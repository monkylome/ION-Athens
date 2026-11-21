/**
 * Typed client for the AthensGov Sandbox API.
 *
 * - The API key travels only in the `X-API-Key` header and never appears in an
 *   error, a log line or a return value.
 * - Every call has a timeout. A network error or a 5xx answer is retried once,
 *   but only for calls that are safe to repeat: creating a report, upvoting and
 *   sending an assistant message are sent at most once.
 * - On 429 the client waits for `Retry-After` when that is short and tries once
 *   more; otherwise it fails at once and refuses further calls until the time
 *   the sandbox gave, so a burst cannot dig the hole deeper.
 */
import type { ZodType, ZodTypeDef } from "zod";
import { type Benefit, benefitPageSchema } from "../missions/rewards.ts";
import {
  type AssistantReply, type NluParse, type SandboxInfo, type SandboxPoi, type SandboxProject,
  type SandboxReport, assistantReplySchema, conversationSchema, nluParseSchema, poiPageSchema,
  projectCollectionSchema, reportPageSchema, reportSchema, sandboxInfoSchema,
} from "./schemas.ts";

export type SandboxErrorCode =
  | "not_configured" // base URL or key missing
  | "network" // no answer
  | "timeout"
  | "rate_limited" // 429
  | "unauthorized" // 401 or 403 about the key
  | "not_found"
  | "forbidden" // for example changing a report another key created
  | "invalid_request" // 4xx
  | "server_error" // 5xx
  | "bad_response"; // the answer did not have the documented shape

export class SandboxError extends Error {
  override readonly name = "SandboxError";
  constructor(
    readonly code: SandboxErrorCode,
    /** For example "GET /v1/requests". Never contains the key or a query string. */
    readonly endpoint: string,
    detail: string,
    readonly status?: number,
    readonly retryAfterS?: number,
  ) {
    super(`Sandbox ${endpoint} failed: ${code}${status ? ` (HTTP ${status})` : ""}${detail ? `: ${detail}` : ""}`);
  }
}

export interface SandboxClientOptions {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  timeoutMs?: number;
  /** A `Retry-After` up to this long is waited for; a longer one fails at once. */
  maxRetryAfterMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface ListReportsQuery {
  status?: string;
  category?: string;
  mine?: boolean;
  near?: LatLng;
  radiusKm?: number;
  page?: number;
  size?: number;
}

export interface CreateReportInput {
  category: string;
  title: string;
  description?: string;
  address: string;
  lat: number;
  lng: number;
}

export interface SearchPoisQuery {
  q?: string;
  category?: string;
  area?: string;
  near?: LatLng;
  radiusKm?: number;
  openNow?: boolean;
  size?: number;
}

export type AssistantEngine = "rules" | "llm";

interface CallOptions<T> {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  schema?: ZodType<T, ZodTypeDef, unknown>;
  /** Safe to send twice. Defaults to true for GET and DELETE. */
  repeatable?: boolean;
  timeoutMs?: number;
}

export class SandboxClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private blockedUntil = 0;
  /** Last `X-RateLimit-Remaining` the sandbox sent, when it sent one. */
  rateLimitRemaining: number | null = null;

