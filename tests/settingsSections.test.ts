import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import {
  openInlineExclusive,
  renderAdvancedSection,
  renderBasicSection,
  renderDebugSection,
  renderImportExportSection,
} from "../src/settingsSections";

const tick = () => new Promise((r) => setTimeout(r, 0));

function fixture(settings: Record<string, unknown> = {}) {
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
  renderBasicSection(host, plugin);
  const rows = Array.from(
    host.querySelectorAll(".rsnext-row")
  ) as HTMLElement[];
  const rowFor = (key: string) =>
    rows.find((r) => r.querySelector("label")?.textContent === key);
  const buttonIn = (row: HTMLElement, text: string) =>
    Array.from(row.querySelectorAll("button")).find(
      (b) => b.textContent === text
    );
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
  it("renders the webdav automation rows with their i18n labels", () => {
    const f = fixture();
    assert.ok(f.host.textContent!.includes("settings_basic"));
    assert.ok(f.rowFor("settings_autorun"));
    assert.ok(f.rowFor("settings_runoncestartup"));
    assert.ok(f.rowFor("settings_synconsave"));
  });

  it("no longer renders the password or encryption-method rows", () => {
    const f = fixture();
    assert.equal(f.rowFor("settings_password"), undefined);
    assert.equal(f.rowFor("settings_encryptionmethod"), undefined);
  });

  it("persists a sync-on-save change", async () => {
    const f = fixture();
    const synconsave = f
      .rowFor("settings_synconsave")!
      .querySelector("select") as HTMLSelectElement;
    synconsave.value = "1000";
    synconsave.dispatchEvent(new f.dom.window.Event("change"));
    await tick();
    assert.equal(f.plugin.settings.syncOnSaveAfterMilliseconds, 1000);
    assert.deepEqual(f.calls, ["save"]);
  });
});

function advancedFixture(
  settings: Record<string, unknown> = {},
  opts: Record<string, unknown> = {}
) {
  const dom = new JSDOM("<div id='host'></div>");
  const host = dom.window.document.getElementById("host")!;
  const calls: string[] = [];
  const plugin: any = {
    settings: {
      password: "",
      encryptionMethod: "rclone-base64",
      ignorePaths: [],
      syncConfigDir: false,
      ...settings,
    },
    app: { vault: { configDir: ".obsidian" } },
    i18n: { t: (key: string) => key },
    saveSettings: async () => {
      calls.push("save");
    },
  };
  renderAdvancedSection(host, plugin, {
    desktop: opts.desktop !== false,
    renderClearDupFiles: opts.renderClearDupFiles as
      | ((el: HTMLElement) => void)
      | undefined,
  });
  const rows = Array.from(
    host.querySelectorAll(".rsnext-row")
  ) as HTMLElement[];
  const rowFor = (key: string) =>
    rows.find((r) => r.querySelector("label")?.textContent === key);
  const buttonIn = (row: HTMLElement, text: string) =>
    Array.from(row.querySelectorAll("button")).find(
      (b) => b.textContent === text
    );
  return { dom, host, plugin, calls, rows, rowFor, buttonIn };
}

