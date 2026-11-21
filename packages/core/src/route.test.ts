import { describe, expect, it } from "vitest";
import { DEFAULT_COST_OPTIONS, edgeCost } from "./cost.ts";
import { bearingDeg, haversineM, turnDirection } from "./geo.ts";
import { buildGraphIndex, nearestEdge, nearestNode } from "./graph.ts";
import { findRoute } from "./route.ts";
import {
  NOW,
  at,
  crossingGraph,
  diamondGraph,
  ladderGraph,
  lineGraph,
  obstacle,
  streetGraph,
} from "./testing/fixtures.ts";
import type { Route } from "./types.ts";

function ok(result: ReturnType<typeof findRoute>): Route {
  if (!result.ok) throw new Error(`expected a route: ${result.message}`);
  return result.route;
}

describe("geometry and graph index", () => {
  it("measures distance and bearing", () => {
    expect(haversineM(at(0, 0), at(100, 0))).toBeCloseTo(100, 1);
    expect(haversineM(at(0, 0), at(30, 40))).toBeCloseTo(50, 1);
    expect(bearingDeg(at(0, 0), at(0, 100))).toBeCloseTo(0, 1);
    expect(bearingDeg(at(0, 0), at(100, 0))).toBeCloseTo(90, 1);
    expect(bearingDeg(at(0, 0), at(-100, 0))).toBeCloseTo(270, 1);
  });

  it("classifies turns", () => {
    expect(turnDirection(90, 95)).toBe("straight");
    expect(turnDirection(90, 0)).toBe("left");
    expect(turnDirection(90, 180)).toBe("right");
    expect(turnDirection(350, 20)).toBe("slight_right");
    expect(turnDirection(90, 230)).toBe("sharp_right");
    expect(turnDirection(90, 270)).toBe("u_turn");
  });

  it("indexes undirected edges and finds the nearest node and edge", () => {
    const index = buildGraphIndex(ladderGraph());
    expect(index.adjacency.get("B")!.map((n) => n.node).sort()).toEqual(["A", "B2", "C"]);
    expect(index.adjacency.get("A")!.map((n) => n.node)).toEqual(["B"]);

    const node = nearestNode(index, at(95, 5))!;
    expect(node.node.id).toBe("B");
    expect(node.distanceM).toBeCloseTo(Math.hypot(5, 5), 1);
    expect(nearestNode(index, at(5000, 5000), 50)).toBeNull();

    const edge = nearestEdge(index, at(150, 10))!;
    expect(edge.edge.id).toBe("B-C");
    expect(edge.distanceM).toBeCloseTo(10, 1);
    expect(edge.alongM).toBeCloseTo(50, 1);
  });
});

describe("cost model", () => {
  const index = buildGraphIndex(streetGraph());
  const pavement = index.edges.get("P0-P1")!;

  it("penalises steps and shared roads, and rewards tactile paving", () => {
    const len = pavement.lengthM;
    expect(edgeCost(pavement, [], NOW)).toBeCloseTo(len);
    expect(edgeCost({ ...pavement, kind: "steps" }, [], NOW)).toBeCloseTo(
      len + DEFAULT_COST_OPTIONS.stepsPenaltyM,
    );
    expect(edgeCost({ ...pavement, kind: "shared_road" }, [], NOW)).toBeCloseTo(len * 2);
    expect(edgeCost({ ...pavement, tactilePaving: "yes" }, [], NOW)).toBeLessThan(len);
    expect(edgeCost({ ...pavement, tactilePaving: "unknown" }, [], NOW)).toBeCloseTo(len);
    expect(edgeCost(pavement, [], NOW, { stepsPenaltyM: 5 })).toBeCloseTo(len);
  });

  it("orders crossings: sound, no confirmed sound, unsignalled", () => {
    const crossing = index.edges.get("P1-P2")!;
    const cost = (signals: "yes" | "no" | "unknown", sound: "yes" | "no" | "unknown") =>
      edgeCost({ ...crossing, crossing: { signals, sound, marked: "unknown" } }, [], NOW) -
      crossing.lengthM;
    expect(cost("yes", "yes")).toBeCloseTo(10);
    expect(cost("yes", "no")).toBeCloseTo(60);
    // "unknown" sound is not confirmed: it costs the same as no sound, never less.
    expect(cost("yes", "unknown")).toBeCloseTo(60);
    expect(cost("no", "no")).toBeCloseTo(300);
    // Unknown signals: dearer than any signalled crossing, cheaper than a confirmed "no".
    expect(cost("unknown", "unknown")).toBeCloseTo(120);
    expect(cost("unknown", "yes")).toBeCloseTo(120);
    // A crossing edge without any crossing info is treated as all unknown.
    const { crossing: _dropped, ...bare } = crossing;
    expect(edgeCost(bare, [], NOW) - crossing.lengthM).toBeCloseTo(120);
  });

  it("applies obstacles by blocking level, confidence and expiry", () => {
    const len = pavement.lengthM;
    const id = pavement.id;
    expect(edgeCost(pavement, [obstacle(id)], NOW)).toBe(Infinity);
    expect(edgeCost(pavement, [obstacle(id, { confidence: 0.5 })], NOW)).toBe(Infinity);
    expect(edgeCost(pavement, [obstacle(id, { confidence: 0.49 })], NOW)).toBeCloseTo(len * 3);
    expect(edgeCost(pavement, [obstacle(id, { blocks: "partial" })], NOW)).toBeCloseTo(len * 3);
    expect(
      edgeCost(pavement, [obstacle(id, { expiresAt: "2026-11-22T09:59:59Z" })], NOW),
    ).toBeCloseTo(len);
    expect(edgeCost(pavement, [obstacle(id, { expiresAt: "2026-11-22T10:00:01Z" })], NOW)).toBe(
      Infinity,
    );
    // Obstacles on other edges do not count.
    expect(edgeCost(pavement, [obstacle("somewhere-else")], NOW)).toBeCloseTo(len);
  });
});

