import { Modal, Notice, Platform, Setting } from "obsidian";
import QRCode from "qrcode";
import type RemotelySavePlugin from "../main";
import { createSettingsSection } from "../settingsLayout";
import { QuarkQrLogin, quarkRoot, type QuarkConfig } from "./quarkAuth";
import { QuarkClient } from "./quarkClient";
import { getQuarkPluginTransport } from "./quarkService";
import { QuarkError } from "./quarkTransport";

/** Disposer for an inline QR login; `ready` resolves after the first fetch. */
export type QuarkQrLoginHandle = (() => void) & { ready: Promise<void> };

interface QuarkQrLoginState {
  cancelled: boolean;
  running: boolean;
  finished: boolean;
  timer?: ReturnType<typeof setInterval>;
}

/**
 * Renders the Quark QR login into `host`, polls the keyless session once a
 * second, saves it with rollback, then calls `done` once. Reused verbatim by
 * the inline settings fragment and, via delegation, by QuarkLoginModal.
 */
export function renderQuarkLoginBlock(
  host: HTMLElement,
  plugin: RemotelySavePlugin,
  done: () => void
): QuarkQrLoginHandle {
  const doc = host.ownerDocument;
  const login = new QuarkQrLogin(getQuarkPluginTransport(plugin));
  const state: QuarkQrLoginState = {
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
    append("h2", "夸克扫码登录");
    const status = append("p", "正在获取二维码…");
    const previous = plugin.settings.quarkNative;
    try {
      const url = await login.start();
      const image = await QRCode.toDataURL(url, { width: 240, margin: 2 });
      if (state.cancelled) return;
      const img = doc.createElement("img");
      img.setAttribute("src", image);
      img.setAttribute("alt", "使用夸克 App 扫码登录");
      img.setAttribute("width", "240");
      img.setAttribute("height", "240");
      host.append(img);
      status.textContent =
        "使用夸克 App 扫码并确认，登录成功后会自动完成。二维码五分钟后失效。";
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
          if (plugin.settings.quarkNative !== previous)
            throw new QuarkError("configuration_changed");
          status.textContent = "登录成功，正在保存…";
          await saveQuarkConfig(plugin, {
            ...previous,
            session,
            overwriteVerified: undefined,
          });
          if (!state.cancelled) {
            new Notice("夸克已登录，请准备同步文件夹。");
            state.finished = true;
            done();
          }
        } catch (error) {
          if (!state.cancelled) status.textContent = message(error);
          if (
            !(error instanceof QuarkError) ||
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

export class QuarkLoginModal extends Modal {
  private cleanup?: () => void;
  constructor(
    private readonly plugin: RemotelySavePlugin,
    private readonly done: () => void = () => {}
  ) {
    super(plugin.app);
  }
  async onOpen() {
    const block = renderQuarkLoginBlock(this.contentEl, this.plugin, () => {
      this.done();
      this.close();
    });
    this.cleanup = block;
    await block.ready;
  }
  onClose() {
    this.cleanup?.();
    this.contentEl.empty();
  }
}
function message(error: unknown) {
  return `夸克操作失败：${error instanceof QuarkError ? error.code : "operation_failed"}`;
}
async function saveQuarkConfig(
  plugin: RemotelySavePlugin,
  config: QuarkConfig
) {
  const previous = plugin.settings.quarkNative;
  plugin.settings.quarkNative = config;
  try {
    await plugin.saveSettings();
  } catch (error) {
    if (plugin.settings.quarkNative === config)
      plugin.settings.quarkNative = previous;
    throw error;
  }
}
export function generateQuarkSettings(
  parent: HTMLElement,
  plugin: RemotelySavePlugin
) {
  const section = createSettingsSection(parent, "夸克网盘 · 桌面实验");
  section.parentElement!.hidden = plugin.settings.serviceType !== "quark";
  if (!Platform.isDesktopApp) {
    section.createEl("p", { text: "夸克直接登录和同步暂仅支持桌面端。" });
    return;
  }
  section.createEl("p", {
    text: "直接使用夸克 App 扫码，无需中转服务。会话保存在插件配置中。首次使用必须验证同名覆盖能力，通过后才能修改已有文件。接口未经真实账号验证，请先用测试仓库；单文件最多 64 MiB，空明文文件暂不支持。",
  });
  new Setting(section)
    .setName("夸克账号")
    .setDesc(
      plugin.settings.quarkNative?.session ? "已保存登录会话" : "尚未登录"
    )
    .addButton((button) =>
      button
        .setButtonText("扫码登录")
        .onClick(() => new QuarkLoginModal(plugin).open())
    )
    .addButton((button) =>
      button.setButtonText("退出登录").onClick(async () => {
        try {
          await saveQuarkConfig(plugin, {
            remoteRoot: plugin.settings.quarkNative?.remoteRoot,
          });
          new Notice("本地夸克会话已清除。");
        } catch (error) {
          new Notice(message(error));
        }
      })
    );
  let root = plugin.settings.quarkNative?.remoteRoot ?? "";
  let running = false;
  new Setting(section)
    .setName("专用同步目录")
    .setDesc(
      "填写已存在的绝对路径，例如 /Obsidian测试；检查时只读，不自动创建目录。"
    )
    .addText((field) =>
      field
        .setPlaceholder("/Obsidian测试")
        .setValue(root)
        .onChange((value) => {
          root = value;
        })
    )
    .addButton((button) =>
      button.setButtonText("检查并保存").onClick(async () => {
        if (running) return;
        running = true;
        button.setDisabled(true);
        const previous = plugin.settings.quarkNative;
        try {
          const normalized = quarkRoot(root);
          const config = {
            ...previous,
            remoteRoot: normalized,
            overwriteVerified:
              previous?.remoteRoot === normalized
                ? previous.overwriteVerified
                : undefined,
          };
          const entries = await new QuarkClient(
            getQuarkPluginTransport(plugin),
            () => config
          ).scan();
          if (
            plugin.settings.quarkNative !== previous ||
            root !== config.remoteRoot
          )
            throw new QuarkError("configuration_changed");
          await saveQuarkConfig(plugin, config);
          new Notice(`目录已保存：${entries.length} 项。请先预览同步计划。`);
        } catch (error) {
          new Notice(message(error));
        } finally {
          running = false;
          button.setDisabled(false);
        }
      })
    );
  new Setting(section)
    .setName("验证同名覆盖")
    .setDesc(
      "在已保存的专用目录创建随机测试文件，覆盖为不同内容，下载比对并删除。失败时禁止覆盖现有笔记；可能留下测试文件，请检查目录。"
    )
    .addButton((button) =>
      button.setButtonText("创建测试文件并验证覆盖").onClick(async () => {
        if (plugin.isSyncing || plugin.nativeMaintenance) {
          new Notice("请等当前同步或网盘检查结束后再验证覆盖。");
          return;
        }
        if (running) return;
        running = true;
        button.setDisabled(true);
        plugin.nativeMaintenance = true;
        const previous = plugin.settings.quarkNative;
        try {
          const client = new QuarkClient(
            getQuarkPluginTransport(plugin),
            () => plugin.settings.quarkNative
          );
          const overwriteVerified = await client.verifyOverwrite();
          if (plugin.settings.quarkNative !== previous)
            throw new QuarkError("configuration_changed");
          await saveQuarkConfig(plugin, { ...previous, overwriteVerified });
          new Notice("同名覆盖验证通过。请先预览同步计划，再手动同步。");
        } catch (error) {
          new Notice(message(error));
        } finally {
          plugin.nativeMaintenance = false;
          running = false;
          button.setDisabled(false);
        }
      })
    );
}
