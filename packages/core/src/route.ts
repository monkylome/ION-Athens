/**
 * Shortest path (A*) and Route construction.
 */
import {
  UNKNOWN_CROSSING,
  edgeCost,
  isObstacleActive,
  minCostPerMetre,
  resolveCostOptions,
  surveyUsable,
  type CostOptions,
  type TimeInput,
} from "./cost.ts";
import {
  bearingDeg,
  haversineM,
  pointAlongPolyline,
  polylineLengthM,
  slicePolyline,
  turnDirection,
} from "./geo.ts";
import { orientedGeometry, type GraphIndex } from "./graph.ts";
import type {
  EdgeId,
  GraphEdge,
  LngLat,
  NodeId,
  Obstacle,
  Route,
  RouteStep,
  SurveyNotice,
  TurnDirection,
} from "./types.ts";

export interface RoutingContext {
  /** The moment obstacles are evaluated at. Required when obstacles are given. */
  atTime?: TimeInput;
  obstacles?: readonly Obstacle[];
  cost?: Partial<CostOptions>;
  /** Edges that must not be used, whatever their cost. */
  avoidEdges?: readonly EdgeId[];
}

export type RouteResult =
  | { ok: true; route: Route }
  | { ok: false; reason: "unknown_node" | "no_route"; message: string };

/** Edge costs for one routing context, with obstacles grouped by edge. */
export interface Coster {
  /** Cost with obstacles. Infinity when closed. */
  cost(edge: GraphEdge): number;
  /** Cost ignoring obstacles. */
  baseCost(edge: GraphEdge): number;
  /** Lower bound of cost per metre, used to keep the A* heuristic admissible. */
  minFactor: number;
  /** The resolved cost options. Step notices use surveyMinConfidence from here; defaults when missing. */
  options?: CostOptions;
}

export function createCoster(context: RoutingContext = {}): Coster {
  const options = resolveCostOptions(context.cost);
  const byEdge = new Map<EdgeId, Obstacle[]>();
  const obstacles = context.obstacles ?? [];
  if (obstacles.length > 0 && context.atTime === undefined) {
    throw new TypeError("RoutingContext.atTime is required when obstacles are given");
  }
  const atTime = context.atTime ?? 0;
  for (const o of obstacles) {
    if (!isObstacleActive(o, atTime)) continue;
    const list = byEdge.get(o.edgeId);
    if (list) list.push(o);
    else byEdge.set(o.edgeId, [o]);
  }
  const none: Obstacle[] = [];
  const cache = new Map<EdgeId, number>();
  return {
    cost(edge) {
      let c = cache.get(edge.id);
      if (c === undefined) {
        c = edgeCost(edge, byEdge.get(edge.id) ?? none, atTime, options);
        cache.set(edge.id, c);
      }
      return c;
    },
    baseCost: (edge) => edgeCost(edge, none, atTime, options),
    minFactor: minCostPerMetre(options),
    options,
  };
}

/** Minimal binary heap of [priority, g, node]. */
class MinHeap {
  private items: [number, number, NodeId][] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: [number, number, NodeId]): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent]![0] <= a[i]![0]) break;
      [a[parent], a[i]] = [a[i]!, a[parent]!];
      i = parent;
    }
  }
  pop(): [number, number, NodeId] | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

export interface PathResult {
  nodes: NodeId[];
  edges: EdgeId[];
  cost: number;
}

