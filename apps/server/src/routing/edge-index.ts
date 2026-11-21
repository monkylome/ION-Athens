/** A grid index over the edges of a PedestrianGraph, for nearest-edge and area queries. */
import type { GraphEdge, LngLat, PedestrianGraph } from "@ion/core";
import { type BBox, bboxOf, expandBBox, pointToLine } from "../geo.ts";

export interface EdgeMatch {
  edgeId: string;
  /** Metres from the query point to the edge. */
  distanceM: number;
  /** Closest point on the edge. */
  point: LngLat;
}

const CELL_DEG = 0.001; // about 90 by 110 metres in Athens

export class EdgeIndex {
  private readonly cells = new Map<string, GraphEdge[]>();
  readonly edgeCount: number;

  constructor(graph: Pick<PedestrianGraph, "edges">) {
    this.edgeCount = graph.edges.length;
    for (const edge of graph.edges) {
      const box = bboxOf(edge.geometry);
      if (!box) continue;
      for (const key of cellKeys(box)) {
        const list = this.cells.get(key);
        if (list) list.push(edge);
        else this.cells.set(key, [edge]);
      }
    }
  }

  edgesInBBox(box: BBox): GraphEdge[] {
    const seen = new Set<GraphEdge>();
    for (const key of cellKeys(box)) for (const e of this.cells.get(key) ?? []) seen.add(e);
    return [...seen];
  }

  nearestEdge(p: LngLat, maxDistanceM = 60): EdgeMatch | null {
    let best: EdgeMatch | null = null;
    for (const edge of this.edgesInBBox(expandBBox([p[0], p[1], p[0], p[1]], maxDistanceM))) {
      const hit = pointToLine(p, edge.geometry);
      if (hit && hit.distanceM <= maxDistanceM && (!best || hit.distanceM < best.distanceM)) {
        best = { edgeId: edge.id, distanceM: hit.distanceM, point: hit.point };
      }
    }
    return best;
  }
}

function cellKeys(box: BBox): string[] {
  const keys: string[] = [];
  const x0 = Math.floor(box[0] / CELL_DEG), x1 = Math.floor(box[2] / CELL_DEG);
  const y0 = Math.floor(box[1] / CELL_DEG), y1 = Math.floor(box[3] / CELL_DEG);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x}:${y}`);
  return keys;
}
