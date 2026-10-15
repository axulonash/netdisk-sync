import { strict as assert } from "assert";
import { readFileSync } from "fs";
import { api } from "./native/support/baiduSyncHarness";

describe("Independent remotely-save-next identity", () => {
  it("uses matching package, plugin and release identities", () => {
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const versions = JSON.parse(readFileSync("versions.json", "utf8"));
    assert.equal(manifest.id, "remotely-save-next");
    assert.equal(manifest.name, manifest.id);
    for (const metadata of [pkg, lock, lock.packages[""]]) {
      assert.equal(metadata.name, manifest.id);
      assert.equal(metadata.version, manifest.version);
    }
    assert.equal(versions[manifest.version], manifest.minAppVersion);
    assert.equal(manifest.fundingUrl, undefined);
  });
  it("round-trips configuration through the new URI without claiming the old handler", async () => {
    const settings: any = { serviceType: "webdav", webdav: { address: "https://example.test/dav" } };
    const exported = await api.exportQrCodeUri(settings, "test-vault", "0.1.0", "webdav");
    assert.ok(exported.rawUri.startsWith("obsidian://remotely-save-next?"));
    const params = api.parseUriByHand(exported.rawUri);
    const imported = api.importQrCodeUri(params, "test-vault");
    assert.equal(imported.status, "ok");
    assert.deepEqual(imported.result.webdav, settings.webdav);
    assert.throws(() => api.parseUriByHand(exported.rawUri.replace("remotely-save-next?", "remotely-save?")));
  });
  it("isolates local history and callbacks from the upstream plugin", () => {
    assert.equal(api.DEFAULT_DB_NAME, "remotely-save-next-db");
    assert.equal(api.COMMAND_URI, "remotely-save-next");
    assert.equal(api.COMMAND_CALLBACK, "remotely-save-next-cb");
  });
});
