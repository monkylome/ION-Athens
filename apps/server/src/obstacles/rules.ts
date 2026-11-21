/**
 * The rules that turn AthensGov Sandbox data into routing obstacles.
 *
 * This module is pure: data in, obstacles out, with the reason for everything
 * it leaves out. All numbers are options (`DEFAULT_MAPPING_OPTIONS`).
 *
 * Citizen reports (points)
 *   1. A resolved or rejected report is no obstacle.
 *   2. The category decides whether a blind pedestrian is affected:
 *      always for sidewalk, tree, garbage, bulky_waste, water_leak, pothole;
 *      for abandoned_vehicle and other only when the text says the pavement or
 *      a crossing is blocked; never for graffiti, noise, stray_animals, streetlight.
 *   3. The report expires 12 hours after it was created. Status changes made by
 *      the municipality are not sightings, and the sandbox does not say when an
 *      upvote happened, so neither extends the life of the obstacle.
 *   4. The point is matched to the nearest walkable edge. Up to 15 m it is
 *      accepted, beyond 25 m rejected, and between the two the confidence
 *      drops linearly to half.
 *   5. One report alone is `partial` with moderate confidence. With 2 or more
 *      upvotes («Το έχω δει κι εγώ») it is `full`. A `full` whose confidence
 *      falls under 0.5 is downgraded to `partial`, because the contract says
 *      such an obstacle never closes an edge.
 *
 * Municipal projects (points, lines, polygons)
 *   1. Only projects in progress count, in the categories sidewalk, road,
 *      accessibility, square, water, cycling, until the planned end date
 *      (end of that day, Athens time).
 *   2. Every edge near the geometry is sampled every few metres. The share of
 *      samples inside the works area is the edge's coverage. A line or polygon
 *      has a buffer around it; a point is a circle.
 *   3. Coverage of 60 % or more makes the edge a candidate for `full`. It
 *      becomes `full` when the edge also runs along the works (for lines) and
 *      the category is one that takes the pavement itself. Everything else
 *      that is touched (10 % or 5 m) is `partial`.
 *
 * Everything from the sandbox is test data, so every obstacle is `synthetic: true`.
 */
import type { GraphEdge, LngLat, Obstacle } from "@ion/core";
import {
  type BBox, bboxOf, bearingDeg, distanceM, expandBBox, pointInRing, pointToLine, sampleLine,
  undirectedAngleDeg,
} from "../geo.ts";
import type { EdgeMatch } from "../routing/edge-index.ts";
import type { SandboxGeometry, SandboxProject, SandboxReport } from "../sandbox/schemas.ts";

export interface MappingOptions {
  /** Report categories that always affect a blind pedestrian. */
  reportCategories: readonly string[];
  /** Report categories that count only when the text says the way is blocked. */
  reportCategoriesIfBlocking: readonly string[];
  /** Report statuses that mean there is nothing (left) to avoid. */
  closedStatuses: readonly string[];
  /** Up to this distance from an edge a report is accepted at full confidence. */
  snapAcceptM: number;
  /** Beyond this distance a report is rejected. */
  snapRejectM: number;
  /** Share of the confidence that is left at `snapRejectM`. */
  snapFarFactor: number;
  /** Upvotes from which a report closes the edge. */
  fullBlockUpvotes: number;
  /** Confidence of a report nobody else has confirmed. */
  singleReportConfidence: number;
  /** Confidence of a report with `fullBlockUpvotes` or more. */
  confirmedReportConfidence: number;
  /** Hours after its creation when a report stops affecting routes. */
  reportTtlHours: number;
  /** Project categories that count while in progress. */
  projectCategories: readonly string[];
  /** Project categories that take the pavement itself and may close an edge. */
  projectFullCategories: readonly string[];
  /** Project statuses that mean works are on the ground. */
  projectActiveStatuses: readonly string[];
  /** Works area around a project line or polygon, in metres. */
  projectBufferM: number;
  /** Works area around a project given as a single point, in metres. */
  projectPointRadiusM: number;
  /** Distance between the samples taken along an edge. */
  sampleStepM: number;
  /** Coverage from which an edge is a candidate for `full`. */
  fullCoverage: number;
  /** Coverage from which an edge is `partial`. */
  partialCoverage: number;
  /** Covered length from which an edge is `partial`, whatever its coverage. */
  partialCoveredM: number;
  /** Largest angle between an edge and a project line for the edge to count as running along it. */
  alignedWithinDeg: number;
  projectFullConfidence: number;
  projectPartialConfidence: number;
}

