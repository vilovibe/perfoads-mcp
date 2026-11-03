// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Carried-in checks: MI13, AS12, BB12, BB13, SK24, SK25, SL09, SH13-SH15, SH17-SH21,
 * PX13 and VD07. Each keeps the group of its subject (MI13 is measurement, SK24
 * search ...). Every bar a
 * reasonable expert could set differently is a setting (settings.ts); the few
 * fixed numbers here are named and explained where they are declared.
 *
 *   - `gateOnData(ctx, requires)` runs first in every `run`;
 *   - numbers come from the registry through `ctx.get(...)`;
 *   - a signal the model cannot resolve is `not_checkable` naming the gap, never `none_found`.
 */
import { assetsUnknownReason } from "../model/nodes/AssetGroupNode.js";
import {
  groupByParentProduct,
  merchantCenterLimit,
  outsideMerchantCenterRead,
  parentProductKey,
  type ProductNode,
} from "../model/nodes/ProductNode.js";
import { scaleMoney } from "../registry/thresholds.js";
import { foldBrandText } from "../shared/campaignClassification.js";
import { clientGrossMargin } from "./clientContextGate.js";
import { pmaxWastedParentKeys } from "./pmax.js";
import {
  feedProducts,
  merchantCenterGate,
  NO_PRODUCTS,
  noLiveCampaignCanShow,
  productRows,
  statusCell,
} from "./shopping.js";
import { liveConversionActions } from "../roles.js";
import { ROLLUP_IS_SAMPLE, ROLLUP_WASTED_COST_90D } from "../scoring/impact.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import type { MetricValue } from "../registry/types.js";
import { eligibleCampaigns } from "../registry/index.js";
import { liveAssetGroupsOf } from "../registry/entityStatus.js";
import {
  campaignsOf,
  type CheckCtx,
  type CheckDefinition,
  type CheckFinding,
  type CheckResult,
  type CheckScope,
  defineCheck,
  evidence as evidenceOf,
  finding,
  gateOnData,
  isOk,
  num,
  wasteFloorReason,
} from "./types.js";

/** A lead action should count once per click, a purchase action every purchase. */
const PURCHASE_CATEGORIES = new Set(["PURCHASE", "PURCHASE_ONLINE"]);
const LEAD_CATEGORIES = new Set([
  "SUBMIT_LEAD_FORM",
  "QUALIFIED_LEAD",
  "CONVERTED_LEAD",
  "BOOK_APPOINTMENT",
  "REQUEST_QUOTE",
  "SIGNUP",
  "CONTACT",
  "PHONE_CALL_LEAD",
  "IMPORTED_LEAD",
  "GET_DIRECTIONS",
]);

/** Google reports "< 10%" impression share as the literal 0.0999: a bound, not a measurement. */
const IS_LOW_SENTINEL_PCT = 9.99;

export const IMAGE_FIELD_TYPES = [
  "MARKETING_IMAGE",
  "SQUARE_MARKETING_IMAGE",
  "PORTRAIT_MARKETING_IMAGE",
] as const;

/** Undersized images under this share of the account's spend are a note-level fix. */
const PX13_SMALL_IMAGE_SHARE = 0.01;
const PX13_IMAGE_SPEND_UNKNOWN = "We could not see how much this image itself spent.";

const accountScope = (): CheckScope => ({ type: "account", id: null, name: null });

const campaignScope = (c: CampaignNode): CheckScope => ({
  type: "campaign",
  id: c.id,
  name: c.name,
  campaignId: c.id,
  campaignName: c.name,
});

const cvrOf = (v: MetricValue): number | null => {
  if (!isOk(v) || typeof v.value !== "object" || v.value == null || Array.isArray(v.value))
    return null;
  const slice = v.value as Record<string, number | null>;
  const clicks = slice.clicks;
  const conv = slice.conv;
  if (clicks == null || conv == null || clicks <= 0) return null;
  return conv / clicks;
};

/** One number of an `SL.device(scope)` bundle; null when absent or not computable. */
const fieldOf = (v: MetricValue, field: string): number | null => {
  if (!isOk(v) || typeof v.value !== "object" || v.value == null || Array.isArray(v.value))
    return null;
  const x = (v.value as Record<string, number | null>)[field];
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};

const clicksOf = (v: MetricValue): number | null => {
  if (!isOk(v) || typeof v.value !== "object" || v.value == null || Array.isArray(v.value))
    return null;
  return (v.value as Record<string, number | null>).clicks ?? null;
};

// ---------------------------------------------------------------------------
// MI13 — counting type against the action's own category
// ---------------------------------------------------------------------------

const MI13_TABLES: string[] = ["conversionActions"];
const MI13 = defineCheck({
  id: "MI13",
  claimKey: CLAIM_KEYS.TRACKING_COUNTING_TYPE_MISMATCH,
  title: "conversion action counts against its category",
  clientLabel: "conversion actions counted the wrong way for what they measure",
  group: "measurement",
  metrics: ["CA.counting_type(action)"],
  confounders: ["MI03", "MI05"],
  requires: MI13_TABLES,
  impactFormula: "IMP_MEASUREMENT",
  noneFoundMeans: "Each conversion action counts the way its category implies.",
  judges: {
    conversionActions: "live",
    because: "a deleted action has no counting type anyone can fix",
  },
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, MI13_TABLES);
    if (gate) return gate;
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const a of liveConversionActions(ctx.model)) {
      const category = (a.attrs.category ?? "").toUpperCase();
      const counting = ctx.get("CA.counting_type(action)", { actionId: a.attrs.actionId });
      const countingValue =
        isOk(counting) && typeof counting.value === "string" ? counting.value : null;
      if (
        countingValue == null ||
        (!PURCHASE_CATEGORIES.has(category) && !LEAD_CATEGORIES.has(category))
      )
        continue;
      population += 1;
      const isLead = LEAD_CATEGORIES.has(category);
      const mismatch = isLead
        ? countingValue === "MANY_PER_CLICK"
        : countingValue === "ONE_PER_CLICK";
      if (!mismatch) continue;
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.TRACKING_COUNTING_TYPE_MISMATCH,
          scope: { type: "conversion_action", id: a.attrs.actionId, name: a.name },
          cite: [counting],
          entity: { id: a.attrs.actionId, name: a.name },
          facts: {
            category,
            counting_type: countingValue,
            expected: isLead ? "ONE_PER_CLICK" : "MANY_PER_CLICK",
          },
          population,
          note: isLead
            ? "lead action counting many per click"
            : "purchase action counting once per click",
        }),
      );
    }
    if (population === 0) {
      return {
        state: "not_checkable",
        reason:
          "no live conversion action carries a purchase or lead category with a counting type",
        table: "conversionActions",
        category: "not_present",
      };
    }
    return findings.length ? { state: "fires", findings } : { state: "none_found", population };
  },
});

// ---------------------------------------------------------------------------
// AS12 — brand vs prospecting share of spend (the same line as AS01)
// ---------------------------------------------------------------------------

