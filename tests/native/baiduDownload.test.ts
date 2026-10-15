import { strict as assert } from "assert";
import {
  BaiduDownloadClient,
  BaiduDownloadError,
  type BaiduBinaryRequest,
  type BaiduBinaryTransport,
} from "../../src/native/baiduDownload";
const payload = new ArrayBuffer(4);
new Uint8Array(payload).set([0, 37, 255, 12]);
const target = { fsId: "9007199254740993", size: 4 };
const meta = (dlink = "https://d.pcs.baidu.com/file?signature=fixture") => ({
  status: 200,
  json: { errno: 0, list: [{ fs_id: target.fsId, dlink }] },
});
const reader = (binary: BaiduBinaryTransport, dlink?: string) =>
  new BaiduDownloadClient(
    async () => meta(dlink),
    binary,
    async () => "fixture-token"
  );
describe("Baidu native file download", () => {
  it("looks up the exact decimal file ID and downloads bytes using a session token", async () => {
    const download = new BaiduDownloadClient(
      async ({ url }) => {
        const u = new URL(url);
        assert.equal(u.origin, "https://pan.baidu.com");
        assert.equal(u.pathname, "/rest/2.0/xpan/multimedia");
        assert.equal(u.searchParams.get("method"), "filemetas");
        assert.equal(u.searchParams.get("fsids"), "[9007199254740993]");
        assert.equal(u.searchParams.get("dlink"), "1");
        assert.equal(u.searchParams.get("access_token"), "fixture-token");
        return meta();
      },
      async (request) => {
        const url = new URL(request.url);
        assert.equal(url.searchParams.get("access_token"), "fixture-token");
        assert.equal(url.searchParams.get("signature"), "fixture");
        assert.equal(request.headers["User-Agent"], "pan.baidu.com");
        assert.equal(request.redirect, "manual");
        assert.equal(request.headers.Authorization, undefined);
        assert.equal(request.headers.Cookie, undefined);
        return { status: 200, headers: {}, body: payload };
      },
      async () => "fixture-token"
    );
    assert.deepEqual(await download.readFile(target), payload);
  });
  it("follows trusted HTTPS redirects without copying the token into the next URL", async () => {
    const requests: BaiduBinaryRequest[] = [];
    const download = reader(
      async (request): Promise<Awaited<ReturnType<BaiduBinaryTransport>>> => {
        requests.push(request);
        return requests.length === 1
          ? {
              status: 302,
              headers: {
                Location:
                  "https://cdn.baidupcs.com/file?signed=1&access_token=echoed",
              },
            }
          : { status: 200, headers: {}, body: payload };
      }
    );
    assert.deepEqual(await download.readFile(target), payload);
    assert.equal(
      new URL(requests[1].url).searchParams.get("access_token"),
      null
    );
    assert.equal(new URL(requests[1].url).searchParams.get("signed"), "1");
  });
  for (const url of [
    "https://attacker.example/file",
    "https://baidupcs.com.attacker.example/file",
    "http://d.pcs.baidu.com/file",
    "https://user:secret@d.pcs.baidu.com/file",
    "https://d.pcs.baidu.com:8443/file",
    "https://d.pcs.baidu.com/file#fragment",
  ]) {
    it("rejects an unsafe initial link before sending a credentials-bearing request", async () => {
      let requests = 0;
      await assert.rejects(
        () =>
          reader(async () => {
            requests++;
            return { status: 200, headers: {}, body: payload };
          }, url).readFile(target),
        BaiduDownloadError
      );
      assert.equal(requests, 0);
    });
  }
  it("rejects an off-domain redirect before contacting its destination", async () => {
    let requests = 0;
    await assert.rejects(
      () =>
        reader(async () => {
          requests++;
          return {
            status: 302,
            headers: {
              location: "https://attacker.example/?access_token=fixture-token",
            },
          };
        }).readFile(target),
      BaiduDownloadError
    );
    assert.equal(requests, 1);
  });
  it("bounds redirect loops", async () => {
    let requests = 0;
    await assert.rejects(
      () =>
        reader(async () => {
          requests++;
          return { status: 302, headers: { location: "/loop" } };
        }).readFile(target),
      (e: BaiduDownloadError) => e.code === "redirect_limit"
    );
    assert.equal(requests, 6);
  });
  it("rejects incomplete or partial downloads", async () => {
    for (const response of [
      { status: 200, headers: {}, body: new ArrayBuffer(3) },
      { status: 206, headers: {}, body: payload },
      { status: 200, headers: {} },
    ])
      await assert.rejects(
        () => reader(async () => response).readFile(target),
        BaiduDownloadError
      );
  });
  it("rejects malformed metadata or a mismatched ID without starting a download", async () => {
    for (const json of [
      null,
      {},
      { errno: 0, list: [] },
      {
        errno: 0,
        list: [{ fs_id: "2", dlink: "https://d.pcs.baidu.com/file" }],
      },
      { errno: 0, list: [{ fs_id: target.fsId }] },
    ]) {
      let requests = 0;
      const download = new BaiduDownloadClient(
        async () => ({ status: 200, json }),
        async () => {
          requests++;
          return { status: 200, headers: {}, body: payload };
        },
        async () => "token"
      );
      await assert.rejects(() => download.readFile(target), BaiduDownloadError);
      assert.equal(requests, 0);
    }
  });
  it("preserves numeric platform errors while dropping descriptions", async () => {
    const download = new BaiduDownloadClient(
      async () => ({
        status: 200,
        json: { errno: -6, errmsg: "fixture-token" },
      }),
      async () => {
        throw new Error("unexpected");
      },
      async () => "fixture-token"
    );
    await assert.rejects(
      () => download.readFile(target),
      (e: BaiduDownloadError) =>
        e.errno === -6 && !e.message.includes("fixture-token")
    );
  });
  it("sanitizes binary transport failures", async () => {
    await assert.rejects(
      () =>
        reader(async () => {
          throw new Error("fixture-token");
        }).readFile(target),
      (e: BaiduDownloadError) =>
        e.code === "transport_error" && !e.message.includes("fixture-token")
    );
  });
  it("supports an empty file response without inventing content", async () => {
    assert.equal(
      (
        await reader(async () => ({
          status: 200,
          headers: {},
          body: new ArrayBuffer(0),
        })).readFile({ ...target, size: 0 })
      ).byteLength,
      0
    );
  });
});

describe("Baidu download additional boundaries", () => {
  it("rejects stale size metadata before downloading", async () => {
    let calls = 0;
    const download = new BaiduDownloadClient(
      async () => ({
        status: 200,
        json: {
          errno: 0,
          list: [
            {
              fs_id: target.fsId,
              dlink: "https://d.pcs.baidu.com/file",
              size: 5,
            },
          ],
        },
      }),
      async () => {
        calls++;
        return { status: 200, headers: {}, body: payload };
      },
      async () => "token"
    );
    await assert.rejects(() => download.readFile(target), BaiduDownloadError);
    assert.equal(calls, 0);
  });
  it("rejects missing redirect Location and HTTP errors without returning bytes", async () => {
    for (const status of [302, 403, 429, 503])
      await assert.rejects(
        () => reader(async () => ({ status, headers: {} })).readFile(target),
        BaiduDownloadError
      );
  });
});
