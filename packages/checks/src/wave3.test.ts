// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Wave 3 checks on synthetic accounts: Shopping, the PMax product and placement checks,
// countries and languages, Local Services, video and Demand Gen. Every number is made up.
// For each check: it fires, it is clean, and it is not run (never clean) when it cannot judge.

import { describe, expect, it } from "vitest";
import { runChecks, type EvidenceInput } from "./api.js";
import type { CheckResult } from "./engine/checks/types.js";
import type { Row } from "./engine/shared/input.js";
import { siteLanguageOf } from "./engine/checks/slices.js";
import { catalogItemsOf, includedByListingTree } from "./engine/model/productCatalog.js";
import { checkCtxOf, runOne } from "./testing/account.js";
import {
  calls,
  country,
  demandGenAccount,
  dgAsset,
  dgChannel,
  dgControl,
  DG_FULL_ASSETS,
  leads,
  LSA_CAMPAIGN,
  lsaAccount,
  placement,
  PMAX_CAMPAIGN,
  PRODUCTS,
  SHOPPING_CAMPAIGN,
  shoppingAccount,
  videoAccount,
  withStatus,
  type ProductSpec,
} from "./testing/wave3.js";

const state = (r: CheckResult) => r.state;
const findingsOf = (r: CheckResult) => (r.state === "fires" ? r.findings : []);
const status = (input: EvidenceInput, id: string) =>
  runChecks(input).checks.find((c) => c.id === id)?.status;

/** A named table marked failed (the read went wrong). */
function failed(input: EvidenceInput, table: string): EvidenceInput {
  return {
    ...input,
    statusRows: (input.statusRows ?? []).map((r) =>
      r.table_name === table ? { ...r, status: "failed", error_message: "boom" } : r,
    ),
  };
}

const many = (n: number, o: Partial<ProductSpec> = {}): ProductSpec[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `sku-${i + 1}`,
    cost: 50,
    conv: 1,
    value: 250,
    ...o,
  }));

// ---------------------------------------------------------------------------
// Shopping
// ---------------------------------------------------------------------------

describe("SH01 products Google Ads cannot show", () => {
  it("fires over the bar and names the products", () => {
    const products = PRODUCTS.map((p, i) => (i < 2 ? { ...p, status: "NOT_ELIGIBLE" } : p));
    const r = runOne("SH01", shoppingAccount({ products }));
    expect(findingsOf(r)[0]?.facts.products_cannot_show).toBe(2);
    expect(findingsOf(r)[0]?.rows?.map((x) => x.entity.id)).toEqual(["sku-1", "sku-2"]);
    // an older snapshot without Google's issues: the reason is said to be unread
    expect(findingsOf(r)[0]?.rows?.[0]?.cells.reason).toBe("reason not read");
  });
  it("is clean under the bar, and the bar is a setting", () => {
    const products = [
      { id: "sku-1", cost: 300, conv: 6, value: 900, status: "NOT_ELIGIBLE" },
      ...PRODUCTS.slice(1),
      ...many(14).map((p, i) => ({ ...p, id: `x${i}` })),
    ];
    expect(state(runOne("SH01", shoppingAccount({ products })))).toBe("none_found");
    const strict = shoppingAccount({ products, settings: { shopping: { disapprovedMaxPct: 1 } } });
    expect(state(runOne("SH01", strict))).toBe("fires");
  });
  it("counts feed rows: the same items in a US and a CA feed, blocked in CA only", () => {
    const products = [
      ...PRODUCTS,
      ...PRODUCTS.map((p) => ({ ...p, feedLabel: "CA", status: "NOT_ELIGIBLE" })),
    ];
    const r = runOne("SH01", shoppingAccount({ products }));
    expect(findingsOf(r)[0]?.facts).toMatchObject({
      feed_rows_cannot_show: 6,
      feed_rows_advertised: 12,
      feed_rows_with_status: 12,
      products_cannot_show: 6,
    });
    expect(findingsOf(r)[0]?.rows?.[0]?.cells.feeds).toBe("CA");
  });
  it("is not run when the product list was not read", () => {
    expect(status(failed(shoppingAccount(), "shopping_products"), "SH01")).toBe("not_run");
  });
  it("counts only the feeds a live campaign serves: a shared Merchant Center's EU feed is left out", () => {
    // 40 EU products this US account never serves, every one blocked
    const products = [
      ...PRODUCTS,
      ...many(40).map((p, i) => ({ ...p, id: `eu-${i}`, feedLabel: "EU", status: "NOT_ELIGIBLE" })),
    ];
    const base = shoppingAccount({ products, shoppingFeedLabel: "US" });
    const usOnly: EvidenceInput = {
      ...base,
      data: {
        ...base.data,
        shoppingSettings: (base.data.shoppingSettings as Row[]).map((r) => ({
          ...r,
          feed_label: "US",
        })),
      },
    };
    const r = runOne("SH01", usOnly);
    expect(state(r)).toBe("none_found");
    expect(r.state === "none_found" ? r.population : null).toBe(6);
    // a live campaign selling every feed label (the PMax with no label) can serve them: counted
    expect(state(runOne("SH01", base))).toBe("fires");
    // a paused campaign selling the EU label does not make them count
    const withPaused = shoppingAccount({
      products,
      campaigns: [
        SHOPPING_CAMPAIGN,
        PMAX_CAMPAIGN,
        { ...SHOPPING_CAMPAIGN, id: "73", name: "Shopping EU", status: "PAUSED" },
      ],
    });
    const pausedEu: EvidenceInput = {
      ...withPaused,
      data: {
        ...withPaused.data,
        shoppingSettings: [
          ...(usOnly.data.shoppingSettings as Row[]),
          { campaign_id: "73", campaign_priority: 0, merchant_id: "900", feed_label: "EU" },
        ],
      },
    };
    expect(state(runOne("SH01", pausedEu))).toBe("none_found");
  });
  // B8, modelled on a live shop (2 Nov): 5,438 US feed rows, 460 can show; the rest are sizes
  // no live campaign advertises (left out of a listing group, asset group paused, in no
  // campaign) or sold-out sizes. Scaled down: 46 can show, 15 advertised but out of stock,
  // 1 advertised and blocked by a feed problem, 482 not in any live campaign
  const shopUs = () => {
    const row = (id: string, o: Partial<ProductSpec>): ProductSpec => ({
      id,
      cost: 0,
      conv: 0,
      value: 0,
      served: false,
      availability: "IN_STOCK",
      issues: [],
      ...o,
    });
    const notEligible = (issues: string[], availability = "IN_STOCK"): Partial<ProductSpec> => ({
      status: "NOT_ELIGIBLE",
      issues,
      availability,
    });
    return [
      ...PRODUCTS.map((p) => ({ ...p, availability: "IN_STOCK", issues: [] })),
      ...Array.from({ length: 40 }, (_, i) => row(`ok-${i}`, { status: "ELIGIBLE" })),
      ...Array.from({ length: 15 }, (_, i) =>
        row(`oos-${i}`, notEligible(["not_eligible_out_of_stock"], "OUT_OF_STOCK")),
      ),
      row("mismatch-1", notEligible(["availability_mismatch"])),
      ...Array.from({ length: 400 }, (_, i) =>
        row(`lg-${i}`, notEligible(["not_eligible_excluded_product_listing_group"])),
      ),
      ...Array.from({ length: 70 }, (_, i) =>
        row(
          `lgoos-${i}`,
          notEligible(
            ["not_eligible_excluded_product_listing_group", "not_eligible_out_of_stock"],
            "OUT_OF_STOCK",
          ),
        ),
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        row(`agp-${i}`, notEligible(["not_eligible_asset_group_paused"])),
      ),
    ];
  };
  it("B8: the share is over the rows a live campaign advertises; out of stock and not advertised are their own counts", () => {
    const r = runOne("SH01", shoppingAccount({ products: shopUs() }));
    // 1 blocked of 62 advertised (46 showable + 15 sold out + 1 blocked) = 1.6%, under the 5% bar
    expect(r.state).toBe("none_found");
    expect(r.state === "none_found" ? r.population : null).toBe(62);
    expect(r.state === "none_found" ? r.note : "").toBe(
      "1 of 62 product feed rows a live campaign advertises cannot show (1.61%); 15 more are out of stock (sold-out sizes or colours); 482 of 544 feed rows are not in any live campaign",
    );
  });
  it("B8: fires on feed problems alone, and names each product's reason", () => {
    const products = [
      ...shopUs(),
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `bad-${i}`,
        cost: 0,
        served: false,
        status: "NOT_ELIGIBLE",
        availability: "IN_STOCK",
        issues: ["image_unwanted_overlays"],
      })),
    ];
    const f = findingsOf(runOne("SH01", shoppingAccount({ products })))[0];
    expect(f?.facts).toMatchObject({
      feed_rows_advertised: 68,
      feed_rows_cannot_show: 7,
      feed_rows_disapproved: 7,
      feed_rows_out_of_stock: 15,
      feed_rows_not_in_live_campaign: 482,
      feed_rows_with_status: 550,
      products_cannot_show: 7,
      cannot_show_pct: 10.29,
    });
    expect(f?.facts).not.toHaveProperty("feed_rows_reason_not_read");
    // the sold-out and not-advertised sizes are never listed as feed faults
    const ids = f?.rows?.map((x) => x.entity.id) ?? [];
    expect(ids.some((id) => /^(oos|lg|lgoos|agp)-/.test(id ?? ""))).toBe(false);
    expect(f?.rows?.[0]?.cells.reason).toBe("disapproved or held back by a feed problem");
  });
  it("B8: no row advertised by a live campaign: not run, never a 100% alarm", () => {
    const products = PRODUCTS.map((p) => ({
      ...p,
      status: "NOT_ELIGIBLE",
      availability: "IN_STOCK",
      issues: ["not_eligible_in_any_campaign"],
    }));
    expect(runOne("SH01", shoppingAccount({ products }))).toMatchObject({
      state: "not_checkable",
      category: "not_present",
    });
  });
  it("no live Shopping or PMax campaign sells products: not checkable, never the shared catalogue", () => {
    // every product blocked, but only a paused campaign sells them
    const products = PRODUCTS.map((p) => ({ ...p, status: "NOT_ELIGIBLE" }));
    const input = shoppingAccount({
      products,
      campaigns: [{ ...SHOPPING_CAMPAIGN, status: "PAUSED" }],
    });
    const r = runOne("SH01", input);
    expect(r).toMatchObject({
      state: "not_checkable",
      reason: "no live Shopping or Performance Max campaign sells products",
      category: "not_present",
    });
  });
});

describe("Merchant Center checks (SH02, SH08, SH09, SH15, SH22) on a snapshot", () => {
  it("are not run with the reason that Merchant Center is not read", () => {
    const r = runChecks(shoppingAccount());
    for (const id of ["SH02", "SH08", "SH09", "SH15", "SH22"]) {
      const c = r.checks.find((x) => x.id === id);
      expect([id, c?.status]).toEqual([id, "not_run"]);
      expect(c?.reason).toMatch(/Google Ads API only/);
    }
    // one shared sentence, so the reply can give it once
    const reasons = ["SH02", "SH08", "SH09", "SH15", "SH22"].map(
      (id) => r.checks.find((x) => x.id === id)?.reason,
    );
    expect(new Set(reasons).size).toBe(1);
  });
  it("SH02 and SH08 still judge Merchant Center rows an input provides", () => {
    const base = shoppingAccount();
    const input: EvidenceInput = {
      ...base,
      data: {
        ...base.data,
        mcAccountIssues: [{ issue_id: "1", title: "Missing shipping", severity: "ERROR" }],
        mcPromotions: [
          { promotion_id: "1", promotion_status: "EXPIRED" },
          { promotion_id: "2", promotion_status: "EXPIRED" },
        ],
      },
      statusRows: (base.statusRows ?? []).map((r) =>
        r.table_name === "mc_account_issues" || r.table_name === "mc_promotions"
          ? { ...r, status: "ok", row_count: r.table_name === "mc_promotions" ? 2 : 1 }
          : r,
      ),
    };
    expect(state(runOne("SH02", input))).toBe("fires");
    expect(state(runOne("SH08", input))).toBe("fires");
  });
});

