import {SyncCancelledError} from '../syncControl';
import {Platform} from 'obsidian';
import type RemotelySavePlugin from '../main';
import type {RemotelySavePluginSettings} from '../baseTypes';
import {FakeFsBaiduWeb} from '../fsBaiduWeb';
import {BaiduWebProbe,BaiduWebProbeError,type BaiduWebProbeTransport} from './baiduWebProbe';
import {createDesktopBaiduWebTransport} from './baiduWebTransport';
import {BaiduWebSyncClient,baiduWebBinding} from './baiduWebSync';
export function createBaiduWebSyncClient(getSettings:()=>RemotelySavePluginSettings,transport:BaiduWebProbeTransport){
 const settings=getSettings(),binding=baiduWebBinding(settings);
 const guard=()=>{const current=getSettings();if(current.serviceType!=='baidu'||baiduWebBinding(current)!==binding||current.baiduWebPrepared!==binding)throw new BaiduWebProbeError('sync_scope_changed');};
 guard();
 const probe=new BaiduWebProbe(async request=>{guard();const response=await transport(request);guard();return response;});
 probe.restoreSession(settings.baiduWebExperimental!);
 return new FakeFsBaiduWeb(new BaiduWebSyncClient(probe,settings.baiduWebRemoteRoot!,guard));
}
export function getBaiduWebPluginTransport(plugin:RemotelySavePlugin):BaiduWebProbeTransport{
 return async request=>{
  const control=plugin.syncControl;await control?.checkpoint();
  const transport=createDesktopBaiduWebTransport(Platform.isDesktopApp,control?.signal??new AbortController().signal);
  try{return await transport(request);}catch(error){if(control?.signal.aborted)throw new SyncCancelledError();throw error;}
 };
}
