// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// create_campaign through the real engine on a fake account: every input check, money
// exactness (EUR, JPY, IDR), the one atomic Mutate with temporary ids in order, policy
// defaults (PAUSED, BROAD rule, ops count), negatives safety, the approval content,
// read-back, all-or-nothing, the enable link and undo (unused -> removed, run -> refused).

import { makeClient } from "@perfoads/ads-client/testing";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.js";
import type { EngineOptions } from "./engine.js";
import { ChangeError } from "./errors.js";
import { listEvents } from "./log.js";
import { getRow, rowDiffHash } from "./repo.js";
import {
  createHooks,
  createWorld,
  fakeWorld,
  moreWorld,
  must,
  permissiveTestPolicy,
  type CreateWorld,
  type FakeWorld,
} from "./testing/index.js";
import { AGENT, makeRig, type Rig } from "./testing/setup.js";
import { localDateTime } from "./time.js";
import { createCampaign } from "./types/createCampaign.js";
import type { PolicyDefaults } from "./types/actionType.js";

let rig: Rig | undefined;
afterEach(() => {
  rig?.close();
  rig = undefined;
});

const PAT = { actor: "Pat", via: "cli" } as const;
const C = "1234567890";

const setup = (
  o: {
    currency?: string;
    defaults?: Partial<PolicyDefaults>;
    world?: (w: FakeWorld) => void;
    engine?: Partial<EngineOptions>;
  } = {},
): { r: Rig; w: FakeWorld; cw: CreateWorld } => {
  const w: FakeWorld = { ...fakeWorld({ name: "Northwind" }), more: moreWorld() };
  if (o.currency) w.customer.currencyCode = o.currency;
  o.world?.(w);
  const cw = createWorld();
  const r = makeRig({
    world: w,
    hooks: createHooks(w, cw),
    clockSleeps: true,
    ...(o.defaults ? { policy: permissiveTestPolicy({ defaults: o.defaults }) } : {}),
    ...(o.engine ? { engine: o.engine } : {}),
  });
  rig = r;
  cw.now = () => r.clock.now;
  return { r, w, cw };
};

/** Every required field, nothing optional. */
const minimal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "Spring search",
  campaign_type: "SEARCH",
  daily_budget: "20",
  bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
  networks: { google_search: true, search_partners: false, display: false },
  locations: { geo_target_ids: ["2840"], targeting: "PRESENCE" },
  language_ids: ["1000"],
  contains_eu_political_advertising: false,
  ...over,
});

const ad = (over: Record<string, unknown> = {}) => ({
  final_url: "https://shop.example/shoes",
  headlines: [{ text: "Red shoes", pin: 1 }, { text: "Fast delivery" }, { text: "Free returns" }],
  descriptions: [{ text: "Shop red shoes today." }, { text: "Many sizes in stock." }],
  path1: "shoes",
  path2: "red",
  ...over,
});

const full = (over: Record<string, unknown> = {}) =>
  minimal({
    bidding: { strategy: "MANUAL_CPC" },
    start_date: "2026-11-01",
    end_date: "2026-12-31",
    ad_groups: [
      {
        name: "Red shoes",
        max_cpc: "0.45",
        keywords: [
          { text: "red shoes", match_type: "EXACT" },
          { text: "buy red shoes", match_type: "PHRASE" },
        ],
        ad: ad(),
      },
      {
        name: "Blue shoes",
        max_cpc: "0.30",
        keywords: [{ text: "blue shoes", match_type: "EXACT" }],
      },
    ],
    negatives: [{ text: "free", match_type: "PHRASE" }],
    ...over,
  });

const req = (input: Record<string, unknown>) => ({
  customerId: C,
  type: "create_campaign",
  input,
  ...AGENT,
});

const errOf = async (p: Promise<unknown>): Promise<ChangeError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChangeError) return e;
    throw e;
  }
  throw new Error("expected a ChangeError");
};

type Body = { mutateOperations?: Record<string, unknown>[]; validateOnly?: boolean };
const writesSent = (r: Rig): Body[] =>
  r.calls
    .filter((c) => c.url.endsWith(":mutate") && (c.body as Body).validateOnly !== true)
    .map((c) => c.body as Body);
const lastValidate = (r: Rig): Body | undefined =>
  r.calls.filter((c) => c.url.endsWith(":mutate") && (c.body as Body).validateOnly === true).at(-1)
    ?.body as Body | undefined;

const approveApply = async (r: Rig, id: string) => {
  const v = must(r.engine.get(id));
  r.engine.markApproved(id, v.version, "cli", "Pat");
  return r.engine.apply(id, PAT);
};
const proposeApply = async (r: Rig, input: Record<string, unknown>) =>
  approveApply(r, (await r.engine.propose(req(input))).id);

const newCampaign = (w: FakeWorld, name = "Spring search") =>
  must(Object.values(w.campaigns).find((c) => c.name === name));

/** Undo waits 15 minutes after the create (Google's change history lags). */
const settle = (r: Rig) => {
  r.clock.now += 16 * 60_000;
};

