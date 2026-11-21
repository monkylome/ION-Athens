/** The room channel and the help requests. In memory, no network. */
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { FallbackRouting } from "../routing/fallback.ts";
import { SandboxClient } from "../sandbox/client.ts";
import { at, testEdges, testGraph } from "../testing/fixtures.ts";
import { RoomHub, type RoomEvent } from "./hub.ts";
import { roundPosition } from "./service.ts";

function member(hub: RoomHub, room: string, id: string) {
  const events: RoomEvent[] = [];
  const closed: string[] = [];
  const r = hub.join(room, id, (e) => void events.push(e), (why) => void closed.push(why));
  return { r, events, closed };
}

describe("room hub", () => {
  it("relays to the room or to one member, never back to the sender", () => {
    const hub = new RoomHub();
    const a = member(hub, "r", "member-a1");
    const b = member(hub, "r", "member-b1");
    const c = member(hub, "r", "member-c1");
    expect(hub.send("r", "member-a1", { hi: 1 })).toMatchObject({ ok: true, delivered: 2 });
    expect(hub.send("r", "member-a1", { only: "b" }, "member-b1")).toMatchObject({ ok: true, delivered: 1 });
    const msgs = (x: typeof a) => x.events.filter((e) => e.event === "message").length;
    expect([msgs(a), msgs(b), msgs(c)]).toEqual([0, 2, 1]);
    expect(b.events[0]).toMatchObject({ event: "hello", data: { members: ["member-a1"] } });
    expect(hub.send("r", "member-a1", 1, "nobody-here")).toMatchObject({ ok: false, code: "recipient_gone" });
    expect(hub.send("r", "stranger-1", 1)).toMatchObject({ ok: false, code: "not_member" });
  });

  it("announces joins and leaves and deletes an empty room", () => {
    const hub = new RoomHub();
    const a = member(hub, "r", "member-a1");
    member(hub, "r", "member-b1");
    hub.leave("r", "member-b1");
    expect(a.events.map((e) => e.event)).toEqual(["hello", "member_joined", "member_left"]);
    hub.leave("r", "member-a1");
    expect(hub.roomCount()).toBe(0);
  });

  it("bounds rooms, members, message size and rate", () => {
    let t = 0;
    const hub = new RoomHub({ maxRooms: 2, maxMembersPerRoom: 2, maxMessageBytes: 50, maxMessagesPerWindow: 3, windowMs: 1000 }, () => t);
    member(hub, "r1", "member-a1");
    member(hub, "r1", "member-b1");
    expect(member(hub, "r1", "member-c1").r).toMatchObject({ ok: false, code: "room_full" });
    member(hub, "r2", "member-a1");
    expect(member(hub, "r3", "member-a1").r).toMatchObject({ ok: false, code: "room_limit" });
    expect(hub.send("r1", "member-a1", "x".repeat(80))).toMatchObject({ ok: false, code: "too_large" });
    for (let i = 0; i < 3; i++) expect(hub.send("r1", "member-a1", i).ok).toBe(true);
    expect(hub.send("r1", "member-a1", 4)).toMatchObject({ ok: false, code: "rate_limited" });
    t = 1500;
    expect(hub.send("r1", "member-a1", 5).ok).toBe(true);
  });

  it("removes members who vanish and replaces a member that joins twice", () => {
    let t = 0;
    const hub = new RoomHub({ memberTtlMs: 1000 }, () => t);
    const a = member(hub, "r", "member-a1");
    const b = member(hub, "r", "member-b1");
    t = 800;
    hub.touch("r", "member-b1");
    t = 1500;
    expect(hub.sweep()).toBe(1);
    expect(a.closed).toEqual(["expired"]);
    expect(b.closed).toEqual([]);
    const b2 = member(hub, "r", "member-b1");
    expect(b.closed).toEqual(["replaced"]);
    expect(b2.r.ok).toBe(true);
  });

  it("drops a member whose queue is full", () => {
    const hub = new RoomHub();
    const closed: string[] = [];
    hub.join("r", "member-a1", () => { throw new Error("full"); }, (why) => void closed.push(why));
    member(hub, "r", "member-b1");
    hub.send("r", "member-b1", 1);
    expect(closed).toContain("too_slow");
  });
});

