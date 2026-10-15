import { DEFAULT_DEBUG_FOLDER, type Entity } from "./baseTypes";
import { FakeFs } from "./fsAll";

import { TFile, TFolder, type Vault } from "obsidian";
import { isSpecialFolderNameToSkip, mkdirpInVault, statFix, unixTimeToStr } from "./misc";
import { listFilesInObsFolder } from "./obsFolderLister";
import type { Profiler } from "./profiler";
import { assertLocalVersion } from "./syncVersion";

export class FakeFsLocal extends FakeFs {
  vault: Vault;
  syncConfigDir: boolean;
  syncBookmarks: boolean;
  configDir: string;
  pluginID: string;
  profiler: Profiler | undefined;
  deleteToWhere: "obsidian" | "system";
  kind: "local";
  constructor(
    vault: Vault,
    syncConfigDir: boolean,
    syncBookmarks: boolean,
    configDir: string,
    pluginID: string,
    profiler: Profiler | undefined,
    deleteToWhere: "obsidian" | "system"
  ) {
    super();

    this.vault = vault;
    this.syncConfigDir = syncConfigDir;
    this.syncBookmarks = syncBookmarks;
    this.configDir = configDir;
    this.pluginID = pluginID;
    this.profiler = profiler;
    this.deleteToWhere = deleteToWhere;
    this.kind = "local";
  }

  async walk(): Promise<Entity[]> {
    this.profiler?.addIndent();
    this.profiler?.insert("enter walk for local");
    const local: Entity[] = [];
    let scannedFiles = 0, scannedFolders = 0;

    const localTAbstractFiles = this.vault.getAllLoadedFiles();
    this.profiler?.insert("finish getting walk for local");
    for (const entry of localTAbstractFiles) {
      let r: Entity | undefined = undefined;
      let key = entry.path;
      if (key.startsWith("/")) {
        // why?
        // just remove leading slash /
        key = key.slice(1);
      }

      if (entry.path === "/" || entry.path === "") {
        // ignore
        continue;
      } else if (entry instanceof TFile) {
        let mtimeLocal: number | undefined = entry.stat.mtime;
        if (mtimeLocal <= 0) {
          mtimeLocal = entry.stat.ctime;
        }
        if (mtimeLocal === 0) {
          mtimeLocal = undefined;
        }
        if (mtimeLocal === undefined) {
          throw Error(
            `Your file has last modified time 0: ${key}, don't know how to deal with it`
          );
        }
        r = {
          key: key, // local always unencrypted
          keyRaw: key,
          mtimeCli: mtimeLocal,
          mtimeSvr: mtimeLocal,
          size: entry.stat.size, // local always unencrypted
          sizeRaw: entry.stat.size,
        };
      } else if (entry instanceof TFolder) {
        key = `${key}/`;
        r = {
          key: key,
          keyRaw: key,
          size: 0,
          sizeRaw: 0,
        };
      } else {
        throw Error(`unexpected ${entry}`);
      }

      if (r.keyRaw.startsWith(DEFAULT_DEBUG_FOLDER)) {
        // skip listing the debug folder,
        // which should always not involved in sync
        // continue;
      } else {
        local.push(r);
        if (r.key!.endsWith("/")) scannedFolders++; else scannedFiles++;
        this.onScanProgress?.(scannedFiles, scannedFolders);
      }
    }

    // Obsidian's loaded-file index can omit unsupported extensions (HTML,
    // for example). Supplement it from disk so existing files are never
    // mistaken for absent local destinations by the sync plan.
    const known = new Set(local.map(entry => entry.key!));
    const directories = ["/"];
    const visited = new Set<string>();
    while (directories.length) {
      await this.beforeOperation?.();
      const directory = directories.pop()!;
      if (visited.has(directory)) continue;
      visited.add(directory);
      const listing = await this.vault.adapter.list(directory);
      for (const path of listing.folders) {
        if (path === this.configDir || path.split("/").some(part => part.startsWith(".")) || isSpecialFolderNameToSkip(path, [])) continue;
        directories.push(path);
        const key = path.replace(/\/+$/, "") + "/";
        if (!known.has(key)) {
          local.push({key, keyRaw:key, size:0, sizeRaw:0});known.add(key);
          this.onScanProgress?.(scannedFiles, ++scannedFolders);
        }
      }
      for (const key of listing.files) {
        if (known.has(key) || key.split("/").some(part => part.startsWith(".")) || isSpecialFolderNameToSkip(key, [])) continue;
        await this.beforeOperation?.();
        const stat = await this.vault.adapter.stat(key);
        if (!stat || stat.type !== "file") throw Object.assign(new Error("Local inventory changed during scan"), {code:"plan_changed"});
        const mtime = stat.mtime > 0 ? stat.mtime : stat.ctime;
        if (!(mtime > 0)) throw new Error("Local file has no valid modification time");
        local.push({key, keyRaw:key, size:stat.size, sizeRaw:stat.size, mtimeCli:mtime, mtimeSvr:mtime});
        known.add(key);this.onScanProgress?.(++scannedFiles, scannedFolders);
      }
    }

    this.profiler?.insert("finish transforming walk for local");

    if (this.syncConfigDir || this.syncBookmarks) {
      this.profiler?.insert("into syncConfigDir or syncBookmarks");
      const bookmarksOnly = !this.syncConfigDir;
      const syncFiles = await listFilesInObsFolder(
        this.configDir,
        this.vault,
        this.pluginID,
        bookmarksOnly
      );
      // console.debug(`syncFiles in obs: ${JSON.stringify(syncFiles, null, 2)}`);
      for (const f of syncFiles) {
        local.push(f);
        if (f.key!.endsWith("/")) scannedFolders++; else scannedFiles++;
        this.onScanProgress?.(scannedFiles, scannedFolders);
      }
      this.profiler?.insert("finish syncConfigDir");
    }

    this.profiler?.insert("finish walk for local");
    this.profiler?.removeIndent();
    return local;
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const statRes = await statFix(this.vault, key);
    if (statRes === undefined || statRes === null) {
      throw Error(`${key} does not exist! cannot stat for local`);
    }
    const isFolder = statRes.type === "folder";
    return {
      key: isFolder ? `${key}/` : key, // local always unencrypted
      keyRaw: isFolder ? `${key}/` : key,
      ctimeCli: statRes.ctime,
      mtimeCli: statRes.mtime,
      mtimeSvr: statRes.mtime,
      ctimeCliFmt: unixTimeToStr(statRes.ctime),
      mtimeCliFmt: unixTimeToStr(statRes.mtime),
      mtimeSvrFmt: unixTimeToStr(statRes.mtime),
      size: statRes.size, // local always unencrypted
      sizeRaw: statRes.size,
    };
  }

