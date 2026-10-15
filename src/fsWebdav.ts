import { desktopWebdavRequest } from "./native/webdavDesktopTransport";
import { resolveWebdavDirectory } from "./webdavDirectory";
import { Buffer } from "buffer";
import { createHash } from "crypto";
import { getReasonPhrase } from "http-status-codes/build/cjs/utils-functions";
import cloneDeep from "lodash/cloneDeep";
import PQueue from "p-queue";
import { retryWebdavRead, transientWebdavError, type WebdavDiagnostics } from "./webdavRetry";
import { nanoid } from "nanoid";
import { Platform, type RequestUrlParam, requestUrl } from "obsidian";
import type {
  FileStat,
  RequestOptionsWithState,
  WebDAVClient,
  // Response,
  // ResponseDataDetailed,
} from "webdav";
import type { Entity, WebdavConfig } from "./baseTypes";
import { VALID_REQURL } from "./baseTypesObs";
import { FakeFs } from "./fsAll";
import { bufferToArrayBuffer, delay, splitFileSizeToChunkRanges } from "./misc";

/**
 * https://stackoverflow.com/questions/32850898/how-to-check-if-a-string-has-any-non-iso-8859-1-characters-with-javascript
 * @param str
 * @returns true if all are iso 8859 1 chars
 */
function onlyAscii(str: string) {
  return !/[^\u0000-\u00ff]/g.test(str);
}

/**
 * https://stackoverflow.com/questions/12539574/
 * @param obj
 * @returns
 */
function objKeyToLower(obj: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v])
  );
}

// @ts-ignore
import { getPatcher } from "webdav/dist/web/index.js";
if (VALID_REQURL) {
  getPatcher().patch(
    "request",
    async (options: RequestOptionsWithState): Promise<Response> => {
      const transformedHeaders = objKeyToLower({ ...options.headers });
      delete transformedHeaders["host"];
      delete transformedHeaders["content-length"];

      const reqContentType =
        transformedHeaders["accept"] ?? transformedHeaders["content-type"];

      const retractedHeaders = { ...transformedHeaders };
      if (retractedHeaders.hasOwnProperty("authorization")) {
        retractedHeaders["authorization"] = "<retracted>";
      }

      // console.debug(`before request:`);
      // console.debug(`url: ${options.url}`);
      // console.debug(`method: ${options.method}`);
      // console.debug(`headers: ${JSON.stringify(retractedHeaders, null, 2)}`);
      // console.debug(`reqContentType: ${reqContentType}`);

      const p: RequestUrlParam = {
        url: options.url,
        method: options.method,
        body: options.data as string | ArrayBuffer,
        headers: transformedHeaders,
        contentType: reqContentType,
        throw: false,
      };

      const execute = () => Platform.isDesktopApp
        ? desktopWebdavRequest({...p,method:p.method ?? "GET",signal:options.signal})
        : requestUrl(p);
      let r = await execute();

      if (
        r.status === 401 &&
        Platform.isIosApp &&
        !options.url.endsWith("/") &&
        !options.url.endsWith(".md") &&
        options.method.toUpperCase() === "PROPFIND"
      ) {
        // don't ask me why,
        // some webdav servers have some mysterious behaviours,
        // if a folder doesn't exist without slash, the servers return 401 instead of 404
        // here is a dirty hack that works
        console.debug(`so we have 401, try appending request url with slash`);
        p.url = `${options.url}/`;
        r = await execute();
      }

      // console.debug(`after request:`);
      const rspHeaders = objKeyToLower({ ...r.headers });
      // console.debug(`rspHeaders: ${JSON.stringify(rspHeaders, null, 2)}`);
      for (const key in rspHeaders) {
        if (rspHeaders.hasOwnProperty(key)) {
          // avoid the error:
          // Failed to read the 'headers' property from 'ResponseInit': String contains non ISO-8859-1 code point.
          // const possibleNonAscii = [
          //   "Content-Disposition",
          //   "X-Accel-Redirect",
          //   "X-Outfilename",
          //   "X-Sendfile"
          // ];
          // for (const p of possibleNonAscii) {
          //   if (key === p || key === p.toLowerCase()) {
          //     rspHeaders[key] = encodeURIComponent(rspHeaders[key]);
          //   }
          // }
          if (!onlyAscii(rspHeaders[key])) {
            // console.debug(`rspHeaders[key] needs encode: ${key}`);
            rspHeaders[key] = encodeURIComponent(rspHeaders[key]);
          }
        }
      }

      let r2: Response | undefined = undefined;
      const statusText = getReasonPhrase(r.status);
      // console.debug(`statusText: ${statusText}`);
      if ([101, 103, 204, 205, 304].includes(r.status)) {
        // A null body status is a status that is 101, 103, 204, 205, or 304.
        // https://fetch.spec.whatwg.org/#statuses
        // fix this: Failed to construct 'Response': Response with null body status cannot have body
        r2 = new Response(null, {
          status: r.status,
          statusText: statusText,
          headers: rspHeaders,
        });
      } else {
        r2 = new Response(r.arrayBuffer, {
          status: r.status,
          statusText: statusText,
          headers: rspHeaders,
        });
      }

      return r2;
    }
  );
}

