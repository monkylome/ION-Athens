/** Finds street names of the walking graph in free text, and measures how far a street is from a point. */
import type { LngLat } from "@ion/core";
import { distanceM, pointToLine } from "../geo.ts";
import { fold } from "./text.ts";

const PREFIXES = new Set(["ΟΔΟΣ", "ΛΕΩΦΟΡΟΣ", "Λ", "ΠΛΑΤΕΙΑ", "ΠΛ", "ΠΕΖΟΔΡΟΜΟΣ", "ΠΕΖ"]);

export interface NamedEdge {
  name?: string;
  geometry: readonly LngLat[];
}

interface Street {
  name: string;
  core: string;
  lines: Array<readonly LngLat[]>;
}

export class StreetIndex {
  private readonly streets: Street[] = [];

  constructor(edges: readonly NamedEdge[]) {
    const byName = new Map<string, Street>();
    for (const e of edges) {
      if (!e.name || e.geometry.length === 0) continue;
      let street = byName.get(e.name);
      if (!street) {
        const words = fold(e.name).split(" ");
        while (words.length > 1 && PREFIXES.has(words[0]!)) words.shift();
        street = { name: e.name, core: words.join(" "), lines: [] };
        byName.set(e.name, street);
      }
      street.lines.push(e.geometry);
    }
    // Short cores ("ΑΡΗ") would match inside ordinary prose; a hint must not be noise.
    for (const s of byName.values()) if (s.core.length >= 4) this.streets.push(s);
  }

  get size(): number {
    return this.streets.length;
  }

  /** Graph street names that appear as whole words in the text. Hints, not facts. */
  match(text: string): string[] {
    const hay = ` ${fold(text)} `;
    return this.streets.filter((s) => hay.includes(` ${s.core} `)).map((s) => s.name);
  }

  /** Distance in metres from a point to the nearest edge of a street, or null for an unknown street. */
  distanceM(name: string, p: LngLat): number | null {
    const street = this.streets.find((s) => s.name === name);
    if (!street) return null;
    let best = Infinity;
    for (const line of street.lines) {
      const first = line[0]!;
      // Cheap reject before the exact distance: far-away edges cannot be the nearest.
      if (distanceM(p, first) > best + 400) continue;
      const hit = pointToLine(p, line as LngLat[]);
      if (hit && hit.distanceM < best) best = hit.distanceM;
    }
    return Number.isFinite(best) ? best : null;
  }
}
