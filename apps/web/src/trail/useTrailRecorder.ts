import { useCallback, useEffect, useRef, useState } from "react";
import { TrailEngine } from "./engine";
import { defaultStepLength, type Segment, type Side } from "./segments";
import { demoWalk, simulateWalk } from "./simulate";

export type RecorderState = "idle" | "recording" | "done" | "unsupported" | "denied";

interface PermissionApi { requestPermission?: () => Promise<"granted" | "denied"> }
type WakeLockLike = { release: () => Promise<void> };

/** Records one indoor trail from the phone's motion sensors, or from a scripted walk with `simulated`. */
export function useTrailRecorder({ stepLength = defaultStepLength, simulated = false }: { stepLength?: number; simulated?: boolean } = {}) {
  const [state, setState] = useState<RecorderState>("idle");
  const [steps, setSteps] = useState(0);
  const [headingChange, setHeadingChange] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [event, setEvent] = useState("");
  const engine = useRef<TrailEngine>(new TrailEngine());
  const cleanup = useRef<() => void>(() => undefined);
  const stepLengthRef = useRef(stepLength);
  stepLengthRef.current = stepLength;
  const lastPaint = useRef(0);
  const turnsSeen = useRef(0);

  const paint = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastPaint.current < 100) return;
    lastPaint.current = now;
    const e = engine.current;
    setSteps(e.stepCount);
    setHeadingChange(Math.round(e.headingChange));
    setSegments(e.segments(stepLengthRef.current));
    if (e.turns.length !== turnsSeen.current) {
      turnsSeen.current = e.turns.length;
      const last = e.turns[e.turns.length - 1]!;
      setEvent(last.angle > 0 ? "Στροφή αριστερά" : "Στροφή δεξιά");
    }
  }, []);

  useEffect(() => () => cleanup.current(), []);
  useEffect(() => { if (state === "recording") setSegments(engine.current.segments(stepLength)); }, [stepLength, state]);

  const start = useCallback(async () => {
    cleanup.current();
    engine.current = new TrailEngine();
    turnsSeen.current = 0;
    setSteps(0); setHeadingChange(0); setSegments([]); setEvent("");
    const stops: (() => void)[] = [];
    cleanup.current = () => { stops.forEach(stop => stop()); stops.length = 0; };

    if (simulated) {
      const samples = simulateWalk(demoWalk);
      const began = performance.now();
      let next = 0;
      const timer = window.setInterval(() => {
        const elapsed = performance.now() - began;
        while (next < samples.length && samples[next]!.t <= elapsed) engine.current.push(samples[next++]!);
        paint();
      }, 20);
      stops.push(() => window.clearInterval(timer));
      setState("recording");
      setEvent("Η προσομοίωση ξεκίνησε");
      return;
    }

    // Permission must be asked inside the tap, before anything is awaited.
    if (typeof DeviceMotionEvent === "undefined") { setState("unsupported"); return; }
    const asks = [(DeviceMotionEvent as unknown as PermissionApi).requestPermission, (globalThis.DeviceOrientationEvent as unknown as PermissionApi | undefined)?.requestPermission];
    try {
      const answers = await Promise.all(asks.filter(Boolean).map(ask => ask!.call(DeviceMotionEvent)));
      if (answers.includes("denied")) { setState("denied"); return; }
    } catch {
      setState("denied");
      return;
    }

    let gotData = false;
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      gotData = true;
      const r = e.rotationRate;
      engine.current.push({ t: performance.now(), ax: a.x, ay: a.y, az: a.z, rx: r?.beta ?? 0, ry: r?.gamma ?? 0, rz: r?.alpha ?? 0 });
      paint();
    };
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha == null) return;
      engine.current.pushAlpha(performance.now(), e.alpha);
    };
    window.addEventListener("devicemotion", onMotion);
    window.addEventListener("deviceorientation", onOrientation);
    stops.push(() => window.removeEventListener("devicemotion", onMotion), () => window.removeEventListener("deviceorientation", onOrientation));

    // A screen that sleeps stops the sensors. Ask again when the page comes back.
    let lock: WakeLockLike | null = null;
    const holdScreen = async () => {
      try { lock = (await (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<WakeLockLike> } }).wakeLock?.request("screen")) ?? null; } catch { lock = null; }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void holdScreen(); };
    document.addEventListener("visibilitychange", onVisible);
    stops.push(() => document.removeEventListener("visibilitychange", onVisible), () => { void lock?.release().catch(() => undefined); lock = null; });
    void holdScreen();

    const noData = window.setTimeout(() => { if (!gotData) { cleanup.current(); setState("unsupported"); } }, 3000);
    stops.push(() => window.clearTimeout(noData));
    setState("recording");
    setEvent("Η καταγραφή ξεκίνησε");
  }, [paint, simulated]);

  const stop = useCallback((): Segment[] => {
    cleanup.current();
    paint(true);
    setState("done");
    setEvent("Η καταγραφή τελείωσε");
    return engine.current.segments(stepLengthRef.current);
  }, [paint]);

  const addNote = useCallback((text: string) => {
    engine.current.addNote(text);
    paint(true);
    setEvent("Προστέθηκε σημείωση");
  }, [paint]);

  const addCheckpoint = useCallback((side: Side) => {
    engine.current.addCheckpoint(side);
    paint(true);
    setEvent("Σημειώθηκε ο προορισμός");
  }, [paint]);

  const reset = useCallback(() => {
    cleanup.current();
    engine.current = new TrailEngine();
    setState("idle"); setSteps(0); setHeadingChange(0); setSegments([]); setEvent("");
  }, []);

  return { state, steps, headingChange, segments, event, simulated, start, stop, addNote, addCheckpoint, reset };
}
