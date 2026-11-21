import { describe, expect, it } from "vitest";
import { comparisonPair, updateQuiet, caption, type Compared } from "./comparison";

describe("stage comparison", () => {
  it("reads longitude, latitude overrides independently and rejects malformed coordinates", () => {
    const q = new URLSearchParams({ compareFrom: "23.71,37.98", compareTo: ",80" });
    expect(comparisonPair(q)).toEqual({ from: { lng: 23.71, lat: 37.98 }, to: { lng: 23.727198, lat: 37.978602 } });
  });
  it("keeps the two other routes when a crowd observation is confirmed", () => {
    const rows: Compared[] = (["voice", "wheels", "quiet"] as const).map(profile => ({ profile, route: null, lengthM: null, facts: null }));
    const fresh = rows.map(row => ({ ...row }));
    const next = updateQuiet(rows, fresh);
    expect(next[0]).toBe(rows[0]);
    expect(next[1]).toBe(rows[1]);
    expect(next[2]).toBe(fresh[2]);
    expect(caption(next[2]!)).toBe("Δεν βρέθηκε διαδρομή.");
  });
});
