// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The client's stated gross margin (intake form, ecommerce only) and the
 * break-even return on ad spend it implies.
 *
 * Asked as "roughly what share of each sale is left after product cost and
 * shipping, before ads?" and stored as `strategic_context.grossMarginPct`
 * (a whole-number percent, 1-95). Break-even ROAS = 1 / margin: at a 30%
 * margin every 1 spent on ads must bring back 3.33 in sales just to cover
 * the product cost.
 *
 * Pure, no imports: the questionnaire route, the client-context loader, the
 * evidence checks and the legacy prompt builders all read it from here.
 */

export const GROSS_MARGIN_MIN_PCT = 1;
export const GROSS_MARGIN_MAX_PCT = 95;

/**
 * The margin as a number in 1-95, or null when absent / unreadable.
 * Accepts a numeric string ("30", "30%") because older JSON may hold one.
 */
export function parseGrossMarginPct(v: unknown): number | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" ? Number(v.replace("%", "").trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  if (n < GROSS_MARGIN_MIN_PCT || n > GROSS_MARGIN_MAX_PCT) return null;
  return n;
}

/** Break-even ROAS for a margin in percent (30 -> 3.333...). */
export function breakEvenRoas(marginPct: number): number {
  return 100 / marginPct;
}
