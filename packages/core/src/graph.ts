/**
 * Graph index: a PedestrianGraph loaded into lookup maps and an adjacency list.
 * Edges are undirected, so each edge appears in the adjacency of both ends.
 */
import { haversineM, projectOntoPolyline } from "./geo.ts";
import type { EdgeId, GraphEdge, GraphNode, LngLat, NodeId, PedestrianGraph } from "./types.ts";

export interface Neighbour {
  edge: GraphEdge;
  /** The node at the other end of the edge. */
  node: NodeId;
}

export interface GraphIndex {
  graph: PedestrianGraph;
  nodes: Map<NodeId, GraphNode>;
  edges: Map<EdgeId, GraphEdge>;
  adjacency: Map<NodeId, Neighbour[]>;
}

/** Build the index. Edges whose end nodes are missing are kept out of the adjacency. */
export function buildGraphIndex(graph: PedestrianGraph): GraphIndex {
  const nodes = new Map<NodeId, GraphNode>();
  const edges = new Map<EdgeId, GraphEdge>();
  const adjacency = new Map<NodeId, Neighbour[]>();
  for (const node of graph.nodes) {
    nodes.set(node.id, node);
    adjacency.set(node.id, []);
  }
  for (const edge of graph.edges) {
    const a = adjacency.get(edge.from);
    const b = adjacency.get(edge.to);
    if (!a || !b) continue;
    edges.set(edge.id, edge);
    a.push({ edge, node: edge.to });
    if (edge.from !== edge.to) b.push({ edge, node: edge.from });
  }
  return { graph, nodes, edges, adjacency };
}

export function nodeLngLat(node: GraphNode): LngLat {
  return [node.lng, node.lat];
}

/** Geometry of an edge in walking order when leaving `fromNode`. */
export function orientedGeometry(index: GraphIndex, edge: GraphEdge, fromNode: NodeId): LngLat[] {
  let geometry = edge.geometry;
  if (geometry.length < 2) {
    const a = index.nodes.get(edge.from);
    const b = index.nodes.get(edge.to);
    geometry = a && b ? [nodeLngLat(a), nodeLngLat(b)] : geometry;
  }
  return edge.from === fromNode ? geometry.slice() : geometry.slice().reverse();
}

export interface NearestNode {
  node: GraphNode;
  distanceM: number;
}

/** Nearest node to a coordinate, or null when the graph is empty or nothing is within maxDistanceM. */
export function nearestNode(
  index: GraphIndex,
  point: LngLat,
  maxDistanceM = Infinity,
): NearestNode | null {
  let best: NearestNode | null = null;
  for (const node of index.nodes.values()) {
    const d = haversineM(point, [node.lng, node.lat]);
    if (d <= maxDistanceM && (!best || d < best.distanceM)) best = { node, distanceM: d };
  }
  return best;
}

export interface NearestEdge {
  edge: GraphEdge;
  distanceM: number;
  /** The closest point on the edge. */
  point: LngLat;
  /** Metres from the edge's `from` node to that point, on the scale of edge.lengthM. */
  alongM: number;
}

/** Nearest edge to a coordinate, measured to the edge geometry, or null as for nearestNode. */
export function nearestEdge(
  index: GraphIndex,
  point: LngLat,
  maxDistanceM = Infinity,
): NearestEdge | null {
  let best: NearestEdge | null = null;
  for (const edge of index.edges.values()) {
    const geometry = orientedGeometry(index, edge, edge.from);
    if (geometry.length === 0) continue;
    const hit = projectOntoPolyline(geometry, point);
    if (hit.distanceM > maxDistanceM || (best && hit.distanceM >= best.distanceM)) continue;
    let geomLen = 0;
    for (let i = 1; i < geometry.length; i++) geomLen += haversineM(geometry[i - 1]!, geometry[i]!);
    const alongM = geomLen > 0 ? (hit.alongM / geomLen) * edge.lengthM : 0;
    best = { edge, distanceM: hit.distanceM, point: hit.point, alongM };
  }
  return best;
}
