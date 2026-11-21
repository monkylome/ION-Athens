/**
 * The final spoken Greek. Every sentence the voice says is built here, from the
 * structured announcements of @ion/core.
 *
 * Rules (voice report, "Οι δέκα κανόνες", and DESIGN.md section 7):
 * - polite plural, short sentences, one action at a time, no exclamation marks;
 * - a crossing is described and never commanded: no sentence tells the person to cross;
 * - "unknown" is said as not confirmed, never as absent;
 * - a route change comes with its short reason, so that it does not sound arbitrary;
 * - when little time is left, the action comes first;
 * - units are written out, distances arrive already rounded to 5 metres, and
 *   15 metres or less is "κοντά".
 */
import type { Announcement, CrossingInfo, RouteStep, TurnDirection } from "@ion/core";
import type { InstructionView } from "./types";

export interface PhraseContext {
  destinationName?: string;
  routeLengthM?: number;
  /** True only when the entrance of the destination has been checked. */
  entranceVerified?: boolean;
}

const NEAR_M = 15;

const TURN: Record<TurnDirection, string> = {
  straight: "συνεχίστε ευθεία",
  slight_left: "συνεχίστε ελαφρά αριστερά",
  left: "στρίψτε αριστερά",
  sharp_left: "στρίψτε κλειστά αριστερά",
  slight_right: "συνεχίστε ελαφρά δεξιά",
  right: "στρίψτε δεξιά",
  sharp_right: "στρίψτε κλειστά δεξιά",
  u_turn: "γυρίστε προς τα πίσω",
};

function capital(s: string): string {
  return s.charAt(0).toLocaleUpperCase("el") + s.slice(1);
}

export function metres(distanceM: number): string {
  return `${Math.round(distanceM)} μέτρα`;
}

/** Round to 5 m, as the engine does. */
export function round5(distanceM: number): number {
  return Math.round(Math.max(0, distanceM) / 5) * 5;
}

/**
 * "στην οδό Ερμού", "στην πλατεία Μοναστηρακίου". Street names in the graph are
 * mostly genitives ("Ερμού", "Αθηνάς"), so they follow "οδό" without change.
 */
export function ontoStreet(name: string | undefined): string {
  if (!name) return "";
  const kinds: [RegExp, string][] = [
    [/^Πλατεία\s+/i, "στην πλατεία "],
    [/^Λεωφόρος\s+/i, "στη λεωφόρο "],
    [/^Οδός\s+/i, "στην οδό "],
    [/^Πεζόδρομος\s+/i, "στον πεζόδρομο "],
    [/^Στοά\s+/i, "στη στοά "],
  ];
  for (const [pattern, lead] of kinds) {
    if (pattern.test(name)) return ` ${lead}${name.replace(pattern, "")}`;
  }
  return ` στην οδό ${name}`;
}

/** Facts about a crossing. Never an instruction to cross. */
export function crossingFacts(crossing: CrossingInfo): string {
  if (crossing.signals === "yes") {
    if (crossing.sound === "yes") return "Έχει φανάρι με ηχητικό σήμα.";
    if (crossing.sound === "no") return "Έχει φανάρι, χωρίς ηχητικό σήμα.";
    return "Έχει φανάρι. Δεν είναι επιβεβαιωμένο αν έχει ηχητικό σήμα.";
  }
  if (crossing.signals === "no") return "Δεν έχει φανάρι.";
  return "Δεν είναι επιβεβαιωμένο αν έχει φανάρι.";
}

function side(direction: TurnDirection | undefined): string {
  if (direction?.endsWith("left")) return ", στα αριστερά σας";
  if (direction?.endsWith("right")) return ", στα δεξιά σας";
  return "";
}

function turnAhead(distanceM: number, direction: TurnDirection, onto?: string): string {
  const action = `${TURN[direction]}${ontoStreet(onto)}`;
  if (direction === "straight") {
    return distanceM <= NEAR_M
      ? `Η διασταύρωση είναι κοντά. ${capital(action)}.`
      : `Σε ${metres(distanceM)}, στη διασταύρωση, ${action}.`;
  }
  return distanceM <= NEAR_M ? `Η γωνία είναι κοντά. ${capital(action)}.` : `Σε ${metres(distanceM)}, ${action}.`;
}

