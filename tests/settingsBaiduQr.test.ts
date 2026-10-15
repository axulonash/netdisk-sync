import {strict as assert} from 'assert';
import {JSDOM} from 'jsdom';
import {renderBaiduQrTest} from '../src/settingsBaiduQr';
describe('Baidu QR plugin test screen',()=>{
 function fixture(result={upload:true,download:true,cleanup:true}){
  const dom=new JSDOM('<main></main>');const parent=dom.window.document.querySelector('main')!;
  const plugin:any={settings:{serviceType:'baidu'},nativeMaintenance:false,isSyncing:false,saveSettings:async()=>{}};
  let completed:()=>void=()=>{};let close=0;const verified:string[]=[];
  const cleanup=renderBaiduQrTest(parent,plugin,{openLogin:done=>{completed=done;return ()=>{close++;};},verify:async(root:string)=>{verified.push(root);return result;}},true);
  return {dom,parent,plugin,cleanup,complete:()=>completed(),closes:()=>close,verified};
 }
 it('offers only QR login without application key, secret or authorization code fields',()=>{
  const f=fixture();assert.equal(f.parent.querySelectorAll('input:not([type=radio]):not([data-field=remoteRoot])').length,0);assert.ok(f.parent.textContent!.includes('扫码登录'));
  assert.ok(!f.parent.textContent!.includes('AppKey')&&!f.parent.textContent!.includes('AppSecret')&&!f.parent.textContent!.includes('授权码'));f.cleanup();
 });
 it('refreshes persisted login state and verifies read/write and enables sync only after a successful folder preparation',async()=>{
  const f=fixture();(f.parent.querySelector('[data-action="login"]') as HTMLButtonElement).click();
  f.plugin.settings.baiduWebExperimental={cookie:'BDUSS=fixture',csrf:'csrf'};f.complete();
  assert.ok(f.parent.textContent!.includes('已登录'));
  (f.parent.querySelector('[data-action="verify"]') as HTMLButtonElement).click();
  await new Promise(r=>setTimeout(r,0));assert.ok(f.parent.textContent!.includes('上传通过')&&f.parent.textContent!.includes('下载通过'));
  assert.equal((f.parent.querySelector('[data-action="sync"]') as HTMLButtonElement).disabled,false);f.cleanup();
 });
 it('closes pending login when navigating away and does not expose login on mobile',()=>{
  const f=fixture();(f.parent.querySelector('[data-action="login"]') as HTMLButtonElement).click();f.cleanup();assert.equal(f.closes(),1);
  const dom=new JSDOM('<main></main>');const p=dom.window.document.querySelector('main')!;
  const cleanup=renderBaiduQrTest(p,{settings:{}} as any,{openLogin:()=>{throw Error('mobile');},verify:async()=>({}) as any},false);
  assert.equal(p.querySelector('[data-action="login"]'),null);assert.ok(p.textContent!.includes('电脑'));cleanup();
 });
 it('persists service changes and lets the user return to WebDAV',async()=>{
  const f=fixture();const radio=f.parent.querySelector('input[value="webdav"]') as HTMLInputElement;
  radio.checked=true;radio.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
  await new Promise(r=>setTimeout(r,0));assert.equal(f.plugin.settings.serviceType,'webdav');f.cleanup();
 });

 it('uses the entered directory for preparation and persists it only after success',async()=>{
  const f=fixture();f.plugin.settings.baiduWebExperimental={cookie:'BDUSS=fixture',csrf:'csrf'};f.complete();
  const directory=f.parent.querySelector('[data-field="remoteRoot"]') as HTMLInputElement;
  assert.ok(directory);directory.value='/国内同步/我的笔记';directory.dispatchEvent(new f.dom.window.Event('input'));
  (f.parent.querySelector('[data-action="verify"]') as HTMLButtonElement).click();await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(f.verified,['/国内同步/我的笔记']);assert.equal(f.plugin.settings.baiduWebRemoteRoot,'/国内同步/我的笔记');f.cleanup();
 });

 it('keeps the last saved folder when read/write verification fails',async()=>{
  const f=fixture({upload:true,download:false,cleanup:true});f.plugin.settings.baiduWebExperimental={cookie:'BDUSS=fixture',csrf:'csrf'};f.plugin.settings.baiduWebRemoteRoot='/old';f.complete();
  const directory=f.parent.querySelector('[data-field="remoteRoot"]') as HTMLInputElement;directory.value='/new';directory.dispatchEvent(new f.dom.window.Event('input'));
  (f.parent.querySelector('[data-action="verify"]') as HTMLButtonElement).click();await new Promise(r=>setTimeout(r,0));
  assert.equal(f.plugin.settings.baiduWebRemoteRoot,'/old');assert.equal((f.parent.querySelector('.rsnext-connection-light') as HTMLElement).dataset.state,'failure');f.cleanup();
 });
 it('rolls back the folder if saving settings fails after successful verification',async()=>{
  const f=fixture();f.plugin.settings.baiduWebExperimental={cookie:'BDUSS=fixture',csrf:'csrf'};f.plugin.settings.baiduWebRemoteRoot='/old';f.complete();f.plugin.saveSettings=async()=>{throw Error('private-cookie');};
  const directory=f.parent.querySelector('[data-field="remoteRoot"]') as HTMLInputElement;directory.value='/new';directory.dispatchEvent(new f.dom.window.Event('input'));
  (f.parent.querySelector('[data-action="verify"]') as HTMLButtonElement).click();await new Promise(r=>setTimeout(r,0));
  assert.equal(f.plugin.settings.baiduWebRemoteRoot,'/old');assert.ok(f.parent.textContent!.includes('save_failed'));assert.ok(!f.parent.textContent!.includes('private-cookie'));f.cleanup();
 });

});
