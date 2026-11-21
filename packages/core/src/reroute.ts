/**
 * Rerouting at the decision point: what a new (or removed) obstacle means for
 * a walker who is already on a route.
 */
import type { CostOptions, TimeInput } from "./cost.ts";
import { isObstacleActive } from "./cost.ts";
import { polylineLengthM, projectOntoPolyline } from "./geo.ts";
import { orientedGeometry, type GraphIndex } from "./graph.ts";
import {
  buildRoute,
  createCoster,
  routeSpans,
  searchPath,
  turnAtNode,
  type PathResult,
} from "./route.ts";
import type { EdgeId, NodeId, Obstacle, Route, TurnDirection } from "./types.ts";

export const DEFAULT_MIN_WARNING_DISTANCE_M = 25;
/** A walker this close to a node is treated as standing on it. */
const AT_NODE_M = 1;

export interface RerouteOptions {
  /** The moment obstacles are evaluated at. */
  atTime: TimeInput;
  /** Every other obstacle already known. The new one is added to these. */
  obstacles?: readonly Obstacle[];
  cost?: Partial<CostOptions>;
  /** A turn at a junction nearer to the walker than this is flagged as a late warning. Default 25. */
  minWarningDistanceM?: number;
}

export type RerouteResult =
  | {
      /** The obstacle changes nothing for this walker. */
      outcome: "not_relevant";
      reason: "inactive" | "not_on_route" | "behind_walker";
      route: Route;
      progressM: number;
    }
  | {
      /** The obstacle is ahead but does not close the way, and no other way is cheaper. */
      outcome: "keep_route";
      route: Route;
      progressM: number;
      blockedEdgeId: EdgeId;
      distanceToObstacleM: number;
    }
  | {
      /** Turn at a junction ahead. `route` is the full route: the part up to the decision node, then the new remainder. */
      outcome: "reroute";
      route: Route;
      progressM: number;
      blockedEdgeId: EdgeId;
      distanceToObstacleM: number;
      decisionNode: NodeId;
      distanceToDecisionM: number;
      /** Turn to make at the decision node. null when the walker is at the very start. */
      turnDirection: TurnDirection | null;
      /** New full length minus old full length. */
      extraDistanceM: number;
      /** True when the junction is nearer to the walker than minWarningDistanceM: the turn is imminent. */
      lateWarning: boolean;
    }
  | {
      /** No usable junction is left ahead. `route` starts at the walker's position and progressM is 0. */
      outcome: "turn_back";
      route: Route;
      progressM: 0;
      blockedEdgeId: EdgeId;
      distanceToObstacleM: number;
      /** The junction the walker goes back to. */
      decisionNode: NodeId;
      distanceToDecisionM: number;
      /** Turn to make at that junction, arriving from where the walker is now. null when it is the destination. */
      turnDirection: TurnDirection | null;
      /** Metres already walked plus the new route, minus the old full length. */
      extraDistanceM: number;
    }
  | {
      /** The way is closed and the destination cannot be reached any other way. */
      outcome: "no_alternative";
      route: Route;
      progressM: number;
      blockedEdgeId: EdgeId;
      distanceToObstacleM: number;
    };

function clampProgress(route: Route, progressM: number): number {
  return Math.min(Math.max(0, progressM), route.lengthM);
}

/**
 * Decide what a new obstacle means for a walker `progressM` metres into `route`.
 *
 * 1. Not relevant: the obstacle is not active, its edge is not on the route, or
 *    it is behind the walker.
 * 2. Otherwise the decision point is the last junction ahead of the walker and
 *    before the blocked edge from which another way to the destination exists
 *    without going back the way the walker came. For an obstacle that does not
 *    close the edge, "another way" must also be cheaper than staying on the
 *    route. When that junction is nearer than minWarningDistanceM the walker
 *    still turns there, and the result is flagged lateWarning.
 * 3. If no junction ahead offers another way and the edge is closed, the walker
 *    turns back: the route is computed from their position, back to the
 *    junction behind them and on from there.
 */
