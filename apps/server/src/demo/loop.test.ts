import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildGraphIndex, findRoute, rerouteForObstacle, type Obstacle } from "@ion/core";
import { MissionBoard } from "../missions/missions.ts";
import { loadGraph } from "../routing/index.ts";
import { venueMissions } from "../venues/catalogue.ts";
import { theatreLoop } from "./loop.ts";

const graphFile = fileURLToPath(new URL("../../../../data/athens-centre.graph.json",import.meta.url));
it.each([undefined, "absent-survey-for-test"])("finds a usable theatre loop for the installed graph (survey override %s)",survey => {
  const {graph} = loadGraph(graphFile,survey);
  const now = new Date("2026-11-21T15:00:00Z");
  const board = new MissionBoard(graph,{},()=>now,[],venueMissions());
  const preset = theatreLoop(graph,board.all(),[],[],now);
  expect(preset).not.toBeNull();
  expect(preset!.alternatives).toHaveLength(1);
  const index = buildGraphIndex(graph);
  for (const p of [preset!,...preset!.alternatives]) {
    const result = findRoute(index,p.start.nodeId,p.destination.nodeId,{atTime:now});
    if (!result.ok) throw Error("No route from preset start");
    expect(result.route.edges).toContain(p.obstacle.edgeId);
    expect(result.route.edges.some(e => p.crossing.edgeIds.includes(e))).toBe(true);
    expect(p.walkerProgressM).toBeCloseTo(result.route.lengthM*0.4);
    const block:Obstacle = {id:"test",type:"sidewalk",label:"demo",source:{kind:"synthetic"},synthetic:true,
      edgeId:p.obstacle.edgeId,position:p.obstacle.position,blocks:"full",observedAt:now.toISOString(),expiresAt:null,confidence:1};
    const turn = rerouteForObstacle(index,result.route,p.walkerProgressM,block,{atTime:now});
    if (turn.outcome !== "reroute") throw Error(turn.outcome);
    expect(turn.route.edges).not.toContain(block.edgeId);
    expect(turn.decisionNode).toBe(p.obstacle.decisionNode);
    expect(turn.distanceToDecisionM).toBeGreaterThan(0);
    expect(turn.extraDistanceM).toBeLessThan(120);
  }
});
