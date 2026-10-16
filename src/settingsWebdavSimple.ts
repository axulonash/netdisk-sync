import { resolveWebdavDirectory } from "./webdavDirectory";
import type RemotelySavePlugin from "./main";
import type { ConnectionState } from "./settingsFrame";
import { webdavScope, webdavTarget } from "./syncActivity";

/**
 * "连接" fragment for the WebDAV single page: address/账号/密码, the inline
 * remote-directory editor and the composed target path. The test-connection
 * button lives in the frame header, so the tester is handed over via ctx.setTester.
 */
export function renderWebdavConnection(
  parent: HTMLElement,
  plugin: RemotelySavePlugin,
  ctx: {
    desktop: boolean;
    redisplay: () => void;
    setStatus(s: ConnectionState, text: string): void;
    setTester(t: (() => Promise<{ ok: boolean; message: string }>) | null): void;
  }
): () => void {
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
  const root = el("div");
  parent.append(root);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = Promise.resolve();
  let testedScope: string | undefined;
  let connectionSuccess: boolean | undefined;
  let idleText = "尚未测试连接";
  const controls: (HTMLInputElement | HTMLButtonElement)[] = [];
  const id = `rsnext-webdav-${Math.random().toString(36).slice(2)}`;
  let fieldId = 0;

  const persist = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    saving = saving.catch(() => {}).then(() => plugin.saveSettings());
    return saving;
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void persist().catch(() =>
        ctx.setStatus("failure", "设置保存失败，请重试")
      );
    }, 300);
  };

  const row = (name: string, control: HTMLElement, description?: string) => {
    const box = el("div", "", "rsnext-row");
    const label = el("label", name);
    const controlId = `${id}-field${fieldId++}`;
    control.id = controlId;
    label.htmlFor = controlId;
    box.append(label, control);
    if (description) box.append(el("small", description));
    root.append(box);
  };

  const invalidate = () => {
    testedScope = undefined;
    connectionSuccess = undefined;
    idleText = "连接信息已更改，请重新测试";
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
    const input = doc.createElement("input");
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
    if (key === "password") {
      const field = el("div", "", "rsnext-password-control");
      input.replaceWith(field);
      const show = el("button", "", "rsnext-password-toggle");
      show.type = "button";
      show.setAttribute("aria-controls", input.id);
      const drawIcon = (visible: boolean) => {
        const aria = visible ? "隐藏密码" : "显示密码";
        show.setAttribute("aria-label", aria);
        show.title = aria;
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
      root.append(el("hr", "", "rsnext-connection-divider"));
    }
  }

  const directory = doc.createElement("input");
  directory.type = "text";
  const existingDirectory = (
    plugin.settings.webdav.remoteBaseDir || plugin.app.vault.getName()
  ).replace(/^\/+|\/+$/g, "");
  directory.value =
    "/" +
    (plugin.settings.webdav.parentDir ??
      existingDirectory.split("/").slice(0, -1).join("/"));
  directory.placeholder = "/home/Drive";
  directory.spellcheck = false;
  controls.push(directory);
  row(
    "同步目录",
    directory,
    `自动追加当前笔记本名称：${plugin.app.vault.getName()}`
  );
  const target = el("p", "", "rsnext-target");
  root.append(target);
  directory.oninput = () => {
    plugin.settings.webdav.parentDir = directory.value
      .trim()
      .replace(/^\/+|\/+$/g, "");
    plugin.settings.webdav.remoteBaseDir = resolveWebdavDirectory(
      plugin.settings.webdav,
      plugin.app.vault.getName()
    );
    invalidate();
  };

  ctx.setTester(async () => {
    try {
      await persist();
      testedScope = webdavScope(plugin.settings, plugin.app.vault.getName());
      connectionSuccess = await plugin.testWebdavConnection();
    } catch {
      connectionSuccess = false;
      plugin.syncUiStatus = "设置保存失败，请重试";
    }
    update();
    return { ok: connectionSuccess === true, message: plugin.syncUiStatus };
  });

  function update() {
    if (disposed) return;
    const busy = plugin.isSyncing || plugin.nativeMaintenance;
    for (const control of controls) control.disabled = busy;
    const scope = webdavScope(plugin.settings, plugin.app.vault.getName());
    const result =
      testedScope === scope
        ? connectionSuccess
        : !plugin.settings.webdavNeedsValidation &&
            plugin.settings.webdavVerifiedConfig === scope
          ? true
          : undefined;
    const state: ConnectionState = plugin.nativeMaintenance
      ? "testing"
      : result === true
        ? "success"
        : result === false
          ? "failure"
          : "idle";
    const message =
      state === "testing"
        ? "正在测试连接"
        : state === "success"
          ? "连接成功"
          : state === "failure"
            ? plugin.syncUiStatus
            : idleText;
    ctx.setStatus(state, message);
    target.textContent = `完整路径：${webdavTarget(
      plugin.settings,
      plugin.app.vault.getName()
    )}`;
  }

  const unsubscribe = plugin.onSyncUiUpdate(update);
  update();
  return () => {
    disposed = true;
    unsubscribe();
    ctx.setTester(null);
    if (timer) void persist().catch(() => {});
    root.remove();
  };
}
