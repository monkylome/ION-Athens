# @ion/enrich-graph

Joins the City of Athens pavement survey to the ION pedestrian graph.

OpenStreetMap knows little about pavements in central Athens. The City's own
survey ("Walkable Athens", City of Athens with the NTUA Sustainable Mobility
Unit, surveyed in 2022 from street panoramas) records, for every side of every
city block, whether a pavement exists, its width and condition, tactile
guidance for the blind and the obstacles on it, and for every junction leg the
zebra markings and kerb ramps. This tool matches those records to graph edges
by geometry and writes one file the routing engine can lay over the graph.

```
npm run build   --workspace @ion/enrich-graph   # match, write the file, print coverage
npm run measure --workspace @ion/enrich-graph   # print the distance distributions the thresholds come from; writes nothing
npm run routes  --workspace @ion/enrich-graph   # two demo routes before and after
```

| | Path |
| --- | --- |
| Reads | `data/athens-centre.graph.json`, `data-local/walkable-athens/centre_{audit_lines,crossings,ramps}.geojson` |
| Writes | `data-local/athens-centre.enrichment.json` (type `GraphEnrichment` in `@ion/core`) |

Options: `--graph`, `--survey`, `--out`.

## The data must stay local

The survey carries "© NTUA, 2023. All rights reserved" and no licence.
`data-local/` is ignored by git on purpose. The input and the enrichment file
are never committed, and nothing from the survey is written into the graph
file: `applyEnrichment` in `@ion/core` applies the file in memory when the
server starts. This README and the tests contain no survey records; the test
features are invented. Ask the City and NTUA before any use beyond the demo.

## How matching works

The survey has no street names and no OpenStreetMap ids. Geometry is all there
is, so the rules are strict and an edge without a good match stays without
survey data.

**Block sides to edges.** Edges of kind `shared_road`, `pedestrian`, `sidewalk`
and `footway` of 10 m or more are sampled every 4 m. At each sample the tool
takes the nearest block side on the left and the nearest on the right, counting
a side only when

1. it lies beside the sample, not past its own end (1 m of slack),
2. it runs the same way as the edge, within 20 degrees, and
3. no other street axis lies between the sample and the side. A side behind
   another `shared_road` or `pedestrian` edge belongs to that street: the far
   carriageway of an avenue, a service road, the next street over. Nothing
   further away on that hand is taken in its place.

A side is accepted for an edge when it lies beside at least 60% of the samples
(a block side counts once it covers 25% of them), its mean distance is within
the limit for the kind, and the confidence is 0.5 or more.

- A street axis (`shared_road`, `pedestrian`) keeps both sides as `left` and
  `right`, relative to the direction of the edge from `from` to `to`, and
  records the `better` one: the side with the lower length factor under the
  default cost model. When only one side matched and it has no pavement, no
  better side is recorded and routing treats the street as unknown, because
  "no pavement" on one side says nothing about the other.
- A mapped pavement (`sidewalk`) takes the nearer side only.
- A `footway` takes one side, or both when it is an alley between two blocks.
- `steps` and `path` edges are not matched. Crossing edges are matched to
  crossing lines.

When two block sides share an edge the values are merged cautiously: the
narrowest width, the worst condition, every obstacle kind, tactile guidance
`whole` only if both have it, and a value either of them lacks is dropped.

**Crossings.** A crossing edge takes the survey crossing line whose middle is
within 8 m of its own and that runs the same way within 30 degrees. If a second
line within 2 m more says something different, the match is dropped as
ambiguous. A crossing node that is not an end of a crossing edge (a pavement
crossing a street at one node) takes a line that passes within 6 m and runs
across the street there. **Ramps** go to the end node of a crossing edge
within 5 m; a node takes its nearest ramp.

**Confidence**, 0 to 1, kept with every match next to the survey feature ids
and the distance. For a side: `coverage x (1 - 0.3 x distance/limit) x (1 - 0.2
x angle/20)`. For a crossing: `(1 - 0.5 x distance/limit) x (1 - 0.2 x
angle/30)`. For a ramp: `1 - 0.5 x distance/limit`.

