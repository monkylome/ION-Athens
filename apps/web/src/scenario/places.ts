/** The local catalogue of named places (data/places.json): the start of a scenario, and the fallback for a destination. */
import { haversineM } from "@ion/core";
import type { PlaceInfo } from "./types";

export interface PlaceRecord {
  id: string;
  name: string;
  nameEn?: string;
  kind: string;
  lng: number;
  lat: number;
  nearestNodeId: string;
  address?: string;
  entranceVerified?: boolean;
}

/** Lowercase, no accents, final sigma folded: Greek words compare equal however they were typed. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("el")
    .replace(/ς/g, "σ");
}

const STOP = new Set(
  "θελω να παω παμε πηγαινε με στο στη στην στον στα στισ στουσ το τη την τον τα ο η οι που ειναι πιο κοντινο κοντινη κοντινοτερο κοντινοτερη ενα μια ενασ για προσ απο και σε i want to go the".split(
    " ",
  ),
);

/** The words of a sentence that can name a place. */
export function placeWords(sentence: string): string[] {
  return fold(sentence)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Greek case endings differ ("Δημαρχείο", "Δημαρχείου"): compare the first letters. */
function stem(word: string): string {
  return word.length <= 4 ? word : word.slice(0, Math.max(4, word.length - 2));
}

export function toPlaceInfo(record: PlaceRecord): PlaceInfo {
  return {
    id: record.id,
    name: record.name,
    lng: record.lng,
    lat: record.lat,
    address: record.address ?? null,
    kind: record.kind,
    nodeId: record.nearestNodeId,
    ...(record.entranceVerified !== undefined ? { entranceVerified: record.entranceVerified } : {}),
  };
}

/** A place by id, or by its exact name. */
export function findPlace(places: readonly PlaceRecord[], idOrName: string): PlaceRecord | null {
  const wanted = fold(idOrName.trim());
  return (
    places.find((p) => p.id === idOrName) ??
    places.find((p) => fold(p.name) === wanted || (p.nameEn && fold(p.nameEn) === wanted)) ??
    null
  );
}

/** Words that name a kind of place rather than a place. */
const KIND_WORDS: [string, string][] = [
  ["νοσοκομ", "hospital"],
  ["κλινικ", "hospital"],
  ["δημαρχ", "townhall"],
  ["κεπ", "kep"],
  ["μουσει", "museum"],
  ["πλατει", "square"],
  ["αστυνομ", "police"],
  ["μετρο", "metro_station"],
];

export interface PlaceMatch {
  place: PlaceRecord;
  /** Share of the spoken place words found in the name or the kind: 1 means all of them. */
  share: number;
}

/** The place a sentence most likely names: share of spoken words in the name, then the shorter name, then distance. */
export function matchPlace(
  places: readonly PlaceRecord[],
  sentence: string,
  near?: { lng: number; lat: number },
): PlaceMatch | null {
  const words = placeWords(sentence).map(stem);
  if (words.length === 0) return null;
  let best: { place: PlaceRecord; share: number; score: number; distance: number } | null = null;
  for (const place of places) {
    const name = `${fold(place.name)} ${fold(place.nameEn ?? "")}`.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    let hits = 0;
    let weight = 0;
    for (const w of words) {
      if (name.some((n) => n.startsWith(w))) {
        hits++;
        weight += 1;
      } else if (KIND_WORDS.some(([word, kind]) => kind === place.kind && w.startsWith(word))) {
        // The kind of place was said, not its name: a match, but a weaker one than the name itself.
        hits++;
        weight += 0.8;
      }
    }
    if (hits === 0) continue;
    const share = hits / words.length;
    // All spoken words in a short name beats the same words in a long one.
    const score = weight / words.length - name.length * 0.01;
    const distance = near ? haversineM([near.lng, near.lat], [place.lng, place.lat]) : 0;
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && distance < best.distance)) {
      best = { place, share, score, distance };
    }
  }
  return best ? { place: best.place, share: best.share } : null;
}

export function searchPlaces(
  places: readonly PlaceRecord[],
  sentence: string,
  near?: { lng: number; lat: number },
): PlaceRecord | null {
  const match = matchPlace(places, sentence, near);
  return match && match.share >= 0.45 ? match.place : null;
}

export function looksLikeHospital(name: string, kind?: string): boolean {
  return kind === "hospital" || /νοσοκομει|πολυκλινικ|hospital|εφημερ/.test(fold(name));
}
