/** Tree plantings of the City (athenstrees). */
import { z } from "zod";
import { SourceError, fetchJson } from "./http.ts";
import type { SourceAdapter, SourceMeta } from "./types.ts";

const URL_ = "https://athenstrees.cityofathens.gr/api/public/map-locations";

export const TREES_META: SourceMeta = {
  id: "athens-trees",
  name: "Δενδροφυτεύσεις Δήμου Αθηναίων (Athens Trees)",
  owner: "Δήμος Αθηναίων (athenstrees.cityofathens.gr)",
  gives: "Points where the City planted trees, a hint of works on a pavement; the answer has no dates",
  kind: "daily",
  data: "real",
  terms: "Δεν βρέθηκε δήλωση άδειας χρήσης· το ανώνυμο endpoint το χρησιμοποιεί η δημόσια σελίδα.",
  termsUrl: "https://athenstrees.cityofathens.gr/",
  termsQuoted: false,
  permission: "pending",
  request: `GET ${URL_} (JSON, about 2.5 MB, filtered here)`,
};

export interface TreePlanting {
  id: number;
  description: string;
  lng: number;
  lat: number;
}

const R = 6378137;

/** EPSG:3857 metres to lng/lat. */
export function fromWebMercator(x: number, y: number): [lng: number, lat: number] {
  return [((x / R) * 180) / Math.PI, ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI];
}

const rowSchema = z.object({ map_location_id: z.number(), description: z.string().nullish(), latitude: z.number(), longitude: z.number() });

/** The field names are swapped: `latitude` is the X coordinate and `longitude` the Y coordinate. */
export function parseTrees(raw: unknown): TreePlanting[] {
  const endpoint = "GET athenstrees.cityofathens.gr/api/public/map-locations";
  if (!Array.isArray(raw)) throw new SourceError("bad_response", endpoint, "the answer is not a list");
  const out: TreePlanting[] = [];
  for (const row of raw) {
    const r = rowSchema.safeParse(row);
    if (!r.success) continue;
    const [lng, lat] = fromWebMercator(r.data.latitude, r.data.longitude);
    // Attica only; anything else means the swap was undone or the projection changed.
    if (lng < 22.5 || lng > 25 || lat < 37.5 || lat > 38.5) continue;
    out.push({ id: r.data.map_location_id, description: r.data.description?.trim() ?? "", lng, lat });
  }
  if (raw.length > 0 && out.length === 0) throw new SourceError("bad_response", endpoint, "no point falls in Attica; the coordinate layout may have changed");
  return out;
}

export const treesAdapter: SourceAdapter<TreePlanting> = {
  meta: TREES_META,
  ttlMs: 6 * 3600_000,
  timeoutMs: 20_000,
  async fetch(_q, env) {
    return parseTrees(await fetchJson(env, URL_, "GET athenstrees.cityofathens.gr/api/public/map-locations"));
  },
};
