// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Interaction matrix — the confounder layer of the audit v3 evidence engine.
 *
 * Spec §3.2 (the matrix), §8.3 (entity map + influence table), §8.4 rule 7
 * ("confounders resolved before firing; unknown blocks STRONG"), build sheet
 * §B (every check row names its confounders by check id).
 *
 * Before a check may fire, every X that can move its Y is evaluated and the
 * answer recorded: `cleared` (X does not explain the signal), `explains`
 * (X does — the check must not fire as stated) or `unknown` (X could not be
 * resolved — STRONG is blocked). The model later reads the record and cannot
 * claim otherwise.
 *
 * Metrics are referenced by their string id through MetricLookup only; this
 * module never imports the registry (wiring is a later integration step).
 */
import type { NodeKind } from "../model/types.js";
import type { AccountModel } from "../model/nodes/AccountNode.js";
import type { SliceDimension } from "../model/nodes/Slice.js";

/** Which entity the check (and therefore the confounder) is about. */
export interface NodeRef {
  kind: NodeKind;
  /** node id inside the model; null for an account-scoped claim. */
  id?: string | null | undefined;
  campaignId?: string | undefined;
  adGroupId?: string | undefined;
  /** slice dimension + value; also parsed out of a slice node id when absent. */
  dimension?: SliceDimension | undefined;
  key?: string | undefined;
  /** which scope the claim is made at — rule 6 pairs the two. */
  scope?: "account" | "campaign" | "adGroup" | undefined;
  /** named window the claim is made over (m30 / mPrior30 / settledWeek / …). */
  window?: string | undefined;
}

/**
 * Narrow view of the metric registry (registry/types.ts is structurally
 * compatible; nothing is imported from it). `reason` discriminates the union.
 */
export interface MetricOkLike {
  id: string;
  value: unknown;
  reason?: undefined | undefined;
  note?: string | undefined;
  source?: { table: string; rowCount?: number } | undefined;
}

export interface NotComputable {
  id: string;
  value: null;
  reason: "not_checkable" | "insufficient_data" | "not_implemented" | "no_entity";
  detail: string;
  /** a stable cause a resolver may branch on (registry NotComputableCode) */
  code?: string | undefined;
}

export type MetricValue = MetricOkLike | NotComputable;

export interface MetricLookup {
  get(id: string, scope?: NodeRef): MetricValue | NotComputable;
}

export function isComputable(v: MetricValue | NotComputable | undefined | null): v is MetricOkLike {
  return v != null && (v as NotComputable).reason === undefined;
}

/** Where a confounder's answer came from — provenance, §8.4 rule 1. */
export interface EvidenceRef {
  kind: "metric" | "node" | "table" | "window";
  /** metric id, node id, AccountData key / * table, or window label. */
  id: string;
  detail?: string | undefined;
}

export type ConfounderState = "cleared" | "explains" | "unknown";

/** What an `explains` answer does to the check (spec §3.2's "effect" column). */
export type ConfounderEffect = "drop" | "transform";

export interface ConfounderResult {
  state: ConfounderState;
  evidence: EvidenceRef[];
  note: string;
  /** filled by resolveConfounders from the matrix entry. */
  id?: string | undefined;
  forCheck?: string | undefined;
  question?: string | undefined;
  /** what `explains` does here; from the matrix entry unless the resolver overrides it. */
  effect?: ConfounderEffect | undefined;
  /** a confounder may cap confidence even when it clears (e.g. unresolvable match type). */
  capsConfidence?: Confidence | undefined;
  /**
   * The campaigns the answer is about, when the resolver knows them (MI01: the
   * campaigns the silent action counted conversions for). Absent = the whole account.
   */
  campaignIds?: string[] | undefined;
}

export type Confidence = "STRONG" | "MODERATE";

