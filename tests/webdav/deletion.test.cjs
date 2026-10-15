const assert = require("node:assert/strict");
const { test } = require("node:test");
const { startDav, loadAdapter } = require("./support/harness.cjs");
const {
  FakeFsWebdav,
  DEFAULT_WEBDAV_CONFIG,
  doActualSync,
  upsertPrevSyncRecordByVaultAndProfile,
  getAllPrevSyncRecordsByVaultAndProfile,
  upsertFileContentHistoryByVaultAndProfile,
  getFileContentHistoryByVaultAndProfile,
} = loadAdapter();
const bytes = (text) => new TextEncoder().encode(text).buffer;

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

// Only the LocalForage storage backend is substituted. Production history-key
// construction, update/read/remove functions and sync dispatch all run unchanged.
function memoryTable() {
  const values = new Map();
  return {
    async setItem(key, value) {
      values.set(key, structuredClone(value));
      return value;
    },
    async getItem(key) {
      return values.has(key) ? structuredClone(values.get(key)) : null;
    },
    async removeItem(key) {
      values.delete(key);
    },
    async getItems() {
      return Object.fromEntries(values);
    },
  };
}

async function syncFixture(
  t,
  key = "note.md",
  conflictAction = "smart_conflict"
) {
  const { server, remote } = await setup(t);
  const entity = key.endsWith("/")
    ? await remote.mkdir(key)
    : await remote.writeFile(key, bytes("old complete content"), 0, 0);
  const db = {
    prevSyncRecordsTbl: memoryTable(),
    fileContentHistoryTbl: memoryTable(),
  };
  await upsertPrevSyncRecordByVaultAndProfile(
    db,
    "vault-id",
    "profile-id",
    entity
  );
  if (!key.endsWith("/")) {
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "vault-id",
      "profile-id",
      entity,
      bytes("previous merge base")
    );
  }
  // Same path in a second profile: a successful deletion must not clear it.
  await upsertPrevSyncRecordByVaultAndProfile(
    db,
    "vault-id",
    "other-profile",
    entity
  );
  const plan = {
    [key]: {
      key,
      remote: entity,
      prevSync: entity,
      change: true,
      decision: key.endsWith("/")
        ? "folder_to_be_deleted_on_remote"
        : "local_is_deleted_thus_also_delete_remote",
    },
  };
  return {
    server,
    remote,
    entity,
    // This tests an unencrypted remote; the encryption wrapper is not under test.
    run: () =>
      doActualSync(
        plan,
        {},
        remote,
        "vault-id",
        "profile-id",
        1,
        -1,
        undefined,
        db,
        undefined,
        conflictAction,
        "manual"
      ),
    history: (profile = "profile-id") =>
      getAllPrevSyncRecordsByVaultAndProfile(db, "vault-id", profile),
    contentHistory: () =>
      getFileContentHistoryByVaultAndProfile(
        db,
        "vault-id",
        "profile-id",
        entity
      ),
  };
}

for (const status of [401, 403, 404, 409, 423, 429, 500, 503, 507]) {
  test(
    `DELETE ${status} rejects and leaves the target intact`,
    { timeout: 10000 },
    async (t) => {
      const { server, remote } = await setup(t);
      await remote.writeFile("note.md", bytes("old"), 0, 0);
      server.fail({ method: "DELETE", path: "/vault/note.md", status });
      await assert.rejects(
        () => remote.rm("note.md"),
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
  "missing target 404 is reported instead of guessed successful",
  { timeout: 10000 },
  async (t) => {
    const { remote } = await setup(t);
    await remote.writeFile("note.md", bytes("old"), 0, 0);
    await remote.rm("note.md");
    await assert.rejects(
      () => remote.rm("note.md"),
      (error) => error.status === 404
    );
  }
);

test(
  "DELETE connection loss rejects instead of guessing success",
  { timeout: 10000 },
  async (t) => {
    const { server, remote } = await setup(t);
    await remote.writeFile("note.md", bytes("old"), 0, 0);
    server.fail({ method: "DELETE", path: "/vault/note.md", disconnect: true });
    await assert.rejects(() => remote.rm("note.md"));
    assert.equal(
      new TextDecoder().decode(await remote.readFile("note.md")),
      "old"
    );
  }
);

for (const fault of [
  { status: 403 },
  { status: 404 },
  { status: 429 },
  { status: 503 },
  { disconnect: true },
]) {
  test(
    `sync keeps file and content histories after DELETE ${fault.status ?? "connection loss"}`,
    { timeout: 10000 },
    async (t) => {
      const state = await syncFixture(t);
      state.server.fail({ method: "DELETE", path: "/vault/note.md", ...fault });
      // Capture the outcome so we also inspect state if the old buggy code resolves.
      const error = await state.run().then(
        () => undefined,
        (failure) => failure
      );
      assert.deepEqual(await state.history(), [state.entity]);
      assert.equal(
        new TextDecoder().decode(await state.contentHistory()),
        "previous merge base"
      );
      assert.deepEqual(await state.history("other-profile"), [state.entity]);
      assert.ok(error, "sync must report the failed deletion");
    }
  );
}

test(
  "retry clears only the matching histories after confirmed deletion",
  { timeout: 10000 },
  async (t) => {
    const state = await syncFixture(t);
    state.server.fail({
      method: "DELETE",
      path: "/vault/note.md",
      status: 503,
      once: true,
    });
    await assert.rejects(() => state.run());
    assert.deepEqual(await state.history(), [state.entity]);
    await state.run();
    assert.deepEqual(await state.history(), []);
    assert.equal(await state.contentHistory(), null);
    assert.deepEqual(await state.history("other-profile"), [state.entity]);
    await assert.rejects(
      () => state.remote.readFile("note.md"),
      (error) => error.status === 404
    );
  }
);

test(
  "basic conflict mode clears file history on successful deletion",
  { timeout: 10000 },
  async (t) => {
    const state = await syncFixture(t, "note.md", "keep_newer");
    await state.run();
    assert.deepEqual(await state.history(), []);
    await assert.rejects(
      () => state.remote.readFile("note.md"),
      (error) => error.status === 404
    );
  }
);

test(
  "folder deletion failure preserves history; successful retry clears it",
  { timeout: 10000 },
  async (t) => {
    const state = await syncFixture(t, "folder/");
    state.server.fail({
      method: "DELETE",
      path: "/vault/folder",
      status: 403,
      once: true,
    });
    const error = await state.run().then(
      () => undefined,
      (failure) => failure
    );
    assert.deepEqual(await state.history(), [state.entity]);
    assert.ok(error);
    await state.run();
    assert.deepEqual(await state.history(), []);
    assert.deepEqual(await state.history("other-profile"), [state.entity]);
    await assert.rejects(
      () => state.remote.stat("folder/"),
      (failure) => failure.status === 404
    );
  }
);
