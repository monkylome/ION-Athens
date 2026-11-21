import { describe, expect, it } from "vitest";
import type { LngLat } from "@ion/core";
import { moveBy } from "./geo";
import {
  changeSentence, crossed, describeNearby, levelProgress, missionLine, nearby, neighbourhoodLine, nextReward, nextRewardLine,
  addStamp, albumTiles, discoveryEvent, mergeDiscoveries, readDiscovery, visionReady, factKnown, factWords, kindOf, typeLabel, outcome, outsideLine, parseSpokenAnswer, venueLine, venueProgress, places, pointsObject, pointsWords, readNeighbourhood, refusal, type Mission, type Reward,
} from "./game";

const here: LngLat = [23.7257, 37.9762];
const mission = (id: string, bearing: number, metres: number, extra: Partial<Mission> = {}): Mission => ({
  id, type: "crossing_sound", question: "Έχει ηχητικό σήμα το φανάρι σε αυτή τη διάβαση;", position: moveBy(here, bearing, metres),
  where: "Σταδίου", points: 15, answers: { yes: 0, no: 0 }, ...extra,
});
const reward = (id: string, pointsRequired: number, title = id): Reward => ({ id, title, partner: "Δημοτική Πινακοθήκη", pointsRequired, unlocked: false });

describe("missions around the player", () => {
  const list = nearby([mission("far", 90, 120), mission("near", 0, 20), mission("mid", 180, 45)], here);
  it("sorts by distance and marks what is in reach", () => {
    expect(list.map((n) => n.mission.id)).toEqual(["near", "mid", "far"]);
    expect(list.map((n) => n.reachable)).toEqual([true, false, false]);
    expect(list[1]!.distance).toBeCloseTo(45, 0);
    expect(list[2]!.bearing).toBeCloseTo(90, 0);
  });
  it("lets a poor fix reach a little further", () => {
    expect(nearby([mission("mid", 180, 45)], here, 30)[0]!.reachable).toBe(true);
  });
});

describe("places on the board", () => {
  const theatre = moveBy(here, 45, 20);
  const list = nearby([
    mission("ramp", 0, 0, { position: theatre, type: "venue_check", venueId: "theatre-1", points: 15 }),
    mission("toilet", 0, 0, { position: theatre, type: "venue_check", venueId: "theatre-1", points: 15 }),
    mission("lone", 200, 80),
  ], here);
  it("puts questions about one spot on one plate", () => {
    const spots = places(list);
    expect(spots).toHaveLength(2);
    expect(spots[0]).toMatchObject({ open: 2, reachable: true, first: { mission: { id: "ramp" } } });
    expect(spots[1]).toMatchObject({ open: 1, reachable: false });
  });
  it("opens the next unanswered question, and knows when a place is done", () => {
    expect(places(list, new Set(["ramp"]))[0]).toMatchObject({ open: 1, first: { mission: { id: "toilet" } } });
    expect(places(list, new Set(["ramp", "toilet"]))[0]!.open).toBe(0);
  });
  it("merges spots a few metres apart, and keeps apart what is further", () => {
    const close = nearby([mission("a", 0, 5), mission("b", 90, 8), mission("c", 0, 60)], here);
    const spots = places(close);
    expect(spots.map((s) => s.items.length)).toEqual([2, 1]);
    expect(spots[0]!.key).toBe("a");
  });
});

describe("objects and the album", () => {
  it("reaches a place from inside its building, out to the server's limit", () => {
    const list = nearby([mission("hall", 0, 54, { venueId: "hall", type: "venue_check" }), mission("crossing", 90, 54)], here);
    expect(list.find((n) => n.mission.id === "hall")!.reachable).toBe(true);
    expect(list.find((n) => n.mission.id === "crossing")!.reachable).toBe(false);
    expect(nearby([mission("hall", 0, 70, { venueId: "hall" })], here)[0]!.reachable).toBe(false);
  });
  it("keeps a place apart from a street object beside it", () => {
    const list = nearby([mission("hall", 0, 10, { venueId: "hall", type: "venue_check" }), mission("crowd", 0, 12, { type: "crowd_check" })], here);
    expect(places(list)).toHaveLength(2);
  });
  it("gives every mission a glyph family, known type or not", () => {
    expect(kindOf({ type: "crossing_sound" })).toBe("sound");
    expect(kindOf({ type: "crossing_tactile" })).toBe("tactile");
    expect(kindOf({ type: "obstacle_check" })).toBe("obstacle");
    expect(kindOf({ type: "crowd_check" })).toBe("crowd");
    expect(kindOf({ type: "anything", venueId: "v" })).toBe("place");
    expect(kindOf({ type: "bench_check" })).toBe("other");
    expect(typeLabel("bench_check", "Έχει παγκάκι εδώ;")).toBe("Έχει παγκάκι εδώ;");
  });
  it("fills the album by type and leaves empty slots for what is still to find", () => {
    let stamps = addStamp([], { id: "a", type: "crowd_check", question: "q", confirmed: false });
    stamps = addStamp(stamps, { id: "b", type: "crowd_check", question: "q", confirmed: true });
    stamps = addStamp(stamps, { id: "a", type: "crowd_check", question: "q", confirmed: true }); // the same mission, now confirmed
    const tiles = albumTiles(stamps, ["crossing_sound", "crowd_check", "venue_check"]);
    expect(tiles[0]).toEqual({ type: "crowd_check", label: "Κόσμος", count: 2, confirmed: 2 });
    expect(tiles.slice(1).map((t) => [t.label, t.count])).toEqual([["Ηχητικά φανάρια", 0], ["Χώροι", 0]]);
  });
});