export const DEFAULT_MAPPING_OPTIONS: MappingOptions = {
  reportCategories: ["sidewalk", "tree", "garbage", "bulky_waste", "water_leak", "pothole"],
  reportCategoriesIfBlocking: ["abandoned_vehicle", "other"],
  closedStatuses: ["resolved", "rejected"],
  snapAcceptM: 15,
  snapRejectM: 25,
  snapFarFactor: 0.5,
  fullBlockUpvotes: 2,
  singleReportConfidence: 0.6,
  confirmedReportConfidence: 0.85,
  reportTtlHours: 12,
  projectCategories: ["sidewalk", "road", "accessibility", "square", "water", "cycling"],
  projectFullCategories: ["sidewalk", "accessibility", "square"],
  projectActiveStatuses: ["in_progress"],
  projectBufferM: 20,
  projectPointRadiusM: 30,
  sampleStepM: 5,
  fullCoverage: 0.6,
  partialCoverage: 0.1,
  partialCoveredM: 5,
  alignedWithinDeg: 35,
  projectFullConfidence: 0.8,
  projectPartialConfidence: 0.6,
};

/** What the rules need from the walking graph. */
export interface EdgeLookup {
  nearestEdge(point: LngLat, maxDistanceM?: number): EdgeMatch | null;
  edgesInBBox(box: BBox): GraphEdge[];
}

export type SkipReason =
  | "closed" // resolved or rejected
  | "category_not_relevant"
  | "text_not_blocking"
  | "no_location"
  | "expired"
  | "too_far_from_edge"
  | "no_edge_nearby"
  | "not_in_progress"
  | "no_edges_covered";

export interface Skipped {
  ref: string;
  reason: SkipReason;
  snapDistanceM?: number;
}

export type ReportOutcome = { obstacle: Obstacle } | { skipped: Skipped };

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Lower case, no accents: Greek text comparison that survives missing tonos. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");
}

/** Words that say a pavement, a crossing or a ramp is obstructed. Matched on folded text. */
const BLOCKING_TEXT = /πεζοδρομ|διαβασ|ραμπα|εμποδ|μπλοκ|κλειν|κλειστ|φρασ|διελευσ|περασμα|οδηγο[συ]? τυφλων|sidewalk|pavement|block|obstruct/;

export function textSaysBlocked(report: Pick<SandboxReport, "title" | "description">): boolean {
  return BLOCKING_TEXT.test(fold(`${report.title} ${report.description ?? ""}`));
}

export function snapConfidenceFactor(snapDistanceM: number, opts: MappingOptions): number {
  if (snapDistanceM <= opts.snapAcceptM) return 1;
  if (snapDistanceM > opts.snapRejectM) return 0;
  const t = (snapDistanceM - opts.snapAcceptM) / (opts.snapRejectM - opts.snapAcceptM);
  return 1 - t * (1 - opts.snapFarFactor);
}

