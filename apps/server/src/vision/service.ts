/**
 * The camera as a source of map facts. A model proposes, a citizen confirms.
 *
 * The frame is held in memory for the request only. Nothing is logged. It is
 * written to disk only when the citizen switched on «Δωρίστε αυτή τη φωτογραφία»
 * (`keep: true`), and then only under the kept folder, without any participant id.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LngLat } from "@ion/core";
import { distanceM } from "../geo.ts";
import type { Mission, Profile } from "../missions/missions.ts";
import { ModelError, type VisionModel } from "./model.ts";
import { cleanText, type Confidence, CONFIDENCES, EVIDENCE, hasGreek, KINDS, type Kind, LABELS, mentionsPeople, rawOutput } from "./vocab.ts";

export const IMAGE_NOTICE = "Η εικόνα αναλύεται και δεν αποθηκεύεται. Αποφασίζετε εσείς τι μπαίνει στον χάρτη.";
export const KEEP_NOTICE = "Η φωτογραφία αυτή θα κρατηθεί στον διακομιστή αυτής της επίδειξης για ανάλυση. Μπορεί να δείχνει περαστικούς.";
export const KEPT_LATER = "Η φωτογραφία κρατήθηκε και θα αναλυθεί αργότερα.";

export type Answer = "yes" | "no";
export interface Proposal {
  kind: Kind;
  label: string;
  confidence: Confidence;
  evidence: string;
  /** The text read from a sign. */
  text?: string;
  /** True when no open mission already covers it: nobody had mapped it. */
  discovery: boolean;
  mission?: { id: string; question: string; answer: Answer };
}

export interface CameraObservation {
  id: string;
  kind: Kind;
  label: string;
  text?: string;
  lng: number;
  lat: number;
  where: string;
  at: string;
  source: "camera";
  sourceLabel: string;
  proposedBy: "vision";
  /** Random device ids of the citizens who tapped «Σωστό». */
  confirmedBy: string[];
  status: "seen_by_one" | "confirmed";
  missionId?: string;
}

export interface VisionOptions {
  timeoutMs: number;
  maxImageBytes: number;
  /** Discoveries of the same kind within this distance count as the same thing. */
  sameThingM: number;
  missionReachM: number;
  discoveryPoints: number;
  secondDiscoveryPoints: number;
  firstFinderBonus: number;
  discoveriesPerDay: number;
  maxQueued: number;
  maxObservations: number;
  keptMaxFrames: number;
  keptMaxBytes: number;
}
export const DEFAULT_VISION_OPTIONS: VisionOptions = {
  timeoutMs: 12_000,
  maxImageBytes: 1_500_000,
  sameThingM: 25,
  missionReachM: 60,
  discoveryPoints: 30,
  secondDiscoveryPoints: 30,
  firstFinderBonus: 20,
  discoveriesPerDay: 40,
  maxQueued: 1,
  maxObservations: 500,
  keptMaxFrames: 500,
  keptMaxBytes: 200 * 1024 * 1024,
};

export interface VisionDeps {
  /** Absent when no model is configured: every endpoint then answers 503. */
  model: VisionModel | null;
  licence: string;
  now: () => Date;
  areaOf: (p: LngLat) => string;
  /** Open missions near a point, nearest first. */
  missionsNear: (p: LngLat) => Mission[];
  /** Submits a mission answer through the board, with every rule it has. */
  answerMission: (id: string, participant: string, answer: Answer, at: LngLat) => Promise<MissionAnswer>;
  award: (participant: string, points: number) => Profile;
  profile: (participant: string) => Profile;
  announce: (event: { type: string; [k: string]: unknown }) => void;
  keptDir: string;
  opts?: Partial<VisionOptions>;
}
export type MissionAnswer =
  | { ok: true; pointsEarned: number; profile: Profile; confirmed: unknown; mission?: Mission }
  | { ok: false; status: number; code: string; message: string };

export type Failure = { ok: false; status: number; code: string; message: string };
const fail = (status: number, code: string, message: string): Failure => ({ ok: false, status, code, message });

