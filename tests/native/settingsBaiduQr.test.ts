import * as nodeCrypto from 'crypto';
import {strict as assert} from 'assert';
import {buildSync} from 'esbuild';
import {JSDOM} from 'jsdom';
const fixture=()=> (globalThis as any).__baiduQrModalTest;
const bundle=buildSync({entryPoints:['src/native/settingsBaiduQr.ts'],bundle:true,write:false,platform:'node',format:'cjs',alias:{obsidian:'qr-obsidian-test-stub'},external:['qr-obsidian-test-stub','node:https']}).outputFiles[0].text;
const moduleFixture:{exports:any}={exports:{}};
new Function('module','exports','require',bundle)(moduleFixture,moduleFixture.exports,(name:string)=>{
 if(name==='buffer')return {Buffer};
 if(name==='crypto'||name==='node:crypto')return nodeCrypto;
 if(name==='qr-obsidian-test-stub')return {
  Platform:{isDesktopApp:true},Notice:class{constructor(){}},
  Modal:class{
   contentEl=fixture().content;
   constructor(_app:any){}
   close(){(this as any).onClose();}
  }
 };
 if(name==='node:https')return {
  Agent:class{},
  request:(_url:any,_options:any,callback:any)=>{
   const request:any=new (require('events').EventEmitter)();
   request.setTimeout=()=>request;request.destroy=()=>{};
   request.end=()=>queueMicrotask(()=>{
    const data=fixture().responses.shift();if(!data){request.emit('error',Error('unexpected request'));return;}
    const response:any=new (require('events').EventEmitter)();response.statusCode=200;response.headers={'set-cookie':data.cookies??[]};response.complete=true;response.destroy=()=>{};
    callback(response);if(data.body)response.emit('data',data.body);else response.emit('data',Buffer.from(JSON.stringify(data.json)));response.emit('end');
   });return request;
  }
 };
 throw Error('Unexpected dependency '+name);
});
describe('Baidu QR modal integration',()=>{
 it('shows a PNG, polls login automatically and persists a keyless session',async function(){
  this.timeout(4000);
  const dom=new JSDOM('<main></main>');const content=dom.window.document.querySelector('main')!;
  (dom.window.HTMLElement.prototype as any).createEl=function(tag:string,opts:any){const e=dom.window.document.createElement(tag);if(opts?.text)e.textContent=opts.text;for(const [k,v] of Object.entries(opts?.attr??{}))e.setAttribute(k,String(v));this.append(e);return e;};
  (dom.window.HTMLElement.prototype as any).empty=function(){this.replaceChildren();};
  (globalThis as any).__baiduQrModalTest={content,responses:[
   {json:{errno:0,sign:'ticket',imgurl:'passport.baidu.com/v2/api/qrcode?sign=ticket'}},
   {body:Buffer.from([137,80,78,71,13,10,26,10])},
   {json:{errno:0,channel_v:JSON.stringify({status:0,v:'temporary-ticket'})}},
   {json:{errno:0},cookies:['BDUSS=actual-cookie; Domain=.baidu.com; Path=/']},
   {json:{errno:0,result:{bdstoken:'csrf'}}}
  ]};
  let done=0,saved=0;const plugin:any={app:{},settings:{serviceType:'baidu'},saveSettings:async()=>{saved++;}};
  const modal=new moduleFixture.exports.BaiduQrLoginModal(plugin,()=>done++);
  try{
   await modal.onOpen();assert.ok(content.querySelector('img')!.src.startsWith('data:image/png;base64,'));
   await new Promise(r=>setTimeout(r,1100));
   assert.equal(saved,1);assert.equal(done,1);assert.equal(plugin.settings.baiduWebExperimental.cookie,'BDUSS=actual-cookie');
   assert.equal(plugin.settings.baiduWebExperimental.csrf,'csrf');assert.equal(plugin.settings.baiduWebExperimental.clientSecret,undefined);
  }finally{modal.onClose();delete (globalThis as any).__baiduQrModalTest;dom.window.close();}
 });
});
