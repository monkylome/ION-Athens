import { describe, expect, it } from "vitest";
import type { Obstacle } from "@ion/core";
import { DEFAULT_CONFIG, configFromSearch, resolveTimeScale } from "./config";
import { MOMENT, ScenarioEngine } from "./engine";
import { hostLink } from "./link";
import { FakeClock, FakeServer, FakeVoice, ladder, ladderPlaces } from "./testing";
import { memoryHub } from "./transport";
import type { Effect, ScenarioConfig, ScenarioState } from "./types";

// The fake server here asks for a report and two confirmations, to exercise a rule stricter than the default of two people.
const config: ScenarioConfig = { ...DEFAULT_CONFIG, from: "start", timeScale: 5, confirmLeadS: 2, witnessesNeeded: 3 };

function setup(over: Partial<ScenarioConfig> = {}, options: { fullAtUpvotes?: number; autoVoice?: boolean; sound?: boolean } = {}) {
  const { index } = ladder();
  const clock = new FakeClock();
  const server = new FakeServer(index, clock, options.fullAtUpvotes ?? 2);
  const voice = new FakeVoice(options.autoVoice ?? true);
  const effects: Effect[] = [];
  const engine = new ScenarioEngine(
    { index, places: ladderPlaces(index), api: server, voice, now: clock.now, wallNow: clock.wallNow, effect: (e) => effects.push(e), soundOn: () => options.sound ?? false },
    { ...config, ...over },
  );
  /** Let real time pass in 50 ms ticks. */
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 50) {
      clock.t += 50;
      engine.tick();
    }
  };
  const state = () => engine.getState();
  const walking = async () => {
    await engine.dispatch({ type: "advance" });
    await engine.dispatch({ type: "advance" });
  };
  return { index, clock, server, voice, effects, engine, run, state, walking };
}

/** Run until the predicate holds, at most `limitMs`. */
function until(s: ReturnType<typeof setup>, done: (state: ScenarioState) => boolean, limitMs = 60_000) {
  for (let t = 0; t < limitMs && !done(s.state()); t += 50) s.run(50);
  expect(done(s.state())).toBe(true);
}

