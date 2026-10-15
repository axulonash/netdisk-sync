import type { BaiduReadTransport } from "./baiduRead";
export const BAIDU_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
export interface BaiduBinaryRequest {
  url: string;
  method: "GET";
  headers: Record<string, string>;
  redirect: "manual";
  maxBytes?: number;
}
export type BaiduBinaryTransport = (request: BaiduBinaryRequest) => Promise<{
  status: number;
  headers: Record<string, string>;
  body?: ArrayBuffer;
}>;
export class BaiduDownloadError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
    public readonly errno?: number
  ) {
    super(`Baidu download failed (${code})`);
    this.name = "BaiduDownloadError";
  }
}
export const trustedBaiduDownloadUrl = (value: string, base?: string): URL => {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new BaiduDownloadError("untrusted_url");
  }
  const host = url.hostname;
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !(
      host === "pcs.baidu.com" ||
      host.endsWith(".pcs.baidu.com") ||
      host === "baidupcs.com" ||
      host.endsWith(".baidupcs.com")
    )
  ) {
    throw new BaiduDownloadError("untrusted_url");
  }
  return url;
};
const idOf = (value: unknown): string => {
  const id =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : "";
  return /^[1-9][0-9]*$/.test(id) ? id : "";
};
export class BaiduDownloadClient {
  constructor(
    private readonly metadata: BaiduReadTransport,
    private readonly binary: BaiduBinaryTransport,
    private readonly accessToken: () => Promise<string>
  ) {}

  async readFile(file: { fsId: string; size: number }): Promise<ArrayBuffer> {
    if (!idOf(file.fsId) || !Number.isSafeInteger(file.size) || file.size < 0)
      throw new BaiduDownloadError("invalid_file");
    if (file.size > BAIDU_DOWNLOAD_MAX_BYTES)
      throw new BaiduDownloadError("download_too_large");
    let token: string;
    try {
      token = await this.accessToken();
    } catch {
      throw new BaiduDownloadError("session_error");
    }
    if (typeof token !== "string" || !token.trim())
      throw new BaiduDownloadError("session_error");
    const metadataUrl = new URL(
      "https://pan.baidu.com/rest/2.0/xpan/multimedia"
    );
    metadataUrl.search = new URLSearchParams({
      method: "filemetas",
      fsids: `[${file.fsId}]`,
      dlink: "1",
      access_token: token,
    }).toString();
    let response: Awaited<ReturnType<BaiduReadTransport>>;
    try {
      response = await this.metadata({
        url: metadataUrl.toString(),
        method: "GET",
      });
    } catch {
      throw new BaiduDownloadError("transport_error");
    }
    if (
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300
    )
      throw new BaiduDownloadError("http_error", response.status);
    const data = response.json;
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      !("errno" in data) ||
      typeof data.errno !== "number" ||
      !Number.isSafeInteger(data.errno)
    ) {
      throw new BaiduDownloadError("invalid_metadata");
    }
    if (data.errno !== 0)
      throw new BaiduDownloadError("platform_error", undefined, data.errno);
    if (
      !("list" in data) ||
      !Array.isArray(data.list) ||
      data.list.length !== 1
    )
      throw new BaiduDownloadError("invalid_metadata");
    const item = data.list[0];
    if (
      typeof item !== "object" ||
      item === null ||
      idOf(item.fs_id) !== file.fsId ||
      typeof item.dlink !== "string" ||
      (item.size !== undefined && item.size !== file.size) ||
      (item.isdir !== undefined && item.isdir !== 0)
    )
      throw new BaiduDownloadError("invalid_metadata");
    let url = trustedBaiduDownloadUrl(item.dlink);
    url.searchParams.set("access_token", token);
    for (let hop = 0; hop <= 5; hop++) {
      let download: Awaited<ReturnType<BaiduBinaryTransport>>;
      try {
        download = await this.binary({
          url: url.toString(),
          method: "GET",
          headers: { "User-Agent": "pan.baidu.com" },
          redirect: "manual",
          maxBytes: file.size,
        });
      } catch (error) {
        if (error instanceof BaiduDownloadError) throw error;
        throw new BaiduDownloadError("transport_error");
      }
      if ([301, 302, 303, 307, 308].includes(download.status)) {
        if (hop === 5) throw new BaiduDownloadError("redirect_limit");
        const location = Object.entries(download.headers).find(
          ([name]) => name.toLowerCase() === "location"
        )?.[1];
        if (typeof location !== "string" || !location)
          throw new BaiduDownloadError("missing_location");
        url = trustedBaiduDownloadUrl(location, url.toString());
        // Signed redirects must stand on their own; never forward the OAuth
        // token, even if a Location URL happens to echo it.
        url.searchParams.delete("access_token");
        continue;
      }
      if (download.status !== 200)
        throw new BaiduDownloadError("http_error", download.status);
      if (
        !(download.body instanceof ArrayBuffer) ||
        download.body.byteLength !== file.size
      )
        throw new BaiduDownloadError("incomplete_download");
      return download.body;
    }
    throw new BaiduDownloadError("redirect_limit");
  }
}
