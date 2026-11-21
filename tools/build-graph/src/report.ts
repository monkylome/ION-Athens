/**
 * Data quality report. Every number is measured on the graph that was just built.
 */
import type { EdgeKind, GraphEdge, LngLat, NodeId, PedestrianGraph, Tri } from "../../../packages/core/src/types.ts";
import { midpointAlong, pointSegmentDistanceM } from "./geo.ts";
import type { BuildStats, GraphExtras } from "./graph.ts";
import type { Bbox } from "./overpass.ts";
import type { Place } from "./places.ts";

export interface ReportInput {
  graph: PedestrianGraph;
  extras: GraphExtras;
  stats: BuildStats;
  places: Place[];
  rawMeta: { source: string; bbox: Bbox; endpoint: string; fetchedAt: string; osmBaseTimestamp: string | null; attempts: string[]; offline: boolean };
  files: { label: string; bytes: number }[];
  findings?: string;
}

const KINDS: EdgeKind[] = ["sidewalk", "footway", "pedestrian", "crossing", "steps", "path", "shared_road"];

const km = (m: number) => (m / 1000).toFixed(2);
const pct = (part: number, whole: number) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "n/a");
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

interface Tally {
  yes: number;
  no: number;
  unknown: number;
}
const tally = (): Tally => ({ yes: 0, no: 0, unknown: 0 });
const tallyCells = (t: Tally) => {
  const total = t.yes + t.no + t.unknown;
  return [t.yes, t.no, t.unknown, pct(t.yes + t.no, total)];
};

/** One record per OSM crossing way (a way is usually cut into two edges at the road centre line). */
function crossingWays(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Map<number | string, GraphEdge>();
  for (const e of edges) {
    if (e.kind !== "crossing") continue;
    const key = e.osmWayId ?? e.id;
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()];
}

function crossingTable(ways: GraphEdge[]): string {
  const signals = tally();
  const sound = tally();
  const marked = tally();
  const tactile = tally();
  for (const e of ways) {
    signals[e.crossing?.signals ?? "unknown"]++;
    sound[e.crossing?.sound ?? "unknown"]++;
    marked[e.crossing?.marked ?? "unknown"]++;
    tactile[e.tactilePaving ?? "unknown"]++;
  }
  return table(
    ["Fact", "yes", "no", "unknown", "known"],
    [
      ["Traffic signals", ...tallyCells(signals)],
      ["Audible signal (`traffic_signals:sound`)", ...tallyCells(sound)],
      ["Marked", ...tallyCells(marked)],
      ["Tactile paving", ...tallyCells(tactile)],
    ],
  );
}

// ---------- graph search ----------

interface Adjacent {
  to: NodeId;
  edge: GraphEdge;
}

function adjacency(edges: GraphEdge[]): Map<NodeId, Adjacent[]> {
  const adj = new Map<NodeId, Adjacent[]>();
  const push = (a: NodeId, b: NodeId, edge: GraphEdge) => {
    let list = adj.get(a);
    if (!list) adj.set(a, (list = []));
    list.push({ to: b, edge });
  };
  for (const e of edges) {
    push(e.from, e.to, e);
    push(e.to, e.from, e);
  }
  return adj;
}

