// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { makeMetricLookups } from "./engine/adapters.js";
import type { CheckResult } from "./engine/checks/types.js";
import { confoundersFor } from "./engine/interactions/matrix.js";
import { DEFAULT_CONFOUNDER_THRESHOLDS } from "./engine/interactions/types.js";
import { runChecks } from "./api.js";
import {
  buildInput,
  campaignRows,
  checkCtxOf,
  dayBefore,
  LAST_DAY,
  runOne,
  type CampaignSpec,
  type FixtureOptions,
} from "./testing/account.js";

const state = (r: CheckResult) => r.state;
const findingsOf = (r: CheckResult) => (r.state === "fires" ? r.findings : []);
const run = (id: string, opts: FixtureOptions) => runOne(id, buildInput(opts));
const one = (spec: Partial<CampaignSpec>, opts: Omit<FixtureOptions, "campaigns"> = {}) =>
  ({ campaigns: [{ id: "11", ...spec }], ...opts }) as FixtureOptions;

describe("BB01 budget utilisation low", () => {
  it("fires when a campaign spends under half its budget", () => {
    const r = run("BB01", one({ budget: 100, cost: 30 }));
    expect(state(r)).toBe("fires");
    expect(findingsOf(r)[0]?.facts.util90).toBeCloseTo(0.3, 2);
  });
  it("is clean when the budget is used", () => {
    expect(state(run("BB01", one({ budget: 100, cost: 90 })))).toBe("none_found");
  });
  it("is not checkable without the daily series", () => {
    const r = run(
      "BB01",
      one(
        { budget: 100, cost: 30 },
        { noMarker: ["campaignDailyMetrics"], data: { campaignDailyMetrics: [] } },
      ),
    );
    expect(state(r)).toBe("not_checkable");
  });
});

describe("BB02 impression share lost to budget", () => {
  it("fires above the bar", () => {
    expect(state(run("BB02", one({ is: { lostBudget: 0.2 } })))).toBe("fires");
  });
  it("is clean under the bar", () => {
    expect(state(run("BB02", one({ is: { lostBudget: 0.05 } })))).toBe("none_found");
  });
  it("is not checkable with no impression share read", () => {
    expect(state(run("BB02", one({})))).toBe("not_checkable");
  });
  it("follows a settings override", () => {
    expect(
      state(
        run(
          "BB02",
          one({ is: { lostBudget: 0.2 } }, { settings: { bidding: { lostIsBudgetPct: 25 } } }),
        ),
      ),
    ).toBe("none_found");
  });
});

