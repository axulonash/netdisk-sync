import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import { renderSimpleWebdav } from "../src/settingsWebdavSimple";
const tick = () => new Promise((r) => setTimeout(r, 0));
function fixture(records: any[] = []) {
  const dom = new JSDOM("<main></main>"),
    parent = dom.window.document.querySelector("main")!;
  let listener = () => {},
    saved = 0,
    tested = 0,
    advanced = 0;
  const plugin: any = {
    settings: {
      serviceType: "webdav",
      webdav: {
        address: "https://dav.example.com",
        username: "user",
        password: "secret",
      },
      conflictAction: "keep_newer",
      autoRunEveryMilliseconds: -1,
    },
    app: { vault: { getName: () => "笔记" } },
    syncUiStatus: "尚未同步",
    isSyncing: false,
    nativeMaintenance: false,
    saveSettings: async () => {
      saved++;
    },
    testWebdavConnection: async () => {
      tested++;
      plugin.settings.webdavNeedsValidation = false;
      plugin.syncUiStatus = "连接正常";
      listener();
      return true;
    },
    syncRun: async () => {},
    onSyncUiUpdate: (f: any) => {
      listener = f;
      return () => {
        listener = () => {};
      };
    },
    getSyncActivities: async () => records,
  };
  const cleanup = renderSimpleWebdav(
    parent,
    plugin,
    (p) => {
      advanced++;
      p.append(dom.window.document.createElement("input"));
    },
    () => {},
    true
  );
  return {
    dom,
    parent,
    plugin,
    cleanup,
    update: () => listener(),
    stats: () => ({ saved, tested, advanced }),
  };
}
describe("Implemented WebDAV settings", () => {
  it("shows four connection fields and loads advanced controls lazily", () => {
    const f = fixture();
    assert.equal(
      f.parent.querySelectorAll(
        'input:not([type="checkbox"]):not([type="radio"])'
      ).length,
      4
    );
    assert.equal(f.stats().advanced, 0);
    const details = f.parent.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new f.dom.window.Event("toggle"));
    assert.equal(f.stats().advanced, 1);
    assert.equal(
      details
        .querySelector("fieldset")
        ?.querySelectorAll('input:not([type="radio"])').length,
      1
    );
    f.cleanup();
  });
  it("invalidates connection immediately, persists edits before testing, preserves password whitespace", async () => {
    const f = fixture();
    const password = f.parent.querySelector(
      'input[type="password"]'
    ) as HTMLInputElement;
    password.value = " secret ";
    password.dispatchEvent(new f.dom.window.Event("input"));
    assert.equal(f.plugin.settings.webdav.password, " secret ");
    assert.equal(f.plugin.settings.webdavNeedsValidation, true);
    assert.equal(
      (f.parent.querySelector(".mod-cta") as HTMLButtonElement).disabled,
      true
    );
    const button = Array.from(f.parent.querySelectorAll("button")).find(
      (b) => b.textContent === "测试连接"
    )!;
    button.click();
    await tick();
    assert.equal(f.stats().tested, 1);
    assert.equal(f.stats().saved, 1);
    assert.equal(
      (f.parent.querySelector(".mod-cta") as HTMLButtonElement).disabled,
      false
    );
    f.cleanup();
  });
  it("renders hostile file paths as text and batches history and files", async () => {
    const record = (id: number) => ({
      id: String(id),
      startedAt: 0,
      status: "success",
      counts: { upload: 51, download: 0, delete: 0 },
      files: {
        upload: Array.from({ length: 51 }, (_, i) =>
          i === 0 ? "<img src=x onerror=alert(1)>.md" : `folder/${i}.md`
        ),
        download: [],
        delete: [],
      },
      failedPaths: [],
    });
    const f = fixture(Array.from({ length: 25 }, (_, i) => record(i)));
    Array.from(f.parent.querySelectorAll('[role="tab"]'))[1].dispatchEvent(
      new f.dom.window.MouseEvent("click")
    );
    await tick();
    assert.equal(f.parent.querySelectorAll(".rsnext-record").length, 20);
    assert.equal(f.parent.querySelector("img"), null);
    assert.equal(
      f.parent.querySelectorAll(".rsnext-record:first-of-type li:not(:has(ul))")
        .length,
      50
    );
    const more = Array.from(f.parent.querySelectorAll("button")).find(
      (b) => b.textContent === "加载更多记录"
    )!;
    more.click();
    assert.equal(f.parent.querySelectorAll(".rsnext-record").length, 25);
    f.cleanup();
  });
  it("locks connection and advanced controls while syncing and supports keyboard tabs", () => {
    const f = fixture();
    f.plugin.isSyncing = true;
    f.update();
    assert.ok(
      Array.from(f.parent.querySelectorAll("input,select,fieldset")).every(
        (e) => (e as HTMLInputElement).matches(":disabled")
      )
    );
    const tab = f.parent.querySelector('[role="tab"]')!;
    tab.dispatchEvent(
      new f.dom.window.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
      })
    );
    assert.equal(
      f.parent
        .querySelectorAll('[role="tab"]')[1]
        .getAttribute("aria-selected"),
      "true"
    );
    f.cleanup();
  });
  it("places the test next to the address and composes a directory into the target", async () => {
    const f = fixture();
    const address = f.parent.querySelector('input[type="url"]')!;
    assert.equal(
      address.parentElement!.querySelector("button")?.textContent,
      "测试连接"
    );
    const label = Array.from(f.parent.querySelectorAll("label")).find(
      (n) => n.textContent === "同步目录"
    )!;
    const directory = f.dom.window.document.getElementById(
      label.htmlFor
    ) as HTMLInputElement;
    assert.equal(directory.value, "/");
    directory.value = "/home/Drive";
    directory.dispatchEvent(new f.dom.window.Event("input"));
    assert.equal(f.plugin.settings.webdav.remoteBaseDir, "home/Drive/笔记");
    assert.equal(
      f.parent.querySelector(".rsnext-target")!.textContent,
      "完整路径：https://dav.example.com/home/Drive/笔记/"
    );
    (
      address.parentElement!.querySelector("button") as HTMLButtonElement
    ).click();
    await tick();
    assert.equal(
      (f.parent.querySelector(".rsnext-connection-light") as HTMLElement)
        .dataset.state,
      "success"
    );
    directory.value = "其他目录";
    directory.dispatchEvent(new f.dom.window.Event("input"));
    assert.equal(
      (f.parent.querySelector(".rsnext-connection-light") as HTMLElement)
        .dataset.state,
      "idle"
    );
    f.plugin.testWebdavConnection = async () => {
      f.plugin.syncUiStatus = "账号或密码未通过认证";
      return false;
    };
    (
      address.parentElement!.querySelector("button") as HTMLButtonElement
    ).click();
    await tick();
    assert.equal(
      (f.parent.querySelector(".rsnext-connection-light") as HTMLElement)
        .dataset.state,
      "failure"
    );
    assert.equal(
      f.parent
        .querySelector(".rsnext-connection-light")!
        .getAttribute("aria-label"),
      "账号或密码未通过认证"
    );
    f.cleanup();
  });
});

