// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Budget and bidding checks: BB01-BB11, BB14-BB17.
 *
 * A check here decides ONE thing and returns evidence. It never picks a
 * severity, never computes a dollar figure and never resolves its own
 * confounders: `confounders` and `impactFormula` are DATA for interactions/
 * and scoring/ (checks/types.ts header).
 *
 * Judgement bars come from `ctx.settings.bidding` (settings.ts): defaults the
 * caller can override per run. Two numbers this file must not get wrong:
 *   - `C.budget_util90` divides by `C.budget_days`, which caps at the REAL
 *     window length, never a literal 90. The registry owns that formula.
 *   - BB03's money gate is `T.waste_floor`, the one money bar for "wasted".
 */
import { cmpStr } from "../shared/order.js";
import { eligibleCampaigns, scaleMoney } from "../registry/index.js";
import type { MetricPayload, MetricValue } from "../registry/types.js";
import {
  ACCOUNT_AVERAGE_BAR_NOTE,
  aiTargetIgnoredNote,
  clientGrossMargin,
  declaredTargetFor,
  targetBar,
  targetSentence,
} from "./clientContextGate.js";
import { brandMatcherOfModel } from "../model/context.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import {
  campaignsOf,
  defineCheck,
  finding,
  gateOnData,
  isOk,
  lostIsBudgetNow,
  num,
  str,
  type CheckCtx,
  type CheckDefinition,
  type CheckFinding,
  type CheckResult,
  type CheckScope,
} from "./types.js";

const scopeOf = (c: { id: string; name: string }): CheckScope => ({
  type: "campaign",
  id: c.id,
  name: c.name,
});

/** Every check below runs over the ONE eligible-campaign definition (§A.1). */
const campaigns = (ctx: CheckCtx) => eligibleCampaigns(ctx.model);

/**
 * Rule: `population` is how many entities the check JUDGED — the same value on
 * every finding one run emits. Never the loop index, never the finding count.
 * The loop counter is only final once the loop ends, so it is stamped here.
 */
function withPopulation(findings: CheckFinding[], population: number): CheckFinding[] {
  for (const f of findings) f.sample.population = population;
  return findings;
}

/** `C.window(w)` returns an object; pull one field or null. */
function windowField(
  v: MetricValue,
  field: "cost" | "conv" | "value" | "roas" | "cpa",
): number | null {
  if (!isOk(v) || v.value == null || typeof v.value !== "object" || Array.isArray(v.value))
    return null;
  const raw = (v.value as Record<string, unknown>)[field];
  return typeof raw === "number" ? raw : null;
}

/** Daily rows behind a `C.window(w)` value — the `F.days_min_for_window` input. */
function windowRows(v: MetricValue): number | null {
  return isOk(v) ? (v.source.rowCount ?? null) : null;
}

function daysMinForWindow(ctx: CheckCtx): number {
  return num(ctx.get("F.days_min_for_window")) ?? 10;
}

/** Rule: a money comparison at an unknown currency scale is not made at all (§A.9). */
function currencyGate(ctx: CheckCtx): CheckResult | null {
  return ctx.currency.known
    ? null
    : {
        state: "insufficient_data",
        reason: "account currency is unknown; money floors are not comparable at USD scale",
      };
}

// ---------------------------------------------------------------------------

/** BB01 — budget utilisation low. Context for BB05/BB07, never a finding alone. */
export const bb01 = defineCheck({
  id: "BB01",
  claimKey: "budget.utilisation_low",
  title: "Campaign uses less than half its budget",
  group: "budget_bidding",
  metrics: ["C.budget_util90", "C.spend", "C.budget_daily", "C.budget_days"],
  confounders: ["BB05", "BB02", "MI01"],
  requires: ["campaigns", "campaignDailyMetrics"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Each campaign uses its budget.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "campaignDailyMetrics"]);
    if (gate) return gate;
    const money = currencyGate(ctx);
    if (money) return money;
    const { lowUtilisation, lowUtilisationMinSpendUsd } = ctx.settings.bidding;
    const floor = scaleMoney(lowUtilisationMinSpendUsd, ctx.currency);

    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of campaigns(ctx)) {
      const util = ctx.get("C.budget_util90", { campaignId: c.id });
      const spend = ctx.get("C.spend", { campaignId: c.id });
      const u = num(util);
      const s = num(spend);
      if (u == null || s == null) continue;
      population++;
      if (u >= lowUtilisation || s < floor) continue;
      const daily = ctx.get("C.budget_daily", { campaignId: c.id });
      const days = ctx.get("C.budget_days", { campaignId: c.id });
      findings.push(
        finding({
          claimKey: "budget.utilisation_low",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [util, spend, daily, days],
          facts: { util90: u, spend: s, budget_daily: num(daily), budget_days: num(days) },
          note: "context for BB05/BB07 — utilisation alone is not a finding",
        }),
      );
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no eligible campaign has both a budget and a daily series",
        table: "campaign_daily_metrics",
      };
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note: `every campaign spending ≥ ${floor} uses at least ${Math.round(lowUtilisation * 100)}% of its budget`,
        };
  },
});

/**
 * BB02 — impression share lost to budget.
 *
 * Judged on the window's last 3 weeks when they were read: US - SHOP - HERO read 13% over
 * 90 days from its launch weeks and 0% in each of the last 3, and was still priced. A
 * campaign with no activity in those weeks is not limited by its budget now. The return per
 * $1 is always stated (value / spend, not floored), and set against ONE bar: the client's
 * declared target for the campaign first (as BB07), then break-even from the stated gross
 * margin (as SH21), and the account's own return only when neither is known. A campaign
 * below its bar is never priced (IMP_LOSTIS reads the same bar from the facts).
 */
export const bb02 = defineCheck({
  id: "BB02",
  claimKey: "budget.lost_is_budget",
  title: "Campaign loses impressions to its budget",
  group: "budget_bidding",
  metrics: [
    "C.lost_is_budget_recent_pct",
    "C.lost_is_budget_pct",
    "C.spend",
    "C.value",
    "C.roas",
    "C.cpa",
    "A.spend",
    "A.conv_value",
  ],
  confounders: ["AS03", "BB05"],
  requires: ["campaigns", "impressionShare"],
  impactFormula: "IMP_LOSTIS",
  noneFoundMeans: "No campaign loses impressions to budget.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "impressionShare"]);
    if (gate) return gate;
    const findings: CheckFinding[] = [];
    let population = 0;
    const noRow: string[] = [];
    const idle: string[] = [];
    const aSpend = ctx.get("A.spend");
    const aValue = ctx.get("A.conv_value");
    const accountReturn = perDollar(num(aValue), num(aSpend));
    for (const c of campaigns(ctx)) {
      const lost90 = ctx.get("C.lost_is_budget_pct", { campaignId: c.id });
      const v90 = num(lost90);
      if (v90 == null) {
        noRow.push(c.name);
        continue;
      }
      population++;
      const recent = ctx.get("C.lost_is_budget_recent_pct", { campaignId: c.id });
      const r = c.attrs.impressionShare.recent;
      // read, and no activity in those weeks: nothing is held back by the budget today
      if (r != null && !isOk(recent)) {
        if (v90 > ctx.settings.bidding.lostIsBudgetPct) idle.push(c.name);
        continue;
      }
      const judged = isOk(recent) ? num(recent) : v90;
      if (judged == null || judged <= ctx.settings.bidding.lostIsBudgetPct) continue;
      const spend = ctx.get("C.spend", { campaignId: c.id });
      const value = ctx.get("C.value", { campaignId: c.id });
      const roas = ctx.get("C.roas", { campaignId: c.id });
      const ret = perDollar(num(value), num(spend));
      const bar = lostIsReturnBar(ctx, c.id, ret, accountReturn);
      findings.push(
        finding({
          claimKey: "budget.lost_is_budget",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: isOk(recent)
            ? [recent, lost90, spend, value, roas, aSpend, aValue]
            : [lost90, spend, value, roas, aSpend, aValue],
          facts: {
            lost_is_budget_pct: judged,
            judged_on: isOk(recent) ? "last 3 weeks" : "90 days (recent weeks not read)",
            ...(isOk(recent)
              ? {
                  recent_start: r?.start ?? null,
                  recent_end: r?.end ?? null,
                  lost_is_budget_pct_90d: v90,
                }
              : {}),
            spend_90d: num(spend),
            sales_90d: num(value),
            return_per_dollar: ret,
            account_return_per_dollar: accountReturn,
            ...bar.facts,
            roas: num(roas),
          },
          note: bar.note,
        }),
      );
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: `no campaign has an impression_share row (${noRow.length} campaigns have none)`,
        table: "impression_share",
      };
    const idleNote =
      idle.length > 0
        ? `; ${idle.length} lost to budget over 90 days but had no activity in the last 3 weeks: ${idle.join(", ")}`
        : "";
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note: `${noRow.length} campaigns have no impression_share row and are not checkable for lost IS: ${noRow.join(", ")}${idleNote}`,
        };
  },
});

