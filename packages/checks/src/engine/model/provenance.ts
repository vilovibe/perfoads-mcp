// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Provenance — where every number in the account model came from.
 *
 * Spec (§8.4 rule 1): "No number without a source can reach a finding."
 * The build sheet's node contract (G.0) keeps NodeMetrics as plain numbers so
 * the tree stays readable; the compact equivalent used here is ONE
 * `Provenance` object per NodeMetrics object (per window), not one per leaf:
 * every number inside a NodeMetrics shares the same table, the same rows, the
 * same window and the same maturity, so repeating it per field adds nothing.
 *
 * Maturity has two tiers: `settledStrict`
 * (date <= range_end − max lookback of the actions involved) and
 * `settledPractical` (date <= range_end − 7). Every conversion number carries both.
 *
 *   NodeMetrics = { cost, clicks, ..., roas, provenance: Provenance }
 *
 * `rowIds` is kept when the metrics come from <= MAX_ROW_IDS rows (the usual
 * case: one row per entity); above that only `rowCount` is stored (e.g. tens of
 * thousands of negatives, a 91-row daily series).
 */

export type WindowLabel = "m90" | "m30" | "mPrior30" | "m7" | "settledWeek" | "settledToDate";

export interface WindowSpec {
  label: WindowLabel;
  /** ISO date YYYY-MM-DD, inclusive. null = the window could not be placed (no daily series). */
  start: string | null;
  end: string | null;
  days: number | null;
  /** end <= range_end − max lookback of the conversion actions. false when the lookback is unknown (rule 2: never assume settled). */
  settledStrict: boolean;
  /** end <= range_end − 7 (the practical tier — most conversions have landed). */
  settledPractical: boolean;
}

export interface Provenance {
  /** AccountData key or * table the rows came from (e.g. 'campaigns', 'placement_performance'). */
  table: string;
  /** Number of rows aggregated into this metrics object. 0 = no rows → every field null. */
  rowCount: number;
  /** Row ids (the table's `id` column, or the entity key when there is no `id`) when rowCount <= MAX_ROW_IDS. */
  rowIds?: string[] | undefined;
  window: WindowLabel;
  /** Conversion numbers in this object are settled by the strict rule (window end <= range_end − max lookback). */
  settledStrict: boolean;
  /** … and by the practical rule (window end <= range_end − 7). */
  settledPractical: boolean;
  /** Other tables this object was derived from (e.g. account rollup = campaigns rows). */
  computedFrom?: string[] | undefined;
}

export const MAX_ROW_IDS = 25;

export function makeProvenance(
  table: string,
  rows: readonly any[],
  window: WindowSpec,
  idField: string = "id",
  computedFrom?: string[],
): Provenance {
  const p: Provenance = {
    table,
    rowCount: rows.length,
    window: window.label,
    settledStrict: window.settledStrict,
    settledPractical: window.settledPractical,
  };
  if (rows.length > 0 && rows.length <= MAX_ROW_IDS) {
    const ids = rows
      .map((r) => (r && r[idField] != null ? String(r[idField]) : null))
      .filter((x): x is string => x != null);
    if (ids.length === rows.length) p.rowIds = ids;
  }
  if (computedFrom && computedFrom.length) p.computedFrom = computedFrom;
  return p;
}
