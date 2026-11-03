// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The one place that turns Google Ads REST rows into clean typed values.
//
// Rules, by field type (never by what a value looks like):
// - money in micros -> decimal string ("12.5"), BigInt maths, never floats
// - money Google sends as a double (conversions_value) -> decimal string, max 6 decimals
// - counts (int64 strings) -> number; ratios and doubles -> number
// - enums -> plain string (only the shape A-Z, 0-9, _ is accepted; anything else -> null)
// - ids and resource names -> digit-only id strings
// - dates -> YYYY-MM-DD
// - currency codes and time zones -> plain string when the shape is right, else null
// - free text (names, ad texts, URLs, search terms, keyword texts, asset texts, labels,
//   Google's messages) -> {"untrusted": "..."}, cut to 300 characters with "truncated": true
// - conversions stay raw doubles per row; only totals and text lines are rounded

import { decimalToMicros, microsToDecimalString, parseMicros } from "@perfoads/ads-client";
import { untrustedText, type Untrusted } from "./untrusted.js";

export type Row = Record<string, unknown>;

const isObject = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

/** Value at a dotted camelCase path, e.g. get(row, "campaign.networkSettings.targetGoogleSearch"). */
export const get = (row: unknown, path: string): unknown => {
  let cur: unknown = row;
  for (const key of path.split(".")) {
    if (!isObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
};

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

// ---- money ----

/** Micros (int64 string or safe integer) -> decimal string. null when missing or not an integer. */
export const money = (v: unknown): string | null => {
  if (!present(v)) return null;
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "bigint") return null;
  try {
    return microsToDecimalString(parseMicros(v));
  } catch {
    return null;
  }
};

/** Like money(), but missing means 0 (REST leaves out zero metrics). */
export const moneyOrZero = (v: unknown): string => money(v) ?? "0";

/**
 * Money Google sends as a double in account currency units (conversions_value).
 * Rounded to whole micros, then written as a decimal string.
 */
export const doubleMoney = (v: unknown): string => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return "0";
  return microsToDecimalString(BigInt(Math.round(n * 1_000_000)));
};

export const toMicros = (decimal: string): bigint => decimalToMicros(decimal);

export const sumMoney = (values: readonly string[]): string =>
  microsToDecimalString(values.reduce((acc, v) => acc + decimalToMicros(v), 0n));

/** a / b for money strings and a count, rounded to whole micros. null when b is 0. */
export const moneyPer = (total: string, per: number): string | null => {
  if (!(per > 0)) return null;
  const micros = Number(decimalToMicros(total)) / per;
  return microsToDecimalString(BigInt(Math.round(micros)));
};

// ---- numbers ----

/** int64 count (impressions, clicks). Missing = 0. */
export const count = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
};

/** int64 or double that may be missing (quality score, member count). */
export const numberOrNull = (v: unknown): number | null => {
  if (!present(v)) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Double metric (conversions). Missing = 0. */
export const double = (v: unknown): number => numberOrNull(v) ?? 0;

/** Rounds to `digits` decimals for display-safe numbers (ratios, conversions). */
export const round = (n: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** 0..1 share (impression share). Missing = null. */
export const ratio = (v: unknown): number | null => {
  const n = numberOrNull(v);
  return n === null ? null : round(n, 4);
};

export const bool = (v: unknown): boolean => v === true;

export const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

// ---- enums, ids, dates, codes ----

const ENUM_SHAPE = /^[A-Z][A-Z0-9_]*$/;

/** Google enum as a plain string. Any other shape is not an enum value: null. */
export const enumValue = (v: unknown): string | null =>
  typeof v === "string" && ENUM_SHAPE.test(v) ? v : null;

const DIGITS = /^\d{1,20}$/;

/** Numeric id (int64 string or number). */
export const id = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return typeof v === "string" && DIGITS.test(v) ? v : null;
};

/**
 * Asset links end in their field type: "customers/1/campaignAssets/456~789~SITELINK".
 * The type is dropped (it is read from field_type); anything else is left for the shape check.
 */
const withoutFieldType = (v: unknown): string | null =>
  typeof v === "string" ? v.replace(/(\/[0-9~]+)~[A-Z][A-Z0-9_]*$/, "$1") : null;

/**
 * Last id in a resource name: "customers/1/campaignBudgets/22" -> "22",
 * "customers/1/adGroupCriteria/33~44" -> "44" (the criterion id after the "~").
 */
export const idFromResourceName = (v: unknown): string | null => {
  const name = withoutFieldType(v);
  if (name === null || !/^customers\/\d+(\/[A-Za-z]+\/[0-9~]+)*$/.test(name)) return null;
  const last = name.split("/").pop() ?? "";
  return id(last.split("~").pop());
};

/**
 * Every id in the last part of a resource name, in order:
 * "customers/1/adGroupAds/21~31" -> ["21", "31"]. [] when the shape is wrong.
 */
export const idsFromResourceName = (v: unknown): string[] => {
  const name = withoutFieldType(v);
  if (name === null || !/^customers\/\d+(\/[A-Za-z]+\/[0-9~]+)*$/.test(name)) return [];
  const last = name.split("/").pop() ?? "";
  const ids = last.split("~").map(id);
  return ids.every((x): x is string => x !== null) ? ids : [];
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD that is a real calendar date, else null. */
export const date = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = DATE.exec(v);
  if (!m) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
};

/** Google date-time "2026-10-20 13:45:10" (optional fraction and offset) with a real date, else null. */
export const dateTime = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}(\.\d{1,9})?([+-]\d{2}:\d{2})?$/.exec(v);
  return m && date(m[1]) ? v : null;
};