describe("create_campaign input", () => {
  it("every required field is required; nothing that chooses for the person has a default", async () => {
    const { r } = setup();
    for (const field of [
      "name",
      "campaign_type",
      "bidding",
      "networks",
      "locations",
      "language_ids",
      "contains_eu_political_advertising",
    ]) {
      const input = Object.fromEntries(Object.entries(minimal()).filter(([k]) => k !== field));
      const e = await errOf(r.engine.propose(req(input)));
      expect(e.code, field).toBe("invalid_input");
    }
    for (const net of ["google_search", "search_partners", "display"]) {
      const networks = Object.fromEntries(
        Object.entries({ google_search: true, search_partners: false, display: false }).filter(
          ([k]) => k !== net,
        ),
      );
      expect((await errOf(r.engine.propose(req(minimal({ networks }))))).code, net).toBe(
        "invalid_input",
      );
    }
    const bad: [string, Record<string, unknown>][] = [
      ["no budget", minimal({ daily_budget: undefined })],
      ["both budgets", minimal({ shared_budget_id: "222" })],
      ["no locations", minimal({ locations: { geo_target_ids: [], targeting: "PRESENCE" } })],
      ["no targeting option", minimal({ locations: { geo_target_ids: ["2840"] } })],
      ["no languages", minimal({ language_ids: [] })],
      ["bad geo id", minimal({ locations: { geo_target_ids: ["US"], targeting: "PRESENCE" } })],
      ["bad language id", minimal({ language_ids: ["en"] })],
      ["bad budget id", minimal({ daily_budget: undefined, shared_budget_id: "22a" })],
      ["twice", minimal({ language_ids: ["1000", "1000"] })],
      ["not Search", minimal({ campaign_type: "PERFORMANCE_MAX" })],
      ["bad strategy", minimal({ bidding: { strategy: "TARGET_IMPRESSION_SHARE" } })],
      ["cpa on clicks", minimal({ bidding: { strategy: "MAXIMIZE_CLICKS", target_cpa: "5" } })],
      [
        "roas decimals",
        minimal({
          bidding: { strategy: "MAXIMIZE_CONVERSION_VALUE", target_roas_percent: 250.555 },
        }),
      ],
      ["bad date", minimal({ start_date: "2026-02-30" })],
      ["end before start", minimal({ start_date: "2026-11-02", end_date: "2026-11-01" })],
      ["status given", minimal({ status: "ENABLED" })],
      ["control char name", minimal({ name: "Spring\nsearch" })],
      [
        "manual without max_cpc",
        minimal({ bidding: { strategy: "MANUAL_CPC" }, ad_groups: [{ name: "A" }] }),
      ],
      ["max_cpc with smart bidding", minimal({ ad_groups: [{ name: "A", max_cpc: "1" }] })],
      ["ad group twice", minimal({ ad_groups: [{ name: "A" }, { name: "a" }] })],
      [
        "keyword twice",
        minimal({
          ad_groups: [
            {
              name: "A",
              keywords: [
                { text: "red shoes", match_type: "EXACT" },
                { text: "Red  shoes", match_type: "EXACT" },
              ],
            },
          ],
        }),
      ],
      ["two ads", minimal({ ad_groups: [{ name: "A", ad: [ad(), ad()] }] })],
      [
        "2 headlines",
        minimal({
          ad_groups: [{ name: "A", ad: ad({ headlines: [{ text: "a" }, { text: "b" }] }) }],
        }),
      ],
      [
        "headline 31",
        minimal({
          ad_groups: [
            {
              name: "A",
              ad: ad({ headlines: [{ text: "x".repeat(31) }, { text: "b" }, { text: "c" }] }),
            },
          ],
        }),
      ],
      [
        "5 descriptions",
        minimal({
          ad_groups: [
            {
              name: "A",
              ad: ad({ descriptions: ["a", "b", "c", "d", "e"].map((text) => ({ text })) }),
            },
          ],
        }),
      ],
      [
        "description 91",
        minimal({
          ad_groups: [
            { name: "A", ad: ad({ descriptions: [{ text: "x".repeat(91) }, { text: "b" }] }) },
          ],
        }),
      ],
      [
        "http url",
        minimal({ ad_groups: [{ name: "A", ad: ad({ final_url: "http://shop.example" }) }] }),
      ],
      ["path 16", minimal({ ad_groups: [{ name: "A", ad: ad({ path1: "x".repeat(16) }) }] })],
      ["path2 alone", minimal({ ad_groups: [{ name: "A", ad: ad({ path1: undefined }) }] })],
      [
        "pin 4",
        minimal({
          ad_groups: [
            {
              name: "A",
              ad: ad({ headlines: [{ text: "a", pin: 4 }, { text: "b" }, { text: "c" }] }),
            },
          ],
        }),
      ],
      [
        "pins leave position 2 empty",
        minimal({
          ad_groups: [
            {
              name: "A",
              ad: ad({
                headlines: [
                  { text: "a", pin: 1 },
                  { text: "b", pin: 1 },
                  { text: "c", pin: 3 },
                ],
              }),
            },
          ],
        }),
      ],
      [
        "same headline twice",
        minimal({
          ad_groups: [
            { name: "A", ad: ad({ headlines: [{ text: "a" }, { text: "A" }, { text: "c" }] }) },
          ],
        }),
      ],
    ];
    for (const [what, input] of bad) {
      const e = await errOf(r.engine.propose(req(input)));
      expect(e.code, what).toBe("invalid_input");
    }
    expect(r.fake.validations()).toBe(0);
  });

  it("refuses a taken name, a location Google doesn't have and a language that can't be targeted", async () => {
    const { r } = setup();
    const taken = await errOf(r.engine.propose(req(minimal({ name: "Search shoes" }))));
    expect(taken.code).toBe("not_allowed");
    expect(taken.message).toContain("already exists");
    const geo = await errOf(
      r.engine.propose(
        req(minimal({ locations: { geo_target_ids: ["99"], targeting: "PRESENCE" } })),
      ),
    );
    expect(geo.message).toContain("Not a Google location (geo target constant): 99");
    const lang = await errOf(r.engine.propose(req(minimal({ language_ids: ["1019"] }))));
    expect(lang.message).toContain("Not a targetable Google language");
    expect(r.fake.validations()).toBe(0);
  });

  it("money is exact in the account's currency (EUR cents, JPY and IDR whole units), never rounded", async () => {
    const eur = setup();
    expect((await errOf(eur.r.engine.propose(req(minimal({ daily_budget: "20.005" }))))).code).toBe(
      "invalid_input",
    );
    expect(
      (
        await errOf(
          eur.r.engine.propose(
            req(minimal({ bidding: { strategy: "MAXIMIZE_CONVERSIONS", target_cpa: "0" } })),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    await eur.r.engine.propose(req(minimal({ daily_budget: "20.01" })));
    expect(lastValidate(eur.r)?.mutateOperations?.[0]).toEqual({
      campaignBudgetOperation: {
        create: {
          resourceName: `customers/${C}/campaignBudgets/-1`,
          amountMicros: "20010000",
          period: "DAILY",
          explicitlyShared: false,
        },
      },
    });
    eur.r.close();
    rig = undefined;

    const jpy = setup({ currency: "JPY" });
    const half = await errOf(jpy.r.engine.propose(req(minimal({ daily_budget: "1500.5" }))));
    expect(half.message).toContain("can't be used in JPY");
    await jpy.r.engine.propose(
      req(
        minimal({
          daily_budget: "15000",
          bidding: { strategy: "MAXIMIZE_CLICKS", max_cpc_limit: "120" },
        }),
      ),
    );
    const ops = lastValidate(jpy.r)?.mutateOperations ?? [];
    expect(
      (ops[0]?.campaignBudgetOperation as { create: { amountMicros: string } }).create.amountMicros,
    ).toBe("15000000000");
    expect(
      (ops[1]?.campaignOperation as { create: { targetSpend: unknown } }).create.targetSpend,
    ).toEqual({ cpcBidCeilingMicros: "120000000" });
    jpy.r.close();
    rig = undefined;

    const idr = setup({ currency: "IDR" });
    expect(
      (await errOf(idr.r.engine.propose(req(minimal({ daily_budget: "75000.5" }))))).code,
    ).toBe("invalid_input");
    const v = await idr.r.engine.propose(req(minimal({ daily_budget: "750000000" })));
    expect(
      (
        lastValidate(idr.r)?.mutateOperations?.[0]?.campaignBudgetOperation as {
          create: { amountMicros: string };
        }
      ).create.amountMicros,
    ).toBe("750000000000000");
    expect(v.facts.spendWhenEnabled).toEqual({
      dailyBudgetMicros: "750000000000000",
      budgetShared: false,
    });
  });
});

describe("final URLs (every type that takes one)", () => {
  it("are sent as the URL parser writes them; a non-ASCII site name (lookalike) is refused", async () => {
    const { r } = setup();
    const withUrl = (final_url: string) =>
      minimal({ name: `U ${final_url.length}`, ad_groups: [{ name: "A", ad: ad({ final_url }) }] });
    // Cyrillic "а" in place of Latin "a": looks like shop.example.
    const cyr = await errOf(r.engine.propose(req(withUrl("https://shop.ex\u0430mple/shoes"))));
    expect(cyr.code).toBe("invalid_input");
    expect(cyr.message).toContain("non-ASCII letters in the site name");
    // The same name written in punycode is visible as such: allowed.
    const puny = new URL("https://shop.ex\u0430mple/").hostname;
    expect(puny.startsWith("shop.xn--")).toBe(true);
    await r.engine.propose(req(withUrl(`https://${puny}/shoes`)));
    // Written out: lower-case host, a path, spaces in the path refused before.
    const c = await r.engine.propose(req(withUrl("https://Shop.Example")));
    const op = lastValidate(r)?.mutateOperations?.at(-1)?.adGroupAdOperation as {
      create: { ad: { finalUrls: string[] } };
    };
    expect(op.create.ad.finalUrls).toEqual(["https://shop.example/"]);
    expect(c.modelTexts.find((t) => t.label === "Ad group 1 ad final URL")?.items).toEqual([
      "https://shop.example/",
    ]);
    // Non-ASCII in the path is fine (sent percent-encoded, as shown).
    await r.engine.propose(req(withUrl("https://shop.example/\u00fcber")));
    expect(
      (
        lastValidate(r)?.mutateOperations?.at(-1)?.adGroupAdOperation as {
          create: { ad: { finalUrls: string[] } };
        }
      ).create.ad.finalUrls,
    ).toEqual(["https://shop.example/%C3%BCber"]);
    // Sitelinks use the same check.
    const site = await errOf(
      r.engine.propose({
        customerId: C,
        type: "add_sitelinks",
        input: {
          campaign_id: "333",
          sitelinks: [{ link_text: "Sale", final_url: "https://\u0430pple.example/sale" }],
        },
        ...AGENT,
      }),
    );
    expect(site.code).toBe("invalid_input");
    expect(site.message).toContain("non-ASCII letters in the site name");
  });
});

describe("sitelink duplicates compare URLs written out the same way", () => {
  it('an existing "https://shop.example" is the new "https://shop.example/": already there', async () => {
    const { r, w } = setup();
    const more = must(w.more);
    more.assets.push({
      id: "70",
      sitelink: { linkText: "Sale" },
      finalUrls: ["https://shop.example"],
    });
    more.campaignAssets.push({
      campaignId: "333",
      assetId: "70",
      fieldType: "SITELINK",
      status: "ENABLED",
    });
    const sitelink = (final_url: string) =>
      r.engine.propose({
        customerId: C,
        type: "add_sitelinks",
        input: { campaign_id: "333", sitelinks: [{ link_text: "Sale", final_url }] },
        ...AGENT,
      });
    for (const url of ["https://shop.example/", "https://Shop.Example", "https://shop.example"]) {
      const e = await errOf(sitelink(url));
      expect(e.code, url).toBe("nothing_to_change");
    }
    const other = await errOf(sitelink("https://shop.example/sale"));
    expect(other.code).toBe("not_allowed");
    expect(other.message).toContain("different URL");
  });
});

describe("create_campaign operations and approval", () => {
  it("ONE atomic Mutate with temporary ids: budget -> campaign -> criteria -> ad groups -> keywords -> ad", async () => {
    const { r } = setup();
    const c = await r.engine.propose(req(full()));
    const budget = `customers/${C}/campaignBudgets/-1`;
    const camp = `customers/${C}/campaigns/-2`;
    const g1 = `customers/${C}/adGroups/-3`;
    const g2 = `customers/${C}/adGroups/-4`;
    expect(lastValidate(r)?.mutateOperations).toEqual([
      {
        campaignBudgetOperation: {
          create: {
            resourceName: budget,
            amountMicros: "20000000",
            period: "DAILY",
            explicitlyShared: false,
          },
        },
      },
      {
        campaignOperation: {
          create: {
            resourceName: camp,
            name: "Spring search",
            status: "PAUSED",
            advertisingChannelType: "SEARCH",
            campaignBudget: budget,
            manualCpc: {},
            networkSettings: {
              targetGoogleSearch: true,
              targetSearchNetwork: false,
              targetContentNetwork: false,
              targetPartnerSearchNetwork: false,
            },
            geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" },
            containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
            startDateTime: "2026-11-01 00:00:00",
            endDateTime: "2026-12-31 23:59:59",
          },
        },
      },
      {
        campaignCriterionOperation: {
          create: { campaign: camp, location: { geoTargetConstant: "geoTargetConstants/2840" } },
        },
      },
      {
        campaignCriterionOperation: {
          create: { campaign: camp, language: { languageConstant: "languageConstants/1000" } },
        },
      },
      {
        campaignCriterionOperation: {
          create: {
            campaign: camp,
            negative: true,
            keyword: { text: "free", matchType: "PHRASE" },
          },
        },
      },
      {
        adGroupOperation: {
          create: {
            resourceName: g1,
            campaign: camp,
            name: "Red shoes",
            status: "ENABLED",
            type: "SEARCH_STANDARD",
            cpcBidMicros: "450000",
          },
        },
      },
      {
        adGroupOperation: {
          create: {
            resourceName: g2,
            campaign: camp,
            name: "Blue shoes",
            status: "ENABLED",
            type: "SEARCH_STANDARD",
            cpcBidMicros: "300000",
          },
        },
      },
      {
        adGroupCriterionOperation: {
          create: {
            adGroup: g1,
            status: "ENABLED",
            keyword: { text: "red shoes", matchType: "EXACT" },
          },
        },
      },
      {
        adGroupCriterionOperation: {
          create: {
            adGroup: g1,
            status: "ENABLED",
            keyword: { text: "buy red shoes", matchType: "PHRASE" },
          },
        },
      },
      {
        adGroupCriterionOperation: {
          create: {
            adGroup: g2,
            status: "ENABLED",
            keyword: { text: "blue shoes", matchType: "EXACT" },
          },
        },
      },
      {
        adGroupAdOperation: {
          create: {
            adGroup: g1,
            status: "ENABLED",
            ad: {
              finalUrls: ["https://shop.example/shoes"],
              responsiveSearchAd: {
                headlines: [
                  { text: "Red shoes", pinnedField: "HEADLINE_1" },
                  { text: "Fast delivery" },
                  { text: "Free returns" },
                ],
                descriptions: [{ text: "Shop red shoes today." }, { text: "Many sizes in stock." }],
                path1: "shoes",
                path2: "red",
              },
            },
          },
        },
      },
    ]);
    // Approval: server lines (no model text), every model text in the AI boxes as sent.
    expect(c.diff).toContain("Budget: a new daily budget of 20.00 EUR for this campaign only.");
    expect(c.diff).toContain("Bidding: Manual CPC, you set the max CPC per ad group.");
    expect(c.diff).toContain("Networks: Google Search yes, Search partners no, Display no.");
    expect(c.diff).toContain(
      "Locations (1): geo target 2840 (Google's names in the box below). Reaches people in or regularly in them (PRESENCE).",
    );
    expect(c.diff).toContain("Languages (1): language 1000 (Google's names in the box below).");
    expect(c.diff).toContain("EU political advertising: declared as NOT containing it.");
    const eu = await r.engine.propose(
      req(minimal({ name: "EU", contains_eu_political_advertising: true })),
    );
    expect(eu.diff).toContain("EU political advertising: declared as CONTAINING it.");
    expect(
      (
        lastValidate(r)?.mutateOperations?.[1]?.campaignOperation as {
          create: { containsEuPoliticalAdvertising: string };
        }
      ).create.containsEuPoliticalAdvertising,
    ).toBe("CONTAINS_EU_POLITICAL_ADVERTISING");
    expect(c.facts.googleNames).toEqual([
      { label: "Locations (id: Google's name)", items: ["2840: United States"] },
      { label: "Languages (id: Google's name)", items: ["1000: English"] },
    ]);
    expect(c.diff).toContain("Start: 2026-11-01. End: 2026-12-31.");
    expect(c.diff).toContain(
      "Ad group 1: max CPC 0.45 EUR, 2 keywords (1 EXACT, 1 PHRASE), 1 responsive search ad (3 headlines, 2 descriptions; pinned: headline 1 -> position 1).",
    );
    expect(c.diff).toContain(
      "11 operations in one all-or-nothing request: if Google refuses any part, nothing is made.",
    );
    expect(c.diff[0]).toContain("PAUSED");
    expect(c.diff[2]).toContain("max_new_daily_spend");
    expect(c.diff.join("\n")).not.toContain("Spring search");
    expect(c.diff.join("\n")).not.toContain("Red shoes");
    expect(c.modelTexts).toEqual([
      { label: "Campaign name", items: ["Spring search"] },
      { label: "Ad group names (in order)", items: ["Red shoes", "Blue shoes"] },
      {
        label: "Ad group 1 keywords (match type: text)",
        items: ["EXACT: red shoes", "PHRASE: buy red shoes"],
      },
      { label: "Ad group 1 ad final URL", items: ["https://shop.example/shoes"] },
      {
        label: "Ad group 1 ad headlines (in order)",
        items: ["Red shoes", "Fast delivery", "Free returns"],
      },
      {
        label: "Ad group 1 ad descriptions (in order)",
        items: ["Shop red shoes today.", "Many sizes in stock."],
      },
      { label: "Ad group 1 ad display paths (1, 2)", items: ["shoes", "red"] },
      { label: "Ad group 2 keywords (match type: text)", items: ["EXACT: blue shoes"] },
      { label: "Campaign negative keywords (match type: text)", items: ["PHRASE: free"] },
    ]);
    expect(c.undo).toMatchObject({ supported: true, level: "full_while_unused" });
    expect(c.facts).toMatchObject({
      createdEnabled: 0,
      broadWithoutSmartBidding: 0,
      spendWhenEnabled: { dailyBudgetMicros: "20000000", budgetShared: false },
      items: [
        { kind: "campaign_budget", created: 1 },
        { kind: "campaign", created: 1 },
        { kind: "campaign_criterion", created: 3 },
        { kind: "ad_group", created: 2 },
        { kind: "ad_group_keyword", created: 3 },
        { kind: "ad", created: 1 },
      ],
    });
    expect(c.facts.newlyEnabled).toBeUndefined();
    // Policy sees the real ops count (max_ops_per_change) and the facts.
    const policyReq = must(
      (r.policy as ReturnType<typeof permissiveTestPolicy>).requests.find(
        (q) => q.stage === "propose",
      ),
    );
    expect(policyReq.opsCount).toBe(11);
    expect(JSON.parse(must(getRow(r.store, c.id)).target_keys)).toEqual([
      `${C}:campaigns/new:Spring search`,
    ]);
  });

  it("a shared budget: no budget op, the campaigns on it listed, both item keys locked", async () => {
    const { r } = setup({
      world: (w) => {
        const b = must(w.budgets["222"]);
        b.explicitlyShared = true;
      },
    });
    const c = await r.engine.propose(
      req(minimal({ daily_budget: undefined, shared_budget_id: "222" })),
    );
    const ops = lastValidate(r)?.mutateOperations ?? [];
    expect(ops[0]?.campaignOperation).toMatchObject({
      create: {
        resourceName: `customers/${C}/campaigns/-1`,
        campaignBudget: `customers/${C}/campaignBudgets/222`,
      },
    });
    expect(ops.some((o) => "campaignBudgetOperation" in o)).toBe(false);
    expect(c.affected.map((a) => `${a.kind}:${a.id}`)).toEqual([
      "campaign_budget:222",
      "campaign:333",
    ]);
    expect(c.facts.spendWhenEnabled).toEqual({ dailyBudgetMicros: "10000000", budgetShared: true });
    expect(JSON.parse(must(getRow(r.store, c.id)).target_keys)).toEqual([
      `${C}:campaignBudgets/222`,
      `${C}:campaigns/new:Spring search`,
    ]);
    // A budget of one campaign can't be used.
    must(r.fake.world.budgets["222"]).explicitlyShared = false;
    const e = await errOf(
      r.engine.propose(
        req(minimal({ name: "Other", daily_budget: undefined, shared_budget_id: "222" })),
      ),
    );
    expect(e.message).toContain("not a shared budget");
  });
});

describe("create_campaign policy", () => {
  it("always created PAUSED, also when the policy lets new keywords start enabled", async () => {
    const { r } = setup({ defaults: { newEntitiesPaused: false } });
    await r.engine.propose(req(full()));
    const camp = lastValidate(r)?.mutateOperations?.[1]?.campaignOperation as {
      create: { status: string };
    };
    expect(camp.create.status).toBe("PAUSED");
  });

  it("BROAD only with smart bidding (policy default); allowed and counted when the policy allows it", async () => {
    const broad = { name: "A", max_cpc: "1", keywords: [{ text: "shoes", match_type: "BROAD" }] };
    const s1 = setup();
    const e = await errOf(
      s1.r.engine.propose(
        req(minimal({ bidding: { strategy: "MANUAL_CPC" }, ad_groups: [broad] })),
      ),
    );
    expect(e.code).toBe("not_allowed");
    expect(e.message).toContain("defaults.broad_match_requires_smart_bidding");
    const clicks = await errOf(
      s1.r.engine.propose(
        req(
          minimal({
            bidding: { strategy: "MAXIMIZE_CLICKS" },
            ad_groups: [{ ...broad, max_cpc: undefined }],
          }),
        ),
      ),
    );
    expect(clicks.code).toBe("not_allowed");
    const smart = await s1.r.engine.propose(
      req(minimal({ ad_groups: [{ ...broad, max_cpc: undefined }] })),
    );
    expect(smart.facts.broadWithoutSmartBidding).toBe(0);
    s1.r.close();
    rig = undefined;
    const s2 = setup({ defaults: { broadMatchRequiresSmartBidding: false } });
    const ok = await s2.r.engine.propose(
      req(minimal({ bidding: { strategy: "MANUAL_CPC" }, ad_groups: [broad] })),
    );
    expect(ok.facts.broadWithoutSmartBidding).toBe(1);
  });

  it("campaign negatives go through the negatives safety (converting searches, brand)", async () => {
    const { r } = setup({
      world: (w) => {
        must(w.more).searchTerms.push({
          text: "free red shoes",
          campaignId: "333",
          conversions: 3,
        });
      },
    });
    const conv = await errOf(r.engine.propose(req(full())));
    expect(conv.code).toBe("not_allowed");
    expect(conv.message).toContain('would block the search "free red shoes"');
    const brand = await errOf(
      r.engine.propose(req(minimal({ negatives: [{ text: "northwind", match_type: "BROAD" }] }))),
    );
    expect(brand.message).toContain("names your brand");
    const over = await r.engine.propose(req(full({ override_blocked_conversions: true })));
    expect(over.facts.blockedConversions?.count).toBe(1);
    expect(over.warnings[0]).toContain("OVERRIDE");
  });
});

describe("create_campaign apply, read-back, undo", () => {
  it("applies, reads every field back, and undo removes the unused campaign and its own budget", async () => {
    const { r, w } = setup();
    const v = await proposeApply(r, full());
    expect(v.status).toBe("verified");
    expect(writesSent(r)).toHaveLength(1);
    const made = newCampaign(w);
    expect(made.status).toBe("PAUSED");
    const budgetId = made.budgetId;
    settle(r);
    const u = await r.engine.proposeUndo(v.id, PAT);
    expect(u.diff[0]).toContain(`Removes campaign ${made.id}`);
    expect(JSON.parse(must(getRow(r.store, u.id)).target_keys)).toEqual([
      `${C}:campaignBudgets/${budgetId}`,
      `${C}:campaigns/${made.id}`,
      `${C}:campaigns/new:Spring search`,
    ]);
    const done = await approveApply(r, u.id);
    expect(done.status).toBe("verified");
    expect(writesSent(r)[1]?.mutateOperations).toEqual([
      { campaignOperation: { remove: `customers/${C}/campaigns/${made.id}` } },
      { campaignBudgetOperation: { remove: `customers/${C}/campaignBudgets/${budgetId}` } },
    ]);
    expect(made.status).toBe("REMOVED");
    expect(must(w.budgets[budgetId]).status).toBe("REMOVED");
  });

  it("a shared budget stays when undo removes the campaign", async () => {
    const { r } = setup({ world: (w) => void (must(w.budgets["222"]).explicitlyShared = true) });
    const v = await proposeApply(r, minimal({ daily_budget: undefined, shared_budget_id: "222" }));
    expect(v.status).toBe("verified");
    settle(r);
    const done = await approveApply(r, (await r.engine.proposeUndo(v.id, PAT)).id);
    expect(done.status).toBe("verified");
    expect(writesSent(r)[1]?.mutateOperations).toHaveLength(1);
    expect(must(r.fake.world.budgets["222"]).status).toBe("ENABLED");
  });

  it("undo is refused once it ran, is on, or Google can't say (no results row)", async () => {
    const { r, w, cw } = setup();
    const v = await proposeApply(r, full());
    const made = newCampaign(w);
    cw.metrics[made.id] = { impressions: "12", clicks: "1", costMicros: "450000" };
    const spent = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(spent.code).toBe("undo_unavailable");
    expect(spent.message).toContain("has run (12 impressions, 1 clicks, 0.45 EUR spent)");
    expect(spent.message).toContain("pause it with update_campaign_status");
    cw.metrics[made.id] = null;
    const noRow = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(noRow.message).toContain("Google returned no results row");
    cw.metrics[made.id] = { impressions: "0", clicks: "0", costMicros: "0" };
    made.status = "ENABLED";
    r.clock.now += 61_000; // undo attempts: 3 a minute per change
    const on = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(on.message).toContain("is turned on");
    expect(writesSent(r)).toHaveLength(1);
  });

  it("undo is refused when Google's change history shows any change after the create", async () => {
    const { r, w, cw } = setup();
    const v = await proposeApply(r, full());
    const made = newCampaign(w);
    const creates = [...must(cw.history[made.id])];
    settle(r);
    // The creates of the original request alone: undo is offered.
    expect((await r.engine.proposeUndo(v.id, PAT)).status).toBe("proposed");
    for (const u of r.engine.list({ customerId: C }).filter((x) => x.undoOf === v.id)) {
      r.engine.markRejected(u.id, PAT);
    }
    // Any update, whatever field (a name change, a switch on and off, unknown fields).
    cw.history[made.id] = [...creates, { type: "CAMPAIGN", operation: "UPDATE" }];
    const changed = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(changed.code).toBe("undo_unavailable");
    expect(changed.message).toContain("change history shows campaign");
    // Stamped by an account clock running ahead of ours: still read (window ends a day ahead).
    cw.history[made.id] = [
      ...creates,
      {
        type: "CAMPAIGN",
        operation: "UPDATE",
        at: localDateTime(r.clock.now + 2 * 3_600_000, "Europe/Amsterdam"),
      },
    ];
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).message).toContain(
      "change history shows campaign",
    );
    r.clock.now += 61_000; // undo attempts: 3 a minute per change
    // A create the original request did not make (a sitelink linked later).
    cw.history[made.id] = [...creates, { type: "CAMPAIGN_ASSET", operation: "CREATE" }];
    const added = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(added.code).toBe("undo_stale");
    // One more ad group than it made.
    r.clock.now += 61_000;
    cw.history[made.id] = [...creates, { type: "AD_GROUP", operation: "CREATE" }];
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).code).toBe("undo_stale");
    // A full page of history: can't tell.
    cw.history[made.id] = Array.from({ length: 10_000 }, () => ({
      type: "CAMPAIGN_CRITERION",
      operation: "CREATE",
    }));
    const full_ = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(full_.message).toContain("too long to check");
    expect(writesSent(r)).toHaveLength(1);
  });

  it("undo second line: sitelinks, labels, settings or keywords found on it make it stale", async () => {
    const { r, w, cw } = setup();
    const v = await proposeApply(r, full());
    const made = newCampaign(w);
    const tree = must(cw.trees[made.id]);
    settle(r);
    // Sitelinks linked after the create (the change history has not caught up).
    tree.attached.campaign_asset = [
      { campaignAsset: { resourceName: `customers/${C}/campaignAssets/${made.id}~9~SITELINK` } },
    ];
    const sitelinks = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(sitelinks.code).toBe("undo_stale");
    expect(sitelinks.message).toContain("added to the campaign after it was made");
    // Google's own device rows (no bid adjustment) don't count; one with an adjustment does.
    const mods = must(tree.attached.ad_group_bid_modifier);
    tree.attached = { ad_group_bid_modifier: mods };
    const desktop = must(tree.criteria.find((c) => c.type === "DEVICE"));
    (desktop as Record<string, unknown>).bidModifier = 0;
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).code).toBe("undo_stale");
    delete (desktop as Record<string, unknown>).bidModifier;
    r.clock.now += 61_000; // undo attempts: 3 a minute per change
    (made as unknown as Record<string, unknown>).labels = [`customers/${C}/labels/5`];
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).code).toBe("undo_stale");
    delete (made as unknown as Record<string, unknown>).labels;
    (made as unknown as Record<string, unknown>).trackingUrlTemplate = "{lpurl}?src=x";
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).code).toBe("undo_stale");
    delete (made as unknown as Record<string, unknown>).trackingUrlTemplate;
    tree.keywords.push({
      adGroupId: must(tree.adGroups[0]).id,
      criterionId: "1",
      type: "KEYWORD",
      negative: false,
      status: "ENABLED",
      keyword: { text: "added by hand", matchType: "EXACT" },
    });
    r.clock.now += 61_000; // undo attempts: 3 a minute per change
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).code).toBe("undo_stale");
    expect(writesSent(r)).toHaveLength(1);
  });

  it("undo needs Google's change history to show the creation: empty, partial or lagging = refused (logged)", async () => {
    const { r, w, cw } = setup();
    const v = await proposeApply(r, full());
    const made = newCampaign(w);
    const creates = [...must(cw.history[made.id])];
    settle(r);
    const notYet = "Google's change history doesn't show this campaign's creation yet";
    // Empty (Google's history answered no rows).
    cw.historyReads = { [made.id]: ["empty"] };
    const empty = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(empty.code).toBe("undo_unavailable");
    expect(empty.message).toBe(
      `${notYet}, so it can't confirm nothing else changed. Try the undo again in a few minutes.`,
    );
    expect(listEvents(r.store, v.id).at(-1)).toMatchObject({
      event: "refused",
      data: { stage: "undo", code: "undo_unavailable" },
    });
    // Part of it: the ad groups without the campaign's own create.
    const noCampaign = creates.filter((e) => e.type !== "CAMPAIGN");
    cw.historyReads = { [made.id]: [noCampaign, noCampaign] };
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).message).toContain(notYet);
    // A campaign create, but of another campaign.
    const other = creates.map((e) =>
      e.type === "CAMPAIGN" ? { ...e, name: `customers/${C}/campaigns/1` } : e,
    );
    cw.historyReads = { [made.id]: [other, other] };
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).message).toContain(notYet);
    // Part of it: the campaign, one of its two ad groups.
    const firstGroup = creates.findIndex((e) => e.type === "AD_GROUP");
    r.clock.now += 61_000; // undo attempts: 3 a minute per change
    const partial = creates.filter((_, i) => i !== firstGroup);
    cw.historyReads = { [made.id]: [partial, partial] };
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).message).toContain(notYet);
    // All rows, then none a moment later (seen live): refused after the second read.
    cw.historyReads = { [made.id]: [creates, "empty"] };
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).message).toContain(notYet);
    expect(r.sleeps).toContain(20_000);
    // Lagging: events not shown until 20 minutes after; at 16 minutes nothing yet.
    r.clock.now += 61_000;
    cw.historyLagMs = 20 * 60_000;
    cw.historyReads = {};
    const v2Start = r.clock.now;
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).message).toContain(notYet);
    r.clock.now = v2Start + 10 * 60_000;
    expect((await r.engine.proposeUndo(v.id, PAT)).status).toBe("proposed");
    expect(writesSent(r)).toHaveLength(1);
  });

  it("undo is refused when the second history read shows a change or differs from the first", async () => {
    const { r, w, cw } = setup();
    const v = await proposeApply(r, full());
    const made = newCampaign(w);
    const creates = [...must(cw.history[made.id])];
    settle(r);
    cw.historyReads = {
      [made.id]: [creates, [...creates, { type: "CAMPAIGN", operation: "UPDATE" }]],
    };
    const changed = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(changed.code).toBe("undo_unavailable");
    expect(changed.message).toContain("change history shows campaign");
    // A create the first read did not have: the reads disagree.
    cw.historyReads = {
      [made.id]: [creates, [...creates, { type: "CAMPAIGN_ASSET", operation: "CREATE" }]],
    };
    const differs = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(differs.code).toBe("undo_unavailable");
    expect(differs.message).toContain("doesn't show this campaign's creation yet");
    expect(writesSent(r)).toHaveLength(1);
  });

  it("undo is refused for 15 minutes after the create, with the earliest time; then it removes it", async () => {
    const { r, w, cw } = setup();
    const v = await proposeApply(r, full());
    const madeAt = r.clock.now;
    const made = newCampaign(w);
    r.clock.now += 5 * 60_000;
    const young = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(young.code).toBe("undo_unavailable");
    expect(young.message).toBe(
      `Campaign ${made.id} was made less than 15 minutes ago and Google's change history lags, so it can't confirm nothing else changed yet. Try the undo again after ${localDateTime(madeAt + 15 * 60_000, "Europe/Amsterdam")} (Europe/Amsterdam).`,
    );
    expect(listEvents(r.store, v.id).at(-1)).toMatchObject({
      event: "refused",
      data: { code: "undo_unavailable" },
    });
    r.clock.now = madeAt + 15 * 60_000 - 1_000;
    expect((await errOf(r.engine.proposeUndo(v.id, PAT))).message).toContain(
      "less than 15 minutes ago",
    );
    // Both reads show its creates, 15 minutes on: proposed, applied, read back.
    r.clock.now = madeAt + 15 * 60_000;
    cw.historyReadAt = [];
    const u = await r.engine.proposeUndo(v.id, PAT);
    expect(u.status).toBe("proposed");
    const done = await approveApply(r, u.id);
    expect(done.status).toBe("verified");
    expect(made.status).toBe("REMOVED");
    // Propose and the re-check before sending each read the history twice, 20 s apart.
    expect(r.sleeps.filter((ms) => ms === 20_000)).toHaveLength(2);
    const at = must(cw.historyReadAt);
    expect(at).toHaveLength(4);
    expect(must(at[1]) - must(at[0])).toBeGreaterThanOrEqual(20_000);
    expect(must(at[3]) - must(at[2])).toBeGreaterThanOrEqual(20_000);
  });

  it("undo's 15 minutes run from this server's apply time, across clock changes in the account's zone", async () => {
    // Made at 01:30 local, in the hour the clocks repeat (or skip): never an hour early.
    for (const [zone, utc] of [
      ["America/New_York", "2026-11-01T06:30:00Z"], // 01:30 EST, after the fall-back
      ["Europe/Amsterdam", "2026-03-29T00:30:00Z"], // 01:30 CET, before the spring change
      ["Pacific/Auckland", "2026-09-26T13:30:00Z"], // 01:30 NZST, before the spring change
      ["Pacific/Honolulu", "2026-11-01T11:30:00Z"], // fixed offset
    ] as const) {
      const { r, w } = setup({
        world: (x) => {
          x.customer.timeZone = zone;
        },
      });
      r.clock.now = Date.parse(utc);
      const v = await proposeApply(r, minimal());
      const made = newCampaign(w);
      r.clock.now += 5 * 60_000;
      expect((await errOf(r.engine.proposeUndo(v.id, PAT))).message, zone).toContain(
        `Campaign ${made.id} was made less than 15 minutes ago`,
      );
      r.clock.now += 11 * 60_000;
      expect((await r.engine.proposeUndo(v.id, PAT)).status, zone).toBe("proposed");
      rig?.close();
      rig = undefined;
    }
  });

  it("undo: history empty at the re-check before sending = stale with the real reason, nothing sent", async () => {
    const { r, w, cw } = setup();
    const v = await proposeApply(r, minimal());
    const made = newCampaign(w);
    settle(r);
    const u = await r.engine.proposeUndo(v.id, PAT);
    cw.historyReads = { [made.id]: ["empty"] };
    const done = await approveApply(r, u.id);
    expect(done.status).toBe("stale");
    expect(done.statusReason).toBe(
      "Nothing was sent: Google's change history doesn't show this campaign's creation yet, so it can't confirm nothing else changed. Try the undo again in a few minutes.",
    );
    expect(made.status).toBe("PAUSED");
    expect(writesSent(r)).toHaveLength(1);
  });

  it("undo (direct plan): no time left before the apply deadline for the second read = refused", async () => {
    const { r, w } = setup();
    const v = await proposeApply(r, minimal());
    const made = newCampaign(w);
    settle(r);
    const { client } = makeClient(r.fake.router, { now: () => r.clock.now });
    const keys = Object.keys(JSON.parse(must(getRow(r.store, v.id)).expected) as object);
    const slept: number[] = [];
    const plan = (deadlineAt: number, sendReserveMs?: number) =>
      createCampaign.plan(
        {
          ads: client,
          target: { customerId: C, loginCustomerId: undefined },
          account: {
            customerId: C,
            name: "Northwind",
            currencyCode: "EUR",
            timeZone: "Europe/Amsterdam",
            testAccount: true,
            manager: false,
          },
          now: () => r.clock.now,
          deadlineAt,
          sendReserveMs,
          sleep: async (ms) => void slept.push(ms),
          sentOnCampaign: () => [],
        },
        {
          undo: {
            campaign_name: "Spring search",
            campaign_id: made.id,
            remove_budget: true,
            made_at: must(must(getRow(r.store, v.id)).applied_at),
            keys,
          },
        },
      );
    const late = await errOf(plan(r.clock.now + 30_000));
    expect(late.code).toBe("read_failed");
    expect(late.message).toContain("Not enough time");
    expect(slept).toEqual([]);
    // Before sending, the send's reserve counts too: 60 s left is not enough for 20 + 15 + 130.
    expect((await errOf(plan(r.clock.now + 60_000, 130_000))).code).toBe("read_failed");
    expect(slept).toEqual([]);
    expect((await plan(r.clock.now + 165_000, 130_000)).ops).toHaveLength(2);
    expect((await plan(r.clock.now + 60_000)).ops).toHaveLength(2);
    expect(slept).toEqual([20_000, 20_000]);
  });

  it("undo (engine): too little apply time for wait + second read + send = failed before the wait, nothing sent", async () => {
    // 70 s: enough for the wait and second read alone (35 s), not with the 60 s send reserve.
    const { r, w } = setup({ engine: { applyDeadlineMs: 70_000, sendReserveMs: 60_000 } });
    const v = await proposeApply(r, minimal());
    expect(v.status).toBe("verified");
    const made = newCampaign(w);
    settle(r);
    const u = await r.engine.proposeUndo(v.id, PAT);
    const slept = r.sleeps.length;
    const done = await approveApply(r, u.id);
    expect(done.status).toBe("failed");
    expect(done.statusReason).toBe(
      "Couldn't re-check the account right before sending, so nothing was sent. Try again.",
    );
    expect(r.sleeps.slice(slept)).not.toContain(20_000);
    expect(made.status).toBe("PAUSED");
    expect(writesSent(r)).toHaveLength(1);
  });

  it("undo proposed without made_at (before it was stored) = stale at the re-check, nothing sent", async () => {
    const { r, w } = setup();
    const v = await proposeApply(r, minimal());
    const made = newCampaign(w);
    settle(r);
    const u = await r.engine.proposeUndo(v.id, PAT);
    // The saved input as an older server stored it: no made_at, hash to match.
    r.store.db.exec("DROP TRIGGER changes_fixed_fields");
    const row = must(getRow(r.store, u.id));
    const payload = JSON.parse(row.payload) as { undo: Record<string, unknown> };
    expect(payload.undo.made_at).toBeDefined();
    delete payload.undo.made_at;
    const old = { ...row, payload: canonicalJson(payload) };
    r.store.db
      .prepare("UPDATE changes SET payload = ?, diff_hash = ? WHERE id = ?")
      .run(old.payload, rowDiffHash(old), u.id);
    const done = await approveApply(r, u.id);
    expect(done.status).toBe("stale");
    expect(done.statusReason).toBe(
      "Nothing was sent: This undo doesn't say when the campaign was made, so it can't wait for Google's change history. Propose the undo again.",
    );
    expect(made.status).toBe("PAUSED");
    expect(writesSent(r)).toHaveLength(1);
  });

  it("undo is refused when this server sent any change on the campaign (store), not for a proposal only", async () => {
    const { r, w } = setup();
    const v = await proposeApply(r, minimal({ daily_budget: "35" }));
    const made = newCampaign(w);
    settle(r);
    const status = (s: string) => ({
      customerId: C,
      type: "update_campaign_status",
      input: { campaign_id: made.id, status: s },
      ...AGENT,
    });
    // Only proposed (never sent): undo still offered.
    const pending = await r.engine.propose(status("ENABLED"));
    const ok = await r.engine.proposeUndo(v.id, PAT);
    expect(ok.status).toBe("proposed");
    r.engine.markRejected(ok.id, PAT);
    // Switched on and off again: status is PAUSED, no numbers yet, but it may have run.
    await approveApply(r, pending.id);
    expect((await approveApply(r, (await r.engine.propose(status("PAUSED"))).id)).status).toBe(
      "verified",
    );
    expect(made.status).toBe("PAUSED");
    const e = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(e.code).toBe("undo_unavailable");
    expect(e.message).toContain("update_campaign_status, verified");
    expect(e.message).toContain("pause it with update_campaign_status");
  });

  it("a shared-budget change that only lists the campaign doesn't block undo; a status change on it does", async () => {
    const { r, w } = setup({ world: (x) => void (must(x.budgets["222"]).explicitlyShared = true) });
    const v = await proposeApply(r, minimal({ daily_budget: undefined, shared_budget_id: "222" }));
    const made = newCampaign(w);
    settle(r);
    const budget = await approveApply(
      r,
      (
        await r.engine.propose({
          customerId: C,
          type: "update_budget",
          input: { budget_id: "222", daily_amount: "12" },
          ...AGENT,
        })
      ).id,
    );
    expect(budget.status).toBe("verified");
    expect(budget.facts.affectedCampaignIds).toContain(made.id);
    const ok = await r.engine.proposeUndo(v.id, PAT);
    expect(ok.status).toBe("proposed");
    r.engine.markRejected(ok.id, PAT);
    const status = (s: string) => ({
      customerId: C,
      type: "update_campaign_status",
      input: { campaign_id: made.id, status: s },
      ...AGENT,
    });
    await approveApply(r, (await r.engine.propose(status("ENABLED"))).id);
    await approveApply(r, (await r.engine.propose(status("PAUSED"))).id);
    const e = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(e.code).toBe("undo_unavailable");
    expect(e.message).toContain("update_campaign_status, verified");
  });

  it("a shared negative list linked to it (a child key) blocks undo", async () => {
    const { r, w } = setup();
    const v = await proposeApply(r, minimal());
    const made = newCampaign(w);
    const linked = await approveApply(
      r,
      (
        await r.engine.propose({
          customerId: C,
          type: "add_shared_negatives",
          input: {
            new_list_name: "Never sells",
            negatives: [{ text: "jobs", match_type: "BROAD" }],
            link_campaign_ids: [made.id],
          },
          ...AGENT,
        })
      ).id,
    );
    expect(linked.status).toBe("verified");
    const e = await errOf(r.engine.proposeUndo(v.id, PAT));
    expect(e.code).toBe("undo_unavailable");
    expect(e.message).toContain("add_shared_negatives, verified");
  });

  it("undo (direct plan): never removes a budget that is shared now; no store check = refused", async () => {
    const { r, w } = setup();
    const v = await proposeApply(r, minimal());
    const made = newCampaign(w);
    must(w.budgets[made.budgetId]).explicitlyShared = true;
    settle(r);
    const { client } = makeClient(r.fake.router, { now: () => r.clock.now });
    const keys = Object.keys(JSON.parse(must(getRow(r.store, v.id)).expected) as object);
    const made_at = must(must(getRow(r.store, v.id)).applied_at);
    const undoIn = {
      undo: {
        campaign_name: "Spring search",
        campaign_id: made.id,
        remove_budget: true,
        made_at,
        keys,
      },
    };
    const account = {
      customerId: C,
      name: "Northwind",
      currencyCode: "EUR",
      timeZone: "Europe/Amsterdam",
      testAccount: true,
      manager: false,
    };
    const blind = await errOf(
      createCampaign.plan(
        { ads: client, target: { customerId: C, loginCustomerId: undefined }, account },
        undoIn,
      ),
    );
    expect(blind.code).toBe("undo_unavailable");
    expect(blind.message).toContain("Couldn't check this server's own changes");
    const planned = await createCampaign.plan(
      {
        ads: client,
        target: { customerId: C, loginCustomerId: undefined },
        account: {
          customerId: C,
          name: "Northwind",
          currencyCode: "EUR",
          timeZone: "Europe/Amsterdam",
          testAccount: true,
          manager: false,
        },
        now: () => r.clock.now,
        sleep: async () => {},
        sentOnCampaign: () => [],
      },
      {
        undo: {
          campaign_name: "Spring search",
          campaign_id: made.id,
          remove_budget: true,
          made_at,
          keys,
        },
      },
    );
    expect(planned.ops).toEqual([
      { campaignOperation: { remove: `customers/${C}/campaigns/${made.id}` } },
    ]);
  });

  it("read-back: Google storing a different value is verify_failed", async () => {
    const { r, cw } = setup();
    cw.storeAs = (c) => {
      c.networkSettings = { ...(c.networkSettings as object), targetContentNetwork: true };
    };
    const v = await proposeApply(r, full());
    expect(v.status).toBe("verify_failed");
  });

  it("all or nothing: Google refusing one part makes nothing", async () => {
    const { r, w } = setup();
    r.fake.hooks.failOps = (i) =>
      i === 7 ? { type: "criterionError", value: "KEYWORD_HAS_INVALID_CHARS" } : undefined;
    const v = await proposeApply(r, full());
    expect(v.status).toBe("failed");
    expect(Object.values(w.campaigns).some((c) => c.name === "Spring search")).toBe(false);
    expect(Object.keys(w.budgets)).toEqual(["222"]);
  });

  it("turning the new campaign on later counts its budget as new daily spend", async () => {
    const { r, w } = setup();
    await proposeApply(r, minimal({ daily_budget: "35" }));
    const made = newCampaign(w);
    const on = await r.engine.propose({
      customerId: C,
      type: "update_campaign_status",
      input: { campaign_id: made.id, status: "ENABLED" },
      ...AGENT,
    });
    expect(on.facts.newlyEnabled).toEqual([
      { campaignId: made.id, dailyBudgetMicros: "35000000", budgetShared: false },
    ]);
  });
});
