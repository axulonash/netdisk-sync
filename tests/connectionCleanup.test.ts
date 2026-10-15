import { strict as assert } from "assert";
import { FakeFs } from "../src/fsAll";
describe("Connection probe cleanup", () => {
  for (const cleanupFails of [false, true])
    it(`reports residue only when cleanup fails (${cleanupFails})`, async () => {
      const probe: any = Object.create(FakeFs.prototype);
      let removed = 0;
      probe.mkdir = async () => ({});
      probe.writeFile = async () => {
        throw Object.assign(new Error("upload denied"), { status: 403 });
      };
      probe.rm = async (key: string) => {
        assert.ok(key.startsWith("rs-test-folder-"));
        removed++;
        if (cleanupFails) throw new Error("cleanup denied");
      };
      let error: any;
      assert.equal(
        await probe.checkConnectCommonOps((e: any) => {
          error = e;
        }),
        false
      );
      assert.equal(error.status, 403);
      assert.equal(removed, 1);
      assert.equal(probe.connectTestCleanupRequired, cleanupFails);
    });
});
