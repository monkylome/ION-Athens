/**
 * Cost model. One function, edgeCost, turns an edge and the obstacles on it
 * into a cost in metre-equivalents. Time is always passed in.
 */
import type { CrossingInfo, GraphEdge, Obstacle } from "./types.ts";

/** A moment in time: ISO string, epoch milliseconds, or a Date. */
export type TimeInput = string | number | Date;

export interface CostOptions {
  /** Fixed penalty added to every `steps` edge. */
  stepsPenaltyM: number;
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

/**
 * Cost of walking an edge, in metre-equivalents. Infinity means closed.
 *
 *   cost = (length x kindFactor x tactileFactor + stepsPenalty + crossingPenalty) x obstacleFactor
 *
 * - length: edge.lengthM.
 * - kindFactor: sharedRoadFactor for `shared_road`, otherwise 1.
 * - tactileFactor: tactilePavingFactor when tactilePaving is "yes", otherwise 1.
 * - stepsPenalty: stepsPenaltyM for `steps`.
 * - crossingPenalty: for edges of kind `crossing` or carrying crossing info.
 *   Signals with sound are cheapest, signals without confirmed sound cost more,
 *   unknown signals more again, and confirmed no signals costs most. A crossing edge without crossing info counts as all "unknown".
 * - obstacles: only those whose edgeId matches and that are active at atTime count.
 *   An active `full` obstacle with confidence >= closingConfidence closes the edge.
 *   Any other active obstacle multiplies the cost by partialObstacleFactor (once,
 *   however many there are).
 */
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

  let cost = edge.lengthM;
  if (edge.kind === "shared_road") cost *= o.sharedRoadFactor;
  if (edge.tactilePaving === "yes") cost *= o.tactilePavingFactor;
  if (edge.kind === "steps") cost += o.stepsPenaltyM;
  if (edge.kind === "crossing" || edge.crossing) {
    cost += crossingPenaltyM(edge.crossing ?? UNKNOWN_CROSSING, o);
  }
  if (effect === "partial") cost *= o.partialObstacleFactor;
  return cost;
}
