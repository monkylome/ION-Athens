import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "./graph.ts";
import { checkObstacleRemoved, rerouteForObstacle } from "./reroute.ts";
import { findRoute } from "./route.ts";
import { NOW, at, ladderGraph, lineGraph, diamondGraph, obstacle } from "./testing/fixtures.ts";
import type { Route } from "./types.ts";

const index = buildGraphIndex(ladderGraph());

function baseRoute(): Route {
  const result = findRoute(index, "A", "E");
  if (!result.ok) throw new Error("fixture route missing");
  return result.route;
}

describe("rerouteForObstacle", () => {
  it("reports an obstacle that does not matter", () => {
    const route = baseRoute();
    const off = rerouteForObstacle(index, route, 50, obstacle("C2-D2"), { atTime: NOW });
    expect(off).toMatchObject({ outcome: "not_relevant", reason: "not_on_route" });
    expect(off.route).toBe(route);

    const behind = rerouteForObstacle(index, route, 150, obstacle("A-B"), { atTime: NOW });
    expect(behind).toMatchObject({ outcome: "not_relevant", reason: "behind_walker" });

    const expired = obstacle("D-E", { expiresAt: "2026-11-22T09:00:00Z" });
    expect(rerouteForObstacle(index, route, 50, expired, { atTime: NOW })).toMatchObject({
      outcome: "not_relevant",
      reason: "inactive",
    });

    // On the walker's own edge, a known position behind them does not matter either.
    const passed = obstacle("D-E", { position: at(320, 0) });
    expect(rerouteForObstacle(index, route, 350, passed, { atTime: NOW })).toMatchObject({
      outcome: "not_relevant",
      reason: "behind_walker",
    });
  });

  it("reroutes at the last junction before the blocked edge", () => {
    const route = baseRoute();
    const result = rerouteForObstacle(index, route, 50, obstacle("D-E"), { atTime: NOW });
    if (result.outcome !== "reroute") throw new Error(`unexpected outcome ${result.outcome}`);
    expect(result.decisionNode).toBe("D");
    expect(result.distanceToDecisionM).toBeCloseTo(250, 0);
    expect(result.distanceToObstacleM).toBeCloseTo(250, 0);
    expect(result.turnDirection).toBe("left");
    expect(result.extraDistanceM).toBeCloseTo(200, 0);
    expect(result.lateWarning).toBe(false);
    expect(result.progressM).toBe(50);
    // Full route: the walked part and the way to the decision node, then the new remainder.
    expect(result.route.nodes).toEqual(["A", "B", "C", "D", "D2", "E2", "E"]);
    expect(result.route.lengthM).toBeCloseTo(600, 0);
    expect(result.route.geometry[0]).toEqual(at(0, 0));
    const turns = result.route.steps.filter((s) => s.kind === "turn");
    expect(turns.map((s) => [s.atNode, s.direction])).toEqual([
      ["D", "left"],
      ["D2", "right"],
      ["E2", "right"],
    ]);
    expect(turns[1]!.onto).toBe("Μητροπόλεως");
  });

  it("uses an earlier junction when the last one has no other way", () => {
    // Without the rung at D, the last junction with another way is C.
    const graph = ladderGraph();
    graph.edges = graph.edges.filter((e) => e.id !== "D-D2");
    const pruned = buildGraphIndex(graph);
    const found = findRoute(pruned, "A", "E");
    if (!found.ok) throw new Error("fixture route missing");
    const result = rerouteForObstacle(pruned, found.route, 50, obstacle("D-E"), { atTime: NOW });
    if (result.outcome !== "reroute") throw new Error(`unexpected outcome ${result.outcome}`);
    expect(result.decisionNode).toBe("C");
    expect(result.distanceToDecisionM).toBeCloseTo(150, 0);
    expect(result.route.nodes).toEqual(["A", "B", "C", "C2", "D2", "E2", "E"]);
  });

  it("turns at a junction that is closer than the warning distance, as a late warning", () => {
    const route = baseRoute();
    // 10 m before D: the walker still turns there rather than walking back to C.
    const result = rerouteForObstacle(index, route, 290, obstacle("D-E"), { atTime: NOW });
    if (result.outcome !== "reroute") throw new Error(`unexpected outcome ${result.outcome}`);
    expect(result.lateWarning).toBe(true);
    expect(result.decisionNode).toBe("D");
    expect(result.distanceToDecisionM).toBeCloseTo(10, 0);
    expect(result.turnDirection).toBe("left");
    expect(result.progressM).toBe(290);
    expect(result.route.nodes).toEqual(["A", "B", "C", "D", "D2", "E2", "E"]);
    expect(result.extraDistanceM).toBeCloseTo(200, 0);
    expect(result).not.toHaveProperty("skippedTooCloseNode");

    // At exactly the warning distance it is an ordinary reroute.
    const edge = rerouteForObstacle(index, route, 275, obstacle("D-E"), { atTime: NOW });
    expect(edge).toMatchObject({ outcome: "reroute", decisionNode: "D", lateWarning: false });
    const justInside = rerouteForObstacle(index, route, 280, obstacle("D-E"), { atTime: NOW });
    expect(justInside).toMatchObject({ outcome: "reroute", decisionNode: "D", lateWarning: true });

    // The threshold is tunable.
    const relaxed = rerouteForObstacle(index, route, 290, obstacle("D-E"), {
      atTime: NOW,
      minWarningDistanceM: 5,
    });
    expect(relaxed).toMatchObject({ outcome: "reroute", decisionNode: "D", lateWarning: false });
  });

  it("turns the walker back when they are past every usable junction", () => {
    const route = baseRoute();
    // Already on the blocked edge, 50 m past D.
    const result = rerouteForObstacle(index, route, 350, obstacle("D-E"), { atTime: NOW });
    if (result.outcome !== "turn_back") throw new Error(`unexpected outcome ${result.outcome}`);
    expect(result.progressM).toBe(0);
    expect(result.decisionNode).toBe("D");
    expect(result.distanceToDecisionM).toBeCloseTo(50, 0);
    expect(result.turnDirection).toBe("right");
    // The new route starts where the walker stands and first goes back along D-E.
    expect(result.route.geometry[0]![0]).toBeCloseTo(at(350, 0)[0], 6);
    expect(result.route.edges).toEqual(["D-E", "D-D2", "D2-E2", "E-E2"]);
    expect(result.route.startOffsetM).toBeCloseTo(50, 0);
    expect(result.route.lengthM).toBeCloseTo(350, 0);
    expect(result.route.steps[0]).toMatchObject({ kind: "depart", direction: "u_turn" });
    expect(result.route.steps[1]).toMatchObject({ kind: "turn", atNode: "D", direction: "right" });
    expect(result.route.steps[1]!.atDistanceM).toBeCloseTo(50, 0);
    expect(result.extraDistanceM).toBeCloseTo(300, 0);

    // An obstacle position ahead on the same edge gives the distance to it.
    const ahead = obstacle("D-E", { position: at(380, 0) });
    const withPosition = rerouteForObstacle(index, route, 350, ahead, { atTime: NOW });
    expect(withPosition.outcome).toBe("turn_back");
    if (withPosition.outcome === "turn_back") {
      expect(withPosition.distanceToObstacleM).toBeCloseTo(30, 0);
    }
  });

  it("turns back only when no junction ahead offers another way", () => {
    // Without the rung at D, a walker past C has no junction left before the blocked edge.
    const graph = ladderGraph();
    graph.edges = graph.edges.filter((e) => e.id !== "D-D2");
    const pruned = buildGraphIndex(graph);
    const found = findRoute(pruned, "A", "E");
    if (!found.ok) throw new Error("fixture route missing");
    const result = rerouteForObstacle(pruned, found.route, 290, obstacle("D-E"), { atTime: NOW });
    if (result.outcome !== "turn_back") throw new Error(`unexpected outcome ${result.outcome}`);
    expect(result.decisionNode).toBe("C");
    expect(result.distanceToDecisionM).toBeCloseTo(90, 0);
    expect(result.turnDirection).toBe("right");
    expect(result.route.edges).toEqual(["C-D", "C-C2", "C2-D2", "D2-E2", "E-E2"]);
    expect(result.route.lengthM).toBeCloseTo(490, 0);
    expect(result.extraDistanceM).toBeCloseTo(380, 0);

    // 10 m before the only junction with another way: a late turn there, not a walk back.
    const diamond = buildGraphIndex(diamondGraph());
    const short = findRoute(diamond, "S", "T");
    if (!short.ok) throw new Error("fixture route missing");
    const late = rerouteForObstacle(diamond, short.route, 90, obstacle("M-T"), { atTime: NOW });
    expect(late).toMatchObject({ outcome: "reroute", decisionNode: "M", lateWarning: true });
  });

  it("reports when no other way exists at all", () => {
    const line = buildGraphIndex(lineGraph());
    const found = findRoute(line, "S", "T");
    if (!found.ok) throw new Error("fixture route missing");
    const result = rerouteForObstacle(line, found.route, 50, obstacle("M-T"), { atTime: NOW });
    expect(result.outcome).toBe("no_alternative");
    expect(result.route).toBe(found.route);
  });

  it("keeps the route for a partial obstacle unless another way is cheaper", () => {
    const route = baseRoute();
    // D-E at factor 2 costs 200, the way round from D costs 300: staying is cheaper.
    const partial = obstacle("D-E", { blocks: "partial" });
    const stay = rerouteForObstacle(index, route, 50, partial, {
      atTime: NOW,
      cost: { partialObstacleFactor: 2 },
    });
    expect(stay).toMatchObject({ outcome: "keep_route", blockedEdgeId: "D-E" });
    // At factor 5 the way round is cheaper.
    const leave = rerouteForObstacle(index, route, 50, partial, {
      atTime: NOW,
      cost: { partialObstacleFactor: 5 },
    });
    expect(leave).toMatchObject({ outcome: "reroute", decisionNode: "D" });
    // A partial obstacle never sends the walker back.
    const late = rerouteForObstacle(index, route, 350, partial, {
      atTime: NOW,
      cost: { partialObstacleFactor: 5 },
    });
    expect(late.outcome).toBe("keep_route");
  });

  it("respects obstacles that were already known", () => {
    const route = baseRoute();
    // D-D2 is already closed, so the turn has to happen at C.
    const result = rerouteForObstacle(index, route, 50, obstacle("D-E"), {
      atTime: NOW,
      obstacles: [obstacle("D-D2")],
    });
    expect(result).toMatchObject({ outcome: "reroute", decisionNode: "C" });
  });
});

