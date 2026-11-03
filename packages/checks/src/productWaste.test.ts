// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// (product waste), parity with the PerfoAds app: SH04 (Shopping) and PX05 (PMax) judge
// each product per campaign, per model + colour, at that campaign's own bar
// (C.product_waste_bar = 2 x its cost per sale; C.product_loss_bar = 1 x), plus whole
// categories that lose money. The Mira rows are a demo shop fixture (neutral names and ids,
// spend scaled and rounded); campaign totals, menswear, belts and product types are the same
// synthetic rows the app's tests (campaignProductLosers.test.ts, categoryRollup.test.ts,
// productWasteBar.test.ts) use, and the bars and relationships below are the app test's own.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runChecks, type EvidenceInput } from "./api.js";
import type { CheckFinding, CheckResult } from "./engine/checks/types.js";
import { cappedReadMayHideLosers, categoryRollup, roasPct } from "./engine/checks/shopping.js";
import {
  colourKeyItems,
  titlesSplitByColour,
  sizeStrippedTitle,
  modelColourKey,
  modelColourKeys,
  normaliseColour,
} from "./engine/model/nodes/ProductNode.js";
import { cutoffCostOfMarker, productTypeLevelsOf } from "./engine/model/buildPmaxTree.js";
import { buildInput, checkCtxOf, runOne, type CampaignSpec } from "./testing/account.js";
import { withStatus } from "./testing/wave3.js";

const demo = JSON.parse(
  readFileSync(join(__dirname, "testing", "fixtures", "demoApparelCampaignProducts.json"), "utf8"),
) as {
  miraRows: Array<{
    itemId: string;
    title: string;
    cost: number;
    conversions: number;
    colourFromTitle: string;
  }>;
};

type Camp = { id: string; name: string; type: string; cost: number; conv: number };
type Row = {
  campaign: string;
  id: string;
  title: string;
  cost: number;
  conv?: number;
  value?: number;
  color?: string | null;
  /** product type levels as Google reports them (lowercased) */
  seg?: [string | null, string | null];
  /** the feed's product_type */
  feed?: string | null;
  cat?: string | null;
};

const JACKETS = "DEMO - PMAX - JACKETS";
const BELTS = "DEMO - PMAX  - BELTS"; // two spaces, exactly as Google Ads shows it
const SHOP = "DEMO - SHOP - Brand";
const CAMPS: Camp[] = [
  { id: "1001", name: JACKETS, type: "PERFORMANCE_MAX", cost: 4980, conv: 60 }, // $83 a sale -> bar $166
  { id: "1002", name: BELTS, type: "PERFORMANCE_MAX", cost: 7980, conv: 210 }, // $38 -> bar $76; loss bar = $50 floor
  { id: "1003", name: SHOP, type: "SHOPPING", cost: 640, conv: 13 }, // $49.23 -> bar $98.46
  { id: "11", name: "DEMO - SEARCH - Brand", type: "SEARCH", cost: 1200, conv: 130 },
];

const MIRA: Row[] = demo.miraRows.map((r) => ({
  campaign: JACKETS,
  id: r.itemId,
  title: r.title,
  cost: r.cost,
  conv: r.conversions,
  value: r.conversions * 300,
  color: r.colourFromTitle,
}));
const MENSWEAR: Row[] = [
  {
    campaign: JACKETS,
    id: "shopify_us_7000000000001_1",
    title: "Men's Leather Jacket Viktor Black Demo Brand L",
    cost: 95,
    color: "Black",
  },
  {
    campaign: JACKETS,
    id: "shopify_us_7000000000001_2",
    title: "Men's Leather Jacket Viktor Black Demo Brand M",
    cost: 80,
    color: "Black",
  },
  {
    campaign: JACKETS,
    id: "shopify_us_7000000000001_3",
    title: "Men's Leather Jacket Viktor Black Demo Brand XL",
    cost: 40,
    color: "Black",
  },
  // under the Jackets bar ($166), over the old account bar: not flagged
  {
    campaign: JACKETS,
    id: "shopify_us_7000000000002_1",
    title: "Men's Suede Jacket Hugo Brown Demo Brand M",
    cost: 120,
    color: "Brown",
  },
];
const BELT_ROWS: Row[] = [
  // sells, but at 96% ROAS after more than 1 x a sale there -> loss-maker
  {
    campaign: BELTS,
    id: "shopify_us_7100000000001_1",
    title: "Demo Belt Cognac 85",
    cost: 60,
    conv: 1,
    value: 57.6,
    color: "Cognac",
  },
  {
    campaign: BELTS,
    id: "shopify_us_7100000000001_2",
    title: "Demo Belt Cognac 90",
    cost: 40,
    conv: 1,
    value: 38.4,
    color: "Cognac",
  },
  // 96% ROAS but under the loss bar ($50): not flagged
  {
    campaign: BELTS,
    id: "shopify_us_7100000000002_1",
    title: "Kai Belt Olive 95",
    cost: 30,
    conv: 1,
    value: 28.8,
    color: "Olive",
  },
  // wastes in Jackets, sells in Belts -> flagged in Jackets only
  {
    campaign: BELTS,
    id: "shopify_us_7200000000001_1",
    title: "Sora Belt Black 85",
    cost: 50,
    conv: 3,
    value: 450,
    color: "Black",
  },
  // colourless sizes of a colourless model, summed as the model
  { campaign: BELTS, id: "shopify_us_7300000000001_1", title: "Lumi Belt 85", cost: 50 },
  { campaign: BELTS, id: "shopify_us_7300000000001_2", title: "Lumi Belt 90", cost: 40 },
];
const CROSS: Row = {
  campaign: JACKETS,
  id: "shopify_us_7200000000001_2",
  title: "Sora Belt Black 90",
  cost: 200,
  color: "Black",
};
const SHOP_ROWS: Row[] = [
  // a brand feed copy is judged on its own, never summed into its original
  {
    campaign: SHOP,
    id: "shopify_us_7400000000001_1-cp-demo",
    title: "Demo Belt (copy)",
    cost: 110,
  },
  {
    campaign: SHOP,
    id: "shopify_us_7400000000001_1",
    title: "Demo Belt Tan 85",
    cost: 20,
    conv: 2,
    value: 300,
    color: "Tan",
  },
];

