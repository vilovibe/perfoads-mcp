// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The brand-campaign gate — A5 of AUDIT_V3_RULE_GAP_PLAN.md (rules 31-43, 179,
 * 242, 278, 336, 347, 348).
 *
 * Brand campaigns do not behave like anything else in an account: branded
 * searches convert at rates that look "too good", cost per sale looks high
 * because volume is low, click-through is naturally 3-5x non-brand, and the
 * correct fix for a brand problem is almost never a bid change. Every rule
 * below was written the day an audit said one of those things about a brand
 * campaign in front of a client.
 *
 * This is a DECLARED TABLE, not thirteen special cases scattered through the
 * check bodies: one row per check id, the rule number in the comment, so the
 * next person can trace any suppression back to the sentence that caused it.
 * It is applied in `defineCheck` (checks/types.ts) beside the activity gate, so
 * a check imported straight from its group module cannot bypass it.
 *
 * Three things it deliberately does NOT do:
 *   - it does not gate SK20 (landing-page conversion rate). Rule 41 says brand
 *     conversion-rate findings BELONG to the landing-page section — SK20 is
 *     that section, and rule 34 ("poor brand CVR points at the landing page or
 *     the offer") sends the finding here on purpose.
 *   - it does not gate SK05/SK07 by campaign. Branded queries are never waste
 *     (rule 34), and that is already enforced by the brand-as-defensive-spend
 *     resolver in interactions/matrix.ts (`R.SK07`), now wired to SK01 and SK05
 *     alike. One mechanism, not two.
 *   - it does not decide severity. Rule 40 ("brand on Maximize Clicks at 90%+
 *     impression share is not a critical issue") is carried by BB06 never
 *     firing on brand at all, which is the stronger reading of rules 37/179/336.
 */
import { brandTokensInText, isBrandCampaign } from "../shared/campaignClassification.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import type { CheckCtx, CheckFinding, CheckResult, CheckScope } from "./types.js";

/** SK13 on brand: the ad carries an asset Google rates LOW. */
function adHasLowRatedAsset(ctx: CheckCtx, f: CheckFinding): boolean {
  const ad = f.scope.id ? ctx.metrics.index.adsById.get(f.scope.id) : null;
  if (!ad) return false;
  return ad.children.assets.some(
    (a) => (a.attrs.performanceLabel ?? a.attrs.assetPerformanceLabel) === "LOW",
  );
}

/**
 * `never`   — the check may not produce a finding whose scope sits in a brand
 *             campaign; the candidate is dropped before scoring.
 * `only_if` — the check fires on brand only when `allowOnBrand` holds. The
 *             finding is otherwise correct, it is the brand case that is not.
 */
export type BrandScopeMode = "never" | "only_if";

export interface BrandScopeRule {
  mode: BrandScopeMode;
  /** inventory rule number(s) this row encodes — AUDIT_V3_RULE_INVENTORY.md. */
  rules: string;
  /** why, in the words of the rule, for the suppression note and the trace. */
  why: string;
  /** `only_if` rows only: the condition under which the finding is still true on brand. */
  allowOnBrand?(ctx: CheckCtx, f: CheckFinding): boolean;
}

/**
 * The table. Every row names its rule; a row is added only when the inventory
 * says so, never because a finding looked awkward.
 */
export const BRAND_SCOPE_RULES: Readonly<Record<string, BrandScopeRule>> = {
  // --- rules 31/32/33: no device, audience or demographic bid-adjustment finding on a
  // brand campaign. The one exception (a cannibalising device on a budget-capped brand
  // campaign) needs a judgement the slice checks never form, so the family is off on brand.
  SL01: {
    mode: "never",
    rules: "31",
    why: "audience bid adjustments on a brand campaign are forbidden by default",
  },
  SL05: {
    mode: "never",
    rules: "31, 33",
    why: "a device cost-per-sale gap on a brand campaign is not a finding — brand device mix is demand, not a bid error",
  },
  SL06: {
    mode: "never",
    rules: "31, 34",
    why: "a brand device slice that spends without converting is defensive spend, never waste",
  },
  SL07: {
    mode: "never",
    rules: "31",
    why: "age and gender bid adjustments on a brand campaign are forbidden by default",
  },
  SL03: {
    mode: "never",
    rules: "31",
    why: "country bid adjustments on a brand campaign are forbidden by default",
  },
  SL09: {
    mode: "never",
    rules: "31, 41",
    why: "a mobile-versus-desktop return comparison on brand uses a non-brand benchmark",
  },
  // --- rule 35: brand click-through is naturally several times non-brand.
  SK24: {
    mode: "never",
    rules: "35, 42",
    why: "brand click-through must never be compared to a non-brand benchmark",
  },
  SK22: {
    mode: "never",
    rules: "31, 34",
    why: "a brand day-and-hour cell that spends without converting is defensive spend, never waste",
  },
  BB09: {
    mode: "never",
    rules: "31, 32",
    why: "bid-adjustment advice on a brand campaign is forbidden by default",
  },

  // --- rule 36: ad relevance on a brand campaign is measured against the
  // non-brand keywords the quality-score components are calibrated on.
  SK02: {
    mode: "never",
    rules: "36",
    why: "ad-relevance and quality-score findings on brand are tied to non-brand keywords",
  },

  // --- rules 37 / 43 / 179 / 336: "switch to Smart Bidding" is forbidden on
  // brand; e-commerce brand campaigns belong on manual CPC and the bidding
  // ladder is non-brand only. `L.ladder_rung` (registry/metrics.ts) already
  // excludes brand from `ready_for_target`; this row makes the rule declared
  // rather than a side effect of one formula.
  BB06: {
    mode: "never",
    rules: "37, 43, 179, 336",
    why: "brand campaigns are exempt from the bidding-promotion rung — brand runs on manual CPC",
  },

  // --- rule 242: on a brand campaign a pinned brand headline is intentional
  // and correct. Unpin only when Google rates the asset LOW.
  SK13: {
    mode: "only_if",
    rules: "242",
    why: "a pinned brand headline is intentional on a brand campaign — unpin only when the asset is rated LOW",
    allowOnBrand: adHasLowRatedAsset,
  },
};

/**
 * Checks whose finding NAMES a query or keyword the report would go on to
 * propose as a negative. Rules 347/348: no proposed negative may contain a
 * brand token, and the client's own business name is never a competitor. This
 * is the check-side half of the veto; writer/validateFindings.ts (V14) is the
 * other, because either alone is insufficient — the check can be bypassed by a
 * model candidate, and the validator only sees prose.
 */
export const BRAND_TERM_VETO: ReadonlySet<string> = new Set(["SK01", "SK05"]);

/**
 * Negatives framework P3: PX22 is ONE account-scope finding whose ROWS name the
 * words to block and example searches (the scope name is the account's, which
 * often IS the brand). For such a finding the veto reads the rows instead: every
 * listed word or search holding a brand token is struck from `block` /
 * `examples`, and a row left with nothing to block is dropped.
 */
const VETO_ROW_CELLS: readonly { cell: string; sep: string }[] = [
  { cell: "block", sep: ", " },
  { cell: "examples", sep: "; " },
];
function vetoRows(ctx: CheckCtx, f: CheckFinding, struck: string[]): CheckFinding {
  if (!f.rows || f.rows.length === 0) return f;
  const rows = f.rows.flatMap((row) => {
    const cells = { ...row.cells };
    for (const { cell, sep } of VETO_ROW_CELLS) {
      const v = cells[cell];
      if (typeof v !== "string" || v === "") continue;
      const items = v.split(sep);
      const kept = items.filter((item) => {
        const hits = brandTokensIn(ctx, item);
        if (hits.length > 0) struck.push(`${item} (contains the brand token "${hits[0]}")`);
        return hits.length === 0;
      });
      if (cell === "block" && kept.length === 0) return [];
      cells[cell] = kept.join(sep);
    }
    return [{ ...row, cells }];
  });
  return { ...f, rows };
}

/** The campaign a finding sits in, when the model knows it. */
function campaignOf(ctx: CheckCtx, scope: CheckScope): CampaignNode | null {
  const id = scope.type === "campaign" ? scope.id : (scope.campaignId ?? null);
  if (id) return ctx.metrics.index.campaignsById.get(id) ?? null;
  return null;
}

/**
 * Rule 386: the manual tag from the monitoring wizard wins, the name heuristic
 * is the fallback. Both live in `isBrandCampaign`; the node carries the answer
 * already, and the name is used only when the node cannot be resolved (slice
 * scopes carry a synthetic id).
 */
export function isBrandScope(ctx: CheckCtx, scope: CheckScope): boolean {
  const c = campaignOf(ctx, scope);
  if (c) return c.attrs.isBrand;
  const name = scope.type === "campaign" ? scope.name : (scope.campaignName ?? null);
  return name ? isBrandCampaign(name) : false;
}

/** The brand tokens a scope name contains (rule 347/348). Empty when the questionnaire has no business name. */
export function brandTokensIn(ctx: CheckCtx, text: string | null): string[] {
  return brandTokensInText(text, ctx.model.attrs.brandTokens);
}

/**
 * Apply the table. Runs for every check, after the activity gate.
 *
 * Rule 42: a rule that hits brand and non-brand alike must be split and say
 * "excluding brand campaigns". When this gate drops a brand finding, the
 * surviving findings of the same check carry `brand_campaigns_excluded` as a
 * fact, so the number reaches the writer's bundle as a quotable row rather than
 * living only in a note the writer never sees.
 */
export function applyBrandGate(checkId: string, ctx: CheckCtx, r: CheckResult): CheckResult {
  if (r.state !== "fires") return r;
  const rule = BRAND_SCOPE_RULES[checkId];
  const vetoTerms = BRAND_TERM_VETO.has(checkId);
  if (!rule && !vetoTerms) return r;

  const kept: CheckFinding[] = [];
  const scopeExcluded: string[] = [];
  const termsExcluded: string[] = [];
  for (const f of r.findings) {
    if (vetoTerms && f.scope.type === "account") {
      const vetoed = vetoRows(ctx, f, termsExcluded);
      if (vetoed.rows && vetoed.rows.length === 0 && (f.rows?.length ?? 0) > 0) continue;
      kept.push(vetoed);
      continue;
    }
    if (vetoTerms) {
      const hits = brandTokensIn(ctx, f.scope.name);
      if (hits.length > 0) {
        // rules 34 / 347 / 348: a branded query is never waste, and naming it
        // here is how it ends up proposed as a negative keyword.
        termsExcluded.push(`${f.scope.name} (contains the brand token "${hits[0]}")`);
        continue;
      }
    }
    if (rule && isBrandScope(ctx, f.scope)) {
      if (rule.mode === "never" || !(rule.allowOnBrand?.(ctx, f) ?? false)) {
        scopeExcluded.push(f.scope.campaignName ?? f.scope.name ?? f.scope.type);
        continue;
      }
    }
    kept.push(f);
  }

  if (scopeExcluded.length === 0 && termsExcluded.length === 0) return r;
  const notes = [
    scopeExcluded.length > 0
      ? `${scopeExcluded.length} finding(s) left out on brand campaigns: ${rule?.why ?? ""} — ${[...new Set(scopeExcluded)].join("; ")}`
      : null,
    termsExcluded.length > 0
      ? `${termsExcluded.length} branded search(es) or keyword(s) left out: a search for your own brand is never waste and must never become a negative keyword — ${termsExcluded.join("; ")}`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  if (kept.length === 0)
    return { state: "fires", findings: [], withheld: [...(r.withheld ?? []), notes] };
  return {
    state: "fires",
    ...(r.withheld ? { withheld: r.withheld } : {}),
    findings: kept.map((f) => ({
      ...f,
      facts: {
        ...f.facts,
        ...(scopeExcluded.length > 0 ? { brand_campaigns_excluded: scopeExcluded.length } : {}),
        ...(termsExcluded.length > 0 ? { brand_terms_excluded: termsExcluded.length } : {}),
      },
      note: [f.note, notes].filter(Boolean).join("; "),
    })),
  };
}
