/**
 * Matching survey features to graph edges and nodes by geometry alone: the
 * survey has no street names and no OpenStreetMap ids.
 *
 * Block sides: an edge is sampled every few metres. At each sample the nearest
 * block side on the left and the nearest on the right are looked up, counting
 * only sides that run beside the sample (not past their end) and in the same
 * direction as the edge. A side is accepted for the edge when it covers enough
 * of the samples; otherwise the edge stays without survey data.
 */
import {
  DEFAULT_COST_OPTIONS,
  SURVEY_SOURCE,
  SURVEY_YEAR,
  pavementFactor,
  tactileFactor,
  type EdgeEnrichment,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type NodeEnrichment,
  type PavementSurvey,
  type PedestrianGraph,
  type SurveyNote,
  type SurveyedCrossing,
  type SurveyedSide,
} from "@ion/core";
import { mergeSides, normaliseCrossing, normaliseRamp, normaliseSide, type Props } from "./normalise.ts";
import {
  Grid,
  Plane,
  dist,
  lineAngleDeg,
  midpoint,
  polylineLength,
  projectOntoSegment,
  samplePolyline,
  segmentsCross,
  type Sample,
  type Segment,
  type XY,
} from "./plane.ts";

export interface Thresholds {
  /** Largest mean distance between a street axis and a block side beside it. */
  roadSideMaxDistanceM: number;
  /** Largest mean distance between a mapped pavement (`sidewalk`) and its block side. */
  pavementSideMaxDistanceM: number;
  /** Largest mean distance between a `footway` and a block side it runs along. */
  footwaySideMaxDistanceM: number;
  /** Largest difference in direction between an edge and a block side. */
  sideMaxAngleDeg: number;
  /** A block side may be this far past its end and still count as beside a sample. */
  sideEndSlackM: number;
  /** Distance between samples along an edge. */
  sampleStepM: number;
  /** Edges shorter than this are not matched to block sides: too little to compare directions on. */
  minEdgeLengthM: number;
  /** Share of an edge's samples that must have the side beside them. */
  minCoverage: number;
  /** A block side counts for an edge when it lies beside at least this share of the samples. */
  minFeatureShare: number;
  /** Matches below this confidence are dropped. */
  minConfidence: number;
  /** Largest distance between the middle of a crossing edge and the middle of a survey crossing line. */
  crossingMaxDistanceM: number;
  crossingMaxAngleDeg: number;
  /** Largest distance between a crossing node and a survey crossing line. */
  nodeCrossingMaxDistanceM: number;
  /** A second candidate this close to the best one, saying something else, makes the match ambiguous. */
  ambiguityMarginM: number;
  /** Largest distance between a ramp point and the end node of a crossing. */
  rampMaxDistanceM: number;
}

export interface Feature {
  id: number;
  props: Props;
  lines: XY[][];
}

export interface SurveyLayers {
  sides: Feature[];
  crossings: Feature[];
  ramps: Feature[];
}

interface GeoJsonFeature {
  properties: Props;
  geometry: { type: string; coordinates: unknown };
}

export function toFeatures(plane: Plane, collection: { features: GeoJsonFeature[] }): Feature[] {
  return collection.features.map((f, i) => {
    const g = f.geometry;
    const raw =
      g.type === "Point"
        ? [[g.coordinates as number[]]]
        : g.type === "LineString"
          ? [g.coordinates as number[][]]
          : (g.coordinates as number[][][]);
    const id = typeof f.properties.OBJECTID === "number" ? f.properties.OBJECTID : i;
    return { id, props: f.properties, lines: raw.map((line) => line.map((p) => plane.toXY(p))) };
  });
}

function segmentGrid(features: Feature[]): Grid<Segment> {
  const grid = new Grid<Segment>();
  features.forEach((f, index) => {
    for (const line of f.lines) {
      for (let i = 1; i < line.length; i++) {
        const seg: Segment = { a: line[i - 1]!, b: line[i]!, feature: index };
        grid.addSegment(seg.a, seg.b, seg);
      }
    }
  });
  return grid;
}

