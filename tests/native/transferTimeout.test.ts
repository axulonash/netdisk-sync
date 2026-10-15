import {strict as assert} from "assert";
import * as policy from "../../src/native/httpsPool";
describe("Native transfer deadline budget",()=>{
 it("allows slow large transfers while bounding stalled requests",()=>{
   const timeout=(policy as any).nativeTransferTimeout;
   assert.equal(typeof timeout,"function");
   assert.equal(timeout(4),60000);
   assert.ok(timeout(64*1024*1024)>5*60000);
   assert.ok(timeout(Number.MAX_SAFE_INTEGER)<=10*60000);
 });
 it("allows measured slow Aliyun downloads without extending other provider deadlines",()=>{
   const timeout=(policy as any).nativeDownloadTimeout;
   assert.equal(typeof timeout,"function");
   assert.ok(timeout(2*1024*1024)>=110000);
   assert.ok(timeout(4*1024*1024)>=200000);
   assert.ok(timeout(64*1024*1024)<=30*60*1000);
 });
});
