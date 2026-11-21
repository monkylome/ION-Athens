/**
 * What the camera may propose: a closed vocabulary that matches what the map
 * already stores, the fixed prompt, and the schema the model must follow.
 */
import { z } from "zod";

export const KINDS = [
  "steps", "ramp", "sidewalk_obstacle", "narrow_sidewalk", "tactile_paving", "crossing_signals",
  "crossing_no_signals", "entrance_step_free", "entrance_with_steps", "lift", "sign_text", "clear_path",
] as const;
export type Kind = (typeof KINDS)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const LABELS: Record<Kind, string> = {
  steps: "Σκαλιά",
  ramp: "Ράμπα",
  sidewalk_obstacle: "Εμπόδιο στο πεζοδρόμιο",
  narrow_sidewalk: "Στενό πεζοδρόμιο",
  tactile_paving: "Οδηγός όδευσης τυφλών",
  crossing_signals: "Διάβαση με φανάρι",
  crossing_no_signals: "Διάβαση χωρίς φανάρι",
  entrance_step_free: "Είσοδος χωρίς σκαλιά",
  entrance_with_steps: "Είσοδος με σκαλιά",
  lift: "Ανελκυστήρας",
  sign_text: "Πινακίδα με κείμενο",
  clear_path: "Ελεύθερο πεζοδρόμιο",
};

/** What the model is told, in English because the model follows English instructions best. The evidence it writes is Greek. */
export const SYSTEM_PROMPT = `You are a careful accessibility assistant for a city map. You receive one photo taken by a pedestrian's phone on a street or at the entrance of a building in Greece.
Report only what is UNMISTAKABLE in the photo. Most photos contain zero to three of the features below. When in doubt, leave the feature out. An empty list is a correct and common answer. Report each kind at most once.
Allowed kinds for "detections", and nothing else:
- steps: a flight of at least two steps or stairs that a person would climb or descend
- ramp: an inclined ramp (with or without handrails) meant for wheelchairs, prams or bicycles
- sidewalk_obstacle: a car, van, motorcycle, bin, pole, scaffolding, hole or heap of goods standing ON the pavement (the part for walking, usually raised from the road) and blocking part of it. Vehicles on the road itself, kerbs, shop displays and plants are NOT obstacles
- narrow_sidewalk: a pavement you can see is clearly narrower than one metre. Never for pedestrian streets or squares
- tactile_paving: raised yellow or grey guidance strips or studded tiles set in the pavement for blind people. Ordinary paving slabs and kerbs are not tactile paving
- crossing_signals: a pedestrian crossing (painted stripes at a road) where a traffic light or pedestrian signal or push button is visible
- crossing_no_signals: a pedestrian crossing (painted stripes at a road) where no traffic light is visible
- entrance_step_free: a building door that is level with the pavement, no step in front of it
- entrance_with_steps: a building door that is reached by steps
- lift: a lift or elevator
- clear_path: the main subject is a pavement or pedestrian street with free, even walking space ahead and nothing blocking it
Never mention or describe people, faces, clothes or number plates. "evidence" is one short phrase in Greek, at most 8 words, saying what you see. "signs" lists the words of signs or shop fronts that you can actually read, exactly as printed and in their own script (at most three, most prominent first). Leave "signs" empty if you cannot read any words. Do not guess. Answer with JSON only.`;

/** Used when the model answers in another language: the screen and the voice stay Greek. */
export const EVIDENCE: Record<Kind, string> = {
  steps: "Φαίνονται σκαλιά.",
  ramp: "Φαίνεται κεκλιμένο επίπεδο, ράμπα.",
  sidewalk_obstacle: "Φαίνεται κάτι πάνω στο πεζοδρόμιο.",
  narrow_sidewalk: "Το πεζοδρόμιο φαίνεται στενό.",
  tactile_paving: "Φαίνονται ανάγλυφες λωρίδες στο πεζοδρόμιο.",
  crossing_signals: "Φαίνεται διάβαση με φανάρι.",
  crossing_no_signals: "Φαίνεται διάβαση χωρίς φανάρι.",
  entrance_step_free: "Η είσοδος φαίνεται στο επίπεδο του δρόμου.",
  entrance_with_steps: "Η είσοδος φαίνεται να έχει σκαλιά.",
  lift: "Φαίνεται ανελκυστήρας.",
  sign_text: "Διαβάστηκε κείμενο σε πινακίδα.",
  clear_path: "Το πεζοδρόμιο φαίνεται ελεύθερο.",
};
export const hasGreek = (s: string): boolean => /[\u0370-\u03ff\u1f00-\u1fff]/.test(s);

export const USER_PROMPT = "What accessibility features are clearly visible in this photo?";

/** JSON schema handed to the model runtime. */
export const MODEL_SCHEMA = {
  type: "object",
  properties: {
    signs: { type: "array", maxItems: 3, items: { type: "string", maxLength: 60 } },
    detections: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: KINDS.filter((k) => k !== "sign_text") },
          confidence: { type: "string", enum: [...CONFIDENCES] },
          evidence: { type: "string", maxLength: 80 },
        },
        required: ["kind", "confidence", "evidence"],
      },
    },
  },
  required: ["signs", "detections"],
} as const;

/** What the model may return before the closed vocabulary is applied: unknown kinds are dropped later, not rejected. */
export const rawOutput = z.object({
  signs: z.array(z.string()).max(10).optional(),
  detections: z.array(z.object({
    kind: z.string(),
    confidence: z.string().optional(),
    evidence: z.string().optional(),
    text: z.string().optional(),
  })).max(20).default([]),
});

/** Anything about a person is dropped: the screen is for places. */
const PEOPLE = /(άνθρωπ|ανθρωπ|άτομ|ατομ|πρόσωπ|προσωπ|γυναίκ|γυναικ|άνδρ|ανδρ|άντρ|αντρ|παιδ|κορίτσ|αγόρ|πεζ(?:ός|οί|ού|ών|ο[ύυ]ς)\b|περαστικ|κόσμος|κοσμος|τουρίστ|ηλικιωμ|\bpeople\b|\bperson\b|\bman\b|\bwoman\b|\bchild|\bpedestrians?\b|\bface|\bcrowd|\btourist|\bboy\b|\bgirl\b|\bkid)/i;
export const mentionsPeople = (s: string | undefined): boolean => !!s && PEOPLE.test(s);

export function cleanText(s: string | undefined, max: number): string {
  return (s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
