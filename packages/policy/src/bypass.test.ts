// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Bypass suite (plan P5): an AI (or a careless edit) tries to get a change past the policy.
// Every attempt must be refused with a plain message, logged, and send nothing to Google.
// Real change engine + real policy file + fake Google account; fake ids only.

import { ChangeError, type PolicyCheck } from "@perfoads/changes";
import type { FakeWorld } from "@perfoads/changes/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCOUNT,
  AGENT,
  fakeWorld,
  makePolicyRig,
  policyYaml,
  type PolicyRig,
} from "./testing/rig.js";

let rig: PolicyRig | undefined;
afterEach(() => {
  rig?.close();
  rig = undefined;
});

const refusedWith = async (p: Promise<unknown>): Promise<ChangeError> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChangeError);
  return err as ChangeError;
};

/** Budgets 223 / 224 / 225 (6 EUR each) with paused campaigns 334 / 335 / 336 on them. */
const manyCampaigns = (currencyCode = "EUR"): FakeWorld => {
  const w = fakeWorld({ currencyCode });
  for (const [c, b] of [
    ["334", "223"],
    ["335", "224"],
    ["336", "225"],
  ] as const) {
    w.budgets[b] = {
      id: b,
      name: `Budget ${b}`,
      amountMicros: "6000000",
      explicitlyShared: false,
      period: "DAILY",
      status: "ENABLED",
    };
    w.campaigns[c] = {
      id: c,
      name: `Campaign ${c}`,
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
      budgetId: b,
      biddingStrategyType: "MAXIMIZE_CLICKS",
    };
  }
  return w;
};

const budget = (amount: string, id = "222") => ({ budget_id: id, daily_amount: amount });
const enable = (id: string) => ({ campaign_id: id, status: "ENABLED" });

describe("bypass: params outside limits", () => {
  it("a budget raise above max_budget_change_pct is refused at propose, logged, nothing checked with Google", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 100 }) });
    const err = await refusedWith(
      rig.engine.propose({
        customerId: ACCOUNT,
        type: "update_budget",
        input: budget("20"),
        ...AGENT,
      }),
    );
    expect(err.code).toBe("policy_refused");
    expect(err.message).toBe(
      "This changes budget 222 by 100% (10.00 EUR -> 20.00 EUR); the policy allows at most 30% in one change.",
    );
    expect(rig.fake.validations()).toBe(0);
    expect(rig.refusals()).toEqual([
      expect.objectContaining({
        changeId: null,
        stage: "propose",
        code: "policy_refused",
        type: "update_budget",
      }),
    ]);
  });

  it("max_budget_change_abs and a 'pause' that is really an enable are judged by the facts, not the words", async () => {
    rig = makePolicyRig({
      world: manyCampaigns(),
      policy: policyYaml({ abs: 2, cap: 5, pct: 100 }),
    });
    expect(
      (
        await refusedWith(
          rig.engine.propose({
            customerId: ACCOUNT,
            type: "update_budget",
            input: budget("12.50"),
            ...AGENT,
          }),
        )
      ).message,
    ).toMatch(/by 2.50 EUR; the policy allows at most 2.00 EUR/);
    // Enabling a 6 EUR campaign with a 5 EUR 24-hour cap.
    expect(
      (
        await refusedWith(
          rig.engine.propose({
            customerId: ACCOUNT,
            type: "update_campaign_status",
            input: enable("334"),
            reason: "just pausing it",
            ...AGENT,
          }),
        )
      ).message,
    ).toMatch(/adds 6.00 EUR of daily spend.*only 5.00 EUR is left/);
    expect(rig.fake.writes()).toBe(0);
  });
});

