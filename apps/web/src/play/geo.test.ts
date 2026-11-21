import { describe, expect, it } from "vitest";
import type { LngLat } from "@ion/core";
import {
  bearingDeg, calibrationOffset, courseBetween, direction, directionWords, distanceM, distanceWords, edgePoint,
  headingFromOrientation, inReach, shortDistance, moveBy, normalise, platePlacement, reachM, REACH_M, ring, roundDistance, smoothHeading, turn,
} from "./geo";

const syntagma: LngLat = [23.7349, 37.9755];

describe("distance and bearing", () => {
  it("measures a known distance in central Athens", () => {
    // Syntagma to Omonoia is about 1.0 km in a straight line.
    const omonoia: LngLat = [23.7280, 37.9841];
    expect(distanceM(syntagma, omonoia)).toBeGreaterThan(1050);
    expect(distanceM(syntagma, omonoia)).toBeLessThan(1200);
    expect(distanceM(syntagma, syntagma)).toBe(0);
  });
  it("gives the four compass bearings", () => {
    expect(bearingDeg(syntagma, [syntagma[0], syntagma[1] + 0.001])).toBeCloseTo(0, 1);
    expect(bearingDeg(syntagma, [syntagma[0] + 0.001, syntagma[1]])).toBeCloseTo(90, 1);
    expect(bearingDeg(syntagma, [syntagma[0], syntagma[1] - 0.001])).toBeCloseTo(180, 1);
    expect(bearingDeg(syntagma, [syntagma[0] - 0.001, syntagma[1]])).toBeCloseTo(270, 1);
  });
  it("moves a point by metres along a bearing, and back", () => {
    const there = moveBy(syntagma, 40, 25);
    expect(distanceM(syntagma, there)).toBeCloseTo(25, 1);
    expect(bearingDeg(syntagma, there)).toBeCloseTo(40, 0);
    expect(distanceM(moveBy(there, 40, -25), syntagma)).toBeLessThan(0.05);
  });
  it("draws a closed ring at the reach radius", () => {
    const points = ring(syntagma, REACH_M, 24);
    expect(points).toHaveLength(25);
    expect(points[0]).toEqual(points[24]);
    for (const p of points) expect(distanceM(syntagma, p)).toBeCloseTo(REACH_M, 0);
  });
  it("normalises angles and takes the short way round", () => {
    expect(normalise(-10)).toBe(350);
    expect(normalise(725)).toBe(5);
    expect(turn(350, 10)).toBe(20);
    expect(turn(10, 350)).toBe(-20);
    expect(turn(0, 180)).toBe(180);
  });
});

describe("reach", () => {
  it("is 30 metres with a good fix", () => {
    expect(inReach(30)).toBe(true);
    expect(inReach(30.5)).toBe(false);
    expect(inReach(29, 8)).toBe(true);
  });
  it("widens with a poor fix, never past the server's 60 metres", () => {
    expect(reachM(25)).toBe(45);
    expect(inReach(44, 25)).toBe(true);
    expect(reachM(500)).toBe(60);
    expect(inReach(61, 500)).toBe(false);
    expect(reachM(Number.NaN)).toBe(30);
  });
});

describe("words for distance and direction", () => {
  it("rounds as the design asks", () => {
    expect(roundDistance(43)).toBe(45);
    expect(roundDistance(1234)).toBe(1250);
    expect(distanceWords(43)).toBe("45 μέτρα");
    expect(distanceWords(12)).toBe("κοντά");
    expect(distanceWords(43, 15)).toBe("περίπου 45 μέτρα");
    expect(distanceWords(43, 40)).toBe("γύρω στα 45 μέτρα");
    expect(distanceWords(1500)).toBe("1,5 χιλιόμετρα");
    expect(shortDistance(52)).toBe("50 μ.");
    expect(shortDistance(8)).toBe("κοντά");
    expect(shortDistance(1480)).toBe("1,5 χλμ.");
  });
  it("says ahead, right, behind and left, never a clock face", () => {
    expect(direction(10, 0)).toBe("ahead");
    expect(direction(90, 0)).toBe("right");
    expect(direction(180, 0)).toBe("behind");
    expect(direction(270, 0)).toBe("left");
    expect(direction(0, 315)).toBe("ahead_right");
    expect(directionWords(100, 280)).toBe("πίσω σας");
    expect(directionWords(45, 0)).toBe("μπροστά δεξιά");
    expect(directionWords(350, 0)).toBe("μπροστά");
    expect(directionWords(200, 110)).not.toMatch(/ώρα/);
  });
  it("falls back to compass points when nobody knows where the person faces", () => {
    expect(directionWords(0, null)).toBe("βόρεια");
    expect(directionWords(135, null)).toBe("νοτιοανατολικά");
  });
});

