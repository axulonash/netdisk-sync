import {createBaiduWebSyncClient} from './native/baiduWebService';
import type {BaiduWebProbeTransport} from './native/baiduWebProbe';
import { createAliyunSyncClient } from "./native/aliyunService";
import { AliyunError, type AliyunTransport } from "./native/aliyunTransport";
import { FakeFsAzureBlobStorage } from "../pro/src/fsAzureBlobStorage";
import { FakeFsBox } from "../pro/src/fsBox";
import { FakeFsGoogleDrive } from "../pro/src/fsGoogleDrive";
import { FakeFsKoofr } from "../pro/src/fsKoofr";
import { FakeFsOnedriveFull } from "../pro/src/fsOnedriveFull";
import { FakeFsPCloud } from "../pro/src/fsPCloud";
import { FakeFsYandexDisk } from "../pro/src/fsYandexDisk";
import type { RemotelySavePluginSettings } from "./baseTypes";
import type { FakeFs } from "./fsAll";
import { FakeFsDropbox } from "./fsDropbox";
import { FakeFsOnedrive } from "./fsOnedrive";
import { FakeFsS3 } from "./fsS3";
import { FakeFsWebdav } from "./fsWebdav";
import { FakeFsWebdis } from "./fsWebdis";
import { createBaiduSyncClient } from "./native/baiduService";
import type { BaiduConnection } from "./native/baiduConnection";
import { BaiduProfileError } from "./native/baiduProfile";
import { createQuarkSyncClient } from "./native/quarkService";
import { QuarkError, type QuarkTransport } from "./native/quarkTransport";

/**
 * To avoid circular dependency, we need a new file here.
 */
export function getClient(
  settings: RemotelySavePluginSettings,
  vaultName: string,
  saveUpdatedConfigFunc: () => Promise<any>,
  native?: {
    baiduConnection?: BaiduConnection;
    baiduWebTransport?: BaiduWebProbeTransport;
    aliyunTransport?: AliyunTransport;
    quarkTransport?: QuarkTransport;
    getSettings: () => RemotelySavePluginSettings;
  }
): FakeFs {
  switch (settings.serviceType) {
    case "baidu":
      if(native?.baiduWebTransport)return createBaiduWebSyncClient(native.getSettings,native.baiduWebTransport);
      if (!native?.baiduConnection) throw new BaiduProfileError("desktop_connection_required");
      return createBaiduSyncClient(native.baiduConnection, native.getSettings);
    case "aliyun":
      if (!native?.aliyunTransport) throw new AliyunError("desktop_required");
      return createAliyunSyncClient(native.getSettings, native.aliyunTransport, saveUpdatedConfigFunc);
    case "quark":
      if (!native?.quarkTransport) throw new QuarkError("desktop_required");
      return createQuarkSyncClient(native.getSettings, native.quarkTransport);
    case "s3":
      return new FakeFsS3(settings.s3);
    case "webdav":
      return new FakeFsWebdav(
        settings.webdav,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "dropbox":
      return new FakeFsDropbox(
        settings.dropbox,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "onedrive":
      return new FakeFsOnedrive(
        settings.onedrive,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "onedrivefull":
      return new FakeFsOnedriveFull(
        settings.onedrivefull,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "webdis":
      return new FakeFsWebdis(
        settings.webdis,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "googledrive":
      return new FakeFsGoogleDrive(
        settings.googledrive,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "box":
      return new FakeFsBox(settings.box, vaultName, saveUpdatedConfigFunc);
    case "pcloud":
      return new FakeFsPCloud(
        settings.pcloud,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "yandexdisk":
      return new FakeFsYandexDisk(
        settings.yandexdisk,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "koofr":
      return new FakeFsKoofr(settings.koofr, vaultName, saveUpdatedConfigFunc);
    case "azureblobstorage":
      return new FakeFsAzureBlobStorage(settings.azureblobstorage, vaultName);
    default:
      throw Error(`cannot init client for serviceType=${settings.serviceType}`);
  }
}
