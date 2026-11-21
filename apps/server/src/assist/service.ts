/**
 * Help requests: a person who cannot see the way ahead asks, one citizen
 * accepts, they talk in a room, either ends, the helper earns points.
 *
 * Privacy: no names, no accounts. A device id is random and made on the
 * device. A request keeps only a position rounded to about 100 m. Nothing of
 * the call itself (video, audio, exact positions) passes through here.
 */
import { randomBytes } from "node:crypto";
import type { LngLat } from "@ion/core";
import { distanceM } from "../geo.ts";
import type { Profile } from "../missions/missions.ts";
import type { RoomHub } from "./hub.ts";

export const MARK_KINDS = {
  ramp: "Ράμπα",
  steps: "Σκαλιά",
  sidewalk_obstacle: "Εμπόδιο στο πεζοδρόμιο",
  audible_signal: "Φανάρι με ήχο",
  narrow_sidewalk: "Στενό πεζοδρόμιο",
  clear_path: "Ελεύθερος δρόμος",
} as const;
export type MarkKind = keyof typeof MARK_KINDS;

export interface AssistOptions {
  waitMs: number;
  minCallMs: number;
  callPoints: number;
  markPoints: number;
  rewardedCallsPerDay: number;
  marksPerDay: number;
  reportsPerCall: number;
  maxOpen: number;
  maxObservations: number;
  /** Open requests per device per hour. */
  requestsPerHour: number;
  /** A mark must be within this distance of the rounded request position. */
  markRadiusM: number;
}

export const DEFAULT_ASSIST_OPTIONS: AssistOptions = {
  waitMs: 5 * 60_000,
  minCallMs: 30_000,
  callPoints: 30,
  markPoints: 3,
  rewardedCallsPerDay: 5,
  marksPerDay: 30,
  reportsPerCall: 3,
  maxOpen: 200,
  maxObservations: 500,
  requestsPerHour: 10,
  markRadiusM: 1500,
};

export type RequestStatus = "open" | "accepted" | "ended" | "expired";
export type EndReason = "person_ended" | "helper_ended" | "expired" | "cancelled";

export interface Reward {
  rewarded: boolean;
  pointsEarned: number;
  durationS: number;
  reason?: "not_connected" | "too_short" | "daily_limit";
  profile: Profile;
}

interface HelpRequest {
  id: string;
  room: string;
  device: string;
  /** Rounded to about 100 m. The exact position is never kept. */
  position: LngLat;
  text: string;
  status: RequestStatus;
  createdAt: number;
  expiresAt: number;
  helper?: string;
  acceptedAt?: number;
  /** Set when the person who asked reports that sound or picture arrived. A call that never connected earns nothing. */
  connectedAt?: number;
  endedAt?: number;
  endReason?: EndReason;
  reward?: Reward;
  reports: number;
}

export interface Observation {
  id: string;
  kind: MarkKind;
  label: string;
  lng: number;
  lat: number;
  where?: string;
  at: string;
  source: "help_call";
  sourceLabel: string;
}

export type Fail = { ok: false; status: 400 | 403 | 404 | 409 | 410 | 422 | 429 | 503; code: string; message: string };
const fail = (status: Fail["status"], code: string, message: string): Fail => ({ ok: false, status, code, message });

/** Round to the centre of a ~100 m cell. */
export function roundPosition(p: LngLat, cellM = 100): LngLat {
  const latStep = cellM / 110_540;
  const lngStep = cellM / (111_320 * Math.cos((p[1] * Math.PI) / 180));
  const r = (v: number, s: number) => (Math.floor(v / s) + 0.5) * s;
  return [Number(r(p[0], lngStep).toFixed(5)), Number(r(p[1], latStep).toFixed(5))];
}
const round10 = (p: LngLat): LngLat => [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))];

export interface AssistDeps {
  hub: RoomHub;
  now: () => Date;
  areaOf: (p: LngLat) => string;
  award: (participant: string, points: number) => Profile;
  profile: (participant: string) => Profile;
  announce: (event: { type: string; [k: string]: unknown }) => void;
  fileReport: (input: { lng: number; lat: number; text: string }) => Promise<{ id: string } | null>;
  opts?: Partial<AssistOptions>;
}

