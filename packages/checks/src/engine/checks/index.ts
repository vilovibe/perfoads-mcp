// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The check collector. The group consts are the only place a check is
 * declared; this module is the only place they are joined. Nothing here runs a
 * check: it collects them and indexes them by id.
 *
 * The collector's invariants (unique ids, known claim keys, known impact
 * formulas, every declared confounder resolvable or named as unresolvable) are
 * checked by `collectorProblems()`, which the test suite asserts is empty. They
 * are not asserted at import, so a library user never pays for them and a
 * broken registry fails the build, not a running server.
 */
import { confoundersFor } from "../interactions/matrix.js";
import { isKnownClaimKey } from "../registry/claimKeys.js";
import { IMPACT_FORMULA_IDS } from "../scoring/impact.js";
import { BUDGET_BIDDING_CHECKS } from "./budgetBidding.js";
import { CARRIED_IN_CHECKS } from "./carriedIn.js";
import { CROSS_TREE_CHECKS } from "./crossTree.js";
import { DEMAND_GEN_CHECKS } from "./demandGen.js";
import { MEASUREMENT_CHECKS } from "./measurement.js";
import { PMAX_CHECKS } from "./pmax.js";
import { PRESENCE_CHECKS } from "./presence.js";
import { SEARCH_CHECKS } from "./search.js";
import { SEARCH_KEYWORD_CHECKS } from "./searchKeywords.js";
import { SHOPPING_CHECKS } from "./shopping.js";
import { SLICE_CHECKS } from "./slices.js";
import { STRUCTURE_CHECKS } from "./structure.js";
import { TREND_CHECKS } from "./trends.js";
import { VIDEO_CHECKS } from "./video.js";
import type { CheckDefinition, CheckGroup } from "./types.js";

export interface CheckGroupEntry {
  group: CheckGroup;
  checks: readonly CheckDefinition[];
}

/**
 * Group order: measurement first (every one of its checks is a confounder elsewhere), then
 * structure, budget and bidding, search, Performance Max, Shopping, slices, trends,
 * presence, the carried-in checks (each keeps its subject group), the cross-tree checks,
 * Demand Gen and video.
 */
export const CHECK_GROUPS: readonly CheckGroupEntry[] = [
  { group: "measurement", checks: MEASUREMENT_CHECKS },
  { group: "structure", checks: STRUCTURE_CHECKS },
  { group: "budget_bidding", checks: BUDGET_BIDDING_CHECKS },
  { group: "search", checks: [...SEARCH_KEYWORD_CHECKS, ...SEARCH_CHECKS] },
  { group: "pmax", checks: PMAX_CHECKS },
  { group: "shopping", checks: SHOPPING_CHECKS },
  { group: "slices", checks: SLICE_CHECKS },
  { group: "trends", checks: TREND_CHECKS },
  { group: "presence", checks: PRESENCE_CHECKS },
  { group: "carried_in", checks: CARRIED_IN_CHECKS },
  { group: "cross_tree", checks: CROSS_TREE_CHECKS },
  { group: "demand_gen", checks: DEMAND_GEN_CHECKS },
  { group: "video", checks: VIDEO_CHECKS },
];

export const ALL_CHECKS: readonly CheckDefinition[] = CHECK_GROUPS.flatMap((g) => g.checks);

export const CHECKS_BY_ID: ReadonlyMap<string, CheckDefinition> = new Map(
  ALL_CHECKS.map((c) => [c.id, c]),
);

/** How many checks this version ships. */
export const CHECK_COUNT = ALL_CHECKS.length;

/**
 * Declared confounders with no resolver yet, each named on purpose. A finding
 * declaring one of these is NOT silently treated as clear: `resolveConfounders`
 * records it `unknown`, which caps confidence at MODERATE, prints it as an open
 * item and forbids `critical`. Form: `<check>:<confounder>`.
 */
export const UNRESOLVABLE_CONFOUNDERS: ReadonlySet<string> = new Set<string>([
  // SK01 / SK09 as confounders: the checks run and fire, but their resolver form was never written
  "SK23:SK01",
  "PX12:SK01",
  "PX12:SK09",
  // SH17 (which products a Shopping campaign can sell, and at what priority) has no resolver form
  "SH10:SH17",
  "SH12:SH17",
  // Demand Gen and video checks as confounders of each other: no resolver form written
  "DG02:DG01",
  "DG03:DG01",
  "DG04:DG01",
  "VD02:VD01",
  "VD03:VD01",
  "VD05:VD06",
  "VD07:VD01",
  "VD07:VD02",
]);

/** Every broken collector invariant, as a sentence. Empty = healthy. */
export function collectorProblems(): string[] {
  const problems: string[] = [];

  if (CHECKS_BY_ID.size !== ALL_CHECKS.length) {
    const seen = new Set<string>();
    const dupes = ALL_CHECKS.map((c) => c.id).filter((id) =>
      seen.has(id) ? true : (seen.add(id), false),
    );
    problems.push(`duplicate check id(s): ${[...new Set(dupes)].join(", ")}`);
  }

  const badClaim = ALL_CHECKS.filter((c) => !isKnownClaimKey(c.claimKey));
  if (badClaim.length > 0) {
    problems.push(
      `claim key outside registry/claimKeys.ts: ${badClaim.map((c) => `${c.id}=${c.claimKey}`).join(", ")}`,
    );
  }

  const formulas = new Set<string>(IMPACT_FORMULA_IDS);
  const badFormula = ALL_CHECKS.filter(
    (c) => c.impactFormula != null && !formulas.has(c.impactFormula),
  );
  if (badFormula.length > 0) {
    problems.push(
      `unknown impact formula id: ${badFormula.map((c) => `${c.id}=${c.impactFormula}`).join(", ")}`,
    );
  }

  // Every confounder a check DECLARES must have a resolver, or be named in
  // UNRESOLVABLE_CONFOUNDERS. A silent gap would report "every confounder
  // cleared" when one was never examined.
  const gaps = ALL_CHECKS.flatMap((c) =>
    (c.confounders ?? [])
      .filter((cid) => !confoundersFor(c.id).some((r) => r.confounderId === cid))
      .map((cid) => `${c.id}:${cid}`),
  );
  const unexpected = gaps.filter((g) => !UNRESOLVABLE_CONFOUNDERS.has(g));
  if (unexpected.length > 0) {
    problems.push(
      `declared confounder with no resolver and not on the known-unresolvable list: ${unexpected.join(", ")}`,
    );
  }
  const stale = [...UNRESOLVABLE_CONFOUNDERS].filter((g) => !gaps.includes(g));
  if (stale.length > 0)
    problems.push(`UNRESOLVABLE_CONFOUNDERS lists ${stale.join(", ")}, which now resolve`);

  return problems;
}

export function getCheck(id: string): CheckDefinition | null {
  return CHECKS_BY_ID.get(id) ?? null;
}

export * from "./types.js";