## Thresholds, and what was measured

Defaults are in `src/thresholds.ts`. `npm run measure` matches with wide limits
(30 m, 45 degrees) and prints what the choices below rest on (graph built
2026-11-21):

| Threshold | Value | Measured |
| --- | --- | --- |
| `roadSideMaxDistanceM` | 13 | street axis to block side: median 5.5 m, p90 10.7, p95 12.8, then a thin tail to 30 m. The survey line is the block edge, so the distance is half the carriageway plus the pavement: streets with wide pavements, Athinas among them, sit at 10 to 12.5 m and a limit of 10 would drop exactly those |
| `pavementSideMaxDistanceM` | 8 | mapped pavement to its block side: median 3.4 m, p90 6.1, and almost nothing between 10 and 30 m |
| `footwaySideMaxDistanceM` | 6 | two populations: footpaths along a block (0 to 6 m) and paths through squares and parks (10 m and more), which are not pavements |
| `sideMaxAngleDeg` | 20 | candidate sides of streets differ from the edge by under 1 degree at the median and under 9 at p95 |
| `minCoverage` | 0.6 | below this the side belongs to a neighbouring block more than to this edge |
| `crossingMaxDistanceM` | 8 | middle to middle: median 6.3 m with no clear gap. The survey draws one line per junction leg, OpenStreetMap draws the crossing where it is painted, so they are a few metres apart along the same leg. The crossing of the opposite leg is further than a street width away |
| `nodeCrossingMaxDistanceM` | 6 | median 5.0 m, p90 8.7 |
| `rampMaxDistanceM` | 5 | ramps are at kerbs, crossing ends in the graph are often on the pavement line; median 10 m, so few ramps match |

The earlier reverse-engineering notes suggested about 12 m and 20 degrees for
sides and 8 m for crossings. The measurements agree, with the limit split by
edge kind and the street-in-between rule added. That rule matters more than
the distance limit: it removed 958 of 6,888 candidate matches, most of them
block sides on the far side of another carriageway.

## Coverage (graph built 2026-11-21)

| Kind | Edges with pavement data | Length with pavement data |
| --- | --- | --- |
| `shared_road` | 2,004 of 2,981 (67%) | 99.7 of 116.3 km (86%) |
| `pedestrian` | 694 of 1,166 (60%) | 32.1 of 41.7 km (77%) |
| `sidewalk` | 418 of 719 (58%) | 23.7 of 29.0 km (82%) |
| `footway` | 100 of 2,118 (5%) | 3.0 of 52.8 km (6%) |
| `steps`, `path` | not matched | |
| all walkable, without crossings | 3,216 of 7,505 (43%) | 158.5 of 252.0 km (63%) |

- 1,477 streets have both sides. 26 streets matched one side without pavement
  and stay unknown for routing.
- Of 5,930 edge sides that had any block side beside them under the wide
  limits, 5,194 were accepted and 736 (12.4%) rejected as doubtful, most of
  them because the side lay beside too little of the edge.
- Accepted side matches: distance median 4.4 m, p90 8.4 m, max 12.9 m;
  confidence median 0.75, p10 0.60.
- 3,908 of the 4,801 block sides in the box are used.
- Crossing edges with survey data: 175 of 334 (52%). No line near enough for
  154, 1 ambiguous, 4 below the confidence floor.
- Crossing nodes off crossing edges: 114 of 213. End nodes with a ramp: 84.

Short edges matter here: 536 `shared_road` edges are under 10 m and are not
matched at all, and others sit inside junctions with no block beside them,
which is why 67% of the edges carry 86% of the length.

## Checks against OpenStreetMap

There is no ground truth. Three tags that OpenStreetMap holds independently
give a partial check of the matching:

| OpenStreetMap says | Survey says, on the matched feature | Survey base rate in the box |
| --- | --- | --- |
| the edge is a mapped pavement (418 matched) | a pavement exists: 418 of 418 | 96% |
| `tactile_paving=yes` (266 sides) | tactile guidance on the whole length or part: 219 (82%) | 20% |
| crossing is marked (95 edges) | zebra markings, clear or worn: 88 (93%) | 12% of lines, 16% of lines with data |

The second and third rows could not come out this way from random matches.
They also show the residue: between one match in fourteen (crossings) and one
in six (tactile guidance) disagrees with OpenStreetMap, from a wrong match, a change since 2022, or an error in either
source. These tags are too rare to measure the error of the pavement width and
condition values, which nothing else describes.

## Survey codes

Read (value 0 or null is "no data" and becomes a missing field, never "none"):

| Code | Becomes |
| --- | --- |
| `A_271` pavement exists, fixed or varying width | `pavement`, `pavementWidthVaries` |
| `A_272` width class | `pavementWidth`: `narrow` (to about 1 m), `medium` (1 to 2 m), `wide` |
| `A_273` condition | `pavementCondition`: `poor`, `medium`, `good` |
| `A_29` tactile guidance | `tactileGuidance`: `none`, `whole`, `part` |
| `A_2101`, `A_2105`, `A_2106`, `A_2107`, `A_2109`, `A_2110`, `A_2112`, `A_2113`, `A_21014` | `fixedObstacles`: `kiosk`, `tree_row`, `street_furniture`, `surface_defect`, `pole_or_bollard`, `utility_cabinet`, `transit_stop`, `building_protrusion`, `level_change` |
| `B_21` zebra | `markings`: `none`, `clear`, `worn` |
| `B_22` ramps at the ends | `ramps`: `none`, `one_end`, `both_ends` |
| `B_23`, `B_24` ramp condition and room to manoeuvre | `condition`, `manoeuvringSpace` |

When `A_271`, `A_272` and `A_273` contradict each other about whether a
pavement exists, the side gets no pavement, width or condition.

Left out, and why (the list is also written into the file as
`meta.omittedCodes`):

- `A_21015`: an obstacle flag set on 39% of sides with no label anywhere.
- `Εμπόδ`: an aggregate obstacle flag with no definition and dirty values.
- `A_219`: defined twice in the app with two meanings.
- `No_Data`, `G_26`: meaning not found.
- `A_2104` shop stalls, `A_2108` cafe tables, `A_2111` private objects: their
  meaning is known, but they move. An observation from 2022 says nothing
  about today, so they are not presented as fixed obstacles.
- `A_273 = 4` and `B_23 = 2` (works in progress in 2022): the works are over,
  so the condition is left unknown.
- `Category = 4` (footbridges).
- Not used at all: bollards and railings as a share of the length (`A_212`),
  trees, land use, the street-axis layer, bus stops and the 50 m indicator
  grid. Poles, bollards and railings that narrow the pavement are covered by
  `A_2109`.

## Limits

- The survey is from 2022. Pavements have been rebuilt since, and others have
  decayed. Every value carries `survey.year`.
- Matching is by geometry and cannot be checked street by street. A wrong
  match tells a blind person a pavement is good when it is not. The rules lean
  towards no data, and the cost model ignores matches below
  `surveyMinConfidence`, which can be raised.
- A class is not a measurement: "wide" is "over about 2 m" judged from a
  panorama, and an obstacle flag means "at least one on this side", not where.
- One value describes a whole block side. A narrow point halfway along is
  invisible unless it produced an obstacle flag.
- For a street the engine uses the better side and announces which side
  tactile guidance is on, but the route does not include crossing over to it.
- On wide pedestrian streets "left" and "right" are the block faces, which may
  be 10 m from where a person walks.
- The enrichment is tied to one build of the graph (`meta.graphBuiltAt` and a
  length check per edge). Rebuild the graph, then run this tool again.
- Only the centre box is covered: W 23.715, S 37.965, E 23.740, N 37.990.
