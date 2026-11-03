// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Impact formulas — build sheet §B ("Impact formula ids, all defined once").
 *
 * Eight ids, no more: a check names one of them and supplies its scope; the
 * formula resolves its own inputs through the MetricLookup and returns an
 * `Impact` carrying the formula id and every metric id it consumed. A check may
 * never hand the writer a bare number — that is how "$200/mo decision risk"
 * used to get invented.
 *
 * Rules honoured here:
 *  - monthly is the unit of every impact (§3.3 compares it to A.spend_monthly);
 *    a 90-day figure is divided by `DAYS_PER_MONTH_DIVISOR` (registry/windows.ts)
 *    exactly as §B writes it (`wasted_cost_90d / 3`) — that literal divisor is
 *    what a 90-day figure is stated against ($79.56 -> $26.52/mo), and since
 *    it is the ONLY monthly conversion in v3 (A.spend_monthly too).
 *  - annual = 12 × monthly, emitted ONLY when the monthly figure is settled
 *    (every input settledStrict). An unsettled number never gets multiplied.
 *  - an input that will not resolve returns IMP_NONE with the reason, never 0.
 */
import {
  isNotComputable,
  type Impact,
  type ImpactFormulaId,
  type ImpactInput,
  type ImpactKind,
  type MetricLookup,
  type MetricValue,
  type NodeRef,
  type NotComputable,
} from "./types.js";
import { DAYS_PER_MONTH_DIVISOR } from "../registry/windows.js";

/**
 * The 30-day campaign cost, under the id the REGISTRY answers. Three formulas
 * declared `C.window().cost`, which resolves to nothing — the window has to be
 * named in the id — so IMP_SCALE, IMP_LOSTIS and IMP_WASTE_30 could never
 * return a number on any account until this was fixed.
 */
export const WINDOW_30D_COST = "C.window(30d).cost";

export const DEFAULT_CURRENCY = "USD";

/**
 * IMP_MEASUREMENT's second factor. It is a named input, not a loose scalar: the
 * check supplies it through `facts` / `overrides` with its own settledness, and
 * without it the formula refuses to price anything.
 */
export const SHARE_OF_SPEND_AFFECTED = "share_of_spend_affected";

export interface ImpactContext {
  scope: NodeRef;
  metrics: MetricLookup;
  currency?: string | undefined;
  /**
   * Values the CHECK already computed for a metric id (e.g. the summed spend of
   * the keyword set it is about). Read before the registry, under the same id,
   * so provenance stays honest.
   */
  overrides?: Record<string, MetricValue | NotComputable> | undefined;
  /**
   * The check's own fact block (shopping / slices groups put `Pr.spend`,
   * `SL.device().cost`, `T.waste_floor` here). Read BEFORE the registry, under
   * the same metric id. A bare number carries no provenance, so it is treated
   * as unsettled — the monthly figure still prints, the annual one does not.
   */
  facts?: Record<string, number | MetricValue | NotComputable | undefined>;
  /**
   * Non-metric scalars a formula needs: `sliceKind` for IMP_CPA_GAP.
   * `share_of_spend_affected` is NOT read from here — it must arrive as a named
   * input through `facts` / `overrides` so the writer can cite it.
   */
  params?: Record<string, number | string | undefined>;
}

export interface ImpactFormula {
  id: ImpactFormulaId;
  describe: string;
  /** Every metric id the formula may consume. Each one exists in build sheet §A. */
  inputs: string[];
  compute(ctx: ImpactContext): Impact;
}

// ---------------------------------------------------------------------------
// resolution helpers
// ---------------------------------------------------------------------------

interface Resolved {
  input: ImpactInput;
  value: number;
}

/** A bare number out of a check's fact block: real, but with no provenance and no settledness. */
function factToMetricValue(id: string, v: number): MetricValue {
  return {
    id,
    value: v,
    settledStrict: false,
    settledPractical: false,
    source: { table: "check facts" },
  };
}

function lookup(ctx: ImpactContext, id: string): MetricValue | NotComputable {
  const o = ctx.overrides?.[id];
  if (o) return o;
  const f = ctx.facts?.[id];
  if (typeof f === "number" && Number.isFinite(f)) return factToMetricValue(id, f);
  if (f && typeof f === "object") return f;
  return ctx.metrics.get(id, ctx.scope);
}

