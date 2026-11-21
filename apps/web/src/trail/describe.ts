import type { Segment, Side } from "./segments";

export const startOptions = ["Κύρια είσοδος"] as const;
export const targetOptions = ["Ταμείο", "Τουαλέτα", "Ανελκυστήρας", "Αίθουσα"] as const;

const norm = (text: string) => text.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const startPhrase: Record<string, string> = { "κυρια εισοδος": "την κύρια είσοδο" };
const targetPhrase: Record<string, string> = {
  "ταμειο": "Το ταμείο", "τουαλετα": "Η τουαλέτα", "ανελκυστηρας": "Ο ανελκυστήρας", "αιθουσα": "Η αίθουσα",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sentence = (text: string) => {
  const clean = text.trim().replace(/[.\s]+$/, "");
  return clean ? clean[0]!.toUpperCase() + clean.slice(1) + "." : "";
};
const stairs = /σκαλ|σκάλ|σκαλοπάτ|κλιμακ/i;

export function targetSubject(target: string) {
  return targetPhrase[norm(target)] ?? `Ο προορισμός «${target.trim()}»`;
}

const sideWords: Record<Side, string> = { left: "στα αριστερά σας", right: "στα δεξιά σας", ahead: "μπροστά σας" };
export function checkpointSentence(target: string, side: Side) {
  return `${targetSubject(target)} είναι ${sideWords[side]}.`;
}
/** Reads the side back from a note written by `checkpointSentence`. */
export function sideFromNote(note: string | undefined): Side | undefined {
  if (!note) return undefined;
  if (/στα αριστερά σας/.test(note)) return "left";
  if (/στα δεξιά σας/.test(note)) return "right";
  if (/μπροστά σας/.test(note)) return "ahead";
  return undefined;
}

function movement(segment: Segment) {
  const walk = `περίπου ${plural(segment.steps, "βήμα", "βήματα")}, δηλαδή περίπου ${plural(segment.metres, "μέτρο", "μέτρα")}`;
  return segment.turn === "left" ? `Μετά στρίψτε αριστερά και προχωρήστε ${walk}.`
    : segment.turn === "right" ? `Μετά στρίψτε δεξιά και προχωρήστε ${walk}.`
    : segment.turn === "back" ? `Μετά κάντε μεταβολή και προχωρήστε ${walk}.`
    : `Μετά προχωρήστε ευθεία ${walk}.`;
}

/** The text a person hears at the door. Steps, metres, a side from the listener's own body, never a clock face. */
export function describeTrail(input: { start: string; target: string; segments: readonly Segment[] }): string {
  const { start, target, segments } = input;
  if (segments.length === 0 || segments.every(s => s.steps === 0)) return "Δεν καταγράφηκε διαδρομή.";
  const startName = startPhrase[norm(start)];
  const parts: string[] = [];
  segments.forEach((segment, i) => {
    const warning = segment.note && stairs.test(segment.note) ? sentence(segment.note) : "";
    const other = segment.note && !warning ? sentence(segment.note) : "";
    if (warning) parts.push(warning);
    if (i === 0) {
      const from = startName ? `Από ${startName}` : `Από το σημείο «${start.trim()}»`;
      const walk = `περίπου ${plural(segment.steps, "βήμα", "βήματα")}, δηλαδή περίπου ${plural(segment.metres, "μέτρο", "μέτρα")}`;
      parts.push(`${from} προχωρήστε ευθεία ${walk}.`);
    } else parts.push(movement(segment));
    if (other) parts.push(other);
  });
  const side = [...segments].reverse().find(s => s.checkpoint)?.checkpoint ?? "ahead";
  parts.push(checkpointSentence(target, side), "Τα βήματα μπορεί να διαφέρουν λίγο από τα δικά σας.");
  return parts.join(" ");
}

export function describeSegment(segment: Segment, index: number) {
  const turn = index === 0 ? "ευθεία" : segment.turn === "left" ? "αριστερά" : segment.turn === "right" ? "δεξιά" : segment.turn === "back" ? "μεταβολή" : "ευθεία";
  return `${index + 1}. ${turn}: περίπου ${plural(segment.steps, "βήμα", "βήματα")}, ${plural(segment.metres, "μέτρο", "μέτρα")}`;
}