describe("BB02 judged on the last 3 weeks, return stated", () => {
  // a new Shopping campaign: 13.13% over 90 days (launch weeks), 0% in each of the last 3 weeks
  const fresh = {
    id: "11",
    name: "Shopping - New product",
    type: "SHOPPING",
    cost: 20.64,
    value: 67.14,
    conv: 0.5,
  };
  it("13% over 90 days but 0% in the last 3 weeks is not a finding", () => {
    const r = run(
      "BB02",
      one({ ...fresh, is: { lostBudget: 0.1313, recent: { lostBudget: 0, cost: 1100 } } }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("still fires when the last 3 weeks lose to budget, judged on them", () => {
    const r = run(
      "BB02",
      one({ ...fresh, is: { lostBudget: 0.1313, recent: { lostBudget: 0.18, cost: 1100 } } }),
    );
    const f = findingsOf(r)[0];
    expect(f?.facts.lost_is_budget_pct).toBeCloseTo(18, 5);
    expect(f?.facts.lost_is_budget_pct_90d).toBeCloseTo(13.13, 5);
    expect(f?.facts.judged_on).toBe("last 3 weeks");
  });
  it("no activity in the last 3 weeks: not limited by its budget now", () => {
    const r = run(
      "BB02",
      one({ ...fresh, is: { lostBudget: 0.2, recent: { lostBudget: null, cost: 0, value: 0 } } }),
    );
    expect(state(r)).toBe("none_found");
    expect(r.state === "none_found" ? r.note : "").toMatch(/no activity in the last 3 weeks/);
  });
  it("recent weeks not read (old snapshot): the 90-day share, and it says so", () => {
    const f = findingsOf(run("BB02", one({ ...fresh, is: { lostBudget: 0.1313 } })))[0];
    expect(f?.facts.judged_on).toMatch(/90 days/);
  });
  it("an article campaign: return per $1 is stated even under 10 sales ($858 / $604 = $1.42)", () => {
    // 90 days: $604.48 spend, $858 sales, 20.5% lost to budget
    const r = run(
      "BB02",
      one({
        name: "Search - Article",
        cost: 604.48 / 90,
        value: 858 / 90,
        conv: 0.05,
        is: { lostBudget: 0.205, recent: { lostBudget: 0.205, cost: 140, value: 200 } },
      }),
    );
    const f = findingsOf(r)[0];
    expect(f?.facts.roas).toBeNull();
    expect(Number(f?.facts.return_per_dollar)).toBeCloseTo(1.42, 2);
  });
  it("a PMax campaign: $0.13 per $1 under the account's $0.72 is stated and never priced", () => {
    const nl = {
      id: "21",
      name: "PMax - Country B",
      type: "PERFORMANCE_MAX",
      cost: 332.41 / 90,
      value: 44.62 / 90,
      conv: 0.2,
      is: { lostBudget: 0.2133, recent: { lostBudget: 0.2133, cost: 110, value: 15 } },
    };
    // the rest of the account: $572.59 spend, $606.38 sales -> $651 on $905 in all
    const rest = { id: "22", name: "Brand - Country B", cost: 572.59 / 90, value: 606.38 / 90 };
    const out = runChecks(buildInput({ campaigns: [nl, rest] }));
    const f = out.findings.find((x) => x.checkId === "BB02");
    expect(Number(f?.facts.return_per_dollar)).toBeCloseTo(0.134, 2);
    expect(Number(f?.facts.account_return_per_dollar)).toBeCloseTo(0.72, 2);
    expect(f?.facts.below_return_bar).toBe(true);
    expect(f?.facts.return_bar_source).toBe("account_average");
    expect(f?.impact.value ?? null).toBeNull();
  });
  it("a campaign above the account's return keeps its money", () => {
    const good = {
      id: "21",
      cost: 50,
      value: 300,
      conv: 1,
      is: { lostBudget: 0.25, recent: { lostBudget: 0.25 } },
    };
    const weak = { id: "22", cost: 50, value: 50, conv: 1 };
    const out = runChecks(buildInput({ campaigns: [good, weak] }));
    const f = out.findings.find((x) => x.checkId === "BB02");
    expect(f?.facts.below_return_bar).toBe(false);
    expect(Number(f?.impact.value)).toBeGreaterThan(0);
  });
});

describe("BB02 bar: the client's target, then break-even, then the account", () => {
  // the campaign returns $2 per $1; the rest of the account $6 per $1 (account ~$4)
  const lost = {
    id: "21",
    name: "Search - Generic",
    cost: 50,
    value: 100,
    conv: 1,
    is: { lostBudget: 0.25, recent: { lostBudget: 0.25 } },
  };
  const rest = { id: "22", name: "Search - Other", cost: 50, value: 300, conv: 3 };
  const bb02 = (clientContext?: FixtureOptions["clientContext"]) =>
    runChecks(
      buildInput({ campaigns: [lost, rest], ...(clientContext ? { clientContext } : {}) }),
    ).findings.find((x) => x.checkId === "BB02");

  it("no target, no margin: below the account's return, no money", () => {
    const f = bb02();
    expect(f?.facts.return_bar_source).toBe("account_average");
    expect(f?.facts.below_return_bar).toBe(true);
    expect(f?.impact.value ?? null).toBeNull();
  });
  it("a declared ROAS target the campaign meets prices it, even below the account", () => {
    const f = bb02({ campaigns: { "21": { source: "owner", target: "ROAS 1.5:1" } } });
    expect(f?.facts.return_bar_source).toBe("client_target");
    expect(f?.facts.return_bar).toBe(1.5);
    expect(f?.facts.below_return_bar).toBe(false);
    expect(Number(f?.impact.value)).toBeGreaterThan(0);
  });
  it("a declared ROAS target the campaign misses gives no money", () => {
    const f = bb02({ campaigns: { "21": { source: "owner", target: "ROAS 3:1" } } });
    expect(f?.facts.below_return_bar).toBe(true);
    expect(f?.impact.value ?? null).toBeNull();
  });
  it("a declared cost-per-sale target is judged on cost per sale", () => {
    // 90 days: $4,500 spend, 90 sales -> $50 per sale
    const ok = bb02({ campaigns: { "21": { source: "owner", target: "CPA $60" } } });
    expect(ok?.facts.declared_target_cpa).toBe(60);
    expect(ok?.facts.below_return_bar).toBe(false);
    expect(Number(ok?.impact.value)).toBeGreaterThan(0);
    const miss = bb02({ campaigns: { "21": { source: "owner", target: "CPA $40" } } });
    expect(miss?.facts.below_return_bar).toBe(true);
    expect(miss?.impact.value ?? null).toBeNull();
  });
  it("no target: break-even from the stated margin decides, not the account", () => {
    // 60% margin -> break-even $1.67 per $1; the campaign's $2 clears it
    const f = bb02({ account: { businessType: "ecommerce", grossMarginPct: "60" } });
    expect(f?.facts.return_bar_source).toBe("break_even_margin");
    expect(Number(f?.facts.return_bar)).toBeCloseTo(1.667, 2);
    expect(Number(f?.impact.value)).toBeGreaterThan(0);
    // 40% margin -> break-even $2.50: below it, no money
    const low = bb02({ account: { businessType: "ecommerce", grossMarginPct: "40" } });
    expect(low?.facts.below_return_bar).toBe(true);
    expect(low?.impact.value ?? null).toBeNull();
  });
  it("an AI-suggested target is not a bar", () => {
    const f = bb02({ campaigns: { "21": { source: "suggested", target: "ROAS 1.5:1" } } });
    expect(f?.facts.return_bar_source).toBe("account_average");
  });
});

describe("BB03 impression share lost to rank", () => {
  it("fires strictly above the bar", () => {
    expect(state(run("BB03", one({ is: { lostRank: 0.4 } })))).toBe("fires");
  });
  it("is clean at or under the bar", () => {
    expect(state(run("BB03", one({ is: { lostRank: 0.3 } })))).toBe("none_found");
  });
  it("is not checkable with no impression share read", () => {
    expect(state(run("BB03", one({})))).toBe("not_checkable");
  });
});

describe("BB04 bid target ahead of the data", () => {
  it("fires on a target ROAS with too few conversions", () => {
    const r = run("BB04", one({ strategy: "TARGET_ROAS", targetRoas: 4, conv: 0.5 }));
    expect(state(r)).toBe("fires");
  });
  it("is clean with enough conversions", () => {
    expect(state(run("BB04", one({ strategy: "TARGET_ROAS", targetRoas: 4, conv: 2 })))).toBe(
      "none_found",
    );
  });
  it("abstains when the business type is unknown", () => {
    const r = run(
      "BB04",
      one(
        { strategy: "TARGET_ROAS", targetRoas: 4, conv: 0.5 },
        { profile: {}, businessType: "unknown" },
      ),
    );
    expect(state(r)).toBe("not_checkable");
  });
  it("is not checkable without the daily series", () => {
    const r = run(
      "BB04",
      one(
        { strategy: "TARGET_ROAS", targetRoas: 4 },
        { noMarker: ["campaignDailyMetrics"], data: { campaignDailyMetrics: [] } },
      ),
    );
    expect(state(r)).toBe("not_checkable");
  });
});

describe("BB04 verdict follows the 90-day result against the target", () => {
  // a Jackets PMax on a 300% target, 29.94 sales in the last 30 days (bar 30) and
  // 101.94 over the 90 days, $100 a day at 333%: the data backs the target so far
  const jackets = (valuePerDay: number, conv30 = 29.94, conv90 = 101.94): FixtureOptions => {
    const spec: CampaignSpec = {
      id: "11",
      name: "PMax - Jackets",
      type: "PERFORMANCE_MAX",
      strategy: "TARGET_ROAS",
      targetRoas: 3,
      cost: 100,
      value: valuePerDay,
    };
    const rows = campaignRows(spec);
    const daily = rows.daily.map((r, i) => ({
      ...r,
      conversions: i < 30 ? conv30 / 30 : (conv90 - conv30) / 60,
    }));
    return {
      campaigns: [spec],
      data: { campaigns: [{ ...rows.campaign, conversions: conv90 }], campaignDailyMetrics: daily },
    };
  };
  it("333% over 90 days against 300%: a note (info), says why", () => {
    const f = findingsOf(run("BB04", jackets(333)))[0];
    expect(f).toBeDefined();
    expect(f?.maxSeverity).toBe("info");
    expect(f?.facts).toMatchObject({ target_roas: 3, conv_bar_30d: 30, target_met_90d: true });
    expect(f?.facts.result_90d).toBeCloseTo(3.33, 2);
    expect(f?.note).toBe(
      "the campaign's last 90 days meet its target (333% return against a 300% target), so the data supports the target so far; only the last 30 days' sales are under the guideline of 30",
    );
  });
  it("250% over 90 days against 300%: the warning stays", () => {
    const f = findingsOf(run("BB04", jackets(250)))[0];
    expect(f).toBeDefined();
    expect(f?.maxSeverity).toBeUndefined();
    expect(f?.facts.target_met_90d).toBeUndefined();
    expect(f?.note).toBeUndefined();
  });
  it("30 sales over 90 days (3 in the last 30) meets the target but is under 3x the bar: the warning stays", () => {
    const f = findingsOf(run("BB04", jackets(333, 3, 30)))[0];
    expect(f).toBeDefined();
    expect(f?.maxSeverity).toBeUndefined();
    expect(f?.facts.target_met_90d).toBeUndefined();
    expect(f?.note).toBeUndefined();
  });
});

describe("a conversion floor not met says so in plain words", () => {
  it("A.roas on 4 conversions: no 'conv 4 < floor 10'", () => {
    const ctx = checkCtxOf(
      buildInput({ campaigns: [{ id: "1", cost: 10, conv: 4 / 90, value: 20, days: 90 }] }),
    );
    const v = ctx.get("A.roas");
    expect(v.value).toBeNull();
    expect("detail" in v && v.detail).toMatch(
      /^only 4(\.0)? conversions, fewer than the \d+ needed to judge it$/,
    );
  });
});

describe("BB05 bid target choking delivery", () => {
  const choking = {
    strategy: "TARGET_ROAS",
    targetRoas: 8,
    budget: 100,
    cost: 30,
    conv: 1,
    value: 60,
  };
  it("fires when the target is far above the realised return and the budget goes unspent", () => {
    expect(state(run("BB05", one(choking)))).toBe("fires");
  });
  it("is clean when the target is near reality", () => {
    expect(state(run("BB05", one({ ...choking, targetRoas: 2.5 })))).toBe("none_found");
  });
  it("is insufficient when the series is too short for both windows", () => {
    expect(state(run("BB05", one({ ...choking, days: 20 })))).toBe("insufficient_data");
  });
  it("is not checkable when no campaign carries a target ROAS", () => {
    const r = run("BB05", one({ strategy: "MAXIMIZE_CONVERSIONS" }));
    expect(state(r)).toBe("not_checkable");
    expect(r.state === "not_checkable" && r.reason).toBe(
      "no campaign has both a target return on ad spend (tROAS) and a budget that could be read",
    );
  });
});

describe("BB06 ready for a bid target", () => {
  it("fires on a non-brand campaign with volume and no target", () => {
    expect(state(run("BB06", one({ strategy: "MAXIMIZE_CONVERSION_VALUE", conv: 2 })))).toBe(
      "fires",
    );
  });
  it("is clean below the conversion bar", () => {
    expect(state(run("BB06", one({ strategy: "MAXIMIZE_CONVERSION_VALUE", conv: 0.5 })))).toBe(
      "none_found",
    );
  });
  it("is not checkable without the daily series", () => {
    expect(
      state(
        run(
          "BB06",
          one({}, { noMarker: ["campaignDailyMetrics"], data: { campaignDailyMetrics: [] } }),
        ),
      ),
    ).toBe("not_checkable");
  });
});

describe("BB07 profitable and budget-starved", () => {
  const starved = { budget: 100, cost: 100, is: { lostBudget: 0.2 } };
  it("fires against the account average", () => {
    const r = run("BB07", one(starved));
    expect(state(r)).toBe("fires");
    expect(findingsOf(r)[0]?.facts.target_source).toBe("account_average");
  });
  it("is clean when the budget is not the limit", () => {
    expect(state(run("BB07", one({ ...starved, cost: 50 })))).toBe("none_found");
  });
  it("is not checkable with no impression share read", () => {
    expect(state(run("BB07", one({ budget: 100, cost: 100 })))).toBe("not_checkable");
  });
  it("judges the last 3 weeks, as BB02: a launch-week limit is not a limit now", () => {
    const recent = (lostBudget: number | null, cost = 700) => ({
      ...starved,
      is: { lostBudget: 0.2, recent: { lostBudget, cost } },
    });
    expect(state(run("BB07", one(recent(0))))).toBe("none_found");
    expect(state(run("BB07", one(recent(null, 0))))).toBe("none_found");
    const r = run("BB07", one(recent(0.3)));
    expect(findingsOf(r)[0]?.facts.lost_is_budget_pct).toBeCloseTo(30, 5);
  });
});

describe("BB08 portfolio bidding strategies", () => {
  it("is clean when no strategy has an attached campaign we cannot see", () => {
    expect(state(run("BB08", one({}, { syncedEmpty: ["biddingStrategies"] })))).toBe("none_found");
  });
  it("is clean and names the campaign when the link is held", () => {
    const r = run(
      "BB08",
      one(
        {
          extra: {
            bidding_strategy_resource: "customers/1/biddingStrategies/77",
            bidding_strategy_source: "portfolio",
          },
        },
        {
          data: {
            biddingStrategies: [
              {
                strategy_id: "77",
                name: "Shared ROAS",
                type: "TARGET_ROAS",
                non_removed_campaign_count: 1,
              },
            ],
          },
        },
      ),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when Google counts an attached campaign the data does not link", () => {
    const r = run(
      "BB08",
      one(
        { extra: { bidding_strategy_source: null } },
        {
          data: {
            biddingStrategies: [
              {
                strategy_id: "77",
                name: "Shared ROAS",
                type: "TARGET_ROAS",
                non_removed_campaign_count: 2,
              },
            ],
          },
        },
      ),
    );
    expect(state(r)).toBe("not_checkable");
  });
  it("is not checkable when the strategies were not read", () => {
    expect(state(run("BB08", one({})))).toBe("not_checkable");
  });
});

describe("BB09 bid adjustment against the slice", () => {
  const devices = (mobileConv: number) => [
    {
      campaign_id: "11",
      device: "MOBILE",
      cost: 4500,
      clicks: 2000,
      conversions: mobileConv,
      conversion_value: mobileConv * 200,
      impressions: 40000,
    },
    {
      campaign_id: "11",
      device: "DESKTOP",
      cost: 4500,
      clicks: 2500,
      conversions: 180 - mobileConv,
      conversion_value: (180 - mobileConv) * 200,
      impressions: 50000,
    },
  ];
  const modifier = {
    campaign_id: "11",
    criterion_id: "30001",
    bid_modifier: 1.5,
    modifier_source: "DEVICE",
    criterion_key: "MOBILE",
  };
  it("fires when a raised bid sits on a slice that returns much less", () => {
    const r = run(
      "BB09",
      one(
        { strategy: "MANUAL_CPC" },
        { data: { deviceData: devices(20), bidModifiers: [modifier] } },
      ),
    );
    expect(state(r)).toBe("fires");
  });
  it("is clean when the raised slice returns as well as the campaign", () => {
    const r = run(
      "BB09",
      one(
        { strategy: "MANUAL_CPC" },
        { data: { deviceData: devices(90), bidModifiers: [modifier] } },
      ),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable on Smart Bidding, which ignores the adjustment", () => {
    const r = run(
      "BB09",
      one(
        { strategy: "TARGET_ROAS", targetRoas: 3 },
        { data: { deviceData: devices(20), bidModifiers: [modifier] } },
      ),
    );
    expect(state(r)).toBe("not_checkable");
  });
  it("is not checkable when the modifiers were not read", () => {
    expect(state(run("BB09", one({ strategy: "MANUAL_CPC" })))).toBe("not_checkable");
  });
});

describe("BB10 target simulation available", () => {
  it("fires when a simulation has points", () => {
    const r = run(
      "BB10",
      one(
        {},
        {
          data: {
            simulations: [
              {
                resource_name: "customers/1/campaigns/11/simulations/1",
                simulation_type: "TARGET_ROAS",
                points_json: [{}, {}],
              },
            ],
          },
        },
      ),
    );
    expect(state(r)).toBe("fires");
  });
  it("is clean when the read found none", () => {
    expect(state(run("BB10", one({}, { syncedEmpty: ["simulations"] })))).toBe("none_found");
  });
  it("is not checkable when simulations were not read", () => {
    expect(state(run("BB10", one({})))).toBe("not_checkable");
  });
});

describe("BB11 seasonality adjustment", () => {
  it("fires when an override covers the campaign", () => {
    expect(
      state(
        run(
          "BB11",
          one(
            {},
            {
              data: {
                biddingOverrides: [{ campaign_id: "11", override_type: "SEASONALITY_ADJUSTMENT" }],
              },
            },
          ),
        ),
      ),
    ).toBe("fires");
  });
  it("is clean when the read found none", () => {
    expect(state(run("BB11", one({}, { syncedEmpty: ["biddingOverrides"] })))).toBe("none_found");
  });
  it("is not checkable when overrides were not read", () => {
    expect(state(run("BB11", one({})))).toBe("not_checkable");
  });
});

describe("BB14 count bidding while value is tracked", () => {
  it("fires on Maximize conversions with recorded value", () => {
    expect(state(run("BB14", one({ strategy: "MAXIMIZE_CONVERSIONS" })))).toBe("fires");
  });
  it("is clean on value bidding", () => {
    expect(state(run("BB14", one({ strategy: "MAXIMIZE_CONVERSION_VALUE" })))).toBe("none_found");
  });
  it("abstains on a lead-gen account", () => {
    expect(
      state(
        run(
          "BB14",
          one({ strategy: "MAXIMIZE_CONVERSIONS" }, { profile: { businessType: "lead_gen" } }),
        ),
      ),
    ).toBe("not_checkable");
  });
  it("is not checkable when no campaign carries a strategy", () => {
    expect(state(run("BB14", one({ strategy: null })))).toBe("not_checkable");
  });
  it("fires with the 30-day count on the row (the default fixture: 60 in 30 days)", () => {
    const f = findingsOf(run("BB14", one({ strategy: "MAXIMIZE_CONVERSIONS" })))[0];
    expect(f?.facts.conversions_30d).toBe(60);
    expect(f?.rows?.[0]?.cells.conv_30d).toBe(60);
  });
  it("under Google's value-bidding minimum (9 in 30 days): a Note of its own, never clean", () => {
    const r = run(
      "BB14",
      one({ name: "Demand Gen - Retargeting", strategy: "MAXIMIZE_CONVERSIONS", conv: 0.3 }),
    );
    expect(state(r)).toBe("fires");
    const f = findingsOf(r)[0];
    expect(f?.maxSeverity).toBe("info");
    expect(f?.facts.below_value_minimum).toBe("yes");
    expect(f?.facts.value_bidding_min_30d).toBe(30);
    expect(f?.facts.conversions_30d).toBe(9);
    expect(f?.note).toMatch(
      /keep the current bidding until it has enough sales; no change is offered/,
    );
  });
  it("the report: the 9-sale campaign is a Note finding with no money, never clean", () => {
    const out = runChecks(
      buildInput({
        campaigns: [
          {
            id: "11",
            name: "Demand Gen - Retargeting",
            type: "DEMAND_GEN",
            strategy: "MAXIMIZE_CONVERSIONS",
            conv: 0.3,
          },
        ],
      }),
    );
    const outcome = out.checks.find((c) => c.id === "BB14");
    expect(outcome?.status).toBe("finding");
    const f = out.findings.find((x) => x.checkId === "BB14");
    expect(f?.severity.severity).toBe("info");
    expect(Number(f?.impact.value ?? 0)).toBe(0);
    expect(f?.remediation).toBeUndefined();
  });
  it("no 30-day series: not_checkable, never clean", () => {
    // a value-bidding campaign carries the daily table; the count-bidding one has no rows in it
    const r = run("BB14", {
      campaigns: [
        { id: "21", strategy: "MAXIMIZE_CONVERSION_VALUE" },
        {
          id: "22",
          strategy: "MAXIMIZE_CONVERSIONS",
          days: 0,
          extra: { cost: 9000, conversions: 180, conversion_value: 36000 },
        },
      ],
    });
    expect(state(r)).toBe("not_checkable");
    expect(r.state === "not_checkable" ? r.reason : "").toMatch(
      /no 30-day conversion series for 1 /,
    );
  });
  it("at the minimum it fires as a normal finding; the minimum follows settings.bidding.targetRoasMinConv30d", () => {
    const at = findingsOf(run("BB14", one({ strategy: "MAXIMIZE_CONVERSIONS", conv: 1 })))[0];
    expect(at?.maxSeverity).toBeUndefined();
    expect(at?.facts.below_value_minimum).toBeUndefined();
    const raised = findingsOf(
      run(
        "BB14",
        one(
          { strategy: "MAXIMIZE_CONVERSIONS", conv: 1 },
          { settings: { bidding: { targetRoasMinConv30d: 31 } } },
        ),
      ),
    )[0];
    expect(raised?.maxSeverity).toBe("info");
    expect(raised?.facts.below_value_minimum).toBe("yes");
  });
});

describe("BB15 brand CPC above the band", () => {
  const generic: CampaignSpec = { id: "11", name: "Generic search", cost: 100, clicks: 100 };
  const brand = (cost: number, clicks: number): CampaignSpec => ({
    id: "12",
    name: "Brand search",
    cost,
    clicks,
  });
  it("fires when brand clicks cost far more than the band", () => {
    expect(state(run("BB15", { campaigns: [generic, brand(30, 20)] }))).toBe("fires");
  });
  it("is clean when brand clicks are cheap", () => {
    expect(state(run("BB15", { campaigns: [generic, brand(6, 20)] }))).toBe("none_found");
  });
  it("is insufficient with too few non-brand clicks for a reference", () => {
    expect(
      state(run("BB15", { campaigns: [{ ...generic, clicks: 1, days: 30 }, brand(30, 20)] })),
    ).toBe("insufficient_data");
  });
  it("is not checkable without a live brand campaign", () => {
    expect(state(run("BB15", { campaigns: [generic] }))).toBe("not_checkable");
  });
  it("B19 / Phase F: the spend above the band is money at risk a month (a live shop: $953.78 -> $317.93)", () => {
    const r = runChecks(buildInput({ campaigns: [generic, brand(30, 20)] }));
    const f = r.findings.find((c) => c.checkId === "BB15");
    const above = Number(f?.facts.spend_above_bar_90d);
    expect(above).toBeGreaterThan(0);
    expect(f?.facts.at_risk_cost_90d).toBe(above);
    expect(f?.impact.formulaId).toBe("IMP_STRUCTURAL");
    expect(f?.impact.kind).toBe("at_risk");
    expect(f?.impact.value).toBeCloseTo(above / 3, 2);
    // a rule-of-thumb band never reaches critical
    const raw = run("BB15", { campaigns: [generic, brand(30, 20)] });
    expect(raw.state === "fires" ? raw.findings[0]?.maxSeverity : null).toBe("warning");
    expect(f?.severity.severity).not.toBe("critical");
  });
});

describe("BB16 loose target on a budget-limited campaign", () => {
  const loose = {
    strategy: "TARGET_ROAS",
    targetRoas: 2,
    conv: 2,
    value: 400,
    cost: 100,
    is: { lostBudget: 0.2 },
  };
  const read = { syncedEmpty: ["changeHistory" as const] };
  const targetChange = (daysAgo: number) => ({
    change_resource_name: "customers/1/campaigns/11",
    change_date_time: `${dayBefore(LAST_DAY, daysAgo)} 10:00:00`,
    changed_fields: "maximize_conversion_value.target_roas",
    changed_values: { "maximizeConversionValue.targetRoas": { old: 1.5, new: 2 } },
    operation: "UPDATE",
    client_type: "GOOGLE_ADS_WEB_CLIENT",
    resource_type: "CAMPAIGN",
  });
  it("fires when results beat the target by the margin", () => {
    expect(state(run("BB16", one(loose, read)))).toBe("fires");
  });
  it("budget-limited is judged on the last 3 weeks when read", () => {
    const now = (lostBudget: number | null, cost = 700) => ({
      ...loose,
      is: { lostBudget: 0.2, recent: { lostBudget, cost } },
    });
    expect(state(run("BB16", one(now(0), read)))).toBe("none_found");
    expect(state(run("BB16", one(now(null, 0), read)))).toBe("none_found");
    expect(state(run("BB16", one(now(0.25), read)))).toBe("fires");
  });
  it("is clean when the target matches the results", () => {
    expect(state(run("BB16", one({ ...loose, targetRoas: 4 }, read)))).toBe("none_found");
  });
  it("is not checkable when the change history was not read", () => {
    expect(state(run("BB16", one(loose)))).toBe("not_checkable");
  });
  it("is never clean when every loose campaign changed its target recently", () => {
    const r = run("BB16", one(loose, { data: { changeHistory: [targetChange(5)] } }));
    expect(state(r)).toBe("insufficient_data");
    expect(r.state === "insufficient_data" && r.reason).toMatch(/changed in the last 28 days/);
  });
  it("an ad group's own target change does not hold the campaign back (CAMPAIGN rows only)", () => {
    const agChange = {
      ...targetChange(5),
      change_resource_name: "customers/1/adGroups/501",
      changed_fields: "targetRoas",
      changed_values: { targetRoas: { old: 1.5, new: 2 } },
      resource_type: "AD_GROUP",
      campaign_id: "11",
      ad_group_id: "501",
    };
    expect(state(run("BB16", one(loose, { data: { changeHistory: [agChange] } })))).toBe("fires");
  });
  it("a strategy switch naming only the new strategy holds the campaign back", () => {
    const sw = {
      ...targetChange(5),
      changed_fields: "maximizeConversionValue",
      changed_values: { maximizeConversionValue: { old: null, new: {} } },
    };
    expect(state(run("BB16", one(loose, { data: { changeHistory: [sw] } })))).toBe(
      "insufficient_data",
    );
  });
  it("judges a campaign whose target change is older than the window", () => {
    expect(state(run("BB16", one(loose, { data: { changeHistory: [targetChange(45)] } })))).toBe(
      "fires",
    );
  });
  it("needs 15 conversions in 30 days: exactly 15 fires, just under does not", () => {
    expect(state(run("BB16", one({ ...loose, conv: 0.5 }, read)))).toBe("fires");
    expect(state(run("BB16", one({ ...loose, conv: 0.49 }, read)))).toBe("none_found");
  });
  it("is not checkable when the window ends before the configured start date", () => {
    expect(
      state(
        run(
          "BB16",
          one(loose, { ...read, settings: { bidding: { looseTargetFromDate: "2027-01-01" } } }),
        ),
      ),
    ).toBe("not_checkable");
  });
  it("is not checkable when no campaign has a target", () => {
    expect(state(run("BB16", one({ strategy: "MAXIMIZE_CONVERSION_VALUE" }, read)))).toBe(
      "not_checkable",
    );
  });
});

describe("BB16 / BB17 never judge past the change history they were given", () => {
  const loose = {
    strategy: "TARGET_ROAS",
    targetRoas: 2,
    conv: 2,
    value: 400,
    cost: 100,
    is: { lostBudget: 0.2 },
  };
  const change = (daysAgo: number) => ({
    change_resource_name: "customers/1/campaigns/11",
    change_date_time: `${dayBefore(LAST_DAY, daysAgo)} 10:00:00`,
    changed_fields: "maximize_conversion_value.target_roas",
    changed_values: { "maximizeConversionValue.targetRoas": { old: 1.5, new: 2 } },
    operation: "UPDATE",
    client_type: "GOOGLE_ADS_WEB_CLIENT",
    resource_type: "CAMPAIGN",
  });
  // the snapshot's 28 days: window ends 09-01, history from 08-05
  const withCoverage = (startDate: string, settings?: FixtureOptions["settings"]) => ({
    ...buildInput(
      one(loose, { syncedEmpty: ["changeHistory"], ...(settings ? { settings } : {}) }),
    ),
    changeHistoryCoverage: { startDate, endDate: "2026-09-02" },
  });
  it("the default 28-day lookback fits the 28 days the snapshot reads", () => {
    expect(runChecks(withCoverage("2026-08-05")).checks.find((c) => c.id === "BB16")?.status).toBe(
      "finding",
    );
  });
  it("a change history that starts later than the lookback: not run, never judged", () => {
    const o = runChecks(withCoverage("2026-08-10")).checks.find((c) => c.id === "BB16");
    expect(o?.status).toBe("not_run");
    expect(o?.reason).toMatch(/change history covers only 23 days/);
  });
  it("a longer lookback in the settings than the history covers: not run (the 08-03 probe)", () => {
    // a target change on 08-03 is before the history starts: unknown, so BB16 must not judge
    const input = withCoverage("2026-08-05", { bidding: { recentTargetChangeDays: 30 } });
    const o = runChecks(input).checks.find((c) => c.id === "BB16");
    expect(o?.status).toBe("not_run");
    expect(o?.reason).toMatch(/looks back 30 days/);
  });
  it("BB17: a re-learning window longer than the history: not run", () => {
    const base = buildInput(
      one({ strategy: "TARGET_ROAS", targetRoas: 4 }, { data: { changeHistory: [change(5)] } }),
    );
    const ok = runChecks({
      ...base,
      changeHistoryCoverage: { startDate: "2026-08-05", endDate: "2026-09-02" },
    });
    // a re-learning window is a note: `info`, never a finding
    expect(ok.checks.find((c) => c.id === "BB17")?.status).toBe("info");
    const short = runChecks({
      ...base,
      changeHistoryCoverage: { startDate: "2026-08-25", endDate: "2026-09-02" },
    });
    expect(short.checks.find((c) => c.id === "BB17")?.status).toBe("not_run");
  });
  it("BB17: an ad group's own target is not a campaign re-learn; a strategy switch is", () => {
    const coverage = { startDate: "2026-08-05", endDate: "2026-09-02" };
    const smart = { strategy: "TARGET_ROAS", targetRoas: 4 };
    const agChange = {
      ...change(5),
      change_resource_name: "customers/1/adGroups/501",
      changed_fields: "targetRoas",
      changed_values: { targetRoas: { old: 3, new: 4 } },
      resource_type: "AD_GROUP",
      campaign_id: "11",
      ad_group_id: "501",
    };
    const ag = runChecks({
      ...buildInput(one(smart, { data: { changeHistory: [agChange] } })),
      changeHistoryCoverage: coverage,
    });
    expect(ag.checks.find((c) => c.id === "BB17")?.status).not.toBe("info");
    // judged (values were read): not "insufficient data"
    const agOne = runOne("BB17", buildInput(one(smart, { data: { changeHistory: [agChange] } })));
    expect(agOne.state).toBe("none_found");
    const sw = {
      ...change(5),
      changed_fields: "targetRoas",
      changed_values: { targetRoas: { old: null, new: { targetRoas: 4 } } },
    };
    const switched = runChecks({
      ...buildInput(one(smart, { data: { changeHistory: [sw] } })),
      changeHistoryCoverage: coverage,
    });
    expect(switched.checks.find((c) => c.id === "BB17")?.status).toBe("info");
    const r = runOne("BB17", buildInput(one(smart, { data: { changeHistory: [sw] } })));
    expect(findingsOf(r)[0]?.facts.what_changed).toBe("bid strategy");
  });
  it("a malformed coverage is an input error", () => {
    expect(
      runChecks({
        ...withCoverage("2026-08-05"),
        changeHistoryCoverage: { startDate: "x", endDate: "y" },
      }).errors.join(" "),
    ).toMatch(/changeHistoryCoverage/);
  });
});

describe("BB09 with location and schedule adjustments", () => {
  const devices = [
    {
      campaign_id: "11",
      device: "DESKTOP",
      cost: 4500,
      clicks: 2500,
      conversions: 90,
      conversion_value: 18000,
      impressions: 50000,
    },
    {
      campaign_id: "11",
      device: "MOBILE",
      cost: 4500,
      clicks: 2000,
      conversions: 90,
      conversion_value: 18000,
      impressions: 40000,
    },
  ];
  const mods = [
    {
      campaign_id: "11",
      criterion_id: "30000",
      bid_modifier: 1.1,
      modifier_source: "DEVICE",
      criterion_key: "DESKTOP",
    },
    {
      campaign_id: "11",
      criterion_id: "1023191",
      bid_modifier: 1.5,
      modifier_source: "LOCATION",
      criterion_key: "geoTargetConstants/1023191",
    },
  ];
  const geo = (conv: number) => [
    {
      campaign_id: "11",
      location_id: "1023191",
      location_type: "TARGETED",
      cost: 3000,
      clicks: 1500,
      conversions: conv,
      conversion_value: conv * 200,
      impressions: 30000,
    },
  ];
  it("the reviewer's probe: DESKTOP +10% and LOCATION +50% with location performance not read -> not clean", () => {
    const o = runChecks(
      buildInput(
        one({ strategy: "MANUAL_CPC" }, { data: { deviceData: devices, bidModifiers: mods } }),
      ),
    ).checks.find((c) => c.id === "BB09");
    expect(o?.status).toBe("not_run");
    // the reason names the kind that was not judged
    expect(o?.reason).toMatch(/^location adjustments could not be judged/);
  });
  it("judged once the location performance was read: clean when it matches, a finding when it does not", () => {
    const run = (conv: number) =>
      runChecks(
        buildInput(
          one(
            { strategy: "MANUAL_CPC" },
            { data: { deviceData: devices, bidModifiers: mods, geographicData: geo(conv) } },
          ),
        ),
      ).checks.find((c) => c.id === "BB09")?.status;
    expect(run(60)).toBe("clean");
    expect(run(5)).toBe("finding");
  });
  it("a location adjustment on a paused campaign does not make location performance a need", () => {
    const [device, location] = mods as [(typeof mods)[number], (typeof mods)[number]];
    const pausedMods = [device, { ...location, campaign_id: "12" }];
    const o = runChecks(
      buildInput({
        campaigns: [
          { id: "11", strategy: "MANUAL_CPC" },
          { id: "12", strategy: "MANUAL_CPC", status: "PAUSED", cost: 0 },
        ],
        data: { deviceData: devices, bidModifiers: pausedMods },
      }),
    ).checks.find((c) => c.id === "BB09");
    expect(o?.status).toBe("clean");
  });
  it("location performance read but failed -> not clean", () => {
    const input = buildInput(
      one(
        { strategy: "MANUAL_CPC" },
        { data: { deviceData: devices, bidModifiers: mods, geographicData: geo(60) } },
      ),
    );
    const statusRows = (input.statusRows ?? []).map((r) =>
      r.table_name === "geographic_data" ? { ...r, status: "failed" } : r,
    );
    expect(runChecks({ ...input, statusRows }).checks.find((c) => c.id === "BB09")?.status).toBe(
      "not_run",
    );
  });
  it("a schedule adjustment without the day x hour grid -> not clean; with it, judged", () => {
    const sched = [
      ...mods.slice(0, 1),
      {
        campaign_id: "11",
        criterion_id: "40001",
        bid_modifier: 1.3,
        modifier_source: "AD_SCHEDULE",
        criterion_key: "MONDAY 9:00-17:00",
      },
    ];
    const base = buildInput(
      one({ strategy: "MANUAL_CPC" }, { data: { deviceData: devices, bidModifiers: sched } }),
    );
    const noGrid = runChecks(base).checks.find((c) => c.id === "BB09");
    expect(noGrid?.status).toBe("not_run");
    expect(noGrid?.reason).toMatch(/^ad schedule adjustments could not be judged/);
    const grid = Array.from({ length: 8 }, (_, i) => ({
      campaign_id: "11",
      day_of_week: "MONDAY",
      hour_of_day: 9 + i,
      cost: 400,
      clicks: 200,
      conversions: 8,
      conversion_value: 1600,
      impressions: 4000,
    }));
    const withGrid = {
      ...base,
      tables: { temporal_grid: grid },
      statusRows: [
        ...(base.statusRows ?? []),
        { table_name: "temporal_grid", status: "ok", row_count: grid.length, error_message: null },
      ],
    };
    expect(runChecks(withGrid).checks.find((c) => c.id === "BB09")?.status).toBe("clean");
  });
});

describe("campaigns on a shared (portfolio) strategy: changes Google does not record", () => {
  // the reviewer's probe: campaign 11 on portfolio 501 (tROAS 3 -> 2 three days before the
  // window end). v26 change_event has no bidding strategy resource type, so that change is
  // not in the history: BB16 must hold 11 back, BB17 must not call it settled.
  const onPortfolio = {
    strategy: "TARGET_ROAS",
    targetRoas: 2,
    conv: 2,
    value: 400,
    cost: 100,
    is: { lostBudget: 0.2 },
    extra: {
      bidding_strategy_resource: "customers/1/biddingStrategies/501",
      bidding_strategy_source: "portfolio",
    },
  };
  const read = { syncedEmpty: ["changeHistory" as const] };
  it("BB16 holds it back (never 'loose target'): not checkable, naming the shared strategy", () => {
    const r = run("BB16", one(onPortfolio, read));
    expect(state(r)).toBe("not_checkable");
    expect(r.state === "not_checkable" && r.reason).toMatch(/shared \(portfolio\) strategy/);
  });
  it("BB16 mixed: 11 shared and loose-looking, 13 judged not loose -> not checkable, never clean", () => {
    const r = run("BB16", {
      campaigns: [
        { id: "11", ...onPortfolio },
        { ...onPortfolio, id: "13", targetRoas: 4, extra: {} },
      ],
      ...read,
    });
    expect(state(r)).toBe("not_checkable");
    expect(
      runChecks(
        buildInput({
          campaigns: [
            { id: "11", ...onPortfolio },
            { ...onPortfolio, id: "13", targetRoas: 4, extra: {} },
          ],
          ...read,
        }),
      ).checks.find((c) => c.id === "BB16")?.status,
    ).toBe("not_run");
  });
  it("BB16 mixed with a finding: the held-back campaign stays a stated limit", () => {
    const r = run("BB16", {
      campaigns: [
        { id: "11", ...onPortfolio },
        { ...onPortfolio, id: "13", extra: {} },
      ],
      ...read,
    });
    expect(state(r)).toBe("fires");
    const f = findingsOf(r);
    expect(f.map((x) => x.scope.id)).toEqual(["13"]);
    expect(f[0]?.limitedBy?.join(" ")).toMatch(
      /shared \(portfolio\) strategy.*Generic campaign 11/,
    );
  });
  it("BB17 does not call it settled: not checkable, naming the shared strategy", () => {
    const r = run("BB17", one(onPortfolio, { data: { changeHistory: [otherChange] } }));
    expect(state(r)).toBe("not_checkable");
    expect(r.state === "not_checkable" && r.reason).toMatch(/shared \(portfolio\) strategy/);
  });
  it("the same campaign on its own strategy is judged as before", () => {
    const own = { ...onPortfolio, extra: {} };
    expect(state(run("BB16", one(own, read)))).toBe("fires");
    expect(state(run("BB17", one(own, { data: { changeHistory: [otherChange] } })))).toBe(
      "none_found",
    );
  });
});

const otherChange = {
  change_resource_name: "customers/1/campaigns/99",
  change_date_time: `${dayBefore(LAST_DAY, 3)} 10:00:00`,
  changed_fields: "maximize_conversion_value.target_roas",
  changed_values: { "maximizeConversionValue.targetRoas": { old: 3, new: 2 } },
  operation: "UPDATE",
  client_type: "GOOGLE_ADS_WEB_CLIENT",
  resource_type: "CAMPAIGN",
};

describe("BB10 joins a simulation to its campaign by the whole id", () => {
  it("campaigns/1 is not campaigns/11", () => {
    const sim = (cid: string) => ({
      resource_name: `customers/1/campaigns/${cid}/simulations/TARGET_ROAS~UNIFORM`,
      simulation_type: "TARGET_ROAS",
      points_json: [{}, {}],
    });
    const r = run("BB10", {
      campaigns: [{ id: "1" }, { id: "11" }],
      data: { simulations: [sim("11")] },
    });
    expect(findingsOf(r).map((f) => f.scope.id)).toEqual(["11"]);
  });
});

describe("BB07 confounder: is there impression share to buy?", () => {
  const resolve = (lostBudget: number) => {
    const ctx = checkCtxOf(
      buildInput({ campaigns: [{ id: "11", budget: 100, cost: 100, is: { lostBudget } }] }),
    );
    const scale = confoundersFor("BB07").find((c) => c.id === "BB07:BB02@scale");
    if (!scale) throw new Error("BB07 has no BB02@scale resolver");
    return scale.resolve({
      model: ctx.model,
      metrics: makeMetricLookups(ctx.metrics).forInteractions,
      scope: { kind: "campaign", id: "11", scope: "campaign" },
      thresholds: DEFAULT_CONFOUNDER_THRESHOLDS,
    });
  };
  it("clears at 20% lost to budget (a fraction 0.2 is read as 20%)", () => {
    expect(resolve(0.2).state).toBe("cleared");
  });
  it("explains (drops the scale finding) at 3% lost to budget", () => {
    expect(resolve(0.03).state).toBe("explains");
  });
});

describe("BB17 Smart Bidding re-learning after a change", () => {
  const change = (daysAgo: number) => ({
    change_resource_name: "customers/1/campaigns/11",
    change_date_time: `${dayBefore(LAST_DAY, daysAgo)} 10:00:00`,
    changed_fields: "maximize_conversion_value.target_roas",
    changed_values: { "maximizeConversionValue.targetRoas": { old: 3, new: 4 } },
    operation: "UPDATE",
    client_type: "GOOGLE_ADS_WEB_CLIENT",
    resource_type: "CAMPAIGN",
  });
  it("fires when the target changed in the last two weeks", () => {
    expect(
      state(
        run(
          "BB17",
          one({ strategy: "TARGET_ROAS", targetRoas: 4 }, { data: { changeHistory: [change(5)] } }),
        ),
      ),
    ).toBe("fires");
  });
  it("is clean when the change is older", () => {
    expect(
      state(
        run(
          "BB17",
          one(
            { strategy: "TARGET_ROAS", targetRoas: 4 },
            { data: { changeHistory: [change(40)] } },
          ),
        ),
      ),
    ).toBe("none_found");
  });
  it("is insufficient when the history carries no old / new values", () => {
    const { changed_values: _drop, ...noValues } = change(5);
    void _drop;
    expect(
      state(
        run(
          "BB17",
          one({ strategy: "TARGET_ROAS", targetRoas: 4 }, { data: { changeHistory: [noValues] } }),
        ),
      ),
    ).toBe("insufficient_data");
  });
  it("is not checkable when the change history was not read", () => {
    expect(state(run("BB17", one({ strategy: "TARGET_ROAS", targetRoas: 4 })))).toBe(
      "not_checkable",
    );
  });
});

describe("BB03 confounder: rank, not budget, uses settings.bidding.lostIsRankPct", () => {
  const resolve = (lostRank: number, lostIsRankPct: number) => {
    const ctx = checkCtxOf(buildInput({ campaigns: [{ id: "11", is: { lostRank } }] }));
    const rank = confoundersFor("SK02").find((c) => c.confounderId === "BB03");
    if (!rank) throw new Error("SK02 has no BB03 resolver");
    return rank.resolve({
      model: ctx.model,
      metrics: makeMetricLookups(ctx.metrics).forInteractions,
      scope: { kind: "campaign", id: "11", scope: "campaign" },
      thresholds: { ...DEFAULT_CONFOUNDER_THRESHOLDS, lostIsRankPct },
    });
  };
  it("35% lost to rank explains at the default 30% bar", () => {
    expect(resolve(0.35, 30).state).toBe("explains");
  });
  it("35% lost to rank clears when the bar is raised to 40%", () => {
    expect(resolve(0.35, 40).state).toBe("cleared");
  });
  it("the run passes the setting through", () => {
    const ctx = checkCtxOf(
      buildInput({ campaigns: [{ id: "11" }], settings: { bidding: { lostIsRankPct: 40 } } }),
    );
    expect(ctx.settings.bidding.lostIsRankPct).toBe(40);
  });
});
