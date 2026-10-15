import cloneDeep from "lodash/cloneDeep";
import type { RemotelySavePluginSettings } from "./baseTypes";
import { SyncScopeError } from "./syncProtection";
/** Persist refreshed legacy PRO credentials without replacing concurrent user edits. */
export function createSnapshotSaver(
  snapshot: RemotelySavePluginSettings,
  current: () => RemotelySavePluginSettings,
  persist: () => Promise<void>
) {
  let expected = JSON.stringify(snapshot.pro);
  return async () => {
    const refreshed = JSON.stringify(snapshot.pro);
    if (refreshed !== expected) {
      if (JSON.stringify(current().pro) !== expected)
        throw new SyncScopeError();
      current().pro = cloneDeep(snapshot.pro);
      expected = refreshed;
    }
    await persist();
  };
}
