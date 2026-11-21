/**
 * Small planar geometry helpers. Central Athens is a few kilometres wide, so a
 * local equirectangular projection is accurate to well under a metre.
 */
import type { LngLat } from "@ion/core";

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LNG_EQUATOR = 111_320;

export type XY = [x: number, y: number];

export function toXY(p: LngLat, ref: LngLat): XY {
  const k = Math.cos((ref[1] * Math.PI) / 180) * M_PER_DEG_LNG_EQUATOR;
  return [(p[0] - ref[0]) * k, (p[1] - ref[1]) * M_PER_DEG_LAT];
}

export function fromXY(xy: XY, ref: LngLat): LngLat {
  const k = Math.cos((ref[1] * Math.PI) / 180) * M_PER_DEG_LNG_EQUATOR;
  return [ref[0] + xy[0] / k, ref[1] + xy[1] / M_PER_DEG_LAT];
}

export function distanceM(a: LngLat, b: LngLat): number {
  const [x, y] = toXY(b, a);
  return Math.hypot(x, y);
}

export interface LineHit {
  distanceM: number;
  /** Closest point on the line. */
  point: LngLat;
  /** Index of the segment that holds the closest point. */
  segment: number;
}

/** Distance from a point to a polyline. A single-point line is treated as a point. */
export function pointToLine(p: LngLat, line: readonly LngLat[]): LineHit | null {
  const first = line[0];
  if (!first) return null;
  let best: LineHit = { distanceM: distanceM(p, first), point: first, segment: 0 };
  for (let i = 0; i + 1 < line.length; i++) {
    const a = toXY(line[i]!, p);
    const b = toXY(line[i + 1]!, p);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len2));
    const cx = a[0] + t * dx;
    const cy = a[1] + t * dy;
    const d = Math.hypot(cx, cy);
    if (d < best.distanceM) best = { distanceM: d, point: fromXY([cx, cy], p), segment: i };
  }
  return best;
}

export function lineLengthM(line: readonly LngLat[]): number {
  let total = 0;
  for (let i = 0; i + 1 < line.length; i++) total += distanceM(line[i]!, line[i + 1]!);
  return total;
}

/** Points along a line every `stepM` metres, always including both ends. */
export function sampleLine(line: readonly LngLat[], stepM: number): LngLat[] {
  const first = line[0];
  if (!first) return [];
  const total = lineLengthM(line);
  if (total === 0) return [first];
  const n = Math.max(2, Math.ceil(total / stepM));
  const out: LngLat[] = [];
  let seg = 0;
  let segStart = 0;
  let segLen = distanceM(line[0]!, line[1]!);
  for (let i = 0; i <= n; i++) {
    const target = (total * i) / n;
    while (seg + 2 < line.length && target > segStart + segLen) {
      segStart += segLen;
      seg++;
      segLen = distanceM(line[seg]!, line[seg + 1]!);
    }
    const a = line[seg]!;
    const b = line[seg + 1]!;
    const t = segLen === 0 ? 0 : Math.max(0, Math.min(1, (target - segStart) / segLen));
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Bearing of a→b in degrees, 0 = north, clockwise. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const [x, y] = toXY(b, a);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/** Angle between two undirected lines, 0 to 90 degrees. */
export function undirectedAngleDeg(b1: number, b2: number): number {
  const d = Math.abs(b1 - b2) % 180;
  return d > 90 ? 180 - d : d;
}

export function pointInRing(p: LngLat, ring: readonly LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

export type BBox = [west: number, south: number, east: number, north: number];

export function bboxOf(points: readonly LngLat[]): BBox | null {
  if (points.length === 0) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of points) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

export function expandBBox(b: BBox, metres: number): BBox {
  const dLat = metres / M_PER_DEG_LAT;
  const dLng = metres / (Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180) * M_PER_DEG_LNG_EQUATOR);
  return [b[0] - dLng, b[1] - dLat, b[2] + dLng, b[3] + dLat];
}
