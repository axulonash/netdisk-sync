import { strict as assert } from "assert";
import { BaiduConnection } from "../../src/native/baiduConnection";
import {
  bindBaiduIdentity,
  getBaiduProfileId,
} from "../../src/native/baiduProfile";
const app = { clientId: "app", clientSecret: "secret", redirectUri: "oob" };
const tokens = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 9999999999999,
};
const identity = (remoteRoot = "/apps/test") =>
  bindBaiduIdentity({ app, tokens, remoteRoot }, "a".repeat(32));
describe("Baidu sync profile isolation", () => {
  it("uses an opaque profile without including credentials, password or path", () => {
    const config = identity();
    const profile = getBaiduProfileId(config, "password", "openssl-base64");
    assert.match(profile, /^baidu-v1-[a-f0-9]{64}$/);
    for (const value of [
      "secret",
      "access",
      "refresh",
      "password",
      "/apps/test",
    ])
      assert.ok(!profile.includes(value));
    assert.equal(
      profile,
      getBaiduProfileId(structuredClone(config), "password", "openssl-base64")
    );
  });
  it("isolates root, authorization identity, password and encryption method", () => {
    const base = getBaiduProfileId(identity(), "password", "openssl-base64");
    for (const profile of [
      getBaiduProfileId(identity("/apps/other"), "password", "openssl-base64"),
      getBaiduProfileId(
        bindBaiduIdentity(
          { app, tokens, remoteRoot: "/apps/test" },
          "b".repeat(32)
        ),
        "password",
        "openssl-base64"
      ),
      getBaiduProfileId(identity(), "other", "openssl-base64"),
      getBaiduProfileId(identity(), "password", "rclone-base64"),
    ])
      assert.notEqual(profile, base);
    assert.equal(
      getBaiduProfileId(identity("/apps/test/"), "", "unknown"),
      getBaiduProfileId(identity(), "", "openssl-base64")
    );
  });
  it("rejects missing identity or credentials swapped without a matching binding", () => {
    assert.throws(
      () =>
        getBaiduProfileId(
          { app, tokens, remoteRoot: "/apps/test" },
          "",
          "unknown"
        ),
      /reauthorize_required/
    );
    const config = identity();
    config.tokens = { ...tokens, accessToken: "foreign" };
    assert.throws(
      () => getBaiduProfileId(config, "", "unknown"),
      /credential_binding_mismatch/
    );
  });
  it("rejects unconfigured or invalid roots before accessing any sync history", () => {
    for (const root of [undefined, "", "/", "relative", "/apps/../test"]) {
      const config = bindBaiduIdentity(
        { app, tokens, remoteRoot: root },
        "a".repeat(32)
      );
      assert.throws(() => getBaiduProfileId(config, "", "unknown"));
    }
  });
  it("keeps root and identity through a token refresh while updating the binding", async () => {
    let config: any = bindBaiduIdentity(
      { app, tokens: { ...tokens, expiresAt: 0 }, remoteRoot: "/apps/test" },
      "a".repeat(32)
    );
    const before = getBaiduProfileId(config, "", "unknown");
    const connection = new BaiduConnection({
      getConfig: () => config,
      saveConfig: async (next) => {
        config = next;
      },
      transport: async (request) =>
        request.method === "POST"
          ? {
              status: 200,
              json: {
                access_token: "rotated",
                refresh_token: "rotated-refresh",
                expires_in: 3600,
              },
            }
          : { status: 200, json: { errno: 0, list: [] } },
    });
    await connection.scan("/apps/test");
    assert.equal(config.remoteRoot, "/apps/test");
    assert.equal(getBaiduProfileId(config, "", "unknown"), before);
    assert.equal(config.tokens.accessToken, "rotated");
  });
  it("cannot bless swapped credentials into the old identity by refreshing from a read-only check", async () => {
    let config: any = identity();
    config.tokens = { ...tokens, accessToken: "foreign", expiresAt: 0 };
    let requests = 0;
    const connection = new BaiduConnection({
      getConfig: () => config,
      saveConfig: async (next) => {
        config = next;
      },
      transport: async (request) => {
        requests++;
        return request.method === "POST"
          ? {
              status: 200,
              json: {
                access_token: "rotated",
                refresh_token: "rotated-refresh",
                expires_in: 3600,
              },
            }
          : { status: 200, json: { errno: 0, list: [] } };
      },
    });
    await assert.rejects(
      connection.scan("/apps/test"),
      /credential_binding_mismatch/
    );
    assert.equal(requests, 0);
    assert.throws(
      () => getBaiduProfileId(config, "", "unknown"),
      /credential_binding_mismatch/
    );
  });
  it("saves only a successfully checked directory and keeps the old root after scan failure", async () => {
    let config: any = identity();
    let denied = false;
    let saves = 0;
    const connection = new BaiduConnection({
      getConfig: () => config,
      saveConfig: async (next) => {
        saves++;
        config = next;
      },
      transport: async () => ({
        status: denied ? 403 : 200,
        json: { errno: 0, list: [] },
      }),
    });
    await connection.setRemoteRoot("/apps/other/");
    assert.equal(config.remoteRoot, "/apps/other");
    assert.equal(saves, 1);
    denied = true;
    await assert.rejects(connection.setRemoteRoot("/apps/denied"));
    assert.equal(config.remoteRoot, "/apps/other");
    assert.equal(saves, 1);
  });
  it("gives reauthorization a new profile even for the same application and directory", async () => {
    let config: any = identity();
    const before = getBaiduProfileId(config, "", "unknown");
    const connection = new BaiduConnection({
      getConfig: () => config,
      saveConfig: async (next) => {
        config = next;
      },
      transport: async () => ({
        status: 200,
        json: {
          access_token: "new",
          refresh_token: "new-refresh",
          expires_in: 3600,
        },
      }),
    });
    await connection.login(app, "code");
    assert.equal(config.remoteRoot, "/apps/test");
    assert.notEqual(getBaiduProfileId(config, "", "unknown"), before);
  });
});
