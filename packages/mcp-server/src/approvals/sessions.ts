// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Approval sessions (plan 6.2, 9.1): one per approval page. The page shows a 6-character
// code; a person completes the approval by clicking Approve on the page, or by typing the
// code into the AI app's form (elicitation) or into the terminal (`approve <id>`, TTY
// only). The code is stored only as a scrypt hash, attempts are limited, and a session is
// used once. markApproved / markResolved are called from finishSession only.

import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import {
  ChangeError,
  type ApprovalVia,
  type ChangeEngine,
  type ChangeView,
  type ResolveOutcome,
} from "@perfoads/changes";
import type { Store } from "@perfoads/store";

/** No 0/O, 1/I/L: every character reads one way. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 6;
/** Wrong codes allowed per session; then it is burned and a new page must be opened. */
export const MAX_CODE_ATTEMPTS = 5;
/** A page and its code live at most this long (less when the change expires sooner). */
export const SESSION_LIFETIME_MS = 10 * 60 * 1000;
/** scrypt cost: N = 2^15, r = 8, p = 1 (32 MiB, tens of ms per check). */
export const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024, keylen: 32 } as const;

export type SessionKind = "approve" | "resolve";
export type SessionStatus = "open" | "used" | "burned" | "closed" | "expired";

export interface ApprovalSession {
  id: string;
  changeId: string;
  kind: SessionKind;
  /** The change version the person is shown (its diff hash). */
  version: string;
  outcome: ResolveOutcome | null;
  note: string | null;
  attempts: number;
  status: SessionStatus;
  expiresAt: string;
  /** A page shows its code (this process or another one). */
  served: boolean;
}

interface Row {
  id: string;
  change_id: string;
  kind: SessionKind;
  version: string;
  outcome: ResolveOutcome | null;
  note: string | null;
  code_hash: string;
  code_salt: string;
  attempts: number;
  state_nonce: string | null;
  status: SessionStatus;
  expires_at: string;
  created_at: string;
  updated_at: string;
  served: number;
}

const toSession = (r: Row): ApprovalSession => ({
  id: r.id,
  changeId: r.change_id,
  kind: r.kind,
  version: r.version,
  outcome: r.outcome,
  note: r.note,
  attempts: r.attempts,
  status: r.status,
  expiresAt: r.expires_at,
  served: Number(r.served) === 1,
});

/** The person at this computer, as the approval records them. */
export const localUser = (): string => {
  try {
    const name = userInfo().username.trim();
    // eslint-disable-next-line no-control-regex
    if (name && name.length <= 60 && !/[\u0000-\u001f\u007f]/.test(name)) return name;
  } catch {
    // No user database entry (some containers).
  }
  return "local user";
};

export const newCode = (): string =>
  Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(
    "",
  );

/** Typed text -> code shape: upper case, spaces and dashes dropped. */
export const normaliseCode = (typed: unknown): string =>
  typeof typed === "string" ? typed.toUpperCase().replace(/[\s-]/g, "").slice(0, 32) : "";

/** "ABC234" -> "ABC 234" for reading. */
export const formatCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

/** scrypt(code, salt = session id + random). Slow on purpose: a copied store can't be brute-forced fast. */
export const hashCode = (code: string, sessionId: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const { keylen, ...cost } = SCRYPT;
    scrypt(
      code,
      `perfoads.approval-code\u0000${sessionId}\u0000${salt}`,
      keylen,
      cost,
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });

const iso = (ms: number) => new Date(ms).toISOString();

const getRow = (store: Store, id: string): Row | undefined =>
  store.db.prepare("SELECT * FROM approval_sessions WHERE id = ?").get(id) as Row | undefined;

/** Moves open sessions past their expiry to expired. */
const expireSessions = (store: Store, now: number): void => {
  store.db
    .prepare(
      "UPDATE approval_sessions SET status = 'expired', updated_at = ? WHERE status = 'open' AND expires_at <= ?",
    )
    .run(iso(now), iso(now));
};

/**
 * Same change, version and kind (and, to settle, the same outcome and note): a page for
 * one stands for the other.
 */
export const sameApproval = (
  s: ApprovalSession,
  change: Pick<ChangeView, "id" | "version">,
  kind: SessionKind,
  outcome: ResolveOutcome | null = null,
  note: string | null = null,
): boolean =>
  s.changeId === change.id &&
  s.version === change.version &&
  s.kind === kind &&
  (kind === "approve" || (s.outcome === outcome && s.note === note));

