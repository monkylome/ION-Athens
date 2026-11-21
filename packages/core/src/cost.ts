/**
 * Cost model. One function, edgeCost, turns an edge and the obstacles on it
 * into a cost in metre-equivalents. Time is always passed in.
 */
import type { CrossingInfo, EdgeKind, GraphEdge, Obstacle, PavementSurvey } from "./types.ts";

/** A moment in time: ISO string, epoch milliseconds, or a Date. */
export type TimeInput = string | number | Date;

export interface CostOptions {
  /** Fixed penalty added to every `steps` edge. */
  stepsPenaltyM: number;
  busyFactor?: number;
  eventEdges?: ReadonlySet<string>;
  /** Length multiplier for `shared_road` edges (walking on the carriageway). */
  sharedRoadFactor: number;
  /** Length multiplier for edges with tactilePaving "yes". Below 1 is a bonus. */
  tactilePavingFactor: number;
  /** Crossing with signals "yes" and sound "yes". */
  crossingSignalsWithSoundM: number;
  /** Crossing with signals "yes" and sound "no" or "unknown" (not confirmed). */
  crossingSignalsNoSoundM: number;
  /** Crossing with signals "no". */
  crossingUnsignalledM: number;
  /**
   * Crossing with signals "unknown": not confirmed, so dearer than any signalled
   * crossing, but cheaper than a confirmed "no". Most OpenStreetMap crossings are
   * untagged, and pricing them all as unsignalled would bend every route.
   */
  crossingSignalsUnknownM: number;
  /** Cost multiplier for an edge with a partial (or low-confidence full) obstacle. */
  partialObstacleFactor: number;
  /** A `full` obstacle closes its edge at or above this confidence. */
  closingConfidence: number;

  // Survey values (set by applyEnrichment). A value that is missing changes nothing.

  /** Survey values on an edge are ignored when `survey.confidence` is below this. */
  surveyMinConfidence: number;
  /**
   * Length multiplier for a `shared_road` edge whose survey says a pavement
   * exists. It replaces sharedRoadFactor, which stood for "nothing is known".
   */
  pavedRoadFactor: number;
  /** Length multiplier for a `shared_road` edge whose survey says there is no pavement. Replaces sharedRoadFactor. */
  noPavementRoadFactor: number;
  /** Length multipliers by surveyed pavement width: up to about 1 m, and over 2 m. 1 to 2 m is neutral. */
  narrowPavementFactor: number;
  widePavementFactor: number;
  /** Length multipliers by surveyed pavement condition. "medium" is neutral. */
  poorPavementFactor: number;
  goodPavementFactor: number;
  /** Length multiplier for each kind of fixed obstacle surveyed on the pavement. At least 1. */
  fixedObstacleFactor: number;
  /** Ceiling of the combined multiplier for fixed obstacles. */
  fixedObstaclesMaxFactor: number;
  /** Length multiplier for tactile guidance along the whole length. Below 1 is a bonus. */
  tactileGuidanceFactor: number;
  /** Added to the crossing penalty by surveyed zebra markings. Negative is a bonus. */
  crossingMarkingsClearM: number;
  crossingMarkingsWornM: number;
  crossingMarkingsNoneM: number;
  /** Added to the crossing penalty by surveyed kerb ramps. Negative is a bonus. */
  crossingRampsBothM: number;
  crossingRampsOneEndM: number;
  crossingRampsNoneM: number;
}

export const DEFAULT_COST_OPTIONS: Readonly<CostOptions> = Object.freeze({
  stepsPenaltyM: 80,
  sharedRoadFactor: 2,
  tactilePavingFactor: 0.9,
  crossingSignalsWithSoundM: 10,
  crossingSignalsNoSoundM: 60,
  crossingUnsignalledM: 300,
  crossingSignalsUnknownM: 120,
  partialObstacleFactor: 3,
  closingConfidence: 0.5,
  surveyMinConfidence: 0.5,
  pavedRoadFactor: 1.2,
  noPavementRoadFactor: 2.5,
  narrowPavementFactor: 1.3,
  widePavementFactor: 0.95,
  poorPavementFactor: 1.25,
  goodPavementFactor: 0.95,
  fixedObstacleFactor: 1.06,
  fixedObstaclesMaxFactor: 1.25,
  tactileGuidanceFactor: 0.8,
  crossingMarkingsClearM: -20,
  crossingMarkingsWornM: -5,
  crossingMarkingsNoneM: 40,
  crossingRampsBothM: -10,
  crossingRampsOneEndM: 10,
  crossingRampsNoneM: 30,
});

