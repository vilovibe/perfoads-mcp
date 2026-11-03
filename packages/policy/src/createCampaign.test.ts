// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// create_campaign under the real policy file: the ops cap, the PAUSED default, and the
// link to new spend (turning the new campaign on counts its budget).

import { ChangeError } from "@perfoads/changes";
import { createHooks, createWorld, fakeWorld, moreWorld } from "@perfoads/changes/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT, AGENT, makePolicyRig, policyYaml, type PolicyRig } from "./testing/rig.js";

let rig: PolicyRig | undefined;
afterEach(() => {
  rig?.close();
  rig = undefined;
});

const PAT = { actor: "Pat", via: "cli" } as const;

const input = (over: Record<string, unknown> = {}) => ({
  name: "Spring search",
  campaign_type: "SEARCH",
  daily_budget: "25",
  bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
  networks: { google_search: true, search_partners: false, display: false },
  locations: { geo_target_ids: ["2840"], targeting: "PRESENCE" },
  language_ids: ["1000"],
  contains_eu_political_advertising: false,
  ...over,
});

const setup = (yaml: string): PolicyRig => {
  const world = { ...fakeWorld(), more: moreWorld() };
  const r = makePolicyRig({ world, policy: yaml });
  Object.assign(r.fake.hooks, createHooks(world, createWorld()));
  rig = r;
  return r;
};

const errOf = async (p: Promise<unknown>): Promise<ChangeError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChangeError) return e;
    throw e;
  }
  throw new Error("expected a ChangeError");
};

describe("create_campaign under the policy file", () => {
  it("max_ops_per_change counts every operation of the one atomic request", async () => {
    const r = setup(
      policyYaml().replace("  undo_per_day", "  max_ops_per_change: 3\n  undo_per_day"),
    );
    const e = await errOf(
      r.engine.propose({ customerId: ACCOUNT, type: "create_campaign", input: input(), ...AGENT }),
    );
    expect(e.code).toBe("policy_refused");
    expect(e.message).toContain("This change has 4 operations; the policy allows at most 3");
    expect(r.fake.validations()).toBe(0);
  });

  it("making it is not new spend; turning it on counts its budget against max_new_daily_spend", async () => {
    const r = setup(policyYaml({ cap: 30 }));
    const made = await r.proposeApproved("create_campaign", input());
    const v = await r.engine.apply(made.id, PAT);
    expect(v.status).toBe("verified");
    const id = Object.values(r.fake.world.campaigns).find((c) => c.name === "Spring search")?.id;
    expect(id).toBeTruthy();
    const on = await r.proposeApproved("update_campaign_status", {
      campaign_id: id,
      status: "ENABLED",
    });
    expect(on.facts.newlyEnabled?.[0]?.dailyBudgetMicros).toBe("25000000");
    expect((await r.engine.apply(on.id, PAT)).status).toBe("verified");

    // A second one: 25 more would pass 30 in 24 hours, so turning it on is refused.
    const second = await r.proposeApproved("create_campaign", input({ name: "Autumn search" }));
    expect((await r.engine.apply(second.id, PAT)).status).toBe("verified");
    const id2 = Object.values(r.fake.world.campaigns).find((c) => c.name === "Autumn search")?.id;
    const e = await errOf(
      r.engine.propose({
        customerId: ACCOUNT,
        type: "update_campaign_status",
        input: { campaign_id: id2, status: "ENABLED" },
        ...AGENT,
      }),
    );
    expect(e.code).toBe("policy_refused");
    expect(e.message).toContain("This adds 25.00 EUR of daily spend");
  });
});
