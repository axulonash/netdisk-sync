import { createHash } from "crypto";
import type { CipherMethodType } from "../baseTypes";
import type { BaiduConnectionConfig } from "./baiduConnection";
import { baiduSyncRoot } from "./baiduPath";
export class BaiduProfileError extends Error {
  constructor(
    public readonly code: string,
    public readonly outcomeUnknown = false
  ) {
    super(`Baidu sync configuration failed (${code})`);
    this.name = "BaiduProfileError";
  }
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (config: BaiduConnectionConfig) =>
  digest([
    config.app.clientId,
    config.app.clientSecret,
    config.app.redirectUri,
    config.tokens?.accessToken,
    config.tokens?.refreshToken,
    config.tokens?.expiresAt,
  ]);
export const bindBaiduIdentity = (
  config: BaiduConnectionConfig,
  accountId: string
): BaiduConnectionConfig => {
  if (!/^[A-Za-z0-9_-]{32}$/.test(accountId))
    throw new BaiduProfileError("invalid_identity");
  return {
    ...config,
    syncIdentity: { accountId, credentialBinding: binding(config) },
  };
};
export const validateBaiduIdentity = (config: BaiduConnectionConfig): void => {
  if (
    !config.syncIdentity ||
    !/^[A-Za-z0-9_-]{32}$/.test(config.syncIdentity.accountId)
  )
    throw new BaiduProfileError("reauthorize_required");
  if (config.syncIdentity.credentialBinding !== binding(config))
    throw new BaiduProfileError("credential_binding_mismatch");
};
export const getBaiduProfileId = (
  config: BaiduConnectionConfig | undefined,
  password: string,
  method: CipherMethodType
): string => {
  if (!config?.tokens) throw new BaiduProfileError("not_logged_in");
  validateBaiduIdentity(config);
  if (!config.remoteRoot) throw new BaiduProfileError("remote_root_required");
  const root = baiduSyncRoot(config.remoteRoot);
  if (password && method !== "openssl-base64" && method !== "rclone-base64")
    throw new BaiduProfileError("invalid_encryption_method");
  return `baidu-v1-${digest([config.syncIdentity!.accountId, config.app.clientId, root, password, password ? method : "none"])}`;
};
