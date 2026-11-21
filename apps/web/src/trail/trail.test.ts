import { describe, expect, it } from "vitest";
import { StepDetector } from "./steps";
import { HeadingTracker, classifyAngle } from "./turns";
import { buildSegments, type Segment } from "./segments";
import { describeTrail } from "./describe";
import { compareTrails } from "./confirm";
import { TrailEngine } from "./engine";
import { demoWalk, simulateWalk } from "./simulate";

function run(plan: Parameters<typeof simulateWalk>[0], options: Parameters<typeof simulateWalk>[1] = {}) {
  const engine = new TrailEngine();
  for (const s of simulateWalk(plan, options)) engine.push(s);
  return engine;
}

describe("steps", () => {
  it("counts a 1.8 Hz walk within two steps, however the phone is held", () => {
    for (const gravity of [[0, 0, 9.81], [0, 9.81, 0], [0, 5.2, 8.3]] as [number, number, number][]) {
      const engine = run([{ walk: 30 }], { gravity, seed: 3 });
      expect(Math.abs(engine.stepCount - 30)).toBeLessThanOrEqual(2);
    }
  });
  it("counts nothing while standing still, even with noise", () => {
    const engine = run([], { noise: 0.4, leadInMs: 20000 });
    expect(engine.stepCount).toBe(0);
  });
  it("does not count a brief shake as a walk", () => {
    const detector = new StepDetector();
    // three hard shakes at 3 Hz after a second of standing
    for (let t = 0; t < 6000; t += 20) {
      const shaking = t > 1500 && t < 2500;
      detector.push({ t, x: 0, y: 0, z: 9.81 + (shaking ? 6 * Math.sin(2 * Math.PI * 3 * (t - 1500) / 1000) : 0) });
    }
    expect(detector.steps).toBe(0);
  });
  it("counts slow and fast walkers, and ignores the walk-up before warm-up only", () => {
    expect(Math.abs(run([{ walk: 20 }], { cadence: 1.2 }).stepCount - 20)).toBeLessThanOrEqual(2);
    expect(Math.abs(run([{ walk: 40 }], { cadence: 2.4, seed: 5 }).stepCount - 40)).toBeLessThanOrEqual(2);
  });
  it("restarts after a gap in the samples", () => {
    const detector = new StepDetector();
    detector.push({ t: 0, x: 0, y: 0, z: 9.8 });
    detector.push({ t: 5000, x: 0, y: 0, z: 9.8 });
    expect(detector.steps).toBe(0);
  });
});

describe("turns", () => {
  const rotate = (yaw: (t: number) => number, seconds: number, gravity: [number, number, number] = [0, 0, 9.81], alphaMode = false) => {
    const tracker = new HeadingTracker();
    const norm = Math.hypot(...gravity);
    const turns = [];
    let alpha = 0;
    for (let t = 0; t <= seconds * 1000; t += 20) {
      const rate = yaw(t / 1000);
      let turn;
      if (alphaMode) { alpha -= rate * -0.02 * -1; alpha = ((alpha % 360) + 360) % 360; turn = tracker.pushAlpha(t, alpha); }
      else turn = tracker.push({ t, ax: gravity[0], ay: gravity[1], az: gravity[2], rx: rate * gravity[0] / norm, ry: rate * gravity[1] / norm, rz: rate * gravity[2] / norm });
      if (turn) turns.push(turn);
    }
    return { turns, tracker };
  };
  const bell = (from: number, deg: number, dur: number) => (t: number) => t >= from && t < from + dur ? deg / dur * (1 - Math.cos(2 * Math.PI * (t - from) / dur)) : 0;

  it("classifies angles", () => {
    expect(classifyAngle(30)).toBe("straight");
    expect(classifyAngle(90)).toBe("left");
    expect(classifyAngle(-90)).toBe("right");
    expect(classifyAngle(-170)).toBe("back");
  });
  it("detects left, right and back turns with the phone flat or upright", () => {
    for (const gravity of [[0, 0, 9.81], [0, 9.81, 0]] as [number, number, number][]) {
      const left = rotate(bell(3, 90, 1.5), 8, gravity).turns;
      expect(left).toHaveLength(1);
      expect(left[0]!.angle).toBeGreaterThan(80);
      expect(left[0]!.angle).toBeLessThan(100);
      expect(rotate(bell(3, -90, 1.5), 8, gravity).turns[0]!.angle).toBeLessThan(-80);
    }
    expect(classifyAngle(rotate(bell(3, 180, 2), 9).turns[0]!.angle)).toBe("back");
  });
  it("detects a turn from the orientation alpha too", () => {
    const { turns } = rotate(bell(3, 90, 1.5), 8, undefined, true);
    expect(turns).toHaveLength(1);
    expect(Math.abs(Math.abs(turns[0]!.angle) - 90)).toBeLessThan(15);
  });
  it("ignores drift, sway and small corrections while walking straight", () => {
    expect(rotate(() => 1.5, 60).turns).toHaveLength(0);
    expect(rotate(t => 15 * Math.sin(2 * Math.PI * 0.9 * t), 30).turns).toHaveLength(0);
    expect(rotate(bell(3, 30, 1), 8).turns).toHaveLength(0);
  });
});

