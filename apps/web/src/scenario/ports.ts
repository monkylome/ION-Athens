/** What the scenario engine needs from the outside. Tests pass fakes. */
import type { Obstacle, Route } from "@ion/core";

export interface ApiResult<T> {
  ok: boolean;
  /** HTTP status, or 0 when no answer came back. */
  status: number;
  data: T | null;
  /** True when the server could not be reached at all (network error, or the dev proxy answering for a dead server). */
  unreachable: boolean;
  method: "GET" | "POST";
  path: string;
  message?: string;
  code?: string;
}

export interface ServerPlace {
  id: string | null;
  name: string;
  lng: number;
  lat: number;
  address?: string | null;
  category?: string;
  kind?: string;
}

export type DestinationResponse = { sandbox?: boolean; speech: string; how?: string } & (
  | { understood: true; place: ServerPlace; confidence: number }
  | { understood: false; reason: string }
);

export interface RouteResponse {
  sandbox?: boolean;
  engine?: string;
  route: Route;
  rerouted?: boolean;
  arrival?: { speech: string };
}

export interface ReportResponse {
  sandbox?: boolean;
  demo?: boolean;
  report: { id: string; upvotes?: number; status?: string };
  obstacle: Obstacle | null;
  notAnObstacle?: { reason: string };
}

export interface SourceInfo {
  id: string;
  name: string;
  owner: string;
  kind?: string;
  data?: string;
  permission?: string;
  answering?: boolean;
  records?: number;
  lastFetched?: string | null;
  stale?: boolean;
}

type Point = { lng: number; lat: number };

export interface ApiPort {
  venue?(id: string): Promise<ApiResult<import("./types").VenueCard>>;
  destination(text: string, location?: Point): Promise<ApiResult<DestinationResponse>>;
  route(from: Point, to: Point, profile: import("@ion/core").ProfileId): Promise<ApiResult<RouteResponse>>;
  report(input: Point & { category?: string; text?: string }): Promise<ApiResult<ReportResponse>>;
  demoConfirm?(reportId: string): Promise<ApiResult<ReportResponse>>;
  confirm(reportId: string): Promise<ApiResult<ReportResponse>>;
  resolve(reportId: string): Promise<ApiResult<ReportResponse>>;
  reset(): Promise<ApiResult<{ reset: boolean; sandbox?: boolean; demo?: boolean }>>;
}

export interface Utterance {
  text: string;
  /** Cancels whatever is being said. */
  urgent?: boolean;
  /** Wait this long before speaking: an earcon has just been played and comes first. */
  leadMs?: number;
  /** The voice (or the caption timer) began. `voiced` is false when no Greek voice spoke. */
  onStart?: (info: { voiced: boolean }) => void;
  /** Word `index` (0-based) is being said. */
  onWord?: (index: number) => void;
  onEnd?: () => void;
}

export interface VoicePort {
  say(utterance: Utterance): void;
  cancel(): void;
}
