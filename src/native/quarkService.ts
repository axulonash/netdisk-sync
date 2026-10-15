import { Platform } from "obsidian";
import type RemotelySavePlugin from "../main";
import type { RemotelySavePluginSettings } from "../baseTypes";
import { FakeFsQuark } from "../fsQuark";
import { getQuarkProfileId } from "./quarkAuth";
import { QuarkClient } from "./quarkClient";
import { createDesktopQuarkTransport, QuarkError, type QuarkTransport } from "./quarkTransport";
export function createQuarkSyncClient(getSettings: () => RemotelySavePluginSettings, transport: QuarkTransport) {
  const current = getSettings();
  const profile = getQuarkProfileId(current.quarkNative, current.password ?? "", current.encryptionMethod ?? "unknown");
  const guard = () => {
    const settings = getSettings();
    if (settings.serviceType !== "quark" || profile !== getQuarkProfileId(settings.quarkNative,
      settings.password ?? "", settings.encryptionMethod ?? "unknown")) throw new QuarkError("sync_scope_changed");
  };
  guard();
  return new FakeFsQuark(new QuarkClient(transport, () => getSettings().quarkNative, guard));
}
export function getQuarkPluginTransport(plugin: RemotelySavePlugin): QuarkTransport {
  return plugin.quarkTransport ??= async request=>{const control=plugin.syncControl;await control?.checkpoint();return createDesktopQuarkTransport(Platform.isDesktopApp)({...request,signal:control?.signal});};
}