/** A numeric metric, or null with the reason recorded. */
function resolveNumber(ctx: ImpactContext, id: string, reasons: string[]): Resolved | null {
  const mv = lookup(ctx, id);
  if (isNotComputable(mv)) {
    reasons.push(`${id} not computable: ${mv.reason}`);
    return null;
  }
  if (typeof mv.value !== "number" || !Number.isFinite(mv.value)) {
    reasons.push(`${id} has no numeric value`);
    return null;
  }
  const capped = sampleBlocksQuantification(mv);
  if (capped) {
    reasons.push(`${id} ${capped}`);
    return null;
  }
  return {
    value: mv.value,
    input: {
      metric: id,
      value: mv.value,
      settledStrict: mv.settledStrict,
      settledPractical: mv.settledPractical,
    },
  };
}

/**
 * §8.4 rule 4: a capped fetch or an orphan-only population can support a
 * statement but never a dollar figure. Returns the reason, or null when the
 * value may be quantified.
 */
export function sampleBlocksQuantification(mv: MetricValue): string | null {
  if (mv.truncated) return "came from a capped fetch — a sample cannot be priced as a total";
  if (mv.population === "orphan_only") return "is built from rows that join no node of this audit";
  return null;
}

/**
 * What each formula's money IS. Every formula returns spend units, so severity
 * and ranking compare like with like; the kind says whether that spend was
 * wasted, is at stake, or is upside not yet taken.
 */
const KIND_BY_FORMULA: Partial<Record<ImpactFormulaId, ImpactKind>> = {
  IMP_WASTE_90: "waste",
  IMP_WASTE_30: "waste",
  IMP_CPA_GAP: "waste",
  // the spend a fall in return made less productive: at stake, not wasted
  IMP_VALUE_GAP: "at_risk",
  IMP_LOSTIS: "gain",
  IMP_SCALE: "gain",
  IMP_MEASUREMENT: "at_risk",
  IMP_STRUCTURAL: "at_risk",
};

function finish(
  formulaId: ImpactFormulaId,
  monthly: number,
  used: Resolved[],
  ctx: ImpactContext,
  reasons: string[],
  kind: ImpactKind | undefined = KIND_BY_FORMULA[formulaId],
): Impact {
  const inputs = used.map((u) => u.input);
  const settled = inputs.length > 0 && inputs.every((i) => i.settledStrict);
  const value = Math.round(monthly * 100) / 100;
  if (!settled) reasons.push("annual figure withheld: the monthly figure is not settled");
  return {
    formulaId,
    value,
    ...(kind ? { kind } : {}),
    currency: ctx.currency ?? DEFAULT_CURRENCY,
    inputs,
    annual: settled ? Math.round(value * 12 * 100) / 100 : null,
    settled,
    quantified: true,
    reasons,
  };
}

/** Real but not quantifiable — the honest answer when an input is missing or the sample is capped. */
export function impactNone(ctx: ImpactContext, reason: string, inputs: ImpactInput[] = []): Impact {
  return {
    formulaId: "IMP_NONE",
    value: null,
    currency: ctx.currency ?? DEFAULT_CURRENCY,
    inputs,
    annual: null,
    settled: false,
    quantified: false,
    reasons: [reason],
  };
}

// ---------------------------------------------------------------------------
// the eight formulas
// ---------------------------------------------------------------------------

/**
 * The spend basis for "wasted money": ONE id per scope kind, no fall-through.
 *
 * An earlier version walked every kind until something resolved, which ended at
 * the scope-blind `A.spend` and let a single wasteful SKU claim the whole
 * account (a `product` scope returning more than 100% of monthly spend, critical). An unmapped kind is now IMP_NONE with the reason.
 *
 * `slice` scopes (device / geo / demographic / audience) resolve through
 * `params.sliceKind`, because §A.8 keys those metrics by family, not by node.
 */
const WASTE_BASIS_BY_KIND: Partial<Record<NodeRef["kind"], string>> = {
  account: "A.spend",
  campaign: "C.spend",
  adGroup: "G.spend",
  keyword: "K.spend",
  searchTerm: "T.spend",
  landingPage: "L.spend",
  product: "Pr.spend",
  placement: "Pl.cost",
};

const SLICE_COST_ID: Record<string, string> = {
  device: "SL.device().cost",
  geo: "SL.geo().cost",
  demo: "SL.demo().cost",
  demographic: "SL.demo().cost",
  audience: "SL.audience().cost",
  // SK22's crossed day-and-hour cell (Round 2 Y1): the check hands the cell's
  // own 90-day cost in as a fact under this id; a dead cell's spend is waste.
  hour: "SL.dow_hour().cost",
};

const SLICE_CONV_ID: Record<string, string> = {
  device: "SL.device().conv",
  geo: "SL.geo().conv",
  demo: "SL.demo().conv",
  demographic: "SL.demo().conv",
  audience: "SL.audience().conv",
};

