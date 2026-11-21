/**
 * The HTTP API. Everything it needs is passed in, so tests can build it with
 * a fake sandbox client and a tiny graph.
 */
import type { LngLat, Obstacle } from "@ion/core";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { DestinationResolver } from "./destination/resolve.ts";
import type { ObstacleEvent } from "./obstacles/diff.ts";
import { type EdgeLookup, type MappingOptions, DEFAULT_MAPPING_OPTIONS, reportToObstacle } from "./obstacles/rules.ts";
import { ObstacleService } from "./obstacles/service.ts";
import { isActive } from "./routing/fallback.ts";
import { type MissionOptions, MissionBoard } from "./missions/missions.ts";
import { type Benefit, toRewards } from "./missions/rewards.ts";
import type { RoutingPort } from "./routing/port.ts";
import { SandboxError, type SandboxClient } from "./sandbox/client.ts";
import { REPORT_CATEGORIES, type SandboxPoi, type SandboxReport } from "./sandbox/schemas.ts";
import { streetIndex, placeDecision, decisionObstacles, type Placed } from "./sources/diavgeia.ts";
import { type CitySources, gisPlaces, offlineCitySources, registerCityRoutes } from "./sources/index.ts";

export interface AppDeps {
  client: SandboxClient;
  routing: RoutingPort;
  /** Edge queries for the obstacle rules. */
  edges: EdgeLookup;
  graphLoaded: boolean;
  /** Whether the pavement survey was applied to the graph, from loadGraph. */
  enrichment?: { applied: boolean; edgesCovered: number; problem?: string };
  mapping?: Partial<MappingOptions>;
  pollMs?: number;
  corsOrigins?: string[];
  demoEnabled?: boolean;
  useLlm?: boolean;
  /** Rules for citizen missions; defaults in missions/missions.ts. */
  missions?: Partial<MissionOptions>;
  /** City sources behind `/api/sources`, `/api/context` and the extra places. Without it none is reached. */
  citySources?: CitySources;
  now?: () => Date;
  log?: (line: string) => void;
}

