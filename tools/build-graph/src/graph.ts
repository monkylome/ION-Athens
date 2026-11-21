import type {
  CrossingInfo,
  EdgeKind,
  GraphEdge,
  GraphNode,
  LngLat,
  NodeId,
  NodeKind,
  PedestrianGraph,
  Tri,
} from "../../../packages/core/src/types.ts";
import { lineLengthM, round6 } from "./geo.ts";
import type { SiteEdges } from "./areas.ts";
import type { Bbox, OsmIndex, OsmNode, Tags } from "./overpass.ts";

export const SOURCE_OVERPASS = "OpenStreetMap via Overpass API";
export const SOURCE_OSM_API = "OpenStreetMap via OpenStreetMap API 0.6";
export const LICENCE = "ODbL 1.0";
export const ATTRIBUTION = "© OpenStreetMap contributors";

/** Streets a pedestrian walks on when no separate pavement is mapped. */
const ROAD_HIGHWAYS = new Set([
  "living_street",
  "residential",
  "service",
  "unclassified",
  "road",
  "tertiary",
  "tertiary_link",
  "secondary",
  "secondary_link",
  "primary",
  "primary_link",
  "trunk",
  "trunk_link",
]);

/** Never walkable, or not a real way on the ground. */
const EXCLUDED_HIGHWAYS = new Set([
  "motorway",
  "motorway_link",
  "construction",
  "proposed",
  "planned",
  "abandoned",
  "razed",
  "disused",
  "bus_guideway",
  "busway",
  "raceway",
  "escape",
  "corridor", // indoor
  "elevator",
  "platform",
  "rest_area",
  "services",
  "bus_stop",
  "emergency_bay",
  "via_ferrata",
]);

const FOOT_ALLOWED = new Set(["yes", "designated", "permissive", "official", "destination"]);
const FOOT_FORBIDDEN = new Set(["no", "private", "use_sidepath"]);
const ACCESS_FORBIDDEN = new Set(["private", "no", "military"]);

/** Way tags copied verbatim to the extras file (the contract has no field for them). */
const WAY_EXTRA_TAGS = [
  "highway",
  "footway",
  "sidewalk",
  "sidewalk:left",
  "sidewalk:right",
  "sidewalk:both",
  "foot",
  "access",
  "fee",
  "opening_hours",
  "bicycle",
  "motor_vehicle",
  "vehicle",
  "area",
  "tunnel",
  "bridge",
  "indoor",
  "level",
  "layer",
  "covered",
  "lit",
  "width",
  "incline",
  "handrail",
  "step_count",
  "ramp",
  "ramp:wheelchair",
  "conveying",
  "crossing",
  "crossing:signals",
  "crossing:markings",
  "crossing:island",
  "traffic_signals:sound",
  "traffic_signals:vibration",
  "tactile_paving",
  "wheelchair",
  "smoothness",
  "kerb",
  "maxspeed",
  "lanes",
  "oneway",
  "service",
];

const NODE_EXTRA_TAGS = [
  "highway",
  "crossing",
  "crossing:signals",
  "crossing:markings",
  "crossing:island",
  "traffic_signals",
  "traffic_signals:sound",
  "traffic_signals:vibration",
  "button_operated",
  "tactile_paving",
  "kerb",
  "barrier",
  "bollard",
  "access",
  "foot",
  "entrance",
  "railway",
  "wheelchair",
  "level",
  "name",
  "name:en",
  "ref",
];

export type Classification = { kind: EdgeKind } | { skip: string };

