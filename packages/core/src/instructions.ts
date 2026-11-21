/**
 * Instruction data: what should be announced now, as structured objects plus a
 * plain Greek sentence each. The wording is a placeholder for the voice layer.
 *
 * Two rules hold here:
 * - A crossing is described (signals, sound). The engine never tells the
 *   person to cross.
 * - An announcement is produced once. Every announcement has a `key`; the
 *   caller passes back the keys already announced.
 */
import type { RemovalResult, RerouteResult } from "./reroute.ts";
import type { CrossingInfo, NodeId, Obstacle, Route, RouteStep, TurnDirection } from "./types.ts";

export interface AnnouncementOptions {
  /** A step is announced as "ahead" once it is within this distance. Default 30. */
  aheadDistanceM?: number;
  /** A step is announced as "now" once it is within this distance. Default 5. */
  nowDistanceM?: number;
  /** A reroute decision to announce, from rerouteForObstacle. */
  reroute?: { obstacle: Obstacle; result: RerouteResult };
  /** The outcome of checkObstacleRemoved to announce. */
  removal?: { obstacleId: string; result: RemovalResult };
}

interface Base {
  /** Stable identity, used to avoid repeating the announcement. */
  key: string;
  /** Plain Greek sentence. */
  text: string;
}

export type Announcement =
  | (Base & { type: "depart"; direction?: TurnDirection; onto?: string; crossing?: CrossingInfo })
  | (Base & {
      type: "turn";
      phase: "ahead" | "now";
      atNode: NodeId;
      /** Rounded to 5 m. */
      distanceM: number;
      direction: TurnDirection;
      onto?: string;
    })
  | (Base & {
      type: "crossing";
      phase: "ahead" | "now";
      atNode: NodeId;
      distanceM: number;
      crossing: CrossingInfo;
      /** Where the crossing lies relative to the walking direction. */
      direction?: TurnDirection;
    })
  | (Base & { type: "arrival"; phase: "ahead" | "now"; atNode: NodeId; distanceM: number })
  | (Base & {
      type: "obstacle";
      outcome: "keep_route" | "reroute" | "turn_back" | "no_alternative";
      obstacleId: string;
      label: string;
      distanceToObstacleM: number;
      decisionNode?: NodeId;
      distanceToDecisionM?: number;
      direction?: TurnDirection | null;
      extraDistanceM?: number;
      /** The turn is imminent: the sentence is short and leads with the action. */
      lateWarning?: boolean;
    })
  | (Base & {
      type: "obstacle_cleared";
      obstacleId: string;
      decisionNode: NodeId;
      distanceToDecisionM: number;
      direction: TurnDirection | null;
      savedDistanceM: number;
    });

export interface AnnouncementResult {
  announcements: Announcement[];
  /** All keys announced so far, including the new ones. Pass this back next time. */
  announced: string[];
}

/** Round a distance to the nearest 5 metres. */
export function roundTo5(distanceM: number): number {
  return Math.round(Math.max(0, distanceM) / 5) * 5;
}

const DIRECTION_EL: Record<TurnDirection, string> = {
  straight: "συνεχίστε ευθεία",
  slight_left: "στρίψτε ελαφρά αριστερά",
  left: "στρίψτε αριστερά",
  sharp_left: "στρίψτε κλειστά αριστερά",
  slight_right: "στρίψτε ελαφρά δεξιά",
  right: "στρίψτε δεξιά",
  sharp_right: "στρίψτε κλειστά δεξιά",
  u_turn: "κάντε αναστροφή",
};

function capitalise(s: string): string {
  return s.charAt(0).toLocaleUpperCase("el") + s.slice(1);
}

function inMetres(distanceM: number): string {
  return `σε ${distanceM} μέτρα`;
}

/** Greek for a turn, for example "στρίψτε αριστερά, προς Ερμού". */
export function describeTurn(direction: TurnDirection, onto?: string): string {
  return onto ? `${DIRECTION_EL[direction]}, προς ${onto}` : DIRECTION_EL[direction];
}

/**
 * Greek description of a crossing: facts only, never an instruction to cross.
 * "unknown" is reported as not confirmed, never as absent.
 */
export function describeCrossing(crossing: CrossingInfo, direction?: TurnDirection): string {
  let text: string;
  if (crossing.signals === "yes") {
    text =
      crossing.sound === "yes"
        ? "Διάβαση με φανάρι και ηχητικό σήμα"
        : crossing.sound === "no"
          ? "Διάβαση με φανάρι, χωρίς ηχητικό σήμα"
          : "Διάβαση με φανάρι, χωρίς επιβεβαιωμένο ηχητικό σήμα";
  } else if (crossing.signals === "no") {
    text = "Διάβαση χωρίς φανάρι";
  } else {
    text = "Διάβαση, δεν είναι επιβεβαιωμένο αν έχει φανάρι";
  }
  if (direction?.endsWith("left")) text += ", στα αριστερά σας";
  else if (direction?.endsWith("right")) text += ", στα δεξιά σας";
  return text;
}

