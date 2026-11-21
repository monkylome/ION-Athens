/**
 * `createRouting` is the only place that decides which routing implementation
 * the server uses: the engine in `@ion/core`. Set ION_ROUTING=fallback to use
 * the plain stand-in instead, for example to rule the engine out while
 * debugging.
 */
import { existsSync, readFileSync } from "node:fs";
import type { PedestrianGraph } from "@ion/core";
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
}

/** Reads the graph file if it exists. Never throws: a missing graph is a normal state. */
export function loadGraph(path: string): LoadedGraph {
  if (!existsSync(path)) return { graph: EMPTY_GRAPH, loaded: false, problem: "graph file not found" };
  try {
    const graph = JSON.parse(readFileSync(path, "utf8")) as PedestrianGraph;
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.edges.length === 0) {
      return { graph: EMPTY_GRAPH, loaded: false, problem: "graph file has no edges" };
    }
    return { graph, loaded: true };
  } catch {
    return { graph: EMPTY_GRAPH, loaded: false, problem: "graph file is not valid JSON" };
  }
}