export function classifyWay(tags: Tags): Classification {
  const hw = tags.highway;
  if (!hw) return { skip: "no highway tag" };
  if (EXCLUDED_HIGHWAYS.has(hw)) return { skip: `highway=${hw}` };
  const foot = tags.foot;
  if (foot && FOOT_FORBIDDEN.has(foot)) return { skip: `foot=${foot}` };
  const footAllowed = foot !== undefined && FOOT_ALLOWED.has(foot);
  if (!footAllowed && tags.access && ACCESS_FORBIDDEN.has(tags.access)) {
    return { skip: `access=${tags.access}` };
  }
  if (tags.motorroad === "yes") return { skip: "motorroad=yes" };

  if (hw === "footway" || hw === "path") {
    if (tags.footway === "crossing" || tags.path === "crossing") return { kind: "crossing" };
    if (tags.footway === "sidewalk") return { kind: "sidewalk" };
    return { kind: hw === "footway" ? "footway" : "path" };
  }
  if (hw === "crossing") return { kind: "crossing" };
  if (hw === "pedestrian") return { kind: "pedestrian" };
  if (hw === "steps") return { kind: "steps" };
  if (hw === "track") return { kind: "path" };
  if (hw === "cycleway" || hw === "bridleway") {
    return footAllowed ? { kind: "path" } : { skip: `highway=${hw} without foot=yes` };
  }
  if (ROAD_HIGHWAYS.has(hw)) return { kind: "shared_road" };
  return { skip: `highway=${hw} (not handled)` };
}

function triFromYesNo(value: string | undefined, yesValues: string[] = ["yes"]): Tri {
  if (value === undefined) return "unknown";
  if (value === "no") return "no";
  if (yesValues.includes(value)) return "yes";
  return "unknown";
}

/**
 * Reads crossing facts from one tag set (a crossing way or a crossing node).
 * Only what OSM states: a missing tag gives "unknown".
 */
export function crossingFromTags(tags: Tags): CrossingInfo {
  const crossing = tags.crossing;
  let signals: Tri = "unknown";
  if (tags["crossing:signals"] === "yes" || tags["crossing:signals"] === "no") {
    signals = tags["crossing:signals"];
  } else if (crossing === "traffic_signals") {
    signals = "yes";
  } else if (crossing === "uncontrolled" || crossing === "marked" || crossing === "zebra" || crossing === "unmarked") {
    // By OSM definition these values describe crossings without signals.
    signals = "no";
  }

  let sound: Tri = "unknown";
  const soundTag = tags["traffic_signals:sound"];
  if (soundTag === "no") sound = "no";
  else if (soundTag !== undefined && soundTag !== "unknown") sound = "yes"; // yes | walk | locate

  let marked: Tri = "unknown";
  const markings = tags["crossing:markings"];
  if (markings === "no") marked = "no";
  else if (markings !== undefined && markings !== "unknown") marked = "yes"; // yes | zebra | lines ...
  else if (crossing === "marked" || crossing === "zebra" || crossing === "uncontrolled") marked = "yes";
  else if (crossing === "unmarked") marked = "no";

  return { signals, sound, marked };
}

export function tactileFromTags(tags: Tags): Tri {
  return triFromYesNo(tags.tactile_paving, ["yes", "contrasted"]);
}

function mergeTri(primary: Tri, secondary: Tri): Tri {
  return primary !== "unknown" ? primary : secondary;
}

function pick(tags: Tags, keys: string[]): Tags | undefined {
  let out: Tags | undefined;
  for (const key of keys) {
    const value = tags[key];
    if (value !== undefined) (out ??= {})[key] = value;
  }
  return out;
}

export interface GraphExtras {
  meta: {
    note: string;
    builtAt: string;
    source: string;
    licence: string;
    attribution: string;
  };
  /** OSM tags per way, keyed by GraphEdge.osmWayId. */
  ways: Record<string, Tags>;
  /** OSM tags per graph node, keyed by GraphNode.id. Only nodes that carry one of the tags. */
  nodes: Record<NodeId, Tags>;
  /** Crossing facts read from highway=crossing nodes that are graph nodes. */
  crossingNodes: Record<NodeId, CrossingInfo & { tactilePaving: Tri; onCrossingEdge: boolean }>;
  /**
   * Edges whose mid point lies inside the mapped outline of an archaeological site.
   * Such sites are often fenced, ticketed and closed at night, and OSM does not say so on the paths.
   */
  archaeologicalSites: SiteEdges[];
}