describe("SH03 product spend concentration", () => {
  it("fires when the top 10 hold most of the spend", () => {
    const products = [
      ...many(10, { cost: 500 }),
      ...many(10, { cost: 5 }).map((p, i) => ({ ...p, id: `tail-${i}` })),
    ];
    const r = runOne("SH03", shoppingAccount({ products }));
    expect(state(r)).toBe("fires");
    expect(findingsOf(r)[0]?.rows).toHaveLength(10);
  });
  it("is clean when spend is spread", () => {
    expect(state(runOne("SH03", shoppingAccount({ products: many(30) })))).toBe("none_found");
  });
  it("is not run with 10 or fewer products spending (the top 10 is all of them)", () => {
    expect(runOne("SH03", shoppingAccount())).toMatchObject({
      state: "not_checkable",
      category: "nothing_to_compare",
    });
  });
});

describe("SH04 a product spends past the bar without a sale", () => {
  it("fires on a product over the bar with no sale", () => {
    const products = [...PRODUCTS, { id: "sku-9", cost: 400, conv: 0, value: 0 }];
    const r = runOne("SH04", shoppingAccount({ products }));
    expect(findingsOf(r).map((f) => f.scope.id)).toEqual(["sku-9"]);
  });
  it("is clean when every product over the bar sold", () => {
    expect(state(runOne("SH04", shoppingAccount()))).toBe("none_found");
  });
  it("sums an item's spend across its feeds (40 in US + 40 in CA past a bar of 50)", () => {
    const bands = {
      wasteBandUnder1kUsd: 50,
      wasteBand1kTo10kUsd: 50,
      wasteBand10kTo50kUsd: 50,
      wasteBand50kPlusUsd: 50,
    };
    const sku9 = { id: "sku-9", cost: 40, conv: 0, value: 0 };
    const twoFeeds = [...PRODUCTS, sku9, { ...sku9, feedLabel: "CA" }];
    const r = runOne("SH04", shoppingAccount({ products: twoFeeds, settings: { floors: bands } }));
    expect(findingsOf(r).map((f) => [f.scope.id, f.facts["Pr.spend"]])).toEqual([["sku-9", 80]]);
    // one feed alone stays under the bar
    const oneFeed = shoppingAccount({ products: [...PRODUCTS, sku9], settings: { floors: bands } });
    expect(state(runOne("SH04", oneFeed))).toBe("none_found");
  });
  it("is not run when the products were not read, and not present with no product", () => {
    expect(status(failed(shoppingAccount(), "products"), "SH04")).toBe("not_run");
    for (const id of ["SH03", "SH04", "SH05", "SH14", "SH20", "SH23"])
      expect([id, runOne(id, shoppingAccount({ products: [] }))]).toMatchObject([
        id,
        { category: "not_present" },
      ]);
  });
});

describe("SH05 a product returning far more than the account", () => {
  const products = [...PRODUCTS, { id: "sku-9", cost: 200, conv: 20, value: 6_000 }];
  it("fires on a product returning far more than the account", () => {
    expect(findingsOf(runOne("SH05", shoppingAccount({ products })))[0]?.scope.id).toBe("sku-9");
  });
  it("is clean when the strong products return in line, and the multiple is a setting", () => {
    const even = [...PRODUCTS, { id: "sku-9", cost: 200, conv: 20, value: 1_200 }];
    expect(state(runOne("SH05", shoppingAccount({ products: even })))).toBe("none_found");
    const strict = shoppingAccount({ products, settings: { shopping: { scaleRoasMultiple: 20 } } });
    expect(state(runOne("SH05", strict))).toBe("none_found");
  });
  it("has no verdict when no product has enough conversions", () => {
    expect(state(runOne("SH05", shoppingAccount()))).toBe("insufficient_data");
  });
});

describe("SH06 / SH13 need Merchant Center attributes (size, GTIN, colour)", () => {
  it("are not run on Google Ads product data, saying Google does not return them", () => {
    const r = runChecks(shoppingAccount());
    for (const id of ["SH06", "SH13"]) {
      const c = r.checks.find((x) => x.id === id);
      expect([id, c?.status, c?.category]).toEqual([id, "not_run", "google_withholds"]);
    }
  });
});

describe("SH10 two Shopping campaigns at the same priority", () => {
  it("fires on two campaigns with the same feed label and priority", () => {
    const r = runOne("SH10", shoppingAccount({ secondShopping: true }));
    expect(
      findingsOf(r)
        .map((f) => f.scope.id)
        .sort(),
    ).toEqual(["71", "72"]);
  });
  it("is clean with one Shopping campaign", () => {
    expect(state(runOne("SH10", shoppingAccount()))).toBe("none_found");
  });
  it("is not run when the Shopping settings were not read", () => {
    expect(
      status(failed(shoppingAccount({ secondShopping: true }), "shopping_settings"), "SH10"),
    ).toBe("not_run");
  });
});

describe("SH11 cart data (a context line)", () => {
  it("is clean with cart rows, and not run with none", () => {
    expect(state(runOne("SH11", shoppingAccount()))).toBe("none_found");
    expect(runOne("SH11", shoppingAccount({ cart: [] }))).toMatchObject({
      state: "not_checkable",
      category: "not_present",
    });
  });
});

describe("cart data across feeds", () => {
  it("an item's cart rows from its US and CA feeds are summed, like its spend", () => {
    const row = (orders: number) => ({
      product_item_id: "sku-1",
      units_sold: orders,
      orders,
      revenue_micros: orders * 50_000_000,
      average_cart_size: 1,
    });
    // 6 + 6 orders: 12, over the 10-order floor only when summed
    const r = runOne("SH11", shoppingAccount({ cart: [row(6), row(6)] }));
    expect(r.state === "none_found" ? r.note : "").toMatch(/1 joined, 1 with 10\+ orders/);
  });
});

describe("SH23 gift cards and test items in ads", () => {
  it("fires when a gift card spends past the bar", () => {
    const products = [
      ...PRODUCTS,
      { id: "gc-1", title: "Gift card 50", cost: 60, conv: 0, value: 0 },
    ];
    const r = runOne("SH23", shoppingAccount({ products }));
    expect(findingsOf(r)[0]?.rows?.[0]?.entity.id).toBe("gc-1");
  });
  it("is clean on real products, and a small spend is a note", () => {
    expect(state(runOne("SH23", shoppingAccount()))).toBe("none_found");
    const products = [
      ...PRODUCTS,
      { id: "gc-1", title: "Gift card 50", cost: 5, conv: 0, value: 0 },
    ];
    expect(state(runOne("SH23", shoppingAccount({ products })))).toBe("none_found");
  });
});

describe("SH24 store quality", () => {
  it("is not run: Google does not show it to outside tools", () => {
    expect(runOne("SH24", shoppingAccount())).toMatchObject({ category: "google_withholds" });
  });
});

describe("SH14 custom labels", () => {
  it("fires when most products carry no label", () => {
    const products = PRODUCTS.map((p) => ({ ...p, labels: [null] }));
    const r = runOne("SH14", shoppingAccount({ products }));
    expect(findingsOf(r)[0]?.facts.unlabelled).toBe(6);
  });
  it("is clean when products are labelled", () => {
    expect(state(runOne("SH14", shoppingAccount()))).toBe("none_found");
  });
  it("never counts a product whose labels were not read as unlabelled", () => {
    const base = shoppingAccount({ products: PRODUCTS.map((p) => ({ ...p, labels: [null] })) });
    const input = { ...base, data: { ...base.data, shoppingProductsData: [] } };
    expect(runOne("SH14", input)).toMatchObject({ state: "not_checkable", category: "our_gap" });
  });
});

describe("SH17 Shopping priority and product filter known", () => {
  it("is clean when every Shopping campaign's settings were read", () => {
    expect(state(runOne("SH17", shoppingAccount()))).toBe("none_found");
  });
  it("is not run for a Shopping campaign with no settings row", () => {
    const base = shoppingAccount();
    const input = {
      ...base,
      data: { ...base.data, shoppingSettings: (base.data.shoppingSettings ?? []).slice(1) },
    };
    expect(state(runOne("SH17", input))).toBe("not_checkable");
  });
});

describe("SH18 product quadrant (context, never a finding)", () => {
  it("states the quadrant counts and never fires", () => {
    const r = runOne("SH18", shoppingAccount());
    expect(r.state).toBe("insufficient_data");
    expect(status(shoppingAccount(), "SH18")).toBe("not_run");
  });
});

describe("SH19 an included product that never served", () => {
  it("fires on a product in an included listing group with no impression", () => {
    const products = [...PRODUCTS, { id: "sku-9", served: false }];
    const r = runOne("SH19", shoppingAccount({ products }));
    expect(findingsOf(r)[0]?.rows?.map((x) => x.entity.id)).toEqual(["sku-9"]);
  });
  it("is clean when every included product served", () => {
    expect(state(runOne("SH19", shoppingAccount()))).toBe("none_found");
  });
  it("is not run when the product list was cut at its limit", () => {
    const products = [...PRODUCTS, { id: "sku-9", served: false }];
    expect(runOne("SH19", shoppingAccount({ products, catalogCut: true }))).toMatchObject({
      state: "not_checkable",
      category: "incomplete_data",
    });
  });
});

describe("SK20 product pages a product check already prices (R17)", () => {
  // a gold belt size with 60 clicks and no sale (SH20 prices it), its page judged on value
  const products = [
    ...PRODUCTS,
    {
      id: "shopify_us_871_87101",
      title: "Gold belt Luxe wide metallic - Gold, 4 cm",
      cost: 100,
      clicks: 60,
      conv: 0,
      value: 0,
    },
    {
      id: "shopify_us_871_87102",
      title: "Gold belt Luxe wide metallic - Silver, 3 cm",
      cost: 50,
      clicks: 20,
      conv: 2,
      value: 300,
    },
    { id: "shopify_us_872_87201", cost: 50, clicks: 20, conv: 2, value: 300 },
  ];
  const lp = (url: string, cost = 480, value = 560): Row => ({
    url,
    cost,
    clicks: 230,
    impressions: 5000,
    conversions: 6,
    conversion_value: value,
  });
  const withPages = (urls: string[], cost?: number, value?: number): EvidenceInput => {
    const input = shoppingAccount({ products });
    return {
      ...input,
      data: { ...input.data, landingPageViews: urls.map((u) => lp(u, cost, value)) },
    };
  };
  it("leaves the page out when the product checks price 80%+ of its spend, naming the check", () => {
    // SH20 prices 100 of the page's 120
    const r = runChecks(
      withPages(["https://example.com/products/gold-belt?variant=87101"], 120, 40),
    );
    expect(r.findings.find((x) => x.checkId === "SK20")).toBeUndefined();
    expect(r.findings.find((x) => x.checkId === "SH20")?.impact.quantified).toBe(true);
    const entry = r.checks.find((c) => c.id === "SK20");
    expect(entry?.reason ?? entry?.note).toMatch(
      /products\/gold-belt left out: SH20 already prices 100 of its 120 spend over 90 days as the product spend of Gold belt Luxe wide metallic(?! -)/,
    );
  });
  it("keeps a page when one priced size is a small part of its spend, marked as overlapping", () => {
    // one size priced at 100 of a 480 page: a page of 8 sizes is not that one size
    const r = runChecks(withPages(["https://example.com/products/gold-belt?variant=87101"]));
    const page = r.findings.find((x) => x.checkId === "SK20");
    expect(page?.impact.quantified).toBe(true);
    expect(page?.facts.overlaps_with).toEqual(["SH20"]);
    expect(page?.facts.product_spend_priced_elsewhere_90d).toBe(100);
    expect(String(page?.facts.overlap_note)).toContain("Gold belt Luxe wide metallic;");
    expect(String(page?.facts.overlap_note)).not.toContain("4 cm");
  });
  it("keeps a product page whose product no product check prices", () => {
    const r = runChecks(withPages(["https://example.com/products/other-belt?variant=87201"]));
    const page = r.findings.find((x) => x.checkId === "SK20");
    expect(page?.impact.quantified).toBe(true);
    expect(page?.facts.overlaps_with).toBeUndefined();
  });
});