function extraSentence(extraM: number | undefined): string {
  if (!extraM) return "";
  const n = Math.abs(extraM);
  return extraM > 0 ? ` Η νέα διαδρομή είναι ${metres(n)} μακρύτερη.` : ` Η νέα διαδρομή είναι ${metres(n)} συντομότερη.`;
}

/** The sentence for one announcement of the engine. */
export function phraseFor(a: Announcement, context: PhraseContext = {}): string {
  switch (a.type) {
    case "depart": {
      const to = context.destinationName ? ` Προορισμός: ${context.destinationName}` : "";
      const length = context.routeLengthM ? `, ${metres(round5(context.routeLengthM))}` : "";
      const first = a.direction && a.direction !== "straight" ? ` ${capital(TURN[a.direction])}${ontoStreet(a.onto)}.` : "";
      const crossing = a.crossing ? ` Ξεκινάτε σε διάβαση πεζών. ${crossingFacts(a.crossing)}` : "";
      return `Η πλοήγηση ξεκινά.${to ? `${to}${length}.` : ""}${first}${crossing}`;
    }
    case "turn":
      if (a.phase === "now") {
        return a.direction === "straight" ? "Συνεχίστε ευθεία." : `${capital(TURN[a.direction])} τώρα${ontoStreet(a.onto)}.`;
      }
      return turnAhead(a.distanceM, a.direction, a.onto);
    case "crossing": {
      const facts = crossingFacts(a.crossing);
      if (a.phase === "now") return `Διάβαση πεζών${side(a.direction)}. ${facts}`;
      return a.distanceM <= NEAR_M
        ? `Πλησιάζετε σε διάβαση πεζών${side(a.direction)}. ${facts}`
        : `Σε ${metres(a.distanceM)}, διάβαση πεζών${side(a.direction)}. ${facts}`;
    }
    case "arrival": {
      const name = context.destinationName;
      if (a.phase === "ahead") {
        return a.distanceM <= NEAR_M
          ? "Ο προορισμός σας είναι κοντά."
          : `Σε ${metres(a.distanceM)} φτάνετε στον προορισμό σας.`;
      }
      if (!name) return "Φτάσατε στον προορισμό σας.";
      return context.entranceVerified
        ? `Φτάσατε στην είσοδο: ${name}.`
        : `Φτάσατε: ${name}. Δεν μπορώ να επιβεβαιώσω την ακριβή είσοδο.`;
    }
    case "obstacle": {
      const where = a.distanceToObstacleM > 0 ? `, σε ${metres(a.distanceToObstacleM)}` : "";
      if (a.outcome === "keep_route") {
        return `Υπάρχει εμπόδιο στο επόμενο τμήμα της διαδρομής${where}. Η διαδρομή δεν αλλάζει.`;
      }
      if (a.outcome === "no_alternative") {
        return `Εμπόδιο μπροστά${where}. Η διαδρομή μπροστά δεν είναι διαθέσιμη και δεν βρέθηκε άλλη προς τον προορισμό.`;
      }
      const turn = a.direction ? TURN[a.direction] : null;
      const toTurn = a.distanceToDecisionM ?? 0;
      if (a.outcome === "turn_back") {
        const then = turn && toTurn > 0 ? ` Εκεί, ${turn}.` : "";
        return `Η διαδρομή μπροστά δεν είναι διαθέσιμη. Όταν είναι ασφαλές, επιστρέψτε μέχρι την προηγούμενη γωνία.${then}${extraSentence(a.extraDistanceM)}`;
      }
      if (a.lateWarning && turn) {
        // Little time left: the action first, then one short reason.
        const action = toTurn > 5 ? `Σε ${metres(toTurn)}, ${turn}.` : `${capital(turn)} τώρα, στη γωνία.`;
        return `${action} Ο δρόμος μπροστά είναι κλειστός.`;
      }
      const change = a.direction ? ` ${turnAhead(toTurn, a.direction)}` : "";
      return `Εμπόδιο μπροστά${where}. Η διαδρομή αλλάζει.${change}${extraSentence(a.extraDistanceM)}`;
    }
    case "obstacle_cleared": {
      const change = a.direction ? ` ${turnAhead(a.distanceToDecisionM, a.direction)}` : "";
      const saved = a.savedDistanceM > 0 ? ` Η διαδρομή είναι ${metres(a.savedDistanceM)} συντομότερη.` : "";
      return `Το εμπόδιο απομακρύνθηκε. Η διαδρομή αλλάζει ξανά.${change}${saved}`;
    }
  }
}

