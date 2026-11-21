import { describe, expect, it } from "vitest";
import { DEFAULT_COST_OPTIONS, edgeCost, minCostPerMetre, resolveCostOptions } from "./cost.ts";
import { SURVEY_SOURCE, SURVEY_YEAR, applyEnrichment } from "./enrichment.ts";
import { buildGraphIndex } from "./graph.ts";
import { describeSurveyNotice, nextAnnouncements } from "./instructions.ts";
import { findRoute } from "./route.ts";
import { GraphBuilder, NOW } from "./testing/fixtures.ts";
import type {
  EdgeKind,
  GraphEdge,
  GraphEnrichment,
  PedestrianGraph,
  Route,
  SurveyNote,
  SurveyedSide,
} from "./types.ts";

const note = (confidence = 0.8, extra: Partial<SurveyNote> = {}): SurveyNote => ({
  source: SURVEY_SOURCE,
  year: SURVEY_YEAR,
  confidence,
  ...extra,
});

/** A 100 m edge of the given kind with survey values laid on it. */
function edge(kind: EdgeKind, extra: Partial<GraphEdge> = {}): GraphEdge {
  const graph = new GraphBuilder().node("A", 0, 0).node("B", 100, 0).edge("A", "B", { kind, ...extra }).build();
  return graph.edges[0]!;
}

const cost = (e: GraphEdge) => edgeCost(e, [], NOW);
const O = DEFAULT_COST_OPTIONS;

function ok(result: ReturnType<typeof findRoute>): Route {
  if (!result.ok) throw new Error(`expected a route: ${result.message}`);
  return result.route;
}