export function reportToObstacle(
  report: SandboxReport,
  edges: Pick<EdgeLookup, "nearestEdge">,
  now: Date,
  options: Partial<MappingOptions> = {},
): ReportOutcome {
  const opts = { ...DEFAULT_MAPPING_OPTIONS, ...options };
  const skip = (reason: SkipReason, snapDistanceM?: number): ReportOutcome => ({
    skipped: { ref: report.id, reason, ...(snapDistanceM === undefined ? {} : { snapDistanceM: round1(snapDistanceM) }) },
  });

  if (opts.closedStatuses.includes(report.status)) return skip("closed");
  if (!opts.reportCategories.includes(report.category)) {
    if (!opts.reportCategoriesIfBlocking.includes(report.category)) return skip("category_not_relevant");
    if (!textSaysBlocked(report)) return skip("text_not_blocking");
  }
  if (report.lat == null || report.lng == null) return skip("no_location");

  const observedMs = Date.parse(report.created_at) || 0;
  const expiresMs = observedMs + opts.reportTtlHours * 3_600_000;
  if (expiresMs <= now.getTime()) return skip("expired");

  const position: LngLat = [report.lng, report.lat];
  const match = edges.nearestEdge(position, opts.snapRejectM * 2);
  if (!match) return skip("no_edge_nearby");
  if (match.distanceM > opts.snapRejectM) return skip("too_far_from_edge", match.distanceM);

  const confirmed = report.upvotes >= opts.fullBlockUpvotes;
  const confidence = round2(
    (confirmed ? opts.confirmedReportConfidence : opts.singleReportConfidence) * snapConfidenceFactor(match.distanceM, opts),
  );
  return {
    obstacle: {
      id: `sandbox:${report.id}`,
      edgeId: match.edgeId,
      blocks: confirmed && confidence >= 0.5 ? "full" : "partial",
      type: report.category,
      label: reportLabel(report),
      source: { kind: "sandbox_request", ref: report.id },
      synthetic: true,
      observedAt: new Date(observedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      confidence,
      position,
      snapDistanceM: round1(match.distanceM),
    },
  };
}

/** "Σπασμένες πλάκες πεζοδρομίου, Αγίου Λουκά 20" */
export function reportLabel(report: Pick<SandboxReport, "title" | "address" | "category_name">): string {
  const what = report.title.trim() || report.category_name?.trim() || "Εμπόδιο";
  const street = report.address?.split(",")[0]?.trim();
  return street && !/^σημείο /i.test(street) ? `${what}, ${street}` : what;
}

interface WorksArea {
  points: LngLat[];
  lines: LngLat[][];
  polygons: LngLat[][][];
}

function worksArea(g: SandboxGeometry): WorksArea {
  const p = (c: number[]): LngLat => [c[0]!, c[1]!];
  switch (g.type) {
    case "Point": return { points: [p(g.coordinates)], lines: [], polygons: [] };
    case "MultiPoint": return { points: g.coordinates.map(p), lines: [], polygons: [] };
    case "LineString": return { points: [], lines: [g.coordinates.map(p)], polygons: [] };
    case "MultiLineString": return { points: [], lines: g.coordinates.map((l) => l.map(p)), polygons: [] };
    case "Polygon": return { points: [], lines: [], polygons: [g.coordinates.map((r) => r.map(p))] };
    case "MultiPolygon": return { points: [], lines: [], polygons: g.coordinates.map((poly) => poly.map((r) => r.map(p))) };
  }
}

function insideWorks(p: LngLat, area: WorksArea, opts: MappingOptions): boolean {
  for (const pt of area.points) if (distanceM(p, pt) <= opts.projectPointRadiusM) return true;
  for (const line of area.lines) {
    const hit = pointToLine(p, line);
    if (hit && hit.distanceM <= opts.projectBufferM) return true;
  }
  for (const poly of area.polygons) {
    const outer = poly[0];
    if (!outer) continue;
    if (pointInRing(p, outer) && !poly.slice(1).some((hole) => pointInRing(p, hole))) return true;
    const hit = pointToLine(p, outer);
    if (hit && hit.distanceM <= opts.projectBufferM) return true;
  }
  return false;
}

/** True when the edge runs roughly parallel to the nearest stretch of a project line. */
function runsAlong(edge: GraphEdge, area: WorksArea, opts: MappingOptions): boolean {
  if (area.lines.length === 0) return true; // points and polygons have no direction
  const a = edge.geometry[0];
  const b = edge.geometry[edge.geometry.length - 1];
  if (!a || !b || distanceM(a, b) < 1) return true;
  const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let best: { d: number; bearing: number } | null = null;
  for (const line of area.lines) {
    const hit = pointToLine(mid, line);
    const s0 = line[hit?.segment ?? 0];
    const s1 = line[(hit?.segment ?? 0) + 1];
    if (hit && s0 && s1 && (!best || hit.distanceM < best.d)) best = { d: hit.distanceM, bearing: bearingDeg(s0, s1) };
  }
  return !best || undirectedAngleDeg(bearingDeg(a, b), best.bearing) <= opts.alignedWithinDeg;
}

/** End of the given calendar day (YYYY-MM-DD) in Athens, as an instant. */
export function endOfDayAthens(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const utcGuess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
  // Athens is UTC+2 in winter and UTC+3 in summer: ask the time zone database which.
  const hourInAthens = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Athens", hour: "2-digit", hourCycle: "h23" }).format(new Date(utcGuess)),
  );
  const offsetH = (hourInAthens - 23 + 24) % 24;
  return new Date(utcGuess - offsetH * 3_600_000);
}

