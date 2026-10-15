import {strict as assert} from 'assert';
import {createServer} from 'http';
import type {AddressInfo} from 'net';
import {gzipSync} from 'zlib';
import {desktopWebdavRequest} from '../../src/native/webdavDesktopTransport';
describe('Abortable desktop WebDAV transport',function(){
 this.timeout(3000);
 async function server(handler:any){const instance=createServer(handler);await new Promise<void>(r=>instance.listen(0,'127.0.0.1',r));return{url:`http://127.0.0.1:${(instance.address() as AddressInfo).port}`,close:async()=>{instance.closeAllConnections();await new Promise<void>(r=>instance.close(()=>r()));}};}
 async function bounded(promise:Promise<any>){let timer:any;try{return await Promise.race([promise.then(()=>({code:'unexpected_success'}),e=>e),new Promise(r=>timer=setTimeout(()=>r({code:'hung'}),300))]);}finally{clearTimeout(timer);}}
 it('times out and closes a socket when the server never returns headers',async()=>{
  let closed=false;const s=await server((req:any)=>req.socket.once('close',()=>closed=true));
  try{const error:any=await bounded(desktopWebdavRequest({url:s.url,method:'GET'},{idleTimeoutMs:30,totalTimeoutMs:100}));
   assert.equal(error.code,'ETIMEDOUT');await new Promise(r=>setTimeout(r,20));assert.equal(closed,true);
  }finally{await s.close();}
 });
 it('does not return partial file bytes when a response stops halfway',async()=>{
  const s=await server((_req:any,res:any)=>{res.writeHead(200,{'Content-Length':'10'});res.write('abc');});
  try{const error:any=await bounded(desktopWebdavRequest({url:s.url,method:'GET'},{idleTimeoutMs:30,totalTimeoutMs:100}));assert.equal(error.code,'ETIMEDOUT');}finally{await s.close();}
 });
 it('bounds a write with an unknown outcome without replaying it',async()=>{
  let writes=0;const s=await server((req:any)=>{req.resume();req.on('end',()=>{writes++;});});
  try{const error:any=await bounded(desktopWebdavRequest({url:s.url,method:'PUT',body:new TextEncoder().encode('payload').buffer},{idleTimeoutMs:30,totalTimeoutMs:100}));
   assert.equal(error.code,'ETIMEDOUT');assert.equal(error.outcomeUnknown,true);assert.equal(writes,1);
  }finally{await s.close();}
 });
 it('aborts an active read and releases its socket',async()=>{
  let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);const s=await server(()=>entered());const controller=new AbortController();
  try{const result=bounded(desktopWebdavRequest({url:s.url,method:'GET',signal:controller.signal},{idleTimeoutMs:1000,totalTimeoutMs:2000}));await ready;controller.abort();const error:any=await result;assert.equal(error.code,'sync_cancelled');}finally{await s.close();}
 });
 it('preserves binary data and decodes compressed responses',async()=>{
  const body=Buffer.from('中文 HTML 100%');const s=await server((_req:any,res:any)=>{res.writeHead(200,{'Content-Encoding':'gzip'});res.end(gzipSync(body));});
  try{const response=await desktopWebdavRequest({url:s.url,method:'GET'});assert.equal(response.status,200);assert.deepEqual(Buffer.from(response.arrayBuffer),body);}finally{await s.close();}
 });
 it('follows cross-origin download redirects without forwarding credentials',async()=>{
  let headers:any;const destination=await server((req:any,res:any)=>{headers=req.headers;res.end('file');});
  const origin=await server((_req:any,res:any)=>{res.writeHead(302,{Location:destination.url});res.end();});
  try{const response=await desktopWebdavRequest({url:origin.url,method:'GET',headers:{Authorization:'Basic secret',Cookie:'session-secret','X-Api-Key':'secret'}});assert.equal(Buffer.from(response.arrayBuffer).toString(),'file');assert.equal(headers.authorization,undefined);assert.equal(headers.cookie,undefined);assert.equal(headers['x-api-key'],undefined);}finally{await origin.close();await destination.close();}
 });
});

