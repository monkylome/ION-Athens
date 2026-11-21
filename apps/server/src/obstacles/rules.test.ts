import { describe, expect, it } from "vitest";
import { NOW, at, project, report, testEdges } from "../testing/fixtures.ts";
import { endOfDayAthens, mapSandboxData, projectToObstacles, reportToObstacle, snapConfidenceFactor, DEFAULT_MAPPING_OPTIONS, textSaysBlocked } from "./rules.ts";

const edges = testEdges();
const map = (r: Parameters<typeof report>[0], opts = {}) => reportToObstacle(report(r), edges, NOW, opts);
const obstacleOf = (r: Parameters<typeof report>[0], opts = {}) => {
  const out = map(r, opts);
  if (!("obstacle" in out)) throw new Error(`expected an obstacle, got ${out.skipped.reason}`);
  return out.obstacle;
};
const reasonOf = (r: Parameters<typeof report>[0]) => {
  const out = map(r);
  return "skipped" in out ? out.skipped.reason : "obstacle";
};

describe("reports: distance to the nearest edge", () => {
  it("accepts a report within 15 m at full confidence and records the distance", () => {
    const o = obstacleOf({ at: at(50, 5) });
    expect(o.edgeId).toBe("AB");
    expect(o.snapDistanceM).toBeCloseTo(5, 0);
    expect(o.confidence).toBe(0.6);
    expect(o.position).toEqual(at(50, 5));
  });

  it("lowers the confidence between 15 m and 25 m", () => {
    const o = obstacleOf({ at: at(50, -20) });
    expect(o.snapDistanceM).toBeCloseTo(20, 0);
    expect(o.confidence).toBeCloseTo(0.45, 2); // 0.6 x 0.75
    expect(snapConfidenceFactor(15, DEFAULT_MAPPING_OPTIONS)).toBe(1);
    expect(snapConfidenceFactor(25, DEFAULT_MAPPING_OPTIONS)).toBe(0.5);
  });

  it("rejects a report beyond 25 m and says how far it was", () => {
    const out = map({ at: at(50, -30) });
    expect(out).toEqual({ skipped: { ref: "req-1001", reason: "too_far_from_edge", snapDistanceM: 30 } });
  });

  it("rejects a report with no edge anywhere near, and one without coordinates", () => {
    expect(reasonOf({ at: at(50, -500) })).toBe("no_edge_nearby");
    expect(reasonOf({ lat: null, lng: null })).toBe("no_location");
  });

  it("takes the thresholds from the options", () => {
    expect(obstacleOf({ at: at(50, -30) }, { snapAcceptM: 40, snapRejectM: 50 }).confidence).toBe(0.6);
  });
});

describe("reports: categories", () => {
  it.each(["sidewalk", "tree", "garbage", "bulky_waste", "water_leak", "pothole"])("%s is an obstacle", (category) => {
    expect(obstacleOf({ category }).type).toBe(category);
  });

  it.each(["graffiti", "noise", "stray_animals", "streetlight"])("%s is not a routing obstacle", (category) => {
    expect(reasonOf({ category })).toBe("category_not_relevant");
  });

  it("abandoned_vehicle and other count only when the text says the pavement is blocked", () => {
    expect(reasonOf({ category: "abandoned_vehicle", title: "Εγκαταλελειμμένο αυτοκίνητο", description: "Χωρίς πινακίδες εδώ και μήνες." })).toBe("text_not_blocking");
    expect(reasonOf({ category: "abandoned_vehicle", title: "Παρατημένη μοτοσικλέτα", description: "Δεμένη σε κολόνα πάνω στο πεζοδρόμιο." })).toBe("obstacle");
    expect(reasonOf({ category: "other", title: "Χαλασμένο παγκάκι σε πάρκο", description: "" })).toBe("text_not_blocking");
    expect(reasonOf({ category: "other", title: "Σκαλωσιά κλείνει τη διάβαση", description: null })).toBe("obstacle");
  });

  it("reads the blocking words without accents and in capitals", () => {
    expect(textSaysBlocked({ title: "ΟΧΗΜΑ ΣΤΟ ΠΕΖΟΔΡΟΜΙΟ", description: null })).toBe(true);
    expect(textSaysBlocked({ title: "Θόρυβος τη νύχτα", description: null })).toBe(false);
  });
});

describe("reports: trust, status and expiry", () => {
  it("one report alone is partial with moderate confidence", () => {
    const o = obstacleOf({ upvotes: 0 });
    expect(o.blocks).toBe("partial");
    expect(o.confidence).toBe(0.6);
  });

  it("a second person confirming it makes it a full block", () => {
    const o = obstacleOf({ upvotes: 1 });
    expect(o.blocks).toBe("full");
    expect(o.confidence).toBe(0.85);
  });

  it("a confirmed report far from the edge stays partial when its confidence falls under 0.5", () => {
    expect(obstacleOf({ upvotes: 5, at: at(50, -20) })).toMatchObject({ blocks: "full", confidence: 0.64 });
    expect(obstacleOf({ upvotes: 5, at: at(50, -24.5) })).toMatchObject({ blocks: "partial" });
  });

  it.each(["resolved", "rejected"])("a %s report produces no obstacle", (status) => {
    expect(reasonOf({ status, upvotes: 30 })).toBe("closed");
  });

  it.each(["submitted", "received", "in_progress"])("a %s report still counts", (status) => {
    expect(reasonOf({ status })).toBe("obstacle");
  });

  it("expires 12 hours after it was created", () => {
    const o = obstacleOf({ created_at: "2026-11-21T00:30:00+02:00" });
    expect(o.observedAt).toBe("2026-11-20T22:30:00.000Z");
    expect(o.expiresAt).toBe("2026-11-21T10:30:00.000Z");
    expect(reasonOf({ created_at: "2026-11-20T23:59:00+02:00" })).toBe("expired");
    expect(reasonOf({ created_at: "2026-11-09T19:20:00+02:00", upvotes: 27 })).toBe("expired");
  });

  it("marks everything as sandbox test data with a Greek label", () => {
    const o = obstacleOf({});
    expect(o).toMatchObject({
      id: "sandbox:req-1001",
      synthetic: true,
      source: { kind: "sandbox_request", ref: "req-1001" },
      label: "Σπασμένες πλάκες πεζοδρομίου, Οδός ΑΒ 20",
    });
  });
});

