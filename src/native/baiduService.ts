import type { RemotelySavePluginSettings } from "../baseTypes";
import { FakeFsBaidu } from "../fsBaidu";
import type { BaiduConnection } from "./baiduConnection";
import { BaiduProfileError, getBaiduProfileId } from "./baiduProfile";
export const createBaiduSyncClient = (
  connection: BaiduConnection,
  getSettings: () => RemotelySavePluginSettings
): FakeFsBaidu => {
  const initial = getSettings();
  if (initial.serviceType !== "baidu")
    throw new BaiduProfileError("service_changed");
  const profile = getBaiduProfileId(
    initial.baiduNative,
    initial.password ?? "",
    initial.encryptionMethod ?? "unknown"
  );
  if (initial.password && initial.encryptionMethod !== "openssl-base64")
    throw new BaiduProfileError("encryption_not_yet_supported");
  const guard = () => {
    const current = getSettings();
    if (
      current.serviceType !== "baidu" ||
      getBaiduProfileId(
        current.baiduNative,
        current.password ?? "",
        current.encryptionMethod ?? "unknown"
      ) !== profile
    )
      throw new BaiduProfileError("sync_scope_changed");
  };
  return new FakeFsBaidu(connection, initial.baiduNative!.remoteRoot!, guard);
};
