// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The policy's judgement of one change (plan 6.1, 7, 9.5). Pure: the caller passes the
// change's facts and this account's recent claims (read inside the claim transaction at
// apply). All money is compared in micros with BigInt, never with floats.

import {
  decimalToMicros,
  microsToDecimalString,
  minimumUnitMicros,
  parseMicros,
} from "@perfoads/ads-client";
import type { ChangeFacts, PolicyRequest, RecentWrite, RiskTier } from "@perfoads/changes";
import type { PolicyV1, Tier } from "./schema.js";

export interface Verdict {
  allowed: boolean;
  tier: RiskTier;
  /** Plain sentence; empty when allowed. */
  reason: string;
  /** Which rule refused (for the audit log). */
  rule: string | null;
}

/** Claims that count as spent in the rolling 24 h (in_doubt counts as spent; failed/stale don't). */
export const SPENT_STATUSES: ReadonlySet<string> = new Set([
  "applying",
  "applied",
  "partially_applied",
  "verified",
  "verify_failed",
  "in_doubt",
  "resolved_by_user",
  "abandoned",
]);

const MINUTE_MS = 60_000;
/** Percent limits are compared as integers: pct * 10^6. */
const PCT_SCALE = 1_000_000n;

const TIER_RANK: Record<Tier, number> = { auto: 0, confirm: 1, blocked: 2 };

export const stricterTier = (a: Tier, b: Tier): Tier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);

/** "1234567890" -> "123-456-7890" */
const dashed = (id: string): string =>
  /^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;

/** 40000000 EUR -> "40.00 EUR" (the currency's own decimals). */
export const money = (micros: bigint, currencyCode: string): string => {
  const unit = minimumUnitMicros(currencyCode) ?? 10_000n;
  const digits = unit >= 1_000_000n ? 0 : unit >= 100_000n ? 1 : 2;
  return `${microsToDecimalString(micros, { minFractionDigits: digits })} ${currencyCode}`;
};

export const amountMicros = (amount: number): bigint => decimalToMicros(amount.toFixed(6));

const pctScaled = (pct: number): bigint => BigInt(Math.round(pct * Number(PCT_SCALE)));

/** |after - before| * 100 > pct * before, exactly. before <= 0 with any change = over. */
const overPct = (before: bigint, after: bigint, pct: number): boolean => {
  const delta = after > before ? after - before : before - after;
  if (delta === 0n) return false;
  if (before <= 0n) return true;
  return delta * 100n * PCT_SCALE > pctScaled(pct) * before;
};

/** Percentage for messages, one decimal, rounded up so it never reads as under the limit. */
const pctText = (before: bigint, after: bigint): string => {
  if (before <= 0n) return "more than any";
  const delta = after > before ? after - before : before - after;
  const tenths = (delta * 1000n + before - 1n) / before;
  return `${tenths / 10n}${tenths % 10n ? `.${tenths % 10n}` : ""}%`;
};

/** A micros amount (int64 string, as Google sends it); null when missing or not an integer. */
const micros = (value: string | null | undefined): bigint | null => {
  if (value === null || value === undefined) return null;
  try {
    return parseMicros(value);
  } catch {
    return null;
  }
};

/** A target (micros or a ROAS ratio like "4.5") scaled by 10^6, for exact ratio maths. */
const scaled = (value: string | null | undefined): bigint | null => {
  if (value === null || value === undefined) return null;
  try {
    return decimalToMicros(value);
  } catch {
    return null;
  }
};

/**
 * Daily spend a change can add: budget raises + the budgets of campaigns it turns on.
 * Decreases never offset. null when a turned-on campaign's budget is unknown.
 */
export const addedSpend = (facts: ChangeFacts): bigint | null => {
  let sum = 0n;
  for (const b of facts.budgetChanges ?? []) {
    const before = micros(b.beforeMicros);
    const after = micros(b.afterMicros);
    if (before === null || after === null) return null;
    if (after > before) sum += after - before;
  }
  for (const e of facts.newlyEnabled ?? []) {
    const budget = micros(e.dailyBudgetMicros);
    if (budget === null) return null;
    sum += budget;
  }
  return sum;
};

