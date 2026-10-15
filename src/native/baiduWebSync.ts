import {getSizeFromOrigToEnc} from '../encryptOpenSSL';
import {isSyncCancelled} from '../syncControl';
import {getSyncTask} from '../syncProgress';
import {createHash,randomBytes} from 'crypto';
import type {Entity,MixedEntity,RemotelySavePluginSettings} from '../baseTypes';
import type {SyncActivity} from '../syncActivity';
import {baiduSyncPath} from './baiduPath';
import {BaiduWebProbe,BaiduWebProbeError,baiduWebRoot} from './baiduWebProbe';
const MAX=64*1024*1024,PART=4*1024*1024;
const marker=/^\.rsnext-baidu-(stage|backup|check)-[a-f0-9]{32}$/;
const hash=(data:ArrayBuffer|Uint8Array,algorithm='sha256')=>createHash(algorithm).update(data instanceof Uint8Array?data:new Uint8Array(data)).digest('hex');
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function baiduWebBinding(settings:RemotelySavePluginSettings):string{
 const session=settings.baiduWebExperimental;if(!session)throw new BaiduWebProbeError('login_required');
 const root=baiduWebRoot(settings.baiduWebRemoteRoot??'');
 if(settings.password&&settings.encryptionMethod!=='openssl-base64')throw new BaiduWebProbeError('encryption_not_yet_supported');
 return digest([session.cookie,session.scopedCookies??[],root,settings.password??'',settings.password?settings.encryptionMethod:'none']);
}
export function baiduWebProfile(settings:RemotelySavePluginSettings){
 const binding=baiduWebBinding(settings),id=settings.baiduWebExperimental?.accountId;
 if(!id)return `baidu-web-v1-${binding}`;
 if(!/^[1-9][0-9]{0,19}$/.test(id))throw new BaiduWebProbeError('invalid_session');
 return `baidu-web-v2-${digest([id,baiduWebRoot(settings.baiduWebRemoteRoot??''),settings.password??'',settings.password?settings.encryptionMethod:'none'])}`;
}
export function createBaiduWebPreparationGuard(getSettings:()=>RemotelySavePluginSettings,root:string){
 const settings=getSettings(),session=settings.baiduWebExperimental,originalRoot=settings.baiduWebRemoteRoot,accountId=session?.accountId;
 const scope=baiduWebBinding({...settings,baiduWebRemoteRoot:root});
 return ()=>{
  const current=getSettings();
  if(current.serviceType!=='baidu'||current.baiduWebExperimental!==session||session?.accountId!==accountId||current.baiduWebRemoteRoot!==originalRoot||baiduWebBinding({...current,baiduWebRemoteRoot:root})!==scope)throw new BaiduWebProbeError('configuration_changed');
 };
}
interface HistoryTable {getItems():Promise<Record<string,unknown>>;getItem<T>(key:string):Promise<T|null>;setItem<T>(key:string,value:T):Promise<T>;}
/** Called only after authenticating the current legacy session's account.
 * Keep originals, and never replace an existing stable-account record. */
export async function migrateBaiduWebHistory(table:HistoryTable,vault:string,from:string,to:string,activities?:Pick<HistoryTable,'getItem'|'setItem'>){
 if(from===to)return;
 const prefix=`${vault}\t${from}\t`,records=await table.getItems();
 for(const [key,value] of Object.entries(records))if(key.startsWith(prefix)&&value&&typeof value==='object'){
  const relative=key.slice(prefix.length);
  if((value as Entity).key!==relative)continue;
  const destination=`${vault}\t${to}\t${relative}`;
  if(await table.getItem(destination)===null)await table.setItem(destination,value);
 }
 if(activities){
  const key=`sync-activities-v1:${vault}`,history=await activities.getItem<SyncActivity[]>(key);
  if(Array.isArray(history))await activities.setItem(key,history.map(record=>record?.profile===from?{...record,profile:to}:record));
 }
}
export function assertBaiduWebPlan(plan:Record<string,MixedEntity>,encrypted:boolean){
 for(const entry of Object.values(plan)){
  if(entry.key.endsWith('/')&&['folder_to_be_deleted_on_remote','folder_to_be_deleted_on_both'].includes(entry.decision??''))throw new BaiduWebProbeError('directory_delete_unsupported');
  const task=getSyncTask(entry);
  if(!encrypted&&task&&['upload','conflict'].includes(task.action)&&entry.local?.size===0)throw new BaiduWebProbeError('empty_file_unsupported');
  if(task&&['upload','download','conflict'].includes(task.action)&&[entry.local?.size===undefined?undefined:encrypted?getSizeFromOrigToEnc(entry.local.size):entry.local.size,entry.remote?.sizeRaw??entry.remote?.size].some(size=>size!==undefined&&size>MAX))throw new BaiduWebProbeError('upload_too_large');
 }
}
/** Preserve unsupported empty sources and any matching remote file, while
 * allowing independent items in the same plan to run. */
