import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import { renderSimpleBaidu } from "../src/settingsBaiduSimple";
const tick = () => new Promise((r) => setTimeout(r, 0));
function fixture(logged = true, desktop = true) {
  const dom = new JSDOM("<main></main>", { url: "https://example.test" }),
    parent = dom.window.document.querySelector("main")!;
  let listener = () => {},
    checked = 0,
    syncs = 0;
  const plugin: any = {
    settings: {
      serviceType: "baidu",
      baiduNative: logged
        ? {
            app: {
              clientId: "app",
              clientSecret: "secret",
              redirectUri: "oob",
            },
            tokens: { accessToken: "token" },
            remoteRoot: "/apps/已有目录",
          }
        : undefined,
      conflictAction: "keep_newer",
    },
    app: { vault: { getName: () => "笔记" } },
    isSyncing: false,
    nativeMaintenance: false,
    syncUiStatus: "尚未同步",
    saveSettings: async () => {},
    onSyncUiUpdate: (f: any) => {
      listener = f;
      return () => {};
    },
    updateSyncUi: () => listener(),
    getSyncActivities: async () => [],
    syncRun: async () => {
      syncs++;
    },
  };
  const connection: any = {
    busy: false,
    setRemoteRoot: async (root: string) => {
      checked++;
      plugin.settings.baiduNative.remoteRoot = root;
    },
    scan: async () => [],
    login: async () => {},
    logout: async () => {
      plugin.settings.baiduNative = undefined;
    },
  };
  const cleanup = renderSimpleBaidu(
    parent,
    plugin,
    connection,
    () => {},
    () => {},
    desktop
  );
  return {
    dom,
    parent,
    plugin,
    connection,
    cleanup,
    stats: () => ({ checked, syncs }),
  };
}
describe("Simplified Baidu settings", () => {
  it("preserves the configured directory and offers manual controls without unsupported automatic sync", () => {
    const f = fixture();
    const root = f.parent.querySelector(
      '[data-field="remoteRoot"]'
    ) as HTMLInputElement;
    assert.equal(root.value, "/apps/已有目录");
    assert.equal(f.parent.querySelectorAll('[role="tab"]').length, 2);
    assert.ok(!f.parent.textContent!.includes("保存时同步"));
    assert.ok(!f.parent.textContent!.includes("定时同步"));
    assert.equal(f.parent.querySelector("details")!.open, false);
    f.cleanup();
  });
  it("requires checking an edited directory before manual sync and shows success as a green light", async () => {
    const f = fixture();
    const root = f.parent.querySelector(
      '[data-field="remoteRoot"]'
    ) as HTMLInputElement;
    root.value = "/apps/新目录";
    root.dispatchEvent(new f.dom.window.Event("input"));
    assert.equal(
      (f.parent.querySelector('[data-action="sync"]') as HTMLButtonElement)
        .disabled,
      true
    );
    (
      f.parent.querySelector('[data-action="test"]') as HTMLButtonElement
    ).click();
    await tick();
    assert.equal(f.plugin.settings.baiduNative.remoteRoot, "/apps/新目录");
    assert.equal(f.stats().checked, 1);
    assert.equal(
      (f.parent.querySelector(".rsnext-connection-light") as HTMLElement)
        .dataset.state,
      "success"
    );
    assert.equal(
      (f.parent.querySelector('[data-action="sync"]') as HTMLButtonElement)
        .disabled,
      false
    );
    f.cleanup();
  });
  it("keeps a failed directory change from enabling sync or replacing the configured root", async () => {
    const f = fixture();
    f.connection.setRemoteRoot = async () => {
      throw Object.assign(new Error("secret token"), { code: "invalid_path" });
    };
    const root = f.parent.querySelector(
      '[data-field="remoteRoot"]'
    ) as HTMLInputElement;
    root.value = "invalid";
    root.dispatchEvent(new f.dom.window.Event("input"));
    (
      f.parent.querySelector('[data-action="test"]') as HTMLButtonElement
    ).click();
    await tick();
    assert.equal(f.plugin.settings.baiduNative.remoteRoot, "/apps/已有目录");
    assert.equal(
      (f.parent.querySelector('[data-action="sync"]') as HTMLButtonElement)
        .disabled,
      true
    );
    assert.equal(
      (f.parent.querySelector(".rsnext-connection-light") as HTMLElement)
        .dataset.state,
      "failure"
    );
    assert.ok(!f.parent.innerHTML.includes("secret token"));
    f.cleanup();
  });
  it("keeps mobile sync disabled and provides inline icons for application secrets", () => {
    const f = fixture(false);
    (
      f.parent.querySelector('[data-action="login"]') as HTMLButtonElement
    ).click();
    assert.ok(f.parent.querySelector(".rsnext-password-control button svg"));
    assert.equal(
      (f.parent.querySelector('[data-action="sync"]') as HTMLButtonElement)
        .disabled,
      true
    );
    f.cleanup();
  });
  it("does not perform setup or sync on mobile", async () => {
    const f = fixture(true, false);
    const test = f.parent.querySelector(
      '[data-action="test"]'
    ) as HTMLButtonElement;
    test.click();
    await tick();
    assert.equal(f.stats().checked, 0);
    assert.equal(
      (f.parent.querySelector('[data-action="sync"]') as HTMLButtonElement)
        .disabled,
      true
    );
    f.cleanup();
  });
  it("shows empty history before login and locks credentials during maintenance", async () => {
    const f = fixture(false);
    const tabs = f.parent.querySelectorAll('[role="tab"]');
    (tabs[1] as HTMLButtonElement).click();
    await tick();
    assert.ok(f.parent.textContent!.includes("还没有同步记录"));
    f.plugin.nativeMaintenance = true;
    f.plugin.updateSyncUi();
    assert.ok(
      Array.from(f.parent.querySelectorAll("input,select")).every((n) =>
        (n as HTMLInputElement).matches(":disabled")
      )
    );
    f.cleanup();
  });
  it("completes official authorization, clears the code and supports logout", async () => {
    const f = fixture(false);
    (f.dom.window as any).open = () => ({});
    const input = (label: string) =>
      f.dom.window.document.getElementById(
        Array.from(f.parent.querySelectorAll("label")).find(
          (n) => n.textContent === label
        )!.htmlFor
      ) as HTMLInputElement;
    input("应用 AppKey").value = "my-app";
    input("应用 AppKey").dispatchEvent(new f.dom.window.Event("input"));
    input("应用 AppSecret").value = "my-secret";
    input("应用 AppSecret").dispatchEvent(new f.dom.window.Event("input"));
    const button = (label: string) =>
      Array.from(f.parent.querySelectorAll("button")).find(
        (n) => n.textContent === label
      )!;
    button("打开百度授权页").click();
    input("百度授权码").value = "one-time-code";
    f.connection.login = async (app: any, code: string) => {
      assert.equal(app.clientId, "my-app");
      assert.equal(app.clientSecret, "my-secret");
      assert.equal(code, "one-time-code");
      f.plugin.settings.baiduNative = {
        app,
        tokens: { accessToken: "private-token" },
      };
    };
    button("完成登录").click();
    await tick();
    assert.equal(input("百度授权码").value, "");
    assert.ok(f.parent.textContent!.includes("已登录"));
    assert.equal(
      (f.parent.querySelector('[data-action="sync"]') as HTMLButtonElement)
        .disabled,
      true
    );
    button("退出登录").click();
    await tick();
    assert.equal(f.plugin.settings.baiduNative, undefined);
    assert.ok(f.parent.textContent!.includes("未登录"));
    f.cleanup();
  });
  it("opens official authorization with just the app key and provides a manual link", async () => {
    const f = fixture(false);
    let opened = "";
    (f.dom.window as any).open = (url: string) => {
      opened = url;
      return null;
    };
    const label = Array.from(f.parent.querySelectorAll("label")).find(
      (n) => n.textContent === "应用 AppKey"
    )!;
    const key = f.dom.window.document.getElementById(
      label.htmlFor
    ) as HTMLInputElement;
    key.value = "my-app";
    key.dispatchEvent(new f.dom.window.Event("input"));
    Array.from(f.parent.querySelectorAll("button"))
      .find((n) => n.textContent === "打开百度授权页")!
      .click();
    await tick();
    assert.ok(
      opened.startsWith("https://openapi.baidu.com/oauth/2.0/authorize?")
    );
    const link = f.parent.querySelector(
      '[data-action="authorization-link"]'
    ) as HTMLAnchorElement;
    assert.equal(link.href, opened);
    assert.equal(link.hidden, false);
    assert.ok(!link.href.includes("client_secret"));
    f.cleanup();
  });
  it("keeps safe platform diagnostic codes in the red-light tooltip", async () => {
    const f = fixture();
    f.connection.setRemoteRoot = async () => {
      throw Object.assign(new Error("private-secret"), {
        code: "platform_error",
        errno: -9,
      });
    };
    (
      f.parent.querySelector('[data-action="test"]') as HTMLButtonElement
    ).click();
    await tick();
    const light = f.parent.querySelector(
      ".rsnext-connection-light"
    ) as HTMLElement;
    assert.equal(light.dataset.state, "failure");
    assert.ok(light.title.includes("platform_error"));
    assert.ok(light.title.includes("errno=-9"));
    assert.ok(!f.parent.innerHTML.includes("private-secret"));
    f.cleanup();
  });
  it("enables desktop sync after the backend normalizes a checked directory", async () => {
    const f = fixture();
    f.connection.setRemoteRoot = async (root: string) => {
      f.plugin.settings.baiduNative.remoteRoot = root.replace(/\/$/, "");
    };
    const directory = f.parent.querySelector(
      '[data-field="remoteRoot"]'
    ) as HTMLInputElement;
    directory.value = "/apps/";
    directory.dispatchEvent(new f.dom.window.Event("input"));
    (
      f.parent.querySelector('[data-action="test"]') as HTMLButtonElement
    ).click();
    await tick();
    assert.equal(
      (f.parent.querySelector(".rsnext-connection-light") as HTMLElement)
        .dataset.state,
      "success"
    );
    assert.equal(
      (f.parent.querySelector('[data-action="sync"]') as HTMLButtonElement)
        .disabled,
      false
    );
    assert.equal(directory.value, "/apps");
    f.cleanup();
  });
  it("explains the setup order and explicitly offers automatic directory creation", () => {
    const f = fixture(false);
    const headings = Array.from(
      f.parent.querySelectorAll(".rsnext-setup-step h3")
    ).map((n) => n.textContent);
    assert.deepEqual(headings, [
      "1. 登录百度网盘",
      "2. 选择同步文件夹",
      "3. 开始同步",
    ]);
    assert.ok(f.parent.textContent!.includes("不存在时自动创建"));
    assert.equal(
      f.parent.querySelector('[data-action="test"]')?.textContent,
      "准备同步文件夹"
    );
    f.cleanup();
  });
  it("shows a prominent desktop setup prompt on phones", () => {
    const f = fixture(false, false);
    const guide = f.parent.querySelector(".rsnext-mobile-guide") as HTMLElement;
    assert.ok(guide);
    assert.equal(guide.hidden, false);
    assert.ok(guide.textContent!.includes("请到电脑完成设置"));
    assert.ok(
      Array.from(f.parent.querySelectorAll(".rsnext-setup-step")).every(
        (n) => (n as HTMLElement).hidden
      )
    );
    f.cleanup();
  });
});
