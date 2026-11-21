/**
 * Step counting from accelerometer samples (accelerationIncludingGravity). Pure: time comes from the samples.
 * Signal: magnitude, minus a slow baseline (gravity), lightly smoothed. A step is a bump of that signal above a
 * threshold with a plausible duration and spacing. A walk is only believed once several bumps keep a rhythm,
 * so a brief shake counts nothing; the steps of that first stretch are then counted retroactively.
 */

export interface AccelSample { t: number; x: number; y: number; z: number }

export interface StepParams {
  /** Time constant of the slow low-pass that estimates gravity. */
  baselineTauMs: number;
  /** Time constant of the fast smoothing of the gravity-free magnitude. */
  smoothTauMs: number;
  /** Ignore the start while the filters settle. */
  warmupMs: number;
  /** Rising above this, in m/s2, begins a step candidate. User-tunable between 0.8 and 1.5. */
  threshold: number;
  /** Re-arm when the signal falls below this fraction of the threshold. */
  rearmFraction: number;
  minIntervalMs: number;
  minPeakMs: number;
  maxPeakMs: number;
  /** A bump above this is a knock or a shake, not a step. */
  maxPeak: number;
  /** Samples further apart than this restart the filters. */
  resetGapMs: number;
  /** Steps in a steady rhythm needed before they count as a walk. */
  confirmCount: number;
  /** Each interval must be within this ratio of the one before (1.8: from 0.55 to 1.8 times). */
  rhythmRatio: number;
  /** Between two steps of one walk. A longer gap starts a new chain. */
  maxIntervalMs: number;
  /** After a walk is confirmed, a pause up to this long still continues it (turning, a door). */
  pauseMs: number;
}

export const defaultStepParams: StepParams = {
  baselineTauMs: 650,
  smoothTauMs: 45,
  warmupMs: 700,
  threshold: 1.1,
  rearmFraction: 0.25,
  minIntervalMs: 320,
  minPeakMs: 60,
  maxPeakMs: 600,
  maxPeak: 12,
  resetGapMs: 500,
  confirmCount: 4,
  rhythmRatio: 1.8,
  maxIntervalMs: 1400,
  pauseMs: 2500,
};

export class StepDetector {
  readonly params: StepParams;
  /** Timestamps of every counted step. */
  readonly stepTimes: number[] = [];
  private startT?: number;
  private lastT = 0;
  private baseline = 0;
  private smooth = 0;
  private armed = true;
  private rise: number | null = null;
  private peak = 0;
  private lastStepT = -Infinity;
  private chain: number[] = [];
  private walking = false;

  constructor(params: Partial<StepParams> = {}) {
    this.params = { ...defaultStepParams, ...params };
  }

  get steps() { return this.stepTimes.length; }

  private restart(sample: AccelSample, m: number) {
    this.startT = sample.t;
    this.baseline = m;
    this.smooth = 0;
    this.armed = true;
    this.rise = null;
    this.chain = [];
    this.walking = false;
  }

  /** Feed one sample. Returns the timestamps of steps counted because of it (a new walk is confirmed in a batch). */
  push(sample: AccelSample): number[] {
    const p = this.params;
    const m = Math.hypot(sample.x, sample.y, sample.z);
    if (this.startT === undefined || sample.t - this.lastT > p.resetGapMs || sample.t < this.lastT) {
      this.restart(sample, m);
      this.lastT = sample.t;
      return [];
    }
    const dt = Math.max(1, sample.t - this.lastT);
    this.lastT = sample.t;
    this.baseline += dt / (p.baselineTauMs + dt) * (m - this.baseline);
    this.smooth += dt / (p.smoothTauMs + dt) * (m - this.baseline - this.smooth);
    const s = this.smooth;
    if (sample.t - this.startT < p.warmupMs) return [];

    if (this.rise === null) {
      if (this.armed && s > p.threshold) { this.rise = sample.t; this.peak = s; this.armed = false; }
      else if (!this.armed && s < p.threshold * p.rearmFraction) this.armed = true;
      return [];
    }
    this.peak = Math.max(this.peak, s);
    if (s > p.threshold && sample.t - this.rise <= p.maxPeakMs) return [];
    const riseT = this.rise;
    const duration = sample.t - riseT;
    this.rise = null;
    if (s <= p.threshold && s < p.threshold * p.rearmFraction) this.armed = true;
    if (duration < p.minPeakMs || duration > p.maxPeakMs || this.peak >= p.maxPeak) return [];
    if (riseT - this.lastStepT < p.minIntervalMs) return [];
    this.lastStepT = riseT;
    return this.accept(riseT);
  }

  private accept(t: number): number[] {
    const p = this.params;
    const last = this.chain[this.chain.length - 1];
    if (last !== undefined && t - last > (this.walking ? p.pauseMs : p.maxIntervalMs)) {
      this.walking = false;
      this.chain = [];
    }
    if (this.walking) {
      this.chain = [t];
      this.stepTimes.push(t);
      return [t];
    }
    const previous = this.chain[this.chain.length - 1];
    if (previous !== undefined && this.chain.length >= 2) {
      const ratio = (t - previous) / (previous - this.chain[this.chain.length - 2]!);
      if (ratio > p.rhythmRatio || ratio < 1 / p.rhythmRatio) this.chain = [previous];
    }
    this.chain.push(t);
    if (this.chain.length < p.confirmCount) return [];
    this.walking = true;
    const confirmed = this.chain;
    this.chain = [t];
    this.stepTimes.push(...confirmed);
    return confirmed;
  }
}
