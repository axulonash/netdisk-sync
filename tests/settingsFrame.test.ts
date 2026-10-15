import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import { createSettingsFrame } from "../src/settingsFrame";

const tick = () => new Promise((r) => setTimeout(r, 0));

function fixture(
  opts: Partial<{ desktop: boolean; unsupported: boolean }> = {}
) {
  const dom = new JSDOM("<main></main>");
  const container = dom.window.document.querySelector("main")!;
  const changes: string[] = [];
  const uiListeners: (() => void)[] = [];
  const plugin: any = {
    settings: { serviceType: "webdav" },
    syncUiStatus: "尚未同步",
    syncRun: () => Promise.resolve(),
    onSyncUiUpdate: (cb: () => void) => {
      uiListeners.push(cb);
      return () => {
        const i = uiListeners.indexOf(cb);
        if (i >= 0) uiListeners.splice(i, 1);
      };
    },
  };
  const frame = createSettingsFrame(container, plugin, {
    desktop: opts.desktop ?? true,
    unsupported: opts.unsupported ?? false,
    onServiceChange: (s) => changes.push(s),
  });
  const select = container.querySelector("select")!;
  const light = container.querySelector(".rsnext-connection-light")!;
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "测试连接"
  )!;
  const fire = (node: HTMLElement, type: string) =>
    node.dispatchEvent(new dom.window.Event(type));
  return {
    dom,
    container,
    frame,
    select,
    light,
    button,
    changes,
    fire,
    plugin,
    uiListeners,
    fireUi: () => uiListeners.slice().forEach((cb) => cb()),
  };
}

describe("Settings frame skeleton", () => {
  it("renders service options per platform", () => {
    assert.equal(fixture({ desktop: true }).select.options.length, 4);
    assert.equal(fixture({ desktop: false }).select.options.length, 1);
  });

  it("renders the four collapsible sections in order", () => {
    const { container, frame } = fixture();
    const details = container.querySelectorAll("details");
    assert.equal(details.length, 4);
    assert.deepEqual(
      Array.from(details).map((d) => d.querySelector("summary")!.textContent),
      ["连接", "基本", "高级", "同步记录"]
    );
    assert.ok(frame.progressHost instanceof container.ownerDocument.defaultView!.HTMLElement);
  });

  it("warns and clears selection when the service is unsupported", () => {
    const { container, select } = fixture({ unsupported: true });
    assert.equal(select.value, "");
    const warning = container.querySelector(".rsnext-service-warning")!;
    assert.ok(warning);
    assert.equal(warning.textContent, "当前配置的服务已不再支持，请重新选择服务");
  });

  it("notifies listeners when the service changes", () => {
    const { select, changes, fire } = fixture();
    select.value = "baidu";
    fire(select, "change");
    assert.deepEqual(changes, ["baidu"]);
  });

  it("toggles the test button and reflects the tester result", async () => {
    const f = fixture();
    assert.equal(f.button.hidden, true);
    f.frame.setTester(null);
    assert.equal(f.button.hidden, true);

    let resolve: (r: { ok: boolean; message: string }) => void = () => {};
    f.frame.setTester(() => new Promise((r) => (resolve = r)));
    assert.equal(f.button.hidden, false);
    f.fire(f.button, "click");
    assert.equal(f.light.dataset.state, "testing");
    resolve({ ok: true, message: "连接成功" });
    await tick();
    assert.equal(f.light.dataset.state, "success");

    let resolve2: (r: { ok: boolean; message: string }) => void = () => {};
    f.frame.setTester(() => new Promise((r) => (resolve2 = r)));
    f.fire(f.button, "click");
    assert.equal(f.light.dataset.state, "testing");
    resolve2({ ok: false, message: "连接失败" });
    await tick();
    assert.equal(f.light.dataset.state, "failure");
  });

  it("clears the container and detaches listeners on cleanup", () => {
    const f = fixture();
    assert.ok(f.frame.sections.connection);
    f.frame.cleanup();
    assert.equal(f.container.childNodes.length, 0);
    assert.doesNotThrow(() => f.fire(f.select, "change"));
  });
});

describe("进度行", () => {
  it("renders the progress meter and manual sync button inside progressHost", () => {
    const { frame } = fixture();
    assert.ok(frame.progressHost.querySelector("progress"));
    const sync = Array.from(frame.progressHost.querySelectorAll("button")).find(
      (b) => b.textContent === "立即同步"
    );
    assert.ok(sync);
  });

  it("reflects the activity snapshot after an update notification", () => {
    const f = fixture();
    f.plugin.syncUiStatus = "正在同步…";
    f.plugin.syncUiActivity = {
      progress: {
        phase: "syncing",
        completed: 2,
        failed: 0,
        unexecuted: 0,
        plan: {
          total: 5,
          upload: 5,
          download: 0,
          delete: 0,
          createFolder: 0,
          conflicts: 0,
          bytes: 0,
        },
        timings: {},
      },
    };
    f.fireUi();
    const status = f.frame.progressHost.querySelector(".rsnext-status")!;
    const meter = f.frame.progressHost.querySelector("progress")!;
    assert.equal(status.textContent, "正在同步…");
    assert.equal(meter.value, 2);
    assert.equal(meter.max, 5);
  });

  it("detaches its listener and stops updating on cleanup", () => {
    const f = fixture();
    const cb = f.uiListeners[0];
    assert.ok(cb);
    f.frame.cleanup();
    assert.equal(f.uiListeners.length, 0);
    f.plugin.syncUiStatus = "同步中";
    assert.doesNotThrow(() => cb());
  });
});
