import { strict as assert } from "assert";
import {
  BaiduReadClient,
  BaiduReadError,
  type BaiduReadTransport,
} from "../../src/native/baiduRead";
const file = (path: string, id: number | string = 1, directory = false) => ({
  path,
  fs_id: id,
  isdir: directory ? 1 : 0,
  size: directory ? 0 : 7,
  server_mtime: 1700000000,
  server_ctime: 1699999999,
});
const ok = (list: unknown[]) => ({ status: 200, json: { errno: 0, list } });
const client = (transport: BaiduReadTransport, limits = {}) =>
  new BaiduReadClient(transport, "fixture-token", limits);
describe("Baidu native complete directory reads", () => {
  it("requests the official file-list endpoint with literal Unicode and special-character paths", async () => {
    const reader = client(async ({ url, method }) => {
      const u = new URL(url);
      assert.equal(u.origin, "https://pan.baidu.com");
      assert.equal(u.pathname, "/rest/2.0/xpan/file");
      assert.equal(method, "GET");
      assert.equal(u.searchParams.get("method"), "list");
      assert.equal(u.searchParams.get("dir"), "/测试 # %20");
      assert.equal(u.searchParams.get("access_token"), "fixture-token");
      assert.equal(u.searchParams.get("start"), "0");
      assert.equal(u.searchParams.get("limit"), "1000");
      return ok([file("/测试 # %20/笔记.md")]);
    });
    assert.deepEqual(await reader.listDirectory("/测试 # %20/"), [
      {
        fsId: "1",
        remotePath: "/测试 # %20/笔记.md",
        isDirectory: false,
        size: 7,
        mtimeMs: 1700000000000,
        ctimeMs: 1699999999000,
      },
    ]);
  });
  it("combines all pages, including the empty page after an exact page boundary", async () => {
    const offsets: string[] = [];
    const reader = client(
      async ({ url }) => {
        const start = new URL(url).searchParams.get("start")!;
        offsets.push(start);
        return start === "0"
          ? ok([file("/test/a", 1), file("/test/b", 2)])
          : start === "2"
            ? ok([file("/test/c", 3), file("/test/d", 4)])
            : ok([]);
      },
      { pageSize: 2 }
    );
    assert.deepEqual(
      (await reader.listDirectory("/test")).map((x) => x.fsId),
      ["1", "2", "3", "4"]
    );
    assert.deepEqual(offsets, ["0", "2", "4"]);
  });
  it("rejects a second-page error rather than returning the first page", async () => {
    const reader = client(
      async ({ url }) =>
        new URL(url).searchParams.get("start") === "0"
          ? ok([file("/test/a"), file("/test/b", 2)])
          : { status: 200, json: { errno: -6, errmsg: "fixture-token" } },
      { pageSize: 2 }
    );
    await assert.rejects(
      () => reader.listDirectory("/test"),
      (e: BaiduReadError) =>
        e.errno === -6 && !e.message.includes("fixture-token")
    );
  });
  it("rejects HTTP and transport errors without including credentials", async () => {
    for (const transport of [
      async () => ({ status: 503, json: { token: "fixture-token" } }),
      async () => {
        throw new Error("fixture-token");
      },
    ]) {
      await assert.rejects(
        () => client(transport).listDirectory("/test"),
        (e: BaiduReadError) =>
          e instanceof BaiduReadError && !e.message.includes("fixture-token")
      );
    }
  });
  for (const json of [
    null,
    {},
    { list: [] },
    { errno: "0", list: [] },
    { errno: 0 },
    { errno: 0, list: {} },
  ]) {
    it("never interprets a malformed success response as an empty directory", async () => {
      await assert.rejects(
        () =>
          client(async () => ({ status: 200, json })).listDirectory("/test"),
        BaiduReadError
      );
    });
  }
  for (const entry of [
    file("/outside/note"),
    file("/test/a/b"),
    file("/test/../note"),
    file("/test//note"),
    { ...file("/test/a"), size: -1 },
    { ...file("/test/a"), fs_id: Number.MAX_SAFE_INTEGER + 1 },
    { ...file("/test/a"), isdir: 2 },
    { ...file("/test/a"), server_mtime: "1700000000" },
  ]) {
    it("rejects invalid metadata or an entry outside the direct parent", async () => {
      await assert.rejects(
        () => client(async () => ok([entry])).listDirectory("/test"),
        BaiduReadError
      );
    });
  }
  it("preserves a large decimal-string file ID without precision loss", async () => {
    const entries = await client(async () =>
      ok([file("/test/a", "9007199254740993")])
    ).listDirectory("/test");
    assert.equal(entries[0].fsId, "9007199254740993");
  });
  it("rejects duplicate paths or IDs across pages instead of guessing completeness", async () => {
    for (const second of [file("/test/a", 2), file("/test/b", 1)]) {
      const reader = client(
        async ({ url }) =>
          ok([
            new URL(url).searchParams.get("start") === "0"
              ? file("/test/a", 1)
              : second,
          ]),
        { pageSize: 1, maxPages: 3 }
      );
      await assert.rejects(
        () => reader.listDirectory("/test"),
        (e: BaiduReadError) => e.code === "duplicate_entry"
      );
    }
  });
  it("stops a nonterminating scan at its page limit with an error", async () => {
    let calls = 0;
    const reader = client(
      async () => ok([file(`/test/file-${++calls}`, calls)]),
      { pageSize: 1, maxPages: 2 }
    );
    await assert.rejects(
      () => reader.listDirectory("/test"),
      (e: BaiduReadError) => e.code === "page_limit"
    );
    assert.equal(calls, 2);
  });
  it("fails instead of silently truncating at the entry limit", async () => {
    const reader = client(
      async () => ok([file("/test/a", 1), file("/test/b", 2)]),
      { maxEntries: 1 }
    );
    await assert.rejects(
      () => reader.listDirectory("/test"),
      (e: BaiduReadError) => e.code === "entry_limit"
    );
  });
  it("returns recursive keys relative to the root with directory markers", async () => {
    const reader = client(async ({ url }) =>
      new URL(url).searchParams.get("dir") === "/test"
        ? ok([file("/test/folder", 1, true), file("/test/a.md", 2)])
        : ok([file("/test/folder/b.md", 3)])
    );
    assert.deepEqual(
      (await reader.scan("/test/")).map((x) => x.key),
      ["folder/", "a.md", "folder/b.md"]
    );
  });
  it("rejects the entire recursive result when a child directory fails", async () => {
    const reader = client(async ({ url }) =>
      new URL(url).searchParams.get("dir") === "/test"
        ? ok([file("/test/folder", 1, true)])
        : { status: 403, json: {} }
    );
    await assert.rejects(
      () => reader.scan("/test"),
      (e: BaiduReadError) => e.status === 403
    );
  });
  it("applies the total entry limit across different child directories", async () => {
    const reader = client(
      async ({ url }) =>
        new URL(url).searchParams.get("dir") === "/test"
          ? ok([file("/test/folder", 1, true)])
          : ok([file("/test/folder/b.md", 2)]),
      { maxEntries: 1 }
    );
    await assert.rejects(
      () => reader.scan("/test"),
      (e: BaiduReadError) => e.code === "entry_limit"
    );
  });
  it("supports account root without dropping the first path component", async () => {
    const reader = client(async () => ok([file("/a.md")]));
    assert.equal((await reader.scan("/"))[0].key, "a.md");
  });
  it("rejects unsafe roots before requesting any credentials-bearing URL", async () => {
    let requests = 0;
    const reader = client(async () => {
      requests++;
      return ok([]);
    });
    for (const root of [
      "relative",
      "//",
      "/test/../outside",
      "/test//folder",
      "/test/./folder",
      "/test\u0000folder",
    ])
      await assert.rejects(() => reader.scan(root), BaiduReadError);
    assert.equal(requests, 0);
  });
});

