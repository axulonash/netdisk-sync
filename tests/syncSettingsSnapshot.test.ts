import { strict as assert } from "assert";
import { createSnapshotSaver } from "../src/syncSettingsSnapshot";
describe("Sync snapshot credential persistence", () => {
  it("persists successive token refreshes while keeping user changes", async () => {
    const current: any = {
        pro: { accessToken: "old" },
        webdav: { address: "user edited" },
      },
      snapshot: any = {
        pro: { accessToken: "old" },
        webdav: { address: "before edit" },
      };
    let saved: any;
    const save = createSnapshotSaver(
      snapshot,
      () => current,
      async () => {
        saved = structuredClone(current);
      }
    );
    snapshot.pro.accessToken = "refreshed";
    await save();
    assert.equal(saved.pro.accessToken, "refreshed");
    assert.equal(saved.webdav.address, "user edited");
    snapshot.pro.accessToken = "refreshed-again";
    await save();
    assert.equal(saved.pro.accessToken, "refreshed-again");
  });
  it("stops when the user has independently changed the account", async () => {
    const current: any = { pro: { accessToken: "old" } },
      snapshot: any = structuredClone(current);
    let writes = 0;
    const save = createSnapshotSaver(
      snapshot,
      () => current,
      async () => {
        writes++;
      }
    );
    current.pro.accessToken = "another-account";
    snapshot.pro.accessToken = "refreshed";
    await assert.rejects(save(), (e: any) => e.code === "sync_scope_changed");
    assert.equal(writes, 0);
    assert.equal(current.pro.accessToken, "another-account");
  });
});
