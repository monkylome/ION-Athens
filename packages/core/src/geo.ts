/**
 * Geometry helpers. Coordinates are [lng, lat] in WGS84, distances in metres,
 * bearings in degrees clockwise from north (0 to 360).
 */
import type { LngLat, TurnDirection } from "./types.ts";

const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in metres between two [lng, lat] points. */
export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, degrees clockwise from north, 0 <= bearing < 360. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * RAD;
  const lat2 = b[1] * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  if (x === 0 && y === 0) return 0;
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Signed change of heading from one bearing to another, in (-180, 180]. Positive is to the right. */
export function angleDiffDeg(fromBearing: number, toBearing: number): number {
  let d = (toBearing - fromBearing) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Turn direction for a change of heading.
 * Under 20 degrees is straight, under 45 slight, under 120 a normal turn,
 * under 160 sharp, anything more a U-turn.
 */
export function turnDirection(inBearing: number, outBearing: number): TurnDirection {
  const d = angleDiffDeg(inBearing, outBearing);
  const a = Math.abs(d);
  if (a < 20) return "straight";
  if (a >= 160) return "u_turn";
  const side = d > 0 ? "right" : "left";
  if (a < 45) return `slight_${side}`;
  if (a < 120) return side;
  return `sharp_${side}`;
}

/** Length of a polyline in metres. */
export function polylineLengthM(line: readonly LngLat[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += haversineM(line[i - 1]!, line[i]!);
  return total;
}

function lerp(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Point at a distance along a polyline (clamped to its ends), with the bearing
 * of the segment it lies on.
 */
export function pointAlongPolyline(
  line: readonly LngLat[],
  distanceM: number,
): { point: LngLat; bearing: number } {
  const first = line[0];
  if (!first) throw new RangeError("pointAlongPolyline: empty polyline");
  if (line.length === 1) return { point: [first[0], first[1]], bearing: 0 };
  let remaining = Math.max(0, distanceM);
  let lastBearing = 0;
  let haveBearing = false;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const seg = haversineM(a, b);
    if (seg === 0) continue;
    lastBearing = bearingDeg(a, b);
    haveBearing = true;
    if (remaining <= seg) return { point: lerp(a, b, remaining / seg), bearing: lastBearing };
    remaining -= seg;
  }
  const last = line[line.length - 1]!;
  return { point: [last[0], last[1]], bearing: haveBearing ? lastBearing : 0 };
}

/** The part of a polyline between two distances along it. Always at least two points. */
export function slicePolyline(line: readonly LngLat[], fromM: number, toM: number): LngLat[] {
  const start = pointAlongPolyline(line, fromM).point;
  const end = pointAlongPolyline(line, Math.max(fromM, toM)).point;
  const out: LngLat[] = [start];
  let walked = 0;
  for (let i = 1; i < line.length; i++) {
    walked += haversineM(line[i - 1]!, line[i]!);
    if (walked > fromM && walked < toM) out.push([line[i]![0], line[i]![1]]);
  }
  out.push(end);
  return out;
}

/** Nearest point on a polyline to p: the point, its distance from p, and how far along the line it is. */
export function projectOntoPolyline(
  line: readonly LngLat[],
  p: LngLat,
): { point: LngLat; distanceM: number; alongM: number } {
  const first = line[0];
  if (!first) throw new RangeError("projectOntoPolyline: empty polyline");
  let best = { point: [first[0], first[1]] as LngLat, distanceM: haversineM(first, p), alongM: 0 };
  const kx = Math.cos(p[1] * RAD) * RAD * EARTH_RADIUS_M;
  const ky = RAD * EARTH_RADIUS_M;
  let walked = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const seg = haversineM(a, b);
    // Local flat projection centred on p.
    const ax = (a[0] - p[0]) * kx;
    const ay = (a[1] - p[1]) * ky;
    const bx = (b[0] - p[0]) * kx;
    const by = (b[1] - p[1]) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (d < best.distanceM) best = { point: lerp(a, b, t), distanceM: d, alongM: walked + seg * t };
    walked += seg;
  }
  return best;
}