// @ts-ignore
// biome-ignore lint: we want to ts-ignore the next line
import { AuthType, BufferLike, createClient } from "webdav/dist/web/index.js";

export const DEFAULT_WEBDAV_CONFIG = {
  address: "",
  username: "",
  password: "",
  authType: "basic",
  manualRecursive: true,
  depth: "manual_1",
  remoteBaseDir: "",
} as WebdavConfig;

const getWebdavPath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  let key = fileOrFolderPath;
  if (fileOrFolderPath === "/" || fileOrFolderPath === "") {
    // special
    key = `/${remoteBaseDir}/`;
  } else if (fileOrFolderPath.startsWith("/")) {
    console.warn(
      `why the path ${fileOrFolderPath} starts with '/'? but we just go on.`
    );
    key = `/${remoteBaseDir}${fileOrFolderPath}`;
  } else {
    key = `/${remoteBaseDir}/${fileOrFolderPath}`;
  }
  return key;
};

/**
 * sometimes the path startswith /../../......
 * we want to make sure the path is compatible
 */
const stripLeadingPath = (x: string) => {
  let y = x;
  while (y.startsWith("/..")) {
    y = y.slice("/..".length);
  }
  return y;
};

const getNormPath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  const strippedFileOrFolderPath = stripLeadingPath(fileOrFolderPath);
  if (
    !(
      strippedFileOrFolderPath === `/${remoteBaseDir}` ||
      strippedFileOrFolderPath.startsWith(`/${remoteBaseDir}/`)
    )
  ) {
    throw Error(
      `"${fileOrFolderPath}" after stripping doesn't starts with "/${remoteBaseDir}/"`
    );
  }
  const result = strippedFileOrFolderPath.slice(`/${remoteBaseDir}/`.length);
  return result;
};

const fromWebdavItemToEntity = (x: FileStat, remoteBaseDir: string): Entity => {
  let key = getNormPath(x.filename, remoteBaseDir);

  if (x.type === "directory" && !key.endsWith("/")) {
    key = `${key}/`;
  }
  const mtimeSvr = Date.parse(x.lastmod).valueOf();
  return {
    key: key,
    keyRaw: key,
    mtimeSvr: mtimeSvr,
    mtimeCli: mtimeSvr, // TODO: no universal way to set mtime in webdav
    size: x.size,
    sizeRaw: x.size,
    etag: typeof x.etag === "string" ? x.etag : undefined,
  };
};

const tryEncodeURI = (x: string) => {
  if (x.includes("%")) {
    // likely encoded before!
    return x;
  }
  return encodeURI(x);
};

const tryEncodeUsernamePassword = (x: string) => {
  if (onlyAscii(x)) {
    return x;
  }
  return unescape(encodeURIComponent(x));
};

const parseCustomHeaders = (x: string): Record<string, string> => {
  const y = x.trim();
  if (y === "") {
    return {};
  }
  const z = y.split("\n");

  const res: Record<string, string> = {};

  for (const kv of z) {
    if (!kv.includes(":")) {
      continue;
    }

    const [keyRaw, ...valueArr] = kv.split(":");
    const key = keyRaw.trim();
    const value = valueArr.join(":").trim();
    res[key] = value;
  }

  return res;
};

