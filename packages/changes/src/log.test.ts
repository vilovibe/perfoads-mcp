// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { afterEach, describe, expect, it } from "vitest";
import { ChangeError } from "./errors.js";
import { appendEvent, containsHead, exportHead, listEvents, verifyChain } from "./log.js";
import { moveStatus, noteChange } from "./repo.js";
import { CHANGE_STATUSES, CHANGE_TRANSITIONS, canMove } from "./states.js";
import { budgetChange, makeRig, type Rig } from "./testing/setup.js";

let rig: Rig | undefined;
afterEach(() => {
  rig?.close();
  rig = undefined;
});

/** A bare row in a given status, inserted straight into SQL (bypassing the engine). */
const insertRaw = (r: Rig, id: string, status: string) => {
  r.store.db
    .prepare(
      `INSERT INTO changes (id, customer_id, account_name, currency_code, type, payload, ops, before, expected,
        diff, diff_hash, affected, facts, warnings, risk_tier, policy, validate, undo_support, status,
        expires_at, created_by, created_via, created_at, updated_at)
       VALUES (?, '1234567890', 'n', 'EUR', 'update_budget', '{}', '[]', '{}', '{}', '[]', 'h', '[]', '{}', '[]',
        'confirm', '{}', '{}', '{}', ?, '2030-01-01T00:00:00.000Z', 'a', 'v', 'x', 'x')`,
    )
    .run(id, status);
};