/** Breadth-first search from several sources. Returns the number of edges to the nearest target, or null. */
export function bfsHops(adj: Map<NodeId, Adjacent[]>, sources: NodeId[], targets: Set<NodeId>): number | null {
  const dist = new Map<NodeId, number>();
  const queue: NodeId[] = [];
  for (const s of sources) {
    if (!dist.has(s)) {
      dist.set(s, 0);
      queue.push(s);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    if (targets.has(cur)) return dist.get(cur)!;
    for (const { to } of adj.get(cur) ?? []) {
      if (!dist.has(to)) {
        dist.set(to, dist.get(cur)! + 1);
        queue.push(to);
      }
    }
  }
  return null;
}

/** Shortest path by length (Dijkstra with a binary heap). Only used to describe what a path is made of. */
function shortestPath(
  adj: Map<NodeId, Adjacent[]>,
  sources: NodeId[],
  targets: Set<NodeId>,
  weight: (e: GraphEdge) => number = (e) => e.lengthM,
): { lengthM: number; edges: GraphEdge[] } | null {
  const dist = new Map<NodeId, number>();
  const via = new Map<NodeId, Adjacent & { from: NodeId }>();
  const heap: [number, NodeId][] = [];
  const push = (item: [number, NodeId]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]![0] <= heap[i]![0]) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = (): [number, NodeId] | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  for (const s of sources) {
    dist.set(s, 0);
    push([0, s]);
  }
  for (;;) {
    const item = pop();
    if (!item) return null;
    const [d, cur] = item;
    if (d > (dist.get(cur) ?? Infinity)) continue;
    if (targets.has(cur)) {
      const edges: GraphEdge[] = [];
      let at = cur;
      for (let step = via.get(at); step; step = via.get(at)) {
        edges.push(step.edge);
        at = step.from;
      }
      return { lengthM: edges.reduce((sum, e) => sum + e.lengthM, 0), edges: edges.reverse() };
    }
    for (const next of adj.get(cur) ?? []) {
      const nd = d + weight(next.edge);
      if (nd < (dist.get(next.to) ?? Infinity)) {
        dist.set(next.to, nd);
        via.set(next.to, { ...next, from: cur });
        push([nd, next.to]);
      }
    }
  }
}

function describePath(path: { lengthM: number; edges: GraphEdge[] } | null): string {
  if (!path) return "no path";
  const byKind = new Map<string, number>();
  for (const e of path.edges) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + e.lengthM);
  const parts = [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, m]) => `${k} ${Math.round(m)} m`);
  const cw = crossingWays(path.edges);
  const sig = cw.filter((e) => e.crossing?.signals === "yes").length;
  const sound = cw.filter((e) => e.crossing?.sound === "yes").length;
  const names: string[] = [];
  for (const e of path.edges) if (e.name && names[names.length - 1] !== e.name) names.push(e.name);
  const via = names.length > 0 ? ` Via: ${names.slice(0, 12).join(" → ")}${names.length > 12 ? " …" : ""}.` : "";
  return `${Math.round(path.lengthM)} m, ${path.edges.length} edges (${parts.join(", ")}); ${cw.length} mapped crossing ways, ${sig} with signals, ${sound} with sound.${via}`;
}

// ---------- street corridors ----------

