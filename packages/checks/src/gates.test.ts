// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The gate chain every check runs behind: business type, spend tier, activity,
 * brand, learning age, volume floor and the owner's constraints. Each gate gets
 * a case where it lets the finding through, one where it acts, and one where
 * it cannot judge (and must leave the finding alone or say "not checkable",
 * never "clean").
 */
import { describe, expect, it } from "vitest";
import { runChecks } from "./api.js";
import { applySpendTierGate } from "./engine/checks/spendTierGate.js";
import { applyVolumeFloorGate, type VolumeFloorRule } from "./engine/checks/volumeFloorGate.js";
import type { CheckFinding, CheckResult } from "./engine/checks/types.js";
import {
  adGroup,
  buildInput,
  checkCtxOf,
  keyword,
  runOne,
  type CampaignSpec,
} from "./testing/account.js";

const findingsOf = (r: CheckResult) => (r.state === "fires" ? r.findings : []);

function fakeFinding(scope: CheckFinding["scope"]): CheckFinding {
  return {
    claimKey: "test.claim",
    scope,
    evidence: [],
    facts: {},
    sample: { truncated: false, population: 1 },
    settled: { strict: true, practical: true },
    markerState: "ok",
  };
}
const fires = (scope: CheckFinding["scope"]): CheckResult => ({
  state: "fires",
  findings: [fakeFinding(scope)],
});

const ready: Partial<CampaignSpec> = { strategy: "MAXIMIZE_CONVERSION_VALUE", conv: 2 };

describe("business type gate", () => {
  it("lets an e-commerce check run on an e-commerce account", () => {
    expect(
      runOne("BB14", buildInput({ campaigns: [{ id: "11", strategy: "MAXIMIZE_CONVERSIONS" }] }))
        .state,
    ).toBe("fires");
  });
  it("stops it on a lead-gen account, with the reason", () => {
    const r = runOne(
      "BB14",
      buildInput({
        campaigns: [{ id: "11", strategy: "MAXIMIZE_CONVERSIONS" }],
        profile: { businessType: "lead_gen" },
      }),
    );
    expect(r.state).toBe("not_checkable");
    expect(r.state === "not_checkable" && r.reason).toMatch(/not e-commerce/);
  });
  it("abstains when the type is unknown, never assuming e-commerce", () => {
    const r = runOne(
      "BB06",
      buildInput({ campaigns: [{ id: "11", ...ready }], profile: {}, businessType: "unknown" }),
    );
    expect(r.state).toBe("not_checkable");
  });
});

describe("activity gate", () => {
  it("passes a finding on a live campaign", () => {
    expect(
      findingsOf(runOne("BB06", buildInput({ campaigns: [{ id: "11", ...ready }] }))),
    ).toHaveLength(1);
  });
  it("drops a finding on a paused campaign and the run reports it suppressed, never clean", () => {
    const input = buildInput({
      campaigns: [
        { id: "11", ...ready, status: "PAUSED" },
        { id: "12", conv: 0.5 },
      ],
    });
    expect(findingsOf(runOne("BB06", input))).toHaveLength(0);
    const outcome = runChecks(input).checks.find((c) => c.id === "BB06");
    expect(outcome?.status).toBe("suppressed");
  });
});

describe("brand gate", () => {
  it("never makes a bidding-promotion finding on a brand campaign", () => {
    expect(
      findingsOf(
        runOne("BB06", buildInput({ campaigns: [{ id: "11", name: "Brand search", ...ready }] })),
      ),
    ).toHaveLength(0);
  });
  const kw = keyword({
    id: "31",
    campaignId: "11",
    adGroupId: "21",
    text: "acme outdoor boots",
    cost: 200,
    clicks: 100,
    conv: 0,
  });
  const kwInput = (brandTerms?: string[]) =>
    buildInput({
      campaigns: [{ id: "11", name: "Generic search" }],
      data: { adGroups: [adGroup({ id: "21", campaignId: "11" })], keywords: [kw] },
      profile: { businessType: "ecommerce", ...(brandTerms ? { brandTerms } : {}) },
    });
  it("names a wasting keyword when no brand terms are known", () => {
    expect(findingsOf(runOne("SK01", kwInput()))).toHaveLength(1);
  });
  it("never names a keyword holding the brand as waste", () => {
    const r = runOne("SK01", kwInput(["Acme Outdoor"]));
    expect(r.state).toBe("fires");
    expect(findingsOf(r)).toHaveLength(0);
  });
});

describe("learning-age gate", () => {
  it("holds a verdict on a campaign younger than the learning age, citing its age", () => {
    const input = buildInput({ campaigns: [{ id: "11", ...ready, conv: 6, days: 9 }] });
    const r = runOne("BB06", input);
    expect(r.state).toBe("fires");
    expect(findingsOf(r)).toHaveLength(0);
    expect(r.state === "fires" && r.withheld?.join(" ")).toMatch(/still learning.*9 days ago/);
    const outcome = runChecks(input).checks.find((c) => c.id === "BB06");
    expect(outcome?.status).toBe("suppressed");
    expect(outcome?.reason).toMatch(
      /1 finding\(s\) held back because the campaign is still learning/,
    );
  });
  it("lets a campaign past the learning age through", () => {
    expect(
      runOne("BB06", buildInput({ campaigns: [{ id: "11", ...ready, conv: 2, days: 40 }] })).state,
    ).toBe("fires");
  });
});

