import { createHash } from "crypto";
import { nanoid } from "nanoid";
export const BAIDU_UPLOAD_PART_BYTES = 4 * 1024 * 1024;
export const BAIDU_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export interface BaiduUploadRequest {
  url: string;
  method: "POST";
  redirect: "manual";
  headers: Record<string, string>;
  body: string | ArrayBuffer;
}
export type BaiduUploadTransport = (
  request: BaiduUploadRequest
) => Promise<{ status: number; json: unknown }>;
export interface BaiduUploadFile {
  path: string;
  data: ArrayBuffer;
  overwrite: boolean;
  mtimeMs?: number;
  ctimeMs?: number;
}
export class BaiduUploadError extends Error {
  constructor(
    public readonly code: string,
    public readonly stage: "input" | "prepare" | "part" | "commit",
    public readonly status?: number,
    public readonly errno?: number,
    public readonly outcomeUnknown = false
  ) {
    super(`Baidu upload failed (${code}, ${stage})`);
    this.name = "BaiduUploadError";
  }
}
export interface BaiduUploadedFile {
  fsId: string;
  remotePath: string;
  size: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const md5 = (bytes: Uint8Array) =>
  createHash("md5").update(bytes).digest("hex");
const formHeaders = { "Content-Type": "application/x-www-form-urlencoded" };
const multipart = (bytes: Uint8Array) => {
  const boundary = `netdisk-sync-${nanoid()}`;
  // The fixed filename keeps arbitrary remote paths out of multipart headers.
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(
    head.byteLength + bytes.byteLength + tail.byteLength
  );
  body.set(head);
  body.set(bytes, head.byteLength);
  body.set(tail, head.byteLength + bytes.byteLength);
  return {
    body: body.buffer,
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  };
};
export class BaiduUploadClient {
  constructor(
    private readonly transport: BaiduUploadTransport,
    private readonly token: () => Promise<string>,
    private readonly checkSession?: () => Promise<void>
  ) {}
  private async guard(stage: BaiduUploadError["stage"], afterRequest = false) {
    try {
      await this.checkSession?.();
    } catch {
      throw new BaiduUploadError(
        "session_changed",
        stage,
        undefined,
        undefined,
        afterRequest && stage !== "part"
      );
    }
  }
  private async send(
    request: BaiduUploadRequest,
    stage: "prepare" | "part" | "commit"
  ) {
    await this.guard(stage);
    let response: Awaited<ReturnType<BaiduUploadTransport>>;
    try {
      response = await this.transport(request);
    } catch (error) {
      if (error instanceof BaiduUploadError) throw error;
      throw new BaiduUploadError(
        "transport_error",
        stage,
        undefined,
        undefined,
        stage !== "part"
      );
    }
    await this.guard(stage, true);
    if (
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300
    )
      throw new BaiduUploadError(
        "http_error",
        stage,
        response.status,
        undefined,
        stage !== "part"
      );
    const data = response.json;
    if (!record(data))
      throw new BaiduUploadError(
        "invalid_response",
        stage,
        undefined,
        undefined,
        stage !== "part"
      );
    if (
      stage !== "part" &&
      !Object.prototype.hasOwnProperty.call(data, "errno")
    )
      throw new BaiduUploadError(
        "invalid_response",
        stage,
        undefined,
        undefined,
        true
      );
    for (const key of ["errno", "error_code"]) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      if (!Number.isSafeInteger(data[key]))
        throw new BaiduUploadError(
          "invalid_response",
          stage,
          undefined,
          undefined,
          stage !== "part"
        );
      if (data[key] !== 0)
        throw new BaiduUploadError(
          "platform_error",
          stage,
          undefined,
          data[key] as number
        );
    }
    return data;
  }
  private result(
    data: Record<string, unknown>,
    file: BaiduUploadFile,
    stage: "prepare" | "commit"
  ): BaiduUploadedFile {
    const id =
      typeof data.fs_id === "string"
        ? data.fs_id
        : typeof data.fs_id === "number" && Number.isSafeInteger(data.fs_id)
          ? String(data.fs_id)
          : "";
    if (
      !/^[1-9][0-9]*$/.test(id) ||
      data.path !== file.path ||
      data.size !== file.data.byteLength ||
      data.isdir !== 0
    )
      throw new BaiduUploadError(
        "invalid_commit_metadata",
        stage,
        undefined,
        undefined,
        true
      );
    return { fsId: id, remotePath: file.path, size: file.data.byteLength };
  }
  async writeFile(input: BaiduUploadFile): Promise<BaiduUploadedFile> {
    if (
      !input ||
      typeof input.path !== "string" ||
      !input.path.startsWith("/") ||
      input.path.endsWith("/") ||
      input.path.includes("//") ||
      /[\u0000-\u001f\u007f]/.test(input.path) ||
      input.path
        .split("/")
        .some((segment) => segment === "." || segment === "..") ||
      !(input.data instanceof ArrayBuffer) ||
      typeof input.overwrite !== "boolean" ||
      [input.mtimeMs, input.ctimeMs].some(
        (time) =>
          time !== undefined && (!Number.isSafeInteger(time) || time < 0)
      )
    )
      throw new BaiduUploadError("invalid_file", "input");
    // URLSearchParams replaces unpaired UTF-16 surrogates with U+FFFD.
    // Reject them before any request could create or overwrite another path.
    try {
      encodeURIComponent(input.path);
    } catch {
      throw new BaiduUploadError("invalid_file", "input");
    }
    if (input.data.byteLength === 0)
      throw new BaiduUploadError("empty_file_unsupported", "input");
    if (input.data.byteLength > BAIDU_UPLOAD_MAX_BYTES)
      throw new BaiduUploadError("upload_too_large", "input");
    const file = { ...input, data: input.data.slice(0) };
    const bytes = new Uint8Array(file.data);
    const hashes: string[] = [];
    for (
      let start = 0;
      start < bytes.byteLength;
      start += BAIDU_UPLOAD_PART_BYTES
    )
      hashes.push(md5(bytes.subarray(start, start + BAIDU_UPLOAD_PART_BYTES)));
    let token: string;
    try {
      token = await this.token();
    } catch {
      throw new BaiduUploadError("session_error", "input");
    }
    if (typeof token !== "string" || !token.trim())
      throw new BaiduUploadError("session_error", "input");
    const form: Record<string, string> = {
      path: file.path,
      size: String(bytes.byteLength),
      isdir: "0",
      rtype: file.overwrite ? "3" : "0",
      block_list: JSON.stringify(hashes),
    };
    if (file.mtimeMs !== undefined)
      form.local_mtime = String(Math.floor(file.mtimeMs / 1000));
    if (file.ctimeMs !== undefined)
      form.local_ctime = String(Math.floor(file.ctimeMs / 1000));
    const formRequest = (
      method: string,
      fields: Record<string, string>
    ): BaiduUploadRequest => {
      const url = new URL("https://pan.baidu.com/rest/2.0/xpan/file");
      url.search = new URLSearchParams({
        method,
        access_token: token,
      }).toString();
      return {
        url: url.toString(),
        method: "POST",
        redirect: "manual",
        headers: { ...formHeaders },
        body: new URLSearchParams(fields).toString(),
      };
    };
    const prepared = await this.send(
      formRequest("precreate", { ...form, autoinit: "1" }),
      "prepare"
    );
    if (prepared.return_type === 2)
      return this.result(prepared, file, "prepare");
    if (prepared.return_type !== 1)
      throw new BaiduUploadError(
        "invalid_precreate",
        "prepare",
        undefined,
        undefined,
        true
      );
    const indices = prepared.block_list;
    if (
      typeof prepared.uploadid !== "string" ||
      !prepared.uploadid.trim() ||
      !Array.isArray(indices) ||
      indices.length > hashes.length ||
      indices.some(
        (index) =>
          !Number.isInteger(index) || index < 0 || index >= hashes.length
      ) ||
      new Set(indices).size !== indices.length
    )
      throw new BaiduUploadError(
        "invalid_precreate",
        "prepare",
        undefined,
        undefined,
        true
      );
    for (const index of [...indices].sort((a, b) => a - b)) {
      const url = new URL("https://d.pcs.baidu.com/rest/2.0/pcs/superfile2");
      url.search = new URLSearchParams({
        method: "upload",
        access_token: token,
        type: "tmpfile",
        path: file.path,
        uploadid: prepared.uploadid,
        partseq: String(index),
      }).toString();
      const part = bytes.subarray(
        index * BAIDU_UPLOAD_PART_BYTES,
        (index + 1) * BAIDU_UPLOAD_PART_BYTES
      );
      const data = await this.send(
        {
          url: url.toString(),
          method: "POST",
          redirect: "manual",
          ...multipart(part),
        },
        "part"
      );
      if (
        typeof data.md5 !== "string" ||
        data.md5.toLowerCase() !== hashes[index]
      )
        throw new BaiduUploadError("part_hash_mismatch", "part");
    }
    // Commit exactly once. A lost/malformed response is an unknown outcome;
    // no delete, rename, automatic overwrite retry or partial success follows.
    const result = await this.send(
      formRequest("create", { ...form, uploadid: prepared.uploadid }),
      "commit"
    );
    return this.result(result, file, "commit");
  }
}
