import { strict as assert } from "assert";
import Module from "module";
import { JSDOM } from "jsdom";
import {
  bindQuarkSession,
  quarkOverwriteBinding,
} from "../src/native/quarkAuth";
import { renderQuarkConnection } from "../src/settingsQuarkSimple";
import { renderSettingsSinglePage } from "../src/settingsSinglePage";

const tick = () => new Promise((r) => setTimeout(r, 0));

// The QR block and quarkService import obsidian at load. Intercept those loads
// (scoped to the Quark modules and the fragment) so the fragment runs under tsx.
let nativeOverride: any;
let currentDoc: Document | undefined;

const obsidianStub = {
  Platform: { isDesktopApp: true },
  Notice: class {},
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
  Setting: class {
    setName() {
      return this;
    }
    setDesc() {
      return this;
    }
    addButton() {
      return this;
    }
    addText() {
      return this;
    }
  },
};

const qrcodeStub = { toDataURL: async () => "data:image/png;base64,test" };
const transportStub = async () => ({
  status: 200,
  headers: {},
  cookies: ["__puus=secret; Domain=.quark.cn; Path=/"],
  body: new TextEncoder().encode(
    JSON.stringify({ status: 2000000, data: { members: { token: "token" } } })
  ),
});

let verifyImpl: (config: any) => Promise<string> = async (config) =>
  quarkOverwriteBinding(config);
let verifyCalls = 0;
class FakeQuarkClient {
  constructor(
    _transport: any,
    private readonly getConfig: () => any,
    _guard: () => void
  ) {}
  async prepareRoot() {}
  async scan() {}
  async verifyOverwrite() {
    verifyCalls++;
    return verifyImpl(this.getConfig());
  }
}

const originalLoad = (Module as any)._load;
const fromQuark = (parent: any) =>
  typeof parent?.filename === "string" &&
  (parent.filename.includes("/src/native/") ||
    parent.filename.includes("settingsQuarkSimple"));

