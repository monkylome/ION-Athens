/**
 * Where the player is and which way they face. Real sensors on a phone, or a
 * fixed place moved with the arrow keys for a presenter (`?fake=lng,lat`).
 * The two never mix: a fake position is always labelled on screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LngLat } from "@ion/core";
import { calibrationOffset, courseBetween, headingFromOrientation, moveBy, normalise, smoothHeading, turn } from "./geo";

export type PositionStatus = "idle" | "waiting" | "ok" | "denied" | "unavailable" | "insecure" | "fake";
export interface Position {
  point: LngLat | null;
  accuracyM?: number;
  status: PositionStatus;
  /** Direction of travel from the last two fixes, when the person has moved. */
  course: number | null;
}

export const POSITION_WORDS: Record<PositionStatus, string> = {
  idle: "",
  waiting: "Αναζήτηση της θέσης σας.",
  ok: "",
  fake: "",
  denied: "Η τοποθεσία δεν επιτρέπεται. Επιτρέψτε την από τις ρυθμίσεις του προγράμματος περιήγησης για να δείτε αποστολές κοντά σας.",
  unavailable: "Η θέση σας δεν είναι διαθέσιμη αυτή τη στιγμή. Δοκιμάστε σε ανοιχτό χώρο.",
  insecure: "Το πρόγραμμα περιήγησης δεν δίνει τη θέση σε αυτή τη σύνδεση, γιατί δεν τη θεωρεί ασφαλή.",
};

