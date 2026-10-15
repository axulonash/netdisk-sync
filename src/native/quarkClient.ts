import { createHash } from "crypto";
import { lookup as mimeLookup } from "mime-types";
import {
  quarkKey,
  quarkRoot,
  quarkSession,
  quarkOverwriteBinding,
  type QuarkConfig,
} from "./quarkAuth";
import { nanoid } from "nanoid";
import {
  QuarkError,
  quarkJson,
  quarkUrl,
  quarkSessionHost,
  QUARK_DRIVE_USER_AGENT,
  type QuarkTransport,
} from "./quarkTransport";

export interface QuarkEntry {
  fid: string;
  name: string;
  directory: boolean;
  size: number;
  mtime: number;
  ctime: number;
  key: string;
}
const integer = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const fidOf = (n: unknown): string => {
  if (typeof n !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(n))
    throw new QuarkError("invalid_file_id");
  return n;
};
const text = (n: unknown): string => {
  if (typeof n !== "string" || !n || n.length > 8192 || /[\r\n]/.test(n))
    throw new QuarkError("invalid_upload_metadata");
  return n;
};
const hash = (
  algorithm: string,
  value: Uint8Array | string,
  encoding: "hex" | "base64" = "hex"
) => createHash(algorithm).update(value).digest(encoding);
export const QUARK_MAX_BYTES = 64 * 1024 * 1024;
const OSS_AGENT =
  "aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit";
const replacementBackup = /^rsnext-backup-[A-Za-z0-9_-]{32}--.+$/;
const replacementUpload = /^rsnext-upload-[A-Za-z0-9_-]{32}\.bin$/;

