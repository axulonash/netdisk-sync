import type { SUPPORTED_SERVICES_TYPE } from "./baseTypes";
import { getServiceChoices } from "./settingsLayout";
export type ServicePicker = HTMLFieldSetElement & { value: string };
export function createServicePicker(
  doc: Document,
  current: SUPPORTED_SERVICES_TYPE,
  legacy?: SUPPORTED_SERVICES_TYPE
): ServicePicker {
  const group = doc.createElement("fieldset") as ServicePicker;
  group.className = "rsnext-service-picker";
  const legend = doc.createElement("legend");
  legend.textContent = "同步服务";
  group.append(legend);
  const name = `rsnext-service-${Math.random().toString(36).slice(2)}`;
  for (const value of getServiceChoices(current, legacy, true)) {
    const label = doc.createElement("label"),
      input = doc.createElement("input"),
      text = doc.createElement("span");
    input.type = "radio";
    input.name = name;
    input.value = value;
    input.checked = value === current;
    text.textContent =
      (
        { webdav: "WebDAV", baidu: "百度网盘", quark: "夸克网盘", aliyun: "阿里云盘" } as Record<
          string,
          string
        >
      )[value] ?? `${value}（原有配置）`;
    label.append(input, text);
    group.append(label);
  }
  Object.defineProperty(group, "value", {
    get: () =>
      group.querySelector<HTMLInputElement>("input:checked")?.value ?? current,
  });
  return group;
}