describe("bypass: splitting a big raise into small changes inside 24 hours", () => {
  it("each step passes the percent limit, the rolling sum stops at the cap (propose)", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 10 }) });
    for (const amount of ["12.50", "15", "18"]) {
      const v = await rig.proposeApproved("update_budget", budget(amount));
      expect((await rig.engine.apply(v.id, AGENT)).status).toBe("verified");
      rig.clock.now += 60 * 60 * 1000;
    }
    // +2.50 +2.50 +3.00 = 8.00 so far; 18 -> 21 adds 3.00 (11.00 > 10.00).
    const err = await refusedWith(
      rig.engine.propose({
        customerId: ACCOUNT,
        type: "update_budget",
        input: budget("21"),
        ...AGENT,
      }),
    );
    expect(err.message).toMatch(
      /adds 3.00 EUR of daily spend; 8.00 EUR was already added.*only 2.00 EUR is left of the 10.00 EUR/,
    );
    // After 24 hours the window has moved on.
    rig.clock.now += 24 * 60 * 60 * 1000;
    const later = await rig.proposeApproved("update_budget", budget("21"));
    expect((await rig.engine.apply(later.id, AGENT)).status).toBe("verified");
  });

  it("small raises all proposed first, then applied one by one: the later ones are refused at apply", async () => {
    rig = makePolicyRig({ world: manyCampaigns(), policy: policyYaml({ cap: 2 }) });
    const ids: string[] = [];
    for (const b of ["223", "224", "225"])
      ids.push((await rig.proposeApproved("update_budget", budget("7", b))).id);
    expect((await rig.engine.apply(ids[0] ?? "", AGENT)).status).toBe("verified");
    expect((await rig.engine.apply(ids[1] ?? "", AGENT)).status).toBe("verified");
    const err = await refusedWith(rig.engine.apply(ids[2] ?? "", AGENT));
    expect(err.message).toMatch(
      /2.00 EUR was already added on this account in the last 24 hours, so only 0.00 EUR is left/,
    );
    expect(rig.engine.get(ids[2] ?? "")?.status).toBe("approved");
    expect(rig.fake.writes()).toBe(2);
    expect(rig.refusals().at(-1)).toMatchObject({ changeId: ids[2], code: "policy_refused" });
  });
});

describe("bypass: enabling many campaigns in parallel", () => {
  it("two claims racing: the claim transaction lets only one pass max_new_daily_spend", async () => {
    rig = makePolicyRig({ world: manyCampaigns(), policy: policyYaml({ cap: 10 }) });
    const a = await rig.proposeApproved("update_campaign_status", enable("334"));
    const b = await rig.proposeApproved("update_campaign_status", enable("335"));
    const other = rig.second();
    // Both pre-checks read the account before either claims: each alone would pass (6 <= 10).
    rig.holdAccountReads(2);
    const results = await Promise.allSettled([
      rig.engine.apply(a.id, AGENT),
      other.engine.apply(b.id, AGENT),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const no = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(no).toHaveLength(1);
    expect((no[0]?.reason as ChangeError).message).toMatch(
      /adds 6.00 EUR of daily spend; 6.00 EUR was already added/,
    );
    expect(rig.fake.writes()).toBe(1);
    expect(rig.refusals()).toEqual([
      expect.objectContaining({ stage: "claim", code: "policy_refused" }),
    ]);
  });

  it("writes_per_minute counts claims, also across connections", async () => {
    rig = makePolicyRig({ world: manyCampaigns(), policy: policyYaml({ cap: 100, perMinute: 1 }) });
    const a = await rig.proposeApproved("update_budget", budget("7", "223"));
    const b = await rig.proposeApproved("update_budget", budget("7", "224"));
    await rig.engine.apply(a.id, AGENT);
    const err = await refusedWith(rig.second().engine.apply(b.id, AGENT));
    expect(err.message).toMatch(
      /1 changes were sent to this account in the last minute; the policy allows 1 a minute/,
    );
  });
});

describe("bypass: currency tricks", () => {
  it("JPY: whole yen, compared exactly; many tiny raises can't round away", async () => {
    const w = manyCampaigns("JPY");
    for (const b of Object.values(w.budgets)) b.amountMicros = "10000000000"; // 10,000 JPY
    rig = makePolicyRig({ world: w, policy: policyYaml({ cap: 1000 }) });
    const first = await rig.proposeApproved("update_budget", budget("10999"));
    expect((await rig.engine.apply(first.id, AGENT)).status).toBe("verified");
    const err = await refusedWith(
      rig.engine.propose({
        customerId: ACCOUNT,
        type: "update_budget",
        input: budget("10002", "223"),
        ...AGENT,
      }),
    );
    expect(err.message).toBe(
      "This adds 2 JPY of daily spend; 999 JPY was already added on this account in the last 24 hours, so only 1 JPY is left of the 1000 JPY 24-hour limit.",
    );
    // 1 JPY fits exactly.
    expect((await rig.proposeApproved("update_budget", budget("10001", "224"))).status).toBe(
      "approved",
    );
  });

  it("a cap written for another account does not cover this one: spend can't go up here", async () => {
    rig = makePolicyRig({ policy: policyYaml({ capFor: "9876543210", cap: 1000 }) });
    const err = await refusedWith(
      rig.engine.propose({
        customerId: ACCOUNT,
        type: "update_budget",
        input: budget("11"),
        ...AGENT,
      }),
    );
    expect(err.message).toMatch(/sets no max_new_daily_spend for account 123-456-7890/);
  });

  it("the account's currency changes after approval: stale, nothing sent", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 10 }) });
    const v = await rig.proposeApproved("update_budget", budget("12"));
    rig.fake.world.customer.currencyCode = "HUF";
    const after = await rig.engine.apply(v.id, AGENT);
    expect(after.status).toBe("stale");
    expect(rig.fake.writes()).toBe(0);
  });
});

