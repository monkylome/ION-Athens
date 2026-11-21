/**
 * The rules of the game as the screen needs them, with no browser in it.
 * The server decides points, levels, confirmations and rewards; this module
 * only reads what it answers and turns it into sentences and arithmetic.
 * Nothing here assumes a list of mission types: an unknown type is shown
 * through its own question.
 */
import type { LngLat } from "@ion/core";
import { bearingDeg, compassWords, distanceM, distanceWords, directionWords, inReach, SERVER_REACH_M } from "./geo";

export type Answer = "yes" | "no" | "unsure";
export const ANSWER_LABELS: Record<Answer, string> = { yes: "Ναι", no: "Όχι", unsure: "Δεν είμαι σίγουρος" };

export interface Mission {
  id: string;
  type: string;
  question: string;
  position: LngLat;
  where?: string;
  points: number;
  answers: { yes: number; no: number };
  distanceM?: number;
  /** The neighbourhood, when the server names it. */
  area?: string;
  /** For a question about a place (a theatre, a library): the place and the fact it fills in. */
  venueId?: string;
  key?: string;
}
export interface Board {
  summary: { open: number; confirmed: number; byType?: Record<string, number> };
  missions: Mission[];
}
export interface Profile {
  points: number;
  answers: number;
  confirmed: number;
  level: string;
  nextLevel: { name: string; pointsNeeded: number } | null;
}
export interface Reward {
  id: string;
  title: string;
  partner: string;
  category?: string;
  pointsRequired: number;
  unlocked: boolean;
  municipal?: boolean;
  /** Set when the server lowered the threshold for a rehearsal: the real one. Shown, so nothing simulated looks live. */
  standardPointsRequired?: number;
}
export interface Rewards {
  note: string;
  fictional?: boolean;
  points: number;
  rewards: Reward[];
}
export interface Observation {
  missionId: string;
  type: string;
  where?: string;
  value: "yes" | "no";
  confirmedBy?: number;
}
export interface AnswerResult {
  mission: Mission;
  pointsEarned: number;
  confirmed: Observation | null;
  profile: Profile;
}

/** A mission as the player meets it: how far, which way, and whether it can be answered now. */
export interface Nearby {
  mission: Mission;
  distance: number;
  bearing: number;
  reachable: boolean;
}

export function nearby(missions: readonly Mission[], from: LngLat, accuracyM?: number): Nearby[] {
  return missions
    .map((mission) => {
      const distance = distanceM(from, mission.position);
      // A place is a building and its point is the middle of it: someone inside can be 50 m from that point.
      // So a place is answerable out to the server's own limit; everything else from inside the 30 m ring.
      const reachable = mission.venueId ? distance <= SERVER_REACH_M : inReach(distance, accuracyM);
      return { mission, distance, bearing: bearingDeg(from, mission.position), reachable };
    })
    .sort((a, b) => a.distance - b.distance);
}

/** Several questions can belong to one spot (a venue, a crossing). On the board they are one plate. */
export interface Place {
  key: string;
  at: LngLat;
  /** Every mission here, the player's unanswered ones first. */
  items: Nearby[];
  /** How many the player can still answer. */
  open: number;
  /** The mission the plate opens: the first unanswered one, or the first. */
  first: Nearby;
  distance: number;
  bearing: number;
  reachable: boolean;
}

/** Spots closer together than this share a plate: two plates on top of each other cannot be read or tapped. */
export const MERGE_M = 22;

export function places(list: readonly Nearby[], answered: ReadonlySet<string> = new Set(), mergeM = MERGE_M): Place[] {
  const groups: { at: LngLat; members: Nearby[] }[] = [];
  for (const n of [...list].sort((a, b) => a.distance - b.distance)) {
    // A place keeps its own object; street objects a few metres apart share one.
    const group = groups.find((g) => g.members[0]!.mission.venueId === n.mission.venueId && (n.mission.venueId !== undefined || distanceM(g.at, n.mission.position) <= mergeM));
    if (group) group.members.push(n); else groups.push({ at: n.mission.position, members: [n] });
  }
  return groups.map(({ at, members }) => {
    const pending = members.filter((n) => !answered.has(n.mission.id));
    const items = [...pending, ...members.filter((n) => answered.has(n.mission.id))];
    const first = items[0]!;
    return { key: members[0]!.mission.id, at, items, open: pending.length, first, distance: first.distance, bearing: first.bearing, reachable: first.reachable };
  });
}

