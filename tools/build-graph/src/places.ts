import type { LngLat, NodeId, PedestrianGraph } from "../../../packages/core/src/types.ts";
import { haversineM, round6 } from "./geo.ts";
import { nodeIdOf, type GraphExtras } from "./graph.ts";
import type { Bbox, OsmElement, OsmIndex, OsmNode, Tags } from "./overpass.ts";

export type PlaceKind =
  | "theatre" | "cinema" | "library" | "arts_centre" | "concert_hall" | "neighbourhood" | "suburb"
  | "metro_station"
  | "metro_entrance"
  | "townhall"
  | "kep"
  | "museum"
  | "landmark"
  | "hospital"
  | "police"
  | "square"
  | "building_entrance";

export interface Place {
  id: string;
  /** Greek name when OSM has one. Entrances without a name of their own get a descriptive one. */
  name: string;
  nameEn: string | null;
  kind: PlaceKind;
  lng: number;
  lat: number;
  /** Nearest node of the pedestrian graph at street level. */
  nearestNodeId: NodeId;
  nearestNodeDistanceM: number;
  /** OSM element the place was read from, for example "osm:node/123". */
  source: string;
  osmType: "node" | "way" | "relation";
  osmId: number;
  /** How the position was obtained. */
  position: "osm_node" | "centroid";
  /** For buildings: true when OSM maps at least one entrance node on the outline. */
  entranceVerified?: boolean;
  /** "addr:street": no entrance is mapped, so the node is the nearest one on the street of the OSM address (within 100 m). */
  snappedBy?: "addr:street";
  /** OSM addr:street and addr:housenumber, when present. */
  address?: string;
  /** For entrances: id of the place they belong to. */
  parentId?: string;
  /** For metro entrances: the station they were matched to by distance, and that distance. */
  station?: string;
  stationDistanceM?: number;
  /** OSM tags kept as written. */
  venueTags?: Tags;
  entrance?: string;
  wheelchair?: string;
  level?: string;
  ref?: string;
}

const KEP_RE = /(^|[^Α-Ωα-ωA-Za-z])(ΚΕΠ|Κ\.Ε\.Π\.|KEP)([^Α-Ωα-ωA-Za-z]|$)|Κέντρο Εξυπηρέτησης Πολιτών|Citizens?'? Service Cent/i;
const HEROD_RE = /Ηρώδ|Ηρωδ|Herod/i;

