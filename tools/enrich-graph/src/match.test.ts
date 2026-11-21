/** The matcher on small hand-made streets. No survey data is used here: every feature below is invented. */
import { describe, expect, it } from "vitest";
import type { EdgeKind, GraphEdge, GraphNode, LngLat, PedestrianGraph } from "@ion/core";
import { DEFAULT_THRESHOLDS } from "./thresholds.ts";
import { matchCrossingEdges, matchRamps, matchSides, type Feature } from "./match.ts";
import { mergeSides, normaliseCrossing, normaliseRamp, normaliseSide, type Props } from "./normalise.ts";
import { Plane, type XY } from "./plane.ts";

const ORIGIN: LngLat = [23.7275, 37.9775];
const plane = new Plane(ORIGIN);
const M_PER_DEG = (Math.PI / 180) * 6371008.8;

/** [x east, y north] in metres to [lng, lat]: the inverse of the plane. */
function at(x: number, y: number): LngLat {
  return [ORIGIN[0] + x / (M_PER_DEG * Math.cos((ORIGIN[1] * Math.PI) / 180)), ORIGIN[1] + y / M_PER_DEG];
}

function graphOf(edges: { id: string; kind: EdgeKind; line: XY[] }[]): PedestrianGraph {
  const nodes: GraphNode[] = [];
  const out: GraphEdge[] = edges.map((e) => {
    const [a, b] = [e.line[0]!, e.line.at(-1)!];
    const ends = [a, b].map((p, i) => {
      const [lng, lat] = at(p[0], p[1]);
      const node: GraphNode = { id: `${e.id}:${i}`, lng, lat, kind: "junction" };
      nodes.push(node);
      return node.id;
    });
    let lengthM = 0;
    for (let i = 1; i < e.line.length; i++) lengthM += Math.hypot(e.line[i]![0] - e.line[i - 1]![0], e.line[i]![1] - e.line[i - 1]![1]);
    return { id: e.id, from: ends[0]!, to: ends[1]!, lengthM, kind: e.kind, geometry: e.line.map((p) => at(p[0], p[1])) };
  });
  return {
    meta: { bbox: [0, 0, 0, 0], builtAt: "test", source: "test", licence: "test", attribution: "test", nodeCount: nodes.length, edgeCount: out.length },
    nodes,
    edges: out,
  };
}

const GOOD: Props = { A_271: 2, A_272: 3, A_273: 3, A_29: 2, ...flags(1) };
const POOR: Props = { A_271: 3, A_272: 1, A_273: 1, A_29: 1, ...flags(1), A_2109: 2 };
const NONE: Props = { A_271: 1, A_272: 4, A_273: 5, A_29: 1, ...flags(1) };

function flags(value: number): Props {
  return Object.fromEntries(
    ["A_2101", "A_2105", "A_2106", "A_2107", "A_2109", "A_2110", "A_2112", "A_2113", "A_21014"].map((k) => [k, value]),
  );
}

const side = (id: number, props: Props, ...line: XY[]): Feature => ({ id, props, lines: [line] });
const t = DEFAULT_THRESHOLDS;
/** A street axis drawn west to east, 80 m long: north is its left. */
const street = (kind: EdgeKind = "shared_road") => graphOf([{ id: "e", kind, line: [[0, 0], [80, 0]] }]);
const entryOf = (graph: PedestrianGraph, sides: Feature[], id = "e") =>
  matchSides(plane, graph, sides, t).find((o) => o.edge.id === id)!.entry;

