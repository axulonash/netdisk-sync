import { strict as assert } from "assert";
import { createHash } from "crypto";
import {
  BaiduUploadClient,
  BaiduUploadError,
  BAIDU_UPLOAD_PART_BYTES,
  type BaiduUploadRequest,
} from "../../src/native/baiduUpload";
const md5 = (data: Uint8Array) => createHash("md5").update(data).digest("hex");
const bytes = new Uint8Array([0, 37, 255, 12]);
const path = "/apps/test/中文 #&%.md";
const file = (data = bytes.buffer) => ({
  path,
  data,
  overwrite: true,
  mtimeMs: 1700000000123,
  ctimeMs: 1690000000456,
});
const created = (size = 4, extra = {}) => ({
  errno: 0,
  fs_id: "9007199254740993",
  path,
  size,
  isdir: 0,
  ...extra,
});
const prepared = (indices = [0]) => ({
  errno: 0,
  return_type: 1,
  uploadid: "fixture-upload",
  block_list: indices,
});
const response = (json: unknown, status = 200) => ({ status, json });
const multipartBytes = (request: BaiduUploadRequest) => {
  assert.ok(request.body instanceof ArrayBuffer);
  const body = new Uint8Array(request.body);
  const text = new TextDecoder().decode(body);
  const start = text.indexOf("\r\n\r\n") + 4;
  const boundary = request.headers["Content-Type"].split("boundary=")[1];
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  return body.slice(start, body.length - tail.length);
};
describe("Baidu upload protocol", () => {
  it("uploads a binary part and commits the exact path, hashes, size and timestamps", async () => {
    const requests: BaiduUploadRequest[] = [];
    const client = new BaiduUploadClient(
      async (request) => {
        requests.push(request);
        const url = new URL(request.url);
        assert.equal(request.method, "POST");
        assert.equal(request.redirect, "manual");
        assert.equal(url.searchParams.get("access_token"), "fixture-token");
        if (url.searchParams.get("method") === "upload") {
          assert.equal(url.origin, "https://d.pcs.baidu.com");
          assert.equal(url.searchParams.get("path"), path);
          assert.equal(url.searchParams.get("partseq"), "0");
          assert.deepEqual(multipartBytes(request), bytes);
          return response({ md5: md5(bytes) });
        }
        const form = new URLSearchParams(request.body as string);
        assert.equal(form.get("path"), path);
        assert.equal(form.get("rtype"), "3");
        assert.equal(form.get("size"), "4");
        assert.equal(form.get("local_mtime"), "1700000000");
        assert.equal(form.get("local_ctime"), "1690000000");
        assert.deepEqual(JSON.parse(form.get("block_list")!), [md5(bytes)]);
        return response(
          url.searchParams.get("method") === "precreate"
            ? prepared()
            : created()
        );
      },
      async () => "fixture-token"
    );
    const result = await client.writeFile(file());
    assert.equal(result.fsId, "9007199254740993");
    assert.equal(result.remotePath, path);
    assert.equal(result.size, 4);
    assert.deepEqual(
      requests.map((r) => new URL(r.url).searchParams.get("method")),
      ["precreate", "upload", "create"]
    );
  });
  it("uses 4 MiB blocks and uploads only the indices requested by precreate", async () => {
    const content = new Uint8Array(BAIDU_UPLOAD_PART_BYTES + 3);
    content.fill(2);
    content.set([0, 255, 7], BAIDU_UPLOAD_PART_BYTES);
    const stages: string[] = [];
    const client = new BaiduUploadClient(
      async (request) => {
        const method = new URL(request.url).searchParams.get("method")!;
        stages.push(method);
        if (method === "precreate") {
          assert.deepEqual(
            JSON.parse(
              new URLSearchParams(request.body as string).get("block_list")!
            ),
            [
              md5(content.slice(0, BAIDU_UPLOAD_PART_BYTES)),
              md5(content.slice(BAIDU_UPLOAD_PART_BYTES)),
            ]
          );
          return response(prepared([1]));
        }
        if (method === "upload") {
          assert.equal(new URL(request.url).searchParams.get("partseq"), "1");
          assert.deepEqual(
            multipartBytes(request),
            new Uint8Array([0, 255, 7])
          );
          return response({ md5: md5(content.slice(BAIDU_UPLOAD_PART_BYTES)) });
        }
        return response(created(content.byteLength));
      },
      async () => "token"
    );
    await client.writeFile(file(content.buffer));
    assert.deepEqual(stages, ["precreate", "upload", "create"]);
  });
  it("still commits when all blocks already exist", async () => {
    const methods: string[] = [];
    const client = new BaiduUploadClient(
      async (request) => {
        const method = new URL(request.url).searchParams.get("method")!;
        methods.push(method);
        return response(method === "precreate" ? prepared([]) : created());
      },
      async () => "token"
    );
    await client.writeFile(file());
    assert.deepEqual(methods, ["precreate", "create"]);
  });
  it("validates metadata when precreate reports a rapid upload", async () => {
    let calls = 0;
    const client = new BaiduUploadClient(
      async () => {
        calls++;
        return response({ ...created(), return_type: 2 });
      },
      async () => "token"
    );
    assert.equal((await client.writeFile(file())).fsId, "9007199254740993");
    assert.equal(calls, 1);
  });
  it("does not implicitly permit an overwrite", async () => {
    const client = new BaiduUploadClient(
      async (request) => {
        assert.equal(
          new URLSearchParams(request.body as string).get("rtype"),
          "0"
        );
        return response({ ...created(), return_type: 2 });
      },
      async () => "token"
    );
    await client.writeFile({ ...file(), overwrite: false });
  });
  for (const invalidPath of [
    "relative.md",
    "/",
    "/notes/",
    "/notes//file",
    "/notes/../file",
    "/notes/./file",
    "/notes/\u0000file",
    "/notes/\ud800.md",
    "/notes/\udc00.md",
  ]) {
    it(`rejects unsafe paths before authentication or network access (${JSON.stringify(invalidPath)})`, async () => {
      let calls = 0;
      const client = new BaiduUploadClient(
        async () => {
          calls++;
          throw new Error();
        },
        async () => {
          calls++;
          return "token";
        }
      );
      await assert.rejects(
        client.writeFile({ ...file(), path: invalidPath }),
        (e: BaiduUploadError) => e.code === "invalid_file"
      );
      assert.equal(calls, 0);
    });
  }
  it("rejects zero byte files explicitly without inventing file content", async () => {
    let calls = 0;
    const client = new BaiduUploadClient(
      async () => {
        calls++;
        throw new Error();
      },
      async () => {
        calls++;
        return "token";
      }
    );
    await assert.rejects(
      client.writeFile(file(new ArrayBuffer(0))),
      (e: BaiduUploadError) => e.code === "empty_file_unsupported"
    );
    assert.equal(calls, 0);
  });
  it("rejects unsafe timestamps and files above 64 MiB before network access", async () => {
    let calls = 0;
    const client = new BaiduUploadClient(
      async () => {
        calls++;
        throw new Error();
      },
      async () => "token"
    );
    for (const [value, code] of [
      [{ ...file(), mtimeMs: NaN }, "invalid_file"],
      [{ ...file(), ctimeMs: -1 }, "invalid_file"],
      [file(new ArrayBuffer(64 * 1024 * 1024 + 1)), "upload_too_large"],
    ] as const)
      await assert.rejects(
        client.writeFile(value),
        (e: BaiduUploadError) => e.code === code
      );
    assert.equal(calls, 0);
  });
  it("rejects invalid upload indices and missing upload IDs without uploading or committing", async () => {
    for (const json of [
      prepared([1]),
      prepared([-1]),
      prepared([0, 0]),
      prepared([0.5]),
      { ...prepared(), uploadid: "" },
      { ...prepared(), block_list: null },
    ]) {
      let calls = 0;
      const client = new BaiduUploadClient(
        async () => {
          calls++;
          return response(json);
        },
        async () => "token"
      );
      await assert.rejects(
        client.writeFile(file()),
        (e: BaiduUploadError) =>
          e.code === "invalid_precreate" && e.outcomeUnknown
      );
      assert.equal(calls, 1);
    }
  });
  it("does not commit after a failed or mismatched part", async () => {
    for (const partResponse of [
      response({ error_code: 31023, error_msg: "fixture-token" }),
      response({ md5: "00000000000000000000000000000000" }),
      response({ md5: md5(bytes) }, 503),
    ]) {
      let calls = 0;
      const client = new BaiduUploadClient(
        async () => {
          calls++;
          return calls === 1 ? response(prepared()) : partResponse;
        },
        async () => "token"
      );
      await assert.rejects(
        client.writeFile(file()),
        (e: BaiduUploadError) =>
          e.stage === "part" &&
          !e.outcomeUnknown &&
          !e.message.includes("fixture-token")
      );
      assert.equal(calls, 2);
    }
  });
  it("reports a lost commit response as unknown and never retries the commit", async () => {
    let calls = 0;
    const client = new BaiduUploadClient(
      async () => {
        calls++;
        if (calls === 1) return response(prepared([]));
        throw new Error("fixture-token");
      },
      async () => "token"
    );
    await assert.rejects(
      client.writeFile(file()),
      (e: BaiduUploadError) =>
        e.stage === "commit" &&
        e.outcomeUnknown &&
        !e.message.includes("fixture-token")
    );
    assert.equal(calls, 2);
  });
  it("does not report renamed, wrong-sized or imprecise-ID commits as success", async () => {
    for (const final of [
      created(4, { path: "/renamed.md" }),
      created(3),
      created(4, { fs_id: 9007199254740992 }),
      created(4, { isdir: 1 }),
    ]) {
      let calls = 0;
      const client = new BaiduUploadClient(
        async () => response(++calls === 1 ? prepared([]) : final),
        async () => "token"
      );
      await assert.rejects(
        client.writeFile(file()),
        (e: BaiduUploadError) => e.stage === "commit" && e.outcomeUnknown
      );
    }
  });
  it("classifies a malformed rapid success as an unknown mutation", async () => {
    const client = new BaiduUploadClient(
      async () => response({ errno: 0, return_type: 2 }),
      async () => "token"
    );
    await assert.rejects(
      client.writeFile(file()),
      (e: BaiduUploadError) => e.outcomeUnknown && e.stage === "prepare"
    );
  });
  it("preserves explicit platform errno without echoing the response", async () => {
    const client = new BaiduUploadClient(
      async () => response({ errno: -8, errmsg: "fixture-token" }),
      async () => "token"
    );
    await assert.rejects(
      client.writeFile(file()),
      (e: BaiduUploadError) =>
        e.errno === -8 &&
        !e.outcomeUnknown &&
        !e.message.includes("fixture-token")
    );
  });
  it("snapshots the bytes before the token callback can modify the source", async () => {
    const source = bytes.slice();
    const client = new BaiduUploadClient(
      async (request) => {
        if (new URL(request.url).searchParams.get("method") === "upload") {
          assert.deepEqual(multipartBytes(request), bytes);
          return response({ md5: md5(bytes) });
        }
        return response(
          new URL(request.url).searchParams.get("method") === "precreate"
            ? prepared()
            : created()
        );
      },
      async () => {
        source.fill(0);
        return "token";
      }
    );
    await client.writeFile(file(source.buffer));
  });
  it("checks the account before each mutation and stops before committing a changed session", async () => {
    let calls = 0;
    const client = new BaiduUploadClient(
      async (request) => {
        calls++;
        return response(
          new URL(request.url).searchParams.get("method") === "precreate"
            ? prepared()
            : { md5: md5(bytes) }
        );
      },
      async () => "token",
      async () => {
        if (calls === 2) throw new Error("fixture-secret");
      }
    );
    await assert.rejects(
      client.writeFile(file()),
      (e: BaiduUploadError) =>
        e.code === "session_changed" && !e.message.includes("fixture-secret")
    );
    assert.equal(calls, 2);
  });
});
