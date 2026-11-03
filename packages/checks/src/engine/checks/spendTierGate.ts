// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The spend-tier gate — D6 of AUDIT_V3_STATUS.md §2, Phase E item 3 of
 * AUDIT_V3_RULE_GAP_PLAN.md (inventory rules 113, 115, 186, 187).
 *
 * Small accounts are judged by small-account standards.
 *
 * Like businessTypeGate.ts and brandGate.ts this is a DECLARED TABLE, one row
 * per check id with its rule number, applied in `defineCheck` (checks/types.ts)
 * so a check imported straight from its group module cannot bypass it.
 *
 * ------------------------------------------------------------------ the tier
 *
 * The tier is derived from MEASURED spend (`A.spend_monthly`, which is D1's
 * 90-day-value/3), not from the questionnaire's self-reported band. The
 * questionnaire number is a client's estimate of what he spends; the account's
 * own 90 days is evidence of what he spent. When both exist and disagree, the
 * measured one wins and the suppression reason SAYS SO, so nobody reads a
 * suppressed demand as a silent disagreement with the intake form.
 *
 * The declared band is a fallback only, and only when it resolves cleanly: the
 * wizard's bands are `under_1k`, `1k_5k`, `5k_10k`, `10k_25k`, `25k_50k`,
 * `over_50k`, and two of them STRADDLE a tier boundary (`1k_5k` crosses $3,700,
 * `10k_25k` crosses $12,500). A straddling band resolves to no tier at all
 * rather than to a coin flip.
 *
 * ------------------------------------------------- three deliberate decisions
 *
 *   1. UNKNOWN SIZE NEVER SUPPRESSES. This is the opposite of the business-type
 *      gate, where `'unknown'` is a deny (rule 264). The directions differ
 *      because the risks differ: an unclassified account told about its product
 *      feed reads a FALSE statement, while an unsized account told to separate
 *      brand from non-brand reads a TRUE one that may be premature. Suppressing
 *      on a guess would quietly raise the score of any account whose spend we
 *      could not measure, which is exactly what the hard requirement below
 *      forbids. So: no measured spend and no clean band → the check runs.
 *   2. SUPPRESSING IS NOT PASSING. A gated check returns `not_checkable`, never
 *      `none_found`, so it lands in `engine.notCheckable` and reaches the
 *      client through `brief/buildNotChecked.ts` as "not applicable at this
 *      account size" rather than as a clean pillar. `SPEND_TIER_REASON_TAG`
 *      is how that file recognises this family; do not reword the prefix
 *      without changing `plainReason` with it.
 *   3. IT NEVER MOVES A NUMBER. Every rule this file encodes (113, 115, 186,
 *      187) is a binary APPLICABILITY rule, so every row here is a gate. The
 *      one threshold the inventory does tie to account size — the search-term
 *      waste floor's band ladder, rule 186's sibling — ALREADY moves with
 *      measured monthly spend inside `T.waste_floor` (registry/metrics.ts,
 *      `wasteFloorBand`) and is deliberately left exactly as it is: two
 *      definitions of "how big is this account" would drift apart within a
 *      month. Both read `A.spend_monthly` divided by `CurrencyScale.factor`.
 *
 * ----------------------------------------------------- what it does NOT gate
 *
 *   - PR02 (channel types present and their spend share). Rule 116 says Demand
 *     Gen absent at Tier A is CORRECT, so the obvious move is to gate the
 *     "you are missing a channel" finding. There is no such finding: PR02 is
 *     `IMP_NONE` and reports the channel mix as a fact, and no v3 check fires
 *     on a channel being absent. Rule 116 is therefore already satisfied and
 *     nothing is added for it. Same for rule 187's "fewer than four campaigns":
 *     v3 has no minimum-campaign-count check to gate.
 *   - Rule 114 ("campaign fragmentation is critical at Tier A"). That is a
 *     SEVERITY escalation on a small account, not a suppression, and severity
 *     is keyed by check id in `scoring/severityPolicy.ts`. It also has no
 *     fragmentation check to attach to. Recorded, not pretended.
 *   - SL02 (usable remarketing lists attached nowhere). Rule 115 forbids
 *     PENALISING a small account for lists it never built; a list it DID build
 *     and then attached to nothing is a real finding at any size.
 */