/**
 * The return a BB02 campaign is held to before its lost views are priced. One bar, in
 * order: the client's declared target for the campaign (ROAS or cost per sale, as BB07),
 * then break-even from the stated gross margin (as SH21), then the account's own return.
 * `return_bar` (ROAS bars) or `declared_target_cpa` reach IMP_LOSTIS through the facts.
 */
function lostIsReturnBar(
  ctx: CheckCtx,
  campaignId: string,
  ret: number | null,
  accountReturn: number | null,
): { facts: Record<string, MetricPayload>; note: string } {
  const declared = declaredTargetFor(ctx, campaignId);
  if (declared) {
    const bar = targetBar(declared.target);
    if (declared.target.kind === "cpa") {
      const cpa = num(ctx.get("C.cpa", { campaignId }));
      return {
        facts: {
          return_bar_source: "client_target",
          declared_target_cpa: bar,
          cpa_90d: cpa,
          below_return_bar: cpa == null ? null : cpa > bar,
        },
        note: targetSentence(declared),
      };
    }
    return {
      facts: {
        return_bar_source: "client_target",
        return_bar: bar,
        below_return_bar: ret == null ? null : ret < bar,
      },
      note: targetSentence(declared),
    };
  }
  const margin = clientGrossMargin(ctx);
  if (margin) {
    return {
      facts: {
        return_bar_source: "break_even_margin",
        return_bar: margin.breakEvenRoas,
        gross_margin_pct: margin.marginPct,
        below_return_bar: ret == null ? null : ret < margin.breakEvenRoas,
      },
      note: `judged against break-even from your stated ${margin.marginPct}% gross margin (${margin.breakEvenRoas.toFixed(2)} per $1); an estimate`,
    };
  }
  return {
    facts: {
      return_bar_source: "account_average",
      return_bar: accountReturn,
      below_return_bar: ret != null && accountReturn != null ? ret < accountReturn : null,
    },
    note: [ACCOUNT_AVERAGE_BAR_NOTE, aiTargetIgnoredNote(ctx, campaignId)]
      .filter(Boolean)
      .join("; "),
  };
}

/** value / spend, unfloored; null without spend. */
const perDollar = (value: number | null, spend: number | null): number | null =>
  value == null || spend == null || spend <= 0 ? null : value / spend;

/** BB03 — impression share lost to rank. The bar is STRICT: a share exactly at it does not fire. */
export const bb03 = defineCheck({
  id: "BB03",
  claimKey: "budget.lost_is_rank",
  title: "Campaign loses impressions to ad rank",
  group: "budget_bidding",
  metrics: ["C.lost_is_rank_pct", "C.spend", "T.waste_floor"],
  confounders: ["SK02", "SK14"],
  requires: ["campaigns", "impressionShare"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Impression share is not rank-limited.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "impressionShare"]);
    if (gate) return gate;
    const wasteFloor = ctx.get("T.waste_floor");
    const floor = num(wasteFloor);
    if (floor == null)
      return {
        state: "insufficient_data",
        reason: "T.waste_floor is not computable (unknown currency or no account spend)",
      };

    const findings: CheckFinding[] = [];
    let population = 0;
    const noRow: string[] = [];
    for (const c of campaigns(ctx)) {
      const lost = ctx.get("C.lost_is_rank_pct", { campaignId: c.id });
      const v = num(lost);
      if (v == null) {
        noRow.push(c.name);
        continue;
      }
      population++;
      const spend = ctx.get("C.spend", { campaignId: c.id });
      const s = num(spend);
      if (!(v > ctx.settings.bidding.lostIsRankPct) || s == null || s < floor) continue;
      findings.push(
        finding({
          claimKey: "budget.lost_is_rank",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [lost, spend, wasteFloor],
          facts: { lost_is_rank_pct: v, spend: s, waste_floor: floor },
        }),
      );
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: `no campaign has an impression_share row (${noRow.length} campaigns have none)`,
        table: "impression_share",
      };
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note: `tested strictly at > ${ctx.settings.bidding.lostIsRankPct}% with a ${floor} spend floor; ${noRow.length} campaigns have no impression_share row`,
        };
  },
});

/** BB04 — a bid target set ahead of the conversion volume that supports it. */
export const bb04 = defineCheck({
  id: "BB04",
  claimKey: "bidding.ahead_of_data",
  title: "Bid target set ahead of the data",
  group: "budget_bidding",
  metrics: ["C.ladder_verdict", "C.strategy", "C.target_roas", "C.target_cpa", "C.window(w)"],
  confounders: ["MI01", "TR01"],
  requires: ["campaigns", "campaignDailyMetrics"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each bid target has the conversion volume to support it.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "campaignDailyMetrics"]);
    if (gate) return gate;
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of campaigns(ctx)) {
      const verdict = ctx.get("C.ladder_verdict", { campaignId: c.id });
      const v = str(verdict);
      if (v == null) continue;
      population++;
      if (v !== "ahead_of_data") continue;
      const strategy = ctx.get("C.strategy", { campaignId: c.id });
      const tRoas = ctx.get("C.target_roas", { campaignId: c.id });
      const tCpa = ctx.get("C.target_cpa", { campaignId: c.id });
      const w30 = ctx.get("C.window(w)", { campaignId: c.id, window: "30d" });
      findings.push(
        finding({
          claimKey: "bidding.ahead_of_data",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [verdict, strategy, tRoas, tCpa, w30],
          facts: {
            strategy: str(strategy),
            target_roas: num(tRoas),
            target_cpa: num(tCpa),
            conv_30d: windowField(w30, "conv"),
            status: c.status ?? null,
          },
        }),
      );
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no campaign has a resolvable ladder verdict (no 30d daily series)",
        table: "campaign_daily_metrics",
      };
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

/** BB05 — a tROAS so far above reality that it is holding delivery back.
 *  A 2.4x ratio computed on 8 daily rows is not a finding: the days floor governs. */
export const bb05 = defineCheck({
  id: "BB05",
  claimKey: "bidding.target_choking",
  title: "Bid target is choking delivery",
  group: "budget_bidding",
  metrics: [
    "C.target_roas",
    "C.window(w)",
    "C.budget_util90",
    "C.budget_daily",
    "F.days_min_for_window",
  ],
  confounders: ["MI01", "BB01", "TR01"],
  requires: ["campaigns", "campaignDailyMetrics"],
  impactFormula: "IMP_SCALE",
  noneFoundMeans: "No bid target is holding delivery back.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "campaignDailyMetrics"]);
    if (gate) return gate;
    const money = currencyGate(ctx);
    if (money) return money;
    const { chokingMinDailyBudgetUsd, chokingUtilBelow, chokingTargetVsRealised } =
      ctx.settings.bidding;
    const minBudget = scaleMoney(chokingMinDailyBudgetUsd, ctx.currency);
    const minDays = daysMinForWindow(ctx);

    const findings: CheckFinding[] = [];
    const daysBlocked: string[] = [];
    let population = 0;
    for (const c of campaigns(ctx)) {
      const tRoas = ctx.get("C.target_roas", { campaignId: c.id });
      const target = num(tRoas);
      if (target == null) continue;
      const util = ctx.get("C.budget_util90", { campaignId: c.id });
      const daily = ctx.get("C.budget_daily", { campaignId: c.id });
      const u = num(util);
      const b = num(daily);
      if (u == null || b == null) continue;
      population++;
      if (u >= chokingUtilBelow || b < minBudget) continue;
      const w30 = ctx.get("C.window(w)", { campaignId: c.id, window: "30d" });
      const p30 = ctx.get("C.window(w)", { campaignId: c.id, window: "prior30" });
      const realized = windowField(w30, "roas");
      if (realized == null || realized <= 0 || target < chokingTargetVsRealised * realized)
        continue;
      const rows30 = windowRows(w30) ?? 0;
      const rowsPrior = windowRows(p30) ?? 0;
      if (rows30 < minDays || rowsPrior < minDays) {
        daysBlocked.push(
          `${c.name} (${rows30} rows in 30d, ${rowsPrior} in prior30, floor ${minDays})`,
        );
        continue;
      }
      findings.push(
        finding({
          claimKey: "bidding.target_choking",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [tRoas, w30, util, daily],
          facts: {
            target_roas: target,
            roas_30d: realized,
            target_vs_realized: target / realized,
            util90: u,
            budget_daily: b,
          },
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };
    if (daysBlocked.length > 0) {
      return {
        state: "insufficient_data",
        reason: `target/realised ratio clears the bar but the daily series does not: ${daysBlocked.join("; ")}`,
      };
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason:
          "no campaign has both a target return on ad spend (tROAS) and a budget that could be read",
        table: "campaigns",
      };
    return { state: "none_found", population };
  },
});

/** BB06 — no target set and enough conversions to set one. Brand is exempt by rule. */
export const bb06 = defineCheck({
  id: "BB06",
  claimKey: "bidding.ready_for_target",
  title: "Campaign is ready for a bid target",
  group: "budget_bidding",
  metrics: ["C.ladder_verdict", "C.window(w)", "C.strategy"],
  confounders: ["AS02"],
  requires: ["campaigns", "campaignDailyMetrics"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No campaign is waiting for a target.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "campaignDailyMetrics"]);
    if (gate) return gate;
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of campaigns(ctx)) {
      const verdict = ctx.get("C.ladder_verdict", { campaignId: c.id });
      const v = str(verdict);
      if (v == null) continue;
      population++;
      if (v !== "ready_for_target") continue;
      const w30 = ctx.get("C.window(w)", { campaignId: c.id, window: "30d" });
      const strategy = ctx.get("C.strategy", { campaignId: c.id });
      findings.push(
        finding({
          claimKey: "bidding.ready_for_target",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [verdict, w30, strategy],
          facts: {
            conv_30d: windowField(w30, "conv"),
            strategy: str(strategy),
            is_brand: c.attrs.isBrand,
          },
        }),
      );
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no campaign has a resolvable ladder verdict (no 30d daily series)",
        table: "campaign_daily_metrics",
      };
    return findings.length > 0
      ? { state: "fires", findings }
      : { state: "none_found", population, note: "brand campaigns are exempt by rule" };
  },
});

