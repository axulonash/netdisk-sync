import type { SUPPORTED_SERVICES_TYPE } from "./baseTypes";

export const DEFAULT_SERVICE_TYPE: SUPPORTED_SERVICES_TYPE = "webdav";

// Keep legacy configurations reachable; native Baidu sync is desktop-only.
export const getServiceChoices = (
  current: SUPPORTED_SERVICES_TYPE,
  legacy?: SUPPORTED_SERVICES_TYPE,
  desktop = false
): SUPPORTED_SERVICES_TYPE[] => {
  const targets: SUPPORTED_SERVICES_TYPE[] = desktop
    ? ["webdav", "baidu", "quark", "aliyun"]
    : ["webdav"];
  const retained =
    !["webdav", "baidu", "quark", "aliyun"].includes(current) ? current : legacy;
  if (retained && !targets.includes(retained)) targets.push(retained);
  if (["baidu", "quark", "aliyun"].includes(current) && !targets.includes(current)) targets.push(current);
  return targets;
};

export const createSettingsSection = (
  parent: HTMLElement,
  title: string
): HTMLDivElement => {
  const details = parent.ownerDocument.createElement("details");
  details.className = "remotely-save-next-settings-section";
  const summary = parent.ownerDocument.createElement("summary");
  summary.textContent = title;
  const content = parent.ownerDocument.createElement("div");
  details.append(summary, content);
  parent.append(details);
  return content;
};
