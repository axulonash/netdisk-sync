import { strict as assert } from "assert";
import { createHash } from "crypto";
import {
  QuarkQrLogin,
  bindQuarkSession,
  getQuarkProfileId,
  quarkKey,
  quarkRoot,
  quarkOverwriteBinding,
  type QuarkConfig,
} from "../../src/native/quarkAuth";
import { QuarkClient } from "../../src/native/quarkClient";
import {
  QuarkError,
  quarkUrl,
  createDesktopQuarkTransport,
  type QuarkRequest,
  type QuarkResponse,
  type QuarkTransport,
} from "../../src/native/quarkTransport";
import { FakeFsQuark } from "../../src/fsQuark";
import { api, bytes, setup } from "./support/baiduSyncHarness";
const reply = (json: unknown, cookies: string[] = []): QuarkResponse => ({
  status: 200,
  headers: {},
  cookies,
  body: new TextEncoder().encode(JSON.stringify(json)),
});
const code = (expected: string) => (error: any) =>
  error instanceof QuarkError && error.code === expected;
describe("Quark direct QR login", () => {
  it("discards an in-flight QR response after cancellation", async () => {
    let resolve!: (value: QuarkResponse) => void;
    let first = true;
    const login = new QuarkQrLogin(async () => {
      if (first) {
        first = false;
        return new Promise<QuarkResponse>((r) => (resolve = r));
      }
      return reply({
        status: 2000000,
        data: { members: { token: "new-token" } },
      });
    });
    const started = login.start();
    login.cancel();
    resolve(
      reply({ status: 2000000, data: { members: { token: "old-token" } } }, [
        "__pus=old; Domain=.quark.cn; Path=/",
      ])
    );
    await assert.rejects(started, code("qr_expired"));
    await login.start();
    login.cancel();
  });
  it("does not keep explicitly expired domain cookies", async () => {
    const responses = [
      reply({ status: 2000000, data: { members: { token: "token" } } }),
      reply(
        { status: 2000000, data: { members: { service_ticket: "ticket" } } },
        ["__pus=old; Domain=.quark.cn; Path=/"]
      ),
      reply({ success: true }, [
        "__pus=old; Domain=.quark.cn; Path=/; Max-Age=0",
        "expired=old; Domain=.quark.cn; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        "__puus=new; Domain=.quark.cn; Path=/",
      ]),
    ];
    const login = new QuarkQrLogin(async () => responses.shift()!);
    await login.start();
    assert.equal((await login.check())?.cookie, "__puus=new");
  });

  it("removes cleared cookies instead of retaining an earlier login value", async () => {
    const responses = [
      reply({ status: 2000000, data: { members: { token: "token" } } }),
      reply(
        { status: 2000000, data: { members: { service_ticket: "ticket" } } },
        ["__pus=old; Domain=.quark.cn; Path=/"]
      ),
      reply({ success: true }, [
        "__pus=; Domain=.quark.cn; Path=/",
        "__puus=new; Domain=.quark.cn; Path=/",
      ]),
    ];
    const login = new QuarkQrLogin(async () => responses.shift()!);
    await login.start();
    assert.equal((await login.check())?.cookie, "__puus=new");
  });

  it("retains login cookies from the ticket exchange as well as the final account response", async () => {
    const responses = [
      reply({ status: 2000000, data: { members: { token: "token" } } }),
      reply(
        { status: 2000000, data: { members: { service_ticket: "ticket" } } },
        [
          "__pus=ticket-cookie; Domain=.quark.cn; Path=/; Secure",
          "foreign=bad; Domain=evil.example; Path=/",
        ]
      ),
      reply({ success: true }, [
        "__puus=account-cookie; Domain=.quark.cn; Path=/; Secure",
      ]),
    ];
    const login = new QuarkQrLogin(async () => responses.shift()!);
    await login.start();
    const session = await login.check();
    assert.equal(session?.cookie, "__pus=ticket-cookie; __puus=account-cookie");
  });

  it("exchanges the official QR token and ticket for a domain session without a gateway", async () => {
    const requests: QuarkRequest[] = [];
    const responses = [
      reply({ status: 2000000, data: { members: { token: "qr-token" } } }),
      reply({ status: 50004001 }),
      reply({
        status: 2000000,
        data: { members: { service_ticket: "ticket" } },
      }),
      reply({ success: true }, [
        "__puus=secret; Domain=.quark.cn; Path=/; Secure; HttpOnly",
        "foreign=bad; Domain=evil.example; Path=/",
      ]),
    ];
    const login = new QuarkQrLogin(async (request) => {
      requests.push(request);
      return responses.shift()!;
    });
    const qr = new URL(await login.start());
    assert.equal(qr.hostname, "su.quark.cn");
    assert.equal(qr.searchParams.get("token"), "qr-token");
    assert.equal(await login.check(), undefined);
    const session = await login.check();
    assert.equal(session?.cookie, "__puus=secret");
    assert.deepEqual(
      requests.map((r) => new URL(r.url).hostname),
      ["uop.quark.cn", "uop.quark.cn", "uop.quark.cn", "pan.quark.cn"]
    );
    assert.equal(new URL(requests[3].url).searchParams.get("st"), "ticket");
    assert.ok(requests.every((r) => !r.headers?.Cookie));
    await assert.rejects(login.check(), code("qr_expired"));
  });
  it("expires drafts and cancels in-flight login without retaining the ticket", async () => {
    let now = 0;
    const login = new QuarkQrLogin(
      async () =>
        reply({ status: 2000000, data: { members: { token: "token" } } }),
      () => now
    );
    await login.start();
    now = 300000;
    await assert.rejects(login.check(), code("qr_expired"));
    now = 0;
    await login.start();
    login.cancel();
    await assert.rejects(login.check(), code("qr_expired"));
  });
  it("rejects missing, host-only and foreign-domain session cookies", async () => {
    for (const cookie of [
      "",
      "__puus=secret; Path=/",
      "__puus=secret; Domain=.evil.example; Path=/",
      "__puus=secret; Domain=.quark.cn; Path=/account",
    ]) {
      const responses = [
        reply({ status: 2000000, data: { members: { token: "t" } } }),
        reply({ status: 2000000, data: { members: { service_ticket: "s" } } }),
        reply({ success: true }, cookie ? [cookie] : []),
      ];
      const login = new QuarkQrLogin(async () => responses.shift()!);
      await login.start();
      await assert.rejects(login.check(), code("session_cookie_missing"));
    }
  });
  it("does not expose raw server messages or session cookies in errors", async () => {
    const login = new QuarkQrLogin(async () =>
      reply({ status: 500, message: "secret-token" })
    );
    await assert.rejects(
      login.start(),
      (error) => !String(error).includes("secret-token")
    );
  });
});
describe("Quark sync scope and endpoint validation", () => {
  it("permits session cookies only on approved download GET targets", async () => {
    let loaded = 0;
    const transport = createDesktopQuarkTransport(true, () => {
      loaded++;
      throw new Error("mock HTTPS");
    });
    for (const host of [
      "dl-pc-zb.pds.quark.cn",
      "dl-pc-zb.drive.quark.cn",
      "dl-pc-zd-pds.quark.cn",
    ]) {
      await assert.rejects(
        transport({
          method: "GET",
          url: `https://${host}/file`,
          headers: { Cookie: "test" },
        }),
        code("transport_unavailable")
      );
    }
    assert.equal(loaded, 3);
    for (const host of [
      "dl-pc-zb.pds.quark.cn.evil.example",
      "dl-pc-zb.evil.pds.quark.cn",
      "dl-pc-zd-pds.quark.cn.evil.example",
      "other.dl-pc-zd-pds.quark.cn",
      "other.quark.cn",
      "test-bucket.pds.quark.cn",
    ]) {
      await assert.rejects(
        transport({
          method: "GET",
          url: `https://${host}/file`,
          headers: { Cookie: "test" },
        })
      );
      assert.equal(loaded, 3);
    }
    await assert.rejects(
      transport({
        method: "PUT",
        url: "https://dl-pc-zb.pds.quark.cn/file",
        headers: { Cookie: "test" },
      }),
      code("credential_destination")
    );
    assert.equal(loaded, 3);
  });

  it("sends upload authorization only to an approved Quark PDS bucket and never forwards cookies there", async () => {
    let loaded = 0;
    const transport = createDesktopQuarkTransport(true, () => {
      loaded++;
      throw new Error("mock transport");
    });
    await assert.rejects(
      transport({
        method: "PUT",
        url: "https://test-bucket.pds.quark.cn/file",
        headers: { Authorization: "OSS test" },
      }),
      code("transport_unavailable")
    );
    assert.equal(loaded, 1);
    for (const host of [
      "pan.quark.cn",
      "pds.quark.cn",
      "bucket.evil.pds.quark.cn",
      "test-bucket.pds.quark.cn.evil.example",
    ]) {
      await assert.rejects(
        transport({
          method: "PUT",
          url: `https://${host}/file`,
          headers: { Authorization: "OSS test" },
        })
      );
      assert.equal(loaded, 1);
    }
    await assert.rejects(
      transport({
        method: "PUT",
        url: "https://test-bucket.pds.quark.cn/file",
        headers: { Cookie: "secret" },
      }),
      code("credential_destination")
    );
    assert.equal(loaded, 1);
  });

  for (const path of [
    "/",
    "/a//b",
    "/../a",
    "/a/./b",
    "/a\u0000b",
    "/bad\ud800",
  ]) {
    it(`rejects unsafe root ${JSON.stringify(path)}`, () =>
      assert.throws(() => quarkRoot(path), QuarkError));
  }
  it("preserves long Unicode and percent-containing names", () => {
    const name = "测试 % #".repeat(80);
    assert.deepEqual(quarkKey(name), [name]);
    assert.equal(quarkRoot(`/笔记/${name}/`), `/笔记/${name}`);
  });
  for (const url of [
    "http://drive-pc.quark.cn/",
    "https://quark.cn.evil.example/",
    "https://user:secret@pan.quark.cn/",
    "https://pan.quark.cn:444/",
    "https://localhost/",
  ]) {
    it(`rejects untrusted endpoint ${url}`, () =>
      assert.throws(() => quarkUrl(url), QuarkError));
  }
  it("isolates history by login, root and encryption settings without exposing credentials", () => {
    const config = {
      session: bindQuarkSession("__puus=secret", "a".repeat(32)),
      remoteRoot: "/测试",
    };
    const profile = getQuarkProfileId(config, "", "unknown");
    assert.match(profile, /^quark-v1-[a-f0-9]{64}$/);
    assert.notEqual(
      profile,
      getQuarkProfileId({ ...config, remoteRoot: "/other" }, "", "unknown")
    );
    assert.notEqual(
      profile,
      getQuarkProfileId(config, "pwd", "openssl-base64")
    );
    assert.throws(
      () =>
        getQuarkProfileId(
          { ...config, session: { ...config.session, cookie: "imported" } },
          "",
          "unknown"
        ),
      code("login_required")
    );
    assert.throws(
      () => getQuarkProfileId(config, "pwd", "rclone-base64"),
      code("encryption_not_yet_supported")
    );
  });
  it("never loads Node HTTPS on mobile or when credentials have a foreign destination", async () => {
    const load = () => {
      throw new Error("must not load");
    };
    await assert.rejects(
      createDesktopQuarkTransport(
        false,
        load
      )({ method: "GET", url: "https://pan.quark.cn/" }),
      code("desktop_required")
    );
    await assert.rejects(
      createDesktopQuarkTransport(
        true,
        load
      )({
        method: "GET",
        url: "https://bucket.oss-cn.aliyuncs.com/",
        headers: { Cookie: "secret" },
      }),
      code("credential_destination")
    );
  });
});
function fixture(
  uploadEndpoint = "http://oss-cn-hangzhou.aliyuncs.com/",
  visibilityDelay = 0,
  downloadHost = "drive-pc.quark.cn"
) {
  let config: QuarkConfig = {
    session: bindQuarkSession("__puus=secret", "a".repeat(32)),
    remoteRoot: "/test",
  };
  const requests: QuarkRequest[] = [];
  const files = new Map<
    string,
    { name: string; fid: string; bytes: Uint8Array }
  >();
  let delayedReads = 0;
  let shadow: any;
  let shadowName = "";
  let collisionHttp400 = false;
  let rejectAllRename = false;
  let overwriteRename = false;
  let nextFid = 1;
  let failPublish = false;
  let failBackup = false;
  let pre: any;
  let pending = new Uint8Array();
  let denyDelete = false;
  let autoRename = false;
  let beforeRequest: (request: QuarkRequest) => void = () => {};
  const raw = (file: { name: string; fid: string; bytes: Uint8Array }) => ({
    fid: file.fid,
    file_name: file.name,
    size: file.bytes.length,
    file: true,
    created_at: 1700000000000,
    updated_at: 1700000001000,
    pdir_fid: "root",
  });
  const transport: QuarkTransport = async (request) => {
    requests.push(request);
    beforeRequest(request);
    const url = new URL(request.url);
    const body =
      typeof request.body === "string"
        ? JSON.parse(request.body.startsWith("<") ? "{}" : request.body)
        : {};
    const success = (data: any) => reply({ code: 0, status: 200, data });
    if (url.pathname === "/1/clouddrive/file/sort") {
      const entries =
        url.searchParams.get("pdir_fid") === "0"
          ? [
              {
                fid: "root",
                file_name: "test",
                file: false,
                size: 0,
                created_at: 0,
                updated_at: 0,
                pdir_fid: "0",
              },
            ]
          : [...files.values()]
              .filter((file) => !(delayedReads > 0 && file.name === shadowName))
              .concat(delayedReads > 0 && shadow ? [shadow] : [])
              .map(raw);
      if (url.searchParams.get("pdir_fid") !== "0" && delayedReads > 0)
        delayedReads--;
      return reply({
        code: 0,
        status: 200,
        data: { list: entries },
        metadata: { _total: entries.length },
      });
    }
    if (url.pathname === "/1/clouddrive/file/download")
      return success([
        {
          fid: body.fids[0],
          download_url: `https://${downloadHost}/data/${body.fids[0]}`,
        },
      ]);
    if (url.pathname.startsWith("/data/")) {
      if (downloadHost !== "drive-pc.quark.cn" && !request.headers?.Cookie)
        throw new QuarkError("response_too_large");
      const file = [...files.values()].find(
        (f) => f.fid === url.pathname.slice(6)
      );
      return {
        status: 200,
        headers: {},
        cookies: [],
        body: file!.bytes.slice(),
      };
    }
    if (url.pathname === "/1/clouddrive/file/upload/pre") {
      pre = body;
      pending = new Uint8Array();
      return reply({
        code: 0,
        status: 200,
        data: {
          task_id: "task",
          upload_id: "upload",
          obj_key: "objects/item",
          bucket: "test-bucket",
          upload_url: uploadEndpoint,
          auth_info: "auth-info",
          callback: {
            callbackUrl: "https://drive-pc.quark.cn/callback",
            callbackBody: "body",
          },
        },
        metadata: { part_size: 65536 },
      });
    }
    if (url.pathname === "/1/clouddrive/file/update/hash")
      return success({ finish: false });
    if (url.pathname === "/1/clouddrive/file/upload/auth")
      return success({ auth_key: "OSS secret" });
    if (
      url.hostname.endsWith(".aliyuncs.com") ||
      url.hostname === "test-bucket.pds.quark.cn"
    ) {
      assert.equal(request.headers?.Cookie, undefined);
      if (request.method === "PUT") {
        const chunk = request.body as Uint8Array;
        const all = new Uint8Array(pending.length + chunk.length);
        all.set(pending);
        all.set(chunk, pending.length);
        pending = all;
      }
      return {
        status: 200,
        headers: {
          etag: '"' + createHash("md5").update(pending).digest("hex") + '"',
        },
        cookies: [],
        body: new Uint8Array(),
      };
    }
    if (url.pathname === "/1/clouddrive/file/upload/finish") {
      const previous = files.get(pre.file_name);
      shadow = previous
        ? { ...previous, bytes: previous.bytes.slice() }
        : undefined;
      shadowName = pre.file_name;
      delayedReads = visibilityDelay;
      const name =
        previous && autoRename ? `${pre.file_name} (1)` : pre.file_name;
      files.set(name, {
        name,
        fid: previous && !autoRename ? previous.fid : `f${nextFid++}`,
        bytes: pending.slice(),
      });
      return success({});
    }
    if (url.pathname === "/1/clouddrive/file/rename") {
      const found = [...files].find(([, file]) => file.fid === body.fid);
      if (
        (failPublish &&
          body.file_name === "note.md" &&
          found?.[1].name.startsWith("rsnext-upload-")) ||
        (failBackup && body.file_name.startsWith("rsnext-backup-"))
      )
        throw new QuarkError("transport_error", true);
      if (rejectAllRename || (collisionHttp400 && files.has(body.file_name)))
        return {
          ...reply({
            code: 23009,
            status: 400,
            message: "private-server-message",
          }),
          status: 400,
        };
      if (!found || (files.has(body.file_name) && !overwriteRename))
        throw new QuarkError("api_rejected", true);
      if (overwriteRename) files.delete(body.file_name);
      const [oldName, file] = found;
      files.delete(oldName);
      file.name = body.file_name;
      files.set(file.name, file);
      return success({});
    }
    if (url.pathname === "/1/clouddrive/file/delete") {
      if (!denyDelete)
        for (const [name, file] of files)
          if (body.filelist.includes(file.fid)) files.delete(name);
      return success({});
    }
    throw new Error(`unexpected fixture request ${url.pathname}`);
  };
  const client = new QuarkClient(transport, () => config);
  return {
    client,
    transport,
    requests,
    files,
    config: () => config,
    replace: (next: QuarkConfig) => {
      config = next;
    },
    denyDelete: () => {
      denyDelete = true;
    },
    autoRename: () => {
      autoRename = true;
    },
    collisionHttp400: () => {
      collisionHttp400 = true;
    },
    rejectAllRename: () => {
      rejectAllRename = true;
    },
    overwriteRename: () => {
      overwriteRename = true;
    },
    failPublish: () => {
      failPublish = true;
    },
    failBackup: () => {
      failBackup = true;
    },
    beforeRequest: (callback: (request: QuarkRequest) => void) => {
      beforeRequest = callback;
    },
  };
}
describe("Quark file operations with actual multipart protocol", () => {
  for (const destination of [
    "drive-pc.quark.cn",
    "dl-pc-zb.pds.quark.cn",
    "bucket.oss-cn-hangzhou.aliyuncs.com",
  ])
    it(`strips session cookies on download redirect to ${destination}`, async () => {
      const f = fixture();
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await f.client.write("note.md", bytes.buffer, 1, 1);
      let hops = 0;
      const client = new QuarkClient(
        async (request) => {
          const url = new URL(request.url);
          if (url.pathname.startsWith("/data/")) {
            assert.equal(request.headers?.Cookie, "__puus=secret");
            hops++;
            return {
              status: 302,
              headers: { location: `https://${destination}/redirect` },
              cookies: [],
              body: new Uint8Array(),
            };
          }
          if (url.pathname === "/redirect") {
            assert.equal(request.headers?.Cookie, undefined);
            hops++;
            return { status: 200, headers: {}, cookies: [], body: bytes };
          }
          return f.transport(request);
        },
        () => f.config()
      );
      assert.deepEqual(new Uint8Array(await client.read("note.md")), bytes);
      assert.equal(hops, 2);
    });

  for (const host of [
    "dl-pc-zb.pds.quark.cn",
    "dl-pc-zb.drive.quark.cn",
    "dl-pc-zd-pds.quark.cn",
  ])
    it(`authenticates first read-back on the official download host ${host}`, async () => {
      const f = fixture("https://pds.quark.cn", 0, host);
      assert.equal(
        await f.client.verifyOverwrite(),
        quarkOverwriteBinding(f.config())
      );
      const downloads = f.requests.filter(
        (request) => new URL(request.url).hostname === host
      );
      assert.ok(downloads.length > 0);
      assert.ok(
        downloads.every(
          (request) => request.headers?.Cookie === "__puus=secret"
        )
      );
      assert.equal(f.files.size, 0);
    });

  it("stops read-back retries after the account changes during the confirmation wait", async () => {
    const f = fixture("https://pds.quark.cn", 2);
    let countAtChange = -1;
    f.beforeRequest((request) => {
      if (new URL(request.url).pathname.endsWith("/upload/finish"))
        setTimeout(() => {
          f.replace({
            ...f.config(),
            session: bindQuarkSession("__puus=other"),
          });
          countAtChange = f.requests.length;
        }, 100);
    });
    await assert.rejects(
      f.client.verifyOverwrite(),
      code("sync_scope_changed")
    );
    assert.ok(countAtChange > 0);
    assert.equal(f.requests.length, countAtChange);
    assert.equal(f.config().overwriteVerified, undefined);
  });
  it("reports cleanup failure even when overwrite confirmation failed and never grants capability", async () => {
    const f = fixture();
    f.autoRename();
    f.denyDelete();
    await assert.rejects(
      f.client.verifyOverwrite(),
      (error: any) =>
        error.code === "replacement_recovery_required" &&
        error.stage === "overwrite"
    );
    assert.equal(f.config().overwriteVerified, undefined);
  });

  it("confirms delayed initial and overwritten listings without repeating file mutations", async () => {
    const f = fixture("https://pds.quark.cn", 2);
    assert.equal(
      await f.client.verifyOverwrite(),
      quarkOverwriteBinding(f.config())
    );
    assert.equal(f.files.size, 0);
    assert.equal(
      f.requests.filter((request) =>
        new URL(request.url).pathname.endsWith("/upload/pre")
      ).length,
      2
    );
    assert.equal(
      f.requests.filter((request) =>
        new URL(request.url).pathname.endsWith("/file/delete")
      ).length,
      2
    );
  });

  it("prepares overwrite capability through the Quark PDS upload endpoint without sending session cookies", async () => {
    const f = fixture("https://pds.quark.cn");
    assert.equal(
      await f.client.verifyOverwrite(),
      quarkOverwriteBinding(f.config())
    );
    const uploads = f.requests.filter(
      (request) => new URL(request.url).hostname === "test-bucket.pds.quark.cn"
    );
    assert.ok(uploads.length > 0);
    assert.ok(
      uploads.every((request) => request.headers?.Cookie === undefined)
    );
    assert.equal(f.files.size, 0);
  });

  it("uploads parts, commits, reads back and maps metadata to the sync filesystem", async () => {
    const f = fixture();
    const fs = new FakeFsQuark(f.client);
    const bytes = new Uint8Array(70001).fill(23);
    const saved = await fs.writeFile(
      "中文%.md",
      bytes.buffer,
      1700000001000,
      1700000000000
    );
    assert.equal(saved.key, "中文%.md");
    assert.equal(saved.size, bytes.length);
    assert.deepEqual(new Uint8Array(await fs.readFile("中文%.md")), bytes);
    assert.equal((await fs.walk()).length, 1);
    assert.equal(f.requests.filter((r) => r.method === "PUT").length, 2);
    assert.ok(
      f.requests
        .filter((r) => new URL(r.url).hostname.endsWith(".aliyuncs.com"))
        .every((r) => !r.headers?.Cookie)
    );
  });
  it("blocks changed-file overwrite before uploading or deleting without a verified capability", async () => {
    const f = fixture();
    f.files.set("note.md", {
      name: "note.md",
      fid: "old",
      bytes: new Uint8Array([1]),
    });
    await assert.rejects(
      f.client.write("note.md", new Uint8Array([2]).buffer, 1, 1),
      code("overwrite_not_verified")
    );
    assert.deepEqual(f.files.get("note.md")!.bytes, new Uint8Array([1]));
    assert.ok(
      !f.requests.some((r) => /upload|delete/.test(new URL(r.url).pathname))
    );
  });
  it("verifies overwrite on a disposable file and cleans it up before enabling capability", async () => {
    const f = fixture();
    const binding = await f.client.verifyOverwrite();
    assert.equal(binding, quarkOverwriteBinding(f.config()));
    assert.equal(f.files.size, 0);
    f.replace({ ...f.config(), overwriteVerified: binding });
    f.files.set("note.md", {
      name: "note.md",
      fid: "old",
      bytes: new Uint8Array([1]),
    });
    await f.client.write("note.md", new Uint8Array([2, 3]).buffer, 1, 1);
    assert.deepEqual(f.files.get("note.md")!.bytes, new Uint8Array([2, 3]));
    const deletedOld = f.requests.findIndex(
      (r) =>
        new URL(r.url).pathname.endsWith("/delete") &&
        (r.body as string).includes('"old"')
    );
    const publish = f.requests.findIndex(
      (r) =>
        new URL(r.url).pathname.endsWith("/rename") &&
        JSON.parse(r.body as string).file_name === "note.md"
    );
    assert.ok(deletedOld > publish && publish >= 0);
    assert.ok(
      f.requests
        .filter((r) => new URL(r.url).pathname.endsWith("/pre"))
        .every((r) => !JSON.parse(r.body as string).same_path_reuse)
    );
  });
  it("verifies staged replacement on auto-renaming servers", async () => {
    const f = fixture();
    f.autoRename();
    assert.equal(
      await f.client.verifyOverwrite(),
      quarkOverwriteBinding(f.config())
    );
    assert.equal(f.files.size, 0);
  });
  it("requires confirmed deletion and fails a capability probe when cleanup fails", async () => {
    const f = fixture();
    f.files.set("note.md", {
      name: "note.md",
      fid: "old",
      bytes: new Uint8Array([1]),
    });
    f.denyDelete();
    await assert.rejects(
      f.client.remove("note.md"),
      code("delete_not_confirmed")
    );
    await assert.rejects(
      f.client.verifyOverwrite(),
      code("replacement_recovery_required")
    );
    assert.equal(f.config().overwriteVerified, undefined);
  });
  it("never deletes a replacement FID during probe cleanup and does not grant capability", async () => {
    const f = fixture();
    let owned = "";
    f.beforeRequest((request) => {
      if (new URL(request.url).pathname.endsWith("/delete")) {
        owned = JSON.parse(request.body as string).filelist[0];
        const [name, file] = [...f.files][0];
        f.files.set(name, { ...file, fid: "replacement" });
      }
    });
    await assert.rejects(
      f.client.verifyOverwrite(),
      code("replacement_recovery_required")
    );
    assert.notEqual(owned, "replacement");
    assert.equal([...f.files.values()][0].fid, "replacement");
    assert.equal(f.config().overwriteVerified, undefined);
  });
  it("keeps disposable probe residues out of note scans on other devices", async () => {
    const f = fixture();
    const name = `rs-overwrite-check-${"x".repeat(32)}.bin`;
    f.files.set(name, { name, fid: "residue", bytes: new Uint8Array([1]) });
    f.files.set("note.md", {
      name: "note.md",
      fid: "note",
      bytes: new Uint8Array([2]),
    });
    assert.deepEqual(
      (await f.client.scan()).map((e) => e.key),
      ["note.md"]
    );
  });
  it("stops stale clients before requests after changing login or root", async () => {
    const f = fixture();
    f.replace({ ...f.config(), remoteRoot: "/other" });
    await assert.rejects(f.client.scan(), code("sync_scope_changed"));
    assert.equal(f.requests.length, 0);
  });
  it("fails closed on duplicate names, incomplete pages and cyclic IDs", async () => {
    for (const variant of ["duplicate", "incomplete", "cycle"]) {
      const config = fixture().config();
      const item = {
        fid: variant === "cycle" ? "0" : "f1",
        file_name: "test",
        size: 0,
        file: false,
        created_at: 0,
        updated_at: 0,
      };
      const client = new QuarkClient(
        async () =>
          reply({
            code: 0,
            status: 200,
            data: {
              list:
                variant === "duplicate"
                  ? [item, item]
                  : variant === "incomplete"
                    ? []
                    : [item],
            },
            metadata: { _total: 1 },
          }),
        () => config
      );
      await assert.rejects(client.scan(), QuarkError);
    }
  });
  it("rejects empty plaintext uploads and unsupported rename without changing remote data", async () => {
    const f = fixture();
    const fs = new FakeFsQuark(f.client);
    await assert.rejects(
      fs.writeFile("empty.md", new ArrayBuffer(0), 1, 1),
      code("empty_upload_not_supported")
    );
    await assert.rejects(fs.rename("a", "b"), code("rename_not_supported"));
    assert.equal(f.files.size, 0);
  });
});
describe("Quark through real sync planning, encryption and history", () => {
  for (const password of ["", "test-password"])
    it(`pushes then skips unchanged notes: ${password ? "OpenSSL" : "plain"}`, async () => {
      const q = fixture();
      const f = setup();
      const fs = new api.FakeFsEncrypt(
        new FakeFsQuark(q.client),
        password,
        "openssl-base64"
      );
      const profile = getQuarkProfileId(q.config(), password, "openssl-base64");
      const settings = {
        ...f.settings,
        serviceType: "quark",
        password,
        encryptionMethod: "openssl-base64",
      };
      const history = () =>
        api.getAllPrevSyncRecordsByVaultAndProfile(f.db, "vault", profile);
      const plan = async () =>
        api.buildSyncPlan({
          localEntityList: await f.local.walk(),
          remoteEntityList: await fs.walk(),
          prevSyncEntityList: await history(),
          fsEncrypt: fs,
          settings,
          triggerSource: "manual",
          configDir: ".obsidian",
        });
      const run = async () =>
        api.doActualSync(
          await plan(),
          f.local,
          fs,
          "vault",
          profile,
          5,
          -1,
          undefined,
          f.db,
          undefined,
          "keep_newer",
          "manual"
        );
      await f.local.writeFile("中文.md", bytes("完整笔记"), 10123, 10123);
      await run();
      assert.equal((await history()).length, 1);
      assert.equal(
        new TextDecoder().decode(await fs.readFile("中文.md")),
        "完整笔记"
      );
      const uploaded = q.requests.filter((r) => r.method === "PUT").length;
      assert.equal((await plan())["中文.md"].change, false);
      await run();
      assert.equal(
        q.requests.filter((r) => r.method === "PUT").length,
        uploaded
      );
      if (password) assert.ok(!q.files.has("中文.md"));
      // Changed files must not advance history while overwrite remains unverified.
      const before = await history();
      await f.local.writeFile("中文.md", bytes("更新后"), 20123, 10123);
      await assert.rejects(run());
      assert.deepEqual(await history(), before);
      assert.equal(
        new TextDecoder().decode(await fs.readFile("中文.md")),
        "完整笔记"
      );
    });
  it("factory binds the selected Quark provider and refuses stale service settings", async () => {
    const q = fixture();
    const settings: any = {
      serviceType: "quark",
      quarkNative: q.config(),
      password: "",
      encryptionMethod: "unknown",
    };
    const fs = api.getClient(settings, "vault", async () => {}, {
      quarkTransport: q.transport,
      getSettings: () => settings,
    });
    assert.equal(fs.kind, "quark");
    assert.deepEqual(await fs.walk(), []);
    settings.serviceType = "webdav";
    await assert.rejects(async () => fs.walk());
  });
});