describe("SH20 products with clicks and no sale", () => {
  it("fires on a product past the clicks bar with no sale", () => {
    const products = [...PRODUCTS, { id: "sku-9", cost: 30, clicks: 80, conv: 0, value: 0 }];
    expect(findingsOf(runOne("SH20", shoppingAccount({ products })))[0]?.rows?.[0]?.entity.id).toBe(
      "sku-9",
    );
  });
  it("is not run otherwise: the item-group comparison cannot be made", () => {
    expect(runOne("SH20", shoppingAccount())).toMatchObject({ category: "our_gap" });
  });
  it("B19: priced on exactly the zero-sale sizes (3 products, $395.92 in 90 days)", () => {
    // Jacket sizes S and M sold nothing; the jacket sells in other sizes ($1,217), so no
    // product waste check prices them. Same for the gold belt.
    const products = [
      ...PRODUCTS,
      {
        id: "shopify_us_846_1",
        title: "Jacket Lisa Black S",
        cost: 162.63,
        clicks: 80,
        conv: 0,
        value: 0,
      },
      {
        id: "shopify_us_846_2",
        title: "Jacket Lisa Black M",
        cost: 133.29,
        clicks: 70,
        conv: 0,
        value: 0,
      },
      {
        id: "shopify_us_846_3",
        title: "Jacket Lisa Black L",
        cost: 303.35,
        clicks: 244,
        conv: 5,
        value: 1217,
      },
      { id: "shopify_us_871_1", title: "Gold Belt 85", cost: 100, clicks: 60, conv: 0, value: 0 },
      { id: "shopify_us_871_2", title: "Gold Belt 90", cost: 50, clicks: 20, conv: 2, value: 300 },
    ];
    const input = shoppingAccount({ products });
    const f = findingsOf(runOne("SH20", input))[0];
    expect(f?.facts.priced_by_product_waste_check).toBe(0);
    expect(f?.facts.rollup_wasted_cost_90d).toBeCloseTo(395.92, 2);
    const priced = runChecks(input).findings.find((x) => x.checkId === "SH20");
    expect(Number(priced?.impact.value)).toBeCloseTo(395.92 / 3, 1);
  });
  it("a size whose product PX05 prices in one PMax campaign is not priced again here", () => {
    // the product sells overall ($3,000 on $600), but in the PMax campaign it spent $5,000
    // with no sale: PX05 prices that, so its zero-sale size is left out of SH20's money
    const products = [
      ...PRODUCTS,
      {
        id: "shopify_us_500_1",
        title: "Coat Ivo Navy S",
        cost: 300,
        clicks: 80,
        conv: 0,
        value: 0,
      },
      {
        id: "shopify_us_500_2",
        title: "Coat Ivo Navy M",
        cost: 300,
        clicks: 80,
        conv: 4,
        value: 3000,
      },
      { id: "shopify_us_600_1", title: "Scarf Mo Red S", cost: 120, clicks: 60, conv: 0, value: 0 },
      {
        id: "shopify_us_600_2",
        title: "Scarf Mo Red M",
        cost: 50,
        clicks: 20,
        conv: 2,
        value: 1000,
      },
    ];
    const pmaxRow = (offer: string, cost: number) => ({
      campaign_id: "41",
      offer_id: offer,
      // sizes of one product share its title (the size part aside)
      product_title: `Product ${offer.replace(/_\d+$/, "")} 85`,
      cost_micros: cost * 1_000_000,
      clicks: 100,
      impressions: 5_000,
      conversions: 0,
      conversions_value: 0,
    });
    const without = findingsOf(runOne("SH20", shoppingAccount({ products })))[0];
    const withPmax = findingsOf(
      runOne(
        "SH20",
        shoppingAccount({
          products,
          campaignProducts: [pmaxRow("shopify_us_500_1", 5000), pmaxRow("shopify_us_600_1", 5)],
        }),
      ),
    )[0];
    expect(Number(without?.facts.rollup_wasted_cost_90d)).toBeCloseTo(420, 2);
    expect(withPmax?.facts.priced_by_product_waste_check).toBe(1);
    expect(Number(withPmax?.facts.rollup_wasted_cost_90d)).toBeCloseTo(120, 2);
  });
  it("a size whose whole product spends past the bar without a sale is priced there, not here", () => {
    const products = [
      ...PRODUCTS,
      { id: "shopify_us_9_1", cost: 5000, clicks: 80, conv: 0, value: 0 },
    ];
    const f = findingsOf(runOne("SH20", shoppingAccount({ products })))[0];
    expect(f?.facts.priced_by_product_waste_check).toBe(1);
    expect(f?.facts.rollup_wasted_cost_90d).toBeUndefined();
    const sh20 = runChecks(shoppingAccount({ products })).findings.find(
      (x) => x.checkId === "SH20",
    );
    expect(sh20?.impact.value ?? null).toBeNull();
  });
});

describe("SH21 below break-even after product cost", () => {
  const margin = (pct: string) => ({
    account: { businessType: "ecommerce", grossMarginPct: pct },
  });
  it("needs the owner's margin, and fires when a campaign returns under break-even", () => {
    expect(runOne("SH21", shoppingAccount())).toMatchObject({ category: "needs_client_data" });
    const r = runOne("SH21", shoppingAccount({ clientContext: margin("10") }));
    expect(findingsOf(r).length).toBeGreaterThan(0);
  });
  it("is clean when every campaign clears break-even", () => {
    expect(state(runOne("SH21", shoppingAccount({ clientContext: margin("60") })))).toBe(
      "none_found",
    );
  });
});

describe("SH12 the same product in a Shopping and a Performance Max campaign", () => {
  it("fires when the Shopping campaign's feed label covers the PMax products", () => {
    const r = runOne("SH12", shoppingAccount({ shoppingFeedLabel: "US" }));
    expect(findingsOf(r)[0]?.facts.overlapping_items).toBe(6);
    expect(findingsOf(r)[0]?.limitedBy?.[0]).toMatch(/product groups are not read/);
  });
  it("is clean when the Shopping campaign sells another feed", () => {
    expect(state(runOne("SH12", shoppingAccount()))).toBe("none_found");
  });
  it("B8/N5: counts only items that can show (a live shop: 33 of 5,438 'buyable' was 33 of ~460)", () => {
    // 6 items both campaigns can sell and show, plus 30 sold-out sizes and 4 sizes Google
    // holds back that sit in both campaigns' products too
    const products = [
      ...PRODUCTS,
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `oos-${i}`,
        cost: 0,
        served: false,
        status: "NOT_ELIGIBLE",
        availability: "OUT_OF_STOCK",
        issues: ["not_eligible_out_of_stock"],
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `lg-${i}`,
        cost: 0,
        served: false,
        status: "NOT_ELIGIBLE",
        issues: ["not_eligible_excluded_product_listing_group"],
      })),
    ];
    const f = findingsOf(runOne("SH12", shoppingAccount({ products, shoppingFeedLabel: "US" })))[0];
    expect(f?.facts).toMatchObject({ overlapping_items: 6, items_that_can_show: 6 });
    expect(f?.scope.name).toBe("6 of 6 items that can show");
  });
  it("a PMax campaign with a feed label sells only that label's products", () => {
    // Shopping sells the CA feed; PMax (all products in its tree) is set to the US feed
    const products = [
      ...PRODUCTS,
      ...PRODUCTS.slice(0, 3).map((p) => ({ ...p, id: `ca-${p.id}`, feedLabel: "CA" })),
    ];
    const base = shoppingAccount({ products });
    const usPmax: EvidenceInput = {
      ...base,
      data: {
        ...base.data,
        shoppingSettings: (base.data.shoppingSettings as Row[]).map((r) =>
          r.campaign_id === "41" ? { ...r, feed_label: "US" } : r,
        ),
      },
    };
    expect(state(runOne("SH12", usPmax))).toBe("none_found");
    // no label on the PMax: it sells the CA items too
    expect(findingsOf(runOne("SH12", base))[0]?.facts.overlapping_items).toBe(3);
  });
  it("counts live campaigns only: a paused Shopping and a paused PMax over the same items are left out", () => {
    const base = shoppingAccount({
      shoppingFeedLabel: "US",
      secondShopping: true,
      campaigns: [
        SHOPPING_CAMPAIGN,
        PMAX_CAMPAIGN,
        { ...SHOPPING_CAMPAIGN, id: "72", name: "Shopping clearance", status: "PAUSED" },
        { ...PMAX_CAMPAIGN, id: "42", name: "PMax old", status: "PAUSED" },
      ],
    });
    const input: EvidenceInput = {
      ...base,
      data: {
        ...base.data,
        shoppingSettings: [
          ...(base.data.shoppingSettings as Row[]),
          { campaign_id: "42", campaign_priority: null, merchant_id: "900", feed_label: "" },
        ],
        assetGroups: [
          ...(base.data.assetGroups as Row[]),
          { ...(base.data.assetGroups as Row[])[0], asset_group_id: "53", campaign_id: "42" },
        ],
        pmaxListingGroups: [
          ...(base.data.pmaxListingGroups as Row[]),
          {
            asset_group_id: "53",
            listing_group_id: "9",
            parent_listing_group_id: null,
            type: "UNIT_INCLUDED",
            case_value: "{}",
          },
        ],
      },
    };
    const f = findingsOf(runOne("SH12", input))[0];
    expect(f?.facts).toMatchObject({
      overlapping_items: 6,
      items_that_can_show: 6,
      shopping_campaigns: 1,
      pmax_campaigns: 1,
    });
    expect(f?.rows?.[0]?.cells).toMatchObject({ shopping_campaigns: 1, pmax_campaigns: 1 });
  });
  it("fires when the items also sit in the CA feed the Shopping campaign sells", () => {
    const products = [...PRODUCTS, ...PRODUCTS.map((p) => ({ ...p, feedLabel: "CA" }))];
    const r = runOne("SH12", shoppingAccount({ products }));
    expect(findingsOf(r)[0]?.facts.overlapping_items).toBe(6);
  });
  it("is not run when a product's feed label was not read (it could belong to the campaign)", () => {
    const base = shoppingAccount({ shoppingFeedLabel: "US" });
    const unlabelled = (rows: Row[] | undefined) =>
      (rows ?? []).map((r) => ({ ...r, feed_label: null }));
    const input = {
      ...base,
      data: {
        ...base.data,
        products: unlabelled(base.data.products),
        shoppingProductsData: unlabelled(base.data.shoppingProductsData),
      },
    };
    expect(runOne("SH12", input)).toMatchObject({ state: "not_checkable", category: "our_gap" });
  });
  it("is not run when a PMax selection splits on product type (no exact match)", () => {
    expect(runOne("SH12", shoppingAccount({ listing: "type" }))).toMatchObject({
      state: "not_checkable",
      category: "our_gap",
    });
  });
});

