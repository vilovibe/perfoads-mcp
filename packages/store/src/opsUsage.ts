// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { busyAsStoreError, StoreBusyError, type Store } from "./db.js";

/** Short wait before the one retry of a busy save (blocks the thread: keep it tiny). */
const RETRY_WAIT_MS = 25;
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows older than this are pruned (the window is 24 h; the rest is slack for clock skew). */
const KEEP_MS = 2 * DAY_MS;

/** Test-account and production-account operations are counted apart (Google does too). */
export type StoreOpsPool = "test" | "production";

/**
 * Same shape as OpsCounter in @perfoads/ads-client (kept structural so the store does
 * not depend on the client). No pool = production. `remaining()` is null when the pool
 * has no known limit.
 */
export interface StoreOpsCounter {
  record(n: number, kind: string, pool?: StoreOpsPool): void;
  used(pool?: StoreOpsPool): number;
  remaining(pool?: StoreOpsPool): number | null;
  limitReached(untilMs: number, pool?: StoreOpsPool): void;
  limitUntil(pool?: StoreOpsPool): number | null;
  freesAt(n: number, pool?: StoreOpsPool): number | null;
  refilled(atMs: number, pool?: StoreOpsPool): void;
}

/**
 * meta key holding when a pool's spent daily limit refills, as Google said:
 * "<epoch ms> <scope>" (scope = which Google Cloud project and access level it was for).
 * One key per pool and scope, so a wait for one project never overwrites another's.
 */
const limitKey = (pool: StoreOpsPool, scope = ""): string =>
  scope ? `ops_limit_until_${pool}_${scope}` : `ops_limit_until_${pool}`;

/**
 * meta key holding when Google showed a pool had refilled (it took a request our count said
 * it would refuse): "<epoch ms> <scope>", one key per pool and scope like the wait.
 */
const refilledKey = (pool: StoreOpsPool, scope = ""): string =>
  scope ? `ops_refilled_${pool}_${scope}` : `ops_refilled_${pool}`;

/** Google's daily limit refills within a day: a longer stated wait is kept as 24 hours. */
const LIMIT_WAIT_CAP_MS = DAY_MS;

/** Forgets every saved wait (after setup or a new access level: the old one may not apply). */
export const clearSavedLimitWait = (store: Store): void => {
  busyAsStoreError(store, () =>
    store.db.prepare("DELETE FROM meta WHERE key LIKE 'ops\\_limit\\_until\\_%' ESCAPE '\\'").run(),
  );
};

/**
 * Google Ads operations over a rolling 24 hours, per pool, kept in the store's ops_usage
 * table, so every server process on one store shares one count per pool. `record` never
 * throws: it runs right after Google answered, and a busy store must not turn a finished
 * write into an error. A count that could not be saved is kept in memory and saved with
 * the next one. A pool without a limit in `limits` has none.
 */
