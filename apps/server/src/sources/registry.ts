/** All city sources, built once from a fetch function, and the registry the jury reads. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { stationsAdapter, entrancesAdapter, type Station, type LiftEntrance } from "./metro.ts";
import { weatherAdapter, type parseWeather } from "./weather.ts";
import { decisionAdapter, type Decision } from "./diavgeia.ts";
import { CachedSource } from "./cache.ts";
import { type GisPlace, LAYERS, gisAdapter } from "./gis.ts";
import { announcementsAdapter, type Announcement } from "./announcements.ts";
import { hospitalsAdapter, type DutyDocument } from "./hospitals.ts";
import { type BusArrival, type BusStop, type Point, type StopRoute, oasaArrivals, oasaClosestStops, oasaStopRoutes } from "./oasa.ts";
import { type RouteNote, routesAdapter } from "./accessible-routes.ts";
import { type MetroStationLifts, stasyAdapter } from "./stasy.ts";
import { type TreePlanting, treesAdapter } from "./trees.ts";
import type { PartStatus, SourceAdapter, SourceMeta } from "./types.ts";

export interface CitySourcesOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  /** Folder with the extracted Accessible Routes files; null switches the source off. */
  routesDir?: string | null;
  retryDelayMs?: number;
  readFile?: (path: string) => Promise<string>;
  log?: (line: string) => void;
}

export const DEFAULT_ROUTES_DIR = fileURLToPath(new URL("../../../../data-local/accessible-routes/", import.meta.url));

