// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

export interface Migration {
  /** 1, 2, 3 ... in order, never reused, never edited once released. */
  version: number;
  name: string;
  sql: string;
}

/** Change states, also listed in the CHECK and the transition trigger below. */
const STATES =
  "'proposed','expired','rejected','approved','applying','applied','partially_applied','failed','in_doubt','verified','verify_failed','stale','resolved_by_user','abandoned'";

/**
 * Every allowed status move (from -> to). Mirrors CHANGE_TRANSITIONS in @perfoads/changes;
 * a test there checks both agree. A released migration is never edited: a new table of
 * moves needs a new migration that replaces the trigger.
 */
const ALLOWED_MOVES = [
  ["proposed", "approved"],
  ["proposed", "rejected"],
  ["proposed", "expired"],
  ["approved", "applying"],
  ["approved", "expired"],
  ["applying", "applied"],
  ["applying", "partially_applied"],
  ["applying", "failed"],
  ["applying", "in_doubt"],
  ["applying", "stale"],
  ["in_doubt", "applied"],
  ["in_doubt", "partially_applied"],
  ["in_doubt", "failed"],
  ["in_doubt", "resolved_by_user"],
  ["in_doubt", "abandoned"],
  ["applied", "verified"],
  ["applied", "verify_failed"],
  ["partially_applied", "verified"],
  ["partially_applied", "verify_failed"],
]
  .map(([from, to]) => `(OLD.status = '${from}' AND NEW.status = '${to}')`)
  .join(" OR ");

