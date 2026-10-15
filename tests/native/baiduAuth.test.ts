import { strict as assert } from "assert";
import {
  BaiduOAuthClient,
  BaiduOAuthError,
  createBaiduAuthorizationUrl,
  parseBaiduAuthorizationCallback,
  type BaiduTokenRequest,
} from "../../src/native/baiduAuth";
const app = {
  clientId: "fixture-app",
  clientSecret: "fixture-secret",
  redirectUri: "obsidian://remotely-save-baidu",
};
const state = "fixture-random-state";
const response = {
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  expires_in: 3600,
};
describe("Baidu native authorization foundation", () => {
  it("builds an official authorization URL with exact callback, scopes and state", () => {
    const url = new URL(
      createBaiduAuthorizationUrl(app.clientId, app.redirectUri, state)
    );
    assert.equal(url.origin, "https://openapi.baidu.com");
    assert.equal(url.pathname, "/oauth/2.0/authorize");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), app.clientId);
    assert.equal(url.searchParams.get("redirect_uri"), app.redirectUri);
    assert.equal(url.searchParams.get("scope"), "basic,netdisk");
    assert.equal(url.searchParams.get("state"), state);
    assert.ok(!url.toString().includes(app.clientSecret));
  });
  it("extracts a code only after validating callback destination and state", () => {
    assert.equal(
      parseBaiduAuthorizationCallback(
        `${app.redirectUri}?state=${state}&code=fixture%2Bcode`,
        app.redirectUri,
        state
      ),
      "fixture+code"
    );
  });
  for (const suffix of [
    "state=wrong&code=x",
    "code=x",
    `state=${state}&state=wrong&code=x`,
    `state=${state}`,
    `state=${state}&code=x&code=y`,
    `state=${state}&error=access_denied`,
  ]) {
    it(`rejects an invalid authorization callback: ${suffix}`, () => {
      assert.throws(
        () =>
          parseBaiduAuthorizationCallback(
            `${app.redirectUri}?${suffix}`,
            app.redirectUri,
            state
          ),
        BaiduOAuthError
      );
    });
  }
  it("rejects a callback to another plugin handler", () => {
    assert.throws(
      () =>
        parseBaiduAuthorizationCallback(
          `obsidian://other-plugin?state=${state}&code=x`,
          app.redirectUri,
          state
        ),
      BaiduOAuthError
    );
  });
  it("exchanges a code by POST without putting secrets into the URL", async () => {
    let captured: BaiduTokenRequest | undefined;
    const auth = new BaiduOAuthClient(
      async (request) => {
        captured = request;
        return { status: 200, json: response };
      },
      () => 1000
    );
    const tokens = await auth.exchangeCode(app, "fixture+code");
    assert.deepEqual(tokens, {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: 3601000,
    });
    assert.equal(captured!.url, "https://openapi.baidu.com/oauth/2.0/token");
    assert.equal(captured!.method, "POST");
    assert.equal(
      captured!.headers["Content-Type"],
      "application/x-www-form-urlencoded"
    );
    const form = new URLSearchParams(captured!.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "fixture+code");
    assert.equal(form.get("client_secret"), app.clientSecret);
    assert.equal(form.get("redirect_uri"), app.redirectUri);
  });
  it("refreshes with the user's own app and adopts a rotated refresh token", async () => {
    const auth = new BaiduOAuthClient(
      async (request) => {
        const form = new URLSearchParams(request.body);
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("refresh_token"), "old-token");
        assert.equal(form.get("client_id"), app.clientId);
        return { status: 200, json: response };
      },
      () => 1000
    );
    assert.equal(
      (await auth.refresh(app, "old-token")).refreshToken,
      response.refresh_token
    );
  });
  it("retains the refresh token when a refresh response omits rotation", async () => {
    const auth = new BaiduOAuthClient(async () => ({
      status: 200,
      json: { access_token: "new", expires_in: 60 },
    }));
    assert.equal(
      (await auth.refresh(app, "old-token")).refreshToken,
      "old-token"
    );
  });
  for (const json of [
    null,
    {},
    { ...response, access_token: "" },
    { ...response, refresh_token: "" },
    { ...response, expires_in: -1 },
    { ...response, expires_in: "3600" },
    { ...response, expires_in: Infinity },
  ]) {
    it("rejects a malformed token response instead of saving partial credentials", async () => {
      const auth = new BaiduOAuthClient(async () => ({ status: 200, json }));
      await assert.rejects(
        () => auth.exchangeCode(app, "code"),
        BaiduOAuthError
      );
    });
  }
  it("does not expose a platform error description that echoes credentials", async () => {
    const auth = new BaiduOAuthClient(async () => ({
      status: 200,
      json: {
        error: "invalid_grant",
        error_description: "fixture-secret fixture-access",
      },
    }));
    await assert.rejects(
      () => auth.exchangeCode(app, "code"),
      (error: BaiduOAuthError) => {
        assert.equal(error.code, "invalid_grant");
        assert.ok(!error.message.includes("fixture-secret"));
        assert.ok(!error.message.includes("fixture-access"));
        return true;
      }
    );
  });
  it("reports HTTP failures without exposing response bodies", async () => {
    const auth = new BaiduOAuthClient(async () => ({
      status: 503,
      json: { secret: app.clientSecret },
    }));
    await assert.rejects(
      () => auth.refresh(app, "old"),
      (error: BaiduOAuthError) =>
        error.status === 503 && !error.message.includes(app.clientSecret)
    );
  });
  it("rejects missing app credentials before sending a request", async () => {
    let requests = 0;
    const auth = new BaiduOAuthClient(async () => {
      requests++;
      return { status: 200, json: response };
    });
    await assert.rejects(
      () => auth.exchangeCode({ ...app, clientSecret: "" }, "code"),
      BaiduOAuthError
    );
    assert.equal(requests, 0);
  });
});

