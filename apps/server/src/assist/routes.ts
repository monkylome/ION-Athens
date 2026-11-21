/** The HTTP side of the help feature, mounted at /api/assist. */
import type { LngLat } from "@ion/core";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { distanceM } from "../geo.ts";
import type { Profile } from "../missions/missions.ts";
import { type HubOptions, RoomHub } from "./hub.ts";
import { type AssistOptions, AssistService, MARK_KINDS, type MarkKind } from "./service.ts";

export interface AssistConfig {
  now: () => Date;
  areaOf: (p: LngLat) => string;
  award: (participant: string, points: number) => Profile;
  profile: (participant: string) => Profile;
  announce: (event: { type: string; [k: string]: unknown }) => void;
  fileReport: (input: { lng: number; lat: number; text: string }) => Promise<{ id: string } | null>;
  options?: Partial<AssistOptions> & { hub?: Partial<HubOptions>; heartbeatMs?: number };
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM = /^[A-Za-z0-9_-]{1,48}$/;
const lng = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);
const device = z.string().regex(ID);

const createSchema = z.object({ device, lng, lat, text: z.string().trim().max(140).optional() });
const deviceSchema = z.object({ device });
const markSchema = z.object({ device, kind: z.enum(Object.keys(MARK_KINDS) as [MarkKind, ...MarkKind[]]), lng, lat });
const messageSchema = z.object({ from: z.string().regex(ID), to: z.string().regex(ID).optional(), data: z.unknown() });
const leaveSchema = z.object({ member: z.string().regex(ID) });

