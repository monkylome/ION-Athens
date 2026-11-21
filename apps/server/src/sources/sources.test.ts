/** Parsers, cache and the city endpoints. Hand-written inputs and a fake fetch; no network. */
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { FallbackRouting } from "../routing/fallback.ts";
import { SandboxClient } from "../sandbox/client.ts";
import { at, testEdges, testGraph } from "../testing/fixtures.ts";
import { parseAnnouncements } from "./announcements.ts";
import { CachedSource } from "./cache.ts";
import { LAYERS, parseGisLayer } from "./gis.ts";
import { athensDate, parseDutyPage } from "./hospitals.ts";
import { SourceError } from "./http.ts";
import { createCitySources, ownRows, type CitySources } from "./registry.ts";
import { findStation, parseStasyElevators } from "./stasy.ts";
import { StreetIndex } from "./streets.ts";
import { fromWebMercator, parseTrees } from "./trees.ts";
import type { SourceAdapter } from "./types.ts";
import { fold, htmlText } from "./text.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// --- hand-written inputs -----------------------------------------------------------

const lift = (name: string, ok = true) => `<li class='jw_elevatorStatus${ok ? "Ok" : "Error"}'>${name}<span class='jw_sr-only'> is ${ok ? "" : "not "}functional</span></li>`;
const station = (name: string, lifts: string) => `<li class="jw_line_station line1station0 jw_statusOk"><span class="jw_station__name">${name}</span><div class="jw_elevators_container"><ul class="jw_elevators_list">${lifts}</ul></div></li>`;
const STASY_HTML = `
<ul class="jw_lines"><li><button data-line="line1" class="jw_line_select">Γραμμή <span>(Α)</span></button></li><li><button data-line="line2" class="jw_line_select">Γραμμή <span>(Β)</span></button></li></ul>
<div class="jw_line_content  jwOpen" id="line1"><ul>
${station("Μοναστηράκι", lift("Προς Πειραιά") + lift("Προς Πειραιά", false) + "<li class='jw_elevatorStatusOk'><span class='jw_sr-only'> is functional</span></li>")}
${station("Ταύρος – Ελ. Βενιζέλος", lift("Πεζογέφυρα"))}
</ul></div>
<div class="jw_line_content" id="line2"><ul>
${station("Μοναστηράκι", lift("Προς Πειραιά") + lift("Άλλος"))}
</ul></div>`;

const merc = (lng: number, lat: number): { x: number; y: number } => ({ x: (lng * Math.PI * 6378137) / 180, y: 6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) });
const [LNG, LAT] = at(50, 5);

const MOH_HTML = `
<a href="?fdl=11" target="_blank" class="tip" title="Download: ΣΑΒΒΑΤΟ 21 ΝΟΕΜΒΡΙΟΥ 2026.pdf (531.9 KB)">x</a>
<a href="?fdl=12" target="_blank" class="tip" title="Download: efimeria_20261121.doc (135.5 KB)">y</a>
<a href="?fdl=13" target="_blank" class="tip" title="Download: ΚΥΡΙΑΚΗ 22 ΝΟΕΜΒΡΙΟΥ 2026.pdf (500 KB)">z</a>`;

const post = (id: number, date: string, title: string, content: string) => ({ id, date, link: `https://example.test/p/${id}`, title: { rendered: title }, content: { rendered: content } });
const POSTS = [
  post(1, "2026-11-06T15:41:32", "Κυκλοφοριακές ρυθμίσεις &#8211; Αγώνας &#038; Μαραθώνιος", "<p>Κλειστή η οδός Ερμού και η Αιόλου.</p>"),
  post(2, "2026-11-01T10:00:00", "Μια άσχετη ανακοίνωση", "<p>Ερμού</p>"),
  post(3, "2025-01-01T10:00:00", "Κυκλοφοριακές ρυθμίσεις παλιές", "<p>Οδός Ερμού</p>"),
];

