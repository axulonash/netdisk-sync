import { renderSettingsSinglePage } from "./settingsSinglePage";
import { createSettingsSection, getServiceChoices } from "./settingsLayout";
import {
  renderAdvancedSection,
  renderBasicSection,
  renderDebugSection,
  renderImportExportSection,
} from "./settingsSections";
import { generateBaiduConnectionSettings } from "./native/settingsBaidu";
import { generateQuarkSettings } from "./native/settingsQuark";
import { Eye, EyeOff, createElement } from "lucide";
import {
  type App,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  requireApiVersion,
} from "obsidian";
import type { TextComponent } from "obsidian";
import type {
  ConflictActionType,
  EmptyFolderCleanType,
  QRExportType,
  SUPPORTED_SERVICES_TYPE,
  SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR,
  SyncDirectionType,
  WebdavAuthType,
} from "./baseTypes";

import { generateAzureBlobStorageSettingsPart } from "../pro/src/settingsAzureBlobStorage";
import { generateBoxSettingsPart } from "../pro/src/settingsBox";
import { generateClearDupFilesSettingsPart } from "../pro/src/settingsClearDupFiles";
import { generateGoogleDriveSettingsPart } from "../pro/src/settingsGoogleDrive";
import { generateKoofrSettingsPart } from "../pro/src/settingsKoofr";
import { generateOnedriveFullSettingsPart } from "../pro/src/settingsOnedriveFull";
import { generatePCloudSettingsPart } from "../pro/src/settingsPCloud";
import { generateProSettingsPart } from "../pro/src/settingsPro";
import { generateYandexDiskSettingsPart } from "../pro/src/settingsYandexDisk";
import { API_VER_ENSURE_REQURL_OK, VALID_REQURL } from "./baseTypesObs";
import {
  DEFAULT_DROPBOX_CONFIG,
  getAuthUrlAndVerifier as getAuthUrlAndVerifierDropbox,
  sendAuthReq as sendAuthReqDropbox,
  setConfigBySuccessfullAuthInplace,
} from "./fsDropbox";
import { getClient } from "./fsGetter";
import {
  DEFAULT_ONEDRIVE_CONFIG,
  getAuthUrlAndVerifier as getAuthUrlAndVerifierOnedrive,
} from "./fsOnedrive";
import { simpleTransRemotePrefix } from "./fsS3";
import type { TransItemType } from "./i18n";
import { exportQrCodeUri } from "./importExport";
import type RemotelySavePlugin from "./main"; // unavoidable
import { checkHasSpecialCharForDir, stringToFragment } from "./misc";

