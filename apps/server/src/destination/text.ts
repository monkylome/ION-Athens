/** Greek text helpers for matching what a person said against place names. */
import { fold } from "../obstacles/rules.ts";

/**
 * Words that carry no information about which place is meant: verbs of going
 * and wanting, articles, prepositions, "nearest". Folded (no accents, lower case).
 */
const FILLER = new Set(
  `θελω θελουμε θα ηθελα να παω πασ παμε πηγαινε πηγαινετε πηγαινω με μασ μου οδηγησε οδηγησε δειξε βρεσ βρω
   ψαχνω χρειαζομαι πρεπει μπορω μπορεισ που ειναι βρισκεται εχει υπαρχει ποιο ποια ποιοσ
   ο η το οι τα τον την τη του τησ των τουσ τισ ενα εναν μια μιασ ενοσ καποιο καποια καποιον
   σε στο στον στη στην στα στουσ στισ προσ για απο ωσ μεχρι και κι η ειτε αλλα
   πιο κοντινο κοντινη κοντινοσ κοντινοτερο κοντινοτερη κοντινοτεροσ πλησιεστερο πλησιεστερη πλησιεστεροσ
   κοντα εδω γυρω τωρα παρακαλω λιγο δρομο διαδρομη δρομολογιο προορισμοσ προορισμο
   i want to go take me the a an nearest closest where is to please`
    .split(/\s+/)
    .filter(Boolean),
);

/** The words of a sentence that may name a place, as they were said. */
export function contentWords(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !FILLER.has(fold(w)));
}

/** The same words folded, for comparison. */
export function contentTokens(text: string): string[] {
  return contentWords(text).map(fold);
}

/**
 * True when two folded words are the same word in different Greek cases:
 * "δημαρχειο"/"δημαρχειου", "κηπο"/"κηποσ", "τεχνοπολη"/"τεχνοπολισ".
 * Short words (under 4 letters, like "κεπ") must be equal.
 */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 4 || Math.abs(a.length - b.length) > 3) return false;
  let common = 0;
  while (common < min && a[common] === b[common]) common++;
  return common >= Math.max(4, min - 2);
}

export interface NameMatch {
  /** Share of the spoken content words found in the name, 0 to 1. */
  coverage: number;
  /** Share of the name's words that were spoken, 0 to 1. Separates "Δημαρχείο Αθηνών" from "ΚΕΠ Δημαρχείου" only together with `exact`. */
  nameShare: number;
  /** How many spoken words appear in the name letter for letter. */
  exact: number;
}

export function matchName(tokens: readonly string[], name: string): NameMatch {
  const nameTokens = fold(name).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
  if (tokens.length === 0 || nameTokens.length === 0) return { coverage: 0, nameShare: 0, exact: 0 };
  const hit = tokens.filter((t) => nameTokens.some((n) => sameWord(t, n)));
  const exact = tokens.filter((t) => nameTokens.includes(t)).length;
  const spoken = nameTokens.filter((n) => tokens.some((t) => sameWord(t, n))).length;
  return { coverage: hit.length / tokens.length, nameShare: spoken / nameTokens.length, exact };
}
