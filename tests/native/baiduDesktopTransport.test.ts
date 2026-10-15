import { strict as assert } from "assert";
import { createServer, request as httpsRequest } from "https";
import type { RequestOptions } from "https";
import type { AddressInfo } from "net";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createDesktopBaiduTransport,
  type NodeHttpsRequest,
} from "../../src/native/baiduDesktopTransport";
import { BaiduDownloadClient } from "../../src/native/baiduDownload";
import { createDesktopBaiduUploadTransport } from "../../src/native/baiduDesktopUpload";
import { BaiduUploadClient } from "../../src/native/baiduUpload";
import { createHash } from "crypto";
import { BaiduManagementClient } from "../../src/native/baiduManagement";

describe("Baidu desktop HTTPS transport", function () {
  this.timeout(5000);
  const calls: { path: string; headers: Record<string, any> }[] = [];
  const committedPaths: string[] = [];
  const removedPaths: string[] = [];
  let server: ReturnType<typeof createServer>;
  let directory: string;
  let localRequest: NodeHttpsRequest;
  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "baidu-test-tls-"));
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=d.pcs.baidu.com",
        "-addext",
        "subjectAltName=DNS:d.pcs.baidu.com,DNS:cdn.baidupcs.com,DNS:pan.baidu.com",
      ],
      { stdio: "ignore" }
    );
    const ca = readFileSync(cert);
    server = createServer(
      { key: readFileSync(key), cert: ca },
      (request, response) => {
        calls.push({ path: request.url!, headers: request.headers });
        const path = new URL(request.url!, "https://fixture").pathname;
        if (request.method === "POST") {
          const chunks: Buffer[] = [];
          request.on("data", (chunk) => chunks.push(chunk));
          request.on("end", () => {
            const body = Buffer.concat(chunks);
            const url = new URL(request.url!, "https://fixture");
            const form = new URLSearchParams(body.toString("utf8"));
            const method = url.searchParams.get("method");
            if (form.get("path") === "/hang") return;
            if (form.get("path") === "/oversize-json") {
              response.writeHead(200);
              response.end(Buffer.alloc(1024 * 1024 + 1));
              return;
            }
            if (form.get("path") === "/bad-json") {
              response.end("fixture-token");
              return;
            }
            if (form.get("path") === "/redirect") {
              response.writeHead(302, {
                Location: "https://attacker.example/",
              });
              response.end();
              return;
            }
            if (method === "upload") {
              const boundary = String(request.headers["content-type"]).split(
                "boundary="
              )[1];
              const start = body.indexOf("\r\n\r\n") + 4;
              const tail = Buffer.byteLength(`\r\n--${boundary}--\r\n`);
              const md5 = createHash("md5")
                .update(body.subarray(start, body.length - tail))
                .digest("hex");
              response.end(JSON.stringify({ md5 }));
            } else if (method === "precreate")
              response.end(
                JSON.stringify({
                  errno: 0,
                  return_type: 1,
                  uploadid: "fixture-session",
                  block_list: [0],
                })
              );
            else if (method === "create") {
              committedPaths.push(form.get("path")!);
              if (form.get("path") === "/lost-commit") {
                response.destroy();
                return;
              }
              response.end(
                JSON.stringify({
                  errno: 0,
                  fs_id: "1",
                  path: form.get("path"),
                  size: Number(form.get("size")),
                  isdir: Number(form.get("isdir")),
                })
              );
            } else if (method === "filemanager") {
              const selected = JSON.parse(form.get("filelist")!)[0];
              if (selected.endsWith("/pending")) {
                response.end(
                  JSON.stringify({ errno: 0, taskid: 123, info: [] })
                );
                return;
              }
              if (selected.endsWith("/denied")) {
                response.end(
                  JSON.stringify({
                    errno: 0,
                    info: [{ path: selected, errno: -9 }],
                  })
                );
                return;
              }
              removedPaths.push(selected);
              if (selected.endsWith("/lost-delete")) {
                response.destroy();
                return;
              }
              response.end(
                JSON.stringify({
                  errno: 0,
                  info: [{ path: selected, errno: 0 }],
                })
              );
            } else response.end("{}");
          });
          return;
        }
        if (path === "/redirect") {
          response.writeHead(302, {
            Location:
              "https://cdn.baidupcs.com/bytes?signed=1&access_token=echo",
          });
          response.end();
        } else if (path === "/foreign") {
          response.writeHead(302, { Location: "https://attacker.example/" });
          response.end();
        } else if (path === "/hang") {
          /* Wait for client timeout. */
        } else if (path === "/cut") {
          response.writeHead(200, { "Content-Length": "10" });
          response.write(Buffer.from([1, 2]));
          setTimeout(() => response.destroy(), 5);
        } else if (path === "/oversize-header") {
          response.writeHead(200, { "Content-Length": "10000" });
          response.end("x");
        } else if (path === "/oversize-stream") {
          response.writeHead(200);
          response.end(Buffer.alloc(20));
        } else if (path === "/compressed") {
          response.writeHead(200, { "Content-Encoding": "gzip" });
          response.end("x");
        } else if (path === "/empty") {
          response.writeHead(200);
          response.end();
        } else {
          response.writeHead(200);
          response.end(Buffer.from([0, 37, 255, 12]));
        }
      }
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    // Keep the trusted URL and TLS identity, route only this fixture to loopback.
    localRequest = (url, options, callback) => {
      const lookup = ((
        _hostname: string,
        lookupOptions: { all?: boolean },
        callback: (...args: any[]) => void
      ) => {
        if (lookupOptions.all)
          callback(null, [{ address: "127.0.0.1", family: 4 }]);
        else callback(null, "127.0.0.1", 4);
      }) as RequestOptions["lookup"];
      return httpsRequest(
        url,
        { ...options, port, ca, agent: options.agent ?? false, lookup },
        callback
      );
    };
  });
  after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  beforeEach(() => {
    calls.length = 0;
    committedPaths.length = 0;
    removedPaths.length = 0;
  });
  const fetch = (path: string, maxBytes = 10, timeoutMs = 1000) =>
    createDesktopBaiduTransport(true, () => localRequest, {
      maxBytes,
      timeoutMs,
    })({
      url: `https://d.pcs.baidu.com${path}`,
      method: "GET",
      headers: { "User-Agent": "pan.baidu.com" },
      redirect: "manual",
    });

  it("reuses a verified TLS connection for sequential downloads", async () => {
    let opened = 0;
    const connected = () => { opened++; };
    server.on("secureConnection", connected);
    try {
      await fetch("/bytes");
      await fetch("/bytes");
      assert.equal(opened, 1);
    } finally { server.off("secureConnection", connected); }
  });
  it("returns one redirect without following it", async () => {
    const response = await fetch("/redirect");
    assert.equal(response.status, 302);
    assert.equal(response.body, undefined);
    assert.equal(calls.length, 1);
  });
  it("returns exact binary bytes and sends no cookies or authorization headers", async () => {
    const response = await fetch("/bytes");
    assert.deepEqual(
      Array.from(new Uint8Array(response.body!)),
      [0, 37, 255, 12]
    );
    assert.equal(calls[0].headers["user-agent"], "pan.baidu.com");
    assert.equal(calls[0].headers["accept-encoding"], "identity");
    assert.equal(calls[0].headers.cookie, undefined);
    assert.equal(calls[0].headers.authorization, undefined);
  });
  it("runs the real redirect chain and strips the token at the next hop", async () => {
    const client = new BaiduDownloadClient(
      async () => ({
        status: 200,
        json: {
          errno: 0,
          list: [{ fs_id: "1", dlink: "https://d.pcs.baidu.com/redirect" }],
        },
      }),
      createDesktopBaiduTransport(true, () => localRequest),
      async () => "fixture-token"
    );
    assert.equal((await client.readFile({ fsId: "1", size: 4 })).byteLength, 4);
    assert.equal(calls.length, 2);
    assert.equal(
      new URL(calls[0].path, "https://fixture").searchParams.get(
        "access_token"
      ),
      "fixture-token"
    );
    assert.equal(
      new URL(calls[1].path, "https://fixture").searchParams.get(
        "access_token"
      ),
      null
    );
  });
  it("does not request a foreign redirect destination", async () => {
    const client = new BaiduDownloadClient(
      async () => ({
        status: 200,
        json: {
          errno: 0,
          list: [{ fs_id: "1", dlink: "https://d.pcs.baidu.com/foreign" }],
        },
      }),
      createDesktopBaiduTransport(true, () => localRequest),
      async () => "fixture-token"
    );
    await assert.rejects(
      client.readFile({ fsId: "1", size: 4 }),
      /untrusted_url/
    );
    assert.equal(calls.length, 1);
  });
  it("rejects header and streamed body sizes above the limit", async () => {
    for (const path of ["/oversize-header", "/oversize-stream"])
      await assert.rejects(fetch(path), /download_too_large/);
  });
  it("rejects truncated responses rather than returning partial content", async () => {
    await assert.rejects(fetch("/cut"), /incomplete_download/);
  });
  it("stops a stalled request with a sanitized timeout", async () => {
    await assert.rejects(
      fetch("/hang?access_token=fixture-token", 10, 40),
      (error: Error) =>
        error.message.includes("download_timeout") &&
        !error.message.includes("fixture-token")
    );
  });
  it("rejects unexpected compression", async () => {
    await assert.rejects(fetch("/compressed"), /unexpected_encoding/);
  });
  it("retains TLS hostname validation", async () => {
    const transport = createDesktopBaiduTransport(
      true,
      () => (url, options, callback) =>
        localRequest(
          url,
          { ...options, servername: "attacker.example" },
          callback
        )
    );
    await assert.rejects(
      transport({
        url: "https://d.pcs.baidu.com/bytes?access_token=fixture-token",
        method: "GET",
        headers: {},
        redirect: "manual",
      }),
      (error: Error) =>
        error.message.includes("transport_error") &&
        !error.message.includes("fixture-token")
    );
    assert.equal(calls.length, 0);
  });
  it("supports empty files with a zero byte request budget", async () => {
    const transport = createDesktopBaiduTransport(true, () => localRequest);
    const response = await transport({
      url: "https://d.pcs.baidu.com/empty",
      method: "GET",
      headers: {},
      redirect: "manual",
      maxBytes: 0,
    });
    assert.equal(response.body!.byteLength, 0);
  });
  it("uses the expected file size as a tighter stream budget", async () => {
    const transport = createDesktopBaiduTransport(true, () => localRequest, {
      maxBytes: 100,
    });
    await assert.rejects(
      transport({
        url: "https://d.pcs.baidu.com/oversize-stream",
        method: "GET",
        headers: {},
        redirect: "manual",
        maxBytes: 4,
      }),
      /download_too_large/
    );
  });
  it("does not load Node networking on mobile", async () => {
    let loads = 0;
    const transport = createDesktopBaiduTransport(false, () => {
      loads++;
      return localRequest;
    });
    await assert.rejects(
      transport({
        url: "https://d.pcs.baidu.com/bytes",
        method: "GET",
        headers: {},
        redirect: "manual",
      }),
      /desktop_download_required/
    );
    assert.equal(loads, 0);
  });
  it("rejects unsafe input before loading Node networking", async () => {
    let loads = 0;
    const transport = createDesktopBaiduTransport(true, () => {
      loads++;
      return localRequest;
    });
    for (const url of [
      "not-a-url",
      "http://d.pcs.baidu.com/",
      "https://attacker.example/",
      "https://user:secret@d.pcs.baidu.com/",
      "https://d.pcs.baidu.com:8443/",
    ])
      await assert.rejects(
        transport({ url, method: "GET", headers: {}, redirect: "manual" }),
        /untrusted_url/
      );
    assert.equal(loads, 0);
  });
  it("uploads and commits real binary multipart requests over verified TLS", async () => {
    const client = new BaiduUploadClient(
      createDesktopBaiduUploadTransport(true, () => localRequest),
      async () => "fixture-token"
    );
    const result = await client.writeFile({
      path: "/notes/中文%.md",
      data: new Uint8Array([0, 37, 255, 12]).buffer,
      overwrite: true,
    });
    assert.equal(result.remotePath, "/notes/中文%.md");
    assert.equal(result.size, 4);
    assert.deepEqual(
      calls.map((call) =>
        new URL(call.path, "https://fixture").searchParams.get("method")
      ),
      ["precreate", "upload", "create"]
    );
    assert.ok(
      calls.every((call) => !call.headers.cookie && !call.headers.authorization)
    );
  });
  it("does not follow an upload API redirect or resend the POST", async () => {
    const client = new BaiduUploadClient(
      createDesktopBaiduUploadTransport(true, () => localRequest),
      async () => "token"
    );
    await assert.rejects(
      client.writeFile({
        path: "/redirect",
        data: new ArrayBuffer(1),
        overwrite: false,
      }),
      (e: any) => e.status === 302 && e.outcomeUnknown
    );
    assert.equal(calls.length, 1);
  });
  it("times out stalled uploads without exposing credentials", async () => {
    const client = new BaiduUploadClient(
      createDesktopBaiduUploadTransport(true, () => localRequest, {
        timeoutMs: 40,
      }),
      async () => "fixture-token"
    );
    await assert.rejects(
      client.writeFile({
        path: "/hang",
        data: new ArrayBuffer(1),
        overwrite: false,
      }),
      (e: any) =>
        e.code === "upload_timeout" &&
        e.outcomeUnknown &&
        !e.message.includes("fixture-token")
    );
  });
  it("rejects foreign upload endpoints and mobile use before loading Node", async () => {
    let loads = 0;
    const request = {
      url: "https://attacker.example/",
      method: "POST" as const,
      redirect: "manual" as const,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "path=/test",
    };
    for (const isDesktop of [true, false])
      await assert.rejects(
        createDesktopBaiduUploadTransport(isDesktop, () => {
          loads++;
          return localRequest;
        })(request),
        (e: any) =>
          e.code ===
          (isDesktop ? "invalid_endpoint" : "desktop_upload_required")
      );
    assert.equal(loads, 0);
  });
  it("reports unknown success when the server commits and loses the response", async () => {
    const client = new BaiduUploadClient(
      createDesktopBaiduUploadTransport(true, () => localRequest),
      async () => "token"
    );
    await assert.rejects(
      client.writeFile({
        path: "/lost-commit",
        data: new ArrayBuffer(1),
        overwrite: false,
      }),
      (e: any) => e.stage === "commit" && e.outcomeUnknown
    );
    assert.deepEqual(committedPaths, ["/lost-commit"]);
    assert.equal(calls.length, 3);
  });
  it("limits upload response bodies and sanitizes malformed JSON", async () => {
    for (const [path, code] of [
      ["/oversize-json", "response_too_large"],
      ["/bad-json", "invalid_json"],
    ]) {
      const client = new BaiduUploadClient(
        createDesktopBaiduUploadTransport(true, () => localRequest),
        async () => "fixture-token"
      );
      await assert.rejects(
        client.writeFile({ path, data: new ArrayBuffer(1), overwrite: false }),
        (e: any) =>
          e.code === code &&
          e.outcomeUnknown &&
          !e.message.includes("fixture-token")
      );
    }
  });
  it("does not send upload bytes to a TLS host with an invalid identity", async () => {
    const transport = createDesktopBaiduUploadTransport(
      true,
      () => (url, options, callback) =>
        localRequest(
          url,
          { ...options, servername: "attacker.example" },
          callback
        )
    );
    const client = new BaiduUploadClient(transport, async () => "token");
    await assert.rejects(
      client.writeFile({
        path: "/notes/test.md",
        data: new ArrayBuffer(1),
        overwrite: false,
      }),
      /transport_error/
    );
    assert.equal(calls.length, 0);
  });
  it("creates and deletes a scoped directory over real TLS", async () => {
    const client = new BaiduManagementClient(
      createDesktopBaiduUploadTransport(true, () => localRequest),
      async () => "token",
      "/apps/test/vault"
    );
    assert.equal(
      (await client.mkdir("中文 #&%/")).remotePath,
      "/apps/test/vault/中文 #&%"
    );
    await client.remove("中文 #&%/");
    assert.deepEqual(removedPaths, ["/apps/test/vault/中文 #&%"]);
    assert.deepEqual(
      calls.map((call) =>
        new URL(call.path, "https://fixture").searchParams.get("method")
      ),
      ["create", "filemanager"]
    );
  });
  it("does not retry after the server deletes a file and loses the response", async () => {
    const client = new BaiduManagementClient(
      createDesktopBaiduUploadTransport(true, () => localRequest),
      async () => "token",
      "/apps/test/vault"
    );
    await assert.rejects(
      client.remove("lost-delete"),
      (e: any) => e.operation === "remove" && e.outcomeUnknown
    );
    assert.deepEqual(removedPaths, ["/apps/test/vault/lost-delete"]);
    assert.equal(calls.length, 1);
  });
  it("rejects actual asynchronous and per-item failed deletions", async () => {
    const client = new BaiduManagementClient(
      createDesktopBaiduUploadTransport(true, () => localRequest),
      async () => "token",
      "/apps/test/vault"
    );
    await assert.rejects(
      client.remove("pending"),
      (e: any) => e.code === "delete_not_confirmed"
    );
    await assert.rejects(client.remove("denied"), (e: any) => e.errno === -9);
    assert.equal(removedPaths.length, 0);
  });
  it("does not open other filemanager operations through the delete transport", async () => {
    let loads = 0;
    const transport = createDesktopBaiduUploadTransport(true, () => {
      loads++;
      return localRequest;
    });
    await assert.rejects(
      transport({
        url: "https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=move&access_token=token",
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "filelist=[]",
      }),
      (e: any) => e.code === "invalid_endpoint"
    );
    assert.equal(loads, 0);
  });
});
