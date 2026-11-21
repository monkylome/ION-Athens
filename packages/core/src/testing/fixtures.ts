/** Small hand-made graphs for the tests. Coordinates are given in metres from an origin in central Athens. */
import { haversineM } from "../geo.ts";
import type {
  CrossingInfo,
  EdgeKind,
  GraphEdge,
  GraphNode,
  LngLat,
  Obstacle,
  PedestrianGraph,
} from "../types.ts";

const ORIGIN: LngLat = [23.7348, 37.9755];
const M_PER_DEG = 111195.08;

/** [x east, y north] in metres to [lng, lat]. */
export function at(x: number, y: number): LngLat {
  return [
    ORIGIN[0] + x / (M_PER_DEG * Math.cos((ORIGIN[1] * Math.PI) / 180)),
    ORIGIN[1] + y / M_PER_DEG,
  ];
}

export class GraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];

  node(id: string, x: number, y: number): this {
    const [lng, lat] = at(x, y);
    this.nodes.set(id, { id, lng, lat, kind: "junction" });
    return this;
  }

  edge(from: string, to: string, extra: Partial<GraphEdge> & { kind?: EdgeKind } = {}): this {
    const a = this.nodes.get(from)!;
    const b = this.nodes.get(to)!;
    const geometry: LngLat[] = [
      [a.lng, a.lat],
      [b.lng, b.lat],
    ];
    this.edges.push({
      id: `${from}-${to}`,
      from,
      to,
      lengthM: haversineM(geometry[0]!, geometry[1]!),
      kind: "sidewalk",
      geometry,
      ...extra,
    });
    return this;
  }

  build(): PedestrianGraph {
    return {
      meta: {
        bbox: [0, 0, 0, 0],
        builtAt: "2026-11-21T00:00:00Z",
        source: "test",
        licence: "test",
        attribution: "test",
        nodeCount: this.nodes.size,
        edgeCount: this.edges.length,
      },
      nodes: [...this.nodes.values()],
      edges: this.edges,
    };
  }
}

/**
 * A ladder. Bottom street A-B-C-D-E, top street B2-C2-D2-E2, rungs at B, C, D, E.
 *
 *        B2 --- C2 --- D2 --- E2
 *        |      |      |      |
 * A ---- B ---- C ---- D ---- E      (100 m per segment)
 */
export function ladderGraph(): PedestrianGraph {
  const g = new GraphBuilder();
  ["A", "B", "C", "D", "E"].forEach((id, i) => g.node(id, i * 100, 0));
  ["B2", "C2", "D2", "E2"].forEach((id, i) => g.node(id, (i + 1) * 100, 100));
  for (const [a, b] of [["A", "B"], ["B", "C"], ["C", "D"], ["D", "E"]] as const) {
    g.edge(a, b, { name: "Ερμού" });
  }
  for (const [a, b] of [["B2", "C2"], ["C2", "D2"], ["D2", "E2"]] as const) {
    g.edge(a, b, { name: "Μητροπόλεως" });
  }
  for (const id of ["B", "C", "D", "E"]) g.edge(id, `${id}2`);
  return g.build();
}

/** S - M - T in a line (100 m each), plus a longer way round from M to T through X (about 156 m). */
export function diamondGraph(): PedestrianGraph {
  return new GraphBuilder()
    .node("S", 0, 0)
    .node("M", 100, 0)
    .node("T", 200, 0)
    .node("X", 150, -60)
    .edge("S", "M")
    .edge("M", "T")
    .edge("M", "X")
    .edge("X", "T")
    .build();
}

/** S - M - T in a line, nothing else. */
export function lineGraph(): PedestrianGraph {
  return new GraphBuilder()
    .node("S", 0, 0)
    .node("M", 100, 0)
    .node("T", 200, 0)
    .edge("S", "M")
    .edge("M", "T")
    .build();
}

/**
 * Two ways from S to T. The short one (110 m) uses crossing U1-U2, the long
 * one (about 166 m) uses crossing V1-V2.
 */
export function crossingGraph(short: CrossingInfo, long: CrossingInfo): PedestrianGraph {
  return new GraphBuilder()
    .node("S", 0, 0)
    .node("U1", 50, 0)
    .node("U2", 60, 0)
    .node("T", 110, 0)
    .node("V1", 50, 60)
    .node("V2", 60, 60)
    .edge("S", "U1")
    .edge("U1", "U2", { kind: "crossing", crossing: short })
    .edge("U2", "T")
    .edge("S", "V1")
    .edge("V1", "V2", { kind: "crossing", crossing: long })
    .edge("V2", "T")
    .build();
}

/** A street with a signalled crossing (no sound) and a left turn: P0 - P1 = P2 - P3, then north to P4. */
export function streetGraph(): PedestrianGraph {
  return new GraphBuilder()
    .node("P0", 0, 0)
    .node("P1", 60, 0)
    .node("P2", 70, 0)
    .node("P3", 120, 0)
    .node("P4", 120, 60)
    .edge("P0", "P1", { name: "Ερμού" })
    .edge("P1", "P2", {
      kind: "crossing",
      crossing: { signals: "yes", sound: "no", marked: "yes" },
    })
    .edge("P2", "P3", { name: "Ερμού" })
    .edge("P3", "P4", { name: "Βουλής" })
    .build();
}

export const NOW = "2026-11-22T10:00:00Z";

export function obstacle(edgeId: string, extra: Partial<Obstacle> = {}): Obstacle {
  return {
    id: `obs-${edgeId}`,
    edgeId,
    blocks: "full",
    type: "works",
    label: "Έργα στο πεζοδρόμιο",
    source: { kind: "synthetic" },
    synthetic: true,
    observedAt: "2026-11-22T09:00:00Z",
    expiresAt: null,
    confidence: 0.9,
    ...extra,
  };
}