describe("cost model with survey values", () => {
  it("leaves every edge kind as it was when there is no survey", () => {
    expect(cost(edge("sidewalk"))).toBeCloseTo(100, 1);
    expect(cost(edge("shared_road"))).toBeCloseTo(100 * O.sharedRoadFactor, 1);
    expect(cost(edge("sidewalk", { tactilePaving: "yes" }))).toBeCloseTo(100 * O.tactilePavingFactor, 1);
  });

  it("ignores survey values without a survey note or below the confidence floor", () => {
    const values = { pavement: "yes", pavementWidth: "narrow", pavementCondition: "poor" } as const;
    expect(cost(edge("shared_road", values))).toBeCloseTo(200, 1);
    expect(cost(edge("shared_road", { ...values, survey: note(0.3) }))).toBeCloseTo(200, 1);
    expect(cost(edge("sidewalk", { ...values, survey: note(0.3) }))).toBeCloseTo(100, 1);
  });

  it("makes a street with a surveyed good pavement cheaper than the blanket shared-road penalty", () => {
    const unknown = cost(edge("shared_road"));
    const paved = cost(edge("shared_road", { pavement: "yes", survey: note() }));
    const good = cost(
      edge("shared_road", { pavement: "yes", pavementWidth: "wide", pavementCondition: "good", survey: note() }),
    );
    expect(paved).toBeCloseTo(100 * O.pavedRoadFactor, 1);
    expect(good).toBeCloseTo(100 * O.pavedRoadFactor * O.widePavementFactor * O.goodPavementFactor, 1);
    expect(good).toBeLessThan(paved);
    expect(paved).toBeLessThan(unknown);
    // A mapped pavement with the same survey still wins over a street axis matched by geometry.
    expect(cost(edge("sidewalk", { pavement: "yes", pavementWidth: "wide", pavementCondition: "good", survey: note() }))).toBeLessThan(good);
  });

  it("makes a street the survey found without pavement dearer than an unknown one", () => {
    const none = cost(edge("shared_road", { pavement: "no", survey: note() }));
    expect(none).toBeCloseTo(100 * O.noPavementRoadFactor, 1);
    expect(none).toBeGreaterThan(cost(edge("shared_road")));
    // On a pedestrian street the whole street is walked: "no pavement" is not a fault.
    expect(cost(edge("pedestrian", { pavement: "no", survey: note() }))).toBeCloseTo(100, 1);
  });

  it("penalises a narrow pavement and leaves a medium one and an unknown one alone", () => {
    const narrow = cost(edge("sidewalk", { pavement: "yes", pavementWidth: "narrow", survey: note() }));
    const medium = cost(edge("sidewalk", { pavement: "yes", pavementWidth: "medium", survey: note() }));
    const unknown = cost(edge("sidewalk", { pavement: "yes", survey: note() }));
    expect(narrow).toBeCloseTo(100 * O.narrowPavementFactor, 1);
    expect(medium).toBeCloseTo(100, 1);
    expect(unknown).toBeCloseTo(100, 1);
  });

  it("penalises poor condition, rewards good, and treats unknown as neither", () => {
    const at = (pavementCondition?: GraphEdge["pavementCondition"]) =>
      cost(edge("sidewalk", { pavement: "yes", ...(pavementCondition ? { pavementCondition } : {}), survey: note() }));
    expect(at("poor")).toBeCloseTo(100 * O.poorPavementFactor, 1);
    expect(at("good")).toBeCloseTo(100 * O.goodPavementFactor, 1);
    expect(at("medium")).toBeCloseTo(100, 1);
    expect(at()).toBeCloseTo(100, 1);
    expect(at("good")).toBeLessThan(at());
    expect(at()).toBeLessThan(at("poor"));
  });

  it("adds cost per kind of fixed obstacle, up to a ceiling, and nothing for an empty or missing list", () => {
    const withKinds = (fixedObstacles?: GraphEdge["fixedObstacles"]) =>
      cost(edge("sidewalk", { pavement: "yes", ...(fixedObstacles ? { fixedObstacles } : {}), survey: note() }));
    expect(withKinds()).toBeCloseTo(100, 1);
    expect(withKinds([])).toBeCloseTo(100, 1);
    expect(withKinds(["kiosk"])).toBeCloseTo(100 * O.fixedObstacleFactor, 1);
    expect(withKinds(["kiosk", "level_change"])).toBeCloseTo(100 * O.fixedObstacleFactor ** 2, 1);
    expect(
      withKinds(["kiosk", "level_change", "pole_or_bollard", "tree_row", "utility_cabinet", "surface_defect"]),
    ).toBeCloseTo(100 * O.fixedObstaclesMaxFactor, 1);
  });

  it("rewards tactile guidance along the whole length only, and never twice with the OSM tag", () => {
    const whole = cost(edge("sidewalk", { tactileGuidance: "whole", survey: note() }));
    expect(whole).toBeCloseTo(100 * O.tactileGuidanceFactor, 1);
    expect(cost(edge("sidewalk", { tactileGuidance: "part", survey: note() }))).toBeCloseTo(100, 1);
    expect(cost(edge("sidewalk", { tactileGuidance: "none", survey: note() }))).toBeCloseTo(100, 1);
    expect(cost(edge("pedestrian", { tactileGuidance: "whole", survey: note() }))).toBeCloseTo(whole, 1);
    expect(cost(edge("sidewalk", { tactileGuidance: "whole", tactilePaving: "yes", survey: note() }))).toBeCloseTo(whole, 1);
    // The survey saying "none" does not take away what OpenStreetMap says.
    expect(cost(edge("sidewalk", { tactileGuidance: "none", tactilePaving: "yes", survey: note() }))).toBeCloseTo(
      100 * O.tactilePavingFactor,
      1,
    );
  });

  it("prefers a crossing with zebra markings and ramps to one without, with unknown in between", () => {
    const crossing = { signals: "no", sound: "no", marked: "unknown" } as const;
    const at = (extra: Partial<GraphEdge>) => cost(edge("crossing", { crossing, ...extra })) - 100;
    const unknown = at({});
    const best = at({ crossingMarkings: "clear", crossingRamps: "both_ends", survey: note() });
    const worst = at({ crossingMarkings: "none", crossingRamps: "none", survey: note() });
    expect(unknown).toBeCloseTo(O.crossingUnsignalledM, 1);
    expect(best).toBeCloseTo(O.crossingUnsignalledM + O.crossingMarkingsClearM + O.crossingRampsBothM, 1);
    expect(worst).toBeCloseTo(O.crossingUnsignalledM + O.crossingMarkingsNoneM + O.crossingRampsNoneM, 1);
    expect(best).toBeLessThan(unknown);
    expect(unknown).toBeLessThan(worst);
    expect(at({ crossingMarkings: "worn", survey: note() })).toBeLessThan(unknown);
    expect(at({ crossingRamps: "one_end", survey: note() })).toBeGreaterThan(unknown);
  });

  it("never lets a crossing bonus push the crossing penalty below zero", () => {
    const quiet = { signals: "yes", sound: "yes", marked: "yes" } as const;
    const e = edge("crossing", { crossing: quiet, crossingMarkings: "clear", crossingRamps: "both_ends", survey: note() });
    expect(cost(e)).toBeCloseTo(100, 1);
  });

  it("keeps the A* lower bound under every bonus", () => {
    const best = edge("sidewalk", {
      pavement: "yes",
      pavementWidth: "wide",
      pavementCondition: "good",
      tactileGuidance: "whole",
      survey: note(),
    });
    expect(cost(best) / 100).toBeGreaterThanOrEqual(minCostPerMetre(resolveCostOptions()) - 1e-9);
  });
});