describe("Quark safe replacement on auto-renaming servers", () => {
  it("passes preparation and replaces content without uploading a duplicate target name", async () => {
    const f = fixture();
    f.autoRename();
    const binding = await f.client.verifyOverwrite();
    f.replace({ ...f.config(), overwriteVerified: binding });
    f.files.set("note.md", {
      name: "note.md",
      fid: "old",
      bytes: new Uint8Array([4]),
    });
    await f.client.write("note.md", new Uint8Array([7, 8]).buffer, 1, 1);
    assert.deepEqual(f.files.get("note.md")!.bytes, new Uint8Array([7, 8]));
    assert.equal(f.files.size, 1);
    assert.ok(
      !f.requests
        .filter((r) => new URL(r.url).pathname.endsWith("/upload/pre"))
        .some((r) => JSON.parse(r.body as string).same_path_reuse)
    );
  });
  it("preserves old content when backup rename fails", async () => {
    const f = fixture();
    f.autoRename();
    f.replace({
      ...f.config(),
      overwriteVerified: quarkOverwriteBinding(f.config()),
    });
    f.files.set("note.md", {
      name: "note.md",
      fid: "old",
      bytes: new Uint8Array([4]),
    });
    f.failBackup();
    await assert.rejects(
      f.client.write("note.md", new Uint8Array([7, 8]).buffer, 1, 1)
    );
    assert.equal(f.files.get("note.md")!.fid, "old");
    assert.deepEqual(f.files.get("note.md")!.bytes, new Uint8Array([4]));
  });
  it("restores the old name when publishing the verified new file fails", async () => {
    const f = fixture();
    f.autoRename();
    f.replace({
      ...f.config(),
      overwriteVerified: quarkOverwriteBinding(f.config()),
    });
    f.files.set("note.md", {
      name: "note.md",
      fid: "old",
      bytes: new Uint8Array([4]),
    });
    f.failPublish();
    await assert.rejects(
      f.client.write("note.md", new Uint8Array([7, 8]).buffer, 1, 1)
    );
    assert.equal(f.files.get("note.md")!.fid, "old");
    assert.deepEqual(f.files.get("note.md")!.bytes, new Uint8Array([4]));
  });
  it("stops before renaming if the target changes while the staged file uploads", async () => {
    const f = fixture();
    f.replace({
      ...f.config(),
      overwriteVerified: quarkOverwriteBinding(f.config()),
    });
    f.files.set("note.md", {
      name: "note.md",
      fid: "old",
      bytes: new Uint8Array([4]),
    });
    f.beforeRequest((r) => {
      if (new URL(r.url).pathname.endsWith("/upload/finish"))
        f.files.set("note.md", {
          name: "note.md",
          fid: "external",
          bytes: new Uint8Array([9]),
        });
    });
    await assert.rejects(
      f.client.write("note.md", new Uint8Array([7, 8]).buffer, 1, 1)
    );
    assert.equal(f.files.get("note.md")!.fid, "external");
    assert.ok(
      !f.requests.some((r) => new URL(r.url).pathname.endsWith("/file/rename"))
    );
  });
  it("blocks scans with an interrupted backup instead of treating an absent target as deletion", async () => {
    const f = fixture();
    const name = `rsnext-backup-${"a".repeat(32)}--note.md`;
    f.files.set(name, { name, fid: "old", bytes: new Uint8Array([4]) });
    await assert.rejects(
      f.client.scan(),
      code("replacement_recovery_required")
    );
  });
});

