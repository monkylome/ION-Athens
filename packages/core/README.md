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

    cost = (length x kindFactor x tactileFactor + stepsPenalty + crossingPenalty) x obstacleFactor

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
`describeObstacleRemoved`, `roundTo5`.

## Addition to `types.ts`

`Route.startOffsetM?: number`, set only on a route that starts part-way along
its first edge (a `turn_back` route). Nothing was renamed or removed.

## Left out on purpose

- Snapping a GPS position to the route. Progress along the route is an input.
- Routing from an arbitrary point on an edge, except for the turn-back case.
- A spatial index. `nearestNode` and `nearestEdge` are linear scans, fine for a
  city-centre graph and a demo, not for a hot loop.
- Turning back when an obstacle is removed. `checkObstacleRemoved` only looks at junctions ahead.
- Time-dependent costs, kerbs, slopes, surface quality, width and `wheelchair`.
- Marked versus unmarked crossings: `marked` is carried through but not priced.
- Final wording, speech, and any language other than Greek.
- Reading the clock. Time is always an argument.