describe("bypass: target change via campaign vs portfolio", () => {
  const portfolio = (): FakeWorld => {
    const w = fakeWorld();
    w.strategies["444"] = {
      id: "444",
      name: "Shared tCPA",
      type: "TARGET_CPA",
      status: "ENABLED",
      targetCpa: { targetCpaMicros: "8000000" },
    };
    w.campaigns["334"] = {
      id: "334",
      name: "On portfolio",
      status: "ENABLED",
      advertisingChannelType: "SEARCH",
      budgetId: "222",
      biddingStrategyType: "TARGET_CPA",
      biddingStrategy: `customers/${ACCOUNT}/biddingStrategies/444`,
    };
    return w;
  };

  it("both paths hit max_target_change_pct", async () => {
    rig = makePolicyRig({ world: portfolio(), policy: policyYaml() });
    // Campaign 333: own target 5.00 -> 7.00 (+40 %).
    const own = await refusedWith(
      rig.engine.propose({
        customerId: ACCOUNT,
        type: "update_bidding",
        input: { campaign_id: "333", target_cpa: "7" },
        ...AGENT,
      }),
    );
    expect(own.message).toMatch(/changes the target CPA by 40%; the policy allows at most 20%/);
    // Campaign 334 on portfolio 444: 8.00 -> 11.20 (+40 %), reaching every campaign on it.
    const shared = await refusedWith(
      rig.engine.propose({
        customerId: ACCOUNT,
        type: "update_bidding",
        input: { campaign_id: "334", target_cpa: "11.20" },
        ...AGENT,
      }),
    );
    expect(shared.message).toMatch(/changes the target CPA by 40%/);
    // 8.00 -> 9.60 (+20 %) is fine.
    expect(
      (
        await rig.engine.propose({
          customerId: ACCOUNT,
          type: "update_bidding",
          input: { campaign_id: "334", target_cpa: "9.60" },
          ...AGENT,
        })
      ).status,
    ).toBe("proposed");
    expect(rig.refusals()).toHaveLength(2);
  });
});

