// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Per-check severity policy.
 *
 * `computeSeverity` (scoring/severity.ts) needs six inputs per check that live
 * on no check object: `integrity`, `structural`, `positive`, `opportunity`,
 * `maxSeverity` and `declaredConfounders`. Five of them are here, one row per
 * check. `declaredConfounders` is the check's own `confounders[]`, and the
 * runner passes it straight through: leaving it undefined makes computeSeverity
 * fail closed and demote every critical to a warning.
 *
 * Derivation rules, applied mechanically:
 *   maxSeverity   a CEILING, never a floor. A `warning` row stays a warning
 *                 even when the money says critical.
 *   sheetBase     a FLOOR, only where nothing else can reach the row's own
 *                 severity (a warning with no money and no flag).
 *   positive      the row states a healthy signal
 *   opportunity   the row's severity is `opportunity` or `info`
 *   structural    impact = `IMP_STRUCTURAL`
 *   integrity     measurement checks, plus any `IMP_MEASUREMENT` row
 *   emit          `false` for rows that are context or a confounder feed,
 *                 never a finding of their own. They still RUN and still feed
 *                 the confounder matrix; they are never returned as candidates.
 */
import type { Severity } from "../scoring/types.js";

export interface CheckSeverityPolicy {
  /** Ceiling from the §B severity cell. Never raises a severity, only caps it. */
  maxSeverity: Severity;
  /**
   * FLOOR from the same §B severity cell, set ONLY on the rows where nothing
   * else can reach it: severity `warning`/`critical`, impact `IMP_NONE`, and
   * not integrity / structural / positive / opportunity. For those rows
   * (AS01, AS03, BB03, SK02, SH15, SH21) §1.2's derivation leaves every flag false, so
   * `computeSeverity` fell to `info` and the sheet's declared warning was
   * structurally unreachable. Still capped by `maxSeverity`.
   */
  sheetBase?: Severity | undefined;
  /**
   * A LOWER ceiling for one claim key this check shares with a specialist, when
   * the check's own `maxSeverity` belongs to a different key it emits. SH21: its
   * margin leg (`campaign.below_breakeven_after_margin`) may reach `warning`,
   * while `product.cogs_missing` — the data-gap claim the feed specialist files —
   * stays `info`. Read by `specialistSeverityCeiling`.
   */
  maxSeverityByClaimKey?: Readonly<Record<string, Severity>> | undefined;
  /** B.1, or an IMP_MEASUREMENT impact: measurement / attribution integrity. */
  integrity: boolean;
  /** Policy, disapproval, a missing setting or list — no dollar claim. */
  structural: boolean;
  /** States a healthy signal. */
  positive: boolean;
  /** Positive expected value (scale, revive, add). */
  opportunity: boolean;
  /** `false` = runs and feeds confounders, but is NEVER returned as a candidate. */
  emit: boolean;
}

/** The shipped checks that are context feeds, never a finding of their own. */
export const NON_EMITTING_CHECKS: readonly string[] = [
  "MI08",
  "MI09",
  "BB01",
  "SK06",
  "TR02",
  "TR04",
  "SH18",
];