describe("Quark connection fragment", () => {
  before(() => {
    (Module as any)._load = function (
      request: string,
      parent: any,
      isMain: boolean
    ) {
      if (fromQuark(parent)) {
        if (request === "obsidian") return obsidianStub;
        if (request === "qrcode") return qrcodeStub;
        if (request === "./native/quarkClient" || request === "./quarkClient")
          return { QuarkClient: FakeQuarkClient };
        if (request === "./native/quarkService" || request === "./quarkService")
          return { getQuarkPluginTransport: () => transportStub };
        if (
          request === "./native/settingsQuark" &&
          nativeOverride !== undefined
        )
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
    currentDoc = undefined;
    verifyCalls = 0;
    verifyImpl = async (config: any) => quarkOverwriteBinding(config);
  });

  function fixture(opts: { desktop?: boolean } = {}) {
    const dom = new JSDOM("<main></main>");
    currentDoc = dom.window.document;
    const parent = dom.window.document.querySelector("main")!;
    const listeners = new Set<() => void>();
    const statuses: { state: string; text: string }[] = [];
    let tester: (() => Promise<{ ok: boolean; message: string }>) | null = null;
    let saves = 0;
    const plugin: any = {
      settings: {
        serviceType: "quark",
        quarkNative: {
          session: bindQuarkSession("__puus=secret"),
          remoteRoot: "/notes",
        },
        conflictAction: "keep_both",
      },
      app: { vault: { getName: () => "vault" } },
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
    const cleanup = renderQuarkConnection(parent, plugin, {
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
      folder: () =>
        parent.querySelector('[data-field="remoteRoot"]') as HTMLInputElement,
    };
  }

  it("renders the QR login inline instead of a modal", async () => {
    const f = fixture();
    (
      f.parent.querySelector('[data-action="login"]') as HTMLButtonElement
    ).click();
    await tick();
    await tick();
    assert.ok(
      f.parent.querySelector(".rsnext-quark-qr img"),
      "QR image is inline"
    );
    assert.equal(f.dom.window.document.querySelector(".modal"), null);
    assert.ok(f.parent.textContent!.includes("夸克扫码登录"));
    f.cleanup();
  });

  it("preserves the login-then-folder step order", () => {
    const f = fixture();
    const order = Array.from(
      f.parent.querySelectorAll(
        '[data-action="login"], [data-field="remoteRoot"]'
      )
    ).map((node) => {
      const el = node as HTMLElement;
      return el.dataset.action ?? el.dataset.field;
    });
    assert.deepEqual(order, ["login", "remoteRoot"]);
    f.cleanup();
  });

  it("gates sync on a verified session and prepared folder", async () => {
    const f = fixture();
    assert.equal(f.plugin.settings.quarkNative.overwriteVerified, undefined);
    const before = await f.tester()!();
    assert.equal(before.ok, true);
    assert.equal(
      f.plugin.settings.quarkNative.overwriteVerified,
      quarkOverwriteBinding(f.plugin.settings.quarkNative)
    );
    assert.ok(f.saves() >= 1);

    f.plugin.settings.quarkNative = undefined;
    const after = await f.tester()!();
    assert.equal(after.ok, false);
    f.cleanup();
  });

  it("rejects an in-flight preparation after settings change", async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    verifyImpl = async (config: any) => {
      await pending;
      return quarkOverwriteBinding(config);
    };
    const running = f.tester()!();
    const replacement = {
      session: bindQuarkSession("__puus=other"),
      remoteRoot: "/other",
    };
    f.plugin.settings.quarkNative = replacement;
    release();
    const result = await running;
    assert.equal(f.plugin.settings.quarkNative, replacement);
    assert.equal(result.ok, false);
    f.cleanup();
  });

  it("restores the configuration when persistence fails", async () => {
    const f = fixture();
    const previous = f.plugin.settings.quarkNative;
    f.plugin.saveSettings = async () => {
      throw new Error("write failure");
    };
    const result = await f.tester()!();
    assert.equal(f.plugin.settings.quarkNative, previous);
    assert.equal(result.ok, false);
    f.cleanup();
  });

  it("identifies a rejected upload endpoint without exposing raw URLs", async () => {
    const f = fixture();
    verifyImpl = async () => {
      throw Object.assign(new Error("https://secret-token"), {
        code: "invalid_oss_endpoint",
      });
    };
    await f.tester()!();
    assert.match(f.parent.textContent!, /上传地址/);
    assert.ok(!f.parent.textContent!.includes("secret-token"));
    f.cleanup();
  });

  it("shows missing-after-upload error code and probe stage rather than a generic hint", async () => {
    const f = fixture();
    verifyImpl = async () => {
      throw Object.assign(new Error("secret-url"), {
        code: "not_found",
        stage: "initial_upload",
      });
    };
    await f.tester()!();
    assert.match(f.parent.textContent!, /not_found/);
    assert.match(f.parent.textContent!, /首次上传/);
    assert.ok(!f.parent.textContent!.includes("secret-url"));
    f.cleanup();
  });

  it("shows safe response size and type details without raw credentials", async () => {
    const f = fixture();
    verifyImpl = async () => {
      throw Object.assign(new Error("secret-token"), {
        code: "response_too_large",
        stage: "initial_upload",
        responseInfo: {
          host: "dl-pc-zb.pds.quark.cn",
          status: 200,
          expectedBytes: 4,
          announcedBytes: 1000,
          kind: "html",
        },
      });
    };
    await f.tester()!();
    assert.match(f.parent.textContent!, /HTML 页面/);
    assert.match(f.parent.textContent!, /上限 4 B \/ 返回 1000 B/);
    assert.ok(!f.parent.textContent!.includes("secret-token"));
    f.cleanup();
  });

  for (const serverCode of ["AccessDenied", "secret-server-code"])
    it(`shows login-header evidence and filters ${serverCode}`, async () => {
      const f = fixture();
      verifyImpl = async () => {
        throw Object.assign(new Error("secret-token"), {
          code: "http_403",
          stage: "initial_upload",
          responseInfo: {
            host: "dl-pc-zd-pds.quark.cn",
            status: 403,
            expectedBytes: 4,
            announcedBytes: 376,
            kind: "other",
            cookieSent: true,
            serverCode,
          },
        });
      };
      await f.tester()!();
      assert.match(f.parent.textContent!, /已携带登录态/);
      assert.match(f.parent.textContent!, /\[http_403\]/);
      if (serverCode === "AccessDenied")
        assert.match(f.parent.textContent!, /AccessDenied/);
      assert.ok(!f.parent.textContent!.includes("secret"));
      f.cleanup();
    });

  for (const operation of [
    "backup_rename",
    "secret-operation",
    "constructor",
    "__proto__",
  ])
    it(`shows only safe operation labels for ${operation}`, async () => {
      const f = fixture();
      verifyImpl = async () => {
        throw Object.assign(new Error("secret-body"), {
          code: "http_400",
          stage: "overwrite",
          operation,
        });
      };
      await f.tester()!();
      assert.match(f.parent.textContent!, /HTTP 400/);
      if (operation === "backup_rename")
        assert.match(f.parent.textContent!, /旧文件备份改名/);
      assert.ok(!f.parent.textContent!.includes("secret"));
      f.cleanup();
    });

  it("hands mobile setup off to desktop without making requests", async () => {
    const f = fixture({ desktop: false });
    assert.equal(f.tester(), null);
    assert.ok(f.parent.textContent!.includes("电脑"));
    await tick();
    assert.equal(verifyCalls, 0);
    f.cleanup();
  });

  it("detaches its listener and its login block on cleanup, and stays off mobile", () => {
    let blockCleanups = 0;
    nativeOverride = {
      renderQuarkLoginBlock: (host: HTMLElement) => {
        host.append(host.ownerDocument.createElement("p"));
        return () => {
          blockCleanups++;
        };
      },
    };
    const f = fixture();
    assert.equal(f.listeners.size, 1);
    assert.ok(f.tester());
    (
      f.parent.querySelector('[data-action="login"]') as HTMLButtonElement
    ).click();
    f.cleanup();
    assert.equal(f.listeners.size, 0);
    assert.equal(blockCleanups, 1);
    assert.equal(f.parent.childNodes.length, 0);

    const mobile = fixture({ desktop: false });
    assert.equal(mobile.parent.querySelector('[data-action="login"]'), null);
    assert.ok(mobile.parent.textContent!.includes("电脑"));
    mobile.cleanup();
  });

  it("persists service changes through the frame dropdown", async () => {
    const dom = new JSDOM("<main></main>");
    currentDoc = dom.window.document;
    const container = dom.window.document.querySelector("main")!;
    let saves = 0;
    const plugin: any = {
      settings: {
        serviceType: "quark",
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
      manifest: {
        name: "remotely-save-next",
        version: "1.0.0",
        id: "remotely-save-next",
      },
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
});