describe("bypass: 150 proposals to burn operations", () => {
  const proposeOnce = (r: PolicyRig, amount = "10.50") =>
    r.engine
      .propose({ customerId: ACCOUNT, type: "update_budget", input: budget(amount), ...AGENT })
      .then(
        () => "ok",
        (e: unknown) => (e instanceof ChangeError ? e.message : String(e)),
      );

  it("150 at once: 20 a minute get to Google, the rest are refused before any read", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 100 }) });
    const results: string[] = [];
    for (let i = 0; i < 150; i++) results.push(await proposeOnce(rig));
    expect(results.filter((r) => r === "ok")).toHaveLength(20);
    expect(results[20]).toBe(
      "20 changes were proposed for this account in the last minute; the policy allows 20 a minute (limits.proposals_per_minute). Try again in a minute.",
    );
    expect(rig.fake.validations()).toBe(20);
    const searches = rig.fake.searches();
    await proposeOnce(rig);
    expect(rig.fake.searches()).toBe(searches); // refused before reading Google
    expect(rig.refusals().filter((r) => r.rule === "limits.proposals_per_minute")).toHaveLength(
      131,
    );
    // The limit's own refusals don't count: a minute later proposals work again.
    rig.clock.now += 61_000;
    expect(await proposeOnce(rig)).toBe("ok");
  });

  it("150 spread out: the day limit stops them; refused-after-reading attempts count too", async () => {
    rig = makePolicyRig({
      policy: policyYaml({ cap: 100, proposalsPerMinute: 1000, proposalsPerDay: 100 }),
    });
    const results: string[] = [];
    for (let i = 0; i < 150; i++) {
      // Every 3rd one is over the percent limit: refused by the policy after reading Google.
      results.push(await proposeOnce(rig, i % 3 === 0 ? "20" : "10.50"));
      rig.clock.now += 1_000;
    }
    expect(results.slice(100).every((r) => /allows 100 a day/.test(r))).toBe(true);
    expect(results.slice(0, 100).some((r) => /at most 30%/.test(r))).toBe(true);
    expect(rig.fake.validations()).toBeLessThan(100);
  });

  it("a burst against the minute limit doesn't use up the day limit", async () => {
    rig = makePolicyRig({
      policy: policyYaml({ cap: 100, proposalsPerMinute: 5, proposalsPerDay: 30 }),
    });
    for (let i = 0; i < 45; i++) await proposeOnce(rig);
    expect(rig.fake.validations()).toBe(5);
    rig.clock.now += 61_000;
    expect(await proposeOnce(rig)).toBe("ok");
  });

  it("undo is never held back by the proposal limits", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 100, proposalsPerMinute: 1 }) });
    const v = await rig.proposeApproved("update_budget", budget("9"));
    await rig.engine.apply(v.id, AGENT);
    expect(await proposeOnce(rig)).toMatch(/allows 1 a minute/);
    expect((await rig.engine.proposeUndo(v.id, AGENT)).status).toBe("proposed");
  });
});

