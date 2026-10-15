# WebDAV HTTP baseline

These tests bundle the actual `src/fsWebdav.ts`, its helpers and the installed
WebDAV SDK. Only the Obsidian runtime boundary is replaced: `requestUrl` uses
Node fetch, `Platform` represents desktop, and Web Crypto uses Node's implementation.
Requests go to an in-memory HTTP fixture listening on `127.0.0.1` at an ephemeral
port. No Obsidian vault, account, remote storage or on-disk note is used.

Use the Node version in `.nvmrc`, then run:

```sh
npm ci --ignore-scripts
npm run test:baseline
npm run build
```

- `npm test`: the pre-existing Mocha suite.
- `npm run test:webdav`: normal CRUD, MOVE, empty files, Unicode and literal URL
  characters, recursive scan failure, HTTP errors, component/URI limits, the
  10 MiB upload branch boundary, OpenSSL filename expansion, and deletion/history
  regressions in `deletion.test.cjs`, plus whole-upload routing and upload/history
  regressions in `upload.test.cjs`, and initialization regressions in
  `initialization.test.cjs`, plus capability fallback in `capabilities.test.cjs` and Nextcloud protocol tests
  in `nextcloud.test.cjs`, plus upload target metrics in `path-diagnostics.test.cjs`.
- `npm run test:webdav:known`: reserved entry point for future reproduced issues;
  currently empty. All previously reproduced cases run in the normal suite.

W07 adds 12 upload-error diagnostic tests. Metrics describe the remote target
(including any encrypted filename), count Unicode code points and UTF-8 bytes,
and distinguish the longest segment from the encoded target path. No fixed
length limit is imposed and no status is reclassified as a filename error.
Encoded path length excludes the endpoint prefix and is not the whole request
URI. New metadata has no path text; original errors are preserved, not redacted.
Independent CRUD and initialization errors are not annotated by this change.

W05/W06 adds nine Nextcloud protocol regressions: Destination encoding, trailing
slashes and encoded user paths, custom headers, equal basenames, two adapter
instances, and MKCOL/PUT/MOVE failures with retry. Each chunk has different bytes;
full-content comparison detects reordered or repeated chunks. The fixture checks
Destination consistency and total assembled size, implements upload sessions and
MOVE assembly, and deletes temporary sessions. It is a limited protocol fixture,
not a Nextcloud deployment. Faults precede mutations; ambiguous failures after
commit are not simulated. Cleanup failure preserves the original upload error.

W04 permits ordinary WebDAV operations when OPTIONS returns 405 or 501. Eleven
capability tests cover CRUD after fallback, probe reuse, upload errors, persistent
401/403/404/429/500/503 and connection loss. Other errors remain failures. This
covers the desktop password/no-auth path; SDK Digest-specific behavior is not
validated. Unsupported discovery disables Nextcloud detection for that instance.

W03 adds 13 regression tests for shared initialization, retries after root checks,
directory creation and capability failures, concurrent failure propagation,
connection loss and failed depth-setting saves. Explicit response gates pause
individual requests without sleeps. A later operation retries after failure;
there is no automatic retry loop. Persistent OPTIONS 403 remains an error; W04 now allows 405/501 fallback.

W02 is enforced in the normal suite: generic Apache/Sabre partial updates have
been removed, so the adapter no longer zeroes the live target to begin a large
upload. These servers now receive one ordinary PUT. The tests cover zero bytes,
the 10 MiB boundary, full byte comparison, 413/503, connection loss, and sync
history across a failed upload and successful retry. The Nextcloud case checks
only uploader selection; the separate W05/W06 suite now tests chunk assembly.

This change does not make ordinary PUT atomic. Some servers may mutate a file
before a request fails. The fixture errors occur before mutation and cannot prove
otherwise. Servers that previously needed 5 MiB chunks to fit a request-size limit
may now reject a large file with 413; the adapter reports that error and does not
fall back to a destructive write strategy.

W01 is fixed and enforced in the normal suite. Deletion failures, including 404,
are propagated rather than interpreted as success. The history tests execute the
real sync dispatcher, adapter and history functions with an in-memory substitute
for the LocalForage table backend. They cover unencrypted remote files/folders,
failed/successful retries, merge-base preservation and profile isolation. They do
not exercise the encryption wrapper, IndexedDB persistence or the full sync
planner. Network fault injection drops a connection before deletion; an ambiguous
disconnect after a server commits deletion is not simulated.

The HTTP fixture implements a limited DAV subset. Its injected HTTP errors occur
before mutation. It advertises Apache/Sabre support to test upload selection;
it does **not** implement successful partial writes or guarantee real-server
atomicity. Apache partial writes use ranged PUT; Sabre uses PATCH. Fixture limits
(80 or 255 bytes and 100-byte request URI) are test parameters, not universal DAV
limits. The encrypted-path case uses the real OpenSSL name function, but is not a
full encrypted-vault synchronization test.

These tests do not validate a real Nextcloud server, Digest/iOS behavior,
HTTPS/certificates, real proxies, persistent sync history, filesystem limits,
request cancellation, retry scheduling or mobile Obsidian. `npm run build2` also
exists as a secondary build path; its validation is recorded separately.

In a sandbox that prohibits local listeners, the tests need permission to bind
loopback. A listener permission failure is an environment error, not a WebDAV
regression. The transport explicitly rejects external destinations and redirects.

Adapter debug logging is suppressed in this harness because it includes paths.
The server records synthetic fixture method/path pairs, body lengths and a partial
request flag (plus synthetic Nextcloud Destination paths) in memory, never authentication headers or file bodies in traces.
This is not a production diagnostic logger; the production logging schema and rollout are specified in
[the stage-one plan](../../docs/diagnostics/stage-1-baseline.zh-cn.md).
