# ION Athens server

The server sits between the ION screens and the City of Athens **AthensGov Sandbox** API. It turns the sandbox's citizen reports and municipal projects into routing obstacles, understands a spoken destination, computes routes around obstacles, and pushes live changes to the screens.

The API key stays on the server. The browser talks only to `/api/*` and never sees the sandbox or the key.

Everything that comes from the sandbox is test data. Every obstacle carries `synthetic: true` and the responses that carry sandbox data say `"sandbox": true`.

## Run

From the workspace root (Node 22):

```sh
npm run server                              # tsx watch, reloads on change
npm run start --workspace @ion/server       # without watch
npx vitest run apps/server                  # no network
npm run typecheck --workspace @ion/server
```

Both scripts load `ION-Athens/.env`. The server listens on `http://localhost:8787`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SANDBOX` | none | Sandbox base URL. Required. |
| `SANDBOX_KEY` | none | Sandbox API key. Required. Sent only as `X-API-Key` to the sandbox. |
| `PORT` | `8787` | |
| `ION_GRAPH_PATH` | `data/athens-centre.graph.json` | The walking graph. Loaded only if the file exists. |
| `ION_POLL_MS` | `5000` | Sandbox polling interval while a screen listens to `/api/events`. Minimum 2000. |
| `ION_REPORT_TTL_HOURS` | `12` | How long a report stays an obstacle. |
| `ION_CORS_ORIGINS` | none | Extra allowed origins, comma separated. `localhost` on any port is always allowed. |
| `ION_LLM` | on | `off`: never spend language-model messages on destinations. |
| `ION_DEMO` | on | `off`: `/api/demo/*` answers 403. |

Without the graph file the server still starts: `/api/health` says `graph.loaded: false`, `/api/obstacles` returns no obstacles (each report is listed under `skipped` with `no_edge_nearby`), and `/api/route` answers 503 `graph_not_loaded`. Destinations, places and reports work without a graph.

## Plugging in the real routing engine

**Change one file: `src/routing/index.ts`.** `createRouting(graph)` is the only place that chooses the implementation. Replace its body with an adapter that implements `RoutingPort` (`src/routing/port.ts`) on top of `@ion/core`, with `engine: "core"`:

```ts
interface RoutingPort {
  readonly engine: "fallback" | "core";
  readonly graph: PedestrianGraph;
  nearestEdge(point: LngLat, maxDistanceM?: number): EdgeMatch | null;   // { edgeId, distanceM, point }
  route(from: LngLat, to: LngLat, obstacles: readonly Obstacle[], now: Date): Route | null;
}
```

Until then `src/routing/fallback.ts` answers: Dijkstra on edge length, where a `full` obstacle with confidence of 0.5 or more closes its edge and any other active obstacle adds cost. It starts and ends at the nearer end node of the nearest edge, and its `steps` are only `depart` and `arrive`.

## Endpoints

Coordinates in requests are `{ "lng": .., "lat": .. }`. Errors are always `{ "error": { "code", "message" } }`. A sandbox failure is passed on as `sandbox_<code>` with the sandbox endpoint named, for example `POST /v1/requests/{id}/upvote`; HTTP 404, 403, 400 and 429 keep their meaning and everything else is 502.

### `GET /api/health`

```json
{
  "ok": true,
  "time": "2026-11-21T13:37:23.921Z",
  "sandbox": { "configured": true, "reachable": true, "checkedAt": "2026-11-21T13:37:16.247Z", "rateLimitRemaining": 66, "llmMessagesLeftToday": 982 },
  "graph": { "loaded": true, "nodes": 9, "edges": 9, "builtAt": "2026-11-21T13:36:11.018Z" },
  "routing": { "engine": "fallback" },
  "obstacles": { "count": 2, "stale": false, "updatedAt": "2026-11-21T13:37:23.778Z" }
}
```

The sandbox is asked at most once every 30 seconds. When it does not answer: `"reachable": false, "problem": "timeout"`.

### `GET /api/obstacles`

The current obstacles, mapped by the rules below. `skipped` lists every report and project that produced no obstacle, with the reason, so the screens can show what the city data contained and why it was left out.

```json
{
  "sandbox": true, "synthetic": true, "stale": false,
  "updatedAt": "2026-11-21T13:36:26.130Z", "graphLoaded": true,
  "counts": { "reports": 26, "projects": 40, "obstacles": 1, "skipped": 65 },
  "obstacles": [{
    "id": "sandbox:req-1002", "edgeId": "AB", "blocks": "full", "type": "sidewalk",
    "label": "Εμπόδιο στο πεζοδρόμιο, Αθηνάς",
    "source": { "kind": "sandbox_request", "ref": "req-1002" },
    "synthetic": true, "observedAt": "2026-11-21T13:36:26.000Z", "expiresAt": "2026-11-22T01:36:26.000Z",
    "confidence": 0.85, "position": [23.72706982, 37.97853619], "snapDistanceM": 4
  }],
  "skipped": [{ "ref": "req-0014", "reason": "closed" }, { "ref": "req-0012", "reason": "expired" }, { "ref": "prj-002", "reason": "not_in_progress" }]
}
```

Obstacle ids: `sandbox:<report id>` for a report, `sandbox:<project id>:<edge id>` for a project (one obstacle per covered edge). When the sandbox stops answering, the last known obstacles are still served with `"stale": true, "problem": "timeout"` (or `network`, `rate_limited`, ...).

### `GET /api/places?q=&category=&lat=&lng=`

Sandbox points of interest. All parameters are optional; with `lat` and `lng` the nearest come first. Answers are remembered for 60 seconds.

```sh
curl 'localhost:8787/api/places?q=Δημαρχείο&lat=37.9762&lng=23.7257'
```
```json
{ "sandbox": true, "stale": false, "places": [
  { "id": "poi-001", "name": "ΚΕΠ Δημαρχείου", "category": "kep", "categoryName": "ΚΕΠ", "lng": 23.726805, "lat": 37.978712,
    "address": "Αθηνάς 63, 10552 Αθήνα", "distanceM": 296, "openNow": false, "wheelchairAccessible": true }
] }
```

Note that the sandbox search is not ranked by relevance (see "What the sandbox does"). For a spoken destination use `/api/destination`.

### `POST /api/destination`

```sh
curl -X POST localhost:8787/api/destination -H 'content-type: application/json' \
  -d '{"text":"Θέλω να πάω στο Δημαρχείο","location":{"lat":37.9762,"lng":23.7257}}'
```
```json
{
  "sandbox": true, "understood": true,
  "place": { "id": "poi-008", "name": "Δημαρχείο Αθηνών", "lng": 23.727198, "lat": 37.978602, "address": "Αθηνάς 63, 10552 Αθήνα" },
  "how": "poi_search", "confidence": 0.9,
  "speech": "Βρήκα: Δημαρχείο Αθηνών, Αθηνάς 63. Απέχει περίπου 300 μέτρα σε ευθεία. Να ξεκινήσουμε;",
  "alternatives": [{ "id": "poi-001", "name": "ΚΕΠ Δημαρχείου", "lng": 23.726805, "lat": 37.978712, "address": "Αθηνάς 63, 10552 Αθήνα" }],
  "trace": [
    { "step": "assistant_rules", "intent": "faq", "category": "municipal_office", "engineUsed": "rules", "candidates": 0 },
    { "step": "poi_search", "candidates": 2 }
  ]
}
```

`how` is `assistant_rules`, `assistant_llm` or `poi_search`. `confidence` is 0.9 when every place word that was said is in the name, 0.5 to 0.8 when only some are, and 0.5 when only the kind of place was understood. `trace` shows what each sandbox call understood. `location` is optional.

Not understood (HTTP 200, with a sentence to say):

```json
{ "sandbox": true, "understood": false, "reason": "no_match",
  "speech": "Δεν βρήκα προορισμό για «θέλω ένα φαρμακείο» στα δεδομένα του Δήμου. Πείτε μου το όνομα ή το είδος του σημείου, για παράδειγμα «το πιο κοντινό ΚΕΠ».",
  "trace": [ ... ] }
```

`reason` is `no_match`, `empty` or `sandbox_unavailable`. Understood answers are remembered for 60 seconds.

### `POST /api/route`

```sh
curl -X POST localhost:8787/api/route -H 'content-type: application/json' \
  -d '{"from":{"lng":23.7265,"lat":37.9785},"to":{"lng":23.728779,"lat":37.9785}}'
```
```json
{
  "sandbox": true, "engine": "fallback", "graphLoaded": true, "obstaclesStale": false,
  "route": { "nodes": ["A","D","E","F","C"], "edges": ["AD","DE","EF","CF"], "lengthM": 400, "cost": 400, "geometry": [[23.7265,37.9785]], "steps": [] },
  "rerouted": true,
  "withoutObstacles": { "lengthM": 200, "cost": 200 },
  "obstacles": [{ "id": "sandbox:req-1002", "edgeId": "AB", "blocks": "full", "effect": "avoided", "label": "..." }]
}
```

`obstacles` holds only the obstacles that affected this route: `effect: "avoided"` lay on the route there would be without obstacles and is not on this one; `effect: "on_route"` is still on the route (a partial obstacle, or no way around). `route` is the `Route` of `@ion/core`. 404 `no_route`, 503 `graph_not_loaded`.

### `POST /api/reports`

A person says «εμπόδιο εδώ». The body has a point, a category and an optional text, and nothing about the person. `category` is one of the sandbox categories and defaults to `sidewalk`. The server writes the Greek title itself and takes the address from the street name of the nearest edge.

```sh
curl -X POST localhost:8787/api/reports -H 'content-type: application/json' \
  -d '{"lng":23.72707,"lat":37.97854,"category":"sidewalk","text":"σκαλωσιά"}'
```
```json
{
  "sandbox": true,
  "report": { "id": "req-1002", "category": "sidewalk", "title": "Εμπόδιο στο πεζοδρόμιο", "status": "submitted", "upvotes": 0, "lng": 23.72707, "lat": 37.97854, "createdAt": "2026-11-21T15:36:26+02:00" },
  "obstacle": { "id": "sandbox:req-1002", "edgeId": "AB", "blocks": "partial", "confidence": 0.6, "snapDistanceM": 4, "...": "..." }
}
```

When the report is no obstacle (too far from a street, a category that does not count), `obstacle` is `null` and `notAnObstacle` gives the reason.

### `POST /api/reports/:id/confirm`

«Το έχω δει κι εγώ»: one upvote. Same response shape. The second confirmation turns the obstacle into `"blocks": "full"`.

### `GET /api/events` (Server-Sent Events)

On connect: one `snapshot` event with the body of `GET /api/obstacles`. Then, whenever polling the sandbox shows a change:

```
event: obstacle_added
data: {"type":"obstacle_added","obstacle":{"id":"sandbox:req-1003","edgeId":"EF","blocks":"full", ...},"at":"2026-11-21T13:36:27.000Z","sandbox":true}

event: obstacle_changed
data: {"type":"obstacle_changed","obstacle":{...},"changed":["blocks","confidence"],"at":"...","sandbox":true}

event: obstacle_removed
data: {"type":"obstacle_removed","obstacle":{...the last known state...},"at":"...","sandbox":true}
```

A `ping` event every 15 quiet seconds carries `{ "at", "stale" }`. The sandbox is polled every 5 seconds only while at least one client listens (12 of the 100 calls a minute; projects are fetched again every 5 minutes). A change made through this server is announced at once, without waiting for the next poll.

```js
const events = new EventSource("http://localhost:8787/api/events");
events.addEventListener("obstacle_added", (e) => reroute(JSON.parse(e.data).obstacle));
```

### Demo control: `/api/demo/*`

The sandbox has no test data on the demo streets, so the team creates the obstacle during the presentation. These endpoints write test data to the sandbox and every response says `"sandbox": true, "demo": true`.

| Endpoint | What it does |
| --- | --- |
| `POST /api/demo/obstacle` | Body as in `/api/reports`. Creates the report and adds the one confirmation a second person would give, so it is a full block at once. 201, same shape as `/api/reports`. |
| `POST /api/demo/resolve/:id` | Sets the report to `resolved`; the obstacle disappears and `obstacle_removed` is sent. Works only for reports this key created (otherwise 403 `sandbox_forbidden`). |
| `POST /api/demo/reset` | `POST /v1/sandbox/reset`: removes everything this key created (reports, conversations, bookings). Answers `{ "sandbox": true, "demo": true, "reset": true, "obstacles": 2 }`. |

## City sources

Besides the sandbox, ION joins real sources of the City and of public bodies. The team decided to use them in the demo even where the terms restrict reuse, and to ask for permission afterwards. So every source states its owner, its terms and its permission, and `/api/sources` says "pending" plainly. Nothing from these sources is committed to the repository; `data-local/` is gitignored and the tests use hand-written data.

Code: `src/sources/`. Each adapter implements `SourceAdapter` (`types.ts`): metadata, a lifetime, a timeout and `fetch`, which returns typed records. `CachedSource` (`cache.ts`) adds the cache, one shared request for concurrent callers, a retry once on a network error or a 5xx (not after a timeout), no new attempt for 60 seconds after a failure, and a last-known-good copy that is served marked `stale` when the source stops answering. `get` never throws, so one source failing never breaks another or the server. `/api/context` waits at most 4 seconds for any source and then uses the older copy or leaves that section empty.

Without `citySources` in `createApp` (the tests) no source is reached. `src/index.ts` passes the real ones.

### `GET /api/sources`

Every source ION uses, those of other parts of the server included. It first asks each source whose cache is cold or old, so `answering` is true now (`?probe=false` skips that and reports the last attempt). Rows: `id`, `name`, `owner`, `gives`, `kind` (`live`, `daily`, `static`), `data` (`real` or `test`), `terms` and `termsQuoted` (true when `terms` is a verbatim quote), `termsUrl`, `permission` (`open licence`, `pending`, `not needed`), `request`, `lastFetched`, `records`, `answering` (null before the first attempt), `stale`, `problem`. `counts` gives totals, including `permissionPending`.

The sandbox, OpenStreetMap and Walkable Athens come from `/api/health` (called inside the server): Walkable Athens is listed only when `routing.enrichment.loaded` is true there. That field is the contract with the routing work; until routing reports it the source is not listed.

### `GET /api/context?lng=&lat=&radius=`

What is around a point, `radius` in metres (default 200, from 20 to 1000). Every item has `source` (a source id) and `distanceM`. Sections:

| Section | Source | Content |
| --- | --- | --- |
| `notes` | accessible-routes | Greek text of the step for the voice, `step`, `routeTitle`, `poi`. The coordinates are those of the step's point of interest (`coordinatesOf`), not of the step. |
| `busStops` | oasa-telematics | Up to 5 nearest stops (buses and trolleys are not told apart by the service) with `arrivals`: `minutes`, `lineId`, `lineDescr`. |
| `metroStations` | athens-gis + stasy-lifts | Metro stations (tram and rail excluded) with `lifts`: `known`, `total`, `working`, `outOfService` (names). |
| `hospitals` | athens-gis + moh-duty-hospitals | `onDutyToday` is always `null` (see below); `dutyList` links today's document. |
| `disabledParking`, `places` | athens-gis | Disabled parking places; KEP, municipal clinics, drinking fountains. |
| `announcements` | athens-announcements | Traffic announcements of the last 120 days with a matched street within the radius: title, date, link, `matchedStreets`, `streetsNear`, `hint: true`, `closesStreet: false`. The text is not republished. |
| `treePlantings` | athens-trees | Up to 30 points. The service gives no dates, so `date` is `null`. |
| `sources` | | For each source consulted: `ok`, `fetchedAt`, `stale`, `problem`. |

### `GET /api/announcements`

The recent traffic announcements (title, date, link, matched streets as hints). An announcement never closes a street on its own.

### `GET /api/places`

Unchanged for the sandbox. Places from the City's GIS layers are appended, each with `source: "athens-gis"` and `sandbox: false`, the same fields as the others (`openNow` and `wheelchairAccessible` are `null`; no layer has them), at most 10, selected by `q`, `category` or position. GIS categories: `kep`, `hospital`, `municipal_clinic`, `metro_station`, `tram_stop`, `rail_station`, `drinking_fountain`, `disabled_parking`.

### The sources

**stasy-lifts** (live, cache 5 min). `GET https://www.stasy.gr/elevators/`, server-rendered HTML; the parser reads each station and each lift with its `jw_elevatorStatusOk` or `jw_elevatorStatusError` class (a station listed on several lines is counted once). If no station is found the page layout changed and the call fails. Owner: ΣΤΑΣΥ. Terms: none found on the page. Permission: pending. Stations are matched to the GIS metro stations by name, ignoring case and accents.

**oasa-telematics** (live; stops 6 h, arrivals 20 s, lines of a stop 24 h). `GET https://telematics.oasa.gr/api/?act=getClosestStops&p1=<lat>&p2=<lng>` (the first parameter is the latitude, confirmed by experiment; it returns the 20 nearest stops and ION filters by radius), `?act=getStopArrivals&p1=<stop code>` (`route_code`, `veh_code`, `btime2` minutes), `?act=webRoutesForStop&p1=<stop code>` (to name the line of each arrival). https only (http times out). Owner: ΟΑΣΑ. Terms: "διατίθενται στο κοινό μόνο για προσωπική χρήση" (https://telematics.oasa.gr/terms.php). Permission: pending.

**accessible-routes** (static, read from files). Reads `data-local/accessible-routes/visual-impairment-historic-centre.json` and `visual-impairment-acropolis.json` if present (22 steps, 21 placed). No request while the server runs; if the files are absent the source reports `problem` and the section is empty. Owner: Δήμος Αθηναίων and This is Athens. Terms: reuse needs written consent (not a verbatim quote). Permission: pending.

**moh-duty-hospitals** (daily, cache 30 min). `GET https://www.moh.gov.gr/articles/citizen/efhmeries-nosokomeiwn/68-efhmeries-nosokomeiwn-attikhs`, which lists the daily files as `?fdl=<id>` links; today's PDF and .doc are found by the date in their names. The PDF and the .doc are not parsed: a reliable reading needs a PDF reader that is not a dependency of the server, and a hospital listed in the table is on duty only for the clinics listed under it, so a hospital name would not answer "can I go there now". `onDutyToday` stays `null` and `dutyList` links today's document. Owner: Υπουργείο Υγείας. Terms: none found. Permission: pending.

**athens-announcements** (daily, cache 30 min). `GET https://www.cityofathens.gr/wp-json/wp/v2/posts?search=κυκλοφοριακές ρυθμίσεις&per_page=20&orderby=date&order=desc&_fields=id,date,title,link,content`. The search is loose, so only posts whose title contains "κυκλοφοριακ" are kept. Street names of the walking graph (`data/athens-centre.graph.json`, edge `name`) are looked for as whole words in the title and text, after dropping "Οδός", "Λεωφόρος", "Πλατεία" and abbreviations in front of the name and ignoring accents; names under 4 letters are skipped. Prose that abbreviates ("Λ. Βασ. Σοφίας") does not match. These are hints. Terms: "απαγορεύεται ρητά η αναπαραγωγή, αναδημοσίευση, αντιγραφή … χωρίς τη ρητή προηγούμενη έγγραφη συναίνεση του Δικαιούχου" (https://www.cityofathens.gr/oroi-chrisis/). Permission: pending.

**athens-trees** (daily, cache 6 h). `GET https://athenstrees.cityofathens.gr/api/public/map-locations`, about 12,400 points, 2.5 MB. `latitude` is the X and `longitude` the Y coordinate in EPSG:3857; they are converted, and points outside Attica are dropped. The answer has no date, so "recent" cannot be told. Terms: no licence statement found. Permission: pending.

**athens-gis** (static, cache 24 h; one request per layer). `GET http://gis.cityofathens.gr/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=geonode:<layer>&outputFormat=application/json&srsName=EPSG:4326&count=2000` for `kep`, `nosokomeia`, `iatreia`, `stasy2024`, `pidakes` (only `ΕΝΕΡΓΟ`), `parking_amea`. The whole layer is read, not a bounding box; each is a few dozen features. http only. Terms: "Creative Commons Αναφορά Δημιουργού v.3.0 (CC BY 3.0 GR), Απόφαση Δημοτικού Συμβουλίου 302/2013". Permission: open licence. Credit the City of Athens when showing these places.

**ion-sandbox**, **openstreetmap**, **walkable-athens**: described by the registry only. Sandbox: test data, every record synthetic, permission not needed. OpenStreetMap: © OpenStreetMap contributors (ODbL 1.0), open licence. Walkable Athens: "(c) NTUA, 2023. All rights reserved.", pending.

## Citizen missions

People who can see fill the gaps in the map for people who cannot. A mission is one yes-or-no question about one place, answered on the spot. The rules are in `src/missions/missions.ts` and tested in `missions.test.ts`.

- **Where missions come from.** Crossings whose audible signal is untagged (`crossing_sound`), crossings whose tactile paving is untagged (`crossing_tactile`), and citizen reports that one person made and nobody confirmed yet (`obstacle_check`). On the Athens graph of 21 November 2026 that is 15 + 165 open missions.
- **When an answer counts.** When two different participants give the same answer. Then the fact is written onto the graph the router reads (`crossing.sound`, `tactilePaving`), the mission closes, and `map_updated` is sent on `/api/events`. A "yes" on an obstacle check is sent to the sandbox as «Το έχω δει κι εγώ», so two of them close the pavement and reroute.
- **Abuse.** The person must be within 60 m of the place, answers once per mission, and at most 40 times a day.
- **Privacy.** A participant is a random id made on the device. The position sent with an answer is used for the distance check and not stored.
- **Rewards.** Points unlock benefits of the sandbox's Athens Card (`GET /v1/athens-card/benefits`). Benefits from the City's own venues unlock first, because they cost the City almost nothing. The sandbox states that this programme is fictional.
- **State is in memory.** Answers, points and confirmed facts are lost when the server restarts.

| Endpoint | What it does |
| --- | --- |
| `GET /api/missions?lng=&lat=&radius=&limit=` | Open missions nearest to a point, with a summary. Without a point: the first missions. |
| `POST /api/missions/:id/answer` | Body `{ "answer": "yes" \| "no" \| "unsure", "participant": "<8-64 chars>", "lng": 0, "lat": 0 }`. Answers: points earned, the confirmation if this answer completed one, and the profile. Errors: 404 `not_found`, 409 `already_answered` or `closed`, 422 `too_far`, 429 `daily_limit`. |
| `GET /api/missions/profile?participant=` | Points, answers, confirmed answers, level and the next level. |
| `GET /api/missions/observations` | Facts confirmed so far. |
| `GET /api/rewards?participant=` | Athens Card benefits with the points each needs and whether they are unlocked. |
| `POST /api/demo/missions/:id/answer` | The same answer without being at the place, for a presentation. Body without `lng`/`lat`. |

Checked live: two answers confirmed a crossing's audible signal and changed the graph; a new report became an `obstacle_check` mission, two "yes" answers made it a full block, and the route from Monastiraki to the City Hall went from 327 m to 341 m.

## Mapping rules

One module, `src/obstacles/rules.ts`, pure and tested (`rules.test.ts`). Every number is an option in `DEFAULT_MAPPING_OPTIONS`.

**Citizen reports (points)**

| Rule | Default |
| --- | --- |
| Always an obstacle | `sidewalk`, `tree`, `garbage`, `bulky_waste`, `water_leak`, `pothole` |
| Only when title or description says the pavement, a crossing or a ramp is blocked | `abandoned_vehicle`, `other` |
| Never | `graffiti`, `noise`, `stray_animals`, `streetlight` |
| No obstacle when status is | `resolved`, `rejected` |
| Distance to the nearest walkable edge | up to 15 m accepted; 15 to 25 m accepted with confidence falling linearly to half; beyond 25 m rejected. Recorded as `snapDistanceM`. |
| One report alone | `partial`, confidence 0.6 |
| 1 or more upvotes (the reporter and one more person) | `full`, confidence 0.85 |
| Confidence under 0.5 after the distance penalty | `partial`, whatever the upvotes (the contract says such an obstacle never closes an edge) |
| Expiry | 12 hours after `created_at` |

**Municipal projects (points, lines, polygons)**

| Rule | Default |
| --- | --- |
| Counts while | status `in_progress`, category `sidewalk`, `road`, `accessibility`, `square`, `water` or `cycling` |
| Expiry | end of the planned end date, Athens time |
| Works area | 20 m around a line or polygon; a 30 m circle around a point |
| Coverage of an edge | share of samples, taken every 5 m along the edge, that fall inside the works area |
| `full` (confidence 0.8) | coverage of 60 % or more, and the edge runs along the works (within 35°, for lines), and the category takes the pavement itself: `sidewalk`, `accessibility`, `square` |
| `partial` (confidence 0.6) | any other edge with coverage of 10 % or more, or 5 m or more inside |

Road, water and cycling works never close a pavement by themselves: they make it more expensive. A side street that only crosses the works is `partial`.

Skip reasons in `skipped`: `closed`, `category_not_relevant`, `text_not_blocking`, `no_location`, `expired`, `too_far_from_edge` (with `snapDistanceM`), `no_edge_nearby`, `not_in_progress`, `no_edges_covered`.

## What the sandbox does (experiments of 21 November 2026)

All against the real sandbox, with location Monastiraki (37.9762, 23.7257).

### Understanding a destination

| Said | Assistant, `rules` | Assistant, `llm` (fresh conversation) | `/v1/nlu/parse` | `/v1/pois?q=` (place words) |
| --- | --- | --- | --- | --- |
| Θέλω να πάω στο Δημαρχείο | wrong: intent `faq`, website pages; entity `municipal_office` | right: `nearby_poi`, first card Δημαρχείο Αθηνών (2.4 s) | intent `information`, entity `municipal_office` | ΚΕΠ Δημαρχείου, **Δημαρχείο Αθηνών**, car park |
| πήγαινέ με στο πιο κοντινό ΚΕΠ | right: 3 ΚΕΠ, nearest first | right | `nearby_poi`, `kep` | |
| πού είναι το Μουσείο Ακρόπολης | right, by luck: it is the nearest museum | right, same luck | `nearby_poi`, `museum` | |
| πήγαινέ με στο Μουσείο Μπενάκη | wrong: 3 nearest museums, Μπενάκη not among them | wrong, same cards | | Ακρόπολης, Φωταερίου, **Μπενάκη**, Αρχαιολογικό |
| θέλω να πάω στην Τεχνόπολη | wrong: `book_appointment`, starts a booking flow | right intent, Τεχνόπολις is the third card | `book_appointment` | car park, gas museum, **Τεχνόπολις** |
| thelo na pao sto dimarxeio | wrong: `faq` | right: Δημαρχείο Αθηνών | | nothing |
| θέλω ένα φαρμακείο | `find_service` (social pharmacy procedures) | same | `unknown` | nothing |

What follows from this, and what the chain in `src/destination/resolve.ts` does:

1. **Assistant, `rules` engine, fresh conversation, with location.** About 60 ms. It understands "the nearest X" well. For a named place it only returns the nearest places of the category, so the server checks the cards against the words that were said and accepts a card at once only when its name contains all of them.
2. **POI text search with the place words** (the sentence without "θέλω να πάω στο", articles, "κοντινότερο"). The sandbox search matches any word in any field (name, description, tags, address) and sorts by distance, not relevance: "Μουσείο Μπενάκη" puts Μουσείο Ακρόπολης first, and "Αθηνάς 63" returns 34 places. So the server ranks by the **name**: share of spoken words in the name, exact words before inflected ones ("Δημαρχείο" beats "ΚΕΠ Δημαρχείου"), then the category the assistant understood, then distance. The search itself ignores accents and Greek case endings (Τεχνόπολη finds Τεχνόπολις); so does the ranking.
3. **Assistant, `llm` engine**, only when 1 and 2 found no place. It rescues greeklish, typos and vague wishes. It costs 1.5 to 2.5 seconds on a good call (5 seconds measured once for the whole chain) and one of 1000 messages a day; the same message again the same day is free.
4. **`/v1/nlu/parse`** only when the assistant could not be reached: it gives the category, and the nearest place of that category is offered at confidence 0.5.

Measured through `POST /api/destination`: Δημαρχείο → Δημαρχείο Αθηνών (`poi_search`, 0.19 s); κοντινό ΚΕΠ → ΚΕΠ Δημαρχείου (`assistant_rules`, 0.12 s); Μουσείο Ακρόπολης → right (`assistant_rules`, 0.12 s); Μουσείο Μπενάκη → right (`poi_search`, 0.17 s); Τεχνόπολη → Τεχνόπολις (`poi_search`, 0.28 s); Εθνικό Κήπο → right (`assistant_rules`); greeklish Δημαρχείο → right (`assistant_llm`, confidence 0.5, 5 s); φαρμακείο → not understood, with the Greek sentence.

What does not work:

- **The `rules` engine does not understand "θέλω να πάω …" / "πάμε …".** The verb sends it to `faq` or to `book_appointment`.
- **A conversation is sticky.** Once a message starts the booking flow (`state.flow: "book_appointment"`), every later message in that conversation is read as part of it, with either engine: "τι καιρό κάνει" came back as `book_appointment`. In a used conversation the `llm` engine answered `book_appointment` for sentences it understands correctly in a fresh one. So every destination gets its own conversation, deleted afterwards, and the `llm` message never follows a `rules` message that started a flow.
- **`/v1/nlu/parse` adds nothing to an assistant reply**: it is the same rules, returns the same entities, and only names the intent differently (`information` where the assistant says `faq`).
- **The sandbox has only municipal places** (70 points in 17 categories). Pharmacies, shops, metro stations, squares and street addresses are not there. "πλατεία Συντάγματος" would find only "Δωρεάν Wi-Fi – Πλατεία Συντάγματος". Destinations outside the sandbox need `data/places.json`, which this server does not read yet.
- A vague wish can be answered confidently wrong by the rules: "θέλω να διαβάσω ένα βιβλίο κάπου ήσυχα" gives a Λέσχη Φιλίας (category `friendship_club`). The server returns it with confidence 0.5 and "Το πιο σχετικό που βρήκα είναι …"; the caller should ask for confirmation below 0.8.

### Reports and projects

- `GET /v1/requests` returns `{ total, page, size, items }`; `size=100` works, so one call fetches everything. The status after "submitted" is `received` (the guide's table says "acknowledged").
- **Upvotes are not limited per key**: two upvotes from the same key count as two. That is what makes `/api/demo/obstacle` possible. The upvote response does not say when it happened.
- `PATCH` (status) and `DELETE` work only on reports the key created; on seed data the sandbox answers 403 `not_yours`. Upvoting seed data works, and `POST /v1/sandbox/reset` undoes it.
- The 25 seed reports are dated 4 September to 9 November 2026, so with the 12-hour rule **none of them is an obstacle**: live, the result was 10 `closed`, 9 `expired`, 5 not relevant by category and 1 `text_not_blocking`. Report obstacles come only from reports created now. A created report is auto-resolved by the sandbox after 30 minutes, which removes the obstacle.
- Of the 40 projects 15 are in progress, 8 of them in a category that counts; most are a single point, and the lines are coarse (5 points for a whole avenue, up to 300 m between points), so a 20 m works area will miss the parts of a real street that bend away from the straight line. With a scratch graph along Πανεπιστημίου, `prj-010` (cycling) produced two `partial` obstacles.
- Errors are `{ "error": { "code", "message" } }` with Greek and English text; validation errors are 422 with `details`. Every answer carries `X-RateLimit-Remaining`.
- A 429 was never provoked, so the handling of `429` and `Retry-After` is tested only against mocked answers.

## The sandbox client

`src/sandbox/client.ts`. Reports (list with `near`/`radiusKm`/`status`/`category`/`mine`, all pages, get, create, upvote, set status, delete), projects (`/v1/projects.geojson`), points of interest (text, category, area, near a point), assistant (open conversation, send message with location and engine `rules` or `llm`, delete conversation), `/v1/nlu/parse`, `/v1/sandbox` info and reset.

- Timeout of 8 seconds (12 for an `llm` message).
- One retry after a network error or a 5xx, only for calls that are safe to repeat. Creating a report, upvoting and sending a message are sent at most once, so a retry cannot create a second report or a second vote.
- 429: a `Retry-After` of up to 3 seconds is waited for and the call repeated once. A longer one fails at once with `rate_limited` and `retryAfterS`, and no call leaves the server until that time has passed.
- Errors are `SandboxError` with `code`, `endpoint` (method and path template, no query string), `status`. The key is never in a message: the underlying fetch error is not attached, and sandbox messages are scrubbed.
- Responses are validated with zod (`src/sandbox/schemas.ts`); a wrong shape is `bad_response` with the first failing fields.

## Files

```
src/index.ts                 entry: config, graph, client, server
src/app.ts                   the HTTP API (Hono)
src/config.ts                environment
src/geo.ts                   distances, sampling, point in polygon
src/sandbox/                 client and response schemas
src/obstacles/rules.ts       the mapping rules
src/obstacles/diff.ts        added / changed / removed
src/obstacles/service.ts     cache, polling, stale handling, events
src/destination/             spoken destination: chain and Greek word matching
src/routing/index.ts         THE file to change for the real engine; graph loading
src/routing/port.ts          RoutingPort
src/routing/fallback.ts      stand-in routing
src/routing/edge-index.ts    grid index: nearest edge, edges in an area
src/sources/                 city sources: adapters, cache, registry, context (see "City sources")
src/testing/fixtures.ts      a 6-node street grid for tests
```

## Official traffic decisions

`GET /api/decisions` lists both Diavgeia feeds, freshness, original subjects, parsed restrictions and matched graph edge IDs. The police and municipality feeds use a rolling 21-day window, independent 15-minute caches and last-known-good results. A cold or failed feed does not prevent sandbox routing. Publication licence confirmation is pending for both authorities.

Placement requires a named street and an unambiguous connected stretch between two named junctions, or an explicit whole-street restriction. Building numbers cannot be located with this graph. Placement and current validity are separate. Athens local dates, weekday lists, time ranges and overnight windows gate routing. Exceptions, extensions and multiple daily schedules need review. For one opaque subject per feed per refresh the adapter checks the detail record and, when available, extracts a review excerpt with pdftotext. A PDF excerpt alone does not activate an obstacle.

Currently applicable decisions appear in the obstacle snapshot and event stream with their ADA and publication link. Roadway restrictions add a partial cost. Explicit pedestrian prohibitions can close a segment. One pavement mission covers each uncertain decision stretch per Athens calendar day. Two independent matching answers remove the effect or close the stretch for that day, subject to the official decision remaining active. Votes and overrides live in server memory.

## Metro entrances, GIS failover and rain

The context endpoint uses station coordinates from the repository's OSM place index. Case- and accent-normalised names group duplicate station geometries and join the live STASY lift list. GIS can supply additional stations. Each station includes its Line 1 entrance locations and directions from the national open-data CSV when available. Live lift status applies to the station as a whole. An individual entrance's operating status is unknown unless separately identified. The response lists coordinate-bearing stations with no live status match in `unmatchedLiftStations`; consult source freshness when interpreting missing matches.

GIS requests start at the HTTPS Athens Maps WFS, with legacy GeoNode fallback. The primary layers checked were kep, nosokomeia, iatreia, MetroStations1-2-3, pidakes and parking_amea. Open-Meteo supplies current modelled rain and three hourly forecasts for central Athens, cached for ten minutes. Its Greek voice summary is withheld when only a stale forecast is available.

### Decision placement and presentation clock

`/api/decisions` distinguishes resolved stretches and addresses (`precise`) from low-confidence street hints (`streetOnly`). Both are included in `placed`. Hints supply a citizen mission when active and never contribute to routing cost. `inside` counts decisions with a recognisable, explicitly named street or cross street in the graph; this alone does not establish that a particular house number is inside the coverage area. Unplaced results have a reason, and unresolved intersections include their missing names. `upcomingStart` is the first supported future window starting within seven days, in UTC.

Optional one-off address enrichment uses a single operator on one machine. Save the JSON from /api/decisions and run `node --import tsx apps/server/src/sources/decision-addresses.ts <saved-json>` at the repository root. The server itself only reads the disk cache on source refresh. The command looks up distinct public decision addresses sequentially, waits at least 1.1 seconds between requests, caches positive and negative responses under data-local and stops on refusal. Do not schedule this one-off tool. A compatible provider can be selected with ION_NOMINATIM_URL. Results are attributed to OpenStreetMap contributors. [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) · [OSM attribution](https://www.openstreetmap.org/copyright)

When demo control is enabled, pass an ISO timestamp with a timezone in the `at` query parameter to /api/obstacles, /api/decisions or POST /api/route. URL-encode the plus sign of a positive offset. The response includes simulatedTime and the effective timestamp. Projection uses currently known source data; it is not a historical archive. Projected reads do not broadcast simulated changes to other clients.

## Route preferences and crowds

GET /api/profiles returns the IDs and Greek labels/descriptions. POST /api/route accepts an optional profile (voice by default) and returns facts beside the route. POST /api/routes takes the same endpoints and returns a routes array in voice, wheels, quiet order. Each entry includes profile, route, lengthM, facts, differsFromVoice and lengthDeltaM. An unavailable route has null geometry and metrics. Both endpoints use a common obstacle snapshot and support the presentation clock.

Crowd questions are available on named pedestrian streets, squares and mapped streets within 100 m of an OSM metro station. A nearby result includes up to three crowd questions. Two matching independent answers set busy or calm for one hour and emit map_updated. These observations live in memory and do not retain positions. Placed event decisions contribute a separate busy signal only during a supported validity window; crowdSources identifies the ADA, affected edge IDs and validity. Only the quiet preset adds a crowd penalty.
