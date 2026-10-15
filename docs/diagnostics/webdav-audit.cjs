/* Diagnostic probes of current source, not a regression suite or server test.
 * Run with Node >= 22.13: node docs/diagnostics/webdav-audit.cjs
 * Installed project dependencies required; no credentials or network access needed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { webcrypto, randomUUID, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
let factory;
let readHelpers = {};
function load(file, names, extra = {}) {
  const source = stripTypeScriptTypes(fs.readFileSync(path.join(root, file), 'utf8'))
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/^export /gm, '');
  const context = vm.createContext({
    console: quiet, AbortController, Buffer, ArrayBuffer, Uint8Array, TextEncoder, TextDecoder, Response, Headers, setTimeout, createHash, nanoid: randomUUID,
    PQueue: require("p-queue").default, ...readHelpers,
    VALID_REQURL: false, cloneDeep: structuredClone, FakeFs: class {},
    AuthType: { Digest: 'digest', Password: 'password' },
    createClient: (...args) => factory(...args),
    Queue: class { constructor(xs) { this.xs = xs; } get length() { return this.xs.length; } pop() { return this.xs.shift(); } push(x) { this.xs.push(x); } },
    chunk: (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n)),
    flatten: xs => xs.flat(),
    splitFileSizeToChunkRanges: (size, n) => Array.from({ length: Math.ceil(size / n) }, (_, i) => ({ start: i * n, end: Math.min(size, (i + 1) * n) - 1 })),
    ...extra,
  });
  return vm.runInContext(`${source}\n;({${names.join(',')}})`, context, { filename: file });
}
readHelpers = load('src/webdavRetry.ts', ['retryWebdavRead', 'transientWebdavError']);
Object.assign(readHelpers, load('src/webdavDirectory.ts', ['resolveWebdavDirectory']));
const { FakeFsWebdav, tryEncodeURI } = load('src/fsWebdav.ts', ['FakeFsWebdav', 'tryEncodeURI']);
function fresh(address = 'https://example.test/remote.php/dav/files/user', overrides = {}) {
  return new FakeFsWebdav({ address, username: 'user', password: 'secret', authType: 'basic', depth: 'manual_1', remoteBaseDir: 'vault', ...overrides }, 'vault', async () => {});
}
const results = [];
async function probe(name, fn) {
  const evidence = await fn();
  results.push({ name, evidence });
  console.log(`CONFIRMED ${name}: ${evidence}`);
}
(async () => {
  await probe('DELETE error propagates (W01 fixed)', async () => {
    const remote = fresh();
    remote._init = async () => {}; // Isolate this non-initialization boundary probe.
    remote.client = { deleteFile: async () => { throw new Error('HTTP 403'); } };
    await assert.rejects(() => remote.rm('note.md'), /HTTP 403/);
    return 'rm rejects on a simulated HTTP 403';
  });
  await probe('Failed initialization retries (W03 fixed)', async () => {
    let calls = 0;
    factory = () => ({ exists: async () => { if (++calls === 1) throw new Error('offline'); return true; }, customRequest: async () => ({ headers: new Headers() }) });
    const remote = fresh();
    await assert.rejects(() => remote._init(), /offline/);
    await assert.doesNotReject(() => remote._init());
    assert.equal(calls, 2);
    assert.equal(remote.vaultFolderExists, true);
    return 'second _init checks the root again and completes';
  });
  await probe('Concurrent initialization waits (W03 fixed)', async () => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    factory = () => ({ exists: () => waiting, customRequest: async () => ({ headers: new Headers() }) });
    const remote = fresh();
    const first = remote._init();
    let settled = false;
    const second = remote._init().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(remote.vaultFolderExists, false);
    release(true);
    await Promise.all([first, second]);
    assert.equal(remote.vaultFolderExists, true);
    return 'both callers wait for the same root check';
  });
  await probe('Unsupported capability discovery falls back (W04 fixed)', async () => {
    factory = () => ({ exists: async () => true, customRequest: async () => { throw Object.assign(new Error('OPTIONS 405'), { status: 405 }); } });
    await assert.doesNotReject(() => fresh()._init());
    return 'existing root + OPTIONS 405 => initialization succeeds without Nextcloud detection';
  });
  await probe('Nextcloud trailing slash detection (W06 fixed)', async () => {
    const client = { customRequest: async () => ({ headers: new Headers({ DAV: 'nextcloud' }) }) };
    const a = fresh(); a.client = client;
    const b = fresh(`${a.webdavConfig.address}/`); b.client = client;
    await a._checkPartialSupport(); await b._checkPartialSupport();
    assert.equal(a.isNextcloud, true); assert.equal(b.isNextcloud, true);
    return 'same endpoint detected with and without trailing slash';
  });
  await probe('Nextcloud unique sessions, encoded Destination and headers (W05 fixed)', async () => {
    const sessions = [];
    factory = (address, config) => {
      const session = { address, config }; sessions.push(session);
      return { createDirectory: async (name, options) => { Object.assign(session, { name, destination: options.headers.Destination }); }, putFileContents: async () => {}, customRequest: async () => {} };
    };
    const remote = fresh(undefined, { customHeaders: 'X-Test-Required: token' });
    remote.nextcloudUploadServerAddress = 'https://example.test/remote.php/dav/uploads/user';
    remote.stat = async () => ({ sizeRaw: 1 });
    for (const key of ['/vault/a/同名#附件.bin', '/vault/b/同名#附件.bin']) {
      await remote._writeFileFromRootNextcloud(key, new ArrayBuffer(1), 0, 0, key);
    }
    assert.notEqual(sessions[0].name, sessions[1].name);
    assert.ok(sessions[0].destination.includes('/user/vault/'));
    assert.equal(new URL(sessions[0].destination).hash, '');
    assert.ok(sessions[0].destination.includes('%23'));
    assert.equal(sessions[0].config.headers['X-Test-Required'], 'token');
    return 'distinct temporary names, escaped hash, no extra slash, custom header preserved';
  });
  await probe('Generic partial capabilities use one whole-file write (W02 fixed)', async () => {
    for (const compliance of ['<http://apache.org/dav/propset/fs/1>', 'sabredav-partialupdate']) {
      const remote = fresh();
      const sizes = [];
      remote.client = { customRequest: async () => ({ headers: new Headers({ Server: 'Apache', DAV: compliance }) }) };
      await remote._checkPartialSupport();
      remote._writeFileFromRootFull = async (_key, content) => { sizes.push(content.byteLength); };
      const size = 10 * 1024 * 1024 + 1;
      await remote._writeFileFromRoot('/vault/a.bin', new ArrayBuffer(size), 0, 0, 'a.bin');
      assert.deepEqual(sizes, [size]);
    }
    return 'Apache and Sabre capabilities do not cause an empty pre-write';
  });
  await probe('Mixed encoded/raw base URL is left untouched', async () => {
    const input = 'https://example.test/dav/already%20encoded/未编码 空格';
    assert.equal(tryEncodeURI(input), input);
    return 'raw space and Chinese text remain when any percent sign exists; transport outcome untested';
  });
  await probe('OpenSSL encryption turns a long path into one long name', async () => {
    const { encryptStringToBase64url } = load('src/encryptOpenSSL.ts', ['encryptStringToBase64url'], {
      window: { crypto: webcrypto },
      bufferToArrayBuffer: value => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
      base64url: { stringify: value => Buffer.from(value).toString('base64url') },
    });
    const input = Array(6).fill('a'.repeat(30)).join('/') + '/note.md';
    const output = await encryptStringToBase64url(input, 'diagnostic-password');
    assert.ok(output.length > 255); assert.ok(!output.includes('/'));
    return `input=${Buffer.byteLength(input)} bytes, max original component=30; encrypted single component=${output.length} bytes (255 is illustrative, not universal)`;
  });
  await probe('Control: listing failure propagates', async () => {
    const remote = fresh();
    remote._init = async () => {}; // Isolate this non-initialization boundary probe.
    remote.client = { getDirectoryContents: async () => { throw new Error('PROPFIND 503'); } };
    await assert.rejects(() => remote.walk(), /PROPFIND 503/);
    return 'walk rejects; it does not return a partial list after a thrown request error';
  });
  await probe('Control: normal path is passed raw to SDK', async () => {
    const remote = fresh(); let actual;
    remote._init = async () => {}; // Isolate this non-initialization boundary probe.
    remote.client = { customRequest: async key => { actual = key; return new Response(null, {status: 201}); }, stat: async key => ({ filename: key, type: 'file', lastmod: '2024-01-01', size: 1 }) };
    await remote.writeFile('中文 # %.md', new ArrayBuffer(1), 0, 0);
    assert.equal(actual, '/vault/中文 # %.md');
    return 'ordinary PUT leaves encoding to SDK, unlike manually constructed Nextcloud Destination';
  });
  console.log(`\n${results.length} diagnostic probes confirmed. These demonstrate current behavior, not fixes or live-server compatibility.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
