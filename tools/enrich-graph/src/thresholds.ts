import type { Thresholds } from "./match.ts";

/** Chosen from the measured distributions; see README.md, "Thresholds". */
export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  roadSideMaxDistanceM: 13,
  pavementSideMaxDistanceM: 8,
  footwaySideMaxDistanceM: 6,
  sideMaxAngleDeg: 20,
  sideEndSlackM: 1,
  sampleStepM: 4,
  minEdgeLengthM: 10,
  minCoverage: 0.6,
  minFeatureShare: 0.25,
  minConfidence: 0.5,
  crossingMaxDistanceM: 8,
  crossingMaxAngleDeg: 30,
  nodeCrossingMaxDistanceM: 6,
  ambiguityMarginM: 2,
  rampMaxDistanceM: 5,
});
