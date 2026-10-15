const assert = require("node:assert/strict");
const { test } = require("node:test");
const { startDav, loadAdapter } = require("./support/harness.cjs");
const { FakeFsWebdav, DEFAULT_WEBDAV_CONFIG } = loadAdapter();
const bytes = new TextEncoder().encode("fallback content").buffer;
async function setup(t) {
  const server = await startDav();
  t.after(() => server.close());
  const remote = new FakeFsWebdav(
    { ...DEFAULT_WEBDAV_CONFIG, address: server.url, remoteBaseDir: "vault" },
    "vault",
    async () => {}
  );
  return { server, remote };
}
for (const status of [405, 501]) {
  test(`OPTIONS ${status} allows ordinary CRUD and probes only once`, async (t) => {
    const { server, remote } = await setup(t);
    server.fail({ method: "OPTIONS", path: "/vault", status });
    await remote.writeFile("note.md", bytes, 0, 0);
    assert.deepEqual(await remote.readFile("note.md"), bytes);
    assert.ok((await remote.walk()).some((entry) => entry.key === "note.md"));
    await remote.rm("note.md");
    assert.equal(server.files.has("/vault/note.md"), false);
    assert.equal(remote.isNextcloud, false);
    assert.equal(
      server.requests.filter((r) => r.method === "OPTIONS").length,
      1
    );
  });
  test(`PUT errors still propagate after OPTIONS ${status} fallback`, async (t) => {
    const { server, remote } = await setup(t);
    server.fail({ method: "OPTIONS", path: "/vault", status });
    server.fail({ method: "PUT", path: "/vault/note.md", status: 403 });
    await assert.rejects(
      () => remote.writeFile("note.md", bytes, 0, 0),
      (e) => e.status === 403
    );
  });
}
for (const status of [401, 403, 404, 429, 500, 503]) {
  test(`OPTIONS ${status} remains an error on repeated operations`, async (t) => {
    const { server, remote } = await setup(t);
    server.fail({ method: "OPTIONS", path: "/vault", status });
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        () => remote.writeFile("note.md", bytes, 0, 0),
        (e) => e.status === status
      );
    assert.ok(!server.requests.some((r) => r.method === "PUT"));
    assert.equal(
      server.requests.filter((r) => r.method === "OPTIONS").length,
      [429,500,503].includes(status) ? 6 : 2
    );
  });
}
test("OPTIONS connection loss fails, then the next operation retries", async (t) => {
  const { server, remote } = await setup(t);
  for(let i=0;i<3;i++) server.fail({
    method: "OPTIONS",
    path: "/vault",
    disconnect: true,
    once: true,
  });
  await assert.rejects(() => remote.writeFile("note.md", bytes, 0, 0));
  assert.ok(!server.requests.some((r) => r.method === "PUT"));
  await remote.writeFile("note.md", bytes, 0, 0);
  assert.deepEqual(await remote.readFile("note.md"), bytes);
});
