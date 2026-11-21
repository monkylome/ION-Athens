import { StepDetector, type StepParams } from "./steps";
import { HeadingTracker, type GyroSample, type TurnEvent, type TurnParams } from "./turns";
import { buildSegments, defaultStepLength, type Segment, type Side, type TimedCheckpoint, type TimedNote } from "./segments";

export type MotionSample = GyroSample;

/** Feeds one walk through both detectors and keeps what the segments are built from. */
export class TrailEngine {
  readonly steps: StepDetector;
  readonly heading: HeadingTracker;
  readonly turns: TurnEvent[] = [];
  readonly notes: TimedNote[] = [];
  readonly checkpoints: TimedCheckpoint[] = [];
  lastT = 0;

  constructor(options: { steps?: Partial<StepParams>; turns?: Partial<TurnParams> } = {}) {
    this.steps = new StepDetector(options.steps);
    this.heading = new HeadingTracker(options.turns);
  }

  /** Returns true when something the screen shows changed. */
  push(s: MotionSample): boolean {
    this.lastT = s.t;
    const stepped = this.steps.push({ t: s.t, x: s.ax, y: s.ay, z: s.az }).length > 0;
    const turn = this.heading.push(s);
    if (turn) this.turns.push(turn);
    return stepped || !!turn;
  }

  pushAlpha(t: number, alpha: number): boolean {
    const turn = this.heading.pushAlpha(t, alpha);
    if (turn) this.turns.push(turn);
    return !!turn;
  }

  get stepCount() { return this.steps.steps; }
  get headingChange() { return this.heading.change; }
  addNote(text: string) { this.notes.push({ t: this.lastT, text }); }
  addCheckpoint(side: Side) { this.checkpoints.push({ t: this.lastT, side }); }

  segments(stepLength = defaultStepLength): Segment[] {
    return buildSegments({ stepTimes: this.steps.stepTimes, turns: this.turns, notes: this.notes, checkpoints: this.checkpoints }, { stepLength });
  }
}
