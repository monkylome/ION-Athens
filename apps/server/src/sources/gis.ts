/** The City's open GIS layers (GeoServer WFS), connected as places. */
import { z } from "zod";
import { SourceError, fetchJson } from "./http.ts";
import type { SourceAdapter, SourceMeta } from "./types.ts";

const MAPS = "https://maps.cityofathens.gr/geoserver/athens/ows";
const OWS = "http://gis.cityofathens.gr/geoserver/ows";

export const GIS_META: SourceMeta = {
  id: "athens-gis",
  name: "Γεωπύλη Δήμου Αθηναίων (GeoServer)",
  owner: "Δήμος Αθηναίων",
  gives: "Places: ΚΕΠ, hospitals, municipal clinics, metro/tram stations, disabled parking places, drinking fountains",
  kind: "static",
  data: "real",
  terms: "Creative Commons Αναφορά Δημιουργού v.3.0 (CC BY 3.0 GR), Απόφαση Δημοτικού Συμβουλίου 302/2013",
  termsUrl: "http://creativecommons.org/licenses/by/3.0/gr/",
  termsQuoted: true,
  permission: "open licence",
  request: `GET ${MAPS} WFS 1.0.0 (athens workspace); fallback GET ${OWS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=geonode:<layer>&outputFormat=application/json&srsName=EPSG:4326 for kep, nosokomeia, iatreia, stasy2024, pidakes, parking_amea`,
};

export interface GisPlace {
  id: string;
  layer: string;
  name: string;
  category: string;
  categoryName: string;
  lng: number;
  lat: number;
  address: string | null;
  /** For stations: ΜΕΤΡΟ, ΤΡΑΜ or ΟΣΕ. */
  stationType: string | null;
}

type Props = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const join = (...parts: unknown[]) => parts.map(str).filter(Boolean).join(" ") || null;

interface LayerDef {
  layer: string;
  category: string | ((p: Props) => string);
  categoryName: string | ((p: Props) => string);
  name: (p: Props) => string | null;
  address: (p: Props) => string | null;
  keep?: (p: Props) => boolean;
}

export const LAYERS: LayerDef[] = [
  { layer: "kep", category: "kep", categoryName: "ΚΕΠ", name: (p) => str(p["label"]) ?? str(p["name"]), address: (p) => str(p["tax_diefth"]) ?? str(p["diefth"]) },
  { layer: "nosokomeia", category: "hospital", categoryName: "Νοσοκομείο", name: (p) => str(p["Label"]) ?? str(p["label"]), address: (p) => join(p["odos"], p["arith"]) },
  { layer: "iatreia", category: "municipal_clinic", categoryName: "Δημοτικό ιατρείο", name: (p) => str(p["name"]) ?? join(p["type"],p["diefth"]), address: (p) => str(p["tax_diefth"]) ?? str(p["diefth"]) },
  {
    layer: "stasy2024",
    category: (p) => (p["eidos"] === "ΜΕΤΡΟ" ? "metro_station" : p["eidos"] === "ΤΡΑΜ" ? "tram_stop" : "rail_station"),
    categoryName: (p) => (p["eidos"] === "ΜΕΤΡΟ" ? "Σταθμός μετρό" : p["eidos"] === "ΤΡΑΜ" ? "Στάση τραμ" : "Σιδηροδρομικός σταθμός"),
    name: (p) => str(p["label"]) ?? str(p["name"]),
    address: () => null,
  },
  { layer: "pidakes", category: "drinking_fountain", categoryName: "Βρύση πόσιμου νερού", name: (p) => str(p["name"]) ?? str(p["address"]), address: (p) => str(p["address"]), keep: (p) => p["status"] === undefined || p["status"] === "ΕΝΕΡΓΟ" },
  { layer: "parking_amea", category: "disabled_parking", categoryName: "Θέση στάθμευσης ΑμεΑ", name: (p) => "Θέση στάθμευσης ΑμεΑ", address: (p) => join(p["street"], p["number"]) },
];

const featureSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  geometry: z.object({ type: z.string(), coordinates: z.unknown() }).nullable(),
  properties: z.record(z.unknown()).nullish(),
});
const collectionSchema = z.object({ features: z.array(featureSchema) });

function firstPoint(coords: unknown): [number, number] | null {
  let c = coords;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") return [c[0], c[1]];
  return null;
}

export function parseGisLayer(def: LayerDef, raw: unknown): GisPlace[] {
  const endpoint = `GET gis.cityofathens.gr/geoserver/ows (${def.layer})`;
  const parsed = collectionSchema.safeParse(raw);
  if (!parsed.success) throw new SourceError("bad_response", endpoint, "the answer is not a GeoJSON collection");
  const out: GisPlace[] = [];
  parsed.data.features.forEach((f, i) => {
    const p = f.properties ?? {};
    const pt = f.geometry ? firstPoint(f.geometry.coordinates) : null;
    const name = def.name(p);
    if (!pt || !name || (def.keep && !def.keep(p))) return;
    const [lng, lat] = pt;
    if (lng < 22.5 || lng > 25 || lat < 37.5 || lat > 38.5) return;
    out.push({
      id: `gis:${def.layer}:${f.id ?? i}`,
      layer: def.layer,
      name,
      category: typeof def.category === "function" ? def.category(p) : def.category,
      categoryName: typeof def.categoryName === "function" ? def.categoryName(p) : def.categoryName,
      lng,
      lat,
      address: def.address(p),
      stationType: def.layer === "stasy2024" ? str(p["eidos"]) : null,
    });
  });
  return out;
}

/** One adapter per layer, so one layer failing does not hide the others. The whole layer is read; they are small. */
export function gisAdapter(def: LayerDef): SourceAdapter<GisPlace> {
  return {
    meta: GIS_META,
    part: def.layer,
    ttlMs: 24 * 3600_000,
    timeoutMs: 6000,
    async fetch(_q, env) {
      const layer = def.layer === "stasy2024" ? "MetroStations1-2-3" : def.layer;
      const primary = `${MAPS}?service=WFS&version=1.0.0&request=GetFeature&typeName=athens:${layer}&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=2000`;
      try {
        return parseGisLayer(def, await fetchJson(env, primary, `Athens Maps (${layer})`));
      } catch {
        // Legacy WFS provides the same category under the geonode workspace.
      }
      const url = `${OWS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=geonode:${def.layer}&outputFormat=application/json&srsName=EPSG:4326&count=2000`;
      return parseGisLayer(def, await fetchJson(env, url, `GET gis.cityofathens.gr/geoserver/ows (${def.layer})`));
    },
  };
}