export interface ConfounderThresholds {
  /** T.waste_floor — the single money floor . */
  wasteFloor: number;
  /** F.conv_min_for_verdict. */
  convMinForVerdict: number;
  /** conversions/30d a tROAS target needs (bidding ladder). */
  tRoasMinConv30: number;
  /** conversions/30d a tCPA target needs. */
  tCpaMinConv30: number;
  /** trend.decline_pct.audit — 30v30 direction agreement bar. */
  declinePct: number;
  /** device slice click floor (skews.minSegmentClicks). */
  deviceMinClicks: number;
  /** geo / audience / demographic slice click floor. */
  sliceMinClicks: number;
  /** CPA multiple that makes a slice a finding. */
  sliceCpaMultiple: number;
  /** feed disapproval rate that makes the feed the cause. */
  feedDisapprovalPct: number;
  /** share of a slice's cost held by one campaign before the finding belongs to that campaign. */
  sliceScopeConcentration: number;
  /** budget lost-IS bar for "budget-starved" (percent). */
  lostIsBudgetPct: number;
  /** rank lost-IS bar for "rank, not budget" (percent; settings.bidding.lostIsRankPct). */
  lostIsRankPct: number;
  /** budget use at or above which a campaign spends its budget (settings.bidding.scaleUtilMin). */
  scaleUtilMin: number;
  /** util90 below which a target is choking delivery. */
  chokingUtil: number;
  /** target / realised ratio that means choking. */
  chokingTargetRatio: number;
  /** QS at or below which quality is the cause. */
  qsLow: number;
  /** brand share of spend that makes brand the cause. */
  brandSharePct: number;
  /** clicks a zero-conversion campaign needs before "zombie" is STRONG. */
  zombieMinClicks: number;
  /** days paused before a campaign counts as dormant. */
  dormantDays: number;
  /** MI01's own silence bar: the fewest silent days that can count (settings.measurement.silenceMinDays). */
  silenceMinDays: number;
  /** MI01's cap on an action's longest historical gap (settings.measurement.silenceMaxGapDays). */
  silenceMaxGapDays: number;
}

export const DEFAULT_CONFOUNDER_THRESHOLDS: ConfounderThresholds = {
  wasteFloor: 50,
  convMinForVerdict: 3,
  tRoasMinConv30: 30,
  tCpaMinConv30: 15,
  declinePct: 20,
  deviceMinClicks: 30,
  sliceMinClicks: 100,
  sliceCpaMultiple: 2,
  feedDisapprovalPct: 5,
  sliceScopeConcentration: 0.6,
  lostIsBudgetPct: 5,
  lostIsRankPct: 30,
  scaleUtilMin: 0.95,
  chokingUtil: 0.5,
  chokingTargetRatio: 2,
  qsLow: 4,
  brandSharePct: 30,
  zombieMinClicks: 25,
  dormantDays: 30,
  silenceMinDays: 3,
  silenceMaxGapDays: 14,
};

export interface ConfounderContext {
  model: AccountModel;
  metrics: MetricLookup;
  /** the entity the check is about. */
  scope: NodeRef;
  thresholds: ConfounderThresholds;
}

export interface Confounder {
  /** `<checkId>:<confounderId>` — one entry per relationship. */
  id: string;
  /** the check this entry guards. */
  forCheck: string;
  /** the X being resolved (a check id from §B, or an X_* rule from §8.3). */
  confounderId: string;
  /** the question in one sentence, as it is printed beside the finding. */
  question: string;
  /** what an `explains` answer does to the check here. */
  onExplains: ConfounderEffect;
  resolve(ctx: ConfounderContext): ConfounderResult;
}

/** The verdict `confidenceCeiling` returns (binding rule 2). */
export interface ConfidenceVerdict {
  ceiling: Confidence;
  /** fire as stated · transform into the confounder's finding · drop entirely. */
  action: "fire" | "transform" | "drop";
  explains: string[];
  unknown: string[];
  cleared: string[];
  /** the open items printed beside a MODERATE finding. */
  openItems: string[];
}
