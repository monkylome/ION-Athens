# @ion/core

The routing engine for ION Athens. Pure TypeScript, no runtime dependencies, no
clock and no I/O: every function is a deterministic function of its arguments.
Nothing in it knows a place, a route or a scene.

```ts
import { buildGraphIndex, findRoute, rerouteForObstacle } from "@ion/core";
```

Coordinates are `[lng, lat]`, distances are metres, bearings are degrees
clockwise from north, times are an ISO string, epoch milliseconds or a `Date`.

## Public functions

### Graph index and geometry (`graph.ts`, `geo.ts`)

```ts
const index = buildGraphIndex(graph);            // nodes, edges, adjacency (undirected)
nearestNode(index, [23.7348, 37.9755]);          // { node, distanceM } | null
nearestEdge(index, [23.7348, 37.9755], 50);      // { edge, distanceM, point, alongM } | null (within 50 m)
haversineM([23.73, 37.97], [23.74, 37.98]);      // metres
bearingDeg([23.73, 37.97], [23.74, 37.98]);      // 0..360
turnDirection(90, 0);                            // "left"
```

Also exported: `angleDiffDeg`, `polylineLengthM`, `pointAlongPolyline`,
`slicePolyline`, `projectOntoPolyline`, `orientedGeometry`, `nodeLngLat`.

`nearestNode` and `nearestEdge` scan the whole graph. See "Left out".

### Cost model (`cost.ts`)

```ts
edgeCost(edge, obstacles, "2026-11-22T10:00:00Z", { crossingUnsignalledM: 400 });
// metre-equivalents, Infinity when the edge is closed
isObstacleActive(obstacle, atTime);              // expiresAt is null or later than atTime
```

    cost = (length x pavementFactor x tactileFactor + stepsPenalty + crossingPenalty) x obstacleFactor

Without survey values (see "Pavement survey" below) `pavementFactor` is
`sharedRoadFactor` on a `shared_road` edge and 1 elsewhere, and `tactileFactor`
is `tactilePavingFactor` when OSM says `"yes"`.

| Option | Default | Meaning |
| --- | --- | --- |
| `stepsPenaltyM` | 80 | added to every `steps` edge |
| `sharedRoadFactor` | 2 | length multiplier for `shared_road` |
| `tactilePavingFactor` | 0.9 | length multiplier when `tactilePaving` is `"yes"` |
| `crossingSignalsWithSoundM` | 10 | signals `yes`, sound `yes` |
| `crossingSignalsNoSoundM` | 60 | signals `yes`, sound `no` or `unknown` |
| `crossingUnsignalledM` | 300 | signals `no` |
| `crossingSignalsUnknownM` | 120 | signals `unknown`: dearer than any signalled crossing, cheaper than a confirmed `no` |
| `partialObstacleFactor` | 3 | cost multiplier for a `partial` obstacle, or a `full` one below `closingConfidence` |
| `closingConfidence` | 0.5 | a `full` obstacle at or above this closes the edge |

"unknown" is treated as not confirmed: it never earns the cheaper price, and
the announcement text never reports it as absent. Unknown signals cost less
than a confirmed unsignalled crossing, because most OpenStreetMap crossings are
untagged and pricing them all at 300 would bend every route. An edge of kind
`crossing` without crossing info counts as all unknown. Several partial obstacles on one
edge apply the factor once. Defaults are in `DEFAULT_COST_OPTIONS`.

### Pavement survey (`enrichment.ts`, `cost.ts`)

```ts
const { graph, applied, edgesCovered, problem } = applyEnrichment(loadedGraph, enrichmentFile);
const index = buildGraphIndex(graph);            // route on the enriched copy
```

The City's pavement survey ("Walkable Athens", City of Athens with NTUA, 2022)
is matched to the graph by `tools/enrich-graph` and kept in a separate file
outside the repository, because the survey is not licensed for redistribution.
`applyEnrichment` lays that file over a loaded graph in memory and returns a
new graph; it never writes, and the input graph is left as it was. A file made
for another build of the graph (`meta.graphBuiltAt`) is refused whole, and an
entry whose edge has changed length is skipped.

