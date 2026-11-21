/** The scan screen's rules that need no browser: sizes, counters, sentences, and when the walking scan must stop. */

export const FRAME_MAX_SIDE = 1024;
export const FRAME_QUALITY = 0.7;
/** The walking scan sends a frame this often at most. */
export const WALK_INTERVAL_MS = 10_000;
export const WALK_LIMIT_MS = 120_000;
/** A frame is worth sending only after the person moved or turned. */
export const WALK_MIN_MOVE_M = 3;
export const WALK_MIN_TURN_DEG = 25;

export type Kind =
  | "steps" | "ramp" | "sidewalk_obstacle" | "narrow_sidewalk" | "tactile_paving" | "crossing_signals"
  | "crossing_no_signals" | "entrance_step_free" | "entrance_with_steps" | "lift" | "sign_text" | "clear_path";

export interface Proposal {
  kind: Kind;
  label: string;
  confidence: "high" | "medium" | "low";
  evidence: string;
  text?: string;
  discovery: boolean;
  mission?: { id: string; question: string; answer: "yes" | "no" };
}
export interface ConfirmResult {
  kind: Kind;
  label: string;
  discovery: boolean;
  pointsEarned: number;
  profile: { points: number; level: string };
  confirmed: unknown;
  needsSecond: boolean;
}

/** Longest side at most `max`, never enlarged. */
export function fitSize(width: number, height: number, max = FRAME_MAX_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest === 0) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export const CONFIDENCE_WORD: Record<Proposal["confidence"], string> = { high: "Σίγουρο", medium: "Μάλλον", low: "Ίσως" };

/** «Το μοντέλο πρότεινε 7, επιβεβαιώσατε 5» */
export function counterText(proposed: number, confirmed: number): string {
  return `Το μοντέλο πρότεινε ${proposed}, επιβεβαιώσατε ${confirmed}`;
}

/** What happened, in the map's own terms. */
export function confirmText(r: Pick<ConfirmResult, "needsSecond" | "discovery" | "pointsEarned">): string {
  const state = r.needsSecond ? "Καταγράφηκε. Χρειάζεται ένας ακόμα δημότης." : "Επιβεβαιώθηκε. Ο χάρτης άλλαξε για όλους.";
  return `${state} ${pointsText(r.pointsEarned)}`.trim();
}
export function pointsText(points: number): string {
  return points > 0 ? `${points} πόντοι.` : "";
}

export const DISCOVERY_LINE = "Βρήκατε κάτι που δεν είχε χαρτογραφηθεί";
export const NOTICE_OFF = "Η εικόνα αναλύεται και δεν αποθηκεύεται. Αποφασίζετε εσείς τι μπαίνει στον χάρτη.";
export const NOTICE_ON = "Η φωτογραφία αυτή θα κρατηθεί στον διακομιστή αυτής της επίδειξης για ανάλυση. Μπορεί να δείχνει περαστικούς.";
export const notice = (donate: boolean) => (donate ? NOTICE_ON : NOTICE_OFF);

/** Distance in metres between two points, close enough for a movement gate. */
export function metresBetween(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const dx = (b.lng - a.lng) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const dy = (b.lat - a.lat) * 110_540;
  return Math.hypot(dx, dy);
}
export function turnedDeg(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return 0;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Has the person moved or turned enough since the last frame to send another. */
export function movedEnough(last: { lng: number; lat: number; heading?: number } | null, now: { lng: number; lat: number; heading?: number }): boolean {
  if (!last) return true;
  return metresBetween(last, now) >= WALK_MIN_MOVE_M || turnedDeg(last.heading, now.heading) >= WALK_MIN_TURN_DEG;
}

export type StopReason = "time" | "hidden" | "slow";
/** Why the walking scan must stop now, or null. */
export function walkStop(s: { startedAt: number; now: number; hidden: boolean; lastLatencyMs: number | null }): StopReason | null {
  if (s.hidden) return "hidden";
  if (s.now - s.startedAt >= WALK_LIMIT_MS) return "time";
  if (s.lastLatencyMs !== null && s.lastLatencyMs > WALK_INTERVAL_MS) return "slow";
  return null;
}
export const STOP_TEXT: Record<StopReason, string> = {
  time: "Η σάρωση καθώς περπατάτε σταμάτησε μετά από δύο λεπτά.",
  hidden: "Η σάρωση καθώς περπατάτε σταμάτησε, γιατί η σελίδα δεν φαίνεται.",
  slow: "Η σάρωση καθώς περπατάτε σταμάτησε, γιατί το μοντέλο αργεί περισσότερο από το διάστημα ανάμεσα στις φωτογραφίες.",
};
