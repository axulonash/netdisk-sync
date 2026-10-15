import type { Entity } from "./baseTypes";
import { FakeFs } from "./fsAll";
import { AliyunClient, type AliyunEntry } from "./native/aliyunClient";
import { AliyunError } from "./native/aliyunTransport";
const entity = (entry: AliyunEntry): Entity => ({
  key: entry.key,
  keyRaw: entry.key,
  size: entry.size,
  sizeRaw: entry.size,
  mtimeCli: entry.mtime,
  mtimeSvr: entry.mtime,
  ctimeCli: entry.ctime,
});
export class FakeFsAliyun extends FakeFs {
  kind = "aliyun";
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly client: AliyunClient) {
    super();
  }
  private queue<T>(action: () => Promise<T>, mutation = false): Promise<T> {
    const promise = this.tail.then(async () => {
      this.client.guard();
      const result = await action();
      try {
        this.client.guard();
      } catch {
        throw new AliyunError("sync_scope_changed", mutation);
      }
      return result;
    });
    this.tail = promise.catch(() => {});
    return promise;
  }
  walk() {
    return this.queue(async () => (await this.client.scan((files, folders) => this.onScanProgress?.(files, folders))).map(entity));
  }
  walkPartial() {
    return this.walk();
  }
  stat(key: string) {
    return this.queue(async () => entity(await this.client.stat(key)));
  }
  mkdir(key: string) {
    return this.queue(async () => entity(await this.client.mkdir(key)), true);
  }
  writeFile(key: string, content: ArrayBuffer, mtime: number, ctime: number) {
    const bytes = content.slice(0);
    return this.queue(
      async () => entity(await this.client.write(key, bytes, mtime, ctime)),
      true
    );
  }
  readFile(key: string) {
    return this.queue(() => this.client.read(key));
  }
  rename(_key1: string, _key2: string): Promise<void> {
    return Promise.reject(new AliyunError("rename_not_supported"));
  }
  rm(key: string) {
    return this.queue(() => this.client.remove(key), true);
  }
  async checkConnect(callback?: (error: unknown) => void) {
    try {
      await this.walk();
      return true;
    } catch (error) {
      callback?.(error);
      return false;
    }
  }
  getUserDisplayName() {
    return Promise.resolve("阿里云盘");
  }
  revokeAuth(): Promise<void> {
    return Promise.reject(new AliyunError("logout_from_settings"));
  }
  allowEmptyFile() {
    return false;
  }
}
