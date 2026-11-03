// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Change lifecycle (plan section 6), plus `stale`: the account changed between approval
 * and sending, so nothing was sent and the change must be proposed again;
 * `resolved_by_user`: a person settled an unclear (in_doubt) change after checking the
 * account; `abandoned`: still unclear after 30 days (the change history no longer covers it).
 */
export const CHANGE_STATUSES = [
  "proposed",
  "expired",
  "rejected",
  "approved",
  "applying",
  "applied",
  "partially_applied",
  "failed",
  "in_doubt",
  "verified",
  "verify_failed",
  "stale",
  "resolved_by_user",
  "abandoned",
] as const;

export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

/**
 * Every allowed move. The store enforces the same table with a trigger (store migration 2),
 * so a move that is not here fails even when SQL is written by hand.
 */
export const CHANGE_TRANSITIONS: Readonly<Record<ChangeStatus, readonly ChangeStatus[]>> = {
  proposed: ["approved", "rejected", "expired"],
  approved: ["applying", "expired"],
  applying: ["applied", "partially_applied", "failed", "in_doubt", "stale"],
  // Resolved by reading the account, never by sending again.
  in_doubt: ["applied", "partially_applied", "failed", "resolved_by_user", "abandoned"],
  applied: ["verified", "verify_failed"],
  partially_applied: ["verified", "verify_failed"],
  expired: [],
  rejected: [],
  failed: [],
  verified: [],
  verify_failed: [],
  stale: [],
  resolved_by_user: [],
  abandoned: [],
};

export const canMove = (from: ChangeStatus, to: ChangeStatus): boolean =>
  CHANGE_TRANSITIONS[from].includes(to);

export const isChangeStatus = (value: string): value is ChangeStatus =>
  (CHANGE_STATUSES as readonly string[]).includes(value);

/** Statuses where the change may have landed in Google Ads (an undo may follow). */
export const LANDED_STATUSES: readonly ChangeStatus[] = [
  "applied",
  "partially_applied",
  "verified",
  "verify_failed",
];
