/**
 * The common shape of a city source. An adapter knows what to ask and how to
 * read the answer; `CachedSource` (cache.ts) adds the cache, the timeout and
 * the last-known-good copy. Nothing here touches the network on its own.
 */

export type SourceKind = "live" | "daily" | "static";
export type Permission = "open licence" | "pending" | "not needed";

/** What the screens and the jury see about a source. */
export interface SourceMeta {
  id: string;
  name: string;
  owner: string;
  /** What ION takes from it, in one sentence. */
  gives: string;
  kind: SourceKind;
  /** `real` or `test` (the sandbox is test data). */
  data: "real" | "test";
  /** A short quote from the owner's terms, or a plain statement that none was found. */
  terms: string;
  termsUrl: string | null;
  /** True when `terms` is a verbatim quote. */
  termsQuoted: boolean;
  permission: Permission;
  /** The request the adapter makes, without parameters that name a person or place. */
  request: string;
}

export interface FetchEnv {
  fetch: typeof fetch;
  timeoutMs: number;
  now: () => Date;
  retryDelayMs: number;
}

export interface SourceAdapter<R, Q = void> {
  meta: SourceMeta;
  /** Which request of the source this is, when a source makes several. */
  part?: string;
  ttlMs: number;
  timeoutMs: number;
  /** Cache key for a query; defaults to one entry. */
  key?(q: Q): string;
  /** The query used when only checking that the source answers. */
  probe?: Q;
  fetch(q: Q, env: FetchEnv): Promise<R[]>;
}

export interface Snapshot<R> {
  records: R[];
  /** When these records were fetched; null when nothing was ever fetched. */
  fetchedAt: string | null;
  /** True when the source did not answer and an older copy is served. */
  stale: boolean;
  problem: string | null;
}

export interface PartStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Did the last attempt work; null before any attempt. */
  ok: boolean | null;
  problem: string | null;
  records: number;
}