describe("renderAdvancedSection", () => {
  it("renders the ignore-paths editor and saves the parsed list", async () => {
    const f = advancedFixture({ ignorePaths: ["a"] });
    const row = f.rowFor("settings_ignorepaths")!;
    const ta = row.querySelector("textarea") as HTMLTextAreaElement;
    assert.ok(ta);
    assert.equal(ta.value, "a");
    ta.value = "a\nb";
    ta.dispatchEvent(new f.dom.window.Event("input"));
    await tick();
    assert.deepEqual(f.plugin.settings.ignorePaths, ["a", "b"]);
    assert.deepEqual(f.calls, ["save"]);
  });

  it("opens the sync-config-dir inline confirm and saves only on second confirm", async () => {
    const f = advancedFixture();
    const row = f.rowFor("settings_configdir")!;
    const select = row.querySelector("select") as HTMLSelectElement;
    assert.equal(select.value, "disable");
    select.value = "enable";
    select.dispatchEvent(new f.dom.window.Event("change"));
    await tick();
    // reverted to disabled and an inline confirm block opened; nothing persisted yet
    assert.equal(select.value, "disable");
    assert.equal(f.plugin.settings.syncConfigDir, false);
    assert.deepEqual(f.calls, []);
    assert.ok(row.textContent!.includes("modal_syncconfig_attn"));
    f.buttonIn(row, "modal_syncconfig_secondconfirm")!.click();
    await tick();
    assert.equal(f.plugin.settings.syncConfigDir, true);
    assert.deepEqual(f.calls, ["save"]);
    assert.equal(select.value, "enable");
  });

  it("clears the enabled notice when the config dir is disabled again", async () => {
    const f = advancedFixture();
    const row = f.rowFor("settings_configdir")!;
    const select = row.querySelector("select") as HTMLSelectElement;
    select.value = "enable";
    select.dispatchEvent(new f.dom.window.Event("change"));
    f.buttonIn(row, "modal_syncconfig_secondconfirm")!.click();
    await tick();
    assert.ok(row.textContent!.includes("modal_syncconfig_notice"));
    select.value = "disable";
    select.dispatchEvent(new f.dom.window.Event("change"));
    await tick();
    assert.equal(f.plugin.settings.syncConfigDir, false);
    assert.deepEqual(f.calls, ["save", "save"]);
    assert.ok(!row.textContent!.includes("modal_syncconfig_notice"));
  });

  it("keeps only one inline editor open inside 高级 (password vs config-dir)", () => {
    const f = advancedFixture();
    const password = f.rowFor("settings_password")!;
    f.buttonIn(password, "修改")!.click();
    assert.ok(password.querySelector("input[type=password]"));

    const configDir = f.rowFor("settings_configdir")!;
    const select = configDir.querySelector("select") as HTMLSelectElement;
    select.value = "enable";
    select.dispatchEvent(new f.dom.window.Event("change"));
    // opening the config-dir inline block closed the password one
    assert.equal(password.querySelector("input[type=password]"), null);
    assert.ok(configDir.textContent!.includes("modal_syncconfig_attn"));
  });

  it("places the moved password + encryption rows at the top of 高级", () => {
    const f = advancedFixture();
    assert.equal(
      f.rows[0].querySelector("label")?.textContent,
      "settings_password"
    );
    assert.equal(
      f.rows[1].querySelector("label")?.textContent,
      "settings_encryptionmethod"
    );
    assert.equal(
      f.rows[2].querySelector("label")?.textContent,
      "settings_skiplargefiles"
    );
  });

  it("renders the moved password row with its warnings and two-step confirm", async () => {
    const f = advancedFixture({ password: "old" });
    const password = f.rowFor("settings_password")!;
    f.buttonIn(password, "修改")!.click();
    const text = password.textContent!;
    assert.ok(text.includes("modal_password_shortdesc"));
    for (let i = 1; i <= 5; i++) {
      assert.ok(text.includes(`modal_password_attn${i}`), `missing attn${i}`);
    }
    const input = password.querySelector(
      "input[type=password]"
    ) as HTMLInputElement;
    input.value = "newpass";
    input.dispatchEvent(new f.dom.window.Event("input"));
    // first confirm only reveals the second confirm; nothing persisted yet
    f.buttonIn(password, "确认")!.click();
    await tick();
    assert.equal(f.plugin.settings.password, "old");
    assert.deepEqual(f.calls, []);
    // second confirm persists and updates the dependent visibility
    f.buttonIn(password, "modal_password_secondconfirm")!.click();
    await tick();
    assert.equal(f.plugin.settings.password, "newpass");
    assert.deepEqual(f.calls, ["save"]);
    assert.ok(password.textContent!.includes("modal_password_notice"));
    assert.ok(
      !f
        .rowFor("settings_encryptionmethod")!
        .classList.contains("settings-encryption-method-hide")
    );
  });

  it("toggles the password input type via the eye control", () => {
    const f = advancedFixture();
    const password = f.rowFor("settings_password")!;
    f.buttonIn(password, "修改")!.click();
    const input = password.querySelector(
      "input[type=password]"
    ) as HTMLInputElement;
    const eye = password.querySelector(".rsnext-eye") as HTMLElement;
    eye.click();
    assert.equal(input.getAttribute("type"), "text");
    eye.click();
    assert.equal(input.getAttribute("type"), "password");
  });

  it("hides the moved encryption row when no password is set", () => {
    const f = advancedFixture();
    assert.ok(
      f
        .rowFor("settings_encryptionmethod")!
        .classList.contains("settings-encryption-method-hide")
    );
  });

  it("shows the encryption-method warning and needs confirm when a password is set", async () => {
    const f = advancedFixture({ password: "secret" });
    const encryption = f.rowFor("settings_encryptionmethod")!;
    f.buttonIn(encryption, "修改")!.click();
    const openssl = Array.from(
      encryption.querySelectorAll("input[type=radio]")
    ).find(
      (r) => (r as HTMLInputElement).value === "openssl-base64"
    ) as HTMLInputElement;
    openssl.checked = true;
    openssl.dispatchEvent(new f.dom.window.Event("change"));
    await tick();
    // warning surfaced, but nothing persisted until confirm
    assert.equal(f.plugin.settings.encryptionMethod, "rclone-base64");
    assert.deepEqual(f.calls, []);
    assert.ok(
      encryption.textContent!.includes("modal_encryptionmethod_shortdesc")
    );
    f.buttonIn(encryption, "确认")!.click();
    await tick();
    assert.equal(f.plugin.settings.encryptionMethod, "openssl-base64");
    assert.deepEqual(f.calls, ["save"]);
  });

  it("saves an encryption-method change directly when no password is set", async () => {
    const f = advancedFixture();
    const encryption = f.rowFor("settings_encryptionmethod")!;
    f.buttonIn(encryption, "修改")!.click();
    const openssl = Array.from(
      encryption.querySelectorAll("input[type=radio]")
    ).find(
      (r) => (r as HTMLInputElement).value === "openssl-base64"
    ) as HTMLInputElement;
    openssl.checked = true;
    openssl.dispatchEvent(new f.dom.window.Event("change"));
    await tick();
    assert.equal(f.plugin.settings.encryptionMethod, "openssl-base64");
    assert.deepEqual(f.calls, ["save"]);
  });

  it("absorbs the remaining advanced rows for the single page", () => {
    const f = advancedFixture(
      {},
      {
        renderClearDupFiles: (el: HTMLElement) => el.append("CLEARDUP"),
      }
    );
    for (const key of [
      "settings_password",
      "settings_encryptionmethod",
      "settings_skiplargefiles",
      "settings_enablestatusbar_info",
      "settings_resetstatusbar_time",
      "settings_ignorepaths",
      "settings_configdir",
      "settings_onlyallowpaths",
      "settings_concurrency",
      "settings_syncunderscore",
      "settings_bookmarks",
      "settings_deletetowhere",
      "settings_conflictaction",
      "settings_protectmodifypercentage",
      "settings_protectmodifypercentage_customfield",
    ]) {
      assert.ok(f.rowFor(key), `missing row ${key}`);
    }
    assert.ok(f.host.textContent!.includes("CLEARDUP"));
  });

  it("saves the parsed allowed-paths list", async () => {
    const f = advancedFixture({ onlyAllowPaths: ["a"] });
    const ta = f
      .rowFor("settings_onlyallowpaths")!
      .querySelector("textarea") as HTMLTextAreaElement;
    assert.equal(ta.value, "a");
    ta.value = "a\nb";
    ta.dispatchEvent(new f.dom.window.Event("input"));
    await tick();
    assert.deepEqual(f.plugin.settings.onlyAllowPaths, ["a", "b"]);
    assert.deepEqual(f.calls, ["save"]);
  });

  it("shows the status-bar rows on desktop and the mobile row on mobile", () => {
    const desktop = advancedFixture({}, { desktop: true });
    assert.ok(desktop.rowFor("settings_enablestatusbar_info"));
    assert.ok(desktop.rowFor("settings_resetstatusbar_time"));
    assert.equal(desktop.rowFor("settings_enablemobilestatusbar"), undefined);
    const mobile = advancedFixture({}, { desktop: false });
    assert.equal(mobile.rowFor("settings_enablestatusbar_info"), undefined);
    assert.ok(mobile.rowFor("settings_enablemobilestatusbar"));
  });

  it("renders an existing keep_both conflict action as selected", () => {
    const f = advancedFixture({ conflictAction: "keep_both" });
    const select = f
      .rowFor("settings_conflictaction")!
      .querySelector("select") as HTMLSelectElement;
    assert.ok(
      Array.from(select.options).some((o) => o.value === "keep_both"),
      "keep_both option present"
    );
    assert.equal(select.value, "keep_both");
  });

  it("preserves an out-of-list conflict action and re-saves it unchanged", async () => {
    const f = advancedFixture({ conflictAction: "some_retired_action" });
    const select = f
      .rowFor("settings_conflictaction")!
      .querySelector("select") as HTMLSelectElement;
    const preserved = Array.from(select.options).find(
      (o) => o.value === "some_retired_action"
    );
    assert.ok(preserved, "out-of-list value keeps its own option");
    assert.equal(select.value, "some_retired_action");
    select.dispatchEvent(new f.dom.window.Event("change"));
    await tick();
    assert.equal(f.plugin.settings.conflictAction, "some_retired_action");
    assert.deepEqual(f.calls, ["save"]);
  });
});

