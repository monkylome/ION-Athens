import {
  buildGraphIndex, findRoute, haversineM, pointAlongPolyline, polylineLengthM, projectOntoPolyline, PROFILES,
  rerouteForObstacle, type GraphIndex, type LngLat, type Obstacle, type PedestrianGraph, type Route
} from "@ion/core";
import type { RouteNote } from "../sources/accessible-routes.ts";
import type { Mission, Observation } from "../missions/missions.ts";
import { EdgeIndex } from "../routing/edge-index.ts";
import { places, point, venues, venueMissions } from "../venues/catalogue.ts";

const station = places.find(p => p.id === "metro_station-akropoli-n1957144319")!;
const pointOf = (p:{lng:number;lat:number}):LngLat => [p.lng,p.lat];
const streets = (r:Route) => [...new Set(r.steps.flatMap(s => s.onto ? [s.onto] : []))];
const same = (a:Route,b:Route) => a.edges.length === b.edges.length && a.edges.every((e,i) => e === b.edges[i]);

function detour(index: GraphIndex, spatial: EdgeIndex, route:Route, crossingEdges:string[], obstacles:Obstacle[], at:Date) {
  const progressM = route.lengthM * 0.4;
  const candidates = [];
  for (const id of route.edges) {
    const edge = index.edges.get(id)!;
    if (edge.lengthM < 5 || crossingEdges.includes(id)) continue;
    const position = pointAlongPolyline(edge.geometry,polylineLengthM(edge.geometry)/2).point;
    if (spatial.nearestEdge(position)?.edgeId !== id) continue;
    const obstacle:Obstacle = {id:"probe:"+id,edgeId:id,position,blocks:"full",type:"probe",label:"δοκιμή",
      source:{kind:"synthetic"},synthetic:true,observedAt:at.toISOString(),expiresAt:null,confidence:1};
    const turn = rerouteForObstacle(index,route,progressM,obstacle,{atTime:at,obstacles});
    if (turn.outcome !== "reroute" || turn.distanceToDecisionM < 8 || turn.extraDistanceM < 12 || turn.extraDistanceM >= 120) continue;
    if (!turn.route.edges.some(e=>crossingEdges.includes(e))) continue;
    const alternative = findRoute(index,route.nodes[0]!,route.nodes.at(-1)!,{atTime:at,obstacles:[...obstacles,obstacle]});
    if (!alternative.ok || alternative.route.edges.includes(id) || !alternative.route.edges.some(e=>crossingEdges.includes(e))) continue;
    const extra = alternative.route.lengthM - route.lengthM;
    if (extra <= 0 || extra >= 120) continue;
    const node = index.nodes.get(turn.decisionNode)!;
    candidates.push({edgeId:id,position,street:edge.name ?? null,decisionNode:node.id,decisionPosition:pointOf(node),
      distanceToDecisionM:turn.distanceToDecisionM,distanceToObstacleM:turn.distanceToObstacleM,turn:turn.turnDirection,
      walkingDetourM:turn.route.lengthM,replannedLengthM:alternative.route.lengthM,detourStreets:streets(turn.route)});
  }
  return candidates.sort((a,b)=>Math.abs(a.replannedLengthM-route.lengthM-60)-Math.abs(b.replannedLengthM-route.lengthM-60) || Math.abs(a.distanceToDecisionM-35)-Math.abs(b.distanceToDecisionM-35))[0];
}