describe("block sides to edges", () => {
  it("keeps both sides of a street axis as left and right and names the better one", () => {
    const entry = entryOf(street(), [side(1, POOR, [0, 5], [80, 5]), side(2, GOOD, [80, -6], [0, -6])])!;
    expect(entry.left).toMatchObject({ pavement: "yes", pavementWidth: "narrow", pavementCondition: "poor", fixedObstacles: ["pole_or_bollard"] });
    expect(entry.right).toMatchObject({ pavement: "yes", pavementWidth: "wide", pavementCondition: "good", tactileGuidance: "whole", fixedObstacles: [] });
    expect(entry.better).toBe("right");
    expect(entry.left!.survey).toMatchObject({ featureIds: [1], distanceM: 5, year: 2022 });
    expect(entry.right!.survey.distanceM).toBe(6);
    expect(entry.left!.survey.confidence).toBeGreaterThan(0.8);
    expect(entry.lengthM).toBeCloseTo(80, 3);
  });

  it("does not match a side that runs across the edge, is too far, or lies beside too little of it", () => {
    expect(entryOf(street(), [side(1, GOOD, [40, 2], [40, 60])])).toBeUndefined();
    expect(entryOf(street(), [side(1, GOOD, [0, 20], [80, 20])])).toBeUndefined();
    expect(entryOf(street(), [side(1, GOOD, [0, 5], [30, 5])])).toBeUndefined();
  });

  it("lowers confidence with distance", () => {
    const near = entryOf(street(), [side(1, GOOD, [0, 3], [80, 3])])!.left!.survey.confidence;
    const far = entryOf(street(), [side(1, GOOD, [0, 12], [80, 12])])!.left!.survey.confidence;
    expect(far).toBeLessThan(near);
    expect(far).toBeGreaterThanOrEqual(t.minConfidence);
  });

  it("does not take a side that lies beyond another street", () => {
    const graph = graphOf([
      { id: "e", kind: "shared_road", line: [[0, 0], [80, 0]] },
      { id: "other", kind: "shared_road", line: [[0, 6], [80, 6]] },
    ]);
    const sides = [side(1, GOOD, [0, 10], [80, 10])];
    expect(entryOf(graph, sides)).toBeUndefined();
    expect(entryOf(graph, sides, "other")!.left!.survey.featureIds).toEqual([1]);
  });

  it("gives a mapped pavement the nearer side only", () => {
    const graph = graphOf([{ id: "e", kind: "sidewalk", line: [[0, 0], [80, 0]] }]);
    const entry = entryOf(graph, [side(1, GOOD, [0, 2], [80, 2]), side(2, POOR, [0, -7], [80, -7])])!;
    expect(entry.side!.survey.featureIds).toEqual([1]);
    expect(entry.left).toBeUndefined();
    expect(entry.right).toBeUndefined();
  });

  it("leaves a street unknown when its only matched side has no pavement", () => {
    const entry = entryOf(street(), [side(1, NONE, [0, 5], [80, 5])])!;
    expect(entry.left!.pavement).toBe("no");
    expect(entry.better).toBeUndefined();
    const both = entryOf(street(), [side(1, NONE, [0, 5], [80, 5]), side(2, NONE, [0, -5], [80, -5])])!;
    expect(both.better).toBeDefined();
  });

  it("reads two block sides along one edge cautiously", () => {
    const entry = entryOf(street(), [side(1, GOOD, [0, 5], [40, 5]), side(2, POOR, [40, 5], [80, 5])])!;
    expect(entry.left).toMatchObject({ pavementWidth: "narrow", pavementCondition: "poor", tactileGuidance: "part", pavementWidthVaries: true });
    expect(entry.left!.survey.featureIds!.sort()).toEqual([1, 2]);
  });

  it("does not match steps, paths or very short edges", () => {
    const graph = graphOf([
      { id: "steps", kind: "steps", line: [[0, 0], [80, 0]] },
      { id: "short", kind: "shared_road", line: [[0, 0], [6, 0]] },
    ]);
    const outcomes = matchSides(plane, graph, [side(1, GOOD, [0, 3], [80, 3])], t);
    expect(outcomes.every((o) => o.entry === undefined)).toBe(true);
  });
});

