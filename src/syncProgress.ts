import type { MixedEntity } from "./baseTypes";

export interface SyncPlanSummary {
  total: number;
  upload: number;
  download: number;
  delete: number;
  createFolder: number;
  conflicts: number;
  bytes: number;
  unknownSizes: number;
}
export interface SyncTask {
  key: string;
  action: "upload" | "download" | "delete" | "createFolder" | "conflict";
  bytes: number;
  unknownSize: boolean;
}
export interface SyncTaskEvent extends SyncTask {
  state: "started" | "completed" | "failed";
  error?: unknown;
}
export interface SyncProgressSnapshot {
  phase: "remote" | "local" | "planning" | "ready" | "syncing" | "finished";
  scanned: Record<"remote" | "local", { files: number; folders: number }>;
  plan?: SyncPlanSummary;
  completed: number;
  failed: number;
  skipped?: number;
  unexecuted: number;
  completedBytes: number;
  currentPath?: string;
  speed?: {upload:number;download:number};
  timings: Partial<Record<SyncProgressSnapshot["phase"], number>>;
  failurePhase?: SyncProgressSnapshot["phase"];
  failures?: SyncFailureDiagnostic[];
}

// One task is one engine operation. A conflict can involve more than one
// transfer; its total bytes are an estimate until the operation is resolved.
export function getSyncTask(entry: MixedEntity): SyncTask | undefined {
  const decision = entry.decision ?? "";
  if (entry.key === "/$@meta" ||
      ["equal", "only_history", "folder_to_skip", "folder_existed_both_then_do_nothing", "unsupported_empty_then_skip",
       "conflict_created_then_do_nothing", "local_is_created_too_large_then_do_nothing",
       "remote_is_created_too_large_then_do_nothing"].includes(decision)) return;
  let action: SyncTask["action"];
  let sizes: (number | undefined)[] = [];
  if (decision.includes("deleted")) action = "delete";
  else if (entry.key.endsWith("/")) action = "createFolder";
  else if (decision.endsWith("smart_conflict")) {
    action = "conflict";
    sizes = [entry.local?.size, entry.remote?.size ?? entry.remote?.sizeRaw];
  } else if (decision.endsWith("push") || decision.endsWith("keep_local")) {
    action = "upload"; sizes = [entry.local?.size];
  } else if (decision.endsWith("pull") || decision.endsWith("keep_remote")) {
    action = "download"; sizes = [entry.remote?.size ?? entry.remote?.sizeRaw];
  } else return;
  const valid = (size: number | undefined): size is number =>
    size !== undefined && Number.isSafeInteger(size) && size >= 0;
  return { key: entry.key, action, bytes: sizes.filter(valid).reduce((a,b)=>a+b,0),
    unknownSize: sizes.some(size => !valid(size)) };
}

/** Preserve plaintext empty files when the selected provider cannot upload them. */
export function skipUnsupportedEmptyUploads(
  plan: Record<string, MixedEntity>,
  encrypted: boolean
): string[] {
  if (encrypted) return [];
  const skipped: string[] = [];
  for (const entry of Object.values(plan)) {
    const task = getSyncTask(entry);
    if (task && ["upload", "conflict"].includes(task.action) && entry.local?.size === 0) {
      entry.decision = "unsupported_empty_then_skip";
      skipped.push(entry.key);
    }
  }
  return skipped.sort();
}

export function summarizeSyncPlan(entries: Record<string, MixedEntity>): SyncPlanSummary {
  const result: SyncPlanSummary = { total: 0, upload: 0, download: 0, delete: 0,
    createFolder: 0, conflicts: 0, bytes: 0, unknownSizes: 0 };
  for (const entry of Object.values(entries)) {
    const task = getSyncTask(entry);
    if (!task) continue;
    result.total++;
    if (task.action !== "conflict") result[task.action]++;
    if (entry.decision?.startsWith("conflict")) result.conflicts++;
    result.bytes += task.bytes;
    if (task.unknownSize) result.unknownSizes++;
  }
  return result;
}