describe("heading", () => {
  it("reads a flat phone from its top edge", () => {
    expect(headingFromOrientation(0, 0, 0)).toBeCloseTo(0);
    expect(headingFromOrientation(270, 0, 0)).toBeCloseTo(90); // alpha grows anticlockwise
    expect(headingFromOrientation(90, 10, 5)).toBeCloseTo(270, 0);
  });
  it("reads an upright phone from where its camera looks", () => {
    expect(headingFromOrientation(0, 90, 0)).toBeCloseTo(0);
    expect(headingFromOrientation(270, 80, 0)).toBeCloseTo(90);
    expect(headingFromOrientation(180, 70, 0)).toBeCloseTo(180);
  });
  it("does not jump when the phone is raised from flat to upright", () => {
    const flat = headingFromOrientation(300, 40, 0);
    const raised = headingFromOrientation(300, 50, 0);
    expect(Math.abs(turn(flat, raised))).toBeLessThan(1);
  });
  it("smooths across north without spinning the long way", () => {
    expect(smoothHeading(null, 370)).toBe(10);
    expect(smoothHeading(350, 10, 0.5)).toBeCloseTo(0);
    expect(smoothHeading(10, 350, 0.25)).toBeCloseTo(5);
  });
  it("learns a correction from facing the mission", () => {
    expect(calibrationOffset(90, 70)).toBe(20);
    expect(calibrationOffset(10, 350)).toBe(20);
    expect(calibrationOffset(350, 10)).toBe(-20);
  });
  it("takes a course from two fixes only after a real move", () => {
    expect(courseBetween(syntagma, moveBy(syntagma, 90, 2))).toBeNull();
    expect(courseBetween(syntagma, moveBy(syntagma, 90, 12))).toBeCloseTo(90, 0);
  });
});

describe("the plate in the camera view", () => {
  it("sits in the middle when the phone points at the mission", () => {
    expect(platePlacement(120, 120, 60)).toEqual({ visible: true, x: 0.5, side: null, turn: 0 });
  });
  it("slides with the heading", () => {
    expect(platePlacement(120, 105, 60).x).toBeCloseTo(0.75);
    expect(platePlacement(120, 135, 60).x).toBeCloseTo(0.25);
    expect(platePlacement(5, 355, 60).x).toBeCloseTo(0.5 + 10 / 60);
  });
  it("gives an arrow when the mission is out of view", () => {
    expect(platePlacement(120, 60, 60)).toMatchObject({ visible: false, side: "right", x: 1 });
    expect(platePlacement(120, 200, 60)).toMatchObject({ visible: false, side: "left", x: 0 });
    expect(platePlacement(0, 180, 60).visible).toBe(false);
  });
});

describe("the arrow at the edge of the board", () => {
  it("lands on the border in the direction asked", () => {
    expect(edgePoint(0, 400, 600)).toEqual({ x: 200, y: 0 });
    expect(edgePoint(90, 400, 600).x).toBeCloseTo(400);
    expect(edgePoint(90, 400, 600).y).toBeCloseTo(300);
    expect(edgePoint(180, 400, 600).y).toBeCloseTo(600);
    expect(edgePoint(270, 400, 600).x).toBeCloseTo(0);
  });
  it("respects the inset", () => {
    const p = edgePoint(45, 400, 600, 50);
    expect(p.x).toBeCloseTo(350);
    expect(p.y).toBeCloseTo(150);
  });
});
