// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { Store } from "@perfoads/store";
import { canonicalJson, sha256Hex } from "./canonical.js";

// Append-only audit log with a hash chain: hash = sha256(prev_hash + canonical event).
// SQLite triggers refuse UPDATE and DELETE on audit_log (store migrations 2 and 7); the
// only delete is retention (retention.ts): the oldest rows, as one prefix, after a
// retention_pruned event that names the last removed row (seq + hash) is appended and
// that checkpoint is saved in retention_checkpoints. The chain is then checked from the
// newest checkpoint, which must match a retention_pruned event still in the log. What
// this proves, stated plainly: an edit or a removed row in the middle breaks the chain;
// cutting rows off the end is only caught against a head exported earlier and kept
// elsewhere. It does not stop someone with full access to the file who rewrites it all.

export const GENESIS_HASH = "0".repeat(64);

export interface AuditEventInput {
  changeId: string | null;
  event: string;
  /** Who did it: "server", or the name the approval path gives for the person. */
  actor: string;
  /** How: "engine", "startup", "elicitation", "browser", "cli", ... */
  via: string;
  /** Small facts only: never secrets, never whole Google replies. */
  data?: Record<string, unknown>;
}

export interface AuditEvent extends Required<AuditEventInput> {
  seq: number;
  at: string;
  prevHash: string;
  hash: string;
}

interface Row {
  seq: number;
  at: string;
  change_id: string | null;
  event: string;
  actor: string;
  via: string;
  data: string;
  prev_hash: string;
  hash: string;
}

const hashOf = (prevHash: string, e: Omit<AuditEvent, "prevHash" | "hash">): string =>
  sha256Hex(
    prevHash +
      canonicalJson({
        seq: e.seq,
        at: e.at,
        changeId: e.changeId,
        event: e.event,
        actor: e.actor,
        via: e.via,
        data: e.data,
      }),
  );

