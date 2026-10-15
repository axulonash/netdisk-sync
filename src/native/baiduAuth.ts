export interface BaiduAppCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
export interface BaiduTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
}
export interface BaiduTokenRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}
export type BaiduTokenTransport = (request: BaiduTokenRequest) => Promise<{
  status: number;
  json: unknown;
}>;
export class BaiduOAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number
  ) {
    super(`Baidu authorization failed (${code})`);
    this.name = "BaiduOAuthError";
  }
}
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const validateRedirect = (redirectUri: string) => {
  if (redirectUri === "oob") return;
  try {
    const url = new URL(redirectUri);
    if (
      !["https:", "http:", "obsidian:"].includes(url.protocol) ||
      !url.host ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error();
    }
  } catch {
    throw new BaiduOAuthError("invalid_redirect_uri");
  }
};

export function createBaiduAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  if (!nonempty(clientId) || !nonempty(state) || state.length < 16) {
    throw new BaiduOAuthError("invalid_authorization_parameters");
  }
  validateRedirect(redirectUri);
  const url = new URL("https://openapi.baidu.com/oauth/2.0/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "basic,netdisk",
    state,
  }).toString();
  return url.toString();
}

export function parseBaiduAuthorizationCallback(
  callback: string,
  redirectUri: string,
  state: string
): string {
  validateRedirect(redirectUri);
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(callback);
    expected = new URL(redirectUri);
  } catch {
    throw new BaiduOAuthError("invalid_callback");
  }
  if (
    actual.protocol !== expected.protocol ||
    actual.host !== expected.host ||
    actual.pathname !== expected.pathname ||
    actual.hash ||
    actual.username ||
    actual.password
  ) {
    throw new BaiduOAuthError("invalid_callback");
  }
  expected.searchParams.forEach((value, key) => {
    if (
      actual.searchParams.getAll(key).length !== 1 ||
      actual.searchParams.get(key) !== value
    ) {
      throw new BaiduOAuthError("invalid_callback");
    }
  });
  if (
    !nonempty(state) ||
    state.length < 16 ||
    actual.searchParams.getAll("state").length !== 1 ||
    actual.searchParams.get("state") !== state
  ) {
    throw new BaiduOAuthError("invalid_state");
  }
  if (actual.searchParams.has("error"))
    throw new BaiduOAuthError("authorization_denied");
  const codes = actual.searchParams.getAll("code");
  if (codes.length !== 1 || !nonempty(codes[0]))
    throw new BaiduOAuthError("missing_code");
  return codes[0];
}

export class BaiduOAuthClient {
  constructor(
    private readonly transport: BaiduTokenTransport,
    private readonly now: () => number = Date.now
  ) {}

  async exchangeCode(
    app: BaiduAppCredentials,
    code: string
  ): Promise<BaiduTokens> {
    if (!nonempty(code)) throw new BaiduOAuthError("missing_code");
    return this.request(app, {
      grant_type: "authorization_code",
      code,
      redirect_uri: app.redirectUri,
    });
  }

  async refresh(
    app: BaiduAppCredentials,
    refreshToken: string
  ): Promise<BaiduTokens> {
    if (!nonempty(refreshToken))
      throw new BaiduOAuthError("missing_refresh_token");
    return this.request(
      app,
      { grant_type: "refresh_token", refresh_token: refreshToken },
      refreshToken
    );
  }

  private async request(
    app: BaiduAppCredentials,
    fields: Record<string, string>,
    previousRefresh?: string
  ): Promise<BaiduTokens> {
    if (!nonempty(app.clientId) || !nonempty(app.clientSecret)) {
      throw new BaiduOAuthError("missing_app_credentials");
    }
    validateRedirect(app.redirectUri);
    let result: Awaited<ReturnType<BaiduTokenTransport>>;
    try {
      result = await this.transport({
        url: "https://openapi.baidu.com/oauth/2.0/token",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...fields,
          client_id: app.clientId,
          client_secret: app.clientSecret,
        }).toString(),
      });
    } catch {
      // Transport errors can contain URLs, request bodies or echoed secrets.
      throw new BaiduOAuthError("transport_error");
    }
    if (
      !Number.isInteger(result.status) ||
      result.status < 200 ||
      result.status >= 300
    ) {
      throw new BaiduOAuthError("http_error", result.status);
    }
    const data = result.json;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new BaiduOAuthError("invalid_token_response");
    }
    if ("error" in data) {
      const known = [
        "invalid_request",
        "invalid_client",
        "invalid_grant",
        "unauthorized_client",
        "unsupported_grant_type",
        "invalid_scope",
        "access_denied",
      ];
      const code =
        typeof data.error === "string" && known.includes(data.error)
          ? data.error
          : "platform_error";
      throw new BaiduOAuthError(code);
    }
    const token = data as Record<string, unknown>;
    const refreshToken =
      token.refresh_token === undefined ? previousRefresh : token.refresh_token;
    if (
      token.scope !== undefined &&
      (typeof token.scope !== "string" ||
        !token.scope.split(/[\s,]+/).includes("netdisk"))
    ) {
      throw new BaiduOAuthError("missing_netdisk_scope");
    }
    const now = this.now();
    const expiresIn = token.expires_in;
    if (
      !nonempty(token.access_token) ||
      !nonempty(refreshToken) ||
      typeof expiresIn !== "number" ||
      !Number.isSafeInteger(expiresIn) ||
      expiresIn <= 0 ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(now + expiresIn * 1000)
    ) {
      throw new BaiduOAuthError("invalid_token_response");
    }
    const tokens: BaiduTokens = {
      accessToken: token.access_token,
      refreshToken,
      expiresAt: now + expiresIn * 1000,
    };
    if (typeof token.scope === "string") tokens.scope = token.scope;
    return tokens;
  }
}
