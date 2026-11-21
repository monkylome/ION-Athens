import type { GraphEdge, LngLat, Obstacle, PedestrianGraph } from "@ion/core";
import { z } from "zod";
import { activeUntil, localDay, parseDecision, streetKey } from "./decision-parser.ts";
import { decisionDetail } from "./decision-detail.ts";
import { pointToLine, distanceM } from "../geo.ts";
import { fetchJson } from "./http.ts";
import type { SourceAdapter } from "./types.ts";

const endpoint = "https://diavgeia.gov.gr/opendata/search.json";
const page = z.object({ info: z.object({ total: z.number() }), decisions: z.array(z.object({
  ada: z.string().min(1), subject: z.string(), issueDate: z.number(), status: z.string(),
})) });
export interface Decision { ada: string; subject: string; detailExcerpt?: string; issueDate: number; authority: string }
export function decisionAdapter(police: boolean): SourceAdapter<Decision> {
  const authority = police ? "Ελληνική Αστυνομία, Διεύθυνση Τροχαίας Αττικής" : "Δήμος Αθηναίων";
  return {
    meta: { id: police ? "diavgeia-police" : "diavgeia-city", name: police ? "Διαύγεια · Τροχαία Αττικής" : "Διαύγεια · Δήμος Αθηναίων", owner: authority,
      gives: "Δημοσιευμένες προσωρινές κυκλοφοριακές ρυθμίσεις", kind: "live", data: "real",
      terms: "licence not stated on the site, to be confirmed", termsQuoted: false, termsUrl: null, permission: "pending", request: endpoint },
    ttlMs: 900000, retryAfterFailureMs: 900000, timeoutMs: 10000,
    async fetch(_, env) {
      const now = env.now();
      const start = new Date(localDay(now)+"T12:00Z");
      start.setUTCDate(start.getUTCDate()-20);
      const size = police ? 50 : 20;
      const params = new URLSearchParams({ org: police ? "100054489" : "6013", term: police ? "Δήμου Αθηναίων" : "προσωρινών κυκλοφοριακών",
        size: String(size), sort: "recent", from_issue_date: localDay(start), to_issue_date: localDay(now) });
      if (police) params.set("unit","70926");
      const result: Decision[] = [];
      for (let index = 0; ; index++) {
        params.set("page", String(index));
        const batch = page.parse(await fetchJson(env, endpoint+"?"+params, "Diavgeia search"));
        result.push(...batch.decisions.filter(d => d.status === "PUBLISHED").map(d => ({ ...d, authority })));
        if ((index+1)*size >= batch.info.total || !batch.decisions.length) break;
      }
      const opaque = result.find(d => !parseDecision(d.subject).street);
      if (opaque) opaque.detailExcerpt = await decisionDetail(opaque.ada,env).catch(() => undefined);
      return result;
    },
  };
}

/** Find an unambiguous path along one named street between two named junctions. */
export function streetIndex(graph: PedestrianGraph) {
  const byName = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) if (edge.name) {
    const key = streetKey(edge.name);
    const list = byName.get(key) ?? [];
    list.push(edge);
    byName.set(key,list);
  }
  function named(name: string) {
    for (const part of [name,...(name.match(/\(([^)]+)\)/)?.slice(1) ?? []),name.split("(")[0]!]) {
      const key = streetKey(part);
      const expanded = ["βασιλεωσ","βασιλισσησ"].map(prefix => key.replace(/^βασ\s+/, prefix+" "));
      const matches = [...new Set([key,...expanded])].map(k=>byName.get(k)).filter(a=>a!==undefined);
      if (matches.length === 1) return matches[0]!;
    }
    return [];
  }
  const exact = (parsed: ReturnType<typeof parseDecision>): GraphEdge[] => {
    const street = named(parsed.street);
    if (parsed.multi || !street.length || parsed.address) return [];
    if (!parsed.cross.length) return /σε ολο το μηκοσ/.test(streetKey(parsed.subject)) ? street : [];
    const junctions = parsed.cross.map(name => {
      const nodes = new Set((named(name)).flatMap(e=>[e.from,e.to]));
      return [...new Set(street.flatMap(e=>[e.from,e.to]).filter(n=>nodes.has(n)))];
    });
    if (junctions.some(j=>j.length!==1)) return [];
    const start = junctions[0]![0]!, end = junctions[1]![0]!;
    const paths: GraphEdge[][] = [];
    function visit(node: string, seen: Set<string>, path: GraphEdge[]) {
      if (node===end) { paths.push([...path]); return; }
      seen.add(node);
      for (const edge of street) {
        const next = edge.from===node ? edge.to : edge.to===node ? edge.from : undefined;
        if (next && !seen.has(next) && paths.length<2) visit(next,seen,[...path,edge]);
      }
      seen.delete(node);
    }
    visit(start,new Set(),[]);
    return paths.length===1 ? paths[0]! : [];
  };
  return Object.assign(exact, {named, bbox: graph.meta.bbox});
}

