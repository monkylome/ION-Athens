/**
 * Sound and vibration: the joy of this game is weight, not colour.
 * ZzFX synthesises every sound on the phone (no audio files, nothing fetched).
 * Three vibration patterns, each with a sound and a visible change beside it:
 * haptics are never the only channel.
 *
 * ZzFX opens its AudioContext when the module loads, so it is imported only
 * from `unlock()`, which runs inside the Start tap.
 */
type Zzfx = typeof import("zzfx");
let engine: Zzfx | null = null;
let loading: Promise<void> | null = null;
let muted = false;

export function unlock(): Promise<void> {
  loading ??= import("zzfx").then((module) => {
    engine = module;
    module.ZZFX.volume = 0.45;
    return module.ZZFX.audioContext.resume();
  }).catch(() => undefined);
  void engine?.ZZFX.audioContext.resume().catch(() => undefined);
  return loading;
}
export function setMuted(value: boolean): void { muted = value; }

function play(...parameters: (number | undefined)[]): void {
  if (muted || !engine) return;
  try { engine.zzfx(...parameters); } catch { /* a sound is never worth an error */ }
}

function vibrate(pattern: number[]): boolean {
  try { return navigator.vibrate?.(pattern) ?? false; } catch { return false; }
}

export const PATTERNS = { stamp: [45], confirm: [45, 70, 140], refuse: [25, 60, 25], tear: [15, 25, 15, 25, 70] } as const;

export const feel = {
  /** A mission came into reach, or a button was pressed: one dry tick. */
  tick(): void { play(0.5, 0, 1400, 0, 0.005, 0.02, 1, 1.5); },
  /** The stamp lands: a low drum with a short click on top. */
  stamp(): void {
    play(1.6, 0, 129, 0.01, 0, 0.16, 0, 1, 0, 0, 0, 0, 0, 5);
    play(0.5, 0, 900, 0, 0.004, 0.03, 4, 2);
    vibrate([...PATTERNS.stamp]);
  },
  /** Two matching answers: the stamp, then two rising notes. The map changed. */
  confirm(): void {
    feel.stamp();
    window.setTimeout(() => play(0.8, 0, 523, 0.005, 0.06, 0.12, 1, 1.4), 170);
    window.setTimeout(() => play(0.8, 0, 784, 0.005, 0.1, 0.22, 1, 1.4), 300);
    vibrate([...PATTERNS.confirm]);
  },
  /** One step of the rolling counter. */
  count(step: number): void { play(0.25, 0, 620 + step * 28, 0, 0.004, 0.012, 1, 1.2); },
  /** A refusal: two low, soft notes. Not an alarm. */
  refuse(): void {
    play(0.6, 0, 196, 0.01, 0.05, 0.1, 0, 1.2);
    window.setTimeout(() => play(0.6, 0, 165, 0.01, 0.07, 0.14, 0, 1.2), 140);
    vibrate([...PATTERNS.refuse]);
  },
  /** The ticket tears: a ragged burst of noise that falls in pitch. */
  tear(): void {
    play(1.1, 0.2, 420, 0.005, 0.11, 0.09, 4, 2.6, -6, 0, 0, 0, 0, 1.8, 0, 0.3);
    vibrate([...PATTERNS.tear]);
  },
  /** Something changed on the board because of another citizen. */
  elsewhere(): void { play(0.5, 0, 392, 0.005, 0.04, 0.1, 1, 1.4); },
};