export interface SyncFailureDiagnostic {
 action: SyncTask["action"];
 providerCode?:string;
 providerStage?:"upload_prepare" | "upload_hash" | "upload_authorize" | "upload_part" | "upload_commit" | "upload_finish" | "upload_confirm" | "download_authorize" | "download_transfer" | "download_redirect" | "upload_confirm_authorize" | "upload_confirm_transfer" | "upload_confirm_redirect";
 outcomeUnknown?:boolean;
 apiName?:string;
 apiOperation?:'rename'|'delete';
 itemErrno?:number;
 operationStage?:'verify_upload';
 reason: "local_changed" | "remote_changed" | "size_mismatch" | "http_error" | "network_error" | "provider_error" | "unknown";
 httpStatus?: number;
 networkCode?: "ETIMEDOUT" | "ECONNRESET" | "ECONNABORTED";
 transfer?: {phase:string;bodyBytes:number;bodyFlushed:boolean;responseBytes?:number;elapsedMs:number;timeout?:"idle"|"response"|"total"};
 expectedBytes?: number;
 actualBytes?: number;
}
export function syncFailureDiagnostic(error: any, action: SyncTask["action"]): SyncFailureDiagnostic {
 let cause=error;let transfer:any;const seen=new Set<unknown>();
 while(cause && !seen.has(cause) && seen.size<12) {
  transfer ??= cause.transfer;
  seen.add(cause);const next=cause.cause ?? cause.errors?.[0];if(!next)break;cause=next;
 }
 const encodedHttp=/^(?:download_)?http_(\d{3})$/.exec(cause?.code??'');
 const status=cause?.status ?? cause?.response?.status ?? (encodedHttp?Number(encodedHttp[1]):undefined);
 const validStatus=Number.isInteger(status)&&status>=100&&status<=599;
 const reason:SyncFailureDiagnostic["reason"]=cause?.code==='size_mismatch'?'size_mismatch':
  cause?.code==='plan_changed'?(/^Local /i.test(cause.message??'')?'local_changed':'remote_changed'):
  status===412?'remote_changed':validStatus?'http_error':
  ['ETIMEDOUT','ECONNRESET','ECONNABORTED','request_timeout','download_timeout','upload_timeout','network_error','transport_error','incomplete_response'].includes(cause?.code)?'network_error':'unknown';
 const result:SyncFailureDiagnostic={action,reason};
 if(cause?.name==='BaiduWebProbeError'){
  const code=cause.code;
  if(typeof code==='string'&&(/^(?:api_errno_-?\d{1,8}|(?:download_)?http_\d{3})$/.test(code)||['invalid_precreate','invalid_metadata','part_hash_mismatch','upload_not_confirmed','rename_not_confirmed','delete_not_confirmed','plan_changed','path_conflict','size_mismatch','request_timeout','network_error','response_too_large','incomplete_response','unexpected_encoding'].includes(code)))result.providerCode=code;
  if(cause.operationStage==='verify_upload')result.operationStage='verify_upload';
  if(['list','precreate','create','filemanager','filemetas','gettemplatevariable'].includes(cause.apiName))result.apiName=cause.apiName;
  if(['rename','delete'].includes(cause.apiOperation))result.apiOperation=cause.apiOperation;
  if(Number.isSafeInteger(cause.itemErrno)&&Math.abs(cause.itemErrno)<100000000)result.itemErrno=cause.itemErrno;
 }
 if(cause?.name==='QuarkError'){
  const code=cause.code;
  if(typeof code==='string'&&/^[a-z0-9_]{1,64}$/.test(code)){
   result.providerCode=code;
   if(reason==='unknown')result.reason='provider_error';
  }
  if(['upload_prepare','upload_hash','upload_authorize','upload_part','upload_commit','upload_finish','upload_confirm'].includes(cause.providerStage))result.providerStage=cause.providerStage;
  if(cause.outcomeUnknown===true)result.outcomeUnknown=true;
 }
 if(cause?.name==='AliyunError'){
  const code=cause.code;
  if(typeof code==='string'&&/^[a-z0-9_]{1,64}$/.test(code)){
   result.providerCode=code;
   if(reason==='unknown')result.reason='provider_error';
  }
  if(['upload_prepare','upload_part','upload_commit','upload_confirm','download_authorize','download_transfer','download_redirect','upload_confirm_authorize','upload_confirm_transfer','upload_confirm_redirect'].includes(cause.providerStage))result.providerStage=cause.providerStage;
  if(cause.outcomeUnknown===true)result.outcomeUnknown=true;
 }
 if(transfer&&["connecting","sending_body","awaiting_response","receiving_response"].includes(transfer.phase)&&
    Number.isSafeInteger(transfer.bodyBytes)&&transfer.bodyBytes>=0&&Number.isSafeInteger(transfer.elapsedMs)&&transfer.elapsedMs>=0&&typeof transfer.bodyFlushed==="boolean"){
  result.transfer={phase:transfer.phase,bodyBytes:transfer.bodyBytes,bodyFlushed:transfer.bodyFlushed,elapsedMs:transfer.elapsedMs};
  if(Number.isSafeInteger(transfer.responseBytes)&&transfer.responseBytes>=0)result.transfer.responseBytes=transfer.responseBytes;
  if(transfer.timeout==="idle"||transfer.timeout==="response"||transfer.timeout==="total")result.transfer.timeout=transfer.timeout;
 }
 if(validStatus)result.httpStatus=status;
 const networkCode=cause?.networkCode??cause?.code;
 if(["ETIMEDOUT","ECONNRESET","ECONNABORTED"].includes(networkCode))result.networkCode=networkCode;
 for(const field of ['expectedBytes','actualBytes'] as const) if(Number.isSafeInteger(cause?.[field])&&cause[field]>=0)result[field]=cause[field];
 return result;
}
