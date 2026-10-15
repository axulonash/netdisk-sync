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
  const plugin: any = { settings: { serviceType: "webdav" } };
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
  return { dom, container, frame, select, light, button, changes, fire };
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