describe("the scenario state machine", () => {
  it("starts idle at the configured place and resolves the spoken destination", async () => {
    const s = setup();
    expect(s.state().phase).toBe("idle");
    expect(s.state().start?.name).toBe("Μοναστηράκι");
    await s.engine.dispatch({ type: "advance" });
    expect(s.state().phase).toBe("destination");
    expect(s.state().destination).toMatchObject({ name: "Δημαρχείο Αθηνών", local: false, hospital: false, nodeId: "E" });
    expect(s.voice.said.at(-1)).toBe("Βρήκα: Δημαρχείο Αθηνών. Να ξεκινήσουμε;");
    expect(s.state().toasts.at(-1)?.text).toBe("POST /api/destination → 200 · SANDBOX");
  });

  it("walks the route with the simulated clock and announces the start", async () => {
    const s = setup();
    await s.walking();
    expect(s.state().phase).toBe("walking");
    expect(s.state().route?.edges).toEqual(["A-B", "B-C", "C-D", "D-E"]);
    expect(s.state().timeScale).toBe(5);
    expect(s.voice.said.at(-1)).toBe("Η πλοήγηση ξεκινά. Προορισμός: Δημαρχείο Αθηνών, 400 μέτρα.");
    s.run(2000); // 2 s at 1 m/s, five times faster
    expect(s.state().walker?.distanceM).toBeCloseTo(10, 0);
    expect(s.state().walker?.street).toBe("Αθηνάς");
  });

  it("a first report changes nothing for the walker; the confirmations the server asks for change the route", async () => {
    const s = setup();
    await s.walking();
    s.run(1000);
    await s.engine.dispatch({ type: "report", at: "ahead" });
    let tracked = s.state().obstacles[0]!;
    expect(s.state().phase).toBe("reported");
    expect(tracked).toMatchObject({ witnesses: 1, needed: 3, closes: false, createdHere: true, local: false });
    expect(tracked.obstacle.edgeId).toBe("B-C");
    expect(s.state().route?.edges).toEqual(["A-B", "B-C", "C-D", "D-E"]);
    expect(s.voice.said.some((t) => /εμπόδιο/i.test(t))).toBe(false); // the walker is told nothing yet

    await s.engine.dispatch({ type: "confirm" });
    tracked = s.state().obstacles[0]!;
    expect(tracked).toMatchObject({ witnesses: 2, needed: 3, closes: false });
    expect(s.state().phase).toBe("reported");
    expect(s.state().route?.edges).toEqual(["A-B", "B-C", "C-D", "D-E"]);

    s.clock.t += 400; // the last confirmation takes 400 ms to come back
    await s.engine.dispatch({ type: "confirm" });
    tracked = s.state().obstacles[0]!;
    expect(tracked).toMatchObject({ witnesses: 3, needed: 3, closes: true });
    expect(s.state().phase).toBe("rerouting");
    // Round the block: the turn is at B, the closed edge is not walked, and the way is 80 m longer.
    expect(s.state().route?.edges.slice(0, 3)).toEqual(["A-B", "B-B2", "B2-C2"]);
    expect(s.state().route?.edges).not.toContain("B-C");
    expect(s.state().route?.lengthM).toBeCloseTo(480, 0);
    expect(s.server.calls.filter((c) => c.includes("/confirm"))).toHaveLength(2);
  });

  it("runs the moment: warn, dark with the voice, then the new route, and measures both numbers", async () => {
    const s = setup({}, { autoVoice: false });
    await s.walking();
    s.voice.finish();
    s.run(1000);
    await s.engine.dispatch({ type: "report", at: "ahead" });
    await s.engine.dispatch({ type: "confirm" });
    const before = s.clock.t;
    s.clock.t += 250;
    await s.engine.dispatch({ type: "confirm" });
    const walkedAtReroute = s.state().walker!.distanceM;

    expect(s.state().moment).toMatchObject({ beat: "warn", replay: false });
    expect(s.state().timeScale).toBe(1); // real time while the voice speaks
    expect(s.state().metrics).toMatchObject({ measuredFrom: "request", warningM: null });
    expect(s.state().metrics!.reportToRouteS).toBeCloseTo((s.clock.t - before - 250) / 1000, 3);
    expect(s.state().metrics!.extraM).toBeCloseTo(80, 0);
    expect(s.state().change).toMatchObject({ kind: "reroute" });
    expect(s.state().change!.divergeAtM).toBeCloseTo(100, 0);
    expect(s.effects).toContainEqual({ type: "earcon", name: "obstacle" });
    expect(s.state().signal?.value).toBe("obstacle_ahead");

    s.run(MOMENT.warnMs);
    expect(s.state().moment?.beat).toBe("dark");
    const saidBefore = s.voice.said.length;
    s.run(MOMENT.voiceDelayMs);
    expect(s.voice.said).toHaveLength(saidBefore + 1);
    const sentence = s.voice.said.at(-1)!;
    expect(sentence).toMatch(/^Εμπόδιο μπροστά, σε \d+ μέτρα\. Η διαδρομή αλλάζει\. Σε \d+ μέτρα, στρίψτε αριστερά\. Η νέα διαδρομή είναι 80 μέτρα μακρύτερη\.$/);
    expect(s.state().caption).toMatchObject({ text: sentence, kind: "obstacle" });

    // The warning is what was left to the turn when the voice began.
    const warning = s.state().metrics!.warningM!;
    expect(warning).toBeCloseTo(100 - s.state().walker!.distanceM, 0);
    expect(warning).toBeLessThan(100 - walkedAtReroute);
    expect(warning).toBeGreaterThan(40);

    s.run(3000); // the voice is still speaking: it stays dark
    expect(s.state().moment?.beat).toBe("dark");
    expect(s.state().phase).toBe("rerouting");
    s.voice.finish();
    s.run(MOMENT.silenceMs + 50);
    expect(s.state().moment?.beat).toBe("mend");
    expect(s.state().phase).toBe("walking_new");
    expect(s.state().timeScale).toBe(5);
    expect(s.effects).toContainEqual({ type: "earcon", name: "new_route" });
    s.run(MOMENT.mendMs + 50);
    expect(s.state().moment).toBeNull();
    expect(s.state().metrics!.warningM).toBe(warning);
  });

  it("plays the turn sound inside the moment only when sound is on", async () => {
    const s = setup({}, { sound: true });
    await s.walking();
    s.run(500);
    await s.engine.dispatch({ type: "report", at: "ahead" });
    await s.engine.dispatch({ type: "confirm" });
    await s.engine.dispatch({ type: "confirm" });
    s.run(MOMENT.warnMs + MOMENT.voiceDelayMs + 100);
    expect(s.effects).toContainEqual({ type: "turn_sound", toRight: false });
    s.run(MOMENT.silenceMs + 200);
    expect(s.state().moment?.beat).toBe("dark"); // three seconds of steps first
    s.run(MOMENT.turnSoundMs);
    expect(s.state().moment?.beat).toBe("mend");
  });

  it("restores the route when the obstacle is resolved, and walks to the destination", async () => {
    const s = setup();
    await s.walking();
    await s.engine.dispatch({ type: "report", at: "ahead" });
    await s.engine.dispatch({ type: "confirm" });
    await s.engine.dispatch({ type: "confirm" });
    until(s, (state) => state.phase === "walking_new" && state.moment === null);
    expect(s.state().walker!.distanceM).toBeLessThan(60);
    await s.engine.dispatch({ type: "resolve" });
    expect(s.server.calls.at(-1)).toMatch(/^POST \/demo\/resolve\/req-\d+ 200$/);
    expect(s.state().phase).toBe("restored");
    expect(s.state().route?.edges).toEqual(["A-B", "B-C", "C-D", "D-E"]);
    expect(s.state().change).toMatchObject({ kind: "restored" });
    expect(s.state().obstacles).toHaveLength(0);
    expect(s.voice.said.at(-1)).toMatch(/^Το εμπόδιο απομακρύνθηκε\. Η διαδρομή αλλάζει ξανά\./);
    until(s, (state) => state.phase === "arrived", 120_000);
    expect(s.voice.said.at(-1)).toBe("Φτάσατε: Δημαρχείο Αθηνών. Δεν μπορώ να επιβεβαιώσω την ακριβή είσοδο.");
    expect(s.state().signal?.value).toBe("arrived");
  });

  it("keeps the route when the obstacle is resolved too late to go back", async () => {
    const s = setup();
    await s.walking();
    await s.engine.dispatch({ type: "report", at: "ahead" });
    await s.engine.dispatch({ type: "confirm" });
    await s.engine.dispatch({ type: "confirm" });
    until(s, (state) => (state.walker?.distanceM ?? 0) > 150);
    const edges = s.state().route!.edges;
    await s.engine.dispatch({ type: "resolve" });
    expect(s.state().route!.edges).toEqual(edges);
    expect(s.state().phase).toBe("walking_new");
    expect(s.voice.said.at(-1)).toBe("Το εμπόδιο απομακρύνθηκε. Η διαδρομή σας δεν αλλάζει.");
  });

  it("reroutes for an obstacle that arrives on the event stream exactly as for its own", async () => {
    const s = setup();
    await s.walking();
    s.run(1000);
    const obstacle: Obstacle = {
      id: "sandbox:req-7", edgeId: "C-D", blocks: "partial", type: "sidewalk", label: "Εμπόδιο στο πεζοδρόμιο",
      source: { kind: "sandbox_request", ref: "req-7" }, synthetic: true, observedAt: "2026-11-22T10:00:00Z", expiresAt: null, confidence: 0.6,
    };
    s.engine.serverEvent({ type: "obstacle_added", obstacle });
    expect(s.state().phase).toBe("reported");
    expect(s.state().obstacles[0]).toMatchObject({ witnesses: 1, closes: false, createdHere: false });
    expect(s.state().route?.edges).toEqual(["A-B", "B-C", "C-D", "D-E"]);

    s.engine.serverEvent({ type: "obstacle_changed", obstacle: { ...obstacle, blocks: "full", confidence: 0.85 } });
    expect(s.state().phase).toBe("rerouting");
    expect(s.state().obstacles[0]).toMatchObject({ witnesses: 3, needed: 3, closes: true });
    expect(s.state().route?.edges.slice(0, 4)).toEqual(["A-B", "B-C", "C-C2", "C2-D2"]);
    expect(s.state().route?.edges).not.toContain("C-D");
    expect(s.state().metrics?.measuredFrom).toBe("event");

    until(s, (state) => state.phase === "walking_new");
    s.engine.serverEvent({ type: "obstacle_removed", obstacle });
    expect(s.state().phase).toBe("restored");
    expect(s.state().route?.edges).toEqual(["A-B", "B-C", "C-D", "D-E"]);
  });

  it("takes a snapshot as what is known, and drops what a later snapshot no longer has", async () => {
    const s = setup();
    const works: Obstacle = {
      id: "sandbox:prj-1:C-D", edgeId: "C-D", blocks: "full", type: "works", label: "Έργα", source: { kind: "sandbox_project", ref: "prj-1" },
      synthetic: true, observedAt: "2026-11-01T00:00:00Z", expiresAt: null, confidence: 0.8,
    };
    s.engine.serverEvent({ type: "snapshot", obstacles: [works] });
    await s.walking();
    // Known before the walk: the route already avoids it, and nothing is announced.
    expect(s.state().route?.edges).not.toContain("C-D");
    expect(s.state().route?.lengthM).toBeCloseTo(480, 0);
    expect(s.state().phase).toBe("walking");
    expect(s.state().moment).toBeNull();
    s.engine.serverEvent({ type: "snapshot", obstacles: [] });
    expect(s.state().obstacles).toHaveLength(0);
    expect(s.state().phase).toBe("restored");
  });

  it("shows what the server did when it closes a pavement sooner than configured", async () => {
    const s = setup({}, { fullAtUpvotes: 1 });
    await s.walking();
    await s.engine.dispatch({ type: "report", at: "ahead" });
    await s.engine.dispatch({ type: "confirm" });
    expect(s.state().obstacles[0]).toMatchObject({ witnesses: 2, needed: 2, closes: true });
    expect(s.state().phase).toBe("rerouting");
  });

  it("falls back to a local obstacle when the server cannot be reached, and says so", async () => {
    const s = setup();
    s.server.down = true;
    await s.walking(); // destination from the local catalogue, route from @ion/core
    expect(s.state().destination).toMatchObject({ name: "Δημαρχείο Αθηνών", local: true, how: "local_places" });
    expect(s.state().phase).toBe("walking");
    expect(s.state().connection).toBe("offline");
    expect(s.state().localFallback).toBe(true);
    await s.engine.dispatch({ type: "report", at: "ahead" });
    expect(s.state().obstacles[0]).toMatchObject({ local: true, witnesses: 1, closes: false });
    expect(s.state().obstacles[0]!.obstacle.id).toMatch(/^local:/);
    expect(s.state().toasts.some((t) => t.tone === "local" && t.text.startsWith("ΤΟΠΙΚΗ ΠΡΟΣΟΜΟΙΩΣΗ"))).toBe(true);
    expect(s.state().toasts.some((t) => t.text === "POST /api/reports → ΧΩΡΙΣ ΑΠΑΝΤΗΣΗ")).toBe(true);
    await s.engine.dispatch({ type: "confirm" });
    await s.engine.dispatch({ type: "confirm" });
    expect(s.state().phase).toBe("rerouting");
    expect(s.state().metrics?.measuredFrom).toBe("local");
    until(s, (state) => state.phase === "walking_new");
    await s.engine.dispatch({ type: "resolve" });
    expect(s.state().phase).toBe("restored");
    expect(s.server.calls.some((c) => / 2\d\d$/.test(c))).toBe(false); // no call was presented as answered
  });

  it("files a report where the walker stands and says what happened", async () => {
    const s = setup();
    await s.walking();
    s.run(4000);
    await s.engine.dispatch({ type: "report", at: "walker" });
    expect(s.server.calls.at(-1)).toBe("POST /reports 201");
    expect(s.state().obstacles[0]!.obstacle.edgeId).toBe("A-B");
    expect(s.state().notice).toBe("Η αναφορά σας καταχωρίστηκε. Χρειάζεται επιβεβαίωση από 2 ακόμη ανθρώπους πριν αλλάξει κάποια διαδρομή.");
    expect(s.voice.said.at(-1)).toBe(s.state().notice);
    expect(s.state().route?.edges).toEqual(["A-B", "B-C", "C-D", "D-E"]);
  });

  it("adds the 112 reminder when the destination is a hospital", async () => {
    const s = setup();
    // The server only guesses here (confidence 0.65, the wrong building). The catalogue has every word that was said.
    await s.engine.dispatch({ type: "setDestination", text: "Θέλω να πάω στην Πολυκλινική Αθηνών" });
    expect(s.state().destination).toMatchObject({ name: "Πολυκλινική Αθηνών", hospital: true, local: true });
    expect(s.state().toasts.map((t) => t.text)).toEqual(["POST /api/destination → 200 · SANDBOX", "ΤΟΠΙΚΟΣ ΚΑΤΑΛΟΓΟΣ OSM · Πολυκλινική Αθηνών"]);
    expect(s.voice.said.at(-1)).toMatch(/Αν είναι επείγον, καλέστε το 112\.$/);
    expect(s.state().connection).toBe("online");
    expect(s.state().localFallback).toBe(false); // the server answered; the place came from the OSM catalogue
  });

  it("understands the kind of place when the name was not said", async () => {
    const s = setup();
    await s.engine.dispatch({ type: "setDestination", text: "Θέλω να πάω στο νοσοκομείο" });
    expect(s.state().destination).toMatchObject({ name: "Πολυκλινική Αθηνών", hospital: true });
    expect(s.voice.said.at(-1)).toMatch(/καλέστε το 112\.$/);
  });

  it("says so when a destination is not understood, and stays idle", async () => {
    const s = setup();
    await s.engine.dispatch({ type: "setDestination", text: "κάπου ωραία" });
    expect(s.state().phase).toBe("idle");
    expect(s.voice.said.at(-1)).toBe("Δεν βρήκα προορισμό.");
  });

  it("keeps one sentence in flight: a waiting instruction is replaced, an urgent one cuts in", async () => {
    const s = setup({}, { autoVoice: false });
    await s.engine.dispatch({ type: "advance" });
    await s.engine.dispatch({ type: "advance" }); // the start sentence cuts the destination sentence
    const count = s.voice.said.length;
    until(s, (state) => (state.walker?.distanceM ?? 0) > 380, 120_000); // several instructions become due while the voice is busy
    expect(s.voice.said).toHaveLength(count);
    s.voice.finish();
    // Only what is still true is said: the arrival ahead, not the turns behind.
    expect(s.voice.said).toHaveLength(count + 1);
    expect(s.voice.said.at(-1)).toMatch(/προορισμ/);
  });

  it("pauses, replays the moment as a replay, and resets through the server", async () => {
    const s = setup();
    await s.walking();
    await s.engine.dispatch({ type: "pause" });
    const at = s.state().walker!.distanceM;
    s.run(2000);
    expect(s.state().walker!.distanceM).toBe(at);
    await s.engine.dispatch({ type: "pause" });
    await s.engine.dispatch({ type: "report", at: "ahead" });
    await s.engine.dispatch({ type: "confirm" });
    await s.engine.dispatch({ type: "confirm" });
    until(s, (state) => state.phase === "walking_new" && state.moment === null);
    const metrics = s.state().metrics;
    const sentence = s.voice.said.filter((t) => t.startsWith("Εμπόδιο μπροστά")).at(-1);

    await s.engine.dispatch({ type: "replay" });
    expect(s.state().moment).toMatchObject({ beat: "warn", replay: true });
    const frozen = s.state().walker!.distanceM;
    until(s, (state) => state.moment === null);
    expect(s.state().walker!.distanceM).toBe(frozen); // a replay does not move the walker
    expect(s.voice.said.filter((t) => t === sentence)).toHaveLength(2); // the same words, not new ones
    expect(s.state().metrics).toEqual(metrics); // and the measurements stay the measured ones
    expect(s.state().phase).toBe("walking_new");

    await s.engine.dispatch({ type: "reset" });
    expect(s.server.calls.at(-1)).toBe("POST /demo/reset 200");
    expect(s.state()).toMatchObject({ phase: "idle", route: null, walker: null, metrics: null, change: null, destination: null });
    expect(s.state().obstacles).toHaveLength(0);
  });

  it("removes a report that was never confirmed without touching the route", async () => {
    const s = setup();
    await s.walking();
    await s.engine.dispatch({ type: "report", at: "ahead" });
    expect(s.state().phase).toBe("reported");
    await s.engine.dispatch({ type: "resolve" });
    expect(s.state().phase).toBe("walking");
    expect(s.state().change).toBeNull();
  });
});