interface SideHit {
  feature: number;
  distance: number;
  angle: number;
}

/**
 * Nearest block side on each hand of a sample. A side with another street axis
 * between it and the sample belongs to that other street (the far carriageway
 * of an avenue, a service road, the next street): it is not taken, and nothing
 * further away on that hand is taken in its place.
 */
function sideHitsAt(
  sample: Sample,
  grid: Grid<Segment>,
  maxDistanceM: number,
  t: Thresholds,
  axes: Grid<Segment>,
  self: number,
): { left?: SideHit; right?: SideHit } {
  const out: { left?: SideHit & { point: XY }; right?: SideHit & { point: XY } } = {};
  for (const seg of grid.near(sample.point, maxDistanceM)) {
    const p = projectOntoSegment(sample.point, seg.a, seg.b);
    if (p.distance > maxDistanceM) continue;
    if (p.along < -t.sideEndSlackM || p.along > p.length + t.sideEndSlackM) continue; // past the end of the side
    const angle = lineAngleDeg(sample.direction, [seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]]);
    if (angle > t.sideMaxAngleDeg) continue;
    // Positive cross product: the side lies to the left of the direction of the edge.
    const cross =
      sample.direction[0] * (p.point[1] - sample.point[1]) - sample.direction[1] * (p.point[0] - sample.point[0]);
    const hand = cross >= 0 ? "left" : "right";
    const best = out[hand];
    if (!best || p.distance < best.distance) {
      out[hand] = { feature: seg.feature, distance: p.distance, angle, point: p.point };
    }
  }
  for (const hand of ["left", "right"] as const) {
    const hit = out[hand];
    if (!hit) continue;
    for (const axis of axes.near(sample.point, hit.distance)) {
      if (axis.feature !== self && segmentsCross(sample.point, hit.point, axis.a, axis.b)) {
        delete out[hand];
        break;
      }
    }
  }
  return out;
}

export interface SideMatch {
  features: number[];
  coverage: number;
  distanceM: number;
  angleDeg: number;
  confidence: number;
}

export type Rejection = "no_candidate" | "low_coverage" | "too_far" | "low_confidence" | "no_data";

/**
 * Confidence of a side match, 0 to 1: the share of the edge the side lies
 * beside, lowered as the side gets far for its kind and as directions differ.
 */
export function sideConfidence(coverage: number, distanceM: number, angleDeg: number, maxDistanceM: number, t: Thresholds): number {
  const far = Math.min(1, distanceM / maxDistanceM);
  const skew = Math.min(1, angleDeg / t.sideMaxAngleDeg);
  return coverage * (1 - 0.3 * far) * (1 - 0.2 * skew);
}

function aggregateSide(
  hits: (SideHit | undefined)[],
  maxDistanceM: number,
  t: Thresholds,
): SideMatch | Rejection {
  const n = hits.length;
  const per = new Map<number, { count: number; distance: number; angle: number }>();
  for (const h of hits) {
    if (!h) continue;
    const e = per.get(h.feature) ?? { count: 0, distance: 0, angle: 0 };
    e.count++;
    e.distance += h.distance;
    e.angle += h.angle;
    per.set(h.feature, e);
  }
  if (per.size === 0) return "no_candidate";
  const kept = [...per.entries()].filter(([, e]) => e.count / n >= t.minFeatureShare).sort((a, b) => b[1].count - a[1].count);
  const count = kept.reduce((s, [, e]) => s + e.count, 0);
  const coverage = count / n;
  if (coverage < t.minCoverage) return "low_coverage";
  const distanceM = kept.reduce((s, [, e]) => s + e.distance, 0) / count;
  const angleDeg = kept.reduce((s, [, e]) => s + e.angle, 0) / count;
  if (distanceM > maxDistanceM) return "too_far";
  const confidence = sideConfidence(coverage, distanceM, angleDeg, maxDistanceM, t);
  if (confidence < t.minConfidence) return "low_confidence";
  return { features: kept.map(([f]) => f), coverage, distanceM, angleDeg, confidence };
}

const round = (v: number, digits = 2) => Number(v.toFixed(digits));

