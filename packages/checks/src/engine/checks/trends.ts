// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Trends and change: TR01, TR01a, TR02-TR10.
 *
 * TR01 is campaign scope, TR01a account scope. An account decline must carry
 * the latest week beside it (a trend that recovered is not a decline) and the
 * fact that the recent 30 days are not settled yet.
 *
 * Every check is a pure read over the account model + the metric registry.
 */
import { EVIDENCE, eligibleCampaigns } from "../registry/index.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import { isReportable } from "../registry/entityStatus.js";
import type { MetricValue } from "../registry/types.js";
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import { FLOORS, scaleMoney } from "../registry/thresholds.js";
import { PRIOR_YEAR_DAILY_TABLE } from "../model/context.js";
import { SEASONAL_MOVE_PCT, seasonalityOf } from "../model/buildBuyersAndLanguages.js";
import {
  bool,
  defineCheck,
  finding,
  gateOnData,
  isOk,
  num,
  type CheckCtx,
  type CheckDefinition,
  type CheckFinding,
  type CheckResult,
  type CheckScope,
} from "./types.js";

/** A campaign needs this many days with activity before a decline is judged (two full weeks). */
const MIN_ACTIVE_DAYS = 14;

const scopeOf = (c: { id: string; name: string }): CheckScope => ({
  type: "campaign",
  id: c.id,
  name: c.name,
});
const accountScope = (ctx: CheckCtx): CheckScope => ({
  type: "account",
  id: ctx.model.id,
  name: ctx.model.name,
});

function windowField(
  v: MetricValue,
  field: "cost" | "conv" | "value" | "roas" | "cpa",
): number | null {
  if (!isOk(v) || v.value == null || typeof v.value !== "object" || Array.isArray(v.value))
    return null;
  const raw = (v.value as Record<string, unknown>)[field];
  return typeof raw === "number" ? raw : null;
}

function windowRows(v: MetricValue): number | null {
  return isOk(v) ? (v.source.rowCount ?? null) : null;
}

/** `W.last_settled_day` carries both tiers (strict / practical) in one payload. */
function settledDayOf(v: MetricValue, tier: "strict" | "practical"): string | null {
  if (!isOk(v)) return null;
  if (typeof v.value === "string") return tier === "strict" ? v.value : null;
  if (v.value && typeof v.value === "object" && !Array.isArray(v.value)) {
    const raw = (v.value as Record<string, unknown>)[tier];
    return typeof raw === "string" ? raw : null;
  }
  return null;
}

/** Percent change, null when the baseline is missing or zero. */
function changePct(now: number | null, before: number | null): number | null {
  if (now == null || before == null || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

// ---------------------------------------------------------------------------

/**
 * TR01 — a campaign in a real decline: return over the last 30 days against the
 * 30 before. When the last 7 days disagree with the 30-day direction the finding
 * still stands and says so (a noisier signal lowers confidence; it never deletes
 * the larger comparison).
 */
export const tr01 = defineCheck({
  id: "TR01",
  claimKey: "trend.performance_declining",
  title: "Campaign performance is declining",
  clientLabel: "campaigns whose return is falling",
  group: "trends",
  metrics: [
    "C.window(w)",
    "C.windows_agree",
    "C.active_days",
    "C.tracking_break_run_days",
    "F.days_min_for_window",
  ],
  confounders: [
    "MI01",
    "MI04",
    "MI05",
    "MI07",
    "MI08",
    "TR02",
    "TR03",
    "TR04",
    "SH08",
    "SK18",
    "AS06",
    "BB05",
  ],
  requires: ["campaigns", "campaignDailyMetrics"],
  /** A decline is priced by the value it stopped returning. */
  impactFormula: "IMP_VALUE_GAP",
  noneFoundMeans: "No campaign is in a real decline over the last 30 days.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "campaignDailyMetrics"]);
    if (gate) return gate;
    const minDays = num(ctx.get("F.days_min_for_window")) ?? 10;
    const { declinePct } = ctx.settings.trends;

    const findings: CheckFinding[] = [];
    let population = 0;
    const declinedButDisagreed: string[] = [];
    for (const c of eligibleCampaigns(ctx.model)) {
      const w30 = ctx.get("C.window(w)", { campaignId: c.id, window: "30d" });
      const p30 = ctx.get("C.window(w)", { campaignId: c.id, window: "prior30" });
      const daysNow = windowRows(w30) ?? 0;
      const daysBefore = windowRows(p30) ?? 0;
      if (daysNow < minDays || daysBefore < minDays) continue;
      const now = windowField(w30, "roas");
      const before = windowField(p30, "roas");
      const move = changePct(now, before);
      if (move == null) continue; // ROAS withheld below the conversion floor: no verdict
      population++;
      if (move > -declinePct) continue;

      const active = ctx.get("C.active_days", { campaignId: c.id });
      const days = num(active);
      if (days == null || days < MIN_ACTIVE_DAYS) continue;

      const agree = ctx.get("C.windows_agree", { campaignId: c.id });
      const windowsAgree = bool(agree) === true;
      if (!windowsAgree)
        declinedButDisagreed.push(`${c.name} (${move.toFixed(1)}% 30v30, 7v7 disagrees)`);

      const breakRun = ctx.get("C.tracking_break_run_days", { campaignId: c.id });
      // a conversion collapse while cost holds is a tracking question (MI01), not a decline
      if ((num(breakRun) ?? 0) > 0) continue;

      findings.push(
        finding({
          claimKey: "trend.performance_declining",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [w30, p30, agree, active, breakRun],
          facts: {
            roas_30d: now,
            roas_prior30: before,
            change_pct: move,
            active_days: days,
            // IMP_VALUE_GAP reads this name; the same number as roas_30d
            roas_recent30: now,
            spend_monthly: windowField(w30, "cost"),
            windows_agree: windowsAgree,
          },
          population,
          note: windowsAgree
            ? undefined
            : "the last 7 days do not agree with the 30-day direction — stated, not hidden",
        }),
      );
    }
    if (population === 0)
      return {
        state: "insufficient_data",
        reason: `no campaign has ≥ ${minDays} daily rows on both sides with a ROAS above the conversion floor`,
      };
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note:
            declinedButDisagreed.length > 0
              ? `30v30 declined but the 7v7 direction disagrees: ${declinedButDisagreed.join("; ")}`
              : `no campaign declined more than ${declinePct}% over 30v30`,
        };
  },
});

/**
 * TR01a — the ACCOUNT trend. Valid only with the latest week and the fact that
 * the recent 30 days are not settled; it names the campaign that moved the
 * account (each campaign's recent value against what the same spend returned
 * at its own earlier rate).
 */