export interface BuildStats {
  highwayWaysInRaw: number;
  multipolygonMemberWays: number;
  waysUsed: number;
  waysExcluded: Record<string, number>;
  waysClippedAtBbox: number;
  zeroLengthEdgesDropped: number;
  before: { nodes: number; edges: number; lengthM: number; components: number };
  dropped: { nodes: number; edges: number; lengthM: number; components: number; lengthByKind: Record<string, number> };
  largestDroppedComponents: { edges: number; lengthM: number; sampleNames: string[]; sampleWay: number | undefined }[];
}

export interface BuildResult {
  graph: PedestrianGraph;
  extras: GraphExtras;
  stats: BuildStats;
}

export const nodeIdOf = (osmId: number): NodeId => `n${osmId}`;

export function buildGraph(osm: OsmIndex, bbox: Bbox, builtAt: string, source: string): BuildResult {
  // 1. Collect walkable ways with their effective tags.
  const effectiveTags = new Map<number, Tags>();
  let highwayWaysInRaw = 0;
  for (const way of osm.ways.values()) {
    if (way.tags?.highway) {
      highwayWaysInRaw++;
      effectiveTags.set(way.id, way.tags);
    }
  }
  // Pedestrian areas mapped as multipolygons: the outer ring ways carry no tags themselves.
  let multipolygonMemberWays = 0;
  for (const rel of osm.relations.values()) {
    const t = rel.tags;
    if (!t || t.type !== "multipolygon" || (t.highway !== "pedestrian" && t.highway !== "footway")) continue;
    for (const member of rel.members ?? []) {
      if (member.type !== "way" || member.role === "inner") continue;
      if (effectiveTags.has(member.ref) || !osm.ways.has(member.ref)) continue;
      const { type: _type, ...rest } = t;
      effectiveTags.set(member.ref, { ...rest, area: "yes" });
      multipolygonMemberWays++;
    }
  }

  interface Piece {
    wayId: number;
    tags: Tags;
    kind: EdgeKind;
    refs: number[];
  }
  const pieces: Piece[] = [];
  const waysExcluded: Record<string, number> = {};
  let waysUsed = 0;
  let waysClippedAtBbox = 0;

  for (const [wayId, tags] of effectiveTags) {
    const way = osm.ways.get(wayId)!;
    const cls = classifyWay(tags);
    if ("skip" in cls) {
      waysExcluded[cls.skip] = (waysExcluded[cls.skip] ?? 0) + 1;
      continue;
    }
    // Nodes outside the bbox are not in the download: cut the way there.
    let run: number[] = [];
    let clipped = false;
    let used = false;
    const flush = () => {
      if (run.length >= 2) {
        pieces.push({ wayId, tags, kind: cls.kind, refs: run });
        used = true;
      }
      run = [];
    };
    for (const ref of way.nodes ?? []) {
      if (!osm.nodes.has(ref)) {
        clipped = true;
        flush();
        continue;
      }
      if (run[run.length - 1] !== ref) run.push(ref);
    }
    flush();
    if (clipped) waysClippedAtBbox++;
    if (used) waysUsed++;
    else waysExcluded["no nodes inside bbox"] = (waysExcluded["no nodes inside bbox"] ?? 0) + 1;
  }

  // 2. Find split points: nodes used more than once across all ways, way ends,
  //    and nodes that carry facts a router must be able to address.
  const uses = new Map<number, number>();
  for (const piece of pieces) {
    piece.refs.forEach((ref, i) => {
      const isEnd = i === 0 || i === piece.refs.length - 1;
      uses.set(ref, (uses.get(ref) ?? 0) + (isEnd ? 2 : 1));
    });
  }
  const forcesSplit = (node: OsmNode): boolean => {
    const t = node.tags;
    if (!t) return false;
    return t.barrier !== undefined || t.entrance !== undefined || t.railway === "subway_entrance" || t.highway === "elevator";
  };
  const isSplit = (ref: number): boolean => (uses.get(ref) ?? 0) >= 2 || forcesSplit(osm.nodes.get(ref)!);

  // 3. Cut pieces into edges.
  const nodes = new Map<NodeId, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeSeq = new Map<number, number>();
  let zeroLengthEdgesDropped = 0;

  const coord = (ref: number): LngLat => {
    const n = osm.nodes.get(ref)!;
    return [round6(n.lon), round6(n.lat)];
  };
  const ensureNode = (ref: number): NodeId => {
    const id = nodeIdOf(ref);
    if (!nodes.has(id)) {
      const n = osm.nodes.get(ref)!;
      const [lng, lat] = coord(ref);
      const node: GraphNode = { id, lng, lat, kind: "other", osmNodeId: ref };
      const name = n.tags?.["name:el"] ?? n.tags?.name;
      if (name) node.name = name;
      nodes.set(id, node);
    }
    return id;
  };

  const emit = (piece: Piece, refs: number[]) => {
    if (refs.length < 2) return;
    // A closed loop with a single graph node would be a self-loop: cut it in the middle.
    if (refs[0] === refs[refs.length - 1] && refs.length >= 3) {
      const mid = Math.floor(refs.length / 2);
      emit(piece, refs.slice(0, mid + 1));
      emit(piece, refs.slice(mid));
      return;
    }
    const geometry = refs.map(coord);
    const lengthM = Math.round(lineLengthM(geometry) * 100) / 100;
    if (refs[0] === refs[refs.length - 1] || lengthM <= 0) {
      zeroLengthEdgesDropped++;
      return;
    }
    const seq = edgeSeq.get(piece.wayId) ?? 0;
    edgeSeq.set(piece.wayId, seq + 1);
    const t = piece.tags;
    const edge: GraphEdge = {
      id: `w${piece.wayId}-${seq}`,
      from: ensureNode(refs[0]!),
      to: ensureNode(refs[refs.length - 1]!),
      lengthM,
      kind: piece.kind,
      geometry,
    };
    const name = t["name:el"] ?? t.name;
    if (name) edge.name = name;
    if (t["name:en"]) edge.nameEn = t["name:en"];

    if (piece.kind === "crossing") {
      // Facts can sit on the way or on its highway=crossing node(s): the way wins, the nodes fill gaps.
      const info = crossingFromTags(t);
      let tactile = tactileFromTags(t);
      const way = osm.ways.get(piece.wayId)!;
      for (const ref of way.nodes ?? []) {
        const nt = osm.nodes.get(ref)?.tags;
        if (!nt || nt.highway !== "crossing") continue;
        const fromNode = crossingFromTags(nt);
        info.signals = mergeTri(info.signals, fromNode.signals);
        info.sound = mergeTri(info.sound, fromNode.sound);
        info.marked = mergeTri(info.marked, fromNode.marked);
        tactile = mergeTri(tactile, tactileFromTags(nt));
      }
      edge.crossing = info;
      edge.tactilePaving = tactile;
    } else if (t.tactile_paving !== undefined) {
      edge.tactilePaving = tactileFromTags(t);
    }
    if (t.wheelchair === "yes" || t.wheelchair === "designated") edge.wheelchair = "yes";
    else if (t.wheelchair === "no") edge.wheelchair = "no";
    if (t.surface) edge.surface = t.surface;
    edge.osmWayId = piece.wayId;
    edges.push(edge);
  };

  for (const piece of pieces) {
    let start = 0;
    for (let i = 1; i < piece.refs.length; i++) {
      if (i === piece.refs.length - 1 || isSplit(piece.refs[i]!)) {
        emit(piece, piece.refs.slice(start, i + 1));
        start = i;
      }
    }
  }

  // 4. Keep the largest connected component (union-find).
  const parent = new Map<NodeId, NodeId>();
  const find = (x: NodeId): NodeId => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const id of nodes.keys()) parent.set(id, id);
  for (const e of edges) {
    const a = find(e.from);
    const b = find(e.to);
    if (a !== b) parent.set(a, b);
  }
  const compEdges = new Map<NodeId, GraphEdge[]>();
  for (const e of edges) {
    const root = find(e.from);
    let list = compEdges.get(root);
    if (!list) compEdges.set(root, (list = []));
    list.push(e);
  }
  const compLength = (list: GraphEdge[]) => list.reduce((s, e) => s + e.lengthM, 0);
  let mainRoot: NodeId | undefined;
  let mainLength = -1;
  for (const [root, list] of compEdges) {
    const len = compLength(list);
    if (list.length > (mainRoot ? compEdges.get(mainRoot)!.length : -1)) {
      mainRoot = root;
      mainLength = len;
    }
  }
  void mainLength;

  const keptEdges = edges.filter((e) => find(e.from) === mainRoot);
  const keptNodes = [...nodes.values()].filter((n) => find(n.id) === mainRoot);
  const droppedEdges = edges.filter((e) => find(e.from) !== mainRoot);
  const droppedByKind: Record<string, number> = {};
  for (const e of droppedEdges) droppedByKind[e.kind] = (droppedByKind[e.kind] ?? 0) + e.lengthM;
  const largestDroppedComponents = [...compEdges.entries()]
    .filter(([root]) => root !== mainRoot)
    .map(([, list]) => ({
      edges: list.length,
      lengthM: Math.round(compLength(list)),
      sampleNames: [...new Set(list.map((e) => e.name).filter((n): n is string => !!n))].slice(0, 3),
      sampleWay: list[0]?.osmWayId,
    }))
    .sort((a, b) => b.lengthM - a.lengthM)
    .slice(0, 8);

  // 5. Node kinds, from OSM tags first and from the degree otherwise.
  const degree = new Map<NodeId, number>();
  for (const e of keptEdges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const crossingEdgeNodes = new Set<NodeId>();
  for (const e of keptEdges) {
    if (e.kind === "crossing") {
      crossingEdgeNodes.add(e.from);
      crossingEdgeNodes.add(e.to);
    }
  }
  const extras: GraphExtras = {
    meta: {
      note:
        "OSM tags that the PedestrianGraph contract has no field for. ways is keyed by GraphEdge.osmWayId, nodes and crossingNodes by GraphNode.id, archaeologicalSites lists GraphEdge.id values.",
      builtAt,
      source,
      licence: LICENCE,
      attribution: ATTRIBUTION,
    },
    ways: {},
    nodes: {},
    crossingNodes: {},
    archaeologicalSites: [],
  };
  for (const node of keptNodes) {
    const tags = osm.nodes.get(node.osmNodeId!)?.tags ?? {};
    let kind: NodeKind = (degree.get(node.id) ?? 0) >= 3 ? "junction" : "other";
    if (tags.highway === "crossing") kind = "crossing";
    else if (tags.entrance !== undefined || tags.railway === "subway_entrance") kind = "entrance";
    node.kind = kind;
    const picked = pick(tags, NODE_EXTRA_TAGS);
    if (picked) extras.nodes[node.id] = picked;
    if (tags.highway === "crossing") {
      extras.crossingNodes[node.id] = {
        ...crossingFromTags(tags),
        tactilePaving: tactileFromTags(tags),
        onCrossingEdge: crossingEdgeNodes.has(node.id),
      };
    }
  }
  for (const e of keptEdges) {
    const key = String(e.osmWayId);
    if (extras.ways[key]) continue;
    const picked = pick(effectiveTags.get(e.osmWayId!)!, WAY_EXTRA_TAGS);
    if (picked) extras.ways[key] = picked;
  }

  const graph: PedestrianGraph = {
    meta: {
      bbox,
      builtAt,
      source,
      licence: LICENCE,
      attribution: ATTRIBUTION,
      nodeCount: keptNodes.length,
      edgeCount: keptEdges.length,
    },
    nodes: keptNodes,
    edges: keptEdges,
  };

  const stats: BuildStats = {
    highwayWaysInRaw,
    multipolygonMemberWays,
    waysUsed,
    waysExcluded,
    waysClippedAtBbox,
    zeroLengthEdgesDropped,
    before: {
      nodes: nodes.size,
      edges: edges.length,
      lengthM: Math.round(compLength(edges)),
      components: compEdges.size,
    },
    dropped: {
      nodes: nodes.size - keptNodes.length,
      edges: droppedEdges.length,
      lengthM: Math.round(compLength(droppedEdges)),
      components: compEdges.size - 1,
      lengthByKind: droppedByKind,
    },
    largestDroppedComponents,
  };
  return { graph, extras, stats };
}
