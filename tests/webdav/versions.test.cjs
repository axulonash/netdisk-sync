const assert = require('node:assert/strict');
const {test} = require('node:test');
const {startDav,loadAdapter} = require('./support/harness.cjs');
const {FakeFsWebdav,DEFAULT_WEBDAV_CONFIG,copyFile}=loadAdapter();
const bytes = text=>new TextEncoder().encode(text).buffer;
async function setup(t){
 const server=await startDav({etags:true});t.after(()=>server.close());
 const remote=new FakeFsWebdav({...DEFAULT_WEBDAV_CONFIG,address:server.url,remoteBaseDir:'vault'},'vault',async()=>{});
 await remote.writeFile('a.md',bytes('original'),1,1);
 await remote.walk();server.requests.length=0;
 return {server,remote};
}
test('conditional GET reuses scanned metadata without another PROPFIND',async t=>{
 const {server,remote}=await setup(t);let content;
 await copyFile('a.md',remote,{writeFile:async(k,data)=>{content=data;return{};}});
 assert.equal(new TextDecoder().decode(content),'original');
 assert.deepEqual(server.requests.map(r=>r.method),['GET']);
});
test('a remote edit after scanning cannot be overwritten',async t=>{
 const {server,remote}=await setup(t);
 server.files.get('/vault/a.md').body=Buffer.from('edited elsewhere');
 await assert.rejects(remote.writeFile('a.md',bytes('local'),1,1),e=>e.status===412);
 assert.equal(server.files.get('/vault/a.md').body.toString(),'edited elsewhere');
});
test('a remote edit after scanning cannot be downloaded as the old version',async t=>{
 const {server,remote}=await setup(t);let writes=0;
 server.files.get('/vault/a.md').body=Buffer.from('edited elsewhere');
 await assert.rejects(copyFile('a.md',remote,{writeFile:async()=>{writes++;return{};}}),e=>e.status===412 || e.code==='plan_changed');
 assert.equal(writes,0);
});
test('a remote edit after scanning cannot be deleted',async t=>{
 const {server,remote}=await setup(t);
 server.files.get('/vault/a.md').body=Buffer.from('edited elsewhere');
 await assert.rejects(remote.rm('a.md'),e=>e.status===412);
 assert.ok(server.files.has('/vault/a.md'));
});
test('a newly appeared file cannot be overwritten by a planned creation',async t=>{
 const {server,remote}=await setup(t);
 server.files.set('/vault/new.md',{directory:false,body:Buffer.from('external')});
 await assert.rejects(remote.writeFile('new.md',bytes('local'),1,1),e=>e.status===412);
 assert.equal(server.files.get('/vault/new.md').body.toString(),'external');
});
test('a version replaced between PUT and confirmation is not marked successful',async t=>{
 const {server,remote}=await setup(t);
 const gate=server.hold('PROPFIND','/vault/a.md');
 const uploading=remote.writeFile('a.md',bytes('local'),1,1);
 const outcome=uploading.then(()=>({ok:true}),error=>({error}));
 await gate.entered;
 server.files.get('/vault/a.md').body=Buffer.from('other');
 gate.release();
 const result=await outcome;
 assert.equal(result.error?.code,'plan_changed');
});
