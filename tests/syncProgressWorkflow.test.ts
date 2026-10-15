import { strict as assert } from "assert";
import { api, setup, bytes } from "./native/support/baiduSyncHarness";

describe("Pre-scanned sync progress through the real engine", () => {
  it("announces the whole plan before writes and completes folders and files only after confirmation", async () => {
    const f = setup();
    await f.local.mkdir("notes/", 10000);
    await f.local.writeFile("notes/a.md", bytes("hello"), 10000, 10000);
    const plan = await f.plan();
    const events: any[] = [];
    await api.doActualSync(plan, f.local, f.encrypted, "vault", "baidu-profile", 2,
      -1, undefined, f.db, undefined, "keep_newer", "manual", undefined, {
        onPlan: (summary: any) => {
          assert.equal(f.remoteItems.size, 0, "plan must precede mutations");
          events.push({plan: summary});
        },
        onTask: (event: any) => {
          if (event.state === "completed") {
            assert.ok(f.remoteItems.has("/apps/test/" + event.key.replace(/\/$/, "")));
          }
          events.push(event);
        },
      });
    assert.equal(events[0]?.plan?.total, 2);
    assert.equal(events[0].plan.upload, 1);
    assert.equal(events[0].plan.createFolder, 1);
    assert.equal(events[0].plan.bytes, 5);
    assert.deepEqual(events.filter(e => e.state === "completed").map(e => e.key), ["notes/", "notes/a.md"]);
    assert.equal(events.filter(e => e.state === "started").length, 2);
  });
  it("reports a failed upload without claiming completion or advancing its history", async () => {
    const f = setup();
    await f.local.writeFile("a.md", bytes("hello"), 10000, 10000);
    const plan = await f.plan(); f.failUpload();
    const events: any[] = [];
    await assert.rejects(api.doActualSync(plan, f.local, f.encrypted, "vault", "baidu-profile", 1,
      -1, undefined, f.db, undefined, "keep_newer", "manual", undefined, {
        onPlan: (summary: any) => events.push({plan: summary}),
        onTask: (event: any) => events.push(event),
      }));
    assert.equal(events[0]?.plan?.total, 1);
    assert.deepEqual(events.filter(e => e.state === "failed").map(e => e.key), ["a.md"]);
    assert.equal(events.filter(e => e.state === "completed").length, 0);
    assert.equal((await f.history()).length, 0);
  });
  it("does not count unchanged files and internal history maintenance as transfer tasks", async () => {
    const f = setup();
    await f.local.writeFile("a.md", bytes("hello"), 10000, 10000);
    await f.run(await f.plan());
    let summary: any;
    await api.doActualSync(await f.plan(), f.local, f.encrypted, "vault", "baidu-profile", 1,
      -1, undefined, f.db, undefined, "keep_newer", "manual", undefined,
      {onPlan: (s: any) => {summary=s;}});
    assert.equal(summary?.total, 0);
    assert.equal(summary.bytes, 0);
  });
});

describe("Files changed after pre-scan", () => {
  it("does not upload a local version that changed after planning", async () => {
    const f = setup();
    await f.local.writeFile("a.md", bytes("before"),10000,10000);
    const plan = await f.plan();
    await f.local.writeFile("a.md",bytes("changed after planning"),20000,10000);
    await assert.rejects(f.run(plan));
    assert.equal(f.remoteItems.size,0);
    assert.equal((await f.history()).length,0);
  });
});

