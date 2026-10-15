import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import { createServicePicker } from "../src/settingsServicePicker";
describe("Top-level service radios", () => {
  it("exposes all four services as labeled native mutually exclusive radios", () => {
    const dom = new JSDOM("<main></main>");
    const picker = createServicePicker(dom.window.document, "baidu");
    dom.window.document.querySelector("main")!.append(picker);
    assert.equal(picker.querySelectorAll('input[type="radio"]').length, 4);
    assert.equal(
      picker.querySelector("input:checked")?.getAttribute("value"),
      "baidu"
    );
    let changed = 0;
    picker.onchange = () => {
      changed++;
    };
    (picker.querySelector('input[value="quark"]') as HTMLInputElement).click();
    assert.equal(picker.value, "quark");
    assert.equal(changed, 1);
    assert.equal(picker.querySelectorAll("input:checked").length, 1);
  });
});
