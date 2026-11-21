/** The HTTP API against an in-memory imitation of the sandbox. No network. */
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { FallbackRouting } from "./routing/fallback.ts";
import { SandboxClient } from "./sandbox/client.ts";
import { at, testEdges, testGraph } from "./testing/fixtures.ts";

const KEY = "test-key-51c2e8";

function setup(opts: { graph?: boolean; demoEnabled?: boolean } = {}) {
  const sandbox = { reports: [] as Array<Record<string, unknown>>, down: false, calls: [] as string[], next: 1001 };
  let time = Date.parse("2026-11-21T12:00:00+02:00");
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/sandbox", "");
    sandbox.calls.push(`${method} ${path}`);
    if (sandbox.down) throw new TypeError("fetch failed");
    const send = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const one = /^\/v1\/requests\/([^/]+)(\/upvote)?$/.exec(path);
    const found = one && sandbox.reports.find((r) => r["id"] === one[1]);
    if (path === "/v1/sandbox") return send({ rate_limit_per_minute: 100, llm: { enabled: true, calls_left_today: 990 } });
    if (path === "/v1/projects.geojson") return send({ type: "FeatureCollection", features: [] });
    if (path === "/v1/requests" && method === "GET") return send({ total: sandbox.reports.length, page: 1, size: 100, items: sandbox.reports });
    if (path === "/v1/requests" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const created = { ...body, id: `req-${sandbox.next++}`, status: "submitted", upvotes: 0, created_at: new Date(time).toISOString(), created_by_you: true };
      sandbox.reports.push(created);
      return send(created, 201);
    }
    if (path === "/v1/sandbox/reset") {
      sandbox.reports = [];
      return send({ ok: true });
    }
    if (one && !found) return send({ error: { code: "not_found", message: "not found" } }, 404);
    if (one && found && one[2]) return send(Object.assign(found, { upvotes: Number(found["upvotes"]) + 1 }));
    if (one && found && method === "PATCH") return send(Object.assign(found, JSON.parse(String(init?.body)) as object));
    if (path === "/v1/pois") return send({ total: 1, page: 1, size: 20, items: [{ id: "poi-1", name: "Δοκιμαστικό σημείο", category: "kep", lat: 37.98, lng: 23.73, address: "Οδός 1, Αθήνα", distance_km: 0.25 }] });
    return send({ error: { code: "not_found", message: "no such path" } }, 404);
  };
  const client = new SandboxClient({ baseUrl: "https://sandbox.test/sandbox", apiKey: KEY, fetch: fetchFn as typeof fetch });
  const graph = opts.graph === false ? { ...testGraph(), nodes: [], edges: [] } : testGraph();
  const { app, obstacles } = createApp({
    client,
    routing: new FallbackRouting(graph),
    edges: opts.graph === false ? { nearestEdge: () => null, edgesInBBox: () => [] } : testEdges(),
    graphLoaded: opts.graph !== false,
    now: () => new Date(time),
    ...(opts.demoEnabled === undefined ? {} : { demoEnabled: opts.demoEnabled }),
  });
  const post = (path: string, body?: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const point = (x: number, y: number) => {
    const [lng, lat] = at(x, y);
    return { lng, lat };
  };
  return { app, post, point, sandbox, obstacles, advance: (ms: number) => (time += ms) };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (res: Response | Promise<Response>): Promise<Json> => (await (await res).json()) as Json;

describe("reports and demo control", () => {
  it("POST /api/reports creates an unconfirmed report: a partial obstacle", async () => {
    const { post, point, sandbox } = setup();
    const res = await post("/api/reports", { ...point(50, 4), category: "bulky_waste", text: "καναπές" });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({ sandbox: true, report: { id: "req-1001", upvotes: 0 }, obstacle: { edgeId: "AB", blocks: "partial", synthetic: true } });
    // The sandbox got a point, a category and a text: nothing about a person.
    expect(Object.keys(sandbox.reports[0]!).sort()).toEqual(["address", "category", "created_at", "created_by_you", "description", "id", "lat", "lng", "status", "title", "upvotes"]);
    expect(sandbox.reports[0]).toMatchObject({ title: "Ογκώδη αντικείμενα στο πεζοδρόμιο", address: "Οδός AB, Αθήνα", description: "καναπές" });
  });

  it("a report alone is partial; a second person confirming it makes it a full block", async () => {
    const { post, point } = setup();
    expect((await json(post("/api/reports", point(50, 4)))).obstacle.blocks).toBe("partial");
    expect((await json(post("/api/reports/req-1001/confirm"))).obstacle).toMatchObject({ blocks: "full", confidence: 0.85 });
  });

  it("POST /api/demo/obstacle creates a full block at once, and /api/route goes around it", async () => {
    const { post, point, app } = setup();
    const before = await json(post("/api/route", { from: point(0, 0), to: point(200, 0) }));
    expect(before.route.edges).toEqual(["AB", "BC"]);
    expect(before).toMatchObject({ rerouted: false, obstacles: [], sandbox: true, engine: "fallback" });

    // An unconfirmed report first, so the next answer must reflect a change made a moment ago.
    await post("/api/reports", point(150, 104));
    await post("/api/reports/req-1001/confirm");
    await post("/api/reports/req-1001/confirm");
    expect((await json(post("/api/route", { from: point(0, 100), to: point(200, 100) }))).rerouted).toBe(true);
    await post("/api/demo/resolve/req-1001");

    const made = await json(post("/api/demo/obstacle", point(50, 3)));
    expect(made).toMatchObject({ sandbox: true, demo: true, report: { upvotes: 1 }, obstacle: { blocks: "full", edgeId: "AB" } });

    const list = await json(app.request("/api/obstacles"));
    expect(list).toMatchObject({ sandbox: true, stale: false, counts: { reports: 2, obstacles: 1 } });

    const after = await json(post("/api/route", { from: point(0, 0), to: point(200, 0) }));
    expect(after.route.edges).not.toContain("AB");
    expect(after.route.lengthM).toBeCloseTo(400, 0);
    expect(after.rerouted).toBe(true);
    expect(after.obstacles).toMatchObject([{ id: "sandbox:req-1002", effect: "avoided" }]);
    expect(after.withoutObstacles.lengthM).toBeCloseTo(200, 0);

    const resolved = await json(post("/api/demo/resolve/req-1002"));
    expect(resolved).toMatchObject({ sandbox: true, report: { status: "resolved" }, obstacle: null, notAnObstacle: { reason: "closed" } });
    expect((await json(post("/api/route", { from: point(0, 0), to: point(200, 0) }))).route.edges).toEqual(["AB", "BC"]);
  });

  it("POST /api/demo/reset clears what the key created", async () => {
    const { post, point, sandbox } = setup();
    await post("/api/demo/obstacle", point(50, 3));
    expect(await json(post("/api/demo/reset"))).toEqual({ sandbox: true, demo: true, reset: true, obstacles: 0 });
    expect(sandbox.reports).toEqual([]);
  });

  it("can switch demo control off", async () => {
    const { post, point } = setup({ demoEnabled: false });
    expect((await post("/api/demo/obstacle", point(50, 3))).status).toBe(403);
  });

  it("refuses bad input before calling the sandbox", async () => {
    const { post, sandbox } = setup();
    expect((await post("/api/reports", { lng: 23.7, lat: 137 })).status).toBe(400);
    expect((await post("/api/reports", { lng: 23.7, lat: 37.9, category: "aliens" })).status).toBe(400);
    expect((await post("/api/reports/..%2Freset/confirm")).status).toBe(400);
    expect((await post("/api/destination", { text: "" })).status).toBe(400);
    expect(sandbox.calls).toEqual([]);
  });

  it("passes on a sandbox 404 with the endpoint named", async () => {
    const { post } = setup();
    const res = await post("/api/reports/req-9999/confirm");
    expect(res.status).toBe(404);
    expect((await json(res)).error).toMatchObject({ code: "sandbox_not_found", endpoint: "POST /v1/requests/{id}/upvote" });
  });
});

describe("when the sandbox stops answering", () => {
  it("serves the last obstacles marked stale, still routes, and never shows the key", async () => {
    const { post, point, app, sandbox, advance } = setup();
    await post("/api/demo/obstacle", point(50, 3));
    await app.request("/api/obstacles");
    sandbox.down = true;
    advance(60_000);

    const list = await json(app.request("/api/obstacles"));
    expect(list).toMatchObject({ stale: true, problem: "network", counts: { obstacles: 1 } });
    const route = await json(post("/api/route", { from: point(0, 0), to: point(200, 0) }));
    expect(route).toMatchObject({ rerouted: true, obstaclesStale: true });

    const health = await json(app.request("/api/health"));
    expect(health).toMatchObject({ ok: true, sandbox: { configured: true, reachable: false, problem: "network" }, graph: { loaded: true, edges: 7 }, routing: { engine: "fallback" } });
    const failed = await post("/api/reports", point(50, 3));
    expect(failed.status).toBe(502);
    expect(JSON.stringify([list, route, health, await json(failed)])).not.toContain(KEY);
  });
});

describe("other endpoints", () => {
  it("GET /api/health says the sandbox answers and the graph is loaded", async () => {
    const { app } = setup();
    expect(await json(app.request("/api/health"))).toMatchObject({ ok: true, sandbox: { reachable: true, llmMessagesLeftToday: 990 }, graph: { loaded: true, nodes: 6, edges: 7 } });
  });

  it("GET /api/places searches once and then answers from memory", async () => {
    const { app, sandbox } = setup();
    const first = await json(app.request("/api/places?q=%CE%9A%CE%95%CE%A0&lat=37.979&lng=23.727"));
    expect(first.places).toEqual([{ id: "poi-1", name: "Δοκιμαστικό σημείο", category: "kep", categoryName: null, lng: 23.73, lat: 37.98, address: "Οδός 1, Αθήνα", distanceM: 250, openNow: null, wheelchairAccessible: null }]);
    await app.request("/api/places?q=%CE%9A%CE%95%CE%A0&lat=37.979&lng=23.727");
    expect(sandbox.calls.filter((c) => c === "GET /v1/pois")).toHaveLength(1);
  });

  it("POST /api/route says so when the graph is missing", async () => {
    const { post, point } = setup({ graph: false });
    const res = await post("/api/route", { from: point(0, 0), to: point(200, 0) });
    expect(res.status).toBe(503);
    expect((await json(res)).error.code).toBe("graph_not_loaded");
  });

  it("allows a local web app through CORS and nobody else", async () => {
    const { app } = setup();
    const local = await app.request("/api/health", { headers: { origin: "http://localhost:5173" } });
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await app.request("/api/health", { headers: { origin: "https://example.org" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("GET /api/events sends a snapshot and then the changes", async () => {
    const { app, post, point, obstacles } = setup();
    const res = await app.request("/api/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        text += decoder.decode(value, { stream: true });
      }
    };
    await until("event: snapshot");
    await post("/api/demo/obstacle", point(50, 3));
    await until("event: obstacle_added");
    const data = /event: obstacle_added\ndata: (.*)\n/.exec(text)?.[1];
    expect(JSON.parse(data!)).toMatchObject({ type: "obstacle_added", sandbox: true, obstacle: { id: "sandbox:req-1001", blocks: "full" } });
    await reader.cancel();
    obstacles.stop();
  });
});

it("isolates the demo clock across route, decisions and obstacle reads", async () => {
  const query="?at=2026-11-23T10:00:00Z";
  for (const demoEnabled of [true,false]) {
    const {app,post,point} = setup({demoEnabled});
    for (const path of ["/api/obstacles","/api/decisions"]) {
      expect((await json(app.request(path+query))).simulatedTime).toBe(demoEnabled || undefined);
      expect((await json(app.request(path))).simulatedTime).toBeUndefined();
      expect((await app.request(path+"?at=bad")).status).toBe(demoEnabled ? 400 : 200);
    }
    expect((await json(post("/api/route"+query,{from:point(0,0),to:point(100,0)}))).simulatedTime).toBe(demoEnabled || undefined);
  }
});

it("lists three preferences, defaults to voice and returns comparable routes", async () => {
  const {app,post,point}=setup();
  const body={from:point(0,0),to:point(100,0)};
  const prefs=await json(app.request("/api/profiles"));
  expect(prefs.profiles.map((p:Json)=>p.id)).toEqual(["voice","wheels","quiet"]);
  expect((await json(post("/api/route",body))).profile).toBe("voice");
  const single=await json(post("/api/route",{...body,profile:"quiet"}));
  expect(single.profile).toBe("quiet");
  const comparison=await json(post("/api/routes",body));
  expect(comparison.routes).toHaveLength(3);
  expect(comparison.routes[2].facts).toEqual(single.facts);
  expect((await post("/api/route",{...body,profile:"other"})).status).toBe(400);
});