/** Fixed sentences that do not come from an announcement. */
export const SAY = {
  emergency: "Αν είναι επείγον, καλέστε το 112.",
  reportFiled: (stillNeeded: number) =>
    stillNeeded <= 0
      ? "Η αναφορά σας καταχωρίστηκε."
      : stillNeeded === 1
        ? "Η αναφορά σας καταχωρίστηκε. Χρειάζεται επιβεβαίωση από έναν ακόμη άνθρωπο πριν αλλάξει κάποια διαδρομή."
        : `Η αναφορά σας καταχωρίστηκε. Χρειάζεται επιβεβαίωση από ${stillNeeded} ακόμη ανθρώπους πριν αλλάξει κάποια διαδρομή.`,
  reportFiledLocal: "Η αναφορά κρατήθηκε μόνο σε αυτή τη συσκευή. Ο διακομιστής δεν απαντά.",
  reportFailed: "Η αναφορά δεν στάλθηκε. Δοκιμάστε ξανά.",
  reportNotObstacle: "Η αναφορά σας καταχωρίστηκε. Δεν βρέθηκε πεζοδρόμιο κοντά στο σημείο.",
  clearedNoChange: "Το εμπόδιο απομακρύνθηκε. Η διαδρομή σας δεν αλλάζει.",
  notUnderstood: "Δεν βρήκα αυτόν τον προορισμό. Πείτε μου το όνομα ή το είδος του σημείου.",
  noRoute: "Δεν βρέθηκε διαδρομή προς αυτόν τον προορισμό.",
  foundLocal: (name: string, distanceM: number) =>
    `Βρήκα: ${name}. Απέχει περίπου ${metres(round5(distanceM))} σε ευθεία. Να ξεκινήσουμε;`,
} as const;

const SHORT: Record<TurnDirection, string> = {
  straight: "Συνεχίστε ευθεία",
  slight_left: "Ελαφρά αριστερά",
  left: "Στρίψτε αριστερά",
  sharp_left: "Κλειστά αριστερά",
  slight_right: "Ελαφρά δεξιά",
  right: "Στρίψτε δεξιά",
  sharp_right: "Κλειστά δεξιά",
  u_turn: "Γυρίστε προς τα πίσω",
};

/** A turn and how far it is, for the screen in the hand. */
export function turnView(direction: TurnDirection | null, distanceM: number): InstructionView {
  const d = round5(distanceM);
  return { title: SHORT[direction ?? "straight"], distance: d <= 0 ? "τώρα" : d <= NEAR_M ? "κοντά" : `σε ${metres(d)}`, direction: direction ?? "straight" };
}

/** The next instruction for the screen in the hand: a few words and a distance. */
export function instructionView(step: RouteStep | null, distanceM: number | null): InstructionView | null {
  if (!step || distanceM === null) return null;
  const d = round5(distanceM);
  const distance = d <= 0 ? "τώρα" : d <= NEAR_M ? "κοντά" : `σε ${metres(d)}`;
  if (step.kind === "arrive") return { title: "Προορισμός", distance, direction: "arrive" };
  if (step.kind === "crossing") return { title: "Διάβαση πεζών", distance, direction: "crossing" };
  const direction = step.direction ?? "straight";
  return { title: SHORT[direction], distance, direction };
}

/** Split a spoken text into sentences, each a list of words: the caption shows one sentence at a time. */
export function captionSentences(text: string): string[][] {
  return text
    .split(/(?<=[.;])\s+/u)
    .map((s) => s.trim().split(/\s+/u).filter(Boolean))
    .filter((words) => words.length > 0);
}

/** Rough speaking time of each word in milliseconds, for captions when no voice gives word boundaries. */
export function wordDurations(text: string, rate = 1): number[] {
  return text
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => {
      const pause = /[.;:]$/u.test(word) ? 380 : /,$/u.test(word) ? 160 : 0;
      return (150 + word.replace(/[^\p{L}\p{N}]/gu, "").length * 62 + pause) / rate;
    });
}