What an edge can then carry, all optional:

| Field | Values | From |
| --- | --- | --- |
| `pavement` | `yes`, `no` | whether a pavement exists |
| `pavementWidth` | `narrow` (to about 1 m), `medium` (1 to 2 m), `wide` | width class |
| `pavementWidthVaries` | boolean | |
| `pavementCondition` | `poor`, `medium`, `good` | |
| `tactileGuidance` | `none`, `part`, `whole` | guidance for the blind along the side |
| `fixedObstacles` | list of `FixedObstacleKind` | kinds seen at least once; `[]` means none seen |
| `pavementSides` | `{ left?, right? }` | both sides of a street, relative to `from` -> `to` |
| `crossingMarkings` | `none`, `clear`, `worn` | zebra markings (crossing edges) |
| `crossingRamps` | `none`, `one_end`, `both_ends` | kerb ramps (crossing edges) |
| `survey` | `{ source, year, confidence, side?, featureIds?, distanceM? }` | where the values come from |

On a street with two surveyed sides the edge takes the values of the better
side, named in `survey.side`; both stay in `pavementSides`. Nodes can carry
`surveyedRamp` and `surveyedCrossing`. The cost model reads edges only.

How the survey changes the cost. A missing value never changes anything, and
survey values count only when `survey.confidence >= surveyMinConfidence`:

| Option | Default | Meaning and reason |
| --- | --- | --- |
| `surveyMinConfidence` | 0.5 | the floor the matching tool itself uses; raise it to trust fewer matches |
| `pavedRoadFactor` | 1.2 | `shared_road` whose survey says a pavement exists. Replaces `sharedRoadFactor` (2), which stood for "nothing is known". Not 1: the match is by geometry, the data is from 2022, and side-street crossings along a street axis are not modelled, so a pavement mapped in OSM with the same survey still wins |
| `noPavementRoadFactor` | 2.5 | `shared_road` whose survey says there is no pavement: now known to be the carriageway, so dearer than unknown |
| `narrowPavementFactor` | 1.3 | up to about 1 m: room for one person, none for a guide or a dog beside them |
| `widePavementFactor` | 0.95 | over 2 m. `medium` is 1 |
| `poorPavementFactor` | 1.25 | "serious faults that are a danger to pedestrians" in the survey's words |
| `goodPavementFactor` | 0.95 | `medium` is 1 |
| `fixedObstacleFactor` | 1.06 | per kind of fixed obstacle present. The survey records a kind once however many there are, so the price per kind is small |
| `fixedObstaclesMaxFactor` | 1.25 | ceiling for all kinds together: obstacles alone never outweigh "poor" |
| `tactileGuidanceFactor` | 0.8 | tactile guidance along the whole length. Stronger than the OSM tag (0.9) because the survey says how much of the side has it. `part` earns nothing: guidance that stops is not a guide |
| `crossingMarkingsClearM` / `WornM` / `NoneM` | -20 / -5 / +40 | zebra markings, added to the crossing penalty |
| `crossingRampsBothM` / `OneEndM` / `NoneM` | -10 / +10 / +30 | kerb ramps, added to the crossing penalty |

"medium" is the neutral class for width and condition, so an unknown value is
priced neither as the best class nor as the worst. Width, condition and
obstacles apply to `sidewalk`, `footway` and paved `shared_road` edges. On a
`pedestrian` street only tactile guidance counts, because the whole street is
walked and the pavement at its side does not describe it. The tactile bonus is
the smaller of the OSM and survey factors, never their product. Crossing
adjustments are small next to the signal penalties (10 to 300): signals and
sound matter more to a blind person than paint, and a ramp matters less than
either. The crossing penalty never goes below 0. The worst paved street
(narrow, poor, obstructed: about 2.4) costs about as much as one with no
pavement, and the best (about 1.08 before the tactile bonus) stays above a
mapped pavement with the same survey values.

### Shortest path (`route.ts`)

