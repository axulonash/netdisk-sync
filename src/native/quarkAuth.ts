import { nanoid } from "nanoid";
import { createHash } from "crypto";
import { QuarkError, quarkJson, type QuarkTransport } from "./quarkTransport";

export interface QuarkConfig {
  session?: { cookie: string; identity: string; binding: string };
  remoteRoot?: string;
  overwriteVerified?: string;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function bindQuarkSession(cookie: string, identity = nanoid(32)) {
  if (!cookie || /[\r\n]/.test(cookie) || !/^[\w-]{32}$/.test(identity))
    throw new QuarkError("invalid_session");
  return { cookie, identity, binding: digest([cookie, identity]) };
}
export function quarkSession(config?: QuarkConfig) {
  const session = config?.session;
  if (
    !session ||
    session.binding !== digest([session.cookie, session.identity]) ||
    !/^[\w-]{32}$/.test(session.identity) ||
    !session.cookie ||
    /[\r\n]/.test(session.cookie)
  )
    throw new QuarkError("login_required");
  return session;
}
export function quarkRoot(value: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value === "/" ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new QuarkError("invalid_root");
  const root = value.endsWith("/") ? value.slice(0, -1) : value;
  quarkKey(root.slice(1));
  return root;
}
export function quarkKey(value: string): string[] {
  if (!value || /[\u0000-\u001f\u007f]/.test(value))
    throw new QuarkError("invalid_path");
  const parts = (value.endsWith("/") ? value.slice(0, -1) : value).split("/");
  if (parts.some((p) => !p || p === "." || p === ".."))
    throw new QuarkError("invalid_path");
  try {
    encodeURIComponent(value);
  } catch {
    throw new QuarkError("invalid_path");
  }
  return parts;
}
export function getQuarkProfileId(
  config: QuarkConfig | undefined,
  password: string,
  method: string
) {
  const session = quarkSession(config);
  const root = quarkRoot(config?.remoteRoot ?? "");
  if (password && method !== "openssl-base64")
    throw new QuarkError("encryption_not_yet_supported");
  return `quark-v1-${digest([session.identity, root, password, password ? method : "none"])}`;
}
export function quarkOverwriteBinding(config: QuarkConfig) {
  const session = quarkSession(config);
  return digest([
    session.identity,
    session.binding,
    quarkRoot(config.remoteRoot ?? ""),
    "staged-replacement-probe-v2",
  ]);
}
// The QR token and service ticket are short-lived. They are never saved or logged.
export class QuarkQrLogin {
  private draft?: { token: string; expires: number };
  private busy = false;
  private readonly cookies = new Map<string, string>();
  private revision = 0;
  constructor(
    private readonly transport: QuarkTransport,
    private readonly now = Date.now
  ) {}
  private async cas(action: string, token?: string) {
    const revision = this.revision;
    const url = new URL(`https://uop.quark.cn/cas/ajax/${action}`);
    url.search = new URLSearchParams({
      client_id: "532",
      v: "1.2",
      request_id: nanoid(32),
      ...(token ? { token } : {}),
    }).toString();
    const response = await this.transport({ url: url.href, method: "GET" });
    if (revision !== this.revision) throw new QuarkError("qr_expired");
    this.captureCookies(response.cookies);
    return quarkJson(response);
  }
  private captureCookies(rawCookies: string[]) {
    for (const raw of rawCookies) {
      const [pair, ...attributes] = raw.split(";");
      const match = /^([!#$%&'*+.^_`|~\w-]+)=([^\r\n;]*)$/.exec(pair.trim());
      if (!match) continue;
      const domain = attributes
        .find((a) => /^\s*domain=/i.test(a))
        ?.split("=")[1]
        ?.trim()
        .toLowerCase();
      // Only domain cookies usable by drive-pc.quark.cn; never forward host-only
      // pan.quark.cn cookies to the file API.
      if (domain !== ".quark.cn" && domain !== "quark.cn") continue;
      const path = attributes
        .find((a) => /^\s*path=/i.test(a))
        ?.split("=")[1]
        ?.trim();
      if (path && path !== "/") continue;
      const maxAge = attributes
        .find((a) => /^\s*max-age=/i.test(a))
        ?.split("=")[1]
        ?.trim();
      const expires = attributes
        .find((a) => /^\s*expires=/i.test(a))
        ?.slice(
          attributes.find((a) => /^\s*expires=/i.test(a))!.indexOf("=") + 1
        )
        .trim();
      const expired =
        maxAge && /^-?\d+$/.test(maxAge)
          ? Number(maxAge) <= 0
          : expires
            ? Date.parse(expires) <= this.now()
            : false;
      if (match[2] && !expired) this.cookies.set(match[1], match[2]);
      else this.cookies.delete(match[1]);
    }
  }
  async start(): Promise<string> {
    if (this.busy) throw new QuarkError("login_busy");
    this.busy = true;
    this.revision++;
    this.draft = undefined;
    this.cookies.clear();
    try {
      const result = await this.cas("getTokenForQrcodeLogin");
      const token = result.data?.members?.token;
      if (
        result.status !== 2000000 ||
        typeof token !== "string" ||
        !token ||
        token.length > 4096
      )
        throw new QuarkError("invalid_qr_token");
      this.draft = { token, expires: this.now() + 5 * 60 * 1000 };
      const qr = new URL("https://su.quark.cn/4_eMHBJ");
      qr.search = new URLSearchParams({
        token,
        client_id: "532",
        ssb: "weblogin",
        uc_param_str: "",
        uc_biz_str: "S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0",
      }).toString();
      return qr.href;
    } finally {
      this.busy = false;
    }
  }
  cancel() {
    this.revision++;
    this.draft = undefined;
    this.cookies.clear();
  }
  async check(): Promise<ReturnType<typeof bindQuarkSession> | undefined> {
    if (this.busy) throw new QuarkError("login_busy");
    const draft = this.draft;
    if (!draft || this.now() >= draft.expires) {
      this.cancel();
      throw new QuarkError("qr_expired");
    }
    this.busy = true;
    try {
      const result = await this.cas(
        "getServiceTicketByQrcodeToken",
        draft.token
      );
      if (this.draft !== draft || this.now() >= draft.expires)
        throw new QuarkError("qr_expired");
      if (result.status === 50004001) return undefined;
      if (result.status === 50004002) {
        this.cancel();
        throw new QuarkError("qr_expired");
      }
      const ticket = result.data?.members?.service_ticket;
      if (
        result.status !== 2000000 ||
        typeof ticket !== "string" ||
        !ticket ||
        ticket.length > 4096
      )
        throw new QuarkError("invalid_service_ticket");
      const url = new URL("https://pan.quark.cn/account/info");
      url.search = new URLSearchParams({ st: ticket, lw: "scan" }).toString();
      const response = await this.transport({ url: url.href, method: "GET" });
      const account = quarkJson(response);
      if (this.draft !== draft || this.now() >= draft.expires)
        throw new QuarkError("qr_expired");
      if (account.success !== true) throw new QuarkError("login_rejected");
      this.captureCookies(response.cookies);
      if (!this.cookies.has("__puus") && !this.cookies.has("__pus"))
        throw new QuarkError("session_cookie_missing");
      const session = bindQuarkSession(
        [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
      );
      this.cancel();
      return session;
    } finally {
      this.busy = false;
    }
  }
}
