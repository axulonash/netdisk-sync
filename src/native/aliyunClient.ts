import { createHash, randomBytes } from "crypto";
import { nanoid } from "nanoid";
import {
  aliyunSession,
  aliyunRoot,
  aliyunKey,
  aliyunOverwriteBinding,
  refreshAliyun,
  type AliyunConfig,
  type AliyunSession,
} from "./aliyunAuth";
import {
  AliyunError,
  ALIYUN_SAFE_SERVER_CODES,
  type AliyunRequest,
  aliyunJson,
  aliyunFileUrl,
  type AliyunTransport,
} from "./aliyunTransport";
export interface AliyunEntry {
  key: string;
  fid: string;
  parent: string;
  name: string;
  folder: boolean;
  size: number;
  mtime: number;
  ctime: number;
}
const hash = (bytes: ArrayBuffer) =>
  createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const probeName = (name: string) =>
  /^rs-overwrite-check-[A-Za-z0-9_-]{32}\.bin$/.test(name);
const requestId = () => {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const MAX = 64 * 1024 * 1024,
  PART = 10 * 1024 * 1024;
export class AliyunClient {
  private expected: string;
  private readonly root: string;
  private rootId?: string;
  private deviceReady = false;
  constructor(
    private readonly transport: AliyunTransport,
    private readonly config: () => AliyunConfig | undefined,
    private readonly scopeGuard: () => void = () => {},
    private readonly persist: (
      session: AliyunSession
    ) => Promise<void> = async () => {
      throw new AliyunError("session_save_required");
    }
  ) {
    this.expected = aliyunSession(config()).binding;
    this.root = aliyunRoot(config()?.remoteRoot ?? "");
  }
  guard() {
    this.scopeGuard();
    if (
      aliyunSession(this.config()).binding !== this.expected ||
      aliyunRoot(this.config()?.remoteRoot ?? "") !== this.root
    )
      throw new AliyunError("sync_scope_changed");
  }
  private signature() {
    const s = aliyunSession(this.config());
    const EC = require("elliptic").ec;
    const ec = new EC("secp256k1");
    const key = ec.keyFromPrivate(s.privateKey, "hex");
    const deviceId = createHash("sha256")
      .update(s.userId + s.identity)
      .digest("hex");
    const message = createHash("sha256")
      .update(`5dde4e1bdf9e4966b387ba58f4b3fdc3:${deviceId}:${s.userId}:0`)
      .digest("hex");
    const sign = key.sign(message, { canonical: true });
    return {
      deviceId,
      pubKey: key.getPublic(false, "hex").slice(2),
      signature:
        sign.r.toString("hex", 64) +
        sign.s.toString("hex", 64) +
        sign.recoveryParam.toString(16).padStart(2, "0"),
    };
  }
  private async send(path: string, body: any) {
    this.guard();
    const s = aliyunSession(this.config()),
      sig = this.signature();
    const response = await this.transport({
      url: `https://api.alipan.com${path}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${s.accessToken}`,
        "Content-Type": "application/json",
        "X-Device-Id": sig.deviceId,
        "X-Signature": sig.signature,
        "x-request-id": requestId(),
        "X-Canary": "client=Android,app=adrive,version=v4.1.0",
        Origin: "https://www.alipan.com",
        Referer: "https://www.alipan.com/",
      },
      body: JSON.stringify(body),
    });
    this.guard();
    // Trash may succeed without JSON. The caller still confirms the FID is absent.
    if (
      path === "/v2/recyclebin/trash" &&
      response.status === 204 &&
      response.body.length === 0
    )
      return {};
    const r = aliyunJson(response);
    if (r.code)
      throw new AliyunError(
        [
          "AccessTokenInvalid",
          "AccessTokenExpired",
          "InvalidAccessToken",
          "RefreshTokenExpired",
        ].includes(r.code)
          ? "login_required"
          : "api_rejected",
        true
      );
    return r;
  }
  private async ready() {
    this.guard();
    let s = aliyunSession(this.config());
    if (s.expiresAt <= Date.now() + 120000) {
      const renewed = await refreshAliyun(this.transport, s.refreshToken, s);
      this.guard();
      await this.persist(renewed);
      this.expected = renewed.binding;
      this.deviceReady = false;
      this.guard();
      s = renewed;
    }
    if (!this.deviceReady) {
      const sig = this.signature();
      const r = await this.send("/users/v1/users/device/create_session", {
        deviceName: "remotely-save-next",
        modelName: "Desktop",
        nonce: 0,
        pubKey: sig.pubKey,
        refreshToken: s.refreshToken,
      });
      if (r.success === false) throw new AliyunError("device_session_failed");
      this.deviceReady = true;
    }
  }
  private async api(path: string, body: any) {
    await this.ready();
    return this.send(path, {
      drive_id: aliyunSession(this.config()).driveId,
      ...body,
    });
  }
  private async list(parent: string): Promise<AliyunEntry[]> {
    const all: AliyunEntry[] = [];
    const ids = new Set<string>(),
      names = new Set<string>(),
      markers = new Set<string>();
    let marker = "";
    for (let page = 0; page < 100; page++) {
      const r = await this.api("/v2/file/list", {
        parent_file_id: parent,
        limit: 200,
        marker,
        order_by: "name",
        order_direction: "ASC",
        fields: "*",
      });
      if (
        !Array.isArray(r.items) ||
        r.items.length > 200 ||
        typeof r.next_marker !== "string"
      )
        throw new AliyunError("incomplete_listing");
      for (const f of r.items) {
        if (
          typeof f.file_id !== "string" ||
          !f.file_id ||
          typeof f.name !== "string" ||
          f.name.includes("/") ||
          aliyunKey(f.name).length !== 1 ||
          !["file", "folder"].includes(f.type) ||
          ids.has(f.file_id) ||
          names.has(f.name) ||
          (f.parent_file_id && f.parent_file_id !== parent) ||
          (f.type === "file" && (!Number.isSafeInteger(f.size) || f.size < 0))
        )
          throw new AliyunError("incomplete_listing");
        ids.add(f.file_id);
        names.add(f.name);
        all.push({
          key: f.name + (f.type === "folder" ? "/" : ""),
          fid: f.file_id,
          name: f.name,
          parent,
          folder: f.type === "folder",
          size: f.type === "folder" ? 0 : f.size,
          mtime: Date.parse(f.updated_at) || 0,
          ctime: Date.parse(f.created_at) || 0,
        });
        if (all.length > 10000) throw new AliyunError("listing_limit");
      }
      if (!r.next_marker) return all;
      if (markers.has(r.next_marker) || !r.items.length)
        throw new AliyunError("incomplete_listing");
      markers.add(r.next_marker);
      marker = r.next_marker;
    }
    throw new AliyunError("listing_limit");
  }
  private async child(parent: string, name: string) {
    return (await this.list(parent)).find((f) => f.name === name);
  }
  private async directory(parent: string, name: string, create: boolean) {
    let f = await this.child(parent, name);
    if (!f && create) {
      const r = await this.api("/adrive/v2/file/createWithFolders", {
        parent_file_id: parent,
        name,
        type: "folder",
        check_name_mode: "refuse",
      });
      if (typeof r.file_id !== "string")
        throw new AliyunError("directory_not_confirmed");
      f = await this.child(parent, name);
      if (!f || f.fid !== r.file_id)
        throw new AliyunError("directory_not_confirmed");
    }
    if (!f || !f.folder)
      throw new AliyunError(f ? "path_conflict" : "not_found");
    return f;
  }
  private async ensureRoot(create = false) {
    this.guard();
    let parent = "root";
    for (const name of aliyunKey(this.root.slice(1))) {
      parent = (await this.directory(parent, name, create)).fid;
    }
    if (this.rootId && this.rootId !== parent)
      throw new AliyunError("sync_scope_changed");
    this.rootId = parent;
    return parent;
  }
  async prepareRoot() {
    await this.ensureRoot(true);
  }
  async scan(onProgress?: (files: number, folders: number) => void) {
    const root = await this.ensureRoot();
    const out: AliyunEntry[] = [];
    let files = 0, folders = 0;
    const visited = new Set<string>([root]);
    const walk = async (parent: string, prefix: string, depth: number) => {
      if (depth > 100) throw new AliyunError("listing_limit");
      for (const f of await this.list(parent)) {
        if (!f.folder && probeName(f.name)) continue;
        if (out.length >= 10000 || visited.has(f.fid))
          throw new AliyunError("incomplete_listing");
        visited.add(f.fid);
        const e = { ...f, key: prefix + f.key };
        out.push(e);
        if (f.folder) folders++; else files++;
        onProgress?.(files, folders);
        if (f.folder) await walk(f.fid, e.key, depth + 1);
      }
    };
    await walk(root, "", 0);
    return out;
  }
  private async location(key: string, create = false) {
    const parts = aliyunKey(key);
    let parent = await this.ensureRoot();
    for (const part of parts.slice(0, -1))
      parent = (await this.directory(parent, part, create)).fid;
    return { parent, name: parts.at(-1)! };
  }
  async stat(key: string) {
    const { parent, name } = await this.location(key);
    const f = await this.child(parent, name);
    if (!f || key.endsWith("/") !== f.folder)
      throw new AliyunError("not_found");
    return { ...f, key };
  }
  private verified() {
    if (
      this.config()?.overwriteVerified !==
      aliyunOverwriteBinding(this.config()!)
    )
      throw new AliyunError("overwrite_not_verified");
  }
  async mkdir(key: string) {
    this.verified();
    if (!key.endsWith("/")) throw new AliyunError("invalid_path");
    const { parent, name } = await this.location(key, true);
    return { ...(await this.directory(parent, name, true)), key };
  }
  private async transfer(
    request: AliyunRequest,
    operation: "upload_url" | "download_url" | "download_redirect"
  ) {
    const host = new URL(request.url).hostname;
    try {
      const response = await this.transport(request);
      const accepted =
        operation === "upload_url"
          ? [200, 201]
          : [200, 301, 302, 303, 307, 308];
      if (!accepted.includes(response.status)) {
        const error = new AliyunError(
          `http_${response.status}`,
          request.method !== "GET"
        );
        const code =
          response.body.length <= 4096
            ? /<Code>\s*([A-Za-z]+)\s*<\/Code>/.exec(
                new TextDecoder().decode(response.body)
              )?.[1]
            : undefined;
        error.responseInfo = {
          host,
          status: response.status,
          expectedBytes: request.maxBytes ?? 1024 * 1024,
          kind: "other",
          ...(code && ALIYUN_SAFE_SERVER_CODES.has(code)
            ? { serverCode: code }
            : {}),
        };
        throw error;
      }
      return response;
    } catch (error) {
      if (error instanceof AliyunError)
        error.endpointInfo = { host, operation };
      throw error;
    }
  }
  private async download(f: AliyunEntry, confirmingUpload = false): Promise<ArrayBuffer> {
    let stage: AliyunError["providerStage"] = confirmingUpload ? "upload_confirm_authorize" : "download_authorize";
    try {
    if (f.folder || f.size > MAX) throw new AliyunError("unsupported_file");
    const r = await this.api("/v2/file/get_download_url", {
      file_id: f.fid,
      expire_sec: 300,
    });
    if (typeof r.url !== "string") throw new AliyunError("invalid_response");
    let url = aliyunFileUrl(r.url, "download_url");
    for (let hop = 0; hop < 5; hop++) {
      this.guard();
      stage = hop === 0
        ? (confirmingUpload ? "upload_confirm_transfer" : "download_transfer")
        : (confirmingUpload ? "upload_confirm_redirect" : "download_redirect");
      const response = await this.transfer(
        {
          url: url.href,
          method: "GET",
          headers: { Referer: "https://www.alipan.com/" },
          maxBytes: f.size,
        },
        hop ? "download_redirect" : "download_url"
      );
      this.guard();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location)
          throw new AliyunError("invalid_response");
        url = aliyunFileUrl(
          new URL(response.headers.location, url).href,
          "download_redirect"
        );
        continue;
      }
      if (response.status !== 200)
        throw new AliyunError(`http_${response.status}`);
      if (response.body.length !== f.size)
        throw new AliyunError("download_not_confirmed");
      return response.body.slice().buffer as ArrayBuffer;
    }
    throw new AliyunError("redirect_limit");
    } catch (error) {
      if (error instanceof AliyunError && !error.providerStage)
        error.providerStage = stage;
      throw error;
    }
  }
  async read(key: string) {
    return this.download(await this.stat(key));
  }
  private async upload(key: string, bytes: ArrayBuffer, probe = false) {
    if (!probe) this.verified();
    if (bytes.byteLength === 0)
      throw new AliyunError("empty_file_not_supported");
    if (bytes.byteLength > MAX) throw new AliyunError("file_too_large");
    let stage: AliyunError["providerStage"] = "upload_prepare";
    try {
    const { parent, name } = await this.location(key, true);
    const old = await this.child(parent, name);
    if (old?.folder) throw new AliyunError("path_conflict");
    const parts = Array.from(
      { length: Math.ceil(bytes.byteLength / PART) },
      (_, i) => ({ part_number: i + 1 })
    );
    const r = await this.api("/adrive/v2/file/createWithFolders", {
      parent_file_id: parent,
      name,
      type: "file",
      size: bytes.byteLength,
      check_name_mode: old ? "overwrite" : "refuse",
      part_info_list: parts,
      content_hash_name: "none",
      proof_version: "v1",
    });
    if (
      typeof r.file_id !== "string" ||
      !r.file_id ||
      typeof r.upload_id !== "string" ||
      !Array.isArray(r.part_info_list) ||
      r.part_info_list.length !== parts.length
    )
      throw new AliyunError("upload_not_confirmed", true);
    const owned = r.file_id;
    stage = "upload_part";
    for (let i = 0; i < parts.length; i++) {
      const p = r.part_info_list[i];
      if (p.part_number !== i + 1 || typeof p.upload_url !== "string")
        throw new AliyunError("invalid_response", true);
      const url = aliyunFileUrl(p.upload_url, "upload_url");
      this.guard();
      const body = new Uint8Array(bytes.slice(i * PART, (i + 1) * PART));
      if (
        p.content_type !== undefined &&
        p.content_type !== "" &&
        (typeof p.content_type !== "string" ||
          p.content_type.length > 256 ||
          !/^[\x20-\x7e]+$/.test(p.content_type))
      )
        throw new AliyunError("invalid_response", true);
      const result = await this.transfer(
        {
          url: url.href,
          method: "PUT",
          headers: {
            ...(p.content_type ? { "Content-Type": p.content_type } : {}),
            "Content-Length": String(body.length),
          },
          body,
        },
        "upload_url"
      );
      this.guard();
      if (![200, 201].includes(result.status))
        throw new AliyunError(`http_${result.status}`, true);
    }
    stage = "upload_commit";
    const done = await this.api("/v2/file/complete", {
      file_id: owned,
      upload_id: r.upload_id,
    });
    if (done.file_id !== owned)
      throw new AliyunError("upload_not_confirmed", true);
    stage = "upload_confirm";
    const current = await this.child(parent, name);
    if (
      !current ||
      current.fid !== owned ||
      current.size !== bytes.byteLength ||
      hash(await this.download(current, true)) !== hash(bytes)
    )
      throw new AliyunError("upload_not_confirmed", true);
    return { ...current, key };
    } catch (error) {
      if (error instanceof AliyunError && !error.providerStage)
        error.providerStage = stage;
      throw error;
    }
  }
  async write(key: string, bytes: ArrayBuffer, _mtime: number, _ctime: number) {
    if (aliyunKey(key).some(probeName)) throw new AliyunError("reserved_path");
    if (key.endsWith("/")) throw new AliyunError("invalid_path");
    return this.upload(key, bytes);
  }
  private async trash(f: AliyunEntry) {
    const current = await this.child(f.parent, f.name);
    if (!current || current.fid !== f.fid || current.size !== f.size)
      throw new AliyunError("sync_scope_changed");
    await this.api("/v2/recyclebin/trash", { file_id: f.fid });
    if ((await this.list(f.parent)).some((e) => e.fid === f.fid))
      throw new AliyunError("cleanup_not_confirmed", true);
  }
  async remove(key: string) {
    this.verified();
    const f = await this.stat(key);
    if (f.folder && (await this.list(f.fid)).length)
      throw new AliyunError("directory_not_empty");
    await this.trash(f);
  }
  async verifyOverwrite() {
    this.guard();
    const key = `rs-overwrite-check-${nanoid(32)}.bin`;
    let stage: "initial_upload" | "overwrite" | "cleanup" = "initial_upload";
    try {
      await this.upload(key, new Uint8Array([1, 2, 3, 4]).buffer, true);
      stage = "overwrite";
      const updated = await this.upload(
        key,
        new Uint8Array([5, 6, 7, 8, 9, 10, 11]).buffer,
        true
      );
      stage = "cleanup";
      await this.trash(updated);
      return aliyunOverwriteBinding(this.config()!);
    } catch (e) {
      if (e instanceof AliyunError) e.stage = stage;
      throw e;
    }
  }
}
