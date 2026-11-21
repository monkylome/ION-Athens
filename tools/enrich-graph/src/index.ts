/**
 * Joins the City of Athens pavement survey ("Walkable Athens", NTUA 2022) to
 * the ION pedestrian graph and writes an enrichment file.
 *
 *   tsx src/index.ts [--graph path] [--survey dir] [--out path] [--measure]
 *
 * The survey is not licensed for redistribution. It is read from data-local/
 * and everything derived from it is written to data-local/, which is ignored
 * by git. --measure matches with wide limits and prints the distributions the
 * thresholds below were chosen from; it writes nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SURVEY_SOURCE,
  SURVEY_YEAR,
  type EdgeEnrichment,
  type EdgeKind,
  type GraphEnrichment,
  type NodeEnrichment,
  type PedestrianGraph,
} from "@ion/core";
import {
  SIDE_KINDS,
  matchCrossingEdges,
  matchCrossingNodes,
  matchRamps,
  matchSides,
  toFeatures,
  type CrossingOutcome,
  type SideMatch,
  type SideOutcome,
  type Thresholds,
} from "./match.ts";
import { OMITTED_CODES } from "./normalise.ts";
import { DEFAULT_THRESHOLDS } from "./thresholds.ts";
import { Plane } from "./plane.ts";

/** Wide limits for --measure: what would match if almost anything were allowed. */
const MEASURE_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  ...DEFAULT_THRESHOLDS,
  roadSideMaxDistanceM: 30,
  pavementSideMaxDistanceM: 30,
  footwaySideMaxDistanceM: 30,
  sideMaxAngleDeg: 45,
  minConfidence: 0,
  crossingMaxDistanceM: 30,
  crossingMaxAngleDeg: 60,
  nodeCrossingMaxDistanceM: 30,
  rampMaxDistanceM: 30,
});

interface Args {
  graph: string;
  survey: string;
  out: string;
  measure: boolean;
}

function parseArgs(argv: string[]): Args {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const args: Args = {
    graph: resolve(root, "data/athens-centre.graph.json"),
    survey: resolve(root, "data-local/walkable-athens"),
    out: resolve(root, "data-local/athens-centre.enrichment.json"),
    measure: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const flag = arg.split("=")[0];
    const value = () => {
      const v = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return resolve(v);
    };
    if (flag === "--measure") args.measure = true;
    else if (flag === "--graph") args.graph = value();
    else if (flag === "--survey") args.survey = value();
    else if (flag === "--out") args.out = value();
    else throw new Error(`Unknown argument ${arg}`);
  }
  return args;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function quantiles(values: number[]): string {
  if (values.length === 0) return "none";
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(1);
  return `n=${s.length}  p10 ${q(0.1)}  p25 ${q(0.25)}  p50 ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}  p95 ${q(0.95)}  max ${s.at(-1)!.toFixed(1)}`;
}

function histogram(values: number[], edges: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < edges.length; i++) {
    const lo = edges[i]!;
    const hi = edges[i + 1] ?? Infinity;
    const n = values.filter((v) => v >= lo && v < hi).length;
    parts.push(`${lo}${hi === Infinity ? "+" : `-${hi}`} m: ${n}`);
  }
  return parts.join(", ");
}

const pct = (part: number, whole: number) => (whole === 0 ? "0%" : `${((100 * part) / whole).toFixed(1)}%`);
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const isMatch = (m: SideOutcome["left"]): m is SideMatch => typeof m !== "string";

function printMeasure(sides: SideOutcome[], crossingEdges: CrossingOutcome[], crossingNodes: CrossingOutcome[], rampNearest: number[]): void {
  console.log("Measured with wide limits (30 m, 45 degrees). Mean distance from an edge to the nearest block side beside it, per side of the edge:");
  for (const kind of SIDE_KINDS) {
    const matches = sides.filter((o) => o.edge.kind === kind).flatMap((o) => [o.left, o.right].filter(isMatch));
    console.log(`  ${kind.padEnd(12)} distance  ${quantiles(matches.map((m) => m.distanceM))}`);
    console.log(`  ${"".padEnd(12)} ${histogram(matches.map((m) => m.distanceM), [0, 2, 4, 6, 8, 10, 12, 15, 20])}`);
    console.log(`  ${"".padEnd(12)} angle     ${quantiles(matches.map((m) => m.angleDeg))}`);
    if (kind === "sidewalk" || kind === "footway") {
      const nearer = sides
        .filter((o) => o.edge.kind === kind)
        .map((o) => Math.min(isMatch(o.left) ? o.left.distanceM : Infinity, isMatch(o.right) ? o.right.distanceM : Infinity))
        .filter(Number.isFinite);
      console.log(`  ${"".padEnd(12)} nearer side only  ${quantiles(nearer)}`);
      console.log(`  ${"".padEnd(12)} ${histogram(nearer, [0, 1, 2, 3, 4, 5, 6, 8, 10, 15])}`);
    }
  }
  const near = (list: CrossingOutcome[]) => list.flatMap((o) => (o.nearestM === undefined ? [] : [o.nearestM]));
  console.log(`Crossing edges (${crossingEdges.length}): distance to the nearest survey crossing line within 60 degrees`);
  console.log(`  ${quantiles(near(crossingEdges))}`);
  console.log(`  ${histogram(near(crossingEdges), [0, 2, 4, 6, 8, 10, 15, 20])}`);
  console.log(`Crossing nodes off crossing edges (${crossingNodes.length}): distance to the nearest survey crossing line across the street`);
  console.log(`  ${quantiles(near(crossingNodes))}`);
  console.log(`  ${histogram(near(crossingNodes), [0, 1, 2, 3, 4, 6, 8, 10, 15])}`);
  console.log(`Ramp points: distance to the nearest end node of a crossing edge`);
  console.log(`  ${quantiles(rampNearest)}`);
  console.log(`  ${histogram(rampNearest, [0, 2, 3, 4, 5, 6, 8, 10, 15])}`);
}

