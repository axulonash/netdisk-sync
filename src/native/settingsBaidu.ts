import { Notice, Platform, Setting } from "obsidian";
import type RemotelySavePlugin from "../main";
import { createSettingsSection } from "../settingsLayout";
import { createBaiduAuthorizationUrl, BaiduOAuthError } from "./baiduAuth";
import { BaiduConnectionError } from "./baiduConnection";
import { BaiduReadError, type BaiduScanEntry } from "./baiduRead";
import { BaiduSessionError } from "./baiduSession";
import { BaiduDownloadError } from "./baiduDownload";
import { getBaiduPluginConnection } from "./baiduPluginConnection";
import { BaiduProfileError } from "./baiduProfile";

export function generateBaiduConnectionSettings(
  parent: HTMLElement,
  plugin: RemotelySavePlugin
) {
  const section = createSettingsSection(
    parent,
    "百度网盘 · 桌面手动同步（实验）"
  );
  section.parentElement!.hidden = plugin.settings.serviceType !== "baidu";
  section.createEl("p", {
    text: "使用你自己的百度网盘开放平台应用直接授权。桌面端支持同步预览与手动同步，须先保存专用远端目录；移动端仅支持授权和只读检查。应用密钥和登录凭据保存在插件设置中；设置混淆不等于加密。",
  });
  const draft = {
    clientId: plugin.settings.baiduNative?.app.clientId ?? "",
    clientSecret: plugin.settings.baiduNative?.app.clientSecret ?? "",
    redirectUri: "oob",
  };
  let code = "";
  let root = plugin.settings.baiduNative?.remoteRoot ?? "/apps/remotely-save";
  let fileKey = "";
  let checkedDirectory:
    | { entries: BaiduScanEntry[]; config: typeof plugin.settings.baiduNative }
    | undefined;
  let authorization:
    | { clientId: string; clientSecret: string; started: number }
    | undefined;
  const status = section.createEl("p", {
    text: plugin.settings.baiduNative?.tokens
      ? "已保存授权，可进行目录检查。"
      : "尚未授权。",
  });
  const connection = getBaiduPluginConnection(plugin);
  new Setting(section).setName("应用 API Key").addText((text) =>
    text.setValue(draft.clientId).onChange((value) => {
      draft.clientId = value.trim();
      authorization = undefined;
    })
  );
  new Setting(section).setName("应用 Secret Key").addText((text) => {
    text.inputEl.type = "password";
    text.setValue(draft.clientSecret).onChange((value) => {
      draft.clientSecret = value.trim();
      authorization = undefined;
    });
  });
  const report = async (action: () => Promise<string>) => {
    if (connection.busy) {
      new Notice("百度连接正在处理，请等待。");
      return;
    }
    status.textContent = "正在处理…";
    try {
      status.textContent = await action();
    } catch (error) {
      const known =
        error instanceof BaiduOAuthError ||
        error instanceof BaiduConnectionError ||
        error instanceof BaiduReadError ||
        error instanceof BaiduDownloadError ||
        error instanceof BaiduSessionError ||
        error instanceof BaiduProfileError;
      const message = `百度连接失败：${known ? error.code : "unexpected_error"}`;
      status.textContent = message;
      new Notice(message);
    }
  };
  new Setting(section)
    .setName("1. 打开百度官方授权页")
    .setDesc(
      "回调方式为 oob：授权后由百度页面显示授权码，请在 10 分钟内回填。应用需具备网盘权限。"
    )
    .addButton((button) =>
      button.setButtonText("浏览器授权").onClick(() => {
        if (connection.busy) {
          new Notice("百度连接正在处理，请等待。");
          return;
        }
        if (!draft.clientId || !draft.clientSecret) {
          new Notice("请先填写应用 API Key 和 Secret Key。");
          return;
        }
        try {
          const bytes = crypto.getRandomValues(new Uint8Array(24));
          const state = Array.from(bytes, (value) =>
            value.toString(16).padStart(2, "0")
          ).join("");
          const url = createBaiduAuthorizationUrl(draft.clientId, "oob", state);
          window.open(url, "_blank", "noopener,noreferrer");
          authorization = { ...draft, started: Date.now() };
          status.textContent = "请完成官方授权，然后回填本次授权码。";
        } catch {
          status.textContent = "无法打开授权页，请检查应用信息与浏览器。";
        }
      })
    );
  new Setting(section).setName("2. 回填本次授权码").addText((text) => {
    text.inputEl.type = "password";
    text.onChange((value) => {
      code = value.trim();
    });
    new Setting(section).addButton((button) =>
      button.setButtonText("保存授权").onClick(() =>
        report(async () => {
          if (
            !authorization ||
            Date.now() - authorization.started >= 600000 ||
            authorization.clientId !== draft.clientId ||
            authorization.clientSecret !== draft.clientSecret
          )
            throw new BaiduConnectionError(
              "authorization_not_started_or_expired"
            );
          const submitted = code;
          checkedDirectory = undefined;
          code = "";
          text.setValue("");
          authorization = undefined;
          await connection.login(draft, submitted);
          return "授权已保存。可检查指定目录；请保存同步目录，再选择百度网盘并先预览同步计划。";
        })
      )
    );
  });
  new Setting(section)
    .setName("检查远端目录")
    .setDesc(
      "填写已存在的绝对路径，仅递归读取目录信息；最多 10,000 条记录，不上传、不删除。"
    )
    .addText((text) =>
      text.setValue(root).onChange((value) => {
        root = value.trim();
        checkedDirectory = undefined;
      })
    )
    .addButton((button) =>
      button.setButtonText("只读检查").onClick(() =>
        report(async () => {
          checkedDirectory = undefined;
          const scannedRoot = root;
          const entries = await connection.scan(scannedRoot);
          if (root !== scannedRoot)
            throw new BaiduConnectionError("directory_changed");
          checkedDirectory = { entries, config: plugin.settings.baiduNative };
          const files = entries.filter((entry) => !entry.isDirectory).length;
          return `目录检查完成：${files} 个文件，${entries.length - files} 个子目录。`;
        })
      )
    );
  if (Platform.isDesktopApp) {
    new Setting(section)
      .setName("保存百度同步目录")
      .setDesc(
        "使用上方填写的绝对路径，先只读检查，再保存为同步目录。请使用专用测试目录；空明文文件暂不支持，单文件最多 64 MiB；加密仅开放 OpenSSL。"
      )
      .addButton((button) =>
        button.setButtonText("检查并保存同步目录").onClick(() =>
          report(async () => {
            const selectedRoot = root;
            checkedDirectory = undefined;
            await connection.setRemoteRoot(selectedRoot);
            return "同步目录已保存。选择百度网盘后先预览计划，再手动同步。";
          })
        )
      );
  }
  if (Platform.isDesktopApp) {
    new Setting(section)
      .setName("检查下载文件")
      .setDesc(
        "先检查目录，再填写其中一个文件的相对路径（如 test.md）。下载到内存并核对字节数，不写入仓库；单文件最多 64 MiB。"
      )
      .addText((text) =>
        text.onChange((value) => {
          fileKey = value.trim();
        })
      )
      .addButton((button) =>
        button.setButtonText("下载检查").onClick(() =>
          report(async () => {
            if (
              !checkedDirectory ||
              checkedDirectory.config !== plugin.settings.baiduNative
            )
              throw new BaiduConnectionError("check_directory_first");
            const entry = checkedDirectory.entries.find(
              (item) => !item.isDirectory && item.key === fileKey
            );
            if (!entry)
              throw new BaiduConnectionError("file_not_in_checked_directory");
            const bytes = await connection.readFile({
              fsId: entry.fsId,
              size: entry.size,
            });
            return `下载检查完成：${bytes.byteLength} 字节，与远端记录的大小一致。`;
          })
        )
      );
  } else {
    section.createEl("p", {
      text: "文件下载检查暂仅支持桌面端，移动端可进行授权和目录检查。",
    });
  }
  new Setting(section)
    .setName("清除本地授权")
    .setDesc("清除本插件保存的令牌。撤销百度侧授权需在百度账号中操作。")
    .addButton((button) =>
      button.setButtonText("退出登录").onClick(() =>
        report(async () => {
          checkedDirectory = undefined;
          await connection.logout();
          return "本地授权已清除。";
        })
      )
    );
}