describe("scenario as data", () => {
  it("reads every part of the scenario from the address", () => {
    const c = configFromSearch("?from=Σύνταγμα&to=Θέλω+να+πάω+στο+ΚΕΠ&speed=1.2&scale=3&duration=120&witnesses=2&ahead=60");
    expect(c).toMatchObject({ from: "Σύνταγμα", sentence: "Θέλω να πάω στο ΚΕΠ", speedMps: 1.2, timeScale: 3, durationS: 120, witnessesNeeded: 2, minDecisionAheadM: 60 });
    expect(configFromSearch("")).toEqual(DEFAULT_CONFIG);
    expect(configFromSearch("?speed=abc&scale=-4").speedMps).toBe(1);
  });

  it("fits the walk into the demo when the scale is automatic", () => {
    expect(resolveTimeScale(DEFAULT_CONFIG, 327)).toBeCloseTo(5, 1);
    expect(resolveTimeScale({ ...DEFAULT_CONFIG, timeScale: 2 }, 327)).toBe(2);
    expect(resolveTimeScale(DEFAULT_CONFIG, 20)).toBe(1);
  });
});

describe("two screens, one state", () => {
  it("a follower gets the host's state on hello and its commands reach the engine", async () => {
    const s = setup();
    const connect = memoryHub();
    const hostEnd = connect();
    const phoneEnd = connect();
    const link = hostLink(hostEnd, "host", "stage", (command) => void s.engine.dispatch(command), () => s.state(), { now: s.clock.now });
    s.engine.subscribe((state) => link.publish(state));
    const seen: ScenarioState[] = [];
    phoneEnd.subscribe((message) => {
      if (message.t === "state") seen.push(message.state);
    });
    phoneEnd.post({ t: "hello", from: "phone" });
    expect(seen.at(-1)?.phase).toBe("idle");

    phoneEnd.post({ t: "command", from: "phone", command: { type: "setDestination", text: "Θέλω να πάω στο Δημαρχείο" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1)?.phase).toBe("destination");
    phoneEnd.post({ t: "command", from: "phone", command: { type: "start" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.at(-1)?.phase).toBe("walking");
    expect(seen.at(-1)?.route?.edges).toEqual(s.state().route?.edges);

    const before = seen.length;
    s.run(1000); // walker-only updates are sent at an interval, not on every tick
    expect(seen.length - before).toBeLessThan(8);
    expect(seen.length - before).toBeGreaterThan(2);
    link.close();
  });
});

it("keeps the chosen walking profile for the walk", async () => {
  const { engine, walking, state } = setup();
  expect(state().profile).toBe("voice");
  await engine.dispatch({ type: "chooseProfile", profile: "wheels" });
  await walking();
  expect(state().phase).toBe("walking");
  await engine.dispatch({ type: "chooseProfile", profile: "quiet" });
  expect(state().profile).toBe("wheels");
});
