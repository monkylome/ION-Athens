import { describe, expect, it, vi } from "vitest";
import { SandboxClient, SandboxError, parseRetryAfter } from "./client.ts";

const KEY = "test-key-7f3a9c";
const BASE = "https://sandbox.test/sandbox";

type Step = Response | Error | (() => Response);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function setup(steps: Step[], opts: { maxRetryAfterMs?: number } = {}) {
  const calls: Array<{ url: string; method: string; key: string | null; body: unknown }> = [];
  const sleeps: number[] = [];
  let time = 1_000_000;
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), method: init?.method ?? "GET", key: headers.get("x-api-key"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const step = steps.shift();
    if (!step) throw new Error("unexpected call");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step;
  });
  const client = new SandboxClient({
    baseUrl: `${BASE}/`,
    apiKey: KEY,
    fetch: fetchFn as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    now: () => time,
    ...opts,
  });
  return { client, calls, sleeps, advance: (ms: number) => (time += ms) };
}

const page = (items: unknown[], total = items.length) => ({ total, page: 1, size: 100, items });
const REPORT = { id: "req-1001", category: "sidewalk", title: "Εμπόδιο", address: "Οδός", lat: 37.97, lng: 23.72, status: "submitted", created_at: "2026-11-21T15:23:00+02:00", upvotes: 0 };

async function failure(p: Promise<unknown>): Promise<SandboxError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SandboxError) return err;
    throw err;
  }
  throw new Error("expected the call to fail");
}