function note(confidence: number, featureIds: number[], distanceM: number): SurveyNote {
  return { source: SURVEY_SOURCE, year: SURVEY_YEAR, confidence: round(confidence), featureIds, distanceM: round(distanceM, 1) };
}

/** Kinds matched to block sides. Crossings are matched to crossing lines; steps and paths are left alone. */
export const SIDE_KINDS: readonly EdgeKind[] = ["shared_road", "pedestrian", "sidewalk", "footway"];
const AXIS_KINDS: readonly EdgeKind[] = ["shared_road", "pedestrian"];

export interface SideOutcome {
  edge: GraphEdge;
  left: SideMatch | Rejection;
  right: SideMatch | Rejection;
  entry?: EdgeEnrichment;
}

/** How good a side is to walk on under the default cost model. Lower is better. */
function sideRank(kind: EdgeKind, side: PavementSurvey): number {
  return pavementFactor(kind, side, DEFAULT_COST_OPTIONS) * tactileFactor(undefined, side, DEFAULT_COST_OPTIONS);
}

export function matchSides(plane: Plane, graph: PedestrianGraph, sides: Feature[], t: Thresholds): SideOutcome[] {
  const grid = segmentGrid(sides);
  const normalised = sides.map((f) => normaliseSide(f.props));
  const lines = graph.edges.map((edge) => edge.geometry.map((p) => plane.toXY(p)));
  const axes = new Grid<Segment>();
  graph.edges.forEach((edge, index) => {
    if (!AXIS_KINDS.includes(edge.kind)) return;
    const line = lines[index]!;
    for (let i = 1; i < line.length; i++) axes.addSegment(line[i - 1]!, line[i]!, { a: line[i - 1]!, b: line[i]!, feature: index });
  });
  const out: SideOutcome[] = [];
  for (const [index, edge] of graph.edges.entries()) {
    if (!SIDE_KINDS.includes(edge.kind)) continue;
    const line = lines[index]!;
    const length = polylineLength(line);
    if (length < t.minEdgeLengthM) {
      out.push({ edge, left: "no_candidate", right: "no_candidate" });
      continue;
    }
    const axis = AXIS_KINDS.includes(edge.kind);
    const maxDistanceM = axis
      ? t.roadSideMaxDistanceM
      : edge.kind === "sidewalk"
        ? t.pavementSideMaxDistanceM
        : t.footwaySideMaxDistanceM;
    const samples = samplePolyline(line, Math.max(3, Math.ceil(length / t.sampleStepM)));
    const hits = samples.map((s) => sideHitsAt(s, grid, maxDistanceM, t, axes, index));
    const build = (hand: "left" | "right"): { match: SideMatch | Rejection; side?: SurveyedSide } => {
      const match = aggregateSide(hits.map((h) => h[hand]), maxDistanceM, t);
      if (typeof match === "string") return { match };
      const values = mergeSides(match.features.map((f) => normalised[f]!));
      if (Object.keys(values).length === 0) return { match: "no_data" };
      return {
        match,
        side: { ...values, survey: note(match.confidence, match.features.map((f) => sides[f]!.id), match.distanceM) },
      };
    };
    const left = build("left");
    const right = build("right");
    const outcome: SideOutcome = { edge, left: left.match, right: right.match };
    if (left.side || right.side) {
      const entry: EdgeEnrichment = { lengthM: edge.lengthM };
      if (edge.kind === "sidewalk" && left.side && right.side) {
        // A mapped pavement belongs to one block: the nearer side.
        entry.side = left.side.survey.distanceM! <= right.side.survey.distanceM! ? left.side : right.side;
      } else if (!axis && !(left.side && right.side)) {
        entry.side = (left.side ?? right.side)!;
      } else {
        if (left.side) entry.left = left.side;
        if (right.side) entry.right = right.side;
        if (left.side && right.side) {
          const l = sideRank(edge.kind, left.side);
          const r = sideRank(edge.kind, right.side);
          entry.better = l < r || (l === r && left.side.survey.confidence >= right.side.survey.confidence) ? "left" : "right";
        } else {
          // One side known. "No pavement" on it says nothing about the other side: the street stays unknown.
          const only = (left.side ?? right.side)!;
          if (!(edge.kind === "shared_road" && only.pavement !== "yes")) entry.better = left.side ? "left" : "right";
        }
      }
      outcome.entry = entry;
    }
    out.push(outcome);
  }
  return out;
}

