import { strict as assert } from "assert";
import {
  ActivityTracker,
  saveActivity,
  listActivities,
  webdavScope,
  safeSyncError,
} from "../src/syncActivity";
import { memoryTable } from "./native/support/baiduSyncHarness";

describe("Confirmed sync activity", () => {
  it("counts only confirmed file writes/deletes and never stores bodies or credentials", async () => {
    const tracker = new ActivityTracker("manual", "profile");
    const fs: any = {
      writeFile: async (key: string) => {
        if (key === "fail.md") throw new Error("https://user:secret@server");
        return {};
      },
      rm: async () => {},
      mkdir: async () => {},
    };
    const remote = tracker.observe(fs, "upload"),
      local = tracker.observe(fs, "download");
    await remote.writeFile("工作/note.md", new ArrayBuffer(5), 1, 1);
    await remote.writeFile("工作/note.md", new ArrayBuffer(5), 1, 1);
    await local.writeFile("read.md", new ArrayBuffer(0), 1, 1);
    await assert.rejects(remote.writeFile("fail.md", new ArrayBuffer(0), 1, 1));
    await remote.mkdir("folder/");
    await local.rm("old.md");
    await remote.rm("folder/");
    const record = tracker.finish(new Error("secret"));
    assert.deepEqual(record.counts, { upload: 1, download: 1, delete: 1 });
    assert.deepEqual(record.files.upload, ["工作/note.md"]);
    assert.equal(record.status, "partial");
    assert.ok(!JSON.stringify(record).includes("secret"));
  });
  it("stores the newest 100 records separately for each vault and profile", async () => {
    const table = memoryTable();
    for (let i = 0; i < 103; i++) {
      const record = new ActivityTracker(
        "manual",
        i % 2 ? "other" : "p"
      ).finish();
      record.startedAt = i;
      await saveActivity(table, "v", record);
    }
    assert.equal((await listActivities(table, "v")).length, 100);
    assert.equal((await listActivities(table, "other-vault")).length, 0);
    assert.ok(
      (await listActivities(table, "v", "p")).every((r) => r.profile === "p")
    );
  });
  it("isolates WebDAV history when account, root or encryption changes without exposing secrets", () => {
    const settings: any = {
      webdav: {
        address: "https://server.test/dav/",
        username: "user",
        password: "secret",
        remoteBaseDir: "",
      },
      password: "",
      encryptionMethod: "openssl-base64",
    };
    const before = webdavScope(settings, "vault");
    assert.match(before, /^[a-f0-9]{64}$/);
    assert.equal(before, webdavScope(settings, "vault"));
    settings.webdav.remoteBaseDir = "other";
    assert.notEqual(before, webdavScope(settings, "vault"));
    assert.match(
      safeSyncError({ status: 401, message: "secret" }),
      /账号或密码/
    );
  });
});

