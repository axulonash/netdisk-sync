const http = require("node:http");
const {createHash} = require("node:crypto");
const path = require("node:path");
const vm = require("node:vm");
const { once } = require("node:events");
const { buildSync } = require("esbuild");

let adapter;
function loadAdapter() {
  if (adapter) return adapter;
  const root = path.resolve(__dirname, "../../..");
  const { outputFiles } = buildSync({
    absWorkingDir: root,
    stdin: {
      contents:
        'export * from "./src/fsWebdav"; export { SyncControl } from "./src/syncControl"; export { encryptStringToBase64url } from "./src/encryptOpenSSL";' +
        'export { copyFile } from "./src/copyLogic"; export { doActualSync } from "./pro/src/sync";' +
        'export { upsertPrevSyncRecordByVaultAndProfile, getAllPrevSyncRecordsByVaultAndProfile } from "./src/localdb";' +
        'export { upsertFileContentHistoryByVaultAndProfile, getFileContentHistoryByVaultAndProfile } from "./pro/src/localdb";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: { obsidian: path.join(__dirname, "obsidian.cjs") },
    logLevel: "silent",
  });
  const module = { exports: {} };
  // Suppress adapter debug output, which includes paths. Test failures expose
  // only synthetic fixtures. SDK/HTTP behavior remains real.
  const quiet = { ...console, debug() {}, info() {}, warn() {}, error() {} };
  const evaluate = vm.runInThisContext(
    `(function(require,module,exports,console,window,localStorage){${outputFiles[0].text}\n})`
  );
  // The browser SDK captures window.fetch during module initialization; use
  // Node's complete web API globals, including fetch and Web Crypto.
  // History integration supplies an in-memory table backend, not browser
  // storage. Do not probe Node's experimental disk-backed localStorage.
  evaluate(require, module, module.exports, quiet, globalThis, undefined);
  adapter = module.exports;
  return adapter;
}

const xmlEscape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]
  );
const canonical = (value) => value.replace(/\/+$/, "") || "/";
const parent = (value) => value.slice(0, value.lastIndexOf("/")) || "/";

