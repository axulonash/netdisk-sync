const assert = require("node:assert/strict");
const { test } = require("node:test");
const { startDav, loadAdapter } = require("./support/harness.cjs");

const { FakeFsWebdav, DEFAULT_WEBDAV_CONFIG } = loadAdapter();
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
function bytes(text) {
  return new TextEncoder().encode(text).buffer;
}

test(
  "connection check performs real CRUD and removes temporary files",
  { timeout: 10000 },
  async (t) => {
    const { remote, server } = await setup(t);
    assert.equal(await remote.checkConnect(), true);
    assert.deepEqual([...server.files.keys()], ["/", "/vault"]);
    for (const method of [
      "PROPFIND",
      "OPTIONS",
      "MKCOL",
      "PUT",
      "GET",
      "DELETE",
    ]) {
      assert.ok(
        server.requests.some((request) => request.method === method),
        method
      );
    }
  }
);

test(
  "Unicode, spaces, hash, literal percent and empty files survive CRUD and MOVE",
  { timeout: 10000 },
  async (t) => {
    const { remote } = await setup(t);
    await remote.mkdir("目录/");
    const original = "目录/中文 🍎 # 100% %20.md";
    const renamed = "目录/重命名 # %.md";
    await remote.writeFile(
      original,
      bytes("正文\nwith binary-safe UTF-8"),
      0,
      0
    );
    assert.equal(
      new TextDecoder().decode(await remote.readFile(original)),
      "正文\nwith binary-safe UTF-8"
    );
    assert.ok((await remote.walk()).some((entity) => entity.key === original));
    await remote.rename(original, renamed);
    assert.equal(
      new TextDecoder().decode(await remote.readFile(renamed)),
      "正文\nwith binary-safe UTF-8"
    );
    await remote.writeFile(renamed, new ArrayBuffer(0), 0, 0);
    assert.equal((await remote.readFile(renamed)).byteLength, 0);
    await remote.rm(renamed);
    assert.deepEqual(
      (await remote.walk()).map((entity) => entity.key),
      ["目录/"]
    );
  }
);

test(
  "deep listing includes nested content and a failed child listing rejects",
  { timeout: 10000 },
  async (t) => {
    const { server, remote } = await setup(t);
    await remote.mkdir("a/");
    await remote.mkdir("a/b/");
    await remote.writeFile("a/b/note.md", bytes("hello"), 0, 0);
    assert.deepEqual((await remote.walk()).map((entity) => entity.key).sort(), [
      "a/",
      "a/b/",
      "a/b/note.md",
    ]);
    server.fail({ method: "PROPFIND", path: "/vault/a/b", status: 503 });
    await assert.rejects(
      () => remote.walk(),
      (error) => error.status === 503
    );
  }
);

for (const status of [401, 403, 409, 414, 429, 500, 503, 507]) {
  test(
    `PUT ${status} is reported as a failure and preserves the fixture's old content`,
    { timeout: 10000 },
    async (t) => {
      const { server, remote } = await setup(t);
      await remote.writeFile("note.md", bytes("old"), 0, 0);
      server.fail({ method: "PUT", path: "/vault/note.md", status });
      await assert.rejects(
        () => remote.writeFile("note.md", bytes("new"), 0, 0),
        (error) => error.status === status
      );
      assert.equal(
        new TextDecoder().decode(await remote.readFile("note.md")),
        "old"
      );
    }
  );
}

test(
  "single-component byte limit rejects a name without silently truncating it",
  { timeout: 10000 },
  async (t) => {
    const { server, remote } = await setup(t, { maxNameBytes: 80 });
    await remote.writeFile(`${"中".repeat(25)}.md`, bytes("ok"), 0, 0);
    await assert.rejects(
      () => remote.writeFile(`${"中".repeat(26)}.md`, bytes("no"), 0, 0),
      (error) => error.status === 403
    );
    assert.equal(server.files.size, 3);
  }
);