const AS12_TABLES: string[] = ["campaigns"];
const AS12 = defineCheck({
  id: "AS12",
  claimKey: CLAIM_KEYS.ACCOUNT_BUDGET_SPLIT_OFF_TARGET,
  title: "brand vs prospecting share of spend",
  clientLabel: "how your spend splits between brand and new customers",
  group: "structure",
  metrics: ["A.brand_spend_share", "A.brand_roas", "A.brand_spend", "A.spend"],
  confounders: ["AS01", "PX02"],
  requires: AS12_TABLES,
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Brand takes less than the brand-share line of spend.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, AS12_TABLES);
    if (gate) return gate;
    const line = ctx.settings.structure.brandSpendSharePct;

    // counted over the campaigns whose money the share is made of (paused included)
    const brandCampaigns = eligibleCampaigns(ctx.model).filter((c) => c.attrs.isBrand);
    if (brandCampaigns.length === 0) {
      return {
        state: "not_checkable",
        reason: "no campaign is classified brand — the split has no brand side",
        table: "campaigns",
        category: "not_present",
      };
    }
    const share = ctx.get("A.brand_spend_share");
    const brandShare = num(share);
    const spend = ctx.get("A.spend");
    if (brandShare == null || (num(spend) ?? 0) <= 0) {
      return {
        state: "not_checkable",
        reason: "the brand share of spend is not computable (no account spend)",
        table: "campaigns",
      };
    }
    // the counter-context is the ROAS of the whole brand set that produced the share
    const brandRoas = ctx.get("A.brand_roas");
    const brandSpend = ctx.get("A.brand_spend");
    const cite = [share, brandSpend, spend, brandRoas].filter((v) => isOk(v));

    if (brandShare < line) {
      const brand = { id: null, name: "brand" };
      return {
        state: "none_found",
        population: campaignsOf(ctx).length,
        note: `brand takes ${brandShare.toFixed(1)}% of spend, under the ${line}% line`,
        evidence: [share, brandSpend, brandRoas]
          .filter((v) => isOk(v))
          .map((v) => evidenceOf(v, brand)),
      };
    }

    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.ACCOUNT_BUDGET_SPLIT_OFF_TARGET,
          scope: accountScope(),
          cite,
          entity: { id: null, name: "account" },
          entityByMetric: {
            "A.brand_spend_share": { id: null, name: "brand" },
            "A.brand_spend": { id: null, name: "brand" },
            "A.brand_roas": { id: null, name: "brand" },
          },
          facts: {
            brand_spend_share_pct: brandShare,
            prospecting_spend_share_pct: 100 - brandShare,
            brand_share_line_pct: line,
            brand_roas: num(brandRoas),
            brand_campaign_count: brandCampaigns.length,
          },
          population: campaignsOf(ctx).length,
          note: `brand is at or over the ${line}% line (the same line as AS01); the ROAS quoted is the whole brand set`,
        }),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// BB12 — absolute-top impression share
// ---------------------------------------------------------------------------

const BB12_TABLES: string[] = ["impressionShare"];
const BB12 = defineCheck({
  id: "BB12",
  claimKey: CLAIM_KEYS.BUDGET_ABSOLUTE_TOP_IS_LOW,
  title: "absolute top impression share below the bar",
  clientLabel: "how often your ads show in the very first position",
  group: "budget_bidding",
  metrics: ["C.impression_share", "C.lost_is_rank_pct"],
  confounders: ["BB02", "BB03", "SK02", "SK15"],
  requires: BB12_TABLES,
  // never IMP_LOSTIS: lost share to budget is BB02's money, and BB12 copied it
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Each measurable campaign holds its share of the first position.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, BB12_TABLES);
    if (gate) return gate;
    const bar = ctx.settings.bidding.absoluteTopMinPct;

    // only campaigns with an impression share row of their own
    const measurable = campaignsOf(ctx).filter(
      (c) => c.attrs.impressionShare.source === "impression_share",
    );
    const unmeasurable = campaignsOf(ctx).length - measurable.length;
    if (measurable.length === 0) {
      return {
        state: "not_checkable",
        reason: "no campaign has an impression share row",
        table: "impressionShare",
        category: "not_present",
      };
    }

    const findings: CheckFinding[] = [];
    let judged = 0;
    for (const c of measurable) {
      const absTop = c.attrs.impressionShare.absoluteTop;
      if (absTop == null) continue;
      judged += 1;
      const absTopPct = absTop * 100;
      if (absTopPct >= bar) continue;
      const is = ctx.get("C.impression_share", { campaignId: c.id });
      const lostRank = ctx.get("C.lost_is_rank_pct", { campaignId: c.id });
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.BUDGET_ABSOLUTE_TOP_IS_LOW,
          scope: campaignScope(c),
          cite: [is, lostRank].filter((v) => isOk(v)),
          entity: { id: c.id, name: c.name },
          facts: {
            absolute_top_is_pct: absTopPct,
            bar_pct: bar,
            is_sentinel: Math.abs(absTopPct - IS_LOW_SENTINEL_PCT) < 0.005,
          },
          population: measurable.length,
          note: `absolute-top impression share is carried as a fact; ${unmeasurable} campaigns have no impression share row and are not judged`,
        }),
      );
    }
    if (findings.length) return { state: "fires", findings };
    if (judged === 0)
      return {
        state: "not_checkable",
        reason: "no campaign reports an absolute-top impression share",
        table: "impressionShare",
      };
    return {
      state: "none_found",
      population: judged,
      note: `${unmeasurable} campaigns have no impression share row — not judged`,
    };
  },
});

// ---------------------------------------------------------------------------
// BB13 — repeated bid-target moves
// ---------------------------------------------------------------------------

/** target ROAS / CPA paths in the change history's before/after values. */
const TARGET_FIELD = /targetRoas|targetCpa|target_roas|target_cpa/i;
/** a change row on the campaign itself (Google's CAMPAIGN resource type), not its ad groups or budget. */
const isCampaignRow = (m: { resourceType: string }): boolean =>
  m.resourceType.toUpperCase() === "CAMPAIGN";
/** a target value as a number; CPA micros -> currency units so the % move is the same either way. */
function targetNumber(field: string, v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return /micros/i.test(field) ? n / 1e6 : n;
}

const BB13_TABLES: string[] = ["changeHistory"];
const BB13 = defineCheck({
  id: "BB13",
  claimKey: CLAIM_KEYS.BIDDING_TARGET_THRASH,
  title: "bid target moved repeatedly",
  clientLabel: "bid targets changed too often or by too much",
  group: "budget_bidding",
  metrics: ["A.change_days_covered", "A.change_count", "W.window_days"],
  confounders: ["AS06", "TR03", "AS11"],
  requires: BB13_TABLES,
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No campaign had its bid target moved repeatedly.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, BB13_TABLES);
    if (gate) return gate;
    const { targetMovesMax, targetMoveMinPct, targetMoveWindowDays } = ctx.settings.bidding;

    const covered = num(ctx.get("A.change_days_covered"));
    const windowDays = num(ctx.get("W.window_days"));
    const changes = num(ctx.get("A.change_count"));
    const capNote =
      covered != null && windowDays != null && covered < windowDays
        ? `Google's change history covers the last ${covered} of the ${windowDays} days (${changes ?? "?"} changes read)`
        : "the change history is a sample";
    // a target move = a target ROAS / CPA field with a numeric old AND new value
    // a CAMPAIGN row only: an ad group's own target (AD_GROUP row) is not a move of the campaign's target
    // the "values present" gate looks at every material row (values were read even when only
    // ad-group or keyword rows carry them); the move logic then keeps campaign rows only
    const anyValues = (ctx.model.attrs.changeHistory.material ?? []).filter(
      (m) => m.changedValues != null,
    );
    const withValues = anyValues.filter(isCampaignRow);
    if (anyValues.length === 0) {
      return {
        state: "insufficient_data",
        reason: `${capNote}; the change history carries no old/new values, so a move of more than ${targetMoveMinPct}% cannot be measured and more than ${targetMovesMax} moves in ${targetMoveWindowDays} days cannot be ruled out`,
      };
    }
    const moves = new Map<
      string,
      { date: string; field: string; from: number; to: number; pct: number }[]
    >();
    for (const m of withValues) {
      if (!m.campaignId) continue;
      for (const [field, v] of Object.entries(m.changedValues ?? {})) {
        if (!TARGET_FIELD.test(field) || /tolerance/i.test(field)) continue;
        const from = targetNumber(field, v?.old);
        const to = targetNumber(field, v?.new);
        if (from == null || to == null || from <= 0 || from === to) continue;
        (moves.get(m.campaignId) ?? moves.set(m.campaignId, []).get(m.campaignId)!).push({
          date: m.date,
          field,
          from,
          to,
          pct: (Math.abs(to - from) / from) * 100,
        });
      }
    }
    const enabled = campaignsOf(ctx).filter(
      (c) => String(c.status ?? "").toUpperCase() === "ENABLED",
    );
    // a shared (portfolio) strategy's target changes are not in Google's change history, so its
    // campaigns are not judged (as BB16 / BB17)
    const shared = enabled.filter(
      (c) => c.attrs.portfolioStrategyId != null || c.attrs.biddingStrategySource === "portfolio",
    );
    const live = enabled.filter((c) => !shared.includes(c));
    const sharedText =
      shared.length > 0
        ? `${shared.length} campaign(s) bid with a shared (portfolio) strategy, whose target changes Google's change history does not record, so their moves were not judged: ${shared
            .slice(0, 10)
            .map((c) => c.name)
            .join(", ")}`
        : null;
    const findings: CheckFinding[] = [];
    for (const c of live) {
      const list = (moves.get(c.id) ?? []).sort(
        (a, b) => a.date.localeCompare(b.date) || a.field.localeCompare(b.field),
      );
      if (list.length === 0) continue;
      let busiest = 0;
      for (let i = 0; i < list.length; i++) {
        const end =
          new Date(`${list[i]!.date}T00:00:00Z`).getTime() + targetMoveWindowDays * 86_400_000;
        busiest = Math.max(
          busiest,
          list.filter((x, j) => j >= i && new Date(`${x.date}T00:00:00Z`).getTime() < end).length,
        );
      }
      const largest = Math.max(...list.map((x) => x.pct));
      const repeated = busiest > targetMovesMax;
      const bigStep = largest > targetMoveMinPct;
      if (!repeated && !bigStep) continue;
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.BIDDING_TARGET_THRASH,
          scope: campaignScope(c),
          cite: [ctx.get("A.change_count"), ctx.get("A.change_days_covered")].filter((v) =>
            isOk(v),
          ),
          entity: { id: c.id, name: c.name },
          facts: {
            target_moves: list.length,
            most_moves_in_window: busiest,
            largest_move_pct: Number(largest.toFixed(1)),
            moves_allowed_in_window: targetMovesMax,
            move_window_days: targetMoveWindowDays,
            move_bar_pct: targetMoveMinPct,
            first_move: list[0]!.date,
            last_move: list[list.length - 1]!.date,
          },
          population: live.length,
          rows: list.map((x) => ({
            entity: { id: `${c.id}:${x.date}:${x.field}`, name: x.date },
            cells: { from: x.from, to: x.to, change_pct: Number(x.pct.toFixed(1)) },
          })),
          note: `${list.length} target move(s) read from the change history's before/after values; ${capNote}`,
        }),
      );
    }
    if (findings.length > 0) {
      if (sharedText) for (const f of findings) f.limitedBy = [`${sharedText}.`];
      return { state: "fires", findings };
    }
    if (live.length === 0 && sharedText)
      return {
        state: "not_checkable",
        reason: sharedText,
        table: "change_history",
        category: "google_withholds",
      };
    return {
      state: "none_found",
      population: live.length,
      note: `no live campaign moved its bid target more than ${targetMovesMax} times in ${targetMoveWindowDays} days or by more than ${targetMoveMinPct}% at once (${capNote})${sharedText ? `; ${sharedText}` : ""}`,
    };
  },
});