export const tr01a = defineCheck({
  id: "TR01a",
  claimKey: "trend.account_performance_declining",
  title: "Account return is declining",
  clientLabel: "whether the account's return is falling",
  group: "trends",
  metrics: [
    "A.roas_window(w)",
    "W.last_settled_day",
    "A.value_rules_enabled_count",
    "A.spend_monthly",
  ],
  confounders: [
    "MI01",
    "MI04",
    "MI05",
    "MI07",
    "MI08",
    "TR02",
    "TR03",
    "TR04",
    "SH08",
    "SK18",
    "AS06",
    "BB05",
  ],
  requires: ["dailyMetrics", "campaignDailyMetrics"],
  impactFormula: "IMP_VALUE_GAP",
  noneFoundMeans: "The account's return is stable across the last two 30-day periods.",
  run(ctx) {
    const gate = gateOnData(ctx, ["dailyMetrics"]);
    if (gate) return gate;
    const minDays = num(ctx.get("F.days_min_for_window")) ?? 10;
    const { declinePct } = ctx.settings.trends;

    const recent = ctx.get("A.roas_window(w)", { window: "recent30" });
    const prior = ctx.get("A.roas_window(w)", { window: "prior30" });
    // the days come from the daily series itself: the ROAS metric carries no row
    // count when it is unknown (under its conversion floor), which read as "0 rows"
    const recentRows = ctx.model.windows.m30?.provenance.rowCount ?? 0;
    const priorRows = ctx.model.windows.mPrior30?.provenance.rowCount ?? 0;
    if (recentRows < minDays || priorRows < minDays) {
      return {
        state: "insufficient_data",
        reason: `the account has ${recentRows} days of data in the last 30 and ${priorRows} in the 30 before, below the ${minDays}-day minimum`,
      };
    }
    const unknownSide = !isOk(recent) ? recent : !isOk(prior) ? prior : null;
    if (unknownSide)
      return {
        state: "insufficient_data",
        reason: `the account's return cannot be compared across the two 30-day periods: ${unknownSide.detail}`,
      };
    const now = num(recent);
    const before = num(prior);
    const move = changePct(now, before);
    if (move == null)
      return {
        state: "insufficient_data",
        reason: "account ROAS is not computable on one side of the comparison (conversion floor)",
      };
    if (move > -declinePct)
      return {
        state: "none_found",
        population: recentRows + priorRows,
        note: `recent30 ${now?.toFixed(2)} vs prior30 ${before?.toFixed(2)} = ${move.toFixed(1)}%`,
      };

    // the recovery leg: without it the finding is not valid
    const latestWeek = ctx.get("A.roas_window(w)", { window: "last7" });
    const settledWeek = ctx.get("A.roas_window(w)", { window: "settled_week" });
    const settledToDate = ctx.get("A.roas_window(w)", { window: "settled_to_date" });
    const lastSettled = ctx.get("W.last_settled_day");
    const valueRules = ctx.get("A.value_rules_enabled_count");
    const monthly = ctx.get("A.spend_monthly");
    if (!isOk(latestWeek)) {
      return {
        state: "insufficient_data",
        reason:
          "the latest week is not computable, so the decline cannot be stated against the recovery it must carry",
      };
    }
    const recentSettled = isOk(recent) ? recent.maturity.settledStrict === true : false;

    const contributors: Array<{
      id: string;
      name: string;
      gap: number;
      roasNow: number;
      roasBefore: number;
      spendNow: number;
    }> = [];
    for (const c of eligibleCampaigns(ctx.model)) {
      const cw = ctx.get("C.window(w)", { campaignId: c.id, window: "30d" });
      const cp = ctx.get("C.window(w)", { campaignId: c.id, window: "prior30" });
      const rNow = windowField(cw, "roas");
      const rBefore = windowField(cp, "roas");
      const sNow = windowField(cw, "cost");
      if (rNow == null || rBefore == null || sNow == null || sNow <= 0) continue;
      contributors.push({
        id: c.id,
        name: c.name,
        // B18: in spend units, the same formula as IMP_VALUE_GAP (spend_now x
        // (1 - roas_now / roas_before)), so a big campaign's fall outranks a small one's
        gap: rBefore > 0 ? sNow * (1 - rNow / rBefore) : 0,
        roasNow: rNow,
        roasBefore: rBefore,
        spendNow: sNow,
      });
    }
    contributors.sort((a, b) => b.gap - a.gap || a.id.localeCompare(b.id));
    const worst = contributors[0];

    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "trend.account_performance_declining",
          scope: accountScope(ctx),
          cite: [
            recent,
            prior,
            latestWeek,
            settledWeek,
            settledToDate,
            lastSettled,
            valueRules,
            monthly,
          ],
          facts: {
            roas_recent30: now,
            roas_prior30: before,
            change_pct: move,
            latest_week_roas: num(latestWeek),
            latest_week_range: `${latestWeek.window?.start ?? "?"}..${latestWeek.window?.end ?? "?"}`,
            latest_week_settled: latestWeek.maturity.settledStrict === true,
            settled_week_roas: num(settledWeek),
            settled_to_date_roas: num(settledToDate),
            recent30_settled: recentSettled,
            last_settled_day_strict: settledDayOf(lastSettled, "strict"),
            last_settled_day_practical: settledDayOf(lastSettled, "practical"),
            value_rules_enabled: num(valueRules),
            spend_monthly: num(monthly),
            // the cause: null when no campaign has both sides above the conversion floor
            worst_campaign: worst?.name ?? null,
            worst_campaign_spend_gap: worst ? Math.round(worst.gap * 100) / 100 : null,
            worst_campaign_roas_recent30: worst?.roasNow ?? null,
            worst_campaign_roas_prior30: worst?.roasBefore ?? null,
            worst_campaign_spend_recent30: worst?.spendNow ?? null,
            declining_campaigns: contributors.filter((c) => c.gap > 0).length,
          },
          population: recentRows + priorRows,
          // every campaign, before and now: a campaign that improved shows the fall is not everyone's
          rows: contributors.map((c) => ({
            entity: { id: c.id, name: c.name },
            cells: {
              roas_prior30: c.roasBefore,
              roas_recent30: c.roasNow,
              spend_recent30: c.spendNow,
              spend_gap: Math.round(c.gap * 100) / 100,
            },
          })),
          note: "the recent 30 days are not settled yet; the latest week is stated beside the decline",
        }),
      ],
    };
  },
});

