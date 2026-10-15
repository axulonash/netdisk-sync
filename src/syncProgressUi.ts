import type { SyncActivity } from "./syncActivity";
import type { SyncProgressSnapshot } from "./syncProgress";

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
  ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function progressStatus(p: SyncProgressSnapshot): string {
  if (p.phase === "remote" || p.phase === "local") {
    const side = p.phase === "remote" ? "remote" : "local";
    return `正在扫描${side === "remote" ? "网盘" : "本地"} · 已发现 ${p.scanned[side].files} 个文件、${p.scanned[side].folders} 个文件夹`;
  }
  if (p.phase === "planning") return "正在计算需要同步的文件…";
  if (p.phase === "ready") return p.plan?.total ? `扫描完成 · 待处理 ${p.plan.total} 项${p.skipped?` · 跳过空文件 ${p.skipped}`:""}` : p.skipped?`扫描完成 · 跳过空文件 ${p.skipped}`:"扫描完成 · 没有变化";
  if (p.phase === "syncing") return `正在同步 · 已完成 ${p.completed} / ${p.plan?.total ?? 0} 项${p.failed ? ` · 失败 ${p.failed}` : ""}${p.skipped?` · 跳过空文件 ${p.skipped}`:""}`;
  return `成功 ${p.completed} · 失败 ${p.failed} · 未执行 ${p.unexecuted}${p.skipped?` · 跳过空文件 ${p.skipped}`:""}`;
}

export function createSyncProgress(status: HTMLElement, getActivity: () => SyncActivity | undefined) {
  const doc = status.ownerDocument;
  const root = doc.createElement("div");
  root.className = "rsnext-sync-progress";
  const meter = doc.createElement("progress");
  meter.setAttribute("aria-label", "已确认完成的同步任务");
  const summary = doc.createElement("p"), details = doc.createElement("p"), current = doc.createElement("p");
  const speed=doc.createElement("p");
  speed.className="rsnext-transfer-speed";
  speed.setAttribute("aria-label","传输速度");
  root.append(meter, speed, summary, details, current);
  status.after(root);
  const update = () => {
    const p = getActivity()?.progress;
    root.hidden = !p;
    if (!p) return;
    speed.hidden=p.phase!=="syncing"||!p.speed;
    speed.textContent=p.speed?`↑ 上传 ${size(Math.round(p.speed.upload))}/s · ↓ 下载 ${size(Math.round(p.speed.download))}/s`:"";
    summary.textContent = progressStatus(p);
    summary.hidden = status.textContent === summary.textContent;
    if (!p.plan) {
      meter.removeAttribute("value");
      meter.removeAttribute("max");
      details.textContent = p.phase === "finished" ? "扫描未完成，尚未开始同步" : "扫描完成后自动开始同步";
      meter.hidden = p.phase === "finished";
    } else {
      meter.hidden = false;
      meter.max = Math.max(1, p.plan.total);
      meter.value = p.plan.total === 0 && p.phase === "finished" ? 1 : p.completed;
      details.textContent = `上传 ${p.plan.upload} · 下载 ${p.plan.download} · 删除 ${p.plan.delete} · 创建文件夹 ${p.plan.createFolder} · 冲突 ${p.plan.conflicts}` +
        `；已完成约 ${size(p.completedBytes)} / 预计 ${size(p.plan.bytes)}` +
        (p.plan.unknownSizes ? `，另 ${p.plan.unknownSizes} 项大小待确认` : "");
    }
    current.textContent = p.currentPath ? `当前：${p.currentPath}` : "";
    current.hidden = !p.currentPath;
  };
  update();
  return update;
}

export function appendProgressResult(parent: HTMLElement, record: SyncActivity) {
  const p = record.progress;
  if (!p) return;
  const doc = parent.ownerDocument;
  if (p.plan) {
    const summary = doc.createElement("p");
    summary.className = "rsnext-progress-result";
    summary.textContent = progressStatus({...p, phase: "finished"});
    parent.append(summary);
  }
  const details = doc.createElement("details"), label = doc.createElement("summary"), body = doc.createElement("pre");
  label.textContent = "诊断摘要";
  body.textContent = JSON.stringify(syncDiagnostic(record), null, 2);
  details.className = "rsnext-diagnostic";
  details.append(label, body);
  parent.append(details);
}

export function syncDiagnostic(record: SyncActivity) {
  const p = record.progress, d = record.diagnostics?.webdav;
  return {
    startedAt: record.startedAt, endedAt: record.endedAt, status: record.status,
    counts: {...record.counts}, plan: p?.plan ? {...p.plan} : undefined,
    completed: p?.completed, failed: p?.failed, skipped:p?.skipped, unexecuted: p?.unexecuted,
    failures: p?.failures?.map(f=>({...f})),
    failurePhase: p?.failurePhase, timingsMs: p ? {...p.timings} : undefined,
    webdav: d ? {readRequests: d.requests, retries: d.retries, requestTimeMs: d.elapsedMs,
      operations: {...d.operations}, lastFailure: d.lastFailure ? {...d.lastFailure} : undefined} : undefined,
  };
}
