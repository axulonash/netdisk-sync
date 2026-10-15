import { strict as assert } from "assert";
import { bindQuarkSession } from "../../src/native/quarkAuth";
import { QuarkClient } from "../../src/native/quarkClient";
import type { QuarkTransport } from "../../src/native/quarkTransport";
const result = (data: unknown, cookies: string[] = [], metadata?: unknown) => ({status:200,headers:{},cookies,body:new TextEncoder().encode(JSON.stringify({code:0,status:200,data,metadata}))});
function fixture(updates: string[]) {
 const config={session:bindQuarkSession("__pus=stable; __puus=old", "a".repeat(32)),remoteRoot:"/test"};
 const seen: string[]=[];
 const transport:QuarkTransport=async request=>{
  const url=new URL(request.url);
  if(url.hostname==="dl-pc-zd-pds.quark.cn") {seen.push(request.headers?.Cookie??"");return {status:200,headers:{},cookies:[],body:new Uint8Array([1,2,3,4])};}
  if(url.pathname.endsWith("/file/download")) return result([{fid:"note",download_url:"https://dl-pc-zd-pds.quark.cn/note"}],updates);
  const root=url.searchParams.get("pdir_fid")==="0";
  return result({list:[{fid:root?"root":"note",file_name:root?"test":"note.md",file:!root,size:root?0:4,updated_at:0,created_at:0,pdir_fid:root?"0":"root"}]},[],{_total:1});
 };
 return {client:new QuarkClient(transport,()=>config),config,seen};
}
describe("Quark API session rotation",()=>{
 it("uses the credential refreshed by download metadata without changing the saved account binding",async()=>{
  const f=fixture(["__puus=fresh; Domain=.quark.cn; Path=/; Secure; HttpOnly"]);
  const before=JSON.stringify(f.config);
  await f.client.read("note.md");
  assert.equal(f.seen[0],"__pus=stable; __puus=fresh");
  assert.equal(JSON.stringify(f.config),before);
 });
 it("rejects foreign, host-only, narrow-path and malformed cookie updates",async()=>{
  const f=fixture(["__puus=foreign; Domain=evil.example; Path=/", "__puus=hostonly; Path=/", "__puus=narrow; Domain=.quark.cn; Path=/api", "__puus=bad\r\n; Domain=.quark.cn; Path=/"]);
  await f.client.read("note.md");assert.equal(f.seen[0],"__pus=stable; __puus=old");
 });
 it("removes explicitly expired session cookies",async()=>{
  const f=fixture(["__puus=gone; Domain=.quark.cn; Path=/; Max-Age=0"]);
  await f.client.read("note.md");assert.equal(f.seen[0],"__pus=stable");
 });
});
