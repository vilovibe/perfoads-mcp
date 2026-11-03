// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The change lifecycle (plan section 6): propose -> Google check (validateOnly) ->
// approval (markApproved, called by the approval paths in P4b) -> apply once ->
// read-back -> log; undo = a new change. Every status move goes through moveStatus
// (single writer, exactly one row). After an unclear answer a write is never sent
// again: the change is in_doubt and is settled by reading the account. A write Google
// refused as busy (nothing applied) may be sent again by the engine, but only after
// re-reading the account and finding it exactly as approved.

import { randomUUID } from "node:crypto";
import {
  AdsNetworkError,
  AdsNotAllowedError,
  AdsNotSentError,
  GoogleAdsApiError,
  GoogleAdsBusyError,
  noopLogger,
  normalizeCustomerId,
  type Logger,
  type MutateResult,
} from "@perfoads/ads-client";
import type { Store } from "@perfoads/store";
import { readAccount } from "./account.js";
import { canonicalJson } from "./canonical.js";
import { ChangeError, type ChangeErrorCode } from "./errors.js";
import type {
  AccountFacts,
  AffectedEntity,
  ChangeFacts,
  EngineAds,
  EngineMerchant,
  Target,
} from "./facts.js";
import {
  READ_ONLY_POLICY,
  type PolicyCheck,
  type PolicyDecision,
  type PolicyRequest,
  type RecentWrite,
} from "./policy.js";
import {
  diffHashOf,
  getRow,
  insertChange,
  logRefusal,
  markSent,
  moveStatus,
  noteChange,
  rowDiffHash,
  type ChangeRow,
  type MoveFields,
} from "./repo.js";
import type { ChangeStatus } from "./states.js";
import { localDateTime } from "./time.js";
import {
  readDeadlineMs,
  SAFE_DEFAULTS,
  touchedMatch,
  type ActionType,
  type ModelText,
  type PolicyDefaults,
  type ReadCtx,
  type ReadTarget,
  type Touched,
  type UndoSupport,
} from "./types/actionType.js";
import { assertId, gaql, resourceName } from "./types/common.js";
import { V1_ACTION_TYPES } from "./types/index.js";

const MIN = 60 * 1000;
export const PROPOSAL_TTL_MS = 30 * MIN;
export const UNDO_WINDOW_MS = 30 * 24 * 60 * MIN;
/** A change still `applying` after this long belongs to a server that stopped. */
export const STALE_APPLYING_MS = 10 * MIN;
/** Waits between read-back attempts (Google can take a moment to show a change). */
export const READ_BACK_DELAYS_MS: readonly number[] = [1000, 2000, 4000];
/** An in_doubt change may only be called failed this long after it was sent. */
export const IN_DOUBT_FAIL_AFTER_MS = 10 * MIN;
/** One apply, all reads, waits and the send included. */
export const APPLY_DEADLINE_MS = 200_000;
/**
 * Time one send needs: the client's 60 s request timeout, twice (a 401 answer is resent
 * once with a fresh token), + 10 s for the token refresh. Less left -> not sent.
 */
export const SEND_RESERVE_MS = 130_000;
/** A change sent less than this long ago (applying, or in_doubt) blocks other changes to its items. */
export const ITEM_LOCK_MS = 10 * MIN;
/** in_doubt this long after the last send -> abandoned (change history covers ~30 days). */
export const ABANDON_AFTER_MS = 30 * 24 * 60 * MIN;
/** change_event is only trusted for sends younger than this. */
export const CHANGE_HISTORY_MAX_AGE_MS = 28 * 24 * 60 * MIN;
/** Extra margin before the last send in the change_event window (clock change in autumn). */
export const CHANGE_HISTORY_DST_MARGIN_MS = 60 * MIN;
/** Busy refusals: at most 2 more sends, waits of 2 s then 5 s (or Google's), 30 s in total. */
export const BUSY_WAITS_MS: readonly number[] = [2000, 5000];
export const BUSY_MAX_TOTAL_WAIT_MS = 30_000;

export const APPROVAL_VIAS = ["elicitation", "browser", "cli"] as const;
export type ApprovalVia = (typeof APPROVAL_VIAS)[number];
/** approved_via of a change the policy approved itself (auto tier, low-risk types only). */
export const POLICY_AUTO_VIA = "policy_auto";
/** Window of the policy's rolling limits (writes per day, new daily spend). */
export const POLICY_WINDOW_MS = 24 * 60 * MIN;
/** Undo attempts of one original change: per minute and per 24 hours (fixed). */
export const UNDO_PER_CHANGE_PER_MINUTE = 3;
export const UNDO_PER_CHANGE_PER_DAY = 20;
/** A proposal attempt that never finished (crashed server) stops counting after this. */
export const ATTEMPT_STALE_MS = 10 * MIN;
/** Short waits before re-trying to mark an attempt finished when the store is busy. */
const FINISH_ATTEMPT_RETRY_MS = [50, 200, 500] as const;
export type ResolveOutcome = "applied" | "failed" | "unknown";

export const NOT_TEST_ACCOUNT_MESSAGE =
  "Not applied: this account is not a Google Ads test account and the policy file does not list it under accounts.write, so changes can't be applied to it.";

const NOT_TEST_ACCOUNT_WARNING =
  "This is not a Google Ads test account: the policy file must list it under accounts.write before this change can be applied.";

const LIVE_ACCOUNT_WARNING =
  "This is a live account (not a Google Ads test account): once applied, this change affects real ads and real spend.";

const PROBABLY_NOT_LANDED =
  "Probably did not land - will re-check (the account still shows the old values). It will not be sent again.";

const REASON_MAX = 500;
const NOTE_MAX = 500;

/** Collections for item keys ("1234567890:campaignBudgets/222"). */
const KEY_COLLECTION: Readonly<Record<string, string>> = {
  campaign: "campaigns",
  campaign_budget: "campaignBudgets",
  bidding_strategy: "biddingStrategies",
};
const ACTOR_MAX = 100;

export interface ProposeRequest {
  customerId: string;
  loginCustomerId?: string | undefined;
  type: string;
  input: unknown;
  /** Who asked: e.g. "agent" (the model) or a person's name. */
  actor: string;
  /** How: e.g. "mcp", "cli". */
  via: string;
  /** The model's reason, kept as untrusted text. */
  reason?: string | undefined;
}

export interface Actor {
  actor: string;
  via: string;
}

export interface ChangeView {
  id: string;
  status: ChangeStatus;
  statusReason: string | null;
  type: string;
  customerId: string;
  loginCustomerId: string | null;
  /** From Google: untrusted text. */
  accountName: string;
  currencyCode: string;
  payload: unknown;
  diff: string[];
  /**
   * Version id of this exact change (its diff hash). Never proof of approval: anyone who
   * can read the change can see it. Approval paths pass the hash they showed a human.
   */
  version: string;
  affected: AffectedEntity[];
  facts: ChangeFacts;
  warnings: string[];
  /** From the AI: untrusted text. */
  reason: string | null;
  /**
   * Text the model wrote that this change sends (negatives, keywords, ad text ...), exactly
   * as sent. Untrusted: shown in the approval view's "from the AI" box.
   */
  modelTexts: ModelText[];
  riskTier: string;
  undo: Required<UndoSupport>;
  /** Independent types: how many operations landed (null when not partly applied). */
  landed: { ok: number; total: number } | null;
  undoOf: string | null;
  expiresAt: string;
  createdAt: string;
  approvedBy: string | null;
  approvedVia: string | null;
  approvedAt: string | null;
  appliedAt: string | null;
  googleRequestIds: string[];
  readback: unknown;
  /** Why it failed: the server's sentence, plus Google's words apart (untrusted). */
  error: { message: string; googleSaid: string | null; googleRequestId: string | null } | null;
}

