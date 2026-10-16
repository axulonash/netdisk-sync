import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import {
  DEFAULT_SERVICE_TYPE,
  createSettingsSection,
} from "../src/settingsLayout";

describe("Focused settings and legacy compatibility", () => {
  it("defaults new configurations to WebDAV", () => {
    assert.equal(DEFAULT_SERVICE_TYPE, "webdav");
  });
  it("renders an accessible closed section without discarding configured controls", () => {
    const dom = new JSDOM("<main></main>");
    const parent = dom.window.document.querySelector("main")!;
    const content = createSettingsSection(parent, "Advanced <settings>");
    const input = dom.window.document.createElement("input");
    input.value = "existing setting";
    content.append(input);
    const details = parent.querySelector("details")!;
    assert.ok(details);
    assert.equal(details.open, false);
    assert.equal(
      details.querySelector("summary")?.textContent,
      "Advanced <settings>"
    );
    details.open = true;
    assert.equal(details.querySelector("input")?.value, "existing setting");
    assert.equal(details.querySelectorAll("settings").length, 0);
  });
});