/* ---------- what kind of object a mission is ---------- */

/** The glyph family of a mission. Read from the type's name, so a type this screen has never seen still gets one. */
export type Kind = "sound" | "tactile" | "obstacle" | "crowd" | "place" | "other";
export function kindOf(m: Pick<Mission, "type" | "venueId">): Kind {
  if (m.venueId || /venue|place/.test(m.type)) return "place";
  if (/sound|audio/.test(m.type)) return "sound";
  if (/tactile/.test(m.type)) return "tactile";
  if (/obstacle|pavement|sidewalk/.test(m.type)) return "obstacle";
  if (/crowd/.test(m.type)) return "crowd";
  return "other";
}
const TYPE_LABELS: Record<string, string> = {
  crossing_sound: "Ηχητικά φανάρια",
  crossing_tactile: "Οδηγοί όδευσης",
  obstacle_check: "Εμπόδια",
  pavement_check: "Πεζοδρόμια",
  crowd_check: "Κόσμος",
  venue_check: "Χώροι",
};
/** A short name for a type. An unknown type is named by its own question. */
export function typeLabel(type: string, question?: string): string {
  return TYPE_LABELS[type] ?? question ?? type;
}

/* ---------- the album: what this device has stamped ---------- */

export interface StampRecord { id: string; type: string; question: string; where?: string; venueId?: string; confirmed: boolean }
export interface AlbumTile { type: string; label: string; count: number; confirmed: number }

/** One tile per type: the ones stamped with their counts, and an empty slot for each type still to find. */
export function albumTiles(stamps: readonly StampRecord[], knownTypes: readonly string[]): AlbumTile[] {
  const tiles = new Map<string, AlbumTile>();
  for (const type of knownTypes) tiles.set(type, { type, label: typeLabel(type), count: 0, confirmed: 0 });
  for (const s of stamps) {
    const tile = tiles.get(s.type) ?? { type: s.type, label: typeLabel(s.type, s.question), count: 0, confirmed: 0 };
    tile.count++;
    if (s.confirmed) tile.confirmed++;
    tiles.set(s.type, tile);
  }
  return [...tiles.values()].sort((a, b) => Number(b.count > 0) - Number(a.count > 0) || a.label.localeCompare(b.label, "el"));
}
export function addStamp(stamps: readonly StampRecord[], stamp: StampRecord): StampRecord[] {
  return [...stamps.filter((s) => s.id !== stamp.id), stamp];
}

/* ---------- discoveries: what the scan mode finds that nobody had mapped ---------- */

export interface Discovery { id: string; at: LngLat; label: string; participant?: string }

/** `GET /api/vision/status`: is there a model to scan with. Another team's endpoint, read by trying its likely fields. */
export function visionReady(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const o = body as Record<string, unknown>;
  if (o.error) return false;
  return o.configured === true || o.available === true || o.ready === true || o.enabled === true || (typeof o.model === "string" && o.model.length > 0);
}

/** A discovery as the server announces or lists it. Anything without a place and a name is ignored. */
export function readDiscovery(raw: unknown): Discovery | null {
  if (!raw || typeof raw !== "object") return null;
  const outer = raw as Record<string, unknown>;
  const o = (outer.discovery && typeof outer.discovery === "object" ? outer.discovery : outer) as Record<string, unknown>;
  const p = Array.isArray(o.position) ? o.position : Array.isArray(o.at) ? o.at : [o.lng, o.lat];
  const lng = p[0], lat = p[1];
  if (typeof lng !== "number" || typeof lat !== "number" || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const label = [o.label, o.title, o.what, o.name, o.kind, o.type].find((v): v is string => typeof v === "string" && v.length > 0 && v !== "discovery");
  if (!label) return null;
  const id = typeof o.id === "string" || typeof o.id === "number" ? String(o.id) : `${label}@${lng.toFixed(5)},${lat.toFixed(5)}`;
  return { id, at: [lng, lat], label, ...(typeof o.participant === "string" ? { participant: o.participant } : {}) };
}

/* ---------- points, levels, rewards ---------- */

/** The level bar: how far along the current level the player is, 0 to 1. Null on the last level. */
export function levelProgress(profile: Pick<Profile, "points" | "nextLevel">, levelStart = 0): number | null {
  if (!profile.nextLevel) return null;
  const target = profile.points + profile.nextLevel.pointsNeeded;
  const span = target - levelStart;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (profile.points - levelStart) / span));
}

