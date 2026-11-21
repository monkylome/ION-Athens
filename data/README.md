# ION Athens data

Built on 2026-11-21 by `tools/build-graph` for the bounding box west 23.700, south 37.965, east 23.740, north 37.990 (central Athens).

All files here derive from OpenStreetMap. Licence: Open Database License (ODbL) 1.0. Attribution, to be shown wherever the data or a map made from it is shown: **© OpenStreetMap contributors**. The files are a derived database: if they are distributed, they stay under the ODbL.

## Files

| File | What it is | Source, licence |
| --- | --- | --- |
| `athens-centre.graph.json` | The pedestrian graph, a `PedestrianGraph` as defined in `packages/core/src/types.ts`. Coordinates rounded to 6 decimals, not pretty-printed. | OpenStreetMap, ODbL 1.0, © OpenStreetMap contributors |
| `athens-centre.extras.json` | OSM facts the contract has no field for: `ways` (tags per `osmWayId`: road class, `sidewalk*`, `tunnel`, `indoor`, `level`, `access`, `lit`, `width`, `incline`, `handrail`, raw `crossing*` values and more), `nodes` (tags per graph node: barriers, kerbs, entrances, crossing tags), `crossingNodes` (signals, sound, marked, tactile paving for each `highway=crossing` node, and whether a crossing edge passes through it), `archaeologicalSites` (edge ids inside the outline of each mapped archaeological site). | same |
| `places.json` | Named places for demo start and end points: `{ id, name, nameEn, kind, lng, lat, nearestNodeId, nearestNodeDistanceM, source, osmType, osmId, position, ... }`. Includes the Serafeio community centre (Πειραιώς 144), cultural venues, neighbourhood centres and legacy kinds such as `metro_station`, `metro_entrance`, `townhall`, `kep`, `museum`, `landmark` (Odeon of Herodes Atticus), `hospital`, `police`, `square`, `building_entrance`. | same |
| `graph-report.md` | Data quality report, measured on the graph by the build. Overwritten by every build. | measurements of the above |
| `raw/athens-centre.osmapi/tile-NNN.json.gz` | The raw download, one gzipped file per tile. Elements are kept as received (id, coordinates, node lists, members, all tags); the editing metadata (user, uid, changeset, version, timestamp) is removed. | OpenStreetMap, ODbL 1.0, © OpenStreetMap contributors |
| `raw/athens-centre.meta.json` | Where and when the raw data was downloaded, the bbox and the tile list. `--offline` reads it. | — |

## How it was built

From the workspace root:

```
npm run build --workspace @ion/build-graph                      # download, then build
npm run build:offline --workspace @ion/build-graph              # rebuild from data/raw, no network
npm run check --workspace @ion/build-graph                      # validate the graph and places against the contract
npm run build --workspace @ion/build-graph -- --bbox 23.72,37.97,23.73,37.98 --name test-area
```

Options: `--bbox west,south,east,north`, `--name` (file prefix, default `athens-centre`), `--offline`, `--source auto|osm-api|overpass`, `--tile degrees` (default 0.006), `--timeout seconds`, `--out-dir`.