describe("SandboxClient: requests", () => {
  it("sends the key only in the X-API-Key header and builds the location filter", async () => {
    const { client, calls } = setup([json(page([REPORT]))]);
    const res = await client.listReports({ near: { lat: 37.979, lng: 23.727 }, radiusKm: 0.5, mine: true });
    expect(res.items[0]?.id).toBe("req-1001");
    expect(calls[0]?.key).toBe(KEY);
    expect(calls[0]?.url).toBe(`${BASE}/v1/requests?mine=true&lat=37.979&lng=23.727&radius_km=0.5`);
    expect(calls[0]?.url).not.toContain(KEY);
  });

  it("follows pages until it has every report", async () => {
    const { client, calls } = setup([json(page([REPORT, REPORT], 3)), json(page([REPORT], 3))]);
    expect(await client.listAllReports({ size: 2 })).toHaveLength(3);
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("sends the engine and the location with an assistant message", async () => {
    const { client, calls } = setup([json({ id: "conv-1" }), json({ speech: "ok", cards: [] })]);
    const conv = await client.openConversation();
    await client.sendMessage(conv, "πού είναι το ΚΕΠ;", { location: { lat: 37.97, lng: 23.72 }, engine: "llm" });
    expect(calls[1]).toMatchObject({
      url: `${BASE}/v1/conversations/conv-1/messages`,
      body: { text: "πού είναι το ΚΕΠ;", location: { lat: 37.97, lng: 23.72 }, engine: "llm" },
    });
  });

  it("escapes ids in paths", async () => {
    const { client, calls } = setup([new Response(null, { status: 204 })]);
    await client.deleteReport("../v1/sandbox/reset");
    expect(calls[0]?.url).toBe(`${BASE}/v1/requests/..%2Fv1%2Fsandbox%2Freset`);
  });
});

describe("SandboxClient: errors", () => {
  it("fails without a call when the key is missing", async () => {
    const fetchFn = vi.fn();
    const client = new SandboxClient({ baseUrl: BASE, apiKey: undefined, fetch: fetchFn as unknown as typeof fetch });
    const err = await failure(client.info());
    expect(err.code).toBe("not_configured");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("retries a read once after a network error", async () => {
    const { client, calls } = setup([new TypeError("fetch failed"), json(page([REPORT]))]);
    expect((await client.listReports()).items).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("gives up after the second network error and names the endpoint, not the key", async () => {
    const leaky = new TypeError(`connect failed for key ${KEY}`);
    const { client, calls } = setup([leaky, leaky]);
    const err = await failure(client.listReports({ category: "pothole" }));
    expect(calls).toHaveLength(2);
    expect(err).toMatchObject({ code: "network", endpoint: "GET /v1/requests" });
    expect(err.message).toBe("Sandbox GET /v1/requests failed: network: could not reach the sandbox");
    expect(JSON.stringify({ ...err, message: err.message, stack: err.stack, cause: err.cause })).not.toContain(KEY);
  });

  it("reports a timeout as such", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const { client } = setup([timeout, timeout]);
    expect((await failure(client.info())).code).toBe("timeout");
  });

  it("does not repeat a call that would create or count something twice", async () => {
    const a = setup([new TypeError("fetch failed")]);
    expect((await failure(a.client.createReport({ category: "sidewalk", title: "τ", address: "δ", lat: 1, lng: 2 }))).code).toBe("network");
    expect(a.calls).toHaveLength(1);

    const b = setup([new TypeError("fetch failed")]);
    expect((await failure(b.client.upvoteReport("req-1001"))).endpoint).toBe("POST /v1/requests/{id}/upvote");
    expect(b.calls).toHaveLength(1);

    const c = setup([new Response("bad gateway", { status: 502 })]);
    expect((await failure(c.client.sendMessage("conv-1", "γεια"))).code).toBe("server_error");
    expect(c.calls).toHaveLength(1);
  });

  it("retries a read once after a 5xx answer", async () => {
    const { client, calls } = setup([new Response("oops", { status: 503 }), json(page([]))]);
    await client.listReports();
    expect(calls).toHaveLength(2);
  });

  it("waits for a short Retry-After and tries once more", async () => {
    const { client, calls, sleeps } = setup([json({ error: { code: "rate_limited" } }, 429, { "retry-after": "2" }), json(page([REPORT]))]);
    expect((await client.listReports()).items).toHaveLength(1);
    expect(sleeps).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it("fails at once on a long Retry-After and makes no call until it has passed", async () => {
    const { client, calls, sleeps, advance } = setup([json({}, 429, { "retry-after": "30" }), json(page([]))]);
    const err = await failure(client.listReports());
    expect(err).toMatchObject({ code: "rate_limited", status: 429, retryAfterS: 30 });
    expect(sleeps).toEqual([]);

    const blocked = await failure(client.info());
    expect(blocked).toMatchObject({ code: "rate_limited", endpoint: "GET /v1/sandbox", retryAfterS: 30 });
    expect(calls).toHaveLength(1);

    advance(30_001);
    await client.listReports();
    expect(calls).toHaveLength(2);
  });

  it("gives up when the second answer is 429 again", async () => {
    const limited = json({}, 429, { "retry-after": "1" });
    const { client, calls } = setup([limited, limited]);
    expect((await failure(client.listReports())).code).toBe("rate_limited");
    expect(calls).toHaveLength(2);
  });

  it("maps HTTP errors to codes and keeps the sandbox's message", async () => {
    const notFound = setup([json({ error: { code: "not_found", message: "request 'req-9999' not found." } }, 404)]);
    expect(await failure(notFound.client.getReport("req-9999"))).toMatchObject({ code: "not_found", status: 404, endpoint: "GET /v1/requests/{id}" });

    const notYours = setup([json({ error: { code: "not_yours", message: "You can only change requests you created." } }, 403)]);
    const err = await failure(notYours.client.setReportStatus("req-0014", "resolved"));
    expect(err.code).toBe("forbidden");
    expect(err.message).toContain("You can only change requests you created.");

    const unauthorized = setup([json({ error: { code: "unauthorized", message: `Invalid key ${KEY}` } }, 401)]);
    const leak = await failure(unauthorized.client.info());
    expect(leak.code).toBe("unauthorized");
    expect(leak.message).not.toContain(KEY);

    const invalid = setup([json({ error: { code: "validation_error", message: "Invalid request." } }, 422)]);
    expect((await failure(invalid.client.parse(""))).code).toBe("invalid_request");
  });

  it("rejects an answer that does not have the documented shape", async () => {
    const wrong = setup([json({ items: "nope" })]);
    const err = await failure(wrong.client.listReports());
    expect(err.code).toBe("bad_response");
    expect(err.message).toContain("total");

    const html = setup([new Response("<html>maintenance</html>", { status: 200 })]);
    expect((await failure(html.client.listProjects())).code).toBe("bad_response");
  });

  it("records the remaining rate limit", async () => {
    const { client } = setup([json({}, 200, { "x-ratelimit-remaining": "87" })]);
    await client.info();
    expect(client.rateLimitRemaining).toBe(87);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds, dates and nonsense", () => {
    expect(parseRetryAfter("7", 0)).toBe(7);
    expect(parseRetryAfter("Sat, 21 Nov 2026 13:00:10 GMT", Date.parse("2026-11-21T13:00:00Z"))).toBe(10);
    expect(parseRetryAfter(null, 0)).toBe(60);
    expect(parseRetryAfter("soon", 0)).toBe(60);
  });
});