/**
 * Opens a new session for a change and returns it with its code (shown on the page
 * only). Earlier open sessions of the change are closed when they are stale (another
 * version or kind) or no page shows them; a served session for the same change, version
 * and kind is never closed here: it may be another process's page (`approvals open` in a
 * terminal) whose code a person is about to type.
 */
export const createSession = async (
  store: Store,
  input: {
    change: ChangeView;
    kind: SessionKind;
    now: number;
    outcome?: ResolveOutcome;
    note?: string;
  },
): Promise<{ session: ApprovalSession; code: string }> => {
  const { change, kind, now } = input;
  const expires =
    kind === "approve"
      ? Math.min(Date.parse(change.expiresAt), now + SESSION_LIFETIME_MS)
      : now + SESSION_LIFETIME_MS;
  if (!(expires > now)) {
    throw new ChangeError(
      "expired",
      "This change expired before it was approved. Propose it again.",
    );
  }
  const id = `apr_${randomBytes(12).toString("hex")}`;
  const salt = randomBytes(16).toString("base64url");
  const code = newCode();
  const hash = (await hashCode(code, id, salt)).toString("base64url");
  store.immediate(() => {
    expireSessions(store, now);
    store.db
      .prepare(
        `UPDATE approval_sessions SET status = 'closed', updated_at = ?
         WHERE change_id = ? AND status = 'open'
           AND NOT (served = 1 AND version = ? AND kind = ?
             AND (kind = 'approve' OR (outcome IS ? AND note IS ?)))`,
      )
      .run(iso(now), change.id, change.version, kind, input.outcome ?? null, input.note ?? null);
    store.db
      .prepare(
        `INSERT INTO approval_sessions (id, change_id, kind, version, outcome, note, code_hash,
           code_salt, attempts, state_nonce, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'open', ?, ?, ?)`,
      )
      .run(
        id,
        change.id,
        kind,
        change.version,
        input.outcome ?? null,
        input.note ?? null,
        hash,
        salt,
        iso(expires),
        iso(now),
        iso(now),
      );
  });
  const row = getRow(store, id);
  if (!row) throw new Error("approval session not saved");
  return { session: toSession(row), code };
};

export const getSession = (store: Store, id: string, now: number): ApprovalSession | undefined => {
  expireSessions(store, now);
  const row = getRow(store, id);
  return row ? toSession(row) : undefined;
};

/** The open session for a change, if there is one. */
export const openSessionFor = (
  store: Store,
  changeId: string,
  now: number,
): ApprovalSession | undefined => {
  expireSessions(store, now);
  const row = store.db
    .prepare(
      "SELECT * FROM approval_sessions WHERE change_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1",
    )
    .get(changeId) as Row | undefined;
  return row ? toSession(row) : undefined;
};

/** Every open session of a change, newest first. */
export const openSessionsFor = (store: Store, changeId: string, now: number): ApprovalSession[] => {
  expireSessions(store, now);
  return (
    store.db
      .prepare(
        "SELECT * FROM approval_sessions WHERE change_id = ? AND status = 'open' ORDER BY created_at DESC",
      )
      .all(changeId) as unknown as Row[]
  ).map(toSession);
};

/** A page now shows this session's code. False when it is no longer open. */
export const markServed = (store: Store, id: string, now: number): boolean =>
  store.immediate(
    () =>
      Number(
        store.db
          .prepare(
            "UPDATE approval_sessions SET served = 1, updated_at = ? WHERE id = ? AND status = 'open'",
          )
          .run(iso(now), id).changes,
      ) === 1,
  );

/** open -> status. False when the session was no longer open (someone else finished it). */
export const endSession = (
  store: Store,
  id: string,
  status: Exclude<SessionStatus, "open">,
  now: number,
): boolean =>
  store.immediate(
    () =>
      Number(
        store.db
          .prepare(
            "UPDATE approval_sessions SET status = ?, updated_at = ? WHERE id = ? AND status = 'open'",
          )
          .run(status, iso(now), id).changes,
      ) === 1,
  );

export type CodeCheck =
  | { ok: true; session: ApprovalSession }
  | { ok: false; reason: "wrong"; attemptsLeft: number }
  | { ok: false; reason: "burned" | "expired" | "not_open" };

/**
 * Checks a typed code. Right code: the session is used (single use) and returned. Wrong
 * code: one attempt is counted; the fifth wrong code burns the session.
 */
