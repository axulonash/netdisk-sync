import { nativeHttpsAgent, nativeTransferTimeout } from "./httpsPool";
import type { ClientRequest, IncomingMessage } from "http";
import type { RequestOptions } from "https";
import {
  BAIDU_DOWNLOAD_MAX_BYTES,
  BaiduDownloadError,
  trustedBaiduDownloadUrl,
  type BaiduBinaryTransport,
} from "./baiduDownload";

export type NodeHttpsRequest = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void
) => ClientRequest;

// The require is intentionally inside the loader. Importing this module on
// mobile must not load a Node builtin. Webpack externalizes only node:https.
export function createDesktopBaiduTransport(
  isDesktop: boolean,
  loadRequest: () => NodeHttpsRequest = () => require("node:https").request,
  options: { maxBytes?: number; timeoutMs?: number } = {}
): BaiduBinaryTransport {
  return async (request) => {
    if (!isDesktop) throw new BaiduDownloadError("desktop_download_required");
    const url = trustedBaiduDownloadUrl(request.url);
    const configuredLimit = options.maxBytes ?? BAIDU_DOWNLOAD_MAX_BYTES;
    const timeoutMs = options.timeoutMs ?? nativeTransferTimeout(request.maxBytes ?? configuredLimit);
    if (
      !Number.isSafeInteger(configuredLimit) ||
      configuredLimit < 0 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2147483647 ||
      (request.maxBytes !== undefined &&
        (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0))
    )
      throw new BaiduDownloadError("invalid_transport_limits");
    const limit = Math.min(
      configuredLimit,
      request.maxBytes ?? configuredLimit
    );
    if (request.method !== "GET" || request.redirect !== "manual")
      throw new BaiduDownloadError("invalid_download_request");
    return new Promise((resolve, reject) => {
      let outgoing: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let settled = false;
      const timer = setTimeout(() => fail("download_timeout"), timeoutMs);
      const fail = (code: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new BaiduDownloadError(code));
        incoming?.destroy();
        outgoing?.destroy();
      };
      const succeed = (response: Awaited<ReturnType<BaiduBinaryTransport>>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      };
      try {
        outgoing = loadRequest()(
          url,
          {
            method: "GET",
            // Do not accept caller credentials or cookies in headers.
            headers: {
              "User-Agent": "pan.baidu.com",
              "Accept-Encoding": "identity",
            },
            agent: nativeHttpsAgent(),
            rejectUnauthorized: true,
          },
          (response) => {
            incoming = response;
            response.once("error", () => fail("incomplete_download"));
            response.once("aborted", () => fail("incomplete_download"));
            response.once("close", () => {
              if (!settled) fail("incomplete_download");
            });
            const status = response.statusCode ?? 0;
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (typeof value === "string") headers[name] = value;
              else if (Array.isArray(value)) headers[name] = value.join(", ");
            }
            // A single request returns the redirect headers to the download
            // client. Close its body rather than following or buffering it.
            if (status !== 200) {
              succeed({ status, headers });
              response.destroy();
              outgoing?.destroy();
              return;
            }
            if (
              headers["content-encoding"] &&
              headers["content-encoding"].toLowerCase() !== "identity"
            ) {
              fail("unexpected_encoding");
              return;
            }
            const length = headers["content-length"];
            if (
              length !== undefined &&
              (!/^[0-9]+$/.test(length) ||
                !Number.isSafeInteger(Number(length)))
            ) {
              fail("invalid_content_length");
              return;
            }
            if (length !== undefined && Number(length) > limit) {
              fail("download_too_large");
              return;
            }
            const chunks: Uint8Array[] = [];
            let total = 0;
            response.on("data", (chunk: Uint8Array) => {
              if (settled) return;
              total += chunk.byteLength;
              if (total > limit) {
                fail("download_too_large");
                return;
              }
              chunks.push(new Uint8Array(chunk));
            });
            response.once("end", () => {
              if (settled) return;
              if (
                !response.complete ||
                (length !== undefined && total !== Number(length))
              ) {
                fail("incomplete_download");
                return;
              }
              const bytes = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
              }
              succeed({ status, headers, body: bytes.buffer });
            });
          }
        );
        outgoing.setTimeout?.(Math.min(30000, timeoutMs), () => fail("download_timeout"));
        outgoing.once("error", () => fail("transport_error"));
        outgoing.end();
      } catch {
        fail("transport_unavailable");
      }
    });
  };
}
