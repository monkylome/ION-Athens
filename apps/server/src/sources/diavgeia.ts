import type { GraphEdge, Obstacle, PedestrianGraph } from "@ion/core";
import { z } from "zod";
import { activeUntil, localDay, parseDecision, streetKey } from "./decision-parser.ts";
import { decisionDetail } from "./decision-detail.ts";
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
    meta: { id: police ? "diavgeia-police" : "diavgeia-city", name: "Διαύγεια", owner: authority,
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
  return (parsed: ReturnType<typeof parseDecision>): GraphEdge[] => {
    const street = byName.get(streetKey(parsed.street)) ?? [];
    if (parsed.multi || !street.length || parsed.address) return [];
    if (!parsed.cross.length) return /σε ολο το μηκοσ/.test(streetKey(parsed.subject)) ? street : [];
    const junctions = parsed.cross.map(name => {
      const nodes = new Set((byName.get(streetKey(name)) ?? []).flatMap(e=>[e.from,e.to]));
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
}
export function placeDecision(d: Decision, index: ReturnType<typeof streetIndex>) {
  const parse = parseDecision(d.subject);
  return { ...d, parse, edges: index(parse) };
}
export type Placed = ReturnType<typeof placeDecision>;
const defaultConfidence = { partial: 0.55, full: 0.9 };
export function decisionObstacles(d: Placed, now: Date, confidence = defaultConfidence): Obstacle[] {
  const issued = new Date(d.issueDate);
  const expiresAt = activeUntil(d.parse, issued, now);
  if (!expiresAt || !d.edges.length || (d.parse.kind==="unknown" && !d.parse.fullPedestrian)) return [];
  const blocks = d.parse.fullPedestrian ? "full" : "partial";
  const mid = d.edges[Math.floor(d.edges.length/2)]!;
  const position = mid.geometry[Math.floor(mid.geometry.length/2)];
  return d.edges.map(e=>({ id: `diavgeia:${d.ada}:${e.id}`, edgeId:e.id, blocks, type:"traffic_decision",
    label:`Κυκλοφοριακή ρύθμιση στην οδό ${e.name}, απόφαση ${d.authority}.`,
    confidence:confidence[blocks], source:{kind:"open_data",ref:d.ada,url:"https://diavgeia.gov.gr/doc/"+encodeURIComponent(d.ada)},
    synthetic:false, observedAt:issued.toISOString(), expiresAt, position }));
}
