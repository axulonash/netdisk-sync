import { strict as assert } from "assert";
import { buildSync } from "esbuild";
import { createRequire } from "module";
import { JSDOM } from "jsdom";
const require = createRequire(import.meta.url);
const bundle = buildSync({
  entryPoints: ["src/native/settingsQuark.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["obsidian", "qrcode"],
}).outputFiles[0].text;
function fixture(fail = false, waitFirst = false) {
  const dom = new JSDOM("<main></main>");
  const content = dom.window.document.querySelector("main")!;
  (content as any).createEl = (tag: string, options: any = {}) => {
    const node = dom.window.document.createElement(tag);
    node.textContent = options.text ?? "";
    content.append(node);
    return node;
  };
  (content as any).empty = () => content.replaceChildren();
  let check!: () => Promise<void>,
    release!: () => void,
    done = 0,
    interval = 0,
    active = false,
    buttons = 0;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stub: any = {
    Platform: { isDesktopApp: true },
    Notice: class {},
    Modal: class {
      contentEl = content;
      constructor(..._args: any[]) {}
      close() {
        (this as any).onClose();
      }
    },
    Setting: class {
      constructor(..._args: any[]) {}
      addButton(fn: any) {
        buttons++;
        const button: any = {
          setButtonText: () => button,
          setDisabled: () => button,
          onClick: (action: any) => {
            check = action;
            return button;
          },
        };
        fn(button);
        return this;
      }
    },
  };
  const module = { exports: {} as any };
  new Function(
    "require",
    "module",
    "exports",
    "setInterval",
    "clearInterval",
    bundle
  )(
    (name: string) =>
      name === "obsidian"
        ? stub
        : name === "qrcode"
          ? { toDataURL: async () => "data:image/png;base64,test" }
          : require(name),
    module,
    module.exports,
    (fn: any, ms: number) => {
      check = fn;
      interval = ms;
      active = true;
      return 1;
    },
    () => {
      active = false;
    }
  );
  let request = 0;
  const bodies = [
    { status: 2000000, data: { members: { token: "token" } } },
    ...(waitFirst ? [{ status: 50004001 }] : []),
    { status: 2000000, data: { members: { service_ticket: "ticket" } } },
    { success: true },
  ];
  const plugin: any = {
    app: {},
    settings: {},
    saveSettings: async () => {
      await gate;
      if (fail) throw new Error("save failed");
    },
    quarkTransport: async () => ({
      status: 200,
      headers: {},
      cookies: ["__puus=secret; Domain=.quark.cn; Path=/"],
      body: new TextEncoder().encode(JSON.stringify(bodies[request++])),
    }),
  };
  const modal = new module.exports.QuarkLoginModal(plugin, () => done++);
  return {
    modal,
    plugin,
    get check() {
      return check;
    },
    release,
    get done() {
      return done;
    },
    get active() {
      return active;
    },
    get interval() {
      return interval;
    },
    get requests() {
      return request;
    },
    get buttons() {
      return buttons;
    },
  };
}
describe("Quark login modal persistence lock", () => {
  for (const fail of [false, true])
    it(`defers close callback until login persistence settles (${fail ? "failure" : "success"})`, async () => {
      const f = fixture(fail);
      await f.modal.onOpen();
      const checking = f.check();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.ok(f.plugin.settings.quarkNative?.session);
      f.modal.onClose();
      assert.equal(f.done, 0);
      f.release();
      await checking;
      assert.equal(f.done, 1);
      f.modal.onClose();
      assert.equal(f.done, 1);
      if (fail) assert.equal(f.plugin.settings.quarkNative, undefined);
    });
});

describe("Automatic Quark QR login", () => {
  it("polls every second without a confirmation button and finishes automatically", async () => {
    const f = fixture();
    f.release();
    await f.modal.onOpen();
    assert.equal(f.interval, 1000);
    assert.equal(f.buttons, 0);
    assert.ok(f.active);
    await f.check();
    assert.ok(f.plugin.settings.quarkNative?.session);
    assert.equal(f.active, false);
    assert.equal(f.done, 1);
  });
  it("keeps polling while waiting for a scan and stops after success", async () => {
    const f = fixture(false, true);
    f.release();
    await f.modal.onOpen();
    await f.check();
    assert.equal(f.plugin.settings.quarkNative, undefined);
    assert.ok(f.active);
    await f.check();
    assert.ok(f.plugin.settings.quarkNative?.session);
    assert.equal(f.active, false);
  });
  it("cancels the timer and performs no requests after closing", async () => {
    const f = fixture();
    await f.modal.onOpen();
    f.modal.onClose();
    assert.equal(f.active, false);
    await f.check();
    assert.equal(f.requests, 1);
    assert.equal(f.done, 1);
  });
  it("does not overlap checks while session persistence is pending", async () => {
    const f = fixture();
    await f.modal.onOpen();
    const checking = f.check();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const requests = f.requests;
    await f.check();
    assert.equal(f.requests, requests);
    f.release();
    await checking;
    assert.equal(f.done, 1);
  });
});
