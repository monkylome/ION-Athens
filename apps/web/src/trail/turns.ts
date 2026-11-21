/** Relative heading from the gyroscope, and turn detection. Pure. Heading is in degrees, counter-clockwise (left) positive. */

export interface GyroSample {
  t: number;
  /** accelerationIncludingGravity, device axes. It points up when the phone rests. */
  ax: number; ay: number; az: number;
  /** rotationRate in degrees per second: beta (about x), gamma (about y), alpha (about z). */
  rx: number; ry: number; rz: number;
}

export interface TurnEvent {
  /** Middle of the rotation, ms. */
  t: number;
  /** Signed heading change in degrees, left positive. */
  angle: number;
}

export interface TurnParams {
  /** Smoothed yaw rate above this starts a rotation, degrees per second. */
  startRate: number;
  /** A rotation ends after the rate stays below this. */
  endRate: number;
  quietMs: number;
  /** Smaller net rotations are sway or drift, not turns. */
  minTurnDeg: number;
  /** A rotation lasting longer is closed anyway. */
  maxTurnMs: number;
  yawTauMs: number;
  gravityTauMs: number;
  /** The rotation began a little before the smoothed rate crossed the start rate. */
  lookbackMs: number;
  /** Rates below this feed the slow gyroscope bias estimate. */
  restRate: number;
  biasTauMs: number;
  /** Circular mean window for the orientation alpha. */
  alphaMeanMs: number;
}

export const defaultTurnParams: TurnParams = {
  startRate: 12,
  endRate: 5,
  quietMs: 500,
  minTurnDeg: 45,
  maxTurnMs: 10000,
  yawTauMs: 250,
  gravityTauMs: 800,
  lookbackMs: 150,
  restRate: 2,
  biasTauMs: 8000,
  alphaMeanMs: 250,
};

export type TurnKind = "left" | "right" | "straight" | "back";

/** 45 to 135 degrees is left or right, more is back, less is straight. */
export function classifyAngle(angle: number): TurnKind {
  const size = Math.abs(angle);
  if (size < 45) return "straight";
  if (size > 135) return "back";
  return angle > 0 ? "left" : "right";
}

export class HeadingTracker {
  readonly params: TurnParams;
  /** Integrated heading since the first sample. */
  heading = 0;
  private lastT?: number;
  private g: [number, number, number] = [0, 0, 0];
  private yawSmooth = 0;
  private bias = 0;
  private history: { t: number; h: number }[] = [];
  private rotating = false;
  private startT = 0;
  private startHeading = 0;
  private quietT: number | null = null;
  private quietHeading = 0;

  constructor(params: Partial<TurnParams> = {}) {
    this.params = { ...defaultTurnParams, ...params };
  }

  /** Heading when the last turn ended (or at the start). */
  baseHeading = 0;

  /** Heading change since the last turn ended, including a rotation in progress. */
  get change() { return this.heading - this.baseHeading; }

  private source: "gyro" | "alpha" = "gyro";
  private alphaBuffer: { t: number; a: number }[] = [];
  private alphaSmooth?: number;
  private alphaLastT?: number;

  /**
   * Preferred source: the relative `alpha` of the plain deviceorientation event (no magnetometer indoors).
   * Heading is minus alpha, smoothed with a circular mean over `alphaMeanMs`. Once alpha has arrived, gyroscope samples
   * are ignored; they stay as the fallback when alpha is null.
   */
  pushAlpha(t: number, alpha: number): TurnEvent | undefined {
    const p = this.params;
    this.source = "alpha";
    this.alphaBuffer.push({ t, a: -alpha });
    while (this.alphaBuffer.length > 1 && this.alphaBuffer[0]!.t < t - p.alphaMeanMs) this.alphaBuffer.shift();
    const rad = Math.PI / 180;
    const mean = Math.atan2(
      this.alphaBuffer.reduce((sum, b) => sum + Math.sin(b.a * rad), 0),
      this.alphaBuffer.reduce((sum, b) => sum + Math.cos(b.a * rad), 0)) / rad;
    if (this.alphaSmooth === undefined || this.alphaLastT === undefined) {
      this.alphaSmooth = mean;
      this.alphaLastT = t;
      this.history.push({ t, h: this.heading });
      return undefined;
    }
    const step = ((mean - this.alphaSmooth + 540) % 360) - 180;
    const dt = Math.max(1, t - this.alphaLastT);
    this.alphaSmooth = mean;
    this.alphaLastT = t;
    this.heading += step;
    return this.advance(t, dt, step / dt * 1000);
  }

  push(s: GyroSample): TurnEvent | undefined {
    const p = this.params;
    if (this.source === "alpha") return undefined;
    if (this.lastT === undefined) {
      this.lastT = s.t;
      this.g = [s.ax, s.ay, s.az];
      this.history.push({ t: s.t, h: 0 });
      return undefined;
    }
    const dt = Math.max(1, s.t - this.lastT);
    this.lastT = s.t;
    const ag = dt / (p.gravityTauMs + dt);
    this.g = [this.g[0] + ag * (s.ax - this.g[0]), this.g[1] + ag * (s.ay - this.g[1]), this.g[2] + ag * (s.az - this.g[2])];
    const norm = Math.hypot(...this.g);
    // Rotation rate along the up direction: independent of how the phone is held.
    const yaw = norm < 1 ? 0 : (s.rx * this.g[0] + s.ry * this.g[1] + s.rz * this.g[2]) / norm;
    if (!this.rotating && Math.abs(yaw) < p.restRate) this.bias += dt / (p.biasTauMs + dt) * (yaw - this.bias);
    const corrected = yaw - this.bias;
    this.heading += corrected * dt / 1000;
    return this.advance(s.t, dt, corrected);
  }

  private advance(t: number, dt: number, corrected: number): TurnEvent | undefined {
    const p = this.params;
    const s = { t };
    this.yawSmooth += dt / (p.yawTauMs + dt) * (corrected - this.yawSmooth);
    this.history.push({ t, h: this.heading });
    while (this.history.length > 2 && this.history[1]!.t < t - 2000) this.history.shift();
    const rate = Math.abs(this.yawSmooth);

    if (!this.rotating) {
      if (rate > p.startRate) {
        this.rotating = true;
        this.startT = s.t;
        this.startHeading = this.headingAt(s.t - p.lookbackMs);
        this.quietT = null;
      }
      return undefined;
    }
    if (rate < p.endRate) {
      if (this.quietT === null) { this.quietT = s.t; this.quietHeading = this.heading; }
      if (s.t - this.quietT >= p.quietMs) return this.finish(this.quietT, this.quietHeading);
    } else {
      this.quietT = null;
    }
    if (s.t - this.startT > p.maxTurnMs) return this.finish(s.t, this.heading);
    return undefined;
  }

  private headingAt(t: number) {
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i]!.t <= t) return this.history[i]!.h;
    return this.history[0]!.h;
  }

  private finish(endT: number, endHeading: number): TurnEvent | undefined {
    this.rotating = false;
    const angle = endHeading - this.startHeading;
    if (Math.abs(angle) < this.params.minTurnDeg) return undefined;
    this.baseHeading = endHeading;
    return { t: (this.startT + endT) / 2, angle };
  }
}