describe("Quark replacement failure boundaries", function () {
  this.timeout(10000);
  function prepared() {
    const f = fixture();
    f.autoRename();
    f.replace({
      ...f.config(),
      overwriteVerified: quarkOverwriteBinding(f.config()),
    });
    f.files.set("note.md", {
      name: "note.md",
      fid: "old",
      bytes: new Uint8Array([4]),
    });
    return f;
  }
  it("does not repeat rename after a successful publish loses its response", async () => {
    const f = prepared();
    let lost = false;
    const client = new QuarkClient(
      async (r) => {
        const response = await f.transport(r);
        if (
          new URL(r.url).pathname.endsWith("/rename") &&
          JSON.parse(r.body as string).file_name === "note.md" &&
          !lost
        ) {
          lost = true;
          throw new QuarkError("transport_error", true);
        }
        return response;
      },
      () => f.config()
    );
    await client.write("note.md", new Uint8Array([7, 8]).buffer, 1, 1);
    assert.deepEqual(f.files.get("note.md")!.bytes, new Uint8Array([7, 8]));
    assert.equal(f.files.size, 1);
    assert.equal(
      f.requests.filter(
        (r) =>
          new URL(r.url).pathname.endsWith("/rename") &&
          JSON.parse(r.body as string).file_name === "note.md"
      ).length,
      1
    );
  });
  it("preserves a recoverable backup and blocks scanning if publishing and rollback both fail", async () => {
    const f = prepared();
    const client = new QuarkClient(
      async (r) => {
        if (
          new URL(r.url).pathname.endsWith("/rename") &&
          JSON.parse(r.body as string).file_name === "note.md"
        )
          throw new QuarkError("transport_error", true);
        return f.transport(r);
      },
      () => f.config()
    );
    await assert.rejects(
      client.write("note.md", new Uint8Array([7, 8]).buffer, 1, 1),
      code("replacement_recovery_required")
    );
    const backup = [...f.files.values()].find((file) =>
      file.name.startsWith("rsnext-backup-")
    )!;
    assert.equal(backup.fid, "old");
    assert.deepEqual(backup.bytes, new Uint8Array([4]));
    assert.ok(backup.name.endsWith("--note.md"));
    await assert.rejects(client.scan(), code("replacement_recovery_required"));
    assert.ok(
      !f.requests.some((r) => new URL(r.url).pathname.endsWith("/file/delete"))
    );
  });
  it("does not touch the old name if staged content fails download validation", async () => {
    const f = prepared();
    const client = new QuarkClient(
      async (r) => {
        const response = await f.transport(r);
        if (
          new URL(r.url).pathname.startsWith("/data/") &&
          new URL(r.url).pathname !== "/data/old"
        )
          return { ...response, body: new Uint8Array([99, 99]) };
        return response;
      },
      () => f.config()
    );
    await assert.rejects(
      client.write("note.md", new Uint8Array([7, 8]).buffer, 1, 1),
      code("upload_not_confirmed")
    );
    assert.equal(f.files.get("note.md")!.fid, "old");
    assert.deepEqual(f.files.get("note.md")!.bytes, new Uint8Array([4]));
    assert.ok(
      !f.requests.some((r) => /rename|delete/.test(new URL(r.url).pathname))
    );
  });
  it("does not mutate a new account when authorization changes after backup rename", async () => {
    const f = prepared();
    let count = -1;
    const client = new QuarkClient(
      async (r) => {
        const response = await f.transport(r);
        if (
          new URL(r.url).pathname.endsWith("/rename") &&
          JSON.parse(r.body as string).file_name.startsWith("rsnext-backup-")
        ) {
          f.replace({
            ...f.config(),
            session: bindQuarkSession("__puus=another"),
          });
          count = f.requests.length;
        }
        return response;
      },
      () => f.config()
    );
    await assert.rejects(
      client.write("note.md", new Uint8Array([7, 8]).buffer, 1, 1),
      code("sync_scope_changed")
    );
    assert.ok(count > 0);
    assert.equal(f.requests.length, count);
    assert.ok(
      [...f.files.values()].some(
        (file) => file.fid === "old" && file.name.startsWith("rsnext-backup-")
      )
    );
  });
});