// Measure the actual remote target, which may already be encrypted. These are
// observations, not server limits; never infer a length failure from HTTP 403.
export const addWebdavPathDiagnostics = (
  error: unknown,
  remotePath: string,
  operation: string
): unknown => {
  try {
    if (
      typeof error !== "object" ||
      error === null ||
      !("message" in error) ||
      typeof error.message !== "string" ||
      "webdavPathDiagnostics" in error
    ) {
      return error;
    }
    const segments = remotePath.split("/");
    const diagnostics = {
      operation,
      pathCodePoints: Array.from(remotePath).length,
      pathUtf8Bytes: Buffer.byteLength(remotePath, "utf8"),
      maxSegmentUtf8Bytes: segments.reduce(
        (max, segment) => Math.max(max, Buffer.byteLength(segment, "utf8")),
        0
      ),
      // Encoded target path only, excluding the endpoint prefix and query.
      encodedPathBytes: Buffer.byteLength(
        segments.map(encodeURIComponent).join("/"),
        "utf8"
      ),
    };
    const message = `${error.message} [WebDAV path metrics: operation=${operation}, codePoints=${diagnostics.pathCodePoints}, utf8Bytes=${diagnostics.pathUtf8Bytes}, maxSegmentUtf8Bytes=${diagnostics.maxSegmentUtf8Bytes}, encodedPathBytes=${diagnostics.encodedPathBytes}; target path only, server limits unknown]`;
    Object.assign(error, { webdavPathDiagnostics: diagnostics, message });
  } catch {
    // Diagnostics must not replace frozen errors or encoding failures.
  }
  return error;
};

export class FakeFsWebdav extends FakeFs {
  kind: "webdav";

  webdavConfig: WebdavConfig;
  remoteBaseDir: string;
  client!: WebDAVClient;
  private initPromise?: Promise<void>;
  vaultFolderExists: boolean;
  saveUpdatedConfigFunc: () => Promise<any>;

  isNextcloud: boolean;
  nextcloudUploadServerAddress: string;
  readonly diagnostics: WebdavDiagnostics = { requests: 0, retries: 0, elapsedMs: 0, operations: {} };
  private scanQueue?: PQueue;
  private snapshot?: Map<string, Entity>;
  private readonly readController = new AbortController();
  cancelPendingReads = () => this.readController.abort();

  private strongEtag(entity?: Entity): string | undefined {
    const tag = entity?.etag;
    // The installed SDK strips quotes. Weak tags cannot guard If-Match.
    return tag && !tag.startsWith("W/") && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(tag) ? `"${tag}"` : undefined;
  }
  private snapshotKey(path: string) { return stripLeadingPath(path).replace(/\/+$/, ""); }
  private remember(path: string, entity: Entity) {
    this.snapshot?.set(this.snapshotKey(path), {...entity});
  }
  statForRead = async (key: string): Promise<Entity> => {
    const cached = this.snapshot?.get(this.snapshotKey(getWebdavPath(key, this.remoteBaseDir)));
    return cached && this.strongEtag(cached) ? {...cached} : this.stat(key);
  };
  private async versionHeaders(path: string, writing = false): Promise<Record<string, string>> {
    if (!this.snapshot) return {};
    const expected = this.snapshot.get(this.snapshotKey(path));
    if (!expected) {
      if (writing) return {"If-None-Match": "*"};
      throw Object.assign(new Error("Remote file changed after scan"), {code: "plan_changed"});
    }
    if (expected.key!.endsWith("/")) return {};
    const tag = this.strongEtag(expected);
    if (tag) return {"If-Match": tag};
    // Servers without usable ETags still get a fresh metadata check. This is
    // conservative but cannot detect equal-size edits within timestamp precision.
    const actual = await this._statFromRoot(path);
    if (expected.sizeRaw !== actual.sizeRaw || expected.mtimeSvr !== actual.mtimeSvr || expected.etag !== actual.etag)
      throw Object.assign(new Error("Remote file changed after scan"), {code: "plan_changed"});
    return expected.mtimeSvr && Number.isFinite(expected.mtimeSvr)
      ? {"If-Unmodified-Since": new Date(expected.mtimeSvr).toUTCString()} : {};
  }
  private async nextcloudDestinationConditions(path: string, destination: string): Promise<Record<string,string>> {
    if (!this.snapshot) return {};
    const expected = this.snapshot.get(this.snapshotKey(path));
    if (!expected) return {Overwrite: "F"};
    const headers = await this.versionHeaders(path, true);
    // If-Match on MOVE would apply to the upload session, not its destination.
    // RFC 4918 section 10.4 uses a tagged If list for destination versions.
    return headers["If-Match"] ? {If: `<${destination}> ([${headers["If-Match"]}])`} : {};
  }