class PasswordModal extends Modal {
  plugin: RemotelySavePlugin;
  newPassword: string;
  encryptionMethodSetting: Setting;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    newPassword: string,
    encryptionMethodSetting: Setting
  ) {
    super(app);
    this.plugin = plugin;
    this.newPassword = newPassword;
    this.encryptionMethodSetting = encryptionMethodSetting;
  }

  onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    // contentEl.setText("Add Or change password.");
    contentEl.createEl("h2", { text: t("modal_password_title") });
    t("modal_password_shortdesc")
      .split("\n")
      .forEach((val, idx) => {
        contentEl.createEl("p", {
          text: val,
        });
      });

    [
      t("modal_password_attn1"),
      t("modal_password_attn2"),
      t("modal_password_attn3"),
      t("modal_password_attn4"),
      t("modal_password_attn5"),
    ].forEach((val, idx) => {
      if (idx < 3) {
        contentEl.createEl("p", {
          text: val,
          cls: "password-disclaimer",
        });
      } else {
        contentEl.createEl("p", {
          text: val,
        });
      }
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t("modal_password_secondconfirm"));
        button.onClick(async () => {
          this.plugin.settings.password = this.newPassword;
          if (this.newPassword !== "") {
            this.encryptionMethodSetting.settingEl.removeClass(
              "settings-encryption-method-hide"
            );
          } else {
            this.encryptionMethodSetting.settingEl.addClass(
              "settings-encryption-method-hide"
            );
          }

          await this.plugin.saveSettings();
          new Notice(t("modal_password_notice"));
          this.close();
        });
        button.setClass("password-second-confirm");
      })
      .addButton((button) => {
        button.setButtonText(t("goback"));
        button.onClick(() => {
          this.close();
        });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class EncryptionMethodModal extends Modal {
  plugin: RemotelySavePlugin;
  constructor(app: App, plugin: RemotelySavePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    // contentEl.setText("Add Or change password.");
    contentEl.createEl("h2", { text: t("modal_encryptionmethod_title") });
    t("modal_encryptionmethod_shortdesc")
      .split("\n")
      .forEach((val, idx) => {
        contentEl.createEl("p", {
          text: stringToFragment(val),
        });
      });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText(t("confirm"));
      button.onClick(async () => {
        this.close();
      });
      button.setClass("encryptionmethod-second-confirm");
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class ChangeRemoteBaseDirModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly newRemoteBaseDir: string;
  readonly service: SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    newRemoteBaseDir: string,
    service: SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR
  ) {
    super(app);
    this.plugin = plugin;
    this.newRemoteBaseDir = newRemoteBaseDir;
    this.service = service;
  }

  onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    contentEl.createEl("h2", { text: t("modal_remotebasedir_title") });
    t("modal_remotebasedir_shortdesc")
      .split("\n")
      .forEach((val, idx) => {
        contentEl.createEl("p", {
          text: val,
        });
      });

    if (
      this.newRemoteBaseDir === "" ||
      this.newRemoteBaseDir === this.app.vault.getName()
    ) {
      new Setting(contentEl)
        .addButton((button) => {
          button.setButtonText(
            t("modal_remotebasedir_secondconfirm_vaultname")
          );
          button.onClick(async () => {
            // in the settings, the value is reset to the special case ""
            this.plugin.settings[this.service].remoteBaseDir = "";
            await this.plugin.saveSettings();
            new Notice(t("modal_remotebasedir_notice"));
            this.close();
          });
          button.setClass("remotebasedir-second-confirm");
        })
        .addButton((button) => {
          button.setButtonText(t("goback"));
          button.onClick(() => {
            this.close();
          });
        });
    } else if (checkHasSpecialCharForDir(this.newRemoteBaseDir)) {
      contentEl.createEl("p", {
        text: t("modal_remotebasedir_invaliddirhint"),
      });
      new Setting(contentEl).addButton((button) => {
        button.setButtonText(t("goback"));
        button.onClick(() => {
          this.close();
        });
      });
    } else {
      new Setting(contentEl)
        .addButton((button) => {
          button.setButtonText(t("modal_remotebasedir_secondconfirm_change"));
          button.onClick(async () => {
            this.plugin.settings[this.service].remoteBaseDir =
              this.newRemoteBaseDir;
            await this.plugin.saveSettings();
            new Notice(t("modal_remotebasedir_notice"));
            this.close();
          });
          button.setClass("remotebasedir-second-confirm");
        })
        .addButton((button) => {
          button.setButtonText(t("goback"));
          button.onClick(() => {
            this.close();
          });
        });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * s3 is special and do not necessarily the same as others
 * thus a new Modal here
 */
class ChangeS3RemotePrefixModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly newRemotePrefix: string;
  constructor(app: App, plugin: RemotelySavePlugin, newRemotePrefix: string) {
    super(app);
    this.plugin = plugin;
    this.newRemotePrefix = newRemotePrefix;
  }

  onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    contentEl.createEl("h2", { text: t("modal_remoteprefix_s3_title") });
    t("modal_remoteprefix_s3_shortdesc")
      .split("\n")
      .forEach((val, idx) => {
        contentEl.createEl("p", {
          text: val,
        });
      });

    contentEl.createEl("p", {
      text: t("modal_remoteprefix_s3_tosave", { prefix: this.newRemotePrefix }),
    });

    if (
      this.newRemotePrefix === "" ||
      this.newRemotePrefix === this.app.vault.getName()
    ) {
      new Setting(contentEl)
        .addButton((button) => {
          button.setButtonText(t("modal_remoteprefix_s3_secondconfirm_empty"));
          button.onClick(async () => {
            // in the settings, the value is reset to the special case ""
            this.plugin.settings.s3.remotePrefix = "";
            await this.plugin.saveSettings();
            new Notice(t("modal_remoteprefix_s3_notice"));
            this.close();
          });
          button.setClass("remoteprefix-second-confirm");
        })
        .addButton((button) => {
          button.setButtonText(t("goback"));
          button.onClick(() => {
            this.close();
          });
        });
    } else {
      new Setting(contentEl)
        .addButton((button) => {
          button.setButtonText(t("modal_remoteprefix_s3_secondconfirm_change"));
          button.onClick(async () => {
            this.plugin.settings.s3.remotePrefix = this.newRemotePrefix;
            await this.plugin.saveSettings();
            new Notice(t("modal_remoteprefix_s3_notice"));
            this.close();
          });
          button.setClass("remoteprefix-s3-second-confirm");
        })
        .addButton((button) => {
          button.setButtonText(t("goback"));
          button.onClick(() => {
            this.close();
          });
        });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class DropboxAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  readonly revokeAuthSetting: Setting;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement,
    revokeAuthSetting: Setting
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
    this.revokeAuthSetting = revokeAuthSetting;
  }

  async onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    let needManualPatse = false;
    const userAgent = window.navigator.userAgent.toLocaleLowerCase() || "";
    // some users report that,
    // the Linux would open another instance Obsidian if jumping back,
    // so fallback to manual paste on Linux
    if (
      Platform.isDesktopApp &&
      !Platform.isMacOS &&
      (/linux/.test(userAgent) ||
        /ubuntu/.test(userAgent) ||
        /debian/.test(userAgent) ||
        /fedora/.test(userAgent) ||
        /centos/.test(userAgent))
    ) {
      needManualPatse = true;
    }

    const { authUrl, verifier } = await getAuthUrlAndVerifierDropbox(
      this.plugin.settings.dropbox.clientID,
      needManualPatse
    );

    if (needManualPatse) {
      t("modal_dropboxauth_manualsteps")
        .split("\n")
        .forEach((val) => {
          contentEl.createEl("p", {
            text: val,
          });
        });
    } else {
      this.plugin.oauth2Info.verifier = verifier;

      t("modal_dropboxauth_autosteps")
        .split("\n")
        .forEach((val) => {
          contentEl.createEl("p", {
            text: val,
          });
        });
    }

    const div2 = contentEl.createDiv();
    div2.createEl(
      "button",
      {
        text: t("modal_dropboxauth_copybutton"),
      },
      (el) => {
        el.onclick = async () => {
          await navigator.clipboard.writeText(authUrl);
          new Notice(t("modal_dropboxauth_copynotice"));
        };
      }
    );

    contentEl.createEl("p").createEl("a", {
      href: authUrl,
      text: authUrl,
    });

    if (needManualPatse) {
      let authCode = "";
      new Setting(contentEl)
        .setName(t("modal_dropboxauth_maualinput"))
        .setDesc(t("modal_dropboxauth_maualinput_desc"))
        .addText((text) =>
          text
            .setPlaceholder("")
            .setValue("")
            .onChange((val) => {
              authCode = val.trim();
            })
        )
        .addButton(async (button) => {
          button.setButtonText(t("submit"));
          button.onClick(async () => {
            new Notice(t("modal_dropboxauth_maualinput_notice"));
            try {
              const authRes = await sendAuthReqDropbox(
                this.plugin.settings.dropbox.clientID,
                verifier,
                authCode,
                async (e: any) => {
                  new Notice(t("protocol_dropbox_connect_fail"));
                  new Notice(`${e}`);
                  throw e;
                }
              );
              const self = this;
              setConfigBySuccessfullAuthInplace(
                this.plugin.settings.dropbox,
                authRes!,
                () => self.plugin.saveSettings()
              );
              const client = getClient(
                this.plugin.settings,
                this.app.vault.getName(),
                () => this.plugin.saveSettings()
              );
              const username = await client.getUserDisplayName();
              this.plugin.settings.dropbox.username = username;
              await this.plugin.saveSettings();
              new Notice(
                t("modal_dropboxauth_maualinput_conn_succ", {
                  username: username,
                })
              );
              this.authDiv.toggleClass(
                "dropbox-auth-button-hide",
                this.plugin.settings.dropbox.username !== ""
              );
              this.revokeAuthDiv.toggleClass(
                "dropbox-revoke-auth-button-hide",
                this.plugin.settings.dropbox.username === ""
              );
              this.revokeAuthSetting.setDesc(
                t("modal_dropboxauth_maualinput_conn_succ_revoke", {
                  username: this.plugin.settings.dropbox.username,
                })
              );
              this.close();
            } catch (err) {
              console.error(err);
              new Notice(t("modal_dropboxauth_maualinput_conn_fail"));
            }
          });
        });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class OnedriveAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  readonly revokeAuthSetting: Setting;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement,
    revokeAuthSetting: Setting
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
    this.revokeAuthSetting = revokeAuthSetting;
  }

  async onOpen() {
    const { contentEl } = this;

    const { authUrl, verifier } = await getAuthUrlAndVerifierOnedrive(
      this.plugin.settings.onedrive.clientID,
      this.plugin.settings.onedrive.authority
    );
    this.plugin.oauth2Info.verifier = verifier;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    t("modal_onedriveauth_shortdesc")
      .split("\n")
      .forEach((val) => {
        contentEl.createEl("p", {
          text: val,
        });
      });
    if (Platform.isLinux) {
      t("modal_onedriveauth_shortdesc_linux")
        .split("\n")
        .forEach((val) => {
          contentEl.createEl("p", {
            text: stringToFragment(val),
          });
        });
    }
    const div2 = contentEl.createDiv();
    div2.createEl(
      "button",
      {
        text: t("modal_onedriveauth_copybutton"),
      },
      (el) => {
        el.onclick = async () => {
          await navigator.clipboard.writeText(authUrl);
          new Notice(t("modal_onedriveauth_copynotice"));
        };
      }
    );

    contentEl.createEl("p").createEl("a", {
      href: authUrl,
      text: authUrl,
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class OnedriveRevokeAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
  }

  async onOpen() {
    const { contentEl } = this;
    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    contentEl.createEl("p", {
      text: t("modal_onedriverevokeauth_step1"),
    });
    const consentUrl = "https://microsoft.com/consent";
    contentEl.createEl("p").createEl("a", {
      href: consentUrl,
      text: consentUrl,
    });

    contentEl.createEl("p", {
      text: t("modal_onedriverevokeauth_step2"),
    });

    new Setting(contentEl)
      .setName(t("modal_onedriverevokeauth_clean"))
      .setDesc(t("modal_onedriverevokeauth_clean_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("modal_onedriverevokeauth_clean_button"));
        button.onClick(async () => {
          try {
            this.plugin.settings.onedrive = JSON.parse(
              JSON.stringify(DEFAULT_ONEDRIVE_CONFIG)
            );
            await this.plugin.saveSettings();
            this.authDiv.toggleClass(
              "onedrive-auth-button-hide",
              this.plugin.settings.onedrive.username !== ""
            );
            this.revokeAuthDiv.toggleClass(
              "onedrive-revoke-auth-button-hide",
              this.plugin.settings.onedrive.username === ""
            );
            new Notice(t("modal_onedriverevokeauth_clean_notice"));
            this.close();
          } catch (err) {
            console.error(err);
            new Notice(t("modal_onedriverevokeauth_clean_fail"));
          }
        });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class SyncConfigDirModal extends Modal {
  plugin: RemotelySavePlugin;
  saveDropdownFunc: () => void;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    saveDropdownFunc: () => void
  ) {
    super(app);
    this.plugin = plugin;
    this.saveDropdownFunc = saveDropdownFunc;
  }

  async onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    t("modal_syncconfig_attn")
      .split("\n")
      .forEach((val) => {
        contentEl.createEl("p", {
          text: val,
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t("modal_syncconfig_secondconfirm"));
        button.onClick(async () => {
          this.plugin.settings.syncConfigDir = true;
          await this.plugin.saveSettings();
          this.saveDropdownFunc();
          new Notice(t("modal_syncconfig_notice"));
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText(t("goback"));
        button.onClick(() => {
          this.close();
        });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class ExportSettingsQrCodeModal extends Modal {
  plugin: RemotelySavePlugin;
  exportType: QRExportType;
  constructor(app: App, plugin: RemotelySavePlugin, exportType: QRExportType) {
    super(app);
    this.plugin = plugin;
    this.exportType = exportType;
  }

  async onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    const { rawUri, imgUri } = await exportQrCodeUri(
      this.plugin.settings,
      this.app.vault.getName(),
      this.plugin.manifest.version,
      this.exportType
    );

    const div1 = contentEl.createDiv();
    t("modal_qr_shortdesc")
      .split("\n")
      .forEach((val) => {
        div1.createEl("p", {
          text: val,
        });
      });

    const div2 = contentEl.createDiv();
    div2.createEl(
      "button",
      {
        text: t("modal_qr_button"),
      },
      (el) => {
        el.onclick = async () => {
          await navigator.clipboard.writeText(rawUri);
          new Notice(t("modal_qr_button_notice"));
        };
      }
    );

    const div3 = contentEl.createDiv();
    div3.createEl(
      "img",
      {
        cls: "qrcode-img",
      },
      async (el) => {
        el.src = imgUri;
      }
    );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

const getEyesElements = () => {
  const eyeEl = createElement(Eye);
  const eyeOffEl = createElement(EyeOff);
  return {
    eye: eyeEl.outerHTML,
    eyeOff: eyeOffEl.outerHTML,
  };
};

export const wrapTextWithPasswordHide = (text: TextComponent) => {
  const { eye, eyeOff } = getEyesElements();
  const hider = text.inputEl.insertAdjacentElement("afterend", createSpan())!;
  // the init type of hider is "hidden" === eyeOff === password
  hider.innerHTML = eyeOff;
  hider.addEventListener("click", (e) => {
    const isText = text.inputEl.getAttribute("type") === "text";
    hider.innerHTML = isText ? eyeOff : eye;
    text.inputEl.setAttribute("type", isText ? "password" : "text");
    text.inputEl.focus();
  });

  // the init type of text el is password
  text.inputEl.setAttribute("type", "password");
  return text;
};

export class RemotelySaveSettingTab extends PluginSettingTab {
  readonly plugin: RemotelySavePlugin;

  constructor(app: App, plugin: RemotelySavePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private simpleCleanup?: () => void;
  display(): void {
    this.simpleCleanup?.();
    this.containerEl.empty();
    this.simpleCleanup = renderSettingsSinglePage(
      this.containerEl,
      this.plugin,
      Platform.isDesktopApp
    );
  }
  private renderLegacy(containerEl: HTMLElement, advancedOnly=false): void {
    containerEl.style.setProperty("overflow-wrap", "break-word");

    containerEl.empty();

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    if(!advancedOnly)containerEl.createEl("h1", { text: this.plugin.manifest.name });

    //////////////////////////////////////////////////
    // below for service chooser (part 1/2)
    //////////////////////////////////////////////////

    // we need to create the div in advance of any other service divs
    const serviceChooserDiv = containerEl.createDiv();
    serviceChooserDiv.hidden=advancedOnly;
    serviceChooserDiv.createEl("h2", { text: t("settings_chooseservice") });
    generateBaiduConnectionSettings(serviceChooserDiv, this.plugin);
    generateQuarkSettings(serviceChooserDiv, this.plugin);

    //////////////////////////////////////////////////
    // below for s3
    //////////////////////////////////////////////////

    const s3Div = containerEl.createEl("div", { cls: "s3-hide" });
    s3Div.toggleClass("s3-hide", this.plugin.settings.serviceType !== "s3");
    s3Div.createEl("h2", { text: t("settings_s3") });

    const s3LongDescDiv = s3Div.createEl("div", { cls: "settings-long-desc" });

    for (const c of [
      t("settings_s3_disclaimer1"),
      t("settings_s3_disclaimer2"),
    ]) {
      s3LongDescDiv.createEl("p", {
        text: c,
        cls: "s3-disclaimer",
      });
    }

    if (!VALID_REQURL) {
      s3LongDescDiv.createEl("p", {
        text: t("settings_s3_cors"),
      });
    }

    s3LongDescDiv.createEl("p", {
      text: t("settings_s3_prod"),
    });

    const s3LinksUl = s3LongDescDiv.createEl("ul");

    s3LinksUl.createEl("li").createEl("a", {
      href: "https://docs.aws.amazon.com/general/latest/gr/s3.html",
      text: t("settings_s3_prod1"),
    });

    s3LinksUl.createEl("li").createEl("a", {
      href: "https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/getting-your-credentials.html",
      text: t("settings_s3_prod2"),
    });

    if (!VALID_REQURL) {
      s3LinksUl.createEl("li").createEl("a", {
        href: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/enabling-cors-examples.html",
        text: t("settings_s3_prod3"),
      });
    }

    new Setting(s3Div)
      .setName(t("settings_s3_endpoint"))
      .setDesc(t("settings_s3_endpoint"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.s3.s3Endpoint)
          .onChange(async (value) => {
            this.plugin.settings.s3.s3Endpoint = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(s3Div)
      .setName(t("settings_s3_region"))
      .setDesc(t("settings_s3_region_desc"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(`${this.plugin.settings.s3.s3Region}`)
          .onChange(async (value) => {
            this.plugin.settings.s3.s3Region = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(s3Div)
      .setName(t("settings_s3_accesskeyid"))
      .setDesc(t("settings_s3_accesskeyid_desc"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text
          .setPlaceholder("")
          .setValue(`${this.plugin.settings.s3.s3AccessKeyID}`)
          .onChange(async (value) => {
            this.plugin.settings.s3.s3AccessKeyID = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(s3Div)
      .setName(t("settings_s3_secretaccesskey"))
      .setDesc(t("settings_s3_secretaccesskey_desc"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text
          .setPlaceholder("")
          .setValue(`${this.plugin.settings.s3.s3SecretAccessKey}`)
          .onChange(async (value) => {
            this.plugin.settings.s3.s3SecretAccessKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(s3Div)
      .setName(t("settings_s3_bucketname"))
      .setDesc(t("settings_s3_bucketname"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(`${this.plugin.settings.s3.s3BucketName}`)
          .onChange(async (value) => {
            this.plugin.settings.s3.s3BucketName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(s3Div)
      .setName(t("settings_s3_urlstyle"))
      .setDesc(t("settings_s3_urlstyle_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption(
          "virtualHostedStyle",
          "Virtual Hosted-Style (default)"
        );
        dropdown.addOption("pathStyle", "Path-Style");
        dropdown
          .setValue(
            this.plugin.settings.s3.forcePathStyle
              ? "pathStyle"
              : "virtualHostedStyle"
          )
          .onChange(async (val: string) => {
            this.plugin.settings.s3.forcePathStyle = val === "pathStyle";
            await this.plugin.saveSettings();
          });
      });

    if (VALID_REQURL && !requireApiVersion(API_VER_ENSURE_REQURL_OK)) {
      new Setting(s3Div)
        .setName(t("settings_s3_bypasscorslocally"))
        .setDesc(t("settings_s3_bypasscorslocally_desc"))
        .addDropdown((dropdown) => {
          dropdown
            .addOption("disable", t("disable"))
            .addOption("enable", t("enable"));

          dropdown
            .setValue(
              `${
                this.plugin.settings.s3.bypassCorsLocally ? "enable" : "disable"
              }`
            )
            .onChange(async (value) => {
              if (value === "enable") {
                this.plugin.settings.s3.bypassCorsLocally = true;
              } else {
                this.plugin.settings.s3.bypassCorsLocally = false;
              }
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(s3Div)
      .setName(t("settings_s3_parts"))
      .setDesc(t("settings_s3_parts_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("1", "1");
        dropdown.addOption("2", "2");
        dropdown.addOption("3", "3");
        dropdown.addOption("5", "5");
        dropdown.addOption("10", "10");
        dropdown.addOption("15", "15");
        dropdown.addOption("20", "20 (default)");

        dropdown
          .setValue(`${this.plugin.settings.s3.partsConcurrency}`)
          .onChange(async (val) => {
            const realVal = Number.parseInt(val);
            this.plugin.settings.s3.partsConcurrency = realVal;
            await this.plugin.saveSettings();
          });
      });

    new Setting(s3Div)
      .setName(t("settings_s3_accuratemtime"))
      .setDesc(t("settings_s3_accuratemtime_desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("disable", t("disable"))
          .addOption("enable", t("enable"));

        dropdown
          .setValue(
            `${this.plugin.settings.s3.useAccurateMTime ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            if (val === "enable") {
              this.plugin.settings.s3.useAccurateMTime = true;
            } else {
              this.plugin.settings.s3.useAccurateMTime = false;
            }
            await this.plugin.saveSettings();
          });
      });

    let newS3RemotePrefix = this.plugin.settings.s3.remotePrefix || "";
    new Setting(s3Div)
      .setName(t("settings_remoteprefix_s3"))
      .setDesc(t("settings_remoteprefix_s3_desc"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(newS3RemotePrefix)
          .onChange((value) => {
            newS3RemotePrefix = simpleTransRemotePrefix(value.trim());
          })
      )
      .addButton((button) => {
        button.setButtonText(t("confirm"));
        button.onClick(() => {
          new ChangeS3RemotePrefixModal(
            this.app,
            this.plugin,
            simpleTransRemotePrefix(newS3RemotePrefix.trim())
          ).open();
        });
      });
    new Setting(s3Div)
      .setName(t("settings_s3_reverse_proxy_no_sign_url"))
      .setDesc(t("settings_s3_reverse_proxy_no_sign_url_desc"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.s3.reverseProxyNoSignUrl ?? "")
          .onChange(async (value) => {
            this.plugin.settings.s3.reverseProxyNoSignUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(s3Div)
      .setName(t("settings_s3_generatefolderobject"))
      .setDesc(t("settings_s3_generatefolderobject_desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption(
            "notgenerate",
            t("settings_s3_generatefolderobject_notgenerate")
          )
          .addOption(
            "generate",
            t("settings_s3_generatefolderobject_generate")
          );

        dropdown
          .setValue(
            `${
              this.plugin.settings.s3.generateFolderObject
                ? "generate"
                : "notgenerate"
            }`
          )
          .onChange(async (val) => {
            if (val === "generate") {
              this.plugin.settings.s3.generateFolderObject = true;
            } else {
              this.plugin.settings.s3.generateFolderObject = false;
            }
            await this.plugin.saveSettings();
          });
      });

    new Setting(s3Div)
      .setName(t("settings_checkonnectivity"))
      .setDesc(t("settings_checkonnectivity_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_checkonnectivity_button"));
        button.onClick(async () => {
          new Notice(t("settings_checkonnectivity_checking"));
          const client = getClient(
            this.plugin.settings,
            this.app.vault.getName(),
            () => this.plugin.saveSettings()
          );
          const errors = { msg: "" };
          const res = await client.checkConnect((err: any) => {
            errors.msg = err;
          });
          if (res) {
            new Notice(t("settings_s3_connect_succ"));
          } else {
            new Notice(t("settings_s3_connect_fail"));
            new Notice(errors.msg);
          }
        });
      });

    //////////////////////////////////////////////////
    // below for dropbpx
    //////////////////////////////////////////////////

    const dropboxDiv = containerEl.createEl("div", { cls: "dropbox-hide" });
    dropboxDiv.toggleClass(
      "dropbox-hide",
      this.plugin.settings.serviceType !== "dropbox"
    );
    dropboxDiv.createEl("h2", { text: t("settings_dropbox") });

    const dropboxLongDescDiv = dropboxDiv.createEl("div", {
      cls: "settings-long-desc",
    });
    for (const c of [
      t("settings_dropbox_disclaimer1"),
      t("settings_dropbox_disclaimer2"),
    ]) {
      dropboxLongDescDiv.createEl("p", {
        text: c,
        cls: "dropbox-disclaimer",
      });
    }
    dropboxLongDescDiv.createEl("p", {
      text: t("settings_dropbox_folder", {
        pluginID: this.plugin.manifest.id,
        remoteBaseDir:
          this.plugin.settings.dropbox.remoteBaseDir ||
          this.app.vault.getName(),
      }),
    });

    const dropboxSelectAuthDiv = dropboxDiv.createDiv();
    const dropboxAuthDiv = dropboxSelectAuthDiv.createDiv({
      cls: "dropbox-auth-button-hide settings-auth-related",
    });
    const dropboxRevokeAuthDiv = dropboxSelectAuthDiv.createDiv({
      cls: "dropbox-revoke-auth-button-hide settings-auth-related",
    });

    const dropboxRevokeAuthSetting = new Setting(dropboxRevokeAuthDiv)
      .setName(t("settings_dropbox_revoke"))
      .setDesc(
        t("settings_dropbox_revoke_desc", {
          username: this.plugin.settings.dropbox.username,
        })
      )
      .addButton(async (button) => {
        button.setButtonText(t("settings_dropbox_revoke_button"));
        button.onClick(async () => {
          try {
            const client = getClient(
              this.plugin.settings,
              this.app.vault.getName(),
              () => this.plugin.saveSettings()
            );
            await client.revokeAuth();
            this.plugin.settings.dropbox = JSON.parse(
              JSON.stringify(DEFAULT_DROPBOX_CONFIG)
            );
            await this.plugin.saveSettings();
            dropboxAuthDiv.toggleClass(
              "dropbox-auth-button-hide",
              this.plugin.settings.dropbox.username !== ""
            );
            dropboxRevokeAuthDiv.toggleClass(
              "dropbox-revoke-auth-button-hide",
              this.plugin.settings.dropbox.username === ""
            );
            new Notice(t("settings_dropbox_revoke_notice"));
          } catch (err) {
            console.error(err);
            new Notice(t("settings_dropbox_revoke_noticeerr"));
          }
        });
      });

    new Setting(dropboxRevokeAuthDiv)
      .setName(t("settings_dropbox_clearlocal"))
      .setDesc(t("settings_dropbox_clearlocal_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_dropbox_clearlocal_button"));
        button.onClick(async () => {
          this.plugin.settings.dropbox = JSON.parse(
            JSON.stringify(DEFAULT_DROPBOX_CONFIG)
          );
          await this.plugin.saveSettings();
          dropboxAuthDiv.toggleClass(
            "dropbox-auth-button-hide",
            this.plugin.settings.dropbox.username !== ""
          );
          dropboxRevokeAuthDiv.toggleClass(
            "dropbox-revoke-auth-button-hide",
            this.plugin.settings.dropbox.username === ""
          );
          new Notice(t("settings_dropbox_clearlocal_notice"));
        });
      });

    new Setting(dropboxAuthDiv)
      .setName(t("settings_dropbox_auth"))
      .setDesc(t("settings_dropbox_auth_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_dropbox_auth_button"));
        button.onClick(async () => {
          const modal = new DropboxAuthModal(
            this.app,
            this.plugin,
            dropboxAuthDiv,
            dropboxRevokeAuthDiv,
            dropboxRevokeAuthSetting
          );
          this.plugin.oauth2Info.helperModal = modal;
          this.plugin.oauth2Info.authDiv = dropboxAuthDiv;
          this.plugin.oauth2Info.revokeDiv = dropboxRevokeAuthDiv;
          this.plugin.oauth2Info.revokeAuthSetting = dropboxRevokeAuthSetting;
          modal.open();
        });
      });

    dropboxAuthDiv.toggleClass(
      "dropbox-auth-button-hide",
      this.plugin.settings.dropbox.username !== ""
    );
    dropboxRevokeAuthDiv.toggleClass(
      "dropbox-revoke-auth-button-hide",
      this.plugin.settings.dropbox.username === ""
    );

    let newDropboxRemoteBaseDir =
      this.plugin.settings.dropbox.remoteBaseDir || "";
    new Setting(dropboxDiv)
      .setName(t("settings_remotebasedir"))
      .setDesc(t("settings_remotebasedir_desc"))
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(newDropboxRemoteBaseDir)
          .onChange((value) => {
            newDropboxRemoteBaseDir = value.trim();
          })
      )
      .addButton((button) => {
        button.setButtonText(t("confirm"));
        button.onClick(() => {
          new ChangeRemoteBaseDirModal(
            this.app,
            this.plugin,
            newDropboxRemoteBaseDir,
            "dropbox"
          ).open();
        });
      });

    new Setting(dropboxDiv)
      .setName(t("settings_checkonnectivity"))
      .setDesc(t("settings_checkonnectivity_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_checkonnectivity_button"));
        button.onClick(async () => {
          new Notice(t("settings_checkonnectivity_checking"));
          const client = getClient(
            this.plugin.settings,
            this.app.vault.getName(),
            () => this.plugin.saveSettings()
          );

          const errors = { msg: "" };
          const res = await client.checkConnect((err: any) => {
            errors.msg = `${err}`;
          });
          if (res) {
            new Notice(t("settings_dropbox_connect_succ"));
          } else {
            new Notice(t("settings_dropbox_connect_fail"));
            new Notice(errors.msg);
          }
        });
      });

    //////////////////////////////////////////////////
    // below for onedrive
    //////////////////////////////////////////////////

    const onedriveDiv = containerEl.createEl("div", { cls: "onedrive-hide" });
    onedriveDiv.toggleClass(
      "onedrive-hide",
      this.plugin.settings.serviceType !== "onedrive"
    );
    onedriveDiv.createEl("h2", { text: t("settings_onedrive") });
    const onedriveLongDescDiv = onedriveDiv.createEl("div", {
      cls: "settings-long-desc",
    });
    for (const c of [
      t("settings_onedrive_disclaimer1"),
      t("settings_onedrive_disclaimer2"),
    ]) {
      onedriveLongDescDiv.createEl("p", {
        text: c,
        cls: "onedrive-disclaimer",
      });
    }

    onedriveLongDescDiv.createEl("p", {
      text: t("settings_onedrive_folder", {
        pluginID: this.plugin.manifest.id,
        remoteBaseDir:
          this.plugin.settings.onedrive.remoteBaseDir ||
          this.app.vault.getName(),
      }),
    });

    onedriveLongDescDiv.createEl("p", {
      text: t("settings_onedrive_nobiz"),
    });

    const onedriveSelectAuthDiv = onedriveDiv.createDiv();
    const onedriveAuthDiv = onedriveSelectAuthDiv.createDiv({
      cls: "onedrive-auth-button-hide settings-auth-related",
    });
    const onedriveRevokeAuthDiv = onedriveSelectAuthDiv.createDiv({
      cls: "onedrive-revoke-auth-button-hide settings-auth-related",
    });

    const onedriveRevokeAuthSetting = new Setting(onedriveRevokeAuthDiv)
      .setName(t("settings_onedrive_revoke"))
      .setDesc(
        t("settings_onedrive_revoke_desc", {
          username: this.plugin.settings.onedrive.username,
        })
      )
      .addButton(async (button) => {
        button.setButtonText(t("settings_onedrive_revoke_button"));
        button.onClick(async () => {
          new OnedriveRevokeAuthModal(
            this.app,
            this.plugin,
            onedriveAuthDiv,
            onedriveRevokeAuthDiv
          ).open();
        });
      });

    new Setting(onedriveAuthDiv)
      .setName(t("settings_onedrive_auth"))
      .setDesc(t("settings_onedrive_auth_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_onedrive_auth_button"));
        button.onClick(async () => {
          const modal = new OnedriveAuthModal(
            this.app,
            this.plugin,
            onedriveAuthDiv,
            onedriveRevokeAuthDiv,
            onedriveRevokeAuthSetting
          );
          this.plugin.oauth2Info.helperModal = modal;
          this.plugin.oauth2Info.authDiv = onedriveAuthDiv;
          this.plugin.oauth2Info.revokeDiv = onedriveRevokeAuthDiv;
          this.plugin.oauth2Info.revokeAuthSetting = onedriveRevokeAuthSetting;
          modal.open();
        });
      });

    onedriveAuthDiv.toggleClass(
      "onedrive-auth-button-hide",
      this.plugin.settings.onedrive.username !== ""
    );
    onedriveRevokeAuthDiv.toggleClass(
      "onedrive-revoke-auth-button-hide",
      this.plugin.settings.onedrive.username === ""
    );

    let newOnedriveRemoteBaseDir =
      this.plugin.settings.onedrive.remoteBaseDir || "";
    new Setting(onedriveDiv)
      .setName(t("settings_remotebasedir"))
      .setDesc(t("settings_remotebasedir_desc"))
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(newOnedriveRemoteBaseDir)
          .onChange((value) => {
            newOnedriveRemoteBaseDir = value.trim();
          })
      )
      .addButton((button) => {
        button.setButtonText(t("confirm"));
        button.onClick(() => {
          new ChangeRemoteBaseDirModal(
            this.app,
            this.plugin,
            newOnedriveRemoteBaseDir,
            "onedrive"
          ).open();
        });
      });

    new Setting(onedriveDiv)
      .setName(t("settings_onedrive_emptyfile"))
      .setDesc(t("settings_onedrive_emptyfile_desc"))
      .addDropdown(async (dropdown) => {
        dropdown
          .addOption("skip", t("settings_onedrive_emptyfile_skip"))
          .addOption("error", t("settings_onedrive_emptyfile_error"))
          .setValue(this.plugin.settings.onedrive.emptyFile)
          .onChange(async (val) => {
            this.plugin.settings.onedrive.emptyFile = val as any;
            await this.plugin.saveSettings();
          });
      });

    new Setting(onedriveDiv)
      .setName(t("settings_checkonnectivity"))
      .setDesc(t("settings_checkonnectivity_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_checkonnectivity_button"));
        button.onClick(async () => {
          new Notice(t("settings_checkonnectivity_checking"));
          const client = getClient(
            this.plugin.settings,
            this.app.vault.getName(),
            () => this.plugin.saveSettings()
          );
          const errors = { msg: "" };
          const res = await client.checkConnect((err: any) => {
            errors.msg = `${err}`;
          });
          if (res) {
            new Notice(t("settings_onedrive_connect_succ"));
          } else {
            new Notice(t("settings_onedrive_connect_fail"));
            new Notice(errors.msg);
          }
        });
      });

    //////////////////////////////////////////////////
    // below for webdav
    //////////////////////////////////////////////////

    const webdavDiv = containerEl.createEl("div", { cls: "webdav-hide" });
    webdavDiv.toggleClass(
      "webdav-hide",
      this.plugin.settings.serviceType !== "webdav"
    );

    webdavDiv.createEl("h2", { text: t("settings_webdav") });

    const webdavLongDescDiv = webdavDiv.createEl("div", {
      cls: "settings-long-desc",
    });

    webdavLongDescDiv.createEl("p", {
      text: t("settings_webdav_disclaimer1"),
      cls: "webdav-disclaimer",
    });

    if (!VALID_REQURL) {
      webdavLongDescDiv.createEl("p", {
        text: t("settings_webdav_cors_os"),
      });

      webdavLongDescDiv.createEl("p", {
        text: t("settings_webdav_cors"),
      });
    }

    webdavLongDescDiv.createEl("p", {
      text: t("settings_webdav_folder", {
        remoteBaseDir:
          this.plugin.settings.webdav.remoteBaseDir || this.app.vault.getName(),
      }),
    });

    new Setting(webdavDiv)
      .setName(t("settings_webdav_addr"))
      .setDesc(t("settings_webdav_addr_desc"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.webdav.address)
          .onChange(async (value) => {
            this.plugin.settings.webdav.address = value.trim();
            // deprecate auto on 20240116, force to manual_1
            if (
              this.plugin.settings.webdav.depth === "auto" ||
              this.plugin.settings.webdav.depth === "auto_1" ||
              this.plugin.settings.webdav.depth === "auto_infinity" ||
              this.plugin.settings.webdav.depth === "auto_unknown"
            ) {
              this.plugin.settings.webdav.depth = "manual_1";
            }

            // normally saved
            await this.plugin.saveSettings();
          })
      );

    new Setting(webdavDiv)
      .setName(t("settings_webdav_user"))
      .setDesc(t("settings_webdav_user_desc"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.webdav.username)
          .onChange(async (value) => {
            this.plugin.settings.webdav.username = value.trim();
            // deprecate auto on 20240116, force to manual_1
            if (
              this.plugin.settings.webdav.depth === "auto" ||
              this.plugin.settings.webdav.depth === "auto_1" ||
              this.plugin.settings.webdav.depth === "auto_infinity" ||
              this.plugin.settings.webdav.depth === "auto_unknown"
            ) {
              this.plugin.settings.webdav.depth = "manual_1";
            }
            await this.plugin.saveSettings();
          });
      });

    new Setting(webdavDiv)
      .setName(t("settings_webdav_password"))
      .setDesc(t("settings_webdav_password_desc"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.webdav.password)
          .onChange(async (value) => {
            this.plugin.settings.webdav.password = value.trim();
            // deprecate auto on 20240116, force to manual_1
            if (
              this.plugin.settings.webdav.depth === "auto" ||
              this.plugin.settings.webdav.depth === "auto_1" ||
              this.plugin.settings.webdav.depth === "auto_infinity" ||
              this.plugin.settings.webdav.depth === "auto_unknown"
            ) {
              this.plugin.settings.webdav.depth = "manual_1";
            }
            await this.plugin.saveSettings();
          });
      });

    const webdavAdvancedDiv = createSettingsSection(
      webdavDiv,
      t("settings_webdav_advanced")
    );
    if(advancedOnly){
      const wrapper=webdavAdvancedDiv.parentElement as HTMLDetailsElement;
      for(const child of Array.from(wrapper.parentElement!.children))if(child!==wrapper)(child as HTMLElement).hidden=true;
      wrapper.open=true;
    }
    new Setting(webdavAdvancedDiv)
      .setName(t("settings_webdav_auth"))
      .setDesc(t("settings_webdav_auth_desc"))
      .addDropdown(async (dropdown) => {
        dropdown.addOption("basic", "basic");
        if (VALID_REQURL) {
          dropdown.addOption("digest", "digest");
        }

        // new version config, copied to old version, we need to reset it
        if (!VALID_REQURL && this.plugin.settings.webdav.authType !== "basic") {
          this.plugin.settings.webdav.authType = "basic";
          await this.plugin.saveSettings();
        }

        dropdown
          .setValue(this.plugin.settings.webdav.authType)
          .onChange(async (val) => {
            this.plugin.settings.webdav.authType = val as WebdavAuthType;
            await this.plugin.saveSettings();
          });
      });

    new Setting(webdavAdvancedDiv)
      .setName(t("settings_webdav_depth"))
      .setDesc(t("settings_webdav_depth_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("manual_1", t("settings_webdav_depth_1"));
        dropdown.addOption("manual_infinity", t("settings_webdav_depth_inf"));

        dropdown
          .setValue(this.plugin.settings.webdav.depth || "manual_1")
          .onChange(async (val) => {
            if (val === "manual_1") {
              this.plugin.settings.webdav.depth = "manual_1";
              this.plugin.settings.webdav.manualRecursive = true;
            } else if (val === "manual_infinity") {
              this.plugin.settings.webdav.depth = "manual_infinity";
              this.plugin.settings.webdav.manualRecursive = false;
            }

            // normally save
            await this.plugin.saveSettings();
          });
      });

    new Setting(webdavAdvancedDiv)
      .setName(t("settings_webdav_customheaders"))
      .setDesc(stringToFragment(t("settings_webdav_customheaders_desc")))
      .addTextArea((textArea) => {
        textArea
          .setPlaceholder(`X-Header1: Value1\nX-Header2: Value2`)
          .setValue(`${this.plugin.settings.webdav.customHeaders ?? ""}`)
          .onChange(async (value) => {
            this.plugin.settings.webdav.customHeaders = value
              .trim()
              .split("\n")
              .filter((x) => x.trim() !== "")
              .join("\n");
            await this.plugin.saveSettings();
          });
        textArea.inputEl.rows = 10;
        textArea.inputEl.cols = 30;

        textArea.inputEl.addClass("webdav-customheaders-textarea");
      });

    let newWebdavRemoteBaseDir =
      this.plugin.settings.webdav.remoteBaseDir || "";
    new Setting(webdavDiv)
      .setName(t("settings_remotebasedir"))
      .setDesc(t("settings_remotebasedir_desc"))
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(newWebdavRemoteBaseDir)
          .onChange((value) => {
            newWebdavRemoteBaseDir = value.trim();
          })
      )
      .addButton((button) => {
        button.setButtonText(t("confirm"));
        button.onClick(() => {
          new ChangeRemoteBaseDirModal(
            this.app,
            this.plugin,
            newWebdavRemoteBaseDir,
            "webdav"
          ).open();
        });
      });

    new Setting(webdavDiv)
      .setName(t("settings_checkonnectivity"))
      .setDesc(t("settings_checkonnectivity_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_checkonnectivity_button"));
        button.onClick(async () => {
          new Notice(t("settings_checkonnectivity_checking"));
          const client = getClient(
            this.plugin.settings,
            this.app.vault.getName(),
            () => this.plugin.saveSettings()
          );
          const errors = { msg: "" };
          const res = await client.checkConnect((err: any) => {
            errors.msg = `${err}`;
          });
          if (res) {
            new Notice(t("settings_webdav_connect_succ"));
          } else {
            if (VALID_REQURL) {
              new Notice(t("settings_webdav_connect_fail"));
            } else {
              new Notice(t("settings_webdav_connect_fail_withcors"));
            }
            new Notice(errors.msg);
          }
        });
      });

    //////////////////////////////////////////////////
    // below for webdis
    //////////////////////////////////////////////////

    const webdisDiv = containerEl.createEl("div", { cls: "webdis-hide" });
    webdisDiv.toggleClass(
      "webdis-hide",
      this.plugin.settings.serviceType !== "webdis"
    );

    webdisDiv.createEl("h2", { text: t("settings_webdis") });

    const webdisLongDescDiv = webdisDiv.createEl("div", {
      cls: "settings-long-desc",
    });

    for (const c of [
      t("settings_webdis_disclaimer1"),
      t("settings_webdis_disclaimer2"),
    ]) {
      webdisLongDescDiv.createEl("p", {
        text: c,
        cls: "webdis-disclaimer",
      });
    }

    webdisLongDescDiv.createEl("p", {
      text: t("settings_webdis_folder", {
        remoteBaseDir:
          this.plugin.settings.webdis.remoteBaseDir || this.app.vault.getName(),
      }),
    });

    new Setting(webdisDiv)
      .setName(t("settings_webdis_addr"))
      .setDesc(t("settings_webdis_addr_desc"))
      .addText((text) =>
        text
          .setPlaceholder("https://")
          .setValue(this.plugin.settings.webdis.address)
          .onChange(async (value) => {
            this.plugin.settings.webdis.address = value.trim();
            // normally saved
            await this.plugin.saveSettings();
          })
      );

    new Setting(webdisDiv)
      .setName(t("settings_webdis_user"))
      .setDesc(t("settings_webdis_user_desc"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.webdis.username ?? "")
          .onChange(async (value) => {
            this.plugin.settings.webdis.username = (value ?? "").trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(webdisDiv)
      .setName(t("settings_webdis_password"))
      .setDesc(t("settings_webdis_password_desc"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.webdis.password ?? "")
          .onChange(async (value) => {
            this.plugin.settings.webdis.password = (value ?? "").trim();
            await this.plugin.saveSettings();
          });
      });

    let newWebdisRemoteBaseDir =
      this.plugin.settings.webdis.remoteBaseDir || "";
    new Setting(webdisDiv)
      .setName(t("settings_remotebasedir"))
      .setDesc(t("settings_remotebasedir_desc"))
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(newWebdisRemoteBaseDir)
          .onChange((value) => {
            newWebdisRemoteBaseDir = value.trim();
          })
      )
      .addButton((button) => {
        button.setButtonText(t("confirm"));
        button.onClick(() => {
          new ChangeRemoteBaseDirModal(
            this.app,
            this.plugin,
            newWebdisRemoteBaseDir,
            "webdis"
          ).open();
        });
      });

    new Setting(webdisDiv)
      .setName(t("settings_checkonnectivity"))
      .setDesc(t("settings_checkonnectivity_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_checkonnectivity_button"));
        button.onClick(async () => {
          new Notice(t("settings_checkonnectivity_checking"));
          const client = getClient(
            this.plugin.settings,
            this.app.vault.getName(),
            () => this.plugin.saveSettings()
          );
          const errors = { msg: "" };
          const res = await client.checkConnect((err: any) => {
            errors.msg = `${err}`;
          });
          if (res) {
            new Notice(t("settings_webdis_connect_succ"));
          } else {
            new Notice(t("settings_webdis_connect_fail"));
            new Notice(errors.msg);
          }
        });
      });

    //////////////////////////////////////////////////
    // below for Onedrive (Full)
    //////////////////////////////////////////////////

    const {
      onedriveFullDiv,
      onedriveFullAllowedToUsedDiv,
      onedriveFullNotShowUpHintSetting,
    } = generateOnedriveFullSettingsPart(
      containerEl,
      t,
      this.app,
      this.plugin,
      () => this.plugin.saveSettings()
    );

    //////////////////////////////////////////////////
    // below for googledrive
    //////////////////////////////////////////////////

    const {
      googleDriveDiv,
      googleDriveAllowedToUsedDiv,
      googleDriveNotShowUpHintSetting,
    } = generateGoogleDriveSettingsPart(
      containerEl,
      t,
      this.app,
      this.plugin,
      () => this.plugin.saveSettings()
    );

    //////////////////////////////////////////////////
    // below for box
    //////////////////////////////////////////////////

    const { boxDiv, boxAllowedToUsedDiv, boxNotShowUpHintSetting } =
      generateBoxSettingsPart(containerEl, t, this.app, this.plugin, () =>
        this.plugin.saveSettings()
      );

    //////////////////////////////////////////////////
    // below for pcloud
    //////////////////////////////////////////////////

    const { pCloudDiv, pCloudAllowedToUsedDiv, pCloudNotShowUpHintSetting } =
      generatePCloudSettingsPart(containerEl, t, this.app, this.plugin, () =>
        this.plugin.saveSettings()
      );

    //////////////////////////////////////////////////
    // below for yandexdisk
    //////////////////////////////////////////////////

    const {
      yandexDiskDiv,
      yandexDiskAllowedToUsedDiv,
      yandexDiskNotShowUpHintSetting,
    } = generateYandexDiskSettingsPart(
      containerEl,
      t,
      this.app,
      this.plugin,
      () => this.plugin.saveSettings()
    );

    //////////////////////////////////////////////////
    // below for koofr
    //////////////////////////////////////////////////

    const { koofrDiv, koofrAllowedToUsedDiv, koofrNotShowUpHintSetting } =
      generateKoofrSettingsPart(containerEl, t, this.app, this.plugin, () =>
        this.plugin.saveSettings()
      );

    //////////////////////////////////////////////////
    // below for Azure Blob Storage
    //////////////////////////////////////////////////

    const {
      azureBlobStorageDiv,
      azureBlobStorageAllowedToUsedDiv,
      azureBlobStorageNotShowUpHintSetting,
    } = generateAzureBlobStorageSettingsPart(
      containerEl,
      t,
      this.app,
      this.plugin,
      () => this.plugin.saveSettings()
    );

    //////////////////////////////////////////////////
    // below for general chooser (part 2/2)
    //////////////////////////////////////////////////

    if (
      !["webdav", "baidu", "quark", "aliyun"].includes(this.plugin.settings.serviceType) ||
      this.plugin.settings.legacyServiceType
    ) {
      serviceChooserDiv.createEl("p", {
        text: t("settings_legacy_service_notice"),
      });
    }

    // we need to create chooser
    // after all service-div-s being created
    new Setting(serviceChooserDiv)
      .setName(t("settings_chooseservice"))
      .setDesc(t("settings_chooseservice_desc"))
      .addDropdown(async (dropdown) => {
        for (const service of getServiceChoices(
          this.plugin.settings.serviceType,
          this.plugin.settings.legacyServiceType,
          Platform.isDesktopApp
        )) {
          dropdown.addOption(
            service,
            service === "baidu"
              ? "百度网盘（桌面实验）"
              : service === "aliyun" ? "阿里云盘（桌面实验）"
              : service === "quark" ? "夸克网盘（桌面实验）"
              : t(`settings_chooseservice_${service}` as TransItemType)
          );
        }

        dropdown
          .setValue(this.plugin.settings.serviceType)
          .onChange(async (val) => {
            if (
              !["webdav", "baidu", "quark", "aliyun"].includes(this.plugin.settings.serviceType)
            ) {
              this.plugin.settings.legacyServiceType =
                this.plugin.settings.serviceType;
            }
            this.plugin.settings.serviceType = val as SUPPORTED_SERVICES_TYPE;
            s3Div.toggleClass(
              "s3-hide",
              this.plugin.settings.serviceType !== "s3"
            );
            dropboxDiv.toggleClass(
              "dropbox-hide",
              this.plugin.settings.serviceType !== "dropbox"
            );
            onedriveDiv.toggleClass(
              "onedrive-hide",
              this.plugin.settings.serviceType !== "onedrive"
            );
            onedriveFullDiv.toggleClass(
              "onedrivefull-hide",
              this.plugin.settings.serviceType !== "onedrivefull"
            );
            webdavDiv.toggleClass(
              "webdav-hide",
              this.plugin.settings.serviceType !== "webdav"
            );
            webdisDiv.toggleClass(
              "webdis-hide",
              this.plugin.settings.serviceType !== "webdis"
            );
            googleDriveDiv.toggleClass(
              "googledrive-hide",
              this.plugin.settings.serviceType !== "googledrive"
            );
            boxDiv.toggleClass(
              "box-hide",
              this.plugin.settings.serviceType !== "box"
            );
            pCloudDiv.toggleClass(
              "pcloud-hide",
              this.plugin.settings.serviceType !== "pcloud"
            );
            yandexDiskDiv.toggleClass(
              "yandexdisk-hide",
              this.plugin.settings.serviceType !== "yandexdisk"
            );
            koofrDiv.toggleClass(
              "koofr-hide",
              this.plugin.settings.serviceType !== "koofr"
            );
            azureBlobStorageDiv.toggleClass(
              "azureblobstorage-hide",
              this.plugin.settings.serviceType !== "azureblobstorage"
            );

            await this.plugin.saveSettings();
            this.display();
          });
      });

    //////////////////////////////////////////////////
    // below for basic settings
    //////////////////////////////////////////////////

    const basicDiv = containerEl.createEl("div");
    renderBasicSection(basicDiv, this.plugin, {
      advancedOnly,
      showAutomation: !["baidu", "quark", "aliyun"].includes(
        this.plugin.settings.serviceType
      ),
      redisplay: () => this.display(),
    });

    //////////////////////////////////////////////////
    // below for advanced settings
    //////////////////////////////////////////////////
    const advDiv = createSettingsSection(containerEl, t("settings_adv"));
    renderAdvancedSection(advDiv, this.plugin, {
      desktop: Platform.isDesktopApp,
      redisplay: () => this.display(),
      advancedOnly,
      renderClearDupFiles: (el) =>
        generateClearDupFilesSettingsPart(el, t, this.app, this.plugin),
    });

    new Setting(basicDiv)
      .setName(t("setting_syncdirection"))
      .setDesc(stringToFragment(t("setting_syncdirection_desc")))
      .addDropdown((dropdown) => {
        dropdown.addOption(
          "bidirectional",
          t("setting_syncdirection_bidirectional_desc")
        );
        dropdown.addOption(
          "incremental_push_only",
          t("setting_syncdirection_incremental_push_only_desc")
        );
        dropdown.addOption(
          "incremental_pull_only",
          t("setting_syncdirection_incremental_pull_only_desc")
        );
        dropdown.addOption(
          "incremental_push_and_delete_only",
          t("setting_syncdirection_incremental_push_and_delete_only_desc")
        );
        dropdown.addOption(
          "incremental_pull_and_delete_only",
          t("setting_syncdirection_incremental_pull_and_delete_only_desc")
        );

        dropdown
          .setValue(this.plugin.settings.syncDirection ?? "bidirectional")
          .onChange(async (val) => {
            this.plugin.settings.syncDirection = val as SyncDirectionType;
            await this.plugin.saveSettings();
          });
      });

    //////////////////////////////////////////////////
    // below for import and export functions
    //////////////////////////////////////////////////

    // import and export
    renderImportExportSection(containerEl, this.plugin);

    //////////////////////////////////////////////////
    // below for pro
    //////////////////////////////////////////////////

    const proDiv = createSettingsSection(
      containerEl,
      t("settings_account_options")
    );
    proDiv.parentElement!.hidden = ["webdav", "baidu", "quark", "aliyun"].includes(
      this.plugin.settings.serviceType
    );
    generateProSettingsPart(
      proDiv,
      t,
      this.app,
      this.plugin,
      () => this.plugin.saveSettings(),
      onedriveFullAllowedToUsedDiv,
      onedriveFullNotShowUpHintSetting,
      googleDriveAllowedToUsedDiv,
      googleDriveNotShowUpHintSetting,
      boxAllowedToUsedDiv,
      boxNotShowUpHintSetting,
      pCloudAllowedToUsedDiv,
      pCloudNotShowUpHintSetting,
      yandexDiskAllowedToUsedDiv,
      yandexDiskNotShowUpHintSetting,
      koofrAllowedToUsedDiv,
      koofrNotShowUpHintSetting,
      azureBlobStorageAllowedToUsedDiv,
      azureBlobStorageNotShowUpHintSetting
    );

    //////////////////////////////////////////////////
    // below for debug
    //////////////////////////////////////////////////

    renderDebugSection(containerEl, this.plugin);
    if(advancedOnly){
      const section=webdavAdvancedDiv.parentElement;
      for(const child of Array.from(webdavDiv.children))if(child!==section)(child as HTMLElement).hidden=true;
    }
  }

  hide() {
    this.simpleCleanup?.();this.simpleCleanup=undefined;
    const { containerEl } = this;
    containerEl.empty();
    super.hide();
  }
}
