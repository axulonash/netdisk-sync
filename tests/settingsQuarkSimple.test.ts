import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import { renderSimpleQuark } from "../src/settingsQuarkSimple";
import {
  bindQuarkSession,
  quarkOverwriteBinding,
} from "../src/native/quarkAuth";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(desktop = true) {
  const dom = new JSDOM("<main></main>");
  const parent = dom.window.document.querySelector("main")!;
  let listener = () => {};
  let preparations = 0,
    syncs = 0;
  const plugin: any = {
    settings: {
      serviceType: "quark",
      quarkNative: {
        session: bindQuarkSession("__puus=secret"),
        remoteRoot: "/notes",
      },
      conflictAction: "keep_both",
    },
    app: { vault: { getName: () => "vault" } },
    isSyncing: false,
    nativeMaintenance: false,
    syncUiStatus: "尚未同步",
    saveSettings: async () => {},
    onSyncUiUpdate: (f: any) => {
      listener = f;
      return () => {};
    },
    updateSyncUi: () => listener(),
    getSyncActivities: async () => [],
    syncRun: async () => {
      syncs++;
    },
  };
  const deps: any = {
    openLogin: () => () => {},
    prepare: async (config: any) => {
      preparations++;
      return { ...config, overwriteVerified: quarkOverwriteBinding(config) };
    },
  };
  const cleanup = renderSimpleQuark(
    parent,
    plugin,
    deps,
    () => {},
    () => {},
    desktop
  );
  const button = (action: string) =>
    parent.querySelector(`[data-action="${action}"]`) as HTMLButtonElement;
  return {
    plugin,
    parent,
    dom,
    button,
    deps,
    cleanup,
    get preparations() {
      return preparations;
    },
    get syncs() {
      return syncs;
    },
  };
}
describe("Guided Quark settings", () => {
  it("places service radios first and shows three ordered steps", () => {
    const f = fixture();
    assert.ok(
      f.parent.firstElementChild!.firstElementChild!.classList.contains(
        "rsnext-service-picker"
      )
    );
    assert.deepEqual(
      Array.from(f.parent.querySelectorAll(".rsnext-setup-step h3")).map(
        (n) => n.textContent
      ),
      ["1. 登录夸克网盘", "2. 选择同步文件夹", "3. 开始同步"]
    );
    assert.ok(f.button("sync").disabled);
    f.cleanup();
  });
  it("prepares and verifies the selected root before enabling sync", async () => {
    const f = fixture();
    f.button("prepare").click();
    await tick();
    assert.equal(f.preparations, 1);
    assert.equal(f.button("sync").disabled, false);
    f.button("sync").click();
    await tick();
    assert.equal(f.syncs, 1);
    const input = f.parent.querySelector(
      '[data-field="remoteRoot"]'
    ) as HTMLInputElement;
    input.value = "/other";
    input.dispatchEvent(new f.dom.window.Event("input"));
    assert.ok(f.button("sync").disabled);
    f.cleanup();
  });
  it("retains the old configuration on preparation failure and masks secrets", async () => {
    const f = fixture();
    const previous = f.plugin.settings.quarkNative;
    f.deps.prepare = async () => {
      throw new Error("secret-cookie");
    };
    f.button("prepare").click();
    await tick();
    assert.equal(f.plugin.settings.quarkNative, previous);
    assert.ok(!f.parent.textContent!.includes("secret-cookie"));
    assert.ok(f.button("sync").disabled);
    f.cleanup();
  });
  it("hands mobile setup off to desktop without making requests", async () => {
    const f = fixture(false);
    assert.equal(
      (f.parent.querySelector(".rsnext-mobile-guide") as HTMLElement).hidden,
      false
    );
    assert.ok(f.button("prepare").disabled);
    f.button("prepare").click();
    await tick();
    assert.equal(f.preparations, 0);
    assert.ok(f.button("sync").disabled);
    f.cleanup();
  });
});

