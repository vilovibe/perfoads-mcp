// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Scoring layer types — the candidate finding and everything it carries.
 *
 * Contract = spec §3.1 (Candidate), §3.3 (severity/impact computed, not chosen),
 * §8.4 rules 1-9 (provenance, maturity, floors, population, confounders).
 *
 * Phase 1f owns ONLY this folder. The metric registry (`evidence/registry`) and
 * the interaction matrix (`evidence/interactions`) are built by other agents, so
 * everything they will supply is consumed through the two narrow interfaces
 * declared here (`MetricLookup`, `ConfounderSummary`) and nothing is imported
 * from those folders.
 *
 * Never a bare number: an impact carries its formula id and the metric ids it
 * consumed, so the writer can only cite what was actually computed.
 */
import type { NodeKind } from "../model/types.js";

/** Where a metric / candidate is measured. Mirrors the account model's node identity. */
export interface NodeRef {
  kind: NodeKind;
  id: string;
  name?: string | undefined;
  /**
   * The campaign this node sits inside, when it has one . A slice / ad group / landing page finding must be priced
   * against ITS campaign's baseline: while this was dropped in translation,
   * every slice resolved `C.cpa` as `no_entity` and fell back to the ACCOUNT
   * CPA, and the error is unbounded in the overstating direction.
   */
  campaignId?: string | undefined;
  campaignName?: string | undefined;
}

export type MetricUnit = "usd" | "pct" | "ratio" | "count" | "days" | "date" | "enum" | "bool";

/** Whether the rows behind a number are the real population or only orphans (§8.4 rule 5, handover rule 3). */
export type PopulationState = "real" | "orphan_only" | "unknown";

export interface FloorCheck {
  metric: string;
  required: number;
  actual: number | null;
  met: boolean;
}

/**
 * One value out of the metric registry. Both settled tiers travel with the
 * number (handover rule 6): `settledStrict` = range_end − max lookback,
 * `settledPractical` = range_end − 7.
 */
export interface MetricValue {
  id: string;
  value: number | string | boolean | null;
  unit?: MetricUnit | undefined;
  settledStrict: boolean;
  settledPractical: boolean;
  /** A capped fetch fed this number; it is a sample, never an account total (§8.4 rule 4). */
  truncated?: boolean | undefined;
  population?: PopulationState | undefined;
  floors?: FloorCheck[] | undefined;
  source?: { table: string; rowCount?: number } | undefined;
}

/** The registry could not produce the metric here, and says why (never 0-for-unknown). */
export interface NotComputable {
  id: string;
  notComputable: true;
  reason: string;
}

export function isNotComputable<T>(v: T | NotComputable | null | undefined): v is NotComputable {
  return !!v && (v as NotComputable).notComputable === true;
}

/** The only surface the scoring layer uses to read metrics. Implemented by the registry. */
export interface MetricLookup {
  get(id: string, scope?: NodeRef): MetricValue | NotComputable;
}

/** One confounder's answer, as recorded by the interaction matrix (§3.2, §8.4 rule 7). */
export interface ConfounderSummary {
  state: "cleared" | "explains" | "unknown";
  id: string;
  /**
   * The campaigns the confounder's answer is about (e.g. the campaigns a silent
   * conversion action counted for). Absent = the whole account.
   */
  campaignIds?: readonly string[] | undefined;
}

export type Severity = "critical" | "warning" | "opportunity" | "positive" | "info";
export type Confidence = "STRONG" | "MODERATE" | "HYPOTHESIS";

export type ImpactFormulaId =
  | "IMP_WASTE_90"
  | "IMP_WASTE_30"
  | "IMP_SCALE"
  | "IMP_LOSTIS"
  | "IMP_CPA_GAP"
  | "IMP_VALUE_GAP"
  | "IMP_MEASUREMENT"
  | "IMP_STRUCTURAL"
  | "IMP_NONE";

export type ImpactKind = "waste" | "at_risk" | "gain";

/** A metric the formula actually consumed. The writer may cite these ids and nothing else. */
export interface ImpactInput {
  metric: string;
  value: number | null;
  settledStrict: boolean;
  settledPractical: boolean;
}

/**
 * The money on a candidate. `value` is the monthly figure (the unit every
 * severity comparison uses); `annual` is 12 × monthly and is emitted ONLY when
 * the monthly figure is itself settled.
 */
export interface Impact {
  formulaId: ImpactFormulaId;
  /** Monthly USD-scale figure, always in SPEND units (never a sales value). null = not quantifiable (IMP_NONE). */
  value: number | null;
  /**
   * What the money is: `waste` (spent with nothing to show), `at_risk` (real
   * spend or margin at stake, not wasted) or `gain` (upside not yet taken).
   * Absent when nothing is priced.
   */
  kind?: ImpactKind | undefined;
  currency: string;
  inputs: ImpactInput[];
  /** 12 × value, only when `settled` is true. */
  annual: number | null;
  /** Every input is settled by the strict rule. */
  settled: boolean;
  /** False for IMP_NONE and for IMP_STRUCTURAL (which carries no dollar claim). */
  quantified: boolean;
  /** Why the value is what it is — including why it is null. */
  reasons: string[];
}

/** Reference back into the evidence array; the id is the citable handle. */
export interface EvidenceRef {
  id: string;
  metric: string;
  scope?: NodeRef | undefined;
}

/** §8.4 rule 4 + handover rule 3: sampled is labelled, orphan-only is not a population. */
export interface SampleSummary {
  truncated: boolean;
  /** THE ENUM WINS. A check that carries a row count puts it in `populationRows`. */
  population: PopulationState;
  /** How many rows the population actually held, when the check counted them. */
  populationRows?: number | undefined;
  rowsSeen?: number | undefined;
  cap?: number | undefined;
}

/**
 * Adapter for the check layer, whose `sample.population` is a COUNT while the
 * scoring layer's is a state. The enum is the contract: a positive count means
 * `real`, zero or missing means `unknown` (never "none found" — §8.4 rule 5),
 * and the number is kept beside it as `populationRows`.
 */
export function toSampleSummary(sample: {
  truncated?: boolean | undefined;
  population?: number | PopulationState | undefined;
  rowsSeen?: number | undefined;
  cap?: number | undefined;
}): SampleSummary {
  const p = sample.population;
  const out: SampleSummary = {
    truncated: sample.truncated === true,
    population: typeof p === "number" ? (p > 0 ? "real" : "unknown") : (p ?? "unknown"),
  };
  if (typeof p === "number") out.populationRows = p;
  if (sample.rowsSeen != null) out.rowsSeen = sample.rowsSeen;
  if (sample.cap != null) out.cap = sample.cap;
  return out;
}

/** Handover rule 6: both settled tiers, always. */
export interface SettledSummary {
  strict: boolean;
  practical: boolean;
}

export interface NotCheckableReason {
  checkId: string;
  reason: string;
}

/** Spec §3.1 — the candidate finding. Severity, impact and confidence are computed, never chosen. */
export interface Candidate {
  checkId: string;
  claimKey: string;
  scope: NodeRef;
  evidence: EvidenceRef[];
  impact: Impact;
  severity: Severity;
  confidence: Confidence;
  confounders: ConfounderSummary[];
  sample: SampleSummary;
  settled: SettledSummary;
  /** Set when the check could not run here; the report says so by name (§E.2). */
  notCheckable?: NotCheckableReason | undefined;
  /** Why the severity came out where it did — printed beside the finding. */
  severityReasons?: string[] | undefined;
  /** The open items that kept confidence below STRONG (handover rule 2). */
  confidenceReasons?: string[] | undefined;
}
