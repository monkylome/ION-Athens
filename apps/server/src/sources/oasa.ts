/** OASA telematics: nearest stops to a point, arrivals at a stop, and the lines of a stop. */
import { z } from "zod";
import { SourceError, fetchJson } from "./http.ts";
import type { SourceAdapter, SourceMeta } from "./types.ts";

const API = "https://telematics.oasa.gr/api/";
const TERMS_URL = "https://telematics.oasa.gr/terms.php";

export const OASA_META: SourceMeta = {
  id: "oasa-telematics",
  name: "ΟΑΣΑ telematics: στάσεις και αφίξεις",
  owner: "Οργανισμός Αστικών Συγκοινωνιών Αθηνών (ΟΑΣΑ)",
  gives: "Bus and trolley stops near a point, with the minutes to the next arrivals",
  kind: "live",
  data: "real",
  terms: "διατίθενται στο κοινό μόνο για προσωπική χρήση",
  termsUrl: TERMS_URL,
  termsQuoted: true,
  permission: "pending",
  request: `GET ${API}?act=getClosestStops (stops near a point), ?act=getStopArrivals (arrivals), ?act=webRoutesForStop (lines of a stop)`,
};

export interface BusStop {
  code: number;
  id: string | null;
  name: string;
  street: string | null;
  lng: number;
  lat: number;
}

export interface BusArrival {
  stopCode: number;
  routeCode: number;
  vehicleCode: number;
  /** Minutes until the vehicle arrives; 0 means arriving now. */
  minutes: number;
}

export interface StopRoute {
  routeCode: number;
  lineId: string | null;
  lineDescr: string | null;
  routeDescr: string | null;
}

const stopSchema = z.object({
  StopCode: z.coerce.number(),
  StopID: z.string().nullish(),
  StopDescr: z.string(),
  StopStreet: z.string().nullish(),
  StopLat: z.coerce.number().min(-90).max(90),
  StopLng: z.coerce.number().min(-180).max(180),
});
const arrivalSchema = z.object({ route_code: z.coerce.number(), veh_code: z.coerce.number(), btime2: z.coerce.number() });
const routeSchema = z.object({ RouteCode: z.coerce.number(), LineID: z.string().nullish(), LineDescr: z.string().nullish(), RouteDescr: z.string().nullish() });

function rows<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, endpoint: string): T[] {
  // The service answers `[]` or null when there is nothing; anything else that is not a list is a change of shape.
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new SourceError("bad_response", endpoint, "the answer is not a list");
  const out: T[] = [];
  for (const row of raw) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  if (raw.length > 0 && out.length === 0) throw new SourceError("bad_response", endpoint, "no row has the documented fields");
  return out;
}

export interface Point {
  lng: number;
  lat: number;
}

/** The 20 stops nearest to a point. `p1` is the latitude and `p2` the longitude (confirmed by experiment). */
export const oasaClosestStops: SourceAdapter<BusStop, Point> = {
  meta: OASA_META,
  part: "closest stops",
  ttlMs: 6 * 3600_000,
  timeoutMs: 8000,
  key: (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`,
  probe: { lng: 23.7346, lat: 37.9755 },
  async fetch(p, env) {
    const endpoint = "GET telematics.oasa.gr/api/?act=getClosestStops";
    const raw = await fetchJson(env, `${API}?act=getClosestStops&p1=${p.lat}&p2=${p.lng}`, endpoint);
    return rows(stopSchema, raw, endpoint).map((r) => ({ code: r.StopCode, id: r.StopID ?? null, name: r.StopDescr, street: r.StopStreet ?? null, lng: r.StopLng, lat: r.StopLat }));
  },
};

export const oasaArrivals: SourceAdapter<BusArrival, number> = {
  meta: OASA_META,
  part: "arrivals",
  ttlMs: 20_000,
  timeoutMs: 6000,
  key: (code) => String(code),
  probe: 12789,
  async fetch(code, env) {
    const endpoint = "GET telematics.oasa.gr/api/?act=getStopArrivals";
    const raw = await fetchJson(env, `${API}?act=getStopArrivals&p1=${code}`, endpoint);
    return rows(arrivalSchema, raw, endpoint)
      .map((r) => ({ stopCode: code, routeCode: r.route_code, vehicleCode: r.veh_code, minutes: r.btime2 }))
      .sort((a, b) => a.minutes - b.minutes);
  },
};

export const oasaStopRoutes: SourceAdapter<StopRoute, number> = {
  meta: OASA_META,
  part: "lines of a stop",
  ttlMs: 24 * 3600_000,
  timeoutMs: 6000,
  key: (code) => String(code),
  async fetch(code, env) {
    const endpoint = "GET telematics.oasa.gr/api/?act=webRoutesForStop";
    const raw = await fetchJson(env, `${API}?act=webRoutesForStop&p1=${code}`, endpoint);
    return rows(routeSchema, raw, endpoint).map((r) => ({ routeCode: r.RouteCode, lineId: r.LineID ?? null, lineDescr: r.LineDescr ?? null, routeDescr: r.RouteDescr ?? null }));
  },
};
