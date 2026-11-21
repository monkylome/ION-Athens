/**
 * Survey codes to plain values.
 *
 * Only codes whose meaning the reverse-engineering notes establish are read
 * (data-local/walkable-athens/FINDINGS.md, section 1.3). Value 0 or null is
 * "no data" everywhere and becomes a missing field, never "none".
 */
import type {
  CrossingMarkings,
  CrossingRamps,
  FixedObstacleKind,
  PavementCondition,
  PavementSurvey,
  PavementWidth,
  SurveyedRamp,
  TactileGuidance,
} from "@ion/core";

export type Props = Record<string, unknown>;

/** Codes present in the files and deliberately not read, with the reason. */
export const OMITTED_CODES: Record<string, string> = {
  A_21015: "obstacle flag with no label anywhere in the app",
  "Εμπόδ": "aggregate obstacle flag: definition not found, and 7% of the values are dirty",
  A_219: "defined twice in the app (parked motorbikes, commercial dominance)",
  No_Data: "meaning not found",
  G_26: "labelled one-way, classes not found",
  A_2104: "shop stalls: movable, a 2022 observation says nothing about today",
  A_2108: "cafe tables and screens: movable",
  A_2111: "private objects: movable",
  "A_273=4": "pavement works in progress in 2022: long finished, so the condition is left unknown",
  "B_23=2": "ramp works in progress in 2022: left unknown",
  "Category=4": "footbridges are not street crossings",
};

/** Fixed obstacle flags: value 2 means "at least one on this side", 1 means none. */
const OBSTACLE_CODES: [code: string, kind: FixedObstacleKind][] = [
  ["A_2101", "kiosk"],
  ["A_2105", "tree_row"],
  ["A_2106", "street_furniture"],
  ["A_2107", "surface_defect"],
  ["A_2109", "pole_or_bollard"],
  ["A_2110", "utility_cabinet"],
  ["A_2112", "transit_stop"],
  ["A_2113", "building_protrusion"],
  ["A_21014", "level_change"],
];

const WIDTH: Record<number, PavementWidth> = { 1: "narrow", 2: "medium", 3: "wide" };
const CONDITION: Record<number, PavementCondition> = { 1: "poor", 2: "medium", 3: "good" };
const TACTILE: Record<number, TactileGuidance> = { 1: "none", 2: "whole", 3: "part" };

function code(props: Props, key: string): number {
  const v = props[key];
  return typeof v === "number" ? v : 0;
}

/**
 * One block side. A_271 says whether a pavement exists (1 no, 2 fixed width,
 * 3 varying width); A_272 and A_273 repeat "no pavement" as 4 and 5. When the
 * three disagree the side is left without pavement, width and condition.
 */
export function normaliseSide(props: Props): PavementSurvey {
  const out: PavementSurvey = {};
  const exists = code(props, "A_271");
  const width = code(props, "A_272");
  const condition = code(props, "A_273");
  if (exists === 1 && (width === 4 || width === 0) && (condition === 5 || condition === 0)) {
    out.pavement = "no";
  } else if ((exists === 2 || exists === 3) && width !== 4 && condition !== 5) {
    out.pavement = "yes";
    out.pavementWidthVaries = exists === 3;
    const w = WIDTH[width];
    if (w) out.pavementWidth = w;
    const c = CONDITION[condition];
    if (c) out.pavementCondition = c;
  }
  const t = TACTILE[code(props, "A_29")];
  if (t) out.tactileGuidance = t;
  if (out.pavement === "yes") {
    // The flags are about points "on the pavement"; all are 0 together when the side has no data.
    const flags = OBSTACLE_CODES.map(([key, kind]) => [code(props, key), kind] as const);
    if (flags.every(([v]) => v === 1 || v === 2)) {
      out.fixedObstacles = flags.filter(([v]) => v === 2).map(([, kind]) => kind);
    }
  }
  return out;
}

const WIDTH_RANK: PavementWidth[] = ["narrow", "medium", "wide"];
const CONDITION_RANK: PavementCondition[] = ["poor", "medium", "good"];

/**
 * Several block sides along one edge, read cautiously: the narrowest width,
 * the worst condition, every obstacle kind, tactile guidance "whole" only when
 * all have it. A value one of them lacks is left out.
 */
export function mergeSides(sides: PavementSurvey[]): PavementSurvey {
  const first = sides[0];
  if (!first) return {};
  if (sides.length === 1) return first;
  const out: PavementSurvey = {};
  const all = <T>(pick: (s: PavementSurvey) => T | undefined): T[] | null => {
    const values = sides.map(pick);
    return values.every((v) => v !== undefined) ? (values as T[]) : null;
  };
  const exists = all((s) => s.pavement);
  if (exists && exists.every((v) => v === exists[0])) out.pavement = exists[0]!;
  if (out.pavement === "yes") {
    out.pavementWidthVaries =
      sides.some((s) => s.pavementWidthVaries) || new Set(sides.map((s) => s.pavementWidth)).size > 1;
    const widths = all((s) => s.pavementWidth);
    if (widths) out.pavementWidth = WIDTH_RANK[Math.min(...widths.map((w) => WIDTH_RANK.indexOf(w)))]!;
    const conditions = all((s) => s.pavementCondition);
    if (conditions) {
      out.pavementCondition = CONDITION_RANK[Math.min(...conditions.map((c) => CONDITION_RANK.indexOf(c)))]!;
    }
    const obstacles = all((s) => s.fixedObstacles);
    if (obstacles) out.fixedObstacles = [...new Set(obstacles.flat())];
  }
  const tactile = all((s) => s.tactileGuidance);
  if (tactile) {
    out.tactileGuidance = tactile.every((t) => t === "whole")
      ? "whole"
      : tactile.every((t) => t === "none")
        ? "none"
        : "part";
  }
  return out;
}

const MARKINGS: Record<number, CrossingMarkings> = { 1: "none", 2: "clear", 3: "worn" };
const RAMPS: Record<number, CrossingRamps> = { 1: "none", 2: "one_end", 3: "both_ends" };

/** A crossing line. Footbridges (Category 4) are not street crossings and give null. */
export function normaliseCrossing(props: Props): { markings?: CrossingMarkings; ramps?: CrossingRamps } | null {
  if (code(props, "Category") === 4) return null;
  const out: { markings?: CrossingMarkings; ramps?: CrossingRamps } = {};
  const m = MARKINGS[code(props, "B_21")];
  if (m) out.markings = m;
  const r = RAMPS[code(props, "B_22")];
  if (r) out.ramps = r;
  return out.markings || out.ramps ? out : null;
}

export function normaliseRamp(props: Props): Omit<SurveyedRamp, "survey"> | null {
  const out: Omit<SurveyedRamp, "survey"> = {};
  const condition = code(props, "B_23");
  if (condition === 1) out.condition = "poor";
  else if (condition === 3) out.condition = "good";
  const space = code(props, "B_24");
  if (space === 1) out.manoeuvringSpace = "no";
  else if (space === 2) out.manoeuvringSpace = "yes";
  return out.condition || out.manoeuvringSpace ? out : null;
}
