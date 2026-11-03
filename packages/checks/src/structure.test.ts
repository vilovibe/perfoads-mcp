// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { runChecks, type EvidenceInput } from "./api.js";
import type { CheckResult } from "./engine/checks/types.js";
import type { Row } from "./engine/shared/input.js";
import {
  buildInput,
  dayBefore,
  keyword,
  adGroup,
  LAST_DAY,
  runOne,
  type CampaignSpec,
  type FixtureOptions,
} from "./testing/account.js";

const state = (r: CheckResult) => r.state;
const findingsOf = (r: CheckResult) => (r.state === "fires" ? r.findings : []);

/** A read status for a named table (the engine's db tables have no AccountData key). */
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
const account = (opts: Partial<FixtureOptions> = {}, campaigns: CampaignSpec[] = [generic]) =>
  buildInput({ campaigns, ...opts });

describe("AS01 brand share of spend", () => {
  it("fires when brand campaigns take the bar or more", () => {
    const r = runOne("AS01", account({}, [generic, { id: "12", name: "Brand search", cost: 100 }]));
    expect(state(r)).toBe("fires");
  });
  it("is clean under the bar, and the bar is a setting", () => {
    const small = account({}, [generic, { id: "12", name: "Brand search", cost: 10 }]);
    expect(state(runOne("AS01", small))).toBe("none_found");
    const strict = account({ settings: { structure: { brandSpendSharePct: 5 } } }, [
      generic,
      { id: "12", name: "Brand search", cost: 10 },
    ]);
    expect(state(runOne("AS01", strict))).toBe("fires");
  });
  it("is not checkable with no brand campaign", () => {
    expect(state(runOne("AS01", account()))).toBe("not_checkable");
  });
});

describe("AS02 brand campaign on a value or CPA target", () => {
  it("fires on a brand campaign with a target ROAS", () => {
    const r = runOne(
      "AS02",
      account({}, [{ id: "12", name: "Brand search", strategy: "TARGET_ROAS", targetRoas: 4 }]),
    );
    expect(findingsOf(r)[0]?.scope.id).toBe("12");
  });
  it("is clean on manual CPC", () => {
    const r = runOne("AS02", account({}, [{ id: "12", name: "Brand", strategy: "MANUAL_CPC" }]));
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable with no brand campaign", () => {
    expect(state(runOne("AS02", account()))).toBe("not_checkable");
  });
});

describe("AS03 shared budget starves another campaign", () => {
  const shared = (lostBudget: number) =>
    buildInput({
      campaigns: [
        { id: "11", extra: { budget_id: "b1" }, is: { lostBudget: 0.01 } },
        { id: "12", extra: { budget_id: "b1" }, is: { lostBudget } },
      ],
      data: {
        campaignBudgets: [
          { budget_id: "b1", name: "Shared", amount: 100, status: "ENABLED", reference_count: 2 },
        ],
      },
    });
  it("fires when a campaign on the shared budget loses over the bar to budget", () => {
    expect(state(runOne("AS03", shared(0.3)))).toBe("fires");
  });
  it("is clean when nobody on the shared budget is starved", () => {
    expect(state(runOne("AS03", shared(0.02)))).toBe("none_found");
  });
  it("judges a sibling on the last 3 weeks when read, as BB02", () => {
    const withRecent = (lostBudget: number | null, cost = 700) =>
      buildInput({
        campaigns: [
          { id: "11", extra: { budget_id: "b1" }, is: { lostBudget: 0.01 } },
          {
            id: "12",
            extra: { budget_id: "b1" },
            is: { lostBudget: 0.3, recent: { lostBudget, cost } },
          },
        ],
        data: {
          campaignBudgets: [
            { budget_id: "b1", name: "Shared", amount: 100, status: "ENABLED", reference_count: 2 },
          ],
        },
      });
    expect(state(runOne("AS03", withRecent(0)))).toBe("none_found");
    expect(state(runOne("AS03", withRecent(null, 0)))).toBe("none_found");
    expect(state(runOne("AS03", withRecent(0.3)))).toBe("fires");
  });
  it("is not checkable when budgets were not read", () => {
    const input = account({ noMarker: ["campaignBudgets"] });
    const r = runOne("AS03", { ...input, data: { ...input.data, campaignBudgets: [] } });
    expect(state(r)).toBe("not_checkable");
  });
});