describe("Bounded large-file transfers", () => {
  it("does not read several large files into memory at the same time", async () => {
    const f=setup(); const length=40*1024*1024;
    let active=0,peak=0;
    const entries:any={};
    for(const key of ["a.bin","b.bin"]) entries[key]={key,decision:"local_is_created_then_push",local:{key,keyRaw:key,size:length,sizeRaw:length,mtimeCli:10000}};
    const local:any={kind:"local",stat:async(key:string)=>entries[key].local,readFile:async()=>{active++;peak=Math.max(peak,active);return new ArrayBuffer(length);}};
    const remote:any={kind:"encrypt",writeFile:async(key:string,body:ArrayBuffer)=>{await new Promise(r=>setTimeout(r,10));active--;return {key,keyRaw:key,size:body.byteLength,sizeRaw:body.byteLength,mtimeCli:10000};}};
    await api.doActualSync(entries,local,remote,"vault","p",5,-1,undefined,f.db,undefined,"keep_newer","manual");
    assert.equal(peak,1);
  });
});

describe("Planned folder deletion",()=>{
 it("preserves local children created after the scan",async()=>{
  let deleted=false;
  const vault:any={adapter:{list:async()=>({files:["notes/new.md"],folders:[]}),trashSystem:async()=>{deleted=true;return true;}}};
  const fs=new api.FakeFsLocal(vault,false,false,".obsidian","remotely-save-next",undefined,"system");
  await assert.rejects(fs.rm("notes/"), (e:any)=>e.code==='plan_changed');
  assert.equal(deleted,false);
 });
});

describe("Native scan progress",()=>{
 it("reports files and directories during a Baidu scan",async()=>{
  const f=setup();await f.local.mkdir("notes/",10000);await f.local.writeFile("notes/a.md",bytes("hello"),10000,10000);
  await f.run(await f.plan());
  const counts:any[]=[];f.remote.onScanProgress=(files:number,folders:number)=>counts.push([files,folders]);
  await f.remote.walk();
  assert.deepEqual(counts.at(-1),[1,1]);
 });
});

describe("One pre-scan per ordinary sync",()=>{
 it("reuses the scanned remote inventory for the password check and dry-run plan",async()=>{
  const f=setup();await f.local.writeFile("a.md",bytes("hello"),10000,10000);
  let scans=0;const walk=f.remote.walk.bind(f.remote);
  f.remote.walk=()=>{scans++;return walk();};
  const errors:any[]=[];
  await api.syncer(f.local,f.remote,f.encrypted,undefined,f.db,"dry","baidu-profile","vault",".obsidian",
   {...f.settings,pro:{refreshToken:"test-pro-state",enabledProFeatures:[]}},"0.5.25",async()=>{},undefined,()=>{},undefined,async(_s:any,e:any)=>{errors.push(e);});
  assert.deepEqual(errors,[]);assert.equal(scans,1);
  assert.equal(f.remoteItems.size,0);
 });
});

describe('Controlling planned sync operations',()=>{
 it('waits after folder creation and continues the pending file only on resume',async()=>{
  const {SyncControl}=await import('../src/syncControl');const control=new SyncControl();
  const f=setup();await f.local.mkdir('test/',10000);await f.local.writeFile('test/a.md',bytes('hello'),10000,10000);
  let paused!:()=>void;const reached=new Promise<void>(r=>paused=r);
  const running=api.doActualSync(await f.plan(),f.local,f.encrypted,'vault','baidu-profile',1,-1,undefined,f.db,undefined,'keep_newer','manual',undefined,{
   checkpoint:()=>control.checkpoint(),guard:()=>control.guard(),
   onTask:(e:any)=>{if(e.key==='test/'&&e.state==='completed'){control.pause();paused();}}
  });
  await reached;await new Promise(r=>setTimeout(r,10));
  const uploadedBeforeResume=f.remoteItems.has('/apps/test/test/a.md');
  control.resume();await running;
  assert.equal(uploadedBeforeResume,false);assert.ok(f.remoteItems.has('/apps/test/test/a.md'));
 });
 it('stop leaves pending files unexecuted rather than reporting them as failed',async()=>{
  const {SyncControl,isSyncCancelled}=await import('../src/syncControl');const control=new SyncControl();
  const f=setup();await f.local.mkdir('test/',10000);await f.local.writeFile('test/a.md',bytes('hello'),10000,10000);
  const failed:any[]=[];
  await assert.rejects(api.doActualSync(await f.plan(),f.local,f.encrypted,'vault','baidu-profile',1,-1,undefined,f.db,undefined,'keep_newer','manual',undefined,{
   checkpoint:()=>control.checkpoint(),guard:()=>control.guard(),
   onTask:(e:any)=>{if(e.state==='failed')failed.push(e);if(e.key==='test/'&&e.state==='completed')control.stop();}
  }));
  assert.equal(f.remoteItems.has('/apps/test/test/a.md'),false);assert.deepEqual(failed,[]);
 });
});

