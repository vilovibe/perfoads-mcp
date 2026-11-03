// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { runChecks } from "./api.js";
import type { CheckResult } from "./engine/checks/types.js";
import {
  adGroup,
  buildInput,
  checkCtxOf,
  keyword,
  runOne,
  searchTerm,
  type FixtureOptions,
} from "./testing/account.js";
import type { Row } from "./engine/shared/input.js";

const state = (r: CheckResult) => r.state;
const findingsOf = (r: CheckResult) => (r.state === "fires" ? r.findings : []);

/**
 * One Search campaign: 100/day over 90 days (9,000), 2 conversions/day (180),
 * 50 clicks/day (4,500). Account CPA 50 and a 3,000 monthly spend, so the
 * waste floor is 50; the 4% conversion rate puts the zero-conversion click
 * threshold at 74 clicks.
 */
function account(
  rows: { keywords?: Row[]; searchTerms?: Row[]; adGroups?: Row[] },
  opts: Omit<FixtureOptions, "campaigns"> = {},
) {
  return buildInput({
    campaigns: [{ id: "11", name: "Generic search" }],
    ...opts,
    data: {
      adGroups: rows.adGroups ?? [
        adGroup({ id: "21", campaignId: "11" }),
        adGroup({ id: "22", campaignId: "11" }),
      ],
      ...(rows.keywords ? { keywords: rows.keywords } : {}),
      ...(rows.searchTerms ? { searchTerms: rows.searchTerms } : {}),
      ...(opts.data ?? {}),
    },
  });
}