describe("AS04 auto-apply", () => {
  const subs = (rows: Row[]) => account({ data: { recommendationSubscriptions: rows } });
  it("fires when a type that changes bidding auto-applies", () => {
    const r = runOne("AS04", subs([{ type: "TARGET_ROAS_OPT_IN", status: "ENABLED" }]));
    expect(findingsOf(r)[0]?.rows?.[0]?.entity.name).toBe("TARGET_ROAS_OPT_IN");
  });
  it("names a type the API could not name as unnamed, never invented", () => {
    const r = runOne("AS04", subs([{ type: "UNKNOWN", status: "ENABLED" }]));
    expect(findingsOf(r)[0]?.facts.unnamed_types).toBe(1);
  });
  it("is clean when only cosmetic types are on, or nothing is", () => {
    expect(state(runOne("AS04", subs([{ type: "OPTIMIZE_AD_ROTATION", status: "ENABLED" }])))).toBe(
      "none_found",
    );
    expect(state(runOne("AS04", subs([{ type: "KEYWORD", status: "PAUSED" }])))).toBe("none_found");
  });
  it("is not checkable when the settings were not read", () => {
    expect(state(runOne("AS04", account()))).toBe("not_checkable");
  });
});

describe("AS06 experiment running", () => {
  const exp = (status: string) =>
    account({
      data: {
        experiments: [
          {
            experiment_id: "71",
            resource_name: "customers/1/experiments/71",
            name: "Test",
            status,
          },
        ],
        experimentArms: [
          {
            experiment_resource_name: "customers/1/experiments/71",
            campaigns_json: ["customers/1/campaigns/11"],
          },
        ],
      },
    });
  it("fires on the campaign in a running experiment", () => {
    const r = runOne("AS06", exp("ENABLED"));
    expect(findingsOf(r)[0]?.scope.id).toBe("11");
  });
  it("says the tested campaigns could not be read when the arms were not read", () => {
    const input = exp("ENABLED");
    const noArms = runOne("AS06", {
      ...input,
      data: { ...input.data, experimentArms: [] },
      statusRows: (input.statusRows ?? []).filter((r) => r.table_name !== "experiment_arms"),
    });
    const f = findingsOf(noArms)[0];
    expect(f?.scope.type).toBe("account");
    expect(f?.limitedBy?.join(" ")).toMatch(/could not read which campaigns/);
  });
  it("is clean when the experiment ended", () => {
    expect(state(runOne("AS06", exp("HALTED")))).toBe("none_found");
  });
  it("is not checkable when experiments were not read", () => {
    expect(state(runOne("AS06", account()))).toBe("not_checkable");
  });
});

describe("AS07 content exclusions missing", () => {
  const display = { id: "12", name: "Display prospecting", type: "DISPLAY" };
  it("fires when nothing is excluded while Display runs", () => {
    const input = withStatus(
      account({ tables: { account_negative_criteria: [] } }, [generic, display]),
      "account_negative_criteria",
      0,
    );
    expect(state(runOne("AS07", input))).toBe("fires");
  });
  it("is clean with an exclusion", () => {
    const rows = [{ criterion_type: "CONTENT_LABEL", content_label_type: "TRAGEDY" }];
    const input = withStatus(
      account({ tables: { account_negative_criteria: rows } }, [generic, display]),
      "account_negative_criteria",
      1,
    );
    expect(state(runOne("AS07", input))).toBe("none_found");
  });
  it("is not checkable when exclusions were not read", () => {
    expect(state(runOne("AS07", account({}, [generic, display])))).toBe("not_checkable");
  });
});

describe("AS08 negative list attached to no campaign", () => {
  const lists = (linked: string[]) =>
    account({
      data: {
        sharedNegativeLists: [
          {
            shared_set_id: "81",
            shared_set_name: "Junk",
            member_count: 1,
            linked_campaign_ids: linked,
          },
        ],
        sharedNegativeListMembers: [
          {
            shared_set_id: "81",
            shared_set_name: "Junk",
            keyword_text: "free",
            match_type: "BROAD",
          },
        ],
      },
      syncedEmpty: ["accountNegatives"],
    });
  it("fires on a list attached nowhere", () => {
    expect(state(runOne("AS08", lists([])))).toBe("fires");
  });
  // B15: the rows (the reply's items) name the LISTS, never the campaigns
  it("names the unattached lists, one row each, with the campaigns they fit as context", () => {
    const f = findingsOf(runOne("AS08", lists([])))[0];
    expect(f?.facts.unattached_lists).toEqual(["Junk"]);
    expect(f?.facts.unattached_list_count).toBe(1);
    // N6: the list is attached to none; the campaigns it fits are named as that, never "campaigns"
    expect(f?.facts.lists).toEqual([
      { name: "Junk", attached_campaigns: 0, fits_live_campaigns: ["Generic search"] },
    ]);
    expect(f?.rows).toEqual([
      {
        entity: { id: "81", name: "Junk" },
        cells: { campaigns: ["Generic search"], campaign_ids: ["11"] },
      },
    ]);
  });
  it("is clean when the list is attached", () => {
    expect(state(runOne("AS08", lists(["11"])))).toBe("none_found");
  });
  it("is not checkable when the lists were not read", () => {
    expect(state(runOne("AS08", account()))).toBe("not_checkable");
  });
});