describe("Quark rename collision contract", () => {
  it("does not enable replacement on a server whose rename overwrites occupied names", async () => {
    const f = fixture();
    f.overwriteRename();
    await assert.rejects(
      f.client.verifyOverwrite(),
      code("rename_overwrites_target")
    );
    assert.equal(f.config().overwriteVerified, undefined);
    assert.ok(
      !f.requests.some((r) => new URL(r.url).pathname.endsWith("/file/delete"))
    );
  });
  it("keeps another device's file if it occupies the target immediately before publication", async () => {
    const f = fixture();
    f.replace({
      ...f.config(),
      overwriteVerified: quarkOverwriteBinding(f.config()),
    });
    f.files.set("note.md", {
      name: "note.md",
      fid: "old",
      bytes: new Uint8Array([4]),
    });
    f.beforeRequest((r) => {
      if (
        new URL(r.url).pathname.endsWith("/rename") &&
        JSON.parse(r.body as string).file_name === "note.md"
      )
        f.files.set("note.md", {
          name: "note.md",
          fid: "other-device",
          bytes: new Uint8Array([9]),
        });
    });
    await assert.rejects(
      f.client.write("note.md", new Uint8Array([7, 8]).buffer, 1, 1),
      code("replacement_recovery_required")
    );
    assert.equal(f.files.get("note.md")!.fid, "other-device");
    assert.deepEqual(f.files.get("note.md")!.bytes, new Uint8Array([9]));
    assert.ok(
      [...f.files.values()].some(
        (file) => file.fid === "old" && file.name.startsWith("rsnext-backup-")
      )
    );
    assert.ok(
      !f.requests.some((r) => new URL(r.url).pathname.endsWith("/file/delete"))
    );
  });
  it("does not grant capability when deleting the backup succeeds but its response is lost", async () => {
    const f = fixture();
    let count = 0;
    const client = new QuarkClient(
      async (r) => {
        const response = await f.transport(r);
        if (new URL(r.url).pathname.endsWith("/file/delete")) {
          count++;
          throw new QuarkError("transport_error", true);
        }
        return response;
      },
      () => f.config()
    );
    await assert.rejects(client.verifyOverwrite(), code("transport_error"));
    assert.equal(count, 1);
    assert.equal(f.config().overwriteVerified, undefined);
    assert.equal(f.files.size, 1);
    assert.deepEqual(
      [...f.files.values()][0].bytes,
      new Uint8Array([63, 11, 88, 6, 32, 9, 7])
    );
  });
});

