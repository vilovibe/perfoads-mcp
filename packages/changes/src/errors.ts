// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

export type ChangeErrorCode =
  | "invalid_input"
  | "unknown_type"
  | "not_found"
  | "not_allowed"
  | "nothing_to_change"
  | "policy_refused"
  | "google_refused"
  | "read_failed"
  | "wrong_state"
  | "expired"
  | "hash_mismatch"
  | "not_test_account"
  | "undo_unavailable"
  | "undo_window"
  | "undo_stale"
  | "item_busy";

/**
 * A change was refused or could not go ahead. `message` is the server's own sentence;
 * Google's words, when there are any, are kept apart in `googleSaid` (untrusted text).
 */
export class ChangeError extends Error {
  constructor(
    readonly code: ChangeErrorCode,
    message: string,
    readonly googleSaid?: string,
  ) {
    super(message);
    this.name = "ChangeError";
  }
}