export function rerouteForObstacle(
  index: GraphIndex,
  route: Route,
  progressM: number,
  obstacle: Obstacle,
  options: RerouteOptions,
): RerouteResult {
  const p = clampProgress(route, progressM);
  const minWarning = options.minWarningDistanceM ?? DEFAULT_MIN_WARNING_DISTANCE_M;
  const notRelevant = (reason: "inactive" | "not_on_route" | "behind_walker"): RerouteResult => ({
    outcome: "not_relevant",
    reason,
    route,
    progressM: p,
  });

  if (!isObstacleActive(obstacle, options.atTime)) return notRelevant("inactive");
  const spans = routeSpans(index, route);
  if (!route.edges.includes(obstacle.edgeId)) return notRelevant("not_on_route");

  // Current edge: the first one that ends beyond the walker.
  const i = spans.findIndex((s) => s.endM > p);
  if (i < 0) return notRelevant("behind_walker"); // already arrived
  const k = route.edges.findIndex((id, idx) => idx >= i && id === obstacle.edgeId);
  if (k < 0) return notRelevant("behind_walker");
  const here = spans[i]!;
  const blocked = spans[k]!;

  let obstacleAtM = blocked.startM;
  if (obstacle.position) {
    const edge = index.edges.get(obstacle.edgeId)!;
    const line = orientedGeometry(index, edge, blocked.fromNode);
    const geomLen = polylineLengthM(line);
    if (geomLen > 0) {
      const along = (projectOntoPolyline(line, obstacle.position).alongM / geomLen) * edge.lengthM;
      const offset = k === 0 ? (route.startOffsetM ?? 0) : 0;
      obstacleAtM = Math.max(blocked.startM, blocked.startM + along - offset);
      // On the walker's own edge, a known position decides whether it is already behind them.
      if (k === i && obstacleAtM < p - AT_NODE_M) return notRelevant("behind_walker");
    }
  }
  const distanceToObstacleM = Math.max(0, obstacleAtM - p);

  const others = (options.obstacles ?? []).filter((o) => o.id !== obstacle.id);
  const coster = createCoster({
    atTime: options.atTime,
    obstacles: [...others, obstacle],
    ...(options.cost ? { cost: options.cost } : {}),
  });
  const closed = !Number.isFinite(coster.cost(index.edges.get(obstacle.edgeId)!));
  const destination = route.nodes[route.nodes.length - 1]!;

  // Cost of staying on the old route from node j to the end.
  const remainingCost: number[] = new Array<number>(route.edges.length + 1).fill(0);
  for (let j = route.edges.length - 1; j >= 0; j--) {
    remainingCost[j] = remainingCost[j + 1]! + coster.cost(index.edges.get(route.edges[j]!)!);
  }

  const alternativeFrom = (j: number): PathResult | null => {
    const forbidden = new Set<EdgeId>(j > 0 ? [route.edges[j - 1]!] : []);
    const path = searchPath(index, route.nodes[j]!, destination, coster, forbidden);
    if (!path || path.edges.includes(obstacle.edgeId)) return null;
    return path.cost < remainingCost[j]! - 1e-6 ? path : null;
  };

  const rerouteAt = (
    j: number,
    path: PathResult,
    lateWarning: boolean,
  ): RerouteResult => {
    const full = buildRoute(
      index,
      [...route.nodes.slice(0, j + 1), ...path.nodes.slice(1)],
      [...route.edges.slice(0, j), ...path.edges],
      coster,
      route.startOffsetM ? { startOffsetM: route.startOffsetM } : {},
    );
    const firstNew = path.edges[0];
    return {
      outcome: "reroute",
      route: full,
      progressM: p,
      blockedEdgeId: obstacle.edgeId,
      distanceToObstacleM,
      decisionNode: route.nodes[j]!,
      distanceToDecisionM: Math.max(0, spans[j]!.startM - p),
      turnDirection:
        j > 0 && firstNew ? turnAtNode(index, route.edges[j - 1]!, route.nodes[j]!, firstNew) : null,
      extraDistanceM: full.lengthM - route.lengthM,
      lateWarning,
    };
  };

  // Junctions ahead of the walker, from the blocked edge backwards.
  const standingOnNode = p - here.startM < AT_NODE_M;
  const lowest = standingOnNode ? i : i + 1;
  for (let j = k; j >= lowest; j--) {
    const path = alternativeFrom(j);
    if (path) return rerouteAt(j, path, spans[j]!.startM - p < minWarning);
  }

  if (!closed) {
    return {
      outcome: "keep_route",
      route,
      progressM: p,
      blockedEdgeId: obstacle.edgeId,
      distanceToObstacleM,
    };
  }

  // Turn back: to the junction behind the walker, and on from there without
  // coming straight back along the edge they are on.
  const backNode = here.fromNode;
  const backDistanceM = p - here.startM;
  const back = searchPath(index, backNode, destination, coster, new Set([here.edgeId]));
  if (back) {
    const firstNew = back.edges[0];
    if (backDistanceM < AT_NODE_M) {
      // Standing on the junction: the new route simply starts there.
      const direction =
        i > 0 && firstNew ? turnAtNode(index, route.edges[i - 1]!, backNode, firstNew) : null;
      const fresh = buildRoute(
        index,
        back.nodes,
        back.edges,
        coster,
        direction ? { departDirection: direction } : {},
      );
      return {
        outcome: "turn_back",
        route: fresh,
        progressM: 0,
        blockedEdgeId: obstacle.edgeId,
        distanceToObstacleM,
        decisionNode: backNode,
        distanceToDecisionM: 0,
        turnDirection: direction,
        extraDistanceM: p + fresh.lengthM - route.lengthM,
      };
    }
    const fresh = buildRoute(
      index,
      [here.toNode, ...back.nodes],
      [here.edgeId, ...back.edges],
      coster,
      { startOffsetM: here.endM - p, departDirection: "u_turn" },
    );
    return {
      outcome: "turn_back",
      route: fresh,
      progressM: 0,
      blockedEdgeId: obstacle.edgeId,
      distanceToObstacleM,
      decisionNode: backNode,
      distanceToDecisionM: backDistanceM,
      turnDirection: firstNew ? turnAtNode(index, here.edgeId, backNode, firstNew) : null,
      extraDistanceM: p + fresh.lengthM - route.lengthM,
    };
  }

  return {
    outcome: "no_alternative",
    route,
    progressM: p,
    blockedEdgeId: obstacle.edgeId,
    distanceToObstacleM,
  };
}

