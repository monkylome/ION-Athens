import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LngLat, ProfileId } from "@ion/core";
import { contentTokens, matchName } from "../destination/text.ts";
import { distanceM } from "../geo.ts";
import type { Mission, Observation } from "../missions/missions.ts";

export interface Place {
  id: string; name: string; nameEn?: string | null; kind: string; lng: number; lat: number;
  address?: string; parentId?: string; entrance?: string; nearestNodeId: string; nearestNodeDistanceM: number;
  venueTags?: Record<string,string>; source: string;
}

export const places: Place[] = JSON.parse(readFileSync(new URL("../../../../data/places.json",import.meta.url),"utf8"));
const publicKinds = ["community_centre","theatre","cinema","library","arts_centre","concert_hall","events_venue","museum"];
export const venues = places.filter(p => publicKinds.includes(p.kind));
export const centres = places.filter(p => ["suburb","neighbourhood"].includes(p.kind));
const entrances = places.filter(p => p.kind === "building_entrance" && !["emergency","service","exit"].includes(p.entrance ?? "") &&
  !["private","no"].includes(p.venueTags?.access ?? ""));
const questions = [
  ["wheelchair","Είναι ο χώρος προσβάσιμος με αμαξίδιο;"],
  ["step_count","Έχει αυτή η είσοδος πρόσβαση χωρίς σκαλιά;"],
  ["elevator","Έχει ανελκυστήρα για το κοινό;"],
  ["toilets:wheelchair","Έχει τουαλέτα για αμαξίδιο;"],
  ["wheelchair:places","Έχει θέσεις για αμαξίδιο στην αίθουσα;"],
  ["guide_dog","Δέχεται σκύλο-οδηγό;"],
  ["tactile_paving","Έχει οδηγό όδευσης ως την είσοδο;"],
] as const;
export const point = (p: Place): LngLat => [p.lng,p.lat];
export const doors = (v: Place) => entrances.filter(e => e.parentId === v.id);
export function area(at: LngLat) {
  let name = "Άγνωστη περιοχή", min = Infinity;
  for (const p of centres) {
    const d = distanceM(at,point(p));
    if (d < min) { min = d; name = p.name; }
  }
  return name;
}
function definitions(v: Place) {
  return questions.flatMap(([key,question]) => {
    const mapped = doors(v);
    const targets = key === "step_count" && mapped.length ? mapped : [v];
    return targets.map(target => {
      const token = createHash("sha256").update(target.id + "|" + key).digest("hex").slice(0,24);
      return {key,question,target,id:"venue_check:"+token,raw:target.venueTags?.[key]};
    });
  });
}
export function venueMissions(): Mission[] {
  return venues.flatMap(v => definitions(v).filter(f => !f.raw || f.raw === "unknown").map(f => ({
    id:f.id, type:"venue_check", venueId:v.id, key:f.key, entranceId:f.target.parentId ? f.target.id : null,
    // OSM way 217627849 extends 107.2 m from its centroid. Allow 12 m for the phone fix.
    ...(f.target.id === "community_centre-x-w217627849" ? {venueReachM:120} : {}),
    question:f.question, where:f.target.name, position:point(f.target), edgeIds:[], points:15, answers:{yes:0,no:0}
  })));
}
export function facts(v: Place, obs: Observation[]) {
  return definitions(v).map(f => {
    const answer = obs.find(o => o.missionId === f.id);
    return {key:f.key, question:f.question, entranceId:f.target.parentId ? f.target.id : null,
      value:answer?.value ?? (f.raw === "unknown" ? null : f.raw ?? null), source:answer ? "citizens" : f.raw && f.raw !== "unknown" ? "openstreetmap" : "unknown",
      confirmedAt:answer?.confirmedAt ?? null};
  });
}
export function entrance(v: Place, profile: ProfileId, obs: Observation[]) {
  const values = facts(v,obs);
  const score = (p: Place) => {
    const step = values.find(f => f.key === "step_count" && f.entranceId === p.id);
    const free = step?.source === "citizens" ? step.value === "yes" : step?.value === "0";
    return (profile === "wheels" && free ? 4 : 0) + (profile === "wheels" && p.venueTags?.wheelchair === "yes" ? 2 : 0) + Number(p.entrance === "main");
  };
  return doors(v).sort((a,b) => score(b)-score(a) || a.nearestNodeDistanceM-b.nearestNodeDistanceM)[0];
}
export function matchVenue(text: string) {
  const tokens = contentTokens(text);
  const olympia = venues.find(v => v.venueTags?.wikidata === "Q106695288");
  if (tokens.length === 1 && tokens[0] === "θεατρο") return olympia;
  if (!tokens.length) return undefined;
  return venues.map(v => {
    const scores = [v.name,v.nameEn,v.venueTags?.operator].filter((x): x is string => !!x).map(name => matchName(tokens,name));
    return {v,score:Math.max(...scores.map(s => s.coverage === 1 && s.exact > 0 ? s.exact + s.nameShare : 0))};
  }).filter(s => s.score > 0).sort((a,b) => b.score-a.score)[0]?.v;
}
