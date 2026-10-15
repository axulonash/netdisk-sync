import { nanoid } from "nanoid";
import { createHash, randomBytes } from "crypto";
import {
  AliyunError,
  aliyunJson,
  aliyunUrl,
  type AliyunTransport,
} from "./aliyunTransport";
export interface AliyunSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  driveId: string;
  identity: string;
  privateKey: string;
  binding: string;
}
export interface AliyunConfig {
  session?: AliyunSession;
  remoteRoot?: string;
  overwriteVerified?: string;
}
export const aliyunDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (s: Omit<AliyunSession, "binding">) =>
  aliyunDigest([
    s.accessToken,
    s.refreshToken,
    s.expiresAt,
    s.userId,
    s.driveId,
    s.identity,
    s.privateKey,
  ]);
const text = (v: any) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 8192 &&
  !/[\r\n\u0000]/.test(v);
export function bindAliyunSession(
  data: any,
  previous?: AliyunSession,
  now = Date.now()
): AliyunSession {
  if (
    !text(data.access_token) ||
    !text(data.refresh_token) ||
    !text(data.user_id) ||
    !text(data.default_drive_id) ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  )
    throw new AliyunError("invalid_session");
  if (
    previous &&
    (data.user_id !== previous.userId ||
      data.default_drive_id !== previous.driveId)
  )
    throw new AliyunError("sync_scope_changed");
  const s = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + data.expires_in * 1000,
    userId: data.user_id,
    driveId: data.default_drive_id,
    identity: previous?.identity ?? nanoid(32),
    privateKey: previous?.privateKey ?? randomBytes(32).toString("hex"),
  };
  return { ...s, binding: binding(s) };
}
export function aliyunSession(config?: AliyunConfig): AliyunSession {
  const s = config?.session;
  if (
    !s ||
    !text(s.accessToken) ||
    !text(s.refreshToken) ||
    !text(s.userId) ||
    !text(s.driveId) ||
    !/^[\w-]{32}$/.test(s.identity) ||
    !/^[a-f0-9]{64}$/.test(s.privateKey) ||
    !Number.isFinite(s.expiresAt) ||
    s.binding !== binding(s)
  )
    throw new AliyunError("login_required");
  return s;
}
export function aliyunKey(value: string): string[] {
  if (
    typeof value !== "string" ||
    !value ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new AliyunError("invalid_path");
  const parts = (value.endsWith("/") ? value.slice(0, -1) : value).split("/");
  if (parts.some((p) => !p || p === "." || p === ".."))
    throw new AliyunError("invalid_path");
  try {
    encodeURIComponent(value);
  } catch {
    throw new AliyunError("invalid_path");
  }
  return parts;
}
export function aliyunRoot(value: string) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/")
    throw new AliyunError("invalid_root");
  const root = value.endsWith("/") ? value.slice(0, -1) : value;
  aliyunKey(root.slice(1));
  return root;
}
export function getAliyunProfileId(
  config: AliyunConfig | undefined,
  password: string,
  method: string
) {
  const s = aliyunSession(config);
  if (password && method !== "openssl-base64")
    throw new AliyunError("encryption_not_yet_supported");
  return `aliyun-v1-${aliyunDigest([s.identity, s.userId, s.driveId, aliyunRoot(config?.remoteRoot ?? ""), password, password ? method : "none"])}`;
}
export function aliyunOverwriteBinding(config: AliyunConfig) {
  const s = aliyunSession(config);
  return aliyunDigest([
    s.identity,
    s.userId,
    s.driveId,
    aliyunRoot(config.remoteRoot ?? ""),
    "overwrite-readback-v1",
  ]);
}
export async function refreshAliyun(
  transport: AliyunTransport,
  refreshToken: string,
  previous?: AliyunSession
) {
  const result = aliyunJson(
    await transport({
      url: "https://auth.alipan.com/v2/account/token",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    })
  );
  if (result.code) throw new AliyunError("login_required");
  if (!result.default_drive_id && result.access_token) {
    const user = aliyunJson(
      await transport({
        url: "https://api.alipan.com/v2/user/get",
        method: "POST",
        headers: {
          Authorization: `Bearer ${result.access_token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    );
    result.default_drive_id = user.default_drive_id;
    result.user_id ??= user.user_id;
  }
  return bindAliyunSession(result, previous);
}
export class AliyunQrLogin {
  private draft?: { t: string; ck: string; expires: number };
  private revision = 0;
  private busy = false;
  private readonly cookies = new Map<string, string>();
  constructor(
    private readonly transport: AliyunTransport,
    private readonly now = Date.now
  ) {}
  private async request(action: string, body?: string) {
    const revision = this.revision;
    const params = new URLSearchParams({
      appName: "aliyun_drive",
      fromSite: "52",
      appEntrance: "web",
      _csrf_token: "undefined",
      umidToken: "undefined",
      isMobile: "false",
      lang: "zh_CN",
      returnUrl: "",
      hsiz: "1d3d3f3d3f3f",
      navlanguage: "zh-CN",
      navPlatform: "MacIntel",
    });
    const r = await this.transport({
      url: `https://passport.aliyundrive.com/newlogin/qrcode/${action}.do?${params}`,
      method: body ? "POST" : "GET",
      headers: {
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
        ...(this.cookies.size
          ? {
              Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            }
          : {}),
      },
      body,
    });
    if (revision !== this.revision) throw new AliyunError("qr_expired");
    for (const raw of r.cookies) {
      const [pair, ...attributes] = raw.split(";");
      const match = /^([\w-]+)=([^\r\n;]*)$/.exec(pair.trim());
      if (!match) continue;
      const attribute = (name: string) =>
        attributes
          .find((a) =>
            a
              .trim()
              .toLowerCase()
              .startsWith(name + "=")
          )
          ?.trim()
          .slice(name.length + 1)
          .trim();
      const domain = attribute("domain")?.toLowerCase().replace(/^\./, "");
      if (
        domain &&
        !["aliyundrive.com", "passport.aliyundrive.com"].includes(domain)
      )
        continue;
      const path = attribute("path");
      if (
        path &&
        path !== "/" &&
        !"/newlogin/qrcode/".startsWith(path.endsWith("/") ? path : path + "/")
      )
        continue;
      const maxAge = attribute("max-age"),
        expires = attribute("expires");
      const expired =
        maxAge && /^-?\d+$/.test(maxAge)
          ? Number(maxAge) <= 0
          : expires
            ? Date.parse(expires) <= this.now()
            : false;
      if (!match[2] || expired) this.cookies.delete(match[1]);
      else this.cookies.set(match[1], match[2]);
    }
    return aliyunJson(r).content?.data;
  }
  async start() {
    if (this.busy) throw new AliyunError("login_busy");
    this.busy = true;
    this.revision++;
    this.draft = undefined;
    this.cookies.clear();
    try {
      const d = await this.request("generate");
      if (
        !d ||
        !["string", "number"].includes(typeof d.t) ||
        !text(d.ck) ||
        !text(d.codeContent)
      )
        throw new AliyunError("invalid_qr_token");
      const url = aliyunUrl(d.codeContent);
      if (
        !["alipan.com", "aliyundrive.com"].some(
          (d) => url.hostname === d || url.hostname.endsWith(`.${d}`)
        )
      )
        throw new AliyunError("untrusted_endpoint");
      this.draft = { t: String(d.t), ck: d.ck, expires: this.now() + 300000 };
      return url.href;
    } finally {
      this.busy = false;
    }
  }
  async check() {
    if (this.busy) throw new AliyunError("login_busy");
    const draft = this.draft,
      revision = this.revision;
    if (!draft || draft.expires <= this.now())
      throw new AliyunError("qr_expired");
    this.busy = true;
    try {
      const d = await this.request(
        "query",
        new URLSearchParams({ t: draft.t, ck: draft.ck }).toString()
      );
      if (["NEW", "SCANED"].includes(d?.qrCodeStatus)) return undefined;
      if (d?.qrCodeStatus !== "CONFIRMED" || !text(d.bizExt))
        throw new AliyunError("qr_expired");
      let token: string;
      try {
        const bytes = Buffer.from(d.bizExt, "base64");
        let result: any;
        try {
          result = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          result = JSON.parse(new TextDecoder("gb18030").decode(bytes));
        }
        token = result.pds_login_result.refreshToken;
        if (!text(token)) throw 0;
      } catch {
        throw new AliyunError("invalid_session");
      }
      const session = await refreshAliyun(this.transport, token);
      if (this.revision !== revision) throw new AliyunError("qr_expired");
      this.draft = undefined;
      this.cookies.clear();
      return session;
    } finally {
      this.busy = false;
    }
  }
  cancel() {
    this.revision++;
    this.draft = undefined;
    this.cookies.clear();
  }
}