/** Enums of a repeated field (e.g. devices). Values of another shape are dropped. */
export const enumList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(enumValue).filter((x): x is string => x !== null) : [];

export const currencyCode = (v: unknown): string | null =>
  typeof v === "string" && /^[A-Z]{3}$/.test(v) ? v : null;

/** IANA time zone shape, e.g. Europe/Amsterdam, America/Argentina/Buenos_Aires. */
export const timeZone = (v: unknown): string | null =>
  typeof v === "string" && /^[A-Za-z]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(v) && v.length <= 64
    ? v
    : null;

// ---- free text ----

/** Free text from Google: always wrapped (and cut if very long). Missing = empty wrapped text. */
export const text = (v: unknown): Untrusted => untrustedText(typeof v === "string" ? v : "");

/** Free text from Google, null when missing. */
export const textOrNull = (v: unknown): Untrusted | null =>
  typeof v === "string" && v !== "" ? untrustedText(v) : null;

/** A repeated free-text field (URLs, snippet values): each wrapped, at most `max` kept. */
export const textList = (v: unknown, max = 20): Untrusted[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x !== "")
        .slice(0, max)
        .map(untrustedText)
    : [];

// ---- shared metric block ----

export interface Metrics {
  impressions: number;
  clicks: number;
  cost: string;
  conversions: number;
  conversionsValue: string;
}

/** metrics.impressions, clicks, cost_micros, conversions, conversions_value of one row. */
export const metrics = (row: unknown): Metrics => ({
  impressions: count(get(row, "metrics.impressions")),
  clicks: count(get(row, "metrics.clicks")),
  cost: moneyOrZero(get(row, "metrics.costMicros")),
  conversions: double(get(row, "metrics.conversions")),
  conversionsValue: doubleMoney(get(row, "metrics.conversionsValue")),
});

export const addMetrics = (a: Metrics, b: Metrics): Metrics => ({
  impressions: a.impressions + b.impressions,
  clicks: a.clicks + b.clicks,
  cost: sumMoney([a.cost, b.cost]),
  conversions: a.conversions + b.conversions,
  conversionsValue: sumMoney([a.conversionsValue, b.conversionsValue]),
});

export const ZERO_METRICS: Metrics = Object.freeze({
  impressions: 0,
  clicks: 0,
  cost: "0",
  conversions: 0,
  conversionsValue: "0",
});

export interface Totals extends Metrics {
  /** clicks / impressions */
  ctr: number | null;
  averageCpc: string | null;
  costPerConversion: string | null;
  /** conversion value / cost, e.g. 3.25 = 325% */
  roas: number | null;
  /** true when some rows' conversions are unknown: conversion totals are a minimum. */
  conversionsAreMinimum: boolean;
}

/** Sums metrics over every row read and adds the derived ratios. */
export const totals = (rows: readonly Metrics[]): Totals => {
  const raw = rows.reduce(addMetrics, ZERO_METRICS);
  const sum = { ...raw, conversions: round(raw.conversions, 2) };
  const costMicros = decimalToMicros(sum.cost);
  return {
    ...sum,
    ctr: sum.impressions > 0 ? round(sum.clicks / sum.impressions, 4) : null,
    averageCpc: moneyPer(sum.cost, sum.clicks),
    costPerConversion: moneyPer(sum.cost, raw.conversions),
    roas:
      costMicros > 0n
        ? round(Number(decimalToMicros(sum.conversionsValue)) / Number(costMicros), 2)
        : null,
    conversionsAreMinimum: false,
  };
};

/** Descending by money string, exact (BigInt). */
export const byMoneyDesc = (a: string, b: string): number => {
  const x = decimalToMicros(a);
  const y = decimalToMicros(b);
  return x === y ? 0 : x > y ? -1 : 1;
};