1. **Download.** The primary source is the main OpenStreetMap API, `GET https://api.openstreetmap.org/api/0.6/map.json?bbox=…`. It refuses boxes with more than 50,000 nodes, so the bbox is cut into tiles of at most 0.006° (this snapshot combines 25 original tiles and 15 western tiles), fetched one at a time, 1.5 s apart, with one retry after 10 s, and merged by element id. Only the bounding box is sent, with the User-Agent `ion-athens-hackathon-graph-builder`. The Overpass API (`overpass-api.de`, then `overpass.kumi.systems`, one retry each) is kept as a fallback and is used only if the OSM API fails; on 2026-11-21 neither Overpass server could be reached from the build machine. `meta.source` in the graph says which one was used; for this build it is "OpenStreetMap via OpenStreetMap API 0.6".
2. **Selection.** Every way with a `highway` tag a pedestrian can use, plus the outlines of pedestrian multipolygons. Excluded: `foot=no|private|use_sidepath`; `access=private|no|military` unless `foot` allows walking; motorways, busways, construction, indoor corridors, platforms, elevators; cycleways without `foot=yes`. Ways are cut at the bbox edge.
3. **Kinds.** `footway=sidewalk` → `sidewalk`; `footway=crossing` → `crossing`; other `footway` → `footway`; `pedestrian` → `pedestrian`; `steps` → `steps`; `path`, `track` → `path`; every street (`living_street`, `residential`, `service`, `unclassified`, `tertiary`, `secondary`, `primary`, `trunk` and links) → `shared_road`.
4. **Splitting.** Ways are cut at every node used by two or more ways, and at nodes with a `barrier`, `entrance` or `railway=subway_entrance` tag. Each edge keeps its full geometry; `lengthM` is the haversine length of that geometry, rounded to centimetres. Ids: node `n<OSM node id>`, edge `w<OSM way id>-<part>`. The westward extension preserves the original centre’s part numbers. Where a newly connected street divides an old edge, its first section retains the previous ID and additional sections receive new IDs.
5. **Tags.** Read as written and never inferred: `crossing`, `crossing:signals`, `traffic_signals:sound`, `crossing:markings`, `tactile_paving`, `wheelchair`, `surface`, `name`, `name:el`, `name:en`. Crossing facts come from the crossing way first and from its `highway=crossing` node(s) where the way is silent. A missing tag gives `"unknown"` (crossing edges) or an absent field (other edges). `crossing=uncontrolled|marked|zebra|unmarked` gives `signals: "no"`, which is what those values mean in OSM.
6. **Connectivity.** Only the largest connected component is kept; the report states what was dropped.
7. **Places.** Read from the same download. `nearestNodeId` is the nearest graph node at street level (edges tagged underground or indoor are ignored); an entrance that is itself a graph node points to itself. A building without a mapped entrance uses the centre of its bounding box, has `entranceVerified: false`, and, if it has an `addr:street`, is snapped to the nearest node on that street within 100 m (`snappedBy: "addr:street"`). Metro entrances carry no name in OSM: they are named after the nearest station within 400 m (`station`, `stationDistanceM`).
8. **Validation.** The build stops if the graph breaks the contract: unique ids, existing end nodes, geometry end points equal to the node coordinates, positive lengths that match the geometry, no self-loops, one connected component, valid enum values.

## Limits found

- **Street centre lines.** 58.6% of the graph length is `shared_road`. On such an edge the graph does not know which side of the street the person is on, or whether a pavement exists. The contract cannot carry the road class; `extras.json` has it (`ways[osmWayId].highway`), and a router should treat a `primary` road very differently from a `living_street`.
- **Pavements are mapped in patches.** Separate pavements (30.4 km) exist around some blocks only and often do not connect to each other.
- **Crossings.** A crossing way is cut where it meets the road centre line, so one crossing is usually two `crossing` edges with the same facts. About half of the `highway=crossing` nodes have no crossing way at all; their facts are only in `extras.json`. Audible signals and tactile paving are almost never tagged: "unknown" is the normal value, not an exception.
- **Squares and other areas** (`area=yes`, multipolygons) are represented by their outline only. A route crosses Kotzia or Syntagma Square along the edge of the mapped area, not across it.
- **Archaeological sites.** OSM does not tag the paths inside fenced, ticketed sites with `access` or `fee`. The graph keeps them. `extras.json` lists the edges inside each mapped site outline, but this is incomplete: the Acropolis site is mapped as a `type=site` relation without an area, so the paths on its slopes are not flagged. The list also contains the freely accessible Western Hills (Filopappou). Opening hours are not applied anywhere.
- **Barriers** (gates, bollards, kerbs, one turnstile) are graph nodes with their tags in `extras.json`; the graph does not block them.
- **Underground and indoor ways** (metro passages, road tunnels; about 6 km) are in the graph, because they connect at real OSM nodes. The contract cannot mark them; `extras.json` has `tunnel`, `indoor`, `level`, `layer`.
- **Athens City Hall** (way 768849988, `addr:street` Αθηνάς 63) has no entrance mapped. Its position is the building centre and its node is on Athinas, not at a door.
- **KEP** are found by name (ΚΕΠ, Κέντρο Εξυπηρέτησης Πολιτών); one that is mapped without such a name is missed. Only one `amenity=hospital` lies inside the bbox.
- **`wheelchair=limited`** and tactile paving values other than yes, contrasted and no have no value in the contract and are left out of the graph; the raw value is in `extras.json`.
- **Live data.** The OSM API serves the current map, so a new download can change counts and ids. Use `--offline` for a repeatable build.
- **Not verified on the ground.** Nothing here was checked in the street. OSM in central Athens is detailed but uneven, and a tag can be out of date.
