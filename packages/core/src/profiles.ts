import { DEFAULT_COST_OPTIONS, isBusy, surveyUsable, type CostOptions } from "./cost.ts";
import type { GraphEdge, Route } from "./types.ts";

export type ProfileId = "voice" | "wheels" | "quiet";
interface Preset { id: ProfileId; label: string; description: string; cost: Partial<CostOptions> }
const neutralCrossings = { crossingSignalsWithSoundM: 0, crossingSignalsNoSoundM: 0, crossingUnsignalledM: 0, crossingSignalsUnknownM: 0 };
export const PROFILES: Record<ProfileId,Preset> = {
  voice: { id:"voice", label:"Με φωνή", description:"Προτιμά όδευση αφής και διαβάσεις με ηχητικό σήμα.", cost:{} },
  wheels: { id:"wheels", label:"Με ρόδες", description:"Αποφεύγει τα σκαλιά και προτιμά φαρδιά πεζοδρόμια και διαβάσεις με ράμπες.",
    cost:{stepsPenaltyM:Infinity, crossingSignalsWithSoundM:30,crossingSignalsNoSoundM:30,crossingRampsNoneM:600,crossingRampsOneEndM:240,
      noPavementRoadFactor:12,narrowPavementFactor:5,poorPavementFactor:5,tactileGuidanceFactor:1,tactilePavingFactor:1} },
  quiet: { id:"quiet", label:"Με ησυχία", description:"Προτιμά σύντομη διαδρομή μακριά από σημεία με επιβεβαιωμένο συνωστισμό.",
    cost:{...neutralCrossings,stepsPenaltyM:0,sharedRoadFactor:1,pavedRoadFactor:1,noPavementRoadFactor:1,narrowPavementFactor:1,widePavementFactor:1,
      poorPavementFactor:1,goodPavementFactor:1,fixedObstacleFactor:1,tactileGuidanceFactor:1,tactilePavingFactor:1,
      crossingRampsNoneM:0,crossingRampsOneEndM:0,crossingRampsBothM:0,crossingMarkingsClearM:0,crossingMarkingsWornM:0,crossingMarkingsNoneM:0,busyFactor:8} },
};
export function routeFacts(route: Route, edges: ReadonlyMap<string,GraphEdge>, now: Date, eventEdges?: ReadonlySet<string>, voice?: Route | null) {
  let tactileM=0,busyM=0,noPavementM=0,stepsTaken=0;
  const withRamp=new Set(), withoutRamp=new Set(), audible=new Set(), oneRamp=new Set();
  for (const [i,id] of route.edges.entries()) {
    const edge=edges.get(id);
    if (!edge) continue;
    const length=Math.max(0,edge.lengthM-(i===0 ? route.startOffsetM ?? 0 : 0));
    const surveyed=surveyUsable(edge,DEFAULT_COST_OPTIONS);
    if (edge.tactilePaving==="yes" || (surveyed && edge.tactileGuidance==="whole")) tactileM+=length;
    if (edge.kind==="shared_road" && surveyed && edge.pavement==="no") noPavementM+=length;
    if (isBusy(edge,now,eventEdges)) busyM+=length;
    if (edge.kind==="steps") stepsTaken++;
    const crossing=edge.osmWayId ?? edge.id;
    if (edge.kind==="crossing" || edge.crossing) {
      if (edge.crossing?.sound==="yes") audible.add(crossing);
      if (surveyed && edge.crossingRamps==="both_ends") withRamp.add(crossing);
      if (surveyed && edge.crossingRamps==="one_end") oneRamp.add(crossing);
      if (surveyed && edge.crossingRamps==="none") withoutRamp.add(crossing);
    }
  }
  const used=new Set(route.edges);
  const stepsAvoided=voice?.edges.filter(id=>edges.get(id)?.kind==="steps" && !used.has(id)).length ?? 0;
  return {tactileM:Math.round(tactileM),busyM:Math.round(busyM),noPavementM:Math.round(noPavementM),stepsTaken,stepsAvoided,
    crossingsWithRamps:withRamp.size,crossingsWithOneRamp:oneRamp.size,crossingsWithoutRamps:withoutRamp.size,audibleCrossings:audible.size};
}