/** TR02 — the latest settled week: context beside any trend finding, never a finding of its own. */
export const tr02 = defineCheck({
  id: "TR02",
  claimKey: "trend.latest_settled_week",
  title: "Latest week, stated beside every trend",
  group: "trends",
  metrics: ["A.roas_window(w)", "W.last_settled_day", "W.settled_days"],
  confounders: ["MI08"],
  requires: ["dailyMetrics"],
  impactFormula: "IMP_NONE",
  run(ctx) {
    const gate = gateOnData(ctx, ["dailyMetrics"]);
    if (gate) return gate;
    const latestWeek = ctx.get("A.roas_window(w)", { window: "last7" });
    if (!isOk(latestWeek))
      return {
        state: "insufficient_data",
        reason: `the latest week is not computable: ${latestWeek.detail}`,
      };
    const settledWeek = ctx.get("A.roas_window(w)", { window: "settled_week" });
    const settledToDate = ctx.get("A.roas_window(w)", { window: "settled_to_date" });
    const lastSettled = ctx.get("W.last_settled_day");
    const settledDays = ctx.get("W.settled_days");
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "trend.latest_settled_week",
          scope: accountScope(ctx),
          cite: [latestWeek, settledWeek, settledToDate, lastSettled, settledDays],
          facts: {
            latest_week_roas: num(latestWeek),
            latest_week_range: `${latestWeek.window?.start ?? "?"}..${latestWeek.window?.end ?? "?"}`,
            latest_week_settled: latestWeek.maturity.settledStrict === true,
            settled_week_roas: num(settledWeek),
            settled_week_range: isOk(settledWeek)
              ? `${settledWeek.window?.start ?? "?"}..${settledWeek.window?.end ?? "?"}`
              : null,
            settled_to_date_roas: num(settledToDate),
            last_settled_day_strict: settledDayOf(lastSettled, "strict"),
            last_settled_day_practical: settledDayOf(lastSettled, "practical"),
            settled_days: num(settledDays),
          },
          population: windowRows(latestWeek),
          note: "context for the trend checks — never a finding on its own",
        }),
      ],
    };
  },
});

/**
 * TR03 — a dated change that may explain a move. Google keeps about 30 days of
 * change history; partial coverage of a longer window bounds what silence can
 * mean (absence of a change is unknown, not cleared), never whether a change
 * that was found may be named. One note per campaign touched.
 */
export const tr03 = defineCheck({
  id: "TR03",
  claimKey: "change.dated_cause",
  title: "A dated change explains the move",
  clientLabel: "dated changes that may explain a move",
  group: "trends",
  metrics: [
    "A.change_days_covered",
    "W.window_days",
    "A.change_count",
    "CH.changes_near(campaign, date, ±3d)",
  ],
  confounders: ["AS11", "AS06"],
  requires: ["campaigns", "changeHistory"],
  impactFormula: "IMP_NONE",
  noneFoundMeans:
    "No budget, bidding-target or status change was made, and no campaign, ad group or asset group was launched or removed, in the window.",
  noteOnly:
    "Budget, bidding-target or status changes, or launches and removals, were made in the window; they are listed so a move can be read against them.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "changeHistory"]);
    if (gate) return gate;
    const covered = ctx.get("A.change_days_covered");
    const windowDays = ctx.get("W.window_days");
    const days = num(covered);
    const total = num(windowDays);
    if (days == null || total == null) {
      return {
        state: "not_checkable",
        reason:
          "change-history coverage is not computable, so a dated cause can neither be found nor ruled out",
        table: "change_history",
      };
    }
    const partial = days < total;

    const material = ctx.model.attrs.changeHistory.material;
    if (material.length === 0) {
      return partial
        ? {
            state: "insufficient_data",
            reason: `change history reaches back ${days} of ${total} days (Google keeps about 30), so the absence of a change is unknown rather than cleared`,
          }
        : { state: "none_found", population: ctx.model.attrs.changeHistory.rows };
    }

    const byCampaign = new Map<string | null, typeof material>();
    for (const m of material) {
      const k = m.campaignId;
      if (!byCampaign.has(k)) byCampaign.set(k, []);
      byCampaign.get(k)!.push(m);
    }

    const findings: CheckFinding[] = [];
    const summary = (changes: typeof material) => {
      const dates = changes.map((c) => c.date).sort();
      return {
        changes: changes.length,
        first_change: dates[0] ?? null,
        last_change: dates[dates.length - 1] ?? null,
        // the material fields in plain words, not every API path a row touched
        fields_touched: [...new Set(changes.flatMap((c) => c.materialFields))].join(", "),
        changes_by_a_person: changes.filter((c) => c.changedBy === "person").length,
        coverage_days: days,
        coverage_partial: partial,
      };
    };
    const coverageNote = partial
      ? `change history reaches ${days} of ${total} days (Google's own limit)`
      : undefined;
    // N10: a campaign paused since (it spent in the window) carries no finding of its own
    // (the activity gate holds those back), so its changes are named together in one
    // account-wide finding: a launch batch paused later still dates a move
    const notRunning: { campaign: CampaignNode; changes: typeof material }[] = [];
    for (const [campaignId, changes] of byCampaign) {
      const campaign = campaignId
        ? eligibleCampaigns(ctx.model).find((c) => c.id === campaignId)
        : null;
      // a change to a campaign that is gone, or was never this account's, explains nothing
      if (campaignId && !campaign) continue;
      if (campaign && !isReportable(campaign)) {
        notRunning.push({ campaign, changes });
        continue;
      }
      findings.push(
        finding({
          claimKey: "change.dated_cause",
          scope: campaign ? scopeOf(campaign) : accountScope(ctx),
          ...(campaign ? { entity: { id: campaign.id, name: campaign.name } } : {}),
          cite: [covered, windowDays].filter(isOk),
          facts: { changes_on: campaign ? "campaign" : "account", ...summary(changes) },
          population: material.length,
          note: coverageNote,
        }),
      );
    }
    if (notRunning.length > 0) {
      notRunning.sort(
        (a, b) =>
          (b.campaign.windows.m90.cost ?? 0) - (a.campaign.windows.m90.cost ?? 0) ||
          a.campaign.id.localeCompare(b.campaign.id),
      );
      const spend = notRunning.reduce((t, x) => t + (x.campaign.windows.m90.cost ?? 0), 0);
      findings.push(
        finding({
          claimKey: "change.dated_cause",
          scope: accountScope(ctx),
          cite: [covered, windowDays].filter(isOk),
          facts: {
            changes_on: "campaigns_not_running",
            ...summary(notRunning.flatMap((x) => x.changes)),
            campaigns_not_running: notRunning.length,
            campaigns_not_running_spend_90d: Math.round(spend * 100) / 100,
          },
          population: material.length,
          rows: notRunning.map(({ campaign, changes }) => {
            const s = summary(changes);
            return {
              entity: { id: campaign.id, name: campaign.name },
              cells: {
                changes: s.changes,
                first_change: s.first_change,
                last_change: s.last_change,
                fields_touched: s.fields_touched,
                spend_90d: campaign.windows.m90.cost ?? 0,
              },
            };
          }),
          note: coverageNote,
        }),
      );
    }

    return findings.length > 0
      ? { state: "fires", findings }
      : { state: "none_found", population: material.length };
  },
});