export function skipBaiduEmptyFiles(plan:Record<string,MixedEntity>,encrypted:boolean):string[]{
 if(encrypted)return [];
 const skipped:string[]=[];
 for(const entry of Object.values(plan)){
  const task=getSyncTask(entry);
  if(task&&['upload','download','conflict'].includes(task.action)&&entry.local?.size===0){
   entry.decision='unsupported_empty_then_skip';skipped.push(entry.key);
  }
 }
 return skipped.sort();
}
export interface BaiduWebEntry {key:string;path:string;id:string;folder:boolean;size:number;mtime:number;ctime:number;md5?:string;}
export const baiduWebEntity=(entry:BaiduWebEntry):Entity=>({key:entry.key,keyRaw:entry.key,size:entry.size,sizeRaw:entry.size,mtimeCli:entry.mtime,mtimeSvr:entry.mtime,ctimeCli:entry.ctime,etag:digest([entry.id,entry.folder,entry.size,entry.mtime,entry.md5])});
const version=(entry:BaiduWebEntry|undefined)=>entry?JSON.stringify([entry.id,entry.folder,entry.size,entry.mtime,entry.md5]):undefined;
const sameIdentity=(a:BaiduWebEntry,b:BaiduWebEntry|undefined)=>!!b&&a.id===b.id&&a.folder===b.folder&&a.size===b.size&&(!a.md5||!b.md5||a.md5===b.md5);
export class BaiduWebSyncClient {
 private readonly root:string;
 private planned?:Map<string,BaiduWebEntry>;
 constructor(private readonly probe:BaiduWebProbe,root:string,readonly guard:()=>void){this.root=baiduWebRoot(root);}
 private path(key:string){const path=baiduSyncPath(this.root,key);if(key.split('/').some(p=>marker.test(p)))throw new BaiduWebProbeError('reserved_path');return path;}
 private entry(raw:any,parent:string):BaiduWebEntry{
  if(!raw||typeof raw.path!=='string'||baiduWebRoot(raw.path)!==raw.path||(raw.path.slice(0,raw.path.lastIndexOf('/'))||'/')!==parent||![0,1].includes(raw.isdir)||
   !Number.isSafeInteger(raw.size)||raw.size<0||!Number.isSafeInteger(raw.server_mtime)||raw.server_mtime<0||!Number.isSafeInteger(raw.server_ctime)||raw.server_ctime<0||
   !Number.isSafeInteger(raw.server_mtime*1000)||!Number.isSafeInteger(raw.server_ctime*1000)||
   !((typeof raw.fs_id==='string'&&/^[1-9][0-9]*$/.test(raw.fs_id))||(Number.isSafeInteger(raw.fs_id)&&raw.fs_id>0)))throw new BaiduWebProbeError('invalid_metadata');
  const key=raw.path.slice(this.root.length+1)+(raw.isdir?'/':'');
  return {key,path:raw.path,id:String(raw.fs_id),folder:raw.isdir===1,size:raw.size,mtime:raw.server_mtime*1000,ctime:raw.server_ctime*1000,
   md5:typeof raw.md5==='string'&&/^[a-f0-9]{32}$/i.test(raw.md5)?raw.md5.toLowerCase():undefined};
 }
 private async list(parent:string):Promise<BaiduWebEntry[]>{
  const entries:BaiduWebEntry[]=[],seen=new Set<string>(),ids=new Set<string>();
  for(let page=1;page<=100;page++){
   this.guard();const r=await this.probe.webApi('list',{dir:parent,num:'1000',page:String(page),order:'name',desc:'0'});this.guard();
   if(!Array.isArray(r.list)||r.list.length>1000)throw new BaiduWebProbeError('incomplete_listing');
   for(const raw of r.list){const item=this.entry(raw,parent);if(seen.has(item.path)||ids.has(item.id))throw new BaiduWebProbeError('incomplete_listing');seen.add(item.path);ids.add(item.id);entries.push(item);}
   if(r.list.length<1000)return entries;
  }
  throw new BaiduWebProbeError('incomplete_listing');
 }
 private async lookup(path:string){
  this.guard();let r:any;
  try{r=await this.probe.webApi('filemetas',{target:JSON.stringify([path]),dlink:'0'});}
  catch(error){
   if(!(error instanceof BaiduWebProbeError)||error.apiName!=='filemetas'||error.code!=='api_errno_12'||error.itemErrno!==-7)throw error;
   // Some paths are rejected by the direct metadata endpoint. A successful,
   // complete parent listing is an independent source of exact metadata or
   // confirmed absence; -7 itself never means that a file is missing.
   const parent=path.slice(0,path.lastIndexOf('/'))||'/';
   return (await this.list(parent)).find(entry=>entry.path===path);
  }
  this.guard();
  if(!Array.isArray(r.info)||r.info.length>1)throw new BaiduWebProbeError('invalid_metadata');
  if(!r.info.length)return;
  const entry=this.entry(r.info[0],path.slice(0,path.lastIndexOf('/'))||'/');
  if(entry.path!==path)throw new BaiduWebProbeError('invalid_metadata');return entry;
 }
 private expected(key:string,current:BaiduWebEntry|undefined){if(this.planned&&version(this.planned.get(key))!==version(current))throw new BaiduWebProbeError('plan_changed');}
 async scan(onProgress?:(files:number,folders:number)=>void){
  const queue=[this.root],seen=new Set<string>(),entries:BaiduWebEntry[]=[];let files=0,folders=0;
  for(let i=0;i<queue.length;i++)for(const entry of await this.list(queue[i])){
   const reserved=marker.exec(entry.path.slice(entry.path.lastIndexOf('/')+1));
   // An unpublished stage has never replaced the destination. Preserve it,
   // exclude it from the note plan, and allow the source to be uploaded again.
   if(reserved){if(reserved[1]==='stage'&&!entry.folder)continue;throw new BaiduWebProbeError('interrupted_replacement');}
   if(seen.has(entry.id)||entries.length>=100000)throw new BaiduWebProbeError('incomplete_listing');seen.add(entry.id);entries.push(entry);
   if(entry.folder){folders++;queue.push(entry.path);}else files++;onProgress?.(files,folders);
  }
  this.planned=new Map(entries.map(e=>[e.key,e]));return entries;
 }
 async stat(key:string){const entry=await this.lookup(this.path(key));if(!entry)throw new BaiduWebProbeError('not_found');if(entry.folder!==key.endsWith('/'))throw new BaiduWebProbeError('directory_type_mismatch');return entry;}
 async mkdir(key:string){
  if(!key.endsWith('/'))throw new BaiduWebProbeError('invalid_root');const path=this.path(key),before=await this.lookup(path);this.expected(key,before);
  this.guard();await this.probe.ensureRemoteRoot(path);this.guard();const created=await this.stat(key);this.planned?.set(key,created);return created;
 }
 async read(key:string){
  const entry=await this.stat(key);if(entry.folder)throw new BaiduWebProbeError('directory_type_mismatch');this.expected(key,entry);
  this.guard();const bytes=await this.probe.downloadPath(entry.path,entry.size);this.guard();
  if(version(await this.stat(key))!==version(entry))throw new BaiduWebProbeError('plan_changed');return bytes;
 }
 private async uploadNew(path:string,data:ArrayBuffer,mtime:number,ctime:number){
  const bytes=new Uint8Array(data),blocks:string[]=[];
  for(let i=0;i<bytes.length;i+=PART)blocks.push(hash(bytes.subarray(i,i+PART),'md5'));
  if(await this.lookup(path))throw new BaiduWebProbeError('path_conflict');
  const form={path,size:String(bytes.length),isdir:'0',rtype:'0',block_list:JSON.stringify(blocks),local_mtime:String(Math.floor(mtime/1000)),local_ctime:String(Math.floor(ctime/1000))};
  this.guard();const r=await this.probe.webApi('precreate',{}, {...form,autoinit:'1'});this.guard();
  if(r.return_type!==1||typeof r.uploadid!=='string'||!r.uploadid||!Array.isArray(r.block_list)||new Set(r.block_list).size!==r.block_list.length||r.block_list.some((v:any)=>!Number.isInteger(v)||v<0||v>=blocks.length))throw new BaiduWebProbeError('invalid_precreate');
  for(const index of r.block_list){this.guard();const md5=await this.probe.uploadPart(path,r.uploadid,index,bytes.subarray(index*PART,(index+1)*PART));this.guard();if(md5!==blocks[index])throw new BaiduWebProbeError('part_hash_mismatch');}
  this.guard();let responseError:unknown;
  try{await this.probe.webApi('create',{a:'commit'},{...form,uploadid:r.uploadid});}catch(error){responseError=error;}
  this.guard();const entry=await this.lookup(path);
  if(!entry||entry.folder||entry.size!==bytes.length){if(responseError)throw responseError;throw new BaiduWebProbeError('upload_not_confirmed');}
  // Verify bytes once before publishing; a lost commit response is never replayed.
  try{
   if(hash(await this.probe.downloadPath(path,bytes.length))!==hash(bytes))throw new BaiduWebProbeError('upload_not_confirmed');
   if(version(await this.lookup(path))!==version(entry))throw new BaiduWebProbeError('plan_changed');
  }catch(error){
   if(error instanceof BaiduWebProbeError)error.operationStage='verify_upload';
   try{this.guard();await this.deleteOwned(entry);}catch{/* Preserve uncertain stages; scans exclude them without publishing them. */}
   throw error;
  }
  return entry;
 }
 private async renameOwned(entry:BaiduWebEntry,target:string){
  this.guard();if(version(await this.lookup(entry.path))!==version(entry))throw new BaiduWebProbeError('plan_changed');
  if(await this.lookup(target))throw new BaiduWebProbeError('path_conflict');
  const name=target.slice(target.lastIndexOf('/')+1);if(target.slice(0,target.lastIndexOf('/'))!==entry.path.slice(0,entry.path.lastIndexOf('/')))throw new BaiduWebProbeError('invalid_root');
  let failure:unknown;
  try{const r=await this.probe.webApi('filemanager',{opera:'rename',async:'0'},{filelist:JSON.stringify([{path:entry.path,newname:name}]),ondup:'fail'});if(r.info?.some((item:any)=>item.errno!==0))throw new BaiduWebProbeError('rename_not_confirmed');}catch(error){
   if(error instanceof BaiduWebProbeError&&error.itemErrno===-7&&/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(entry.path+target))error.filenameHasSupplementary=true;
   failure=error;
  }
  this.guard();const published=await this.lookup(target),old=await this.lookup(entry.path);
  if(!sameIdentity(entry,published)||old){if(failure)throw failure;throw new BaiduWebProbeError('rename_not_confirmed');}
  return published;
 }
 private async deleteOwned(entry:BaiduWebEntry){
  this.guard();const current=await this.lookup(entry.path);if(!current||version(current)!==version(entry))throw new BaiduWebProbeError('plan_changed');
  if(entry.folder)throw new BaiduWebProbeError('directory_delete_unsupported');
  let failure:unknown;try{const r=await this.probe.webApi('filemanager',{opera:'delete',async:'0'},{filelist:JSON.stringify([entry.path])});if(r.info?.some((i:any)=>i.errno!==0))throw new BaiduWebProbeError('delete_not_confirmed');}catch(error){failure=error;}
  this.guard();if(await this.lookup(entry.path)){if(failure)throw failure;throw new BaiduWebProbeError('delete_not_confirmed');}
 }
 async write(key:string,data:ArrayBuffer,mtime:number,ctime:number){
  const path=this.path(key);if(key.endsWith('/'))throw new BaiduWebProbeError('directory_type_mismatch');
  if(!data.byteLength)throw new BaiduWebProbeError('empty_file_unsupported');if(data.byteLength>MAX)throw new BaiduWebProbeError('upload_too_large');
  if(!Number.isSafeInteger(mtime)||mtime<0||!Number.isSafeInteger(ctime)||ctime<0)throw new BaiduWebProbeError('invalid_metadata');
  const old=await this.lookup(path);this.expected(key,old);if(old?.folder)throw new BaiduWebProbeError('directory_type_mismatch');
  let oldHash:string|undefined;if(old){oldHash=hash(await this.probe.downloadPath(old.path,old.size));if(version(await this.lookup(path))!==version(old))throw new BaiduWebProbeError('plan_changed');}
  const parent=path.slice(0,path.lastIndexOf('/')),id=randomBytes(16).toString('hex');
  const stage=await this.uploadNew(`${parent}/.rsnext-baidu-stage-${id}`,data,mtime,ctime);
  let backup:BaiduWebEntry|undefined,published:BaiduWebEntry|undefined;
  try{
   this.guard();if(version(await this.lookup(path))!==version(old))throw new BaiduWebProbeError('plan_changed');
   if(old){if(hash(await this.probe.downloadPath(path,old.size))!==oldHash)throw new BaiduWebProbeError('plan_changed');backup=await this.renameOwned(old,`${parent}/.rsnext-baidu-backup-${id}`);}
   published=await this.renameOwned(stage,path);
   // MD5 is a server content token (not assumed to equal a local plain MD5).
   // Rename may change timestamps. Reuse the staged byte verification only
   // when the published identity, size and content token still match.
   const current=await this.lookup(path);
   if(!sameIdentity(stage,current))throw new BaiduWebProbeError('plan_changed');
   if(!stage.md5||!current!.md5){if(hash(await this.probe.downloadPath(path,stage.size))!==hash(data))throw new BaiduWebProbeError('upload_not_confirmed');}
   if(version(await this.lookup(path))!==version(current))throw new BaiduWebProbeError('plan_changed');
   if(backup){if(hash(await this.probe.downloadPath(backup.path,backup.size))!==oldHash)throw new BaiduWebProbeError('plan_changed');await this.deleteOwned(backup);}
  }catch(error){
   // Preserve backups when a stopped request or a third-party edit makes the
   // outcome uncertain. Never overwrite a newly appeared destination.
   if(backup&&!published){try{this.guard();if(!await this.lookup(path))await this.renameOwned(backup,path);}catch{if(isSyncCancelled(error))throw error;throw new BaiduWebProbeError('interrupted_replacement');}}
   try{this.guard();const remaining=await this.lookup(stage.path);if(remaining?.id===stage.id)await this.deleteOwned(remaining);}catch{/* Marker blocks the next scan; no silent deletion. */}
   throw error;
  }
  const result=await this.stat(key);this.planned?.set(key,result);return result;
 }
 async verifyReplacement(id:string){
  if(!/^[a-f0-9]{32}$/.test(id))throw new BaiduWebProbeError('invalid_probe_id');
  const directory=`${this.root}/.rsnext-baidu-check-${id}`;
  if(await this.lookup(directory))throw new BaiduWebProbeError('path_conflict');
  this.guard();await this.probe.ensureRemoteRoot(directory);
  const client=new BaiduWebSyncClient(this.probe,directory,this.guard);
  let completed=false;
  try{
   const first=new TextEncoder().encode('RSNX').buffer,second=new TextEncoder().encode('RSNEXT!').buffer;
   const a=await client.write('a.bin',first,Date.now(),Date.now()),b=await client.write('b.bin',second,Date.now(),Date.now());
   let refused=false;
   try{const r=await this.probe.webApi('filemanager',{opera:'rename',async:'0'},{filelist:JSON.stringify([{path:a.path,newname:'b.bin'}]),ondup:'fail'});refused=Array.isArray(r.info)&&r.info.some((item:any)=>item.errno===-8);}
   catch(error){refused=error instanceof BaiduWebProbeError&&(error.code==='api_errno_-8'||error.itemErrno===-8);}
   this.guard();
   if(!refused||(await client.stat('a.bin')).id!==a.id||(await client.stat('b.bin')).id!==b.id)throw new BaiduWebProbeError('rename_refusal_not_verified');
   await client.write('a.bin',second,Date.now(),Date.now());
   if(hash(await client.read('a.bin'))!==hash(second))throw new BaiduWebProbeError('overwrite_not_verified');
   await client.remove('a.bin');await client.remove('b.bin');completed=true;
  }finally{
   // Only a successful isolated check may remove its now-empty scratch folder.
   // Failed markers are retained, and scans stop rather than sync them as notes.
   if(completed){
    this.guard();if((await client.list(directory)).length)throw new BaiduWebProbeError('cleanup_not_confirmed');
    await this.probe.webApi('filemanager',{opera:'delete',async:'0'},{filelist:JSON.stringify([directory])});
    if(await this.lookup(directory))throw new BaiduWebProbeError('cleanup_not_confirmed');
   }
  }
 }
 async remove(key:string){const entry=await this.stat(key);this.expected(key,entry);await this.deleteOwned(entry);this.planned?.delete(key);}
}
