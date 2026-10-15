import { strict as assert } from "assert";
import { QuarkClient } from "../../src/native/quarkClient";
import { bindQuarkSession } from "../../src/native/quarkAuth";
import type { QuarkTransport } from "../../src/native/quarkTransport";

describe("Quark folder creation visibility", () => {
  it("waits for a created directory to appear without repeating the create request", async () => {
    const config = {
      session: bindQuarkSession("__puus=test"),
      remoteRoot: "/test",
    };
    let folderCreates = 0;
    let listReadsUntilVisible = 3;
    const transport: QuarkTransport = async (request) => {
      const url = new URL(request.url);
      const body = request.body ? JSON.parse(request.body as string) : {};
      let data: any;
      if (url.pathname.endsWith("/file/sort")) {
        const parent = url.searchParams.get("pdir_fid");
        if (parent === "0") {
          data = { list: [{ fid: "root", file_name: "test", file: false, size: 0,
            created_at: 1, updated_at: 1, pdir_fid: "0" }] };
        } else {
          if (listReadsUntilVisible > 0) listReadsUntilVisible--;
          data = { list: listReadsUntilVisible === 0 ? [{ fid: "folder", file_name: "docs", file: false,
            size: 0, created_at: 1, updated_at: 1, pdir_fid: "root" }] : [] };
        }
        const json = { code: 0, status: 200, metadata: { _total: data.list.length }, data };
        return { status: 200, headers: {}, cookies: [], body: new TextEncoder().encode(JSON.stringify(json)) };
      }
      if (url.pathname.endsWith("/file")) {
        folderCreates++;
        const json = { code: 0, status: 200, data: { fid: "folder" } };
        return { status: 200, headers: {}, cookies: [], body: new TextEncoder().encode(JSON.stringify(json)) };
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    };

    const client = new QuarkClient(transport, () => config);
    const entry = await client.mkdir("docs/");
    assert.equal(entry.fid, "folder");
    assert.equal(folderCreates, 1);
  });
});