export interface CrossingOutcome {
  id: string;
  /** Distance to the nearest candidate that passed the direction test, whatever the distance limit. */
  nearestM?: number;
  result: SurveyedCrossing | "no_candidate" | "ambiguous" | "low_confidence";
}

interface Candidate {
  feature: number;
  distance: number;
  angle: number;
}

function pickCrossing(
  candidates: Candidate[],
  crossings: Feature[],
  values: (ReturnType<typeof normaliseCrossing>)[],
  maxDistanceM: number,
  maxAngleDeg: number,
  t: Thresholds,
): CrossingOutcome["result"] {
  const within = candidates.filter((c) => c.distance <= maxDistanceM).sort((a, b) => a.distance - b.distance);
  const best = within[0];
  if (!best) return "no_candidate";
  const mine = values[best.feature]!;
  const rival = within.find(
    (c) =>
      c.feature !== best.feature &&
      c.distance - best.distance <= t.ambiguityMarginM &&
      (values[c.feature]!.markings !== mine.markings || values[c.feature]!.ramps !== mine.ramps),
  );
  if (rival) return "ambiguous";
  const confidence = (1 - 0.5 * (best.distance / maxDistanceM)) * (1 - 0.2 * Math.min(1, best.angle / maxAngleDeg));
  if (confidence < t.minConfidence) return "low_confidence";
  return { ...mine, survey: note(confidence, [crossings[best.feature]!.id], best.distance) };
}

/** Survey crossing lines to crossing edges: middle to middle, running the same way. */
export function matchCrossingEdges(
  plane: Plane,
  graph: PedestrianGraph,
  crossings: Feature[],
  t: Thresholds,
): CrossingOutcome[] {
  const values = crossings.map((f) => normaliseCrossing(f.props));
  const mids = crossings.map((f) => midpoint(f.lines[0] ?? []));
  const grid = new Grid<number>();
  crossings.forEach((f, i) => {
    if (values[i] && f.lines[0] && f.lines[0].length >= 2) grid.addPoint(mids[i]!.point, i);
  });
  const out: CrossingOutcome[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "crossing") continue;
    const mid = midpoint(edge.geometry.map((p) => plane.toXY(p)));
    const candidates: Candidate[] = [];
    for (const i of grid.near(mid.point, 30)) {
      const angle = lineAngleDeg(mid.direction, mids[i]!.direction);
      if (angle > t.crossingMaxAngleDeg) continue;
      candidates.push({ feature: i, distance: dist(mid.point, mids[i]!.point), angle });
    }
    const nearestM = candidates.length ? Math.min(...candidates.map((c) => c.distance)) : undefined;
    out.push({
      id: edge.id,
      ...(nearestM !== undefined ? { nearestM } : {}),
      result: pickCrossing(candidates, crossings, values, t.crossingMaxDistanceM, t.crossingMaxAngleDeg, t),
    });
  }
  return out;
}

/**
 * Survey crossing lines to crossing nodes that are not an end of a crossing
 * edge: places where a pavement or path crosses a street at a single node.
 * The line must pass close to the node and run across the street there.
 */
