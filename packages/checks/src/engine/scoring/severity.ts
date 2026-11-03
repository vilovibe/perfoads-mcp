// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Severity — spec §3.3, computed from the impact and the confounders, never
 * chosen by the model.
 *
 *   critical    = measurement/attribution integrity OR impact >= 10% of monthly spend at STRONG
 *   warning     = impact >= 2% of monthly spend OR structural (policy, disapproval)
 *   opportunity = positive expected value
 *   positive    = a healthy signal worth stating
 *   info        = below 2% and not structural
 *
 * Then: downgrade ONE step per unresolved confounder FROM THE BASE, then apply
 * the check's ceiling, and never critical with an unresolved confounder.
 *
 * Floor: an impact >= 2% of monthly spend on a loss-type base (warning or
 * critical) keeps at least warning, under the check's ceiling, when ALL of:
 *   (a) the money is real spend: IMP_WASTE_90, IMP_WASTE_30, IMP_VALUE_GAP or a
 *       priced IMP_STRUCTURAL (spend at risk). Never IMP_CPA_GAP: a cost-per-sale
 *       gap is a comparison, and its confounder downgrades stand (BB09);
 *   (b) no measurement confounder (MI01, MI02, MI05, MI07) in "explains" could
 *       plausibly explain THIS finding: broken tracking can make the money itself
 *       wrong, but only when the check's conclusion rests on conversion counts
 *       (every floor formula but IMP_STRUCTURAL: zero-sale spend, a fall in
 *       return) AND the confounder touches the finding's campaigns (a confounder
 *       or a finding with no campaign list covers the whole account). Phase F: a
 *       YouTube action that counted nothing kept $400-650/month declines at info.
 *       Other "explains" states do not block it (SK18 says "explains" whenever a
 *       promo has an end date);
 *   (c) at most FLOOR_LIFTS_PER_CHECK findings per check, biggest money first;
 *       the engine applies this budget (`applyFloorBudget`).
 * Confounders lower the confidence in real money; they never hide it. The old order
 * (ceiling first, then the downgrades) printed a $14.9k/month account decline
 * as info while a $15 expired promo stayed a warning.
 *
 * Tiny-spend cap (Phase F, round 2): a hygiene finding (TINY_SPEND_CHECKS only) with
 * no money, on a campaign whose monthly run rate (spend per day it spent x 30) is
 * under max(TINY_SPEND_SHARE_PCT of the account's monthly spend, the money floor),
 * is a note, never a warning: one ad in a brand campaign that spent $25 in 90 days
 * is not a fault worth a warning. The run rate, not the 90-day total, so a campaign
 * launched last week is judged on its pace. Never integrity, policy, delivery or
 * goal/measurement checks (SK15, BB04, MI07, ...): those are faults at any spend.
 *
 * The check this exists for (build sheet TR06): a 100%-wasteful campaign
 * costing $26.52/mo against A.spend_monthly 8,500 is 0.31% — info, not the
 * critical the old pipeline used to gate a whole report with.
 */
import type { ConfounderSummary, Confidence, Impact, Severity } from "./types.js";

export const CRITICAL_PCT_OF_MONTHLY_SPEND = 10;
export const WARNING_PCT_OF_MONTHLY_SPEND = 2;

/** 'cleared' is the only resolved state; 'explains' means the signal is explained away, not cleared. */
const UNRESOLVED_STATES: ReadonlyArray<ConfounderSummary["state"]> = ["unknown", "explains"];

/** (c) the most findings one check may have lifted by the money floor. */
export const FLOOR_LIFTS_PER_CHECK = 5;

/** (a) the formulas whose money is real spend. */
const FLOOR_FORMULAS: ReadonlySet<Impact["formulaId"]> = new Set([
  "IMP_WASTE_90",
  "IMP_WASTE_30",
  "IMP_VALUE_GAP",
  "IMP_STRUCTURAL",
]);

/** (b) measurement confounders: in "explains" they can make the money itself wrong. */
const MEASUREMENT_CONFOUNDERS = ["MI01", "MI02", "MI05", "MI07"];

/** The tiny-spend cap: a campaign under this share of the account's monthly spend (percent). */
export const TINY_SPEND_SHARE_PCT = 0.5;

/** Days in the month A.spend_monthly uses (90-day spend / 3). */
export const DAYS_PER_MONTH = 30;

/**
 * The tiny-spend cap applies to these checks only: pure hygiene of how ads, keywords
 * and assets are built, where no money, policy, tracking or delivery rides on it.
 *   SK04 duplicate keyword across ad groups   SK11 responsive-ad count per ad group
 *   SK12 few headlines                         SK13 heavy pinning
 *   SK16 missing asset types                   SK17 callout never served
 *   SK25 too many keywords in an ad group      PX03 / PX13 asset group short of a full set
 * Not here on purpose: SK15 / SK26 / PX17 (disapproval), BB04 / BB05 (bidding and
 * delivery), MI* (measurement and goals), SL10-SL12 (targeting), AS* (account settings).
 */
export const TINY_SPEND_CHECKS: ReadonlySet<string> = new Set([
  "SK04",
  "SK11",
  "SK12",
  "SK13",
  "SK16",
  "SK17",
  "SK25",
  "PX03",
  "PX13",
]);

/** (b) Does the check's conclusion rest on conversion counts? Every formula but a structural one. */
export function dependsOnConversions(formulaId: Impact["formulaId"]): boolean {
  return formulaId !== "IMP_STRUCTURAL";
}

/** (b) Do two campaign sets meet? An absent set is the whole account and meets everything. */
function overlaps(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (a == null || b == null) return true;
  return a.some((id) => b.includes(id));
}

const DOWNGRADE: Record<Severity, Severity> = {
  critical: "warning",
  warning: "info",
  opportunity: "info",
  positive: "info",
  info: "info",
};

const RANK: Record<Severity, number> = {
  critical: 4,
  warning: 3,
  opportunity: 2,
  positive: 1,
  info: 0,
};

export interface SeverityInput {
  impact: Impact;
  /** A.spend_monthly, the one denominator §3.3 uses. null → the percentage cannot be computed. */
  monthlySpend: number | null;
  confidence: Confidence;
  confounders: ConfounderSummary[];
  /** The check is about measurement or attribution integrity (B.1). */
  integrity?: boolean | undefined;
  /** The check is structural: policy, disapproval, a missing setting or list. */
  structural?: boolean | undefined;
  /** The check states a healthy signal. */
  positive?: boolean | undefined;
  /** The check has positive expected value (scale, revive, add). */
  opportunity?: boolean | undefined;
  /** A ceiling the check declares for itself, e.g. MI02 "opportunity (never critical)". */
  maxSeverity?: Severity | undefined;
  /**
   * The severity the build sheet states for a row that can NEVER carry a dollar
   * figure and is neither structural, positive, an opportunity nor an integrity
   * check. For those rows the sheet's own cell is the only source of severity
   * there is; without this, `warning` was structurally unreachable and AS01
   * (brand spend share, "warning / critical at 70"), BB03, SK02 and SH15 all
   * printed `info` — the sheet's contract, broken in the understating
   * direction. It is a FLOOR and is still capped by `maxSeverity`.
   */
  minSeverity?: Severity | undefined;
  /**
   * The confounder ids the check's §B row declares. Pass `[]` to say "this
   * check genuinely has none". LEAVING IT UNDEFINED FAILS CLOSED: with no
   * confounder evidence at all the finding cannot be critical, because nothing
   * was compared against anything.
   */
  declaredConfounders?: string[] | undefined;
  /**
   * The campaigns the finding is about (its campaign, or the campaign its ad group,
   * keyword or slice sits in). Absent = account-wide or not known.
   */
  campaignIds?: readonly string[] | null | undefined;
  /** (b) Override: does the check's conclusion rest on conversion counts? Default: by formula. */
  dependsOnConversions?: boolean | undefined;
  /** The check that raised the finding: the tiny-spend cap applies to TINY_SPEND_CHECKS only. */
  checkId?: string | undefined;
  /**
   * The tiny-spend cap's inputs: the finding's campaign monthly run rate (spend per
   * day it spent x DAYS_PER_MONTH), the account's monthly spend, and the money floor.
   * Absent = not campaign-scoped, no cap.
   */
  scopeSpend?:
    { campaignMonthly: number; accountMonthly: number; floor: number } | null | undefined;
}

export interface SeverityResult {
  severity: Severity;
  /** Before the confounder downgrades and the ceiling. */
  base: Severity;
  /** impact.value as a percentage of monthlySpend; null when either is unknown. */
  impactPctOfMonthlySpend: number | null;
  unresolvedConfounders: string[];
  reasons: string[];
  /**
   * Set when the money floor lifted the severity: what it would be without the
   * floor. The engine drops the lift on all but the biggest FLOOR_LIFTS_PER_CHECK
   * findings of a check.
   */
  withoutFloor?: Severity | undefined;
}

export const SEVERITY_ORDER: Severity[] = [
  "critical",
  "warning",
  "opportunity",
  "positive",
  "info",
];

export function impactPctOfMonthlySpend(
  impact: Impact,
  monthlySpend: number | null,
): number | null {
  if (impact.value == null || monthlySpend == null || monthlySpend <= 0) return null;
  return (impact.value / monthlySpend) * 100;
}

export function computeSeverity(input: SeverityInput): SeverityResult {
  const reasons: string[] = [];
  const pct = impactPctOfMonthlySpend(input.impact, input.monthlySpend);

  let base: Severity;
  if (input.integrity) {
    base = "critical";
    reasons.push("measurement/attribution integrity");
  } else if (input.positive) {
    base = "positive";
    reasons.push("healthy signal worth stating");
  } else if (input.opportunity) {
    base = "opportunity";
    reasons.push("positive expected value");
  } else if (pct != null && pct >= CRITICAL_PCT_OF_MONTHLY_SPEND && input.confidence === "STRONG") {
    base = "critical";
    reasons.push(`impact ${pct.toFixed(2)}% of monthly spend at STRONG`);
  } else if (pct != null && pct >= WARNING_PCT_OF_MONTHLY_SPEND) {
    base = "warning";
    reasons.push(`impact ${pct.toFixed(2)}% of monthly spend`);
  } else if (input.structural) {
    base = "warning";
    reasons.push("structural finding (policy, disapproval or setting)");
  } else {
    base = "info";
    reasons.push(
      pct == null
        ? "no quantified impact and not structural"
        : `impact ${pct.toFixed(2)}% of monthly spend is below the ${WARNING_PCT_OF_MONTHLY_SPEND}% bar and the finding is not structural`,
    );
  }

  if (input.minSeverity && RANK[input.minSeverity] > RANK[base]) {
    reasons.push(
      `this check is a ${input.minSeverity} on its own terms; no dollar figure can derive it`,
    );
    base = input.minSeverity;
  }

  // the confounder downgrades act on the base, BEFORE the ceiling
  const unresolved = input.confounders
    .filter((c) => UNRESOLVED_STATES.includes(c.state))
    .map((c) => c.id);
  let severity = base;
  for (const id of unresolved) {
    const next = DOWNGRADE[severity];
    if (next !== severity)
      reasons.push(`downgraded ${severity} → ${next}: confounder ${id} unresolved`);
    severity = next;
  }

  if (input.maxSeverity && RANK[severity] > RANK[input.maxSeverity]) {
    severity = input.maxSeverity;
    reasons.push(`capped at ${input.maxSeverity} by the check`);
  }

  // the money floor: >= 2% of monthly spend on a loss-type base keeps at least
  // warning, never above the check's own ceiling — real spend only, and never
  // when a measurement confounder explains the signal (see the header)
  let withoutFloor: Severity | undefined;
  const conversionBased =
    input.dependsOnConversions ?? dependsOnConversions(input.impact.formulaId);
  const measurementExplains = input.confounders.find(
    (c) =>
      c.state === "explains" &&
      MEASUREMENT_CONFOUNDERS.some((m) => c.id.endsWith(m)) &&
      conversionBased &&
      overlaps(c.campaignIds, input.campaignIds),
  );
  if (
    pct != null &&
    pct >= WARNING_PCT_OF_MONTHLY_SPEND &&
    RANK[base] >= RANK.warning &&
    FLOOR_FORMULAS.has(input.impact.formulaId) &&
    !measurementExplains
  ) {
    const floor: Severity =
      input.maxSeverity && RANK[input.maxSeverity] < RANK.warning ? input.maxSeverity : "warning";
    if (RANK[severity] < RANK[floor]) {
      reasons.push(
        `kept at ${floor}: impact ${pct.toFixed(2)}% of monthly spend is real money; confounders lower the confidence only`,
      );
      withoutFloor = severity;
      severity = floor;
    }
  }

  // the tiny-spend cap: no money on a campaign that barely spent is a note
  const money = input.impact.value ?? 0;
  const sp = input.scopeSpend;
  if (
    sp &&
    input.checkId != null &&
    TINY_SPEND_CHECKS.has(input.checkId) &&
    money <= 0 &&
    RANK[severity] > RANK.opportunity
  ) {
    const bar = Math.max((TINY_SPEND_SHARE_PCT / 100) * sp.accountMonthly, sp.floor);
    if (sp.campaignMonthly < bar) {
      reasons.push(
        `capped at info: the campaign spends ${sp.campaignMonthly.toFixed(2)} a month on the days it runs, under the ${bar.toFixed(2)} bar for a campaign worth a warning`,
      );
      severity = "info";
    }
  }

  // §3.3, stated twice on purpose: never critical with an unresolved confounder.
  if (severity === "critical" && unresolved.length > 0) {
    severity = "warning";
    reasons.push("forced off critical: an unresolved confounder remains");
  }

  // Fail closed: a critical with NO confounder evidence recorded has not
  // survived anything, and a single unearned critical used to gate a report.
  const declared = input.declaredConfounders;
  const noEvidence = input.confounders.length === 0 && !(declared && declared.length === 0);
  if (severity === "critical" && noEvidence) {
    severity = "warning";
    reasons.push("forced off critical: no confounder was evaluated, so nothing was ruled out");
  }

  return {
    severity,
    base,
    impactPctOfMonthlySpend: pct,
    unresolvedConfounders: unresolved,
    reasons,
    ...(withoutFloor ? { withoutFloor } : {}),
  };
}

/**
 * (c) The floor's budget per check: of the findings one check had lifted, only
 * the FLOOR_LIFTS_PER_CHECK with the most money keep the lift; the rest go back
 * to the severity the confounders gave them. Mutates the results in place.
 */
export function applyFloorBudget(
  scored: Array<{ severity: SeverityResult; impact: Impact }>,
): void {
  const lifted = scored
    .filter((s) => s.severity.withoutFloor !== undefined)
    .sort((a, b) => (b.impact.value ?? 0) - (a.impact.value ?? 0));
  for (const s of lifted.slice(FLOOR_LIFTS_PER_CHECK)) {
    const back = s.severity.withoutFloor as Severity;
    s.severity.reasons.push(
      `not kept at ${s.severity.severity}: the money floor lifts only the ${FLOOR_LIFTS_PER_CHECK} biggest findings of a check`,
    );
    s.severity.severity = back;
    delete s.severity.withoutFloor;
  }
}
