// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import * as z from "zod";
import {
  dateCondition,
  ReadInputError,
  resolveDateRange,
  type DateRange,
  type DateRangeInput,
} from "./dateRange.js";
import { round } from "./normalise.js";
import type { ReaderContext } from "./reader.js";
import type { Untrusted } from "./untrusted.js";

export const MetricsSchema = z.object({
  impressions: z.number(),
  clicks: z.number(),
  cost: z.string().describe("Account currency, decimal string"),
  conversions: z.number(),
  conversionsValue: z.string(),
});

export const TotalsSchema = MetricsSchema.extend({
  ctr: z.number().nullable(),
  averageCpc: z.string().nullable(),
  costPerConversion: z.string().nullable(),
  roas: z.number().nullable().describe("Conversion value / cost; 3.2 = 320%"),
  conversionsAreMinimum: z
    .boolean()
    .describe("true: some rows' conversions are unknown, so conversion totals are a minimum"),
});

/** Filters shared by the date-based readers, already checked. */
export interface FilterInput {
  dateRange: DateRange;
  campaignId: string | null;
  adGroupId: string | null;
  status: "ENABLED" | "PAUSED" | null;
}

export const STATUS_FILTERS = ["ENABLED", "PAUSED"] as const;

const checkStatus = (v: unknown): FilterInput["status"] => {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && (STATUS_FILTERS as readonly string[]).includes(v)) {
    return v as FilterInput["status"];
  }
  throw new ReadInputError("status must be ENABLED or PAUSED.");
};

/** Raw tool input -> checked FilterInput. Throws ReadInputError with a plain reason. */
export const filterInput = (raw: {
  date_range?: DateRangeInput | undefined;
  campaign_id?: string | undefined;
  ad_group_id?: string | undefined;
  status?: string | undefined;
}): FilterInput => ({
  dateRange: resolveDateRange(raw.date_range),
  campaignId: checkId(raw.campaign_id, "campaign_id"),
  adGroupId: checkId(raw.ad_group_id, "ad_group_id"),
  status: checkStatus(raw.status),
});

/**
 * The shared WHERE pieces (date, status, ids), checked again at run time: a library caller
 * that builds a FilterInput by hand cannot put anything else into GAQL.
 */
export const filterConditions = (input: FilterInput, statusField: string | null): string[] => [
  dateCondition(input.dateRange),
  ...statusAndIdConditions(input, statusField),
];

/** filterConditions without the date (for reads of settings, not metrics). */
export const statusAndIdConditions = (
  input: Pick<FilterInput, "status" | "campaignId" | "adGroupId">,
  statusField: string | null,
): string[] => {
  const status = checkStatus(input.status);
  return [
    ...(status && statusField ? [`${statusField} = '${status}'`] : []),
    ...idConditions(input),
  ];
};

/** One choice from a fixed list, or null. Anything else is refused before Google is called. */
export const checkChoice = <T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && (choices as readonly string[]).includes(value))
    return value as T;
  throw new ReadInputError(`${label} must be one of ${choices.join(", ")}.`);
};

/** A digit-only id from the user, or null. Anything else is refused before Google is called. */
export const checkId = (value: unknown, label: string): string | null => {
  if (value === undefined) return null;
  const v = typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,20}$/.test(v)) throw new ReadInputError(`${label} must be digits only, e.g. 123456.`);
  return v;
};

/** Extra GAQL conditions for campaign / ad group filters (ids are digits, checked above). */
export const idConditions = (input: Pick<FilterInput, "campaignId" | "adGroupId">): string[] => {
  const campaignId = input.campaignId === null ? null : checkId(input.campaignId, "campaign_id");
  const adGroupId = input.adGroupId === null ? null : checkId(input.adGroupId, "ad_group_id");
  return [
    ...(campaignId ? [`campaign.id = ${campaignId}`] : []),
    ...(adGroupId ? [`ad_group.id = ${adGroupId}`] : []),
  ];
};

export const where = (conditions: readonly string[]): string =>
  conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

export const amount = (value: string | null, ctx: ReaderContext): string =>
  value === null ? "n/a" : `${value}${ctx.currencyCode ? ` ${ctx.currencyCode}` : ""}`;

/** Untrusted text inside a text line keeps its marking. */
export const shown = (u: Untrusted | null): string => (u === null ? "(none)" : JSON.stringify(u));

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export const countBy = <T>(rows: readonly T[], key: (r: T) => string | null) => {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r) ?? "UNKNOWN";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

export const metricLine = (
  m: { cost: string; clicks: number; conversions: number | null },
  ctx: ReaderContext,
): string =>
  `cost ${amount(m.cost, ctx)}, ${plural(m.clicks, "click")}, ${m.conversions === null ? "conversions unknown" : `${round(m.conversions, 2)} conv`}`;

/**
 * Google usually reports test accounts (manager and client) as CLOSED or CANCELED, and that
 * alone does not stop reads or changes; the note keeps the AI from calling them unusable
 * without claiming a test account the user really closed still works. null = no note needed.
 */
export const TEST_ACCOUNT_STATUS_NOTE =
  "Google usually shows test accounts as closed; that alone doesn't stop changes, and test accounts never show ads.";
export const testAccountStatusNote = (isTestAccount: boolean, status: string | null | undefined) =>
  isTestAccount && (status === "CLOSED" || status === "CANCELED" || status === "CANCELLED")
    ? TEST_ACCOUNT_STATUS_NOTE
    : null;

/** Text for a fact that depends on a part that was not read in full. */
export const unknownBecause = (part: string): string => `unknown ("${part}" couldn't be read)`;

/** n, or the reason it is unknown. */
export const countOr = (n: number | null, word: string, part: string): string =>
  n === null ? `${word}s: ${unknownBecause(part)}` : plural(n, word);
