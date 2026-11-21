/**
 * The fake sandbox below answers the way the real one did on 21 November 2026
 * (see the README): the same intents, categories and card order.
 */
import { describe, expect, it } from "vitest";
import { SandboxError, type LatLng } from "../sandbox/client.ts";
import type { AssistantReply, SandboxPoi } from "../sandbox/schemas.ts";
import { type DestinationClient, DestinationResolver, resolveDestination } from "./resolve.ts";
import { contentTokens, matchName, sameWord } from "./text.ts";

const HERE: LatLng = { lat: 37.9762, lng: 23.7257 };

const poi = (id: string, name: string, category: string, lat: number, lng: number, address: string): SandboxPoi => ({ id, name, category, lat, lng, address });
const POIS = {
  kepDimarcheiou: poi("poi-001", "ΚΕΠ Δημαρχείου", "kep", 37.978712, 23.726805, "Αθηνάς 63, 10552 Αθήνα"),
  kepPetralonon: poi("poi-003", "ΚΕΠ Πετραλώνων", "kep", 37.968812, 23.711034, "Τρώων 40, 11851 Αθήνα"),
  dimarcheio: poi("poi-008", "Δημαρχείο Αθηνών", "municipal_office", 37.978602, 23.727198, "Αθηνάς 63, 10552 Αθήνα"),
  lixiarcheio: poi("poi-009", "Ληξιαρχείο Αθηνών", "municipal_office", 37.985812, 23.724005, "Λιοσίων 22, 10438 Αθήνα"),
  parking: poi("poi-066", "Υπόγειος Σταθμός Στάθμευσης Κοτζιά", "parking", 37.979012, 23.727512, "Πλατεία Κοτζιά, 10552 Αθήνα"),
  acropolis: poi("poi-043", "Μουσείο Ακρόπολης", "museum", 37.968412, 23.728512, "Διονυσίου Αρεοπαγίτου 15, 11742 Αθήνα"),
  pinakothiki: poi("poi-042", "Δημοτική Πινακοθήκη Αθηνών", "museum", 37.984005, 23.719512, "Λεωνίδου & Μυλλέρου, 10436 Αθήνα"),
  gasMuseum: poi("poi-044", "Βιομηχανικό Μουσείο Φωταερίου", "museum", 37.978812, 23.713812, "Πειραιώς 100, 11854 Αθήνα"),
  benaki: poi("poi-041", "Μουσείο Μπενάκη Ελληνικού Πολιτισμού", "museum", 37.975612, 23.740512, "Κουμπάρη 1, 10674 Αθήνα"),
  technopolis: poi("poi-045", "Τεχνόπολις Δήμου Αθηναίων", "cultural_venue", 37.978312, 23.713505, "Πειραιώς 100, 11854 Αθήνα"),
};

const cards = (...pois: SandboxPoi[]) => pois.map((p) => ({ type: "poi", id: p.id, title: p.name, subtitle: null, data: { lat: p.lat, lng: p.lng, address: p.address } }));
const reply = (intent: string, over: Partial<AssistantReply> = {}): AssistantReply => ({
  speech: "", intent: { name: intent, confidence: 1 }, entities: {}, cards: [], engine: { used: "rules" }, state: { flow: null, awaiting: null }, ...over,
});
const pages = [{ type: "page", id: "a60b", title: "\"Παίρνω το ποδήλατο και.. πάω\"", subtitle: null, data: { source: "live" } }];

interface Script {
  rules?: AssistantReply | Error;
  llm?: AssistantReply | Error;
  search?: Record<string, SandboxPoi[]> | Error;
  parse?: { intent: string; entities: Record<string, unknown> } | Error;
  open?: Error;
}

