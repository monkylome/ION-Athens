/**
 * Shared data contract for ION Athens.
 *
 * The graph builder writes a PedestrianGraph, the routing engine reads it, and
 * the server turns city data into Obstacles. Do not rename or remove exported
 * names or fields: other parts are written against them. Adding an optional
 * field is fine.
 *
 * Coordinates are [lng, lat] in WGS84, as in GeoJSON. Distances are metres.
 */

export type NodeId = string;
export type EdgeId = string;
export type LngLat = [lng: number, lat: number];

export type NodeKind = "junction" | "crossing" | "entrance" | "other";

export interface GraphNode {
  id: NodeId;
  lng: number;
  lat: number;
  kind: NodeKind;
  /** OpenStreetMap node id, when the node comes from one. */
  osmNodeId?: number;
  name?: string;
}

export type EdgeKind =
  | "sidewalk" // a mapped pavement next to a street
  | "footway" // any other footpath
  | "pedestrian" // pedestrian street or square
  | "crossing" // a road crossing
  | "steps"
  | "path"
  | "shared_road"; // a street walked on because no pavement is mapped

export type Tri = "yes" | "no" | "unknown";

export interface CrossingInfo {
  /** Traffic signals control the crossing. */
  signals: Tri;
  /** The signal has an audible device (OSM traffic_signals:sound). */
  sound: Tri;
  /** Painted or otherwise marked crossing. */
  marked: Tri;
}

/** An undirected walkable segment between two nodes. */
export interface GraphEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  lengthM: number;
  kind: EdgeKind;
  /** Full geometry from `from` to `to`, including both end points. */
  geometry: LngLat[];
  /** Street or place name, in Greek when OSM has it. */
  name?: string;
  nameEn?: string;
  crossing?: CrossingInfo;
  tactilePaving?: Tri;
  /** Present only when OSM says so; never inferred. */
  wheelchair?: Tri;
  surface?: string;
  osmWayId?: number;
}

export interface PedestrianGraph {
  meta: {
    /** [west, south, east, north] */
    bbox: [number, number, number, number];
    builtAt: string;
    source: string;
    licence: string;
    attribution: string;
    nodeCount: number;
    edgeCount: number;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type ObstacleSourceKind =
  | "sandbox_request" // a citizen report from the AthensGov sandbox (test data)
  | "sandbox_project" // a municipal project from the AthensGov sandbox (test data)
  | "open_data" // a real, published dataset
  | "user_report" // reported from inside ION
  | "synthetic"; // created by the team for the demo

export interface ObstacleSource {
  kind: ObstacleSourceKind;
  /** Id in the source system, for example "req-0012". */
  ref?: string;
  url?: string;
  licence?: string;
}

export interface Obstacle {
  id: string;
  edgeId: EdgeId;
  /** "full" closes the edge. "partial" makes it more expensive. */
  blocks: "full" | "partial";
  /** Short machine type, for example "scaffolding", "works", "pothole". */
  type: string;
  /** What a person is told, in Greek. */
  label: string;
  source: ObstacleSource;
  /** True for anything that is not a real, current city incident. */
  synthetic: boolean;
  observedAt: string;
  /** ISO time after which the obstacle no longer affects routing. null = until removed. */
  expiresAt: string | null;
  /** 0 to 1. Below 0.5 an obstacle never closes an edge, it only adds cost. */
  confidence: number;
  position?: LngLat;
  /** How far the source point was from the edge it was matched to. */
  snapDistanceM?: number;
}

export type TurnDirection =
  | "straight"
  | "slight_left"
  | "left"
  | "sharp_left"
  | "slight_right"
  | "right"
  | "sharp_right"
  | "u_turn";

export interface RouteStep {
  /** Node where the instruction applies. */
  atNode: NodeId;
  /** Metres from the start of the route to that node. */
  atDistanceM: number;
  kind: "depart" | "turn" | "crossing" | "arrive";
  direction?: TurnDirection;
  /** Name of the street or place being entered. */
  onto?: string;
  crossing?: CrossingInfo;
}

export interface Route {
  nodes: NodeId[];
  edges: EdgeId[];
  lengthM: number;
  /** Length plus penalties, in metre-equivalents. */
  cost: number;
  geometry: LngLat[];
  steps: RouteStep[];
  /**
   * Set only when the route starts part-way along its first edge (a walker who
   * has to turn back mid-edge). Metres of edges[0], measured from nodes[0],
   * that are not walked. lengthM, cost, geometry and step distances already
   * leave them out.
   */
  startOffsetM?: number;
}
