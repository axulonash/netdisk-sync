import { nativeHttpsAgent, nativeTransferTimeout } from "./httpsPool";
import type { NodeHttpsRequest } from "./baiduDesktopTransport";
import type { ClientRequest, IncomingMessage } from "http";
import {
  BAIDU_UPLOAD_PART_BYTES,
  BaiduUploadError,
  type BaiduUploadTransport,
} from "./baiduUpload";
export function createDesktopBaiduUploadTransport(
  isDesktop: boolean,
  loadRequest: () => NodeHttpsRequest = () => require("node:https").request,
  options: { timeoutMs?: number } = {}
): BaiduUploadTransport {
  return async (request) => {
    if (!isDesktop)
      throw new BaiduUploadError("desktop_upload_required", "input");
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new BaiduUploadError("invalid_endpoint", "input");
    }
    const method = url.searchParams.get("method");
    const isForm =
      url.hostname === "pan.baidu.com" &&
      url.pathname === "/rest/2.0/xpan/file" &&
      ["precreate", "create", "filemanager"].includes(method ?? "") &&
      (method !== "filemanager" ||
        (url.searchParams.getAll("opera").length === 1 &&
          url.searchParams.get("opera") === "delete"));
    const isPart =
      url.hostname === "d.pcs.baidu.com" &&
      url.pathname === "/rest/2.0/pcs/superfile2" &&
      method === "upload";
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      (!isForm && !isPart) ||
      url.searchParams.getAll("method").length !== 1 ||
      url.searchParams.getAll("access_token").length !== 1 ||
      !url.searchParams.get("access_token")
    )
      throw new BaiduUploadError("invalid_endpoint", "input");
    const stage = isPart
      ? "part"
      : method === "precreate"
        ? "prepare"
        : "commit";
    const contentType = request.headers["Content-Type"];
    if (
      request.method !== "POST" ||
      request.redirect !== "manual" ||
      (isForm &&
        (typeof request.body !== "string" ||
          contentType !== "application/x-www-form-urlencoded")) ||
      (isPart &&
        (!(request.body instanceof ArrayBuffer) ||
          !/^multipart\/form-data; boundary=[A-Za-z0-9_-]{1,100}$/.test(
            contentType ?? ""
          )))
    )
      throw new BaiduUploadError("invalid_upload_request", "input");
    const body =
      typeof request.body === "string"
        ? new TextEncoder().encode(request.body)
        : new Uint8Array(request.body);
    if (body.byteLength > (isForm ? 65536 : BAIDU_UPLOAD_PART_BYTES + 4096))
      throw new BaiduUploadError("request_too_large", "input");
    const timeoutMs = options.timeoutMs ?? nativeTransferTimeout(body.byteLength);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2147483647
    )
      throw new BaiduUploadError("invalid_transport_limits", "input");
    return new Promise((resolve, reject) => {
      let outgoing: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let settled = false;
      const timer = setTimeout(() => fail("upload_timeout"), timeoutMs);
      const fail = (code: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new BaiduUploadError(
            code,
            stage,
            undefined,
            undefined,
            !!outgoing && stage !== "part"
          )
        );
        incoming?.destroy();
        outgoing?.destroy();
      };
      const succeed = (result: Awaited<ReturnType<BaiduUploadTransport>>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      try {
        outgoing = loadRequest()(
          url,
          {
            method: "POST",
            agent: nativeHttpsAgent(),
            rejectUnauthorized: true,
            headers: {
              "Content-Type": contentType,
              "Content-Length": String(body.byteLength),
              "User-Agent": "pan.baidu.com",
              "Accept-Encoding": "identity",
            },
          },
          (response) => {
            incoming = response;
            response.once("error", () => fail("incomplete_response"));
            response.once("aborted", () => fail("incomplete_response"));
            response.once("close", () => {
              if (!settled) fail("incomplete_response");
            });
            if (settled) {
              response.destroy();
              return;
            }
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              succeed({ status, json: null });
              response.destroy();
              outgoing?.destroy();
              return;
            }
            if (
              response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity"
            ) {
              fail("unexpected_encoding");
              return;
            }
            const declaredLength = response.headers["content-length"];
            if (
              declaredLength !== undefined &&
              (!/^[0-9]+$/.test(declaredLength) ||
                !Number.isSafeInteger(Number(declaredLength)))
            ) {
              fail("invalid_content_length");
              return;
            }
            const maxResponse = 1024 * 1024;
            if (
              declaredLength !== undefined &&
              Number(declaredLength) > maxResponse
            ) {
              fail("response_too_large");
              return;
            }
            const chunks: Uint8Array[] = [];
            let total = 0;
            response.on("data", (chunk: Uint8Array) => {
              if (settled) return;
              total += chunk.byteLength;
              if (total > maxResponse) {
                fail("response_too_large");
                return;
              }
              chunks.push(new Uint8Array(chunk));
            });
            response.once("end", () => {
              if (settled) return;
              if (
                !response.complete ||
                (declaredLength !== undefined &&
                  total !== Number(declaredLength))
              ) {
                fail("incomplete_response");
                return;
              }
              const bytes = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
              }
              try {
                succeed({
                  status,
                  json: JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
                  ),
                });
              } catch {
                fail("invalid_json");
              }
            });
          }
        );
        outgoing.setTimeout?.(Math.min(30000, timeoutMs), () => fail("upload_timeout"));
        outgoing.once("error", () => fail("transport_error"));
        outgoing.end(body);
      } catch {
        fail("transport_unavailable");
      }
    });
  };
}
