// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Running the interaction matrix, and what its answers do to a check.
 *
 * Binding rule 2 (handover §6) in code:
 *   - any `unknown` blocks STRONG (§8.4 rule 7) — the ceiling becomes MODERATE
 *     and the open items are printed beside the finding;
 *   - any `explains` means the check must NOT fire as stated: it either drops
 *     or transforms into the confounder's finding, and this returns which.
 */
import { confoundersFor } from "./matrix.js";
import type { ConfidenceVerdict, ConfounderContext, ConfounderResult } from "./types.js";

/**
 * Resolve every confounder of `checkId` against this context, in matrix order.
 * A resolver that throws is recorded as `unknown` — a broken resolver may never
 * clear the way for a STRONG finding.
 */
export function resolveConfounders(
  checkId: string,
  ctx: ConfounderContext,
  declared?: readonly string[],
): ConfounderResult[] {
  const resolved = confoundersFor(checkId).map((c) => {
    let r: ConfounderResult;
    try {
      r = c.resolve(ctx);
    } catch (err) {
      r = {
        state: "unknown",
        evidence: [],
        note: `Confounder ${c.confounderId} could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      ...r,
      id: c.id,
      forCheck: c.forCheck,
      question: c.question,
      effect: r.effect ?? c.onExplains,
    };
  });

  // A confounder the check DECLARES but the matrix has no resolver for used to
  // vanish here, so the finding reported "every confounder cleared" when one was
  // never examined. Binding rule 2: unchecked is not cleared. Recording it as
  // `unknown` caps confidence at MODERATE, prints it as an open item, and lets
  // "never critical with an unresolved confounder" do its job.
  //
  // This is not hypothetical: MI01 (`tracking.primary_action_silent`, ceiling
  // critical) declares TR01 — "did it recover?" — which is exactly the check the
  // original report skipped when it published the false headline.
  const present = new Set(resolved.map((r) => r.id));
  const missing = (declared ?? [])
    .filter((cid) => !present.has(`${checkId}:${cid}`))
    .map((cid): ConfounderResult => ({
      state: "unknown",
      evidence: [],
      note: `declared confounder ${cid} has no resolver in the interaction matrix — it was never checked, so it is not cleared`,
      id: `${checkId}:${cid}`,
      forCheck: checkId,
      question: `${cid}: declared by ${checkId} but unimplemented`,
      effect: "drop",
    }));

  return [...resolved, ...missing];
}

/**
 * The confidence ceiling and the action the check must take.
 * `drop` wins over `transform`: if any confounder says the finding cannot exist,
 * restating it is not an option.
 */
export function confidenceCeiling(results: ConfounderResult[]): ConfidenceVerdict {
  const explains = results.filter((r) => r.state === "explains");
  const unknowns = results.filter((r) => r.state === "unknown");
  const cleared = results.filter((r) => r.state === "cleared");

  const capped = results.some((r) => r.capsConfidence === "MODERATE");
  const ceiling = unknowns.length > 0 || capped ? "MODERATE" : "STRONG";

  let action: ConfidenceVerdict["action"] = "fire";
  if (explains.some((r) => r.effect === "drop")) action = "drop";
  else if (explains.length > 0) action = "transform";

  const openItems = [
    ...unknowns.map((r) => `${r.id ?? "confounder"}: ${r.note}`),
    ...results
      .filter((r) => r.state === "cleared" && r.capsConfidence === "MODERATE")
      .map((r) => `${r.id ?? "confounder"}: ${r.note}`),
  ];

  return {
    ceiling,
    action,
    explains: explains.map((r) => r.id ?? ""),
    unknown: unknowns.map((r) => r.id ?? ""),
    cleared: cleared.map((r) => r.id ?? ""),
    openItems,
  };
}

/** Convenience: resolve and judge in one call. */
export function resolveAndJudge(
  checkId: string,
  ctx: ConfounderContext,
  declared?: readonly string[],
): { results: ConfounderResult[]; verdict: ConfidenceVerdict } {
  const results = resolveConfounders(checkId, ctx, declared);
  return { results, verdict: confidenceCeiling(results) };
}
