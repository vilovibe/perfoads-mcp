// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
/**
 * Scoring layer tests.
 *
 * Covers: every impact formula's declared inputs exist in the metric registry;
 * the severity table; confidence downgrades;
 * annual only when settled; a missing input returns IMP_NONE with a reason.
 */
import {
  IMPACT_FORMULAS,
  IMPACT_FORMULA_IDS,
  computeImpact,
  computeSeverity,
  applyFloorBudget,
  FLOOR_LIFTS_PER_CHECK,
  computeConfidence,
  NON_REGISTRY_INPUTS,
  toSampleSummary,
  wasteBasisId,
  type ImpactContext,
  type MetricLookup,
  type MetricValue,
  type NodeRef,
  type NotComputable,
  type ConfounderSummary,
} from "./index.js";
import { metricIdResolves } from "../adapters.js";
import { countMoneyOnce, pricesWholeCampaign } from "./moneyOverlap.js";
import type { Candidate } from "../runEvidenceEngine.js";
import { DAYS_PER_MONTH, TINY_SPEND_CHECKS } from "./severity.js";

// ---------------------------------------------------------------------------
// test doubles
// ---------------------------------------------------------------------------
const ACCOUNT: NodeRef = { kind: "account", id: "1234567890", name: "Example account" };
const CAMPAIGN: NodeRef = { kind: "campaign", id: "2001", name: "Remarketing campaign" };
const KEYWORD: NodeRef = { kind: "keyword", id: "kw-1", name: "canvas tote" };

function mv(
  id: string,
  value: number | string | boolean | null,
  opts: Partial<MetricValue> = {},
): MetricValue {
  return {
    id,
    value,
    settledStrict: true,
    settledPractical: true,
    population: "real",
    truncated: false,
    ...opts,
  };
}

function lookupOf(values: Record<string, MetricValue>): MetricLookup {
  return {
    get(id: string): MetricValue | NotComputable {
      const v = values[id];
      if (v) return v;
      return { id, notComputable: true, reason: "no row for this metric on this scope" };
    },
  };
}

function ctxOf(
  scope: NodeRef,
  values: Record<string, MetricValue>,
  params?: ImpactContext["params"],
): ImpactContext {
  return { scope, metrics: lookupOf(values), ...(params ? { params } : {}) };
}

const CLEARED: ConfounderSummary[] = [{ id: "MI01", state: "cleared" }];
const UNKNOWN_ONE: ConfounderSummary[] = [{ id: "MI01", state: "unknown" }];

