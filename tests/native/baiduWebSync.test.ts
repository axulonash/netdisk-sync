import {api,setup,bytes,memoryTable} from './support/baiduSyncHarness';
import {FakeFsBaiduWeb} from '../../src/fsBaiduWeb';
import {assertBaiduWebPlan,skipBaiduEmptyFiles,baiduWebProfile,migrateBaiduWebHistory,createBaiduWebPreparationGuard} from '../../src/native/baiduWebSync';
import {strict as assert} from 'assert';
import {createHash} from 'crypto';
import {BaiduWebSyncClient} from '../../src/native/baiduWebSync';
import {BaiduWebProbe,type BaiduWebProbeTransport} from '../../src/native/baiduWebProbe';
const digest=(bytes:Uint8Array)=>createHash('md5').update(bytes).digest('hex');
it('rejects history migration after encryption or directory changes during preparation',()=>{
 const settings:any={serviceType:'baidu',baiduWebExperimental:{cookie:'BDUSS=fixture',csrf:'csrf'},baiduWebRemoteRoot:'/notes',password:'one',encryptionMethod:'openssl-base64'};
 const guard=createBaiduWebPreparationGuard(()=>settings,'/notes');guard();
 settings.password='two';assert.throws(guard,/configuration_changed/);
 settings.password='one';settings.baiduWebRemoteRoot='/other';assert.throws(guard,/configuration_changed/);
});
it('keeps the same account history across QR sessions while isolating other accounts and roots',()=>{
 const settings:any={baiduWebExperimental:{cookie:'BDUSS=first',csrf:'first',accountId:'123'},baiduWebRemoteRoot:'/notes',password:''};
 const first=baiduWebProfile(settings);settings.baiduWebExperimental={cookie:'BDUSS=second',csrf:'second',accountId:'123'};
 assert.equal(baiduWebProfile(settings),first);
 settings.baiduWebExperimental.accountId='124';assert.notEqual(baiduWebProfile(settings),first);
 settings.baiduWebExperimental.accountId='123';settings.baiduWebRemoteRoot='/other';assert.notEqual(baiduWebProfile(settings),first);
});
it('copies only the verified current legacy history and preserves existing stable records',async()=>{
 const f=setup(),table=f.db.prevSyncRecordsTbl;
 await table.setItem('vault\told\tnote.md',{key:'note.md',size:4});
 await table.setItem('vault\told\tnew.md',{key:'new.md',size:5});
 await table.setItem('vault\tother\tprivate.md',{key:'private.md'});
 await table.setItem('vault\tstable\tnote.md',{key:'note.md',size:9});
 await migrateBaiduWebHistory(table,'vault','old','stable');
 assert.equal((await table.getItem('vault\tstable\tnote.md')).size,9);
 assert.equal((await table.getItem('vault\tstable\tnew.md')).size,5);
 assert.equal(await table.getItem('vault\tstable\tprivate.md'),null);
 assert.ok(await table.getItem('vault\told\tnew.md'));
});
it('keeps failed paths visible when the authenticated legacy activity scope is migrated',async()=>{
 const f=setup(),activities=memoryTable();
 await activities.setItem('sync-activities-v1:vault',[{id:'last',profile:'old',failedPaths:['failed.md']},{id:'other',profile:'another',failedPaths:[]}]);
 await migrateBaiduWebHistory(f.db.prevSyncRecordsTbl,'vault','old','stable',activities);
 const records:any=await activities.getItem('sync-activities-v1:vault');
 assert.equal(records[0].profile,'stable');assert.deepEqual(records[0].failedPaths,['failed.md']);assert.equal(records[1].profile,'another');
});
function harness(){
 const files=new Map<string,any>();files.set('/notes',{path:'/notes',isdir:1,fs_id:1,size:0,server_mtime:1,server_ctime:1});
 const uploads=new Map<string,Uint8Array[]>();const calls:{name:string;fields:URLSearchParams}[]=[];let next=2;let losePublish=false,failStageDownload=false,renameChangesTime=false,omitMd5=false;let badMetaPath:string|undefined,denyListing=false,rejectSymbols=false;
 const response=(data:any)=>({status:200,headers:{},cookies:[],body:new TextEncoder().encode(JSON.stringify(data))});
 const transport:BaiduWebProbeTransport=async req=>{
  const url=new URL(req.url),fields=new URLSearchParams(typeof req.body==='string'?req.body:'');const name=url.pathname.split('/').pop()!;
  calls.push({name,fields});
  if(name==='filemetas'){const path=JSON.parse(url.searchParams.get('target')!)[0],entry=files.get(path);if(path===badMetaPath)return response({errno:12,info:[{errno:-7}]});return entry?response({errno:0,info:[{...entry,data:undefined,md5:omitMd5?undefined:entry.md5}]}):response({errno:12,info:[{errno:-9}]});}
  if(name==='list'){if(denyListing)return response({errno:-6});const parent=url.searchParams.get('dir'),page=Number(url.searchParams.get('page')??1),num=Number(url.searchParams.get('num')??1000);return response({errno:0,list:[...files.values()].filter(x=>(x.path.slice(0,x.path.lastIndexOf('/'))||'/')===parent).slice((page-1)*num,page*num).map(({data,...v})=>v)});}
  if(name==='precreate'){uploads.set(fields.get('path')!,[]);return response({errno:0,return_type:1,uploadid:'upload',block_list:JSON.parse(fields.get('block_list')!).map((_:any,i:number)=>i)});}
  if(name==='superfile2'){
   const raw=Buffer.from(req.body! as Uint8Array);const head=raw.indexOf('\r\n\r\n')+4,tail=raw.lastIndexOf('\r\n--');const bytes=new Uint8Array(raw.subarray(head,tail));
   uploads.get(url.searchParams.get('path')!)![Number(url.searchParams.get('partseq'))]=bytes;return response({md5:digest(bytes)});
  }
  if(name==='create'){
   const path=fields.get('path')!;if(files.has(path))return response({errno:-8});
   const parts=uploads.get(path)??[];const data=Buffer.concat(parts.map(p=>Buffer.from(p)));const entry={path,isdir:Number(fields.get('isdir')),fs_id:next++,size:data.length,md5:digest(data),server_mtime:Number(fields.get('local_mtime')??2),server_ctime:2,data:new Uint8Array(data)};
   files.set(path,entry);return response({errno:0,...entry,data:undefined});
  }
  if(name==='file'){
   if(failStageDownload&&url.searchParams.get('path')!.includes('.rsnext-baidu-stage-')){failStageDownload=false;throw new Error('download disconnected');}
   const f=files.get(url.searchParams.get('path')!);return {status:f?200:404,headers:{},cookies:[],body:f?.data??new Uint8Array()};
  }
  if(name==='filemanager'){
   const list=JSON.parse(fields.get('filelist')!);
   if(url.searchParams.get('opera')==='rename'){
    const {path,newname}=list[0],entry=files.get(path);const target=path.slice(0,path.lastIndexOf('/')+1)+newname;
    if(rejectSymbols&&/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(newname))return response({errno:12,info:[{errno:-7}]});
    if(files.has(target))return response({errno:-8});if(!entry)return response({errno:-9});files.delete(path);files.set(target,{...entry,path:target,server_mtime:entry.server_mtime+(renameChangesTime?1:0)});
    if(losePublish&&!newname.startsWith('.rsnext-')){losePublish=false;throw Error('lost response');}
   }else for(const path of list)files.delete(path);
   return response({errno:0});
  }
  throw Error('unexpected operation '+name);
 };
 const probe=new BaiduWebProbe(transport);probe.restoreSession({cookie:'BDUSS=fixture',csrf:'csrf'});
 const client=new BaiduWebSyncClient(probe,'/notes',()=>{});
 return {client,files,calls,losePublish:()=>{losePublish=true;},failStageDownload:()=>{failStageDownload=true;},renameChangesTime:()=>{renameChangesTime=true;},omitMd5:()=>{omitMd5=true;},rejectMetadata:(path:string)=>{badMetaPath=path;},denyListing:()=>{denyListing=true;},rejectSymbols:()=>{rejectSymbols=true;}};
}
describe('Baidu QR full file sync',()=>{
 it('adds filename evidence to a rejected rocket rename while preserving the API error',async()=>{
  const h=harness();h.rejectSymbols();
  await assert.rejects(()=>h.client.write('🚀 个人技能提升与职业发展路线图.md',bytes('note'),3000,3000),(e:any)=>e.code==='api_errno_12'&&e.itemErrno===-7&&e.filenameHasSupplementary===true);
  assert.ok(![...h.files.keys()].some(p=>p.includes('.rsnext-')));
 });
 it('checks every metadata fallback page before deciding whether the target exists',async()=>{
  const h=harness();
  for(let i=0;i<1000;i++){const path='/notes/sibling-'+i;h.files.set(path,{path,isdir:0,fs_id:10000+i,size:1,server_mtime:1,server_ctime:1});}
  h.files.set('/notes/target.md',{path:'/notes/target.md',isdir:0,fs_id:50000,size:4,server_mtime:1,server_ctime:1});
  h.rejectMetadata('/notes/target.md');assert.equal((await h.client.stat('target.md')).id,'50000');
  assert.equal(h.calls.filter(c=>c.name==='list').length,2);
 });
 it('uses an exact parent listing when filemetas rejects the reported Chinese filename with -7',async()=>{
  const h=harness(),key='02-Areas/个人成长/个人技能提升与职业发展路线图.md';
  await h.client.mkdir('02-Areas/');await h.client.mkdir('02-Areas/个人成长/');
  h.rejectMetadata('/notes/'+key);
  await h.client.write(key,bytes('career plan'),3000,3000);
  assert.equal(new TextDecoder().decode(await h.client.read(key)),'career plan');
  await h.client.scan();await h.client.write(key,bytes('updated plan'),4000,3000);
  assert.equal(new TextDecoder().decode(await h.client.read(key)),'updated plan');
  assert.ok(![...h.files.keys()].some(path=>path.includes('.rsnext-')));
 });
 it('does not treat filemetas -7 as absence when the parent listing is denied',async()=>{
  const h=harness();h.rejectMetadata('/notes/blocked.md');h.denyListing();
  await assert.rejects(()=>h.client.write('blocked.md',bytes('content'),3000,3000),(e:any)=>e.code==='api_errno_-6');
  assert.equal(h.calls.filter(c=>['create','precreate','filemanager'].includes(c.name)).length,0);
 });
 it('keeps the published byte readback when the server omits its content token',async()=>{
  const h=harness();h.omitMd5();h.renameChangesTime();await h.client.write('note.md',bytes('note'),3000,3000);
  assert.equal(h.calls.filter(c=>c.name==='file').length,2);
 });
 it('accepts rename timestamps changing only when the verified content identity still matches',async()=>{
  const h=harness();h.renameChangesTime();await h.client.write('note.md',bytes('note'),3000,3000);
  assert.equal(new TextDecoder().decode(await h.client.read('note.md')),'note');
 });
 it('preserves orphan upload stages without blocking unrelated synchronization',async()=>{
  const h=harness(),path='/notes/.rsnext-baidu-stage-'+ 'b'.repeat(32);
  h.files.set(path,{path,isdir:0,fs_id:99,size:4,server_mtime:1,server_ctime:1,data:new Uint8Array([1,2,3,4])});
  assert.deepEqual(await h.client.scan(),[]);
  await h.client.write('note.md',bytes('note'),3000,3000);
  assert.ok(h.files.has(path));assert.equal(new TextDecoder().decode(await h.client.read('note.md')),'note');
 });
 it('cleans a confirmed owned stage when its readback fails before publishing',async()=>{
  const h=harness();await h.client.write('note.md',bytes('old'),3000,3000);h.failStageDownload();
  await assert.rejects(()=>h.client.write('note.md',bytes('new'),4000,3000),(e:any)=>e.operationStage==='verify_upload');
  assert.equal(new TextDecoder().decode(await h.client.read('note.md')),'old');
  assert.ok(![...h.files.keys()].some(p=>p.includes('.rsnext-')));
 });
 it('verifies new bytes once and confirms the published file identity without downloading them twice',async()=>{
  const h=harness();await h.client.write('note.md',bytes('note'),3000,3000);
  assert.equal(h.calls.filter(c=>c.name==='file').length,1);
 });
 it('scans, uploads, downloads, replaces and deletes with a dedicated web session',async()=>{
  const h=harness();await h.client.mkdir('folder/');
  await h.client.write('folder/note.md',new TextEncoder().encode('first').buffer,3000,3000);
  assert.equal(new TextDecoder().decode(await h.client.read('folder/note.md')),'first');
  assert.equal((await h.client.scan()).length,2);
  await h.client.write('folder/note.md',new TextEncoder().encode('second').buffer,4000,3000);
  assert.equal(new TextDecoder().decode(await h.client.read('folder/note.md')),'second');
  assert.ok(![...h.files.keys()].some(p=>p.includes('.rsnext-')));
  await h.client.remove('folder/note.md');await assert.rejects(()=>h.client.remove('folder/'),/directory_delete_unsupported/);assert.equal((await h.client.scan()).length,1);
 });
 it('uploads a file larger than 4 MiB as verified parts',async()=>{
  const h=harness(),bytes=new Uint8Array(4*1024*1024+7);bytes.fill(65);
  await h.client.write('large.pdf',bytes.buffer,3000,3000);
  assert.equal(h.calls.filter(c=>c.name==='superfile2').length,2);assert.equal((await h.client.read('large.pdf')).byteLength,bytes.length);
 });
 it('detects a changed scan version before replacing or deleting remote content',async()=>{
  const h=harness();await h.client.write('note.md',new TextEncoder().encode('first').buffer,3000,3000);await h.client.scan();
  const item=h.files.get('/notes/note.md');h.files.set('/notes/note.md',{...item,server_mtime:9});
  await assert.rejects(()=>h.client.remove('note.md'),/plan_changed/);assert.ok(h.files.has('/notes/note.md'));
 });
 it('reconciles a lost publish response by checking the staged identity instead of replaying rename',async()=>{
  const h=harness();await h.client.write('note.md',new TextEncoder().encode('first').buffer,3000,3000);h.losePublish();
  await h.client.write('note.md',new TextEncoder().encode('second').buffer,4000,3000);
  assert.equal(new TextDecoder().decode(await h.client.read('note.md')),'second');assert.ok(![...h.files.keys()].some(p=>p.includes('.rsnext-')));
 });
 it('blocks traversal and interrupted backup markers before planning deletion',async()=>{
  const h=harness();await assert.rejects(()=>h.client.write('../escape',new Uint8Array([1]).buffer,1,1));
  h.files.set('/notes/.rsnext-baidu-backup-'+ 'a'.repeat(32),{path:'/notes/.rsnext-baidu-backup-'+ 'a'.repeat(32),isdir:0,fs_id:9,size:1,server_mtime:1,server_ctime:1,data:new Uint8Array([1])});
  await assert.rejects(()=>h.client.scan(),/interrupted_replacement/);
 });
});