describe("AS09 standard remarketing lists", () => {
  const ROLES = [
    "All purchasers",
    "High value customers",
    "Recent purchasers 30d",
    "Cart abandoners",
    "Newsletter subscribers",
    "Repeat customers",
    "Lapsed customers",
  ];
  // tier B (about $6,000 a month): the wider set of lists is expected
  const lists = (names: string[]) =>
    account(
      {
        data: {
          audienceLists: names.map((n, i) => ({
            list_id: String(900 + i),
            list_name: n,
            list_type: "RULE_BASED",
            membership_status: "OPEN",
            size_for_search: 5000,
          })),
        },
      },
      [{ id: "11", name: "Generic search", cost: 200 }],
    );
  it("fires and names the missing lists", () => {
    const r = runOne("AS09", lists(["All purchasers"]));
    expect(findingsOf(r)[0]?.facts.missing_count).toBe(6);
  });
  it("is clean with all seven", () => {
    expect(state(runOne("AS09", lists(ROLES)))).toBe("none_found");
  });
  it("is not checkable when the lists were not read, or below tier B", () => {
    expect(state(runOne("AS09", account({}, [{ id: "11", cost: 200 }])))).toBe("not_checkable");
    const small = account({
      data: { audienceLists: lists(["All purchasers"]).data.audienceLists ?? [] },
    });
    expect(runOne("AS09", small)).toMatchObject({ category: "not_applicable" });
  });
});

describe("AS10 users with access", () => {
  const users = (n: number) =>
    account({
      data: { customerUserAccess: Array.from({ length: n }, () => ({ access_role: "ADMIN" })) },
    });
  it("fires (information) with more than one user", () => {
    expect(state(runOne("AS10", users(3)))).toBe("fires");
  });
  it("is clean with one user", () => {
    expect(state(runOne("AS10", users(1)))).toBe("none_found");
  });
  it("is not checkable when not read", () => {
    expect(state(runOne("AS10", account()))).toBe("not_checkable");
  });
});

/** Change rows: `n` changes by `who`, made in the interface. */
const changes = (n: number, who: string, clientType = "GOOGLE_ADS_WEB_CLIENT", fields = "name") =>
  Array.from({ length: n }, (_, i) => ({
    change_date_time: `${dayBefore(LAST_DAY, i % 20)} 10:00:00`,
    change_resource_name: "customers/1/campaigns/11",
    resource_type: "CAMPAIGN",
    operation: "UPDATE",
    changed_fields: fields,
    client_type: clientType,
    user_email: who,
  }));