/** §A gives a cpa only to the device family; the others derive it from cost / conv. */
const SLICE_CPA_ID: Record<string, string | null> = {
  device: "SL.device().cpa",
  geo: null,
  demo: null,
  demographic: null,
  audience: null,
};

/**
 * R3.6e: a ROLL-UP of many small rows (SK27 search terms sharing a word, PX16
 * placements on one site) is an account-scope finding whose waste is the sum of
 * exactly those rows — never `A.spend`. The check hands that sum in as this
 * fact; only when it is present does IMP_WASTE_90 read it instead of the scope's
 * own basis. The check leaves it out when its rows came from a capped fetch.
 */
export const ROLLUP_WASTED_COST_90D = "rollup_wasted_cost_90d";
/**
 * Set to 1 beside the roll-up total when its rows came from a capped fetch. The
 * total is then a sample: stated, never priced. The check ALWAYS sends the total
 * so an account-scope roll-up can never fall through to `A.spend`.
 */
export const ROLLUP_IS_SAMPLE = "rollup_is_sample";
/**
 * Round 4 item 6: set to 1 on a PX05 break-even finding (a product that sells, for less
 * than it costs). It is never priced as waste: the orders are real — this is a margin
 * problem. B19: the shortfall (`shortfall_cost_90d`, ad cost minus sales value) is priced
 * per month as margin AT RISK instead of carrying no money at all.
 */
export const BREAK_EVEN_NOT_PRICED = "break_even_not_priced";
/** PX05's break-even shortfall over the 90-day window (ad cost minus sales value). */
export const SHORTFALL_COST_90D = "shortfall_cost_90d";
/**
 * B19: real spend at stake in the finding's own scope over the 90-day audit window
 * (SK15: a not-approved ad's own spend; ads carry no daily series, so there is no
 * 30-day figure). Priced / 3 per month as money at risk, never as waste.
 */
export const AT_RISK_COST_90D = "at_risk_cost_90d";

const WASTE_BASIS_IDS = [
  ...new Set([
    ...Object.values(WASTE_BASIS_BY_KIND),
    ...Object.values(SLICE_COST_ID),
    ROLLUP_WASTED_COST_90D,
  ]),
];

/** The one spend id this scope is allowed to be judged by. null = the scope has none. */
export function wasteBasisId(scope: NodeRef, params?: ImpactContext["params"]): string | null {
  if (scope.kind === "slice" || scope.kind === "channelSlice") {
    const fam = String(params?.sliceKind ?? "");
    return SLICE_COST_ID[fam] ?? null;
  }
  return WASTE_BASIS_BY_KIND[scope.kind] ?? null;
}

const IMP_WASTE_90: ImpactFormula = {
  id: "IMP_WASTE_90",
  describe: "wasted_cost_90d / 3 — money the window already spent with nothing to show, per month",
  inputs: [...WASTE_BASIS_IDS, SHORTFALL_COST_90D],
  compute(ctx) {
    if (ctx.facts?.[BREAK_EVEN_NOT_PRICED] === 1) {
      // the orders are real: the shortfall is margin at risk, never waste
      const reasons: string[] = [];
      const shortfall = resolveNumber(ctx, SHORTFALL_COST_90D, reasons);
      if (!shortfall || shortfall.value <= 0) {
        return impactNone(
          ctx,
          `the orders are real — this is a margin problem, not waste; ${reasons.join("; ") || "no shortfall to price"}`,
        );
      }
      return finish(
        "IMP_WASTE_90",
        shortfall.value / DAYS_PER_MONTH_DIVISOR,
        [shortfall],
        ctx,
        [
          "margin at risk, not waste: the orders are real",
          `${SHORTFALL_COST_90D} ${shortfall.value} / ${DAYS_PER_MONTH_DIVISOR} months in the 90-day window`,
        ],
        "at_risk",
      );
    }
    const rollup = ctx.facts?.[ROLLUP_WASTED_COST_90D] !== undefined;
    if (rollup && ctx.facts?.[ROLLUP_IS_SAMPLE] === 1) {
      return impactNone(
        ctx,
        `${ROLLUP_WASTED_COST_90D} came from a capped fetch — a sample cannot be priced as a total`,
      );
    }
    const basisId = rollup ? ROLLUP_WASTED_COST_90D : wasteBasisId(ctx.scope, ctx.params);
    if (!basisId) {
      return impactNone(
        ctx,
        `no spend basis is defined for a '${ctx.scope.kind}' scope — the waste cannot be priced here`,
      );
    }
    const reasons: string[] = [];
    const basis = resolveNumber(ctx, basisId, reasons);
    if (!basis) return impactNone(ctx, reasons.join("; "));
    return finish("IMP_WASTE_90", basis.value / DAYS_PER_MONTH_DIVISOR, [basis], ctx, [
      `${basisId} ${basis.value} / ${DAYS_PER_MONTH_DIVISOR} months in the 90-day window`,
    ]);
  },
};