/**
 * BB07 — profitable AND budget-starved. Needs an impression-share row: a campaign
 * at 99% utilisation with no IS row and zero conversions is not a scale candidate.
 *
 * §3b step 1 — WHICH BAR "profitable" IS MEASURED AGAINST.
 *
 * Until now the bar was the ACCOUNT'S OWN AVERAGE: `roas30 >= A.roas`. That is a
 * legitimate relative test and it is the only one available without a target,
 * but the word it produces — "profitable" — reads as an absolute. This is the
 * exact failure the SO Keywords work found in production: a verdict scored
 * against the account average and printed as though it were absolute, so a 2.6x
 * winner read "losing money".
 *
 * A campaign whose OWNER declared "target ROAS 3:1 or better" can be judged
 * against 3:1 instead, and then "profitable" means what the client means by it.
 * So:
 *   - a CLIENT-declared target for this campaign becomes the bar, and the
 *     finding carries which bar it used;
 *   - an AI-suggested target is NOT a bar. `declaredTargetFor` refuses it, and
 *     the fact that one existed is recorded so the trace shows the refusal
 *     rather than looking like the question was never asked;
 *   - with no declaration the account average stays the bar, unchanged, and the
 *     finding now SAYS it is a relative bar (`ACCOUNT_AVERAGE_BAR_NOTE`).
 *
 * The account-average numbers are cited either way: they are true, they are
 * what the reader needs to weigh the campaign, and D8 forbids dropping a
 * finding whose value is the information.
 */
export const bb07 = defineCheck({
  id: "BB07",
  claimKey: "budget.scale_candidate",
  title: "Campaign is profitable and budget-starved",
  group: "budget_bidding",
  metrics: [
    "C.budget_util90",
    "C.lost_is_budget_recent_pct",
    "C.lost_is_budget_pct",
    "C.window(w)",
    "A.roas",
    "A.cpa",
  ],
  confounders: ["BB05", "AS03", "BB09", "TR03", "SL04", "SK22", "MI01", "TR01", "SH01"],
  requires: ["campaigns", "impressionShare", "campaignDailyMetrics"],
  impactFormula: "IMP_SCALE",
  noneFoundMeans: "No campaign is both profitable and budget-starved.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "impressionShare", "campaignDailyMetrics"]);
    if (gate) return gate;
    const { scaleUtilMin, scaleLostIsBudgetPct } = ctx.settings.bidding;
    const accRoas = ctx.get("A.roas");
    const accCpa = ctx.get("A.cpa");
    const aRoas = num(accRoas);
    const aCpa = num(accCpa);

    const findings: CheckFinding[] = [];
    let population = 0;
    const highUtilNoIsRow: string[] = [];
    for (const c of campaigns(ctx)) {
      const util = ctx.get("C.budget_util90", { campaignId: c.id });
      // the last 3 weeks, as BB02 (90 days only when they were not read)
      const now = lostIsBudgetNow(ctx, c.id);
      const lost = now.metric;
      const u = num(util);
      const l = now.value;
      if (now.idle) {
        if (u != null) population++;
        continue;
      }
      if (l == null) {
        if (u != null && u >= scaleUtilMin)
          highUtilNoIsRow.push(`${c.name} (util90 ${u.toFixed(4)}, no impression_share row)`);
        continue;
      }
      if (u == null) continue;
      population++;
      if (u < scaleUtilMin || l <= scaleLostIsBudgetPct) continue;
      const w30 = ctx.get("C.window(w)", { campaignId: c.id, window: "30d" });
      const roas30 = windowField(w30, "roas");
      const cpa30 = windowField(w30, "cpa");
      const declared = declaredTargetFor(ctx, c.id);
      const bar = declared ? targetBar(declared.target) : null;
      // The declared bar REPLACES the account average when there is one; it does
      // not sit beside it as a second way to qualify. Two bars either of which
      // may pass is a lower bar than one, and the client named his.
      const profitable =
        declared && bar != null
          ? declared.target.kind === "roas"
            ? roas30 != null && roas30 >= bar
            : cpa30 != null && cpa30 <= bar
          : (roas30 != null && aRoas != null && roas30 >= aRoas) ||
            (cpa30 != null && aCpa != null && cpa30 <= aCpa);
      if (!profitable) continue;
      const targetFacts: Record<string, MetricPayload> =
        declared && bar != null
          ? {
              target_source: "client_declared",
              ...(declared.target.kind === "roas"
                ? { declared_target_roas: bar }
                : { declared_target_cpa: bar }),
            }
          : { target_source: "account_average" };
      const barNote = declared
        ? targetSentence(declared)
        : [ACCOUNT_AVERAGE_BAR_NOTE, aiTargetIgnoredNote(ctx, c.id)].filter(Boolean).join("; ");
      findings.push(
        finding({
          claimKey: "budget.scale_candidate",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [util, lost, w30, accRoas, accCpa],
          facts: {
            util90: u,
            lost_is_budget_pct: l,
            roas_30d: roas30,
            cpa_30d: cpa30,
            account_roas: aRoas,
            account_cpa: aCpa,
            ...targetFacts,
          },
          note: barNote,
        }),
      );
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no campaign has both an impression_share row and a budget utilisation",
        table: "impression_share",
      };
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note:
            highUtilNoIsRow.length > 0
              ? `not checkable for lost IS despite high utilisation: ${highUtilNoIsRow.join("; ")}`
              : `no campaign reaches ${Math.round(scaleUtilMin * 100)}% utilisation`,
        };
  },
});

/** BB08 — portfolio bidding strategy in use.
 *  `campaigns.bidding_strategy_resource` carries the link (synced
 *  since Phase 1b; the model reads it). A null on every
 *  campaign is "none attached" ONLY when Google agrees: a bidding_strategies
 *  row whose non_removed_campaign_count > 0 with no campaign carrying the link
 *  is a sync contradiction (the attached campaign may be a zero-spend one the
 *  campaign fetch drops), and stays not_checkable. Empty is not clean (rule 4). */