export const createStoreOpsCounter = (
  store: Store,
  options: {
    limits?: Partial<Readonly<Record<StoreOpsPool, number | null>>>;
    now?: () => number;
    /**
     * Which Google Cloud project and access level a saved wait belongs to (e.g. a hash of
     * the OAuth client id and the level). A wait saved for another one, or with none, is
     * ignored. Not set: every saved wait counts.
     */
    scope?: () => string;
  } = {},
): StoreOpsCounter => {
  const now = options.now ?? Date.now;
  let unsaved: { at: number; n: number; kind: string; pool: StoreOpsPool }[] = [];
  const limitMemo = new Map<StoreOpsPool, { until: number; scope: string }>();
  const refilledMemo = new Map<StoreOpsPool, { at: number; scope: string }>();
  const scopeNow = (): string => options.scope?.() ?? "";
  /** The saved wait if it is for this scope and at most 24 hours away; else 0. */
  const savedWait = (pool: StoreOpsPool, scope: string): number => {
    const [at = "", savedScope = ""] = (store.getMeta(limitKey(pool, scope)) ?? "").split(" ");
    const until = Number(at) || 0;
    if (options.scope && savedScope !== scope) return 0;
    return until > now() + LIMIT_WAIT_CAP_MS ? 0 : until;
  };
  const memoWait = (pool: StoreOpsPool, scope: string): number => {
    const m = limitMemo.get(pool);
    return m && m.scope === scope && m.until <= now() + LIMIT_WAIT_CAP_MS ? m.until : 0;
  };

  const save = (): void => {
    if (unsaved.length === 0) return;
    const rows = unsaved;
    busyAsStoreError(store, () =>
      store.immediate(() => {
        const insert = store.db.prepare(
          "INSERT INTO ops_usage (at_ms, n, kind, pool) VALUES (?, ?, ?, ?)",
        );
        for (const r of rows) insert.run(r.at, r.n, r.kind, r.pool);
        store.db.prepare("DELETE FROM ops_usage WHERE at_ms < ?").run(now() - KEEP_MS);
      }),
    );
    unsaved = unsaved.filter((r) => !rows.includes(r));
  };

  /** When Google showed this scope's pool had refilled, as saved (0 = never, or another scope). */
  const savedRefill = (pool: StoreOpsPool, scope: string): number => {
    const [at = "", savedScope = ""] = (store.getMeta(refilledKey(pool, scope)) ?? "").split(" ");
    if (options.scope && savedScope !== scope) return 0;
    return Number(at) || 0;
  };

  /**
   * When Google last refilled, as far as we know: the end of a passed wait, or when it took a
   * request our count said it would refuse; else -Infinity.
   */
  const refilledAt = (pool: StoreOpsPool): number => {
    const scope = scopeNow();
    let until = memoWait(pool, scope);
    const memo = refilledMemo.get(pool);
    let mark = memo && memo.scope === scope ? memo.at : 0;
    try {
      until = Math.max(until, savedWait(pool, scope));
      mark = Math.max(mark, savedRefill(pool, scope));
    } catch {
      // busy store: what this process knows
    }
    const passed = until > 0 && until <= now() ? until : Number.NEGATIVE_INFINITY;
    return Math.max(passed, mark > 0 && mark <= now() ? mark : Number.NEGATIVE_INFINITY);
  };

  /** Operations of the last 24 hours, minus those before a passed wait (Google refilled). */
  const used = (pool: StoreOpsPool = "production"): number => {
    const cutoff = Math.max(now() - DAY_MS, refilledAt(pool));
    const pending = unsaved
      .filter((r) => r.at > cutoff && r.pool === pool)
      .reduce((sum, r) => sum + r.n, 0);
    const row = busyAsStoreError(
      store,
      () =>
        store.db
          .prepare(
            "SELECT COALESCE(SUM(n), 0) AS total FROM ops_usage WHERE pool = ? AND at_ms > ?",
          )
          .get(pool, cutoff) as { total: number | bigint },
    );
    return Number(row.total) + pending;
  };

  /** When enough counted operations (oldest first) leave the 24 hours for n more to fit. */
  const freesAt = (n: number, pool: StoreOpsPool = "production"): number | null => {
    const limit = options.limits?.[pool];
    if (limit === undefined || limit === null || n > limit) return null;
    let excess = used(pool) + n - limit;
    if (excess <= 0) return now();
    const cutoff = Math.max(now() - DAY_MS, refilledAt(pool));
    const rows = busyAsStoreError(
      store,
      () =>
        store.db
          .prepare(
            "SELECT at_ms AS at, n FROM ops_usage WHERE pool = ? AND at_ms > ? ORDER BY at_ms",
          )
          .all(pool, cutoff) as { at: number | bigint; n: number | bigint }[],
    ).map((r) => ({ at: Number(r.at), n: Number(r.n) }));
    const pending = unsaved.filter((r) => r.at > cutoff && r.pool === pool);
    for (const r of [...rows, ...pending].sort((a, b) => a.at - b.at)) {
      excess -= r.n;
      if (excess <= 0) return r.at + DAY_MS;
    }
    return null;
  };

  return {
    record: (n, kind, pool = "production") => {
      if (!Number.isInteger(n) || n <= 0) return;
      unsaved.push({ at: now(), n, kind, pool });
      try {
        save();
      } catch (err) {
        // Busy: one brief retry, then kept in `unsaved` (counted by used()) and saved with the next record.
        if (err instanceof StoreBusyError) {
          pause(RETRY_WAIT_MS);
          try {
            save();
          } catch {
            // still busy
          }
        }
      }
    },
    used,
    remaining: (pool = "production") => {
      const limit = options.limits?.[pool];
      return limit === undefined || limit === null ? null : Math.max(0, limit - used(pool));
    },
    // Kept in the store so every server process on it waits; never throws (runs after Google answered).
    limitReached: (untilMs, pool = "production") => {
      if (!Number.isFinite(untilMs)) return;
      const scope = scopeNow();
      const capped = Math.round(Math.min(untilMs, now() + LIMIT_WAIT_CAP_MS));
      let saved = memoWait(pool, scope);
      try {
        saved = Math.max(saved, savedWait(pool, scope));
        if (capped > saved) store.setMeta(limitKey(pool, scope), `${capped} ${scope}`.trim());
      } catch {
        // busy store: kept in memory for this process
      }
      limitMemo.set(pool, { until: Math.max(saved, capped), scope });
    },
    limitUntil: (pool = "production") => {
      const scope = scopeNow();
      let until = memoWait(pool, scope);
      try {
        until = Math.max(until, savedWait(pool, scope));
      } catch {
        // busy store: what this process knows
      }
      return until > now() ? until : null;
    },
    freesAt,
    // Kept in the store so every server process on it counts from the refill; never throws.
    refilled: (atMs, pool = "production") => {
      if (!Number.isFinite(atMs)) return;
      const scope = scopeNow();
      const at = Math.round(Math.min(atMs, now()));
      const memo = refilledMemo.get(pool);
      let saved = memo && memo.scope === scope ? memo.at : 0;
      try {
        saved = Math.max(saved, savedRefill(pool, scope));
        if (at > saved) store.setMeta(refilledKey(pool, scope), `${at} ${scope}`.trim());
      } catch {
        // busy store: kept in memory for this process
      }
      refilledMemo.set(pool, { at: Math.max(saved, at), scope });
    },
  };
};
