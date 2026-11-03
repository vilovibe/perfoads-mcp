// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { afterEach, describe, expect, it } from "vitest";
import { budgetParams, changeRig, readPage, type ChangeRig } from "../testing/changeRig.js";
import { createApprovalService } from "./service.js";
import {
  checkCode,
  CODE_ALPHABET,
  createSession,
  getSession,
  hashCode,
  markServed,
  SCRYPT,
  SESSION_LIFETIME_MS,
  finishSession,
  MAX_CODE_ATTEMPTS,
  newCode,
  normaliseCode,
  setStateNonce,
  takeStateNonce,
} from "./sessions.js";

const rigs: ChangeRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

const setup = async () => {
  const r = changeRig();
  rigs.push(r);
  const change = await r.rt.engine().propose({
    customerId: "1234567890",
    type: "update_budget",
    input: budgetParams(),
    actor: "agent",
    via: "mcp",
  });
  return { r, change, store: r.rt.store(), now: () => r.clock.now };
};

describe("approval codes", () => {
  it("6 characters from an alphabet without 0/O, 1/I/L", () => {
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
    for (let i = 0; i < 300; i++) expect(newCode()).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(normaliseCode(" abc-234 ")).toBe("ABC234");
  });

  it("is stored only as a scrypt hash with a per-session salt; one check takes a measurable time", async () => {
    const { change, store, now } = await setup();
    const { session, code } = await createSession(store, { change, kind: "approve", now: now() });
    const rows = store.db.prepare("SELECT * FROM approval_sessions").all() as {
      code_hash: string;
      code_salt: string;
    }[];
    expect(JSON.stringify(rows)).not.toContain(code);
    const row = rows[0];
    expect(row?.code_salt.length).toBeGreaterThanOrEqual(20);
    const expected = await hashCode(code, session.id, row?.code_salt ?? "");
    expect(Buffer.from(row?.code_hash ?? "", "base64url").equals(expected)).toBe(true);
    expect(SCRYPT.N).toBeGreaterThanOrEqual(2 ** 15);
    const t0 = performance.now();
    await hashCode("ABC234", session.id, row?.code_salt ?? "");
    const ms = performance.now() - t0;
    console.log(`scrypt check: ${ms.toFixed(1)} ms`);
    expect(ms).toBeGreaterThan(5);
  });

  it("finishSession checks the session row itself: burned, expired or not used -> refused", async () => {
    const { change, store, r } = await setup();
    const { session, code } = await createSession(store, {
      change,
      kind: "approve",
      now: r.clock.now,
    });
    expect((await checkCode(store, session.id, code, r.clock.now)).ok).toBe(true);
    // Past expiry at finish time: refused even though the code was right.
    expect(() =>
      finishSession(
        store,
        r.rt.engine(),
        session.id,
        "cli",
        "x",
        Date.parse(session.expiresAt) + 1,
      ),
    ).toThrow(/not completed/);
    expect(r.rt.engine().get(change.id)?.status).toBe("proposed");
    expect(() => finishSession(store, r.rt.engine(), "apr_nope", "cli", "x", r.clock.now)).toThrow(
      /not completed/,
    );
  });

  it("a page and its code live at most 10 minutes", async () => {
    const { change, store, now } = await setup();
    const t = now();
    const { session } = await createSession(store, { change, kind: "approve", now: t });
    expect(Date.parse(session.expiresAt) - t).toBe(SESSION_LIFETIME_MS);
    expect(SESSION_LIFETIME_MS).toBe(10 * 60 * 1000);
  });

  it("five wrong codes burn the session: the right code no longer works", async () => {
    const { change, store, now, r } = await setup();
    const { session, code } = await createSession(store, { change, kind: "approve", now: now() });
    const wrong = code === "ZZZZZZ" ? "YYYYYY" : "ZZZZZZ";
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
      expect(await checkCode(store, session.id, wrong, now())).toEqual({
        ok: false,
        reason: "wrong",
        attemptsLeft: MAX_CODE_ATTEMPTS - i,
      });
    }
    expect(await checkCode(store, session.id, wrong, now())).toEqual({
      ok: false,
      reason: "burned",
    });
    expect(await checkCode(store, session.id, code, now())).toEqual({
      ok: false,
      reason: "burned",
    });
    expect(r.rt.engine().get(change.id)?.status).toBe("proposed");
  });

  it("the right code works once (single use); then the session is used", async () => {
    const { change, store, now, r } = await setup();
    const { session, code } = await createSession(store, { change, kind: "approve", now: now() });
    const first = await checkCode(store, session.id, code.toLowerCase(), now());
    expect(first.ok).toBe(true);
    expect(await checkCode(store, session.id, code, now())).toEqual({
      ok: false,
      reason: "not_open",
    });
    if (!first.ok) throw new Error("unreachable");
    const v = finishSession(store, r.rt.engine(), first.session.id, "cli", "test-person", now());
    expect(v.status).toBe("approved");
    expect(v.approvedVia).toBe("cli");
  });

  it("a session past its expiry refuses the right code", async () => {
    const { change, store, r } = await setup();
    const { session, code } = await createSession(store, {
      change,
      kind: "approve",
      now: r.clock.now,
    });
    r.clock.now = Date.parse(session.expiresAt) + 1;
    expect(await checkCode(store, session.id, code, r.clock.now)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("a new session closes the old one: one live code per change", async () => {
    const { change, store, now } = await setup();
    const a = await createSession(store, { change, kind: "approve", now: now() });
    await createSession(store, { change, kind: "approve", now: now() });
    expect(await checkCode(store, a.session.id, a.code, now())).toEqual({
      ok: false,
      reason: "not_open",
    });
  });

  it("finishSession refuses a session that was not completed", async () => {
    const { change, store, now, r } = await setup();
    const { session } = await createSession(store, { change, kind: "approve", now: now() });
    expect(() => finishSession(store, r.rt.engine(), session.id, "browser", "x", now())).toThrow(
      /not completed/,
    );
    expect(r.rt.engine().get(change.id)?.status).toBe("proposed");
  });

  it("an elicitation nonce is single use and only the latest one counts", async () => {
    const { change, store, now } = await setup();
    const { session } = await createSession(store, { change, kind: "approve", now: now() });
    const n1 = setStateNonce(store, session.id, now());
    const n2 = setStateNonce(store, session.id, now());
    expect(takeStateNonce(store, session.id, n1, now())).toBe(false);
    expect(takeStateNonce(store, session.id, n2, now())).toBe(true);
    expect(takeStateNonce(store, session.id, n2, now())).toBe(false);
  });

  it("the store refuses to reopen a finished session", async () => {
    const { change, store, now } = await setup();
    const { session, code } = await createSession(store, { change, kind: "approve", now: now() });
    await checkCode(store, session.id, code, now());
    expect(() =>
      store.db.prepare("UPDATE approval_sessions SET status = 'open' WHERE id = ?").run(session.id),
    ).toThrow(/cannot open again/);
  });
});

describe("approval sessions across processes", () => {
  it("a served session for the same change, version and kind is never closed by a new one", async () => {
    const { change, store, now } = await setup();
    const served = await createSession(store, { change, kind: "approve", now: now() });
    markServed(store, served.session.id, now());
    const other = await createSession(store, { change, kind: "approve", now: now() });
    expect(getSession(store, served.session.id, now())?.status).toBe("open");
    // Not served (no page shows its code): replaced by the next one.
    await createSession(store, { change, kind: "approve", now: now() });
    expect(getSession(store, other.session.id, now())?.status).toBe("closed");
    expect(await checkCode(store, served.session.id, served.code, now())).toMatchObject({
      ok: true,
    });
  });

  it("AI apply -> person's approvals open -> AI apply again: the person's code still approves", async () => {
    const { r, change, now } = await setup();
    const ai = r.rt.approvals();
    // The person's terminal: a second process (its own approval service) on the same store.
    const person = createApprovalService({
      store: r.rt.store,
      engine: r.rt.engine,
      now,
      openUrl: () => true,
      user: () => "test-person",
      logger: r.rt.logger,
      mode: "auto",
    });
    try {
      const first = await ai.open(change, "approve", { testAccount: true, clientHasForms: true });
      expect(first.reused).toBe(false);
      const { session, page } = await person.openForTerminal(change);
      const { code } = await readPage(page.url);
      expect(code).toMatch(/^[2-9A-Z]{6}$/);
      const again = await ai.open(change, "approve", { testAccount: true, clientHasForms: true });
      expect(again).toMatchObject({ reused: true, elsewhere: true });
      expect(again.session.id).toBe(session.id);
      expect(getSession(r.rt.store(), session.id, now())?.status).toBe("open");
      const result = await person.completeWithCode(session.id, code, "cli");
      expect(result.ok).toBe(true);
      expect(r.rt.engine().get(change.id)?.status).toBe("approved");
    } finally {
      person.closeAll();
    }
  });
});