// ---------------------------------------------------------------------------
// SK24 — campaign CTR below its channel bar
// ---------------------------------------------------------------------------

const SK24_TABLES: string[] = ["campaigns"];
const SK24 = defineCheck({
  id: "SK24",
  claimKey: CLAIM_KEYS.CAMPAIGN_CTR_BELOW_BENCHMARK,
  title: "campaign CTR below its channel bar",
  clientLabel: "Shopping and brand campaigns with a low click-through rate",
  group: "search",
  metrics: ["C.ctr", "C.impr", "C.clicks"],
  confounders: ["SK02", "SK14", "SK17", "SL05", "MI01"],
  requires: SK24_TABLES,
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Each Shopping and brand Search campaign clears its click-through bar.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, SK24_TABLES);
    if (gate) return gate;
    const { shoppingCtrMinPct, brandSearchCtrMinPct, ctrMinImpressions } = ctx.settings.search;

    const findings: CheckFinding[] = [];
    let population = 0;
    let belowRateFloor = 0;
    for (const c of campaignsOf(ctx)) {
      const isShopping = c.attrs.type === "SHOPPING";
      const isBrandedSearch = c.attrs.type === "SEARCH" && c.attrs.isBrand;
      if (!isShopping && !isBrandedSearch) continue;
      const impr = num(ctx.get("C.impr", { campaignId: c.id }));
      if (impr == null || impr < ctrMinImpressions) continue;
      const ctr = ctx.get("C.ctr", { campaignId: c.id });
      const ctrValue = num(ctr);
      if (ctrValue == null) {
        belowRateFloor += 1; // C.ctr's own click floor
        continue;
      }
      population += 1;
      const ctrPct = ctrValue * 100;
      const bar = isShopping ? shoppingCtrMinPct : brandSearchCtrMinPct;
      if (ctrPct >= bar) continue;
      const clicks = ctx.get("C.clicks", { campaignId: c.id });
      const imprValue = ctx.get("C.impr", { campaignId: c.id });
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.CAMPAIGN_CTR_BELOW_BENCHMARK,
          scope: campaignScope(c),
          cite: [ctr, clicks, imprValue].filter((v) => isOk(v)),
          entity: { id: c.id, name: c.name },
          facts: {
            ctr_pct: ctrPct,
            bar_pct: bar,
            channel: isShopping ? "SHOPPING" : "BRANDED_SEARCH",
          },
          population,
          note: "an absolute channel bar (a setting), printed beside the account's own numbers",
        }),
      );
    }
    if (population === 0) {
      return {
        state: "not_checkable",
        reason: `no Shopping or brand Search campaign clears ${ctrMinImpressions} impressions with a computable click-through rate`,
        table: "campaigns",
        category: "not_present",
      };
    }
    return findings.length
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note: belowRateFloor
            ? `${belowRateFloor} campaign(s) cleared the impression floor but not the click floor for a rate`
            : undefined,
        };
  },
});

// ---------------------------------------------------------------------------
// SK25 — keywords per ad group
// ---------------------------------------------------------------------------

const SK25_TABLES: string[] = ["keywords"];
const SK25 = defineCheck({
  id: "SK25",
  claimKey: CLAIM_KEYS.AD_GROUP_TOO_MANY_KEYWORDS,
  title: "ad group carries too many keywords",
  clientLabel: "ad groups with too many keywords",
  group: "search",
  metrics: ["G.keyword_count"],
  confounders: ["SK03", "SK04"],
  requires: SK25_TABLES,
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No ad group carries more keywords than the bar.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, SK25_TABLES);
    if (gate) return gate;
    const { maxKeywordsPerAdGroup } = ctx.settings.search;
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of campaignsOf(ctx)) {
      for (const g of c.children.adGroups) {
        const count = ctx.get("G.keyword_count", { adGroupId: g.id });
        const n = num(count);
        if (n == null) continue;
        population += 1;
        if (n <= maxKeywordsPerAdGroup) continue;
        findings.push(
          finding({
            claimKey: CLAIM_KEYS.AD_GROUP_TOO_MANY_KEYWORDS,
            scope: {
              type: "ad_group",
              id: g.id,
              name: g.name,
              campaignId: c.id,
              campaignName: c.name,
            },
            cite: [count],
            entity: { id: g.id, name: g.name },
            facts: { keyword_count: n, bar: maxKeywordsPerAdGroup },
            population,
          }),
        );
      }
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no ad group carries a keyword count",
        table: "keywords",
        category: "not_present",
      };
    return findings.length ? { state: "fires", findings } : { state: "none_found", population };
  },
});

// ---------------------------------------------------------------------------
// SL09 — mobile earns below desktop, at both scopes. B17: a lower conversion rate is
// no fault when mobile's orders are worth more per dollar (a live shop: 2.4% against 5.6%, but
// $3.14 against $2.67 per $1). With conversion values the two returns per dollar are
// compared; without, the two costs per sale. The conversion rates stay as facts.
// ---------------------------------------------------------------------------

