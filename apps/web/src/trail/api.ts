import type { Segment } from "./segments";
import { checkpointSentence, sideFromNote } from "./describe";

export interface ServerSegment { steps: number; metres: number; turn: Segment["turn"]; note?: string }
export interface TrailRecord { id: string; start: string; target: string; segments: Segment[]; confirmed?: boolean; local?: boolean }
export type SaveResult = { where: "server"; id: string } | { where: "phone"; id: string };

const participantKey = "ion-participant";
const localKey = "ion-trails-local";

function safe<T>(action: () => T, fallback: T): T { try { return action(); } catch { return fallback; } }

/** Same id as the missions screen: it is stored under the same key. */
export function participantId() {
  const previous = safe(() => localStorage.getItem(participantKey), null);
  if (previous) return previous;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  safe(() => localStorage.setItem(participantKey, id), undefined);
  return id;
}

/** The server holds a note and not a side: the checkpoint travels as a sentence in the note and is read back from it. */
export function toServerSegments(segments: readonly Segment[], target: string): ServerSegment[] {
  return segments.map(s => {
    const note = [s.note, s.checkpoint ? checkpointSentence(target, s.checkpoint) : ""].filter(Boolean).join(". ").slice(0, 180);
    const out: ServerSegment = { steps: s.steps, metres: s.metres, turn: s.turn };
    if (note) out.note = note;
    return out;
  });
}

export function fromServerSegments(segments: readonly ServerSegment[]): Segment[] {
  return segments.map(s => {
    const checkpoint = sideFromNote(s.note);
    const out: Segment = { steps: s.steps, metres: s.metres, turn: s.turn };
    if (s.note) out.note = s.note;
    if (checkpoint) out.checkpoint = checkpoint;
    return out;
  });
}

export const saveBody = (start: string, target: string, segments: readonly Segment[]) =>
  ({ participant: participantId(), start, target, segments: toServerSegments(segments, target) });
export const confirmBody = () => ({ participant: participantId() });

function readLocal(venue: string): TrailRecord[] {
  return safe(() => (JSON.parse(localStorage.getItem(`${localKey}:${venue}`) ?? "[]") as TrailRecord[]), []);
}
function writeLocal(venue: string, trails: TrailRecord[]) {
  safe(() => localStorage.setItem(`${localKey}:${venue}`, JSON.stringify(trails)), undefined);
}

async function post(path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch("/api" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return null;
  }
}
async function problem(response: Response) {
  const data = await response.json().catch(() => null);
  return new Error(data?.error?.message ?? `HTTP ${response.status}`);
}

/** POST /api/venues/:id/trails. When the server does not know the route (404) or does not answer, the trail stays on this phone. */
export async function saveTrail(venue: string, start: string, target: string, segments: Segment[]): Promise<SaveResult> {
  const response = await post(`/venues/${encodeURIComponent(venue)}/trails`, saveBody(start, target, segments));
  if (response?.ok) return { where: "server", id: ((await response.json()) as { id: string }).id };
  if (response && response.status !== 404) throw await problem(response);
  const id = "local-" + Date.now().toString(36);
  writeLocal(venue, [...readLocal(venue), { id, start, target, segments, local: true }]);
  return { where: "phone", id };
}

/** POST /api/venues/:id/trails/:trailId/confirm. */
export async function confirmTrail(venue: string, trailId: string): Promise<"server" | "phone"> {
  if (trailId.startsWith("local-")) {
    writeLocal(venue, readLocal(venue).map(t => t.id === trailId ? { ...t, confirmed: true } : t));
    return "phone";
  }
  const response = await post(`/venues/${encodeURIComponent(venue)}/trails/${encodeURIComponent(trailId)}/confirm`, confirmBody());
  if (response?.ok) return "server";
  if (response && response.status !== 404) throw await problem(response);
  return "phone";
}

/** The trails of a venue to confirm: those on the server card, then those kept on this phone. */
export async function loadTrails(venue: string): Promise<TrailRecord[]> {
  let remote: TrailRecord[] = [];
  try {
    const response = await fetch(`/api/venues/${encodeURIComponent(venue)}`);
    if (response.ok) {
      const card = (await response.json()) as { trails?: { id: string; start: string; target: string; segments?: ServerSegment[]; confirmed?: boolean }[] };
      remote = (card.trails ?? []).filter(t => Array.isArray(t.segments)).map(t => ({ id: t.id, start: t.start, target: t.target, confirmed: t.confirmed, segments: fromServerSegments(t.segments!) }));
    }
  } catch { /* the server is not there: only local trails */ }
  return [...remote, ...readLocal(venue)];
}

export function stepLengthStored(): number | undefined {
  const value = Number(safe(() => localStorage.getItem("ion-trail-step-length"), null));
  return value >= 0.3 && value <= 1.2 ? value : undefined;
}
export function storeStepLength(length: number) {
  safe(() => localStorage.setItem("ion-trail-step-length", String(length)), undefined);
}
