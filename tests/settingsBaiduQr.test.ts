import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import Module from "module";
import { renderBaiduConnection } from "../src/settingsBaiduQr";
import { renderSettingsSinglePage } from "../src/settingsSinglePage";
import { baiduWebBinding } from "../src/native/baiduWebSync";

const tick = () => new Promise((r) => setTimeout(r, 0));

// The QR block and BaiduQrLoginModal import obsidian at module load. Intercept
// those loads (scoped to the Baidu modules) so the fragment runs under tsx.
let nativeOverride: any;
let currentDoc: Document | undefined;
const httpsState: { responses: any[] } = { responses: [] };

const obsidianStub = {
  Platform: { isDesktopApp: true },
  Notice: class {
    constructor(_message?: string) {}
  },
  Modal: class {
    contentEl: HTMLElement;
    constructor(_app: any) {
      const modal = (currentDoc ?? globalThis.document).createElement("div");
      modal.className = "modal";
      (currentDoc ?? globalThis.document).body.append(modal);
      this.contentEl = modal;
    }
    open() {}
    close() {
      (this as any).onClose?.();
    }
  },
};

const httpsStub = {
  Agent: class {},
  request: (_url: any, _options: any, callback: any) => {
    const req: any = new (require("events").EventEmitter)();
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () =>
      queueMicrotask(() => {
        const data = httpsState.responses.shift();
        if (!data) {
          req.emit("error", Error("unexpected request"));
          return;
        }
        const res: any = new (require("events").EventEmitter)();
        res.statusCode = 200;
        res.headers = { "set-cookie": data.cookies ?? [] };
        res.complete = true;
        res.destroy = () => {};
        callback(res);
        if (data.body) res.emit("data", data.body);
        else res.emit("data", Buffer.from(JSON.stringify(data.json)));
        res.emit("end");
      });
    return req;
  },
};

const originalLoad = (Module as any)._load;
const fromBaidu = (parent: any) =>
  typeof parent?.filename === "string" &&
  (parent.filename.includes("/src/native/") ||
    parent.filename.includes("settingsBaiduQr"));

