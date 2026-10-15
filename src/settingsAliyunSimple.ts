import { createSyncControls } from "./syncControlsUi";
import { createSyncProgress, appendProgressResult } from "./syncProgressUi";
import type RemotelySavePlugin from "./main";
import { createServicePicker } from "./settingsServicePicker";
import {
  aliyunRoot,
  aliyunOverwriteBinding,
  type AliyunConfig,
  type AliyunSession,
} from "./native/aliyunAuth";
import type { SyncActivity } from "./syncActivity";
import { ALIYUN_SAFE_SERVER_CODES } from "./native/aliyunTransport";
export interface AliyunSetupActions {
  openLogin(done: () => void): () => void;
  prepare(
    config: AliyunConfig,
    guard: () => void,
    saveSession: (session: AliyunSession) => Promise<void>
  ): Promise<AliyunConfig>;
}
export function renderSimpleAliyun(
  parent: HTMLElement,
  plugin: RemotelySavePlugin,
  actions: AliyunSetupActions,
  advanced: (parent: HTMLElement) => void,
  redisplay: () => void,
  desktop: boolean
) {
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
  const root = el("div", "", "rsnext-settings");
  parent.append(root);
  const service = createServicePicker(
    doc,
    "aliyun",
    plugin.settings.legacyServiceType
  );
  root.append(service);
  root.append(el("h2", "remotely-save-next"));
  const tabs = el("div", "", "rsnext-tabs"),
    settingsTab = el("button", "同步设置"),
    historyTab = el("button", "同步记录");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "阿里云盘同步管理");
  tabs.append(settingsTab, historyTab);
  root.append(tabs);
  const settings = el("div"),
    history = el("div");
  root.append(settings, history);
  const uid = `rsnext-aliyun-${Math.random().toString(36).slice(2)}`;
  [settingsTab, historyTab].forEach((tab, i) => {
    tab.id = `${uid}-tab-${i}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `${uid}-panel-${i}`);
    const panel = i ? history : settings;
    panel.id = `${uid}-panel-${i}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
  });
  const guide = el("section", "", "rsnext-mobile-guide");
  guide.hidden = desktop;
  guide.append(
    el("h3", "请到电脑完成设置"),
    el(
      "p",
      "当前版本手机端暂不支持阿里云盘同步。请在电脑端 Obsidian 打开对应笔记库，进入设置 → remotely-save-next → 阿里云盘，扫码登录、准备同步文件夹，再开始同步。"
    )
  );
  guide.setAttribute("role", "note");
  settings.append(guide);
  const steps = ["1. 登录阿里云盘", "2. 选择同步文件夹", "3. 开始同步"].map(
    (title) => {
      const section = el("section", "", "rsnext-setup-step"),
        head = el("div", "", "rsnext-step-head"),
        badge = el("span", "", "rsnext-step-badge");
      head.append(el("h3", title), badge);
      section.append(head);
      section.hidden = !desktop;
      settings.append(section);
      return { section, badge };
    }
  );
  const row = (title: string, control: HTMLElement, target: HTMLElement) => {
    const box = el("div", "", "rsnext-row"),
      label = el("label", title);
    control.id = `${uid}-${Math.random().toString(36).slice(2)}`;
    label.htmlFor = control.id;
    box.append(label, control);
    target.append(box);
    return box;
  };
  const account = el("div", "", "rsnext-address-control"),
    accountText = el("span"),
    login = el("button", "扫码登录"),
    logout = el("button", "退出登录");
  login.dataset.action = "login";
  account.append(accountText, login, logout);
  row("登录状态", account, steps[0].section);
  steps[0].section.append(
    el(
      "p",
      "使用手机阿里云盘 App 扫描电脑上显示的二维码，确认后会自动完成登录。无需填写应用密钥。",
      "rsnext-step-help"
    )
  );
  const folder = el("input");
  folder.type = "text";
  folder.spellcheck = false;
  folder.dataset.field = "remoteRoot";
  folder.value =
    plugin.settings.aliyunNative?.remoteRoot ??
    `/remotely-save-next/${plugin.app.vault.getName()}`;
  const prepare = el("button", "准备同步文件夹"),
    light = el("span", "", "rsnext-connection-light"),
    folderBox = el("div", "", "rsnext-address-control");
  prepare.dataset.action = "prepare";
  folderBox.append(folder, prepare, light);
  const folderRow = row("网盘文件夹", folderBox, steps[1].section);
  folder.id = `${uid}-folder`;
  folderRow.querySelector("label")!.htmlFor = folder.id;
  light.setAttribute("role", "status");
  light.setAttribute("aria-live", "polite");
  steps[1].section.append(
    el(
      "p",
      "不存在的文件夹会自动创建。准备时会创建、覆盖并清理一个临时测试文件，验证修改已有文件的能力。",
      "rsnext-step-help"
    )
  );
  const feedback = el("p", "", "rsnext-step-feedback");
  feedback.setAttribute("role", "status");
  steps[1].section.append(feedback);
  const conflicts = el("select");
  for (const [value, label] of [
    ["keep_newer", "保留较新文件（推荐）"],
    ["keep_both", "保留双方副本"],
  ]) {
    const option = el("option", label);
    option.value = value;
    conflicts.append(option);
  }
  const conflict = plugin.settings.conflictAction ?? "keep_newer";
  if (!["keep_newer", "keep_both"].includes(conflict)) {
    const option = el("option", "保留现有高级策略");
    option.value = conflict;
    conflicts.append(option);
  }
  conflicts.value = conflict;
  row("文件冲突时", conflicts, steps[2].section);
  const hint = el("p", "", "rsnext-step-feedback"),
    sync = el("button", "立即同步"),
    status = el("p", plugin.syncUiStatus, "rsnext-status");
  sync.dataset.action = "sync";
  status.setAttribute("role", "status");
  steps[2].section.append(
    hint,
    sync,
    status,
    el(
      "p",
      "当前仅支持电脑端手动同步。单文件最多 64 MiB，未加密空文件暂不支持。",
      "rsnext-step-help"
    )
  );
  const updateProgress = createSyncProgress(status, () => plugin.syncUiActivity);
  const updateSyncControls = createSyncControls(sync, plugin);
  const extra = el("details", "", "rsnext-advanced"),
    extraBody = el("fieldset"),
    preview = el("button", "预览同步计划");
  extra.append(el("summary", "高级设置"), extraBody);
  extra.hidden = !desktop;
  settings.append(extra);
  let loaded = false;
  const controls = [
    service,
    login,
    logout,
    folder,
    prepare,
    conflicts,
    sync,
    preview,
    extraBody,
  ];
  let disposed = false,
    busy = false,
    closeLogin: (() => void) | undefined,
    showHistory = false,
    limit = 20,
    historyRevision = 0,
    requiresValidation = false;
  const logged = () => !!plugin.settings.aliyunNative?.session;
  const ready = () => {
    try {
      const config = plugin.settings.aliyunNative;
      return (
        !requiresValidation &&
        desktop &&
        logged() &&
        aliyunRoot(folder.value.trim()) === config?.remoteRoot &&
        config.overwriteVerified === aliyunOverwriteBinding(config)
      );
    } catch {
      return false;
    }
  };
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
  const update = () => {
    updateProgress();
    if (disposed) return;
    const locked = busy || plugin.isSyncing || plugin.nativeMaintenance;
    controls.forEach(
      (control) =>
        (control.disabled = locked || (!desktop && control !== service))
    );
    folder.disabled = locked || !desktop || !logged();
    prepare.disabled = locked || !desktop || !logged();
    sync.disabled = locked || !ready();
    updateSyncControls();
    preview.disabled = locked || !ready();
    logout.hidden = !logged();
    accountText.textContent = logged() ? "已登录" : "尚未登录";
    login.textContent = logged() ? "重新扫码登录" : "扫码登录";
    steps.forEach((step, i) => {
      const state =
        i === 0
          ? logged()
            ? "complete"
            : "current"
          : i === 1
            ? ready()
              ? "complete"
              : logged()
                ? "current"
                : "locked"
            : ready()
              ? "current"
              : "locked";
      step.section.dataset.state = state;
      step.badge.textContent =
        state === "complete"
          ? "已完成"
          : state === "current"
            ? "下一步"
            : "等待前一步";
      if (state === "current")
        step.section.setAttribute("aria-current", "step");
      else step.section.removeAttribute("aria-current");
    });
    login.classList.toggle("mod-cta", desktop && !logged());
    prepare.classList.toggle("mod-cta", desktop && logged() && !ready());
    sync.classList.toggle("mod-cta", ready());
    hint.textContent = ready()
      ? "文件夹已准备好，可以开始同步。"
      : logged()
        ? "请先准备同步文件夹。"
        : "请先扫码登录。";
    status.textContent = plugin.syncUiStatus;
    [settingsTab, historyTab].forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(showHistory === !!i));
      tab.tabIndex = showHistory === !!i ? 0 : -1;
    });
    settings.hidden = showHistory;
    history.hidden = !showHistory;
  };
  const save = async (config: AliyunConfig) => {
    const previous = plugin.settings.aliyunNative;
    plugin.settings.aliyunNative = config;
    try {
      await plugin.saveSettings();
    } catch (error) {
      if (plugin.settings.aliyunNative === config)
        plugin.settings.aliyunNative = previous;
      throw error;
    }
  };
  const run = async (action: () => Promise<void>) => {
    if (disposed || busy || plugin.isSyncing || plugin.nativeMaintenance)
      return;
    busy = true;
    plugin.nativeMaintenance = true;
    update();
    try {
      await action();
    } catch (error) {
      if (!disposed) {
        feedback.textContent = errorText(error);
        light.dataset.state = "failure";
        light.title = feedback.textContent;
        light.setAttribute("aria-label", feedback.textContent);
      }
    } finally {
      busy = false;
      plugin.nativeMaintenance = false;
      plugin.updateSyncUi();
      update();
    }
  };
  folder.oninput = () => {
    requiresValidation = true;
    feedback.textContent = "文件夹已更改，请重新准备。";
    light.dataset.state = "idle";
    update();
  };
  prepare.onclick = () => {
    if (!desktop) return;
    void run(async () => {
      requiresValidation = true;
      update();
      let previous = plugin.settings.aliyunNative;
      const input = folder.value.trim();
      const normalized = aliyunRoot(input);
      const config = {
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
      feedback.textContent = "正在准备文件夹并验证读写…";
      light.dataset.state = "testing";
      const prepared = await actions.prepare(config, guard, async (session) => {
        guard();
        const refreshed = { ...previous, session };
        await save(refreshed);
        if (plugin.settings.aliyunNative !== refreshed)
          throw { code: "configuration_changed" };
        previous = refreshed;
        guard();
      });
      guard();
      await save(prepared);
      if (disposed) return;
      folder.value = prepared.remoteRoot!;
      requiresValidation = false;
      feedback.textContent = "文件夹已准备好，读写验证通过。";
      light.dataset.state = "success";
      light.title = feedback.textContent;
      light.setAttribute("aria-label", feedback.textContent);
    });
  };
  login.onclick = () => {
    if (!desktop || busy || plugin.isSyncing || plugin.nativeMaintenance)
      return;
    busy = true;
    plugin.nativeMaintenance = true;
    update();
    try {
      closeLogin = actions.openLogin(() => {
        closeLogin = undefined;
        busy = false;
        plugin.nativeMaintenance = false;
        plugin.updateSyncUi();
        update();
      });
    } catch (error) {
      busy = false;
      plugin.nativeMaintenance = false;
      feedback.textContent = errorText(error);
      update();
    }
  };
  logout.onclick = () =>
    void run(async () => {
      await save({ remoteRoot: plugin.settings.aliyunNative?.remoteRoot });
      light.dataset.state = "idle";
      feedback.textContent = "已退出登录。";
    });
  service.onchange = () =>
    void run(async () => {
      plugin.settings.serviceType = service.value as any;
      await plugin.saveSettings();
      redisplay();
    });
  conflicts.onchange = () =>
    void run(async () => {
      plugin.settings.conflictAction = conflicts.value as any;
      await plugin.saveSettings();
    });
  const start = (mode: "manual" | "dry") => {
    if (!ready() || busy || plugin.isSyncing || plugin.nativeMaintenance)
      return;
    void plugin.syncRun(mode).catch(() => {
      if (!disposed) status.textContent = "同步未完成，请查看同步记录。";
    });
  };
  sync.onclick = () => start("manual");
  preview.onclick = () => start("dry");
  extra.ontoggle = () => {
    if (extra.open && !loaded) {
      loaded = true;
      advanced(extraBody);
      extraBody.prepend(preview);
      update();
    }
  };
  const renderHistory = async () => {
    const revision = ++historyRevision;
    try {
      let records: SyncActivity[] =
        logged() && plugin.settings.aliyunNative?.remoteRoot
          ? await plugin.getSyncActivities()
          : [];
      if (disposed || revision !== historyRevision) return;
      const open = new Set(
        Array.from(history.querySelectorAll("details[open]")).map(
          (node) => (node as HTMLElement).dataset.id
        )
      );
      const active = plugin.syncUiActivity;
      if (
        active?.status === "running" &&
        plugin.settings.aliyunNative?.remoteRoot &&
        logged()
      )
        records = [
          active,
          ...records.filter((record) => record.id !== active.id),
        ];
      history.replaceChildren();
      history.append(
        el("p", records.length ? "最近的同步记录" : "还没有同步记录")
      );
      const labels: Record<string, string> = {
        running: "同步中",
        success: "已完成",
        unchanged: "没有变化",
        partial: "部分未完成",
        failed: "失败",
        paused: "已暂停",
        cancelled: "已停止",
      };
      for (const record of records.slice(0, limit)) {
        const item = el("details", "", "rsnext-record");
        item.dataset.id = record.id;
        item.open = open.has(record.id);
        item.append(
          el(
            "summary",
            `${new Date(record.startedAt).toLocaleString()} · ${labels[record.status] ?? record.status} · 上传 ${record.counts.upload} / 下载 ${record.counts.download} / 删除 ${record.counts.delete}`
          )
        );
        appendProgressResult(item, record);
      if (record.error) item.append(el("p", record.error));
        for (const [title, paths] of [
          ["上传", record.files.upload],
          ["下载", record.files.download],
          ["删除", record.files.delete],
          ["未完成的文件", record.failedPaths],
        ] as [string, string[]][]) {
          if (!paths.length) continue;
          item.append(el("h4", title));
          const list = el("ul", "", "rsnext-path-tree"),
            more = el("button", "显示更多文件");
          let shown = 0;
          const append = () => {
            for (const path of paths.slice(shown, shown + 50)) {
              const parts = path.split("/");
              let branch = list;
              for (const dir of parts.slice(0, -1)) {
                let node = Array.from(branch.children).find(
                  (child) => (child as HTMLElement).dataset.dir === dir
                ) as HTMLLIElement | undefined;
                if (!node) {
                  node = el("li");
                  node.dataset.dir = dir;
                  node.append(el("span", dir + "/"), el("ul"));
                  branch.append(node);
                }
                branch = node.querySelector("ul")!;
              }
              branch.append(el("li", parts[parts.length - 1]));
            }
            shown += 50;
            more.hidden = shown >= paths.length;
          };
          append();
          more.onclick = append;
          item.append(list, more);
        }
        history.append(item);
      }
      if (records.length > limit) {
        const more = el("button", "加载更多记录");
        more.onclick = () => {
          limit += 20;
          void renderHistory();
        };
        history.append(more);
      }
    } catch {
      if (!disposed) history.textContent = "同步记录读取失败，请重试";
    }
  };
  const switchTab = (show: boolean) => {
    showHistory = show;
    update();
    if (show) void renderHistory();
  };
  settingsTab.onclick = () => switchTab(false);
  historyTab.onclick = () => switchTab(true);
  tabs.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    switchTab(
      event.key === "Home" ? false : event.key === "End" ? true : !showHistory
    );
    (showHistory ? historyTab : settingsTab).focus();
  };
  const unsubscribe = plugin.onSyncUiUpdate(() => {
    update();
    if (showHistory) void renderHistory();
  });
  update();
  return () => {
    disposed = true;
    historyRevision++;
    closeLogin?.();
    unsubscribe();
    root.remove();
  };
}