describe("WebDAV pre-scan and progress display", () => {
  it("shows indeterminate scanning and only confirmed task progress after planning", () => {
    const f = fixture();
    f.plugin.isSyncing = true;
    f.plugin.syncUiActivity = {status:"running", progress:{phase:"remote",
      scanned:{remote:{files:12,folders:3},local:{files:0,folders:0}},
      completed:0,failed:0,unexecuted:0,completedBytes:0,timings:{}}};
    f.update();
    const progress = f.parent.querySelector(".rsnext-sync-progress progress") as HTMLProgressElement;
    assert.ok(progress, "a visible progress control is required");
    assert.equal(progress.hasAttribute("value"), false);
    assert.match(f.parent.querySelector(".rsnext-sync-progress")!.textContent!, /12/);
    Object.assign(f.plugin.syncUiActivity.progress,{phase:"syncing",
      plan:{total:4,upload:2,download:1,delete:0,createFolder:1,conflicts:0,bytes:1024,unknownSizes:0},
      completed:1,failed:1,unexecuted:2,completedBytes:512,currentPath:"notes/a.md"});
    f.update();
    assert.equal(progress.max,4);
    assert.equal(progress.value,1, "failed tasks must not fill the success meter");
    assert.match(f.parent.querySelector(".rsnext-sync-progress")!.textContent!, /notes\/a.md/);
    assert.match(f.parent.querySelector(".rsnext-sync-progress")!.textContent!, /失败.*1/);
    f.plugin.syncUiActivity.progress.speed={upload:2048,download:1048576};f.update();
    const speed=f.parent.querySelector(".rsnext-transfer-speed") as HTMLElement;
    assert.equal(speed.hidden,false);
    assert.match(speed.textContent!,/上传 2.0 KB\/s.*下载 1.0 MB\/s/);
    f.plugin.syncUiActivity.progress.phase="finished";f.update();assert.equal(speed.hidden,true);
    f.cleanup();
  });
});

describe('Sync operation buttons',()=>{
 it('offers pause, resume and stop during a run while keeping settings locked',()=>{
  const f=fixture();let toggled=0,stopped=0;
  f.plugin.toggleSyncPause=()=>{toggled++;};f.plugin.stopSync=()=>{stopped++;};
  f.plugin.isSyncing=true;f.plugin.syncControl={state:'running'};f.update();
  const button=(name:string)=>Array.from(f.parent.querySelectorAll('button')).find(b=>b.textContent===name) as HTMLButtonElement;
  assert.ok(button('暂停'));assert.equal(button('暂停').disabled,false);button('暂停').click();assert.equal(toggled,1);
  f.plugin.syncControl.state='paused';f.update();assert.equal(button('继续').disabled,false);
  button('停止').click();assert.equal(stopped,1);
  assert.equal((f.parent.querySelector('input[type="url"]') as HTMLInputElement).disabled,true);
  f.cleanup();
 });
});
