/**
 * `createRouting` is the only place that decides which routing implementation
 * the server uses: the engine in `@ion/core`. Set ION_ROUTING=fallback to use
 * the plain stand-in instead, for example to rule the engine out while
 * debugging.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyEnrichment, type GraphEnrichment, type PedestrianGraph } from "@ion/core";
import { CoreRouting } from "./core.ts";
import { FallbackRouting } from "./fallback.ts";
import { EMPTY_GRAPH, type RoutingPort } from "./port.ts";

export function createRouting(graph: PedestrianGraph): RoutingPort {
  if (process.env.ION_ROUTING === "fallback") return new FallbackRouting(graph);
  return new CoreRouting(graph);
}

export interface LoadedGraph {
  graph: PedestrianGraph;
  /** False when the graph file is missing or unreadable; the graph is then empty. */
  loaded: boolean;
  problem?: string;
  /** Whether the City's pavement survey was laid over the graph, and on how many edges. */
  enrichment: { applied: boolean; edgesCovered: number; problem?: string };
}

/**
 * The pavement survey matched to the graph by `tools/enrich-graph`. The file is
 * not in the repository (the survey is not licensed for redistribution), so a
 * missing file is the normal state and changes nothing.
 */
export function enrichmentPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env["ION_ENRICHMENT_PATH"] ||
    fileURLToPath(new URL("../../../../data-local/athens-centre.enrichment.json", import.meta.url))
  );
}

function enrich(graph: PedestrianGraph, path: string): Pick<LoadedGraph, "graph" | "enrichment"> {
  if (!existsSync(path)) return { graph, enrichment: { applied: false, edgesCovered: 0 } };
  try {
    const result = applyEnrichment(graph, JSON.parse(readFileSync(path, "utf8")) as GraphEnrichment);
    return {
      graph: result.graph,
      enrichment: {
        applied: result.applied,
        edgesCovered: result.edgesCovered,
        ...(result.problem ? { problem: result.problem } : {}),
      },
    };
  } catch {
    return { graph, enrichment: { applied: false, edgesCovered: 0, problem: "enrichment file is not valid JSON" } };
  }
}

/**
 * Reads the graph file if it exists, then lays the pavement survey over it in
 * memory when its file exists. Never throws: a missing graph is a normal state.
 */
export function loadGraph(path: string, surveyPath: string = enrichmentPath()): LoadedGraph {
  const none = { applied: false, edgesCovered: 0 };
  if (!existsSync(path)) return { graph: EMPTY_GRAPH, loaded: false, problem: "graph file not found", enrichment: none };
  try {
    const graph = JSON.parse(readFileSync(path, "utf8")) as PedestrianGraph;
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.edges.length === 0) {
      return { graph: EMPTY_GRAPH, loaded: false, problem: "graph file has no edges", enrichment: none };
    }
    return { loaded: true, ...enrich(graph, surveyPath) };
  } catch {
    return { graph: EMPTY_GRAPH, loaded: false, problem: "graph file is not valid JSON", enrichment: none };
  }
}