  validatePlan = async (key: string, expected: Entity | undefined): Promise<void> => {
    const stat = await this.vault.adapter.stat(key.replace(/\/$/, ""));
    const actual: Entity | undefined = stat ? {
      key: key.replace(/\/$/, "") + (stat.type === "folder" ? "/" : ""), keyRaw: key,
      sizeRaw: stat.size, mtimeCli: stat.mtime > 0 ? stat.mtime : stat.ctime,
    } : undefined;
    assertLocalVersion(expected, actual);
  };

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    // console.debug(`mkdir: ${key}`);
    await mkdirpInVault(key, this.vault);
    return await this.stat(key);
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    await this.vault.adapter.writeBinary(key, content, {
      mtime: mtime,
      ctime: ctime,
    });
    return await this.stat(key);
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    return await this.vault.adapter.readBinary(key);
  }

  async rename(key1: string, key2: string): Promise<void> {
    return await this.vault.adapter.rename(key1, key2);
  }

  async rm(key: string): Promise<void> {
    if (key.endsWith("/")) {
      // Folder deletions run after their planned children. Anything left is
      // outside that completed plan (including a note created during sync).
      while (true) {
        await this.beforeOperation?.();
        const revision = this.operationRevision?.();
        const entries = await this.vault.adapter.list(key.replace(/\/$/, ""));
        if (entries.files.length || entries.folders.length)
          throw Object.assign(new Error("Folder contents changed after scan"), {code: "plan_changed"});
        await this.beforeOperation?.();
        if (revision === this.operationRevision?.()) break;
      }
    }
    await this.beforeOperation?.();
    if (this.deleteToWhere === "obsidian") {
      await this.vault.adapter.trashLocal(key);
    } else {
      // "system"
      if (!(await this.vault.adapter.trashSystem(key))) {
        await this.beforeOperation?.();
        await this.vault.adapter.trashLocal(key);
      }
    }
  }
  async checkConnect(callbackFunc?: any): Promise<boolean> {
    return true;
  }

  async getUserDisplayName(): Promise<string> {
    throw new Error("Method not implemented.");
  }

  async revokeAuth(): Promise<any> {
    throw new Error("Method not implemented.");
  }

  allowEmptyFile(): boolean {
    return true;
  }
}
