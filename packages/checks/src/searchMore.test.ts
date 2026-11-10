// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { explainCheck, runChecks, type EvidenceInput } from "./api.js";
import type { CheckResult } from "./engine/checks/types.js";
import { SK20_TITLE_COUNT, SK20_TITLE_VALUE } from "./engine/checks/search.js";
import { neighbourSlots, slotName } from "./engine/model/buildSlices.js";
import type { Row } from "./engine/shared/input.js";
import {
  adGroup,
  buildInput,
  keyword,
  runOne,
  searchTerm,
  type CampaignSpec,
  type FixtureOptions,
} from "./testing/account.js";

const state = (r: CheckResult) => r.state;
const findingsOf = (r: CheckResult) => (r.state === "fires" ? r.findings : []);

function withStatus(input: EvidenceInput, table: string, rows: number): EvidenceInput {
  return {
    ...input,
    statusRows: [
      ...(input.statusRows ?? []),
      { table_name: table, status: "ok", row_count: rows, error_message: null },
    ],
  };
}

const generic: CampaignSpec = { id: "11", name: "Generic search" };
const groups = [adGroup({ id: "21", campaignId: "11" }), adGroup({ id: "22", campaignId: "11" })];
const account = (opts: Partial<FixtureOptions> = {}, campaigns: CampaignSpec[] = [generic]) =>
  buildInput({ campaigns, ...opts, data: { adGroups: groups, ...(opts.data ?? {}) } });

/** Campaign negatives read for campaign 11 (none), so a term's blocked state is known. */
const negativesRead = (input: EvidenceInput, campaignRows: Row[] = []): EvidenceInput =>
  withStatus(
    withStatus(
      {
        ...input,
        tables: {
          ...input.tables,
          campaign_negatives: campaignRows,
          campaign_negatives_sync_marker: [{ campaign_id: "11" }],
        },
      },
      "campaign_negatives",
      campaignRows.length,
    ),
    "campaign_negatives_sync_marker",
    1,
  );

describe("SK06 a negative already blocks the search (context only)", () => {
  const terms = [searchTerm({ campaignId: "11", adGroupId: "21", term: "free boots" })];
  it("fires when an account negative blocks a served search", () => {
    const input = negativesRead(
      account({
        data: {
          searchTerms: terms,
          accountNegatives: [{ keyword_text: "free", match_type: "BROAD" }],
        },
        syncedEmpty: ["sharedNegativeLists", "sharedNegativeListMembers"],
      }),
    );
    expect(findingsOf(runOne("SK06", input))[0]?.facts.blocked_level).toBe("account");
  });
  it("is clean when nothing blocks it", () => {
    const input = negativesRead(
      account({
        data: { searchTerms: terms },
        syncedEmpty: ["sharedNegativeLists", "sharedNegativeListMembers", "accountNegatives"],
      }),
    );
    expect(state(runOne("SK06", input))).toBe("none_found");
  });
  it("is not checkable when the negatives were not read", () => {
    expect(state(runOne("SK06", account({ data: { searchTerms: terms } })))).toBe("not_checkable");
  });
});

describe("SK07 generic searches in a brand campaign", () => {
  const brand: CampaignSpec = { id: "12", name: "Brand search", cost: 200 };
  const input = (genericCost: number, brandTerms: string[] = ["acme"]) =>
    buildInput({
      campaigns: [{ ...generic, cost: 200 }, brand],
      profile: { businessType: "ecommerce", brandTerms },
      data: {
        adGroups: [adGroup({ id: "25", campaignId: "12" })],
        searchTerms: [
          searchTerm({ campaignId: "12", adGroupId: "25", term: "acme boots", cost: 100 }),
          searchTerm({ campaignId: "12", adGroupId: "25", term: "cheap boots", cost: genericCost }),
        ],
      },
    });
  it("fires when generic searches take the bar share of a brand campaign", () => {
    expect(findingsOf(runOne("SK07", input(60)))[0]?.scope.id).toBe("12");
  });
  it("is clean under the bar", () => {
    expect(state(runOne("SK07", input(5)))).toBe("none_found");
  });
  it("is not checkable without brand terms", () => {
    expect(state(runOne("SK07", input(60, [])))).toBe("not_checkable");
  });
});

describe("SK07 the account's own brand list and brand keywords count as brand", () => {
  const brand: CampaignSpec = { id: "12", name: "Brand search", cost: 200 };
  const list = (members: string[]) => ({
    sharedNegativeLists: [
      { shared_set_id: "81", shared_set_name: "brand searches", member_count: members.length },
    ],
    sharedNegativeListMembers: members.map((keyword_text) => ({
      shared_set_id: "81",
      shared_set_name: "brand searches",
      keyword_text,
      match_type: "EXACT",
    })),
  });
  const input = (data: Record<string, Row[]> = {}) =>
    buildInput({
      campaigns: [{ ...generic, cost: 200 }, brand],
      profile: { businessType: "ecommerce", brandTerms: ["Acme Widgets"] },
      data: {
        adGroups: [adGroup({ id: "25", campaignId: "12" })],
        searchTerms: [
          searchTerm({ campaignId: "12", adGroupId: "25", term: "acme widgets", cost: 100 }),
          searchTerm({ campaignId: "12", adGroupId: "25", term: "acme boots", cost: 60 }),
          searchTerm({ campaignId: "12", adGroupId: "25", term: "cheap boots", cost: 5 }),
          searchTerm({ campaignId: "12", adGroupId: "25", term: "leather boots", cost: 5 }),
        ],
        ...data,
      },
    });
  it("a partial brand search is generic without the account's brand vocabulary", () => {
    expect(findingsOf(runOne("SK07", input()))[0]?.scope.id).toBe("12");
  });
  it("is brand when a shared list holding the own brand lists it (exact, never contained)", () => {
    const r = runOne("SK07", input(list(["acme widgets", "acme boots", "cheap"])));
    expect(state(r)).toBe("none_found");
  });
  it("a list without the whole brand name is not the brand's list", () => {
    expect(state(runOne("SK07", input(list(["acme boots"]))))).toBe("fires");
  });
  it("a brand campaign keyword counts only when it carries a brand word", () => {
    const kws = (text: string) => ({
      keywords: [keyword({ id: "35", campaignId: "12", adGroupId: "25", text })],
    });
    expect(state(runOne("SK07", input(kws("acme boots"))))).toBe("none_found");
    // a broad generic keyword in the brand campaign never makes its searches brand
    const r = runOne(
      "SK07",
      input({ ...kws("leather boots"), ...list(["acme widgets", "cheap boots"]) }),
    );
    expect(state(r)).toBe("fires");
  });
});

