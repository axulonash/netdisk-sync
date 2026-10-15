import {Buffer} from 'buffer';
import {reportTransferBytes} from '../transferSpeed';
import type {ClientRequest, IncomingMessage} from 'http';
import type {Readable} from 'stream';
import {nativeHttpsAgent} from './httpsPool';

export interface DesktopWebdavRequest {url:string;method:string;headers?:Record<string,string>;body?:string|ArrayBuffer;signal?:AbortSignal;}
export interface WebdavTransportLimits {idleTimeoutMs?:number;responseTimeoutMs?:number;totalTimeoutMs?:number;}
export interface DesktopWebdavResponse {status:number;headers:Record<string,string>;arrayBuffer:ArrayBuffer;}
let httpAgent:any;
export function closeWebdavHttpConnections(){httpAgent?.destroy();httpAgent=undefined;}

/** Desktop-only, lazy Node loading. Deadlines destroy the real request/socket. */
export function desktopWebdavRequest(input:DesktopWebdavRequest,limits:WebdavTransportLimits={}):Promise<DesktopWebdavResponse>{
 const readonly=['GET','HEAD','PROPFIND','OPTIONS'].includes(input.method.toUpperCase());
 const idle=limits.idleTimeoutMs??30000;
 const responseWait=limits.responseTimeoutMs??120000;
 const total=limits.totalTimeoutMs??(['GET','PUT'].includes(input.method.toUpperCase())?600000:60000);
 return new Promise((resolve,reject)=>{
  let outgoing:ClientRequest|undefined,incoming:IncomingMessage|undefined,decoded:Readable|undefined;
  let settled=false;
  const started=performance.now();
  const transfer={phase:"connecting",bodyBytes:typeof input.body==='string'?Buffer.byteLength(input.body):input.body?.byteLength??0,bodyFlushed:false,elapsedMs:0,timeout:undefined as "idle"|"response"|"total"|undefined};
  let uploadTimer:ReturnType<typeof setInterval>|undefined;
  let sampleUpload=()=>{};
  const timer=setTimeout(()=>{transfer.timeout='total';fail('ETIMEDOUT');},total);
  const cleanup=()=>{sampleUpload();if(uploadTimer)clearInterval(uploadTimer);clearTimeout(timer);input.signal?.removeEventListener('abort',abort);};
  const fail=(code:string,cause?:unknown)=>{
   if(settled)return;settled=true;cleanup();
   reject(Object.assign(new Error('WebDAV request failed'),{code,outcomeUnknown:!readonly,cause,transfer:{...transfer,elapsedMs:Math.round(performance.now()-started)}}));
   decoded?.destroy();incoming?.destroy();outgoing?.destroy();
  };
  const abort=()=>fail('sync_cancelled');
  const send=(url:URL,headers:Record<string,string>,redirects:number)=>{
   if(settled)return;
   incoming=undefined;decoded=undefined;transfer.phase="connecting";transfer.bodyFlushed=false;
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password){fail('invalid_endpoint');return;}
   try {
    const secure=url.protocol==='https:';
    const client=secure?require('node:https'):require('node:http');
    const agent=secure?nativeHttpsAgent():(httpAgent??=new client.Agent({keepAlive:true,maxSockets:6,maxFreeSockets:2}));
    const request:ClientRequest=client.request(url,{method:input.method,headers,agent,rejectUnauthorized:true},(response:IncomingMessage)=>{
     if(settled||request!==outgoing){response.destroy();return;}
     incoming=response;transfer.phase="receiving_response";request.setTimeout(idle);
     const status=response.statusCode??0;
     const responseHeaders:Record<string,string>={};
     for(const [key,value] of Object.entries(response.headers))if(value!==undefined)responseHeaders[key]=Array.isArray(value)?value.join(', '):String(value);
     if([301,302,303,307,308].includes(status)&&responseHeaders.location&&['GET','HEAD'].includes(input.method.toUpperCase())){
      if(redirects>=5){fail('redirect_limit');return;}
      let target:URL;try{target=new URL(responseHeaders.location,url);}catch{fail('invalid_endpoint');return;}
      if(url.protocol==='https:'&&target.protocol!=='https:'){fail('untrusted_redirect');return;}
      const nextHeaders:Record<string,string>={};
      for(const [key,value] of Object.entries(headers))if(target.origin===url.origin||['accept','accept-encoding','range','user-agent','if-match','if-none-match','if-unmodified-since','if-modified-since','if-range'].includes(key.toLowerCase()))nextHeaders[key]=value;
      // Close the previous hop, including an unfinished redirect body.
      // Never send credentials to another origin.
      response.destroy();request.destroy();send(target,nextHeaders,redirects+1);return;
     }
     response.once('error',(error)=>{if(request===outgoing)fail('ECONNRESET',error);});
     response.once('aborted',()=>{if(request===outgoing)fail('ECONNRESET');});
     let stream:Readable=response;
     const encoding=responseHeaders['content-encoding']?.toLowerCase();
     if(input.method.toUpperCase()!=='HEAD'&&![204,205,304].includes(status)&&encoding&&encoding!=='identity'){
      const zlib=require('node:zlib');
      if(encoding==='gzip')decoded=zlib.createGunzip();
      else if(encoding==='deflate')decoded=zlib.createInflate();
      else if(encoding==='br')decoded=zlib.createBrotliDecompress();
      else {fail('unexpected_encoding');return;}
      stream=decoded!;response.pipe(stream as any);
      delete responseHeaders['content-encoding'];delete responseHeaders['content-length'];
     }
     const chunks:Buffer[]=[];
     stream.on('data',(chunk:Buffer)=>{if(!settled){chunks.push(Buffer.from(chunk));if(input.method.toUpperCase()==='GET')reportTransferBytes('download',chunk.length);}});
     stream.once('error',(error)=>fail('ECONNRESET',error));
     stream.once('end',()=>{
      if(settled)return;
      if(!response.complete){fail('ECONNRESET');return;}
      try{
       const body=Buffer.concat(chunks);settled=true;cleanup();
       resolve({status,headers:responseHeaders,arrayBuffer:body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength) as ArrayBuffer});
      }catch(error){fail('invalid_response',error);}
     });
    });
    outgoing=request;
    request.once('socket',socket=>{
      const connected=()=>{if(!settled&&request===outgoing)transfer.phase=transfer.bodyBytes>0?"sending_body":"awaiting_response";};
      if(socket.connecting)socket.once(secure?'secureConnect':'connect',connected);else connected();
    });
    request.once('finish',()=>{if(!settled&&request===outgoing){transfer.bodyFlushed=true;if(!incoming){transfer.phase="awaiting_response";if(input.method.toUpperCase()==='PUT')request.setTimeout(responseWait);}}});
    if(input.method.toUpperCase()==='PUT'&&input.body){
     const length=typeof input.body==='string'?Buffer.byteLength(input.body):input.body.byteLength;
     request.once('socket',socket=>{
      if(settled)return;
      const start=socket.bytesWritten;let reported=0;
      sampleUpload=()=>{
       const headerBytes=Buffer.byteLength((request as any)._header??'');
       const sent=Math.min(length,Math.max(0,socket.bytesWritten-start-headerBytes));
       if(sent>reported){reportTransferBytes('upload',sent-reported);reported=sent;}
      };
      uploadTimer=setInterval(sampleUpload,250);
     });
    }
    request.once('error',(error:any)=>{if(request===outgoing)fail(typeof error?.code==='string'?error.code:'ECONNRESET',error);});
    request.setTimeout(idle,()=>{if(request===outgoing){transfer.timeout=input.method.toUpperCase()==='PUT'&&transfer.phase==='awaiting_response'&&transfer.bodyFlushed?'response':'idle';fail('ETIMEDOUT');}});
    const body=input.body;
    outgoing!.end(typeof body==='string'?body:body?Buffer.from(body):undefined);
   }catch(error){fail('request_failed',error);}
  };
  if(input.signal?.aborted){abort();return;}
  input.signal?.addEventListener('abort',abort,{once:true});
  const headers={...input.headers,'accept-encoding':'identity'};
  try{send(new URL(input.url),headers,0);}catch(error){fail('invalid_endpoint',error);}
 });
}
