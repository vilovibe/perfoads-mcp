// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Ported from PerfoAds fetchAdGroups. PerfoAds ran two queries (Search/Shopping vs other
// channels) for impression-share fields it no longer selects; both selected the same fields,
// so this is one query. Impression share is left out on purpose: the v26 field reference lists
// metrics.search_impression_share on ad_group with segments.date, but PerfoAds got
// PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE for exactly that in production (May 2026), and one
// refused field would fail the whole ad group read. Campaign-level impression share is in
// get_campaigns.

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
  text,
  totals,
  type Row,
} from "../normalise.js";
import type { ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const AdGroupRowSchema = z.object({
  id: z.string(),
  name: UntrustedSchema,
  status: z.string().nullable(),
  type: z.string().nullable(),
  campaignId: z.string().nullable(),
  campaignName: UntrustedSchema,
  channelType: z.string().nullable(),
  cpcBid: z.string().nullable(),
  metrics: MetricsSchema,
});
export type AdGroupRow = z.infer<typeof AdGroupRowSchema>;

export const AdGroupSummarySchema = z.object({
  adGroups: z.number(),
  withSpend: z.number(),
  byStatus: z.record(z.string(), z.number()),
  totals: TotalsSchema,
});
export type AdGroupSummary = z.infer<typeof AdGroupSummarySchema>;

export const adGroupsQuery = (input: FilterInput): string => `
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group.type,
      ad_group.cpc_bid_micros,
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM ad_group
    ${where([
      "ad_group.status != 'REMOVED'",
      "campaign.status != 'REMOVED'",
      ...filterConditions(input, "ad_group.status"),
    ])}
    ORDER BY metrics.cost_micros DESC`;

export const mapAdGroup = (row: Row): AdGroupRow | null => {
  const adGroupId = id(get(row, "adGroup.id"));
  if (!adGroupId) return null;
  return {
    id: adGroupId,
    name: text(get(row, "adGroup.name")),
    status: enumValue(get(row, "adGroup.status")),
    type: enumValue(get(row, "adGroup.type")),
    campaignId: id(get(row, "campaign.id")),
    campaignName: text(get(row, "campaign.name")),
    channelType: enumValue(get(row, "campaign.advertisingChannelType")),
    cpcBid: money(get(row, "adGroup.cpcBidMicros")),
    metrics: metrics(row),
  };
};

export const adGroupsReader: ReaderDef<FilterInput, AdGroupRow, AdGroupSummary, null> = {
  name: "ad_groups",
  queries: (input) => ({ ad_groups: { gaql: adGroupsQuery(input) } }),
  map: (data) => ({
    rows: (data.ad_groups ?? []).map(mapAdGroup).filter((r): r is AdGroupRow => r !== null),
    extra: null,
  }),
  compare: (a, b) => byMoneyDesc(a.metrics.cost, b.metrics.cost) || a.id.localeCompare(b.id),
  summarise: (rows) => ({
    adGroups: rows.length,
    withSpend: rows.filter((r) => r.metrics.cost !== "0").length,
    byStatus: countBy(rows, (r) => r.status),
    totals: totals(rows.map((r) => r.metrics)),
  }),
  summaryLine: (s, ctx, input) =>
    `${plural(s.adGroups, "ad group")} on ${ctx.customerId} (${s.withSpend} with spend), ${describeDateRange(input.dateRange)}: ${metricLine(s.totals, ctx)}.`,
  rowLine: (r, ctx) =>
    `${shown(r.name)} id ${r.id} in campaign ${r.campaignId ?? "?"}, ${r.status ?? "?"}: ${metricLine(r.metrics, ctx)}`,
};
