// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { afterEach, describe, expect, it } from "vitest";
import { appendEvent, listEvents, verifyChain } from "./log.js";
import { pruneOldRecords } from "./retention.js";
import { makeRig, type Rig } from "./testing/setup.js";

let rig: Rig | undefined;
afterEach(() => {
  rig?.close();
  rig = undefined;
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2027-06-01T00:00:00.000Z");
const OLD = new Date(NOW - 400 * DAY).toISOString();
const OLDER = new Date(NOW - 500 * DAY).toISOString();
const RECENT = new Date(NOW - 10 * DAY).toISOString();
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const insertChange = (
  r: Rig,
  id: string,
  status: string,
  updatedAt: string,
  extra: { undoOf?: string; policyHash?: string } = {},
) => {
  r.store.db
    .prepare(
      `INSERT INTO changes (id, customer_id, account_name, currency_code, type, payload, ops, before, expected,
        diff, diff_hash, affected, facts, warnings, risk_tier, policy, validate, undo_support, status,
        expires_at, created_by, created_via, created_at, updated_at, undo_of)
       VALUES (?, '1234567890', 'n', 'EUR', 'update_budget', '{}', '[]', '{}', '{}', '[]', 'h', '[]', '{}', '[]',
        'confirm', ?, '{}', '{}', ?, '2030-01-01T00:00:00.000Z', 'a', 'v', ?, ?, ?)`,
    )
    .run(
      id,
      JSON.stringify({ hash: extra.policyHash ?? null }),
      status,
      updatedAt,
      updatedAt,
      extra.undoOf ?? null,
    );
};

const event = (r: Rig, changeId: string | null, at: string, name = "note") =>
  r.store.immediate(() =>
    appendEvent(r.store, { changeId, event: name, actor: "server", via: "test" }, at),
  );

const session = (r: Rig, id: string, changeId: string, status: string, at: string) =>
  r.store.db
    .prepare(
      `INSERT INTO approval_sessions (id, change_id, kind, version, code_hash, code_salt, status,
         expires_at, created_at, updated_at)
       VALUES (?, ?, 'approve', 'v', 'h', 's', ?, ?, ?, ?)`,
    )
    .run(id, changeId, status, at, at, at);

const policy = (r: Rig, hash: string, at: string) =>
  r.store.db
    .prepare("INSERT INTO policy_versions (hash, body, first_loaded_at) VALUES (?, '{}', ?)")
    .run(hash, at);

const ids = (r: Rig, table: string, col = "id") =>
  (r.store.db.prepare(`SELECT ${col} AS v FROM ${table} ORDER BY 1`).all() as { v: unknown }[]).map(
    (x) => x.v,
  );

describe("retention", () => {
  it("removes only old records in a final state; logs a summary first; the chain still verifies", () => {
    rig = makeRig();
    const r = rig;
    insertChange(r, "old_verified", "verified", OLD, { policyHash: HASH_A });
    insertChange(r, "old_rejected", "rejected", OLD);
    insertChange(r, "old_in_doubt", "in_doubt", OLD);
    insertChange(r, "old_applying", "applying", OLD);
    insertChange(r, "old_approved", "approved", OLD);
    insertChange(r, "new_verified", "verified", RECENT, { policyHash: HASH_B });
    session(r, "s_old", "old_rejected", "closed", OLD);
    session(r, "s_new", "new_verified", "used", RECENT);
    policy(r, HASH_A, OLDER);
    policy(r, HASH_B, OLDER);
    policy(r, HASH_C, RECENT);
    event(r, null, OLDER, "policy_loaded");
    event(r, "old_verified", OLDER);
    event(r, "old_rejected", OLD);
    event(r, "old_in_doubt", OLD); // seq 4: a kept change, the prefix stops before it
    event(r, "old_verified", OLD);
    event(r, "new_verified", RECENT);
    expect(verifyChain(r.store).ok).toBe(true);

    const result = pruneOldRecords(r.store, { now: NOW, retentionDays: 180 });
    expect(result.counts).toEqual({
      changes: 2,
      approvalSessions: 1,
      policyVersions: 1,
      auditEvents: 3,
    });
    expect(result.checkpoint?.throughSeq).toBe(3);
    expect(ids(r, "changes")).toEqual([
      "new_verified",
      "old_applying",
      "old_approved",
      "old_in_doubt",
    ]);
    expect(ids(r, "approval_sessions")).toEqual(["s_new"]);
    // HASH_A: only its (removed) change named it; HASH_B: a kept change; HASH_C: newest.
    expect(ids(r, "policy_versions", "hash")).toEqual([HASH_B, HASH_C]);
    const events = listEvents(r.store);
    expect(events.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
    const summary = events.at(-1);
    expect(summary?.event).toBe("retention_pruned");
    expect(summary?.data).toMatchObject({
      throughSeq: 3,
      throughHash: result.checkpoint?.throughHash,
      changes: 2,
      auditEvents: 3,
      retentionDays: 180,
    });
    expect(verifyChain(r.store)).toMatchObject({ ok: true, count: 4 });
    expect(r.store.db.prepare("SELECT COUNT(*) AS n FROM prune_window").get()).toEqual({ n: 0 });
  });

  it("outside a prune, the store still refuses every delete", () => {
    rig = makeRig();
    const r = rig;
    insertChange(r, "old_verified", "verified", OLD);
    event(r, "old_verified", OLD);
    policy(r, HASH_A, OLD);
    session(r, "s1", "old_verified", "closed", OLD);
    expect(() => r.store.db.exec("DELETE FROM changes")).toThrow(/never deleted/);
    expect(() => r.store.db.exec("DELETE FROM audit_log")).toThrow(/append-only/);
    expect(() => r.store.db.exec("DELETE FROM policy_versions")).toThrow(/append-only/);
    expect(() => r.store.db.exec("DELETE FROM approval_sessions")).toThrow(/never deleted/);
    // A window does not open in_doubt / applying changes either.
    insertChange(r, "doubt", "in_doubt", OLD);
    r.store.db
      .prepare("INSERT INTO prune_window (id, cutoff, through_seq) VALUES (1, ?, 0)")
      .run(RECENT);
    expect(() => r.store.db.exec("DELETE FROM changes WHERE id = 'doubt'")).toThrow(
      /never deleted/,
    );
  });

  it("keeps an old change that a kept change undoes", () => {
    rig = makeRig();
    const r = rig;
    insertChange(r, "orig", "verified", OLD);
    insertChange(r, "undo", "applied", RECENT, { undoOf: "orig" });
    insertChange(r, "other", "failed", OLD);
    pruneOldRecords(r.store, { now: NOW, retentionDays: 180 });
    expect(ids(r, "changes")).toEqual(["orig", "undo"]);
  });

  it("a second prune moves the checkpoint on; a forged checkpoint fails verification", () => {
    rig = makeRig();
    const r = rig;
    insertChange(r, "a", "verified", new Date(NOW - 700 * DAY).toISOString());
    event(r, "a", new Date(NOW - 700 * DAY).toISOString());
    event(r, null, new Date(NOW - 650 * DAY).toISOString());
    pruneOldRecords(r.store, { now: NOW - 300 * DAY, retentionDays: 180 });
    expect(verifyChain(r.store).ok).toBe(true);
    event(r, null, new Date(NOW - 100 * DAY).toISOString());
    const second = pruneOldRecords(r.store, { now: NOW, retentionDays: 30 });
    expect(second.checkpoint).not.toBeNull();
    expect(verifyChain(r.store).ok).toBe(true);
    expect(listEvents(r.store).map((e) => e.event)).toEqual(["retention_pruned"]);
    // Someone with file access drops the trigger and forges the checkpoint row.
    r.store.db.exec("DROP TRIGGER retention_checkpoints_no_update");
    r.store.db.prepare("UPDATE retention_checkpoints SET through_hash = ?").run(HASH_C);
    expect(verifyChain(r.store)).toMatchObject({ ok: false });
  });

  it("nothing old: writes nothing; retention_days outside 30..3650 is refused", () => {
    rig = makeRig();
    const r = rig;
    insertChange(r, "new", "verified", RECENT);
    event(r, "new", RECENT);
    const result = pruneOldRecords(r.store, { now: NOW, retentionDays: 180 });
    expect(result.counts).toEqual({
      changes: 0,
      approvalSessions: 0,
      policyVersions: 0,
      auditEvents: 0,
    });
    expect(listEvents(r.store)).toHaveLength(1);
    expect(() => pruneOldRecords(r.store, { now: NOW, retentionDays: 29 })).toThrow(RangeError);
    expect(() => pruneOldRecords(r.store, { now: NOW, retentionDays: 3651 })).toThrow(RangeError);
  });
});
