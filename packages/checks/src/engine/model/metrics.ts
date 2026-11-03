// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Metrics — the ONE place raw rows become numbers.
 *
 * Rules (task spec + §8.4 rule 9, "one definition per metric"):
 *  - pg NUMERIC / BIGINT arrive as STRINGS (see fixtures/.../MAPPING.md); `num()`
 *    coerces with Number() and returns null for null/''/non-numeric — never NaN.
 *  - a sum over rows is null when NO row carries a numeric value for the field
 *    (the column is absent or unsynced), never 0-for-unknown. Rows that have a
 *    value are summed; rows with null for that field contribute nothing.
 *  - cost from micros where the table stores micros (products.cost_micros,
 *    shopping_cart_data.cost_micros / revenue_micros).
 *  - CPA / ROAS / CTR / CVR / AOV are null when the denominator is 0 or null.
 */
import { makeProvenance, type Provenance, type WindowSpec } from "./provenance.js";

export interface NodeMetrics {
  cost: number | null;
  clicks: number | null;
  impressions: number | null;
  conv: number | null;
  value: number | null;
  /** cost / conv */
  cpa: number | null;
  /** value / cost */
  roas: number | null;
  /** clicks / impressions */
  ctr: number | null;
  /** conv / clicks */
  cvr: number | null;
  /** value / conv */
  aov: number | null;
  provenance: Provenance;
}

/** Column names for the five raw counters. Defaults match the * audit tables. */
export interface FieldMap {
  cost?: string | undefined;
  /** When set, cost = sum(field) / 1e6 and `cost` is ignored. */
  costMicros?: string | undefined;
  clicks?: string | undefined;
  impressions?: string | undefined;
  conv?: string | undefined;
  value?: string | undefined;
  /** When set, value = sum(field) / 1e6 and `value` is ignored. */
  valueMicros?: string | undefined;
}

export const DEFAULT_FIELDS: Required<
  Pick<FieldMap, "cost" | "clicks" | "impressions" | "conv" | "value">
> = {
  cost: "cost",
  clicks: "clicks",
  impressions: "impressions",
  conv: "conversions",
  value: "conversion_value",
};

/** Number() coercion of a pg value. null/undefined/''/NaN → null. */
export function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

/** Micros → currency units. null stays null. */
export function fromMicros(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : n / 1_000_000;
}

/** a / b, null when either is null or b is 0. */
export function ratio(a: number | null, b: number | null): number | null {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

/** Sum of a numeric column; null when no row has a numeric value for it. */
export function sumField(
  rows: readonly any[],
  field: string | undefined,
  divisor = 1,
): number | null {
  if (!field) return null;
  let seen = false;
  let total = 0;
  for (const r of rows) {
    const n = num(r?.[field]);
    if (n == null) continue;
    seen = true;
    total += n;
  }
  return seen ? total / divisor : null;
}

/** Round to 2 dp for money / 4 dp for ratios where a stable printed value matters. Pure helper for tests + writer. */
export function round(n: number | null, dp = 2): number | null {
  if (n == null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Fill the derived ratios from the five counters. */
export function deriveRatios(
  m: Omit<NodeMetrics, "cpa" | "roas" | "ctr" | "cvr" | "aov">,
): NodeMetrics {
  return {
    ...m,
    cpa: ratio(m.cost, m.conv),
    roas: ratio(m.value, m.cost),
    ctr: ratio(m.clicks, m.impressions),
    cvr: ratio(m.conv, m.clicks),
    aov: ratio(m.value, m.conv),
  };
}

/**
 * Aggregate rows into a NodeMetrics for a window. `table` is the provenance
 * table name; `idField` the row id column for rowIds.
 */
export function metricsFromRows(
  rows: readonly any[],
  window: WindowSpec,
  table: string,
  fields: FieldMap = {},
  idField = "id",
  computedFrom?: string[],
): NodeMetrics {
  const f = { ...DEFAULT_FIELDS, ...fields };
  const cost = fields.costMicros
    ? sumField(rows, fields.costMicros, 1_000_000)
    : sumField(rows, f.cost);
  const value = fields.valueMicros
    ? sumField(rows, fields.valueMicros, 1_000_000)
    : sumField(rows, f.value);
  return deriveRatios({
    cost,
    clicks: sumField(rows, f.clicks),
    impressions: sumField(rows, f.impressions),
    conv: sumField(rows, f.conv),
    value,
    provenance: makeProvenance(table, rows, window, idField, computedFrom),
  });
}

/** Metrics object with every field null (no rows). */
export function emptyMetrics(window: WindowSpec, table: string): NodeMetrics {
  return metricsFromRows([], window, table);
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Roll several NodeMetrics (same window) into one. Provenance = computedFrom the inputs' tables. */
export function rollupMetrics(
  parts: readonly NodeMetrics[],
  window: WindowSpec,
  table: string,
): NodeMetrics {
  let cost: number | null = null;
  let clicks: number | null = null;
  let impressions: number | null = null;
  let conv: number | null = null;
  let value: number | null = null;
  let rowCount = 0;
  const from = new Set<string>();
  for (const p of parts) {
    cost = addNullable(cost, p.cost);
    clicks = addNullable(clicks, p.clicks);
    impressions = addNullable(impressions, p.impressions);
    conv = addNullable(conv, p.conv);
    value = addNullable(value, p.value);
    rowCount += p.provenance.rowCount;
    from.add(p.provenance.table);
  }
  return deriveRatios({
    cost,
    clicks,
    impressions,
    conv,
    value,
    provenance: {
      table,
      rowCount,
      window: window.label,
      settledStrict: window.settledStrict,
      settledPractical: window.settledPractical,
      computedFrom: [...from],
    },
  });
}

/** Share of a child's number in its parent's; null when either side is unknown or the parent is 0. */
export function share(child: number | null, parent: number | null): number | null {
  return ratio(child, parent);
}
