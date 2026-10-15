import type { CipherMethodType } from "./baseTypes";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";

type CloseInline = () => void;

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
 * renderLegacy is removed). The password confirm persists before redisplay so
 * the re-rendered encryption-method visibility reflects the new password.
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

  // password row: a 修改 button opens an inline input + 确认 block
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
      const confirm = node("button", "确认");
      confirm.onclick = async () => {
        plugin.settings.password = newPassword;
        // persist first: redisplay re-evaluates dependent encryption visibility
        await plugin.saveSettings();
        opts.redisplay();
      };
      host.append(input, confirm);
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
          plugin.settings.encryptionMethod = value;
          await plugin.saveSettings();
        };
        label.append(radio, doc.createTextNode(t(key)));
        host.append(label);
      }
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
