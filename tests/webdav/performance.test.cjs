const assert = require('node:assert/strict');
const {test} = require('node:test');
const {loadAdapter} = require('./support/harness.cjs');
const {FakeFsWebdav,DEFAULT_WEBDAV_CONFIG} = loadAdapter();
const entry = (name,type='directory') => ({filename:'/vault/'+name,type,size:0,lastmod:'2026-01-01'});
function remote() {
  const fs=new FakeFsWebdav({...DEFAULT_WEBDAV_CONFIG,address:'https://example.test',remoteBaseDir:'vault'},'vault',async()=>{});
  fs._init=async()=>{};
  return fs;
}
test('directory scanning fills free slots while another directory is still waiting',async()=>{
  const fs=remote();let release,started;
  const gate=new Promise(r=>release=r), later=new Promise(r=>started=r);
  let active=0,peak=0;
  fs.client={getDirectoryContents:async path=>{
    active++;peak=Math.max(peak,active);
    try {
      if(path==='/vault')return Array.from({length:20},(_,i)=>entry('d'+i));
      if(path==='/vault/d0')await gate;
      if(path==='/vault/d10')started(true);
      return [];
    }finally{active--;}
  }};
  const walking=fs.walk();
  let timer;
  const progressed=await Promise.race([later,new Promise(r=>{timer=setTimeout(()=>r(false),200);})]);
  clearTimeout(timer);release();await walking;
  assert.equal(progressed,true,'a slow folder must not block the next batch');
  assert.ok(peak<=6,'directory concurrency must be bounded');
});
test('a transient directory 503 recovers before publishing a complete scan',async()=>{
  const fs=remote();let attempts=0;
  fs.client={getDirectoryContents:async()=>{
    if(++attempts===1)throw Object.assign(new Error('temporary'),{status:503});
    return [entry('a.md','file')];
  }};
  assert.deepEqual((await fs.walk()).map(e=>e.key),['a.md']);
  assert.equal(attempts,2);
});
test('scan publishes discovered counts as directories finish',async()=>{
  const fs=remote(), counts=[];
  fs.onScanProgress=(files,folders)=>counts.push([files,folders]);
  fs.client={getDirectoryContents:async path=>path==='/vault'?[entry('notes'),entry('a.md','file')]:[entry('notes/b.md','file')]};
  await fs.walk();
  assert.deepEqual(counts.at(-1),[2,1]);
});
test('failed writes are not blindly replayed',async()=>{
  const fs=remote();let writes=0;
  fs.client={customRequest:async()=>{writes++;throw Object.assign(new Error('temporary'),{status:503});}};
  await assert.rejects(fs.writeFile('a.md',new ArrayBuffer(4),1,1));
  assert.equal(writes,1);
});
test('folder deletion preserves children added after the scan',async()=>{
  const fs=remote();let changed=false,deletes=0;
  fs.client={getDirectoryContents:async path=>path==='/vault'?[entry('notes')]:changed?[entry('notes/new.md','file')]:[],deleteFile:async()=>{deletes++;}};
  await fs.walk();changed=true;
  await assert.rejects(fs.rm('notes/'),e=>e.code==='plan_changed');
  assert.equal(deletes,0);
});
test('a lost PUT response is reconciled by version and content without uploading twice',async()=>{
 const fs=remote();let writes=0;
 const body=new TextEncoder().encode('hello').buffer;
 fs.client={customRequest:async()=>{writes++;throw Object.assign(new Error('lost'),{code:'ECONNRESET'});},
  stat:async path=>({...entry(path.slice('/vault/'.length),'file'),size:5,etag:'new-version'}),
  getFileContents:async(_path,options)=>{assert.equal(options.headers['If-Match'],'"new-version"');return body;}};
 const result=await fs.writeFile('a.md',body,1,1);
 assert.equal(result.sizeRaw,5);assert.equal(writes,1);
});
test('reconciliation never treats different bytes as a successful upload',async()=>{
 const fs=remote();let writes=0;
 fs.client={customRequest:async()=>{writes++;throw Object.assign(new Error('lost'),{code:'ECONNRESET'});},
  stat:async path=>({...entry(path.slice('/vault/'.length),'file'),size:5,etag:'other-version'}),
  getFileContents:async()=>new TextEncoder().encode('other').buffer};
 await assert.rejects(fs.writeFile('a.md',new TextEncoder().encode('hello').buffer,1,1));
 assert.equal(writes,1);
});
test('a later remote version is not recorded as this upload',async()=>{
 const fs=remote();
 fs.client={customRequest:async()=>new Response(null,{status:201,headers:{etag:'"uploaded-version"'}}),
  stat:async path=>({...entry(path.slice('/vault/'.length),'file'),size:5,etag:'another-client-version'})};
 await assert.rejects(fs.writeFile('a.md',new TextEncoder().encode('hello').buffer,1,1),e=>e.code==='plan_changed');
});
