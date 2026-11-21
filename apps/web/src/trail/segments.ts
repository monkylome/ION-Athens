import { classifyAngle, type TurnEvent, type TurnKind } from "./turns";

export type Side = "left" | "right" | "ahead";
export interface Segment { steps: number; metres: number; turn: TurnKind; note?: string; checkpoint?: Side }
export interface TimedCheckpoint { t: number; side: Side }
export interface TimedNote { t: number; text: string }
export const defaultStepLength = 0.7;

interface Draft { steps: number; angle: number; notes: string[]; checkpoint?: Side }

/**
 * Cuts the walk into straight segments at every turn. A segment is the straight walk that follows the turn
 * before it, so the first segment is always "straight". Segments of fewer than `minSteps` steps are merged:
 * into the previous one, or into the next one when they open the trail. The rotations are added up, so
 * two small wobbles cannot hide a real turn and a small net rotation disappears.
 */
export function buildSegments(
  input: { stepTimes: readonly number[]; turns: readonly TurnEvent[]; notes?: readonly TimedNote[]; checkpoints?: readonly TimedCheckpoint[] },
  options: { stepLength?: number; minSteps?: number } = {},
): Segment[] {
  const stepLength = options.stepLength ?? defaultStepLength;
  const minSteps = options.minSteps ?? 2;
  const turns = [...input.turns].sort((a, b) => a.t - b.t);
  const drafts: Draft[] = [{ steps: 0, angle: 0, notes: [] }, ...turns.map(turn => ({ steps: 0, angle: turn.angle, notes: [] as string[] }))];
  const indexAt = (t: number) => turns.filter(turn => turn.t <= t).length;
  for (const t of input.stepTimes) drafts[indexAt(t)]!.steps++;
  for (const note of input.notes ?? []) if (note.text.trim()) drafts[indexAt(note.t)]!.notes.push(note.text.trim());

  for (const c of input.checkpoints ?? []) drafts[indexAt(c.t)]!.checkpoint = c.side;

  const joinNotes = (a: string[], b: string[]) => [...a, ...b];
  for (;;) {
    const tiny = drafts.findIndex(d => drafts.length > 1 && d.steps < minSteps);
    if (tiny === -1) break;
    if (tiny === 0) {
      const next = drafts[1]!;
      next.steps += drafts[0]!.steps;
      next.notes = joinNotes(drafts[0]!.notes, next.notes);
      next.angle = 0;
      next.checkpoint ??= drafts[0]!.checkpoint;
      drafts.shift();
    } else {
      const previous = drafts[tiny - 1]!;
      previous.steps += drafts[tiny]!.steps;
      previous.notes = joinNotes(previous.notes, drafts[tiny]!.notes);
      previous.checkpoint = drafts[tiny]!.checkpoint ?? previous.checkpoint;
      const following = drafts[tiny + 1];
      if (following) following.angle += drafts[tiny]!.angle;
      drafts.splice(tiny, 1);
    }
  }
  // A net rotation below 45 degrees is no turn: the walk simply goes on.
  for (let i = drafts.length - 1; i > 0; i--) {
    if (classifyAngle(drafts[i]!.angle) !== "straight") continue;
    drafts[i - 1]!.steps += drafts[i]!.steps;
    drafts[i - 1]!.notes = joinNotes(drafts[i - 1]!.notes, drafts[i]!.notes);
    drafts[i - 1]!.checkpoint = drafts[i]!.checkpoint ?? drafts[i - 1]!.checkpoint;
    drafts.splice(i, 1);
  }
  return drafts.map((d, i): Segment => {
    const segment: Segment = { steps: d.steps, metres: Math.round(d.steps * stepLength), turn: i === 0 ? "straight" : classifyAngle(d.angle) };
    if (d.notes.length) segment.note = d.notes.join(", ");
    if (d.checkpoint) segment.checkpoint = d.checkpoint;
    return segment;
  });
}

export function metresFor(steps: number, stepLength: number) { return Math.round(steps * stepLength); }
