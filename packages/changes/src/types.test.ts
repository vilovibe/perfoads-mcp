// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { afterEach, describe, expect, it } from "vitest";
import { ChangeError } from "./errors.js";
import { VALUE_BIDDING_MIN_CONV_30D } from "./index.js";
import { switchesIntoValueBidding } from "./types/updateBidding.js";
import { fakeWorld, type FakeWorld, must } from "./testing/index.js";
import { AGENT, budgetChange, makeRig, type Rig } from "./testing/setup.js";

let rig: Rig | undefined;
afterEach(() => {
  rig?.close();
  rig = undefined;
});

const PAT = { actor: "Pat", via: "cli" } as const;

const errOf = async (p: Promise<unknown>): Promise<ChangeError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChangeError) return e;
    throw e;
  }
  throw new Error("expected a ChangeError");
};

const sentOps = (r: Rig): unknown => {
  const v = r.calls.filter((c) => c.url.endsWith(":mutate")).at(-1);
  return (v?.body as { mutateOperations?: unknown }).mutateOperations;
};

const applyAll = async (r: Rig, req: Parameters<Rig["engine"]["propose"]>[0]) => {
  const c = await r.engine.propose(req);
  r.engine.markApproved(c.id, c.version, "cli", "Pat");
  return r.engine.apply(c.id, PAT);
};

const req = (type: string, input: Record<string, unknown>) => ({
  customerId: "1234567890",
  type,
  input,
  ...AGENT,
});

describe("update_budget", () => {
  it("a shared budget lists every campaign on it and says all of them change", async () => {
    const world = fakeWorld();
    must(world.budgets["222"]).explicitlyShared = true;
    world.campaigns["334"] = {
      ...must(world.campaigns["333"]),
      id: "334",
      name: "Search boots",
      status: "ENABLED",
    };
    world.campaigns["335"] = {
      ...must(world.campaigns["333"]),
      id: "335",
      name: "Old",
      status: "REMOVED",
    };
    rig = makeRig({ world });
    const c = await rig.engine.propose(budgetChange("15"));
    expect(c.affected.map((a) => `${a.kind}:${a.id}`)).toEqual([
      "campaign_budget:222",
      "campaign:333",
      "campaign:334",
    ]);
    expect(c.diff).toContain("This budget is shared: the change applies to all 2 campaigns on it.");
    expect(c.facts.affectedCampaignIds).toEqual(["333", "334"]);
    expect(c.facts.budgetChanges).toEqual([
      { budgetId: "222", beforeMicros: "10000000", afterMicros: "15000000", shared: true },
    ]);
  });

  it("can be given the campaign instead of the budget", async () => {
    rig = makeRig();
    const c = await rig.engine.propose(
      req("update_budget", { campaign_id: "333", daily_amount: 8 }),
    );
    expect(c.diff[0]).toBe("Daily budget 222: 10.00 EUR -> 8.00 EUR a day (-20%).");
    expect(c.payload).toEqual({ campaign_id: "333", daily_amount: "8" });
  });

  it("rounds to the currency's smallest unit: EUR cents, JPY whole yen, IDR whole rupiah past the JS number limit", async () => {
    rig = makeRig();
    const eur = await rig.engine.propose(budgetChange("12.345"));
    expect(eur.diff[0]).toBe("Daily budget 222: 10.00 EUR -> 12.35 EUR a day (+23.5%).");
    expect(eur.diff[1]).toMatch(/rounded to 12.35 EUR .*0.01 EUR/);
    rig.close();

    const jpy: FakeWorld = fakeWorld({ currencyCode: "JPY" });
    must(jpy.budgets["222"]).amountMicros = "100000000";
    rig = makeRig({ world: jpy });
    const y = await rig.engine.propose(budgetChange("123.4"));
    expect(y.diff[0]).toBe("Daily budget 222: 100 JPY -> 123 JPY a day (+23%).");
    expect(sentOps(rig)).toMatchObject([
      { campaignBudgetOperation: { update: { amountMicros: "123000000" } } },
    ]);
    rig.close();

    const idr: FakeWorld = fakeWorld({ currencyCode: "IDR" });
    must(idr.budgets["222"]).amountMicros = "90000000000000000"; // 90,000,000,000 IDR: far above 2^53 in micros
    rig = makeRig({ world: idr });
    const r = await rig.engine.propose(budgetChange("120000000000.5"));
    expect(sentOps(rig)).toMatchObject([
      { campaignBudgetOperation: { update: { amountMicros: "120000000001000000" } } },
    ]);
    expect(r.facts.budgetChanges?.[0]).toMatchObject({
      beforeMicros: "90000000000000000",
      afterMicros: "120000000001000000",
    });
    expect(r.diff[0]).toBe("Daily budget 222: 90000000000 IDR -> 120000000001 IDR a day (+33.3%).");
  });

  it("refuses zero after rounding, removed budgets and total (non-daily) budgets", async () => {
    const world = fakeWorld({ currencyCode: "JPY" });
    rig = makeRig({ world });
    expect((await errOf(rig.engine.propose(budgetChange("0.4")))).code).toBe("invalid_input");
    must(world.budgets["222"]).period = "CUSTOM_PERIOD";
    expect((await errOf(rig.engine.propose(budgetChange("5")))).code).toBe("not_allowed");
    must(world.budgets["222"]).period = "DAILY";
    must(world.budgets["222"]).status = "REMOVED";
    expect((await errOf(rig.engine.propose(budgetChange("5")))).code).toBe("not_allowed");
    expect(
      (
        await errOf(
          rig.engine.propose(req("update_budget", { budget_id: "999", daily_amount: "5" })),
        )
      ).code,
    ).toBe("not_found");
    expect(rig.fake.validations()).toBe(0);
  });
});