describe("checkObstacleRemoved", () => {
  it("offers the short route again once the obstacle is gone", () => {
    const blocked = obstacle("D-E");
    const rerouted = rerouteForObstacle(index, baseRoute(), 50, blocked, { atTime: NOW });
    if (rerouted.outcome !== "reroute") throw new Error("fixture reroute missing");

    // Still there: nothing changes.
    const still = checkObstacleRemoved(index, rerouted.route, 60, {
      atTime: NOW,
      obstacles: [blocked],
    });
    expect(still.outcome).toBe("keep_route");

    // Removed: the direct way is back.
    const cleared = checkObstacleRemoved(index, rerouted.route, 60, { atTime: NOW, obstacles: [] });
    if (cleared.outcome !== "shorter_available") throw new Error("expected a shorter route");
    expect(cleared.route.nodes).toEqual(["A", "B", "C", "D", "E"]);
    expect(cleared.route.lengthM).toBeCloseTo(400, 0);
    expect(cleared.savedDistanceM).toBeCloseTo(200, 0);
    expect(cleared.decisionNode).toBe("D");
    expect(cleared.distanceToDecisionM).toBeCloseTo(240, 0);
    expect(cleared.turnDirection).toBe("straight");

    // The same happens when the obstacle simply expires.
    const expiring = { ...blocked, expiresAt: "2026-11-22T10:30:00Z" };
    const later = checkObstacleRemoved(index, rerouted.route, 60, {
      atTime: "2026-11-22T11:00:00Z",
      obstacles: [expiring],
    });
    expect(later.outcome).toBe("shorter_available");

    // Past the point where the routes part, the walker is not sent back.
    const past = checkObstacleRemoved(index, rerouted.route, 350, { atTime: NOW, obstacles: [] });
    expect(past.outcome).toBe("keep_route");
  });
});
