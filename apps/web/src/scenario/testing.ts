/** A small hand-made street grid and fake ports, for the tests of the scenario. */
import { buildGraphIndex, haversineM, nearestEdge, type GraphEdge, type GraphIndex, type GraphNode, type LngLat, type Obstacle, type PedestrianGraph } from "@ion/core";
import type { PlaceRecord } from "./places";
import type { ApiPort, ApiResult, ReportResponse, Utterance, VoicePort } from "./ports";

const ORIGIN: LngLat = [23.7265, 37.9765];
const M_PER_DEG = 111195.08;
function at(x: number, y: number): LngLat {
  return [ORIGIN[0] + x / (M_PER_DEG * Math.cos((ORIGIN[1] * Math.PI) / 180)), ORIGIN[1] + y / M_PER_DEG];
}

/**
 * A ladder. The walk is A to E along the bottom street, 100 m a block. The
 * rungs are 40 m, so going round one block adds 80 m.
 *
 *        B2 --- C2 --- D2 --- E2
 *        |      |      |      |
 * A ---- B ---- C ---- D ---- E
 */
export function ladder(): { graph: PedestrianGraph; index: GraphIndex } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const node = (id: string, x: number, y: number) => {
    const [lng, lat] = at(x, y);
    nodes.push({ id, lng, lat, kind: "junction" });
  };
  const edge = (from: string, to: string, name?: string) => {
    const a = nodes.find((n) => n.id === from)!;
    const b = nodes.find((n) => n.id === to)!;
    const geometry: LngLat[] = [[a.lng, a.lat], [b.lng, b.lat]];
    edges.push({ id: `${from}-${to}`, from, to, lengthM: haversineM(geometry[0]!, geometry[1]!), kind: "sidewalk", geometry, ...(name ? { name } : {}) });
  };
  ["A", "B", "C", "D", "E"].forEach((id, i) => node(id, i * 100, 0));
  ["B2", "C2", "D2", "E2"].forEach((id, i) => node(id, (i + 1) * 100, 40));
  for (const [a, b] of [["A", "B"], ["B", "C"], ["C", "D"], ["D", "E"]] as const) edge(a, b, "Αθηνάς");
  for (const [a, b] of [["B2", "C2"], ["C2", "D2"], ["D2", "E2"]] as const) edge(a, b, "Σωκράτους");
  for (const id of ["B", "C", "D", "E"]) edge(id, `${id}2`);
  const graph: PedestrianGraph = {
    meta: { bbox: [0, 0, 0, 0], builtAt: "2026-11-21T00:00:00Z", source: "test", licence: "test", attribution: "test", nodeCount: nodes.length, edgeCount: edges.length },
    nodes,
    edges,
  };
  return { graph, index: buildGraphIndex(graph) };
}

export function ladderPlaces(index: GraphIndex): PlaceRecord[] {
  const place = (id: string, name: string, kind: string, nodeId: string): PlaceRecord => {
    const n = index.nodes.get(nodeId)!;
    return { id, name, kind, lng: n.lng, lat: n.lat, nearestNodeId: nodeId };
  };
  return [
    place("start", "Μοναστηράκι", "metro_station", "A"),
    place("hall", "Δημαρχείο Αθηνών", "townhall", "E"),
    place("clinic", "Πολυκλινική Αθηνών", "hospital", "E2"),
  ];
}

export class FakeClock {
  t = 0;
  now = () => this.t;
  wallNow = () => Date.parse("2026-11-22T10:00:00Z") + this.t;
}

/** A voice that starts at once and ends when the test says so (or at once, with `auto`). */
export class FakeVoice implements VoicePort {
  said: string[] = [];
  private current: Utterance | null = null;
  constructor(public auto = true) {}
  say(u: Utterance) {
    this.said.push(u.text);
    this.current = u;
    u.onStart?.({ voiced: false });
    if (this.auto) this.finish();
  }
  finish() {
    const u = this.current;
    this.current = null;
    if (!u) return;
    const words = u.text.trim().split(/\s+/u).length;
    u.onWord?.(words - 1);
    u.onEnd?.();
  }
  cancel() {
    this.current = null;
  }
}

/** A server in memory with the real rule: a report is partial until it has two confirmations. */
export class FakeServer implements ApiPort {
  down = false;
  calls: string[] = [];
  reports = new Map<string, { upvotes: number; obstacle: Obstacle }>();
  private seq = 1000;
  constructor(private index: GraphIndex, private clock: FakeClock, private fullAtUpvotes = 2) {}

