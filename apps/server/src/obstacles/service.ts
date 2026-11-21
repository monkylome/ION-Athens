/**
 * Keeps the current obstacles: fetches reports and projects from the sandbox,
 * maps them, remembers the result and tells listeners what changed.
 *
 * - A snapshot younger than `maxAgeMs` is served from memory, so a screen
 *   refresh costs no sandbox call.
 * - While at least one listener is subscribed, the sandbox is polled every
 *   `pollMs`. Without listeners nothing is polled.
 * - When the sandbox does not answer, the last known obstacles stay in place
 *   and the snapshot is marked `stale`. Obstacles that expire meanwhile are
 *   still dropped, because expiry needs no sandbox.
 */
import type { Obstacle } from "@ion/core";
import { SandboxError, type SandboxClient } from "../sandbox/client.ts";
import type { SandboxProject, SandboxReport } from "../sandbox/schemas.ts";
import { type ObstacleEvent, diffObstacles } from "./diff.ts";
import { type EdgeLookup, type MappingOptions, type Skipped, mapSandboxData } from "./rules.ts";

export interface ObstacleSnapshot {
  obstacles: Obstacle[];
  skipped: Skipped[];
  /** When the sandbox last answered. null before the first answer. */
  updatedAt: string | null;
  /** True when the newest attempt to reach the sandbox failed. */
  stale: boolean;
  /** Short machine reason for `stale`, for example "timeout". Never a secret. */
  problem: string | null;
  counts: { reports: number; projects: number };
}

export interface ObstacleServiceOptions {
  refreshDecisions?: () => Promise<void>;
  decisionObstacles?: (now: Date) => Obstacle[];
  client: Pick<SandboxClient, "listAllReports" | "listProjects">;
  edges: EdgeLookup;
  mapping?: Partial<MappingOptions>;
  /** Interval between polls while someone listens. 5 s is 12 of the 100 calls per minute. */
  pollMs?: number;
  /** A snapshot younger than this is served without a sandbox call. */
  maxAgeMs?: number;
  /** Projects change rarely: they are fetched again only after this long. */
  projectsMaxAgeMs?: number;
  now?: () => Date;
  onError?: (err: unknown) => void;
}

type Listener = (event: ObstacleEvent) => void;

export class ObstacleService {
  private readonly o: Required<Omit<ObstacleServiceOptions, "mapping" | "onError">> & Pick<ObstacleServiceOptions, "mapping" | "onError">;
  private reports: SandboxReport[] = [];
  private projects: SandboxProject[] = [];
  private projectsAt = 0;
  private fetchedAt = 0;
  private attemptedAt = 0;
  private problem: string | null = null;
  private obstacles: Obstacle[] = [];
  private skipped: Skipped[] = [];
  private inFlight: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ObstacleServiceOptions) {
    this.o = { refreshDecisions: async () => {}, decisionObstacles: () => [], pollMs: 5000, maxAgeMs: 4000, projectsMaxAgeMs: 300_000, now: () => new Date(), ...options };
  }

  /** Current obstacles. Asks the sandbox only when the cached answer is older than `maxAgeMs`. */
  async snapshot(opts: { force?: boolean } = {}): Promise<ObstacleSnapshot> {
    if (this.inFlight) await this.inFlight;
    else if (opts.force || this.o.now().getTime() - this.attemptedAt >= this.o.maxAgeMs) await this.refresh();
    else this.remap();
    return this.current();
  }

  /** The last known state, without any sandbox call. */
  current(): ObstacleSnapshot {
    return {
      obstacles: this.obstacles,
      skipped: this.skipped,
      updatedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      stale: this.problem !== null,
      problem: this.problem,
      counts: { reports: this.reports.length, projects: this.projects.length },
    };
  }

  /**
   * Fetches after this server changed something in the sandbox. A round trip
   * that is already under way may have read the old state, so it is awaited
   * and then a new one is made.
   */
  async refreshAfterWrite(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    await this.refresh();
  }

  /** Fetches now. Concurrent callers share one round trip. Never throws. */
  refresh(): Promise<void> {
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.o.pollMs);
      this.timer.unref?.();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async doRefresh(): Promise<void> {
    const nowMs = this.o.now().getTime();
    this.attemptedAt = nowMs;
    const decisions = this.o.refreshDecisions().catch(err => this.o.onError?.(err));
    try {
      const needProjects = this.projectsAt === 0 || nowMs - this.projectsAt >= this.o.projectsMaxAgeMs;
      const [reports, projects] = await Promise.all([
        this.o.client.listAllReports(),
        needProjects ? this.o.client.listProjects() : Promise.resolve(this.projects),
      ]);
      this.reports = reports;
      this.projects = projects;
      if (needProjects) this.projectsAt = nowMs;
      this.fetchedAt = nowMs;
      this.problem = null;
    } catch (err) {
      this.problem = err instanceof SandboxError ? err.code : "internal";
      this.o.onError?.(err);
    }
    await decisions;
    this.remap();
  }

  /** Applies the rules to the data in memory and announces the differences. */
  remap(): void {
    const now = this.o.now();
    const mapped = mapSandboxData(this.reports, this.projects, this.o.edges, now, this.o.mapping);
    mapped.obstacles.push(...this.o.decisionObstacles(now));
    const events = diffObstacles(this.obstacles, mapped.obstacles, now);
    this.obstacles = mapped.obstacles;
    this.skipped = mapped.skipped;
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (err) {
          this.o.onError?.(err);
        }
      }
    }
  }
}