/** Spend already added on this account in the last 24 h (unknown amounts count as the cap). */
export const spentInWindow = (recent: readonly RecentWrite[], cap: bigint): bigint =>
  recent
    .filter((r) => SPENT_STATUSES.has(r.status))
    .reduce((sum, r) => sum + (addedSpend(r.facts) ?? cap), 0n);

const matches = (pattern: string, type: string): boolean =>
  pattern.endsWith("*") ? type.startsWith(pattern.slice(0, -1)) : pattern === type;

/** The tier the policy file gives a type: exact key first, else the strictest matching pattern. */
export const configuredTier = (policy: PolicyV1, type: string): Tier => {
  const exact = policy.tiers[type];
  if (exact) return exact;
  let found: Tier | null = null;
  for (const [pattern, tier] of Object.entries(policy.tiers)) {
    if (pattern !== type && matches(pattern, type)) {
      found = found ? stricterTier(found, tier) : tier;
    }
  }
  return found ?? "confirm";
};

/**
 * The fixed low-risk list where `auto` is honoured: pausing one campaign, and lowering
 * budgets (nothing turned on, no target changed). Anything else with auto = confirm.
 */
export const isLowRisk = (type: string, payload: unknown, facts: ChangeFacts): boolean => {
  if ((facts.newlyEnabled ?? []).length > 0) return false;
  if ((facts.targetChanges ?? []).length > 0 || facts.strategySwitch) return false;
  if (type === "update_campaign_status") {
    const status = (payload as { status?: unknown } | null)?.status;
    return status === "PAUSED" && (facts.budgetChanges ?? []).length === 0;
  }
  if (type === "update_budget") {
    const changes = facts.budgetChanges ?? [];
    return (
      changes.length > 0 &&
      changes.every((b) => {
        const before = micros(b.beforeMicros);
        const after = micros(b.afterMicros);
        return before !== null && after !== null && after < before;
      })
    );
  }
  return false;
};

const no = (rule: string, reason: string): Verdict => ({
  allowed: false,
  tier: "blocked",
  reason,
  rule,
});

/** May this account be written at all (kill switch, accounts.write, blocked tier)? */
export const gateOf = (policy: PolicyV1, customerId: string, type: string): Verdict => {
  if (policy.kill_switch) {
    return no(
      "kill_switch",
      "Changes are switched off: kill_switch is true in the policy file. Nothing was sent.",
    );
  }
  if (!policy.accounts.write.includes(customerId)) {
    return no(
      "accounts.write",
      `Account ${dashed(customerId)} is read-only: the policy file does not list it under accounts.write.`,
    );
  }
  if (configuredTier(policy, type) === "blocked") {
    return no("tiers", `The policy file blocks ${type} changes (tiers: blocked).`);
  }
  return { allowed: true, tier: "confirm", reason: "", rule: null };
};

