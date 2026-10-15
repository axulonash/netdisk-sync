export function isSyncCancelled(error: any): boolean {
 const pending=[error], visited=new Set<unknown>();
 while(pending.length && visited.size<100) {
  const current=pending.pop();if(!current || visited.has(current))continue;
  visited.add(current);if(current.code==='sync_cancelled')return true;
  if(current.cause)pending.push(current.cause);
  if(Array.isArray(current.errors))pending.push(...current.errors.slice(0,100));
 }
 return false;
}
export class SyncCancelledError extends Error {
 readonly code = 'sync_cancelled';
 constructor() { super('Sync stopped by user'); this.name='SyncCancelledError'; }
}
/** Cooperative control: requests already sent may finish, new operations wait. */
export class SyncControl {
 private readonly controller=new AbortController();
 readonly signal=this.controller.signal;
 revision = 0;
 state: 'running' | 'paused' | 'stopping' = 'running';
 private waiters = new Set<() => void>();
 private stopListeners = new Set<() => void>();
 pause() { if(this.state==='running'){this.state='paused';this.revision++;} }
 resume() { if(this.state==='paused'){this.state='running';this.revision++;this.release();} }
 stop() { this.controller.abort();this.state='stopping';this.revision++;this.release();for(const listener of this.stopListeners)listener();this.stopListeners.clear(); }
 waitFor<T>(operation: Promise<T>, onStop: () => void): Promise<T> {
  return new Promise<T>((resolve,reject)=>{
   const stop=()=>{try{onStop();}finally{reject(new SyncCancelledError());}};
   if(this.state==='stopping') {stop();operation.catch(()=>{});return;}
   this.stopListeners.add(stop);
   operation.then(value=>{this.stopListeners.delete(stop);resolve(value);},error=>{this.stopListeners.delete(stop);reject(error);});
  });
 }
 private release() { for(const release of this.waiters)release();this.waiters.clear(); }
 guard() { if(this.state==='stopping')throw new SyncCancelledError(); }
 async checkpoint() {
  this.guard();
  while(this.state==='paused') {await new Promise<void>(resolve=>this.waiters.add(resolve));this.guard();}
  this.guard();
 }
}