/**
 * TR04 — seasonality. Compares this window's move (recent30 vs prior30: ROAS, or
 * conversions when there is no value) with the same two windows a year earlier
 * (364 days back so the weekdays line up). Never a finding of its own; the
 * answer reaches TR01 / TR01a through the confounder matrix.
 */
export const tr04 = defineCheck({
  id: "TR04",
  claimKey: "trend.seasonality",
  title: "Seasonality behind the move",
  clientLabel: "whether a seasonal pattern explains the change",
  notCheckableCategory: "no_history",
  group: "trends",
  metrics: ["W.window_days"],
  confounders: [],
  requires: ["dailyMetrics", PRIOR_YEAR_DAILY_TABLE],
  impactFormula: "IMP_NONE",
  run(ctx) {
    const gate = gateOnData(ctx, ["dailyMetrics"]);
    if (gate) return gate;
    const s = seasonalityOf(ctx.model, FLOORS.roasCpaConv);
    if (s.state !== "ok") {
      if (s.state === "thin") return { state: "insufficient_data", reason: s.reason };
      return {
        state: "not_checkable",
        reason: s.reason,
        table: PRIOR_YEAR_DAILY_TABLE,
        category: s.state === "not_synced" ? "our_gap" : "no_history",
      };
    }
    const what = s.metric === "roas" ? "return on ad spend" : "conversions";
    const line = `${what} moved ${s.thisYear.changePct.toFixed(1)}% (${s.thisYear.priorRange} → ${s.thisYear.recentRange}); the same weeks a year ago moved ${s.lastYear.changePct.toFixed(1)}% (${s.lastYear.priorRange} → ${s.lastYear.recentRange})`;
    if (!s.explains) {
      return {
        state: "none_found",
        population: 1,
        note: s.moved
          ? `${line}, so seasonality does not explain it`
          : `${line}; no move of ${SEASONAL_MOVE_PCT}% to explain`,
      };
    }
    const windowDays = ctx.get("W.window_days");
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "trend.seasonality",
          scope: accountScope(ctx),
          cite: [windowDays],
          facts: {
            metric: s.metric,
            change_pct: s.thisYear.changePct,
            recent30: s.thisYear.recent,
            prior30: s.thisYear.prior,
            year_ago_change_pct: s.lastYear.changePct,
            year_ago_recent30: s.lastYear.recent,
            year_ago_prior30: s.lastYear.prior,
            year_ago_recent_range: s.lastYear.recentRange,
            year_ago_prior_range: s.lastYear.priorRange,
          },
          population: 1,
          note: `${line}, so the move is at least partly seasonal`,
        }),
      ],
    };
  },
});

/**
 * TR05 (round 5): a paused campaign that returned this or less per $1 only broke even; it
 * is not one "that used to sell" (judged on its numbers, never on its name). Applied only when
 * the account's own return is above it (its value reads as sales): a lead account's placeholder
 * values ($1 a conversion) say nothing about break-even.
 */
export const TR05_BREAK_EVEN_ROAS = 1.1;

/**
 * TR05 — paused campaigns with a converting history worth reviving. Two
 * conversions in 90 days is not a proven winner: the conversion floor governs.
 * ONE account-scoped finding lists them: a finding scoped to a paused campaign
 * is held back by the activity gate (no claim about anything not running), and
 * this one is about the account's options, not about spend.
 */
export const tr05 = defineCheck({
  id: "TR05",
  claimKey: "campaign.dormant_winner",
  title: "Paused campaign with a converting history",
  clientLabel: "paused campaigns that used to sell",
  group: "trends",
  metrics: [
    "A.spend",
    "A.conv_value",
    "C.conv",
    "C.spend",
    "C.value",
    "C.roas",
    "F.conv_min_for_verdict",
  ],
  confounders: ["AS06", "TR06"],
  requires: ["campaigns", "campaignDailyMetrics"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No paused campaign has a converting history above the conversion floor.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns"]);
    if (gate) return gate;
    const { dormantDays: minDormant } = ctx.settings.trends;
    const floors = ctx.get("F.conv_min_for_verdict");
    const minConv =
      isOk(floors) &&
      floors.value &&
      typeof floors.value === "object" &&
      !Array.isArray(floors.value)
        ? Number((floors.value as Record<string, unknown>).moderate ?? EVIDENCE.moderateConv)
        : EVIDENCE.moderateConv;

    const winners: Array<{
      id: string;
      name: string;
      conv: number;
      spend: number | null;
      roas: number | null;
      dormantDays: number;
      cite: MetricValue[];
    }> = [];
    let population = 0;
    const belowFloor: string[] = [];
    const breakEven: string[] = [];
    // the break-even bar holds only where the account's value reads as sales
    const accountSpend = num(ctx.get("A.spend"));
    const accountValue = num(ctx.get("A.conv_value"));
    const valueIsSales =
      accountSpend != null &&
      accountSpend > 0 &&
      accountValue != null &&
      accountValue / accountSpend > TR05_BREAK_EVEN_ROAS;
    for (const c of eligibleCampaigns(ctx.model)) {
      if (String(c.status ?? "").toUpperCase() !== "PAUSED") continue;
      const lastActive = c.attrs.lastActiveDate;
      if (!lastActive || !ctx.window.end) continue;
      population++;
      const dormantDays = Math.round(
        (Date.parse(`${ctx.window.end}T00:00:00Z`) - Date.parse(`${lastActive}T00:00:00Z`)) /
          86_400_000,
      );
      if (dormantDays <= minDormant) continue;
      const conv = ctx.get("C.conv", { campaignId: c.id });
      const n = num(conv);
      if (n == null || n < minConv) {
        belowFloor.push(`${c.name} (${dormantDays}d dormant, ${n ?? 0} conv < ${minConv})`);
        continue;
      }
      const spend = ctx.get("C.spend", { campaignId: c.id });
      const roas = ctx.get("C.roas", { campaignId: c.id });
      // one that only broke even (sales value tracked) did not sell at a profit; judged on its
      // sales value per $1 spent, which needs no conversion floor (the return figure does)
      const sales = num(ctx.get("C.value", { campaignId: c.id }));
      const spent = num(spend);
      const r = sales != null && sales > 0 && spent != null && spent > 0 ? sales / spent : null;
      if (valueIsSales && r != null && r <= TR05_BREAK_EVEN_ROAS) {
        breakEven.push(`${c.name} (${dormantDays}d dormant, ${r.toFixed(2)} per 1 spent)`);
        continue;
      }
      winners.push({
        id: c.id,
        name: c.name,
        conv: n,
        spend: num(spend),
        roas: num(roas),
        dormantDays,
        cite: [conv, spend, roas].filter(isOk),
      });
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no paused campaign has a last day with activity in the window",
        table: "campaigns",
        category: "not_present",
      };
    if (winners.length === 0)
      return {
        state: "none_found",
        population,
        note:
          belowFloor.length > 0 || breakEven.length > 0
            ? [
                belowFloor.length > 0
                  ? `dormant but below the ${minConv}-conversion floor: ${belowFloor.join("; ")}`
                  : null,
                breakEven.length > 0
                  ? `dormant but only broke even (${TR05_BREAK_EVEN_ROAS} or less per 1 spent): ${breakEven.join("; ")}`
                  : null,
              ]
                .filter((x): x is string => x != null)
                .join("; ")
            : `no paused campaign has been dormant more than ${minDormant} days`,
      };
    winners.sort((a, b) => b.conv - a.conv || a.id.localeCompare(b.id));
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "campaign.dormant_winner",
          scope: accountScope(ctx),
          cite: [...winners.flatMap((w) => w.cite), floors].filter(isOk),
          facts: {
            paused_campaigns_that_sold: winners.length,
            conversion_floor: minConv,
            dormant_days_bar: minDormant,
          },
          population,
          rows: winners.map((w) => ({
            entity: { id: w.id, name: w.name },
            cells: {
              conversions_90d: w.conv,
              ...(w.spend != null ? { spend_90d: w.spend } : {}),
              ...(w.roas != null ? { roas: w.roas } : {}),
              days_paused: w.dormantDays,
            },
          })),
        }),
      ],
    };
  },
});