export class AssistService {
  readonly opts: AssistOptions;
  private readonly requests = new Map<string, HelpRequest>();
  private readonly observations: Observation[] = [];
  private readonly rewardedToday = new Map<string, number>();
  private readonly marksToday = new Map<string, number>();
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly d: AssistDeps) {
    this.opts = { ...DEFAULT_ASSIST_OPTIONS, ...d.opts };
  }

  private t() {
    return this.d.now().getTime();
  }
  private day() {
    return this.d.now().toISOString().slice(0, 10);
  }

  /** Expire waiting requests and forget old finished ones. */
  sweep(): void {
    const t = this.t();
    for (const r of this.requests.values()) {
      if (r.status === "open" && t >= r.expiresAt) this.finish(r, "expired");
      else if ((r.status === "ended" || r.status === "expired") && t - (r.endedAt ?? t) > 10 * 60_000) this.requests.delete(r.id);
    }
  }

  create(device: string, at: LngLat, text: string): { ok: true; request: HelpRequest } | Fail {
    this.sweep();
    for (const r of this.requests.values()) {
      if (r.device === device && (r.status === "open" || r.status === "accepted")) return fail(409, "already_open", "Έχετε ήδη ένα αίτημα ανοιχτό.");
    }
    const t = this.t();
    const times = (this.recent.get(device) ?? []).filter((s) => t - s < 3_600_000);
    if (times.length >= this.opts.requestsPerHour) return fail(429, "too_many_requests", "Έχετε κάνει πολλά αιτήματα τελευταία. Δοκιμάστε σε λίγο.");
    const open = [...this.requests.values()].filter((r) => r.status === "open").length;
    if (open >= this.opts.maxOpen) return fail(503, "busy", "Υπάρχουν πολλά αιτήματα αυτή τη στιγμή.");
    const id = randomBytes(8).toString("hex");
    const room = `assist-${randomBytes(16).toString("hex")}`;
    if (!this.d.hub.open(room, 2)) return fail(503, "busy", "Δεν υπάρχει διαθέσιμο δωμάτιο αυτή τη στιγμή.");
    times.push(t);
    this.recent.set(device, times);
    const request: HelpRequest = { id, room, device, position: roundPosition(at), text, status: "open", createdAt: t, expiresAt: t + this.opts.waitMs, reports: 0 };
    this.requests.set(id, request);
    this.d.announce({ type: "assist_requested", requestId: id, area: this.d.areaOf(request.position), position: request.position });
    return { ok: true, request };
  }

  /** Open requests near a point. The exact position is never part of a view. */
  nearby(point: LngLat, radiusM: number, limit = 20) {
    this.sweep();
    const t = this.t();
    return [...this.requests.values()]
      .filter((r) => r.status === "open")
      .map((r) => ({ r, d: Math.round(distanceM(point, r.position) / 50) * 50 }))
      .filter((x) => x.d <= radiusM)
      .sort((a, b) => a.d - b.d || a.r.createdAt - b.r.createdAt)
      .slice(0, limit)
      .map(({ r, d }) => ({
        id: r.id, area: this.d.areaOf(r.position), distanceM: d, text: r.text,
        waitingS: Math.round((t - r.createdAt) / 1000), expiresInS: Math.max(0, Math.round((r.expiresAt - t) / 1000)),
      }));
  }

  private get(id: string) {
    this.sweep();
    return this.requests.get(id);
  }

  view(r: HelpRequest, device: string) {
    const mine = device === r.device ? "person" : device === r.helper ? "helper" : null;
    return {
      id: r.id, status: r.status, role: mine, expiresAt: new Date(r.expiresAt).toISOString(),
      ...(mine && r.status === "accepted" ? { room: r.room } : {}),
      ...(r.endReason ? { endReason: r.endReason } : {}),
      ...(r.acceptedAt ? { acceptedAt: new Date(r.acceptedAt).toISOString() } : {}),
      ...(mine === "helper" && r.reward ? { reward: r.reward } : {}),
    };
  }

  status(id: string, device: string) {
    const r = this.get(id);
    if (!r) return fail(404, "not_found", "Δεν βρέθηκε το αίτημα.");
    if (device !== r.device && device !== r.helper) return fail(403, "not_yours", "Αυτό το αίτημα δεν είναι δικό σας.");
    return { ok: true as const, request: this.view(r, device) };
  }

  /** The person gets the room as soon as the request is made, to join when someone accepts. */
  roomFor(r: HelpRequest) {
    return r.room;
  }

  getRaw(id: string) {
    return this.get(id);
  }

  accept(id: string, helper: string) {
    const r = this.get(id);
    if (!r) return fail(404, "not_found", "Δεν βρέθηκε το αίτημα.");
    if (r.device === helper) return fail(403, "own_request", "Δεν μπορείτε να αποδεχτείτε το δικό σας αίτημα.");
    if (r.status === "expired") return fail(410, "expired", "Το αίτημα έληξε.");
    if (r.status !== "open") return fail(409, "taken", "Το αίτημα το ανέλαβε ήδη άλλος δημότης.");
    r.status = "accepted";
    r.helper = helper;
    r.acceptedAt = this.t();
    this.d.announce({ type: "assist_accepted", requestId: r.id, position: r.position });
    return { ok: true as const, request: { ...this.view(r, helper), room: r.room } };
  }

  /** Only the person who asked can say the call connected: a helper cannot confirm their own points. */
  connected(id: string, device: string) {
    const r = this.get(id);
    if (!r) return fail(404, "not_found", "Δεν βρέθηκε το αίτημα.");
    if (device !== r.device) return fail(403, "not_yours", "Αυτό το αίτημα δεν είναι δικό σας.");
    if (r.status !== "accepted") return fail(409, "not_in_call", "Η κλήση δεν είναι ενεργή.");
    r.connectedAt ??= this.t();
    return { ok: true as const, request: this.view(r, device) };
  }

  end(id: string, device: string) {
    const r = this.get(id);
    if (!r) return fail(404, "not_found", "Δεν βρέθηκε το αίτημα.");
    if (device !== r.device && device !== r.helper) return fail(403, "not_yours", "Αυτό το αίτημα δεν είναι δικό σας.");
    if (r.status === "open") this.finish(r, "cancelled");
    else if (r.status === "accepted") this.finish(r, device === r.device ? "person_ended" : "helper_ended");
    return { ok: true as const, request: this.view(r, device) };
  }

  private finish(r: HelpRequest, reason: EndReason) {
    const t = this.t();
    const wasAccepted = r.status === "accepted";
    r.status = reason === "expired" ? "expired" : "ended";
    r.endReason = reason;
    r.endedAt = t;
    let rewarded = false;
    let durationS = 0;
    if (wasAccepted && r.helper && r.acceptedAt) {
      const ms = r.connectedAt ? t - r.connectedAt : 0;
      durationS = Math.round(ms / 1000);
      const key = `${r.helper}:${this.day()}`;
      const given = this.rewardedToday.get(key) ?? 0;
      let reasonNo: Reward["reason"];
      if (!r.connectedAt) reasonNo = "not_connected";
      else if (ms <= this.opts.minCallMs) reasonNo = "too_short";
      else if (given >= this.opts.rewardedCallsPerDay) reasonNo = "daily_limit";
      if (!reasonNo) {
        this.rewardedToday.set(key, given + 1);
        rewarded = true;
      }
      const profile = rewarded ? this.d.award(r.helper, this.opts.callPoints) : this.d.profile(r.helper);
      r.reward = { rewarded, pointsEarned: rewarded ? this.opts.callPoints : 0, durationS, ...(reasonNo ? { reason: reasonNo } : {}), profile };
    }
    this.d.hub.closeRoom(r.room, { reason, requestId: r.id });
    this.d.announce({ type: "assist_ended", requestId: r.id, reason, durationS, rewarded, position: r.position });
  }

  async mark(id: string, device: string, kind: MarkKind, at: LngLat) {
    const r = this.get(id);
    if (!r) return fail(404, "not_found", "Δεν βρέθηκε το αίτημα.");
    if (device !== r.helper) return fail(403, "not_helper", "Μόνο ο δημότης που βοηθά μπορεί να σημειώσει.");
    if (r.status !== "accepted") return fail(409, "not_active", "Η κλήση έχει τελειώσει.");
    if (distanceM(at, r.position) > this.opts.markRadiusM) return fail(422, "too_far", "Η θέση δεν ταιριάζει με το αίτημα.");
    const p = round10(at);
    const where = this.d.areaOf(p);
    const obs: Observation = {
      id: randomBytes(6).toString("hex"), kind, label: MARK_KINDS[kind], lng: p[0], lat: p[1], where,
      at: this.d.now().toISOString(), source: "help_call", sourceLabel: "Παρατήρηση κατά τη διάρκεια κλήσης βοήθειας",
    };
    this.observations.push(obs);
    if (this.observations.length > this.opts.maxObservations) this.observations.shift();
    const key = `${device}:${this.day()}`;
    const marks = this.marksToday.get(key) ?? 0;
    const earned = marks < this.opts.marksPerDay;
    if (earned) this.marksToday.set(key, marks + 1);
    const profile = earned ? this.d.award(device, this.opts.markPoints) : this.d.profile(device);
    let report: { id: string } | null = null;
    let reportProblem: string | undefined;
    if (kind === "sidewalk_obstacle") {
      if (r.reports >= this.opts.reportsPerCall) reportProblem = "limit";
      else {
        r.reports++;
        try {
          report = await this.d.fileReport({ lng: p[0], lat: p[1], text: "Εμπόδιο στο πεζοδρόμιο, παρατηρήθηκε κατά τη διάρκεια κλήσης βοήθειας." });
        } catch {
          reportProblem = "unavailable";
        }
      }
    }
    return { ok: true as const, observation: obs, pointsEarned: earned ? this.opts.markPoints : 0, profile, report, ...(reportProblem ? { reportProblem } : {}) };
  }

  observationsList(limit = 200) {
    return this.observations.slice(-limit).reverse();
  }
}