const IMP_WASTE_30: ImpactFormula = {
  id: "IMP_WASTE_30",
  describe: "wasted_cost_30d — already a monthly figure, taken from the 30-day window",
  inputs: [WINDOW_30D_COST],
  compute(ctx) {
    const reasons: string[] = [];
    const cost = resolveNumber(ctx, WINDOW_30D_COST, reasons);
    if (!cost) return impactNone(ctx, reasons.join("; "));
    return finish("IMP_WASTE_30", cost.value, [cost], ctx, [
      "30-day wasted cost is already monthly",
    ]);
  },
};

const IMP_SCALE: ImpactFormula = {
  id: "IMP_SCALE",
  describe:
    "min(C.budget_daily*30*0.20, C.budget_daily*30 - C.window(30d).cost) * (C.roas - A.roas) / C.roas — budget the campaign leaves unspent (at most 20% of the monthly budget), weighted by how far its return sits above the account's",
  inputs: ["C.budget_daily", WINDOW_30D_COST, "C.roas", "A.roas"],
  compute(ctx) {
    const reasons: string[] = [];
    const budget = resolveNumber(ctx, "C.budget_daily", reasons);
    const cost30 = resolveNumber(ctx, WINDOW_30D_COST, reasons);
    const cRoas = resolveNumber(ctx, "C.roas", reasons);
    const aRoas = resolveNumber(ctx, "A.roas", reasons);
    if (!budget || !cost30 || !cRoas || !aRoas) return impactNone(ctx, reasons.join("; "));
    if (cRoas.value <= 0)
      return impactNone(ctx, "campaign ROAS is 0 — no return to weigh its unspent budget by");
    const monthlyBudget = budget.value * 30;
    const headroom = Math.min(monthlyBudget * 0.2, monthlyBudget - cost30.value);
    if (headroom <= 0)
      return impactNone(ctx, "the campaign already spends its full monthly budget");
    const edge = (cRoas.value - aRoas.value) / cRoas.value;
    if (edge <= 0) return impactNone(ctx, "campaign does not return above the account");
    return finish("IMP_SCALE", headroom * edge, [budget, cost30, cRoas, aRoas], ctx, [
      `unspent budget ${headroom.toFixed(2)} (at most 20% of the monthly budget), return ${(edge * 100).toFixed(1)}% above the account`,
    ]);
  },
};

const IMP_LOSTIS: ImpactFormula = {
  id: "IMP_LOSTIS",
  describe:
    "C.window(30d).cost * lost share/100 * C.roas / max(C.roas,1) — spend the campaign is not reaching: impression share lost to budget over the last 3 weeks (the 90-day share only when those were not read), priced at its 30-day spend; none when the campaign misses its bar: the client's declared target (return_bar / declared_target_cpa from the check), else break-even from the stated margin (return_bar), else the account's return (A.roas); none when the bar is unknown",
  inputs: [
    WINDOW_30D_COST,
    "C.lost_is_budget_recent_pct",
    "C.lost_is_budget_pct",
    "C.roas",
    "A.roas",
    "return_bar",
    "declared_target_cpa",
    "C.cpa",
  ],
  compute(ctx) {
    const reasons: string[] = [];
    const cost30 = resolveNumber(ctx, WINDOW_30D_COST, reasons);
    // a limit from the launch weeks is not a limit today: the recent share decides
    const lostPct =
      resolveNumber(ctx, "C.lost_is_budget_recent_pct", []) ??
      resolveNumber(ctx, "C.lost_is_budget_pct", reasons);
    const cRoas = resolveNumber(ctx, "C.roas", reasons);
    if (!cost30 || !lostPct || !cRoas) return impactNone(ctx, reasons.join("; "));
    if (lostPct.value <= 0) return impactNone(ctx, "no impressions lost to budget");
    // the bar the check chose (client target, then break-even, then the account)
    const cpaBar = resolveNumber(ctx, "declared_target_cpa", []);
    let bar: Resolved | null;
    if (cpaBar) {
      const cpa = resolveNumber(ctx, "C.cpa", reasons);
      if (!cpa) return impactNone(ctx, reasons.join("; "));
      if (cpa.value > cpaBar.value)
        return impactNone(
          ctx,
          `campaign costs ${cpa.value.toFixed(2)} per sale, above the declared target of ${cpaBar.value.toFixed(2)}: the views it misses are not priced`,
        );
      bar = cpaBar;
    } else {
      bar = resolveNumber(ctx, "return_bar", []) ?? resolveNumber(ctx, "A.roas", reasons);
      if (!bar) return impactNone(ctx, reasons.join("; "));
      if (cRoas.value < bar.value)
        return impactNone(
          ctx,
          `campaign returns ${cRoas.value.toFixed(2)} per 1 spent, below its bar of ${bar.value.toFixed(2)}: the views it misses are not priced`,
        );
    }
    const monthly =
      ((cost30.value * lostPct.value) / 100) * (cRoas.value / Math.max(cRoas.value, 1));
    return finish("IMP_LOSTIS", monthly, [cost30, lostPct, cRoas, bar], ctx, [
      `${lostPct.value}% impression share lost to budget on 30-day spend ${cost30.value}, damped by ROAS ${cRoas.value}`,
    ]);
  },
};