function stepKey(step: RouteStep, phase: string): string {
  return `${step.kind}@${step.atNode}@${Math.round(step.atDistanceM)}@${step.direction ?? ""}:${phase}`;
}

function stepAnnouncement(step: RouteStep, phase: "ahead" | "now", distanceM: number): Announcement {
  const key = stepKey(step, phase);
  const lead = phase === "ahead" ? `${capitalise(inMetres(distanceM))}, ` : "";
  const say = (body: string) => (lead ? `${lead}${body}.` : `${capitalise(body)}.`);
  if (step.kind === "crossing") {
    const crossing = step.crossing ?? { signals: "unknown", sound: "unknown", marked: "unknown" };
    const body = describeCrossing(crossing, step.direction);
    return {
      type: "crossing",
      key,
      phase,
      atNode: step.atNode,
      distanceM,
      crossing,
      ...(step.direction ? { direction: step.direction } : {}),
      text: lead ? `${lead}${body.charAt(0).toLocaleLowerCase("el")}${body.slice(1)}.` : `${body}.`,
    };
  }
  if (step.kind === "arrive") {
    return {
      type: "arrival",
      key,
      phase,
      atNode: step.atNode,
      distanceM,
      text:
        phase === "ahead"
          ? `${capitalise(inMetres(distanceM))} φτάνετε στον προορισμό σας.`
          : "Φτάσατε στον προορισμό σας.",
    };
  }
  const direction = step.direction ?? "straight";
  return {
    type: "turn",
    key,
    phase,
    atNode: step.atNode,
    distanceM,
    direction,
    ...(step.onto ? { onto: step.onto } : {}),
    text: say(describeTurn(direction, step.onto)),
  };
}

function departAnnouncement(step: RouteStep): Announcement {
  let text = step.direction ? `${capitalise(describeTurn(step.direction, step.onto))}.` : "Ξεκινάτε.";
  if (!step.direction && step.onto) text = `Ξεκινάτε, προς ${step.onto}.`;
  if (step.crossing) text += ` ${describeCrossing(step.crossing)}.`;
  return {
    type: "depart",
    key: stepKey(step, "now"),
    ...(step.direction ? { direction: step.direction } : {}),
    ...(step.onto ? { onto: step.onto } : {}),
    ...(step.crossing ? { crossing: step.crossing } : {}),
    text,
  };
}

/** Announcement for a reroute decision, or null when the obstacle is not relevant. */
export function describeReroute(obstacle: Obstacle, result: RerouteResult): Announcement | null {
  if (result.outcome === "not_relevant") return null;
  const toObstacle = roundTo5(result.distanceToObstacleM);
  const where = toObstacle > 0 ? ` ${inMetres(toObstacle)}` : "";
  const base = {
    type: "obstacle" as const,
    key: `obstacle@${obstacle.id}:${result.outcome}`,
    obstacleId: obstacle.id,
    label: obstacle.label,
    distanceToObstacleM: toObstacle,
  };
  if (result.outcome === "keep_route") {
    return {
      ...base,
      outcome: "keep_route",
      text: `Προσοχή, εμπόδιο στη διαδρομή${where}: ${obstacle.label}. Η διαδρομή δεν αλλάζει.`,
    };
  }
  if (result.outcome === "no_alternative") {
    return {
      ...base,
      outcome: "no_alternative",
      text: `Εμπόδιο μπροστά${where}: ${obstacle.label}. Η διαδρομή είναι κλειστή και δεν βρέθηκε άλλη διαδρομή προς τον προορισμό.`,
    };
  }
  const toDecision = roundTo5(result.distanceToDecisionM);
  const extra = roundTo5(Math.abs(result.extraDistanceM));
  const turn = result.turnDirection ? describeTurn(result.turnDirection) : null;
  const longer =
    extra === 0
      ? ""
      : result.extraDistanceM > 0
        ? ` Η νέα διαδρομή είναι ${extra} μέτρα μακρύτερη.`
        : ` Η νέα διαδρομή είναι ${extra} μέτρα συντομότερη.`;
  const structured = {
    decisionNode: result.decisionNode,
    distanceToDecisionM: toDecision,
    direction: result.turnDirection,
    extraDistanceM: roundTo5(result.extraDistanceM),
  };
  if (result.outcome === "turn_back") {
    const then = turn ? (toDecision > 0 ? ` ${capitalise(inMetres(toDecision))}, ${turn}.` : ` ${capitalise(turn)}.`) : "";
    const back = toDecision > 0 ? " Κάντε αναστροφή." : "";
    return {
      ...base,
      ...structured,
      outcome: "turn_back",
      text: `Εμπόδιο μπροστά${where}: ${obstacle.label}. Η διαδρομή είναι κλειστή.${back}${then}${longer}`,
    };
  }
  if (result.lateWarning && turn) {
    // Little time left: the action first, then one short reason.
    const action =
      toDecision > 5 ? `${capitalise(inMetres(toDecision))}, ${turn}.` : `${capitalise(turn)} τώρα στη γωνία.`;
    const closes = obstacle.blocks === "full" && obstacle.confidence >= 0.5;
    return {
      ...base,
      ...structured,
      outcome: "reroute",
      lateWarning: true,
      text: `${action} ${closes ? "Ο δρόμος μπροστά είναι κλειστός." : "Εμπόδιο μπροστά."}`,
    };
  }
  const change = turn
    ? toDecision > 0
      ? ` Αλλαγή διαδρομής: ${inMetres(toDecision)}, ${turn}.`
      : ` Αλλαγή διαδρομής: ${turn} τώρα.`
    : " Αλλαγή διαδρομής.";
  return {
    ...base,
    ...structured,
    outcome: "reroute",
    text: `Εμπόδιο μπροστά${where}: ${obstacle.label}.${change}${longer}`,
  };
}