function venueTags(tags: Tags): Tags {
  const keys = ["wheelchair", "wheelchair:description", "toilets:wheelchair", "website", "wikidata", "elevator", "wheelchair:places", "guide_dog", "tactile_paving", "step_count", "operator", "access", "check_date"];
  const result = Object.fromEntries(keys.filter(k => tags[k]).map(k => [k, tags[k]!]));
  if (!result.website && tags["contact:website"]) result.website = tags["contact:website"];
  return result;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function positionOf(el: OsmElement): LngLat | undefined {
  if (el.type === "node") return [el.lon, el.lat];
  if (el.center) return [el.center.lon, el.center.lat];
  return undefined;
}

function kindOf(tags: Tags): PlaceKind | undefined {
  const names = [tags.name, tags["name:el"], tags["name:en"], tags.official_name, tags.short_name].filter(Boolean).join(" | ");
  if (tags.highway !== undefined) return tags.place === "square" ? "square" : undefined; // streets are not places
  if (tags.type === "route" || tags.type === "route_master" || tags.type === "restriction") return undefined;
  for (const kind of ["theatre", "cinema", "library", "arts_centre", "concert_hall"] as const) {
    if (tags.amenity === kind || (kind === "concert_hall" && tags.building === kind)) return kind;
  }
  if (tags.place === "neighbourhood" || tags.place === "suburb") return tags.place;
  if (tags.amenity === "townhall") return "townhall";
  if (tags.amenity === "hospital") return "hospital";
  if (tags.amenity === "police") return "police";
  if (KEP_RE.test(names)) return "kep";
  if (HEROD_RE.test(names) && (tags.historic !== undefined || tags.amenity === "theatre" || tags.tourism === "attraction")) return "landmark";
  if (tags.tourism === "museum") return "museum";
  if (tags.railway === "station" || tags.railway === "halt" || tags.public_transport === "station") return "metro_station";
  if (tags.place === "square") return "square";
  return undefined;
}

/** Finds the graph node nearest to a point, preferring nodes at street level. */
export function makeNearestNode(graph: PedestrianGraph, extras: GraphExtras) {
  const isBelowGround = (wayId: number | undefined): boolean => {
    const t = extras.ways[String(wayId)];
    if (!t) return false;
    const level = t.level !== undefined ? Number.parseFloat(t.level) : NaN;
    const layer = t.layer !== undefined ? Number.parseFloat(t.layer) : NaN;
    return t.indoor === "yes" || (t.tunnel !== undefined && t.tunnel !== "no") || level < 0 || layer < 0;
  };
  const streetLevel = new Set<NodeId>();
  for (const e of graph.edges) {
    if (!isBelowGround(e.osmWayId)) {
      streetLevel.add(e.from);
      streetLevel.add(e.to);
    }
  }
  const candidates = graph.nodes.filter((n) => streetLevel.has(n.id));
  return (p: LngLat): { id: NodeId; distanceM: number } => {
    let best: NodeId = candidates[0]!.id;
    let bestD = Infinity;
    for (const n of candidates) {
      const d = haversineM(p, [n.lng, n.lat]);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return { id: best, distanceM: Math.round(bestD * 10) / 10 };
  };
}

export function buildPlaces(osm: OsmIndex, graph: PedestrianGraph, extras: GraphExtras, bbox: Bbox): Place[] {
  const [w, s, e, n] = bbox;
  const inside = (p: LngLat) => p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n;
  const graphNodes = new Set(graph.nodes.map((node) => node.id));
  const nearest = makeNearestNode(graph, extras);
  const places: Place[] = [];

  // Nodes of each named street, to snap a building without a mapped entrance to the street of its address.
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const streetNodes = new Map<string, Set<NodeId>>();
  for (const edge of graph.edges) {
    if (!edge.name) continue;
    let set = streetNodes.get(edge.name);
    if (!set) streetNodes.set(edge.name, (set = new Set()));
    set.add(edge.from);
    set.add(edge.to);
  }
  const snapToStreet = (street: string | undefined, p: LngLat) => {
    let best: { id: NodeId; distanceM: number } | undefined;
    for (const id of (street && streetNodes.get(street)) || []) {
      const node = nodeById.get(id)!;
      const d = haversineM(p, [node.lng, node.lat]);
      if (d <= 100 && (!best || d < best.distanceM)) best = { id, distanceM: Math.round(d * 10) / 10 };
    }
    return best;
  };

  const snap = (osmNodeId: number | undefined, p: LngLat) => {
    // A place that is itself a node of the graph (an entrance on a footway) snaps to itself.
    if (osmNodeId !== undefined && graphNodes.has(nodeIdOf(osmNodeId))) return { id: nodeIdOf(osmNodeId), distanceM: 0 };
    return nearest(p);
  };

  const all: OsmElement[] = [...osm.nodes.values(), ...osm.ways.values(), ...osm.relations.values()];

  // Stations first: entrances are named after the nearest one.
  const stations: { name: string; nameEn: string | null; p: LngLat }[] = [];

  const namedDoors = [...osm.nodes.values()].filter(n => n.tags?.entrance && n.tags.entrance !== "no" && n.tags["addr:housename"]);
  const entranceNodesOf = (el: OsmElement): OsmNode[] => {
    if (el.type === "node") {
      const labels = [el.tags?.name, el.tags?.["name:el"], el.tags?.operator];
      return namedDoors.filter(n => labels.includes(n.tags!["addr:housename"]) && haversineM([el.lon,el.lat],[n.lon,n.lat]) < 65);
    }
    const wayIds: number[] = [];
    if (el.type === "way") wayIds.push(el.id);
    if (el.type === "relation") for (const m of el.members ?? []) if (m.type === "way") wayIds.push(m.ref);
    const found = new Map<number, OsmNode>();
    for (const wayId of wayIds) {
      for (const ref of osm.ways.get(wayId)?.nodes ?? []) {
        const node = osm.nodes.get(ref);
        if (node?.tags?.entrance !== undefined && node.tags.entrance !== "no") found.set(ref, node);
      }
    }
    return [...found.values()];
  };

  for (const el of all) {
    const tags = el.tags;
    if (!tags || tags.railway === "subway_entrance") continue;
    const kind = kindOf(tags);
    if (!kind) continue;
    const p = positionOf(el);
    if (!p || !inside(p)) continue;
    const name = tags["name:el"] ?? tags.name ?? tags.official_name;
    const nameEn = tags["name:en"] ?? null;
    const venueNames: Partial<Record<PlaceKind,string>> = {theatre:"Θέατρο",cinema:"Κινηματογράφος",library:"Βιβλιοθήκη",arts_centre:"Χώρος τέχνης",concert_hall:"Αίθουσα συναυλιών"};
    const unnamed = venueNames[kind];
    if (!name && !nameEn && !unnamed) continue;
    const label = name ?? nameEn ?? (unnamed + " χωρίς καταγεγραμμένη ονομασία");
    const hasEntrance = el.type !== "node" && entranceNodesOf(el).length > 0;
    const byAddress = el.type !== "node" && !hasEntrance ? snapToStreet(tags["addr:street"], p) : undefined;
    const snapped = byAddress ?? snap(el.type === "node" ? el.id : undefined, p);
    const place: Place = {
      id: `${kind}-${slug(nameEn ?? label) || "x"}-${el.type[0]}${el.id}`,
      name: label,
      nameEn,
      kind,
      lng: round6(p[0]),
      lat: round6(p[1]),
      nearestNodeId: snapped.id,
      nearestNodeDistanceM: snapped.distanceM,
      source: `osm:${el.type}/${el.id}`,
      osmType: el.type,
      osmId: el.id,
      position: el.type === "node" ? "osm_node" : "centroid",
    };
    if (["theatre","cinema","library","arts_centre","concert_hall"].includes(kind)) {
      place.venueTags = venueTags(tags);
    }
    // Keep links to the previously catalogued landmark stable.
    if (kind === "theatre" && HEROD_RE.test(nameEn ?? label)) place.id = place.id.replace(/^theatre-/, "landmark-");
    if (byAddress) place.snappedBy = "addr:street";
    if (tags["addr:street"]) place.address = `${tags["addr:street"]}${tags["addr:housenumber"] ? " " + tags["addr:housenumber"] : ""}`;
    if (tags.wheelchair) place.wheelchair = tags.wheelchair;
    if (kind === "metro_station") stations.push({ name: label, nameEn, p });
    const entrances = entranceNodesOf(el);
    if (el.type !== "node" || entrances.length) {
      place.entranceVerified = entrances.length > 0;
      places.push(place);
      for (const node of entrances) {
        const ep: LngLat = [node.lon, node.lat];
        const es = snap(node.id, ep);
        const sub: Place = {
          id: place.venueTags ? `entrance-${el.type[0]}${el.id}-n${node.id}` : `entrance-${slug(nameEn ?? label) || "x"}-n${node.id}`,
          name: `${label} (είσοδος${node.tags?.name ? " " + node.tags.name : ""})`,
          nameEn: nameEn ? `${nameEn} (entrance${node.tags?.["name:en"] ? " " + node.tags["name:en"] : ""})` : null,
          kind: "building_entrance",
          lng: round6(ep[0]),
          lat: round6(ep[1]),
          nearestNodeId: es.id,
          nearestNodeDistanceM: es.distanceM,
          source: `osm:node/${node.id}`,
          osmType: "node",
          osmId: node.id,
          position: "osm_node",
          parentId: place.id,
        };
        if (place.venueTags && node.tags) sub.venueTags = venueTags(node.tags);
        if (node.tags?.entrance) sub.entrance = node.tags.entrance;
        if (node.tags?.wheelchair) sub.wheelchair = node.tags.wheelchair;
        if (node.tags?.level) sub.level = node.tags.level;
        places.push(sub);
      }
    } else {
      places.push(place);
    }
  }

  for (const node of osm.nodes.values()) {
    const tags = node.tags;
    if (tags?.railway !== "subway_entrance") continue;
    const p: LngLat = [node.lon, node.lat];
    if (!inside(p)) continue;
    let station: (typeof stations)[number] | undefined;
    let stationD = Infinity;
    for (const st of stations) {
      const d = haversineM(p, st.p);
      if (d < stationD) {
        stationD = d;
        station = st;
      }
    }
    if (stationD > 400) station = undefined;
    const own = tags["name:el"] ?? tags.name;
    const ownEn = tags["name:en"] ?? null;
    const ref = tags.ref ? ` ${tags.ref}` : "";
    const name = own ?? (station ? `${station.name} (είσοδος μετρό${ref})` : `Είσοδος μετρό${ref}`);
    const nameEn = ownEn ?? (station?.nameEn ? `${station.nameEn} (metro entrance${ref})` : null);
    const snapped = snap(node.id, p);
    const place: Place = {
      id: `metro_entrance-${slug(station?.nameEn ?? ownEn ?? station?.name ?? "unmatched") || "x"}-n${node.id}`,
      name,
      nameEn,
      kind: "metro_entrance",
      lng: round6(p[0]),
      lat: round6(p[1]),
      nearestNodeId: snapped.id,
      nearestNodeDistanceM: snapped.distanceM,
      source: `osm:node/${node.id}`,
      osmType: "node",
      osmId: node.id,
      position: "osm_node",
    };
    if (station) {
      place.station = station.nameEn ?? station.name;
      place.stationDistanceM = Math.round(stationD);
    }
    if (tags.wheelchair) place.wheelchair = tags.wheelchair;
    if (tags.level) place.level = tags.level;
    if (tags.ref) place.ref = tags.ref;
    places.push(place);
  }

  const order: PlaceKind[] = ["metro_station", "metro_entrance", "townhall", "kep", "museum", "landmark", "hospital", "police", "square", "building_entrance"];
  places.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id.localeCompare(b.id));
  return places;
}