const SL09_TABLES: string[] = ["deviceData"];
const SL09 = defineCheck({
  id: "SL09",
  claimKey: CLAIM_KEYS.DEVICE_MOBILE_RETURN_BELOW_DESKTOP,
  title: "mobile earns far below desktop per dollar",
  clientLabel: "phones earning far less per dollar than computers",
  group: "slices",
  metrics: ["SL.device(scope)"],
  confounders: ["BB09", "SL05", "MI01", "SK20"],
  requires: SL09_TABLES,
  impactFormula: "IMP_CPA_GAP",
  noneFoundMeans: "Mobile earns in line with desktop per dollar, at campaign and account level.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, SL09_TABLES);
    if (gate) return gate;
    const { mobileCvrShare, deviceCvrMinClicks } = ctx.settings.slices;

    const findings: CheckFinding[] = [];
    let population = 0;
    const judge = (scope: CheckScope, args: Record<string, unknown>): void => {
      const mobile = ctx.get("SL.device(scope)", { ...args, key: "MOBILE" });
      const desktop = ctx.get("SL.device(scope)", { ...args, key: "DESKTOP" });
      const mClicks = clicksOf(mobile);
      const dClicks = clicksOf(desktop);
      if (mClicks == null || dClicks == null) return;
      if (mClicks < deviceCvrMinClicks || dClicks < deviceCvrMinClicks) return;
      const mCvr = cvrOf(mobile);
      const dCvr = cvrOf(desktop);
      if (mCvr == null || dCvr == null) return;
      const mCost = fieldOf(mobile, "cost");
      const dCost = fieldOf(desktop, "cost");
      const mConv = fieldOf(mobile, "conv");
      const dConv = fieldOf(desktop, "conv");
      const mValue = fieldOf(mobile, "value") ?? 0;
      const dValue = fieldOf(desktop, "value") ?? 0;
      if (mCost == null || dCost == null || mConv == null || dConv == null) return;
      if (mCost <= 0 || dCost <= 0 || dConv <= 0) return;
      // value present -> return per dollar; else cost per sale (mobile with no sale = 0)
      const byValue = mValue + dValue > 0;
      let ratio: number;
      let compared: Record<string, number | string | null>;
      if (byValue) {
        const mRoas = mValue / mCost;
        const dRoas = dValue / dCost;
        if (dRoas <= 0) return;
        ratio = mRoas / dRoas;
        compared = { compared_on: "return per dollar", mobile_roas: mRoas, desktop_roas: dRoas };
      } else {
        const mCpa = mConv > 0 ? mCost / mConv : null;
        const dCpa = dCost / dConv;
        ratio = mCpa == null ? 0 : dCpa / mCpa;
        compared = { compared_on: "cost per sale", mobile_cpa: mCpa, desktop_cpa: dCpa };
      }
      population += 1;
      if (ratio >= mobileCvrShare) return;
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.DEVICE_MOBILE_RETURN_BELOW_DESKTOP,
          scope,
          cite: [mobile, desktop],
          facts: {
            ...compared,
            ratio,
            bar: mobileCvrShare,
            // the conversion rates are context, not the verdict
            mobile_cvr_pct: mCvr * 100,
            desktop_cvr_pct: dCvr * 100,
            mobile_clicks: mClicks,
            desktop_clicks: dClicks,
          },
          population,
          note: "computed at both scopes; the scope named here is the one the claim is about",
        }),
      );
    };

    judge(accountScope(), { scope: "account" });
    for (const c of campaignsOf(ctx))
      judge(campaignScope(c), { scope: "campaign", campaignId: c.id });

    if (population === 0) {
      return {
        state: "insufficient_data",
        reason: `no scope has ${deviceCvrMinClicks} clicks, spend and a desktop sale on BOTH mobile and desktop`,
      };
    }
    return findings.length ? { state: "fires", findings } : { state: "none_found", population };
  },
});

// ---------------------------------------------------------------------------
// PX13 — asset group with too few images, or images below the minimum size
// ---------------------------------------------------------------------------

/** The images' own spend; null when any of them has none reported. */
function assetSpend90(
  assets: ReadonlyArray<{ windows: { m90: { cost: number | null } } }>,
): number | null {
  let total = 0;
  for (const a of assets) {
    const c = a.windows.m90.cost;
    if (c == null || !Number.isFinite(c)) return null;
    total += c;
  }
  return total;
}

const PX13_TABLES: string[] = ["pmaxAssets", "assetGroups"];
/** Round 5: PX13's title says what it found (a full set with images too small is not "too few"). */
export const px13Title = (tooFew: boolean, tooSmall: number): string =>
  tooFew && tooSmall > 0
    ? `asset group has too few images, and ${tooSmall === 1 ? "one is" : "some are"} below the minimum size`
    : tooFew
      ? "asset group has fewer images than recommended"
      : `asset group has ${tooSmall === 1 ? "an image" : `${tooSmall} images`} below the minimum size`;
const PX13 = defineCheck({
  id: "PX13",
  claimKey: CLAIM_KEYS.PMAX_IMAGE_COVERAGE_BELOW_SPEC,
  title: "asset group has too few images, or images below the minimum size",
  clientLabel: "Performance Max asset groups with too few or too small images",
  group: "pmax",
  metrics: ["P.ag_asset_count(field)"],
  confounders: ["PX03", "PX09"],
  requires: PX13_TABLES,
  needsCompleteData: ["pmaxAssets"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans:
    "Each asset group has the recommended number of images, none below the minimum size.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, PX13_TABLES);
    if (gate) return gate;
    const { minImagesPerGroup, minImagePx } = ctx.settings.pmax;

    const findings: CheckFinding[] = [];
    let population = 0;
    let feedOnlyExempt = 0;
    let unknown = 0;
    let dimensionsUnknown = 0;

    for (const c of campaignsOf(ctx)) {
      for (const g of c.children.assetGroups) {
        // zero asset rows = unknown, never "0 images"
        if (!g.attrs.assetsKnown) {
          unknown += 1;
          continue;
        }
        // a feed-only group is meant to have no uploaded images
        if (g.attrs.isFeedOnly) {
          feedOnlyExempt += 1;
          continue;
        }
        population += 1;
        const counts = IMAGE_FIELD_TYPES.map((field) =>
          ctx.get("P.ag_asset_count(field)", { assetGroupId: g.id, field }),
        );
        const images = counts.reduce((s, v) => s + (num(v) ?? 0), 0);
        const imageAssets = g.children.assets.filter((a) =>
          IMAGE_FIELD_TYPES.includes(
            (a.attrs.fieldType ?? "") as (typeof IMAGE_FIELD_TYPES)[number],
          ),
        );
        if (imageAssets.some((a) => a.attrs.imageWidthPx == null || a.attrs.imageHeightPx == null))
          dimensionsUnknown += 1;
        const undersized = imageAssets.filter(
          (a) =>
            a.attrs.imageWidthPx != null &&
            a.attrs.imageHeightPx != null &&
            (a.attrs.imageWidthPx < minImagePx || a.attrs.imageHeightPx < minImagePx),
        );
        if (images >= minImagesPerGroup && undersized.length === 0) continue;
        // a full set with only some images too small is about THOSE images, weighed by their own spend
        const onlyUndersized = images >= minImagesPerGroup;
        const imageSpend = onlyUndersized ? assetSpend90(undersized) : null;
        const accountSpend = ctx.model.windows.m90.cost ?? 0;
        const smallShare =
          imageSpend != null &&
          accountSpend > 0 &&
          imageSpend / accountSpend < PX13_SMALL_IMAGE_SHARE;
        findings.push({
          title: px13Title(!onlyUndersized, undersized.length),
          ...(onlyUndersized
            ? imageSpend == null
              ? { maxSeverity: "info" as const, openItems: [PX13_IMAGE_SPEND_UNKNOWN] }
              : smallShare
                ? { maxSeverity: "info" as const }
                : {}
            : {}),
          ...finding({
            claimKey: CLAIM_KEYS.PMAX_IMAGE_COVERAGE_BELOW_SPEC,
            scope: {
              type: "asset_group",
              id: g.id,
              name: g.name,
              campaignId: c.id,
              campaignName: c.name,
              ...(onlyUndersized ? { sizedByAssetIds: undersized.map((a) => a.id) } : {}),
            },
            cite: counts.filter((v) => isOk(v)),
            entity: { id: g.id, name: g.name },
            facts: {
              images,
              bar: minImagesPerGroup,
              below_minimum_size: undersized.length,
              minimum_px: minImagePx,
            },
            population,
            note: "the size leg is only asserted where Google returned the image dimensions; feed-only asset groups are exempt",
          }),
        });
      }
    }
    if (population === 0) {
      const d = unknown > 0 ? `; ${unknown} not checkable — ${assetsUnknownReason()}` : "";
      return {
        state: "not_checkable",
        reason: `no asset group with uploaded assets exists (${feedOnlyExempt} feed-only groups are exempt by design${d})`,
        table: "assetGroups",
        category: "not_present",
      };
    }
    return findings.length
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note: `${feedOnlyExempt} feed-only groups exempt${unknown > 0 ? `; ${unknown} not checkable — ${assetsUnknownReason()}` : ""}; dimensions unknown on ${dimensionsUnknown}`,
        };
  },
});

