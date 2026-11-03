// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import * as z from "zod";
import { date } from "./normalise.js";

/** GAQL `DURING` presets (the ones that are plain day windows). */
export const DATE_PRESETS = [
  "TODAY",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "THIS_MONTH",
  "LAST_MONTH",
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const MAX_RANGE_DAYS = 400;
export const DEFAULT_PRESET: DatePreset = "LAST_30_DAYS";

/** One short string: a preset or "start..end". Checked by resolveDateRange. */
export const DateRangeInputSchema = z
  .string()
  .max(40)
  .describe(
    "LAST_30_DAYS (default), TODAY, YESTERDAY, LAST_7_DAYS, LAST_14_DAYS, THIS_MONTH, LAST_MONTH, or 2026-09-01..2026-09-30 (max 400 days)",
  );
export type DateRangeInput = z.infer<typeof DateRangeInputSchema>;

export const DateRangeSchema = z.object({
  preset: z.enum(DATE_PRESETS).nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
});
export type DateRange = z.infer<typeof DateRangeSchema>;

export class ReadInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadInputError";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isPreset = (v: unknown): v is DatePreset =>
  typeof v === "string" && (DATE_PRESETS as readonly string[]).includes(v);

const checkDates = (start: unknown, end: unknown): { startDate: string; endDate: string } => {
  const s = date(start);
  const e = date(end);
  if (!s || !e) throw new ReadInputError("Dates must be real dates written YYYY-MM-DD.");
  if (s > e) throw new ReadInputError("The start date is after the end date.");
  const days =
    Math.round((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new ReadInputError(
      `The date range is ${days} days; the most is ${MAX_RANGE_DAYS}. Ask for a shorter range.`,
    );
  }
  return { startDate: s, endDate: e };
};

/** "LAST_7_DAYS" or "2026-09-01..2026-09-30" -> DateRange. Throws ReadInputError with a reason. */
export const resolveDateRange = (input: string | undefined): DateRange => {
  const v = (input ?? DEFAULT_PRESET).trim();
  if (isPreset(v)) return { preset: v, startDate: null, endDate: null };
  const m = /^(\S+)\s*\.\.\s*(\S+)$/.exec(v);
  if (!m) {
    throw new ReadInputError(
      `Unknown date range "${v.slice(0, 40)}". Use a preset like LAST_30_DAYS or 2026-09-01..2026-09-30.`,
    );
  }
  return { preset: null, ...checkDates(m[1], m[2]) };
};

/**
 * The GAQL date condition. Checks the range again at run time, so a library caller that builds
 * a DateRange by hand still cannot put anything but a known preset or two real dates into GAQL.
 */
export const dateCondition = (r: DateRange): string => {
  if (r.preset !== null) {
    if (!isPreset(r.preset)) throw new ReadInputError("Unknown date preset.");
    return `segments.date DURING ${r.preset}`;
  }
  const { startDate, endDate } = checkDates(r.startDate, r.endDate);
  return `segments.date BETWEEN '${startDate}' AND '${endDate}'`;
};

export const describeDateRange = (r: DateRange): string =>
  r.preset
    ? r.preset.toLowerCase().replace(/_/g, " ")
    : `${r.startDate ?? "?"} to ${r.endDate ?? "?"}`;

/** "YYYY-MM-DD" of an instant in a time zone (an unknown zone reads as UTC). */
const dayIn = (ms: number, timeZone: string | null): string => {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  try {
    return fmt(timeZone ?? "UTC");
  } catch {
    return fmt("UTC");
  }
};

const shiftDay = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * A range as two dates, a preset resolved the way Google resolves it (in the account's time
 * zone; the LAST_N_DAYS presets end yesterday). For resources that filter on a date-time
 * field instead of segments.date, where DURING cannot be used.
 */
export const rangeDates = (
  r: DateRange,
  nowMs: number,
  timeZone: string | null,
): { startDate: string; endDate: string } => {
  if (r.preset === null) return checkDates(r.startDate, r.endDate);
  if (!isPreset(r.preset)) throw new ReadInputError("Unknown date preset.");
  const today = dayIn(nowMs, timeZone);
  const yesterday = shiftDay(today, -1);
  const lastDays = (n: number) => ({
    startDate: shiftDay(yesterday, -(n - 1)),
    endDate: yesterday,
  });
  switch (r.preset) {
    case "TODAY":
      return { startDate: today, endDate: today };
    case "YESTERDAY":
      return { startDate: yesterday, endDate: yesterday };
    case "LAST_7_DAYS":
      return lastDays(7);
    case "LAST_14_DAYS":
      return lastDays(14);
    case "LAST_30_DAYS":
      return lastDays(30);
    case "THIS_MONTH":
      return { startDate: `${today.slice(0, 8)}01`, endDate: today };
    case "LAST_MONTH": {
      const end = shiftDay(`${today.slice(0, 8)}01`, -1);
      return { startDate: `${end.slice(0, 8)}01`, endDate: end };
    }
  }
};