it('closes the previous redirect response even when its body never ends',async()=>{
 let closed=false;
 const target=createServer((_req,res)=>res.end('file'));await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));
 const targetUrl=`http://127.0.0.1:${(target.address() as AddressInfo).port}`;
 const origin=createServer((req,res)=>{req.socket.once('close',()=>closed=true);res.writeHead(302,{Location:targetUrl});res.write('redirect');});await new Promise<void>(r=>origin.listen(0,'127.0.0.1',r));
 try{await desktopWebdavRequest({url:`http://127.0.0.1:${(origin.address() as AddressInfo).port}`,method:'GET'});await new Promise(r=>setTimeout(r,20));assert.equal(closed,true);}finally{origin.closeAllConnections();target.closeAllConnections();await Promise.all([new Promise<void>(r=>origin.close(()=>r())),new Promise<void>(r=>target.close(()=>r()))]);}
});

it('retains conditional version headers while stripping credentials across redirects',async()=>{
 let match:string|undefined;
 const target=createServer((req,res)=>{match=req.headers['if-match'] as string;res.end('file');});await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));
 const origin=createServer((_req,res)=>{res.writeHead(302,{Location:`http://127.0.0.1:${(target.address() as AddressInfo).port}`});res.end();});await new Promise<void>(r=>origin.listen(0,'127.0.0.1',r));
 try{await desktopWebdavRequest({url:`http://127.0.0.1:${(origin.address() as AddressInfo).port}`,method:'GET',headers:{'If-Match':'"version"'}});assert.equal(match,'"version"');}finally{origin.closeAllConnections();target.closeAllConnections();await Promise.all([new Promise<void>(r=>origin.close(()=>r())),new Promise<void>(r=>target.close(()=>r()))]);}
});

it('accepts a HEAD response that advertises gzip but contains no body',async()=>{
 const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Encoding':'gzip','Content-Length':'100'});res.end();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const response=await desktopWebdavRequest({url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,method:'HEAD'});assert.equal(response.status,200);assert.equal(response.arrayBuffer.byteLength,0);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

it('reports upload and download bytes without counting HTTP headers',async()=>{
 const {observeTransferBytes}=await import('../../src/transferSpeed');
 const totals={upload:0,download:0};const unsubscribe=observeTransferBytes((direction,bytes)=>totals[direction]+=bytes);
 const payload=Buffer.alloc(128*1024,42);
 const server=createServer((req,res)=>{req.resume();req.on('end',()=>res.end(req.method==='GET'?payload:undefined));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 try{
  await desktopWebdavRequest({url,method:'PUT',body:payload.buffer.slice(payload.byteOffset,payload.byteOffset+payload.byteLength) as ArrayBuffer});
  await desktopWebdavRequest({url,method:'GET'});
  assert.deepEqual(totals,{upload:payload.length,download:payload.length});
 }finally{unsubscribe();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it('identifies a timeout after a PUT body was flushed while awaiting headers',async()=>{
 const server=createServer((req,_res)=>req.resume());
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const error:any=await desktopWebdavRequest({url,method:'PUT',body:new Uint8Array(1024).buffer},{idleTimeoutMs:40,responseTimeoutMs:40,totalTimeoutMs:200}).catch(error=>error);
  assert.equal(error.code,'ETIMEDOUT');assert.equal(error.transfer.phase,'awaiting_response');
  assert.equal(error.transfer.bodyBytes,1024);assert.equal(error.transfer.bodyFlushed,true);
  assert.equal(error.transfer.timeout,'response');assert.ok(error.transfer.elapsedMs>=30);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it('allows PUT response latency beyond the transfer idle limit without replaying',async()=>{
 let writes=0;const server=createServer((req,res)=>{req.resume();req.on('end',()=>{writes++;setTimeout(()=>{res.writeHead(201);res.end();},90);});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const response=await desktopWebdavRequest({url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,method:'PUT',body:new Uint8Array(1024).buffer},{idleTimeoutMs:30,responseTimeoutMs:200,totalTimeoutMs:300});
  assert.equal(response.status,201);assert.equal(writes,1);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it('restores the transfer idle limit once PUT response headers arrive',async()=>{
 const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Length':'2'});res.write('a');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const error:any=await desktopWebdavRequest({url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,method:'PUT',body:new Uint8Array(4).buffer},{idleTimeoutMs:30,responseTimeoutMs:200,totalTimeoutMs:300}).catch(error=>error);
  assert.equal(error.code,'ETIMEDOUT');assert.equal(error.transfer.phase,'receiving_response');assert.ok(error.transfer.elapsedMs<180);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
