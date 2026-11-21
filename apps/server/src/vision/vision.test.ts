/** The camera feature against a fake model. No network, no GPU. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Mission, Profile } from "../missions/missions.ts";
import { ModelError, type VisionModel } from "./model.ts";
import { createVision, type VisionConfig } from "./routes.ts";
import { KEPT_LATER } from "./service.ts";
import { KINDS } from "./vocab.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const POS = { lng: 23.7275, lat: 37.9755 };
const A = "participant_AAAA";
const B = "participant_BBBB";

function jpeg(seed = 7): { b64: string; marker: string } {
  const bytes = Buffer.alloc(900, seed);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xe0;
  Buffer.from("IMAGE-MARKER-DO-NOT-KEEP").copy(bytes, 100);
  const b64 = bytes.toString("base64");
  return { b64, marker: Buffer.from("IMAGE-MARKER-DO-NOT-KEEP").toString("base64").slice(0, 20) };
}

class FakeModel implements VisionModel {
  readonly name = "fake-vl:1b";
  calls = 0;
  seen: string[] = [];
  constructor(public answer: () => Promise<unknown> | unknown = () => ({ detections: [] })) {}
  async detect(b64: string, signal: AbortSignal) {
    this.calls++;
    this.seen.push(b64);
    return await Promise.race([
      Promise.resolve().then(this.answer),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new ModelError("timeout", "timeout")))),
    ]);
  }
  async ping() { return true; }
}

const mission = (id: string, type: Mission["type"], extra: Partial<Mission> = {}): Mission => ({
  id, type, question: `question ${id}`, position: [POS.lng, POS.lat], edgeIds: ["e1"], points: 15, answers: { yes: 0, no: 0 }, ...extra,
});
const profile = (participant: string, points: number): Profile => ({ participant, points, answers: 0, confirmed: 0, level: "Νέος χαρτογράφος", nextLevel: null });

describe("vision", () => {
  let dir: string;
  let cwdBefore: string;
  let events: Array<{ type: string; [k: string]: unknown }>;
  let points: Map<string, number>;
  let answered: Array<unknown[]>;
  let missions: Mission[];
  let answerResult: Json;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ion-vision-"));
    cwdBefore = process.cwd();
    process.chdir(dir);
    events = [];
    points = new Map();
    answered = [];
    missions = [];
    answerResult = { ok: true, pointsEarned: 15, profile: profile(A, 15), confirmed: null };
  });
  afterEach(() => {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  function make(model: VisionModel | null, extra: Partial<VisionConfig> = {}) {
    const keptDir = join(mkdtempSync(join(tmpdir(), "ion-kept-")), "kept");
    const v = createVision({
      model, keptDir, now: () => new Date("2026-11-21T12:00:00Z"), areaOf: () => "Μοναστηράκι",
      missionsNear: () => missions,
      answerMission: async (...args) => { answered.push(args); return answerResult as never; },
      award: (p, n) => { points.set(p, (points.get(p) ?? 0) + n); return profile(p, points.get(p)!); },
      profile: (p) => profile(p, points.get(p) ?? 0),
      announce: (e) => events.push(e),
      ...extra,
    });
    const post = async (path: string, body: unknown) => {
      const res = await v.router.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Json };
    };
    const observe = (over: Json = {}) => post("/observe", { image: jpeg().b64, ...POS, participant: A, purpose: "map", ...over });
    return { ...v, post, observe, keptDir };
  }
  const detections = (...d: Json[]) => new FakeModel(() => ({ detections: d }));

  it("answers 503 with a plain Greek message and a status that says no model, when nothing is configured", async () => {
    const { router, observe } = make(null);
    const s = (await (await router.request("/status")).json()) as Json;
    expect(s).toMatchObject({ configured: false, answering: false, model: null });
    expect(s.notice).toBe("Η εικόνα αναλύεται και δεν αποθηκεύεται. Αποφασίζετε εσείς τι μπαίνει στον χάρτη.");
    const r = await observe();
    expect(r.status).toBe(503);
    expect(r.body.error.message).toMatch(/δεν είναι ενεργή/);
    expect((await make(null).post("/confirm", { participant: A, proposal: { kind: "steps" }, ...POS })).status).toBe(503);
  });

  it("reads VISION_URL and VISION_MODEL from the environment and says the licence", async () => {
    const { router } = make(undefined as never, { model: undefined, env: { VISION_URL: "http://127.0.0.1:1", VISION_MODEL: "qwen3-vl:4b-instruct" } });
    const s = (await (await router.request("/status")).json()) as Json;
    expect(s).toMatchObject({ configured: true, model: "qwen3-vl:4b-instruct", licence: "Apache-2.0", answering: false });
  });

  it("proposes from a closed vocabulary: unknown kinds, people and unreadable signs are dropped", async () => {
    const m = new FakeModel(() => ({
      signs: ["ΤΑΜΕΙΟ", "", "μια γυναίκα", "ΤΑΜΕΙΟ"],
      detections: [
        { kind: "steps", confidence: "high", evidence: "τρία σκαλιά στην είσοδο" },
        { kind: "flying_carpet", confidence: "high", evidence: "χαλί" },
        { kind: "sidewalk_obstacle", confidence: "high", evidence: "μια γυναίκα με καροτσάκι" },
        { kind: "sign_text", confidence: "high", evidence: "πινακίδα χωρίς κείμενο" },
        { kind: "ramp", confidence: "wild", evidence: "ράμπα" },
      ],
    }));
    const { observe } = make(m);
    const r = await observe();
    expect(r.status).toBe(200);
    const kinds = r.body.proposals.map((p: Json) => p.kind);
    expect(kinds).toEqual(["steps", "sign_text", "ramp"]);
    expect(kinds.every((k: string) => (KINDS as readonly string[]).includes(k))).toBe(true);
    expect(r.body.proposals[1]).toMatchObject({ label: "Πινακίδα με κείμενο: ΤΑΜΕΙΟ", text: "ΤΑΜΕΙΟ", confidence: "medium" });
    expect(r.body.proposals[2].confidence).toBe("low");
    // The evidence is Greek: an English phrase from the model is replaced by the fixed Greek one.
    expect(r.body.proposals[0].evidence).toBe("τρία σκαλιά στην είσοδο");
    const english = await make(detections({ kind: "ramp", confidence: "high", evidence: "a ramp with railings" })).observe();
    expect(english.body.proposals[0].evidence).toMatch(/[Α-ωά-ώ]/);
  });

  it("drops clear_path when something blocks the pavement", async () => {
    const { observe } = make(detections(
      { kind: "clear_path", confidence: "high", evidence: "ελεύθερο" },
      { kind: "sidewalk_obstacle", confidence: "medium", evidence: "αυτοκίνητο πάνω στο πεζοδρόμιο" },
    ));
    expect((await observe()).body.proposals.map((p: Json) => p.kind)).toEqual(["sidewalk_obstacle"]);
  });

  it("attaches the nearest open mission it would answer; the rest are discoveries", async () => {
    missions = [mission("venue_check:aaa", "venue_check", { key: "step_count" }), mission("obstacle_check:bbb", "obstacle_check"), mission("crowd_check:ccc", "crowd_check")];
    const { observe } = make(detections(
      { kind: "entrance_with_steps", confidence: "high", evidence: "σκαλιά" },
      { kind: "sidewalk_obstacle", confidence: "high", evidence: "κάδος" },
      { kind: "tactile_paving", confidence: "high", evidence: "κίτρινη λωρίδα" },
    ));
    const r = await observe();
    const by = (k: string) => r.body.proposals.find((p: Json) => p.kind === k);
    expect(by("entrance_with_steps")).toMatchObject({ discovery: false, mission: { id: "venue_check:aaa", answer: "no", question: "question venue_check:aaa" } });
    expect(by("sidewalk_obstacle")).toMatchObject({ discovery: false, mission: { id: "obstacle_check:bbb", answer: "yes" } });
    expect(by("tactile_paving")).toMatchObject({ discovery: true });
    expect(by("tactile_paving").mission).toBeUndefined();
  });

  it("answers an invalid model output with 502 and a clear message", async () => {
    const { observe } = make(new FakeModel(() => { throw new ModelError("invalid_output", "not json"); }));
    const r = await observe();
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("invalid_output");
    const r2 = await make(new FakeModel(() => ({ detections: "many" }))).observe();
    expect(r2.status).toBe(502);
  });

  it("gives up on a slow model within the time limit and says so", async () => {
    const { observe, service } = make(new FakeModel(() => new Promise(() => undefined)), { opts: { timeoutMs: 40 } });
    const started = Date.now();
    const r = await observe();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.status).toBe(504);
    expect(r.body.error).toMatchObject({ code: "timeout", message: expect.stringMatching(/άργησε/) });
    expect(service.opts.timeoutMs).toBe(40);
    expect(make(null).service.opts.timeoutMs).toBeLessThanOrEqual(12_000);
  });

  it("answers 503 when the runtime is down", async () => {
    const { observe } = make(new FakeModel(() => { throw new ModelError("unavailable", "refused"); }));
    expect((await observe()).status).toBe(503);
  });

  it("rejects images over 1.5 MB and things that are not JPEG", async () => {
    const m = detections();
    const { observe } = make(m);
    const big = Buffer.alloc(1_600_000, 1); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    expect((await observe({ image: big.toString("base64") })).status).toBe(413);
    expect((await observe({ image: Buffer.alloc(900, 3).toString("base64") })).status).toBe(400);
    expect(m.calls).toBe(0);
  });

  it("describes for a person who cannot see: polite, uncertain, never an instruction to cross", async () => {
    const m = new FakeModel(() => ({ signs: ["ΕΞΟΔΟΣ"], detections: [
      { kind: "crossing_signals", confidence: "high", evidence: "φανάρι πεζών" },
      { kind: "steps", confidence: "medium", evidence: "σκαλιά" },
    ] }));
    const { observe } = make(m);
    const r = await observe({ purpose: "describe" });
    expect(r.status).toBe(200);
    expect(r.body.proposals).toBeUndefined();
    const speech: string = r.body.speech;
    expect(speech).toMatch(/διάβαση με φανάρι/);
    expect(speech).toMatch(/ΕΞΟΔΟΣ/);
    expect(speech).toMatch(/δεν είμαι βέβαιος/i);
    expect(speech).not.toMatch(/περάστε|διασχίστε|μπορείτε να (περάσετε|διασχίσετε|προχωρήσετε)|προχωρήστε|είναι ασφαλές να|!/i);
    expect(speech.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(3);
    const empty = (await make(detections()).observe({ purpose: "describe" })).body.speech;
    expect(empty).toMatch(/δεν διακρίνω/i);
  });

  describe("confirm", () => {
    it("submits a mission answer through the existing mission logic", async () => {
      missions = [mission("obstacle_check:bbb", "obstacle_check")];
      answerResult = { ok: true, pointsEarned: 20, profile: profile(A, 20), confirmed: null };
      const { post } = make(detections());
      const r = await post("/confirm", { participant: A, proposal: { kind: "sidewalk_obstacle", mission: { id: "obstacle_check:bbb", answer: "no" } }, ...POS });
      expect(r.status).toBe(200);
      // The answer is decided by the server from the kind, not taken from the client.
      expect(answered).toEqual([["obstacle_check:bbb", A, "yes", [POS.lng, POS.lat]]]);
      expect(r.body).toMatchObject({ kind: "sidewalk_obstacle", discovery: false, pointsEarned: 20, confirmed: null, needsSecond: true });
    });

    it("tells a confirmed mission answer in the map's terms", async () => {
      missions = [mission("venue_check:aaa", "venue_check", { key: "step_count" })];
      answerResult = { ok: true, pointsEarned: 35, profile: profile(B, 35), confirmed: { missionId: "venue_check:aaa", value: "no" } };
      const r = await make(detections()).post("/confirm", { participant: B, proposal: { kind: "steps" }, missionId: "venue_check:aaa", ...POS });
      expect(r.body).toMatchObject({ needsSecond: false, confirmed: { value: "no" } });
    });

    it("passes the mission rules through: reach, two different people, daily limit", async () => {
      missions = [mission("obstacle_check:bbb", "obstacle_check")];
      answerResult = { ok: false, status: 422, code: "too_far", message: "Πρέπει να βρίσκεστε στο σημείο." };
      const r = await make(detections()).post("/confirm", { participant: A, proposal: { kind: "sidewalk_obstacle" }, missionId: "obstacle_check:bbb", ...POS });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("too_far");
    });

    it("refuses a mission that is gone or does not match what was seen", async () => {
      missions = [mission("crowd_check:ccc", "crowd_check")];
      const { post } = make(detections());
      expect((await post("/confirm", { participant: A, proposal: { kind: "steps" }, missionId: "crowd_check:ccc", ...POS })).status).toBe(409);
      expect(answered).toHaveLength(0);
    });

    it("stores a discovery as seen by one, with both who proposed and who confirmed, and rounds the position", async () => {
      const { post, service } = make(detections());
      const r = await post("/confirm", { participant: A, proposal: { kind: "tactile_paving" }, lng: 23.727512345, lat: 37.975598765 });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ kind: "tactile_paving", label: "Οδηγός όδευσης τυφλών", discovery: true, pointsEarned: 30, confirmed: null, needsSecond: true });
      expect(r.body.profile.points).toBe(30);
      expect(service.stored()).toEqual([expect.objectContaining({ source: "camera", proposedBy: "vision", confirmedBy: [A], status: "seen_by_one", lng: 23.7275, lat: 37.9756 })]);
      expect(events.map((e) => e.type)).toEqual(["discovery_added"]);
      expect(JSON.stringify(events)).not.toContain(A);
    });

    it("becomes a map fact only when a second participant confirms close by, and announces it", async () => {
      const { post, service, router } = make(detections());
      await post("/confirm", { participant: A, proposal: { kind: "steps" }, ...POS });
      const own = await post("/confirm", { participant: A, proposal: { kind: "steps" }, ...POS });
      expect(own.status).toBe(409);
      const far = await post("/confirm", { participant: B, proposal: { kind: "steps" }, lng: POS.lng + 0.001, lat: POS.lat });
      expect(far.body.needsSecond).toBe(true);
      const near = await post("/confirm", { participant: B, proposal: { kind: "steps" }, lng: POS.lng + 0.0001, lat: POS.lat });
      expect(near.body).toMatchObject({ discovery: true, needsSecond: false, pointsEarned: 30, confirmed: { confirmed: true, seenBy: 2 } });
      expect(service.stored().filter((o) => o.status === "confirmed")).toHaveLength(1);
      expect(points.get(A)).toBe(30 + 20);
      expect(events.map((e) => e.type)).toEqual(["discovery_added", "discovery_added", "discovery_confirmed", "map_updated"]);
      expect(events[3]).toMatchObject({ observation: { type: "camera_discovery", value: "yes", confirmedBy: 2 } });
      const list = (await (await router.request("/discoveries")).json()) as Json;
      expect(list.discoveries).toHaveLength(2);
      expect(JSON.stringify(list)).not.toContain(B);
    });

    it("never trusts the label from the client", async () => {
      const { post } = make(detections());
      const r = await post("/confirm", { participant: A, proposal: { kind: "ramp", label: "Παραπλανητική" }, ...POS });
      expect(r.body.label).toBe("Ράμπα");
      expect((await post("/confirm", { participant: A, proposal: { kind: "dragon" }, ...POS })).status).toBe(400);
    });
  });

  describe("the frame", () => {
    it("is not kept by default: nothing is written under the working directory and nothing holds the image", async () => {
      const m = detections({ kind: "steps", confidence: "high", evidence: "σκαλιά" });
      const { observe, service, keptDir } = make(m);
      const { b64, marker } = jpeg(9);
      const before = readdirSync(process.cwd());
      const r = await observe({ image: b64 });
      m.seen = []; // the test double's own log is not the service's memory
      expect(r.status).toBe(200);
      expect(r.body.kept).toBe(false);
      expect(readdirSync(process.cwd())).toEqual(before);
      expect(() => readdirSync(keptDir)).toThrow();
      // Walk everything the service can reach: the frame must not be in it.
      const seen = new Set<unknown>();
      const holds = (v: unknown): boolean => {
        if (typeof v === "string") return v.includes(marker) || Buffer.from(v, "base64").includes("IMAGE-MARKER-DO-NOT-KEEP");
        if (v === null || typeof v !== "object" || seen.has(v)) return false;
        seen.add(v);
        if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).includes("IMAGE-MARKER-DO-NOT-KEEP");
        const entries = v instanceof Map ? [...v.keys(), ...v.values()] : v instanceof Set ? [...v] : Object.values(v);
        return entries.some(holds);
      };
      expect(holds(service)).toBe(false);
      expect(holds({ response: r.body })).toBe(false);
    });

    it("never logs the image", async () => {
      const logged: string[] = [];
      const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
      for (const k of ["log", "info", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logged.push(a.join(" ")); };
      try { await make(detections()).observe(); } finally { Object.assign(console, original); }
      expect(logged.join("")).not.toContain("IMAGE-MARKER");
    });

    it("is kept only in the kept folder, with no participant id, when the citizen chose to donate it", async () => {
      const m = detections({ kind: "steps", confidence: "high", evidence: "σκαλιά" });
      const { observe, keptDir, router } = make(m);
      const r = await observe({ keep: true, heading: 91.6, lng: 23.727512345, lat: 37.975598765 });
      expect(r.body.kept).toBe(true);
      expect(readdirSync(process.cwd())).toEqual([]);
      const files = readdirSync(keptDir);
      expect(files).toHaveLength(2);
      const meta = JSON.parse(readFileSync(join(keptDir, files.find((f) => f.endsWith(".json"))!), "utf8")) as Json;
      expect(meta).toMatchObject({ position: [23.7275, 37.9756], heading: 92, model: "fake-vl:1b" });
      expect(meta.proposals[0].kind).toBe("steps");
      expect(JSON.stringify(meta)).not.toContain(A);
      expect(readFileSync(join(keptDir, files.find((f) => f.endsWith(".jpg"))!)).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(((await (await router.request("/status")).json()) as Json).kept).toBe(1);
    });

    it("queues a donated frame when the model is down and says so", async () => {
      const { observe, keptDir } = make(new FakeModel(() => { throw new ModelError("unavailable", "down"); }));
      const r = await observe({ keep: true });
      expect(r.status).toBe(202);
      expect(r.body).toMatchObject({ queued: true, message: KEPT_LATER });
      expect(readdirSync(keptDir)).toHaveLength(2);
      const none = make(null);
      expect((await none.observe({ keep: true })).body.message).toBe("Η φωτογραφία κρατήθηκε και θα αναλυθεί αργότερα.");
      expect((await make(new FakeModel(() => { throw new ModelError("unavailable", "down"); })).observe()).status).toBe(503);
    });

    it("keeps the folder under its cap, oldest first", async () => {
      let t = Date.parse("2026-11-21T12:00:00Z");
      const { observe, keptDir } = make(detections(), { now: () => new Date((t += 1000)), opts: { keptMaxFrames: 2 } });
      for (let i = 0; i < 4; i++) await observe({ keep: true });
      expect(readdirSync(keptDir).filter((f) => f.endsWith(".jpg"))).toHaveLength(2);
      expect(readdirSync(keptDir).filter((f) => f.endsWith(".json"))).toHaveLength(2);
    });
  });
});