describe("SK01 keyword spend with no conversion", () => {
  it("fires past both the money and the click bar", () => {
    const r = runOne(
      "SK01",
      account({
        keywords: [
          keyword({
            id: "31",
            campaignId: "11",
            adGroupId: "21",
            text: "running shoes",
            cost: 200,
            clicks: 100,
            conv: 0,
          }),
        ],
      }),
    );
    expect(state(r)).toBe("fires");
    expect(findingsOf(r)[0]?.scope).toMatchObject({
      type: "keyword",
      id: "21~31",
      adGroupId: "21",
      campaignId: "11",
    });
  });
  it("is clean when the keyword converts or stays under a bar", () => {
    const r = runOne(
      "SK01",
      account({
        keywords: [
          keyword({
            id: "31",
            campaignId: "11",
            adGroupId: "21",
            text: "running shoes",
            cost: 200,
            clicks: 100,
            conv: 2,
          }),
          keyword({
            id: "32",
            campaignId: "11",
            adGroupId: "21",
            text: "trail shoes",
            cost: 200,
            clicks: 40,
            conv: 0,
          }),
        ],
      }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when keywords were not read", () => {
    expect(state(runOne("SK01", account({})))).toBe("not_checkable");
  });
  it("never reports a paused keyword", () => {
    const r = runOne(
      "SK01",
      account({
        keywords: [
          keyword({
            id: "31",
            campaignId: "11",
            adGroupId: "21",
            text: "running shoes",
            cost: 200,
            clicks: 100,
            conv: 0,
            status: "PAUSED",
          }),
        ],
      }),
    );
    expect(findingsOf(r)).toHaveLength(0);
  });
});

describe("SK02 low quality score on meaningful spend", () => {
  it("fires at quality score 4 or below over the spend gate", () => {
    const r = runOne(
      "SK02",
      account({
        keywords: [
          keyword({
            id: "31",
            campaignId: "11",
            adGroupId: "21",
            text: "running shoes",
            cost: 200,
            qs: 3,
          }),
        ],
      }),
    );
    expect(state(r)).toBe("fires");
    expect(findingsOf(r)[0]?.facts.below_average_components).toBe("ad_relevance");
  });
  it("is clean with a good quality score", () => {
    expect(
      state(
        runOne(
          "SK02",
          account({
            keywords: [
              keyword({
                id: "31",
                campaignId: "11",
                adGroupId: "21",
                text: "running shoes",
                cost: 200,
                qs: 8,
              }),
            ],
          }),
        ),
      ),
    ).toBe("none_found");
  });
  it("is not checkable when no keyword reports a quality score", () => {
    expect(
      state(
        runOne(
          "SK02",
          account({
            keywords: [
              keyword({
                id: "31",
                campaignId: "11",
                adGroupId: "21",
                text: "running shoes",
                qs: null,
              }),
            ],
          }),
        ),
      ),
    ).toBe("not_checkable");
  });
});

describe("SK03 one match type holds the campaign's keyword spend", () => {
  it("fires above the concentration share", () => {
    const r = runOne(
      "SK03",
      account({
        keywords: [
          keyword({
            id: "31",
            campaignId: "11",
            adGroupId: "21",
            text: "running shoes",
            match: "BROAD",
            cost: 900,
          }),
          keyword({
            id: "32",
            campaignId: "11",
            adGroupId: "21",
            text: "trail shoes",
            match: "EXACT",
            cost: 100,
          }),
        ],
      }),
    );
    expect(state(r)).toBe("fires");
    expect(findingsOf(r)[0]?.facts.match_type).toBe("BROAD");
  });
  it("is clean with mixed match types", () => {
    const r = runOne(
      "SK03",
      account({
        keywords: [
          keyword({
            id: "31",
            campaignId: "11",
            adGroupId: "21",
            text: "running shoes",
            match: "BROAD",
            cost: 500,
          }),
          keyword({
            id: "32",
            campaignId: "11",
            adGroupId: "21",
            text: "trail shoes",
            match: "EXACT",
            cost: 500,
          }),
        ],
      }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when the read found no keyword", () => {
    expect(state(runOne("SK03", account({}, { syncedEmpty: ["keywords"] })))).toBe("not_checkable");
  });
});

describe("SK03 edges: strictly above the share", () => {
  const split = (broad: number, exact: number) =>
    runOne(
      "SK03",
      account({
        keywords: [
          keyword({
            id: "31",
            campaignId: "11",
            adGroupId: "21",
            text: "running shoes",
            match: "BROAD",
            cost: broad,
          }),
          keyword({
            id: "32",
            campaignId: "11",
            adGroupId: "21",
            text: "trail shoes",
            match: "EXACT",
            cost: exact,
          }),
        ],
      }),
    ).state;
  it("exactly at 80% does not fire", () => {
    expect(split(800, 200)).toBe("none_found");
  });
  it("just above 80% fires", () => {
    expect(split(810, 190)).toBe("fires");
  });
  it("60% does not fire", () => {
    expect(split(600, 400)).toBe("none_found");
  });
});

describe("SK04 the same keyword in two ad groups", () => {
  it("fires for each copy", () => {
    const r = runOne(
      "SK04",
      account({
        keywords: [
          keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "running shoes" }),
          keyword({ id: "32", campaignId: "11", adGroupId: "22", text: "running shoes" }),
        ],
      }),
    );
    expect(state(r)).toBe("fires");
    expect(findingsOf(r)).toHaveLength(2);
  });
  it("is clean with distinct keywords", () => {
    const r = runOne(
      "SK04",
      account({
        keywords: [
          keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "running shoes" }),
          keyword({ id: "32", campaignId: "11", adGroupId: "22", text: "trail shoes" }),
        ],
      }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when keywords were not read", () => {
    expect(state(runOne("SK04", account({})))).toBe("not_checkable");
  });

  // B11: an NL-only and a DE-only campaign with the same keyword is a country split
  describe("two campaigns (B11 country + language rule)", () => {
    const nl = { id: "11", name: "NL search" };
    const de = { id: "12", name: "DE search" };
    const location = (campaignId: string, geo: string) => ({
      campaign_id: campaignId,
      criterion_id: geo,
      bid_modifier: null,
      modifier_source: "LOCATION",
      criterion_key: `geoTargetConstants/${geo}`,
      status: "ENABLED",
    });
    const language = (campaignId: string, code: string) => ({
      campaign_id: campaignId,
      criterion_id: `l${campaignId}`,
      language_code: code,
      status: "ENABLED",
    });
    const excludedCountry = (campaignId: string, geo: string) => ({
      campaign_id: campaignId,
      criterion_id: geo,
      location_id: geo,
      is_negative: true,
      bid_modifier: null,
      status: "ENABLED",
    });
    const twoCampaigns = (o: {
      locations?: Row[] | null;
      languages?: Row[] | null;
      excluded?: Row[];
    }) => {
      const input = buildInput({
        campaigns: [nl, de],
        data: {
          adGroups: [
            adGroup({ id: "21", campaignId: "11" }),
            adGroup({ id: "22", campaignId: "12" }),
          ],
          // Google reuses criterion id 31 for the same keyword in both ad groups
          keywords: [
            keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "leather belt" }),
            keyword({ id: "31", campaignId: "12", adGroupId: "22", text: "leather belt" }),
          ],
          ...(o.locations ? { bidModifiers: o.locations } : {}),
          ...(o.excluded ? { locationCriteria: o.excluded } : {}),
        },
        ...(o.locations
          ? {
              syncedEmpty: [
                "bidModifiers" as const,
                ...(o.excluded ? ["locationCriteria" as const] : []),
              ],
            }
          : {}),
        tables: o.languages ? { campaign_languages: o.languages } : {},
      });
      return o.languages
        ? {
            ...input,
            statusRows: [
              ...(input.statusRows ?? []),
              {
                table_name: "campaign_languages",
                status: "ok",
                row_count: o.languages.length,
                error_message: null,
              },
            ],
          }
        : input;
    };
    it("is quiet when the campaigns target different countries", () => {
      const r = runOne(
        "SK04",
        twoCampaigns({
          locations: [location("11", "2528"), location("12", "2276")],
          languages: [language("11", "nl"), language("12", "de")],
        }),
      );
      expect(state(r)).toBe("none_found");
    });
    it("is quiet when the countries meet but the languages do not", () => {
      const r = runOne(
        "SK04",
        twoCampaigns({
          locations: [location("11", "2528"), location("12", "2528")],
          languages: [language("11", "nl"), language("12", "en")],
        }),
      );
      expect(state(r)).toBe("none_found");
    });
    it("fires when they share a country and a language", () => {
      const r = runOne(
        "SK04",
        twoCampaigns({
          locations: [location("11", "2528"), location("12", "2528"), location("12", "2276")],
          languages: [language("11", "en"), language("12", "en")],
        }),
      );
      expect(findingsOf(r).map((f) => f.scope.id)).toEqual(["21~31", "22~31"]);
      expect(findingsOf(r)[0]?.note).toBeUndefined();
    });
    it("no language criterion = every language; a city target overlaps any country", () => {
      const r = runOne(
        "SK04",
        twoCampaigns({
          locations: [location("11", "1010543"), location("12", "2276")],
          languages: [language("12", "de")],
        }),
      );
      expect(state(r)).toBe("fires");
    });
    // an EN campaign on every country except NL never meets an NL-only campaign
    it("is quiet when the other campaign excludes the only country this one targets", () => {
      const r = runOne(
        "SK04",
        twoCampaigns({
          locations: [location("11", "2528")],
          excluded: [excludedCountry("12", "2528")],
          languages: [language("11", "en"), language("12", "en")],
        }),
      );
      expect(state(r)).toBe("none_found");
    });
    it("fires when the target country is not among the other campaign's exclusions", () => {
      const r = runOne(
        "SK04",
        twoCampaigns({
          locations: [location("11", "2276")],
          excluded: [excludedCountry("12", "2528")],
          languages: [language("11", "en"), language("12", "en")],
        }),
      );
      expect(state(r)).toBe("fires");
    });
    it("keeps the finding, with a note, when the targets were not read", () => {
      const r = runOne("SK04", twoCampaigns({}));
      expect(state(r)).toBe("fires");
      expect(findingsOf(r)[0]?.note).toMatch(/target locations and target languages not read/);
    });
  });
});

