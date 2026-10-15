import type { CipherMethodType } from "./baseTypes";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";

type CloseInline = () => void;

// Inlined from lucide Eye/EyeOff so this module keeps its "no runtime obsidian
// import" property (settings.ts getEyesElements/wrapTextWithPasswordHide pull it).
const EYE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';

// Only one inline editor is open across the whole settings page; opening a new
// one closes (and empties) the previous host first.
let openInline: { host: HTMLElement; close: CloseInline | undefined } | undefined;

export function openInlineExclusive(
  host: HTMLElement,
  render: (el: HTMLElement) => CloseInline | void
): void {
  openInline?.close?.();
  openInline?.host.replaceChildren();
  openInline = { host, close: render(host) || undefined };
}

/**
 * Native "基本" section shared by the legacy tab (single source of truth until
 * renderLegacy is removed). The password block carries the legacy PasswordModal
 * copy (shortdesc + attn1-5 + second confirm + saved notice) and the encryption
 * block carries the legacy EncryptionMethodModal copy, all inline: no modals.
 */
export function renderBasicSection(
  el: HTMLElement,
  plugin: RemotelySavePlugin,
  opts: {
    advancedOnly: boolean;
    showAutomation: boolean;
    redisplay: () => void;
  }
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
  const fragment = (html: string) => {
    const tpl = doc.createElement("template");
    tpl.innerHTML = html;
    return tpl.content;
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

  const eyeToggle = (input: HTMLInputElement) => {
    const eye = node("button", "", "rsnext-eye");
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
    const box = node("div", "", "rsnext-inline-notice");
    for (const line of t("modal_password_shortdesc").split("\n")) {
      box.append(node("p", line));
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
      box.append(node("p", t(key), idx < 3 ? "password-disclaimer" : ""))
    );
    return box;
  };

  // password row: a 修改 button opens an inline input + warnings + two-step confirm
  let newPassword = `${plugin.settings.password}`;
  const editPassword = node("button", "修改");
  const password = row(
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
      const notice = node("p", "", "rsnext-inline-notice");
      notice.hidden = true;
      const confirm = node("button", "确认");
      const second = node(
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
  const editEncryption = node("button", "修改");
  const encryption = row(
    t("settings_encryptionmethod"),
    editEncryption,
    fragment(t("settings_encryptionmethod_desc"))
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
      const warning = node("div", "", "rsnext-inline-notice");
      warning.hidden = true;
      warning.append(node("h3", t("modal_encryptionmethod_title")));
      for (const line of t("modal_encryptionmethod_shortdesc").split("\n")) {
        const para = node("p");
        para.append(fragment(line));
        warning.append(para);
      }
      const confirm = node("button", "确认");
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

  if (opts.advancedOnly || !opts.showAutomation) return;

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
 * Native advanced-section rows shared by the legacy tab (single source of truth
 * until renderLegacy is removed): the ignore-paths textarea (one regex per
 * line) and the sync-config-dir toggle. The latter carries the legacy
 * SyncConfigDirModal copy inline: selecting "enable" reverts the dropdown and
 * opens the modal's attn copy + second-confirm / go-back buttons in place.
 */
export function renderAdvancedSection(
  el: HTMLElement,
  plugin: RemotelySavePlugin,
  opts: { desktop: boolean; redisplay: () => void }
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
  row(t("settings_ignorepaths"), ignorePaths, t("settings_ignorepaths_desc"));

  const dropdown = doc.createElement("select");
  for (const [value, key] of [
    ["disable", "disable"],
    ["enable", "enable"],
  ] as [string, TransItemType][]) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = t(key);
    dropdown.append(option);
  }
  dropdown.value = `${plugin.settings.syncConfigDir ? "enable" : "disable"}`;
  const configRow = row(
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
          host.append(node("p", line));
        }
        const confirm = node("button", t("modal_syncconfig_secondconfirm"));
        const back = node("button", t("goback"));
        confirm.onclick = async () => {
          plugin.settings.syncConfigDir = true;
          await plugin.saveSettings();
          secondConfirm = true;
          dropdown.value = "enable";
          host.replaceChildren(
            node("p", t("modal_syncconfig_notice"), "rsnext-inline-notice")
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
}