/**
 * Two ways from S to T, both 200 m: north through N on a mapped pavement,
 * south through X on a street axis.
 */
function twoWays(north: Partial<GraphEdge>, south: Partial<GraphEdge>): PedestrianGraph {
  return new GraphBuilder()
    .node("S", 0, 0)
    .node("N", 100, 60)
    .node("X", 100, -60)
    .node("T", 200, 0)
    .edge("S", "N", north)
    .edge("N", "T", north)
    .edge("S", "X", south)
    .edge("X", "T", south)
    .build();
}

describe("routing with survey values", () => {
  it("leaves a mapped pavement for a street whose survey shows a good pavement with tactile guidance", () => {
    const before = ok(findRoute(buildGraphIndex(twoWays({}, { kind: "shared_road" })), "S", "T"));
    expect(before.nodes).toEqual(["S", "N", "T"]);
    const surveyed = {
      kind: "shared_road",
      pavement: "yes",
      pavementWidth: "wide",
      pavementCondition: "good",
      tactileGuidance: "whole",
      survey: note(),
    } as const;
    const after = ok(findRoute(buildGraphIndex(twoWays({}, surveyed)), "S", "T"));
    expect(after.nodes).toEqual(["S", "X", "T"]);
  });

  it("leaves a narrow, poor pavement for an equally long one nothing is known about", () => {
    const bad = { pavement: "yes", pavementWidth: "narrow", pavementCondition: "poor", survey: note() } as const;
    expect(ok(findRoute(buildGraphIndex(twoWays(bad, {})), "S", "T")).nodes).toEqual(["S", "X", "T"]);
  });
});

function enrichment(graph: PedestrianGraph, edges: GraphEnrichment["edges"], nodes: GraphEnrichment["nodes"] = {}): GraphEnrichment {
  return {
    meta: {
      source: SURVEY_SOURCE,
      year: SURVEY_YEAR,
      licence: "test",
      generatedAt: "2026-11-21T00:00:00Z",
      graphBuiltAt: graph.meta.builtAt,
      thresholds: {},
      omittedCodes: [],
    },
    edges,
    nodes,
  };
}

