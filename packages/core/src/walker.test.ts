import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "./graph.ts";
import { describeCrossing, nextAnnouncements, type Announcement } from "./instructions.ts";
import { checkObstacleRemoved, rerouteForObstacle } from "./reroute.ts";
import { findRoute } from "./route.ts";
import { NOW, at, ladderGraph, obstacle, streetGraph } from "./testing/fixtures.ts";
import type { Route } from "./types.ts";
import { walkerAt, walkerAtDistance } from "./walker.ts";

function routeOn(index: ReturnType<typeof buildGraphIndex>, from: string, to: string): Route {
  const result = findRoute(index, from, to);
  if (!result.ok) throw new Error("fixture route missing");
  return result.route;
}

describe("walker simulation", () => {
  const index = buildGraphIndex(ladderGraph());
  const rerouted = rerouteForObstacle(index, routeOn(index, "A", "E"), 0, obstacle("D-E"), {
    atTime: NOW,
  });
  // A, B, C, D, then left to D2, right to E2, right to E: 600 m.
  const route = rerouted.route;

  it("gives position, bearing, edge and next step at several times", () => {
    expect(route.nodes).toEqual(["A", "B", "C", "D", "D2", "E2", "E"]);

    const start = walkerAt(index, route, 0);
    expect(start.distanceM).toBe(0);
    expect(start.position).toEqual(at(0, 0));
    expect(start.bearing).toBeCloseTo(90, 0);
    expect(start.edgeId).toBe("A-B");
    expect(start.arrived).toBe(false);
    expect(start.nextStep).toMatchObject({ kind: "turn", atNode: "D", direction: "left" });
    expect(start.distanceToNextStepM).toBeCloseTo(300, 0);

    const mid = walkerAt(index, route, 150);
    expect(mid.distanceM).toBe(150);
    expect(mid.edgeId).toBe("B-C");
    expect(mid.edgeIndex).toBe(1);
    expect(mid.position[0]).toBeCloseTo(at(150, 0)[0], 6);
    expect(mid.position[1]).toBeCloseTo(at(150, 0)[1], 6);
    expect(mid.distanceToNextStepM).toBeCloseTo(150, 0);

    const onRung = walkerAt(index, route, 350);
    expect(onRung.edgeId).toBe("D-D2");
    expect(onRung.bearing).toBeCloseTo(0, 0);
    expect(onRung.position[1]).toBeCloseTo(at(300, 50)[1], 6);
    expect(onRung.nextStep).toMatchObject({ atNode: "D2", direction: "right" });

    // E-E2 is stored from E to E2 and walked the other way: heading south.
    const last = walkerAt(index, route, 550);
    expect(last.edgeId).toBe("E-E2");
    expect(last.bearing).toBeCloseTo(180, 0);
    expect(last.nextStep).toMatchObject({ kind: "arrive" });
    expect(last.remainingM).toBeCloseTo(50, 0);

    const done = walkerAt(index, route, 10_000);
    expect(done.arrived).toBe(true);
    expect(done.distanceM).toBeCloseTo(600, 0);
    expect(done.position[0]).toBeCloseTo(at(400, 0)[0], 6);
    expect(done.nextStep).toBeNull();
    expect(done.distanceToNextStepM).toBeNull();
  });

  it("is deterministic and follows the speed", () => {
    expect(walkerAt(index, route, 123)).toEqual(walkerAt(index, route, 123));
    expect(walkerAt(index, route, 75, { speedMps: 2 })).toEqual(walkerAtDistance(index, route, 150));
    expect(walkerAt(index, route, 10, { startDistanceM: 140 })).toEqual(
      walkerAtDistance(index, route, 150),
    );
  });

  it("walks a turn-back route from the walker's own position", () => {
    const back = rerouteForObstacle(index, routeOn(index, "A", "E"), 350, obstacle("D-E"), {
      atTime: NOW,
    });
    expect(back.outcome).toBe("turn_back");
    const start = walkerAt(index, back.route, 0);
    expect(start.position[0]).toBeCloseTo(at(350, 0)[0], 6);
    expect(start.bearing).toBeCloseTo(270, 0);
    expect(start.edgeId).toBe("D-E");
    const later = walkerAt(index, back.route, 100);
    expect(later.edgeId).toBe("D-D2");
    expect(later.position[1]).toBeCloseTo(at(300, 50)[1], 6);
  });
});

