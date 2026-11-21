/**
 * The scenario contract: everything both screens read. The state is plain data
 * (it crosses a BroadcastChannel), and nothing in it names a place or a scene.
 */
import type { LngLat, Obstacle, Route, TurnDirection } from "@ion/core";
import type { Signal } from "../devices/signals";

export type Phase =
  | "idle"
  | "destination" // destination resolved, not walking yet
  | "walking"
  | "reported" // a first, unconfirmed report exists: nothing changes for the walker
  | "rerouting" // confirmed and rerouted: the moment
  | "walking_new" // walking the new route
  | "restored" // obstacle resolved and route restored
  | "arrived";

export interface ScenarioConfig {
  /** Place id or name in the local catalogue. */
  from: string;
  /** What the person says. */
  sentence: string;
  speedMps: number;
  /** Simulated seconds per real second, or "auto": fit the walk into `durationS`. */
  timeScale: number | "auto";
  /** Target length of the whole demo in seconds, used by "auto". */
  durationS: number;
  /** People who must have seen an obstacle before it closes a pavement: the reporter plus the confirmations the server asks for. */
  witnessesNeeded: number;
  /** The decision point of a placed obstacle is at least this far ahead when the route changes. */
  minDecisionAheadM: number;
  /** Seconds the presenter is expected to need between the first report and the last confirmation. */
  confirmLeadS: number;
  minExtraM: number;
  maxExtraM: number;
  targetExtraM: number;
  category: string;
  obstacleText: string;
}

export interface TheatreLoop {
  start: PlaceInfo;
  destination: PlaceInfo;
  crossing: { id: string; position: LngLat; edgeIds: string[]; open: boolean };
  obstacle: { edgeId: string; position: LngLat };
  walkerProgressM: number;
}
export interface VenueCard {
  name: string;
  facts: { key: string; entranceId: string | null; question: string; value: string | null; source: string }[];
}

export interface PlaceInfo {
  id: string | null;
  name: string;
  lng: number;
  lat: number;
  address?: string | null;
  kind?: string;
  nodeId?: string;
  entranceVerified?: boolean;
}

export interface DestinationInfo extends PlaceInfo {
  /** How it was understood: a server step, or the local catalogue. */
  how: string;
  /** True when it did not come from the server. */
  local: boolean;
  hospital: boolean;
}

export interface WalkerView {
  distanceM: number;
  remainingM: number;
  position: LngLat;
  bearing: number;
  arrived: boolean;
  street: string | null;
}

export interface TrackedObstacle {
  obstacle: Obstacle;
  /** Report id on the server ("req-1001"), when the obstacle is a citizen report. */
  reportId: string | null;
  /** People who have seen it so far, as far as this screen knows. */
  witnesses: number;
  needed: number;
  /** True when it closes its edge for routing. */
  closes: boolean;
  /** A citizen report (confirmation rule applies), as opposed to works and other sources. */
  report: boolean;
  /** Created from this demo (stage key or phone button). */
  createdHere: boolean;
  /** Exists only in this browser: the server could not be reached. */
  local: boolean;
}

export interface Caption {
  id: number;
  text: string;
  kind: "instruction" | "obstacle" | "info";
  /** Words revealed so far. 0 until the voice starts. */
  revealed: number;
  /** False when no Greek voice spoke and the words were timed. */
  voiced: boolean;
  done: boolean;
}

export interface InstructionView {
  title: string;
  distance: string | null;
  direction: TurnDirection | "arrive" | "crossing" | null;
}

export type Beat = "warn" | "dark" | "mend";

export interface MomentView {
  id: number;
  beat: Beat;
  /** A replay of a change that already happened: never shown as live. */
  replay: boolean;
}

export interface RouteChange {
  id: number;
  kind: "reroute" | "turn_back" | "restored";
  /** The part of the old route that is no longer walked. */
  abandoned: LngLat[];
  /** The new part, from where it leaves the old route. */
  fresh: LngLat[];
  /** Metres along the current route where the new part begins. */
  divergeAtM: number;
  /** What the person does there. null when there is no turn to make. */
  turn: TurnDirection | null;
  obstacleId: string | null;
}

export interface Metrics {
  /** Seconds from the call (or server event) that closed the pavement to the new route. */
  reportToRouteS: number;
  measuredFrom: "request" | "event" | "local";
  /** Metres between the walker and the turn when the voice began to speak. null until it does. */
  warningM: number | null;
  /** Metres to the turn when the route was computed. */
  decisionAheadM: number;
  extraM: number;
  oldLengthM: number;
  newLengthM: number;
}

export interface Toast {
  id: number;
  text: string;
  tone: "ok" | "error" | "local";
  at: number;
}

export interface ScenarioState {
  profile: import("@ion/core").ProfileId;
  loop: TheatreLoop | null;
  citizen: "live" | "scripted";
  loopFallback: boolean;
  injected: boolean;
  waiting: boolean;
  crossingNotice: string;
  card: VenueCard | null;
  closing: boolean;
  rev: number;
  ready: boolean;
  phase: Phase;
  config: ScenarioConfig;
  connection: "unknown" | "online" | "offline";
  /** Something on screen was simulated in this browser because the server did not answer. */
  localFallback: boolean;
  start: PlaceInfo | null;
  request: string;
  destination: DestinationInfo | null;
  route: Route | null;
  walker: WalkerView | null;
  timeScale: number;
  paused: boolean;
  obstacles: TrackedObstacle[];
  focusObstacleId: string | null;
  caption: Caption | null;
  instruction: InstructionView | null;
  moment: MomentView | null;
  change: RouteChange | null;
  metrics: Metrics | null;
  toasts: Toast[];
  signal: { id: number; value: Signal } | null;
  /** The last thing that happened, as a sentence for a live region. */
  notice: string;
  speech: "unknown" | "voice" | "timed";
  busy: boolean;
}

export type Command =
  | { type: "chooseProfile"; profile: import("@ion/core").ProfileId }
  | { type: "advance" }
  | { type: "setDestination"; text: string }
  | { type: "clearDestination" }
  | { type: "start" }
  | { type: "report"; at: "ahead" | "walker" }
  | { type: "confirm" }
  | { type: "resolve" }
  | { type: "reset" }
  | { type: "pause" }
  | { type: "replay" };

export type Effect =
  | { type: "earcon"; name: "start" | "instruction" | "obstacle" | "new_route" | "arrival" }
  | { type: "turn_sound"; toRight: boolean }
  | { type: "walking"; on: boolean };

/** Server events as they arrive on /api/events. */
export type ServerEvent =
  | { type: "snapshot"; obstacles: Obstacle[]; stale?: boolean }
  | { type: "obstacle_added" | "obstacle_changed" | "obstacle_removed"; obstacle: Obstacle }
  | { type: "mission_answered"; missionId: string; answers: { yes: number; no: number } }
  | { type: "map_updated" };