describe("segments", () => {
  const steps = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i * 500);
  it("cuts at turns and measures metres from the step length", () => {
    const result = buildSegments({ stepTimes: [...steps(0, 12), ...steps(10000, 6)], turns: [{ t: 8000, angle: 90 }] }, { stepLength: 0.65 });
    expect(result).toEqual([{ steps: 12, metres: 8, turn: "straight" }, { steps: 6, metres: 4, turn: "left" }]);
  });
  it("merges segments of fewer than two steps, adding the rotations", () => {
    const result = buildSegments({ stepTimes: [...steps(0, 10), 7000, ...steps(9000, 8)], turns: [{ t: 6000, angle: 90 }, { t: 8000, angle: 90 }] });
    expect(result.map(s => [s.steps, s.turn])).toEqual([[11, "straight"], [8, "back"]]);
  });
  it("drops a net rotation below 45 degrees and joins the walks", () => {
    const result = buildSegments({ stepTimes: [...steps(0, 6), ...steps(5000, 6)], turns: [{ t: 4000, angle: 90 }, { t: 4500, angle: -20 }, { t: 4800, angle: 10 }] });
    expect(result).toHaveLength(2);
    expect(result[1]!.turn).toBe("left");
    const wobble = buildSegments({ stepTimes: [...steps(0, 6), ...steps(5000, 6)], turns: [{ t: 4000, angle: 90 }, { t: 4500, angle: -60 }, { t: 4800, angle: 10 }] });
    expect(wobble).toEqual([{ steps: 12, metres: 8, turn: "straight" }]);
  });
  it("keeps notes and checkpoints on the segment where they happened", () => {
    const result = buildSegments({ stepTimes: [...steps(0, 4), ...steps(5000, 4)], turns: [{ t: 3000, angle: -90 }], notes: [{ t: 1000, text: "προσοχή, ένα σκαλί" }], checkpoints: [{ t: 7000, side: "left" }] });
    expect(result[0]!.note).toBe("προσοχή, ένα σκαλί");
    expect(result[1]!.checkpoint).toBe("left");
    expect(result[1]!.turn).toBe("right");
  });
  it("keeps a single short segment instead of emptying the trail", () => {
    expect(buildSegments({ stepTimes: [0], turns: [] })).toEqual([{ steps: 1, metres: 1, turn: "straight" }]);
  });
});

