import type { SUPPORTED_SERVICES_TYPE } from "./baseTypes";
import { createSettingsSection } from "./settingsLayout";
import type RemotelySavePlugin from "./main";

export type ConnectionState = "idle" | "testing" | "success" | "failure";

export interface SettingsFrame {
  sections: Record<
    "connection" | "basic" | "advanced" | "records",
    HTMLDivElement
  >;
  progressHost: HTMLElement;
  setStatus(state: ConnectionState, text: string): void;
  setTester(
    t: (() => Promise<{ ok: boolean; message: string }>) | null
  ): void;
  onServiceChange(cb: (s: SUPPORTED_SERVICES_TYPE) => void): void;
  cleanup(): void;
}

const SERVICE_LABELS: Record<string, string> = {
  webdav: "WebDAV",
  baidu: "百度网盘",
  quark: "夸克网盘",
  aliyun: "阿里云盘",
};

/** Single-page native settings frame: header, status, test button, four sections. */
export function createSettingsFrame(
  containerEl: HTMLElement,
  plugin: RemotelySavePlugin,
  opts: {
    desktop: boolean;
    unsupported: boolean;
    onServiceChange: (s: SUPPORTED_SERVICES_TYPE) => void;
  }
): SettingsFrame {
  const doc = containerEl.ownerDocument;
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
  containerEl.replaceChildren(root);

  const header = el("div", "", "rsnext-header");
  const select = el("select");
  select.setAttribute("aria-label", "同步服务");
  if (opts.unsupported) {
    const placeholder = el("option", "请选择服务");
    placeholder.value = "";
    select.append(placeholder);
  }
  for (const value of opts.desktop
    ? (["webdav", "baidu", "quark", "aliyun"] as const)
    : (["webdav"] as const)) {
    const option = el("option", SERVICE_LABELS[value] ?? value);
    option.value = value;
    select.append(option);
  }
  select.value = opts.unsupported ? "" : plugin.settings.serviceType;

  const light = el("span", "", "rsnext-connection-light");
  light.setAttribute("role", "status");
  light.setAttribute("aria-live", "polite");
  const statusText = el("span", "", "rsnext-connection-text");
  const test = el("button", "测试连接");
  test.type = "button";
  test.hidden = true;
  header.append(select, light, statusText, test);
  root.append(header);

  if (opts.unsupported) {
    const warning = el(
      "p",
      "当前配置的服务已不再支持，请重新选择服务",
      "rsnext-service-warning"
    );
    warning.setAttribute("role", "alert");
    root.append(warning);
  }
  const progressHost = el("div");
  root.append(progressHost);

  const sections = {
    connection: createSettingsSection(root, "连接"),
    basic: createSettingsSection(root, "基本"),
    advanced: createSettingsSection(root, "高级"),
    records: createSettingsSection(root, "同步记录"),
  };

  let disposed = false;
  let tester: (() => Promise<{ ok: boolean; message: string }>) | null = null;
  const listeners: ((s: SUPPORTED_SERVICES_TYPE) => void)[] = [
    opts.onServiceChange,
  ];

  const setStatus = (state: ConnectionState, text: string) => {
    light.dataset.state = state;
    statusText.textContent = text;
    light.setAttribute("aria-label", text);
    light.title = text;
  };

  select.onchange = () => {
    if (disposed) return;
    const value = select.value as SUPPORTED_SERVICES_TYPE;
    for (const cb of listeners) cb(value);
  };

  test.onclick = async () => {
    if (disposed || !tester) return;
    test.disabled = true;
    setStatus("testing", "正在测试连接…");
    let result: { ok: boolean; message: string };
    try {
      result = await tester();
    } catch {
      result = { ok: false, message: "测试连接失败，请重试" };
    }
    if (disposed) return;
    test.disabled = false;
    setStatus(result.ok ? "success" : "failure", result.message);
  };

  setStatus("idle", "");
  return {
    sections,
    progressHost,
    setStatus,
    setTester: (t) => {
      tester = t;
      test.hidden = !t;
    },
    onServiceChange: (cb) => {
      listeners.push(cb);
    },
    cleanup: () => {
      disposed = true;
      tester = null;
      listeners.length = 0;
      containerEl.replaceChildren();
    },
  };
}
