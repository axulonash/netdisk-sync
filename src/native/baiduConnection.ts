import {
  BaiduOAuthClient,
  type BaiduAppCredentials,
  type BaiduTokens,
  type BaiduTokenRequest,
} from "./baiduAuth";
import {
  BaiduReadClient,
  BaiduReadError,
  type BaiduReadRequest,
} from "./baiduRead";
import { BaiduTokenSession } from "./baiduSession";
import {
  BaiduDownloadClient,
  type BaiduBinaryTransport,
} from "./baiduDownload";
import {
  BaiduUploadClient,
  type BaiduUploadFile,
  type BaiduUploadTransport,
} from "./baiduUpload";
import { BaiduManagementClient } from "./baiduManagement";
import { baiduSyncPath, baiduSyncRoot } from "./baiduPath";
import { bindBaiduIdentity, validateBaiduIdentity } from "./baiduProfile";
import { nanoid } from "nanoid";
import type { BaiduScanEntry } from "./baiduRead";

export interface BaiduConnectionConfig {
  app: BaiduAppCredentials;
  tokens?: BaiduTokens;
  remoteRoot?: string;
  syncIdentity?: { accountId: string; credentialBinding: string };
}
export type BaiduJsonTransport = (
  request: BaiduTokenRequest | BaiduReadRequest
) => Promise<{ status: number; json: unknown }>;
type JsonRequester = (request: {
  url: string;
  method: string;
  throw: false;
}) => Promise<{ status: number; text: string }>;
export class BaiduConnectionError extends Error {
  constructor(
    public readonly code: string,
    public readonly outcomeUnknown = false
  ) {
    super(`Baidu connection failed (${code})`);
    this.name = "BaiduConnectionError";
  }
}

// requestUrl follows redirects, so this adapter is only for official JSON APIs.
// It must never be used as the manual-redirect binary download transport.
export const createBaiduJsonTransport =
  (requester: JsonRequester): BaiduJsonTransport =>
  async (request) => {
    const url = new URL(request.url);
    const allowed =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.port &&
      ((url.hostname === "openapi.baidu.com" &&
        url.pathname === "/oauth/2.0/token") ||
        (url.hostname === "pan.baidu.com" &&
          ["/rest/2.0/xpan/file", "/rest/2.0/xpan/multimedia"].includes(
            url.pathname
          )));
    if (!allowed) throw new BaiduConnectionError("invalid_endpoint");
    // Baidu's public OAuth documentation specifies GET for token exchange.
    if (request.method === "POST") {
      if (url.hostname !== "openapi.baidu.com")
        throw new BaiduConnectionError("invalid_endpoint");
      url.search = request.body;
    }
    try {
      const response = await requester({
        url: url.toString(),
        method: "GET",
        throw: false,
      });
      let json: unknown;
      try {
        json = JSON.parse(response.text);
      } catch {
        throw new BaiduConnectionError("invalid_json");
      }
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof BaiduConnectionError) throw error;
      throw new BaiduConnectionError("transport_error");
    }
  };

export class BaiduConnection {
  busy = false;
  private session?: BaiduTokenSession;
  private activeConfig?: string;
  private observedConfig?: string;
  private accountRevision = 0;
  private pendingRotation?: {
    previous?: string;
    next?: string;
    revision: number;
  };
  constructor(
    private readonly options: {
      getConfig: () => BaiduConnectionConfig | undefined;
      saveConfig: (config: BaiduConnectionConfig) => Promise<void>;
      transport: BaiduJsonTransport;
      binary?: BaiduBinaryTransport;
      upload?: BaiduUploadTransport;
    }
  ) {}