function setup() {
  let time = Date.parse("2026-11-21T12:00:00+02:00");
  const sandbox = { reports: [] as Array<Record<string, unknown>> };
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname.replace("/sandbox", "");
    const send = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/v1/projects.geojson") return send({ type: "FeatureCollection", features: [] });
    if (path === "/v1/requests" && (init?.method ?? "GET") === "POST") {
      const created = { ...(JSON.parse(String(init?.body)) as object), id: `req-${1001 + sandbox.reports.length}`, status: "submitted", upvotes: 0, created_at: new Date(time).toISOString() };
      sandbox.reports.push(created);
      return send(created, 201);
    }
    if (path === "/v1/requests") return send({ total: sandbox.reports.length, page: 1, size: 100, items: sandbox.reports });
    return send({ error: { code: "not_found", message: "no" } }, 404);
  };
  const client = new SandboxClient({ baseUrl: "https://sandbox.test/sandbox", apiKey: "k-test-12345", fetch: fetchFn as typeof fetch });
  const events: Array<Record<string, unknown>> = [];
  const { app } = createApp({
    client, routing: new FallbackRouting(testGraph()), edges: testEdges(), graphLoaded: true, now: () => new Date(time),
    assist: { heartbeatMs: 20 },
  });
  const post = async (path: string, body: unknown) => {
    const res = await app.request("/api/assist" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const get = async (path: string) => {
    const res = await app.request("/api/assist" + path);
    return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const p = (x: number, y: number) => ({ lng: at(x, y)[0], lat: at(x, y)[1] });
  return { app, post, get, p, sandbox, events, advance: (ms: number) => (time += ms) };
}
const PERSON = "person-device-0001";
const HELPER = "helper-device-0001";

describe("help requests", () => {
  it("rounds the position to about 100 m", () => {
    const [lng, lat] = at(37, 41);
    const [rl, rt] = roundPosition([lng, lat]);
    expect(Math.abs(rt - lat) * 110_540).toBeLessThan(60);
    expect(Math.abs(rl - lng) * 111_320 * Math.cos((lat * Math.PI) / 180)).toBeLessThan(60);
    expect(roundPosition([lng, lat])).toEqual(roundPosition([lng + 1e-6, lat + 1e-6]));
  });

  it("a request is listed with area and distance but not the exact position, and one citizen takes it", async () => {
    const { post, get, p } = setup();
    const made = await post("/requests", { device: PERSON, ...p(50, 3), text: "Στο πεζοδρόμιο" });
    expect(made.status).toBe(201);
    expect(JSON.stringify(made.body)).not.toContain(String(p(50, 3).lat));
    const list = await get(`/requests?lng=${p(60, 5).lng}&lat=${p(60, 5).lat}`);
    expect(list.body.requests).toHaveLength(1);
    expect(list.body.requests[0]).toMatchObject({ area: expect.stringMatching(/^Οδός /), text: "Στο πεζοδρόμιο" });
    expect(list.body.requests[0].distanceM % 50).toBe(0);
    expect(Object.keys(list.body.requests[0]).sort()).toEqual(["area", "distanceM", "expiresInS", "id", "text", "waitingS"]);

    const id = made.body.request.id;
    expect((await post(`/requests/${id}/accept`, { device: PERSON })).status).toBe(403);
    const ok = await post(`/requests/${id}/accept`, { device: HELPER });
    expect(ok.status).toBe(200);
    expect(ok.body.request.room).toMatch(/^assist-/);
    expect((await post(`/requests/${id}/accept`, { device: "helper-device-0002" })).status).toBe(409);
    expect((await get(`/requests?lng=${p(60, 5).lng}&lat=${p(60, 5).lat}`)).body.requests).toHaveLength(0);
    expect((await get(`/requests/${id}?device=${PERSON}`)).body.request).toMatchObject({ status: "accepted", role: "person" });
    expect((await get(`/requests/${id}?device=stranger-device-1`)).status).toBe(403);
  });

  it("a request nobody accepts ends after 5 minutes", async () => {
    const { post, get, p, advance } = setup();
    const id = (await post("/requests", { device: PERSON, ...p(50, 3) })).body.request.id;
    advance(5 * 60_000 + 1000);
    expect((await get(`/requests/${id}?device=${PERSON}`)).body.request).toMatchObject({ status: "expired", endReason: "expired" });
    expect((await post(`/requests/${id}/accept`, { device: HELPER })).status).toBe(410);
  });

  it("a call over 30 s earns points; a short one does not; at most 5 rewarded calls a day", async () => {
    const { post, get, p, advance } = setup();
    const call = async (seconds: number) => {
      const id = (await post("/requests", { device: PERSON, ...p(50, 3) })).body.request.id;
      await post(`/requests/${id}/accept`, { device: HELPER });
      advance(seconds * 1000);
      expect((await post(`/requests/${id}/end`, { device: PERSON })).status).toBe(200);
      return (await get(`/requests/${id}?device=${HELPER}`)).body.request;
    };
    expect((await call(10)).reward).toMatchObject({ rewarded: false, reason: "too_short", pointsEarned: 0 });
    const first = (await call(40)).reward;
    expect(first).toMatchObject({ rewarded: true, pointsEarned: 30, profile: { points: 30, level: "Νέος χαρτογράφος" } });
    for (let i = 0; i < 4; i++) await call(40);
    expect((await call(40)).reward).toMatchObject({ rewarded: false, reason: "daily_limit", profile: { points: 150 } });
    // The person never sees the helper's points.
    const id = (await post("/requests", { device: PERSON, ...p(50, 3) })).body.request.id;
    expect((await get(`/requests/${id}?device=${PERSON}`)).body.request.reward).toBeUndefined();
  });

  it("marks need the helper of a live call, are stored rounded with their source, earn points, and an obstacle files a report", async () => {
    const { post, get, p, sandbox, advance } = setup();
    const id = (await post("/requests", { device: PERSON, ...p(50, 3) })).body.request.id;
    const mark = (device: string, kind: string, pos = p(52, 4)) => post(`/requests/${id}/marks`, { device, kind, ...pos });
    expect((await mark(HELPER, "ramp")).status).toBe(403);
    await post(`/requests/${id}/accept`, { device: HELPER });
    expect((await mark(PERSON, "ramp")).status).toBe(403);
    expect((await mark(HELPER, "dragon")).status).toBe(400);
    expect((await mark(HELPER, "ramp", p(9000, 4))).status).toBe(422);
    const ramp = await mark(HELPER, "ramp");
    expect(ramp.status).toBe(201);
    expect(ramp.body).toMatchObject({ pointsEarned: 3, report: null, observation: { kind: "ramp", label: "Ράμπα", source: "help_call" } });
    expect(sandbox.reports).toHaveLength(0);
    const obstacle = await mark(HELPER, "sidewalk_obstacle");
    expect(obstacle.body.report).toMatchObject({ id: "req-1001" });
    expect(sandbox.reports).toHaveLength(1);
    expect(sandbox.reports[0]).toMatchObject({ category: "sidewalk", title: "Εμπόδιο στο πεζοδρόμιο" });
    expect(obstacle.body.profile.points).toBe(6);
    const list = (await get("/observations")).body.observations;
    expect(list.map((o: { kind: string }) => o.kind)).toEqual(["sidewalk_obstacle", "ramp"]);
    expect(String(list[0].lat).split(".")[1]!.length).toBeLessThanOrEqual(4);
    await post(`/requests/${id}/end`, { device: HELPER });
    advance(1);
    expect((await mark(HELPER, "ramp")).status).toBe(409);
  });

  it("the room closes when the call ends and strangers cannot create help rooms", async () => {
    const { app, post, p } = setup();
    expect((await app.request(`/api/assist/rooms/assist-${"0".repeat(32)}/events?member=member-a1`)).status).toBe(404);
    const id = (await post("/requests", { device: PERSON, ...p(50, 3) })).body.request.id;
    const room = (await post(`/requests/${id}/accept`, { device: HELPER })).body.request.room as string;
    const res = await app.request(`/api/assist/rooms/${room}/events?member=${HELPER}`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const read = async (until: string) => {
      let text = "";
      while (!text.includes(until)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
      return text;
    };
    expect(await read("event: hello")).toContain("event: hello");
    expect((await post(`/rooms/${room}/messages`, { from: HELPER, data: { x: 1 } })).body.delivered).toBe(0);
    const other = await app.request(`/api/assist/rooms/${room}/events?member=${PERSON}`);
    expect(other.status).toBe(200);
    expect((await app.request(`/api/assist/rooms/${room}/events?member=third-member-1`)).status).toBe(409);
    await post(`/requests/${id}/end`, { device: PERSON });
    expect(await read("event: closed")).toContain("person_ended");
    await reader.cancel();
    await other.body!.cancel();
  });
});