const IMP_CPA_GAP: ImpactFormula = {
  id: "IMP_CPA_GAP",
  describe:
    "(slice.cpa - scope.cpa) * slice.conv_30d — what the dearer slice costs over the scope it sits in, per month; a landing page with sales value tracked: (page spend - page value / account return) / 3",
  inputs: [
    "SL.device().cpa",
    "SL.device().cost",
    "SL.device().conv",
    "SL.geo().cost",
    "SL.geo().conv",
    "SL.demo().cost",
    "SL.demo().conv",
    "SL.audience().cost",
    "SL.audience().conv",
    "L.spend",
    "L.conv",
    "L.value",
    "A.conv_value",
    "A.spend",
    "C.cpa",
    "A.cpa",
  ],
  compute(ctx) {
    const reasons: string[] = [];
    // Round 2 Y1: a LANDING PAGE is priced against the account (pages are not
    // inside one campaign): page spend minus what its conversions would have
    // cost at the account CPA, per month. = (page CPA - account CPA) x page
    // conv when the page converts, = the page's whole spend when it never does.
    if (ctx.scope.kind === "landingPage") {
      // R5: with sales value tracked a page is priced on value, as SK20 judges it: page spend
      // minus what its sales would have cost at the account's return per $1, per month
      const valueReasons: string[] = [];
      const lValue = resolveNumber(ctx, "L.value", valueReasons);
      const aValue = resolveNumber(ctx, "A.conv_value", valueReasons);
      const aSpend = resolveNumber(ctx, "A.spend", valueReasons);
      if (lValue && aValue && aSpend && aValue.value > 0 && aSpend.value > 0) {
        const spend = resolveNumber(ctx, "L.spend", reasons);
        if (!spend) return impactNone(ctx, reasons.join("; "));
        const aReturn = aValue.value / aSpend.value;
        const excess = spend.value - lValue.value / aReturn;
        if (excess <= 0)
          return impactNone(ctx, "the page returns no less per 1 spent than the account");
        return finish(
          "IMP_CPA_GAP",
          excess / DAYS_PER_MONTH_DIVISOR,
          [
            spend,
            lValue,
            aValue,
            aSpend,
            {
              value: DAYS_PER_MONTH_DIVISOR,
              input: {
                metric: "const.months_in_90d_window",
                value: DAYS_PER_MONTH_DIVISOR,
                settledStrict: true,
                settledPractical: true,
              },
            },
          ],
          ctx,
          [
            `page spend ${spend.value.toFixed(2)} minus its sales ${lValue.value.toFixed(2)} at the account's return ${aReturn.toFixed(2)} per 1 = ${excess.toFixed(2)} over 90 days, / ${DAYS_PER_MONTH_DIVISOR} months`,
          ],
        );
      }
      const spend = resolveNumber(ctx, "L.spend", reasons);
      const conv = resolveNumber(ctx, "L.conv", reasons);
      const aCpa = resolveNumber(ctx, "A.cpa", reasons);
      if (!spend || !conv || !aCpa) return impactNone(ctx, reasons.join("; "));
      const excess = spend.value - conv.value * aCpa.value;
      if (excess <= 0)
        return impactNone(ctx, "the page costs no more per conversion than the account");
      return finish(
        "IMP_CPA_GAP",
        excess / DAYS_PER_MONTH_DIVISOR,
        [
          spend,
          conv,
          aCpa,
          {
            value: DAYS_PER_MONTH_DIVISOR,
            input: {
              metric: "const.months_in_90d_window",
              value: DAYS_PER_MONTH_DIVISOR,
              settledStrict: true,
              settledPractical: true,
            },
          },
        ],
        ctx,
        [
          `page spend ${spend.value.toFixed(2)} minus ${conv.value} conversions at the account CPA ${aCpa.value.toFixed(2)} = ${excess.toFixed(2)} over 90 days, / ${DAYS_PER_MONTH_DIVISOR} months`,
        ],
      );
    }
    // No default: a scope whose type names no slice family (landing_page,
    // ad_group…) used to fall to 'device', so a demographic finding reached for
    // a device metric and only failed closed by accident.
    const sliceKind = ctx.params?.sliceKind == null ? "" : String(ctx.params.sliceKind);
    if (!sliceKind) {
      return impactNone(
        ctx,
        `a '${ctx.scope.kind}' scope names no slice family — IMP_CPA_GAP prices a slice against the scope it sits in, and there is no slice here`,
      );
    }
    if (!(sliceKind in SLICE_CONV_ID)) return impactNone(ctx, `unknown slice kind '${sliceKind}'`);
    const conv = resolveNumber(ctx, SLICE_CONV_ID[sliceKind] ?? "", reasons);
    if (!conv) return impactNone(ctx, reasons.join("; "));
    if (conv.value <= 0)
      return impactNone(ctx, "the slice has no conversions — a CPA gap cannot be priced");

    const used: Resolved[] = [conv];
    let sliceCpa: number | null = null;
    const cpaId = SLICE_CPA_ID[sliceKind];
    if (cpaId) {
      const direct = resolveNumber(ctx, cpaId, reasons);
      if (direct) {
        sliceCpa = direct.value;
        used.push(direct);
      }
    }
    if (sliceCpa == null) {
      const cost = resolveNumber(ctx, SLICE_COST_ID[sliceKind] ?? "", reasons);
      if (!cost) return impactNone(ctx, reasons.join("; "));
      sliceCpa = cost.value / conv.value;
      used.push(cost);
    }

    // The scope the slice is compared against: its campaign when it names one,
    // else the account (rule 6/7). There is NO fallback from the campaign to
    // the account: substituting A.cpa for a campaign CPA that will not resolve
    // is unbounded in the overstating direction (account 10, campaign 150,
    // slice 160 → the true gap is $10/conv and the printed one is $150/conv).
    const namesCampaign = ctx.scope.kind === "campaign" || ctx.scope.campaignId != null;
    const scopeCpaId = ctx.scope.kind !== "account" && namesCampaign ? "C.cpa" : "A.cpa";
    const scopeCpa = resolveNumber(ctx, scopeCpaId, reasons);
    if (!scopeCpa) {
      return impactNone(
        ctx,
        scopeCpaId === "C.cpa"
          ? `${reasons.join("; ")} — the finding sits in campaign ${ctx.scope.campaignName ?? ctx.scope.campaignId ?? ctx.scope.id}, and the account CPA is not a substitute for its baseline`
          : reasons.join("; "),
      );
    }
    used.push(scopeCpa);

    const gap = sliceCpa - scopeCpa.value;
    if (gap <= 0) return impactNone(ctx, "the slice is not dearer than its scope");

    // §A.8 defines every SL.*().conv as a 90-DAY count, and §B wants conv_30d.
    // The divisor is a named input so the writer can see the figure is monthly.
    used.push({
      value: DAYS_PER_MONTH_DIVISOR,
      input: {
        metric: "const.months_in_90d_window",
        value: DAYS_PER_MONTH_DIVISOR,
        settledStrict: true,
        settledPractical: true,
      },
    });
    const convMonthly = conv.value / DAYS_PER_MONTH_DIVISOR;
    return finish("IMP_CPA_GAP", gap * convMonthly, used, ctx, [
      `${sliceKind} CPA ${sliceCpa.toFixed(2)} vs ${scopeCpaId === "C.cpa" ? `campaign ${ctx.scope.campaignName ?? ctx.scope.campaignId ?? ctx.scope.id}` : "account"} CPA ${scopeCpa.value.toFixed(2)} over ${convMonthly.toFixed(2)} conversions/month (${conv.value} in the 90-day window)`,
    ]);
  },
};