/** `?fake=lng,lat` */
export function parseFake(value: string | null): LngLat | null {
  if (!value) return null;
  const [lng, lat] = value.split(",").map(Number);
  if (lng === undefined || lat === undefined || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

export const FAKE_STEP_M = 8;
export const FAKE_TURN_DEG = 30;

export interface FakeWalk {
  point: LngLat;
  heading: number;
  forward(): void;
  back(): void;
  left(): void;
  right(): void;
  /** Put the player somewhere at once, for a presenter. Always labelled on screen. */
  jump(to: LngLat, heading?: number): void;
}

/** The presenter's walk: forward and back along the heading, left and right turn on the spot. */
export function useFakeWalk(start: LngLat | null, startHeading: number, enabled: boolean): FakeWalk | null {
  const [state, setState] = useState<{ point: LngLat; heading: number } | null>(null);
  // The start may arrive late (the stage position comes from the server).
  useEffect(() => {
    if (start) setState((s) => s ?? { point: start, heading: startHeading });
  }, [start?.[0], start?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = useCallback((metres: number) => setState((s) => s && { ...s, point: moveBy(s.point, s.heading, metres) }), []);
  const rotate = useCallback((deg: number) => setState((s) => s && { ...s, heading: normalise(s.heading + deg) }), []);
  const forward = useCallback(() => step(FAKE_STEP_M), [step]);
  const back = useCallback(() => step(-FAKE_STEP_M), [step]);
  const left = useCallback(() => rotate(-FAKE_TURN_DEG), [rotate]);
  const right = useCallback(() => rotate(FAKE_TURN_DEG), [rotate]);
  const jump = useCallback((to: LngLat, heading?: number) => setState((s) => ({ point: to, heading: heading ?? s?.heading ?? 0 })), []);
  const ready = state !== null;
  useEffect(() => {
    if (!ready || !enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const move = { ArrowUp: forward, ArrowDown: back, ArrowLeft: left, ArrowRight: right }[event.key];
      if (!move) return;
      event.preventDefault();
      move();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, enabled, forward, back, left, right]);
  return state ? { ...state, forward, back, left, right, jump } : null;
}

/** The phone's own position. Starts only after the Start tap, and stops when the screen closes. */
export function usePosition(active: boolean): Position {
  const [position, setPosition] = useState<Position>({ point: null, status: "idle", course: null });
  const anchor = useRef<LngLat | null>(null);
  useEffect(() => {
    if (!active) return;
    if (!window.isSecureContext) { setPosition((p) => ({ ...p, status: "insecure" })); return; }
    if (!navigator.geolocation) { setPosition((p) => ({ ...p, status: "unavailable" })); return; }
    setPosition((p) => ({ ...p, status: p.point ? "ok" : "waiting" }));
    const id = navigator.geolocation.watchPosition(
      (fix) => {
        const point: LngLat = [fix.coords.longitude, fix.coords.latitude];
        setPosition((p) => {
          // Recompute the course only after a real move, so jitter while standing does not spin the board.
          const moved = anchor.current ? courseBetween(anchor.current, point, Math.max(5, fix.coords.accuracy / 2)) : null;
          if (moved !== null || !anchor.current) anchor.current = point;
          return { point, accuracyM: fix.coords.accuracy, status: "ok", course: moved ?? p.course };
        });
      },
      (error) => setPosition((p) => ({ ...p, status: error.code === error.PERMISSION_DENIED ? "denied" : p.point ? "ok" : "unavailable" })),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);
  return position;
}

export type HeadingSource = "compass" | "course" | "fake" | "none";
export interface Heading {
  /** Degrees from north, corrected by the calibration. Null when nothing tells the direction. */
  value: number | null;
  source: HeadingSource;
  /** True once a compass reading has arrived. */
  compass: boolean;
  /** The person faces the target and taps: from now on the compass is corrected by the difference. */
  calibrate(bearingToTarget: number): void;
  calibrated: boolean;
}

type OrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
type OrientationPermission = { requestPermission?: () => Promise<"granted" | "denied"> };

/** iOS asks for motion permission, and only inside a tap. Android Chrome needs nothing. */
export async function requestCompass(): Promise<boolean> {
  const api = (window as unknown as { DeviceOrientationEvent?: OrientationPermission }).DeviceOrientationEvent;
  if (!api) return false;
  if (typeof api.requestPermission !== "function") return true;
  try { return (await api.requestPermission()) === "granted"; } catch { return false; }
}

/**
 * The direction the phone points. `deviceorientationabsolute` on Android
 * Chrome, `webkitCompassHeading` on iOS, the course over ground when there is
 * no compass, and the presenter's heading in stage mode.
 */
export function useHeading(active: boolean, fake: number | null, course: number | null): Heading {
  const [raw, setRaw] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [calibrated, setCalibrated] = useState(false);
  const smoothed = useRef<number | null>(null);
  const shown = useRef<number | null>(null);
  const sentAt = useRef(0);

  useEffect(() => {
    if (!active || fake !== null) return;
    let absoluteSeen = false;
    const onReading = (event: Event) => {
      const e = event as OrientationEvent;
      let reading: number | null = null;
      if (typeof e.webkitCompassHeading === "number" && Number.isFinite(e.webkitCompassHeading)) reading = e.webkitCompassHeading;
      else if (e.absolute && e.alpha !== null && e.beta !== null && e.gamma !== null) reading = headingFromOrientation(e.alpha, e.beta, e.gamma);
      if (reading === null) return;
      // Once the absolute event speaks, the plain one (relative on Android) is ignored.
      if (event.type === "deviceorientationabsolute") absoluteSeen = true;
      else if (absoluteSeen) return;
      smoothed.current = smoothHeading(smoothed.current, reading);
      // The screen is redrawn at most 12 times a second, and only for a change a person can see.
      const now = performance.now();
      if (shown.current !== null && (now - sentAt.current < 80 || Math.abs(turn(shown.current, smoothed.current)) < 1)) return;
      shown.current = smoothed.current;
      sentAt.current = now;
      setRaw(smoothed.current);
    };
    window.addEventListener("deviceorientationabsolute", onReading);
    window.addEventListener("deviceorientation", onReading);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onReading);
      window.removeEventListener("deviceorientation", onReading);
    };
  }, [active, fake]);

  const source: HeadingSource = fake !== null ? "fake" : raw !== null ? "compass" : course !== null ? "course" : "none";
  const base = fake !== null ? fake : raw !== null ? raw : course;
  const value = base === null ? null : source === "compass" ? normalise(base + offset) : base;
  const calibrate = useCallback((bearingToTarget: number) => {
    if (smoothed.current === null) return;
    setOffset(calibrationOffset(bearingToTarget, smoothed.current));
    setCalibrated(true);
  }, []);
  return { value, source, compass: raw !== null, calibrate, calibrated };
}