const round4 = (p: LngLat): LngLat => [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))];
const CONF_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/** The mission a proposal would answer, and the answer it would give. Used both when proposing and when confirming. */
export function missionFor(kind: Kind, missions: readonly Mission[]): { mission: Mission; answer: Answer } | null {
  const venue = (key: string) => missions.find((m) => m.type === "venue_check" && m.key === key);
  const type = (t: Mission["type"]) => missions.find((m) => m.type === t);
  const pick = (m: Mission | undefined, answer: Answer) => (m ? { mission: m, answer } : null);
  switch (kind) {
    case "tactile_paving": return pick(type("crossing_tactile"), "yes") ?? pick(venue("tactile_paving"), "yes");
    case "sidewalk_obstacle": return pick(type("obstacle_check"), "yes") ?? pick(type("pavement_check"), "no");
    case "clear_path": return pick(type("pavement_check"), "yes") ?? pick(type("obstacle_check"), "no");
    case "steps": case "entrance_with_steps": return pick(venue("step_count"), "no");
    case "entrance_step_free": return pick(venue("step_count"), "yes");
    case "lift": return pick(venue("elevator"), "yes");
    default: return null;
  }
}

export class VisionService {
  readonly opts: VisionOptions;
  private latencies: number[] = [];
  private inflight = 0;
  private observations: CameraObservation[] = [];
  private perDay = new Map<string, number>();
  private pingAt = 0;
  private pingOk = false;

  constructor(private readonly d: VisionDeps) {
    this.opts = { ...DEFAULT_VISION_OPTIONS, ...d.opts };
  }

  get configured(): boolean {
    return this.d.model !== null;
  }

  private day = () => this.d.now().toISOString().slice(0, 10);