describe("Baidu QR settings fragment", () => {
  before(() => {
    (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
      if (fromBaidu(parent)) {
        if (request === "obsidian") return obsidianStub;
        if (request === "node:https") return httpsStub;
        if (request === "./native/settingsBaiduQr" && nativeOverride !== undefined)
          return nativeOverride;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  });
  after(() => {
    (Module as any)._load = originalLoad;
  });
  afterEach(() => {
    nativeOverride = undefined;
    httpsState.responses = [];
    currentDoc = undefined;
  });

  function fixture(opts: { desktop?: boolean } = {}) {
    const dom = new JSDOM("<main></main>");
    currentDoc = dom.window.document;
    const parent = dom.window.document.querySelector("main")!;
    const listeners = new Set<() => void>();
    const statuses: { state: string; text: string }[] = [];
    let tester:
      | (() => Promise<{ ok: boolean; message: string }>)
      | null = null;
    let saves = 0;
    const plugin: any = {
      settings: {
        serviceType: "baidu",
        baiduWebRemoteRoot: "/old",
      },
      app: { vault: { getName: () => "我的笔记" } },
      isSyncing: false,
      nativeMaintenance: false,
      syncUiStatus: "尚未同步",
      saveSettings: async () => {
        saves++;
      },
      onSyncUiUpdate: (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    const cleanup = renderBaiduConnection(parent, plugin, {
      desktop: opts.desktop ?? true,
      redisplay: () => {},
      setStatus: (state, text) => statuses.push({ state, text }),
      setTester: (t) => {
        tester = t;
      },
    });
    return {
      dom,
      parent,
      plugin,
      cleanup,
      listeners,
      statuses,
      tester: () => tester,
      saves: () => saves,
      fire: () => {
        for (const cb of [...listeners]) cb();
      },
    };
  }

  it("offers only QR login, with no application key, secret or authorization code fields", () => {
    const f = fixture();
    assert.equal(
      f.parent.querySelectorAll(
        'input:not([type="radio"]):not([type="checkbox"])'
      ).length,
      1
    );
    assert.ok(f.parent.textContent!.includes("扫码登录"));
    assert.ok(
      !f.parent.textContent!.includes("AppKey") &&
        !f.parent.textContent!.includes("AppSecret") &&
        !f.parent.textContent!.includes("授权码")
    );
    f.cleanup();
  });

  it("renders the QR login inline instead of a modal", async () => {
    httpsState.responses = [
      { json: { errno: 0, sign: "ticket", imgurl: "passport.baidu.com/v2/api/qrcode?sign=ticket" } },
      { body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    ];
    const f = fixture();
    (f.parent.querySelector('[data-action="login"]') as HTMLButtonElement).click();
    await tick();
    assert.ok(f.parent.querySelector(".rsnext-baidu-qr img"), "QR image is inline");
    assert.equal(f.dom.window.document.querySelector(".modal"), null);
    assert.ok(f.parent.textContent!.includes("百度网盘扫码登录"));
    f.cleanup();
  });

  it("gates sync on login and a successful folder preparation", async () => {
    const verified: string[] = [];
    nativeOverride = {
      renderBaiduQrLoginBlock: () => () => {},
      verifyBaiduQrSession: async (_plugin: any, root: string) => {
        verified.push(root);
        return { upload: true, download: true, cleanup: true };
      },
    };
    const f = fixture();
    const before = await f.tester()!();
    assert.equal(before.ok, false);
    assert.equal(f.plugin.settings.baiduWebPrepared, undefined);

    f.plugin.settings.baiduWebExperimental = { cookie: "BDUSS=fixture", csrf: "csrf" };
    const after = await f.tester()!();
    assert.equal(after.ok, true);
    assert.deepEqual(verified, [f.plugin.settings.baiduWebRemoteRoot]);
    assert.equal(
      f.plugin.settings.baiduWebPrepared,
      baiduWebBinding(f.plugin.settings)
    );
    f.cleanup();
  });

  it("uses the entered directory and keeps the last saved folder when verification fails", async () => {
    nativeOverride = {
      renderBaiduQrLoginBlock: () => () => {},
      verifyBaiduQrSession: async () => ({
        upload: true,
        download: false,
        cleanup: true,
        failure: "download_mismatch",
      }),
    };
    const f = fixture();
    f.plugin.settings.baiduWebExperimental = { cookie: "BDUSS=fixture", csrf: "csrf" };
    const directory = f.parent.querySelector(
      '[data-field="remoteRoot"]'
    ) as HTMLInputElement;
    directory.value = "/国内同步/我的笔记";
    directory.dispatchEvent(new f.dom.window.Event("input"));
    const result = await f.tester()!();
    assert.equal(result.ok, false);
    assert.equal(f.plugin.settings.baiduWebRemoteRoot, "/old");
    assert.ok(result.message.includes("下载未通过"));
    assert.ok(result.message.includes("[download_mismatch]"));
    f.cleanup();
  });

  it("rolls back the folder if saving settings fails after successful verification", async () => {
    nativeOverride = {
      renderBaiduQrLoginBlock: () => () => {},
      verifyBaiduQrSession: async () => ({
        upload: true,
        download: true,
        cleanup: true,
      }),
    };
    const f = fixture();
    f.plugin.settings.baiduWebExperimental = { cookie: "BDUSS=fixture", csrf: "csrf" };
    f.plugin.saveSettings = async () => {
      throw Error("private-cookie");
    };
    const directory = f.parent.querySelector(
      '[data-field="remoteRoot"]'
    ) as HTMLInputElement;
    directory.value = "/new";
    directory.dispatchEvent(new f.dom.window.Event("input"));
    const result = await f.tester()!();
    assert.equal(f.plugin.settings.baiduWebRemoteRoot, "/old");
    assert.ok(result.message.includes("save_failed"));
    assert.ok(!f.parent.textContent!.includes("private-cookie"));
    f.cleanup();
  });

  it("persists service changes through the frame dropdown", async () => {
    const dom = new JSDOM("<main></main>");
    currentDoc = dom.window.document;
    const container = dom.window.document.querySelector("main")!;
    let saves = 0;
    const plugin: any = {
      settings: {
        serviceType: "baidu",
        password: "",
        encryptionMethod: "rclone-base64",
        autoRunEveryMilliseconds: -1,
        initRunAfterMilliseconds: -1,
        syncOnSaveAfterMilliseconds: -1,
        ignorePaths: [],
        onlyAllowPaths: [],
        syncConfigDir: false,
        concurrency: 5,
        webdav: { address: "", username: "", password: "" },
        s3: {},
      },
      app: { vault: { getName: () => "笔记", configDir: ".obsidian" } },
      manifest: { name: "remotely-save-next", version: "1.0.0", id: "remotely-save-next" },
      i18n: { t: (key: string) => key },
      syncUiStatus: "尚未同步",
      isSyncing: false,
      nativeMaintenance: false,
      saveSettings: async () => {
        saves++;
      },
      testWebdavConnection: async () => true,
      syncRun: async () => {},
      toggleSyncOnSaveIfSet: () => {},
      getSyncActivities: async () => [],
      registerInterval: () => {},
      onSyncUiUpdate: () => () => {},
    };
    const cleanup = renderSettingsSinglePage(container, plugin, true);
    const select = container.querySelector("select")!;
    select.value = "webdav";
    select.dispatchEvent(new dom.window.Event("change"));
    await tick();
    assert.ok(saves >= 1);
    assert.equal(plugin.settings.serviceType, "webdav");
    cleanup();
  });

  it("detaches its listener and its QR block on cleanup, and stays off mobile", () => {
    let blockCleanups = 0;
    nativeOverride = {
      renderBaiduQrLoginBlock: (host: HTMLElement) => {
        host.append((host.ownerDocument ?? currentDoc!).createElement("p"));
        return () => {
          blockCleanups++;
        };
      },
      verifyBaiduQrSession: async () => ({}),
    };
    const f = fixture();
    assert.equal(f.listeners.size, 1);
    assert.ok(f.tester());
    (f.parent.querySelector('[data-action="login"]') as HTMLButtonElement).click();
    f.cleanup();
    assert.equal(f.listeners.size, 0);
    assert.equal(blockCleanups, 1);
    assert.equal(f.parent.childNodes.length, 0);

    const mobile = fixture({ desktop: false });
    assert.equal(mobile.parent.querySelector('[data-action="login"]'), null);
    assert.ok(mobile.parent.textContent!.includes("电脑"));
    mobile.cleanup();
  });
});