/** Every check for one change. Same rules at propose, apply, in the claim and for undo. */
export const evaluate = (policy: PolicyV1, req: PolicyRequest): Verdict => {
  const id = req.account.customerId;
  const currency = req.account.currencyCode;
  const gate = gateOf(policy, id, req.type);
  if (!gate.allowed) return gate;
  const limits = policy.limits;
  const now = req.now ?? Date.now();
  const recent = req.recent ?? [];
  const undoRestore = req.restoresBefore === true && req.undoOf !== null;

  if (req.opsCount > limits.max_ops_per_change) {
    return no(
      "limits.max_ops_per_change",
      `This change has ${req.opsCount} operations; the policy allows at most ${limits.max_ops_per_change} in one change.`,
    );
  }
  if (recent.length >= limits.writes_per_day) {
    return no(
      "limits.writes_per_day",
      `${recent.length} changes were already sent to this account in the last 24 hours; the policy allows ${limits.writes_per_day} a day. Try again later.`,
    );
  }
  const lastMinute = recent.filter((r) => Date.parse(r.claimedAt) > now - MINUTE_MS).length;
  if (lastMinute >= limits.writes_per_minute) {
    return no(
      "limits.writes_per_minute",
      `${lastMinute} changes were sent to this account in the last minute; the policy allows ${limits.writes_per_minute} a minute. Try again in a minute.`,
    );
  }

  const absCap = limits.max_budget_change_abs[id];
  for (const b of req.facts.budgetChanges ?? []) {
    const before = micros(b.beforeMicros);
    const after = micros(b.afterMicros);
    if (before === null || after === null) {
      return no("limits.budget", "The budget amounts of this change could not be read.");
    }
    // An undo may go back to exactly the old value even if that is a bigger step.
    if (!undoRestore && overPct(before, after, limits.max_budget_change_pct)) {
      return no(
        "limits.max_budget_change_pct",
        `This changes budget ${b.budgetId} by ${pctText(before, after)} (${money(before, currency)} -> ${money(after, currency)}); the policy allows at most ${limits.max_budget_change_pct}% in one change.`,
      );
    }
    if (absCap !== undefined) {
      const delta = after > before ? after - before : before - after;
      if (delta > amountMicros(absCap)) {
        return no(
          "limits.max_budget_change_abs",
          `This changes budget ${b.budgetId} by ${money(delta, currency)}; the policy allows at most ${money(amountMicros(absCap), currency)} in one change on this account.`,
        );
      }
    }
  }

  const targets = req.facts.targetChanges ?? [];
  // Removing a target, or switching between target CPA and target ROAS (one goes, the
  // other comes), can't be measured in percent: refused unless it is an exact undo.
  const sets = targets.find((t) => t.before === null && t.after !== null);
  for (const t of targets) {
    if (undoRestore) break;
    const before = scaled(t.before);
    const after = scaled(t.after);
    const what = t.kind === "target_cpa_micros" ? "target CPA" : "target ROAS";
    if ((t.before !== null && before === null) || (t.after !== null && after === null)) {
      return no(
        "limits.max_target_change_pct",
        `The ${what} values of this change could not be read.`,
      );
    }
    if (before !== null && after !== null) {
      if (overPct(before, after, limits.max_target_change_pct)) {
        return no(
          "limits.max_target_change_pct",
          `This changes the ${what} by ${pctText(before, after)}; the policy allows at most ${limits.max_target_change_pct}% in one change.`,
        );
      }
    } else if (before !== null && after === null) {
      const other = sets && sets.kind !== t.kind ? sets : undefined;
      return no(
        "limits.max_target_change_pct",
        other
          ? `This switches from ${what} to ${other.kind === "target_cpa_micros" ? "target CPA" : "target ROAS"}, a change the policy's ${limits.max_target_change_pct}% target limit can't measure. Change it in Google Ads.`
          : `This removes the ${what}, a change the policy's ${limits.max_target_change_pct}% target limit can't measure. Change it in Google Ads.`,
      );
    }
  }

  // Plan 7 defaults, enforced on what the change creates (the create types follow them
  // while planning; this is the second line).
  const d = policy.defaults;
  if (d.new_entities_paused && (req.facts.createdEnabled ?? 0) > 0 && !undoRestore) {
    return no(
      "defaults.new_entities_paused",
      `This creates ${req.facts.createdEnabled} keyword(s) ENABLED; the policy (defaults.new_entities_paused) wants new keywords paused.`,
    );
  }
  if (d.broad_match_requires_smart_bidding && (req.facts.broadWithoutSmartBidding ?? 0) > 0) {
    return no(
      "defaults.broad_match_requires_smart_bidding",
      `This adds ${req.facts.broadWithoutSmartBidding} BROAD keyword(s) to a campaign without smart bidding; the policy (defaults.broad_match_requires_smart_bidding) does not allow that.`,
    );
  }
  const added = addedSpend(req.facts);
  if (added === null) {
    return no(
      "limits.max_new_daily_spend",
      "This turns on a campaign whose daily budget could not be read, so its new spend can't be checked against the policy.",
    );
  }
  if (added > 0n) {
    const capAmount = limits.max_new_daily_spend[id];
    if (capAmount === undefined) {
      return no(
        "limits.max_new_daily_spend",
        `This adds ${money(added, currency)} of daily spend, and the policy file sets no max_new_daily_spend for account ${dashed(id)}, so spend can't go up on it.`,
      );
    }
    const cap = amountMicros(capAmount);
    const used = spentInWindow(recent, cap);
    if (used + added > cap) {
      const left = cap > used ? cap - used : 0n;
      return no(
        "limits.max_new_daily_spend",
        `This adds ${money(added, currency)} of daily spend; ${money(used, currency)} was already added on this account in the last 24 hours, so only ${money(left, currency)} is left of the ${money(cap, currency)} 24-hour limit.`,
      );
    }
  }

  const tier = configuredTier(policy, req.type);
  const effective: Tier =
    tier === "auto" && !isLowRisk(req.type, req.payload, req.facts) ? "confirm" : tier;
  return { allowed: true, tier: effective, reason: "", rule: null };
};

