import { strict as assert } from "assert";
import {
  BaiduManagementClient,
  BaiduManagementError,
} from "../../src/native/baiduManagement";
const root = "/apps/test/同步目录";
const key = "子目录 #&%";
const target = `${root}/${key}`;
const created = (extra = {}) => ({
  errno: 0,
  fs_id: "9007199254740993",
  path: target,
  isdir: 1,
  size: 0,
  ...extra,
});
const removed = (extra = {}) => ({
  errno: 0,
  info: [{ path: target, errno: 0 }],
  ...extra,
});
const result = (json: unknown, status = 200) => ({ json, status });
describe("Baidu scoped directory and delete operations", () => {
  it("creates an exact directory with no overwrite or automatic rename", async () => {
    let calls = 0;
    const client = new BaiduManagementClient(
      async (request) => {
        calls++;
        const url = new URL(request.url);
        assert.equal(url.origin, "https://pan.baidu.com");
        assert.equal(url.searchParams.get("method"), "create");
        assert.equal(url.searchParams.get("access_token"), "fixture-token");
        assert.equal(request.method, "POST");
        assert.equal(request.redirect, "manual");
        const form = new URLSearchParams(request.body as string);
        assert.equal(form.get("path"), target);
        assert.equal(form.get("isdir"), "1");
        assert.equal(form.get("size"), "0");
        assert.equal(form.get("rtype"), "0");
        assert.equal(form.get("uploadid"), null);
        return result(created());
      },
      async () => "fixture-token",
      root
    );
    assert.deepEqual(await client.mkdir(`${key}/`), {
      fsId: "9007199254740993",
      remotePath: target,
    });
    assert.equal(calls, 1);
  });
  it("requires a synchronous delete with one exact per-item confirmation", async () => {
    const client = new BaiduManagementClient(
      async (request) => {
        const url = new URL(request.url);
        assert.equal(url.searchParams.get("method"), "filemanager");
        assert.equal(url.searchParams.get("opera"), "delete");
        const form = new URLSearchParams(request.body as string);
        assert.equal(form.get("async"), "0");
        assert.equal(form.get("ondup"), "fail");
        assert.deepEqual(JSON.parse(form.get("filelist")!), [target]);
        return result(removed({ taskid: 0 }));
      },
      async () => "token",
      `${root}/`
    );
    assert.equal(await client.remove(key), undefined);
  });
  for (const method of ["mkdir", "remove"] as const) {
    for (const invalidKey of [
      "",
      "/",
      ".",
      "..",
      "../other",
      "/outside",
      "a//b",
      "a/./b",
      "a/../b",
      "a\u0000b",
      "\ud800",
      "\udc00",
    ]) {
      it(`${method} rejects an unsafe relative key before authentication (${JSON.stringify(invalidKey)})`, async () => {
        let calls = 0;
        const client = new BaiduManagementClient(
          async () => {
            calls++;
            throw new Error();
          },
          async () => {
            calls++;
            return "token";
          },
          root
        );
        await assert.rejects(
          client[method](invalidKey),
          (e: BaiduManagementError) =>
            e.code === "invalid_path" && !e.outcomeUnknown
        );
        assert.equal(calls, 0);
      });
    }
  }
  it("rejects an unscoped or malformed root before sending any request", async () => {
    for (const invalidRoot of [
      "/",
      "relative",
      "/apps//test",
      "/apps/../test",
      "/apps/\ud800",
    ]) {
      let calls = 0;
      const client = new BaiduManagementClient(
        async () => {
          calls++;
          throw new Error();
        },
        async () => {
          calls++;
          return "token";
        },
        invalidRoot
      );
      await assert.rejects(
        client.remove("file"),
        (e: BaiduManagementError) => e.code === "invalid_path"
      );
      assert.equal(calls, 0);
    }
  });
  it("preserves legitimate Unicode, percent signs and spaces without path truncation", async () => {
    const name = `😀${"目录".repeat(150)} %2e%2e`;
    const client = new BaiduManagementClient(
      async (request) => {
        const path = new URLSearchParams(request.body as string).get("path")!;
        assert.equal(path, `${root}/${name}`);
        return result(created({ path }));
      },
      async () => "token",
      root
    );
    assert.equal((await client.mkdir(name)).remotePath, `${root}/${name}`);
  });
  it("does not treat an existing-path error as a successfully created directory", async () => {
    const client = new BaiduManagementClient(
      async () => result({ errno: -8, errmsg: "fixture-token" }),
      async () => "token",
      root
    );
    await assert.rejects(
      client.mkdir(key),
      (e: BaiduManagementError) =>
        e.errno === -8 &&
        !e.outcomeUnknown &&
        !e.message.includes("fixture-token")
    );
  });
  it("rejects renamed, wrong-kind or imprecise directory metadata", async () => {
    for (const data of [
      created({ path: `${target}(1)` }),
      created({ isdir: 0 }),
      created({ size: 2 }),
      created({ fs_id: 9007199254740992 }),
      created({ fs_id: "0" }),
    ]) {
      const client = new BaiduManagementClient(
        async () => result(data),
        async () => "token",
        root
      );
      await assert.rejects(
        client.mkdir(key),
        (e: BaiduManagementError) =>
          e.code === "invalid_directory_metadata" && e.outcomeUnknown
      );
    }
  });
  it("does not treat top-level delete success as per-item success", async () => {
    const client = new BaiduManagementClient(
      async () =>
        result(
          removed({
            info: [{ path: target, errno: -9, errmsg: "fixture-token" }],
          })
        ),
      async () => "token",
      root
    );
    await assert.rejects(
      client.remove(key),
      (e: BaiduManagementError) =>
        e.errno === -9 && !e.message.includes("fixture-token")
    );
  });
  it("rejects missing, extra or mismatched delete confirmations", async () => {
    for (const info of [
      undefined,
      [],
      [{ path: "/other", errno: 0 }],
      [{ path: target }],
      [
        { path: target, errno: 0 },
        { path: target, errno: 0 },
      ],
    ]) {
      const client = new BaiduManagementClient(
        async () => result(removed({ info })),
        async () => "token",
        root
      );
      await assert.rejects(
        client.remove(key),
        (e: BaiduManagementError) =>
          e.code === "invalid_delete_confirmation" && e.outcomeUnknown
      );
    }
  });
  it("rejects asynchronous task acceptance even if the response also contains success items", async () => {
    for (const fields of [
      { taskid: 123 },
      { task_id: "9007199254740993" },
      { taskid: 0, task_id: 321 },
    ]) {
      const client = new BaiduManagementClient(
        async () => result(removed(fields)),
        async () => "token",
        root
      );
      await assert.rejects(
        client.remove(key),
        (e: BaiduManagementError) =>
          e.code === "delete_not_confirmed" && e.outcomeUnknown
      );
    }
  });
  it("rejects malformed task IDs rather than declaring deletion complete", async () => {
    for (const taskid of [null, -1, "secret", [], 0.5]) {
      const client = new BaiduManagementClient(
        async () => result(removed({ taskid })),
        async () => "token",
        root
      );
      await assert.rejects(
        client.remove(key),
        (e: BaiduManagementError) => e.outcomeUnknown
      );
    }
  });
  it("never retries a deletion whose response was lost", async () => {
    let calls = 0;
    const client = new BaiduManagementClient(
      async () => {
        calls++;
        throw new Error("fixture-token");
      },
      async () => "token",
      root
    );
    await assert.rejects(
      client.remove(key),
      (e: BaiduManagementError) =>
        e.code === "transport_error" &&
        e.outcomeUnknown &&
        !e.message.includes("fixture-token")
    );
    assert.equal(calls, 1);
  });
  it("reports HTTP and malformed responses as unknown mutations without echoing the body", async () => {
    for (const response of [
      result({}, 503),
      result(null),
      result({ errno: "0", errmsg: "fixture-token" }),
    ]) {
      const client = new BaiduManagementClient(
        async () => response,
        async () => "token",
        root
      );
      await assert.rejects(
        client.remove(key),
        (e: BaiduManagementError) =>
          e.outcomeUnknown && !e.message.includes("fixture-token")
      );
    }
  });
  it("stops before a mutation if the session guard fails", async () => {
    let calls = 0;
    const client = new BaiduManagementClient(
      async () => {
        calls++;
        return result(removed());
      },
      async () => "token",
      root,
      async () => {
        throw new Error("fixture-secret");
      }
    );
    await assert.rejects(
      client.remove(key),
      (e: BaiduManagementError) =>
        e.code === "session_changed" && !e.outcomeUnknown
    );
    assert.equal(calls, 0);
  });
  it("does not report success if the account changed while the mutation was pending", async () => {
    let changed = false;
    const client = new BaiduManagementClient(
      async () => {
        changed = true;
        return result(removed());
      },
      async () => "token",
      root,
      async () => {
        if (changed) throw new Error();
      }
    );
    await assert.rejects(
      client.remove(key),
      (e: BaiduManagementError) =>
        e.code === "session_changed" && e.outcomeUnknown
    );
  });
  it("does not accept an HTTP 202 delete as completion", async () => {
    const client = new BaiduManagementClient(
      async () => result(removed(), 202),
      async () => "token",
      root
    );
    await assert.rejects(
      client.remove(key),
      (e: BaiduManagementError) =>
        e.code === "delete_not_confirmed" && e.outcomeUnknown
    );
  });
  it("rejects an explicit asynchronous response mode", async () => {
    const client = new BaiduManagementClient(
      async () => result(removed({ async: 2 })),
      async () => "token",
      root
    );
    await assert.rejects(
      client.remove(key),
      (e: BaiduManagementError) =>
        e.code === "delete_not_confirmed" && e.outcomeUnknown
    );
  });
  it("does not ignore a contradictory top-level error_code", async () => {
    const client = new BaiduManagementClient(
      async () =>
        result(removed({ error_code: 31023, error_msg: "fixture-token" })),
      async () => "token",
      root
    );
    await assert.rejects(
      client.remove(key),
      (e: BaiduManagementError) =>
        e.errno === 31023 && !e.message.includes("fixture-token")
    );
  });
});
