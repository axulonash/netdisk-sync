import { strict as assert } from 'assert';
import { BaiduWebProbe, parseBaiduWebJson, type BaiduWebProbeTransport } from '../../src/native/baiduWebProbe';
const response=(json:any,cookies:string[]=[])=>({status:200,body:new TextEncoder().encode(JSON.stringify(json)),cookies,headers:{}});
const qr={errno:0,imgurl:'passport.baidu.com/v2/api/qrcode?sign=short-lived',sign:'short-lived'};
describe('Baidu keyless QR feasibility probe',()=>{
 it('resolves the authenticated stable account identity and rejects a changed account',async()=>{
  const probe=new BaiduWebProbe(async()=>response({errno:0,result:{uk:123}}));
  probe.restoreSession({cookie:'BDUSS=fixture',csrf:'csrf'});
  assert.equal(await probe.resolveAccountId(),'123');
  probe.restoreSession({cookie:'BDUSS=fixture',csrf:'csrf',accountId:'124'});
  await assert.rejects(()=>probe.resolveAccountId(),/account_changed/);
 });
 it('reports the failing batch operation and item error without keeping the raw response',async()=>{
  const probe=new BaiduWebProbe(async()=>response({errno:12,info:[{errno:-8,path:'/private/name'}],secret:'private-cookie'}));
  await assert.rejects(()=>probe.webApi('filemanager',{opera:'rename'},{filelist:'[]'}),(error:any)=>
   error.apiName==='filemanager'&&error.apiOperation==='rename'&&error.itemErrno===-8&&!JSON.stringify(error).includes('private'));
 });
 it('parses JSON and exact JSONP without evaluating server code',()=>{
  assert.deepEqual(parseBaiduWebJson(new TextEncoder().encode('rsnext({"errno":0});'),'rsnext'),{errno:0});
  assert.throws(()=>parseBaiduWebJson(new TextEncoder().encode('evil({"errno":0});'),'rsnext'),/invalid_response/);
 });
 it('starts a QR without app keys and rejects untrusted image destinations',async()=>{
  let captured='';const probe=new BaiduWebProbe(async request=>{captured=request.url;return response(qr);});
  const image=await probe.start();assert.equal(new URL(image).hostname,'passport.baidu.com');
  assert.ok(!captured.includes('client_id')&&!captured.includes('client_secret'));
  const unsafe=new BaiduWebProbe(async()=>response({...qr,imgurl:'evil.test/code'}));
  await assert.rejects(()=>unsafe.start(),/untrusted_endpoint/);
 });
 it('does not mistake a temporary QR ticket for a logged-in drive session',async()=>{
  const calls:string[]=[];
  const transport:BaiduWebProbeTransport=async request=>{
   calls.push(new URL(request.url).pathname);
   if(calls.length===1)return response(qr,['BAIDUID=browser; Domain=.baidu.com; Path=/']);
   if(calls.length===2)return response({errno:0,channel_v:JSON.stringify({status:0,v:'temporary-ticket'})});
   return response({errno:0});
  };
  const probe=new BaiduWebProbe(transport);await probe.start();
  await assert.rejects(()=>probe.check(),/session_cookie_missing/);
  assert.equal(calls[2],'/v3/login/main/qrbdusslogin');
 });
 it('only finishes login after official cookies and a successful drive session check',async()=>{
  let calls=0;
  const probe=new BaiduWebProbe(async request=>{
   calls++;
   if(calls===1)return response(qr);
   if(calls===2)return response({errno:0,channel_v:JSON.stringify({status:0,v:'temporary-ticket'})});
   if(calls===3)return response({errno:0},['BDUSS=actual-cookie; Domain=.baidu.com; Path=/; HttpOnly']);
   assert.equal(new URL(request.url).hostname,'pan.baidu.com');assert.ok(request.headers?.Cookie?.includes('BDUSS=actual-cookie'));
   return response({errno:0,result:{bdstoken:'csrf-token'}});
  });
  await probe.start();assert.equal(await probe.check(),'logged_in');
 });
 it('rejects late login results after cancellation and never sends cookies to the QR image CDN',async()=>{
  let resolve:any;let calls=0;
  const probe=new BaiduWebProbe(async()=>{calls++;if(calls===1)return response(qr);return new Promise(r=>{resolve=r;});});
  await probe.start();const pending=probe.check();probe.cancel();resolve(response({errno:0,channel_v:JSON.stringify({status:0,v:'ticket'})}));
  await assert.rejects(pending,/cancelled/);assert.equal(calls,2);
 });
 it('reports pending, scanned and expiry distinctly',async()=>{
  let now=0;let data:any={errno:1};
  const probe=new BaiduWebProbe(async request=>new URL(request.url).pathname.includes('getqrcode')?response(qr):response(data),()=>now);
  await probe.start();assert.equal(await probe.check(),'pending');
  data={errno:0,channel_v:JSON.stringify({status:1})};assert.equal(await probe.check(),'scanned');
  now=180001;await assert.rejects(()=>probe.check(),/qr_expired/);
 });
 it('refuses to treat cookie values from an unrelated domain as a drive session',async()=>{
  let calls=0;const probe=new BaiduWebProbe(async()=>{
   if(++calls===1)return response(qr);
   if(calls===2)return response({errno:0,channel_v:JSON.stringify({status:0,v:'temporary-ticket'})});
   return response({errno:0},['BDUSS=wrong; Domain=evil.test; Path=/']);
  });
  await probe.start();await assert.rejects(()=>probe.check(),/session_cookie_missing/);
 });
});
describe('Baidu web probe temporary-file boundaries',()=>{
 it('never attempts file writes before a real drive login',async()=>{
  let calls=0;const probe=new BaiduWebProbe(async()=>{calls++;return response({});});
  await assert.rejects(()=>probe.verifyReadWrite('a'.repeat(32)),/login_required/);assert.equal(calls,0);
 });
 it('rejects caller paths rather than allowing probes in user directories',async()=>{
  const probe=new BaiduWebProbe(async()=>response({}));
  await assert.rejects(()=>probe.verifyReadWrite('../notes'),/invalid_probe_id/);
 });
});
describe('Baidu keyless login and temporary-file verification',()=>{
 async function fixture(options:{collision?:boolean;extraFile?:boolean;badDownload?:boolean;directoryNotDeleted?:boolean}={}){
  const id='b'.repeat(32),directory=`/rsnext-qr-check-${id}`,file=`${directory}/probe.bin`;
  let auth=0,uploaded=false,removed=false;const mutations:string[]=[];
  const transport:BaiduWebProbeTransport=async request=>{
   const url=new URL(request.url),name=url.pathname;
   if(name.includes('getqrcode'))return response(qr);
   if(name==='/channel/unicast')return response({errno:0,channel_v:JSON.stringify({status:0,v:'ticket'})});
   if(name.includes('qrbdusslogin'))return response({errno:0},['BDUSS=real-cookie; Domain=.baidu.com; Path=/']);
   if(name.endsWith('gettemplatevariable')){auth++;return response({errno:0,result:{bdstoken:'csrf'}});}
   if(name==='/api/create'){
    const fields=new URLSearchParams(request.body as string);assert.equal(fields.get('rtype'),'0');
    const path=fields.get('path');mutations.push(`create:${path}`);
    if(path===directory){if(options.collision)return response({errno:-8});return response({errno:0,fs_id:'dir',path:directory,isdir:1});}
    assert.equal(path,file);uploaded=true;return response({errno:0,path:file,size:4,fs_id:'file'});
   }
   if(name==='/api/precreate')return response({errno:0,return_type:1,uploadid:'upload',block_list:[0]});
   if(name.endsWith('superfile2'))return response({md5:'df5aeefdb938cc1cc64b141b1fea4e8e'});
   if(name==='/api/list'&&url.searchParams.get('dir')==='/')return response({errno:0,list:options.directoryNotDeleted?[{path:directory,fs_id:'dir',isdir:1}]:[]});
   if(name==='/api/list')return response({errno:0,list:!uploaded||removed?[]:[{path:file,size:4,isdir:0,fs_id:'file'},...(options.extraFile?[{path:directory+'/user.txt',size:5,isdir:0,fs_id:'user'}]:[])]});
   if(name==='/rest/2.0/pcs/file')return {status:302,headers:{location:'https://cdn.baidupcs.com/download'},cookies:[],body:new Uint8Array()};
   if(url.hostname==='cdn.baidupcs.com'){assert.equal(request.headers?.Cookie,undefined);return {status:200,headers:{},cookies:[],body:new TextEncoder().encode(options.badDownload?'FAIL':'RSNX')};}
   if(name==='/api/filemanager'){const paths=JSON.parse(new URLSearchParams(request.body as string).get('filelist')!);assert.ok(paths.every((p:string)=>[file,directory].includes(p)));mutations.push(`delete:${paths[0]}`);if(paths[0]===file)removed=true;return response({errno:0});}
   throw Error('Unexpected request');
  };
  const probe=new BaiduWebProbe(transport);await probe.start();assert.equal(await probe.check(),'logged_in');assert.equal(auth,1);
  return {result:await probe.verifyReadWrite(id),mutations};
 }
 it('verifies all four bytes and strips session cookies on a download redirect',async()=>{
  const f=await fixture();assert.deepEqual(f.result,{upload:true,download:true,cleanup:true});assert.equal(f.mutations.filter(m=>m.startsWith('delete:')).length,2);
 });
 it('never cleans up a colliding pre-existing folder',async()=>{
  const f=await fixture({collision:true});assert.equal(f.result.failure,'api_errno_-8');assert.equal(f.mutations.filter(m=>m.startsWith('delete:')).length,0);
 });
 it('refuses recursive cleanup if unrelated content appears',async()=>{
  const f=await fixture({extraFile:true});assert.equal(f.result.cleanupFailure,'cleanup_scope_changed');assert.equal(f.mutations.filter(m=>m.startsWith('delete:')).length,0);
 });
 it('never calls a mismatched download successful and still cleans up its own file',async()=>{
  const f=await fixture({badDownload:true});assert.equal(f.result.download,false);assert.equal(f.result.failure,'download_mismatch');assert.equal(f.result.cleanup,true);
 });
});

