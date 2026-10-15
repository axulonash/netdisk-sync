import { strict as assert } from "assert";
import { BaiduConnection } from "../../src/native/baiduConnection";
import { bindBaiduIdentity } from "../../src/native/baiduProfile";
function fixture() {
  let config: any = bindBaiduIdentity(
    {
      app: { clientId: "app", clientSecret: "secret", redirectUri: "oob" },
      tokens: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 9999999999999,
      },
      remoteRoot: "/apps/old",
    },
    "a".repeat(32)
  );
  let saved = 0,
    serial = 10;
  const nodes = new Map<string, { id: number; dir: boolean }>([
      ["/", { id: 1, dir: true }],
      ["/apps", { id: 2, dir: true }],
    ]),
    writes: string[] = [];
  let denied = false,
    failCreate = false;
  const connection = new BaiduConnection({
    getConfig: () => config,
    saveConfig: async (next) => {
      saved++;
      config = next;
    },
    transport: async (request) => {
      const parent = new URL(request.url).searchParams.get("dir")!;
      if (denied) return { status: 403, json: {} };
      if (!nodes.get(parent)?.dir) return { status: 200, json: { errno: -9 } };
      return {
        status: 200,
        json: {
          errno: 0,
          list: [...nodes]
            .filter(
              ([path]) =>
                path !== "/" &&
                path.slice(0, path.lastIndexOf("/")) ===
                  (parent === "/" ? "" : parent)
            )
            .map(([path, node]) => ({
              fs_id: node.id,
              path,
              server_filename: path.slice(path.lastIndexOf("/") + 1),
              isdir: node.dir ? 1 : 0,
              size: 0,
              server_mtime: 1,
              server_ctime: 1,
            })),
        },
      };
    },
    upload: async (request) => {
      const form = new URLSearchParams(request.body as string),
        path = form.get("path")!;
      writes.push(path);
      assert.equal(form.get("rtype"), "0");
      assert.equal(form.get("isdir"), "1");
      if (failCreate) return { status: 200, json: { errno: -7 } };
      const node = { id: serial++, dir: true };
      nodes.set(path, node);
      return {
        status: 200,
        json: { errno: 0, fs_id: node.id, path, isdir: 1, size: 0 },
      };
    },
  });
  return {
    connection,
    nodes,
    writes,
    config: () => config,
    saved: () => saved,
    deny: () => {
      denied = true;
    },
    fail: () => {
      failCreate = true;
    },
  };
}
describe("Preparing Baidu sync directories", () => {
  it("creates missing parent directories, verifies them and only then saves the selected root", async () => {
    const f = fixture();
    await f.connection.setRemoteRoot("/apps/notes/vault/", {
      createIfMissing: true,
    });
    assert.deepEqual(f.writes, ["/apps/notes", "/apps/notes/vault"]);
    assert.equal(f.config().remoteRoot, "/apps/notes/vault");
    assert.equal(f.saved(), 1);
  });
  it("reuses an existing directory without creating or renaming anything", async () => {
    const f = fixture();
    f.nodes.set("/apps/existing", { id: 5, dir: true });
    await f.connection.setRemoteRoot("/apps/existing", {
      createIfMissing: true,
    });
    assert.deepEqual(f.writes, []);
    assert.equal(f.config().remoteRoot, "/apps/existing");
  });
  it("does not create anything on permission or transport failure", async () => {
    const f = fixture();
    f.deny();
    await assert.rejects(
      f.connection.setRemoteRoot("/apps/new", { createIfMissing: true })
    );
    assert.deepEqual(f.writes, []);
    assert.equal(f.config().remoteRoot, "/apps/old");
    assert.equal(f.saved(), 0);
  });
  it("does not replace a same-named file with a directory", async () => {
    const f = fixture();
    f.nodes.set("/apps/file", { id: 5, dir: false });
    await assert.rejects(
      f.connection.setRemoteRoot("/apps/file", { createIfMissing: true })
    );
    assert.deepEqual(f.writes, []);
    assert.equal(f.saved(), 0);
  });
  it("keeps the previous root if creation fails", async () => {
    const f = fixture();
    f.fail();
    await assert.rejects(
      f.connection.setRemoteRoot("/apps/new", { createIfMissing: true })
    );
    assert.equal(f.config().remoteRoot, "/apps/old");
    assert.equal(f.saved(), 0);
  });
});
