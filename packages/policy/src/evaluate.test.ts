// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { ChangeFacts, PolicyRequest, RecentWrite } from "@perfoads/changes";
import { describe, expect, it } from "vitest";
import { describeChange, evaluate, isLowRisk } from "./evaluate.js";
import { parsePolicyText, type PolicyV1 } from "./schema.js";

const A = "1234567890";
const B = "9876543210";
const NOW = Date.parse("2026-10-25T10:00:00.000Z");

const policyOf = (yaml: string): PolicyV1 => {
  const r = parsePolicyText(yaml);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.policy;
};

const base = (extra = ""): PolicyV1 =>
  policyOf(`version: 1
accounts: { allow: ["${A}", "${B}"], write: ["${A}", "${B}"] }
limits:
  max_budget_change_pct: 30
  max_budget_change_abs: { "${A}": 50 }
  max_new_daily_spend: { "${A}": 100 }
  max_target_change_pct: 20
  writes_per_day: 5
  writes_per_minute: 2
  max_ops_per_change: 3
${extra}`);

const req = (over: Partial<PolicyRequest> = {}, currency = "EUR"): PolicyRequest => ({
  stage: "propose",
  type: "update_budget",
  account: {
    customerId: A,
    name: "Shop",
    currencyCode: currency,
    timeZone: null,
    testAccount: false,
    manager: false,
  },
  payload: {},
  facts: { affectedCampaignIds: [] },
  opsCount: 1,
  undoOf: null,
  recent: [],
  now: NOW,
  ...over,
});

const budget = (before: string, after: string): ChangeFacts => ({
  budgetChanges: [{ budgetId: "222", beforeMicros: before, afterMicros: after, shared: false }],
  affectedCampaignIds: [],
});

const enable = (budgetMicros: string | null): ChangeFacts => ({
  newlyEnabled: [{ campaignId: "333", dailyBudgetMicros: budgetMicros, budgetShared: false }],
  affectedCampaignIds: ["333"],
});

const claim = (facts: ChangeFacts, status = "verified", agoMs = 60 * 60 * 1000): RecentWrite => ({
  changeId: `chg_${Math.random()}`,
  status,
  claimedAt: new Date(NOW - agoMs).toISOString(),
  facts,
});

const M = (eur: number): string => String(Math.round(eur * 1e6));

