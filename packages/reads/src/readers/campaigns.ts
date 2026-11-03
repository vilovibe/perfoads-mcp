// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Ported from PerfoAds fetchCampaigns (GAQL + mapping). Changes: no zero-spend drop (the
// caller sees every non-removed campaign, idle ones too, plus removed ones with activity in
// the range, sorted by cost), money as decimal strings,
// budget/portfolio ids from resource names, optional status/campaign filter.

import * as z from "zod";
import {
  countBy,
  metricLine,
  MetricsSchema,
  plural,
  shown,
  statusAndIdConditions,
  TotalsSchema,
  filterConditions,
  where,
  type FilterInput,
} from "../common.js";
import { describeDateRange, type DateRange } from "../dateRange.js";
import {
  bool,
  byMoneyDesc,
  enumValue,
  get,
  id,
  idFromResourceName,
  metrics,
  money,
  numberOrNull,
  ratio,
  text,
  totals,
  type Row,
} from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const CampaignRowSchema = z.object({
  id: z.string(),
  name: UntrustedSchema,
  status: z.string().nullable(),
  servingStatus: z.string().nullable(),
  primaryStatus: z
    .string()
    .nullable()
    .describe("Google's overall status for the campaign, e.g. ELIGIBLE, LIMITED, LEARNING"),
  biddingStrategySystemStatus: z
    .string()
    .nullable()
    .describe("Google's status for the bidding strategy, e.g. ENABLED, LEARNING_NEW"),
  channelType: z.string().nullable(),
  channelSubType: z.string().nullable(),
  budgetId: z.string().nullable(),
  dailyBudget: z.string().nullable(),
  budgetShared: z.boolean(),
  biddingStrategyType: z.string().nullable(),
  portfolioStrategyId: z.string().nullable(),
  targetCpa: z.string().nullable(),
  targetRoas: z.number().nullable(),
  networks: z
    .object({
      googleSearch: z.boolean(),
      searchPartners: z.boolean(),
      display: z.boolean(),
    })
    .nullable()
    .describe("Search and Shopping only; null for other types, where these settings do not apply"),
  geoTargetType: z.string().nullable(),
  metrics: MetricsSchema,
  searchImpressionShare: z.number().nullable(),
  searchTopImpressionShare: z.number().nullable(),
  searchAbsoluteTopImpressionShare: z.number().nullable(),
  searchBudgetLostImpressionShare: z.number().nullable(),
  searchRankLostImpressionShare: z.number().nullable(),
});
export type CampaignRow = z.infer<typeof CampaignRowSchema>;

export const CampaignSummarySchema = z.object({
  campaigns: z.number(),
  withSpend: z.number(),
  byStatus: z.record(z.string(), z.number()),
  totals: TotalsSchema,
});
export type CampaignSummary = z.infer<typeof CampaignSummarySchema>;

/** Campaigns input. `recentRange` is for the account snapshot only (the tool never sets it). */
export interface CampaignsInput extends FilterInput {
  /**
   * Also read each campaign's share lost to budget over this recent range (the last weeks of
   * the window): a budget limit from the launch weeks is not a limit today.
   */
  recentRange?: DateRange;
}

/** Snapshot detail (input.recentRange): one row per campaign with activity in the range. */
export interface CampaignsRecent {
  startDate: string | null;
  endDate: string | null;
  /** null = the part was not read (never "nothing lost") */
  campaigns:
    | {
        campaignId: string;
        cost: string;
        conversionsValue: string;
        searchBudgetLostImpressionShare: number | null;
      }[]
    | null;
}

const SETTINGS_FIELDS = `
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.serving_status,
      campaign.primary_status,
      campaign.bidding_strategy_system_status,
      campaign.advertising_channel_type,
      campaign.advertising_channel_sub_type,
      campaign.campaign_budget,
      campaign_budget.amount_micros,
      campaign_budget.explicitly_shared,
      campaign.bidding_strategy_type,
      campaign.bidding_strategy,
      campaign.maximize_conversion_value.target_roas,
      campaign.maximize_conversions.target_cpa_micros,
      campaign.target_cpa.target_cpa_micros,
      campaign.target_roas.target_roas,
      campaign.network_settings.target_google_search,
      campaign.network_settings.target_search_network,
      campaign.network_settings.target_content_network,
      campaign.geo_target_type_setting.positive_geo_target_type`;

/**
 * Every non-removed campaign, with no date: a date range drops a campaign with no activity in
 * it (an idle paused one), and the other reads still hold rows for it.
 */
export const campaignsQuery = (input: FilterInput): string => `
    SELECT${SETTINGS_FIELDS}
    FROM campaign
    ${where([
      "campaign.status != 'REMOVED'",
      ...statusAndIdConditions({ ...input, adGroupId: null }, "campaign.status"),
    ])}
    ORDER BY campaign.id`;

/**
 * Metrics for the range. Removed campaigns too: one with activity in the range is real spend
 * the daily and segment reads also hold.
 */
export const campaignMetricsQuery = (input: FilterInput): string => `
    SELECT${SETTINGS_FIELDS},
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.search_impression_share,
      metrics.search_top_impression_share,
      metrics.search_absolute_top_impression_share,
      metrics.search_budget_lost_impression_share,
      metrics.search_rank_lost_impression_share
    FROM campaign
    ${where(filterConditions({ ...input, adGroupId: null }, "campaign.status"))}
    ORDER BY metrics.cost_micros DESC`;

/** The recent range's spend, sales and share lost to budget, one row per campaign. */
export const campaignRecentQuery = (input: FilterInput, range: DateRange): string => `
    SELECT
      campaign.id,
      metrics.cost_micros,
      metrics.conversions_value,
      metrics.search_budget_lost_impression_share
    FROM campaign
    ${where(filterConditions({ ...input, dateRange: range, adGroupId: null }, "campaign.status"))}
    ORDER BY campaign.id`;