describe("SK08 a search is a keyword in another ad group of the campaign", () => {
  const boots = keyword({
    id: "31",
    campaignId: "11",
    adGroupId: "21",
    text: "boots",
    match: "BROAD",
  });
  const kws = [
    boots,
    keyword({ id: "32", campaignId: "11", adGroupId: "22", text: "hiking boots" }),
  ];
  // the broad "boots" in ad group 21 took the search: Google names its own keyword
  const term = (adGroupId: string, criterion: string) => ({
    ...searchTerm({ campaignId: "11", adGroupId, term: "hiking boots" }),
    keyword_criterion_id: criterion,
    keyword_ad_group_id: adGroupId,
  });
  it("fires when the search is word for word a keyword in another ad group", () => {
    const r = runOne("SK08", account({ data: { keywords: kws, searchTerms: [term("21", "31")] } }));
    const f = findingsOf(r)[0];
    expect(f?.facts).toMatchObject({
      keyword: "hiking boots",
      keyword_ad_group: "Ad group 22",
      served_ad_group: "Ad group 21",
    });
  });
  it("is clean when the ad group that holds the keyword served it", () => {
    const r = runOne("SK08", account({ data: { keywords: kws, searchTerms: [term("22", "32")] } }));
    expect(state(r)).toBe("none_found");
  });
  it("is clean when the serving ad group has the same keyword too", () => {
    const both = [
      ...kws,
      keyword({ id: "32", campaignId: "11", adGroupId: "21", text: "hiking boots" }),
    ];
    const r = runOne(
      "SK08",
      account({ data: { keywords: both, searchTerms: [term("21", "32")] } }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("ignores a paused keyword and a keyword in another campaign", () => {
    const paused = [
      boots,
      keyword({
        id: "32",
        campaignId: "11",
        adGroupId: "22",
        text: "hiking boots",
        status: "PAUSED",
      }),
    ];
    expect(
      state(
        runOne("SK08", account({ data: { keywords: paused, searchTerms: [term("21", "31")] } })),
      ),
    ).toBe("none_found");
    const other = account(
      {
        data: {
          adGroups: [...groups, adGroup({ id: "23", campaignId: "12" })],
          keywords: [
            boots,
            keyword({ id: "32", campaignId: "12", adGroupId: "23", text: "hiking boots" }),
          ],
          searchTerms: [term("21", "31")],
        },
      },
      [generic, { id: "12", name: "Other search" }],
    );
    expect(state(runOne("SK08", other))).toBe("none_found");
  });
  it("is clean when the keyword moved: paused in the serving ad group, added in another", () => {
    // "hiking boots" paused in 21, added in 22; the old search row was served by 21
    const moved = [
      ...kws,
      keyword({
        id: "33",
        campaignId: "11",
        adGroupId: "21",
        text: "hiking boots",
        status: "PAUSED",
      }),
    ];
    const r = runOne(
      "SK08",
      account({ data: { keywords: moved, searchTerms: [term("21", "33")] } }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("needs no keyword id on the search terms (B10: the old id path could never fire)", () => {
    const r = runOne(
      "SK08",
      account({
        data: {
          keywords: kws,
          searchTerms: [searchTerm({ campaignId: "11", adGroupId: "21", term: "Hiking Boots" })],
        },
      }),
    );
    expect(state(r)).toBe("fires");
  });
});

describe("SK09 a converting search that is not a keyword", () => {
  const kws = [keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "boots" })];
  it("fires on a converting search no keyword covers", () => {
    const terms = [searchTerm({ campaignId: "11", adGroupId: "21", term: "red boots", conv: 2 })];
    const r = runOne("SK09", account({ data: { keywords: kws, searchTerms: terms } }));
    expect(findingsOf(r)[0]?.scope.name).toBe("red boots");
  });
  it("is clean when every converting search is a keyword", () => {
    const terms = [searchTerm({ campaignId: "11", adGroupId: "21", term: "boots", conv: 2 })];
    const r = runOne("SK09", account({ data: { keywords: kws, searchTerms: terms } }));
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when the keywords were not read", () => {
    const terms = [searchTerm({ campaignId: "11", adGroupId: "21", term: "boots", conv: 2 })];
    expect(state(runOne("SK09", account({ data: { searchTerms: terms } })))).toBe("not_checkable");
  });
});

describe("SK09 at least 2 sales, one line per search, no brand searches", () => {
  const brandC: CampaignSpec = { id: "12", name: "Search - Brand" };
  const nb: CampaignSpec = { id: "11", name: "Search - Article" };
  const other: CampaignSpec = { id: "13", name: "Search - Mugs" };
  const kws = [keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "boots" })];
  const sGroups = [
    adGroup({ id: "21", campaignId: "11" }),
    adGroup({ id: "22", campaignId: "12" }),
    adGroup({ id: "23", campaignId: "13" }),
  ];
  const run = (terms: Row[]) =>
    runOne(
      "SK09",
      account(
        {
          data: { keywords: kws, searchTerms: terms, adGroups: sGroups },
          profile: { businessType: "ecommerce", brandTerms: ["Acme Leather"] },
        },
        [nb, brandC, other],
      ),
    );
  it("the 9 one-sale searches are not findings", () => {
    const ones = [
      "womens mugs leather",
      "womens leather mugs",
      "designer mugs",
      "new york leather",
    ].map((term) => searchTerm({ campaignId: "11", adGroupId: "21", term, conv: 1 }));
    const r = run([
      ...ones,
      searchTerm({ campaignId: "11", adGroupId: "21", term: "x", conv: 0.4 }),
    ]);
    expect(state(r)).toBe("none_found");
    expect(r.state === "none_found" ? r.note : "").toMatch(/5 with under 2 sales left out/);
  });
  it("one search in two campaigns is one line, its sales summed", () => {
    const r = run([
      searchTerm({ campaignId: "11", adGroupId: "21", term: "Leather Mugs Women", conv: 1 }),
      searchTerm({ campaignId: "13", adGroupId: "23", term: "leather mugs women", conv: 1 }),
    ]);
    const f = findingsOf(r);
    expect(f).toHaveLength(1);
    expect(f[0]?.facts.conversions).toBe(2);
    expect(f[0]?.facts.campaigns).toBe(2);
  });
  it("brand searches are left out: the brand name, or only the Brand campaign ran on it", () => {
    const r = run([
      searchTerm({ campaignId: "11", adGroupId: "21", term: "leather acme", conv: 3 }),
      searchTerm({ campaignId: "11", adGroupId: "21", term: "acme leather review", conv: 2 }),
      // only in the Brand campaign
      searchTerm({ campaignId: "12", adGroupId: "22", term: "mug shop", conv: 4 }),
    ]);
    expect(state(r)).toBe("none_found");
    expect(r.state === "none_found" ? r.note : "").toMatch(/3 brand search\(es\)/);
  });
  it("one row in the Brand campaign does not drop a generic search; only its other sales count", () => {
    // "leather mugs": 1 sale in Brand, 1 + 2 in two generic campaigns -> 3 counted
    const r = run([
      searchTerm({ campaignId: "12", adGroupId: "22", term: "leather mugs", conv: 1 }),
      searchTerm({ campaignId: "11", adGroupId: "21", term: "leather mugs", conv: 1 }),
      searchTerm({ campaignId: "13", adGroupId: "23", term: "leather mugs", conv: 2 }),
    ]);
    const f = findingsOf(r);
    expect(f).toHaveLength(1);
    expect(f[0]?.facts.conversions).toBe(3);
    expect(f[0]?.facts.campaign_names).toBe("Search - Article, Search - Mugs");
  });
  it("a generic search with 1 sale outside Brand and 3 in Brand is under the bar", () => {
    const r = run([
      searchTerm({ campaignId: "12", adGroupId: "22", term: "leather mugs", conv: 3 }),
      searchTerm({ campaignId: "11", adGroupId: "21", term: "leather mugs", conv: 1 }),
    ]);
    expect(state(r)).toBe("none_found");
    expect(r.state === "none_found" ? r.note : "").toMatch(/1 with under 2 sales/);
  });
});

describe("SK09 keywords are added in Search campaigns only", () => {
  const shop: CampaignSpec = { id: "14", name: "Shopping - Mugs", type: "SHOPPING" };
  const kws = [keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "boots" })];
  const sGroups = [...groups, adGroup({ id: "24", campaignId: "14" })];
  const run = (terms: Row[]) =>
    runOne(
      "SK09",
      account({ data: { keywords: kws, searchTerms: terms, adGroups: sGroups } }, [generic, shop]),
    );
  it("a Shopping campaign's converting search is no finding", () => {
    const r = run([
      searchTerm({ campaignId: "14", adGroupId: "24", term: "mugs for women", conv: 5 }),
    ]);
    expect(state(r)).toBe("none_found");
    expect(r.state === "none_found" ? r.note : "").toMatch(/0 converting Search-campaign searches/);
  });
  it("the same search in a Search campaign fires, its sales counted from Search rows only", () => {
    const r = run([
      searchTerm({ campaignId: "14", adGroupId: "24", term: "mugs for women", conv: 5 }),
      searchTerm({ campaignId: "11", adGroupId: "21", term: "mugs for women", conv: 2 }),
    ]);
    const f = findingsOf(r);
    expect(f).toHaveLength(1);
    expect(f[0]?.facts.conversions).toBe(2);
    expect(f[0]?.facts.campaign_type).toBe("SEARCH");
    expect(f[0]?.facts.campaign_names).toBe("Generic search");
  });
});

describe("SK10 dynamic search ads overlap", () => {
  const dsaCampaign: CampaignSpec = { id: "12", name: "Dynamic search" };
  const words = ["boots a", "boots b", "boots c", "boots d", "boots e"];
  const input = (overlap: number) =>
    buildInput({
      campaigns: [generic, dsaCampaign],
      data: {
        adGroups: [...groups, adGroup({ id: "25", campaignId: "12" })],
        searchTerms: words
          .slice(0, overlap)
          .map((w) => searchTerm({ campaignId: "11", adGroupId: "21", term: w })),
        dsaSearchTerms: words.map((w) =>
          searchTerm({ campaignId: "12", adGroupId: "25", term: w }),
        ),
      },
    });
  it("fires when the DSA campaign buys the bar's number of searches another campaign covers", () => {
    expect(findingsOf(runOne("SK10", input(5)))[0]?.scope.id).toBe("12");
  });
  it("is clean under the bar, and its own search-term rows are no overlap", () => {
    expect(state(runOne("SK10", input(2)))).toBe("none_found");
    const own = input(0);
    const self = words.map((w) => searchTerm({ campaignId: "12", adGroupId: "25", term: w }));
    const r = runOne("SK10", { ...own, data: { ...own.data, searchTerms: self } });
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when the DSA searches were not read", () => {
    expect(state(runOne("SK10", account()))).toBe("not_checkable");
  });
});

/** An ad row; `headlines` texts, optionally pinned. */
const ad = (r: {
  id: string;
  adGroupId?: string;
  headlines?: number;
  pinned?: number;
  type?: string;
  status?: string;
  url?: string;
  impressions?: number;
}): Row => ({
  ad_id: r.id,
  ad_group_id: r.adGroupId ?? "21",
  campaign_id: "11",
  type: r.type ?? "RESPONSIVE_SEARCH_AD",
  status: r.status ?? "ENABLED",
  headlines: Array.from({ length: r.headlines ?? 12 }, (_, i) => ({
    text: `Headline ${i}`,
    pinnedField: i < (r.pinned ?? 0) ? "HEADLINE_1" : null,
  })),
  descriptions: [{ text: "Description", pinnedField: null }],
  final_urls: [r.url ?? "https://example.com/collections/boots"],
  cost: 100,
  clicks: 50,
  impressions: r.impressions ?? 1000,
  conversions: 2,
  conversion_value: 400,
});
const spendingGroups = [
  { ...adGroup({ id: "21", campaignId: "11" }), cost: 900, clicks: 300, impressions: 6000 },
  { ...adGroup({ id: "22", campaignId: "11" }), cost: 900, clicks: 300, impressions: 6000 },
];
const withAds = (ads: Row[], extra: Partial<FixtureOptions["data"]> = {}) =>
  account({ data: { adGroups: spendingGroups, ads, ...extra } });

describe("SK11 responsive search ads per ad group", () => {
  it("fires on a spending ad group with no responsive search ad", () => {
    const r = runOne("SK11", withAds([ad({ id: "41" }), ad({ id: "42" })]));
    expect(findingsOf(r).map((f) => f.scope.id)).toEqual(["22"]);
  });
  it("is clean with one to three in each", () => {
    const r = runOne("SK11", withAds([ad({ id: "41" }), ad({ id: "42", adGroupId: "22" })]));
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when the ads were not read", () => {
    expect(state(runOne("SK11", account({ data: { adGroups: spendingGroups } })))).toBe(
      "not_checkable",
    );
  });
  // R4: one ad group is the normal shape of a brand campaign; one ad in it is the fault
  const brandOnly = (ads: number) =>
    account(
      {
        profile: { businessType: "ecommerce", brandTerms: ["acme"] },
        data: {
          adGroups: [
            ...spendingGroups,
            {
              ...adGroup({ id: "25", campaignId: "12" }),
              cost: 900,
              clicks: 300,
              impressions: 6000,
            },
          ],
          ads: [
            ad({ id: "41" }),
            ad({ id: "42", adGroupId: "22" }),
            ...Array.from({ length: ads }, (_, i) => ({
              ...ad({ id: `5${i}`, adGroupId: "25" }),
              campaign_id: "12",
            })),
          ],
        },
      },
      [generic, { id: "12", name: "Brand search" }],
    );
  it("R4: a brand campaign with one ad group and 2 ads is not a fault", () => {
    expect(state(runOne("SK11", brandOnly(2)))).toBe("none_found");
  });
  it("R4: a brand ad group with one ad still is", () => {
    const f = findingsOf(runOne("SK11", brandOnly(1)))[0];
    expect(f?.scope.id).toBe("25");
    expect(f?.facts.brand_single_ad).toBe(true);
  });
});

describe("SK12 few headlines", () => {
  it("fires under the headline bar", () => {
    expect(state(runOne("SK12", withAds([ad({ id: "41", headlines: 5 })])))).toBe("fires");
  });
  it("is clean at the bar, and the bar is a setting", () => {
    expect(state(runOne("SK12", withAds([ad({ id: "41", headlines: 12 })])))).toBe("none_found");
    const strict = {
      ...withAds([ad({ id: "41", headlines: 12 })]),
      settings: { search: { rsaMinHeadlines: 15 } },
    };
    expect(state(runOne("SK12", strict))).toBe("fires");
  });
  it("is not checkable with no responsive search ad", () => {
    expect(state(runOne("SK12", withAds([ad({ id: "41", type: "EXPANDED_TEXT_AD" })])))).toBe(
      "not_checkable",
    );
  });
});

describe("SK13 pinning", () => {
  it("fires when an ad pins three or more lines", () => {
    expect(state(runOne("SK13", withAds([ad({ id: "41", pinned: 3 })])))).toBe("fires");
  });
  it("is clean when it pins fewer", () => {
    expect(state(runOne("SK13", withAds([ad({ id: "41", pinned: 1 })])))).toBe("none_found");
  });
  it("is not checkable when pinning was not read", () => {
    const noPins = { ...ad({ id: "41" }), headlines: [{ text: "Headline" }] };
    expect(state(runOne("SK13", withAds([noPins])))).toBe("not_checkable");
  });
});

describe("SK14 an asset rated LOW", () => {
  const rated = (label: string): Row => ({
    asset_id: "5001",
    ad_resource: "customers/1/adGroupAds/21~41",
    field_type: "HEADLINE",
    performance_label: label,
    asset_text: "Headline 0",
  });
  it("fires on a LOW rating with enough impressions", () => {
    const r = runOne("SK14", withAds([ad({ id: "41" })], { assetPerformance: [rated("LOW")] }));
    expect(findingsOf(r)[0]?.facts.performance_label).toBe("LOW");
  });
  it("is clean when nothing is rated LOW", () => {
    const r = runOne("SK14", withAds([ad({ id: "41" })], { assetPerformance: [rated("GOOD")] }));
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when the ratings were not read", () => {
    expect(state(runOne("SK14", withAds([ad({ id: "41" })])))).toBe("not_checkable");
  });
});

describe("SK15 an ad not fully approved", () => {
  const policy = (status: string): Row => ({
    ad_id: "41",
    campaign_id: "11",
    ad_group_id: "21",
    approval_status: status,
    ad_status: "ENABLED",
    ad_group_status: "ENABLED",
    campaign_status: "ENABLED",
  });
  it("fires on a disapproved live ad", () => {
    const r = runOne(
      "SK15",
      withAds([ad({ id: "41" })], { adPolicyData: [policy("DISAPPROVED")] }),
    );
    expect(findingsOf(r)[0]?.facts.approval_status).toBe("DISAPPROVED");
  });
  it("names the ad's own spend as money at risk, and the finding is priced with it", () => {
    const input = withAds([ad({ id: "41" })], { adPolicyData: [policy("DISAPPROVED")] });
    // ads carry no daily series: the 90-day audit-window spend, priced per month as / 3
    expect(findingsOf(runOne("SK15", input))[0]?.facts.at_risk_cost_90d).toBe(100);
    const scored = runChecks(input).findings.find((f) => f.checkId === "SK15");
    expect(scored?.impact.quantified).toBe(true);
    expect(scored?.impact.value).toBeCloseTo(100 / 3, 2);
    expect(scored?.impact.kind).toBe("at_risk");
    expect(scored?.severity.severity).toBe("warning");
  });
  it("a live ad with no spend in the window carries no money", () => {
    // ad 99 is live and disapproved but has no row in the (spend-gated) ads table
    const r = runOne(
      "SK15",
      withAds([ad({ id: "41" })], {
        adPolicyData: [policy("APPROVED"), { ...policy("DISAPPROVED"), ad_id: "99" }],
      }),
    );
    const f = findingsOf(r)[0];
    expect(f?.facts.ad_has_spend_in_window).toBe(false);
    expect(f?.facts.at_risk_cost_90d).toBeUndefined();
  });
  it("is clean when every live ad is approved", () => {
    const r = runOne("SK15", withAds([ad({ id: "41" })], { adPolicyData: [policy("APPROVED")] }));
    expect(state(r)).toBe("none_found");
  });
  it("an ad in a paused ad group is not live: its verdict is not judged", () => {
    const paused = { ...policy("DISAPPROVED"), ad_group_status: "PAUSED" };
    const r = runOne("SK15", withAds([ad({ id: "41" })], { adPolicyData: [paused] }));
    expect(state(r)).toBe("not_checkable");
  });
  it("is not checkable when policy was not read", () => {
    expect(state(runOne("SK15", withAds([ad({ id: "41" })])))).toBe("not_checkable");
  });
});

/** An asset link (extension) row. */
const ext = (type: string, i: number, extra: Row = {}): Row => ({
  asset_id: `${type}-${i}`,
  extension_type: type,
  level: "CAMPAIGN",
  campaign_id: "11",
  status: "ENABLED",
  text: `${type.toLowerCase()} ${i}`,
  ...extra,
});
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
// M18 (J33): the Search bar is 8 sitelinks and 10 callouts
const fullSet = [
  ...upTo(8).map((i) => ext("SITELINK", i)),
  ...upTo(10).map((i) => ext("CALLOUT", i)),
  ext("STRUCTURED_SNIPPET", 1),
];

describe("SK16 asset types a campaign can serve", () => {
  it("fires when a type is missing or short", () => {
    const r = runOne("SK16", account({ data: { adExtensions: fullSet.slice(8) } }));
    expect(findingsOf(r)[0]?.facts.missing_types).toBe("SITELINK");
  });
  it("is clean with the full set", () => {
    expect(state(runOne("SK16", account({ data: { adExtensions: fullSet } })))).toBe("none_found");
  });
  it("counts account-level assets for a campaign with none of that type", () => {
    const accountLinks = upTo(8).map((i) =>
      ext("SITELINK", i, { level: "ACCOUNT", campaign_id: null }),
    );
    const r = runOne(
      "SK16",
      account({ data: { adExtensions: [...fullSet.slice(8), ...accountLinks] } }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when the assets were not read", () => {
    expect(state(runOne("SK16", account()))).toBe("not_checkable");
  });
});

describe("account-level assets are no orphans", () => {
  it("SK16 is clean (not held back) with account-level sitelinks beside a campaign's own assets", () => {
    const accountLinks = upTo(8).map((i) =>
      ext("SITELINK", i, { level: "ACCOUNT", campaign_id: null }),
    );
    const input = account({ data: { adExtensions: [...fullSet.slice(8), ...accountLinks] } });
    expect(runChecks(input).checks.find((c) => c.id === "SK16")?.status).toBe("clean");
  });
});

describe("SK17 a callout never served", () => {
  const callouts = (impressions: number | undefined) =>
    account({
      data: {
        adExtensions: [1, 2].map((i) =>
          ext("CALLOUT", i, impressions === undefined ? {} : { impressions }),
        ),
      },
    });
  it("fires when a callout has no impressions anywhere", () => {
    expect(state(runOne("SK17", callouts(0)))).toBe("fires");
  });
  it("is clean when each callout served", () => {
    expect(state(runOne("SK17", callouts(50)))).toBe("none_found");
  });
  it("is not checkable while asset impressions are not read", () => {
    const r = runOne("SK17", callouts(undefined));
    expect(r.state === "not_checkable" && r.reason).toMatch(/doesn't read yet/);
  });
});

describe("SK18 promotion value or date", () => {
  const promo = (endDate: string, percentOff = 15) =>
    account({
      data: { adExtensions: [ext("PROMOTION", 1, { metadata: { percentOff, endDate } })] },
    });
  it("fires on a promotion that already ended", () => {
    expect(findingsOf(runOne("SK18", promo("2026-08-01")))[0]?.facts.reason).toBe(
      "end date in the past",
    );
  });
  it("R8: an ended promotion is a note (Google stops showing it), an impossible value is not", () => {
    expect(findingsOf(runOne("SK18", promo("2026-08-01")))[0]?.maxSeverity).toBe("info");
    const ended = runChecks(promo("2026-08-01")).findings.find((x) => x.checkId === "SK18");
    expect(ended?.severity.severity).toBe("info");
    expect(findingsOf(runOne("SK18", promo("2026-12-31", 150)))[0]?.maxSeverity).toBeUndefined();
  });
  it("is clean on a running promotion", () => {
    expect(state(runOne("SK18", promo("2026-12-31")))).toBe("none_found");
  });
  it("is not checkable with no promotion", () => {
    expect(state(runOne("SK18", account({ data: { adExtensions: fullSet } })))).toBe(
      "not_checkable",
    );
  });
});

const page = (url: string, clicks = 200, conv = 8): Row => ({
  url,
  cost: 400,
  clicks,
  impressions: clicks * 20,
  conversions: conv,
  conversion_value: conv * 100,
});

describe("SK19 landing page over http", () => {
  it("fires on an http page", () => {
    const r = runOne(
      "SK19",
      account({ data: { landingPageViews: [page("http://example.com/a")] } }),
    );
    expect(state(r)).toBe("fires");
  });
  it("an http link with no error found is never priced", () => {
    const f = runChecks(
      account({ data: { landingPageViews: [{ ...page("http://example.com/a"), cost: 600 }] } }),
    ).findings.find((x) => x.checkId === "SK19");
    expect(f).toBeDefined();
    expect(f?.impact.quantified).toBe(false);
  });
  it("is clean on https", () => {
    const r = runOne(
      "SK19",
      account({ data: { landingPageViews: [page("https://example.com/a")] } }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when pages were not read", () => {
    expect(state(runOne("SK19", account()))).toBe("not_checkable");
  });
  it("a table cut short by time, or with no status at all, is incomplete data, not our gap", () => {
    const base = account({ data: { landingPageViews: [page("http://example.com/a")] } });
    const cut = {
      ...base,
      statusRows: [
        ...(base.statusRows ?? []).filter((r) => r.table_name !== "landing_page_views"),
        {
          table_name: "landing_page_views",
          status: "skipped",
          row_count: 0,
          error_message: "stopped before any row was read (time or row limit)",
        },
      ],
    };
    expect(runOne("SK19", cut)).toMatchObject({
      state: "not_checkable",
      category: "incomplete_data",
    });
    expect(runOne("SK19", account())).toMatchObject({
      state: "not_checkable",
      category: "incomplete_data",
    });
  });
  it("prices only the http rows when the same path is read over http and https", () => {
    const r = runOne(
      "SK19",
      account({
        data: {
          landingPageViews: [
            { ...page("https://example.com/a"), cost: 3000 },
            { ...page("http://example.com/a"), cost: 2 },
          ],
        },
      }),
    );
    expect(state(r)).toBe("fires");
    const f = findingsOf(r);
    expect(f).toHaveLength(1);
    expect(f[0]?.scope.name).toBe("http://example.com/a");
    expect(f[0]?.facts.spend).toBe(2);
  });
  it("reads HTTP:// and http:// rows of one path as one http page", () => {
    const r = runOne(
      "SK19",
      account({
        data: {
          landingPageViews: [
            { ...page("HTTP://example.com/a"), cost: 3 },
            { ...page("http://example.com/a"), cost: 2 },
          ],
        },
      }),
    );
    expect(state(r)).toBe("fires");
    const f = findingsOf(r);
    expect(f).toHaveLength(1);
    expect(f[0]?.scope.name).toBe("http://example.com/a");
    expect(f[0]?.facts.spend).toBe(5);
  });
});

describe("SK20 landing page converts below the account", () => {
  // the account converts at 4% (2 of 50 clicks a day)
  it("fires on a page under half the account rate", () => {
    const r = runOne(
      "SK20",
      account({ data: { landingPageViews: [page("https://example.com/a", 200, 1)] } }),
    );
    expect(state(r)).toBe("fires");
  });
  it("is clean on a page near the account rate", () => {
    const r = runOne(
      "SK20",
      account({ data: { landingPageViews: [page("https://example.com/a", 200, 8)] } }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("R17: judged on value it says the page returns less per $1, never 'converts below'", () => {
    const input = account({ data: { landingPageViews: [page("https://example.com/a", 200, 1)] } });
    expect(findingsOf(runOne("SK20", input))[0]?.title).toBe(SK20_TITLE_VALUE);
    const out = runChecks(input).findings.find((x) => x.checkId === "SK20");
    expect(out?.title).toBe(SK20_TITLE_VALUE);
    expect(out?.title).not.toMatch(/converts/);
  });
  it("is insufficient when no page reaches the click floor", () => {
    const r = runOne(
      "SK20",
      account({ data: { landingPageViews: [page("https://example.com/a", 20, 0)] } }),
    );
    expect(state(r)).toBe("insufficient_data");
  });
  it("reads one page split by query string or a {placeholder} as one page", () => {
    // 3 rows of 40 clicks: each alone is under the floor, the page together is not
    const r = runOne(
      "SK20",
      account({
        data: {
          landingPageViews: [
            page("https://example.com/p/mug{ignore}?utm_source=google&utm_content=ad1", 40, 0),
            page("https://example.com/p/mug?variant=1&utm_medium=product_sync", 40, 0),
            page("https://example.com/p/mug%7Bignore%7D?variant=2", 40, 0),
          ],
        },
      }),
    );
    expect(state(r)).toBe("fires");
    const f = findingsOf(r);
    expect(f).toHaveLength(1);
    expect(f[0]?.scope.name).toBe("https://example.com/p/mug");
    expect(f[0]?.facts.clicks).toBe(120);
  });
  it("round 2 (NEW-14): a page weak on its bare URL but strong via its variant URLs is judged whole", () => {
    // alone, the bare URL fires (1 sale on 200 clicks); its product links sell 15 on 200
    const bare = page("https://example.com/products/mug", 200, 1);
    expect(state(runOne("SK20", account({ data: { landingPageViews: [bare] } })))).toBe("fires");
    const r = runOne(
      "SK20",
      account({
        data: {
          landingPageViews: [
            bare,
            {
              ...page(
                "https://example.com/products/mug?variant=101&utm_medium=product_sync",
                120,
                9,
              ),
              cost: 100,
            },
            { ...page("https://example.com/products/mug?variant=102", 80, 6), cost: 100 },
          ],
        },
      }),
    );
    expect(state(r)).toBe("none_found");
  });
  // Phase F, a guide page: 11,000 clicks, 9 sales, every ad in a paused campaign
  const crack = "https://example.com/pages/care-guide";
  const withCampaigns = (adCampaign: string, adClicks = 11000) =>
    account(
      {
        data: {
          adGroups: [...groups, adGroup({ id: "25", campaignId: "12" })],
          ads: [
            {
              ...ad({ id: "81", adGroupId: adCampaign === "12" ? "25" : "21", url: crack }),
              campaign_id: adCampaign,
              clicks: adClicks,
            },
          ],
          // 9 sales worth $300 on $400: $0.75 per $1 against the account's $4
          landingPageViews: [{ ...page(crack, 11000, 9), conversion_value: 300 }],
        },
      },
      [generic, { id: "12", name: "DG drawer", status: "PAUSED" }],
    );
  it("holds back a page whose every ad sits in a paused campaign", () => {
    const r = runOne("SK20", withCampaigns("12"));
    expect(state(r)).toBe("fires");
    expect(findingsOf(r)).toHaveLength(0);
    expect(r.state === "fires" ? r.withheld?.join(" ") : "").toMatch(
      /1 page\(s\) held back: every ad or campaign that sends traffic there is not running/,
    );
    // the line keeps what the page cost and sold while it was live
    expect(r.state === "fires" ? r.withheld?.join(" ") : "").toContain(
      `${crack} (spend 400.00, 9 sales worth 300.00, 11000 clicks while it was live)`,
    );
  });
  it("keeps a page with mixed traffic: paused ads carry under 95% of its clicks", () => {
    // 10,000 of 11,000 clicks (91%) from the paused ad; the rest has no ad id (Shopping / PMax)
    expect(findingsOf(runOne("SK20", withCampaigns("12", 10000)))).toHaveLength(1);
    // 10,800 (98%) is all of it for this purpose: held back
    expect(findingsOf(runOne("SK20", withCampaigns("12", 10800)))).toHaveLength(0);
  });
  it("findings + withheld: the held-back page stays a line on the check's entry", () => {
    const input = withCampaigns("12");
    const pages = input.data.landingPageViews ?? [];
    const both = {
      ...input,
      data: { ...input.data, landingPageViews: [...pages, page("https://example.com/a", 200, 1)] },
    };
    expect(findingsOf(runOne("SK20", both))).toHaveLength(1);
    const entry = runChecks(both).checks.find((c) => c.id === "SK20");
    expect(entry?.status).toBe("finding");
    expect(entry?.note).toMatch(/1 page\(s\) held back/);
    expect(entry?.note).toContain(`${crack} (spend 400.00, 9 sales`);
  });
  it("keeps the page when a live ad sends traffic there", () => {
    expect(findingsOf(runOne("SK20", withCampaigns("11")))).toHaveLength(1);
  });
});

describe("SK20 on sales value, and pages only paused campaigns fed", () => {
  // the account returns $2.70 per $1 ($100 a day, $270 in sales)
  const shop: CampaignSpec = { id: "11", name: "PMax - Mugs", value: 270 };
  const lp = (url: string, clicks: number, conv: number, cost: number, value: number): Row => ({
    url,
    cost,
    clicks,
    impressions: clicks * 20,
    conversions: conv,
    conversion_value: value,
  });
  const jacket = "https://example.com/products/jacket";
  const strap = "https://example.com/pages/collection-page";
  it("jacket page: 5 sales but $1,217 on $599 ($2.03 per $1) is not a finding", () => {
    const r = runOne(
      "SK20",
      account({ data: { landingPageViews: [lp(jacket, 394, 5, 599.27, 1217)] } }, [shop]),
    );
    expect(findingsOf(r)).toHaveLength(0);
  });
  it("a collection page: $0.29 per $1 fires, judged on value, priced on value", () => {
    const input = account({ data: { landingPageViews: [lp(strap, 1518, 1, 297, 86)] } }, [shop]);
    const f = findingsOf(runOne("SK20", input))[0];
    expect(f?.facts.judged_on).toBe("sales value");
    expect(Number(f?.facts.return_per_dollar)).toBeCloseTo(0.29, 2);
    expect(Number(f?.facts.account_return_per_dollar)).toBeCloseTo(2.7, 2);
    const priced = runChecks(input).findings.find((x) => x.checkId === "SK20");
    // ($297 - $86 / 2.70) / 3 months
    expect(Number(priced?.impact.value)).toBeCloseTo((297 - 86 / 2.7) / 3, 1);
  });
  it("no sales value tracked: the sale count (conversion rate) decides", () => {
    const noValue: CampaignSpec = { id: "11", value: 0 };
    const r = runOne(
      "SK20",
      account({ data: { landingPageViews: [lp(jacket, 394, 1, 599.27, 0)] } }, [noValue]),
    );
    expect(findingsOf(r)[0]?.facts.judged_on).toBe("sale count");
    expect(findingsOf(r)[0]?.title).toBe(SK20_TITLE_COUNT);
  });
  // a .de mugs page, all 1,062 clicks from a paused PMax campaign (no ad id)
  const mugs = "https://example.de/collections/mugs";
  const dePmax: CampaignSpec = {
    id: "31",
    name: "PMax - Country C v2",
    type: "PERFORMANCE_MAX",
    status: "PAUSED",
  };
  const fedBy = (split: { campaign_id: string; clicks: number }[] | null) =>
    account(
      {
        data: {
          landingPageViews: [{ ...lp(mugs, 1062, 1, 525.19, 30), campaign_clicks: split }],
        },
      },
      [shop, dePmax],
    );
  it("a page only a paused PMax campaign fed is held back, with the campaign named", () => {
    const r = runOne("SK20", fedBy([{ campaign_id: "31", clicks: 1062 }]));
    expect(findingsOf(r)).toHaveLength(0);
    const line = r.state === "fires" ? (r.withheld?.join(" ") ?? "") : "";
    expect(line).toContain(
      `${mugs} (spend 525.19, 1 sales worth 30.00, 1062 clicks while it was live from PMax - Country C v2)`,
    );
  });
  it("a live campaign feeding over 5% of the clicks keeps the page", () => {
    const r = runOne(
      "SK20",
      fedBy([
        { campaign_id: "31", clicks: 900 },
        { campaign_id: "11", clicks: 162 },
      ]),
    );
    expect(findingsOf(r)).toHaveLength(1);
  });
  it("campaign split not read: the page keeps its finding (never assumed paused)", () => {
    expect(findingsOf(runOne("SK20", fedBy(null)))).toHaveLength(1);
  });
});

describe("SK21 landing page tracking tags (information)", () => {
  it("states the split", () => {
    const r = runOne(
      "SK21",
      account({
        data: { landingPageViews: [page("https://example.com/a?utm_medium=product_sync")] },
      }),
    );
    expect(findingsOf(r)[0]?.facts.utm_class).toBe("product_sync");
  });
  it("splits one page's spend by the tag each of its links carries", () => {
    const r = runOne(
      "SK21",
      account({
        data: {
          landingPageViews: [
            { ...page("https://example.com/b?utm_source=x"), cost: 600 },
            { ...page("https://example.com/b"), cost: 400 },
          ],
        },
      }),
    );
    const byClass = Object.fromEntries(
      findingsOf(r).map((f) => [f.facts.utm_class, f.facts] as const),
    );
    expect(byClass.tagged?.spend).toBe(600);
    expect(byClass.tagged?.spend_share_pct).toBe(60);
    expect(byClass.gclid_only?.spend).toBe(400);
    expect(byClass.gclid_only?.spend_share_pct).toBe(40);
    expect(byClass.tagged?.pages).toBe(1);
    expect(byClass.gclid_only?.pages).toBe(1);
  });
  it("names each page with its scheme, so http and https pages are told apart", () => {
    const r = runOne(
      "SK21",
      account({
        data: {
          landingPageViews: [
            { ...page("https://Example.com/A"), cost: 600 },
            { ...page("http://example.com/A"), cost: 400 },
          ],
        },
      }),
    );
    const names = findingsOf(r)
      .flatMap((f) => f.evidence)
      .filter((e) => e.key === "L.utm_class_spend(class)")
      .map((e) => e.entity)
      .sort();
    expect(names).toEqual(["http://example.com/A", "https://example.com/A"]);
  });
  it("is not checkable when the read found no page", () => {
    expect(state(runOne("SK21", account({ syncedEmpty: ["landingPageViews"] })))).toBe(
      "not_checkable",
    );
  });
});

describe("SK22 a day-and-hour slot spends without a sale", () => {
  type Cell = [day: string, hour: number, clicks: number, cost: number, conv: number];
  // the rest of the week sets the grid's sale rate: 1,084 sales on 40,000 clicks (2.71%)
  const background: Cell = ["WEDNESDAY", 12, 40_000, 50_000, 1_084];
  const grid = (cells: Cell[]) =>
    withStatus(
      account({
        tables: {
          temporal_grid: [background, ...cells].map(([day, hour, clicks, cost, conv]) => ({
            campaign_id: "11",
            day_of_week: day,
            hour_of_day: hour,
            cost,
            clicks,
            impressions: clicks * 20,
            conversions: conv,
            conversion_value: conv * 100,
          })),
        },
      }),
      "temporal_grid",
      cells.length + 1,
    );
  // a slot whose clicks should have brought 8 sales, with a quiet hour before it
  const dead: Cell[] = [
    ["MONDAY", 2, 100, 80, 0],
    ["MONDAY", 3, 300, 400, 0],
  ];
  it("fires on a slot past the waste bar with no sale, enough clicks and quiet hours beside it", () => {
    const f = findingsOf(runOne("SK22", grid(dead)));
    expect(f).toHaveLength(1);
    expect(f[0]?.facts.expected_conversions).toBeGreaterThanOrEqual(3);
  });
  it("names the slot in plain words", () => {
    expect(findingsOf(runOne("SK22", grid(dead)))[0]?.scope.name).toBe("Monday 3-4 am");
    expect(slotName("SATURDAY:2")).toBe("Saturday 2-3 am");
    expect(slotName("FRIDAY:11")).toBe("Friday 11 am-12 pm");
    expect(slotName("SUNDAY:23")).toBe("Sunday 11 pm-12 am");
    expect(slotName("SUNDAY:0")).toBe("Sunday 12-1 am");
    expect(slotName("odd")).toBe("odd");
  });
  it("R7: Saturday 2-3 am (86 clicks, $147.73, no sale) is chance: 2.3 sales expected and 1 am and 3 am both sell", () => {
    const r = runOne(
      "SK22",
      grid([
        ["SATURDAY", 1, 75, 91.71, 2.98],
        ["SATURDAY", 2, 86, 147.73, 0],
        ["SATURDAY", 3, 62, 62.09, 1],
      ]),
    );
    expect(state(r)).toBe("none_found");
    expect(r.state === "none_found" ? r.note : "").toMatch(/Saturday 2-3 am/);
  });
  it("R7: enough clicks is not enough when an hour beside it sells at the grid's rate", () => {
    expect(
      state(
        runOne(
          "SK22",
          grid([
            ["MONDAY", 2, 100, 80, 3],
            ["MONDAY", 3, 300, 400, 0],
          ]),
        ),
      ),
    ).toBe("none_found");
  });
  it("R7: quiet hours beside it are not enough with too few clicks to tell from chance", () => {
    expect(
      state(
        runOne(
          "SK22",
          grid([
            ["MONDAY", 2, 50, 40, 0],
            ["MONDAY", 3, 90, 150, 0],
            ["MONDAY", 4, 50, 40, 0],
          ]),
        ),
      ),
    ).toBe("none_found");
  });
  it("the hours beside a slot run across midnight", () => {
    expect(neighbourSlots("SUNDAY:23")).toEqual(["SUNDAY:22", "MONDAY:0"]);
    expect(neighbourSlots("MONDAY:0")).toEqual(["SUNDAY:23", "MONDAY:1"]);
    expect(neighbourSlots("odd")).toEqual([]);
  });
  it("is clean when the slot converts", () => {
    expect(state(runOne("SK22", grid([["MONDAY", 3, 300, 400, 3]])))).toBe("none_found");
  });
  it("is not checkable when the grid was not read", () => {
    expect(state(runOne("SK22", account()))).toBe("not_checkable");
  });
});

describe("SK26 a disapproved extension on a spending campaign", () => {
  const withApproval = (status: string | null) =>
    account({ data: { adExtensions: [ext("SITELINK", 1, { approval_status: status })] } });
  it("fires on a disapproved asset", () => {
    expect(state(runOne("SK26", withApproval("DISAPPROVED")))).toBe("fires");
  });
  it("is clean when approved", () => {
    expect(state(runOne("SK26", withApproval("APPROVED")))).toBe("none_found");
  });
  it("is not checkable when the approval status was not read", () => {
    expect(state(runOne("SK26", withApproval(null)))).toBe("not_checkable");
  });
  it("fires on a disapproved account-level sitelink serving a campaign with none of its own", () => {
    const accountLink = ext("SITELINK", 9, {
      level: "ACCOUNT",
      campaign_id: null,
      approval_status: "DISAPPROVED",
    });
    const r = runOne(
      "SK26",
      account({
        data: { adExtensions: [ext("CALLOUT", 1, { approval_status: "APPROVED" }), accountLink] },
      }),
    );
    expect(findingsOf(r)[0]?.facts).toMatchObject({ level: "ACCOUNT", campaigns_served: 1 });
    // a campaign with its own sitelinks is not served by it
    const own = runOne(
      "SK26",
      account({
        data: {
          adExtensions: [ext("SITELINK", 1, { approval_status: "APPROVED" }), accountLink],
        },
      }),
    );
    expect(state(own)).toBe("none_found");
  });
});

describe("SK27 small searches that add up", () => {
  const tail = (n: number, cost: number) =>
    Array.from({ length: n }, (_, i) =>
      searchTerm({
        campaignId: "11",
        adGroupId: "21",
        term: `cheapest knockoff ${i}`,
        cost,
        clicks: 5,
      }),
    );
  const sold = searchTerm({
    campaignId: "11",
    adGroupId: "21",
    term: "trail boots",
    cost: 4000,
    conv: 40,
  });
  it("fires when a shared word in many zero-sale searches adds up", () => {
    const r = runOne("SK27", account({ data: { searchTerms: [sold, ...tail(10, 30)] } }));
    expect(findingsOf(r)[0]?.facts.leaking_words).toBeGreaterThan(0);
  });
  it("is clean when the tail is small", () => {
    expect(state(runOne("SK27", account({ data: { searchTerms: [sold, ...tail(3, 2)] } })))).toBe(
      "none_found",
    );
  });
  it("is not checkable when search terms were not read", () => {
    expect(state(runOne("SK27", account()))).toBe("not_checkable");
  });
});

describe("SK28 brand searches in a non-brand campaign", () => {
  const input = (brandCost: number, brandTerms: string[] = ["acme"]) =>
    buildInput({
      campaigns: [generic],
      profile: { businessType: "ecommerce", brandTerms },
      data: {
        adGroups: groups,
        searchTerms: [
          searchTerm({
            campaignId: "11",
            adGroupId: "21",
            term: "trail boots",
            cost: 1000,
            conv: 5,
          }),
          searchTerm({
            campaignId: "11",
            adGroupId: "21",
            term: "acme boots",
            cost: brandCost,
            conv: 3,
          }),
        ],
      },
    });
  it("fires past the share and money bars", () => {
    expect(findingsOf(runOne("SK28", input(200)))[0]?.scope.id).toBe("11");
  });
  it("is clean when brand searches are a sliver", () => {
    expect(state(runOne("SK28", input(10)))).toBe("none_found");
  });
  it("is not checkable without brand terms", () => {
    expect(state(runOne("SK28", input(200, [])))).toBe("not_checkable");
  });
  // brand blocking only in pairs: a branded product name given as a brand term counts too
  it("counts searches for a branded product name given as a brand term", () => {
    const productName = buildInput({
      campaigns: [generic],
      profile: { businessType: "ecommerce", brandTerms: ["Acme Outdoor", "Zuma Mug"] },
      data: {
        adGroups: groups,
        searchTerms: [
          searchTerm({
            campaignId: "11",
            adGroupId: "21",
            term: "trail boots",
            cost: 1000,
            conv: 5,
          }),
          searchTerm({
            campaignId: "11",
            adGroupId: "21",
            term: "zuma mug brown",
            cost: 200,
            conv: 3,
          }),
        ],
      },
    });
    const f = findingsOf(runOne("SK28", productName))[0];
    expect(f?.scope.id).toBe("11");
    expect(JSON.stringify(f)).toContain("zuma mug brown");
  });
});

describe("SK30 research searches sent to a product page", () => {
  const input = (url: string, researchConv = 0) =>
    account({
      data: {
        ads: [ad({ id: "41", url })],
        searchTerms: [
          searchTerm({
            campaignId: "11",
            adGroupId: "21",
            term: "best trail boots",
            cost: 400,
            clicks: 100,
            conv: researchConv,
          }),
          searchTerm({
            campaignId: "11",
            adGroupId: "21",
            term: "trail boots",
            cost: 100,
            clicks: 30,
            conv: 2,
          }),
        ],
      },
    });
  it("fires when research searches land on a product page and sell under the account rate", () => {
    expect(state(runOne("SK30", input("https://example.com/products/boot")))).toBe("fires");
  });
  it("is clean when they land on a guide page, or sell well", () => {
    expect(state(runOne("SK30", input("https://example.com/guides/boots")))).toBe("none_found");
    expect(state(runOne("SK30", input("https://example.com/products/boot", 10)))).toBe(
      "none_found",
    );
  });
  it("is not checkable when ads were not read", () => {
    expect(state(runOne("SK30", account({ data: { searchTerms: [] } })))).toBe("not_checkable");
  });
});

describe("SK32 partners or Display on a Search campaign", () => {
  const net = (display: boolean) =>
    account({}, [
      {
        ...generic,
        extra: {
          network_settings: {
            targetGoogleSearch: true,
            targetSearchNetwork: false,
            targetContentNetwork: display,
          },
        },
      },
    ]);
  it("fires with the Display Network on", () => {
    expect(findingsOf(runOne("SK32", net(true)))[0]?.facts.display_network_on).toBe(true);
  });
  it("is clean on Google Search only", () => {
    expect(state(runOne("SK32", net(false)))).toBe("none_found");
  });
  it("is not checkable when network settings were not read", () => {
    expect(state(runOne("SK32", account()))).toBe("not_checkable");
  });
  // M7 (K13): a brand Shopping campaign with search partners on is not flagged
  const shopPartners = (name: string) =>
    account({}, [
      {
        id: "12",
        name,
        type: "SHOPPING",
        extra: {
          network_settings: {
            targetGoogleSearch: true,
            targetSearchNetwork: true,
            targetContentNetwork: false,
          },
        },
      },
    ]);
  it("M7: a brand Shopping campaign with partners on is no finding", () => {
    expect(state(runOne("SK32", shopPartners("Shopping - Brand")))).toBe("none_found");
  });
  it("M7: a prospecting Shopping campaign with partners on still fires", () => {
    expect(
      findingsOf(runOne("SK32", shopPartners("Shopping all shoes")))[0]?.facts.search_partners_on,
    ).toBe(true);
  });
  // R9: a Brand Search campaign (1,575 clicks, $2,157) has partners on and every click on Google Search
  const brand: CampaignSpec = { id: "11", name: "Brand Search" };
  const partners = (split: Row[] | null, display = false) => {
    const input = account({ ...(split ? { tables: { campaign_network_split: split } } : {}) }, [
      {
        ...brand,
        extra: {
          network_settings: {
            targetGoogleSearch: true,
            targetSearchNetwork: true,
            ...(display ? { targetContentNetwork: true } : {}),
          },
        },
      },
    ]);
    return split ? withStatus(input, "campaign_network_split", split.length) : input;
  };
  const row = (net: string, cost: number, clicks: number, conv = 0) => ({
    campaign_id: "11",
    ad_network_type: net,
    cost,
    clicks,
    impressions: clicks * 10,
    conversions: conv,
    conversion_value: conv * 140,
  });
  it("R9: partners on with $0 spent there is no finding, and the note names it", () => {
    const r = runOne("SK32", partners([row("SEARCH", 2157.22, 1575, 149.6)]));
    expect(state(r)).toBe("none_found");
    expect(r.state === "none_found" ? r.note : "").toMatch(/Brand Search: .*no spend there/);
  });
  it("R9: partner spend is read and shown, with no 'not in our data' limit", () => {
    const f = findingsOf(
      runOne("SK32", partners([row("SEARCH", 2000, 1500, 140), row("SEARCH_PARTNERS", 57.5, 75)])),
    )[0];
    expect(f?.facts.search_partners_spend).toBe(57.5);
    expect(f?.facts.search_partners_clicks).toBe(75);
    expect(f?.facts.google_search_spend).toBe(2000);
    expect(f?.limitedBy ?? []).toEqual([]);
  });
  it("R9: Display on with $0 spent there is no warning, the same rule as partners", () => {
    const idle = runOne("SK32", partners([row("SEARCH", 2157.22, 1575, 149.6)], true));
    expect(state(idle)).toBe("none_found");
    expect(idle.state === "none_found" ? idle.note : "").toMatch(
      /Brand Search: Google search partners and Display Network on, but no spend there/,
    );
    const f = findingsOf(
      runOne(
        "SK32",
        partners([row("SEARCH", 2000, 1500, 140), row("SEARCH_PARTNERS", 57.5, 75)], true),
      ),
    )[0];
    expect(f?.maxSeverity).toBe("opportunity");
    expect(f?.note).toMatch(/no spend on Display Network in the window/);
  });
  it("R9: an older snapshot without the split keeps the limit", () => {
    const f = findingsOf(runOne("SK32", partners(null)))[0];
    expect(f?.limitedBy?.[0]).toMatch(/not in our data/);
  });
});

describe("SK33 a negative blocks the account's own keyword", () => {
  const kws = [keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "trail boots" })];
  it("fires when a campaign negative blocks a keyword", () => {
    const input = negativesRead(account({ data: { keywords: kws } }), [
      { campaign_id: "11", keyword_text: "boots", match_type: "BROAD" },
    ]);
    expect(findingsOf(runOne("SK33", input))[0]?.facts.keywords_blocked).toBe(1);
  });
  it("is clean when nothing blocks it", () => {
    const input = negativesRead(account({ data: { keywords: kws } }), [
      { campaign_id: "11", keyword_text: "free", match_type: "BROAD" },
    ]);
    expect(state(runOne("SK33", input))).toBe("none_found");
  });
  it("is not checkable when keywords were not read", () => {
    expect(state(runOne("SK33", account()))).toBe("not_checkable");
  });
});

describe("SK35 kinds of searches bought (information)", () => {
  it("states the split and the kinds missing", () => {
    const r = runOne(
      "SK35",
      buildInput({
        campaigns: [generic],
        profile: { businessType: "ecommerce", brandTerms: ["acme"] },
        data: {
          adGroups: groups,
          searchTerms: [
            searchTerm({ campaignId: "11", adGroupId: "21", term: "acme boots", cost: 100 }),
            searchTerm({ campaignId: "11", adGroupId: "21", term: "best trail boots", cost: 50 }),
            searchTerm({ campaignId: "11", adGroupId: "21", term: "trail boots", cost: 200 }),
          ],
        },
      }),
    );
    const f = findingsOf(r)[0];
    expect(f?.facts.brand_spend_90d).toBe(100);
    expect(f?.facts.missing_types).toMatch(/Competitor/);
  });
  it("R10: counts the Brand campaign's own spend whole as brand, and Search money is the campaigns' spend", () => {
    // Brand Search spent $2,157 (search terms show little of it, no brand terms given);
    // Ranking Article $604, of which its search terms show $313
    const r = runOne(
      "SK35",
      buildInput({
        campaigns: [
          {
            id: "11",
            name: "Brand Search",
            cost: 2157.22 / 90,
            conv: 149.59 / 90,
            value: 21259.05 / 90,
          },
          {
            id: "12",
            name: "Generic Search - Article",
            cost: 604.48 / 90,
            conv: 4 / 90,
            value: 509 / 90,
          },
        ],
        data: {
          adGroups: [
            adGroup({ id: "21", campaignId: "11" }),
            adGroup({ id: "22", campaignId: "12" }),
          ],
          searchTerms: [
            searchTerm({ campaignId: "11", adGroupId: "21", term: "acme mugs", cost: 40 }),
            searchTerm({
              campaignId: "12",
              adGroupId: "22",
              term: "womens leather mug",
              cost: 287.77,
            }),
            searchTerm({
              campaignId: "12",
              adGroupId: "22",
              term: "best leather mugs",
              cost: 25.14,
            }),
          ],
        },
      }),
    );
    const f = findingsOf(r)[0];
    expect(f?.facts.brand_spend_90d as number).toBeCloseTo(2157.22, 0);
    expect(f?.facts.search_spend_90d as number).toBeCloseTo(2761.7, 0);
    expect(f?.facts.unseen_spend_90d as number).toBeCloseTo(291.57, 0);
    expect(f?.facts.brand_detected).toBe(true);
    const brandRow = f?.rows?.find((x) => x.label === "brand");
    expect(brandRow?.cells.share_of_spend_pct as number).toBeCloseTo(78.1, 0);
  });
  it("is not checkable when search terms were not read", () => {
    expect(state(runOne("SK35", account()))).toBe("not_checkable");
  });
});

describe("explainCheck on the new checks", () => {
  it("shows the overridable bars with their defaults", () => {
    expect(explainCheck("SK12")?.settings).toEqual({ "search.rsaMinHeadlines": 11 });
    expect(explainCheck("AS13")?.settings).toEqual({
      "structure.editorsMinChanges": 50,
      "structure.topEditorShare": 0.8,
    });
    expect(explainCheck("MI06")?.title).toMatch(/views, not clicks/);
  });
});
