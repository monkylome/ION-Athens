/** `/api/sources`, `/api/context`, `/api/announcements` and the GIS places of `/api/places`. */
import type { Hono } from "hono";
import { distanceM } from "../geo.ts";
import { fold } from "./text.ts";
import { DEFAULT_RADIUS_M, MAX_RADIUS_M, buildContext } from "./context.ts";
import type { GisPlace } from "./gis.ts";
import { type CitySources, type OwnHealth, cityRows, ownRows } from "./registry.ts";
import { StreetIndex, type NamedEdge } from "./streets.ts";

export interface CityRouteDeps {
  city: CitySources;
  /** The existing health information, as `/api/health` serves it. */
  health: () => Promise<OwnHealth>;
  edges: () => readonly NamedEdge[];
  now: () => Date;
}

const bad = (message: string) => ({ error: { code: "invalid_request", message } });

export function registerCityRoutes(app: Hono, deps: CityRouteDeps): void {
  let streets: { edges: readonly NamedEdge[]; index: StreetIndex } | null = null;
  const streetIndex = () => {
    const edges = deps.edges();
    if (!streets || streets.edges !== edges) streets = { edges, index: new StreetIndex(edges) };
    return streets.index;
  };

  app.get("/api/sources", async (c) => {
    // Ask every source that is cold or old, so "answering" is true now; each ask has its own timeout.
    if (c.req.query("probe") !== "false") await Promise.all(deps.city.parts.map((p) => p.warm()));
    const health = await deps.health().catch(() => ({}) as OwnHealth);
    const sources = [...ownRows(health), ...cityRows(deps.city)];
    return c.json({
      generatedAt: deps.now().toISOString(),
      counts: {
        total: sources.length,
        answering: sources.filter((s) => s.answering === true).length,
        permissionPending: sources.filter((s) => s.permission === "pending").length,
        testData: sources.filter((s) => s.data === "test").length,
      },
      sources,
    });
  });

  app.get("/api/context", async (c) => {
    const lng = Number(c.req.query("lng"));
    const lat = Number(c.req.query("lat"));
    if (!c.req.query("lng") || !c.req.query("lat") || !Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      return c.json(bad("lng and lat are required numbers"), 400);
    }
    const rawRadius = c.req.query("radius");
    const radius = rawRadius === undefined || rawRadius === "" ? DEFAULT_RADIUS_M : Number(rawRadius);
    if (!Number.isFinite(radius) || radius <= 0) return c.json(bad("radius must be a number of metres above 0"), 400);
    const radiusM = Math.min(MAX_RADIUS_M, Math.max(20, radius));
    return c.json(await buildContext(deps.city, streetIndex(), { lng, lat, radiusM }, deps.now()));
  });

  app.get("/api/announcements", async (c) => {
    const snap = await deps.city.announcements.get(undefined, 4000);
    const index = streetIndex();
    return c.json({
      source: "athens-announcements",
      fetchedAt: snap.fetchedAt,
      stale: snap.stale,
      ...(snap.problem ? { problem: snap.problem } : {}),
      announcements: snap.records.map((a) => ({
        id: a.id,
        title: a.title,
        date: a.date,
        link: a.link,
        matchedStreets: index.match(`${a.title} ${a.text}`),
        hint: true,
        closesStreet: false,
      })),
    });
  });
}

export interface PlaceQuery {
  q: string;
  category: string;
  near?: { lat: number; lng: number };
}

/** Places from the City's GIS layers for `/api/places`. Never throws; layers that fail are left out. */
export async function gisPlaces(city: CitySources, query: PlaceQuery) {
  const snaps = await Promise.all(city.gis.map((g) => g.get(undefined, 3000)));
  const want = fold(query.q);
  let items: Array<GisPlace & { distanceM: number | null }> = snaps
    .flatMap((s) => s.records)
    .filter((p) => !query.category || p.category === query.category)
    .filter((p) => !want || fold(`${p.name} ${p.address ?? ""} ${p.categoryName}`).includes(want))
    .map((p) => ({ ...p, distanceM: query.near ? Math.round(distanceM([query.near.lng, query.near.lat], [p.lng, p.lat])) : null }));
  // Without a text, a category or a position there is nothing to select by; the sandbox answers alone.
  if (!want && !query.category && !query.near) items = [];
  items.sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
  return {
    stale: snaps.some((s) => s.stale),
    places: items.slice(0, 10).map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      categoryName: p.categoryName,
      lng: p.lng,
      lat: p.lat,
      address: p.address,
      distanceM: p.distanceM,
      openNow: null,
      wheelchairAccessible: null,
      source: "athens-gis",
      sandbox: false,
    })),
  };
}