/**
 * TR06 — a campaign that spends and never converts. The size of the waste is
 * scoring's job; this check only says the campaign returned nothing on enough
 * clicks to mean it.
 */
export const tr06 = defineCheck({
  id: "TR06",
  claimKey: "campaign.zombie",
  title: "Campaign spends without converting",
  clientLabel: "campaigns that spend and never convert",
  group: "trends",
  metrics: ["C.conv", "C.clicks", "C.spend", "A.spend_monthly"],
  confounders: ["MI01", "AS06", "TR05", "BB04"],
  requires: ["campaigns"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "No campaign spends without converting.",
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns"]);
    if (gate) return gate;
    const { zeroConvMinClicks } = ctx.settings.trends;
    const monthly = ctx.get("A.spend_monthly");
    const findings: CheckFinding[] = [];
    let population = 0;
    const weak: string[] = [];
    for (const c of eligibleCampaigns(ctx.model)) {
      const conv = ctx.get("C.conv", { campaignId: c.id });
      const clicks = ctx.get("C.clicks", { campaignId: c.id });
      const spend = ctx.get("C.spend", { campaignId: c.id });
      const n = num(conv);
      const k = num(clicks);
      const s = num(spend);
      if (n == null || k == null || s == null) continue;
      population++;
      if (n !== 0 || s <= 0) continue;
      if (k < zeroConvMinClicks) {
        weak.push(`${c.name} (${k} clicks < ${zeroConvMinClicks})`);
        continue;
      }
      findings.push(
        finding({
          claimKey: "campaign.zombie",
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [conv, clicks, spend, monthly],
          facts: { conv: n, clicks: k, wasted_cost_90d: s, spend_monthly: num(monthly) },
          population,
        }),
      );
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no eligible campaign carries clicks, conversions and cost",
        table: "campaigns",
      };
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note:
            weak.length > 0
              ? `zero conversions but under the click bar: ${weak.join("; ")}`
              : undefined,
        };
  },
});

/**
 * TR07 — paid clicks duplicating a first-position organic result. Not run by
 * design: Google's API reports organic clicks, impressions and queries
 * (paid_organic_search_term_view) but not the organic position, so "already
 * ranks first" can never be read.
 */