it('uses direct metadata instead of relisting siblings for each file lookup',async()=>{
 const h=harness();await h.client.write('note.md',new TextEncoder().encode('text').buffer,3000,3000);const before=h.calls.filter(c=>c.name==='list').length;await h.client.read('note.md');assert.equal(h.calls.filter(c=>c.name==='list').length,before);
});
it('preflights unsupported empty uploads and directory deletions before executing any mutation',async()=>{
 const {assertBaiduWebPlan}=await import('../../src/native/baiduWebSync');
 assert.throws(()=>assertBaiduWebPlan({zero:{key:'empty.md',decision:'local_is_created_then_push',local:{size:0}}} as any,false),/empty_file_unsupported/);
 assert.throws(()=>assertBaiduWebPlan({folder:{key:'old/',decision:'folder_to_be_deleted_on_remote'}} as any,false),/directory_delete_unsupported/);
 assert.doesNotThrow(()=>assertBaiduWebPlan({note:{key:'note.md',decision:'local_is_created_then_push',local:{size:3}}} as any,false));
 assert.doesNotThrow(()=>assertBaiduWebPlan({zero:{key:'empty.md',decision:'local_is_created_then_push',local:{size:0}}} as any,true));
});
it('verifies rename refusal and replacement in an isolated preparation directory',async()=>{
 const h=harness();await h.client.verifyReplacement('e'.repeat(32));assert.ok(![...h.files.keys()].some(p=>p.includes('.rsnext-')));
});