describe("applyEnrichment", () => {
  const base = () =>
    new GraphBuilder()
      .node("A", 0, 0)
      .node("B", 100, 0)
      .node("C", 200, 0)
      .node("D", 210, 0)
      .edge("A", "B", { kind: "shared_road" })
      .edge("B", "C")
      .edge("C", "D", { kind: "crossing" })
      .build();
  const lengthOf = (g: PedestrianGraph, id: string) => g.edges.find((e) => e.id === id)!.lengthM;
  const good: SurveyedSide = { pavement: "yes", pavementWidth: "wide", pavementCondition: "good", survey: note(0.9, { featureIds: [1] }) };
  const poor: SurveyedSide = { pavement: "yes", pavementWidth: "narrow", pavementCondition: "poor", survey: note(0.7, { featureIds: [2] }) };

  it("lays values over a copy of the graph and leaves the input untouched", () => {
    const graph = base();
    const snapshot = JSON.stringify(graph);
    const result = applyEnrichment(
      graph,
      enrichment(
        graph,
        {
          "A-B": { lengthM: lengthOf(graph, "A-B"), left: poor, right: good, better: "right" },
          "B-C": { lengthM: lengthOf(graph, "B-C"), side: { tactileGuidance: "whole", survey: note(0.8) } },
          "C-D": { lengthM: lengthOf(graph, "C-D"), crossing: { markings: "clear", ramps: "none", survey: note(0.6) } },
        },
        { C: { ramp: { condition: "good", manoeuvringSpace: "yes", survey: note(0.7) } } },
      ),
    );
    expect(JSON.stringify(graph)).toBe(snapshot);
    expect(result.applied).toBe(true);
    expect(result.edgesCovered).toBe(3);
    expect(result.nodesCovered).toBe(1);
    expect(result.skipped).toBe(0);

    const [road, pavement, crossing] = result.graph.edges as [GraphEdge, GraphEdge, GraphEdge];
    expect(road).toMatchObject({ pavement: "yes", pavementWidth: "wide", pavementCondition: "good" });
    expect(road.survey).toMatchObject({ source: "Walkable Athens (City of Athens, NTUA)", year: 2022, confidence: 0.9, side: "right" });
    expect(road.pavementSides?.left?.pavementWidth).toBe("narrow");
    expect(pavement.tactileGuidance).toBe("whole");
    expect(pavement.pavement).toBeUndefined();
    expect(crossing).toMatchObject({ crossingMarkings: "clear", crossingRamps: "none" });
    expect(result.graph.nodes.find((n) => n.id === "C")!.surveyedRamp?.condition).toBe("good");
    // The surveyed street is now cheaper than it was, the unknown values cost nothing.
    expect(edgeCost(road, [], NOW)).toBeLessThan(edgeCost(graph.edges[0]!, [], NOW));
  });

  it("keeps a street unknown when no better side is named", () => {
    const graph = base();
    const none: SurveyedSide = { pavement: "no", survey: note(0.9) };
    const result = applyEnrichment(graph, enrichment(graph, { "A-B": { lengthM: lengthOf(graph, "A-B"), left: none } }));
    const road = result.graph.edges[0]!;
    expect(result.edgesCovered).toBe(0);
    expect(road.pavement).toBeUndefined();
    expect(road.survey).toBeUndefined();
    expect(road.pavementSides?.left?.pavement).toBe("no");
    expect(edgeCost(road, [], NOW)).toBe(edgeCost(graph.edges[0]!, [], NOW));
  });

  it("skips entries for unknown edges and for edges whose length changed", () => {
    const graph = base();
    const result = applyEnrichment(
      graph,
      enrichment(graph, {
        "A-B": { lengthM: lengthOf(graph, "A-B") + 5, side: good },
        "X-Y": { lengthM: 10, side: good },
        "B-C": { lengthM: lengthOf(graph, "B-C"), side: good },
      }),
    );
    expect(result.edgesCovered).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.graph.edges[0]).toBe(graph.edges[0]);
  });

  it("refuses a file made for another build of the graph", () => {
    const graph = base();
    const file = enrichment(graph, { "B-C": { lengthM: lengthOf(graph, "B-C"), side: good } });
    file.meta.graphBuiltAt = "2020-01-01T00:00:00Z";
    const result = applyEnrichment(graph, file);
    expect(result.applied).toBe(false);
    expect(result.problem).toContain("2020-01-01");
    expect(result.graph).toBe(graph);
  });
});