export function theatreLoop(graph:PedestrianGraph, missions:Mission[], observed:Observation[], obstacles:Obstacle[], at:Date, preset: "olympia" | "acropolis" = "olympia", notes: readonly RouteNote[] = []) {
  const acropolis = preset === "acropolis";
  const venue = venues.find(p => p.id === (acropolis ? "landmark-odeon-of-herodes-atticus-r13249184" : "theatre-x-w780950690"))!;
  const index = buildGraphIndex(graph);
  const target = index.nodes.get(venue.nearestNodeId);
  if (!target) return null;
  const spatial = new EdgeIndex(graph);
  const crossingMissions = [...missions.filter(m=>m.type==="crossing_sound").map(m=>({id:m.id,edgeIds:m.edgeIds,position:m.position,open:true})),
    ...observed.filter(o=>o.type==="crossing_sound" && o.value==="yes").map(o=>({id:o.missionId,edgeIds:o.edgeIds,position:o.position,open:false}))];
  const crossingByEdge = new Map(crossingMissions.flatMap(m=>m.edgeIds.map(e=>[e,m] as const)));
  const stepFree = venueMissions().find(m=>m.venueId===venue.id && m.key==="step_count");
  if (!stepFree || !crossingByEdge.size) return null;
  const named = places.filter(p=>!["neighbourhood","suburb","building_entrance"].includes(p.kind) && !p.name.includes("χωρίς καταγεγραμμένη"));
  const candidates = [];
  for (const node of graph.nodes) {
    const origin = pointOf(node);
    const direct = haversineM(origin,pointOf(target));
    if (acropolis ? haversineM(origin,point(station)) > 220 : direct < 160 || direct > 525) continue;
    const baseline = findRoute(index,node.id,target.id,{atTime:at,obstacles});
    if (!baseline.ok || baseline.route.lengthM < 345 || baseline.route.lengthM > (acropolis ? 1050 : 510)) continue;
    const route = baseline.route;
    const crossing = route.edges.map(e=>crossingByEdge.get(e)).find(m=>m !== undefined);
    if (!crossing) continue;
    const obstacle = detour(index,spatial,route,crossing.edgeIds,obstacles,at);
    if (!obstacle) continue;
    const nearest = named.map(p=>({p,d:haversineM(origin,point(p))})).sort((a,b)=>a.d-b.d)[0]!;
    const street = [...new Set(index.adjacency.get(node.id)?.flatMap(a=>a.edge.name ? [a.edge.name] : []))].join(" / ");
    const profiles = (["wheels","quiet"] as const).map(profile=>{
      const result = findRoute(index,node.id,target.id,{atTime:at,obstacles,cost:PROFILES[profile].cost});
      return {profile,lengthM:result.ok ? result.route.lengthM : null,distinct:result.ok && !same(route,result.route),edges:result.ok ? result.route.edges : []};
    });
    const threeDistinct = profiles.every(p=>p.distinct) && profiles[0]!.edges.join() !== profiles[1]!.edges.join();
    const start = {nodeId:node.id,lng:node.lng,lat:node.lat,name:street || nearest.p.name,landmark:nearest.p.name,landmarkDistanceM:Math.round(nearest.d)};
    candidates.push({start,destination:{id:venue.id,name:venue.name,lng:venue.lng,lat:venue.lat,nodeId:target.id},
      crossing,venueMissionId:stepFree.id,venueMissionOpen:missions.some(m=>m.id===stepFree.id),
      obstacle,walkerProgressM:route.lengthM*0.4,lengthM:route.lengthM,directM:haversineM(origin,point(venue)),streets:streets(route),
      profiles:profiles.map(({edges,...p})=>p),threeDistinct});
  }
  candidates.sort((a, b) => {
    const crossingPriority = Number(b.crossing.open) - Number(a.crossing.open);
    if (crossingPriority) return crossingPriority;
    if (acropolis) {
      const stationDistance = haversineM(pointOf(a.start), point(station)) - haversineM(pointOf(b.start), point(station));
      if (stationDistance) return stationDistance;
    }
    return Number(b.threeDistinct) - Number(a.threeDistinct)
      || Number(b.start.name !== b.start.landmark) - Number(a.start.name !== a.start.landmark)
      || a.start.landmarkDistanceM - b.start.landmarkDistanceM;
  });
  const recommended = candidates[0];
  if (!recommended) return null;
  const second = candidates.find(c=>haversineM(pointOf(c.start),pointOf(recommended.start))>20) ?? candidates[1];
  const steps = [];
  if (acropolis && notes.length) {
    const selected = findRoute(index,recommended.start.nodeId,target.id,{atTime:at,obstacles});
    if (selected.ok) for (const note of notes) {
      if (note.routeId !== "visual-impairment-acropolis") continue;
      const position = pointOf(note);
      if (projectOntoPolyline(selected.route.geometry,position).distanceM <= 65)
        steps.push({order:note.order,position});
    }
  }
  return {preset,steps,...recommended,alternatives:second ? [second] : []};
}