export const bb08 = defineCheck({
  id: "BB08",
  claimKey: "bidding.portfolio_unreviewed",
  title: "Campaign runs on a portfolio bidding strategy",
  clientLabel: "campaigns on a shared (portfolio) bidding strategy",
  group: "budget_bidding",
  metrics: ["C.portfolio_strategy"],
  confounders: ["BB04"],
  requires: ["campaigns", "biddingStrategies"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Portfolio bidding, where used, is attached to campaigns we can see.",
  /**
   * ONE account-level result: being on a portfolio
   * strategy is not a finding, so the check never emits one per campaign. It is
   * `none_found` when every campaign Google says is attached is a campaign we
   * hold with the link, and a single `not_checkable` naming the contradiction
   * when the counts disagree. The rulebook has no rule on WHICH campaigns may
   * share a strategy, so there is nothing for it to fire on.
   */
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "biddingStrategies"]);
    if (gate) return gate;
    const linked = campaigns(ctx).filter(
      (c) => str(ctx.get("C.portfolio_strategy", { campaignId: c.id })) != null,
    );
    const strategies = ctx.model.attrs.biddingStrategies;
    const attachedInGoogle = strategies.filter(
      (s) => (s.nonRemovedCampaignCount ?? s.campaignCount ?? 0) > 0,
    );
    const attachedCount = attachedInGoogle.reduce(
      (n, s) => n + (s.nonRemovedCampaignCount ?? s.campaignCount ?? 0),
      0,
    );
    if (linked.length !== attachedCount) {
      const names = attachedInGoogle
        .map(
          (s) => `"${s.name ?? s.id}" (${s.nonRemovedCampaignCount ?? s.campaignCount} attached)`,
        )
        .join(", ");
      /**
       * Round 4 item 10: the sync now states each campaign's bidding source ('portfolio' /
       * 'standard'). When every campaign we hold has one, a campaign Google counts as
       * attached that we do not hold is one outside the audit window (no spend) — not a
       * lost link — so the question is answered for every campaign we audit.
       */
      const held = campaigns(ctx);
      const sourceKnown =
        held.length > 0 && held.every((c) => c.attrs.biddingStrategySource != null);
      const onPortfolio = held.filter(
        (c) => c.attrs.biddingStrategySource === "portfolio" || c.attrs.portfolioStrategyId != null,
      );
      if (sourceKnown && onPortfolio.length < attachedCount) {
        return {
          state: "none_found",
          population: held.length,
          // L3 review: no campaign in the window on a shared strategy = nothing to praise
          subject: onPortfolio.length,
          note:
            onPortfolio.length === 0
              ? `all ${held.length} campaigns in the window run their own (standard) bidding; Google counts ${attachedCount} campaign(s) on a shared strategy (${names}), none of them among the campaigns that spent in the window`
              : `${onPortfolio.length} of ${held.length} campaigns run on a shared strategy (${onPortfolio.map((c) => c.name).join(", ")}), the rest on their own; Google counts ${attachedCount - onPortfolio.length} more attached campaign(s) outside the window`,
        };
      }
      return {
        state: "not_checkable",
        reason:
          linked.length === 0
            ? `Google reports ${attachedInGoogle.length} portfolio strategy(ies) with a live campaign attached — ${names} — but bidding_strategy_resource is null on all ${campaigns(ctx).length} synced campaigns; the attached campaign may have had no spend in the window (the campaign fetch keeps spend > 0 only) or the link was lost in the sync, so no campaign can be attributed to a strategy`
            : `Google reports ${attachedCount} campaign(s) attached to a portfolio strategy (${names}) but ${linked.length} synced campaign(s) carry the link (${linked.map((c) => c.name).join(", ")}) — the difference is not in the campaigns we hold`,
        table: "bidding_strategies",
        category: "our_gap",
      };
    }
    return {
      state: "none_found",
      population: linked.length,
      note:
        linked.length === 0
          ? `${strategies.length} bidding_strategies row(s), none with a non-removed campaign attached; no campaign carries a bidding_strategy_resource`
          : `portfolio bidding is in use on ${linked.length} campaign(s) (${linked.map((c) => c.name).join(", ")}) and every attached campaign is known`,
    };
  },
});

/** BB09 — a bid modifier that contradicts how the slice performs.
 *  09-29: the sync's `modifier_source` + `criterion_key` resolve each row to the
 *  slice it multiplies (buildSlices), and `SL.modifier_vs_slice` measures that
 *  slice against its campaign. Fires when a bid is pushed UP (≥ +10%) on a
 *  slice that returns materially less (ROAS ≤ campaign / 1.5, or CPA ≥ 1.5x, or
 *  no sale for a full campaign CPA), or pushed DOWN (≤ -10%) on one that returns
 *  materially more. Judged only where the modifier acts: manual-CPC style
 *  strategies (Smart Bidding ignores every adjustment but a -100% exclusion,
 *  and a -100% slice has no traffic left to compare). */
export const bb09 = defineCheck({
  id: "BB09",
  claimKey: "bidding.modifier_contradicts_data",
  title: "Bid adjustment contradicts the slice it targets",
  clientLabel: "bid adjustments that work against the results",
  notCheckableCategory: "our_gap",
  group: "budget_bidding",
  metrics: ["SL.modifier_vs_slice(scope, criterion)", "SL.bid_modifier(scope, criterion)"],
  confounders: ["SL05", "SL06", "SL03", "SL08"],
  requires: ["campaigns", "bidModifiers"],
  impactFormula: "IMP_CPA_GAP",
  noneFoundMeans: "Bid adjustments match how each slice performs.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "bidModifiers"]);
    if (gate) return gate;
    const attached = campaigns(ctx).flatMap((c) => c.children.bidModifiers);
    const marker = ctx.metrics.markers.get("bidModifiers");
    if (attached.length === 0) {
      return {
        state: "not_checkable",
        reason: `${marker?.rowsSeen ?? 0} bid_modifier rows exist but none join a campaign of this audit (population rule)`,
        table: "bid_modifiers",
      };
    }
    const sliceRows = attached.filter(
      (m) => !(m.attrs.measuredSlice.kind === "unresolved" && m.attrs.measuredSlice.noSlice),
    );
    const unresolved = sliceRows.filter((m) => m.attrs.measuredSlice.kind === "unresolved");
    // call-bid modifiers only: there is no traffic slice to judge, so nothing was
    // checked — never none_found (that prints a "bid adjustments match" positive)
    if (sliceRows.length === 0) {
      return {
        state: "not_checkable",
        reason: `all ${attached.length} bid modifier row(s) adjust call bids, not a traffic slice — no slice adjustment to compare`,
        table: "bid_modifiers",
        category: "not_present",
      };
    }
    if (unresolved.length === sliceRows.length) {
      return {
        state: "not_checkable",
        reason: `all ${sliceRows.length} joined bid_modifier rows (of ${marker?.rowsSeen ?? attached.length} synced) carry no modifier_source / criterion_key, so the slice each modifier multiplies cannot be resolved (rows synced before the 5B fields)`,
        table: "bid_modifiers",
      };
    }

    const { modifierMinStep: BB09_MIN_STEP, modifierGapMultiple: BB09_GAP_MULTIPLE } =
      ctx.settings.bidding;
    const findings: CheckFinding[] = [];
    let evaluated = 0;
    let smartBidding = 0;
    let neutral = 0;
    let belowFloor = 0;
    const unjudged: string[] = [];
    const unjudgedKinds = new Set<string>();
    for (const c of campaigns(ctx)) {
      for (const m of c.children.bidModifiers) {
        const ms = m.attrs.measuredSlice;
        if (ms.kind === "unresolved") continue;
        const mod = m.attrs.modifier;
        if (mod == null || mod <= 0 || Math.abs(mod - 1) < BB09_MIN_STEP) {
          neutral += 1;
          continue;
        }
        if (!MANUAL_CPC_STRATEGIES.has(String(c.attrs.strategy ?? ""))) {
          smartBidding += 1;
          continue;
        }
        const args = { scope: "campaign" as const, campaignId: c.id, key: ms.key, type: ms.kind };
        const v = ctx.get("SL.modifier_vs_slice(scope, criterion)", args);
        if (!isOk(v)) {
          // thin or no traffic on a slice whose table WAS read is "below the floor"; a slice
          // whose performance table was not read (or not in full) was not judged at all
          if (sliceTableRead(ctx, ms.kind)) belowFloor += 1;
          else {
            unjudged.push(ms.kind === "dowHour" ? `schedule ${ms.key}` : `${ms.kind} ${ms.key}`);
            unjudgedKinds.add(KIND_WORD[ms.kind] ?? ms.kind);
          }
          continue;
        }
        const x = (v as { value: Record<string, number | null> }).value;
        const campRoas = x.campaign_roas;
        const campCpa = x.campaign_cpa;
        const useRoas = campRoas != null && campRoas > 0;
        if (!useRoas && (campCpa == null || campCpa <= 0)) {
          belowFloor += 1;
          continue;
        }
        evaluated += 1;
        // a slice with no sale is "worse" only once it spent a full campaign CPA
        // (both branches): 35 clicks / $35 / 0 sales is noise, not ROAS 0
        const noSale = (x.conv ?? 0) === 0;
        const spentACpa = campCpa != null && campCpa > 0 && (x.cost ?? 0) >= campCpa;
        const worse = noSale
          ? spentACpa
          : useRoas
            ? (x.roas ?? 0) * BB09_GAP_MULTIPLE <= campRoas!
            : (x.cpa ?? 0) >= campCpa! * BB09_GAP_MULTIPLE;
        const better = useRoas
          ? (x.roas ?? 0) >= campRoas! * BB09_GAP_MULTIPLE
          : x.cpa != null && x.cpa * BB09_GAP_MULTIPLE <= campCpa!;
        const up = mod >= 1 + BB09_MIN_STEP;
        if (!((up && worse) || (!up && better))) continue;
        const label = ms.kind === "dowHour" ? `schedule ${ms.key}` : `${ms.kind} ${ms.key}`;
        const scopeType: CheckScope["type"] =
          ms.kind === "dowHour" ? "hour" : ms.kind === "dow" ? "hour" : ms.kind;
        findings.push(
          finding({
            claimKey: this.claimKey,
            scope: {
              type: scopeType,
              id: ms.key,
              name: ms.key,
              campaignId: c.id,
              campaignName: c.name,
            },
            cite: [v, ctx.get("SL.bid_modifier(scope, criterion)", args)],
            entity: { id: m.id, name: label },
            facts: {
              modifier: mod,
              direction: up ? "raised" : "lowered",
              slice_cost: x.cost ?? null,
              slice_conv: x.conv ?? null,
              slice_roas: x.roas ?? null,
              campaign_roas: campRoas ?? null,
              slice_cpa: x.cpa ?? null,
              campaign_cpa: campCpa ?? null,
              compared_on: useRoas ? "roas" : "cpa",
            },
            population: sliceRows.length,
            note: `${c.name}: bid ${up ? "raised" : "lowered"} ${Math.round((mod - 1) * 100)}% on ${label}, which ${up ? "returns less" : "returns more"} than the campaign (${useRoas ? "ROAS" : "CPA"}, 90 days)`,
          }),
        );
      }
    }
    const skipped = `${smartBidding} on Smart Bidding (adjustments ignored), ${neutral} neutral or -100%, ${belowFloor} under the slice click floor or without comparable data, ${unresolved.length} unresolved`;
    const notJudged =
      unjudged.length > 0
        ? `${[...unjudgedKinds].sort().join(" and ")} adjustments could not be judged (their performance was not read): ${unjudged.slice(0, 10).join(", ")}${unjudged.length > 10 ? `, +${unjudged.length - 10} more` : ""}`
        : null;
    if (findings.length > 0)
      return {
        state: "fires",
        findings: notJudged
          ? findings.map((f) => ({ ...f, limitedBy: [...(f.limitedBy ?? []), notJudged] }))
          : findings,
      };
    // an adjustment nobody could measure leaves "they all match" unproven
    if (notJudged)
      return {
        state: "not_checkable",
        reason: notJudged,
        table: "bid_modifiers",
        category: "incomplete_data",
      };
    if (evaluated === 0) {
      // under the click floor = thin data; otherwise nothing applies: Smart Bidding
      // ignores the adjustments (not_applicable), or none is a real push (not_present)
      if (belowFloor > 0)
        return {
          state: "insufficient_data",
          reason: `no bid modifier could be compared against its slice: ${skipped}`,
        };
      if (smartBidding > 0)
        return {
          state: "not_checkable",
          reason: `every slice adjustment sits on a Smart Bidding campaign, which ignores it: ${skipped}`,
          table: "bid_modifiers",
          category: "not_applicable",
        };
      return {
        state: "not_checkable",
        reason: `no slice adjustment moves a bid by ${BB09_MIN_STEP * 100}% or more: ${skipped}`,
        table: "bid_modifiers",
        category: "not_present",
      };
    }
    return {
      state: "none_found",
      population: evaluated,
      note: `${evaluated} modifier(s) compared against their slice, none works against it; ${skipped}`,
    };
  },
});

