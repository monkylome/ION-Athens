/**
 * Flat-plane geometry for matching. Everything is projected once to metres
 * (x east, y north) around a fixed origin; over a 2.5 km box the error of this
 * projection is a few centimetres, far below the matching thresholds.
 */
import type { LngLat } from "@ion/core";

export type XY = [x: number, y: number];

const RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6371008.8;

export class Plane {
  private readonly kx: number;
  private readonly ky = RAD * EARTH_RADIUS_M;
  constructor(private readonly origin: LngLat) {
    this.kx = Math.cos(origin[1] * RAD) * RAD * EARTH_RADIUS_M;
  }
  toXY(p: readonly number[]): XY {
    return [(p[0]! - this.origin[0]) * this.kx, (p[1]! - this.origin[1]) * this.ky];
  }
}

export interface Segment {
  a: XY;
  b: XY;
  /** Index of the survey feature the segment belongs to. */
  feature: number;
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polylineLength(line: readonly XY[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += dist(line[i - 1]!, line[i]!);
  return total;
}

/** Angle between two directions as lines (0 to 90 degrees): direction of travel does not matter. */
export function lineAngleDeg(d1: XY, d2: XY): number {
  const n = Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]);
  if (n === 0) return 90;
  const cos = Math.min(1, Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) / n);
  return Math.acos(cos) / RAD;
}

export interface Projection {
  point: XY;
  distance: number;
  /** Position along the segment in metres, before clamping: below 0 or above the length means beside an end. */
  along: number;
  length: number;
}

/** Nearest point of a segment to p. */
export function projectOntoSegment(p: XY, a: XY, b: XY): Projection {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return { point: a, distance: dist(p, a), along: 0, length: 0 };
  const along = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length;
  const t = Math.min(1, Math.max(0, along / length));
  const point: XY = [a[0] + dx * t, a[1] + dy * t];
  return { point, distance: dist(p, point), along, length };
}

/** True when the open segments p1-p2 and q1-q2 cross each other. */
export function segmentsCross(p1: XY, p2: XY, q1: XY, q2: XY): boolean {
  const side = (a: XY, b: XY, c: XY) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = side(q1, q2, p1);
  const d2 = side(q1, q2, p2);
  const d3 = side(p1, p2, q1);
  const d4 = side(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export interface Sample {
  point: XY;
  /** Direction of the polyline at the sample, from its first point towards its last. */
  direction: XY;
}

/** `count` points spread evenly along a polyline, at the middle of equal parts (never on an end point). */
export function samplePolyline(line: readonly XY[], count: number): Sample[] {
  const total = polylineLength(line);
  const out: Sample[] = [];
  if (total === 0 || line.length < 2) return out;
  let i = 1;
  let walked = 0;
  for (let k = 0; k < count; k++) {
    const target = ((k + 0.5) / count) * total;
    while (i < line.length - 1 && walked + dist(line[i - 1]!, line[i]!) < target) {
      walked += dist(line[i - 1]!, line[i]!);
      i++;
    }
    const a = line[i - 1]!;
    const b = line[i]!;
    const seg = dist(a, b);
    const t = seg === 0 ? 0 : Math.min(1, (target - walked) / seg);
    out.push({ point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], direction: [b[0] - a[0], b[1] - a[1]] });
  }
  return out;
}

export function midpoint(line: readonly XY[]): Sample {
  return samplePolyline(line, 1)[0] ?? { point: line[0] ?? [0, 0], direction: [0, 0] };
}

/** Uniform grid over segments or points, for "everything within r metres of p" queries. */
export class Grid<T> {
  private readonly cells = new Map<string, T[]>();
  constructor(private readonly cellM = 25) {}
  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }
  private insert(minX: number, minY: number, maxX: number, maxY: number, item: T): void {
    for (let cx = Math.floor(minX / this.cellM); cx <= Math.floor(maxX / this.cellM); cx++) {
      for (let cy = Math.floor(minY / this.cellM); cy <= Math.floor(maxY / this.cellM); cy++) {
        const k = this.key(cx, cy);
        const cell = this.cells.get(k);
        if (cell) cell.push(item);
        else this.cells.set(k, [item]);
      }
    }
  }
  addSegment(a: XY, b: XY, item: T): void {
    this.insert(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), item);
  }
  addPoint(p: XY, item: T): void {
    this.insert(p[0], p[1], p[0], p[1], item);
  }
  /** Items whose cells touch the square of half-side r around p. May contain items further than r. */
  near(p: XY, r: number): Set<T> {
    const out = new Set<T>();
    for (let cx = Math.floor((p[0] - r) / this.cellM); cx <= Math.floor((p[0] + r) / this.cellM); cx++) {
      for (let cy = Math.floor((p[1] - r) / this.cellM); cy <= Math.floor((p[1] + r) / this.cellM); cy++) {
        for (const item of this.cells.get(this.key(cx, cy)) ?? []) out.add(item);
      }
    }
    return out;
  }
}
