import type RemotelySavePlugin from "./main";
import {
  type AliyunConfig,
  aliyunOverwriteBinding,
  aliyunRoot,
} from "./native/aliyunAuth";
import { ALIYUN_SAFE_SERVER_CODES } from "./native/aliyunTransport";
import type { ConnectionState } from "./settingsFrame";

type AliyunNative = typeof import("./native/settingsAliyun");
// The QR block/module imports obsidian at load; require it lazily so the
// fragment (and settingsSinglePage) stay loadable in tests without the runtime.
const loadAliyunNative = (): AliyunNative | undefined => {
  try {
    return require("./native/settingsAliyun") as AliyunNative;
  } catch (error) {
    console.warn("aliyun login block unavailable", error);
    return undefined;
  }
};

type AliyunPrepare = {
  AliyunClient: typeof import("./native/aliyunClient").AliyunClient;
  getAliyunPluginTransport: typeof import("./native/aliyunService").getAliyunPluginTransport;
};
// aliyunService imports obsidian at load; aliyunClient is loaded alongside so the
// prepare path can run without the obsidian runtime.
const loadAliyunPrepare = (): AliyunPrepare | undefined => {
  try {
    return {
      AliyunClient: require("./native/aliyunClient").AliyunClient,
      getAliyunPluginTransport: require("./native/aliyunService")
        .getAliyunPluginTransport,
    };
  } catch (error) {
    console.warn("aliyun prepare unavailable", error);
    return undefined;
  }
};

/**
 * "连接" fragment for the Aliyun single page: after login the QR renders inline
 * in this section (no modal), the 同步文件夹 editor verifies read/write, and the
 * frame's 测试连接 button runs that same preparation through ctx.setTester.
 */
