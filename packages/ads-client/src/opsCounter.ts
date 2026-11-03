// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { AccessLevel, OpsCounter, OpsPool } from "./types.js";

/** Daily limits of one access level, per pool. null = no limit. */
export type OpsLimits = Readonly<Record<OpsPool, number | null>>;

/**
 * Daily operation limits per access level and pool (Google Ads API access page of the
 * Cloud project). Google counts test-account and production-account operations apart.
 * Test access can't reach production accounts at all (Google refuses them itself); its
 * production limit stays at 2,880 so account discovery, counted as production until an
 * account is known to be a test account, still works.
 * Unknown level: assume Explorer, the level most new projects get.
 */
export const DAILY_OPS_LIMITS: Readonly<Record<AccessLevel, OpsLimits>> = Object.freeze({
  test: Object.freeze({ test: 15_000, production: 2_880 }),
  explorer: Object.freeze({ test: 15_000, production: 2_880 }),
  basic: Object.freeze({ test: 15_000, production: 15_000 }),
  standard: Object.freeze({ test: null, production: null }),
  unknown: Object.freeze({ test: 15_000, production: 2_880 }),
});

/** Default production budget when the level is unknown (Explorer). */
export const DEFAULT_DAILY_OPS_BUDGET = DAILY_OPS_LIMITS.unknown.production;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When enough of the counted operations (oldest first) leave the 24 hours for n more to
 * fit under the limit; null when there is no limit or n alone is over it.
 */
export const freesAt = (
  counted: readonly { at: number; n: number }[],
  n: number,
  limit: number | null | undefined,
  now: number,
): number | null => {
  if (limit === undefined || limit === null || n > limit) return null;
  let excess = counted.reduce((sum, e) => sum + e.n, 0) + n - limit;
  if (excess <= 0) return now;
  for (const e of [...counted].sort((a, b) => a.at - b.at)) {
    excess -= e.n;
    if (excess <= 0) return e.at + DAY_MS;
  }
  return null;
};

/**
 * In-memory ops counter over a rolling 24 hours, one count per pool. For tests and single
 * short runs only: it forgets everything on restart and is not shared between processes.
 * The store-backed counter (multi-process safe) replaces it in real use.
 * A pool without a limit in `limits` has none.
 */
export const createMemoryOpsCounter = (
  options: { limits?: Partial<OpsLimits>; now?: () => number } = {},
): OpsCounter => {
  const now = options.now ?? Date.now;
  let entries: { at: number; n: number; pool: OpsPool }[] = [];
  const limitUntil = new Map<OpsPool, number>();
  const refilledMark = new Map<OpsPool, number>();

  /** Operations of the last 24 hours, minus those before a passed wait or a refill Google showed. */
  const counted = (pool: OpsPool): typeof entries => {
    entries = entries.filter((e) => e.at > now() - DAY_MS);
    const until = limitUntil.get(pool);
    const passed = until !== undefined && until <= now() ? until : Number.NEGATIVE_INFINITY;
    const mark = refilledMark.get(pool);
    const refilled = Math.max(passed, mark !== undefined && mark <= now() ? mark : -Infinity);
    return entries.filter((e) => e.pool === pool && e.at > refilled);
  };
  const used = (pool: OpsPool = "production"): number =>
    counted(pool).reduce((sum, e) => sum + e.n, 0);

  return {
    record: (n, _kind, pool = "production") => {
      if (Number.isInteger(n) && n > 0) entries.push({ at: now(), n, pool });
    },
    used,
    remaining: (pool = "production") => {
      const limit = options.limits?.[pool];
      return limit === undefined || limit === null ? null : Math.max(0, limit - used(pool));
    },
    limitReached: (untilMs, pool = "production") => {
      // Google's daily limit refills within a day: a longer stated wait is kept as 24 hours
      const capped = Math.min(untilMs, now() + DAY_MS);
      limitUntil.set(pool, Math.max(capped, limitUntil.get(pool) ?? 0));
    },
    limitUntil: (pool = "production") => {
      const until = limitUntil.get(pool);
      return until !== undefined && until > now() ? until : null;
    },
    freesAt: (n, pool = "production") => freesAt(counted(pool), n, options.limits?.[pool], now()),
    refilled: (atMs, pool = "production") => {
      if (Number.isFinite(atMs))
        refilledMark.set(pool, Math.max(atMs, refilledMark.get(pool) ?? 0));
    },
  };
};
