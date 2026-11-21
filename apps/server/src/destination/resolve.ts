/**
 * Turns a spoken destination into a place, using the AthensGov Sandbox.
 *
 * The chain, in the order that proved most reliable in experiments (see README):
 *
 *   1. The assistant with the `rules` engine, in a fresh conversation, with the
 *      person's location. Fast (about 60 ms). Right for "the nearest X", and for
 *      a named place only when that place happens to be among the nearest of
 *      its category, so its cards are checked against the spoken words.
 *   2. A text search of the points of interest with the place words of the
 *      sentence. The sandbox matches any word in any field and sorts by
 *      distance, so the results are ranked here by how well the NAME matches.
 *   3. The assistant with the `llm` engine, only when 1 and 2 found no place. It understands greeklish, typos and vague
 *      wishes, takes about 2 seconds and has a daily quota.
 *   4. If the assistant could not be reached at all: `/v1/nlu/parse` for the
 *      category, then the nearest place of that category.
 *
 * A candidate is accepted early only when its name contains every place word
 * that was said. Otherwise all candidates are compared at the end.
 */
import { distanceM } from "../geo.ts";
import { fold } from "../obstacles/rules.ts";
import { SandboxError, type AssistantEngine, type LatLng, type SandboxClient } from "../sandbox/client.ts";
import type { AssistantReply } from "../sandbox/schemas.ts";
import { type NameMatch, contentTokens, contentWords, matchName } from "./text.ts";

export type DestinationHow = "assistant_rules" | "assistant_llm" | "poi_search";

export interface DestinationPlace {
  /** Sandbox id, for example "poi-008". */
  id: string | null;
  name: string;
  lng: number;
  lat: number;
  address: string | null;
}

export interface TraceStep {
  step: DestinationHow | "nlu_parse";
  /** What the sandbox understood, when it said. */
  intent?: string;
  category?: string;
  engineUsed?: string;
  candidates: number;
  /** Error code when the step failed. */
  error?: string;
}

export type DestinationResult =
  | {
      understood: true;
      place: DestinationPlace;
      how: DestinationHow;
      /** 0 to 1. 0.9: every spoken place word is in the name. 0.5: only the kind of place was understood. */
      confidence: number;
      /** A Greek sentence to say. */
      speech: string;
      /** Other candidates, best first, in case the person says "not that one". */
      alternatives: DestinationPlace[];
      trace: TraceStep[];
    }
  | {
      understood: false;
      reason: "empty" | "no_match" | "sandbox_unavailable";
      speech: string;
      trace: TraceStep[];
    };

export type DestinationClient = Pick<
  SandboxClient,
  "openConversation" | "sendMessage" | "deleteConversation" | "parse" | "searchPois"
>;

export interface ResolveOptions {
  /** Set false to never spend language-model messages. */
  useLlm?: boolean;
}

interface Candidate {
  place: DestinationPlace;
  how: DestinationHow;
  category: string | null;
  match: NameMatch;
  /** Position in the chain: earlier steps and nearer places first. */
  order: number;
}

const STEP_ORDER: Record<DestinationHow, number> = { assistant_rules: 0, poi_search: 1, assistant_llm: 2 };

