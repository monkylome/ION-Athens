/**
 * Applying the City's pavement survey to a loaded graph, in memory.
 *
 * The survey ("Walkable Athens", City of Athens with NTUA, 2022) is not
 * licensed for redistribution, so its values never go into the graph file.
 * A separate enrichment file holds them, keyed by edge and node id, and this
 * function lays them over a graph that has just been loaded.
 */
import type {
  GraphEdge,
  GraphEnrichment,
  GraphNode,
  PavementSurvey,
  PedestrianGraph,
  SurveyedSide,
} from "./types.ts";

export const SURVEY_SOURCE = "Walkable Athens (City of Athens, NTUA)";
export const SURVEY_YEAR = 2022;

/** An edge whose length differs from the matched one by more than this was rebuilt: its values are not applied. */
const LENGTH_TOLERANCE_M = 0.5;

export interface EnrichmentResult {
  /** A new graph. The input graph and its edges are not modified. */
  graph: PedestrianGraph;
  /** False when nothing was applied; `problem` says why. */
  applied: boolean;
  problem?: string;
  /** Edges that now carry survey values routing uses (`survey` is set). Streets kept as unknown are not counted. */
  edgesCovered: number;
  /** Nodes that now carry survey values. */
  nodesCovered: number;
  /** Entries of the file that were not applied: unknown id, or an edge whose length changed. */
  skipped: number;
}

function pavementValues(side: SurveyedSide): PavementSurvey {
  const out: PavementSurvey = {};
  if (side.pavement !== undefined) out.pavement = side.pavement;
  if (side.pavementWidth !== undefined) out.pavementWidth = side.pavementWidth;
  if (side.pavementWidthVaries !== undefined) out.pavementWidthVaries = side.pavementWidthVaries;
  if (side.pavementCondition !== undefined) out.pavementCondition = side.pavementCondition;
  if (side.tactileGuidance !== undefined) out.tactileGuidance = side.tactileGuidance;
  if (side.fixedObstacles !== undefined) out.fixedObstacles = [...side.fixedObstacles];
  return out;
}

/**
 * Lay an enrichment file over a graph. Returns a new graph; nothing is written
 * anywhere and the input is left as it was.
 *
 * - A pavement edge takes the values of its one side.
 * - A street with two sides keeps both in `pavementSides` and takes the values
 *   of the side the file marks as better; `survey.side` names it. Without a
 *   better side the edge keeps `pavementSides` only and is priced as unknown.
 * - A crossing edge takes markings and ramps.
 * - The whole file is refused when it was made for another build of the graph.
 */
export function applyEnrichment(graph: PedestrianGraph, enrichment: GraphEnrichment): EnrichmentResult {
  const refuse = (problem: string): EnrichmentResult => ({
    graph,
    applied: false,
    problem,
    edgesCovered: 0,
    nodesCovered: 0,
    skipped: 0,
  });
  if (!enrichment || typeof enrichment !== "object" || !enrichment.meta || !enrichment.edges) {
    return refuse("enrichment file has no meta or edges");
  }
  if (enrichment.meta.graphBuiltAt !== graph.meta.builtAt) {
    return refuse(
      `enrichment was made for the graph built at ${enrichment.meta.graphBuiltAt}, not ${graph.meta.builtAt}`,
    );
  }
  const edgeEntries = enrichment.edges;
  const nodeEntries = enrichment.nodes ?? {};
  let edgesCovered = 0;
  let nodesCovered = 0;
  const seenEdges = new Set<string>();
  const seenNodes = new Set<string>();

  const edges = graph.edges.map((edge): GraphEdge => {
    const entry = Object.hasOwn(edgeEntries, edge.id) ? edgeEntries[edge.id] : undefined;
    if (!entry || Math.abs(entry.lengthM - edge.lengthM) > LENGTH_TOLERANCE_M) return edge;
    seenEdges.add(edge.id);
    const out: GraphEdge = { ...edge };
    let covered = false;
    if (entry.crossing) {
      if (entry.crossing.markings !== undefined) out.crossingMarkings = entry.crossing.markings;
      if (entry.crossing.ramps !== undefined) out.crossingRamps = entry.crossing.ramps;
      out.survey = { ...entry.crossing.survey };
      covered = true;
    } else if (entry.side) {
      Object.assign(out, pavementValues(entry.side));
      out.survey = { ...entry.side.survey };
      covered = true;
    } else if (entry.left || entry.right) {
      out.pavementSides = {
        ...(entry.left ? { left: entry.left } : {}),
        ...(entry.right ? { right: entry.right } : {}),
      };
      const chosen = entry.better ? entry[entry.better] : undefined;
      if (chosen && entry.better) {
        Object.assign(out, pavementValues(chosen));
        out.survey = { ...chosen.survey, side: entry.better };
        covered = true;
      }
    } else {
      return edge;
    }
    if (covered) edgesCovered++;
    return out;
  });

  const nodes = graph.nodes.map((node): GraphNode => {
    const entry = Object.hasOwn(nodeEntries, node.id) ? nodeEntries[node.id] : undefined;
    if (!entry || (!entry.ramp && !entry.crossing)) return node;
    seenNodes.add(node.id);
    nodesCovered++;
    return {
      ...node,
      ...(entry.ramp ? { surveyedRamp: entry.ramp } : {}),
      ...(entry.crossing ? { surveyedCrossing: entry.crossing } : {}),
    };
  });

  const skipped =
    Object.keys(edgeEntries).length - seenEdges.size + (Object.keys(nodeEntries).length - seenNodes.size);
  return { graph: { ...graph, nodes, edges }, applied: true, edgesCovered, nodesCovered, skipped };
}