export function projectToObstacles(
  project: SandboxProject,
  edges: Pick<EdgeLookup, "edgesInBBox">,
  now: Date,
  options: Partial<MappingOptions> = {},
): { obstacles: Obstacle[]; skipped?: Skipped } {
  const opts = { ...DEFAULT_MAPPING_OPTIONS, ...options };
  const props = project.properties;
  const skip = (reason: SkipReason) => ({ obstacles: [], skipped: { ref: props.id, reason } });

  if (!opts.projectActiveStatuses.includes(props.status)) return skip("not_in_progress");
  if (!opts.projectCategories.includes(props.category)) return skip("category_not_relevant");
  const expires = props.end_date_planned ? endOfDayAthens(props.end_date_planned) : null;
  if (expires && expires.getTime() <= now.getTime()) return skip("expired");

  const area = worksArea(project.geometry);
  const all = [...area.points, ...area.lines.flat(), ...area.polygons.flat(2)];
  const box = bboxOf(all);
  if (!box) return skip("no_location");

  const started = props.start_date ? Date.parse(props.start_date) : NaN;
  const observedAt = new Date(Number.isNaN(started) ? now.getTime() : Math.min(started, now.getTime())).toISOString();
  const mayClose = opts.projectFullCategories.includes(props.category);
  const obstacles: Obstacle[] = [];

  for (const edge of edges.edgesInBBox(expandBBox(box, Math.max(opts.projectBufferM, opts.projectPointRadiusM)))) {
    const samples = sampleLine(edge.geometry, opts.sampleStepM);
    if (samples.length === 0) continue;
    const coverage = samples.filter((s) => insideWorks(s, area, opts)).length / samples.length;
    const coveredM = coverage * edge.lengthM;
    const full = coverage >= opts.fullCoverage && mayClose && runsAlong(edge, area, opts);
    if (!full && coverage < opts.partialCoverage && coveredM < opts.partialCoveredM) continue;
    if (coverage === 0) continue;
    obstacles.push({
      id: `sandbox:${props.id}:${edge.id}`,
      edgeId: edge.id,
      blocks: full ? "full" : "partial",
      type: "works",
      label: `Έργα του Δήμου: ${props.title}`,
      source: { kind: "sandbox_project", ref: props.id },
      synthetic: true,
      observedAt,
      expiresAt: expires ? expires.toISOString() : null,
      confidence: full ? opts.projectFullConfidence : opts.projectPartialConfidence,
      position: samples[Math.floor(samples.length / 2)]!,
    });
  }
  return obstacles.length > 0 ? { obstacles } : skip("no_edges_covered");
}

export interface MappingResult {
  obstacles: Obstacle[];
  /** Everything that produced no obstacle, with the reason. */
  skipped: Skipped[];
}

export function mapSandboxData(
  reports: readonly SandboxReport[],
  projects: readonly SandboxProject[],
  edges: EdgeLookup,
  now: Date,
  options: Partial<MappingOptions> = {},
): MappingResult {
  const obstacles: Obstacle[] = [];
  const skipped: Skipped[] = [];
  for (const report of reports) {
    const out = reportToObstacle(report, edges, now, options);
    if ("obstacle" in out) obstacles.push(out.obstacle);
    else skipped.push(out.skipped);
  }
  for (const project of projects) {
    const out = projectToObstacles(project, edges, now, options);
    obstacles.push(...out.obstacles);
    if (out.skipped) skipped.push(out.skipped);
  }
  obstacles.sort((a, b) => a.id.localeCompare(b.id));
  return { obstacles, skipped };
}