/** A* over the graph. Returns null when `to` cannot be reached. */
export function searchPath(
  index: GraphIndex,
  from: NodeId,
  to: NodeId,
  coster: Coster,
  forbidden?: ReadonlySet<EdgeId>,
): PathResult | null {
  const target = index.nodes.get(to);
  if (!target || !index.nodes.has(from)) return null;
  const targetLL: LngLat = [target.lng, target.lat];
  const h = (id: NodeId): number => {
    const n = index.nodes.get(id)!;
    return haversineM([n.lng, n.lat], targetLL) * coster.minFactor;
  };
  const g = new Map<NodeId, number>([[from, 0]]);
  const cameFrom = new Map<NodeId, { node: NodeId; edge: EdgeId }>();
  const heap = new MinHeap();
  heap.push([h(from), 0, from]);
  while (heap.size > 0) {
    const [, gAtPush, id] = heap.pop()!;
    const gHere = g.get(id)!;
    if (gAtPush > gHere) continue; // stale entry
    if (id === to) {
      const nodes: NodeId[] = [to];
      const edges: EdgeId[] = [];
      let cur = to;
      for (let step = cameFrom.get(cur); step; step = cameFrom.get(cur)) {
        nodes.push(step.node);
        edges.push(step.edge);
        cur = step.node;
      }
      return { nodes: nodes.reverse(), edges: edges.reverse(), cost: gHere };
    }
    for (const nb of index.adjacency.get(id) ?? []) {
      if (forbidden?.has(nb.edge.id)) continue;
      const c = coster.cost(nb.edge);
      if (!Number.isFinite(c)) continue;
      const next = gHere + c;
      if (next < (g.get(nb.node) ?? Infinity)) {
        g.set(nb.node, next);
        cameFrom.set(nb.node, { node: id, edge: nb.edge.id });
        heap.push([next + h(nb.node), next, nb.node]);
      }
    }
  }
  return null;
}

const BEARING_PROBE_M = 5;

function getEdge(index: GraphIndex, id: EdgeId): GraphEdge {
  const edge = index.edges.get(id);
  if (!edge) throw new Error(`Edge ${id} is not in the graph`);
  return edge;
}

/** Bearing when arriving at `node` along `edge`. */
function bearingInto(index: GraphIndex, edge: GraphEdge, node: NodeId): number {
  const away = orientedGeometry(index, edge, node); // starts at node
  const probe = pointAlongPolyline(away, BEARING_PROBE_M).point;
  return bearingDeg(probe, away[0]!);
}

/** Bearing when leaving `node` along `edge`. */
function bearingOutOf(index: GraphIndex, edge: GraphEdge, node: NodeId): number {
  const away = orientedGeometry(index, edge, node);
  const probe = pointAlongPolyline(away, BEARING_PROBE_M).point;
  return bearingDeg(away[0]!, probe);
}

/** Turn made at `node` when arriving along inEdge and leaving along outEdge. */
export function turnAtNode(
  index: GraphIndex,
  inEdgeId: EdgeId,
  node: NodeId,
  outEdgeId: EdgeId,
): TurnDirection {
  if (inEdgeId === outEdgeId) return "u_turn";
  const inEdge = getEdge(index, inEdgeId);
  const outEdge = getEdge(index, outEdgeId);
  return turnDirection(bearingInto(index, inEdge, node), bearingOutOf(index, outEdge, node));
}

export interface EdgeSpan {
  index: number;
  edgeId: EdgeId;
  fromNode: NodeId;
  toNode: NodeId;
  /** Metres from the start of the route to where this edge begins and ends. */
  startM: number;
  endM: number;
}

/** Where each edge of a route starts and ends, in metres along the route. */
export function routeSpans(index: GraphIndex, route: Route): EdgeSpan[] {
  const spans: EdgeSpan[] = [];
  let at = 0;
  for (let i = 0; i < route.edges.length; i++) {
    const edge = getEdge(index, route.edges[i]!);
    const offset = i === 0 ? Math.min(route.startOffsetM ?? 0, edge.lengthM) : 0;
    const end = at + edge.lengthM - offset;
    spans.push({
      index: i,
      edgeId: edge.id,
      fromNode: route.nodes[i]!,
      toNode: route.nodes[i + 1]!,
      startM: at,
      endM: end,
    });
    at = end;
  }
  return spans;
}

/** A surveyed fact is announced only when it holds for at least this much of the stretch ahead. */
const MIN_NOTICE_LENGTH_M = 20;
/** Tactile guidance "starts" only when there was none on this much of the route just walked: a short gap is not a new start. */
const GUIDANCE_GAP_M = 40;

/**
 * The one surveyed fact worth saying at a step, or undefined. `stretch` is the
 * edges the step leads onto, up to the next step, each with the node it is
 * entered from; `before` is the edges walked up to the step, nearest first,
 * crossings left out.
 *
 * In order: a crossing without ramps, a stretch without pavement, a narrow
 * pavement, tactile guidance beginning. A value that is missing never produces
 * a notice.
 */
