import { SourceError } from "./http.ts";
import type { FetchEnv, PartStatus, Snapshot, SourceAdapter, SourceMeta } from "./types.ts";

/** After a failure the source is not asked again for this long; the older copy is served. */
const RETRY_AFTER_FAILURE_MS = 60_000;
const MAX_ENTRIES = 100;

/**
 * Wraps an adapter with a cache of its own lifetime, concurrent-call sharing and
 * a last-known-good copy. `get` never throws: a source that fails must not
 * break the others or the server.
 */
export class CachedSource<R, Q = void> {
  private readonly entries = new Map<string, { records: R[]; at: number }>();
  private readonly failures = new Map<string, { at: number; problem: string }>();
  private readonly inflight = new Map<string, Promise<void>>();
  private lastAttempt: number | null = null;
  private lastSuccess: number | null = null;
  private lastOk: boolean | null = null;
  private lastProblem: string | null = null;
  private lastCount = 0;

  constructor(
    readonly adapter: SourceAdapter<R, Q>,
    private readonly env: Omit<FetchEnv, "timeoutMs">,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  get meta(): SourceMeta {
    return this.adapter.meta;
  }

  /**
   * `waitMs` bounds how long the caller waits for a refresh. When it runs out the
   * older copy is served marked stale (or nothing, with the problem "still loading")
   * and the refresh goes on in the background for the next call.
   */
  async get(q: Q, waitMs?: number): Promise<Snapshot<R>> {
    const key = this.adapter.key ? this.adapter.key(q) : "";
    const t = this.env.now().getTime();
    const entry = this.entries.get(key);
    if (entry && t - entry.at < this.adapter.ttlMs) return this.snapshot(entry, false, null);
    const failed = this.failures.get(key);
    if (!failed || t - failed.at >= (this.adapter.retryAfterFailureMs ?? RETRY_AFTER_FAILURE_MS)) {
      let run = this.inflight.get(key);
      if (!run) {
        run = this.refresh(key, q).finally(() => this.inflight.delete(key));
        this.inflight.set(key, run);
      }
      if (waitMs === undefined) await run;
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const slow = await Promise.race([run.then(() => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), waitMs)))]);
        clearTimeout(timer);
        if (slow) return this.snapshot(this.entries.get(key) ?? null, true, `${this.adapter.meta.id} is slow to answer; still loading`);
      }
    }
    const after = this.entries.get(key);
    const fail = this.failures.get(key);
    if (after && (!fail || after.at > fail.at)) return this.snapshot(after, false, null);
    return this.snapshot(after ?? null, true, fail?.problem ?? "no answer");
  }

  /** Ask the source now if the cache is cold or old, using the adapter's probe query. */
  async warm(): Promise<Snapshot<R>> {
    // A source that needs a query and has no probe query is not asked just to see if it answers.
    if (this.adapter.key && this.adapter.probe === undefined) return this.snapshot(null, false, null);
    return this.get(this.adapter.probe as Q);
  }

  status(): PartStatus {
    const iso = (n: number | null) => (n === null ? null : new Date(n).toISOString());
    return { lastAttemptAt: iso(this.lastAttempt), lastSuccessAt: iso(this.lastSuccess), ok: this.lastOk, problem: this.lastProblem, records: this.lastCount };
  }

  private snapshot(entry: { records: R[]; at: number } | null, stale: boolean, problem: string | null): Snapshot<R> {
    return { records: entry?.records ?? [], fetchedAt: entry ? new Date(entry.at).toISOString() : null, stale: entry ? stale : false, problem };
  }

  private async refresh(key: string, q: Q): Promise<void> {
    const started = this.env.now().getTime();
    this.lastAttempt = started;
    try {
      const records = await this.adapter.fetch(q, { ...this.env, timeoutMs: this.adapter.timeoutMs });
      const at = this.env.now().getTime();
      if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
      this.entries.set(key, { records, at });
      this.failures.delete(key);
      this.lastSuccess = at;
      this.lastOk = true;
      this.lastProblem = null;
      this.lastCount = records.length;
    } catch (err) {
      const problem = err instanceof SourceError ? err.message : `${this.adapter.meta.id} failed: ${err instanceof Error ? err.message : "unknown error"}`;
      this.failures.set(key, { at: this.env.now().getTime(), problem });
      this.lastOk = false;
      this.lastProblem = problem;
      this.log(`source ${this.adapter.meta.id}${this.adapter.part ? ` (${this.adapter.part})` : ""}: ${problem}`);
    }
  }
}
