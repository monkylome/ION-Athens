import { describe, expect, it } from "vitest";
import type { Announcement } from "@ion/core";
import { captionSentences, crossingFacts, instructionView, ontoStreet, phraseFor, SAY, wordDurations } from "./phrases";

const turn = (over: Partial<Extract<Announcement, { type: "turn" }>> = {}): Announcement => ({
  type: "turn", key: "k", text: "", phase: "ahead", atNode: "n", distanceM: 30, direction: "right", ...over,
});
const obstacle = (over: Partial<Extract<Announcement, { type: "obstacle" }>> = {}): Announcement => ({
  type: "obstacle", key: "o", text: "", outcome: "reroute", obstacleId: "x", label: "Εμπόδιο", distanceToObstacleM: 60,
  distanceToDecisionM: 40, direction: "right", extraDistanceM: 80, ...over,
});

describe("spoken Greek", () => {
  it("gives a turn its distance, written out, in the polite plural", () => {
    expect(phraseFor(turn({ onto: "Ερμού" }))).toBe("Σε 30 μέτρα, στρίψτε δεξιά στην οδό Ερμού.");
    expect(phraseFor(turn({ phase: "now", distanceM: 0, direction: "left" }))).toBe("Στρίψτε αριστερά τώρα.");
    expect(phraseFor(turn({ direction: "slight_left" }))).toBe("Σε 30 μέτρα, συνεχίστε ελαφρά αριστερά.");
  });

  it("says «κοντά» at 15 metres or less instead of a number", () => {
    const text = phraseFor(turn({ distanceM: 15 }));
    expect(text).toBe("Η γωνία είναι κοντά. Στρίψτε δεξιά.");
    expect(text).not.toMatch(/\d/);
  });

  it("names a square, an avenue and a plain street correctly", () => {
    expect(ontoStreet("Πλατεία Μοναστηρακίου")).toBe(" στην πλατεία Μοναστηρακίου");
    expect(ontoStreet("Λεωφόρος Αμαλίας")).toBe(" στη λεωφόρο Αμαλίας");
    expect(ontoStreet("Αθηνάς")).toBe(" στην οδό Αθηνάς");
    expect(ontoStreet(undefined)).toBe("");
  });

  it("describes a crossing and never tells the person to cross", () => {
    const facts = [
      { signals: "yes", sound: "yes", marked: "yes" },
      { signals: "yes", sound: "no", marked: "yes" },
      { signals: "yes", sound: "unknown", marked: "unknown" },
      { signals: "no", sound: "no", marked: "no" },
      { signals: "unknown", sound: "unknown", marked: "unknown" },
    ] as const;
    for (const crossing of facts) {
      for (const phase of ["ahead", "now"] as const) {
        const text = phraseFor({ type: "crossing", key: "c", text: "", phase, atNode: "n", distanceM: phase === "ahead" ? 25 : 0, crossing });
        expect(text).toMatch(/διάβαση πεζών/i);
        expect(text).not.toMatch(/περάστε|διασχίστε|προχωρήστε|ασφαλές/i);
      }
    }
    expect(crossingFacts(facts[1])).toBe("Έχει φανάρι, χωρίς ηχητικό σήμα.");
  });

  it("reports an unknown as not confirmed, never as absent", () => {
    expect(crossingFacts({ signals: "unknown", sound: "unknown", marked: "unknown" })).toBe("Δεν είναι επιβεβαιωμένο αν έχει φανάρι.");
    expect(crossingFacts({ signals: "yes", sound: "unknown", marked: "unknown" })).toContain("Δεν είναι επιβεβαιωμένο");
  });

  it("announces a route change as what, where, what to do, with its cost", () => {
    expect(phraseFor(obstacle())).toBe(
      "Εμπόδιο μπροστά, σε 60 μέτρα. Η διαδρομή αλλάζει. Σε 40 μέτρα, στρίψτε δεξιά. Η νέα διαδρομή είναι 80 μέτρα μακρύτερη.",
    );
  });

  it("leads with the action when the turn is imminent", () => {
    expect(phraseFor(obstacle({ lateWarning: true, distanceToDecisionM: 5 }))).toBe("Στρίψτε δεξιά τώρα, στη γωνία. Ο δρόμος μπροστά είναι κλειστός.");
    expect(phraseFor(obstacle({ lateWarning: true, distanceToDecisionM: 10 }))).toMatch(/^Σε 10 μέτρα, στρίψτε δεξιά\./);
  });

  it("covers the outcomes without a turn", () => {
    expect(phraseFor(obstacle({ outcome: "keep_route" }))).toBe("Υπάρχει εμπόδιο στο επόμενο τμήμα της διαδρομής, σε 60 μέτρα. Η διαδρομή δεν αλλάζει.");
    expect(phraseFor(obstacle({ outcome: "turn_back" }))).toContain("Όταν είναι ασφαλές, επιστρέψτε μέχρι την προηγούμενη γωνία.");
    expect(phraseFor(obstacle({ outcome: "no_alternative" }))).toContain("δεν βρέθηκε άλλη");
  });

  it("is honest about the entrance on arrival", () => {
    const arrival: Announcement = { type: "arrival", key: "a", text: "", phase: "now", atNode: "n", distanceM: 0 };
    expect(phraseFor(arrival, { destinationName: "Δημαρχείο Αθηνών" })).toBe("Φτάσατε: Δημαρχείο Αθηνών. Δεν μπορώ να επιβεβαιώσω την ακριβή είσοδο.");
    expect(phraseFor(arrival, { destinationName: "Δημαρχείο Αθηνών", entranceVerified: true })).toBe("Φτάσατε στην είσοδο: Δημαρχείο Αθηνών.");
  });

  it("starts with the destination and the length of the walk", () => {
    expect(phraseFor({ type: "depart", key: "d", text: "" }, { destinationName: "Δημαρχείο Αθηνών", routeLengthM: 327 })).toBe(
      "Η πλοήγηση ξεκινά. Προορισμός: Δημαρχείο Αθηνών, 325 μέτρα.",
    );
  });

  it("has no exclamation marks, double spaces or abbreviated units anywhere", () => {
    const all = [
      phraseFor(turn()), phraseFor(obstacle()), phraseFor(obstacle({ outcome: "turn_back" })), phraseFor(obstacle({ lateWarning: true })),
      phraseFor({ type: "obstacle_cleared", key: "c", text: "", obstacleId: "x", decisionNode: "n", distanceToDecisionM: 30, direction: "left", savedDistanceM: 80 }),
      SAY.emergency, SAY.reportFiled(2), SAY.reportFiled(1), SAY.reportFiled(0), SAY.clearedNoChange, SAY.foundLocal("Χ", 310),
    ];
    for (const text of all) {
      expect(text).not.toMatch(/!|\s{2,}|\d\s?μ\./);
      expect(text.trim()).toBe(text);
    }
    expect(SAY.emergency).toBe("Αν είναι επείγον, καλέστε το 112.");
  });

  it("gives the phone a few words and a distance", () => {
    expect(instructionView({ atNode: "n", atDistanceM: 100, kind: "turn", direction: "right" }, 42)).toEqual({ title: "Στρίψτε δεξιά", distance: "σε 40 μέτρα", direction: "right" });
    expect(instructionView({ atNode: "n", atDistanceM: 100, kind: "turn", direction: "left" }, 12)?.distance).toBe("κοντά");
    expect(instructionView({ atNode: "n", atDistanceM: 100, kind: "arrive" }, 1)).toEqual({ title: "Προορισμός", distance: "τώρα", direction: "arrive" });
    expect(instructionView(null, null)).toBeNull();
  });

  it("splits a caption into sentences and times every word", () => {
    const text = "Εμπόδιο μπροστά, σε 60 μέτρα. Η διαδρομή αλλάζει.";
    expect(captionSentences(text)).toEqual([["Εμπόδιο", "μπροστά,", "σε", "60", "μέτρα."], ["Η", "διαδρομή", "αλλάζει."]]);
    const times = wordDurations(text);
    expect(times).toHaveLength(8);
    expect(times.every((ms) => ms > 100)).toBe(true);
  });
});