describe("Safe native sync diagnostics", () => {
  it("explains a rejected emoji filename and gives an Obsidian rename action without leaking raw messages",()=>{
    const message=safeSyncError({name:'BaiduWebProbeError',code:'api_errno_12',apiName:'filemanager',apiOperation:'rename',itemErrno:-7,filenameHasSupplementary:true,message:'secret-token'});
    assert.match(message,/文件名/);assert.match(message,/表情|特殊字符/);assert.match(message,/Obsidian/);assert.match(message,/移除|修改/);assert.ok(!message.includes('secret-token'));
  });
  it("does not claim an emoji restriction when a rejected path has no filename evidence",()=>{
    const message=safeSyncError({name:'BaiduWebProbeError',code:'api_errno_12',apiName:'filemetas',itemErrno:-7});
    assert.match(message,/名称|文件名/);assert.match(message,/权限/);assert.match(message,/检查/);
    assert.ok(!message.includes('移除表情'));
  });
  it("explains an unconfirmed Quark folder creation and tells the user to check for a partial result",()=>{
    const message=safeSyncError({name:'QuarkError',code:'api_rejected',outcomeUnknown:true,message:'secret'});
    assert.match(message,/夸克接口拒绝/);assert.match(message,/权限/);assert.match(message,/检查网盘/);assert.ok(!message.includes('secret'));
  });
  for(const [error,reason,action] of [
    [{status:401},/账号|密码/,/检查|登录/],
    [{status:403},/拒绝|权限/,/检查/],
    [{status:404},/不存在|找不到/,/检查/],
    [{status:429},/频繁/,/稍后/],
    [{status:503},/服务|服务器/,/重试/],
    [{name:'BaiduWebProbeError',code:'upload_too_large'},/64 MiB/,/缩小/],
    [{name:'BaiduWebProbeError',code:'network_error'},/网络/,/重试|重新同步/],
  ] as const)it(`provides a reason and an action for ${JSON.stringify(error)}`,()=>{
    const message=safeSyncError(error);assert.match(message,reason);assert.match(message,action);
  });
  it("reports empty files through nested sync errors without leaking raw messages", () => {
    const error = {
      errors: [
        {
          cause: {
            code: "empty_file_unsupported",
            stage: "input",
            message: "secret-token",
          },
        },
      ],
    };
    assert.match(safeSyncError(error), /不支持.*空文件/);
    assert.ok(!safeSyncError(error).includes("secret-token"));
  });
  it("reports upload stage and provider errno without leaking raw messages", () => {
    const result = safeSyncError({
      errors: [
        {
          cause: {
            name: "BaiduUploadError",
            code: "platform_error",
            stage: "part",
            errno: 31024,
            message: "secret-token",
          },
        },
      ],
    });
    assert.match(result, /31024/);
    assert.match(result, /分片上传/);
    assert.ok(!result.includes("secret-token"));
  });
});

describe("Quark sync failure messages", () => {
  it("identifies session and upload failures without raw server text", () => {
    assert.match(
      safeSyncError({
        name: "QuarkError",
        code: "login_required",
        message: "secret",
      }),
      /夸克.*登录/
    );
    const result = safeSyncError({
      errors: [
        {
          cause: {
            name: "QuarkError",
            code: "upload_not_confirmed",
            outcomeUnknown: true,
            message: "secret",
          },
        },
      ],
    });
    assert.match(result, /上传.*确认/);
    assert.ok(!result.includes("secret"));
  });
});

describe("Planned sync activity", () => {
  it("reports skipped empty files as partial without counting them as uploaded or failed", () => {
    const tracker = new ActivityTracker("manual", "profile");
    tracker.onSkipped("empty.md", "empty_file_unsupported");
    tracker.onPlan({total:1,upload:1,download:0,delete:0,createFolder:0,conflicts:0,bytes:5,unknownSizes:0});
    tracker.onTask({key:"note.md",action:"upload",bytes:5,unknownSize:false,state:"completed"});
    const record=tracker.finish();
    assert.equal(record.status,"partial");
    assert.deepEqual(record.skippedPaths,["empty.md"]);
    assert.equal(record.progress?.skipped,1);
    assert.equal(record.progress?.failed,0);
    assert.equal(record.progress?.unexecuted,0);
    assert.match(record.error??"",/网盘不支持的空文件/);
  });
  it("keeps scanning indeterminate then distinguishes confirmed, failed and unexecuted tasks", () => {
    const tracker: any = new ActivityTracker("manual", "profile");
    tracker.onPhase?.("remote");
    tracker.onScan?.("remote", 12, 3);
    assert.equal(tracker.record.progress?.scanned.remote.files, 12);
    assert.equal(tracker.record.progress.plan, undefined);
    tracker.onPlan?.({total: 3, upload: 2, download: 0, delete: 0, createFolder: 1, conflicts: 0, bytes: 10, unknownSizes: 0});
    tracker.onTask?.({key:"notes/",action:"createFolder",bytes:0,unknownSize:false,state:"completed"});
    tracker.onTask?.({key:"notes/a.md",action:"upload",bytes:5,unknownSize:false,state:"started"});
    tracker.onTask?.({key:"notes/a.md",action:"upload",bytes:5,unknownSize:false,state:"failed"});
    const record = tracker.finish(new Error("secret"));
    assert.equal(record.progress.completed, 1);
    assert.equal(record.progress.failed, 1);
    assert.equal(record.progress.unexecuted, 1);
    assert.equal(record.progress.completedBytes, 0);
    assert.equal(record.progress.currentPath, undefined);
    assert.deepEqual(record.failedPaths, ["notes/a.md"]);
    assert.equal(record.status, "partial");
  });
  it("does not call a folder-only sync unchanged or double-count repeated completion events", () => {
    const tracker: any = new ActivityTracker("manual", "profile");
    tracker.onPlan?.({total:1,upload:0,download:0,delete:0,createFolder:1,conflicts:0,bytes:0,unknownSizes:0});
    const event={key:"notes/",action:"createFolder",bytes:0,unknownSize:false,state:"completed"};
    tracker.onTask?.(event);tracker.onTask?.(event);
    const record = tracker.finish();
    assert.equal(record.progress?.completed, 1);
    assert.equal(record.status, "success");
    assert.equal(record.progress.unexecuted, 0);
  });
});