const DAYS = 90;
function build(
  camps: Camp[],
  rows: Row[],
  opts: {
    currencyCode?: string | null;
    marker?: string | null;
    noChannel?: boolean;
    /** extra account data (asset groups, listing trees, shopping settings) */
    data?: Record<string, Row[] | Record<string, unknown>[]>;
    /** catalog products with no row (sizes that never spent) */
    unspent?: Row[];
  } = {},
): EvidenceInput {
  const idOf = (name: string) => camps.find((c) => c.name === name)?.id ?? "";
  const typeOf = (name: string) => camps.find((c) => c.name === name)?.type ?? "";
  const specs: CampaignSpec[] = camps.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    cost: c.cost / DAYS,
    conv: c.conv / DAYS,
    value: (c.conv * 120) / DAYS,
  }));
  const products = rows.map((r) => ({
    campaign_id: idOf(r.campaign),
    offer_id: r.id,
    product_title: r.title,
    channel: opts.noChannel ? null : typeOf(r.campaign),
    product_type_l1: r.seg?.[0] ?? null,
    product_type_l2: r.seg?.[1] ?? null,
    product_category_l1: r.cat ?? null,
    cost_micros: Math.round(r.cost * 1e6),
    clicks: 10,
    impressions: 500,
    conversions: r.conv ?? 0,
    conversions_value: r.value ?? 0,
  }));
  // colour (and product type) from the stored catalog: the product universe slice is empty here
  const catalog = [...rows, ...(opts.unspent ?? [])].map((r) => ({
    product_id: r.id,
    title: r.title,
    color: r.color ?? null,
    item_group_id: null,
    product_type: r.feed ?? null,
  }));
  const input = buildInput({
    campaigns: specs,
    ...(opts.currencyCode !== undefined ? { currencyCode: opts.currencyCode } : {}),
    ...(opts.data ? { data: opts.data } : {}),
    tables: { pmax_campaign_products: products, products_catalog: catalog },
  });
  return {
    ...input,
    statusRows: [
      ...(input.statusRows ?? []),
      {
        table_name: "pmax_campaign_products",
        status: "ok",
        row_count: products.length,
        error_message: opts.marker ?? null,
      },
      ...(withStatus({ ...input, statusRows: [] }, { products_catalog: catalog.length })
        .statusRows ?? []),
    ],
  };
}

/** The snapshot's note of a capped split read (snapshot adapter campaignProductsTruncatedNote). */
const capped = (cutoff: number) =>
  `truncated: reads budget of 40 queries spent: a 1-day read kept its top 10000 rows (the highest-cost rows kept); cutoff_cost=${cutoff.toFixed(2)}`;

const must = <T>(x: T | undefined): T => {
  if (x === undefined) throw new Error("expected a value");
  return x;
};
const fired = (r: CheckResult): CheckFinding[] => (r.state === "fires" ? r.findings : []);
const cardOf = (fs: CheckFinding[], campaign: string, reason: string) =>
  fs.find((f) => f.scope.campaignName === campaign && f.facts.reason === reason);
const listed = (f: CheckFinding | undefined) => (f?.rows ?? []).map((r) => String(r.entity.name));
const bar = (input: EvidenceInput, id: string, campaignId: string) =>
  (checkCtxOf(input).get(id, { campaignId }).value as { bar: number } | null)?.bar;

describe("the keys: model + colour (PRODUCT_KEY_PATTERNS)", () => {
  it("Mira Light Camel and Light Blue share a parent but not a key", () => {
    const camel = demo.miraRows.find((r) => r.colourFromTitle === "Light Camel");
    const blue = demo.miraRows.find((r) => r.colourFromTitle === "Light Blue");
    expect(camel && blue).toBeTruthy();
    expect(modelColourKey({ id: camel?.itemId ?? "", color: camel?.colourFromTitle ?? null })).toBe(
      "shopify:5000000000001|light camel",
    );
    expect(modelColourKey({ id: blue?.itemId ?? "", color: blue?.colourFromTitle ?? null })).toBe(
      "shopify:5000000000001|light blue",
    );
  });
  it("colour spellings fold; item_group_id; copies keep their own id", () => {
    expect(normaliseColour(" Dark-Brown ")).toBe("dark brown");
    expect(normaliseColour("Dark/Brown")).toBe("dark brown");
    expect(modelColourKey({ id: "SKU-1", itemGroupId: "G1", color: "Camel " })).toBe(
      "group:g1|camel",
    );
    expect(modelColourKey({ id: "shopify_us_1_2", itemGroupId: "1" })).toBe("shopify:1");
    expect(modelColourKey({ id: "shopify_us_1_2-cp-demo", color: "Tan" })).toBe(
      "copy:shopify_us_1_2-cp-demo",
    );
  });
  it("mixed sizes: one colour in the model -> colourless sizes join it; two -> they stay alone", () => {
    expect(
      modelColourKeys([
        { id: "shopify_us_1_1", color: "Camel" },
        { id: "shopify_us_1_2", color: null },
      ]),
    ).toEqual(["shopify:1|camel", "shopify:1|camel"]);
    expect(
      modelColourKeys([
        { id: "shopify_us_1_1", color: "Camel" },
        { id: "shopify_us_1_2", color: "Blue" },
        { id: "shopify_us_1_3", color: null },
      ]),
    ).toEqual(["shopify:1|camel", "shopify:1|blue", "shopify:1"]);
  });
});

