import {strict as assert} from 'assert';
import {EventEmitter} from 'events';
import {mock} from 'node:test';
import {createDesktopBaiduWebTransport} from '../../src/native/baiduWebTransport';
describe('Desktop Baidu keyless QR transport',()=>{
 it('allows a progressing low-speed download to exceed three minutes',async()=>{
  mock.timers.enable({apis:['setTimeout']});
  try{
   const request:any=new EventEmitter(),response:any=new EventEmitter();let callback:any,settled=false;
   request.setTimeout=()=>request;request.end=()=>request.emit('finish');request.destroy=()=>{};
   response.statusCode=200;response.headers={};response.complete=true;response.destroy=()=>{};
   const transport=createDesktopBaiduWebTransport(true,new AbortController().signal,()=>((_url:any,_options:any,cb:any)=>{callback=cb;return request;}) as any);
   const pending=transport({url:'https://pcs.baidu.com/rest/2.0/pcs/file',method:'GET',maxBytes:8*1024*1024,transfer:'download'});
   pending.then(()=>{settled=true;},()=>{settled=true;});
   callback(response);response.emit('data',new Uint8Array([1]));mock.timers.tick(180001);await Promise.resolve();
   assert.equal(settled,false);
   response.emit('end');assert.equal((await pending).body.length,1);
  }finally{mock.timers.reset();}
 });
 it('never loads desktop networking on mobile',async()=>{
  const transport=createDesktopBaiduWebTransport(false,new AbortController().signal,()=>{throw Error('loaded');});
  await assert.rejects(()=>transport({url:'https://passport.baidu.com/v2/api/getqrcode',method:'GET'}),/desktop_required/);
 });
 it('blocks Cookie delivery to an image/download CDN',async()=>{
  const transport=createDesktopBaiduWebTransport(true,new AbortController().signal,()=>{throw Error('loaded');});
  await assert.rejects(()=>transport({url:'https://cdn.baidupcs.com/file',method:'GET',headers:{Cookie:'BDUSS=private'}}),/untrusted_endpoint/);
 });
 it('destroys the real pending request on cancel and does not expose request secrets',async()=>{
  const controller=new AbortController();const request:any=new EventEmitter();let destroyed=false;
  request.setTimeout=()=>request;request.end=()=>{};request.destroy=()=>{destroyed=true;};
  const transport=createDesktopBaiduWebTransport(true,controller.signal,()=>()=>request);
  const pending=transport({url:'https://passport.baidu.com/channel/unicast?channel_id=private-ticket',method:'GET'});controller.abort();
  await assert.rejects(pending,(e:any)=>e.code==='cancelled'&&!e.message.includes('private-ticket'));assert.equal(destroyed,true);
 });
 it('switches POST response waiting separately and restores response-body idle protection',async()=>{
  const controller=new AbortController();const request:any=new EventEmitter(),response:any=new EventEmitter();const deadlines:number[]=[];let callback:any;
  request.setTimeout=(n:number)=>{deadlines.push(n);return request;};request.end=()=>request.emit('finish');request.destroy=()=>{};
  response.statusCode=200;response.headers={'content-length':'2'};response.complete=true;response.destroy=()=>{};
  const transport=createDesktopBaiduWebTransport(true,controller.signal,()=>((_url:any,_options:any,cb:any)=>{callback=cb;return request;}) as any);
  const pending=transport({url:'https://pan.baidu.com/api/create',method:'POST',body:'a=b'});
  callback(response);response.emit('data',new TextEncoder().encode('{}'));response.emit('end');
  assert.equal((await pending).status,200);assert.deepEqual(deadlines,[35000,120000,35000]);
 });
});
