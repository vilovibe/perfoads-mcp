// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). The view numbers of Video campaigns, for the
// video checks:
// - video_campaigns (campaign, over the range): each non-removed Video campaign's views, view
//   rate, average cost per view and how far viewers watched (quartile rates). Google drops a
//   campaign with no activity in the range.

import * as z from "zod";
import { MetricsSchema, plural, where, type FilterInput } from "../common.js";
import { dateCondition, describeDateRange } from "../dateRange.js";
import { doubleMoney, get, id, metrics, numberOrNull, type Row } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";

export const VideoRowSchema = z.object({
  campaignId: z.string(),
  views: z.number().nullable().describe("TrueView views; null = Google sent none"),
  viewRate: z.number().nullable().describe("views / impressions, a fraction"),
  averageCpv: z.string().nullable().describe("average cost per view, account currency"),
  quartiles: z
    .object({
      p25: z.number().nullable(),
      p50: z.number().nullable(),
      p75: z.number().nullable(),
      p100: z.number().nullable(),
    })
    .describe("share of impressions watched to 25/50/75/100% (fractions)"),
  metrics: MetricsSchema,
});
export type VideoRow = z.infer<typeof VideoRowSchema>;

export const VideoSummarySchema = z.object({
  videoCampaigns: z.number().nullable().describe("null = not read"),
});
export type VideoSummary = z.infer<typeof VideoSummarySchema>;

export const videoCampaignsQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      metrics.video_trueview_views,
      metrics.video_trueview_view_rate,
      metrics.trueview_average_cpv,
      metrics.video_quartile_p25_rate,
      metrics.video_quartile_p50_rate,
      metrics.video_quartile_p75_rate,
      metrics.video_quartile_p100_rate,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    ${where([
      dateCondition(input.dateRange),
      "campaign.advertising_channel_type = 'VIDEO'",
      "campaign.status != 'REMOVED'",
    ])}
    ORDER BY campaign.id`;

/** Google sends the average cost per view in micros, as a double. */
const cpvOf = (v: unknown): string | null => {
  const n = numberOrNull(v);
  return n === null ? null : doubleMoney(n / 1_000_000);
};

const mapVideo = (r: Row): VideoRow | null => {
  const campaignId = id(get(r, "campaign.id"));
  if (!campaignId) return null;
  return {
    campaignId,
    views: numberOrNull(get(r, "metrics.videoTrueviewViews")),
    viewRate: numberOrNull(get(r, "metrics.videoTrueviewViewRate")),
    averageCpv: cpvOf(get(r, "metrics.trueviewAverageCpv")),
    quartiles: {
      p25: numberOrNull(get(r, "metrics.videoQuartileP25Rate")),
      p50: numberOrNull(get(r, "metrics.videoQuartileP50Rate")),
      p75: numberOrNull(get(r, "metrics.videoQuartileP75Rate")),
      p100: numberOrNull(get(r, "metrics.videoQuartileP100Rate")),
    },
    metrics: metrics(r),
  };
};

export const videoReader: ReaderDef<FilterInput, VideoRow, VideoSummary, null> = {
  name: "video",
  queries: (input) => ({ video_campaigns: { gaql: videoCampaignsQuery(input) } }),
  map: (data) => ({
    rows: (data.video_campaigns ?? []).map(mapVideo).filter((r): r is VideoRow => r !== null),
    extra: null,
  }),
  compare: (a, b) => a.campaignId.localeCompare(b.campaignId),
  summarise: (rows, _extra, _ctx, _input, parts) => ({
    videoCampaigns: partOk(parts, "video_campaigns") ? rows.length : null,
  }),
  summaryLine: (s, ctx, input) =>
    `Video on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${s.videoCampaigns === null ? "unknown" : plural(s.videoCampaigns, "Video campaign")} with activity.`,
  rowLine: (r) =>
    `${r.campaignId}: ${r.views ?? "?"} views, view rate ${r.viewRate ?? "?"}, cost per view ${r.averageCpv ?? "?"}`,
};