function importExportFixture() {
  const dom = new JSDOM("<div id='host'></div>");
  const host = dom.window.document.getElementById("host")!;
  const plugin: any = {
    settings: { serviceType: "webdav" },
    app: { vault: { getName: () => "notes", configDir: ".obsidian" } },
    manifest: { version: "1.0.0" },
    i18n: { t: (key: string) => key },
    saveSettings: async () => {},
  };
  renderImportExportSection(host, plugin);
  const rows = Array.from(
    host.querySelectorAll(".rsnext-row")
  ) as HTMLElement[];
  const rowFor = (key: string) =>
    rows.find((r) => r.querySelector("label")?.textContent === key);
  const buttonIn = (row: HTMLElement, text: string) =>
    Array.from(row.querySelectorAll("button")).find(
      (b) => b.textContent === text
    );
  return { dom, host, plugin, rows, rowFor, buttonIn };
}

describe("renderImportExportSection", () => {
  it("renders the import/export rows with only the native-service QR buttons", () => {
    const f = importExportFixture();
    assert.ok(f.rowFor("settings_export"));
    assert.ok(f.rowFor("settings_import"));
    const text = f.host.textContent!;
    assert.ok(text.includes("settings_export_basic_and_advanced_button"));
    assert.ok(text.includes("settings_export_webdav_button"));
    assert.ok(text.includes("导出百度网盘部分"));
    assert.ok(text.includes("导出夸克网盘部分"));
    assert.ok(text.includes("导出阿里云盘部分"));
    for (const gone of [
      "settings_export_dropbox_button",
      "settings_export_onedrive_button",
      "settings_export_onedrivefull_button",
      "settings_export_s3_button",
      "settings_export_webdis_button",
      "settings_export_googledrive_button",
      "settings_export_box_button",
      "settings_export_pcloud_button",
      "settings_export_yandexdisk_button",
      "settings_export_koofr_button",
      "settings_export_azureblobstorage_button",
    ]) {
      assert.ok(!text.includes(gone), `should not render ${gone}`);
    }
  });

  it("opens an inline QR placeholder when an export button is clicked", () => {
    const f = importExportFixture();
    const exportRow = f.rowFor("settings_export")!;
    f.buttonIn(exportRow, "settings_export_webdav_button")!.click();
    assert.ok(exportRow.textContent!.includes("modal_qr_shortdesc"));
    assert.ok(exportRow.querySelector("img.qrcode-img"));
  });

  it("keeps only one inline editor open across advanced and import/export", () => {
    const dom = new JSDOM("<div id='adv'></div><div id='ie'></div>");
    const adv = dom.window.document.getElementById("adv")!;
    const ie = dom.window.document.getElementById("ie")!;
    const plugin: any = {
      settings: {
        serviceType: "webdav",
        password: "",
        encryptionMethod: "rclone-base64",
        ignorePaths: [],
        syncConfigDir: false,
      },
      app: { vault: { getName: () => "notes", configDir: ".obsidian" } },
      manifest: { version: "1.0.0" },
      i18n: { t: (key: string) => key },
      saveSettings: async () => {},
    };
    renderAdvancedSection(adv, plugin, { desktop: true });
    renderImportExportSection(ie, plugin);
    const rowIn = (root: HTMLElement, key: string) =>
      Array.from(root.querySelectorAll(".rsnext-row")).find(
        (r) => r.querySelector("label")?.textContent === key
      ) as HTMLElement;
    const password = rowIn(adv, "settings_password");
    Array.from(password.querySelectorAll("button"))
      .find((b) => b.textContent === "修改")!
      .click();
    assert.ok(password.querySelector("input[type=password]"));

    const exportRow = rowIn(ie, "settings_export");
    Array.from(exportRow.querySelectorAll("button"))
      .find((b) => b.textContent === "settings_export_webdav_button")!
      .click();
    assert.equal(password.querySelector("input[type=password]"), null);
    assert.ok(exportRow.querySelector("img.qrcode-img"));
  });
});