  private async readOperation<T>(operation: string, read: () => Promise<T>): Promise<T> {
    return retryWebdavRead(operation, async () => {await this.beforeOperation?.(); return read();}, attempt => {
      this.diagnostics.requests++;
      this.diagnostics.elapsedMs += attempt.elapsedMs;
      this.diagnostics.operations[operation] = (this.diagnostics.operations[operation] ?? 0) + 1;
      if (attempt.retryDelayMs !== undefined) this.diagnostics.retries++;
      if (attempt.status !== undefined) this.diagnostics.lastFailure = {operation, status: attempt.status};
      if (attempt.status === 429 && this.scanQueue) this.scanQueue.concurrency = Math.max(1, Math.floor(this.scanQueue.concurrency / 2));
    });
  }

  constructor(
    webdavConfig: WebdavConfig,
    vaultName: string,
    saveUpdatedConfigFunc: () => Promise<any>
  ) {
    super();
    this.kind = "webdav";
    this.webdavConfig = cloneDeep(webdavConfig);
    this.webdavConfig.address = tryEncodeURI(this.webdavConfig.address);
    // SDK requests normalize boundary slashes; inventory validation and task
    // paths must use the same base, including user-entered /home/test/.
    this.remoteBaseDir = resolveWebdavDirectory(this.webdavConfig, vaultName);
    this.vaultFolderExists = false;
    this.saveUpdatedConfigFunc = saveUpdatedConfigFunc;

    this.isNextcloud = false;
    this.nextcloudUploadServerAddress = "";
  }

  _init(): Promise<void> {
    if (this.initPromise === undefined) {
      const depth = this.webdavConfig.depth;
      const manualRecursive = this.webdavConfig.manualRecursive;
      this.initPromise = this._initOnce().catch((error) => {
        // A later caller can retry the entire initialization after a failure.
        this.initPromise = undefined;
        this.vaultFolderExists = false;
        this.isNextcloud = false;
        this.nextcloudUploadServerAddress = "";
        this.webdavConfig.depth = depth;
        this.webdavConfig.manualRecursive = manualRecursive;
        throw error;
      });
    }
    return this.initPromise;
  }

  private async _initOnce() {
    const cacheHeader = {
      "Cache-Control": "no-cache",
    };
    const customHeaders = parseCustomHeaders(
      this.webdavConfig.customHeaders ?? ""
    );
    const headers = { ...cacheHeader, ...customHeaders };

    if (
      this.webdavConfig.username !== "" &&
      this.webdavConfig.password !== ""
    ) {
      this.client = createClient(this.webdavConfig.address, {
        username: tryEncodeUsernamePassword(this.webdavConfig.username),
        password: tryEncodeUsernamePassword(this.webdavConfig.password),
        headers: headers,
        authType:
          this.webdavConfig.authType === "digest"
            ? AuthType.Digest
            : AuthType.Password,
      });
    } else {
      console.info("no password");
      this.client = createClient(this.webdavConfig.address, {
        headers: headers,
      });
    }

    // check vault folder
    if (this.vaultFolderExists) {
      // pass
    } else {
      const res = await this.readOperation("exists", () => this.client.exists(`/${this.remoteBaseDir}/`, {signal:this.readController.signal}));
      if (res) {
        // console.info("remote vault folder exits!");
        this.vaultFolderExists = true;
      } else {
        console.info("remote vault folder not exists, creating");
        await this.beforeOperation?.();
        await this.client.createDirectory(`/${this.remoteBaseDir}/`);
        console.info("remote vault folder created!");
        this.vaultFolderExists = true;
      }
    }

    // adjust depth parameter
    if (
      this.webdavConfig.depth === "auto" ||
      this.webdavConfig.depth === "auto_1" ||
      this.webdavConfig.depth === "auto_infinity" ||
      this.webdavConfig.depth === "auto_unknown"
    ) {
      this.webdavConfig.depth = "manual_1";
      this.webdavConfig.manualRecursive = true;
      if (this.saveUpdatedConfigFunc !== undefined) {
        await this.saveUpdatedConfigFunc();
        console.info(
          `webdav depth="auto_???" is changed to ${this.webdavConfig.depth}`
        );
      }
    }

    await this._checkPartialSupport();
  }

  /**
   * <server>/remote.php/dav/files/<userid>
   * => <server>/remote.php/dav/uploads/<userid>
   */
  _getnextcloudUploadServerAddress = () => {
    const k = this.webdavConfig.address.replace(/\/+$/, "");
    const s = k.split("/");
    if (
      s.length > 3 &&
      s[s.length - 3] === "dav" &&
      s[s.length - 2] === "files" &&
      s[s.length - 1] !== ""
    ) {
      s[s.length - 2] = "uploads";
      return s.join("/");
    }
    throw Error(`cannot construct upload address for ${s}`);
  };