  constructor(opts: SandboxClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 3000;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  get configured(): boolean {
    return this.baseUrl !== "" && this.apiKey !== "";
  }

  // --- reports -------------------------------------------------------------

  listReports(q: ListReportsQuery = {}): Promise<{ total: number; page: number; size: number; items: SandboxReport[] }> {
    return this.call("GET", "/v1/requests", {
      schema: reportPageSchema,
      query: {
        status: q.status, category: q.category, mine: q.mine, lat: q.near?.lat, lng: q.near?.lng,
        radius_km: q.radiusKm, page: q.page, size: q.size,
      },
    });
  }

  /** Every report, following pages. Stops after `maxPages` to protect the rate limit. */
  async listAllReports(q: Omit<ListReportsQuery, "page"> = {}, maxPages = 5): Promise<SandboxReport[]> {
    const size = q.size ?? 100;
    const items: SandboxReport[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.listReports({ ...q, size, page });
      items.push(...res.items);
      if (res.items.length === 0 || items.length >= res.total) break;
    }
    return items;
  }

  getReport(id: string): Promise<SandboxReport> {
    return this.call("GET", `/v1/requests/${encodeURIComponent(id)}`, { schema: reportSchema }, "/v1/requests/{id}");
  }

  createReport(input: CreateReportInput): Promise<SandboxReport> {
    return this.call("POST", "/v1/requests", { schema: reportSchema, body: input, repeatable: false });
  }

  /** «Το έχω δει κι εγώ». The sandbox counts every call, also from the same key. */
  upvoteReport(id: string): Promise<SandboxReport> {
    return this.call("POST", `/v1/requests/${encodeURIComponent(id)}/upvote`, { schema: reportSchema, repeatable: false }, "/v1/requests/{id}/upvote");
  }

  /** Works only for reports this key created; the sandbox answers 403 `not_yours` otherwise. */
  setReportStatus(id: string, status: string, note?: string): Promise<SandboxReport> {
    return this.call("PATCH", `/v1/requests/${encodeURIComponent(id)}`, { schema: reportSchema, body: { status, note }, repeatable: true }, "/v1/requests/{id}");
  }

  async deleteReport(id: string): Promise<void> {
    await this.call("DELETE", `/v1/requests/${encodeURIComponent(id)}`, {}, "/v1/requests/{id}");
  }

  // --- projects and points of interest ----------------------------------------

  async listProjects(q: { status?: string; category?: string } = {}): Promise<SandboxProject[]> {
    const fc = await this.call("GET", "/v1/projects.geojson", { schema: projectCollectionSchema, query: q });
    return fc.features;
  }

  async searchPois(q: SearchPoisQuery = {}): Promise<SandboxPoi[]> {
    const res = await this.call("GET", "/v1/pois", {
      schema: poiPageSchema,
      query: {
        q: q.q, category: q.category, area: q.area, lat: q.near?.lat, lng: q.near?.lng,
        radius_km: q.radiusKm, open_now: q.openNow, size: q.size ?? 20,
      },
    });
    return res.items;
  }

  // --- Athens Card ---------------------------------------------------------

  /** Benefits of the sandbox's Athens Card, a programme the sandbox itself calls fictional. */
  async listBenefits(): Promise<Benefit[]> {
    const res = await this.call("GET", "/v1/athens-card/benefits", { schema: benefitPageSchema, query: { size: 50 } });
    return res.items;
  }

  // --- assistant -------------------------------------------------------------

  async openConversation(opts: { lang?: "el" | "en" | "auto"; channel?: "chat" | "voice" } = {}): Promise<string> {
    const conv = await this.call("POST", "/v1/conversations", {
      schema: conversationSchema,
      body: { lang: opts.lang ?? "el", channel: opts.channel ?? "voice" },
      repeatable: true,
    });
    return conv.id;
  }

  sendMessage(conversationId: string, text: string, opts: { location?: LatLng; engine?: AssistantEngine } = {}): Promise<AssistantReply> {
    return this.call(
      "POST",
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        schema: assistantReplySchema,
        body: { text, location: opts.location, engine: opts.engine ?? "rules" },
        repeatable: false,
        // The language-model engine takes 1.5 to 2.5 seconds on top of the rules.
        timeoutMs: opts.engine === "llm" ? Math.max(this.timeoutMs, 12_000) : undefined,
      },
      "/v1/conversations/{id}/messages",
    );
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.call("DELETE", `/v1/conversations/${encodeURIComponent(conversationId)}`, {}, "/v1/conversations/{id}");
  }