describe('Complete local disk inventory',()=>{
 it('uploads an HTML file even when it is absent from the Obsidian loaded-file index',async()=>{
  const f=setup();const key='00-Inbox/剪藏网页（2026_4_29）.html';const body=bytes('<html>saved page</html>');
  const vault:any={getAllLoadedFiles:()=>[],adapter:{
   list:async(path:string)=>path==='/'?{files:[],folders:['00-Inbox']}:{files:[key],folders:[]},
   stat:async(path:string)=>path.replace(/\/$/,'')==='00-Inbox'?{type:'folder',size:0,mtime:10000,ctime:10000}:path===key?{type:'file',size:body.byteLength,mtime:10000,ctime:10000}:null,
   readBinary:async()=>body.slice(0),
  }};
  const local=new api.FakeFsLocal(vault,false,false,'.obsidian','remotely-save-next',undefined,'system');
  const inventory=await local.walk();assert.ok(inventory.some((e:any)=>e.key===key),'HTML file must be present in the scan');
  const plan=await api.buildSyncPlan({localEntityList:inventory,remoteEntityList:await f.encrypted.walk(),prevSyncEntityList:[],fsEncrypt:f.encrypted,settings:f.settings,triggerSource:'manual',configDir:'.obsidian'});
  assert.equal(plan[key].decision,'local_is_created_then_push');
  await api.doActualSync(plan,local,f.encrypted,'vault','baidu-profile',1,-1,undefined,f.db,undefined,'keep_newer','manual');
  assert.ok(f.remoteItems.has('/apps/test/'+key));
 });
});

it('does not trash a local folder when stopped during its emptiness check',async()=>{
 const {SyncControl,isSyncCancelled}=await import('../src/syncControl');const control=new SyncControl();
 let release!:()=>void,entered!:()=>void,trashed=false;
 const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const vault:any={adapter:{list:async()=>{entered();await gate;return{files:[],folders:[]};},trashSystem:async()=>{trashed=true;return true;}}};
 const fs=new api.FakeFsLocal(vault,false,false,'.obsidian','remotely-save-next',undefined,'system');fs.beforeOperation=()=>control.checkpoint();
 const removing=fs.rm('notes/');const result=removing.catch((error:any)=>error);
 await ready;control.stop();release();const error=await result;
 assert.equal(trashed,false);assert.ok(isSyncCancelled(error));
});

it('rechecks folder contents after a pause before trashing it',async()=>{
 const {SyncControl}=await import('../src/syncControl');const control=new SyncControl();let checked!:()=>void;
 const firstCheck=new Promise<void>(r=>checked=r);let checks=0,trashed=false;
 const vault:any={adapter:{list:async()=>{checks++;if(checks===1){control.pause();checked();return{files:[],folders:[]};}return{files:['notes/new.md'],folders:[]};},trashSystem:async()=>{trashed=true;return true;}}};
 const fs=new api.FakeFsLocal(vault,false,false,'.obsidian','remotely-save-next',undefined,'system');
 fs.beforeOperation=()=>control.checkpoint();fs.operationRevision=()=>control.revision;
 const result=fs.rm('notes/').catch((error:any)=>error);
 await firstCheck;control.resume();const error=await result;
 assert.equal(trashed,false);assert.equal(error?.code,'plan_changed');
});
