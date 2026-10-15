import { strict as assert } from "assert";
import { QuarkClient } from "../../src/native/quarkClient";
import { bindQuarkSession } from "../../src/native/quarkAuth";
import type { QuarkTransport } from "../../src/native/quarkTransport";
function fixture(conflict = false, mode = "normal") {
  const config = {
    session: bindQuarkSession("__puus=test"),
    remoteRoot: "/notes/vault",
  };
  const nodes = new Map<string, any[]>([
    [
      "0",
      conflict
        ? [
            {
              fid: "file",
              file_name: "notes",
              file: true,
              size: 1,
              created_at: 1,
              updated_at: 1,
            },
          ]
        : [],
    ],
  ]);
  const writes: string[] = [];
  const transport: QuarkTransport = async (request) => {
    const url = new URL(request.url);
    let result: any;
    if (request.method === "GET") {
      if (mode === "denied") throw new Error("permission denied");
      const list = nodes.get(url.searchParams.get("pdir_fid")!)!;
      result = { metadata: { _total: list.length }, data: { list } };
    } else {
      const body = JSON.parse(request.body as string);
      writes.push(body.file_name);
      const fid = `dir${writes.length}`;
      nodes.get(body.pdir_fid)!.push({
        fid,
        file_name: body.file_name,
        file: false,
        size: 0,
        created_at: 1,
        updated_at: 1,
      });
      nodes.set(fid, []);
      result = { data: { fid: mode === "mismatch" ? "other" : fid } };
      if (mode === "swapped") config.session = bindQuarkSession("__puus=other");
    }
    return {
      status: 200,
      headers: {},
      cookies: [],
      body: new TextEncoder().encode(
        JSON.stringify({ code: 0, status: 200, ...result })
      ),
    };
  };
  return { client: new QuarkClient(transport, () => config), writes };
}
describe("Quark setup directory creation", () => {
  it("creates missing ancestors once and then reuses them", async () => {
    const f = fixture();
    await f.client.prepareRoot();
    assert.deepEqual(f.writes, ["notes", "vault"]);
    await f.client.prepareRoot();
    assert.equal(f.writes.length, 2);
    assert.deepEqual(await f.client.scan(), []);
  });
  it("does not replace a same-name file", async () => {
    const f = fixture(true);
    await assert.rejects(f.client.prepareRoot());
    assert.equal(f.writes.length, 0);
  });
  for (const mode of ["denied", "mismatch", "swapped"]) {
    it(`stops preparation on ${mode} without creating the next directory`, async () => {
      const f = fixture(false, mode);
      await assert.rejects(f.client.prepareRoot());
      assert.deepEqual(f.writes, mode === "denied" ? [] : ["notes"]);
    });
  }
});