// B10 / B11: Google reuses one criterion id across ad groups (the same text in an NL and a
// DE ad group); a keyword is ad group + criterion id, so each copy keeps its own numbers
describe("keyword identity is ad group + criterion id", () => {
  const twoCopies = (deStatus = "ENABLED") =>
    buildInput({
      campaigns: [
        { id: "11", name: "NL search" },
        { id: "12", name: "DE search" },
      ],
      data: {
        adGroups: [
          adGroup({ id: "21", campaignId: "11" }),
          adGroup({ id: "22", campaignId: "12" }),
        ],
        keywords: [
          keyword({
            id: "31",
            campaignId: "11",
            adGroupId: "21",
            text: "riem",
            cost: 200,
            clicks: 100,
            conv: 0,
            match: "BROAD",
          }),
          keyword({
            id: "31",
            campaignId: "12",
            adGroupId: "22",
            text: "riem",
            cost: 50,
            status: deStatus,
            match: "BROAD",
          }),
        ],
        searchTerms: [
          {
            ...searchTerm({ campaignId: "12", adGroupId: "22", term: "riem kopen" }),
            keyword_criterion_id: "31",
            keyword_ad_group_id: "22",
          },
        ],
      },
    });
  const keywordsOf = (input: ReturnType<typeof twoCopies>) =>
    checkCtxOf(input).model.children.campaigns.flatMap((c) =>
      c.children.adGroups.flatMap((g) => g.children.keywords),
    );
  it("builds two keywords, each with its own spend, criterion id and duplicate", () => {
    const kws = keywordsOf(twoCopies());
    expect(kws.map((k) => [k.id, k.attrs.criterionId, k.windows.m90.cost])).toEqual([
      ["21~31", "31", 200],
      ["22~31", "31", 50],
    ]);
    expect(kws.map((k) => k.attrs.cannibalisedBy)).toEqual([["22~31"], ["21~31"]]);
  });
  it("links a search term to the keyword in its own ad group only", () => {
    const kws = keywordsOf(twoCopies());
    expect(kws.map((k) => k.children.triggeredTerms.length)).toEqual([0, 1]);
    const ctx = checkCtxOf(twoCopies());
    const termId = kws[1]?.children.triggeredTerms[0] ?? "";
    expect(ctx.get("T.matched_keyword", { searchTermId: termId })).toMatchObject({
      value: "22~31",
    });
  });
  it("SK03 cites each campaign's own keyword spend", () => {
    const r = runOne("SK03", twoCopies());
    const nl = findingsOf(r).find((f) => f.scope.id === "11");
    expect(nl?.facts.campaign_keyword_spend).toBe(200);
    expect(nl?.evidence.map((e) => [e.entityId, e.value])).toEqual([["21~31", 200]]);
  });
  it("a paused DE copy never gates the live NL keyword's finding", () => {
    const out = runChecks(twoCopies("PAUSED"));
    const sk01 = out.findings.filter((f) => f.checkId === "SK01");
    expect(sk01.map((f) => f.scope.id)).toEqual(["21~31"]);
  });
});

