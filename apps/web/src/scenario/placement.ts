/**
 * Where to put the demo obstacle. Nothing is hard-coded: for every edge ahead
 * of the walker the routing engine is asked what closing it would do, and the
 * edge with a clearly visible detour and enough warning is chosen.
 */
import {
  nearestEdge,
  orientedGeometry,
  pointAlongPolyline,
  polylineLengthM,
  rerouteForObstacle,
  type GraphIndex,
  type LngLat,
  type NodeId,
  type Obstacle,
  type Route,
  type TurnDirection,
} from "@ion/core";

export interface PlacementOptions {
  /** The decision point must be at least this far ahead of the walker. */
  minDecisionAheadM: number;
  minExtraM: number;
  maxExtraM: number;
  /** The detour that reads best on a screen. */
  targetExtraM: number;
  /** Shorter edges are skipped: a report on them snaps to a neighbour too easily. Default 8. */
  minEdgeLengthM?: number;
  cost?: Partial<import("@ion/core").CostOptions>;
  atTime: number | string | Date;
  /** Obstacles already known to routing. */
  obstacles?: readonly Obstacle[];
}

export interface Placement {
  edgeId: string;
  /** A point on the edge that is nearer to this edge than to any other. */
  position: LngLat;
  decisionNode: NodeId;
  distanceToDecisionM: number;
  distanceToObstacleM: number;
  extraDistanceM: number;
  turnDirection: TurnDirection | null;
  /** True when no edge met every bound and this is the best of the rest. */
  relaxed: boolean;
  score: number;
}

export function probeObstacle(edgeId: string, position: LngLat, atTime: number | string | Date): Obstacle {
  return {
    id: `probe:${edgeId}`,
    edgeId,
    blocks: "full",
    type: "probe",
    label: "probe",
    source: { kind: "synthetic" },
    synthetic: true,
    observedAt: new Date(atTime).toISOString(),
    expiresAt: null,
    confidence: 1,
    position,
  };
}

/** A point on the edge that the nearest-edge search gives back to the same edge, or null. */
function pointOnEdge(index: GraphIndex, edgeId: string): LngLat | null {
  const edge = index.edges.get(edgeId);
  if (!edge) return null;
  const line = orientedGeometry(index, edge, edge.from);
  const length = polylineLengthM(line);
  for (const fraction of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    const point = pointAlongPolyline(line, length * fraction).point;
    if (nearestEdge(index, point, 30)?.edge.id === edgeId) return point;
  }
  return null;
}

/** Every edge ahead whose closure reroutes the walker in good time, best first. */
export function findPlacements(
  index: GraphIndex,
  route: Route,
  progressM: number,
  options: PlacementOptions,
): Placement[] {
  const minLength = options.minEdgeLengthM ?? 8;
  const out: Placement[] = [];
  const seen = new Set<string>();
  for (const edgeId of route.edges) {
    if (seen.has(edgeId)) continue;
    seen.add(edgeId);
    const edge = index.edges.get(edgeId);
    if (!edge || edge.lengthM < minLength) continue;
    const position = pointOnEdge(index, edgeId);
    if (!position) continue;
    const result = rerouteForObstacle(index, route, progressM, probeObstacle(edgeId, position, options.atTime), {
      ...options.cost && { cost: options.cost },
      atTime: options.atTime,
      obstacles: options.obstacles ?? [],
      minWarningDistanceM: 0,
    });
    if (result.outcome !== "reroute") continue;
    const within =
      result.distanceToDecisionM >= options.minDecisionAheadM &&
      result.extraDistanceM >= options.minExtraM &&
      result.extraDistanceM <= options.maxExtraM;
    // Near the target detour, and no further ahead than needed, so the audience does not wait.
    const score =
      Math.abs(result.extraDistanceM - options.targetExtraM) +
      0.3 * Math.max(0, result.distanceToDecisionM - options.minDecisionAheadM) +
      (within ? 0 : 10_000 + Math.max(0, options.minDecisionAheadM - result.distanceToDecisionM) * 10);
    out.push({
      edgeId,
      position,
      decisionNode: result.decisionNode,
      distanceToDecisionM: result.distanceToDecisionM,
      distanceToObstacleM: result.distanceToObstacleM,
      extraDistanceM: result.extraDistanceM,
      turnDirection: result.turnDirection,
      relaxed: !within,
      score,
    });
  }
  return out.sort((a, b) => a.score - b.score);
}

export function choosePlacement(
  index: GraphIndex,
  route: Route,
  progressM: number,
  options: PlacementOptions,
): Placement | null {
  return findPlacements(index, route, progressM, options)[0] ?? null;
}
