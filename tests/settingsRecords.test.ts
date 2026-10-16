import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import { createRecordsSection } from "../src/settingsRecords";

const tick = () => new Promise((r) => setTimeout(r, 0));

const activity = (
  id: string,
  status: string,
  files: { upload?: string[]; download?: string[]; delete?: string[] } = {}
) => ({
  id,
  startedAt: 0,
  endedAt: 1000,
  trigger: "manual",
  status,
  counts: {
    upload: files.upload?.length ?? 0,
    download: files.download?.length ?? 0,
    delete: files.delete?.length ?? 0,
  },
  files: {
    upload: files.upload ?? [],
    download: files.download ?? [],
    delete: files.delete ?? [],
  },
  failedPaths: [],
});

function fixture() {
  const dom = new JSDOM("<div id='section'></div>");
  const sectionEl = dom.window.document.getElementById("section")!;
  const records = [
    activity("1", "success", { upload: ["a/b.md"] }),
    activity("2", "success", { download: ["c.md"] }),
    activity("3", "partial"),
  ];
  const listeners = new Set<() => void>();
  const plugin: any = {
    syncUiActivity: undefined,
    getSyncActivities: async () => records,
    onSyncUiUpdate(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const handle = createRecordsSection(sectionEl, plugin);
  const fire = () => {
    for (const cb of [...listeners]) cb();
  };
  return { dom, sectionEl, plugin, handle, fire, listeners, records };
}

describe("shared sync records section", () => {
  it("renders one row per record with localized result text", async () => {
    const f = fixture();
    await tick();
    const rows = f.sectionEl.querySelectorAll(".rsnext-record");
    assert.equal(rows.length, 3);
    const summaries = Array.from(rows).map(
      (r) => r.querySelector("summary")!.textContent!
    );
    assert.equal(summaries.filter((t) => t.includes("已完成")).length, 2);
    assert.equal(summaries.filter((t) => t.includes("部分完成")).length, 1);
    f.handle.cleanup();
  });

  it("reveals file paths when a row is expanded", async () => {
    const f = fixture();
    await tick();
    const row = f.sectionEl.querySelector(
      ".rsnext-record"
    ) as HTMLDetailsElement;
    assert.equal(row.open, false);
    (row.querySelector("summary") as HTMLElement).dispatchEvent(
      new f.dom.window.MouseEvent("click", { bubbles: true })
    );
    assert.equal(row.open, true);
    assert.ok(row.querySelector(".rsnext-path-tree"));
    assert.ok(row.textContent!.includes("b.md"));
    f.handle.cleanup();
  });

  it("refreshes when a sync update notification arrives", async () => {
    const f = fixture();
    await tick();
    f.records.push(activity("4", "success"));
    f.fire();
    await tick();
    assert.equal(f.sectionEl.querySelectorAll(".rsnext-record").length, 4);
    f.handle.cleanup();
  });

  it("detaches its listener on cleanup", async () => {
    const f = fixture();
    await tick();
    assert.equal(f.listeners.size, 1);
    f.handle.cleanup();
    assert.equal(f.listeners.size, 0);
  });
});
