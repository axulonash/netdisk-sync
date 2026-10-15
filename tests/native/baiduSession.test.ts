import { strict as assert } from "assert";
import {
  BaiduTokenSession,
  BaiduSessionError,
} from "../../src/native/baiduSession";
import type { BaiduTokens } from "../../src/native/baiduAuth";
const expired: BaiduTokens = {
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: 0,
};
const fresh: BaiduTokens = {
  accessToken: "new-access",
  refreshToken: "rotated-refresh",
  expiresAt: 100000,
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
describe("Baidu token session lifecycle", () => {
  it("reuses a valid token without a refresh or save", async () => {
    let refreshes = 0,
      saves = 0;
    const session = new BaiduTokenSession({
      tokens: fresh,
      now: () => 1000,
      refresh: async () => {
        refreshes++;
        return fresh;
      },
      save: async () => {
        saves++;
      },
    });
    assert.equal(await session.getAccessToken(), "new-access");
    assert.equal(refreshes, 0);
    assert.equal(saves, 0);
  });
  it("shares one refresh across concurrent callers and waits for persistence", async () => {
    const saving = gate(),
      entered = gate();
    let refreshes = 0;
    const session = new BaiduTokenSession({
      tokens: expired,
      now: () => 1000,
      refresh: async (token) => {
        assert.equal(token, "old-refresh");
        refreshes++;
        return fresh;
      },
      save: async (tokens) => {
        assert.deepEqual(tokens, fresh);
        entered.release();
        await saving.promise;
      },
    });
    const first = session.getAccessToken(),
      second = session.getAccessToken();
    await entered.promise;
    let resolved = false;
    first.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    assert.equal(resolved, false);
    saving.release();
    assert.deepEqual(await Promise.all([first, second]), [
      "new-access",
      "new-access",
    ]);
    assert.equal(refreshes, 1);
  });
  it("retries saving a rotated token instead of refreshing again after a save failure", async () => {
    let refreshes = 0,
      saves = 0;
    const session = new BaiduTokenSession({
      tokens: expired,
      now: () => 1000,
      refresh: async () => {
        refreshes++;
        return fresh;
      },
      save: async () => {
        if (++saves === 1) throw new Error("secret save failure");
      },
    });
    await assert.rejects(
      () => session.getAccessToken(),
      (e: BaiduSessionError) =>
        e.code === "save_failed" && !e.message.includes("secret")
    );
    assert.equal(await session.getAccessToken(), "new-access");
    assert.equal(refreshes, 1);
    assert.equal(saves, 2);
  });
  it("allows the next operation to retry a failed refresh", async () => {
    let refreshes = 0;
    const session = new BaiduTokenSession({
      tokens: expired,
      now: () => 1000,
      refresh: async () => {
        if (++refreshes === 1) throw new Error("secret refresh failure");
        return fresh;
      },
      save: async () => {},
    });
    await assert.rejects(
      () => session.getAccessToken(),
      (e: BaiduSessionError) =>
        e.code === "refresh_failed" && !e.message.includes("secret")
    );
    assert.equal(await session.getAccessToken(), "new-access");
  });
  it("logout during refresh cannot restore the old session", async () => {
    const refreshing = gate(),
      entered = gate();
    const saved: (BaiduTokens | undefined)[] = [];
    const session = new BaiduTokenSession({
      tokens: expired,
      now: () => 1000,
      refresh: async () => {
        entered.release();
        await refreshing.promise;
        return fresh;
      },
      save: async (tokens) => {
        saved.push(tokens);
      },
    });
    const result = session.getAccessToken().then(
      () => "unexpected",
      (e: BaiduSessionError) => e.code
    );
    await entered.promise;
    await session.logout();
    refreshing.release();
    assert.equal(await result, "session_changed");
    assert.deepEqual(saved, [undefined]);
    await assert.rejects(
      () => session.getAccessToken(),
      (e: BaiduSessionError) => e.code === "not_logged_in"
    );
  });
  it("logout waits behind a pending save and leaves persisted state cleared", async () => {
    const saving = gate(),
      entered = gate();
    const saved: (BaiduTokens | undefined)[] = [];
    const session = new BaiduTokenSession({
      tokens: expired,
      now: () => 1000,
      refresh: async () => fresh,
      save: async (tokens) => {
        if (tokens) {
          entered.release();
          await saving.promise;
        }
        saved.push(tokens);
      },
    });
    const result = session.getAccessToken().then(
      () => "unexpected",
      (e: BaiduSessionError) => e.code
    );
    await entered.promise;
    const logout = session.logout();
    saving.release();
    await logout;
    assert.equal(await result, "session_changed");
    assert.deepEqual(saved, [fresh, undefined]);
  });
  it("keeps memory logged out if clearing persisted credentials fails", async () => {
    const session = new BaiduTokenSession({
      tokens: fresh,
      now: () => 1000,
      refresh: async () => fresh,
      save: async () => {
        throw new Error("secret");
      },
    });
    await assert.rejects(
      () => session.logout(),
      (e: BaiduSessionError) => e.code === "save_failed"
    );
    await assert.rejects(
      () => session.getAccessToken(),
      (e: BaiduSessionError) => e.code === "not_logged_in"
    );
  });
  it("does not retain mutable token references from the caller or save callback", async () => {
    const initial = { ...expired };
    const session = new BaiduTokenSession({
      tokens: initial,
      now: () => 1000,
      refresh: async (token) => {
        assert.equal(token, "old-refresh");
        return { ...fresh };
      },
      save: async (tokens) => {
        tokens!.accessToken = "mutated";
      },
    });
    initial.refreshToken = "external mutation";
    assert.equal(await session.getAccessToken(), "new-access");
  });
  it("does not refresh forever when a provider returns an already expired token", async () => {
    let calls = 0;
    const session = new BaiduTokenSession({
      tokens: expired,
      now: () => 1000,
      refresh: async () => {
        calls++;
        return expired;
      },
      save: async () => {
        throw new Error("must not save");
      },
    });
    await assert.rejects(
      () => session.getAccessToken(),
      (e: BaiduSessionError) => e.code === "invalid_tokens"
    );
    assert.equal(calls, 1);
  });
});

describe("Baidu session expiry boundaries", () => {
  it("does not return a token that expired while its save was pending", async () => {
    let now = 1000;
    const session = new BaiduTokenSession({
      tokens: expired,
      now: () => now,
      refresh: async () => fresh,
      save: async () => {
        now = 100001;
      },
    });
    await assert.rejects(
      () => session.getAccessToken(),
      (e: BaiduSessionError) => e.code === "token_expired"
    );
  });
  it("refreshes with the rotated token if an unsaved candidate later expires", async () => {
    let now = 1000,
      saves = 0;
    const refreshTokens: string[] = [];
    const session = new BaiduTokenSession({
      tokens: expired,
      now: () => now,
      refresh: async (token) => {
        refreshTokens.push(token);
        return refreshTokens.length === 1
          ? fresh
          : { ...fresh, accessToken: "later-access", expiresAt: 300000 };
      },
      save: async () => {
        if (++saves === 1) throw new Error("save failed");
      },
    });
    await assert.rejects(() => session.getAccessToken(), BaiduSessionError);
    now = 100001;
    assert.equal(await session.getAccessToken(), "later-access");
    assert.deepEqual(refreshTokens, ["old-refresh", "rotated-refresh"]);
  });
});
