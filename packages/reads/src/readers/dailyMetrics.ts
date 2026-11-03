// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). The daily series the checks measure their
// windows on: account totals per day (FROM customer), each campaign per day (FROM campaign),
// and each campaign per device over the range. PerfoAds read the same three in its sync
// (daily_metrics, campaign_daily_metrics, device_data); rewritten here as plain GAQL.
//
// - Removed campaigns are NOT filtered out: their spend in the range is real spend and is in
//   the account totals, so it stays in the campaign series too.
// - Google drops segmented rows whose metrics are all zero: a day with no activity has no
//   row. The snapshot adapter fills the account series to every day of the range; campaign
//   days stay as read (the check engine counts a campaign's rows as the days it ran).
// - A manager account has no metrics of its own: the account series is skipped there.

import * as z from "zod";
import { filterConditions, MetricsSchema, plural, where, type FilterInput } from "../common.js";
import { describeDateRange } from "../dateRange.js";
import { date, enumValue, get, id, metrics, type Row } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";

export const DailyMetricRowSchema = z.object({
  kind: z.enum(["account_day", "campaign_day", "campaign_device"]),
  date: z.string().nullable().describe("YYYY-MM-DD; null for campaign_device"),
  campaignId: z.string().nullable(),
  device: z
    .string()
    .nullable()
    .describe("MOBILE, DESKTOP, TABLET, CONNECTED_TV, OTHER, UNKNOWN, UNSPECIFIED"),
  metrics: MetricsSchema,
});
export type DailyMetricRow = z.infer<typeof DailyMetricRowSchema>;

export const DailyMetricSummarySchema = z.object({
  accountDays: z.number().nullable().describe("null = not read"),
  campaignDays: z.number().nullable(),
  deviceRows: z.number().nullable(),
});
export type DailyMetricSummary = z.infer<typeof DailyMetricSummarySchema>;

/** A campaign series is days x campaigns: 120 campaigns x 90 days already passes 10,000. */
export const CAMPAIGN_DAILY_CAP = 50_000;

const METRIC_FIELDS = `
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value`;

const noFilter = (input: FilterInput): FilterInput => ({
  ...input,
  campaignId: null,
  adGroupId: null,
  status: null,
});

export const accountDailyQuery = (input: FilterInput): string => `
    SELECT
      segments.date,${METRIC_FIELDS}
    FROM customer
    ${where(filterConditions(noFilter(input), null))}
    ORDER BY segments.date`;

export const campaignDailyQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      segments.date,${METRIC_FIELDS}
    FROM campaign
    ${where(filterConditions(noFilter(input), null))}
    ORDER BY campaign.id, segments.date`;

export const campaignDeviceQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      segments.device,${METRIC_FIELDS}
    FROM campaign
    ${where(filterConditions(noFilter(input), null))}
    ORDER BY campaign.id`;

const mapRow = (row: Row, kind: DailyMetricRow["kind"]): DailyMetricRow | null => {
  const day = kind === "campaign_device" ? null : date(get(row, "segments.date"));
  if (kind !== "campaign_device" && day === null) return null;
  const campaignId = kind === "account_day" ? null : id(get(row, "campaign.id"));
  if (kind !== "account_day" && campaignId === null) return null;
  const device = kind === "campaign_device" ? enumValue(get(row, "segments.device")) : null;
  if (kind === "campaign_device" && device === null) return null;
  return { kind, date: day, campaignId, device, metrics: metrics(row) };
};

const KIND_ORDER: Record<DailyMetricRow["kind"], number> = {
  account_day: 0,
  campaign_day: 1,
  campaign_device: 2,
};

export const dailyMetricsReader: ReaderDef<FilterInput, DailyMetricRow, DailyMetricSummary, null> =
  {
    name: "daily_metrics",
    queries: (input, ctx) => ({
      account_daily: ctx.isManager
        ? { skipped: "Manager accounts have no metrics of their own. Ask about a client account." }
        : { gaql: accountDailyQuery(input) },
      campaign_daily: { gaql: campaignDailyQuery(input), limit: CAMPAIGN_DAILY_CAP },
      campaign_device: { gaql: campaignDeviceQuery(input) },
    }),
    map: (data) => ({
      rows: [
        ...(data.account_daily ?? []).map((r) => mapRow(r, "account_day")),
        ...(data.campaign_daily ?? []).map((r) => mapRow(r, "campaign_day")),
        ...(data.campaign_device ?? []).map((r) => mapRow(r, "campaign_device")),
      ].filter((r): r is DailyMetricRow => r !== null),
      extra: null,
    }),
    compare: (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.campaignId ?? "").localeCompare(b.campaignId ?? "") ||
      (a.date ?? "").localeCompare(b.date ?? "") ||
      (a.device ?? "").localeCompare(b.device ?? ""),
    summarise: (rows, _extra, _ctx, _input, parts) => {
      const n = (kind: DailyMetricRow["kind"], part: string) =>
        partOk(parts, part) ? rows.filter((r) => r.kind === kind).length : null;
      return {
        accountDays: n("account_day", "account_daily"),
        campaignDays: n("campaign_day", "campaign_daily"),
        deviceRows: n("campaign_device", "campaign_device"),
      };
    },
    summaryLine: (s, ctx, input) =>
      `Daily metrics on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${s.accountDays === null ? "account days unknown" : plural(s.accountDays, "account day")}, ${s.campaignDays === null ? "campaign days unknown" : plural(s.campaignDays, "campaign day")}, ${s.deviceRows === null ? "device rows unknown" : plural(s.deviceRows, "device row")}.`,
    rowLine: (r) =>
      `${r.kind} ${r.campaignId ?? "account"} ${r.date ?? r.device ?? ""}: cost ${r.metrics.cost}, ${r.metrics.clicks} clicks`,
  };
