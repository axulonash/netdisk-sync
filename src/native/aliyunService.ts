import { Platform } from "obsidian";
import type RemotelySavePlugin from "../main";
import type { RemotelySavePluginSettings } from "../baseTypes";
import { FakeFsAliyun } from "../fsAliyun";
import { getAliyunProfileId, type AliyunSession } from "./aliyunAuth";
import { AliyunClient } from "./aliyunClient";
import {
  AliyunError,
  createDesktopAliyunTransport,
  type AliyunTransport,
} from "./aliyunTransport";
export function createAliyunSyncClient(
  getSettings: () => RemotelySavePluginSettings,
  transport: AliyunTransport,
  persist: () => Promise<any>
) {
  const current = getSettings(),
    profile = getAliyunProfileId(
      current.aliyunNative,
      current.password ?? "",
      current.encryptionMethod ?? "unknown"
    );
  const guard = () => {
    const settings = getSettings();
    if (
      settings.serviceType !== "aliyun" ||
      profile !==
        getAliyunProfileId(
          settings.aliyunNative,
          settings.password ?? "",
          settings.encryptionMethod ?? "unknown"
        )
    )
      throw new AliyunError("sync_scope_changed");
  };
  guard();
  const save = async (session: AliyunSession) => {
    guard();
    const settings = getSettings(),
      previous = settings.aliyunNative;
    const next = { ...previous, session };
    settings.aliyunNative = next;
    try {
      await persist();
    } catch (error) {
      if (settings.aliyunNative === next) settings.aliyunNative = previous;
      throw error;
    }
  };
  return new FakeFsAliyun(
    new AliyunClient(transport, () => getSettings().aliyunNative, guard, save)
  );
}
export function getAliyunPluginTransport(
  plugin: RemotelySavePlugin
): AliyunTransport {
  return (plugin.aliyunTransport ??= async request=>{const control=plugin.syncControl;await control?.checkpoint();return createDesktopAliyunTransport(Platform.isDesktopApp)({...request,signal:control?.signal});});
}
