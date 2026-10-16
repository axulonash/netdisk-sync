import type { SUPPORTED_SERVICES_TYPE } from "./baseTypes";
import type RemotelySavePlugin from "./main";
import { renderAliyunConnection } from "./settingsAliyunSimple";
import { renderBaiduConnection } from "./settingsBaiduQr";
import { createSettingsFrame } from "./settingsFrame";
import { renderQuarkConnection } from "./settingsQuarkSimple";
import { createRecordsSection } from "./settingsRecords";
import {
  renderAdvancedSection,
  renderBasicSection,
  renderDebugSection,
  renderImportExportSection,
} from "./settingsSections";
import { renderWebdavConnection } from "./settingsWebdavSimple";

/** Services the single page knows how to render a connection for. */
const NATIVE_SERVICES: SUPPORTED_SERVICES_TYPE[] = [
  "webdav",
  "baidu",
  "quark",
  "aliyun",
];

// pro module imports obsidian at load; require it lazily so tests (no obsidian
// package) can still mount the page and only Obsidian renders the ClearDupFiles row.
const loadClearDupFiles = () => {
  try {
    return (
      require("../pro/src/settingsClearDupFiles") as typeof import("../pro/src/settingsClearDupFiles")
    ).generateClearDupFilesSettingsPart;
  } catch (error) {
    console.warn("ClearDupFiles settings part unavailable", error);
    return undefined;
  }
};

/**
 * Assembles the whole native single page for one service: frame (header + four
 * sections) → connection fragment → basic → advanced (advanced + import/export
 * + debug) → sync records. Switching services persists and re-mounts in place.
 */
export function renderSettingsSinglePage(
  containerEl: HTMLElement,
  plugin: RemotelySavePlugin,
  desktop: boolean
): () => void {
  let dispose: () => void = () => {};

  function redisplay() {
    dispose();
    dispose = mount();
  }

  function mount(): () => void {
    const frame = createSettingsFrame(containerEl, plugin, {
      desktop,
      unsupported: !NATIVE_SERVICES.includes(plugin.settings.serviceType),
      // 基本 holds only the webdav automation rows now, so it is skipped for
      // the netdisk services (their page shows 连接 → 高级 → 同步记录).
      showBasic: plugin.settings.serviceType === "webdav",
      onServiceChange: (s) => {
        plugin.settings.serviceType = s;
        void Promise.resolve(plugin.saveSettings())
          .then(() => redisplay())
          .catch(() => {});
      },
    });
    const cleanups: (() => void)[] = [frame.cleanup];

    if (plugin.settings.serviceType === "webdav") {
      cleanups.push(
        renderWebdavConnection(frame.sections.connection, plugin, {
          desktop,
          redisplay,
          setStatus: frame.setStatus,
          setTester: frame.setTester,
        })
      );
    } else if (plugin.settings.serviceType === "baidu") {
      cleanups.push(
        renderBaiduConnection(frame.sections.connection, plugin, {
          desktop,
          redisplay,
          setStatus: frame.setStatus,
          setTester: frame.setTester,
        })
      );
    } else if (plugin.settings.serviceType === "quark") {
      cleanups.push(
        renderQuarkConnection(frame.sections.connection, plugin, {
          desktop,
          redisplay,
          setStatus: frame.setStatus,
          setTester: frame.setTester,
        })
      );
    } else if (plugin.settings.serviceType === "aliyun") {
      cleanups.push(
        renderAliyunConnection(frame.sections.connection, plugin, {
          desktop,
          redisplay,
          setStatus: frame.setStatus,
          setTester: frame.setTester,
        })
      );
    }

    // password + encryption rows now live inside 高级 (renderAdvancedSection)
    if (frame.sections.basic) {
      renderBasicSection(frame.sections.basic, plugin);
    }

    const generateClearDupFiles = loadClearDupFiles();
    renderAdvancedSection(frame.sections.advanced, plugin, {
      desktop,
      renderClearDupFiles: generateClearDupFiles
        ? (el) =>
            generateClearDupFiles(
              el,
              (key, vars) => plugin.i18n.t(key, vars),
              plugin.app,
              plugin
            )
        : undefined,
    });
    renderImportExportSection(frame.sections.advanced, plugin);
    renderDebugSection(frame.sections.advanced, plugin);

    const records = createRecordsSection(frame.sections.records, plugin);
    cleanups.push(records.cleanup);

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }

  dispose = mount();
  return () => dispose();
}
