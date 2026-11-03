// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { Store } from "@perfoads/store";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { ChangeError } from "./errors.js";
import { appendEvent, type AuditEventInput } from "./log.js";
import { canMove, isChangeStatus, type ChangeStatus } from "./states.js";

/** One row of the changes table (JSON columns as text). */
export interface ChangeRow {
  id: string;
  customer_id: string;
  login_customer_id: string | null;
  account_name: string;
  currency_code: string;
  type: string;
  payload: string;
  ops: string;
  before: string;
  expected: string;
  diff: string;
  diff_hash: string;
  affected: string;
  facts: string;
  warnings: string;
  reason: string | null;
  risk_tier: string;
  policy: string;
  validate: string;
  undo_support: string;
  /** JSON list of every item key the change touches ("1234567890:campaignBudgets/222"). */
  target_keys: string;
  status: ChangeStatus;
  status_reason: string | null;
  error: string | null;
  expires_at: string;
  created_by: string;
  created_via: string;
  approved_by: string | null;
  approved_via: string | null;
  approved_at: string | null;
  applying_at: string | null;
  applied_at: string | null;
  /** When a write for this change last left for Google (the 10-minute and 30-day clocks). */
  last_sent_at: string | null;
  google_request_ids: string;
  per_op_results: string | null;
  readback: string | null;
  undo_of: string | null;
  created_at: string;
  updated_at: string;
}

/** Columns a status move may also set. Fixed columns (ops, before, ...) are refused by a trigger. */
export type MoveFields = Partial<
  Pick<
    ChangeRow,
    | "status_reason"
    | "error"
    | "approved_by"
    | "approved_via"
    | "approved_at"
    | "applying_at"
    | "applied_at"
    | "google_request_ids"
    | "per_op_results"
    | "readback"
  >
>;

const MOVE_COLUMNS = new Set([
  "status_reason",
  "error",
  "approved_by",
  "approved_via",
  "approved_at",
  "applying_at",
  "applied_at",
  "google_request_ids",
  "per_op_results",
  "readback",
]);

/**
 * The change's version hash: sha256 over the canonical change: what is sent, what it was
 * checked against, and everything the approval view and the policy show (account,
 * currency, diff, affected campaigns, facts, warnings). Approval is bound to it; apply
 * recomputes it from the stored row. It is a version id, never proof of approval.
 */
export interface HashedChange {
  customerId: string;
  loginCustomerId: string | null;
  accountName: string;
  currencyCode: string;
  type: string;
  payload: unknown;
  ops: unknown;
  before: unknown;
  expected: unknown;
  diff: unknown;
  affected: unknown;
  facts: unknown;
  warnings: unknown;
}

export const diffHashOf = (c: HashedChange): string => sha256Hex(canonicalJson({ v: 1, ...c }));

export const rowDiffHash = (r: ChangeRow): string =>
  diffHashOf({
    customerId: r.customer_id,
    loginCustomerId: r.login_customer_id,
    accountName: r.account_name,
    currencyCode: r.currency_code,
    type: r.type,
    payload: JSON.parse(r.payload),
    ops: JSON.parse(r.ops),
    before: JSON.parse(r.before),
    expected: JSON.parse(r.expected),
    diff: JSON.parse(r.diff),
    affected: JSON.parse(r.affected),
    facts: JSON.parse(r.facts),
    warnings: JSON.parse(r.warnings),
  });

export const getRow = (store: Store, id: string): ChangeRow | undefined =>
  store.db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as ChangeRow | undefined;

export const insertChange = (store: Store, row: ChangeRow, event: AuditEventInput): void => {
  store.immediate(() => {
    const cols = Object.keys(row);
    store.db
      .prepare(
        `INSERT INTO changes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...cols.map((c) => row[c as keyof ChangeRow]));
    appendEvent(store, event, row.created_at);
  });
};

/** Thrown inside a move's `check` to stop it; the move is rolled back and this is rethrown. */
export interface MoveOptions {
  /** Runs inside the transaction, before the update, on the row as it is now. Throw to stop. */
  check?: (row: ChangeRow) => void;
  fields?: MoveFields;
  event: Omit<AuditEventInput, "changeId" | "event"> & { event?: string };
  /**
   * The row is already in `to` (another process got there first): return it as it is,
   * with no update and no event, instead of throwing wrong_state.
   */
  idempotent?: boolean;
}

/**
 * The only way a status changes. Inside BEGIN IMMEDIATE:
 * `UPDATE changes SET status = to WHERE id = ? AND status = from` must hit exactly one
 * row, else nothing changes and ChangeError("wrong_state") is thrown. The move is also
 * checked against the state machine here and by the store trigger. The audit event is
 * written in the same transaction.
 */
export const moveStatus = (
  store: Store,
  id: string,
  from: ChangeStatus,
  to: ChangeStatus,
  at: string,
  options: MoveOptions,
): ChangeRow => {
  if (!canMove(from, to)) {
    throw new ChangeError("wrong_state", `A change can't go from ${from} to ${to}.`);
  }
  return store.immediate(() => {
    const row = getRow(store, id);
    if (!row) throw new ChangeError("not_found", `No change with id ${id}.`);
    if (options.idempotent && row.status === to) return row;
    options.check?.(row);
    const fields = options.fields ?? {};
    const keys = Object.keys(fields).filter((k) => MOVE_COLUMNS.has(k));
    const sets = ["status = ?", "updated_at = ?", ...keys.map((k) => `${k} = ?`)].join(", ");
    const result = store.db
      .prepare(`UPDATE changes SET ${sets} WHERE id = ? AND status = ?`)
      .run(to, at, ...keys.map((k) => fields[k as keyof MoveFields] ?? null), id, from);
    if (Number(result.changes) !== 1) {
      if (options.idempotent && row.status === to) return row;
      throw new ChangeError(
        "wrong_state",
        `Change ${id} is ${row.status}, not ${from}, so it can't become ${to}.`,
      );
    }
    appendEvent(
      store,
      {
        changeId: id,
        event: options.event.event ?? to,
        actor: options.event.actor,
        via: options.event.via,
        data: { from, to, ...(options.event.data ?? {}) },
      },
      at,
    );
    const updated = getRow(store, id);
    if (!updated || !isChangeStatus(updated.status)) throw new Error("change row vanished");
    return updated;
  });
};

/**
 * Updates only the reason line, and only while the change is still in the status the
 * caller saw (a note never lands on a row another process just moved). Returns false
 * when it did not apply.
 */
export const noteChange = (
  store: Store,
  id: string,
  observed: ChangeStatus,
  at: string,
  reason: string,
  event: AuditEventInput,
): boolean =>
  store.immediate(() => {
    const r = store.db
      .prepare("UPDATE changes SET status_reason = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(reason, at, id, observed);
    if (Number(r.changes) !== 1) return false;
    appendEvent(store, event, at);
    return true;
  });

/** Records a refusal (nothing changed) in the audit log. */
export const logRefusal = (store: Store, at: string, event: AuditEventInput): void => {
  store.immediate(() => {
    appendEvent(store, event, at);
  });
};

/** Records that a write is about to leave for Google (only while the change is applying). */
export const markSent = (store: Store, id: string, at: string): void => {
  store.immediate(() => {
    store.db
      .prepare(
        "UPDATE changes SET last_sent_at = ?, updated_at = ? WHERE id = ? AND status = 'applying'",
      )
      .run(at, at, id);
  });
};