function fake(script: Script) {
  const log: string[] = [];
  let conversations = 0;
  const give = <T>(v: T | Error | undefined, fallback: T): T => {
    if (v instanceof Error) throw v;
    return v ?? fallback;
  };
  const client: DestinationClient = {
    openConversation: async () => {
      log.push("open");
      if (script.open) throw script.open;
      return `conv-${++conversations}`;
    },
    sendMessage: async (conv, _text, opts) => {
      log.push(`${opts?.engine}@${conv}`);
      return give(opts?.engine === "llm" ? script.llm : script.rules, reply("unknown"));
    },
    deleteConversation: async (conv) => {
      log.push(`delete@${conv}`);
    },
    parse: async () => {
      log.push("parse");
      return { confidence: 1, ...give(script.parse, { intent: "unknown", entities: {} }) };
    },
    searchPois: async (q = {}) => {
      log.push(`search:${q.q ?? `category=${q.category}`}`);
      const table = give(script.search, {});
      return table[q.q ?? `category=${q.category}`] ?? [];
    },
  };
  return { client, log };
}

const down = new SandboxError("network", "POST /v1/conversations", "could not reach the sandbox");

describe("text matching", () => {
  it("keeps only the words that may name a place", () => {
    expect(contentTokens("Θέλω να πάω στο Δημαρχείο")).toEqual(["δημαρχειο"]);
    expect(contentTokens("πήγαινέ με στο πιο κοντινό ΚΕΠ")).toEqual(["κεπ"]);
    expect(contentTokens("πού είναι το Μουσείο Ακρόπολης;")).toEqual(["μουσειο", "ακροπολησ"]);
    expect(contentTokens("θέλω ένα φαρμακείο")).toEqual(["φαρμακειο"]);
  });

  it("treats Greek case endings as the same word", () => {
    expect(sameWord("δημαρχειο", "δημαρχειου")).toBe(true);
    expect(sameWord("κηπο", "κηποσ")).toBe(true);
    expect(sameWord("τεχνοπολη", "τεχνοπολισ")).toBe(true);
    expect(sameWord("μουσειο", "μουσικη")).toBe(false);
    expect(sameWord("κεπ", "κεντρο")).toBe(false);
  });

  it("measures how much of what was said is in a name", () => {
    expect(matchName(["μουσειο", "μπενακη"], "Μουσείο Ακρόπολης").coverage).toBe(0.5);
    expect(matchName(["μουσειο", "μπενακη"], "Μουσείο Μπενάκη Ελληνικού Πολιτισμού").coverage).toBe(1);
    expect(matchName(["δημαρχειο"], "Δημαρχείο Αθηνών").exact).toBe(1);
    expect(matchName(["δημαρχειο"], "ΚΕΠ Δημαρχείου").exact).toBe(0);
  });
});