function surveyNoticeFor(
  before: readonly GraphEdge[],
  stretch: readonly { edge: GraphEdge; fromNode: NodeId }[],
  options: CostOptions,
): SurveyNotice | undefined {
  const usable = (edge: GraphEdge | undefined): edge is GraphEdge => edge !== undefined && surveyUsable(edge, options);
  const head = stretch[0];
  if (!head) return undefined;
  if (head.edge.kind === "crossing") {
    if (usable(head.edge) && head.edge.crossingRamps === "none") return { kind: "crossing_no_ramp" };
  }
  const walked = stretch.filter((s) => s.edge.kind !== "crossing");
  const first = walked[0];
  if (!first) return undefined;
  const lengthWhere = (test: (edge: GraphEdge) => boolean): number =>
    walked.reduce((sum, s) => (usable(s.edge) && test(s.edge) ? sum + s.edge.lengthM : sum), 0);

  const noPavement = (e: GraphEdge) => e.kind === "shared_road" && e.pavement === "no";
  if (lengthWhere(noPavement) >= MIN_NOTICE_LENGTH_M) return { kind: "no_pavement" };

  // Width is about the pavement walked on: a mapped pavement or footpath, or a street with a surveyed pavement.
  const onPavement = (e: GraphEdge) =>
    e.kind === "sidewalk" || e.kind === "footway" || (e.kind === "shared_road" && e.pavement === "yes");
  const narrow = (e: GraphEdge) => onPavement(e) && e.pavementWidth === "narrow";
  if (usable(first.edge) && narrow(first.edge) && lengthWhere(narrow) >= MIN_NOTICE_LENGTH_M) {
    const previous = before[0];
    const was = usable(previous) && onPavement(previous) ? previous.pavementWidth : undefined;
    if (was === "medium" || was === "wide") return { kind: "pavement_narrows" };
    if (was === undefined) return { kind: "pavement_narrow" };
  }

  const guided = (e: GraphEdge) => e.tactileGuidance === "whole";
  let back = 0;
  let guidedJustBefore = false;
  for (const e of before) {
    if (back >= GUIDANCE_GAP_M) break;
    if (usable(e) && guided(e)) guidedJustBefore = true;
    back += e.lengthM;
  }
  if (usable(first.edge) && guided(first.edge) && !guidedJustBefore && lengthWhere(guided) >= MIN_NOTICE_LENGTH_M) {
    const side = first.edge.survey?.side;
    if (!side) return { kind: "tactile_guidance_starts" };
    // The surveyed side is relative to from -> to; turn it to the walking direction.
    const forward = first.edge.from === first.fromNode;
    return { kind: "tactile_guidance_starts", side: forward ? side : side === "left" ? "right" : "left" };
  }
  return undefined;
}

export interface BuildRouteOptions {
  /** Metres of the first edge to skip: the route starts part-way along it. */
  startOffsetM?: number;
  /** Direction given on the depart step, for example "u_turn" when turning back. */
  departDirection?: TurnDirection;
}

/**
 * Build a Route from a node and edge sequence: length, cost, stitched geometry
 * and steps. `nodes` has one more entry than `edges`.
 */
