import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import { renderSimpleAliyun } from "../src/settingsAliyunSimple";
import {
  bindAliyunSession,
  aliyunOverwriteBinding,
} from "../src/native/aliyunAuth";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(desktop = true) {
  const dom = new JSDOM("<main></main>");
  const parent = dom.window.document.querySelector("main")!;
  let listener = () => {};
  let preparations = 0,
    syncs = 0;
  const plugin: any = {
    settings: {
      serviceType: "aliyun",
      aliyunNative: {
        session: bindAliyunSession({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 7200,
          user_id: "user",
          default_drive_id: "drive",
        }),
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
      return { ...config, overwriteVerified: aliyunOverwriteBinding(config) };
    },
  };
  const cleanup = renderSimpleAliyun(
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
describe("Guided Aliyun settings", () => {
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
      ["1. 登录阿里云盘", "2. 选择同步文件夹", "3. 开始同步"]
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
    const previous = f.plugin.settings.aliyunNative;
    f.deps.prepare = async () => {
      throw new Error("secret-cookie");
    };
    f.button("prepare").click();
    await tick();
    assert.equal(f.plugin.settings.aliyunNative, previous);
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

describe("Aliyun setup state protection", () => {
  it("rejects an in-flight preparation after settings change", async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    f.deps.prepare = async (config: any, guard: () => void) => {
      await pending;
      guard();
      return { ...config, overwriteVerified: aliyunOverwriteBinding(config) };
    };
    f.button("prepare").click();
    const replacement = {
      session: bindAliyunSession({
        access_token: "other",
        refresh_token: "other",
        expires_in: 7200,
        user_id: "other",
        default_drive_id: "drive",
      }),
      remoteRoot: "/other",
    };
    f.plugin.settings.aliyunNative = replacement;
    release();
    await tick();
    assert.equal(f.plugin.settings.aliyunNative, replacement);
    assert.ok(f.button("sync").disabled);
    f.cleanup();
  });
  it("restores the configuration when persistence fails", async () => {
    const f = fixture(),
      previous = f.plugin.settings.aliyunNative;
    f.plugin.saveSettings = async () => {
      throw new Error("write failure");
    };
    f.button("prepare").click();
    await tick();
    assert.equal(f.plugin.settings.aliyunNative, previous);
    assert.ok(f.button("sync").disabled);
    f.cleanup();
  });
  it("shows empty history without requiring login", async () => {
    const f = fixture();
    f.plugin.settings.aliyunNative = undefined;
    f.plugin.getSyncActivities = async () => {
      throw new Error("must not call");
    };
    (f.parent.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click();
    await tick();
    assert.ok(f.parent.textContent!.includes("还没有同步记录"));
    f.cleanup();
  });
});

describe("Aliyun endpoint diagnostics", () => {
  it("shows the rejected transfer stage and hostname without signed URL parameters", async () => {
    const f = fixture();
    f.deps.prepare = async () => {
      throw Object.assign(
        new Error("https://unknown.example/file?token=secret"),
        {
          code: "untrusted_endpoint",
          stage: "initial_upload",
          endpointInfo: { host: "unknown.example", operation: "download_url" },
        }
      );
    };
    f.button("prepare").click();
    await tick();
    assert.match(f.parent.textContent!, /下载地址.*unknown\.example/);
    assert.ok(!f.parent.textContent!.includes("token=secret"));
    f.cleanup();
  });
});

describe("Aliyun HTTP rejection details", () => {
  it("shows transfer host, operation and safe signature error code", async () => {
    const f = fixture();
    f.deps.prepare = async () => {
      throw Object.assign(new Error("secret-url"), {
        code: "http_403",
        stage: "initial_upload",
        endpointInfo: {
          host: "cn-beijing-data.aliyundrive.net",
          operation: "upload_url",
        },
        responseInfo: {
          host: "cn-beijing-data.aliyundrive.net",
          status: 403,
          expectedBytes: 1048576,
          kind: "other",
          serverCode: "SignatureDoesNotMatch",
        },
      });
    };
    f.button("prepare").click();
    await tick();
    assert.match(f.parent.textContent!, /SignatureDoesNotMatch/);
    assert.match(
      f.parent.textContent!,
      /上传地址.*cn-beijing-data\.aliyundrive\.net/
    );
    assert.ok(!f.parent.textContent!.includes("secret-url"));
    f.cleanup();
  });
});
