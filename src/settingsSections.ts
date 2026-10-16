import cloneDeep from "lodash/cloneDeep";
import type {
  CipherMethodType,
  ConflictActionType,
  QRExportType,
} from "./baseTypes";
import { messyConfigToNormal } from "./configPersist";
import {
  exportVaultProfilerResultsToFiles,
  exportVaultSyncPlansToFiles,
} from "./debugMode";
import type { TransItemType } from "./i18n";
import {
  clearAllPrevSyncRecordByVault,
  clearAllSyncPlanRecords,
  destroyDBs,
  upsertLastFailedSyncTimeByVault,
  upsertLastSuccessSyncTimeByVault,
} from "./localdb";
import type RemotelySavePlugin from "./main";
import { changeMobileStatusBar } from "./misc";
import { DEFAULT_PROFILER_CONFIG } from "./profiler";

type CloseInline = () => void;

// Inlined from lucide Eye/EyeOff so this module keeps its "no runtime obsidian
// import" property (settings.ts getEyesElements/wrapTextWithPasswordHide pull it).
const EYE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';

// Only one inline editor is open across the whole settings page; opening a new
// one closes (and empties) the previous host first.
let openInline:
  | { host: HTMLElement; close: CloseInline | undefined }
  | undefined;

export function openInlineExclusive(
  host: HTMLElement,
  // biome-ignore lint/suspicious/noConfusingVoidType: a void return means "no cleanup" (callers may not return a closer)
  render: (el: HTMLElement) => CloseInline | void
): void {
  openInline?.close?.();
  openInline?.host.replaceChildren();
  openInline = { host, close: render(host) || undefined };
}

const node = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text = "",
  cls = ""
) => {
  const n = doc.createElement(tag);
  n.textContent = text;
  n.className = cls;
  return n;
};

const fragment = (doc: Document, html: string) => {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  return tpl.content;
};

const appendRow = (
  el: HTMLElement,
  name: string,
  control: HTMLElement,
  desc?: Node | string
) => {
  const doc = el.ownerDocument;
  const box = node(doc, "div", "", "rsnext-row");
  const controlBox = node(doc, "div", "", "rsnext-control");
  const inline = node(doc, "div", "", "rsnext-inline");
  controlBox.append(control, inline);
  box.append(node(doc, "label", name), controlBox);
  let hint: HTMLElement | undefined;
  if (desc !== undefined) {
    hint = node(doc, "small");
    if (typeof desc === "string") hint.textContent = desc;
    else hint.append(desc);
    box.append(hint);
  }
  el.append(box);
  return { box, inline, hint };
};

const makeSelect = (
  doc: Document,
  options: [string, string][],
  value: string,
  onchange: (value: string) => void
) => {
  const select = doc.createElement("select");
  for (const [v, label] of options) {
    const option = doc.createElement("option");
    option.value = v;
    option.textContent = label;
    select.append(option);
  }
  select.value = value;
  select.onchange = () => onchange(select.value);
  return select;
};

// Obsidian injects `require` at runtime; these run only from user-triggered
// handlers (never during module load) so this file stays importable under tsx.
const notice = (message: string) => {
  const { Notice } = require("obsidian") as typeof import("obsidian");
  new Notice(message);
};

const loadImportExport = () =>
  require("./importExport") as typeof import("./importExport");

/**
 * Native "基本" section: only the webdav automation rows (autorun, run-once,
 * sync-on-save). The password + encryption-method rows moved to 高级 (see
 * renderAdvancedSection), so a service whose 基本 held just those two rows
 * (baidu, quark, aliyun) no longer renders a 基本 section at all.
 */