/**
 * IMP_VALUE_GAP — what a fall in return costs, per month.
 *
 * `spend_now - sales_now / roas_before`: the spend the earlier rate would not
 * have needed for the sales the period actually brought — a SPEND figure, so it
 * compares to monthly spend like every other formula. Never capped at the
 * sales lost: when spend rises and sales hold, the extra spend IS the cost.
 * The earlier `(roas_before - roas_now) * spend_now` was a sales value and put
 * $8,474/month on a campaign spending ~$1k/month.
 *
 * This exists because the account's single largest problem could not carry a
 * dollar figure. TR01a — "return on spend is down across the account" — was
 * priced with IMP_MEASUREMENT, whose kind is `at_risk`, and `sumWaste` excludes
 * `at_risk` by design, so an account-wide decline carried no dollar figure and
 * ranked below a small finding. IMP_MEASUREMENT was the wrong instrument: it prices spend
 * judged on unverified data, and a decline is not a measurement doubt — the
 * numbers are trusted, they simply got worse.
 *
 * Both inputs are named facts from the check, never the registry, because the
 * comparison window is the check's own (recent30 vs prior30) and only the check
 * knows which pair it compared.
 */
const IMP_VALUE_GAP: ImpactFormula = {
  id: "IMP_VALUE_GAP",
  describe:
    "spend_monthly * (1 - roas_recent30 / roas_prior30) — the spend the earlier rate would not have needed for the same sales, per month (spend, never sales value)",
  inputs: ["roas_prior30", "roas_recent30", "spend_monthly", "A.spend_monthly"],
  compute(ctx) {
    const reasons: string[] = [];
    const before = resolveNumber(ctx, "roas_prior30", reasons);
    const now = resolveNumber(ctx, "roas_recent30", reasons);
    if (!before || !now) {
      return impactNone(
        ctx,
        `both sides of the comparison must be supplied as named inputs — ${reasons.join("; ") || "one was missing"}`,
      );
    }
    // An IMPROVEMENT is not an impact. The check should not have fired, but a
    // formula that returned a negative "cost" would print as money saved.
    if (before.value <= now.value) {
      return impactNone(
        ctx,
        `return did not fall (${before.value} then, ${now.value} now) — there is no gap to price`,
      );
    }
    // the finding's own monthly spend (a campaign's), never the account's for a campaign;
    // account spend stands in only for an account-scope finding (TR01a)
    const own = resolveNumber(ctx, "spend_monthly", reasons);
    const monthlySpend = own
      ? { value: own.value, used: [own] }
      : ctx.scope.kind === "account"
        ? resolveMonthlySpend(ctx, reasons)
        : null;
    if (!monthlySpend) return impactNone(ctx, reasons.join("; "));
    // B18: in SPEND units — the part of the spend that the earlier rate would not
    // have needed for the sales it brought (spend_now - sales_now / roas_before).
    // The old (before - now) × spend was a SALES value and was compared to spend.
    const gap = monthlySpend.value * (1 - now.value / before.value);
    const lines = [
      `return fell ${before.value.toFixed(2)}x to ${now.value.toFixed(2)}x on ${monthlySpend.value.toFixed(2)} of monthly spend: ${gap.toFixed(2)} of it bought no more than the earlier rate would have`,
    ];
    return finish("IMP_VALUE_GAP", gap, [before, now, ...monthlySpend.used], ctx, lines);
  },
};

