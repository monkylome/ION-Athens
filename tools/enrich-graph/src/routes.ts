/**
 * Evidence: two routes before and after the survey is laid over the graph.
 *
 *   tsx src/routes.ts [--graph path] [--enrichment path] [--places path]
 *
 * Prints lengths, streets and how much of each route the survey describes.
 * It prints aggregates only, no survey records.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEnrichment,
  buildGraphIndex,
  describeSurveyNotice,
  edgeCost,
  findRoute,
  type GraphEdge,
  type GraphEnrichment,
  type GraphIndex,
  type PedestrianGraph,
  type Route,
} from "@ion/core";

interface Place {
  id: string;
  name: string;
  nearestNodeId: string;
}

const PAIRS: [label: string, from: string, to: string][] = [
  ["Monastiraki metro station to Athens City Hall", "metro_station-monastiraki-n9666216537", "townhall-athens-town-hall-w768849988"],
  ["Akropoli metro station to Thiseio metro station", "metro_station-akropoli-n1957144319", "metro_station-thiseio-n2284727248"],
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]!) : resolve(root, fallback);
}
const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

const m = (v: number) => `${Math.round(v)} m`;

/** Streets in walking order, consecutive edges of the same name and kind merged. */
function streets(index: GraphIndex, route: Route): string {
  const parts: { label: string; length: number }[] = [];
  for (const id of route.edges) {
    const e = index.edges.get(id)!;
    const label = `${e.name ?? "(unnamed)"} [${e.kind}]`;
    const last = parts.at(-1);
    if (last && last.label === label) last.length += e.lengthM;
    else parts.push({ label, length: e.lengthM });
  }
  return parts.map((p) => `${p.label} ${m(p.length)}`).join(" > ");
}

function lengthWhere(edges: GraphEdge[], test: (e: GraphEdge) => boolean): number {
  return edges.reduce((s, e) => (test(e) ? s + e.lengthM : s), 0);
}

function describe(label: string, index: GraphIndex, route: Route): void {
  const edges = route.edges.map((id) => index.edges.get(id)!);
  const kinds = new Map<string, number>();
  for (const e of edges) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + e.lengthM);
  console.log(`  ${label}: ${m(route.lengthM)}, cost ${Math.round(route.cost)}, ${route.edges.length} edges, ${route.steps.length} steps`);
  console.log(`    by kind: ${[...kinds.entries()].map(([k, v]) => `${k} ${m(v)}`).join(", ")}`);
  console.log(`    streets: ${streets(index, route)}`);
  const walked = edges.filter((e) => e.kind !== "crossing");
  const surveyed = lengthWhere(walked, (e) => e.survey !== undefined);
  if (surveyed === 0 && !edges.some((e) => e.survey)) return;
  const crossings = edges.filter((e) => e.kind === "crossing");
  console.log(
    `    survey: ${m(surveyed)} of ${m(lengthWhere(walked, () => true))} described; pavement exists ${m(lengthWhere(walked, (e) => e.pavement === "yes"))}, none ${m(lengthWhere(walked, (e) => e.pavement === "no"))}; ` +
      `narrow ${m(lengthWhere(walked, (e) => e.pavementWidth === "narrow"))}; poor condition ${m(lengthWhere(walked, (e) => e.pavementCondition === "poor"))}; ` +
      `tactile guidance whole length ${m(lengthWhere(walked, (e) => e.tactileGuidance === "whole"))}; ` +
      `crossing edges with survey data ${crossings.filter((e) => e.survey).length} of ${crossings.length}`,
  );
  const notices = route.steps.flatMap((s) => (s.surveyNotice ? [`at ${m(s.atDistanceM)}: ${describeSurveyNotice(s.surveyNotice)}`] : []));
  console.log(`    surveyed facts announced: ${notices.length ? notices.join(" | ") : "none"}`);
}

function main(): void {
  const graphPath = arg("graph", "data/athens-centre.graph.json");
  const enrichmentPath = arg("enrichment", "data-local/athens-centre.enrichment.json");
  const places = readJson<Place[]>(arg("places", "data/places.json"));
  const graph = readJson<PedestrianGraph>(graphPath);
  if (!existsSync(enrichmentPath)) throw new Error(`No enrichment file at ${enrichmentPath}: run the build first`);
  const applied = applyEnrichment(graph, readJson<GraphEnrichment>(enrichmentPath));
  if (!applied.applied) throw new Error(`Enrichment not applied: ${applied.problem}`);
  console.log(`Enrichment applied: ${applied.edgesCovered} edges, ${applied.nodesCovered} nodes, ${applied.skipped} entries skipped`);
  const before = buildGraphIndex(graph);
  const after = buildGraphIndex(applied.graph);

  for (const [label, fromId, toId] of PAIRS) {
    const from = places.find((p) => p.id === fromId);
    const to = places.find((p) => p.id === toId);
    if (!from || !to) throw new Error(`Place not found: ${fromId} or ${toId}`);
    console.log(`\n${label} (${from.name} > ${to.name})`);
    const a = findRoute(before, from.nearestNodeId, to.nearestNodeId);
    const b = findRoute(after, from.nearestNodeId, to.nearestNodeId);
    if (!a.ok || !b.ok) {
      console.log(`  no route: ${!a.ok ? a.message : ""} ${!b.ok ? b.message : ""}`);
      continue;
    }
    describe("before", before, a.route);
    describe("after ", after, b.route);
    // The old route priced with what is now known about it: why the engine left it, or kept it.
    const oldCostNow = a.route.edges.reduce((s, id) => s + edgeCost(after.edges.get(id)!, [], 0), 0);
    const shared = a.route.edges.filter((id) => b.route.edges.includes(id));
    const sharedM = shared.reduce((s, id) => s + before.edges.get(id)!.lengthM, 0);
    const same = a.route.edges.join() === b.route.edges.join();
    console.log(
      same
        ? `  unchanged: same ${a.route.edges.length} edges. Cost ${Math.round(a.route.cost)} before, ${Math.round(b.route.cost)} after.`
        : `  changed: ${m(sharedM)} of the old route kept (${Math.round((100 * sharedM) / a.route.lengthM)}%). Old route costs ${Math.round(oldCostNow)} with the survey, new route ${Math.round(b.route.cost)}; length ${m(a.route.lengthM)} > ${m(b.route.lengthM)}.`,
    );
  }
}

main();
