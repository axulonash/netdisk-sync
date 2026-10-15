import { strict as assert } from "assert";
import { BaiduConnection } from "../../src/native/baiduConnection";
import {
  bindBaiduIdentity,
  getBaiduProfileId,
} from "../../src/native/baiduProfile";
import { createBaiduSyncClient } from "../../src/native/baiduService";
import { getServiceChoices } from "../../src/settingsLayout";
function setup() {
  let settings: any = {
    serviceType: "baidu",
    password: "",
    encryptionMethod: "unknown",
    baiduNative: bindBaiduIdentity(
      {
        app: { clientId: "app", clientSecret: "secret", redirectUri: "oob" },
        tokens: {
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: 9999999999999,
        },
        remoteRoot: "/apps/test",
      },
      "a".repeat(32)
    ),
  };
  const requests: URL[] = [];
  let onRead = () => {};
  const connection = new BaiduConnection({
    getConfig: () => settings.baiduNative,
    saveConfig: async (config) => {
      settings.baiduNative = config;
    },
    transport: async (request) => {
      requests.push(new URL(request.url));
      onRead();
      return { status: 200, json: { errno: 0, list: [] } };
    },
  });
  return {
    connection,
    onRead: (fn: () => void) => {
      onRead = fn;
    },
    getSettings: () => settings,
    replace: (next: any) => {
      settings = next;
    },
    requests,
  };
}
describe("Baidu desktop service entry", () => {
  it("offers Baidu on desktop while retaining an existing legacy provider", () => {
    assert.deepEqual(getServiceChoices("webdav", "s3", true), [
      "webdav",
      "baidu",
      "quark",
      "aliyun",
      "s3",
    ]);
    assert.deepEqual(getServiceChoices("baidu", "s3", true), [
      "webdav",
      "baidu",
      "quark",
      "aliyun",
      "s3",
    ]);
    assert.deepEqual(getServiceChoices("webdav", undefined, false), ["webdav"]);
  });
  it("creates a scoped filesystem with its isolated profile and configured directory", async () => {
    const f = setup();
    const client = createBaiduSyncClient(f.connection, f.getSettings);
    assert.equal(client.kind, "baidu");
    assert.deepEqual(await client.walk(), []);
    assert.equal(f.requests[0].searchParams.get("dir"), "/apps/test");
    assert.match(
      getBaiduProfileId(f.getSettings().baiduNative, "", "unknown"),
      /^baidu-v1-/
    );
  });
  for (const change of ["root", "password", "method", "service", "import"])
    it(`rejects an old filesystem before requests after scope changes: ${change}`, async () => {
      const f = setup();
      const client = createBaiduSyncClient(f.connection, f.getSettings);
      const next = structuredClone(f.getSettings());
      if (change === "root") next.baiduNative.remoteRoot = "/apps/other";
      if (change === "password") next.password = "new-password";
      if (change === "method") {
        next.password = "new-password";
        next.encryptionMethod = "openssl-base64";
      }
      if (change === "service") next.serviceType = "webdav";
      if (change === "import") next.baiduNative.tokens.accessToken = "foreign";
      f.replace(next);
      await assert.rejects(client.walk());
      assert.equal(f.requests.length, 0);
    });
  it("rejects scope changes while a scan is in flight before returning metadata", async () => {
    const f = setup();
    const client = createBaiduSyncClient(f.connection, f.getSettings);
    f.onRead(() => {
      f.getSettings().password = "changed";
      f.getSettings().encryptionMethod = "openssl-base64";
    });
    await assert.rejects(client.walk(), /sync_scope_changed/);
  });
  it("reports a completed logout as success and invalidates the old client", async () => {
    const f = setup();
    const client = createBaiduSyncClient(f.connection, f.getSettings);
    await client.revokeAuth();
    assert.equal(f.getSettings().baiduNative.tokens, undefined);
    assert.equal(f.getSettings().baiduNative.syncIdentity, undefined);
    await assert.rejects(client.walk());
  });
  it("requires a verified login identity and explicit directory before creating a client", () => {
    const f = setup();
    f.getSettings().baiduNative.syncIdentity = undefined;
    assert.throws(
      () => createBaiduSyncClient(f.connection, f.getSettings),
      /reauthorize_required/
    );
  });
});