describe("SK05 search term spend with no conversion", () => {
  it("fires past both bars", () => {
    const r = runOne(
      "SK05",
      account({
        searchTerms: [
          searchTerm({
            campaignId: "11",
            adGroupId: "21",
            term: "free shoes",
            cost: 200,
            clicks: 100,
          }),
        ],
      }),
    );
    expect(state(r)).toBe("fires");
  });
  it("is clean when the term converts", () => {
    expect(
      state(
        runOne(
          "SK05",
          account({
            searchTerms: [
              searchTerm({
                campaignId: "11",
                adGroupId: "21",
                term: "running shoes",
                cost: 200,
                clicks: 100,
                conv: 3,
              }),
            ],
          }),
        ),
      ),
    ).toBe("none_found");
  });
  it("is not checkable when search terms were not read", () => {
    expect(state(runOne("SK05", account({})))).toBe("not_checkable");
  });
  it("never names a search for the account's own brand", () => {
    const r = runOne(
      "SK05",
      account(
        {
          searchTerms: [
            searchTerm({
              campaignId: "11",
              adGroupId: "21",
              term: "acme outdoor shoes",
              cost: 200,
              clicks: 100,
            }),
          ],
        },
        { profile: { businessType: "ecommerce", brandTerms: ["Acme Outdoor"] } },
      ),
    );
    expect(findingsOf(r)).toHaveLength(0);
  });
});