const IMP_MEASUREMENT: ImpactFormula = {
  id: "IMP_MEASUREMENT",
  describe:
    'A.spend_monthly * share_of_spend_affected — money AT RISK, not money saved; always labelled "spend judged on unverified data"',
  inputs: ["A.spend_monthly", "A.spend", "W.window_days", SHARE_OF_SPEND_AFFECTED],
  compute(ctx) {
    const reasons: string[] = ["spend judged on unverified data — money at risk, not money saved"];
    // A named input with its own provenance and settledness, never a bare scalar
    // and never defaulted to 1: an unsized share is not a dollar claim.
    const share = resolveNumber(ctx, SHARE_OF_SPEND_AFFECTED, reasons);
    if (!share || share.value <= 0) {
      return impactNone(
        ctx,
        `${SHARE_OF_SPEND_AFFECTED} was not supplied as a named input — the money at risk cannot be sized`,
      );
    }
    if (share.value > 1)
      return impactNone(ctx, `${SHARE_OF_SPEND_AFFECTED} must be a share of 1, got ${share.value}`);
    const monthlySpend = resolveMonthlySpend(ctx, reasons);
    if (!monthlySpend) return impactNone(ctx, reasons.join("; "));
    return finish(
      "IMP_MEASUREMENT",
      monthlySpend.value * share.value,
      [...monthlySpend.used, share],
      ctx,
      [
        ...reasons,
        `${(share.value * 100).toFixed(1)}% of monthly spend ${monthlySpend.value.toFixed(2)}`,
      ],
    );
  },
};

