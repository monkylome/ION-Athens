/**
 * Archaeological sites mapped as areas, and the graph edges that run inside them.
 * OSM rarely tags the paths inside a fenced, ticketed site with access or fee,
 * so the only fact available is "this edge lies inside the outline of site X".
 */
import type { EdgeId, LngLat, PedestrianGraph } from "../../../packages/core/src/types.ts";
import { midpointAlong } from "./geo.ts";
import type { OsmIndex, Tags } from "./overpass.ts";

export interface SiteArea {
  source: string;
  name: string;
  nameEn: string | null;
  /** OSM tags as written, when present. */
  fee?: string;
  access?: string;
  openingHours?: string;
  rings: LngLat[][];
  /** False when part of the outline was not in the download: edges may be missed. */
  outlineComplete: boolean;
}

export interface SiteEdges extends Omit<SiteArea, "rings"> {
  edgeIds: EdgeId[];
  lengthM: number;
}

/** Joins ways end to end into closed rings. Returns the closed rings and whether every way was used. */
function assembleRings(ways: number[][]): { rings: number[][]; complete: boolean } {
  const rings: number[][] = [];
  const open = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  let complete = true;
  while (open.length > 0) {
    let ring = open.pop()!;
    for (let grew = true; grew && ring[0] !== ring[ring.length - 1]; ) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i]!;
        const tail = ring[ring.length - 1];
        if (w[0] === tail) ring = ring.concat(w.slice(1));
        else if (w[w.length - 1] === tail) ring = ring.concat([...w].reverse().slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring[0] === ring[ring.length - 1] && ring.length >= 4) rings.push(ring);
    else complete = false;
  }
  return { rings, complete };
}

/** Must run before nodes outside the bbox are removed from the index. */
export function findSites(osm: OsmIndex): SiteArea[] {
  const sites: SiteArea[] = [];
  const add = (source: string, tags: Tags, wayNodeLists: number[][], membersComplete: boolean) => {
    const { rings, complete } = assembleRings(wayNodeLists);
    let nodesComplete = true;
    const coords = rings.map((ring) =>
      ring.flatMap((id): LngLat[] => {
        const n = osm.nodes.get(id);
        if (!n) nodesComplete = false;
        return n ? [[n.lon, n.lat]] : [];
      }),
    );
    if (coords.length === 0) return;
    const site: SiteArea = {
      source,
      name: tags["name:el"] ?? tags.name ?? tags["name:en"] ?? "(unnamed)",
      nameEn: tags["name:en"] ?? null,
      rings: coords,
      outlineComplete: complete && membersComplete && nodesComplete,
    };
    if (tags.fee) site.fee = tags.fee;
    if (tags.access) site.access = tags.access;
    if (tags.opening_hours) site.openingHours = tags.opening_hours;
    sites.push(site);
  };
  for (const way of osm.ways.values()) {
    if (way.tags?.historic !== "archaeological_site" || !way.nodes || way.nodes.length < 4) continue;
    if (way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;
    add(`osm:way/${way.id}`, way.tags, [way.nodes], true);
  }
  for (const rel of osm.relations.values()) {
    if (rel.tags?.historic !== "archaeological_site" || rel.tags.type !== "multipolygon") continue;
    const lists: number[][] = [];
    let membersComplete = true;
    for (const m of rel.members ?? []) {
      if (m.type !== "way") continue;
      const nodes = osm.ways.get(m.ref)?.nodes;
      if (nodes) lists.push(nodes);
      else membersComplete = false;
    }
    add(`osm:relation/${rel.id}`, rel.tags, lists, membersComplete);
  }
  return sites;
}

/** Even-odd rule over all rings, so inner rings of a multipolygon are holes. */
function inside(p: LngLat, rings: LngLat[][]): boolean {
  let within = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) within = !within;
    }
  }
  return within;
}

export function edgesInSites(sites: SiteArea[], graph: PedestrianGraph): SiteEdges[] {
  const mids = graph.edges.map((e) => ({ e, mid: midpointAlong(e.geometry) }));
  const out: SiteEdges[] = [];
  for (const { rings, ...rest } of sites) {
    const hit = mids.filter(({ mid }) => inside(mid, rings)).map(({ e }) => e);
    if (hit.length === 0) continue;
    out.push({ ...rest, edgeIds: hit.map((e) => e.id), lengthM: Math.round(hit.reduce((s, e) => s + e.lengthM, 0)) });
  }
  return out.sort((a, b) => b.lengthM - a.lengthM);
}
