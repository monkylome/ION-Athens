/** What is around a point, from every city source. Each section fails on its own. */
import type { LngLat } from "@ion/core";
import { distanceM } from "../geo.ts";
import { athensDate } from "./hospitals.ts";
import type { CitySources } from "./registry.ts";
import type { StreetIndex } from "./streets.ts";
import { findStation } from "./stasy.ts";
import type { GisPlace } from "./gis.ts";
import type { Snapshot } from "./types.ts";

export interface ContextQuery {
  lng: number;
  lat: number;
  radiusM: number;
}

export const DEFAULT_RADIUS_M = 200;
export const MAX_RADIUS_M = 1000;
const MAX_STOPS = 5;
const ANNOUNCEMENT_DAYS = 120;
/** A voice answer cannot wait for a slow source: after this the older copy, or nothing, is used. */
const WAIT_MS = 4000;

const ids = {
  notes: "accessible-routes",
  oasa: "oasa-telematics",
  lifts: "stasy-lifts",
  gis: "athens-gis",
  duty: "moh-duty-hospitals",
  announcements: "athens-announcements",
  trees: "athens-trees",
} as const;

interface Seen {
  ok: boolean;
  fetchedAt: string | null;
  stale: boolean;
  problem: string | null;
}

const near = <T extends { lng: number; lat: number }>(items: readonly T[], p: LngLat, radiusM: number): Array<T & { distanceM: number }> =>
  items
    .map((i) => ({ ...i, distanceM: Math.round(distanceM(p, [i.lng, i.lat])) }))
    .filter((i) => i.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);