// ---------------------------------------------------------------------------
describe("impact formulas", () => {
  // IMP_VALUE_GAP is the ninth, added 2026-09-07: the sheet's eight had no way to
  // price a fall in return, which is why the account's largest problem shipped
  // with dollar_impact_monthly = NULL.
  it("implements exactly the nine ids: build sheet §B plus IMP_VALUE_GAP", () => {
    expect(IMPACT_FORMULA_IDS.sort()).toEqual([
      "IMP_CPA_GAP",
      "IMP_LOSTIS",
      "IMP_MEASUREMENT",
      "IMP_NONE",
      "IMP_SCALE",
      "IMP_STRUCTURAL",
      "IMP_VALUE_GAP",
      "IMP_WASTE_30",
      "IMP_WASTE_90",
    ]);
  });

  it("every declared input is an id the REAL registry resolves", () => {
    // This used to compare against a hand-written copy of build sheet §A
    // through a normaliser that collapsed `C.window(30d).cost` to
    // `C.window().cost` — i.e. it normalised away exactly the difference that
    // breaks the runtime lookup. Four formulas declared ids that resolve to
    // nothing, and IMP_SCALE / IMP_LOSTIS / IMP_WASTE_30 could not return a
    // number on any account. The registry is the only authority.
    const unknown: string[] = [];
    for (const id of IMPACT_FORMULA_IDS) {
      for (const input of IMPACT_FORMULAS[id].inputs) {
        if (NON_REGISTRY_INPUTS.has(input)) continue;
        if (!metricIdResolves(input)) unknown.push(`${id}: ${input}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("the waste basis of every scope kind is an id the registry resolves", () => {
    for (const kind of [
      "account",
      "campaign",
      "adGroup",
      "keyword",
      "searchTerm",
      "landingPage",
      "product",
      "placement",
    ] as NodeRef["kind"][]) {
      const basis = wasteBasisId({ kind, id: "x" });
      expect(basis).not.toBeNull();
      expect(metricIdResolves(basis!)).toBe(true);
    }
    for (const sliceKind of ["device", "geo", "demographic", "audience"]) {
      const basis = wasteBasisId({ kind: "slice", id: "TABLET" }, { sliceKind });
      expect(basis).not.toBeNull();
      expect(metricIdResolves(basis!)).toBe(true);
    }
  });

  it("every formula has a description and an id that matches its key", () => {
    for (const id of IMPACT_FORMULA_IDS) {
      expect(IMPACT_FORMULAS[id].id).toBe(id);
      expect(IMPACT_FORMULAS[id].describe.length).toBeGreaterThan(10);
    }
  });

  it("IMP_WASTE_90 divides the window spend into a monthly figure and names what it consumed", () => {
    // a campaign with 79.56 spent and 0 conversions.
    const impact = computeImpact(
      "IMP_WASTE_90",
      ctxOf(CAMPAIGN, { "C.spend": mv("C.spend", 79.56) }),
    );
    expect(impact.value).toBeCloseTo(26.52, 2);
    expect(impact.formulaId).toBe("IMP_WASTE_90");
    expect(impact.inputs.map((i) => i.metric)).toEqual(["C.spend"]);
    expect(impact.quantified).toBe(true);
  });

  it("IMP_WASTE_90 picks the spend basis that fits the scope", () => {
    const impact = computeImpact(
      "IMP_WASTE_90",
      ctxOf(KEYWORD, { "K.spend": mv("K.spend", 300), "A.spend": mv("A.spend", 25920) }),
    );
    expect(impact.inputs.map((i) => i.metric)).toEqual(["K.spend"]);
    expect(impact.value).toBeCloseTo(100, 2);
  });

  it("a check may pass its own aggregate under the same metric id (overrides beat the registry)", () => {
    const impact = computeImpact("IMP_WASTE_90", {
      scope: KEYWORD,
      metrics: lookupOf({ "K.spend": mv("K.spend", 10) }),
      overrides: { "K.spend": mv("K.spend", 900) },
    });
    expect(impact.value).toBeCloseTo(300, 2);
  });

  it("IMP_SCALE caps the headroom at the 20%/week rung and prices the ROAS edge", () => {
    const impact = computeImpact(
      "IMP_SCALE",
      ctxOf(CAMPAIGN, {
        "C.budget_daily": mv("C.budget_daily", 100),
        "C.window(30d).cost": mv("C.window(30d).cost", 1500),
        "C.roas": mv("C.roas", 4),
        "A.roas": mv("A.roas", 2),
      }),
    );
    // min(3000*0.2=600, 3000-1500=1500) = 600; edge (4-2)/4 = 0.5 → 300
    expect(impact.value).toBeCloseTo(300, 2);
    expect(impact.inputs).toHaveLength(4);
  });

  it("IMP_SCALE returns IMP_NONE when the campaign does not beat the account", () => {
    const impact = computeImpact(
      "IMP_SCALE",
      ctxOf(CAMPAIGN, {
        "C.budget_daily": mv("C.budget_daily", 100),
        "C.window(30d).cost": mv("C.window(30d).cost", 1500),
        "C.roas": mv("C.roas", 1.5),
        "A.roas": mv("A.roas", 2),
      }),
    );
    expect(impact.formulaId).toBe("IMP_NONE");
    expect(impact.value).toBeNull();
    expect(impact.reasons.join(" ")).toMatch(/does not return above the account/);
  });

  it("IMP_LOSTIS prices the impressions lost to budget, damped by ROAS", () => {
    const impact = computeImpact(
      "IMP_LOSTIS",
      ctxOf(CAMPAIGN, {
        "C.window(30d).cost": mv("C.window(30d).cost", 2000),
        "C.lost_is_budget_pct": mv("C.lost_is_budget_pct", 20),
        "C.roas": mv("C.roas", 3),
        "A.roas": mv("A.roas", 2.5),
      }),
    );
    expect(impact.value).toBeCloseTo(400, 2);
  });

  it("IMP_LOSTIS prices the last 3 weeks' share when read, not the 90-day one", () => {
    const impact = computeImpact(
      "IMP_LOSTIS",
      ctxOf(CAMPAIGN, {
        "C.window(30d).cost": mv("C.window(30d).cost", 2000),
        "C.lost_is_budget_recent_pct": mv("C.lost_is_budget_recent_pct", 10),
        "C.lost_is_budget_pct": mv("C.lost_is_budget_pct", 20),
        "C.roas": mv("C.roas", 3),
        "A.roas": mv("A.roas", 2.5),
      }),
    );
    expect(impact.value).toBeCloseTo(200, 2);
  });

  it("IMP_LOSTIS has no money when the campaign returns less per $1 than the account", () => {
    // a PMax campaign at $0.13 per $1, the account $0.72
    const impact = computeImpact(
      "IMP_LOSTIS",
      ctxOf(CAMPAIGN, {
        "C.window(30d).cost": mv("C.window(30d).cost", 110),
        "C.lost_is_budget_pct": mv("C.lost_is_budget_pct", 21.33),
        "C.roas": mv("C.roas", 0.13),
        "A.roas": mv("A.roas", 0.72),
      }),
    );
    expect(impact.formulaId).toBe("IMP_NONE");
    expect(impact.reasons.join(" ")).toMatch(/below its bar of 0\.72/);
  });

  it("IMP_CPA_GAP derives a slice CPA from cost and conv when §A carries no cpa for that family", () => {
    const impact = computeImpact(
      "IMP_CPA_GAP",
      ctxOf(
        CAMPAIGN,
        {
          "SL.geo().cost": mv("SL.geo().cost", 3000),
          "SL.geo().conv": mv("SL.geo().conv", 30),
          "C.cpa": mv("C.cpa", 60),
        },
        { sliceKind: "geo" },
      ),
    );
    // slice cpa 100 vs scope 60 = 40 over 30 conversions in 90 days = 10/month → 400/mo
    expect(impact.value).toBeCloseTo(400, 2);
    expect(impact.inputs.map((i) => i.metric).sort()).toEqual([
      "C.cpa",
      "SL.geo().conv",
      "SL.geo().cost",
      "const.months_in_90d_window",
    ]);
  });

  it("IMP_CPA_GAP on a demographic slice reads the DEMOGRAPHIC metrics, never the device ones", () => {
    // Moved here from evidenceEngineRunner when the A5 brand gate removed this
    // account's only SL07 candidate (GENDER:FEMALE in Brand shopping, rule
    // 31). The guarantee is about the formula, not about that finding: a
    // demographic scope must never reach for `SL.device()`.
    const impact = computeImpact(
      "IMP_CPA_GAP",
      ctxOf(
        { kind: "slice", id: "GENDER:FEMALE", campaignId: "2002", campaignName: "Brand shopping" },
        {
          "SL.demo().cost": mv("SL.demo().cost", 376.89),
          "SL.demo().conv": mv("SL.demo().conv", 3.09),
          "SL.device().cost": mv("SL.device().cost", 178.39),
          "SL.device().conv": mv("SL.device().conv", 1),
          "C.cpa": mv("C.cpa", 48.94),
        },
        { sliceKind: "demographic" },
      ),
    );
    const used = impact.inputs.map((i) => i.metric);
    expect(used).toContain("SL.demo().conv");
    expect(used.some((m) => m.startsWith("SL.device"))).toBe(false);
  });

  it("IMP_CPA_GAP uses the device cpa directly and is IMP_NONE when the slice is not dearer", () => {
    const cheaper = computeImpact(
      "IMP_CPA_GAP",
      ctxOf(
        ACCOUNT,
        {
          "SL.device().cpa": mv("SL.device().cpa", 20),
          "SL.device().conv": mv("SL.device().conv", 50),
          "A.cpa": mv("A.cpa", 37.5),
        },
        { sliceKind: "device" },
      ),
    );
    expect(cheaper.formulaId).toBe("IMP_NONE");
    expect(cheaper.reasons.join(" ")).toMatch(/not dearer/);
  });

  it("IMP_CPA_GAP declines when no slice family is supplied — it never assumes device", () => {
    // a landing_page / ad_group scope names no slice family; the formula used
    // to default to 'device', so a non-device finding reached for a device
    // metric and only failed closed by accident
    // Round 2 Y1: a landing page is now priced on its OWN metrics (next test),
    // so the no-slice case is shown on an ad group
    const impact = computeImpact(
      "IMP_CPA_GAP",
      ctxOf(
        { kind: "adGroup", id: "123" },
        {
          "SL.device().cpa": mv("SL.device().cpa", 500),
          "SL.device().conv": mv("SL.device().conv", 50),
          "A.cpa": mv("A.cpa", 10),
        },
      ),
    );
    expect(impact.formulaId).toBe("IMP_NONE");
    expect(impact.value).toBeNull();
    expect(impact.reasons.join(" ")).toMatch(/names no slice family/);
  });

  it("Round 2 Y1: IMP_CPA_GAP prices a landing page against the account CPA, never off a device metric", () => {
    // page: $900 over 90 days, 10 conversions; account CPA $30 -> excess 900 - 300 = 600 / 3 = $200/mo
    const priced = computeImpact(
      "IMP_CPA_GAP",
      ctxOf(
        { kind: "landingPage", id: "https://example.com/p" },
        {
          "L.spend": mv("L.spend", 900),
          "L.conv": mv("L.conv", 10),
          "A.cpa": mv("A.cpa", 30),
          "SL.device().cpa": mv("SL.device().cpa", 500),
        },
      ),
    );
    expect(priced.formulaId).toBe("IMP_CPA_GAP");
    expect(priced.value).toBe(200);
    expect(priced.inputs.map((i) => i.metric)).not.toContain("SL.device().cpa");
    // a page that never converts: its whole spend, per month
    const dead = computeImpact(
      "IMP_CPA_GAP",
      ctxOf(
        { kind: "landingPage", id: "https://example.com/q" },
        { "L.spend": mv("L.spend", 300), "L.conv": mv("L.conv", 0), "A.cpa": mv("A.cpa", 30) },
      ),
    );
    expect(dead.value).toBe(100);
    // cheaper than the account: nothing to price
    const fine = computeImpact(
      "IMP_CPA_GAP",
      ctxOf(
        { kind: "landingPage", id: "https://example.com/r" },
        { "L.spend": mv("L.spend", 200), "L.conv": mv("L.conv", 10), "A.cpa": mv("A.cpa", 30) },
      ),
    );
    expect(fine.formulaId).toBe("IMP_NONE");
    // no page metrics: declines with the reason, never a number
    const blind = computeImpact(
      "IMP_CPA_GAP",
      ctxOf({ kind: "landingPage", id: "https://example.com/s" }, { "A.cpa": mv("A.cpa", 30) }),
    );
    expect(blind.value).toBeNull();
  });

  it("IMP_CPA_GAP never substitutes the ACCOUNT cpa for a campaign it cannot compute", () => {
    // account 10 / campaign 150 / slice 160: the true gap is $10 per
    // conversion, and the A.cpa "last resort" printed $150.
    const impact = computeImpact(
      "IMP_CPA_GAP",
      ctxOf(
        { kind: "slice", id: "DESKTOP", campaignId: "2002", campaignName: "Brand shopping" },
        {
          "SL.device().cpa": mv("SL.device().cpa", 160),
          "SL.device().conv": mv("SL.device().conv", 30),
          "A.cpa": mv("A.cpa", 10),
        },
        { sliceKind: "device" },
      ),
    );
    expect(impact.formulaId).toBe("IMP_NONE");
    expect(impact.value).toBeNull();
    expect(impact.reasons.join(" ")).toMatch(/C\.cpa not computable/);
    expect(impact.reasons.join(" ")).toMatch(/not a substitute for its baseline/);

    // with the campaign's own CPA it prices the real gap: (160 - 150) * 30/3
    const real = computeImpact(
      "IMP_CPA_GAP",
      ctxOf(
        { kind: "slice", id: "DESKTOP", campaignId: "2002", campaignName: "Brand shopping" },
        {
          "SL.device().cpa": mv("SL.device().cpa", 160),
          "SL.device().conv": mv("SL.device().conv", 30),
          "C.cpa": mv("C.cpa", 150),
          "A.cpa": mv("A.cpa", 10),
        },
        { sliceKind: "device" },
      ),
    );
    expect(real.value).toBeCloseTo(100, 2);
    expect(real.inputs.map((i) => i.metric)).not.toContain("A.cpa");
  });

  it("IMP_MEASUREMENT sizes money at risk from A.spend_monthly and labels it as such", () => {
    const impact = computeImpact(
      "IMP_MEASUREMENT",
      ctxOf(ACCOUNT, {
        "A.spend_monthly": mv("A.spend_monthly", 8500),
        share_of_spend_affected: mv("share_of_spend_affected", 0.5),
      }),
    );
    expect(impact.value).toBeCloseTo(4250, 2);
    expect(impact.inputs.map((i) => i.metric)).toContain("share_of_spend_affected");
    expect(impact.reasons.join(" ")).toMatch(/money at risk, not money saved/);
  });

  it("IMP_MEASUREMENT derives monthly spend as A.spend / 3 when the registry has no A.spend_monthly", () => {
    const impact = computeImpact(
      "IMP_MEASUREMENT",
      ctxOf(ACCOUNT, {
        "A.spend": mv("A.spend", 25920),
        "W.window_days": mv("W.window_days", 91),
        share_of_spend_affected: mv("share_of_spend_affected", 1),
      }),
    );
    expect(impact.value).toBeCloseTo(8640, 1); // 25,920 / DAYS_PER_MONTH_DIVISOR — never ×30/91
    expect(impact.inputs.map((i) => i.metric)).toEqual(["A.spend", "share_of_spend_affected"]);
  });

  it("IMP_MEASUREMENT without share_of_spend_affected is IMP_NONE with a reason, never 0", () => {
    const impact = computeImpact(
      "IMP_MEASUREMENT",
      ctxOf(ACCOUNT, { "A.spend_monthly": mv("A.spend_monthly", 8500) }),
    );
    expect(impact.formulaId).toBe("IMP_NONE");
    expect(impact.value).toBeNull();
    expect(impact.reasons.join(" ")).toMatch(/share_of_spend_affected/);
  });

  it("IMP_VALUE_GAP prices a campaign decline on the campaign's spend, never the account's", () => {
    // live: 15.09x -> 6.34x on a campaign spending 1,017 a month in a 16,040 account
    const values = {
      "A.spend_monthly": mv("A.spend_monthly", 16040),
      roas_prior30: mv("roas_prior30", 15.09),
      roas_recent30: mv("roas_recent30", 6.34),
    };
    const impact = computeImpact("IMP_VALUE_GAP", {
      ...ctxOf(CAMPAIGN, values),
      facts: { spend_monthly: 1017 },
    });
    // spend units: spend_now - sales_now / roas_before, never the sales gap
    expect(impact.value).toBeCloseTo(1017 - (6.34 * 1017) / 15.09, 2);
    expect(impact.value).toBeLessThan(1017);
    expect(impact.inputs.map((i) => i.metric)).not.toContain("A.spend_monthly");
    // a campaign finding without its own spend is not priced on the account's
    const bare = computeImpact("IMP_VALUE_GAP", ctxOf(CAMPAIGN, values));
    expect(bare.formulaId).toBe("IMP_NONE");
    expect(bare.value).toBeNull();
    // the account trend (TR01a) still reads the account's spend
    const account = computeImpact("IMP_VALUE_GAP", ctxOf(ACCOUNT, values));
    expect(account.value).toBeCloseTo(16040 * (1 - 6.34 / 15.09), 2);
  });

  it("IMP_VALUE_GAP is in spend units and never above the campaign's own spend (live TR01 Brand)", () => {
    // live: Brand 14.84x -> 6.46x on 1,011 a month printed 8,474/month (a sales value)
    const values = {
      roas_prior30: mv("roas_prior30", 14.84),
      roas_recent30: mv("roas_recent30", 6.46),
    };
    const impact = computeImpact("IMP_VALUE_GAP", {
      ...ctxOf(CAMPAIGN, values),
      facts: { spend_monthly: 1011 },
    });
    expect(impact.value).toBeCloseTo(571.1, 0);
    expect(impact.value).toBeLessThan(1011);
  });

  it("IMP_VALUE_GAP is never capped at the sales lost: spend that grew while sales held is the full cost", () => {
    // spend 1,000 -> 3,000 a month, sales 10,000 -> 9,900: return 10x -> 3.3x
    const values = {
      roas_prior30: mv("roas_prior30", 10),
      roas_recent30: mv("roas_recent30", 3.3),
    };
    const impact = computeImpact("IMP_VALUE_GAP", {
      ...ctxOf(CAMPAIGN, values),
      facts: { spend_monthly: 3000 },
    });
    // the earlier rate needed 990 for 9,900 of sales: 2,010 of extra spend, not the 100 of lost sales
    expect(impact.value).toBeCloseTo(2010, 2);
    expect(impact.kind).toBe("at_risk");
    expect(impact.reasons.join(" ")).not.toMatch(/capped/);
  });

  it("IMP_STRUCTURAL carries no dollar claim", () => {
    const impact = computeImpact("IMP_STRUCTURAL", ctxOf(ACCOUNT, {}));
    expect(impact.value).toBe(0);
    expect(impact.quantified).toBe(false);
    expect(impact.annual).toBeNull();
  });

  it("IMP_NONE is null with a reason, for real but unquantifiable findings", () => {
    const impact = computeImpact("IMP_NONE", ctxOf(ACCOUNT, {}));
    expect(impact.value).toBeNull();
    expect(impact.quantified).toBe(false);
    expect(impact.reasons).toHaveLength(1);
  });

  it("an impact whose inputs are not all present returns IMP_NONE with a reason rather than 0", () => {
    const impact = computeImpact(
      "IMP_LOSTIS",
      ctxOf(CAMPAIGN, {
        "C.window(30d).cost": mv("C.window(30d).cost", 2000),
        // C.lost_is_budget_pct and C.roas missing
      }),
    );
    expect(impact.formulaId).toBe("IMP_NONE");
    expect(impact.value).toBeNull();
    expect(impact.value).not.toBe(0);
    expect(impact.reasons.join(" ")).toMatch(/C\.lost_is_budget_pct not computable/);
    expect(impact.reasons.join(" ")).toMatch(/C\.roas not computable/);
  });
});

// ---------------------------------------------------------------------------
describe("waste basis is bound to the scope (review blocker 1)", () => {
  const PRODUCT: NodeRef = { kind: "product", id: "sku-1", name: "Canvas tote" };
  const PLACEMENT: NodeRef = { kind: "placement", id: "yt-1", name: "youtube.com/x" };
  const SLICE: NodeRef = { kind: "slice", id: "device:MOBILE", name: "mobile" };

  it("NEVER falls through to A.spend: a product scope with only account spend is IMP_NONE", () => {
    const impact = computeImpact(
      "IMP_WASTE_90",
      ctxOf(PRODUCT, { "A.spend": mv("A.spend", 25920) }),
    );
    expect(impact.formulaId).toBe("IMP_NONE");
    expect(impact.value).toBeNull();
    expect(impact.reasons.join(" ")).toMatch(/Pr\.spend not computable/);
  });

  it("an unmapped scope kind is IMP_NONE with the reason, not the next kind up", () => {
    const impact = computeImpact(
      "IMP_WASTE_90",
      ctxOf({ kind: "ad", id: "ad-1" }, { "A.spend": mv("A.spend", 25920) }),
    );
    expect(impact.formulaId).toBe("IMP_NONE");
    expect(impact.reasons.join(" ")).toMatch(/no spend basis is defined for a 'ad' scope/);
  });

  it.each([
    [PRODUCT, undefined, "Pr.spend"],
    [PLACEMENT, undefined, "Pl.cost"],
    [KEYWORD, undefined, "K.spend"],
    [{ kind: "searchTerm", id: "t-1" } as NodeRef, undefined, "T.spend"],
    [CAMPAIGN, undefined, "C.spend"],
    [ACCOUNT, undefined, "A.spend"],
    [SLICE, { sliceKind: "device" }, "SL.device().cost"],
    [SLICE, { sliceKind: "geo" }, "SL.geo().cost"],
    [SLICE, { sliceKind: "demographic" }, "SL.demo().cost"],
    [SLICE, { sliceKind: "audience" }, "SL.audience().cost"],
  ] as Array<[NodeRef, ImpactContext["params"], string]>)(
    "scope %o resolves its basis to %s",
    (scope, params, expected) => {
      expect(wasteBasisId(scope, params)).toBe(expected);
      const impact = computeImpact(
        "IMP_WASTE_90",
        ctxOf(scope, { [expected]: mv(expected, 300) }, params),
      );
      expect(impact.inputs.map((i) => i.metric)).toEqual([expected]);
      expect(impact.value).toBeCloseTo(100, 2);
    },
  );

  it("reads the basis out of the check fact block when the registry has nothing", () => {
    const impact = computeImpact("IMP_WASTE_90", {
      scope: PRODUCT,
      metrics: lookupOf({}),
      facts: { "Pr.spend": 900 },
    });
    expect(impact.value).toBeCloseTo(300, 2);
    // a bare fact carries no provenance, so it is unsettled and gets no annual figure
    expect(impact.settled).toBe(false);
    expect(impact.annual).toBeNull();
  });

  it("a capped or orphan-only basis is IMP_NONE, not a dollar figure (§8.4 rule 4)", () => {
    const capped = computeImpact(
      "IMP_WASTE_90",
      ctxOf(KEYWORD, { "K.spend": mv("K.spend", 300, { truncated: true }) }),
    );
    expect(capped.formulaId).toBe("IMP_NONE");
    expect(capped.reasons.join(" ")).toMatch(/capped fetch/);
    const orphan = computeImpact(
      "IMP_WASTE_90",
      ctxOf(KEYWORD, { "K.spend": mv("K.spend", 300, { population: "orphan_only" }) }),
    );
    expect(orphan.formulaId).toBe("IMP_NONE");
    expect(orphan.reasons.join(" ")).toMatch(/join no node of this audit/);
  });
});

// ---------------------------------------------------------------------------
describe("IMP_CPA_GAP is monthly, not 90-day (review blocker 2)", () => {
  it("divides the 90d slice conversions by the named divisor", () => {
    const impact = computeImpact(
      "IMP_CPA_GAP",
      ctxOf(
        ACCOUNT,
        {
          "SL.device().cpa": mv("SL.device().cpa", 100),
          "SL.device().conv": mv("SL.device().conv", 30),
          "A.cpa": mv("A.cpa", 60),
        },
        { sliceKind: "device" },
      ),
    );
    // (100 - 60) * (30 / 3 months) = 400/mo, NOT 1200
    expect(impact.value).toBeCloseTo(400, 2);
    const divisor = impact.inputs.find((i) => i.metric === "const.months_in_90d_window");
    expect(divisor?.value).toBe(3);
    expect(impact.reasons.join(" ")).toMatch(
      /10\.00 conversions\/month \(30 in the 90-day window\)/,
    );
  });
});

// ---------------------------------------------------------------------------
describe("IMP_MEASUREMENT refuses an unnamed share (review should-fix 2)", () => {
  it("will not price anything without share_of_spend_affected as a named input", () => {
    const impact = computeImpact(
      "IMP_MEASUREMENT",
      ctxOf(ACCOUNT, { "A.spend_monthly": mv("A.spend_monthly", 8500) }, {
        share_of_spend_affected: 1,
      } as ImpactContext["params"]),
    );
    expect(impact.formulaId).toBe("IMP_NONE");
    expect(impact.reasons.join(" ")).toMatch(/not supplied as a named input/);
  });

  it("takes the settledness of the share, not only of the spend", () => {
    const impact = computeImpact(
      "IMP_MEASUREMENT",
      ctxOf(ACCOUNT, {
        "A.spend_monthly": mv("A.spend_monthly", 8500),
        share_of_spend_affected: mv("share_of_spend_affected", 0.25, {
          settledStrict: false,
          settledPractical: true,
        }),
      }),
    );
    expect(impact.value).toBeCloseTo(2125, 2);
    expect(impact.settled).toBe(false);
    expect(impact.annual).toBeNull();
  });

  it("rejects a share above 1", () => {
    const impact = computeImpact(
      "IMP_MEASUREMENT",
      ctxOf(ACCOUNT, {
        "A.spend_monthly": mv("A.spend_monthly", 8500),
        share_of_spend_affected: mv("share_of_spend_affected", 100),
      }),
    );
    expect(impact.formulaId).toBe("IMP_NONE");
  });
});

// ---------------------------------------------------------------------------
describe("annual figures", () => {
  it("are 12x monthly when every input is settled", () => {
    const impact = computeImpact(
      "IMP_WASTE_90",
      ctxOf(CAMPAIGN, { "C.spend": mv("C.spend", 79.56) }),
    );
    expect(impact.settled).toBe(true);
    expect(impact.annual).toBeCloseTo(26.52 * 12, 1);
  });

  it("are withheld when the monthly figure is not settled", () => {
    const impact = computeImpact(
      "IMP_WASTE_90",
      ctxOf(CAMPAIGN, {
        "C.spend": mv("C.spend", 79.56, { settledStrict: false, settledPractical: true }),
      }),
    );
    expect(impact.settled).toBe(false);
    expect(impact.annual).toBeNull();
    expect(impact.value).toBeCloseTo(26.52, 2);
    expect(impact.reasons.join(" ")).toMatch(/annual figure withheld/);
  });
});

// ---------------------------------------------------------------------------
describe("severity (spec §3.3)", () => {
  const MONTHLY_SPEND = 8500;

  function impactOf(value: number | null, settled = true) {
    return {
      formulaId: value == null ? ("IMP_NONE" as const) : ("IMP_WASTE_90" as const),
      value,
      currency: "USD",
      inputs: [],
      annual: null,
      settled,
      quantified: value != null,
      reasons: [],
    };
  }

  const cases: Array<{
    name: string;
    input: Parameters<typeof computeSeverity>[0];
    expected: string;
  }> = [
    {
      name: "$26.52/mo on 8,500 monthly spend = 0.31% → info, not critical",
      input: {
        impact: impactOf(26.52),
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: [
          { id: "MI01", state: "cleared" },
          { id: "AS06", state: "cleared" },
        ],
      },
      expected: "info",
    },
    {
      name: "measurement integrity is critical with every confounder cleared",
      input: {
        impact: impactOf(4272.83),
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: CLEARED,
        integrity: true,
      },
      expected: "critical",
    },
    {
      name: "impact >= 10% of monthly spend at STRONG is critical",
      input: {
        impact: impactOf(1000),
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: CLEARED,
      },
      expected: "critical",
    },
    {
      name: "the same 10% impact at MODERATE is only a warning",
      input: {
        impact: impactOf(1000),
        monthlySpend: MONTHLY_SPEND,
        confidence: "MODERATE",
        confounders: CLEARED,
      },
      expected: "warning",
    },
    {
      name: "impact >= 2% of monthly spend is a warning",
      input: {
        impact: impactOf(200),
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: CLEARED,
      },
      expected: "warning",
    },
    {
      name: "structural with no dollar claim is a warning",
      input: {
        impact: impactOf(0),
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: CLEARED,
        structural: true,
      },
      expected: "warning",
    },
    {
      name: "positive expected value is an opportunity",
      input: {
        impact: impactOf(300),
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: CLEARED,
        opportunity: true,
      },
      expected: "opportunity",
    },
    {
      name: "a healthy signal is positive",
      input: {
        impact: impactOf(null),
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: CLEARED,
        positive: true,
      },
      expected: "positive",
    },
    {
      name: "below 2% and not structural is info",
      input: {
        impact: impactOf(50),
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: CLEARED,
      },
      expected: "info",
    },
    {
      name: "no quantified impact and not structural is info",
      input: {
        impact: impactOf(null),
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: CLEARED,
      },
      expected: "info",
    },
    {
      name: "unknown monthly spend cannot make a percentage, so it is info",
      input: {
        impact: impactOf(5000),
        monthlySpend: null,
        confidence: "STRONG",
        confounders: CLEARED,
      },
      expected: "info",
    },
    {
      name: "a check may cap itself (MI02: never critical)",
      input: {
        impact: impactOf(4272.83),
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: CLEARED,
        integrity: true,
        maxSeverity: "opportunity",
      },
      expected: "opportunity",
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(computeSeverity(input).severity).toBe(expected);
  });

  it("rule: one step down per unresolved confounder, but money >= 2% of spend stops at warning", () => {
    const base = {
      impact: impactOf(1000),
      monthlySpend: MONTHLY_SPEND,
      confidence: "STRONG" as const,
    };
    expect(computeSeverity({ ...base, confounders: [], declaredConfounders: [] }).severity).toBe(
      "critical",
    );
    expect(computeSeverity({ ...base, confounders: UNKNOWN_ONE }).severity).toBe("warning");
    // two confounders used to reach info; 11.8% of monthly spend is real money
    const two = computeSeverity({
      ...base,
      confounders: [
        { id: "MI01", state: "unknown" },
        { id: "SK18", state: "unknown" },
      ],
    });
    expect(two.severity).toBe("warning");
    expect(two.withoutFloor).toBe("info");
    expect(two.reasons.join(" ")).toMatch(/kept at warning: impact 11\.76% of monthly spend/);
  });

  it("floor (a): only real spend is floored; the cost-per-sale gap keeps its downgrades (BB09)", () => {
    const two: ConfounderSummary[] = [
      { id: "MI01", state: "unknown" },
      { id: "SK18", state: "unknown" },
    ];
    const at = (formulaId: "IMP_WASTE_30" | "IMP_VALUE_GAP" | "IMP_STRUCTURAL" | "IMP_CPA_GAP") =>
      computeSeverity({
        impact: { ...impactOf(1000), formulaId },
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: two,
      }).severity;
    expect(at("IMP_WASTE_30")).toBe("warning");
    expect(at("IMP_VALUE_GAP")).toBe("warning");
    expect(at("IMP_STRUCTURAL")).toBe("warning");
    expect(at("IMP_CPA_GAP")).toBe("info");
  });

  it("floor (b): a measurement confounder that explains blocks it; another 'explains' does not", () => {
    const base = {
      impact: impactOf(1000),
      monthlySpend: MONTHLY_SPEND,
      confidence: "STRONG" as const,
    };
    for (const id of ["MI01", "MI02", "MI05", "MI07"]) {
      const r = computeSeverity({
        ...base,
        confounders: [
          { id, state: "explains" },
          { id: "SK18", state: "unknown" },
        ],
      });
      expect(r.severity).toBe("info");
      expect(r.withoutFloor).toBeUndefined();
    }
    // SK18 says "explains" whenever a promo has an end date: that must not hide real money
    const promo = computeSeverity({
      ...base,
      confounders: [
        { id: "SK18", state: "explains" },
        { id: "MI01", state: "unknown" },
      ],
    });
    expect(promo.severity).toBe("warning");
  });

  it("floor (c): at most 5 findings per check are lifted, biggest money first", () => {
    const two: ConfounderSummary[] = [
      { id: "MI01", state: "unknown" },
      { id: "SK18", state: "unknown" },
    ];
    const scored = [300, 900, 200, 800, 400, 700, 500, 600].map((v) => {
      const impact = impactOf(v);
      return {
        impact,
        severity: computeSeverity({
          impact,
          monthlySpend: MONTHLY_SPEND,
          confidence: "STRONG",
          confounders: two,
        }),
      };
    });
    expect(scored.every((s) => s.severity.severity === "warning")).toBe(true);
    applyFloorBudget(scored);
    const kept = scored.filter((s) => s.severity.severity === "warning").map((s) => s.impact.value);
    expect(kept).toHaveLength(FLOOR_LIFTS_PER_CHECK);
    expect([...kept].sort((a, b) => (b ?? 0) - (a ?? 0))).toEqual([900, 800, 700, 600, 500]);
    const dropped = scored.filter((s) => s.severity.severity !== "warning");
    expect(dropped.map((s) => s.severity.severity)).toEqual(["info", "info", "info"]);
    expect(dropped[0]?.severity.reasons.join(" ")).toMatch(/lifts only the 5 biggest/);
  });

  it("rule: below 2% of spend, every unresolved confounder still lowers one step", () => {
    // a structural warning with no money behind it has no floor
    const r = computeSeverity({
      impact: impactOf(15),
      monthlySpend: MONTHLY_SPEND,
      confidence: "STRONG",
      confounders: UNKNOWN_ONE,
      structural: true,
    });
    expect(r.base).toBe("warning");
    expect(r.severity).toBe("info");
  });

  it("rule: confounders downgrade the BASE, then the ceiling caps (live TR01a: $14.9k on $16.2k)", () => {
    // 92% of monthly spend, ceiling warning, 1 of 12 confounders unknown.
    // Old order: critical -> ceiling warning -> confounder info. New: critical -> warning -> warning.
    const r = computeSeverity({
      impact: impactOf(14900),
      monthlySpend: 16200,
      confidence: "STRONG",
      confounders: [
        { id: "SK18", state: "unknown" },
        { id: "MI01", state: "cleared" },
      ],
      maxSeverity: "warning",
    });
    expect(r.base).toBe("critical");
    expect(r.severity).toBe("warning");
    expect(r.unresolvedConfounders).toEqual(["SK18"]);
  });

  it("rule: the money floor never lifts a finding above its own ceiling", () => {
    const r = computeSeverity({
      impact: impactOf(1000),
      monthlySpend: MONTHLY_SPEND,
      confidence: "STRONG",
      confounders: UNKNOWN_ONE,
      maxSeverity: "info",
    });
    expect(r.severity).toBe("info");
  });

  it("rule: the money floor applies to losses only — an opportunity is never lifted to warning", () => {
    const r = computeSeverity({
      impact: impactOf(1000),
      monthlySpend: MONTHLY_SPEND,
      confidence: "STRONG",
      confounders: UNKNOWN_ONE,
      opportunity: true,
    });
    expect(r.base).toBe("opportunity");
    expect(r.severity).toBe("info");
  });

  it("rule: a big priced loss ranks above a small structural one under the same confounder", () => {
    const confounders = UNKNOWN_ONE;
    const promo = computeSeverity({
      impact: impactOf(0),
      monthlySpend: 16200,
      confidence: "STRONG",
      confounders: [],
      structural: true,
      declaredConfounders: [],
    });
    const decline = computeSeverity({
      impact: impactOf(14900),
      monthlySpend: 16200,
      confidence: "STRONG",
      confounders,
      maxSeverity: "warning",
    });
    expect(promo.severity).toBe("warning");
    expect(decline.severity).toBe("warning");
  });

  it("NEVER returns critical with an unresolved confounder", () => {
    const states: ConfounderSummary["state"][] = ["unknown", "explains"];
    for (const state of states) {
      const r = computeSeverity({
        impact: impactOf(9000),
        monthlySpend: MONTHLY_SPEND,
        confidence: "STRONG",
        confounders: [{ id: "MI01", state }],
        integrity: true,
      });
      expect(r.base).toBe("critical");
      expect(r.severity).not.toBe("critical");
      expect(r.unresolvedConfounders).toEqual(["MI01"]);
    }
  });

  it("reports the percentage it judged by", () => {
    const r = computeSeverity({
      impact: impactOf(26.52),
      monthlySpend: MONTHLY_SPEND,
      confidence: "STRONG",
      confounders: CLEARED,
    });
    expect(r.impactPctOfMonthlySpend).toBeCloseTo(0.31, 2);
    expect(r.reasons.join(" ")).toMatch(/0\.31% of monthly spend is below the 2% bar/);
  });
});

// ---------------------------------------------------------------------------
// Phase F: the a live shop / its NL shop re-check of 2 Nov 2026, as fixtures. Same money
// sizes and the same confounder states the live run recorded.
// ---------------------------------------------------------------------------

describe("severity — live re-check 2 Nov (Phase F)", () => {
  // a live shop: $50,866.22 in the 90-day window
  const AH_MONTHLY = 50866.22 / 3;
  const JACKETS = "1111111111";
  const BRAND = "2222222222";
  const RT = "3333333333";
  const valueGap = (value: number) => ({
    formulaId: "IMP_VALUE_GAP" as const,
    value,
    kind: "at_risk" as const,
    currency: "USD",
    inputs: [],
    annual: null,
    settled: false,
    quantified: true,
    reasons: [],
  });
  // TR01's confounders on a PMax campaign finding, as recorded (MI01 aside)
  const tr01Rest = (sk18: ConfounderSummary["state"]): ConfounderSummary[] => [
    { id: "TR01:MI04", state: "cleared" },
    { id: "TR01:MI05", state: "cleared" },
    { id: "TR01:MI07", state: "cleared" },
    { id: "TR01:MI08", state: "cleared" },
    { id: "TR01:TR02", state: "unknown" },
    { id: "TR01:TR03", state: "unknown" },
    { id: "TR01:TR04", state: "unknown" },
    { id: "TR01:SH08", state: "cleared" },
    { id: "TR01:SK18", state: sk18 },
    { id: "TR01:AS06", state: "cleared" },
    { id: "TR01:BB05", state: "cleared" },
  ];
  const tr01 = (
    value: number,
    campaign: string,
    mi01: ConfounderSummary,
    sk18: ConfounderSummary["state"],
  ) =>
    computeSeverity({
      impact: valueGap(value),
      monthlySpend: AH_MONTHLY,
      confidence: "MODERATE",
      confounders: [mi01, ...tr01Rest(sk18)],
      maxSeverity: "warning",
      campaignIds: [campaign],
    });

  it("the live trace: an account-wide MI01 'explains' kept $605 and $507 a month at info", () => {
    const mi01: ConfounderSummary = { id: "TR01:MI01", state: "explains" };
    const jackets = tr01(605.5, JACKETS, mi01, "unknown");
    expect(jackets.base).toBe("warning");
    expect(jackets.impactPctOfMonthlySpend).toBeCloseTo(3.57, 2);
    expect(jackets.severity).toBe("info");
    expect(tr01(507.25, BRAND, mi01, "explains").severity).toBe("info");
  });

  it("with MI01 cleared, both declines rank by their money: warning", () => {
    const mi01: ConfounderSummary = { id: "TR01:MI01", state: "cleared" };
    const jackets = tr01(605.5, JACKETS, mi01, "unknown");
    const brand = tr01(507.25, BRAND, mi01, "explains");
    expect(jackets.severity).toBe("warning");
    expect(jackets.withoutFloor).toBe("info");
    // SK18 "explains" (a promo end date) never blocks the floor
    expect(brand.severity).toBe("warning");
  });

  it("a measurement confounder about other campaigns does not block the floor", () => {
    const elsewhere: ConfounderSummary = {
      id: "TR01:MI01",
      state: "explains",
      campaignIds: [RT],
    };
    expect(tr01(605.5, JACKETS, elsewhere, "unknown").severity).toBe("warning");
    // the same confounder on the finding's own campaign still blocks it
    const here: ConfounderSummary = { ...elsewhere, campaignIds: [JACKETS] };
    expect(tr01(605.5, JACKETS, here, "unknown").severity).toBe("info");
  });

  it("a measurement confounder never blocks money that does not rest on conversions", () => {
    // priced structural spend at risk ($400/mo, 2.4%): tracking cannot make it wrong
    const r = computeSeverity({
      impact: { ...valueGap(400), formulaId: "IMP_STRUCTURAL" },
      monthlySpend: AH_MONTHLY,
      confidence: "MODERATE",
      confounders: [
        { id: "SK15:MI01", state: "explains" },
        { id: "SK15:SK02", state: "unknown" },
      ],
      maxSeverity: "warning",
      campaignIds: [BRAND],
    });
    expect(r.severity).toBe("warning");
    // and an explicit override says the same for a conversion-free check
    const forced = computeSeverity({
      impact: valueGap(605.5),
      monthlySpend: AH_MONTHLY,
      confidence: "MODERATE",
      confounders: [{ id: "TR01:MI01", state: "explains" }],
      maxSeverity: "warning",
      dependsOnConversions: false,
    });
    expect(forced.severity).toBe("warning");
  });

  it("an account-wide MI01 'explains' blocks the floor for a campaign launched after the tag went quiet", () => {
    // the resolver no longer narrows MI01 to the campaigns the action counted for: a new
    // campaign has no conversions to name, and its decline still rests on a silent tag
    const mi01: ConfounderSummary = { id: "TR01:MI01", state: "explains" };
    expect(tr01(605.5, "9999999999", mi01, "unknown").severity).toBe("info");
  });

  // NL: $904.93 in the window; the money floor there is the account CPA, 150.82
  const NL_MONTHLY = 904.93 / 3;
  const noMoney = (checkId: string, campaignMonthly: number, structural = true) =>
    computeSeverity({
      impact: { ...valueGap(0), formulaId: "IMP_STRUCTURAL", quantified: false },
      monthlySpend: NL_MONTHLY,
      confidence: "STRONG",
      confounders: [{ id: `${checkId}:SK15`, state: "cleared" }],
      structural,
      maxSeverity: "warning",
      checkId,
      scopeSpend: { campaignMonthly, accountMonthly: NL_MONTHLY, floor: 150.82 },
    });

  it("NL shop: SK11 on the brand campaigns ($24.97 over 17 spend days, $20.09 over 12) is a note", () => {
    for (const [spend, days] of [
      [24.97, 17],
      [20.09, 12],
    ] as const) {
      const r = noMoney("SK11", (spend / days) * DAYS_PER_MONTH);
      expect(r.base).toBe("warning");
      expect(r.severity).toBe("info");
      expect(r.reasons.join(" ")).toMatch(/capped at info: the campaign spends/);
    }
    // a campaign above the bar keeps its warning
    expect(noMoney("SK11", 400).severity).toBe("warning");
  });

  it("a campaign launched last week is judged on its pace, not its 90-day total", () => {
    // $140 in its first 7 days = $600 a month: over the $150.82 floor, keeps the warning
    expect(noMoney("SK11", (140 / 7) * DAYS_PER_MONTH).severity).toBe("warning");
  });

  it("the cap never touches integrity, policy, delivery or goal checks", () => {
    for (const id of ["SK15", "BB04", "MI07", "SK26", "PX17", "SL11"]) {
      expect(TINY_SPEND_CHECKS.has(id)).toBe(false);
      const r = noMoney(id, 5);
      expect(r.severity, id).toBe("warning");
      expect(r.reasons.join(" "), id).not.toMatch(/capped at info/);
    }
    // and a hygiene check with no check id named is never capped
    const unnamed = computeSeverity({
      impact: { ...valueGap(0), formulaId: "IMP_STRUCTURAL", quantified: false },
      monthlySpend: NL_MONTHLY,
      confidence: "STRONG",
      confounders: [],
      declaredConfounders: [],
      structural: true,
      maxSeverity: "warning",
      scopeSpend: { campaignMonthly: 5, accountMonthly: NL_MONTHLY, floor: 150.82 },
    });
    expect(unnamed.severity).toBe("warning");
  });

  it("the tiny-spend cap leaves money findings and normal-size campaigns alone", () => {
    // a live shop Brand: ~$900 a month, far over 0.5% of $16,955
    const brand = computeSeverity({
      impact: { ...valueGap(0), formulaId: "IMP_STRUCTURAL", quantified: false },
      monthlySpend: AH_MONTHLY,
      confidence: "STRONG",
      confounders: [],
      declaredConfounders: [],
      structural: true,
      maxSeverity: "warning",
      checkId: "SK11",
      scopeSpend: { campaignMonthly: 900, accountMonthly: AH_MONTHLY, floor: 50 },
    });
    expect(brand.severity).toBe("warning");
    // priced money on a small campaign is judged by its money, not capped
    const priced = computeSeverity({
      impact: { ...valueGap(400), formulaId: "IMP_STRUCTURAL" },
      monthlySpend: AH_MONTHLY,
      confidence: "STRONG",
      confounders: [],
      declaredConfounders: [],
      maxSeverity: "warning",
      checkId: "SK11",
      scopeSpend: { campaignMonthly: 13, accountMonthly: AH_MONTHLY, floor: 50 },
    });
    expect(priced.severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
describe("confidence", () => {
  const CLEAN_SAMPLE = { truncated: false, population: "real" as const };

  it("is STRONG only when everything holds", () => {
    const r = computeConfidence({
      inputs: [mv("C.spend", 79.56)],
      sample: CLEAN_SAMPLE,
      floors: [{ metric: "C.clicks", required: 25, actual: 146, met: true }],
      confounders: CLEARED,
    });
    expect(r.level).toBe("STRONG");
    expect(r.openItems).toEqual([]);
  });

  it("drops to MODERATE on an unsettled input and names it", () => {
    const r = computeConfidence({
      inputs: [mv("C.spend", 79.56, { settledStrict: false, settledPractical: true })],
      sample: CLEAN_SAMPLE,
      confounders: CLEARED,
    });
    expect(r.level).toBe("MODERATE");
    expect(r.openItems.join(" ")).toMatch(/C\.spend is settled only by the practical rule/);
  });

  it("drops to MODERATE on a truncated sample", () => {
    const r = computeConfidence({
      inputs: [mv("T.spend", 400)],
      sample: { truncated: true, population: "real", cap: 500, rowsSeen: 500 },
      confounders: CLEARED,
    });
    expect(r.level).toBe("MODERATE");
    expect(r.openItems.join(" ")).toMatch(/capped fetch/);
  });

  it("drops to MODERATE when the population is orphan-only or unknown", () => {
    for (const population of ["orphan_only", "unknown"] as const) {
      const r = computeConfidence({
        inputs: [mv("C.spend", 1)],
        sample: { truncated: false, population },
        confounders: CLEARED,
      });
      expect(r.level).toBe("MODERATE");
      expect(r.openItems).toHaveLength(1);
    }
  });

  it("drops to MODERATE when a sample floor is not met", () => {
    const r = computeConfidence({
      inputs: [mv("C.conv", 2)],
      sample: CLEAN_SAMPLE,
      floors: [{ metric: "C.conv", required: 3, actual: 2, met: false }],
      confounders: CLEARED,
    });
    expect(r.level).toBe("MODERATE");
    expect(r.openItems.join(" ")).toMatch(/sample floor not met: C\.conv 2 < 3/);
  });

  it("drops to MODERATE on an unresolved confounder", () => {
    const r = computeConfidence({
      inputs: [mv("C.spend", 1)],
      sample: CLEAN_SAMPLE,
      confounders: UNKNOWN_ONE,
    });
    expect(r.level).toBe("MODERATE");
    expect(r.openItems.join(" ")).toMatch(/confounder MI01 is unknown/);
  });

  it("names a NotComputable input as the open item", () => {
    const r = computeConfidence({
      inputs: [
        { id: "K.match_type", notComputable: true, reason: "keyword_criterion_id not synced" },
      ],
      sample: CLEAN_SAMPLE,
      confounders: CLEARED,
    });
    expect(r.level).toBe("MODERATE");
    expect(r.openItems.join(" ")).toMatch(
      /K\.match_type not computable: keyword_criterion_id not synced/,
    );
  });

  it("honours a check that caps itself at MODERATE (SK01)", () => {
    const r = computeConfidence({
      inputs: [mv("K.spend", 60)],
      sample: CLEAN_SAMPLE,
      confounders: CLEARED,
      capAtModerate: true,
    });
    expect(r.level).toBe("MODERATE");
    expect(r.openItems.join(" ")).toMatch(/capped at MODERATE by construction/);
  });

  it("reserves HYPOTHESIS for the model pass", () => {
    const engine = computeConfidence({
      inputs: [],
      sample: { truncated: true, population: "unknown" },
      confounders: UNKNOWN_ONE,
    });
    expect(engine.level).toBe("MODERATE");
    const model = computeConfidence({ inputs: [], sample: CLEAN_SAMPLE, fromModelPass: true });
    expect(model.level).toBe("HYPOTHESIS");
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// B4 — deprecated and impossible products (inventory rules 21, 110, 112, 256)

// ---------------------------------------------------------------------------
describe("severity fails closed on missing confounder evidence", () => {
  const big = {
    formulaId: "IMP_WASTE_90" as const,
    value: 4000,
    currency: "USD",
    inputs: [],
    annual: null,
    settled: true,
    quantified: true,
    reasons: [],
  };

  it("cannot be critical when no confounder was evaluated", () => {
    const r = computeSeverity({
      impact: big,
      monthlySpend: 8500,
      confidence: "STRONG",
      confounders: [],
    });
    expect(r.base).toBe("critical");
    expect(r.severity).toBe("warning");
    expect(r.reasons.join(" ")).toMatch(/no confounder was evaluated/);
  });

  it("stays critical when the check proves it declares none", () => {
    const r = computeSeverity({
      impact: big,
      monthlySpend: 8500,
      confidence: "STRONG",
      confounders: [],
      declaredConfounders: [],
    });
    expect(r.severity).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
describe("confidence reads each input's own sample state (review should-fix 1)", () => {
  const CLEAN = { truncated: false, population: "real" as const };

  it("blocks STRONG on a truncated input even when the candidate sample looks clean", () => {
    const r = computeConfidence({
      inputs: [mv("T.spend", 400, { truncated: true })],
      sample: CLEAN,
      confounders: CLEARED,
    });
    expect(r.level).toBe("MODERATE");
    expect(r.openItems.join(" ")).toMatch(/T\.spend came from a capped fetch/);
  });

  it("blocks STRONG on an orphan-only input and on an unmet input floor", () => {
    const r = computeConfidence({
      inputs: [
        mv("C.spend", 1, {
          population: "orphan_only",
          floors: [{ metric: "C.clicks", required: 25, actual: 7, met: false }],
        }),
      ],
      sample: CLEAN,
      confounders: CLEARED,
    });
    expect(r.level).toBe("MODERATE");
    expect(r.openItems).toHaveLength(2);
    expect(r.openItems.join(" ")).toMatch(/join no node of this audit/);
    expect(r.openItems.join(" ")).toMatch(/sample floor not met: C\.clicks 7 < 25/);
  });
});

// ---------------------------------------------------------------------------
describe("sample adapter — the enum wins", () => {
  it("turns the check layer's row count into a state and keeps the number", () => {
    expect(toSampleSummary({ population: 131, truncated: false })).toEqual({
      truncated: false,
      population: "real",
      populationRows: 131,
    });
    expect(toSampleSummary({ population: 0 })).toEqual({
      truncated: false,
      population: "unknown",
      populationRows: 0,
    });
    expect(
      toSampleSummary({ population: "orphan_only", cap: 500, rowsSeen: 500, truncated: true }),
    ).toEqual({
      truncated: true,
      population: "orphan_only",
      rowsSeen: 500,
      cap: 500,
    });
    expect(toSampleSummary({}).population).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Round 4 R14: money counted once
// ---------------------------------------------------------------------------

describe("countMoneyOnce (R14)", () => {
  /** Only the fields countMoneyOnce reads; the rest of a candidate plays no part. */
  const priced = (
    checkId: string,
    value: number | null,
    scope: Partial<Candidate["scope"]>,
    kind: "waste" | "at_risk" | "gain" = "at_risk",
    formulaId = "IMP_WASTE_90",
    facts: Record<string, unknown> = {},
  ): Candidate =>
    ({
      checkId,
      scope: { type: "campaign", id: null, name: null, ...scope },
      impact: {
        quantified: value != null,
        value,
        kind: value != null ? kind : undefined,
        formulaId,
        inputs: [],
      },
      facts: { ...facts },
    }) as unknown as Candidate;
  /** a finding priced on a roll-up of rows: a slice of the campaign, never the whole */
  const slice = (checkId: string, value: number, campaignId: string): Candidate =>
    priced(checkId, value, { id: campaignId }, "waste", "IMP_WASTE_90", {
      rollup_wasted_cost_90d: value * 3,
    });

  it("two findings on one campaign: both marked, the total counts the campaign once", () => {
    // a brand campaign of $967 a month: a falling return ($507) and dear brand clicks ($318)
    const trend = priced("TR01", 507.25, { id: "8" }, "at_risk", "IMP_VALUE_GAP");
    const clicks = priced("BB15", 317.93, { id: "8" });
    const other = priced("PX05", 36.9, { type: "product", id: "p1", campaignId: "9" });
    const m = countMoneyOnce(
      [trend, clicks, other],
      new Map([
        ["8", 967],
        ["9", 2955],
      ]),
      "USD",
    );
    expect(m.monthly).toBeCloseTo(862.08, 2);
    expect(m.monthlyCountedOnce).toBeCloseTo(544.15, 2);
    expect(m.overlapping).toBe(2);
    expect(clicks.facts.overlaps_with).toEqual(["TR01"]);
    expect(clicks.facts.counted_once_monthly).toBe(0);
    expect(clicks.facts.shared_money_monthly).toBeCloseTo(317.93, 2);
    expect(trend.facts.overlaps_with).toEqual(["BB15"]);
    expect(trend.facts.counted_once_monthly).toBeCloseTo(507.25, 2);
    expect(other.facts.overlaps_with).toBeUndefined();
    // the findings' own money is left as priced
    expect(clicks.impact.value).toBeCloseTo(317.93, 2);
  });
  it("one campaign's counted money never passes its monthly spend", () => {
    const a = slice("SK07", 300, "8");
    const b = priced("PX05", 150, { type: "product", id: "p1", campaignId: "8" });
    const c = priced("PX05", 100, { type: "product", id: "p2", campaignId: "8" });
    const m = countMoneyOnce([a, b, c], new Map([["8", 400]]), "USD");
    expect(m.monthly).toBe(550);
    expect(m.monthlyCountedOnce).toBe(400);
    // the smallest gives way first
    expect(c.facts.counted_once_monthly).toBe(0);
    expect(b.facts.counted_once_monthly).toBe(100);
    expect(a.facts.overlaps_with).toBeUndefined();
  });
  it("two sliced findings on one campaign are both counted, up to the campaign's spend", () => {
    const terms = slice("SK07", 200, "8");
    const audience = slice("SL11", 150, "8");
    const m = countMoneyOnce([terms, audience], new Map([["8", 1000]]), "USD");
    expect(m.monthlyCountedOnce).toBe(350);
    expect(m.overlapping).toBe(0);
    expect(terms.facts.overlaps_with).toBeUndefined();
    expect(audience.facts.overlaps_with).toBeUndefined();
    // past the campaign's spend the step-2 cap applies, never a merge
    const capped = countMoneyOnce(
      [slice("SK07", 200, "8"), slice("SL11", 150, "8")],
      new Map([["8", 300]]),
      "USD",
    );
    expect(capped.monthlyCountedOnce).toBe(300);
  });
  it("a finding that prices the whole campaign counts the products inside it once", () => {
    // a PMax campaign whose fall in return is priced (TR01), and products in it (PX05)
    const trend = priced("TR01", 605.5, { id: "9" }, "at_risk", "IMP_VALUE_GAP");
    const p1 = priced("PX05", 36.9, { type: "product", id: "p1", campaignId: "9" });
    const p2 = priced("PX05", 34.78, { type: "product", id: "p2", campaignId: "9" });
    const elsewhere = priced("PX05", 20, { type: "product", id: "p3", campaignId: "7" });
    const terms = slice("SK07", 50, "9");
    const m = countMoneyOnce([trend, p1, p2, elsewhere, terms], new Map([["9", 2955]]), "USD");
    expect(m.monthlyCountedOnce).toBeCloseTo(625.5, 2);
    expect(p1.facts.counted_once_monthly).toBe(0);
    expect(p1.facts.overlaps_with).toEqual(["TR01"]);
    expect(terms.facts.counted_once_monthly).toBe(0);
    expect(String(trend.facts.overlap_note)).toMatch(
      /^TR01 prices this whole campaign; SK07 prices money inside it/,
    );
    expect(String(trend.facts.overlap_note)).toContain("PX05 prices 36.9 a month of product money");
    expect(String(p1.facts.overlap_note)).toMatch(/counts it once, under TR01$/);
    expect(elsewhere.facts.overlaps_with).toBeUndefined();
  });
  it("product money counted under a whole-campaign finding never passes that finding's money", () => {
    // TR01 prices $40 a month; SH20 prices $100 a month of product spend inside the campaign
    const trend = priced("TR01", 40, { id: "9" }, "at_risk", "IMP_VALUE_GAP");
    const clicks = priced("SH20", 100, { type: "product", id: null }, "waste", "IMP_WASTE_90", {
      rollup_wasted_cost_90d: 300,
    });
    clicks.rows = [{ entity: { id: "shopify_us_1_11", name: "a" }, cells: { spend: 300 } }];
    const productSpend = new Map([
      ["9", { byVariant: new Map([["11", 300]]), byParent: new Map<string, number>() }],
    ]);
    const m = countMoneyOnce([trend, clicks], new Map([["9", 2955]]), "USD", productSpend);
    expect(m.monthlyCountedOnce).toBeGreaterThanOrEqual(100);
    expect(m.monthlyCountedOnce).toBeCloseTo(100, 2);
    expect(clicks.facts.counted_once_monthly).toBeCloseTo(60, 2);
    expect(clicks.facts.shared_money_monthly).toBeCloseTo(40, 2);
    expect(String(clicks.facts.overlap_note)).toMatch(
      /under TR01; the other 60 a month is counted here/,
    );
  });
  it("PX05 and SH20 inside one campaign share the whole-campaign finding's money, no more", () => {
    // TR01 $30, PX05 $36.90 and SH20 $100 in the same campaign: TR01 can hold $30 of it
    const trend = priced("TR01", 30, { id: "9" }, "at_risk", "IMP_VALUE_GAP");
    const px = priced("PX05", 36.9, { type: "product", id: "p1", campaignId: "9" });
    const clicks = priced("SH20", 100, { type: "product", id: null }, "waste", "IMP_WASTE_90", {
      rollup_wasted_cost_90d: 300,
    });
    clicks.rows = [{ entity: { id: "shopify_us_1_11", name: "a" }, cells: { spend: 300 } }];
    const productSpend = new Map([
      ["9", { byVariant: new Map([["11", 300]]), byParent: new Map<string, number>() }],
    ]);
    const m = countMoneyOnce([trend, px, clicks], new Map([["9", 2955]]), "USD", productSpend);
    expect(m.monthlyCountedOnce).toBeGreaterThanOrEqual(136.9);
    expect(m.monthlyCountedOnce).toBeCloseTo(136.9, 2);
    expect(trend.facts.counted_once_monthly).toBeCloseTo(30, 2);
    expect(px.facts.counted_once_monthly).toBeCloseTo(6.9, 2);
    expect(String(px.facts.overlap_note)).toContain("under TR01");
    expect(clicks.facts.overlaps_with).toBeUndefined();
  });
  it("product money is not counted under a whole-campaign finding that is not the top one", () => {
    // TR01 ($20) prices the campaign whole, but a bigger finding on it (SK07, $80) is the top
    const small = priced("TR01", 20, { id: "9" }, "at_risk", "IMP_VALUE_GAP");
    const big = slice("SK07", 80, "9");
    const px = priced("PX05", 15, { type: "product", id: "p1", campaignId: "9" });
    const m = countMoneyOnce([small, big, px], new Map([["9", 2955]]), "USD");
    // SK07 is the top: TR01 counted under it, the product stays counted
    expect(small.facts.counted_once_monthly).toBe(0);
    expect(px.facts.overlaps_with).toBeUndefined();
    expect(m.monthlyCountedOnce).toBeCloseTo(95, 2);
  });
  it("a campaign priced on its own spend (C.spend) is a whole-campaign finding", () => {
    const whole = priced("SK13", 400, { id: "8" }, "waste");
    (whole.impact as { inputs: Array<{ metric: string }> }).inputs = [{ metric: "C.spend" }];
    expect(pricesWholeCampaign(whole)).toBe(true);
    expect(pricesWholeCampaign(slice("SK07", 100, "8"))).toBe(false);
    expect(pricesWholeCampaign(priced("TR06", 100, { id: "8" }, "waste"))).toBe(true);
  });
  it("a kept SK20 page counts only the money the product checks do not price", () => {
    // A product page: SH20 prices $95.93 of its 90-day spend; the page prices $161.13 a month
    const page = priced(
      "SK20",
      161.13,
      { type: "landing_page", id: "lp1" },
      "waste",
      "IMP_WASTE_90",
      {
        overlaps_with: ["SH20"],
        product_spend_priced_elsewhere_90d: 95.93,
        overlap_note: "SH20 prices 95.93 of this page's 483.38 spend over 90 days",
      },
    );
    const plain = priced("SK20", 40, { type: "landing_page", id: "lp2" }, "waste");
    const m = countMoneyOnce([page, plain], new Map(), "USD");
    expect(m.monthly).toBeCloseTo(201.13, 2);
    expect(m.monthlyCountedOnce).toBeCloseTo(201.13 - 95.93 / 3, 2);
    expect(page.facts.counted_once_monthly).toBeCloseTo(161.13 - 95.93 / 3, 2);
    expect(page.facts.shared_money_monthly).toBeCloseTo(95.93 / 3, 2);
    expect(page.facts.overlaps_with).toEqual(["SH20"]);
    expect(String(page.facts.overlap_note)).toMatch(/^SH20 prices 95.93/);
    expect(plain.facts.counted_once_monthly).toBeUndefined();
    // product spend past the page's money never counts below 0
    const small = priced("SK20", 10, { type: "landing_page", id: "lp3" }, "waste", "IMP_WASTE_90", {
      product_spend_priced_elsewhere_90d: 90,
    });
    expect(countMoneyOnce([small], new Map(), "USD").monthlyCountedOnce).toBe(0);
    expect(small.facts.counted_once_monthly).toBe(0);
  });
  it("account-wide product money spent inside a campaign priced as a whole is counted once", () => {
    const trend = priced("TR01", 605.5, { id: "9" }, "at_risk", "IMP_VALUE_GAP");
    const clicks = priced("SH20", 131.97, { type: "product", id: null }, "waste", "IMP_WASTE_90", {
      rollup_wasted_cost_90d: 395.92,
    });
    const row = (id: string, spend: number, pricedHere = true) => ({
      entity: { id, name: id },
      cells: { spend, priced_here: pricedHere },
    });
    clicks.rows = [
      row("shopify_us_1_11", 162.63),
      row("shopify_us_1_12", 137.36),
      row("shopify_us_2_21", 95.93),
      // priced by a product waste check, not by this finding: never taken off it
      row("shopify_us_3_31", 50, false),
    ];
    const product = priced(
      "SH04",
      40,
      { type: "product", id: "shopify_us_4_41" },
      "waste",
      "IMP_WASTE_90",
      {
        "Pr.spend": 120,
      },
    );
    const productSpend = new Map([
      [
        "9",
        {
          byVariant: new Map([
            ["11", 162.63],
            ["12", 137.36],
            ["31", 50],
          ]),
          byParent: new Map([["shopify:4", 90]]),
        },
      ],
      // a campaign no finding prices as a whole: its product money stays counted
      ["7", { byVariant: new Map([["21", 95.93]]), byParent: new Map<string, number>() }],
    ]);
    const m = countMoneyOnce([trend, clicks, product], new Map([["9", 2955]]), "USD", productSpend);
    expect(clicks.facts.counted_once_monthly).toBeCloseTo(131.97 - (162.63 + 137.36) / 3, 2);
    expect(clicks.facts.overlaps_with).toEqual(["TR01"]);
    expect(product.facts.counted_once_monthly).toBeCloseTo(10, 2);
    expect(trend.facts.overlaps_with).toEqual(["SH04", "SH20"]);
    expect(trend.facts.counted_once_monthly).toBeCloseTo(605.5, 2);
    expect(m.monthlyCountedOnce).toBeCloseTo(605.5 + 131.97 - (162.63 + 137.36) / 3 + 10, 2);
    expect(m.overlapping).toBe(3);
    // the findings' own money is left as priced
    expect(clicks.impact.value).toBeCloseTo(131.97, 2);
  });
  it("upside is never added to spend, and unpriced findings count nothing", () => {
    const m = countMoneyOnce(
      [priced("BB07", 900, { id: "8" }, "gain"), priced("AS04", null, { type: "account" })],
      new Map(),
      "USD",
    );
    expect(m).toEqual({
      currency: "USD",
      findings: 0,
      monthly: 0,
      monthlyCountedOnce: 0,
      overlapping: 0,
    });
  });
});