export const SEVERITY_POLICY: Readonly<Record<string, CheckSeverityPolicy>> = {
  /** B.3 BB01 · sheet severity: info (context, not a finding on its own) · impact: IMP_NONE */
  BB01: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: false,
  },
  /** B.3 BB02 · sheet severity: warning · impact: IMP_LOSTIS */
  BB02: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** B.3 BB03 · sheet severity: warning · impact: IMP_NONE */
  BB03: {
    maxSeverity: "warning",
    sheetBase: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** B.3 BB04 · sheet severity: warning · impact: IMP_STRUCTURAL */
  BB04: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** B.3 BB05 · sheet severity: warning · impact: IMP_SCALE */
  BB05: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** B.3 BB06 · sheet severity: opportunity · impact: IMP_STRUCTURAL */
  BB06: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** B.3 BB07 · sheet severity: opportunity · impact: IMP_SCALE */
  BB07: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** B.3 BB08 · sheet severity: info · impact: IMP_NONE */
  BB08: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** B.3 BB09 · sheet severity: warning · impact: IMP_CPA_GAP */
  BB09: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** B.3 BB10 · sheet severity: info · impact: IMP_NONE */
  BB10: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** B.3 BB11 · sheet severity: info · impact: IMP_NONE */
  BB11: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** B.4 SK01 · sheet severity: warning · impact: IMP_WASTE_90 */
  SK01: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** B.4 SK02 · sheet severity: warning · impact: IMP_NONE */
  SK02: {
    maxSeverity: "warning",
    sheetBase: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** B.4 SK03 · sheet severity: info · impact: IMP_NONE */
  SK03: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** B.4 SK04 · sheet severity: info · impact: IMP_NONE */
  SK04: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** B.4 SK05 · sheet severity: warning · impact: IMP_WASTE_90 */
  SK05: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** plan 5.2 BB14 (Gate 1 row 4) · bids on conversion count while order value is tracked · warning · impact: IMP_STRUCTURAL */
  BB14: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** R3.8 BB15 · clicks on your own brand name cost more than they usually should (relative to the account's non-brand CPC) · warning · impact: IMP_STRUCTURAL */
  BB15: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** R3.8 BB16 · budget-limited campaign on a target looser than its results (17 Aug 2026 change) · warning · impact: IMP_STRUCTURAL */
  BB16: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** R4-D BB17 · Smart Bidding re-learning after a recent target / strategy change · info (a note) · impact: IMP_NONE */
  BB17: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  MI01: {
    maxSeverity: "critical",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  MI03: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  MI04: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  MI05: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  MI06: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  MI07: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  MI08: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: false,
  },
  MI09: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: false,
  },
  MI10: {
    maxSeverity: "opportunity",
    integrity: true,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  MI11: {
    maxSeverity: "positive",
    integrity: true,
    structural: false,
    positive: true,
    opportunity: false,
    emit: true,
  },
  MI12: {
    maxSeverity: "warning",
    integrity: true,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  MI14: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  MI16: {
    maxSeverity: "critical",
    integrity: true,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  MI18: {
    maxSeverity: "warning",
    integrity: true,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  AS01: {
    maxSeverity: "critical",
    sheetBase: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  AS02: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** AS03 · ceiling warning · impact: IMP_NONE (its own lost share is BB02's money, never priced twice) */
  AS03: {
    maxSeverity: "warning",
    sheetBase: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  AS04: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  AS06: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  AS07: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  AS08: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  AS09: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  AS10: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  AS13: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** M18 AS24 (J40) · a spending account with fewer than 5 changes a month for 2+ months · warning · impact: IMP_NONE */
  AS24: {
    maxSeverity: "warning",
    sheetBase: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  AS14: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  AS15: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  AS16: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  AS17: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  SK06: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: false,
  },
  SK07: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  SK08: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  SK09: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  SK10: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  SK11: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  SK12: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  SK13: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  SK14: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  SK15: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  SK16: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  SK17: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  SK18: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SK19 · ceiling info · impact: IMP_NONE (round 5: no page is fetched, so an http link is a note, never priced) */
  SK19: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  SK20: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  SK21: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  SK22: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  SK26: {
    maxSeverity: "critical",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  SK27: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  SK28: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  SK30: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  SK32: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  SK33: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  SK35: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** M18 SK42 (J41) · a live Search ad mixes Title Case and sentence case headlines · opportunity · impact: IMP_STRUCTURAL */
  SK42: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX01 · ceiling warning · impact: IMP_WASTE_90 */
  PX01: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX02 · ceiling warning · impact: IMP_WASTE_90 */
  PX02: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX03 · ceiling warning · impact: IMP_STRUCTURAL */
  PX03: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX06 · ceiling warning · impact: IMP_STRUCTURAL */
  PX06: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX08 · ceiling info · impact: IMP_STRUCTURAL */
  PX08: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** PX09 · ceiling warning · impact: IMP_STRUCTURAL */
  PX09: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX10 · ceiling info · impact: IMP_STRUCTURAL */
  PX10: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  PX14: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SL01 · ceiling info · impact: IMP_CPA_GAP */
  SL01: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SL02 · ceiling opportunity · impact: IMP_STRUCTURAL */
  SL02: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SL04 · ceiling info · impact: IMP_WASTE_90 */
  SL04: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SL05 · ceiling info · impact: IMP_CPA_GAP */
  SL05: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SL06 · ceiling info · impact: IMP_WASTE_90 */
  SL06: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SL07 · ceiling info · impact: IMP_CPA_GAP */
  SL07: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** TR01 · ceiling warning · impact: IMP_VALUE_GAP */
  TR01: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** TR01a · ceiling warning · impact: IMP_VALUE_GAP */
  TR01a: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** TR02 · ceiling info · impact: IMP_NONE */
  TR02: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: false,
  },
  TR03: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** TR04 · ceiling info · impact: IMP_NONE */
  TR04: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: false,
  },
  /** TR05 · ceiling opportunity · impact: IMP_NONE */
  TR05: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** TR06 · ceiling critical · impact: IMP_WASTE_90 */
  TR06: {
    maxSeverity: "critical",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** TR07 · ceiling info · impact: IMP_WASTE_90 */
  TR07: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** TR08 · ceiling positive · impact: IMP_NONE */
  TR08: {
    maxSeverity: "positive",
    integrity: false,
    structural: false,
    positive: true,
    opportunity: false,
    emit: true,
  },
  /** TR09 · ceiling info · impact: IMP_NONE (numbers only, round 3 R4) */
  TR09: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /**
   * TR10 · warning · impact: IMP_NONE (round 4 R16: numbers only, never priced, so it never
   * doubles the money other checks price). Floor warning; a campaign under a tenth of the
   * account's spend carries its own info ceiling.
   */
  TR10: {
    maxSeverity: "warning",
    sheetBase: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PR01 · ceiling info · impact: IMP_STRUCTURAL */
  PR01: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** PR02 · ceiling info · impact: IMP_NONE */
  PR02: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** MI13 · ceiling warning · impact: IMP_MEASUREMENT */
  MI13: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** AS12 · ceiling opportunity · impact: IMP_NONE */
  AS12: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** BB12 · ceiling info · impact: IMP_NONE (lost share to budget is BB02's money, never copied) */
  BB12: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** BB13 · ceiling warning · impact: IMP_STRUCTURAL */
  BB13: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX17 · ceiling warning · impact: IMP_STRUCTURAL */
  PX17: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX18 · ceiling info · impact: IMP_STRUCTURAL */
  PX18: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** PX19 · ceiling warning · impact: IMP_STRUCTURAL */
  PX19: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX20 · ceiling warning · impact: IMP_STRUCTURAL */
  PX20: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX21 · ceiling opportunity · impact: IMP_STRUCTURAL */
  PX21: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SK24 · ceiling info · impact: IMP_NONE */
  SK24: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SK25 · ceiling info · impact: IMP_STRUCTURAL */
  SK25: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SL09 · ceiling info · impact: IMP_CPA_GAP */
  SL09: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** PX13 · ceiling warning · impact: IMP_STRUCTURAL */
  PX13: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  PX12: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SK23 · ceiling info · impact: IMP_NONE */
  SK23: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SH01 · ceiling warning */
  SH01: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SH02 · ceiling warning */
  SH02: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SH03 · ceiling info */
  SH03: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SH04 · ceiling warning */
  SH04: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SH05 · ceiling opportunity */
  SH05: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SH06 · ceiling warning */
  SH06: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SH08 · ceiling info */
  SH08: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SH09 · ceiling warning */
  SH09: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SH10 · ceiling info */
  SH10: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SH11 · ceiling info */
  SH11: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SH12 · ceiling info */
  SH12: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SH13 · ceiling opportunity */
  SH13: {
    maxSeverity: "opportunity",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SH14 · ceiling warning */
  SH14: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SH15 · ceiling warning */
  SH15: {
    maxSeverity: "warning",
    sheetBase: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SH17 · ceiling info */
  SH17: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SH18 · ceiling info */
  SH18: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: false,
  },
  /** SH19 · ceiling info */
  SH19: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SH20 · ceiling warning */
  SH20: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SH21 · ceiling warning */
  SH21: {
    maxSeverity: "warning",
    sheetBase: "warning",
    maxSeverityByClaimKey: { "product.cogs_missing": "info" },
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SH22 · ceiling info */
  SH22: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** SH23 · ceiling warning */
  SH23: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SH24 · ceiling info */
  SH24: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** M15 SH26 · ceiling warning · a store ranking factor is weak */
  SH26: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** M15 SH27 · ceiling warning · best sellers with fewer than 3 photos */
  SH27: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** M15 SH28 · ceiling warning · products with no product type (barcodes are not checked here) */
  SH28: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** M15 SH29 · ceiling info · best sellers with no product highlights or details */
  SH29: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** PX05 · ceiling warning */
  PX05: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX07 · ceiling warning */
  PX07: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX11 · ceiling warning */
  PX11: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX15 · ceiling warning */
  PX15: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PX16 · ceiling warning */
  PX16: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SL03 · ceiling warning */
  SL03: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SL10 · ceiling warning */
  SL10: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SL11 · ceiling warning */
  SL11: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** SL12 · ceiling info */
  SL12: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** PR03 · ceiling info */
  PR03: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PR04 · ceiling warning */
  PR04: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PR05 · ceiling warning */
  PR05: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PR06 · ceiling warning */
  PR06: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** PR07 · ceiling warning */
  PR07: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** VD01 · ceiling info */
  VD01: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** VD02 · ceiling info */
  VD02: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** VD03 · ceiling warning */
  VD03: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** VD04 · ceiling warning */
  VD04: {
    maxSeverity: "warning",
    integrity: true,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** VD05 · ceiling info */
  VD05: {
    maxSeverity: "info",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** VD06 · ceiling info */
  VD06: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** VD07 · ceiling info */
  VD07: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** DG01 · ceiling warning */
  DG01: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** DG02 · ceiling warning */
  DG02: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** DG03 · ceiling warning */
  DG03: {
    maxSeverity: "warning",
    integrity: false,
    structural: true,
    positive: false,
    opportunity: false,
    emit: true,
  },
  /** DG04 · ceiling info */
  DG04: {
    maxSeverity: "info",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: true,
    emit: true,
  },
  /** DG06 · ceiling warning */
  DG06: {
    maxSeverity: "warning",
    integrity: false,
    structural: false,
    positive: false,
    opportunity: false,
    emit: true,
  },
};

/** Policy for a §B check id. Throws: a check with no policy row must never be scored. */
export function severityPolicyFor(checkId: string): CheckSeverityPolicy {
  const p = SEVERITY_POLICY[checkId];
  if (!p) throw new Error(`severityPolicy: no policy row for check ${checkId}`);
  return p;
}

export function emits(checkId: string): boolean {
  return severityPolicyFor(checkId).emit;
}