export interface RemovalOptions {
  atTime: TimeInput;
  /** The obstacles that remain, without the removed one. */
  obstacles?: readonly Obstacle[];
  cost?: Partial<CostOptions>;
  minWarningDistanceM?: number;
  /** A new route must be at least this much cheaper (metre-equivalents) to be offered. Default 10. */
  minSavingM?: number;
}

export type RemovalResult =
  | { outcome: "keep_route"; route: Route; progressM: number }
  | {
      /** A cheaper route exists again. `route` is the full route with the new remainder. */
      outcome: "shorter_available";
      route: Route;
      progressM: number;
      /** Where the new route leaves the current one. */
      decisionNode: NodeId;
      distanceToDecisionM: number;
      turnDirection: TurnDirection | null;
      /** Old full length minus new full length. Can be negative when the saving is in penalties. */
      savedDistanceM: number;
      savedCostM: number;
    };

/**
 * After an obstacle has been removed (or has expired): is there a cheaper way
 * to the destination again? Only junctions at least minWarningDistanceM ahead
 * are considered, and the walker is never sent back.
 */
export function checkObstacleRemoved(
  index: GraphIndex,
  route: Route,
  progressM: number,
  options: RemovalOptions,
): RemovalResult {
  const p = clampProgress(route, progressM);
  const keep: RemovalResult = { outcome: "keep_route", route, progressM: p };
  const minWarning = options.minWarningDistanceM ?? DEFAULT_MIN_WARNING_DISTANCE_M;
  const spans = routeSpans(index, route);
  const i = spans.findIndex((s) => s.endM > p);
  if (i < 0) return keep;

  // First node the walker can still be told about in time.
  let m = -1;
  if (p - spans[i]!.startM < AT_NODE_M) m = i;
  else m = spans.findIndex((s) => s.index > i && s.startM - p >= minWarning);
  if (m < 0) return keep;

  const coster = createCoster({
    atTime: options.atTime,
    obstacles: options.obstacles ?? [],
    ...(options.cost ? { cost: options.cost } : {}),
  });
  let oldCost = 0;
  for (let j = m; j < route.edges.length; j++) oldCost += coster.cost(index.edges.get(route.edges[j]!)!);

  const destination = route.nodes[route.nodes.length - 1]!;
  const forbidden = new Set<EdgeId>(m > 0 ? [route.edges[m - 1]!] : []);
  const best = searchPath(index, route.nodes[m]!, destination, coster, forbidden);
  if (!best || !(best.cost < oldCost - (options.minSavingM ?? 10))) return keep;

  let shared = 0;
  while (shared < best.edges.length && best.edges[shared] === route.edges[m + shared]) shared++;
  const d = m + shared;
  const full = buildRoute(
    index,
    [...route.nodes.slice(0, m + 1), ...best.nodes.slice(1)],
    [...route.edges.slice(0, m), ...best.edges],
    coster,
    route.startOffsetM ? { startOffsetM: route.startOffsetM } : {},
  );
  const firstNew = best.edges[shared];
  return {
    outcome: "shorter_available",
    route: full,
    progressM: p,
    decisionNode: route.nodes[d]!,
    distanceToDecisionM: Math.max(0, (spans[d]?.startM ?? route.lengthM) - p),
    turnDirection:
      d > 0 && firstNew ? turnAtNode(index, route.edges[d - 1]!, route.nodes[d]!, firstNew) : null,
    savedDistanceM: route.lengthM - full.lengthM,
    savedCostM: Number.isFinite(oldCost) ? oldCost - best.cost : Infinity,
  };
}