export const checkCode = async (
  store: Store,
  sessionId: string,
  typed: unknown,
  now: number,
): Promise<CodeCheck> => {
  const before = getRow(store, sessionId);
  const code = normaliseCode(typed);
  // Hashed before the transaction (it takes tens of ms); compared inside it.
  const given = before ? await hashCode(code, before.id, before.code_salt) : Buffer.alloc(0);
  return store.immediate((): CodeCheck => {
    expireSessions(store, now);
    const row = getRow(store, sessionId);
    if (!row) return { ok: false, reason: "not_open" };
    if (row.status === "expired") return { ok: false, reason: "expired" };
    if (row.status === "burned") return { ok: false, reason: "burned" };
    if (row.status !== "open") return { ok: false, reason: "not_open" };
    const stored = Buffer.from(row.code_hash, "base64url");
    const right =
      code.length === CODE_LENGTH &&
      given.length === stored.length &&
      timingSafeEqual(given, stored);
    if (right) {
      store.db
        .prepare(
          "UPDATE approval_sessions SET status = 'used', state_nonce = NULL, updated_at = ? WHERE id = ? AND status = 'open'",
        )
        .run(iso(now), row.id);
      return { ok: true, session: toSession({ ...row, status: "used" }) };
    }
    const attempts = row.attempts + 1;
    const burned = attempts >= MAX_CODE_ATTEMPTS;
    store.db
      .prepare(
        "UPDATE approval_sessions SET attempts = ?, status = ?, state_nonce = NULL, updated_at = ? WHERE id = ?",
      )
      .run(attempts, burned ? "burned" : "open", iso(now), row.id);
    return burned
      ? { ok: false, reason: "burned" }
      : { ok: false, reason: "wrong", attemptsLeft: MAX_CODE_ATTEMPTS - attempts };
  });
};

/** Gives an open session a new single-use nonce for the next elicitation round. */
export const setStateNonce = (store: Store, sessionId: string, now: number): string | undefined => {
  const nonce = randomBytes(16).toString("base64url");
  const changed = store.immediate(() =>
    Number(
      store.db
        .prepare(
          "UPDATE approval_sessions SET state_nonce = ?, updated_at = ? WHERE id = ? AND status = 'open'",
        )
        .run(nonce, iso(now), sessionId).changes,
    ),
  );
  return changed === 1 ? nonce : undefined;
};

/** Uses up a nonce: true only once, and only for the nonce the session holds now. */
export const takeStateNonce = (
  store: Store,
  sessionId: string,
  nonce: unknown,
  now: number,
): boolean =>
  typeof nonce === "string" &&
  nonce.length > 0 &&
  store.immediate(
    () =>
      Number(
        store.db
          .prepare(
            "UPDATE approval_sessions SET state_nonce = NULL, updated_at = ? WHERE id = ? AND status = 'open' AND state_nonce = ?",
          )
          .run(iso(now), sessionId, nonce).changes,
      ) === 1,
  );

/**
 * The one place a used session turns into an approval (or a settled change). It re-reads
 * the session row and checks it itself, in the same transaction as the engine's move:
 * used just now (not open, burned or closed), not past its expiry, fewer than the
 * maximum wrong codes, and for this change and version. `via` is how the person
 * completed it; `by` is the local OS user.
 */
export const finishSession = (
  store: Store,
  engine: ChangeEngine,
  sessionId: string,
  via: ApprovalVia,
  by: string,
  now: number,
): ChangeView => {
  let refusal: unknown;
  const result = store.immediate((): ChangeView | undefined => {
    const row = getRow(store, sessionId);
    if (
      !row ||
      row.status !== "used" ||
      !(Date.parse(row.expires_at) > now) ||
      row.attempts >= MAX_CODE_ATTEMPTS
    ) {
      throw new ChangeError(
        "wrong_state",
        "This approval was not completed. Nothing was approved.",
      );
    }
    const current = engine.get(row.change_id);
    if (!current || current.version !== row.version) {
      throw new ChangeError(
        "hash_mismatch",
        "The change is not the one shown. Nothing was approved.",
      );
    }
    try {
      return row.kind === "approve"
        ? engine.markApproved(row.change_id, row.version, via, by)
        : engine.markResolved(
            row.change_id,
            row.outcome ?? "unknown",
            by,
            via,
            row.note ?? "Settled by a person.",
          );
    } catch (err) {
      // The engine's own refusal log stays (its work was a savepoint); the error goes out.
      refusal = err;
      return undefined;
    }
  });
  if (refusal !== undefined || result === undefined) throw refusal;
  return result;
};
