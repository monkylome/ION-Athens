/**
 * Routing backed by the real engine in `@ion/core`: A* with the pedestrian cost
 * model (crossings, steps, tactile paving) and turn-by-turn steps.
 */
import { buildGraphIndex, findRoute, nearestNode, type GraphIndex } from "@ion/core";
import type { LngLat, Obstacle, PedestrianGraph, Route } from "@ion/core";
import { EdgeIndex, type EdgeMatch } from "./edge-index.ts";
import type { RoutingPort } from "./port.ts";

/** A point further than this from every graph node is outside the mapped area. */
const SNAP_LIMIT_M = 250;

export class CoreRouting implements RoutingPort {
  readonly engine = "core" as const;
  private readonly index: GraphIndex;
  private readonly edges: EdgeIndex;

  constructor(readonly graph: PedestrianGraph) {
    this.index = buildGraphIndex(graph);
    this.edges = new EdgeIndex(graph);
  }

  nearestEdge(point: LngLat, maxDistanceM?: number): EdgeMatch | null {
    return this.edges.nearestEdge(point, maxDistanceM);
  }

  route(from: LngLat, to: LngLat, obstacles: readonly Obstacle[], now: Date): Route | null {
    const start = nearestNode(this.index, from, SNAP_LIMIT_M);
    const goal = nearestNode(this.index, to, SNAP_LIMIT_M);
    if (!start || !goal) return null;
    const result = findRoute(this.index, start.node.id, goal.node.id, {
      atTime: now.toISOString(),
      obstacles: [...obstacles],
    });
    return result.ok ? result.route : null;
  }
}