type Placement = "unplaced" | "street_only" | "stretch" | "address";
export const reasons = ["outside_area","stretch_unresolved","building_number_only","several_streets","subject_too_vague","parse_failed"] as const;
type Reason = typeof reasons[number];

function boundaryStretch(street: GraphEdge[], crossing: GraphEdge[], box: number[], bearing: string, reverse: boolean) {
  const adjacent = new Map<string, GraphEdge[]>();
  for (const e of street) for (const node of [e.from,e.to]) adjacent.set(node,[...(adjacent.get(node) ?? []),e]);
  const joins = [...new Set(crossing.flatMap(e=>[e.from,e.to]).filter(n=>adjacent.has(n)))];
  if (joins.length!==1) return [];
  const branches = adjacent.get(joins[0]!)!;
  const heading = /(?:προσ|κατευθυνση) (?:τα |το |τον )?(βορ|νοτ|ανατολ|δυτ)/.exec(streetKey(bearing))?.[1];
  const candidates = branches.filter(edge => {
    if (!heading) return branches.length === 1;
    const a = edge.geometry[0], b = edge.geometry.at(-1);
    if (!a || !b) return false;
    const sign = (edge.from === joins[0] ? 1 : -1) * (reverse ? -1 : 1);
    const dx = (b[0]-a[0])*sign*Math.cos(a[1]*Math.PI/180), dy=(b[1]-a[1])*sign;
    return Math.abs(dx)>Math.abs(dy) ? heading===(dx>0 ? "ανατολ" : "δυτ") : heading===(dy>0 ? "βορ" : "νοτ");
  });
  if (candidates.length!==1) return [];
  const segment: GraphEdge[] = [];
  let node = joins[0]!;
  while (true) {
    const options = segment.length ? adjacent.get(node)!.filter(e=>!segment.includes(e)) : candidates;
    if (!options.length) break;
    if (options.length!==1) return [];
    const edge = options[0]!;
    segment.push(edge); node = edge.from===node ? edge.to : edge.from;
  }
  const end = segment.at(-1);
  const xy = end && (end.to===node ? end.geometry.at(-1) : end.geometry[0]);
  if (!xy) return [];
  const border = Math.min(...[box[0],box[2]].map(x=>distanceM(xy,[x!,xy[1]])), ...[box[1],box[3]].map(y=>distanceM(xy,[xy[0],y!])));
  return border < 25 ? segment : [];
}
export function placeDecision(d: Decision, index: ReturnType<typeof streetIndex>, addressPoint?: LngLat | null) {
  const parse = parseDecision(d.subject);
  const street = index.named(parse.street);
  const matchedNames = [...new Set(parse.streets.flatMap(name=>index.named(name).map(e=>e.name!)))];
  const inside = matchedNames.length > 0;
  let edges = index(parse);
  let placement: Placement = edges.length ? "stretch" : "unplaced";
  let reason: Reason | null = null;
  const missingCrossStreets = parse.cross.filter(name=>{
    const nodes = new Set(index.named(name).flatMap(e=>[e.from,e.to]));
    return !street.some(e=>nodes.has(e.from)||nodes.has(e.to));
  });
  if (!edges.length) {
    if (parse.multi) reason="several_streets";
    else if (!parse.street) reason=/οδ[οόώ]|λεωφ/i.test(d.subject) ? "parse_failed" : "subject_too_vague";
    else if (!street.length) reason=inside ? "stretch_unresolved" : "outside_area";
    else {
      reason=parse.address ? "building_number_only" : "stretch_unresolved";
      placement="street_only"; edges=street;
      if (parse.address && addressPoint) {
        const [w,s,e,n]=index.bbox;
        const inBox=addressPoint[0]>=w && addressPoint[0]<=e && addressPoint[1]>=s && addressPoint[1]<=n;
        const hits=street.map(edge=>({edge, distance:pointToLine(addressPoint,edge.geometry)?.distanceM ?? Infinity})).sort((a,b)=>a.distance-b.distance);
        if (inBox && hits[0] && hits[0].distance<=40) {placement="address"; edges=[hits[0].edge]; reason=null;}
      } else if (parse.cross.length===2 && missingCrossStreets.length===1 && /από .+ (έως|μέχρι) /iu.test(d.subject)) {
        const known=parse.cross.find(n=>!missingCrossStreets.includes(n))!;
        const path=boundaryStretch(street,index.named(known),index.bbox,d.subject,known===parse.cross[1]);
        if (path.length) {placement="stretch"; edges=path; reason=null;}
      }
    }
  }
  const streetName = street[0]?.name;
  const addressPosition = placement==="address" && addressPoint ? pointToLine(addressPoint,edges[0]!.geometry)?.point : undefined;
  return { ...d, parse, edges, streetName, addressPosition, matchedNames, inside, placement, reason, missingCrossStreets,
    hint: placement==="street_only" ? `Κάπου στην οδό ${streetName} · αβέβαιη θέση` : null,
    placementConfidence: placement==="street_only" ? 0.2 : placement==="unplaced" ? 0 : 0.8 };

}
export type Placed = ReturnType<typeof placeDecision>;
const defaultConfidence = { partial: 0.55, full: 0.9 };
export function decisionObstacles(d: Placed, now: Date, confidence = defaultConfidence): Obstacle[] {
  const issued = new Date(d.issueDate);
  const expiresAt = activeUntil(d.parse, issued, now);
  if (d.placement === "street_only" || !expiresAt || !d.edges.length || (d.parse.kind==="unknown" && !d.parse.fullPedestrian)) return [];
  const blocks = d.parse.fullPedestrian ? "full" : "partial";
  const mid = d.edges[Math.floor(d.edges.length/2)]!;
  const position = d.addressPosition ?? mid.geometry[Math.floor(mid.geometry.length/2)];
  return d.edges.map(e=>({ id: `diavgeia:${d.ada}:${e.id}`, edgeId:e.id, blocks, type:"traffic_decision",
    label:`Κυκλοφοριακή ρύθμιση στην οδό ${e.name}, απόφαση ${d.authority}.`,
    confidence:confidence[blocks], source:{kind:"open_data",ref:d.ada,url:"https://diavgeia.gov.gr/doc/"+encodeURIComponent(d.ada)},
    synthetic:false, observedAt:issued.toISOString(), expiresAt, position }));
}

