import {isSyncCancelled} from '../syncControl';
import {baiduSyncRoot} from './baiduPath';
import {parseExpressionAt} from 'acorn';
/** Keyless Baidu web session client. Credentials stay inside this instance;
 * no export or logging of cookies or tickets.
 */
export interface BaiduWebProbeRequest {
  url: string; method: 'GET'|'POST'; headers?: Record<string,string>;
  body?: Uint8Array|string; maxBytes?: number; transfer?: 'upload'|'download';
}
export interface BaiduWebProbeResponse {
  status: number; headers: Record<string,string>; cookies: string[]; body: Uint8Array;
}
export type BaiduWebProbeTransport=(request:BaiduWebProbeRequest)=>Promise<BaiduWebProbeResponse>;
export class BaiduWebProbeError extends Error {
  itemErrno?:number;
  filenameHasSupplementary?:boolean;
  apiName?:'list'|'precreate'|'create'|'filemanager'|'filemetas'|'gettemplatevariable';
  apiOperation?:'rename'|'delete';
  operationStage?:'verify_upload';
  constructor(public readonly code:string){super(`Baidu QR verification: ${code}`);this.name='BaiduWebProbeError';}
}
// Passport returns a JavaScript object literal inside an exact JSONP callback
// (not always JSON: e.g. single-quoted 'data'). Parse syntax, never execute it.
function passportLiteral(text:string):unknown {
  const tree=parseExpressionAt(text,0,{ecmaVersion:2020});
  if(tree.end!==text.length)throw 0;
  let nodes=0;
  const read=(node:any,depth=0):any=>{
    if(++nodes>10000||depth>30)throw 0;
    if(node.type==='Literal'&&!node.regex&&(node.value===null||['string','boolean'].includes(typeof node.value)||(typeof node.value==='number'&&Number.isFinite(node.value))))return node.value;
    if(node.type==='UnaryExpression'&&node.operator==='-'&&node.argument.type==='Literal'&&typeof node.argument.value==='number'&&Number.isFinite(node.argument.value))return -node.argument.value;
    if(node.type==='ArrayExpression')return node.elements.map((item:any)=>{if(!item)throw 0;return read(item,depth+1);});
    if(node.type==='ObjectExpression'){
      const result=Object.create(null);
      for(const prop of node.properties){
        if(prop.type!=='Property'||prop.kind!=='init'||prop.computed||prop.method||prop.shorthand)throw 0;
        const key=prop.key.type==='Identifier'?prop.key.name:prop.key.type==='Literal'&&typeof prop.key.value==='string'?prop.key.value:undefined;
        if(key===undefined||['__proto__','constructor','prototype'].includes(key)||Object.prototype.hasOwnProperty.call(result,key))throw 0;
        result[key]=read(prop.value,depth+1);
      }
      return result;
    }
    throw 0;
  };
  return read(tree);
}
export function parseBaiduWebJson(body:Uint8Array,callback?:string):any {
  try {
    let text=new TextDecoder('utf-8',{fatal:true}).decode(body).trim(),wrapped=false;
    if(callback&&text.startsWith(`${callback}(`)) {
      const suffix=text.endsWith(');')?2:text.endsWith(')')?1:0;
      if(!suffix)throw 0;
      text=text.slice(callback.length+1,-suffix).trim();wrapped=true;
    }
    let result:any;
    try{result=JSON.parse(text);}catch{if(!wrapped)throw 0;result=passportLiteral(text);}
    if(!result||typeof result!=='object'||Array.isArray(result))throw 0;
    return result;
  }catch {throw new BaiduWebProbeError('invalid_response');}
}
function parseStage(body:Uint8Array,stage:'qr_create'|'qr_poll'|'qr_exchange'|'drive_session'|'drive_api',callback?:string){
  try{return parseBaiduWebJson(body,callback);}catch{throw new BaiduWebProbeError(`${stage}_invalid_response`);}
}
export function baiduProbeUrl(value:string):URL {
  let url:URL;
  try {url=new URL(value);}catch {throw new BaiduWebProbeError('untrusted_endpoint');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||
    !['passport.baidu.com','pan.baidu.com','pcs.baidu.com','d.pcs.baidu.com'].includes(url.hostname))
    throw new BaiduWebProbeError('untrusted_endpoint');
  return url;
}
export interface BaiduWebSession {
  cookie:string; csrf:string;
  accountId?:string;
  scopedCookies?:{name:string;value:string;host:string}[];
}
export function baiduWebRoot(value:string):string {
  try{return baiduSyncRoot(value.trim());}catch{throw new BaiduWebProbeError('invalid_root');}
}
export class BaiduWebProbe {
  private readonly cookies=new Map<string,string>();
  private readonly scopedCookies = new Map<string,{name:string;value:string;host:string}>();
  private draft?:{sign:string;expires:number};
  private csrf?:string;
  private accountId?:string;
  private revision=0;
  private busy=false;
  constructor(private readonly transport:BaiduWebProbeTransport,private readonly now=Date.now){}
  sessionSnapshot(): BaiduWebSession {
    if(!this.csrf||!this.cookies.has('BDUSS'))throw new BaiduWebProbeError('login_required');
    return {cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; '),csrf:this.csrf,accountId:this.accountId,scopedCookies:[...this.scopedCookies.values()].map(c=>({...c}))};
  }
  restoreSession(session:BaiduWebSession) {
    if(typeof session.cookie!=='string'||/[\r\n]/.test(session.cookie)||typeof session.csrf!=='string'||!session.csrf||/[\r\n]/.test(session.csrf))throw new BaiduWebProbeError('invalid_session');
    const parsed=new Map<string,string>();
    for(const pair of session.cookie.split(';')){
      const match=/^([!#$%&'*+.^_`|~\w-]+)=([^\r\n;]+)$/.exec(pair.trim());
      if(!match)throw new BaiduWebProbeError('invalid_session');
      parsed.set(match[1],match[2]);
    }
    if(!parsed.has('BDUSS'))throw new BaiduWebProbeError('invalid_session');
    if(session.accountId!==undefined&&(typeof session.accountId!=='string'||!/^[1-9][0-9]{0,19}$/.test(session.accountId)))throw new BaiduWebProbeError('invalid_session');
    const scoped=session.scopedCookies??[];
    if(!Array.isArray(scoped)||scoped.length>100||scoped.some(c=>!c||!['passport.baidu.com','pan.baidu.com'].includes(c.host)||!/^([!#$%&'*+.^_`|~\w-]+)$/.test(c.name)||typeof c.value!=='string'||!c.value||/[\r\n;]/.test(c.value)))throw new BaiduWebProbeError('invalid_session');
    this.cancel();for(const [k,v] of parsed)this.cookies.set(k,v);this.csrf=session.csrf;this.accountId=session.accountId;
    for(const c of scoped)this.scopedCookies.set(`${c.host}|${c.name}`,{...c});
  }
  cancel(){this.revision++;this.draft=undefined;this.csrf=undefined;this.accountId=undefined;this.cookies.clear();this.scopedCookies.clear();}
  private parseAccountId(value:unknown){
    if(typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value))return value;
    if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return String(value);
  }
  async resolveAccountId(){
    if(!this.csrf)throw new BaiduWebProbeError('login_required');
    const info=await this.api('gettemplatevariable',{fields:JSON.stringify(['uk'])});
    const id=this.parseAccountId(info.result?.uk);
    if(!id)throw new BaiduWebProbeError('account_identity_missing');
    if(this.accountId&&this.accountId!==id)throw new BaiduWebProbeError('account_changed');
    this.accountId=id;return id;
  }
  private capture(raw:string[],host:string) {
    for(const item of raw){
      const [pair,...attrs]=item.split(';');
      const match=/^([!#$%&'*+.^_`|~\w-]+)=([^\r\n;]*)$/.exec(pair.trim());
      if(!match)continue;
      const domain=attrs.find(a=>/^\s*domain=/i.test(a))?.split('=')[1]?.trim().toLowerCase();
      const path=attrs.find(a=>/^\s*path=/i.test(a))?.split('=')[1]?.trim();
      const parent=domain==='.baidu.com'||domain==='baidu.com';
      const scope=domain?.replace(/^\./,'')??host;
      // A response cannot set a sibling-domain cookie. Host-only and matching
      // pan/passport cookies remain scoped instead of being dropped or shared.
      if(!host.endsWith('.baidu.com')||(!parent&&(!['pan.baidu.com','passport.baidu.com'].includes(scope)||scope!==host))||(path&&path!=='/'))continue;
      const age=attrs.find(a=>/^\s*max-age=/i.test(a))?.split('=')[1]?.trim();
      const expires=attrs.find(a=>/^\s*expires=/i.test(a))?.split('=').slice(1).join('=').trim();
      const expired=age&&/^-?\d+$/.test(age)?Number(age)<=0:expires?Date.parse(expires)<=this.now():false;
      if(parent){if(!match[2]||expired)this.cookies.delete(match[1]);else this.cookies.set(match[1],match[2]);}
      else {const key=`${scope}|${match[1]}`;if(!match[2]||expired)this.scopedCookies.delete(key);else this.scopedCookies.set(key,{host:scope,name:match[1],value:match[2]});}
    }
  }
  private cookieHeader(host:string){
    const values=new Map(this.cookies);
    for(const c of this.scopedCookies.values())if(c.host===host)values.set(c.name,c.value);
    return [...values].map(([k,v])=>`${k}=${v}`).join('; ');
  }
  private async request(url:URL,method:'GET'|'POST'='GET',body?:Uint8Array|string,maxBytes=1024*1024,contentType?:string,redirects=0,transfer?:'upload'|'download'):Promise<BaiduWebProbeResponse> {
    baiduProbeUrl(url.href);
    const revision=this.revision;
    let response:BaiduWebProbeResponse;
    try {response=await this.transport({url:url.href,method,body,maxBytes,transfer,headers:{
      'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      Referer:'https://pan.baidu.com/disk/main',
      ...(contentType?{'Content-Type':contentType}:{}),
      ...(this.cookieHeader(url.hostname)?{Cookie:this.cookieHeader(url.hostname)}:{})
    }});}catch(error){if(revision!==this.revision)throw new BaiduWebProbeError('cancelled');if(isSyncCancelled(error)||error instanceof BaiduWebProbeError)throw error;throw new BaiduWebProbeError('network_error');}
    if(revision!==this.revision)throw new BaiduWebProbeError('cancelled');
    this.capture(response.cookies,url.hostname);
    if(method==='GET'&&[301,302,303,307,308].includes(response.status)){
      if(redirects>=5||!response.headers.location)throw new BaiduWebProbeError('invalid_session_redirect');
      let target:URL;try{target=new URL(response.headers.location,url);}catch{throw new BaiduWebProbeError('untrusted_endpoint');}
      baiduProbeUrl(target.href);
      if(!['passport.baidu.com','pan.baidu.com'].includes(target.hostname)||!['passport.baidu.com','pan.baidu.com'].includes(url.hostname))throw new BaiduWebProbeError('untrusted_endpoint');
      return this.request(target,'GET',undefined,maxBytes,undefined,redirects+1);
    }
    if(response.status<200||response.status>=300)throw new BaiduWebProbeError(`http_${response.status}`);
    return response;
  }
  private passport(path:string,params:Record<string,string>) {
    const url=new URL(`https://passport.baidu.com${path}`);
    url.search=new URLSearchParams({tpl:'netdisk',apiver:'v3',tt:String(this.now()),...params}).toString();return url;
  }
  async start():Promise<string>{
    if(this.busy)throw new BaiduWebProbeError('busy');
    this.cancel();this.busy=true;
    try {
      const result=parseStage((await this.request(this.passport('/v2/api/getqrcode',{lp:'pc',qrloginfrom:'pc'}))).body,'qr_create');
      if(result.errno!==0||typeof result.sign!=='string'||!result.sign||result.sign.length>4096||typeof result.imgurl!=='string')throw new BaiduWebProbeError('invalid_qr');
      const image=baiduProbeUrl(result.imgurl.startsWith('https://')?result.imgurl:`https://${result.imgurl}`);
      if(image.hostname!=='passport.baidu.com'||image.pathname!=='/v2/api/qrcode')throw new BaiduWebProbeError('untrusted_endpoint');
      this.draft={sign:result.sign,expires:this.now()+180000};return image.href;
    }finally {this.busy=false;}
  }
  async check():Promise<'pending'|'scanned'|'logged_in'>{
    if(this.busy)throw new BaiduWebProbeError('busy');
    if(!this.draft||this.now()>=this.draft.expires)throw new BaiduWebProbeError('qr_expired');
    this.busy=true;
    try {
      const draft=this.draft;
      const result=parseStage((await this.request(this.passport('/channel/unicast',{channel_id:draft.sign}))).body,'qr_poll');
      if(this.now()>=draft.expires)throw new BaiduWebProbeError('qr_expired');
      if(result.errno===1)return 'pending';
      if(result.errno!==0)throw new BaiduWebProbeError('login_rejected');
      let channel:any;try {channel=JSON.parse(result.channel_v);}catch{throw new BaiduWebProbeError('qr_poll_invalid_channel');}
      if(channel.status===1)return 'scanned';
      if(channel.status!==0||typeof channel.v!=='string'||!channel.v||channel.v.length>4096)throw new BaiduWebProbeError('login_rejected');
      const callback='rsnext_baidu_probe';
      const login=await this.request(this.passport('/v3/login/main/qrbdusslogin',{
        bduss:channel.v,loginVersion:'v4',qrcode:'1',time:String(Math.floor(this.now()/1000)),
        alg:'v3',u:'https://pan.baidu.com/disk/main',callback,
      }));
      const exchange=parseStage(login.body,'qr_exchange',callback);
      if(exchange.errInfo?.no!==undefined&&String(exchange.errInfo.no)!=='0')throw new BaiduWebProbeError('login_rejected');
      // The channel ticket is NOT BDUSS. Only server-set session cookies count.
      if(!this.cookies.has('BDUSS')){
        const data=exchange;
        if(data.errInfo?.no && String(data.errInfo.no)!=='0')throw new BaiduWebProbeError('login_rejected');
        throw new BaiduWebProbeError('session_cookie_missing');
      }
      let info:any;
      try{info=await this.api('gettemplatevariable',{fields:JSON.stringify(['bdstoken','uk'])});}
      catch(error){
        if(!(error instanceof BaiduWebProbeError)||error.code!=='api_errno_-6')throw error;
        // Establish pan-specific session cookies through the official landing
        // page, then retry the read-only check once. Never replay a mutation.
        await this.request(new URL('https://pan.baidu.com/disk/main'),'GET',undefined,8*1024*1024);
        try{info=await this.api('gettemplatevariable',{fields:JSON.stringify(['bdstoken','uk'])});}
        catch(retry){if(retry instanceof BaiduWebProbeError&&retry.code==='api_errno_-6')throw new BaiduWebProbeError('drive_session_api_errno_-6');throw retry;}
      }
      if(typeof info.result?.bdstoken!=='string'||!info.result.bdstoken)throw new BaiduWebProbeError('drive_session_invalid');
      this.csrf=info.result.bdstoken;this.accountId=this.parseAccountId(info.result.uk);this.draft=undefined;return 'logged_in';
    }finally{this.busy=false;}
  }
  private async api(name:string,params:Record<string,string>={},form?:Record<string,string>){
   try{
    const url=new URL(`https://pan.baidu.com/api/${name}`);
    url.search=new URLSearchParams({channel:'chunlei',web:'1',clienttype:'0',app_id:'250528',...(this.csrf?{bdstoken:this.csrf}:{}),...params}).toString();
    const data=parseStage((await this.request(url,form?'POST':'GET',form?new URLSearchParams(form).toString():undefined,1024*1024,form?'application/x-www-form-urlencoded':undefined)).body,name==='gettemplatevariable'?'drive_session':'drive_api');
    if(name==='filemetas'&&data.errno===12&&Array.isArray(data.info)&&data.info.length===1&&data.info[0]?.errno===-9)return {errno:0,info:[]};
    if(data.errno!==0){
      const error=new BaiduWebProbeError(Number.isSafeInteger(data.errno)?`api_errno_${data.errno}`:'invalid_response');
      if(Array.isArray(data.info)&&data.info.length===1&&Number.isSafeInteger(data.info[0]?.errno))error.itemErrno=data.info[0].errno;
      throw error;
    }return data;
   }catch(error){
    if(error instanceof BaiduWebProbeError){
     if(['list','precreate','create','filemanager','filemetas','gettemplatevariable'].includes(name))error.apiName=name as BaiduWebProbeError['apiName'];
     if(name==='filemanager'&&['rename','delete'].includes(params.opera))error.apiOperation=params.opera as 'rename'|'delete';
    }
    throw error;
   }
  }
  webApi(name:'list'|'precreate'|'create'|'filemanager'|'filemetas',params:Record<string,string>={},form?:Record<string,string>){return this.api(name,params,form);}
  async uploadPart(path:string,uploadId:string,index:number,bytes:Uint8Array):Promise<string>{
    baiduWebRoot(path);
    if(!Number.isSafeInteger(index)||index<0||bytes.length>4*1024*1024||!uploadId)throw new BaiduWebProbeError('invalid_part');
    const url=new URL('https://d.pcs.baidu.com/rest/2.0/pcs/superfile2');
    url.search=new URLSearchParams({method:'upload',app_id:'250528',channel:'chunlei',web:'1',clienttype:'0',path,uploadid:uploadId,partseq:String(index)}).toString();
    const boundary='rsnextBaiduPart',head=new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`),tail=new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const body=new Uint8Array(head.length+bytes.length+tail.length);body.set(head);body.set(bytes,head.length);body.set(tail,head.length+bytes.length);
    const result=parseStage((await this.request(url,'POST',body,1024*1024,`multipart/form-data; boundary=${boundary}`,0,'upload')).body,'drive_api');
    if(typeof result.md5!=='string'||!/^[a-f0-9]{32}$/i.test(result.md5))throw new BaiduWebProbeError('part_hash_mismatch');return result.md5.toLowerCase();
  }
  async downloadPath(path:string,size:number):Promise<ArrayBuffer>{
    baiduWebRoot(path);
    if(!Number.isSafeInteger(size)||size<0||size>64*1024*1024)throw new BaiduWebProbeError('file_too_large');
    let url=new URL('https://pcs.baidu.com/rest/2.0/pcs/file');url.search=new URLSearchParams({method:'download',app_id:'250528',path}).toString();
    for(let hop=0;hop<=5;hop++){
      const revision=this.revision,credentialHost=['pcs.baidu.com','d.pcs.baidu.com'].includes(url.hostname);
      let response:BaiduWebProbeResponse;
      try{response=await this.transport({url:url.href,method:'GET',maxBytes:size,transfer:'download',headers:{'Accept-Encoding':'identity','User-Agent':'netdisk',...(credentialHost?{Cookie:this.cookieHeader(url.hostname)}:{})}});}catch(e){if(isSyncCancelled(e)||e instanceof BaiduWebProbeError)throw e;throw new BaiduWebProbeError('network_error');}
      if(revision!==this.revision)throw new BaiduWebProbeError('cancelled');
      if([301,302,303,307,308].includes(response.status)){
        if(hop===5||!response.headers.location)throw new BaiduWebProbeError('invalid_download_redirect');
        try{url=new URL(response.headers.location,url);}catch{throw new BaiduWebProbeError('untrusted_endpoint');}
        if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!['baidupcs.com','baidubce.com','pcs.baidu.com'].some(d=>url.hostname===d||url.hostname.endsWith(`.${d}`)))throw new BaiduWebProbeError('untrusted_endpoint');continue;
      }
      if(response.status!==200)throw new BaiduWebProbeError(`download_http_${response.status}`);
      if(response.body.length!==size)throw new BaiduWebProbeError('size_mismatch');
      return response.body.slice().buffer as ArrayBuffer;
    }
    throw new BaiduWebProbeError('invalid_download_redirect');
  }
  async listRoot():Promise<number>{
    if(!this.csrf)throw new BaiduWebProbeError('login_required');
    const data=await this.api('list',{dir:'/',page:'1',num:'1',order:'name',desc:'0'});
    if(!Array.isArray(data.list))throw new BaiduWebProbeError('invalid_response');return data.list.length;
  }
  async ensureRemoteRoot(value:string):Promise<void> {
    const root=baiduWebRoot(value);
    if(!this.csrf)throw new BaiduWebProbeError('login_required');
    const lookup=async(parent:string,target:string)=>{
      const seen=new Set<string>();let found:any;
      for(let page=1;page<=100;page++){
        const result=await this.api('list',{dir:parent,num:'1000',page:String(page),order:'name',desc:'0'});
        if(!Array.isArray(result.list)||result.list.length>1000)throw new BaiduWebProbeError('incomplete_listing');
        for(const item of result.list){
          if(typeof item.path!=='string'||seen.has(item.path))throw new BaiduWebProbeError('incomplete_listing');
          seen.add(item.path);if(item.path===target)found=item;
        }
        if(result.list.length<1000)return found;
      }
      throw new BaiduWebProbeError('incomplete_listing');
    };
    let parent='/';
    for(const name of root.slice(1).split('/')){
      const target=`${parent==='/'?'':parent}/${name}`;
      let entry=await lookup(parent,target);
      if(!entry){
        const created=await this.api('create',{a:'commit'},{path:target,isdir:'1',block_list:'[]',rtype:'0'});
        if(created.path!==target||created.isdir!==1||!created.fs_id)throw new BaiduWebProbeError('folder_not_confirmed');
        entry=await lookup(parent,target);
        if(!entry||String(entry.fs_id)!==String(created.fs_id))throw new BaiduWebProbeError('folder_not_confirmed');
      }
      if(entry.isdir!==1)throw new BaiduWebProbeError('directory_type_mismatch');
      parent=target;
    }
  }
  /** Isolated four-byte read/write test; never selects an existing user folder. */
  async verifyReadWrite(id:string,root='/'):Promise<{upload:boolean;download:boolean;cleanup:boolean;failure?:string;cleanupFailure?:string}> {
    if(!/^[a-z0-9]{32}$/.test(id))throw new BaiduWebProbeError('invalid_probe_id');
    if(!this.csrf)throw new BaiduWebProbeError('login_required');
    const parentRoot=root==='/'?'':baiduWebRoot(root);
    const directory=`${parentRoot}/rsnext-qr-check-${id}`,path=`${directory}/probe.bin`;
    const bytes=new TextEncoder().encode('RSNX');
    // Four fixed diagnostic bytes, not user content.
    const md5='df5aeefdb938cc1cc64b141b1fea4e8e';
    const result:{upload:boolean;download:boolean;cleanup:boolean;failure?:string;cleanupFailure?:string}={upload:false,download:false,cleanup:false};
    let created=false;
    try {
      const folder=await this.api('create',{a:'commit'},{path:directory,isdir:'1',block_list:'[]',rtype:'0'});
      if(folder.path!==directory||folder.isdir!==1||!folder.fs_id)throw new BaiduWebProbeError('folder_not_confirmed');
      created=true;
      const prepared=await this.api('precreate',{}, {path,size:'4',isdir:'0',autoinit:'1',rtype:'0',block_list:JSON.stringify([md5])});
      if(prepared.return_type!==1||typeof prepared.uploadid!=='string'||!prepared.uploadid||!Array.isArray(prepared.block_list)||prepared.block_list.some((v:unknown)=>v!==0)||prepared.block_list.length>1)
        throw new BaiduWebProbeError('invalid_precreate');
      if(prepared.block_list.length){
        const url=new URL('https://d.pcs.baidu.com/rest/2.0/pcs/superfile2');
        url.search=new URLSearchParams({method:'upload',app_id:'250528',channel:'chunlei',web:'1',clienttype:'0',path,uploadid:prepared.uploadid,partseq:'0'}).toString();
        const boundary=`rsnext${id}`;
        const prefix=new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        const suffix=new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
        const body=new Uint8Array(prefix.length+bytes.length+suffix.length);body.set(prefix);body.set(bytes,prefix.length);body.set(suffix,prefix.length+bytes.length);
        const part=parseBaiduWebJson((await this.request(url,'POST',body,1024*1024,`multipart/form-data; boundary=${boundary}`)).body);
        if(part.md5!==md5)throw new BaiduWebProbeError('part_hash_mismatch');
      }
      const file=await this.api('create',{a:'commit'}, {path,size:'4',isdir:'0',rtype:'0',uploadid:prepared.uploadid,block_list:JSON.stringify([md5])});
      if(file.path!==path||file.size!==4||!file.fs_id)throw new BaiduWebProbeError('upload_not_confirmed');
      const listing=await this.api('list',{dir:directory,num:'100',page:'1',order:'name',desc:'0'});
      if(!Array.isArray(listing.list)||listing.list.length!==1||String(listing.list[0].fs_id)!==String(file.fs_id)||listing.list[0].size!==4)
        throw new BaiduWebProbeError('upload_not_confirmed');
      result.upload=true;
      let url=new URL('https://pcs.baidu.com/rest/2.0/pcs/file');
      url.search=new URLSearchParams({method:'download',app_id:'250528',path}).toString();
      for(let hop=0;hop<=5;hop++){
        const credentialHost=['pcs.baidu.com','d.pcs.baidu.com'].includes(url.hostname);
        const revision=this.revision;
        const response=await this.transport({url:url.href,method:'GET',maxBytes:4,headers:{'Accept-Encoding':'identity','User-Agent':'netdisk',...(credentialHost?{Cookie:this.cookieHeader(url.hostname)}:{})}});
        if(revision!==this.revision)throw new BaiduWebProbeError('cancelled');
        if([301,302,303,307,308].includes(response.status)){
          if(hop===5||!response.headers.location)throw new BaiduWebProbeError('invalid_download_redirect');
          url=new URL(response.headers.location,url);
          if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!['baidupcs.com','baidubce.com','pcs.baidu.com'].some(d=>url.hostname===d||url.hostname.endsWith(`.${d}`)))throw new BaiduWebProbeError('untrusted_endpoint');
          continue;
        }
        if(response.status!==200)throw new BaiduWebProbeError(`download_http_${response.status}`);
        if(response.body.length!==4||response.body.some((b,i)=>b!==bytes[i]))throw new BaiduWebProbeError('download_mismatch');
        result.download=true;break;
      }
    }catch(error){result.failure=error instanceof BaiduWebProbeError?error.code:'network_error';}
    finally {
      if(created){
        try {
          const listing=await this.api('list',{dir:directory,num:'100',page:'1',order:'name',desc:'0'});
          if(!Array.isArray(listing.list)||listing.list.length>1||listing.list.some((f:any)=>f.path!==path||f.isdir!==0))throw new BaiduWebProbeError('cleanup_scope_changed');
          if(listing.list.length)await this.api('filemanager',{opera:'delete',async:'0'},{filelist:JSON.stringify([path])});
          const remaining=await this.api('list',{dir:directory,num:'100',page:'1',order:'name',desc:'0'});
          if(!Array.isArray(remaining.list)||remaining.list.length)throw new BaiduWebProbeError('cleanup_not_empty');
          const deleted=await this.api('filemanager',{opera:'delete',async:'0'},{filelist:JSON.stringify([directory])});
          if(deleted.info!==undefined&&(!Array.isArray(deleted.info)||deleted.info.some((entry:any)=>entry.errno!==0)))throw new BaiduWebProbeError('cleanup_not_confirmed');
          // A successful request may contain per-item failure or lag behind the
          // listing. Do not announce cleanup until a complete parent scan agrees.
          let absent=false;
          const seen=new Set<string>();
          for(let page=1;page<=100;page++){
            const parent=await this.api('list',{dir:parentRoot||'/',num:'1000',page:String(page),order:'name',desc:'0'});
            if(!Array.isArray(parent.list)||parent.list.length>1000)throw new BaiduWebProbeError('cleanup_not_confirmed');
            for(const item of parent.list){
              if(typeof item.path!=='string'||seen.has(item.path)||item.path===directory)throw new BaiduWebProbeError('cleanup_not_confirmed');
              seen.add(item.path);
            }
            if(parent.list.length<1000){absent=true;break;}
          }
          if(!absent)throw new BaiduWebProbeError('cleanup_not_confirmed');
          result.cleanup=true;
        }catch(error){result.cleanupFailure=error instanceof BaiduWebProbeError?error.code:'network_error';}
      }
    }
    return result;
  }

}
