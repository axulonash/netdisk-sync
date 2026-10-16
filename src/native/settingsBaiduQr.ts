import {BaiduWebSyncClient,baiduWebProfile,migrateBaiduWebHistory,createBaiduWebPreparationGuard} from './baiduWebSync';
import {Buffer} from 'buffer';
import {Modal,Notice,Platform} from 'obsidian';
import type RemotelySavePlugin from '../main';
import {BaiduWebProbe,BaiduWebProbeError} from './baiduWebProbe';
import {createDesktopBaiduWebTransport} from './baiduWebTransport';
const message=(error:unknown)=>`百度扫码验证未完成 [${error instanceof BaiduWebProbeError?error.code:'operation_failed'}]`;
interface BaiduQrLoginState {
 cancelled:boolean;
 running:boolean;
 doneCalled:boolean;
 timer?:ReturnType<typeof setTimeout>;
 expiry?:ReturnType<typeof setTimeout>;
}
/** Disposer for an inline QR login; `ready` resolves after the first fetch. */
export type BaiduQrLoginHandle=(()=>void)&{ready:Promise<void>};
/** Renders the Baidu QR login into `host`, polls until the keyless session is
 * saved, then calls `done` once. Reused verbatim by the inline settings block
 * and, via delegation, by BaiduQrLoginModal. */
export function renderBaiduQrLoginBlock(host:HTMLElement,plugin:RemotelySavePlugin,done:()=>void):BaiduQrLoginHandle {
 const doc=host.ownerDocument;
 const controller=new AbortController();
 const probe=new BaiduWebProbe(createDesktopBaiduWebTransport(Platform.isDesktopApp,controller.signal));
 const state:BaiduQrLoginState={cancelled:false,running:false,doneCalled:false};
 const stop=()=>{if(state.timer)clearTimeout(state.timer);if(state.expiry)clearTimeout(state.expiry);};
 const finish=()=>{if(state.cancelled&&!state.running&&!state.doneCalled){state.doneCalled=true;done();}};
 const append=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const node=doc.createElement(tag);node.textContent=text;host.append(node);return node;};
 const ready=(async()=>{
  state.running=true;
  const previous=plugin.settings.baiduWebExperimental;
  append('h2','百度网盘扫码登录');
  const status=append('p','正在获取百度官方二维码…');status.setAttribute('role','status');
  try{
   const url=await probe.start();
   const transport=createDesktopBaiduWebTransport(Platform.isDesktopApp,controller.signal);
   const image=await transport({url,method:'GET',maxBytes:512*1024});
   if(state.cancelled)return;
   if(image.status!==200||image.body.length<8||[137,80,78,71,13,10,26,10].some((v,i)=>image.body[i]!==v))throw new BaiduWebProbeError('invalid_qr_image');
   const img=doc.createElement('img');
   img.setAttribute('src',`data:image/png;base64,${Buffer.from(image.body).toString('base64')}`);
   img.setAttribute('alt','使用百度网盘 App 扫码登录');img.setAttribute('width','240');img.setAttribute('height','240');
   host.append(img);
   status.textContent='使用百度网盘 App 扫码并确认，登录成功后自动完成。二维码约 3 分钟有效。';
   const check=async()=>{
    if(state.cancelled||state.running)return;state.running=true;
    try{
     const s=await probe.check();if(state.cancelled)return;
     if(s!=='logged_in'){status.textContent=s==='scanned'?'已扫码，请在手机上确认登录。':'等待扫码，正在自动检查…';state.timer=setTimeout(check,1000);return;}
     stop();
     if(plugin.settings.serviceType!=='baidu'||plugin.settings.baiduWebExperimental!==previous)throw new BaiduWebProbeError('configuration_changed');
     const session=probe.sessionSnapshot();
     plugin.settings.baiduWebExperimental=session;
     try{await plugin.saveSettings();}catch{if(plugin.settings.baiduWebExperimental===session)plugin.settings.baiduWebExperimental=previous;throw new BaiduWebProbeError('save_failed');}
     if(!state.cancelled){new Notice('百度扫码登录成功，请验证文件读写。');state.doneCalled=true;done();}
    }catch(error){if(!state.cancelled){stop();status.textContent=message(error);}}
    finally{state.running=false;finish();}
   };
   state.expiry=setTimeout(()=>{stop();probe.cancel();controller.abort();if(!state.cancelled)status.textContent='二维码已过期，请关闭窗口后重新扫码。';},180000);
   state.timer=setTimeout(check,1000);
  }catch(error){if(!state.cancelled)status.textContent=message(error);}
  finally{state.running=false;finish();}
 })();
 const cleanup=()=>{state.cancelled=true;stop();probe.cancel();controller.abort();finish();};
 return Object.assign(cleanup,{ready});
}
export class BaiduQrLoginModal extends Modal {
 private cleanup?:()=>void;
 constructor(private readonly plugin:RemotelySavePlugin,private readonly done:()=>void){
  super(plugin.app);
 }
 async onOpen(){
  const block=renderBaiduQrLoginBlock(this.contentEl,this.plugin,()=>{this.done();this.close();});
  this.cleanup=block;
  await block.ready;
 }
 onClose(){this.cleanup?.();this.contentEl.empty();}
}
export async function verifyBaiduQrSession(plugin:RemotelySavePlugin,root:string){
 const session=plugin.settings.baiduWebExperimental;
 if(!session)throw new BaiduWebProbeError('login_required');
 const guard=createBaiduWebPreparationGuard(()=>plugin.settings,root);guard();
 const controller=new AbortController(),probe=new BaiduWebProbe(createDesktopBaiduWebTransport(Platform.isDesktopApp,controller.signal));
 try{
  probe.restoreSession(session);await probe.listRoot();
  const oldProfile=plugin.settings.baiduWebRemoteRoot===root?baiduWebProfile(plugin.settings):undefined,accountId=await probe.resolveAccountId();
  guard();
  const id=Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  await probe.ensureRemoteRoot(root);
  guard();
  const result=await probe.verifyReadWrite(id,root);
  if(result.upload&&result.download&&result.cleanup){
   try{const client=new BaiduWebSyncClient(probe,root,guard);await client.scan();await client.verifyReplacement(id);}
   catch(error){result.upload=false;result.cleanup=false;result.cleanupFailure='replacement_cleanup_not_confirmed';result.failure=error instanceof BaiduWebProbeError?error.code:'overwrite_not_verified';}
  }
  if(result.upload&&result.download&&result.cleanup){
   guard();
   // The selected root is saved by the caller after this check. Compute the
   // destination scope with that root, and migrate only when the root matches.
   if(oldProfile&&plugin.settings.baiduWebRemoteRoot===root&&plugin.db?.prevSyncRecordsTbl){
    const targetProfile=baiduWebProfile({...plugin.settings,baiduWebExperimental:{...session,accountId}});
    await migrateBaiduWebHistory(plugin.db.prevSyncRecordsTbl,plugin.vaultRandomID,oldProfile,targetProfile,plugin.db.simpleKVForMiscTbl);
   }
   guard();
   session.accountId=accountId;
  }
  return result;
 }finally{probe.cancel();controller.abort();}
}
