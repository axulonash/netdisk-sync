import {BaiduWebSyncClient,baiduWebProfile,migrateBaiduWebHistory,createBaiduWebPreparationGuard} from './baiduWebSync';
import {Buffer} from 'buffer';
import {Modal,Notice,Platform} from 'obsidian';
import type RemotelySavePlugin from '../main';
import {BaiduWebProbe,BaiduWebProbeError} from './baiduWebProbe';
import {createDesktopBaiduWebTransport} from './baiduWebTransport';
const message=(error:unknown)=>`百度扫码验证未完成 [${error instanceof BaiduWebProbeError?error.code:'operation_failed'}]`;
export class BaiduQrLoginModal extends Modal {
 private readonly controller=new AbortController();
 private readonly probe:BaiduWebProbe;
 private cancelled=false;
 private running=false;
 private doneCalled=false;
 private timer?:ReturnType<typeof setTimeout>;
 private expiry?:ReturnType<typeof setTimeout>;
 constructor(private readonly plugin:RemotelySavePlugin,private readonly done:()=>void){
  super(plugin.app);this.probe=new BaiduWebProbe(createDesktopBaiduWebTransport(Platform.isDesktopApp,this.controller.signal));
 }
 private finish(){if(this.cancelled&&!this.running&&!this.doneCalled){this.doneCalled=true;this.done();}}
 async onOpen(){
  this.running=true;
  const previous=this.plugin.settings.baiduWebExperimental;
  this.contentEl.createEl('h2',{text:'百度网盘扫码登录'});
  const status=this.contentEl.createEl('p',{text:'正在获取百度官方二维码…'});status.setAttribute('role','status');
  const stop=()=>{if(this.timer)clearTimeout(this.timer);if(this.expiry)clearTimeout(this.expiry);};
  try{
   const url=await this.probe.start();
   const transport=createDesktopBaiduWebTransport(Platform.isDesktopApp,this.controller.signal);
   const image=await transport({url,method:'GET',maxBytes:512*1024});
   if(this.cancelled)return;
   if(image.status!==200||image.body.length<8||[137,80,78,71,13,10,26,10].some((v,i)=>image.body[i]!==v))throw new BaiduWebProbeError('invalid_qr_image');
   const src=`data:image/png;base64,${Buffer.from(image.body).toString('base64')}`;
   this.contentEl.createEl('img',{attr:{src,alt:'使用百度网盘 App 扫码登录',width:'240',height:'240'}});
   status.textContent='使用百度网盘 App 扫码并确认，登录成功后自动完成。二维码约 3 分钟有效。';
   const check=async()=>{
    if(this.cancelled||this.running)return;this.running=true;
    try{
     const state=await this.probe.check();if(this.cancelled)return;
     if(state!=='logged_in'){status.textContent=state==='scanned'?'已扫码，请在手机上确认登录。':'等待扫码，正在自动检查…';this.timer=setTimeout(check,1000);return;}
     stop();
     if(this.plugin.settings.serviceType!=='baidu'||this.plugin.settings.baiduWebExperimental!==previous)throw new BaiduWebProbeError('configuration_changed');
     const session=this.probe.sessionSnapshot();
     this.plugin.settings.baiduWebExperimental=session;
     try{await this.plugin.saveSettings();}catch{if(this.plugin.settings.baiduWebExperimental===session)this.plugin.settings.baiduWebExperimental=previous;throw new BaiduWebProbeError('save_failed');}
     if(!this.cancelled){new Notice('百度扫码登录成功，请验证文件读写。');this.close();}
    }catch(error){if(!this.cancelled){stop();status.textContent=message(error);}}
    finally{this.running=false;this.finish();}
   };
   this.expiry=setTimeout(()=>{stop();this.probe.cancel();this.controller.abort();if(!this.cancelled)status.textContent='二维码已过期，请关闭窗口后重新扫码。';},180000);
   this.timer=setTimeout(check,1000);
  }catch(error){if(!this.cancelled)status.textContent=message(error);}
  finally{this.running=false;this.finish();}
 }
 onClose(){this.cancelled=true;if(this.timer)clearTimeout(this.timer);if(this.expiry)clearTimeout(this.expiry);this.probe.cancel();this.controller.abort();this.contentEl.empty();this.finish();}
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