describe("PX11 one product in several asset groups of one campaign", () => {
  it("fires when two live groups include every product", () => {
    const r = runOne("PX11", shoppingAccount({ overlappingGroups: true }));
    expect(findingsOf(r)[0]?.facts.products_in_more_than_one_asset_group).toBe(6);
    expect(findingsOf(r)[0]?.rows).toHaveLength(6);
  });
  it("is clean when the groups split the products", () => {
    expect(state(runOne("PX11", shoppingAccount({ listing: "split" })))).toBe("none_found");
  });
  it("is not run when a group splits on product type, and with one group", () => {
    expect(state(runOne("PX11", shoppingAccount({ listing: "type" })))).toBe("not_checkable");
    expect(runOne("PX11", shoppingAccount())).toMatchObject({ category: "nothing_to_compare" });
  });
});

describe("PX05 a product inside a Performance Max campaign spends without a sale", () => {
  const row = (id: string, cost: number, conv: number, value: number): Row => ({
    campaign_id: "41",
    offer_id: id,
    product_title: `Trail shoe ${id}`,
    cost_micros: cost * 1_000_000,
    clicks: 30,
    impressions: 900,
    conversions: conv,
    conversions_value: value,
  });
  it("fires per campaign, and a seller under break-even is a loss (warning or info), never an opportunity", () => {
    const r = runOne(
      "PX05",
      shoppingAccount({ campaignProducts: [row("sku-1", 90, 0, 0), row("sku-2", 90, 1, 30)] }),
    );
    const f = findingsOf(r);
    expect(f.map((x) => x.scope.id)).toEqual(["sku-1", "sku-2"]);
    expect(f[1]?.maxSeverity).toBe("warning");
    const scored = runChecks(
      shoppingAccount({ campaignProducts: [row("sku-1", 90, 0, 0), row("sku-2", 90, 1, 30)] }),
    ).findings.find((x) => x.checkId === "PX05" && x.scope.id === "sku-2");
    expect(["warning", "info"]).toContain(scored?.severity.severity);
  });
  it("prices the break-even shortfall per month as margin at risk, the no-sale spend as waste", () => {
    const input = shoppingAccount({
      campaignProducts: [row("sku-1", 90, 0, 0), row("sku-2", 90, 1, 30)],
    });
    const scored = runChecks(input).findings.filter((x) => x.checkId === "PX05");
    const bySku = new Map(scored.map((x) => [x.scope.id, x.impact]));
    // sold for 30 against 90 of ad cost: a 60 shortfall over 90 days = 20 a month at risk
    expect(bySku.get("sku-2")?.value).toBeCloseTo(20, 2);
    expect(bySku.get("sku-2")?.kind).toBe("at_risk");
    expect(bySku.get("sku-1")?.value).toBeCloseTo(30, 2);
    expect(bySku.get("sku-1")?.kind).toBe("waste");
  });
  it("is clean when nothing over the bar lost money", () => {
    expect(state(runOne("PX05", shoppingAccount()))).toBe("none_found");
  });
  it("a read cut at its limit with every kept row over the bar is not clean", () => {
    const base = shoppingAccount({
      campaignProducts: [row("sku-1", 90, 3, 900), row("sku-2", 80, 2, 600)],
    });
    const input = {
      ...base,
      statusRows: (base.statusRows ?? []).map((r) =>
        r.table_name === "pmax_campaign_products"
          ? { ...r, error_message: "truncated: the product read hit its row limit" }
          : r,
      ),
    };
    expect(runOne("PX05", input)).toMatchObject({ state: "not_checkable", category: "our_gap" });
  });
  it("is not present when the campaigns show no product", () => {
    expect(runOne("PX05", shoppingAccount({ campaignProducts: [] }))).toMatchObject({
      category: "not_present",
    });
  });
  it("is not run when the per-campaign product rows were not read", () => {
    expect(status(failed(shoppingAccount(), "pmax_campaign_products"), "PX05")).toBe("not_run");
  });
});

describe("PX07 / PX16 placements with spend and no sale", () => {
  const display = { id: "31", name: "Display remarketing", type: "DISPLAY", cost: 10, conv: 0.2 };
  const withPlaces = (rows: Row[]) =>
    shoppingAccount({
      campaigns: [
        { id: "71", name: "Shopping all shoes", type: "SHOPPING", cost: 6, conv: 0.15 },
        { id: "41", name: "PMax all shoes", type: "PERFORMANCE_MAX", cost: 6, conv: 0.15 },
        display,
      ],
      placements: rows,
    });
  it("PX07 fires on a place over the bar with no sale, never on Google's own", () => {
    const r = runOne(
      "PX07",
      withPlaces([
        placement("31", "junk.example", 80),
        placement("31", "youtube.com", 90),
        placement("31", "good.example", 80, 3),
      ]),
    );
    expect(findingsOf(r).map((f) => f.scope.name)).toEqual(["junk.example"]);
  });
  it("PX07 skips a place the account already excludes", () => {
    const input = withPlaces([placement("31", "junk.example", 80)]);
    const tables = {
      ...input.tables,
      account_placement_exclusions: [{ type: "PLACEMENT", value: "https://www.junk.example/" }],
    };
    const statusRows = (input.statusRows ?? []).map((r) =>
      r.table_name === "account_placement_exclusions" ? { ...r, row_count: 1 } : r,
    );
    expect(runOne("PX07", { ...input, tables, statusRows })).toMatchObject({
      state: "not_checkable",
    });
  });
  it("PX16 fires when many small places on one site add up", () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      placement("31", `https://news.example/page-${i}`, 20),
    );
    const r = runOne("PX16", withPlaces([...rows, placement("31", "shop.example", 30, 5)]));
    expect(findingsOf(r)[0]?.rows?.[0]?.entity.name).toBe("news.example");
  });
  it("both are clean when places convert, and not run with no paid places", () => {
    const good = withPlaces([placement("31", "good.example", 80, 4)]);
    expect([state(runOne("PX07", good)), state(runOne("PX16", good))]).toEqual([
      "none_found",
      "none_found",
    ]);
    expect(runOne("PX07", shoppingAccount())).toMatchObject({ category: "not_present" });
  });
});

