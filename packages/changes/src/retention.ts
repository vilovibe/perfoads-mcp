// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Retention (config.json retention_days, default 180): old records leave the store in one
// transaction. What goes, all older than the cutoff (now - retention_days):
// - changes in a final state (expired, rejected, failed, verified, verify_failed, stale,
//   resolved_by_user, abandoned), by updated_at, except one a kept change undoes;
//   never proposed, approved, applying, in_doubt, applied or partially_applied;
// - finished approval sessions (and every session of a change that goes);
// - policy versions no kept change or kept audit event names (the newest always stays);
// - the oldest audit events, as one prefix: up to the first event that is newer than the
//   cutoff or belongs to a kept change.
// Order: a retention_pruned audit event with the counts and the chain checkpoint (seq and
// hash of the last audit row removed) is written first; the checkpoint also goes to
// retention_checkpoints; then the rows are deleted while a prune_window row tells the
// store triggers (migration 7) which deletes are allowed; the window row is removed again
// before the transaction ends. verifyChain starts from the latest checkpoint.

import type { Store } from "@perfoads/store";
import { appendEvent } from "./log.js";

export const DEFAULT_RETENTION_DAYS = 180;
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

/** Change statuses that never move again: the only ones retention removes. */
export const FINAL_STATUSES = [
  "expired",
  "rejected",
  "failed",
  "verified",
  "verify_failed",
  "stale",
  "resolved_by_user",
  "abandoned",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneCounts {
  changes: number;
  approvalSessions: number;
  policyVersions: number;
  auditEvents: number;
}

export interface PruneResult {
  cutoff: string;
  counts: PruneCounts;
  /** The last audit row removed (the chain continues from its hash); null when none. */
  checkpoint: { throughSeq: number; throughHash: string } | null;
}

const final = FINAL_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * Removes records older than `retentionDays` (30..3650) that are in a final state.
 * Writes nothing when nothing qualifies. Throws only on a store error (the caller logs it).
 */
export const pruneOldRecords = (
  store: Store,
  options: { now: number; retentionDays: number; actor?: string },
): PruneResult => {
  const days = Math.trunc(options.retentionDays);
  if (!(days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS)) {
    throw new RangeError(`retention_days must be ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`);
  }
  const at = new Date(options.now).toISOString();
  const cutoff = new Date(options.now - days * DAY_MS).toISOString();
  const db = store.db;

  return store.immediate((): PruneResult => {
    // Open sessions past their expiry are finished (as getSession would mark them); their
    // updated_at stays, so an old one is old.
    db.prepare(
      "UPDATE approval_sessions SET status = 'expired' WHERE status = 'open' AND expires_at <= ?",
    ).run(at);

    // Candidate changes (all their sessions old and finished too), then drop any that a
    // kept change points at (undo_of), until stable.
    const candidates = new Set(
      (
        db
          .prepare(
            `SELECT id FROM changes c WHERE status IN (${final}) AND updated_at < ?
               AND NOT EXISTS (SELECT 1 FROM approval_sessions s WHERE s.change_id = c.id
                               AND (s.status = 'open' OR s.updated_at >= ?))`,
          )
          .all(cutoff, cutoff) as { id: string }[]
      ).map((r) => r.id),
    );
    const links = db.prepare("SELECT id, undo_of FROM changes WHERE undo_of IS NOT NULL").all() as {
      id: string;
      undo_of: string;
    }[];
    for (let moved = true; moved;) {
      moved = false;
      for (const l of links) {
        if (!candidates.has(l.id) && candidates.delete(l.undo_of)) moved = true;
      }
    }
    const ids = [...candidates];

    db.exec("CREATE TEMP TABLE IF NOT EXISTS prune_changes (id TEXT PRIMARY KEY)");
    db.exec("DELETE FROM prune_changes");
    const addId = db.prepare("INSERT INTO prune_changes (id) VALUES (?)");
    for (const id of ids) addId.run(id);

    const sessions = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM approval_sessions
             WHERE change_id IN (SELECT id FROM prune_changes)
                OR (status <> 'open' AND updated_at < ?)`,
          )
          .get(cutoff) as { n: number }
      ).n,
    );

    // The audit prefix: older than the cutoff, and before the first event of a kept change.
    const lastOld = (
      db.prepare("SELECT MAX(seq) AS s FROM audit_log WHERE at < ?").get(cutoff) as {
        s: number | null;
      }
    ).s;
    const firstOfKept = (
      db
        .prepare(
          `SELECT MIN(seq) AS s FROM audit_log
           WHERE change_id IN (SELECT id FROM changes WHERE id NOT IN (SELECT id FROM prune_changes))`,
        )
        .get() as { s: number | null }
    ).s;
    // Every row up to throughSeq must also be older than the cutoff (the log is in time order).
    const firstNew = (
      db.prepare("SELECT MIN(seq) AS s FROM audit_log WHERE at >= ?").get(cutoff) as {
        s: number | null;
      }
    ).s;
    const limits = [lastOld ?? 0];
    if (firstOfKept !== null) limits.push(firstOfKept - 1);
    if (firstNew !== null) limits.push(firstNew - 1);
    const throughSeq = Math.max(0, Math.min(...limits));
    const through =
      throughSeq > 0
        ? (db.prepare("SELECT seq, hash FROM audit_log WHERE seq = ?").get(throughSeq) as
            { seq: number; hash: string } | undefined)
        : undefined;
    const auditEvents = through
      ? Number(
          (
            db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE seq <= ?").get(throughSeq) as {
              n: number;
            }
          ).n,
        )
      : 0;

    // Policy versions still named by a kept change or a kept audit event stay; so does the newest.
    const keptHashes = new Set<string>();
    for (const r of db
      .prepare(
        `SELECT json_extract(policy, '$.hash') AS h FROM changes
         WHERE id NOT IN (SELECT id FROM prune_changes)`,
      )
      .all() as { h: unknown }[]) {
      if (typeof r.h === "string") keptHashes.add(r.h);
    }
    for (const r of db
      .prepare(
        `SELECT json_extract(data, '$.hash') AS h, json_extract(data, '$.policyHash') AS p
         FROM audit_log WHERE seq > ? AND json_valid(data)`,
      )
      .all(through ? throughSeq : 0) as { h: unknown; p: unknown }[]) {
      if (typeof r.h === "string") keptHashes.add(r.h);
      if (typeof r.p === "string") keptHashes.add(r.p);
    }
    const newest = db
      .prepare("SELECT hash FROM policy_versions ORDER BY first_loaded_at DESC LIMIT 1")
      .get() as { hash: string } | undefined;
    if (newest) keptHashes.add(newest.hash);
    const oldPolicies = (
      db.prepare("SELECT hash FROM policy_versions WHERE first_loaded_at < ?").all(cutoff) as {
        hash: string;
      }[]
    )
      .map((r) => r.hash)
      .filter((h) => !keptHashes.has(h));

    const counts: PruneCounts = {
      changes: ids.length,
      approvalSessions: sessions,
      policyVersions: oldPolicies.length,
      auditEvents,
    };
    const checkpoint = through
      ? { throughSeq: Number(through.seq), throughHash: through.hash }
      : null;
    if (Object.values(counts).every((n) => n === 0)) {
      db.exec("DELETE FROM prune_changes");
      return { cutoff, counts, checkpoint: null };
    }

    // 1. The summary (and the chain checkpoint) goes into the log first.
    const summary = appendEvent(
      store,
      {
        changeId: null,
        event: "retention_pruned",
        actor: options.actor ?? "server",
        via: "retention",
        data: {
          cutoff,
          retentionDays: days,
          ...counts,
          throughSeq: checkpoint?.throughSeq ?? null,
          throughHash: checkpoint?.throughHash ?? null,
        },
      },
      at,
    );
    if (checkpoint) {
      db.prepare(
        `INSERT INTO retention_checkpoints (at, cutoff, through_seq, through_hash, summary_seq, counts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        at,
        cutoff,
        checkpoint.throughSeq,
        checkpoint.throughHash,
        summary.seq,
        JSON.stringify(counts),
      );
    }

    // 2. Delete, with the window open for this transaction only.
    db.prepare("INSERT INTO prune_window (id, cutoff, through_seq) VALUES (1, ?, ?)").run(
      cutoff,
      checkpoint?.throughSeq ?? 0,
    );
    db.prepare(
      `DELETE FROM approval_sessions
       WHERE change_id IN (SELECT id FROM prune_changes) OR (status <> 'open' AND updated_at < ?)`,
    ).run(cutoff);
    db.exec("DELETE FROM changes WHERE id IN (SELECT id FROM prune_changes)");
    const dropPolicy = db.prepare("DELETE FROM policy_versions WHERE hash = ?");
    for (const h of oldPolicies) dropPolicy.run(h);
    if (checkpoint) {
      db.prepare("DELETE FROM audit_log WHERE seq <= ?").run(checkpoint.throughSeq);
    }
    db.exec("DELETE FROM prune_window");
    db.exec("DELETE FROM prune_changes");
    return { cutoff, counts, checkpoint };
  });
};
