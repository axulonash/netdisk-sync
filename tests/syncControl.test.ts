import { strict as assert } from 'assert';
import { SyncControl, isSyncCancelled } from '../src/syncControl';
describe('Sync run control',()=>{
 it('pauses the next operation and resumes it without replaying completed work',async()=>{
  const control=new SyncControl();let operations=0;
  await control.checkpoint();operations++;
  control.pause();const next=control.checkpoint().then(()=>{operations++;});
  await new Promise(r=>setTimeout(r,5));assert.equal(operations,1);
  control.resume();await next;assert.equal(operations,2);
 });
 it('stop releases paused operations and prevents every later operation',async()=>{
  const control=new SyncControl();control.pause();
  const next=control.checkpoint();control.stop();
  await assert.rejects(next,isSyncCancelled);
  await assert.rejects(control.checkpoint(),isSyncCancelled);
  assert.throws(()=>control.guard(),isSyncCancelled);
 });
});

it('recognizes cancellation through an aggregate error so history records a stopped run',()=>{
 const control=new SyncControl();control.stop();let cause:any;
 try{control.guard();}catch(e){cause=e;}
 assert.equal(isSyncCancelled(new (globalThis as any).AggregateError([new Error('earlier transfer failed'),Object.assign(new Error('task stopped'),{cause})])),true);
});

it('stop closes a pending confirmation and releases the run',async()=>{
 const control=new SyncControl();let closed=false;
 const result=control.waitFor(new Promise<boolean>(()=>{}),()=>{closed=true;});
 control.stop();await assert.rejects(result,isSyncCancelled);assert.equal(closed,true);
});
it('aborts the active native request signal when stopped',()=>{
 const control=new SyncControl();assert.equal(control.signal.aborted,false);control.stop();assert.equal(control.signal.aborted,true);
});