function streetSection(title: string, pattern: RegExp, graph: PedestrianGraph, extras: GraphExtras, radiusM: number): string {
  const street = graph.edges.filter((e) => (e.kind === "shared_road" || e.kind === "pedestrian") && ((e.name && pattern.test(e.name)) || (e.nameEn && pattern.test(e.nameEn))));
  const out: string[] = [`### ${title}`, ""];
  if (street.length === 0) {
    out.push(`No street or pedestrian-street edge with a name matching \`${pattern.source}\` is in the graph.`, "");
    return out.join("\n");
  }
  const streetLen = street.reduce((s, e) => s + e.lengthM, 0);
  const names = [...new Set(street.map((e) => `${e.name ?? ""}${e.nameEn ? ` / ${e.nameEn}` : ""}`))];
  out.push(`Matched names: ${names.join("; ")}. Centre line in the graph: ${Math.round(streetLen)} m in ${street.length} edges (${new Set(street.map((e) => e.osmWayId)).size} OSM ways).`, "");

  const byClass = new Map<string, number>();
  for (const e of street) {
    const t = extras.ways[String(e.osmWayId)] ?? {};
    const sidewalk = ["sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right"].filter((k) => t[k] !== undefined).map((k) => `${k}=${t[k]}`).join(", ") || "no sidewalk tag";
    const key = `highway=${t.highway ?? "?"}${t.area === "yes" ? " (area)" : ""} | ${e.kind} | ${sidewalk} | surface=${e.surface ?? "not tagged"} | tactile_paving=${t.tactile_paving ?? "not tagged"}`;
    byClass.set(key, (byClass.get(key) ?? 0) + e.lengthM);
  }
  out.push(
    table(
      ["OSM class of the street itself", "Graph kind", "Sidewalk tags on the street", "Surface", "Tactile paving", "Length m"],
      [...byClass.entries()].sort((a, b) => b[1] - a[1]).map(([k, m]) => [...k.split(" | "), Math.round(m)]),
    ),
    "",
  );

  const segments: [LngLat, LngLat][] = [];
  const streetIds = new Set(street.map((e) => e.id));
  for (const e of street) for (let i = 1; i < e.geometry.length; i++) segments.push([e.geometry[i - 1]!, e.geometry[i]!]);
  const near = graph.edges.filter((e) => {
    if (streetIds.has(e.id)) return false;
    const mid = midpointAlong(e.geometry);
    return segments.some(([a, b]) => pointSegmentDistanceM(mid, a, b) <= radiusM);
  });
  const lenByKind = new Map<string, number>();
  for (const e of near) lenByKind.set(e.kind, (lenByKind.get(e.kind) ?? 0) + e.lengthM);
  const sidewalkLen = lenByKind.get("sidewalk") ?? 0;
  out.push(
    `Other edges whose mid point lies within ${radiusM} m of the centre line:`,
    "",
    table(["Kind", "Edges", "Length m"], KINDS.filter((k) => lenByKind.has(k)).map((k) => [k, near.filter((e) => e.kind === k).length, Math.round(lenByKind.get(k)!)])),
    "",
    `Separately mapped pavement (\`footway=sidewalk\`) in the corridor: ${Math.round(sidewalkLen)} m, which is ${pct(sidewalkLen, 2 * streetLen)} of two full sides (2 × ${Math.round(streetLen)} m). The corridor also catches the first metres of side streets, so read this as an upper bound.`,
    "",
  );
  const cw = crossingWays(near);
  if (cw.length > 0) {
    out.push(`Crossing ways in the corridor: ${cw.length}.`, "", crossingTable(cw), "");
  } else {
    out.push("No crossing way (`footway=crossing`) is mapped in the corridor.", "");
  }
  const crossingNodes = new Set<NodeId>();
  for (const e of street) for (const id of [e.from, e.to]) if (extras.crossingNodes[id]) crossingNodes.add(id);
  const bare = [...crossingNodes].filter((id) => !extras.crossingNodes[id]!.onCrossingEdge).length;
  out.push(`\`highway=crossing\` nodes on the centre line: ${crossingNodes.size}, of which ${bare} have no crossing way through them.`, "");
  return out.join("\n");
}

// ---------- report ----------