describe("state machine", () => {
  it("the store trigger allows exactly the moves in CHANGE_TRANSITIONS", () => {
    rig = makeRig();
    const r = rig;
    let n = 0;
    for (const from of CHANGE_STATUSES) {
      for (const to of CHANGE_STATUSES) {
        if (from === to) continue;
        const id = `raw_${n++}`;
        insertRaw(r, id, from);
        // The approval columns are filled on every move (the approval trigger needs them).
        const run = () =>
          r.store.db
            .prepare(
              "UPDATE changes SET status = ?, approved_by = 'Pat', approved_via = 'cli', approved_at = 'x' WHERE id = ?",
            )
            .run(to, id);
        if (canMove(from, to)) expect(run, `${from} -> ${to}`).not.toThrow();
        else expect(run, `${from} -> ${to}`).toThrow(/status move not allowed/);
      }
    }
    expect(n).toBe(CHANGE_STATUSES.length * (CHANGE_STATUSES.length - 1));
  });

  it("terminal states have no way out, and in_doubt can never go back to applying or approved", () => {
    for (const s of [
      "expired",
      "rejected",
      "failed",
      "verified",
      "verify_failed",
      "stale",
    ] as const) {
      expect(CHANGE_TRANSITIONS[s]).toEqual([]);
    }
    expect(canMove("in_doubt", "applying")).toBe(false);
    expect(canMove("in_doubt", "approved")).toBe(false);
    expect(canMove("failed", "applying")).toBe(false);
    expect(canMove("proposed", "applying")).toBe(false);
  });

  it("moveStatus refuses a move outside the table and a wrong current status (no row changed, no event)", () => {
    rig = makeRig();
    insertRaw(rig, "c1", "proposed");
    const at = new Date().toISOString();
    const ev = { event: { actor: "server", via: "test" } };
    expect(() => moveStatus((rig as Rig).store, "c1", "proposed", "applying", at, ev)).toThrow(
      /can't go from proposed to applying/,
    );
    const err = (() => {
      try {
        moveStatus((rig as Rig).store, "c1", "approved", "applying", at, ev);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ChangeError);
    expect((err as ChangeError).code).toBe("wrong_state");
    expect(listEvents(rig.store)).toHaveLength(0);
    moveStatus(rig.store, "c1", "proposed", "approved", at, {
      ...ev,
      fields: { approved_by: "Pat", approved_via: "cli", approved_at: at },
    });
    expect(listEvents(rig.store, "c1").map((e) => e.event)).toEqual(["approved"]);
  });

  it("a note only lands while the change is in the status the writer saw", () => {
    rig = makeRig();
    insertRaw(rig, "c1", "failed");
    const ev = { changeId: "c1", event: "note", actor: "server", via: "test" };
    expect(noteChange(rig.store, "c1", "in_doubt", "x", "late note", ev)).toBe(false);
    expect(listEvents(rig.store, "c1")).toHaveLength(0);
    expect(noteChange(rig.store, "c1", "failed", "x", "note", ev)).toBe(true);
    expect(listEvents(rig.store, "c1")).toHaveLength(1);
  });

  it("the fields a change was approved on can't be edited, and changes are never deleted", () => {
    rig = makeRig();
    insertRaw(rig, "c1", "proposed");
    const db = rig.store.db;
    for (const col of [
      "ops",
      "before",
      "payload",
      "diff_hash",
      "expected",
      "customer_id",
      "type",
    ]) {
      expect(
        () => db.prepare(`UPDATE changes SET ${col} = 'x' WHERE id = 'c1'`).run(),
        col,
      ).toThrow(/cannot be edited/);
    }
    expect(() => db.prepare("DELETE FROM changes WHERE id = 'c1'").run()).toThrow(/never deleted/);
  });
});

describe("approval binding in the store", () => {
  it("proposed -> approved needs who, how (a known path) and when; the approval can't be edited later", () => {
    rig = makeRig();
    insertRaw(rig, "c1", "proposed");
    const db = rig.store.db;
    const up = (sql: string) => () => db.prepare(sql).run();
    expect(up("UPDATE changes SET status = 'approved' WHERE id = 'c1'")).toThrow(
      /needs who approved/,
    );
    expect(
      up(
        "UPDATE changes SET status = 'approved', approved_by = ' ', approved_via = 'cli', approved_at = 'x' WHERE id = 'c1'",
      ),
    ).toThrow(/needs who approved/);
    expect(
      up(
        "UPDATE changes SET status = 'approved', approved_by = 'Pat', approved_via = 'chat', approved_at = 'x' WHERE id = 'c1'",
      ),
    ).toThrow(/needs who approved/);
    up(
      "UPDATE changes SET status = 'approved', approved_by = 'Pat', approved_via = 'cli', approved_at = 'x' WHERE id = 'c1'",
    )();
    expect(up("UPDATE changes SET approved_by = 'Mallory' WHERE id = 'c1'")).toThrow(
      /cannot be edited/,
    );
  });

  it("what the approval view showed is frozen after propose", () => {
    rig = makeRig();
    insertRaw(rig, "c1", "proposed");
    const db = rig.store.db;
    for (const col of [
      "facts",
      "affected",
      "warnings",
      "account_name",
      "currency_code",
      "expires_at",
      "risk_tier",
      "policy",
      "diff",
    ]) {
      expect(
        () => db.prepare(`UPDATE changes SET ${col} = 'x' WHERE id = 'c1'`).run(),
        col,
      ).toThrow(/cannot be edited/);
    }
  });
});

describe("audit log", () => {
  it("every step of a change is logged with actor and via, and the chain verifies", async () => {
    rig = makeRig();
    const c = await rig.engine.propose(budgetChange());
    rig.engine.markApproved(c.id, c.version, "cli", "Pat");
    await rig.engine.apply(c.id, { actor: "Pat", via: "cli" });
    const events = listEvents(rig.store, c.id);
    expect(events.map((e) => e.event)).toEqual([
      "proposed",
      "approved",
      "applying",
      "applied",
      "verified",
    ]);
    expect(events.map((e) => `${e.actor}/${e.via}`)).toEqual([
      "agent/mcp",
      "Pat/cli",
      "Pat/cli",
      "Pat/cli",
      "server/engine",
    ]);
    const check = verifyChain(rig.store);
    expect(check).toMatchObject({ ok: true, count: 5 });
    expect(exportHead(rig.store)?.hash).toBe(check.headHash);
  });

  it("triggers refuse UPDATE and DELETE on audit_log", async () => {
    rig = makeRig();
    await rig.engine.propose(budgetChange());
    const db = rig.store.db;
    expect(() => db.prepare("UPDATE audit_log SET actor = 'someone' WHERE seq = 1").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
    expect(verifyChain(rig.store).ok).toBe(true);
  });

  it("detects an edited row, a removed row and a cut-off tail (against an exported head)", async () => {
    rig = makeRig();
    const db = rig.store.db;
    for (let i = 0; i < 4; i++) {
      rig.store.immediate(() =>
        appendEvent(
          (rig as Rig).store,
          { changeId: null, event: `e${i}`, actor: "server", via: "test", data: { i } },
          "2026-10-25T10:00:00.000Z",
        ),
      );
    }
    const head = exportHead(rig.store);
    expect(head?.seq).toBe(4);
    // An attacker with file access drops the triggers first.
    db.exec("DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;");
    db.prepare(`UPDATE audit_log SET data = '{"i":99}' WHERE seq = 2`).run();
    expect(verifyChain(rig.store)).toMatchObject({ ok: false, brokenAtSeq: 2 });
    db.prepare(`UPDATE audit_log SET data = '{"i":1}' WHERE seq = 2`).run();
    expect(verifyChain(rig.store).ok).toBe(true);
    db.prepare("UPDATE audit_log SET actor = 'Pat' WHERE seq = 3").run();
    expect(verifyChain(rig.store)).toMatchObject({ ok: false, brokenAtSeq: 3 });
    db.prepare("UPDATE audit_log SET actor = 'server' WHERE seq = 3").run();
    db.prepare("DELETE FROM audit_log WHERE seq = 2").run();
    expect(verifyChain(rig.store)).toMatchObject({ ok: false, brokenAtSeq: 3 });
    db.prepare("DELETE FROM audit_log WHERE seq >= 3").run();
    // Rows 1 only: the chain itself is fine, the exported head is not in it any more.
    db.prepare("DELETE FROM audit_log WHERE seq > 1").run();
    expect(verifyChain(rig.store).ok).toBe(true);
    expect(head && containsHead(rig.store, head)).toBe(false);
  });
});
