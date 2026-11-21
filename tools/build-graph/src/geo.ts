import type { LngLat } from "../../../packages/core/src/types.ts";

const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function lineLengthM(line: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    total += haversineM(line[i - 1]!, line[i]!);
  }
  return total;
}

/** Distance from p to the segment a-b, on a local flat projection (fine for city scale). */
export function pointSegmentDistanceM(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = Math.cos(p[1] * RAD) * RAD * EARTH_RADIUS_M;
  const ky = RAD * EARTH_RADIUS_M;
  const ax = (a[0] - p[0]) * kx;
  const ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx;
  const by = (b[1] - p[1]) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** The point half way along a line, measured by length. */
export function midpointAlong(line: LngLat[]): LngLat {
  const half = lineLengthM(line) / 2;
  let walked = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const seg = haversineM(a, b);
    if (walked + seg >= half && seg > 0) {
      const t = (half - walked) / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    walked += seg;
  }
  return line[0]!;
}

export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