export function buildReport(input: ReportInput): string {
  const { graph, extras, stats, places, rawMeta } = input;
  const edges = graph.edges;
  const totalLen = edges.reduce((s, e) => s + e.lengthM, 0);
  const out: string[] = [];
  const p = (...lines: string[]) => out.push(...lines);

  p(
    "# ION Athens pedestrian graph: data quality report",
    "",
    "Generated by `tools/build-graph` from the graph it just built. Do not edit by hand: the next build overwrites this file.",
    "",
    `- Built: ${graph.meta.builtAt}${rawMeta.offline ? " (offline, from the saved download)" : ""}`,
    `- Downloaded: ${rawMeta.fetchedAt} from ${rawMeta.endpoint}`,
    `- OpenStreetMap data as of: ${rawMeta.osmBaseTimestamp ?? "not stated by the server"} (${rawMeta.source === "osm-api" ? "the OSM API serves live data, so this is the download time" : "the Overpass server's `timestamp_osm_base`"})`,
    `- Bounding box [west, south, east, north]: ${graph.meta.bbox.join(", ")}`,
    `- Source: ${graph.meta.source}. Licence: ${graph.meta.licence}. Attribution: ${graph.meta.attribution}`,
    "",
    "Download attempts:",
    "",
    ...rawMeta.attempts.map((a) => `- ${a}`),
    "",
  );

  // 1. size
  const nodeKinds = new Map<string, number>();
  for (const n of graph.nodes) nodeKinds.set(n.kind, (nodeKinds.get(n.kind) ?? 0) + 1);
  p(
    "## 1. Size",
    "",
    `- Nodes: ${graph.nodes.length} (${[...nodeKinds.entries()].map(([k, c]) => `${k} ${c}`).join(", ")})`,
    `- Edges: ${edges.length}, from ${new Set(edges.map((e) => e.osmWayId)).size} OSM ways`,
    `- Total length: ${km(totalLen)} km`,
    "",
    table(["File", "Size"], input.files.map((f) => [`\`${f.label}\``, `${(f.bytes / 1024).toFixed(0)} kB`])),
    "",
  );

  // 2. build
  const excluded = Object.entries(stats.waysExcluded).sort((a, b) => b[1] - a[1]);
  p(
    "## 2. What the build kept and dropped",
    "",
    `- \`highway=*\` ways in the download: ${stats.highwayWaysInRaw}, plus ${stats.multipolygonMemberWays} outline ways of pedestrian multipolygons`,
    `- Ways used: ${stats.waysUsed}. Ways cut at the bounding box: ${stats.waysClippedAtBbox}`,
    `- Ways excluded: ${excluded.reduce((s, [, c]) => s + c, 0)} (${excluded.map(([k, c]) => `${k}: ${c}`).join("; ")})`,
    `- Edges of zero length dropped: ${stats.zeroLengthEdgesDropped}`,
    `- Before the component filter: ${stats.before.nodes} nodes, ${stats.before.edges} edges, ${km(stats.before.lengthM)} km in ${stats.before.components} connected components`,
    `- Dropped outside the largest component: ${stats.dropped.nodes} nodes, ${stats.dropped.edges} edges, ${km(stats.dropped.lengthM)} km (${pct(stats.dropped.lengthM, stats.before.lengthM)} of the length) in ${stats.dropped.components} components`,
    `- Dropped length by kind: ${Object.entries(stats.dropped.lengthByKind).sort((a, b) => b[1] - a[1]).map(([k, m]) => `${k} ${Math.round(m)} m`).join(", ") || "none"}`,
    "",
  );
  if (stats.largestDroppedComponents.length > 0) {
    p(
      "Largest dropped components:",
      "",
      table(
        ["Edges", "Length m", "Names", "Example OSM way"],
        stats.largestDroppedComponents.map((c) => [c.edges, c.lengthM, c.sampleNames.join(", ") || "(unnamed)", c.sampleWay ?? ""]),
      ),
      "",
    );
  }

  // 3. kinds
  p("## 3. Length by edge kind", "");
  p(
    table(
      ["Kind", "Edges", "Length km", "Share of length", "With a name"],
      KINDS.map((k) => {
        const list = edges.filter((e) => e.kind === k);
        const len = list.reduce((s, e) => s + e.lengthM, 0);
        const named = list.filter((e) => e.name).reduce((s, e) => s + e.lengthM, 0);
        return [k, list.length, km(len), pct(len, totalLen), pct(named, len)];
      }),
    ),
    "",
  );
  const roadClass = new Map<string, { len: number; separate: number; anySidewalkTag: number }>();
  for (const e of edges) {
    if (e.kind !== "shared_road") continue;
    const t = extras.ways[String(e.osmWayId)] ?? {};
    const rec = roadClass.get(t.highway ?? "?") ?? { len: 0, separate: 0, anySidewalkTag: 0 };
    rec.len += e.lengthM;
    const values = [t.sidewalk, t["sidewalk:both"], t["sidewalk:left"], t["sidewalk:right"]].filter((v): v is string => v !== undefined);
    if (values.length > 0) rec.anySidewalkTag += e.lengthM;
    if (values.includes("separate")) rec.separate += e.lengthM;
    roadClass.set(t.highway ?? "?", rec);
  }
  p(
    "`shared_road` by OSM road class. These are street centre lines: the graph cannot say on which side a person walks, or whether a pavement exists there.",
    "",
    table(
      ["highway=", "Length km", "Has any `sidewalk*` tag", "Tagged `sidewalk=separate`"],
      [...roadClass.entries()].sort((a, b) => b[1].len - a[1].len).map(([k, r]) => [k, km(r.len), pct(r.anySidewalkTag, r.len), pct(r.separate, r.len)]),
    ),
    "",
  );

  // 4. crossings
  const cw = crossingWays(edges);
  const crossingEdges = edges.filter((e) => e.kind === "crossing");
  const cn = Object.values(extras.crossingNodes);
  const bareNodes = cn.filter((c) => !c.onCrossingEdge);
  const nodeTally = (list: typeof cn, key: "signals" | "sound" | "marked" | "tactilePaving") => {
    const t = tally();
    for (const c of list) t[c[key] as Tri]++;
    return t;
  };
  p(
    "## 4. Crossings",
    "",
    `Crossing edges: ${crossingEdges.length}, from ${cw.length} OSM crossing ways (a way is cut where it meets the road centre line, so one crossing is usually two edges with the same facts). Counted per OSM way, facts from the way and from its \`highway=crossing\` node:`,
    "",
    crossingTable(cw),
    "",
    `\`highway=crossing\` nodes in the graph: ${cn.length}. ${cn.length - bareNodes.length} lie on a crossing edge. ${bareNodes.length} do not: there a road and a footway or another road meet at a crossing node, but no \`footway=crossing\` way is drawn, so no edge of kind "crossing" exists and the contract has no place for the node's facts. They are in \`extras.json\` under \`crossingNodes\`. For those ${bareNodes.length} nodes:`,
    "",
    table(
      ["Fact", "yes", "no", "unknown", "known"],
      [
        ["Traffic signals", ...tallyCells(nodeTally(bareNodes, "signals"))],
        ["Audible signal", ...tallyCells(nodeTally(bareNodes, "sound"))],
        ["Marked", ...tallyCells(nodeTally(bareNodes, "marked"))],
        ["Tactile paving", ...tallyCells(nodeTally(bareNodes, "tactilePaving"))],
      ],
    ),
    "",
  );
  // Where the audible signals are: the roads that meet at the crossing.
  const roadNamesAt = new Map<NodeId, Set<string>>();
  for (const e of edges) {
    if (e.kind !== "shared_road" || !e.name) continue;
    for (const id of [e.from, e.to]) (roadNamesAt.get(id) ?? roadNamesAt.set(id, new Set()).get(id)!).add(e.name);
  }
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const soundRows: (string | number)[][] = [];
  for (const way of cw.filter((e) => e.crossing?.sound === "yes")) {
    const parts = crossingEdges.filter((e) => e.osmWayId === way.osmWayId);
    const names = new Set<string>();
    for (const e of parts) for (const id of [e.from, e.to]) for (const name of roadNamesAt.get(id) ?? []) names.add(name);
    const at = nodeById.get(way.from)!;
    soundRows.push([`way ${way.osmWayId}`, [...names].join(" / ") || "(no named road at its nodes)", `${at.lat}, ${at.lng}`, way.crossing!.signals, way.tactilePaving ?? "unknown"]);
  }
  for (const [id, c] of Object.entries(extras.crossingNodes)) {
    if (c.sound !== "yes" || c.onCrossingEdge) continue;
    const at = nodeById.get(id)!;
    soundRows.push([`node ${at.osmNodeId}`, [...(roadNamesAt.get(id) ?? [])].join(" / ") || "(no named road)", `${at.lat}, ${at.lng}`, c.signals, c.tactilePaving]);
  }
  p(`Crossings tagged with an audible signal (${soundRows.length}):`, "", table(["OSM element", "Roads at the crossing", "lat, lng", "Signals", "Tactile paving"], soundRows), "");

  // 5. accessibility tags
  const nonCrossing = edges.filter((e) => e.kind !== "crossing");
  const lenWhere = (list: GraphEdge[], f: (e: GraphEdge) => boolean) => list.filter(f).reduce((s, e) => s + e.lengthM, 0);
  const ncLen = lenWhere(nonCrossing, () => true);
  const surfaces = new Map<string, number>();
  for (const e of edges) surfaces.set(e.surface ?? "(not tagged)", (surfaces.get(e.surface ?? "(not tagged)") ?? 0) + e.lengthM);
  const belowGround = edges.filter((e) => {
    const t = extras.ways[String(e.osmWayId)] ?? {};
    return t.indoor === "yes" || (t.tunnel !== undefined && t.tunnel !== "no") || Number.parseFloat(t.level ?? "0") < 0 || Number.parseFloat(t.layer ?? "0") < 0;
  });
  const restricted = new Map<string, number>();
  for (const e of edges) {
    const t = extras.ways[String(e.osmWayId)] ?? {};
    for (const k of ["access", "foot", "fee", "opening_hours"]) {
      if (t[k] !== undefined) {
        const key = k === "opening_hours" ? "opening_hours=*" : `${k}=${t[k]}`;
        restricted.set(key, (restricted.get(key) ?? 0) + e.lengthM);
      }
    }
  }
  const barriers = new Map<string, number>();
  for (const t of Object.values(extras.nodes)) if (t.barrier) barriers.set(t.barrier, (barriers.get(t.barrier) ?? 0) + 1);
  p(
    "## 5. Other accessibility tags",
    "",
    `- \`tactile_paving\` on edges that are not crossings (${km(ncLen)} km): yes ${km(lenWhere(nonCrossing, (e) => e.tactilePaving === "yes"))} km, no ${km(lenWhere(nonCrossing, (e) => e.tactilePaving === "no"))} km, not tagged or other value ${km(lenWhere(nonCrossing, (e) => e.tactilePaving === undefined || e.tactilePaving === "unknown"))} km`,
    `- \`wheelchair\` on edges: yes ${km(lenWhere(edges, (e) => e.wheelchair === "yes"))} km, no ${km(lenWhere(edges, (e) => e.wheelchair === "no"))} km, not tagged ${km(lenWhere(edges, (e) => e.wheelchair === undefined))} km`,
    `- \`surface\`: ${[...surfaces.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, m]) => `${k} ${km(m)} km`).join(", ")}`,
    `- Steps: ${edges.filter((e) => e.kind === "steps").length} edges, ${km(lenWhere(edges, (e) => e.kind === "steps"))} km`,
    `- Edges below ground or indoors (\`tunnel\`, \`indoor=yes\`, negative \`level\` or \`layer\`): ${belowGround.length} edges, ${km(lenWhere(belowGround, () => true))} km (${[...new Set(belowGround.map((e) => e.kind))].join(", ") || "none"}). The contract cannot mark them; see \`extras.json\`.`,
    `- Access tags on kept edges (length km): ${[...restricted.entries()].sort((a, b) => b[1] - a[1]).map(([k, m]) => `${k} ${km(m)}`).join(", ") || "none"}`,
    `- Barrier nodes that are graph nodes: ${[...barriers.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(", ") || "none"}. Their tags are in \`extras.json\`; the graph does not block them.`,
    "",
  );

  const siteEdgeIds = new Set(extras.archaeologicalSites.flatMap((site) => site.edgeIds));
  p(
    "### Edges inside archaeological sites",
    "",
    "Edges whose mid point lies inside the mapped outline of a `historic=archaeological_site` area. The graph keeps them, because OSM puts no access tag on them, but several of these sites are fenced and ticketed. Whether a site is open and free is not in the data: check before a route uses these edges. The edge ids are in `extras.json` under `archaeologicalSites`.",
    "",
    extras.archaeologicalSites.length === 0
      ? "None found."
      : table(
          ["Site", "OSM element", "Edges", "Length m", "fee", "opening_hours", "Outline complete"],
          extras.archaeologicalSites.map((site) => [site.nameEn ?? site.name, site.source, site.edgeIds.length, site.lengthM, site.fee ?? "not tagged", site.openingHours ? "tagged" : "not tagged", site.outlineComplete ? "yes" : "no"]),
        ),
    "",
  );

  // 6. streets
  p(
    "## 6. Pavement mapping along Athinas and the Acropolis walk",
    "",
    streetSection("Athinas (Αθηνάς)", /^(Οδός )?Αθηνάς$|^Athinas/i, graph, extras, 20),
    streetSection("Dionysiou Areopagitou (Διονυσίου Αρεοπαγίτου)", /Αρεοπαγίτου|Areopagitou/i, graph, extras, 20),
    streetSection("Apostolou Pavlou (Αποστόλου Παύλου)", /Αποστόλου Παύλου|Apostolou Pavlou/i, graph, extras, 20),
  );

  // 7. connectivity
  const adjAll = adjacency(edges);
  const adjNoRoad = adjacency(edges.filter((e) => e.kind !== "shared_road"));
  const adjNoRoadNoSteps = adjacency(edges.filter((e) => e.kind !== "shared_road" && e.kind !== "steps"));
  const adjNoSites = adjacency(edges.filter((e) => !siteEdgeIds.has(e.id)));
  const adjNoSitesNoRoad = adjacency(edges.filter((e) => !siteEdgeIds.has(e.id) && e.kind !== "shared_road"));
  const nodesOf = (list: Place[]) => [...new Set(list.map((pl) => pl.nearestNodeId))];
  const metro = (re: RegExp) => {
    const entrances = places.filter((pl) => pl.kind === "metro_entrance" && pl.station !== undefined && re.test(pl.station));
    if (entrances.length > 0) return { label: `${entrances.length} mapped entrances of ${entrances[0]!.station}`, places: entrances };
    const stations = places.filter((pl) => pl.kind === "metro_station" && re.test(`${pl.name} ${pl.nameEn ?? ""}`));
    return { label: `station point (${stations.length} elements, no mapped entrance)`, places: stations };
  };
  const townhalls = places.filter((pl) => pl.kind === "townhall");
  const cityHall = townhalls.filter((pl) => /Δημαρχ|City Hall|Town Hall/i.test(`${pl.name} ${pl.nameEn ?? ""}`));
  const cityHallEntrances = places.filter((pl) => pl.kind === "building_entrance" && cityHall.some((c) => c.id === pl.parentId));
  const hallTarget = cityHallEntrances.length > 0 ? cityHallEntrances : cityHall;
  const pairs: { title: string; from: { label: string; places: Place[] }; to: { label: string; places: Place[] } }[] = [
    {
      title: "Monastiraki station → Athens City Hall",
      from: metro(/Monastiraki|Μοναστηράκι/i),
      to: { label: cityHallEntrances.length > 0 ? `${cityHallEntrances.length} mapped entrances of the City Hall` : `City Hall building centroid (${cityHall.map((c) => c.source).join(", ") || "not found"}), no mapped entrance`, places: hallTarget },
    },
    { title: "Akropoli station → Thiseio station", from: metro(/Akropoli|Acropoli|Ακρόπολη/i), to: metro(/Thiseio|Thissio|Θησείο/i) },
  ];
  p(
    "## 7. Connectivity checks",
    "",
    "Start and end are the graph nodes nearest to the places in `places.json`. The first line is a breadth-first search over all edges. The next lines are shortest paths by length only, to show what such a path is made of. They are not ION routes: the routing engine applies its own costs.",
    "",
  );
  for (const pair of pairs) {
    p(`### ${pair.title}`, "");
    const sources = nodesOf(pair.from.places);
    const targets = new Set(nodesOf(pair.to.places));
    p(`- From: ${pair.from.label}; nodes ${sources.join(", ") || "none"}`, `- To: ${pair.to.label}; nodes ${[...targets].join(", ") || "none"}`);
    if (sources.length === 0 || targets.size === 0) {
      p("- **Not checked: a place is missing from the OSM data.**", "");
      continue;
    }
    const hops = bfsHops(adjAll, sources, targets);
    p(
      `- Breadth-first search: **${hops === null ? "NO PATH" : `path exists, ${hops} edges`}**`,
      `- Shortest by length, all edge kinds: ${describePath(shortestPath(adjAll, sources, targets))}`,
      `- Shortest without \`shared_road\` (only mapped foot infrastructure): ${describePath(shortestPath(adjNoRoad, sources, targets))}`,
      `- Shortest without \`shared_road\` and without steps: ${describePath(shortestPath(adjNoRoadNoSteps, sources, targets))}`,
      `- Shortest avoiding every edge inside an archaeological site outline: ${describePath(shortestPath(adjNoSites, sources, targets))}`,
      `- Shortest avoiding those edges and \`shared_road\`: ${describePath(shortestPath(adjNoSitesNoRoad, sources, targets))}`,
      "",
    );
  }

  // The route the brief describes: along Dionysiou Areopagitou and Apostolou Pavlou.
  const walkRe = /Αρεοπαγίτου|Αποστόλου Παύλου/;
  const onWalk = (e: GraphEdge) => e.name !== undefined && walkRe.test(e.name);
  const akropoli = metro(/Akropoli|Acropoli|Ακρόπολη/i);
  const thiseio = metro(/Thiseio|Thissio|Θησείο/i);
  if (akropoli.places.length > 0 && thiseio.places.length > 0) {
    const walk = shortestPath(adjAll, nodesOf(akropoli.places), new Set(nodesOf(thiseio.places)), (e) => (onWalk(e) ? e.lengthM : e.lengthM * 10));
    p("### Akropoli station → Thiseio station along the pedestrian walk", "");
    if (walk) {
      const walkM = walk.edges.filter(onWalk).reduce((sum, e) => sum + e.lengthM, 0);
      const off = walk.edges.filter((e) => !onWalk(e));
      const inSites = walk.edges.filter((e) => siteEdgeIds.has(e.id)).reduce((sum, e) => sum + e.lengthM, 0);
      const surfaces = new Map<string, number>();
      for (const e of walk.edges) surfaces.set(e.surface ?? "not tagged", (surfaces.get(e.surface ?? "not tagged") ?? 0) + e.lengthM);
      p(
        "A path that strongly prefers edges named Διονυσίου Αρεοπαγίτου or Αποστόλου Παύλου (other edges cost ten times their length), to test whether the two streets form one continuous line in the graph.",
        "",
        `- ${describePath(walk)}`,
        `- On the two named streets: ${Math.round(walkM)} m. Off them: ${Math.round(off.reduce((sum, e) => sum + e.lengthM, 0))} m in ${off.length} edges (${[...new Set(off.map((e) => `${e.kind}${e.name ? " " + e.name : ""}`))].join("; ") || "none"}).`,
        `- Inside an archaeological site outline: ${Math.round(inSites)} m (${extras.archaeologicalSites.filter((site) => walk.edges.some((e) => site.edgeIds.includes(e.id))).map((site) => site.nameEn ?? site.name).join(", ") || "none"}).`,
        `- Surface: ${[...surfaces.entries()].sort((a, b) => b[1] - a[1]).map(([k, m]) => `${k} ${Math.round(m)} m`).join(", ")}. Tactile paving tagged yes on ${Math.round(walk.edges.filter((e) => e.tactilePaving === "yes").reduce((sum, e) => sum + e.lengthM, 0))} m.`,
        "",
      );
    } else p("No path.", "");
  }

  // 8. places
  const byKind = new Map<string, Place[]>();
  for (const pl of places) byKind.set(pl.kind, [...(byKind.get(pl.kind) ?? []), pl]);
  p("## 8. Places", "", table(["Kind", "Count", "Median distance to graph node m", "Max m"], [...byKind.entries()].map(([k, list]) => {
    const d = list.map((pl) => pl.nearestNodeDistanceM).sort((a, b) => a - b);
    return [k, list.length, d[Math.floor(d.length / 2)]!, d[d.length - 1]!];
  })), "");
  const entrancesByStation = new Map<string, number>();
  for (const pl of byKind.get("metro_entrance") ?? []) entrancesByStation.set(pl.station ?? "(no station within 400 m)", (entrancesByStation.get(pl.station ?? "(no station within 400 m)") ?? 0) + 1);
  p(
    `- Metro entrances by nearest station: ${[...entrancesByStation.entries()].map(([k, c]) => `${k} ${c}`).join(", ") || "none mapped"}`,
    `- Station elements: ${(byKind.get("metro_station") ?? []).map((pl) => `${pl.nameEn ?? pl.name} (${pl.source})`).join(", ") || "none"}`,
    `- Town halls: ${townhalls.map((pl) => `${pl.name} (${pl.source}, entranceVerified=${String(pl.entranceVerified ?? "n/a")}, node ${pl.nearestNodeId} at ${pl.nearestNodeDistanceM} m${pl.snappedBy ? `, snapped to the street of its OSM address ${pl.address}` : ""})`).join("; ") || "none"}`,
    `- Buildings with a mapped entrance: ${places.filter((pl) => pl.entranceVerified === true).map((pl) => pl.nameEn ?? pl.name).join(", ") || "none"}`,
    `- Places more than 40 m from their graph node: ${places.filter((pl) => pl.nearestNodeDistanceM > 40).map((pl) => `${pl.nameEn ?? pl.name} (${pl.nearestNodeDistanceM} m)`).join(", ") || "none"}`,
    "",
  );

  if (input.findings) p(input.findings.trim(), "");
  return out.join("\n");
}
