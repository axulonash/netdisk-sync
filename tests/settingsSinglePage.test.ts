import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import { renderSettingsSinglePage } from "../src/settingsSinglePage";

const tick = () => new Promise((r) => setTimeout(r, 0));

function fixture(serviceType: string) {
  const dom = new JSDOM("<main></main>");
  const container = dom.window.document.querySelector("main")!;
  const listeners = new Set<() => void>();
  let saves = 0;
  const plugin: any = {
    settings: {
      serviceType,
      password: "",
      encryptionMethod: "rclone-base64",
      autoRunEveryMilliseconds: -1,
      initRunAfterMilliseconds: -1,
      syncOnSaveAfterMilliseconds: -1,
      ignorePaths: [],
      onlyAllowPaths: [],
      syncConfigDir: false,
      concurrency: 5,
      webdav: {
        address: "https://dav.example.com",
        username: "user",
        password: "secret",
      },
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
    onSyncUiUpdate: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const cleanup = renderSettingsSinglePage(container, plugin, true);
  return { dom, container, plugin, cleanup, listeners, saves: () => saves };
}

describe("single-page settings assembly", () => {
  it("renders the four sections and the webdav connection fields for webdav", () => {
    const f = fixture("webdav");
    const sections = f.container.querySelectorAll("details");
    assert.equal(sections.length, 4);
    assert.deepEqual(
      Array.from(sections).map((d) => d.querySelector("summary")!.textContent),
      ["连接", "基本", "高级", "同步记录"]
    );
    const inputs = sections[0].querySelectorAll(
      'input:not([type="checkbox"]):not([type="radio"])'
    );
    assert.equal(inputs.length, 4);
    assert.equal(
      (inputs[0] as HTMLInputElement).value,
      "https://dav.example.com"
    );
    f.cleanup();
  });

  it("warns but still renders basic and records for an unsupported service", async () => {
    const f = fixture("s3");
    const warning = f.container.querySelector(".rsnext-service-warning");
    assert.ok(warning);
    assert.equal(warning!.textContent, "当前配置的服务已不再支持，请重新选择服务");
    assert.ok(f.container.textContent!.includes("settings_basic"));
    await tick();
    const records = f.container.querySelectorAll("details")[3];
    assert.ok(records.textContent!.includes("仅记录同步时间"));
    f.cleanup();
  });

  it("persists the service change and updates the settings", async () => {
    const f = fixture("webdav");
    const select = f.container.querySelector("select")!;
    select.value = "baidu";
    select.dispatchEvent(new f.dom.window.Event("change"));
    await tick();
    assert.ok(f.saves() >= 1);
    assert.equal(f.plugin.settings.serviceType, "baidu");
    f.cleanup();
  });

  it("renders ignore-paths content inside the advanced section", () => {
    const f = fixture("webdav");
    const advanced = f.container.querySelectorAll("details")[2];
    advanced.open = true;
    advanced.dispatchEvent(new f.dom.window.Event("toggle"));
    assert.ok(advanced.querySelector(".ignorepaths-textarea"));
    f.cleanup();
  });

  it("clears the container and detaches every listener on cleanup", () => {
    const f = fixture("webdav");
    assert.ok(f.listeners.size > 0);
    f.cleanup();
    assert.equal(f.container.childNodes.length, 0);
    assert.equal(f.listeners.size, 0);
  });
});
