// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/** The fetch signature the client needs. Inject a fake in tests; defaults to global fetch. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Hands out OAuth access tokens. This package never stores tokens: the caller owns
 * storage and refresh. `forceRefresh` is asked for once after Google answers 401.
 */
export interface TokenProvider {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  /**
   * Optional: the scopes Google granted this sign-in (from its last token reply), or
   * undefined when Google did not say. Used for opt-in access (Merchant Center).
   */
  grantedScopes?(): Promise<readonly string[] | undefined>;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export type OpsKind = "search" | "mutate" | "other";

/**
 * Google counts operations on test accounts and on production (live) accounts separately,
 * each with its own daily limit. A request whose account is not known to be a test account
 * counts as production (the stricter one).
 */
export type OpsPool = "test" | "production";

/**
 * Counts Google Ads API operations against the daily limit of the Google Cloud project's API access level,
 * one count per pool (no pool = production). `remaining()` returns null when there is no known limit.
 */
export interface OpsCounter {
  record(n: number, kind: OpsKind, pool?: OpsPool): void;
  used(pool?: OpsPool): number;
  remaining(pool?: OpsPool): number | null;
  /**
   * Optional extra check before a request leaves: a plain refusal (e.g. reads may not use
   * the operations a policy keeps for changes), or undefined to let it go.
   */
  admit?(n: number, kind: OpsKind, pool?: OpsPool): string | undefined;
  /**
   * Optional: Google said the pool's daily limit is spent and named when it refills
   * (epoch ms). Kept so no request is sent before then.
   */
  limitReached?(untilMs: number, pool?: OpsPool): void;
  /** Optional: when the pool's spent daily limit refills (epoch ms), or null when it is not known spent. */
  limitUntil?(pool?: OpsPool): number | null;
  /**
   * Optional: when enough of the counted operations drop out of the 24 hours for n more
   * to fit (epoch ms); null when the pool has no limit or n never fits.
   */
  freesAt?(n: number, pool?: OpsPool): number | null;
  /**
   * Optional: Google took a request our count said it would refuse, so it has refilled
   * since (epoch ms). Operations counted before then stop counting, like after a passed wait.
   */
  refilled?(atMs: number, pool?: OpsPool): void;
}

/** API access level of the Google Cloud project that owns the OAuth client. Google has no endpoint that reports it. */
export type AccessLevel = "test" | "explorer" | "basic" | "standard" | "unknown";
