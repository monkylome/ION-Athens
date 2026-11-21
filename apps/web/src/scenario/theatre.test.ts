import { describe, expect, it } from "vitest";
import type { LngLat } from "@ion/core";
import { DEFAULT_CONFIG } from "./config";
import { ScenarioEngine } from "./engine";
import { FakeClock, FakeServer, FakeVoice, ladder, ladderPlaces } from "./testing";
import type { ApiPort } from "./ports";

async function rehearsal(live: boolean) {
  const { index } = ladder();
  const clock = new FakeClock();
  const server = new FakeServer(index, clock, 1);
  const voice = new FakeVoice();
  const places = ladderPlaces(index);
  const edge = index.edges.get("B-C")!;
  const a = index.nodes.get("B")!, b = index.nodes.get("C")!;
  const position: LngLat = [(a.lng+b.lng)/2, (a.lat+b.lat)/2];
  const loop = {
    start: {...places[0]!,nodeId:"A"}, destination:{...places[1]!,nodeId:"E"},
    walkerProgressM:50, crossing:{id:"crossing",edgeIds:["A-B"],position,open:true},
    obstacle:{edgeId:edge.id,position},
  };
  const card = { name:"Θέατρο",facts:[{ key:"step_count", entranceId:null, question:"Χωρίς σκαλιά;", value:"yes", source:"citizens" }] };
  const api: ApiPort = {
    destination: server.destination.bind(server), report:server.report.bind(server), confirm:server.confirm.bind(server),
    resolve:server.resolve.bind(server), reset:server.reset.bind(server),
    route:async () => {
      const route = engine.getState().route;
      if (!route) return server.route();
      return { ok:true, status:200, method:"POST", path:"/route", unreachable:false, data:{route,arrival:{speech:"Κείμενο του server."}} };
    },
    venue:async () => ({ok:true,status:200,method:"GET",path:"/venues/hall",unreachable:false,data:card}),
  };
  const engine: ScenarioEngine = new ScenarioEngine({index,places,api,voice,now:clock.now,wallNow:clock.wallNow},
    {...DEFAULT_CONFIG,timeScale:10,sentence:"Θέλω να πάω στο θέατρο"}, {loop,fallback:false,live});
  await engine.dispatch({type:"advance"});
  await engine.dispatch({type:"advance"});
  function run(seconds:number) {
    for (let i=0;i<seconds*20;i++) {clock.t+=50;engine.tick();}
  }
  return {engine,server,run,loop,voice,state:()=>engine.getState()};
}

describe("the theatre rehearsal",()=>{
  it("holds the walker until a live report on the selected edge is confirmed",async()=>{
    const s=await rehearsal(true);
    s.run(12);
    expect(s.state().waiting).toBe(true);
    expect(s.state().walker?.distanceM).toBeCloseTo(50);
    s.engine.serverEvent({type:"mission_answered",missionId:"another-crossing",answers:{yes:1,no:0}});
    expect(s.state().crossingNotice).toBe("");
    s.engine.serverEvent({type:"mission_answered",missionId:"crossing",answers:{yes:1,no:0}});
    expect(s.state().crossingNotice).toContain("ακούγεται");
    const [lng,lat]=s.loop.obstacle.position;
    const first=(await s.server.report({lng,lat})).data!;
    s.engine.serverEvent({type:"obstacle_added",obstacle:first.obstacle!});
    expect(s.state().change).toBeNull();
    const second=(await s.server.confirm(first.report.id)).data!;
    s.engine.serverEvent({type:"obstacle_changed",obstacle:{...second.obstacle!, id:"elsewhere",edgeId:"C-D"}});
    expect(s.state().waiting).toBe(true);
    s.engine.serverEvent({type:"obstacle_changed",obstacle:second.obstacle!});
    expect(s.state()).toMatchObject({waiting:false,phase:"rerouting",injected:false});
  });

  it("labels injected evidence, buffers early confirmation, reads the server card and closes",async()=>{
    const s=await rehearsal(false);
    await s.engine.dispatch({type:"report",at:"ahead"});
    await s.engine.dispatch({type:"confirm"});
    expect(s.state()).toMatchObject({injected:true,change:null});
    s.run(6);
    expect(s.state().change?.kind).toBe("reroute");
    s.run(65);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.state()).toMatchObject({phase:"arrived",card:{name:"Θέατρο"}});
    expect(s.voice.said.at(-1)).toBe("Κείμενο του server.");
    await s.engine.dispatch({type:"advance"});
    expect(s.state().closing).toBe(true);
    await s.engine.dispatch({type:"reset"});
    expect(s.state()).toMatchObject({phase:"idle",closing:false,card:null,injected:false});
    expect(s.server.calls.join(" ")).not.toContain("/demo/reset");
  });
});