export const tr07 = defineCheck({
  id: "TR07",
  claimKey: "paid_organic.brand_cannibalisation",
  title: "Paid click duplicates a first-position organic result",
  clientLabel: "paid clicks on searches where you already rank first organically",
  notCheckableCategory: "google_withholds",
  group: "trends",
  metrics: [],
  confounders: ["AS01", "SK07"],
  requires: ["campaigns"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "No paid click duplicates a first-position organic result.",
  run(): CheckResult {
    return {
      state: "not_checkable",
      reason:
        "Google's API reports organic clicks and impressions for paid searches, not the organic position, so a first-position duplicate cannot be identified",
      category: "google_withholds",
    };
  },
});

/**
 * TR08 — a positive that says what is earning: the biggest live spender when it
 * returns at least the live-campaign average ("carries the account"), else the
 * non-brand campaign that returns most per unit of spend that is not noise
 * ("best non-brand return per dollar", its own claim key: it carries nothing at a
 * small share of spend). Brand is never the standout: its return is demand the
 * account already owns, so the standout states brand's return beside its own.
 * A campaign whose return is falling (TR01's question) is no strength: dropped.
 */
const tr08 = defineCheck({
  id: "TR08",
  claimKey: CLAIM_KEYS.PERFORMANCE_CARRYING_CAMPAIGN,
  title: "the campaign carrying the account, or the best non-brand return per dollar",
  clientLabel: "the campaign that carries the account, or earns most per dollar outside brand",
  group: "trends",
  metrics: ["C.spend", "C.roas", "A.spend", "A.roas"],
  confounders: ["TR01"],
  requires: ["campaigns"],
  impactFormula: "IMP_NONE",
  // no noneFoundMeans on purpose: the clean branch is "the biggest spender earns below the rest",
  // which is nothing good to say
  noteOnly:
    "One campaign carries the account and is earning, or earns most per dollar outside brand: a strength, not a fault.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["campaigns"]);
    if (gate) return gate;
    const { carryingMinSharePct, standoutMinSpendUsd } = ctx.settings.trends;

    const live = eligibleCampaigns(ctx.model).filter(
      (c) => (c.windows.m90.cost ?? 0) > 0 && String(c.status).toUpperCase() === "ENABLED",
    );
    if (live.length === 0)
      return {
        state: "not_checkable",
        reason: "no live campaign spent in the window",
        table: "campaigns",
        category: "not_present",
      };
    const accountCost = live.reduce((n, c) => n + (c.windows.m90.cost ?? 0), 0);
    const accountValue = live.reduce((n, c) => n + (c.windows.m90.value ?? 0), 0);
    if (accountCost <= 0)
      return {
        state: "not_checkable",
        reason: "live campaigns carry no spend to take a share of",
        table: "campaigns",
      };
    const accountRoas = accountValue / accountCost;
    const standoutBar = scaleMoney(standoutMinSpendUsd, ctx.currency);

    const ranked = [...live].sort(
      (a, b) => (b.windows.m90.cost ?? 0) - (a.windows.m90.cost ?? 0) || a.id.localeCompare(b.id),
    );
    const shareOf = (c: (typeof live)[number]) => ((c.windows.m90.cost ?? 0) / accountCost) * 100;
    const judgeable = live.filter(
      (c) => (c.windows.m90.conv ?? 0) >= FLOORS.roasCpaConv && c.windows.m90.roas != null,
    );
    if (judgeable.length === 0) {
      return {
        state: "not_checkable",
        reason: `no live campaign has the ${FLOORS.roasCpaConv} conversions a return claim needs`,
        table: "campaigns",
        category: "thin_data",
      };
    }

    const top = ranked[0]!;
    const topJudgeable = judgeable.includes(top);
    const carrying =
      topJudgeable &&
      shareOf(top) >= carryingMinSharePct &&
      (top.windows.m90.roas ?? 0) >= accountRoas;
    const nonBrand = judgeable.filter((c) => !c.attrs.isBrand);
    const best = [...nonBrand].sort(
      (a, b) => (b.windows.m90.roas ?? 0) - (a.windows.m90.roas ?? 0) || a.id.localeCompare(b.id),
    )[0];
    const standout =
      !carrying &&
      best != null &&
      standoutBar != null &&
      (best.windows.m90.roas ?? 0) > accountRoas &&
      (best.windows.m90.cost ?? 0) >= standoutBar;

    if (!carrying && !standout) {
      return {
        state: "none_found",
        population: live.length,
        note: topJudgeable
          ? `${top.name} carries ${shareOf(top).toFixed(1)}% of live spend and returns below the live-campaign average, and no other campaign that is not brand returns above it on spend worth naming`
          : "the biggest live campaign cannot carry a return claim, and no campaign that is not brand returns above the live-campaign average on spend worth naming",
      };
    }

    const subject = carrying ? top : best!;
    const share = shareOf(subject);
    const roas = subject.windows.m90.roas!;
    // the standout leaves brand out on purpose; brand's own return is stated beside it
    const brand = live.filter((c) => c.attrs.isBrand);
    const brandCost = brand.reduce((n, c) => n + (c.windows.m90.cost ?? 0), 0);
    const brandValue = brand.reduce((n, c) => n + (c.windows.m90.value ?? 0), 0);
    const brandRoas = brandCost > 0 ? brandValue / brandCost : null;

    return {
      state: "fires",
      findings: [
        finding({
          claimKey: carrying
            ? CLAIM_KEYS.PERFORMANCE_CARRYING_CAMPAIGN
            : CLAIM_KEYS.PERFORMANCE_STANDOUT_NON_BRAND,
          scope: scopeOf(subject),
          cite: [
            ctx.get("C.spend", { campaignId: subject.id }),
            ctx.get("C.roas", { campaignId: subject.id }),
          ].filter(isOk),
          entity: { id: subject.id, name: subject.name },
          facts: {
            strength: carrying
              ? "carries the account and earns"
              : "best non-brand return per dollar",
            share_of_live_spend_pct: share,
            campaign_roas: roas,
            // the live campaigns' return: the account's would include paused ones
            live_campaign_roas: accountRoas,
            campaign_spend: subject.windows.m90.cost ?? 0,
            ...(carrying
              ? {}
              : {
                  excludes_brand: true,
                  // null = no live brand campaign spent in the window
                  brand_roas: brandRoas,
                }),
          },
          population: live.length,
          rows: ranked.map((c) => ({
            entity: { id: c.id, name: c.name },
            cells: {
              spend: c.windows.m90.cost ?? 0,
              share_of_live_spend_pct: ((c.windows.m90.cost ?? 0) / accountCost) * 100,
              ...(c.windows.m90.roas != null ? { roas: c.windows.m90.roas } : {}),
            },
          })),
          note: carrying
            ? "positive: this is the campaign the account rests on, and it is earning"
            : "positive: the best return per dollar among the campaigns that are not brand (brand is left out and its own return is shown beside it); it does not carry the account",
        }),
      ],
    };
  },
});

/** TR09 (round 5): under this move either way (percent) the return per $1 "held". */
const TR09_HELD_PCT = 2;

/** TR09 (round 5): the title says how the return moved, from the two windows' numbers. */
export function tr09Title(salesMove: number, roasMove: number): string {
  if (roasMove >= TR09_HELD_PCT) return "Campaign sales fell while its return per $1 rose";
  if (roasMove > -TR09_HELD_PCT) return "Campaign sales fell while its return per $1 held";
  return roasMove > salesMove
    ? "Campaign sales fell, and its return per $1 fell less"
    : "Campaign sales and its return per $1 both fell";
}

/**
 * TR09 (round 3 R4) — a live campaign whose sales value fell while its return per dollar
 * held: the last 30 days against the 30 before, sales value down by `salesFallPct` or more
 * and the return moved less than TR01's decline bar either way. TR01 sees only the return,
 * so a campaign that sold a third less on a third less spend said nothing (a shop's product
 * PMax: $41.9k -> $29.8k sales, $2.78 -> $2.41 per $1). Numbers only: the two windows'
 * sales, spend and return; never a cause and never advice.
 */
