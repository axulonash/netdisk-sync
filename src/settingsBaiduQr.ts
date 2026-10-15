import {baiduWebBinding} from './native/baiduWebSync';
import {createSyncControls} from './syncControlsUi';
import {createSyncProgress,appendProgressResult} from './syncProgressUi';
import {baiduWebRoot} from './native/baiduWebProbe';
import type RemotelySavePlugin from './main';
import {createServicePicker} from './settingsServicePicker';
export interface BaiduQrTestActions {
 openLogin(done:()=>void):()=>void;
 verify(root:string):Promise<{upload:boolean;download:boolean;cleanup:boolean;failure?:string;cleanupFailure?:string}>;
}
/** Visible experimental boundary: a web session must never run the OAuth adapter. */
export function renderBaiduQrTest(parent:HTMLElement,plugin:RemotelySavePlugin,actions:BaiduQrTestActions,desktop:boolean,redisplay:()=>void=()=>{}){
 const doc=parent.ownerDocument;
 const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='',cls='')=>{const node=doc.createElement(tag);node.textContent=text;node.className=cls;return node;};
 const root=el('div','','rsnext-settings');parent.append(root);
 const service=createServicePicker(doc,'baidu',plugin.settings.legacyServiceType);
 root.append(service,el('h2','remotely-save-next'));
 let disposed=false,busy=false,closeLogin:(()=>void)|undefined;
 service.onchange=async()=>{
  if(disposed||busy||plugin.isSyncing||plugin.nativeMaintenance){for(const input of service.querySelectorAll('input'))input.checked=input.value===plugin.settings.serviceType;return;}
  const previous=plugin.settings.serviceType;service.disabled=true;
  try{plugin.settings.serviceType=service.value as any;await plugin.saveSettings();if(!disposed)redisplay();}
  catch{plugin.settings.serviceType=previous;for(const input of service.querySelectorAll('input'))input.checked=input.value===previous;}
  finally{if(!disposed)service.disabled=false;}
 };
 if(!desktop){root.append(el('p','请在电脑端 Obsidian 测试百度扫码登录。'));return ()=>{disposed=true;};}
 const ready=()=>{try{return directory.value.trim()===plugin.settings.baiduWebRemoteRoot&&plugin.settings.baiduWebPrepared===baiduWebBinding(plugin.settings);}catch{return false;}};
 const login=el('button','扫码登录','mod-cta'),logout=el('button','退出登录'),verify=el('button','验证文件读写'),sync=el('button','立即同步'),account=el('p'),status=el('p');
 login.dataset.action='login';verify.dataset.action='verify';sync.dataset.action='sync';status.setAttribute('role','status');
 const directory=el('input'),label=el('label','同步文件夹'),directoryRow=el('div','','rsnext-row'),directoryBox=el('div','','rsnext-address-control'),light=el('span','','rsnext-connection-light');
 directory.id=`baidu-root-${Math.random().toString(36).slice(2)}`;label.htmlFor=directory.id;
 directory.type='text';directory.dataset.field='remoteRoot';directory.spellcheck=false;
 directory.value=plugin.settings.baiduWebRemoteRoot??plugin.settings.baiduNative?.remoteRoot??`/remotely-save-next/${plugin.app?.vault?.getName?.()??'我的笔记'}`;
 light.dataset.state='idle';light.setAttribute('role','status');light.setAttribute('aria-label','尚未验证');
 directoryBox.append(directory,verify,light);directoryRow.append(label,directoryBox);
 directory.oninput=()=>{light.dataset.state='idle';light.setAttribute('aria-label','目录已更改，尚未验证');status.textContent='目录已更改，请重新准备同步文件夹。';plugin.settings.baiduWebPrepared=undefined;update();};
 verify.textContent='准备同步文件夹';
 root.append(el('h3','1. 扫码登录'),account,login,logout,el('hr'),el('h3','2. 选择同步文件夹'),directoryRow,
  el('p','不存在时自动创建；读写验证通过后保存。'),status,el('hr'),sync,
  el('p','暂仅支持电脑端手动同步；单文件最多 64 MiB。未加密空文件会跳过并列入记录；远端目录删除会在执行前提示。','rsnext-hint'));
 const syncStatus=el('p',plugin.syncUiStatus??'尚未同步','rsnext-status');root.append(syncStatus);
 const updateProgress=createSyncProgress(syncStatus,()=>plugin.syncUiActivity),updateControls=createSyncControls(sync,plugin);
 const conflicts=el('select'),conflictLabel=el('label','文件冲突时');conflicts.id='baidu-conflict-policy';conflictLabel.htmlFor=conflicts.id;
 for(const [value,title] of [['keep_newer','保留较新文件（推荐）'],['keep_both','保留双方副本']]){const option=el('option',title);option.value=value;conflicts.append(option);}
 conflicts.value=plugin.settings.conflictAction??'keep_newer';
 root.insertBefore(conflictLabel,sync);root.insertBefore(conflicts,sync);
 conflicts.onchange=async()=>{if(busy||plugin.isSyncing||plugin.nativeMaintenance)return;const previous=plugin.settings.conflictAction;plugin.settings.conflictAction=conflicts.value as any;try{await plugin.saveSettings();}catch{plugin.settings.conflictAction=previous;conflicts.value=previous??'keep_newer';}};
 sync.onclick=()=>{if(!busy&&!plugin.nativeMaintenance&&!plugin.isSyncing&&ready())void plugin.syncRun('manual').catch(()=>{if(!disposed)syncStatus.textContent='同步未完成，请查看同步记录。';});};
 const historyDetails=el('details'),history=el('div');historyDetails.append(el('summary','同步记录'),history);root.append(historyDetails);
 let records:import('./syncActivity').SyncActivity[]=[];
 const paintHistory=()=>{
  const open=new Set(Array.from(history.querySelectorAll('details[open]')).map(n=>(n as HTMLElement).dataset.id));history.replaceChildren();
  const active=plugin.syncUiActivity,all=active?.status==='running'?[active,...records.filter(r=>r.id!==active.id)]:records;
  if(!all.length)history.append(el('p','还没有同步记录'));
  const labels={running:'同步中',success:'已完成',unchanged:'没有变化',partial:'部分完成',failed:'失败',paused:'已暂停',cancelled:'已停止'};
  for(const record of all.slice(0,20)){
   const item=el('details');item.dataset.id=record.id;item.open=open.has(record.id);
   item.append(el('summary',`${new Date(record.startedAt).toLocaleString()} · ${labels[record.status]} · 上传 ${record.counts.upload} / 下载 ${record.counts.download} / 删除 ${record.counts.delete}`));
   appendProgressResult(item,record);if(record.error)item.append(el('p',record.error));
   if(record.failedPaths.length){item.append(el('h4','未完成的文件'));const paths=el('ul');for(const path of record.failedPaths)paths.append(el('li',path));item.append(paths);}
   if(record.skippedPaths?.length){item.append(el('h4','跳过的空文件'));const paths=el('ul');for(const path of record.skippedPaths)paths.append(el('li',path));item.append(paths);}
   for(const [action,label] of [['upload','上传'],['download','下载'],['delete','删除']] as const){
    if(!record.files[action].length)continue;item.append(el('h4',label));const paths=el('ul');
    for(const path of record.files[action])paths.append(el('li',path));item.append(paths);
   }
   history.append(item);
  }
 };
 const refreshHistory=async()=>{try{const next=await plugin.getSyncActivities?.()??[];if(!disposed){records=next;paintHistory();}}catch{if(!disposed)history.textContent='同步记录暂时无法读取。';}};
 historyDetails.ontoggle=()=>{if(historyDetails.open)void refreshHistory();};
 let lastRecord='';
 const unsubscribe=plugin.onSyncUiUpdate?.(()=>{if(disposed)return;syncStatus.textContent=plugin.syncUiStatus;update();if(historyDetails.open){if(plugin.isSyncing)paintHistory();else{const current=`${plugin.syncUiActivity?.id}:${plugin.syncUiActivity?.status}`;if(current!==lastRecord){lastRecord=current;void refreshHistory();}}}});
 function update(){if(disposed)return;service.disabled=busy||plugin.isSyncing||plugin.nativeMaintenance;conflicts.disabled=service.disabled;const logged=!!plugin.settings.baiduWebExperimental;account.textContent=logged?'已登录':'未登录';login.textContent=logged?'重新扫码登录':'扫码登录';logout.hidden=!logged;login.disabled=busy||plugin.isSyncing||plugin.nativeMaintenance;logout.disabled=login.disabled;directory.disabled=login.disabled||!logged;verify.disabled=login.disabled||!logged||!directory.value.trim();sync.disabled=busy||plugin.nativeMaintenance||!ready();updateProgress();updateControls();}
 login.onclick=()=>{
  if(busy||plugin.isSyncing||plugin.nativeMaintenance)return;
  busy=true;plugin.nativeMaintenance=true;update();
  try{closeLogin=actions.openLogin(()=>{closeLogin=undefined;busy=false;plugin.nativeMaintenance=false;update();});}
  catch{busy=false;plugin.nativeMaintenance=false;status.textContent='无法打开扫码窗口，请重试。';update();}
 };
 logout.onclick=async()=>{
  if(busy||plugin.isSyncing||plugin.nativeMaintenance)return;
  busy=true;plugin.nativeMaintenance=true;const previous=plugin.settings.baiduWebExperimental;
  try{plugin.settings.baiduWebExperimental=undefined;await plugin.saveSettings();status.textContent='已退出扫码登录。';}
  catch{if(!plugin.settings.baiduWebExperimental)plugin.settings.baiduWebExperimental=previous;status.textContent='退出登录未保存，请重试。';}
  finally{busy=false;plugin.nativeMaintenance=false;update();}
 };
 verify.onclick=async()=>{
  if(busy||plugin.isSyncing||plugin.nativeMaintenance||!plugin.settings.baiduWebExperimental)return;
  busy=true;plugin.nativeMaintenance=true;plugin.settings.baiduWebPrepared=undefined;update();status.textContent='正在准备同步文件夹及验证读写…';light.dataset.state='testing';
  try{
   const selected=baiduWebRoot(directory.value),session=plugin.settings.baiduWebExperimental;
   const result=await actions.verify(selected);if(disposed)return;
   if(plugin.settings.serviceType!=='baidu'||plugin.settings.baiduWebExperimental!==session)throw {code:'configuration_changed'};
   const passed=result.upload&&result.download&&result.cleanup;
   if(passed){const previous=plugin.settings.baiduWebRemoteRoot,previousPrepared=plugin.settings.baiduWebPrepared;plugin.settings.baiduWebRemoteRoot=selected;plugin.settings.baiduWebPrepared=baiduWebBinding(plugin.settings);
    try{await plugin.saveSettings();}catch{if(plugin.settings.baiduWebRemoteRoot===selected){plugin.settings.baiduWebRemoteRoot=previous;plugin.settings.baiduWebPrepared=previousPrepared;}throw {code:'save_failed'};}
    directory.value=selected;
   }
   light.dataset.state=passed?'success':'failure';light.setAttribute('aria-label',passed?'文件夹已准备好':'文件夹准备未通过');
   status.textContent=`上传${result.upload?'通过':'未通过'} · 下载${result.download?'通过':'未通过'} · 清理${result.cleanup?'通过':'未通过'}`;
   for(const code of [result.failure,result.cleanupFailure])if(code&&/^[a-z0-9_-]{1,80}$/.test(code))status.textContent+=` [${code}]`;
  }catch(error){light.dataset.state='failure';light.setAttribute('aria-label','文件夹准备未通过');if(!disposed)status.textContent=`验证未完成 [${typeof (error as any)?.code==='string'&&/^[a-z0-9_-]{1,80}$/.test((error as any).code)?(error as any).code:'operation_failed'}]`;}
  finally{busy=false;plugin.nativeMaintenance=false;update();}
 };
 update();return ()=>{disposed=true;unsubscribe?.();closeLogin?.();};
}
