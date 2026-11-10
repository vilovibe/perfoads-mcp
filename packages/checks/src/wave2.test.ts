// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Wave 2 checks on synthetic accounts: Performance Max, trends, slices, presence, the
// carried-in checks and the cross-tree checks. Every number is made up.

import { describe, expect, it } from "vitest";
import { runChecks, type EvidenceInput } from "./api.js";
import type { CheckResult } from "./engine/checks/types.js";
import type { Row } from "./engine/shared/input.js";
import { PRIOR_YEAR_DAILY_TABLE } from "./engine/model/context.js";
import { classifyChannel } from "./engine/model/buildPmaxTree.js";
import { DEFAULT_SETTINGS, validateSettings } from "./engine/settings.js";
import { PX14_TITLE_ONE_LIVE, PX19_TITLE_LISTED } from "./engine/checks/pmax.js";
import { TR10_TITLE_LEARNING } from "./engine/checks/trends.js";
import { px13Title } from "./engine/checks/carriedIn.js";
import {
  adGroup,
  buildInput,
  checkCtxOf,
  dayBefore,
  keyword,
  LAST_DAY,
  runOne,
  searchTerm,
  type CampaignSpec,
  type FixtureOptions,
} from "./testing/account.js";

const state = (r: CheckResult) => r.state;
const findingsOf = (r: CheckResult) => (r.state === "fires" ? r.findings : []);