export async function resolveDestination(
  client: DestinationClient,
  text: string,
  location?: LatLng,
  options: ResolveOptions = {},
): Promise<DestinationResult> {
  const said = text.trim();
  const trace: TraceStep[] = [];
  if (said === "") {
    return { understood: false, reason: "empty", speech: "Δεν άκουσα προορισμό. Πείτε μου πού θέλετε να πάτε.", trace };
  }
  const tokens = contentTokens(said);
  const candidates: Candidate[] = [];
  let category: string | null = null;
  let failures = 0;
  let conversation: string | null = null;

  const add = (how: DestinationHow, place: DestinationPlace, cat: string | null) => {
    if (candidates.some((c) => (c.place.id ?? c.place.name) === (place.id ?? place.name))) return;
    candidates.push({ place, how, category: cat, match: matchName(tokens, place.name), order: STEP_ORDER[how] * 1000 + candidates.length });
  };
  const best = () => rank(candidates, category)[0];
  const decisive = () => tokens.length > 0 && best()?.match.coverage === 1;

  const ask = async (engine: AssistantEngine): Promise<boolean> => {
    const step: DestinationHow = engine === "llm" ? "assistant_llm" : "assistant_rules";
    try {
      conversation ??= await client.openConversation({ lang: "el", channel: "voice" });
      const reply = await client.sendMessage(conversation, said, { ...(location ? { location } : {}), engine });
      const cat = stringEntity(reply, "poi_category");
      category ??= cat;
      const places = poiCards(reply);
      for (const p of places) add(step, p, cat);
      trace.push({
        step,
        ...(reply.intent ? { intent: reply.intent.name } : {}),
        ...(cat ? { category: cat } : {}),
        ...(reply.engine?.used ? { engineUsed: reply.engine.used } : {}),
        candidates: places.length,
      });
      // A reply that starts a multi-step flow (booking, reporting) would colour the next message.
      if (reply.state?.flow || reply.state?.awaiting) {
        dispose(client, conversation);
        conversation = null;
      }
      return places.length > 0;
    } catch (err) {
      failures++;
      trace.push({ step, candidates: 0, error: errorCode(err) });
      return false;
    }
  };

  try {
    // 1. The assistant's rules.
    await ask("rules");

    // 2. Text search of the points of interest, ranked by name.
    if (!decisive() && tokens.length > 0) {
      try {
        const pois = await client.searchPois({ q: contentWords(said).join(" "), ...(location ? { near: location } : {}), size: 20 });
        let kept = 0;
        for (const poi of pois) {
          // The search also matches descriptions and addresses: keep only name matches.
          if (matchName(tokens, poi.name).coverage === 0) continue;
          add("poi_search", { id: poi.id, name: poi.name, lng: poi.lng, lat: poi.lat, address: poi.address ?? null }, poi.category);
          kept++;
        }
        trace.push({ step: "poi_search", candidates: kept });
      } catch (err) {
        failures++;
        trace.push({ step: "poi_search", candidates: 0, error: errorCode(err) });
      }
    }

    // 3. The language model, when neither the rules nor the search found a place.
    if (candidates.length === 0 && options.useLlm !== false) await ask("llm");

    // 4. The assistant never answered: get the category another way.
    if (candidates.length === 0 && category === null && !trace.some((t) => t.step.startsWith("assistant") && !t.error)) {
      try {
        const parsed = await client.parse(said);
        const cat = parsed.entities["poi_category"];
        category = typeof cat === "string" ? cat : null;
        trace.push({ step: "nlu_parse", intent: parsed.intent, ...(category ? { category } : {}), candidates: 0 });
      } catch (err) {
        failures++;
        trace.push({ step: "nlu_parse", candidates: 0, error: errorCode(err) });
      }
    }
    if (candidates.length === 0 && category !== null) {
      try {
        const pois = await client.searchPois({ category, ...(location ? { near: location } : {}), size: 5 });
        for (const poi of pois) add("poi_search", { id: poi.id, name: poi.name, lng: poi.lng, lat: poi.lat, address: poi.address ?? null }, poi.category);
        trace.push({ step: "poi_search", category, candidates: pois.length });
      } catch (err) {
        failures++;
        trace.push({ step: "poi_search", category, candidates: 0, error: errorCode(err) });
      }
    }
  } finally {
    if (conversation) dispose(client, conversation);
  }

  const ranked = rank(candidates, category);
  const winner = ranked[0];
  if (!winner) {
    if (failures > 0 && !trace.some((t) => !t.error)) {
      return {
        understood: false,
        reason: "sandbox_unavailable",
        speech: "Δεν μπορώ να επικοινωνήσω με τα δεδομένα του Δήμου αυτή τη στιγμή. Δοκιμάστε ξανά σε λίγο.",
        trace,
      };
    }
    return {
      understood: false,
      reason: "no_match",
      speech: `Δεν βρήκα προορισμό για «${said}» στα δεδομένα του Δήμου. Πείτε μου το όνομα ή το είδος του σημείου, για παράδειγμα «το πιο κοντινό ΚΕΠ».`,
      trace,
    };
  }

  const coverage = tokens.length === 0 ? 0 : winner.match.coverage;
  const confidence = coverage === 1 ? 0.9 : coverage > 0 ? Math.round((0.5 + 0.3 * coverage) * 100) / 100 : 0.5;
  return {
    understood: true,
    place: winner.place,
    how: winner.how,
    confidence,
    speech: placeSpeech(winner.place, location, confidence),
    alternatives: ranked.slice(1, 4).map((c) => c.place),
    trace,
  };
}

