/**
 * Citizen missions: one question about one place, answered on the spot.
 *
 * Missions come from what the map does not know (a crossing whose audible
 * signal or tactile paving is untagged) and from obstacle reports that still
 * need a second pair of eyes. An answer counts once two different people give
 * it. A confirmed answer changes the graph the router uses, so the next route
 * already benefits from it.
 *
 * No personal data: a participant is a random id made on the device, and the
 * position sent with an answer is used for the distance check and not kept.
 */
import type { GraphEdge, LngLat, Obstacle, PedestrianGraph, Tri } from "@ion/core";
import { distanceM } from "../geo.ts";

export type MissionType = "crossing_sound" | "crossing_tactile" | "obstacle_check";
export type Answer = "yes" | "no" | "unsure";

export interface Mission {
  id: string;
  type: MissionType;
  /** The question, in Greek, answerable with yes or no. */
  question: string;
  /** Where the person has to stand. */
  position: LngLat;
  /** Street or place, when the map has a name. */
  where?: string;
  edgeIds: string[];
  points: number;
  /** How many people gave each answer so far. */
  answers: { yes: number; no: number };
  /** For obstacle_check: the report this mission confirms. */
  reportRef?: string;
}

export interface Observation {
  missionId: string;
  type: MissionType;
  edgeIds: string[];
  where?: string;
  value: "yes" | "no";
  confirmedAt: string;
  confirmedBy: number;
}

export interface MissionOptions {
  /** Same answer from this many different people confirms it. */
  confirmations: number;
  /** A person must be this close to answer. */
  maxDistanceM: number;
  dailyLimit: number;
  bonusPoints: number;
  unsurePoints: number;
}

export const DEFAULT_MISSION_OPTIONS: MissionOptions = {
  confirmations: 2,
  maxDistanceM: 60,
  dailyLimit: 40,
  bonusPoints: 20,
  unsurePoints: 2,
};

const POINTS: Record<MissionType, number> = { crossing_sound: 15, crossing_tactile: 10, obstacle_check: 20 };

const QUESTIONS: Record<MissionType, string> = {
  crossing_sound: "Έχει ηχητικό σήμα το φανάρι σε αυτή τη διάβαση;",
  crossing_tactile: "Υπάρχει οδηγός όδευσης τυφλών σε αυτή τη διάβαση;",
  obstacle_check: "Υπάρχει ακόμα εμπόδιο στο πεζοδρόμιο εδώ;",
};

export const LEVELS = [
  { from: 0, name: "Νέος χαρτογράφος" },
  { from: 50, name: "Χαρτογράφος της γειτονιάς" },
  { from: 150, name: "Μάτια της πόλης" },
] as const;

export type AnswerResult =
  | { ok: true; mission: Mission; pointsEarned: number; confirmed: Observation | null; profile: Profile }
  | { ok: false; code: "not_found" | "already_answered" | "too_far" | "daily_limit" | "closed"; message: string; distanceM?: number };

export interface Profile {
  participant: string;
  points: number;
  answers: number;
  confirmed: number;
  level: string;
  nextLevel: { name: string; pointsNeeded: number } | null;
}

interface Tally {
  byParticipant: Map<string, Answer>;
}

function middle(points: LngLat[]): LngLat {
  return points[Math.floor(points.length / 2)] ?? points[0]!;
}

/** Crossing edges that belong to one OpenStreetMap way are one crossing for a person. */
function crossingGroups(graph: PedestrianGraph): Map<string, GraphEdge[]> {
  const groups = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (e.kind !== "crossing" || !e.crossing) continue;
    const key = e.osmWayId !== undefined ? `w${e.osmWayId}` : e.id;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  return groups;
}

export class MissionBoard {
  private readonly opts: MissionOptions;
  private readonly tallies = new Map<string, Tally>();
  private readonly closed = new Set<string>();
  private readonly observations: Observation[] = [];
  private readonly points = new Map<string, number>();
  private readonly answered = new Map<string, number>();
  private readonly confirmedCount = new Map<string, number>();
  private readonly daily = new Map<string, number>();
  private mapMissions: Mission[] = [];

