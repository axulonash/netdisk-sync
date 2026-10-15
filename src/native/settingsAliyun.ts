import { Modal, Notice, Platform, Setting } from "obsidian";
import QRCode from "qrcode";
import type RemotelySavePlugin from "../main";
import { createSettingsSection } from "../settingsLayout";
import { AliyunQrLogin, aliyunRoot, type AliyunConfig } from "./aliyunAuth";
import { AliyunClient } from "./aliyunClient";
import { getAliyunPluginTransport } from "./aliyunService";
import { AliyunError } from "./aliyunTransport";

export class AliyunLoginModal extends Modal {
  private readonly login: AliyunQrLogin;
  private cancelled = false;
  private running = false;
  private finished = false;
  private timer?: ReturnType<typeof setInterval>;
  private stopPolling() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
  private finishClose() {
    if (this.cancelled && !this.running && !this.finished) {
      this.finished = true;
      this.done();
    }
  }
  constructor(
    private readonly plugin: RemotelySavePlugin,
    private readonly done: () => void = () => {}
  ) {
    super(plugin.app);
    this.login = new AliyunQrLogin(getAliyunPluginTransport(plugin));
  }
  async onOpen() {
    this.contentEl.createEl("h2", { text: "阿里云盘扫码登录" });
    const status = this.contentEl.createEl("p", { text: "正在获取二维码…" });
    const previous = this.plugin.settings.aliyunNative;
    try {
      const url = await this.login.start();
      const image = await QRCode.toDataURL(url, { width: 240, margin: 2 });
      if (this.cancelled) return;
      this.contentEl.createEl("img", {
        attr: {
          src: image,
          alt: "使用阿里云盘 App 扫码登录",
          width: "240",
          height: "240",
        },
      });
      status.textContent =
        "使用阿里云盘 App 扫码并确认，登录成功后会自动完成。二维码五分钟后失效。";
      const check = async () => {
        if (this.running || this.cancelled) return;
        this.running = true;
        try {
          const session = await this.login.check();
          if (this.cancelled) return;
          if (!session) {
            status.textContent = "等待扫码确认，正在自动检查…";
            return;
          }
          this.stopPolling();
          if (this.plugin.settings.aliyunNative !== previous)
            throw new AliyunError("configuration_changed");
          status.textContent = "登录成功，正在保存…";
          await saveAliyunConfig(this.plugin, {
            ...previous,
            session,
            overwriteVerified: undefined,
          });
          if (!this.cancelled) {
            new Notice("阿里云盘已登录，请准备同步文件夹。");
            this.close();
          }
        } catch (error) {
          if (!this.cancelled) status.textContent = message(error);
          if (
            !(error instanceof AliyunError) ||
            ![
              "transport_error",
              "request_timeout",
              "incomplete_response",
            ].includes(error.code)
          )
            this.stopPolling();
        } finally {
          this.running = false;
          this.finishClose();
        }
      };
      this.timer = setInterval(check, 1000);
    } catch (error) {
      if (!this.cancelled) status.textContent = message(error);
    }
  }
  onClose() {
    this.stopPolling();
    this.cancelled = true;
    this.login.cancel();
    this.contentEl.empty();
    this.finishClose();
  }
}
function message(error: unknown) {
  return `阿里云盘操作失败：${error instanceof AliyunError ? error.code : "operation_failed"}`;
}
async function saveAliyunConfig(
  plugin: RemotelySavePlugin,
  config: AliyunConfig
) {
  const previous = plugin.settings.aliyunNative;
  plugin.settings.aliyunNative = config;
  try {
    await plugin.saveSettings();
  } catch (error) {
    if (plugin.settings.aliyunNative === config)
      plugin.settings.aliyunNative = previous;
    throw error;
  }
}
