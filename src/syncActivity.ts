import { resolveWebdavDirectory } from "./webdavDirectory";
import { syncFailureDiagnostic } from "./syncProgress";
import { isSyncCancelled } from "./syncControl";
import { createHash } from "crypto";
import { nanoid } from "nanoid";
import type { Entity, RemotelySavePluginSettings } from "./baseTypes";
import type { SyncPlanSummary, SyncProgressSnapshot, SyncTaskEvent } from "./syncProgress";
export type ActivityAction = "upload" | "download" | "delete";
export interface SyncActivity {
  id: string;
  profile: string;
  startedAt: number;
  endedAt?: number;
  trigger: string;
  status: "running" | "success" | "unchanged" | "partial" | "failed" | "paused" | "cancelled";
  counts: Record<ActivityAction, number>;
  files: Record<ActivityAction, string[]>;
  failedPaths: string[];
  skippedPaths?: string[];
  error?: string;
  progress?: SyncProgressSnapshot;
  diagnostics?: { webdav?: import("./webdavRetry").WebdavDiagnostics };
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const webdavScope = (
  settings: RemotelySavePluginSettings,
  vault: string
) =>
  digest([
    settings.webdav.address,
    settings.webdav.username,
    settings.webdav.password,
    resolveWebdavDirectory(settings.webdav, vault),
    settings.password || "",
    settings.password ? settings.encryptionMethod : "none",
  ]);
export const syncSettingsFingerprint = (
  settings: RemotelySavePluginSettings,
  vault: string
) =>
  digest([
    settings.serviceType,
    webdavScope(settings, vault),
    settings.webdav,
    settings.conflictAction,
    settings.syncDirection,
    settings.ignorePaths,
    settings.onlyAllowPaths,
    settings.syncConfigDir,
    settings.syncBookmarks,
    settings.syncUnderscoreItems,
    settings.skipSizeLargerThan,
    settings.howToCleanEmptyFolder,
    settings.protectModifyPercentage,
  ]);
export const entityFingerprint = (entries: Entity[]) =>
  digest(
    entries
      .map((e) => [e.key, e.keyRaw, e.size, e.sizeRaw, e.mtimeCli, e.mtimeSvr, e.etag])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  );
export function webdavTarget(
  settings: RemotelySavePluginSettings,
  vault: string
) {
  try {
    const url = new URL(settings.webdav.address);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname =
      url.pathname.replace(/\/+$/, "") +
      "/" +
      (resolveWebdavDirectory(settings.webdav, vault))
        .split("/")
        .map(encodeURIComponent)
        .join("/") +
      "/";
    return decodeURI(url.href);
  } catch {
    return "";
  }
}
function httpSyncHint(status:number,provider:string):string|undefined {
 if(status===401)return `${provider}账号或密码未通过认证，请检查登录信息并重新测试连接`;
 if(status===403)return `${provider}拒绝访问，请检查同步目录的读写权限后重试`;
 if(status===404)return `${provider}地址、文件或同步目录不存在，请检查路径后重新测试连接`;
 if(status===429)return `${provider}请求过于频繁，请稍后重新同步`;
 if(status>=500&&status<=599)return `${provider}服务暂时不可用，请稍后重试`;
}
export function safeSyncError(error: any): string {
  if (isSyncCancelled(error)) return "同步已停止，已完成的文件保留";
  let first = error;
  const visited = new Set<unknown>();
  for (let depth = 0; first && depth < 12 && !visited.has(first); depth++) {
    visited.add(first);
    const next = first?.errors?.[0] ?? first?.cause;
    if (!next) break;
    first = next;
  }
  if (first?.code === "empty_file_unsupported")
    return "当前百度同步不支持未加密的空文件，请写入内容后重试";
  if (first?.code === "upload_too_large")
    return "文件超过当前百度同步的 64 MiB 上传限制，请缩小文件后重试";
  if(first?.name==='BaiduWebProbeError'){
    const reasons:Record<string,string>={interrupted_replacement:'百度文件替换未完成，已保留恢复文件；请查看同步记录定位文件，核对网盘中的备份内容后再重试',plan_changed:'网盘文件在扫描后发生变化，请重新同步',login_required:'百度登录已失效，请重新扫码',request_timeout:'百度连接超时，请检查网络后重试',sync_scope_changed:'同步设置已变化，请重新准备文件夹',upload_not_confirmed:'上传结果未通过完整性校验，请检查网络及网盘中的目标文件后重新同步','api_errno_-6':'百度登录已失效，请重新扫码'};
    const code=typeof first.code==='string'&&/^[a-z0-9_-]{1,80}$/.test(first.code)?first.code:'operation_failed';
    const api=['list','precreate','create','filemanager','filemetas','gettemplatevariable'].includes(first.apiName)?` · ${first.apiName}`:'';
    const operation=['rename','delete'].includes(first.apiOperation)?` · ${first.apiOperation}`:'';
    const item=Number.isSafeInteger(first.itemErrno)&&Math.abs(first.itemErrno)<100000000?` · item_errno_${first.itemErrno}`:'';
    const http=/^(?:download_)?http_(\d{3})$/.exec(code);
    let hint=reasons[code]??(http?httpSyncHint(Number(http[1]),'百度网盘'):undefined);
    if(first.itemErrno===-7){
      hint=first.filenameHasSupplementary===true
       ?'文件名或目录名含表情或特殊字符，百度拒绝改名；请在 Obsidian 中移除这些字符后重新同步'
       :'百度拒绝该文件名称或访问请求，请检查文件名，并确认同步目录的读写权限后重试';
    }else if(first.itemErrno===-8)hint='网盘已有同名文件，请检查并保留需要的版本，再重新同步';
    else if(first.itemErrno===-9)hint='网盘文件或目录已不存在，请刷新网盘后重新同步';
    const recovery:Record<string,string>={
      network_error:'百度网络连接中断，请检查网络后重新同步',
      incomplete_response:'百度返回的内容不完整，请检查网络后重新同步',
      account_changed:'百度账号发生变化，请重新扫码并准备同步文件夹',
      account_identity_missing:'无法确认百度账号，请重新扫码并准备同步文件夹',
      invalid_precreate:'百度返回的上传准备信息异常，请稍后重试；若仍失败，请查看同步记录中的诊断摘要',
      size_mismatch:'百度文件大小校验未通过，请检查失败文件两端的大小后重新同步',
      part_hash_mismatch:'上传分片的内容校验未通过，请检查网络后重新同步',
      rename_not_confirmed:'百度文件改名结果尚未确认，请先检查网盘中的原文件和暂存文件，再重新同步',
      directory_delete_unsupported:'当前百度同步暂不支持删除远端目录，请保留目录，或确认其内容已备份后在网盘中手动处理',
    };
    const stages:Record<string,string>={filemetas:'读取文件信息',list:'读取目录',precreate:'准备上传',create:'提交文件',filemanager:'处理文件',gettemplatevariable:'确认登录'};
    const stage=first.apiOperation==='rename'?'改名':first.apiOperation==='delete'?'删除文件':stages[first.apiName]??'处理文件';
    return `${hint??recovery[code]??`百度无法${stage}，请展开同步记录查看失败文件及诊断摘要后重试`} [${code}${api}${operation}${item}]`;
  }
  if (first?.name === "BaiduUploadError") {
    const stages: Record<string, string> = {
      input: "文件检查",
      prepare: "准备上传",
      part: "分片上传",
      commit: "提交文件",
    };
    const stage = stages[first.stage] ?? "上传";
    const errno = Number.isSafeInteger(first.errno)
      ? ` · 百度错误码 ${first.errno}`
      : "";
    const http = Number.isSafeInteger(first.status)
      ? ` · HTTP ${first.status}`
      : "";
    const reasons: Record<string, string> = {
      transport_error: "网络请求失败",
      http_error: "接口请求失败",
      platform_error: "百度接口拒绝操作",
      invalid_response: "接口响应格式异常",
      invalid_precreate: "预上传响应异常",
      part_hash_mismatch: "分片校验失败",
      invalid_commit_metadata: "提交后的文件信息校验失败",
      session_changed: "登录状态已变化",
      session_error: "登录状态不可用",
      invalid_file: "文件参数无效",
    };
    const reason = reasons[first.code] ? ` · ${reasons[first.code]}` : "";
    const unknown = first.outcomeUnknown
      ? "；结果尚未确认，请先检查网盘中的文件"
      : "";
    return `百度文件同步失败：${stage}${reason}${errno}${http}${unknown}`;
  }
  if (first?.name === "AliyunError") {
    const reasons:Record<string,string>={login_required:"阿里云盘登录已失效，请重新扫码",request_timeout:"阿里云盘连接超时，请检查网络后重试",sync_scope_changed:"同步设置已变化，请重新准备文件夹",overwrite_not_verified:"请先准备同步文件夹",upload_not_confirmed:"上传结果未通过校验，请检查网盘中的文件",empty_file_not_supported:"阿里云盘暂不支持未加密空文件，请写入内容后重试",file_too_large:"文件超过当前 64 MiB 限制",incomplete_listing:"文件列表不完整，请重试",cleanup_not_confirmed:"文件清理尚未确认，请检查网盘"};
    const http=/^http_(\d{3})$/.exec(first.code??"");
    return reasons[first.code] ?? (http ? httpSyncHint(Number(http[1]),'阿里云盘')??`阿里云盘请求失败 HTTP ${http[1]}，请查看诊断摘要后重试` : "阿里云盘同步未完成，请检查登录、网络及目录权限后重试");
  }
  if (first?.name === "QuarkError") {
    const reasons: Record<string, string> = {
      login_required: "夸克登录已失效，请重新扫码登录",
      sync_scope_changed: "同步设置已更改，请重新准备文件夹",
      request_timeout: "夸克连接超时，请检查网络后重试",
      overwrite_not_verified: "请先准备同步文件夹，完成同名覆盖验证",
      upload_not_confirmed: "夸克文件上传未确认，请先检查网盘中的文件",
      replacement_recovery_required:
        "夸克文件替换未完成，旧内容已保留，请检查 rsnext-backup- 备份文件并恢复原文件名",
      replacement_target_changed:
        "夸克网盘文件在替换期间发生变化，已停止操作，请检查后重试",
      rename_not_confirmed: "夸克文件改名结果未确认，请检查网盘中的文件",
      rename_overwrites_target: "夸克网盘未通过同名改名保护验证，已停止同步",
      part_upload_failed: "夸克文件分片上传失败，请检查网络后重试",
      upload_commit_failed: "夸克文件提交失败，请先检查网盘中的文件",
      download_limit_or_type: "文件超过当前夸克下载限制，或文件类型不符",
      empty_upload_not_supported:
        "当前夸克同步不支持未加密的空文件，请写入内容后重试",
      invalid_upload: "夸克文件超过当前上传限制，或文件参数无效",
      directory_creation_not_confirmed: "夸克未确认目录已创建，请检查同步目录中是否已有该文件夹，刷新后再重试",
      parent_not_found: "夸克未找到上级文件夹，请确认上级目录已存在后重试",
      invalid_filename: "夸克无法识别该文件或文件夹名称，请移除名称中的特殊字符后重试",
      invalid_metadata: "夸克返回的文件夹信息无效，请刷新网盘目录后重试",
      api_rejected: "夸克接口拒绝了操作，请检查登录状态、目录权限和名称后重试",
    };
    const outcome = first.outcomeUnknown ? "；操作结果未确认，请先检查网盘中是否已创建或更新，再重试" : "";
    return (
      (reasons[first.code] ?? (/^http_\d{3}$/.test(first.code??'')?httpSyncHint(Number(first.code.slice(5)),'夸克网盘'):undefined) ??
        "夸克同步未完成，请查看同步记录中的错误码并检查登录、网络及目录权限后重试") + outcome
    );
  }
  if (isSyncCancelled(first)) return "同步已停止，已完成的文件保留";
  const status = first?.status ?? first?.response?.status;
  if (
    ["ETIMEDOUT", "ECONNABORTED"].includes(first?.code) ||
    first?.name === "AbortError"
  )
    return "连接超时，请检查网络和服务器地址后重试";
  const httpHint=httpSyncHint(status,'服务器');if(httpHint)return httpHint;
  if (status === 412) return "文件在扫描后发生变化，已停止相关操作，请重新同步";
  if (first?.outcomeUnknown) return "上传结果尚未确认，请检查网盘中的文件后重试";
  if (first?.code === "sync_scope_changed")
    return "同步设置已更改，本次已停止，请重新同步";
  if (first?.code === "size_mismatch") return "读取内容与文件大小不一致，请查看诊断摘要";
  if (first?.code === "plan_changed")
    return "文件或同步设置已变化，请重新检查本次计划";
  if (first?.code === "sync_protected") return "本次大量变更已暂停，等待确认";
  return "同步未完成，请展开同步记录查看未完成的文件和诊断摘要后重试";
}
const validPath = (key: unknown): key is string =>
  typeof key === "string" &&
  !!key &&
  !key.startsWith("/") &&
  !/[\u0000-\u001f\u007f]/.test(key) &&
  !key.split("/").some((p) => p === "." || p === "..");
export class ActivityTracker {
  readonly record: SyncActivity;
  private seen = new Set<string>();
  private skippedSeen = new Set<string>();
  private settledTasks = new Set<string>();
  private activeTasks = new Set<string>();
  private phaseStartedAt = Date.now();
  constructor(
    trigger: string,
    profile: string,
    private readonly changed: () => void = () => {}
  ) {
    this.record = {
      id: nanoid(),
      profile,
      startedAt: Date.now(),
      trigger,
      status: "running",
      counts: { upload: 0, download: 0, delete: 0 },
      files: { upload: [], download: [], delete: [] },
      failedPaths: [],
      skippedPaths: [],
      progress: { phase: "remote", scanned: { remote: {files: 0, folders: 0}, local: {files: 0, folders: 0} },
        completed: 0, failed: 0, unexecuted: 0, completedBytes: 0, timings: {} },
    };
  }
  onPhase(phase: SyncProgressSnapshot["phase"]) {
    const progress = this.record.progress!;
    if (progress.phase !== phase) {
      const now = Date.now();
      progress.timings[progress.phase] = (progress.timings[progress.phase] ?? 0) + Math.max(0, now - this.phaseStartedAt);
      this.phaseStartedAt = now;
      progress.phase = phase;
    }
    this.changed();
  }
  onScan(side: "remote" | "local", files: number, folders: number) {
    this.record.progress!.scanned[side] = { files, folders };
    this.changed();
  }
  onPlan(plan: SyncPlanSummary) {
    this.record.progress!.plan = { ...plan };
    this.record.progress!.unexecuted = plan.total;
    this.onPhase("ready");
  }
  onSkipped(path:string,reason:'empty_file_unsupported') {
    if(reason!=='empty_file_unsupported'||!validPath(path))return;
    if(this.skippedSeen.has(path))return;
    this.skippedSeen.add(path);
    const paths=this.record.skippedPaths??=[];
    if(paths.length<10000)paths.push(path);
    this.record.progress!.skipped=this.skippedSeen.size;
    this.changed();
  }
  onTask(event: SyncTaskEvent) {
    if (!validPath(event.key) || this.settledTasks.has(event.key)) return;
    const progress = this.record.progress!;
    if (event.state === "started") {
      this.activeTasks.add(event.key);
      this.onPhase("syncing");
    } else {
      this.activeTasks.delete(event.key);
      this.settledTasks.add(event.key);
      if (event.state === "completed") {
        progress.completed++;
        progress.completedBytes += event.bytes;
      } else {
        progress.failed++;
        progress.failures ??= [];
        if(progress.failures.length<20)progress.failures.push(syncFailureDiagnostic(event.error,event.action));
        if (!this.record.failedPaths.includes(event.key)) this.record.failedPaths.push(event.key);
      }
    }
    progress.currentPath = [...this.activeTasks].at(-1);
    progress.unexecuted = Math.max(0, (progress.plan?.total ?? 0) - progress.completed - progress.failed);
    this.changed();
  }
  observe<T extends object>(
    fs: T,
    direction: "upload" | "download",
    guard: () => void = () => {},
    checkpoint: () => Promise<void> = async () => {}
  ): T {
    return new Proxy(fs, {
      get: (target, property) => {
        const method = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        if (
          ![
            "walk",
            "walkPartial",
            "stat",
            "statForRead",
            "validatePlan",
            "readFile",
            "writeFile",
            "mkdir",
            "rename",
            "rm",
            "isPasswordOk",
          ].includes(String(property))
        )
          return method.bind(target);
        return async (...args: any[]) => {
          await checkpoint();
          guard();
          try {
            const result = await method.apply(target, args);
            if (property === "walk" && Array.isArray(result)) {
              const files = result.filter((entry: Entity) => !(entry.key ?? entry.keyRaw).endsWith("/")).length;
              this.onScan(direction === "upload" ? "remote" : "local", files, result.length - files);
            }
            const action: ActivityAction | undefined =
              property === "writeFile"
                ? direction
                : property === "rm"
                  ? "delete"
                  : undefined;
            const key = args[0];
            if (
              action &&
              validPath(key) &&
              !key.endsWith("/") &&
              !this.seen.has(`${action}:${key}`)
            ) {
              this.seen.add(`${action}:${key}`);
              this.record.counts[action]++;
              if (this.record.files[action].length < 10000)
                this.record.files[action].push(key);
              this.changed();
            }
            if (!["writeFile", "rm", "mkdir", "rename"].includes(String(property))) guard();
            return result;
          } catch (error) {
            if (
              !isSyncCancelled(error) && ["writeFile", "rm", "rename"].includes(String(property)) &&
              validPath(args[0]) &&
              !this.record.failedPaths.includes(args[0])
            )
              this.record.failedPaths.push(args[0]);
            throw error;
          }
        };
      },
    });
  }
  finish(error?: unknown, paused = false): SyncActivity {
    const total = Math.max(this.record.progress?.completed ?? 0, Object.values(this.record.counts).reduce((a, b) => a + b, 0));
    if (error) this.record.progress!.failurePhase = this.record.progress!.phase;
    this.record.progress!.currentPath = undefined;
    this.activeTasks.clear();
    this.onPhase("finished");
    this.record.endedAt = Date.now();
    this.record.status = isSyncCancelled(error)
      ? "cancelled"
      : paused
      ? "paused"
      : error
        ? total
          ? "partial"
          : "failed"
        : (this.record.progress?.skipped??0)>0
          ? "partial"
          : total
            ? "success"
            : "unchanged";
    if (error) this.record.error = safeSyncError(error);
    else if(this.record.progress?.skipped)this.record.error=`已跳过 ${this.record.progress.skipped} 个网盘不支持的空文件，其他项目已处理。如需同步这些空文件，请先写入内容再重新同步。`;
    return this.record;
  }
}
interface ActivityTable {
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<T>;
}
const tails = new WeakMap<object, Promise<unknown>>();
const storageKey = (vault: string) => `sync-activities-v1:${vault}`;
export async function listActivities(
  table: ActivityTable,
  vault: string,
  profile?: string
): Promise<SyncActivity[]> {
  const records = await table.getItem<SyncActivity[]>(storageKey(vault));
  if (!Array.isArray(records)) return [];
  return records.filter(
    (r) => r && typeof r.id === "string" && (!profile || r.profile === profile)
  );
}
export async function saveActivity(
  table: ActivityTable,
  vault: string,
  record: SyncActivity
): Promise<void> {
  const result = (tails.get(table) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const previous = await listActivities(table, vault);
      await table.setItem(
        storageKey(vault),
        [record, ...previous.filter((r) => r.id !== record.id)].slice(0, 100)
      );
    });
  tails.set(table, result);
  await result;
}
