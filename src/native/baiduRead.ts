export interface BaiduReadRequest {
  url: string;
  method: "GET";
}
export type BaiduReadTransport = (
  request: BaiduReadRequest
) => Promise<{ status: number; json: unknown }>;
export interface BaiduRemoteEntry {
  fsId: string;
  remotePath: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
export interface BaiduScanEntry extends BaiduRemoteEntry {
  key: string;
}
export interface BaiduReadLimits {
  pageSize?: number;
  maxPages?: number;
  maxEntries?: number;
}
export class BaiduReadError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
    public readonly errno?: number
  ) {
    super(`Baidu directory read failed (${code})`);
    this.name = "BaiduReadError";
  }
}
const pathOf = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("//") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new BaiduReadError("invalid_path");
  }
  const path =
    value.endsWith("/") && value !== "/" ? value.slice(0, -1) : value;
  if (
    path !== "/" &&
    path
      .slice(1)
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  ) {
    throw new BaiduReadError("invalid_path");
  }
  return path;
};
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const entryOf = (raw: unknown, parent: string): BaiduRemoteEntry => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BaiduReadError("invalid_metadata");
  }
  const item = raw as Record<string, unknown>;
  const remotePath = pathOf(item.path);
  const actualParent = remotePath.slice(0, remotePath.lastIndexOf("/")) || "/";
  if (
    remotePath === parent ||
    actualParent !== parent ||
    remotePath !== item.path
  ) {
    throw new BaiduReadError("invalid_entry_parent");
  }
  const id = item.fs_id;
  const fsId = typeof id === "string" ? id : integer(id) ? String(id) : "";
  if (
    !/^[1-9][0-9]*$/.test(fsId) ||
    (item.isdir !== 0 && item.isdir !== 1) ||
    !integer(item.size) ||
    !integer(item.server_mtime) ||
    !integer(item.server_ctime) ||
    !Number.isSafeInteger(item.server_mtime * 1000) ||
    !Number.isSafeInteger(item.server_ctime * 1000)
  ) {
    throw new BaiduReadError("invalid_metadata");
  }
  return {
    fsId,
    remotePath,
    isDirectory: item.isdir === 1,
    size: item.size,
    mtimeMs: item.server_mtime * 1000,
    ctimeMs: item.server_ctime * 1000,
  };
};

export class BaiduReadClient {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxEntries: number;

  constructor(
    private readonly transport: BaiduReadTransport,
    private readonly accessToken: string,
    limits: BaiduReadLimits = {}
  ) {
    this.pageSize = limits.pageSize ?? 1000;
    this.maxPages = limits.maxPages ?? 1000;
    this.maxEntries = limits.maxEntries ?? 100000;
    if (
      ![this.pageSize, this.maxPages, this.maxEntries].every(
        (value) => integer(value) && value > 0
      ) ||
      this.pageSize > 1000
    ) {
      throw new BaiduReadError("invalid_limits");
    }
    if (typeof accessToken !== "string" || !accessToken.trim())
      throw new BaiduReadError("missing_access_token");
  }

  async listDirectory(remotePath: string): Promise<BaiduRemoteEntry[]> {
    const parent = pathOf(remotePath);
    const result: BaiduRemoteEntry[] = [];
    const paths = new Set<string>();
    const ids = new Set<string>();
    for (let page = 0; page < this.maxPages; page++) {
      const offset = page * this.pageSize;
      if (!Number.isSafeInteger(offset)) throw new BaiduReadError("page_limit");
      const url = new URL("https://pan.baidu.com/rest/2.0/xpan/file");
      url.search = new URLSearchParams({
        method: "list",
        dir: parent,
        web: "web",
        start: String(offset),
        limit: String(this.pageSize),
        order: "name",
        desc: "0",
        access_token: this.accessToken,
      }).toString();
      let response: Awaited<ReturnType<BaiduReadTransport>>;
      try {
        response = await this.transport({ url: url.toString(), method: "GET" });
      } catch {
        // Do not forward transport messages containing the credential-bearing URL.
        throw new BaiduReadError("transport_error");
      }
      if (
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status >= 300
      ) {
        throw new BaiduReadError("http_error", response.status);
      }
      if (
        typeof response.json !== "object" ||
        response.json === null ||
        Array.isArray(response.json)
      ) {
        throw new BaiduReadError("invalid_response");
      }
      const data = response.json as Record<string, unknown>;
      if (typeof data.errno !== "number" || !Number.isSafeInteger(data.errno)) {
        throw new BaiduReadError("invalid_response");
      }
      if (data.errno !== 0)
        throw new BaiduReadError("platform_error", undefined, data.errno);
      if (!Array.isArray(data.list) || data.list.length > this.pageSize)
        throw new BaiduReadError("invalid_response");
      for (const raw of data.list) {
        const entry = entryOf(raw, parent);
        if (paths.has(entry.remotePath) || ids.has(entry.fsId))
          throw new BaiduReadError("duplicate_entry");
        if (result.length >= this.maxEntries)
          throw new BaiduReadError("entry_limit");
        paths.add(entry.remotePath);
        ids.add(entry.fsId);
        result.push(entry);
      }
      if (data.list.length < this.pageSize) return result;
    }
    throw new BaiduReadError("page_limit");
  }

  async scan(root: string, onProgress?: (files: number, folders: number) => void): Promise<BaiduScanEntry[]> {
    const base = pathOf(root);
    const queue = [base];
    const result: BaiduScanEntry[] = [];
    let files = 0, folders = 0;
    const ids = new Set<string>();
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const entries = await this.listDirectory(queue[cursor]);
      for (const entry of entries) {
        if (ids.has(entry.fsId)) throw new BaiduReadError("duplicate_entry");
        if (result.length >= this.maxEntries)
          throw new BaiduReadError("entry_limit");
        ids.add(entry.fsId);
        const key =
          entry.remotePath.slice(base === "/" ? 1 : base.length + 1) +
          (entry.isDirectory ? "/" : "");
        result.push({ ...entry, key });
        if (entry.isDirectory) folders++; else files++;
        onProgress?.(files, folders);
        if (entry.isDirectory) queue.push(entry.remotePath);
      }
    }
    return result;
  }
}