export function buildRoute(
  index: GraphIndex,
  nodes: readonly NodeId[],
  edgeIds: readonly EdgeId[],
  coster: Coster,
  options: BuildRouteOptions = {},
): Route {
  if (nodes.length !== edgeIds.length + 1) {
    throw new RangeError("buildRoute: nodes must have one more entry than edges");
  }
  const edges = edgeIds.map((id) => getEdge(index, id));
  const firstEdge = edges[0];
  const offset = firstEdge ? Math.min(Math.max(0, options.startOffsetM ?? 0), firstEdge.lengthM) : 0;

  const geometry: LngLat[] = [];
  const push = (p: LngLat) => {
    const last = geometry[geometry.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) geometry.push([p[0], p[1]]);
  };
  let lengthM = 0;
  let cost = 0;
  const startOf: number[] = [];
  edges.forEach((edge, i) => {
    startOf.push(lengthM);
    let line = orientedGeometry(index, edge, nodes[i]!);
    let fraction = 1;
    if (i === 0 && offset > 0) {
      const geomLen = polylineLengthM(line);
      fraction = edge.lengthM > 0 ? (edge.lengthM - offset) / edge.lengthM : 0;
      line = slicePolyline(line, geomLen * (1 - fraction), geomLen);
    }
    line.forEach(push);
    lengthM += edge.lengthM * fraction;
    const c = coster.cost(edge);
    cost += (Number.isFinite(c) ? c : coster.baseCost(edge)) * fraction;
  });
  if (edges.length === 0) {
    const only = index.nodes.get(nodes[0]!);
    if (only) geometry.push([only.lng, only.lat]);
  }

  const steps: RouteStep[] = [];
  /** For each step, the index of the edge it leads onto. */
  const stepEdge: number[] = [];
  const depart: RouteStep = { atNode: nodes[0]!, atDistanceM: 0, kind: "depart" };
  if (options.departDirection) depart.direction = options.departDirection;
  let currentName: string | undefined;
  if (firstEdge) {
    if (firstEdge.kind === "crossing") {
      depart.crossing = { ...(firstEdge.crossing ?? UNKNOWN_CROSSING) };
    } else if (firstEdge.name) {
      depart.onto = firstEdge.name;
      currentName = firstEdge.name;
    }
  }
  steps.push(depart);
  stepEdge.push(0);

  for (let j = 1; j < edges.length; j++) {
    const prev = edges[j - 1]!;
    const next = edges[j]!;
    const node = nodes[j]!;
    const direction = turnAtNode(index, prev.id, node, next.id);
    if (next.kind === "crossing") {
      if (prev.kind === "crossing") continue; // one crossing split in two edges: describe it once
      steps.push({
        atNode: node,
        atDistanceM: startOf[j]!,
        kind: "crossing",
        direction,
        crossing: { ...(next.crossing ?? UNKNOWN_CROSSING) },
      });
      stepEdge.push(j);
      continue;
    }
    const degree = index.adjacency.get(node)?.length ?? 0;
    const slight = direction === "slight_left" || direction === "slight_right";
    // A bend in a pavement (two edges meeting) is only a turn when it is a real change of direction.
    const turns = direction !== "straight" && (degree >= 3 || !slight);
    const renamed = next.name !== undefined && next.name !== currentName;
    if (next.name) currentName = next.name;
    if (!turns && !(renamed && degree >= 3)) continue;
    const step: RouteStep = { atNode: node, atDistanceM: startOf[j]!, kind: "turn", direction };
    if (next.name) step.onto = next.name;
    steps.push(step);
    stepEdge.push(j);
  }
  const costOptions = coster.options ?? resolveCostOptions();
  steps.forEach((step, k) => {
    if (step.kind === "arrive") return;
    const start = stepEdge[k]!;
    const end = stepEdge[k + 1] ?? edges.length;
    const stretch = edges.slice(start, end).map((edge, i) => ({ edge, fromNode: nodes[start + i]! }));
    const before: GraphEdge[] = [];
    for (let i = start - 1; i >= 0; i--) if (edges[i]!.kind !== "crossing") before.push(edges[i]!);
    const notice = surveyNoticeFor(before, stretch, costOptions);
    if (notice) step.surveyNotice = notice;
  });
  steps.push({ atNode: nodes[nodes.length - 1]!, atDistanceM: lengthM, kind: "arrive" });

  const route: Route = {
    nodes: nodes.slice(),
    edges: edgeIds.slice(),
    lengthM,
    cost,
    geometry,
    steps,
  };
  if (offset > 0) route.startOffsetM = offset;
  return route;
}

/**
 * Cheapest route between two nodes under the cost model. Never throws for an
 * unreachable destination: check `ok` on the result.
 */
export function findRoute(
  index: GraphIndex,
  from: NodeId,
  to: NodeId,
  context: RoutingContext = {},
): RouteResult {
  for (const id of [from, to]) {
    if (!index.nodes.has(id)) {
      return { ok: false, reason: "unknown_node", message: `Node ${id} is not in the graph` };
    }
  }
  const coster = createCoster(context);
  const forbidden = context.avoidEdges ? new Set(context.avoidEdges) : undefined;
  const path = searchPath(index, from, to, coster, forbidden);
  if (!path) {
    return { ok: false, reason: "no_route", message: `No walkable route from ${from} to ${to}` };
  }
  return { ok: true, route: buildRoute(index, path.nodes, path.edges, coster) };
}