export const tr09 = defineCheck({
  id: "TR09",
  claimKey: CLAIM_KEYS.TREND_SALES_FELL_RETURN_HELD,
  title: "Campaign sales fell more than its return per $1",
  clientLabel: "campaigns whose sales fell more than their return per dollar",
  group: "trends",
  metrics: ["C.window(w)", "C.active_days", "F.days_min_for_window"],
  confounders: ["MI01", "MI08", "TR03", "TR04"],
  requires: ["campaigns", "campaignDailyMetrics"],
  impactFormula: "IMP_NONE",
  noneFoundMeans:
    "No live campaign's sales fell over the last 30 days while its return per dollar moved much less.",
  judges: {
    campaigns: "enabled",
    because: "a paused campaign's sales stop because it stopped, not because they fell",
  },
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns", "campaignDailyMetrics"]);
    if (gate) return gate;
    const minDays = num(ctx.get("F.days_min_for_window")) ?? 10;
    const { declinePct, salesFallPct } = ctx.settings.trends;

    const findings: CheckFinding[] = [];
    let population = 0;
    const live = eligibleCampaigns(ctx.model).filter(
      (c) => String(c.status).toUpperCase() === "ENABLED",
    );
    for (const c of live) {
      const w30 = ctx.get("C.window(w)", { campaignId: c.id, window: "30d" });
      const p30 = ctx.get("C.window(w)", { campaignId: c.id, window: "prior30" });
      const daysNow = windowRows(w30) ?? 0;
      const daysBefore = windowRows(p30) ?? 0;
      if (daysNow < minDays || daysBefore < minDays) continue;
      const valueNow = windowField(w30, "value");
      const valueBefore = windowField(p30, "value");
      const roasNow = windowField(w30, "roas");
      const roasBefore = windowField(p30, "roas");
      // the return is withheld below the conversion floor: no verdict on "held"
      if (roasNow == null || roasBefore == null || valueBefore == null || valueBefore <= 0)
        continue;
      const days = num(ctx.get("C.active_days", { campaignId: c.id }));
      if (days == null || days < MIN_ACTIVE_DAYS) continue;
      population++;
      const salesMove = changePct(valueNow, valueBefore);
      const roasMove = changePct(roasNow, roasBefore);
      if (salesMove == null || roasMove == null) continue;
      if (salesMove > -salesFallPct) continue;
      // a return that moved past TR01's bar is TR01's (down) or not "held" (up)
      if (Math.abs(roasMove) >= declinePct) continue;
      const spendNow = windowField(w30, "cost");
      const spendBefore = windowField(p30, "cost");
      const r2 = (n: number | null) => (n == null ? null : Number(n.toFixed(2)));
      const r1 = (n: number | null) => (n == null ? null : Number(n.toFixed(1)));
      const spendMove = changePct(spendNow, spendBefore);
      findings.push({
        title: tr09Title(salesMove, roasMove),
        ...finding({
          claimKey: CLAIM_KEYS.TREND_SALES_FELL_RETURN_HELD,
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [w30, p30],
          facts: {
            sales_value_30d: r2(valueNow),
            sales_value_prior30: r2(valueBefore),
            sales_change_pct: r1(salesMove),
            spend_30d: r2(spendNow),
            spend_prior30: r2(spendBefore),
            spend_change_pct: r1(spendMove),
            roas_30d: r2(roasNow),
            roas_prior30: r2(roasBefore),
            roas_change_pct: r1(roasMove),
            days_with_data_30d: daysNow,
            days_with_data_prior30: daysBefore,
          },
          population,
          note: `sales value ${r2(valueBefore)} -> ${r2(valueNow)} (${r1(salesMove)}%), spend ${r2(spendBefore)} -> ${r2(spendNow)} (${r1(spendMove)}%), return per 1 spent ${r2(roasBefore)} -> ${r2(roasNow)} (${r1(roasMove)}%, under the ${declinePct}% decline bar); last 30 days (${daysNow} days with data) against the 30 before (${daysBefore} days with data)`,
        }),
      });
    }
    if (population === 0)
      return {
        state: "insufficient_data",
        reason: `no live campaign has ≥ ${minDays} daily rows on both sides with sales value and a return above the conversion floor`,
      };
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note: `no live campaign's sales value fell ${salesFallPct}% or more while its return moved under ${declinePct}%`,
        };
  },
});

/** TR10: the campaign types judged on their own return (Demand Gen, Video and Display act earlier in the path). */
const TR10_TYPES: ReadonlySet<string> = new Set(["SEARCH", "SHOPPING", "PERFORMANCE_MAX"]);
/** TR10: a campaign under this share of the account's spend is a note, not a warning. */
const TR10_WARN_SPEND_SHARE = 0.1;

/** TR10 (round 5): the title of a campaign line that is still learning. */
export const TR10_TITLE_LEARNING = "Spent more than it brought in, while still learning";

/** TR10: a campaign Google shows as new (LEARNING_NEW) is early only under this many days with spend. */
const TR10_NEW_MAX_DAYS = 30;

/**
 * TR10 (round 5): Google's own word that a campaign is still learning, or null. The campaign
 * status LEARNING, or a bidding strategy status starting LEARNING_ (LEARNING_NEW = a new
 * campaign, the others a recent change); null when not read or not learning. `isNew` is true
 * only for LEARNING_NEW: the other learning states follow a change on a campaign of any age.
 */
export function googleLearningState(c: {
  attrs: Pick<CampaignNode["attrs"], "primaryStatus" | "biddingStrategySystemStatus">;
}): { text: string; isNew: boolean } | null {
  const bidding = String(c.attrs.biddingStrategySystemStatus ?? "").toUpperCase();
  if (bidding === "LEARNING_NEW") return { text: "Google shows it as learning (new)", isNew: true };
  if (bidding.startsWith("LEARNING_"))
    return {
      text: `Google shows its bidding re-learning after a ${bidding
        .slice("LEARNING_".length)
        .toLowerCase()
        .replace(/_change$/, "")
        .replace(/_/g, " ")} change`,
      isNew: false,
    };
  if (bidding === "MULTIPLE_LEARNING")
    return {
      text: "Google shows its bidding re-learning after more than one change",
      isNew: false,
    };
  if (String(c.attrs.primaryStatus ?? "").toUpperCase() === "LEARNING")
    return { text: "Google shows it as learning", isNew: false };
  return null;
}

/**
 * TR10 (round 4 R16) — the account, or a live Search / Shopping / Performance Max campaign,
 * brought in less sales value than it spent over the 90-day window, with sales value tracked
 * (a shop's second-country account: $0.67 per $1, its PMax $0.13 per $1, and no line said so). A campaign
 * needs the money bar of spend; one with no sale at all is TR06's. Numbers only: spend,
 * sales value, return per $1. Never priced (the money is other checks'), never advice.
 * Round 5: a campaign that is actually new (first spent under `floors.learningMinAgeDays` ago,
 * or Google shows it as new with under 30 days of spend) is a note that says so: early, not
 * judged. Any other learning state (re-learning after a budget or setting change) keeps the
 * warning, with the learning state stated.
 */