export async function buildContext(city: CitySources, streets: StreetIndex, q: ContextQuery, now: Date) {
  const p: LngLat = [q.lng, q.lat];
  const seen: Record<string, Seen> = {};
  const note = (id: string, s: Snapshot<unknown>, merge = false) => {
    const was = seen[id];
    const ok = s.fetchedAt !== null && !s.stale;
    seen[id] = merge && was
      ? { ok: was.ok && ok, fetchedAt: [was.fetchedAt, s.fetchedAt].filter(Boolean).sort().at(0) ?? null, stale: was.stale || s.stale, problem: was.problem ?? s.problem }
      : { ok, fetchedAt: s.fetchedAt, stale: s.stale, problem: s.problem };
  };

  const [notes, lifts, duty, announcements, trees, stops, ...layers] = await Promise.all([
    city.notes.get(undefined, WAIT_MS),
    city.lifts.get(undefined, WAIT_MS),
    city.duty.get(undefined, WAIT_MS),
    city.announcements.get(undefined, WAIT_MS),
    city.trees.get(undefined, WAIT_MS),
    city.stops.get({ lng: q.lng, lat: q.lat }, WAIT_MS),
    ...city.gis.map((g) => g.get(undefined, WAIT_MS)),
  ]);
  note(ids.notes, notes);
  note(ids.lifts, lifts);
  note(ids.duty, duty);
  note(ids.announcements, announcements);
  note(ids.trees, trees);
  note(ids.oasa, stops);
  layers.forEach((l) => note(ids.gis, l, true));

  const places = layers.flatMap((l) => l.records);
  const byCategory = (category: string): GisPlace[] => places.filter((x) => x.category === category);

  // Notes from Accessible Routes: the Greek text, for the voice to offer.
  const noteItems = near(notes.records, p, q.radiusM).map((n) => ({
    source: ids.notes,
    routeId: n.routeId,
    routeTitle: n.routeTitle,
    step: n.order,
    title: n.title,
    text: n.text,
    lng: n.lng,
    lat: n.lat,
    distanceM: n.distanceM,
    coordinatesOf: n.coordinatesOf,
    poi: n.poi,
    sourceUrl: n.sourceUrl,
  }));

  // Bus and trolley stops with the next arrivals.
  const closest = near(stops.records, p, q.radiusM).slice(0, MAX_STOPS);
  const busStops = await Promise.all(
    closest.map(async (s) => {
      const [arr, lines] = await Promise.all([city.arrivals.get(s.code, WAIT_MS), city.stopRoutes.get(s.code, WAIT_MS)]);
      note(ids.oasa, arr, true);
      const byRoute = new Map(lines.records.map((r) => [r.routeCode, r]));
      return {
        source: ids.oasa,
        code: s.code,
        name: s.name,
        street: s.street,
        lng: s.lng,
        lat: s.lat,
        distanceM: s.distanceM,
        arrivals: arr.records.slice(0, 5).map((a) => {
          const line = byRoute.get(a.routeCode);
          return { minutes: a.minutes, lineId: line?.lineId ?? null, lineDescr: line?.lineDescr ?? null, routeCode: a.routeCode };
        }),
        arrivalsFetchedAt: arr.fetchedAt,
        arrivalsStale: arr.stale,
        ...(arr.fetchedAt === null ? { arrivalsProblem: arr.problem } : {}),
      };
    }),
  );

  // Metro stations with the lifts that are out of service.
  const metro = near(byCategory("metro_station"), p, q.radiusM).map((s) => {
    const st = lifts.fetchedAt ? findStation(lifts.records, s.name) : null;
    return {
      source: ids.gis,
      id: s.id,
      name: s.name,
      lng: s.lng,
      lat: s.lat,
      distanceM: s.distanceM,
      lifts: st
        ? { source: ids.lifts, known: true, total: st.lifts.length, working: st.lifts.filter((l) => l.working).length, outOfService: st.outOfService, fetchedAt: lifts.fetchedAt, stale: lifts.stale }
        : { source: ids.lifts, known: false, reason: lifts.fetchedAt ? "station_not_found_on_the_page" : "source_not_answering" },
    };
  });

  // Hospitals; whether they are on duty is not read from the ministry's file.
  const today = athensDate(now);
  const todays = duty.records.find((d) => d.date === today) ?? null;
  const hospitals = near(byCategory("hospital"), p, q.radiusM).map((h) => ({
    source: ids.gis,
    id: h.id,
    name: h.name,
    address: h.address,
    lng: h.lng,
    lat: h.lat,
    distanceM: h.distanceM,
    onDutyToday: null as boolean | null,
    dutyList: todays ? { source: ids.duty, date: todays.date, title: todays.title, pdfUrl: todays.pdfUrl, docUrl: todays.docUrl } : null,
  }));

  const asPlace = (x: GisPlace & { distanceM: number }) => ({ source: ids.gis, id: x.id, name: x.name, category: x.category, categoryName: x.categoryName, address: x.address, lng: x.lng, lat: x.lat, distanceM: x.distanceM });
  const disabledParking = near(byCategory("disabled_parking"), p, q.radiusM).map(asPlace);
  const otherPlaces = near([...byCategory("kep"), ...byCategory("municipal_clinic"), ...byCategory("drinking_fountain")], p, q.radiusM).map(asPlace);

  // Announcements: only as hints, and only when a named street is within the radius.
  const recent = announcements.records.filter((a) => now.getTime() - Date.parse(a.date) <= ANNOUNCEMENT_DAYS * 86_400_000);
  const announcementItems = recent
    .map((a) => {
      const matched = streets.match(`${a.title} ${a.text}`);
      const streetsNear = matched
        .map((name) => ({ name, distanceM: streets.distanceM(name, p) }))
        .filter((s): s is { name: string; distanceM: number } => s.distanceM !== null && s.distanceM <= q.radiusM)
        .map((s) => ({ name: s.name, distanceM: Math.round(s.distanceM) }))
        .sort((x, y) => x.distanceM - y.distanceM);
      return { source: ids.announcements, id: a.id, title: a.title, date: a.date, link: a.link, matchedStreets: matched, streetsNear, hint: true as const, closesStreet: false as const, note: "Ενδεικτικό: το κείμενο δεν έχει συντεταγμένες. Δεν σημαίνει ότι ο δρόμος είναι κλειστός." };
    })
    .filter((a) => a.streetsNear.length > 0);

  const treeItems = near(trees.records, p, q.radiusM)
    .slice(0, 30)
    .map((t) => ({ source: ids.trees, id: t.id, description: t.description, lng: t.lng, lat: t.lat, distanceM: t.distanceM, date: null }));

  return {
    point: { lng: q.lng, lat: q.lat },
    radiusM: q.radiusM,
    generatedAt: now.toISOString(),
    notes: noteItems,
    busStops,
    metroStations: metro,
    hospitals,
    disabledParking,
    announcements: announcementItems,
    treePlantings: treeItems,
    places: otherPlaces,
    sources: seen,
  };
}