describe("evaluate", () => {
  it("allows a change inside every limit (tier confirm by default)", () => {
    expect(evaluate(base(), req({ facts: budget(M(100), M(120)) }))).toMatchObject({
      allowed: true,
      tier: "confirm",
    });
  });

  it("kill switch refuses everything, undo too", () => {
    const p = base("kill_switch: true\n");
    expect(evaluate(p, req({ facts: budget(M(100), M(90)) })).reason).toMatch(/kill_switch/);
    expect(
      evaluate(p, req({ facts: budget(M(100), M(90)), undoOf: "chg_x", restoresBefore: true })),
    ).toMatchObject({ allowed: false, rule: "kill_switch" });
  });

  it("accounts.write: an allow-only account is read-only", () => {
    const p = policyOf(`version: 1\naccounts: { allow: ["${A}"], write: [] }\n`);
    expect(evaluate(p, req()).reason).toMatch(/123-456-7890 is read-only/);
  });

  it("budget percent and absolute limits, both directions, exact (no float rounding)", () => {
    expect(evaluate(base(), req({ facts: budget(M(100), M(130)) })).allowed).toBe(true);
    // 30.000001 % is over 30 %.
    expect(evaluate(base(), req({ facts: budget("100000000", "130000001") }))).toMatchObject({
      allowed: false,
      rule: "limits.max_budget_change_pct",
    });
    expect(evaluate(base(), req({ facts: budget(M(100), M(60)) })).rule).toBe(
      "limits.max_budget_change_pct",
    );
    // 50 EUR abs cap: 200 -> 251 is 25.5 % but 51 EUR.
    expect(evaluate(base(), req({ facts: budget(M(200), M(251)) }))).toMatchObject({
      allowed: false,
      rule: "limits.max_budget_change_abs",
    });
    expect(evaluate(base(), req({ facts: budget(M(200), M(251)) })).reason).toMatch(
      /by 51.00 EUR; the policy allows at most 50.00 EUR/,
    );
  });

  it("an undo back to exactly the old value may exceed the percent limit, but not the spend cap", () => {
    const undo = { undoOf: "chg_prev", restoresBefore: true };
    // 70 -> 100 = +42.9 %: allowed for an exact undo; +30 EUR is inside the 50 abs cap and 100 cap.
    expect(evaluate(base(), req({ facts: budget(M(70), M(100)), ...undo })).allowed).toBe(true);
    expect(evaluate(base(), req({ facts: budget(M(70), M(100)) })).allowed).toBe(false);
    // Undo used as a raise: still counted in the 24-hour spend.
    const recent = [claim(budget(M(10), M(90)))];
    expect(evaluate(base(), req({ facts: budget(M(70), M(100)), ...undo, recent }))).toMatchObject({
      allowed: false,
      rule: "limits.max_new_daily_spend",
    });
    // undoOf without the engine's exact-restore flag gets no exemption.
    expect(
      evaluate(base(), req({ facts: budget(M(70), M(100)), undoOf: "chg_prev" })).allowed,
    ).toBe(false);
  });

  it("max_new_daily_spend: raises + enabled budgets over the rolling 24 h, in_doubt counts as spent", () => {
    const p = base();
    expect(evaluate(p, req({ facts: enable(M(60)) })).allowed).toBe(true);
    const recent = [claim(enable(M(60)), "in_doubt")];
    const r = evaluate(p, req({ facts: enable(M(60)), recent }));
    expect(r).toMatchObject({ allowed: false, rule: "limits.max_new_daily_spend" });
    expect(r.reason).toMatch(
      /adds 60.00 EUR.*60.00 EUR was already added.*only 40.00 EUR is left of the 100.00 EUR/,
    );
    // Failed / stale claims spent nothing; claims older than the window are not passed in.
    expect(
      evaluate(p, req({ facts: enable(M(60)), recent: [claim(enable(M(60)), "failed")] })).allowed,
    ).toBe(true);
    // Decreases never offset raises.
    const mixed = [claim(budget(M(100), M(10))), claim(budget(M(100), M(150)))];
    expect(evaluate(p, req({ facts: enable(M(60)), recent: mixed })).allowed).toBe(false);
  });

  it("no max_new_daily_spend for the account = spend can't go up; decreases are fine", () => {
    const r = evaluate(
      base(),
      req({ account: { ...req().account, customerId: B }, facts: enable(M(1)) }),
    );
    expect(r).toMatchObject({ allowed: false, rule: "limits.max_new_daily_spend" });
    expect(r.reason).toMatch(/no max_new_daily_spend for account 987-654-3210/);
    expect(
      evaluate(
        base(),
        req({ account: { ...req().account, customerId: B }, facts: budget(M(10), M(8)) }),
      ).allowed,
    ).toBe(true);
  });

  it("an enabled campaign whose budget is unknown is refused", () => {
    expect(evaluate(base(), req({ facts: enable(null) })).rule).toBe("limits.max_new_daily_spend");
  });

  it("currency: limits are in the account's own currency, compared in micros (JPY, IDR)", () => {
    const p = policyOf(`version: 1
accounts: { allow: ["${A}"], write: ["${A}"] }
limits: { max_new_daily_spend: { "${A}": 1000 }, max_budget_change_pct: 1000 }
`);
    // 999 JPY then 2 JPY: 1,001 > 1,000.
    const recent = [claim(budget(M(1000), M(1999)))];
    const jpy = evaluate(p, req({ facts: budget(M(2000), M(2002)), recent }, "JPY"));
    expect(jpy.allowed).toBe(false);
    expect(jpy.reason).toMatch(
      /adds 2 JPY of daily spend; 999 JPY was already added.*only 1 JPY is left of the 1000 JPY/,
    );
    // Many tiny raises cannot round away: 1,000 x 1 IDR raises fill a 1,000 IDR cap exactly.
    const many = Array.from({ length: 1000 }, () => claim(budget(M(5000), M(5001))));
    const pMany = policyOf(`version: 1
accounts: { allow: ["${A}"], write: ["${A}"] }
limits: { max_new_daily_spend: { "${A}": 1000 }, writes_per_day: 100000, writes_per_minute: 100000 }
`);
    expect(
      evaluate(pMany, req({ facts: budget(M(5000), M(5001)), recent: many }, "IDR")).allowed,
    ).toBe(false);
    expect(
      evaluate(pMany, req({ facts: budget(M(5000), M(5001)), recent: many.slice(1) }, "IDR"))
        .allowed,
    ).toBe(true);
  });

  it("target CPA / ROAS change limit, exact, campaign or portfolio alike", () => {
    const t = (before: string | null, after: string | null, kind = "target_cpa_micros") => ({
      targetChanges: [{ kind: kind as "target_cpa_micros", before, after, changePct: null }],
      affectedCampaignIds: ["333"],
    });
    expect(evaluate(base(), req({ type: "update_bidding", facts: t(M(10), M(12)) })).allowed).toBe(
      true,
    );
    // 20.04 % would round to 20.0 % in a one-decimal percent: refused exactly.
    expect(
      evaluate(base(), req({ type: "update_bidding", facts: t("10000000", "12004000") })).rule,
    ).toBe("limits.max_target_change_pct");
    expect(
      evaluate(base(), req({ type: "update_bidding", facts: t("4", "4.81", "target_roas") })).rule,
    ).toBe("limits.max_target_change_pct");
    // Removing a target can't be measured: refused (unless an exact undo).
    expect(evaluate(base(), req({ type: "update_bidding", facts: t(M(10), null) })).allowed).toBe(
      false,
    );
    expect(
      evaluate(
        base(),
        req({ type: "update_bidding", facts: t(M(10), null), undoOf: "c", restoresBefore: true }),
      ).allowed,
    ).toBe(true);
    // Adding a target where there was none is fine.
    expect(evaluate(base(), req({ type: "update_bidding", facts: t(null, M(10)) })).allowed).toBe(
      true,
    );
  });

  it("switching between target CPA and target ROAS (either way, campaign or portfolio) is refused unless an exact undo", () => {
    const sw = (from: "target_cpa_micros" | "target_roas", ids: string[]) => ({
      targetChanges: [
        { kind: from, before: from === "target_roas" ? "4" : M(5), after: null, changePct: null },
        {
          kind: from === "target_roas" ? ("target_cpa_micros" as const) : ("target_roas" as const),
          before: null,
          after: from === "target_roas" ? M(5) : "4",
          changePct: null,
        },
      ],
      affectedCampaignIds: ids,
    });
    for (const from of ["target_cpa_micros", "target_roas"] as const) {
      for (const ids of [["333"], ["333", "334", "335"]]) {
        const r = evaluate(base(), req({ type: "update_bidding", facts: sw(from, ids) }));
        expect(r).toMatchObject({ allowed: false, rule: "limits.max_target_change_pct" });
        expect(r.reason).toMatch(
          from === "target_roas"
            ? /switches from target ROAS to target CPA/
            : /switches from target CPA to target ROAS/,
        );
        expect(
          evaluate(
            base(),
            req({
              type: "update_bidding",
              facts: sw(from, ids),
              undoOf: "c",
              restoresBefore: true,
            }),
          ).allowed,
        ).toBe(true);
      }
    }
  });

  it("writes per day / per minute count every claim; max ops per change", () => {
    const five = Array.from({ length: 5 }, () => claim(budget(M(10), M(9)), "failed"));
    expect(evaluate(base(), req({ facts: budget(M(10), M(9)), recent: five })).rule).toBe(
      "limits.writes_per_day",
    );
    const two = [
      claim(budget(M(10), M(9)), "stale", 5000),
      claim(budget(M(10), M(9)), "verified", 30_000),
    ];
    expect(evaluate(base(), req({ facts: budget(M(10), M(9)), recent: two })).rule).toBe(
      "limits.writes_per_minute",
    );
    expect(evaluate(base(), req({ facts: budget(M(10), M(9)), opsCount: 4 })).rule).toBe(
      "limits.max_ops_per_change",
    );
  });

  it("tiers: exact key beats patterns, strictest pattern wins, blocked refuses, default confirm", () => {
    const p = base('tiers: { "update_*": blocked, update_budget: auto, "update_b*": confirm }\n');
    expect(evaluate(p, req({ type: "update_campaign_status" })).rule).toBe("tiers");
    expect(evaluate(p, req({ type: "update_bidding" })).rule).toBe("tiers");
    expect(evaluate(p, req({ facts: budget(M(10), M(9)) })).tier).toBe("auto");
  });

  it("auto is honoured only for pausing a campaign and lowering budgets", () => {
    const p = base(
      "tiers: { update_budget: auto, update_campaign_status: auto, update_bidding: auto }\n",
    );
    expect(evaluate(p, req({ facts: budget(M(10), M(9)) })).tier).toBe("auto");
    expect(evaluate(p, req({ facts: budget(M(10), M(11)) })).tier).toBe("confirm");
    expect(
      evaluate(p, req({ type: "update_campaign_status", payload: { status: "PAUSED" } })).tier,
    ).toBe("auto");
    expect(
      evaluate(
        p,
        req({
          type: "update_campaign_status",
          payload: { status: "ENABLED" },
          facts: enable(M(1)),
        }),
      ).tier,
    ).toBe("confirm");
    expect(
      evaluate(p, req({ type: "update_bidding", facts: { affectedCampaignIds: [] } })).tier,
    ).toBe("confirm");
    expect(isLowRisk("remove_campaign", {}, { affectedCampaignIds: [] })).toBe(false);
  });

  it("approval view lines say how much of the 24-hour limit is left", () => {
    const lines = describeChange(base(), req({ facts: enable(M(40)), recent: [] }));
    expect(lines[0]).toBe(
      "This raises daily spend on this account by 40.00 EUR; 60.00 EUR left of your 100.00 EUR 24-hour limit.",
    );
  });
});