describe("C.product_waste_bar / C.product_loss_bar (same numbers as the app)", () => {
  const input = build(CAMPS, MIRA);
  it("2 x the campaign's own cost per sale at 10+ sales; never below the spend floor", () => {
    expect(bar(input, "C.product_waste_bar", "1001")).toBeCloseTo(166, 6);
    expect(bar(input, "C.product_loss_bar", "1001")).toBeCloseTo(83, 6);
    expect(bar(input, "C.product_waste_bar", "1002")).toBeCloseTo(76, 6);
    // 1 x $38 is under the $50 spend floor (account $4,933 a month)
    expect(bar(input, "C.product_loss_bar", "1002")).toBe(50);
    expect(bar(input, "C.product_waste_bar", "1003")).toBeCloseTo(98.46, 2);
    const v = checkCtxOf(input).get("C.product_waste_bar", { campaignId: "1001" });
    expect(v.value).toMatchObject({ basis: "campaign", multiple: 2, band: 50 });
    expect(v.reason === undefined ? v.note : null).toBe(
      "bar $166 = 2 x this campaign's 90-day cost per sale ($83.00)",
    );
  });
  it("few campaign sales: the account's cost per sale; tiny account: the spend floor ('band')", () => {
    const camps: Camp[] = [
      { id: "1", name: "PMax Small", type: "PERFORMANCE_MAX", cost: 900, conv: 3 },
      { id: "2", name: "Search Big", type: "SEARCH", cost: 900, conv: 57 },
    ];
    const v = checkCtxOf(build(camps, [])).get("C.product_waste_bar", { campaignId: "1" });
    expect(v.value).toMatchObject({ basis: "account", cpa: 30, bar: 60 });
    const tiny = checkCtxOf(build([{ ...must(camps[0]), conv: 3 }], [])).get(
      "C.product_waste_bar",
      {
        campaignId: "1",
      },
    );
    expect(tiny.value).toMatchObject({ basis: "band", bar: 20 });
    expect(tiny.reason === undefined ? tiny.note : "").toMatch(
      /^few sales yet \(3 sales in this campaign, 3 sales in the account/,
    );
  });
  it("currency unknown: not checkable, never a bar", () => {
    const v = checkCtxOf(build(CAMPS, [], { currencyCode: "XXX" })).get("C.product_waste_bar", {
      campaignId: "1001",
    });
    expect(v.reason).toBe("not_checkable");
    expect(v.reason ? v.detail : "").toMatch(/^currency_unknown:/);
  });
});

describe("PX05 per campaign, per model + colour, one finding per campaign and reason (demo Mira fixture)", () => {
  const input = build(CAMPS, [...MIRA, ...MENSWEAR, ...BELT_ROWS, CROSS, ...SHOP_ROWS]);
  const px05 = fired(runOne("PX05", input));
  const camelTop = must(
    [...MIRA].filter((r) => r.color === "Light Camel").sort((a, b) => b.cost - a.cost)[0],
  );
  const jackets = must(cardOf(px05, JACKETS, "no_sale"));

  it("one finding per campaign and reason: Jackets no sale, Belts no sale, Belts loses money", () => {
    expect(px05.map((f) => [f.scope.campaignName, f.facts.reason])).toEqual([
      [JACKETS, "no_sale"],
      [BELTS, "no_sale"],
      [BELTS, "loses_money"],
    ]);
  });

  it("Mira Light Camel is on the Jackets finding; Mira Light Blue (same jacket, sells) is not", () => {
    expect(listed(jackets)).toContain(`${camelTop.title} (5 sizes)`);
    expect(listed(jackets).some((n) => /Light Blue/.test(n))).toBe(false);
    expect(jackets.facts.member_item_ids).toEqual(
      expect.arrayContaining(MIRA.filter((r) => r.color === "Light Camel").map((r) => r.id)),
    );
    expect(
      (jackets.facts.member_item_ids as string[]).some(
        (id) => MIRA.find((r) => r.id === id)?.color === "Light Blue",
      ),
    ).toBe(false);
    expect(jackets.facts.product_waste_bar).toBeCloseTo(166, 6);
    expect(jackets.facts).toMatchObject({ bar_basis: "campaign", one_colour: true });
  });

  it("every product with its own spend, biggest first, names exact and never shortened", () => {
    expect(
      (jackets.rows ?? []).map((r) => [
        r.entity.name,
        r.cells.campaign_product_spend,
        r.cells.sizes,
      ]),
    ).toEqual([
      [`${camelTop.title} (5 sizes)`, 377, 5],
      ["Men's Leather Jacket Viktor Black Demo Brand L (3 sizes)", 215, 3],
      ["Sora Belt Black 90", 200, 1],
    ]);
    expect(jackets.facts).toMatchObject({
      products: 3,
      campaign_product_spend: 792,
      "Pr.spend": 792,
      variants: 9,
    });
    expect(jackets.facts.product_ids).toEqual([
      camelTop.id,
      "shopify_us_7000000000001_1",
      "shopify_us_7200000000001_2",
    ]);
    expect(jackets.scope).toMatchObject({
      name: "3 products",
      campaignName: JACKETS,
      campaignId: "1001",
    });
  });

  it("the sentence (Google's names: in the facts, never in the title)", () => {
    expect(jackets.facts.headline).toBe(
      `3 products spent $792 in ${JACKETS} with no sale, each more than 2x what a sale costs there ($166)`,
    );
    expect(jackets.title).toBe("products that spent past their campaign's bar with no sale");
    expect(String(jackets.facts.headline)).not.toMatch(/…/);
  });

  it("menswear: Viktor ($215 over 3 sizes) is flagged; Hugo ($120) stays under the bar", () => {
    expect(listed(jackets).some((n) => /Viktor/.test(n))).toBe(true);
    expect(px05.some((f) => listed(f).some((n) => /Hugo/.test(n)))).toBe(false);
  });

  it("loss-maker at 96% ROAS on its own finding, only above the loss bar (the $50 spend floor)", () => {
    const loss = must(cardOf(px05, BELTS, "loses_money"));
    expect(listed(loss)).toEqual(["Demo Belt Cognac 85 (2 sizes)"]);
    expect(loss.rows?.[0]?.cells).toMatchObject({
      campaign_product_spend: 100,
      campaign_product_sales_value: 96,
      return_on_ad_spend: "96%",
    });
    expect(loss.facts).toMatchObject({
      below_break_even: true,
      campaign_product_roas: 0.96,
      product_roas: ["96%"],
      product_loss_bar: 50,
      break_even_not_priced: 1,
    });
    expect(loss.facts.headline).toBe(
      `Demo Belt Cognac 85 (2 sizes) sells in ${BELTS}, but its sales came to 96% of its ad cost (ROAS 96%) after it spent $100, past the spend floor of $50.00, which is higher than what a sale costs there`,
    );
    // MCP rule (kept): a product losing money is never an "opportunity"
    expect(loss.maxSeverity).toBe("warning");
  });

  it("a product wasting in one campaign and selling in another is flagged only in the first", () => {
    expect(listed(jackets)).toContain("Sora Belt Black 90");
    expect(
      px05
        .filter((f) => f.scope.campaignName === BELTS)
        .some((f) => listed(f).some((n) => /Sora/.test(n))),
    ).toBe(false);
  });

  it("colourless sizes are judged as their model (summed: $90 >= the Belts bar $76)", () => {
    const belts = must(cardOf(px05, BELTS, "no_sale"));
    expect(listed(belts)).toEqual(["Lumi Belt 85 (2 sizes and colours together)"]);
    expect(belts.facts).toMatchObject({
      products: 1,
      variants: 2,
      one_colour: false,
      colour_source: "no colour known",
      campaign_product_spend: 90,
    });
    expect(belts.facts.headline).toBe(
      `Lumi Belt 85 (2 sizes and colours together) spent $90.00 in ${BELTS} with no sale, more than 2x what a sale costs there ($76.00)`,
    );
  });

  it("PX05 never reads the Shopping campaign; SH04 judges it per campaign, copies on their own", () => {
    expect(px05.some((f) => f.scope.campaignName === SHOP)).toBe(false);
    const sh04 = fired(runOne("SH04", input));
    expect(sh04.map((f) => [f.scope.name, f.scope.campaignName])).toEqual([
      ["Demo Belt (copy)", SHOP],
    ]);
    expect(sh04[0]?.facts).toMatchObject({
      reason: "no_sale",
      variants: 1,
      campaign_type: "SHOPPING",
    });
    expect(sh04[0]?.claimKey).toBe("product.zero_conv_waste");
  });

  it("two loss-makers: one finding, every ROAS in the sentence", () => {
    const rows: Row[] = [
      {
        campaign: BELTS,
        id: "shopify_us_8100000000001_1",
        title: "Mira Belt Red 85",
        cost: 120,
        conv: 1,
        value: 73.2,
        color: "Red",
      },
      {
        campaign: BELTS,
        id: "shopify_us_8100000000002_1",
        title: "Rae Belt Tan 85",
        cost: 80,
        conv: 1,
        value: 70.4,
        color: "Tan",
      },
    ];
    const two = fired(runOne("PX05", build(CAMPS, rows)));
    expect(two).toHaveLength(1);
    expect(two[0]?.facts.headline).toBe(
      `2 products sell in ${BELTS}, but lose money: ROAS 61% and 88%, each after spending past the spend floor of $50.00, which is higher than what a sale costs there`,
    );
  });

  it("15 products: every one in the rows (never capped)", () => {
    const many: Row[] = Array.from({ length: 15 }, (_, k) => ({
      campaign: JACKETS,
      id: `shopify_us_90000000000${String(k).padStart(2, "0")}_1`,
      title: `Jacket Number ${k + 1} Black`,
      cost: 170 + k,
      color: "Black",
    }));
    const f = fired(runOne("PX05", build(CAMPS, many)))[0];
    expect(f?.rows).toHaveLength(15);
    expect(String(f?.facts.headline)).toMatch(
      /^15 products spent \$2,655 in DEMO - PMAX - JACKETS with no sale, each more than 2x/,
    );
  });

  it("priced: the no-sale spend as waste, the loss leg's shortfall as margin at risk", () => {
    const out = runChecks(input).findings.filter((x) => x.checkId === "PX05");
    const j = out.find((x) => x.facts.reason === "no_sale" && x.scope.campaignName === JACKETS);
    const l = out.find((x) => x.facts.reason === "loses_money");
    expect(j?.impact.kind).toBe("waste");
    expect(l?.impact.kind).toBe("at_risk");
  });
});

describe("failure paths: never 'none found' when we could not check", () => {
  it("currency unknown: PX05 and SH04 say could not check", () => {
    const input = build(CAMPS, [...MIRA, ...SHOP_ROWS], { currencyCode: "XXX" });
    for (const id of ["PX05", "SH04"]) {
      const r = runOne(id, input);
      expect(r.state).toBe("not_checkable");
      expect((r as { reason: string }).reason).toMatch(
        /could not check the products in .*currency_unknown/,
      );
    }
  });

  it("capped read: the unseen spend could reach the bar -> not checkable; a tiny cutoff -> none found", () => {
    const quiet: Row[] = [
      {
        campaign: JACKETS,
        id: "shopify_us_1_1",
        title: "Quiet Jacket Black S",
        cost: 100,
        conv: 0,
        color: "Black",
      },
      {
        campaign: BELTS,
        id: "shopify_us_2_1",
        title: "Good Belt Tan 85",
        cost: 50,
        conv: 2,
        value: 400,
        color: "Tan",
      },
    ];
    const r = runOne("PX05", build(CAMPS, quiet, { marker: capped(70) }));
    expect(r.state).toBe("not_checkable");
    expect((r as { reason: string }).reason).toMatch(
      /some products may be missing.*DEMO - PMAX - JACKETS \(166\.00\)/,
    );
    expect(runOne("PX05", build(CAMPS, quiet, { marker: capped(5) })).state).toBe("none_found");
  });

  it("the capped-read guard runs at the loss bar too (cutoff $30, loss bar $50, kept $40 / $30)", () => {
    const kept: Row[] = [
      {
        campaign: BELTS,
        id: "shopify_us_2_1",
        title: "Kept Belt Tan 85",
        cost: 40,
        conv: 1,
        value: 30,
        color: "Tan",
      },
    ];
    const r = runOne("PX05", build(CAMPS, kept, { marker: capped(30) }));
    expect(r.state).toBe("not_checkable");
    expect((r as { reason: string }).reason).toMatch(/DEMO - PMAX {2}- BELTS \(loss bar 50\.00\)/);
    expect(
      runOne("PX05", build(CAMPS, [{ ...must(kept[0]), value: 80 }], { marker: capped(30) })).state,
    ).toBe("none_found");
  });

  it("a product hidden entirely under the cap could pass the loss bar (cutoff $60, loss bar $50, bar $100)", () => {
    const camps: Camp[] = [
      { id: "5", name: "PMax Mid", type: "PERFORMANCE_MAX", cost: 5000, conv: 100 },
      { id: "6", name: "Search Generic", type: "SEARCH", cost: 1000, conv: 50 },
    ];
    const kept: Row[] = [
      {
        campaign: "PMax Mid",
        id: "shopify_us_3_1",
        title: "Small Belt Tan 85",
        cost: 20,
        conv: 0,
        color: "Tan",
      },
    ];
    const input = build(camps, kept, { marker: capped(60) });
    expect(bar(input, "C.product_waste_bar", "5")).toBeCloseTo(100, 6);
    expect(bar(input, "C.product_loss_bar", "5")).toBeCloseTo(50, 6);
    expect(runOne("PX05", input)).toMatchObject({
      state: "not_checkable",
      reason: expect.stringMatching(/PMax Mid \(loss bar 50\.00\)/),
    });
  });

  it("an older snapshot (rows without a channel) never judges Shopping per campaign: SH04 falls back", () => {
    const input = build(CAMPS, [...MIRA, ...SHOP_ROWS.map((r) => ({ ...r, campaign: JACKETS }))], {
      noChannel: true,
    });
    const shop = checkCtxOf(input).model.children.campaigns.find((c) => c.name === SHOP);
    expect(shop?.attrs.productPerf).toMatchObject({ state: "not_checkable" });
    const r = runOne("SH04", input);
    expect(
      r.state === "fires"
        ? r.findings.every((f) => /account-wide read/.test(f.note ?? ""))
        : r.state,
    ).not.toBe("fires");
    // PMax keeps its per-campaign read
    expect(
      fired(runOne("PX05", input)).some((f) => listed(f).some((n) => /Light Camel/.test(n))),
    ).toBe(true);
  });

  it("the cutoff of a capped read is read from the note", () => {
    expect(cutoffCostOfMarker(capped(70))).toBe(70);
    expect(cutoffCostOfMarker("truncated: the product read hit its row limit")).toBeNull();
    expect(cappedReadMayHideLosers(true, null, 90, 0, 80)).toBe(true);
    expect(cappedReadMayHideLosers(true, 5, 0, 100, 166)).toBe(false);
  });

  it("ROAS under 100% rounds down (0.996 = 99%, never a '100%' loss)", () => {
    expect(roasPct(0.996)).toBe("99%");
    expect(roasPct(0.6149)).toBe("61%");
    expect(roasPct(1.004)).toBe("100%");
  });
});

describe("whole categories that lose money (app categoryRollup.test.ts numbers)", () => {
  const WOMEN = {
    seg: ["womenswear", "jackets"] as [string, string],
    feed: "Womenswear > Jackets",
  };
  const MEN = { seg: ["menswear", "jackets"] as [string, string], feed: "Menswear > Jackets" };
  const mira: Row[] = MIRA.map((r) => ({ ...r, ...WOMEN }));
  const womenSeller: Row = {
    campaign: JACKETS,
    id: "shopify_us_8000000000001_1",
    title: "Women's Leather Jacket Lotte Black Demo Brand M",
    cost: 400,
    conv: 8,
    value: 2400,
    color: "Black",
    ...WOMEN,
  };
  const menswear: Row[] = [
    ...MENSWEAR.map((r) => ({ ...r, ...MEN })),
    {
      campaign: JACKETS,
      id: "shopify_us_7000000000003_1",
      title: "Men's Bomber Jacket Bram Cognac Demo Brand L",
      cost: 197,
      conv: 1,
      value: 31,
      color: "Cognac",
      ...MEN,
    },
  ];
  const BAG = (k: number, cost: number, conv = 0, value = 0): Row => ({
    campaign: BELTS,
    id: `shopify_us_76000000000${k}_1`,
    title: `Bag Number ${k} Tan`,
    cost,
    conv,
    value,
    color: "Tan",
    seg: ["bags", null],
    feed: "Bags",
  });
  const belts: Row[] = [
    BAG(1, 100),
    BAG(2, 90),
    BAG(3, 160, 4, 900),
    {
      campaign: BELTS,
      id: "shopify_us_7100000000001_1",
      title: "Demo Belt Cognac 85",
      cost: 300,
      conv: 10,
      value: 1500,
      color: "Cognac",
      seg: ["belts", null],
      feed: "Belts",
    },
  ];
  const px05 = fired(runOne("PX05", build(CAMPS, [...mira, womenSeller, ...menswear, ...belts])));
  const men = must(cardOf(px05, JACKETS, "category_loses_money"));

  it("Menswear in PMax Jackets: $532 spent, $31 in sales, ROAS 5%, the feed's spelling", () => {
    expect(men.facts).toMatchObject({
      category: "Menswear",
      category_source: "product_type",
      category_level: 1,
      products: 3,
      variants: 5,
      campaign_product_spend: 532,
      campaign_product_sales_value: 31,
      conv: 1,
      below_break_even: true,
    });
    expect(men.facts.product_waste_bar).toBeCloseTo(166, 6);
    expect(men.facts.category_bar).toBe(332);
    expect(men.scope).toMatchObject({
      name: "Menswear",
      campaignId: "1001",
      campaignName: JACKETS,
    });
    expect(men.facts.headline).toBe(
      `Menswear spent $532 in ${JACKETS} and brought $31.00 in sales (ROAS 5%)`,
    );
  });

  it("the spend of its no-sale products (Viktor $215 + Hugo $120) is wasted money, priced", () => {
    expect(men.facts).toMatchObject({
      wasted_cost_90d: 335,
      "Pr.spend": 335,
      category_no_sale_spend: 335,
    });
    expect(men.facts.break_even_not_priced).toBeUndefined();
    expect(men.maxSeverity).toBeUndefined();
  });

  it("its products are on the category finding only; Mira Light Camel keeps its product finding; Womenswear and Bags never fire", () => {
    expect(listed(men).some((n) => /Viktor/.test(n))).toBe(true);
    const jackets = cardOf(px05, JACKETS, "no_sale");
    expect(listed(jackets).some((n) => /Viktor/.test(n))).toBe(false);
    expect(listed(jackets).some((n) => /Light Camel/.test(n))).toBe(true);
    expect(
      px05.filter((f) => f.facts.reason === "category_loses_money").map((f) => f.facts.category),
    ).toEqual(["Menswear"]);
    // Bags earns back its cost; its 0-sale bags ($100 >= $76) keep their own product finding
    expect(listed(cardOf(px05, BELTS, "no_sale"))).toEqual([
      "Bag Number 1 Tan",
      "Bag Number 2 Tan",
    ]);
  });

  it("product type spelling: the feed's when it reads the same; Google category when no product type", () => {
    expect(productTypeLevelsOf("menswear", "jackets", "Menswear > Jackets")).toEqual([
      "Menswear",
      "Jackets",
    ]);
    expect(productTypeLevelsOf("bags", null, "Womenswear > Jackets")).toEqual(["bags", null]);
    const g = (key: string, cost: number, cat: string) => ({
      key,
      cost,
      conv: 0,
      value: 0,
      members: [{ productTypeL1: null, productTypeL2: null, categoryL1: cat }],
    });
    const r = categoryRollup(
      [g("a", 50, "Apparel"), g("b", 40, "Apparel"), g("c", 10, "Bags")],
      80,
    );
    expect(r.source).toBe("google_category");
    expect(r.losers.map((l) => [l.path, l.cost])).toEqual([["Apparel", 90]]);
    expect(categoryRollup([g("a", 50, "Apparel")], 10).losers).toEqual([]);
  });

  it("a capped read with category data is could-not-check, never clean", () => {
    const rows: Row[] = [
      {
        campaign: JACKETS,
        id: "shopify_us_1_1",
        title: "A Black",
        cost: 10,
        conv: 1,
        value: 100,
        color: "Black",
        seg: ["menswear", null],
      },
      {
        campaign: JACKETS,
        id: "shopify_us_2_1",
        title: "B Black",
        cost: 10,
        conv: 1,
        value: 100,
        color: "Black",
        seg: ["womenswear", null],
      },
    ];
    const r = runOne("PX05", build(CAMPS, rows, { marker: capped(1) }));
    expect(r).toMatchObject({
      state: "not_checkable",
      reason: expect.stringMatching(/whole categories/),
    });
  });
});

describe("colour from product titles (no Merchant Center colour on live reads)", () => {
  const keysOf = (rows: Array<{ id: string; title: string; color?: string | null }>) =>
    colourKeyItems(rows, (r) => ({ id: r.id, title: r.title, color: r.color ?? null }));
  it("strips the size part of demo title shapes", () => {
    expect(
      sizeStrippedTitle(
        "Women's Sample Demo Jacket Mira Basic Test Plain Simple Neutral Straight-Cut Snap-On Light Camel Demo Brand XS",
      ),
    ).toBe(
      "women's sample demo jacket mira basic test plain simple neutral straight-cut snap-on light camel demo brand",
    );
    expect(sizeStrippedTitle("Twin Belt Camel XL-105")).toBe("twin belt camel");
    expect(sizeStrippedTitle("Twin Belt Black L/XL-100")).toBe("twin belt black");
    expect(sizeStrippedTitle("Demo Belt Cognac 85")).toBe("demo belt cognac");
    expect(sizeStrippedTitle("Demo Belt Cognac | Size 90")).toBe("demo belt cognac");
    expect(sizeStrippedTitle("Bag Number 1 Tan")).toBe("bag number 1 tan");
  });
  it("Mira Light Camel and Light Blue sizes split by title; sizes of one colour stay one", () => {
    const rows = demo.miraRows.map((r) => ({ id: r.itemId, title: r.title }));
    const { items, fromTitle } = keysOf(rows);
    const keys = items.map((i) => modelColourKey(i));
    const camel = new Set(
      keys.filter((_, k) => demo.miraRows[k]?.colourFromTitle === "Light Camel"),
    );
    const blue = new Set(keys.filter((_, k) => demo.miraRows[k]?.colourFromTitle === "Light Blue"));
    expect(camel.size).toBe(1);
    expect(blue.size).toBe(1);
    expect([...camel][0]).not.toBe([...blue][0]);
    expect(fromTitle.every(Boolean)).toBe(true);
  });
  it("Twin Camel XL-105 vs Twin Black L/XL-100 split; a title without a size stays as is", () => {
    const { items } = keysOf([
      { id: "shopify_us_55_1", title: "Twin Belt Camel XL-105" },
      { id: "shopify_us_55_2", title: "Twin Belt Camel S-85" },
      { id: "shopify_us_55_3", title: "Twin Belt Black L/XL-100" },
      { id: "shopify_us_66_1", title: "Plain Wallet" },
    ]);
    const k = items.map((i) => modelColourKey(i));
    expect(k[0]).toBe(k[1]);
    expect(k[0]).not.toBe(k[2]);
    expect(k[3]).toBe("shopify:66");
  });
  it("Merchant Center colour wins: a model with a colour keeps colours only; copies keep their own key", () => {
    const { items, fromTitle } = keysOf([
      { id: "shopify_us_77_1", title: "Mira Belt Red 85", color: "Red" },
      { id: "shopify_us_77_2", title: "Mira Belt Red 90" },
      { id: "shopify_us_77_1-cp-demo", title: "Mira Belt copy" },
    ]);
    expect(fromTitle).toEqual([false, false, false]);
    expect(items[1]?.color ?? null).toBeNull();
  });
  it("PX05 on live-shaped rows (no colour anywhere): Mira Light Camel flagged, Light Blue not, source said", () => {
    const rows: Row[] = MIRA.map((r) => ({ ...r, color: null }));
    const f = fired(runOne("PX05", build(CAMPS, rows)));
    const card = must(cardOf(f, JACKETS, "no_sale"));
    expect(listed(card)).toEqual([
      `${must([...MIRA].filter((r) => r.color === "Light Camel").sort((a, b) => b.cost - a.cost)[0]).title} (5 sizes)`,
    ]);
    expect(card.facts.campaign_product_spend).toBe(377);
    expect(card.facts.colour_source).toBe("colour from product titles");
  });
});

describe("sizes that never spent: the campaign's readable products, same model + colour", () => {
  // 5 Light Camel sizes, 2 of them never spent in Jackets (catalog only); every Light Blue size
  // spent and sells, plus one Light Blue size that never spent
  const camel = MIRA.filter((r) => r.color === "Light Camel").map((r) => ({ ...r, color: null }));
  const blue = MIRA.filter((r) => r.color === "Light Blue").map((r) => ({ ...r, color: null }));
  const never = camel.filter((r) => / (XS|L)$/.test(r.title));
  const spent = camel.filter((r) => !never.includes(r));
  const blueNever: Row = {
    ...must(blue[0]),
    id: "shopify_us_5000000000001_1099",
    title: must(blue[0]).title.replace(/ M$/, " XXL"),
    cost: 0,
    conv: 0,
  };
  const tree = (campaignId: string, group: string) => ({
    assetGroups: [{ asset_group_id: group, campaign_id: campaignId, status: "ENABLED" }],
    pmaxListingGroups: [
      {
        asset_group_id: group,
        listing_group_id: "1",
        parent_listing_group_id: null,
        type: "UNIT_INCLUDED",
        case_value: "{}",
      },
    ],
  });
  const ids = (f: CheckFinding | undefined) => [
    ...((f?.facts.member_item_ids as string[] | undefined) ?? []),
    ...((f?.facts.unspent_item_ids as string[] | undefined) ?? []),
  ];

  it("PX05: all 5 Light Camel sizes excluded (3 spent + 2 never spent); Light Blue untouched", () => {
    expect([never.length, spent.length]).toEqual([2, 3]);
    const input = build(CAMPS, [...spent, ...blue], {
      data: tree("1001", "501"),
      unspent: [...never, blueNever],
    });
    const card = must(cardOf(fired(runOne("PX05", input)), JACKETS, "no_sale"));
    expect(listed(card)).toEqual([
      `${must([...spent].sort((a, b) => b.cost - a.cost)[0]).title} (3 sizes)`,
    ]);
    expect([...(card.facts.unspent_item_ids as string[])].sort()).toEqual(
      never.map((r) => r.id).sort(),
    );
    expect(ids(card).sort()).toEqual(camel.map((r) => r.id).sort());
    expect(ids(card).some((id) => [...blue, blueNever].some((b) => b.id === id))).toBe(false);
  });

  it("no listing tree read: no unspent sizes (only the spent ones are named)", () => {
    const input = build(CAMPS, [...spent, ...blue], { unspent: [...never, blueNever] });
    const card = must(cardOf(fired(runOne("PX05", input)), JACKETS, "no_sale"));
    expect(card.facts.unspent_item_ids).toEqual([]);
  });

  it("an unspent size that would change the split adds nothing", () => {
    // a renamed size of the same parent: the titles no longer read as one colour slot
    const odd: Row = { ...must(never[0]), title: "Mira Jacket Light Camel XS" };
    const input = build(CAMPS, [...spent, ...blue], {
      data: tree("1001", "501"),
      unspent: [odd],
    });
    const card = cardOf(fired(runOne("PX05", input)), JACKETS, "no_sale");
    expect(card ? card.facts.unspent_item_ids : []).toEqual([]);
  });

  it("SH04: the Shopping campaign's feed label reads its never-spent sizes the same way", () => {
    const shop = (r: Row): Row => ({ ...r, campaign: SHOP });
    const input = build(CAMPS, [...spent, ...blue].map(shop), {
      data: {
        shoppingSettings: [
          { campaign_id: "1003", campaign_priority: null, merchant_id: "900", feed_label: "" },
        ],
      },
      unspent: [...never, blueNever],
    });
    const card = must(cardOf(fired(runOne("SH04", input)), SHOP, "no_sale"));
    expect(ids(card).sort()).toEqual(camel.map((r) => r.id).sort());
  });
});

describe("round 2: a product no running asset group can select now is already out (NEW-15)", () => {
  // Jackets' one live group takes custom label 0 "no_data" AND custom label 1 "jackets"; the
  // Light Camel sizes were tagged "exclude" on label 0 since they spent
  const at = (id: string, type: string, caseValue: object, parent?: string) => ({
    asset_group_id: "501",
    listing_group_id: id,
    parent_listing_group_id: parent ?? null,
    type,
    case_value: JSON.stringify(caseValue),
  });
  const label = (index: string, value?: string) => ({
    productCustomAttribute: value === undefined ? { index } : { index, value },
  });
  const tree = {
    assetGroups: [{ asset_group_id: "501", campaign_id: "1001", status: "ENABLED" }],
    pmaxListingGroups: [
      at("1", "SUBDIVISION", {}),
      at("2", "SUBDIVISION", label("INDEX0", "no_data"), "1"),
      at("3", "UNIT_INCLUDED", label("INDEX1", "jackets"), "2"),
      at("4", "UNIT_EXCLUDED", label("INDEX1"), "2"),
      at("5", "UNIT_EXCLUDED", label("INDEX0"), "1"),
    ],
  };
  const rows = [...MIRA, ...MENSWEAR, CROSS];
  const withLabels = (excluded: (r: Row) => boolean): EvidenceInput => {
    const base = build(CAMPS, rows, { data: tree });
    return {
      ...base,
      data: {
        ...base.data,
        products: rows.map((r) => ({
          product_id: r.id,
          title: r.title,
          custom_label_0: excluded(r) ? "exclude" : "no_data",
          custom_label_1: "jackets",
          cost_micros: Math.round(r.cost * 1e6),
          clicks: 10,
          impressions: 500,
          conversions: r.conv ?? 0,
          conversion_value: r.value ?? 0,
        })),
      },
    };
  };
  const camel = (r: Row) => r.color === "Light Camel";

  it("PX05: the excluded jacket is not judged, no waste money for it; the rest stay", () => {
    const r = runOne("PX05", withLabels(camel));
    const card = must(cardOf(fired(r), JACKETS, "no_sale"));
    expect(listed(card).some((n) => /Light Camel/.test(n))).toBe(false);
    expect(card.facts).toMatchObject({ products: 2, campaign_product_spend: 415 });
    expect(card.note).toMatch(/not judged, already out: .* in DEMO - PMAX - JACKETS \(1\)/);
  });

  it("PX05: every product still selectable = judged as before (Light Camel on the card)", () => {
    const card = must(
      cardOf(
        fired(
          runOne(
            "PX05",
            withLabels(() => false),
          ),
        ),
        JACKETS,
        "no_sale",
      ),
    );
    expect(listed(card).some((n) => /Light Camel/.test(n))).toBe(true);
    expect(card.facts.products).toBe(3);
  });

  it("PX05: only some sizes tagged = the model is still in, still judged", () => {
    const firstCamel = must(MIRA.find(camel)).id;
    const card = must(
      cardOf(
        fired(
          runOne(
            "PX05",
            withLabels((r) => r.id === firstCamel),
          ),
        ),
        JACKETS,
        "no_sale",
      ),
    );
    expect(listed(card).some((n) => /Light Camel/.test(n))).toBe(true);
  });

  it("PX05: a product with no feed row (blank labels, not read) stays in, still judged", () => {
    const base = withLabels(() => false);
    const input: EvidenceInput = {
      ...base,
      data: {
        ...base.data,
        products: (base.data.products ?? []).filter(
          (p) => !MIRA.some((r) => camel(r) && r.id === p.product_id),
        ),
        shoppingProductsData: MIRA.filter(camel).map((r) => ({
          item_id: r.id,
          title: r.title,
          status: "ELIGIBLE",
        })),
      },
    };
    const card = must(cardOf(fired(runOne("PX05", input)), JACKETS, "no_sale"));
    expect(listed(card).some((n) => /Light Camel/.test(n))).toBe(true);
    expect(card.note ?? "").not.toMatch(/already out/);
  });

  it("round 2 review: a running tree on product type (feed stores the full path) cannot rule a product out", () => {
    // the group takes product type level 1 "Jackets"; the feed says "Jackets > Women"
    const base = withLabels(camel);
    const input: EvidenceInput = {
      ...base,
      data: {
        ...base.data,
        pmaxListingGroups: [
          at("1", "SUBDIVISION", {}),
          at("2", "UNIT_INCLUDED", { productType: { level: "LEVEL1", value: "Jackets" } }, "1"),
          at("3", "UNIT_EXCLUDED", { productType: { level: "LEVEL1" } }, "1"),
        ],
        products: (base.data.products ?? []).map((p) => ({
          ...p,
          product_type: "Jackets > Women",
        })),
      },
    };
    const card = must(cardOf(fired(runOne("PX05", input)), JACKETS, "no_sale"));
    expect(listed(card).some((n) => /Light Camel/.test(n))).toBe(true);
    expect(card.note ?? "").not.toMatch(/already out/);
  });

  it("round 2 review: a second running group with no tree in our data = nothing is already out", () => {
    const base = withLabels(camel);
    const input: EvidenceInput = {
      ...base,
      data: {
        ...base.data,
        assetGroups: [
          ...(base.data.assetGroups ?? []),
          { asset_group_id: "502", campaign_id: "1001", status: "ENABLED" },
        ],
      },
    };
    const card = must(cardOf(fired(runOne("PX05", input)), JACKETS, "no_sale"));
    expect(listed(card).some((n) => /Light Camel/.test(n))).toBe(true);
  });

  // round 3 (bug B): SH20 skips a product NO live campaign can show now. The second PMax
  // campaign's one group takes custom label 1 "belts"; the Shopping campaign sells another
  // feed label of the same Merchant Center account
  const sh20 = (
    excluded: (r: Row) => boolean,
    opts: { shoppingLabel?: string; extraGroup?: boolean } = {},
  ): EvidenceInput => {
    const base = withLabels(excluded);
    return {
      ...base,
      data: {
        ...base.data,
        assetGroups: [
          ...(base.data.assetGroups ?? []),
          { asset_group_id: "601", campaign_id: "1002", status: "ENABLED" },
          ...(opts.extraGroup
            ? [{ asset_group_id: "502", campaign_id: "1001", status: "ENABLED" }]
            : []),
        ],
        pmaxListingGroups: [
          ...(base.data.pmaxListingGroups ?? []),
          { ...at("11", "SUBDIVISION", {}), asset_group_id: "601" },
          { ...at("12", "UNIT_INCLUDED", label("INDEX1", "belts"), "11"), asset_group_id: "601" },
          { ...at("13", "UNIT_EXCLUDED", label("INDEX1"), "11"), asset_group_id: "601" },
        ],
        shoppingSettings: [
          {
            campaign_id: "1003",
            campaign_priority: null,
            merchant_id: "900",
            feed_label: opts.shoppingLabel ?? "us_second",
          },
        ],
        products: (base.data.products ?? []).map((p) => ({
          ...p,
          clicks: 60,
          merchant_id: "900",
          feed_label: "us",
        })),
      },
    };
  };
  const sh20Ids = (r: CheckResult): string[] =>
    r.state === "fires" ? (r.findings[0]?.rows ?? []).map((x) => x.entity.id ?? "") : [];
  const camelIds = MIRA.filter(camel).map((r) => r.id);

  it("SH20: an excluded product no live campaign can show is skipped, with a note and a count", () => {
    const r = runOne("SH20", sh20(camel));
    const ids = sh20Ids(r);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => camelIds.includes(id))).toBe(false);
    const f = must(r.state === "fires" ? r.findings[0] : undefined);
    expect(f.facts.products_already_excluded).toBe(camelIds.length);
    expect(f.note).toMatch(/5 product\(s\) .* not judged, already out/);
    // the money counts only the products left
    const all = runOne(
      "SH20",
      sh20(() => false),
    );
    const allCost = Number(all.state === "fires" ? all.findings[0]?.facts.wasted_cost_90d : 0);
    const camelCost = MIRA.filter(camel).reduce((t, x) => t + x.cost, 0);
    expect(Number(f.facts.wasted_cost_90d)).toBeCloseTo(allCost - camelCost, 2);
  });

  it("SH20: the same product while a running group's tree could still select it is listed", () => {
    const ids = sh20Ids(
      runOne(
        "SH20",
        sh20(() => false),
      ),
    );
    expect(camelIds.every((id) => ids.includes(id))).toBe(true);
  });

  it("SH20: a running group with no tree in our data = the excluded product is listed", () => {
    const r = runOne("SH20", sh20(camel, { extraGroup: true }));
    expect(camelIds.every((id) => sh20Ids(r).includes(id))).toBe(true);
    expect(r.state === "fires" ? r.findings[0]?.facts.products_already_excluded : 0).toBe(
      undefined,
    );
  });

  it("SH20: a live Shopping campaign that can serve its feed = the excluded product is listed", () => {
    for (const shoppingLabel of ["us", ""]) {
      const ids = sh20Ids(runOne("SH20", sh20(camel, { shoppingLabel })));
      expect(camelIds.every((id) => ids.includes(id))).toBe(true);
    }
  });
});