import {
  SPEND_TIER,
  SPEND_TIER_ORDER,
  spendTierOf,
  type SpendTier,
} from "../registry/thresholds.js";
import { isOk, num, type CheckCtx, type CheckResult } from "./types.js";

export interface SpendTierRule {
  /**
   * The LOWEST tier this structural expectation applies to. A check with
   * `minTier: 'B'` does not run on a Tier A account.
   */
  minTier: SpendTier;
  /** inventory rule number(s) this row encodes — AUDIT_V3_RULE_INVENTORY.md. */
  rules: string;
  /** the reason the REPORT prints, in plain words. Never "no data". */
  why: string;
}

/**
 * The table. Every row names its rule; a row is added only when the inventory
 * says so, never because a finding looked heavy-handed on one account.
 */
export const SPEND_TIER_RULES: Readonly<Record<string, SpendTierRule>> = {
  // --- rule 113: under about $3,700 a month do not recommend splitting brand
  // from non-brand. SK07's one fix is to pull the generic side out into its own
  // campaign.
  SK07: {
    minTier: "B",
    rules: "113",
    why: "at this spend a brand / non-brand split costs more in management and lost volume than it returns",
  },

  // --- rules 113 / 186: AS12 measures the brand-versus-prospecting split against a fixed
  // line, which presupposes an account big enough to run both sides deliberately.
  AS12: {
    minTier: "B",
    rules: "113, 186",
    why: "a brand share-of-spend line assumes an account large enough to run both sides deliberately, which this one is not",
  },

  // --- rule 115: a small account needs only an all-visitors and an
  // all-purchasers list. AS09 asks for all seven standard lists.
  AS09: {
    minTier: "B",
    rules: "115",
    why: "an account this size needs only an all-visitors and an all-purchasers list, so the wider set of audience lists is not expected",
  },
};

/**
 * How `buildNotChecked` recognises this family. The reason strings from the
 * other gates fall into its generic "the data is not available" bucket; an
 * applicability answer is a different sentence and needs a different one.
 */
export const SPEND_TIER_REASON_TAG = "not applicable at this account size";

/**
 * The declared spend bands (`AccountProfile.monthlySpendRange`), in USD per
 * month, as [min, max).
 */
const DECLARED_BANDS: Readonly<Record<string, [number, number]>> = {
  under_1k: [0, 1_000],
  "1k_5k": [1_000, 5_000],
  "5k_10k": [5_000, 10_000],
  "10k_25k": [10_000, 25_000],
  "25k_50k": [25_000, 50_000],
  over_50k: [50_000, Number.POSITIVE_INFINITY],
};

/**
 * The tier a declared band implies, or `null` when the band STRADDLES a
 * boundary. `1k_5k` spans $3,700 and `10k_25k` spans $12,500, and an account
 * that answered either could be on either side. Guessing would be inventing a
 * fact about the client's size, which is precisely what the measured figure
 * exists to avoid.
 */
export function tierOfDeclaredBand(
  band: string | null,
  tiers: { spendTierAMaxMonthlyUsd: number; spendTierBMaxMonthlyUsd: number } = {
    spendTierAMaxMonthlyUsd: SPEND_TIER.tierAMaxMonthlyUsd,
    spendTierBMaxMonthlyUsd: SPEND_TIER.tierBMaxMonthlyUsd,
  },
): SpendTier | null {
  if (!band) return null;
  const bounds = DECLARED_BANDS[band.trim().toLowerCase()];
  if (!bounds) return null;
  const [lo, hi] = bounds;
  // `hi` is exclusive, so the top of the band is the last dollar below it.
  const loTier = spendTierOf(lo, tiers);
  const hiTier = spendTierOf(Number.isFinite(hi) ? hi - 1 : tiers.spendTierBMaxMonthlyUsd, tiers);
  return loTier === hiTier ? loTier : null;
}

