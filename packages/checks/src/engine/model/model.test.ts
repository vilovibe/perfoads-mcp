// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/** Account model: unit tests on synthetic data. */
import { describe, expect, it } from "vitest";
import type { AccountData as AuditData } from "../shared/input.js";
import { buildAccountModel } from "./buildAccountModel.js";
import { negativeMatches } from "./buildNegatives.js";
import { classifyChannel, parseDimension } from "./buildPmaxTree.js";
import { cleanPageUrl, overrideClassOf, urlKey } from "./buildSearchTree.js";
import { buildCoverageReport, COVERAGE_ALLOWLIST } from "./coverage.js";
import { fromMicros, metricsFromRows, num, ratio, sumField } from "./metrics.js";
import { computeAuditWindow, windowsFromDaily } from "./windows.js";
import { ACCOUNT_DATA_ARRAY_KEYS as AUDIT_DATA_ARRAY_KEYS } from "../shared/input.js";
import { buildSyntheticSnapshot } from "../../testing/syntheticSnapshot.js";

const W = {
  label: "m90" as const,
  start: "2026-06-04",
  end: "2026-09-02",
  days: 91,
  settledStrict: false,
  settledPractical: false,
};

describe("metrics: one definition per number", () => {
  it("num() coerces pg strings and never returns NaN", () => {
    expect(num("1000.25")).toBe(1000.25);
    expect(num("3389")).toBe(3389);
    expect(num(5)).toBe(5);
    expect(num(null)).toBeNull();
    expect(num("")).toBeNull();
    expect(num("abc")).toBeNull();
    expect(num(NaN)).toBeNull();
    expect(fromMicros("1124753")).toBeCloseTo(1.124753, 6);
  });
  it("sumField is null when no row carries the column (never 0-for-unknown)", () => {
    expect(sumField([{ cost: "1.5" }, { cost: null }, { cost: "2" }], "cost")).toBe(3.5);
    expect(sumField([{ clicks: 1 }], "conversion_value")).toBeNull();
    expect(sumField([], "cost")).toBeNull();
  });
  it("ratios are null on a zero or unknown denominator", () => {
    expect(ratio(10, 0)).toBeNull();
    expect(ratio(10, null)).toBeNull();
    expect(ratio(null, 5)).toBeNull();
    expect(ratio(10, 4)).toBe(2.5);
    const m = metricsFromRows(
      [
        {
          id: "r1",
          cost: "10.00",
          clicks: "0",
          impressions: "100",
          conversions: "0.00",
          conversion_value: "0",
        },
      ],
      W,
      "campaigns",
    );
    expect(m).toMatchObject({
      cost: 10,
      clicks: 0,
      conv: 0,
      cpa: null,
      roas: 0,
      ctr: 0,
      cvr: null,
      aov: null,
    });
    expect(m.provenance).toEqual({
      table: "campaigns",
      rowCount: 1,
      rowIds: ["r1"],
      window: "m90",
      settledStrict: false,
      settledPractical: false,
    });
  });
  it("cost from micros when the table stores micros", () => {
    const m = metricsFromRows(
      [
        {
          product_id: "p",
          cost_micros: "2500000",
          clicks: 3,
          conversions: "1",
          conversion_value: "40",
        },
      ],
      W,
      "products",
      { costMicros: "cost_micros" },
      "product_id",
    );
    expect(m.cost).toBe(2.5);
    expect(m.roas).toBe(16);
  });
});