describe("AS13 one login made most changes", () => {
  it("fires when one login makes the bar share or more", () => {
    const r = runOne(
      "AS13",
      account({ data: { changeHistory: [...changes(60, "a"), ...changes(2, "b")] } }),
    );
    expect(state(r)).toBe("fires");
  });
  it("is clean when changes are spread", () => {
    const r = runOne(
      "AS13",
      account({ data: { changeHistory: [...changes(30, "a"), ...changes(30, "b")] } }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is insufficient under the change bar and not checkable when not read", () => {
    expect(state(runOne("AS13", account({ data: { changeHistory: changes(5, "a") } })))).toBe(
      "insufficient_data",
    );
    expect(state(runOne("AS13", account()))).toBe("not_checkable");
  });
});

describe("AS14 Google changed the account itself", () => {
  it("fires on a budget change made by an auto-applied recommendation", () => {
    const rows = changes(1, "x", "GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION", "amount_micros");
    const budget = {
      ...rows[0],
      change_resource_name: "customers/1/campaignBudgets/b11",
      resource_type: "CAMPAIGN_BUDGET",
    };
    const r = runOne("AS14", account({ data: { changeHistory: [budget] } }));
    expect(findingsOf(r)[0]?.facts.budget_changes).toBe(1);
  });
  it("is clean when people made every change", () => {
    expect(state(runOne("AS14", account({ data: { changeHistory: changes(3, "a") } })))).toBe(
      "none_found",
    );
  });
  it("is not checkable when not read", () => {
    expect(state(runOne("AS14", account()))).toBe("not_checkable");
  });
});

describe("AS15 apps not excluded", () => {
  const video = { id: "12", name: "Video prospecting", type: "VIDEO" };
  const ex = (rows: Row[]) =>
    withStatus(
      account({ tables: { account_negative_criteria: rows } }, [generic, video]),
      "account_negative_criteria",
      rows.length,
    );
  const label = { criterion_type: "CONTENT_LABEL", content_label_type: "TRAGEDY" };
  it("fires when apps are not excluded while video runs", () => {
    const r = runOne("AS15", ex([label]));
    expect(state(r)).toBe("fires");
    // no live PMax: nothing withheld
    expect(findingsOf(r)[0]?.facts.pmax_app_cost_withheld).toBeUndefined();
  });
  it("says Performance Max app cost is not included when a live PMax runs", () => {
    const pmax = { id: "14", name: "PMax all products", type: "PERFORMANCE_MAX" };
    const rows = [label];
    const input = withStatus(
      account({ tables: { account_negative_criteria: rows } }, [generic, video, pmax]),
      "account_negative_criteria",
      rows.length,
    );
    const f = findingsOf(runOne("AS15", input))[0];
    expect(f?.facts).toMatchObject({
      pmax_app_cost_withheld: true,
      app_spend_scope: "Display, Video and Demand Gen only",
    });
    expect(f?.openItems?.join(" ")).toMatch(/Performance Max app spend is not included/);
    expect(f?.note).toMatch(/Performance Max app spend not included/);
    // B6: the line people read (the info note) says it too, not only the facts
    const line = runChecks(input).checks.find((c) => c.id === "AS15");
    expect(line?.status).toBe("info");
    expect(line?.note).toBe(
      "some brand-safety exclusions are set, but mobile apps are not excluded; the app spend shown does not include Performance Max, because Google does not report what its app placements cost",
    );
  });
  it("B6: without a live PMax the info line stays the plain one", () => {
    expect(runChecks(ex([label])).checks.find((c) => c.id === "AS15")?.note).toBe(
      "some brand-safety exclusions are set, but mobile apps are not excluded",
    );
  });
  it("is clean with the app category excluded", () => {
    const app = {
      criterion_type: "MOBILE_APP_CATEGORY",
      mobile_app_category: "mobileAppCategoryConstants/69500",
    };
    expect(state(runOne("AS15", ex([label, app])))).toBe("none_found");
  });
  it("is not checkable when not read", () => {
    expect(state(runOne("AS15", account({}, [generic, video])))).toBe("not_checkable");
  });
});

describe("AS16 campaigns split too thin to learn", () => {
  const thin = (conv: number) =>
    [1, 2, 3].map((i) => ({
      id: `1${i}`,
      name: `Generic search ${i}`,
      strategy: "TARGET_CPA",
      targetCpa: 20,
      conv,
    }));
  it("fires when three campaigns of a kind each sit under the bar", () => {
    const r = runOne("AS16", account({}, thin(0.3)));
    expect(findingsOf(r)[0]?.facts.campaigns_under_bar).toBe(3);
  });
  it("is clean when each clears the bar", () => {
    expect(state(runOne("AS16", account({}, thin(2))))).toBe("none_found");
  });
  it("is not checkable with no campaign on conversion bidding", () => {
    expect(state(runOne("AS16", account({}, [{ id: "11", strategy: "MANUAL_CPC" }])))).toBe(
      "not_checkable",
    );
  });
});

describe("AS17 holiday peak not prepared", () => {
  it("fires in September with nothing seasonal", () => {
    expect(state(runOne("AS17", account()))).toBe("fires");
  });
  it("is clean with a seasonal campaign or keyword", () => {
    expect(state(runOne("AS17", account({}, [{ id: "11", name: "Christmas gifts" }])))).toBe(
      "none_found",
    );
    const kw = account({
      data: {
        adGroups: [adGroup({ id: "21", campaignId: "11" })],
        keywords: [
          keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "black friday boots" }),
        ],
      },
    });
    expect(state(runOne("AS17", kw))).toBe("none_found");
  });
  it("is not checkable when campaigns were not read", () => {
    const input = account({ noMarker: ["campaigns"] });
    expect(state(runOne("AS17", { ...input, data: { ...input.data, campaigns: [] } }))).toBe(
      "not_checkable",
    );
  });
});

describe("AS17 needs every place a seasonal set-up could be", () => {
  const status = (input: EvidenceInput) =>
    runChecks(input).checks.find((c) => c.id === "AS17")?.status;
  const read = () =>
    account({
      data: {
        adGroups: [adGroup({ id: "21", campaignId: "11" })],
        keywords: [keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "trail boots" })],
      },
      syncedEmpty: ["adExtensions"],
    });
  it("states it (info) when names, keywords and assets were all read", () => {
    expect(status(read())).toBe("info");
  });
  it("is not run when the assets or the keywords could not be read", () => {
    for (const table of ["ad_extensions", "keywords"]) {
      const input = read();
      const broken = {
        ...input,
        statusRows: (input.statusRows ?? []).map((r) =>
          r.table_name === table ? { ...r, status: "failed" } : r,
        ),
      };
      expect([table, status(broken)]).toEqual([table, "not_run"]);
    }
  });
});
