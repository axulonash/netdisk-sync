import type RemotelySavePlugin from "./main";
import { baiduWebRoot } from "./native/baiduWebProbe";
import { baiduWebBinding } from "./native/baiduWebSync";
import type { ConnectionState } from "./settingsFrame";

type BaiduNative = typeof import("./native/settingsBaiduQr");
// The QR block/modal import obsidian at load; require it lazily so the fragment
// (and settingsSinglePage) stay loadable in tests without the obsidian runtime.
const loadBaiduNative = (): BaiduNative | undefined => {
  try {
    return require("./native/settingsBaiduQr") as BaiduNative;
  } catch (error) {
    console.warn("baidu login block unavailable", error);
    return undefined;
  }
};

/**
 * "连接" fragment for the Baidu single page: after login the QR renders inline
 * in this section (no modal), the 同步文件夹 editor verifies read/write, and the
 * frame's 测试连接 button runs that same preparation through ctx.setTester.
 */
export function renderBaiduConnection(
  parent: HTMLElement,
  plugin: RemotelySavePlugin,
  ctx: {
    desktop: boolean;
    redisplay: () => void;
    setStatus(s: ConnectionState, text: string): void;
    setTester(
      t: (() => Promise<{ ok: boolean; message: string }>) | null
    ): void;
  }
): () => void {
  const doc = parent.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    cls = ""
  ) => {
    const node = doc.createElement(tag);
    node.textContent = text;
    node.className = cls;
    return node;
  };
  const root = el("div");
  parent.append(root);
  let disposed = false;
  let qrActive = false;
  let verifyBusy = false;
  let closeLogin: (() => void) | undefined;
  let outcome: { state: ConnectionState; text: string } = {
    state: "idle",
    text: "尚未验证",
  };

  if (!ctx.desktop) {
    root.append(el("p", "请在电脑端 Obsidian 测试百度扫码登录。"));
    ctx.setTester(null);
    ctx.setStatus("idle", "请在电脑端使用");
    return () => {
      disposed = true;
      root.remove();
    };
  }

  const account = el("p");
  const login = el("button", "扫码登录", "mod-cta");
  login.type = "button";
  login.dataset.action = "login";
  const logout = el("button", "退出登录");
  logout.type = "button";
  const cancel = el("button", "取消扫码");
  cancel.type = "button";
  cancel.hidden = true;
  root.append(account, login, logout, cancel);

  const qrHost = el("div", "", "rsnext-baidu-qr");
  qrHost.hidden = true;
  root.append(qrHost);

  const directory = doc.createElement("input");
  directory.type = "text";
  directory.dataset.field = "remoteRoot";
  directory.spellcheck = false;
  directory.value =
    plugin.settings.baiduWebRemoteRoot ??
    plugin.settings.baiduNative?.remoteRoot ??
    `/remotely-save-next/${plugin.app?.vault?.getName?.() ?? "我的笔记"}`;
  const directoryLabel = el("label", "同步文件夹");
  directory.id = `baidu-root-${Math.random().toString(36).slice(2)}`;
  directoryLabel.htmlFor = directory.id;
  const directoryRow = el("div", "", "rsnext-row");
  directoryRow.append(directoryLabel, directory);
  root.append(directoryRow);
  root.append(el("p", "不存在时自动创建；读写验证通过后保存。"));
  const status = el("p", "", "rsnext-status");
  status.setAttribute("role", "status");
  root.append(status);
  root.append(
    el(
      "p",
      "暂仅支持电脑端手动同步；单文件最多 64 MiB。未加密空文件会跳过并列入记录；远端目录删除会在执行前提示。",
      "rsnext-hint"
    )
  );

  const ready = () => {
    try {
      return (
        directory.value.trim() === plugin.settings.baiduWebRemoteRoot &&
        plugin.settings.baiduWebPrepared === baiduWebBinding(plugin.settings)
      );
    } catch {
      return false;
    }
  };

  function update() {
    if (disposed) return;
    const locked =
      qrActive || verifyBusy || plugin.isSyncing || plugin.nativeMaintenance;
    const logged = !!plugin.settings.baiduWebExperimental;
    account.textContent = logged ? "已登录" : "未登录";
    login.textContent = logged ? "重新扫码登录" : "扫码登录";
    login.hidden = qrActive;
    logout.hidden = !logged || qrActive;
    cancel.hidden = !qrActive;
    login.disabled = locked;
    logout.disabled = locked;
    directory.disabled = locked || !logged;
    if (qrActive) ctx.setStatus("testing", "正在获取百度二维码…");
    else if (verifyBusy)
      ctx.setStatus("testing", "正在准备同步文件夹及验证读写…");
    else if (outcome.state === "idle" && logged && ready())
      ctx.setStatus("success", "文件夹已准备好");
    else ctx.setStatus(outcome.state, outcome.text);
  }

  const finishLogin = () => {
    qrActive = false;
    closeLogin = undefined;
    qrHost.hidden = true;
    qrHost.replaceChildren();
    plugin.nativeMaintenance = false;
    update();
  };

  login.onclick = () => {
    if (
      !disposed &&
      !qrActive &&
      !plugin.isSyncing &&
      !plugin.nativeMaintenance
    ) {
      const native = loadBaiduNative();
      if (!native) {
        outcome = { state: "failure", text: "百度扫码功能不可用" };
        update();
        return;
      }
      qrActive = true;
      plugin.nativeMaintenance = true;
      qrHost.hidden = false;
      update();
      try {
        closeLogin = native.renderBaiduQrLoginBlock(
          qrHost,
          plugin,
          finishLogin
        );
      } catch (error) {
        console.warn("baidu QR login failed to open", error);
        outcome = { state: "failure", text: "无法显示二维码，请重试。" };
        finishLogin();
      }
    }
  };
  cancel.onclick = () => closeLogin?.();

  directory.oninput = () => {
    outcome = { state: "idle", text: "目录已更改，请重新准备同步文件夹。" };
    plugin.settings.baiduWebPrepared = undefined;
    update();
  };

  logout.onclick = async () => {
    if (
      disposed ||
      qrActive ||
      verifyBusy ||
      plugin.isSyncing ||
      plugin.nativeMaintenance
    )
      return;
    verifyBusy = true;
    plugin.nativeMaintenance = true;
    const previous = plugin.settings.baiduWebExperimental;
    try {
      plugin.settings.baiduWebExperimental = undefined;
      await plugin.saveSettings();
      outcome = { state: "idle", text: "已退出扫码登录。" };
    } catch (error) {
      console.warn("baidu logout failed to save", error);
      if (!plugin.settings.baiduWebExperimental)
        plugin.settings.baiduWebExperimental = previous;
      outcome = { state: "failure", text: "退出登录未保存，请重试。" };
    } finally {
      verifyBusy = false;
      plugin.nativeMaintenance = false;
      update();
    }
  };

  const runVerify = async (): Promise<{ ok: boolean; message: string }> => {
    if (
      disposed ||
      qrActive ||
      verifyBusy ||
      plugin.isSyncing ||
      plugin.nativeMaintenance
    )
      return { ok: false, message: outcome.text };
    if (!plugin.settings.baiduWebExperimental) {
      outcome = { state: "idle", text: "请先扫码登录。" };
      update();
      return { ok: false, message: outcome.text };
    }
    const native = loadBaiduNative();
    if (!native) {
      outcome = { state: "failure", text: "百度扫码功能不可用" };
      update();
      return { ok: false, message: outcome.text };
    }
    verifyBusy = true;
    plugin.nativeMaintenance = true;
    plugin.settings.baiduWebPrepared = undefined;
    update();
    try {
      const selected = baiduWebRoot(directory.value);
      const session = plugin.settings.baiduWebExperimental;
      const result = await native.verifyBaiduQrSession(plugin, selected);
      if (disposed) return { ok: false, message: outcome.text };
      if (
        plugin.settings.serviceType !== "baidu" ||
        plugin.settings.baiduWebExperimental !== session
      )
        throw { code: "configuration_changed" };
      const passed = result.upload && result.download && result.cleanup;
      if (passed) {
        const previous = plugin.settings.baiduWebRemoteRoot;
        const previousPrepared = plugin.settings.baiduWebPrepared;
        plugin.settings.baiduWebRemoteRoot = selected;
        plugin.settings.baiduWebPrepared = baiduWebBinding(plugin.settings);
        try {
          await plugin.saveSettings();
        } catch {
          if (plugin.settings.baiduWebRemoteRoot === selected) {
            plugin.settings.baiduWebRemoteRoot = previous;
            plugin.settings.baiduWebPrepared = previousPrepared;
          }
          throw { code: "save_failed" };
        }
        directory.value = selected;
      }
      let text = `上传${result.upload ? "通过" : "未通过"} · 下载${result.download ? "通过" : "未通过"} · 清理${result.cleanup ? "通过" : "未通过"}`;
      for (const code of [result.failure, result.cleanupFailure])
        if (code && /^[a-z0-9_-]{1,80}$/.test(code)) text += ` [${code}]`;
      outcome = { state: passed ? "success" : "failure", text };
      return { ok: passed, message: text };
    } catch (error) {
      const code =
        typeof (error as any)?.code === "string" &&
        /^[a-z0-9_-]{1,80}$/.test((error as any).code)
          ? (error as any).code
          : "operation_failed";
      outcome = { state: "failure", text: `验证未完成 [${code}]` };
      return { ok: false, message: outcome.text };
    } finally {
      verifyBusy = false;
      plugin.nativeMaintenance = false;
      update();
    }
  };
  ctx.setTester(runVerify);

  const unsubscribe = plugin.onSyncUiUpdate(update);
  update();
  return () => {
    disposed = true;
    unsubscribe();
    closeLogin?.();
    closeLogin = undefined;
    ctx.setTester(null);
    root.remove();
  };
}
