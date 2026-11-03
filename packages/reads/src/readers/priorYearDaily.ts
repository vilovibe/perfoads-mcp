// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). The account's daily totals (FROM customer) for
// the same window a year earlier: the snapshot asks for the performance range moved back 364
// days, so the weekdays line up. The seasonality check compares this year's move with that
// one. A manager account has no metrics of its own: skipped there.

import * as z from "zod";
import { filterConditions, MetricsSchema, plural, where, type FilterInput } from "../common.js";
import { describeDateRange } from "../dateRange.js";
import { date, get, metrics, type Row } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";

export const PriorYearDayRowSchema = z.object({
  date: z.string(),
  metrics: MetricsSchema,
});
export type PriorYearDayRow = z.infer<typeof PriorYearDayRowSchema>;

export const PriorYearSummarySchema = z.object({
  days: z.number().nullable().describe("null = not read"),
});
export type PriorYearSummary = z.infer<typeof PriorYearSummarySchema>;

export const priorYearDailyQuery = (input: FilterInput): string => `
    SELECT
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM customer
    ${where(filterConditions({ ...input, campaignId: null, adGroupId: null, status: null }, null))}
    ORDER BY segments.date`;

const mapRow = (row: Row): PriorYearDayRow | null => {
  const day = date(get(row, "segments.date"));
  return day === null ? null : { date: day, metrics: metrics(row) };
};

export const priorYearDailyReader: ReaderDef<FilterInput, PriorYearDayRow, PriorYearSummary, null> =
  {
    name: "prior_year_daily",
    queries: (input, ctx) => ({
      prior_year_daily: ctx.isManager
        ? { skipped: "Manager accounts have no metrics of their own. Ask about a client account." }
        : { gaql: priorYearDailyQuery(input) },
    }),
    map: (data) => ({
      rows: (data.prior_year_daily ?? [])
        .map(mapRow)
        .filter((r): r is PriorYearDayRow => r !== null),
      extra: null,
    }),
    compare: (a, b) => a.date.localeCompare(b.date),
    summarise: (rows, _extra, _ctx, _input, parts) => ({
      days: partOk(parts, "prior_year_daily") ? rows.length : null,
    }),
    summaryLine: (s, ctx, input) =>
      `Daily totals a year earlier on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${s.days === null ? "days unknown" : plural(s.days, "day")}.`,
    rowLine: (r) => `${r.date}: cost ${r.metrics.cost}, ${r.metrics.clicks} clicks`,
  };
