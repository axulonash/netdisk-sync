import type { BaiduTokens } from "./baiduAuth";
export interface BaiduSessionOptions {
  tokens?: BaiduTokens;
  refresh: (refreshToken: string) => Promise<BaiduTokens>;
  save: (tokens: BaiduTokens | undefined) => Promise<void>;
  now?: () => number;
}
export class BaiduSessionError extends Error {
  constructor(public readonly code: string) {
    super(`Baidu token session failed (${code})`);
    this.name = "BaiduSessionError";
  }
}
const copy = (tokens: BaiduTokens): BaiduTokens => ({ ...tokens });
const validate = (tokens: BaiduTokens) => {
  if (
    !tokens ||
    typeof tokens.accessToken !== "string" ||
    !tokens.accessToken.trim() ||
    typeof tokens.refreshToken !== "string" ||
    !tokens.refreshToken.trim() ||
    !Number.isSafeInteger(tokens.expiresAt) ||
    tokens.expiresAt < 0
  ) {
    throw new BaiduSessionError("invalid_tokens");
  }
};
export class BaiduTokenSession {
  private tokens?: BaiduTokens;
  private pending?: BaiduTokens;
  private revision = 0;
  private flight?: Promise<string>;
  private saves: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: BaiduSessionOptions) {
    this.now = options.now ?? Date.now;
    if (options.tokens) {
      validate(options.tokens);
      this.tokens = copy(options.tokens);
    }
  }

  async getAccessToken(): Promise<string> {
    if (!this.tokens && !this.pending)
      throw new BaiduSessionError("not_logged_in");
    if (this.flight) return this.flight;
    if (
      !this.pending &&
      this.tokens &&
      this.tokens.expiresAt > this.now() + 30000
    )
      return this.tokens.accessToken;
    const revision = this.revision;
    const flight = this.refreshAndSave(revision);
    this.flight = flight;
    try {
      return await flight;
    } finally {
      if (this.flight === flight) this.flight = undefined;
    }
  }

  private async refreshAndSave(revision: number): Promise<string> {
    let candidate = this.pending;
    if (!candidate || candidate.expiresAt <= this.now()) {
      const source = candidate ?? this.tokens!;
      try {
        candidate = copy(await this.options.refresh(source.refreshToken));
      } catch {
        throw new BaiduSessionError(
          this.revision === revision ? "refresh_failed" : "session_changed"
        );
      }
    }
    if (this.revision !== revision)
      throw new BaiduSessionError("session_changed");
    validate(candidate);
    if (candidate.expiresAt <= this.now())
      throw new BaiduSessionError("invalid_tokens");
    // Retain a rotated token in memory until saving succeeds; a retry must not
    // reuse the previous refresh token after the provider has rotated it.
    this.pending = copy(candidate);
    const saving = this.saves.then(async () => {
      if (this.revision !== revision)
        throw new BaiduSessionError("session_changed");
      try {
        await this.options.save(copy(candidate!));
      } catch {
        throw new BaiduSessionError(
          this.revision === revision ? "save_failed" : "session_changed"
        );
      }
    });
    this.saves = saving.catch(() => {});
    await saving;
    if (this.revision !== revision)
      throw new BaiduSessionError("session_changed");
    this.tokens = copy(candidate);
    this.pending = undefined;
    if (candidate.expiresAt <= this.now())
      throw new BaiduSessionError("token_expired");
    return candidate.accessToken;
  }

  async logout(): Promise<void> {
    this.revision++;
    this.tokens = undefined;
    this.pending = undefined;
    const clearing = this.saves.then(async () => {
      try {
        await this.options.save(undefined);
      } catch {
        throw new BaiduSessionError("save_failed");
      }
    });
    this.saves = clearing.catch(() => {});
    await clearing;
  }
}
