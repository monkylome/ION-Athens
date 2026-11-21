/**
 * Overpass API access. Only the query is sent: no project or personal details.
 */

export type Tags = Record<string, string>;

export interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}
export interface OsmWay {
  type: "way";
  id: number;
  nodes?: number[];
  tags?: Tags;
  center?: { lat: number; lon: number };
}
export interface OsmRelation {
  type: "relation";
  id: number;
  members?: { type: "node" | "way" | "relation"; ref: number; role: string }[];
  tags?: Tags;
  center?: { lat: number; lon: number };
}
export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface OverpassResponse {
  version?: number;
  generator?: string;
  osm3s?: { timestamp_osm_base?: string; copyright?: string };
  elements: OsmElement[];
}

/** [west, south, east, north] */
export type Bbox = [number, number, number, number];

export const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export const USER_AGENT = "ion-athens-hackathon-graph-builder";

export function buildQuery(bbox: Bbox, serverTimeoutS = 120): string {
  const [w, s, e, n] = bbox;
  return `[out:json][timeout:${serverTimeoutS}][bbox:${s},${w},${n},${e}];
way["highway"]->.hw;
rel["type"="multipolygon"]["highway"~"^(pedestrian|footway)$"]->.hwrel;
way(r.hwrel)->.hwrelways;
(.hw; .hwrelways;)->.allways;
.hwrel out body qt;
.allways out body qt;
node(w.allways);
out body qt;
(
  node["railway"="subway_entrance"];
  nwr["railway"~"^(station|halt)$"];
  nwr["public_transport"="station"];
  nwr["amenity"~"^(townhall|hospital|police|theatre)$"];
  nwr["office"="government"];
  nwr["tourism"="museum"];
  nwr["name"~"Ηρώδ|Ηρωδ"];
  nwr["name:en"~"Herod",i];
  nwr["place"="square"];
)->.poi;
.poi out body center qt;
way(r.poi)->.poimembers;
.poimembers out skel qt;
(way.poi; .poimembers;)->.poiways;
node(w.poiways)["entrance"];
out body qt;
`;
}

async function postQuery(endpoint: string, query: string, timeoutMs: number): Promise<OverpassResponse> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    body: "data=" + encodeURIComponent(query),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Overpass reports "too busy" and runtime errors as HTML or XML with status 200.
    throw new Error(`response is not JSON: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  }
  const response = parsed as OverpassResponse & { remark?: string };
  if (!Array.isArray(response.elements)) throw new Error("response has no elements array");
  if (response.remark) throw new Error(`Overpass remark: ${response.remark}`);
  if (response.elements.length === 0) throw new Error("response has zero elements");
  return response;
}

export interface FetchResult {
  response: OverpassResponse;
  endpoint: string;
  attempts: string[];
}

/** Tries each endpoint twice (one retry) before moving to the next. */
export async function fetchOverpass(
  query: string,
  timeoutMs: number,
  endpoints: string[] = ENDPOINTS,
  log: (msg: string) => void = () => {},
): Promise<FetchResult> {
  const attempts: string[] = [];
  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      try {
        log(`Overpass: ${endpoint} (attempt ${attempt}, timeout ${Math.round(timeoutMs / 1000)} s)`);
        const response = await postQuery(endpoint, query, timeoutMs);
        attempts.push(`${endpoint} attempt ${attempt}: ok in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        return { response, endpoint, attempts };
      } catch (err) {
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        attempts.push(`${endpoint} attempt ${attempt}: failed after ${((Date.now() - started) / 1000).toFixed(1)} s (${reason})`);
        log(`  failed: ${reason}`);
        if (attempt === 1) await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  throw new Error("Overpass could not be reached:\n  " + attempts.join("\n  "));
}

/** Index of a raw response. An element can appear in several output blocks: the parts are merged. */
export interface OsmIndex {
  nodes: Map<number, OsmNode>;
  ways: Map<number, OsmWay>;
  relations: Map<number, OsmRelation>;
}

export function indexElements(response: OverpassResponse): OsmIndex {
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations = new Map<number, OsmRelation>();
  for (const el of response.elements) {
    if (el.type === "node") {
      const prev = nodes.get(el.id);
      nodes.set(el.id, prev ? { ...prev, ...el, tags: el.tags ?? prev.tags } : el);
    } else if (el.type === "way") {
      const prev = ways.get(el.id);
      ways.set(
        el.id,
        prev
          ? { ...prev, ...el, tags: el.tags ?? prev.tags, nodes: el.nodes ?? prev.nodes, center: el.center ?? prev.center }
          : el,
      );
    } else {
      const prev = relations.get(el.id);
      relations.set(el.id, prev ? { ...prev, ...el, tags: el.tags ?? prev.tags, center: el.center ?? prev.center } : el);
    }
  }
  return { nodes, ways, relations };
}