// ---------------------------------------------------------------------------
// Shopping carried-in checks (SH13-SH21) and VD07
// ---------------------------------------------------------------------------

/** A finding about a SET of products: the scope names the set, never one row. */
const productSetScope = (n: number, total: number): CheckScope => ({
  type: "product",
  id: null,
  name: `${n} of ${total} products`,
});

const campaignsOfType = (ctx: CheckCtx, type: CampaignNode["attrs"]["type"]): CampaignNode[] =>
  campaignsOf(ctx).filter((c) => c.attrs.type === type);

/** Highest-spending product of a set: the witness a set finding cites. */
const topSpender = (ps: readonly ProductNode[]): ProductNode | null =>
  ps.reduce<ProductNode | null>(
    (best, p) =>
      best == null || (p.windows.m90.cost ?? 0) > (best.windows.m90.cost ?? 0) ? p : best,
    null,
  );

/** Google's longest product title. */
const TITLE_MAX_CHARS = 150;

/**
 * Title order: product type and key attributes first, the brand last or in the
 * middle. Brand first is right only on a separate brand feed, recognised here by
 * an offer id ending "-brand" or a "brand-feed" custom label.
 */
const BRAND_FEED_ID_SUFFIX = "-brand";
const BRAND_FEED_LABEL = "brand-feed";
export const TITLE_ORDER_NOTE =
  "put the product type and key attributes first, brand last or in the middle";

export function onBrandFeed(p: ProductNode): boolean {
  return (
    p.attrs.productId.endsWith(BRAND_FEED_ID_SUFFIX) ||
    p.attrs.customLabels.some((l) => (l ?? "").trim().toLowerCase() === BRAND_FEED_LABEL)
  );
}

/** The title's first words are the brand attribute (folded, whole words). */
export function titleStartsWithBrand(p: ProductNode): boolean {
  const brand = foldBrandText(p.attrs.brand ?? "").trim();
  const title = foldBrandText(p.attrs.title ?? "").trim();
  if (!brand || !title) return false;
  return title === brand || title.startsWith(`${brand} `);
}

// SH13 — title length and shape

const SH13_TABLES: string[] = ["products"];
const SH13 = defineCheck({
  id: "SH13",
  claimKey: CLAIM_KEYS.PRODUCT_TITLE_STRUCTURE_WEAK,
  title: "product titles waste the allowance or miss the shape",
  clientLabel: "product titles that are short or miss the product type and size",
  group: "shopping",
  metrics: ["DQ.population[table]", "Pr.spend", "Pr.missing_attrs"],
  confounders: ["SH06", "SH15"],
  requires: SH13_TABLES,
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Titles use the available length and carry the product type and key attributes.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, SH13_TABLES);
    if (gate) return gate;
    if (feedProducts(ctx).length === 0) return NO_PRODUCTS;
    const withLength = ctx.model.children.products.filter((p) => p.attrs.titleLength != null);
    if (withLength.length === 0)
      return { state: "not_checkable", reason: "no product carries a title", table: "products" };
    // brand-feed rows are built brand-first for brand searches: never judged
    const brandFeedRows = withLength.filter(onBrandFeed);
    // size is a Merchant Center attribute: a product outside a Merchant Center read would
    // always "miss the size", so it is not judged at all
    const notRead = withLength.filter((p) => !onBrandFeed(p) && outsideMerchantCenterRead(p));
    const judged = withLength.filter((p) => !onBrandFeed(p) && !outsideMerchantCenterRead(p));
    if (judged.length === 0)
      return notRead.length > 0
        ? {
            state: "not_checkable",
            reason:
              "the product size is a Merchant Center attribute the Google Ads API does not return, so the title shape (type, attributes, size) cannot be judged",
            table: "products",
            category: "google_withholds",
          }
        : { state: "none_found", population: 0 };
    const shortBar = ctx.settings.shopping.titleShortChars;
    const short = judged.filter((p) => (p.attrs.titleLength ?? 0) < shortBar);
    const missingShape = judged.filter(
      (p) => !p.attrs.brand || !p.attrs.productType || !p.attrs.size,
    );
    const affected = [...new Set([...short, ...missingShape])];
    const avgLength = judged.reduce((s, p) => s + (p.attrs.titleLength ?? 0), 0) / judged.length;
    // a brand-first title on a normal feed is a mark on its row, never what makes this fire
    const brandFirst = new Set(judged.filter(titleStartsWithBrand));
    const unreadNote =
      notRead.length > 0
        ? `${notRead.length} of ${notRead.length + judged.length} titled products were outside the Merchant Center read, so this is a sample of the catalogue`
        : undefined;
    if (affected.length === 0)
      return {
        state: "none_found",
        population: judged.length,
        ...(unreadNote ? { note: unreadNote } : {}),
      };
    const witness = topSpender(affected);
    const cite: MetricValue[] = [ctx.get("DQ.population[table]", { table: "products" })];
    if (witness) {
      cite.push(ctx.get("Pr.spend", { productId: witness.id }));
      cite.push(ctx.get("Pr.missing_attrs", { productId: witness.id }));
    }
    const limit = merchantCenterLimit(
      notRead.length,
      notRead.length + judged.length,
      "titles and sizes",
    );
    return {
      state: "fires",
      findings: [
        {
          ...(limit.length > 0 ? { limitedBy: limit } : {}),
          ...finding({
            claimKey: CLAIM_KEYS.PRODUCT_TITLE_STRUCTURE_WEAK,
            scope: productSetScope(affected.length, judged.length),
            cite: cite.filter((v) => isOk(v)),
            facts: {
              products_with_title_length: judged.length,
              avg_title_length: avgLength,
              allowance: TITLE_MAX_CHARS,
              shorter_than_bar: short.length,
              short_bar_chars: shortBar,
              missing_brand_type_or_size: missingShape.length,
              ...(brandFirst.size > 0 ? { brand_first_titles: brandFirst.size } : {}),
              ...(brandFeedRows.length > 0 ? { brand_feed_rows: brandFeedRows.length } : {}),
              outside_merchant_center_read: notRead.length,
            },
            population: judged.length,
            rows: productRows(affected, (p) => ({
              title_length: p.attrs.titleLength ?? 0,
              spend: p.windows.m90.cost ?? 0,
              missing:
                [
                  !p.attrs.brand ? "brand" : null,
                  !p.attrs.productType ? "type" : null,
                  !p.attrs.size ? "size" : null,
                ]
                  .filter(Boolean)
                  .join(", ") || "nothing",
              ...(brandFirst.has(p) ? { title_order: `brand first: ${TITLE_ORDER_NOTE}` } : {}),
            })),
          }),
        },
      ],
    };
  },
});

// SH14 — custom labels

/**
 * Custom labels are read with Google Ads' product list (shopping_product, the
 * linked feed as Google Ads sees it). A product row with no product-list row
 * beside it has unread labels: it is not judged, never "unlabelled".
 */
const labelsRead = (p: ProductNode): boolean =>
  p.attrs.primarySource === "products" && p.attrs.shopping != null;

