/**
 * Everything the server needs from the routing engine. The engine in
 * `packages/core` is plugged in behind this interface in `routing/index.ts`.
 */
import type { LngLat, Obstacle, PedestrianGraph, Route } from "@ion/core";
import type { EdgeMatch } from "./edge-index.ts";

export type { EdgeMatch };

export interface RoutingPort {
  /** Which implementation answers: the simple fallback or the real engine. */
  readonly engine: "fallback" | "core";
  readonly graph: PedestrianGraph;
  /** Nearest walkable edge to a point, or null when none is within `maxDistanceM`. */
  nearestEdge(point: LngLat, maxDistanceM?: number): EdgeMatch | null;
  /** Best route that respects the obstacles active at `now`, or null when there is none. */
  route(from: LngLat, to: LngLat, obstacles: readonly Obstacle[], now: Date): Route | null;
}

export const EMPTY_GRAPH: PedestrianGraph = {
  meta: {
    bbox: [0, 0, 0, 0],
    builtAt: "",
    source: "none",
    licence: "",
    attribution: "",
    nodeCount: 0,
    edgeCount: 0,
  },
  nodes: [],
  edges: [],
};