export interface NextReward {
  reward: Reward;
  /** Points still missing. */
  pointsNeeded: number;
  /** 0 to 1 toward this reward. */
  progress: number;
}

/** The reward the header points at: the cheapest one the player has not reached, in the server's own order. */
export function nextReward(rewards: readonly Reward[], points: number): NextReward | null {
  let best: Reward | undefined;
  for (const r of rewards) {
    if (r.pointsRequired <= points) continue;
    if (!best || r.pointsRequired < best.pointsRequired) best = r;
  }
  if (!best) return null;
  return { reward: best, pointsNeeded: best.pointsRequired - points, progress: best.pointsRequired > 0 ? Math.max(0, points) / best.pointsRequired : 1 };
}

/** "32 πόντοι ως: Δωρεάν είσοδος σε περιοδικές εκθέσεις" */
export function nextRewardLine(next: NextReward | null): string {
  if (!next) return "Έχετε ξεκλειδώσει όλα τα προνόμια.";
  return `${pointsWords(next.pointsNeeded)} ως: ${next.reward.title}`;
}

/** Rewards whose threshold lies between the points before an answer and the points after it. */
export function crossed(rewards: readonly Reward[], before: number, after: number): Reward[] {
  return rewards.filter((r) => r.pointsRequired > before && r.pointsRequired <= after);
}

export function pointsWords(n: number): string {
  return n === 1 ? "1 πόντος" : `${n} πόντοι`;
}
/** The same count as an object: "Έχετε 70 πόντους". */
export function pointsObject(n: number): string {
  return n === 1 ? "1 πόντο" : `${n} πόντους`;
}

/* ---------- what the card says after an answer ---------- */

const CHANGES: Record<string, { yes: string; no: string }> = {
  crossing_sound: { yes: "το φανάρι έχει πλέον ηχητικό σήμα στον χάρτη", no: "το φανάρι σημειώθηκε στον χάρτη χωρίς ηχητικό σήμα" },
  crossing_tactile: { yes: "η διάβαση έχει πλέον οδηγό όδευσης τυφλών στον χάρτη", no: "η διάβαση σημειώθηκε στον χάρτη χωρίς οδηγό όδευσης τυφλών" },
  obstacle_check: { yes: "το εμπόδιο επιβεβαιώθηκε και οι διαδρομές το αποφεύγουν", no: "δύο δημότες είπαν ότι το εμπόδιο δεν υπάρχει πια" },
  pavement_check: { yes: "το πεζοδρόμιο σημειώθηκε ελεύθερο στον χάρτη", no: "το πεζοδρόμιο σημειώθηκε στον χάρτη ως μη ελεύθερο" },
  crowd_check: { yes: "σημειώθηκε πολύς κόσμος για την επόμενη ώρα", no: "σημειώθηκε ησυχία για την επόμενη ώρα" },
};

function capital(text: string): string {
  return text.charAt(0).toLocaleUpperCase("el") + text.slice(1);
}

/** What a confirmed answer changed, in one sentence. The street leads, so no article has to agree with its name. */
export function changeSentence(o: Pick<Observation, "type" | "where" | "value">, question?: string): string {
  const known = CHANGES[o.type]?.[o.value];
  if (known) return o.where ? `${o.where}: ${known}.` : `${capital(known)}.`;
  // A type this screen has never seen: say what was asked and what the two answers were.
  const answer = ANSWER_LABELS[o.value];
  const asked = question ? `«${question}» ${answer}. ` : `Η απάντηση είναι «${answer}». `;
  return `${o.where ? `${o.where}: ` : ""}${asked}Είναι πλέον στον χάρτη για όλους.`;
}

export interface Outcome {
  /** One word for the stamp. */
  stamp: string;
  confirmed: boolean;
  /** The server's result in a sentence. */
  line: string;
  /** What changed on the map, when something did. */
  change: string | null;
}

export function outcome(result: Pick<AnswerResult, "confirmed" | "mission">, given: Answer): Outcome {
  if (result.confirmed) {
    return {
      stamp: "Επιβεβαιώθηκε",
      confirmed: true,
      line: "Επιβεβαιώθηκε. Ο χάρτης άλλαξε για όλους.",
      change: changeSentence(result.confirmed, result.mission.question),
    };
  }
  if (given === "unsure") {
    return { stamp: "Καταγράφηκε", confirmed: false, line: "Η απάντησή σας καταγράφηκε. Η αποστολή μένει ανοιχτή για τον επόμενο δημότη.", change: null };
  }
  return { stamp: "Καταγράφηκε", confirmed: false, line: "Η απάντησή σας καταγράφηκε. Χρειάζεται ένας ακόμα δημότης.", change: null };
}

