import { buildSync } from "esbuild";
import { createRequire } from "module";
import path from "path";
const require = createRequire(import.meta.url);
const bundle = buildSync({
  stdin: {
    contents:
      'export { parseUriByHand, exportQrCodeUri, importQrCodeUri } from "./src/importExport"; export { COMMAND_URI, COMMAND_CALLBACK } from "./src/baseTypes"; export { getClient } from "./src/fsGetter"; export { bindBaiduIdentity, getBaiduProfileId } from "./src/native/baiduProfile"; export * from "./pro/src/sync"; export { FakeFsLocal } from "./src/fsLocal"; export { FakeFsEncrypt } from "./src/fsEncrypt"; export { FakeFsBaidu } from "./src/fsBaidu"; export { BaiduConnection } from "./src/native/baiduConnection"; export * from "./src/localdb"; export * from "./pro/src/localdb";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  alias: { obsidian: path.resolve("tests/webdav/support/obsidian.cjs") },
  external: ["./encryptRClone.worker"],
}).outputFiles[0].text;
const moduleFixture: { exports: any } = { exports: {} };
new Function(
  "require",
  "module",
  "exports",
  "console",
  "window",
  "localStorage",
  bundle
)(
  (name: string) =>
    name === "./encryptRClone.worker"
      ? class {
          constructor() {
            throw new Error("Rclone worker is outside this fixture");
          }
        }
      : require(name),
  moduleFixture,
  moduleFixture.exports,
  { ...console, debug() {}, info() {}, warn() {}, error() {} },
  {
    ...globalThis,
    moment: (time: number) => ({ format: () => new Date(time).toISOString() }),
  },
  undefined
);
export const api = moduleFixture.exports;
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
export { bytes };
export function memoryTable() {
  const values = new Map<string, any>();
  return {
    async setItem(key: string, value: any) {
      values.set(key, structuredClone(value));
      return value;
    },
    async getItem(key: string) {
      return values.has(key) ? structuredClone(values.get(key)) : null;
    },
    async removeItem(key: string) {
      values.delete(key);
    },
    async getItems() {
      return Object.fromEntries(
        [...values].map(([key, value]) => [key, structuredClone(value)])
      );
    },
  };
}
export function setup(password = "") {
  const root = "/apps/test";
  const remoteItems = new Map<string, any>();
  const localItems = new Map<string, any>();
  let id = 1;
  let time = 100;
  const uploads = new Map<string, Uint8Array>();
  const mutations: string[] = [];
  let deleteMode = "ok";
  let uploadFailure = false;
  let scanFailure = false;
  let connectionConfig: any = {
    app: { clientId: "app", clientSecret: "secret", redirectUri: "oob" },
    tokens: {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 9999999999999,
    },
  };
  const connection = new api.BaiduConnection({
    getConfig: () => connectionConfig,
    saveConfig: async (next: any) => {
      connectionConfig = next;
    },
    transport: async (request: any) => {
      const url = new URL(request.url);
      if (url.searchParams.get("method") === "filemetas") {
        const ids = JSON.parse(url.searchParams.get("fsids")!);
        const item = [...remoteItems.values()].find(
          (entry) => entry.fs_id === ids[0]
        );
        return {
          status: 200,
          json: {
            errno: 0,
            list: item
              ? [
                  {
                    ...item,
                    dlink: `https://d.pcs.baidu.com/file?id=${item.fs_id}`,
                  },
                ]
              : [],
          },
        };
      }
      if (scanFailure) return { status: 503, json: {} };
      const dir = url.searchParams.get("dir");
      return {
        status: 200,
        json: {
          errno: 0,
          list: [...remoteItems.values()]
            .filter(
              (entry) =>
                entry.path.slice(0, entry.path.lastIndexOf("/")) === dir
            )
            .map(({ body, ...entry }) => entry),
        },
      };
    },
    binary: async (request: any) => {
      const fsid = Number(new URL(request.url).searchParams.get("id"));
      const item = [...remoteItems.values()].find(
        (entry) => entry.fs_id === fsid
      );
      return { status: 200, headers: {}, body: item.body.slice(0) };
    },
    upload: async (request: any) => {
      const url = new URL(request.url);
      const method = url.searchParams.get("method")!;
      mutations.push(method);
      if (url.hostname === "d.pcs.baidu.com") {
        const all = Buffer.from(request.body);
        const first = all.indexOf("\r\n\r\n") + 4;
        const last = all.lastIndexOf("\r\n--");
        const part = new Uint8Array(all.subarray(first, last));
        uploads.set(url.searchParams.get("uploadid")!, part);
        const crypto = require("crypto");
        return {
          status: 200,
          json: { md5: crypto.createHash("md5").update(part).digest("hex") },
        };
      }
      const form = new URLSearchParams(request.body);
      if (method === "filemanager") {
        const target = JSON.parse(form.get("filelist")!)[0];
        if (deleteMode === "async")
          return { status: 200, json: { errno: 0, taskid: 123, info: [] } };
        if (deleteMode === "denied")
          return {
            status: 200,
            json: { errno: 0, info: [{ path: target, errno: -9 }] },
          };
        remoteItems.delete(target);
        if (deleteMode === "lost") throw new Error("response lost");
        return {
          status: 200,
          json: { errno: 0, info: [{ path: target, errno: 0 }] },
        };
      }
      const target = form.get("path")!;
      const parent = target.slice(0, target.lastIndexOf("/"));
      if (parent !== root && remoteItems.get(parent)?.isdir !== 1)
        return { status: 200, json: { errno: -9 } };
      if (uploadFailure) return { status: 503, json: {} };
      if (method === "precreate")
        return {
          status: 200,
          json: {
            errno: 0,
            return_type: 1,
            uploadid: String(id++),
            block_list: [0],
          },
        };
      const body =
        form.get("isdir") === "1"
          ? new ArrayBuffer(0)
          : uploads.get(form.get("uploadid")!)!.slice().buffer;
      const item = {
        fs_id: id++,
        path: target,
        isdir: form.get("isdir") === "1" ? 1 : 0,
        size: body.byteLength,
        server_mtime: ++time,
        server_ctime: time,
        body,
      };
      remoteItems.set(target, item);
      const { body: ignored, ...metadata } = item;
      return { status: 200, json: { errno: 0, ...metadata } };
    },
  });
  const remote = new api.FakeFsBaidu(connection, root);
  const encrypted = new api.FakeFsEncrypt(remote, password, "openssl-base64");
  const local = {
    kind: "local-fixture",
    async walk() {
      return [...localItems.values()].map((item) =>
        structuredClone(item.entity)
      );
    },
    async stat(key: string) {
      if (!localItems.has(key)) throw new Error("local not found");
      return structuredClone(localItems.get(key).entity);
    },
    async readFile(key: string) {
      return localItems.get(key).body.slice(0);
    },
    async writeFile(
      key: string,
      body: ArrayBuffer,
      mtime: number,
      ctime: number
    ) {
      const entity = {
        key,
        keyRaw: key,
        size: body.byteLength,
        sizeRaw: body.byteLength,
        mtimeCli: mtime,
        ctimeCli: ctime,
      };
      localItems.set(key, { entity, body: body.slice(0) });
      return entity;
    },
    async mkdir(key: string, mtime = 10000, ctime = mtime) {
      return this.writeFile(key, new ArrayBuffer(0), mtime, ctime);
    },
    async rm(key: string) {
      localItems.delete(key);
    },
    async rename(from: string,to: string) {
      if(!localItems.has(from)||localItems.has(to))throw new Error("invalid local rename");
      const item=structuredClone(localItems.get(from));item.entity.key=to;item.entity.keyRaw=to;
      localItems.set(to,item);localItems.delete(from);
    },
  };
  const db = {
    prevSyncRecordsTbl: memoryTable(),
    fileContentHistoryTbl: memoryTable(),
    syncPlansTbl: memoryTable(),
  };
  const settings = {
    serviceType: "webdav",
    password,
    encryptionMethod: "openssl-base64",
    syncDirection: "bidirectional",
    conflictAction: "keep_newer",
    howToCleanEmptyFolder: "skip",
    skipSizeLargerThan: -1,
  };
  const history = () =>
    api.getAllPrevSyncRecordsByVaultAndProfile(db, "vault", "baidu-profile");
  const plan = async () =>
    api.buildSyncPlan({
      localEntityList: await local.walk(),
      prevSyncEntityList: await history(),
      remoteEntityList: await encrypted.walk(),
      fsEncrypt: encrypted,
      settings,
      triggerSource: "manual",
      configDir: ".obsidian",
    });
  const run = async (mapping: any, conflictAction = "keep_newer") =>
    api.doActualSync(
      mapping,
      local,
      encrypted,
      "vault",
      "baidu-profile",
      5,
      -1,
      undefined,
      db,
      undefined,
      conflictAction,
      "manual"
    );
  return {
    connection,
    replaceConfig: (next: any) => {
      connectionConfig = next;
    },
    local,
    remote,
    encrypted,
    db,
    settings,
    history,
    plan,
    run,
    localItems,
    remoteItems,
    mutations,
    failScan: () => {
      scanFailure = true;
    },
    failUpload: () => {
      uploadFailure = true;
    },
    deleteMode: (mode: string) => {
      deleteMode = mode;
    },
  };
}
