import { describe, expect, it } from "vitest";
import type { GraphEdge, LngLat, Obstacle, PedestrianGraph } from "@ion/core";
import { MissionBoard } from "./missions.ts";
import { pointsFor, toRewards } from "./rewards.ts";

const NOW = new Date("2026-11-21T12:00:00+02:00");
const A: LngLat = [23.727, 37.979];
const B: LngLat = [23.7271, 37.979];
const C: LngLat = [23.7272, 37.979];
const FAR: LngLat = [23.74, 37.99];

function edge(over: Partial<GraphEdge> & Pick<GraphEdge, "id" | "from" | "to" | "geometry">): GraphEdge {
  return { lengthM: 9, kind: "crossing", ...over };
}

function graph(): PedestrianGraph {
  return {
    meta: { bbox: [0, 0, 0, 0], builtAt: "", source: "test", licence: "", attribution: "", nodeCount: 3, edgeCount: 4 },
    nodes: [
      { id: "a", lng: A[0], lat: A[1], kind: "crossing" },
      { id: "b", lng: B[0], lat: B[1], kind: "crossing" },
      { id: "c", lng: C[0], lat: C[1], kind: "crossing" },
    ],
    edges: [
      // One OpenStreetMap crossing, split in two halves at the road axis.
      edge({ id: "x1", from: "a", to: "b", geometry: [A, B], osmWayId: 7, name: "Σταδίου", crossing: { signals: "yes", sound: "unknown", marked: "yes" } }),
      edge({ id: "x2", from: "b", to: "c", geometry: [B, C], osmWayId: 7, name: "Σταδίου", crossing: { signals: "yes", sound: "unknown", marked: "yes" } }),
      // Already known: no mission for sound, none for tactile paving.
      edge({ id: "y", from: "a", to: "c", geometry: [A, C], osmWayId: 8, tactilePaving: "yes", crossing: { signals: "yes", sound: "yes", marked: "yes" } }),
      { id: "s", from: "a", to: "c", lengthM: 20, kind: "sidewalk", geometry: [A, C], name: "Αθηνάς" },
    ],
  };
}

const P1 = "device-aaaaaaaa";
const P2 = "device-bbbbbbbb";
const P3 = "device-cccccccc";

describe("missions from gaps in the map", () => {
  it("makes one mission per crossing and per unknown fact", () => {
    const board = new MissionBoard(graph());
    const ids = board.all().map((m) => m.id).sort();
    expect(ids).toEqual(["crossing_sound:w7", "crossing_tactile:w7"]);
    const sound = board.all().find((m) => m.type === "crossing_sound")!;
    expect(sound.edgeIds).toEqual(["x1", "x2"]);
    expect(sound.where).toBe("Σταδίου");
    expect(sound.question).toContain("ηχητικό σήμα");
  });

  it("lists the nearest missions and leaves out distant ones", () => {
    const board = new MissionBoard(graph());
    expect(board.near(B, [], 100).length).toBe(2);
    expect(board.near(FAR, [], 100).length).toBe(0);
  });
});