describe("Quark setup state protection", () => {
  it("rejects an in-flight preparation after settings change", async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    f.deps.prepare = async (config: any, guard: () => void) => {
      await pending;
      guard();
      return { ...config, overwriteVerified: quarkOverwriteBinding(config) };
    };
    f.button("prepare").click();
    const replacement = {
      session: bindQuarkSession("__puus=other"),
      remoteRoot: "/other",
    };
    f.plugin.settings.quarkNative = replacement;
    release();
    await tick();
    assert.equal(f.plugin.settings.quarkNative, replacement);
    assert.ok(f.button("sync").disabled);
    f.cleanup();
  });
  it("restores the configuration when persistence fails", async () => {
    const f = fixture(),
      previous = f.plugin.settings.quarkNative;
    f.plugin.saveSettings = async () => {
      throw new Error("write failure");
    };
    f.button("prepare").click();
    await tick();
    assert.equal(f.plugin.settings.quarkNative, previous);
    assert.ok(f.button("sync").disabled);
    f.cleanup();
  });
  it("shows empty history without requiring login", async () => {
    const f = fixture();
    f.plugin.settings.quarkNative = undefined;
    f.plugin.getSyncActivities = async () => {
      throw new Error("must not call");
    };
    (f.parent.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click();
    await tick();
    assert.ok(f.parent.textContent!.includes("还没有同步记录"));
    f.cleanup();
  });
});

describe("Quark setup error diagnosis", () => {
  it("identifies a rejected upload endpoint without exposing raw URLs", async () => {
    const f = fixture();
    f.deps.prepare = async () => {
      throw Object.assign(new Error("https://secret-token"), {
        code: "invalid_oss_endpoint",
      });
    };
    f.button("prepare").click();
    await tick();
    assert.match(f.parent.textContent!, /上传地址/);
    assert.ok(!f.parent.textContent!.includes("secret-token"));
    f.cleanup();
  });
});

describe("Quark probe exact safe diagnostics", () => {
  it("shows missing-after-upload error code and probe stage rather than a generic hint", async () => {
    const f = fixture();
    f.deps.prepare = async () => {
      throw Object.assign(new Error("secret-url"), {
        code: "not_found",
        stage: "initial_upload",
      });
    };
    f.button("prepare").click();
    await tick();
    assert.match(f.parent.textContent!, /not_found/);
    assert.match(f.parent.textContent!, /首次上传/);
    assert.ok(!f.parent.textContent!.includes("secret-url"));
    f.cleanup();
  });
});

describe("Quark response details in settings", () => {
  it("shows safe response size and type details without raw credentials", async () => {
    const f = fixture();
    f.deps.prepare = async () => {
      throw Object.assign(new Error("secret-token"), {
        code: "response_too_large",
        stage: "initial_upload",
        responseInfo: {
          host: "dl-pc-zb.pds.quark.cn",
          status: 200,
          expectedBytes: 4,
          announcedBytes: 1000,
          kind: "html",
        },
      });
    };
    f.button("prepare").click();
    await tick();
    assert.match(f.parent.textContent!, /HTML 页面/);
    assert.match(f.parent.textContent!, /上限 4 B \/ 返回 1000 B/);
    assert.ok(!f.parent.textContent!.includes("secret-token"));
    f.cleanup();
  });
});

describe("Quark refreshed-session rejection details", () => {
  for (const serverCode of ["AccessDenied", "secret-server-code"])
    it(`shows login-header evidence and filters ${serverCode}`, async () => {
      const f = fixture();
      f.deps.prepare = async () => {
        throw Object.assign(new Error("secret-token"), {
          code: "http_403",
          stage: "initial_upload",
          responseInfo: {
            host: "dl-pc-zd-pds.quark.cn",
            status: 403,
            expectedBytes: 4,
            announcedBytes: 376,
            kind: "other",
            cookieSent: true,
            serverCode,
          },
        });
      };
      f.button("prepare").click();
      await tick();
      assert.match(f.parent.textContent!, /已携带登录态/);
      assert.match(f.parent.textContent!, /\[http_403\]/);
      if (serverCode === "AccessDenied")
        assert.match(f.parent.textContent!, /AccessDenied/);
      assert.ok(!f.parent.textContent!.includes("secret"));
      f.cleanup();
    });
});

describe("Quark rename operation diagnostics", () => {
  for (const operation of [
    "backup_rename",
    "secret-operation",
    "constructor",
    "__proto__",
  ])
    it(`shows only safe operation labels for ${operation}`, async () => {
      const f = fixture();
      f.deps.prepare = async () => {
        throw Object.assign(new Error("secret-body"), {
          code: "http_400",
          stage: "overwrite",
          operation,
        });
      };
      f.button("prepare").click();
      await tick();
      assert.match(f.parent.textContent!, /HTTP 400/);
      if (operation === "backup_rename")
        assert.match(f.parent.textContent!, /旧文件备份改名/);
      assert.ok(!f.parent.textContent!.includes("secret"));
      f.cleanup();
    });
});