test(
  "request URL length limit propagates independently of component length",
  { timeout: 10000 },
  async (t) => {
    const { remote } = await setup(t, { maxUrlBytes: 100 });
    await remote.mkdir(`${"a".repeat(40)}/`);
    await remote.mkdir(`${"a".repeat(40)}/${"b".repeat(40)}/`);
    await assert.rejects(
      () =>
        remote.writeFile(
          `${"a".repeat(40)}/${"b".repeat(40)}/${"c".repeat(40)}.md`,
          bytes("long"),
          0,
          0
        ),
      (error) => error.status === 414
    );
  }
);

test(
  "OpenSSL path encryption can exceed the server name limit while the plain path works",
  { timeout: 10000 },
  async (t) => {
    const { remote } = await setup(t, { maxNameBytes: 255 });
    let directory = "";
    for (let level = 0; level < 6; level++) {
      directory += `${"a".repeat(30)}/`;
      await remote.mkdir(directory);
    }
    const original = `${directory}note.md`;
    await remote.writeFile(original, bytes("plain succeeds"), 0, 0);
    assert.equal(
      new TextDecoder().decode(await remote.readFile(original)),
      "plain succeeds"
    );
    const encrypted = await loadAdapter().encryptStringToBase64url(
      original,
      "synthetic-password"
    );
    assert.ok(encrypted.length > 255);
    assert.ok(!encrypted.includes("/"));
    await assert.rejects(
      () => remote.writeFile(encrypted, bytes("encrypted path fails"), 0, 0),
      (error) => error.status === 403
    );
  }
);

test(
  "files at and above 10 MiB use ordinary upload when partial writes are unsupported",
  { timeout: 15000 },
  async (t) => {
    const { remote, server } = await setup(t);
    for (const size of [10 * 1024 * 1024, 10 * 1024 * 1024 + 1]) {
      const content = new Uint8Array(size);
      content[0] = 17;
      content[size - 1] = 239;
      await remote.writeFile("large.bin", content.buffer, 0, 0);
      const actual = new Uint8Array(await remote.readFile("large.bin"));
      assert.equal(actual.length, size);
      assert.equal(actual[0], 17);
      assert.equal(actual[size - 1], 239);
    }
    assert.ok(!server.requests.some((request) => request.method === "PATCH"));
  }
);

for (const directory of ['/home/test', '/home/test/', 'home/test/']) {
  test(`sync directory ${directory} scans and uploads nested files`, async t => {
    const server = await startDav(); t.after(() => server.close());
    server.files.set('/home', {directory:true, body:Buffer.alloc(0)});
    server.files.set('/home/test', {directory:true, body:Buffer.alloc(0)});
    const remote = new FakeFsWebdav({...DEFAULT_WEBDAV_CONFIG,
      address:server.url, remoteBaseDir:directory}, 'vault', async()=>{});
    assert.deepEqual(await remote.walk(), []);
    await remote.mkdir('test/');
    await remote.writeFile('test/note.md', bytes('local contents'), 10000, 10000);
    assert.equal(server.files.get('/home/test/test/note.md')?.body.toString(), 'local contents');
    assert.deepEqual((await remote.walk()).map(e=>e.key).sort(), ['test/', 'test/note.md']);
    assert.equal(new TextDecoder().decode(await remote.readFile('test/note.md')), 'local contents');
  });
}

test('stop during the root existence request does not create a new directory afterwards',async t=>{
 const server=await startDav();t.after(()=>server.close());
 const {SyncControl}=loadAdapter();const control=new SyncControl();
 const remote=new FakeFsWebdav({...DEFAULT_WEBDAV_CONFIG,address:server.url,remoteBaseDir:'vault'},'vault',async()=>{});
 remote.beforeOperation=()=>control.checkpoint();
 const gate=server.hold('PROPFIND','/vault');
 const walking=remote.walk();const result=walking.catch(error=>error);
 await gate.entered;control.stop();gate.release();await result;
 assert.equal(server.files.has('/vault'),false);
});
