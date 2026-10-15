import { strict as assert } from "assert";
import { EventEmitter } from "events";
import {
  createDesktopQuarkTransport,
  QuarkError,
} from "../../src/native/quarkTransport";
function load(type: string, status: number, length: number, body?: string) {
  return (() => (_url: any, _options: any, callback: any) => {
    const outgoing: any = new EventEmitter();
    outgoing.destroy = () => {};
    outgoing.end = () => {
      const response: any = new EventEmitter();
      response.statusCode = status;
      response.complete = true;
      response.headers = {
        "content-length": String(length),
        "content-type": type,
        "set-cookie": ["secret-cookie"],
        location: "https://secret-link",
      };
      response.destroy = () => {};
      callback(response);
      if (body !== undefined) response.emit("data", new TextEncoder().encode(body));
      response.emit("end");
    };
    return outgoing;
  }) as any;
}
describe("Safe Quark oversized response diagnostics", () => {
  for (const [type, kind] of [
    ["text/html; charset=UTF-8", "html"],
    ["application/json", "json"],
    ["application/octet-stream", "binary"],
  ])
    it(`captures ${kind} headers without cookies or response content`, async () => {
      const transport = createDesktopQuarkTransport(
        true,
        load(type, 200, 1000)
      );
      await assert.rejects(
        transport({
          method: "GET",
          url: "https://dl-pc-zb.pds.quark.cn/file?secret=token",
          maxBytes: 4,
        }),
        (error: any) => {
          assert.ok(error instanceof QuarkError);
          assert.equal(error.code, "response_too_large");
          assert.deepEqual(error.responseInfo, {
            host: "dl-pc-zb.pds.quark.cn",
            status: 200,
            expectedBytes: 4,
            cookieSent: false,
            announcedBytes: 1000,
            kind,
          });
          assert.ok(!JSON.stringify(error).includes("secret"));
          return true;
        }
      );
    });
});

describe("Quark forbidden download diagnostics",()=>{
 it("reports HTTP 403 before applying the file-size body limit",async()=>{
  const transport=createDesktopQuarkTransport(true,load("application/xml",403,376));
  await assert.rejects(transport({method:"GET",url:"https://dl-pc-zd-pds.quark.cn/file",maxBytes:4}),(error:any)=>{assert.equal(error.code,"http_403");assert.equal(error.responseInfo.status,403);assert.equal(error.responseInfo.announcedBytes,376);assert.equal(error.responseInfo.expectedBytes,4);return true;});
 });
});

 describe("Quark download rejection evidence",()=>{
  it("extracts only a known XML error code and indicates sent login headers",async()=>{
   const body="<Error><Code>AccessDenied</Code><Message>secret-token</Message><RequestId>private-id</RequestId></Error>";
   const transport=createDesktopQuarkTransport(true,load("application/xml",403,new TextEncoder().encode(body).length,body));
   await assert.rejects(transport({method:"GET",url:"https://dl-pc-zd-pds.quark.cn/file?secret=url",headers:{Cookie:"secret-cookie"},maxBytes:4}),(e:any)=>{assert.equal(e.code,"http_403");assert.equal(e.responseInfo.cookieSent,true);assert.equal(e.responseInfo.serverCode,"AccessDenied");assert.ok(!JSON.stringify(e).includes("secret"));assert.ok(!JSON.stringify(e).includes("private-id"));return true;});
  });
  it("does not expose unknown error codes",async()=>{
   const body="<Error><Code>secret-token</Code></Error>";
   const transport=createDesktopQuarkTransport(true,load("application/xml",403,body.length,body));
   await assert.rejects(transport({method:"GET",url:"https://dl-pc-zd-pds.quark.cn/file",maxBytes:4}),(e:any)=>{assert.equal(e.code,"http_403");assert.equal(e.responseInfo.serverCode,undefined);assert.ok(!JSON.stringify(e).includes("secret"));return true;});
  });
  it("caps diagnostic response collection independently of file size",async()=>{
   const body="<Error><Code>AccessDenied</Code>"+"x".repeat(5000);
   const transport=createDesktopQuarkTransport(true,load("application/xml",403,body.length,body));
   await assert.rejects(transport({method:"GET",url:"https://dl-pc-zd-pds.quark.cn/file",maxBytes:4}),(e:any)=>{assert.equal(e.code,"http_403");assert.equal(e.responseInfo.serverCode,undefined);return true;});
  });
 });