describe("PX15 the running asset groups leave selling products out", () => {
  const node = (group: string, id: string, type: string, item?: string, parent?: string): Row => ({
    asset_group_id: group,
    listing_group_id: id,
    parent_listing_group_id: parent ?? null,
    type,
    case_value: JSON.stringify(
      item === undefined ? {} : { productItemId: item === "" ? {} : { value: item } },
    ),
  });
  /** 51 sells sku-1 and sku-2, 52 sku-3 and sku-4, 53 sku-5 (each by item id); 54 everything. */
  const three = (
    statuses: string[],
    cut = false,
    scoped?: { products: ProductSpec[]; running: Row[]; off?: Row[] },
  ): EvidenceInput => {
    const base = shoppingAccount({
      catalogCut: cut,
      ...(scoped ? { products: scoped.products } : {}),
    });
    const ids = ["51", "52", "53", "54"].slice(0, statuses.length);
    const groups = ids.map((id, i) => ({
      asset_group_id: id,
      campaign_id: "41",
      name: `Group ${id}`,
      status: statuses[i],
      ad_strength: "GOOD",
      cost: 100,
      clicks: 50,
      impressions: 2_000,
      conversions: 2,
      conversion_value: 400,
    }));
    const tree = (group: string, n: number, items: string[]) => [
      node(group, `${n}`, "SUBDIVISION"),
      ...items.map((item, i) => node(group, `${n + 1 + i}`, "UNIT_INCLUDED", item, `${n}`)),
      node(group, `${n + 9}`, "UNIT_EXCLUDED", "", `${n}`),
    ];
    const listing = [
      ...(scoped ? scoped.running : tree("51", 10, ["sku-1", "sku-2"])),
      ...(scoped?.off ?? [...tree("52", 30, ["sku-3", "sku-4"]), ...tree("53", 50, ["sku-5"])]),
      ...(ids.includes("54") ? [node("54", "70", "UNIT_INCLUDED")] : []),
    ];
    return { ...base, data: { ...base.data, assetGroups: groups, pmaxListingGroups: listing } };
  };
  it("fires when the switched-off groups held selling products no running group sells", () => {
    const r = runOne("PX15", three(["ENABLED", "PAUSED", "PAUSED"]));
    expect(
      findingsOf(r)[0]
        ?.rows?.map((x) => x.entity.id)
        .sort(),
    ).toEqual(["sku-3", "sku-4", "sku-5"]);
  });
  it("is clean when a running group still sells them", () => {
    expect(state(runOne("PX15", three(["ENABLED", "PAUSED", "PAUSED", "ENABLED"])))).toBe(
      "none_found",
    );
    expect(state(runOne("PX15", three(["PAUSED", "PAUSED", "PAUSED", "ENABLED"])))).toBe(
      "none_found",
    );
  });
  // a second live campaign "42" (Standard Shopping unless `type` says otherwise) that showed
  // sku-3 (2 sales) and sku-4 (a row with no spend: it showed); `settings` = its Merchant
  // Center account and feed label
  const withSecond = (
    settings?: { merchant_id: string; feed_label: string },
    type = "SHOPPING",
  ): EvidenceInput => {
    const base = three(["ENABLED", "PAUSED", "PAUSED"]);
    const campaigns = base.data.campaigns ?? [];
    const pmax = campaigns.find((c) => String(c.campaign_id ?? c.id) === "41") ?? {};
    const second = { ...pmax, campaign_id: "42", id: "42", name: "Product campaign", type };
    const daily = (base.data.campaignDailyMetrics ?? [])
      .filter((d) => String(d.campaign_id) === "41")
      .map((d) => ({ ...d, campaign_id: "42" }));
    const shown = (offer: string, cost: number, conv: number) => ({
      campaign_id: "42",
      offer_id: offer,
      product_title: `Trail shoe ${offer}`,
      cost_micros: cost * 1_000_000,
      clicks: cost > 0 ? 14 : 0,
      impressions: 1_188,
      impressions_7d: 96,
      conversions: conv,
      conversions_value: conv * 119,
      channel: type === "SHOPPING" ? "SHOPPING" : "PERFORMANCE_MAX",
    });
    return {
      ...base,
      data: {
        ...base.data,
        campaigns: [...campaigns, second],
        campaignDailyMetrics: [...(base.data.campaignDailyMetrics ?? []), ...daily],
        ...(settings
          ? {
              shoppingSettings: [
                ...(base.data.shoppingSettings ?? []),
                { campaign_id: "42", campaign_priority: null, enable_local: false, ...settings },
              ],
            }
          : {}),
      },
      tables: {
        ...base.tables,
        pmax_campaign_products: [
          ...(base.tables?.pmax_campaign_products ?? []),
          shown("sku-3", 20.47, 2),
          shown("sku-4", 0, 0),
        ],
      },
    };
  };
  it("a product a live Standard Shopping campaign showed is not left out", () => {
    const f = findingsOf(runOne("PX15", withSecond()))[0];
    expect(f?.rows?.map((x) => x.entity.id)).toEqual(["sku-5"]);
    expect(f?.facts.selling_products_advertised_by_another_live_campaign).toBe(2);
    expect(f?.facts.cover_judged_on).toMatch(/Standard Shopping/);
  });
  it("round 2 review: another live Performance Max campaign that showed the products in the last 7 days covers them", () => {
    const f = findingsOf(runOne("PX15", withSecond(undefined, "PERFORMANCE_MAX")))[0];
    expect(f?.rows?.map((x) => x.entity.id)).toEqual(["sku-5"]);
    expect(f?.facts.selling_products_advertised_by_another_live_campaign).toBe(2);
    expect(f?.facts.cover_judged_on).toMatch(/Standard Shopping and Performance Max/);
  });
  it("round 2 review: the campaign's own product rows are never its cover", () => {
    const input = three(["ENABLED", "PAUSED", "PAUSED"]);
    const own = (offer: string) => ({
      campaign_id: "41",
      offer_id: offer,
      product_title: `Trail shoe ${offer}`,
      cost_micros: 20_000_000,
      clicks: 14,
      impressions: 1_188,
      impressions_7d: 96,
      conversions: 1,
      conversions_value: 119,
      channel: "PERFORMANCE_MAX",
    });
    const f = findingsOf(
      runOne("PX15", {
        ...input,
        tables: {
          ...input.tables,
          pmax_campaign_products: [
            ...(input.tables?.pmax_campaign_products ?? []),
            own("sku-3"),
            own("sku-4"),
          ],
        },
      }),
    )[0];
    expect(f?.rows?.map((x) => x.entity.id).sort()).toEqual(["sku-3", "sku-4", "sku-5"]);
  });
  // round 2 re-review: rows of the other campaign with a 7-day count of 0, or none read
  const recentAs = (input: EvidenceInput, v: number | undefined): EvidenceInput => ({
    ...input,
    tables: {
      ...input.tables,
      pmax_campaign_products: (input.tables?.pmax_campaign_products ?? []).map((r) => {
        if (String(r.campaign_id) !== "42") return r;
        const rest = Object.fromEntries(Object.entries(r).filter(([k]) => k !== "impressions_7d"));
        return v === undefined ? rest : { ...rest, impressions_7d: v };
      }),
    },
  });
  it("round 2 re-review: rows over the window with no impressions in the last 7 days are no cover (the group that showed them may be off now)", () => {
    for (const type of ["SHOPPING", "PERFORMANCE_MAX"]) {
      const f = findingsOf(runOne("PX15", recentAs(withSecond(undefined, type), 0)))[0];
      expect(f?.rows?.map((x) => x.entity.id).sort()).toEqual(["sku-3", "sku-4", "sku-5"]);
      expect(f?.facts.selling_products_advertised_by_another_live_campaign).toBe(0);
    }
  });
  it("final: a 7-day count that was not read (older snapshot, failed read) is unknown: not_checkable naming the campaign, never a left-out list", () => {
    for (const type of ["SHOPPING", "PERFORMANCE_MAX"]) {
      const r = runOne("PX15", recentAs(withSecond(undefined, type), undefined));
      expect(r).toMatchObject({ state: "not_checkable", category: "our_gap" });
      expect(r.state === "not_checkable" ? r.reason : "").toMatch(
        /last 7 days' impressions .* were not read for live campaign\(s\) Product campaign/,
      );
    }
  });
  it("round 2 re-review: 7-day impressions in a campaign that is not live now are no cover", () => {
    const input = withSecond(undefined, "PERFORMANCE_MAX");
    const campaigns = (input.data.campaigns ?? []).map((c) =>
      String(c.campaign_id ?? c.id) === "42" ? { ...c, status: "PAUSED" } : c,
    );
    expect(state(runOne("PX15", { ...input, data: { ...input.data, campaigns } }))).not.toBe(
      "none_found",
    );
    const f = findingsOf(runOne("PX15", { ...input, data: { ...input.data, campaigns } }))[0];
    if (f) expect(f.rows?.map((x) => x.entity.id).sort()).toEqual(["sku-3", "sku-4", "sku-5"]);
  });
  it("a live Shopping campaign whose product rows were not read: no left-out list", () => {
    const input = withSecond();
    const rows = (input.tables?.pmax_campaign_products ?? []).map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => k !== "channel")),
    );
    const r = runOne("PX15", {
      ...input,
      tables: { ...input.tables, pmax_campaign_products: rows },
    });
    expect(r).toMatchObject({ state: "not_checkable", category: "our_gap" });
    expect(r.state === "not_checkable" ? r.reason : "").toMatch(/Product campaign/);
  });
  it("R11: the other campaign covers only from the same Merchant Center account and feed label", () => {
    const same = findingsOf(
      runOne("PX15", withSecond({ merchant_id: "900", feed_label: "us" })),
    )[0];
    expect(same?.rows?.map((x) => x.entity.id)).toEqual(["sku-5"]);
    const otherMerchant = findingsOf(
      runOne("PX15", withSecond({ merchant_id: "901", feed_label: "" })),
    )[0];
    expect(otherMerchant?.rows?.map((x) => x.entity.id).sort()).toEqual([
      "sku-3",
      "sku-4",
      "sku-5",
    ]);
    const otherLabel = findingsOf(
      runOne("PX15", withSecond({ merchant_id: "900", feed_label: "CA" })),
    )[0];
    expect(otherLabel?.rows?.map((x) => x.entity.id).sort()).toEqual(["sku-3", "sku-4", "sku-5"]);
    expect(otherLabel?.facts.selling_products_advertised_by_another_live_campaign).toBe(0);
  });
  // round 3 (bug A): campaign 42 shows COPIES of the items ("<item id>-<suffix>", a second
  // feed with its own feed label), or pairs seen only in the last 7 days
  const withCopies = (
    rows: Array<{ offer: string; imp7d?: number; window?: boolean; campaign?: string }>,
    settings: { merchant_id: string; feed_label: string } = {
      merchant_id: "900",
      feed_label: "us_second",
    },
    type = "SHOPPING",
  ): EvidenceInput => {
    const input = withSecond(settings, type);
    const row = (r: (typeof rows)[number]) => ({
      campaign_id: r.campaign ?? "42",
      offer_id: r.offer,
      product_title: `Trail shoe ${r.offer}`,
      channel: type === "SHOPPING" ? "SHOPPING" : "PERFORMANCE_MAX",
      ...(r.window === false
        ? {}
        : {
            cost_micros: 5_000_000,
            clicks: 6,
            impressions: 15_106,
            conversions: 0,
            conversions_value: 0,
          }),
      ...(r.imp7d === undefined ? {} : { impressions_7d: r.imp7d }),
    });
    return {
      ...input,
      tables: {
        ...input.tables,
        pmax_campaign_products: [
          ...(input.tables?.pmax_campaign_products ?? []).filter(
            (r) => String(r.campaign_id) !== "42",
          ),
          ...rows.map(row),
        ],
      },
    };
  };
  const leftOut = (input: EvidenceInput) =>
    findingsOf(runOne("PX15", input))[0]
      ?.rows?.map((x) => x.entity.id)
      .sort();
  it("round 3: copies of the items in a live Shopping campaign with 7-day impressions cover them, whatever their feed label", () => {
    const input = withCopies([
      { offer: "sku-3-gao0a1m0", imp7d: 7_710 },
      { offer: "SKU-4-cp-round", imp7d: 2_854 },
    ]);
    const f = findingsOf(runOne("PX15", input))[0];
    expect(f?.rows?.map((x) => x.entity.id)).toEqual(["sku-5"]);
    expect(f?.facts.selling_products_advertised_by_another_live_campaign).toBe(2);
    expect(f?.facts.selling_products_shown_as_copy_elsewhere).toBe(2);
    // the same rows under the original item ids are judged on the feed label: no cover
    expect(leftOut(withCopies([{ offer: "sku-3", imp7d: 7_710 }]))).toEqual([
      "sku-3",
      "sku-4",
      "sku-5",
    ]);
  });
  it("round 3: a copy in a paused campaign, with no 7-day impressions, or in the campaign's own rows does not cover", () => {
    const paused = withCopies([{ offer: "sku-3-gao0a1m0", imp7d: 7_710 }]);
    const campaigns = (paused.data.campaigns ?? []).map((c) =>
      String(c.campaign_id ?? c.id) === "42" ? { ...c, status: "PAUSED" } : c,
    );
    const r = runOne("PX15", { ...paused, data: { ...paused.data, campaigns } });
    const f = findingsOf(r)[0];
    expect(f?.rows?.map((x) => x.entity.id).sort()).toEqual(["sku-3", "sku-4", "sku-5"]);
    expect(leftOut(withCopies([{ offer: "sku-3-gao0a1m0", imp7d: 0 }]))).toEqual([
      "sku-3",
      "sku-4",
      "sku-5",
    ]);
    expect(
      leftOut(withCopies([{ offer: "sku-3-gao0a1m0", imp7d: 7_710, campaign: "41" }])),
    ).toEqual(["sku-3", "sku-4", "sku-5"]);
  });
  it("round 3: an id that only shares a prefix without a '-' is another item, never a copy", () => {
    expect(
      leftOut(
        withCopies([
          { offer: "sku-30", imp7d: 500 },
          { offer: "sku-4x-gao0a1m0", imp7d: 500 },
        ]),
      ),
    ).toEqual(["sku-3", "sku-4", "sku-5"]);
  });
  it("round 3: a copy in another Merchant Center account does not cover", () => {
    expect(
      leftOut(
        withCopies([{ offer: "sku-3-gao0a1m0", imp7d: 7_710 }], {
          merchant_id: "901",
          feed_label: "us_second",
        }),
      ),
    ).toEqual(["sku-3", "sku-4", "sku-5"]);
  });
  it("round 3: a copy whose 7-day count was not read is unknown: not_checkable naming the campaign", () => {
    const r = runOne("PX15", withCopies([{ offer: "sku-3-gao0a1m0" }]));
    expect(r).toMatchObject({ state: "not_checkable", category: "our_gap" });
    expect(r.state === "not_checkable" ? r.reason : "").toMatch(/Product campaign/);
  });
  it("round 3: a pair seen only in the last 7 days (no row over the window) covers, with no money", () => {
    for (const type of ["SHOPPING", "PERFORMANCE_MAX"]) {
      const input = withCopies(
        [
          { offer: "sku-3", imp7d: 120, window: false },
          { offer: "sku-4-gao0a1m0", imp7d: 80, window: false },
        ],
        { merchant_id: "900", feed_label: "us" },
        type,
      );
      const f = findingsOf(runOne("PX15", input))[0];
      expect(f?.rows?.map((x) => x.entity.id)).toEqual(["sku-5"]);
      expect(f?.facts.selling_products_shown_as_copy_elsewhere).toBe(1);
    }
    // a 7-day-only pair is never a money row of the campaign
    const model = checkCtxOf(
      withCopies([{ offer: "sku-3", imp7d: 120, window: false }], {
        merchant_id: "900",
        feed_label: "us",
      }),
    );
    const perf = model.model.children.campaigns.find((c) => c.id === "42")?.attrs.productPerf;
    expect(perf?.state === "synced" ? perf.rows.map((r) => r.offerId) : null).toEqual([]);
    expect(perf?.state === "synced" ? perf.recentOnly : null).toEqual([
      { offerId: "sku-3", productId: "sku-3", impressions7d: 120 },
    ]);
  });
  // review fix: campaign 41 sells feed label "us" only; `patch` rewrites a product's feed rows
  const feedPatched = (patch: Record<string, Row>): EvidenceInput => {
    const base = three(["ENABLED", "PAUSED", "PAUSED"]);
    const fix = (rows: Row[] | undefined): Row[] | undefined =>
      rows?.map((r) => {
        const id = String(r.product_id ?? r.item_id ?? "");
        return r.offer_id === undefined && patch[id] ? { ...r, ...patch[id] } : r;
      });
    const data = Object.fromEntries(
      Object.entries(base.data).map(([k, v]) => [k, Array.isArray(v) ? fix(v as Row[]) : v]),
    ) as EvidenceInput["data"];
    const tables = Object.fromEntries(
      Object.entries(base.tables ?? {}).map(([k, v]) => [k, fix(v)]),
    ) as EvidenceInput["tables"];
    return {
      ...base,
      data: {
        ...data,
        shoppingSettings: (data.shoppingSettings ?? []).map((s) =>
          String(s.campaign_id) === "41" ? { ...s, feed_label: "us" } : s,
        ),
      },
      tables,
    };
  };
  it("review fix: an item only in a feed label the campaign does not sell is not left out; an unknown label stays", () => {
    const f = findingsOf(
      runOne(
        "PX15",
        feedPatched({ "sku-3": { feed_label: "US_SECOND" }, "sku-4": { feed_label: null } }),
      ),
    )[0];
    expect(f?.rows?.map((x) => x.entity.id).sort()).toEqual(["sku-4", "sku-5"]);
    expect(f?.facts.selling_products_in_a_feed_this_campaign_does_not_sell).toBe(1);
    expect(f?.facts.selling_products_selected_by_switched_off).toBe(3);
    expect(f?.note).toMatch(/1 selling product\(s\).*feed label/);
  });
  it("review fix: an item sold out in every feed the campaign sells is not left out; stock not read stays", () => {
    const f = findingsOf(
      runOne(
        "PX15",
        feedPatched({
          "sku-3": { availability: "OUT_OF_STOCK" },
          "sku-4": { availability: "IN_STOCK" },
        }),
      ),
    )[0];
    expect(f?.rows?.map((x) => x.entity.id).sort()).toEqual(["sku-4", "sku-5"]);
    expect(f?.facts.selling_products_sold_out).toBe(1);
    expect(f?.facts.selling_products_in_a_feed_this_campaign_does_not_sell).toBe(0);
  });
  // round 2 (NEW-2): the running group takes custom label 1 "jackets" only, and within it
  // sku-1 and sku-2 by item id; sku-3 and sku-4 are belts (label "belts"), sku-5 a jacket
  const labelled = (belts: string[]): { products: ProductSpec[]; running: Row[] } => {
    const label = (key: object) => JSON.stringify({ productCustomAttribute: key });
    const at = (id: string, type: string, caseValue: string, parent?: string): Row => ({
      asset_group_id: "51",
      listing_group_id: id,
      parent_listing_group_id: parent ?? null,
      type,
      case_value: caseValue,
    });
    return {
      products: PRODUCTS.map((p) => ({
        ...p,
        labels: ["core", belts.includes(p.id) ? "belts" : "jackets"],
      })),
      running: [
        at("10", "SUBDIVISION", "{}"),
        at("11", "SUBDIVISION", label({ index: "INDEX1", value: "jackets" }), "10"),
        at("12", "UNIT_INCLUDED", JSON.stringify({ productItemId: { value: "sku-1" } }), "11"),
        at("13", "UNIT_INCLUDED", JSON.stringify({ productItemId: { value: "sku-2" } }), "11"),
        at("14", "UNIT_EXCLUDED", JSON.stringify({ productItemId: {} }), "11"),
        at("15", "UNIT_EXCLUDED", label({ index: "INDEX1" }), "10"),
      ],
    };
  };
  it("round 2 review: switched-off groups picked them by item id, the running group splits on a label = left out, nothing set aside", () => {
    const f = findingsOf(
      runOne("PX15", three(["ENABLED", "PAUSED", "PAUSED"], false, labelled(["sku-3", "sku-4"]))),
    )[0];
    expect(f?.rows?.map((x) => x.entity.id).sort()).toEqual(["sku-3", "sku-4", "sku-5"]);
    expect(f?.facts.selling_products_left_out).toBe(3);
    expect(f?.facts).not.toHaveProperty("selling_products_outside_running_selection");
  });
  // running group 51 takes custom label 1 "jackets"; switched-off 52 took "belts", 53 "bags",
  // on custom label 0 (different label) or custom label 1 (same label)
  const beltsBags = (offIndex: "INDEX0" | "INDEX1", shownBy?: "41" | "42"): EvidenceInput => {
    const label = (key: object) => JSON.stringify({ productCustomAttribute: key });
    const at = (group: string, id: string, type: string, caseValue: string, parent?: string) => ({
      asset_group_id: group,
      listing_group_id: id,
      parent_listing_group_id: parent ?? null,
      type,
      case_value: caseValue,
    });
    const byLabel = (group: string, n: number, index: string, value: string): Row[] => [
      at(group, `${n}`, "SUBDIVISION", "{}"),
      at(group, `${n + 1}`, "UNIT_INCLUDED", label({ index, value }), `${n}`),
      at(group, `${n + 2}`, "UNIT_EXCLUDED", label({ index }), `${n}`),
    ];
    const kind: Record<string, string> = { "sku-3": "belts", "sku-4": "belts", "sku-5": "bags" };
    const base = three(["ENABLED", "PAUSED", "PAUSED"], false, {
      products: PRODUCTS.map((p) => {
        const k = kind[p.id] ?? "jackets";
        return { ...p, labels: offIndex === "INDEX0" ? [k, k] : ["core", k] };
      }),
      running: byLabel("51", 10, "INDEX1", "jackets"),
      off: [...byLabel("52", 30, offIndex, "belts"), ...byLabel("53", 50, offIndex, "bags")],
    });
    if (!shownBy) return base;
    // a second live Performance Max campaign "42" with no tree for them showed them in the window
    const campaigns = base.data.campaigns ?? [];
    const pmax = campaigns.find((c) => String(c.campaign_id ?? c.id) === "41") ?? {};
    const second = { ...pmax, campaign_id: "42", id: "42", name: "Second campaign" };
    const daily = (base.data.campaignDailyMetrics ?? [])
      .filter((d) => String(d.campaign_id) === "41")
      .map((d) => ({ ...d, campaign_id: "42" }));
    const shown = (offer: string) => ({
      campaign_id: shownBy,
      offer_id: offer,
      product_title: `Trail shoe ${offer}`,
      cost_micros: 24_000_000,
      clicks: 14,
      impressions: 1_188,
      impressions_7d: 96,
      conversions: 1,
      conversions_value: 119,
      channel: "PERFORMANCE_MAX",
    });
    return {
      ...base,
      data: {
        ...base.data,
        campaigns: [...campaigns, second],
        campaignDailyMetrics: [...(base.data.campaignDailyMetrics ?? []), ...daily],
      },
      tables: {
        ...base.tables,
        pmax_campaign_products: [
          ...(base.tables?.pmax_campaign_products ?? []),
          ...["sku-3", "sku-4", "sku-5"].map(shown),
        ],
      },
    };
  };
  it("round 2 review: switched-off groups picked them by a DIFFERENT label (cl0 belts, bags) than the running one (cl1 jackets) = left out", () => {
    const f = findingsOf(runOne("PX15", beltsBags("INDEX0")))[0];
    expect(f?.rows?.map((x) => x.entity.id).sort()).toEqual(["sku-3", "sku-4", "sku-5"]);
    expect(f?.facts.selling_products_left_out).toBe(3);
  });
  it("round 2 review: switched-off groups picked them by the SAME label (cl1 belts, bags) = left out", () => {
    const f = findingsOf(runOne("PX15", beltsBags("INDEX1")))[0];
    expect(f?.rows?.map((x) => x.entity.id).sort()).toEqual(["sku-3", "sku-4", "sku-5"]);
  });
  it("round 2 review: another live Performance Max campaign showed them in the last 7 days = covered, clean, fact only in the note", () => {
    const r = runOne("PX15", beltsBags("INDEX0", "42"));
    expect(state(r)).toBe("none_found");
    const note = r.state === "none_found" ? (r.note ?? "") : "";
    expect(note).toMatch(/3 selling product\(s\) through another live campaign/);
    expect(note).not.toMatch(/by choice|outside what the running groups select/);
    // the campaign's own rows are not cover
    expect(state(runOne("PX15", beltsBags("INDEX0", "41")))).toBe("fires");
  });
  it("is not run when the product list was cut", () => {
    expect(runOne("PX15", three(["ENABLED", "PAUSED", "PAUSED"], true))).toMatchObject({
      state: "not_checkable",
      category: "our_gap",
    });
  });
});