export const UNKNOWN_CROSSING: Readonly<CrossingInfo> = Object.freeze({
  signals: "unknown",
  sound: "unknown",
  marked: "unknown",
});

export function resolveCostOptions(options?: Partial<CostOptions>): CostOptions {
  return { ...DEFAULT_COST_OPTIONS, ...options };
}

/** Convert a TimeInput to epoch milliseconds. Throws on an unparseable value. */
export function toEpochMs(time: TimeInput): number {
  const ms = typeof time === "number" ? time : time instanceof Date ? time.getTime() : Date.parse(time);
  if (Number.isNaN(ms)) throw new TypeError(`Invalid time: ${String(time)}`);
  return ms;
}

/**
 * An obstacle is active when expiresAt is null or later than atTime.
 * An expiresAt that cannot be parsed is treated as "until removed".
 */
export function isObstacleActive(obstacle: Obstacle, atTime: TimeInput): boolean {
  if (obstacle.expiresAt === null) return true;
  const expires = Date.parse(obstacle.expiresAt);
  if (Number.isNaN(expires)) return true;
  return expires > toEpochMs(atTime);
}

/** What the active obstacles do to an edge. */
export type ObstacleEffect = "none" | "partial" | "closed";

/** Effect of a set of obstacles (already filtered to one edge) at a given time. */
export function obstacleEffect(
  obstacles: readonly Obstacle[],
  atTime: TimeInput,
  closingConfidence: number = DEFAULT_COST_OPTIONS.closingConfidence,
): ObstacleEffect {
  let effect: ObstacleEffect = "none";
  for (const o of obstacles) {
    if (!isObstacleActive(o, atTime)) continue;
    if (o.blocks === "full" && o.confidence >= closingConfidence) return "closed";
    effect = "partial";
  }
  return effect;
}

/** Penalty in metres for a crossing. "unknown" is never read as "no". */
export function crossingPenaltyM(crossing: CrossingInfo, options: CostOptions): number {
  if (crossing.signals === "yes") {
    return crossing.sound === "yes"
      ? options.crossingSignalsWithSoundM
      : options.crossingSignalsNoSoundM;
  }
  return crossing.signals === "no" ? options.crossingUnsignalledM : options.crossingSignalsUnknownM;
}

/** True when the edge carries survey values the cost model may use. */
export function surveyUsable(edge: GraphEdge, options: CostOptions): boolean {
  return edge.survey !== undefined && edge.survey.confidence >= options.surveyMinConfidence;
}

/**
 * Length multiplier for the kind of edge and what the survey says about its
 * pavement. Without survey values this is sharedRoadFactor for `shared_road`
 * and 1 otherwise, exactly as before the survey existed.
 *
 * - `shared_road`: a surveyed pavement replaces sharedRoadFactor with
 *   pavedRoadFactor (then width, condition and obstacles apply); a surveyed
 *   absence replaces it with noPavementRoadFactor.
 * - `sidewalk`, `footway`: width, condition and obstacles apply.
 * - any other kind: 1. On a pedestrian street the whole street is walked, so
 *   the pavement at its side does not price it.
 */
export function pavementFactor(kind: EdgeKind, survey: PavementSurvey, options: CostOptions): number {
  const road = kind === "shared_road";
  if (road) {
    if (survey.pavement === "no") return options.noPavementRoadFactor;
    if (survey.pavement !== "yes") return options.sharedRoadFactor;
  } else if (kind !== "sidewalk" && kind !== "footway") {
    return 1;
  }
  let factor = road ? options.pavedRoadFactor : 1;
  if (survey.pavementWidth === "narrow") factor *= options.narrowPavementFactor;
  else if (survey.pavementWidth === "wide") factor *= options.widePavementFactor;
  if (survey.pavementCondition === "poor") factor *= options.poorPavementFactor;
  else if (survey.pavementCondition === "good") factor *= options.goodPavementFactor;
  const kinds = survey.fixedObstacles?.length ?? 0;
  if (kinds > 0) {
    const each = Math.max(1, options.fixedObstacleFactor);
    factor *= Math.max(1, Math.min(options.fixedObstaclesMaxFactor, each ** kinds));
  }
  return factor;
}

/**
 * Length multiplier for tactile help: the smaller of tactilePavingFactor (OSM
 * says "yes") and tactileGuidanceFactor (the survey says "whole"). The two
 * sources describe the same thing, so they are not multiplied together.
 */
export function tactileFactor(
  tactilePaving: GraphEdge["tactilePaving"],
  survey: PavementSurvey,
  options: CostOptions,
): number {
  let factor = 1;
  if (tactilePaving === "yes") factor = Math.min(factor, options.tactilePavingFactor);
  if (survey.tactileGuidance === "whole") factor = Math.min(factor, options.tactileGuidanceFactor);
  return factor;
}

