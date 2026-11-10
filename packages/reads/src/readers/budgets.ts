// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Ported from PerfoAds fetchCampaignBudgets + fetchBiddingStrategies. Changes: a third query
// (campaign -> budget + strategy) lists every campaign that shares a budget or a portfolio
// strategy, which a change to either touches; a failed query is reported (PerfoAds returned
// an empty list); Google's suggested-budget fields left out (not part of this product).

import * as z from "zod";
import { amount, countBy, countOr, plural, shown, unknownBecause } from "../common.js";
import {
  bool,
  byMoneyDesc,
  count,
  enumValue,
  get,
  id,
  idFromResourceName,
  money,
  numberOrNull,
  sumMoney,
  text,
  type Row,
} from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

const LinkedCampaignSchema = z.object({
  id: z.string(),
  name: UntrustedSchema,
  status: z.string().nullable(),
  biddingStrategyType: z.string().nullable(),
  portfolioStrategyId: z.string().nullable(),
  budgetId: z.string().nullable(),
  targetCpa: z.string().nullable(),
  targetRoas: z.number().nullable(),
});
export type LinkedCampaign = z.infer<typeof LinkedCampaignSchema>;

export const BudgetRowSchema = z.object({
  id: z.string(),
  name: UntrustedSchema,
  status: z.string().nullable(),
  amount: z.string().nullable().describe("Per period, account currency"),
  period: z.string().nullable(),
  deliveryMethod: z.string().nullable(),
  type: z.string().nullable(),
  shared: z.boolean(),
  referenceCount: z.number(),
  campaignCount: z.number().nullable().describe("null when the campaign list couldn't be read"),
  campaigns: z.array(LinkedCampaignSchema).describe("First 20 campaigns on this budget"),
});
export type BudgetRow = z.infer<typeof BudgetRowSchema>;

export const StrategySchema = z.object({
  id: z.string(),
  name: UntrustedSchema,
  type: z.string().nullable(),
  status: z.string().nullable(),
  targetCpa: z.string().nullable(),
  targetRoas: z.number().nullable(),
  nonRemovedCampaignCount: z.number(),
  maxCpc: z
    .string()
    .nullable()
    .describe('Highest cost per click the strategy may bid; "0" = no cap; null = this type has no cap'),
  campaignIds: z.array(z.string()).describe("First 20 campaigns on this strategy"),
});
export type Strategy = z.infer<typeof StrategySchema>;

/** Every field is null when a query it depends on couldn't be read (see parts). */
export const BudgetSummarySchema = z.object({
  budgets: z.number().nullable(),
  sharedBudgets: z.number().nullable(),
  enabledDailyBudget: z
    .string()
    .nullable()
    .describe("Sum of daily budgets used by an enabled campaign"),
  budgetsWithoutCampaigns: z.number().nullable(),
  portfolioStrategies: z.number().nullable(),
  campaignsOnPortfolio: z.number().nullable(),
  campaignsOnUnlistedStrategies: z
    .number()
    .nullable()
    .describe("Portfolio owned by a manager account; not in biddingStrategies"),
  biddingTypes: z.record(z.string(), z.number()).nullable(),
});
export type BudgetSummary = z.infer<typeof BudgetSummarySchema>;

export const BUDGETS_QUERY = `
    SELECT
      campaign_budget.id,
      campaign_budget.name,
      campaign_budget.amount_micros,
      campaign_budget.status,
      campaign_budget.delivery_method,
      campaign_budget.period,
      campaign_budget.type,
      campaign_budget.explicitly_shared,
      campaign_budget.reference_count
    FROM campaign_budget
    WHERE campaign_budget.status != 'REMOVED'`;

/** The strategy types whose settings carry a max CPC cap. */
const STRATEGY_CAP_FIELDS = [
  "target_roas",
  "target_cpa",
  "target_spend",
  "maximize_conversion_value",
  "maximize_conversions",
  "target_impression_share",
] as const;

/** A strategy's max CPC cap from its own type's settings: "0" = no cap; null = its type has no cap. */
export function strategyMaxCpc(type: string | null, at: (path: string) => unknown): string | null {
  const t = String(type ?? "").toLowerCase();
  if (!(STRATEGY_CAP_FIELDS as readonly string[]).includes(t)) return null;
  const camel = t.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  return money(at(`${camel}.cpcBidCeilingMicros`) ?? 0) ?? "0";
}