const IMP_STRUCTURAL: ImpactFormula = {
  id: "IMP_STRUCTURAL",
  describe:
    "0 — structural findings (policy, settings, missing lists) carry no dollar claim; when the check names the spend at stake over the 90-day window (at_risk_cost_90d / 3), that spend is money at risk per month",
  inputs: [AT_RISK_COST_90D],
  compute(ctx) {
    // B19: a not-approved ad that spends puts that spend at risk (SK15)
    const reasons: string[] = [];
    if (ctx.facts?.[AT_RISK_COST_90D] !== undefined) {
      const atRisk = resolveNumber(ctx, AT_RISK_COST_90D, reasons);
      if (atRisk && atRisk.value > 0) {
        return finish("IMP_STRUCTURAL", atRisk.value / DAYS_PER_MONTH_DIVISOR, [atRisk], ctx, [
          "money at risk, not money wasted: the 90-day spend this finding puts at stake",
          `${AT_RISK_COST_90D} ${atRisk.value} / ${DAYS_PER_MONTH_DIVISOR} months in the 90-day window`,
        ]);
      }
    }
    return {
      formulaId: "IMP_STRUCTURAL",
      value: 0,
      currency: ctx.currency ?? DEFAULT_CURRENCY,
      inputs: [],
      annual: null,
      settled: false,
      quantified: false,
      reasons: ["structural finding — no dollar claim is made"],
    };
  },
};

const IMP_NONE_FORMULA: ImpactFormula = {
  id: "IMP_NONE",
  describe: "null — real but not quantifiable (positives, informational, capped samples)",
  inputs: [],
  compute(ctx) {
    return impactNone(ctx, "not quantifiable");
  },
};

/**
 * Monthly account spend — `A.spend_monthly` when the registry has it, else
 * `A.spend / DAYS_PER_MONTH_DIVISOR` (§A: 25,920 / 3 = 8,640; the ×30/91
 * form was retired ).
 */
export function resolveMonthlySpend(
  ctx: ImpactContext,
  reasons: string[],
): { value: number; used: Resolved[] } | null {
  const direct = resolveNumber(ctx, "A.spend_monthly", []);
  if (direct) return { value: direct.value, used: [direct] };
  const spend = resolveNumber(ctx, "A.spend", reasons);
  if (!spend) return null;
  return { value: spend.value / DAYS_PER_MONTH_DIVISOR, used: [spend] };
}

export const IMPACT_FORMULAS: Record<ImpactFormulaId, ImpactFormula> = {
  IMP_WASTE_90,
  IMP_WASTE_30,
  IMP_SCALE,
  IMP_LOSTIS,
  IMP_CPA_GAP,
  IMP_VALUE_GAP,
  IMP_MEASUREMENT,
  IMP_STRUCTURAL,
  IMP_NONE: IMP_NONE_FORMULA,
};

export const IMPACT_FORMULA_IDS = Object.keys(IMPACT_FORMULAS) as ImpactFormulaId[];

/**
 * Declared inputs that are deliberately NOT build-sheet §A metric ids: a
 * check-supplied share and a named divisor. Everything else a formula declares
 * must exist in §A (the scoring test enforces exactly that).
 */
/**
 * Declared inputs that are NOT registry metric ids, and must not be validated
 * against it. `roas_prior30` / `roas_recent30` / `spend_monthly` are named facts
 * supplied by the check itself: only the check knows which pair of windows it
 * compared, so the registry has no id for them (see IMP_VALUE_GAP).
 */
export const NON_REGISTRY_INPUTS = new Set<string>([
  SHARE_OF_SPEND_AFFECTED,
  ROLLUP_WASTED_COST_90D,
  ROLLUP_IS_SAMPLE,
  BREAK_EVEN_NOT_PRICED,
  SHORTFALL_COST_90D,
  AT_RISK_COST_90D,
  "const.months_in_90d_window",
  "roas_prior30",
  "roas_recent30",
  "spend_monthly",
  "return_bar",
  "declared_target_cpa",
]);

export function getImpactFormula(id: ImpactFormulaId): ImpactFormula {
  return IMPACT_FORMULAS[id];
}

/** Run a formula by id. The only way a check gets a dollar figure. */
export function computeImpact(id: ImpactFormulaId, ctx: ImpactContext): Impact {
  return IMPACT_FORMULAS[id].compute(ctx);
}
