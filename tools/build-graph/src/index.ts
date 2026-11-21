/**
 * Builds the ION Athens pedestrian graph from OpenStreetMap.
 *
 *   tsx src/index.ts [--bbox west,south,east,north] [--name athens-centre]
 *                    [--offline] [--source auto|osm-api|overpass] [--tile degrees]
 *                    [--timeout seconds] [--out-dir path]
 *
 * Online: downloads the area in tiles from the main OpenStreetMap API (source
 * "osm-api"). With --source auto (the default) the Overpass API is tried only
 * if that fails. The raw download is saved under <out-dir>/raw/.
 * Offline: reads the saved download and uses no network.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { edgesInSites, findSites } from "./areas.ts";
import { buildGraph, SOURCE_OSM_API, SOURCE_OVERPASS } from "./graph.ts";
import { clipToBbox, fetchOsmApi, OSM_API, readTiles, type TileInfo } from "./osmapi.ts";
import { buildQuery, fetchOverpass, indexElements, USER_AGENT, type Bbox, type OverpassResponse } from "./overpass.ts";
import { buildPlaces } from "./places.ts";
import { buildReport } from "./report.ts";
import { validateGraph } from "./validate.ts";

const DEFAULT_BBOX: Bbox = [23.700, 37.965, 23.74, 37.99];

interface Args {
  bbox?: Bbox;
  name: string;
  offline: boolean;
  timeoutS: number;
  outDir: string;
  source: "auto" | "osm-api" | "overpass";
  tileDeg: number;
}

function parseArgs(argv: string[]): Args {
  const here = dirname(fileURLToPath(import.meta.url));
  const args: Args = { name: "athens-centre", offline: false, timeoutS: 60, source: "auto", tileDeg: 0.006, outDir: resolve(here, "../../../data") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    const flag = arg.split("=")[0];
    if (flag === "--offline") args.offline = true;
    else if (flag === "--bbox") {
      const parts = value().split(",").map(Number);
      if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) throw new Error("--bbox needs west,south,east,north");
      const [w, s, e, n] = parts as [number, number, number, number];
      if (!(w < e && s < n && w >= -180 && e <= 180 && s >= -90 && n <= 90)) throw new Error("--bbox is not a valid west,south,east,north box");
      args.bbox = [w, s, e, n];
    } else if (flag === "--name") {
      args.name = value();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(args.name)) throw new Error("--name may contain a-z, 0-9 and -");
    } else if (flag === "--timeout") args.timeoutS = Number(value());
    else if (flag === "--tile") {
      args.tileDeg = Number(value());
      if (!(args.tileDeg >= 0.001 && args.tileDeg <= 0.05)) throw new Error("--tile must be between 0.001 and 0.05 degrees");
    } else if (flag === "--source") {
      const v = value();
      if (v !== "auto" && v !== "osm-api" && v !== "overpass") throw new Error("--source must be auto, osm-api or overpass");
      args.source = v;
    }
    else if (flag === "--out-dir") args.outDir = resolve(value());
    else if (flag === "--help" || flag === "-h") {
      console.log("Usage: tsx src/index.ts [--bbox west,south,east,north] [--name athens-centre] [--offline] [--source auto|osm-api|overpass] [--tile degrees] [--timeout seconds] [--out-dir path]");
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

interface RawMeta {
  source: "osm-api" | "overpass";
  bbox: Bbox;
  endpoint: string;
  fetchedAt: string;
  /** Date of the OSM data. The OSM API serves live data; Overpass states its own replication time. */
  osmBaseTimestamp: string | null;
  userAgent: string;
  attempts: string[];
  tiles?: TileInfo[];
  query?: string;
}