const pointSchema = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});
const reportBodySchema = pointSchema.extend({
  category: z.enum(REPORT_CATEGORIES).default("sidewalk"),
  text: z.string().trim().max(280).optional(),
});
const destinationBodySchema = z.object({
  text: z.string().trim().min(1).max(300),
  location: pointSchema.optional(),
});
const routeBodySchema = z.object({ from: pointSchema, to: pointSchema });
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What a person is told when ION files the report for them. No personal data. */
const REPORT_TITLES: Record<(typeof REPORT_CATEGORIES)[number], string> = {
  sidewalk: "Εμπόδιο στο πεζοδρόμιο",
  tree: "Δέντρο ή κλαδιά στο πεζοδρόμιο",
  garbage: "Σκουπίδια ή κάδος στο πεζοδρόμιο",
  bulky_waste: "Ογκώδη αντικείμενα στο πεζοδρόμιο",
  water_leak: "Νερά στο πεζοδρόμιο",
  pothole: "Λακκούβα στη διαδρομή πεζών",
  abandoned_vehicle: "Όχημα που κλείνει το πεζοδρόμιο",
  other: "Εμπόδιο που κλείνει το πεζοδρόμιο",
  streetlight: "Πρόβλημα φωτισμού",
  graffiti: "Γκράφιτι",
  noise: "Θόρυβος",
  stray_animals: "Αδέσποτα ζώα",
};

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const { client, routing } = deps;
  const city = deps.citySources ?? offlineCitySources();
  const mapping = { ...DEFAULT_MAPPING_OPTIONS, ...deps.mapping };
  const board = new MissionBoard(routing.graph, deps.missions, now);
  const index = streetIndex(routing.graph);
  let decisions: Placed[] = [];
  let cacheKey = "";
  async function refreshDecisions(waitMs?: number) {
    const feeds = await Promise.all(city.decisions.map(feed => feed.get(undefined, waitMs)));
    const key = feeds.map(f => f.fetchedAt).join("|");
    if (key !== cacheKey) {
      decisions = [...new Map(feeds.flatMap(f => f.records).map(d => [d.ada, d])).values()].map(d => placeDecision(d,index));
      cacheKey = key;
    }
    return feeds.map(({ stale, problem, fetchedAt }) => ({ stale, problem, fetchedAt }));
  }
  const obstacles = new ObstacleService({
    refreshDecisions: async () => { if (deps.citySources) await refreshDecisions(50); },
    decisionObstacles: date => board.applyPavementAnswers(decisions.flatMap(d => decisionObstacles(d,date)),date),
    client,
    edges: deps.edges,
    mapping,
    now,
    ...(deps.pollMs ? { pollMs: deps.pollMs, maxAgeMs: Math.max(1000, deps.pollMs - 1000) } : {}),
    onError: (err) => log(`obstacles: ${describe(err)}`),
  });
  const destinations = new DestinationResolver(client, { useLlm: deps.useLlm ?? true });

  // Citizen missions change the graph the router reads, so they share it.

  type StreamEvent = { type: string };
  const missionListeners = new Set<(event: StreamEvent) => void>();
  const announce = (event: StreamEvent) => {
    for (const listener of missionListeners) listener(event);
  };
  let benefits: { at: number; items: Benefit[] } | null = null;
  const places = new Map<string, { at: number; items: SandboxPoi[] }>();
  let health: { at: number; reachable: boolean; problem: string | null; llmLeft: number | null } | null = null;

  const app = new Hono();
  const allowed = new Set(deps.corsOrigins ?? []);
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (allowed.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.onError((err, c) => {
    if (err instanceof SandboxError) {
      log(`sandbox: ${err.message}`);
      const status = err.code === "not_found" ? 404 : err.code === "rate_limited" ? 429 : err.code === "forbidden" ? 403 : err.code === "invalid_request" ? 400 : 502;
      if (err.retryAfterS !== undefined) c.header("Retry-After", String(err.retryAfterS));
      return c.json({ error: { code: `sandbox_${err.code}`, message: err.message, endpoint: err.endpoint } }, status);
    }
    log(`error: ${describe(err)}`);
    return c.json({ error: { code: "internal", message: "Unexpected server error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "No such endpoint" } }, 404));

  const body = async <T>(c: Context, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<{ ok: true; data: T } | { ok: false; res: Response }> => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return { ok: false, res: c.json({ error: { code: "invalid_json", message: "The body must be JSON" } }, 400) };
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) return { ok: true, data: parsed.data };
    const message = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return { ok: false, res: c.json({ error: { code: "invalid_request", message } }, 400) };
  };

  const snapshotBody = (snap: Awaited<ReturnType<ObstacleService["snapshot"]>>) => ({
    sandbox: true,
    synthetic: true,
    stale: snap.stale,
    ...(snap.problem ? { problem: snap.problem } : {}),
    updatedAt: snap.updatedAt,
    graphLoaded: deps.graphLoaded,
    counts: { ...snap.counts, obstacles: snap.obstacles.length, skipped: snap.skipped.length },
    obstacles: snap.obstacles,
    skipped: snap.skipped,
  });

  /** The address the sandbox requires, from the street name of the nearest edge when there is one. */
  const addressFor = (p: LngLat): string => {
    const match = routing.nearestEdge(p, 30);
    const name = match && routing.graph.edges.find((e) => e.id === match.edgeId)?.name;
    return name ? `${name}, Αθήνα` : `Σημείο ${p[1].toFixed(5)}, ${p[0].toFixed(5)}`;
  };

  const reportView = (r: SandboxReport) => {
    const out = reportToObstacle(r, deps.edges, now(), mapping);
    return {
      sandbox: true,
      report: { id: r.id, category: r.category, title: r.title, status: r.status, upvotes: r.upvotes, lng: r.lng, lat: r.lat, createdAt: r.created_at },
      obstacle: "obstacle" in out ? out.obstacle : null,
      ...("skipped" in out ? { notAnObstacle: out.skipped } : {}),
    };
  };

  const createReport = async (data: z.infer<typeof reportBodySchema>, upvotes: number) => {
    let report = await client.createReport({
      category: data.category,
      title: REPORT_TITLES[data.category],
      description: data.text || "Αναφορά από την εφαρμογή ION.",
      address: addressFor([data.lng, data.lat]),
      lat: data.lat,
      lng: data.lng,
    });
    for (let i = 0; i < upvotes; i++) report = await client.upvoteReport(report.id);
    await obstacles.refreshAfterWrite();
    return report;
  };

  // --- health ------------------------------------------------------------------

  app.get("/api/health", async (c) => {
    const t = now().getTime();
    if (!health || t - health.at > 30_000) {
      try {
        const info = await client.info();
        health = { at: t, reachable: true, problem: null, llmLeft: info.llm?.calls_left_today ?? null };
      } catch (err) {
        health = { at: t, reachable: false, problem: err instanceof SandboxError ? err.code : "internal", llmLeft: null };
      }
    }
    const snap = obstacles.current();
    return c.json({
      ok: true,
      time: now().toISOString(),
      sandbox: {
        configured: client.configured,
        reachable: health.reachable,
        ...(health.problem ? { problem: health.problem } : {}),
        checkedAt: new Date(health.at).toISOString(),
        rateLimitRemaining: client.rateLimitRemaining,
        llmMessagesLeftToday: health.llmLeft,
      },
      graph: {
        loaded: deps.graphLoaded,
        nodes: routing.graph.nodes.length,
        edges: routing.graph.edges.length,
        builtAt: routing.graph.meta.builtAt || null,
      },
      routing: {
        engine: routing.engine,
        enrichment: {
          loaded: deps.enrichment?.applied ?? false,
          records: deps.enrichment?.edgesCovered ?? 0,
          ...(deps.enrichment?.problem ? { problem: deps.enrichment.problem } : {}),
        },
      },
      obstacles: { count: snap.obstacles.length, stale: snap.stale, updatedAt: snap.updatedAt },
    });
  });

  // --- obstacles and places -------------------------------------------------------

  app.get("/api/obstacles", async (c) => c.json(snapshotBody(await obstacles.snapshot())));

  app.get("/api/places", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const category = (c.req.query("category") ?? "").trim().slice(0, 40);
    const lat = Number(c.req.query("lat"));
    const lng = Number(c.req.query("lng"));
    const near = c.req.query("lat") && c.req.query("lng") && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
    const key = JSON.stringify([q.toLowerCase(), category, near && [lat.toFixed(3), lng.toFixed(3)]]);
    const t = now().getTime();
    let hit = places.get(key);
    let stale = false;
    if (!hit || t - hit.at > 60_000) {
      try {
        const items = await client.searchPois({ ...(q ? { q } : {}), ...(category ? { category } : {}), ...(near ? { near } : {}), size: 20 });
        if (places.size > 200) places.clear();
        hit = { at: t, items };
        places.set(key, hit);
      } catch (err) {
        if (!hit) throw err;
        stale = true;
      }
    }
    const gis = await gisPlaces(city, { q, category, ...(near ? { near } : {}) });
    return c.json({
      sandbox: true,
      stale,
      places: [...hit.items.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        categoryName: p.category_name ?? null,
        lng: p.lng,
        lat: p.lat,
        address: p.address ?? null,
        distanceM: p.distance_km == null ? null : Math.round(p.distance_km * 1000),
        openNow: p.open_now ?? null,
        wheelchairAccessible: p.wheelchair_accessible ?? null,
      })), ...gis.places],
    });
  });

  // --- destination and route -------------------------------------------------------

  app.post("/api/destination", async (c) => {
    const b = await body(c, destinationBodySchema);
    if (!b.ok) return b.res;
    return c.json({ sandbox: true, ...(await destinations.resolve(b.data.text, b.data.location)) });
  });

  app.post("/api/route", async (c) => {
    const b = await body(c, routeBodySchema);
    if (!b.ok) return b.res;
    const at = now();
    const snap = await obstacles.snapshot();
    const active = snap.obstacles.filter((o) => isActive(o, at));
    const from: LngLat = [b.data.from.lng, b.data.from.lat];
    const to: LngLat = [b.data.to.lng, b.data.to.lat];
    const meta = { sandbox: true, engine: routing.engine, graphLoaded: deps.graphLoaded, obstaclesStale: snap.stale };
    if (!deps.graphLoaded) {
      return c.json({ ...meta, error: { code: "graph_not_loaded", message: "The walking graph is not available yet" } }, 503);
    }
    const route = routing.route(from, to, active, at);
    if (!route) {
      return c.json({ ...meta, error: { code: "no_route", message: "No walkable route between these points" } }, 404);
    }
    const baseline = active.length > 0 ? routing.route(from, to, [], at) : route;
    const onRoute = new Set(route.edges);
    const onBaseline = new Set(baseline?.edges ?? []);
    const affecting: Array<Obstacle & { effect: "avoided" | "on_route" }> = [];
    for (const o of active) {
      if (onRoute.has(o.edgeId)) affecting.push({ ...o, effect: "on_route" });
      else if (onBaseline.has(o.edgeId)) affecting.push({ ...o, effect: "avoided" });
    }
    return c.json({
      ...meta,
      route,
      rerouted: affecting.some((o) => o.effect === "avoided"),
      /** The route if there were no obstacles, for comparison. */
      withoutObstacles: baseline ? { lengthM: baseline.lengthM, cost: baseline.cost } : null,
      obstacles: affecting,
    });
  });

  // --- reports -----------------------------------------------------------------------

  app.post("/api/reports", async (c) => {
    const b = await body(c, reportBodySchema);
    if (!b.ok) return b.res;
    return c.json(reportView(await createReport(b.data, 0)), 201);
  });

  app.post("/api/reports/:id/confirm", async (c) => {
    const id = c.req.param("id");
    if (!ID.test(id)) return c.json({ error: { code: "invalid_request", message: "Bad report id" } }, 400);
    const report = await client.upvoteReport(id);
    await obstacles.refreshAfterWrite();
    return c.json(reportView(report));
  });

  // --- citizen missions ---------------------------------------------------------------

  const MISSION_ID = /^[a-z_]{3,24}:[A-Za-z0-9_-]{1,64}$/;
  const answerSchema = z.object({
    answer: z.enum(["yes", "no", "unsure"]),
    /** A random id made on the device. Not a person. */
    participant: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  });
  const placedAnswerSchema = answerSchema.merge(pointSchema);

  const answerMission = async (c: Context, id: string, data: z.infer<typeof answerSchema>, at: LngLat | null) => {
    const current = obstacles.current().obstacles;
    const result = board.answer(id, data.participant, data.answer, at, now(), current);
    if (!result.ok) {
      const status = result.code === "not_found" ? 404 : result.code === "daily_limit" ? 429 : result.code === "too_far" ? 422 : 409;
      return c.json({ error: { code: result.code, message: result.message, ...(result.distanceM !== undefined ? { distanceM: result.distanceM } : {}) } }, status);
    }
    // «Το έχω δει κι εγώ»: a yes on an obstacle check is the City's own confirmation.
    let report: ReturnType<typeof reportView> | null = null;
    if (result.mission.type === "obstacle_check" && data.answer === "yes" && result.mission.reportRef) {
      report = reportView(await client.upvoteReport(result.mission.reportRef));
      await obstacles.refreshAfterWrite();
    }
    if (result.confirmed?.type === "pavement_check") obstacles.remap();
    announce({ type: "mission_answered", missionId: id, missionType: result.mission.type, position: result.mission.position, answers: result.mission.answers } as StreamEvent);
    if (result.confirmed) announce({ type: "map_updated", observation: result.confirmed } as StreamEvent);
    return c.json({ mission: result.mission, pointsEarned: result.pointsEarned, confirmed: result.confirmed, profile: result.profile, ...(report ? { report: report.report, obstacle: report.obstacle, sandbox: true } : {}) });
  };

  app.get("/api/missions", async (c) => {
    const snap = await obstacles.snapshot();
    const lng = Number(c.req.query("lng"));
    const lat = Number(c.req.query("lat"));
    const radius = Math.min(5000, Math.max(50, Number(c.req.query("radius")) || 500));
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
    const summary = board.summary(snap.obstacles);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !c.req.query("lng")) return c.json({ summary, missions: board.all(snap.obstacles).slice(0, limit) });
    return c.json({ summary, missions: board.near([lng, lat], snap.obstacles, radius, limit) });
  });

  app.get("/api/decisions", async c => {
    const feeds = await refreshDecisions();
    const placed = decisions.filter(d => d.edges.length).length;
    return c.json({ total: decisions.length, placed, feeds, decisions: decisions.map(({edges,...d}) => ({...d, edgeIds: edges.map(e=>e.id)})) });
  });
  app.get("/api/missions/observations", (c) => c.json({ observations: board.confirmedObservations() }));

  app.get("/api/missions/profile", (c) => {
    const participant = c.req.query("participant") ?? "";
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(participant)) return c.json({ error: { code: "invalid_request", message: "Bad participant id" } }, 400);
    return c.json(board.profile(participant));
  });

  app.post("/api/missions/:id/answer", async (c) => {
    const id = c.req.param("id");
    if (!MISSION_ID.test(id)) return c.json({ error: { code: "invalid_request", message: "Bad mission id" } }, 400);
    const b = await body(c, placedAnswerSchema);
    if (!b.ok) return b.res;
    return answerMission(c, id, b.data, [b.data.lng, b.data.lat]);
  });

  /** What the points unlock: the City's Athens Card benefits from the sandbox, which calls the programme fictional. */
  app.get("/api/rewards", async (c) => {
    const participant = c.req.query("participant") ?? "";
    const points = /^[A-Za-z0-9_-]{8,64}$/.test(participant) ? board.profile(participant).points : 0;
    if (!benefits || now().getTime() - benefits.at > 10 * 60_000) benefits = { at: now().getTime(), items: await client.listBenefits() };
    return c.json({
      sandbox: true,
      fictional: true,
      note: "Τα προνόμια προέρχονται από τη δοκιμαστική Κάρτα Αθηναίου του sandbox. Δεν αντιστοιχούν σε υπαρκτό πρόγραμμα του Δήμου.",
      points,
      rewards: toRewards(benefits.items, points),
    });
  });

  // --- events ------------------------------------------------------------------------

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: StreamEvent[] = [];
      let wake: (() => void) | null = null;
      let open = true;
      const push = (event: StreamEvent) => {
        queue.push(event);
        wake?.();
      };
      const stopObstacles = obstacles.subscribe(push);
      missionListeners.add(push);
      const unsubscribe = () => {
        stopObstacles();
        missionListeners.delete(push);
      };
      stream.onAbort(() => {
        open = false;
        unsubscribe();
        wake?.();
      });
      try {
        const snap = await obstacles.snapshot();
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snapshotBody(snap)) });
        while (open) {
          const next = queue.shift();
          if (next) {
            await stream.writeSSE({ event: next.type, data: JSON.stringify({ ...next, sandbox: true }) });
            continue;
          }
          const timedOut = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(true), 15_000);
            wake = () => {
              clearTimeout(timer);
              resolve(false);
            };
          });
          wake = null;
          if (timedOut && open) {
            const cur = obstacles.current();
            await stream.writeSSE({ event: "ping", data: JSON.stringify({ at: now().toISOString(), stale: cur.stale }) });
          }
        }
      } finally {
        unsubscribe();
      }
    }),
  );

  // --- demo control ----------------------------------------------------------------------

  const demo = new Hono();
  demo.use("*", async (c, next) => {
    if (deps.demoEnabled === false) return c.json({ sandbox: true, error: { code: "demo_disabled", message: "Demo control is switched off" } }, 403);
    return next();
  });

  demo.post("/obstacle", async (c) => {
    const b = await body(c, reportBodySchema);
    if (!b.ok) return b.res;
    const report = await createReport(b.data, mapping.fullBlockUpvotes);
    return c.json({ ...reportView(report), demo: true }, 201);
  });

  demo.post("/resolve/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID.test(id)) return c.json({ sandbox: true, error: { code: "invalid_request", message: "Bad report id" } }, 400);
    const report = await client.setReportStatus(id, "resolved", "Επιλύθηκε (επίδειξη ION).");
    await obstacles.refreshAfterWrite();
    return c.json({ ...reportView(report), demo: true });
  });

  demo.post("/reset", async (c) => {
    await client.reset();
    await obstacles.refreshAfterWrite();
    return c.json({ sandbox: true, demo: true, reset: true, obstacles: obstacles.current().obstacles.length });
  });

  /** Answers a mission from the stage, without being at the place. Demo only. */
  demo.post("/missions/:id/answer", async (c) => {
    const id = c.req.param("id");
    if (!MISSION_ID.test(id)) return c.json({ sandbox: true, error: { code: "invalid_request", message: "Bad mission id" } }, 400);
    const b = await body(c, answerSchema);
    if (!b.ok) return b.res;
    return answerMission(c, id, b.data, null);
  });

  app.route("/api/demo", demo);

  registerCityRoutes(app, {
    city,
    health: async () => (await app.request("/api/health")).json() as Promise<never>,
    edges: () => routing.graph.edges,
    now,
  });

  return { app, obstacles };
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
}