/** Best first: name match, then exact words, then the understood category, then nearest. */
function rank(candidates: readonly Candidate[], category: string | null): Candidate[] {
  const cat = (c: Candidate) => (category !== null && c.category === category ? 1 : 0);
  return [...candidates].sort(
    (a, b) =>
      b.match.coverage - a.match.coverage ||
      b.match.exact - a.match.exact ||
      cat(b) - cat(a) ||
      b.match.nameShare - a.match.nameShare ||
      a.order - b.order,
  );
}

function poiCards(reply: AssistantReply): DestinationPlace[] {
  const out: DestinationPlace[] = [];
  for (const card of reply.cards) {
    const lat = card.data?.["lat"];
    const lng = card.data?.["lng"];
    if (card.type !== "poi" || typeof lat !== "number" || typeof lng !== "number" || !card.title) continue;
    const address = card.data?.["address"];
    out.push({ id: card.id ?? null, name: card.title, lng, lat, address: typeof address === "string" ? address : null });
  }
  return out;
}

function stringEntity(reply: AssistantReply, key: string): string | null {
  const v = reply.entities?.[key];
  return typeof v === "string" ? v : null;
}

function errorCode(err: unknown): string {
  return err instanceof SandboxError ? err.code : "internal";
}

function dispose(client: DestinationClient, conversation: string): void {
  void client.deleteConversation(conversation).catch(() => undefined);
}

export function placeSpeech(place: DestinationPlace, from: LatLng | undefined, confidence: number): string {
  const street = place.address?.split(",")[0]?.trim();
  const where = street ? `, ${street}` : "";
  let far = "";
  if (from) {
    const m = distanceM([from.lng, from.lat], [place.lng, place.lat]);
    far = m < 1000
      ? ` Απέχει περίπου ${Math.max(10, Math.round(m / 10) * 10)} μέτρα σε ευθεία.`
      : ` Απέχει περίπου ${(m / 1000).toFixed(1).replace(".", ",")} χιλιόμετρα σε ευθεία.`;
  }
  const lead = confidence >= 0.8 ? "Βρήκα" : "Το πιο σχετικό που βρήκα είναι";
  return `${lead}: ${place.name}${where}.${far} Να ξεκινήσουμε;`;
}

/** Remembers recent answers so a repeated question costs no sandbox call. */
export class DestinationResolver {
  private readonly cache = new Map<string, { at: number; result: DestinationResult }>();

  constructor(
    private readonly client: DestinationClient,
    private readonly options: ResolveOptions & { cacheMs?: number; now?: () => number } = {},
  ) {}

  async resolve(text: string, location?: LatLng): Promise<DestinationResult> {
    const now = (this.options.now ?? Date.now)();
    const key = `${fold(text.trim())}|${location ? `${location.lat.toFixed(3)},${location.lng.toFixed(3)}` : ""}`;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (this.options.cacheMs ?? 60_000)) return hit.result;
    const result = await resolveDestination(this.client, text, location, this.options);
    if (result.understood) {
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(key, { at: now, result });
    }
    return result;
  }
}
