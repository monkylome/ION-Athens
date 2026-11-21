import type { PedestrianGraph } from "../../../packages/core/src/types.ts";
import { lineLengthM } from "./geo.ts";

const NODE_KINDS = new Set(["junction", "crossing", "entrance", "other"]);
const EDGE_KINDS = new Set(["sidewalk", "footway", "pedestrian", "crossing", "steps", "path", "shared_road"]);
const TRI = new Set(["yes", "no", "unknown"]);

/** Checks a graph against the contract in packages/core/src/types.ts. Returns the problems found. */
export function validateGraph(graph: PedestrianGraph, maxProblems = 50): string[] {
  const problems: string[] = [];
  const add = (msg: string) => {
    if (problems.length < maxProblems) problems.push(msg);
  };

  const meta = graph.meta;
  if (!meta) return ["meta is missing"];
  if (!Array.isArray(meta.bbox) || meta.bbox.length !== 4 || meta.bbox.some((v) => typeof v !== "number")) {
    add("meta.bbox is not four numbers");
  }
  for (const key of ["builtAt", "source", "licence", "attribution"] as const) {
    if (typeof meta[key] !== "string" || meta[key] === "") add(`meta.${key} is empty`);
  }
  if (Number.isNaN(Date.parse(meta.builtAt))) add("meta.builtAt is not a date");
  if (meta.nodeCount !== graph.nodes.length) add(`meta.nodeCount ${meta.nodeCount} != ${graph.nodes.length} nodes`);
  if (meta.edgeCount !== graph.edges.length) add(`meta.edgeCount ${meta.edgeCount} != ${graph.edges.length} edges`);

  const nodes = new Map<string, { lng: number; lat: number }>();
  const [w, s, e, n] = meta.bbox;
  for (const node of graph.nodes) {
    if (typeof node.id !== "string" || node.id === "") add("node with empty id");
    if (nodes.has(node.id)) add(`duplicate node id ${node.id}`);
    nodes.set(node.id, node);
    if (!Number.isFinite(node.lng) || !Number.isFinite(node.lat)) add(`node ${node.id}: bad coordinates`);
    else if (node.lng < w || node.lng > e || node.lat < s || node.lat > n) add(`node ${node.id}: outside meta.bbox`);
    if (!NODE_KINDS.has(node.kind)) add(`node ${node.id}: unknown kind ${String(node.kind)}`);
  }

  const edgeIds = new Set<string>();
  const used = new Set<string>();
  for (const edge of graph.edges) {
    const id = edge.id;
    if (typeof id !== "string" || id === "") add("edge with empty id");
    if (edgeIds.has(id)) add(`duplicate edge id ${id}`);
    edgeIds.add(id);
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from) add(`edge ${id}: from node ${edge.from} does not exist`);
    if (!to) add(`edge ${id}: to node ${edge.to} does not exist`);
    if (edge.from === edge.to) add(`edge ${id}: self-loop`);
    used.add(edge.from);
    used.add(edge.to);
    if (!EDGE_KINDS.has(edge.kind)) add(`edge ${id}: unknown kind ${String(edge.kind)}`);
    if (!(typeof edge.lengthM === "number" && Number.isFinite(edge.lengthM) && edge.lengthM > 0)) {
      add(`edge ${id}: length ${edge.lengthM} is not positive`);
    }
    const g = edge.geometry;
    if (!Array.isArray(g) || g.length < 2) {
      add(`edge ${id}: geometry has fewer than two points`);
      continue;
    }
    if (g.some((p) => !Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
      add(`edge ${id}: geometry has a bad point`);
      continue;
    }
    const first = g[0]!;
    const last = g[g.length - 1]!;
    if (from && (first[0] !== from.lng || first[1] !== from.lat)) add(`edge ${id}: geometry does not start at node ${edge.from}`);
    if (to && (last[0] !== to.lng || last[1] !== to.lat)) add(`edge ${id}: geometry does not end at node ${edge.to}`);
    const measured = lineLengthM(g);
    if (Math.abs(measured - edge.lengthM) > 0.02 + measured * 1e-6) {
      add(`edge ${id}: lengthM ${edge.lengthM} differs from geometry length ${measured.toFixed(3)}`);
    }
    if (edge.crossing) {
      for (const key of ["signals", "sound", "marked"] as const) {
        if (!TRI.has(edge.crossing[key])) add(`edge ${id}: crossing.${key} is not yes/no/unknown`);
      }
    }
    if (edge.kind === "crossing" && !edge.crossing) add(`edge ${id}: crossing edge without crossing info`);
    if (edge.tactilePaving !== undefined && !TRI.has(edge.tactilePaving)) add(`edge ${id}: bad tactilePaving`);
    if (edge.wheelchair !== undefined && !TRI.has(edge.wheelchair)) add(`edge ${id}: bad wheelchair`);
  }

  for (const id of nodes.keys()) {
    if (!used.has(id)) add(`node ${id}: not used by any edge`);
  }

  // One connected component.
  if (graph.nodes.length > 0) {
    const adjacency = new Map<string, string[]>();
    for (const edge of graph.edges) {
      (adjacency.get(edge.from) ?? adjacency.set(edge.from, []).get(edge.from)!).push(edge.to);
      (adjacency.get(edge.to) ?? adjacency.set(edge.to, []).get(edge.to)!).push(edge.from);
    }
    const start = graph.nodes[0]!.id;
    const seen = new Set<string>([start]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const next of adjacency.get(queue[i]!) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    if (seen.size !== nodes.size) add(`graph is not connected: ${seen.size} of ${nodes.size} nodes reachable`);
  }
  return problems;
}