const kb = (path: string) => `${(statSync(path).size / 1024).toFixed(0)} kB`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawDir = resolve(args.outDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const rawMetaPath = resolve(rawDir, `${args.name}.meta.json`);
  const tilesDir = resolve(rawDir, `${args.name}.osmapi`);
  const overpassPath = resolve(rawDir, `${args.name}.overpass.json`);
  const log = (m: string) => console.log(m);

  let response: OverpassResponse;
  let rawMeta: RawMeta;
  if (args.offline) {
    if (!existsSync(rawMetaPath)) throw new Error(`--offline needs ${rawMetaPath}. Run once without --offline.`);
    rawMeta = JSON.parse(readFileSync(rawMetaPath, "utf8")) as RawMeta;
    if (args.bbox && args.bbox.join() !== rawMeta.bbox.join()) {
      throw new Error(`--offline: the saved download covers bbox ${rawMeta.bbox.join()}, not ${args.bbox.join()}`);
    }
    response = rawMeta.source === "osm-api" ? readTiles(tilesDir, rawMeta.tiles ?? []) : (JSON.parse(readFileSync(overpassPath, "utf8")) as OverpassResponse);
    console.log(`Offline: read the saved ${rawMeta.source} download of ${rawMeta.fetchedAt} from ${rawDir}`);
  } else {
    const bbox = args.bbox ?? DEFAULT_BBOX;
    const attempts: string[] = [];
    let fetched: RawMeta | undefined;
    let fetchedResponse: OverpassResponse | undefined;
    if (args.source !== "overpass") {
      try {
        console.log(`OpenStreetMap API: ${OSM_API}`);
        const result = await fetchOsmApi(bbox, tilesDir, { tileDeg: args.tileDeg, timeoutMs: args.timeoutS * 1000, pauseMs: 1500, log });
        const fetchedAt = new Date().toISOString();
        attempts.push(...result.attempts);
        fetchedResponse = { elements: result.elements };
        fetched = { source: "osm-api", bbox, endpoint: OSM_API, fetchedAt, osmBaseTimestamp: fetchedAt, userAgent: USER_AGENT, attempts, tiles: result.tiles };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        attempts.push(`OpenStreetMap API failed: ${message.split("\n").slice(-1)[0]!.trim()}`);
      }
    }
    if (!fetched && args.source !== "osm-api") {
      try {
        const query = buildQuery(bbox, Math.max(30, Math.round(args.timeoutS * 0.9)));
        const result = await fetchOverpass(query, args.timeoutS * 1000, undefined, log);
        attempts.push(...result.attempts);
        fetchedResponse = result.response;
        writeFileSync(overpassPath, JSON.stringify(result.response));
        fetched = {
          source: "overpass",
          bbox,
          endpoint: result.endpoint,
          fetchedAt: new Date().toISOString(),
          osmBaseTimestamp: result.response.osm3s?.timestamp_osm_base ?? null,
          userAgent: USER_AGENT,
          attempts,
          query,
        };
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
      }
    }
    if (!fetched || !fetchedResponse) {
      console.error("No download succeeded. Nothing was written.");
      if (existsSync(rawMetaPath)) console.error("A saved download exists: run again with --offline to build from it.");
      process.exit(2);
    }
    response = fetchedResponse;
    rawMeta = fetched;
    writeFileSync(rawMetaPath, JSON.stringify(rawMeta, null, 2) + "\n");
    console.log(`Saved the raw ${rawMeta.source} download under ${rawDir}`);
  }

  const builtAt = new Date().toISOString();
  const osm = indexElements(response);
  const sites = findSites(osm); // needs the full outlines, so before clipping
  clipToBbox(osm, rawMeta.bbox);
  const source = rawMeta.source === "osm-api" ? SOURCE_OSM_API : SOURCE_OVERPASS;
  const { graph, extras, stats } = buildGraph(osm, rawMeta.bbox, builtAt, source);

  extras.archaeologicalSites = edgesInSites(sites, graph);
  const problems = validateGraph(graph);
  if (problems.length > 0) {
    console.error("The built graph does not match the contract:");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }

  const places = buildPlaces(osm, graph, extras, rawMeta.bbox);

  const graphPath = resolve(args.outDir, `${args.name}.graph.json`);
  const extrasPath = resolve(args.outDir, `${args.name}.extras.json`);
  const suffix = args.name === "athens-centre" ? "" : `.${args.name}`;
  const placesPath = resolve(args.outDir, `places${suffix}.json`);
  const reportPath = resolve(args.outDir, `graph-report${suffix}.md`);
  writeFileSync(graphPath, JSON.stringify(graph));
  writeFileSync(extrasPath, JSON.stringify(extras));
  writeFileSync(placesPath, JSON.stringify(places, null, 1) + "\n");

  const findingsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../findings.md");
  const findings = suffix === "" && existsSync(findingsPath) ? readFileSync(findingsPath, "utf8") : undefined;
  const report = buildReport({
    graph,
    extras,
    stats,
    places,
    rawMeta: { ...rawMeta, offline: args.offline },
    files: [
      { label: `${args.name}.graph.json`, bytes: statSync(graphPath).size },
      { label: `${args.name}.extras.json`, bytes: statSync(extrasPath).size },
      { label: `places${suffix}.json`, bytes: statSync(placesPath).size },
      rawMeta.source === "osm-api"
        ? { label: `raw/${args.name}.osmapi/ (${rawMeta.tiles?.length ?? 0} gzipped tiles)`, bytes: (rawMeta.tiles ?? []).reduce((sum, t) => sum + statSync(resolve(tilesDir, t.file)).size, 0) }
        : { label: `raw/${args.name}.overpass.json`, bytes: statSync(overpassPath).size },
    ],
    findings,
  });
  writeFileSync(reportPath, report);

  console.log(`Graph:  ${graphPath} (${kb(graphPath)}): ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  console.log(`        dropped outside the largest component: ${stats.dropped.edges} edges, ${stats.dropped.lengthM} m in ${stats.dropped.components} components`);
  console.log(`Extras: ${extrasPath} (${kb(extrasPath)})`);
  console.log(`Places: ${placesPath} (${kb(placesPath)}): ${places.length} places`);
  console.log(`Report: ${reportPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
