# ION Athens server

The server sits between the ION screens and the City of Athens **AthensGov Sandbox** API. It turns the sandbox's citizen reports and municipal projects into routing obstacles, understands a spoken destination, computes routes around obstacles, and pushes live changes to the screens.

The API key stays on the server. The browser talks only to `/api/*` and never sees the sandbox or the key.

Everything that comes from the sandbox is test data. Every obstacle carries `synthetic: true` and the responses that carry sandbox data say `"sandbox": true`.

## Run

From the workspace root (Node 22):

```sh
npm run server                              # tsx watch, reloads on change
npm run start --workspace @ion/server       # without watch
npx vitest run apps/server                  # 89 tests, no network
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
| `POST /api/demo/obstacle` | Body as in `/api/reports`. Creates the report and upvotes it twice, so it is a full block at once. 201, same shape as `/api/reports`. |
| `POST /api/demo/resolve/:id` | Sets the report to `resolved`; the obstacle disappears and `obstacle_removed` is sent. Works only for reports this key created (otherwise 403 `sandbox_forbidden`). |
| `POST /api/demo/reset` | `POST /v1/sandbox/reset`: removes everything this key created (reports, conversations, bookings). Answers `{ "sandbox": true, "demo": true, "reset": true, "obstacles": 2 }`. |

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
| 2 or more upvotes | `full`, confidence 0.85 |
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
src/testing/fixtures.ts      a 6-node street grid for tests
```