export function renderBasicSection(
  el: HTMLElement,
  plugin: RemotelySavePlugin
): void {
  const doc = el.ownerDocument;
  const t = (key: TransItemType, vars?: Record<string, string>) =>
    plugin.i18n.t(key, vars);
  const node = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    cls = ""
  ) => {
    const n = doc.createElement(tag);
    n.textContent = text;
    n.className = cls;
    return n;
  };

  el.append(node("h2", t("settings_basic")));

  const row = (name: string, control: HTMLElement, desc?: Node | string) => {
    const box = node("div", "", "rsnext-row");
    const controlBox = node("div", "", "rsnext-control");
    const inline = node("div", "", "rsnext-inline");
    controlBox.append(control, inline);
    box.append(node("label", name), controlBox);
    if (desc) {
      const hint = node("small");
      if (typeof desc === "string") hint.textContent = desc;
      else hint.append(desc);
      box.append(hint);
    }
    el.append(box);
    return { box, inline };
  };

  const autorun = node("select");
  for (const [value, key] of [
    ["-1", "settings_autorun_notset"],
    [`${1000 * 60 * 1}`, "settings_autorun_1min"],
    [`${1000 * 60 * 5}`, "settings_autorun_5min"],
    [`${1000 * 60 * 10}`, "settings_autorun_10min"],
    [`${1000 * 60 * 30}`, "settings_autorun_30min"],
  ] as [string, TransItemType][]) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = t(key);
    autorun.append(option);
  }
  autorun.value = `${plugin.settings.autoRunEveryMilliseconds}`;
  autorun.onchange = async () => {
    const realVal = Number.parseInt(autorun.value);
    plugin.settings.autoRunEveryMilliseconds = realVal;
    await plugin.saveSettings();
    if (
      (realVal === undefined || realVal === null || realVal <= 0) &&
      plugin.autoRunIntervalID !== undefined
    ) {
      window.clearInterval(plugin.autoRunIntervalID);
      plugin.autoRunIntervalID = undefined;
    } else if (realVal !== undefined && realVal !== null && realVal > 0) {
      const intervalID = window.setInterval(() => {
        console.info("auto run from settings.ts");
        plugin.syncRun("auto");
      }, realVal);
      plugin.autoRunIntervalID = intervalID;
      plugin.registerInterval(intervalID);
    }
  };
  row(t("settings_autorun"), autorun, t("settings_autorun_desc"));

  const runonce = node("select");
  for (const [value, key] of [
    ["-1", "settings_runoncestartup_notset"],
    [`${1000 * 1 * 1}`, "settings_runoncestartup_1sec"],
    [`${1000 * 10 * 1}`, "settings_runoncestartup_10sec"],
    [`${1000 * 30 * 1}`, "settings_runoncestartup_30sec"],
  ] as [string, TransItemType][]) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = t(key);
    runonce.append(option);
  }
  runonce.value = `${plugin.settings.initRunAfterMilliseconds}`;
  runonce.onchange = async () => {
    plugin.settings.initRunAfterMilliseconds = Number.parseInt(runonce.value);
    await plugin.saveSettings();
  };
  row(t("settings_runoncestartup"), runonce, t("settings_runoncestartup_desc"));

  const synconsave = node("select");
  for (const [value, key] of [
    ["-1", "settings_synconsave_disable"],
    ["1000", "settings_synconsave_enable"],
  ] as [string, TransItemType][]) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = t(key);
    synconsave.append(option);
  }
  // for backward compatibility, the enabled value is a fixed number of seconds
  synconsave.value = `${(plugin.settings.syncOnSaveAfterMilliseconds ?? -1) > 0 ? "1000" : "-1"}`;
  synconsave.onchange = async () => {
    plugin.settings.syncOnSaveAfterMilliseconds = Number.parseInt(
      synconsave.value
    );
    await plugin.saveSettings();
    plugin.toggleSyncOnSaveIfSet();
  };
  row(t("settings_synconsave"), synconsave, t("settings_synconsave_desc"));
}

/**
 * Native advanced-section content shared by the legacy tab (single source of
 * truth until renderLegacy is removed): the whole 高级 area — the password and
 * encryption-method rows moved out of 基本, skip-large-files, status-bar
 * helpers, ignore/allowed paths, sync-config-dir, concurrency,
 * underscore/bookmarks/delete options, ClearDupFiles (pro, injected so this
 * module stays obsidian-free), modify-protection percentage and the mobile
 * status-bar toggle. The config-dir row carries the legacy SyncConfigDirModal
 * copy inline (attn + second-confirm / go-back in place).
 */
