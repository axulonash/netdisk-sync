import { api, bytes, setup as syncFixture } from "./support/baiduSyncHarness";
import { strict as assert } from "assert";
import {
  AliyunQrLogin,
  bindAliyunSession,
  getAliyunProfileId,
} from "../../src/native/aliyunAuth";
import { FakeFsAliyun } from "../../src/fsAliyun";
import { AliyunClient } from "../../src/native/aliyunClient";
import {
  AliyunError,
  createDesktopAliyunTransport,
  aliyunJson,
} from "../../src/native/aliyunTransport";
const reply = (data: any, status = 200) => ({
  status,
  headers: {},
  cookies: [],
  body: new TextEncoder().encode(JSON.stringify(data)),
});
const tokens = {
  access_token: "access",
  refresh_token: "refresh",
  expires_in: 7200,
  user_id: "user",
  default_drive_id: "drive",
};
describe("Aliyun direct authorization", () => {
  it("generates and polls a QR code without developer keys or a gateway", async () => {
    const seen: any[] = [];
    const login = new AliyunQrLogin(async (r) => {
      seen.push(r);
      return new URL(r.url).pathname.endsWith("generate.do")
        ? reply({
            content: {
              data: {
                t: 123,
                ck: "ck",
                codeContent: "https://www.alipan.com/qr/test",
              },
            },
          })
        : new URL(r.url).pathname.endsWith("query.do")
          ? reply({
              content: {
                data: {
                  qrCodeStatus: "CONFIRMED",
                  bizExt: Buffer.from(
                    JSON.stringify({
                      pds_login_result: {
                        refreshToken: "refresh",
                        accessToken: "access",
                      },
                    })
                  ).toString("base64"),
                },
              },
            })
          : reply(tokens);
    });
    assert.equal(await login.start(), "https://www.alipan.com/qr/test");
    const session = await login.check();
    assert.ok(session);
    assert.equal(session!.userId, "user");
    assert.equal(session!.driveId, "drive");
    assert.equal(session!.refreshToken, "refresh");
    assert.ok(
      seen.every((r) =>
        /\.(aliyundrive|alipan)\.com$/.test(new URL(r.url).hostname)
      )
    );
    assert.equal(seen[1].method, "POST");
  });
  it("does not complete a QR login closed while polling", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const login = new AliyunQrLogin(async (r) => {
      if (new URL(r.url).pathname.endsWith("generate.do"))
        return reply({
          content: {
            data: {
              t: 123,
              ck: "ck",
              codeContent: "https://www.alipan.com/qr/test",
            },
          },
        });
      await gate;
      return reply({
        content: {
          data: {
            qrCodeStatus: "CONFIRMED",
            bizExt: Buffer.from(
              JSON.stringify({ pds_login_result: { refreshToken: "refresh" } })
            ).toString("base64"),
          },
        },
      });
    });
    await login.start();
    const pending = login.check();
    login.cancel();
    release();
    await assert.rejects(pending, (e: any) => e.code === "qr_expired");
  });
  it("isolates profile IDs by account and root without leaking tokens", () => {
    const config = { session: bindAliyunSession(tokens), remoteRoot: "/notes" };
    assert.ok(!getAliyunProfileId(config, "", "unknown").includes("refresh"));
    assert.notEqual(
      getAliyunProfileId(config, "", "unknown"),
      getAliyunProfileId({ ...config, remoteRoot: "/other" }, "", "unknown")
    );
  });
  it("blocks token forwarding to storage and runs no desktop transport on mobile", async () => {
    const load = () => {
      throw new Error("must not load");
    };
    await assert.rejects(
      createDesktopAliyunTransport(
        false,
        load
      )({ method: "GET", url: "https://api.alipan.com/" }),
      (e: any) => e.code === "desktop_required"
    );
    await assert.rejects(
      createDesktopAliyunTransport(
        true,
        load
      )({
        method: "PUT",
        url: "https://bucket.oss-cn-hangzhou.aliyuncs.com/note",
        headers: { Authorization: "Bearer secret" },
      }),
      (e: any) => e.code === "credential_destination"
    );
  });
});