describe("review fixes: feed title first, missed size words, split only on a colour slot", () => {
  const keys = (rows: Array<{ id: string; title: string }>) =>
    colourKeyItems(rows, (r) => r).items.map((i) => modelColourKey(i));
  it("size words: Medium, Large, X-Large, 3XL-6XL, XXXXL, W28 L32, 34 inch, EU 85, dashes", () => {
    for (const t of [
      "Shirt - White / Large",
      "Shirt - White / Medium",
      "Shirt - White / X-Large",
      "Shirt - White / X-Small",
      "Shirt - White 4XL",
      "Shirt - White XXXXL",
      "Shirt - White W28 L32",
      "Shirt - White 34 inch",
      "Shirt - White EU 85",
      "Shirt - White \u2013 S",
      "Shirt - White \u2014 Small",
    ])
      expect([t, sizeStrippedTitle(t)]).toEqual([t, "shirt - white"]);
  });
  it("Shirt White Large vs White Medium stay one group; White Large vs Black Large split", () => {
    const one = keys([
      { id: "shopify_us_90_1", title: "Shirt - White / Large" },
      { id: "shopify_us_90_2", title: "Shirt - White / Medium" },
    ]);
    expect(one[0]).toBe(one[1]);
    const two = keys([
      { id: "shopify_us_91_1", title: "Shirt - White / Large" },
      { id: "shopify_us_91_2", title: "Shirt - Black / Large" },
    ]);
    expect(two[0]).not.toBe(two[1]);
  });
  it("no colour slot (a size word left, a renamed product): the model stays whole", () => {
    expect(titlesSplitByColour(["shirt white petite", "shirt white"])).toBe(false);
    expect(titlesSplitByColour(["shirt white 10 wide", "shirt white 12 wide"])).toBe(false);
    expect(titlesSplitByColour(["old demo belt cognac", "demo belt cognac new"])).toBe(false);
    expect(titlesSplitByColour(["twin belt camel", "twin belt black"])).toBe(true);
  });
  it("Demo Cognac XS with an old saved title and M with the new title stay one group (current feed title)", () => {
    const rows: Row[] = [
      {
        campaign: BELTS,
        id: "shopify_us_7700000000001_1",
        title: "Demo Belt Cognac Leather XS",
        cost: 50,
      },
      { campaign: BELTS, id: "shopify_us_7700000000001_2", title: "Demo Belt Cognac M", cost: 40 },
    ];
    const base = build(CAMPS, rows);
    // the feed (shopping_product) now titles both sizes the new way
    const input: EvidenceInput = {
      ...base,
      data: {
        ...base.data,
        products: rows.map((r) => ({
          product_id: r.id,
          title: r.id.endsWith("_1") ? "Demo Belt Cognac XS" : "Demo Belt Cognac M",
          cost_micros: r.cost * 1e6,
          clicks: 10,
          impressions: 500,
          conversions: 0,
          conversion_value: 0,
        })),
      },
    };
    const f = must(cardOf(fired(runOne("PX05", input)), BELTS, "no_sale"));
    expect(f.facts).toMatchObject({ products: 1, variants: 2, campaign_product_spend: 90 });
  });
});