export function renderAdvancedSection(
  el: HTMLElement,
  plugin: RemotelySavePlugin,
  opts: {
    desktop: boolean;
    renderClearDupFiles?: (el: HTMLElement) => void;
  }
): void {
  const doc = el.ownerDocument;
  const t = (key: TransItemType, vars?: Record<string, string>) =>
    plugin.i18n.t(key, vars);

  // The password block carries the legacy PasswordModal copy (shortdesc +
  // attn1-5 + second confirm + saved notice) and the encryption block carries
  // the legacy EncryptionMethodModal copy, all inline: no modals.
  const eyeToggle = (input: HTMLInputElement) => {
    const eye = node(doc, "button", "", "rsnext-eye");
    eye.type = "button";
    eye.innerHTML = EYE_OFF_SVG;
    eye.setAttribute("aria-label", "显示密码");
    eye.onclick = () => {
      const isText = input.getAttribute("type") === "text";
      eye.innerHTML = isText ? EYE_OFF_SVG : EYE_SVG;
      eye.setAttribute("aria-label", isText ? "显示密码" : "隐藏密码");
      input.setAttribute("type", isText ? "password" : "text");
      input.focus();
    };
    return eye;
  };

  const passwordWarning = () => {
    const box = node(doc, "div", "", "rsnext-inline-notice");
    for (const line of t("modal_password_shortdesc").split("\n")) {
      box.append(node(doc, "p", line));
    }
    (
      [
        "modal_password_attn1",
        "modal_password_attn2",
        "modal_password_attn3",
        "modal_password_attn4",
        "modal_password_attn5",
      ] as TransItemType[]
    ).forEach((key, idx) =>
      box.append(node(doc, "p", t(key), idx < 3 ? "password-disclaimer" : ""))
    );
    return box;
  };

  // password row: a 修改 button opens an inline input + warnings + two-step confirm
  let newPassword = `${plugin.settings.password}`;
  const editPassword = node(doc, "button", "修改");
  const password = appendRow(
    el,
    t("settings_password"),
    editPassword,
    t("settings_password_desc")
  );
  editPassword.onclick = () =>
    openInlineExclusive(password.inline, (host) => {
      newPassword = `${plugin.settings.password}`;
      const input = doc.createElement("input");
      input.type = "password";
      input.value = newPassword;
      input.oninput = () => {
        newPassword = input.value.trim();
      };
      const warnings = passwordWarning();
      const notice = node(doc, "p", "", "rsnext-inline-notice");
      notice.hidden = true;
      const confirm = node(doc, "button", "确认");
      const second = node(
        doc,
        "button",
        t("modal_password_secondconfirm"),
        "password-second-confirm"
      );
      second.hidden = true;
      confirm.onclick = () => {
        confirm.hidden = true;
        second.hidden = false;
      };
      second.onclick = async () => {
        plugin.settings.password = newPassword;
        // persist first: the dependent encryption-method visibility changes after
        await plugin.saveSettings();
        encryption.box.classList.toggle(
          "settings-encryption-method-hide",
          newPassword === ""
        );
        notice.textContent = t("modal_password_notice");
        notice.hidden = false;
      };
      host.append(input, eyeToggle(input), warnings, notice, confirm, second);
      input.focus();
    });

  // encryption-method row: a 修改 button opens an inline radio block
  const editEncryption = node(doc, "button", "修改");
  const encryption = appendRow(
    el,
    t("settings_encryptionmethod"),
    editEncryption,
    fragment(doc, t("settings_encryptionmethod_desc"))
  );
  if (plugin.settings.password === "") {
    encryption.box.classList.add("settings-encryption-method-hide");
  }
  editEncryption.onclick = () =>
    openInlineExclusive(encryption.inline, (host) => {
      const current = plugin.settings.encryptionMethod ?? "rclone-base64";
      let pending: CipherMethodType = current;
      // legacy EncryptionMethodModal copy, surfaced inline only when a password
      // is set (changing the method then risks orphaning remote files)
      const warning = node(doc, "div", "", "rsnext-inline-notice");
      warning.hidden = true;
      warning.append(node(doc, "h3", t("modal_encryptionmethod_title")));
      for (const line of t("modal_encryptionmethod_shortdesc").split("\n")) {
        const para = node(doc, "p");
        para.append(fragment(doc, line));
        warning.append(para);
      }
      const confirm = node(doc, "button", "确认");
      confirm.hidden = true;
      const commit = async () => {
        plugin.settings.encryptionMethod = pending;
        await plugin.saveSettings();
      };
      for (const [value, key] of [
        ["rclone-base64", "settings_encryptionmethod_rclone"],
        ["openssl-base64", "settings_encryptionmethod_openssl"],
      ] as [CipherMethodType, TransItemType][]) {
        const label = doc.createElement("label");
        const radio = doc.createElement("input");
        radio.type = "radio";
        radio.name = "rsnext-encryption-method";
        radio.value = value;
        radio.checked = value === current;
        radio.onchange = async () => {
          pending = value;
          if (plugin.settings.password === "") {
            await commit();
            return;
          }
          warning.hidden = false;
          confirm.hidden = false;
        };
        label.append(radio, doc.createTextNode(t(key)));
        host.append(label);
      }
      confirm.onclick = async () => {
        await commit();
        warning.hidden = true;
        confirm.hidden = true;
      };
      host.append(warning, confirm);
    });

  const skipOptions: [string, string][] = [
    ["-1", t("settings_skiplargefiles_notset")],
  ];
  for (const mb of [1, 5, 10, 20, 50, 100, 200, 500, 1000]) {
    skipOptions.push([`${mb * 1000 * 1000}`, `${mb} MB`]);
  }
  appendRow(
    el,
    t("settings_skiplargefiles"),
    makeSelect(
      doc,
      skipOptions,
      `${plugin.settings.skipSizeLargerThan}`,
      async (val) => {
        plugin.settings.skipSizeLargerThan = Number.parseInt(val);
        await plugin.saveSettings();
      }
    ),
    t("settings_skiplargefiles_desc")
  );

  if (opts.desktop) {
    const toggle = doc.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = plugin.settings.enableStatusBarInfo ?? false;
    toggle.onchange = async () => {
      plugin.settings.enableStatusBarInfo = toggle.checked;
      await plugin.saveSettings();
      notice(t("settings_enablestatusbar_reloadrequired_notice"));
    };
    appendRow(
      el,
      t("settings_enablestatusbar_info"),
      toggle,
      t("settings_enablestatusbar_info_desc")
    );

    const reset = node(doc, "button", t("settings_resetstatusbar_button"));
    reset.onclick = async () => {
      await upsertLastSuccessSyncTimeByVault(
        plugin.db,
        plugin.vaultRandomID,
        -1
      );
      await upsertLastFailedSyncTimeByVault(
        plugin.db,
        plugin.vaultRandomID,
        -1
      );
      plugin.updateLastSyncMsg(undefined, "not_syncing", null, null);
      notice(t("settings_resetstatusbar_notice"));
    };
    appendRow(
      el,
      t("settings_resetstatusbar_time"),
      reset,
      t("settings_resetstatusbar_time_desc")
    );
  }

  const ignorePaths = doc.createElement("textarea");
  ignorePaths.className = "ignorepaths-textarea";
  ignorePaths.rows = 10;
  ignorePaths.cols = 30;
  ignorePaths.value = (plugin.settings.ignorePaths ?? []).join("\n");
  ignorePaths.oninput = async () => {
    plugin.settings.ignorePaths = ignorePaths.value
      .trim()
      .split("\n")
      .filter((x) => x.trim() !== "");
    await plugin.saveSettings();
  };
  appendRow(
    el,
    t("settings_ignorepaths"),
    ignorePaths,
    t("settings_ignorepaths_desc")
  );

  const dropdown = makeSelect(
    doc,
    [
      ["disable", t("disable")],
      ["enable", t("enable")],
    ],
    `${plugin.settings.syncConfigDir ? "enable" : "disable"}`,
    () => {}
  );
  const configRow = appendRow(
    el,
    t("settings_configdir"),
    dropdown,
    t("settings_configdir_desc", { configDir: plugin.app.vault.configDir })
  );
  let secondConfirm = false;
  dropdown.onchange = () => {
    if (dropdown.value === "enable" && !secondConfirm) {
      dropdown.value = "disable";
      openInlineExclusive(configRow.inline, (host) => {
        for (const line of t("modal_syncconfig_attn").split("\n")) {
          host.append(node(doc, "p", line));
        }
        const confirm = node(
          doc,
          "button",
          t("modal_syncconfig_secondconfirm")
        );
        const back = node(doc, "button", t("goback"));
        confirm.onclick = async () => {
          plugin.settings.syncConfigDir = true;
          await plugin.saveSettings();
          secondConfirm = true;
          dropdown.value = "enable";
          host.replaceChildren(
            node(doc, "p", t("modal_syncconfig_notice"), "rsnext-inline-notice")
          );
        };
        back.onclick = () => host.replaceChildren();
        host.append(confirm, back);
      });
    } else {
      secondConfirm = false;
      plugin.settings.syncConfigDir = false;
      configRow.inline.replaceChildren();
      void plugin.saveSettings();
    }
  };

  const onlyAllowPaths = doc.createElement("textarea");
  onlyAllowPaths.className = "onlyallowpaths-textarea";
  onlyAllowPaths.rows = 10;
  onlyAllowPaths.cols = 30;
  onlyAllowPaths.value = `${(plugin.settings.onlyAllowPaths ?? []).join("\n")}`;
  onlyAllowPaths.oninput = async () => {
    plugin.settings.onlyAllowPaths = onlyAllowPaths.value
      .trim()
      .split("\n")
      .filter((x) => x.trim() !== "");
    await plugin.saveSettings();
  };
  appendRow(
    el,
    t("settings_onlyallowpaths"),
    onlyAllowPaths,
    t("settings_onlyallowpaths_desc")
  );

  appendRow(
    el,
    t("settings_concurrency"),
    makeSelect(
      doc,
      [
        ["1", "1"],
        ["2", "2"],
        ["3", "3"],
        ["5", "5 (default)"],
        ["10", "10"],
        ["15", "15"],
        ["20", "20"],
      ],
      `${plugin.settings.concurrency}`,
      async (val) => {
        plugin.settings.concurrency = Number.parseInt(val);
        await plugin.saveSettings();
      }
    ),
    t("settings_concurrency_desc")
  );

  appendRow(
    el,
    t("settings_syncunderscore"),
    makeSelect(
      doc,
      [
        ["disable", t("disable")],
        ["enable", t("enable")],
      ],
      `${plugin.settings.syncUnderscoreItems ? "enable" : "disable"}`,
      async (val) => {
        plugin.settings.syncUnderscoreItems = val === "enable";
        await plugin.saveSettings();
      }
    ),
    t("settings_syncunderscore_desc")
  );

  appendRow(
    el,
    t("settings_bookmarks"),
    makeSelect(
      doc,
      [
        ["disable", t("disable")],
        ["enable", t("enable")],
      ],
      `${plugin.settings.syncBookmarks ? "enable" : "disable"}`,
      async (val) => {
        plugin.settings.syncBookmarks = val === "enable";
        await plugin.saveSettings();
      }
    ),
    t("settings_bookmarks_desc", { configDir: plugin.app.vault.configDir })
  );

  appendRow(
    el,
    t("settings_deletetowhere"),
    makeSelect(
      doc,
      [
        ["system", t("settings_deletetowhere_system_trash")],
        ["obsidian", t("settings_deletetowhere_obsidian_trash")],
      ],
      plugin.settings.deleteToWhere ?? "system",
      async (val) => {
        plugin.settings.deleteToWhere = val as "system" | "obsidian";
        await plugin.saveSettings();
      }
    ),
    t("settings_deletetowhere_desc")
  );

  const conflictDesc = () => {
    let desc = t("settings_conflictaction_desc");
    if ((plugin.settings.conflictAction ?? "keep_newer") === "smart_conflict") {
      desc += t("settings_conflictaction_smart_conflict_desc");
    }
    return desc;
  };
  const conflictValue = plugin.settings.conflictAction ?? "keep_newer";
  const conflictOptions: [string, string][] = [
    ["keep_newer", t("settings_conflictaction_keep_newer")],
    ["keep_both", "保留双方副本"],
    ["keep_larger", t("settings_conflictaction_keep_larger")],
    ["smart_conflict", t("settings_conflictaction_smart_conflict")],
  ];
  // Keep an out-of-list saved value selectable instead of silently resetting it.
  if (!conflictOptions.some(([value]) => value === conflictValue))
    conflictOptions.push([conflictValue, "保留现有高级策略"]);
  const conflict = appendRow(
    el,
    t("settings_conflictaction"),
    makeSelect(doc, conflictOptions, conflictValue, async (val) => {
      plugin.settings.conflictAction = val as ConflictActionType;
      await plugin.saveSettings();
      conflict.hint?.replaceChildren(fragment(doc, conflictDesc()));
    }),
    fragment(doc, conflictDesc())
  );

  // pro ClearDupFiles row (a kept feature, not a removable service)
  opts.renderClearDupFiles?.(el);

  const pctInput = doc.createElement("input");
  pctInput.type = "number";
  pctInput.placeholder = "0 ~ 100";
  const initialPct = plugin.settings.protectModifyPercentage ?? 50;
  pctInput.value = `${initialPct}`;
  pctInput.onchange = async () => {
    let k = Number.parseFloat(pctInput.value.trim());
    if (Number.isNaN(k)) return;
    if (k < 0) k = 0;
    else if (k > 100) k = 100;
    plugin.settings.protectModifyPercentage = k;
    await plugin.saveSettings();
  };
  const pctOptions: [string, string][] = [];
  for (const i of Array.from({ length: 11 }, (x, i) => i * 10)) {
    let desc = `${i}`;
    if (i === 0) desc = t("settings_protectmodifypercentage_000_desc");
    else if (i === 50) desc = t("settings_protectmodifypercentage_050_desc");
    else if (i === 100) desc = t("settings_protectmodifypercentage_100_desc");
    pctOptions.push([`${i}`, desc]);
  }
  pctOptions.push([
    "custom",
    t("settings_protectmodifypercentage_custom_desc"),
  ]);
  const initVal = initialPct % 10 === 0 ? `${initialPct}` : "custom";
  let pctCustom: { box: HTMLElement };
  const pctControl = makeSelect(doc, pctOptions, initVal, async (val) => {
    const k = Number.parseInt(val);
    if (val === "custom" || Number.isNaN(k)) {
      pctCustom.box.classList.remove("settings-percentage-custom-hide");
    } else {
      plugin.settings.protectModifyPercentage = k;
      pctCustom.box.classList.add("settings-percentage-custom-hide");
      pctInput.value = `${k}`;
      await plugin.saveSettings();
    }
  });
  appendRow(
    el,
    t("settings_protectmodifypercentage"),
    pctControl,
    t("settings_protectmodifypercentage_desc")
  );
  pctCustom = appendRow(
    el,
    t("settings_protectmodifypercentage_customfield"),
    pctInput,
    t("settings_protectmodifypercentage_customfield_desc")
  );
  if (initialPct % 10 === 0) {
    pctCustom.box.classList.add("settings-percentage-custom-hide");
  } else {
    pctCustom.box.classList.remove("settings-percentage-custom");
  }

  if (!opts.desktop) {
    const mobile = makeSelect(
      doc,
      [
        ["enable", t("enable")],
        ["disable", t("disable")],
      ],
      plugin.settings.enableMobileStatusBar ? "enable" : "disable",
      async (val) => {
        if (val === "enable") {
          plugin.settings.enableMobileStatusBar = true;
          plugin.appContainerObserver = changeMobileStatusBar("enable");
        } else {
          plugin.settings.enableMobileStatusBar = false;
          changeMobileStatusBar("disable", plugin.appContainerObserver);
          plugin.appContainerObserver?.disconnect();
          plugin.appContainerObserver = undefined;
        }
        await plugin.saveSettings();
      }
    );
    appendRow(
      el,
      t("settings_enablemobilestatusbar"),
      mobile,
      t("settings_enablemobilestatusbar_desc")
    );
  }
}