describe("bypass: parallel proposals and undo loops", () => {
  const proposeOnce = (r: PolicyRig, amount = "10.50", engine = r.engine) =>
    engine
      .propose({ customerId: ACCOUNT, type: "update_budget", input: budget(amount), ...AGENT })
      .then(
        () => "ok",
        (e: unknown) => (e instanceof ChangeError ? e.message : String(e)),
      );

  it("40 parallel proposals at 5 a minute (two connections): exactly 5 reach Google", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 100, proposalsPerMinute: 5 }) });
    const other = rig.second().engine;
    const r = rig;
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => proposeOnce(r, "10.50", i % 2 ? other : r.engine)),
    );
    expect(results.filter((x) => x === "ok")).toHaveLength(5);
    expect(rig.fake.validations()).toBe(5);
    expect(results.filter((x) => /allows 5 a minute/.test(x))).toHaveLength(35);
  });

  it("an attempt that failed counts; one left unfinished by a crash stops counting after 10 minutes", async () => {
    rig = makePolicyRig({
      policy: policyYaml({ cap: 100, proposalsPerMinute: 2, proposalsPerDay: 2 }),
    });
    expect(await proposeOnce(rig, "20")).toMatch(/at most 30%/); // failed after reading: counts
    rig.store.db
      .prepare(
        "INSERT INTO proposal_attempts (customer_id, kind, started_at) VALUES (?, 'propose', ?)",
      )
      .run(ACCOUNT, new Date(rig.clock.now).toISOString()); // a crashed server's row
    rig.clock.now += 2 * 60_000;
    expect(await proposeOnce(rig)).toMatch(/allows 2 a day/);
    rig.clock.now += 10 * 60_000;
    expect(await proposeOnce(rig)).toBe("ok");
  });

  it("120 refused undos: reads stop after the per-change limit; normal proposals still work", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 100 }) });
    const cut = await rig.proposeApproved("update_budget", budget("7"));
    expect((await rig.engine.apply(cut.id, AGENT)).status).toBe("verified");
    // Tight spend cap: every undo (+3.00 EUR) is refused after reading Google.
    rig.writePolicy(policyYaml({ cap: 1 }));
    const searches = rig.fake.searches();
    const out: string[] = [];
    for (let i = 0; i < 120; i++) {
      out.push(
        await rig.engine.proposeUndo(cut.id, AGENT).then(
          () => "ok",
          (e: unknown) => (e as Error).message,
        ),
      );
    }
    const readsFor3 = rig.fake.searches() - searches;
    expect(out.slice(0, 3).every((m) => /adds 3.00 EUR/.test(m))).toBe(true);
    expect(out.slice(3).every((m) => /already tried 3 times in the last minute/.test(m))).toBe(
      true,
    );
    expect(readsFor3).toBeLessThanOrEqual(3 * 3);
    // Spread over hours: at most 20 a day reach Google.
    for (let i = 0; i < 120; i++) {
      rig.clock.now += 30_000;
      out.push(
        await rig.engine.proposeUndo(cut.id, AGENT).then(
          () => "ok",
          (e: unknown) => (e as Error).message,
        ),
      );
    }
    expect(out.filter((m) => /adds 3.00 EUR/.test(m))).toHaveLength(20);
    expect(out.at(-1)).toMatch(/already tried 20 times in the last 24 hours/);
    // Refusals are tagged with the change they undo; undos never count as proposals.
    expect(rig.refusals().filter((r) => r.undoOf === cut.id).length).toBeGreaterThan(200);
    rig.writePolicy(policyYaml({ cap: 100, proposalsPerMinute: 1 }));
    expect(await proposeOnce(rig, "6.50")).toBe("ok");
  });

  it("undo_per_day per account (policy key) across different changes", async () => {
    rig = makePolicyRig({
      world: manyCampaigns(),
      policy: policyYaml({ cap: 100, undoPerDay: 2 }),
    });
    const ids: string[] = [];
    for (const b of ["223", "224", "225"]) {
      const v = await rig.proposeApproved("update_budget", budget("5", b));
      await rig.engine.apply(v.id, AGENT);
      ids.push(v.id);
    }
    expect((await rig.engine.proposeUndo(ids[0] ?? "", AGENT)).status).toBe("proposed");
    expect((await rig.engine.proposeUndo(ids[1] ?? "", AGENT)).status).toBe("proposed");
    const err = await refusedWith(rig.engine.proposeUndo(ids[2] ?? "", AGENT));
    expect(err.message).toMatch(
      /2 undos were tried on this account in the last 24 hours; the policy allows 2 a day/,
    );
  });
});

describe("bypass: switching the kind of target", () => {
  it("target CPA -> target ROAS and target ROAS -> target CPA on a campaign are refused", async () => {
    const w = fakeWorld();
    w.campaigns["334"] = {
      id: "334",
      name: "Value campaign",
      status: "ENABLED",
      advertisingChannelType: "SEARCH",
      budgetId: "222",
      biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE",
      maximizeConversionValue: { targetRoas: 4 },
    };
    // over Google's value-bidding minimum, so the policy is what refuses
    w.conversions30d = { "333": 40 };
    rig = makePolicyRig({ world: w, policy: policyYaml({ cap: 100 }) });
    const toRoas = await refusedWith(
      rig.engine.propose({
        customerId: ACCOUNT,
        type: "update_bidding",
        input: {
          campaign_id: "333",
          strategy: "MAXIMIZE_CONVERSION_VALUE",
          target_roas_percent: 400,
        },
        ...AGENT,
      }),
    );
    expect(toRoas.message).toMatch(/switches from target CPA to target ROAS/);
    const toCpa = await refusedWith(
      rig.engine.propose({
        customerId: ACCOUNT,
        type: "update_bidding",
        input: { campaign_id: "334", strategy: "MAXIMIZE_CONVERSIONS", target_cpa: "5" },
        ...AGENT,
      }),
    );
    expect(toCpa.message).toMatch(/switches from target ROAS to target CPA/);
    expect(rig.fake.validations()).toBe(0);
    expect(rig.refusals()).toHaveLength(2);
  });
});