  /** Intent and entities from the rules engine, without a conversation. */
  parse(text: string): Promise<NluParse> {
    return this.call("POST", "/v1/nlu/parse", { schema: nluParseSchema, body: { text }, repeatable: true });
  }

  // --- sandbox ---------------------------------------------------------------

  info(): Promise<SandboxInfo> {
    return this.call("GET", "/v1/sandbox", { schema: sandboxInfoSchema });
  }

  /** Deletes everything this key created: reports, conversations, bookings. */
  async reset(): Promise<void> {
    await this.call("POST", "/v1/sandbox/reset", { repeatable: true });
  }

  // --- transport -------------------------------------------------------------

  private async call<T = unknown>(method: string, path: string, opts: CallOptions<T> = {}, label = path): Promise<T> {
    const endpoint = `${method} ${label}`;
    if (!this.configured) {
      throw new SandboxError("not_configured", endpoint, "SANDBOX and SANDBOX_KEY must be set in the server environment");
    }
    const waitMs = this.blockedUntil - this.now();
    if (waitMs > 0) {
      throw new SandboxError("rate_limited", endpoint, "waiting for the sandbox rate limit to clear", 429, Math.ceil(waitMs / 1000));
    }

    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const repeatable = opts.repeatable ?? (method === "GET" || method === "DELETE");
    const init: RequestInit = {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    };

    let rateLimitRetried = false;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs) });
      } catch (err) {
        if (repeatable && attempt === 1) continue;
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        // The cause is not passed on: a fetch error can carry the request, headers included.
        throw new SandboxError(timedOut ? "timeout" : "network", endpoint, timedOut ? "no answer in time" : "could not reach the sandbox");
      }

      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      if (res.headers.has("x-ratelimit-remaining") && Number.isFinite(remaining)) this.rateLimitRemaining = remaining;

      if (res.status === 429) {
        const retryAfterS = parseRetryAfter(res.headers.get("retry-after"), this.now());
        const retryMs = retryAfterS * 1000;
        if (!rateLimitRetried && retryMs <= this.maxRetryAfterMs) {
          rateLimitRetried = true;
          await this.sleep(retryMs);
          continue;
        }
        this.blockedUntil = this.now() + retryMs;
        throw new SandboxError("rate_limited", endpoint, "too many requests", 429, retryAfterS);
      }
      if (res.status >= 500) {
        if (repeatable && attempt === 1) continue;
        throw new SandboxError("server_error", endpoint, "", res.status);
      }
      if (!res.ok) {
        const { code, message } = await readError(res);
        const kind: SandboxErrorCode =
          res.status === 401 ? "unauthorized"
          : res.status === 404 ? "not_found"
          : res.status === 403 ? (code === "not_yours" ? "forbidden" : "unauthorized")
          : "invalid_request";
        throw new SandboxError(kind, endpoint, this.scrub([code, message].filter(Boolean).join(" - ")), res.status);
      }

      if (res.status === 204 || !opts.schema) return undefined as T;
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new SandboxError("bad_response", endpoint, "the answer was not JSON", res.status);
      }
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        const where = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        throw new SandboxError("bad_response", endpoint, `unexpected shape (${where})`, res.status);
      }
      return parsed.data;
    }
  }

  /** Last line of defence: the key must not leave through an echoed message. */
  private scrub(text: string): string {
    const clean = this.apiKey ? text.split(this.apiKey).join("[key]") : text;
    return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
  }
}

async function readError(res: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    return {
      code: typeof body.error?.code === "string" ? body.error.code : "",
      message: typeof body.error?.message === "string" ? body.error.message : "",
    };
  } catch {
    return { code: "", message: "" };
  }
}

/** `Retry-After` as seconds: a number, an HTTP date, or 60 when missing or unreadable. */
export function parseRetryAfter(value: string | null, nowMs: number): number {
  if (value === null || value.trim() === "") return 60;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 60 : Math.max(0, Math.ceil((date - nowMs) / 1000));
}
