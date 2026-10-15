import { Platform, requestUrl } from "obsidian";
import type RemotelySavePlugin from "../main";
import { BaiduConnection, createBaiduJsonTransport } from "./baiduConnection";
import { createDesktopBaiduTransport } from "./baiduDesktopTransport";
import { createDesktopBaiduUploadTransport } from "./baiduDesktopUpload";
export const getBaiduPluginConnection = (
  plugin: RemotelySavePlugin
): BaiduConnection =>
  (plugin.baiduConnection ??= new BaiduConnection({
    getConfig: () => plugin.settings.baiduNative,
    saveConfig: async (config) => {
      const previous = plugin.settings.baiduNative;
      plugin.settings.baiduNative = config;
      try {
        await plugin.saveSettings();
      } catch (error) {
        if (plugin.settings.baiduNative === config)
          plugin.settings.baiduNative = previous;
        throw error;
      }
    },
    transport: createBaiduJsonTransport(requestUrl),
    binary: createDesktopBaiduTransport(Platform.isDesktopApp),
    upload: Platform.isDesktopApp
      ? createDesktopBaiduUploadTransport(true)
      : undefined,
  }));