/** The table a modifier's slice is measured on (model/buildSlices.ts tableOf). */
const SLICE_TABLE: Readonly<Record<string, string>> = {
  device: "deviceData",
  geo: "geographicData",
  dowHour: "temporal_grid",
  audience: "campaignAudiencePerf",
};

/** The adjustment kinds in plain words, for BB09's "could not be judged". */
const KIND_WORD: Readonly<Record<string, string>> = {
  device: "device",
  geo: "location",
  dowHour: "ad schedule",
  audience: "audience",
};

/** True when the slice's performance table was read in full (ok, not partial). */
function sliceTableRead(ctx: CheckCtx, kind: string): boolean {
  const table = SLICE_TABLE[kind];
  if (!table) return false;
  const m = ctx.metrics.markers.get(table);
  return m != null && m.status === "ok" && !m.partial;
}

/** BB10 — target simulations exist. Context for BB05, never a finding on its own. */
export const bb10 = defineCheck({
  id: "BB10",
  claimKey: "bidding.simulation_available",
  title: "Target simulation available for this campaign",
  group: "budget_bidding",
  metrics: ["C.simulation_points"],
  confounders: [],
  requires: ["campaigns", "simulations"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No target simulations available.",
  // plan 1.6: context for BB05, $0 — a line under the campaign, not a card
  noteOnly: "Google offers a target simulation for this campaign",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "simulations"]);
    if (gate) return gate;
    const findings: CheckFinding[] = [];
    const population = campaigns(ctx).length;
    for (const c of campaigns(ctx)) {
      const points = ctx.get("C.simulation_points", { campaignId: c.id });
      const n = num(points);
      if (n == null || n <= 0) continue;
      findings.push(
        finding({
          claimKey: "bidding.simulation_available",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [points],
          facts: { simulation_points: n, simulation_types: c.attrs.simulationTypes.join(",") },
          population,
          note: "context for BB05 — never a finding on its own",
        }),
      );
    }
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

/** BB11 — seasonality / data-exclusion override active in the window.
 *  Gated entirely by rule 4: `bidding_overrides` has no sync marker
 *  and no legacy count column, so zero rows cannot be told from never synced. */
export const bb11 = defineCheck({
  id: "BB11",
  claimKey: "bidding.seasonality_override_active",
  title: "Seasonality adjustment active in the window",
  group: "budget_bidding",
  metrics: ["C.seasonality_adjustments"],
  confounders: ["TR01", "TR03"],
  requires: ["campaigns", "biddingOverrides"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No seasonality adjustments in the window.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "biddingOverrides"]);
    if (gate) return gate;
    const findings: CheckFinding[] = [];
    const population = campaigns(ctx).length;
    for (const c of campaigns(ctx)) {
      const n = ctx.get("C.seasonality_adjustments", { campaignId: c.id });
      const v = num(n);
      if (v == null || v <= 0) continue;
      findings.push(
        finding({
          claimKey: "bidding.seasonality_override_active",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [n],
          facts: { seasonality_adjustments: v },
        }),
      );
    }
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

/** Strategies that bid on the NUMBER of conversions, never on what they are worth. */
const COUNT_BIDDING_STRATEGIES: ReadonlySet<string> = new Set([
  "MAXIMIZE_CONVERSIONS",
  "TARGET_CPA",
]);
/** Strategies that already bid on conversion value (Maximize conversion value with or without a tROAS, Target ROAS). */
const VALUE_BIDDING_STRATEGIES: ReadonlySet<string> = new Set([
  "MAXIMIZE_CONVERSION_VALUE",
  "TARGET_ROAS",
]);

/**
 * BB14: the strategy a campaign really bids with. A portfolio campaign bids with
 * its portfolio's type (when synced); `valueBidding` is true when ANY source says
 * the campaign already bids on value (either type is a value strategy, or a tROAS
 * is set on the campaign or its portfolio), so a stale or partial read never
 * turns a value-bidding campaign into a finding.
 */
function effectiveBidding(
  c: CampaignNode,
  campaignType: string,
): { strategy: string; valueBidding: boolean } {
  const onPortfolio =
    c.attrs.biddingStrategySource === "portfolio" || c.attrs.portfolioStrategyId != null;
  const portfolioType = onPortfolio
    ? ((c.attrs.portfolioStrategyType ?? null)?.toUpperCase() ?? null)
    : null;
  const own = campaignType.toUpperCase();
  const strategy = portfolioType ?? own;
  const roas = [c.attrs.targetRoas, onPortfolio ? (c.attrs.portfolioTargetRoas ?? null) : null];
  const valueBidding =
    VALUE_BIDDING_STRATEGIES.has(own) ||
    (portfolioType != null && VALUE_BIDDING_STRATEGIES.has(portfolioType)) ||
    roas.some((r) => r != null && r > 0);
  return { strategy, valueBidding };
}

/**
 * BB14 (plan 5.2, Gate 1 row 4) — a campaign bids on conversion COUNT while its
 * conversions carry order value.
 *
 * The campaign's `conversions_value` is Google's own figure for the actions in
 * its Conversions column — the primary (biddable) actions this campaign bids
 * toward — so a value above zero there means the tag already records what each
 * order is worth and the bidding ignores it. The volume floor is `C.roas`'s own
 * (`FLOORS.roasCpaConv`): below it a return figure is not stable enough to hand
 * a value-based strategy. States what is set and what is recorded; it does not
 * price the switch.
 *
 * Google refuses a switch to value bidding (Maximize conversion value, with or
 * without a target ROAS) on a campaign with too few recent conversions
 * (validate-only: biddingError NOT_ENOUGH_CONVERSIONS); its guidance runs from
 * about 15 (Search / Shopping) to 30-50 (Demand Gen) in 30 days. So the
 * campaign's OWN last-30-day conversions must reach
 * `settings.bidding.targetRoasMinConv30d` (the same minimum the update_bidding
 * change refuses the switch under: @perfoads/changes VALUE_BIDDING_MIN_CONV_30D).
 * Under it: a Note-level finding of its own (maxSeverity info, fact
 * `below_value_minimum: "yes"`) that says to keep the current bidding until the
 * campaign has about that many conversions in 30 days. It carries no money and
 * no change is offered for it. Never a none_found: a campaign held back is not a
 * clean result, so it never reads as Good news. A campaign with no 30-day series
 * is not known: when nothing else fires, the check is not_checkable.
 */
export const bb14 = defineCheck({
  id: "BB14",
  claimKey: "bidding.count_while_value_tracked",
  title: "Bids on conversion count while order value is tracked",
  clientLabel: "campaigns bidding on the number of sales while the value of each sale is recorded",
  group: "budget_bidding",
  metrics: ["C.strategy", "C.conv", "C.value", "C.roas", "C.window(w)"],
  confounders: ["MI01", "MI04", "MI07"],
  requires: ["campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No campaign with recorded order value bids on conversion count alone.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns"]);
    if (gate) return gate;
    const findings: CheckFinding[] = [];
    let population = 0;
    let noValueColumn = 0;
    const minConv30 = ctx.settings.bidding.targetRoasMinConv30d;
    let no30 = 0;
    for (const c of campaigns(ctx)) {
      const strategy = ctx.get("C.strategy", { campaignId: c.id });
      const s = str(strategy);
      if (s == null) continue;
      population++;
      // never fire on a campaign that already bids on value
      const bidding = effectiveBidding(c, s);
      if (bidding.valueBidding || !COUNT_BIDDING_STRATEGIES.has(bidding.strategy)) continue;
      const value = ctx.get("C.value", { campaignId: c.id });
      const v = num(value);
      if (v == null) {
        noValueColumn++;
        continue;
      }
      if (v <= 0) continue;
      // C.roas carries the conversion floor; under it the value is too thin to bid on
      const roas = ctx.get("C.roas", { campaignId: c.id });
      if (!isOk(roas)) continue;
      // under Google's value-bidding minimum (recent conversions) the switch is refused;
      // no 30-day series = not known
      const w30 = ctx.get("C.window(w)", { campaignId: c.id, window: "30d" });
      const conv30 = windowField(w30, "conv");
      if (conv30 == null) {
        no30++;
        continue;
      }
      const below = conv30 < minConv30;
      const conv = ctx.get("C.conv", { campaignId: c.id });
      // one-click gaps phase 1: portfolio = yes / no / unknown (not synced). The
      // bid-on-value change is built only from `no`: an inline strategy on a
      // portfolio campaign would detach it from its siblings' shared strategy.
      const portfolio =
        c.attrs.biddingStrategySource === "portfolio" || c.attrs.portfolioStrategyId != null
          ? "yes"
          : c.attrs.biddingStrategySource === "standard"
            ? "no"
            : "unknown";
      const f = finding({
        claimKey: "bidding.count_while_value_tracked",
        scope: scopeOf(c),
        entity: { id: c.id, name: c.name },
        cite: [strategy, value, conv, roas, w30],
        facts: {
          strategy: bidding.strategy,
          conv_value_90d: v,
          conversions_90d: num(conv),
          conversions_30d: conv30,
          roas_90d: num(roas),
          status: c.status ?? null,
          ...(below ? { below_value_minimum: "yes", value_bidding_min_30d: minConv30 } : {}),
        },
        rows: [
          {
            entity: { id: c.id, name: c.name },
            cells: {
              strategy: bidding.strategy,
              value_tracked: "yes",
              portfolio,
              conv_30d: conv30,
            },
          },
        ],
        note: below
          ? `under Google's value-bidding minimum (about ${minConv30} conversions in 30 days, this campaign has ${Math.round(conv30 * 10) / 10}): keep the current bidding until it has enough sales; no change is offered`
          : "conversions_value counts only the actions in this campaign's Conversions column (the ones it bids toward), so the value is on the actions the bidding reads",
      });
      // under the minimum: a Note only (no money, no change), never a none_found, never a warning
      findings.push(below ? { ...f, maxSeverity: "info" } : f);
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no campaign carries a bidding_strategy_type",
        table: "campaigns",
      };
    if (findings.length > 0)
      return { state: "fires", findings: withPopulation(findings, population) };
    // a campaign we could not judge (no 30-day series) is not a clean result
    if (no30 > 0)
      return {
        state: "not_checkable",
        reason: `no 30-day conversion series for ${no30} count-bidding campaign(s) with recorded order value, so Google's value-bidding minimum could not be checked`,
        table: "campaign_daily_metrics",
      };
    return {
      state: "none_found",
      population,
      note:
        noValueColumn > 0
          ? `${noValueColumn} count-bidding campaign(s) have no conversions_value column`
          : undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// Brand CPC (BB15) and loose targets on budget-limited campaigns (BB16)
// ---------------------------------------------------------------------------

const CLICK_PRICED_TYPES = new Set(["SEARCH", "SHOPPING", "PERFORMANCE_MAX"]);
/** Strategies where the advertiser sets the click price (Maximize clicks = TARGET_SPEND, which may carry a CPC cap). */
const MANUAL_CPC_STRATEGIES = new Set(["MANUAL_CPC", "ENHANCED_CPC", "TARGET_SPEND"]);

/**
 * BB15 — brand clicks cost far more than they should.
 *
 * A live brand Search or Shopping campaign whose average CPC sits above the
 * brand bar. Brand searches come from people already looking for the business,
 * so their clicks should cost a fraction of the account's other clicks. The bar
 * is RELATIVE so it fits any currency and market: the larger of a small floor
 * (settings.bidding.brandCpcFloorUsd, currency-scaled) and a share of the
 * account's own non-brand CPC (Search, Shopping and Performance Max clicks, 90
 * days). When brand terms are known and the campaign's own brand searches carry
 * enough clicks, their CPC is judged (a brand campaign that also buys generic
 * searches would otherwise look expensive for the wrong reason); else the
 * campaign's CPC. The spend above the bar is money at risk a month (Phase F,
 * B19: `at_risk_cost_90d` / 3), never waste: the bar is a rule of thumb, not a
 * quote. A small monthly amount above it is a line in the check's note, never a
 * finding.
 */
export const bb15 = defineCheck({
  id: "BB15",
  claimKey: "bidding.brand_cpc_high",
  title: "clicks on your own brand name cost more than they usually should",
  clientLabel: "what you pay for a click on your own brand name",
  group: "budget_bidding",
  metrics: ["C.spend", "C.strategy", "A.spend"],
  confounders: [],
  requires: ["campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No brand campaign overpays for clicks on your own name by a meaningful amount.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns"]);
    if (gate) return gate;
    const money = currencyGate(ctx);
    if (money) return money;
    const live = campaigns(ctx).filter((c) => c.status === "ENABLED");
    const nb = live.filter((c) => !c.attrs.isBrand && CLICK_PRICED_TYPES.has(c.attrs.type));
    const nbCost = nb.reduce((t, c) => t + (c.windows.m90.cost ?? 0), 0);
    const nbClicks = nb.reduce((t, c) => t + (c.windows.m90.clicks ?? 0), 0);
    const brand = live.filter(
      (c) => c.attrs.isBrand && (c.attrs.type === "SEARCH" || c.attrs.type === "SHOPPING"),
    );
    if (brand.length === 0)
      return {
        state: "not_checkable",
        reason: "no live brand Search or Shopping campaign on this account",
        category: "not_present",
      };
    const {
      brandCpcFloorUsd: BRAND_CPC_FLOOR_USD,
      brandCpcShareOfNonBrand: BRAND_CPC_SHARE_OF_NON_BRAND,
      brandCpcMinClicks: BRAND_CPC_MIN_CLICKS,
      nonBrandCpcMinClicks: NON_BRAND_CPC_MIN_CLICKS,
      brandCpcNoteBelowMonthlyUsd: BRAND_CPC_NOTE_BELOW_MONTHLY_USD,
    } = ctx.settings.bidding;
    if (nbClicks < NON_BRAND_CPC_MIN_CLICKS || nbCost <= 0)
      return {
        state: "insufficient_data",
        reason: `non-brand Search / Shopping / Performance Max clicks ${nbClicks} under the ${NON_BRAND_CPC_MIN_CLICKS}-click floor for a reference CPC`,
      };
    const nonBrandCpc = nbCost / nbClicks;
    const bar = Math.max(
      scaleMoney(BRAND_CPC_FLOOR_USD, ctx.currency),
      BRAND_CPC_SHARE_OF_NON_BRAND * nonBrandCpc,
    );
    const noteBelow = scaleMoney(BRAND_CPC_NOTE_BELOW_MONTHLY_USD, ctx.currency);
    const isBrandTerm = brandMatcherOfModel(ctx.model);

    const findings: CheckFinding[] = [];
    const judged: string[] = [];
    let population = 0;
    for (const c of brand) {
      // negatives framework P3: brand Search / Shopping terms only, never PMax rows (PX02 reads those)
      const terms = [
        ...c.children.searchTerms,
        ...c.children.adGroups.flatMap((g) => g.children.searchTerms),
      ].filter((t) => t.attrs.source !== "pmaxSearchTerms");
      const brandTerms = isBrandTerm ? terms.filter((t) => isBrandTerm(t.attrs.term)) : [];
      const btClicks = brandTerms.reduce((t, x) => t + (x.windows.m90.clicks ?? 0), 0);
      const btCost = brandTerms.reduce((t, x) => t + (x.windows.m90.cost ?? 0), 0);
      const useTerms = btClicks >= BRAND_CPC_MIN_CLICKS && btCost > 0;
      // review fix: with a name and search-term rows, the campaign CPC would mix in generic searches
      // (SK07's subject) — too few brand clicks means skip, never fall back
      if (!useTerms && isBrandTerm && terms.length > 0) {
        judged.push(
          `${c.name} not judged (${btClicks} brand-search clicks, under ${BRAND_CPC_MIN_CLICKS})`,
        );
        continue;
      }
      const clicks = useTerms ? btClicks : (c.windows.m90.clicks ?? 0);
      const cost = useTerms ? btCost : (c.windows.m90.cost ?? 0);
      if (clicks < BRAND_CPC_MIN_CLICKS || cost <= 0) continue;
      population++;
      const cpc = cost / clicks;
      judged.push(`${c.name} ${cpc.toFixed(2)}`);
      if (cpc <= bar) continue;
      const above90 = (cpc - bar) * clicks;
      const broad = c.children.adGroups
        .flatMap((g) => g.children.keywords)
        .filter(
          (k) =>
            !k.attrs.isNegative &&
            String(k.attrs.matchType ?? "").toUpperCase() === "BROAD" &&
            (k.windows.m90.cost ?? 0) > 0,
        ).length;
      if (above90 / 3 < noteBelow) {
        judged[judged.length - 1] +=
          ` (above the usual brand click price by ${(above90 / 3).toFixed(2)} a month, under the ${noteBelow.toFixed(2)} bar for a finding)`;
        continue;
      }
      const strategy = ctx.get("C.strategy", { campaignId: c.id });
      const spend = ctx.get("C.spend", { campaignId: c.id });
      findings.push({
        ...finding({
          claimKey: "bidding.brand_cpc_high",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [spend, strategy],
          facts: {
            brand_cpc: Number(cpc.toFixed(2)),
            brand_clicks_90d: clicks,
            cpc_measured_on: useTerms ? "brand searches in this campaign" : "the whole campaign",
            non_brand_cpc: Number(nonBrandCpc.toFixed(2)),
            brand_cpc_bar: Number(bar.toFixed(2)),
            spend_above_bar_90d: Number(above90.toFixed(2)),
            // B19: the same spend, priced as money at risk (IMP_STRUCTURAL)
            at_risk_cost_90d: Number(above90.toFixed(2)),
            strategy: str(strategy),
            strategy_sets_cpc: MANUAL_CPC_STRATEGIES.has(String(c.attrs.strategy ?? "")),
            target_roas: c.attrs.targetRoas,
            target_cpa: c.attrs.targetCpa,
            broad_brand_keywords: broad,
          },
          note: `the usual brand click price = the larger of ${scaleMoney(BRAND_CPC_FLOOR_USD, ctx.currency).toFixed(2)} and ${BRAND_CPC_SHARE_OF_NON_BRAND * 100}% of the non-brand CPC; a rule of thumb, so the spend above it is money at risk, not waste`,
        }),
        // a rule-of-thumb bar: its money can rank the finding, never make it critical
        maxSeverity: "warning",
      });
    }
    if (population === 0)
      return {
        state: "insufficient_data",
        reason: `no live brand campaign reaches ${BRAND_CPC_MIN_CLICKS} clicks in the window`,
      };
    return findings.length > 0
      ? { state: "fires", findings: withPopulation(findings, population) }
      : {
          state: "none_found",
          population,
          note: `brand CPC per campaign: ${judged.join(", ")}; usual brand click price ${bar.toFixed(2)} (non-brand CPC ${nonBrandCpc.toFixed(2)})`,
        };
  },
});

/** The first day of the last `days` days of the window (inclusive of its end), or null. */
function lookbackStart(end: string | null, days: number): string | null {
  if (!end) return null;
  return new Date(Date.parse(`${end}T00:00:00Z`) - Math.max(0, days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * When the change history the caller read starts after `since`, "no recent change" cannot be
 * told from "the change happened before the history starts": the check must not judge.
 */
function changeCoverageGap(ctx: CheckCtx, since: string | null, days: number): CheckResult | null {
  const cov = ctx.changeHistoryCoverage;
  if (!cov || !since || since >= cov.startDate) return null;
  const covered =
    Math.round(
      (Date.parse(`${ctx.model.window.end ?? cov.endDate}T00:00:00Z`) -
        Date.parse(`${cov.startDate}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  return {
    state: "not_checkable",
    reason: `change history covers only ${covered} days of the window (from ${cov.startDate}), but this check looks back ${days} days for a target or strategy change`,
    table: "change_history",
    category: "incomplete_data",
  };
}

/** BB16: did the change history record a target ROAS / CPA or bidding-strategy change on this campaign recently? */
function targetChangedRecently(ctx: CheckCtx, campaignId: string): boolean {
  const since = lookbackStart(ctx.model.window.end, ctx.settings.bidding.recentTargetChangeDays);
  if (!since) return false;
  return (ctx.model.attrs.changeHistory.material ?? []).some(
    (m) =>
      m.campaignId === campaignId &&
      // the campaign's own target or strategy (CAMPAIGN row), not an ad group's own target
      m.resourceType.toUpperCase() === "CAMPAIGN" &&
      m.date >= since &&
      m.materialFields.some(
        (f) => f === "target ROAS" || f === "target CPA" || f === "bidding strategy",
      ),
  );
}

/**
 * BB16 — a budget-limited campaign on a loose target.
 *
 * tROAS / tCPA campaign, losing impression share to budget (or spending its
 * whole budget where Google reports no share), whose last-30-day return beats
 * its target by a clear margin (or cost per conversion clearly under it). When
 * the budget is the limit, a target looser than the real results leaves the
 * bidding room to spend toward the target instead of beating it. BB07
 * (profitable and budget-starved) says "add budget"; BB05 is the opposite case
 * (target too tight). No dollar figure: what the drift costs depends on the
 * auction.
 */
export const bb16 = defineCheck({
  id: "BB16",
  claimKey: "bidding.target_loose_while_budget_limited",
  title: "budget-limited campaign on a target looser than its results",
  clientLabel: "budget-limited campaigns whose bid target is looser than what they achieve",
  group: "budget_bidding",
  metrics: [
    "C.target_roas",
    "C.target_cpa",
    "C.window(w)",
    "C.lost_is_budget_recent_pct",
    "C.lost_is_budget_pct",
    "C.budget_util90",
  ],
  confounders: ["MI01", "BB04"],
  requires: ["campaigns", "campaignDailyMetrics", "changeHistory"],
  // a recent target change missing from the history would cancel the finding
  needsCompleteData: ["changeHistory"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No budget-limited campaign runs on a target looser than its results.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "campaignDailyMetrics", "changeHistory"]);
    if (gate) return gate;
    const {
      looseTargetFromDate,
      looseTargetMargin: LOOSE_TARGET_MARGIN,
      budgetLimitedLostIsPct,
      budgetLimitedUtil,
      looseTargetMinConv30d,
      recentTargetChangeDays,
    } = ctx.settings.bidding;
    const end = ctx.model.window.end;
    const coverageGap = changeCoverageGap(
      ctx,
      lookbackStart(end, recentTargetChangeDays),
      recentTargetChangeDays,
    );
    if (coverageGap) return coverageGap;
    if (looseTargetFromDate !== "" && end != null && end < looseTargetFromDate) {
      return {
        state: "not_checkable",
        reason: `the audit window ends ${end}, before ${looseTargetFromDate} (settings.bidding.looseTargetFromDate)`,
        category: "not_applicable",
      };
    }
    const findings: CheckFinding[] = [];
    const recentChange: string[] = [];
    const sharedHeld: string[] = [];
    let population = 0;
    let candidates = 0;
    for (const c of campaigns(ctx)) {
      const tRoasV = ctx.get("C.target_roas", { campaignId: c.id });
      const tCpaV = ctx.get("C.target_cpa", { campaignId: c.id });
      const tRoas = num(tRoasV);
      const tCpa = num(tCpaV);
      if ((tRoas == null || tRoas <= 0) && (tCpa == null || tCpa <= 0)) continue;
      population++;
      // the last 3 weeks, as BB02 (90 days only when they were not read); no activity in
      // them = not budget-limited now
      const now = lostIsBudgetNow(ctx, c.id);
      const lostV = now.metric;
      const utilV = ctx.get("C.budget_util90", { campaignId: c.id });
      const lost = now.value;
      const util = num(utilV);
      const limited = now.idle
        ? false
        : lost != null
          ? lost >= budgetLimitedLostIsPct
          : util != null && util >= budgetLimitedUtil;
      if (!limited) continue;
      const w30 = ctx.get("C.window(w)", { campaignId: c.id, window: "30d" });
      const conv30 = windowField(w30, "conv");
      if (conv30 == null || conv30 < looseTargetMinConv30d) continue;
      const roas30 = windowField(w30, "roas");
      const cpa30 = windowField(w30, "cpa");
      const loose =
        tRoas != null && tRoas > 0
          ? roas30 != null && roas30 >= tRoas * LOOSE_TARGET_MARGIN
          : cpa30 != null && tCpa != null && cpa30 > 0 && cpa30 * LOOSE_TARGET_MARGIN <= tCpa;
      if (!loose) {
        candidates++;
        continue;
      }
      candidates++;
      // a target changed inside the recent window is not yet reflected in the 30-day results
      if (targetChangedRecently(ctx, c.id)) {
        recentChange.push(c.name);
        continue;
      }
      // a shared (portfolio) strategy's target changes are not in Google's change history:
      // a recent change cannot be ruled out, so the campaign is held back, never called loose
      if (c.attrs.portfolioStrategyId != null) {
        sharedHeld.push(c.name);
        continue;
      }
      findings.push(
        finding({
          claimKey: "bidding.target_loose_while_budget_limited",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [tRoas != null ? tRoasV : tCpaV, w30, lost != null ? lostV : utilV],
          facts: {
            ...(tRoas != null && tRoas > 0
              ? { target_roas: tRoas, roas_30d: roas30 }
              : { target_cpa: tCpa, cpa_30d: cpa30 }),
            conv_30d: conv30,
            ...(lost != null ? { lost_is_budget_pct: lost } : { util90: util }),
          },
          note: `budget-limited ${lost != null ? `(${lost.toFixed(1)}% impression share lost to budget)` : `(${((util ?? 0) * 100).toFixed(0)}% of budget used; no impression-share row)`}; results beat the target by ${Math.round((LOOSE_TARGET_MARGIN - 1) * 100)}%+`,
        }),
      );
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no campaign carries a target ROAS or target CPA",
        category: "not_present",
      };
    const sharedText =
      sharedHeld.length > 0
        ? `${sharedHeld.length} budget-limited campaign(s) beat a target that sits on a shared (portfolio) strategy, whose target changes Google's change history does not record, so a recent change cannot be ruled out and they were not judged: ${sharedHeld.slice(0, 10).join(", ")}`
        : null;
    if (findings.length > 0) {
      const judged = withPopulation(findings, population);
      return {
        state: "fires",
        findings: sharedText
          ? judged.map((f) => ({ ...f, limitedBy: [...(f.limitedBy ?? []), sharedText] }))
          : judged,
      };
    }
    // a held-back shared-strategy campaign leaves "no loose target" unproven: never clean
    if (sharedText)
      return {
        state: "not_checkable",
        reason: sharedText,
        table: "change_history",
        category: "google_withholds",
      };
    // every campaign that met the bar had its target changed too recently to judge: nothing was judged clean
    if (recentChange.length > 0 && recentChange.length === candidates)
      return {
        state: "insufficient_data",
        reason: `the target changed in the last ${recentTargetChangeDays} days on every campaign it would apply to, so its 30-day results cannot be judged yet: ${recentChange.join(", ")}`,
      };
    return {
      state: "none_found",
      population,
      ...(recentChange.length > 0
        ? {
            note: `target changed in the last ${recentTargetChangeDays} days, not judged yet: ${recentChange.join(", ")}`,
          }
        : {}),
    };
  },
});

/** BB17: Smart Bidding strategies (they re-learn after a target or strategy change). */
const RELEARNING_STRATEGIES: ReadonlySet<string> = new Set([
  "MAXIMIZE_CONVERSIONS",
  "MAXIMIZE_CONVERSION_VALUE",
  "TARGET_CPA",
  "TARGET_ROAS",
]);
/** BB17: change-history paths that restart the learning: a target, or the strategy itself (tolerance tweaks do not). */
const RELEARN_FIELD =
  /targetRoas|targetCpa|target_roas|target_cpa|biddingStrategyType|bidding_strategy_type/i;

/**
 * BB17 (R4-D, Round 4 item 30) — a Smart Bidding campaign still re-learning
 * after its target or strategy changed.
 *
 * Google's own "Learning" / "Limited" bid-strategy status (campaign
 * primary_status) is not synced; "limited by budget" and "limited by rank" are
 * BB02 / BB03. What IS synced is the change history with before/after values
 * (Round 4 item 10), so a live Smart Bidding campaign whose target or strategy
 * changed inside the last 14 days of the window is, by Google's own rule, still
 * re-learning. A $0 context line under the campaign (never a card): its recent
 * results are not a fair read yet, and every other card about it should be read
 * with that in mind.
 */
const bb17 = defineCheck({
  id: "BB17",
  claimKey: "bidding.learning_or_limited",
  title: "Smart Bidding campaign re-learning after a recent target or strategy change",
  clientLabel: "campaigns whose bidding is still re-learning after a recent change",
  noteOnly:
    "the bid target or bid strategy changed recently, so the bidding is still re-learning and its recent results are not a fair read yet",
  group: "budget_bidding",
  metrics: ["A.change_count", "C.strategy"],
  confounders: [],
  requires: ["changeHistory", "campaigns"],
  impactFormula: "IMP_NONE",
  noneFoundMeans:
    "No Smart Bidding campaign had its target or strategy changed inside the re-learning window.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["changeHistory", "campaigns"]);
    if (gate) return gate;
    const RELEARN_DAYS = ctx.settings.bidding.relearnDays;
    const end = ctx.window.end;
    if (!end) return { state: "insufficient_data", reason: "the audit window has no end day" };
    // CAMPAIGN rows only: an ad group's own target (AD_GROUP row) does not re-learn the campaign
    // the gate looks at every row with values; the re-learning logic keeps campaign rows only
    const anyValues = (ctx.model.attrs.changeHistory.material ?? []).filter(
      (m) => m.changedValues != null,
    );
    const material = anyValues.filter((m) => m.resourceType.toUpperCase() === "CAMPAIGN");
    if (anyValues.length === 0)
      return {
        state: "insufficient_data",
        reason:
          "change_history carries no old/new values, so a recent target or strategy change cannot be dated",
      };
    const smart = campaignsOf(ctx).filter((c) =>
      RELEARNING_STRATEGIES.has(String(c.attrs.strategy ?? "").toUpperCase()),
    );
    if (smart.length === 0)
      return { state: "none_found", population: 0, note: "no live campaign uses Smart Bidding" };
    const cutoff = lookbackStart(end, RELEARN_DAYS) ?? end;
    const coverageGap = changeCoverageGap(ctx, cutoff, RELEARN_DAYS);
    if (coverageGap) return coverageGap;
    const findings: CheckFinding[] = [];
    const shared: string[] = [];
    for (const c of smart) {
      const recent = material
        // a CREATE is a new campaign (the learning-age gate's business), not a change to a running one
        .filter(
          (m) =>
            m.campaignId === c.id &&
            m.date >= cutoff &&
            m.date <= end &&
            String(m.operation ?? "UPDATE").toUpperCase() !== "CREATE",
        )
        .map((m) => ({
          date: m.date,
          fields: Object.keys(m.changedValues ?? {}).filter(
            (k) => RELEARN_FIELD.test(k) && !/tolerance/i.test(k),
          ),
          // a switch can name only the new strategy (maximizeConversions): the model words it
          strategySwitch: m.materialFields.includes("bidding strategy"),
        }))
        .filter((m) => m.fields.length > 0 || m.strategySwitch)
        .sort((a, b) => cmpStr(a.date, b.date));
      if (recent.length === 0) {
        // a shared strategy's target lives on the strategy, whose changes Google's change
        // history does not record: "no change" cannot be told from "a change we cannot see"
        if (c.attrs.portfolioStrategyId != null) shared.push(c.name);
        continue;
      }
      const last = recent[recent.length - 1];
      if (!last) continue;
      const strategyChanged = recent.some(
        (m) => m.strategySwitch || m.fields.some((k) => /strategy/i.test(k)),
      );
      const daysSince = Math.round(
        (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${last.date}T00:00:00Z`).getTime()) /
          86_400_000,
      );
      findings.push(
        finding({
          claimKey: "bidding.learning_or_limited",
          scope: {
            type: "campaign",
            id: c.id,
            name: c.name,
            campaignId: c.id,
            campaignName: c.name,
          },
          entity: { id: c.id, name: c.name },
          cite: [ctx.get("C.strategy", { campaignId: c.id })].filter((v) => isOk(v)),
          facts: {
            last_change_day: last.date,
            days_since_change: daysSince,
            what_changed: strategyChanged ? "bid strategy" : "bid target",
            changes_in_relearn_window: recent.length,
            relearn_days: RELEARN_DAYS,
          },
          population: smart.length,
          note: `${recent.length} target/strategy change(s) in the last ${RELEARN_DAYS} days, the last on ${last.date}; Google's own learning / limited status is not synced`,
        }),
      );
    }
    const sharedText =
      shared.length > 0
        ? `${shared.length} campaign(s) bid with a shared (portfolio) strategy, whose target changes Google's change history does not record, so their re-learning cannot be judged: ${shared.slice(0, 10).join(", ")}`
        : null;
    if (findings.length > 0)
      return {
        state: "fires",
        findings: sharedText
          ? findings.map((f) => ({ ...f, limitedBy: [...(f.limitedBy ?? []), sharedText] }))
          : findings,
      };
    if (sharedText)
      return {
        state: "not_checkable",
        reason: sharedText,
        table: "change_history",
        category: "google_withholds",
      };
    return {
      state: "none_found",
      population: smart.length,
      note: `no target or strategy change on ${smart.length} Smart Bidding campaign(s) in the last ${RELEARN_DAYS} days of the window`,
    };
  },
});

export const BUDGET_BIDDING_CHECKS: CheckDefinition[] = [
  bb01,
  bb02,
  bb03,
  bb04,
  bb05,
  bb06,
  bb07,
  bb08,
  bb09,
  bb10,
  bb11,
  bb14,
  bb15,
  bb16,
  bb17,
];
