import type { ScenarioConfig } from "./types";

export const DEFAULT_CONFIG: ScenarioConfig = {
  from: "metro_station-monastiraki-n9666216537",
  sentence: "Θέλω να πάω στο Δημαρχείο",
  speedMps: 1.0,
  timeScale: "auto",
  durationS: 90,
  witnessesNeeded: 2,
  minDecisionAheadM: 40,
  confirmLeadS: 6,
  minExtraM: 15,
  maxExtraM: 250,
  targetExtraM: 60,
  category: "sidewalk",
  obstacleText: "σκαλωσιά",
};

function positive(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/**
 * Every part of the scenario can be set in the address:
 * ?from=&to=&speed=&scale=&duration=&witnesses=&ahead=&lead=&extra=&category=&text=
 */
export function configFromSearch(search: string, base: ScenarioConfig = DEFAULT_CONFIG): ScenarioConfig {
  const q = new URLSearchParams(search);
  const scale = q.get("scale");
  return {
    from: q.get("from")?.trim() || base.from,
    sentence: q.get("to")?.trim() || base.sentence,
    speedMps: positive(q.get("speed"), base.speedMps, 0.2, 3),
    timeScale: scale === null || scale === "auto" || scale === "" ? base.timeScale : positive(scale, 1, 0.25, 30),
    durationS: positive(q.get("duration"), base.durationS, 30, 900),
    witnessesNeeded: Math.round(positive(q.get("witnesses"), base.witnessesNeeded, 1, 9)),
    minDecisionAheadM: positive(q.get("ahead"), base.minDecisionAheadM, 5, 300),
    confirmLeadS: positive(q.get("lead"), base.confirmLeadS, 0, 60),
    minExtraM: base.minExtraM,
    maxExtraM: base.maxExtraM,
    targetExtraM: positive(q.get("extra"), base.targetExtraM, 5, 500),
    category: q.get("category")?.trim() || base.category,
    obstacleText: q.get("text")?.trim() || base.obstacleText,
  };
}

/** Simulated seconds per real second for a route of this length. */
export function resolveTimeScale(config: ScenarioConfig, routeLengthM: number): number {
  if (config.timeScale !== "auto") return config.timeScale;
  // The moment runs in real time and the destination step takes a few seconds: leave 25 s for them.
  const walkingS = Math.max(20, config.durationS - 25);
  const scale = routeLengthM / config.speedMps / walkingS;
  return Math.min(12, Math.max(1, Math.round(scale * 10) / 10));
}