describe("Version-aware plan fingerprints",()=>{
 it("detects remote changes even when size and timestamp stay the same",async()=>{
   const {entityFingerprint}=await import("../src/syncActivity");
   const before:any=[{key:"note.md",keyRaw:"note.md",size:5,sizeRaw:5,mtimeSvr:10000,etag:"version1"}];
   const after=structuredClone(before);after[0].etag="version2";
   assert.notEqual(entityFingerprint(before),entityFingerprint(after));
 });
});

describe("Safe performance diagnostics",()=>{
 it("retains failure phase and aggregate requests without recording credentials or paths",async()=>{
  const module=await import("../src/syncProgressUi");
  const tracker:any=new ActivityTracker("manual","secret-profile");
  tracker.onPhase("local");
  const record=tracker.finish(new Error("https://user:secret@example.test"));
  record.diagnostics={webdav:{requests:12,retries:2,elapsedMs:500,operations:{list:8,stat:4},lastFailure:{operation:"list",status:503}}};
  record.failedPaths=["private/note.md"];
  assert.equal(record.progress.failurePhase,"local");
  const diagnostic=(module as any).syncDiagnostic?.(record);
  assert.equal(diagnostic?.webdav?.readRequests,12);
  assert.equal(diagnostic?.failurePhase,"local");
  assert.ok(!JSON.stringify(diagnostic).includes("secret"));
  assert.ok(!JSON.stringify(diagnostic).includes("private"));
 });
});

it('does not label an acknowledged file write as failed when stop arrives during the request',async()=>{
 const {SyncControl}=await import('../src/syncControl');
 const tracker2=new ActivityTracker('manual','p');const control2=new SyncControl();
 const fs=tracker2.observe({writeFile:async(_key:string)=>{control2.stop();return{};}},'upload',()=>control2.guard(),()=>control2.checkpoint());
 await fs.writeFile('done.md');
 const record=tracker2.finish(Object.assign(new Error('stopped'),{code:'sync_cancelled'}));
 assert.equal(record.counts.upload,1);assert.deepEqual(record.failedPaths,[]);assert.equal(record.status,'cancelled');
});

it('exports task failure direction and safe reason without raw paths or secrets',async()=>{
 const {syncDiagnostic}=await import('../src/syncProgressUi');
 const tracker=new ActivityTracker('manual','p');
 tracker.onTask({key:'private/clip.html',action:'download',bytes:10,unknownSize:false,state:'failed',
  error:Object.assign(new Error('secret path /home/private'),{code:'size_mismatch',expectedBytes:10,actualBytes:8})} as any);
 const diagnostic:any=syncDiagnostic(tracker.finish(new Error('failed')));
 assert.deepEqual(diagnostic.failures,[{action:'download',reason:'size_mismatch',expectedBytes:10,actualBytes:8}]);
 assert.ok(!JSON.stringify(diagnostic).includes('private'));assert.ok(!JSON.stringify(diagnostic).includes('secret'));
});