  async status() {
    const model = this.d.model;
    let answering = false;
    if (model) {
      if (this.d.now().getTime() - this.pingAt > 10_000) {
        this.pingOk = await model.ping(AbortSignal.timeout(2000));
        this.pingAt = this.d.now().getTime();
      }
      answering = this.pingOk;
    }
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      configured: model !== null,
      answering,
      model: model?.name ?? null,
      licence: model ? this.d.licence : null,
      medianLatencyMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null,
      samples: sorted.length,
      kept: this.keptCount(),
      notice: IMAGE_NOTICE,
      keepNotice: KEEP_NOTICE,
    };
  }

  /** Decodes and checks the frame. Returns the base64 text for the model without keeping the bytes. */
  checkImage(image: string): { ok: true; b64: string; bytes: Buffer } | Failure {
    const b64 = image.replace(/^data:image\/jpe?g;base64,/i, "");
    if (b64.length > Math.ceil((this.opts.maxImageBytes * 4) / 3) + 8) return fail(413, "too_large", "Η φωτογραφία είναι πολύ μεγάλη. Δοκιμάστε ξανά.");
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length > this.opts.maxImageBytes) return fail(413, "too_large", "Η φωτογραφία είναι πολύ μεγάλη. Δοκιμάστε ξανά.");
    if (bytes.length < 200 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return fail(400, "invalid_image", "Η φωτογραφία δεν είναι έγκυρη εικόνα JPEG.");
    return { ok: true, b64, bytes };
  }

  /** Runs the model with the time limit and the queue limit, and returns the cleaned detections. */
  async detect(b64: string): Promise<{ ok: true; proposals: Omit<Proposal, "discovery" | "mission">[]; ms: number } | Failure> {
    const model = this.d.model;
    if (!model) return fail(503, "not_configured", "Η ανάλυση εικόνας δεν είναι ενεργή σε αυτόν τον διακομιστή.");
    if (this.inflight > this.opts.maxQueued) return fail(429, "busy", "Το μοντέλο αναλύει ήδη άλλη εικόνα. Δοκιμάστε σε λίγο.");
    this.inflight++;
    const started = Date.now();
    try {
      const raw = await model.detect(b64, AbortSignal.timeout(this.opts.timeoutMs));
      const ms = Date.now() - started;
      this.latencies.push(ms);
      if (this.latencies.length > 50) this.latencies.shift();
      return { ok: true, proposals: this.clean(raw), ms };
    } catch (err) {
      if (err instanceof ModelError && err.code === "invalid_output") return fail(502, "invalid_output", "Το μοντέλο δεν απάντησε σε μορφή που να μπορώ να χρησιμοποιήσω. Δοκιμάστε ξανά.");
      if (err instanceof ModelError && err.code === "timeout" || (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") return fail(504, "timeout", "Το μοντέλο άργησε να απαντήσει. Δοκιμάστε ξανά.");
      return fail(503, "model_unavailable", "Το μοντέλο ανάλυσης δεν απαντά αυτή τη στιγμή.");
    } finally {
      this.inflight--;
    }
  }

  /** Closed vocabulary, no people, one proposal per kind, no contradictions. */
  clean(raw: unknown): Omit<Proposal, "discovery" | "mission">[] {
    const parsed = rawOutput.safeParse(raw);
    if (!parsed.success) throw new ModelError("invalid_output", "schema");
    const best = new Map<Kind, Omit<Proposal, "discovery" | "mission">>();
    for (const d of parsed.data.detections) {
      if (!(KINDS as readonly string[]).includes(d.kind)) continue;
      const kind = d.kind as Kind;
      const evidence = cleanText(d.evidence, 100);
      const text = kind === "sign_text" ? cleanText(d.text, 60) : "";
      if (mentionsPeople(evidence) || mentionsPeople(text)) continue;
      if (kind === "sign_text" && text.length < 2) continue;
      const confidence = (CONFIDENCES as readonly string[]).includes(d.confidence ?? "") ? (d.confidence as Confidence) : "low";
      const label = kind === "sign_text" ? `${LABELS[kind]}: ${text}` : LABELS[kind];
      const item = { kind, label, confidence, evidence: hasGreek(evidence) ? evidence : EVIDENCE[kind], ...(text ? { text } : {}) };
      const had = best.get(kind);
      if (!had || CONF_RANK[confidence] < CONF_RANK[had.confidence]) best.set(kind, item);
    }
    // Words the model read on signs. Each is one sign_text proposal; the same words are not proposed twice.
    for (const word of parsed.data.signs ?? []) {
      const text = cleanText(word, 60);
      if (text.length < 2 || !/[\p{L}\p{N}]{2}/u.test(text) || mentionsPeople(text)) continue;
      if ([...best.values()].some((p) => p.kind === "sign_text" && p.text === text)) continue;
      if ([...best.values()].filter((p) => p.kind === "sign_text").length >= 3) break;
      best.set(`sign_text:${text}` as Kind, { kind: "sign_text", label: `${LABELS.sign_text}: ${text}`, confidence: "medium", evidence: EVIDENCE.sign_text, text });
    }
    const out = [...best.values()];
    const blocked = best.has("sidewalk_obstacle") || best.has("narrow_sidewalk") || best.has("steps");
    return out.filter((p) => !(p.kind === "clear_path" && blocked)).sort((a, b) => CONF_RANK[a.confidence] - CONF_RANK[b.confidence]);
  }

  /** Attaches the nearest open mission, or marks the proposal as a discovery. */
  attach(proposals: Omit<Proposal, "discovery" | "mission">[], at: LngLat): Proposal[] {
    const missions = this.d.missionsNear(at).filter((m) => distanceM(at, m.position) <= this.opts.missionReachM);
    return proposals.map((p) => {
      const m = missionFor(p.kind, missions);
      return m
        ? { ...p, discovery: false, mission: { id: m.mission.id, question: m.mission.question, answer: m.answer } }
        : { ...p, discovery: true };
    });
  }

  /**
   * Speech for a person who cannot see. Built from the detections only, in the polite plural,
   * with the uncertainty said aloud, and never an instruction to cross or to proceed.
   */
  speech(proposals: readonly Omit<Proposal, "discovery" | "mission">[]): string {
    const strong = proposals.filter((p) => p.confidence !== "low");
    const parts: string[] = [];
    const has = (k: Kind) => strong.some((p) => p.kind === k);
    const phrase: Partial<Record<Kind, string>> = {
      steps: "σκαλιά", ramp: "ράμπα", sidewalk_obstacle: "κάτι που ίσως κλείνει το πεζοδρόμιο", narrow_sidewalk: "στενό πεζοδρόμιο",
      tactile_paving: "οδηγό όδευσης στο πεζοδρόμιο", crossing_signals: "διάβαση με φανάρι", crossing_no_signals: "διάβαση χωρίς φανάρι",
      entrance_step_free: "είσοδο χωρίς σκαλιά", entrance_with_steps: "είσοδο με σκαλιά", lift: "ανελκυστήρα",
    };
    const seen = strong.filter((p) => phrase[p.kind]).map((p) => phrase[p.kind]!);
    if (seen.length) parts.push(`Η κάμερα φαίνεται να βλέπει ${list(seen)}.`);
    const sign = strong.find((p) => p.kind === "sign_text");
    if (sign?.text) parts.push(`Μια πινακίδα γράφει «${sign.text}», αν το διάβασα σωστά.`);
    if (has("clear_path") && !has("sidewalk_obstacle") && !has("narrow_sidewalk")) parts.push("Το πεζοδρόμιο μοιάζει ελεύθερο.");
    if (!parts.length) return "Δεν διακρίνω κάτι σίγουρο μπροστά σας. Η εικόνα μπορεί να μην είναι καθαρή. Μην βασιστείτε σε αυτήν.";
    // The uncertainty is always said, in the last of at most three sentences.
    parts.splice(2);
    parts.push("Δεν είμαι βέβαιος και δεν μπορώ να πω αν το σημείο είναι ασφαλές, γι' αυτό ζητήστε βοήθεια αν τη χρειάζεστε.");
    return parts.join(" ");
  }

  /** Stores a frame for later analysis. Only called when the citizen asked for it. */
  keep(bytes: Buffer, meta: { at: LngLat; heading?: number | undefined; proposals: unknown; model: string | null }): boolean {
    try {
      mkdirSync(this.d.keptDir, { recursive: true });
      const stamp = this.d.now().toISOString().replace(/[:.]/g, "-");
      const name = `${stamp}-${randomBytes(3).toString("hex")}`;
      const p = round4(meta.at);
      writeFileSync(join(this.d.keptDir, `${name}.jpg`), bytes);
      writeFileSync(join(this.d.keptDir, `${name}.json`), JSON.stringify({
        at: this.d.now().toISOString(), position: p, heading: meta.heading === undefined ? null : Math.round(meta.heading),
        proposals: meta.proposals, model: meta.model,
      }, null, 1));
      this.trimKept();
      return true;
    } catch {
      return false;
    }
  }

  private keptFiles() {
    try {
      return readdirSync(this.d.keptDir).filter((f) => f.endsWith(".jpg")).sort();
    } catch {
      return [];
    }
  }
  keptCount(): number {
    return this.keptFiles().length;
  }
  private trimKept() {
    const files = this.keptFiles();
    const size = (f: string) => { try { return statSync(join(this.d.keptDir, f)).size; } catch { return 0; } };
    let total = files.reduce((n, f) => n + size(f), 0);
    let count = files.length;
    for (const f of files) {
      if (count <= this.opts.keptMaxFrames && total <= this.opts.keptMaxBytes) break;
      total -= size(f);
      count--;
      for (const ext of [".jpg", ".json"]) { try { unlinkSync(join(this.d.keptDir, f.replace(/\.jpg$/, ext))); } catch { /* already gone */ } }
    }
  }

  // --- confirming ------------------------------------------------------------------------------

  async confirm(participant: string, input: { kind: Kind; text?: string | undefined; missionId?: string | undefined }, at: LngLat) {
    const kind = input.kind;
    const text = kind === "sign_text" ? cleanText(input.text, 60) : "";
    if (kind === "sign_text" && (text.length < 2 || mentionsPeople(text))) return fail(400, "invalid_request", "Λείπει το κείμενο της πινακίδας.");
    const label = kind === "sign_text" ? `${LABELS[kind]}: ${text}` : LABELS[kind];

    if (input.missionId) {
      const nearby = this.d.missionsNear(at);
      const found = missionFor(kind, nearby.filter((m) => m.id === input.missionId));
      if (!found) return fail(409, "mission_gone", "Η αποστολή έχει κλείσει ή δεν ταιριάζει με αυτό που είδατε.");
      const r = await this.d.answerMission(found.mission.id, participant, found.answer, at);
      if (!r.ok) return fail(r.status, r.code, r.message);
      this.record({ kind, label, text, at, participant, status: r.confirmed ? "confirmed" : "seen_by_one", missionId: found.mission.id });
      return { ok: true as const, kind, label, discovery: false, pointsEarned: r.pointsEarned, profile: r.profile, confirmed: r.confirmed, needsSecond: !r.confirmed };
    }

    // A discovery: nobody had mapped it. Seen by one until a second citizen, close by, sees it too.
    const key = `${participant}:${this.day()}`;
    const today = this.perDay.get(key) ?? 0;
    if (today >= this.opts.discoveriesPerDay) return fail(429, "daily_limit", "Φτάσατε το όριο ανακαλύψεων για σήμερα. Ευχαριστούμε.");
    const same = this.observations.find((o) => o.kind === kind && !o.missionId && (kind !== "sign_text" || o.text === text) && distanceM(at, [o.lng, o.lat]) <= this.opts.sameThingM);
    if (same && same.confirmedBy.includes(participant)) return fail(409, "already_answered", "Το έχετε ήδη καταγράψει εδώ.");
    this.perDay.set(key, today + 1);
    if (same) {
      same.confirmedBy.push(participant);
      same.status = "confirmed";
      const first = same.confirmedBy[0]!;
      this.d.award(first, this.opts.firstFinderBonus);
      const profile = this.d.award(participant, this.opts.secondDiscoveryPoints);
      this.d.announce({ type: "discovery_confirmed", discovery: this.view(same) });
      this.d.announce({ type: "map_updated", observation: this.mapObservation(same) });
      return { ok: true as const, kind, label, discovery: true, pointsEarned: this.opts.secondDiscoveryPoints, profile, confirmed: this.view(same), needsSecond: false };
    }
    const obs = this.record({ kind, label, text, at, participant, status: "seen_by_one" });
    const profile = this.d.award(participant, this.opts.discoveryPoints);
    this.d.announce({ type: "discovery_added", discovery: this.view(obs) });
    return { ok: true as const, kind, label, discovery: true, pointsEarned: this.opts.discoveryPoints, profile, confirmed: null, needsSecond: true };
  }

  private record(o: { kind: Kind; label: string; text: string; at: LngLat; participant: string; status: CameraObservation["status"]; missionId?: string }): CameraObservation {
    const p = round4(o.at);
    const obs: CameraObservation = {
      id: randomBytes(6).toString("hex"), kind: o.kind, label: o.label, ...(o.text ? { text: o.text } : {}), lng: p[0], lat: p[1],
      where: this.d.areaOf(p), at: this.d.now().toISOString(), source: "camera", sourceLabel: "Παρατήρηση με κάμερα, επιβεβαιωμένη από δημότη",
      proposedBy: "vision", confirmedBy: [o.participant], status: o.status, ...(o.missionId ? { missionId: o.missionId } : {}),
    };
    this.observations.push(obs);
    if (this.observations.length > this.opts.maxObservations) this.observations.shift();
    return obs;
  }

  /** The public shape: no participant ids. */
  view(o: CameraObservation) {
    return { id: o.id, kind: o.kind, label: o.label, ...(o.text ? { text: o.text } : {}), position: [o.lng, o.lat] as LngLat, where: o.where, at: o.at, confirmed: o.status === "confirmed", seenBy: o.confirmedBy.length };
  }
  /** The shape the other map events carry in `observation`. */
  private mapObservation(o: CameraObservation) {
    return { missionId: `camera:${o.id}`, type: "camera_discovery", position: [o.lng, o.lat], edgeIds: [], where: o.where, value: "yes", confirmedAt: this.d.now().toISOString(), confirmedBy: o.confirmedBy.length, kind: o.kind, label: o.label };
  }
  discoveries() {
    return this.observations.filter((o) => !o.missionId).map((o) => this.view(o));
  }
  /** Observations as stored, for tests and for the map to read. Participant ids stay on the server. */
  confirmedObservations() {
    return this.observations.filter((o) => o.status === "confirmed").map((o) => this.view(o));
  }
  stored(): readonly CameraObservation[] {
    return this.observations;
  }
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} και ${items[items.length - 1]}`;
}
