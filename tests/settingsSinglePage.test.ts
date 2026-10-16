import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import Module from "module";
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
    assert.equal(f.container.querySelectorAll('[role="alert"]').length, 1);
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

// settings.ts imports obsidian (types-only package, no runtime) and the pro
// ClearDupFiles module at load, so stub obsidian for the single dynamic import
// that pulls in the tab class.
const obsidianStub = {
  Platform: { isDesktopApp: true },
  Notice: class {
    constructor(_message?: string) {}
  },
  Modal: class {
    constructor(_app?: any) {}
    open() {}
    close() {}
  },
  Setting: class {
    constructor(..._args: any[]) {}
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
  PluginSettingTab: class {
    constructor(_app: any, plugin: any) {
      (this as any).plugin = plugin;
    }
  },
  requireApiVersion: () => true,
};

const originalLoad = (Module as any)._load;
let SettingTab: any;
let savedGlobalDocument: any;

function tabFixture(serviceType: string) {
  const dom = new JSDOM("<main></main>");
  // settings.ts statically imports the pro ClearDupFiles module, which resolves
  // obsidian via the stub above and is then reused by the single page; it needs a
  // global document for its stringToFragment call.
  (globalThis as any).document = dom.window.document;
  const container = dom.window.document.querySelector("main")!;
  (container as any).empty = () => container.replaceChildren();
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
  const tab = new SettingTab({} as any, plugin);
  tab.containerEl = container;
  return { dom, container, plugin, tab, listeners, saves: () => saves };
}

describe("RemotelySaveSettingTab.display() routes everything through the single page", () => {
  before(async () => {
    // tests/misc.test.ts leaves a global `window` behind; webdav's UMD bundle
    // picks a browser path and blows up when it is present while loading.
    const savedWindow = (globalThis as any).window;
    const hadWindow = "window" in globalThis;
    savedGlobalDocument = (globalThis as any).document;
    delete (globalThis as any).window;
    (Module as any)._load = function (
      request: string,
      parent: any,
      isMain: boolean
    ) {
      if (request === "obsidian") return obsidianStub;
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      const mod = (await import("../src/settings")) as any;
      SettingTab = mod.RemotelySaveSettingTab;
    } finally {
      (Module as any)._load = originalLoad;
      if (hadWindow) (globalThis as any).window = savedWindow;
      else delete (globalThis as any).window;
      (globalThis as any).document = savedGlobalDocument;
    }
  });

  after(() => {
    (globalThis as any).document = savedGlobalDocument;
  });

  for (const serviceType of ["webdav", "baidu", "quark", "aliyun"]) {
    it(`renders ${serviceType} through the single page with no legacy markup`, () => {
      const f = tabFixture(serviceType);
      f.tab.display();
      assert.ok(f.container.querySelector(".rsnext-settings"), "frame root");
      assert.equal(f.container.querySelectorAll("details").length, 4);
      assert.equal(f.container.querySelector(".s3-hide"), null);
      assert.equal(f.container.querySelector(".settings-long-desc"), null);
      assert.equal(f.container.querySelector(".rsnext-service-warning"), null);
      f.tab.simpleCleanup?.();
    });
  }

  it("warns but still renders the page for a legacy serviceType", () => {
    const f = tabFixture("dropbox");
    f.tab.display();
    const warning = f.container.querySelector(".rsnext-service-warning");
    assert.ok(warning);
    assert.equal(
      warning!.textContent,
      "当前配置的服务已不再支持，请重新选择服务"
    );
    assert.equal(f.container.querySelectorAll('[role="alert"]').length, 1);
    assert.equal(f.container.querySelectorAll("details").length, 4);
    assert.ok(f.container.textContent!.includes("settings_basic"));
    f.tab.simpleCleanup?.();
  });

  it("does not leak subscriptions when display() re-runs mid-sync", () => {
    const f = tabFixture("webdav");
    f.plugin.syncUiActivity = {
      status: "running",
      progress: {
        phase: "syncing",
        completed: 3,
        failed: 0,
        plan: {
          total: 10,
          upload: 1,
          download: 1,
          delete: 0,
          createFolder: 0,
          conflicts: 0,
          bytes: 0,
        },
      },
    };
    f.plugin.isSyncing = true;
    f.tab.display();
    const afterFirst = f.listeners.size;
    f.tab.display();
    assert.equal(
      f.container.querySelectorAll(".rsnext-sync-progress").length,
      1
    );
    assert.equal(f.listeners.size, afterFirst, "no duplicate subscription");
    f.tab.simpleCleanup?.();
    assert.equal(f.listeners.size, 0);
  });
});