  private async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new BaiduConnectionError("busy");
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
  private async save(config: BaiduConnectionConfig) {
    try {
      await this.options.saveConfig(config);
    } catch {
      throw new BaiduConnectionError("save_failed");
    }
  }
  private makeSession(config: BaiduConnectionConfig) {
    this.observeAccount();
    const app = { ...config.app };
    // Compare values rather than object identity: imports and in-place edits
    // can both replace credentials while the settings tab stays alive.
    this.activeConfig = this.configKey(config);
    return new BaiduTokenSession({
      tokens: config.tokens,
      refresh: (token) =>
        new BaiduOAuthClient(this.options.transport).refresh(app, token),
      save: async (tokens) => {
        if (this.configKey(this.options.getConfig()) !== this.activeConfig)
          throw new BaiduConnectionError("account_changed");
        const current = this.options.getConfig()!;
        const base = { ...current, app, tokens };
        const next =
          tokens && current.syncIdentity
            ? bindBaiduIdentity(base, current.syncIdentity.accountId)
            : { ...base, syncIdentity: undefined };
        const previous = this.activeConfig;
        const nextKey = this.configKey(next);
        const revision = this.observeAccount();
        if (tokens)
          this.pendingRotation = { previous, next: nextKey, revision };
        try {
          await this.save(next);
          if (this.configKey(this.options.getConfig()) !== nextKey)
            throw new BaiduConnectionError("account_changed");
          // Recognize a persisted rotation, never a logout or external import.
          if (
            tokens &&
            this.accountRevision === revision &&
            this.observedConfig === previous
          )
            this.observedConfig = nextKey;
          this.activeConfig = nextKey;
        } finally {
          this.pendingRotation = undefined;
        }
      },
    });
  }
  private configKey(config?: BaiduConnectionConfig) {
    return config
      ? JSON.stringify([
          config.app.clientId,
          config.app.clientSecret,
          config.app.redirectUri,
          config.tokens?.accessToken,
          config.tokens?.refreshToken,
          config.tokens?.expiresAt,
          config.remoteRoot,
          config.syncIdentity?.accountId,
          config.syncIdentity?.credentialBinding,
        ])
      : undefined;
  }
  private observeAccount(): number {
    const current = this.configKey(this.options.getConfig());
    const rotation = this.pendingRotation;
    if (
      rotation &&
      current === rotation.next &&
      this.observedConfig === rotation.previous &&
      this.accountRevision === rotation.revision
    )
      return this.accountRevision;
    if (current !== this.observedConfig) {
      this.observedConfig = current;
      this.accountRevision++;
    }
    return this.accountRevision;
  }
  captureAccountGuard(): () => void {
    const expected = this.observeAccount();
    return () => {
      if (this.observeAccount() !== expected)
        throw new BaiduConnectionError("account_changed");
    };
  }
  private currentSession() {
    const config = this.options.getConfig();
    if (!config) throw new BaiduConnectionError("not_logged_in");
    if (config.syncIdentity) validateBaiduIdentity(config);
    if (!this.session || this.configKey(config) !== this.activeConfig)
      this.session = this.makeSession(config);
    return this.session;
  }
  login(app: BaiduAppCredentials, code: string): Promise<void> {
    const snapshot = { ...app };
    return this.run(async () => {
      const previous = this.configKey(this.options.getConfig());
      const tokens = await new BaiduOAuthClient(
        this.options.transport
      ).exchangeCode(snapshot, code.trim());
      if (this.configKey(this.options.getConfig()) !== previous)
        throw new BaiduConnectionError("account_changed");
      const next = bindBaiduIdentity(
        {
          app: snapshot,
          tokens,
          remoteRoot: this.options.getConfig()?.remoteRoot,
        },
        nanoid(32)
      );
      await this.save(next);
      this.session = this.makeSession(next);
    });
  }
  scan(root: string, onProgress?: (files: number, folders: number) => void) {
    return this.run(async () => {
      const token = await this.currentSession().getAccessToken();
      const entries = await new BaiduReadClient(this.options.transport, token, {
        maxEntries: 10000,
        maxPages: 100,
      }).scan(root, onProgress);
      if (this.configKey(this.options.getConfig()) !== this.activeConfig)
        throw new BaiduConnectionError("account_changed");
      return entries;
    });
  }
  setRemoteRoot(
    root: string,
    options: { createIfMissing?: boolean } = {}
  ): Promise<void> {
    const path = baiduSyncRoot(root);
    return this.run(async () => {
      const session = this.mutationSession();
      const token = await session.token();
      const reader = new BaiduReadClient(this.options.transport, token, {
        maxEntries: 10000,
        maxPages: 100,
      });
      try {
        await reader.scan(path);
      } catch (error) {
        if (
          !options.createIfMissing ||
          !(error instanceof BaiduReadError) ||
          error.code !== "platform_error"
        )
          throw error;
        if (!this.options.upload)
          throw new BaiduConnectionError("management_transport_unavailable");
        // Parent listings establish absence. Never interpret permission/network failure as absence.
        const ensure = async (target: string): Promise<void> => {
          await session.guard();
          const separator = target.lastIndexOf("/"),
            parent = target.slice(0, separator) || "/";
          let entries;
          try {
            entries = await reader.listDirectory(parent);
          } catch (parentError) {
            if (
              parent === "/" ||
              !(parentError instanceof BaiduReadError) ||
              parentError.code !== "platform_error"
            )
              throw parentError;
            await ensure(parent);
            entries = await reader.listDirectory(parent);
          }
          await session.guard();
          const existing = entries.find((entry) => entry.remotePath === target);
          if (existing) {
            if (!existing.isDirectory)
              throw new BaiduConnectionError("type_mismatch");
            return;
          }
          const created = await new BaiduManagementClient(
            this.options.upload!,
            async () => token,
            target,
            session.guard
          ).createScopeDirectory();
          await session.guard();
          const confirmed = (await reader.listDirectory(parent)).find(
            (entry) => entry.remotePath === target
          );
          await session.guard();
          if (!confirmed?.isDirectory || confirmed.fsId !== created.fsId)
            throw new BaiduConnectionError(
              "mutation_verification_failed",
              true
            );
        };
        await ensure(path);
        await reader.scan(path);
      }
      await session.guard();
      const next = { ...this.options.getConfig()!, remoteRoot: path };
      await this.save(next);
      if (this.configKey(this.options.getConfig()) !== this.configKey(next))
        throw new BaiduConnectionError("account_changed");
    });
  }
  readFile(file: { fsId: string; size: number }): Promise<ArrayBuffer> {
    const snapshot = { ...file };
    return this.run(async () => {
      if (!this.options.binary)
        throw new BaiduConnectionError("download_transport_unavailable");
      const bytes = await new BaiduDownloadClient(
        this.options.transport,
        this.options.binary,
        () => this.currentSession().getAccessToken()
      ).readFile(snapshot);
      if (this.configKey(this.options.getConfig()) !== this.activeConfig)
        throw new BaiduConnectionError("account_changed");
      return bytes;
    });
  }
  logout(): Promise<void> {
    return this.run(async () => {
      const config = this.options.getConfig();
      if (!config) return;
      await this.currentSession().logout();
    });
  }
  writeFile(file: BaiduUploadFile) {
    return this.run(async () => {
      if (!this.options.upload)
        throw new BaiduConnectionError("upload_transport_unavailable");
      const session = this.mutationSession();
      return new BaiduUploadClient(
        this.options.upload,
        session.token,
        session.guard
      ).writeFile(file);
    });
  }
  private async lookup(
    root: string,
    key: string,
    token: string
  ): Promise<BaiduScanEntry> {
    const path = baiduSyncPath(root, key);
    const parent = path.slice(0, path.lastIndexOf("/"));
    const entries = await new BaiduReadClient(this.options.transport, token, {
      maxEntries: 10000,
      maxPages: 100,
    }).listDirectory(parent);
    const entry = entries.find((item) => item.remotePath === path);
    if (!entry) throw new BaiduConnectionError("not_found");
    if (entry.isDirectory !== key.endsWith("/"))
      throw new BaiduConnectionError("type_mismatch");
    return { ...entry, key };
  }
  stat(root: string, key: string): Promise<BaiduScanEntry> {
    baiduSyncPath(root, key);
    return this.run(async () => {
      const session = this.mutationSession();
      const token = await session.token();
      const entry = await this.lookup(root, key, token);
      await session.guard();
      return entry;
    });
  }
  readFileByPath(root: string, key: string): Promise<ArrayBuffer> {
    baiduSyncPath(root, key);
    return this.run(async () => {
      if (key.endsWith("/")) throw new BaiduConnectionError("type_mismatch");
      if (!this.options.binary)
        throw new BaiduConnectionError("download_transport_unavailable");
      const session = this.mutationSession();
      const token = await session.token();
      const entry = await this.lookup(root, key, token);
      await session.guard();
      const bytes = await new BaiduDownloadClient(
        async (request) => {
          await session.guard();
          const response = await this.options.transport(request);
          await session.guard();
          return response;
        },
        async (request) => {
          await session.guard();
          const response = await this.options.binary!(request);
          await session.guard();
          return response;
        },
        async () => {
          await session.guard();
          return token;
        }
      ).readFile(entry);
      await session.guard();
      return bytes;
    });
  }
  private async verifyMutation(
    root: string,
    key: string,
    fsId: string,
    token: string,
    guard: () => Promise<void>,
    size?: number
  ) {
    try {
      await guard();
      const entry = await this.lookup(root, key, token);
      await guard();
      if (entry.fsId !== fsId || (size !== undefined && entry.size !== size))
        throw new BaiduConnectionError("metadata_mismatch");
      return entry;
    } catch {
      throw new BaiduConnectionError("mutation_verification_failed", true);
    }
  }
  mkdirAndStat(root: string, key: string): Promise<BaiduScanEntry> {
    baiduSyncPath(root, key);
    return this.run(async () => {
      if (!key.endsWith("/")) throw new BaiduConnectionError("type_mismatch");
      if (!this.options.upload)
        throw new BaiduConnectionError("management_transport_unavailable");
      const session = this.mutationSession();
      const token = await session.token();
      const created = await new BaiduManagementClient(
        this.options.upload,
        async () => token,
        root,
        session.guard
      ).mkdir(key);
      return this.verifyMutation(
        root,
        key,
        created.fsId,
        token,
        session.guard,
        0
      );
    });
  }
  writeFileAndStat(
    root: string,
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<BaiduScanEntry> {
    const path = baiduSyncPath(root, key);
    const data = content.slice(0);
    return this.run(async () => {
      if (key.endsWith("/")) throw new BaiduConnectionError("type_mismatch");
      if (!this.options.upload)
        throw new BaiduConnectionError("upload_transport_unavailable");
      const session = this.mutationSession();
      const token = await session.token();
      const created = await new BaiduUploadClient(
        this.options.upload,
        async () => token,
        session.guard
      ).writeFile({
        path,
        data,
        overwrite: true,
        mtimeMs: mtime,
        ctimeMs: ctime,
      });
      return this.verifyMutation(
        root,
        key,
        created.fsId,
        token,
        session.guard,
        data.byteLength
      );
    });
  }
  private mutationSession() {
    let expectedAccount: string | undefined;
    return {
      token: async () => {
        const token = await this.currentSession().getAccessToken();
        if (this.configKey(this.options.getConfig()) !== this.activeConfig)
          throw new BaiduConnectionError("account_changed");
        expectedAccount = this.activeConfig;
        return token;
      },
      guard: async () => {
        if (
          !expectedAccount ||
          this.configKey(this.options.getConfig()) !== expectedAccount
        )
          throw new BaiduConnectionError("account_changed");
      },
    };
  }
  private management(root: string) {
    if (!this.options.upload)
      throw new BaiduConnectionError("management_transport_unavailable");
    const session = this.mutationSession();
    return new BaiduManagementClient(
      this.options.upload,
      session.token,
      root,
      session.guard
    );
  }
  mkdir(root: string, key: string) {
    return this.run(() => this.management(root).mkdir(key));
  }
  remove(root: string, key: string) {
    return this.run(() => this.management(root).remove(key));
  }
}
