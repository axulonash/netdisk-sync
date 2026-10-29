import type { SUPPORTED_SERVICES_TYPE } from "./baseTypes";

export const DEFAULT_SERVICE_TYPE: SUPPORTED_SERVICES_TYPE = "webdav";

export const createSettingsSection = (
  parent: HTMLElement,
  title: string
): HTMLDivElement => {
  const details = parent.ownerDocument.createElement("details");
  details.className = "netdisk-sync-settings-section";
  const summary = parent.ownerDocument.createElement("summary");
  summary.textContent = title;
  const content = parent.ownerDocument.createElement("div");
  details.append(summary, content);
  parent.append(details);
  return content;
};
