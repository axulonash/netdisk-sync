import type RemotelySavePlugin from './main';
/** Reuses the start button as pause/resume, with a separate stop control. */
export function createSyncControls(run:HTMLButtonElement, plugin:RemotelySavePlugin) {
 const stop=run.ownerDocument.createElement('button');stop.type='button';stop.textContent='停止';stop.dataset.action='stop';
 stop.title='停止后保留已完成的文件；当前请求完成后结束';run.after(stop);
 run.addEventListener('click',event=>{
  if(!plugin.isSyncing)return;
  event.preventDefault();event.stopImmediatePropagation();plugin.toggleSyncPause();
 },true);
 stop.onclick=()=>plugin.stopSync();
 return ()=>{
  const state=plugin.syncControl?.state;
  if(plugin.isSyncing) {
   run.disabled=!state||state==='stopping';
   run.textContent=state==='paused'?'继续':state==='stopping'?'停止中…':'暂停';
   run.title=state==='paused'?'继续执行本次计划':'暂停后等待当前请求完成';
  }else run.textContent='立即同步';
  stop.disabled=!plugin.isSyncing||!state||state==='stopping';
 };
}
