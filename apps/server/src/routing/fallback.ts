/**
 * Stand-in routing used until the engine in `packages/core` is wired in.
 * Dijkstra over edge length. A full obstacle with confidence of 0.5 or more
 * closes its edge; any other active obstacle adds cost. Instructions are only
 * "depart" and "arrive": turn-by-turn steps are the real engine's job.
 */
import type { GraphEdge, LngLat, NodeId, Obstacle, PedestrianGraph, Route } from "@ion/core";
import { EdgeIndex, type EdgeMatch } from "./edge-index.ts";
import type { RoutingPort } from "./port.ts";
import { distanceM } from "../geo.ts";

const SNAP_LIMIT_M = 250;
const PARTIAL_PENALTY_M = 60;

export function isActive(o: Obstacle, now: Date): boolean {
  return o.expiresAt === null || Date.parse(o.expiresAt) > now.getTime();
}

export class FallbackRouting implements RoutingPort {
  readonly engine = "fallback" as const;
  private readonly index: EdgeIndex;
  private readonly edgesById = new Map<string, GraphEdge>();
  private readonly adjacency = new Map<NodeId, GraphEdge[]>();

  constructor(readonly graph: PedestrianGraph) {
    this.index = new EdgeIndex(graph);
    for (const e of graph.edges) {
      this.edgesById.set(e.id, e);
      for (const n of [e.from, e.to]) {
        const list = this.adjacency.get(n);
        if (list) list.push(e);
        else this.adjacency.set(n, [e]);
      }
    }
  }

  nearestEdge(point: LngLat, maxDistanceM?: number): EdgeMatch | null {
    return this.index.nearestEdge(point, maxDistanceM);
  }

  route(from: LngLat, to: LngLat, obstacles: readonly Obstacle[], now: Date): Route | null {
    const start = this.nearestNode(from);
    const goal = this.nearestNode(to);
    if (!start || !goal) return null;

    const closed = new Set<string>();
    const penalty = new Map<string, number>();
    for (const o of obstacles) {
      if (!isActive(o, now)) continue;
      if (o.blocks === "full" && o.confidence >= 0.5) closed.add(o.edgeId);
      else penalty.set(o.edgeId, (penalty.get(o.edgeId) ?? 0) + PARTIAL_PENALTY_M * Math.max(0.1, o.confidence));
    }

    const cost = new Map<NodeId, number>([[start, 0]]);
    const via = new Map<NodeId, GraphEdge>();
    const done = new Set<NodeId>();
    const queue: Array<[number, NodeId]> = [[0, start]];
    while (queue.length > 0) {
      const [c, node] = heapPop(queue)!;
      if (done.has(node)) continue;
      done.add(node);
      if (node === goal) break;
      for (const e of this.adjacency.get(node) ?? []) {
        if (closed.has(e.id)) continue;
        const next = e.from === node ? e.to : e.from;
        const nc = c + e.lengthM + (penalty.get(e.id) ?? 0);
        if (nc < (cost.get(next) ?? Infinity)) {
          cost.set(next, nc);
          via.set(next, e);
          heapPush(queue, [nc, next]);
        }
      }
    }
    if (!done.has(goal)) return null;

    const nodes: NodeId[] = [goal];
    const edges: GraphEdge[] = [];
    for (let n = goal; n !== start; ) {
      const e = via.get(n)!;
      edges.unshift(e);
      n = e.from === n ? e.to : e.from;
      nodes.unshift(n);
    }
    const geometry: LngLat[] = [];
    let lengthM = 0;
    edges.forEach((e, i) => {
      const forward = e.from === nodes[i];
      const pts = forward ? e.geometry : [...e.geometry].reverse();
      geometry.push(...(geometry.length > 0 ? pts.slice(1) : pts));
      lengthM += e.lengthM;
    });
    return {
      nodes,
      edges: edges.map((e) => e.id),
      lengthM,
      cost: cost.get(goal) ?? lengthM,
      geometry,
      steps: [
        { atNode: start, atDistanceM: 0, kind: "depart", ...(edges[0]?.name ? { onto: edges[0].name } : {}) },
        { atNode: goal, atDistanceM: lengthM, kind: "arrive" },
      ],
    };
  }

  /** The end node of the nearest edge that is closer to the point. */
  private nearestNode(p: LngLat): NodeId | null {
    const match = this.index.nearestEdge(p, SNAP_LIMIT_M);
    const edge = match && this.edgesById.get(match.edgeId);
    if (!edge) return null;
    const a = edge.geometry[0];
    const b = edge.geometry[edge.geometry.length - 1];
    if (!a || !b) return edge.from;
    return distanceM(p, a) <= distanceM(p, b) ? edge.from : edge.to;
  }
}

function heapPush(h: Array<[number, NodeId]>, item: [number, NodeId]): void {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (h[parent]![0] <= h[i]![0]) break;
    [h[parent], h[i]] = [h[i]!, h[parent]!];
    i = parent;
  }
}

function heapPop(h: Array<[number, NodeId]>): [number, NodeId] | undefined {
  const top = h[0];
  const last = h.pop();
  if (h.length > 0 && last) {
    h[0] = last;
    for (let i = 0; ; ) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l]![0] < h[m]![0]) m = l;
      if (r < h.length && h[r]![0] < h[m]![0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i]!, h[m]!];
      i = m;
    }
  }
  return top;
}
