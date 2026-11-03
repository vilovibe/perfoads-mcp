// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Ported from PerfoAds fetchKeywords (keyword_view). Changes: segments.date is filtered, not
// selected, so Google sums the days (PerfoAds summed per-day rows itself); names of campaign
// and ad group added; negatives left out (get_negatives has them). Same filter as PerfoAds:
// only keywords with impressions in the date range.

import * as z from "zod";
import {
  countBy,
  metricLine,
  MetricsSchema,
  plural,
  shown,
  TotalsSchema,
  filterConditions,
  where,
  type FilterInput,
} from "../common.js";
import { describeDateRange } from "../dateRange.js";
import {
  byMoneyDesc,
  enumValue,
  get,
  id,
  metrics,
  money,
  numberOrNull,
  text,
  totals,
  type Row,
} from "../normalise.js";
import type { ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const KeywordRowSchema = z.object({
  criterionId: z.string(),
  text: UntrustedSchema,
  matchType: z.string().nullable(),
  status: z.string().nullable(),
  campaignId: z.string().nullable(),
  campaignName: UntrustedSchema,
  adGroupId: z.string().nullable(),
  adGroupName: UntrustedSchema,
  qualityScore: z.number().nullable(),
  expectedCtr: z.string().nullable(),
  adRelevance: z.string().nullable(),
  landingPageExperience: z.string().nullable(),
  cpcBid: z.string().nullable(),
  firstPageCpc: z.string().nullable(),
  topOfPageCpc: z.string().nullable(),
  firstPositionCpc: z.string().nullable(),
  metrics: MetricsSchema,
});
export type KeywordRow = z.infer<typeof KeywordRowSchema>;

export const KeywordSummarySchema = z.object({
  keywords: z.number(),
  withConversions: z.number(),
  byMatchType: z.record(z.string(), z.number()),
  lowQualityScore: z.number().describe("Keywords with quality score 1-4"),
  totals: TotalsSchema,
});
export type KeywordSummary = z.infer<typeof KeywordSummarySchema>;

export const keywordsQuery = (input: FilterInput): string => `
    SELECT
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.cpc_bid_micros,
      ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.quality_info.creative_quality_score,
      ad_group_criterion.quality_info.post_click_quality_score,
      ad_group_criterion.quality_info.search_predicted_ctr,
      ad_group_criterion.position_estimates.first_page_cpc_micros,
      ad_group_criterion.position_estimates.first_position_cpc_micros,
      ad_group_criterion.position_estimates.top_of_page_cpc_micros,
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM keyword_view
    ${where([
      "ad_group_criterion.status != 'REMOVED'",
      "ad_group_criterion.negative = FALSE",
      "ad_group.status != 'REMOVED'",
      "campaign.status != 'REMOVED'",
      "metrics.impressions > 0",
      ...filterConditions(input, "ad_group_criterion.status"),
    ])}
    ORDER BY metrics.cost_micros DESC`;

export const mapKeyword = (row: Row): KeywordRow | null => {
  const criterionId = id(get(row, "adGroupCriterion.criterionId"));
  if (!criterionId) return null;
  const c = (path: string) => get(row, `adGroupCriterion.${path}`);
  return {
    criterionId,
    text: text(c("keyword.text")),
    matchType: enumValue(c("keyword.matchType")),
    status: enumValue(c("status")),
    campaignId: id(get(row, "campaign.id")),
    campaignName: text(get(row, "campaign.name")),
    adGroupId: id(get(row, "adGroup.id")),
    adGroupName: text(get(row, "adGroup.name")),
    qualityScore: numberOrNull(c("qualityInfo.qualityScore")),
    expectedCtr: enumValue(c("qualityInfo.searchPredictedCtr")),
    adRelevance: enumValue(c("qualityInfo.creativeQualityScore")),
    landingPageExperience: enumValue(c("qualityInfo.postClickQualityScore")),
    cpcBid: money(c("cpcBidMicros")),
    firstPageCpc: money(c("positionEstimates.firstPageCpcMicros")),
    topOfPageCpc: money(c("positionEstimates.topOfPageCpcMicros")),
    firstPositionCpc: money(c("positionEstimates.firstPositionCpcMicros")),
    metrics: metrics(row),
  };
};

export const keywordsReader: ReaderDef<FilterInput, KeywordRow, KeywordSummary, null> = {
  name: "keywords",
  queries: (input) => ({ keywords: { gaql: keywordsQuery(input) } }),
  map: (data) => ({
    rows: (data.keywords ?? []).map(mapKeyword).filter((r): r is KeywordRow => r !== null),
    extra: null,
  }),
  compare: (a, b) =>
    byMoneyDesc(a.metrics.cost, b.metrics.cost) ||
    `${a.adGroupId}~${a.criterionId}`.localeCompare(`${b.adGroupId}~${b.criterionId}`),
  summarise: (rows) => ({
    keywords: rows.length,
    withConversions: rows.filter((r) => r.metrics.conversions > 0).length,
    byMatchType: countBy(rows, (r) => r.matchType),
    lowQualityScore: rows.filter((r) => r.qualityScore !== null && r.qualityScore <= 4).length,
    totals: totals(rows.map((r) => r.metrics)),
  }),
  summaryLine: (s, ctx, input) =>
    `${plural(s.keywords, "keyword")} with impressions on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${metricLine(s.totals, ctx)}; ${s.withConversions} with conversions, ${s.lowQualityScore} with quality score 1-4.`,
  rowLine: (r, ctx) =>
    `${shown(r.text)} ${r.matchType ?? "?"} (ad group ${r.adGroupId ?? "?"}, QS ${r.qualityScore ?? "-"}): ${metricLine(r.metrics, ctx)}`,
};