export function matchCrossingNodes(
  plane: Plane,
  graph: PedestrianGraph,
  crossings: Feature[],
  t: Thresholds,
): CrossingOutcome[] {
  const values = crossings.map((f) => normaliseCrossing(f.props));
  const grid = segmentGrid(crossings);
  const onCrossingEdge = new Set<string>();
  const roadsAt = new Map<string, XY[]>();
  for (const edge of graph.edges) {
    if (edge.kind === "crossing") {
      onCrossingEdge.add(edge.from);
      onCrossingEdge.add(edge.to);
    }
    if (edge.kind !== "shared_road" || edge.geometry.length < 2) continue;
    const line = edge.geometry.map((p) => plane.toXY(p));
    const first: XY = [line[1]![0] - line[0]![0], line[1]![1] - line[0]![1]];
    const last: XY = [line.at(-1)![0] - line.at(-2)![0], line.at(-1)![1] - line.at(-2)![1]];
    for (const [node, direction] of [[edge.from, first], [edge.to, last]] as const) {
      const list = roadsAt.get(node);
      if (list) list.push(direction);
      else roadsAt.set(node, [direction]);
    }
  }
  const out: CrossingOutcome[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "crossing" || onCrossingEdge.has(node.id)) continue;
    const roads = roadsAt.get(node.id);
    if (!roads) {
      out.push({ id: node.id, result: "no_candidate" });
      continue;
    }
    const p = plane.toXY([node.lng, node.lat]);
    const best = new Map<number, Candidate>();
    for (const seg of grid.near(p, 30)) {
      if (!values[seg.feature]) continue;
      const direction: XY = [seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]];
      // Across the street: far from parallel to every road edge at the node.
      const across = Math.min(...roads.map((r) => lineAngleDeg(r, direction)));
      const angle = 90 - across;
      if (angle > t.crossingMaxAngleDeg) continue;
      const distance = projectOntoSegment(p, seg.a, seg.b).distance;
      const known = best.get(seg.feature);
      if (!known || distance < known.distance) best.set(seg.feature, { feature: seg.feature, distance, angle });
    }
    const candidates = [...best.values()];
    const nearestM = candidates.length ? Math.min(...candidates.map((c) => c.distance)) : undefined;
    out.push({
      id: node.id,
      ...(nearestM !== undefined ? { nearestM } : {}),
      result: pickCrossing(candidates, crossings, values, t.nodeCrossingMaxDistanceM, t.crossingMaxAngleDeg, t),
    });
  }
  return out;
}

export interface RampOutcome {
  nodes: Record<string, NodeEnrichment>;
  /** Distance from every ramp with data to the nearest crossing end, whatever the limit. */
  nearestM: number[];
  matched: number;
  total: number;
}

/** Ramp points to the nodes where crossings end. Each node takes its nearest ramp. */
export function matchRamps(plane: Plane, graph: PedestrianGraph, ramps: Feature[], t: Thresholds): RampOutcome {
  const ends = new Map<string, GraphNode>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const edge of graph.edges) {
    if (edge.kind !== "crossing") continue;
    for (const id of [edge.from, edge.to]) {
      const n = byId.get(id);
      if (n) ends.set(id, n);
    }
  }
  const grid = new Grid<{ id: string; p: XY }>();
  for (const n of ends.values()) {
    const p = plane.toXY([n.lng, n.lat]);
    grid.addPoint(p, { id: n.id, p });
  }
  const best = new Map<string, { distance: number; ramp: number }>();
  const nearestM: number[] = [];
  let total = 0;
  ramps.forEach((f, i) => {
    const p = f.lines[0]?.[0];
    if (!p || !normaliseRamp(f.props)) return;
    total++;
    let near: { id: string; distance: number } | undefined;
    for (const n of grid.near(p, 30)) {
      const d = dist(p, n.p);
      if (!near || d < near.distance) near = { id: n.id, distance: d };
    }
    if (!near) return;
    nearestM.push(near.distance);
    if (near.distance > t.rampMaxDistanceM) return;
    const known = best.get(near.id);
    if (!known || near.distance < known.distance) best.set(near.id, { distance: near.distance, ramp: i });
  });
  const nodes: Record<string, NodeEnrichment> = {};
  for (const [id, b] of best) {
    const confidence = 1 - 0.5 * (b.distance / t.rampMaxDistanceM);
    if (confidence < t.minConfidence) continue;
    const f = ramps[b.ramp]!;
    nodes[id] = { ramp: { ...normaliseRamp(f.props)!, survey: note(confidence, [f.id], b.distance) } };
  }
  return { nodes, nearestM, matched: Object.keys(nodes).length, total };
}