  async _checkPartialSupport() {
    const compliance = await this.readOperation("capabilities", () => this.client
      .customRequest(`/${this.remoteBaseDir}/`, { method: "OPTIONS", signal: this.readController.signal })
      .then(response => ({ compliance: (response.headers.get("DAV") ?? "").split(",").map(item => item.trim()), server: response.headers.get("Server") ?? "" })))
      .catch((error: unknown) => {
        // Capability discovery is optional when OPTIONS is unsupported.
        // Authentication, permission and transport failures must still surface.
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          (error.status === 405 || error.status === 501)
        ) {
          return { compliance: [], server: "" };
        }
        throw error;
      });

    for (const c of compliance.compliance) {
      // nextcloud AND with an account
      if (
        c.toLocaleLowerCase().includes("nextcloud") &&
        this.webdavConfig.username !== "" &&
        this.webdavConfig.password !== ""
      ) {
        // the address is parsable
        const s = this.webdavConfig.address.replace(/\/+$/, "").split("/");
        if (
          s.length > 3 &&
          s[s.length - 3] === "dav" &&
          s[s.length - 2] === "files" &&
          s[s.length - 1] !== ""
        ) {
          this.isNextcloud = true;
          this.nextcloudUploadServerAddress =
            this._getnextcloudUploadServerAddress();
          console.debug(
            `isNextcloud=${this.isNextcloud}, uploadFolder=${this.nextcloudUploadServerAddress}`
          );
          return true;
        } else {
          return false;
        }
      }
    }

