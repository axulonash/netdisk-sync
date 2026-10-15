/** Standalone feasibility check, not a service or installed-plugin migration. */
import https from 'node:https';
import {writeFile,mkdir,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {BaiduWebProbe,BaiduWebProbeError,baiduProbeUrl,type BaiduWebProbeTransport} from '../src/native/baiduWebProbe';
const controller=new AbortController();
const agent=new https.Agent({keepAlive:true,maxSockets:2});
const transport:BaiduWebProbeTransport=async input=>{
 const url=new URL(input.url);
 try {baiduProbeUrl(url.href);} catch {
  if(input.method!=='GET'||url.protocol!=='https:'||url.username||url.password||url.hash||url.port||
   !['baidupcs.com','baidubce.com'].some(d=>url.hostname===d||url.hostname.endsWith(`.${d}`))||
   Object.keys(input.headers??{}).some(k=>/cookie|authorization/i.test(k)))throw new BaiduWebProbeError('untrusted_endpoint');
 }
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(fn:()=>void)=>{if(settled)return;settled=true;clearTimeout(timer);fn();};
  const request=https.request(url,{method:input.method,agent,signal:controller.signal,rejectUnauthorized:true,
   headers:{...input.headers,'Accept-Encoding':'identity',...(input.body!==undefined?{'Content-Length':String(Buffer.byteLength(input.body))}:{})}},response=>{
    const headers:Record<string,string>={};
    for(const [name,value] of Object.entries(response.headers))if(value!==undefined)headers[name]=Array.isArray(value)?value.join(', '):value;
    const status=response.statusCode??0;
    if(status<200||status>=300){finish(()=>resolve({status,headers,cookies:response.headers['set-cookie']??[],body:new Uint8Array()}));response.destroy();return;}
    if(headers['content-encoding']&&headers['content-encoding']!=='identity'){finish(()=>reject(new BaiduWebProbeError('unexpected_encoding')));response.destroy();return;}
    const limit=input.maxBytes??1024*1024;
    const chunks:Buffer[]=[];let size=0;
    response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>limit){finish(()=>reject(new BaiduWebProbeError('response_too_large')));response.destroy();return;}chunks.push(chunk);});
    response.once('end',()=>finish(()=>{
     if(!response.complete||(headers['content-length']!==undefined&&Number(headers['content-length'])!==size)){reject(new BaiduWebProbeError('incomplete_response'));return;}
     resolve({status,headers,cookies:response.headers['set-cookie']??[],body:new Uint8Array(Buffer.concat(chunks))});
    }));
    response.once('error',()=>finish(()=>reject(new BaiduWebProbeError('network_error'))));
    response.once('aborted',()=>finish(()=>reject(new BaiduWebProbeError('incomplete_response'))));
   });
  const timer=setTimeout(()=>{finish(()=>reject(new BaiduWebProbeError('request_timeout')));request.destroy();},60000);
  request.setTimeout(35000,()=>{finish(()=>reject(new BaiduWebProbeError('request_timeout')));request.destroy();});
  request.once('error',()=>finish(()=>reject(new BaiduWebProbeError(controller.signal.aborted?'cancelled':'network_error'))));
  request.end(input.body);
 });
};
async function main(){
 const preflight=process.argv.includes('--preflight');
 const destination=path.resolve('dist/baidu-qr-verification');
 await mkdir(destination,{recursive:true,mode:0o700});
 const png=path.join(destination,'qr.png'),html=path.join(destination,'index.html');
 const probe=new BaiduWebProbe(transport);
 const cancel=()=>{probe.cancel();controller.abort();};process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 try {
  const url=await probe.start();
  const image=await transport({url,method:'GET',maxBytes:512*1024});
  if(image.status!==200||!Buffer.from(image.body).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new BaiduWebProbeError('invalid_qr_image');
  if(preflight){console.log(JSON.stringify({qrRequest:'passed',image:'png',appCredentialsRequired:false}));return;}
  await writeFile(png,image.body,{mode:0o600});
  await writeFile(html,'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>百度扫码验证</title><body style="font:18px system-ui;text-align:center;padding:32px"><h1>百度网盘扫码验证</h1><p>使用百度网盘 App 扫码并确认登录。二维码约 3 分钟有效。</p><img src="qr.png" width="240" height="240" alt="百度官方登录二维码"><p>扫码后请查看运行命令的终端，程序会自动验证临时文件读写。<br>登录凭据仅保存在内存，结束后清除。</p></body></html>',{mode:0o600});
  console.log(`请在浏览器打开：${html}\n使用百度网盘 App 扫码确认。无需填写任何 Key、Secret 或授权码。`);
  const deadline=Date.now()+180000;let logged=false;
  while(Date.now()<deadline&&!controller.signal.aborted){
   const state=await probe.check();console.log(JSON.stringify({login:state}));
   if(state==='logged_in'){logged=true;break;}
   await new Promise<void>(resolve=>{const timer=setTimeout(done,1000);function done(){clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();}controller.signal.addEventListener('abort',done,{once:true});});
  }
  if(!logged)throw new BaiduWebProbeError(controller.signal.aborted?'cancelled':'qr_expired');
  await probe.listRoot();console.log(JSON.stringify({directoryRead:'passed'}));
  const result=await probe.verifyReadWrite(randomBytes(16).toString('hex'));
  console.log(JSON.stringify({temporaryFile:result}));
  if(!result.upload||!result.download||!result.cleanup)process.exitCode=1;
 }catch(error){console.error(JSON.stringify({error:error instanceof BaiduWebProbeError?error.code:'unexpected_error'}));process.exitCode=1;}
 finally {
  probe.cancel();controller.abort();agent.destroy();process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
  for(const file of [png,html])await unlink(file).catch(()=>{});
 }
}
void main();
