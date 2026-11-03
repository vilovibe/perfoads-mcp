// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The PolicyCheck the change engine calls (propose, apply, inside the claim transaction,
// auto approval), backed by policy.yaml. No valid file = read-only everywhere. When the
// file changed between propose and apply, the change must pass BOTH versions and gets the
// stricter tier: a looser edit never helps a change proposed under a stricter policy.

import {
  SAFE_DEFAULTS,
  type PolicyCheck,
  type PolicyDecision,
  type PolicyDefaults,
  type PolicyRequest,
} from "@perfoads/changes";
import { describeChange, evaluate, gateOf, stricterTier, type Verdict } from "./evaluate.js";
import type { PolicySource, PolicyState } from "./source.js";
import { howToRun } from "@perfoads/store";

export const NO_POLICY_REASON =
  "Writes are off: no policy file allows writes for this account, so this server only reads. See the docs on the change policy file.";

const checkCommand = (): string => howToRun("policy check");

/** Why a state that is not valid allows no writes, in plain words. */
export const notValidReason = (state: Exclude<PolicyState, { status: "valid" }>): string => {
  switch (state.status) {
    case "none":
      return NO_POLICY_REASON;
    case "invalid":
      return `Writes are off: the policy file is not valid (${state.problems[0] ?? "unknown problem"}), so this server only reads. Run \`${checkCommand()}\` in a terminal.`;
    case "ignored":
      return `Writes are off: ${state.reason}`;
  }
};

export const policyLabel = (state: PolicyState): string =>
  state.status === "valid"
    ? `policy.yaml ${state.hash.slice(0, 12)}`
    : `read-only (${state.status})`;

export interface FilePolicy extends PolicyCheck {
  /** The policy in force right now. */
  state(): PolicyState;
  liveWrites(customerId: string): boolean;
  defaults(customerId: string): PolicyDefaults;
  /**
   * Why this account may not be read, or undefined. Valid policy: only accounts.allow +
   * accounts.write. No file: every account. Invalid or ignored file: never wider than the
   * last valid version; an invalid file with no valid version ever = nothing is read.
   */
  readDenial(customerId: string): string | undefined;
  readAllowed(customerId: string): boolean;
  /** Proposals per minute / per day on one account (policy limits), checked before any read. */
  proposalDenial(counts: { minute: number; day: number }): string | undefined;
  /**
   * Reads are refused once they would eat into the share of today's operations the policy
   * keeps for changes (ops_budget.reserve_for_writes_pct). Returns the refusal, if any.
   * Test-account and production-account operations are separate counts with their own
   * limits: `used` and `dailyLimit` are those of the request's pool.
   */
  readRefusal(
    used: number,
    cost: number,
    dailyLimit: number | null,
    share?: "read" | "undo",
    pool?: "test" | "production",
  ): string | undefined;
}

const decide = (v: Verdict, state: Extract<PolicyState, { status: "valid" }>): PolicyDecision => ({
  allowed: v.allowed,
  tier: v.tier,
  reason: v.reason,
  policy: policyLabel(state),
  hash: state.hash,
  rule: v.rule,
});

const dashed = (id: string): string =>
  /^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;

const refused = (state: PolicyState, reason: string): PolicyDecision => ({
  allowed: false,
  tier: "blocked",
  reason,
  policy: policyLabel(state),
  hash: state.status === "valid" ? state.hash : undefined,
});

