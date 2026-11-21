/**
 * Download through the main OpenStreetMap API (api/0.6/map).
 *
 * The API returns everything inside a box and refuses boxes with more than
 * 50,000 nodes, so the area is fetched as small tiles, one request at a time,
 * and merged by element id. Only the bounding box is sent.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { USER_AGENT, type Bbox, type OsmElement, type OsmIndex, type OverpassResponse } from "./overpass.ts";

export const OSM_API = "https://api.openstreetmap.org/api/0.6/map.json";

export interface TileInfo {
  file: string;
  bbox: Bbox;
  elements: number;
}

export interface OsmApiResult {
  elements: OsmElement[];
  tiles: TileInfo[];
  attempts: string[];
  generator: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (x: number) => x.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");

class TooManyNodes extends Error {}

/** Keeps the map data and drops the editing metadata (user, uid, changeset, version, timestamp). */
function strip(el: Record<string, unknown>): OsmElement | undefined {
  const tags = el.tags as Record<string, string> | undefined;
  if (el.type === "node") {
    return { type: "node", id: el.id as number, lat: el.lat as number, lon: el.lon as number, ...(tags ? { tags } : {}) };
  }
  if (el.type === "way") {
    return { type: "way", id: el.id as number, nodes: (el.nodes as number[]) ?? [], ...(tags ? { tags } : {}) };
  }
  if (el.type === "relation") {
    const members = ((el.members as { type: "node" | "way" | "relation"; ref: number; role: string }[]) ?? []).map((m) => ({
      type: m.type,
      ref: m.ref,
      role: m.role,
    }));
    return { type: "relation", id: el.id as number, members, ...(tags ? { tags } : {}) };
  }
  return undefined;
}

