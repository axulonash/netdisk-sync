import type RemotelySavePlugin from "./main";
import type { SyncActivity } from "./syncActivity";
import { appendProgressResult } from "./syncProgressUi";

export interface RecordsHandle {
  refresh(): void;
  cleanup(): void;
}

const STATUS_LABELS: Record<SyncActivity["status"], string> = {
  running: "同步中",
  success: "已完成",
  unchanged: "没有变化",
  partial: "部分完成",
  failed: "失败",
  paused: "已暂停",
  cancelled: "已停止",
};

const TRIGGER_LABELS: Record<string, string> = {
  manual: "手动同步",
  auto: "定时同步",
  auto_sync_on_save: "保存时同步",
  auto_once_init: "启动时同步",
};

/**
 * Shared sync-records list, extracted from the WebDAV simple settings renderHistory.
 * Records are re-read with refresh(); the section subscribes to sync UI updates and
 * refreshes once a run leaves the running state, so progress ticks do not re-fetch.
 * Detail/diagnostic rendering stays per-record via appendProgressResult, matching the
 * existing WebDAV behaviour.
 */
export function createRecordsSection(
  sectionEl: HTMLElement,
  plugin: RemotelySavePlugin
): RecordsHandle {
  const doc = sectionEl.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    cls = ""
  ) => {
    const node = doc.createElement(tag);
    node.textContent = text;
    node.className = cls;
    return node;
  };
  let disposed = false;
  let limit = 20;
  let generation = 0;
  let records: SyncActivity[] = [];

  const render = () => {
    const open = new Set(
      Array.from(sectionEl.querySelectorAll("details[open]")).map(
        (n) => (n as HTMLElement).dataset.id
      )
    );
    sectionEl.replaceChildren();
    sectionEl.append(
      el("p", "仅记录同步时间、统计和文件路径；最近 100 次。", "rsnext-hint")
    );
    const active = plugin.syncUiActivity;
    const all =
      active?.status === "running"
        ? [active, ...records.filter((r) => r.id !== active.id)]
        : records;
    if (!all.length) sectionEl.append(el("p", "还没有同步记录"));
    for (const record of all.slice(0, limit)) {
      const item = el("details", "", "rsnext-record");
      item.dataset.id = record.id;
      item.open = open.has(record.id);
      item.append(
        el(
          "summary",
          `${new Date(record.startedAt).toLocaleString()} · ${STATUS_LABELS[record.status]} · 上传 ${record.counts.upload} / 下载 ${record.counts.download} / 删除 ${record.counts.delete}`
        )
      );
      item.append(
        el(
          "small",
          `${TRIGGER_LABELS[record.trigger] ?? "自动同步"} · ${record.endedAt ? `耗时 ${Math.max(0, (record.endedAt - record.startedAt) / 1000).toFixed(1)} 秒` : "正在执行"}`
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
      sectionEl.append(item);
    }
    if (all.length > limit) {
      const more = el("button", "加载更多记录");
      more.onclick = () => {
        limit += 20;
        render();
      };
      sectionEl.append(more);
    }
  };

  const refresh = () => {
    const ticket = ++generation;
    void Promise.resolve(plugin.getSyncActivities())
      .then((next) => {
        if (disposed || ticket !== generation) return;
        records = next;
        render();
      })
      .catch(() => {
        if (!disposed) sectionEl.textContent = "同步记录读取失败，请稍后重试";
      });
  };

  const unsubscribe = plugin.onSyncUiUpdate(() => {
    if (disposed || plugin.syncUiActivity?.status === "running") return;
    refresh();
  });
  refresh();

  return {
    refresh,
    cleanup: () => {
      disposed = true;
      generation++;
      unsubscribe();
      sectionEl.replaceChildren();
    },
  };
}
