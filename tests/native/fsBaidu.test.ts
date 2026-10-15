import { strict as assert } from "assert";
import { FakeFsBaidu } from "../../src/fsBaidu";
import { BaiduConnection } from "../../src/native/baiduConnection";

const rawFile = {
  fs_id: 2,
  path: "/apps/test/中文.txt",
  isdir: 0,
  size: 3,
  server_mtime: 20,
  server_ctime: 10,
};
const rawFolder = {
  fs_id: 1,
  path: "/apps/test/目录",
  isdir: 1,
  size: 0,
  server_mtime: 15,
  server_ctime: 10,
};
function fixture(expired = false) {
  let config: any = {
    app: { clientId: "app", clientSecret: "secret", redirectUri: "oob" },
    tokens: {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: expired ? 0 : Date.now() + 3600000,
    },
  };
  const entries: any[] = [rawFile, rawFolder];
  const requests: URL[] = [];
  let beforeResponse: () => void = () => {};
  let failScan = false;
  let binaryCalls = 0;
  let deleteFailure = false;
  let saveGate: () => Promise<void> = async () => {};
  const connection = new BaiduConnection({
    getConfig: () => config,
    saveConfig: async (next) => {
      config = next;
      await saveGate();
    },
    transport: async (request) => {
      const url = new URL(request.url);
      requests.push(url);
      beforeResponse();
      if (request.method === "POST")
        return {
          status: 200,
          json: {
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          },
        };
      if (url.searchParams.get("method") === "filemetas")
        return {
          status: 200,
          json: {
            errno: 0,
            list: [
              { fs_id: 2, size: 3, dlink: "https://d.pcs.baidu.com/file" },
            ],
          },
        };
      if (failScan) return { status: 503, json: {} };
      const parent = url.searchParams.get("dir");
      return {
        status: 200,
        json: {
          errno: 0,
          list: entries.filter(
            (item) => item.path.slice(0, item.path.lastIndexOf("/")) === parent
          ),
        },
      };
    },
    binary: async () => {
      binaryCalls++;
      return {
        status: 200,
        headers: {},
        body: new Uint8Array([1, 2, 3]).buffer,
      };
    },
    upload: async (request) => {
      const url = new URL(request.url);
      requests.push(url);
      const form = new URLSearchParams(request.body as string);
      const method = url.searchParams.get("method");
      if (method === "filemanager")
        return {
          status: 200,
          json: {
            errno: 0,
            info: [
              {
                path: JSON.parse(form.get("filelist")!)[0],
                errno: deleteFailure ? -9 : 0,
              },
            ],
          },
        };
      const path = form.get("path")!;
      if (form.get("isdir") === "1") {
        entries.push({
          fs_id: 9,
          path,
          isdir: 1,
          size: 0,
          server_mtime: 30,
          server_ctime: 30,
        });
        return {
          status: 200,
          json: { errno: 0, fs_id: 9, path, isdir: 1, size: 0 },
        };
      }
      entries.push({ ...rawFile, path, fs_id: 8 });
      return {
        status: 200,
        json: { errno: 0, return_type: 2, fs_id: 8, path, isdir: 0, size: 3 },
      };
    },
  });
  return {
    fs: new FakeFsBaidu(connection, "/apps/test"),
    connection,
    entries,
    requests,
    setBeforeResponse: (fn: () => void) => {
      beforeResponse = fn;
    },
    setSaveGate: (fn: () => Promise<void>) => {
      saveGate = fn;
    },
    switchAccount: () => {
      config = {
        ...config,
        tokens: {
          ...config.tokens,
          accessToken: "other",
          refreshToken: "other-refresh",
        },
      };
    },
    failScan: () => {
      failScan = true;
    },
    failDelete: () => {
      deleteFailure = true;
    },
    binaryCalls: () => binaryCalls,
  };
}
describe("Baidu filesystem adapter", () => {
  it("maps recursive scan metadata to sync entities with relative directory keys", async () => {
    const f = fixture();
    assert.deepEqual(await f.fs.walk(), [
      {
        key: "中文.txt",
        keyRaw: "中文.txt",
        size: 3,
        sizeRaw: 3,
        mtimeCli: 20000,
        mtimeSvr: 20000,
        ctimeCli: 10000,
      },
      {
        key: "目录/",
        keyRaw: "目录/",
        size: 0,
        sizeRaw: 0,
        mtimeCli: 15000,
        mtimeSvr: 15000,
        ctimeCli: 10000,
      },
    ]);
  });
  it("does not return a partial or empty scan after a remote error", async () => {
    const f = fixture();
    f.failScan();
    await assert.rejects(f.fs.walk());
  });
  it("looks up stat in the exact parent and rejects missing or wrongly typed paths", async () => {
    const f = fixture();
    assert.equal((await f.fs.stat("中文.txt")).sizeRaw, 3);
    assert.equal(f.requests.at(-1)!.searchParams.get("dir"), "/apps/test");
    await assert.rejects(f.fs.stat("missing"), /not_found/);
    await assert.rejects(f.fs.stat("目录"), /type_mismatch/);
    await assert.rejects(f.fs.stat("中文.txt/"), /type_mismatch/);
  });
  it("downloads by a freshly looked-up path without requiring a previous walk", async () => {
    const f = fixture();
    assert.deepEqual(
      new Uint8Array(await f.fs.readFile("中文.txt")),
      new Uint8Array([1, 2, 3])
    );
    assert.equal(f.binaryCalls(), 1);
  });
  it("rejects folders and absent paths before binary download", async () => {
    const f = fixture();
    await assert.rejects(f.fs.readFile("目录/"));
    await assert.rejects(f.fs.readFile("missing"));
    assert.equal(f.binaryCalls(), 0);
  });
  it("rejects account changes after lookup before downloading a stale file ID", async () => {
    const f = fixture();
    f.setBeforeResponse(f.switchAccount);
    await assert.rejects(f.fs.readFile("中文.txt"), /account_changed/);
    assert.equal(f.binaryCalls(), 0);
  });
  it("queues simultaneous operations instead of failing the connection busy guard", async () => {
    const f = fixture();
    const result = await Promise.all([
      f.fs.walkPartial(),
      f.fs.stat("中文.txt"),
      f.fs.readFile("中文.txt"),
    ]);
    assert.equal(result[0].length, 2);
    assert.equal(result[1].sizeRaw, 3);
    assert.equal(result[2].byteLength, 3);
  });
  it("refreshes once while all queued operations continue on the same account", async () => {
    const f = fixture(true);
    const results = await Promise.all([
      f.fs.stat("中文.txt"),
      f.fs.walk(),
      f.fs.readFile("中文.txt"),
    ]);
    assert.equal(results[0].sizeRaw, 3);
    assert.equal(results[1].length, 2);
    assert.equal(results[2].byteLength, 3);
    assert.equal(
      f.requests.filter((url) => url.hostname === "openapi.baidu.com").length,
      1
    );
  });
  it("accepts new queued operations while an internal token save is pending", async () => {
    const f = fixture(true);
    let started!: () => void;
    const saving = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setSaveGate(async () => {
      started();
      await gate;
    });
    const first = f.fs.stat("中文.txt");
    await saving;
    const second = f.fs.stat("目录/");
    release();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].sizeRaw, 3);
    assert.equal(results[1].keyRaw, "目录/");
    assert.equal((await f.fs.walk()).length, 2);
  });
  it("rejects an external account import during a pending internal token save", async () => {
    const f = fixture(true);
    let started!: () => void;
    const saving = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setSaveGate(async () => {
      started();
      await gate;
    });
    const first = f.fs.stat("中文.txt");
    await saving;
    f.switchAccount();
    const deletion = f.fs.rm("中文.txt");
    release();
    await assert.rejects(first);
    await assert.rejects(deletion, /account_changed/);
    assert.equal(
      f.requests.some(
        (url) => url.searchParams.get("method") === "filemanager"
      ),
      false
    );
  });
  it("binds the adapter to its original account across separate operations", async () => {
    const f = fixture();
    await f.fs.walk();
    f.switchAccount();
    const before = f.requests.length;
    await assert.rejects(f.fs.rm("中文.txt"), /account_changed/);
    assert.equal(f.requests.length, before);
    assert.equal(
      (await new FakeFsBaidu(f.connection, "/apps/test").stat("中文.txt"))
        .sizeRaw,
      3
    );
  });
  it("rejects queued deletion if the account changes before it starts", async () => {
    const f = fixture();
    const read = f.fs.stat("中文.txt");
    const deletion = f.fs.rm("中文.txt");
    f.switchAccount();
    await assert.rejects(read, /account_changed/);
    await assert.rejects(deletion, /account_changed/);
    assert.equal(f.requests.length, 0);
  });
  it("does not download after an account change during metadata retrieval", async () => {
    const f = fixture();
    f.setBeforeResponse(() => {
      if (f.requests.at(-1)?.searchParams.get("method") === "filemetas")
        f.switchAccount();
    });
    await assert.rejects(f.fs.readFile("中文.txt"));
    assert.equal(f.binaryCalls(), 0);
  });
  it("marks a committed write with unverified metadata as unknown and never retries it", async () => {
    const f = fixture();
    f.setBeforeResponse(() => {
      if (f.entries.length > 2) f.entries.pop();
    });
    await assert.rejects(
      f.fs.writeFile(
        "新文件.txt",
        new Uint8Array([1, 2, 3]).buffer,
        20000,
        10000
      ),
      (error: any) =>
        error.code === "mutation_verification_failed" &&
        error.outcomeUnknown === true
    );
    assert.equal(
      f.requests.filter((url) => url.searchParams.get("method") === "precreate")
        .length,
      1
    );
  });
  it("continues the queue after a failed operation", async () => {
    const f = fixture();
    const failed = f.fs.stat("missing");
    const next = f.fs.stat("中文.txt");
    await assert.rejects(failed);
    assert.equal((await next).sizeRaw, 3);
  });
  it("creates a directory and returns verified server metadata", async () => {
    const f = fixture();
    assert.deepEqual(await f.fs.mkdir("新目录/"), {
      key: "新目录/",
      keyRaw: "新目录/",
      size: 0,
      sizeRaw: 0,
      mtimeCli: 30000,
      mtimeSvr: 30000,
      ctimeCli: 30000,
    });
  });
  it("writes within the configured root and returns verified metadata", async () => {
    const f = fixture();
    const entity = await f.fs.writeFile(
      "新文件.txt",
      new Uint8Array([1, 2, 3]).buffer,
      20000,
      10000
    );
    assert.equal(entity.keyRaw, "新文件.txt");
    assert.equal(entity.sizeRaw, 3);
    assert.equal(f.entries.at(-1).path, "/apps/test/新文件.txt");
  });
  it("propagates target-item deletion failure", async () => {
    const f = fixture();
    f.failDelete();
    await assert.rejects(f.fs.rm("中文.txt"), /item_error/);
  });
  it("checks connectivity using reads without creating or deleting test files", async () => {
    const f = fixture();
    assert.equal(await f.fs.checkConnect(), true);
    assert.equal(
      f.requests.every((url) => url.searchParams.get("method") === "list"),
      true
    );
    f.failScan();
    let failure: unknown;
    assert.equal(
      await f.fs.checkConnect((error: unknown) => {
        failure = error;
      }),
      false
    );
    assert.ok(failure);
  });
  it("does not emulate unsupported rename using destructive copy and delete", async () => {
    const f = fixture();
    await assert.rejects(
      f.fs.rename("中文.txt", "other.txt"),
      /rename_unsupported/
    );
    assert.equal(f.requests.length, 0);
  });
  for (const key of [
    "",
    "/中文.txt",
    "../中文.txt",
    "a//b",
    "a/./b",
    "a\u0000b",
    "bad\ud800",
  ])
    it(`rejects invalid keys before requests: ${JSON.stringify(key)}`, async () => {
      const f = fixture();
      for (const action of [
        () => f.fs.stat(key),
        () => f.fs.readFile(key),
        () => f.fs.rm(key),
        () => f.fs.writeFile(key, new ArrayBuffer(3), 1, 1),
      ])
        await assert.rejects(action(), /invalid_path/);
      assert.equal(f.requests.length, 0);
    });
  it("rejects an account-wide or malformed remote root before scanning", async () => {
    const f = fixture();
    for (const root of [
      "/",
      "relative",
      "/apps//test",
      "/apps/../test",
      "/apps/bad\ud800",
    ])
      assert.throws(() => new FakeFsBaidu(f.connection, root));
    assert.equal(f.requests.length, 0);
  });
});