/**
 * Native import/export rows for the single page (merged into 高级). Only the
 * four native services keep a QR export button; the legacy/pro services' buttons
 * are gone. The QR code renders inline (the legacy ExportSettingsQrCodeModal
 * copy, no modal). Import reuses the existing importExport helpers.
 */
export function renderImportExportSection(
  el: HTMLElement,
  plugin: RemotelySavePlugin
): void {
  const doc = el.ownerDocument;
  const t = (key: TransItemType, vars?: Record<string, string>) =>
    plugin.i18n.t(key, vars);

  el.append(node(doc, "h2", t("settings_importexport")));

  const buttons = node(doc, "div", "", "rsnext-buttons");
  const exportRow = appendRow(
    el,
    t("settings_export"),
    buttons,
    t("settings_export_desc")
  );
  const qrTargets: [QRExportType, string][] = [
    ["basic_and_advanced", t("settings_export_basic_and_advanced_button")],
    ["webdav", t("settings_export_webdav_button")],
    ["baidu", "导出百度网盘部分"],
    ["quark", "导出夸克网盘部分"],
    ["aliyun", "导出阿里云盘部分"],
  ];
  for (const [exportType, label] of qrTargets) {
    const button = node(doc, "button", label);
    button.onclick = () =>
      openInlineExclusive(exportRow.inline, (host) =>
        renderQrCodeInline(host, plugin, exportType)
      );
    buttons.append(button);
  }

  let importSettingVal = "";
  const input = doc.createElement("input");
  input.type = "text";
  input.placeholder = "obsidian://remotely-save-next?func=settings&...";
  input.oninput = () => {
    importSettingVal = input.value;
  };
  const confirm = node(doc, "button", t("confirm"));
  confirm.onclick = async () => {
    if (importSettingVal === "") {
      notice(t("settings_import_error_notice"));
      return;
    }
    try {
      const { parseUriByHand, importQrCodeUri } = loadImportExport();
      const inputParams = parseUriByHand(importSettingVal);
      const parsed = importQrCodeUri(inputParams, plugin.app.vault.getName());
      if (parsed.status === "error") {
        notice(parsed.message);
      } else {
        const copied = cloneDeep(parsed.result);
        plugin.settings = Object.assign({}, plugin.settings, copied);
        plugin.saveSettings();
        notice(t("protocol_saveqr", { manifestName: plugin.manifest.name }));
      }
    } catch (e) {
      notice(`${e}`);
    }
    importSettingVal = "";
  };
  const importControl = node(doc, "div", "", "rsnext-buttons");
  importControl.append(input, confirm);
  appendRow(el, t("settings_import"), importControl, t("settings_import_desc"));
}

