/**
 * Every sound of the demo, synthesised with the Web Audio API. No audio files.
 * These are the team's own sounds, not recordings of a street.
 *
 * The context is created by `unlock()`, which must be called from a user
 * gesture: nothing sounds before a key or a tap.
 */

export type Earcon = "start" | "instruction" | "obstacle" | "new_route" | "arrival";

const STEP_S = 0.56; // one footstep every 560 ms: an unhurried walk

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private walkTimer: number | null = null;
  private walkNext = 0;
  private walkCount = 0;
  private presetTimer: number | null = null;
  muted = false;

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /** Call from a key press or a tap. */
  unlock(): boolean {
    const Ctor = typeof window === "undefined" ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctor) return false;
    if (!this.ctx) {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      this.master.connect(this.ctx.destination);
      const length = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return true;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) this.master.gain.setValueAtTime(muted ? 0 : 0.9, this.ctx.currentTime);
  }

  /** True when a sound would be heard now. */
  get audible(): boolean {
    return this.unlocked && !this.muted;
  }

  private out(pan = 0): AudioNode | null {
    if (!this.ctx || !this.master) return null;
    if (pan === 0 || typeof this.ctx.createStereoPanner !== "function") return this.master;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(this.master);
    return panner;
  }

  private burst(at: number, seconds: number, type: BiquadFilterType, frequency: number, q: number, gain: number, pan = 0): void {
    const ctx = this.ctx;
    const to = this.out(pan);
    if (!ctx || !to || !this.noise) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    source.connect(filter).connect(amp).connect(to);
    source.start(at, Math.random());
    source.stop(at + seconds + 0.02);
  }

  private tone(at: number, seconds: number, frequency: number, gain: number, type: OscillatorType = "sine", pan = 0): void {
    const ctx = this.ctx;
    const to = this.out(pan);
    if (!ctx || !to) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = frequency;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(gain, at + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    osc.connect(amp).connect(to);
    osc.start(at);
    osc.stop(at + seconds + 0.02);
  }

  /** A shoe on paving: a low thud and a little grit. */
  private footstep(at: number, pan = 0): void {
    this.burst(at, 0.09, "lowpass", 260, 0.7, 0.55, pan);
    this.burst(at + 0.012, 0.05, "bandpass", 1500, 0.8, 0.07, pan);
  }

  /** The tip of a cane on stone: a sharp click with a short ring. */
  private cane(at: number, pan = 0): void {
    this.burst(at, 0.028, "bandpass", 3300, 2.5, 0.32, pan);
    this.tone(at, 0.07, 1750, 0.07, "triangle", pan);
  }

  /** A cane meeting metal: inharmonic partials that ring and die. */
  private knock(at: number): void {
    this.burst(at, 0.05, "bandpass", 2400, 1.2, 0.8);
    this.burst(at, 0.14, "lowpass", 300, 0.8, 0.6);
    const partials: [number, number, number][] = [
      [412, 0.9, 0.34],
      [1093, 1.5, 0.26],
      [1688, 1.2, 0.2],
      [2456, 0.8, 0.14],
      [3310, 0.5, 0.09],
      [4720, 0.3, 0.05],
    ];
    for (const [frequency, seconds, gain] of partials) this.tone(at, seconds, frequency, gain);
  }

  /** A street heard from the pavement: filtered noise that swells and falls. Returns a function that cuts it. */
  private street(at: number, seconds: number): (cutAt: number) => void {
    const ctx = this.ctx;
    const to = this.out();
    if (!ctx || !to || !this.noise) return () => undefined;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(240, at);
    // one vehicle passing
    filter.frequency.linearRampToValueAtTime(900, at + seconds * 0.45);
    filter.frequency.linearRampToValueAtTime(280, at + seconds * 0.85);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.linearRampToValueAtTime(0.16, at + 1.2);
    amp.gain.linearRampToValueAtTime(0.26, at + seconds * 0.45);
    amp.gain.linearRampToValueAtTime(0.14, at + seconds);
    source.connect(filter).connect(amp).connect(to);
    source.start(at);
    source.stop(at + seconds + 0.1);
    return (cutAt) => {
      amp.gain.cancelScheduledValues(cutAt);
      amp.gain.setValueAtTime(0, cutAt); // a cut, not a fade
    };
  }

  earcon(name: Earcon): void {
    const ctx = this.ctx;
    if (!ctx || !this.audible) return;
    const t = ctx.currentTime + 0.01;
    switch (name) {
      case "start":
        this.tone(t, 0.14, 523, 0.16);
        this.tone(t + 0.13, 0.2, 784, 0.16);
        break;
      case "instruction":
        this.tone(t, 0.09, 880, 0.1);
        break;
      case "obstacle": // low and doubled: a warning that is not an alarm
        this.tone(t, 0.16, 294, 0.24, "triangle");
        this.tone(t + 0.2, 0.22, 294, 0.24, "triangle");
        break;
      case "new_route":
        this.tone(t, 0.12, 587, 0.16);
        this.tone(t + 0.12, 0.12, 740, 0.16);
        this.tone(t + 0.24, 0.24, 880, 0.16);
        break;
      case "arrival":
        this.tone(t, 0.18, 659, 0.16);
        this.tone(t + 0.17, 0.4, 988, 0.16);
        break;
    }
  }

  /** Footsteps and cane while the walker walks. Quiet, under the voice. */
  setWalking(on: boolean): void {
    if (!on || !this.ctx) {
      if (this.walkTimer !== null) window.clearInterval(this.walkTimer);
      this.walkTimer = null;
      return;
    }
    if (this.walkTimer !== null) return;
    this.walkNext = this.ctx.currentTime + 0.1;
    this.walkTimer = window.setInterval(() => {
      const ctx = this.ctx;
      if (!ctx) return;
      if (this.presetTimer !== null) {
        this.walkNext = ctx.currentTime + 0.3;
        return;
      }
      while (this.walkNext < ctx.currentTime + 0.3) {
        const side = this.walkCount % 2 === 0 ? -0.15 : 0.15;
        this.footstep(this.walkNext, side);
        // The cane touches down between steps, on the side opposite the forward foot.
        this.cane(this.walkNext + STEP_S / 2, -side * 2.5);
        this.walkNext += STEP_S;
        this.walkCount++;
      }
    }, 100);
  }

  private holdPreset(seconds: number): void {
    if (this.presetTimer !== null) window.clearTimeout(this.presetTimer);
    this.presetTimer = window.setTimeout(() => {
      this.presetTimer = null;
    }, seconds * 1000);
  }

  /**
   * The opening, 9 seconds: a street, steps and a cane, a metallic knock at
   * 6.2 s, and then nothing at all.
   */
  opening(): number {
    const ctx = this.ctx;
    if (!ctx || !this.audible) return 0;
    const t = ctx.currentTime + 0.05;
    this.holdPreset(9);
    const cut = this.street(t, 6.2);
    let step = 0;
    for (let at = 1.0; at < 5.9; at += STEP_S, step++) {
      const side = step % 2 === 0 ? -0.15 : 0.15;
      this.footstep(t + at, side);
      this.cane(t + at + STEP_S / 2, -side * 2.5);
    }
    this.knock(t + 6.2);
    cut(t + 6.2); // the street stops with the knock: what is left is the metal, then silence
    return 9000;
  }

  /** The turn, 3 seconds: the same steps and the same cane, moving to one side. No knock. */
  turn(toRight = true): number {
    const ctx = this.ctx;
    if (!ctx || !this.audible) return 0;
    const t = ctx.currentTime + 0.05;
    this.holdPreset(3);
    const sign = toRight ? 1 : -1;
    let step = 0;
    for (let at = 0.1; at < 2.9; at += STEP_S, step++) {
      const progress = at / 2.9;
      const pan = sign * progress * 0.8;
      this.footstep(t + at, pan + (step % 2 === 0 ? -0.1 : 0.1));
      if (at + STEP_S / 2 < 2.95) this.cane(t + at + STEP_S / 2, pan);
    }
    return 3000;
  }
}

export const synth = new Synth();