  private answer<T>(method: "GET" | "POST", path: string, status: number, data: T | null): ApiResult<T> {
    this.calls.push(`${method} ${path} ${status}`);
    return { ok: status >= 200 && status < 300, status, data, unreachable: status === 0 || status >= 500, method, path };
  }
  private view(id: string): ReportResponse {
    const r = this.reports.get(id)!;
    return { sandbox: true, report: { id, upvotes: r.upvotes }, obstacle: r.obstacle };
  }
  async destination(text: string) {
    if (this.down) return this.answer<never>("POST", "/destination", 0, null);
    if (/δημαρχ/i.test(text)) {
      const n = this.index.nodes.get("E")!;
      return this.answer("POST", "/destination", 200, {
        sandbox: true, understood: true as const, confidence: 0.9, how: "poi_search", speech: "Βρήκα: Δημαρχείο Αθηνών. Να ξεκινήσουμε;",
        place: { id: "poi-008", name: "Δημαρχείο Αθηνών", lng: n.lng, lat: n.lat, address: "Αθηνάς 63" },
      });
    }
    if (/αθηνών/i.test(text)) {
      // As the real server does: one of the words is in a name, so it offers that place without being sure.
      const n = this.index.nodes.get("E")!;
      return this.answer("POST", "/destination", 200, {
        sandbox: true, understood: true as const, confidence: 0.65, how: "poi_search", speech: "Το πιο σχετικό που βρήκα είναι: Δημαρχείο Αθηνών.",
        place: { id: "poi-008", name: "Δημαρχείο Αθηνών", lng: n.lng, lat: n.lat, address: "Αθηνάς 63" },
      });
    }
    return this.answer("POST", "/destination", 200, { sandbox: true, understood: false as const, reason: "no_match", speech: "Δεν βρήκα προορισμό." });
  }
  async route() {
    // No route from the server: the engine computes it with @ion/core, as it does when offline.
    return this.answer<never>("POST", "/route", this.down ? 0 : 404, null);
  }
  async report(input: { lng: number; lat: number }) {
    if (this.down) return this.answer<ReportResponse>("POST", "/reports", 0, null);
    const id = `req-${++this.seq}`;
    const hit = nearestEdge(this.index, [input.lng, input.lat], 25);
    if (!hit) return this.answer<ReportResponse>("POST", "/reports", 201, { sandbox: true, report: { id, upvotes: 0 }, obstacle: null });
    const full = this.fullAtUpvotes <= 0;
    this.reports.set(id, {
      upvotes: 0,
      obstacle: {
        id: `sandbox:${id}`, edgeId: hit.edge.id, blocks: full ? "full" : "partial", type: "sidewalk", label: "Εμπόδιο στο πεζοδρόμιο",
        source: { kind: "sandbox_request", ref: id }, synthetic: true, observedAt: new Date(this.clock.wallNow()).toISOString(),
        expiresAt: null, confidence: full ? 0.85 : 0.6, position: [input.lng, input.lat],
      },
    });
    return this.answer("POST", "/reports", 201, this.view(id));
  }
  async confirm(id: string) {
    const path = `/reports/${id}/confirm`;
    if (this.down) return this.answer<ReportResponse>("POST", path, 0, null);
    const r = this.reports.get(id);
    if (!r) return this.answer<ReportResponse>("POST", path, 404, null);
    r.upvotes++;
    if (r.upvotes >= this.fullAtUpvotes) r.obstacle = { ...r.obstacle, blocks: "full", confidence: 0.85 };
    return this.answer("POST", path, 200, this.view(id));
  }
  async resolve(id: string) {
    const path = `/demo/resolve/${id}`;
    if (this.down) return this.answer<ReportResponse>("POST", path, 0, null);
    if (!this.reports.delete(id)) return this.answer<ReportResponse>("POST", path, 404, null);
    return this.answer<ReportResponse>("POST", path, 200, { sandbox: true, demo: true, report: { id }, obstacle: null });
  }
  async reset() {
    if (this.down) return this.answer<{ reset: boolean }>("POST", "/demo/reset", 0, null);
    this.reports.clear();
    return this.answer("POST", "/demo/reset", 200, { reset: true, sandbox: true, demo: true });
  }
}