describe("P6: defaults and the types that create things", () => {
  const kw = (createdEnabled: number, broad = 0): ChangeFacts => ({
    affectedCampaignIds: ["333"],
    items: [{ kind: "keyword", created: 2, updated: 0, removed: 0 }],
    createdEnabled,
    broadWithoutSmartBidding: broad,
  });

  it("new_entities_paused refuses keywords created ENABLED; false lets them through", () => {
    const r = evaluate(base(), req({ type: "add_keywords", facts: kw(2), opsCount: 2 }));
    expect(r).toMatchObject({ allowed: false, rule: "defaults.new_entities_paused" });
    const off = base("defaults: { new_entities_paused: false }");
    expect(evaluate(off, req({ type: "add_keywords", facts: kw(2), opsCount: 2 })).allowed).toBe(
      true,
    );
    expect(evaluate(base(), req({ type: "add_keywords", facts: kw(0), opsCount: 2 })).allowed).toBe(
      true,
    );
  });

  it("broad_match_requires_smart_bidding refuses BROAD without smart bidding", () => {
    const r = evaluate(base(), req({ type: "add_keywords", facts: kw(0, 1), opsCount: 2 }));
    expect(r).toMatchObject({
      allowed: false,
      rule: "defaults.broad_match_requires_smart_bidding",
    });
    const off = base("defaults: { broad_match_requires_smart_bidding: false }");
    expect(evaluate(off, req({ type: "add_keywords", facts: kw(0, 1), opsCount: 2 })).allowed).toBe(
      true,
    );
  });

  it("max_ops_per_change covers every type; remove_* tiers block remove_campaign_negatives", () => {
    const facts: ChangeFacts = { affectedCampaignIds: ["333"] };
    expect(evaluate(base(), req({ type: "add_campaign_negatives", facts, opsCount: 4 })).rule).toBe(
      "limits.max_ops_per_change",
    );
    const blocked = base('tiers: { "remove_*": blocked }');
    expect(evaluate(blocked, req({ type: "remove_campaign_negatives", facts })).rule).toBe("tiers");
    expect(evaluate(blocked, req({ type: "add_campaign_negatives", facts })).tier).toBe("confirm");
  });

  it("types 4-10 are never auto (auto is honoured only for the low-risk list)", () => {
    const auto = base("tiers: { add_callouts: auto, add_campaign_negatives: auto }");
    const facts: ChangeFacts = { affectedCampaignIds: ["333"] };
    expect(evaluate(auto, req({ type: "add_callouts", facts })).tier).toBe("confirm");
    expect(evaluate(auto, req({ type: "add_campaign_negatives", facts })).tier).toBe("confirm");
  });

  it("describe: the override line comes first; counts per item kind and the ops line", () => {
    const facts: ChangeFacts = {
      affectedCampaignIds: ["333"],
      items: [{ kind: "campaign_negative_keyword", created: 3, updated: 0, removed: 0 }],
      blockedConversions: { count: 1, examples: [] },
    };
    const lines = describeChange(
      base(),
      req({ type: "add_campaign_negatives", facts, opsCount: 3 }),
    );
    expect(lines[0]).toBe(
      "OVERRIDE: 1 negative keyword(s) block searches or keywords that had conversions; a person must accept that.",
    );
    expect(lines).toContain("Writes campaign negative keyword: 3 created.");
    expect(lines).toContain("Operations in this change: 3 of at most 3.");
  });
});
