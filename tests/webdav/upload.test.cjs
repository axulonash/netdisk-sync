const assert = require("node:assert/strict");
const { test } = require("node:test");
const { startDav, loadAdapter } = require("./support/harness.cjs");
const {
  FakeFsWebdav,
  DEFAULT_WEBDAV_CONFIG,
  doActualSync,
  upsertPrevSyncRecordByVaultAndProfile,
  getAllPrevSyncRecordsByVaultAndProfile,
} = loadAdapter();
const MiB = 1024 * 1024;
const bytes = (text) => new TextEncoder().encode(text).buffer;
function payload(size) {
  const content = new Uint8Array(size);
  // Every chunk boundary has nonzero content, not just the ends of the file.
  for (let i = 0; i < size; i++) content[i] = i % 251;
  return content.buffer;
}
async function setup(t, protocol) {
  const server = await startDav({
    apachePartial: protocol === "apache",
    sabrePartial: protocol === "sabre",
  });
  t.after(() => server.close());
  const remote = new FakeFsWebdav(
    { ...DEFAULT_WEBDAV_CONFIG, address: server.url, remoteBaseDir: "vault" },
    "vault",
    async () => {}
  );
  await remote.writeFile(
    "attachment.bin",
    bytes("previous complete version"),
    0,
    0
  );
  server.requests.length = 0;
  return { remote, server };
}
function writes(server) {
  return server.requests.filter(
    (request) => request.method === "PUT" || request.method === "PATCH"
  );
}
function assertOneWholeUpload(server, size) {
  assert.deepEqual(writes(server), [
    {
      method: "PUT",
      path: "/vault/attachment.bin",
      bodyBytes: size,
      partial: false,
    },
  ]);
}

for (const protocol of ["apache", "sabre"]) {
  for (const size of [0, 10 * MiB, 10 * MiB + 1]) {
    test(
      `${protocol}: ${size} bytes upload once without an empty pre-write or partial request`,
      { timeout: 15000 },
      async (t) => {
        const { server, remote } = await setup(t, protocol);
        const content = payload(size);
        const entity = await remote.writeFile("attachment.bin", content, 0, 0);
        assert.equal(entity.sizeRaw, size);
        assert.deepEqual(
          Buffer.from(await remote.readFile("attachment.bin")),
          Buffer.from(content)
        );
        assertOneWholeUpload(server, size);
      }
    );
  }

  test(
    `W02 ${protocol}: unavailable partial writes do not trigger destructive initialization`,
    { timeout: 15000 },
    async (t) => {
      const { server, remote } = await setup(t, protocol);
      server.fail({
        method: protocol === "apache" ? "PUT" : "PATCH",
        header: protocol === "apache" ? "content-range" : undefined,
        path: "/vault/attachment.bin",
        status: 503,
      });
      const content = payload(10 * MiB + 1);
      await remote.writeFile("attachment.bin", content, 0, 0);
      assert.deepEqual(
        Buffer.from(await remote.readFile("attachment.bin")),
        Buffer.from(content)
      );
      assertOneWholeUpload(server, content.byteLength);
    }
  );

  for (const fault of [
    { status: 413 },
    { status: 503 },
    { disconnect: true },
  ]) {
    test(
      `${protocol}: large upload ${fault.status ?? "connection loss"} is reported without an empty pre-write`,
      { timeout: 15000 },
      async (t) => {
        const { server, remote } = await setup(t, protocol);
        server.fail({ method: "PUT", path: "/vault/attachment.bin", ...fault });
        const content = payload(10 * MiB + 1);
        await assert.rejects(
          () => remote.writeFile("attachment.bin", content, 0, 0),
          (error) => (fault.status ? error.status === fault.status : !!error)
        );
        // This fixture rejects before mutation; this is not a guarantee about all DAV servers.
        assert.equal(
          new TextDecoder().decode(await remote.readFile("attachment.bin")),
          "previous complete version"
        );
        assertOneWholeUpload(server, content.byteLength);
      }
    );
  }

  test(
    `${protocol}: failed large upload preserves sync history; retry records complete content`,
    { timeout: 15000 },
    async (t) => {
      const { server, remote } = await setup(t, protocol);
      const previous = await remote.stat("attachment.bin");
      const records = new Map();
      const db = {
        prevSyncRecordsTbl: {
          async setItem(key, value) {
            records.set(key, structuredClone(value));
            return value;
          },
          async getItems() {
            return Object.fromEntries(records);
          },
        },
      };
      await upsertPrevSyncRecordByVaultAndProfile(
        db,
        "vault-id",
        "profile-id",
        previous
      );
      const content = payload(10 * MiB + 1);
      const localEntity = {
        key: "attachment.bin",
        keyRaw: "attachment.bin",
        size: content.byteLength,
        mtimeCli: 1234567,
      };
      const local = {
        kind: "fixture",
        stat: async () => ({ ...localEntity }),
        readFile: async () => content,
      };
      const plan = {
        "attachment.bin": {
          key: "attachment.bin",
          decision: "local_is_modified_then_push",
          change: true,
          local: localEntity,
          remote: previous,
          prevSync: previous,
        },
      };
      const run = () =>
        doActualSync(
          plan,
          local,
          remote,
          "vault-id",
          "profile-id",
          1,
          -1,
          undefined,
          db,
          undefined,
          "keep_newer",
          "manual"
        );
      const history = () =>
        getAllPrevSyncRecordsByVaultAndProfile(db, "vault-id", "profile-id");
      server.fail({
        method: "PUT",
        path: "/vault/attachment.bin",
        status: 503,
        once: true,
      });
      await assert.rejects(run);
      assert.deepEqual(await history(), [previous]);
      assert.equal(
        new TextDecoder().decode(await remote.readFile("attachment.bin")),
        "previous complete version"
      );
      await run();
      const updated = await history();
      assert.equal(updated.length, 1);
      assert.equal(updated[0].sizeRaw, content.byteLength);
      assert.equal(updated[0].mtimeCli, localEntity.mtimeCli);
      assert.deepEqual(
        Buffer.from(await remote.readFile("attachment.bin")),
        Buffer.from(content)
      );
    }
  );
}

test("Nextcloud still selects its dedicated chunked uploader only above 10 MiB", async () => {
  const remote = new FakeFsWebdav(
    { ...DEFAULT_WEBDAV_CONFIG },
    "vault",
    async () => {}
  );
  remote.isNextcloud = true;
  // Selection-only control: the Nextcloud protocol itself is outside this fix.
  remote._writeFileFromRootFull = async () => "whole";
  remote._writeFileFromRootNextcloud = async () => "nextcloud";
  assert.equal(
    await remote._writeFileFromRoot(
      "/vault/x",
      new ArrayBuffer(10 * MiB),
      0,
      0,
      "x"
    ),
    "whole"
  );
  assert.equal(
    await remote._writeFileFromRoot(
      "/vault/x",
      new ArrayBuffer(10 * MiB + 1),
      0,
      0,
      "x"
    ),
    "nextcloud"
  );
});
