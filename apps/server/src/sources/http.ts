import type { FetchEnv } from "./types.ts";

export type SourceErrorCode = "network" | "timeout" | "http" | "bad_response" | "not_present";

export class SourceError extends Error {
  override readonly name = "SourceError";
  constructor(
    readonly code: SourceErrorCode,
    /** For example "GET telematics.oasa.gr/api/?act=getStopArrivals". Never holds coordinates or ids. */
    readonly endpoint: string,
    detail = "",
    readonly status?: number,
  ) {
    super(`${endpoint} failed: ${code}${status ? ` (HTTP ${status})` : ""}${detail ? `: ${detail}` : ""}`);
  }
}

const HEADERS = { "user-agent": "ION-Athens-prototype/0.1 (accessible mobility; read-only)", "accept-language": "el,en;q=0.5" };

/** GET with a timeout. A network error or a 5xx is tried once more; a timeout is not. */
export async function fetchText(env: FetchEnv, url: string, endpoint: string, accept = "*/*"): Promise<string> {
  let last: SourceError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && env.retryDelayMs > 0) await new Promise((r) => setTimeout(r, env.retryDelayMs));
    try {
      const res = await env.fetch(url, { method: "GET", headers: { ...HEADERS, accept }, signal: AbortSignal.timeout(env.timeoutMs) });
      if (res.ok) return await res.text();
      last = new SourceError("http", endpoint, "", res.status);
      if (res.status < 500) throw last;
    } catch (err) {
      if (err instanceof SourceError) {
        last = err;
        if (err.status !== undefined && err.status < 500) throw err;
        continue;
      }
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      last = new SourceError(timedOut ? "timeout" : "network", endpoint, timedOut ? `no answer in ${env.timeoutMs} ms` : err instanceof Error ? err.message : "");
      if (timedOut) break; // a source that did not answer in time is not asked again at once
    }
  }
  throw last ?? new SourceError("network", endpoint);
}

export async function fetchJson(env: FetchEnv, url: string, endpoint: string): Promise<unknown> {
  const text = await fetchText(env, url, endpoint, "application/json");
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError("bad_response", endpoint, "the answer is not JSON");
  }
}
