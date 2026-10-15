import {strict as assert} from "assert";
import {retryWebdavRead} from "../src/webdavRetry";
describe("Bounded WebDAV read retries",()=>{
 it("stops after three transient failures and preserves the original error",async()=>{
  let attempts=0;const waits:number[]=[];const error=Object.assign(new Error("temporary"),{status:503});
  await assert.rejects(retryWebdavRead("list",async()=>{attempts++;throw error;},()=>{},async ms=>{waits.push(ms);}),e=>e===error);
  assert.equal(attempts,3);assert.equal(waits.length,2);
 });
 it("does not retry authentication or permissions failures",async()=>{
  for(const status of [401,403,404,412]){
   let attempts=0;
   await assert.rejects(retryWebdavRead("stat",async()=>{attempts++;throw {status};},()=>{},async()=>{throw new Error("unexpected wait");}));
   assert.equal(attempts,1);
  }
 });
 it("honors Retry-After without waiting beyond the bounded retry budget",async()=>{
  for(const seconds of [3,60]){
   let attempts=0;const waits:number[]=[];
   const operation=()=>retryWebdavRead("list",async()=>{if(++attempts===1)throw {status:429,response:{headers:new Headers({"Retry-After":String(seconds)})}};return "complete";},()=>{},async ms=>{waits.push(ms);});
   if(seconds===3){assert.equal(await operation(),"complete");assert.deepEqual(waits,[3000]);}
   else {await assert.rejects(operation());assert.equal(attempts,1);assert.deepEqual(waits,[]);}
  }
 });
});