```ts
const result = findRoute(index, "n1", "n9", { atTime, obstacles, cost: { stepsPenaltyM: 120 } });
if (result.ok) use(result.route);                // Route: nodes, edges, lengthM, cost, geometry, steps
else say(result.reason, result.message);         // "no_route" | "unknown_node", never throws for these
```

A* with a haversine heuristic. `geometry` is stitched in walking order. `steps`
are `depart`, `turn`, `crossing`, `arrive`. A `turn` is emitted at a junction
(three or more edges) when the direction is not straight or the street name
changes, and at a bend between two edges only for a real turn (45 degrees or
more). A `crossing` step sits at the node where the crossing edge begins and
carries the crossing facts. `atTime` is required when obstacles are passed
(a `TypeError` otherwise). `avoidEdges` excludes edges outright.

Also exported: `buildRoute` (a Route from a node and edge list), `routeSpans`
(where each edge starts and ends along a route), `turnAtNode`, `searchPath`,
`createCoster`.

### Rerouting at the decision point (`reroute.ts`)

```ts
const r = rerouteForObstacle(index, route, progressM, newObstacle, {
  atTime, obstacles: alreadyKnown, minWarningDistanceM: 25,
});
switch (r.outcome) {
  case "not_relevant":   // r.reason: "inactive" | "not_on_route" | "behind_walker"
  case "keep_route":     // ahead, not closing, nothing cheaper: announce it, keep walking
  case "reroute":        // r.route (full), r.decisionNode, r.distanceToDecisionM, r.turnDirection, r.extraDistanceM, r.lateWarning
  case "turn_back":      // r.route starts at the walker, r.progressM is 0
  case "no_alternative": // closed, and no other way to the destination
}
// Every outcome has r.route and r.progressM: the route and progress to continue with.
```

The decision point is the last junction ahead of the walker and before the
blocked edge from which the destination can be reached without going back along
the edge the walker arrives by. For an obstacle that does not close its edge,
the other way must also be cheaper.