describe("bypass: undo used as a raise", () => {
  it("an exact undo may pass the percent limit but counts against the 24-hour spend; kill switch stops it", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 2 }) });
    const cut = await rig.proposeApproved("update_budget", budget("7"));
    expect((await rig.engine.apply(cut.id, AGENT)).status).toBe("verified");
    // 7 -> 10 = +42.9 % (over 30 %, fine for an exact undo) but +3.00 EUR > 2.00 EUR cap.
    const err = await refusedWith(rig.engine.proposeUndo(cut.id, AGENT));
    expect(err.message).toMatch(/adds 3.00 EUR of daily spend.*only 2.00 EUR is left/);
    rig.writePolicy(policyYaml({ cap: 5 }));
    const undo = await rig.engine.proposeUndo(cut.id, AGENT);
    expect(undo.diff.join(" ")).toMatch(/7.00 EUR -> 10.00 EUR/);
    rig.writePolicy(policyYaml({ cap: 5, kill: true }));
    const approved = rig.engine.markApproved(undo.id, undo.version, "cli", "tester");
    expect((await refusedWith(rig.engine.apply(approved.id, AGENT))).message).toMatch(
      /kill_switch is true/,
    );
    expect(rig.fake.writes()).toBe(1);
  });

  it("an undo can't exceed the percent limit unless it puts back exactly the old value", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 100 }) });
    // A plain change that happens to go back up by the same step is a normal change.
    const cut = await rig.proposeApproved("update_budget", budget("7"));
    await rig.engine.apply(cut.id, AGENT);
    const err = await refusedWith(
      rig.engine.propose({
        customerId: ACCOUNT,
        type: "update_budget",
        input: budget("10"),
        ...AGENT,
      }),
    );
    expect(err.message).toMatch(/by 42.9%.*at most 30%/);
  });
});

describe("bypass: the policy file changes between propose and apply", () => {
  it("a looser file never helps a change proposed under a stricter one (both must pass)", async () => {
    rig = makePolicyRig({ world: manyCampaigns(), policy: policyYaml({ cap: 9 }) });
    const big = await rig.proposeApproved("update_budget", budget("7.80", "223")); // +1.80, fine alone
    const first = await rig.proposeApproved("update_budget", budget("7.80", "224")); // +1.80
    expect((await rig.engine.apply(first.id, AGENT)).status).toBe("verified");
    const more = await rig.proposeApproved("update_campaign_status", enable("336")); // +6.00
    expect((await rig.engine.apply(more.id, AGENT)).status).toBe("verified");
    // 7.80 used: big would make 9.60 > 9. The file is loosened to 100 before big is applied.
    rig.writePolicy(policyYaml({ cap: 100 }));
    const err = await refusedWith(rig.engine.apply(big.id, AGENT));
    expect(err.message).toMatch(
      /stricter of the two versions applies, and the earlier one says: This adds 1.80 EUR of daily spend; 7.80 EUR was already added/,
    );
    expect(rig.engine.get(big.id)?.status).toBe("approved");
  });

  it("a stricter file refuses a change proposed under a looser one, and the switch is logged", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 10 }) });
    const v = await rig.proposeApproved("update_budget", budget("12.50"));
    rig.writePolicy(policyYaml({ cap: 1 }));
    expect((await refusedWith(rig.engine.apply(v.id, AGENT))).message).toMatch(
      /adds 2.50 EUR.*1.00 EUR 24-hour limit/,
    );
    const { listEvents } = await import("@perfoads/changes");
    const events = listEvents(rig.store).map((e) => e.event);
    expect(events).toContain("policy_changed");
    expect(events.filter((e) => e === "policy_loaded").length).toBeGreaterThanOrEqual(2);
    expect(rig.fake.writes()).toBe(0);
  });
});