async function getTile(bbox: Bbox, timeoutMs: number): Promise<{ elements: OsmElement[]; generator: string | null }> {
  const url = `${OSM_API}?bbox=${bbox.map(fmt).join(",")}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (res.status === 400 && /too many nodes|limit is/i.test(text)) throw new TooManyNodes(text.slice(0, 200));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  const parsed = JSON.parse(text) as { generator?: string; elements?: Record<string, unknown>[] };
  if (!Array.isArray(parsed.elements)) throw new Error("response has no elements array");
  const elements: OsmElement[] = [];
  for (const raw of parsed.elements) {
    const el = strip(raw);
    if (el) elements.push(el);
  }
  return { elements, generator: parsed.generator ?? null };
}

export function tileGrid(bbox: Bbox, tileDeg: number): Bbox[] {
  const [w, s, e, n] = bbox;
  const cols = Math.max(1, Math.ceil((e - w) / tileDeg - 1e-9));
  const rows = Math.max(1, Math.ceil((n - s) / tileDeg - 1e-9));
  const tiles: Bbox[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push([
        c === 0 ? w : w + ((e - w) * c) / cols,
        r === 0 ? s : s + ((n - s) * r) / rows,
        c === cols - 1 ? e : w + ((e - w) * (c + 1)) / cols,
        r === rows - 1 ? n : s + ((n - s) * (r + 1)) / rows,
      ]);
    }
  }
  return tiles;
}

/**
 * Fetches the tiles one after another with a pause in between. A failed tile is
 * retried once after a longer pause. A tile over the node limit is cut in four.
 * Every tile is saved gzipped in tilesDir. Throws when a tile cannot be fetched.
 */
export async function fetchOsmApi(
  bbox: Bbox,
  tilesDir: string,
  options: { tileDeg: number; timeoutMs: number; pauseMs: number; log: (msg: string) => void },
): Promise<OsmApiResult> {
  mkdirSync(tilesDir, { recursive: true });
  const queue = tileGrid(bbox, options.tileDeg).map((b) => ({ bbox: b, depth: 0 }));
  const tiles: TileInfo[] = [];
  const attempts: string[] = [];
  const merged: OsmElement[] = [];
  let generator: string | null = null;
  let done = 0;
  let failures = 0;

  while (queue.length > 0) {
    const tile = queue.shift()!;
    let result: Awaited<ReturnType<typeof getTile>> | undefined;
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      const started = Date.now();
      try {
        result = await getTile(tile.bbox, options.timeoutMs);
      } catch (err) {
        if (err instanceof TooManyNodes) {
          if (tile.depth >= 3) throw new Error(`tile ${tile.bbox.map(fmt).join(",")} is still over the node limit after three splits`);
          const [w, s, e, n] = tile.bbox;
          const mx = (w + e) / 2;
          const my = (s + n) / 2;
          for (const b of [[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]] as Bbox[]) queue.unshift({ bbox: b, depth: tile.depth + 1 });
          attempts.push(`tile ${tile.bbox.map(fmt).join(",")}: over the node limit, cut in four`);
          break;
        }
        const reason = err instanceof Error ? `${err.name}: ${err.message}${err.cause ? ` (${String((err.cause as { code?: string }).code ?? err.cause)})` : ""}` : String(err);
        attempts.push(`tile ${tile.bbox.map(fmt).join(",")} attempt ${attempt}: failed after ${((Date.now() - started) / 1000).toFixed(1)} s (${reason})`);
        options.log(`  tile failed: ${reason}`);
        failures++;
        if (attempt === 2 || failures > 6) {
          throw new Error(`OpenStreetMap API could not be read:\n  ${attempts.join("\n  ")}`);
        }
        await sleep(10_000);
      }
    }
    if (result) {
      const file = `tile-${String(tiles.length).padStart(3, "0")}.json.gz`;
      writeFileSync(resolve(tilesDir, file), gzipSync(JSON.stringify({ bbox: tile.bbox, elements: result.elements })));
      tiles.push({ file, bbox: tile.bbox, elements: result.elements.length });
      for (const el of result.elements) merged.push(el);
      generator = result.generator ?? generator;
      done++;
      options.log(`  tile ${done} (${tile.bbox.map(fmt).join(",")}): ${result.elements.length} elements, ${queue.length} to go`);
    }
    if (queue.length > 0) await sleep(options.pauseMs);
  }
  attempts.push(`${tiles.length} tiles fetched from ${OSM_API}, one at a time, ${options.pauseMs} ms apart`);
  return { elements: merged, tiles, attempts, generator };
}

export function readTiles(tilesDir: string, tiles: TileInfo[]): OverpassResponse {
  const elements: OsmElement[] = [];
  for (const tile of tiles) {
    const parsed = JSON.parse(gunzipSync(readFileSync(resolve(tilesDir, tile.file))).toString("utf8")) as { elements: OsmElement[] };
    for (const el of parsed.elements) elements.push(el);
  }
  return { elements };
}

/**
 * Makes the index look the same for both sources: every way and relation gets a
 * centre (the middle of its bounding box, as Overpass "out center" gives), and
 * nodes outside the bbox are removed so that ways are cut at the bbox edge.
 */
export function clipToBbox(osm: OsmIndex, bbox: Bbox): void {
  const [w, s, e, n] = bbox;
  const centreOf = (nodeIds: Iterable<number>) => {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const id of nodeIds) {
      const node = osm.nodes.get(id);
      if (!node) continue;
      minLon = Math.min(minLon, node.lon);
      maxLon = Math.max(maxLon, node.lon);
      minLat = Math.min(minLat, node.lat);
      maxLat = Math.max(maxLat, node.lat);
    }
    return minLon === Infinity ? undefined : { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  };
  for (const way of osm.ways.values()) {
    if (!way.center && way.tags) way.center = centreOf(way.nodes ?? []);
  }
  for (const rel of osm.relations.values()) {
    if (rel.center || !rel.tags) continue;
    const ids: number[] = [];
    for (const m of rel.members ?? []) {
      if (m.type === "node") ids.push(m.ref);
      else if (m.type === "way") for (const ref of osm.ways.get(m.ref)?.nodes ?? []) ids.push(ref);
    }
    rel.center = centreOf(ids);
  }
  for (const [id, node] of osm.nodes) {
    if (node.lon < w || node.lon > e || node.lat < s || node.lat > n) osm.nodes.delete(id);
  }
}