describe("level and next reward", () => {
  it("measures progress toward the next level", () => {
    expect(levelProgress({ points: 20, nextLevel: { name: "Χαρτογράφος της γειτονιάς", pointsNeeded: 30 } })).toBeCloseTo(0.4);
    expect(levelProgress({ points: 100, nextLevel: { name: "Μάτια της πόλης", pointsNeeded: 50 } }, 50)).toBeCloseTo(0.5);
    expect(levelProgress({ points: 300, nextLevel: null })).toBeNull();
  });
  it("points at the cheapest reward not yet reached, in the server's order", () => {
    const rewards = [reward("a", 50, "Δωρεάν είσοδος σε περιοδικές εκθέσεις"), reward("b", 50), reward("c", 80), reward("d", 120)];
    expect(nextReward(rewards, 18)).toMatchObject({ reward: { id: "a" }, pointsNeeded: 32 });
    expect(nextReward(rewards, 18)!.progress).toBeCloseTo(0.36);
    expect(nextRewardLine(nextReward(rewards, 18))).toBe("32 πόντοι ως: Δωρεάν είσοδος σε περιοδικές εκθέσεις");
    expect(nextReward(rewards, 50)).toMatchObject({ reward: { id: "c" }, pointsNeeded: 30 });
    expect(nextRewardLine(nextReward(rewards, 79))).toBe("1 πόντος ως: c");
    expect(nextReward(rewards, 120)).toBeNull();
    expect(nextRewardLine(null)).toBe("Έχετε ξεκλειδώσει όλα τα προνόμια.");
  });
  it("finds the rewards an answer crossed", () => {
    const rewards = [reward("a", 50), reward("b", 50), reward("c", 80)];
    expect(crossed(rewards, 45, 60).map((r) => r.id)).toEqual(["a", "b"]);
    expect(crossed(rewards, 50, 60)).toEqual([]);
    expect(crossed(rewards, 45, 80).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(crossed(rewards, 45, 49)).toEqual([]);
  });
  it("counts points in Greek", () => {
    expect(pointsWords(1)).toBe("1 πόντος");
    expect(pointsWords(15)).toBe("15 πόντοι");
    expect(pointsObject(70)).toBe("70 πόντους");
    expect(pointsObject(1)).toBe("1 πόντο");
  });
});

describe("what the card says", () => {
  const m = mission("m", 0, 10);
  it("says one more citizen is needed after a first answer", () => {
    expect(outcome({ confirmed: null, mission: m }, "yes")).toMatchObject({ confirmed: false, line: "Η απάντησή σας καταγράφηκε. Χρειάζεται ένας ακόμα δημότης.", change: null });
  });
  it("does not promise a confirmation after an unsure", () => {
    expect(outcome({ confirmed: null, mission: m }, "unsure").line).not.toMatch(/ένας ακόμα/);
  });
  it("says what the second answer changed", () => {
    const told = outcome({ confirmed: { missionId: "m", type: "crossing_sound", where: "Σταδίου", value: "yes" }, mission: m }, "yes");
    expect(told.line).toBe("Επιβεβαιώθηκε. Ο χάρτης άλλαξε για όλους.");
    expect(told.change).toBe("Σταδίου: το φανάρι έχει πλέον ηχητικό σήμα στον χάρτη.");
    expect(told.stamp).toBe("Επιβεβαιώθηκε");
  });
  it("words a change without a street, and a no", () => {
    expect(changeSentence({ type: "crossing_tactile", value: "no" })).toBe("Η διάβαση σημειώθηκε στον χάρτη χωρίς οδηγό όδευσης τυφλών.");
  });
  it("words a mission type it has never seen from its own question", () => {
    expect(changeSentence({ type: "venue_check", where: "Θέατρο", value: "yes" }, "Έχει ράμπα η είσοδος;")).toBe("Θέατρο: «Έχει ράμπα η είσοδος;» Ναι. Είναι πλέον στον χάρτη για όλους.");
  });
  it("refuses plainly and kindly", () => {
    expect(refusal("too_far", "x", 84)).toMatch(/περίπου 84 μέτρα/);
    expect(refusal("already_answered", undefined)).toMatch(/Έχετε ήδη απαντήσει/);
    expect(refusal("daily_limit", undefined)).toMatch(/όριο αποστολών για σήμερα/);
    expect(refusal("something_new", "Κάτι στα ελληνικά.")).toBe("Κάτι στα ελληνικά.");
    expect(refusal(undefined, "HTTP 500")).toBe("Η απάντηση δεν καταχωρίστηκε. Δοκιμάστε ξανά σε λίγο.");
  });
});

describe("the board in words", () => {
  const list = nearby([mission("a", 0, 20), mission("b", 90, 45, { where: undefined, question: "Έχει πολύ κόσμο εδώ τώρα;", points: 10 }), mission("c", 180, 120)], here);
  it("describes one mission: what, where, how far and which way", () => {
    expect(missionLine(list[1]!, 0)).toBe("Έχει πολύ κόσμο εδώ τώρα; 45 μέτρα δεξιά. 10 πόντοι.");
    expect(missionLine(list[0]!, 0)).toBe("Έχει ηχητικό σήμα το φανάρι σε αυτή τη διάβαση; Σταδίου, 20 μέτρα μπροστά. 15 πόντοι. Μπορείτε να απαντήσετε τώρα.");
    expect(missionLine(list[2]!, 0)).toMatch(/Σταδίου, 120 μέτρα πίσω σας\. 15 πόντοι\.$/);
  });
  it("reads the nearest missions, nearest first", () => {
    const text = describeNearby(list, 0);
    expect(text).toMatch(/^3 αποστολές κοντά σας\. Μία είναι στην εμβέλειά σας\. Πρώτη: /);
    expect(text.indexOf("Πρώτη")).toBeLessThan(text.indexOf("Δεύτερη"));
    expect(text).toMatch(/Τρίτη: .*πίσω σας/);
    expect(text).not.toMatch(/η ώρα/);
  });
  it("turns with the person", () => {
    expect(describeNearby(list.slice(0, 1), 180)).toMatch(/πίσω σας/);
    expect(describeNearby(list.slice(0, 1), null)).toMatch(/βόρεια/);
  });
  it("says so when nothing is near", () => {
    expect(describeNearby([], 0)).toMatch(/^Δεν υπάρχουν ανοιχτές αποστολές κοντά σας/);
  });
  it("says «κοντά» under fifteen metres", () => {
    expect(missionLine(nearby([mission("x", 270, 8)], here)[0]!, 0)).toMatch(/Σταδίου, κοντά σας, αριστερά\./);
  });
});

describe("a place and its card", () => {
  const venue = { name: "Ολύμπια, Δημοτικό Μουσικό Θέατρο «Μαρία Κάλλας»", facts: [
    { key: "wheelchair", question: "Είναι ο χώρος προσβάσιμος με αμαξίδιο;", value: null, source: "unknown" },
    { key: "elevator", question: "Έχει ανελκυστήρα για το κοινό;", value: "yes", source: "citizen_mission" },
    { key: "guide_dog", question: "Δέχεται σκύλο-οδηγό;", value: "no", source: "citizen_mission" },
  ] };
  it("counts what is known, and starts from nothing", () => {
    expect(venueProgress(venue)).toEqual({ known: 2, total: 3 });
    expect(venueLine(venue)).toBe("Ολύμπια: 2 από 3 στοιχεία");
    expect(venueLine({ name: "Ολύμπια", facts: venue.facts.map((f) => ({ ...f, value: null })) })).toBe("Ολύμπια: 0 από 3 στοιχεία");
  });
  it("words a fact", () => {
    expect(venue.facts.map(factKnown)).toEqual([false, true, true]);
    expect(venue.facts.map(factWords)).toEqual(["άγνωστο ακόμα", "Ναι", "Όχι"]);
  });
});

describe("outside the mapped area", () => {
  it("says nothing is mapped here and where the nearest mission is", () => {
    expect(outsideLine({ distance: 702, bearing: 92 })).toBe("Εδώ δεν έχει χαρτογραφηθεί ακόμα τίποτα. Η κοντινότερη αποστολή είναι 700 μέτρα προς τα ανατολικά.");
    expect(outsideLine({ distance: 1480, bearing: 270 }, 15)).toMatch(/περίπου 1,5 χιλιόμετρα προς τα δυτικά\.$/);
    expect(outsideLine(null)).toBe("Εδώ δεν έχει χαρτογραφηθεί ακόμα τίποτα.");
  });
});

describe("discoveries from the scan mode", () => {
  it("requires a configured model that answers", () => {
    expect(visionReady({ configured: true, answering: true })).toBe(true);
    expect(visionReady({ configured: true, answering: false })).toBe(false);
    expect(visionReady({ model: "llava" })).toBe(false);
  });
  it("merges actual stream events and a late list response without downgrading proof", () => {
    const first = {id:"d1", position:[23.73,37.98], label:"Ράμπα", seenBy:1, confirmed:false};
    const second = {...first, confirmed:true, seenBy:2};
    const added = discoveryEvent({type:"discovery_added", discovery:first})!;
    const fact = discoveryEvent({type:"discovery_confirmed", discovery:second})!;
    expect(added.confirmed).toBe(false);
    expect(fact.at).toEqual(first.position);
    expect(mergeDiscoveries([fact], [added])).toEqual([fact]);
    expect(discoveryEvent({type:"discovery_confirmed", discovery:first})).toBeNull();
    expect(discoveryEvent({type:"map_updated", discovery:second})).toBeNull();
    expect(readDiscovery({...second, position:null})).toBeNull();
  });
});

describe("a spoken answer", () => {
  it("understands the three answers", () => {
    expect(parseSpokenAnswer("Ναι")).toBe("yes");
    expect(parseSpokenAnswer("όχι.")).toBe("no");
    expect(parseSpokenAnswer("δεν είμαι σίγουρος")).toBe("unsure");
    expect(parseSpokenAnswer("Δεν είμαι σίγουρη")).toBe("unsure");
    expect(parseSpokenAnswer("δεν ξέρω")).toBe("unsure");
    expect(parseSpokenAnswer("ναι έχει")).toBe("yes");
  });
  it("does not guess", () => {
    expect(parseSpokenAnswer("καλημέρα")).toBeNull();
    expect(parseSpokenAnswer("")).toBeNull();
  });
});

describe("neighbourhood progress, whatever shape the server gives", () => {
  it("reads a list with counts and picks the one the player is in", () => {
    const body = { neighbourhoods: [{ name: "Ψυρρή", total: 40, confirmed: 6, center: [23.7257, 37.9785] }, { name: "Πλάκα", total: 30, confirmed: 3, center: [23.7300, 37.9720] }] };
    expect(readNeighbourhood(body, [23.7258, 37.9780])).toEqual({ name: "Ψυρρή", done: 6, total: 40 });
    expect(neighbourhoodLine({ name: "Ψυρρή", done: 6, total: 40 })).toBe("Ψυρρή: 6 από 40 σημεία στον χάρτη");
  });
  it("reads the server's list by the area a mission names, and claims none without it", () => {
    const body = { neighbourhoods: [{ name: "Ακρόπολη", total: 58, confirmed: 0, percent: 0 }, { name: "Μοναστηράκι", total: 178, confirmed: 2, percent: 1.1 }] };
    expect(readNeighbourhood(body, here, "Μοναστηράκι")).toEqual({ name: "Μοναστηράκι", done: 2, total: 178 });
    expect(readNeighbourhood(body, here)).toBeNull();
  });
  it("reads a single current neighbourhood and open counts", () => {
    expect(readNeighbourhood({ current: { title: "Κουκάκι", missions: 20, open: 15 } })).toEqual({ name: "Κουκάκι", done: 5, total: 20 });
  });
  it("reads a bare share", () => {
    expect(readNeighbourhood([{ name: "Θησείο", progress: 0.25 }])).toEqual({ name: "Θησείο", done: 25, total: 100 });
  });
  it("ignores what it cannot read", () => {
    expect(readNeighbourhood({ error: { code: "not_found" } })).toBeNull();
    expect(readNeighbourhood(null)).toBeNull();
    expect(readNeighbourhood({ neighbourhoods: [{ name: "Χωρίς αριθμούς" }] })).toBeNull();
  });
});
