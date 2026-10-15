export interface WebdavAttempt {
  operation: string;
  elapsedMs: number;
  status?: number;
  retryDelayMs?: number;
}
export interface WebdavDiagnostics {
  requests: number;
  retries: number;
  elapsedMs: number;
  operations: Record<string, number>;
  lastFailure?: { operation: string; status?: number };
}
function retryAfter(error: any): number | undefined {
  const headers = error?.response?.headers;
  const value = headers?.get?.("retry-after") ?? headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (typeof value !== "string") return;
  const ms = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}
export function transientWebdavError(error: any): boolean {
  const status = error?.status ?? error?.response?.status;
  if (typeof status === "number") return [408, 429, 500, 502, 503, 504].includes(status);
  return ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ENETUNREACH", "ECONNREFUSED"].includes(error?.code ?? error?.cause?.code) ||
    /(?:fetch failed|failed to fetch|network request failed|net::ERR_(?:TIMED_OUT|CONNECTION_RESET|NETWORK_CHANGED|INTERNET_DISCONNECTED))/i.test(error?.message ?? "");
}

// Read-only SDK operations only. Never wrap PUT/MOVE/DELETE/MKCOL: a lost
// response cannot tell us whether a mutation already happened.
export async function retryWebdavRead<T>(operation: string, read: () => Promise<T>,
  observed: (attempt: WebdavAttempt) => void = () => {},
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const start = Date.now();
    try {
      const result = await read();
      observed({operation, elapsedMs: Math.max(0, Date.now() - start)});
      return result;
    } catch (error: any) {
      const serverDelay = retryAfter(error);
      const canRetry = attempt < 2 && transientWebdavError(error) && (serverDelay === undefined || serverDelay <= 15000);
      const retryDelayMs = canRetry ? Math.max(serverDelay ?? 0, 500 * 2 ** attempt + Math.floor(Math.random() * 250)) : undefined;
      observed({operation, elapsedMs: Math.max(0, Date.now() - start), status: error?.status ?? error?.response?.status, retryDelayMs});
      if (!canRetry) throw error;
      await wait(retryDelayMs!);
    }
  }
}