function debugFixture(settings: Record<string, unknown> = {}) {
  const dom = new JSDOM("<div id='host'></div>");
  const host = dom.window.document.getElementById("host")!;
  const plugin: any = {
    settings: {
      currLogLevel: "info",
      obfuscateSettingFile: false,
      ...settings,
    },
    app: { vault: { getName: () => "notes", configDir: ".obsidian" } },
    manifest: { version: "1.0.0", name: "netdisk-sync" },
    db: {},
    vaultRandomID: "vault",
    i18n: { t: (key: string) => key },
    loadData: async () => ({}),
    saveSettings: async () => {},
    getVaultBasePath: () => "/vault",
    unload: () => {},
  };
  renderDebugSection(host, plugin);
  const rows = Array.from(
    host.querySelectorAll(".rsnext-row")
  ) as HTMLElement[];
  const rowFor = (key: string) =>
    rows.find((r) => r.querySelector("label")?.textContent === key);
  const buttonIn = (row: HTMLElement, text: string) =>
    Array.from(row.querySelectorAll("button")).find(
      (b) => b.textContent === text
    );
  return { dom, host, plugin, rows, rowFor, buttonIn };
}

describe("renderDebugSection", () => {
  it("renders the debug rows including the reset-cache action", () => {
    const f = debugFixture();
    for (const key of [
      "settings_debuglevel",
      "settings_outputsettingsconsole",
      "settings_obfuscatesettingfile",
      "settings_viewconsolelog",
      "settings_syncplans",
      "settings_delsyncplans",
      "settings_delprevsync",
      "settings_profiler_results",
      "settings_profiler_enableprofiler",
      "settings_profiler_enabledebugprint",
      "settings_profiler_recordsize",
      "settings_outputbasepathvaultid",
      "settings_resetcache",
    ]) {
      assert.ok(f.rowFor(key), `missing row ${key}`);
    }
    assert.ok(
      f.buttonIn(f.rowFor("settings_resetcache")!, "settings_resetcache_button")
    );
    assert.ok(
      f.buttonIn(
        f.rowFor("settings_syncplans")!,
        "settings_syncplans_button_all"
      )
    );
  });
});