const gisFeature = (layer: string, props: Record<string, unknown>, coordinates: unknown = [[LNG, LAT]], type = "MultiPoint") => ({
  type: "FeatureCollection",
  features: [{ id: `${layer}.1`, geometry: { type, coordinates }, properties: props }],
});
const GIS: Record<string, unknown> = {
  kep: gisFeature("kep", { label: "Δοκιμαστικό ΚΕΠ", tax_diefth: "Οδός 1, Τ.Κ. 100 00" }),
  nosokomeia: gisFeature("nosokomeia", { Label: "ΔΟΚΙΜΑΣΤΙΚΟ ΝΟΣΟΚΟΜΕΙΟ", odos: "ΟΔΟΣ", arith: "5" }),
  iatreia: gisFeature("iatreia", { name: "Δοκιμαστικό ιατρείο", diefth: "Οδός 2" }),
  stasy2024: {
    type: "FeatureCollection",
    features: [
      { id: "s.1", geometry: { type: "MultiPoint", coordinates: [[LNG, LAT]] }, properties: { label: "ΜΟΝΑΣΤΗΡΑΚΙ", eidos: "ΜΕΤΡΟ" } },
      { id: "s.2", geometry: { type: "MultiPoint", coordinates: [[LNG, LAT]] }, properties: { label: "ΖΑΠΠΕΙΟ", eidos: "ΤΡΑΜ" } },
    ],
  },
  pidakes: {
    type: "FeatureCollection",
    features: [
      { id: "p.1", geometry: { type: "MultiPoint", coordinates: [[LNG, LAT]] }, properties: { name: "Βρύση 1", address: "Οδός 3", status: "ΕΝΕΡΓΟ" } },
      { id: "p.2", geometry: { type: "MultiPoint", coordinates: [[LNG, LAT]] }, properties: { name: "Βρύση 2", address: "Οδός 4", status: "ΕΚΤΟΣ" } },
    ],
  },
  parking_amea: gisFeature("parking_amea", { street: "ΟΔΟΣ", number: "7" }, [LNG, LAT], "Point"),
};

const NEAR_STOP = { StopCode: 100, StopID: "1", StopDescr: "ΣΤΑΣΗ ΔΟΚΙΜΗ", StopStreet: "ΟΔΟΣ", StopLat: at(60, 10)[1], StopLng: at(60, 10)[0] };
const FAR_STOP = { StopCode: 200, StopID: "2", StopDescr: "ΜΑΚΡΙΑ", StopStreet: null, StopLat: at(3000, 10)[1], StopLng: at(3000, 10)[0] };

const NOTE_FILE = JSON.stringify({
  route: "r1",
  route_title: "Διαδρομή δοκιμής",
  source_url: "https://example.test/route",
  steps: [
    { order: 1, title: "Βήμα 1", text: "Προχωράμε ευθεία.", lng: LNG, lat: LAT, pois: [{ title: "Σημείο", url: "https://example.test/poi" }] },
    { order: 2, title: "Βήμα 2", text: "Χωρίς συντεταγμένες." },
  ],
});

interface World {
  down: Set<string>;
  calls: string[];
  now: Date;
}

