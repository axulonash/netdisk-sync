import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import { createSyncNotice } from "../src/syncNoticeUi";
import { progressStatus } from "../src/syncProgressUi";

function fixture() {
  const dom = new JSDOM("<body></body>");
  const listeners = new Set<() => void>();
  const plugin: any = {
    syncUiActivity: undefined,
    onSyncUiUpdate(callback: () => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  (globalThis as any).document = dom.window.document;
  const fire = () => {
    for (const callback of [...listeners]) callback();
  };
  return { plugin, fire, listeners };
}

describe("floating sync notice", () => {
  it("shows progress text and a progress meter while a manual sync runs", () => {
    const { plugin, fire } = fixture();
    const notice = createSyncNotice(plugin);
    plugin.syncUiActivity = {
      trigger: "manual",
      status: "running",
      progress: { phase: "syncing", plan: { total: 10 }, completed: 3 },
    };
    fire();
    const element = document.querySelector<HTMLElement>(".rsnext-sync-notice");
    assert.ok(element);
    assert.ok(element.querySelector("progress"));
    assert.ok(
      element.textContent?.includes(
        progressStatus(plugin.syncUiActivity.progress)
      )
    );
    notice.destroy();
  });

  it("ignores automatic syncs", () => {
    const { plugin, fire } = fixture();
    const notice = createSyncNotice(plugin);
    plugin.syncUiActivity = {
      trigger: "auto",
      status: "running",
      progress: { phase: "syncing", plan: { total: 1 }, completed: 0 },
    };
    fire();
    assert.equal(document.querySelector(".rsnext-sync-notice"), null);
    notice.destroy();
  });

  it("swaps to a result summary and dismisses after the timeout", async () => {
    const { plugin, fire } = fixture();
    const notice = createSyncNotice(plugin, { dismissMs: 5 });
    plugin.syncUiActivity = {
      trigger: "manual",
      status: "success",
      progress: { phase: "finished", completed: 2, failed: 0, unexecuted: 0 },
    };
    fire();
    const element = document.querySelector<HTMLElement>(".rsnext-sync-notice");
    assert.ok(element);
    assert.ok(!element.querySelector("progress"));
    assert.ok(element.textContent?.includes("同步完成"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(document.querySelector(".rsnext-sync-notice"), null);
    notice.destroy();
  });

  it("dismisses a paused sync the same way", async () => {
    const { plugin, fire } = fixture();
    const notice = createSyncNotice(plugin, { dismissMs: 5 });
    plugin.syncUiActivity = {
      trigger: "manual",
      status: "paused",
      progress: { phase: "finished", completed: 1, failed: 0, unexecuted: 1 },
    };
    fire();
    assert.ok(
      document
        .querySelector(".rsnext-sync-notice")
        ?.textContent?.includes("同步已暂停")
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(document.querySelector(".rsnext-sync-notice"), null);
    notice.destroy();
  });

  it("does not re-pop a dismissed terminal notice on unrelated updates, but shows a new sync", async () => {
    const { plugin, fire } = fixture();
    const notice = createSyncNotice(plugin, { dismissMs: 5 });
    const finished = {
      trigger: "manual",
      status: "success",
      progress: { phase: "finished", completed: 2, failed: 0, unexecuted: 0 },
    };
    plugin.syncUiActivity = finished;
    fire();
    assert.ok(document.querySelector(".rsnext-sync-notice"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(document.querySelector(".rsnext-sync-notice"), null);
    // Unrelated UI refresh (e.g. "test connection") re-fires the callback with the same record.
    fire();
    assert.equal(document.querySelector(".rsnext-sync-notice"), null);
    // A real new sync uses a different activity object and must show again.
    plugin.syncUiActivity = {
      trigger: "manual",
      status: "running",
      progress: { phase: "syncing", plan: { total: 3 }, completed: 1 },
    };
    fire();
    assert.ok(document.querySelector(".rsnext-sync-notice"));
    notice.destroy();
  });

  it("removes the notice on destroy and ignores later updates", () => {
    const { plugin, fire } = fixture();
    const notice = createSyncNotice(plugin);
    plugin.syncUiActivity = {
      trigger: "manual",
      status: "running",
      progress: { phase: "syncing", plan: { total: 1 }, completed: 0 },
    };
    fire();
    assert.ok(document.querySelector(".rsnext-sync-notice"));
    notice.destroy();
    assert.equal(document.querySelector(".rsnext-sync-notice"), null);
    fire();
    assert.equal(document.querySelector(".rsnext-sync-notice"), null);
  });
});