describe("findRoute", () => {
  it("finds the plain shortest path with stitched geometry and steps", () => {
    const index = buildGraphIndex(ladderGraph());
    const route = ok(findRoute(index, "A", "E"));
    expect(route.nodes).toEqual(["A", "B", "C", "D", "E"]);
    expect(route.edges).toEqual(["A-B", "B-C", "C-D", "D-E"]);
    expect(route.lengthM).toBeCloseTo(400, 0);
    expect(route.cost).toBeCloseTo(400, 0);
    expect(route.geometry).toHaveLength(5);
    expect(route.geometry[0]).toEqual(at(0, 0));
    expect(route.steps.map((s) => s.kind)).toEqual(["depart", "arrive"]);
    expect(route.steps[0]!.onto).toBe("Ερμού");
    expect(route.startOffsetM).toBeUndefined();
  });

  it("reverses edge geometry when an edge is walked backwards", () => {
    const index = buildGraphIndex(ladderGraph());
    const route = ok(findRoute(index, "E", "A"));
    expect(route.nodes).toEqual(["E", "D", "C", "B", "A"]);
    expect(route.geometry[0]).toEqual(at(400, 0));
    expect(route.geometry[4]).toEqual(at(0, 0));
    for (let i = 1; i < route.geometry.length; i++) {
      expect(haversineM(route.geometry[i - 1]!, route.geometry[i]!)).toBeCloseTo(100, 0);
    }
  });

  it("computes turn directions, crossing steps and street names", () => {
    const index = buildGraphIndex(streetGraph());
    const route = ok(findRoute(index, "P0", "P4"));
    expect(route.steps).toHaveLength(4);
    const [depart, crossing, turn, arrive] = route.steps;
    expect(depart).toMatchObject({ kind: "depart", atNode: "P0", onto: "Ερμού" });
    expect(crossing).toMatchObject({
      kind: "crossing",
      atNode: "P1",
      direction: "straight",
      crossing: { signals: "yes", sound: "no", marked: "yes" },
    });
    expect(crossing!.atDistanceM).toBeCloseTo(60, 0);
    expect(turn).toMatchObject({ kind: "turn", atNode: "P3", direction: "left", onto: "Βουλής" });
    expect(turn!.atDistanceM).toBeCloseTo(120, 0);
    expect(arrive).toMatchObject({ kind: "arrive", atNode: "P4" });
    expect(arrive!.atDistanceM).toBeCloseTo(180, 0);

    const back = ok(findRoute(index, "P4", "P0"));
    expect(back.steps.find((s) => s.kind === "turn")).toMatchObject({
      atNode: "P3",
      direction: "right",
      onto: "Ερμού",
    });
  });

  it("detours around a full obstacle", () => {
    const index = buildGraphIndex(ladderGraph());
    const route = ok(findRoute(index, "A", "E", { atTime: NOW, obstacles: [obstacle("D-E")] }));
    expect(route.edges).not.toContain("D-E");
    expect(route.lengthM).toBeCloseTo(600, 0);
    expect(route.nodes[0]).toBe("A");
    expect(route.nodes.at(-1)).toBe("E");
  });

  it("avoids a partial obstacle only when the other way is cheaper", () => {
    const index = buildGraphIndex(diamondGraph());
    const partial = obstacle("M-T", { blocks: "partial" });
    // Factor 3: 300 through the obstacle against about 156 round it.
    const detour = ok(findRoute(index, "S", "T", { atTime: NOW, obstacles: [partial] }));
    expect(detour.nodes).toEqual(["S", "M", "X", "T"]);
    // Factor 1.2: 120 through the obstacle is still cheaper.
    const through = ok(
      findRoute(index, "S", "T", {
        atTime: NOW,
        obstacles: [partial],
        cost: { partialObstacleFactor: 1.2 },
      }),
    );
    expect(through.nodes).toEqual(["S", "M", "T"]);
    expect(through.lengthM).toBeCloseTo(200, 0);
    expect(through.cost).toBeCloseTo(220, 0);
  });

  it("ignores an expired obstacle", () => {
    const index = buildGraphIndex(diamondGraph());
    const expired = obstacle("M-T", { expiresAt: "2026-11-22T09:00:00Z" });
    const route = ok(findRoute(index, "S", "T", { atTime: NOW, obstacles: [expired] }));
    expect(route.nodes).toEqual(["S", "M", "T"]);
    expect(route.cost).toBeCloseTo(200, 0);
    // The same obstacle still counts before it expires.
    const earlier = ok(
      findRoute(index, "S", "T", { atTime: "2026-11-22T08:00:00Z", obstacles: [expired] }),
    );
    expect(earlier.nodes).toEqual(["S", "M", "X", "T"]);
  });

  it("does not close an edge for a low-confidence full obstacle", () => {
    const unsure = obstacle("M-T", { confidence: 0.3 });
    // With no other way, the edge is still usable, at a higher cost.
    const line = buildGraphIndex(lineGraph());
    const route = ok(findRoute(line, "S", "T", { atTime: NOW, obstacles: [unsure] }));
    expect(route.nodes).toEqual(["S", "M", "T"]);
    expect(route.cost).toBeCloseTo(400, 0);
    // The same obstacle at full confidence leaves no route.
    expect(findRoute(line, "S", "T", { atTime: NOW, obstacles: [obstacle("M-T")] }).ok).toBe(false);
  });

  it("prefers a longer way through a signalled crossing with sound", () => {
    const unsignalled = { signals: "no", sound: "no", marked: "yes" } as const;
    const withSound = { signals: "yes", sound: "yes", marked: "yes" } as const;
    const longer = ok(findRoute(buildGraphIndex(crossingGraph(unsignalled, withSound)), "S", "T"));
    expect(longer.nodes).toEqual(["S", "V1", "V2", "T"]);
    expect(longer.lengthM).toBeGreaterThan(150);

    // When both crossings are equally good, the shorter way wins.
    const shorter = ok(findRoute(buildGraphIndex(crossingGraph(withSound, withSound)), "S", "T"));
    expect(shorter.nodes).toEqual(["S", "U1", "U2", "T"]);

    // Signals with unknown sound still beat no signals.
    const unknownSound = { signals: "yes", sound: "unknown", marked: "yes" } as const;
    const stillLonger = ok(
      findRoute(buildGraphIndex(crossingGraph(unsignalled, unknownSound)), "S", "T"),
    );
    expect(stillLonger.nodes).toEqual(["S", "V1", "V2", "T"]);

    // An untagged crossing loses to signals with sound, but beats a confirmed unsignalled one.
    const untagged = { signals: "unknown", sound: "unknown", marked: "unknown" } as const;
    const avoidUntagged = ok(findRoute(buildGraphIndex(crossingGraph(untagged, withSound)), "S", "T"));
    expect(avoidUntagged.nodes).toEqual(["S", "V1", "V2", "T"]);
    const preferUntagged = ok(
      findRoute(buildGraphIndex(crossingGraph(unsignalled, untagged)), "S", "T"),
    );
    expect(preferUntagged.nodes).toEqual(["S", "V1", "V2", "T"]);
  });

  it("returns a clear no-route result instead of throwing", () => {
    const index = buildGraphIndex(lineGraph());
    const blocked = findRoute(index, "S", "T", { atTime: NOW, obstacles: [obstacle("S-M")] });
    expect(blocked).toMatchObject({ ok: false, reason: "no_route" });
    expect(findRoute(index, "S", "nowhere")).toMatchObject({ ok: false, reason: "unknown_node" });
    const same = ok(findRoute(index, "S", "S"));
    expect(same.lengthM).toBe(0);
    expect(same.nodes).toEqual(["S"]);
  });
});
