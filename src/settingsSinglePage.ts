import type { SUPPORTED_SERVICES_TYPE } from "./baseTypes";
import type RemotelySavePlugin from "./main";
import { createSettingsFrame } from "./settingsFrame";
import { createRecordsSection } from "./settingsRecords";
import {
  renderAdvancedSection,
  renderBasicSection,
  renderDebugSection,
  renderImportExportSection,
} from "./settingsSections";
import { renderWebdavConnection } from "./settingsWebdavSimple";
import { renderBaiduConnection } from "./settingsBaiduQr";
import { renderQuarkConnection } from "./settingsQuarkSimple";
import { renderAliyunConnection } from "./settingsAliyunSimple";

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
  } catch {
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
    } else {
      const warning = containerEl.ownerDocument.createElement("p");
      warning.className = "rsnext-service-warning";
      warning.setAttribute("role", "alert");
      warning.textContent = "当前配置的服务已不再支持，请重新选择服务";
      frame.sections.connection.append(warning);
    }

    renderBasicSection(frame.sections.basic, plugin, {
      advancedOnly: false,
      showAutomation: plugin.settings.serviceType === "webdav",
      redisplay,
    });

    const generateClearDupFiles = loadClearDupFiles();
    renderAdvancedSection(frame.sections.advanced, plugin, {
      desktop,
      redisplay,
      advancedOnly: false,
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
