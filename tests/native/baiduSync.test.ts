import { strict as assert } from "assert";
import { safeSyncError } from "../../src/syncActivity";
import { api, bytes, setup } from "./support/baiduSyncHarness";
describe("Baidu through real sync planning and dispatch", () => {
  it("builds a new-file push plan without remote mutation or history updates", async () => {
    const f = setup();
    await f.local.writeFile("笔记.md", bytes("hello"), 10000, 10000);
    const plan = await f.plan();
    assert.equal(plan["笔记.md"].decision, "local_is_created_then_push");
    assert.equal(f.mutations.length, 0);
    assert.deepEqual(await f.history(), []);
  });
  for (const password of ["", "test-password"])
    it(`uploads and downloads unchanged content through the encryption wrapper: ${password ? "OpenSSL" : "plain"}`, async () => {
      const f = setup(password);
      await f.local.writeFile("中文.md", bytes("完整笔记内容"), 10123, 10123);
      await f.run(await f.plan());
      const history = await f.history();
      assert.equal(history.length, 1);
      assert.equal(history[0].key, "中文.md");
      assert.equal(history[0].mtimeCli, 10123);
      const body = await f.encrypted.readFile("中文.md");
      assert.equal(new TextDecoder().decode(body), "完整笔记内容");
      if (password) {
        const item = [...f.remoteItems.values()][0];
        assert.notEqual(item.path, "/apps/test/中文.md");
        assert.notEqual(new TextDecoder().decode(item.body), "完整笔记内容");
      }
      const previousMutations = f.mutations.length;
      const next = await f.plan();
      assert.equal(next["中文.md"].change, false);
      await f.run(next);
      assert.equal(f.mutations.length, previousMutations);
    });
  it("downloads an existing remote note to a new local vault", async () => {
    const f = setup();
    await f.encrypted.walk();
    await f.encrypted.writeFile("远端.md", bytes("remote"), 10000, 10000);
    const plan = await f.plan();
    assert.equal(plan["远端.md"].decision, "remote_is_created_then_pull");
    await f.run(plan);
    assert.equal(
      new TextDecoder().decode(await f.local.readFile("远端.md")),
      "remote"
    );
    assert.equal((await f.history()).length, 1);
  });
  it("uploads an encrypted empty note and restores its empty plaintext", async () => {
    const f = setup("test-password");
    await f.local.writeFile("空.md", new ArrayBuffer(0), 10000, 10000);
    await f.run(await f.plan());
    assert.equal((await f.encrypted.readFile("空.md")).byteLength, 0);
    assert.equal((await f.history()).length, 1);
  });
  it("does not record an unsupported unencrypted empty-file upload as successful", async () => {
    const f = setup();
    await f.local.writeFile("空.md", new ArrayBuffer(0), 10000, 10000);
    await assert.rejects(f.run(await f.plan()), (error: unknown) => {
      assert.match(safeSyncError(error), /不支持.*空文件/);
      return true;
    });
    assert.deepEqual(await f.history(), []);
    assert.equal(f.remoteItems.size, 0);
  });
  it("preserves previous sync history when overwrite fails", async () => {
    const f = setup();
    await f.local.writeFile("note.md", bytes("old"), 10000, 10000);
    await f.run(await f.plan());
    const before = await f.history();
    await f.local.writeFile("note.md", bytes("new content"), 20000, 10000);
    f.failUpload();
    const plan = await f.plan();
    assert.equal(plan["note.md"].decision, "local_is_modified_then_push");
    await assert.rejects(f.run(plan));
    assert.deepEqual(await f.history(), before);
  });
  for (const mode of ["denied", "async", "lost"])
    it(`keeps sync and merge history after an unconfirmed delete: ${mode}`, async () => {
      const f = setup();
      await f.local.writeFile("note.md", bytes("old"), 10000, 10000);
      await f.run(await f.plan(), "smart_conflict");
      const before = await f.history();
      const mergeBefore = await api.getFileContentHistoryByVaultAndProfile(
        f.db,
        "vault",
        "baidu-profile",
        before[0]
      );
      await f.local.rm("note.md");
      await f.local.writeFile("保留.md", bytes("anchor"), 10000, 10000);
      const plan = await f.plan();
      assert.equal(
        plan["note.md"].decision,
        "local_is_deleted_thus_also_delete_remote"
      );
      f.deleteMode(mode);
      await assert.rejects(f.run(plan, "smart_conflict"));
      assert.deepEqual(await f.history(), before);
      assert.deepEqual(
        await api.getFileContentHistoryByVaultAndProfile(
          f.db,
          "vault",
          "baidu-profile",
          before[0]
        ),
        mergeBefore
      );
    });
  it("clears only the active profile history after confirmed deletion", async () => {
    const f = setup();
    await f.local.writeFile("note.md", bytes("old"), 10000, 10000);
    await f.run(await f.plan());
    const record = (await f.history())[0];
    await api.upsertPrevSyncRecordByVaultAndProfile(
      f.db,
      "vault",
      "other-profile",
      record
    );
    await f.local.rm("note.md");
    await f.local.writeFile("保留.md", bytes("anchor"), 10000, 10000);
    await f.run(await f.plan());
    assert.equal(
      (await f.history()).some((item: any) => item.key === "note.md"),
      false
    );
    assert.equal(
      (
        await api.getAllPrevSyncRecordsByVaultAndProfile(
          f.db,
          "vault",
          "other-profile"
        )
      ).length,
      1
    );
  });
  it("retains the existing empty-vault safeguard instead of planning mass remote deletion", async () => {
    const f = setup();
    await f.local.writeFile("note.md", bytes("old"), 10000, 10000);
    await f.run(await f.plan());
    await f.local.rm("note.md");
    const plan = await f.plan();
    assert.equal(plan["note.md"].decision, "remote_is_created_then_pull");
    assert.equal(f.remoteItems.size, 1);
  });
  it("runs the complete dry-run entry without remote mutations or sync-history updates", async () => {
    const f = setup();
    await f.local.writeFile("note.md", bytes("preview"), 10000, 10000);
    const errors: Error[] = [];
    const states: boolean[] = [];
    await api.syncer(
      f.local,
      f.remote,
      f.encrypted,
      undefined,
      f.db,
      "dry",
      "baidu-profile",
      "vault",
      ".obsidian",
      {
        ...f.settings,
        pro: { refreshToken: "test-pro-state", enabledProFeatures: [] },
      },
      "0.5.25",
      async () => {},
      undefined,
      (state: boolean) => states.push(state),
      undefined,
      async (_source: string, error: Error) => {
        errors.push(error);
      }
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(states, [true, false]);
    const records = Object.values(await f.db.syncPlansTbl.getItems()) as any[];
    assert.equal(records.length, 1);
    assert.equal(
      JSON.parse(records[0].syncPlan)["note.md"].decision,
      "local_is_created_then_push"
    );
    assert.equal(f.mutations.length, 0);
    assert.deepEqual(await f.history(), []);
  });
  it("runs native Baidu dry-run without requiring an unrelated PRO account", async () => {
    const f = setup();
    await f.local.writeFile("note.md", bytes("preview"), 10000, 10000);
    const errors: Error[] = [];
    await api.syncer(
      f.local,
      f.remote,
      f.encrypted,
      undefined,
      f.db,
      "dry",
      "baidu-profile",
      "vault",
      ".obsidian",
      { ...f.settings, serviceType: "baidu" },
      "0.5.25",
      async () => {},
      undefined,
      () => {},
      undefined,
      async (_source: string, error: Error) => {
        errors.push(error);
      }
    );
    assert.deepEqual(errors, []);
    const records = Object.values(await f.db.syncPlansTbl.getItems()) as any[];
    assert.equal(records.length, 1);
    assert.equal(records[0].remoteType, "baidu");
    assert.equal(
      JSON.parse(records[0].syncPlan)["/$@meta"].sideNotes.service,
      "baidu"
    );
    assert.equal(f.mutations.length, 0);
  });
  it("selects the native adapter through getClient and completes manual sync with a Baidu profile", async () => {
    const f = setup();
    const config = api.bindBaiduIdentity(
      {
        app: { clientId: "app", clientSecret: "secret", redirectUri: "oob" },
        tokens: {
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: 9999999999999,
        },
        remoteRoot: "/apps/test",
      },
      "a".repeat(32)
    );
    const settings = {
      ...f.settings,
      serviceType: "baidu",
      baiduNative: config,
      protectModifyPercentage: -1,
    };
    f.replaceConfig(config);
    const remote = api.getClient(settings, "vault", async () => {}, {
      baiduConnection: f.connection,
      getSettings: () => settings,
    });
    const encrypted = new api.FakeFsEncrypt(remote, "", "openssl-base64");
    const profile = api.getBaiduProfileId(config, "", "unknown");
    await f.local.writeFile("native.md", bytes("native"), 10000, 10000);
    const errors: Error[] = [];
    await api.syncer(
      f.local,
      remote,
      encrypted,
      undefined,
      f.db,
      "manual",
      profile,
      "vault",
      ".obsidian",
      settings,
      "0.5.25",
      async () => {},
      undefined,
      () => {},
      undefined,
      async (_source: string, error: Error) => {
        errors.push(error);
      }
    );
    assert.deepEqual(errors, []);
    assert.equal(remote.kind, "baidu");
    const history = await api.getAllPrevSyncRecordsByVaultAndProfile(
      f.db,
      "vault",
      profile
    );
    assert.equal(history.length, 1);
    assert.equal(history[0].key, "native.md");
    assert.deepEqual(
      await api.getAllPrevSyncRecordsByVaultAndProfile(
        f.db,
        "vault",
        "webdav-default-1"
      ),
      []
    );
  });
  it("executes parallel file operations after creating parent folders", async () => {
    const f = setup();
    await f.local.mkdir("目录/");
    for (const key of ["目录/a.md", "目录/b.md", "目录/c.md"])
      await f.local.writeFile(key, bytes(key), 10000, 10000);
    await f.run(await f.plan());
    assert.equal((await f.history()).length, 4);
    for (const key of ["目录/a.md", "目录/b.md", "目录/c.md"])
      assert.equal(
        new TextDecoder().decode(await f.encrypted.readFile(key)),
        key
      );
    assert.equal(
      [...f.remoteItems.values()].find(
        (item: any) => item.path === "/apps/test/目录"
      ).isdir,
      1
    );
  });
  it("stores an OpenSSL folder marker as a nonempty remote file", async () => {
    const f = setup("test-password");
    await f.local.mkdir("目录/");
    await f.local.writeFile("目录/note.md", bytes("inside"), 10000, 10000);
    await f.run(await f.plan());
    assert.equal((await f.history()).length, 2);
    assert.equal(f.remoteItems.size, 2);
    assert.equal(
      new TextDecoder().decode(await f.encrypted.readFile("目录/note.md")),
      "inside"
    );
    const entries = await f.encrypted.walk();
    assert.ok(entries.some((entry: any) => entry.key === "目录/"));
    assert.equal(
      [...f.remoteItems.values()].every(
        (item: any) => item.isdir === 0 && item.size > 0
      ),
      true
    );
  });
  it("does not generate local-deletion actions from a failed remote scan", async () => {
    const f = setup();
    await f.local.writeFile("note.md", bytes("old"), 10000, 10000);
    await f.run(await f.plan());
    const before = await f.history();
    f.failScan();
    await assert.rejects(f.plan());
    assert.deepEqual(await f.history(), before);
    assert.equal(
      new TextDecoder().decode(await f.local.readFile("note.md")),
      "old"
    );
  });
});
