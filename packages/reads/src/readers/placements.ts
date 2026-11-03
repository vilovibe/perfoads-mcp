// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). Where Display and Video ads showed and what each
// place cost, for the placement checks (Google documents the view as mainly the Display
// Network, with YouTube videos and apps; whether Demand Gen places appear is not documented):
// - placements (detail_placement_view, over the range): Google returns one row per ad group and
//   place; they are merged here into one row per campaign and place (site page, app, YouTube
//   video), metrics summed, the highest-cost first. Places with no cost are left out (the checks
//   judge money). Google's "Other" row (low-traffic places rolled together) names no place that
//   can be excluded: it is dropped, its spend kept in the summary. Performance Max reports no
//   cost per place, so it is not here.

import * as z from "zod";
import { MetricsSchema, plural, where, type FilterInput } from "../common.js";
import { dateCondition, describeDateRange } from "../dateRange.js";
import {
  addMetrics,
  enumValue,
  get,
  id,
  metrics,
  sumMoney,
  textOrNull,
  type Row,
} from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const PlacementRowSchema = z.object({
  campaignId: z.string(),
  placement: UntrustedSchema.nullable(),
  placementType: z.string().nullable(),
  displayName: UntrustedSchema.nullable(),
  targetUrl: UntrustedSchema.nullable(),
  groupTargetUrl: UntrustedSchema.nullable().describe("the site / app / channel the place sits in"),
  metrics: MetricsSchema,
});
export type PlacementRow = z.infer<typeof PlacementRowSchema>;

export const PlacementSummarySchema = z.object({
  placements: z.number().nullable().describe("null = not read"),
  otherCost: z
    .string()
    .nullable()
    .describe('spend in Google\'s "Other" row (places too small to name); null = not read'),
});
export type PlacementSummary = z.infer<typeof PlacementSummarySchema>;

/** Places read, the highest-cost first. */
export const PLACEMENT_CAP = 10_000;

export const placementsQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      detail_placement_view.placement,
      detail_placement_view.placement_type,
      detail_placement_view.display_name,
      detail_placement_view.target_url,
      detail_placement_view.group_placement_target_url,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM detail_placement_view
    ${where([dateCondition(input.dateRange), "campaign.status != 'REMOVED'", "metrics.cost_micros > 0"])}
    ORDER BY metrics.cost_micros DESC`;

/** Google's summary row of low-traffic places: not a place anyone can exclude. */
const OTHER = "Other";

const mapPlacement = (r: Row): PlacementRow | null => {
  const campaignId = id(get(r, "campaign.id"));
  if (!campaignId) return null;
  if (get(r, "detailPlacementView.placement") === OTHER) return null;
  return {
    campaignId,
    placement: textOrNull(get(r, "detailPlacementView.placement")),
    placementType: enumValue(get(r, "detailPlacementView.placementType")),
    displayName: textOrNull(get(r, "detailPlacementView.displayName")),
    targetUrl: textOrNull(get(r, "detailPlacementView.targetUrl")),
    groupTargetUrl: textOrNull(get(r, "detailPlacementView.groupPlacementTargetUrl")),
    metrics: metrics(r),
  };
};

export const placementsReader: ReaderDef<
  FilterInput,
  PlacementRow,
  PlacementSummary,
  { otherCost: string }
> = {
  name: "placements",
  queries: (input) => ({
    placements: { gaql: placementsQuery(input), limit: PLACEMENT_CAP },
  }),
  map: (data) => {
    const raw = data.placements ?? [];
    // one row per ad group and place from Google: merged per campaign and place
    const byKey = new Map<string, PlacementRow>();
    for (const r of raw.map(mapPlacement)) {
      if (!r) continue;
      const key = `${r.campaignId}\u0000${r.placement?.untrusted ?? r.targetUrl?.untrusted ?? ""}`;
      const had = byKey.get(key);
      byKey.set(
        key,
        had
          ? {
              ...had,
              placementType: had.placementType ?? r.placementType,
              displayName: had.displayName ?? r.displayName,
              targetUrl: had.targetUrl ?? r.targetUrl,
              groupTargetUrl: had.groupTargetUrl ?? r.groupTargetUrl,
              metrics: addMetrics(had.metrics, r.metrics),
            }
          : r,
      );
    }
    const otherCost = sumMoney(
      raw
        .filter((r) => get(r, "detailPlacementView.placement") === OTHER)
        .map((r) => metrics(r).cost),
    );
    return { rows: [...byKey.values()], extra: { otherCost } };
  },
  compare: (a, b) =>
    Number(b.metrics.cost) - Number(a.metrics.cost) ||
    a.campaignId.localeCompare(b.campaignId) ||
    (a.placement?.untrusted ?? "").localeCompare(b.placement?.untrusted ?? ""),
  summarise: (rows, extra, _ctx, _input, parts) => ({
    placements: partOk(parts, "placements") ? rows.length : null,
    otherCost: partOk(parts, "placements") ? (extra?.otherCost ?? "0") : null,
  }),
  summaryLine: (s, ctx, input) =>
    `Placements on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${s.placements === null ? "unknown" : plural(s.placements, "place")} with spend.`,
  rowLine: (r) =>
    `${r.campaignId} ${r.placementType ?? ""} ${r.displayName ? JSON.stringify(r.displayName) : ""} cost ${r.metrics.cost}`.trim(),
};