/** Mission-only proxy at the geometry nearest the street centre. Never passed to the router. */
export function decisionHint(d: Placed, date: Date): Obstacle[] {
  if (d.placement !== "street_only" || !activeUntil(d.parse,new Date(d.issueDate),date)) return [];
  const points=d.edges.flatMap(e=>e.geometry);
  if (!points.length) return [];
  const centre: LngLat=[points.reduce((s,p)=>s+p[0],0)/points.length,points.reduce((s,p)=>s+p[1],0)/points.length];
  const candidates=d.edges.map(e=>({e,hit:pointToLine(centre,e.geometry)})).sort((a,b)=>(a.hit?.distanceM??Infinity)-(b.hit?.distanceM??Infinity));
  const first=candidates[0];
  if (!first?.hit) return [];
  return [{id:"hint:"+d.ada,edgeId:first.e.id,position:first.hit.point,blocks:"partial",confidence:0.2,type:"traffic_decision",
    label:d.hint!,source:{kind:"open_data",ref:"hint:"+d.ada,url:"https://diavgeia.gov.gr/doc/"+encodeURIComponent(d.ada)},
    synthetic:false,observedAt:new Date(d.issueDate).toISOString(),expiresAt:activeUntil(d.parse,new Date(d.issueDate),date)}];
}