describe("crossings and ramps", () => {
  const crossingGraph = () => graphOf([{ id: "c", kind: "crossing", line: [[0, 0], [0, 10]] }]);
  const line = (id: number, props: Props, ...l: XY[]): Feature => ({ id, props, lines: [l] });

  it("matches a crossing edge to the survey line beside it that runs the same way", () => {
    const [outcome] = matchCrossingEdges(plane, crossingGraph(), [line(7, { Category: 1, B_21: 2, B_22: 1 }, [3, 0], [3, 10])], t);
    expect(outcome!.result).toMatchObject({ markings: "clear", ramps: "none", survey: { featureIds: [7], distanceM: 3 } });
  });

  it("ignores a line across the edge, one too far away, and one with no data", () => {
    const result = (f: Feature) => matchCrossingEdges(plane, crossingGraph(), [f], t)[0]!.result;
    expect(result(line(1, { Category: 1, B_21: 2, B_22: 3 }, [-5, 5], [5, 5]))).toBe("no_candidate");
    expect(result(line(1, { Category: 1, B_21: 2, B_22: 3 }, [15, 0], [15, 10]))).toBe("no_candidate");
    expect(result(line(1, { Category: 2, B_21: 0, B_22: 0 }, [1, 0], [1, 10]))).toBe("no_candidate");
  });

  it("refuses to choose between two near lines that say different things", () => {
    const lines = [
      line(1, { Category: 1, B_21: 2, B_22: 3 }, [3, 0], [3, 10]),
      line(2, { Category: 1, B_21: 1, B_22: 1 }, [-4, 0], [-4, 10]),
    ];
    expect(matchCrossingEdges(plane, crossingGraph(), lines, t)[0]!.result).toBe("ambiguous");
    lines[1] = line(2, { Category: 1, B_21: 2, B_22: 3 }, [-4, 0], [-4, 10]);
    expect(matchCrossingEdges(plane, crossingGraph(), lines, t)[0]!.result).toMatchObject({ markings: "clear" });
  });

  it("gives the end node of a crossing its nearest ramp", () => {
    const ramp = (id: number, x: number, y: number, props: Props): Feature => ({ id, props, lines: [[[x, y]]] });
    const out = matchRamps(plane, crossingGraph(), [ramp(1, 1, -1, { B_23: 3, B_24: 2 }), ramp(2, 3, -3, { B_23: 1, B_24: 1 }), ramp(3, 30, 30, { B_23: 3, B_24: 2 })], t);
    expect(Object.keys(out.nodes)).toEqual(["c:0"]);
    expect(out.nodes["c:0"]!.ramp).toMatchObject({ condition: "good", manoeuvringSpace: "yes", survey: { featureIds: [1] } });
  });
});

describe("survey codes", () => {
  it("reads 0 as no data, never as none", () => {
    expect(normaliseSide({ A_271: 0, A_272: 0, A_273: 0, A_29: 0, ...flags(0) })).toEqual({});
    expect(normaliseCrossing({ Category: 1, B_21: 0, B_22: 0 })).toBeNull();
    expect(normaliseCrossing({ Category: 1, B_21: 3, B_22: 0 })).toEqual({ markings: "worn" });
    expect(normaliseRamp({ B_23: 0, B_24: 0 })).toBeNull();
  });

  it("leaves out what the codes contradict or cannot say today", () => {
    // A_271 says no pavement, the width code says 1 to 2 m.
    expect(normaliseSide({ A_271: 1, A_272: 2, A_273: 2, A_29: 1, ...flags(1) })).toEqual({ tactileGuidance: "none" });
    // Works in progress in the survey year: the condition is not known.
    expect(normaliseSide({ A_271: 2, A_272: 3, A_273: 4, A_29: 1, ...flags(1) }).pavementCondition).toBeUndefined();
    expect(normaliseRamp({ B_23: 2, B_24: 2 })).toEqual({ manoeuvringSpace: "yes" });
    expect(normaliseCrossing({ Category: 4, B_21: 1, B_22: 1 })).toBeNull();
  });

  it("does not read the codes whose meaning is not established, nor movable obstacles", () => {
    const withUnknown = normaliseSide({ ...GOOD, A_21015: 2, "Εμπόδ": "2", A_219: 2, No_Data: 2, A_2104: 2, A_2108: 2, A_2111: 2 });
    expect(withUnknown).toEqual(normaliseSide(GOOD));
    expect(withUnknown.fixedObstacles).toEqual([]);
  });

  it("merges sides towards the worse value and drops what one of them lacks", () => {
    const merged = mergeSides([normaliseSide(GOOD), normaliseSide({ ...GOOD, A_273: 0 })]);
    expect(merged.pavementCondition).toBeUndefined();
    expect(merged.pavementWidth).toBe("wide");
    expect(mergeSides([normaliseSide(GOOD), normaliseSide(NONE)]).pavement).toBeUndefined();
  });
});
