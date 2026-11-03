// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Confidence — handover rule 2 and §8.4 rule 8.
 *
 *   STRONG      every input settledStrict, nothing truncated, a real population,
 *               every floor met, every confounder cleared
 *   MODERATE    settledPractical only, or any named open item
 *   HYPOTHESIS  the model pass only — the engine never returns it, and a model
 *               claim never returns anything else. A hypothesis has had no
 *               confounder analysis, so rule 2's third condition can never be
 *               met however clean its numbers are. See the `fromModelPass` block
 *               below (Phase 2, D3, reversed on review).
 *
 * The reasons ARE the product: "in the past it was giving findings stated as
 * truth but with very shaky fundaments." A MODERATE always prints its open
 * items beside the finding.
 */
import type {
  Confidence,
  ConfounderSummary,
  FloorCheck,
  ImpactInput,
  MetricValue,
  NotComputable,
  SampleSummary,
} from "./types.js";
import { isNotComputable } from "./types.js";

export interface ConfidenceInput {
  /** Every metric the check consumed — impact inputs plus the signal's own metrics. */
  inputs: Array<ImpactInput | MetricValue | NotComputable>;
  sample: SampleSummary;
  floors?: FloorCheck[] | undefined;
  confounders?: ConfounderSummary[] | undefined;
  /** Anything else the check knows is open (e.g. "match type unresolvable until Phase 1b"). */
  openItems?: string[] | undefined;
  /** The check declares it can never reach STRONG (e.g. SK01, capped at MODERATE by construction). */
  capAtModerate?: boolean | undefined;
  /** Set only by the hypothesis pass. */
  fromModelPass?: boolean | undefined;
}

export interface ConfidenceResult {
  level: Confidence;
  reasons: string[];
  /** The named open items that kept it below STRONG. */
  openItems: string[];
}

function isMetricValue(i: ImpactInput | MetricValue): i is MetricValue {
  return !("metric" in i);
}

function settledOf(
  i: ImpactInput | MetricValue | NotComputable,
): { id: string; strict: boolean; practical: boolean } | null {
  if (isNotComputable(i)) return null;
  if ("metric" in i)
    return { id: i.metric, strict: i.settledStrict, practical: i.settledPractical };
  return { id: i.id, strict: i.settledStrict, practical: i.settledPractical };
}

/**
 * Handover rules 3 and 9: a MetricValue carries its OWN truncation, population
 * and floors. Reading only the candidate-level sample let a truncated,
 * orphan-only input with an unmet floor still come out STRONG.
 */
function openItemsOfInput(i: ImpactInput | MetricValue): string[] {
  if (!isMetricValue(i)) return [];
  const out: string[] = [];
  if (i.truncated) out.push(`${i.id} came from a capped fetch — it is a sample, not a total`);
  if (i.population === "orphan_only")
    out.push(`${i.id} is built from rows that join no node of this audit`);
  else if (i.population === "unknown") out.push(`${i.id} has an unknown population`);
  for (const f of i.floors ?? []) {
    if (!f.met)
      out.push(`${i.id} sample floor not met: ${f.metric} ${f.actual ?? "null"} < ${f.required}`);
  }
  return out;
}

/**
 * The open item every model-proposed claim carries, whatever else is true of it.
 * It is not a defect in the evidence — it is the fact that no rulebook check
 * stands behind the claim, and the reader is entitled to know that.
 */
export const MODEL_PASS_NOTE = "proposed by the model pass; no rulebook check backs this claim";

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const open: string[] = [...(input.openItems ?? [])];
  const reasons: string[] = [];

  for (const raw of input.inputs) {
    const s = settledOf(raw);
    if (!s) {
      open.push(`${(raw as NotComputable).id} not computable: ${(raw as NotComputable).reason}`);
      continue;
    }
    if (!s.strict) {
      open.push(
        s.practical ? `${s.id} is settled only by the practical rule` : `${s.id} is unsettled`,
      );
    }
    open.push(...openItemsOfInput(raw as ImpactInput | MetricValue));
  }

  if (input.sample.truncated)
    open.push("a capped fetch fed this claim — the numbers are a sample, not a total");
  if (input.sample.population === "orphan_only")
    open.push("the rows behind this claim join no node of this audit");
  else if (input.sample.population === "unknown")
    open.push("the population behind this claim is unknown");

  for (const f of input.floors ?? []) {
    if (!f.met)
      open.push(`sample floor not met: ${f.metric} ${f.actual ?? "null"} < ${f.required}`);
  }

  for (const c of input.confounders ?? []) {
    if (c.state !== "cleared") open.push(`confounder ${c.id} is ${c.state}`);
  }

  /**
   * The model pass — audit v3 Phase 2, D3, REVERSED after review.
   *
   * The first cut tried to reconcile spec §3.4 ("passing hypotheses become
   * candidates, confidence MODERATE") with §8.4 rule 8 ("HYPOTHESIS only from the
   * model pass") by awarding MODERATE when code had proved every clause on
   * settled data. That tier turned out to be unreachable, and correctly so: a
   * hypothesis has had NO confounder analysis — there is no rulebook check to
   * declare what would explain it away, so nothing was ruled out — and
   * `toCandidate` therefore always passes that as an open item.
   *
   * Rule 2 settles it: a finding is stated as fact only when every input is
   * settled, every floor is met and EVERY CONFOUNDER IS CLEARED. A model claim
   * can never satisfy the third, so HYPOTHESIS is not a consolation tier for it,
   * it is the accurate one. §3.4's MODERATE is superseded.
   *
   * What did change from the original: the caller's open items are PRESERVED
   * rather than dropped. The reasons are the product — a hypothesis that prints
   * "no confounder analysis was run" and "a source table has no sync marker" is
   * doing its job.
   */
  if (input.fromModelPass) {
    return {
      level: "HYPOTHESIS",
      reasons: ["proposed by the model pass, not computed", MODEL_PASS_NOTE, ...open],
      openItems: [MODEL_PASS_NOTE, ...open],
    };
  }

  if (open.length === 0 && !input.capAtModerate) {
    reasons.push(
      "every input settled, nothing truncated, real population, floors met, confounders cleared",
    );
    return { level: "STRONG", reasons, openItems: [] };
  }

  if (input.capAtModerate) open.push("the check is capped at MODERATE by construction");
  reasons.push(`MODERATE: ${open.length} open item${open.length === 1 ? "" : "s"}`);
  return { level: "MODERATE", reasons: [...reasons, ...open], openItems: open };
}