export interface EngineOptions {
  store: Store;
  ads: EngineAds;
  /**
   * Client for new proposals (not undos, never apply): the runtime passes one that keeps
   * to the ops reserve like any read. Default: `ads`.
   */
  proposeAds?: EngineAds;
  /**
   * Client for undo proposals: reserve-aware too, but may use a small share of the
   * operations kept for changes (so a real undo still works when reads are used up).
   * Default: `ads`. Applying (also an approved undo) always uses `ads`.
   */
  undoAds?: EngineAds;
  /** Merchant Center (tag_exclude). Missing = that type refuses plainly. */
  merchant?: EngineMerchant;
  /** Default READ_ONLY_POLICY: nothing can be proposed or applied until P5's policy exists. */
  policy?: PolicyCheck;
  types?: readonly ActionType<unknown>[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readBackDelaysMs?: readonly number[];
  proposalTtlMs?: number;
  undoWindowMs?: number;
  staleApplyingMs?: number;
  inDoubtFailAfterMs?: number;
  applyDeadlineMs?: number;
  sendReserveMs?: number;
  itemLockMs?: number;
  newId?: () => string;
  /** Warnings the engine can't return to a caller (stderr in the server). Default: none. */
  logger?: Logger;
}

interface StoredBefore {
  readTarget: ReadTarget;
  touched: Touched;
  /** Independent types: the touched keys of each operation (same order as ops). */
  opKeys?: string[][];
}

interface OpResult {
  index: number;
  ok: boolean;
  resourceName: string | null;
  errors?: string[];
}

const NO_BEFORE: StoredBefore = { readTarget: { resource: "campaign", id: "0" }, touched: {} };
const SYSTEM: Actor = { actor: "server", via: "engine" };

const parse = <T>(text: string | null, fallback: T): T =>
  text === null ? fallback : (JSON.parse(text) as T);

const TYPE_BY_NAME: ReadonlyMap<string, ActionType<unknown>> = new Map(
  V1_ACTION_TYPES.map((t) => [t.type, t]),
);

/** The model's texts in a stored payload (empty when the type has none or can't say). */
const modelTextsOf = (type: string, payload: unknown): ModelText[] => {
  try {
    return TYPE_BY_NAME.get(type)?.modelTexts?.(payload) ?? [];
  } catch {
    return [];
  }
};

const undoSupportOf = (raw: UndoSupport): Required<UndoSupport> => ({
  supported: raw.supported,
  why: raw.why,
  level: raw.level ?? (raw.supported ? "full" : "none"),
});

/**
 * Keys of what landed, for a partly applied change of an independent type: the keys of
 * every operation Google accepted. null = everything (not partly applied, or unknown).
 */
const landedKeys = (before: StoredBefore, results: OpResult[] | null): Set<string> | null => {
  if (!results || !before.opKeys || results.every((r) => r.ok)) return null;
  const keys = new Set<string>();
  for (const r of results) if (r.ok) for (const k of before.opKeys[r.index] ?? []) keys.add(k);
  return keys;
};

const only = (t: Touched, keys: Set<string> | null): Touched =>
  keys ? Object.fromEntries(Object.entries(t).filter(([k]) => keys.has(k))) : t;

export const toView = (r: ChangeRow): ChangeView => {
  const error = parse<{ message: string; googleSaid?: string; googleRequestId?: string } | null>(
    r.error,
    null,
  );
  const results = parse<OpResult[] | null>(r.per_op_results, null);
  const payload = parse<unknown>(r.payload, null);
  return {
    id: r.id,
    status: r.status,
    statusReason: r.status_reason,
    type: r.type,
    customerId: r.customer_id,
    loginCustomerId: r.login_customer_id,
    accountName: r.account_name,
    currencyCode: r.currency_code,
    payload,
    diff: parse<string[]>(r.diff, []),
    version: r.diff_hash,
    affected: parse<AffectedEntity[]>(r.affected, []),
    facts: parse<ChangeFacts>(r.facts, { affectedCampaignIds: [] }),
    warnings: parse<string[]>(r.warnings, []),
    reason: r.reason,
    modelTexts: modelTextsOf(r.type, payload),
    riskTier: r.risk_tier,
    undo: undoSupportOf(parse<UndoSupport>(r.undo_support, { supported: false, why: null })),
    landed:
      results && results.some((x) => !x.ok)
        ? { ok: results.filter((x) => x.ok).length, total: results.length }
        : null,
    undoOf: r.undo_of,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    approvedBy: r.approved_by,
    approvedVia: r.approved_via,
    approvedAt: r.approved_at,
    appliedAt: r.applied_at,
    googleRequestIds: parse<string[]>(r.google_request_ids, []),
    readback: parse(r.readback, null),
    error: error
      ? {
          message: error.message,
          googleSaid: error.googleSaid ?? null,
          googleRequestId: error.googleRequestId ?? null,
        }
      : null,
  };
};

const zodProblems = (
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string =>
  issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`)
    .join("; ");

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

const cleanActor = (value: string, what: string): string => {
  const v = typeof value === "string" ? value.trim() : "";
  // eslint-disable-next-line no-control-regex
  if (!v || v.length > ACTOR_MAX || /[\u0000-\u001f\u007f]/.test(v)) {
    throw new ChangeError("invalid_input", `${what} must be a short plain name.`);
  }
  return v;
};

const googleError = (err: GoogleAdsApiError) => ({
  message: err.serverLine ?? "Google refused the change.",
  ...(err.googleSaid ? { googleSaid: err.googleSaid } : {}),
  ...(err.googleRequestId ? { googleRequestId: err.googleRequestId } : {}),
});

/** change_event resource collections; bidding strategies are not in change_event. */
const CHANGE_EVENT_COLLECTION: Partial<Record<ReadTarget["resource"], string>> = {
  campaign_budget: "campaignBudgets",
  campaign: "campaigns",
};

export const createChangeEngine = (options: EngineOptions) => {
  const { store, ads } = options;
  const policy = options.policy ?? READ_ONLY_POLICY;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const logger = options.logger ?? noopLogger;
  const delays = options.readBackDelaysMs ?? READ_BACK_DELAYS_MS;
  const ttl = options.proposalTtlMs ?? PROPOSAL_TTL_MS;
  const undoWindow = options.undoWindowMs ?? UNDO_WINDOW_MS;
  const staleApplying = options.staleApplyingMs ?? STALE_APPLYING_MS;
  const failAfter = options.inDoubtFailAfterMs ?? IN_DOUBT_FAIL_AFTER_MS;
  const applyDeadline = options.applyDeadlineMs ?? APPLY_DEADLINE_MS;
  const sendReserve = options.sendReserveMs ?? SEND_RESERVE_MS;
  const itemLock = options.itemLockMs ?? ITEM_LOCK_MS;
  const newId = options.newId ?? (() => `chg_${randomUUID().replace(/-/g, "").slice(0, 20)}`);
  const types = new Map((options.types ?? V1_ACTION_TYPES).map((t) => [t.type, t]));

  const iso = (ms = now()): string => new Date(ms).toISOString();
  const isExpired = (r: ChangeRow): boolean => Date.parse(r.expires_at) <= now();
  /** When the change last left for Google (falls back to when it was claimed). */
  const sentAt = (r: ChangeRow): number => Date.parse(r.last_sent_at ?? r.applying_at ?? "");

  const typeOf = (name: string): ActionType<unknown> => {
    const t = types.get(name);
    if (!t) {
      throw new ChangeError(
        "unknown_type",
        `Unknown change type "${String(name).slice(0, 40)}". Known: ${[...types.keys()].join(", ")}.`,
      );
    }
    return t;
  };

  const mustGet = (id: string): ChangeRow => {
    const row = typeof id === "string" ? getRow(store, id) : undefined;
    if (!row) throw new ChangeError("not_found", "No change with that id.");
    return row;
  };

  const current = (id: string): ChangeView => toView(mustGet(id));

  const targetOf = (r: ChangeRow): Target => ({
    customerId: r.customer_id,
    loginCustomerId: r.login_customer_id ?? undefined,
  });

  /** Account facts from the row, for reads that only need the target (no new Google read). */
  const storedAccount = (r: ChangeRow): AccountFacts => ({
    customerId: r.customer_id,
    name: r.account_name,
    currencyCode: r.currency_code,
    timeZone: null,
    testAccount: false,
    manager: false,
  });

  /** The policy's defaults for an account (the safe side when there are none). */
  const defaultsFor = (customerId: string): PolicyDefaults => {
    try {
      return policy.defaults?.(customerId) ?? SAFE_DEFAULTS;
    } catch {
      return SAFE_DEFAULTS;
    }
  };

  /**
   * Changes on this account that reached Google (or may have) whose own target is one
   * campaign or something in it: the campaign itself (status, bidding), its child keys
   * (negatives, shared lists, assets, audiences), or items in it (keywords, ads). A change
   * to a shared budget / portfolio strategy / shared list that only lists the campaign as
   * reached does not count. create_campaign rows (the create, its undo) are left out.
   */
  const sentOnCampaign =
    (customerId: string) =>
    (campaignId: string): { id: string; type: string; status: string }[] =>
      store.db
        .prepare(
          `SELECT id, type, status FROM changes WHERE customer_id = ? AND type != 'create_campaign'
             AND status IN ('applying', 'applied', 'partially_applied', 'in_doubt', 'verified', 'verify_failed', 'resolved_by_user', 'abandoned')
             AND (EXISTS (SELECT 1 FROM json_each(target_keys) WHERE value LIKE ?)
               OR (COALESCE(json_extract(before, '$.readTarget.resource'), '') NOT IN ('campaign_budget', 'bidding_strategy', 'shared_set')
                   AND EXISTS (SELECT 1 FROM json_each(facts, '$.affectedCampaignIds') WHERE value = ?)))
           ORDER BY created_at LIMIT 20`,
        )
        .all(customerId, `${customerId}:campaigns/${assertId(campaignId)}/%`, campaignId) as {
        id: string;
        type: string;
        status: string;
      }[];

  /** Sources this server made in Merchant Center, kept in the store's meta table. */
  const ownSources = {
    get: (key: string): string | undefined => store.getMeta(`merchant_source:${key}`),
    set: (key: string, name: string): void => store.setMeta(`merchant_source:${key}`, name),
  };

  /** Changes of one type that may hold what they wrote: sent, not undone, not an undo. */
  const heldOfType =
    (customerId: string) =>
    (
      type: string,
    ): { id: string; status: string; payload: unknown; before: unknown; expected: Touched }[] =>
      (
        store.db
          .prepare(
            `SELECT c.id, c.status, c.payload, c.before, c.expected FROM changes c
              WHERE c.customer_id = ? AND c.type = ? AND c.undo_of IS NULL
                AND c.status IN ('applying', 'applied', 'partially_applied', 'in_doubt', 'verified', 'verify_failed')
                AND NOT EXISTS (SELECT 1 FROM changes u WHERE u.undo_of = c.id
                  AND u.status IN ('applied', 'partially_applied', 'verified'))
              ORDER BY c.created_at`,
          )
          .all(customerId, type) as {
          id: string;
          status: string;
          payload: string;
          before: string;
          expected: string;
        }[]
      ).map((r) => ({
        id: r.id,
        status: r.status,
        payload: parse<unknown>(r.payload, {}),
        before: parse<unknown>(r.before, {}),
        expected: parse<Touched>(r.expected, {}),
      }));

  const ctxOf = (r: ChangeRow, account: AccountFacts, deadlineAt?: number): ReadCtx => ({
    ads,
    target: targetOf(r),
    account,
    deadlineAt,
    now,
    sleep,
    defaults: defaultsFor(r.customer_id),
    sentOnCampaign: sentOnCampaign(r.customer_id),
    merchant: options.merchant,
    ownSources,
    heldOfType: heldOfType(r.customer_id),
    undoOf: r.undo_of ?? undefined,
    changeId: r.id,
  });

  const refuse = (d: PolicyDecision): never => {
    throw new ChangeError("policy_refused", d.reason || "The change policy does not allow this.");
  };

  /**
   * This account's changes claimed (applying_at set) in the last 24 hours, without
   * `excludeId`. Inside the claim transaction this read is serialised with every other
   * claim (BEGIN IMMEDIATE), so two parallel claims can't both pass a rolling limit.
   */
  const recentWrites = (customerId: string, excludeId: string | null): RecentWrite[] => {
    const rows = store.db
      .prepare(
        "SELECT id, status, applying_at, facts FROM changes WHERE customer_id = ? AND applying_at IS NOT NULL AND applying_at > ? AND id <> ? ORDER BY applying_at, id",
      )
      .all(customerId, iso(now() - POLICY_WINDOW_MS), excludeId ?? "") as {
      id: string;
      status: string;
      applying_at: string;
      facts: string;
    }[];
    return rows.map((r) => ({
      changeId: r.id,
      status: r.status,
      claimedAt: r.applying_at,
      facts: parse<ChangeFacts>(r.facts, { affectedCampaignIds: [] }),
    }));
  };

  /** Hash of the policy a stored change was proposed under (null for older rows). */
  const proposedUnder = (r: ChangeRow): string | null => {
    const p = parse<{ hash?: unknown } | null>(r.policy, null);
    return typeof p?.hash === "string" ? p.hash : null;
  };

  /** The policy request for a stored change (apply, claim, approve, approval view). */
  const requestFor = (
    r: ChangeRow,
    stage: PolicyRequest["stage"],
    account: AccountFacts,
  ): PolicyRequest => ({
    stage,
    type: r.type,
    account,
    payload: parse(r.payload, null),
    facts: parse<ChangeFacts>(r.facts, { affectedCampaignIds: [] }),
    opsCount: parse<unknown[]>(r.ops, []).length,
    undoOf: r.undo_of,
    // proposeUndo only stores an undo that puts back exactly the stored before values.
    restoresBefore: r.undo_of !== null,
    proposedUnder: proposedUnder(r),
    approvedVia: r.approved_via,
    recent: recentWrites(r.customer_id, r.id),
    now: now(),
  });

  /** An auto-approved change still needs the auto tier from the policy in force now. */
  const autoStillAllowed = (r: ChangeRow, d: PolicyDecision): PolicyDecision =>
    r.approved_via === POLICY_AUTO_VIA && d.allowed && d.tier !== "auto"
      ? {
          ...d,
          allowed: false,
          reason:
            "The policy no longer lets this change apply without a person's approval. Nothing was sent; propose it again.",
        }
      : d;

  /** A policy refusal before any change row exists (propose) is logged without a change id. */
  const logProposeRefusal = (
    d: PolicyDecision,
    customerId: string,
    type: string,
    by: Actor,
    step: "gate" | "proposals" | "check",
    undoOf: string | null = null,
  ): never => {
    try {
      logRefusal(store, iso(), {
        changeId: null,
        event: "refused",
        actor: by.actor,
        via: by.via,
        data: {
          stage: "propose",
          code: "policy_refused",
          customerId,
          type,
          step,
          undoOf,
          rule: d.rule ?? null,
          reason: d.reason,
          policyHash: d.hash ?? null,
        },
      });
    } catch {
      // A busy store must not hide the refusal itself.
    }
    return refuse(d);
  };

  /** Attempts matching `where` started in the last `windowMs` (a crashed, unfinished one counts 10 minutes). */
  const attempts = (where: string, args: string[], windowMs: number): number => {
    const row = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM proposal_attempts WHERE ${where} AND started_at > ?
         AND (finished_at IS NOT NULL OR started_at > ?)`,
      )
      .get(...args, iso(now() - windowMs), iso(now() - ATTEMPT_STALE_MS)) as { n: number | bigint };
    return Number(row.n);
  };

  const limitHit = (rule: string, reason: string): PolicyDecision => ({
    allowed: false,
    tier: "blocked",
    reason,
    policy: policy.name,
    rule,
  });

  /**
   * Inside BEGIN IMMEDIATE, before any Google read: checks the proposal limits against the
   * attempts already started (parallel calls are counted one by one) and records this one.
   * New proposals: the policy's proposals_per_minute / per_day. Undos: 3 a minute and 20 a
   * day per original change, plus the policy's undo_per_day per account; undos never count
   * against the proposal limits. Refusals by a limit record nothing.
   */
  const beginAttempt = (
    customerId: string,
    undoOf: string | null,
  ): { id: number } | { refused: PolicyDecision } =>
    store.immediate(() => {
      store.db
        .prepare("DELETE FROM proposal_attempts WHERE started_at < ?")
        .run(iso(now() - 2 * POLICY_WINDOW_MS));
      if (undoOf) {
        if (attempts("undo_of = ?", [undoOf], MIN) >= UNDO_PER_CHANGE_PER_MINUTE) {
          return {
            refused: limitHit(
              "undo_per_change_per_minute",
              `Undo of change ${undoOf} was already tried ${UNDO_PER_CHANGE_PER_MINUTE} times in the last minute. Try again in a minute.`,
            ),
          };
        }
        if (attempts("undo_of = ?", [undoOf], POLICY_WINDOW_MS) >= UNDO_PER_CHANGE_PER_DAY) {
          return {
            refused: limitHit(
              "undo_per_change_per_day",
              `Undo of change ${undoOf} was already tried ${UNDO_PER_CHANGE_PER_DAY} times in the last 24 hours. Change it in Google Ads instead.`,
            ),
          };
        }
      }
      const kind = undoOf ? "undo" : "propose";
      const counts = {
        kind,
        minute: attempts("customer_id = ? AND kind = ?", [customerId, kind], MIN),
        day: attempts("customer_id = ? AND kind = ?", [customerId, kind], POLICY_WINDOW_MS),
      } as const;
      const d = policy.proposals?.(customerId, counts);
      if (d && !d.allowed) return { refused: d };
      const r = store.db
        .prepare(
          "INSERT INTO proposal_attempts (customer_id, kind, undo_of, started_at) VALUES (?, ?, ?, ?)",
        )
        .run(customerId, kind, undoOf, iso());
      return { id: Number(r.lastInsertRowid) };
    });

  /**
   * Marks a proposal attempt finished. A busy store gets a few short retries; if it is still
   * busy the row stays "running" (it stops counting after 10 minutes) and a warning is logged.
   */
  const finishAttempt = async (id: number, outcome: string): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        store.immediate(() => {
          store.db
            .prepare(
              "UPDATE proposal_attempts SET finished_at = ?, outcome = ? WHERE id = ? AND finished_at IS NULL",
            )
            .run(iso(), outcome, id);
        });
        return;
      } catch (err) {
        const wait = FINISH_ATTEMPT_RETRY_MS[attempt];
        if (wait === undefined) {
          logger.warn(
            "could not record the end of a proposal attempt (store busy); it counts as running for up to 10 minutes",
            { attempt: id, outcome, error: err instanceof Error ? err.message : String(err) },
          );
          return;
        }
        await sleep(wait);
      }
    }
  };

  /** Runs fn; a ChangeError with one of `codes` is written to the audit log, then rethrown. */
  const logged = async <T>(
    changeId: string,
    by: Actor,
    stage: string,
    codes: readonly ChangeErrorCode[],
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ChangeError && codes.includes(err.code)) {
        logRefusal(store, iso(), {
          changeId,
          event: "refused",
          actor: by.actor,
          via: by.via,
          data: {
            stage,
            code: err.code,
            ...(err.code === "policy_refused" ? { reason: err.message } : {}),
          },
        });
      }
      throw err;
    }
  };

  /** Moves proposed / approved changes past their expiry to expired. Returns how many. */
  const expireDue = (): number => {
    const due = store.db
      .prepare(
        "SELECT id, status FROM changes WHERE status IN ('proposed', 'approved') AND expires_at <= ?",
      )
      .all(iso()) as { id: string; status: ChangeStatus }[];
    let n = 0;
    for (const d of due) {
      try {
        moveStatus(store, d.id, d.status, "expired", iso(), {
          fields: {
            status_reason: "Not approved and applied within 30 minutes. Propose it again.",
          },
          event: SYSTEM,
          idempotent: true,
        });
        n++;
      } catch (err) {
        if (!(err instanceof ChangeError && err.code === "wrong_state")) throw err;
      }
    }
    return n;
  };

  const propose = async (
    req: ProposeRequest,
    internal: {
      undoOf?: string;
      mustMatch?: StoredBefore;
      restores?: Touched;
      /** Item types: keys are compared one by one, the read target only by its kind. */
      itemKeys?: boolean;
    } = {},
  ): Promise<ChangeView> => {
    expireDue();
    const type = typeOf(req.type);
    const actor = cleanActor(req.actor, "actor");
    const via = cleanActor(req.via, "via");
    let target: Target;
    try {
      target = {
        customerId: normalizeCustomerId(String(req.customerId)),
        loginCustomerId:
          req.loginCustomerId === undefined
            ? undefined
            : normalizeCustomerId(String(req.loginCustomerId)),
      };
    } catch {
      throw new ChangeError(
        "invalid_input",
        "customer_id must be a 10-digit Google Ads account id.",
      );
    }
    const gate = policy.gate(target.customerId, type.type);
    if (!gate.allowed) {
      logProposeRefusal(gate, target.customerId, type.type, { actor, via }, "gate");
    }
    // Proposals and undos are rate-limited (recorded before any Google read, in one
    // transaction) and read Google through reserve-aware clients: they can't burn the
    // operations kept for approved changes.
    const undoOf = internal.undoOf ?? null;
    const pads = undoOf ? (options.undoAds ?? ads) : (options.proposeAds ?? ads);
    const attempt = beginAttempt(target.customerId, undoOf);
    const attemptId =
      "refused" in attempt
        ? logProposeRefusal(
            attempt.refused,
            target.customerId,
            type.type,
            { actor, via },
            "proposals",
            undoOf,
          )
        : attempt.id;
    let outcome = "failed";
    try {
      const view = await planAndStore();
      outcome = "proposed";
      return view;
    } finally {
      await finishAttempt(attemptId, outcome);
    }

    async function planAndStore(): Promise<ChangeView> {
      const schema = internal.undoOf ? (type.undoInputSchema ?? type.input) : type.input;
      const parsed = schema.safeParse(req.input);
      if (!parsed.success) {
        throw new ChangeError(
          "invalid_input",
          `The ${type.type} input is not valid: ${zodProblems(parsed.error.issues)}.`,
        );
      }
      const account = await readAccount(pads, target);
      if (account.manager) {
        throw new ChangeError(
          "not_allowed",
          "This is a manager account; changes are made in the accounts under it.",
        );
      }
      const ctx: ReadCtx = {
        ads: pads,
        target,
        account,
        now,
        sleep,
        defaults: defaultsFor(target.customerId),
        sentOnCampaign: sentOnCampaign(target.customerId),
        merchant: options.merchant,
        ownSources,
        heldOfType: heldOfType(target.customerId),
        undoOf: internal.undoOf,
      };
      const planned = await type.plan(ctx, parsed.data);
      if (planned.ops.length === 0) {
        throw new ChangeError("nothing_to_change", "Nothing to change.");
      }
      if (internal.mustMatch) {
        const m = internal.mustMatch;
        const sameTarget = internal.itemKeys
          ? m.readTarget.resource === planned.readTarget.resource
          : same(m.readTarget, planned.readTarget);
        if (!sameTarget || !touchedMatch(planned.touched, m.touched)) {
          throw new ChangeError(
            "undo_stale",
            "It was changed again after this change (in Google Ads or by another change), so undo would overwrite that. Nothing was proposed.",
          );
        }
        // The looser undo bounds are only allowed for exactly the stored before value.
        if (internal.restores && !touchedMatch(internal.restores, planned.expected)) {
          throw new ChangeError(
            "undo_unavailable",
            "Undo can't put back exactly the old value, so nothing was proposed. Change it in Google Ads.",
          );
        }
      }
      const decision = policy.check({
        stage: "propose",
        type: type.type,
        account,
        payload: parsed.data,
        facts: planned.facts,
        opsCount: planned.ops.length,
        undoOf: internal.undoOf ?? null,
        restoresBefore: internal.restores !== undefined,
        proposedUnder: null,
        approvedVia: null,
        recent: recentWrites(target.customerId, null),
        now: now(),
      });
      if (!decision.allowed)
        logProposeRefusal(decision, target.customerId, type.type, { actor, via }, "check", undoOf);

      // Google checks every operation and changes nothing (validateOnly, atomic Mutate).
      let checked: MutateResult;
      try {
        checked = type.send
          ? await type.send(ctx, planned.ops, { validateOnly: true })
          : await pads.mutateAll(planned.ops, { ...target, validateOnly: true });
      } catch (err) {
        if (err instanceof GoogleAdsApiError) {
          throw new ChangeError(
            "google_refused",
            `Google checked this change and refused it, so it was not saved. ${err.serverLine ?? ""}`.trim(),
            err.googleSaid || undefined,
          );
        }
        throw new ChangeError(
          "read_failed",
          "Couldn't check this change with Google, so it was not saved.",
        );
      }
      if (checked.failedCount > 0) {
        throw new ChangeError(
          "google_refused",
          "Google checked this change and refused part of it, so it was not saved.",
        );
      }

      const at = now();
      const before: StoredBefore = {
        readTarget: planned.readTarget,
        touched: planned.touched,
        ...(planned.opKeys ? { opKeys: planned.opKeys } : {}),
      };
      const loginCustomerId = target.loginCustomerId ?? null;
      const warnings = [...planned.warnings];
      if (!account.testAccount) {
        warnings.push(
          policy.liveWrites?.(target.customerId) === true
            ? LIVE_ACCOUNT_WARNING
            : NOT_TEST_ACCOUNT_WARNING,
        );
      }
      // Stored as canonical JSON, so the hash recomputed from the row is the same.
      const stored = {
        payload: JSON.parse(canonicalJson(parsed.data)) as unknown,
        ops: JSON.parse(canonicalJson(planned.ops)) as unknown,
        before: JSON.parse(canonicalJson(before)) as unknown,
        expected: JSON.parse(canonicalJson(planned.expected)) as unknown,
        diff: planned.diff,
        affected: JSON.parse(canonicalJson(planned.affected)) as unknown,
        facts: JSON.parse(canonicalJson(planned.facts)) as unknown,
        warnings,
      };
      const diffHash = diffHashOf({
        customerId: target.customerId,
        loginCustomerId,
        accountName: account.name,
        currencyCode: account.currencyCode,
        type: type.type,
        ...stored,
      });
      const keys = [
        ...new Set(
          planned.targetKeys
            ? planned.targetKeys.map((k) => `${target.customerId}:${k}`)
            : [
                { kind: planned.readTarget.resource, id: planned.readTarget.id },
                ...planned.affected,
              ].map((e) => `${target.customerId}:${KEY_COLLECTION[e.kind] ?? e.kind}/${e.id}`),
        ),
      ].sort();
      const reason =
        typeof req.reason === "string" && req.reason.trim()
          ? req.reason.trim().slice(0, REASON_MAX)
          : null;
      const row: ChangeRow = {
        id: newId(),
        customer_id: target.customerId,
        login_customer_id: loginCustomerId,
        account_name: account.name,
        currency_code: account.currencyCode,
        type: type.type,
        payload: canonicalJson(stored.payload),
        ops: canonicalJson(stored.ops),
        before: canonicalJson(stored.before),
        expected: canonicalJson(stored.expected),
        diff: canonicalJson(stored.diff),
        diff_hash: diffHash,
        affected: canonicalJson(stored.affected),
        facts: canonicalJson(stored.facts),
        warnings: canonicalJson(stored.warnings),
        reason,
        risk_tier: decision.tier,
        policy: canonicalJson({
          policy: decision.policy,
          tier: decision.tier,
          hash: decision.hash ?? null,
        }),
        validate: canonicalJson({
          ok: true,
          operations: planned.ops.length,
          googleRequestId: checked.googleRequestId ?? null,
        }),
        undo_support: canonicalJson(undoSupportOf(planned.undo)),
        target_keys: canonicalJson(keys),
        status: "proposed",
        status_reason: null,
        error: null,
        expires_at: iso(at + ttl),
        created_by: actor,
        created_via: via,
        approved_by: null,
        approved_via: null,
        approved_at: null,
        applying_at: null,
        applied_at: null,
        last_sent_at: null,
        google_request_ids: "[]",
        per_op_results: null,
        readback: null,
        undo_of: internal.undoOf ?? null,
        created_at: iso(at),
        updated_at: iso(at),
      };
      insertChange(store, row, {
        changeId: row.id,
        event: "proposed",
        actor,
        via,
        data: {
          type: row.type,
          customerId: row.customer_id,
          diffHash,
          riskTier: decision.tier,
          policyHash: decision.hash ?? null,
          validateRequestId: checked.googleRequestId ?? null,
          undoOf: row.undo_of,
        },
      });
      return current(row.id);
    }
  };

  /**
   * Records a human approval. Only the approval paths (P4b: elicitation, browser page,
   * TTY CLI) call this, with the diff hash the human was shown. Refuses an expired
   * change, and any hash that is not the stored one or does not match the stored row.
   */
  const markApproved = (
    changeId: string,
    diffHash: string,
    approvedVia: ApprovalVia,
    approvedBy: string,
  ): ChangeView => {
    if (!(APPROVAL_VIAS as readonly string[]).includes(approvedVia)) {
      throw new ChangeError("invalid_input", "Unknown approval path.");
    }
    const by = cleanActor(approvedBy, "approvedBy");
    const row = mustGet(changeId);
    if (row.status === "proposed" && isExpired(row)) {
      expireDue();
      throw new ChangeError(
        "expired",
        "This change expired before it was approved. Propose it again.",
      );
    }
    const at = iso();
    try {
      return toView(
        moveStatus(store, changeId, "proposed", "approved", at, {
          check: (r) => {
            if (isExpired(r))
              throw new ChangeError(
                "expired",
                "This change expired before it was approved. Propose it again.",
              );
            if (
              typeof diffHash !== "string" ||
              diffHash !== r.diff_hash ||
              rowDiffHash(r) !== r.diff_hash
            ) {
              throw new ChangeError(
                "hash_mismatch",
                "The approval does not match this change (it was shown a different version). Nothing was approved.",
              );
            }
          },
          fields: { approved_by: by, approved_via: approvedVia, approved_at: at },
          event: { actor: by, via: approvedVia, data: { diffHash } },
        }),
      );
    } catch (err) {
      if (err instanceof ChangeError && err.code === "expired") expireDue();
      if (err instanceof ChangeError && err.code === "hash_mismatch") {
        logRefusal(store, iso(), {
          changeId,
          event: "refused",
          actor: by,
          via: approvedVia,
          data: { stage: "approve", code: err.code },
        });
      }
      throw err;
    }
  };

  const markRejected = (changeId: string, by: Actor): ChangeView =>
    toView(
      moveStatus(store, changeId, "proposed", "rejected", iso(), {
        fields: { status_reason: "Rejected." },
        event: { actor: cleanActor(by.actor, "actor"), via: cleanActor(by.via, "via") },
      }),
    );

  /**
   * The policy approves a change itself: only a change proposed in the auto tier, and only
   * while the policy in force now (and the one it was proposed under: stricter wins) still
   * puts it in the auto tier. The policy package honours auto only for a fixed low-risk
   * list (pausing a campaign, lowering a budget); anything else stays confirm. Recorded as
   * approved_via "policy_auto" with the policy hash. Apply then runs the full lifecycle.
   */
  const autoApprove = (changeId: string, by: Actor): ChangeView => {
    const who: Actor = { actor: cleanActor(by.actor, "actor"), via: cleanActor(by.via, "via") };
    expireDue();
    const row = mustGet(changeId);
    if (row.status !== "proposed") {
      throw new ChangeError("wrong_state", `Change ${changeId} is ${row.status}, not proposed.`);
    }
    if (row.risk_tier !== "auto") {
      throw new ChangeError("not_allowed", "This change needs a person's approval.");
    }
    const needsPerson = (): never => {
      throw new ChangeError(
        "policy_refused",
        "The policy needs a person's approval for this change (call apply_change to open the approval page).",
      );
    };
    try {
      const pre = policy.check(requestFor(row, "approve", storedAccount(row)));
      if (!pre.allowed) refuse(pre);
      if (pre.tier !== "auto") needsPerson();
      const hash = pre.hash ?? "unknown";
      return toView(
        moveStatus(store, changeId, "proposed", "approved", iso(), {
          check: (r) => {
            if (isExpired(r))
              throw new ChangeError(
                "expired",
                "This change expired before it was approved. Propose it again.",
              );
            if (rowDiffHash(r) !== r.diff_hash) {
              throw new ChangeError(
                "hash_mismatch",
                "The stored change does not match what was proposed. Nothing was approved.",
              );
            }
            // Again inside the transaction: the policy file may have changed meanwhile.
            const d = policy.check(requestFor(r, "approve", storedAccount(r)));
            if (!d.allowed) refuse(d);
            if (d.tier !== "auto" || (d.hash ?? "unknown") !== hash) needsPerson();
          },
          fields: {
            approved_by: `policy ${hash.slice(0, 12)}`,
            approved_via: POLICY_AUTO_VIA,
            approved_at: iso(),
          },
          event: {
            ...who,
            data: { diffHash: row.diff_hash, approvedVia: POLICY_AUTO_VIA, policyHash: hash },
          },
        }),
      );
    } catch (err) {
      if (err instanceof ChangeError && err.code === "expired") expireDue();
      if (err instanceof ChangeError && err.code === "policy_refused") {
        logRefusal(store, iso(), {
          changeId,
          event: "refused",
          actor: who.actor,
          via: who.via,
          data: { stage: "approve", code: err.code, reason: err.message },
        });
      }
      throw err;
    }
  };

  /** Plain policy lines for the approval view (limits this change uses), [] without a policy. */
  const policyLines = (changeId: string): string[] => {
    const row = mustGet(changeId);
    try {
      return policy.describe?.(requestFor(row, "apply", storedAccount(row))) ?? [];
    } catch {
      return [];
    }
  };

  /**
   * applying -> to. If startup reconciliation already moved it to in_doubt, in_doubt -> to.
   * Already in `to` (another process): returns it. Anything else: returns the row as it is.
   */
  const settle = (
    id: string,
    to: ChangeStatus,
    fields: MoveFields,
    by: Actor,
    data: Record<string, unknown> = {},
  ): ChangeRow => {
    const event = { ...by, data };
    try {
      return moveStatus(store, id, "applying", to, iso(), { fields, event, idempotent: true });
    } catch (err) {
      if (!(err instanceof ChangeError && err.code === "wrong_state")) throw err;
      const status = mustGet(id).status;
      if (status === "in_doubt" && (to === "applied" || to === "failed" || to === "in_doubt")) {
        if (to === "in_doubt") return mustGet(id);
        try {
          return moveStatus(store, id, "in_doubt", to, iso(), { fields, event, idempotent: true });
        } catch (e) {
          if (!(e instanceof ChangeError && e.code === "wrong_state")) throw e;
        }
      }
      return mustGet(id);
    }
  };

  /** A move that lost a race returns the change as it is now, never an error. */
  const moveOrCurrent = (
    id: string,
    from: ChangeStatus,
    to: ChangeStatus,
    fields: MoveFields,
    by: Actor,
    data: Record<string, unknown> = {},
  ): ChangeRow => {
    try {
      return moveStatus(store, id, from, to, iso(), {
        fields,
        event: { ...by, data },
        idempotent: true,
      });
    } catch (err) {
      if (err instanceof ChangeError && err.code === "wrong_state") return mustGet(id);
      throw err;
    }
  };

  /** Read-back: the reply's resource, then a confirming GAQL read with short retries. */
  const verify = async (
    row: ChangeRow,
    type: ActionType<unknown>,
    replyTouched: Touched | null,
    deadlineAt?: number,
  ): Promise<ChangeView> => {
    const before = parse<StoredBefore>(row.before, NO_BEFORE);
    const from: ChangeStatus = row.status === "partially_applied" ? "partially_applied" : "applied";
    // Partly applied: what landed must read new, what Google refused must still read old.
    const landed = landedKeys(before, parse<OpResult[] | null>(row.per_op_results, null));
    const allExpected = parse<Touched>(row.expected, {});
    const expected = only(allExpected, landed);
    const unchanged = landed
      ? Object.fromEntries(
          Object.entries(before.touched).filter(([k]) => !landed.has(k) && k in allExpected),
        )
      : {};
    const partNote = landed
      ? (() => {
          const res = parse<OpResult[]>(row.per_op_results, []);
          const ok = res.filter((r) => r.ok).length;
          return ` Partly applied: ${ok} of ${res.length} items landed; Google refused the others (they were not changed).`;
        })()
      : "";
    const ctx = ctxOf(row, storedAccount(row), deadlineAt);
    if (replyTouched !== null && !touchedMatch(replyTouched, expected)) {
      return toView(
        moveOrCurrent(
          row.id,
          from,
          "verify_failed",
          {
            readback: canonicalJson({ reply: replyTouched, expected }),
            status_reason:
              "Google accepted the change but its reply shows different values. Check it in Google Ads.",
          },
          SYSTEM,
        ),
      );
    }
    let observed: Touched | null = null;
    let attempts = 0;
    for (const wait of [0, ...delays]) {
      // The first read always runs (it gets at least 10 s); retries only while time is left.
      if (attempts > 0 && deadlineAt !== undefined && deadlineAt - now() < wait + 1000) break;
      if (wait > 0) await sleep(wait);
      attempts++;
      try {
        observed = await type.readTouched(
          attempts === 1 && deadlineAt !== undefined
            ? { ...ctx, deadlineAt: Math.max(deadlineAt, now() + 10_000) }
            : ctx,
          before.readTarget,
        );
      } catch {
        observed = null; // a failed read is never a reading
        continue;
      }
      if (touchedMatch(observed, expected) && touchedMatch(observed, unchanged)) {
        return toView(
          moveOrCurrent(
            row.id,
            from,
            "verified",
            {
              readback: canonicalJson({ reply: replyTouched, observed, attempts }),
              status_reason: partNote ? partNote.trim() : null,
            },
            SYSTEM,
          ),
        );
      }
    }
    // Only fields Google passes on later still read old, the rest landed: applied, said so.
    const lag = type.readBackLag;
    if (
      lag &&
      observed !== null &&
      touchedMatch(observed, unchanged) &&
      Object.entries(expected).every(
        ([k, v]) => observed?.[k] === v || (lag.keys(k) && observed?.[k] === before.touched[k]),
      )
    ) {
      noteChange(store, row.id, from, iso(), `${lag.note}${partNote}`, {
        changeId: row.id,
        event: "read_back_pending",
        actor: SYSTEM.actor,
        via: SYSTEM.via,
        data: { attempts },
      });
      return toView(mustGet(row.id));
    }
    return toView(
      moveOrCurrent(
        row.id,
        from,
        "verify_failed",
        {
          readback: canonicalJson({ reply: replyTouched, observed, expected, attempts }),
          status_reason:
            (observed === null
              ? "Applied, but reading it back from Google Ads failed. Check it in Google Ads."
              : "Applied, but Google Ads shows different values when read back. Check it in Google Ads.") +
            partNote,
        },
        SYSTEM,
      ),
    );
  };

  /**
   * Has change_event any change to this resource since the last send? Window: from the
   * last send - 2 min - 60 min (clock change), to now, in the ACCOUNT's time zone
   * (change_event times are local). Sends older than 28 days: unknown.
   */
  const changedSince = async (
    row: ChangeRow,
    t: ReadTarget,
    deadlineAt?: number,
  ): Promise<"none" | "some" | "unknown"> => {
    const type = types.get(row.type);
    const collection = CHANGE_EVENT_COLLECTION[t.resource];
    let where: string | null = null;
    try {
      where = type?.historyWhere
        ? type.historyWhere(row.customer_id, t)
        : collection
          ? `change_event.change_resource_name = '${resourceName(row.customer_id, collection, t.id)}'`
          : null;
    } catch {
      where = null;
    }
    const sent = sentAt(row);
    if (!where || !Number.isFinite(sent)) return "unknown";
    if (now() - sent > CHANGE_HISTORY_MAX_AGE_MS) return "unknown";
    try {
      const { timeZone } = await readAccount(
        ads,
        targetOf(row),
        readDeadlineMs({ deadlineAt, now }),
      );
      if (!timeZone) return "unknown";
      const from = localDateTime(sent - 2 * MIN - CHANGE_HISTORY_DST_MARGIN_MS, timeZone);
      const to = localDateTime(now(), timeZone);
      const rows = await gaql(
        ctxOf(row, storedAccount(row), deadlineAt),
        `SELECT change_event.change_date_time, change_event.change_resource_name FROM change_event WHERE change_event.change_date_time >= '${from}' AND change_event.change_date_time <= '${to}' AND ${where} ORDER BY change_event.change_date_time DESC LIMIT 10`,
        "the change history",
        10,
      );
      return rows.length > 0 ? "some" : "none";
    } catch {
      return "unknown";
    }
  };

  /**
   * Settles an in_doubt change by READING the account, never by sending again.
   * - New values seen -> applied -> read-back.
   * - Old values: only `failed` when at least 10 minutes passed since it was sent AND
   *   change_event shows no change to that resource since then. Otherwise it stays
   *   in_doubt ("probably did not land - will re-check").
   * - A failed read is never taken as an old-value reading.
   * Not in_doubt (any more): returns the change as it is.
   */
  const resolveInDoubt = async (
    changeId: string,
    opts: { deadlineAt?: number } = {},
  ): Promise<ChangeView> => {
    const { deadlineAt } = opts;
    const row = mustGet(changeId);
    if (row.status !== "in_doubt") return toView(row);
    const type = typeOf(row.type);
    const before = parse<StoredBefore>(row.before, NO_BEFORE);
    const expected = parse<Touched>(row.expected, {});
    const ctx = ctxOf(row, storedAccount(row), deadlineAt);
    const by: Actor = { actor: "server", via: "resolve" };
    const note = (reason: string, data: Record<string, unknown>): ChangeView => {
      noteChange(store, row.id, "in_doubt", iso(), reason, {
        changeId: row.id,
        event: "in_doubt_unresolved",
        actor: by.actor,
        via: by.via,
        data,
      });
      return current(row.id);
    };

    let observed: Touched | null | undefined;
    let attempts = 0;
    for (const wait of [0, ...delays]) {
      if (attempts > 0 && deadlineAt !== undefined && deadlineAt - now() < wait + 1000) break;
      if (wait > 0) await sleep(wait);
      attempts++;
      try {
        observed = await type.readTouched(ctx, before.readTarget);
      } catch {
        observed = undefined;
        break;
      }
      if (touchedMatch(observed, expected) || !same(observed, before.touched)) break;
    }
    if (observed === undefined) {
      return note(
        "Unclear: Google's answer was unclear and the account could not be read. It will not be sent again; will re-check.",
        { attempts, readOk: false },
      );
    }
    if (touchedMatch(observed, expected)) {
      const applied = moveOrCurrent(
        row.id,
        "in_doubt",
        "applied",
        {
          applied_at: iso(),
          status_reason:
            "Google's answer was unclear; reading the account shows the change landed.",
        },
        by,
        { attempts },
      );
      if (applied.status !== "applied") return toView(applied);
      return verify(applied, type, null, deadlineAt);
    }
    // Independent items: some read new, the rest old -> the send was processed in part.
    const obs = observed;
    if (
      type.independentOps &&
      before.opKeys &&
      obs !== null &&
      Object.keys(expected).every((k) => obs[k] === expected[k] || obs[k] === before.touched[k])
    ) {
      const results: OpResult[] = before.opKeys.map((keys, index) => ({
        index,
        ok: keys.every((k) => obs[k] === expected[k]),
        resourceName: null,
      }));
      if (results.some((r) => r.ok) && results.some((r) => !r.ok)) {
        const part = moveOrCurrent(
          row.id,
          "in_doubt",
          "partially_applied",
          {
            applied_at: iso(),
            per_op_results: canonicalJson(results),
            status_reason:
              "Google's answer was unclear; reading the account shows part of the change landed.",
          },
          by,
          { attempts },
        );
        if (part.status !== "partially_applied") return toView(part);
        return verify(part, type, null, deadlineAt);
      }
    }
    if (!same(observed, before.touched)) {
      return note(
        "Unclear: the account shows neither the old nor the new values (something else changed it). Check it in Google Ads. It will not be sent again.",
        { attempts, readOk: true },
      );
    }
    const sent = sentAt(row);
    if (!Number.isFinite(sent) || now() - sent < failAfter) {
      return note(PROBABLY_NOT_LANDED, { attempts, readOk: true, oldValues: true });
    }
    const history = await changedSince(row, before.readTarget, deadlineAt);
    if (history !== "none") {
      return note(
        history === "some"
          ? "Unclear: the account shows the old values, but its change history shows a change since this was sent. Check it in Google Ads. It will not be sent again."
          : PROBABLY_NOT_LANDED,
        { attempts, readOk: true, oldValues: true, changeHistory: history },
      );
    }
    return toView(
      moveOrCurrent(
        row.id,
        "in_doubt",
        "failed",
        {
          readback: canonicalJson({ observed, attempts, changeHistory: "none" }),
          status_reason:
            "Did not land: more than 10 minutes after the last send, the account still shows the old values and its change history shows no change. It was not sent again.",
        },
        by,
        { attempts },
      ),
    );
  };

  /** Other changes that touch any of this change's items (shared budgets and strategies too). */
  const overlapping = (row: ChangeRow, where: string, ...args: string[]): ChangeRow[] =>
    store.db
      .prepare(
        `SELECT DISTINCT c.* FROM changes c, json_each(c.target_keys) k
         WHERE c.id <> ? AND c.customer_id = ? AND k.value IN (SELECT value FROM json_each(?)) AND ${where}`,
      )
      .all(row.id, row.customer_id, row.target_keys, ...args) as unknown as ChangeRow[];

  /** Earlier unclear changes to the same items get a re-check first (reads only). */
  const settleEarlierInDoubt = async (row: ChangeRow, deadlineAt: number): Promise<void> => {
    for (const o of overlapping(row, "c.status = 'in_doubt'")) {
      if (deadlineAt - now() < sendReserve) return;
      await resolveInDoubt(o.id, { deadlineAt });
    }
  };

  /**
   * Inside the claim transaction: another change to any of the same items that is being
   * applied, or was sent less than 10 minutes ago and is still unclear, blocks this one.
   * After 10 minutes the new change's own live re-check protects the account.
   */
  const itemBusy = (row: ChangeRow): ChangeRow | undefined =>
    overlapping(row, "c.status IN ('applying', 'in_doubt')").find(
      (o) => o.status === "applying" || now() - sentAt(o) < itemLock,
    );

  /** Changes stuck in `applying` past STALE_APPLYING_MS (their server stopped) -> in_doubt. */
  const moveStuckApplying = (via: string, onlyFor?: ChangeRow): string[] => {
    const cutoff = iso(now() - staleApplying);
    const stuck = (
      onlyFor
        ? overlapping(onlyFor, "c.status = 'applying'")
        : (store.db
            .prepare("SELECT * FROM changes WHERE status = 'applying'")
            .all() as unknown as ChangeRow[])
    ).filter((r) => (r.last_sent_at ?? r.applying_at ?? "") <= cutoff);
    const moved: string[] = [];
    for (const r of stuck) {
      const m = moveOrCurrent(
        r.id,
        "applying",
        "in_doubt",
        {
          status_reason:
            "The server stopped while sending this change, so it may or may not have been applied. Checking the account; it will not be sent again.",
        },
        { actor: "server", via },
      );
      if (m.status === "in_doubt") moved.push(r.id);
    }
    return moved;
  };

  type Freshness = { ok: true } | { ok: false; stale: boolean; reason: string; live?: unknown };

  /**
   * Re-reads everything the approval view and the policy were built from (the touched
   * fields, every affected campaign, the budget a campaign turns on, the account's
   * currency and name) by planning the same change again. Any difference = stale.
   */
  const freshness = async (
    ctx: ReadCtx,
    type: ActionType<unknown>,
    row: ChangeRow,
  ): Promise<Freshness> => {
    if (ctx.account.currencyCode !== row.currency_code || ctx.account.name !== row.account_name) {
      return {
        ok: false,
        stale: true,
        reason: "The account's currency or name changed since this was proposed. Nothing was sent.",
      };
    }
    let planned;
    try {
      planned = await type.plan(ctx, parse(row.payload, {}));
    } catch (err) {
      if (err instanceof ChangeError && err.code !== "read_failed") {
        return {
          ok: false,
          stale: true,
          // An undo refused now says why itself (e.g. Google's history not showing it yet).
          reason:
            err.code === "undo_unavailable"
              ? `Nothing was sent: ${err.message}`
              : `It changed in Google Ads after this was proposed, so nothing was sent: ${err.message}`,
        };
      }
      return {
        ok: false,
        stale: false,
        reason:
          "Couldn't re-check the account right before sending, so nothing was sent. Try again.",
      };
    }
    const now_ = {
      before: {
        readTarget: planned.readTarget,
        touched: planned.touched,
        ...(planned.opKeys ? { opKeys: planned.opKeys } : {}),
      },
      ops: planned.ops,
      expected: planned.expected,
      diff: planned.diff,
      affected: planned.affected,
      facts: planned.facts,
    };
    const was = {
      before: parse(row.before, null),
      ops: parse(row.ops, null),
      expected: parse(row.expected, null),
      diff: parse(row.diff, null),
      affected: parse(row.affected, null),
      facts: parse(row.facts, null),
    };
    if (same(now_, was)) return { ok: true };
    const changed = (Object.keys(was) as (keyof typeof was)[]).filter(
      (k) => !same(now_[k], was[k]),
    );
    return {
      ok: false,
      stale: true,
      reason:
        "It changed in Google Ads after this was proposed (what the approval showed is no longer true), so nothing was sent. Propose it again.",
      live: { changed, touched: planned.touched },
    };
  };

  const apply = async (changeId: string, by: Actor): Promise<ChangeView> => {
    const who: Actor = { actor: cleanActor(by.actor, "actor"), via: cleanActor(by.via, "via") };
    const deadlineAt = now() + applyDeadline;
    expireDue();
    const row = mustGet(changeId);
    if (row.status !== "approved") {
      const why: Partial<Record<ChangeStatus, string>> = {
        proposed: "It needs a person's approval first.",
        applying: "It is being applied right now.",
        expired: "It expired. Propose it again.",
      };
      throw new ChangeError(
        "wrong_state",
        `Change ${changeId} is ${row.status}, so it can't be applied. ${why[row.status] ?? ""}`.trim(),
      );
    }
    const type = typeOf(row.type);
    const refusals: ChangeErrorCode[] = [
      "hash_mismatch",
      "not_test_account",
      "policy_refused",
      "item_busy",
    ];
    const account = await logged(changeId, who, "apply", refusals, async () => {
      if (!row.approved_by?.trim() || !row.approved_via || !row.approved_at) {
        throw new ChangeError(
          "hash_mismatch",
          "This change has no recorded approval. Nothing was sent.",
        );
      }
      if (rowDiffHash(row) !== row.diff_hash) {
        throw new ChangeError(
          "hash_mismatch",
          "The stored change does not match what was approved. Nothing was sent.",
        );
      }
      moveStuckApplying("engine", row);
      await settleEarlierInDoubt(row, deadlineAt);
      // Live accounts only when a valid policy lists them under accounts.write. Read live, never cached.
      const live = await readAccount(ads, targetOf(row), readDeadlineMs({ deadlineAt, now }));
      if (!live.testAccount && policy.liveWrites?.(row.customer_id) !== true) {
        throw new ChangeError("not_test_account", NOT_TEST_ACCOUNT_MESSAGE);
      }
      const decision = autoStillAllowed(row, policy.check(requestFor(row, "apply", live)));
      const was = proposedUnder(row);
      if (decision.hash && was && decision.hash !== was) {
        // Re-checked with the new policy too (the policy keeps the stricter of the two).
        logRefusal(store, iso(), {
          changeId,
          event: "policy_changed",
          actor: who.actor,
          via: who.via,
          data: { stage: "apply", from: was, to: decision.hash, allowed: decision.allowed },
        });
      }
      if (!decision.allowed) refuse(decision);
      return live;
    });

    // Claim: approved -> applying, exactly one row. A second applier stops here, and so
    // does any change to an item another change is being applied to (per-item single writer).
    // The send that follows is async: it must never run inside a store transaction (the
    // write lock would be held across Google calls, and a nested claim would commit with
    // whatever outer work surrounds it).
    if (store.inTransaction()) {
      throw new Error(
        "apply was called inside a store transaction; changes are claimed and sent outside it.",
      );
    }
    try {
      moveStatus(store, changeId, "approved", "applying", iso(), {
        check: (r) => {
          const busy = itemBusy(r);
          if (busy) {
            throw new ChangeError(
              "item_busy",
              `Blocked: another change to this item is being applied (${busy.id}, ${busy.status}). Nothing was sent; try again in a few minutes.`,
            );
          }
          if (isExpired(r))
            throw new ChangeError(
              "expired",
              "This change expired before it was applied. Propose it again.",
            );
          if (r.diff_hash !== row.diff_hash)
            throw new ChangeError(
              "hash_mismatch",
              "The change was edited after approval. Nothing was sent.",
            );
          // Policy again, inside this transaction: the kill switch, writes per minute / day
          // and the rolling 24-hour spend limit see every claim committed before this one.
          const d = autoStillAllowed(r, policy.check(requestFor(r, "claim", account)));
          if (!d.allowed) refuse(d);
        },
        fields: { applying_at: iso() },
        event: { ...who, data: { diffHash: row.diff_hash } },
      });
    } catch (err) {
      if (err instanceof ChangeError && err.code === "expired") expireDue();
      if (
        err instanceof ChangeError &&
        (err.code === "item_busy" || err.code === "policy_refused")
      ) {
        logRefusal(store, iso(), {
          changeId,
          event: "refused",
          actor: who.actor,
          via: who.via,
          data: {
            stage: err.code === "policy_refused" ? "claim" : "apply",
            code: err.code,
            ...(err.code === "policy_refused" ? { reason: err.message } : {}),
          },
        });
      }
      throw err;
    }

    const ctx: ReadCtx = { ...ctxOf(row, account, deadlineAt), sendReserveMs: sendReserve };
    const ops = parse<Record<string, unknown>[]>(row.ops, []);
    const requestIds: string[] = [];
    let busyWaited = 0;
    let resends = 0;
    let res: MutateResult;
    for (;;) {
      // Fresh check before every send: the account must still be exactly as approved.
      const fresh = await freshness(ctx, type, row);
      if (!fresh.ok) {
        return toView(
          settle(
            changeId,
            fresh.stale ? "stale" : "failed",
            {
              status_reason: fresh.reason,
              ...(fresh.live === undefined
                ? {}
                : { readback: canonicalJson({ live: fresh.live }) }),
              ...(requestIds.length ? { google_request_ids: canonicalJson(requestIds) } : {}),
            },
            who,
          ),
        );
      }
      if (deadlineAt - now() < sendReserve) {
        return toView(
          settle(
            changeId,
            "failed",
            {
              status_reason: "Not sent: not enough time was left to send it safely. Try again.",
            },
            who,
          ),
        );
      }
      markSent(store, changeId, iso());
      try {
        res = type.send
          ? await type.send(ctx, ops, { validateOnly: false })
          : await ads.mutateAll(ops, {
              ...ctx.target,
              responseContentType: "MUTABLE_RESOURCE",
              ...(type.independentOps ? { partialFailure: true } : {}),
            });
        break;
      } catch (err) {
        if (
          err instanceof GoogleAdsBusyError &&
          err.details.some((d) => d.errorCode?.value === "CONCURRENT_MODIFICATION")
        ) {
          // Someone else wrote this item at the same moment: never overwrite them.
          if (err.googleRequestId) requestIds.push(err.googleRequestId);
          return toView(
            settle(
              changeId,
              "stale",
              {
                status_reason:
                  "Someone else changed this item at the same moment; nothing was applied - re-propose.",
                error: canonicalJson(googleError(err)),
                google_request_ids: canonicalJson(requestIds),
              },
              who,
            ),
          );
        }
        if (err instanceof GoogleAdsBusyError) {
          // 429 / short-term quota: refused whole, nothing applied. Wait, re-read, maybe resend.
          if (err.googleRequestId) requestIds.push(err.googleRequestId);
          const wait = Math.max(err.retryAfterMs ?? 0, BUSY_WAITS_MS[resends] ?? 0);
          const fits =
            resends < BUSY_WAITS_MS.length &&
            busyWaited + wait <= BUSY_MAX_TOTAL_WAIT_MS &&
            now() + wait + sendReserve <= deadlineAt;
          if (!fits) {
            return toView(
              settle(
                changeId,
                "failed",
                {
                  status_reason:
                    "Google was busy and refused it each time, so nothing was applied. Try again later.",
                  error: canonicalJson(googleError(err)),
                  google_request_ids: canonicalJson(requestIds),
                },
                who,
              ),
            );
          }
          await sleep(wait);
          busyWaited += wait;
          resends++;
          continue;
        }
        if (err instanceof GoogleAdsApiError) {
          if (err.googleRequestId) requestIds.push(err.googleRequestId);
          return toView(
            settle(
              changeId,
              "failed",
              {
                status_reason: "Google refused the change. Nothing was changed.",
                error: canonicalJson(googleError(err)),
                google_request_ids: canonicalJson(requestIds),
              },
              who,
            ),
          );
        }
        if (
          err instanceof AdsNotSentError ||
          err instanceof AdsNotAllowedError ||
          (err instanceof AdsNetworkError && !err.sent)
        ) {
          return toView(
            settle(
              changeId,
              "failed",
              {
                status_reason: err.message.startsWith("Not sent")
                  ? err.message
                  : `Not sent: ${err.message}`,
              },
              who,
            ),
          );
        }
        // Unclear (timeout, reset, 5xx, unreadable reply, or anything unexpected): never resend.
        const requestId = (err as { googleRequestId?: unknown }).googleRequestId;
        if (typeof requestId === "string") requestIds.push(requestId);
        settle(
          changeId,
          "in_doubt",
          {
            status_reason:
              "Google's answer was unclear, so it may or may not have been applied. Checking the account; it will not be sent again.",
            google_request_ids: canonicalJson(requestIds),
          },
          who,
        );
        return resolveInDoubt(changeId, { deadlineAt });
      }
    }

    if (res.googleRequestId) requestIds.push(res.googleRequestId);
    const perOp = (): OpResult[] =>
      res.results.map((r) => ({
        index: r.index,
        ok: r.ok,
        resourceName: r.resourceName ?? null,
        ...(r.ok
          ? {}
          : {
              errors: r.errors
                .map((e) => (e.errorCode ? `${e.errorCode.type}: ${e.errorCode.value}` : "error"))
                .slice(0, 3),
            }),
      }));
    // Independent items with partial failure: Google's answer is definite per item.
    if (res.failedCount > 0 && type.independentOps && res.results.length === ops.length) {
      const first = res.results.find((r) => !r.ok)?.errors[0];
      const error = canonicalJson({
        message: "Google refused some of the items.",
        ...(first?.message ? { googleSaid: first.message } : {}),
        ...(res.googleRequestId ? { googleRequestId: res.googleRequestId } : {}),
      });
      if (res.failedCount === res.results.length) {
        return toView(
          settle(
            changeId,
            "failed",
            {
              status_reason: "Google refused every item, so nothing was changed.",
              error,
              per_op_results: canonicalJson(perOp()),
              google_request_ids: canonicalJson(requestIds),
            },
            who,
          ),
        );
      }
      const part = settle(
        changeId,
        "partially_applied",
        {
          applied_at: iso(),
          error,
          per_op_results: canonicalJson(perOp()),
          google_request_ids: canonicalJson(requestIds),
          status_reason: `Partly applied: ${res.results.length - res.failedCount} of ${res.results.length} items landed; Google refused ${res.failedCount}.`,
        },
        who,
        { googleRequestId: res.googleRequestId ?? null, failed: res.failedCount },
      );
      if (part.status !== "partially_applied") return toView(part);
      return verify(part, type, null, deadlineAt);
    }
    if (res.failedCount > 0) {
      settle(
        changeId,
        "in_doubt",
        {
          status_reason:
            "Google's reply named failed operations on an all-or-nothing change. Checking the account.",
          google_request_ids: canonicalJson(requestIds),
        },
        who,
      );
      return resolveInDoubt(changeId, { deadlineAt });
    }
    const applied = settle(
      changeId,
      "applied",
      {
        applied_at: iso(),
        google_request_ids: canonicalJson(requestIds),
        per_op_results: canonicalJson(perOp()),
        status_reason: null,
      },
      who,
      { googleRequestId: res.googleRequestId ?? null, busyResends: resends },
    );
    if (applied.status !== "applied") return toView(applied);
    return verify(applied, type, type.fromMutateResults(res.results), deadlineAt);
  };

  /**
   * Run at server start: changes stuck in `applying` (the server stopped mid-send) become
   * in_doubt; every in_doubt change is re-checked by reading. Nothing is ever sent again.
   */
  const reconcile = async (): Promise<{
    inDoubt: string[];
    abandoned: string[];
    settled: ChangeView[];
  }> => {
    expireDue();
    const moved = moveStuckApplying("startup");
    const abandoned: string[] = [];
    const open = store.db
      .prepare("SELECT * FROM changes WHERE status = 'in_doubt' ORDER BY created_at")
      .all() as unknown as ChangeRow[];
    const settled: ChangeView[] = [];
    for (const r of open) {
      let v: ChangeView;
      try {
        // Re-checked first: a change that did land is applied + read back, never abandoned.
        v = await resolveInDoubt(r.id);
      } catch {
        v = current(r.id); // stays in_doubt; tried again next time
      }
      if (v.status === "in_doubt" && now() - sentAt(r) >= ABANDON_AFTER_MS) {
        const a = moveOrCurrent(
          r.id,
          "in_doubt",
          "abandoned",
          {
            status_reason:
              "Still unclear 30 days after it was sent; the change history no longer covers it. Check it in Google Ads. It was never sent again.",
          },
          { actor: "server", via: "startup" },
        );
        if (a.status === "abandoned") abandoned.push(r.id);
        continue;
      }
      settled.push(v);
    }
    return { inDoubt: moved, abandoned, settled };
  };

  /**
   * A person settles an unclear change after checking the account (P4b exposes it on the
   * human approval paths only). Final: `resolved_by_user`, with the outcome and the
   * person's note in the audit log. Nothing is sent.
   */
  const markResolved = (
    changeId: string,
    outcome: ResolveOutcome,
    by: string,
    via: ApprovalVia,
    note: string,
  ): ChangeView => {
    if (!(APPROVAL_VIAS as readonly string[]).includes(via)) {
      throw new ChangeError(
        "invalid_input",
        "Only a person on an approval path can settle a change.",
      );
    }
    if (!["applied", "failed", "unknown"].includes(outcome)) {
      throw new ChangeError("invalid_input", 'outcome must be "applied", "failed" or "unknown".');
    }
    const who = cleanActor(by, "by");
    // eslint-disable-next-line no-control-regex
    const text = typeof note === "string" ? note.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    if (!text || text.length > NOTE_MAX) {
      throw new ChangeError("invalid_input", `A short note (1-${NOTE_MAX} characters) is needed.`);
    }
    const row = mustGet(changeId);
    const sent = sentAt(row);
    if (row.status === "in_doubt" && Number.isFinite(sent) && now() - sent < itemLock) {
      throw new ChangeError(
        "wrong_state",
        `Wait until ${iso(sent + itemLock)}: the first send could still land. Check the account after that.`,
      );
    }
    const words = { applied: "it landed", failed: "it did not land", unknown: "still unknown" };
    return toView(
      moveStatus(store, changeId, "in_doubt", "resolved_by_user", iso(), {
        fields: {
          status_reason: `Settled by ${who} after checking the account: ${words[outcome]}.`,
        },
        event: { actor: who, via, data: { outcome, note: text } },
      }),
    );
  };

  /**
   * Undo = a new change of the same type that puts the stored before values back. It
   * needs its own approval. Refused after 30 days, when the type can't undo this one,
   * when an undo already exists, or when the account changed since (it would overwrite).
   */
  const proposeUndo = async (changeId: string, by: Actor): Promise<ChangeView> => {
    const who: Actor = { actor: cleanActor(by.actor, "actor"), via: cleanActor(by.via, "via") };
    expireDue();
    const row = mustGet(changeId);
    return logged(
      changeId,
      who,
      "undo",
      ["undo_unavailable", "undo_window", "undo_stale", "policy_refused"],
      async () => {
        if (
          row.status !== "verified" &&
          row.status !== "applied" &&
          row.status !== "partially_applied"
        ) {
          throw new ChangeError(
            "undo_unavailable",
            row.status === "verify_failed" || row.status === "in_doubt"
              ? `Change ${changeId} is ${row.status}: what landed is unclear, so it can't be undone from here. Check it in Google Ads.`
              : `Change ${changeId} is ${row.status}; only applied changes can be undone.`,
          );
        }
        const support = parse<{ supported: boolean; why: string | null }>(row.undo_support, {
          supported: false,
          why: null,
        });
        if (!support.supported) {
          throw new ChangeError(
            "undo_unavailable",
            `Change ${changeId} can't be undone: ${support.why ?? "this type has no undo"}`,
          );
        }
        const appliedAt = Date.parse(row.applied_at ?? row.updated_at);
        if (now() - appliedAt > undoWindow) {
          throw new ChangeError(
            "undo_window",
            `Change ${changeId} was applied more than 30 days ago; undo is only offered for 30 days.`,
          );
        }
        const existing = store.db
          .prepare(
            "SELECT id, status FROM changes WHERE undo_of = ? AND status NOT IN ('expired', 'rejected', 'failed', 'stale') LIMIT 1",
          )
          .get(changeId) as { id: string; status: string } | undefined;
        if (existing) {
          throw new ChangeError(
            "undo_unavailable",
            `Change ${changeId} already has an undo (${existing.id}, ${existing.status}).`,
          );
        }
        const type = typeOf(row.type);
        const before = parse<StoredBefore>(row.before, NO_BEFORE);
        // A partly applied change: undo only what landed.
        const landed = landedKeys(before, parse<OpResult[] | null>(row.per_op_results, null));
        const restores = only(before.touched, landed);
        let input: unknown;
        try {
          input = type.undoInput(
            parse(row.payload, {}),
            restores,
            before.readTarget,
            parse<OpResult[] | null>(row.per_op_results, null),
            row.applied_at,
          );
        } catch (err) {
          if (err instanceof ChangeError) throw err;
          throw new ChangeError(
            "undo_unavailable",
            `Change ${changeId} can't be undone from here.`,
          );
        }
        return propose(
          {
            customerId: row.customer_id,
            loginCustomerId: row.login_customer_id ?? undefined,
            type: row.type,
            input,
            actor: who.actor,
            via: who.via,
            reason: `Undo of change ${changeId}.`,
          },
          {
            undoOf: changeId,
            mustMatch: {
              readTarget: before.readTarget,
              touched: only(parse<Touched>(row.expected, {}), landed),
            },
            restores,
            itemKeys: type.itemKeys === true,
          },
        );
      },
    );
  };

  const get = (changeId: string): ChangeView | undefined => {
    expireDue();
    const row = typeof changeId === "string" ? getRow(store, changeId) : undefined;
    return row ? toView(row) : undefined;
  };

  const list = (
    filter: { status?: ChangeStatus; customerId?: string; limit?: number } = {},
  ): ChangeView[] => {
    expireDue();
    const where: string[] = [];
    const args: string[] = [];
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    if (filter.customerId) {
      where.push("customer_id = ?");
      args.push(filter.customerId);
    }
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 50)), 500);
    const rows = store.db
      .prepare(
        `SELECT * FROM changes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id LIMIT ${limit}`,
      )
      .all(...args) as unknown as ChangeRow[];
    return rows.map(toView);
  };

  return {
    propose: (req: ProposeRequest) => propose(req),
    markApproved,
    markRejected,
    autoApprove,
    policyLines,
    apply,
    resolveInDoubt: (changeId: string) => resolveInDoubt(changeId),
    markResolved,
    reconcile,
    proposeUndo,
    expireDue,
    get,
    list,
    types: () => [...types.values()].map((t) => ({ type: t.type, summary: t.summary })),
  };
};

export type ChangeEngine = ReturnType<typeof createChangeEngine>;
