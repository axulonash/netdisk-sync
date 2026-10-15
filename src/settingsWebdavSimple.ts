import { resolveWebdavDirectory } from "./webdavDirectory";
import { createSyncControls } from "./syncControlsUi";
import { createSyncProgress, appendProgressResult } from "./syncProgressUi";
import type RemotelySavePlugin from "./main";
import { createServicePicker } from "./settingsServicePicker";
import { webdavTarget, webdavScope, type SyncActivity } from "./syncActivity";

/** Native DOM and Obsidian theme variables; no framework or remote assets. */
export function renderSimpleWebdav(
  parent: HTMLElement,
  plugin: RemotelySavePlugin,
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
  let disposed = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    saving = Promise.resolve(),
    records: SyncActivity[] = [],
    limit = 20,
    historyActive = false,
    generation = 0;
  const status = el("p", plugin.syncUiStatus, "rsnext-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const persist = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    saving = saving.catch(() => {}).then(() => plugin.saveSettings());
    return saving;
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void persist().catch(() => {
        status.textContent = "设置保存失败，请重试";
      });
    }, 300);
  };
  const header = el("div", "", "rsnext-header"),
    title = el("h2", "remotely-save-next"),
    sync = el("button", "立即同步", "mod-cta");
  header.append(title, sync);
  root.append(header, status);
  const updateProgress = createSyncProgress(status, () => plugin.syncUiActivity);
  const updateSyncControls = createSyncControls(sync, plugin);
  const tabs = el("div", "", "rsnext-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "同步管理");
  const settingsTab = el("button", "同步设置"),
    historyTab = el("button", "同步记录");
  tabs.append(settingsTab, historyTab);
  root.append(tabs);
  const settings = el("div"),
    history = el("div");
  settings.setAttribute("role", "tabpanel");
  history.setAttribute("role", "tabpanel");
  root.append(settings, history);
  const id = `rsnext-${Math.random().toString(36).slice(2)}`;
  [settingsTab, historyTab].forEach((tab, i) => {
    tab.id = `${id}-tab${i}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `${id}-panel${i}`);
    const panel = i ? history : settings;
    panel.id = `${id}-panel${i}`;
    panel.setAttribute("aria-labelledby", tab.id);
  });
  const controls: (
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLButtonElement
    | HTMLFieldSetElement
  )[] = [];
  const row = (name: string, control: HTMLElement, description?: string) => {
    const box = el("div", "", "rsnext-row"),
      label = el("label", name);
    const controlId = `${id}-field${controls.length}`;
    control.id = controlId;
    label.htmlFor = controlId;
    box.append(label, control);
    if (description) {
      const hint = el("small", description);
      hint.id = `${controlId}-hint`;
      control.setAttribute("aria-describedby", hint.id);
      box.append(hint);
    }
    settings.append(box);
  };
  const service = createServicePicker(
    doc,
    "webdav",
    plugin.settings.legacyServiceType
  );
  controls.push(service);
  root.prepend(service);
  service.onchange = async () => {
    await persist();
    plugin.settings.serviceType = service.value as any;
    await persist();
    redisplay();
  };
  const target = el("p", "", "rsnext-target");
  const test = el("button", "测试连接");
  test.title = "测试会写入并删除临时文件";
  const light = el("span", "", "rsnext-connection-light");
  light.setAttribute("role", "status");
  light.setAttribute("aria-live", "polite");
  controls.push(test);
  let testedScope: string | undefined, connectionSuccess: boolean | undefined;
  let connectionMessage: string | undefined;
  const invalidate = () => {
    connectionMessage = undefined;
    testedScope = undefined;
    connectionSuccess = undefined;
    plugin.settings.webdavNeedsValidation = true;
    plugin.syncUiStatus = "连接信息已更改，请重新测试";
    schedule();
    update();
  };
  for (const [key, label, type] of [
    ["address", "服务器地址", "url"],
    ["username", "账号", "text"],
    ["password", "密码", "password"],
  ] as const) {
    const input = el("input");
    input.type = type;
    input.value = plugin.settings.webdav[key] ?? "";
    input.setAttribute(
      "autocomplete",
      key === "password"
        ? "current-password"
        : key === "username"
          ? "username"
          : "url"
    );
    input.spellcheck = false;
    controls.push(input);
    row(label, input);
    input.oninput = () => {
      plugin.settings.webdav[key] =
        key === "address" ? input.value.trim() : input.value;
      invalidate();
    };
    if (key === "address") {
      const field = el("div", "", "rsnext-address-control");
      input.replaceWith(field);
      field.append(input, test, light);
      const directory = el("input");
      directory.type = "text";
      const existingDirectory = (plugin.settings.webdav.remoteBaseDir || plugin.app.vault.getName()).replace(/^\/+|\/+$/g, "");
      directory.value = "/" + (plugin.settings.webdav.parentDir ?? existingDirectory.split("/").slice(0, -1).join("/"));
      directory.placeholder = "/home/Drive";
      directory.spellcheck = false;
      controls.push(directory);
      row("同步目录", directory, `自动追加当前笔记本名称：${plugin.app.vault.getName()}`);
      settings.append(target);
      directory.oninput = () => {
        plugin.settings.webdav.parentDir = directory.value.trim().replace(/^\/+|\/+$/g, "");
        plugin.settings.webdav.remoteBaseDir = resolveWebdavDirectory(plugin.settings.webdav, plugin.app.vault.getName());
        invalidate();
      };
    }
    if (key === "password") {
      const field = el("div", "", "rsnext-password-control");
      input.replaceWith(field);
      const show = el("button", "", "rsnext-password-toggle");
      show.type = "button";
      show.setAttribute("aria-controls", input.id);
      const drawIcon = (visible: boolean) => {
        const label = visible ? "隐藏密码" : "显示密码";
        show.setAttribute("aria-label", label);
        show.title = label;
        show.setAttribute("aria-pressed", String(visible));
        const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "18");
        svg.setAttribute("height", "18");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.setAttribute("aria-hidden", "true");
        for (const d of [
          "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z",
          "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
          ...(visible ? ["M3 3l18 18"] : []),
        ]) {
          const path = doc.createElementNS(
            "http://www.w3.org/2000/svg",
            "path"
          );
          path.setAttribute("d", d);
          svg.append(path);
        }
        show.replaceChildren(svg);
      };
      drawIcon(false);
      show.onclick = () => {
        const visible = input.type === "password";
        input.type = visible ? "text" : "password";
        drawIcon(visible);
      };
      controls.push(show);
      field.append(input, show);
      settings.append(el("hr", "", "rsnext-connection-divider"));
    }
  }
  test.onclick = async () => {
    try {
      await persist();
      testedScope = webdavScope(plugin.settings, plugin.app.vault.getName());
      connectionSuccess = await plugin.testWebdavConnection();
      connectionMessage = plugin.syncUiStatus;
    } catch {
      connectionSuccess = false;
      plugin.syncUiStatus = "设置保存失败，请重试";
    }
    update();
  };
  const autos = el("input");
  autos.type = "checkbox";
  autos.checked = (plugin.settings.syncOnSaveAfterMilliseconds ?? -1) > 0;
  controls.push(autos);
  row("保存时同步", autos);
  autos.onchange = async () => {
    plugin.settings.syncOnSaveAfterMilliseconds = autos.checked ? 2000 : -1;
    await persist();
    if (plugin.settings.agreeToUseSyncV3) plugin.toggleSyncOnSaveIfSet();
  };
  const interval = el("select");
  for (const minutes of [0, 1, 5, 10, 30]) {
    const o = el("option", minutes ? `每 ${minutes} 分钟` : "关闭");
    o.value = String(minutes ? minutes * 60000 : -1);
    interval.append(o);
  }
  const current = plugin.settings.autoRunEveryMilliseconds ?? -1;
  if (![-1, 60000, 300000, 600000, 1800000].includes(current)) {
    const o = el("option", `保留现有间隔（${current / 60000} 分钟）`);
    o.value = String(current);
    interval.append(o);
  }
  interval.value = String(current);
  controls.push(interval);
  row("定时同步", interval);
  interval.onchange = async () => {
    plugin.settings.autoRunEveryMilliseconds = Number(interval.value);
    await persist();
    if (plugin.settings.agreeToUseSyncV3) plugin.enableAutoSyncIfSet();
  };
  const conflicts = el("select");
  for (const [value, label] of [
    ["keep_newer", "保留较新文件（推荐）"],
    ["keep_both", "保留双方副本"],
  ]) {
    const o = el("option", label);
    o.value = value;
    conflicts.append(o);
  }
  if (
    !["keep_newer", "keep_both"].includes(
      plugin.settings.conflictAction ?? "keep_newer"
    )
  ) {
    const o = el("option", "保留现有高级策略");
    o.value = plugin.settings.conflictAction ?? "keep_newer";
    conflicts.append(o);
  }
  conflicts.value = plugin.settings.conflictAction ?? "keep_newer";
  controls.push(conflicts);
  row("冲突处理", conflicts);
  conflicts.onchange = async () => {
    plugin.settings.conflictAction = conflicts.value as any;
    await persist();
  };
  const details = el("details", "", "rsnext-advanced"),
    summary = el("summary", "高级设置"),
    fieldset = el("fieldset");
  controls.push(fieldset);
  details.append(summary, fieldset);
  settings.append(details);
  let advancedLoaded = false;
  details.ontoggle = () => {
    if (details.open && !advancedLoaded) {
      advancedLoaded = true;
      advanced(fieldset);
    }
  };
  const labels = {
    running: "同步中",
    success: "已完成",
    unchanged: "没有变化",
    partial: "部分完成",
    failed: "失败",
    paused: "已暂停",
    cancelled: "已停止",
  };
  const renderHistory = () => {
    const open = new Set(
      Array.from(history.querySelectorAll("details[open]")).map(
        (n) => (n as HTMLElement).dataset.id
      )
    );
    history.replaceChildren();
    history.append(
      el("p", "仅记录同步时间、统计和文件路径；最近 100 次。", "rsnext-hint")
    );
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
      const heading = el(
        "summary",
        `${new Date(record.startedAt).toLocaleString()} · ${labels[record.status]} · 上传 ${record.counts.upload} / 下载 ${record.counts.download} / 删除 ${record.counts.delete}`
      );
      item.append(heading);
      const triggers: Record<string, string> = {
        manual: "手动同步",
        auto: "定时同步",
        auto_sync_on_save: "保存时同步",
        auto_once_init: "启动时同步",
      };
      item.append(
        el(
          "small",
          `${triggers[record.trigger] ?? "自动同步"} · ${record.endedAt ? `耗时 ${Math.max(0, (record.endedAt - record.startedAt) / 1000).toFixed(1)} 秒` : "正在执行"}`
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
        item.append(el("h4", `${label} ${record.counts[action]}`));
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
        if (record.counts[action] > paths.length)
          item.append(el("small", "其余路径未保留，统计包含全部完成操作。"));
      }
      if (record.failedPaths.length) {
        item.append(el("h4", "未完成的文件"));
        const list = el("ul");
        for (const path of record.failedPaths.slice(0, 50))
          list.append(el("li", path));
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
  const loadHistory = async () => {
    const ticket = ++generation;
    try {
      const next = await plugin.getSyncActivities();
      if (disposed || ticket !== generation) return;
      records = next;
      renderHistory();
    } catch {
      if (!disposed) history.textContent = "同步记录读取失败，请稍后重试";
    }
  };
  const selectTab = (index: number) => {
    historyActive = index === 1;
    settings.hidden = historyActive;
    history.hidden = !historyActive;
    [settingsTab, historyTab].forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    if (historyActive) void loadHistory();
  };
  [settingsTab, historyTab].forEach((tab, index) => {
    tab.onclick = () => selectTab(index);
    tab.onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? 1 : 1 - index;
      selectTab(next);
      [settingsTab, historyTab][next].focus();
    };
  });
  function update() {
    if (disposed) return;
    updateProgress();
    const busy = plugin.isSyncing || plugin.nativeMaintenance;
    for (const control of controls) control.disabled = busy;
    let valid = false;
    try {
      const url = new URL(plugin.settings.webdav.address);
      valid =
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password;
    } catch {}
    sync.disabled = busy || !valid || !!plugin.settings.webdavNeedsValidation;
    test.disabled = busy || !valid;
    sync.textContent = plugin.isSyncing ? "正在同步…" : "立即同步";
    updateSyncControls();
    status.textContent = plugin.syncUiStatus;
    const scope = webdavScope(plugin.settings, plugin.app.vault.getName());
    const result =
      testedScope === scope
        ? connectionSuccess
        : !plugin.settings.webdavNeedsValidation &&
            plugin.settings.webdavVerifiedConfig === scope
          ? true
          : undefined;
    const state = plugin.nativeMaintenance
      ? "testing"
      : result === true
        ? "success"
        : result === false
          ? "failure"
          : "idle";
    light.dataset.state = state;
    const message =
      state === "testing"
        ? "正在测试连接"
        : state === "success"
          ? "连接成功"
          : state === "failure"
            ? plugin.syncUiStatus
            : "尚未测试连接";
    light.setAttribute("aria-label", message);
    light.title = message;
    status.hidden =
      plugin.nativeMaintenance ||
      plugin.syncUiStatus === connectionMessage ||
      /连接|账号|目录权限|服务器地址|测试文件夹/.test(plugin.syncUiStatus);
    target.textContent = `完整路径：${webdavTarget(plugin.settings, plugin.app.vault.getName())}`;
    if (historyActive) {
      if (busy) renderHistory();
      else void loadHistory();
    }
  }
  sync.onclick = async () => {
    try {
      await persist();
      await plugin.syncRun("manual");
    } catch {
      status.textContent = "同步未完成，请重试";
    }
    update();
  };
  for (const control of [service, autos, interval, conflicts]) {
    const handler = control.onchange;
    control.onchange = (event) => {
      void Promise.resolve(handler?.call(control, event)).catch(() => {
        status.textContent = "设置保存失败，请重试";
      });
    };
  }
  const unsubscribe = plugin.onSyncUiUpdate(update);
  selectTab(0);
  update();
  return () => {
    disposed = true;
    generation++;
    unsubscribe();
    if (timer) void persist().catch(() => {});
  };
}