export function renderAliyunConnection(
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
    text: plugin.settings.aliyunNative?.session
      ? "请先准备同步文件夹。"
      : "请先扫码登录。",
  };

  if (!ctx.desktop) {
    root.append(
      el(
        "p",
        "当前版本手机端暂不支持阿里云盘同步。请在电脑端 Obsidian 打开对应笔记库，进入设置 → netdisk-sync → 阿里云盘，扫码登录、准备同步文件夹，再开始同步。"
      )
    );
    ctx.setTester(null);
    ctx.setStatus("idle", "请在电脑端使用");
    return () => {
      disposed = true;
      root.remove();
    };
  }

  const id = `rsnext-aliyun-${Math.random().toString(36).slice(2)}`;
  let fieldId = 0;
  const row = (name: string, control: HTMLElement, description?: string) => {
    const box = el("div", "", "rsnext-row");
    const label = el("label", name);
    const controlId = `${id}-field${fieldId++}`;
    control.id = controlId;
    label.htmlFor = controlId;
    box.append(label, control);
    if (description) {
      const hint = el("small", description);
      hint.id = `${controlId}-hint`;
      control.setAttribute("aria-describedby", hint.id);
      box.append(hint);
    }
    root.append(box);
  };

  const account = el("div", "", "rsnext-address-control");
  const accountText = el("span");
  const login = el("button", "扫码登录", "mod-cta");
  login.type = "button";
  login.dataset.action = "login";
  const logout = el("button", "退出登录");
  logout.type = "button";
  const cancel = el("button", "取消扫码");
  cancel.type = "button";
  cancel.hidden = true;
  account.append(accountText, login, logout, cancel);
  row(
    "登录状态",
    account,
    "使用手机阿里云盘 App 扫描电脑上显示的二维码，确认后会自动完成登录。无需填写应用密钥。"
  );

  const qrHost = el("div", "", "rsnext-aliyun-qr");
  qrHost.hidden = true;
  root.append(qrHost);

  const folder = doc.createElement("input");
  folder.type = "text";
  folder.spellcheck = false;
  folder.dataset.field = "remoteRoot";
  folder.value =
    plugin.settings.aliyunNative?.remoteRoot ??
    `/netdisk-sync/${plugin.app.vault.getName()}`;
  row(
    "同步文件夹",
    folder,
    "不存在的文件夹会自动创建。准备时会创建、覆盖并清理一个临时测试文件，验证修改已有文件的能力。"
  );
  root.append(
    el(
      "p",
      "当前仅支持电脑端手动同步。单文件最多 64 MiB，未加密空文件暂不支持。",
      "rsnext-hint"
    )
  );
  const status = el("p", "", "rsnext-status");
  status.setAttribute("role", "status");
  root.append(status);

  const logged = () => !!plugin.settings.aliyunNative?.session;
  const ready = () => {
    try {
      const config = plugin.settings.aliyunNative;
      return (
        logged() &&
        aliyunRoot(folder.value.trim()) === config?.remoteRoot &&
        config?.overwriteVerified === aliyunOverwriteBinding(config)
      );
    } catch {
      return false;
    }
  };

  function update() {
    if (disposed) return;
    const locked =
      qrActive || verifyBusy || plugin.isSyncing || plugin.nativeMaintenance;
    accountText.textContent = logged() ? "已登录" : "未登录";
    login.textContent = logged() ? "重新扫码登录" : "扫码登录";
    login.hidden = qrActive;
    logout.hidden = !logged() || qrActive;
    cancel.hidden = !qrActive;
    login.disabled = locked;
    logout.disabled = locked;
    folder.disabled = locked || !logged();
    const busyText = qrActive
      ? "正在显示二维码…"
      : verifyBusy
        ? "正在准备同步文件夹并验证读写…"
        : undefined;
    status.textContent = busyText ?? outcome.text;
    if (qrActive) ctx.setStatus("testing", "正在显示二维码…");
    else if (verifyBusy)
      ctx.setStatus("testing", "正在准备同步文件夹并验证读写…");
    else if (outcome.state === "idle" && logged() && ready())
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
    if (disposed || qrActive || plugin.isSyncing || plugin.nativeMaintenance)
      return;
    const native = loadAliyunNative();
    if (!native) {
      outcome = { state: "failure", text: "阿里云盘扫码功能不可用" };
      update();
      return;
    }
    qrActive = true;
    plugin.nativeMaintenance = true;
    qrHost.hidden = false;
    update();
    try {
      closeLogin = native.renderAliyunLoginBlock(qrHost, plugin, finishLogin);
    } catch (error) {
      console.warn("aliyun QR login failed to open", error);
      outcome = { state: "failure", text: "无法显示二维码，请重试。" };
      finishLogin();
    }
  };
  cancel.onclick = () => closeLogin?.();

  folder.oninput = () => {
    outcome = { state: "idle", text: "文件夹已更改，请重新准备。" };
    update();
  };

  const save = async (config: AliyunConfig) => {
    const before = plugin.settings.aliyunNative;
    plugin.settings.aliyunNative = config;
    try {
      await plugin.saveSettings();
    } catch (error) {
      if (plugin.settings.aliyunNative === config)
        plugin.settings.aliyunNative = before;
      throw error;
    }
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
    try {
      await save({ remoteRoot: plugin.settings.aliyunNative?.remoteRoot });
      outcome = { state: "idle", text: "已退出登录。" };
    } catch (error) {
      console.warn("aliyun logout failed to save", error);
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
    if (!plugin.settings.aliyunNative?.session) {
      outcome = { state: "idle", text: "请先扫码登录。" };
      update();
      return { ok: false, message: outcome.text };
    }
    const deps = loadAliyunPrepare();
    if (!deps) {
      outcome = { state: "failure", text: "阿里云盘同步功能不可用" };
      update();
      return { ok: false, message: outcome.text };
    }
    verifyBusy = true;
    plugin.nativeMaintenance = true;
    update();
    let previous = plugin.settings.aliyunNative;
    try {
      const input = folder.value.trim();
      const normalized = aliyunRoot(input);
      let current: AliyunConfig = {
        ...previous,
        remoteRoot: normalized,
        overwriteVerified: undefined,
      };
      const guard = () => {
        if (
          disposed ||
          plugin.settings.serviceType !== "aliyun" ||
          plugin.settings.aliyunNative !== previous ||
          folder.value.trim() !== input
        )
          throw { code: "configuration_changed" };
      };
      const persist = async (session: AliyunConfig["session"]) => {
        guard();
        const refreshed: AliyunConfig = { ...current, session };
        await save(refreshed);
        if (plugin.settings.aliyunNative !== refreshed)
          throw { code: "configuration_changed" };
        previous = refreshed;
        current = refreshed;
        guard();
      };
      const client = new deps.AliyunClient(
        deps.getAliyunPluginTransport(plugin),
        () => current,
        guard,
        persist
      );
      await client.prepareRoot();
      await client.scan();
      const overwriteVerified = await client.verifyOverwrite();
      guard();
      if (disposed) return { ok: false, message: outcome.text };
      plugin.settings.aliyunNative = { ...current, overwriteVerified };
      try {
        await plugin.saveSettings();
      } catch {
        if (plugin.settings.aliyunNative !== previous)
          plugin.settings.aliyunNative = previous;
        throw { code: "save_failed" };
      }
      if (disposed) return { ok: false, message: outcome.text };
      folder.value = normalized;
      outcome = { state: "success", text: "文件夹已准备好，读写验证通过。" };
      return { ok: true, message: outcome.text };
    } catch (error) {
      outcome = { state: "failure", text: errorText(error) };
      return { ok: false, message: outcome.text };
    } finally {
      verifyBusy = false;
      plugin.nativeMaintenance = false;
      update();
    }
  };
  ctx.setTester(runVerify);

  const diagnosticCodes = new Set([
    "account_root_forbidden",
    "directory_not_confirmed",
    "download_not_confirmed",
    "device_session_failed",
    "empty_file_not_supported",
    "file_too_large",
    "cleanup_not_confirmed",
    "session_save_required",
    "ambiguous_listing",
    "api_rejected",
    "configuration_changed",
    "credential_destination",
    "delete_not_confirmed",
    "desktop_required",
    "directory_creation_not_confirmed",
    "directory_key_required",
    "download_limit_or_type",
    "download_redirect",
    "empty_upload_not_supported",
    "encryption_not_yet_supported",
    "incomplete_download",
    "incomplete_listing",
    "incomplete_response",
    "invalid_callback",
    "invalid_download_metadata",
    "invalid_entry_parent",
    "invalid_file_id",
    "invalid_filename",
    "invalid_limits",
    "invalid_metadata",
    "invalid_oss_endpoint",
    "invalid_part_size",
    "invalid_path",
    "invalid_qr_token",
    "invalid_response",
    "invalid_root",
    "invalid_service_ticket",
    "invalid_session",
    "invalid_upload",
    "invalid_upload_metadata",
    "invalid_url",
    "listing_limit",
    "login_busy",
    "login_rejected",
    "login_required",
    "not_found",
    "overwrite_identity_changed",
    "overwrite_not_verified",
    "parent_not_found",
    "part_upload_failed",
    "path_type_mismatch",
    "probe_cleanup_identity_changed",
    "probe_name_collision",
    "qr_expired",
    "request_timeout",
    "response_too_large",
    "root_not_found",
    "scan_limit_or_cycle",
    "session_cookie_missing",
    "sync_scope_changed",
    "task_failed",
    "task_timeout",
    "transport_error",
    "transport_unavailable",
    "unexpected_encoding",
    "untrusted_endpoint",
    "upload_commit_failed",
    "upload_not_confirmed",
    "replacement_recovery_required",
    "replacement_target_changed",
    "rename_not_confirmed",
    "rename_overwrites_target",
  ]);
  const errorText = (error: any) => {
    const descriptions: Record<string, string> = {
      replacement_recovery_required:
        "文件替换未完成，旧内容已保留；请检查同步目录中的 rsnext-backup- 备份文件，恢复原文件名后再重试",
      replacement_target_changed:
        "替换过程中网盘文件发生变化，已停止操作并保留文件，请检查后重试",
      rename_not_confirmed:
        "文件改名结果尚未确认，已保留原内容，请检查网盘中的文件后重试",
      rename_overwrites_target:
        "网盘未通过同名改名保护验证，已停止准备，避免覆盖其它设备的文件",
      not_found: "上传后未能从网盘列表找到测试文件，请稍后重试",
      task_timeout: "测试文件处理超时，请检查网盘中的临时文件",
      task_failed: "测试文件处理任务失败，请检查网盘中的临时文件",
      download_redirect: "测试文件下载跳转异常，未完成校验",
      login_required: "请重新扫码登录",
      qr_expired: "二维码已过期，请重新扫码",
      configuration_changed: "设置已更改，请重新准备",
      sync_scope_changed: "设置已更改，请重新准备",
      invalid_root: "请填写专用文件夹路径，例如 /笔记；不能使用网盘根目录",
      path_type_mismatch: "路径中有同名文件，请选择其他文件夹",
      root_not_found: "同步文件夹不存在，请重新准备",
      api_rejected: "阿里云盘接口拒绝操作，请检查登录状态及目录权限",
      transport_error: "连接中断，请检查网络后重试",
      transport_unavailable: "当前电脑无法发起网盘请求，请重新启用插件后重试",
      request_timeout: "连接超时，请检查网络后重试",
      overwrite_identity_changed: "未通过同名覆盖验证，请检查网盘中的测试文件",
      delete_not_confirmed: "测试文件清理未确认，请检查网盘中的测试文件",
      incomplete_listing:
        "目录已请求，但文件列表不完整或扫描期间发生变化，请重试",
      invalid_metadata: "目录已请求，但文件列表的信息格式不符",
      invalid_response: "阿里云盘接口响应格式异常，请重试",
      invalid_file_id: "文件或目录标识格式异常，未继续验证",
      ambiguous_listing: "目录中存在重复的文件标识或名称，未继续验证",
      scan_limit_or_cycle: "目录扫描超过限制或目录结构异常，未继续验证",
      invalid_oss_endpoint:
        "文件夹已检查，但上传验证失败：接口返回的上传地址不受支持",
      credential_destination:
        "文件夹已检查，但上传验证失败：授权目标地址不受支持",
      invalid_upload_metadata: "文件夹已检查，但上传验证失败：预上传信息不完整",
      invalid_part_size: "文件夹已检查，但上传验证失败：分片大小信息异常",
      invalid_callback: "文件夹已检查，但上传验证失败：提交回调信息异常",
      part_upload_failed: "文件夹已检查，但临时文件分片上传失败",
      upload_commit_failed:
        "文件夹已检查，但临时文件提交失败，请检查网盘中的测试文件",
      upload_not_confirmed: "文件夹已检查，但临时文件上传结果未通过下载校验",
      invalid_download_metadata: "文件夹已检查，但临时文件下载信息异常",
      untrusted_endpoint: "文件夹已检查，但测试文件的传输地址不受支持",
      response_too_large:
        "下载响应超过文件预期大小，可能返回了认证或错误页面；请重新扫码登录后重试",
      incomplete_download: "文件夹已检查，但临时文件未完整下载，请重试",
      probe_cleanup_identity_changed:
        "测试文件身份已变化，已停止清理，请检查网盘中的测试文件",
      directory_creation_not_confirmed: "文件夹创建未确认，请检查网盘后重试",
    };
    const http =
      typeof error?.code === "string"
        ? /^http_(\d{3})$/.exec(error.code)
        : null;
    const code = diagnosticCodes.has(error?.code)
      ? error.code
      : http
        ? `http_${http[1]}`
        : "operation_failed";
    const stage =
      (
        {
          initial_upload: "首次上传及下载校验",
          overwrite: "覆盖及下载校验",
          cleanup: "临时文件清理",
        } as Record<string, string>
      )[error?.stage] ?? "目录及读写验证";
    const description = http
      ? `网盘请求失败 · HTTP ${http[1]}`
      : descriptions[error?.code] ??
        "操作未完成，请检查登录、网络和目录权限；准备失败时请检查是否残留测试文件";
    const operation = new Map([
      ["rename_conflict_probe", "同名改名保护检查"],
      ["backup_rename", "旧文件备份改名"],
      ["publish_rename", "新文件改为原名"],
      ["published_validation", "替换后内容校验"],
      ["backup_cleanup", "旧备份清理"],
      ["rollback_rename", "恢复旧文件名"],
    ]).get(error?.operation);
    const info = error?.responseInfo;
    let diagnostic = "";
    if (
      info &&
      /^[a-z0-9.-]+\.(alipan\.com|aliyundrive\.com|aliyuncs\.com|aliyundrive\.net|alicloudccp\.com|aliyundrive\.cloud)$/.test(
        info.host
      ) &&
      Number.isInteger(info.status) &&
      info.status >= 100 &&
      info.status <= 599 &&
      Number.isSafeInteger(info.expectedBytes) &&
      info.expectedBytes >= 0
    ) {
      const kinds: Record<string, string> = {
        html: "HTML 页面",
        json: "JSON 响应",
        binary: "二进制",
        text: "文本",
        other: "其它响应",
      };
      diagnostic = ` · ${info.host} · HTTP ${info.status} · ${kinds[info.kind] ?? "其它响应"} · 上限 ${info.expectedBytes} B${Number.isSafeInteger(info.announcedBytes) && info.announcedBytes >= 0 ? ` / 返回 ${info.announcedBytes} B` : ""}`;
      if (typeof info.cookieSent === "boolean")
        diagnostic += ` · ${info.cookieSent ? "已携带登录态" : "未携带登录态"}`;
      if (
        typeof info.serverCode === "string" &&
        ALIYUN_SAFE_SERVER_CODES.has(info.serverCode)
      )
        diagnostic += ` · ${info.serverCode}`;
    }
    const endpoint = error?.endpointInfo;
    const endpointStage: Record<string, string> = {
      upload_url: "上传地址",
      download_url: "下载地址",
      download_redirect: "下载跳转",
    };
    if (
      endpoint &&
      typeof endpoint.host === "string" &&
      endpoint.host.length <= 253 &&
      /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(endpoint.host) &&
      Object.prototype.hasOwnProperty.call(endpointStage, endpoint.operation)
    )
      diagnostic += ` · ${endpointStage[endpoint.operation]} · ${endpoint.host}`;
    return `${stage}${operation ? ` · ${operation}` : ""} · ${description} [${code}]${diagnostic}`;
  };

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