/** A refusal, plain and kind. The server's own Greek sentence is kept when there is no better one. */
export function refusal(code: string | undefined, serverMessage: string | undefined, distance?: number): string {
  switch (code) {
    case "too_far":
      return distance !== undefined
        ? `Είστε ακόμα λίγο μακριά: περίπου ${Math.round(distance)} μέτρα. Πλησιάστε στο σημείο και δοκιμάστε ξανά.`
        : "Είστε ακόμα λίγο μακριά. Πλησιάστε στο σημείο και δοκιμάστε ξανά.";
    case "already_answered":
      return "Έχετε ήδη απαντήσει εδώ. Ευχαριστούμε. Τώρα χρειάζεται ένας ακόμα δημότης.";
    case "daily_limit":
      return "Φτάσατε το όριο αποστολών για σήμερα. Ευχαριστούμε για τη βοήθεια.";
    case "closed":
      return "Αυτή η αποστολή μόλις ολοκληρώθηκε από άλλους δημότες. Ο χάρτης έχει ήδη την απάντηση.";
    case "not_found":
      return "Αυτή η αποστολή δεν υπάρχει πια. Διαλέξτε μια άλλη κοντά σας.";
    default:
      return serverMessage && /[Α-ωά-ώ]/.test(serverMessage) ? serverMessage : "Η απάντηση δεν καταχωρίστηκε. Δοκιμάστε ξανά σε λίγο.";
  }
}

/* ---------- a place and its card ---------- */

export interface VenueFact { key: string; question: string; value?: unknown; source?: string | null }
export interface Venue { id: string; name: string; address?: string | null; facts: VenueFact[] }

/** A fact is known once the server holds a value for it. Every fact of a new place starts unknown. */
export function factKnown(f: VenueFact): boolean {
  return f.value !== null && f.value !== undefined && f.source !== "unknown";
}
export function factWords(f: VenueFact): string {
  if (!factKnown(f)) return "άγνωστο ακόμα";
  if (f.value === true || f.value === "yes") return "Ναι";
  if (f.value === false || f.value === "no") return "Όχι";
  if (f.value === "limited") return "Εν μέρει";
  return String(f.value);
}
export function venueProgress(v: Pick<Venue, "facts">): { known: number; total: number } {
  return { known: v.facts.filter(factKnown).length, total: v.facts.length };
}
/** "Ολύμπια: 0 από 7 στοιχεία". The short name is what stands before the first comma. */
export function venueLine(v: Pick<Venue, "name" | "facts">): string {
  const { known, total } = venueProgress(v);
  return `${v.name.split(",")[0]!.trim()}: ${known} από ${total} στοιχεία`;
}

/* ---------- outside the mapped area ---------- */

/** The player stands where nothing is mapped yet: say so, and say where the nearest mission is. */
export function outsideLine(nearest: Pick<Nearby, "distance" | "bearing"> | null, accuracyM?: number): string {
  const lead = "Εδώ δεν έχει χαρτογραφηθεί ακόμα τίποτα.";
  if (!nearest) return lead;
  return `${lead} Η κοντινότερη αποστολή είναι ${distanceWords(nearest.distance, accuracyM)} προς τα ${compassWords(nearest.bearing)}.`;
}

/* ---------- the same board in words ---------- */

/** One mission as a spoken line: what, where, how far and which way, what to do. */
export function missionLine(n: Nearby, heading: number | null, accuracyM?: number): string {
  const far = distanceWords(n.distance, accuracyM);
  const way = directionWords(n.bearing, heading);
  const place = far === "κοντά" ? `κοντά σας, ${way}` : `${far} ${way}`;
  const spot = capital(n.mission.where ? `${n.mission.where}, ${place}` : place);
  return `${n.mission.question} ${spot}. ${pointsWords(n.mission.points)}.${n.reachable ? " Μπορείτε να απαντήσετε τώρα." : ""}`;
}

