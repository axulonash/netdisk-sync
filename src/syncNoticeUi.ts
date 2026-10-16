import type RemotelySavePlugin from "./main";
import type { SyncActivity } from "./syncActivity";
import { progressStatus } from "./syncProgressUi";

const VISIBLE_TRIGGERS = new Set(["manual", "dry"]);
const TERMINAL_STATUS = new Set(["success", "failed", "paused", "cancelled"]);
const RESULT_TEXT: Record<string, string> = {
  success: "同步完成",
  failed: "同步失败",
  paused: "同步已暂停",
  cancelled: "同步已停止",
  partial: "部分同步完成",
  unchanged: "同步完成",
};

export function createSyncNotice(
  plugin: RemotelySavePlugin,
  opts?: { dismissMs?: number }
): { destroy(): void } {
  const dismissMs = opts?.dismissMs ?? 4000;
  let element: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  // Stale terminal activity stays on the plugin until the next sync, so remember
  // which one was already shown and dismissed to avoid re-popping on unrelated UI updates.
  let dismissedActivity: SyncActivity | undefined;

  const remove = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    element?.remove();
    element = null;
  };

  const render = () => {
    if (destroyed) return;
    const activity = plugin.syncUiActivity;
    const progress = activity?.progress;
    if (!activity || !progress || !VISIBLE_TRIGGERS.has(activity.trigger)) return;
    if (activity === dismissedActivity) return;
    if (!element) {
      element = document.createElement("div");
      element.className = "rsnext-sync-notice";
      document.body.appendChild(element);
    }
    if (progress.phase === "finished" || TERMINAL_STATUS.has(activity.status)) {
      dismissedActivity = activity;
      element.textContent = RESULT_TEXT[activity.status] ?? "同步完成";
      if (timer === undefined) timer = setTimeout(remove, dismissMs);
      return;
    }
    dismissedActivity = undefined;
    const label = document.createElement("div");
    label.textContent = progressStatus(progress);
    const meter = document.createElement("progress");
    meter.max = Math.max(1, progress.plan?.total ?? 0);
    meter.value = progress.completed;
    element.replaceChildren(label, meter);
  };

  const unsubscribe = plugin.onSyncUiUpdate(render);
  return {
    destroy() {
      destroyed = true;
      unsubscribe();
      remove();
    },
  };
}
