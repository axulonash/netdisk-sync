import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import { renderWebdavConnection } from "../src/settingsWebdavSimple";

const tick = () => new Promise((r) => setTimeout(r, 0));

function fixture() {
  const dom = new JSDOM("<div id='host'></div>");
  const parent = dom.window.document.getElementById("host")!;
  const events: string[] = [];
  const statuses: { state: string; text: string }[] = [];
  const listeners = new Set<() => void>();
  let tester: (() => Promise<{ ok: boolean; message: string }>) | null = null;
  const plugin: any = {
    settings: {
      serviceType: "webdav",
      webdav: {
        address: "https://dav.example.com",
        username: "user",
        password: "secret",
      },
    },
    app: { vault: { getName: () => "笔记" } },
    syncUiStatus: "尚未同步",
    isSyncing: false,
    nativeMaintenance: false,
    saveSettings: async () => {
      events.push("save");
    },
    testWebdavConnection: async () => {
      events.push("test");
      plugin.settings.webdavNeedsValidation = false;
      plugin.syncUiStatus = "连接正常";
      return true;
    },
    onSyncUiUpdate: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const cleanup = renderWebdavConnection(parent, plugin, {
    desktop: true,
    redisplay: () => {
      events.push("redisplay");
    },
    setStatus: (state, text) => {
      statuses.push({ state, text });
    },
    setTester: (t) => {
      tester = t;
    },
  });
  const fire = () => {
    for (const cb of [...listeners]) cb();
  };
  return {
    dom,
    parent,
    plugin,
    cleanup,
    events,
    statuses,
    listeners,
    fire,
    tester: () => tester,
  };
}

describe("WebDAV connection fragment", () => {
  it("renders four fields and composes the target directory inline", () => {
    const f = fixture();
    const inputs = f.parent.querySelectorAll(
      'input:not([type="checkbox"]):not([type="radio"])'
    );
    assert.equal(inputs.length, 4);
    const address = f.parent.querySelector(
      'input[type="url"]'
    ) as HTMLInputElement;
    assert.equal(address.value, "https://dav.example.com");
    const label = Array.from(f.parent.querySelectorAll("label")).find(
      (n) => n.textContent === "同步目录"
    )!;
    const directory = f.dom.window.document.getElementById(
      label.htmlFor
    ) as HTMLInputElement;
    assert.equal(directory.value, "/");
    directory.value = "/home/Drive";
    directory.dispatchEvent(new f.dom.window.Event("input"));
    assert.equal(f.plugin.settings.webdav.remoteBaseDir, "home/Drive/笔记");
    assert.equal(
      f.parent.querySelector(".rsnext-target")!.textContent,
      "完整路径：https://dav.example.com/home/Drive/笔记/"
    );
    f.cleanup();
  });

  it("links a described field to its hint via aria-describedby", () => {
    const f = fixture();
    const label = Array.from(f.parent.querySelectorAll("label")).find(
      (n) => n.textContent === "同步目录"
    )!;
    const directory = f.dom.window.document.getElementById(
      label.htmlFor
    ) as HTMLInputElement;
    const describedBy = directory.getAttribute("aria-describedby");
    assert.ok(describedBy);
    const hint = f.dom.window.document.getElementById(describedBy!);
    assert.ok(hint, "aria-describedby must point at the hint element");
    assert.ok(hint!.textContent!.includes("自动追加当前笔记本名称"));
    f.cleanup();
  });

  it("invalidates immediately and persists edits before testing, keeping password whitespace", async () => {
    const f = fixture();
    const password = f.parent.querySelector(
      'input[type="password"]'
    ) as HTMLInputElement;
    password.value = " secret ";
    password.dispatchEvent(new f.dom.window.Event("input"));
    assert.equal(f.plugin.settings.webdav.password, " secret ");
    assert.equal(f.plugin.settings.webdavNeedsValidation, true);
    const tester = f.tester();
    assert.ok(tester);
    const result = await tester!();
    assert.deepEqual(f.events, ["save", "test"]);
    assert.equal(result.ok, true);
    f.cleanup();
  });

  it("locks the connection controls while syncing", () => {
    const f = fixture();
    f.plugin.isSyncing = true;
    f.fire();
    assert.ok(
      Array.from(f.parent.querySelectorAll("input,button")).every(
        (e) => (e as HTMLButtonElement).disabled
      )
    );
    f.cleanup();
  });

  it("reports failures through ctx status and detaches its listener on cleanup", async () => {
    const f = fixture();
    f.plugin.testWebdavConnection = async () => {
      f.plugin.syncUiStatus = "账号或密码未通过认证";
      return false;
    };
    await f.tester()!();
    assert.deepEqual(f.statuses.at(-1), {
      state: "failure",
      text: "账号或密码未通过认证",
    });
    assert.equal(f.listeners.size, 1);
    f.cleanup();
    assert.equal(f.listeners.size, 0);
    assert.equal(f.tester(), null);
  });
});
