import { describe, expect, it } from "vitest";
import { buildGraphIndex, findRoute, nearestEdge, type PedestrianGraph } from "@ion/core";
import { choosePlacement, findPlacements } from "./placement";
import { ladder } from "./testing";

const atTime = "2026-11-22T10:00:00Z";
const bounds = { minDecisionAheadM: 40, minExtraM: 15, maxExtraM: 250, targetExtraM: 60, atTime };

function walk() {
  const { index, graph } = ladder();
  const result = findRoute(index, "A", "E");
  if (!result.ok) throw new Error("no route on the ladder");
  return { index, graph, route: result.route };
}

describe("where the demo obstacle goes", () => {
  it("picks the nearest edge ahead whose closure gives a visible detour with enough warning", () => {
    const { index, route } = walk();
    expect(route.edges).toEqual(["A-B", "B-C", "C-D", "D-E"]);
    const placement = choosePlacement(index, route, 0, bounds)!;
    expect(placement.edgeId).toBe("B-C"); // turn at B, 100 m ahead
    expect(placement.decisionNode).toBe("B");
    expect(placement.distanceToDecisionM).toBeCloseTo(100, 0);
    expect(placement.extraDistanceM).toBeCloseTo(80, 0);
    expect(placement.relaxed).toBe(false);
  });

  it("puts the point on the chosen edge, where a nearest-edge search finds that edge again", () => {
    const { index, route } = walk();
    const placement = choosePlacement(index, route, 0, bounds)!;
    expect(nearestEdge(index, placement.position, 25)?.edge.id).toBe(placement.edgeId);
  });

  it("moves further ahead when more warning is asked for", () => {
    const { index, route } = walk();
    const placement = choosePlacement(index, route, 30, { ...bounds, minDecisionAheadM: 120 })!;
    expect(placement.edgeId).toBe("C-D");
    expect(placement.distanceToDecisionM).toBeCloseTo(170, 0);
    expect(placement.distanceToDecisionM).toBeGreaterThanOrEqual(120);
  });

  it("never chooses an edge behind the walker or one without a way round", () => {
    const { index, route } = walk();
    const ids = findPlacements(index, route, 150, bounds).map((p) => p.edgeId);
    expect(ids).not.toContain("A-B"); // behind, and a dead end
    expect(ids).not.toContain("B-C"); // the walker is on it, past its start: no junction left before it
    expect(ids[0]).toBe("C-D");
  });

  it("marks the choice as relaxed when no edge meets the bounds, and prefers the most warning", () => {
    const { index, route } = walk();
    const placement = choosePlacement(index, route, 0, { ...bounds, minDecisionAheadM: 1000 })!;
    expect(placement.relaxed).toBe(true);
    expect(placement.edgeId).toBe("D-E");
  });

  it("returns nothing on a street with no other way", () => {
    const { graph } = ladder();
    const line: PedestrianGraph = { ...graph, edges: graph.edges.filter((e) => e.name === "Αθηνάς") };
    const index = buildGraphIndex(line);
    const result = findRoute(index, "A", "E");
    if (!result.ok) throw new Error("no route");
    expect(choosePlacement(index, result.route, 0, bounds)).toBeNull();
  });

  it("respects the bounds on the extra distance", () => {
    const { index, route } = walk();
    const all = findPlacements(index, route, 0, { ...bounds, maxExtraM: 50 });
    expect(all.every((p) => p.relaxed)).toBe(true);
  });
});