describe("spend tier gate", () => {
  const run = (cost: number, currencyCode: string | null = "USD") =>
    applySpendTierGate(
      "SK07",
      checkCtxOf(buildInput({ campaigns: [{ id: "11", cost }], currencyCode })),
      () => fires({ type: "campaign", id: "11", name: "Generic campaign 11" }),
      // no shipped check is tier-gated; the gate is tested with its own rule
      { SK07: { minTier: "B", rules: "test", why: "a brand split is not worth it at this spend" } },
    );
  it("says not applicable on an account below the tier", () => {
    const r = run(10);
    expect(r.state).toBe("not_checkable");
    expect(r.state === "not_checkable" && r.category).toBe("not_applicable");
  });
  it("runs the check on a larger account", () => {
    expect(run(1000).state).toBe("fires");
  });
  it("runs the check when the size cannot be measured (unknown currency), never suppressing on a guess", () => {
    expect(run(10, "XXX").state).toBe("fires");
  });
});

describe("volume floor gate", () => {
  const input = (impressions: number) =>
    buildInput({
      campaigns: [{ id: "11" }],
      data: {
        adGroups: [adGroup({ id: "21", campaignId: "11" })],
        ads: [
          {
            ad_id: "41",
            ad_group_id: "21",
            campaign_id: "11",
            type: "RESPONSIVE_SEARCH_AD",
            status: "ENABLED",
            impressions,
            clicks: 1,
            cost: 1,
          },
        ],
        assetPerformance: [
          {
            ad_resource: "customers/1/adGroupAds/21~41",
            asset_id: "51",
            field_type: "HEADLINE",
            performance_label: "LOW",
            asset_text: "Free delivery",
          },
        ],
      },
    });
  // no shipped check is volume-gated; the gate is tested with its own rule
  const RULES: Readonly<Record<string, VolumeFloorRule>> = {
    SK14: {
      rules: "test",
      metric: "D.impressions",
      scope: "ad_of_asset" as const,
      floor: 100,
      unit: "impressions" as const,
      why: "too little traffic to rate one headline",
    },
  };
  const assetScope = {
    type: "asset" as const,
    id: "41:51",
    name: "Free delivery",
    campaignId: "11",
  };
  it("holds a rating claim on an asset with too few impressions", () => {
    const r = applyVolumeFloorGate("SK14", checkCtxOf(input(50)), fires(assetScope), RULES);
    expect(r.state).toBe("fires");
    expect(findingsOf(r)).toHaveLength(0);
    expect(r.state === "fires" && r.withheld?.join(" ")).toMatch(/50 impressions, under the 100/);
  });
  it("keeps it with enough impressions", () => {
    expect(
      applyVolumeFloorGate("SK14", checkCtxOf(input(5000)), fires(assetScope), RULES).state,
    ).toBe("fires");
  });
  it("leaves the finding alone when the asset cannot be resolved", () => {
    const r = applyVolumeFloorGate(
      "SK14",
      checkCtxOf(input(50)),
      fires({ ...assetScope, id: "unknown" }),
    );
    expect(findingsOf(r)).toHaveLength(1);
  });
});

describe("owner-context gate through the public API", () => {
  const starved = { budget: 100, cost: 100, value: 400, is: { lostBudget: 0.2 } };
  const status = (clientContext?: Parameters<typeof buildInput>[0]["clientContext"]) =>
    runChecks(
      buildInput({
        campaigns: [{ id: "11", ...starved }],
        ...(clientContext ? { clientContext } : {}),
      }),
    ).checks.find((c) => c.id === "BB07")?.status;
  it("judges against the account average with no context", () => {
    expect(status()).toBe("finding");
  });
  it("an owner target above the results makes the campaign not profitable", () => {
    expect(status({ campaigns: { "11": { target: "ROAS 10:1" } } })).toBe("clean");
  });
  it("a suggested target nobody confirmed is not a bar", () => {
    expect(status({ campaigns: { "11": { target: "ROAS 10:1", source: "suggested" } } })).toBe(
      "finding",
    );
  });
});

describe("severity policy: context-only checks never emit", () => {
  it("BB01 runs and its finding is kept as context, not reported", () => {
    const r = runChecks(buildInput({ campaigns: [{ id: "11", budget: 100, cost: 30 }] }));
    expect(r.findings.some((f) => f.checkId === "BB01")).toBe(false);
    expect(r.suppressed.some((s) => s.checkId === "BB01" && /context only/.test(s.reason))).toBe(
      true,
    );
    expect(r.checks.find((c) => c.id === "BB01")?.status).toBe("suppressed");
  });
});