// round 2 re-review: a big live label tree's shape, anonymised: label 0 -> label 1 -> model
// (label 2) -> colour (label 3) -> item id, an "everything else" node at every level
describe("a deep multi-level label tree is read the way Google applies it", () => {
  const node = (id: string, parent: string | null, type: string, caseValue: object | null) => ({
    asset_group_id: "51",
    listing_group_id: id,
    parent_listing_group_id: parent,
    type,
    case_value: caseValue == null ? null : JSON.stringify(caseValue),
  });
  const cl = (index: number, value?: string) => ({
    productCustomAttribute: { index: `INDEX${index}`, ...(value ? { value } : {}) },
  });
  const tree = [
    node("1", null, "SUBDIVISION", null),
    node("10", "1", "SUBDIVISION", cl(0, "seller_x")),
    node("11", "10", "SUBDIVISION", cl(1, "classic")),
    node("12", "11", "UNIT_INCLUDED", cl(2, "model_a")),
    node("13", "11", "UNIT_EXCLUDED", cl(2, "model_b")),
    node("14", "11", "UNIT_EXCLUDED", cl(2)),
    node("15", "10", "UNIT_EXCLUDED", cl(1)),
    node("20", "1", "SUBDIVISION", cl(0, "bestseller")),
    node("21", "20", "SUBDIVISION", cl(1, "studded")),
    node("22", "21", "SUBDIVISION", cl(2, "model_c")),
    node("23", "22", "SUBDIVISION", cl(3, "black")),
    node("24", "23", "UNIT_EXCLUDED", { productItemId: { value: "sku_us_91_1" } }),
    node("25", "23", "UNIT_INCLUDED", { productItemId: {} }),
    node("26", "22", "UNIT_EXCLUDED", cl(3, "brown")),
    node("27", "22", "UNIT_INCLUDED", cl(3)),
    node("28", "21", "UNIT_EXCLUDED", cl(2)),
    node("30", "20", "SUBDIVISION", cl(1, "wide")),
    node("31", "30", "SUBDIVISION", cl(2, "model_d")),
    node("32", "31", "UNIT_EXCLUDED", { productItemId: { value: "sku_us_91_9" } }),
    node("33", "31", "UNIT_EXCLUDED", { productItemId: {} }),
    node("34", "20", "UNIT_EXCLUDED", cl(1)),
    node("40", "1", "UNIT_EXCLUDED", cl(0)),
  ];
  const feed = (id: string, l: Array<string | null>) => ({
    product_id: id,
    custom_label_0: l[0],
    custom_label_1: l[1],
    custom_label_2: l[2],
    custom_label_3: l[3],
  });
  it("includes exactly the products an included path selects, at every depth", () => {
    const items = catalogItemsOf([
      feed("sku_US_91_2", ["seller_x", "classic", "model_a", "tan"]), // in
      feed("sku_US_91_3", ["seller_x", "classic", "model_b", "tan"]), // model excluded
      feed("sku_US_91_4", ["seller_x", "wide", "model_a", "tan"]), // label 1 everything else
      feed("sku_US_91_5", ["Bestseller", "Studded", "Model_C", "Black"]), // case differs: in
      feed("sku_US_91_1", ["bestseller", "studded", "model_c", "black"]), // item excluded by id
      feed("sku_US_91_6", ["bestseller", "studded", "model_c", "grey"]), // colour everything else: in
      feed("sku_US_91_7", ["bestseller", "studded", "model_c", "brown"]), // colour excluded
      feed("sku_US_91_8", ["bestseller", "wide", "model_d", "black"]), // item everything else excluded
      feed("sku_US_91_10", [null, null, null, null]), // label 0 everything else
    ]);
    const inTree = [...includedByListingTree(tree, items)].map((p) => p.id).sort();
    expect(inTree).toEqual(["sku_us_91_2", "sku_us_91_5", "sku_us_91_6"]);
  });
});

