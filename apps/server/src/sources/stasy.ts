/** Metro lifts, read from the server-rendered page of STASY. */
import { SourceError, fetchText } from "./http.ts";
import { decodeHtml, fold, htmlText } from "./text.ts";
import type { SourceAdapter, SourceMeta } from "./types.ts";

export const STASY_URL = "https://www.stasy.gr/elevators/";

export const STASY_META: SourceMeta = {
  id: "stasy-lifts",
  name: "ΣΤΑΣΥ: λειτουργικότητα ανελκυστήρων",
  owner: "ΣΤΑΣΥ Μονοπρόσωπη Α.Ε. (stasy.gr)",
  gives: "Which metro station lifts work and which are out of service",
  kind: "live",
  data: "real",
  terms: "Δεν βρέθηκαν όροι χρήσης στη σελίδα.",
  termsUrl: STASY_URL,
  termsQuoted: false,
  permission: "pending",
  request: `GET ${STASY_URL} (HTML, parsed)`,
};

export interface MetroLift {
  name: string;
  working: boolean;
}

export interface MetroStationLifts {
  station: string;
  /** Metro lines on whose page the station is listed. */
  lines: string[];
  lifts: MetroLift[];
  /** Names of the lifts that are out of service. */
  outOfService: string[];
}

/** Reads the page. Throws when it finds no station at all, which means the layout changed. */
export function parseStasyElevators(html: string): MetroStationLifts[] {
  const lineNames = new Map<string, string>();
  for (const m of html.matchAll(/<button data-line="(line\d+)"[^>]*>([\s\S]*?)<\/button>/g)) lineNames.set(m[1]!, htmlText(m[2]!));

  const byStation = new Map<string, MetroStationLifts>();
  const blocks = html.split(/<div class="jw_line_content[^"]*"\s+id="/).slice(1);
  for (const block of blocks) {
    const lineId = /^(line\d+)"/.exec(block)?.[1] ?? "";
    const line = lineNames.get(lineId) ?? lineId;
    const stations = block.split(/<li class="jw_line_station\b/).slice(1);
    for (const chunk of stations) {
      const name = /class="jw_station__name">([\s\S]*?)<\/span>/.exec(chunk)?.[1];
      if (!name) continue;
      const station = htmlText(name);
      const entry = byStation.get(station) ?? { station, lines: [], lifts: [], outOfService: [] };
      if (!entry.lines.includes(line)) entry.lines.push(line);
      // A station on several lines is listed on each page with the same lifts: take them once.
      // Within one list the same label can belong to two lifts, so those are all kept.
      const earlier = new Set(entry.lifts.map((l) => l.name));
      for (const m of chunk.matchAll(/<li class='jw_elevatorStatus(Ok|Error)'>([\s\S]*?)<span/g)) {
        const lift = decodeHtml(m[2]!).replace(/\s+/g, " ").trim() || "Ανελκυστήρας χωρίς όνομα";
        if (earlier.has(lift)) continue;
        const working = m[1] === "Ok";
        entry.lifts.push({ name: lift, working });
        if (!working) entry.outOfService.push(lift);
      }
      byStation.set(station, entry);
    }
  }
  if (byStation.size === 0) throw new SourceError("bad_response", "GET www.stasy.gr/elevators/", "no station found on the page; the layout may have changed");
  return [...byStation.values()];
}

export const stasyAdapter: SourceAdapter<MetroStationLifts> = {
  meta: STASY_META,
  ttlMs: 5 * 60_000,
  timeoutMs: 8000,
  async fetch(_q, env) {
    return parseStasyElevators(await fetchText(env, STASY_URL, "GET www.stasy.gr/elevators/", "text/html"));
  },
};

/** Looks a station up by name, ignoring case and accents. "Ταύρος – Ελ. Βενιζέλος" matches "ΤΑΥΡΟΣ". */
export function findStation(stations: readonly MetroStationLifts[], gisName: string): MetroStationLifts | null {
  const want = fold(gisName);
  if (!want) return null;
  return stations.find((s) => fold(s.station) === want) ?? stations.find((s) => fold(s.station).startsWith(`${want} `)) ?? null;
}
