// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). Ported from PerfoAds fetchBiddingDataExclusions
// (data_exclusion_id, not id: Google refuses `id`) and fetchBiddingSeasonalityAdjustments.
// Changes: one reader for both, REMOVED left out, campaigns and channel types read, a
// failed part is reported (PerfoAds returned none).

import * as z from "zod";
import { countBy, plural, shown } from "../common.js";
import {
  dateTime,
  enumList,
  enumValue,
  get,
  id,
  idFromResourceName,
  numberOrNull,
  textOrNull,
  type Row,
} from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const BiddingAdjustmentRowSchema = z.object({
  kind: z.enum(["data_exclusion", "seasonality_adjustment"]),
  id: z.string(),
  name: UntrustedSchema.nullable(),
  description: UntrustedSchema.nullable(),
  scope: z.string().nullable().describe("CUSTOMER, CAMPAIGN, CHANNEL"),
  status: z.string().nullable(),
  startDateTime: z.string().nullable(),
  endDateTime: z.string().nullable(),
  devices: z.array(z.string()),
  channelTypes: z.array(z.string()),
  campaignIds: z.array(z.string()).describe("First 20"),
  conversionRateModifier: z.number().nullable().describe("Seasonality only: 1.3 = +30%"),
});
export type BiddingAdjustmentRow = z.infer<typeof BiddingAdjustmentRowSchema>;

export const BiddingAdjustmentSummarySchema = z.object({
  dataExclusions: z.number().nullable(),
  seasonalityAdjustments: z.number().nullable(),
  byStatus: z.record(z.string(), z.number()),
});
export type BiddingAdjustmentSummary = z.infer<typeof BiddingAdjustmentSummarySchema>;

const common = (r: string) => `
      ${r}.name,
      ${r}.description,
      ${r}.scope,
      ${r}.status,
      ${r}.start_date_time,
      ${r}.end_date_time,
      ${r}.devices,
      ${r}.advertising_channel_types,
      ${r}.campaigns`;

export const DATA_EXCLUSIONS_QUERY = `
    SELECT
      bidding_data_exclusion.data_exclusion_id,${common("bidding_data_exclusion")}
    FROM bidding_data_exclusion
    WHERE bidding_data_exclusion.status != 'REMOVED'
    ORDER BY bidding_data_exclusion.data_exclusion_id`;

export const SEASONALITY_QUERY = `
    SELECT
      bidding_seasonality_adjustment.seasonality_adjustment_id,
      bidding_seasonality_adjustment.conversion_rate_modifier,${common("bidding_seasonality_adjustment")}
    FROM bidding_seasonality_adjustment
    WHERE bidding_seasonality_adjustment.status != 'REMOVED'
    ORDER BY bidding_seasonality_adjustment.seasonality_adjustment_id`;

const mapRow = (row: Row, kind: BiddingAdjustmentRow["kind"]): BiddingAdjustmentRow | null => {
  const base = kind === "data_exclusion" ? "biddingDataExclusion" : "biddingSeasonalityAdjustment";
  const a = (path: string) => get(row, `${base}.${path}`);
  const rowId = id(a(kind === "data_exclusion" ? "dataExclusionId" : "seasonalityAdjustmentId"));
  if (!rowId) return null;
  const campaigns = a("campaigns");
  return {
    kind,
    id: rowId,
    name: textOrNull(a("name")),
    description: textOrNull(a("description")),
    scope: enumValue(a("scope")),
    status: enumValue(a("status")),
    startDateTime: dateTime(a("startDateTime")),
    endDateTime: dateTime(a("endDateTime")),
    devices: enumList(a("devices")),
    channelTypes: enumList(a("advertisingChannelTypes")),
    campaignIds: (Array.isArray(campaigns) ? campaigns : [])
      .map(idFromResourceName)
      .filter((c): c is string => c !== null)
      .slice(0, 20),
    conversionRateModifier:
      kind === "seasonality_adjustment" ? numberOrNull(a("conversionRateModifier")) : null,
  };
};

export const biddingAdjustmentsReader: ReaderDef<
  null,
  BiddingAdjustmentRow,
  BiddingAdjustmentSummary,
  null
> = {
  name: "bidding_adjustments",
  queries: () => ({
    data_exclusions: { gaql: DATA_EXCLUSIONS_QUERY },
    seasonality_adjustments: { gaql: SEASONALITY_QUERY },
  }),
  map: (data) => ({
    rows: [
      ...(data.data_exclusions ?? []).map((r) => mapRow(r, "data_exclusion")),
      ...(data.seasonality_adjustments ?? []).map((r) => mapRow(r, "seasonality_adjustment")),
    ].filter((r): r is BiddingAdjustmentRow => r !== null),
    extra: null,
  }),
  compare: (a, b) =>
    (b.startDateTime ?? "").localeCompare(a.startDateTime ?? "") ||
    a.kind.localeCompare(b.kind) ||
    a.id.localeCompare(b.id),
  summarise: (rows, _extra, _ctx, _input, parts) => {
    const ok = (name: string) => partOk(parts, name);
    return {
      dataExclusions: ok("data_exclusions")
        ? rows.filter((r) => r.kind === "data_exclusion").length
        : null,
      seasonalityAdjustments: ok("seasonality_adjustments")
        ? rows.filter((r) => r.kind === "seasonality_adjustment").length
        : null,
      byStatus: countBy(rows, (r) => r.status),
    };
  },
  summaryLine: (s, ctx) =>
    `Bidding adjustments on ${ctx.customerId}: data exclusions ${s.dataExclusions ?? "unknown"}, seasonality adjustments ${s.seasonalityAdjustments ?? "unknown"}.`,
  rowLine: (r) =>
    `${r.kind} ${r.id} ${shown(r.name)} ${r.status ?? "?"} ${r.startDateTime ?? "?"} to ${r.endDateTime ?? "?"}${r.conversionRateModifier !== null ? ` x${r.conversionRateModifier}` : ""} (${plural(r.campaignIds.length, "campaign")})`,
};