/**
 * Append new migrations at the end. Each runs once, inside BEGIN IMMEDIATE, and bumps
 * meta.schema_version. Snapshots are not in the store: they are gzipped files under
 * <config dir>/snapshots (packages/snapshot/src/files.ts).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "accounts and credentials",
    sql: `
      CREATE TABLE accounts (
        customer_id TEXT PRIMARY KEY CHECK (length(customer_id) = 10),
        name TEXT NOT NULL,
        currency_code TEXT,
        time_zone TEXT,
        is_manager INTEGER NOT NULL DEFAULT 0,
        is_test_account INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        login_customer_id TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE credentials (
        purpose TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "changes, audit log and ops usage",
    sql: `
      CREATE TABLE changes (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL CHECK (length(customer_id) = 10),
        login_customer_id TEXT,
        account_name TEXT NOT NULL,
        currency_code TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        ops TEXT NOT NULL,
        before TEXT NOT NULL,
        expected TEXT NOT NULL,
        diff TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        affected TEXT NOT NULL,
        facts TEXT NOT NULL,
        warnings TEXT NOT NULL,
        reason TEXT,
        risk_tier TEXT NOT NULL,
        policy TEXT NOT NULL,
        validate TEXT NOT NULL,
        undo_support TEXT NOT NULL,
        target_keys TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_keys)),
        status TEXT NOT NULL CHECK (status IN (${STATES})),
        status_reason TEXT,
        error TEXT,
        expires_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_via TEXT NOT NULL,
        approved_by TEXT,
        approved_via TEXT,
        approved_at TEXT,
        applying_at TEXT,
        applied_at TEXT,
        last_sent_at TEXT,
        google_request_ids TEXT NOT NULL DEFAULT '[]',
        per_op_results TEXT,
        readback TEXT,
        undo_of TEXT REFERENCES changes(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX changes_status ON changes (status);
      CREATE INDEX changes_undo_of ON changes (undo_of);
      CREATE TRIGGER changes_status_moves BEFORE UPDATE OF status ON changes
        WHEN OLD.status <> NEW.status AND NOT (${ALLOWED_MOVES})
        BEGIN SELECT RAISE(ABORT, 'change status move not allowed'); END;
      CREATE TRIGGER changes_approval_recorded BEFORE UPDATE OF status ON changes
        WHEN NEW.status = 'approved' AND (
          NEW.approved_by IS NULL OR trim(NEW.approved_by) = '' OR NEW.approved_at IS NULL
          OR NEW.approved_via IS NULL OR NEW.approved_via NOT IN ('elicitation', 'browser', 'cli'))
        BEGIN SELECT RAISE(ABORT, 'an approval needs who approved it, how and when'); END;
      CREATE TRIGGER changes_approval_fixed BEFORE UPDATE OF approved_by, approved_via, approved_at
        ON changes WHEN OLD.approved_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'an approval cannot be edited'); END;
      CREATE TRIGGER changes_fixed_fields BEFORE UPDATE OF
          id, customer_id, login_customer_id, account_name, currency_code, type, payload, ops,
          before, expected, diff, diff_hash, affected, facts, warnings, reason, risk_tier, policy,
          validate, undo_support, target_keys, expires_at, created_by, created_via, undo_of,
          created_at
        ON changes
        BEGIN SELECT RAISE(ABORT, 'a proposed change cannot be edited'); END;
      CREATE TRIGGER changes_no_delete BEFORE DELETE ON changes
        BEGIN SELECT RAISE(ABORT, 'changes are never deleted'); END;

      CREATE TABLE audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        change_id TEXT,
        event TEXT NOT NULL,
        actor TEXT NOT NULL,
        via TEXT NOT NULL,
        data TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE
      );
      CREATE INDEX audit_log_change ON audit_log (change_id);
      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

      CREATE TABLE ops_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        n INTEGER NOT NULL CHECK (n > 0),
        kind TEXT NOT NULL
      );
      CREATE INDEX ops_usage_at ON ops_usage (at_ms);
    `,
  },
  {
    version: 3,
    name: "approval sessions",
    // One row per approval page. The code is stored only as a slow hash (scrypt, per-session
    // salt); the page token never leaves the process serving the page. A session is used
    // once, then never opens again.
    sql: `
      CREATE TABLE approval_sessions (
        id TEXT PRIMARY KEY,
        change_id TEXT NOT NULL REFERENCES changes (id),
        kind TEXT NOT NULL CHECK (kind IN ('approve', 'resolve')),
        version TEXT NOT NULL,
        outcome TEXT CHECK (outcome IS NULL OR outcome IN ('applied', 'failed', 'unknown')),
        note TEXT,
        code_hash TEXT NOT NULL,
        code_salt TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        state_nonce TEXT,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'used', 'burned', 'closed', 'expired')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX approval_sessions_change ON approval_sessions (change_id, status);
      CREATE TRIGGER approval_sessions_final BEFORE UPDATE OF status ON approval_sessions
        WHEN OLD.status <> 'open'
        BEGIN SELECT RAISE(ABORT, 'a finished approval session cannot open again'); END;
      CREATE TRIGGER approval_sessions_fixed BEFORE UPDATE OF
          id, change_id, kind, version, outcome, note, code_hash, code_salt, expires_at, created_at
        ON approval_sessions
        BEGIN SELECT RAISE(ABORT, 'an approval session cannot be edited'); END;
    `,
  },
  {
    version: 4,
    name: "policy versions and policy approvals",
    // Every valid policy file the server loaded, by hash, so an approved change can be
    // re-checked at apply against the policy it was proposed under (stricter wins).
    // The approval trigger is replaced (a released migration is never edited) to allow
    // one more path: "policy_auto", the policy's own auto tier (low-risk types only).
    sql: `
      CREATE TABLE policy_versions (
        hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
        body TEXT NOT NULL CHECK (json_valid(body)),
        first_loaded_at TEXT NOT NULL
      );
      CREATE TRIGGER policy_versions_no_update BEFORE UPDATE ON policy_versions
        BEGIN SELECT RAISE(ABORT, 'policy_versions is append-only'); END;
      CREATE TRIGGER policy_versions_no_delete BEFORE DELETE ON policy_versions
        BEGIN SELECT RAISE(ABORT, 'policy_versions is append-only'); END;
      DROP TRIGGER changes_approval_recorded;
      CREATE TRIGGER changes_approval_recorded BEFORE UPDATE OF status ON changes
        WHEN NEW.status = 'approved' AND (
          NEW.approved_by IS NULL OR trim(NEW.approved_by) = '' OR NEW.approved_at IS NULL
          OR NEW.approved_via IS NULL
          OR NEW.approved_via NOT IN ('elicitation', 'browser', 'cli', 'policy_auto'))
        BEGIN SELECT RAISE(ABORT, 'an approval needs who approved it, how and when'); END;
    `,
  },
  {
    version: 5,
    name: "proposal attempts",
    // One row per proposal (or undo proposal) that passed the rate limits, written inside
    // BEGIN IMMEDIATE before any Google read, so parallel proposals are counted one by
    // one. finished_at is set when it ends (any outcome); an unfinished row (a crash)
    // stops counting after 10 minutes. Rows older than 2 days are pruned.
    sql: `
      CREATE TABLE proposal_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT NOT NULL CHECK (length(customer_id) = 10),
        kind TEXT NOT NULL CHECK (kind IN ('propose', 'undo')),
        undo_of TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT
      );
      CREATE INDEX proposal_attempts_account ON proposal_attempts (customer_id, kind, started_at);
      CREATE INDEX proposal_attempts_undo ON proposal_attempts (undo_of, started_at);
    `,
  },
  {
    version: 6,
    name: "approval session pages",
    // served = 1 once a page shows the session's code (in any process). A served session
    // for the same change, version and kind is reused by every process, never closed by a
    // new one; a session no page shows (no browser, open_browser false) is replaced.
    sql: `
      ALTER TABLE approval_sessions ADD COLUMN served INTEGER NOT NULL DEFAULT 0
        CHECK (served IN (0, 1));
    `,
  },
  {
    version: 7,
    name: "retention",
    // Records older than config.json retention_days go, in one transaction, only while
    // that transaction has a row in prune_window (cutoff + the last audit seq it may cut).
    // Without it every delete is refused as before. Only final changes and finished
    // approval sessions qualify (never in_doubt, applying, approved, proposed, open).
    // The audit log loses only a prefix (seq <= through_seq); the hash of its last
    // removed row is kept in retention_checkpoints, and the same values are in the
    // retention_pruned audit event written before the delete, so the rest of the chain
    // still verifies from there (packages/changes/src/log.ts verifyChain).
    sql: `
      CREATE TABLE prune_window (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cutoff TEXT NOT NULL,
        through_seq INTEGER NOT NULL
      );
      CREATE TABLE retention_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        cutoff TEXT NOT NULL,
        through_seq INTEGER NOT NULL,
        through_hash TEXT NOT NULL CHECK (length(through_hash) = 64),
        summary_seq INTEGER NOT NULL,
        counts TEXT NOT NULL CHECK (json_valid(counts))
      );
      CREATE TRIGGER retention_checkpoints_no_update BEFORE UPDATE ON retention_checkpoints
        BEGIN SELECT RAISE(ABORT, 'retention_checkpoints is append-only'); END;
      CREATE TRIGGER retention_checkpoints_no_delete BEFORE DELETE ON retention_checkpoints
        BEGIN SELECT RAISE(ABORT, 'retention_checkpoints is append-only'); END;
      DROP TRIGGER audit_log_no_delete;
      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
        WHEN NOT EXISTS (SELECT 1 FROM prune_window w
                         WHERE OLD.seq <= w.through_seq AND OLD.at < w.cutoff)
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      DROP TRIGGER changes_no_delete;
      CREATE TRIGGER changes_no_delete BEFORE DELETE ON changes
        WHEN OLD.status NOT IN ('expired', 'rejected', 'failed', 'verified', 'verify_failed',
                                'stale', 'resolved_by_user', 'abandoned')
          OR NOT EXISTS (SELECT 1 FROM prune_window w WHERE OLD.updated_at < w.cutoff)
        BEGIN SELECT RAISE(ABORT, 'changes are never deleted'); END;
      CREATE TRIGGER approval_sessions_no_delete BEFORE DELETE ON approval_sessions
        WHEN OLD.status = 'open'
          OR NOT EXISTS (SELECT 1 FROM prune_window w WHERE OLD.updated_at < w.cutoff)
        BEGIN SELECT RAISE(ABORT, 'approval sessions are never deleted'); END;
      DROP TRIGGER policy_versions_no_delete;
      CREATE TRIGGER policy_versions_no_delete BEFORE DELETE ON policy_versions
        WHEN NOT EXISTS (SELECT 1 FROM prune_window w WHERE OLD.first_loaded_at < w.cutoff)
        BEGIN SELECT RAISE(ABORT, 'policy_versions is append-only'); END;
    `,
  },
  {
    version: 8,
    name: "ops pools",
    // Google counts operations on test accounts and on production accounts separately.
    // Rows from before this column count as production (the stricter, smaller limit).
    sql: `
      ALTER TABLE ops_usage ADD COLUMN pool TEXT NOT NULL DEFAULT 'production'
        CHECK (pool IN ('test', 'production'));
      CREATE INDEX ops_usage_pool_at ON ops_usage (pool, at_ms);
    `,
  },
];