/** What "Πείτε μου τι υπάρχει κοντά" says: the nearest missions, nearest first. */
export function describeNearby(list: readonly Nearby[], heading: number | null, accuracyM?: number, count = 3): string {
  if (list.length === 0) return "Δεν υπάρχουν ανοιχτές αποστολές κοντά σας. Περπατήστε λίγο και ρωτήστε ξανά.";
  const reachable = list.filter((n) => n.reachable).length;
  const shown = list.slice(0, count);
  const lead = list.length === 1 ? "Μία αποστολή κοντά σας." : `${list.length} αποστολές κοντά σας.`;
  const reach = reachable === 0 ? "Καμία δεν είναι ακόμα στην εμβέλειά σας." : reachable === 1 ? "Μία είναι στην εμβέλειά σας." : `${reachable} είναι στην εμβέλειά σας.`;
  const ordinals = ["Πρώτη", "Δεύτερη", "Τρίτη", "Τέταρτη", "Πέμπτη"];
  const lines = shown.map((n, i) => `${shown.length > 1 ? `${ordinals[i] ?? `${i + 1}η`}: ` : ""}${missionLine(n, heading, accuracyM)}`);
  return [lead, reach, ...lines].join(" ");
}

/** A spoken answer, for people who answer by voice. Null when the words are none of the three. */
export function parseSpokenAnswer(heard: string): Answer | null {
  const text = heard.toLocaleLowerCase("el").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.,;!·]/g, " ");
  if (/δεν\s+(ειμαι\s+)?(σιγουρ|ξερω)|δεν\s+γνωριζω|αγνωστο|ισως/.test(text)) return "unsure";
  if (/(^|\s)(ναι|μαλιστα|βεβαια|σωστα|yes)(\s|$)/.test(text)) return "yes";
  if (/(^|\s)(οχι|no)(\s|$)/.test(text)) return "no";
  return null;
}

/* ---------- neighbourhood progress, when the server has it ---------- */

export interface Neighbourhood {
  name: string;
  done: number;
  total: number;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads whatever `GET /api/neighbourhoods` answers. The endpoint is being
 * written by someone else, so the field names are tried rather than assumed,
 * and anything that does not look like a name with a count is ignored.
 */
export function readNeighbourhood(body: unknown, at?: LngLat, area?: string): Neighbourhood | null {
  const root = body as Record<string, unknown> | unknown[] | null;
  if (!root || typeof root !== "object") return null;
  const single = !Array.isArray(root) && (root.current ?? root.neighbourhood);
  const list: unknown[] = single && typeof single === "object" ? [single]
    : Array.isArray(root) ? root
    : Array.isArray(root.neighbourhoods) ? root.neighbourhoods
    : Array.isArray(root.items) ? root.items : [];
  const parsed = list.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : typeof o.title === "string" ? o.title : null;
    if (!name) return [];
    const total = num(o.total) ?? num(o.missions) ?? num(o.places);
    const open = num(o.open) ?? num(o.remaining);
    let done = num(o.confirmed) ?? num(o.done) ?? num(o.mapped) ?? num(o.completed) ?? (total !== undefined && open !== undefined ? total - open : undefined);
    const share = num(o.progress) ?? num(o.share) ?? (num(o.percent) !== undefined ? num(o.percent)! / 100 : undefined);
    let count = total ?? (done !== undefined && open !== undefined ? done + open : undefined);
    if (count === undefined && share !== undefined) { count = 100; done = Math.round(Math.min(1, share > 1 ? share / 100 : share) * 100); }
    if (count === undefined || done === undefined || count <= 0) return [];
    const centre = Array.isArray(o.center) ? o.center : Array.isArray(o.centre) ? o.centre : Array.isArray(o.position) ? o.position : null;
    const here = o.current === true || o.inside === true || o.here === true || (area !== undefined && name === area);
    const far = at && centre && typeof centre[0] === "number" && typeof centre[1] === "number" ? distanceM(at, [centre[0], centre[1]]) : Infinity;
    return [{ name, done: Math.max(0, Math.min(count, done)), total: count, here, far }];
  });
  if (parsed.length === 0) return null;
  // With several neighbourhoods and nothing saying which one the player is in, none is claimed.
  const nearest = [...parsed].sort((a, b) => a.far - b.far)[0]!;
  const pick = parsed.find((p) => p.here) ?? (parsed.length === 1 || nearest.far < Infinity ? nearest : null);
  if (!pick) return null;
  return { name: pick.name, done: pick.done, total: pick.total };
}

export function neighbourhoodLine(n: Neighbourhood): string {
  return `${n.name}: ${n.done} από ${n.total} σημεία στον χάρτη`;
}