describe("Aliyun file safety", () => {
  const setup = (
    createStatus = 200,
    downloadHost = "bucket.aliyuncs.com",
    uploadHost = "bucket.aliyuncs.com"
  ) => {
    const files = new Map<string, any>(),
      content = new Map<string, Uint8Array>();
    let next = 0;
    const calls: any[] = [];
    const config: any = {
      session: bindAliyunSession(tokens),
      remoteRoot: "/notes",
    };
    const transport = async (r: any) => {
      calls.push(r);
      const path = new URL(r.url).pathname;
      const b = typeof r.body === "string" ? JSON.parse(r.body) : {};
      if (path === "/users/v1/users/device/create_session")
        return reply({ success: true });
      if (path === "/v2/file/list")
        return reply({
          items: [...files.values()].filter(
            (f) => f.parent_file_id === b.parent_file_id
          ),
          next_marker: "",
        });
      if (path === "/adrive/v2/file/createWithFolders") {
        let f = [...files.values()].find(
          (f) => f.parent_file_id === b.parent_file_id && f.name === b.name
        );
        if (f && b.check_name_mode !== "overwrite")
          return reply({ code: "AlreadyExist" });
        if (!f) {
          f = {
            file_id: `f${++next}`,
            name: b.name,
            parent_file_id: b.parent_file_id,
            type: b.type,
            size: b.size ?? 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          files.set(f.file_id, f);
        }
        f.size = b.size ?? 0;
        return reply(
          {
            ...f,
            upload_id: `u${f.file_id}`,
            part_info_list: (b.part_info_list ?? []).map((p: any) => ({
              ...p,
              upload_url: `https://${uploadHost}/${f.file_id}/${p.part_number}`,
            })),
          },
          createStatus
        );
      }
      if (r.method === "PUT") {
        assert.equal(r.headers?.Authorization, undefined);
        const id = path.split("/")[1];
        content.set(id, new Uint8Array(r.body));
        return {
          status: 200,
          body: new Uint8Array(),
          headers: {},
          cookies: [],
        };
      }
      if (path === "/v2/file/complete") return reply(files.get(b.file_id));
      if (path === "/v2/file/get_download_url")
        return reply({ url: `https://${downloadHost}/${b.file_id}` });
      if (new URL(r.url).hostname === downloadHost)
        return {
          status: 200,
          body: content.get(path.slice(1)) ?? new Uint8Array(),
          headers: {},
          cookies: [],
        };
      if (path === "/v2/recyclebin/trash") {
        files.delete(b.file_id);
        return reply({});
      }
      throw new Error(`unexpected ${path}`);
    };
    return {
      files,
      content,
      config,
      calls,
      transport,
      client: new AliyunClient(transport, () => config),
    };
  };
  for (const host of [
    "download.aliyundrive.net",
    "download.alicloudccp.com",
    "dl1.aliyundrive.cloud",
    "dl1-v6.aliyundrive.cloud",
  ])
    it(`verifies and cleans the probe through ${host}`, async () => {
      const s = setup(201, host);
      await s.client.prepareRoot();
      assert.ok(await s.client.verifyOverwrite());
      assert.equal(
        [...s.files.values()].filter((f) => f.type === "file").length,
        0
      );
      const requests = s.calls.filter((r) => new URL(r.url).hostname === host);
      assert.ok(requests.length);
      assert.ok(
        requests.every(
          (r) =>
            r.method === "GET" && !r.headers.Authorization && !r.headers.Cookie
        )
      );
    });
  it("uploads and verifies the probe using the Beijing native data endpoint", async () => {
    const host = "cn-beijing-data.aliyundrive.net";
    const s = setup(201, host, host);
    await s.client.prepareRoot();
    assert.ok(await s.client.verifyOverwrite());
    assert.equal(
      [...s.files.values()].filter((f) => f.type === "file").length,
      0
    );
    const uploads = s.calls.filter((r) => r.method === "PUT");
    assert.equal(uploads.length, 2);
    assert.ok(
      uploads.every(
        (r) =>
          new URL(r.url).hostname === host &&
          !r.headers.Authorization &&
          !r.headers.Cookie
      )
    );
  });
  it("does not add an unsigned Content-Type to a presigned upload", async () => {
    const s = setup(
      201,
      "cn-beijing-data.aliyundrive.net",
      "cn-beijing-data.aliyundrive.net"
    );
    const transport: any = async (r: any) =>
      r.method === "PUT" &&
      Object.keys(r.headers ?? {}).some(
        (k) => k.toLowerCase() === "content-type"
      )
        ? reply({ code: "SignatureDoesNotMatch" }, 403)
        : s.transport(r);
    const client = new AliyunClient(transport, () => s.config);
    await client.prepareRoot();
    assert.ok(await client.verifyOverwrite());
  });
  it("honors the Content-Type explicitly supplied with an upload part", async () => {
    const s = setup();
    const transport: any = async (r: any) => {
      if (r.method === "PUT")
        assert.equal(r.headers["Content-Type"], "text/plain");
      const response = await s.transport(r);
      if (new URL(r.url).pathname === "/adrive/v2/file/createWithFolders") {
        const data = JSON.parse(new TextDecoder().decode(response.body));
        data.part_info_list = data.part_info_list.map((p: any) => ({
          ...p,
          content_type: "text/plain",
        }));
        return reply(data);
      }
      return response;
    };
    const client = new AliyunClient(transport, () => s.config);
    await client.prepareRoot();
    assert.ok(await client.verifyOverwrite());
  });
  it("preserves the upload stage and safe server code for a rejected PUT", async () => {
    const s = setup();
    const transport: any = async (r: any) =>
      r.method === "PUT"
        ? {
            ...reply({}, 403),
            headers: { "content-type": "application/xml" },
            body: new TextEncoder().encode(
              "<Error><Code>SignatureDoesNotMatch</Code><Message>secret-url</Message></Error>"
            ),
          }
        : s.transport(r);
    const client = new AliyunClient(transport, () => s.config);
    await client.prepareRoot();
    await assert.rejects(client.verifyOverwrite(), (e: any) => {
      assert.equal(e.code, "http_403");
      assert.equal(e.endpointInfo.operation, "upload_url");
      assert.equal(e.endpointInfo.host, "bucket.aliyuncs.com");
      assert.equal(e.responseInfo.serverCode, "SignatureDoesNotMatch");
      assert.ok(!JSON.stringify(e).includes("secret-url"));
      return true;
    });
  });
  it("confirms probe cleanup after an empty HTTP 204 deletion response", async () => {
    const s = setup();
    const transport: any = async (r: any) => {
      const response = await s.transport(r);
      return new URL(r.url).pathname === "/v2/recyclebin/trash"
        ? { ...response, status: 204, body: new Uint8Array() }
        : response;
    };
    const client = new AliyunClient(transport, () => s.config);
    await client.prepareRoot();
    assert.ok(await client.verifyOverwrite());
    assert.equal(
      [...s.files.values()].filter((f) => f.type === "file").length,
      0
    );
  });
  it("does not mark cleanup successful on HTTP 204 while the file remains", async () => {
    const s = setup();
    const transport: any = async (r: any) =>
      new URL(r.url).pathname === "/v2/recyclebin/trash"
        ? { ...reply({}), status: 204, body: new Uint8Array() }
        : s.transport(r);
    const client = new AliyunClient(transport, () => s.config);
    await client.prepareRoot();
    await assert.rejects(
      client.verifyOverwrite(),
      (e: any) => e.code === "cleanup_not_confirmed" && e.stage === "cleanup"
    );
    assert.equal(s.config.overwriteVerified, undefined);
  });
  it("continues preparation after HTTP 201 directory and upload creation", async () => {
    const s = setup(201);
    await s.client.prepareRoot();
    const verified = await s.client.verifyOverwrite();
    assert.ok(verified);
    assert.equal(
      [...s.files.values()].filter((f) => f.type === "file").length,
      0
    );
    assert.ok(s.calls.some((r) => r.method === "PUT"));
  });
  it("creates missing root, verifies actual overwrite and cleans only its probe", async () => {
    const s = setup();
    await s.client.prepareRoot();
    const marker = await s.client.verifyOverwrite();
    assert.ok(marker);
    assert.equal(
      [...s.files.values()].filter((f) => f.type === "file").length,
      0
    );
    s.config.overwriteVerified = marker;
    await s.client.write(
      "11111.txt",
      new TextEncoder().encode("one line").buffer as ArrayBuffer,
      1,
      1
    );
    assert.equal(
      new TextDecoder().decode(await s.client.read("11111.txt")),
      "one line"
    );
    await s.client.write(
      "11111.txt",
      new TextEncoder().encode("changed").buffer as ArrayBuffer,
      2,
      2
    );
    assert.equal(
      new TextDecoder().decode(await s.client.read("11111.txt")),
      "changed"
    );
  });
  it("rejects duplicate directory entries instead of returning a partial scan", async () => {
    const s = setup();
    await s.client.prepareRoot();
    s.files.set("a", {
      file_id: "a",
      name: "dup",
      parent_file_id: "f1",
      type: "folder",
    });
    s.files.set("b", {
      file_id: "b",
      name: "dup",
      parent_file_id: "f1",
      type: "folder",
    });
    await assert.rejects(
      s.client.scan(),
      (e: any) => e.code === "incomplete_listing"
    );
  });
  it("refuses writes before verification and stops stale account requests", async () => {
    const s = setup();
    await s.client.prepareRoot();
    await assert.rejects(
      s.client.write("a.txt", new Uint8Array([1]).buffer, 1, 1),
      (e: any) => e.code === "overwrite_not_verified"
    );
    s.config.session = bindAliyunSession({ ...tokens, user_id: "other" });
    await assert.rejects(
      s.client.scan(),
      (e: any) => e.code === "sync_scope_changed"
    );
  });
  it("keeps abandoned connection probes out of the vault", async () => {
    const s = setup();
    await s.client.prepareRoot();
    s.files.set("leftover", {
      file_id: "leftover",
      name: "rs-overwrite-check-" + "a".repeat(32) + ".bin",
      parent_file_id: "f1",
      type: "file",
      size: 4,
    });
    assert.deepEqual(await s.client.scan(), []);
    assert.ok(s.files.has("leftover"));
  });
  it("queues filesystem calls during refresh persistence without rejecting the new binding", async () => {
    const s = setup();
    await s.client.prepareRoot();
    s.config.session = bindAliyunSession({ ...tokens, expires_in: 1 });
    s.config.overwriteVerified = (
      await import("../../src/native/aliyunAuth")
    ).aliyunOverwriteBinding(s.config);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    const transport: any = async (r: any) =>
      new URL(r.url).hostname === "auth.alipan.com"
        ? reply({
            ...tokens,
            access_token: "renewed",
            refresh_token: "rotated",
          })
        : s.transport(r);
    const client = new AliyunClient(
      transport,
      () => s.config,
      () => {},
      async (session) => {
        s.config.session = session;
        entered();
        await gate;
      }
    );
    const fs = new FakeFsAliyun(client);
    const first = fs.mkdir("folder/");
    await started;
    let second: Promise<any>;
    try {
      second = fs.walk();
    } catch (e) {
      release();
      await first.catch(() => {});
      throw e;
    }
    release();
    await Promise.all([first, second!]);
    assert.equal(s.config.session.refreshToken, "rotated");
  });
  for (const password of ["", "secret-password"])
    it(`runs the actual sync planner and history with ${password ? "OpenSSL" : "plain"} files`, async () => {
      const s = setup();
      await s.client.prepareRoot();
      s.config.overwriteVerified = await s.client.verifyOverwrite();
      const local = syncFixture();
      const settings = {
        ...local.settings,
        serviceType: "aliyun",
        aliyunNative: s.config,
        password,
        encryptionMethod: "openssl-base64",
      };
      const remote = api.getClient(settings, "vault", async () => {}, {
        aliyunTransport: s.transport,
        getSettings: () => settings,
      });
      assert.equal(remote.kind, "aliyun");
      const fs = new api.FakeFsEncrypt(remote, password, "openssl-base64");
      const profile = getAliyunProfileId(s.config, password, "openssl-base64");
      const history = () =>
        api.getAllPrevSyncRecordsByVaultAndProfile(local.db, "vault", profile);
      const plan = async () =>
        api.buildSyncPlan({
          localEntityList: await local.local.walk(),
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
          local.local,
          fs,
          "vault",
          profile,
          5,
          -1,
          undefined,
          local.db,
          undefined,
          "keep_newer",
          "manual"
        );
      const time = Date.now() + 60000;
      await local.local.writeFile("中文.md", bytes("完整笔记"), time, time);
      await run();
      assert.equal(
        new TextDecoder().decode(await fs.readFile("中文.md")),
        "完整笔记"
      );
      assert.equal((await history()).length, 1);
      const count = s.calls.filter((r) => r.method === "PUT").length;
      assert.equal((await plan())["中文.md"].change, false);
      await run();
      assert.equal(s.calls.filter((r) => r.method === "PUT").length, count);
      await local.local.writeFile(
        "中文.md",
        bytes("更新内容"),
        time + 60000,
        time
      );
      await run();
      assert.equal(
        new TextDecoder().decode(await fs.readFile("中文.md")),
        "更新内容"
      );
      settings.serviceType = "webdav";
      await assert.rejects(remote.walk());
    });
  it("rejects corrupt readback without cleaning an unconfirmed probe", async () => {
    const s = setup();
    await s.client.prepareRoot();
    const transport: any = async (r: any) => {
      const result = await s.transport(r);
      if (
        r.method === "GET" &&
        new URL(r.url).hostname === "bucket.aliyuncs.com"
      )
        return { ...result, body: new Uint8Array(result.body.length).fill(0) };
      return result;
    };
    const client = new AliyunClient(transport, () => s.config);
    await assert.rejects(
      client.verifyOverwrite(),
      (e: any) => e.code === "upload_not_confirmed"
    );
    assert.equal(
      s.calls.filter((r) => new URL(r.url).pathname === "/v2/recyclebin/trash")
        .length,
      0
    );
    assert.equal(s.config.overwriteVerified, undefined);
  });
  it("does not replay a failed upload request", async () => {
    const s = setup();
    await s.client.prepareRoot();
    s.config.overwriteVerified = await s.client.verifyOverwrite();
    let attempts = 0;
    const transport: any = async (r: any) => {
      if (r.method === "PUT") {
        attempts++;
        throw new AliyunError("request_timeout", true);
      }
      return s.transport(r);
    };
    await assert.rejects(
      new AliyunClient(transport, () => s.config).write(
        "a.md",
        bytes("content"),
        1,
        1
      )
    );
    assert.equal(attempts, 1);
  });
  it("marks a failed object-storage request as an upload-part failure", async () => {
    const s = setup();
    await s.client.prepareRoot();
    s.config.overwriteVerified = await s.client.verifyOverwrite();
    const transport: any = async (r: any) => {
      if (r.method === "PUT")
        throw Object.assign(new AliyunError("request_timeout", true), {
          networkCode: "ETIMEDOUT",
        });
      return s.transport(r);
    };
    await assert.rejects(
      new AliyunClient(transport, () => s.config).write(
        "a.md",
        bytes("content"),
        1,
        1
      ),
      (e: any) => e.providerStage === "upload_part" && e.outcomeUnknown
    );
  });
});

describe("Aliyun QR session continuity", () => {
  it("retains needed cookies across polling and ignores foreign/expired cookies", async () => {
    const seen: any[] = [];
    let queries = 0;
    const login = new AliyunQrLogin(async (r) => {
      seen.push(r);
      if (r.url.includes("generate.do"))
        return {
          ...reply({
            content: {
              data: {
                t: 1,
                ck: "ck",
                codeContent: "https://qrlogin.aliyundrive.com/test",
              },
            },
          }),
          cookies: [
            "first=one; Domain=.aliyundrive.com; Path=/",
            "foreign=secret; Domain=evil.test; Path=/",
            "expired=old; Max-Age=0",
          ],
        };
      queries++;
      return {
        ...reply({ content: { data: { qrCodeStatus: "NEW" } } }),
        cookies: queries === 1 ? ["second=two; Path=/"] : [],
      };
    });
    await login.start();
    await login.check();
    await login.check();
    assert.equal(seen[1].headers.Cookie, "first=one");
    assert.equal(seen[2].headers.Cookie, "first=one; second=two");
    login.cancel();
  });
});

describe("Aliyun JSON response status", () => {
  it("still rejects HTTP errors and empty Created responses", () => {
    assert.throws(
      () => aliyunJson({ ...reply({}, 204), body: new Uint8Array() }),
      (e: any) => e.code === "http_204"
    );
    assert.throws(
      () => aliyunJson(reply({ code: "denied" }, 403)),
      (e: any) => e.code === "http_403"
    );
    assert.throws(
      () => aliyunJson({ ...reply({}, 201), body: new Uint8Array() }),
      (e: any) => e.code === "invalid_response"
    );
  });
});

describe("Aliyun file endpoint boundaries", () => {
  it("rejects lookalikes and keeps signed URLs out of diagnostics", () => {
    const { aliyunFileUrl } = require("../../src/native/aliyunTransport");
    for (const url of [
      "https://download.aliyundrive.net.evil.test/file?token=secret",
      "https://dl1.aliyundrive.cloud.evil.test/file",
      "https://other.dl1.aliyundrive.cloud/file",
      "https://unknown.aliyundrive.cloud/file",
      "http://download.aliyundrive.net/file",
      "https://download.aliyundrive.net:8443/file",
    ]) {
      assert.throws(
        () => aliyunFileUrl(url, "download_url"),
        (e: any) => {
          assert.equal(e.code, "untrusted_endpoint");
          assert.ok(!JSON.stringify(e).includes("secret"));
          return true;
        }
      );
    }
    assert.throws(
      () =>
        aliyunFileUrl("https://download.aliyundrive.net/file", "upload_url"),
      (e: any) => e.code === "untrusted_endpoint"
    );
  });
  it("never sends account headers or uploads to download CDN hosts", async () => {
    const load = () => {
      throw new Error("must not load");
    };
    const transport = createDesktopAliyunTransport(true, load);
    for (const host of [
      "download.aliyundrive.net",
      "download.alicloudccp.com",
      "dl1.aliyundrive.cloud",
      "dl1-v6.aliyundrive.cloud",
    ]) {
      const headerCases: Record<string, string>[] = [
        { Authorization: "Bearer secret" },
        { Cookie: "secret=value" },
        { "X-Signature": "secret" },
      ];
      for (const headers of headerCases)
        await assert.rejects(
          transport({ url: `https://${host}/file`, method: "GET", headers }),
          (e: any) => e.code === "credential_destination"
        );
      await assert.rejects(
        transport({ url: `https://${host}/file`, method: "PUT" }),
        (e: any) => e.code === "untrusted_endpoint"
      );
    }
  });
});

describe("Aliyun native upload transport", () => {
  it("allows a credential-free PUT to the exact Beijing endpoint", async () => {
    let loaded = 0;
    const transport = createDesktopAliyunTransport(true, () => {
      loaded++;
      throw new Error("mock HTTPS");
    });
    await assert.rejects(
      transport({
        url: "https://cn-beijing-data.aliyundrive.net/part?signature=test",
        method: "PUT",
        body: new Uint8Array([1]),
      }),
      (e: any) => e.code === "transport_unavailable"
    );
    assert.equal(loaded, 1);
  });
  it("refuses account headers on the native data endpoint and refuses lookalike hosts", async () => {
    const { aliyunFileUrl } = require("../../src/native/aliyunTransport");
    const transport = createDesktopAliyunTransport(true, () => {
      throw new Error("must not load");
    });
    const headerCases: Record<string, string>[] = [
      { Authorization: "Bearer secret" },
      { Cookie: "token=secret" },
      { "X-Signature": "secret" },
      { "X-Device-Id": "secret" },
    ];
    for (const headers of headerCases)
      await assert.rejects(
        transport({
          url: "https://cn-beijing-data.aliyundrive.net/part",
          method: "PUT",
          headers,
        }),
        (e: any) => e.code === "credential_destination"
      );
    for (const host of [
      "cn-beijing-data-aliyundrive.net",
      "cn-beijing-data.aliyundrive.net.evil.test",
      "other.cn-beijing-data.aliyundrive.net",
      "evil-data.aliyundrive.net",
    ])
      assert.throws(
        () => aliyunFileUrl(`https://${host}/part`, "upload_url"),
        (e: any) => e.code === "untrusted_endpoint"
      );
  });
});

describe("Aliyun cloud download transport", () => {
  it("allows credential-free GET requests to both verified cloud download hosts", async () => {
    let loaded = 0;
    const transport = createDesktopAliyunTransport(true, () => {
      loaded++;
      throw new Error("mock HTTPS");
    });
    for (const host of ["dl1.aliyundrive.cloud", "dl1-v6.aliyundrive.cloud"])
      await assert.rejects(
        transport({
          url: `https://${host}/file?signature=test`,
          method: "GET",
          maxBytes: 4,
        }),
        (e: any) => e.code === "transport_unavailable"
      );
    assert.equal(loaded, 2);
  });
});