const SH14_TABLES: string[] = ["products", "shoppingProductsData"];
const SH14 = defineCheck({
  id: "SH14",
  claimKey: CLAIM_KEYS.PRODUCT_CUSTOM_LABELS_MISSING,
  title: "catalogue cannot be segmented — custom labels unset",
  clientLabel: "products with no custom label to group them by",
  group: "shopping",
  metrics: ["DQ.population[table]", "Pr.spend"],
  confounders: ["SH06", "SH15"],
  requires: SH14_TABLES,
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Products carry custom labels for segmentation.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, SH14_TABLES);
    if (gate) return gate;
    const all = feedProducts(ctx);
    if (all.length === 0) return NO_PRODUCTS;
    const products = all.filter(labelsRead);
    const unread = all.length - products.length;
    if (products.length === 0)
      return {
        state: "not_checkable",
        reason: `the custom labels of none of the ${all.length} products were read`,
        table: "shoppingProductsData",
        category: "our_gap",
      };
    const unlabelled = products.filter((p) => !p.attrs.customLabels.some((l) => (l ?? "") !== ""));
    const share = unlabelled.length / products.length;
    const bar = ctx.settings.shopping.unlabelledMaxShare;
    if (share <= bar)
      return {
        state: "none_found",
        population: products.length,
        ...(unread > 0
          ? { note: `${unread} of ${all.length} products had no labels read, so this is a sample` }
          : {}),
      };
    const witness = topSpender(unlabelled);
    const cite: MetricValue[] = [ctx.get("DQ.population[table]", { table: "products" })];
    if (witness) cite.push(ctx.get("Pr.spend", { productId: witness.id }));
    return {
      state: "fires",
      findings: [
        {
          ...(unread > 0
            ? {
                limitedBy: [
                  `${unread} of the ${all.length} products had no labels read, so they are not counted here.`,
                ],
              }
            : {}),
          ...finding({
            claimKey: CLAIM_KEYS.PRODUCT_CUSTOM_LABELS_MISSING,
            scope: productSetScope(unlabelled.length, products.length),
            cite: cite.filter((v) => isOk(v)),
            facts: {
              unlabelled: unlabelled.length,
              labelled: products.length - unlabelled.length,
              total: products.length,
              unlabelled_share_pct: share * 100,
              bar_share_pct: bar * 100,
            },
            population: products.length,
            rows: productRows(unlabelled, (p) => ({ spend: p.windows.m90.cost ?? 0 })),
          }),
        },
      ],
    };
  },
});

// SH15 — the feed sources disagree (needs Merchant Center feed diagnostics)

const SH15_TABLES: string[] = ["feedDiagnostics", "products", "shoppingProductsData"];
const SH15 = defineCheck({
  id: "SH15",
  claimKey: CLAIM_KEYS.FEED_SOURCE_DISAGREEMENT,
  title: "feed health sources contradict each other",
  clientLabel: "whether the feed health numbers agree with each other",
  group: "shopping",
  selfAudit:
    "the feed health numbers we read disagree with each other, so we will not report a feed health number from them",
  metrics: ["F.feed_valid_rate", "DQ.population[table]"],
  confounders: [],
  requires: SH15_TABLES,
  impactFormula: "IMP_NONE",
  noneFoundMeans: "The feed sources agree on feed health.",
  run(ctx: CheckCtx): CheckResult {
    const gate = merchantCenterGate(ctx, SH15_TABLES);
    if (gate) return gate;
    const feeds = ctx.model.attrs.merchantCenter.feeds;
    const products = ctx.model.children.products;
    const approved = products.filter(
      (p) => (p.attrs.mcStatus ?? "").toLowerCase() === "approved",
    ).length;
    const withStatus = products.filter((p) => p.attrs.mcStatus != null).length;
    const eligible = products.filter((p) => (p.attrs.shopping?.status ?? "") === "ELIGIBLE").length;
    const withShoppingStatus = products.filter((p) => p.attrs.shopping?.status != null).length;
    const sourcesWithRows = [
      feeds.itemsTotal != null && feeds.itemsTotal > 0,
      withStatus > 0,
      withShoppingStatus > 0,
    ].filter(Boolean).length;
    if (sourcesWithRows < 2)
      return {
        state: "not_checkable",
        reason: `only ${sourcesWithRows} of the three feed sources has rows, so they cannot be compared`,
        table: "feedDiagnostics",
      };
    const validRate = ctx.get("F.feed_valid_rate");
    const rate = num(validRate);
    const diagnosticsSaysNoneValid = rate != null && rate === 0 && (feeds.itemsTotal ?? 0) > 0;
    const disagree = diagnosticsSaysNoneValid && (approved > 0 || eligible > 0);
    if (!disagree) return { state: "none_found", population: products.length };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.FEED_SOURCE_DISAGREEMENT,
          scope: accountScope(),
          cite: [validRate, ctx.get("DQ.population[table]", { table: "products" })].filter((v) =>
            isOk(v),
          ),
          facts: {
            feed_items_total: feeds.itemsTotal,
            feed_items_invalid: feeds.itemsInvalid,
            feed_valid_rate_pct: rate,
            products_approved: approved,
            products_with_status: withStatus,
            shopping_products_eligible: eligible,
            shopping_products_with_status: withShoppingStatus,
          },
          population: products.length,
        }),
      ],
    };
  },
});

// SH17 — each Shopping campaign's priority and product filter are known

const SH17_TABLES: string[] = ["campaigns", "shoppingSettings"];
const SH17 = defineCheck({
  id: "SH17",
  claimKey: CLAIM_KEYS.SHOPPING_PRIORITY_AND_FILTER_UNKNOWN,
  title: "Shopping campaign priority / product filter not resolvable",
  clientLabel: "which products each Shopping campaign can sell, and at what priority",
  group: "shopping",
  selfAudit:
    "the priority setting or the feed label of a Shopping campaign was not read, so which one wins when two overlap cannot be told",
  metrics: ["Sh.campaign_priority", "Sh.feed_label"],
  confounders: [],
  requires: SH17_TABLES,
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Each Shopping campaign's priority and product filter are known.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, SH17_TABLES);
    if (gate) return gate;
    const shopping = campaignsOfType(ctx, "SHOPPING");
    if (shopping.length === 0)
      return {
        state: "not_checkable",
        reason: "no Shopping campaign on this account",
        table: "campaigns",
        category: "not_present",
      };
    const unresolved = shopping.filter((c) => c.attrs.shoppingSettings.state !== "synced");
    if (unresolved.length > 0)
      return {
        state: "not_checkable",
        reason: `the Shopping settings of ${unresolved.length} of ${shopping.length} Shopping campaigns were not read, so their priority and product filter are unknown`,
        table: "shoppingSettings",
        category: "our_gap",
      };
    return { state: "none_found", population: shopping.length };
  },
});

// SH18 — product quadrant (context for SH04 / SH05, never a finding)

const SH18_TABLES: string[] = ["products"];
const SH18 = defineCheck({
  id: "SH18",
  claimKey: CLAIM_KEYS.PRODUCT_QUADRANT,
  title: "product quadrant (context for SH04 / SH05)",
  clientLabel: "products sorted by spend and return",
  group: "shopping",
  metrics: ["Pr.spend", "Pr.roas", "A.roas", "T.waste_floor", "F.conv_min_for_verdict"],
  confounders: ["SH15", "SH01", "MI01", "MI04"],
  requires: SH18_TABLES,
  impactFormula: "IMP_NONE",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, SH18_TABLES);
    if (gate) return gate;
    const floors = ctx.get("F.conv_min_for_verdict");
    const moderate =
      isOk(floors) &&
      typeof floors.value === "object" &&
      floors.value != null &&
      !Array.isArray(floors.value)
        ? Number((floors.value as Record<string, unknown>).moderate ?? NaN)
        : NaN;
    const wasteFloor = num(ctx.get("T.waste_floor"));
    const accountRoas = num(ctx.get("A.roas"));
    if (!Number.isFinite(moderate) || wasteFloor == null || accountRoas == null)
      return {
        state: "not_checkable",
        reason:
          "sorting products needs the account's overall return, a minimum spend and a minimum number of conversions, and one of them could not be worked out from this data",
        table: "products",
      };
    const spending = ctx.model.children.products.filter((p) => (p.windows.m90.cost ?? 0) > 0);
    if (spending.length === 0) return NO_PRODUCTS;
    const aboveFloor = spending.filter((p) => (p.windows.m90.conv ?? 0) >= moderate);
    // the return axis is only stated above the conversion floor; below it there is no verdict
    const quadrant = (p: ProductNode): string => {
      const highSpend = (p.windows.m90.cost ?? 0) >= wasteFloor;
      const good = (p.windows.m90.roas ?? 0) >= accountRoas;
      return good
        ? highSpend
          ? "high spend / above-average return"
          : "low spend / above-average return"
        : highSpend
          ? "high spend / below-average return"
          : "low spend / below-average return";
    };
    const counts = aboveFloor.reduce<Record<string, number>>((m, p) => {
      const q = quadrant(p);
      m[q] = (m[q] ?? 0) + 1;
      return m;
    }, {});
    return {
      state: "insufficient_data",
      reason: `context, never a finding: ${aboveFloor.length} of ${spending.length} spending products have enough conversions to place; spend against ${wasteFloor} and return against the account's ${accountRoas.toFixed(2)}x: ${
        Object.entries(counts)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ") || "none placed"
      }`,
    };
  },
});