describe("Quark HTTP 400 collision refusal", () => {
  it("accepts HTTP 400 only for the deliberately occupied probe name and completes replacement verification", async () => {
    const f = fixture();
    f.autoRename();
    f.collisionHttp400();
    assert.equal(
      await f.client.verifyOverwrite(),
      quarkOverwriteBinding(f.config())
    );
    assert.equal(f.files.size, 0);
  });
  it("still refuses capability if ordinary rename also returns HTTP 400", async () => {
    const f = fixture();
    f.rejectAllRename();
    await assert.rejects(
      f.client.verifyOverwrite(),
      (e: any) => e.code === "http_400" && e.operation === "backup_rename"
    );
    assert.equal(f.config().overwriteVerified, undefined);
  });
});

describe("Quark collision authentication rejection", () => {
  it("does not treat HTTP 403 as a successful occupied-name safety check", async () => {
    const f = fixture();
    const client = new QuarkClient(
      async (r) => {
        if (
          new URL(r.url).pathname.endsWith("/file/rename") &&
          f.files.has(JSON.parse(r.body as string).file_name)
        )
          return { ...reply({ code: 403, status: 403 }), status: 403 };
        return f.transport(r);
      },
      () => f.config()
    );
    await assert.rejects(
      client.verifyOverwrite(),
      (e: any) =>
        e.code === "http_403" && e.operation === "rename_conflict_probe"
    );
    assert.equal(f.config().overwriteVerified, undefined);
  });
});

