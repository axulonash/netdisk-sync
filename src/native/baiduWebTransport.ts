import {reportTransferBytes} from '../transferSpeed';
import {trackNativeUpload,nativeRequestState} from './transferTelemetry';
import {nativeTransferTimeout} from './httpsPool';
import type {ClientRequest,IncomingMessage} from 'http';
import type {NodeHttpsRequest} from './baiduDesktopTransport';
import {nativeHttpsAgent} from './httpsPool';
import {BaiduWebProbeError,baiduProbeUrl,type BaiduWebProbeTransport} from './baiduWebProbe';
export function createDesktopBaiduWebTransport(desktop:boolean,signal:AbortSignal,load:()=>NodeHttpsRequest=()=>require('node:https').request):BaiduWebProbeTransport {
 return async input=>{
  if(!desktop)throw new BaiduWebProbeError('desktop_required');
  if(signal.aborted)throw new BaiduWebProbeError('cancelled');
  let url:URL;try{url=new URL(input.url);}catch{throw new BaiduWebProbeError('untrusted_endpoint');}
  try{baiduProbeUrl(url.href);}catch{
   if(input.method!=='GET'||url.protocol!=='https:'||url.username||url.password||url.hash||url.port||
    !['baidupcs.com','baidubce.com'].some(d=>url.hostname===d||url.hostname.endsWith(`.${d}`))||
    Object.keys(input.headers??{}).some(k=>/cookie|authorization/i.test(k)))throw new BaiduWebProbeError('untrusted_endpoint');
  }
  const limit=input.maxBytes??1024*1024;
  if(!Number.isSafeInteger(limit)||limit<0||limit>64*1024*1024)throw new BaiduWebProbeError('invalid_limits');
  return new Promise((resolve,reject)=>{
   let outgoing:ClientRequest|undefined,incoming:IncomingMessage|undefined,settled=false;
   const diagnostics=nativeRequestState(input.body instanceof Uint8Array?input.body.length:typeof input.body==='string'?new TextEncoder().encode(input.body).length:0);
   let stopUpload:(()=>void)|undefined;
   const cleanup=()=>{stopUpload?.();clearTimeout(timer);signal.removeEventListener('abort',abort);};
   const fail=(code:string,networkCode?:string)=>{if(settled)return;settled=true;cleanup();reject(Object.assign(new BaiduWebProbeError(code),{transfer:diagnostics.snapshot(),networkCode:code==='request_timeout'?'ETIMEDOUT':['ECONNRESET','ECONNABORTED','ETIMEDOUT'].includes(networkCode??'')?networkCode:undefined}));incoming?.destroy();outgoing?.destroy();};
   const abort=()=>fail('cancelled');
   // Baidu may throttle downloads far below the shared 128 KiB/s estimate.
   // Keep the idle timeout, but budget up to 30 minutes at 16 KiB/s for a
   // download that continues receiving bytes.
   const totalTimeout=input.transfer==='download'?Math.max(180000,Math.min(1800000,60000+Math.ceil(limit/(16*1024))*1000)):
    input.transfer?Math.max(180000,nativeTransferTimeout(Math.max(limit,input.body instanceof Uint8Array?input.body.length:0))):input.method==='POST'?180000:60000;
   const timer=setTimeout(()=>{diagnostics.state.timeout='total';fail('request_timeout');},totalTimeout);
   signal.addEventListener('abort',abort,{once:true});
   try{
    const body=typeof input.body==='string'?new TextEncoder().encode(input.body):input.body;
    outgoing=load()(url,{method:input.method,agent:nativeHttpsAgent(),rejectUnauthorized:true,headers:{...input.headers,'Accept-Encoding':'identity',...(body?{'Content-Length':String(body.byteLength)}:{})}},response=>{
     if(settled){response.destroy();return;}incoming=response;diagnostics.state.phase='receiving_response';outgoing?.setTimeout(35000);
     const headers:Record<string,string>={};
     for(const [name,value] of Object.entries(response.headers))if(value!==undefined)headers[name]=Array.isArray(value)?value.join(', '):value;
     const status=response.statusCode??0;
     if(status<200||status>=300){settled=true;cleanup();resolve({status,headers,cookies:response.headers['set-cookie']??[],body:new Uint8Array()});response.destroy();return;}
     if(headers['content-encoding']&&headers['content-encoding']!=='identity'){fail('unexpected_encoding');return;}
     const length=headers['content-length'];
     if(length!==undefined&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>limit)){fail('response_too_large');return;}
     const chunks:Uint8Array[]=[];let size=0;
     response.on('data',(chunk:Uint8Array)=>{if(settled)return;size+=chunk.length;if(size>limit){fail('response_too_large');return;}chunks.push(new Uint8Array(chunk));if(input.transfer==='download')reportTransferBytes('download',chunk.length);});
     response.once('end',()=>{
      if(settled)return;
      if(!response.complete||(length!==undefined&&Number(length)!==size)){fail('incomplete_response');return;}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      settled=true;cleanup();resolve({status,headers,cookies:response.headers['set-cookie']??[],body:bytes});
     });
     response.once('error',()=>fail('network_error'));response.once('aborted',()=>fail('incomplete_response'));response.once('close',()=>{if(!settled)fail('incomplete_response');});
    });
    diagnostics.attach(outgoing);
    if(input.transfer==='upload'&&body)stopUpload=trackNativeUpload(outgoing,body.length);
    outgoing.once('finish',()=>{if(!settled&&!incoming&&input.method==='POST')outgoing?.setTimeout(120000);});
    outgoing.setTimeout(35000,()=>{diagnostics.state.timeout=input.method==='POST'&&diagnostics.state.bodyFlushed&&diagnostics.state.phase==='awaiting_response'?'response':'idle';fail('request_timeout');});outgoing.once('error',(error:any)=>fail(signal.aborted?'cancelled':'network_error',error?.code));outgoing.end(body);
   }catch{fail('network_error');}
  });
 };
}
