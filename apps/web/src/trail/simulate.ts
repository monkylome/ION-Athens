import type { MotionSample } from "./engine";

export type SimItem = { walk: number } | { turn: number; steps?: number };
export const demoWalk: SimItem[] = [{ walk: 12 }, { turn: 90, steps: 0 }, { walk: 6 }];

export interface SimOptions {
  /** Steps per second. */
  cadence?: number;
  /** Peak vertical acceleration of a step, m/s2. */
  amplitude?: number;
  noise?: number;
  rateHz?: number;
  leadInMs?: number;
  tailMs?: number;
  /** Direction of gravity in device axes (the phone held upright by default is not flat: tilted forwards). */
  gravity?: [number, number, number];
  seed?: number;
  /** Constant gyroscope bias, degrees per second about the vertical. */
  bias?: number;
  /** Side-to-side body sway, degrees per second amplitude at half the step rate. */
  sway?: number;
}

function random(seed: number) {
  let s = seed >>> 0 || 1;
  const uniform = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  return () => { let a = 0; for (let i = 0; i < 6; i++) a += uniform(); return a - 3; };
}

/**
 * A scripted walk as sensor samples. `walk` is steps in a straight line; `turn` is a rotation in degrees (left positive)
 * made over `steps` steps (0: standing still for 1.2 s). Gravity, step bumps and rotation follow the gravity direction, so the phone orientation is free.
 */
export function simulateWalk(plan: readonly SimItem[], options: SimOptions = {}): MotionSample[] {
  const f = options.cadence ?? 1.8, amp = options.amplitude ?? 3, noise = options.noise ?? 0.3, rate = options.rateHz ?? 50;
  const lead = options.leadInMs ?? 1500, tail = options.tailMs ?? 2000;
  const gv = options.gravity ?? [0, 5.2, 8.3];
  const gn = Math.hypot(...gv), up = gv.map(v => v / gn) as [number, number, number];
  const gauss = random(options.seed ?? 7);
  type Part = { start: number; end: number; rotation: number; silent: boolean };
  const parts: Part[] = [];
  let at = lead;
  for (const item of plan) {
    const n = "walk" in item ? item.walk : (item.steps ?? 2);
    const len = n === 0 ? 1200 : n / f * 1000;
    parts.push({ start: at, end: at + len, rotation: "turn" in item ? item.turn : 0, silent: n === 0 });
    at += len;
  }
  const total = at + tail;
  const out: MotionSample[] = [];
  for (let t = 0; t <= total; t += 1000 / rate) {
    let bump = 0, yaw = 0;
    for (const part of parts) {
      if (t < part.start || t >= part.end) continue;
      const u = (t - part.start) / 1000;
      bump = part.silent ? 0 : amp * Math.sin(2 * Math.PI * f * u);
      if (part.rotation) {
        const span = (part.end - part.start) / 1000;
        yaw = part.rotation / span * (1 - Math.cos(2 * Math.PI * u / span));
      }
    }
    if (options.sway && t > lead) yaw += options.sway * Math.sin(2 * Math.PI * (f / 2) * t / 1000);
    yaw += options.bias ?? 0;
    const a = up.map(v => v * (gn + bump) + gauss() * noise);
    out.push({ t, ax: a[0]!, ay: a[1]!, az: a[2]!, rx: up[0]! * yaw + gauss() * 0.5, ry: up[1]! * yaw + gauss() * 0.5, rz: up[2]! * yaw + gauss() * 0.5 });
  }
  return out;
}
