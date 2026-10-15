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

  it("renders the password warnings before the confirm button", () => {
    const f = fixture();
    const password = f.rowFor("settings_password")!;
    f.buttonIn(password, "修改")!.click();
    const text = password.textContent!;
    assert.ok(text.includes("modal_password_shortdesc"));
    for (let i = 1; i <= 5; i++) {
      assert.ok(text.includes(`modal_password_attn${i}`), `missing attn${i}`);
    }
    const firstWarning = password.querySelector("p")!;
    const confirm = f.buttonIn(password, "确认")!;
    assert.ok(
      firstWarning.compareDocumentPosition(confirm) &
        f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("requires confirm then second-confirm before saving the password", async () => {
    const f = fixture({ password: "old" });
    const password = f.rowFor("settings_password")!;
    f.buttonIn(password, "修改")!.click();
    const input = password.querySelector("input[type=password]") as HTMLInputElement;
    input.value = "newpass";
    input.dispatchEvent(new f.dom.window.Event("input"));
    // first confirm only reveals the second confirm; nothing persisted yet
    f.buttonIn(password, "确认")!.click();
    await tick();
    assert.equal(f.plugin.settings.password, "old");
    assert.deepEqual(f.calls, []);
    // second confirm persists and updates dependent visibility
    f.buttonIn(password, "modal_password_secondconfirm")!.click();
    await tick();
    assert.equal(f.plugin.settings.password, "newpass");
    assert.deepEqual(f.calls, ["save"]);
    assert.ok(password.textContent!.includes("modal_password_notice"));
    const encryption = f.rowFor("settings_encryptionmethod")!;
    assert.ok(!encryption.classList.contains("settings-encryption-method-hide"));
  });

  it("toggles the password input type via the eye control", () => {
    const f = fixture();
    const password = f.rowFor("settings_password")!;
    f.buttonIn(password, "修改")!.click();
    const input = password.querySelector("input[type=password]") as HTMLInputElement;
    const eye = password.querySelector(".rsnext-eye") as HTMLElement;
    eye.click();
    assert.equal(input.getAttribute("type"), "text");
    eye.click();
    assert.equal(input.getAttribute("type"), "password");
  });

  it("shows the encryption-method warning and needs confirm when a password is set", async () => {
    const f = fixture({ password: "secret" });
    const encryption = f.rowFor("settings_encryptionmethod")!;
    f.buttonIn(encryption, "修改")!.click();
    const openssl = Array.from(
      encryption.querySelectorAll("input[type=radio]")
    ).find((r) => (r as HTMLInputElement).value === "openssl-base64") as HTMLInputElement;
    openssl.checked = true;
    openssl.dispatchEvent(new f.dom.window.Event("change"));
    await tick();
    // warning surfaced, but nothing persisted until confirm
    assert.equal(f.plugin.settings.encryptionMethod, "rclone-base64");
    assert.deepEqual(f.calls, []);
    assert.ok(encryption.textContent!.includes("modal_encryptionmethod_shortdesc"));
    f.buttonIn(encryption, "确认")!.click();
    await tick();
    assert.equal(f.plugin.settings.encryptionMethod, "openssl-base64");
    assert.deepEqual(f.calls, ["save"]);
  });

  it("saves an encryption-method change directly when no password is set", async () => {
    const f = fixture();
    const encryption = f.rowFor("settings_encryptionmethod")!;
    f.buttonIn(encryption, "修改")!.click();
    const openssl = Array.from(
      encryption.querySelectorAll("input[type=radio]")
    ).find((r) => (r as HTMLInputElement).value === "openssl-base64") as HTMLInputElement;
    openssl.checked = true;
    openssl.dispatchEvent(new f.dom.window.Event("change"));
    await tick();
    assert.equal(f.plugin.settings.encryptionMethod, "openssl-base64");
    assert.deepEqual(f.calls, ["save"]);
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