describe("resolveDestination", () => {
  it("takes the nearest place from the rules engine for «το πιο κοντινό ΚΕΠ»", async () => {
    const { client, log } = fake({ rules: reply("nearby_poi", { entities: { poi_category: "kep" }, cards: cards(POIS.kepDimarcheiou, POIS.kepPetralonon) }) });
    const res = await resolveDestination(client, "πήγαινέ με στο πιο κοντινό ΚΕΠ", HERE);
    expect(res).toMatchObject({
      understood: true,
      how: "assistant_rules",
      confidence: 0.9,
      place: { id: "poi-001", name: "ΚΕΠ Δημαρχείου", lng: 23.726805, lat: 37.978712, address: "Αθηνάς 63, 10552 Αθήνα" },
    });
    expect(res.understood && res.alternatives.map((p) => p.id)).toEqual(["poi-003"]);
    expect(res.speech).toBe("Βρήκα: ΚΕΠ Δημαρχείου, Αθηνάς 63. Απέχει περίπου 290 μέτρα σε ευθεία. Να ξεκινήσουμε;");
    expect(log).toEqual(["open", "rules@conv-1", "delete@conv-1"]); // one assistant message, no search, no language model
  });

  it("finds the Δημαρχείο by name when the rules answer with website pages", async () => {
    const { client, log } = fake({
      rules: reply("faq", { entities: { poi_category: "municipal_office" }, cards: pages }),
      search: { Δημαρχείο: [POIS.kepDimarcheiou, POIS.dimarcheio, POIS.parking] },
    });
    const res = await resolveDestination(client, "Θέλω να πάω στο Δημαρχείο", HERE);
    expect(res).toMatchObject({ understood: true, how: "poi_search", confidence: 0.9, place: { id: "poi-008", name: "Δημαρχείο Αθηνών" } });
    expect(res.understood && res.alternatives.map((p) => p.id)).toEqual(["poi-001"]); // the car park only mentions it in its description
    expect(log).not.toContain("llm@conv-1");
    expect(res.trace).toEqual([
      { step: "assistant_rules", intent: "faq", category: "municipal_office", engineUsed: "rules", candidates: 0 },
      { step: "poi_search", candidates: 2 },
    ]);
  });

  it("does not trust the nearest museum when another one was named", async () => {
    const { client } = fake({
      rules: reply("nearby_poi", { entities: { poi_category: "museum" }, cards: cards(POIS.acropolis, POIS.pinakothiki, POIS.gasMuseum) }),
      search: { "Μουσείο Μπενάκη": [POIS.acropolis, POIS.gasMuseum, POIS.benaki] },
    });
    const res = await resolveDestination(client, "πήγαινέ με στο Μουσείο Μπενάκη", HERE);
    expect(res).toMatchObject({ understood: true, how: "poi_search", confidence: 0.9, place: { id: "poi-041" } });
  });

  it("accepts the rules card when it is the named place", async () => {
    const { client, log } = fake({ rules: reply("nearby_poi", { entities: { poi_category: "museum" }, cards: cards(POIS.pinakothiki, POIS.acropolis) }) });
    const res = await resolveDestination(client, "πού είναι το Μουσείο Ακρόπολης", HERE);
    expect(res).toMatchObject({ understood: true, how: "assistant_rules", place: { id: "poi-043" } });
    expect(log.some((l) => l.startsWith("search"))).toBe(false);
  });

  it("matches a name said in another case, and leaves a conversation that started a booking flow", async () => {
    const { client, log } = fake({
      rules: reply("book_appointment", { state: { flow: "book_appointment", awaiting: "procedure" } }),
      search: { Τεχνόπολη: [POIS.gasMuseum, POIS.technopolis] },
    });
    const res = await resolveDestination(client, "θέλω να πάω στην Τεχνόπολη", HERE);
    expect(res).toMatchObject({ understood: true, how: "poi_search", place: { id: "poi-045" } });
    expect(log).toEqual(["open", "rules@conv-1", "delete@conv-1", "search:Τεχνόπολη"]);
  });

  it("asks the language model, in a clean conversation, when rules and search find nothing", async () => {
    const { client, log } = fake({
      rules: reply("book_appointment", { state: { flow: "book_appointment", awaiting: "procedure" } }),
      llm: reply("nearby_poi", { entities: { poi_category: "municipal_office" }, engine: { used: "llm" }, cards: cards(POIS.dimarcheio, POIS.lixiarcheio) }),
    });
    const res = await resolveDestination(client, "thelo na pao sto dimarxeio", HERE);
    expect(res).toMatchObject({ understood: true, how: "assistant_llm", confidence: 0.5, place: { id: "poi-008" } });
    expect(res.speech).toMatch(/^Το πιο σχετικό που βρήκα είναι: Δημαρχείο Αθηνών/);
    expect(log).toEqual(["open", "rules@conv-1", "delete@conv-1", "search:thelo na pao sto dimarxeio", "open", "llm@conv-2", "delete@conv-2"]);
  });

  it("does not count a rules fallback as a language-model answer, and can be told not to use it", async () => {
    const { client, log } = fake({ rules: reply("faq", { cards: pages }), llm: reply("faq", { cards: pages }) });
    const res = await resolveDestination(client, "κάτι ακατανόητο", HERE, { useLlm: false });
    expect(res.understood).toBe(false);
    expect(log.some((l) => l.startsWith("llm"))).toBe(false);
  });

  it("says so in Greek when the sandbox has no such place", async () => {
    const service = [{ type: "service", id: "01kc", title: "ΚΟΙΝΩΝΙΚΟ ΦΑΡΜΑΚΕΙΟ", subtitle: null, data: {} }];
    const { client } = fake({ rules: reply("find_service", { cards: service }), llm: reply("find_service", { cards: service, engine: { used: "llm" } }) });
    const res = await resolveDestination(client, "θέλω ένα φαρμακείο", HERE);
    expect(res).toMatchObject({ understood: false, reason: "no_match" });
    expect(res.speech).toContain("Δεν βρήκα προορισμό για «θέλω ένα φαρμακείο»");
    expect(res.trace.map((t) => [t.step, t.intent ?? null, t.candidates])).toEqual([
      ["assistant_rules", "find_service", 0],
      ["poi_search", null, 0],
      ["assistant_llm", "find_service", 0],
    ]);
  });

  it("falls back to /v1/nlu/parse and a category search when the assistant cannot be reached", async () => {
    const { client, log } = fake({
      open: down,
      parse: { intent: "nearby_poi", entities: { poi_category: "library" } },
      search: { "category=library": [poi("poi-013", "Κεντρική Δημοτική Βιβλιοθήκη Αθηνών", "library", 37.992, 23.721, "Δομοκού 2, 10440 Αθήνα")] },
    });
    const res = await resolveDestination(client, "θέλω κάπου ήσυχα να διαβάσω", HERE);
    expect(res).toMatchObject({ understood: true, how: "poi_search", confidence: 0.5, place: { id: "poi-013" } });
    expect(log).toContain("parse");
    expect(res.trace.filter((t) => t.error).map((t) => [t.step, t.error])).toEqual([["assistant_rules", "network"], ["assistant_llm", "network"]]);
  });

  it("gives a spoken apology, not an exception, when the whole sandbox is down", async () => {
    const { client } = fake({ open: down, search: down, parse: down });
    const res = await resolveDestination(client, "Θέλω να πάω στο Δημαρχείο", HERE);
    expect(res).toMatchObject({ understood: false, reason: "sandbox_unavailable" });
    expect(res.speech).toMatch(/^Δεν μπορώ να επικοινωνήσω/);
  });

  it("asks again when nothing was said", async () => {
    const { client, log } = fake({});
    expect(await resolveDestination(client, "   ", HERE)).toMatchObject({ understood: false, reason: "empty" });
    expect(log).toEqual([]);
  });

  it("works without a location and leaves the distance out", async () => {
    const { client } = fake({ rules: reply("nearby_poi", { cards: cards(POIS.acropolis) }) });
    const res = await resolveDestination(client, "Μουσείο Ακρόπολης");
    expect(res.speech).toBe("Βρήκα: Μουσείο Ακρόπολης, Διονυσίου Αρεοπαγίτου 15. Να ξεκινήσουμε;");
  });
});

describe("DestinationResolver", () => {
  it("answers a repeated question from memory, and never caches a failure", async () => {
    const script: Script = { rules: reply("nearby_poi", { cards: cards(POIS.kepDimarcheiou) }) };
    const { client, log } = fake(script);
    const resolver = new DestinationResolver(client);
    await resolver.resolve("το πιο κοντινό ΚΕΠ", HERE);
    await resolver.resolve("Το πιο κοντινό ΚΕΠ ", HERE);
    expect(log.filter((l) => l === "open")).toHaveLength(1);

    script.rules = reply("unknown");
    await resolver.resolve("κάτι άλλο", HERE);
    await resolver.resolve("κάτι άλλο", HERE);
    expect(log.filter((l) => l.startsWith("rules"))).toHaveLength(3);
  });
});