/** Plain lines for the approval view. */
export const describeChange = (policy: PolicyV1, req: PolicyRequest): string[] => {
  const id = req.account.customerId;
  const currency = req.account.currencyCode;
  const recent = req.recent ?? [];
  const lines: string[] = [];
  const added = addedSpend(req.facts);
  const capAmount = policy.limits.max_new_daily_spend[id];
  if (added !== null && added > 0n && capAmount !== undefined) {
    const cap = amountMicros(capAmount);
    const used = spentInWindow(recent, cap);
    const left = cap > used + added ? cap - used - added : 0n;
    lines.push(
      `This raises daily spend on this account by ${money(added, currency)}; ${money(left, currency)} left of your ${money(cap, currency)} 24-hour limit.`,
    );
  }
  for (const b of req.facts.budgetChanges ?? []) {
    const before = micros(b.beforeMicros);
    const after = micros(b.afterMicros);
    if (before === null || after === null) continue;
    lines.push(
      `Budget ${b.budgetId} changes by ${pctText(before, after)} (policy limit ${policy.limits.max_budget_change_pct}% per change${req.restoresBefore && req.undoOf ? "; an undo back to the old value may go over it" : ""}).`,
    );
  }
  const blocked = req.facts.blockedConversions;
  if (blocked && blocked.count > 0) {
    lines.unshift(
      `OVERRIDE: ${blocked.count} negative keyword(s) block searches or keywords that had conversions; a person must accept that.`,
    );
  }
  for (const i of req.facts.items ?? []) {
    const parts = [
      i.created ? `${i.created} created` : "",
      i.updated ? `${i.updated} changed` : "",
      i.removed ? `${i.removed} removed` : "",
    ].filter(Boolean);
    if (parts.length) lines.push(`Writes ${i.kind.replace(/_/g, " ")}: ${parts.join(", ")}.`);
  }
  if ((req.facts.items ?? []).some((i) => i.kind === "keyword" && i.created > 0)) {
    lines.push(
      req.facts.createdEnabled
        ? `${req.facts.createdEnabled} new keyword(s) are ENABLED (defaults.new_entities_paused is false).`
        : "New keywords are created paused (defaults.new_entities_paused).",
    );
  }
  lines.push(
    `Changes sent to this account in the last 24 hours: ${recent.length} of ${policy.limits.writes_per_day} allowed.`,
    `Operations in this change: ${req.opsCount} of at most ${policy.limits.max_ops_per_change}.`,
  );
  return lines;
};