/** Inline QR block: the legacy ExportSettingsQrCodeModal content without a modal. */
function renderQrCodeInline(
  host: HTMLElement,
  plugin: RemotelySavePlugin,
  exportType: QRExportType
): void {
  const doc = host.ownerDocument;
  const t = (key: TransItemType, vars?: Record<string, string>) =>
    plugin.i18n.t(key, vars);
  for (const line of t("modal_qr_shortdesc").split("\n")) {
    host.append(node(doc, "p", line));
  }
  const copy = node(doc, "button", t("modal_qr_button"));
  const img = node(doc, "img", "", "qrcode-img");
  img.alt = "导出二维码";
  host.append(copy, img);
  void (async () => {
    try {
      const { exportQrCodeUri } = loadImportExport();
      const { rawUri, imgUri } = await exportQrCodeUri(
        plugin.settings,
        plugin.app.vault.getName(),
        plugin.manifest.version,
        exportType
      );
      copy.onclick = async () => {
        await navigator.clipboard.writeText(rawUri);
        notice(t("modal_qr_button_notice"));
      };
      img.src = imgUri;
    } catch (e) {
      // exportQrCodeUri can fail at runtime (importExport load, QR/clipboard errors)
      console.error(e);
    }
  })();
}

/** Native debug rows for the single page (merged into 高级), moved as-is. */
export function renderDebugSection(
  el: HTMLElement,
  plugin: RemotelySavePlugin
): void {
  const doc = el.ownerDocument;
  const t = (key: TransItemType, vars?: Record<string, string>) =>
    plugin.i18n.t(key, vars);

  el.append(node(doc, "h2", t("settings_debug")));

  appendRow(
    el,
    t("settings_debuglevel"),
    makeSelect(
      doc,
      [
        ["info", "info"],
        ["debug", "debug"],
      ],
      plugin.settings.currLogLevel ?? "info",
      async (val) => {
        plugin.settings.currLogLevel = val;
        await plugin.saveSettings();
        console.info(`the log level is changed to ${val}`);
      }
    ),
    t("settings_debuglevel_desc")
  );

  const output = node(
    doc,
    "button",
    t("settings_outputsettingsconsole_button")
  );
  output.onclick = async () => {
    const c = messyConfigToNormal(await plugin.loadData());
    console.info(c);
    notice(t("settings_outputsettingsconsole_notice"));
  };
  appendRow(
    el,
    t("settings_outputsettingsconsole"),
    output,
    t("settings_outputsettingsconsole_desc")
  );

  appendRow(
    el,
    t("settings_obfuscatesettingfile"),
    makeSelect(
      doc,
      [
        ["enable", t("enable")],
        ["disable", t("disable")],
      ],
      plugin.settings.obfuscateSettingFile ? "enable" : "disable",
      async (val) => {
        plugin.settings.obfuscateSettingFile = val === "enable";
        await plugin.saveSettings();
      }
    ),
    t("settings_obfuscatesettingfile_desc")
  );

  const viewRow = node(doc, "div", "", "rsnext-row");
  viewRow.append(node(doc, "label", t("settings_viewconsolelog")));
  const viewHint = node(doc, "small");
  viewHint.append(fragment(doc, t("settings_viewconsolelog_desc")));
  viewRow.append(viewHint);
  el.append(viewRow);

  const plans = node(doc, "div", "", "rsnext-buttons");
  const syncPlanButtons: [string, number, boolean][] = [
    ["settings_syncplans_button_1_only_change", 1, true],
    ["settings_syncplans_button_5_only_change", 5, true],
    ["settings_syncplans_button_1", 1, false],
    ["settings_syncplans_button_5", 5, false],
    ["settings_syncplans_button_all", -1, false],
  ];
  for (const [key, numberOfPlans, onlyChange] of syncPlanButtons) {
    const button = node(doc, "button", t(key as TransItemType));
    button.onclick = async () => {
      await exportVaultSyncPlansToFiles(
        plugin.db,
        plugin.app.vault,
        plugin.vaultRandomID,
        numberOfPlans,
        onlyChange
      );
      notice(t("settings_syncplans_notice"));
    };
    plans.append(button);
  }
  appendRow(el, t("settings_syncplans"), plans, t("settings_syncplans_desc"));

  const delPlans = node(doc, "button", t("settings_delsyncplans_button"));
  delPlans.onclick = async () => {
    await clearAllSyncPlanRecords(plugin.db);
    notice(t("settings_delsyncplans_notice"));
  };
  appendRow(
    el,
    t("settings_delsyncplans"),
    delPlans,
    t("settings_delsyncplans_desc")
  );

  const delPrev = node(doc, "button", t("settings_delprevsync_button"));
  delPrev.onclick = async () => {
    await clearAllPrevSyncRecordByVault(plugin.db, plugin.vaultRandomID);
    notice(t("settings_delprevsync_notice"));
  };
  appendRow(
    el,
    t("settings_delprevsync"),
    delPrev,
    t("settings_delprevsync_desc")
  );

  const profilerResults = node(
    doc,
    "button",
    t("settings_profiler_results_button_all")
  );
  profilerResults.onclick = async () => {
    await exportVaultProfilerResultsToFiles(
      plugin.db,
      plugin.app.vault,
      plugin.vaultRandomID
    );
    notice(t("settings_profiler_results_notice"));
  };
  appendRow(
    el,
    t("settings_profiler_results"),
    profilerResults,
    t("settings_profiler_results_desc")
  );

  const profilerDropdown = (
    key: "enable" | "enablePrinting" | "recordSize",
    nameKey: TransItemType,
    descKey: TransItemType
  ) =>
    appendRow(
      el,
      t(nameKey),
      makeSelect(
        doc,
        [
          ["enable", t("enable")],
          ["disable", t("disable")],
        ],
        plugin.settings.profiler?.[key] ? "enable" : "disable",
        async (val) => {
          if (plugin.settings.profiler === undefined) {
            plugin.settings.profiler = DEFAULT_PROFILER_CONFIG;
          }
          plugin.settings.profiler[key] = val === "enable";
          await plugin.saveSettings();
        }
      ),
      t(descKey)
    );
  profilerDropdown(
    "enable",
    "settings_profiler_enableprofiler",
    "settings_profiler_enableprofiler_desc"
  );
  profilerDropdown(
    "enablePrinting",
    "settings_profiler_enabledebugprint",
    "settings_profiler_enabledebugprint_desc"
  );
  profilerDropdown(
    "recordSize",
    "settings_profiler_recordsize",
    "settings_profiler_recordsize_desc"
  );

  const outputBasePath = node(
    doc,
    "button",
    t("settings_outputbasepathvaultid_button")
  );
  outputBasePath.onclick = () => {
    notice(plugin.getVaultBasePath());
    notice(plugin.vaultRandomID);
  };
  appendRow(
    el,
    t("settings_outputbasepathvaultid"),
    outputBasePath,
    t("settings_outputbasepathvaultid_desc")
  );

  const resetCache = node(doc, "button", t("settings_resetcache_button"));
  resetCache.onclick = async () => {
    await destroyDBs();
    notice(t("settings_resetcache_notice"));
    plugin.unload();
  };
  appendRow(
    el,
    t("settings_resetcache"),
    resetCache,
    t("settings_resetcache_desc")
  );
}