export const STRATEGIES_QUERY = `
    SELECT
      bidding_strategy.id,
      bidding_strategy.name,
      bidding_strategy.type,
      bidding_strategy.status,
      bidding_strategy.non_removed_campaign_count,
      bidding_strategy.target_cpa.target_cpa_micros,
      bidding_strategy.target_roas.target_roas,
      bidding_strategy.maximize_conversions.target_cpa_micros,
      bidding_strategy.maximize_conversion_value.target_roas,
      ${STRATEGY_CAP_FIELDS.map((f) => `bidding_strategy.${f}.cpc_bid_ceiling_micros`).join(",\n      ")}
    FROM bidding_strategy
    WHERE bidding_strategy.status != 'REMOVED'`;

export const BUDGET_CAMPAIGNS_QUERY = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.campaign_budget,
      campaign.bidding_strategy,
      campaign.bidding_strategy_type,
      campaign.maximize_conversion_value.target_roas,
      campaign.maximize_conversions.target_cpa_micros,
      campaign.target_cpa.target_cpa_micros,
      campaign.target_roas.target_roas
    FROM campaign
    WHERE campaign.status != 'REMOVED'`;

const positiveMoney = (v: unknown): string | null => {
  const m = money(v);
  return m && m !== "0" ? m : null;
};
const positive = (v: unknown): number | null => {
  const n = numberOrNull(v);
  return n !== null && n > 0 ? n : null;
};

export const mapLinkedCampaign = (row: Row): LinkedCampaign | null => {
  const campaignId = id(get(row, "campaign.id"));
  if (!campaignId) return null;
  return {
    id: campaignId,
    name: text(get(row, "campaign.name")),
    status: enumValue(get(row, "campaign.status")),
    biddingStrategyType: enumValue(get(row, "campaign.biddingStrategyType")),
    portfolioStrategyId: idFromResourceName(get(row, "campaign.biddingStrategy")),
    budgetId: idFromResourceName(get(row, "campaign.campaignBudget")),
    targetCpa:
      positiveMoney(get(row, "campaign.maximizeConversions.targetCpaMicros")) ??
      positiveMoney(get(row, "campaign.targetCpa.targetCpaMicros")),
    targetRoas:
      positive(get(row, "campaign.maximizeConversionValue.targetRoas")) ??
      positive(get(row, "campaign.targetRoas.targetRoas")),
  };
};

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

/** Embedded lists stop here (the count says how many there are). */
export const EMBEDDED_MAX = 20;
/** Most portfolio strategies returned (the summary counts all of them). */
export const STRATEGIES_SHOWN = 50;

export const budgetsReader: ReaderDef<
  null,
  BudgetRow,
  BudgetSummary,
  { biddingStrategies: Strategy[] },
  { campaigns: LinkedCampaign[]; strategyIds: string[] }
> = {
  name: "budgets_and_bidding",
  queries: () => ({
    budgets: { gaql: BUDGETS_QUERY },
    bidding_strategies: { gaql: STRATEGIES_QUERY },
    campaigns: { gaql: BUDGET_CAMPAIGNS_QUERY },
  }),
  map: (data, _input, _ctx, parts) => {
    const campaignsRead = partOk(parts, "campaigns");
    const campaigns = (data.campaigns ?? [])
      .map(mapLinkedCampaign)
      .filter((c): c is LinkedCampaign => c !== null)
      .sort(byId);
    const rows: BudgetRow[] = [];
    for (const row of data.budgets ?? []) {
      const budgetId = id(get(row, "campaignBudget.id"));
      if (!budgetId) continue;
      const b = (path: string) => get(row, `campaignBudget.${path}`);
      rows.push({
        id: budgetId,
        name: text(b("name")),
        status: enumValue(b("status")),
        amount: money(b("amountMicros")),
        period: enumValue(b("period")),
        deliveryMethod: enumValue(b("deliveryMethod")),
        type: enumValue(b("type")),
        shared: bool(b("explicitlyShared")),
        referenceCount: count(b("referenceCount")),
        campaignCount: campaignsRead
          ? campaigns.filter((c) => c.budgetId === budgetId).length
          : null,
        campaigns: campaigns.filter((c) => c.budgetId === budgetId).slice(0, EMBEDDED_MAX),
      });
    }
    const biddingStrategies: Strategy[] = [];
    for (const row of data.bidding_strategies ?? []) {
      const strategyId = id(get(row, "biddingStrategy.id"));
      if (!strategyId) continue;
      const s = (path: string) => get(row, `biddingStrategy.${path}`);
      biddingStrategies.push({
        id: strategyId,
        name: text(s("name")),
        type: enumValue(s("type")),
        status: enumValue(s("status")),
        targetCpa:
          positiveMoney(s("targetCpa.targetCpaMicros")) ??
          positiveMoney(s("maximizeConversions.targetCpaMicros")),
        targetRoas:
          positive(s("targetRoas.targetRoas")) ?? positive(s("maximizeConversionValue.targetRoas")),
        nonRemovedCampaignCount: count(s("nonRemovedCampaignCount")),
        maxCpc: strategyMaxCpc(enumValue(s("type")), s),
        campaignIds: campaigns
          .filter((c) => c.portfolioStrategyId === strategyId)
          .slice(0, EMBEDDED_MAX)
          .map((c) => c.id),
      });
    }
    biddingStrategies.sort(byId);
    return {
      rows,
      extra: { biddingStrategies: biddingStrategies.slice(0, STRATEGIES_SHOWN) },
      facts: { campaigns, strategyIds: biddingStrategies.map((x) => x.id) },
    };
  },
  compare: (a, b) => byMoneyDesc(a.amount ?? "0", b.amount ?? "0") || byId(a, b),
  summarise: (rows, _extra, _ctx, _input, parts, facts) => {
    const budgetsOk = partOk(parts, "budgets");
    const campaignsOk = partOk(parts, "campaigns");
    const strategiesOk = partOk(parts, "bidding_strategies");
    const campaigns = facts?.campaigns ?? [];
    const listed = new Set(facts?.strategyIds ?? []);
    const onPortfolio = campaigns.filter((c) => c.portfolioStrategyId !== null);
    const enabledBudgets = new Set(
      campaigns.filter((c) => c.status === "ENABLED").map((c) => c.budgetId),
    );
    const used = new Set(campaigns.map((c) => c.budgetId));
    const both = budgetsOk && campaignsOk;
    return {
      budgets: budgetsOk ? rows.length : null,
      sharedBudgets: budgetsOk ? rows.filter((r) => r.shared).length : null,
      enabledDailyBudget: both
        ? sumMoney(
            rows
              .filter((r) => r.period === "DAILY" && r.amount !== null && enabledBudgets.has(r.id))
              .map((r) => r.amount ?? "0"),
          )
        : null,
      budgetsWithoutCampaigns: both ? rows.filter((r) => !used.has(r.id)).length : null,
      portfolioStrategies: strategiesOk ? listed.size : null,
      campaignsOnPortfolio: campaignsOk ? onPortfolio.length : null,
      campaignsOnUnlistedStrategies:
        campaignsOk && strategiesOk
          ? onPortfolio.filter(
              (c) => c.portfolioStrategyId !== null && !listed.has(c.portfolioStrategyId),
            ).length
          : null,
      biddingTypes: campaignsOk ? countBy(campaigns, (c) => c.biddingStrategyType) : null,
    };
  },
  summaryLine: (s, ctx) =>
    `${countOr(s.budgets, "budget", "budgets")} on ${ctx.customerId} (${s.sharedBudgets ?? "?"} shared); enabled daily budget ${s.enabledDailyBudget === null ? unknownBecause("budgets or campaigns") : amount(s.enabledDailyBudget, ctx)}; portfolio strategies: ${s.portfolioStrategies ?? unknownBecause("bidding_strategies")}, used by ${s.campaignsOnPortfolio === null ? unknownBecause("campaigns") : plural(s.campaignsOnPortfolio, "campaign")}.`,
  rowLine: (r, ctx) =>
    `${shown(r.name)} id ${r.id}, ${amount(r.amount, ctx)} ${r.period ?? ""}${r.shared ? ", shared" : ""}: ${r.campaignCount === null ? "campaigns unknown" : plural(r.campaignCount, "campaign")} (${r.campaigns.map((c) => c.id).join(", ") || "none"}${(r.campaignCount ?? 0) > r.campaigns.length ? ", ..." : ""})`,
};
