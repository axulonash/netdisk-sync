import { strict as assert } from "assert";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import * as nodeCrypto from "crypto";

// Bundle the real settings renderer with a small Obsidian UI/API fixture.
const stub = `
const fixture = () => globalThis.__baiduSettingsTest;
exports.Platform = { get isDesktopApp() { return fixture().desktop !== false; } };
exports.Notice = class { constructor(message) { fixture().notices.push(message); } };
exports.requestUrl = async (request) => { fixture().requests.push(request); return fixture().responses.shift(); };
exports.Setting = class {
  constructor(parent) { this.parent = parent; this.name = ''; }
  setName(name) { this.name = name; return this; }
  setDesc() { return this; }
  addText(callback) {
    const inputEl = this.parent.ownerDocument.createElement('input'); this.parent.append(inputEl);
    fixture().inputs.set(this.name, inputEl);
    const text = { inputEl, setValue(value) { inputEl.value = value; return text; }, onChange(fn) { inputEl.addEventListener('change', () => fn(inputEl.value)); return text; } };
    callback(text); return this;
  }
  addButton(callback) {
    let label;
    const button = { setButtonText(value) { label = value; return button; }, onClick(fn) { fixture().actions.set(label, fn); return button; } };
    callback(button); return this;
  }
};`;
const bundle = buildSync({
  entryPoints: ["src/native/settingsBaidu.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  alias: { obsidian: "baidu-settings-test-stub" },
  // Resolve the API fixture when evaluating the in-memory bundle.
  external: ["baidu-settings-test-stub"],
}).outputFiles[0].text;
const moduleFixture: { exports: any } = { exports: {} };
new Function("module", "exports", "require", bundle)(
  moduleFixture,
  moduleFixture.exports,
  (name: string) => {
    // The Node test bundle uses its MD5 implementation. Production webpack
    // maps crypto to crypto-browserify; node:https stays forbidden here.
    if (name === "crypto" || name === "node:crypto") return nodeCrypto;
    assert.equal(name, "baidu-settings-test-stub");
    const value: any = {};
    new Function("exports", stub)(value);
    return value;
  }
);
const { generateBaiduConnectionSettings } = moduleFixture.exports;

describe("Baidu settings workflow", () => {
  it("renders mobile controls without importing Node HTTPS", () => {
    const dom = new JSDOM("<main></main>");
    (globalThis as any).__baiduSettingsTest = {
      desktop: false,
      inputs: new Map(),
      actions: new Map(),
      notices: [],
    };
    (dom.window.HTMLElement.prototype as any).createEl = function (
      tag: string,
      options: { text: string }
    ) {
      const child = dom.window.document.createElement(tag);
      child.textContent = options.text;
      this.append(child);
      return child;
    };
    try {
      const plugin: any = { settings: {}, saveSettings: async () => {} };
      const parent = dom.window.document.querySelector("main")!;
      generateBaiduConnectionSettings(parent, plugin);
      assert.equal(
        (globalThis as any).__baiduSettingsTest.actions.has("下载检查"),
        false
      );
      assert.ok(parent.textContent!.includes("移动端可进行授权和目录检查"));
      // The bundle evaluator rejects node:https during module load/render.
    } finally {
      delete (globalThis as any).__baiduSettingsTest;
      dom.window.close();
    }
  });
  it("does not roll back an imported account when an older save fails", async () => {
    const dom = new JSDOM("<main></main>");
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = dom.window;
    (globalThis as any).__baiduSettingsTest = {
      inputs: new Map(),
      actions: new Map(),
      notices: [],
      requests: [],
      responses: [
        {
          status: 200,
          text: '{"access_token":"new-access","refresh_token":"refresh","expires_in":3600}',
        },
      ],
    };
    (dom.window.HTMLElement.prototype as any).createEl = function (
      tag: string,
      options: { text: string }
    ) {
      const child = dom.window.document.createElement(tag);
      child.textContent = options.text;
      this.append(child);
      return child;
    };
    let started!: () => void;
    let reject!: (error: Error) => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((_, rejectSave) => {
      reject = rejectSave;
    });
    const app = {
      clientId: "old-app",
      clientSecret: "secret",
      redirectUri: "oob",
    };
    const plugin: any = {
      settings: { baiduNative: { app } },
      saveSettings: async () => {
        started();
        await gate;
      },
    };
    try {
      generateBaiduConnectionSettings(
        dom.window.document.querySelector("main")!,
        plugin
      );
      const loggingIn = plugin.baiduConnection.login(app, "code");
      await entered;
      const imported = { app: { ...app, clientId: "imported-app" } };
      plugin.settings.baiduNative = imported;
      reject(new Error("fixture-disk-failure"));
      await assert.rejects(loggingIn, /save_failed/);
      assert.equal(plugin.settings.baiduNative, imported);
    } finally {
      (globalThis as any).window = previousWindow;
      delete (globalThis as any).__baiduSettingsTest;
      dom.window.close();
    }
  });
  it("opens official OAuth, saves the copied code, checks a directory and clears tokens", async () => {
    const dom = new JSDOM("<main></main>");
    const previousWindow = (globalThis as any).window;
    const fixture = {
      inputs: new Map<string, HTMLInputElement>(),
      actions: new Map<string, () => Promise<void>>(),
      notices: [] as string[],
      requests: [] as any[],
      responses: [
        {
          status: 200,
          text: '{"access_token":"access","refresh_token":"refresh","expires_in":3600}',
        },
        {
          status: 200,
          text: '{"errno":0,"list":[{"fs_id":"1","path":"/notes/test.md","isdir":0,"size":3,"server_mtime":1,"server_ctime":1}]}',
        },
      ],
    };
    (globalThis as any).__baiduSettingsTest = fixture;
    (globalThis as any).window = dom.window;
    let opened = "";
    dom.window.open = ((url: string) => {
      opened = url;
      return null;
    }) as any;
    (dom.window.HTMLElement.prototype as any).createEl = function (
      tag: string,
      options: { text: string }
    ) {
      const child = dom.window.document.createElement(tag);
      child.textContent = options.text;
      this.append(child);
      return child;
    };
    const plugin: any = { settings: {}, saveSettings: async () => {} };
    try {
      const parent = dom.window.document.querySelector("main")!;
      generateBaiduConnectionSettings(parent, plugin);
      assert.equal(parent.querySelector("details")!.open, false);
      const input = (label: string, value: string) => {
        const element = fixture.inputs.get(label)!;
        element.value = value;
        element.dispatchEvent(new dom.window.Event("change"));
      };
      await fixture.actions.get("保存授权")!();
      assert.equal(fixture.requests.length, 0);
      input("应用 API Key", "app");
      input("应用 Secret Key", "secret");
      await fixture.actions.get("浏览器授权")!();
      assert.equal(new URL(opened).searchParams.get("redirect_uri"), "oob");
      assert.ok(!opened.includes("secret"));
      input("2. 回填本次授权码", "copied-code");
      await fixture.actions.get("保存授权")!();
      assert.equal(plugin.settings.baiduNative.tokens.accessToken, "access");
      assert.equal(fixture.inputs.get("2. 回填本次授权码")!.value, "");
      input("检查远端目录", "/notes");
      await fixture.actions.get("只读检查")!();
      assert.equal(
        new URL(fixture.requests[1].url).searchParams.get("dir"),
        "/notes"
      );
      assert.ok(parent.textContent!.includes("1 个文件"));
      let downloads = 0;
      plugin.baiduConnection.readFile = async (file: any) => {
        assert.deepEqual(file, { fsId: "1", size: 3 });
        downloads++;
        return new ArrayBuffer(3);
      };
      input("检查下载文件", "test.md");
      await fixture.actions.get("下载检查")!();
      assert.equal(downloads, 1);
      assert.ok(parent.textContent!.includes("3 字节"));
      fixture.responses.push({ status: 200, text: '{"errno":0,"list":[]}' });
      await fixture.actions.get("检查并保存同步目录")!();
      assert.equal(plugin.settings.baiduNative.remoteRoot, "/notes");
      assert.ok(parent.textContent!.includes("同步目录已保存"));
      input("检查远端目录", "/other");
      await fixture.actions.get("下载检查")!();
      assert.equal(downloads, 1);
      await fixture.actions.get("退出登录")!();
      assert.equal(plugin.settings.baiduNative.tokens, undefined);
      assert.ok(!parent.textContent!.includes("secret"));
      assert.ok(
        fixture.notices.every((message) => !message.includes("secret"))
      );
    } finally {
      (globalThis as any).window = previousWindow;
      delete (globalThis as any).__baiduSettingsTest;
      dom.window.close();
    }
  });
});