describe("bypass: a broken or misplaced policy file", () => {
  it("malformed YAML = read-only, refused with a plain message and logged", async () => {
    rig = makePolicyRig({ policy: 'version: 1\naccounts: { allow: ["1234567890"\n' });
    const err = await refusedWith(
      rig.engine.propose({
        customerId: ACCOUNT,
        type: "update_budget",
        input: budget("10.50"),
        ...AGENT,
      }),
    );
    expect(err.message).toMatch(/Writes are off: the policy file is not valid \(YAML/);
    expect(rig.refusals()).toHaveLength(1);
  });

  it("a valid-looking file with one unknown key = read-only (never partly valid)", async () => {
    rig = makePolicyRig({ policy: `${policyYaml({ cap: 100 })}allow_everything: true\n` });
    const err = await refusedWith(
      rig.engine.propose({
        customerId: ACCOUNT,
        type: "update_budget",
        input: budget("10.50"),
        ...AGENT,
      }),
    );
    expect(err.message).toMatch(/unknown key allow_everything/);
  });

  it("an approved change after the file breaks: refused at apply", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 10 }) });
    const v = await rig.proposeApproved("update_budget", budget("11"));
    rig.writePolicy("kill_switch: [");
    expect((await refusedWith(rig.engine.apply(v.id, AGENT))).message).toMatch(/not valid/);
    expect(rig.fake.writes()).toBe(0);
  });
});

describe("bypass: kill switch mid-apply", () => {
  it("switched on after apply's pre-check: the claim reads the file again and refuses", async () => {
    let flip = false;
    rig = makePolicyRig({
      policy: policyYaml({ cap: 10 }),
      wrapPolicy: (file, r): PolicyCheck => ({
        ...file,
        name: file.name,
        gate: (id, type) => file.gate(id, type),
        check: (req) => {
          const d = file.check(req);
          // The person flips the switch right after the pre-check passed.
          if (req.stage === "apply" && flip) r().writePolicy(policyYaml({ cap: 10, kill: true }));
          return d;
        },
        liveWrites: (id) => file.liveWrites(id),
      }),
    });
    const v = await rig.proposeApproved("update_budget", budget("11"));
    flip = true;
    const err = await refusedWith(rig.engine.apply(v.id, AGENT));
    expect(err.message).toMatch(/kill_switch is true/);
    expect(rig.engine.get(v.id)?.status).toBe("approved");
    expect(rig.fake.writes()).toBe(0);
    expect(rig.refusals()).toEqual([expect.objectContaining({ changeId: v.id, stage: "claim" })]);
  });
});

