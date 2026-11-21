import { expect, it } from "vitest";
import { GraphBuilder } from "./testing/fixtures.ts";
import { buildGraphIndex, edgeCost, findRoute, PROFILES, routeFacts } from "./index.ts";

it("selects three different paths on the same graph and keeps default voice costs", () => {
  const b = new GraphBuilder().node("A",0,0).node("B",100,0);
  b.edge("A","B",{id:"stairs",kind:"steps",lengthM:100});
  b.edge("A","B",{id:"tactile",tactilePaving:"yes",lengthM:110});
  b.edge("A","B",{id:"smooth",lengthM:105});
  const index=buildGraphIndex(b.build());
  const paths = [undefined,PROFILES.voice.cost,PROFILES.wheels.cost,PROFILES.quiet.cost].map(cost=>{
    const result=findRoute(index,"A","B",{cost});
    return result.ok && result.route.edges;
  });
  expect(paths).toEqual([["tactile"],["tactile"],["smooth"],["stairs"]]);
});
it("prices a busy observation only on quiet walks and only during its validity window", () => {
  const graph=new GraphBuilder().node("A",0,0).node("B",100,0).edge("A","B").build();
  const edge=graph.edges[0]!;
  edge.crowd={level:"busy",observedAt:"2026-11-21T11:00:00Z",expiresAt:"2026-11-21T12:00:00Z",source:"citizen_mission"};
  for (const p of Object.values(PROFILES)) {
    const cost=edgeCost(edge,[],"2026-11-21T11:10:00Z",p.cost);
    const expired=edgeCost(edge,[],edge.crowd.expiresAt,p.cost);
    expect(cost>expired).toBe(p.id==="quiet");
  }
  const at=new Date("2026-11-21T11:10:00Z");
  const index=buildGraphIndex(graph),result=findRoute(index,"A","B",{atTime:at});
  expect(result.ok && routeFacts(result.route,index.edges,at).busyM).toBe(100);
});
