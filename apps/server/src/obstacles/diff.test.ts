import { describe, expect, it } from "vitest";
import type { Obstacle } from "@ion/core";
import { NOW, at, report, testEdges } from "../testing/fixtures.ts";
import type { SandboxProject, SandboxReport } from "../sandbox/schemas.ts";
import { SandboxError } from "../sandbox/client.ts";
import { type ObstacleEvent, diffObstacles } from "./diff.ts";
import { ObstacleService } from "./service.ts";

const obstacle = (id: string, over: Partial<Obstacle> = {}): Obstacle => ({
  id, edgeId: "AB", blocks: "partial", type: "sidewalk", label: "Εμπόδιο", source: { kind: "sandbox_request", ref: id },
  synthetic: true, observedAt: "2026-11-21T09:00:00.000Z", expiresAt: "2026-11-21T21:00:00.000Z", confidence: 0.6, ...over,
});

describe("diffObstacles", () => {
  it("reports nothing when nothing changed", () => {
    expect(diffObstacles([obstacle("a")], [obstacle("a")], NOW)).toEqual([]);
  });

  it("reports added, changed and removed obstacles", () => {
    const events = diffObstacles(
      [obstacle("stays"), obstacle("grows"), obstacle("goes")],
      [obstacle("stays"), obstacle("grows", { blocks: "full", confidence: 0.85 }), obstacle("new")],
      NOW,
    );
    expect(events.map((e) => [e.type, e.obstacle.id])).toEqual([
      ["obstacle_changed", "grows"],
      ["obstacle_added", "new"],
      ["obstacle_removed", "goes"],
    ]);
    expect(events[0]?.changed).toEqual(["blocks", "confidence"]);
    expect(events[0]?.obstacle.blocks).toBe("full");
    expect(events[2]?.obstacle.id).toBe("goes"); // the last known state travels with the removal
    expect(events.every((e) => e.at === NOW.toISOString())).toBe(true);
  });

  it("ignores fields that do not matter to routing or speech", () => {
    expect(diffObstacles([obstacle("a")], [obstacle("a", { snapDistanceM: 3, position: at(1, 1) })], NOW)).toEqual([]);
  });
});

describe("ObstacleService", () => {
  function setup() {
    const state = { reports: [] as SandboxReport[], projects: [] as SandboxProject[], fail: null as Error | null, calls: 0, time: NOW.getTime() };
    const service = new ObstacleService({
      client: {
        listAllReports: async () => {
          state.calls++;
          if (state.fail) throw state.fail;
          return state.reports;
        },
        listProjects: async () => state.projects,
      },
      edges: testEdges(),
      now: () => new Date(state.time),
      maxAgeMs: 4000,
    });
    const events: ObstacleEvent[] = [];
    const unsubscribe = service.subscribe((e) => events.push(e));
    service.stop(); // no timer in tests: refresh is called by hand
    return { state, service, events, unsubscribe };
  }

  it("emits added, changed and removed as the sandbox data changes", async () => {
    const { state, service, events } = setup();
    state.reports = [report({ id: "req-1" })];
    await service.refresh();
    state.reports = [report({ id: "req-1", upvotes: 2 })];
    await service.refresh();
    state.reports = [report({ id: "req-1", upvotes: 2, status: "resolved" })];
    await service.refresh();
    expect(events.map((e) => [e.type, e.obstacle.id, e.obstacle.blocks])).toEqual([
      ["obstacle_added", "sandbox:req-1", "partial"],
      ["obstacle_changed", "sandbox:req-1", "full"],
      ["obstacle_removed", "sandbox:req-1", "full"],
    ]);
  });

  it("serves a fresh snapshot from memory", async () => {
    const { state, service } = setup();
    state.reports = [report()];
    await service.snapshot();
    await service.snapshot();
    expect(state.calls).toBe(1);
    state.time += 5000;
    await service.snapshot();
    expect(state.calls).toBe(2);
  });

  it("keeps the last known obstacles, marked stale, when the sandbox stops answering", async () => {
    const { state, service, events } = setup();
    state.reports = [report()];
    const good = await service.snapshot();
    expect(good).toMatchObject({ stale: false, problem: null });

    state.fail = new SandboxError("timeout", "GET /v1/requests", "no answer in time");
    state.time += 10_000;
    const stale = await service.snapshot();
    expect(stale.obstacles.map((o) => o.id)).toEqual(["sandbox:req-1001"]);
    expect(stale).toMatchObject({ stale: true, problem: "timeout", updatedAt: good.updatedAt });
    expect(events.map((e) => e.type)).toEqual(["obstacle_added"]);

    state.fail = null;
    state.time += 10_000;
    expect(await service.snapshot()).toMatchObject({ stale: false, problem: null });
  });

  it("drops an obstacle when it expires, even while the sandbox is down", async () => {
    const { state, service, events } = setup();
    state.reports = [report()]; // created 11:00, expires 23:00
    await service.snapshot();
    state.fail = new SandboxError("network", "GET /v1/requests", "could not reach the sandbox");
    state.time += 12 * 3_600_000;
    const later = await service.snapshot();
    expect(later.obstacles).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["obstacle_added", "obstacle_removed"]);
  });
});
