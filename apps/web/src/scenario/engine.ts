/**
 * The scenario state machine. One instance runs in the tab that hosts the demo
 * and both screens render its state, so they cannot disagree.
 *
 * It owns no clock, no network and no speech: those come in as ports. `tick()`
 * moves the simulated walker and the timeline of a route change forward.
 */
import {
  checkObstacleRemoved,
  describeObstacleRemoved,
  describeReroute,
  findRoute,
  haversineM,
  nearestEdge,
  nearestNode,
  nextAnnouncements,
  rerouteForObstacle,
  slicePolyline,
  walkerAt,
  type Announcement,
  type GraphIndex,
  type LngLat,
  type Obstacle,
  type RerouteResult,
  type Route,
  type WalkerState,
} from "@ion/core";
import type { Signal } from "../devices/signals";
import { resolveTimeScale } from "./config";
import { instructionView, phraseFor, round5, SAY, wordDurations } from "./phrases";
import { findPlace, looksLikeHospital, matchPlace, searchPlaces, toPlaceInfo, type PlaceRecord } from "./places";
import { choosePlacement, type Placement } from "./placement";
import type { ApiPort, ApiResult, VoicePort } from "./ports";
import type {
  Caption,
  Command,
  DestinationInfo,
  Effect,
  Phase,
  ScenarioConfig,
  ScenarioState,
  ServerEvent,
  Toast,
  TrackedObstacle,
} from "./types";

export interface EngineDeps {
  index: GraphIndex;
  places: readonly PlaceRecord[];
  api: ApiPort;
  voice: VoicePort;
  /** Monotonic milliseconds. */
  now: () => number;
  /** Epoch milliseconds: the time obstacles are evaluated at. */
  wallNow: () => number;
  effect?: (effect: Effect) => void;
  /** Whether the presenter has sound on: the turn sound then plays inside the moment. */
  soundOn?: () => boolean;
}

/** Timeline of a route change, in real milliseconds. Suggestions, tuned by eye. */
export const MOMENT = {
  /** The obstacle is shown confirmed, in full light, before the cut. */
  warnMs: 900,
  /** Silence in the dark before the voice. The earcon has already played. */
  voiceDelayMs: 600,
  turnSoundMs: 3000,
  /** Silence after the voice (and the turn sound) before the light returns. */
  silenceMs: 900,
  /** The new route is being drawn. */
  mendMs: 1600,
} as const;

const TOAST_MS = 7000;
/** The earcon names the kind of message about 300 ms before the voice begins (DESIGN.md section 6). */
const EARCON_LEAD_MS = 300;
const MOVING: readonly Phase[] = ["walking", "reported", "rerouting", "walking_new", "restored"];

export function initialState(config: ScenarioConfig): ScenarioState {
  return {
    rev: 0,
    ready: false,
    phase: "idle",
    config,
    connection: "unknown",
    localFallback: false,
    start: null,
    request: config.sentence,
    destination: null,
    route: null,
    walker: null,
    timeScale: 1,
    paused: false,
    obstacles: [],
    focusObstacleId: null,
    caption: null,
    instruction: null,
    moment: null,
    change: null,
    metrics: null,
    toasts: [],
    signal: null,
    notice: "",
    speech: "unknown",
    busy: false,
  };
}

export function isReport(obstacle: Obstacle): boolean {
  return obstacle.source.kind === "sandbox_request" || obstacle.source.kind === "user_report" || obstacle.id.startsWith("local:");
}

export function closesEdge(obstacle: Obstacle): boolean {
  return obstacle.blocks === "full" && obstacle.confidence >= 0.5;
}

interface Queued {
  text: string;
  kind: Caption["kind"];
  urgent?: boolean;
  leadMs?: number;
  /** Checked when a waiting sentence finally gets its turn: a turn already passed is not said late. */
  valid?: () => boolean;
  onStart?: () => void;
  onEnd?: () => void;
}

interface MomentRun {
  startedAt: number;
  darkAt: number | null;
  mendAt: number | null;
  lightAt: number | null;
  deadline: number | null;
  spoken: boolean;
  replay: boolean;
  obstacle: Obstacle;
  result: Extract<RerouteResult, { outcome: "reroute" | "turn_back" }>;
  /** Walker distance when the route was computed. */
  progressAtComputeM: number;
  /** Metres along the current route where the turn is. */
  decisionAtM: number;
  text: string | null;
}

interface UpsertMeta {
  createdHere?: boolean;
  local?: boolean;
  reportId?: string | null;
  witnesses?: number;
  /** When the server event carrying it arrived. */
  receivedAt?: number;
  quiet?: boolean;
}

