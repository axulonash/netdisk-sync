import { strict as assert } from "assert";
import {
  BaiduConnection,
  createBaiduJsonTransport,
} from "../../src/native/baiduConnection";

const app = { clientId: "app", clientSecret: "secret", redirectUri: "oob" };
const tokens = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 3600000,
};
describe("Baidu connection entry", () => {
  it("sends the official token GET without a body and disables HTTP throwing", async () => {
    let sent: any;
    const transport = createBaiduJsonTransport(async (request) => {
      sent = request;
      return { status: 200, text: '{"access_token":"access"}' };
    });
    const result = await transport({
      url: "https://openapi.baidu.com/oauth/2.0/token",
      method: "POST",
      headers: {},
      body: "client_secret=secret&code=a%2Bb",
    });
    assert.equal(sent.method, "GET");
    assert.equal(sent.throw, false);
    assert.equal(sent.body, undefined);
    assert.equal(new URL(sent.url).searchParams.get("code"), "a+b");
    assert.deepEqual(result.json, { access_token: "access" });
  });
  it("drops transport errors and invalid response bodies", async () => {
    for (const request of [
      async () => {
        throw new Error("secret");
      },
      async () => ({ status: 200, text: "secret" }),
    ]) {
      const transport = createBaiduJsonTransport(request);
      await assert.rejects(
        transport({
          url: "https://pan.baidu.com/rest/2.0/xpan/file",
          method: "GET",
        }),
        (error: Error) => !error.message.includes("secret")
      );
    }
  });
  it("rejects foreign transport endpoints before sending credentials", async () => {
    let calls = 0;
    const transport = createBaiduJsonTransport(async () => {
      calls++;
      return { status: 200, text: "{}" };
    });
    await assert.rejects(
      transport({ url: "https://evil.example/", method: "GET" })
    );
    assert.equal(calls, 0);
  });
  it("exchanges a code, persists credentials, scans with a token and logs out", async () => {
    let config: any;
    const requests: URL[] = [];
    const connection = new BaiduConnection({
      getConfig: () => config,
      saveConfig: async (value) => {
        config = value;
      },
      transport: async (request) => {
        requests.push(new URL(request.url));
        return request.method === "POST"
          ? {
              status: 200,
              json: {
                access_token: "access",
                refresh_token: "refresh",
                expires_in: 3600,
              },
            }
          : { status: 200, json: { errno: 0, list: [] } };
      },
    });
    await connection.login(app, "code");
    assert.equal(config.tokens.accessToken, "access");
    assert.deepEqual(await connection.scan("/notes"), []);
    assert.equal(requests.at(-1)!.searchParams.get("access_token"), "access");
    await connection.logout();
    assert.equal(config.tokens, undefined);
    await assert.rejects(connection.scan("/notes"), /not_logged_in/);
  });
  it("serializes account operations across settings rerenders", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connection = new BaiduConnection({
      getConfig: () => ({ app, tokens }),
      saveConfig: async () => {},
      transport: async () => {
        await gate;
        return { status: 200, json: { errno: 0, list: [] } };
      },
    });
    const scanning = connection.scan("/notes");
    await assert.rejects(connection.logout(), /busy/);
    release();
    await scanning;
    assert.equal(connection.busy, false);
  });
  it("does not replace a saved account after failed authorization", async () => {
    let writes = 0;
    const connection = new BaiduConnection({
      getConfig: () => ({ app, tokens }),
      saveConfig: async () => {
        writes++;
      },
      transport: async () => ({
        status: 200,
        json: { error: "invalid_grant" },
      }),
    });
    await assert.rejects(connection.login(app, "code"), /invalid_grant/);
    assert.equal(writes, 0);
    assert.equal(connection.busy, false);
  });
  it("reports persistence failure without treating login as successful", async () => {
    const connection = new BaiduConnection({
      getConfig: () => undefined,
      saveConfig: async () => {
        throw new Error("secret-path");
      },
      transport: async () => ({
        status: 200,
        json: {
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        },
      }),
    });
    await assert.rejects(connection.login(app, "code"), /save_failed/);
    assert.equal(connection.busy, false);
  });
  it("uses an imported account instead of a stale settings-page session", async () => {
    let config = { app, tokens };
    const used: string[] = [];
    const connection = new BaiduConnection({
      getConfig: () => config,
      saveConfig: async () => {},
      transport: async (request) => {
        used.push(new URL(request.url).searchParams.get("access_token")!);
        return { status: 200, json: { errno: 0, list: [] } };
      },
    });
    await connection.scan("/notes");
    config = {
      app: { ...app, clientId: "second-app" },
      tokens: { ...tokens, accessToken: "second-access" },
    };
    await connection.scan("/notes");
    assert.deepEqual(used, ["access", "second-access"]);
  });
  it("does not overwrite an imported account when an old refresh completes", async () => {
    let config = { app, tokens: { ...tokens, expiresAt: 0 } };
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const connection = new BaiduConnection({
      getConfig: () => config,
      saveConfig: async () => {
        writes++;
      },
      transport: async () => {
        started();
        await gate;
        return {
          status: 200,
          json: {
            access_token: "rotated",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          },
        };
      },
    });
    const scanning = connection.scan("/notes");
    await entered;
    config = {
      app: { ...app, clientId: "second-app" },
      tokens: { ...tokens, accessToken: "second-access" },
    };
    release();
    await assert.rejects(scanning, /save_failed/);
    assert.equal(writes, 0);
    assert.equal(config.tokens.accessToken, "second-access");
  });
  it("does not overwrite an imported account when authorization completes", async () => {
    let config = { app, tokens };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const connection = new BaiduConnection({
      getConfig: () => config,
      saveConfig: async () => {
        writes++;
      },
      transport: async () => {
        await gate;
        return {
          status: 200,
          json: {
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          },
        };
      },
    });
    const loggingIn = connection.login(app, "code");
    config = { app: { ...app, clientId: "imported-app" }, tokens };
    release();
    await assert.rejects(loggingIn, /account_changed/);
    assert.equal(writes, 0);
  });
  it("downloads a checked file through the configured binary transport", async () => {
    const connection = new BaiduConnection({
      getConfig: () => ({ app, tokens }),
      saveConfig: async () => {},
      transport: async () => ({
        status: 200,
        json: {
          errno: 0,
          list: [
            { fs_id: "1", dlink: "https://d.pcs.baidu.com/file", size: 3 },
          ],
        },
      }),
      binary: async () => ({
        status: 200,
        headers: {},
        body: new ArrayBuffer(3),
      }),
    });
    assert.equal(
      (await connection.readFile({ fsId: "1", size: 3 })).byteLength,
      3
    );
  });
  it("requires a binary transport before making any metadata request", async () => {
    let calls = 0;
    const connection = new BaiduConnection({
      getConfig: () => ({ app, tokens }),
      saveConfig: async () => {},
      transport: async () => {
        calls++;
        throw new Error();
      },
    });
    await assert.rejects(
      connection.readFile({ fsId: "1", size: 3 }),
      /download_transport_unavailable/
    );
    assert.equal(calls, 0);
  });
  it("rejects oversized downloads before requesting a token or metadata", async () => {
    let calls = 0;
    const connection = new BaiduConnection({
      getConfig: () => ({ app, tokens }),
      saveConfig: async () => {},
      transport: async () => {
        calls++;
        throw new Error();
      },
      binary: async () => {
        throw new Error();
      },
    });
    await assert.rejects(
      connection.readFile({ fsId: "1", size: 64 * 1024 * 1024 + 1 }),
      /download_too_large/
    );
    assert.equal(calls, 0);
  });
  it("uploads through the configured transport using the saved session", async () => {
    const methods: string[] = [];
    const connection = new BaiduConnection({
      getConfig: () => ({ app, tokens }),
      saveConfig: async () => {},
      transport: async () => {
        throw new Error();
      },
      upload: async (request) => {
        const url = new URL(request.url);
        methods.push(url.searchParams.get("method")!);
        assert.equal(url.searchParams.get("access_token"), "access");
        return {
          status: 200,
          json:
            methods.length === 1
              ? {
                  errno: 0,
                  return_type: 1,
                  uploadid: "fixture-upload",
                  block_list: [],
                }
              : {
                  errno: 0,
                  fs_id: "1",
                  path: "/notes/test.md",
                  size: 1,
                  isdir: 0,
                },
        };
      },
    });
    assert.equal(
      (
        await connection.writeFile({
          path: "/notes/test.md",
          data: new ArrayBuffer(1),
          overwrite: true,
        })
      ).fsId,
      "1"
    );
    assert.deepEqual(methods, ["precreate", "create"]);
  });
  it("does not commit an upload after importing another account", async () => {
    let config = { app, tokens };
    let calls = 0;
    const connection = new BaiduConnection({
      getConfig: () => config,
      saveConfig: async () => {},
      transport: async () => {
        throw new Error();
      },
      upload: async () => {
        calls++;
        config = { app: { ...app, clientId: "imported-app" }, tokens };
        return {
          status: 200,
          json: {
            errno: 0,
            return_type: 1,
            uploadid: "fixture-upload",
            block_list: [],
          },
        };
      },
    });
    await assert.rejects(
      connection.writeFile({
        path: "/notes/test.md",
        data: new ArrayBuffer(1),
        overwrite: true,
      }),
      (e: any) => e.code === "session_changed"
    );
    assert.equal(calls, 1);
  });
  it("rejects unavailable uploads before retrieving a token or sending a request", async () => {
    let calls = 0;
    const connection = new BaiduConnection({
      getConfig: () => undefined,
      saveConfig: async () => {},
      transport: async () => {
        calls++;
        throw new Error();
      },
    });
    await assert.rejects(
      connection.writeFile({
        path: "/notes/test.md",
        data: new ArrayBuffer(1),
        overwrite: true,
      }),
      /upload_transport_unavailable/
    );
    assert.equal(calls, 0);
  });
  it("creates and removes scoped directories through the saved session", async () => {
    const methods: string[] = [];
    const connection = new BaiduConnection({
      getConfig: () => ({ app, tokens }),
      saveConfig: async () => {},
      transport: async () => {
        throw new Error();
      },
      upload: async (request) => {
        const url = new URL(request.url);
        methods.push(url.searchParams.get("method")!);
        assert.equal(url.searchParams.get("access_token"), "access");
        return {
          status: 200,
          json:
            methods.length === 1
              ? {
                  errno: 0,
                  fs_id: "1",
                  path: "/notes/folder",
                  isdir: 1,
                  size: 0,
                }
              : { errno: 0, info: [{ path: "/notes/folder", errno: 0 }] },
        };
      },
    });
    assert.equal((await connection.mkdir("/notes", "folder/")).fsId, "1");
    await connection.remove("/notes", "folder/");
    assert.deepEqual(methods, ["create", "filemanager"]);
  });
  it("rejects directory changes without a write transport", async () => {
    const connection = new BaiduConnection({
      getConfig: () => undefined,
      saveConfig: async () => {},
      transport: async () => {
        throw new Error();
      },
    });
    for (const method of ["mkdir", "remove"] as const)
      await assert.rejects(
        connection[method]("/notes", "folder"),
        /management_transport_unavailable/
      );
  });
  it("does not return delete success after importing another account", async () => {
    let config = { app, tokens };
    const connection = new BaiduConnection({
      getConfig: () => config,
      saveConfig: async () => {},
      transport: async () => {
        throw new Error();
      },
      upload: async () => {
        config = { app: { ...app, clientId: "imported-app" }, tokens };
        return {
          status: 200,
          json: { errno: 0, info: [{ path: "/notes/file", errno: 0 }] },
        };
      },
    });
    await assert.rejects(
      connection.remove("/notes", "file"),
      (e: any) => e.code === "session_changed" && e.outcomeUnknown
    );
  });
});