// ---------------------------------------------------------------------------
// Countries and languages
// ---------------------------------------------------------------------------

describe("SL03 a country returning below the account", () => {
  const two = (caValue: number) =>
    shoppingAccount({
      countries: [
        country("11", "2840", "US", 1_200, { clicks: 600 }),
        country("11", "2124", "CA", 600, { clicks: 300, value: caValue }),
      ],
    });
  it("fires on a country under half the account's return", () => {
    const r = runOne("SL03", two(300));
    expect(findingsOf(r).some((f) => f.scope.name === "Canada")).toBe(true);
  });
  it("is clean when the countries return alike, and not run with one country", () => {
    expect(state(runOne("SL03", two(3_000)))).toBe("none_found");
    const one = shoppingAccount({ countries: [country("11", "2840", "US", 1_200)] });
    expect(runOne("SL03", one)).toMatchObject({ category: "nothing_to_compare" });
  });
  it("is not run when the country rows were not read", () => {
    expect(status(failed(two(300), "geo_countries"), "SL03")).toBe("not_run");
  });
});

describe("SL10 one campaign serving several countries", () => {
  it("fires on a campaign with two countries over the bar", () => {
    const input = shoppingAccount({
      countries: [country("11", "2840", "US", 900), country("11", "2124", "CA", 600)],
    });
    expect(findingsOf(runOne("SL10", input))[0]?.rows?.map((x) => x.entity.name)).toEqual([
      "United States",
      "Canada",
    ]);
  });
  it("a country row of a campaign the account does not hold leaves it not clean", () => {
    const input = shoppingAccount({
      countries: [country("11", "2840", "US", 900), country("99", "2124", "CA", 600)],
    });
    expect(status(input, "SL10")).toBe("not_run");
  });
  it("counts only where people were, not interest rows", () => {
    const input = shoppingAccount({
      countries: [
        country("11", "2840", "US", 900),
        country("11", "2124", "CA", 600, { type: "AREA_OF_INTEREST" }),
      ],
    });
    expect(state(runOne("SL10", input))).toBe("none_found");
  });
});

describe("SL11 spend in countries the shop does not sell to", () => {
  it("fires on a Shopping campaign spending outside its feed-label country with no sale", () => {
    const input = shoppingAccount({
      countries: [
        country("71", "2124", "CA", 500),
        country("71", "2276", "DE", 200, { conv: 0, value: 0 }),
      ],
    });
    const r = runOne("SL11", input);
    expect(findingsOf(r)[0]?.rows?.[0]?.entity.name).toBe("Country DE");
  });
  it("is clean when every country with spend is a feed-label country", () => {
    expect(
      state(runOne("SL11", shoppingAccount({ countries: [country("71", "2124", "CA", 500)] }))),
    ).toBe("none_found");
  });
  it("counts the products' own country feeds as countries the shop sells to", () => {
    // the Shopping campaign sells CA; the PMax campaign (every product) sells the US feed
    const us = shoppingAccount({ countries: [country("41", "2840", "US", 500, { conv: 0 })] });
    expect(state(runOne("SL11", us))).toBe("none_found");
    const products = [...PRODUCTS, ...PRODUCTS.map((p) => ({ ...p, feedLabel: "DE" }))];
    const de = [country("41", "2276", "DE", 500, { conv: 0, value: 0 })];
    expect(state(runOne("SL11", shoppingAccount({ countries: de })))).toBe("fires");
    expect(state(runOne("SL11", shoppingAccount({ countries: de, products })))).toBe("none_found");
  });
  it("is not run when a feed label names no country (WEB, ONLINE, DE_DE, EU)", () => {
    const de = [country("41", "2276", "DE", 500, { conv: 0, value: 0 })];
    for (const label of ["WEB", "ONLINE", "DE_DE", "EU"]) {
      const products = PRODUCTS.map((p) => ({ ...p, feedLabel: label }));
      const r = runOne("SL11", shoppingAccount({ countries: de, products }));
      expect([label, r]).toMatchObject([
        label,
        { state: "not_checkable", category: "incomplete_data" },
      ]);
      expect(r.state === "not_checkable" ? r.reason : "").toContain(`"${label}"`);
    }
    // "UK" is Google's name for GB: a country
    const uk = PRODUCTS.map((p) => ({ ...p, feedLabel: "UK" }));
    expect(state(runOne("SL11", shoppingAccount({ countries: de, products: uk })))).toBe("fires");
  });
  it("is not run when no feed label names a country", () => {
    const base = shoppingAccount();
    const blank = (rows: Row[] | undefined) => (rows ?? []).map((r) => ({ ...r, feed_label: "" }));
    const data = {
      ...base.data,
      shoppingSettings: blank(base.data.shoppingSettings),
      products: blank(base.data.products),
      shoppingProductsData: blank(base.data.shoppingProductsData),
    };
    expect(runOne("SL11", { ...base, data })).toMatchObject({ category: "not_present" });
  });
  it("is not run when a campaign sells every product and the product list was not read in full", () => {
    const de = [country("41", "2276", "DE", 500, { conv: 0, value: 0 })];
    const base = shoppingAccount({ countries: de });
    const cut = { ...base, caps: { ...base.caps, shoppingProductsData: PRODUCTS.length } };
    expect(runOne("SL11", cut)).toMatchObject({
      state: "not_checkable",
      category: "incomplete_data",
    });
    expect(status(failed(base, "shopping_products"), "SL11")).toBe("not_run");
  });
});

describe("SL12 campaign language against the products' language", () => {
  it("fires on a campaign targeting only another language", () => {
    const input = shoppingAccount({
      campaignLanguages: [
        { campaign_id: "71", criterion_id: "1", language_code: "de", status: "ENABLED" },
      ],
    });
    expect(findingsOf(runOne("SL12", input))[0]?.scope.id).toBe("71");
  });
  it("is clean when campaigns target the products' language or every language", () => {
    expect(state(runOne("SL12", shoppingAccount()))).toBe("none_found");
  });
  // R12: a shop's German brand campaign targets German and lands on its .de site,
  // while the products' language comes from the Dutch feed
  const brandDe = (url: string): EvidenceInput => {
    const base = shoppingAccount({
      campaignLanguages: [
        { campaign_id: "71", criterion_id: "1", language_code: "en", status: "ENABLED" },
        { campaign_id: "11", criterion_id: "2", language_code: "de", status: "ENABLED" },
      ],
    });
    return {
      ...base,
      data: {
        ...base.data,
        adGroups: [
          {
            ad_group_id: "21",
            campaign_id: "11",
            name: "Brand",
            status: "ENABLED",
            type: "SEARCH_STANDARD",
          },
        ],
        ads: [
          {
            ad_id: "81",
            ad_group_id: "21",
            campaign_id: "11",
            type: "RESPONSIVE_SEARCH_AD",
            status: "ENABLED",
            final_urls: [url],
          },
        ],
      },
    };
  };
  it("R12: a campaign whose ads land on a site in its own language is a match", () => {
    expect(state(runOne("SL12", brandDe("https://brandshop.de/")))).toBe("none_found");
    expect(state(runOne("SL12", brandDe("https://shop.example/de-at/guertel")))).toBe("none_found");
  });
  it("R12: an ad on a site whose language cannot be told keeps the finding", () => {
    const f = findingsOf(runOne("SL12", brandDe("https://brandshop.eu/")))[0];
    expect(f?.scope.id).toBe("11");
  });
  it("R12: reads the site language from a path, a subdomain or a one-language country domain", () => {
    expect(siteLanguageOf("https://brandshop.de/")).toBe("de");
    expect(siteLanguageOf("https://brandshop.nl/collections/riemen")).toBe("nl");
    expect(siteLanguageOf("https://shop.example/fr/")).toBe("fr");
    expect(siteLanguageOf("https://de.shop.example/")).toBe("de");
    expect(siteLanguageOf("https://shop.co.uk/")).toBe("en");
    expect(siteLanguageOf("https://brandshop.eu/")).toBeNull();
    expect(siteLanguageOf("https://shop.ch/")).toBeNull();
    expect(siteLanguageOf("not a url")).toBeNull();
  });
  it("is not run when one campaign's language code was not read, even if others match", () => {
    const input = shoppingAccount({
      campaignLanguages: [
        { campaign_id: "71", criterion_id: "1", language_code: "en", status: "ENABLED" },
        { campaign_id: "41", criterion_id: "2", language_code: null, status: "ENABLED" },
      ],
    });
    expect(state(runOne("SL12", input))).toBe("not_checkable");
  });
  it("is not run when a language code was not read", () => {
    const input = shoppingAccount({
      campaignLanguages: [
        { campaign_id: "71", criterion_id: "1", language_code: null, status: "ENABLED" },
        { campaign_id: "41", criterion_id: "2", language_code: null, status: "ENABLED" },
        { campaign_id: "11", criterion_id: "3", language_code: null, status: "ENABLED" },
      ],
    });
    expect(state(runOne("SL12", input))).toBe("not_checkable");
  });
});

// ---------------------------------------------------------------------------
// Local Services
// ---------------------------------------------------------------------------