/** Metres added to the crossing penalty by the surveyed markings and ramps. Unknown adds nothing. */
export function surveyedCrossingAdjustmentM(
  edge: Pick<GraphEdge, "crossingMarkings" | "crossingRamps">,
  options: CostOptions,
): number {
  let m = 0;
  if (edge.crossingMarkings === "clear") m += options.crossingMarkingsClearM;
  else if (edge.crossingMarkings === "worn") m += options.crossingMarkingsWornM;
  else if (edge.crossingMarkings === "none") m += options.crossingMarkingsNoneM;
  if (edge.crossingRamps === "both_ends") m += options.crossingRampsBothM;
  else if (edge.crossingRamps === "one_end") m += options.crossingRampsOneEndM;
  else if (edge.crossingRamps === "none") m += options.crossingRampsNoneM;
  return m;
}

/**
 * Smallest cost per metre any edge can have under these options: the lower
 * bound that keeps the A* heuristic admissible.
 */
export function minCostPerMetre(options: CostOptions): number {
  const unit = (...factors: number[]) => Math.max(0, Math.min(1, ...factors));
  return (
    unit(options.sharedRoadFactor, options.pavedRoadFactor, options.noPavementRoadFactor) *
    unit(options.narrowPavementFactor, options.widePavementFactor) *
    unit(options.poorPavementFactor, options.goodPavementFactor) *
    unit(options.tactilePavingFactor, options.tactileGuidanceFactor) *
    unit(options.partialObstacleFactor)
  );
}

const NO_SURVEY: PavementSurvey = Object.freeze({});

/**
 * Cost of walking an edge, in metre-equivalents. Infinity means closed.
 *
 *   cost = (length x pavementFactor x tactileFactor + stepsPenalty + crossingPenalty) x obstacleFactor
 *
 * - length: edge.lengthM.
 * - pavementFactor: see pavementFactor. Without survey values it is
 *   sharedRoadFactor for `shared_road`, otherwise 1.
 * - tactileFactor: see tactileFactor. tactilePavingFactor when tactilePaving is "yes".
 * - stepsPenalty: stepsPenaltyM for `steps`.
 * - crossingPenalty: for edges of kind `crossing` or carrying crossing info.
 *   Signals with sound are cheapest, signals without confirmed sound cost more,
 *   unknown signals more again, and confirmed no signals costs most. A crossing edge without crossing info counts as all "unknown".
 *   Surveyed markings and ramps then add or take off metres; never below 0.
 * - survey values count only when edge.survey.confidence >= surveyMinConfidence,
 *   and a value that is missing never changes the cost.
 * - obstacles: only those whose edgeId matches and that are active at atTime count.
 *   An active `full` obstacle with confidence >= closingConfidence closes the edge.
 *   Any other active obstacle multiplies the cost by partialObstacleFactor (once,
 *   however many there are).
 */
export function isBusy(edge: GraphEdge, time: TimeInput, eventEdges?: ReadonlySet<string>) {
  const crowd = edge.crowd;
  const at = toEpochMs(time);
  return eventEdges?.has(edge.id) === true || !!(crowd && crowd.level === "busy" && Date.parse(crowd.observedAt)<=at && at<Date.parse(crowd.expiresAt));
}

export function edgeCost(
  edge: GraphEdge,
  obstacles: readonly Obstacle[],
  atTime: TimeInput,
  options?: Partial<CostOptions>,
): number {
  const o = resolveCostOptions(options);
  const mine = obstacles.filter((ob) => ob.edgeId === edge.id);
  const effect = mine.length === 0 ? "none" : obstacleEffect(mine, atTime, o.closingConfidence);
  if (effect === "closed") return Infinity;

  const surveyed = surveyUsable(edge, o);
  const survey = surveyed ? edge : NO_SURVEY;
  let cost = edge.lengthM * pavementFactor(edge.kind, survey, o) * tactileFactor(edge.tactilePaving, survey, o);
  if (edge.kind === "steps") cost += o.stepsPenaltyM;
  if (edge.kind === "crossing" || edge.crossing) {
    const adjustment = surveyed ? surveyedCrossingAdjustmentM(edge, o) : 0;
    cost += Math.max(0, crossingPenaltyM(edge.crossing ?? UNKNOWN_CROSSING, o) + adjustment);
  }
  if (o.busyFactor && isBusy(edge,atTime,o.eventEdges)) cost *= o.busyFactor;
  if (effect === "partial") cost *= o.partialObstacleFactor;
  return cost;
}
