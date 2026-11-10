// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/** Campaign roles (brand / retargeting / prospecting), the brand name rule and the brand CPC band. */
import { describe, expect, it } from "vitest";
import { brandTermsMatcher, isBrandCampaign } from "../shared/campaignClassification.js";
import { brandCpcBand } from "../shared/brandCpcBand.js";
import { currencyScale } from "../shared/currencyScale.js";
import { layerRolesOf, type LayerRoleInput } from "./layerRoles.js";

const W = (cost = 0, clicks = 0) => ({ m90: { cost, clicks } });
const term = (t: string, clicks: number) => ({
  attrs: { term: t, source: "searchTerms" },
  windows: W(0, clicks),
});
function camp(id: string, name: string, type: string, o: Record<string, any> = {}): any {
  return {
    id,
    name,
    status: o.status ?? "ENABLED",
    windows: W(o.cost ?? 100, o.clicks ?? 100),
    attrs: {
      type,
      isBrand: isBrandCampaign(name),
      strategy: o.strategy ?? "MAXIMIZE_CONVERSION_VALUE",
    },
    children: { searchTerms: o.terms ?? [], adGroups: [] },
  };
}
const input = (campaigns: any[], o: Partial<LayerRoleInput> = {}): LayerRoleInput => ({
  campaigns,
  isBrandText: brandTermsMatcher(["Acme Leather", "Juno"]),
  ...o,
});

describe("brand campaign name rule: whole words", () => {
  it("Brand New Arrivals and Rebrand are not brand campaigns; real brand names are", () => {
    expect(isBrandCampaign("Brand New Arrivals")).toBe(false);
    expect(isBrandCampaign("Rebrand Spring Sale")).toBe(false);
    expect(isBrandCampaign("DEMO - SEARCH - Brand")).toBe(true);
    expect(isBrandCampaign("Brand - New customers")).toBe(true);
    expect(isBrandCampaign("BrandSearch")).toBe(true);
    expect(isBrandCampaign("Brand2025")).toBe(true);
    expect(isBrandCampaign("Non-Brand Search")).toBe(false);
    expect(isBrandCampaign("Kampania marka")).toBe(true);
  });
});

describe("brand CPC band helper", () => {
  it("is the larger of 0.40 (currency-scaled) and 40% of the non-brand CPC, as BB15 had it", () => {
    const usd = currencyScale("USD");
    expect(brandCpcBand({ nonBrandCpc: 2, currency: usd }).bar).toBeCloseTo(0.8, 6);
    expect(brandCpcBand({ nonBrandCpc: 0.5, currency: usd }).bar).toBeCloseTo(0.4, 6);
    expect(
      brandCpcBand({ nonBrandCpc: 2, currency: usd, floorUsd: 1, share: 0.25 }).bar,
    ).toBeCloseTo(1, 6);
  });
});

describe("campaign roles", () => {
  it("brand by name, retargeting by RT, everything else prospecting", () => {
    const pmax = camp("1", "DEMO - PMAX - ALL", "PERFORMANCE_MAX");
    const shop = camp("2", "USDM - SHOP - JUNO", "SHOPPING", { strategy: "TARGET_ROAS" });
    const brand = camp("3", "DEMO - SEARCH - Brand", "SEARCH");
    const rt = camp("4", "DEMO - DGEN - RT", "DEMAND_GEN");
    const roles = layerRolesOf(input([pmax, shop, brand, rt]));
    expect(roles.get("1")?.role).toBe("prospecting");
    expect(roles.get("2")?.role).toBe("prospecting");
    expect(roles.get("3")?.role).toBe("brand");
    expect(roles.get("4")?.role).toBe("retargeting");
  });
  it("brand by searches only (a name with no brand word)", () => {
    const c = camp("1", "Search 1", "SEARCH", {
      terms: [term("acme leather mug", 50), term("juno mug", 30), term("leather mug", 20)],
    });
    expect(layerRolesOf(input([c])).get("1")?.role).toBe("brand");
  });
  it("only three roles exist: a Shopping campaign at any priority is prospecting", () => {
    const c = camp("1", "Shopping - all", "SHOPPING", { strategy: "MANUAL_CPC" });
    expect(layerRolesOf(input([c])).get("1")?.role).toBe("prospecting");
  });
  it("the caller's brand tag beats the name", () => {
    const c = camp("1", "Shopping - all", "SHOPPING");
    const roles = layerRolesOf(
      input([c], { ownerTags: { brandCampaignNames: ["Shopping - all"] } }),
    );
    expect(roles.get("1")).toMatchObject({ role: "brand", why: "tagged as a brand campaign" });
  });
});