  constructor(private readonly graph: PedestrianGraph, opts: Partial<MissionOptions> = {}) {
    this.opts = { ...DEFAULT_MISSION_OPTIONS, ...opts };
    this.rebuild();
  }

  /** Street names at each node, so an unnamed crossing can say which street it is on. */
  private namesAtNode(): Map<string, string> {
    const names = new Map<string, string>();
    for (const e of this.graph.edges) {
      if (!e.name || e.kind === "crossing") continue;
      for (const n of [e.from, e.to]) if (!names.has(n)) names.set(n, e.name);
    }
    return names;
  }

  /** Missions from gaps in the map. Called again after a confirmation changes the graph. */
  private rebuild(): void {
    const out: Mission[] = [];
    const nearby = this.namesAtNode();
    for (const [key, edges] of crossingGroups(this.graph)) {
      const first = edges[0]!;
      const position = middle(edges.flatMap((e) => e.geometry));
      const where = edges.find((e) => e.name)?.name ?? edges.flatMap((e) => [nearby.get(e.from), nearby.get(e.to)]).find(Boolean);
      const base = { position, edgeIds: edges.map((e) => e.id), ...(where ? { where } : {}) };
      const add = (type: MissionType) => {
        const id = `${type}:${key}`;
        if (this.closed.has(id)) return;
        out.push({ id, type, question: QUESTIONS[type], points: POINTS[type], answers: this.counts(id), ...base });
      };
      if (first.crossing!.signals === "yes" && first.crossing!.sound === "unknown") add("crossing_sound");
      if ((first.tactilePaving ?? "unknown") === "unknown") add("crossing_tactile");
    }
    this.mapMissions = out;
  }

  private counts(id: string): { yes: number; no: number } {
    const t = this.tallies.get(id);
    let yes = 0;
    let no = 0;
    for (const a of t?.byParticipant.values() ?? []) {
      if (a === "yes") yes++;
      else if (a === "no") no++;
    }
    return { yes, no };
  }

  /** Reports that one person made and nobody confirmed yet become missions too. */
  private obstacleMissions(obstacles: readonly Obstacle[]): Mission[] {
    const out: Mission[] = [];
    for (const o of obstacles) {
      if (o.source.kind !== "sandbox_request" || o.blocks !== "partial" || !o.source.ref || !o.position) continue;
      const id = `obstacle_check:${o.source.ref}`;
      if (this.closed.has(id)) continue;
      const where = this.graph.edges.find((e) => e.id === o.edgeId)?.name;
      out.push({
        id, type: "obstacle_check", question: QUESTIONS.obstacle_check, position: o.position, edgeIds: [o.edgeId],
        points: POINTS.obstacle_check, answers: this.counts(id), reportRef: o.source.ref, ...(where ? { where } : {}),
      });
    }
    return out;
  }

  all(obstacles: readonly Obstacle[] = []): Mission[] {
    return [...this.obstacleMissions(obstacles), ...this.mapMissions.map((m) => ({ ...m, answers: this.counts(m.id) }))];
  }

  /** Open missions nearest to a point, obstacle checks first when equally near. */
  near(point: LngLat, obstacles: readonly Obstacle[] = [], radiusM = 500, limit = 20): Array<Mission & { distanceM: number }> {
    return this.all(obstacles)
      .map((m) => ({ ...m, distanceM: Math.round(distanceM(point, m.position)) }))
      .filter((m) => m.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM || (a.type === "obstacle_check" ? -1 : 1))
      .slice(0, limit);
  }

  summary(obstacles: readonly Obstacle[] = []) {
    const all = this.all(obstacles);
    const byType: Record<string, number> = {};
    for (const m of all) byType[m.type] = (byType[m.type] ?? 0) + 1;
    return { open: all.length, byType, confirmed: this.observations.length };
  }

  confirmedObservations(): Observation[] {
    return [...this.observations];
  }

