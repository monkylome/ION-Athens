import { describe, expect, it } from "vitest";
import {
  NOTICE_OFF, NOTICE_ON, STOP_TEXT, WALK_INTERVAL_MS, WALK_LIMIT_MS, confirmText, counterText, fitSize, metresBetween, movedEnough, notice, turnedDeg, walkStop,
} from "./logic";

describe("scan logic", () => {
  it("shrinks the longest side to 1024 and never enlarges", () => {
    expect(fitSize(4000, 3000)).toEqual({ width: 1024, height: 768 });
    expect(fitSize(3000, 4000)).toEqual({ width: 768, height: 1024 });
    expect(fitSize(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it("says the counter in the screen's words", () => {
    expect(counterText(7, 5)).toBe("Το μοντέλο πρότεινε 7, επιβεβαιώσατε 5");
  });

  it("tells a confirmation in the map's own terms, with the points", () => {
    expect(confirmText({ needsSecond: true, discovery: false, pointsEarned: 15 })).toBe("Καταγράφηκε. Χρειάζεται ένας ακόμα δημότης. 15 πόντοι.");
    expect(confirmText({ needsSecond: false, discovery: true, pointsEarned: 30 })).toBe("Επιβεβαιώθηκε. Ο χάρτης άλλαξε για όλους. 30 πόντοι.");
    expect(confirmText({ needsSecond: true, discovery: true, pointsEarned: 0 })).toBe("Καταγράφηκε. Χρειάζεται ένας ακόμα δημότης.");
  });

  it("makes the always-visible line follow the donate switch", () => {
    expect(notice(false)).toBe("Η εικόνα αναλύεται και δεν αποθηκεύεται. Αποφασίζετε εσείς τι μπαίνει στον χάρτη.");
    expect(notice(true)).toBe("Η φωτογραφία αυτή θα κρατηθεί στον διακομιστή του Δήμου για ανάλυση. Μπορεί να δείχνει περαστικούς.");
    expect(NOTICE_OFF).not.toBe(NOTICE_ON);
  });

  it("sends a walking frame only after the person moved or turned", () => {
    const here = { lng: 23.7275, lat: 37.9755, heading: 90 };
    expect(movedEnough(null, here)).toBe(true);
    expect(movedEnough(here, { ...here })).toBe(false);
    expect(movedEnough(here, { ...here, lat: here.lat + 0.0001 })).toBe(true); // about 11 m
    expect(movedEnough(here, { ...here, heading: 130 })).toBe(true);
    expect(turnedDeg(350, 10)).toBe(20);
    expect(metresBetween(here, { ...here, lat: here.lat + 0.001 })).toBeGreaterThan(100);
  });

  it("stops the walking scan after two minutes, when hidden, or when the model is slower than the interval", () => {
    const base = { startedAt: 0, now: 1000, hidden: false, lastLatencyMs: 3000 };
    expect(walkStop(base)).toBeNull();
    expect(walkStop({ ...base, now: WALK_LIMIT_MS })).toBe("time");
    expect(walkStop({ ...base, hidden: true })).toBe("hidden");
    expect(walkStop({ ...base, lastLatencyMs: WALK_INTERVAL_MS + 1 })).toBe("slow");
    expect(walkStop({ ...base, lastLatencyMs: null })).toBeNull();
    expect(WALK_LIMIT_MS).toBe(120_000);
    expect(Object.keys(STOP_TEXT)).toEqual(["time", "hidden", "slow"]);
  });
});