describe('Baidu cleanup confirmation',()=>{
 it('does not trust a successful delete response if the temporary folder remains',async()=>{
  const id='c'.repeat(32),dir=`/rsnext-qr-check-${id}`;let calls=0;
  const probe=new BaiduWebProbe(async req=>{
   const u=new URL(req.url);
   if(++calls===1)return response(qr);
   if(calls===2)return response({errno:0,channel_v:JSON.stringify({status:0,v:'ticket'})});
   if(calls===3)return response({},['BDUSS=actual; Domain=.baidu.com; Path=/']);
   if(calls===4)return response({errno:0,result:{bdstoken:'csrf'}});
   if(u.pathname==='/api/create')return response({errno:0,path:dir,isdir:1,fs_id:'dir'});
   if(u.pathname==='/api/precreate')return response({errno:-1});
   if(u.pathname==='/api/list')return response({errno:0,list:u.searchParams.get('dir')==='/'?[{path:dir,isdir:1,fs_id:'dir'}]:[]});
   return response({errno:0});
  });
  await probe.start();await probe.check();const r=await probe.verifyReadWrite(id);
  assert.equal(r.cleanup,false);assert.equal(r.cleanupFailure,'cleanup_not_confirmed');
 });
});
describe('Baidu drive session bootstrap after QR confirmation',()=>{
 it('completes the drive landing hop and preserves pan-scoped cookies before checking again',async()=>{
  const paths:string[]=[];let infoCalls=0;
  const probe=new BaiduWebProbe(async request=>{
   const u=new URL(request.url);paths.push(u.pathname);
   if(u.pathname.includes('getqrcode'))return response(qr);
   if(u.pathname==='/channel/unicast')return response({errno:0,channel_v:JSON.stringify({status:0,v:'ticket'})});
   if(u.pathname.includes('qrbdusslogin'))return response({errno:0},['BDUSS=real; Domain=.baidu.com; Path=/']);
   if(u.pathname==='/api/gettemplatevariable'){
    if(++infoCalls===1)return response({errno:-6});
    assert.ok(request.headers?.Cookie?.includes('STOKEN=drive-cookie'));return response({errno:0,result:{bdstoken:'csrf'}});
   }
   if(u.pathname==='/disk/main')return {status:302,headers:{location:'/disk/home'},cookies:['STOKEN=drive-cookie; Path=/; HttpOnly'],body:new Uint8Array()};
   if(u.pathname==='/disk/home'){assert.ok(request.headers?.Cookie?.includes('STOKEN=drive-cookie'));return response({});}
   if(u.hostname==='pcs.baidu.com'){assert.ok(!request.headers?.Cookie?.includes('STOKEN'));return {status:403,headers:{},cookies:[],body:new Uint8Array()};}
   if(u.pathname==='/api/list')return response({errno:0,list:[]});
   return response({errno:-1});
  });
  await probe.start();assert.equal(await probe.check(),'logged_in');assert.equal(infoCalls,2);assert.ok(paths.includes('/disk/home'));
  const session=probe.sessionSnapshot();assert.ok(session.scopedCookies?.some(c=>c.host==='pan.baidu.com'&&c.name==='STOKEN'&&c.value==='drive-cookie'));
 });
 it('never reports logged in when bootstrap still returns -6',async()=>{
  let infoCalls=0;
  const probe=new BaiduWebProbe(async request=>{
   const path=new URL(request.url).pathname;
   if(path.includes('getqrcode'))return response(qr);
   if(path==='/channel/unicast')return response({errno:0,channel_v:JSON.stringify({status:0,v:'ticket'})});
   if(path.includes('qrbdusslogin'))return response({errno:0},['BDUSS=real; Domain=.baidu.com; Path=/']);
   if(path==='/api/gettemplatevariable'){infoCalls++;return response({errno:-6});}
   return response({});
  });
  await probe.start();await assert.rejects(()=>probe.check(),/drive_session_api_errno_-6/);assert.equal(infoCalls,2);
 });
 it('rejects a failed QR session exchange even if the server sets a BDUSS cookie',async()=>{
  let calls=0;
  const probe=new BaiduWebProbe(async()=>{
   if(++calls===1)return response(qr);
   if(calls===2)return response({errno:0,channel_v:JSON.stringify({status:0,v:'ticket'})});
   if(calls===3)return response({errInfo:{no:'310005'}},['BDUSS=invalid; Domain=.baidu.com; Path=/']);
   return response({errno:0,result:{bdstoken:'csrf'}});
  });
  await probe.start();await assert.rejects(()=>probe.check(),/login_rejected/);assert.equal(calls,3);
 });
});
describe('Baidu scoped-cookie persistence and session redirect limits',()=>{
 it('restores pan cookies for drive requests without flattening their scope',async()=>{
  const probe=new BaiduWebProbe(async req=>{
   assert.equal(new URL(req.url).hostname,'pan.baidu.com');
   assert.ok(req.headers?.Cookie?.includes('BDUSS=parent'));
   assert.ok(req.headers?.Cookie?.includes('STOKEN=pan'));
   assert.ok(!req.headers?.Cookie?.includes('passport-only'));
   return response({errno:0,list:[]});
  });
  probe.restoreSession({cookie:'BDUSS=parent',csrf:'csrf',scopedCookies:[{host:'pan.baidu.com',name:'STOKEN',value:'pan'},{host:'passport.baidu.com',name:'STOKEN',value:'passport-only'}]});
  assert.equal(await probe.listRoot(),0);assert.equal(probe.sessionSnapshot().cookie,'BDUSS=parent');
 });
 it('rejects persisted cookies for unrelated hosts',()=>{
  const probe=new BaiduWebProbe(async()=>response({}));
  assert.throws(()=>probe.restoreSession({cookie:'BDUSS=parent',csrf:'csrf',scopedCookies:[{host:'evil.test',name:'STOKEN',value:'private'}]}),/invalid_session/);
 });
 for(const location of ['https://evil.test/steal','http://pan.baidu.com/disk/home','https://pcs.baidu.com/file']){
  it(`rejects a drive bootstrap redirect outside the login boundary: ${location}`,async()=>{
   let external=false;
   const probe=new BaiduWebProbe(async req=>{
    const path=new URL(req.url).pathname;
    if(path.includes('getqrcode'))return response(qr);
    if(path==='/channel/unicast')return response({errno:0,channel_v:JSON.stringify({status:0,v:'ticket'})});
    if(path.includes('qrbdusslogin'))return response({errno:0},['BDUSS=parent; Domain=.baidu.com; Path=/']);
    if(path==='/api/gettemplatevariable')return response({errno:-6});
    if(path==='/disk/main')return {status:302,headers:{location},cookies:[],body:new Uint8Array()};
    external=true;return response({});
   });
   await probe.start();await assert.rejects(()=>probe.check(),/untrusted_endpoint/);assert.equal(external,false);
  });
 }
});
describe('Baidu passport JSONP object-literal responses',()=>{
 it('accepts the official exchange shape with a single-quoted data key without executing JavaScript',()=>{
  const body=new TextEncoder().encode(`rsnext_baidu_probe({"errInfo":{"no":"0"}, 'data': {"session": {"version":"v3"}}, "traceid":""})`);
  assert.equal(parseBaiduWebJson(body,'rsnext_baidu_probe').errInfo.no,'0');
 });
 for(const payload of ['{data: stealCookie()}','{get data(){return 1}}','{...evil}','{__proto__: {secret:1}}','{data: (()=>1)()}']){
  it(`rejects executable or prototype-changing payload: ${payload}`,()=>{
   assert.throws(()=>parseBaiduWebJson(new TextEncoder().encode(`expected(${payload});`),'expected'),/invalid_response/);
  });
 }
 it('reports which stage returned an invalid response',async()=>{
  let calls=0;const probe=new BaiduWebProbe(async()=>{
   if(++calls===1)return response(qr);
   if(calls===2)return response({errno:0,channel_v:JSON.stringify({status:0,v:'ticket'})});
   return {status:200,headers:{},cookies:['BDUSS=real; Domain=.baidu.com; Path=/'],body:new TextEncoder().encode('<html>login required</html>')};
  });
  await probe.start();await assert.rejects(()=>probe.check(),/qr_exchange_invalid_response/);
 });
});
describe('Baidu QR selected sync directory',()=>{
 it('creates missing ancestors and verifies them without treating API failure as absence',async()=>{
  const folders=new Set<string>();const created:string[]=[];
  const probe=new BaiduWebProbe(async request=>{
   const u=new URL(request.url);
   if(u.pathname==='/api/list'){
    const dir=u.searchParams.get('dir');return response({errno:0,list:[...folders].filter(p=>(p.slice(0,p.lastIndexOf('/'))||'/')===dir).map(path=>({path,isdir:1,fs_id:path}))});
   }
   const form=new URLSearchParams(request.body as string),path=form.get('path')!;created.push(path);folders.add(path);return response({errno:0,path,isdir:1,fs_id:path});
  });
  probe.restoreSession({cookie:'BDUSS=real',csrf:'csrf'});
  await probe.ensureRemoteRoot('/我的笔记/测试库/');assert.deepEqual(created,['/我的笔记','/我的笔记/测试库']);
  await probe.ensureRemoteRoot('/我的笔记/测试库');assert.equal(created.length,2);
 });
 it('does not create folders after a listing permission error',async()=>{
  let writes=0;const probe=new BaiduWebProbe(async request=>{if(request.method==='POST')writes++;return response({errno:-6});});
  probe.restoreSession({cookie:'BDUSS=real',csrf:'csrf'});
  await assert.rejects(()=>probe.ensureRemoteRoot('/notes'),/api_errno_-6/);assert.equal(writes,0);
 });
 it('rejects a root directory or traversal before any network request',async()=>{
  let calls=0;const probe=new BaiduWebProbe(async()=>{calls++;return response({});});probe.restoreSession({cookie:'BDUSS=real',csrf:'csrf'});
  for(const root of ['/','../notes','/notes/../other','/notes//child'])await assert.rejects(()=>probe.ensureRemoteRoot(root),/invalid_root/);
  assert.equal(calls,0);
 });
 it('puts the isolated probe under the selected folder and checks cleanup against that parent',async()=>{
  const id='d'.repeat(32),root='/notes',directory=`${root}/rsnext-qr-check-${id}`;const created:string[]=[];let parentChecked=false;
  const probe=new BaiduWebProbe(async request=>{
   const u=new URL(request.url);
   if(u.pathname==='/api/create'){const path=new URLSearchParams(request.body as string).get('path')!;created.push(path);return response({errno:0,path,isdir:1,fs_id:'dir'});}
   if(u.pathname==='/api/precreate')return response({errno:-1});
   if(u.pathname==='/api/list'){if(u.searchParams.get('dir')===root)parentChecked=true;return response({errno:0,list:[]});}
   return response({errno:0});
  });
  probe.restoreSession({cookie:'BDUSS=real',csrf:'csrf'});const result=await probe.verifyReadWrite(id,root);
  assert.deepEqual(created,[directory]);assert.equal(result.cleanup,true);assert.equal(parentChecked,true);
 });
});