/** The self-reported monthly spend band from the caller's profile. */
export function declaredBandOf(ctx: CheckCtx): string | null {
  const raw = ctx.model.attrs.profile?.monthlySpendRange;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * Measured monthly spend at USD scale, or `null`.
 *
 * Null on an unknown currency, for the reason the waste-floor band is null
 * there: with a 1:1 factor on an ISK account the $3,700 bar is about $27, and
 * every account on earth would be Tier C.
 */
export function measuredMonthlyUsd(ctx: CheckCtx): number | null {
  if (!ctx.currency.known) return null;
  const v = ctx.get("A.spend_monthly");
  if (!isOk(v)) return null;
  const monthly = num(v);
  if (monthly == null || !Number.isFinite(monthly) || monthly < 0) return null;
  return monthly / ctx.currency.factor;
}

export interface SpendTierVerdict {
  /** `null` = the account's size is unknown, and nothing is suppressed. */
  tier: SpendTier | null;
  /** which of the two inputs decided it. */
  source: "measured" | "declared" | null;
  /** measured monthly spend at USD scale, when we have it. */
  measuredMonthlyUsd: number | null;
  /** the band the client picked, verbatim, when there is one. */
  declaredBand: string | null;
  /** the tier that band implies; null when it straddles a boundary or is unrecognised. */
  declaredTier: SpendTier | null;
  /** both inputs resolved and they do not agree. The measured one is the one in `tier`. */
  disagrees: boolean;
}

/** Resolve the account's tier once, from evidence first and the intake form second. */
export function resolveSpendTier(ctx: CheckCtx): SpendTierVerdict {
  const measured = measuredMonthlyUsd(ctx);
  const declaredBand = declaredBandOf(ctx);
  const declaredTier = tierOfDeclaredBand(declaredBand, ctx.settings.floors);
  if (measured == null) {
    return {
      tier: declaredTier,
      source: declaredTier ? "declared" : null,
      measuredMonthlyUsd: null,
      declaredBand,
      declaredTier,
      disagrees: false,
    };
  }
  const tier = spendTierOf(measured, ctx.settings.floors);
  return {
    tier,
    source: "measured",
    measuredMonthlyUsd: measured,
    declaredBand,
    declaredTier,
    disagrees: declaredTier != null && declaredTier !== tier,
  };
}

/** `$3,700` — the boundary printed the way a reader expects to see money. */
function usd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * The evidence sentence a suppression carries: which number decided the tier,
 * and — when the intake form said something else — that the account's own spend
 * was believed over the client's estimate.
 */
export function spendTierEvidenceLine(v: SpendTierVerdict): string {
  if (v.source === "measured" && v.measuredMonthlyUsd != null) {
    const base = `measured spend is about ${usd(v.measuredMonthlyUsd)} a month (90-day spend divided by three), which is tier ${v.tier}`;
    if (!v.disagrees) return base;
    return `${base}; the account profile said "${v.declaredBand}", which would be tier ${v.declaredTier}, and the account's own spend was used instead because it is measured rather than estimated`;
  }
  if (v.source === "declared") {
    return `the account's own spend could not be measured, so the account profile's "${v.declaredBand}" was used, which is tier ${v.tier}`;
  }
  return "the account size could not be established";
}

/**
 * The verdict, BEFORE the check runs. `null` means "run it".
 *
 * `not_checkable` rather than `none_found` is the whole hard requirement of D6:
 * suppressing a demand that does not apply is not the same as awarding a pass,
 * so the check has to land in `engine.notCheckable` with a reason a client can
 * read, not disappear into a clean pillar.
 */
export function spendTierVerdict(
  checkId: string,
  ctx: CheckCtx,
  rules: Readonly<Record<string, SpendTierRule>> = SPEND_TIER_RULES,
): { state: "not_checkable"; reason: string; category: "not_applicable" } | null {
  const rule = rules[checkId];
  if (!rule) return null;
  const v = resolveSpendTier(ctx);
  // Decision 1: an account whose size we could not establish is judged in full.
  if (v.tier == null) return null;
  if (SPEND_TIER_ORDER[v.tier] >= SPEND_TIER_ORDER[rule.minTier]) return null;
  return {
    state: "not_checkable",
    reason: `${SPEND_TIER_REASON_TAG}: ${rule.why} (${spendTierEvidenceLine(v)})`,
    category: "not_applicable",
  };
}

/**
 * Applied in `defineCheck`, beside the business-type gate and for the same
 * reason: account size is a property of the ACCOUNT, so there is nothing
 * per-finding to weigh and the check should not run at all.
 */
export function applySpendTierGate(
  checkId: string,
  ctx: CheckCtx,
  run: () => CheckResult,
  rules: Readonly<Record<string, SpendTierRule>> = SPEND_TIER_RULES,
): CheckResult {
  return spendTierVerdict(checkId, ctx, rules) ?? run();
}
