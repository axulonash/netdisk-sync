import { strict as assert } from "assert";
import { api, bytes, setup } from "./native/support/baiduSyncHarness";
import { ActivityTracker } from "../src/syncActivity";
describe("Simple sync workflow through real engine", () => {
  it("preserves both Markdown versions without merging or discarding either", async () => {
    const f = setup();
    (f.settings as any).conflictAction = "keep_both";
    await f.encrypted.walk();
    await f.encrypted.writeFile(
      "note.md",
      bytes("remote original"),
      10000,
      10000
    );
    await f.local.writeFile(
      "note.md",
      bytes("local original with changes"),
      20000,
      20000
    );
    await f.run(await f.plan(), "keep_both");
    const bodies = await Promise.all(
      (await f.local.walk()).map((e: any) => f.local.readFile(e.key))
    );
    assert.deepEqual(
      bodies.map((b) => new TextDecoder().decode(b)).sort(),
      ["local original with changes", "remote original"].sort()
    );
    assert.equal((await f.encrypted.walk()).length, 2);
  });
  it("keeps both versions when modification times cannot resolve a conflict", async () => {
    const f = setup();
    await f.encrypted.walk();
    await f.encrypted.writeFile("note.md", bytes("remote"), 10000, 10000);
    await f.local.writeFile(
      "note.md",
      bytes("local different"),
      101000,
      101000
    );
    await f.run(await f.plan());
    assert.equal((await f.local.walk()).length, 2);
  });
  it("requires a one-run confirmation for large changes and leaves protection enabled", async () => {
    const f = setup();
    await f.local.writeFile("a.md", bytes("a"), 10000, 10000);
    await f.local.writeFile("b.md", bytes("b"), 10000, 10000);
    await f.run(await f.plan());
    await f.local.rm("a.md");
    const plan = await f.plan();
    let confirmations = 0;
    await api.doActualSync(
      plan,
      f.local,
      f.encrypted,
      "vault",
      "baidu-profile",
      1,
      50,
      () => "protected",
      f.db,
      undefined,
      "keep_newer",
      "manual",
      undefined,
      {
        authorizeLargeChanges: async (p: any) => {
          confirmations++;
          assert.deepEqual(p.deletedPaths, ["a.md"]);
          return true;
        },
      }
    );
    assert.equal(confirmations, 1);
    assert.equal(f.remoteItems.size, 1);
    assert.equal((f.settings as any).protectModifyPercentage, undefined);
  });
  it("tracks actual uploads through encryption without breaking synchronous filesystem methods", async () => {
    const f = setup("password");
    const tracker = new ActivityTracker("manual", "profile");
    const encrypted = tracker.observe(f.encrypted, "upload");
    assert.equal(typeof encrypted.isPasswordEmpty(), "boolean");
    await f.local.writeFile("note.md", bytes("secret content"), 10000, 10000);
    const plan = await api.buildSyncPlan({
      localEntityList: await f.local.walk(),
      remoteEntityList: await encrypted.walk(),
      prevSyncEntityList: [],
      fsEncrypt: encrypted,
      settings: f.settings,
      triggerSource: "manual",
      configDir: ".obsidian",
    });
    await api.doActualSync(
      plan,
      tracker.observe(f.local, "download"),
      encrypted,
      "vault",
      "profile",
      1,
      -1,
      undefined,
      f.db,
      undefined,
      "keep_newer",
      "manual"
    );
    const record = tracker.finish();
    assert.deepEqual(record.files.upload, ["note.md"]);
    assert.equal(record.counts.upload, 1);
    assert.ok(!JSON.stringify(record).includes("secret content"));
  });
  it("rejects a confirmed plan when files change while awaiting approval", async () => {
    const f = setup();
    await f.local.writeFile("a.md", bytes("a"), 10000, 10000);
    await f.local.writeFile("b.md", bytes("b"), 10000, 10000);
    await f.run(await f.plan());
    await f.local.rm("a.md");
    let error: any;
    await api.syncer(
      f.local,
      f.remote,
      f.encrypted,
      undefined,
      f.db,
      "manual",
      "baidu-profile",
      "vault",
      ".obsidian",
      { ...f.settings, protectModifyPercentage: 50, concurrency: 1 },
      "0.1.0",
      async () => {},
      () => "protected",
      () => {},
      undefined,
      async (_: any, e: any) => {
        error = e;
      },
      undefined,
      undefined,
      undefined,
      {
        authorizeLargeChanges: async () => {
          await f.local.writeFile(
            "b.md",
            bytes("changed while waiting"),
            20000,
            20000
          );
          return true;
        },
      }
    );
    assert.equal(error?.code, "plan_changed");
    assert.equal(f.remoteItems.size, 2);
  });
  it("cancels a protected plan without deleting remote files", async () => {
    const f = setup();
    await f.local.writeFile("a.md", bytes("a"), 10000, 10000);
    await f.local.writeFile("b.md", bytes("b"), 10000, 10000);
    await f.run(await f.plan());
    await f.local.rm("a.md");
    await assert.rejects(
      api.doActualSync(
        await f.plan(),
        f.local,
        f.encrypted,
        "vault",
        "baidu-profile",
        1,
        50,
        () => "protected",
        f.db,
        undefined,
        "keep_newer",
        "auto",
        undefined,
        { authorizeLargeChanges: async () => false }
      ),
      (e: any) => e.code === "sync_protected"
    );
    assert.equal(f.remoteItems.size, 2);
  });
});