// One client is bound to one authorization and root. Requests never cross a
// settings/account change, even while an operation is awaiting the network.
export class QuarkClient {
  private readonly session: ReturnType<typeof quarkSession>;
  private readonly sessionCookies = new Map<string, string>();
  readonly root: string;
  constructor(
    private readonly transport: QuarkTransport,
    private readonly getConfig: () => QuarkConfig | undefined,
    private readonly guardExtra: () => void = () => {}
  ) {
    const config = getConfig();
    this.session = quarkSession(config);
    for (const pair of this.session.cookie.split(";")) {
      const separator = pair.indexOf("=");
      if (separator > 0)
        this.sessionCookies.set(
          pair.slice(0, separator).trim(),
          pair.slice(separator + 1).trim()
        );
    }
    this.root = quarkRoot(config?.remoteRoot ?? "");
  }
  private cookieHeader() {
    return [...this.sessionCookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
  private refreshCookies(cookies: string[]) {
    // Keep API credential rotation local to this guarded operation. The saved
    // account binding still detects logout, account and configuration changes.
    for (const raw of cookies) {
      if (/[\r\n]/.test(raw)) continue;
      const [pair, ...attributes] = raw.split(";");
      const match = /^(__pus|__puus)=([^;]*)$/.exec(pair.trim());
      if (!match) continue;
      const attribute = (name: string) =>
        attributes
          .find((a) => a.trim().toLowerCase().startsWith(`${name}=`))
          ?.trim()
          .slice(name.length + 1)
          .trim();
      const domain = attribute("domain")?.toLowerCase();
      if (domain !== ".quark.cn" && domain !== "quark.cn") continue;
      // With no Path the API cookie defaults to /1/clouddrive, not the CDN.
      if (attribute("path") !== "/") continue;
      const maxAge = attribute("max-age");
      const expires = attribute("expires");
      const expired =
        maxAge && /^-?\d+$/.test(maxAge)
          ? Number(maxAge) <= 0
          : expires
            ? Date.parse(expires) <= Date.now()
            : false;
      if (match[2] && !expired) this.sessionCookies.set(match[1], match[2]);
      else this.sessionCookies.delete(match[1]);
    }
  }
  private stageFailure(error: unknown, stage: import("./quarkTransport").QuarkProviderStage) {
    if (error instanceof QuarkError && !error.providerStage) error.providerStage = stage;
    return error;
  }
  guard() {
    this.guardExtra();
    const current = this.getConfig();
    const session = quarkSession(current);
    if (
      session.identity !== this.session.identity ||
      session.binding !== this.session.binding ||
      quarkRoot(current?.remoteRoot ?? "") !== this.root
    )
      throw new QuarkError("sync_scope_changed");
  }
  private async request(
    path: string,
    body?: unknown,
    query: Record<string, string> = {}
  ) {
    this.guard();
    const url = new URL(`https://drive-pc.quark.cn/1/clouddrive${path}`);
    url.search = new URLSearchParams({
      pr: "ucpro",
      fr: "pc",
      ...query,
    }).toString();
    const requestStage: Partial<Record<string, import("./quarkTransport").QuarkProviderStage>> = {
      "/file/upload/pre": "upload_prepare",
      "/file/update/hash": "upload_hash",
      "/file/upload/auth": "upload_authorize",
      "/file/upload/finish": "upload_finish",
    };
    const stage = requestStage[path];
    try {
      const response = await this.transport({
        url: url.href,
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: this.cookieHeader(),
          Referer: "https://pan.quark.cn/",
          "Content-Type": "application/json",
          "User-Agent": QUARK_DRIVE_USER_AGENT,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      this.guard();
      const result = quarkJson(response);
      if (result.code !== 0 || result.status !== 200)
        throw new QuarkError("api_rejected", body !== undefined);
      this.refreshCookies(response.cookies);
      return result;
    } catch (error) {
      if (stage) throw this.stageFailure(error, stage);
      throw error;
    }
  }
  private entry(raw: any): QuarkEntry {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.file_name !== "string" ||
      typeof raw.file !== "boolean" ||
      !integer(raw.size) ||
      !integer(raw.updated_at) ||
      !integer(raw.created_at)
    )
      throw new QuarkError("invalid_metadata");
    if (quarkKey(raw.file_name).length !== 1 || raw.file_name.endsWith("/"))
      throw new QuarkError("invalid_filename");
    return {
      fid: fidOf(raw.fid),
      name: raw.file_name,
      directory: !raw.file,
      size: raw.file ? raw.size : 0,
      mtime: raw.updated_at,
      ctime: raw.created_at,
      key: "",
    };
  }
  async list(parent: string): Promise<QuarkEntry[]> {
    fidOf(parent);
    const output: QuarkEntry[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    let expected: number | undefined;
    for (let page = 1; page <= 100; page++) {
      const result = await this.request("/file/sort", undefined, {
        pdir_fid: parent,
        _size: "100",
        _page: String(page),
        _fetch_total: "1",
        _sort: "file_type:asc,name:asc",
        fetch_all_file: "1",
        fetch_risk_file_name: "1",
      });
      const total = result.metadata?._total;
      if (
        !integer(total) ||
        total > 10000 ||
        (expected !== undefined && expected !== total) ||
        !Array.isArray(result.data?.list) ||
        result.data.list.length > 100
      )
        throw new QuarkError("incomplete_listing");
      expected = total;
      for (const raw of result.data.list) {
        if (raw.pdir_fid !== undefined && raw.pdir_fid !== parent)
          throw new QuarkError("invalid_entry_parent");
        const entry = this.entry(raw);
        if (entry.fid === parent || ids.has(entry.fid) || names.has(entry.name))
          throw new QuarkError("ambiguous_listing");
        ids.add(entry.fid);
        names.add(entry.name);
        output.push(entry);
      }
      if (output.length === total) return output;
      if (output.length > total || result.data.list.length === 0)
        throw new QuarkError("incomplete_listing");
    }
    throw new QuarkError("listing_limit");
  }
  async prepareRoot(): Promise<void> {
    await this.rootId(true);
  }
  private async rootId(createIfMissing = false): Promise<string> {
    let id = "0";
    for (const name of quarkKey(this.root.slice(1))) {
      let entry = (await this.list(id)).find((e) => e.name === name);
      if (!entry && createIfMissing) {
        const created = await this.request("/file", {
          dir_init_lock: false,
          dir_path: "",
          file_name: name,
          pdir_fid: id,
        });
        entry = (await this.list(id)).find((e) => e.name === name);
        if (
          !entry?.directory ||
          (created.data?.fid !== undefined && created.data.fid !== entry.fid)
        )
          throw new QuarkError("directory_creation_not_confirmed", true);
      }
      if (entry && !entry.directory) throw new QuarkError("path_type_mismatch");
      if (!entry) throw new QuarkError("root_not_found");
      id = entry.fid;
    }
    if (id === "0") throw new QuarkError("account_root_forbidden");
    return id;
  }
  async scan(onProgress?: (files: number, folders: number) => void): Promise<QuarkEntry[]> {
    const queue = [{ id: await this.rootId(), prefix: "" }];
    const seen = new Set<string>([queue[0].id]);
    const output: QuarkEntry[] = [];
    let files = 0, folders = 0;
    for (let index = 0; index < queue.length; index++) {
      for (const entry of await this.list(queue[index].id)) {
        if (replacementBackup.test(entry.name))
          throw new QuarkError("replacement_recovery_required", true);
        // Reserved disposable probe names are not notes, including on another
        // device or after an interrupted diagnostic operation.
        if (
          /^rs-overwrite-check-[A-Za-z0-9_-]{32}\.bin(?: \(\d+\))?$/.test(
            entry.name
          ) ||
          /^rs-overwrite-check-[A-Za-z0-9_-]{32} \(\d+\)\.bin$/.test(
            entry.name
          ) ||
          replacementUpload.test(entry.name)
        )
          continue;
        if (seen.has(entry.fid) || output.length >= 10000)
          throw new QuarkError("scan_limit_or_cycle");
        seen.add(entry.fid);
        entry.key = `${queue[index].prefix}${entry.name}${entry.directory ? "/" : ""}`;
        output.push(entry);
        if (entry.directory) folders++; else files++;
        onProgress?.(files, folders);
        if (entry.directory) queue.push({ id: entry.fid, prefix: entry.key });
      }
    }
    this.guard();
    return output;
  }
  private async location(key: string) {
    const parts = quarkKey(key);
    let parent = await this.rootId();
    for (const name of parts.slice(0, -1)) {
      const folder = (await this.list(parent)).find((e) => e.name === name);
      if (!folder?.directory) throw new QuarkError("parent_not_found");
      parent = folder.fid;
    }
    const name = parts[parts.length - 1];
    const entry = (await this.list(parent)).find((e) => e.name === name);
    if (entry && entry.directory !== key.endsWith("/"))
      throw new QuarkError("path_type_mismatch");
    if (entry) entry.key = key;
    return { parent, name, entry };
  }
  async stat(key: string) {
    const { entry } = await this.location(key);
    if (!entry) throw new QuarkError("not_found");
    return entry;
  }
  async read(key: string): Promise<ArrayBuffer> {
    const entry = await this.stat(key);
    if (entry.directory || entry.size > QUARK_MAX_BYTES)
      throw new QuarkError("download_limit_or_type");
    const result = await this.request("/file/download", { fids: [entry.fid] });
    if (
      !Array.isArray(result.data) ||
      result.data.length !== 1 ||
      (result.data[0]?.fid !== undefined && result.data[0].fid !== entry.fid)
    )
      throw new QuarkError("invalid_download_metadata");
    let url = quarkUrl(result.data[0]?.download_url);
    for (let hop = 0; hop <= 5; hop++) {
      this.guard();
      // Domain session cookies are needed by the approved Quark download hosts.
      // Never forward them to a redirect destination or external storage host.
      const headers: Record<string, string> = {
        Referer: "https://pan.quark.cn/",
        "User-Agent": QUARK_DRIVE_USER_AGENT,
      };
      if (hop === 0 && quarkSessionHost(url.hostname))
        headers.Cookie = this.cookieHeader();
      const response = await this.transport({
        url: url.href,
        method: "GET",
        headers,
        maxBytes: entry.size,
      });
      this.guard();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location || hop === 5)
          throw new QuarkError("download_redirect");
        url = quarkUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.status !== 200 || response.body.byteLength !== entry.size)
        throw new QuarkError("incomplete_download");
      return response.body.slice().buffer;
    }
    throw new QuarkError("download_redirect");
  }
  async mkdir(key: string) {
    if (!key.endsWith("/")) throw new QuarkError("directory_key_required");
    const { parent, name, entry } = await this.location(key);
    if (entry) return entry;
    const created = await this.request("/file", {
      dir_init_lock: false,
      dir_path: "",
      file_name: name,
      pdir_fid: parent,
    });
    await this.waitTask(created);
    const expectedFid = created.data?.fid === undefined ? undefined : fidOf(created.data.fid);
    // Quark can acknowledge folder creation before its listing reflects the new
    // entry. Confirm by reading the known parent; never replay the create POST.
    for (let attempt = 0; attempt < 11; attempt++) {
      const found = (await this.list(parent)).find((item) => item.name === name);
      if (found) {
        if (!found.directory) throw new QuarkError("path_type_mismatch");
        if (expectedFid && found.fid !== expectedFid)
          throw new QuarkError("directory_creation_not_confirmed", true);
        found.key = key;
        return found;
      }
      if (attempt < 10) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new QuarkError("directory_creation_not_confirmed", true);
  }
  private async waitTask(result: any) {
    if (result.data?.task_id === undefined) return;
    const task = text(result.data.task_id);
    for (let retry = 0; retry < 30; retry++) {
      const response = await this.request("/task", undefined, {
        task_id: task,
        retry_index: String(retry),
      });
      if (response.data?.status === 2) return;
      if (response.data?.status !== 0 && response.data?.status !== 1)
        throw new QuarkError("task_failed", true);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new QuarkError("task_timeout", true);
  }
  async remove(key: string) {
    const { entry } = await this.location(key);
    if (!entry) return;
    await this.waitTask(
      await this.request("/file/delete", {
        action_type: 1,
        exclude_fids: [],
        filelist: [entry.fid],
      })
    );
    if ((await this.location(key)).entry)
      throw new QuarkError("delete_not_confirmed", true);
  }
  async write(key: string, content: ArrayBuffer, mtime: number, ctime: number) {
    return this.writeChecked(key, content, mtime, ctime, false);
  }
  private async writeChecked(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    diagnostic: boolean
  ) {
    if (
      key.endsWith("/") ||
      content.byteLength > QUARK_MAX_BYTES ||
      !integer(mtime) ||
      !integer(ctime)
    )
      throw new QuarkError("invalid_upload");
    const { parent, name, entry } = await this.location(key);
    if ((await this.list(parent)).some((e) => replacementBackup.test(e.name)))
      throw new QuarkError("replacement_recovery_required", true);
    if (entry) {
      const previous = await this.read(key);
      if (
        hash("sha256", new Uint8Array(previous)) ===
        hash("sha256", new Uint8Array(content))
      )
        return entry;
      const config = this.getConfig()!;
      if (
        !diagnostic &&
        config.overwriteVerified !== quarkOverwriteBinding(config)
      )
        throw new QuarkError("overwrite_not_verified");
      return this.replaceChecked(
        key,
        entry,
        new Uint8Array(previous),
        content,
        mtime,
        ctime,
        diagnostic
      );
    }
    const bytes = new Uint8Array(content);
    if (!bytes.byteLength) throw new QuarkError("empty_upload_not_supported");
    const mime = mimeLookup(name) || "application/octet-stream";
    const result = await this.request("/file/upload/pre", {
      ccp_hash_update: true,
      dir_name: "",
      file_name: name,
      format_type: mime,
      l_created_at: ctime,
      l_updated_at: mtime,
      pdir_fid: parent,
      size: bytes.byteLength,
    });
    const pre = result.data;
    const task = text(pre?.task_id);
    const updated = await this.request("/file/update/hash", {
      md5: hash("md5", bytes),
      sha1: hash("sha1", bytes),
      task_id: task,
    });
    if (updated.data?.finish !== true && pre.finish !== true) {
      const uploadId = text(pre.upload_id),
        objectKey = text(pre.obj_key),
        bucket = text(pre.bucket);
      const endpoint = new URL(
        text(pre.upload_url).replace(/^http:/, "https:")
      );
      if (
        !/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket) ||
        (!endpoint.hostname.endsWith(".aliyuncs.com") &&
          endpoint.hostname !== "pds.quark.cn") ||
        endpoint.pathname !== "/" ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.username ||
        endpoint.password ||
        endpoint.port ||
        objectKey.split("/").some((p) => !p || p === "." || p === "..") ||
        !/^[A-Za-z0-9_/-]+$/.test(objectKey)
      )
        throw new QuarkError("invalid_oss_endpoint");
      const base = quarkUrl(
        `https://${bucket}.${endpoint.hostname}/${objectKey}`
      );
      const partSize = result.metadata?.part_size;
      if (
        !integer(partSize) ||
        partSize < 64 * 1024 ||
        partSize > QUARK_MAX_BYTES
      )
        throw new QuarkError("invalid_part_size");
      const authInfo = text(pre.auth_info);
      const sign = async (method: "PUT" | "POST", canonical: string) => {
        const auth = await this.request("/file/upload/auth", {
          auth_info: authInfo,
          task_id: task,
          auth_meta: canonical,
        });
        return text(auth.data?.auth_key);
      };
      const parts: string[] = [];
      for (
        let offset = 0, number = 1;
        offset < bytes.length;
        offset += partSize, number++
      ) {
        const date = new Date().toUTCString();
        const resource = `/${bucket}/${objectKey}?partNumber=${number}&uploadId=${uploadId}`;
        const canonical = `PUT\n\n${mime}\n${date}\nx-oss-date:${date}\nx-oss-user-agent:${OSS_AGENT}\n${resource}`;
        const authorization = await sign("PUT", canonical);
        const url = new URL(base);
        url.search = new URLSearchParams({
          partNumber: String(number),
          uploadId,
        }).toString();
        this.guard();
        let response;
        try {
          response = await this.transport({
            url: url.href,
            method: "PUT",
            body: bytes.slice(offset, offset + partSize),
            headers: {
              Authorization: authorization,
              "Content-Type": mime,
              "x-oss-date": date,
              "x-oss-user-agent": OSS_AGENT,
              Referer: "https://pan.quark.cn/",
            },
          });
        } catch (error) {
          throw this.stageFailure(error, "upload_part");
        }
        this.guard();
        const etag = response.headers.etag;
        if (
          response.status !== 200 ||
          !etag ||
          !/^"?[a-fA-F0-9]{32}"?$/.test(etag)
        )
          throw Object.assign(new QuarkError("part_upload_failed", true), { providerStage: "upload_part" as const });
        parts.push(
          `<Part><PartNumber>${number}</PartNumber><ETag>${etag}</ETag></Part>`
        );
      }
      if (
        !pre.callback ||
        typeof pre.callback !== "object" ||
        Array.isArray(pre.callback)
      )
        throw new QuarkError("invalid_callback");
      const callback = Buffer.from(JSON.stringify(pre.callback)).toString(
        "base64"
      );
      const xml = `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`;
      const md5 = hash("md5", xml, "base64"),
        date = new Date().toUTCString();
      const canonical = `POST\n${md5}\napplication/xml\n${date}\nx-oss-callback:${callback}\nx-oss-date:${date}\nx-oss-user-agent:${OSS_AGENT}\n/${bucket}/${objectKey}?uploadId=${uploadId}`;
      const authorization = await sign("POST", canonical);
      const url = new URL(base);
      url.search = new URLSearchParams({ uploadId }).toString();
      this.guard();
      let response;
      try {
        response = await this.transport({
          url: url.href,
          method: "POST",
          body: xml,
          headers: {
            Authorization: authorization,
            "Content-Type": "application/xml",
            "Content-MD5": md5,
            "x-oss-callback": callback,
            "x-oss-date": date,
            "x-oss-user-agent": OSS_AGENT,
            Referer: "https://pan.quark.cn/",
          },
        });
      } catch (error) {
        throw this.stageFailure(error, "upload_commit");
      }
      this.guard();
      if (response.status !== 200)
        throw Object.assign(new QuarkError("upload_commit_failed", true), { providerStage: "upload_commit" as const });
      await this.request("/file/upload/finish", {
        obj_key: objectKey,
        task_id: task,
      });
    }
    try {
      return await this.confirmUpload(key, bytes);
    } catch (error) {
      throw this.stageFailure(error, "upload_confirm");
    }
  }
  private async renameOwned(
    parent: string,
    source: string,
    fid: string,
    destination: string
  ) {
    const before = await this.list(parent);
    if (
      before.find((e) => e.name === source)?.fid !== fid ||
      before.some((e) => e.name === destination)
    )
      throw new QuarkError("replacement_target_changed", true);
    let failure: unknown;
    try {
      await this.waitTask(
        await this.request("/file/rename", { fid, file_name: destination })
      );
    } catch (error) {
      failure = error;
    }
    // Reconcile a lost mutation response by reading state, never repeating it.
    for (let attempt = 0; attempt < 5; attempt++) {
      const entries = await this.list(parent);
      const from = entries.find((e) => e.name === source),
        to = entries.find((e) => e.name === destination);
      if (!from && to?.fid === fid) return;
      if ((from && from.fid !== fid) || (to && to.fid !== fid))
        throw new QuarkError("replacement_target_changed", true);
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        this.guard();
      }
    }
    if (failure) throw failure;
    throw new QuarkError("rename_not_confirmed", true);
  }
  private async deleteOwned(parent: string, name: string, fid: string) {
    if ((await this.list(parent)).find((e) => e.name === name)?.fid !== fid)
      throw new QuarkError("replacement_target_changed", true);
    await this.waitTask(
      await this.request("/file/delete", {
        action_type: 1,
        exclude_fids: [],
        filelist: [fid],
      })
    );
    if ((await this.list(parent)).some((e) => e.fid === fid || e.name === name))
      throw new QuarkError("delete_not_confirmed", true);
  }
  private async replaceChecked(
    key: string,
    original: QuarkEntry,
    previous: Uint8Array,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    diagnostic: boolean
  ): Promise<QuarkEntry> {
    const { parent, name } = await this.location(key);
    const prefix = key.slice(0, key.length - name.length);
    const nonce = nanoid(32);
    const stagedName = `rsnext-upload-${nonce}.bin`;
    const backupName = `rsnext-backup-${nonce}--${name}`;
    const stagedKey = `${prefix}${stagedName}`,
      backupKey = `${prefix}${backupName}`;
    if (
      (await this.list(parent)).some(
        (e) => e.name === stagedName || e.name === backupName
      )
    )
      throw new QuarkError("replacement_target_changed", true);
    // The old file remains at its normal name until the new bytes have been
    // uploaded and downloaded successfully under a unique staging name.
    const staged = await this.writeChecked(
      stagedKey,
      content,
      mtime,
      ctime,
      false
    );
    const oldHash = hash("sha256", previous);
    if (
      (await this.stat(key)).fid !== original.fid ||
      hash("sha256", new Uint8Array(await this.read(key))) !== oldHash
    )
      throw new QuarkError("replacement_target_changed", true);
    if (diagnostic) {
      // Test occupied-name rename using only disposable probe files. A local
      // existence check alone cannot protect another device's concurrent file.
      let rejected = false;
      try {
        await this.waitTask(
          await this.request("/file/rename", {
            fid: staged.fid,
            file_name: name,
          })
        );
      } catch (error) {
        if (
          error instanceof QuarkError &&
          (error.code === "api_rejected" || error.code === "http_400")
        )
          rejected = true;
        else {
          if (error instanceof QuarkError)
            error.operation = "rename_conflict_probe";
          throw error;
        }
      }
      const entries = await this.list(parent);
      if (
        !rejected ||
        entries.find((e) => e.name === name)?.fid !== original.fid ||
        entries.find((e) => e.name === stagedName)?.fid !== staged.fid
      )
        throw new QuarkError("rename_overwrites_target", true);
      if (
        hash("sha256", new Uint8Array(await this.read(key))) !== oldHash ||
        hash("sha256", new Uint8Array(await this.read(stagedKey))) !==
          hash("sha256", new Uint8Array(content))
      )
        throw new QuarkError("rename_overwrites_target", true);
    }
    let operation: QuarkError["operation"] = "backup_rename";
    try {
      await this.renameOwned(parent, name, original.fid, backupName);
      operation = "publish_rename";
      await this.renameOwned(parent, stagedName, staged.fid, name);
      operation = "published_validation";
      const published = await this.confirmUpload(key, new Uint8Array(content));
      if (published.fid !== staged.fid)
        throw new QuarkError("replacement_target_changed", true);
      if (
        (await this.stat(backupKey)).fid !== original.fid ||
        hash("sha256", new Uint8Array(await this.read(backupKey))) !== oldHash
      )
        throw new QuarkError("replacement_target_changed", true);
      operation = "backup_cleanup";
      await this.deleteOwned(parent, backupName, original.fid);
      return published;
    } catch (error) {
      if (error instanceof QuarkError) error.operation = operation;
      // Restore only an empty destination and the exact, unchanged backup.
      // If publish may have succeeded or another device touched either name,
      // preserve both copies and stop; scans refuse an outstanding backup.
      this.guard();
      const entries = await this.list(parent);
      const target = entries.find((e) => e.name === name),
        backup = entries.find((e) => e.name === backupName);
      if (
        !target &&
        backup?.fid === original.fid &&
        hash("sha256", new Uint8Array(await this.read(backupKey))) === oldHash
      ) {
        try {
          await this.renameOwned(parent, backupName, original.fid, name);
        } catch {
          const recovery = new QuarkError(
            "replacement_recovery_required",
            true
          );
          recovery.operation = "rollback_rename";
          throw recovery;
        }
      } else if (backup) {
        const recovery = new QuarkError("replacement_recovery_required", true);
        recovery.operation = operation;
        throw recovery;
      }
      throw error;
    }
  }
  private async confirmUpload(
    key: string,
    bytes: Uint8Array
  ): Promise<QuarkEntry> {
    const expected = hash("sha256", bytes);
    // The upload finish response can precede the updated directory listing.
    // Retry only read-back confirmation; never repeat the upload or delete.
    for (let attempt = 0; attempt < 5; attempt++) {
      this.guard();
      try {
        const saved = await this.stat(key);
        if (saved.directory) throw new QuarkError("path_type_mismatch", true);
        if (
          saved.size === bytes.length &&
          hash("sha256", new Uint8Array(await this.read(key))) === expected
        ) {
          this.guard();
          return saved;
        }
      } catch (error) {
        if (!(error instanceof QuarkError) || error.code !== "not_found")
          throw error;
      }
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        this.guard();
      }
    }
    throw new QuarkError("upload_not_confirmed", true);
  }

  async verifyOverwrite(): Promise<string> {
    const key = `rs-overwrite-check-${nanoid(32)}.bin`;
    const first = new Uint8Array([17, 42, 19, 58]).buffer;
    const second = new Uint8Array([63, 11, 88, 6, 32, 9, 7]).buffer;
    // Unpredictable names plus a lookup prevent any user-file collision.
    if ((await this.location(key)).entry)
      throw new QuarkError("probe_name_collision");
    let original: QuarkEntry | undefined;
    let failure: unknown;
    let stage: import("./quarkTransport").QuarkProbeStage = "initial_upload";
    try {
      original = await this.writeChecked(
        key,
        first,
        Date.now(),
        Date.now(),
        false
      );
      stage = "overwrite";
      const replaced = await this.writeChecked(
        key,
        second,
        Date.now(),
        Date.now(),
        true
      );
      original = replaced;
      return quarkOverwriteBinding(this.getConfig()!);
    } catch (error) {
      failure = error;
      if (error instanceof QuarkError) error.stage = stage;
      throw error;
    } finally {
      // Cleanup only the exact file created by this probe. If the API renamed
      // or produced duplicates, leave the residue for inspection, don't guess.
      if (original) {
        try {
          const current = (await this.location(key)).entry;
          if (current?.fid !== original.fid) {
            if (!failure)
              throw new QuarkError("probe_cleanup_identity_changed", true);
          } else {
            // Delete the owned FID, not whichever object a later path lookup finds.
            await this.waitTask(
              await this.request("/file/delete", {
                action_type: 1,
                exclude_fids: [],
                filelist: [original.fid],
              })
            );
            if ((await this.location(key)).entry)
              throw new QuarkError("delete_not_confirmed", true);
          }
        } catch (error) {
          if (error instanceof QuarkError) error.stage = "cleanup";
          throw error;
        }
      }
    }
  }
}