describe("windows and maturity", () => {
  const daily = (days: string[]) =>
    days.map((d) => ({
      metric_date: `${d}T00:00:00.000Z`,
      cost: "1",
      conversions: "1",
      conversion_value: "2",
      clicks: 1,
      impressions: 1,
    }));
  it("places the window from daily_metrics and derives both settled tiers", () => {
    const aw = computeAuditWindow(
      daily(["2026-06-04", "2026-09-02"]),
      [],
      [{ lookback_window_days: 30 }, { lookback_window_days: 7 }],
    );
    expect(aw).toMatchObject({
      start: "2026-06-04",
      end: "2026-09-02",
      maxLookbackDays: 30,
      lastSettledDay: "2026-08-03",
      lastSettledDayPractical: "2026-08-26",
      lookbackUnknown: false,
      source: "dailyMetrics",
    });
    expect(aw.windows.m7).toMatchObject({
      start: "2026-08-27",
      end: "2026-09-02",
      settledStrict: false,
      settledPractical: false,
    });
    expect(aw.windows.mPrior30).toMatchObject({ settledStrict: true, settledPractical: true });
    expect(aw.windows.settledToDate).toMatchObject({ start: "2026-06-04", end: "2026-08-03" });
  });
  it("no conversion actions → lookback unknown → nothing strictly settled, practical still computed", () => {
    const aw = computeAuditWindow(daily(["2026-06-04", "2026-09-02"]), [], []);
    expect(aw.lookbackUnknown).toBe(true);
    expect(aw.lastSettledDay).toBeNull();
    expect(aw.windows.mPrior30.settledStrict).toBe(false);
    expect(aw.windows.mPrior30.settledPractical).toBe(true);
    expect(aw.windows.settledWeek.start).toBeNull();
  });
  it("no daily series → window unplaced, sub-windows null (never zero)", () => {
    const aw = computeAuditWindow([], [], []);
    expect(aw.source).toBe("none");
    expect(aw.windows.m30.start).toBeNull();
    const w = windowsFromDaily(null, aw, "campaignDailyMetrics");
    expect(w).toEqual({
      m30: null,
      mPrior30: null,
      m7: null,
      settledWeek: null,
      settledToDate: null,
    });
  });
});

describe("serving rules, negatives, dimensions", () => {
  it("sitelinks cumulative, the five documented types override, anything else UNKNOWN", () => {
    expect(overrideClassOf("SITELINK")).toBe("CUMULATIVE");
    for (const t of ["CALLOUT", "STRUCTURED_SNIPPET", "PROMOTION", "CALL", "PRICE"])
      expect(overrideClassOf(t)).toBe("OVERRIDE");
    for (const t of ["IMAGE", "LOCATION", "LEAD_FORM"]) expect(overrideClassOf(t)).toBe("UNKNOWN");
  });
  it("negative match semantics", () => {
    expect(
      negativeMatches("cheap canvas tote", {
        criterionId: null,
        text: "cheap",
        matchType: "BROAD",
      }),
    ).toBe(true);
    expect(
      negativeMatches("canvas tote cheap", {
        criterionId: null,
        text: '"cheap tote"',
        matchType: "PHRASE",
      }),
    ).toBe(false);
    expect(
      negativeMatches("cheap tote online", {
        criterionId: null,
        text: "cheap tote",
        matchType: "PHRASE",
      }),
    ).toBe(true);
    expect(
      negativeMatches("cheap tote", {
        criterionId: null,
        text: "[cheap tote]",
        matchType: "EXACT",
      }),
    ).toBe(true);
    expect(
      negativeMatches("cheap totes", { criterionId: null, text: "cheap tote", matchType: "EXACT" }),
    ).toBe(false);
  });
  it("listing group case_value parsing", () => {
    expect(parseDimension('{"productItemId":{"value":"11111111111111"}}')).toEqual({
      kind: "productItemId",
      value: "11111111111111",
    });
    expect(parseDimension('{"productCustomAttribute":{"index":"INDEX0"}}')).toEqual({
      kind: "productCustomAttribute",
      index: "INDEX0",
      value: null,
    });
    expect(parseDimension("")).toEqual({ kind: "root" });
    expect(parseDimension({ productBrand: { value: "X" } })).toEqual({
      kind: "productBrand",
      value: "X",
    });
  });
  it("channel classification and url keys", () => {
    expect(classifyChannel("SEARCH_PARTNERS")).toBe("shopping");
    expect(classifyChannel("YOUTUBE")).toBe("video_display");
    expect(classifyChannel("GMAIL")).toBe("video_display");
    expect(classifyChannel("MIXED")).toBe("unclassified");
    expect(urlKey("https://example.org/?utm_source=google")).toBe("example.org");
    expect(urlKey("https://Example.com/collections/totes/")).toBe("example.com/collections/totes");
    expect(urlKey("https://example.com/pages/edit{ignore}?utm_source=google")).toBe(
      "example.com/pages/edit",
    );
    expect(cleanPageUrl("https://example.com/pages/Edit%7Bignore%7D/?variant=1")).toBe(
      "https://example.com/pages/Edit",
    );
  });
});

