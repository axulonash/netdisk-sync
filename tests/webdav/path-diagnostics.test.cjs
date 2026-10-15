const assert = require("node:assert/strict");
const { test } = require("node:test");
const { startDav, loadAdapter } = require("./support/harness.cjs");
const { FakeFsWebdav, DEFAULT_WEBDAV_CONFIG, encryptStringToBase64url } =
  loadAdapter();
async function setup(t, options = {}) {
  const server = await startDav(options);
  t.after(() => server.close());
  const remote = new FakeFsWebdav(
    { ...DEFAULT_WEBDAV_CONFIG, address: server.url, remoteBaseDir: "vault" },
    "vault",
    async () => {}
  );
  return { server, remote };
}
const bytes = new Uint8Array([1, 2, 3]).buffer;
for (const name of [
  "a".repeat(90),
  "中".repeat(30),
  "😀".repeat(23),
  "secret # ? %20.md",
]) {
  test(`failed upload reports numeric metrics for ${name.length} UTF-16 units without adding names`, async (t) => {
    const { server, remote } = await setup(t);
    server.fail({ method: "PUT", path: `/vault/${name}`, status: 403 });
    await assert.rejects(
      () => remote.writeFile(name, bytes, 0, 0),
      (error) => {
        assert.equal(error.status, 403);
        const d = error.webdavPathDiagnostics;
        assert.equal(d.operation, "write");
        assert.equal(d.pathCodePoints, [...`/vault/${name}`].length);
        assert.equal(d.pathUtf8Bytes, Buffer.byteLength(`/vault/${name}`));
        assert.equal(
          d.maxSegmentUtf8Bytes,
          Math.max(5, Buffer.byteLength(name))
        );
        assert.equal(
          d.encodedPathBytes,
          Buffer.byteLength(`/vault/${encodeURIComponent(name)}`)
        );
        assert.ok(error.message.includes("WebDAV path metrics"));
        assert.ok(!error.message.includes(name));
        assert.ok(!error.message.includes("too long"));
        assert.ok(!JSON.stringify(d).includes(name));
        return true;
      }
    );
  });
}
test("OpenSSL diagnostics measure the actual encrypted name instead of plaintext", async (t) => {
  const { remote } = await setup(t, { maxNameBytes: 255 });
  const original = Array(6).fill("a".repeat(30)).join("/") + "/note.md";
  const encrypted = await encryptStringToBase64url(
    original,
    "fixture-password"
  );
  await assert.rejects(
    () => remote.writeFile(encrypted, bytes, 0, 0),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(
        error.webdavPathDiagnostics.maxSegmentUtf8Bytes,
        Buffer.byteLength(encrypted)
      );
      assert.ok(error.webdavPathDiagnostics.maxSegmentUtf8Bytes > 255);
      return true;
    }
  );
});
test("deep path URI rejection reports segments separately from total length", async (t) => {
  const { remote } = await setup(t, { maxUrlBytes: 100 });
  const a = "a".repeat(40),
    b = "b".repeat(40);
  await remote.mkdir(`${a}/`);
  await remote.mkdir(`${a}/${b}/`);
  await assert.rejects(
    () => remote.writeFile(`${a}/${b}/${"c".repeat(40)}.md`, bytes, 0, 0),
    (error) => {
      assert.equal(error.status, 414);
      assert.equal(error.webdavPathDiagnostics.maxSegmentUtf8Bytes, 43);
      assert.ok(error.webdavPathDiagnostics.encodedPathBytes > 100);
      return true;
    }
  );
});
test("long names are not preemptively rejected when the server accepts them", async (t) => {
  const { remote } = await setup(t);
  const name = "x".repeat(300);
  await remote.writeFile(name, bytes, 0, 0);
  assert.deepEqual(await remote.readFile(name), bytes);
});
for (const status of [401, 429, 503]) {
  test(`short-path HTTP ${status} keeps its original status and neutral explanation`, async (t) => {
    const { server, remote } = await setup(t);
    server.fail({ method: "PUT", path: "/vault/note.md", status });
    await assert.rejects(
      () => remote.writeFile("note.md", bytes, 0, 0),
      (error) => {
        assert.equal(error.status, status);
        assert.equal(error.webdavPathDiagnostics.maxSegmentUtf8Bytes, 7);
        assert.ok(!error.message.includes("too long"));
        return true;
      }
    );
  });
}
test("initialization failure is not annotated with an unrelated file path", async (t) => {
  const { server, remote } = await setup(t);
  server.fail({ method: "OPTIONS", path: "/vault", status: 503 });
  await assert.rejects(
    () => remote.writeFile("x".repeat(300), bytes, 0, 0),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.webdavPathDiagnostics, undefined);
      return true;
    }
  );
});
test("diagnostic enrichment preserves error identity and never masks unusual errors", () => {
  const { addWebdavPathDiagnostics } = loadAdapter();
  const error = Object.assign(new Error("original"), { status: 403 });
  assert.equal(addWebdavPathDiagnostics(error, "/vault/a.md", "write"), error);
  const first = error.message;
  addWebdavPathDiagnostics(error, "/vault/a.md", "write");
  assert.equal(error.message, first);
  for (const value of [
    Object.freeze(new Error("frozen")),
    "plain rejection",
    null,
  ])
    assert.equal(
      addWebdavPathDiagnostics(value, "/vault/a.md", "write"),
      value
    );
  const invalid = new Error("encoding error");
  assert.equal(
    addWebdavPathDiagnostics(invalid, "/vault/\ud800", "write"),
    invalid
  );
  assert.equal(invalid.message, "encoding error");
});