describe("update_campaign_status", () => {
  it("REMOVED is never allowed, before any Google call", async () => {
    rig = makeRig();
    const e = await errOf(
      rig.engine.propose(req("update_campaign_status", { campaign_id: "333", status: "REMOVED" })),
    );
    expect(e.code).toBe("invalid_input");
    expect(e.message).toMatch(/removing a campaign is not allowed/);
    expect(
      (
        await errOf(
          rig.engine.propose(
            req("update_campaign_status", { campaign_id: "333", status: "removed" }),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    expect(rig.calls).toHaveLength(0);
  });

  it("enabling reports the daily budget that starts to spend; applies, verifies and undoes", async () => {
    rig = makeRig();
    const c = await rig.engine.propose(
      req("update_campaign_status", { campaign_id: "333", status: "ENABLED" }),
    );
    expect(c.diff).toEqual([
      "Campaign 333: PAUSED -> ENABLED.",
      "Turning it on lets it spend up to 10.00 EUR a day (budget 222).",
    ]);
    expect(c.facts.newlyEnabled).toEqual([
      { campaignId: "333", dailyBudgetMicros: "10000000", budgetShared: false },
    ]);
    rig.engine.markApproved(c.id, c.version, "cli", "Pat");
    expect((await rig.engine.apply(c.id, PAT)).status).toBe("verified");
    expect(rig.fake.world.campaigns["333"]?.status).toBe("ENABLED");
    const undo = await rig.engine.proposeUndo(c.id, AGENT);
    expect(undo.diff[0]).toBe("Campaign 333: ENABLED -> PAUSED.");
    expect(undo.facts.newlyEnabled).toBeUndefined();
  });

  it("the same status is nothing to change; a removed campaign is refused", async () => {
    rig = makeRig();
    expect(
      (
        await errOf(
          rig.engine.propose(
            req("update_campaign_status", { campaign_id: "333", status: "PAUSED" }),
          ),
        )
      ).code,
    ).toBe("nothing_to_change");
    must(rig.fake.world.campaigns["333"]).status = "REMOVED";
    expect(
      (
        await errOf(
          rig.engine.propose(
            req("update_campaign_status", { campaign_id: "333", status: "ENABLED" }),
          ),
        )
      ).code,
    ).toBe("not_allowed");
  });
});

describe("update_bidding: the campaign's own strategy", () => {
  it("changing the target keeps the strategy, warns about re-learning and reports the change %", async () => {
    rig = makeRig();
    const c = await rig.engine.propose(
      req("update_bidding", { campaign_id: "333", target_cpa: "6" }),
    );
    expect(c.diff[0]).toBe(
      "Campaign 333 bidding: Maximize conversions (target CPA: 5.00 EUR) -> Maximize conversions (target CPA: 6.00 EUR).",
    );
    expect(c.warnings[0]).toMatch(/re-learn/);
    expect(c.facts.targetChanges).toEqual([
      { kind: "target_cpa_micros", before: "5000000", after: "6000000", changePct: 20 },
    ]);
    expect(c.facts.strategySwitch).toBeNull();
    expect(sentOps(rig)).toEqual([
      {
        campaignOperation: {
          update: {
            resourceName: "customers/1234567890/campaigns/333",
            maximizeConversions: { targetCpaMicros: "6000000" },
          },
          updateMask: "maximize_conversions.target_cpa_micros",
        },
      },
    ]);
  });

  it("switching strategy says learning restarts; undo switches back with the old target", async () => {
    const world = fakeWorld();
    world.conversions30d = { "333": 40 };
    rig = makeRig({ world });
    const done = await applyAll(
      rig,
      req("update_bidding", {
        campaign_id: "333",
        strategy: "TARGET_ROAS",
        target_roas_percent: 250,
      }),
    );
    expect(done.status).toBe("verified");
    expect(done.warnings[0]).toMatch(/restarts Smart Bidding's learning/);
    expect(done.facts.strategySwitch).toEqual({
      from: "MAXIMIZE_CONVERSIONS",
      to: "MAXIMIZE_CONVERSION_VALUE",
    });
    expect(rig.fake.world.campaigns["333"]).toMatchObject({
      biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE",
      maximizeConversionValue: { targetRoas: 2.5 },
    });
    const undo = await rig.engine.proposeUndo(done.id, AGENT);
    expect(undo.payload).toEqual({
      campaign_id: "333",
      strategy: "MAXIMIZE_CONVERSIONS",
      target_cpa: "5",
    });
    rig.engine.markApproved(undo.id, undo.version, "cli", "Pat");
    expect((await rig.engine.apply(undo.id, PAT)).status).toBe("verified");
    expect(rig.fake.world.campaigns["333"]).toMatchObject({
      biddingStrategyType: "MAXIMIZE_CONVERSIONS",
      maximizeConversions: { targetCpaMicros: "5000000" },
    });
  });

  it("Maximize clicks without a limit sends the mask with no value (clears it), never a placeholder ceiling", async () => {
    rig = makeRig();
    await rig.engine.propose(
      req("update_bidding", { campaign_id: "333", strategy: "MAXIMIZE_CLICKS" }),
    );
    expect(sentOps(rig)).toMatchObject([
      {
        campaignOperation: {
          update: { targetSpend: {} },
          updateMask: "target_spend.cpc_bid_ceiling_micros",
        },
      },
    ]);
  });

  it("campaign type rules: Performance Max, Shopping (standalone Target ROAS), Demand Gen", async () => {
    const world = fakeWorld();
    world.conversions30d = { "333": 40 };
    rig = makeRig({ world });
    must(world.campaigns["333"]).advertisingChannelType = "PERFORMANCE_MAX";
    expect(
      (
        await errOf(
          rig.engine.propose(req("update_bidding", { campaign_id: "333", strategy: "MANUAL_CPC" })),
        )
      ).message,
    ).toMatch(/Performance Max can only/);
    must(world.campaigns["333"]).advertisingChannelType = "DEMAND_GEN";
    expect(
      (
        await errOf(
          rig.engine.propose(req("update_bidding", { campaign_id: "333", strategy: "MANUAL_CPC" })),
        )
      ).code,
    ).toBe("not_allowed");
    must(world.campaigns["333"]).advertisingChannelType = "SHOPPING";
    expect(
      (
        await errOf(
          rig.engine.propose(req("update_bidding", { campaign_id: "333", target_cpa: "4" })),
        )
      ).code,
    ).toBe("not_allowed");
    await rig.engine.propose(
      req("update_bidding", {
        campaign_id: "333",
        strategy: "TARGET_ROAS",
        target_roas_percent: 400,
      }),
    );
    expect(sentOps(rig)).toMatchObject([
      {
        campaignOperation: {
          update: { targetRoas: { targetRoas: 4 } },
          updateMask: "target_roas.target_roas",
        },
      },
    ]);
    must(world.campaigns["333"]).advertisingChannelType = "VIDEO";
    expect(
      (
        await errOf(
          rig.engine.propose(req("update_bidding", { campaign_id: "333", strategy: "MANUAL_CPC" })),
        )
      ).code,
    ).toBe("not_allowed");
  });

  it("refuses incomplete or mixed asks, and a no-op", async () => {
    rig = makeRig();
    const codes = async (input: Record<string, unknown>) =>
      (await errOf((rig as Rig).engine.propose(req("update_bidding", input)))).code;
    expect(await codes({ campaign_id: "333" })).toBe("invalid_input");
    expect(await codes({ campaign_id: "333", target_cpa: "5", target_roas_percent: 200 })).toBe(
      "invalid_input",
    );
    expect(await codes({ campaign_id: "333", strategy: "TARGET_CPA", clear_target: true })).toBe(
      "invalid_input",
    );
    expect(await codes({ campaign_id: "333", strategy: "MANUAL_CPC", target_cpa: "5" })).toBe(
      "invalid_input",
    );
    expect(await codes({ campaign_id: "333", strategy: "TARGET_ROAS" })).toBe("invalid_input");
    expect(await codes({ campaign_id: "333", target_roas_percent: -5 })).toBe("invalid_input");
    expect(await codes({ campaign_id: "333", target_cpa: "5" })).toBe("nothing_to_change");
    expect(rig.fake.validations()).toBe(0);
  });

  it("a campaign on Enhanced CPC can switch, but declares that it can't be undone", async () => {
    const world = fakeWorld();
    world.campaigns["333"] = {
      ...must(world.campaigns["333"]),
      biddingStrategyType: "ENHANCED_CPC",
      manualCpc: { enhancedCpcEnabled: true },
    };
    delete world.campaigns["333"].maximizeConversions;
    rig = makeRig({ world });
    const c = await rig.engine.propose(
      req("update_bidding", { campaign_id: "333", strategy: "MAXIMIZE_CONVERSIONS" }),
    );
    expect(c.undo.supported).toBe(false);
    expect(c.undo.why).toMatch(/ENHANCED_CPC/);
  });
});

describe("update_bidding: Google's conversion minimum for value bidding", () => {
  const toValue = { campaign_id: "333", strategy: "MAXIMIZE_CONVERSION_VALUE" };

  it("under the minimum (9 in 30 days): refused before Google is asked, keep the current bidding", async () => {
    const world = fakeWorld();
    must(world.campaigns["333"]).advertisingChannelType = "DEMAND_GEN";
    world.conversions30d = { "333": 9 };
    rig = makeRig({ world });
    const e = await errOf(rig.engine.propose(req("update_bidding", toValue)));
    expect(e.code).toBe("not_allowed");
    expect(e.message).toBe(
      `Campaign 333 had 9 conversions in the last 30 days; Google needs about ${VALUE_BIDDING_MIN_CONV_30D} before it allows bidding on conversion value (Maximize conversion value or Target ROAS) and refuses the switch otherwise. Keep the current bidding until it has enough sales.`,
    );
    expect(rig.fake.validations()).toBe(0);
  });

  it("with or without a target ROAS; no conversion rows counts as 0", async () => {
    rig = makeRig();
    expect(
      (
        await errOf(
          rig.engine.propose(
            req("update_bidding", {
              campaign_id: "333",
              strategy: "TARGET_ROAS",
              target_roas_percent: 300,
            }),
          ),
        )
      ).message,
    ).toMatch(/had 0 conversions in the last 30 days/);
    expect((await errOf(rig.engine.propose(req("update_bidding", toValue)))).code).toBe(
      "not_allowed",
    );
  });

  it("at the minimum the switch is proposed", async () => {
    const world = fakeWorld();
    world.conversions30d = { "333": VALUE_BIDDING_MIN_CONV_30D };
    rig = makeRig({ world });
    const c = await rig.engine.propose(req("update_bidding", toValue));
    expect(c.facts.strategySwitch).toEqual({
      from: "MAXIMIZE_CONVERSIONS",
      to: "MAXIMIZE_CONVERSION_VALUE",
    });
  });

  it("not gated: Target ROAS -> Maximize conversion value with no target (already value bidding, 5 in 30 days)", async () => {
    const world = fakeWorld();
    world.campaigns["333"] = {
      ...must(world.campaigns["333"]),
      biddingStrategyType: "TARGET_ROAS",
      targetRoas: { targetRoas: 4 },
    };
    delete world.campaigns["333"].maximizeConversions;
    world.conversions30d = { "333": 5 };
    rig = makeRig({ world });
    const done = await applyAll(
      rig,
      req("update_bidding", {
        campaign_id: "333",
        strategy: "MAXIMIZE_CONVERSION_VALUE",
        clear_target: true,
      }),
    );
    expect(done.status).toBe("verified");
    expect(rig.fake.world.campaigns["333"]?.biddingStrategyType).toBe("MAXIMIZE_CONVERSION_VALUE");
  });

  it("switchesIntoValueBidding: only from a strategy that is not value bidding (unknown = gated)", () => {
    expect(switchesIntoValueBidding("MAXIMIZE_CONVERSION_VALUE", "MAXIMIZE_CONVERSIONS")).toBe(
      true,
    );
    expect(switchesIntoValueBidding("TARGET_ROAS", "MANUAL_CPC")).toBe(true);
    expect(switchesIntoValueBidding("MAXIMIZE_CONVERSION_VALUE", null)).toBe(true);
    expect(switchesIntoValueBidding("MAXIMIZE_CONVERSION_VALUE", "TARGET_ROAS")).toBe(false);
    expect(switchesIntoValueBidding("maximize_conversion_value", "MAXIMIZE_CONVERSION_VALUE")).toBe(
      false,
    );
    expect(switchesIntoValueBidding("MAXIMIZE_CONVERSIONS", "MANUAL_CPC")).toBe(false);
  });

  it("not gated: a target change on value bidding, a switch to count bidding, and an undo back to value", async () => {
    const world = fakeWorld();
    world.campaigns["333"] = {
      ...must(world.campaigns["333"]),
      biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE",
      maximizeConversionValue: { targetRoas: 3 },
    };
    delete world.campaigns["333"].maximizeConversions;
    rig = makeRig({ world });
    await rig.engine.propose(
      req("update_bidding", { campaign_id: "333", target_roas_percent: 350 }),
    );
    const done = await applyAll(
      rig,
      req("update_bidding", { campaign_id: "333", strategy: "MAXIMIZE_CONVERSIONS" }),
    );
    expect(done.status).toBe("verified");
    const undo = await rig.engine.proposeUndo(done.id, AGENT);
    rig.engine.markApproved(undo.id, undo.version, "cli", "Pat");
    expect((await rig.engine.apply(undo.id, PAT)).status).toBe("verified");
    expect(rig.fake.world.campaigns["333"]?.biddingStrategyType).toBe("MAXIMIZE_CONVERSION_VALUE");
  });
});

describe("update_bidding: limits and bounds", () => {
  it("R1: add a max CPC limit, then undo -> verified and the limit is gone", async () => {
    const world = fakeWorld();
    world.campaigns["333"] = {
      ...must(world.campaigns["333"]),
      biddingStrategyType: "TARGET_SPEND",
      targetSpend: {},
    };
    delete world.campaigns["333"].maximizeConversions;
    rig = makeRig({ world });
    const done = await applyAll(
      rig,
      req("update_bidding", { campaign_id: "333", max_cpc_limit: "2" }),
    );
    expect(done.status).toBe("verified");
    expect(rig.fake.world.campaigns["333"]?.targetSpend).toEqual({
      cpcBidCeilingMicros: "2000000",
    });
    const undo = await rig.engine.proposeUndo(done.id, AGENT);
    expect(undo.payload).toEqual({
      campaign_id: "333",
      strategy: "MAXIMIZE_CLICKS",
      clear_max_cpc_limit: true,
    });
    expect(undo.diff[0]).toMatch(
      /max CPC limit: 2.00 EUR\) -> Maximize clicks \(max CPC limit: none\)/,
    );
    rig.engine.markApproved(undo.id, undo.version, "cli", "Pat");
    expect((await rig.engine.apply(undo.id, PAT)).status).toBe("verified");
    expect(rig.fake.world.campaigns["333"]?.targetSpend).toEqual({});
  });

  it("target ROAS 1% .. 10,000%; tCPA and limits must stay above zero after currency rounding", async () => {
    rig = makeRig({ world: fakeWorld({ currencyCode: "JPY" }) });
    const code = async (input: Record<string, unknown>) =>
      (await errOf((rig as Rig).engine.propose(req("update_bidding", input)))).code;
    expect(
      await code({ campaign_id: "333", strategy: "TARGET_ROAS", target_roas_percent: 0.5 }),
    ).toBe("invalid_input");
    expect(
      await code({ campaign_id: "333", strategy: "TARGET_ROAS", target_roas_percent: 20_000 }),
    ).toBe("invalid_input");
    expect(await code({ campaign_id: "333", target_cpa: "0.4" })).toBe("invalid_input");
    expect(
      await code({ campaign_id: "333", strategy: "MAXIMIZE_CLICKS", max_cpc_limit: "0.2" }),
    ).toBe("invalid_input");
    expect(
      await code({
        campaign_id: "333",
        strategy: "MAXIMIZE_CLICKS",
        max_cpc_limit: "2",
        clear_max_cpc_limit: true,
      }),
    ).toBe("invalid_input");
    expect(await code({ campaign_id: "333", clear_max_cpc_limit: true })).toBe("invalid_input");
    expect(rig.fake.validations()).toBe(0);
  });
});

describe("update_bidding: portfolio (shared) strategies", () => {
  const portfolioWorld = (): FakeWorld => {
    const world = fakeWorld();
    const rn = "customers/1234567890/biddingStrategies/444";
    world.strategies["444"] = {
      id: "444",
      name: "Shared tCPA",
      type: "TARGET_CPA",
      status: "ENABLED",
      targetCpa: { targetCpaMicros: "8000000" },
    };
    for (const id of ["333", "334"]) {
      world.campaigns[id] = {
        id,
        name: `Campaign ${id}`,
        status: "ENABLED",
        advertisingChannelType: "SEARCH",
        budgetId: "222",
        biddingStrategyType: "TARGET_CPA",
        biddingStrategy: rn,
      };
    }
    return world;
  };

  it("changes the portfolio's target, lists every campaign on it, applies, verifies and undoes", async () => {
    rig = makeRig({ world: portfolioWorld() });
    const c = await rig.engine.propose(
      req("update_bidding", { campaign_id: "333", target_cpa: "10" }),
    );
    expect(c.diff).toEqual([
      "Shared bidding strategy 444 (Target CPA): target 8.00 EUR -> 10.00 EUR (25% change).",
      "It is used by 2 campaigns; all of them change.",
    ]);
    expect(c.affected.map((a) => `${a.kind}:${a.id}`)).toEqual([
      "bidding_strategy:444",
      "campaign:333",
      "campaign:334",
    ]);
    expect(c.facts.affectedCampaignIds).toEqual(["333", "334"]);
    expect(sentOps(rig)).toEqual([
      {
        biddingStrategyOperation: {
          update: {
            resourceName: "customers/1234567890/biddingStrategies/444",
            targetCpa: { targetCpaMicros: "10000000" },
          },
          updateMask: "target_cpa.target_cpa_micros",
        },
      },
    ]);
    rig.engine.markApproved(c.id, c.version, "cli", "Pat");
    expect((await rig.engine.apply(c.id, PAT)).status).toBe("verified");
    expect(rig.fake.world.strategies["444"]?.targetCpa?.targetCpaMicros).toBe("10000000");
    const undo = await rig.engine.proposeUndo(c.id, AGENT);
    expect(undo.payload).toEqual({ campaign_id: "333", target_cpa: "8" });
    rig.engine.markApproved(undo.id, undo.version, "cli", "Pat");
    expect((await rig.engine.apply(undo.id, PAT)).status).toBe("verified");
    expect(rig.fake.world.strategies["444"]?.targetCpa?.targetCpaMicros).toBe("8000000");
  });

  it("refuses moving a campaign off its portfolio, manager-owned portfolios and the wrong kind of target", async () => {
    const world = portfolioWorld();
    rig = makeRig({ world });
    expect(
      (
        await errOf(
          rig.engine.propose(req("update_bidding", { campaign_id: "333", strategy: "MANUAL_CPC" })),
        )
      ).message,
    ).toMatch(/Moving it off the shared strategy/);
    expect(
      (
        await errOf(
          rig.engine.propose(
            req("update_bidding", { campaign_id: "333", target_roas_percent: 300 }),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    expect(
      (
        await errOf(
          rig.engine.propose(req("update_bidding", { campaign_id: "333", clear_target: true })),
        )
      ).code,
    ).toBe("not_allowed");
    must(world.campaigns["333"]).biddingStrategy = "customers/1111111111/biddingStrategies/555";
    expect(
      (
        await errOf(
          rig.engine.propose(req("update_bidding", { campaign_id: "333", target_cpa: "9" })),
        )
      ).message,
    ).toMatch(/manager account/);
    expect(rig.fake.validations()).toBe(0);
  });

  it("undo is refused when the portfolio target changed again since", async () => {
    const world = portfolioWorld();
    rig = makeRig({ world });
    const done = await applyAll(
      rig,
      req("update_bidding", { campaign_id: "333", target_cpa: "10" }),
    );
    must(world.strategies["444"]).targetCpa = { targetCpaMicros: "12000000" };
    expect((await errOf(rig.engine.proposeUndo(done.id, AGENT))).code).toBe("undo_stale");
  });
});
