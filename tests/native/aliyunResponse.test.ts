import { strict as assert } from "assert";
import { EventEmitter } from "events";
import { createDesktopAliyunTransport } from "../../src/native/aliyunTransport";
function load(body: string, type = "application/xml") {
  return (() => (_url: any, _options: any, callback: any) => {
    const outgoing: any = new EventEmitter();
    outgoing.destroy = () => {};
    outgoing.end = () => {
      const response: any = new EventEmitter();
      response.statusCode = 403;
      response.complete = true;
      response.headers = {
        "content-type": type,
        "content-length": String(Buffer.byteLength(body)),
      };
      response.destroy = () => {};
      callback(response);
      response.emit("data", Buffer.from(body));
      response.emit("end");
    };
    return outgoing;
  }) as any;
}
describe("Aliyun safe transfer rejection diagnostics", () => {
  for (const method of ["GET", "PUT"] as const)
    it(`keeps ${method} HTTP 403 and known XML code without raw secrets`, async () => {
      const transport = createDesktopAliyunTransport(
        true,
        load(
          "<Error><Code>SignatureDoesNotMatch</Code><Message>secret-url</Message></Error>"
        )
      );
      await assert.rejects(
        transport({
          url: "https://cn-beijing-data.aliyundrive.net/file?token=secret",
          method,
          maxBytes: 4,
        }),
        (e: any) => {
          assert.equal(e.code, "http_403");
          assert.equal(e.responseInfo.serverCode, "SignatureDoesNotMatch");
          assert.equal(e.responseInfo.host, "cn-beijing-data.aliyundrive.net");
          assert.ok(!JSON.stringify(e).includes("secret"));
          return true;
        }
      );
    });
  it("omits arbitrary server codes", async () => {
    await assert.rejects(
      createDesktopAliyunTransport(
        true,
        load("<Code>PrivateUserSecret</Code>")
      )({ url: "https://cn-beijing-data.aliyundrive.net/file", method: "PUT" }),
      (e: any) => {
        assert.equal(e.code, "http_403");
        assert.equal(e.responseInfo.serverCode, undefined);
        assert.ok(!JSON.stringify(e).includes("PrivateUserSecret"));
        return true;
      }
    );
  });
});
