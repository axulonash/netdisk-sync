// The only application boundary replaced by the HTTP tests. All WebDAV SDK
// operations and the adapter's request patch are bundled from real source.
exports.Platform = { isAndroidApp: false, isIosApp: false,
  get isDesktopApp() { return globalThis.__rsNextDesktopFixture === true; }
};
exports.requireApiVersion = () => true;
exports.requestUrl = async (options) => {
  const url = new URL(options.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("WebDAV test transport only permits loopback HTTP");
  }
  const response = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    arrayBuffer: await response.arrayBuffer(),
  };
};