function printCoverage(
  graph: PedestrianGraph,
  sides: SideOutcome[],
  wide: SideOutcome[],
  edges: Record<string, EdgeEnrichment>,
  crossingEdges: CrossingOutcome[],
  crossingNodes: CrossingOutcome[],
  ramps: { matched: number; total: number },
  surveyCounts: { sides: number; crossings: number; ramps: number },
): void {
  console.log("\nPavement data by edge kind (an edge counts when at least one side matched):");
  console.log("  kind          edges matched      length matched       both sides  routing uses");
  const kinds: EdgeKind[] = ["shared_road", "pedestrian", "sidewalk", "footway", "steps", "path"];
  let allEdges = 0;
  let allMatched = 0;
  let allLen = 0;
  let allMatchedLen = 0;
  for (const kind of kinds) {
    const of = graph.edges.filter((e) => e.kind === kind);
    const matched = of.filter((e) => edges[e.id]);
    const len = of.reduce((s, e) => s + e.lengthM, 0);
    const matchedLen = matched.reduce((s, e) => s + e.lengthM, 0);
    const both = matched.filter((e) => edges[e.id]!.left && edges[e.id]!.right).length;
    const used = matched.filter((e) => edges[e.id]!.side || edges[e.id]!.better).length;
    allEdges += of.length;
    allMatched += matched.length;
    allLen += len;
    allMatchedLen += matchedLen;
    console.log(
      `  ${kind.padEnd(12)} ${String(matched.length).padStart(5)} / ${String(of.length).padEnd(5)} ${pct(matched.length, of.length).padStart(6)}   ${km(matchedLen).padStart(8)} / ${km(len).padEnd(8)} ${pct(matchedLen, len).padStart(6)}   ${String(both).padStart(6)}   ${String(used).padStart(6)}`,
    );
  }
  console.log(`  ${"all".padEnd(12)} ${String(allMatched).padStart(5)} / ${String(allEdges).padEnd(5)} ${pct(allMatched, allEdges).padStart(6)}   ${km(allMatchedLen).padStart(8)} / ${km(allLen).padEnd(8)} ${pct(allMatchedLen, allLen).padStart(6)}`);
  console.log("  (steps and paths are not matched to block sides)");

  // Rejected share: sides of edges that had a block side beside them under wide limits and were not accepted.
  const accepted = sides.reduce((s, o) => s + [o.left, o.right].filter(isMatch).length, 0);
  const possible = wide.reduce((s, o) => s + [o.left, o.right].filter(isMatch).length, 0);
  const reasons = new Map<string, number>();
  for (const o of sides) {
    for (const m of [o.left, o.right]) if (!isMatch(m)) reasons.set(m, (reasons.get(m) ?? 0) + 1);
  }
  console.log(`\nEdge sides with any block side beside them within 30 m and 45 degrees: ${possible}. Accepted: ${accepted} (${pct(accepted, possible)}). Rejected as doubtful: ${possible - accepted} (${pct(possible - accepted, possible)}).`);
  console.log(`Edge sides without a match, by reason: ${[...reasons.entries()].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const accepted2 = sides.flatMap((o) => [o.left, o.right].filter(isMatch));
  console.log(`Accepted side matches: distance  ${quantiles(accepted2.map((m) => m.distanceM))}`);
  console.log(`  ${histogram(accepted2.map((m) => m.distanceM), [0, 2, 4, 6, 8, 10])}`);
  console.log(`Accepted side matches: confidence  ${quantiles(accepted2.map((m) => m.confidence * 100)).replaceAll(".0", "")} (x 0.01)`);
  const usedSides = new Set<number>();
  for (const e of Object.values(edges)) {
    for (const s of [e.side, e.left, e.right]) for (const id of s?.survey.featureIds ?? []) usedSides.add(id);
  }
  console.log(`Survey block sides used: ${usedSides.size} of ${surveyCounts.sides} (${pct(usedSides.size, surveyCounts.sides)})`);

  const tally = (list: CrossingOutcome[]) => {
    const t = { matched: 0, no_candidate: 0, ambiguous: 0, low_confidence: 0 };
    for (const o of list) t[typeof o.result === "string" ? o.result : "matched"]++;
    return t;
  };
  const ce = tally(crossingEdges);
  const cn = tally(crossingNodes);
  console.log(`\nCrossing edges with survey data: ${ce.matched} of ${crossingEdges.length} (${pct(ce.matched, crossingEdges.length)}); no line near enough ${ce.no_candidate}, ambiguous ${ce.ambiguous}, low confidence ${ce.low_confidence}`);
  const got = crossingEdges.flatMap((o) => (typeof o.result === "string" ? [] : [o.result.survey.distanceM ?? 0]));
  console.log(`  distance  ${quantiles(got)}`);
  console.log(`Crossing nodes off crossing edges with survey data: ${cn.matched} of ${crossingNodes.length} (${pct(cn.matched, crossingNodes.length)}); no line near enough ${cn.no_candidate}, ambiguous ${cn.ambiguous}, low confidence ${cn.low_confidence}`);
  console.log(`Crossing end nodes with a surveyed ramp: ${ramps.matched} (survey has ${ramps.total} ramp points with data in the box, ${surveyCounts.crossings} crossing lines)`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  for (const path of [args.graph, args.survey]) {
    if (!existsSync(path)) throw new Error(`Not found: ${path}`);
  }
  const graph = readJson<PedestrianGraph>(args.graph);
  const [w, s, e, n] = graph.meta.bbox;
  const plane = new Plane([(w + e) / 2, (s + n) / 2]);
  const load = (name: string) => toFeatures(plane, readJson(resolve(args.survey, `centre_${name}.geojson`)));
  const sideFeatures = load("audit_lines");
  const crossingFeatures = load("crossings");
  const rampFeatures = load("ramps");
  console.log(`Graph: ${graph.edges.length} edges, built ${graph.meta.builtAt}`);
  console.log(`Survey: ${sideFeatures.length} block sides, ${crossingFeatures.length} crossing lines, ${rampFeatures.length} ramp points (${SURVEY_SOURCE}, ${SURVEY_YEAR})`);

  const wide = matchSides(plane, graph, sideFeatures, MEASURE_THRESHOLDS);
  if (args.measure) {
    printMeasure(
      wide,
      matchCrossingEdges(plane, graph, crossingFeatures, MEASURE_THRESHOLDS),
      matchCrossingNodes(plane, graph, crossingFeatures, MEASURE_THRESHOLDS),
      matchRamps(plane, graph, rampFeatures, MEASURE_THRESHOLDS).nearestM,
    );
    return;
  }

  const t = DEFAULT_THRESHOLDS;
  const sides = matchSides(plane, graph, sideFeatures, t);
  const crossingEdges = matchCrossingEdges(plane, graph, crossingFeatures, t);
  const crossingNodes = matchCrossingNodes(plane, graph, crossingFeatures, t);
  const ramps = matchRamps(plane, graph, rampFeatures, t);

  const edges: Record<string, EdgeEnrichment> = {};
  for (const o of sides) if (o.entry) edges[o.edge.id] = o.entry;
  const lengthOf = new Map(graph.edges.map((edge) => [edge.id, edge.lengthM]));
  for (const o of crossingEdges) {
    if (typeof o.result !== "string") edges[o.id] = { lengthM: lengthOf.get(o.id)!, crossing: o.result };
  }
  const nodes: Record<string, NodeEnrichment> = { ...ramps.nodes };
  for (const o of crossingNodes) {
    if (typeof o.result !== "string") nodes[o.id] = { ...nodes[o.id], crossing: o.result };
  }

  const enrichment: GraphEnrichment = {
    meta: {
      source: SURVEY_SOURCE,
      year: SURVEY_YEAR,
      licence: "© NTUA, 2023. All rights reserved. Not for redistribution: keep this file out of version control.",
      generatedAt: new Date().toISOString(),
      graphBuiltAt: graph.meta.builtAt,
      thresholds: { ...t },
      omittedCodes: Object.keys(OMITTED_CODES),
    },
    edges,
    nodes,
  };
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(enrichment)}\n`);

  printCoverage(graph, sides, wide, edges, crossingEdges, crossingNodes, ramps, {
    sides: sideFeatures.length,
    crossings: crossingFeatures.length,
    ramps: rampFeatures.length,
  });
  console.log(`\nSurvey codes not read: ${Object.entries(OMITTED_CODES).map(([k, why]) => `${k} (${why})`).join("; ")}`);
  console.log(`\nWrote ${args.out} (${Object.keys(edges).length} edges, ${Object.keys(nodes).length} nodes)`);
}

main();
