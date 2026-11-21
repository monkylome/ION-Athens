import type { Segment } from "./segments";

export interface Difference { segment: number; reason: string }
export interface Comparison { ok: boolean; differences: Difference[]; message: string }

const turnName = { left: "αριστερά", right: "δεξιά", straight: "ευθεία", back: "μεταβολή" } as const;
const sideName = { left: "αριστερά", right: "δεξιά", ahead: "μπροστά" } as const;

/** Allowed difference between two walkers' step counts for one segment: the larger of 2 steps and 15 %. */
export function stepTolerance(reference: number) { return Math.max(2, Math.ceil(reference * 0.15)); }

/**
 * A second citizen's walk confirms a trail only if the turns are the same in the same order, the checkpoint is on the
 * same side in the same segment, and each segment differs by at most max(2 steps, 15 %). Segment numbers are from 1.
 * With `compareMetres` (both walkers calibrated) the metres are compared with the same rule instead of the steps.
 */
export function compareTrails(reference: readonly Segment[], walked: readonly Segment[], options: { compareMetres?: boolean } = {}): Comparison {
  const differences: Difference[] = [];
  if (reference.length !== walked.length) {
    differences.push({ segment: Math.min(reference.length, walked.length) + 1, reason: `η διαδρομή έχει ${walked.length} τμήματα αντί για ${reference.length}` });
  }
  for (let i = 0; i < Math.min(reference.length, walked.length); i++) {
    const a = reference[i]!, b = walked[i]!;
    if (a.turn !== b.turn) {
      differences.push({ segment: i + 1, reason: `στροφή ${turnName[b.turn]} αντί για ${turnName[a.turn]}` });
      continue;
    }
    if (a.checkpoint !== b.checkpoint) {
      differences.push({ segment: i + 1, reason: a.checkpoint && b.checkpoint ? `το σημείο είναι ${sideName[b.checkpoint]} αντί για ${sideName[a.checkpoint]}` : a.checkpoint ? "λείπει το σημείο" : "το σημείο βρίσκεται εδώ και όχι αλλού" });
      continue;
    }
    const x = options.compareMetres ? a.metres : a.steps;
    const y = options.compareMetres ? b.metres : b.steps;
    if (Math.abs(x - y) > stepTolerance(Math.max(x, y))) {
      const unit = options.compareMetres ? "μέτρα" : "βήματα";
      differences.push({ segment: i + 1, reason: `${y} ${unit} αντί για ${x}` });
    }
  }
  const ok = differences.length === 0;
  const message = ok ? "Η διαδρομή ταιριάζει." : differences.map(d => `Τμήμα ${d.segment}: ${d.reason}.`).join(" ");
  return { ok, differences, message };
}