describe("Local Services (PR03-PR07)", () => {
  it("PR03 states the leads as info", () => {
    expect(status(lsaAccount(), "PR03")).toBe("info");
  });
  it("every check is not present without a Local Services campaign", () => {
    const r = runChecks(lsaAccount({ campaigns: [{ id: "11", name: "Generic search" }] }));
    for (const id of ["PR03", "PR04", "PR05", "PR06", "PR07"])
      expect([id, r.checks.find((c) => c.id === id)?.category]).toEqual([id, "not_present"]);
  });
  it("PR04 fires on a drop, is clean when steady, and needs enough prior leads", () => {
    const drop = lsaAccount({ leads: [...leads(5), ...leads(20, { from: 30, prefix: "6" })] });
    expect(findingsOf(runOne("PR04", drop))[0]?.facts.lsa_leads_last_30d).toBe(5);
    expect(state(runOne("PR04", lsaAccount()))).toBe("none_found");
    expect(state(runOne("PR04", lsaAccount({ leads: leads(5) })))).toBe("insufficient_data");
  });
  it("a Performance Max campaign with Local Services on counts as a Local Services campaign", () => {
    const pmax = (on: boolean) =>
      lsaAccount({
        campaigns: [
          {
            id: "41",
            name: "PMax local",
            type: "PERFORMANCE_MAX",
            ...(on ? { extra: { local_services_enabled: true } } : {}),
          },
        ],
      });
    expect(state(runOne("PR04", pmax(true)))).toBe("none_found");
    expect(runOne("PR04", pmax(false))).toMatchObject({ category: "not_present" });
  });
  it("PR04 is not run on a window shorter than the 60 days it compares", () => {
    const short = lsaAccount({
      campaigns: [
        { ...LSA_CAMPAIGN, days: 45 },
        { id: "11", name: "Generic search", days: 45 },
      ],
      leads: [...leads(5), ...leads(20, { from: 30, prefix: "6" })],
    });
    expect(runOne("PR04", short)).toMatchObject({
      state: "not_checkable",
      category: "nothing_to_compare",
    });
  });
  it("PR04 is not run when the leads read stop short of 60 days (cut at the row limit)", () => {
    const input = { ...lsaAccount({ leads: leads(40) }), caps: { lsaLeads: 40 } };
    expect(runOne("PR04", input)).toMatchObject({
      state: "not_checkable",
      category: "incomplete_data",
    });
  });
  it("PR05 fires on a high disputed share", () => {
    const disputed = lsaAccount({
      leads: [...leads(10), ...leads(10, { from: 10, credit: "CREDITED", prefix: "5" })],
    });
    expect(findingsOf(runOne("PR05", disputed))[0]?.facts.lsa_leads_credited).toBe(10);
    expect(state(runOne("PR05", lsaAccount()))).toBe("none_found");
  });
  it("PR06 fires on missed or short calls, and is not run with no durations", () => {
    const missed = lsaAccount({ conversations: [...calls(10, 60_000), ...calls(10, null, "9")] });
    expect(findingsOf(runOne("PR06", missed))[0]?.facts.lsa_answer_rate_pct).toBe(50);
    expect(state(runOne("PR06", lsaAccount()))).toBe("none_found");
    expect(runOne("PR06", lsaAccount({ conversations: calls(12, null) }))).toMatchObject({
      category: "our_gap",
    });
  });
  it("PR07 fires on a licence running out within the bar", () => {
    const soon = lsaAccount({
      verifications: [
        {
          artifact_id: "5",
          artifact_type: "LICENSE",
          status: "PASSED",
          license_type: "PLUMBER",
          license_expiry: "2026-09-15 00:00:00",
          insurance_expiry: null,
        },
      ],
    });
    expect(findingsOf(runOne("PR07", soon))[0]?.facts.lsa_soonest_days_left).toBe(14);
    expect(state(runOne("PR07", lsaAccount()))).toBe("none_found");
  });
  it("is not run when the leads were not read", () => {
    const input = failed(lsaAccount(), "lsa_leads");
    expect([status(input, "PR04"), status(input, "PR05")]).toEqual(["not_run", "not_run"]);
  });
});

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

describe("Video (VD01-VD07)", () => {
  it("VD01 fires on a low view rate, and the bar is a setting", () => {
    expect(state(runOne("VD01", videoAccount({ viewRate: 0.08 })))).toBe("fires");
    expect(state(runOne("VD01", videoAccount()))).toBe("none_found");
    const strict = videoAccount({ settings: { video: { viewRateMin: 0.3 } } });
    expect(state(runOne("VD01", strict))).toBe("fires");
  });
  it("VD01 has no verdict under the impressions floor", () => {
    const thin = videoAccount({
      viewRate: 0.05,
      settings: { video: { minImpressions: 1_000_000 } },
    });
    expect(state(runOne("VD01", thin))).toBe("insufficient_data");
  });
  it("VD02 fires on a steep drop between the quartiles", () => {
    expect(
      findingsOf(runOne("VD02", videoAccount({ q25: 0.8, q100: 0.1 })))[0]?.facts.dropoff,
    ).toBe(0.7);
    expect(state(runOne("VD02", videoAccount()))).toBe("none_found");
  });
  it("VD04 fires when view-through carries the conversions", () => {
    expect(state(runOne("VD04", videoAccount({ viewThrough: { vt: 15, conv: 5 } })))).toBe("fires");
    expect(state(runOne("VD04", videoAccount()))).toBe("none_found");
  });
  it("VD07 fires outside the cost-per-view band, either side", () => {
    expect(findingsOf(runOne("VD07", videoAccount({ cpv: 0.09 })))[0]?.facts.side).toBe("above");
    expect(findingsOf(runOne("VD07", videoAccount({ cpv: 0.002 })))[0]?.facts.side).toBe("below");
    expect(state(runOne("VD07", videoAccount()))).toBe("none_found");
  });
  it("VD03, VD05 and VD06 are not run: what they need is not read", () => {
    for (const id of ["VD03", "VD05", "VD06"])
      expect([id, runOne(id, videoAccount())]).toMatchObject([id, { category: "our_gap" }]);
  });
  it("the view checks are not run when the view numbers were not read", () => {
    const input = videoAccount({ metricsRows: null });
    for (const id of ["VD01", "VD02", "VD07"])
      expect([id, status(input, id)]).toEqual([id, "not_run"]);
  });
  it("every check is not present without a Video campaign", () => {
    const r = runChecks(lsaAccount());
    for (const id of ["VD01", "VD02", "VD03", "VD04", "VD05", "VD06", "VD07"])
      expect([id, r.checks.find((c) => c.id === id)?.category]).toEqual([id, "not_present"]);
  });
});

// ---------------------------------------------------------------------------
// Demand Gen
// ---------------------------------------------------------------------------

describe("Demand Gen (DG01-DG04, DG06)", () => {
  it("DG01 fires with no override and no biddable goal", () => {
    const input = demandGenAccount({
      goals: [
        { campaign_id: "61", category: "PURCHASE", origin: "WEBSITE", biddable: false },
        { campaign_id: "11", category: "PURCHASE", origin: "WEBSITE", biddable: true },
      ],
    });
    expect(findingsOf(runOne("DG01", input))[0]?.scope.id).toBe("61");
    expect(state(runOne("DG01", demandGenAccount()))).toBe("none_found");
  });
  it("DG01 is not run when neither route was read", () => {
    expect(runOne("DG01", demandGenAccount({ goals: [] }))).toMatchObject({ category: "our_gap" });
  });
  it("DG02 fires on a short asset set, and the minimums are settings", () => {
    const short = demandGenAccount({
      assets: [...dgAsset("HEADLINE", 1), ...dgAsset("MARKETING_IMAGE", 3)],
    });
    expect(findingsOf(runOne("DG02", short))[0]?.facts.gaps).toEqual({
      headlines: 2,
      descriptions: 2,
    });
    expect(state(runOne("DG02", demandGenAccount()))).toBe("none_found");
    const strict = demandGenAccount({
      checkSettings: { demandGen: { minHeadlines: 5, minDescriptions: 5 } },
    });
    expect(state(runOne("DG02", strict))).toBe("none_found");
    const stricter = demandGenAccount({
      assets: DG_FULL_ASSETS.filter((a) => a.field_type !== "DESCRIPTION"),
    });
    expect(state(runOne("DG02", stricter))).toBe("fires");
  });
  it("DG03 fires on a spending campaign with no audience", () => {
    expect(state(runOne("DG03", demandGenAccount({ signals: [] })))).toBe("fires");
    expect(state(runOne("DG03", demandGenAccount()))).toBe("none_found");
  });
  it("DG04 fires when one surface holds the campaign", () => {
    const one = demandGenAccount({
      channels: [dgChannel("YOUTUBE", 1_900), dgChannel("DISCOVER", 100)],
    });
    expect(findingsOf(runOne("DG04", one))[0]?.facts.surface).toBe("YOUTUBE");
    expect(state(runOne("DG04", demandGenAccount()))).toBe("none_found");
  });
  it("DG04 skips a campaign set to one surface (B12: Discover only, YouTube Shorts only)", () => {
    const discoverOnly = demandGenAccount({
      channels: [dgChannel("DISCOVER", 1_900), dgChannel("YOUTUBE", 100)],
      controls: [dgControl(["discover"])],
    });
    expect(state(runOne("DG04", discoverOnly))).not.toBe("fires");
    const shortsOnly = demandGenAccount({
      channels: [dgChannel("YOUTUBE", 1_900), dgChannel("DISCOVER", 100)],
      controls: [dgControl(["youtubeShorts"]), dgControl(["youtubeInFeed"], { adGroupId: "612" })],
    });
    // every YouTube format is one surface
    expect(state(runOne("DG04", shortsOnly))).not.toBe("fires");
    // N9 (a live shop: RT Shorts only, Listicle D Discover only): filed as nothing to compare,
    // never as thin traffic
    expect(runOne("DG04", discoverOnly)).toMatchObject({
      state: "not_checkable",
      category: "nothing_to_compare",
    });
    expect(runChecks(shortsOnly).checks.find((c) => c.id === "DG04")).toMatchObject({
      status: "not_run",
      category: "nothing_to_compare",
    });
  });
  it("DG04 measures inside the allowed surfaces; mixed controls still fire", () => {
    // Discover + YouTube allowed: YouTube holds 95% of the allowed spend (Gmail is outside)
    const mixed = demandGenAccount({
      channels: [
        dgChannel("YOUTUBE", 1_900),
        dgChannel("DISCOVER", 100),
        dgChannel("GMAIL", 5_000),
      ],
      controls: [dgControl(["discover"]), dgControl(["youtubeInFeed"], { adGroupId: "612" })],
    });
    const f = findingsOf(runOne("DG04", mixed))[0];
    expect(f?.facts.surface).toBe("YOUTUBE");
    expect(f?.facts.allowed_surfaces).toBe("DISCOVER, YOUTUBE");
    // a paused ad group's controls do not widen where the campaign may show
    const paused = demandGenAccount({
      channels: [dgChannel("DISCOVER", 1_900), dgChannel("YOUTUBE", 100)],
      controls: [
        dgControl(["discover"]),
        dgControl(undefined, { adGroupId: "612", status: "PAUSED" }),
      ],
    });
    expect(state(runOne("DG04", paused))).not.toBe("fires");
  });
  it("DG04 is not run when the channel controls were not read", () => {
    expect(state(runOne("DG04", demandGenAccount({ controls: null })))).toBe("not_checkable");
    const none = runOne("DG04", demandGenAccount({ controls: [] }));
    expect(["not_checkable", "insufficient_data"]).toContain(state(none));
  });
  it("DG06 fires on a feed attached with no sale", () => {
    const feed = demandGenAccount({
      campaign: { id: "61", name: "Demand Gen catalogue", type: "DEMAND_GEN", cost: 20, conv: 0 },
      settings: [
        {
          campaign_id: "61",
          optimization_goal_types: [],
          merchant_center_id: "900",
          product_feed_disabled: false,
          feed_label: "US",
        },
      ],
    });
    expect(state(runOne("DG06", feed))).toBe("fires");
    // a feed state not read is unknown, never "attached"
    const unknown = demandGenAccount({
      campaign: { id: "61", name: "Demand Gen catalogue", type: "DEMAND_GEN", cost: 20, conv: 0 },
      settings: [
        {
          campaign_id: "61",
          optimization_goal_types: [],
          merchant_center_id: "900",
          product_feed_disabled: null,
        },
      ],
    });
    expect(runOne("DG06", unknown)).toMatchObject({ category: "not_present" });
    expect(runOne("DG06", demandGenAccount())).toMatchObject({ category: "not_present" });
  });
  it("is not run when a Demand Gen table was not read", () => {
    const input = failed(demandGenAccount(), "dg_assets");
    expect(status(input, "DG02")).toBe("not_run");
    const settingsGone = failed(demandGenAccount(), "dg_campaign_settings");
    expect([status(settingsGone, "DG01"), status(settingsGone, "DG06")]).toEqual([
      "not_run",
      "not_run",
    ]);
  });
  it("every check is not present without a Demand Gen campaign", () => {
    const r = runChecks(videoAccount());
    for (const id of ["DG01", "DG02", "DG03", "DG04", "DG06"])
      expect([id, r.checks.find((c) => c.id === id)?.category]).toEqual([id, "not_present"]);
  });
});

describe("wave 3 settings", () => {
  it("every new setting sits inside its own range", () => {
    const input = withStatus(shoppingAccount(), {});
    expect(runChecks(input).warnings.filter((w) => w.startsWith("settings"))).toEqual([]);
  });
});
