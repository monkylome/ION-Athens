/**
 * Validates a built graph file against the contract.
 * Usage: tsx src/check.ts [path to graph.json] [path to places.json]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PedestrianGraph } from "../../../packages/core/src/types.ts";
import { validateGraph } from "./validate.ts";

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data");
const graphPath = resolve(process.argv[2] ?? `${dataDir}/athens-centre.graph.json`);
const placesPath = resolve(process.argv[3] ?? `${dataDir}/places.json`);

const graph = JSON.parse(readFileSync(graphPath, "utf8")) as PedestrianGraph;
const problems = validateGraph(graph);

if (existsSync(placesPath)) {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const places = JSON.parse(readFileSync(placesPath, "utf8")) as { id: string; nearestNodeId: string }[];
  const ids = new Set<string>();
  for (const place of places) {
    if (ids.has(place.id)) problems.push(`places: duplicate id ${place.id}`);
    ids.add(place.id);
    if (!nodeIds.has(place.nearestNodeId)) problems.push(`places: ${place.id} points to missing node ${place.nearestNodeId}`);
  }
  console.log(`places: ${places.length} checked (${placesPath})`);
}

if (problems.length > 0) {
  console.error(`FAILED: ${graphPath}`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`OK: ${graphPath} (${graph.nodes.length} nodes, ${graph.edges.length} edges) matches the contract`);