/** Target ROAS / CPA can sit on the standalone strategy or on maximize_*: same as PerfoAds. */
export const mapCampaign = (row: Row): CampaignRow | null => {
  const campaignId = id(get(row, "campaign.id"));
  if (!campaignId) return null;
  const roas =
    numberOrNull(get(row, "campaign.maximizeConversionValue.targetRoas")) ??
    numberOrNull(get(row, "campaign.targetRoas.targetRoas"));
  const cpa =
    money(get(row, "campaign.maximizeConversions.targetCpaMicros")) ??
    money(get(row, "campaign.targetCpa.targetCpaMicros"));
  const googleSearch = get(row, "campaign.networkSettings.targetGoogleSearch");
  const channelType = enumValue(get(row, "campaign.advertisingChannelType"));
  return {
    id: campaignId,
    name: text(get(row, "campaign.name")),
    status: enumValue(get(row, "campaign.status")),
    servingStatus: enumValue(get(row, "campaign.servingStatus")),
    primaryStatus: enumValue(get(row, "campaign.primaryStatus")),
    biddingStrategySystemStatus: enumValue(get(row, "campaign.biddingStrategySystemStatus")),
    channelType,
    channelSubType: enumValue(get(row, "campaign.advertisingChannelSubType")),
    budgetId: idFromResourceName(get(row, "campaign.campaignBudget")),
    dailyBudget: money(get(row, "campaignBudget.amountMicros")),
    budgetShared: bool(get(row, "campaignBudget.explicitlyShared")),
    biddingStrategyType: enumValue(get(row, "campaign.biddingStrategyType")),
    portfolioStrategyId: idFromResourceName(get(row, "campaign.biddingStrategy")),
    targetCpa: cpa && cpa !== "0" ? cpa : null,
    targetRoas: roas && roas > 0 ? roas : null,
    // Google returns network flags for every type, but they only steer Search and Shopping
    networks:
      channelType === "SEARCH" || channelType === "SHOPPING"
        ? {
            googleSearch: googleSearch === undefined ? true : bool(googleSearch),
            searchPartners: bool(get(row, "campaign.networkSettings.targetSearchNetwork")),
            display: bool(get(row, "campaign.networkSettings.targetContentNetwork")),
          }
        : null,
    geoTargetType: enumValue(get(row, "campaign.geoTargetTypeSetting.positiveGeoTargetType")),
    metrics: metrics(row),
    searchImpressionShare: ratio(get(row, "metrics.searchImpressionShare")),
    searchTopImpressionShare: ratio(get(row, "metrics.searchTopImpressionShare")),
    searchAbsoluteTopImpressionShare: ratio(get(row, "metrics.searchAbsoluteTopImpressionShare")),
    searchBudgetLostImpressionShare: ratio(get(row, "metrics.searchBudgetLostImpressionShare")),
    searchRankLostImpressionShare: ratio(get(row, "metrics.searchRankLostImpressionShare")),
  };
};

export const campaignsReader: ReaderDef<
  CampaignsInput,
  CampaignRow,
  CampaignSummary,
  { recent: CampaignsRecent } | null
> = {
  name: "campaigns",
  queries: (input) => ({
    campaigns: { gaql: campaignsQuery(input) },
    campaign_metrics: { gaql: campaignMetricsQuery(input) },
    ...(input.recentRange
      ? { campaign_recent: { gaql: campaignRecentQuery(input, input.recentRange) } }
      : {}),
  }),
  // a campaign with activity in the range comes from the metrics read (its settings too);
  // the rest from the settings read, with zero metrics
  map: (data, input, _ctx, parts) => {
    const byId = new Map<string, CampaignRow>();
    for (const r of (data.campaigns ?? []).map(mapCampaign)) if (r) byId.set(r.id, r);
    for (const r of (data.campaign_metrics ?? []).map(mapCampaign)) if (r) byId.set(r.id, r);
    const range = input.recentRange;
    const recent: CampaignsRecent | null = range
      ? {
          startDate: range.startDate,
          endDate: range.endDate,
          campaigns: partOk(parts, "campaign_recent")
            ? (data.campaign_recent ?? []).flatMap((row) => {
                const campaignId = id(get(row, "campaign.id"));
                if (!campaignId) return [];
                const m = metrics(row);
                return [
                  {
                    campaignId,
                    cost: m.cost,
                    conversionsValue: m.conversionsValue,
                    searchBudgetLostImpressionShare: ratio(
                      get(row, "metrics.searchBudgetLostImpressionShare"),
                    ),
                  },
                ];
              })
            : null,
        }
      : null;
    return { rows: [...byId.values()], extra: recent ? { recent } : null };
  },
  compare: (a, b) => byMoneyDesc(a.metrics.cost, b.metrics.cost) || a.id.localeCompare(b.id),
  summarise: (rows) => ({
    campaigns: rows.length,
    withSpend: rows.filter((r) => r.metrics.cost !== "0").length,
    byStatus: countBy(rows, (r) => r.status),
    totals: totals(rows.map((r) => r.metrics)),
  }),
  summaryLine: (s, ctx, input) =>
    `${plural(s.campaigns, "campaign")} on ${ctx.customerId} (${s.withSpend} with spend), ${describeDateRange(input.dateRange)}: ${metricLine(s.totals, ctx)}.`,
  rowLine: (r, ctx) =>
    `${shown(r.name)} id ${r.id}, ${r.status ?? "?"}, ${r.channelType ?? "?"}: ${metricLine(r.metrics, ctx)}`,
};
