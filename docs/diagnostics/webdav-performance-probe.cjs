/* Run from project root: node docs/diagnostics/webdav-performance-probe.cjs.
 * Bundles current source using the regression harness. SDK calls are simulated;
 * no external or loopback network, accounts, credentials or vault files used.
 */
const {loadAdapter} = require('../../tests/webdav/support/harness.cjs');
const {FakeFsWebdav,DEFAULT_WEBDAV_CONFIG} = loadAdapter();
function fresh(){
 const fs=new FakeFsWebdav({...DEFAULT_WEBDAV_CONFIG,address:'https://example.test',remoteBaseDir:'vault'},'vault',async()=>{});
 fs._init=async()=>{};return fs;
}
(async()=>{
 const make=name=>({filename:'/vault/'+name,type:'directory',size:0,lastmod:'2026-01-01'});
 const remote=fresh();let calls=0,active=0,peak=0;const started=[];
 remote.client={getDirectoryContents:async p=>{
  calls++;active++;peak=Math.max(peak,active);started.push([p,Math.round(performance.now()-start)]);
  await new Promise(r=>setTimeout(r,p==='/vault/d0'?200:10));active--;
  return p==='/vault'?Array.from({length:20},(_,i)=>make('d'+i)):[];
 }};
 const start=performance.now();await remote.walk();
 console.log(JSON.stringify({scenario:'20 sibling folders; d0=200ms; others=10ms',calls,peak,elapsedMs:Math.round(performance.now()-start),d10StartMs:started.find(x=>x[0]==='/vault/d10')[1]}));
 let attempts=0;remote.client={getDirectoryContents:async()=>{if(++attempts===1)throw Object.assign(new Error('HTTP 503'),{status:503});return [];}};
 await remote.walk();
 console.log(JSON.stringify({scenario:'one temporary scan 503',attempts,result:'recovered'}));
 const uploading=fresh();let put=0,stat=0;
 uploading.client={customRequest:async()=>{put++;return new Response(null,{status:201});},stat:async p=>{stat++;return {filename:p,type:'file',size:4,lastmod:'2026-01-01'};}};
 for(let i=0;i<100;i++)await uploading.writeFile('f'+i+'.md',new ArrayBuffer(4),1,1);
 console.log(JSON.stringify({scenario:'100 tiny WebDAV uploads; necessary confirmations retained',put,stat,total:put+stat}));
})().catch(e=>{console.error(e);process.exitCode=1;});
