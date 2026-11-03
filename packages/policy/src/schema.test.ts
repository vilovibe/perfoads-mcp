// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { starterPolicy } from "./describe.js";
import { parsePolicyText } from "./schema.js";

const PLAN_EXAMPLE = `version: 1
accounts: { allow: ["1234567890"], write: ["1234567890"] }
limits:
  max_budget_change_pct: 30
  max_budget_change_abs: { "1234567890": 50 }
  max_new_daily_spend: { "1234567890": 100 }
  max_target_change_pct: 20
  writes_per_day: 50
  writes_per_minute: 10
  max_ops_per_change: 200
defaults: { new_entities_paused: true, broad_match_requires_smart_bidding: true }
tiers: { "remove_*": blocked, update_budget: confirm }
ops_budget: { warn_at_pct: 80, reserve_for_writes_pct: 20 }
kill_switch: false
`;

const problems = (text: string): string[] => {
  const r = parsePolicyText(text);
  if (r.ok) throw new Error("expected invalid");
  return r.problems;
};

describe("policy.yaml schema v1", () => {
  it("accepts the plan's example exactly", () => {
    const r = parsePolicyText(PLAN_EXAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.accounts).toEqual({ allow: ["1234567890"], write: ["1234567890"] });
    expect(r.policy.limits.max_new_daily_spend).toEqual({ "1234567890": 100 });
    expect(r.policy.tiers).toEqual({ "remove_*": "blocked", update_budget: "confirm" });
    expect(r.policy.defaults).toEqual({
      new_entities_paused: true,
      broad_match_requires_smart_bidding: true,
    });
  });

  it("fills safe defaults and normalises dashed ids", () => {
    const r = parsePolicyText(
      'version: 1\naccounts: { allow: ["123-456-7890"] }\nlimits: { max_new_daily_spend: { "123-456-7890": 5 } }\n',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.accounts).toEqual({ allow: ["1234567890"], write: [] });
    expect(r.policy.limits).toMatchObject({
      max_budget_change_pct: 30,
      max_target_change_pct: 20,
      writes_per_day: 50,
      writes_per_minute: 10,
      max_ops_per_change: 200,
      max_new_daily_spend: { "1234567890": 5 },
      max_budget_change_abs: {},
    });
    expect(r.policy.kill_switch).toBe(false);
    expect(r.policy.ops_budget).toEqual({ warn_at_pct: 80, reserve_for_writes_pct: 20 });
    expect(r.policy.defaults.new_entities_paused).toBe(true);
  });

  it("an unknown key anywhere makes the whole file invalid", () => {
    expect(problems(`${PLAN_EXAMPLE}extra: 1\n`).join(" ")).toMatch(/unknown key extra/);
    expect(
      problems(PLAN_EXAMPLE.replace("writes_per_day: 50", "writes_per_dya: 50")).join(" "),
    ).toMatch(/limits: unknown key writes_per_dya/);
    expect(
      problems(PLAN_EXAMPLE.replace("warn_at_pct: 80", "warn_at_pct: 80, reserve: 1")).join(" "),
    ).toMatch(/ops_budget: unknown key reserve/);
    expect(
      problems(
        PLAN_EXAMPLE.replace("new_entities_paused: true", "new_entities_paused: true, x: 1"),
      ),
    ).not.toHaveLength(0);
  });

  it("malformed YAML, duplicate keys, aliases and an empty file are invalid", () => {
    expect(problems("version: 1\naccounts: { allow: [\n").join(" ")).toMatch(/YAML/);
    expect(problems(`${PLAN_EXAMPLE}kill_switch: true\n`).join(" ")).toMatch(/YAML/);
    expect(
      problems(
        'version: 1\naccounts: &a { allow: ["1234567890"], write: [] }\nlimits: { max_new_daily_spend: *a }\n',
      ).join(" "),
    ).toMatch(/YAML|alias/i);
    expect(problems("").join(" ")).toMatch(/empty/);
    expect(problems("# only a comment\n").join(" ")).toMatch(/empty/);
  });

  it("wrong values are refused, never coerced", () => {
    // YAML 1.1 style booleans are strings in the 1.2 core schema.
    expect(
      problems(PLAN_EXAMPLE.replace("kill_switch: false", "kill_switch: no")).join(" "),
    ).toMatch(/kill_switch/);
    // An unquoted id is a number (and would lose a leading zero).
    expect(problems("version: 1\naccounts: { allow: [0123456789] }\n").join(" ")).toMatch(/quoted/);
    expect(problems('version: 2\naccounts: { allow: ["1234567890"] }\n').join(" ")).toMatch(
      /version must be 1/,
    );
    expect(
      problems(PLAN_EXAMPLE.replace("max_budget_change_pct: 30", "max_budget_change_pct: -5")),
    ).not.toHaveLength(0);
    expect(
      problems(PLAN_EXAMPLE.replace("writes_per_day: 50", "writes_per_day: 2.5")),
    ).not.toHaveLength(0);
    expect(
      problems(PLAN_EXAMPLE.replace('"1234567890": 100', '"1234567890": 0.0000001')).join(" "),
    ).toMatch(/6 decimals/);
    expect(
      problems(PLAN_EXAMPLE.replace("update_budget: confirm", "update_budget: yes")).join(" "),
    ).toMatch(/auto, confirm or blocked/);
    expect(problems(PLAN_EXAMPLE.replace('"remove_*"', '"re*move"')).join(" ")).toMatch(/tier key/);
    expect(
      problems(PLAN_EXAMPLE.replace("reserve_for_writes_pct: 20", "reserve_for_writes_pct: 95")),
    ).not.toHaveLength(0);
  });

  it("refuses one account listed twice and limits for accounts the policy does not list", () => {
    expect(
      problems(
        PLAN_EXAMPLE.replace(
          'max_new_daily_spend: { "1234567890": 100 }',
          'max_new_daily_spend: { "1234567890": 100, "123-456-7890": 900 }',
        ),
      ).join(" "),
    ).toMatch(/listed twice/);
    expect(
      problems(
        PLAN_EXAMPLE.replace(
          'max_new_daily_spend: { "1234567890": 100 }',
          'max_new_daily_spend: { "1234567890": 100, "9876543210": 5 }',
        ),
      ).join(" "),
    ).toMatch(/9876543210: this account is not in accounts.allow/);
  });

  it("the starter policy from init is valid and read-only", () => {
    const r = parsePolicyText(starterPolicy(["1234567890"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.accounts).toEqual({ allow: ["1234567890"], write: [] });
    expect(r.policy.tiers).toEqual({ "remove_*": "blocked" });
  });

  it("brand_terms: per listed account, dashes normalised, limits checked", () => {
    const ok = parsePolicyText(
      'version: 1\naccounts: { allow: ["123-456-7890"], write: [] }\nbrand_terms: { "123-456-7890": ["Contoso", " Contoso Shoes "] }\n',
    );
    expect(ok.ok && ok.policy.brand_terms).toEqual({ "1234567890": ["Contoso", "Contoso Shoes"] });
    expect(
      problems(
        'version: 1\naccounts: { allow: ["1234567890"], write: [] }\nbrand_terms: { "1111111111": ["x"] }\n',
      ),
    ).toEqual(["brand_terms.1111111111: this account is not in accounts.allow or accounts.write"]);
    expect(
      problems(
        'version: 1\naccounts: { allow: ["1234567890"], write: [] }\nbrand_terms: { "1234567890": [""] }\n',
      )[0],
    ).toContain("must not be empty");
    expect(
      problems(
        'version: 1\naccounts: { allow: ["1234567890"], write: [] }\nbrand_terms: { "1234567890": ["--"] }\n',
      )[0],
    ).toContain("needs a letter or digit");
  });
});
