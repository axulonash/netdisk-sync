import {Buffer} from 'buffer';
import type {ClientRequest} from 'http';
import {reportTransferBytes} from '../transferSpeed';
/** Socket throughput is not a server acknowledgement; publication verifies bytes separately. */
export function trackNativeUpload(request:ClientRequest,bodyBytes:number){
 let timer:ReturnType<typeof setInterval>|undefined,closed=false,sample=()=>{};
 const onSocket=(socket:any)=>{
  if(closed)return;
  const start=socket.bytesWritten;let reported=0;
  sample=()=>{const bytes=Math.min(bodyBytes,Math.max(0,socket.bytesWritten-start-Buffer.byteLength((request as any)._header??'')));if(bytes>reported){reportTransferBytes('upload',bytes-reported);reported=bytes;}};
  timer=setInterval(sample,250);
 };
 request.once('socket',onSocket);
 return ()=>{closed=true;sample();if(timer)clearInterval(timer);request.removeListener('socket',onSocket);};
}
export function nativeRequestState(bodyBytes:number){
 const started=performance.now();
 const state={phase:'connecting',bodyBytes,bodyFlushed:false,timeout:undefined as 'idle'|'response'|'total'|undefined};
 return {state,snapshot:()=>({...state,elapsedMs:Math.round(performance.now()-started)}),attach:(request:ClientRequest)=>{
  request.once('socket',socket=>{const connected=()=>{if(!state.bodyFlushed&&state.phase!=='receiving_response')state.phase=bodyBytes?'sending_body':'awaiting_response';};if(socket.connecting)socket.once('connect',connected);else connected();});
  request.once('finish',()=>{state.bodyFlushed=true;if(state.phase!=='receiving_response')state.phase='awaiting_response';});
 }};
}