export class ScenarioEngine {
  private state: ScenarioState;
  private readonly listeners = new Set<(state: ScenarioState) => void>();
  private readonly tracked = new Map<string, TrackedObstacle>();
  /** Obstacles whose effect on the route has been decided once. */
  private readonly handled = new Set<string>();
  /** When the call that may close a pavement was sent, by obstacle id. */
  private readonly sentAt = new Map<string, number>();
  private announced: string[] = [];
  private route: Route | null = null;
  private walker: WalkerState | null = null;
  private simT = 0;
  private lastTick: number | null = null;
  private baseScale = 1;
  private speaking = false;
  private currentUtterance = 0;
  private pending: Queued | null = null;
  private run: MomentRun | null = null;
  private lastRun: MomentRun | null = null;
  private ids = 0;

  constructor(
    private readonly deps: EngineDeps,
    config: ScenarioConfig,
  ) {
    this.state = { ...initialState(config), ready: true };
    const start = findPlace(deps.places, config.from) ?? searchPlaces(deps.places, config.from);
    if (start) this.state.start = toPlaceInfo(start);
  }

  getState(): ScenarioState {
    return this.state;
  }

  subscribe(listener: (state: ScenarioState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- commands ---------------------------------------------------------------------------

  async dispatch(command: Command): Promise<void> {
    switch (command.type) {
      case "advance":
        if (this.state.phase === "idle") return this.setDestination(this.state.config.sentence);
        if (this.state.phase === "destination") return this.start();
        return;
      case "setDestination":
        return this.setDestination(command.text);
      case "clearDestination":
        if (this.state.phase === "destination" || this.state.phase === "arrived") this.clear();
        return;
      case "start":
        return this.start();
      case "report":
        return this.report(command.at);
      case "confirm":
        return this.confirm();
      case "resolve":
        return this.resolve();
      case "reset":
        return this.reset();
      case "pause":
        this.lastTick = this.deps.now();
        this.patch({ paused: !this.state.paused });
        this.deps.effect?.({ type: "walking", on: this.isMoving() });
        return;
      case "replay":
        return this.replay();
    }
  }

  private async setDestination(text: string): Promise<void> {
    const sentence = text.trim();
    if (!sentence || this.state.busy || MOVING.includes(this.state.phase)) return;
    this.patch({ busy: true, request: sentence });
    const start = this.state.start;
    const result = await this.deps.api.destination(sentence, start ? { lng: start.lng, lat: start.lat } : undefined);
    this.note(result);
    let destination: DestinationInfo | null = null;
    let speech: string;
    // The catalogue of OpenStreetMap places in this browser: used when the server does not know the place, does not
    // answer, or only guesses (confidence under 0.8) while the catalogue has every word that was said.
    const local = matchPlace(this.deps.places, sentence, start ?? undefined);
    const server = result.ok && result.data?.understood ? result.data : null;
    const preferLocal = local !== null && (server ? server.confidence < 0.8 && local.share >= 1 : local.share >= 0.45);
    if (server && !preferLocal) {
      const place = server.place;
      const node = nearestNode(this.deps.index, [place.lng, place.lat]);
      destination = {
        id: place.id,
        name: place.name,
        lng: place.lng,
        lat: place.lat,
        address: place.address ?? null,
        ...(node ? { nodeId: node.node.id } : {}),
        how: server.how ?? "server",
        local: false,
        hospital: looksLikeHospital(place.name, place.category ?? place.kind),
      };
      speech = server.speech;
    } else if (local && preferLocal) {
      const record = local.place;
      destination = { ...toPlaceInfo(record), how: "local_places", local: true, hospital: looksLikeHospital(record.name, record.kind) };
      const far = start ? haversineM([start.lng, start.lat], [record.lng, record.lat]) : 0;
      speech = SAY.foundLocal(record.name, far);
      this.toast(`ΤΟΠΙΚΟΣ ΚΑΤΑΛΟΓΟΣ OSM · ${record.name}`, "local");
      if (result.unreachable) this.state.localFallback = true;
    } else {
      speech = result.data && !result.data.understood ? result.data.speech : SAY.notUnderstood;
    }
    if (destination) {
      if (destination.hospital) speech = `${speech} ${SAY.emergency}`;
      this.patch({ busy: false, destination, phase: "destination", notice: speech });
    } else {
      this.patch({ busy: false, destination: null, phase: "idle", notice: speech });
    }
    this.say({ text: speech, kind: "info", urgent: true });
  }

  private async start(): Promise<void> {
    const { start, destination, busy, phase } = this.state;
    if (!start || !destination || busy || phase !== "destination") return;
    this.patch({ busy: true });
    const result = await this.deps.api.route({ lng: start.lng, lat: start.lat }, { lng: destination.lng, lat: destination.lat });
    this.note(result);
    let route: Route | null = result.ok && result.data && this.usable(result.data.route) ? result.data.route : null;
    if (!route) {
      const from = start.nodeId && this.deps.index.nodes.has(start.nodeId) ? start.nodeId : nearestNode(this.deps.index, [start.lng, start.lat])?.node.id;
      const to = destination.nodeId && this.deps.index.nodes.has(destination.nodeId) ? destination.nodeId : nearestNode(this.deps.index, [destination.lng, destination.lat])?.node.id;
      if (from && to) {
        const local = findRoute(this.deps.index, from, to, { atTime: this.deps.wallNow(), obstacles: this.routingObstacles() });
        if (local.ok && local.route.edges.length > 0) {
          route = local.route;
          this.toast("ΔΙΑΔΡΟΜΗ ΥΠΟΛΟΓΙΣΜΕΝΗ ΤΟΠΙΚΑ · @ion/core", "local");
          if (result.unreachable) this.state.localFallback = true;
        }
      }
    }
    if (!route) {
      this.patch({ busy: false, notice: SAY.noRoute });
      this.say({ text: SAY.noRoute, kind: "info", urgent: true });
      return;
    }
    this.route = route;
    this.simT = 0;
    this.announced = [];
    this.handled.clear();
    for (const id of this.tracked.keys()) this.handled.add(id); // already part of this route's calculation
    this.baseScale = resolveTimeScale(this.state.config, route.lengthM);
    this.lastTick = this.deps.now();
    this.run = this.lastRun = null;
    this.state = {
      ...this.state,
      busy: false,
      route,
      phase: this.unconfirmedAhead() ? "reported" : "walking",
      timeScale: this.baseScale,
      paused: false,
      change: null,
      metrics: null,
      moment: null,
      notice: "Η πλοήγηση ξεκινά.",
    };
    this.deps.effect?.({ type: "earcon", name: "start" });
    this.deps.effect?.({ type: "walking", on: true });
    this.advance();
    this.emit();
  }

  private async report(at: "ahead" | "walker"): Promise<void> {
    const route = this.route;
    const walker = this.walker;
    if (!route || !walker || walker.arrived || this.state.busy || !MOVING.includes(this.state.phase)) return;
    const { config } = this.state;
    let point: LngLat;
    let planned: Placement | null = null;
    if (at === "walker") {
      point = walker.position;
    } else {
      // The presenter needs a few seconds for the confirmations: ask for that much more warning.
      const lead = config.confirmLeadS * config.speedMps * this.baseScale;
      planned = choosePlacement(this.deps.index, route, walker.distanceM, {
        minDecisionAheadM: config.minDecisionAheadM + lead,
        minExtraM: config.minExtraM,
        maxExtraM: config.maxExtraM,
        targetExtraM: config.targetExtraM,
        atTime: this.deps.wallNow(),
        obstacles: this.routingObstacles(),
      });
      if (!planned) {
        this.toast("Δεν υπάρχει σημείο μπροστά όπου ένα εμπόδιο αλλάζει τη διαδρομή", "error");
        this.emit();
        return;
      }
      point = planned.position;
    }
    this.patch({ busy: true });
    const result = await this.deps.api.report({ lng: point[0], lat: point[1], category: config.category, text: config.obstacleText });
    this.note(result);
    this.state.busy = false;
    let said: string;
    if (result.ok && result.data) {
      const { obstacle, report } = result.data;
      if (obstacle) {
        const witnesses = 1 + (report.upvotes ?? 0);
        this.upsert(obstacle, { createdHere: true, reportId: report.id, witnesses });
        said = SAY.reportFiled((this.tracked.get(obstacle.id)?.needed ?? config.witnessesNeeded) - witnesses);
      } else {
        said = SAY.reportNotObstacle;
      }
    } else if (result.unreachable) {
      const edgeId = planned?.edgeId ?? nearestEdge(this.deps.index, point, 40)?.edge.id ?? walker.edgeId;
      if (!edgeId) {
        this.emit();
        return;
      }
      const street = this.deps.index.edges.get(edgeId)?.name;
      const id = `local:${++this.ids}`;
      this.state.localFallback = true;
      this.toast("ΤΟΠΙΚΗ ΠΡΟΣΟΜΟΙΩΣΗ · το εμπόδιο υπάρχει μόνο σε αυτόν τον browser", "local");
      this.upsert(
        {
          id,
          edgeId,
          blocks: config.witnessesNeeded <= 1 ? "full" : "partial",
          type: config.category,
          label: street ? `Εμπόδιο στο πεζοδρόμιο, ${street}` : "Εμπόδιο στο πεζοδρόμιο",
          source: { kind: "synthetic" },
          synthetic: true,
          observedAt: new Date(this.deps.wallNow()).toISOString(),
          expiresAt: null,
          confidence: config.witnessesNeeded <= 1 ? 0.85 : 0.6,
          position: point,
        },
        { createdHere: true, local: true, reportId: null, witnesses: 1 },
      );
      said = SAY.reportFiledLocal;
    } else {
      said = SAY.reportFailed;
    }
    this.state.notice = said;
    // The person who pressed the button is told what happened. A report by someone else is not announced to the walker.
    if (at === "walker") this.say({ text: said, kind: "info" });
    this.emit();
  }

  private async confirm(): Promise<void> {
    const target = this.confirmTarget();
    if (!target) {
      this.toast("Δεν υπάρχει αναφορά που περιμένει επιβεβαίωση", "error");
      this.emit();
      return;
    }
    if (this.state.busy) return;
    const id = target.obstacle.id;
    this.sentAt.set(id, this.deps.now());
    if (!target.local && target.reportId) {
      this.patch({ busy: true });
      const result = await this.deps.api.confirm(target.reportId);
      this.note(result);
      this.state.busy = false;
      if (result.ok && result.data) {
        const { obstacle, report } = result.data;
        if (obstacle) this.upsert(obstacle, { reportId: report.id, witnesses: 1 + (report.upvotes ?? 0) });
        else this.remove(id);
        this.emit();
        return;
      }
      if (!result.unreachable) {
        this.emit();
        return;
      }
      // The server went away in the middle: carry on in this browser, and say so on screen.
      this.state.localFallback = true;
      this.toast("ΤΟΠΙΚΗ ΠΡΟΣΟΜΟΙΩΣΗ · η επιβεβαίωση δεν έφτασε στον διακομιστή", "local");
    }
    const current = this.tracked.get(id);
    if (!current) return;
    const witnesses = current.witnesses + 1;
    const full = witnesses >= current.needed;
    this.upsert(
      { ...current.obstacle, blocks: full ? "full" : "partial", confidence: full ? 0.85 : 0.6 },
      { local: true, witnesses },
    );
    this.emit();
  }

  private async resolve(): Promise<void> {
    const focus = this.state.focusObstacleId ? this.tracked.get(this.state.focusObstacleId) : undefined;
    const target = focus ?? [...this.tracked.values()].reverse().find((t) => t.createdHere);
    if (!target) {
      this.toast("Δεν υπάρχει εμπόδιο του demo προς απομάκρυνση", "error");
      this.emit();
      return;
    }
    if (this.state.busy) return;
    const id = target.obstacle.id;
    if (!target.local && target.reportId) {
      this.patch({ busy: true });
      const result = await this.deps.api.resolve(target.reportId);
      this.note(result);
      this.state.busy = false;
      if (!result.ok && !result.unreachable) {
        this.emit();
        return;
      }
      if (result.unreachable) {
        this.state.localFallback = true;
        this.toast("ΤΟΠΙΚΗ ΠΡΟΣΟΜΟΙΩΣΗ · η απομάκρυνση δεν έφτασε στον διακομιστή", "local");
      }
    }
    this.remove(id);
    this.emit();
  }

  private async reset(): Promise<void> {
    this.deps.voice.cancel();
    this.speaking = false;
    this.pending = null;
    this.currentUtterance++;
    const result = await this.deps.api.reset();
    this.note(result);
    for (const [id, t] of this.tracked) if (t.createdHere || t.local) this.tracked.delete(id);
    this.state.localFallback = false;
    this.clear();
  }

  /** Back to the start, keeping what is known about the server. */
  private clear(): void {
    this.route = null;
    this.walker = null;
    this.simT = 0;
    this.announced = [];
    this.handled.clear();
    this.sentAt.clear();
    this.run = this.lastRun = null;
    this.deps.effect?.({ type: "walking", on: false });
    this.state = {
      ...this.state,
      phase: "idle",
      busy: false,
      request: this.state.config.sentence,
      destination: null,
      route: null,
      walker: null,
      timeScale: 1,
      paused: false,
      focusObstacleId: null,
      caption: null,
      instruction: null,
      moment: null,
      change: null,
      metrics: null,
      signal: null,
      notice: "",
    };
    this.emit();
  }

  private replay(): void {
    if (!this.lastRun || this.state.moment || !this.state.change) return;
    const now = this.deps.now();
    this.run = { ...this.lastRun, startedAt: now, darkAt: null, mendAt: null, lightAt: null, deadline: null, spoken: false, replay: true };
    this.patch({ moment: { id: ++this.ids, beat: "warn", replay: true } });
    this.deps.effect?.({ type: "walking", on: false });
    this.deps.effect?.({ type: "earcon", name: "obstacle" });
  }

  // ---- server events ----------------------------------------------------------------------

  serverEvent(event: ServerEvent): void {
    const receivedAt = this.deps.now();
    this.state.connection = "online";
    switch (event.type) {
      case "snapshot": {
        const seen = new Set<string>();
        for (const obstacle of event.obstacles) {
          seen.add(obstacle.id);
          this.upsert(obstacle, { receivedAt, quiet: true });
        }
        if (!event.stale) {
          for (const [id, t] of this.tracked) if (!t.local && !seen.has(id)) this.remove(id);
        }
        break;
      }
      case "obstacle_added":
      case "obstacle_changed": {
        const known = this.tracked.get(event.obstacle.id);
        if (isReport(event.obstacle) && !known?.createdHere) this.toast(`SSE ${event.type} · SANDBOX`, "ok");
        this.upsert(event.obstacle, { receivedAt });
        break;
      }
      case "obstacle_removed": {
        const known = this.tracked.get(event.obstacle.id);
        if (known && !known.createdHere) this.toast("SSE obstacle_removed · SANDBOX", "ok");
        this.remove(event.obstacle.id);
        break;
      }
      default:
        this.toast(`SSE ${event.type} · SANDBOX`, "ok");
    }
    this.emit();
  }

  /** The event stream opened or broke. */
  streamStatus(open: boolean): void {
    const connection = open ? "online" : "offline";
    if (this.state.connection !== connection) this.patch({ connection });
  }

  // ---- obstacles --------------------------------------------------------------------------

  private upsert(obstacle: Obstacle, meta: UpsertMeta = {}): void {
    const previous = this.tracked.get(obstacle.id);
    const report = isReport(obstacle);
    const closes = closesEdge(obstacle);
    let needed = previous?.needed ?? this.state.config.witnessesNeeded;
    let witnesses = meta.witnesses ?? previous?.witnesses ?? 1;
    if (report) {
      // The rule lives on the server. If it closes sooner or later than configured, show what it did.
      if (closes && meta.witnesses !== undefined && witnesses < needed) needed = witnesses;
      if (closes && meta.witnesses === undefined) witnesses = Math.max(witnesses, needed);
      if (!closes && witnesses >= needed) needed = witnesses + 1;
    }
    const tracked: TrackedObstacle = {
      obstacle,
      reportId: meta.reportId ?? previous?.reportId ?? (obstacle.source.ref && report ? obstacle.source.ref : null),
      witnesses,
      needed,
      closes,
      report,
      createdHere: meta.createdHere ?? previous?.createdHere ?? false,
      local: meta.local ?? previous?.local ?? false,
    };
    this.tracked.set(obstacle.id, tracked);
    if (!this.route) return;
    if (report && !closes) {
      // One person has seen it. Nothing changes for the walker.
      if (this.state.phase === "walking" && this.isAhead(obstacle)) {
        this.state.phase = "reported";
        this.state.focusObstacleId = obstacle.id;
      }
      return;
    }
    this.consider(tracked, meta.receivedAt);
  }

  private remove(id: string): void {
    const previous = this.tracked.get(id);
    if (!previous) return;
    this.tracked.delete(id);
    this.handled.delete(id);
    this.sentAt.delete(id);
    const wasFocus = this.state.focusObstacleId === id;
    if (wasFocus) this.state.focusObstacleId = null;
    const route = this.route;
    const walker = this.walker;
    if (!route || !walker || !MOVING.includes(this.state.phase)) return;
    if (previous.report && !previous.closes) {
      if (this.state.phase === "reported" && !this.unconfirmedAhead()) this.state.phase = "walking";
      return;
    }
    const check = checkObstacleRemoved(this.deps.index, route, walker.distanceM, {
      atTime: this.deps.wallNow(),
      obstacles: this.routingObstacles(),
    });
    if (check.outcome !== "shorter_available") {
      if (wasFocus || this.state.change?.obstacleId === id) {
        this.state.notice = SAY.clearedNoChange;
        this.say({ text: SAY.clearedNoChange, kind: "info" });
      }
      return;
    }
    const divergeAtM = walker.distanceM + check.distanceToDecisionM;
    const announcement = describeObstacleRemoved(id, check);
    this.state.change = {
      id: ++this.ids,
      kind: "restored",
      abandoned: slicePolyline(route.geometry, divergeAtM, route.lengthM),
      fresh: slicePolyline(check.route.geometry, divergeAtM, check.route.lengthM),
      divergeAtM,
      turn: check.turnDirection,
      obstacleId: id,
    };
    this.route = check.route;
    this.state.route = check.route;
    this.state.phase = "restored";
    this.state.moment = null;
    this.run = null;
    this.lastRun = null;
    this.state.timeScale = this.baseScale;
    this.deps.effect?.({ type: "earcon", name: "new_route" });
    if (announcement) {
      const text = phraseFor(announcement, this.phraseContext());
      this.state.notice = text;
      this.say({ text, kind: "info", urgent: true });
    }
    this.advance(true);
  }

  /** Decide once what an obstacle that counts for routing means for the walker. */
  private consider(tracked: TrackedObstacle, receivedAt?: number): void {
    const route = this.route;
    const walker = this.walker;
    const { obstacle } = tracked;
    if (!route || !walker || walker.arrived || this.handled.has(obstacle.id)) return;
    if (!MOVING.includes(this.state.phase) || this.state.moment) return;
    this.handled.add(obstacle.id);
    const result = rerouteForObstacle(this.deps.index, route, walker.distanceM, obstacle, {
      atTime: this.deps.wallNow(),
      obstacles: this.routingObstacles(obstacle.id),
    });
    if (result.outcome === "not_relevant") {
      if (tracked.createdHere) this.toast("Το εμπόδιο δεν βρίσκεται στη διαδρομή μπροστά από τον πεζό", "error");
      if (this.state.phase === "reported" && !this.unconfirmedAhead()) this.state.phase = "walking";
      return;
    }
    if (result.outcome === "keep_route" || result.outcome === "no_alternative") {
      const announcement = describeReroute(obstacle, result);
      if (announcement) {
        const text = phraseFor(announcement, this.phraseContext());
        this.state.notice = text;
        this.state.focusObstacleId = obstacle.id;
        this.signal("obstacle_ahead");
        this.deps.effect?.({ type: "earcon", name: "obstacle" });
        this.say({ text, kind: "obstacle", urgent: result.outcome === "no_alternative" });
      }
      return;
    }
    this.beginMoment(tracked, result, receivedAt);
  }

  private beginMoment(
    tracked: TrackedObstacle,
    result: Extract<RerouteResult, { outcome: "reroute" | "turn_back" }>,
    receivedAt?: number,
  ): void {
    const old = this.route!;
    const walker = this.walker!;
    const now = this.deps.now();
    const { obstacle } = tracked;
    const sent = this.sentAt.get(obstacle.id);
    this.sentAt.delete(obstacle.id);
    const progress = walker.distanceM;
    const turnBack = result.outcome === "turn_back";
    const divergeAtM = turnBack ? 0 : progress + result.distanceToDecisionM;
    this.state.change = {
      id: ++this.ids,
      kind: result.outcome,
      abandoned: slicePolyline(old.geometry, turnBack ? progress : divergeAtM, old.lengthM),
      fresh: turnBack ? result.route.geometry : slicePolyline(result.route.geometry, divergeAtM, result.route.lengthM),
      divergeAtM,
      turn: turnBack ? "u_turn" : result.turnDirection,
      obstacleId: obstacle.id,
    };
    this.state.metrics = {
      reportToRouteS: Math.max(0, now - (sent ?? receivedAt ?? now)) / 1000,
      measuredFrom: tracked.local ? "local" : sent !== undefined ? "request" : "event",
      warningM: null,
      decisionAheadM: result.distanceToDecisionM,
      extraM: result.extraDistanceM,
      oldLengthM: old.lengthM,
      newLengthM: old.lengthM + result.extraDistanceM,
    };
    this.route = result.route;
    this.simT = result.progressM / this.state.config.speedMps;
    this.state.route = result.route;
    this.state.phase = "rerouting";
    this.state.focusObstacleId = obstacle.id;
    this.state.timeScale = 1; // the voice speaks in real time, so the walker moves in real time while it does
    this.state.moment = { id: ++this.ids, beat: "warn", replay: false };
    this.pending = null;
    this.run = {
      startedAt: now,
      darkAt: null,
      mendAt: null,
      lightAt: null,
      deadline: null,
      spoken: false,
      replay: false,
      obstacle,
      result,
      progressAtComputeM: turnBack ? 0 : progress,
      decisionAtM: turnBack ? result.distanceToDecisionM : divergeAtM,
      text: null,
    };
    this.signal("obstacle_ahead");
    this.deps.effect?.({ type: "earcon", name: "obstacle" });
    this.advance(true);
  }

  private runMoment(now: number): boolean {
    const run = this.run;
    const moment = this.state.moment;
    if (!run || !moment) return false;
    if (moment.beat === "warn") {
      if (now - run.startedAt < MOMENT.warnMs) return false;
      run.darkAt = now;
      this.state.moment = { ...moment, beat: "dark" };
      return true;
    }
    if (moment.beat === "dark") {
      if (!run.spoken && now - (run.darkAt ?? now) >= MOMENT.voiceDelayMs) {
        run.spoken = true;
        run.text ??= this.momentText(run);
        const text = run.text;
        this.state.notice = text;
        run.deadline = now + wordDurations(text).reduce((a, b) => a + b, 0) * 1.8 + 6000;
        this.say({
          text,
          kind: "obstacle",
          urgent: true,
          onStart: () => {
            const walker = this.walker;
            if (!run.replay && this.state.metrics && walker) {
              this.state.metrics = { ...this.state.metrics, warningM: Math.max(0, run.decisionAtM - walker.distanceM) };
            }
          },
          onEnd: () => {
            if (this.run !== run) return;
            const sound = this.deps.soundOn?.() ?? false;
            if (sound) this.deps.effect?.({ type: "turn_sound", toRight: !run.result.turnDirection?.endsWith("left") });
            run.lightAt = this.deps.now() + (sound ? MOMENT.turnSoundMs : 0) + MOMENT.silenceMs;
          },
        });
        return true;
      }
      if (run.spoken && run.lightAt === null && run.deadline !== null && now > run.deadline) run.lightAt = now;
      if (run.lightAt !== null && now >= run.lightAt) {
        run.mendAt = now;
        this.state.moment = { ...moment, beat: "mend" };
        if (!run.replay) {
          this.state.phase = "walking_new";
          this.state.timeScale = this.baseScale;
        }
        this.deps.effect?.({ type: "earcon", name: "new_route" });
        return true;
      }
      return false;
    }
    if (now - (run.mendAt ?? now) < MOMENT.mendMs) return false;
    this.state.moment = null;
    this.lastRun = run;
    this.run = null;
    if (run.replay) this.deps.effect?.({ type: "walking", on: this.isMoving() });
    return true;
  }

  /** The sentence of the route change, with the distances as they are when it is said. */
  private momentText(run: MomentRun): string {
    const announcement = describeReroute(run.obstacle, run.result);
    if (!announcement || announcement.type !== "obstacle") return "";
    const walked = Math.max(0, (this.walker?.distanceM ?? 0) - run.progressAtComputeM);
    const live: Announcement =
      run.result.outcome === "reroute"
        ? {
            ...announcement,
            distanceToObstacleM: round5(run.result.distanceToObstacleM - walked),
            distanceToDecisionM: round5(run.result.distanceToDecisionM - walked),
          }
        : announcement;
    return phraseFor(live, this.phraseContext());
  }

  // ---- walking ----------------------------------------------------------------------------

  tick(): void {
    const now = this.deps.now();
    const dt = this.lastTick === null ? 0 : Math.min(1000, Math.max(0, now - this.lastTick)) / 1000;
    this.lastTick = now;
    let changed = this.expireToasts(now);
    if (this.route && this.isMoving()) {
      this.simT += dt * this.state.timeScale;
      this.advance();
      changed = true;
    }
    if (this.runMoment(now)) changed = true;
    if (changed) this.emit();
  }

  private isMoving(): boolean {
    return MOVING.includes(this.state.phase) && !this.state.paused && !this.state.moment?.replay;
  }

  /** Move the walker to where the simulated clock says, and say what is due. */
  private advance(silent = false): void {
    const route = this.route;
    if (!route) return;
    const walker = walkerAt(this.deps.index, route, this.simT, { speedMps: this.state.config.speedMps });
    this.walker = walker;
    this.state.walker = {
      distanceM: walker.distanceM,
      remainingM: walker.remainingM,
      position: walker.position,
      bearing: walker.bearing,
      arrived: walker.arrived,
      street: (walker.edgeId ? this.deps.index.edges.get(walker.edgeId)?.name : null) ?? null,
    };
    this.state.instruction = instructionView(walker.nextStep, walker.distanceToNextStepM);
    // In the dark only the route change is said. What becomes due meanwhile is said afterwards.
    const inMoment = this.state.moment && this.state.moment.beat !== "mend";
    if (silent || inMoment) return;
    const out = nextAnnouncements(route, walker, this.announced);
    this.announced = out.announced;
    for (const a of out.announcements) this.announce(a, route);
    if (walker.arrived && this.state.phase !== "arrived") {
      this.state.phase = "arrived";
      this.state.instruction = null;
      this.deps.effect?.({ type: "walking", on: false });
    }
  }

  private announce(a: Announcement, route: Route): void {
    const text = phraseFor(a, this.phraseContext());
    if (a.type === "turn") {
      if (a.direction.endsWith("left")) this.signal("turn_left");
      else if (a.direction.endsWith("right")) this.signal("turn_right");
    }
    if (a.type === "arrival" && a.phase === "now") {
      this.signal("arrived");
      this.deps.effect?.({ type: "earcon", name: "arrival" });
      this.state.notice = text;
      this.say({ text, kind: "instruction", urgent: true });
      return;
    }
    this.state.notice = text;
    const at = "atNode" in a ? route.steps.find((s) => s.atNode === a.atNode && s.kind !== "depart")?.atDistanceM : undefined;
    this.deps.effect?.({ type: "earcon", name: "instruction" });
    this.say({
      text,
      kind: "instruction",
      leadMs: EARCON_LEAD_MS,
      // A sentence that had to wait is dropped once the walker is past its point, or when the route is no longer this one.
      valid: () => this.route === route && (at === undefined || (this.walker?.distanceM ?? 0) <= at + 3),
    });
  }

  // ---- speech -----------------------------------------------------------------------------

  /** One sentence in flight. A new instruction replaces one that is still waiting; an urgent one cuts in. */
  private say(queued: Queued): void {
    if (!queued.text) return;
    if (this.speaking && !queued.urgent) {
      this.pending = queued;
      return;
    }
    if (queued.urgent) this.pending = null;
    const id = ++this.currentUtterance;
    const total = queued.text.trim().split(/\s+/u).length;
    this.speaking = true;
    this.deps.voice.say({
      text: queued.text,
      urgent: queued.urgent ?? false,
      ...(queued.leadMs ? { leadMs: queued.leadMs } : {}),
      onStart: ({ voiced }) => {
        if (this.currentUtterance !== id) return;
        // The caption appears when the voice starts, not before.
        this.state.caption = { id, text: queued.text, kind: queued.kind, revealed: 1, voiced, done: false };
        this.state.speech = voiced ? "voice" : "timed";
        queued.onStart?.();
        this.emit();
      },
      onWord: (index) => {
        const caption = this.state.caption;
        if (this.currentUtterance !== id || !caption || caption.id !== id || index + 1 <= caption.revealed) return;
        this.state.caption = { ...caption, revealed: Math.min(total, index + 1) };
        this.emit();
      },
      onEnd: () => {
        if (this.currentUtterance !== id) return;
        this.speaking = false;
        const caption = this.state.caption;
        if (caption && caption.id === id) this.state.caption = { ...caption, revealed: total, done: true };
        queued.onEnd?.();
        const next = this.pending;
        this.pending = null;
        if (next && (next.valid?.() ?? true)) this.say(next);
        this.emit();
      },
    });
  }

  // ---- helpers ----------------------------------------------------------------------------

  private phraseContext() {
    const destination = this.state.destination;
    return {
      ...(destination ? { destinationName: destination.name } : {}),
      ...(this.route ? { routeLengthM: this.route.lengthM } : {}),
      entranceVerified: destination?.entranceVerified === true,
    };
  }

  /** Obstacles that routing takes into account: everything except citizen reports nobody has confirmed. */
  private routingObstacles(except?: string): Obstacle[] {
    const out: Obstacle[] = [];
    for (const t of this.tracked.values()) {
      if (t.obstacle.id === except) continue;
      if (t.report && !t.closes) continue;
      out.push(t.obstacle);
    }
    return out;
  }

  private confirmTarget(): TrackedObstacle | undefined {
    const open = [...this.tracked.values()].filter((t) => t.report && !t.closes);
    const focus = open.find((t) => t.obstacle.id === this.state.focusObstacleId);
    return focus ?? open.reverse().find((t) => t.createdHere) ?? open[0];
  }

  private isAhead(obstacle: Obstacle): boolean {
    const route = this.route;
    return !!route && route.edges.includes(obstacle.edgeId);
  }

  private unconfirmedAhead(): boolean {
    for (const t of this.tracked.values()) if (t.report && !t.closes && t.createdHere && this.isAhead(t.obstacle)) return true;
    return false;
  }

  private usable(route: Route | undefined): route is Route {
    if (!route || !Array.isArray(route.edges) || route.edges.length === 0) return false;
    if (!Array.isArray(route.steps) || !Array.isArray(route.geometry) || route.geometry.length < 2) return false;
    return route.edges.every((id) => this.deps.index.edges.has(id)) && route.nodes.every((id) => this.deps.index.nodes.has(id));
  }

  private signal(value: Signal): void {
    this.state.signal = { id: ++this.ids, value };
  }

  /** Name a server call on screen, and remember whether the server answers. */
  private note(result: ApiResult<unknown>): void {
    this.state.connection = result.unreachable ? "offline" : "online";
    const data = result.data as { sandbox?: boolean; demo?: boolean } | null;
    const status = result.status > 0 ? String(result.status) : "ΧΩΡΙΣ ΑΠΑΝΤΗΣΗ";
    const tags = result.ok ? `${data?.sandbox ? " · SANDBOX" : ""}${data?.demo ? " · DEMO" : ""}` : "";
    this.toast(`${result.method} /api${result.path} → ${status}${tags}`, result.ok ? "ok" : "error");
  }

  private toast(text: string, tone: Toast["tone"]): void {
    const toast: Toast = { id: ++this.ids, text, tone, at: this.deps.now() };
    this.state.toasts = [...this.state.toasts.slice(-2), toast];
  }

  private expireToasts(now: number): boolean {
    const kept = this.state.toasts.filter((t) => now - t.at < TOAST_MS);
    if (kept.length === this.state.toasts.length) return false;
    this.state.toasts = kept;
    return true;
  }

  private patch(partial: Partial<ScenarioState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private emit(): void {
    this.state = { ...this.state, rev: this.state.rev + 1, obstacles: [...this.tracked.values()] };
    for (const listener of this.listeners) listener(this.state);
  }
}
