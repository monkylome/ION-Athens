/**
 * Walker simulation for the demo. Deterministic: the state depends only on the
 * route and the elapsed time (or distance) passed in.
 */
import { pointAlongPolyline, polylineLengthM } from "./geo.ts";
import { orientedGeometry, type GraphIndex } from "./graph.ts";
import { routeSpans } from "./route.ts";
import type { EdgeId, LngLat, Route, RouteStep } from "./types.ts";

export const DEFAULT_WALKING_SPEED_MPS = 1.0;

export interface WalkerOptions {
  /** Metres per second. Default 1.0. */
  speedMps?: number;
  /** Distance already walked at elapsed time 0. Default 0. */
  startDistanceM?: number;
}

export interface WalkerState {
  /** Metres walked from the start of the route, clamped to its length. */
  distanceM: number;
  remainingM: number;
  position: LngLat;
  /** Heading in degrees clockwise from north. */
  bearing: number;
  /** Edge the walker is on. null only for a route without edges. */
  edgeId: EdgeId | null;
  edgeIndex: number;
  arrived: boolean;
  /** The next step still ahead, or null once arrived. */
  nextStep: RouteStep | null;
  distanceToNextStepM: number | null;
}

/** Walker state after walking `distanceM` metres along the route. */
export function walkerAtDistance(index: GraphIndex, route: Route, distanceM: number): WalkerState {
  const d = Math.min(Math.max(0, Number.isFinite(distanceM) ? distanceM : 0), route.lengthM);
  const arrived = d >= route.lengthM;
  const spans = routeSpans(index, route);

  let position: LngLat;
  let bearing = 0;
  let edgeId: EdgeId | null = null;
  let edgeIndex = -1;
  if (spans.length === 0) {
    const g = route.geometry[0];
    const node = index.nodes.get(route.nodes[0] ?? "");
    position = g ? [g[0], g[1]] : node ? [node.lng, node.lat] : [0, 0];
  } else {
    let span = spans.find((s) => s.endM > d);
    span ??= spans[spans.length - 1]!;
    const edge = index.edges.get(span.edgeId)!;
    const line = orientedGeometry(index, edge, span.fromNode);
    const offset = span.index === 0 ? (route.startOffsetM ?? 0) : 0;
    const alongEdge = offset + (d - span.startM);
    const fraction = edge.lengthM > 0 ? Math.min(1, alongEdge / edge.lengthM) : 1;
    const at = pointAlongPolyline(line, fraction * polylineLengthM(line));
    position = at.point;
    bearing = at.bearing;
    edgeId = span.edgeId;
    edgeIndex = span.index;
  }

  const nextStep = arrived ? null : (route.steps.find((s) => s.atDistanceM > d) ?? null);
  return {
    distanceM: d,
    remainingM: route.lengthM - d,
    position,
    bearing,
    edgeId,
    edgeIndex,
    arrived,
    nextStep,
    distanceToNextStepM: nextStep ? nextStep.atDistanceM - d : null,
  };
}

/** Walker state `elapsedS` seconds after setting off at a constant speed. */
export function walkerAt(
  index: GraphIndex,
  route: Route,
  elapsedS: number,
  options: WalkerOptions = {},
): WalkerState {
  const speed = options.speedMps ?? DEFAULT_WALKING_SPEED_MPS;
  const start = options.startDistanceM ?? 0;
  return walkerAtDistance(index, route, start + Math.max(0, elapsedS) * speed);
}