describe('Baidu QR through the real sync planner and history',()=>{
 for(const password of ['', 'fixture-password'])it(`uploads, skips unchanged files, downloads and deletes: ${password?'OpenSSL':'plain'}`,async()=>{
  const h=harness(),f=setup(),remote=new api.FakeFsEncrypt(new FakeFsBaiduWeb(h.client),password,'openssl-base64');
  const settings={...f.settings,serviceType:'baidu',password,encryptionMethod:'openssl-base64'};
  const profile='baidu-web-fixture';
  const history=()=>api.getAllPrevSyncRecordsByVaultAndProfile(f.db,'vault',profile);
  const plan=async()=>api.buildSyncPlan({localEntityList:await f.local.walk(),remoteEntityList:await remote.walk(),prevSyncEntityList:await history(),fsEncrypt:remote,settings,triggerSource:'manual',configDir:'.obsidian'});
  const run=async()=>api.doActualSync(await plan(),f.local,remote,'vault',profile,5,-1,undefined,f.db,undefined,'keep_newer','manual',undefined,{validatePlan:(p:any)=>assertBaiduWebPlan(p,!!password)});
  await f.local.writeFile('中文.md',bytes('first note'),10123,10123);await run();assert.equal((await history()).length,1);
  assert.equal((await plan())['中文.md'].decision,'equal');
  await f.local.writeFile('中文.md',bytes('changed note'),20123,10123);await run();assert.equal(new TextDecoder().decode(await remote.readFile('中文.md')),'changed note');
  await remote.writeFile('中文.md',bytes('remote edit'),30123,10123);await run();assert.equal(new TextDecoder().decode(await f.local.readFile('中文.md')),'remote edit');
  await f.local.writeFile('anchor.md',bytes('anchor'),40000,40000);await run();await f.local.rm('中文.md');const deletion=await plan();assert.equal(deletion['中文.md'].decision,'local_is_deleted_thus_also_delete_remote');await run();assert.equal(h.files.size,2);
 });
 it('rejects unsupported empty uploads before folder creation or any file mutation',async()=>{
  const h=harness(),f=setup(),remote=new api.FakeFsEncrypt(new FakeFsBaiduWeb(h.client),'','openssl-base64');
  await f.local.mkdir('new/');await f.local.writeFile('new/empty.md',new ArrayBuffer(0),10000,10000);
  const plan=await api.buildSyncPlan({localEntityList:await f.local.walk(),remoteEntityList:await remote.walk(),prevSyncEntityList:[],fsEncrypt:remote,settings:{...f.settings,serviceType:'baidu'},triggerSource:'manual',configDir:'.obsidian'});
  await assert.rejects(()=>api.doActualSync(plan,f.local,remote,'vault','fixture',5,-1,undefined,f.db,undefined,'keep_newer','manual',undefined,{validatePlan:(p:any)=>assertBaiduWebPlan(p,false)}),/empty_file_unsupported/);
  assert.equal(h.files.size,1);
 });
 it('syncs nonempty files while leaving an empty local file and its existing remote version untouched',async()=>{
  const h=harness(),f=setup(),remote=new api.FakeFsEncrypt(new FakeFsBaiduWeb(h.client),'','openssl-base64');
  const settings={...f.settings,serviceType:'baidu'};
  await f.local.writeFile('empty.md',new ArrayBuffer(0),10000,10000);
  await f.local.writeFile('note.md',bytes('first'),10000,10000);
  const build=async()=>api.buildSyncPlan({localEntityList:await f.local.walk(),remoteEntityList:await remote.walk(),prevSyncEntityList:await api.getAllPrevSyncRecordsByVaultAndProfile(f.db,'vault','fixture'),fsEncrypt:remote,settings,triggerSource:'manual',configDir:'.obsidian'});
  const run=async()=>{const plan=await build();const skipped=skipBaiduEmptyFiles(plan,false);await api.doActualSync(plan,f.local,remote,'vault','fixture',5,-1,undefined,f.db,undefined,'keep_newer','manual',undefined,{validatePlan:(p:any)=>assertBaiduWebPlan(p,false)});return skipped;};
  assert.deepEqual(await run(),['empty.md']);
  assert.equal(new TextDecoder().decode(await remote.readFile('note.md')),'first');
  assert.equal(h.files.has('/notes/empty.md'),false);
  await remote.writeFile('empty.md',bytes('remote content'),11000,11000);
  await f.local.writeFile('note.md',bytes('second'),12000,10000);
  assert.deepEqual(await run(),['empty.md']);
  assert.equal(new TextDecoder().decode(await remote.readFile('note.md')),'second');
  assert.equal(new TextDecoder().decode(await remote.readFile('empty.md')),'remote content');
 });
});

it('preflights OpenSSL overhead against the binary upload limit',()=>{
 const plan={x:{key:'large.pdf',decision:'local_is_created_then_push',local:{size:64*1024*1024}}} as any;
 assert.throws(()=>assertBaiduWebPlan(plan,true),/upload_too_large/);
 assert.doesNotThrow(()=>assertBaiduWebPlan({x:{...plan.x,local:{size:64*1024*1024-64}}} as any,true));
});
