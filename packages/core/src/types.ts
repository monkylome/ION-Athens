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
  /** Kerb ramp surveyed at this node (an end of a crossing). Set by applyEnrichment only. */
  surveyedRamp?: SurveyedRamp;
  /** Survey facts for a crossing that passes through this node. Set by applyEnrichment only. */
  surveyedCrossing?: SurveyedCrossing;
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

/** Pavement width class from the survey: up to about 1 m, 1 to 2 m, over 2 m. */
export type PavementWidth = "narrow" | "medium" | "wide";
export type PavementCondition = "poor" | "medium" | "good";
/** Tactile guidance for the blind along a pavement: none, on part of it, or along the whole length. */
export type TactileGuidance = "none" | "part" | "whole";
/**
 * Kinds of fixed obstacle the survey saw at least once on a pavement side.
 * Movable things (shop stalls, cafe tables, private objects) are left out: an
 * observation of them from the survey year says nothing about today.
 */
export type FixedObstacleKind =
  | "kiosk"
  | "tree_row"
  | "street_furniture"
  | "surface_defect"
  | "pole_or_bollard" // sign and light poles, bollards, railings
  | "utility_cabinet"
  | "transit_stop"
  | "building_protrusion"
  | "level_change"; // a level difference without a ramp
/** Zebra markings of a crossing as surveyed. */
export type CrossingMarkings = "none" | "clear" | "worn";
/** Kerb ramps at the ends of a crossing as surveyed. */
export type CrossingRamps = "none" | "one_end" | "both_ends";

/** Where a surveyed value comes from and how far the geometric match can be trusted. */
export interface SurveyNote {
  /** "Walkable Athens (City of Athens, NTUA)" */
  source: string;
  /** Year of the survey: 2022. */
  year: number;
  /** 0 to 1: how well the survey feature matched this edge or node by geometry. */
  confidence: number;
  /** For a street with two sides: the side the values describe, relative to the direction from `from` to `to`. */
  side?: "left" | "right";
  /** Survey feature ids (OBJECTID) the values come from. */
  featureIds?: number[];
  /** Mean distance between the survey feature and the edge or node, in metres. */
  distanceM?: number;
}

/**
 * What the survey says about one pavement side. Every field is optional: a
 * missing field means "not known", never "no" and never "fine".
 */
export interface PavementSurvey {
  /** Whether a pavement exists. */
  pavement?: "yes" | "no";
  pavementWidth?: PavementWidth;
  /** The width changes along the side. */
  pavementWidthVaries?: boolean;
  pavementCondition?: PavementCondition;
  tactileGuidance?: TactileGuidance;
  /** Kinds present at least once; an empty list means the survey saw none. */
  fixedObstacles?: FixedObstacleKind[];
}

/** One surveyed pavement side with its match. */
export interface SurveyedSide extends PavementSurvey {
  survey: SurveyNote;
}

export interface SurveyedCrossing {
  markings?: CrossingMarkings;
  ramps?: CrossingRamps;
  survey: SurveyNote;
}

export interface SurveyedRamp {
  condition?: "poor" | "good";
  /** Room to manoeuvre a wheelchair off the ramp. */
  manoeuvringSpace?: "yes" | "no";
  survey: SurveyNote;
}

/**
 * An undirected walkable segment between two nodes.
 *
 * The fields of PavementSurvey, `pavementSides`, `crossingMarkings`,
 * `crossingRamps` and `survey` come from the City's pavement survey. They are
 * never in the graph file: applyEnrichment sets them in memory. On a street
 * with two surveyed sides the PavementSurvey fields describe the better side,
 * named in `survey.side`, and both sides are in `pavementSides`.
 */
export interface GraphEdge extends PavementSurvey {
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
  /** Both sides of a street as surveyed, relative to the direction from `from` to `to`. */
  pavementSides?: { left?: SurveyedSide; right?: SurveyedSide };
  crossingMarkings?: CrossingMarkings;
  crowd?: { level: "busy" | "calm"; observedAt: string; expiresAt: string; source: string };
  crossingRamps?: CrossingRamps;
  /** Present exactly when the survey values above are set on this edge (`pavementSides` alone does not count). */
  survey?: SurveyNote;
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

/** Survey data for one edge in an enrichment file. */
export interface EdgeEnrichment {
  /** Length of the edge when it was matched: a guard against a rebuilt graph. */
  lengthM: number;
  /** A pavement edge (one side): the survey side it runs along. */
  side?: SurveyedSide;
  /** A street axis: its two sides, relative to the direction from `from` to `to`. */
  left?: SurveyedSide;
  right?: SurveyedSide;
  /**
   * The side routing should assume. Missing when the only matched side has no
   * pavement and the other side is not known: the street then stays unknown.
   */
  better?: "left" | "right";
  /** A crossing edge. */
  crossing?: SurveyedCrossing;
}

export interface NodeEnrichment {
  ramp?: SurveyedRamp;
  crossing?: SurveyedCrossing;
}

/**
 * The enrichment file: survey values matched to the edges and nodes of one
 * build of the graph. It lives outside the tracked data (the survey is not
 * licensed for redistribution) and is applied in memory by applyEnrichment.
 */
export interface GraphEnrichment {
  meta: {
    source: string;
    year: number;
    licence: string;
    generatedAt: string;
    /** `meta.builtAt` of the graph the matches were made against. */
    graphBuiltAt: string;
    /** Matching thresholds used, for the record. */
    thresholds: Record<string, number>;
    /** Survey codes left out because their meaning is not established. */
    omittedCodes: string[];
  };
  edges: Record<EdgeId, EdgeEnrichment>;
  nodes: Record<NodeId, NodeEnrichment>;
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
  /** One surveyed fact about the stretch this step leads onto, when it is worth saying ahead of time. */
  surveyNotice?: SurveyNotice;
}

/**
 * - `no_pavement`: the stretch ahead has no pavement.
 * - `pavement_narrows`: the pavement ahead is narrow and the one before it was wider.
 * - `pavement_narrow`: the pavement ahead is narrow (what came before is not known).
 * - `tactile_guidance_starts`: tactile guidance along the whole length begins.
 * - `crossing_no_ramp`: the crossing has no kerb ramp at either end.
 */
export type SurveyNoticeKind =
  | "no_pavement"
  | "pavement_narrows"
  | "pavement_narrow"
  | "tactile_guidance_starts"
  | "crossing_no_ramp";

export interface SurveyNotice {
  kind: SurveyNoticeKind;
  /** Side of the street the fact is about, relative to the walking direction. */
  side?: "left" | "right";
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