export const tr10 = defineCheck({
  id: "TR10",
  claimKey: CLAIM_KEYS.RETURN_BELOW_SPEND,
  title: "Spent more than it brought in",
  clientLabel: "the account or a campaign bringing in less than it spent",
  group: "trends",
  metrics: [
    "A.spend",
    "A.conv_value",
    "A.active_days",
    "C.spend",
    "C.value",
    "C.conv",
    "C.active_days",
    "C.age_days",
    "T.waste_floor",
  ],
  // MI08: the window runs to the end, past the conversion lookback — a stated caveat
  confounders: ["MI01", "MI08"],
  requires: ["campaigns"],
  impactFormula: "IMP_NONE",
  noneFoundMeans:
    "The account and every live Search, Shopping and Performance Max campaign brought in more sales value than they spent.",
  judges: {
    campaigns: "enabled",
    because: "a paused campaign spends nothing now",
  },
  run(ctx) {
    const gate = gateOnData(ctx, ["campaigns"]);
    if (gate) return gate;
    const spendV = ctx.get("A.spend");
    const valueV = ctx.get("A.conv_value");
    const accountSpend = num(spendV);
    const accountValue = num(valueV);
    if (accountSpend == null || accountSpend <= 0)
      return { state: "insufficient_data", reason: "the account spent nothing in the window" };
    if (accountValue == null || accountValue <= 0)
      return {
        state: "not_checkable",
        reason: "no sales value is tracked, so what the spend brought in cannot be read",
        table: "campaigns",
        category: "not_present",
      };
    const floorV = ctx.get("T.waste_floor");
    const floor = num(floorV);
    if (floor == null || !Number.isFinite(floor))
      return {
        state: "insufficient_data",
        reason: "the money bar is not computable (currency or window unknown)",
      };
    const r2 = (n: number) => Number(n.toFixed(2));
    // "over N days with spend": an account that started mid-window did not spend 90 days
    const overDays = (n: number | null) =>
      n != null && n > 0 ? `over ${n} days with spend` : "over the window";
    const accountDaysV = ctx.get("A.active_days");
    const accountDays = num(accountDaysV);
    const findings: CheckFinding[] = [];
    let population = 1;
    if (accountValue < accountSpend)
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.RETURN_BELOW_SPEND,
          scope: accountScope(ctx),
          entity: { id: ctx.model.id, name: ctx.model.name },
          cite: [spendV, valueV, accountDaysV].filter(isOk),
          facts: {
            spend_90d: r2(accountSpend),
            sales_value_90d: r2(accountValue),
            return_per_dollar: r2(accountValue / accountSpend),
            ...(accountDays != null ? { days_with_spend: accountDays } : {}),
          },
          population: 1,
          note: `the account spent ${r2(accountSpend)} and brought in ${r2(accountValue)} in sales value ${overDays(accountDays)} (${r2(accountValue / accountSpend)} per 1 spent)`,
        }),
      );
    const live = eligibleCampaigns(ctx.model).filter(
      (c) => String(c.status).toUpperCase() === "ENABLED" && TR10_TYPES.has(String(c.attrs.type)),
    );
    for (const c of live) {
      const sV = ctx.get("C.spend", { campaignId: c.id });
      const vV = ctx.get("C.value", { campaignId: c.id });
      const cV = ctx.get("C.conv", { campaignId: c.id });
      const spend = num(sV);
      const value = num(vV);
      const conv = num(cV);
      if (spend == null || spend < floor || value == null) continue;
      population++;
      // no sale at all is TR06's (spends without converting)
      if (conv == null || conv <= 0 || value >= spend) continue;
      const daysV = ctx.get("C.active_days", { campaignId: c.id });
      const days = num(daysV);
      // still learning: lowered only when the campaign is actually new: it first spent under the
      // learning age ago, or Google shows it as new (LEARNING_NEW) with under 30 days of spend.
      // Any other learning state (a budget or setting change) keeps the warning, stated.
      const ageV = ctx.get("C.age_days", { campaignId: c.id });
      const age = num(ageV);
      const minAge = ctx.settings.floors.learningMinAgeDays;
      const google = googleLearningState(c);
      const young = age != null && age < minAge;
      const newByGoogle = google?.isNew === true && days != null && days < TR10_NEW_MAX_DAYS;
      const lowered = young || newByGoogle;
      const learning =
        google != null || young
          ? [
              google?.text ?? null,
              young
                ? `it first spent ${age} days ago, under the ${minAge}-day learning period`
                : null,
            ]
              .filter((x): x is string => x != null)
              .join("; ")
          : null;
      const learningNote =
        learning == null
          ? ""
          : lowered
            ? `; still learning: ${learning}, so this is early, not a verdict`
            : `; ${learning}; the loss covers ${days != null ? `${days} days with spend` : "the whole window"}`;
      findings.push({
        ...finding({
          claimKey: CLAIM_KEYS.RETURN_BELOW_SPEND,
          scope: scopeOf(c),
          entity: { id: c.id, name: c.name },
          cite: [sV, vV, cV, floorV, daysV, ...(young ? [ageV] : [])].filter(isOk),
          facts: {
            spend_90d: r2(spend),
            sales_value_90d: r2(value),
            return_per_dollar: r2(value / spend),
            conversions_90d: r2(conv),
            account_return_per_dollar: r2(accountValue / accountSpend),
            share_of_account_spend_pct: r2((spend / accountSpend) * 100),
            ...(days != null ? { days_with_spend: days } : {}),
            ...(learning != null ? { still_learning: learning } : {}),
            ...(young && age != null ? { first_spent_days_ago: age } : {}),
          },
          population,
          note: `spent ${r2(spend)} and brought in ${r2(value)} in sales value ${overDays(days)} (${r2(value / spend)} per 1 spent; the account ${r2(accountValue / accountSpend)})${learningNote}`,
        }),
        ...(lowered ? { title: TR10_TITLE_LEARNING } : {}),
        ...(spend < TR10_WARN_SPEND_SHARE * accountSpend || lowered
          ? { maxSeverity: "info" as const }
          : {}),
      });
    }
    for (const f of findings) f.sample.population = population;
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note: `the account (${r2(accountValue / accountSpend)} per 1 spent) and ${population - 1} live Search / Shopping / Performance Max campaign(s) with ${r2(floor)}+ spend each brought in more than they spent`,
        };
  },
});

export const TREND_CHECKS: CheckDefinition[] = [
  tr01,
  tr01a,
  tr02,
  tr03,
  tr04,
  tr05,
  tr06,
  tr07,
  tr08,
  tr09,
  tr10,
];
