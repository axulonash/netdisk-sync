import {reportTransferBytes} from '../transferSpeed';
import {trackNativeUpload,nativeRequestState} from './transferTelemetry';
import { nativeHttpsAgent, nativeTransferTimeout } from "./httpsPool";
import type { ClientRequest, IncomingMessage } from "http";
import type { NodeHttpsRequest } from "./baiduDesktopTransport";

export type QuarkProbeStage = "initial_upload" | "overwrite" | "cleanup";
export type QuarkProviderStage = "upload_prepare" | "upload_hash" | "upload_authorize" | "upload_part" | "upload_commit" | "upload_finish" | "upload_confirm";
export interface QuarkResponseInfo {
  host: string;
  status: number;
  expectedBytes: number;
  announcedBytes?: number;
  cookieSent?: boolean;
  serverCode?: string;
  kind: "html" | "json" | "binary" | "text" | "other";
}
export class QuarkError extends Error {
  operation?:
    | "rename_conflict_probe"
    | "backup_rename"
    | "publish_rename"
    | "published_validation"
    | "backup_cleanup"
    | "rollback_rename";
  responseInfo?: QuarkResponseInfo;
  stage?: QuarkProbeStage;
  providerStage?: QuarkProviderStage;
  constructor(
    public readonly code: string,
    public readonly outcomeUnknown = false
  ) {
    super(`Quark operation failed (${code})`);
    this.name = "QuarkError";
  }
}
export interface QuarkRequest {
  signal?:AbortSignal;
  url: string;
  method: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  maxBytes?: number;
}
export interface QuarkResponse {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body: Uint8Array;
}
export type QuarkTransport = (request: QuarkRequest) => Promise<QuarkResponse>;
export const QUARK_SAFE_SERVER_CODES = new Set([
  "AccessDenied",
  "AccessForbidden",
  "SignatureDoesNotMatch",
  "InvalidAccessKeyId",
  "RequestTimeTooSkewed",
  "ExpiredToken",
  "InvalidSecurityToken",
  "SecurityTokenExpired",
  "NoSuchKey",
  "InvalidArgument",
  "AuthenticationFailed",
  "InvalidCookie",
  "InvalidUserAgent",
  "UserAgentNotMatch",
  "TokenExpired",
]);
const within = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);
export const QUARK_DRIVE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
export function quarkSessionHost(host: string): boolean {
  return (
    ["pan.quark.cn", "drive-pc.quark.cn"].includes(host) ||
    /^dl-[a-z0-9-]+[.-](pds|drive)\.quark\.cn$/.test(host)
  );
}
export function quarkUploadHost(host: string): boolean {
  return (
    within(host, "aliyuncs.com") ||
    /^[a-z0-9][a-z0-9-]{1,62}\.pds\.quark\.cn$/.test(host)
  );
}
export function quarkUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new QuarkError("invalid_url");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !["quark.cn", "uc.cn", "aliyuncs.com"].some((d) => within(url.hostname, d))
  )
    throw new QuarkError("untrusted_endpoint");
  return url;
}
// Desktop only: receive Set-Cookie without a browser, and never follow redirects
// with credentials. A total deadline covers headers AND the complete response.
export function createDesktopQuarkTransport(
  desktop: boolean,
  load: () => NodeHttpsRequest = () => require("node:https").request
): QuarkTransport {
  return async (request) => {
    if (!desktop) throw new QuarkError("desktop_required");
    if(request.signal?.aborted)throw new QuarkError("sync_cancelled");
    const url = quarkUrl(request.url);
    const limit = request.maxBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64 * 1024 * 1024)
      throw new QuarkError("invalid_limits");
    const headers = { ...request.headers, "Accept-Encoding": "identity" };
    for (const name of Object.keys(headers)) {
      if (/^(cookie|authorization)$/i.test(name)) {
        if (
          name.toLowerCase() === "cookie" &&
          (!quarkSessionHost(url.hostname) ||
            (request.method !== "GET" &&
              !["pan.quark.cn", "drive-pc.quark.cn"].includes(url.hostname)))
        )
          throw new QuarkError("credential_destination");
        if (
          name.toLowerCase() === "authorization" &&
          !quarkUploadHost(url.hostname)
        )
          throw new QuarkError("credential_destination");
      }
    }
    return new Promise((resolve, reject) => {
      let outgoing: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let settled = false;
      const diagnostics=nativeRequestState(request.body instanceof Uint8Array?request.body.byteLength:typeof request.body==='string'?new TextEncoder().encode(request.body).length:0);
      let stopUpload:(()=>void)|undefined;
      const abort=()=>fail("sync_cancelled");
      const cleanup=()=>{stopUpload?.();clearTimeout(timer);request.signal?.removeEventListener("abort",abort);};
      let responseInfo: QuarkResponseInfo | undefined;
      const timer = setTimeout(() => {diagnostics.state.timeout="total";fail("request_timeout");}, Math.max(request.method==="GET"?60000:180000,nativeTransferTimeout(Math.max(limit, request.body instanceof Uint8Array ? request.body.byteLength : 0))));
      request.signal?.addEventListener("abort",abort,{once:true});
      const fail = (code: string,networkCode?:string) => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = Object.assign(new QuarkError(code, request.method !== "GET"),{transfer:diagnostics.snapshot(),networkCode:code==="request_timeout"?"ETIMEDOUT":["ECONNRESET","ECONNABORTED","ETIMEDOUT"].includes(networkCode??"")?networkCode:undefined});
        error.responseInfo = responseInfo;
        reject(error);
        incoming?.destroy();
        outgoing?.destroy();
      };
      try {
        outgoing = load()(
          url,
          {
            method: request.method,
            headers,
            agent: nativeHttpsAgent(),
            rejectUnauthorized: true,
          },
          (response) => {
            if(settled){response.destroy();return;}
            incoming = response;diagnostics.state.phase="receiving_response";outgoing?.setTimeout?.(30000);
            response.once("error", () => fail("incomplete_response"));
            response.once("aborted", () => fail("incomplete_response"));
            response.once("close", () => {
              if (!settled) fail("incomplete_response");
            });
            const responseHeaders: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers))
              if (typeof value === "string") responseHeaders[name] = value;
            if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
              settled = true;
              cleanup();
              resolve({
                status: response.statusCode!,
                headers: responseHeaders,
                cookies: [],
                body: new Uint8Array(),
              });
              response.destroy();
              outgoing?.destroy();
              return;
            }
            const length = responseHeaders["content-length"];
            const type = (responseHeaders["content-type"] ?? "")
              .split(";")[0]
              .trim()
              .toLowerCase();
            responseInfo = {
              host: url.hostname,
              status: response.statusCode ?? 0,
              expectedBytes: limit,
              cookieSent: Object.entries(headers).some(
                ([name, value]) =>
                  name.toLowerCase() === "cookie" && Boolean(value)
              ),
              ...(length &&
              /^\d+$/.test(length) &&
              Number.isSafeInteger(Number(length))
                ? { announcedBytes: Number(length) }
                : {}),
              kind:
                type === "text/html"
                  ? "html"
                  : type === "application/json"
                    ? "json"
                    : type === "application/octet-stream"
                      ? "binary"
                      : type === "text/plain"
                        ? "text"
                        : "other",
            };
            if (
              request.method === "GET" &&
              responseInfo.status >= 400 &&
              responseInfo.status <= 599
            ) {
              const errorCode = `http_${responseInfo.status}`;
              // Error XML has its own small diagnostic budget. Never expose
              // raw response text, links, request IDs or arbitrary server codes.
              if (
                !["application/xml", "text/xml"].includes(type) ||
                (responseHeaders["content-encoding"] &&
                  responseHeaders["content-encoding"] !== "identity") ||
                (length !== undefined &&
                  (!/^\d+$/.test(length) || Number(length) > 4096))
              )
                return fail(errorCode);
              let total = 0;
              const chunks: Uint8Array[] = [];
              response.on("data", (chunk: Uint8Array) => {
                total += chunk.byteLength;
                if (total > 4096) return fail(errorCode);
                chunks.push(new Uint8Array(chunk));
              if(request.method==="GET"&&request.maxBytes!==undefined)reportTransferBytes("download",chunk.byteLength);
              });
              response.once("end", () => {
                if (settled) return;
                if (
                  response.complete &&
                  (length === undefined || total === Number(length))
                ) {
                  const body = new Uint8Array(total);
                  let offset = 0;
                  for (const chunk of chunks) {
                    body.set(chunk, offset);
                    offset += chunk.length;
                  }
                  const code = /<Code>\s*([A-Za-z]+)\s*<\/Code>/.exec(
                    new TextDecoder().decode(body)
                  )?.[1];
                  if (code && QUARK_SAFE_SERVER_CODES.has(code))
                    responseInfo!.serverCode = code;
                }
                fail(errorCode);
              });
              return;
            }
            if (
              responseHeaders["content-encoding"] &&
              responseHeaders["content-encoding"] !== "identity"
            )
              return fail("unexpected_encoding");
            if (
              length !== undefined &&
              (!/^\d+$/.test(length) ||
                !Number.isSafeInteger(Number(length)) ||
                Number(length) > limit)
            )
              return fail("response_too_large");
            const chunks: Uint8Array[] = [];
            let total = 0;
            response.on("data", (chunk: Uint8Array) => {
              total += chunk.byteLength;
              if (total > limit) return fail("response_too_large");
              chunks.push(new Uint8Array(chunk));
              if(request.method==="GET"&&request.maxBytes!==undefined)reportTransferBytes("download",chunk.byteLength);
            });
            response.once("end", () => {
              if (settled) return;
              if (
                !response.complete ||
                (length !== undefined && total !== Number(length))
              )
                return fail("incomplete_response");
              const body = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) {
                body.set(chunk, offset);
                offset += chunk.length;
              }
              settled = true;
              cleanup();
              resolve({
                status: response.statusCode ?? 0,
                headers: responseHeaders,
                cookies: response.headers["set-cookie"] ?? [],
                body,
              });
            });
          }
        );
        diagnostics.attach(outgoing);
        if(request.method==="PUT"&&request.body instanceof Uint8Array)stopUpload=trackNativeUpload(outgoing,request.body.byteLength);
        outgoing.once("finish",()=>{if(!settled&&!incoming&&request.method!=="GET")outgoing?.setTimeout?.(120000);});
        outgoing.setTimeout?.(30000, () => {diagnostics.state.timeout=request.method!=="GET"&&diagnostics.state.phase==="awaiting_response"&&diagnostics.state.bodyFlushed?"response":"idle";fail("request_timeout");});
        outgoing.once("error", (error:any) => fail("transport_error",error?.code));
        outgoing.end(request.body);
      } catch {
        fail("transport_unavailable");
      }
    });
  };
}
export function quarkJson(response: QuarkResponse): any {
  if (response.status !== 200) throw new QuarkError(`http_${response.status}`);
  try {
    const result = JSON.parse(new TextDecoder().decode(response.body));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw 0;
    return result;
  } catch {
    throw new QuarkError("invalid_response");
  }
}
