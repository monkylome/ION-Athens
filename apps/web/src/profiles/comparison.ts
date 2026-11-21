import type { ProfileId, Route, routeFacts } from "@ion/core";

export interface Compared {
  profile: ProfileId;
  route: Route | null;
  lengthM: number | null;
  facts: ReturnType<typeof routeFacts> | null;
}

export function comparisonPair(query: URLSearchParams) {
  function point(key: string, fallback: [number, number]) {
    const parts = query.get(key)?.split(",");
    const [lng, lat] = parts?.map(Number) ?? [];
    if (parts?.length === 2 && parts.every(p => p.trim()) && Math.abs(lng!) <= 180 && Math.abs(lat!) <= 90)
      return { lng: lng!, lat: lat! };
    return { lng: fallback[0], lat: fallback[1] };
  }
  return { from: point("compareFrom", [23.7257, 37.9762]), to: point("compareTo", [23.727198, 37.978602]) };
}

export function updateQuiet(current: Compared[], fresh: Compared[]) {
  const quiet = fresh.find(r => r.profile === "quiet");
  return current.map(r => r.profile === "quiet" && quiet ? quiet : r);
}

export function caption(row: Compared) {
  const f = row.facts;
  if (!f || row.lengthM === null) return "Δεν βρέθηκε διαδρομή.";
  const distance = Math.round(row.lengthM) + " μέτρα";
  if (row.profile === "voice") return distance + " · " + f.tactileM + " μέτρα σε όδευση αφής";
  if (row.profile === "wheels") return distance + (f.stepsTaken === 0 ? " · χωρίς σκαλιά" : "") + " · διαβάσεις με δύο ράμπες: " + f.crossingsWithRamps;
  return distance + " · " + f.busyM + " μέτρα με επιβεβαιωμένο συνωστισμό";
}