/** Announcement for a removed obstacle, or null when the route stays as it is. */
export function describeObstacleRemoved(
  obstacleId: string,
  result: RemovalResult,
): Announcement | null {
  if (result.outcome !== "shorter_available") return null;
  const toDecision = roundTo5(result.distanceToDecisionM);
  const saved = roundTo5(result.savedDistanceM);
  const turn = result.turnDirection ? describeTurn(result.turnDirection) : null;
  const change = turn
    ? toDecision > 0
      ? ` ${capitalise(inMetres(toDecision))}, ${turn}.`
      : ` ${capitalise(turn)} τώρα.`
    : "";
  const gain = saved > 0 ? ` Η νέα διαδρομή είναι ${saved} μέτρα συντομότερη.` : "";
  return {
    type: "obstacle_cleared",
    key: `obstacle@${obstacleId}:cleared`,
    obstacleId,
    decisionNode: result.decisionNode,
    distanceToDecisionM: toDecision,
    direction: result.turnDirection,
    savedDistanceM: saved,
    text: `Το εμπόδιο απομακρύνθηκε. Υπάρχει καλύτερη διαδρομή.${change}${gain}`,
  };
}

/**
 * What should be announced now for a walker `distanceM` metres into the route.
 *
 * Each step is announced at most twice, as two different announcements: once
 * "ahead" (within aheadDistanceM, with the distance rounded to 5 m) and once
 * "now" (within nowDistanceM). Nothing whose key is in `announced` is produced
 * again, and a step the walker has passed is never announced late.
 */
export function nextAnnouncements(
  route: Route,
  walker: { distanceM: number },
  announced: readonly string[] = [],
  options: AnnouncementOptions = {},
): AnnouncementResult {
  const ahead = options.aheadDistanceM ?? 30;
  const now = options.nowDistanceM ?? 5;
  const seen = new Set(announced);
  const out: Announcement[] = [];
  const emit = (a: Announcement | null) => {
    if (!a || seen.has(a.key)) return;
    seen.add(a.key);
    out.push(a);
  };

  if (options.reroute) emit(describeReroute(options.reroute.obstacle, options.reroute.result));
  if (options.removal) emit(describeObstacleRemoved(options.removal.obstacleId, options.removal.result));

  const d = walker.distanceM;
  for (const step of route.steps) {
    const rel = step.atDistanceM - d;
    if (step.kind === "depart") {
      if (rel >= -now) emit(departAnnouncement(step));
      continue;
    }
    if (rel < -now && step.kind !== "arrive") continue; // passed
    const nowAt = step.kind === "arrive" ? Math.min(now, 1) : now;
    if (rel <= nowAt) {
      seen.add(stepKey(step, "ahead")); // never fall back to "ahead" after "now"
      emit(stepAnnouncement(step, "now", 0));
    } else if (rel <= ahead) {
      emit(stepAnnouncement(step, "ahead", roundTo5(rel)));
    }
  }
  return { announcements: out, announced: [...seen] };
}