/** Read statuses for named tables (they have no AccountData key). */
function withStatus(input: EvidenceInput, tables: Record<string, number>): EvidenceInput {
  return {
    ...input,
    statusRows: [
      ...(input.statusRows ?? []),
      ...Object.entries(tables).map(([table_name, row_count]) => ({
        table_name,
        status: "ok",
        row_count,
        error_message: null,
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Performance Max fixtures
// ---------------------------------------------------------------------------

const PMAX: CampaignSpec = {
  id: "41",
  name: "PMax all products",
  type: "PERFORMANCE_MAX",
  cost: 50,
  conv: 2,
  value: 400,
  clicks: 40,
  impressions: 2000,
};

const group = (
  id: string,
  o: {
    status?: string;
    cost?: number;
    conv?: number;
    value?: number;
    clicks?: number;
    strength?: string;
  } = {},
): Row => ({
  asset_group_id: id,
  campaign_id: "41",
  name: `Group ${id}`,
  status: o.status ?? "ENABLED",
  ad_strength: o.strength ?? "EXCELLENT",
  cost: o.cost ?? 1000,
  clicks: o.clicks ?? 500,
  impressions: 10_000,
  conversions: o.conv ?? 20,
  conversion_value: o.value ?? 4000,
});

const asset = (groupId: string, field: string, n: number, extra: Row = {}): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    asset_group_id: groupId,
    asset_id: `${groupId}${field}${i}`,
    field_type: field,
    asset_text: field.includes("IMAGE") || field === "YOUTUBE_VIDEO" ? null : `${field} text ${i}`,
    status: "ENABLED",
    primary_status: "ELIGIBLE",
    image_width_px: field.includes("IMAGE") ? 1200 : null,
    image_height_px: field.includes("IMAGE") ? 1200 : null,
    ...extra,
  }));

/** A full asset set: 11 headlines, 5 long headlines, 4 descriptions, a video, 15 images. */
const fullAssets = (groupId: string): Row[] => [
  ...asset(groupId, "HEADLINE", 11),
  ...asset(groupId, "LONG_HEADLINE", 5),
  ...asset(groupId, "DESCRIPTION", 4),
  ...asset(groupId, "YOUTUBE_VIDEO", 1),
  ...asset(groupId, "MARKETING_IMAGE", 5),
  ...asset(groupId, "SQUARE_MARKETING_IMAGE", 5),
  ...asset(groupId, "PORTRAIT_MARKETING_IMAGE", 5),
];

const signals = (groupId: string): Row[] => [
  { asset_group_id: groupId, search_theme: "running shoes", approval_status: "APPROVED" },
  {
    asset_group_id: groupId,
    audience: "customers/1234567890/audiences/77",
    approval_status: "APPROVED",
  },
];

function pmaxAccount(
  o: {
    groups?: Row[];
    assets?: Row[];
    signals?: Row[];
    listing?: Row[];
    channels?: Row[];
    insights?: Row[];
    controls?: Row[];
    placements?: Row[];
    extra?: Partial<FixtureOptions>;
    campaigns?: CampaignSpec[];
  } = {},
): EvidenceInput {
  const groups = o.groups ?? [group("51")];
  const input = buildInput({
    campaigns: o.campaigns ?? [PMAX],
    data: {
      assetGroups: groups,
      pmaxAssets: o.assets ?? groups.flatMap((g) => fullAssets(String(g.asset_group_id))),
      pmaxSignals: o.signals ?? groups.flatMap((g) => signals(String(g.asset_group_id))),
      ...(o.listing ? { pmaxListingGroups: o.listing } : {}),
      ...(o.channels ? { pmaxChannelDistribution: o.channels } : {}),
      ...(o.insights ? { pmaxSearchInsights: o.insights } : {}),
      ...(o.extra?.data ?? {}),
    },
    tables: {
      ...(o.controls ? { campaign_control_settings: o.controls } : {}),
      ...(o.placements ? { pmax_placements: o.placements } : {}),
      ...(o.extra?.tables ?? {}),
    },
    syncedEmpty: ["pmaxListingGroups", "pmaxChannelDistribution", "pmaxSearchInsights"],
    ...(o.extra?.settings ? { settings: o.extra.settings } : {}),
  });
  return withStatus(input, {
    ...(o.controls ? { campaign_control_settings: o.controls.length } : {}),
    ...(o.placements ? { pmax_placements: o.placements.length } : {}),
  });
}

const channel = (net: string, cost: number): Row => ({
  campaign_id: "41",
  ad_network_type: net,
  cost,
  clicks: 100,
  impressions: 5000,
  conversions: 5,
  conversion_value: cost * 3,
});

describe("PX01 Performance Max spending mostly off Search and Shopping", () => {
  it("fires when most of the spend is on Display and YouTube", () => {
    const r = runOne(
      "PX01",
      pmaxAccount({ channels: [channel("SEARCH", 500), channel("CONTENT", 2500)] }),
    );
    expect(findingsOf(r)[0]?.scope.id).toBe("41");
  });
  it("is clean when Search and Shopping carry most of it, and the bar is a setting", () => {
    const rows = [channel("SEARCH", 2000), channel("CONTENT", 1000)];
    expect(state(runOne("PX01", pmaxAccount({ channels: rows })))).toBe("none_found");
    const strict = pmaxAccount({
      channels: rows,
      extra: { settings: { pmax: { shoppingShareMinPct: 80 } } },
    });
    expect(state(runOne("PX01", strict))).toBe("fires");
  });
  it("is not checkable with no channel rows", () => {
    expect(state(runOne("PX01", pmaxAccount()))).toBe("not_checkable");
  });
  it("prices only the spend off Search/Shopping, never the whole campaign", () => {
    // live: 251.71 spent, 39.5% on Shopping; the waste is the Display/YouTube part
    const rows = [channel("SEARCH", 99.43), channel("YOUTUBE", 90), channel("CONTENT", 62.28)];
    const f = findingsOf(runOne("PX01", pmaxAccount({ channels: rows })))[0];
    expect(f?.facts.shopping_share_pct).toBeCloseTo(39.5, 1);
    expect(f?.facts.wasted_cost_90d).toBeCloseTo(152.28, 2);
    expect(Number(f?.facts.wasted_cost_90d)).toBeLessThan(251.71);
    // the money is that spend over the 3 months of the window, not the campaign's spend
    const scored = runChecks(pmaxAccount({ channels: rows })).findings.find(
      (x) => x.checkId === "PX01",
    );
    expect(scored?.impact.value).toBeCloseTo(152.28 / 3, 2);
  });
});

const category = (label: string, clicks: number): Row => ({
  campaign_id: "41",
  category_label: label,
  clicks,
  impressions: clicks * 20,
  conversions: 1,
  conversions_value: 100,
});

describe("PX02 (profile set)", () => {
  const brandSearch: CampaignSpec = { id: "12", name: "Brand search", cost: 10 };
  const make = (rows: Row[]) => {
    const input = pmaxAccount({ campaigns: [PMAX, brandSearch], insights: rows });
    return {
      ...input,
      data: { ...input.data, profile: { brandTerms: ["Acme"], businessType: "ecommerce" } },
    };
  };
  it("fires when brand categories take more than the bar", () => {
    const r = runOne("PX02", make([category("acme boots", 80), category("running shoes", 20)]));
    expect(findingsOf(r)[0]?.facts.brand_click_share_pct).toBe(80);
  });
  it("is clean when brand is a small share", () => {
    const r = runOne("PX02", make([category("acme boots", 5), category("running shoes", 95)]));
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable with no categories", () => {
    expect(state(runOne("PX02", make([])))).toBe("not_checkable");
  });
  it("names the brand Search campaign, or '' and a note when there is none", () => {
    const rows = [category("acme boots", 80), category("running shoes", 20)];
    expect(findingsOf(runOne("PX02", make(rows)))[0]?.facts.brand_search_campaign).toBe(
      "Brand search",
    );
    const input = pmaxAccount({ campaigns: [PMAX], insights: rows });
    const r = runOne("PX02", {
      ...input,
      data: { ...input.data, profile: { brandTerms: ["Acme"], businessType: "ecommerce" } },
    });
    expect(findingsOf(r)[0]?.facts.brand_search_campaign).toBe("");
    expect(findingsOf(r)[0]?.note).toContain("no brand Search campaign found");
  });
});

describe("PX03 asset group short of a full set", () => {
  it("fires on a group with 5 headlines", () => {
    const assets = [
      ...fullAssets("51").filter((a) => a.field_type !== "HEADLINE"),
      ...asset("51", "HEADLINE", 5),
    ];
    const r = runOne("PX03", pmaxAccount({ assets }));
    expect(findingsOf(r)[0]?.facts.gaps).toEqual({ headlines: 6 });
  });
  it("is clean on a full set, and the headline bar is a setting", () => {
    expect(state(runOne("PX03", pmaxAccount()))).toBe("none_found");
    const strict = pmaxAccount({ extra: { settings: { pmax: { minHeadlines: 15 } } } });
    expect(state(runOne("PX03", strict))).toBe("fires");
  });
  it("never judges a feed-only group (images only, no text)", () => {
    const r = runOne("PX03", pmaxAccount({ assets: asset("51", "MARKETING_IMAGE", 3) }));
    expect(r).toMatchObject({ state: "not_checkable", category: "not_present" });
  });
  it("is not checkable when no asset row was read", () => {
    expect(state(runOne("PX03", pmaxAccount({ assets: [] })))).toBe("not_checkable");
  });
});

describe("PX06 asset group without signals", () => {
  it("fires on a spending group with no search theme", () => {
    const r = runOne(
      "PX06",
      pmaxAccount({
        groups: [group("51"), group("52")],
        signals: [...signals("51"), ...signals("52").slice(1)],
      }),
    );
    expect(findingsOf(r).map((f) => f.scope.id)).toEqual(["52"]);
  });
  it("is clean when every group has both", () => {
    expect(state(runOne("PX06", pmaxAccount()))).toBe("none_found");
  });
  it("is not checkable when no signal row was read at all", () => {
    expect(state(runOne("PX06", pmaxAccount({ signals: [] })))).toBe("not_checkable");
  });
});

const controls = (o: Row): Row[] => [{ campaign_id: "41", ...o }];
const automation = (type: string, status: string) => [
  { asset_automation_type: type, asset_automation_status: status },
];

describe("PX08 auto-generated assets (a note)", () => {
  it("states the opted-in types", () => {
    const r = runOne(
      "PX08",
      pmaxAccount({
        controls: controls({
          asset_automation: JSON.stringify(automation("GENERATE_IMAGE_EXTRACTION", "OPTED_IN")),
        }),
      }),
    );
    expect(String(findingsOf(r)[0]?.facts.opted_in_types)).toMatch(/^GENERATE_IMAGE_EXTRACTION, /);
  });
  it("applies Google's documented Performance Max defaults to a type with no entry", () => {
    const r = runOne(
      "PX08",
      pmaxAccount({
        controls: controls({
          asset_automation: JSON.stringify(automation("GENERATE_IMAGE_EXTRACTION", "OPTED_OUT")),
        }),
      }),
    );
    expect(findingsOf(r)[0]?.facts.on_by_google_default).toBe(
      "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION, TEXT_ASSET_AUTOMATION, GENERATE_ENHANCED_YOUTUBE_VIDEOS, GENERATE_IMAGE_ENHANCEMENT",
    );
  });
  const allOff = (withExtraction: boolean) =>
    JSON.stringify(
      [
        "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION",
        "TEXT_ASSET_AUTOMATION",
        "GENERATE_ENHANCED_YOUTUBE_VIDEOS",
        "GENERATE_IMAGE_ENHANCEMENT",
        ...(withExtraction ? ["GENERATE_IMAGE_EXTRACTION"] : []),
      ].map((t) => ({ asset_automation_type: t, asset_automation_status: "OPTED_OUT" })),
    );
  it("is clean when every automation is set off", () => {
    const r = runOne(
      "PX08",
      pmaxAccount({ controls: controls({ asset_automation: allOff(true) }) }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("image extraction with no entry follows an account setting not read: unknown, never off", () => {
    const r = runOne(
      "PX08",
      pmaxAccount({ controls: controls({ asset_automation: allOff(false) }) }),
    );
    expect(r).toMatchObject({ state: "not_checkable", category: "our_gap" });
  });
  it("is not checkable when the settings were not read", () => {
    expect(state(runOne("PX08", pmaxAccount()))).toBe("not_checkable");
  });
});

describe("PX09 asset groups rated poor", () => {
  it("fires on a POOR group with traffic", () => {
    const r = runOne("PX09", pmaxAccount({ groups: [group("51", { strength: "POOR" })] }));
    expect(findingsOf(r)[0]?.rows?.[0]?.cells.ad_strength).toBe("POOR");
  });
  it("is clean on EXCELLENT", () => {
    expect(state(runOne("PX09", pmaxAccount()))).toBe("none_found");
  });
  it("is not checkable under the click floor", () => {
    const r = runOne(
      "PX09",
      pmaxAccount({ groups: [group("51", { strength: "POOR", clicks: 20 })] }),
    );
    expect(state(r)).toBe("not_checkable");
  });
});

const EXPANSION = "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION";

describe("PX10 final URL expansion (a note) and PX20 legal pages", () => {
  const on = (exclusions: unknown) =>
    pmaxAccount({
      controls: controls({
        asset_automation: JSON.stringify(automation(EXPANSION, "OPTED_IN")),
        url_exclusions: JSON.stringify(exclusions),
      }),
    });
  it("PX10 states expansion on; is clean when off; not checkable when unknown", () => {
    expect(state(runOne("PX10", on([])))).toBe("fires");
    const off = pmaxAccount({
      controls: controls({ asset_automation: JSON.stringify(automation(EXPANSION, "OPTED_OUT")) }),
    });
    expect(state(runOne("PX10", off))).toBe("none_found");
    expect(state(runOne("PX10", pmaxAccount({ controls: controls({}) })))).toBe("not_checkable");
  });
  it("PX10: no expansion entry is Google's documented Performance Max default (on)", () => {
    const r = runOne("PX10", pmaxAccount({ controls: controls({ asset_automation: "[]" }) }));
    expect(findingsOf(r)[0]?.facts.on_by_google_default).toBe(true);
  });
  it("PX20 fires when legal pages are not excluded and is clean when every rule is covered", () => {
    expect(findingsOf(runOne("PX20", on([])))[0]?.facts.missing_url_exclusions).toBeGreaterThan(50);
    // one short CONTAINS argument covers every fragment that contains it
    const all = [
      {
        criterionId: "1",
        name: null,
        conditions: [
          ..."/abcdefghijklmnopqrstuvwxyz-"
            .split("")
            .map((ch) => ({ operand: "URL", operator: "CONTAINS", argument: ch })),
        ],
      },
    ];
    expect(state(runOne("PX20", on(all)))).toBe("none_found");
  });
  it("PX20 is not checkable when the exclusions were not read", () => {
    const r = runOne(
      "PX20",
      pmaxAccount({
        controls: controls({ asset_automation: JSON.stringify(automation(EXPANSION, "OPTED_IN")) }),
      }),
    );
    expect(state(r)).toBe("not_checkable");
  });
});

describe("PX14 one asset group carries the campaign", () => {
  const campaign: CampaignSpec = { ...PMAX, cost: 100 }; // 9,000 over 90 days
  it("fires when the busy group returns less than its live siblings", () => {
    const r = runOne(
      "PX14",
      pmaxAccount({
        campaigns: [campaign],
        groups: [
          group("51", { cost: 8500, value: 8500, conv: 40 }),
          group("52", { cost: 500, value: 2500, conv: 20 }),
        ],
      }),
    );
    expect(findingsOf(r)[0]?.scope.id).toBe("51");
  });
  it("is clean when the busy group earns as much", () => {
    const r = runOne(
      "PX14",
      pmaxAccount({
        campaigns: [campaign],
        groups: [
          group("51", { cost: 8500, value: 40_000, conv: 40 }),
          group("52", { cost: 500, value: 1500, conv: 20 }),
        ],
      }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable with one asset group", () => {
    expect(state(runOne("PX14", pmaxAccount({ campaigns: [campaign] })))).toBe("not_checkable");
  });
  it("R4: one live group with every other group paused says so, never 'carries most'", () => {
    const r = runOne(
      "PX14",
      pmaxAccount({
        campaigns: [campaign],
        groups: [
          group("51", { cost: 9000, value: 9000, conv: 40 }),
          group("52", { status: "PAUSED", cost: 0, value: 0, conv: 0 }),
          group("53", { status: "PAUSED", cost: 0, value: 0, conv: 0 }),
        ],
      }),
    );
    const f = findingsOf(r)[0];
    expect(f?.facts.live_groups).toBe(1);
    expect(f?.title).toBe(PX14_TITLE_ONE_LIVE);
  });
});

describe("PX17 disapproved assets", () => {
  it("fires on a disapproved headline", () => {
    const assets = [
      ...fullAssets("51"),
      ...asset("51", "HEADLINE", 1, { asset_id: "bad", primary_status: "DISAPPROVED" }),
    ];
    const r = runOne("PX17", pmaxAccount({ assets }));
    expect(findingsOf(r)[0]?.facts.refused_assets).toBe(1);
  });
  it("is clean when nothing is refused", () => {
    expect(state(runOne("PX17", pmaxAccount()))).toBe("none_found");
  });
  it("is not checkable with no asset rows", () => {
    expect(state(runOne("PX17", pmaxAccount({ assets: [] })))).toBe("not_checkable");
  });
});

const listing = (id: string, type: string, parent: string | null, caseValue: unknown): Row => ({
  asset_group_id: "51",
  listing_group_id: id,
  parent_listing_group_id: parent ? `51~${parent}` : null,
  type,
  case_value: JSON.stringify(caseValue),
});

describe("PX18 one bucket for the whole catalogue", () => {
  it("fires on one live group with a single included root", () => {
    const r = runOne("PX18", pmaxAccount({ listing: [listing("1", "UNIT_INCLUDED", null, {})] }));
    expect(state(r)).toBe("fires");
  });
  it("is clean when the products are split", () => {
    const r = runOne(
      "PX18",
      pmaxAccount({
        listing: [
          listing("1", "SUBDIVISION", null, {}),
          listing("2", "UNIT_INCLUDED", "1", { productType: { level: "LEVEL1", value: "boots" } }),
          listing("3", "UNIT_INCLUDED", "1", { productType: { level: "LEVEL1" } }),
        ],
      }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable on a campaign with no product selection", () => {
    expect(state(runOne("PX18", pmaxAccount()))).toBe("not_checkable");
  });
});

const placement = (name: string, type: string, impressions: number): Row => ({
  campaign_id: "41",
  placement: name,
  placement_type: type,
  display_name: name,
  target_url: null,
  impressions,
});

describe("PX19 Performance Max in mobile apps", () => {
  it("fires when apps take a big share of the listed impressions", () => {
    const r = runOne(
      "PX19",
      pmaxAccount({
        placements: [
          placement("mobileapp::2-123", "MOBILE_APPLICATION", 3000),
          placement("example.com", "WEBSITE", 1000),
        ],
      }),
    );
    expect(findingsOf(r)[0]?.facts.app_share_of_listed_placements_pct).toBe(75);
    // 3,000 of the campaign's 180,000 impressions: a big share of the listed places only
    expect(findingsOf(r)[0]?.title).toBe(PX19_TITLE_LISTED);
  });
  it("R4: apps a big share of all its impressions keep the check's own words", () => {
    const r = runOne(
      "PX19",
      pmaxAccount({
        campaigns: [{ ...PMAX, impressions: 50 }],
        placements: [
          placement("mobileapp::2-123", "MOBILE_APPLICATION", 3000),
          placement("example.com", "WEBSITE", 1000),
        ],
      }),
    );
    const f = findingsOf(r)[0];
    expect(Number(f?.facts.app_share_of_impressions_pct)).toBeGreaterThan(30);
    expect(f?.title).toBeUndefined();
  });
  it("is clean when apps barely show", () => {
    const r = runOne(
      "PX19",
      pmaxAccount({ placements: [placement("example.com", "WEBSITE", 5000)] }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when the placements were not read", () => {
    expect(state(runOne("PX19", pmaxAccount()))).toBe("not_checkable");
  });
});

describe("PX21 Performance Max blocking no search", () => {
  const negTables = (rows: Row[]) => ({
    campaign_negatives: rows,
    campaign_negatives_sync_marker: [{ campaign_id: "41" }],
  });
  const make = (rows: Row[]) => {
    const input = pmaxAccount({
      extra: { tables: negTables(rows) },
    });
    return withStatus(
      {
        ...input,
        statusRows: [
          ...(input.statusRows ?? []),
          { table_name: "shared_negative_lists", status: "ok", row_count: 0, error_message: null },
          { table_name: "account_negatives", status: "ok", row_count: 0, error_message: null },
        ],
      },
      { campaign_negatives: rows.length, campaign_negatives_sync_marker: 1 },
    );
  };
  it("fires on a campaign with no blocks at all (a note-level finding)", () => {
    const r = runOne("PX21", make([]));
    expect(findingsOf(r)[0]?.maxSeverity).toBe("info");
  });
  it("is clean when the campaign blocks searches of its own", () => {
    const r = runOne(
      "PX21",
      make([{ campaign_id: "41", criterion_id: "9", text: "jobs", match_type: "BROAD" }]),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable on a brand-only account", () => {
    const r = runOne("PX21", pmaxAccount({ campaigns: [{ ...PMAX, name: "Brand PMax" }] }));
    expect(state(r)).not.toBe("none_found");
  });
});

describe("PX13 image set", () => {
  it("fires on a group with 3 images", () => {
    const assets = [
      ...fullAssets("51").filter((a) => !String(a.field_type).includes("IMAGE")),
      ...asset("51", "MARKETING_IMAGE", 3),
    ];
    expect(findingsOf(runOne("PX13", pmaxAccount({ assets })))[0]?.facts.images).toBe(3);
  });
  it("fires on small images and is clean on a full set of big ones", () => {
    expect(state(runOne("PX13", pmaxAccount()))).toBe("none_found");
    const small = pmaxAccount({ extra: { settings: { pmax: { minImagePx: 2000 } } } });
    expect(state(runOne("PX13", small))).toBe("fires");
  });
  it("says what it found: too few images, or a full set with images below the minimum size", () => {
    const small = pmaxAccount({ extra: { settings: { pmax: { minImagePx: 2000 } } } });
    const f = findingsOf(runOne("PX13", small))[0];
    expect(f?.title).toBe(px13Title(false, Number(f?.facts.below_minimum_size)));
    expect(f?.title).toMatch(/below the minimum size$/);
    expect(px13Title(false, 1)).toBe("asset group has an image below the minimum size");
    expect(px13Title(true, 1)).toBe(
      "asset group has too few images, and one is below the minimum size",
    );
    expect(px13Title(true, 3)).toBe(
      "asset group has too few images, and some are below the minimum size",
    );
    const assets = [
      ...fullAssets("51").filter((a) => !String(a.field_type).includes("IMAGE")),
      ...asset("51", "MARKETING_IMAGE", 3),
    ];
    expect(findingsOf(runOne("PX13", pmaxAccount({ assets })))[0]?.title).toBe(
      "asset group has fewer images than recommended",
    );
  });
  it("is not checkable on a feed-only group", () => {
    const assets = asset("51", "MARKETING_IMAGE", 2);
    expect(state(runOne("PX13", pmaxAccount({ assets })))).toBe("not_checkable");
  });
});

describe("Performance Max search categories without a label", () => {
  it("names an empty or spaces-only label (unlabelled), and keeps a real one", () => {
    const input = pmaxAccount({
      insights: [category("", 5), category("  ", 4), category(" rain jackets ", 3)],
    });
    const pmax = checkCtxOf(input).model.children.campaigns.find((c) => c.id === "41");
    if (!pmax) throw new Error("PMax campaign 41 missing");
    expect(pmax.children.searchCategories.map((c) => c.name)).toEqual([
      "(unlabelled)",
      "(unlabelled)",
      " rain jackets ",
    ]);
  });
});

describe("PX12 Performance Max categories overlap a Search campaign", () => {
  const search: CampaignSpec = { id: "11", name: "Generic search" };
  const make = (label: string) =>
    pmaxAccount({
      campaigns: [PMAX, search],
      insights: [category(label, 50)],
      extra: {
        data: {
          adGroups: [adGroup({ id: "21", campaignId: "11" })],
          keywords: [keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "trail shoes" })],
          searchTerms: [searchTerm({ campaignId: "11", adGroupId: "21", term: "trail shoes" })],
        },
      },
    });
  it("fires when a category is a Search campaign's keyword", () => {
    expect(findingsOf(runOne("PX12", make("trail shoes")))[0]?.scope.id).toBe("41");
  });
  it("is clean when no category overlaps", () => {
    expect(state(runOne("PX12", make("rain coats")))).toBe("none_found");
  });
  it("is not checkable with no category rows", () => {
    expect(state(runOne("PX12", pmaxAccount({ campaigns: [PMAX, search] })))).toBe("not_checkable");
  });
});

// ---------------------------------------------------------------------------
// trends
// ---------------------------------------------------------------------------

/** A campaign whose last 30 days return `recent` against `prior` before. */
function trendAccount(recent: number, prior: number, extra: Partial<FixtureOptions> = {}) {
  const input = buildInput({ campaigns: [{ id: "11", cost: 100, conv: 2, value: 400 }], ...extra });
  const daily: Row[] = (input.data.campaignDailyMetrics ?? []).map((d) => {
    const ageDays =
      (Date.parse(`${LAST_DAY}T00:00:00Z`) - Date.parse(`${d.metric_date}T00:00:00Z`)) / 86_400_000;
    const value = ageDays < 30 ? recent * 100 : prior * 100;
    return { ...d, conversion_value: value };
  });
  const account: Row[] = (input.data.dailyMetrics ?? []).map((d) => ({
    ...d,
    conversion_value: daily.find((x) => x.metric_date === d.metric_date)?.conversion_value ?? 0,
  }));
  return { ...input, data: { ...input.data, campaignDailyMetrics: daily, dailyMetrics: account } };
}

describe("TR01 / TR01a decline", () => {
  it("fires on a 50% fall and is clean on a flat line", () => {
    expect(state(runOne("TR01", trendAccount(2, 4)))).toBe("fires");
    expect(state(runOne("TR01a", trendAccount(2, 4)))).toBe("fires");
    expect(state(runOne("TR01", trendAccount(4, 4)))).toBe("none_found");
    expect(state(runOne("TR01a", trendAccount(4, 4)))).toBe("none_found");
  });
  it("prices a decline in spend, never above the campaign's own spend", () => {
    const input = trendAccount(2, 4);
    const raw = findingsOf(runOne("TR01", input))[0];
    const tr01 = runChecks(input).findings.find((f) => f.checkId === "TR01");
    const spend = raw?.facts.spend_monthly as number;
    // half the return: half the spend bought nothing the earlier rate needed it for
    expect(tr01?.impact.value).toBeCloseTo(spend * (1 - 2 / 4), 1);
    expect(tr01?.impact.value).toBeLessThan(spend);
    expect(tr01?.impact.kind).toBe("at_risk");
    const tr01a = runChecks(input).findings.find((f) => f.checkId === "TR01a");
    expect(tr01a?.impact.value).toBeLessThan(tr01a?.facts.spend_monthly as number);
  });
  it("TR01a ranks campaigns by spend gap, not by sales-value gap (a big Shopping campaign over Brand)", () => {
    // Brand: 15x -> 6.5x on ~1,000 a month (spend gap ~567, old sales gap ~8,500).
    // Product PMax: 2.8x -> 1.68x on 7,000 a month (spend gap 2,800, old sales gap 7,840).
    const roasOf: Record<string, [number, number]> = { "1": [15, 6.5], "2": [2.8, 1.68] };
    const input = buildInput({
      campaigns: [
        { id: "1", name: "Brand", cost: 1000 / 30, conv: 5 },
        { id: "2", name: "Product PMax", cost: 7000 / 30, conv: 5 },
      ],
    });
    const daily: Row[] = (input.data.campaignDailyMetrics ?? []).map((d) => {
      const ageDays =
        (Date.parse(`${LAST_DAY}T00:00:00Z`) - Date.parse(`${d.metric_date}T00:00:00Z`)) /
        86_400_000;
      const [before, now] = roasOf[String(d.campaign_id)] ?? [1, 1];
      return { ...d, conversion_value: (d.cost as number) * (ageDays < 30 ? now : before) };
    });
    const account: Row[] = (input.data.dailyMetrics ?? []).map((d) => ({
      ...d,
      conversion_value: daily
        .filter((x) => x.metric_date === d.metric_date)
        .reduce((a, x) => a + (x.conversion_value as number), 0),
    }));
    const r = runOne("TR01a", {
      ...input,
      data: { ...input.data, campaignDailyMetrics: daily, dailyMetrics: account },
    });
    const f = findingsOf(r)[0];
    expect(f?.facts.worst_campaign).toBe("Product PMax");
    expect(f?.facts.worst_campaign_spend_gap as number).toBeCloseTo(2800, -1);
    const gaps = (f?.rows ?? []).map((row) => [row.entity.name, row.cells.spend_gap]);
    expect(gaps[0]?.[0]).toBe("Product PMax");
    expect(gaps[1]?.[0]).toBe("Brand");
    expect(gaps[1]?.[1] as number).toBeCloseTo(567, -1);
  });
  it("the decline bar is a setting", () => {
    const loose = { settings: { trends: { declinePct: 60 } } };
    expect(state(runOne("TR01", trendAccount(2, 4, loose)))).toBe("none_found");
  });
  it("is not checkable or thin with a short series", () => {
    const short = buildInput({ campaigns: [{ id: "11", days: 5 }] });
    expect(["insufficient_data", "not_checkable"]).toContain(state(runOne("TR01", short)));
    expect(["insufficient_data", "not_checkable"]).toContain(state(runOne("TR01a", short)));
  });
  it("TR01a counts the real days and names the conversion floor when return is unknown", () => {
    const reasonOf = (r: CheckResult) => (r.state === "insufficient_data" ? r.reason : "");
    // 14 days of spend: the days are counted, never "0 rows"
    const young = runOne("TR01a", buildInput({ campaigns: [{ id: "11", days: 14 }] }));
    expect(reasonOf(young)).toContain("14 days of data in the last 30");
    // 60 days, 5 conversions in each period: under the conversion floor
    const thin = runOne("TR01a", buildInput({ campaigns: [{ id: "11", days: 60, conv: 1 / 6 }] }));
    expect(reasonOf(thin)).toContain("conversions, below the");
  });
});

/**
 * One campaign whose daily spend and return per $1 step from `before` (31-60 days ago) to
 * `now` (the last 30 days): [spend a day, return per $1].
 */
function salesAccount(
  before: [number, number],
  now: [number, number],
  extra: Partial<FixtureOptions> = {},
) {
  const input = buildInput({
    campaigns: [{ id: "11", name: "Product PMax", cost: before[0], conv: 5 }],
    ...extra,
  });
  const daily: Row[] = (input.data.campaignDailyMetrics ?? []).map((d) => {
    const ageDays =
      (Date.parse(`${LAST_DAY}T00:00:00Z`) - Date.parse(`${d.metric_date}T00:00:00Z`)) / 86_400_000;
    const [cost, roas] = ageDays < 30 ? now : before;
    return { ...d, cost, conversion_value: cost * roas };
  });
  const account: Row[] = (input.data.dailyMetrics ?? []).map((d) => {
    const x = daily.find((r) => r.metric_date === d.metric_date);
    return { ...d, cost: x?.cost ?? 0, conversion_value: x?.conversion_value ?? 0 };
  });
  return { ...input, data: { ...input.data, campaignDailyMetrics: daily, dailyMetrics: account } };
}

describe("TR09 sales fell while the return held (R4)", () => {
  // a product PMax: $15.1k at $2.78 per $1 ($41.9k) -> $12.4k at $2.41 ($29.8k) a month
  const mugs = salesAccount([15_100 / 30, 2.78], [12_400 / 30, 2.41]);
  it("fires on the product PMax numbers: sales -29%, return -13% (under TR01's 20% bar)", () => {
    const f = findingsOf(runOne("TR09", mugs))[0];
    expect(f?.scope.name).toBe("Product PMax");
    expect(f?.facts.sales_value_prior30 as number).toBeCloseTo(41_978, -1);
    expect(f?.facts.sales_value_30d as number).toBeCloseTo(29_884, -1);
    expect(f?.facts.sales_change_pct as number).toBeCloseTo(-28.8, 0);
    expect(f?.facts.roas_change_pct as number).toBeCloseTo(-13.3, 0);
    expect(f?.facts.spend_change_pct as number).toBeCloseTo(-17.9, 0);
    expect(f?.facts.days_with_data_30d).toBe(30);
    expect(f?.facts.days_with_data_prior30).toBe(30);
    expect(f?.note).toMatch(/\(-17\.9%\), return/);
    expect(f?.note).toMatch(/30 days with data\) against the 30 before \(30 days with data\)/);
    // the title says how the return moved: it fell 13%, less than sales
    expect(f?.title).toBe("Campaign sales fell, and its return per $1 fell less");
    // TR01 stays quiet on it: the return moved under its bar
    expect(state(runOne("TR01", mugs))).toBe("none_found");
  });
  it("is info with no money and no advice", () => {
    const f = runChecks(mugs).findings.find((x) => x.checkId === "TR09");
    expect(f?.severity.severity).toBe("info");
    expect(f?.impact.value ?? 0).toBe(0);
  });
  it("leaves a return that fell past the bar to TR01", () => {
    const fell = salesAccount([500, 4], [400, 2]);
    expect(state(runOne("TR09", fell))).toBe("none_found");
    expect(state(runOne("TR01", fell))).toBe("fires");
  });
  it("is clean when sales fell under the bar, and the bar is a setting", () => {
    expect(state(runOne("TR09", salesAccount([500, 3], [450, 3])))).toBe("none_found");
    const strict = { settings: { trends: { salesFallPct: 30 } } };
    expect(
      state(runOne("TR09", salesAccount([15_100 / 30, 2.78], [12_400 / 30, 2.41], strict))),
    ).toBe("none_found");
  });
  it("is thin with a short series", () => {
    const short = buildInput({ campaigns: [{ id: "11", days: 5 }] });
    expect(["insufficient_data", "not_checkable"]).toContain(state(runOne("TR09", short)));
  });
});

describe("TR02 latest week (context) and TR03 dated changes (a note)", () => {
  it("TR02 states the latest week", () => {
    expect(state(runOne("TR02", trendAccount(4, 4)))).toBe("fires");
  });
  it("TR03 states a budget change and is clean with no change", () => {
    const change: Row = {
      change_resource_name: "customers/1/campaigns/11",
      change_date_time: `${dayBefore(LAST_DAY, 3)} 10:00:00`,
      changed_fields: "maximize_conversion_value.target_roas",
      changed_values: { "maximizeConversionValue.targetRoas": { old: 3, new: 4 } },
      operation: "UPDATE",
      client_type: "GOOGLE_ADS_WEB_CLIENT",
      resource_type: "CAMPAIGN",
    };
    const fired = runOne(
      "TR03",
      buildInput({ campaigns: [{ id: "11" }], data: { changeHistory: [change] } }),
    );
    expect(findingsOf(fired)[0]?.facts.changes).toBe(1);
    const none = runOne(
      "TR03",
      buildInput({ campaigns: [{ id: "11" }], syncedEmpty: ["changeHistory"] }),
    );
    // no change row: the coverage of the history cannot be shown, so silence is never "none"
    expect(state(none)).not.toBe("none_found");
  });
  it("TR03 puts budget, ad group and launch rows on their campaign (B4)", () => {
    const row = (o: Row): Row => ({
      change_date_time: `${dayBefore(LAST_DAY, 3)} 10:00:00`,
      operation: "UPDATE",
      client_type: "GOOGLE_ADS_WEB_CLIENT",
      ...o,
    });
    const input = buildInput({
      campaigns: [{ id: "11" }, { id: "12" }],
      data: {
        changeHistory: [
          // a budget change: the resource names a budget, the change names its campaign
          row({
            change_resource_name: "customers/1/campaignBudgets/901",
            resource_type: "CAMPAIGN_BUDGET",
            changed_fields: "amountMicros",
            campaign_id: "11",
          }),
          // a new ad group: a CREATE row names only id and resourceName
          row({
            change_resource_name: "customers/1/adGroups/555",
            resource_type: "AD_GROUP",
            operation: "CREATE",
            changed_fields: "id,resourceName",
            campaign_id: "12",
            ad_group_id: "555",
          }),
          // Google re-labelling a campaign is not an on/off switch
          row({
            change_resource_name: "customers/1/campaigns/11",
            resource_type: "CAMPAIGN",
            changed_fields: "primaryStatus,primaryStatusReasons,adServingOptimizationStatus",
            campaign_id: "11",
          }),
        ],
      },
    });
    const found = findingsOf(runOne("TR03", input));
    const of = (id: string) => found.find((f) => f.scope.id === id);
    expect(found.map((f) => f.scope.type)).toEqual(["campaign", "campaign"]);
    expect(of("11")?.facts).toMatchObject({ changes: 1, fields_touched: "budget" });
    expect(of("12")?.facts).toMatchObject({ changes: 1, fields_touched: "ad group launched" });
  });
  it("N10: changes on campaigns paused since are named together in one account finding", () => {
    // a live shop: a 23 Oct batch of video Demand Gen launches, paused since (~$600 spent)
    const launch = (campaignId: string): Row => ({
      change_resource_name: `customers/1/campaigns/${campaignId}`,
      change_date_time: `${dayBefore(LAST_DAY, 9)} 10:00:00`,
      resource_type: "CAMPAIGN",
      operation: "CREATE",
      changed_fields: "id,resourceName",
      client_type: "GOOGLE_ADS_WEB_CLIENT",
      campaign_id: campaignId,
    });
    const budget: Row = {
      change_resource_name: "customers/1/campaignBudgets/901",
      change_date_time: `${dayBefore(LAST_DAY, 3)} 10:00:00`,
      resource_type: "CAMPAIGN_BUDGET",
      changed_fields: "amountMicros",
      operation: "UPDATE",
      client_type: "GOOGLE_ADS_WEB_CLIENT",
      campaign_id: "11",
    };
    const input = buildInput({
      campaigns: [
        { id: "11" },
        { id: "31", name: "Video DG A", type: "DEMAND_GEN", status: "PAUSED", cost: 3 },
        { id: "32", name: "Video DG B", type: "DEMAND_GEN", status: "PAUSED", cost: 4 },
      ],
      data: { changeHistory: [budget, launch("31"), launch("32")] },
    });
    const found = findingsOf(runOne("TR03", input));
    expect(found.map((f) => [f.scope.type, f.facts.changes_on])).toEqual([
      ["campaign", "campaign"],
      ["account", "campaigns_not_running"],
    ]);
    const paused = found[1];
    expect(paused?.facts).toMatchObject({
      changes: 2,
      fields_touched: "campaign launched",
      campaigns_not_running: 2,
      campaigns_not_running_spend_90d: 630,
    });
    // biggest spender first
    expect(paused?.rows?.map((r) => r.entity.name)).toEqual(["Video DG B", "Video DG A"]);
    // a running experiment (a live shop runs 2) states itself beside the changes, never drops them
    const withExperiment: EvidenceInput = {
      ...input,
      data: {
        ...input.data,
        experiments: [
          { experiment_id: "71", resource_name: "customers/1/experiments/71", status: "ENABLED" },
        ],
        experimentArms: [
          {
            experiment_resource_name: "customers/1/experiments/71",
            campaigns_json: ["customers/1/campaigns/11"],
          },
        ],
      },
    };
    const kept = runChecks(withExperiment).info.filter((c) => c.checkId === "TR03");
    expect(kept.map((c) => c.facts.changes_on).sort()).toEqual([
      "campaign",
      "campaigns_not_running",
    ]);
  });
  it("TR03: a promotion's amount is not a budget; a budget total and a strategy switch are", () => {
    const row = (o: Row): Row => ({
      change_date_time: `${dayBefore(LAST_DAY, 3)} 10:00:00`,
      operation: "UPDATE",
      client_type: "GOOGLE_ADS_WEB_CLIENT",
      ...o,
    });
    const input = buildInput({
      campaigns: [{ id: "11" }, { id: "12" }, { id: "13" }],
      data: {
        changeHistory: [
          row({
            change_resource_name: "customers/1/assets/77",
            resource_type: "ASSET",
            changed_fields: "promotionAsset.moneyAmountOff.amountMicros",
            campaign_id: "11",
          }),
          row({
            change_resource_name: "customers/1/campaignBudgets/902",
            resource_type: "CAMPAIGN_BUDGET",
            changed_fields: "totalAmountMicros",
            campaign_id: "12",
          }),
          row({
            change_resource_name: "customers/1/campaigns/13",
            resource_type: "CAMPAIGN",
            changed_fields: "maximizeConversions",
            campaign_id: "13",
          }),
        ],
      },
    });
    const found = findingsOf(runOne("TR03", input));
    const of = (id: string) => found.find((f) => f.scope.id === id);
    expect(of("11")).toBeUndefined();
    expect(of("12")?.facts).toMatchObject({ changes: 1, fields_touched: "budget" });
    expect(of("13")?.facts).toMatchObject({ changes: 1, fields_touched: "bidding strategy" });
  });
  it("TR03: every strategy-only field name on a CAMPAIGN row is a strategy switch", () => {
    for (const field of [
      "maximizeConversions",
      "maximizeConversionValue",
      "manualCpc",
      "manualCpm",
      "targetSpend",
      "targetImpressionShare",
      "targetRoas",
      "targetCpa",
    ]) {
      const input = buildInput({
        campaigns: [{ id: "11" }],
        data: {
          changeHistory: [
            {
              change_resource_name: "customers/1/campaigns/11",
              change_date_time: `${dayBefore(LAST_DAY, 3)} 10:00:00`,
              resource_type: "CAMPAIGN",
              operation: "UPDATE",
              client_type: "GOOGLE_ADS_WEB_CLIENT",
              changed_fields: field,
              campaign_id: "11",
            },
          ],
        },
      });
      expect(findingsOf(runOne("TR03", input))[0]?.facts.fields_touched).toBe("bidding strategy");
    }
  });
  it("TR03 is not checkable when the change history was not read", () => {
    expect(state(runOne("TR03", buildInput({ campaigns: [{ id: "11" }] })))).toBe("not_checkable");
  });
});

describe("TR04 seasonality (context)", () => {
  it("is not checkable without the year-ago series, and judges with it", () => {
    expect(state(runOne("TR04", trendAccount(2, 4)))).toBe("not_checkable");
    const input = trendAccount(2, 4);
    const year = (input.data.dailyMetrics ?? []).map((d) => ({
      metric_date: dayBefore(String(d.metric_date), 364),
      cost: d.cost,
      conversions: d.conversions,
      conversion_value: d.conversion_value,
    }));
    const r = runOne(
      "TR04",
      withStatus(
        { ...input, tables: { ...input.tables, [PRIOR_YEAR_DAILY_TABLE]: year } },
        { [PRIOR_YEAR_DAILY_TABLE]: year.length },
      ),
    );
    expect(state(r)).toBe("fires");
  });
  it("is clean when last year was flat", () => {
    const input = trendAccount(2, 4);
    const year = (input.data.dailyMetrics ?? []).map((d) => ({
      metric_date: dayBefore(String(d.metric_date), 364),
      cost: 100,
      conversions: 2,
      conversion_value: 400,
    }));
    const r = runOne(
      "TR04",
      withStatus(
        { ...input, tables: { ...input.tables, [PRIOR_YEAR_DAILY_TABLE]: year } },
        { [PRIOR_YEAR_DAILY_TABLE]: year.length },
      ),
    );
    expect(state(r)).toBe("none_found");
  });
});

describe("TR05 paused campaign that used to sell", () => {
  const paused = (lastDaysAgo: number, conv: number) =>
    buildInput({
      campaigns: [
        { id: "11" },
        {
          id: "12",
          status: "PAUSED",
          conv,
          extra: { last_active_date: dayBefore(LAST_DAY, lastDaysAgo) },
        },
      ],
    });
  it("fires on a converter paused 40 days ago, clean at 10 days", () => {
    expect(findingsOf(runOne("TR05", paused(40, 2)))[0]?.rows?.[0]?.entity.id).toBe("12");
    expect(state(runOne("TR05", paused(10, 2)))).toBe("none_found");
  });
  it("is not checkable with no paused campaign", () => {
    expect(state(runOne("TR05", buildInput({ campaigns: [{ id: "11" }] })))).toBe("not_checkable");
  });
  it("a paused campaign that only broke even is not one that used to sell", () => {
    const returned = (value: number) =>
      buildInput({
        campaigns: [
          { id: "11" },
          {
            id: "12",
            name: "Generic campaign",
            status: "PAUSED",
            conv: 2,
            cost: 100,
            value,
            extra: { last_active_date: dayBefore(LAST_DAY, 40) },
          },
        ],
      });
    // $1.01 per $1: break-even, a note in the check, no finding
    const even = runOne("TR05", returned(101));
    expect(state(even)).toBe("none_found");
    expect(even).toMatchObject({ note: expect.stringMatching(/only broke even/) });
    // $1.50 per $1: it sold at a profit
    expect(state(runOne("TR05", returned(150)))).toBe("fires");
  });
  it("a lead account's placeholder values ($1 a conversion) keep the paused converter", () => {
    // the account brings in $1 per conversion: value is a count, not sales
    const leads = buildInput({
      campaigns: [
        { id: "11", conv: 3, value: 3 },
        {
          id: "12",
          name: "Leads campaign",
          status: "PAUSED",
          conv: 2,
          cost: 100,
          value: 2,
          extra: { last_active_date: dayBefore(LAST_DAY, 40) },
        },
      ],
    });
    expect(state(runOne("TR05", leads))).toBe("fires");
  });
  // R13: an experiment left "enabled" on campaigns that spent $0 in the window steers nothing
  const withExperiment = (armCost: number) => {
    return buildInput({
      campaigns: [
        { id: "11" },
        {
          id: "12",
          status: "PAUSED",
          conv: 2,
          extra: { last_active_date: dayBefore(LAST_DAY, 40) },
        },
        { id: "13", name: "Old display test", type: "DISPLAY", cost: armCost, conv: 0, value: 0 },
      ],
      data: {
        experiments: [
          { experiment_id: "81", resource_name: "customers/1/experiments/81", status: "ENABLED" },
        ],
        experimentArms: [
          {
            experiment_resource_name: "customers/1/experiments/81",
            campaigns_json: ["customers/1/campaigns/13"],
          },
        ],
      },
    });
  };
  it("R13: an experiment on a $0 campaign does not hold the account-level line back", () => {
    const r = runChecks(withExperiment(0));
    expect(r.findings.some((f) => f.checkId === "TR05")).toBe(true);
  });
  it("R13: an experiment on a campaign that spent still holds it back", () => {
    const r = runChecks(withExperiment(10));
    expect(r.findings.some((f) => f.checkId === "TR05")).toBe(false);
    expect(r.suppressed.find((x) => x.checkId === "TR05")?.reason).toMatch(/experiment/);
  });
});

describe("TR10 spent more than it brought in (R16)", () => {
  // the account: $100 a day in each campaign over 90 days
  const shop = (value: number, campaignValue = 400, conv = 2) =>
    buildInput({
      campaigns: [
        { id: "11", name: "Search - generic", value: campaignValue, conv },
        { id: "41", name: "PMax - country B", type: "PERFORMANCE_MAX", value },
      ],
    });
  it("names the account and the campaign under $1 per $1, numbers only", () => {
    // account: ($40 + $13) / $200 = $0.27 per $1; the PMax $0.13 per $1
    const r = runOne("TR10", shop(13, 40));
    const byScope = new Map(findingsOf(r).map((f) => [f.scope.type, f] as const));
    expect(Number(byScope.get("account")?.facts.return_per_dollar)).toBeCloseTo(0.27, 2);
    const campaigns = findingsOf(r).filter((f) => f.scope.type === "campaign");
    expect(campaigns.map((f) => f.scope.id).sort()).toEqual(["11", "41"]);
    expect(Number(campaigns.find((f) => f.scope.id === "41")?.facts.return_per_dollar)).toBeCloseTo(
      0.13,
      2,
    );
  });
  it("never priced: it states the numbers, the money is other checks'", () => {
    const f = runChecks(shop(13, 40)).findings.find((x) => x.checkId === "TR10");
    expect(f?.impact.quantified).toBe(false);
  });
  it("is clean when the account and every campaign bring in more than they spend", () => {
    expect(state(runOne("TR10", shop(400)))).toBe("none_found");
  });
  it("a campaign with no sale at all is TR06's, not this check's", () => {
    const r = runOne("TR10", shop(400, 0, 0));
    expect(findingsOf(r).filter((f) => f.scope.type === "campaign")).toHaveLength(0);
  });
  const learningCampaign = (status: Record<string, string>, more: Record<string, unknown> = {}) =>
    buildInput({
      campaigns: [
        { id: "11", name: "Search - generic", value: 40 },
        {
          id: "41",
          name: "PMax - country B",
          type: "PERFORMANCE_MAX",
          value: 13,
          ...more,
          extra: status,
        },
      ],
    });
  it("a new campaign Google shows as learning, under 30 days of spend, is a note that says so", () => {
    // a second-country PMax: LEARNING_NEW, 10 days with spend
    const f = runChecks(
      learningCampaign(
        { primary_status: "LEARNING", bidding_strategy_system_status: "LEARNING_NEW" },
        { cost: 400, days: 10 },
      ),
    ).findings.find((x) => x.checkId === "TR10" && x.scope.id === "41");
    expect(f?.severity.severity).toBe("info");
    expect(f?.title).toBe(TR10_TITLE_LEARNING);
    expect(String(f?.facts.still_learning)).toMatch(/^Google shows it as learning \(new\)/);
    // the same campaign with no learning state read says nothing about learning
    const plain = runChecks(shop(13, 40)).findings.find(
      (x) => x.checkId === "TR10" && x.scope.id === "41",
    );
    expect(plain).toBeDefined();
    expect(plain?.facts.still_learning).toBeUndefined();
    expect(plain?.title).toBeUndefined();
  });
  // the raw line before the tracking confounders (this fixture has no purchase tag read)
  const rawLine = (input: EvidenceInput) => {
    const r = runOne("TR10", input);
    return r.state === "fires" ? r.findings.find((x) => x.scope.id === "41") : undefined;
  };
  it("a 90-day loss re-learning after a budget change stays a warning, the learning stated", () => {
    const f = rawLine(
      learningCampaign({
        primary_status: "LEARNING",
        bidding_strategy_system_status: "LEARNING_BUDGET_CHANGE",
      }),
    );
    expect(f).toBeDefined();
    expect(f?.maxSeverity).toBeUndefined();
    expect(f?.title).toBeUndefined();
    expect(String(f?.facts.still_learning)).toBe(
      "Google shows its bidding re-learning after a budget change",
    );
    expect(f?.note).toContain("the loss covers 90 days with spend");
    expect(f?.note).not.toContain("not a verdict");
  });
  it("LEARNING_NEW over 30 or more days with spend, or a bare LEARNING status, stays a warning", () => {
    for (const status of [
      { bidding_strategy_system_status: "LEARNING_NEW" },
      { primary_status: "LEARNING" },
      { bidding_strategy_system_status: "MULTIPLE_LEARNING" },
    ]) {
      const f = rawLine(learningCampaign(status));
      expect(f).toBeDefined();
      expect(f?.maxSeverity).toBeUndefined();
      expect(f?.facts.still_learning).toBeDefined();
    }
    // the new one under 30 days with spend is lowered
    const young = rawLine(
      learningCampaign({ bidding_strategy_system_status: "LEARNING_NEW" }, { cost: 400, days: 20 }),
    );
    expect(young?.maxSeverity).toBe("info");
    expect(young?.note).toContain("early, not a verdict");
  });
  it("a campaign that first spent under the learning age ago is a note that says so", () => {
    const young = buildInput({
      campaigns: [
        { id: "11", name: "Search - generic", value: 40 },
        {
          id: "41",
          name: "PMax - country B",
          type: "PERFORMANCE_MAX",
          value: 13,
          cost: 400,
          days: 10,
        },
      ],
    });
    const f = runChecks(young).findings.find((x) => x.checkId === "TR10" && x.scope.id === "41");
    expect(f?.severity.severity).toBe("info");
    expect(f?.title).toBe(TR10_TITLE_LEARNING);
    expect(String(f?.facts.still_learning)).toMatch(/first spent 10 days ago, under the 14-day/);
    expect(f?.evidence.some((e) => e.key === "C.age_days")).toBe(true);
  });
  it("says over how many days with spend", () => {
    const f = findingsOf(runOne("TR10", shop(13, 40))).find((x) => x.scope.type === "account");
    expect(f?.facts.days_with_spend).toBe(90);
    expect(f?.note).toContain("over 90 days with spend");
  });
  it("an account that started mid-window with its purchase tag firing is not lowered by MI01", () => {
    // spends from 20 days ago only (21 days); the purchase action fired on 3 days since, all after its
    // settled day (30 days ago): no settled day of silence, so MI01 does not lower TR10
    const base = shop(13, 40);
    const cut = dayBefore(LAST_DAY, 20);
    const zero = (r: Row): Row =>
      String(r.metric_date) < cut
        ? { ...r, cost: 0, clicks: 0, impressions: 0, conversions: 0, conversion_value: 0 }
        : r;
    const purchase: Row = {
      action_id: "61",
      name: "Purchase",
      status: "ENABLED",
      type: "WEBPAGE",
      category: "PURCHASE",
      origin: "WEBSITE",
      is_primary: true,
      include_in_conversions: true,
      counting_type: "MANY_PER_CLICK",
      attribution_model: "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN",
      lookback_window_days: 30,
      view_through_window_days: 1,
      total_conversions: 6,
      total_value: 600,
    };
    const fired = [18, 11, 4].map((n) => ({
      conversion_action_id: "61",
      date: dayBefore(LAST_DAY, n),
      conversions: 2,
      conversions_value: 200,
      all_conversions: 2,
    }));
    const input: EvidenceInput = {
      ...base,
      data: {
        ...base.data,
        conversionActions: [purchase],
        dailyMetrics: (base.data.dailyMetrics ?? []).map(zero),
        campaignDailyMetrics: (base.data.campaignDailyMetrics ?? []).map(zero),
      },
      tables: { ...base.tables, conversion_action_daily: fired },
      statusRows: [
        ...(base.statusRows ?? []),
        {
          table_name: "conversion_action_daily",
          status: "ok",
          row_count: fired.length,
          error_message: null,
        },
      ],
    };
    const f = runChecks(input).findings.find(
      (x) => x.checkId === "TR10" && x.scope.type === "account",
    );
    expect(f).toBeDefined();
    expect(f?.severity.unresolvedConfounders).not.toContain("TR10:MI01");
    expect(f?.confounders.find((c) => c.id === "TR10:MI01")?.state).toBe("cleared");
    // the unsettled window is stated beside the numbers, never a downgrade
    expect(f?.openItems.some((o) => o.startsWith("TR10:MI08"))).toBe(true);
    expect(f?.facts.days_with_spend).toBe(21); // 20 days ago through the last day
  });
  it("is not run when no sales value is tracked", () => {
    expect(runOne("TR10", shop(0, 0))).toMatchObject({
      state: "not_checkable",
      category: "not_present",
    });
  });
});

describe("TR06 campaign spending without converting", () => {
  it("fires on zero conversions over many clicks, clean when it converts", () => {
    expect(
      state(runOne("TR06", buildInput({ campaigns: [{ id: "11", conv: 0, value: 0 }] }))),
    ).toBe("fires");
    expect(state(runOne("TR06", buildInput({ campaigns: [{ id: "11" }] })))).toBe("none_found");
  });
  it("the click bar is a setting", () => {
    const input = buildInput({
      campaigns: [{ id: "11", conv: 0, value: 0, clicks: 1 }],
      settings: { trends: { zeroConvMinClicks: 1000 } },
    });
    expect(state(runOne("TR06", input))).toBe("none_found");
  });
  it("is not checkable with no campaign", () => {
    expect(state(runOne("TR06", buildInput({ campaigns: [] })))).not.toBe("none_found");
  });
});

describe("TR07 paid vs first organic position (not run by design)", () => {
  it("never runs: Google withholds the organic position", () => {
    const r = runOne("TR07", buildInput({ campaigns: [{ id: "11" }] }));
    expect(r).toMatchObject({ state: "not_checkable", category: "google_withholds" });
  });
});

describe("TR08 the campaign carrying the account (a note)", () => {
  it("names the biggest spender that earns at least the average", () => {
    const r = runOne(
      "TR08",
      buildInput({
        campaigns: [
          { id: "11", cost: 200, conv: 3, value: 900 },
          { id: "12", cost: 50, conv: 1, value: 100 },
        ],
      }),
    );
    expect(findingsOf(r)[0]?.scope.id).toBe("11");
    expect(findingsOf(r)[0]?.claimKey).toBe("performance.carrying_campaign");
  });
  it("names a small-share standout as the best non-brand return, never as carrying (B3)", () => {
    const r = runOne(
      "TR08",
      buildInput({
        campaigns: [
          { id: "11", cost: 300, conv: 3, value: 600 },
          { id: "12", name: "Brand search", cost: 60, conv: 3, value: 900 },
          { id: "13", name: "Jackets", cost: 50, conv: 2, value: 230 },
        ],
      }),
    );
    const f = findingsOf(r)[0];
    expect(f?.scope.id).toBe("13");
    expect(f?.claimKey).toBe("performance.standout_non_brand");
    expect(f?.facts).toMatchObject({
      strength: "best non-brand return per dollar",
      excludes_brand: true,
      brand_roas: 15,
    });
    expect(f?.note).not.toMatch(/carries/);
  });
  it("is clean when the biggest spender earns below the rest and nothing stands out", () => {
    const r = runOne(
      "TR08",
      buildInput({
        campaigns: [
          { id: "11", cost: 200, conv: 3, value: 300 },
          { id: "12", name: "Brand search", cost: 50, conv: 2, value: 900 },
        ],
      }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable with no conversions", () => {
    const r = runOne("TR08", buildInput({ campaigns: [{ id: "11", conv: 0, value: 0 }] }));
    expect(state(r)).toBe("not_checkable");
  });
});

// ---------------------------------------------------------------------------
// slices
// ---------------------------------------------------------------------------

const device = (campaignId: string, d: string, cost: number, conv: number, clicks = 500): Row => ({
  campaign_id: campaignId,
  device: d,
  cost,
  clicks,
  impressions: clicks * 20,
  conversions: conv,
  conversion_value: conv * 100,
});

describe("SL05 / SL06 / SL09 devices", () => {
  const make = (rows: Row[], settings?: FixtureOptions["settings"]) =>
    buildInput({
      campaigns: [{ id: "11", cost: 100, conv: 2 }],
      data: { deviceData: rows },
      ...(settings ? { settings } : {}),
    });
  it("SL05 fires on a device at 4x the campaign CPA, clean on even devices", () => {
    expect(
      state(
        runOne(
          "SL05",
          make([device("11", "MOBILE", 6000, 30), device("11", "DESKTOP", 3000, 150)]),
        ),
      ),
    ).toBe("fires");
    expect(
      state(
        runOne("SL05", make([device("11", "MOBILE", 4500, 90), device("11", "DESKTOP", 4500, 90)])),
      ),
    ).toBe("none_found");
  });
  it("SL05 is thin with no device rows over the floor", () => {
    expect(state(runOne("SL05", make([device("11", "MOBILE", 10, 1, 5)])))).toBe(
      "insufficient_data",
    );
  });
  it("SL06 fires on a zero-conversion device past the bar, clean when every device sells", () => {
    expect(
      state(
        runOne("SL06", make([device("11", "TABLET", 900, 0), device("11", "DESKTOP", 8100, 180)])),
      ),
    ).toBe("fires");
    expect(state(runOne("SL06", make([device("11", "DESKTOP", 9000, 180)])))).toBe("none_found");
  });
  it("SL06 labels the account's device numbers as the account's (B14)", () => {
    const input = buildInput({
      campaigns: [
        { id: "11", cost: 100, conv: 2 },
        { id: "12", cost: 100, conv: 2 },
      ],
      data: {
        deviceData: [
          device("11", "TABLET", 900, 0),
          device("11", "DESKTOP", 8100, 180),
          device("12", "TABLET", 300, 3),
          device("12", "DESKTOP", 3000, 60),
        ],
      },
    });
    const f = findingsOf(runOne("SL06", input)).find((x) => x.scope.campaignId === "11");
    expect(f).toBeDefined();
    expect(Object.keys(f?.facts ?? {}).some((k) => k.startsWith("account_TABLET"))).toBe(false);
    expect(f?.facts.account_context).toMatchObject({ scope: "account", TABLET_conv: 3 });
    expect(f?.evidence.some((e) => e.entity === "account · TABLET")).toBe(true);
  });
  it("SL06 skips a campaign where every device converts nothing (B14)", () => {
    const r = runOne(
      "SL06",
      buildInput({
        campaigns: [
          { id: "11", cost: 100, conv: 0, value: 0 },
          { id: "12", cost: 100, conv: 2 },
        ],
        data: {
          deviceData: [
            device("11", "TABLET", 900, 0),
            device("11", "DESKTOP", 8100, 0),
            device("12", "DESKTOP", 9000, 180),
          ],
        },
      }),
    );
    expect(findingsOf(r).some((f) => f.scope.campaignId === "11")).toBe(false);
  });
  it("SL06 is not checkable with no read", () => {
    expect(state(runOne("SL06", buildInput({ campaigns: [{ id: "11" }] })))).toBe("not_checkable");
  });
  it("SL09 judges return per dollar when there is value, cost per sale without (B17)", () => {
    const valued = (d: string, cost: number, conv: number, value: number, clicks: number): Row => ({
      ...device("11", d, cost, conv, clicks),
      conversion_value: value,
    });
    // a live shop: mobile converts 2.4% against 5.6%, but returns $3.14 against $2.67 per $1
    const split = [valued("MOBILE", 1000, 24, 3140, 1000), valued("DESKTOP", 1000, 56, 2670, 1000)];
    expect(state(runOne("SL09", make(split)))).toBe("none_found");
    // mobile returns a third of desktop per dollar: a finding, compared on return
    const low = [valued("MOBILE", 1000, 30, 1000, 1000), valued("DESKTOP", 1000, 30, 3000, 1000)];
    const f = findingsOf(runOne("SL09", make(low)))[0];
    expect(f?.claimKey).toBe("device.mobile_return_below_desktop");
    expect(f?.facts).toMatchObject({ compared_on: "return per dollar" });
    expect(f?.facts.mobile_cvr_pct).toBe(3);
    // no value: mobile costs 3x desktop per sale
    const noValue = [valued("MOBILE", 3000, 10, 0, 1000), valued("DESKTOP", 1000, 10, 0, 1000)];
    expect(findingsOf(runOne("SL09", make(noValue)))[0]?.facts).toMatchObject({
      compared_on: "cost per sale",
    });
  });
  it("SL09 fires when mobile earns far below desktop; the share is a setting", () => {
    const rows = [device("11", "MOBILE", 4500, 20), device("11", "DESKTOP", 4500, 160)];
    expect(state(runOne("SL09", make(rows)))).toBe("fires");
    expect(state(runOne("SL09", make(rows, { slices: { mobileCvrShare: 0.1 } })))).toBe(
      "none_found",
    );
    expect(state(runOne("SL09", make([device("11", "MOBILE", 10, 1, 5)])))).toBe(
      "insufficient_data",
    );
  });
});

describe("SL01 / SL07 audience and demographic bands", () => {
  const aud = (cost: number, conv: number): Row => ({
    campaign_id: "11",
    criterion_id: "701",
    user_list_id: "950",
    audience_type: "USER_LIST",
    cost,
    clicks: 400,
    impressions: 8000,
    conversions: conv,
    conversion_value: conv * 100,
  });
  const demo = (cost: number, conv: number): Row => ({
    campaign_id: "11",
    demographic_type: "AGE_RANGE",
    demographic_value: "AGE_RANGE_65_UP",
    cost,
    clicks: 400,
    impressions: 8000,
    conversions: conv,
    conversion_value: conv * 100,
  });
  const make = (data: NonNullable<FixtureOptions["data"]>) =>
    buildInput({ campaigns: [{ id: "11", cost: 100, conv: 2 }], data });
  it("SL01 fires at 5x the campaign CPA and is clean in line", () => {
    expect(state(runOne("SL01", make({ campaignAudiencePerf: [aud(2000, 2)] })))).toBe("fires");
    expect(state(runOne("SL01", make({ campaignAudiencePerf: [aud(500, 10)] })))).toBe(
      "none_found",
    );
    expect(state(runOne("SL01", make({})))).toBe("not_checkable");
  });
  it("SL01 names the audience by its list name, else by its criterion id", () => {
    const named = findingsOf(
      runOne(
        "SL01",
        make({
          campaignAudiencePerf: [aud(2000, 2)],
          audienceLists: [{ list_id: "950", list_name: "LAL BUYERS - 2.5%" }],
        }),
      ),
    )[0];
    expect(named?.scope.name).toBe("LAL BUYERS - 2.5%");
    expect(named?.scope.id).toBe("701");
    const bare = findingsOf(runOne("SL01", make({ campaignAudiencePerf: [aud(2000, 2)] })))[0];
    expect(bare?.scope.name).toBe("701");
  });
  // Phase F, a live shop "LAL BUYERS - 2.5%": $2,393 of its $2,588 came from paused campaigns
  const live = { id: "11", cost: 100, conv: 2 };
  const paused = { id: "12", status: "PAUSED", cost: 50, conv: 1 };
  const twoCampaigns = (rows: Row[]) =>
    buildInput({ campaigns: [live, paused], data: { campaignAudiencePerf: rows } });
  const audIn = (campaignId: string, cost: number, conv: number, clicks: number): Row => ({
    ...aud(cost, conv),
    campaign_id: campaignId,
    clicks,
  });
  it("SL01 prices the account view on live campaigns only (a live shop LAL BUYERS)", () => {
    const r = runOne(
      "SL01",
      twoCampaigns([audIn("12", 2393.43, 14, 11399), audIn("11", 194.87, 0, 1286)]),
    );
    // the live share has no sale, so no cost-per-sale gap can be priced on it
    expect(findingsOf(r).filter((f) => f.scope.campaignId == null)).toHaveLength(0);
    // the dropped account slice stays a line, with its money while paused campaigns ran
    expect(r.state === "fires" ? r.withheld?.join(" ") : "").toMatch(
      /1 account-level audience slice\(s\) held back: .*spend 2588\.30, 14 sales; live campaigns 194\.87, 0 sales/,
    );
  });
  it("SL01 keeps a live share that is dearer, with the paused money left out", () => {
    const r = runOne("SL01", twoCampaigns([audIn("12", 3000, 4, 2000), audIn("11", 1000, 2, 400)]));
    const acct = findingsOf(r).find((f) => f.scope.campaignId == null);
    expect(acct?.facts["SL.audience().cost"]).toBe(1000);
    expect(acct?.facts["SL.audience().conv"]).toBe(2);
    expect(acct?.note).toMatch(/live campaigns only/);
  });
  it("N7: a custom segment reads by its own name (a live shop's bare-number segment is 'Leather')", () => {
    const leather: Row = {
      ...aud(2000, 2),
      criterion_id: "7001",
      user_list_id: null,
      audience_type: "CUSTOM_AUDIENCE",
      audience_name: "Leather",
    };
    const f = findingsOf(runOne("SL01", make({ campaignAudiencePerf: [leather] })))[0];
    expect(f?.scope.name).toBe("Leather");
    expect(f?.scope.id).toBe("7001");
  });
  it("SL07 fires at 5x the campaign CPA and is clean in line", () => {
    expect(state(runOne("SL07", make({ demographicData: [demo(2000, 2)] })))).toBe("fires");
    expect(state(runOne("SL07", make({ demographicData: [demo(500, 10)] })))).toBe("none_found");
    expect(state(runOne("SL07", make({})))).toBe("not_checkable");
  });
});

describe("SL02 remarketing lists worth using", () => {
  const list = (id: string, name: string): Row => ({
    list_id: id,
    list_name: name,
    list_type: "RULE_BASED",
    membership_status: "OPEN",
    size_for_search: 5000,
    size_for_display: 8000,
  });
  const aud = (listId: string): Row => ({
    campaign_id: "11",
    criterion_id: `c${listId}`,
    user_list_id: listId,
    cost: 10,
    clicks: 10,
    impressions: 100,
    conversions: 1,
    conversion_value: 100,
  });
  const make = (rows: Row[]) =>
    buildInput({
      campaigns: [{ id: "11" }],
      data: { audienceLists: [list("950", "All purchasers")], campaignAudiencePerf: rows },
      syncedEmpty: ["campaignAudiencePerf"],
    });
  it("fires when the purchasers list is attached nowhere, clean when it is", () => {
    expect(findingsOf(runOne("SL02", make([])))[0]?.rows?.[0]?.entity.id).toBe("950");
    expect(state(runOne("SL02", make([aud("950")])))).toBe("none_found");
  });
  it("is not checkable when no list name is recognised", () => {
    const input = buildInput({
      campaigns: [{ id: "11" }],
      data: { audienceLists: [list("951", "Liste A")] },
      syncedEmpty: ["campaignAudiencePerf"],
    });
    expect(state(runOne("SL02", input))).toBe("not_checkable");
  });
});

describe("SL04 location option", () => {
  it("fires on presence-or-interest, clean on presence, not checkable when unread", () => {
    const make = (t?: string) =>
      buildInput({ campaigns: [{ id: "11", extra: t ? { geo_target_type: t } : {} }] });
    expect(state(runOne("SL04", make("PRESENCE_OR_INTEREST")))).toBe("fires");
    expect(state(runOne("SL04", make("PRESENCE")))).toBe("none_found");
    expect(state(runOne("SL04", make()))).toBe("not_checkable");
  });
});

describe("N12: a live campaign that spent $0 gets only delivery findings", () => {
  // a retargeting campaign: enabled, $0 in 90 days, still got SL04 (priced $0), AS06 and PR01
  const idle = {
    id: "12",
    name: "Display - Retargeting test",
    type: "DISPLAY",
    cost: 0,
    conv: 0,
    value: 0,
    extra: { geo_target_type: "PRESENCE_OR_INTEREST" },
  };
  const input = buildInput({ campaigns: [{ id: "11" }, idle] });
  it("SL04 on it is held back, with the campaign named", () => {
    const r = runOne("SL04", input);
    expect(r.state === "fires" ? r.findings : null).toEqual([]);
    expect(r.state === "fires" ? r.withheld?.join(" ") : "").toMatch(
      /1 finding\(s\) held back: each was about a campaign that spent nothing in the 90 days read \(Display - Retargeting test/,
    );
    expect(runChecks(input).findings.some((f) => f.checkId === "SL04")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// presence and carried-in
// ---------------------------------------------------------------------------

describe("PR01 frequency caps / PR02 channel types (a note)", () => {
  const display: CampaignSpec = { id: "61", name: "Display remarketing", type: "DISPLAY" };
  const make = (row?: Row) =>
    withStatus(
      buildInput({
        campaigns: [display],
        tables: row ? { campaign_control_settings: [{ campaign_id: "61", ...row }] } : {},
      }),
      row ? { campaign_control_settings: 1 } : {},
    );
  it("PR01 fires with no cap, clean with one, not checkable when unread", () => {
    expect(state(runOne("PR01", make({ frequency_caps_state: "none_returned" })))).toBe("fires");
    expect(
      state(runOne("PR01", make({ frequency_caps_state: "set", frequency_caps: "[{}]" }))),
    ).toBe("none_found");
    expect(state(runOne("PR01", make()))).toBe("not_checkable");
  });
  it("PR02 states the channel split", () => {
    const r = runOne("PR02", buildInput({ campaigns: [{ id: "11" }, display] }));
    expect(findingsOf(r)[0]?.facts.live_campaigns_by_type).toEqual({ SEARCH: 1, DISPLAY: 1 });
  });
  it("PR02 shares add up to 100 with a paused campaign that spent (same money as A.spend)", () => {
    const r = runOne(
      "PR02",
      buildInput({
        campaigns: [
          { id: "11", cost: 300 },
          { ...display, cost: 100 },
          { id: "13", name: "Old shopping", type: "SHOPPING", status: "PAUSED", cost: 100 },
        ],
      }),
    );
    const facts = findingsOf(r)[0]?.facts as {
      live_campaigns_by_type: Record<string, number>;
      campaigns_with_spend_by_type: Record<string, number>;
      spend_not_live_by_type: Record<string, number>;
      spend_share_pct_by_type: Record<string, number>;
    };
    // N8: the live count and the count behind the spend are two named sets; the paused
    // one's money is in the split and named as not live (an NL shop: "1 PMax" live, but its
    // $858 PMax spend held $525 from a paused DE PMax)
    expect(facts.live_campaigns_by_type).toEqual({ SEARCH: 1, DISPLAY: 1 });
    expect(facts.campaigns_with_spend_by_type).toEqual({ SEARCH: 1, DISPLAY: 1, SHOPPING: 1 });
    expect(facts.spend_not_live_by_type).toEqual({ SHOPPING: 9000 }); // 100 a day over 90 days
    const shares = Object.values(facts.spend_share_pct_by_type);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    expect(facts.spend_share_pct_by_type.SHOPPING).toBeCloseTo(20, 6);
  });
});

describe("MI13 counting type", () => {
  const action = (category: string, counting: string): Row => ({
    action_id: "61",
    name: "Lead form",
    status: "ENABLED",
    category,
    counting_type: counting,
    primary_for_goal: true,
    type: "WEBPAGE",
  });
  const make = (rows: Row[]) =>
    buildInput({ campaigns: [{ id: "11" }], data: { conversionActions: rows } });
  it("fires on a lead counted every time, clean on one per click", () => {
    expect(state(runOne("MI13", make([action("SUBMIT_LEAD_FORM", "MANY_PER_CLICK")])))).toBe(
      "fires",
    );
    expect(state(runOne("MI13", make([action("SUBMIT_LEAD_FORM", "ONE_PER_CLICK")])))).toBe(
      "none_found",
    );
  });
  it("is not checkable with no purchase or lead action", () => {
    expect(state(runOne("MI13", make([action("PAGE_VIEW", "ONE_PER_CLICK")])))).toBe(
      "not_checkable",
    );
  });
});

describe("AS12 brand share", () => {
  const make = (brandCost: number) =>
    buildInput({
      campaigns: [
        { id: "11", cost: 100 },
        { id: "12", name: "Brand search", cost: brandCost },
      ],
      settings: { floors: { spendTierAMaxMonthlyUsd: 1 } },
    });
  it("fires over the line and is clean under it", () => {
    expect(state(runOne("AS12", make(100)))).toBe("fires");
    expect(state(runOne("AS12", make(10)))).toBe("none_found");
  });
  it("is not checkable with no brand campaign", () => {
    expect(state(runOne("AS12", buildInput({ campaigns: [{ id: "11" }] })))).toBe("not_checkable");
  });
});

describe("BB12 absolute-top share", () => {
  const make = (absTop?: number, settings?: FixtureOptions["settings"]) =>
    buildInput({
      campaigns: [{ id: "11", is: { share: 0.6 } }],
      ...(settings ? { settings } : {}),
      data:
        absTop === undefined
          ? {}
          : {
              impressionShare: [
                {
                  campaign_id: "11",
                  search_impression_share: 0.6,
                  search_absolute_top_impression_share: absTop,
                  search_budget_lost_impression_share: 0,
                  search_rank_lost_impression_share: 0.1,
                },
              ],
            },
    });
  it("fires under the bar, clean over it, and the bar is a setting", () => {
    expect(state(runOne("BB12", make(0.1)))).toBe("fires");
    expect(state(runOne("BB12", make(0.5)))).toBe("none_found");
    expect(state(runOne("BB12", make(0.5, { bidding: { absoluteTopMinPct: 60 } })))).toBe("fires");
  });
  it("is not checkable when no absolute-top share is reported", () => {
    expect(state(runOne("BB12", make()))).toBe("not_checkable");
  });
  it("never copies BB02's money: lost share to budget is priced once, on BB02", () => {
    const base = make(0.1);
    const input = {
      ...base,
      data: {
        ...base.data,
        impressionShare: (base.data.impressionShare ?? []).map((r) => ({
          ...r,
          search_budget_lost_impression_share: 0.4,
        })),
      },
    };
    const findings = runChecks(input).findings;
    const bb12 = findings.find((f) => f.checkId === "BB12");
    expect(bb12).toBeDefined();
    expect(bb12?.impact.formulaId).toBe("IMP_NONE");
    expect(bb12?.impact.value).toBeNull();
    const bb02 = findings.find((f) => f.checkId === "BB02");
    expect(bb02?.facts.spend_90d).toBeTypeOf("number");
    expect(bb02?.facts.spend_30d).toBeUndefined();
  });
});

describe("BB13 target moved repeatedly", () => {
  const move = (daysAgo: number, from: number, to: number): Row => ({
    change_resource_name: "customers/1/campaigns/11",
    change_date_time: `${dayBefore(LAST_DAY, daysAgo)} 10:00:00`,
    changed_fields: "maximize_conversion_value.target_roas",
    changed_values: { "maximizeConversionValue.targetRoas": { old: from, new: to } },
    operation: "UPDATE",
    client_type: "GOOGLE_ADS_WEB_CLIENT",
    resource_type: "CAMPAIGN",
  });
  const make = (rows: Row[]) =>
    buildInput({ campaigns: [{ id: "11" }], data: { changeHistory: rows } });
  it("fires on a 50% move, clean on a 5% move", () => {
    expect(state(runOne("BB13", make([move(5, 4, 2)])))).toBe("fires");
    expect(state(runOne("BB13", make([move(5, 4, 4.2)])))).toBe("none_found");
  });
  it("N11: the change-history evidence carries no 90-day window (it covers ~30 days)", () => {
    const f = findingsOf(runOne("BB13", make([move(20, 4, 2), move(5, 2, 4)])))[0];
    const ev = (f?.evidence ?? []).filter((e) => e.key.startsWith("A.change_"));
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) expect([e.key, e.window]).toEqual([e.key, null]);
  });
  it("never judges a paused campaign", () => {
    const input = buildInput({
      campaigns: [{ id: "11", status: "PAUSED" }],
      data: { changeHistory: [move(5, 4, 2)] },
    });
    expect(state(runOne("BB13", input))).not.toBe("fires");
  });
  it("ad groups' own targets are not campaign target moves (3 ad groups, 5% each)", () => {
    const agMove = (agId: string): Row => ({
      change_resource_name: `customers/1/adGroups/${agId}`,
      change_date_time: `${dayBefore(LAST_DAY, 5)} 10:00:00`,
      changed_fields: "targetCpaMicros",
      changed_values: { targetCpaMicros: { old: 10e6, new: 10.5e6 } },
      operation: "UPDATE",
      client_type: "GOOGLE_ADS_WEB_CLIENT",
      resource_type: "AD_GROUP",
      campaign_id: "11",
      ad_group_id: agId,
    });
    const r = runOne("BB13", make([agMove("1"), agMove("2"), agMove("3")]));
    // judged (values were read), and nothing found: not "insufficient data"
    expect(state(r)).toBe("none_found");
  });
  it("is thin when the history has no before/after values", () => {
    const r = runOne("BB13", make([{ ...move(5, 4, 2), changed_values: null }]));
    expect(["insufficient_data", "not_checkable"]).toContain(state(r));
  });
});

describe("SK24 click-through bar", () => {
  const make = (clicks: number, settings?: FixtureOptions["settings"]) =>
    buildInput({
      campaigns: [{ id: "12", name: "Brand search", clicks, impressions: 1000 }],
      ...(settings ? { settings } : {}),
    });
  it("fires at 2% on brand, clean at 20%, and the bar is a setting", () => {
    expect(state(runOne("SK24", make(20)))).toBe("fires");
    expect(state(runOne("SK24", make(200)))).toBe("none_found");
    expect(state(runOne("SK24", make(20, { search: { brandSearchCtrMinPct: 1 } })))).toBe(
      "none_found",
    );
  });
  it("is not checkable on an account with no Shopping or brand campaign", () => {
    expect(state(runOne("SK24", buildInput({ campaigns: [{ id: "11" }] })))).toBe("not_checkable");
  });
  it("R4: Shopping is held to a Shopping bar (0.5%), not a Search one", () => {
    const shop = (clicks: number) =>
      buildInput({
        campaigns: [
          { id: "71", name: "Shop - one product", type: "SHOPPING", clicks, impressions: 1000 },
        ],
      });
    // 0.66% (a normal Shopping rate) is clean; 0.3% is under the bar
    expect(state(runOne("SK24", shop(6.6)))).toBe("none_found");
    expect(findingsOf(runOne("SK24", shop(3)))[0]?.facts.bar_pct).toBe(0.5);
  });
});

describe("SK25 keywords per ad group", () => {
  const make = (n: number) =>
    buildInput({
      campaigns: [{ id: "11" }],
      data: {
        adGroups: [adGroup({ id: "21", campaignId: "11" })],
        keywords: Array.from({ length: n }, (_, i) =>
          keyword({ id: `k${i}`, campaignId: "11", adGroupId: "21", text: `shoe ${i}` }),
        ),
      },
    });
  it("fires over 20 keywords and is clean under", () => {
    expect(state(runOne("SK25", make(25)))).toBe("fires");
    expect(state(runOne("SK25", make(5)))).toBe("none_found");
  });
  it("is not checkable when keywords were not read", () => {
    expect(state(runOne("SK25", buildInput({ campaigns: [{ id: "11" }] })))).toBe("not_checkable");
  });
});

describe("SK23 keyword with spend and no search term", () => {
  const term = (kw: string, text: string): Row => ({
    ...searchTerm({ campaignId: "11", adGroupId: "21", term: text, cost: 5, clicks: 5, conv: 1 }),
    keyword_criterion_id: kw,
  });
  const make = (terms: Row[]) =>
    buildInput({
      campaigns: [{ id: "11" }],
      data: {
        adGroups: [adGroup({ id: "21", campaignId: "11" })],
        keywords: [
          keyword({
            id: "31",
            campaignId: "11",
            adGroupId: "21",
            text: "a",
            cost: 300,
            clicks: 100,
          }),
          keyword({
            id: "32",
            campaignId: "11",
            adGroupId: "21",
            text: "b",
            cost: 300,
            clicks: 100,
          }),
          keyword({
            id: "33",
            campaignId: "11",
            adGroupId: "21",
            text: "c",
            cost: 300,
            clicks: 100,
          }),
        ],
        searchTerms: terms,
      },
    });
  it("fires on a spending keyword no term names, clean when each shows terms", () => {
    expect(
      findingsOf(runOne("SK23", make([term("31", "a x"), term("32", "b x")])))[0]?.scope.id,
    ).toBe("21~33");
    expect(
      state(runOne("SK23", make([term("31", "a x"), term("32", "b x"), term("33", "c x")]))),
    ).toBe("none_found");
  });
  it("is not checkable when no term names its keyword", () => {
    const terms = [searchTerm({ campaignId: "11", adGroupId: "21", term: "a x" })];
    expect(state(runOne("SK23", make(terms)))).toBe("not_checkable");
  });
});

describe("wave 2 in a whole run", () => {
  it("every new check reports an outcome on a Performance Max account", () => {
    const r = runChecks(pmaxAccount());
    for (const id of ["PX01", "PX03", "PX06", "PX09", "TR01", "SL05", "PR02", "SK25"])
      expect(r.checks.find((c) => c.id === id)).toBeDefined();
    expect(r.checks.find((c) => c.id === "PX08")?.status).toBe("not_run");
  });
  it("a note-only check states info, never a finding", () => {
    const r = runChecks(buildInput({ campaigns: [{ id: "11" }, { id: "12" }] }));
    expect(r.checks.find((c) => c.id === "PR02")?.status).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// what was not read is never clean, and the edges of the bars
// ---------------------------------------------------------------------------

/** The status row of a table replaced (the coverage note the snapshot writes on it). */
function withStatusRow(input: EvidenceInput, table: string, row: Row): EvidenceInput {
  return {
    ...input,
    statusRows: [
      ...(input.statusRows ?? []).filter((r) => r.table_name !== table),
      { table_name: table, ...row },
    ],
  };
}

describe("Performance Max categories not read", () => {
  const second: CampaignSpec = { ...PMAX, id: "42", name: "PMax second" };
  const brandSearch: CampaignSpec = { id: "12", name: "Brand search", cost: 10 };
  const make = (rows: Row[]) => {
    const input = pmaxAccount({ campaigns: [PMAX, second, brandSearch], insights: rows });
    return withStatusRow(
      {
        ...input,
        data: { ...input.data, profile: { brandTerms: ["Acme"], businessType: "ecommerce" } },
      },
      "pmax_search_insights",
      {
        status: "ok",
        row_count: rows.length,
        error_message: "coverage partial: campaigns not read: 42",
      },
    );
  };
  it("PX02 is never clean while a campaign's categories were not read", () => {
    const r = runOne("PX02", make([category("running shoes", 95), category("acme", 5)]));
    expect(r).toMatchObject({ state: "not_checkable", category: "our_gap" });
    expect(r.state === "not_checkable" ? r.reason : "").toMatch(/PMax second/);
  });
  it("PX02 still reports what it found, naming the campaigns not read", () => {
    const r = runOne("PX02", make([category("acme boots", 80), category("running shoes", 20)]));
    expect(findingsOf(r)[0]?.limitedBy?.[0]).toMatch(/PMax second/);
  });
  it("PX12 is never clean while a campaign's categories were not read", () => {
    const input = make([category("rain coats", 50)]);
    const withSearch = withStatus(
      {
        ...input,
        data: {
          ...input.data,
          adGroups: [adGroup({ id: "21", campaignId: "12" })],
          keywords: [keyword({ id: "31", campaignId: "12", adGroupId: "21", text: "acme" })],
          searchTerms: [searchTerm({ campaignId: "12", adGroupId: "21", term: "acme shop" })],
        },
      },
      { ad_groups: 1, keywords: 1, search_terms: 1 },
    );
    const r = runOne("PX12", withSearch);
    // the read campaign shows no overlap; the unread one is named, never clean
    expect(r).toMatchObject({ state: "not_checkable", category: "our_gap" });
    expect(r.state === "not_checkable" ? r.reason : "").toMatch(
      /PMax second were not read; the campaigns read show no overlap/,
    );
  });
  it("PX02 needs the brand names", () => {
    const input = pmaxAccount({ campaigns: [PMAX], insights: [category("acme", 50)] });
    expect(runOne("PX02", input)).toMatchObject({
      state: "not_checkable",
      category: "needs_client_input",
    });
  });
});

describe("PX19 places read only in part", () => {
  const rows = [
    placement("example.com", "WEBSITE", 5000),
    placement("news.example", "WEBSITE", 4000),
  ];
  it("a list cut at the per-campaign limit is never clean", () => {
    const input = {
      ...pmaxAccount({ placements: rows }),
      caps: { "pmax_placements:per_campaign": 2 },
    };
    expect(runOne("PX19", input)).toMatchObject({ state: "not_checkable", category: "our_gap" });
  });
  it("a campaign not read is never clean, and is named", () => {
    const input = withStatusRow(pmaxAccount({ placements: rows }), "pmax_placements", {
      status: "ok",
      row_count: 2,
      error_message: "coverage partial: campaigns not read: 41",
    });
    const r = runOne("PX19", input);
    expect(r.state).toBe("not_checkable");
    expect(r.state === "not_checkable" ? r.reason : "").toMatch(/PMax all products/);
  });
  it("too few impressions to judge is thin data", () => {
    const input = pmaxAccount({ placements: [placement("example.com", "WEBSITE", 500)] });
    expect(runOne("PX19", input)).toMatchObject({ state: "not_checkable", category: "thin_data" });
  });
});

describe("BB13 shared bidding strategies", () => {
  it("a campaign on a portfolio strategy is not judged", () => {
    const input = buildInput({
      campaigns: [{ id: "11", extra: { bidding_strategy_source: "portfolio" } }],
      data: {
        changeHistory: [
          {
            change_resource_name: "customers/1/campaigns/11",
            change_date_time: `${dayBefore(LAST_DAY, 5)} 10:00:00`,
            changed_fields: "maximize_conversion_value.target_roas",
            changed_values: { "maximizeConversionValue.targetRoas": { old: 4, new: 2 } },
            operation: "UPDATE",
            client_type: "GOOGLE_ADS_WEB_CLIENT",
            resource_type: "CAMPAIGN",
          },
        ],
      },
    });
    expect(runOne("BB13", input)).toMatchObject({
      state: "not_checkable",
      category: "google_withholds",
    });
  });
});

describe("edges", () => {
  it("PX14: siblings under the conversion floor are not judged, never clean", () => {
    const r = runOne(
      "PX14",
      pmaxAccount({
        campaigns: [{ ...PMAX, cost: 100 }],
        groups: [
          group("51", { cost: 8500, value: 8500, conv: 40 }),
          group("52", { cost: 500, value: 2500, conv: 2 }),
        ],
      }),
    );
    expect(r).toMatchObject({ state: "not_checkable", category: "thin_data" });
  });
  it("TR05: 30 days paused is not yet dormant, 31 is", () => {
    const paused = (daysAgo: number) =>
      buildInput({
        campaigns: [
          { id: "11" },
          {
            id: "12",
            status: "PAUSED",
            extra: { last_active_date: dayBefore(LAST_DAY, daysAgo) },
          },
        ],
      });
    expect(state(runOne("TR05", paused(30)))).toBe("none_found");
    expect(state(runOne("TR05", paused(31)))).toBe("fires");
  });
});

describe("settings and channels", () => {
  it("every setting's default lies inside its own range", () => {
    expect(validateSettings(structuredClone(DEFAULT_SETTINGS)).warnings).toEqual([]);
  });
  it("Performance Max channels by their v26 network names", () => {
    expect(
      ["SEARCH", "CONTENT", "YOUTUBE", "DISCOVER", "GMAIL", "MAPS", "GOOGLE_TV", "MIXED"].map(
        classifyChannel,
      ),
    ).toEqual([
      "shopping",
      "video_display",
      "video_display",
      "video_display",
      "video_display",
      "video_display",
      "video_display",
      "unclassified",
    ]);
  });
});
