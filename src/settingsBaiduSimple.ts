import { createSyncControls } from "./syncControlsUi";
import { createSyncProgress, appendProgressResult } from "./syncProgressUi";
import { openBaiduExternal } from "./native/baiduExternal";
import type RemotelySavePlugin from "./main";
import type { BaiduConnection } from "./native/baiduConnection";
import { createBaiduAuthorizationUrl } from "./native/baiduAuth";
import { createServicePicker } from "./settingsServicePicker";
import type { SyncActivity } from "./syncActivity";

export function renderSimpleBaidu(
  parent: HTMLElement,
  plugin: RemotelySavePlugin,
  connection: BaiduConnection,
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
    const n = doc.createElement(tag);
    n.textContent = text;
    n.className = cls;
    return n;
  };
  const root = el("div", "", "rsnext-settings");
  parent.append(root);
  const header = el("div", "", "rsnext-header"),
    sync = el("button", "立即同步", "mod-cta"),
    status = el("p", plugin.syncUiStatus, "rsnext-status");
  sync.dataset.action = "sync";
  status.setAttribute("role", "status");
  header.append(el("h2", "remotely-save-next"), sync);
  root.append(header);
  root.append(
    el("p", "按下面 3 步完成设置；已完成的步骤无需重复。", "rsnext-setup-intro")
  );
  const tabs = el("div", "", "rsnext-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "百度同步管理");
  const settingsTab = el("button", "同步设置"),
    historyTab = el("button", "同步记录");
  tabs.append(settingsTab, historyTab);
  root.append(tabs);
  const settings = el("div"),
    history = el("div");
  root.append(settings, history);
  const uid = `rsnext-baidu-${Math.random().toString(36).slice(2)}`;
  [settingsTab, historyTab].forEach((tab, i) => {
    tab.setAttribute("role", "tab");
    tab.id = `${uid}-tab-${i}`;
    tab.setAttribute("aria-controls", `${uid}-panel-${i}`);
    const panel = i ? history : settings;
    panel.id = `${uid}-panel-${i}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
  });
  let disposed = false,
    showHistory = false,
    limit = 20,
    revision = 0,
    tested: string | undefined,
    testResult: boolean | undefined,
    advancedLoaded = false;
  const controls: (
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLButtonElement
    | HTMLFieldSetElement
  )[] = [sync];
  const row = (
    name: string,
    control: HTMLElement,
    destination: HTMLElement = settings
  ) => {
    const box = el("div", "", "rsnext-row"),
      label = el("label", name);
    control.id = `${uid}-field-${controls.length}`;
    label.htmlFor = control.id;
    box.append(label, control);
    destination.append(box);
  };
  const service = createServicePicker(
    doc,
    "baidu",
    plugin.settings.legacyServiceType
  );
  controls.push(service);
  root.prepend(service);
  const mobileGuide = el("section", "", "rsnext-mobile-guide");
  mobileGuide.setAttribute("role", "note");
  mobileGuide.append(
    el("h3", "请到电脑完成设置"),
    el(
      "p",
      "百度登录和同步文件夹设置，请在电脑端 Obsidian 完成。当前版本手机端暂不支持百度同步。"
    )
  );
  const mobileSteps = el("ol");
  for (const text of [
    "在电脑上打开对应的笔记库。",
    "进入设置 → remotely-save-next，选择百度网盘。",
    "按页面提示完成登录、准备文件夹，再开始同步。",
  ])
    mobileSteps.append(el("li", text));
  mobileGuide.append(mobileSteps);
  mobileGuide.hidden = desktop;
  settings.append(mobileGuide);
  const step = (title: string) => {
    const section = el("section", "", "rsnext-setup-step"),
      head = el("div", "", "rsnext-step-head"),
      badge = el("span", "", "rsnext-step-badge");
    head.append(el("h3", title), badge);
    section.append(head);
    section.hidden = !desktop;
    settings.append(section);
    return { section, badge };
  };
  const step1 = step("1. 登录百度网盘"),
    step2 = step("2. 选择同步文件夹"),
    step3 = step("3. 开始同步");
  const directoryFeedback = el("p", "", "rsnext-step-feedback");
  directoryFeedback.setAttribute("role", "status");
  const directoryDiagnostics = el("details", "", "rsnext-diagnostics");
  directoryDiagnostics.append(el("summary", "查看错误详情"));
  const diagnosticText = el("p");
  directoryDiagnostics.append(diagnosticText);
  directoryDiagnostics.hidden = true;
  const syncHint = el("p", "", "rsnext-step-feedback");
  step2.section.append(
    el(
      "p",
      "建议每个笔记库使用一个单独的网盘文件夹；不存在时自动创建。",
      "rsnext-step-help"
    )
  );

  const logged = () => !!plugin.settings.baiduNative?.tokens;
  const account = el("div", "", "rsnext-address-control"),
    accountText = el("span"),
    login = el("button", "登录百度"),
    logout = el("button", "退出登录");
  login.dataset.action = "login";
  controls.push(login, logout);
  account.append(accountText, login, logout);
  row("登录状态", account, step1.section);
  const directory = el("input");
  directory.type = "text";
  directory.dataset.field = "remoteRoot";
  directory.value =
    plugin.settings.baiduNative?.remoteRoot ??
    `/apps/remotely-save-next/${plugin.app.vault.getName()}`;
  directory.spellcheck = false;
  const test = el("button", "准备同步文件夹"),
    light = el("span", "", "rsnext-connection-light");
  test.dataset.action = "test";
  test.title = "检查并保存文件夹；不存在时自动创建";
  light.setAttribute("role", "status");
  light.setAttribute("aria-live", "polite");
  controls.push(directory, test);
  row("网盘文件夹", directory, step2.section);
  const directoryBox = el("div", "", "rsnext-address-control");
  directory.replaceWith(directoryBox);
  directoryBox.append(directory, test, light);
  const loginDetails = el("details", "", "rsnext-advanced"),
    loginSummary = el("summary", "百度官方授权"),
    loginBody = el("div");
  loginDetails.append(loginSummary, loginBody);
  step1.section.append(loginDetails);
  loginDetails.open = !logged();
  const authStatus = el("p", "", "rsnext-auth-status");
  authStatus.setAttribute("role", "status");
  const authLink = el("a", "未打开？点击这里手动授权");
  authLink.dataset.action = "authorization-link";
  authLink.target = "_blank";
  authLink.rel = "noopener noreferrer";
  authLink.hidden = true;
  const appHelp = el("a", "获取应用 Key / Secret");
  appHelp.href = "https://pan.baidu.com/union";
  appHelp.textContent = "去百度开放平台创建应用";
  appHelp.target = "_blank";
  appHelp.rel = "noopener noreferrer";
  loginBody.append(
    el(
      "p",
      "首次使用：创建百度应用，把 AppKey 和 AppSecret 复制到下方。AppID 和 SignKey 不用填。",
      "rsnext-step-help"
    ),
    appHelp,
    authStatus,
    authLink
  );
  const draft = {
    clientId: plugin.settings.baiduNative?.app.clientId ?? "",
    clientSecret: plugin.settings.baiduNative?.app.clientSecret ?? "",
    redirectUri: "oob",
  };
  let authorization:
    | { clientId: string; clientSecret: string; started: number }
    | undefined;
  const key = el("input");
  key.value = draft.clientId;
  controls.push(key);
  row("应用 AppKey", key, loginBody);
  key.oninput = () => {
    draft.clientId = key.value.trim();
    authorization = undefined;
    update();
  };
  const secret = el("input");
  secret.type = "password";
  secret.value = draft.clientSecret;
  controls.push(secret);
  row("应用 AppSecret", secret, loginBody);
  secret.oninput = () => {
    draft.clientSecret = secret.value.trim();
    authorization = undefined;
    update();
  };
  const secretBox = el("div", "", "rsnext-password-control"),
    eye = el("button", "", "rsnext-password-toggle");
  eye.type = "button";
  eye.setAttribute("aria-controls", secret.id);
  controls.push(eye);
  secret.replaceWith(secretBox);
  secretBox.append(secret, eye);
  const paintEye = () => {
    const visible = secret.type === "text";
    eye.setAttribute("aria-label", visible ? "隐藏密钥" : "显示密钥");
    eye.setAttribute("aria-pressed", String(visible));
    eye.title = eye.getAttribute("aria-label")!;
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("aria-hidden", "true");
    for (const d of [
      "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z",
      "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
      ...(visible ? ["M3 3l18 18"] : []),
    ]) {
      const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    eye.replaceChildren(svg);
  };
  paintEye();
  eye.onclick = () => {
    secret.type = secret.type === "password" ? "text" : "password";
    paintEye();
  };
  const authorize = el("button", "打开百度授权页"),
    code = el("input"),
    saveLogin = el("button", "完成登录");
  code.type = "password";
  controls.push(authorize, code, saveLogin);
  loginBody.append(authorize);
  row("百度授权码", code, loginBody);
  const codeRow = code.parentElement!;

  loginBody.append(
    saveLogin,
    el(
      "small",
      "在百度页面确认授权后，复制授权码到这里，再点击完成登录。授权码 10 分钟内有效。",
      "rsnext-hint"
    )
  );
  step2.section.append(directoryFeedback, directoryDiagnostics);
  const conflicts = el("select");
  for (const [value, label] of [
    ["keep_newer", "保留较新文件（推荐）"],
    ["keep_both", "保留双方副本"],
  ]) {
    const option = el("option", label);
    option.value = value;
    conflicts.append(option);
  }
  const current = plugin.settings.conflictAction ?? "keep_newer";
  if (!["keep_newer", "keep_both"].includes(current)) {
    const option = el("option", "保留现有高级策略");
    option.value = current;
    conflicts.append(option);
  }
  conflicts.value = current;
  controls.push(conflicts);
  row("文件冲突时", conflicts, step3.section);
  step3.section.append(syncHint, sync, status);
  const updateProgress = createSyncProgress(status, () => plugin.syncUiActivity);
  const updateSyncControls = createSyncControls(sync, plugin);
  step3.section.append(
    el(
      "p",
      desktop
        ? "当前支持手动同步；单文件最多 64 MiB，空明文文件暂不支持，加密仅支持 OpenSSL。"
        : "当前设备仅支持登录和目录检查。",
      "rsnext-hint"
    )
  );
  const advancedDetails = el("details", "", "rsnext-advanced"),
    fieldset = el("fieldset");
  controls.push(fieldset);
  advancedDetails.append(el("summary", "高级设置"), fieldset);
  settings.append(advancedDetails);
  advancedDetails.hidden = !desktop;
  advancedDetails.ontoggle = () => {
    if (advancedDetails.open && !advancedLoaded) {
      advancedLoaded = true;
      advanced(fieldset);
      fieldset.prepend(preview);
    }
  };
  let requiresValidation = false;
  const ready = () =>
    !requiresValidation &&
    desktop &&
    logged() &&
    !!plugin.settings.baiduNative?.remoteRoot &&
    directory.value.trim() === plugin.settings.baiduNative.remoteRoot;
  const friendly = (error: any) => {
    const messages: Record<string, string> = {
      invalid_path: "同步目录需填写有效的绝对路径",
      not_logged_in: "请先登录百度网盘",
      reauthorize_required: "请重新登录百度网盘",
      authorization_not_started_or_expired: "请重新打开授权页获取授权码",
      account_changed: "账号已变化，请重新检查连接",
      directory_changed: "同步目录已变化，请重新测试",
      invalid_grant: "授权码无效或已过期",
      invalid_client: "请检查应用 Key 和密钥",
      missing_netdisk_scope: "授权未包含网盘权限，请检查应用权限后重新登录",
      transport_error: "无法连接百度接口，请检查网络后重试",
      http_error: "百度接口请求失败",
      platform_error: "百度接口拒绝了文件夹操作",
      entry_limit: "目录文件数量超过当前检查上限",
      page_limit: "目录分页超过当前检查上限",
    };
    if (!Object.prototype.hasOwnProperty.call(messages, error?.code))
      return "操作未完成，请检查授权、网络及目录权限";
    const details = [error.code];
    if (error.code === "platform_error" && Number.isSafeInteger(error.errno))
      details.push(`errno=${error.errno}`);
    if (
      error.code === "http_error" &&
      Number.isInteger(error.status) &&
      error.status >= 100 &&
      error.status <= 599
    )
      details.push(`HTTP ${error.status}`);
    return `${messages[error.code]}（${details.join("，")}）`;
  };
  const run = async (action: () => Promise<void>) => {
    if (plugin.isSyncing || plugin.nativeMaintenance || connection.busy) return;
    plugin.nativeMaintenance = true;
    update();
    try {
      await action();
    } catch (error) {
      status.textContent = friendly(error);
      authStatus.textContent = friendly(error);
    } finally {
      plugin.nativeMaintenance = false;
      if (!disposed) plugin.updateSyncUi();
    }
  };
  login.onclick = () => {
    loginDetails.open = logged() ? !loginDetails.open : true;
  };
  authorize.onclick = async () => {
    if (plugin.isSyncing || plugin.nativeMaintenance || connection.busy) return;
    if (!draft.clientId) {
      authStatus.textContent =
        "尚未配置应用 API Key，请先填写或点击获取应用信息";
      key.focus();
      return;
    }
    try {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24)),
        state = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
          ""
        );
      const url = createBaiduAuthorizationUrl(draft.clientId, "oob", state);
      authLink.href = url;
      authLink.hidden = false;
      authorization = { ...draft, started: Date.now() };
      await openBaiduExternal(url, desktop, doc.defaultView);
      authStatus.textContent =
        "请完成百度官方授权，再填写授权码；未跳转可点击上方链接";
    } catch {
      authStatus.textContent = "无法自动打开浏览器，请点击上方链接手动授权";
    }
  };
  saveLogin.onclick = () =>
    void run(async () => {
      if (
        !authorization ||
        Date.now() - authorization.started >= 600000 ||
        authorization.clientId !== draft.clientId ||
        authorization.clientSecret !== draft.clientSecret
      )
        throw { code: "authorization_not_started_or_expired" };
      const submitted = code.value.trim();
      code.value = "";
      authorization = undefined;
      await connection.login({ ...draft }, submitted);
      tested = undefined;
      testResult = undefined;
      requiresValidation = true;
      loginDetails.open = false;
      status.textContent = "登录成功，请测试同步目录";
    });
  logout.onclick = () =>
    void run(async () => {
      await connection.logout();
      tested = undefined;
      testResult = undefined;
      status.textContent = "已退出登录";
    });
  directory.oninput = () => {
    requiresValidation = true;
    tested = undefined;
    testResult = undefined;
    update();
  };
  test.onclick = () =>
    void run(async () => {
      const selected = directory.value.trim();
      tested = selected;
      try {
        if (desktop)
          await connection.setRemoteRoot(selected, { createIfMissing: true });
        else await connection.scan(selected);
        if (directory.value.trim() !== selected)
          throw { code: "directory_changed" };
        if (desktop) {
          directory.value = plugin.settings.baiduNative!.remoteRoot!;
          tested = directory.value;
        }
        testResult = true;
        requiresValidation = false;
      } catch (error) {
        testResult = false;
        light.title = friendly(error);
        throw error;
      }
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
  sync.onclick = () => {
    if (ready() && !plugin.isSyncing && !plugin.nativeMaintenance)
      void plugin.syncRun("manual").catch(() => {
        if (!disposed) status.textContent = "同步未完成，请检查同步配置";
      });
  };
  const preview = el("button", "预览同步计划");
  controls.push(preview);
  fieldset.append(preview);
  preview.onclick = () => {
    if (ready() && !plugin.isSyncing && !plugin.nativeMaintenance)
      void plugin.syncRun("dry").catch(() => {
        if (!disposed) status.textContent = "预览未完成，请检查同步配置";
      });
  };
  const statusLabels = {
    running: "同步中",
    success: "已完成",
    unchanged: "没有变化",
    partial: "部分完成",
    failed: "失败",
    paused: "已暂停",
    cancelled: "已停止",
  };
  let records: SyncActivity[] = [];
  const renderHistory = () => {
    const open = new Set(
      Array.from(history.querySelectorAll("details[open]")).map(
        (n) => (n as HTMLElement).dataset.id
      )
    );
    history.replaceChildren();
    const active = plugin.syncUiActivity;
    const all =
      active?.status === "running"
        ? [active, ...records.filter((r) => r.id !== active.id)]
        : records;
    if (!all.length) history.append(el("p", "还没有同步记录"));
    for (const record of all.slice(0, limit)) {
      const item = el("details", "", "rsnext-record");
      item.dataset.id = record.id;
      item.open = open.has(record.id);
      item.append(
        el(
          "summary",
          `${new Date(record.startedAt).toLocaleString()} · ${statusLabels[record.status]} · 上传 ${record.counts.upload} / 下载 ${record.counts.download} / 删除 ${record.counts.delete}`
        )
      );
      item.append(
        el(
          "small",
          `手动同步${record.endedAt ? ` · 耗时 ${Math.max(0, (record.endedAt - record.startedAt) / 1000).toFixed(1)} 秒` : ""}`
        )
      );
      appendProgressResult(item, record);
      if (record.error) item.append(el("p", record.error));
      for (const [action, label] of [
        ["upload", "上传"],
        ["download", "下载"],
        ["delete", "删除"],
      ] as const) {
        const paths = record.files[action];
        if (!paths.length) continue;
        item.append(el("h4", label));
        const list = el("ul", "", "rsnext-path-tree"),
          more = el("button", "显示更多文件");
        let shown = 0;
        const append = () => {
          for (const path of paths.slice(shown, shown + 50)) {
            const parts = path.split("/");
            let branch = list;
            for (const dir of parts.slice(0, -1)) {
              let node = Array.from(branch.children).find(
                (n) => (n as HTMLElement).dataset.dir === dir
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
      if (record.failedPaths.length) {
        item.append(el("h4", "未完成的文件"));
        const list = el("ul");
        record.failedPaths
          .slice(0, 50)
          .forEach((path) => list.append(el("li", path)));
        item.append(list);
      }
      history.append(item);
    }
    if (all.length > limit) {
      const more = el("button", "加载更多记录");
      more.onclick = () => {
        limit += 20;
        renderHistory();
      };
      history.append(more);
    }
  };
  const refreshHistory = async () => {
    const ticket = ++revision;
    try {
      const next =
        logged() && plugin.settings.baiduNative?.remoteRoot
          ? await plugin.getSyncActivities()
          : [];
      if (disposed || ticket !== revision) return;
      records = next;
      renderHistory();
    } catch {
      if (!disposed)
        history.textContent = "同步记录暂时无法读取，请检查账号和目录";
    }
  };
  const selectTab = (index: number) => {
    showHistory = index === 1;
    settings.hidden = showHistory;
    history.hidden = !showHistory;
    [settingsTab, historyTab].forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    if (showHistory) void refreshHistory();
  };
  [settingsTab, historyTab].forEach((tab, i) => {
    tab.onclick = () => selectTab(i);
    tab.onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? 1 : 1 - i;
      selectTab(next);
      [settingsTab, historyTab][next].focus();
    };
  });
  let lastSyncStatus = plugin.syncUiStatus;
  function update() {
    updateProgress();
    if (disposed) return;
    const busy =
      plugin.isSyncing || plugin.nativeMaintenance || connection.busy;
    controls.forEach((control) => {
      control.disabled = busy || (!desktop && control !== service);
    });
    directory.disabled = busy || !logged() || !desktop;
    codeRow.hidden = !authorization;
    saveLogin.hidden = !authorization;
    authorize.textContent = authorization
      ? "重新打开百度授权页"
      : "打开百度授权页";
    authorize.classList.toggle(
      "mod-cta",
      desktop && !logged() && !authorization
    );
    saveLogin.classList.toggle(
      "mod-cta",
      desktop && !logged() && !!authorization
    );
    test.classList.toggle("mod-cta", desktop && logged() && !ready());
    sync.classList.toggle("mod-cta", desktop && ready());
    step1.section.dataset.state = logged() ? "complete" : "current";
    step1.badge.textContent = logged() ? "已完成" : "待登录";
    step2.section.dataset.state = !logged()
      ? "locked"
      : ready()
        ? "complete"
        : "current";
    step2.badge.textContent = ready()
      ? "已准备好"
      : !logged()
        ? "先完成登录"
        : "待准备";
    step3.section.dataset.state = ready() ? "current" : "locked";
    step3.badge.textContent = ready() ? "可以同步" : "先完成前两步";
    for (const item of [step1, step2, step3]) {
      if (item.section.dataset.state === "current")
        item.section.setAttribute("aria-current", "step");
      else item.section.removeAttribute("aria-current");
    }
    syncHint.textContent = ready()
      ? "设置已完成，点击立即同步。"
      : !logged()
        ? "请先完成第 1 步：登录百度网盘。"
        : "请先完成第 2 步：准备同步文件夹。";

    sync.disabled = busy || !ready();
    sync.title = busy
      ? "正在处理，请稍候"
      : !desktop
        ? "百度同步仅支持电脑端"
        : !logged()
          ? "请先完成百度登录"
          : !ready()
            ? "请重新测试并保存同步目录"
            : "开始同步";

    preview.disabled = busy || !ready();
    test.disabled = busy || !desktop || !logged() || !directory.value.trim();
    accountText.textContent = logged() ? "已登录" : "未登录";
    logout.hidden = !logged();
    login.textContent = logged() ? "重新登录" : "查看登录步骤";
    const state =
      plugin.nativeMaintenance && tested === directory.value.trim()
        ? "testing"
        : tested === directory.value.trim() && testResult !== undefined
          ? testResult
            ? "success"
            : "failure"
          : "idle";
    light.dataset.state = state;
    test.textContent = state === "testing" ? "正在准备…" : "准备同步文件夹";
    directoryDiagnostics.hidden = state !== "failure";
    diagnosticText.textContent = state === "failure" ? light.title : "";
    directoryFeedback.textContent = !logged()
      ? "完成登录后，在这里选择文件夹。"
      : state === "testing"
        ? "正在检查文件夹；不存在时会自动创建…"
        : state === "success"
          ? "文件夹已准备好，可以开始同步。"
          : state === "failure"
            ? (light.title || "文件夹准备失败，请重试。").split("（")[0]
            : "填写网盘路径后，点击准备同步文件夹。";
    directoryFeedback.dataset.state = state;

    const label =
      state === "success"
        ? "连接成功"
        : state === "failure"
          ? light.title || "连接失败"
          : state === "testing"
            ? "正在测试连接"
            : "尚未测试连接";
    light.setAttribute("aria-label", label);
    if (state !== "failure") light.title = label;
    if (lastSyncStatus !== plugin.syncUiStatus) {
      lastSyncStatus = plugin.syncUiStatus;
      status.textContent = plugin.syncUiStatus;
    }
    sync.textContent = plugin.isSyncing ? "正在同步…" : "立即同步";
    updateSyncControls();
    if (showHistory) {
      if (plugin.isSyncing) renderHistory();
      else void refreshHistory();
    }
  }
  const unsubscribe = plugin.onSyncUiUpdate(update);
  selectTab(0);
  update();
  return () => {
    disposed = true;
    revision++;
    unsubscribe();
  };
}