describe("describe", () => {
  const seg = (steps: number, metres: number, turn: Segment["turn"], extra: Partial<Segment> = {}): Segment => ({ steps, metres, turn, ...extra });
  it("describes a single straight segment", () => {
    expect(describeTrail({ start: "Κύρια είσοδος", target: "Ταμείο", segments: [seg(12, 9, "straight")] })).toBe(
      "Από την κύρια είσοδο προχωρήστε ευθεία περίπου 12 βήματα, δηλαδή περίπου 9 μέτρα. Το ταμείο είναι μπροστά σας. Τα βήματα μπορεί να διαφέρουν λίγο από τα δικά σας.");
  });
  it("describes turns and a checkpoint side", () => {
    const text = describeTrail({ start: "Κύρια είσοδος", target: "Ταμείο", segments: [seg(12, 8, "straight"), seg(6, 4, "left", { checkpoint: "right" })] });
    expect(text).toContain("Μετά στρίψτε αριστερά και προχωρήστε περίπου 6 βήματα, δηλαδή περίπου 4 μέτρα.");
    expect(text).toContain("Το ταμείο είναι στα δεξιά σας.");
    expect(text).not.toMatch(/ώρα|ρολόι/);
  });
  it("puts a stairs warning before the walk and other notes after it", () => {
    const text = describeTrail({ start: "Κύρια είσοδος", target: "Τουαλέτα", segments: [seg(5, 4, "straight", { note: "προσοχή, ένα σκαλί" }), seg(3, 2, "back", { note: "βαριά πόρτα" })] });
    expect(text.indexOf("Προσοχή, ένα σκαλί.")).toBeLessThan(text.indexOf("προχωρήστε ευθεία"));
    expect(text).toContain("Μετά κάντε μεταβολή και προχωρήστε περίπου 3 βήματα, δηλαδή περίπου 2 μέτρα. Βαριά πόρτα.");
    expect(text).toContain("Η τουαλέτα είναι μπροστά σας.");
  });
  it("uses singular forms and handles free text", () => {
    const text = describeTrail({ start: "Πίσω πόρτα", target: "Γκισέ 2", segments: [seg(1, 1, "straight")] });
    expect(text).toContain("Από το σημείο «Πίσω πόρτα» προχωρήστε ευθεία περίπου 1 βήμα, δηλαδή περίπου 1 μέτρο.");
    expect(text).toContain("Ο προορισμός «Γκισέ 2» είναι μπροστά σας.");
  });
  it("says so when nothing was recorded", () => {
    expect(describeTrail({ start: "Κύρια είσοδος", target: "Ταμείο", segments: [] })).toBe("Δεν καταγράφηκε διαδρομή.");
  });
});

describe("compareTrails", () => {
  const a: Segment[] = [{ steps: 12, metres: 8, turn: "straight" }, { steps: 6, metres: 4, turn: "left", checkpoint: "left" }];
  it("confirms the same walk within max(2 steps, 15 %)", () => {
    expect(compareTrails(a, [{ steps: 14, metres: 10, turn: "straight" }, { steps: 8, metres: 5, turn: "left", checkpoint: "left" }]).ok).toBe(true);
    expect(compareTrails([{ steps: 40, metres: 28, turn: "straight" }], [{ steps: 46, metres: 32, turn: "straight" }]).ok).toBe(true);
  });
  it("names the segment that differs in length", () => {
    const result = compareTrails(a, [{ steps: 12, metres: 8, turn: "straight" }, { steps: 10, metres: 7, turn: "left", checkpoint: "left" }]);
    expect(result.ok).toBe(false);
    expect(result.differences).toEqual([{ segment: 2, reason: "10 βήματα αντί για 6" }]);
    expect(result.message).toContain("Τμήμα 2");
  });
  it("rejects a different turn, a different checkpoint side and a different number of segments", () => {
    expect(compareTrails(a, [a[0]!, { ...a[1]!, turn: "right" }]).differences[0]!.segment).toBe(2);
    expect(compareTrails(a, [a[0]!, { ...a[1]!, checkpoint: "right" }]).ok).toBe(false);
    expect(compareTrails(a, [a[0]!]).ok).toBe(false);
  });
  it("compares metres when both walkers are calibrated", () => {
    expect(compareTrails(a, [{ steps: 20, metres: 8, turn: "straight" }, { steps: 3, metres: 4, turn: "left", checkpoint: "left" }], { compareMetres: true }).ok).toBe(true);
  });
});

describe("the demonstration walk", () => {
  it("gives 12 steps, a left turn and 6 steps", () => {
    const segments = run(demoWalk).segments(0.65);
    expect(segments).toHaveLength(2);
    expect(Math.abs(segments[0]!.steps - 12)).toBeLessThanOrEqual(2);
    expect(segments[1]!.turn).toBe("left");
    expect(Math.abs(segments[1]!.steps - 6)).toBeLessThanOrEqual(2);
  });
  it("does not invent turns from gyroscope bias and body sway", () => {
    const engine = run([{ walk: 40 }], { bias: 1.5, sway: 12 });
    expect(engine.turns).toHaveLength(0);
    expect(engine.segments()).toHaveLength(1);
  });
});