describe("announcements", () => {
  const index = buildGraphIndex(streetGraph());
  const route = routeOn(index, "P0", "P4");

  function walkWholeRoute(): Announcement[] {
    const all: Announcement[] = [];
    let announced: string[] = [];
    for (let t = 0; t <= 200; t++) {
      const walker = walkerAt(index, route, t);
      const result = nextAnnouncements(route, walker, announced);
      all.push(...result.announcements);
      announced = result.announced;
    }
    return all;
  }

  it("announces each step once ahead and once on reaching it", () => {
    const all = walkWholeRoute();
    expect(all.map((a) => [a.type, "phase" in a ? a.phase : null])).toEqual([
      ["depart", null],
      ["crossing", "ahead"],
      ["crossing", "now"],
      ["turn", "ahead"],
      ["turn", "now"],
      ["arrival", "ahead"],
      ["arrival", "now"],
    ]);
    expect(new Set(all.map((a) => a.key)).size).toBe(all.length);
    expect(new Set(all.map((a) => a.text)).size).toBe(all.length);
    for (const a of all) {
      if ("distanceM" in a) expect(a.distanceM % 5).toBe(0);
    }
  });

  it("does not repeat an announcement for the same walker state", () => {
    const first = nextAnnouncements(route, { distanceM: 35 }, []);
    expect(first.announcements.length).toBeGreaterThan(0);
    const second = nextAnnouncements(route, { distanceM: 35 }, first.announced);
    expect(second.announcements).toEqual([]);
    const third = nextAnnouncements(route, { distanceM: 36 }, second.announced);
    expect(third.announcements).toEqual([]);
  });

  it("describes a crossing and never tells the person to cross", () => {
    const all = walkWholeRoute();
    const [ahead, now] = all.filter((a) => a.type === "crossing");
    expect(ahead!.text).toBe("Σε 30 μέτρα, διάβαση με φανάρι, χωρίς ηχητικό σήμα.");
    expect(now!.text).toBe("Διάβαση με φανάρι, χωρίς ηχητικό σήμα.");
    expect(ahead).toMatchObject({ crossing: { signals: "yes", sound: "no" }, distanceM: 30 });

    const tri = ["yes", "no", "unknown"] as const;
    const texts = all.map((a) => a.text);
    for (const signals of tri) {
      for (const sound of tri) {
        texts.push(describeCrossing({ signals, sound, marked: "unknown" }, "left"));
      }
    }
    for (const text of texts) {
      expect(text).not.toMatch(/περάστε|περάσετε|διασχίστε|διασχίσετε/i);
    }
    // Unknown is never reported as absent.
    expect(describeCrossing({ signals: "yes", sound: "unknown", marked: "unknown" })).toBe(
      "Διάβαση με φανάρι, χωρίς επιβεβαιωμένο ηχητικό σήμα",
    );
    expect(describeCrossing({ signals: "unknown", sound: "unknown", marked: "unknown" })).not.toMatch(
      /χωρίς φανάρι/,
    );
  });

  it("words turns and arrival in Greek", () => {
    const all = walkWholeRoute();
    const texts = all.map((a) => a.text);
    expect(texts[0]).toBe("Ξεκινάτε, προς Ερμού.");
    expect(texts).toContain("Σε 30 μέτρα, στρίψτε αριστερά, προς Βουλής.");
    expect(texts).toContain("Στρίψτε αριστερά, προς Βουλής.");
    expect(texts).toContain("Σε 30 μέτρα φτάνετε στον προορισμό σας.");
    expect(texts.at(-1)).toBe("Φτάσατε στον προορισμό σας.");
  });

  it("announces an obstacle with its reroute once", () => {
    const ladder = buildGraphIndex(ladderGraph());
    const original = routeOn(ladder, "A", "E");
    const blocked = obstacle("D-E");
    const result = rerouteForObstacle(ladder, original, 52, blocked, { atTime: NOW });
    const first = nextAnnouncements(result.route, { distanceM: 52 }, [], {
      reroute: { obstacle: blocked, result },
    });
    const spoken = first.announcements.find((a) => a.type === "obstacle");
    expect(spoken).toMatchObject({
      outcome: "reroute",
      decisionNode: "D",
      distanceToDecisionM: 250,
      distanceToObstacleM: 250,
      direction: "left",
      extraDistanceM: 200,
    });
    expect(spoken!.text).toBe(
      "Εμπόδιο μπροστά σε 250 μέτρα: Έργα στο πεζοδρόμιο. Αλλαγή διαδρομής: σε 250 μέτρα, στρίψτε αριστερά. Η νέα διαδρομή είναι 200 μέτρα μακρύτερη.",
    );
    const again = nextAnnouncements(result.route, { distanceM: 53 }, first.announced, {
      reroute: { obstacle: blocked, result },
    });
    expect(again.announcements.filter((a) => a.type === "obstacle")).toEqual([]);

    // A late warning is short and leads with the action.
    const late = rerouteForObstacle(ladder, original, 290, blocked, { atTime: NOW });
    const lateSpoken = nextAnnouncements(late.route, { distanceM: 290 }, [], {
      reroute: { obstacle: blocked, result: late },
    }).announcements.find((a) => a.type === "obstacle");
    expect(lateSpoken).toMatchObject({ outcome: "reroute", lateWarning: true, distanceToDecisionM: 10 });
    expect(lateSpoken!.text).toBe("Σε 10 μέτρα, στρίψτε αριστερά. Ο δρόμος μπροστά είναι κλειστός.");
    const atCorner = rerouteForObstacle(ladder, original, 297, blocked, { atTime: NOW });
    const cornerSpoken = nextAnnouncements(atCorner.route, { distanceM: 297 }, [], {
      reroute: { obstacle: blocked, result: atCorner },
    }).announcements.find((a) => a.type === "obstacle");
    expect(cornerSpoken!.text).toBe("Στρίψτε αριστερά τώρα στη γωνία. Ο δρόμος μπροστά είναι κλειστός.");

    // Turning back and the obstacle being cleared have their own announcements.
    const back = rerouteForObstacle(ladder, original, 350, blocked, { atTime: NOW });
    const backSpoken = nextAnnouncements(back.route, { distanceM: 0 }, [], {
      reroute: { obstacle: blocked, result: back },
    }).announcements;
    expect(backSpoken[0]).toMatchObject({ type: "obstacle", outcome: "turn_back" });
    expect(backSpoken[0]!.text).toContain("Κάντε αναστροφή.");
    expect(backSpoken[1]).toMatchObject({ type: "depart", direction: "u_turn" });

    const removal = checkObstacleRemoved(ladder, result.route, 60, { atTime: NOW, obstacles: [] });
    const cleared = nextAnnouncements(removal.route, { distanceM: 60 }, [], {
      removal: { obstacleId: blocked.id, result: removal },
    }).announcements;
    expect(cleared[0]).toMatchObject({ type: "obstacle_cleared", savedDistanceM: 200 });
  });
});