describe("buildAccountModel on the synthetic snapshot", () => {
  const snap = buildSyntheticSnapshot(5);
  const model = buildAccountModel(snap.data, snap.dbTables, snap.auditId);

  it("builds one campaign node per campaigns row with shareOfParent summing to 1", () => {
    expect(model.children.campaigns.length).toBe(snap.data.campaigns!.length);
    const s = model.children.campaigns.reduce((a, c) => a + (c.shareOfParent.cost ?? 0), 0);
    expect(s).toBeCloseTo(1, 6);
    expect(model.windows.m90.provenance.table).toBe("campaigns");
  });
  it("sync markers: a table with an ok marker is checkable ok; unmarked tables are unknown", () => {
    const grid = model.dataQuality.tables["db:temporal_grid"]!;
    expect(grid.checkable).toBe("ok");
    expect(model.dataQuality.tables.campaigns!.checkable).toBe("unknown");
    expect(model.dataQuality.syncMarkersPresent).toBe(true);
  });
  it("coverage report has a row per AuditData key and flags unconsumed non-empty keys", () => {
    expect(model.coverage.keys.filter((k) => !k.key.startsWith("db:")).length).toBe(
      AUDIT_DATA_ARRAY_KEYS.length,
    );
    expect(model.coverage.unconsumedNonEmpty).toEqual([]);
    const data = { ...snap.data, keywords: [{ keyword_id: 1 }] } as AuditData;
    const report = buildCoverageReport(
      data,
      {},
      new Set(AUDIT_DATA_ARRAY_KEYS.filter((k) => k !== "keywords")),
    );
    expect(report.unconsumedNonEmpty).toEqual(["keywords"]);
    expect(Object.keys(COVERAGE_ALLOWLIST)).toEqual(
      expect.arrayContaining(["callData", "auctionInsights"]),
    );
    // Phase 11: the LSA keys are consumed by the model now, not allowlisted
    expect(Object.keys(COVERAGE_ALLOWLIST)).not.toContain("lsaLeads");
  });
  it("campaign negatives are null without a marker and [] with one", () => {
    const c0 = model.children.campaigns[0]!;
    const synced = model.dataQuality.campaignNegativesSynced;
    for (const c of model.children.campaigns) {
      if (synced.includes(c.id)) expect(c.children.negatives).toEqual(expect.any(Array));
      else expect(c.children.negatives).toBeNull();
    }
    expect(c0.children.productGroups).toBeNull();
  });
  it("legacy count columns make a table checkable ok when no marker exists", () => {
    const m = buildAccountModel(snap.data, snap.dbTables, snap.auditId, {
      legacyCounts: {
        campaigns_count: snap.data.campaigns!.length,
        search_terms_count: 0,
        some_other_count: 5,
      },
    });
    expect(m.dataQuality.tables.campaigns).toMatchObject({ checkable: "ok", source: "legacy" });
    expect(m.dataQuality.tables.searchTerms).toMatchObject({
      checkable: "ok",
      source: "legacy",
      markerRowCount: 0,
    });
    expect(m.dataQuality.tables.keywords!.checkable).toBe("unknown");
    expect(m.dataQuality.legacyCounts).toEqual({
      campaigns: snap.data.campaigns!.length,
      searchTerms: 0,
    });
  });

  it("product search terms: checkability comes from the marker, never rows.length (Phase 1b: campaign-grain rows, marker skipped)", () => {
    const shopId =
      snap.data.campaigns!.find((c: any) => c.type === "SHOPPING")?.campaign_id ??
      snap.data.campaigns![0]!.campaign_id;
    const shopAg = snap.data.adGroups!.find((g: any) => String(g.campaign_id) === String(shopId));
    const data = {
      ...snap.data,
      productSearchTerms: [
        {
          campaign_id: shopId,
          ad_group_id: shopAg?.ad_group_id ?? null,
          product_item_id: null,
          grain: "campaign_term",
          search_term: "brown tote",
          cost: "12.50",
          clicks: 10,
          impressions: 100,
          conversions: "1",
          conversion_value: "40",
        },
        {
          campaign_id: shopId,
          ad_group_id: null,
          product_item_id: null,
          grain: "campaign_term",
          search_term: "canvas tote",
          cost: "3",
          clicks: 2,
          impressions: 20,
          conversions: "0",
          conversion_value: "0",
        },
      ],
      products: [
        {
          product_id: "shopify_us_1_2",
          title: "P",
          clicks: 5,
          cost_micros: "1000000",
          conversions: "0",
          conversion_value: "0",
        },
      ],
    } as AuditData;
    const skipped = {
      ...snap.dbTables,
      sync_table_status: [
        ...snap.dbTables.sync_table_status!,
        {
          table_name: "product_search_terms",
          status: "skipped",
          row_count: 2,
          error_message: "skipped: API has no product×term segment",
        },
      ],
    };
    const m = buildAccountModel(data, skipped, snap.auditId);
    const product = m.children.products.find((p) => p.id === "shopify_us_1_2")!;
    expect(product.attrs.searchTerms).toBeNull();
    expect(
      product.notCheckable.find((n) => n.checkId === "product.search_terms")!.reason,
    ).toContain("skipped: API has no product×term segment");
    expect(m.attrs.productSearchTerms.synced).toBe(false);
    // the campaign-grain rows still attach — to the ad group they name, or the campaign
    const shop = m.index.campaignsById.get(String(shopId))!;
    const attached = [
      ...shop.children.searchTerms,
      ...shop.children.adGroups.flatMap((g) => g.children.searchTerms),
    ].filter((t) => t.attrs.source === "productSearchTerms");
    expect(attached.map((t) => t.attrs.term).sort()).toEqual(["brown tote", "canvas tote"]);
    expect(shop.children.searchTerms.map((t) => t.attrs.term)).toEqual(["canvas tote"]);
    // marker ok + product-grain rows → per-product terms attach
    const okTables = {
      ...snap.dbTables,
      sync_table_status: [
        ...snap.dbTables.sync_table_status!,
        { table_name: "product_search_terms", status: "ok", row_count: 1 },
      ],
    };
    const data2 = {
      ...data,
      productSearchTerms: [
        {
          campaign_id: shopId,
          product_item_id: "shopify_us_1_2",
          grain: "product_term",
          search_term: "p term",
          cost: "1",
          conversions: "0",
        },
      ],
    } as AuditData;
    const m2 = buildAccountModel(data2, okTables, snap.auditId);
    expect(m2.children.products.find((p) => p.id === "shopify_us_1_2")!.attrs.searchTerms).toEqual([
      { term: "p term", cost: 1, conv: 0 },
    ]);
    // rows present but NO marker → attached with a completeness note, never claimed complete
    const m3 = buildAccountModel(data2, snap.dbTables, snap.auditId);
    expect(
      m3.children.products
        .find((p) => p.id === "shopify_us_1_2")!
        .notCheckable.map((n) => n.reason)
        .join(" "),
    ).toContain("no status row");
  });

  it("Demand Gen audience signals: only negative=false rows attach, deduped per (ad group, criterion), ids never collide across ad groups", () => {
    const dgId = "dg1";
    const data = {
      ...snap.data,
      campaigns: [
        ...snap.data.campaigns!,
        {
          campaign_id: dgId,
          name: "DG test",
          type: "DEMAND_GEN",
          status: "ENABLED",
          cost: "10",
          clicks: "5",
          impressions: "100",
          conversions: "0",
          conversion_value: "0",
        },
      ],
    } as AuditData;
    const tables = {
      ...snap.dbTables,
      sync_table_status: [
        ...snap.dbTables.sync_table_status!,
        { table_name: "dg_audience_signals", status: "ok", row_count: 5 },
        {
          table_name: "dg_assets",
          status: "skipped",
          row_count: 0,
          error_message: "skipped: account has no DEMAND_GEN campaigns",
        },
      ],
      dg_audience_signals: [
        {
          campaign_id: dgId,
          ad_group_id: "ag1",
          criterion_id: "c1",
          user_list_name: "List 1",
          negative: false,
        },
        {
          campaign_id: dgId,
          ad_group_id: "ag1",
          criterion_id: "c1",
          user_list_name: "List 1",
          negative: false,
        }, // duplicate
        {
          campaign_id: dgId,
          ad_group_id: "ag2",
          criterion_id: "c1",
          user_list_name: "List 1",
          negative: false,
        }, // same criterion, other ad group
        {
          campaign_id: dgId,
          ad_group_id: "ag2",
          criterion_id: "c9",
          user_list_name: "Excluded",
          negative: true,
        }, // negative → not a signal
        { campaign_id: "other", ad_group_id: "agX", criterion_id: "c1", negative: false },
      ],
      dg_assets: [],
    };
    const m = buildAccountModel(data, tables, snap.auditId);
    const dg = m.index.campaignsById.get(dgId)!;
    const signals = dg.children.dgAudienceSignals!;
    expect(signals.length).toBe(2);
    expect(new Set(signals.map((s) => s.id)).size).toBe(2);
    expect(signals.map((s) => s.attrs.adGroupId).sort()).toEqual(["ag1", "ag2"]);
    expect(dg.attrs.demandGen).toEqual({ state: "not_synced" });
    // dg_assets marker skipped → null + the marker's message; not "no assets"
    expect(dg.children.dgAssets).toBeNull();
    expect(dg.notCheckable.find((n) => n.checkId === "DG02")!.reason).toContain(
      "skipped: account has no DEMAND_GEN campaigns",
    );
    expect(dg.notCheckable.find((n) => n.checkId === "DG01")!.reason).toContain("not loaded");
  });

  it("a campaign-level OVERRIDE asset is hidden only in the ad groups that carry their own set; PMax callouts with impressions are contradictions", () => {
    const cid = "multi";
    const ags = ["ag1", "ag2", "ag3", "ag4", "ag5"];
    const ext = (over: Partial<any>) => ({
      id: `${over.asset_id}-${over.ad_group_id ?? "c"}`,
      asset_id: over.asset_id,
      campaign_id: cid,
      extension_type: "CALLOUT",
      text: "Free Shipping",
      status: "ENABLED",
      impressions: 0,
      clicks: 0,
      cost: "0",
      conversions: "0",
      level: "CAMPAIGN",
      ad_group_id: null,
      ...over,
    });
    const pmaxId = snap.data.campaigns!.find((c: any) => c.type === "PERFORMANCE_MAX")!.campaign_id;
    const data = {
      ...snap.data,
      campaigns: [
        ...snap.data.campaigns!,
        {
          campaign_id: cid,
          name: "Multi",
          type: "SEARCH",
          status: "ENABLED",
          cost: "10",
          clicks: "1",
          impressions: "10",
          conversions: "0",
          conversion_value: "0",
        },
      ],
      adGroups: [
        ...snap.data.adGroups!,
        ...ags.map((g) => ({
          ad_group_id: g,
          campaign_id: cid,
          name: g,
          status: "ENABLED",
          cost: "2",
          clicks: "1",
          impressions: "2",
          conversions: "0",
        })),
      ],
      adExtensions: [
        ext({ asset_id: "A" }), // campaign-level callout
        ext({ asset_id: "B", level: "AD_GROUP", ad_group_id: "ag3" }), // one ad group brings its own callouts
        ext({ asset_id: "S", extension_type: "SITELINK" }), // cumulative, never overridden
        ext({ asset_id: "I", extension_type: "IMAGE" }), // unknown rule
        ext({ asset_id: "P", campaign_id: pmaxId, impressions: 12 }), // callout with impressions on PMax
      ],
    } as AuditData;
    const m = buildAccountModel(data, snap.dbTables, snap.auditId);
    const c = m.index.campaignsById.get(cid)!;
    const a = c.children.extensions.find((e) => e.id.includes(":A:"))!;
    expect(a.attrs.servedStatus).toBe("eligible_no_impressions");
    expect(a.attrs.overriddenInAdGroupIds).toEqual(["ag3"]);
    expect(a.attrs.servingInAdGroupIds).toEqual(["ag1", "ag2", "ag4", "ag5"]);
    expect(c.children.extensions.find((e) => e.id.includes(":S:"))!.attrs).toMatchObject({
      overrideClass: "CUMULATIVE",
      servedStatus: "eligible_no_impressions",
      overriddenInAdGroupIds: [],
    });
    expect(c.children.extensions.find((e) => e.id.includes(":I:"))!.attrs).toMatchObject({
      overrideClass: "UNKNOWN",
      servedStatus: "eligible_no_impressions",
    });
    const p = m.index.campaignsById
      .get(String(pmaxId))!
      .children.extensions.find((e) => e.id.includes(":P:"))!;
    expect(p.attrs.servedStatus).toBe("served_despite_rule");
    expect(m.dataQuality.contradictions).toEqual([
      expect.objectContaining({
        table: "adExtensions",
        rule: "PERFORMANCE_MAX never serves CALLOUT",
      }),
    ]);
    // single-ad-group campaign: overridden everywhere → 'overridden'
    const one = {
      ...data,
      adGroups: [
        ...snap.data.adGroups!,
        {
          ad_group_id: "ag3",
          campaign_id: cid,
          name: "ag3",
          status: "ENABLED",
          cost: "2",
          clicks: "1",
          impressions: "2",
          conversions: "0",
        },
      ],
    } as AuditData;
    const a1 = buildAccountModel(one, snap.dbTables, snap.auditId)
      .index.campaignsById.get(cid)!
      .children.extensions.find((e) => e.id.includes(":A:"))!;
    expect(a1.attrs.servedStatus).toBe("overridden");
    expect(a1.attrs.servingInAdGroupIds).toEqual([]);
  });

  it("account-level attributes over an empty attached population are null, never 0", () => {
    const data = {
      ...snap.data,
      adPolicyData: Array.from({ length: 500 }, (_, i) => ({
        ad_id: `orphan-${i}`,
        approval_status: "APPROVED",
      })),
    } as AuditData;
    const m = buildAccountModel(data, snap.dbTables, snap.auditId);
    expect(m.attrs.adPolicy).toEqual({
      rows: 500,
      sample: false,
      population: 0,
      notApproved: null,
    }); // no cap on the policy table since 2026-09-07
    expect(m.notCheckable.find((n) => n.checkId === "SK15")!.reason).toContain("population 0");
    expect(m.dataQuality.orphanRows.adPolicyData).toBe(500);
  });

  it("an empty AuditData still builds an account node with everything unknown", () => {
    const empty: any = {
      currencyCode: "USD",
      customerId: null,
      profile: null,
      merchantCenterConnected: false,
      optimizationScore: null,
    };
    for (const k of AUDIT_DATA_ARRAY_KEYS) empty[k] = [];
    const m = buildAccountModel(empty as AuditData, {}, "x");
    expect(m.children.campaigns).toEqual([]);
    expect(m.windows.m90.cost).toBeNull();
    expect(m.windows.m30).toBeNull();
    expect(m.window.lookbackUnknown).toBe(true);
    expect(m.notCheckable.map((n) => n.checkId)).toEqual(
      expect.arrayContaining(["window.maturity", "window.calendar", "sync.markers"]),
    );
    expect(m.dataQuality.tables.campaigns!.checkable).toBe("unknown");
  });
});