export function createAssist(cfg: AssistConfig) {
  const hub = new RoomHub(cfg.options?.hub, () => cfg.now().getTime());
  const service = new AssistService({ ...cfg, hub, ...(cfg.options ? { opts: cfg.options } : {}) });
  const heartbeatMs = cfg.options?.heartbeatMs ?? 15_000;
  const router = new Hono();

  const parse = async <T>(c: Context, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<{ ok: true; data: T } | { ok: false; res: Response }> => {
    let text: string;
    try {
      text = await c.req.text();
    } catch {
      text = "";
    }
    if (text.length > (cfg.options?.hub?.maxMessageBytes ?? 128 * 1024) + 1024) {
      return { ok: false, res: c.json({ error: { code: "too_large", message: "Το μήνυμα είναι πολύ μεγάλο." } }, 413) };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, res: c.json({ error: { code: "invalid_json", message: "The body must be JSON" } }, 400) };
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) return { ok: true, data: parsed.data };
    const message = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return { ok: false, res: c.json({ error: { code: "invalid_request", message } }, 400) };
  };
  const failure = (c: Context, f: { status: number; code: string; message: string }) =>
    c.json({ error: { code: f.code, message: f.message } }, f.status as 400);

  // --- help requests ---------------------------------------------------------

  router.post("/requests", async (c) => {
    const b = await parse(c, createSchema);
    if (!b.ok) return b.res;
    const made = service.create(b.data.device, [b.data.lng, b.data.lat], b.data.text ?? "");
    if (!made.ok) return failure(c, made);
    const view = service.status(made.request.id, b.data.device);
    return c.json({ request: view.ok ? view.request : null, waitS: Math.round(service.opts.waitMs / 1000) }, 201);
  });

  router.get("/requests", (c) => {
    const plng = Number(c.req.query("lng"));
    const plat = Number(c.req.query("lat"));
    if (!c.req.query("lng") || !c.req.query("lat") || !Number.isFinite(plng) || !Number.isFinite(plat)) {
      return c.json({ error: { code: "invalid_request", message: "Χρειάζεται θέση (lng, lat)." } }, 400);
    }
    const radius = Math.min(5000, Math.max(100, Number(c.req.query("radius")) || 2000));
    return c.json({ requests: service.nearby([plng, plat], radius) });
  });

  router.get("/requests/:id", (c) => {
    const dev = c.req.query("device") ?? "";
    if (!ID.test(dev)) return c.json({ error: { code: "invalid_request", message: "Bad device id" } }, 400);
    const r = service.status(c.req.param("id"), dev);
    return r.ok ? c.json({ request: r.request }) : failure(c, r);
  });

  router.post("/requests/:id/accept", async (c) => {
    const b = await parse(c, deviceSchema);
    if (!b.ok) return b.res;
    const r = service.accept(c.req.param("id"), b.data.device);
    return r.ok ? c.json({ request: r.request }) : failure(c, r);
  });

  router.post("/requests/:id/connected", async (c) => {
    const b = await parse(c, deviceSchema);
    if (!b.ok) return b.res;
    const r = service.connected(c.req.param("id"), b.data.device);
    return r.ok ? c.json({ request: r.request }) : failure(c, r);
  });

  router.post("/requests/:id/end", async (c) => {
    const b = await parse(c, deviceSchema);
    if (!b.ok) return b.res;
    const r = service.end(c.req.param("id"), b.data.device);
    return r.ok ? c.json({ request: r.request }) : failure(c, r);
  });

  router.post("/requests/:id/marks", async (c) => {
    const b = await parse(c, markSchema);
    if (!b.ok) return b.res;
    const r = await service.mark(c.req.param("id"), b.data.device, b.data.kind, [b.data.lng, b.data.lat]);
    return r.ok ? c.json(r, 201) : failure(c, r);
  });

  router.get("/observations", (c) => c.json({ observations: service.observationsList() }));

  // --- rooms --------------------------------------------------------------------

  router.get("/rooms/:room/events", (c) => {
    const room = c.req.param("room");
    const member = c.req.query("member") ?? "";
    if (!ROOM.test(room) || !ID.test(member)) return c.json({ error: { code: "invalid_request", message: "Bad room or member id" } }, 400);
    // A help room exists only because a request opened it.
    if (room.startsWith("assist-") && !hub.has(room)) return c.json({ error: { code: "not_found", message: "Η κλήση έχει τελειώσει." } }, 404);

    const queue: Array<{ event: string; data: unknown }> = [];
    let wake: (() => void) | null = null;
    let open = true;
    const deliver = (e: { event: string; data: unknown }) => {
      if (queue.length >= hub.opts.maxQueue) throw new Error("queue full");
      queue.push(e);
      wake?.();
    };
    const joined = hub.join(room, member, deliver, () => {
      open = false;
      wake?.();
    });
    if (!joined.ok) return failure(c, { status: joined.code === "room_full" ? 409 : 503, code: joined.code, message: joined.message });

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        open = false;
        hub.leave(room, member, "left", deliver);
        wake?.();
      });
      try {
        while (open || queue.length > 0) {
          const next = queue.shift();
          if (next) {
            await stream.writeSSE({ event: next.event, data: JSON.stringify(next.data) });
            continue;
          }
          const timedOut = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(true), heartbeatMs);
            wake = () => {
              clearTimeout(timer);
              resolve(false);
            };
          });
          wake = null;
          if (timedOut && open) {
            await stream.writeSSE({ event: "ping", data: JSON.stringify({ at: cfg.now().toISOString() }) });
            hub.touch(room, member);
            hub.sweep();
            service.sweep();
          }
        }
      } finally {
        hub.leave(room, member, "left", deliver);
      }
    });
  });

  router.post("/rooms/:room/messages", async (c) => {
    const room = c.req.param("room");
    if (!ROOM.test(room)) return c.json({ error: { code: "invalid_request", message: "Bad room id" } }, 400);
    const b = await parse(c, messageSchema);
    if (!b.ok) return b.res;
    const r = hub.send(room, b.data.from, b.data.data, b.data.to);
    if (r.ok) return c.json({ delivered: r.delivered });
    const status = r.code === "too_large" ? 413 : r.code === "rate_limited" ? 429 : r.code === "not_member" ? 403 : 404;
    return failure(c, { status, code: r.code, message: r.message });
  });

  router.post("/rooms/:room/leave", async (c) => {
    const room = c.req.param("room");
    if (!ROOM.test(room)) return c.json({ error: { code: "invalid_request", message: "Bad room id" } }, 400);
    const b = await parse(c, leaveSchema);
    if (!b.ok) return b.res;
    hub.leave(room, b.data.member);
    return c.json({ left: true });
  });

  return { router, hub, service };
}

type Named = Array<{ name: string; points: LngLat[] }>;
const namedCache = new WeakMap<object, Named>();

/** The name of the nearest named street in the graph (within 400 m); never a position. */
export function areaName(routing: { graph: { edges: ReadonlyArray<{ name?: string; geometry: LngLat[] }> } }, p: LngLat): string {
  const edges = routing.graph.edges;
  let named = namedCache.get(edges);
  if (!named) {
    named = edges.filter((e) => e.name && e.geometry.length).map((e) => ({ name: e.name!, points: e.geometry }));
    namedCache.set(edges, named);
  }
  const box = 0.006;
  let best: string | null = null;
  let bestD = 400;
  for (const e of named) {
    for (const q of e.points) {
      if (Math.abs(q[0] - p[0]) > box || Math.abs(q[1] - p[1]) > box) continue;
      const d = distanceM(p, q);
      if (d < bestD) {
        bestD = d;
        best = e.name;
      }
    }
  }
  return best ?? "Κοντά σας";
}
