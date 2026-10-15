import {strict as assert} from 'assert';
import {EventEmitter} from 'events';
import {createDesktopQuarkTransport} from '../../src/native/quarkTransport';
import {createDesktopAliyunTransport} from '../../src/native/aliyunTransport';
import {observeTransferBytes} from '../../src/transferSpeed';
for(const [name,factory] of [['Quark',createDesktopQuarkTransport],['Aliyun',createDesktopAliyunTransport]] as const){
 describe(`${name} transfer control and response wait`,()=>{
  it('aborts a pending native request on stop',async()=>{
   const controller=new AbortController();let destroyed=false;
   const outgoing:any=new EventEmitter();outgoing.setTimeout=()=>outgoing;outgoing.end=()=>{};outgoing.destroy=()=>{destroyed=true;};
   const transport=factory(true,()=>()=>outgoing);
   const pending=transport({url:'https://a.aliyuncs.com/upload',method:'PUT',body:new Uint8Array([1]),signal:controller.signal});controller.abort();
   await assert.rejects(pending,(e:any)=>e.code==='sync_cancelled');assert.equal(destroyed,true);
  });
  it('separates sent-body response waiting and counts downloaded bytes once',async()=>{
   const deadlines:number[]=[];let callback:any;let downloaded=0;
   const stop=observeTransferBytes((direction,bytes)=>{if(direction==='download')downloaded+=bytes;});
   const outgoing:any=new EventEmitter();outgoing.setTimeout=(n:number)=>{deadlines.push(n);return outgoing;};outgoing.end=()=>outgoing.emit('finish');outgoing.destroy=()=>{};
   const transport=factory(true,()=>((_url:any,_options:any,cb:any)=>{callback=cb;return outgoing;}) as any);
   const response:any=new EventEmitter();response.statusCode=200;response.headers={'content-length':'4'};response.complete=true;response.destroy=()=>{};
   try{
    const uploaded=transport({url:'https://a.aliyuncs.com/upload',method:'PUT',body:new Uint8Array([1]),maxBytes:4});
    callback(response);response.emit('data',new Uint8Array(4));response.emit('end');await uploaded;assert.deepEqual(deadlines,[30000,120000,30000]);
    const body=transport({url:'https://a.aliyuncs.com/download',method:'GET',maxBytes:4});callback(response);response.emit('data',new Uint8Array(4));response.emit('end');await body;assert.equal(downloaded,4);
   }finally{stop();}
  });
 });
}