When that junction is nearer to the walker than `minWarningDistanceM`, the
outcome is still `reroute` at that junction, with `lateWarning: true`: a short
warning is better than walking a blind person back. The announcement is then
short and leads with the action ("Στρίψτε δεξιά τώρα στη γωνία. Ο δρόμος
μπροστά είναι κλειστός."). `turn_back` happens only when no junction ahead of
the walker and before the blocked edge offers another way.

A `turn_back` route starts part-way along an edge. It has `startOffsetM` set,
its first step is `depart` with direction `u_turn`, and its geometry begins at
the walker's position. If the obstacle has a `position` and lies on the
walker's own edge, that position decides whether it is ahead or behind.

```ts
const c = checkObstacleRemoved(index, route, progressM, { atTime, obstacles: remaining });
if (c.outcome === "shorter_available") use(c.route, c.decisionNode, c.turnDirection, c.savedDistanceM);
```

Offers a route only when it is at least `minSavingM` (default 10) cheaper.

### Walker simulation (`walker.ts`)

```ts
walkerAt(index, route, elapsedSeconds, { speedMps: 1.0 });
// { distanceM, remainingM, position, bearing, edgeId, edgeIndex, arrived, nextStep, distanceToNextStepM }
walkerAtDistance(index, route, 150);             // the same, by distance
```

After a `reroute`, keep the clock running and pass the new full route. After a
`turn_back`, restart elapsed time at 0 on the new route.

### Instruction data (`instructions.ts`)

```ts
let announced: string[] = [];
const out = nextAnnouncements(route, walker, announced, { reroute: { obstacle, result: r } });
announced = out.announced;                       // pass back on the next call
for (const a of out.announcements) speak(a.text); // a.type, a.key, structured fields
```

A `depart`, `turn` or `crossing` step can carry one `surveyNotice`: a fact from
the pavement survey about the stretch the step leads onto. It is spoken once,
as a second short sentence, with the first announcement of that step, and the
announcement repeats it as a structured `surveyNotice` field.

| `kind` | Sentence | When |
| --- | --- | --- |
| `crossing_no_ramp` | "Η διάβαση δεν έχει ράμπες." | the crossing has no ramp at either end |
| `no_pavement` | "Στη συνέχεια δεν υπάρχει πεζοδρόμιο." | 20 m or more of street surveyed without pavement |
| `pavement_narrows` | "Στη συνέχεια το πεζοδρόμιο στενεύει." | narrow ahead for 20 m or more, wider before |
| `pavement_narrow` | "Στη συνέχεια το πεζοδρόμιο είναι στενό." | narrow ahead, nothing known before |
| `tactile_guidance_starts` | "Στη συνέχεια υπάρχει όδευση τυφλών, στα δεξιά σας." | whole-length guidance begins, none in the 40 m before; the side is given as the person walks |

At most one per step, in that order of priority. Nothing is said for a value
that is missing or below `surveyMinConfidence`, and nothing is repeated while
the fact stays the same. A change that happens where the route has no step
(walking straight on) is not announced.

Announcement types: `depart`, `turn`, `crossing`, `arrival`, `obstacle`,
`obstacle_cleared`. Distances are rounded to 5 m. Each step gives at most two
different announcements: `phase: "ahead"` within `aheadDistanceM` (default 30)
and `phase: "now"` within `nowDistanceM` (default 5). A key is never produced
twice, and a step already passed is not announced late.

A crossing is described, for example "Διάβαση με φανάρι, χωρίς ηχητικό σήμα".
No text tells the person to cross. The Greek sentences are plain placeholders
for the voice layer, which should build its own wording from the structured
fields.

Also exported: `describeCrossing`, `describeTurn`, `describeReroute`,
`describeObstacleRemoved`, `describeSurveyNotice`, `roundTo5`.

## Additions to `types.ts`

`Route.startOffsetM?: number`, set only on a route that starts part-way along
its first edge (a `turn_back` route).

For the pavement survey, all optional: on `GraphEdge` the fields in the table
under "Pavement survey"; on `GraphNode` `surveyedRamp` and `surveyedCrossing`;
on `RouteStep` `surveyNotice`. New types: `PavementSurvey`, `SurveyedSide`,
`SurveyedCrossing`, `SurveyedRamp`, `SurveyNote`, `SurveyNotice`,
`FixedObstacleKind`, and for the enrichment file `GraphEnrichment`,
`EdgeEnrichment`, `NodeEnrichment`. Nothing was renamed or removed.

## Left out on purpose

- Snapping a GPS position to the route. Progress along the route is an input.
- Routing from an arbitrary point on an edge, except for the turn-back case.
- A spatial index. `nearestNode` and `nearestEdge` are linear scans, fine for a
  city-centre graph and a demo, not for a hot loop.
- Turning back when an obstacle is removed. `checkObstacleRemoved` only looks at junctions ahead.
- Time-dependent costs, kerbs, slopes, the OSM `surface` tag and `wheelchair`.
- The OSM `marked` flag of a crossing is carried through but not priced; the
  surveyed markings are.
- Which side of a street to walk on. A street takes the values of its better
  side and the route does not include crossing over to it.
- A cost for turns: a route may take a few more turns to stay on tactile guidance.
- Survey facts at nodes (`surveyedRamp`, `surveyedCrossing`) are carried, not priced.
- Final wording, speech, and any language other than Greek.
- Reading the clock. Time is always an argument.

## Walking preferences

The default `voice` preset preserves the original costs. `wheels` closes mapped step segments, penalises missing ramps and poor or narrow pavements, and removes the tactile and audible-signal bonuses. `quiet` uses distance and obstacle constraints with an eightfold multiplier on a stretch currently marked busy. Unknown crowd conditions leave the cost unchanged. Use the presets for the walk someone wants today.

`routeFacts` reports metres on known tactile guidance, busy stretches and surveyed shared roads without a pavement. Crossing counts distinguish ramps at both ends, one end and confirmed absence; unknowns contribute to none of those counts. Steps count mapped step segments, not individual stairs. Steps avoided are segments used by the comparison voice route but omitted on the selected route.
