const assert=require('node:assert/strict');
const {test}=require('node:test');
globalThis.__rsNextDesktopFixture=true;
const {loadAdapter,startDav}=require('./support/harness.cjs');
const {FakeFsWebdav,DEFAULT_WEBDAV_CONFIG}=loadAdapter();
const bytes=text=>new TextEncoder().encode(text).buffer;
async function setup(t){const server=await startDav({etags:true});t.after(()=>server.close());const remote=new FakeFsWebdav({...DEFAULT_WEBDAV_CONFIG,address:server.url,remoteBaseDir:'vault'},'vault',async()=>{});return{server,remote};}
test('desktop SDK transport preserves conditional CRUD and file contents',async t=>{
 const {server,remote}=await setup(t);
 await remote.mkdir('notes/');await remote.writeFile('notes/a.html',bytes('网页 HTML'),1,1);
 assert.deepEqual((await remote.walk()).map(e=>e.key).sort(),['notes/','notes/a.html']);
 assert.equal(new TextDecoder().decode(await remote.readFile('notes/a.html')),'网页 HTML');
 await remote.writeFile('notes/a.html',bytes('updated'),1,1);
 assert.equal(server.files.get('/vault/notes/a.html').body.toString(),'updated');
 await remote.rm('notes/a.html');await remote.rm('notes/');assert.deepEqual(await remote.walk(),[]);
});
test('stopping a desktop read really closes the active request',async t=>{
 const {server,remote}=await setup(t);await remote.writeFile('a.html',bytes('file'),1,1);await remote.walk();
 const gate=server.hold('GET','/vault/a.html');
 const result=remote.readFile('a.html').then(()=>({ok:true}),error=>({error}));
 await gate.entered;remote.cancelPendingReads();
 const outcome=await result;gate.release();
 assert.equal(outcome.error?.code,'sync_cancelled');assert.equal(remote.diagnostics.retries,0);
});
test('desktop target appends the current vault name instead of an old debug target',async t=>{
 const server=await startDav();t.after(()=>server.close());server.files.set('/home',{directory:true,body:Buffer.alloc(0)});server.files.set('/home/Drive',{directory:true,body:Buffer.alloc(0)});
 const remote=new FakeFsWebdav({...DEFAULT_WEBDAV_CONFIG,address:server.url,parentDir:'/home/Drive',remoteBaseDir:'/home/Drive/test'},'我的笔记本',async()=>{});
 await remote.walk();await remote.writeFile('note.md',bytes('current vault'),1,1);
 assert.equal(server.files.get('/home/Drive/我的笔记本/note.md').body.toString(),'current vault');assert.equal(server.files.has('/home/Drive/test'),false);
});

test('stopping during OPTIONS cancels the active capability request',async t=>{
 const {server,remote}=await setup(t);server.files.set('/vault',{directory:true,body:Buffer.alloc(0)});
 const gate=server.hold('OPTIONS','/vault');const result=remote.walk().then(()=>({ok:true}),error=>({error}));
 await gate.entered;remote.cancelPendingReads();let timer;
 const outcome=await Promise.race([result,new Promise(resolve=>timer=setTimeout(()=>resolve({hung:true}),100))]);
 clearTimeout(timer);gate.release();await result;
 assert.equal(outcome.error?.code,'sync_cancelled');
});
