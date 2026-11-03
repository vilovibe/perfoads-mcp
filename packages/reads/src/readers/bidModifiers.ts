// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). Ported from PerfoAds
// CRITERION_BID_MODIFIER_QUERY (campaign_criterion DEVICE / LOCATION / AD_SCHEDULE).
// Changes: audience criteria left to get_audiences; rows without a modifier are kept (a
// targeted location with no adjustment is still targeting); status read. Excluded
// (negative) locations come from a second small query, flagged negative: they say which
// countries a campaign can NOT reach (SK04's duplicate rule).

import * as z from "zod";
import { countBy, plural } from "../common.js";
import { enumValue, get, id, numberOrNull, type Row } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";

export const BidModifierRowSchema = z.object({
  campaignId: z.string().nullable(),
  criterionId: z.string(),
  type: z.string().nullable().describe("DEVICE, LOCATION, AD_SCHEDULE"),
  status: z.string().nullable(),
  negative: z.boolean().describe("true = an excluded location (never a bid adjustment)"),
  bidModifier: z.number().nullable().describe("1.2 = +20%; null = none set"),
  device: z.string().nullable(),
  geoTargetConstantId: z.string().nullable(),
  schedule: z
    .object({
      dayOfWeek: z.string().nullable(),
      startHour: z.number().nullable(),
      startMinute: z.string().nullable(),
      endHour: z.number().nullable(),
      endMinute: z.string().nullable(),
    })
    .nullable(),
});
export type BidModifierRow = z.infer<typeof BidModifierRowSchema>;

export const BidModifierSummarySchema = z.object({
  criteria: z.number().nullable().describe("null = not read"),
  withModifier: z.number().nullable(),
  excludedLocations: z
    .number()
    .nullable()
    .describe("excluded (negative) locations; null = not read"),
  byType: z.record(z.string(), z.number()),
});
export type BidModifierSummary = z.infer<typeof BidModifierSummarySchema>;

export const BID_MODIFIERS_QUERY = `
    SELECT
      campaign.id,
      campaign_criterion.criterion_id,
      campaign_criterion.type,
      campaign_criterion.status,
      campaign_criterion.bid_modifier,
      campaign_criterion.device.type,
      campaign_criterion.location.geo_target_constant,
      campaign_criterion.ad_schedule.day_of_week,
      campaign_criterion.ad_schedule.start_hour,
      campaign_criterion.ad_schedule.start_minute,
      campaign_criterion.ad_schedule.end_hour,
      campaign_criterion.ad_schedule.end_minute
    FROM campaign_criterion
    WHERE campaign_criterion.type IN ('DEVICE', 'LOCATION', 'AD_SCHEDULE')
      AND campaign_criterion.negative = FALSE
      AND campaign_criterion.status != 'REMOVED'
      AND campaign.status != 'REMOVED'
    ORDER BY campaign.id, campaign_criterion.criterion_id`;

/** Excluded locations: where a campaign does NOT show. */
export const EXCLUDED_LOCATIONS_QUERY = `
    SELECT
      campaign.id,
      campaign_criterion.criterion_id,
      campaign_criterion.type,
      campaign_criterion.status,
      campaign_criterion.location.geo_target_constant
    FROM campaign_criterion
    WHERE campaign_criterion.type = 'LOCATION'
      AND campaign_criterion.negative = TRUE
      AND campaign_criterion.status != 'REMOVED'
      AND campaign.status != 'REMOVED'
    ORDER BY campaign.id, campaign_criterion.criterion_id`;

const geoId = (v: unknown): string | null =>
  typeof v === "string" ? (/^geoTargetConstants\/(\d{1,20})$/.exec(v)?.[1] ?? null) : null;

const mapRow = (row: Row, negative = false): BidModifierRow | null => {
  const c = (path: string) => get(row, `campaignCriterion.${path}`);
  const criterionId = id(c("criterionId"));
  if (!criterionId) return null;
  const type = enumValue(c("type"));
  return {
    campaignId: id(get(row, "campaign.id")),
    criterionId,
    type,
    status: enumValue(c("status")),
    negative,
    bidModifier: negative ? null : numberOrNull(c("bidModifier")),
    device: enumValue(c("device.type")),
    geoTargetConstantId: geoId(c("location.geoTargetConstant")),
    schedule:
      type === "AD_SCHEDULE"
        ? {
            dayOfWeek: enumValue(c("adSchedule.dayOfWeek")),
            startHour: numberOrNull(c("adSchedule.startHour")),
            startMinute: enumValue(c("adSchedule.startMinute")),
            endHour: numberOrNull(c("adSchedule.endHour")),
            endMinute: enumValue(c("adSchedule.endMinute")),
          }
        : null,
  };
};

export const bidModifiersReader: ReaderDef<null, BidModifierRow, BidModifierSummary, null> = {
  name: "bid_modifiers",
  queries: () => ({
    criteria: { gaql: BID_MODIFIERS_QUERY },
    excluded_locations: { gaql: EXCLUDED_LOCATIONS_QUERY },
  }),
  map: (data) => ({
    rows: [
      ...(data.criteria ?? []).map((r) => mapRow(r)),
      ...(data.excluded_locations ?? []).map((r) => mapRow(r, true)),
    ].filter((r): r is BidModifierRow => r !== null),
    extra: null,
  }),
  compare: (a, b) =>
    (a.campaignId ?? "").localeCompare(b.campaignId ?? "") ||
    Number(a.negative) - Number(b.negative) ||
    a.criterionId.localeCompare(b.criterionId),
  summarise: (all, _extra, _ctx, _input, parts) => {
    const ok = partOk(parts, "criteria");
    const rows = all.filter((r) => !r.negative);
    return {
      criteria: ok ? rows.length : null,
      withModifier: ok
        ? rows.filter((r) => r.bidModifier !== null && r.bidModifier !== 1).length
        : null,
      byType: countBy(rows, (r) => r.type),
      excludedLocations: partOk(parts, "excluded_locations")
        ? all.filter((r) => r.negative).length
        : null,
    };
  },
  summaryLine: (s, ctx) =>
    s.criteria === null
      ? `Device/location/schedule criteria on ${ctx.customerId}: unknown (not read).`
      : `${plural(s.criteria, "device/location/schedule criterion")} on ${ctx.customerId}, ${s.withModifier ?? "?"} with a bid adjustment.`,
  rowLine: (r) =>
    `campaign ${r.campaignId ?? "?"} ${r.negative ? "EXCLUDED " : ""}${r.type ?? "?"} ${r.device ?? r.geoTargetConstantId ?? r.schedule?.dayOfWeek ?? ""} modifier ${r.bidModifier ?? "none"}`,
};
