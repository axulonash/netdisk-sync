import { Notice } from "obsidian";
import QRCode from "qrcode";
import type RemotelySavePlugin from "../main";
import { createSettingsSection } from "../settingsLayout";
import { AliyunQrLogin, aliyunRoot, type AliyunConfig } from "./aliyunAuth";
import { AliyunClient } from "./aliyunClient";
import { getAliyunPluginTransport } from "./aliyunService";
import { AliyunError } from "./aliyunTransport";

/** Disposer for an inline QR login; `ready` resolves after the first fetch. */
export type AliyunQrLoginHandle = (() => void) & { ready: Promise<void> };

interface AliyunQrLoginState {
  cancelled: boolean;
  running: boolean;
  finished: boolean;
  timer?: ReturnType<typeof setInterval>;
}

/**
 * Renders the Aliyun QR login into `host`, polls the keyless session once a
 * second, saves it with rollback, then calls `done` once. Reused verbatim by
 * the inline settings fragment.
 */
export function renderAliyunLoginBlock(
  host: HTMLElement,
  plugin: RemotelySavePlugin,
  done: () => void
): AliyunQrLoginHandle {
  const doc = host.ownerDocument;
  const login = new AliyunQrLogin(getAliyunPluginTransport(plugin));
  const state: AliyunQrLoginState = {
    cancelled: false,
    running: false,
    finished: false,
  };
  const stopPolling = () => {
    if (state.timer !== undefined) clearInterval(state.timer);
    state.timer = undefined;
  };
  const finish = () => {
    if (state.cancelled && !state.running && !state.finished) {
      state.finished = true;
      done();
    }
  };
  const append = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
    const node = doc.createElement(tag);
    node.textContent = text;
    host.append(node);
    return node;
  };
  const ready = (async () => {
    append("h2", "阿里云盘扫码登录");
    const status = append("p", "正在获取二维码…");
    const previous = plugin.settings.aliyunNative;
    try {
      const url = await login.start();
      const image = await QRCode.toDataURL(url, { width: 240, margin: 2 });
      if (state.cancelled) return;
      const img = doc.createElement("img");
      img.setAttribute("src", image);
      img.setAttribute("alt", "使用阿里云盘 App 扫码登录");
      img.setAttribute("width", "240");
      img.setAttribute("height", "240");
      host.append(img);
      status.textContent =
        "使用阿里云盘 App 扫码并确认，登录成功后会自动完成。二维码五分钟后失效。";
      const check = async () => {
        if (state.running || state.cancelled) return;
        state.running = true;
        try {
          const session = await login.check();
          if (state.cancelled) return;
          if (!session) {
            status.textContent = "等待扫码确认，正在自动检查…";
            return;
          }
          stopPolling();
          if (plugin.settings.aliyunNative !== previous)
            throw new AliyunError("configuration_changed");
          status.textContent = "登录成功，正在保存…";
          await saveAliyunConfig(plugin, {
            ...previous,
            session,
            overwriteVerified: undefined,
          });
          if (!state.cancelled) {
            new Notice("阿里云盘已登录，请准备同步文件夹。");
            state.finished = true;
            done();
          }
        } catch (error) {
          if (!state.cancelled) status.textContent = message(error);
          if (
            !(error instanceof AliyunError) ||
            ![
              "transport_error",
              "request_timeout",
              "incomplete_response",
            ].includes(error.code)
          )
            stopPolling();
        } finally {
          state.running = false;
          finish();
        }
      };
      state.timer = setInterval(check, 1000);
    } catch (error) {
      if (!state.cancelled) status.textContent = message(error);
    }
  })();
  const cleanup = () => {
    stopPolling();
    state.cancelled = true;
    login.cancel();
    finish();
  };
  return Object.assign(cleanup, { ready });
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
