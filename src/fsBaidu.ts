import type { Entity } from "./baseTypes";
import { FakeFs } from "./fsAll";
import {
  BaiduConnection,
  BaiduConnectionError,
} from "./native/baiduConnection";
import { BaiduProfileError } from "./native/baiduProfile";
import { baiduSyncPath, baiduSyncRoot } from "./native/baiduPath";
import type { BaiduScanEntry } from "./native/baiduRead";
const entityOf = (entry: BaiduScanEntry): Entity => ({
  key: entry.key,
  keyRaw: entry.key,
  size: entry.size,
  sizeRaw: entry.size,
  mtimeCli: entry.mtimeMs,
  mtimeSvr: entry.mtimeMs,
  ctimeCli: entry.ctimeMs,
});
// Serialize requests and bind each instance to one sync scope.
export class FakeFsBaidu extends FakeFs {
  kind = "baidu";
  private readonly root: string;
  private readonly accountGuard: () => void;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly connection: BaiduConnection,
    root: string,
    private readonly scopeGuard?: () => void
  ) {
    super();
    this.root = baiduSyncRoot(root);
    this.accountGuard = connection.captureAccountGuard();
  }
  private queue<T>(
    action: () => Promise<T>,
    mutation = false,
    validateAfter = true
  ): Promise<T> {
    const guard = this.connection.captureAccountGuard();
    const result = this.tail.then(async () => {
      this.scopeGuard?.();
      this.accountGuard();
      guard();
      const output = await action();
      try {
        if (validateAfter) this.scopeGuard?.();
      } catch (error) {
        if (mutation) throw new BaiduProfileError("sync_scope_changed", true);
        throw error;
      }
      return output;
    });
    this.tail = result.catch(() => {});
    return result;
  }
  walk(): Promise<Entity[]> {
    return this.queue(async () =>
      (await this.connection.scan(this.root, (files, folders) => this.onScanProgress?.(files, folders))).map(entityOf)
    );
  }
  walkPartial(): Promise<Entity[]> {
    return this.walk();
  }
  stat(key: string): Promise<Entity> {
    return this.queue(async () => {
      baiduSyncPath(this.root, key);
      return entityOf(await this.connection.stat(this.root, key));
    });
  }
  mkdir(key: string, _mtime?: number, _ctime?: number): Promise<Entity> {
    return this.queue(async () => {
      baiduSyncPath(this.root, key);
      return entityOf(await this.connection.mkdirAndStat(this.root, key));
    }, true);
  }
  writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    const data = content.slice(0);
    return this.queue(async () => {
      baiduSyncPath(this.root, key);
      return entityOf(
        await this.connection.writeFileAndStat(
          this.root,
          key,
          data,
          mtime,
          ctime
        )
      );
    }, true);
  }
  readFile(key: string): Promise<ArrayBuffer> {
    return this.queue(async () => {
      baiduSyncPath(this.root, key);
      return this.connection.readFileByPath(this.root, key);
    });
  }
  rename(_key1: string, _key2: string): Promise<void> {
    return Promise.reject(new BaiduConnectionError("rename_unsupported"));
  }
  rm(key: string): Promise<void> {
    return this.queue(async () => {
      baiduSyncPath(this.root, key);
      await this.connection.remove(this.root, key);
    }, true);
  }
  async checkConnect(
    callbackFunc?: (error: unknown) => void
  ): Promise<boolean> {
    try {
      await this.walk();
      return true;
    } catch (error) {
      callbackFunc?.(error);
      return false;
    }
  }
  getUserDisplayName(): Promise<string> {
    return Promise.resolve("百度网盘");
  }
  revokeAuth(): Promise<void> {
    return this.queue(() => this.connection.logout(), false, false);
  }
  allowEmptyFile(): boolean {
    return false;
  }
}
