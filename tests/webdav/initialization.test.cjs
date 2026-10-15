const assert = require("node:assert/strict");
const { test } = require("node:test");
const { startDav, loadAdapter } = require("./support/harness.cjs");
const { FakeFsWebdav, DEFAULT_WEBDAV_CONFIG } = loadAdapter();
const bytes = (text) => new TextEncoder().encode(text).buffer;
async function setup(t, settings = {}, save = async () => {}) {
  const server = await startDav();
  t.after(() => server.close());
  const remote = new FakeFsWebdav(
    {
      ...DEFAULT_WEBDAV_CONFIG,
      address: server.url,
      remoteBaseDir: "vault",
      ...settings,
    },
    "vault",
    save
  );
  return { server, remote };
}
const count = (server, method) =>
  server.requests.filter(
    (request) => request.method === method && request.path === "/vault"
  ).length;
const observe = (promise) =>
  promise.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error })
  );

for (const method of ["PROPFIND", "MKCOL", "OPTIONS"]) {
  test(
    `initialization retries after ${method} fails instead of using a half-ready client`,
    { timeout: 10000 },
    async (t) => {
      const { server, remote } = await setup(t);
      for(let i=0;i<(method === "MKCOL" ? 1 : 3);i++)
        server.fail({ method, path: "/vault", status: 503, once: true });
      await assert.rejects(
        () => remote.writeFile("note.md", bytes("first"), 0, 0),
        (error) => error.status === 503
      );
      await remote.writeFile("note.md", bytes("recovered"), 0, 0);
      assert.equal(
        new TextDecoder().decode(await remote.readFile("note.md")),
        "recovered"
      );
      assert.equal(count(server, method), method === "MKCOL" ? 2 : 4);
      assert.equal(
        count(server, "PROPFIND"),
        method === "PROPFIND" ? 4 : 2,
        "a failed initialization must recheck its root"
      );
    }
  );

  test(
    `concurrent initialization waits for the ${method} response`,
    { timeout: 10000 },
    async (t) => {
      const { server, remote } = await setup(t);
      const gate = server.hold(method, "/vault");
      const first = observe(remote._init());
      try {
        await gate.entered;
        let secondSettled = false;
        const second = observe(remote._init()).then((result) => {
          secondSettled = true;
          return result;
        });
        // Microtask-only checkpoint: a ready promise settles here; a gated HTTP
        // initialization cannot. No sleep or timing-dependent network assertion.
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(
          secondSettled,
          false,
          "initialization returned before its HTTP phase finished"
        );
        gate.release();
        assert.deepEqual(await first, { ok: true });
        assert.deepEqual(await second, { ok: true });
        await remote.writeFile("note.md", bytes("ready"), 0, 0);
        assert.equal(
          new TextDecoder().decode(await remote.readFile("note.md")),
          "ready"
        );
        assert.equal(count(server, "PROPFIND"), 1);
        assert.equal(count(server, "MKCOL"), 1);
        assert.equal(count(server, "OPTIONS"), 1);
      } finally {
        gate.release();
        await first;
      }
    }
  );
}

test(
  "all concurrent waiters see the failed initialization; a later call can retry",
  { timeout: 10000 },
  async (t) => {
    const { server, remote } = await setup(t);
    const gate = server.hold("PROPFIND", "/vault", { status: 503 });
    for(let i=0;i<2;i++) server.fail({method:"PROPFIND",path:"/vault",status:503,once:true});
    const first = observe(remote._init());
    try {
      await gate.entered;
      const second = observe(remote._init());
      gate.release();
      const results = await Promise.all([first, second]);
      assert.ok(
        results.every((result) => !result.ok && result.error.status === 503)
      );
      await remote.writeFile("note.md", bytes("retry"), 0, 0);
      assert.equal(
        new TextDecoder().decode(await remote.readFile("note.md")),
        "retry"
      );
      assert.equal(count(server, "PROPFIND"), 4);
    } finally {
      gate.release();
      await first;
    }
  }
);

test(
  "a burst of writes shares root creation and capability detection",
  { timeout: 10000 },
  async (t) => {
    const { server, remote } = await setup(t);
    const operations = Array.from({ length: 12 }, (_, i) =>
      remote.writeFile(`note-${i}.md`, bytes(`content-${i}`), 0, 0)
    );
    const results = await Promise.allSettled(operations);
    assert.ok(results.every((result) => result.status === "fulfilled"));
    for (let i = 0; i < 12; i++)
      assert.equal(
        new TextDecoder().decode(await remote.readFile(`note-${i}.md`)),
        `content-${i}`
      );
    assert.equal(count(server, "PROPFIND"), 1);
    assert.equal(count(server, "MKCOL"), 1);
    assert.equal(count(server, "OPTIONS"), 1);
  }
);

test(
  "root connection loss is retried by the next operation",
  { timeout: 10000 },
  async (t) => {
    const { server, remote } = await setup(t);
    for(let i=0;i<3;i++) server.fail({
      method: "PROPFIND",
      path: "/vault",
      disconnect: true,
      once: true,
    });
    await assert.rejects(() =>
      remote.writeFile("note.md", bytes("first"), 0, 0)
    );
    await remote.writeFile("note.md", bytes("retry"), 0, 0);
    assert.equal(
      new TextDecoder().decode(await remote.readFile("note.md")),
      "retry"
    );
  }
);

for (const [method, status] of [
  ["PROPFIND", 403],
  ["OPTIONS", 403],
]) {
  test(
    `persistent ${method} ${status} cannot be bypassed by a second operation`,
    { timeout: 10000 },
    async (t) => {
      const { server, remote } = await setup(t);
      server.fail({ method, path: "/vault", status });
      for (let i = 0; i < 2; i++)
        await assert.rejects(
          () => remote.writeFile("note.md", bytes("blocked"), 0, 0),
          (error) => error.status === status
        );
      assert.equal(count(server, method), 2);
      assert.ok(!server.requests.some((request) => request.method === "PUT"));
    }
  );
}

test(
  "retry rechecks a root removed after capability detection failed",
  { timeout: 10000 },
  async (t) => {
    const { server, remote } = await setup(t);
    for(let i=0;i<3;i++) server.fail({ method: "OPTIONS", path: "/vault", status: 503, once: true });
    await assert.rejects(
      () => remote.writeFile("note.md", bytes("first"), 0, 0),
      (error) => error.status === 503
    );
    server.files.delete("/vault");
    await remote.writeFile("note.md", bytes("retry"), 0, 0);
    assert.equal(
      new TextDecoder().decode(await remote.readFile("note.md")),
      "retry"
    );
    assert.equal(count(server, "MKCOL"), 2);
  }
);

test(
  "failed depth-setting save is retried before declaring initialization ready",
  { timeout: 10000 },
  async (t) => {
    let saves = 0;
    const { server, remote } = await setup(
      t,
      { depth: "auto", manualRecursive: false },
      async () => {
        saves++;
        if (saves === 1) throw new Error("settings save failed");
      }
    );
    await assert.rejects(
      () => remote.writeFile("note.md", bytes("first"), 0, 0),
      /settings save failed/
    );
    assert.ok(!server.requests.some((request) => request.method === "PUT"));
    await remote.writeFile("note.md", bytes("retry"), 0, 0);
    assert.equal(saves, 2);
    assert.equal(remote.webdavConfig.depth, "manual_1");
    assert.equal(remote.webdavConfig.manualRecursive, true);
    assert.equal(
      new TextDecoder().decode(await remote.readFile("note.md")),
      "retry"
    );
  }
);