/** Appends one event. Call it inside `store.immediate`, in the same transaction as the change it records. */
export const appendEvent = (store: Store, input: AuditEventInput, at: string): AuditEvent => {
  const last = store.db
    .prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1")
    .get() as { seq: number; hash: string } | undefined;
  const base = {
    seq: (last?.seq ?? 0) + 1,
    at,
    changeId: input.changeId,
    event: input.event,
    actor: input.actor,
    via: input.via,
    data: input.data ?? {},
  };
  const prevHash = last?.hash ?? GENESIS_HASH;
  const hash = hashOf(prevHash, base);
  store.db
    .prepare(
      `INSERT INTO audit_log (seq, at, change_id, event, actor, via, data, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      base.seq,
      at,
      base.changeId,
      base.event,
      base.actor,
      base.via,
      canonicalJson(base.data),
      prevHash,
      hash,
    );
  return { ...base, prevHash, hash };
};

const toEvent = (r: Row): AuditEvent => ({
  seq: Number(r.seq),
  at: r.at,
  changeId: r.change_id,
  event: r.event,
  actor: r.actor,
  via: r.via,
  data: JSON.parse(r.data) as Record<string, unknown>,
  prevHash: r.prev_hash,
  hash: r.hash,
});

export const listEvents = (store: Store, changeId?: string): AuditEvent[] =>
  (
    (changeId === undefined
      ? store.db.prepare("SELECT * FROM audit_log ORDER BY seq").all()
      : store.db
          .prepare("SELECT * FROM audit_log WHERE change_id = ? ORDER BY seq")
          .all(changeId)) as unknown as Row[]
  ).map(toEvent);

/** One page of the log, newest first: events with seq below `beforeSeq` (all when absent). */
export const listRecentEvents = (
  store: Store,
  options: { beforeSeq?: number; limit?: number } = {},
): AuditEvent[] => {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 50)), 200);
  const before = options.beforeSeq ?? Number.MAX_SAFE_INTEGER;
  return (
    store.db
      .prepare("SELECT * FROM audit_log WHERE seq < ? ORDER BY seq DESC LIMIT ?")
      .all(before, limit) as unknown as Row[]
  ).map(toEvent);
};

export interface ChainCheck {
  ok: boolean;
  count: number;
  headHash: string;
  /** First row that does not fit the chain. */
  brokenAtSeq?: number;
  problem?: string;
}

/** The newest retention checkpoint: the chain continues from its hash. */
const latestCheckpoint = (
  store: Store,
): { throughSeq: number; throughHash: string; summarySeq: number } | undefined => {
  const r = store.db
    .prepare(
      "SELECT through_seq, through_hash, summary_seq FROM retention_checkpoints ORDER BY id DESC LIMIT 1",
    )
    .get() as { through_seq: number; through_hash: string; summary_seq: number } | undefined;
  return r
    ? {
        throughSeq: Number(r.through_seq),
        throughHash: r.through_hash,
        summarySeq: Number(r.summary_seq),
      }
    : undefined;
};

/**
 * Walks the log and recomputes every hash: from the start, or after retention from the
 * newest checkpoint (whose seq and hash must be the ones its retention_pruned event names).
 */
export const verifyChain = (store: Store): ChainCheck => {
  const rows = store.db.prepare("SELECT * FROM audit_log ORDER BY seq").all() as unknown as Row[];
  const cp = latestCheckpoint(store);
  let prev = cp?.throughHash ?? GENESIS_HASH;
  let expectedSeq = (cp?.throughSeq ?? 0) + 1;
  if (cp) {
    const summary = rows.find((r) => Number(r.seq) === cp.summarySeq);
    let named: { throughSeq?: unknown; throughHash?: unknown } = {};
    try {
      named = summary ? (JSON.parse(summary.data) as typeof named) : {};
    } catch {
      named = {};
    }
    if (
      summary?.event !== "retention_pruned" ||
      named.throughSeq !== cp.throughSeq ||
      named.throughHash !== cp.throughHash
    ) {
      return {
        ok: false,
        count: rows.length,
        headHash: prev,
        brokenAtSeq: rows[0] ? Number(rows[0].seq) : expectedSeq,
        problem: "the retention checkpoint does not match its retention_pruned event",
      };
    }
  }
  for (const r of rows) {
    const seq = Number(r.seq);
    const fail = (problem: string): ChainCheck => ({
      ok: false,
      count: rows.length,
      headHash: prev,
      brokenAtSeq: seq,
      problem,
    });
    if (seq !== expectedSeq) return fail(`row ${expectedSeq} is missing`);
    if (r.prev_hash !== prev) return fail("does not point at the row before it");
    let event: AuditEvent;
    try {
      event = toEvent(r);
    } catch {
      return fail("its data is not readable");
    }
    if (canonicalJson(event.data) !== r.data) return fail("its data was changed");
    if (hashOf(prev, event) !== r.hash) return fail("its content does not match its hash");
    prev = r.hash;
    expectedSeq++;
  }
  return { ok: true, count: rows.length, headHash: prev };
};

export interface LogHead {
  seq: number;
  hash: string;
  at: string;
}

/** The latest row's hash. Keep a copy elsewhere: a later log must still contain it. */
export const exportHead = (store: Store): LogHead | null => {
  const r = store.db
    .prepare("SELECT seq, hash, at FROM audit_log ORDER BY seq DESC LIMIT 1")
    .get() as { seq: number; hash: string; at: string } | undefined;
  return r ? { seq: Number(r.seq), hash: r.hash, at: r.at } : null;
};

/** True when the log still holds this exported head at the same position. */
export const containsHead = (store: Store, head: LogHead): boolean => {
  const r = store.db.prepare("SELECT hash FROM audit_log WHERE seq = ?").get(head.seq) as
    { hash: string } | undefined;
  return r?.hash === head.hash;
};
