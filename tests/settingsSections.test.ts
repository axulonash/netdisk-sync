import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import { openInlineExclusive, renderBasicSection } from "../src/settingsSections";

const tick = () => new Promise((r) => setTimeout(r, 0));

function fixture(settings: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  const dom = new JSDOM("<div id='host'></div>");
  const host = dom.window.document.getElementById("host")!;
  const calls: string[] = [];
  const plugin: any = {
    settings: {
      password: "",
      encryptionMethod: "rclone-base64",
      autoRunEveryMilliseconds: -1,
      initRunAfterMilliseconds: -1,
      syncOnSaveAfterMilliseconds: -1,
      serviceType: "webdav",
      ...settings,
    },
    i18n: { t: (key: string) => key },
    saveSettings: async () => {
      calls.push("save");
    },
    syncRun: () => {},
    registerInterval: () => {},
    toggleSyncOnSaveIfSet: () => {},
  };
  renderBasicSection(host, plugin, {
    advancedOnly: opts.advancedOnly === true,
    showAutomation: opts.showAutomation !== false,
    redisplay: () => {
      calls.push("redisplay");
    },
  });
  const rows = Array.from(host.querySelectorAll(".rsnext-row")) as HTMLElement[];
  const rowFor = (key: string) =>
    rows.find((r) => r.querySelector("label")?.textContent === key);
  const buttonIn = (row: HTMLElement, text: string) =>
    Array.from(row.querySelectorAll("button")).find((b) => b.textContent === text);
  return { dom, host, plugin, calls, rows, rowFor, buttonIn };
}

describe("openInlineExclusive", () => {
  it("closes the previously opened block when a new one opens", () => {
    const dom = new JSDOM("<div id='a'></div><div id='b'></div>");
    const a = dom.window.document.getElementById("a")!;
    const b = dom.window.document.getElementById("b")!;
    openInlineExclusive(a, (el) => el.append("A"));
    assert.equal(a.textContent, "A");
    openInlineExclusive(b, (el) => el.append("B"));
    assert.equal(a.textContent, "");
    assert.equal(b.textContent, "B");
  });

  it("empties the host when the same block is reopened", () => {
    const dom = new JSDOM("<div id='a'></div>");
    const a = dom.window.document.getElementById("a")!;
    openInlineExclusive(a, (el) => el.append("first"));
    openInlineExclusive(a, (el) => el.append("second"));
    assert.equal(a.textContent, "second");
  });
});

describe("renderBasicSection", () => {
  it("renders the password and encryption-method rows with their i18n labels", () => {
    const f = fixture();
    assert.ok(f.host.textContent!.includes("settings_basic"));
    assert.ok(f.rowFor("settings_password"));
    assert.ok(f.rowFor("settings_encryptionmethod"));
  });

  it("keeps only one inline editor open at a time", () => {
    const f = fixture();
    const password = f.rowFor("settings_password")!;
    const encryption = f.rowFor("settings_encryptionmethod")!;
    f.buttonIn(password, "修改")!.click();
    assert.ok(password.querySelector("input[type=password]"));
    f.buttonIn(encryption, "修改")!.click();
    assert.equal(password.querySelector("input[type=password]"), null);
    assert.ok(encryption.querySelector("input[type=radio]"));
  });

  it("saves the password before any dependent action on confirm", async () => {
    const f = fixture({ password: "old" });
    const password = f.rowFor("settings_password")!;
    f.buttonIn(password, "修改")!.click();
    const input = password.querySelector("input[type=password]") as HTMLInputElement;
    input.value = "newpass";
    input.dispatchEvent(new f.dom.window.Event("input"));
    f.buttonIn(password, "确认")!.click();
    await tick();
    assert.equal(f.plugin.settings.password, "newpass");
    assert.deepEqual(f.calls, ["save", "redisplay"]);
  });

  it("hides the automation rows unless enabled and not advanced-only", () => {
    assert.equal(fixture({}, { showAutomation: false }).rowFor("settings_autorun"), undefined);
    assert.ok(fixture({}, { showAutomation: true, advancedOnly: false }).rowFor("settings_autorun"));
    assert.equal(fixture({}, { showAutomation: true, advancedOnly: true }).rowFor("settings_autorun"), undefined);
  });

  it("hides the encryption-method row when no password is set", () => {
    const f = fixture();
    assert.ok(f.rowFor("settings_encryptionmethod")!.classList.contains("settings-encryption-method-hide"));
  });
});