describe("Baidu authorization boundary failures", () => {
  it("rejects an explicit grant lacking netdisk access", async () => {
    const auth = new BaiduOAuthClient(async () => ({
      status: 200,
      json: { ...response, scope: "basic" },
    }));
    await assert.rejects(
      () => auth.exchangeCode(app, "code"),
      (error: BaiduOAuthError) => error.code === "missing_netdisk_scope"
    );
  });
  it("preserves the granted scope when netdisk access is present", async () => {
    const auth = new BaiduOAuthClient(async () => ({
      status: 200,
      json: { ...response, scope: "basic netdisk" },
    }));
    assert.equal((await auth.exchangeCode(app, "code")).scope, "basic netdisk");
  });
  it("rejects invalid HTTP status values", async () => {
    const auth = new BaiduOAuthClient(async () => ({
      status: NaN,
      json: response,
    }));
    await assert.rejects(() => auth.refresh(app, "old"), BaiduOAuthError);
  });
  it("does not echo transport errors containing secrets", async () => {
    const auth = new BaiduOAuthClient(async () => {
      throw new Error(app.clientSecret);
    });
    await assert.rejects(
      () => auth.refresh(app, "old"),
      (error: BaiduOAuthError) =>
        error.code === "transport_error" &&
        !error.message.includes(app.clientSecret)
    );
  });
  it("does not echo an unrecognized platform error string", async () => {
    const auth = new BaiduOAuthClient(async () => ({
      status: 200,
      json: { error: app.clientSecret },
    }));
    await assert.rejects(
      () => auth.refresh(app, "old"),
      (error: BaiduOAuthError) =>
        error.code === "platform_error" &&
        !error.message.includes(app.clientSecret)
    );
  });
  it("accepts oob authorization without pretending it is a URL callback", () => {
    assert.equal(
      new URL(
        createBaiduAuthorizationUrl(app.clientId, "oob", state)
      ).searchParams.get("redirect_uri"),
      "oob"
    );
    assert.throws(
      () => parseBaiduAuthorizationCallback("oob", "oob", state),
      BaiduOAuthError
    );
  });
});