describe("projects", () => {
  const along = { type: "LineString" as const, coordinates: [at(-10, 3), at(100, 3), at(210, 3)] };
  const byEdge = (p: ReturnType<typeof project>, opts = {}) =>
    Object.fromEntries(projectToObstacles(p, edges, NOW, opts).obstacles.map((o) => [o.edgeId, o]));

  it("closes the edges a sidewalk project runs along and only touches the side streets", () => {
    const got = byEdge(project(along));
    expect(got["AB"]).toMatchObject({ blocks: "full", confidence: 0.8, type: "works", synthetic: true });
    expect(got["BC"]?.blocks).toBe("full");
    expect(got["AD"]?.blocks).toBe("partial"); // 23 m of 100 m inside the works area
    expect(got["BE"]?.blocks).toBe("partial");
    expect(got["CF"]?.blocks).toBe("partial");
    expect(got["DE"]).toBeUndefined();
    expect(got["EF"]).toBeUndefined();
    expect(got["AB"]).toMatchObject({
      id: "sandbox:prj-900:AB",
      source: { kind: "sandbox_project", ref: "prj-900" },
      label: "Έργα του Δήμου: Ανάπλαση πεζοδρομίων",
      expiresAt: "2027-06-30T20:59:59.000Z",
    });
  });

  it("a short edge that crosses the works is covered but not closed, because it does not run along them", () => {
    const crossing = { type: "LineString" as const, coordinates: [at(50, -200), at(50, 200)] };
    const got = byEdge(project(crossing), { projectBufferM: 60 });
    expect(got["AB"]?.blocks).toBe("partial"); // fully covered, perpendicular
    expect(got["AD"]?.blocks).toBe("full"); // fully covered, parallel
  });

  it("road, water and cycling works never close a pavement", () => {
    for (const category of ["road", "water", "cycling"]) {
      expect(byEdge(project(along, { category }))["AB"]?.blocks).toBe("partial");
    }
  });

  it("counts only projects in progress, in relevant categories, before the planned end", () => {
    const skip = (props: Parameters<typeof project>[1]) => projectToObstacles(project(along, props), edges, NOW).skipped?.reason;
    expect(skip({ status: "planned" })).toBe("not_in_progress");
    expect(skip({ status: "completed" })).toBe("not_in_progress");
    expect(skip({ status: "paused" })).toBe("not_in_progress");
    expect(skip({ category: "lighting" })).toBe("category_not_relevant");
    expect(skip({ category: "greenery" })).toBe("category_not_relevant");
    expect(skip({ end_date_planned: "2026-11-20" })).toBe("expired");
    expect(skip({ end_date_planned: "2026-11-21" })).toBeUndefined(); // until the end of that day
  });

  it("treats a point as a circle of works", () => {
    const got = byEdge(project({ type: "Point", coordinates: at(100, 100) }, { category: "square" }));
    expect(Object.keys(got).sort()).toEqual(["BE", "DE", "EF"]);
    expect(got["DE"]?.blocks).toBe("partial"); // 30 m of 100 m
    expect(projectToObstacles(project({ type: "Point", coordinates: at(100, 600) }), edges, NOW).skipped?.reason).toBe("no_edges_covered");
  });

  it("closes the edges inside a polygon", () => {
    const square = { type: "Polygon" as const, coordinates: [[at(90, 60), at(210, 60), at(210, 140), at(90, 140), at(90, 60)]] };
    const got = byEdge(project(square, { category: "square" }), { projectBufferM: 5 });
    expect(got["EF"]?.blocks).toBe("full");
    expect(got["BE"]?.blocks).toBe("partial");
    expect(got["AB"]).toBeUndefined();
  });

  it("ends on the planned day in Athens time, winter and summer", () => {
    expect(endOfDayAthens("2026-12-31")?.toISOString()).toBe("2026-12-31T21:59:59.000Z");
    expect(endOfDayAthens("2027-06-30")?.toISOString()).toBe("2027-06-30T20:59:59.000Z");
    expect(endOfDayAthens("soon")).toBeNull();
  });
});

describe("mapSandboxData", () => {
  it("returns obstacles and the reason for everything left out", () => {
    const { obstacles, skipped } = mapSandboxData(
      [report({ id: "req-1" }), report({ id: "req-2", status: "resolved" }), report({ id: "req-3", category: "noise" })],
      [project({ type: "Point", coordinates: at(100, 100) }, { id: "prj-1", status: "planned" })],
      edges,
      NOW,
    );
    expect(obstacles.map((o) => o.id)).toEqual(["sandbox:req-1"]);
    expect(skipped).toEqual([
      { ref: "req-2", reason: "closed" },
      { ref: "req-3", reason: "category_not_relevant" },
      { ref: "prj-1", reason: "not_in_progress" },
    ]);
  });

  it("maps nothing without a graph, and says why", () => {
    const none = { nearestEdge: () => null, edgesInBBox: () => [] };
    const { obstacles, skipped } = mapSandboxData([report()], [], none, NOW);
    expect(obstacles).toEqual([]);
    expect(skipped[0]?.reason).toBe("no_edge_nearby");
  });
});