function fakeCityFetch(world: World): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    world.calls.push(`${url.hostname}${url.pathname}${url.searchParams.get("act") ? `?act=${url.searchParams.get("act")}` : ""}`);
    const host = url.hostname;
    if (world.down.has(host)) throw new TypeError("fetch failed");
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (host === "www.stasy.gr") return new Response(STASY_HTML, { status: 200 });
    if (host === "www.moh.gov.gr") return new Response(MOH_HTML, { status: 200 });
    if (host === "www.cityofathens.gr") return json(POSTS);
    if (host === "athenstrees.cityofathens.gr") {
      const a = merc(LNG + 0.0004, LAT);
      const far = merc(LNG + 0.05, LAT);
      return json([
        { map_location_id: 1, tree_planting_id: 1, description: "ΟΔΟΣ 1", latitude: a.x, longitude: a.y },
        { map_location_id: 2, tree_planting_id: 2, description: "ΜΑΚΡΙΑ", latitude: far.x, longitude: far.y },
      ]);
    }
    if (host === "gis.cityofathens.gr") return json(GIS[/geonode:(\w+)/.exec(url.search.replaceAll("%3A", ":"))![1]!]);
    if (host === "telematics.oasa.gr") {
      const act = url.searchParams.get("act");
      if (act === "getClosestStops") return json([NEAR_STOP, FAR_STOP]);
      if (act === "getStopArrivals") return json(url.searchParams.get("p1") === "100" ? [{ route_code: 7, veh_code: 1, btime2: 9 }, { route_code: 8, veh_code: 2, btime2: 2 }] : []);
      if (act === "webRoutesForStop") return json([{ RouteCode: 7, LineCode: 70, LineID: "035", LineDescr: "ΔΟΚΙΜΗ - ΤΕΛΟΣ" }]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function cityWorld(opts: { routes?: boolean } = {}) {
  const world: World = { down: new Set(), calls: [], now: new Date("2026-11-21T12:00:00+02:00") };
  const city = createCitySources({
    fetch: fakeCityFetch(world),
    now: () => world.now,
    retryDelayMs: 0,
    routesDir: "/virtual",
    readFile: async (p) => {
      if (opts.routes !== false && p.endsWith("visual-impairment-acropolis.json")) return NOTE_FILE;
      throw new Error("ENOENT");
    },
  });
  return { world, city };
}

// --- parsers ---------------------------------------------------------------------------

describe("parsers", () => {
  it("reads lifts per station, merging stations listed on several lines", () => {
    const stations = parseStasyElevators(STASY_HTML);
    expect(stations.map((s) => s.station)).toEqual(["Μοναστηράκι", "Ταύρος – Ελ. Βενιζέλος"]);
    const mon = stations[0]!;
    expect(mon.lines).toEqual(["Γραμμή (Α)", "Γραμμή (Β)"]);
    // two lifts with the same label on one page are kept; the repeat on the second line is not counted twice
    expect(mon.lifts.map((l) => [l.name, l.working])).toEqual([["Προς Πειραιά", true], ["Προς Πειραιά", false], ["Ανελκυστήρας χωρίς όνομα", true], ["Άλλος", true]]);
    expect(mon.outOfService).toEqual(["Προς Πειραιά"]);
  });

  it("refuses a page with no station, and finds stations by folded name", () => {
    expect(() => parseStasyElevators("<html>nothing</html>")).toThrow(SourceError);
    const stations = parseStasyElevators(STASY_HTML);
    expect(findStation(stations, "ΜΟΝΑΣΤΗΡΑΚΙ")?.station).toBe("Μοναστηράκι");
    expect(findStation(stations, "ΤΑΥΡΟΣ")?.station).toBe("Ταύρος – Ελ. Βενιζέλος");
    expect(findStation(stations, "ΑΓΝΩΣΤΟΣ")).toBeNull();
  });

  it("finds the duty documents by date and today's date in Athens", () => {
    const docs = parseDutyPage(MOH_HTML);
    expect(docs.map((d) => d.date)).toEqual(["2026-11-22", "2026-11-21"]);
    expect(docs[1]).toMatchObject({ title: "ΣΑΒΒΑΤΟ 21 ΝΟΕΜΒΡΙΟΥ 2026", pdfUrl: expect.stringContaining("?fdl=11"), docUrl: expect.stringContaining("?fdl=12") });
    expect(athensDate(new Date("2026-11-21T23:30:00Z"))).toBe("2026-11-22");
  });

  it("keeps only posts about traffic arrangements and decodes the title", () => {
    const list = parseAnnouncements(POSTS);
    expect(list.map((a) => a.id)).toEqual([1, 3]);
    expect(list[0]!.title).toBe("Κυκλοφοριακές ρυθμίσεις – Αγώνας & Μαραθώνιος");
    expect(() => parseAnnouncements({ code: "rest_error" })).toThrow(SourceError);
  });

  it("converts web-mercator points with the swapped field names", () => {
    const a = merc(23.7257, 37.9762);
    const [lng, lat] = fromWebMercator(a.x, a.y);
    expect(lng).toBeCloseTo(23.7257, 6);
    expect(lat).toBeCloseTo(37.9762, 6);
    const trees = parseTrees([
      { map_location_id: 5, tree_planting_id: 5, description: " ΟΔΟΣ 9 ", latitude: a.x, longitude: a.y },
      { map_location_id: 6, description: "swapped back", latitude: a.y, longitude: a.x },
      { nonsense: true },
    ]);
    expect(trees).toHaveLength(1);
    expect(trees[0]).toMatchObject({ id: 5, description: "ΟΔΟΣ 9" });
    expect(() => parseTrees([{ map_location_id: 1, latitude: 5, longitude: 5 }])).toThrow(SourceError);
  });

  it("maps every GIS layer to places and drops inactive fountains", () => {
    const parsed = Object.fromEntries(LAYERS.map((def) => [def.layer, parseGisLayer(def, GIS[def.layer])]));
    expect(parsed["kep"]![0]).toMatchObject({ id: "gis:kep:kep.1", name: "Δοκιμαστικό ΚΕΠ", category: "kep", address: "Οδός 1, Τ.Κ. 100 00" });
    expect(parsed["nosokomeia"]![0]).toMatchObject({ category: "hospital", address: "ΟΔΟΣ 5" });
    expect(parsed["iatreia"]![0]!.category).toBe("municipal_clinic");
    expect(parsed["stasy2024"]!.map((p) => p.category)).toEqual(["metro_station", "tram_stop"]);
    expect(parsed["pidakes"]!.map((p) => p.name)).toEqual(["Βρύση 1"]);
    expect(parsed["parking_amea"]![0]).toMatchObject({ category: "disabled_parking", address: "ΟΔΟΣ 7", lng: LNG });
    expect(() => parseGisLayer(LAYERS[0]!, { html: "error" })).toThrow(SourceError);
  });

  it("folds Greek text and strips tags", () => {
    expect(fold("Βασιλίσσης  Σοφίας, 12")).toBe("ΒΑΣΙΛΙΣΣΗΣ ΣΟΦΙΑΣ 12");
    expect(htmlText("<p>α&nbsp;β</p><p>γ &amp; δ</p>")).toBe("α β γ & δ");
  });
});

describe("street names in text", () => {
  const edges = [
    { name: "Λεωφόρος Αμαλίας", geometry: [at(0, 0), at(100, 0)] },
    { name: "Ερμού", geometry: [at(0, 50), at(300, 50)] },
    { name: "Αρ", geometry: [at(0, 0), at(5, 0)] },
    { geometry: [at(0, 0), at(5, 0)] },
  ];
  const index = new StreetIndex(edges);
  it("matches whole names ignoring accents, skips tiny names", () => {
    expect(index.match("Κλειστή η ΕΡΜΟΥ και η οδός Αμαλίας.")).toEqual(["Λεωφόρος Αμαλίας", "Ερμού"]);
    expect(index.match("Ερμούπολη και Αρ")).toEqual([]);
  });
  it("measures the distance from a point to a street", () => {
    expect(index.distanceM("Ερμού", at(150, 60))).toBeCloseTo(10, 0);
    expect(index.distanceM("Ανύπαρκτη", at(0, 0))).toBeNull();
  });
});

// --- cache -------------------------------------------------------------------------------

describe("CachedSource", () => {
  const meta = createCitySources().lifts.meta;
  function build(fetchImpl: () => Promise<string[]>, now: { t: number }) {
    const adapter: SourceAdapter<string> = { meta, ttlMs: 1000, timeoutMs: 100, fetch: fetchImpl };
    const src = new CachedSource(adapter, { fetch: fetch, now: () => new Date(now.t), retryDelayMs: 0 });
    return src;
  }

  it("serves from memory within the lifetime, and shares concurrent calls", async () => {
    const now = { t: 0 };
    let calls = 0;
    const src = build(async () => (calls++, ["a"]), now);
    const [x, y] = await Promise.all([src.get(), src.get()]);
    expect(x.records).toEqual(["a"]);
    expect(y.records).toEqual(["a"]);
    now.t = 500;
    await src.get();
    expect(calls).toBe(1);
    now.t = 1500;
    await src.get();
    expect(calls).toBe(2);
  });

  it("serves the last good copy marked stale when the source stops answering, and backs off", async () => {
    const now = { t: 0 };
    let fail = false;
    let calls = 0;
    const src = build(async () => {
      calls++;
      if (fail) throw new SourceError("timeout", "GET example.test/x", "no answer");
      return ["good"];
    }, now);
    await src.get();
    fail = true;
    now.t = 2000;
    const s = await src.get();
    expect(s).toMatchObject({ records: ["good"], stale: true, problem: "GET example.test/x failed: timeout: no answer" });
    expect(src.status()).toMatchObject({ ok: false, records: 1 });
    now.t = 5000;
    await src.get();
    expect(calls).toBe(2); // not asked again within 15 s of the failure
    now.t = 70_000;
    fail = false;
    expect((await src.get()).stale).toBe(false);
  });

  it("does not make the caller wait for a slow source, and the refresh still lands", async () => {
    const now = { t: 0 };
    let release: (v: string[]) => void = () => undefined;
    let slow = false;
    const src = build(() => (slow ? new Promise<string[]>((r) => (release = r)) : Promise.resolve(["old"])), now);
    await src.get();
    slow = true;
    now.t = 5000;
    const waited = await src.get(undefined, 10);
    expect(waited).toMatchObject({ records: ["old"], stale: true });
    expect(waited.problem).toContain("still loading");
    release(["new"]);
    await new Promise((r) => setTimeout(r, 5));
    expect((await src.get()).records).toEqual(["new"]);
  });

  it("never throws, even on the first failure", async () => {
    const src = build(async () => {
      throw new Error("boom");
    }, { t: 0 });
    const s = await src.get();
    expect(s).toMatchObject({ records: [], fetchedAt: null, stale: false });
    expect(s.problem).toContain("boom");
  });
});

// --- adapters against the fake fetch ----------------------------------------------------

describe("adapters", () => {
  it("OASA: asks for the nearest stops with latitude first, orders arrivals, tolerates an empty answer", async () => {
    const { world, city } = cityWorld();
    const stops = await city.stops.get({ lng: LNG, lat: LAT });
    expect(stops.records.map((s) => s.code)).toEqual([100, 200]);
    const arr = await city.arrivals.get(100);
    expect(arr.records.map((a) => a.minutes)).toEqual([2, 9]);
    expect((await city.arrivals.get(200)).records).toEqual([]);
    expect(world.calls.filter((c) => c.includes("getClosestStops"))).toHaveLength(1);
  });

  it("OASA: a changed shape is an error that names the endpoint", async () => {
    const world: World = { down: new Set(), calls: [], now: new Date() };
    const city = createCitySources({ fetch: (async () => new Response(JSON.stringify({ error: "x" }), { status: 200 })) as typeof fetch, now: () => world.now, retryDelayMs: 0 });
    const s = await city.arrivals.get(1);
    expect(s.problem).toContain("telematics.oasa.gr/api/?act=getStopArrivals failed: bad_response");
  });

  it("Accessible Routes: loads the files that exist and skips steps without coordinates", async () => {
    const { city } = cityWorld();
    const s = await city.notes.get();
    expect(s.records).toHaveLength(1);
    expect(s.records[0]).toMatchObject({ routeId: "r1", order: 1, text: "Προχωράμε ευθεία.", coordinatesOf: "point_of_interest", poi: { title: "Σημείο" } });
  });

  it("Accessible Routes: no file present is reported, not thrown", async () => {
    const { city } = cityWorld({ routes: false });
    const s = await city.notes.get();
    expect(s.records).toEqual([]);
    expect(s.problem).toContain("not_present");
  });
});

// --- the endpoints --------------------------------------------------------------------------

function appWith(city: CitySources, now: () => Date) {
  const graph = testGraph();
  graph.edges = graph.edges.map((e) => (e.id === "AB" ? { ...e, name: "Ερμού" } : e.id === "BC" ? { ...e, name: "Αιόλου" } : e));
  const sandboxFetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname.replace("/sandbox", "");
    const send = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/v1/sandbox") return send({ rate_limit_per_minute: 100, llm: { enabled: true, calls_left_today: 990 } });
    if (path === "/v1/projects.geojson") return send({ type: "FeatureCollection", features: [] });
    if (path === "/v1/requests") return send({ total: 0, page: 1, size: 100, items: [] });
    if (path === "/v1/pois") return send({ total: 0, page: 1, size: 20, items: [] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new SandboxClient({ baseUrl: "https://sandbox.test/sandbox", apiKey: "k", fetch: sandboxFetch });
  const { app } = createApp({ client, routing: new FallbackRouting(graph), edges: testEdges(), graphLoaded: true, citySources: city, now });
  return app;
}
const get = async (app: { request: (p: string) => Response | Promise<Response> }, path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Json };
};

describe("GET /api/sources", () => {
  it("lists every source with owner, terms, permission, counts and whether it answers", async () => {
    const { city, world } = cityWorld();
    const app = appWith(city, () => world.now);
    const { body } = await get(app, "/api/sources");
    const byId = Object.fromEntries((body["sources"] as Json[]).map((s) => [s["id"], s]));
    expect(Object.keys(byId).sort()).toEqual(["accessible-routes", "athens-announcements", "athens-gis", "athens-trees", "ion-sandbox", "moh-duty-hospitals", "oasa-telematics", "openstreetmap", "stasy-lifts"]);
    expect(byId["stasy-lifts"]).toMatchObject({ owner: expect.stringContaining("ΣΤΑΣΥ"), permission: "pending", data: "real", answering: true, records: 2 });
    expect(byId["athens-gis"]).toMatchObject({ permission: "open licence", answering: true, records: 7 });
    expect(byId["oasa-telematics"]).toMatchObject({ permission: "pending", terms: expect.stringContaining("προσωπική χρήση"), answering: true });
    expect(byId["ion-sandbox"]).toMatchObject({ data: "test", answering: true });
    expect(byId["openstreetmap"]).toMatchObject({ permission: "open licence", answering: true, records: testGraph().edges.length });
    expect(byId["accessible-routes"]).toMatchObject({ records: 1, answering: true });
    for (const s of Object.values(byId) as Json[]) {
      expect(s).toMatchObject({ name: expect.any(String), owner: expect.any(String), terms: expect.any(String), request: expect.any(String), kind: expect.stringMatching(/^(live|daily|static)$/) });
    }
    expect(body["counts"]).toMatchObject({ total: 9, testData: 1 });
  });

  it("lists Walkable Athens only when routing says its enrichment is loaded", () => {
    const base = { sandbox: { configured: true, reachable: true }, graph: { loaded: true, edges: 3, builtAt: "2026-11-21T00:00:00Z" } };
    expect(ownRows({ ...base, routing: { engine: "core" } }).map((r) => r.id)).toEqual(["ion-sandbox", "openstreetmap"]);
    const rows = ownRows({ ...base, routing: { engine: "core", enrichment: { loaded: true, records: 12 } } });
    expect(rows.at(-1)).toMatchObject({ id: "walkable-athens", permission: "pending", records: 12, answering: true });
  });

  it("marks a source that stops answering, keeps its last copy, and leaves the others alone", async () => {
    const { city, world } = cityWorld();
    const app = appWith(city, () => world.now);
    await get(app, "/api/sources");
    world.now = new Date(world.now.getTime() + 10 * 60_000); // past the 5 minute lifetime of the lifts
    world.down.add("www.stasy.gr");
    const { status, body } = await get(app, "/api/sources");
    expect(status).toBe(200);
    const byId = Object.fromEntries((body["sources"] as Json[]).map((s) => [s["id"], s]));
    expect(byId["stasy-lifts"]).toMatchObject({ answering: false, stale: true, records: 2 });
    expect(byId["stasy-lifts"].problem).toContain("www.stasy.gr/elevators/ failed: network");
    expect(byId["athens-gis"].answering).toBe(true);
  });

  it("without city sources every source is listed as not answering and the server still works", async () => {
    const graph = testGraph();
    const client = new SandboxClient({ baseUrl: "https://sandbox.test/sandbox", apiKey: "k", fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch });
    const { app } = createApp({ client, routing: new FallbackRouting(graph), edges: testEdges(), graphLoaded: true });
    const { status, body } = await get(app, "/api/sources");
    expect(status).toBe(200);
    expect((body["sources"] as Json[]).find((s) => s["id"] === "athens-gis")).toMatchObject({ answering: false });
  });
});

describe("GET /api/context", () => {
  const q = (extra = "") => `/api/context?lng=${LNG}&lat=${LAT}${extra}`;

  it("gathers what is around a point, each item with its source", async () => {
    const { city, world } = cityWorld();
    const { status, body } = await get(appWith(city, () => world.now), q("&radius=300"));
    expect(status).toBe(200);
    expect(body["notes"]).toEqual([expect.objectContaining({ source: "accessible-routes", text: "Προχωράμε ευθεία.", step: 1, coordinatesOf: "point_of_interest" })]);
    expect(body["busStops"]).toHaveLength(1); // the far stop is outside the radius
    expect(body["busStops"][0]).toMatchObject({ source: "oasa-telematics", code: 100, arrivals: [{ minutes: 2, lineId: null }, { minutes: 9, lineId: "035", lineDescr: "ΔΟΚΙΜΗ - ΤΕΛΟΣ" }] });
    expect(body["metroStations"]).toHaveLength(1); // the tram stop is not a metro station
    expect(body["metroStations"][0]).toMatchObject({ source: "athens-gis", name: "ΜΟΝΑΣΤΗΡΑΚΙ", lifts: { source: "stasy-lifts", known: true, total: 4, working: 3, outOfService: ["Προς Πειραιά"] } });
    expect(body["hospitals"][0]).toMatchObject({ source: "athens-gis", name: "ΔΟΚΙΜΑΣΤΙΚΟ ΝΟΣΟΚΟΜΕΙΟ", onDutyToday: null, dutyList: { source: "moh-duty-hospitals", date: "2026-11-21", pdfUrl: expect.stringContaining("fdl=11") } });
    expect(body["disabledParking"]).toHaveLength(1);
    expect(body["places"].map((p: Json) => p["category"]).sort()).toEqual(["drinking_fountain", "kep", "municipal_clinic"]);
    expect(body["treePlantings"]).toEqual([expect.objectContaining({ source: "athens-trees", description: "ΟΔΟΣ 1", date: null })]);
    expect(body["announcements"]).toHaveLength(1);
    expect(body["announcements"][0]).toMatchObject({ source: "athens-announcements", id: 1, link: "https://example.test/p/1", hint: true, closesStreet: false });
    expect(body["announcements"][0].streetsNear.map((s: Json) => s["name"])).toEqual(["Ερμού", "Αιόλου"]);
    expect(Object.keys(body["sources"]).sort()).toEqual(["accessible-routes", "athens-announcements", "athens-gis", "athens-trees", "moh-duty-hospitals", "oasa-telematics", "stasy-lifts"]);
    expect(JSON.stringify(body["announcements"])).not.toContain("Κλειστή η οδός"); // the text itself is not republished
  });

  it("an announcement whose streets are far away is left out, and an old one too", async () => {
    const { city, world } = cityWorld();
    const { body } = await get(appWith(city, () => world.now), `/api/context?lng=${LNG}&lat=${LAT + 0.02}&radius=300`);
    expect(body["announcements"]).toEqual([]);
  });

  it("one source down leaves the others in the answer", async () => {
    const { city, world } = cityWorld();
    world.down.add("telematics.oasa.gr");
    world.down.add("gis.cityofathens.gr");
    const { status, body } = await get(appWith(city, () => world.now), q("&radius=300"));
    expect(status).toBe(200);
    expect(body["busStops"]).toEqual([]);
    expect(body["metroStations"]).toEqual([]);
    expect(body["notes"]).toHaveLength(1);
    expect(body["treePlantings"]).toHaveLength(1);
    expect(body["sources"]["oasa-telematics"]).toMatchObject({ ok: false });
    expect(body["sources"]["athens-gis"]).toMatchObject({ ok: false });
    expect(body["sources"]["athens-trees"]).toMatchObject({ ok: true });
  });

  it("validates the point and the radius, and clamps the radius", async () => {
    const { city, world } = cityWorld();
    const app = appWith(city, () => world.now);
    expect((await get(app, "/api/context?lat=37.9")).status).toBe(400);
    expect((await get(app, "/api/context?lng=abc&lat=37.9")).status).toBe(400);
    expect((await get(app, q("&radius=-5"))).status).toBe(400);
    expect((await get(app, q("&radius=99999"))).body["radiusM"]).toBe(1000);
    expect((await get(app, q())).body["radiusM"]).toBe(200);
  });
});

describe("GET /api/places and /api/announcements", () => {
  it("adds GIS places marked with their source and leaves the sandbox fields as they were", async () => {
    const { city, world } = cityWorld();
    const { body } = await get(appWith(city, () => world.now), `/api/places?q=${encodeURIComponent("ΚΕΠ")}&lat=${LAT}&lng=${LNG}`);
    expect(body["sandbox"]).toBe(true);
    expect(body["places"]).toEqual([
      { id: "gis:kep:kep.1", name: "Δοκιμαστικό ΚΕΠ", category: "kep", categoryName: "ΚΕΠ", lng: LNG, lat: LAT, address: "Οδός 1, Τ.Κ. 100 00", distanceM: 0, openNow: null, wheelchairAccessible: null, source: "athens-gis", sandbox: false },
    ]);
  });

  it("lists the recent announcements with matched streets as hints", async () => {
    const { city, world } = cityWorld();
    const { body } = await get(appWith(city, () => world.now), "/api/announcements");
    expect(body["announcements"].map((a: Json) => a["id"])).toEqual([1, 3]);
    expect(body["announcements"][0]).toMatchObject({ matchedStreets: ["Ερμού", "Αιόλου"], closesStreet: false });
  });
});