    return false;
  }

  async walk(): Promise<Entity[]> {
    await this._init();
    this.snapshot = undefined;

    let contents = [] as FileStat[];
    if (
      this.webdavConfig.depth === "auto" ||
      this.webdavConfig.depth === "auto_unknown" ||
      this.webdavConfig.depth === "auto_1" ||
      this.webdavConfig.depth === "auto_infinity" /* don't trust auto now */ ||
      this.webdavConfig.depth === "manual_1" ||
      this.webdavConfig.address.includes("jianguoyun.com") ||
      this.webdavConfig.address.includes("teracloud.jp")
    ) {
      const queue = new PQueue({ concurrency: 6 });
      this.scanQueue = queue;
      const seen = new Set<string>();
      let failure: unknown;
      let scannedFiles = 0, scannedFolders = 0;
      const addDirectory = (path: string) => {
        path = path.replace(/\/+$/, "");
        if (failure || seen.has(path)) return;
        seen.add(path);
        void queue.add(async () => {
          const listing = await this.readOperation("list", () => this.client.getDirectoryContents(path, {
            deep: false, details: false, signal:this.readController.signal,
          })) as FileStat[];
          if (failure) return;
          const children = listing.filter(sub => stripLeadingPath(sub.filename).replace(/\/+$/, "") !== path);
          if (this.webdavConfig.address.includes("jianguoyun.com") && children.length >= 749) {
            throw Error("出错：坚果云 api 有限制，文件列表加载不全。终止同步！");
          }
          for (const child of children) {
            // Reject out-of-scope server entries before scheduling children.
            getNormPath(child.filename, this.remoteBaseDir);
            contents.push(child);
            if (child.type === "directory") {
              scannedFolders++;
              addDirectory(stripLeadingPath(child.filename));
            } else scannedFiles++;
          }
          this.onScanProgress?.(scannedFiles, scannedFolders);
        }).catch(error => {
          failure ??= error;
          queue.pause();
          queue.clear();
        });
      };
      addDirectory(`/${this.remoteBaseDir}`);
      try {
        await queue.onIdle();
        if (failure) throw failure;
      } finally {
        this.scanQueue = undefined;
      }
    } else {
      // the remote supports infinity propfind
      contents = (await this.readOperation("list", () => this.client.getDirectoryContents(
        `/${this.remoteBaseDir}`,
        {
          signal:this.readController.signal,
          deep: true,
          details: false /* no need for verbose details here */,
          // TODO: to support .obsidian,
          // we need to load all files including dot,
          // anyway to reduce the resources?
          // glob: "/**" /* avoid dot files by using glob */,
        }
      ))) as FileStat[];
    }

    const result = contents
      .map((x) => fromWebdavItemToEntity(x, this.remoteBaseDir))
      .filter((x) => x.keyRaw !== "/");
    this.snapshot = new Map(result.map(entity => [this.snapshotKey(getWebdavPath(entity.key!, this.remoteBaseDir)), {...entity}]));
    const files = result.filter(entity => !entity.key!.endsWith("/")).length;
    this.onScanProgress?.(files, result.length - files);
    return result;
  }

  async walkPartial(): Promise<Entity[]> {
    await this._init();

    const contents = (await this.readOperation("listPartial", () => this.client.getDirectoryContents(
      `/${this.remoteBaseDir}`,
      {
        signal:this.readController.signal,
        deep: false, // partial, no need to recursive here
        details: false /* no need for verbose details here */,
      }
    ))) as FileStat[];
    return contents
      .map((x) => fromWebdavItemToEntity(x, this.remoteBaseDir))
      .filter((x) => x.keyRaw !== "/");
  }

  async stat(key: string): Promise<Entity> {
    await this._init();
    const fullPath = getWebdavPath(key, this.remoteBaseDir);
    return await this._statFromRoot(fullPath);
  }

  async _statFromRoot(key: string): Promise<Entity> {
    const res = (await this.readOperation("stat", () => this.client.stat(key, {
      signal:this.readController.signal,
      details: false,
    }))) as FileStat;
    return fromWebdavItemToEntity(res, this.remoteBaseDir);
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    if (!key.endsWith("/")) {
      throw Error(`you should not call mkdir on ${key}`);
    }
    await this._init();
    const uploadFile = getWebdavPath(key, this.remoteBaseDir);
    return await this._mkdirFromRoot(uploadFile, mtime, ctime);
  }

  async _mkdirFromRoot(
    key: string,
    mtime?: number,
    ctime?: number
  ): Promise<Entity> {
    // the sync algorithm should do recursive manually already.
    // if we set recursive: true here, Digest auth will return some error inside the PROPFIND
    await this.beforeOperation?.();
    await this.client.createDirectory(key, {
      recursive: false,
    });
    const entity = await this._statFromRoot(key);
    this.remember(key, entity);
    return entity;
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    if (key.endsWith("/")) {
      throw Error(`you should not call writeFile on ${key}`);
    }
    await this._init();
    const uploadFile = getWebdavPath(key, this.remoteBaseDir);
    return await this._writeFileFromRoot(
      uploadFile,
      content,
      mtime,
      ctime,
      key
    ).catch((error: unknown) => {
      throw addWebdavPathDiagnostics(error, uploadFile, "write");
    });
  }

  async _writeFileFromRoot(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    origKey: string
  ): Promise<Entity> {
    if (content.byteLength > 10 * 1024 * 1024 && this.isNextcloud) {
      return await this._writeFileFromRootNextcloud(
        key,
        content,
        mtime,
        ctime,
        origKey
      );
    }

    // Generic partial updates required truncating the live target first. Use
    // one ordinary PUT instead; do not destroy the old file to start an upload.
    // Atomic replacement during PUT still depends on the server implementation.
    return await this._writeFileFromRootFull(
      key,
      content,
      mtime,
      ctime,
      origKey
    );
  }

  async _writeFileFromRootFull(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    origKey: string
  ): Promise<Entity> {
    // console.debug(`start _writeFileFromRootFull`);
    const headers = await this.versionHeaders(key, true);
    await this.beforeOperation?.();
    let uploadedEtag: string | undefined;
    try { const response = await this.client.customRequest(key, {
      method: "PUT",
      headers: {"Content-Type": "application/octet-stream", ...headers},
      data: content,
    });
      if (![200,201,204].includes(response.status)) throw Object.assign(new Error("Upload was not committed"), {status: response.status});
      uploadedEtag = response.headers.get("etag") ?? undefined;
    } catch (error: any) {
      if (transientWebdavError(error) && error?.status === undefined && error?.response?.status === undefined) {
        // A transport error may arrive after the server committed the PUT.
        // Confirm a strong version and exact bytes; never replay the mutation.
        try {
          const candidate = await this._statFromRoot(key);
          const tag = this.strongEtag(candidate);
          if (tag && candidate.sizeRaw === content.byteLength) {
            const downloaded = await this.readOperation("reconcileUpload", () => this.client.getFileContents(key, {headers: {"If-Match": tag},signal:this.readController.signal}));
            const actual = downloaded instanceof ArrayBuffer ? new Uint8Array(downloaded) : Buffer.isBuffer(downloaded) ? downloaded : undefined;
            if (actual && createHash("sha256").update(actual).digest("hex") === createHash("sha256").update(new Uint8Array(content)).digest("hex")) {
              this.remember(key, candidate);
              return candidate;
            }
          }
        } catch { /* Keep the original uncertain transfer error. */ }
        try { error.outcomeUnknown = true; } catch {}
      }
      throw error;
    }
    const k = await this._statFromRoot(key);
    if (uploadedEtag && this.strongEtag(k) && this.strongEtag(k) !== uploadedEtag)
      throw Object.assign(new Error("Remote file changed after upload"), {code: "plan_changed"});
    if (k.sizeRaw !== content.byteLength) throw Object.assign(new Error("Upload size not confirmed"), {code: "upload_not_confirmed"});
    this.remember(key, k);
    // console.debug(`end _writeFileFromRootFull`);
    return k;
  }

  /**
   * https://docs.nextcloud.com/server/latest/developer_manual/client_apis/WebDAV/chunking.html
   * @param key
   * @param content
   * @param mtime
   * @param ctime
   * @returns
   */
  async _writeFileFromRootNextcloud(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    origKey: string
  ): Promise<Entity> {
    if (key.endsWith("/")) {
      throw Error(
        `key=${key} should not have tailing slash in _writeFileFromRootNextcloud`
      );
    }
    // The SDK encodes ordinary request paths; Destination is a header, so it
    // needs explicit segment encoding. Preserve already encoded base URLs.
    const baseAddress = this.webdavConfig.address.replace(/\/+$/, "");
    const encodedKey = key
      .replace(/^\/+/, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const destUrl = `${baseAddress}/${encodedKey}`;
    const uploadServerAddress = this.nextcloudUploadServerAddress;
    console.debug(`uploadServerAddress=${uploadServerAddress}`);
    const tmpFolderName = `remotely-save-next-${nanoid()}`;
    console.debug(`tmpFolderName=${tmpFolderName}`);

    const clientForUpload = createClient(uploadServerAddress, {
      username: tryEncodeUsernamePassword(this.webdavConfig.username),
      password: tryEncodeUsernamePassword(this.webdavConfig.password),
      headers: {
        "Cache-Control": "no-cache",
        ...parseCustomHeaders(this.webdavConfig.customHeaders ?? ""),
      },
      authType:
        this.webdavConfig.authType === "digest"
          ? AuthType.Digest
          : AuthType.Password,
    });

    // create folder
    await this.beforeOperation?.();
    await clientForUpload.createDirectory(tmpFolderName, {
      method: "MKCOL",
      headers: {
        Destination: destUrl,
      },
    });
    console.debug(`finish creating folder`);

    try {
      // upload by chunks
      const sizePerChunk = 5 * 1024 * 1024; // 5 mb
      const chunkRanges = splitFileSizeToChunkRanges(
        content.byteLength,
        sizePerChunk
      );
      for (let i = 0; i < chunkRanges.length; ++i) {
        const { start, end } = chunkRanges[i];
        const tmpFileName = `${i + 1}`.padStart(5, "0");
        const tmpFileNameWithFolder = `${tmpFolderName}/${tmpFileName}`;
        console.debug(
          `start to upload chunk ${
            i + 1
          } to ${tmpFileNameWithFolder} with startInclusive=${start}, endInclusive=${end}`
        );
        await this.beforeOperation?.();
        await clientForUpload.putFileContents(
          tmpFileNameWithFolder,
          content.slice(start, end + 1),
          {
            headers: {
              Destination: destUrl,
              "OC-Total-Length": `${content.byteLength}`,
            },
          }
        );
      }
      console.debug(`finish upload all chunks`);

      // move to assemble
      const fakeFileToMoveUrl = `${tmpFolderName}/.file`;
      console.debug(`fakeFileToMoveUrl=${fakeFileToMoveUrl}`);
      const destinationConditions = await this.nextcloudDestinationConditions(key, destUrl);
      await this.beforeOperation?.();
      await clientForUpload.customRequest(fakeFileToMoveUrl, {
        method: "MOVE",
        headers: {
          Destination: destUrl,
          "OC-Total-Length": `${content.byteLength}`,
          ...destinationConditions,
        },
      });
      console.debug(`finish moving file`);
    } catch (error) {
      // Only this successfully created session belongs to this operation.
      // Cleanup must never replace the original upload/assembly failure.
      try {
        await clientForUpload.deleteFile(tmpFolderName);
      } catch {
        console.warn("Nextcloud temporary upload cleanup failed");
      }
      throw error;
    }
    // TODO: setting X-OC-Mtime

    // stat
    console.debug(`before stat origKey=${origKey}`);
    const k = await this.stat(origKey);
    console.debug(`after stat`);
    if (k.sizeRaw !== content.byteLength) {
      // we failed!
      this.isNextcloud = false; // give up next time!
      const err = `unable to upload file ${key} by chunks to nextcloud`;
      console.error(err);
      throw Error(err);
    }
    this.remember(key, k);
    console.debug(`after stat, k=${JSON.stringify(k, null, 2)}`);

    return k;
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    if (key.endsWith("/")) {
      throw Error(`you should not call readFile on ${key}`);
    }
    await this._init();
    const downloadFile = getWebdavPath(key, this.remoteBaseDir);
    return await this._readFileFromRoot(downloadFile);
  }

  async _readFileFromRoot(key: string): Promise<ArrayBuffer> {
    const headers = await this.versionHeaders(key);
    const buff = (await this.readOperation("download", () => this.client.getFileContents(key, {headers,signal:this.readController.signal}))) as BufferLike;
    if (buff instanceof ArrayBuffer) {
      return buff;
    } else if (buff instanceof Buffer) {
      return bufferToArrayBuffer(buff);
    }
    throw Error(`unexpected file content result with type ${typeof buff}`);
  }

  async rename(key1: string, key2: string): Promise<void> {
    if (key1 === "/" || key2 === "/") {
      return;
    }
    const remoteFileName1 = getWebdavPath(key1, this.remoteBaseDir);
    const remoteFileName2 = getWebdavPath(key2, this.remoteBaseDir);
    await this._init();
    const headers = await this.versionHeaders(remoteFileName1);
    await this.beforeOperation?.();
    await this.client.moveFile(remoteFileName1, remoteFileName2, {
      overwrite: false, headers,
    });
    if (this.snapshot) {
      const from = this.snapshotKey(remoteFileName1), to = this.snapshotKey(remoteFileName2);
      for (const [path, entry] of [...this.snapshot]) if (path === from || path.startsWith(`${from}/`)) {
        this.snapshot.delete(path);
        const next = to + path.slice(from.length);
        const key = getNormPath(next, this.remoteBaseDir) + (entry.key!.endsWith("/") ? "/" : "");
        this.snapshot.set(next, {...entry, key, keyRaw: key});
      }
    }
  }

  async rm(key: string): Promise<void> {
    if (key === "/") {
      return;
    }
    await this._init();
    const remoteFileName = getWebdavPath(key, this.remoteBaseDir);
    if (this.snapshot && key.endsWith("/")) {
      while (true) {
        await this.beforeOperation?.();
        const revision = this.operationRevision?.();
        const entries = await this.readOperation("verifyEmptyFolder", () => this.client.getDirectoryContents(remoteFileName, {deep: false, details: false, signal:this.readController.signal})) as FileStat[];
        if (entries.some(entry => this.snapshotKey(entry.filename) !== this.snapshotKey(remoteFileName)))
          throw Object.assign(new Error("Folder contents changed after scan"), {code: "plan_changed"});
        await this.beforeOperation?.();
        if (revision === this.operationRevision?.()) break;
      }
    }
    // Let failures (including 404) reach the sync engine. It must not clear
    // previous sync records when the deletion has not been confirmed.
    const headers = await this.versionHeaders(remoteFileName);
    await this.beforeOperation?.();
    await this.client.deleteFile(remoteFileName, {headers});
    const removed = this.snapshotKey(remoteFileName);
    if (this.snapshot) for (const path of this.snapshot.keys())
      if (path === removed || path.startsWith(`${removed}/`)) this.snapshot.delete(path);
  }

  async checkConnect(callbackFunc?: any): Promise<boolean> {
    if (
      !(
        this.webdavConfig.address.startsWith("http://") ||
        this.webdavConfig.address.startsWith("https://")
      )
    ) {
      const err =
        "Error: the url should start with http(s):// but it does not!";
      console.warn("WebDAV connection check failed.");
      if (callbackFunc !== undefined) {
        callbackFunc(err);
      }
      return false;
    }

    try {
      await this._init();
      const results = await this._statFromRoot(`/${this.remoteBaseDir}/`);
      if (results === undefined) {
        throw Error("cannot stat root vault folder!");
      }
    } catch (err) {
      console.warn("WebDAV connection check failed.");
      callbackFunc?.(err);
      return false;
    }

    return await this.checkConnectCommonOps(callbackFunc);
  }

  async getUserDisplayName(): Promise<string> {
    throw new Error("Method not implemented.");
  }

  async revokeAuth() {
    throw new Error("Method not implemented.");
  }

  allowEmptyFile(): boolean {
    return true;
  }
}