export const createFilePolicy = (source: PolicySource): FilePolicy => {
  const proposalLimit = (counts: {
    kind?: "propose" | "undo";
    minute: number;
    day: number;
  }): { rule: string; reason: string } | undefined => {
    const state = source.current();
    if (state.status !== "valid") return undefined; // writes are refused anyway
    const l = state.policy.limits;
    if (counts.kind === "undo") {
      return counts.day >= l.undo_per_day
        ? {
            rule: "limits.undo_per_day",
            reason: `${counts.day} undos were tried on this account in the last 24 hours; the policy allows ${l.undo_per_day} a day (limits.undo_per_day).`,
          }
        : undefined;
    }
    if (counts.minute >= l.proposals_per_minute) {
      return {
        rule: "limits.proposals_per_minute",
        reason: `${counts.minute} changes were proposed for this account in the last minute; the policy allows ${l.proposals_per_minute} a minute (limits.proposals_per_minute). Try again in a minute.`,
      };
    }
    if (counts.day >= l.proposals_per_day) {
      return {
        rule: "limits.proposals_per_day",
        reason: `${counts.day} changes were proposed for this account in the last 24 hours; the policy allows ${l.proposals_per_day} a day (limits.proposals_per_day).`,
      };
    }
    return undefined;
  };

  const readDenial = (customerId: string): string | undefined => {
    const state = source.current();
    if (state.status === "none") return undefined;
    const id = dashed(customerId);
    if (state.status === "valid") {
      const a = state.policy.accounts;
      return a.allow.includes(customerId) || a.write.includes(customerId)
        ? undefined
        : `Account ${id} is not listed under accounts.allow (or accounts.write) in the policy file, so it can't be read here.`;
    }
    // Invalid or ignored: never wider than the last valid version, nor (ignored) than the
    // ignored file's own allowlist. Narrowing only.
    const last = source.lastValid();
    const lists = [
      ...(last ? [last.policy] : []),
      ...(state.status === "ignored" && state.parsed ? [state.parsed] : []),
    ];
    if (lists.length === 0) {
      return state.status === "invalid"
        ? `Your policy file has an error: ${state.problems[0] ?? "it can't be read"}; fix it with \`${howToRun("policy check")}\`. Until then nothing is read.`
        : undefined;
    }
    const inAll = lists.every(
      (p) => p.accounts.allow.includes(customerId) || p.accounts.write.includes(customerId),
    );
    if (inAll) return undefined;
    return state.status === "invalid"
      ? `Your policy file has an error: ${state.problems[0] ?? "it can't be read"}; fix it with \`${howToRun("policy check")}\`. Until then only the accounts of its last valid version can be read, and ${id} is not one of them.`
      : `The policy file is ignored (${state.reason}); reads stay limited to the accounts it (and its last valid version) lists, and ${id} is not one of them.`;
  };

  const check = (req: PolicyRequest): PolicyDecision => {
    const state = source.current();
    if (state.status !== "valid") return refused(state, notValidReason(state));
    const now = decide(evaluate(state.policy, req), state);
    if (!now.allowed) return now;
    const was = req.proposedUnder;
    if (req.stage === "propose" || !was || was === state.hash) return now;
    // The file changed since propose: the change must pass the earlier version too.
    const earlier = source.byHash(was);
    if (!earlier) {
      return refused(
        state,
        "The policy file changed since this was proposed and the earlier version is not known, so it can't be checked against both. Nothing was sent; propose it again.",
      );
    }
    const before = evaluate(earlier, req);
    if (!before.allowed) {
      return refused(
        state,
        `The policy file changed since this was proposed; the stricter of the two versions applies, and the earlier one says: ${before.reason}`,
      );
    }
    return { ...now, tier: stricterTier(now.tier, before.tier) };
  };

  return {
    name: "policy.yaml",
    state: () => source.current(),
    gate: (customerId, type) => {
      const state = source.current();
      if (state.status !== "valid") return refused(state, notValidReason(state));
      return decide(gateOf(state.policy, customerId, type), state);
    },
    check,
    liveWrites: (customerId) => {
      const state = source.current();
      return (
        state.status === "valid" &&
        !state.policy.kill_switch &&
        state.policy.accounts.write.includes(customerId)
      );
    },
    defaults: (customerId) => {
      const state = source.current();
      if (state.status !== "valid") return SAFE_DEFAULTS;
      const d = state.policy.defaults;
      return {
        newEntitiesPaused: d.new_entities_paused,
        broadMatchRequiresSmartBidding: d.broad_match_requires_smart_bidding,
        brandTerms: state.policy.brand_terms[customerId] ?? [],
      };
    },
    describe: (req) => {
      const state = source.current();
      if (state.status !== "valid") return [notValidReason(state)];
      const d = check(req);
      // The verdict comes first: short summaries (form, terminal) always show it.
      return [
        d.allowed
          ? d.tier === "auto"
            ? "Policy: this low-risk change may apply without a person (auto tier)."
            : "Policy: allowed, a person must approve it."
          : `Policy: refused right now: ${d.reason}`,
        ...describeChange(state.policy, req),
        `Policy file version ${state.hash.slice(0, 12)}.`,
      ];
    },
    readDenial: (customerId) => readDenial(customerId),
    readAllowed: (customerId) => readDenial(customerId) === undefined,
    proposalDenial: (counts) => proposalLimit(counts)?.reason,
    proposals: (_customerId, counts) => {
      const state = source.current();
      const hit = proposalLimit(counts);
      if (!hit) return { allowed: true, tier: "confirm", reason: "", policy: policyLabel(state) };
      return { ...refused(state, hit.reason), rule: hit.rule };
    },
    readRefusal: (used, cost, dailyLimit, share = "read", pool) => {
      if (dailyLimit === null) return undefined;
      const state = source.current();
      if (state.status !== "valid") return undefined;
      const reservePct = state.policy.ops_budget.reserve_for_writes_pct;
      if (reservePct <= 0) return undefined;
      const readCap = Math.floor((dailyLimit * (100 - reservePct)) / 100);
      // Undo proposals may use the whole reserve: undoing must work when reads have stopped,
      // and with a stale count their reads reach the limit, where Google shows a refill.
      const cap = share === "undo" ? dailyLimit : readCap;
      if (used + cost <= cap) return undefined;
      const kept = dailyLimit - readCap;
      const on =
        pool === "test" ? " on test accounts" : pool === "production" ? " on live accounts" : "";
      return `Not sent: the last ${kept} of the ${dailyLimit} Google Ads operations a day${on} are kept for approved changes (ops_budget.reserve_for_writes_pct in the policy file), and by our own count of the last 24 hours ${used} are already used. Reads work again as that count goes down.`;
    },
  };
};