describe("bypass: auto tier", () => {
  it("auto for a budget raise (not low risk) stays confirm: no self-approval", async () => {
    rig = makePolicyRig({
      policy: policyYaml({ cap: 10, tiers: "update_budget: auto, update_bidding: auto" }),
    });
    const v = await rig.engine.propose({
      customerId: ACCOUNT,
      type: "update_budget",
      input: budget("11"),
      ...AGENT,
    });
    expect(v.riskTier).toBe("confirm");
    const err = await refusedWith(
      Promise.resolve().then(() => rig?.engine.autoApprove(v.id, AGENT)),
    );
    expect(err.code).toBe("not_allowed");
    const bid = await rig.engine.propose({
      customerId: ACCOUNT,
      type: "update_bidding",
      input: { campaign_id: "333", target_cpa: "5.50" },
      ...AGENT,
    });
    expect(bid.riskTier).toBe("confirm");
    expect(rig.engine.get(v.id)?.status).toBe("proposed");
  });

  it("auto for a budget decrease: approved by the policy (policy_auto + hash), full lifecycle, verified", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 10, tiers: "update_budget: auto" }) });
    const v = await rig.engine.propose({
      customerId: ACCOUNT,
      type: "update_budget",
      input: budget("8"),
      ...AGENT,
    });
    expect(v.riskTier).toBe("auto");
    const a = rig.engine.autoApprove(v.id, AGENT);
    expect(a.approvedVia).toBe("policy_auto");
    expect(a.approvedBy).toMatch(/^policy [0-9a-f]{12}$/);
    expect((await rig.engine.apply(a.id, AGENT)).status).toBe("verified");
  });

  it("auto turned off after propose or after the auto approval: refused, nothing sent", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 10, tiers: "update_budget: auto" }) });
    const v = await rig.engine.propose({
      customerId: ACCOUNT,
      type: "update_budget",
      input: budget("8"),
      ...AGENT,
    });
    const a = rig.engine.autoApprove(v.id, AGENT);
    rig.writePolicy(policyYaml({ cap: 10, tiers: "update_budget: confirm" }));
    expect((await refusedWith(rig.engine.apply(a.id, AGENT))).message).toMatch(
      /no longer lets this change apply without a person/,
    );
    const w = await rig.engine.propose({
      customerId: ACCOUNT,
      type: "update_budget",
      input: budget("9"),
      ...AGENT,
    });
    expect(w.riskTier).toBe("confirm");
    expect(rig.fake.writes()).toBe(0);
  });

  it("a stored auto tier can't be approved by the policy once the file says confirm", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 10, tiers: "update_budget: auto" }) });
    const v = await rig.engine.propose({
      customerId: ACCOUNT,
      type: "update_budget",
      input: budget("8"),
      ...AGENT,
    });
    rig.writePolicy(policyYaml({ cap: 10, tiers: "update_budget: confirm" }));
    const err = await refusedWith(
      Promise.resolve().then(() => rig?.engine.autoApprove(v.id, AGENT)),
    );
    expect(err.message).toMatch(/needs a person's approval/);
    expect(rig.refusals().at(-1)).toMatchObject({ stage: "approve", code: "policy_refused" });
  });

  it("the file switches auto off between autoApprove's first check and its transaction: refused", async () => {
    let approveChecks = 0;
    rig = makePolicyRig({
      policy: policyYaml({ cap: 10, tiers: "update_budget: auto" }),
      wrapPolicy: (file, r): PolicyCheck => ({
        ...file,
        name: file.name,
        gate: (id, type) => file.gate(id, type),
        check: (req) => {
          const d = file.check(req);
          if (req.stage === "approve" && ++approveChecks === 1) {
            r().writePolicy(policyYaml({ cap: 10, tiers: "update_budget: confirm" }));
          }
          return d;
        },
        liveWrites: (id) => file.liveWrites(id),
      }),
    });
    const v = await rig.engine.propose({
      customerId: ACCOUNT,
      type: "update_budget",
      input: budget("8"),
      ...AGENT,
    });
    const err = await refusedWith(
      Promise.resolve().then(() => rig?.engine.autoApprove(v.id, AGENT)),
    );
    expect(err.message).toMatch(/needs a person's approval/);
    expect(rig.engine.get(v.id)?.status).toBe("proposed");
  });

  it("markApproved can't record policy_auto: only the engine's autoApprove can", async () => {
    rig = makePolicyRig({ policy: policyYaml({ cap: 10, tiers: "update_budget: auto" }) });
    const v = await rig.engine.propose({
      customerId: ACCOUNT,
      type: "update_budget",
      input: budget("8"),
      ...AGENT,
    });
    expect(() =>
      rig?.engine.markApproved(v.id, v.version, "policy_auto" as unknown as "cli", "x"),
    ).toThrow(/Unknown approval path/);
  });
});

describe("bypass: live (not test) accounts", () => {
  it("lifted only by accounts.write in a valid policy; read live at apply", async () => {
    rig = makePolicyRig({
      world: fakeWorld({ testAccount: false }),
      policy: policyYaml({ cap: 10 }),
    });
    const v = await rig.proposeApproved("update_budget", budget("11"));
    expect((await rig.engine.apply(v.id, AGENT)).status).toBe("verified");
    // The same account without a write entry: refused before anything (gate) ...
    rig.writePolicy(policyYaml({ cap: 10, write: false }));
    expect(
      (
        await refusedWith(
          rig.engine.propose({
            customerId: ACCOUNT,
            type: "update_budget",
            input: budget("12"),
            ...AGENT,
          }),
        )
      ).message,
    ).toMatch(/read-only: the policy file does not list it under accounts.write/);
  });
});
