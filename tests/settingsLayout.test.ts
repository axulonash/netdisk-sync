import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import {
  DEFAULT_SERVICE_TYPE,
  getServiceChoices,
  createSettingsSection,
} from "../src/settingsLayout";
import type { SUPPORTED_SERVICES_TYPE } from "../src/baseTypes";

describe("Focused settings and legacy compatibility", () => {
  it("defaults new configurations to WebDAV", () => {
    assert.equal(DEFAULT_SERVICE_TYPE, "webdav");
  });
  it("offers only implemented target services for WebDAV users", () => {
    assert.deepEqual(getServiceChoices("webdav"), ["webdav"]);
  });
  for (const service of [
    "s3",
    "dropbox",
    "onedrive",
    "onedrivefull",
    "webdis",
    "googledrive",
    "box",
    "pcloud",
    "yandexdisk",
    "koofr",
    "azureblobstorage",
  ] as SUPPORTED_SERVICES_TYPE[]) {
    it(`keeps the selected ${service} available without offering unrelated providers`, () => {
      assert.deepEqual(getServiceChoices(service), ["webdav", service]);
    });
  }
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

describe("Legacy service return path", () => {
  it("keeps a saved legacy provider selectable after reopening WebDAV settings", () => {
    assert.deepEqual(getServiceChoices("webdav", "s3"), ["webdav", "s3"]);
  });
  it("does not add a duplicate WebDAV entry", () => {
    assert.deepEqual(getServiceChoices("webdav", "webdav"), ["webdav"]);
  });
});
