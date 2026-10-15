import { baiduSyncRoot } from "./baiduPath";
import { BaiduUploadError, type BaiduUploadTransport } from "./baiduUpload";
export class BaiduManagementError extends Error {
  constructor(
    public readonly code: string,
    public readonly operation: "mkdir" | "remove",
    public readonly status?: number,
    public readonly errno?: number,
    public readonly outcomeUnknown = false
  ) {
    super(`Baidu management failed (${code}, ${operation})`);
    this.name = "BaiduManagementError";
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export class BaiduManagementClient {
  constructor(
    private readonly transport: BaiduUploadTransport,
    private readonly token: () => Promise<string>,
    private readonly root: string,
    private readonly checkSession?: () => Promise<void>
  ) {}
  private path(key: string, operation: "mkdir" | "remove") {
    const fail = () => {
      throw new BaiduManagementError("invalid_path", operation);
    };
    if (
      typeof this.root !== "string" ||
      !this.root.startsWith("/") ||
      typeof key !== "string" ||
      key.startsWith("/")
    )
      return fail();
    for (const value of [this.root, key]) {
      if (
        !value ||
        value.includes("//") ||
        /[\u0000-\u001f\u007f]/.test(value) ||
        value.split("/").some((part) => part === "." || part === "..")
      )
        return fail();
      try {
        encodeURIComponent(value);
      } catch {
        return fail();
      }
    }
    const root = this.root.endsWith("/") ? this.root.slice(0, -1) : this.root;
    const relative = key.endsWith("/") ? key.slice(0, -1) : key;
    // Never create/delete the scope itself or operate on an account-wide root.
    if (!root || !relative) return fail();
    return `${root}/${relative}`;
  }
  private async guard(operation: "mkdir" | "remove", afterRequest = false) {
    try {
      await this.checkSession?.();
    } catch {
      throw new BaiduManagementError(
        "session_changed",
        operation,
        undefined,
        undefined,
        afterRequest
      );
    }
  }
  private async send(
    operation: "mkdir" | "remove",
    fields: Record<string, string>
  ) {
    let token: string;
    try {
      token = await this.token();
    } catch {
      throw new BaiduManagementError("session_error", operation);
    }
    if (typeof token !== "string" || !token.trim())
      throw new BaiduManagementError("session_error", operation);
    await this.guard(operation);
    const url = new URL("https://pan.baidu.com/rest/2.0/xpan/file");
    url.search = new URLSearchParams({
      method: operation === "mkdir" ? "create" : "filemanager",
      access_token: token,
      ...(operation === "remove" ? { opera: "delete" } : {}),
    }).toString();
    let response: Awaited<ReturnType<BaiduUploadTransport>>;
    try {
      response = await this.transport({
        url: url.toString(),
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });
    } catch (error) {
      if (error instanceof BaiduUploadError)
        throw new BaiduManagementError(
          error.code,
          operation,
          error.status,
          error.errno,
          error.outcomeUnknown
        );
      throw new BaiduManagementError(
        "transport_error",
        operation,
        undefined,
        undefined,
        true
      );
    }
    await this.guard(operation, true);
    if (
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300
    )
      throw new BaiduManagementError(
        "http_error",
        operation,
        response.status,
        undefined,
        true
      );
    if (operation === "remove" && response.status === 202)
      throw new BaiduManagementError(
        "delete_not_confirmed",
        operation,
        response.status,
        undefined,
        true
      );
    const data = response.json;
    if (!record(data) || !Number.isSafeInteger(data.errno))
      throw new BaiduManagementError(
        "invalid_response",
        operation,
        undefined,
        undefined,
        true
      );
    if (data.errno !== 0)
      throw new BaiduManagementError(
        "platform_error",
        operation,
        undefined,
        data.errno as number
      );
    if (Object.prototype.hasOwnProperty.call(data, "error_code")) {
      if (!Number.isSafeInteger(data.error_code))
        throw new BaiduManagementError(
          "invalid_response",
          operation,
          undefined,
          undefined,
          true
        );
      if (data.error_code !== 0)
        throw new BaiduManagementError(
          "platform_error",
          operation,
          undefined,
          data.error_code as number
        );
    }
    return data;
  }
  async mkdir(key: string): Promise<{ fsId: string; remotePath: string }> {
    return this.createDirectory(this.path(key, "mkdir"));
  }
  /** Explicit setup action only: create precisely the configured scope, never rename/overwrite. */
  async createScopeDirectory(): Promise<{ fsId: string; remotePath: string }> {
    let path: string;
    try {
      path = baiduSyncRoot(this.root);
    } catch {
      throw new BaiduManagementError("invalid_path", "mkdir");
    }
    return this.createDirectory(path);
  }
  private async createDirectory(
    path: string
  ): Promise<{ fsId: string; remotePath: string }> {
    const data = await this.send("mkdir", {
      path,
      size: "0",
      isdir: "1",
      rtype: "0",
    });
    const id =
      typeof data.fs_id === "string"
        ? data.fs_id
        : typeof data.fs_id === "number" && Number.isSafeInteger(data.fs_id)
          ? String(data.fs_id)
          : "";
    if (
      !/^[1-9][0-9]*$/.test(id) ||
      data.path !== path ||
      data.isdir !== 1 ||
      data.size !== 0
    )
      throw new BaiduManagementError(
        "invalid_directory_metadata",
        "mkdir",
        undefined,
        undefined,
        true
      );
    return { fsId: id, remotePath: path };
  }
  async remove(key: string): Promise<void> {
    const path = this.path(key, "remove");
    const data = await this.send("remove", {
      async: "0",
      filelist: JSON.stringify([path]),
      ondup: "fail",
    });
    if (
      Object.prototype.hasOwnProperty.call(data, "async") &&
      data.async !== 0 &&
      data.async !== "0"
    )
      throw new BaiduManagementError(
        "delete_not_confirmed",
        "remove",
        undefined,
        undefined,
        true
      );
    // A task ID is acceptance, not completion. Never let it clear sync history.
    for (const field of ["taskid", "task_id"]) {
      if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
      const task = data[field];
      if (task === 0 || task === "0") continue;
      const positive =
        (typeof task === "number" && Number.isSafeInteger(task) && task > 0) ||
        (typeof task === "string" && /^[1-9][0-9]*$/.test(task));
      throw new BaiduManagementError(
        positive ? "delete_not_confirmed" : "invalid_delete_confirmation",
        "remove",
        undefined,
        undefined,
        true
      );
    }
    if (
      !Array.isArray(data.info) ||
      data.info.length !== 1 ||
      !record(data.info[0]) ||
      data.info[0].path !== path ||
      !Number.isSafeInteger(data.info[0].errno)
    )
      throw new BaiduManagementError(
        "invalid_delete_confirmation",
        "remove",
        undefined,
        undefined,
        true
      );
    if (data.info[0].errno !== 0)
      throw new BaiduManagementError(
        "item_error",
        "remove",
        undefined,
        data.info[0].errno as number
      );
  }
}