  profile(participant: string): Profile {
    const points = this.points.get(participant) ?? 0;
    let level: string = LEVELS[0].name;
    let next: Profile["nextLevel"] = null;
    for (const l of LEVELS) {
      if (points >= l.from) level = l.name;
      else if (!next) next = { name: l.name, pointsNeeded: l.from - points };
    }
    return {
      participant, points, answers: this.answered.get(participant) ?? 0,
      confirmed: this.confirmedCount.get(participant) ?? 0, level, nextLevel: next,
    };
  }

  /**
   * Record an answer. `at` is where the person stands; pass null only for the
   * demo control, which answers from the stage.
   */
  answer(missionId: string, participant: string, answer: Answer, at: LngLat | null, now: Date, obstacles: readonly Obstacle[] = []): AnswerResult {
    if (this.closed.has(missionId)) return { ok: false, code: "closed", message: "Αυτή η αποστολή έχει ήδη ολοκληρωθεί." };
    const mission = this.all(obstacles).find((m) => m.id === missionId);
    if (!mission) return { ok: false, code: "not_found", message: "Δεν υπάρχει τέτοια αποστολή." };

    if (at) {
      const d = Math.round(distanceM(at, mission.position));
      if (d > this.opts.maxDistanceM) {
        return { ok: false, code: "too_far", distanceM: d, message: `Πρέπει να βρίσκεστε στο σημείο. Απέχετε περίπου ${d} μέτρα.` };
      }
    }
    const tally = this.tallies.get(missionId) ?? { byParticipant: new Map<string, Answer>() };
    if (tally.byParticipant.has(participant)) return { ok: false, code: "already_answered", message: "Έχετε ήδη απαντήσει σε αυτή την αποστολή." };

    const dayKey = `${participant}:${now.toISOString().slice(0, 10)}`;
    const today = this.daily.get(dayKey) ?? 0;
    if (today >= this.opts.dailyLimit) return { ok: false, code: "daily_limit", message: "Φτάσατε το όριο αποστολών για σήμερα. Ευχαριστούμε." };

    tally.byParticipant.set(participant, answer);
    this.tallies.set(missionId, tally);
    this.daily.set(dayKey, today + 1);
    this.answered.set(participant, (this.answered.get(participant) ?? 0) + 1);

    let earned = answer === "unsure" ? this.opts.unsurePoints : mission.points;
    let confirmed: Observation | null = null;
    const counts = this.counts(missionId);
    const value: "yes" | "no" | null = counts.yes >= this.opts.confirmations ? "yes" : counts.no >= this.opts.confirmations ? "no" : null;
    if (value) {
      confirmed = {
        missionId, type: mission.type, edgeIds: mission.edgeIds, value, confirmedAt: now.toISOString(),
        confirmedBy: value === "yes" ? counts.yes : counts.no, ...(mission.where ? { where: mission.where } : {}),
      };
      this.observations.push(confirmed);
      this.closed.add(missionId);
      this.apply(confirmed);
      for (const [who, given] of tally.byParticipant) {
        if (given !== value) continue;
        this.confirmedCount.set(who, (this.confirmedCount.get(who) ?? 0) + 1);
        if (who === participant) earned += this.opts.bonusPoints;
        else this.points.set(who, (this.points.get(who) ?? 0) + this.opts.bonusPoints);
      }
      this.rebuild();
    }
    this.points.set(participant, (this.points.get(participant) ?? 0) + earned);
    return { ok: true, mission: { ...mission, answers: counts }, pointsEarned: earned, confirmed, profile: this.profile(participant) };
  }

  /** A confirmed answer becomes a fact on the graph the router reads. */
  private apply(o: Observation): void {
    if (o.type === "obstacle_check") return;
    const ids = new Set(o.edgeIds);
    const value: Tri = o.value;
    for (const e of this.graph.edges) {
      if (!ids.has(e.id)) continue;
      if (o.type === "crossing_sound" && e.crossing) e.crossing = { ...e.crossing, sound: value };
      if (o.type === "crossing_tactile") e.tactilePaving = value;
    }
  }
}