// An intentionally small, in-memory WebDAV protocol fixture, not a production
// DAV server. Faults run before mutation; no files or credentials leave memory.
async function startDav(options = {}) {
  const files = new Map([["/", { directory: true, body: Buffer.alloc(0) }]]);
  const requests = [];
  const faults = [];
  let origin;
  const uploads = new Map();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const etag = item => item ? `"${createHash("sha256").update(item.body).digest("hex")}"` : undefined;
  const matches = (req, item) => !options.etags || ((!req.headers["if-match"] || req.headers["if-match"] === etag(item)) && (!req.headers["if-none-match"] || !item));
  async function handle(req, res) {
    const reply = (status, body = "", headers = {}) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    const rawPath = new URL(req.url, "http://127.0.0.1").pathname;
    let key;
    try {
      key = canonical(decodeURIComponent(rawPath));
    } catch {
      req.resume();
      return reply(400);
    }
    // Only synthetic path and transfer metadata; no credentials or bodies.
    const trace = {
      method: req.method,
      path: key,
      bodyBytes: 0,
      partial:
        req.headers["content-range"] !== undefined ||
        req.headers["x-update-range"] !== undefined,
    };
    requests.push(trace);
    const chunks = [];
    for await (const data of req) chunks.push(data);
    const body = Buffer.concat(chunks);
    trace.bodyBytes = body.length;
    const faultIndex = faults.findIndex(
      (fault) =>
        fault.method === req.method &&
        (fault.path === undefined || fault.path === key) &&
        (!fault.header || req.headers[fault.header] !== undefined)
    );
    if (faultIndex !== -1) {
      const fault = faults[faultIndex];
      if (fault.once) faults.splice(faultIndex, 1);
      if (fault.onEntered) fault.onEntered();
      if (fault.waitFor) await fault.waitFor;
      if (fault.disconnect) {
        req.socket.destroy();
        return;
      }
      if (fault.status !== undefined) return reply(fault.status);
    }
    if (options.nextcloud) {
      if (req.headers["x-test-required"] !== "fixture") return reply(403);
      const uploadRoot = `/remote.php/dav/uploads/${options.nextcloudUser || "user"}`;
      if (key.startsWith(`${uploadRoot}/`)) {
        const parts = key.slice(uploadRoot.length + 1).split("/");
        if (req.method === "DELETE" && parts.length === 1) {
          if (!uploads.delete(parts[0])) return reply(404);
          return reply(204);
        }
        const destination = new URL(req.headers.destination || "/", origin);
        if (
          destination.origin !== origin ||
          destination.hash ||
          destination.search ||
          destination.pathname.includes("//")
        )
          return reply(400);
        const target = decodeURIComponent(destination.pathname);
        trace.destination = target;
        const session = uploads.get(parts[0]);
        if (req.method === "MKCOL" && parts.length === 1) {
          if (session) return reply(405);
          uploads.set(parts[0], { target, chunks: new Map() });
          return reply(201);
        }
        if (!session) return reply(404);
        if (session.target !== target) return reply(409);
        if (
          req.method === "PUT" &&
          parts.length === 2 &&
          /^\d{5}$/.test(parts[1])
        ) {
          session.chunks.set(parts[1], body);
          return reply(201);
        }
        if (req.method === "MOVE" && parts[1] === ".file") {
          const assembled = Buffer.concat(
            [...session.chunks]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, value]) => value)
          );
          if (assembled.length !== Number(req.headers["oc-total-length"]))
            return reply(400);
          if (!files.get(parent(target))?.directory) return reply(409);
          files.set(target, { directory: false, body: assembled });
          uploads.delete(parts[0]);
          return reply(201);
        }
        return reply(405);
      }
    }
    if (options.maxUrlBytes && Buffer.byteLength(req.url) > options.maxUrlBytes)
      return reply(414);
    if (
      options.maxNameBytes &&
      key
        .split("/")
        .some((part) => Buffer.byteLength(part) > options.maxNameBytes)
    )
      return reply(403);
    if (req.method === "OPTIONS")
      return reply(200, "", {
        DAV: options.nextcloud
          ? "1, 2, nextcloud"
          : options.apachePartial
            ? "1, 2, <http://apache.org/dav/propset/fs/1>"
            : options.sabrePartial
              ? "1, 2, sabredav-partialupdate"
              : "1, 2",
        Server: options.apachePartial ? "Apache" : "TestDAV",
      });
    if (req.method === "PROPFIND") {
      if (!files.has(key)) return reply(404);
      const depth = req.headers.depth || "0";
      const prefix = key === "/" ? "/" : `${key}/`;
      const selected = [...files].filter(
        ([name]) =>
          name === key ||
          (depth !== "0" &&
            name.startsWith(prefix) &&
            (depth === "infinity" || !name.slice(prefix.length).includes("/")))
      );
      const responses = selected
        .map(([name, item]) => {
          const href =
            name.split("/").map(encodeURIComponent).join("/") +
            (item.directory && name !== "/" ? "/" : "");
          return (
            `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>` +
            `<d:resourcetype>${item.directory ? "<d:collection/>" : ""}</d:resourcetype>` +
            `<d:getcontentlength>${item.body.length}</d:getcontentlength>` +
            (options.etags ? `<d:getetag>${xmlEscape(etag(item))}</d:getetag>` : "") +
            "<d:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</d:getlastmodified>" +
            `<d:getcontenttype>${item.directory ? "httpd/unix-directory" : "application/octet-stream"}</d:getcontenttype>` +
            "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
          );
        })
        .join("");
      return reply(
        207,
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`,
        { "Content-Type": "application/xml; charset=utf-8" }
      );
    }
    if (req.method === "MKCOL") {
      if (files.has(key)) return reply(405);
      if (!files.get(parent(key))?.directory) return reply(409);
      files.set(key, { directory: true, body: Buffer.alloc(0) });
      return reply(201);
    }
    if (["PUT", "GET", "DELETE"].includes(req.method) && !matches(req, files.get(key))) return reply(412);
    if (req.method === "PUT") {
      if (req.headers["content-range"]) return reply(405);
      if (!files.get(parent(key))?.directory) return reply(409);
      const status = files.has(key) ? 204 : 201;
      files.set(key, { directory: false, body });
      return reply(status, "", options.etags ? {ETag:etag(files.get(key))} : {});
    }
    if (req.method === "GET") {
      const item = files.get(key);
      return item && !item.directory
        ? reply(200, item.body, { "Content-Type": "application/octet-stream", ...(options.etags ? {ETag:etag(item)} : {}) })
        : reply(404);
    }
    if (req.method === "DELETE") {
      if (!files.has(key)) return reply(404);
      for (const name of [...files.keys()])
        if (name === key || name.startsWith(`${key}/`)) files.delete(name);
      return reply(204);
    }
    if (req.method === "MOVE") {
      if (!files.has(key)) return reply(404);
      if (!req.headers.destination) return reply(400);
      const destination = new URL(req.headers.destination, origin);
      if (destination.origin !== origin || destination.hash) return reply(400);
      const target = canonical(decodeURIComponent(destination.pathname));
      if (!files.get(parent(target))?.directory) return reply(409);
      for (const [name, item] of [...files])
        if (name === key || name.startsWith(`${key}/`)) {
          files.set(target + name.slice(key.length), item);
          files.delete(name);
        }
      return reply(201);
    }
    // PATCH is used only with explicit fault injection in the first-stage
    // regression. Do not pretend to implement successful partial writes.
    return reply(405);
  }

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: origin,
    files,
    requests,
    uploads,
    fail: (fault) => faults.push(fault),
    hold: (method, requestPath, extra = {}) => {
      let release;
      let onEntered;
      const waitFor = new Promise((resolve) => {
        release = resolve;
      });
      const entered = new Promise((resolve) => {
        onEntered = resolve;
      });
      faults.push({
        method,
        path: requestPath,
        once: true,
        ...extra,
        waitFor,
        onEntered,
      });
      return { entered, release };
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

module.exports = { loadAdapter, startDav };