// SH19 — an included product that never served

const SH19_TABLES: string[] = ["products", "pmaxListingGroups"];
const SH19 = defineCheck({
  id: "SH19",
  claimKey: CLAIM_KEYS.PRODUCT_ZERO_IMPRESSIONS,
  title: "included product never served",
  clientLabel: "feed products that never served",
  notCheckableCategory: "our_gap",
  group: "shopping",
  metrics: ["Pr.catalog_never_served", "DQ.population[table]", "Y.truncated[table]", "Pr.spend"],
  confounders: ["SH15", "SH01", "PX05"],
  requires: SH19_TABLES,
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Each included product got at least one impression.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, SH19_TABLES);
    if (gate) return gate;
    // the whole product list walked through the listing trees
    const catalog = ctx.model.attrs.merchantCenter.productCatalog;
    if (catalog != null && catalog.rows === 0) return NO_PRODUCTS;
    if (catalog != null) {
      // a running product selection that splits on product type, category, condition or
      // channel cannot be matched to products exactly: which products it includes is unknown
      const inexact = campaignsOf(ctx)
        .flatMap((c) => liveAssetGroupsOf(c))
        .filter((g) => catalog.pmaxGroups?.byGroup[g.id]?.resolved === false);
      if (inexact.length > 0)
        return {
          state: "not_checkable",
          reason: `the product selection of ${inexact.length} running asset group(s) splits on product type, category, condition or channel, which cannot be matched to products exactly`,
          table: "pmaxListingGroups",
          category: "our_gap",
        };
      if (catalog.truncated)
        return {
          state: "not_checkable",
          reason: `the product list was cut at its row limit (${catalog.rows} products read), so a product that never served may sit past it`,
          table: "products_catalog",
          category: "incomplete_data",
        };
      if (catalog.included === 0)
        return {
          state: "not_checkable",
          reason: "no product sits in an included listing group of a running asset group",
          table: "pmaxListingGroups",
          category: "not_present",
        };
      const v = ctx.get("Pr.catalog_never_served");
      if (!isOk(v))
        return {
          state: "not_checkable",
          reason: v.detail ?? "the product list could not be judged",
          table: "products",
        };
      if (catalog.includedNeverServed === 0)
        return {
          state: "none_found",
          population: catalog.included,
          note: `${catalog.included} of ${catalog.rows} products sit in an included listing group; every one had impressions`,
        };
      return {
        state: "fires",
        findings: [
          finding({
            claimKey: CLAIM_KEYS.PRODUCT_ZERO_IMPRESSIONS,
            scope: productSetScope(catalog.includedNeverServed, catalog.included),
            cite: [v],
            facts: {
              silent_products: catalog.includedNeverServed,
              included_products: catalog.included,
              catalogue_rows: catalog.rows,
            },
            population: catalog.included,
            rows: catalog.examples.slice(0, 10).map((id) => {
              const p = ctx.model.index.productsById.get(id);
              return {
                entity: { id, name: p?.attrs.title ?? id },
                cells: { status: statusCell(p) },
              };
            }),
          }),
        ],
      };
    }
    // no product list: the product rows are the clicked ones, so a product with no impression
    // cannot be among them when they were cut at a limit
    const truncated = ctx.get("Y.truncated[table]", { table: "products" });
    if (isOk(truncated) && truncated.value === true)
      return {
        state: "not_checkable",
        reason:
          "the product rows are cut at their limit and ordered by spend, so a product with no impressions cannot be among them",
        table: "products",
      };
    const included = ctx.model.children.products.filter(
      (p) => p.attrs.assetGroupsIncludingMe.length > 0,
    );
    if (included.length === 0)
      return {
        state: "not_checkable",
        reason: "no product resolves into an included listing-group leaf",
        table: "pmaxListingGroups",
      };
    const silent = included.filter((p) => (p.windows.m90.impressions ?? null) === 0);
    if (silent.length === 0) return { state: "none_found", population: included.length };
    const witness = topSpender(silent);
    const cite: MetricValue[] = [ctx.get("DQ.population[table]", { table: "products" })];
    if (witness) cite.push(ctx.get("Pr.spend", { productId: witness.id }));
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.PRODUCT_ZERO_IMPRESSIONS,
          scope: productSetScope(silent.length, included.length),
          cite: cite.filter((v) => isOk(v)),
          facts: {
            silent_products: silent.length,
            included_products: included.length,
            catalogue_rows: ctx.model.children.products.length,
          },
          population: included.length,
          rows: productRows(silent, (p) => ({ status: statusCell(p) })),
        }),
      ],
    };
  },
});

// SH20 — products with clicks and no sale (the clone comparison needs item groups, not read)

const SH20_TABLES: string[] = ["products"];
const SH20 = defineCheck({
  id: "SH20",
  claimKey: CLAIM_KEYS.PRODUCT_UNDERPERFORMING_CLONE,
  title: "products get many clicks and no sale",
  clientLabel: "products with many clicks and no sale",
  group: "shopping",
  metrics: ["Pr.spend", "Pr.roas", "DQ.population[table]", "T.waste_floor"],
  confounders: ["SH15", "SH01", "PX05"],
  requires: SH20_TABLES,
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "No product gets many clicks without a sale.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, SH20_TABLES);
    if (gate) return gate;
    const products = feedProducts(ctx);
    if (products.length === 0) return NO_PRODUCTS;
    const minClicks = ctx.settings.shopping.cloneMinClicks;
    const clickedNoSale = products.filter(
      (p) => (p.windows.m90.clicks ?? 0) >= minClicks && (p.windows.m90.conv ?? 0) === 0,
    );
    // round 3: a product no live campaign can show now (tagged out of every running tree since,
    // and no live Shopping campaign sells its feed) is already out: not judged, not priced
    const alreadyOut = clickedNoSale.filter((p) => noLiveCampaignCanShow(ctx, p));
    const dead = clickedNoSale.filter((p) => !alreadyOut.includes(p));
    const outNote =
      alreadyOut.length > 0
        ? `${alreadyOut.length} product(s) with ${minClicks}+ clicks and no sale not judged, already out: no running asset group of a live Performance Max campaign can select them with their current labels and no live Shopping campaign sells their feed`
        : null;
    if (dead.length > 0) {
      const witness = topSpender(dead)!;
      // B19: priced as the sum of exactly these rows (never the account's spend). A size whose
      // parent product (sizes and colours summed) is at or over the waste bar and returns less
      // than it cost is the product waste checks' finding (SH04 / PX05), priced there
      const floor = num(ctx.get("T.waste_floor"));
      const pricedParents = new Set(
        groupByParentProduct(
          products,
          (p) => p.id,
          (p) => ({
            cost: p.windows.m90.cost ?? 0,
            conv: p.windows.m90.conv ?? 0,
            value: p.windows.m90.value ?? 0,
          }),
        )
          .filter(
            (g) => floor != null && Number.isFinite(floor) && g.cost >= floor && g.value < g.cost,
          )
          .map((g) => g.key),
      );
      // and a size whose parent SH04 / PX05 price as waste in any one campaign (its spend
      // there at or over that campaign's bar, no sale there), even when it sold in another
      const pmaxPriced = pmaxWastedParentKeys(ctx);
      const ownedElsewhere = (p: (typeof dead)[number]): boolean =>
        pricedParents.has(parentProductKey(p.id)) || pmaxPriced.has(parentProductKey(p.id));
      const priced = dead
        .filter((p) => !ownedElsewhere(p))
        .reduce((t, p) => t + (p.windows.m90.cost ?? 0), 0);
      const sample = dead.some((p) => p.sample.truncated);
      return {
        state: "fires",
        findings: [
          finding({
            claimKey: CLAIM_KEYS.PRODUCT_UNDERPERFORMING_CLONE,
            scope: productSetScope(dead.length, products.length),
            cite: [
              ctx.get("DQ.population[table]", { table: "products" }),
              ctx.get("Pr.spend", { productId: witness.id }),
            ].filter((v) => isOk(v)),
            facts: {
              products_with_clicks_no_conversions: dead.length,
              clicks_bar: minClicks,
              wasted_cost_90d: dead.reduce((s, p) => s + (p.windows.m90.cost ?? 0), 0),
              // nothing left to price is no money, never "$0"
              ...(priced > 0 ? { [ROLLUP_WASTED_COST_90D]: Number(priced.toFixed(2)) } : {}),
              ...(priced > 0 && sample ? { [ROLLUP_IS_SAMPLE]: 1 } : {}),
              priced_by_product_waste_check: dead.filter(ownedElsewhere).length,
              ...(alreadyOut.length > 0 ? { products_already_excluded: alreadyOut.length } : {}),
            },
            population: products.length,
            // priced_here: false = its spend is the product waste checks' money, not this finding's
            rows: productRows(dead, (p) => ({
              clicks: p.windows.m90.clicks ?? 0,
              spend: p.windows.m90.cost ?? 0,
              priced_here: !ownedElsewhere(p),
            })),
            note: `only the clicks leg is judged: the item group a variant belongs to is not read, so a variant cannot be compared with its group${outNote ? `; ${outNote}` : ""}`,
          }),
        ],
      };
    }
    // the check's other question (a variant against its own item group) cannot be asked
    return {
      state: "not_checkable",
      reason: `the item group a variant belongs to is not read, so a variant cannot be compared with its group; the clicks leg found no ${outNote ? "other " : ""}product of ${products.length} with ${minClicks}+ clicks and no sale${outNote ? ` (${outNote})` : ""}`,
      table: "products",
      category: "our_gap",
    };
  },
});