export interface CitySources {
  stations: CachedSource<Station>;
  entrances: CachedSource<LiftEntrance>;
  weather: CachedSource<ReturnType<typeof parseWeather>>;
  decisions: CachedSource<Decision>[];
  lifts: CachedSource<MetroStationLifts>;
  stops: CachedSource<BusStop, Point>;
  arrivals: CachedSource<BusArrival, number>;
  stopRoutes: CachedSource<StopRoute, number>;
  notes: CachedSource<RouteNote>;
  duty: CachedSource<DutyDocument>;
  announcements: CachedSource<Announcement>;
  trees: CachedSource<TreePlanting>;
  gis: Array<CachedSource<GisPlace>>;
  /** Every cached request, for the registry. */
  parts: Array<CachedSource<any, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function createCitySources(opts: CitySourcesOptions = {}): CitySources {
  const env = { fetch: opts.fetch ?? fetch, now: opts.now ?? (() => new Date()), retryDelayMs: opts.retryDelayMs ?? 300 };
  const log = opts.log ?? (() => undefined);
  const make = <R, Q = void>(adapter: SourceAdapter<R, Q>) => new CachedSource<R, Q>(adapter, env, log);
  const lifts = make(stasyAdapter);
  const stops = make(oasaClosestStops);
  const arrivals = make(oasaArrivals);
  const stopRoutes = make(oasaStopRoutes);
  const notes = make(routesAdapter(opts.routesDir === undefined ? DEFAULT_ROUTES_DIR : opts.routesDir, opts.readFile));
  const duty = make(hospitalsAdapter);
  const announcements = make(announcementsAdapter);
  const trees = make(treesAdapter);
  const gis = LAYERS.map((def) => make(gisAdapter(def)));
  const decisions = [make(decisionAdapter(true)), make(decisionAdapter(false))];
  const stations = make(stationsAdapter(opts.readFile));
  const entrances = make(entrancesAdapter);
  const weather = make(weatherAdapter);
  return { stations, entrances, weather, decisions, lifts, stops, arrivals, stopRoutes, notes, duty, announcements, trees, gis, parts: [stations, entrances, weather, ...decisions, lifts, stops, arrivals, stopRoutes, notes, duty, announcements, trees, ...gis] };
}

/** A registry whose sources never reach the network: used when the app is built without sources. */
export function offlineCitySources(): CitySources {
  return createCitySources({ fetch: (async () => Promise.reject(new TypeError("city sources are switched off"))) as typeof fetch, routesDir: null, retryDelayMs: 0 });
}

// --- the registry ----------------------------------------------------------------------

export interface SourceRow extends SourceMeta {
  /** When ION last got an answer from the source; null if never. */
  lastFetched: string | null;
  records: number | null;
  /** Is it answering now: the last attempt worked. Null before any attempt. */
  answering: boolean | null;
  /** True when what ION serves is an older copy because the source stopped answering. */
  stale: boolean;
  problem: string | null;
}

export function cityRows(city: CitySources): SourceRow[] {
  const groups = new Map<string, Array<{ meta: SourceMeta; status: PartStatus }>>();
  for (const part of city.parts) {
    const list = groups.get(part.meta.id) ?? [];
    list.push({ meta: part.meta, status: part.status() });
    groups.set(part.meta.id, list);
  }
  return [...groups.values()].map((parts) => {
    const meta = parts[0]!.meta;
    const statuses = parts.map((p) => p.status);
    const tried = statuses.filter((s) => s.ok !== null);
    const failed = statuses.filter((s) => s.ok === false);
    const last = statuses.map((s) => s.lastSuccessAt).filter((x): x is string => x !== null).sort().at(-1) ?? null;
    const answering = tried.length === 0 ? null : failed.length === 0;
    return {
      ...meta,
      lastFetched: last,
      records: last === null && tried.length === 0 ? null : statuses.reduce((n, s) => n + s.records, 0),
      answering,
      stale: answering === false && last !== null,
      problem: failed.length ? failed.map((s) => s.problem).filter(Boolean).join("; ") : null,
    };
  });
}

export const SANDBOX_META: SourceMeta = {
  id: "ion-sandbox",
  name: "AthensGov Sandbox",
  owner: "Δήμος Αθηναίων (AthensGov Sandbox API)",
  gives: "Citizen reports and municipal projects (turned into obstacles), points of interest, the assistant for destinations",
  kind: "live",
  data: "test",
  terms: "Δεδομένα δοκιμής για το hackathon· κάθε εγγραφή είναι συνθετική.",
  termsUrl: null,
  termsQuoted: false,
  permission: "not needed",
  request: "GET /v1/requests, /v1/projects.geojson, /v1/pois, /v1/sandbox and the assistant calls, with the key kept on the server",
};

export const OSM_META: SourceMeta = {
  id: "openstreetmap",
  name: "OpenStreetMap: το πεζοδρομικό δίκτυο",
  owner: "OpenStreetMap contributors",
  gives: "The walking graph of central Athens (streets, footways, crossings, steps) that routes are computed on",
  kind: "static",
  data: "real",
  terms: "© OpenStreetMap contributors (ODbL 1.0)",
  termsUrl: "https://www.openstreetmap.org/copyright",
  termsQuoted: true,
  permission: "open licence",
  request: "Built offline from the OpenStreetMap API 0.6 into data/athens-centre.graph.json; no request while the server runs",
};

export const WALKABLE_META: SourceMeta = {
  id: "walkable-athens",
  name: "Walkable Athens: ποιότητα πεζοδρομίων",
  owner: "Δήμος Αθηναίων και Μονάδα Βιώσιμης Κινητικότητας ΕΜΠ (walkable.cityofathens.gr)",
  gives: "Pavement and crossing attributes that enrich the walking graph",
  kind: "static",
  data: "real",
  terms: "(c) NTUA, 2023. All rights reserved.",
  termsUrl: "https://walkable.cityofathens.gr/",
  termsQuoted: true,
  permission: "pending",
  request: "Extracted offline into data-local/walkable-athens and joined to the graph; no request while the server runs",
};

/** The parts of `/api/health` the registry reads. Anything missing counts as unknown. */
export interface OwnHealth {
  sandbox?: { configured?: boolean; reachable?: boolean; problem?: string; checkedAt?: string };
  graph?: { loaded?: boolean; edges?: number; builtAt?: string | null };
  obstacles?: { count?: number; updatedAt?: string | null };
  routing?: { engine?: string; enrichment?: { loaded?: boolean; records?: number; loadedAt?: string } };
}

export function ownRows(h: OwnHealth): SourceRow[] {
  const rows: SourceRow[] = [];
  const sb = h.sandbox;
  rows.push({
    ...SANDBOX_META,
    lastFetched: h.obstacles?.updatedAt ?? null,
    records: h.obstacles?.count ?? null,
    answering: sb?.configured === false ? false : (sb?.reachable ?? null),
    stale: false,
    problem: sb?.configured === false ? "not_configured" : (sb?.problem ?? null),
  });
  rows.push({
    ...OSM_META,
    lastFetched: h.graph?.builtAt ?? null,
    records: h.graph?.edges ?? null,
    answering: h.graph?.loaded ?? null,
    stale: false,
    problem: h.graph?.loaded === false ? "graph file not loaded" : null,
  });
  const walk = h.routing?.enrichment;
  if (walk?.loaded) rows.push({ ...WALKABLE_META, lastFetched: walk.loadedAt ?? null, records: walk.records ?? null, answering: true, stale: false, problem: null });
  return rows;
}