describe("surveyed facts in the instructions", () => {
  /** A - B - C east along Ερμού, then north C - D on Αθηνάς (100 m each), then a crossing D - E and E - F. */
  function walk(extra: Record<string, Partial<GraphEdge>>): Route {
    const g = new GraphBuilder()
      .node("A", 0, 0)
      .node("B", 100, 0)
      .node("C", 200, 0)
      .node("D", 200, 100)
      .node("E", 200, 110)
      .node("F", 200, 210)
      .edge("A", "B", { name: "Ερμού", ...extra["A-B"] })
      .edge("B", "C", { name: "Ερμού", ...extra["B-C"] })
      .edge("C", "D", { name: "Αθηνάς", ...extra["C-D"] })
      .edge("D", "E", { kind: "crossing", crossing: { signals: "no", sound: "no", marked: "yes" }, ...extra["D-E"] })
      .edge("E", "F", { name: "Αθηνάς", ...extra["E-F"] })
      .build();
    return ok(findRoute(buildGraphIndex(g), "A", "F"));
  }
  const stepAt = (route: Route, node: string) => route.steps.find((s) => s.atNode === node)!;

  it("says nothing without survey values", () => {
    expect(walk({}).steps.every((s) => s.surveyNotice === undefined)).toBe(true);
  });

  it("notes a pavement that narrows, only where it changes", () => {
    const wide = { pavement: "yes", pavementWidth: "wide", survey: note() } as const;
    const narrow = { pavement: "yes", pavementWidth: "narrow", survey: note() } as const;
    const route = walk({ "A-B": wide, "B-C": wide, "C-D": narrow, "E-F": narrow });
    expect(stepAt(route, "A").surveyNotice).toBeUndefined();
    expect(stepAt(route, "C").surveyNotice).toEqual({ kind: "pavement_narrows" });
    expect(stepAt(route, "D").surveyNotice).toBeUndefined(); // still narrow after the crossing: not said again
  });

  it("says a pavement is narrow, not that it narrows, when what came before is not known", () => {
    const narrow = { pavement: "yes", pavementWidth: "narrow", survey: note() } as const;
    const route = walk({ "A-B": narrow, "C-D": narrow });
    expect(stepAt(route, "A").surveyNotice).toEqual({ kind: "pavement_narrow" });
    expect(stepAt(route, "C").surveyNotice).toEqual({ kind: "pavement_narrow" });
  });

  it("notes a stretch without pavement before anything else", () => {
    const route = walk({
      "C-D": { kind: "shared_road", pavement: "no", tactileGuidance: "whole", survey: note() },
    });
    expect(stepAt(route, "C").surveyNotice).toEqual({ kind: "no_pavement" });
  });

  it("notes where tactile guidance starts, on the side as the person walks", () => {
    const guided = (side: "left" | "right") =>
      ({ kind: "shared_road", pavement: "yes", tactileGuidance: "whole", survey: note(0.8, { side }) }) as const;
    // C-D is walked from C to D, the direction the edge was drawn in.
    expect(stepAt(walk({ "C-D": guided("left") }), "C").surveyNotice).toEqual({ kind: "tactile_guidance_starts", side: "left" });
    // Walked the other way, the same side is on the other hand.
    const g = new GraphBuilder()
      .node("A", 0, 0)
      .node("B", 100, 0)
      .edge("B", "A", guided("left"))
      .build();
    const back = ok(findRoute(buildGraphIndex(g), "A", "B"));
    expect(back.steps[0]!.surveyNotice).toEqual({ kind: "tactile_guidance_starts", side: "right" });
  });

  it("does not announce a new start after a short gap in the guidance", () => {
    const guided = { tactileGuidance: "whole", survey: note() } as const;
    const g = new GraphBuilder()
      .node("A", 0, 0)
      .node("B", 100, 0)
      .node("C", 110, 0)
      .node("D", 110, 100)
      .edge("A", "B", guided)
      .edge("B", "C")
      .edge("C", "D", guided)
      .build();
    const route = ok(findRoute(buildGraphIndex(g), "A", "D"));
    expect(route.steps.map((s) => s.surveyNotice?.kind)).toEqual(["tactile_guidance_starts", undefined, undefined]);
  });

  it("notes a crossing without ramps, and nothing for one with ramps or with none recorded", () => {
    expect(stepAt(walk({ "D-E": { crossingRamps: "none", survey: note() } }), "D").surveyNotice).toEqual({ kind: "crossing_no_ramp" });
    expect(stepAt(walk({ "D-E": { crossingRamps: "both_ends", survey: note() } }), "D").surveyNotice).toBeUndefined();
    expect(stepAt(walk({ "D-E": { crossingMarkings: "clear", survey: note() } }), "D").surveyNotice).toBeUndefined();
  });

  it("ignores a fact that holds for a few metres only, or with low confidence", () => {
    const g = new GraphBuilder()
      .node("A", 0, 0)
      .node("B", 10, 0)
      .edge("A", "B", { pavement: "yes", pavementWidth: "narrow", survey: note() })
      .build();
    expect(ok(findRoute(buildGraphIndex(g), "A", "B")).steps[0]!.surveyNotice).toBeUndefined();
    const doubtful = { pavement: "yes", pavementWidth: "narrow", survey: note(0.2) } as const;
    expect(stepAt(walk({ "C-D": doubtful }), "C").surveyNotice).toBeUndefined();
  });

  it("speaks the fact once, with the first announcement of the step", () => {
    const route = walk({
      "A-B": { pavement: "yes", pavementWidth: "wide", survey: note() },
      "B-C": { pavement: "yes", pavementWidth: "wide", survey: note() },
      "C-D": { pavement: "yes", pavementWidth: "narrow", survey: note() },
      "D-E": { crossingRamps: "none", survey: note() },
    });
    const ahead = nextAnnouncements(route, { distanceM: 180 });
    const turn = ahead.announcements.find((a) => a.type === "turn")!;
    expect(turn.text).toBe("Σε 20 μέτρα, στρίψτε αριστερά, προς Αθηνάς. Στη συνέχεια το πεζοδρόμιο στενεύει.");
    expect(turn).toMatchObject({ phase: "ahead", surveyNotice: { kind: "pavement_narrows" } });
    const now = nextAnnouncements(route, { distanceM: 199 }, ahead.announced);
    const turnNow = now.announcements.find((a) => a.type === "turn")!;
    expect(turnNow.text).toBe("Στρίψτε αριστερά, προς Αθηνάς.");
    expect("surveyNotice" in turnNow).toBe(false);

    const crossing = nextAnnouncements(route, { distanceM: 280 }).announcements.find((a) => a.type === "crossing")!;
    expect(crossing.text).toBe("Σε 20 μέτρα, διάβαση χωρίς φανάρι. Η διάβαση δεν έχει ράμπες.");
    expect(crossing.text).not.toMatch(/περάστε|διασχίστε/);
  });

  it("speaks the fact with the 'now' announcement when the step was never announced ahead", () => {
    const route = walk({ "C-D": { pavement: "yes", pavementWidth: "narrow", survey: note() } });
    const turn = nextAnnouncements(route, { distanceM: 198 }).announcements.find((a) => a.type === "turn")!;
    expect(turn.text).toBe("Στρίψτε αριστερά, προς Αθηνάς. Στη συνέχεια το πεζοδρόμιο είναι στενό.");
  });

  it("puts the fact on the departure too", () => {
    const route = walk({ "A-B": { tactileGuidance: "whole", survey: note() }, "B-C": { tactileGuidance: "whole", survey: note() } });
    const depart = nextAnnouncements(route, { distanceM: 0 }).announcements[0]!;
    expect(depart.text).toBe("Ξεκινάτε, προς Ερμού. Στη συνέχεια υπάρχει όδευση τυφλών.");
  });

  it("has a sentence for every kind of fact", () => {
    expect(describeSurveyNotice({ kind: "no_pavement" })).toBe("Στη συνέχεια δεν υπάρχει πεζοδρόμιο.");
    expect(describeSurveyNotice({ kind: "tactile_guidance_starts", side: "right" })).toBe(
      "Στη συνέχεια υπάρχει όδευση τυφλών, στα δεξιά σας.",
    );
    expect(describeSurveyNotice({ kind: "tactile_guidance_starts", side: "left" })).toBe(
      "Στη συνέχεια υπάρχει όδευση τυφλών, στα αριστερά σας.",
    );
  });
});