// SH21 — campaigns below break-even after product cost (needs the owner's margin)

/** Campaign types judged on last-click return; Demand Gen, Video and Display act earlier in the path. */
const SH21_JUDGED_TYPES: ReadonlySet<string> = new Set(["SEARCH", "SHOPPING", "PERFORMANCE_MAX"]);
export const SH21_MARGIN_ESTIMATE_NOTE =
  "The margin is the owner's rough figure, so the money lost after product cost is an estimate.";
const SH21_MARGIN_TABLES: string[] = ["campaigns"];
const SH21 = defineCheck({
  id: "SH21",
  claimKey: CLAIM_KEYS.PRODUCT_COGS_MISSING,
  title: "campaign returns below break-even after product cost",
  clientLabel: "profit after cost of goods",
  notCheckableCategory: "needs_client_data",
  group: "shopping",
  metrics: ["C.spend", "C.value", "C.roas", "T.waste_floor"],
  confounders: [],
  requires: SH21_MARGIN_TABLES,
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No campaign returns less than the break-even set by the stated margin.",
  run(ctx: CheckCtx): CheckResult {
    const margin = clientGrossMargin(ctx);
    if (!margin)
      return {
        state: "not_checkable",
        reason:
          "no gross margin was given (client context grossMarginPct) and Google Ads holds no product cost",
        category: "needs_client_data",
      };
    const marginGate = gateOnData(ctx, SH21_MARGIN_TABLES);
    if (marginGate) return marginGate;
    const floorV = ctx.get("T.waste_floor");
    const floor = num(floorV);
    if (floor == null)
      return {
        state: "not_checkable",
        reason: wasteFloorReason(floorV),
        table: "campaigns",
      };
    const tolerance = ctx.settings.shopping.breakEvenTolerance;
    const breakEven = margin.breakEvenRoas;
    const bar = breakEven * (1 - tolerance);
    const judged: Array<{
      c: CampaignNode;
      cite: MetricValue[];
      r: number;
      cost: number;
      sales: number;
      loss: number;
    }> = [];
    for (const c of campaignsOf(ctx).filter((x) => SH21_JUDGED_TYPES.has(String(x.attrs.type)))) {
      const spend = ctx.get("C.spend", { campaignId: c.id });
      const value = ctx.get("C.value", { campaignId: c.id });
      const roas = ctx.get("C.roas", { campaignId: c.id });
      const r = num(roas);
      const cost = num(spend);
      if (r == null || cost == null || cost <= 0) continue;
      const sales = num(value) ?? r * cost;
      judged.push({
        c,
        cite: [spend, value, roas, floorV].filter((v) => isOk(v)),
        r,
        cost,
        sales,
        loss: cost - sales * (margin.marginPct / 100),
      });
    }
    if (judged.length === 0)
      return {
        state: "insufficient_data",
        reason: `a ${margin.marginPct}% margin was given (break-even return ${breakEven.toFixed(2)}x), but no live Search, Shopping or Performance Max campaign has a return that can be read`,
      };
    const findings: CheckFinding[] = judged
      .filter((j) => j.r < bar && j.loss >= floor)
      .map((j) => ({
        ...finding({
          claimKey: CLAIM_KEYS.CAMPAIGN_BELOW_BREAKEVEN_AFTER_MARGIN,
          scope: campaignScope(j.c),
          cite: j.cite,
          entity: { id: j.c.id, name: j.c.name },
          facts: {
            gross_margin_pct: margin.marginPct,
            gross_margin_source: "client context (owner's estimate)",
            breakeven_roas: Number(breakEven.toFixed(2)),
            roas: Number(j.r.toFixed(2)),
            spend_90d: j.cost,
            conv_value_90d: j.sales,
            estimated_loss_after_product_cost_90d: Number(j.loss.toFixed(2)),
            waste_floor: floor,
          },
          population: judged.length,
        }),
        limitedBy: [SH21_MARGIN_ESTIMATE_NOTE],
      }));
    if (findings.length === 0)
      return {
        state: "none_found",
        population: judged.length,
        note: `none of the ${judged.length} Search / Shopping / Performance Max campaigns with a readable return is more than ${tolerance * 100}% under the ${breakEven.toFixed(2)}x break-even of the stated ${margin.marginPct}% margin with a loss of at least ${floor.toFixed(2)}`,
      };
    return { state: "fires", findings };
  },
});

// VD07 — average cost per view against the reference band

const VD07_TABLES: string[] = ["campaigns", "video_campaign_metrics"];
const VD07 = defineCheck({
  id: "VD07",
  claimKey: CLAIM_KEYS.VIDEO_CPV_OUT_OF_BAND,
  title: "cost per view outside the reference band",
  clientLabel: "cost per video view against the reference band",
  group: "video",
  metrics: ["C.impr"],
  confounders: ["VD01", "VD02", "MI06"],
  requires: VD07_TABLES,
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Cost per view sits inside the reference band.",
  run(ctx: CheckCtx): CheckResult {
    const campaignsGate = gateOnData(ctx, ["campaigns"]);
    if (campaignsGate) return campaignsGate;
    const video = campaignsOfType(ctx, "VIDEO");
    if (video.length === 0)
      return {
        state: "not_checkable",
        reason: "no Video campaign on this account",
        table: "campaigns",
        category: "not_present",
      };
    const gate = gateOnData(ctx, VD07_TABLES);
    if (gate) return gate;
    const s = ctx.settings.video;
    const low = scaleMoney(s.cpvBandMinUsd, ctx.currency);
    const high = scaleMoney(s.cpvBandMaxUsd, ctx.currency);
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of video) {
      for (const v of c.children.videoMetrics ?? []) {
        const views = v.attrs.videoViews;
        const cpv = v.attrs.avgCpv;
        if (cpv == null || views == null || views <= 0) continue;
        population++;
        if (cpv >= low && cpv <= high) continue;
        findings.push(
          finding({
            claimKey: CLAIM_KEYS.VIDEO_CPV_OUT_OF_BAND,
            scope: campaignScope(c),
            cite: [ctx.get("C.impr", { campaignId: c.id })].filter((x) => isOk(x)),
            entity: { id: c.id, name: c.name },
            facts: {
              average_cpv: cpv,
              band_low: Number(low.toFixed(4)),
              band_high: Number(high.toFixed(4)),
              side: cpv > high ? "above" : "below",
              views,
            },
            population,
          }),
        );
      }
    }
    if (population === 0)
      return {
        state: "insufficient_data",
        reason: `no Video campaign of ${video.length} had views with a cost in the window`,
      };
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

export const CARRIED_IN_CHECKS: CheckDefinition[] = [
  MI13,
  AS12,
  BB12,
  BB13,
  SK24,
  SK25,
  SL09,
  SH13,
  SH14,
  SH15,
  SH17,
  SH18,
  SH19,
  SH20,
  SH21,
  PX13,
  VD07,
];
