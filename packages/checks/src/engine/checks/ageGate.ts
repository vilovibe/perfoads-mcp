// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The campaign-age gate — B1 of AUDIT_V3_RULE_GAP_PLAN.md (rules 305, 307, 309,
 * 310, 182, 230).
 *
 * Rule 305: no performance verdict on a campaign under 14 days old. A campaign
 * that launched last week is LEARNING, not failing, and telling a client his
 * nine-day-old campaign is "declining" is the fastest way to lose him.
 * `LEARNING.minAgeDaysForVerdicts` (registry/thresholds.ts) has carried that 14
 * since the merge and, until today, had ZERO callers in v3 — the number was
 * declared and never asked.
 *
 * The age it reads is `C.age_days`, and the honest name for that is a PROXY:
 * the model has no campaign start date at all, so age is measured from the
 * first day the campaign spent and saturates at the window length. That only
 * matters in one direction, and it is the safe one — the gate asks "younger
 * than 14 days?", and a campaign whose first spending day is inside the window
 * genuinely has fewer than 14 days of data to be judged on, whatever the day it
 * was created. A saturated 90 is never read here as "older than 90".
 *
 * Like brandGate.ts this is a DECLARED TABLE, one row per check id with its
 * rule, applied in `defineCheck` so a check imported straight from its group
 * module cannot bypass it.
 *
 * Three things it deliberately does NOT do:
 *   - it does not gate BB02/BB03 (impression share lost to budget / to rank).
 *     Those are structural facts about how a campaign is set up, true on its
 *     first day, not verdicts on how it performed.
 *   - it does not gate the account-level trend (TR01a). Rule 309 — account-wide
 *     trends mixing campaigns that switched on or off inside the period — is a
 *     real gap and is NOT closed here; it needs an "existed in both periods"
 *     identity check that the trend code does not have. Recorded, not pretended.
 *   - it does not implement rules 182 or 230 (a bidding strategy changed within
 *     14 days is still learning). Those need the bidding-strategy-change date,
 *     which is only derivable from `change_history` — a CAPPED,
 *     sampled feed that needs its own sampling treatment before any verdict may
 *     rest on it. Out of scope on purpose.
 */
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import {
  evidence,
  isOk,
  num,
  type CheckCtx,
  type CheckFinding,
  type CheckResult,
  type CheckScope,
  type EvidenceRef,
} from "./types.js";

export interface AgeRule {
  /** inventory rule number(s) this row encodes — AUDIT_V3_RULE_INVENTORY.md. */
  rules: string;
  /** why, in the words of the rule, for the suppression note and the trace. */
  why: string;
}

/** Rule 305's family: the checks whose finding is a VERDICT on how a campaign performed. */
export const AGE_GATED_CHECKS: Readonly<Record<string, AgeRule>> = {
  // --- rules 305 / 310: a decline needs a campaign old enough to have declined FROM
  // something; TR01 demands 14 active days, and age is the other half.
  TR01: { rules: "305, 310", why: "a campaign under the learning age is starting, not declining" },
  TR06: { rules: "305", why: "a campaign under the learning age has not had time to convert" },
  // --- rules 305 / 230: budget and bid-target verdicts are averages. On a
  // campaign still inside its learning period the average is the learning.
  BB01: {
    rules: "305",
    why: "budget utilisation on a campaign under the learning age measures the ramp, not the budget",
  },
  BB04: {
    rules: "305, 230",
    why: "a bid target on a campaign under the learning age is not yet ahead of the data — it has no data",
  },
  BB05: {
    rules: "305, 230",
    why: "a bid target cannot be called choking on a campaign still in its learning period",
  },
  BB06: {
    rules: "305, 230",
    why: "a campaign under the learning age is not ready for a bid target",
  },
  BB07: { rules: "305", why: "a campaign under the learning age is not yet proven profitable" },
  BB16: {
    rules: "305, 230",
    why: "a target cannot be called loose on a campaign still in its learning period",
  },
  // --- B14 / B17: a device verdict on a campaign still learning judges the ramp, not the device
  SL05: { rules: "305", why: "device costs on a campaign under the learning age measure the ramp" },
  SL06: {
    rules: "305",
    why: "a device on a campaign under the learning age has not had time to convert",
  },
  SL09: {
    rules: "305",
    why: "mobile against desktop on a campaign under the learning age measures the ramp",
  },
};

/** The campaign a finding sits in, when the model knows it. Same resolution the brand gate uses. */
function campaignOf(ctx: CheckCtx, scope: CheckScope): CampaignNode | null {
  const id = scope.type === "campaign" ? scope.id : (scope.campaignId ?? null);
  if (id) return ctx.metrics.index.campaignsById.get(id) ?? null;
  return null;
}

/**
 * Apply the table. Runs for every check, after the brand gate.
 *
 * A dropped finding is never silent: the age that dropped it is stamped on the
 * surviving findings of the same check as a citable `C.age_days` row, and when
 * the age drops EVERY finding the check reports `none_found` carrying those same
 * rows — so "Spring launch is 9 days old" reaches the report as a measured number
 * instead of disappearing with the finding. That is the same shape the activity
 * gate uses for `E.entity_status`.
 */
export function applyAgeGate(checkId: string, ctx: CheckCtx, r: CheckResult): CheckResult {
  if (r.state !== "fires") return r;
  const rule = AGE_GATED_CHECKS[checkId];
  if (!rule) return r;
  const minAge = ctx.settings.floors.learningMinAgeDays;

  const kept: CheckFinding[] = [];
  const tooYoung: { name: string; days: number }[] = [];
  const ageRows: EvidenceRef[] = [];
  for (const f of r.findings) {
    const c = campaignOf(ctx, f.scope);
    if (!c) {
      kept.push(f);
      continue;
    }
    const v = ctx.get("C.age_days", { campaignId: c.id });
    const days = num(v);
    // an age the model cannot compute is an unknown age, not a young campaign:
    // the finding stands, exactly as the activity gate leaves an unresolvable scope alone.
    if (days == null || days >= minAge) {
      kept.push(f);
      continue;
    }
    tooYoung.push({ name: c.name, days });
    if (isOk(v)) ageRows.push(evidence(v, { id: c.id, name: c.name }));
  }
  if (tooYoung.length === 0) return r;

  const note = `${tooYoung.length} finding(s) held back because the campaign is still learning: ${rule.why} — ${tooYoung.map((t) => `${t.name} first spent ${t.days} days ago, under the ${minAge}-day minimum`).join("; ")}`;
  if (kept.length === 0)
    return { state: "fires", findings: [], withheld: [...(r.withheld ?? []), note] };
  return {
    state: "fires",
    ...(r.withheld ? { withheld: r.withheld } : {}),
    findings: kept.map((f) => ({
      ...f,
      evidence: [...f.evidence, ...ageRows],
      facts: { ...f.facts, campaigns_below_learning_age: tooYoung.length },
      note: [f.note, note].filter(Boolean).join("; "),
    })),
  };
}
