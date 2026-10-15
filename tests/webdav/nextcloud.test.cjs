const assert = require("node:assert/strict");
const { test } = require("node:test");
const { startDav, loadAdapter } = require("./support/harness.cjs");
const { FakeFsWebdav, DEFAULT_WEBDAV_CONFIG } = loadAdapter();
const root = "/remote.php/dav/files/user";
const payload = (value) => {
  const content = new Uint8Array(10 * 1024 * 1024 + 7);
  for (let i = 0; i < content.length; i++)
    content[i] = (value + Math.floor(i / (5 * 1024 * 1024)) + (i % 251)) % 256;
  return content.buffer;
};
async function setup(t, slash = "", user = "user") {
  const root = `/remote.php/dav/files/${user}`;
  const server = await startDav({ nextcloud: true, nextcloudUser: user });
  t.after(() => server.close());
  for (const dir of [
    root,
    `${root}/vault`,
    `${root}/vault/a`,
    `${root}/vault/b`,
  ])
    server.files.set(dir, { directory: true, body: Buffer.alloc(0) });
  const remote = new FakeFsWebdav(
    {
      ...DEFAULT_WEBDAV_CONFIG,
      address: `${server.url}/remote.php/dav/files/${encodeURIComponent(user)}${slash}`,
      remoteBaseDir: "vault",
      username: "user",
      password: "fixture-password",
      customHeaders: "X-Test-Required: fixture",
    },
    "vault",
    async () => {}
  );
  return { server, remote };
}
for (const slash of ["", "/"]) {
  test(`Nextcloud detection and chunk assembly with trailing slash '${slash}'`, async (t) => {
    const { server, remote } = await setup(t, slash);
    const content = payload(37);
    const key = "a/中文 # ? % %20.bin";
    await remote.writeFile(key, content, 0, 0);
    assert.equal(remote.isNextcloud, true);
    assert.deepEqual(await remote.readFile(key), content);
    const puts = server.requests.filter((r) => r.method === "PUT");
    assert.deepEqual(
      puts.map((r) => r.bodyBytes),
      [5 * 1024 * 1024, 5 * 1024 * 1024, 7]
    );
    assert.ok(
      puts.every((r) => r.path.startsWith("/remote.php/dav/uploads/user/"))
    );
    assert.equal(server.uploads.size, 0);
    assert.ok(
      server.requests
        .filter((r) => r.destination)
        .every((r) => r.destination === `${root}/vault/${key}`)
    );
  });
}
test("concurrent equal basenames use distinct upload sessions", async (t) => {
  const { server, remote } = await setup(t);
  const a = payload(11),
    b = payload(22);
  await Promise.all([
    remote.writeFile("a/same.bin", a, 0, 0),
    remote.writeFile("b/same.bin", b, 0, 0),
  ]);
  assert.deepEqual(await remote.readFile("a/same.bin"), a);
  assert.deepEqual(await remote.readFile("b/same.bin"), b);
  const sessions = server.requests.filter(
    (r) => r.method === "MKCOL" && r.path.includes("/uploads/")
  );
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].path, sessions[1].path);
});
for (const method of ["MKCOL", "PUT", "MOVE"]) {
  test(`${method} failure preserves target before commit and retry uses fresh session`, async (t) => {
    const { server, remote } = await setup(t);
    const key = "a/retry.bin";
    server.files.set(`${root}/vault/${key}`, {
      directory: false,
      body: Buffer.from("old"),
    });
    server.fail({ method, status: 503, once: true });
    await assert.rejects(
      () => remote.writeFile(key, payload(55), 0, 0),
      (e) => e.status === 503
    );
    assert.equal(
      server.files.get(`${root}/vault/${key}`).body.toString(),
      "old"
    );
    assert.equal(
      server.uploads.size,
      0,
      "failed upload session should be cleaned up"
    );
    await remote.writeFile(key, payload(66), 0, 0);
    assert.deepEqual(await remote.readFile(key), payload(66));
    const sessions = server.requests.filter(
      (r) => r.method === "MKCOL" && r.path.includes("/uploads/")
    );
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0].path, sessions[1].path);
  });
}

test("encoded user path is preserved with a trailing slash", async (t) => {
  const { server, remote } = await setup(t, "/", "用户 name");
  await remote.writeFile("a/name.bin", payload(44), 0, 0);
  assert.equal(remote.isNextcloud, true);
  assert.deepEqual(await remote.readFile("a/name.bin"), payload(44));
  assert.equal(server.uploads.size, 0);
});
test("two adapter instances uploading the same target use independent sessions", async (t) => {
  const { server, remote } = await setup(t);
  const other = new FakeFsWebdav(remote.webdavConfig, "vault", async () => {});
  await Promise.all([
    remote.writeFile("a/same.bin", payload(31), 0, 0),
    other.writeFile("a/same.bin", payload(32), 0, 0),
  ]);
  const final = new Uint8Array(await remote.readFile("a/same.bin"));
  assert.ok(
    Buffer.from(final).equals(Buffer.from(payload(31))) ||
      Buffer.from(final).equals(Buffer.from(payload(32)))
  );
  const sessions = server.requests.filter((r) => r.method === "MKCOL");
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].path, sessions[1].path);
});
test("cleanup failure preserves original upload error and retry uses a new session", async (t) => {
  const { server, remote } = await setup(t);
  server.fail({ method: "PUT", status: 507, once: true });
  server.fail({ method: "DELETE", status: 503, once: true });
  await assert.rejects(
    () => remote.writeFile("a/retry.bin", payload(71), 0, 0),
    (e) => e.status === 507
  );
  assert.equal(server.requests.filter((r) => r.method === "DELETE").length, 1);
  await remote.writeFile("a/retry.bin", payload(72), 0, 0);
  assert.deepEqual(await remote.readFile("a/retry.bin"), payload(72));
});
