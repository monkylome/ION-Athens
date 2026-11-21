/**
 * The geometry of the game, with no browser in it: distance, bearing, reach,
 * where the plate sits in the camera view, and the words for a direction.
 */
import type { LngLat } from "@ion/core";

const RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6371008.8;

/** The player answers a mission from inside this ring. The server allows 60 m; the game asks for 30. */
export const REACH_M = 30;
/** The server's own limit. A poor GPS fix may stretch the ring, never beyond this. */
export const SERVER_REACH_M = 60;
/** Horizontal field of view of a phone's rear camera held upright. A guess to tune on the demo phone (`?fov=`). */
export const CAMERA_FOV_DEG = 55;

export function distanceM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing from a to b: 0 north, 90 east. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const dLng = (b[0] - a[0]) * RAD;
  const y = Math.sin(dLng) * Math.cos(b[1] * RAD);
  const x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos(dLng);
  return normalise(Math.atan2(y, x) / RAD);
}

/** Any angle as 0 to 360. */
export function normalise(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** The short way from one bearing to another: -180 (left) to 180 (right). */
export function turn(from: number, to: number): number {
  const d = normalise(to - from);
  return d > 180 ? d - 360 : d;
}

/** A point `metres` away along `bearing`. Used by the presenter's arrows and by the reach ring. */
export function moveBy(from: LngLat, bearing: number, metres: number): LngLat {
  const north = Math.cos(bearing * RAD) * metres;
  const east = Math.sin(bearing * RAD) * metres;
  const mPerDeg = (EARTH_RADIUS_M * Math.PI) / 180;
  return [from[0] + east / (mPerDeg * Math.cos(from[1] * RAD)), from[1] + north / mPerDeg];
}

/** A closed ring of points around a centre, for the reach circle on the board. */
export function ring(centre: LngLat, radiusM: number, steps = 48): LngLat[] {
  return Array.from({ length: steps + 1 }, (_, i) => moveBy(centre, (i % steps) * (360 / steps), radiusM));
}

/**
 * Reach is decided by distance alone. A fix that reports poor accuracy widens
 * the ring by that uncertainty, up to the server's own limit, so nobody is
 * refused for standing in the right place with a bad signal.
 */
export function reachM(accuracyM?: number): number {
  if (accuracyM === undefined || !Number.isFinite(accuracyM) || accuracyM <= 10) return REACH_M;
  return Math.min(SERVER_REACH_M, REACH_M + accuracyM - 10);
}
export function inReach(distance: number, accuracyM?: number): boolean {
  return distance <= reachM(accuracyM);
}

/** DESIGN.md section 7: nearest 5 m under a kilometre, nearest 50 m above. */
export function roundDistance(metres: number): number {
  return metres < 1000 ? Math.round(metres / 5) * 5 : Math.round(metres / 50) * 50;
}

/** "45 μέτρα", "κοντά" at 15 m or less, "περίπου" when the fix is rough. Units written out, as they are spoken. */
export function distanceWords(metres: number, accuracyM?: number): string {
  if (metres <= 15) return "κοντά";
  const rounded = roundDistance(metres);
  const text = rounded >= 1000 ? `${String(rounded / 1000).replace(".", ",")} χιλιόμετρα` : `${rounded} μέτρα`;
  if (accuracyM === undefined || accuracyM <= 10) return text;
  return accuracyM <= 20 ? `περίπου ${text}` : `γύρω στα ${text}`;
}

/** The same distance for the eye, where room is counted in characters: "50 μ.", "1,5 χλμ.". Speech always gets `distanceWords`. */
export function shortDistance(metres: number): string {
  if (metres <= 15) return "κοντά";
  const rounded = roundDistance(metres);
  return rounded >= 1000 ? `${String(rounded / 1000).replace(".", ",")} χλμ.` : `${rounded} μ.`;
}

export type Direction = "ahead" | "ahead_right" | "right" | "behind_right" | "behind" | "behind_left" | "left" | "ahead_left";
const DIRECTIONS: Direction[] = ["ahead", "ahead_right", "right", "behind_right", "behind", "behind_left", "left", "ahead_left"];
const DIRECTION_WORDS: Record<Direction, string> = {
  ahead: "μπροστά",
  ahead_right: "μπροστά δεξιά",
  right: "δεξιά",
  behind_right: "πίσω δεξιά",
  behind: "πίσω σας",
  behind_left: "πίσω αριστερά",
  left: "αριστερά",
  ahead_left: "μπροστά αριστερά",
};
const COMPASS_WORDS = ["βόρεια", "βορειοανατολικά", "ανατολικά", "νοτιοανατολικά", "νότια", "νοτιοδυτικά", "δυτικά", "βορειοδυτικά"];

/** "βόρεια", "νοτιοδυτικά": for when the direction must hold whichever way the person turns. */
export function compassWords(bearing: number): string {
  return COMPASS_WORDS[Math.round(normalise(bearing) / 45) % 8]!;
}

/** Where something is for a person facing `heading`. Proportional words, never a clock face. */
export function direction(bearing: number, heading: number): Direction {
  return DIRECTIONS[Math.round(normalise(bearing - heading) / 45) % 8]!;
}
export function directionWords(bearing: number, heading: number | null): string {
  // Without a heading nobody knows what "ahead" is, so the compass point is said instead.
  if (heading === null) return COMPASS_WORDS[Math.round(normalise(bearing) / 45) % 8]!;
  return DIRECTION_WORDS[direction(bearing, heading)];
}

/**
 * Compass heading from a `deviceorientationabsolute` reading (alpha, beta,
 * gamma in degrees). A phone lying flat points with its top edge; a phone held
 * upright, as for the camera, points with its back. Reading alpha alone is
 * wrong for an upright phone, so the direction is taken from the rotation
 * matrix R = Rz(alpha) Rx(beta) Ry(gamma) in the east-north-up frame.
 */
export function headingFromOrientation(alpha: number, beta: number, gamma: number, screenAngle = 0): number {
  const a = alpha * RAD, b = beta * RAD, g = gamma * RAD;
  const sA = Math.sin(a), cA = Math.cos(a), sB = Math.sin(b), cB = Math.cos(b), sG = Math.sin(g), cG = Math.cos(g);
  // Upright past 45 degrees: use the direction the rear camera looks (the device's -Z axis).
  const upright = sB > Math.SQRT1_2 && cG > 0;
  const east = upright ? -(cG * sA * sB + cA * sG) : -cB * sA;
  const north = upright ? cA * cG * sB - sA * sG : cA * cB;
  return normalise(Math.atan2(east, north) / RAD + screenAngle);
}

/** A moving average for angles, safe across the 0/360 seam. `weight` is how much the new reading counts. */
export function smoothHeading(previous: number | null, next: number, weight = 0.25): number {
  if (previous === null) return normalise(next);
  return normalise(previous + turn(previous, next) * weight);
}

/** The correction learnt when the person faces the mission and taps: what must be added to the raw compass. */
export function calibrationOffset(bearingToTarget: number, rawHeading: number): number {
  return turn(rawHeading, bearingToTarget);
}

export interface Plate {
  /** True when the place is inside the camera's field of view. */
  visible: boolean;
  /** Horizontal position in the frame, 0 left edge to 1 right edge. Clamped to the frame when out of view. */
  x: number;
  /** Which way to turn to bring it into view. */
  side: "left" | "right" | null;
  /** Degrees to turn: negative left, positive right. */
  turn: number;
}

/** Where the mission's plate sits in the camera frame: bearing to the mission minus the phone's heading. */
export function platePlacement(bearingToMission: number, heading: number, fovDeg = CAMERA_FOV_DEG): Plate {
  const delta = turn(heading, bearingToMission);
  const visible = Math.abs(delta) <= fovDeg / 2;
  return {
    visible,
    x: Math.min(1, Math.max(0, 0.5 + delta / fovDeg)),
    side: visible ? null : delta < 0 ? "left" : "right",
    turn: delta,
  };
}

/**
 * Where an arrow sits on the border of a box so that it points at something
 * `angle` degrees clockwise from "up". Returns the point, inset from the edge.
 */
export function edgePoint(angle: number, width: number, height: number, inset = 0): { x: number; y: number } {
  const a = normalise(angle) * RAD;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const halfW = Math.max(1, width / 2 - inset), halfH = Math.max(1, height / 2 - inset);
  const scale = Math.min(Math.abs(dx) < 1e-9 ? Infinity : halfW / Math.abs(dx), Math.abs(dy) < 1e-9 ? Infinity : halfH / Math.abs(dy));
  return { x: width / 2 + dx * scale, y: height / 2 + dy * scale };
}

/** Heading from two GPS fixes, once the person has moved far enough for it to mean something. */
export function courseBetween(previous: LngLat, current: LngLat, minMoveM = 5): number | null {
  return distanceM(previous, current) >= minMoveM ? bearingDeg(previous, current) : null;
}