describe("Baidu read boundary controls", () => {
  it("returns empty only for an explicit valid empty page", async () => {
    assert.deepEqual(await client(async () => ok([])).scan("/test"), []);
  });
  it("rejects duplicate IDs across separate directories", async () => {
    const reader = client(async ({ url }) =>
      new URL(url).searchParams.get("dir") === "/test"
        ? ok([file("/test/folder", 1, true)])
        : ok([file("/test/folder/a", 1)])
    );
    await assert.rejects(
      () => reader.scan("/test"),
      (e: BaiduReadError) => e.code === "duplicate_entry"
    );
  });
  it("rejects oversized pages and invalid HTTP statuses", async () => {
    await assert.rejects(
      () =>
        client(async () => ok([file("/test/a"), file("/test/b", 2)]), {
          pageSize: 1,
        }).listDirectory("/test"),
      BaiduReadError
    );
    await assert.rejects(
      () =>
        client(async () => ({
          status: NaN,
          json: { errno: 0, list: [] },
        })).listDirectory("/test"),
      BaiduReadError
    );
  });
  it("validates scan limits and credentials before any request", () => {
    const transport = async () => ok([]);
    for (const limits of [
      { pageSize: 0 },
      { pageSize: 1001 },
      { maxPages: -1 },
      { maxEntries: Infinity },
    ])
      assert.throws(() => client(transport, limits), BaiduReadError);
    assert.throws(() => new BaiduReadClient(transport, ""), BaiduReadError);
  });
});