describe("answers", () => {
  it("needs two different people to agree before the map changes", () => {
    const g = graph();
    const board = new MissionBoard(g);
    const first = board.answer("crossing_sound:w7", P1, "yes", B, NOW);
    expect(first.ok && first.confirmed).toBe(null);
    expect(g.edges[0]!.crossing!.sound).toBe("unknown");

    const second = board.answer("crossing_sound:w7", P2, "yes", B, NOW);
    expect(second.ok && second.confirmed?.value).toBe("yes");
    // Both halves of the crossing now carry the fact the router reads.
    expect(g.edges[0]!.crossing!.sound).toBe("yes");
    expect(g.edges[1]!.crossing!.sound).toBe("yes");
    // The mission is gone; the tactile one stays.
    expect(board.all().map((m) => m.id)).toEqual(["crossing_tactile:w7"]);
    expect(board.confirmedObservations()).toHaveLength(1);
  });

  it("does not confirm when people disagree", () => {
    const g = graph();
    const board = new MissionBoard(g);
    board.answer("crossing_tactile:w7", P1, "yes", B, NOW);
    const r = board.answer("crossing_tactile:w7", P2, "no", B, NOW);
    expect(r.ok && r.confirmed).toBe(null);
    const third = board.answer("crossing_tactile:w7", P3, "no", B, NOW);
    expect(third.ok && third.confirmed?.value).toBe("no");
    expect(g.edges[0]!.tactilePaving).toBe("no");
  });

  it("refuses a second answer from the same person, an answer from far away, and a closed mission", () => {
    const board = new MissionBoard(graph());
    expect(board.answer("crossing_sound:w7", P1, "yes", FAR, NOW)).toMatchObject({ ok: false, code: "too_far" });
    expect(board.answer("crossing_sound:w7", P1, "yes", B, NOW).ok).toBe(true);
    expect(board.answer("crossing_sound:w7", P1, "no", B, NOW)).toMatchObject({ ok: false, code: "already_answered" });
    board.answer("crossing_sound:w7", P2, "yes", B, NOW);
    expect(board.answer("crossing_sound:w7", P3, "yes", B, NOW)).toMatchObject({ ok: false, code: "closed" });
    expect(board.answer("crossing_sound:nope", P3, "yes", B, NOW)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("limits answers per person per day", () => {
    const board = new MissionBoard(graph(), { dailyLimit: 1 });
    expect(board.answer("crossing_sound:w7", P1, "yes", B, NOW).ok).toBe(true);
    expect(board.answer("crossing_tactile:w7", P1, "yes", B, NOW)).toMatchObject({ ok: false, code: "daily_limit" });
    const tomorrow = new Date(NOW.getTime() + 24 * 3600_000);
    expect(board.answer("crossing_tactile:w7", P1, "yes", B, tomorrow).ok).toBe(true);
  });

  it("gives points for an answer and a bonus to everyone whose answer was confirmed", () => {
    const board = new MissionBoard(graph());
    board.answer("crossing_sound:w7", P1, "yes", B, NOW);
    expect(board.profile(P1).points).toBe(15);
    const r = board.answer("crossing_sound:w7", P2, "yes", B, NOW);
    expect(r.ok && r.pointsEarned).toBe(35);
    expect(board.profile(P1)).toMatchObject({ points: 35, confirmed: 1, level: "Νέος χαρτογράφος" });
    expect(board.profile(P1).nextLevel).toEqual({ name: "Χαρτογράφος της γειτονιάς", pointsNeeded: 15 });
  });

  it("gives almost nothing for 'unsure' and does not count it", () => {
    const board = new MissionBoard(graph());
    const r = board.answer("crossing_sound:w7", P1, "unsure", B, NOW);
    expect(r.ok && r.pointsEarned).toBe(2);
    expect(r.ok && r.mission.answers).toEqual({ yes: 0, no: 0 });
  });

  it("lets the demo control answer without a position", () => {
    const board = new MissionBoard(graph());
    expect(board.answer("crossing_sound:w7", P1, "yes", null, NOW).ok).toBe(true);
  });
});

describe("obstacle checks", () => {
  const report: Obstacle = {
    id: "sandbox:req-1001", edgeId: "s", blocks: "partial", type: "sidewalk", label: "Εμπόδιο στο πεζοδρόμιο",
    source: { kind: "sandbox_request", ref: "req-1001" }, synthetic: true, observedAt: NOW.toISOString(),
    expiresAt: null, confidence: 0.6, position: B,
  };

  it("turns an unconfirmed report into a mission and drops it once the report is a full block", () => {
    const board = new MissionBoard(graph());
    const missions = board.all([report]);
    const check = missions.find((m) => m.type === "obstacle_check")!;
    expect(check).toMatchObject({ id: "obstacle_check:req-1001", reportRef: "req-1001", where: "Αθηνάς", points: 20 });
    expect(board.all([{ ...report, blocks: "full" }]).some((m) => m.type === "obstacle_check")).toBe(false);
  });

  it("does not make missions from projects or synthetic obstacles", () => {
    const board = new MissionBoard(graph());
    expect(board.all([{ ...report, source: { kind: "sandbox_project", ref: "prj-1" } }]).some((m) => m.type === "obstacle_check")).toBe(false);
  });
});

describe("rewards", () => {
  const benefits = [
    { id: "b1", partner: "Δημοτική Πινακοθήκη", category: "culture", title: "Δωρεάν είσοδος σε περιοδικές εκθέσεις" },
    { id: "b2", partner: "Δημοτικά Κολυμβητήρια", category: "sports", title: "20% έκπτωση στη μηνιαία συνδρομή" },
    { id: "b3", partner: "Φούρνος «Σταχυ»", category: "food", title: "10% έκπτωση σε όλα τα προϊόντα" },
  ];

  it("prices what the City gives from its own venues lowest", () => {
    expect(pointsFor(benefits[0]!)).toEqual({ points: 50, municipal: true });
    expect(pointsFor(benefits[1]!)).toEqual({ points: 80, municipal: true });
    expect(pointsFor(benefits[2]!)).toEqual({ points: 120, municipal: false });
  });

  it("unlocks by points and sorts the cheapest first", () => {
    const rewards = toRewards(benefits, 60);
    expect(rewards.map((r) => [r.id, r.unlocked])).toEqual([["b1", true], ["b2", false], ["b3", false]]);
  });
});
