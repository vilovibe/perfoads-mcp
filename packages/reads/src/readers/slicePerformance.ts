// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). The performance a location or ad-schedule bid
// adjustment is judged against, per campaign over the range:
// - location_view: one row per campaign location criterion (the targeted location the
//   adjustment multiplies). geographic_view is the user's physical location, which is not
//   what a location adjustment acts on, so it is not used here.
// - the day x hour grid FROM campaign (segments.day_of_week, segments.hour): an ad-schedule
//   adjustment covers a block of hours, and the check engine measures it on the cells of that
//   block. ad_schedule_view reports per schedule criterion only, so the grid is read instead.
// - the network split FROM campaign (segments.ad_network_type) of the Search and Standard
//   Shopping campaigns: what each spent on Google Search, on search partners and on the
//   Display Network, so a partners or Display setting is judged on its own spend.
// Rows with all-zero metrics are dropped by Google: a cell or location with no row had no
// activity.

import * as z from "zod";
import { filterConditions, MetricsSchema, plural, where, type FilterInput } from "../common.js";
import { describeDateRange } from "../dateRange.js";
import { enumValue, get, id, metrics, numberOrNull, type Row } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";

export const SlicePerformanceRowSchema = z.object({
  kind: z.enum(["location", "schedule_cell", "network"]),
  campaignId: z.string(),
  criterionId: z.string().nullable().describe("location: the campaign criterion id"),
  geoTargetConstantId: z.string().nullable(),
  dayOfWeek: z.string().nullable().describe("schedule_cell: MONDAY ... SUNDAY"),
  hour: z.number().nullable().describe("schedule_cell: 0-23"),
  adNetworkType: z
    .string()
    .nullable()
    .default(null)
    .describe("network: SEARCH, SEARCH_PARTNERS, CONTENT ..."),
  metrics: MetricsSchema,
});
export type SlicePerformanceRow = z.infer<typeof SlicePerformanceRowSchema>;

export const SlicePerformanceSummarySchema = z.object({
  locations: z.number().nullable().describe("null = not read"),
  scheduleCells: z.number().nullable(),
  networkRows: z.number().nullable().default(null).describe("null = not read"),
});
export type SlicePerformanceSummary = z.infer<typeof SlicePerformanceSummarySchema>;

/** 7 days x 24 hours per campaign: passes 10,000 at 60 campaigns. */
export const SCHEDULE_GRID_CAP = 50_000;

const METRIC_FIELDS = `
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value`;

const plain = (input: FilterInput): FilterInput => ({
  ...input,
  campaignId: null,
  adGroupId: null,
  status: null,
});

export const locationViewQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      campaign_criterion.criterion_id,
      campaign_criterion.location.geo_target_constant,${METRIC_FIELDS}
    FROM location_view
    ${where(filterConditions(plain(input), null))}
    ORDER BY campaign.id, campaign_criterion.criterion_id`;

export const scheduleGridQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      segments.day_of_week,
      segments.hour,${METRIC_FIELDS}
    FROM campaign
    ${where(filterConditions(plain(input), null))}
    ORDER BY campaign.id`;

export const networkSplitQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      segments.ad_network_type,${METRIC_FIELDS}
    FROM campaign
    ${where([...filterConditions(plain(input), null), "campaign.advertising_channel_type IN ('SEARCH', 'SHOPPING')"])}
    ORDER BY campaign.id`;

const geoId = (v: unknown): string | null =>
  typeof v === "string" ? (/^geoTargetConstants\/(\d{1,20})$/.exec(v)?.[1] ?? null) : null;

const mapLocation = (row: Row): SlicePerformanceRow | null => {
  const campaignId = id(get(row, "campaign.id"));
  if (!campaignId) return null;
  return {
    kind: "location",
    campaignId,
    criterionId: id(get(row, "campaignCriterion.criterionId")),
    geoTargetConstantId: geoId(get(row, "campaignCriterion.location.geoTargetConstant")),
    dayOfWeek: null,
    hour: null,
    adNetworkType: null,
    metrics: metrics(row),
  };
};

const mapNetwork = (row: Row): SlicePerformanceRow | null => {
  const campaignId = id(get(row, "campaign.id"));
  const net = enumValue(get(row, "segments.adNetworkType"));
  if (!campaignId || !net) return null;
  return {
    kind: "network",
    campaignId,
    criterionId: null,
    geoTargetConstantId: null,
    dayOfWeek: null,
    hour: null,
    adNetworkType: net,
    metrics: metrics(row),
  };
};

const mapCell = (row: Row): SlicePerformanceRow | null => {
  const campaignId = id(get(row, "campaign.id"));
  const day = enumValue(get(row, "segments.dayOfWeek"));
  const hour = numberOrNull(get(row, "segments.hour"));
  if (!campaignId || !day || hour === null || hour < 0 || hour > 23) return null;
  return {
    kind: "schedule_cell",
    campaignId,
    criterionId: null,
    geoTargetConstantId: null,
    dayOfWeek: day,
    hour,
    adNetworkType: null,
    metrics: metrics(row),
  };
};

export const slicePerformanceReader: ReaderDef<
  FilterInput,
  SlicePerformanceRow,
  SlicePerformanceSummary,
  null
> = {
  name: "slice_performance",
  queries: (input) => ({
    locations: { gaql: locationViewQuery(input) },
    schedule_grid: { gaql: scheduleGridQuery(input), limit: SCHEDULE_GRID_CAP },
    networks: { gaql: networkSplitQuery(input) },
  }),
  map: (data) => ({
    rows: [
      ...(data.locations ?? []).map(mapLocation),
      ...(data.schedule_grid ?? []).map(mapCell),
      ...(data.networks ?? []).map(mapNetwork),
    ].filter((r): r is SlicePerformanceRow => r !== null),
    extra: null,
  }),
  compare: (a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.campaignId.localeCompare(b.campaignId) ||
    (a.criterionId ?? "").localeCompare(b.criterionId ?? "") ||
    (a.dayOfWeek ?? "").localeCompare(b.dayOfWeek ?? "") ||
    (a.hour ?? 0) - (b.hour ?? 0) ||
    (a.adNetworkType ?? "").localeCompare(b.adNetworkType ?? ""),
  summarise: (rows, _extra, _ctx, _input, parts) => ({
    locations: partOk(parts, "locations") ? rows.filter((r) => r.kind === "location").length : null,
    scheduleCells: partOk(parts, "schedule_grid")
      ? rows.filter((r) => r.kind === "schedule_cell").length
      : null,
    networkRows: partOk(parts, "networks") ? rows.filter((r) => r.kind === "network").length : null,
  }),
  summaryLine: (s, ctx, input) =>
    `Location and schedule performance on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${s.locations === null ? "locations unknown" : plural(s.locations, "location")}, ${s.scheduleCells === null ? "schedule cells unknown" : plural(s.scheduleCells, "schedule cell")}.`,
  rowLine: (r) =>
    `${r.kind} campaign ${r.campaignId} ${r.geoTargetConstantId ?? r.adNetworkType ?? `${r.dayOfWeek ?? ""} ${r.hour ?? ""}`}: ${r.metrics.clicks} clicks`,
};
