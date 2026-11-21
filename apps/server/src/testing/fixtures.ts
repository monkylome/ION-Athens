/** A tiny street grid and sandbox-shaped records for tests. Not real places. */
import type { GraphEdge, GraphNode, LngLat, PedestrianGraph } from "@ion/core";
import { fromXY, lineLengthM } from "../geo.ts";
import { EdgeIndex } from "../routing/edge-index.ts";
import type { EdgeLookup } from "../obstacles/rules.ts";
import type { SandboxProject, SandboxReport } from "../sandbox/schemas.ts";

export const ORIGIN: LngLat = [23.727, 37.979];

/** A point given in metres east and north of the grid's corner A. */
export const at = (eastM: number, northM: number): LngLat => fromXY([eastM, northM], ORIGIN);

/**
 *   D ---- E ---- F      100 m north
 *   |      |      |
 *   A ---- B ---- C      0 m
 *   0     100    200 m east
 */
const NODES: Record<string, [number, number]> = { A: [0, 0], B: [100, 0], C: [200, 0], D: [0, 100], E: [100, 100], F: [200, 100] };
const EDGES: Array<[string, string, string]> = [
  ["AB", "A", "B"], ["BC", "B", "C"], ["DE", "D", "E"], ["EF", "E", "F"],
  ["AD", "A", "D"], ["BE", "B", "E"], ["CF", "C", "F"],
];

export function testGraph(): PedestrianGraph {
  const nodes: GraphNode[] = Object.entries(NODES).map(([id, [x, y]]) => {
    const [lng, lat] = at(x, y);
    return { id, lng, lat, kind: "junction" };
  });
  const edges: GraphEdge[] = EDGES.map(([id, from, to]) => {
    const geometry = [at(...NODES[from]!), at(...NODES[to]!)];
    return { id, from, to, lengthM: lineLengthM(geometry), kind: "sidewalk", geometry, name: `Οδός ${id}` };
  });
  return {
    meta: { bbox: [0, 0, 0, 0], builtAt: "2026-11-21T00:00:00Z", source: "test", licence: "", attribution: "", nodeCount: nodes.length, edgeCount: edges.length },
    nodes,
    edges,
  };
}

export function testEdges(): EdgeLookup {
  const index = new EdgeIndex(testGraph());
  return { nearestEdge: (p, max) => index.nearestEdge(p, max), edgesInBBox: (b) => index.edgesInBBox(b) };
}

export const NOW = new Date("2026-11-21T12:00:00+02:00");

export function report(over: Partial<SandboxReport> & { at?: LngLat } = {}): SandboxReport {
  const [lng, lat] = over.at ?? at(50, 5);
  const { at: _ignored, ...rest } = over;
  return {
    id: "req-1001",
    category: "sidewalk",
    category_name: "Πεζοδρόμιο",
    title: "Σπασμένες πλάκες πεζοδρομίου",
    description: "Πλάκες που έχουν σηκωθεί.",
    address: "Οδός ΑΒ 20, Αθήνα",
    lat,
    lng,
    status: "submitted",
    created_at: "2026-11-21T11:00:00+02:00",
    updated_at: "2026-11-21T11:00:00+02:00",
    upvotes: 0,
    created_by_you: true,
    distance_km: null,
    ...rest,
  };
}

export function project(geometry: SandboxProject["geometry"], props: Partial<SandboxProject["properties"]> = {}): SandboxProject {
  return {
    type: "Feature",
    id: props.id ?? "prj-900",
    geometry,
    properties: {
      id: "prj-900",
      title: "Ανάπλαση πεζοδρομίων",
      category: "sidewalk",
      status: "in_progress",
      start_date: "2026-04-01",
      end_date_planned: "2027-06-30",
      address: "Οδός ΑΒ",
      ...props,
    },
  };
}
