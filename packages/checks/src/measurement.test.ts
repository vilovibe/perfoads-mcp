// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import type { EvidenceInput } from "./api.js";
import { makeMetricLookups } from "./engine/adapters.js";
import type { CheckResult } from "./engine/checks/types.js";
import { confoundersFor } from "./engine/interactions/matrix.js";
import { DEFAULT_CONFOUNDER_THRESHOLDS } from "./engine/interactions/types.js";
import type { Row } from "./engine/shared/input.js";
import {
  buildInput,
  checkCtxOf,
  dayBefore,
  LAST_DAY,
  runOne,
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

/** A conversion action row (90-day totals). */
const action = (r: {
  id: string;
  name?: string;
  category?: string;
  primary?: boolean;
  status?: string;
  model?: string;
  conv?: number;
  value?: number;
  lookback?: number;
  include?: boolean | null;
  origin?: string;
}): Row => ({
  action_id: r.id,
  name: r.name ?? `Action ${r.id}`,
  status: r.status ?? "ENABLED",
  type: "WEBPAGE",
  category: r.category ?? "PURCHASE",
  origin: r.origin ?? "WEBSITE",
  is_primary: r.primary ?? true,
  include_in_conversions: r.include ?? null,
  counting_type: "MANY_PER_CLICK",
  attribution_model: r.model ?? "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN",
  lookback_window_days: r.lookback ?? 30,
  view_through_window_days: 1,
  total_conversions: r.conv ?? 90,
  total_value: r.value ?? 9000,
});

/** One row per day the action fired, `from` to `to` days before LAST_DAY. */
const daily = (actionId: string, from: number, to: number, conv = 2): Row[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    conversion_action_id: actionId,
    date: dayBefore(LAST_DAY, from + i),
    conversions: conv,
    conversions_value: conv * 100,
  }));

const generic: CampaignSpec = { id: "11", name: "Generic search" };
const account = (opts: Partial<FixtureOptions> = {}, campaigns: CampaignSpec[] = [generic]) =>
  buildInput({ campaigns, ...opts });
const withDaily = (rows: Row[], actions: Row[] = [action({ id: "61" })]) =>
  withStatus(
    account({ data: { conversionActions: actions }, tables: { conversion_action_daily: rows } }),
    "conversion_action_daily",
    rows.length,
  );

describe("MI01 primary action stopped firing", () => {
  it("fires on a primary action silent past its own rhythm, up to the settled day", () => {
    // fired every day from 89 to 46 days ago, then nothing: silent through the settled day (30 days ago)
    const r = runOne("MI01", withDaily(daily("61", 46, 89)));
    expect(findingsOf(r)[0]?.scope.id).toBe("61");
  });
  it("is clean when it fires every day", () => {
    expect(state(runOne("MI01", withDaily(daily("61", 0, 89))))).toBe("none_found");
  });
  it("judges a 30-day action next to a hidden 90-day one and a 90-day sign-up", () => {
    const actions = [
      action({ id: "61" }),
      action({ id: "62", status: "HIDDEN", lookback: 90, conv: 0 }),
      action({ id: "63", category: "SIGNUP", lookback: 90 }),
    ];
    const r = runOne("MI01", withDaily([...daily("61", 0, 89), ...daily("63", 0, 89)], actions));
    expect(state(r)).toBe("none_found");
    expect(r.state === "none_found" ? r.population : null).toBe(1);
    // the sign-up keeps its own reason, never "carries no day"
    expect(r.state === "none_found" ? r.note : "").toContain("precedes the window start");
  });
  it("a switched-on primary with no day and 0 conversions all window blocks clean", () => {
    const actions = [action({ id: "61" }), action({ id: "62", name: "Old checkout", conv: 0 })];
    const r = runOne("MI01", withDaily(daily("61", 0, 89), actions));
    expect(state(r)).toBe("not_checkable");
    expect(r.state === "not_checkable" ? r.reason : "").toContain(
      "Old checkout: switched on and primary, but recorded no conversion",
    );
  });
  it("an action whose lookback reaches before the window is too short to judge (by code, not text)", () => {
    const actions = [action({ id: "61", lookback: 120 })];
    const input = withDaily(daily("61", 0, 89), actions);
    const silent = checkCtxOf(input).get("CA.silent_days(action)", { actionId: "61" });
    expect("code" in silent ? silent.code : null).toBe("settled_before_window");
    const r = runOne("MI01", input);
    expect(r.state === "not_checkable" ? r.category : null).toBe("no_history");
  });
  it("is not checkable with no primary action, or without the daily series", () => {
    const secondary = withDaily(daily("61", 0, 89), [action({ id: "61", primary: false })]);
    expect(state(runOne("MI01", secondary))).toBe("not_checkable");
    const noDaily = account({ data: { conversionActions: [action({ id: "61" })] } });
    expect(state(runOne("MI01", noDaily))).toBe("not_checkable");
  });
});

describe("MI01 confounder", () => {
  it("names the silent action's own settled day, not the account-wide one", () => {
    const actions = [
      action({ id: "61", name: "Purchase" }),
      action({ id: "63", category: "SIGNUP", lookback: 90 }),
    ];
    const ctx = checkCtxOf(withDaily([...daily("61", 46, 89), ...daily("63", 0, 89)], actions));
    const c = confoundersFor("MI02").find((x) => x.confounderId === "MI01");
    if (!c) throw new Error("MI02 has no MI01 confounder");
    const r = c.resolve({
      model: ctx.model,
      metrics: makeMetricLookups(ctx.metrics).forInteractions,
      scope: { kind: "account", id: ctx.model.id, scope: "account" },
      thresholds: DEFAULT_CONFOUNDER_THRESHOLDS,
    });
    // the 30-day purchase settles on 2026-08-02; the 90-day sign-up would put the account on 2026-06-03
    expect(r.note).toContain(`its last settled day (${dayBefore(LAST_DAY, 30)})`);
  });

  // Phase F: the confounder judges the way the MI01 check does
  const resolveMI01 = (input: EvidenceInput) => {
    const ctx = checkCtxOf(input);
    const c = confoundersFor("TR01").find((x) => x.confounderId === "MI01");
    if (!c) throw new Error("TR01 has no MI01 confounder");
    return c.resolve({
      model: ctx.model,
      metrics: makeMetricLookups(ctx.metrics).forInteractions,
      scope: { kind: "campaign", id: "11", scope: "campaign" },
      thresholds: DEFAULT_CONFOUNDER_THRESHOLDS,
    });
  };

  it("Live shop: a primary YouTube action that counted 0 conversions cannot explain a decline", () => {
    // YouTube follow-on views: primary, switched on, 0 in the Conversions column, a few
    // all-conversions on scattered days, last one 5 days before its settled day
    const yt = action({ id: "72", name: "YouTube follow-on views", conv: 0, value: 0 });
    const ytDays = [35, 44, 50, 58, 60, 69, 70, 71, 82, 83].map((n) => ({
      conversion_action_id: "72",
      date: dayBefore(LAST_DAY, n),
      conversions: 0,
      conversions_value: 0,
      all_conversions: 1,
    }));
    const input = withDaily(
      [...daily("61", 0, 89), ...ytDays],
      [action({ id: "61", name: "Purchase" }), yt],
    );
    const r = resolveMI01(input);
    expect(r.state).toBe("cleared");
    // and the MI01 check agrees: no silent primary
    expect(state(runOne("MI01", input))).not.toBe("fires");
  });

  /** the account spent nothing before `firstSpend` days ago (it started mid-window) */
  const startedAt = (input: EvidenceInput, firstSpend: number): EvidenceInput => {
    const cut = dayBefore(LAST_DAY, firstSpend);
    const zero = (r: Row): Row =>
      String(r.metric_date) < cut
        ? { ...r, cost: 0, clicks: 0, impressions: 0, conversions: 0, conversion_value: 0 }
        : r;
    return {
      ...input,
      data: {
        ...input.data,
        dailyMetrics: (input.data.dailyMetrics ?? []).map(zero),
        campaignDailyMetrics: (input.data.campaignDailyMetrics ?? []).map(zero),
      },
    };
  };

  it("an account that started mid-window: silence is counted from its first day with spend", () => {
    // the account first spent 50 days ago; the purchase action fired only after its settled
    // day (30 days ago). Days before the account spent are not silence: 21 days, never 60.
    const input = startedAt(withDaily(daily("61", 0, 20)), 50);
    const silent = checkCtxOf(input).get("CA.silent_days(action)", { actionId: "61" });
    expect("value" in silent ? silent.value : null).toBe(21);
  });

  it("an account that first spent after the last settled day: nothing judged, never 'clean'", () => {
    const late = startedAt(withDaily(daily("61", 0, 20)), 25);
    const none = checkCtxOf(late).get("CA.silent_days(action)", { actionId: "61" });
    expect(none.value).toBeNull();
    expect("code" in none ? none.code : null).toBe("no_settled_spend_day");
    // the check does not run, and says why
    const r = runOne("MI01", late);
    expect(state(r)).toBe("not_checkable");
    expect(r.state === "not_checkable" ? r.reason : "").toMatch(
      /no day with spend has settled yet/,
    );
    // the confounder is a caveat (cleared, confidence capped), never `unknown`: a new
    // account must not downgrade every finding MI01 guards
    const c = resolveMI01(late);
    expect(c.state).toBe("cleared");
    expect(c.capsConfidence).toBe("MODERATE");
    expect(c.note).toMatch(/No day with spend has settled yet/);
  });

  it("silent past the bar with no rhythm to judge it against is unknown, never 'explains'", () => {
    // one firing day 60 days ago, nothing since: the MI01 check says "no rhythm" and does not run
    const r = resolveMI01(withDaily(daily("61", 60, 60, 1), [action({ id: "61", conv: 12 })]));
    expect(r.state).toBe("unknown");
    expect(r.note).toMatch(/no rhythm/);
  });

  it("a counting action quiet within its own rhythm is cleared, not 'explains'", () => {
    // fires every 6 days; 5 quiet days before its settled day is its normal rhythm (bar 12)
    const sparse = [35, 41, 47, 53, 59, 65, 71, 77, 83, 89].flatMap((n) => daily("61", n, n, 1));
    const r = resolveMI01(withDaily(sparse, [action({ id: "61", name: "Purchase", conv: 10 })]));
    expect(r.state).toBe("cleared");
    expect(r.note).toMatch(/within their own rhythm/);
  });

  it("an explaining silence covers the whole account, never only the campaigns it counted for", () => {
    // Purchase counted only for campaign 11; a campaign launched after the tag went
    // quiet has no conversions to name, and must still be covered
    const purchase = {
      ...action({ id: "61", name: "Purchase" }),
      campaign_breakdown: JSON.stringify([
        { campaign_id: "11", conversions: 40 },
        { campaign_id: "12", conversions: 0 },
      ]),
    };
    const r = resolveMI01(withDaily(daily("61", 46, 89), [purchase]));
    expect(r.state).toBe("explains");
    expect(r.campaignIds).toBeUndefined();
  });

  it("two primaries past their bar: explains, account-wide, names the worst", () => {
    const actions = [
      action({ id: "61", name: "Purchase" }),
      action({ id: "62", name: "Lead form", category: "SUBMIT_LEAD_FORM" }),
    ];
    const r = resolveMI01(withDaily([...daily("61", 46, 89), ...daily("62", 60, 89)], actions));
    expect(r.state).toBe("explains");
    expect(r.note).toContain('"Lead form"');
    expect(r.campaignIds).toBeUndefined();
  });

  it("a purchase tag dead all window, with no other primary counting, is never cleared", () => {
    // the only primary: switched on, 0 conversions, no day in the daily series
    const purchase = action({ id: "61", name: "Purchase", conv: 0, value: 0 });
    const actions = [purchase, action({ id: "62", name: "Page view", primary: false })];
    const r = resolveMI01(withDaily(daily("62", 0, 89), actions));
    expect(r.state).not.toBe("cleared");
    expect(r.note).toContain('"Purchase"');
    // and with zero-conversion rows on file it is silent all window: not cleared either
    const zeroRows = daily("61", 0, 89, 0);
    expect(resolveMI01(withDaily(zeroRows, [purchase])).state).not.toBe("cleared");
  });

  it("Live shop: YouTube follow-on views as the only primary, firing in all conversions only, stays cleared", () => {
    const yt = action({ id: "72", name: "YouTube follow-on views", conv: 0, value: 0 });
    const ytDays = [35, 44, 50, 58, 60, 69, 70, 71, 82, 83].map((n) => ({
      conversion_action_id: "72",
      date: dayBefore(LAST_DAY, n),
      conversions: 0,
      conversions_value: 0,
      all_conversions: 1,
    }));
    const r = resolveMI01(withDaily(ytDays, [yt]));
    expect(r.state).toBe("cleared");
    expect(r.note).toMatch(/fires only in all conversions/);
  });
});

describe("MI03 more than one primary purchase action", () => {
  it("fires on two primary purchase actions", () => {
    const r = runOne(
      "MI03",
      account({ data: { conversionActions: [action({ id: "61" }), action({ id: "62" })] } }),
    );
    expect(state(r)).toBe("fires");
  });
  it("is clean with one primary and one secondary", () => {
    const r = runOne(
      "MI03",
      account({
        data: { conversionActions: [action({ id: "61" }), action({ id: "62", primary: false })] },
      }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when the actions were not read", () => {
    expect(state(runOne("MI03", account()))).toBe("not_checkable");
  });
  it("is clean with 1 enabled and 6 hidden primary purchase actions (plus a sign-up)", () => {
    const hidden = ["62", "63", "64", "65", "66", "67"].map((id) =>
      action({ id, status: "HIDDEN", conv: 0 }),
    );
    const r = runOne(
      "MI03",
      account({
        data: {
          conversionActions: [
            action({ id: "61" }),
            action({ id: "68", category: "SIGNUP" }), // a sign-up is not the same order
            ...hidden,
          ],
        },
      }),
    );
    expect(state(r)).toBe("none_found");
  });
});

describe("MI03 groups actions by family, not raw category", () => {
  const run = (actions: Row[]) => runOne("MI03", account({ data: { conversionActions: actions } }));
  it("a form sent and a qualified lead count one lead twice", () => {
    const r = run([
      action({ id: "61", category: "SUBMIT_LEAD_FORM" }),
      action({ id: "62", category: "QUALIFIED_LEAD" }),
    ]);
    expect(findingsOf(r)[0]?.facts.primary_purchase_action_count).toBe(2);
  });
  it("PURCHASE and PURCHASE_ONLINE count one order twice", () => {
    const r = run([action({ id: "61" }), action({ id: "62", category: "PURCHASE_ONLINE" })]);
    expect(state(r)).toBe("fires");
  });
  it("a purchase and a sign-up do not pair (Google Shopping App Purchase + early access sign-up)", () => {
    const r = run([
      action({ id: "61", name: "Google Shopping App Purchase" }),
      action({ id: "62", name: "BFCM early access sign-up", category: "SIGNUP", lookback: 90 }),
    ]);
    expect(state(r)).toBe("none_found");
  });
});

describe("MI03 money: only the spend that bids on the double count", () => {
  const twoBuys = [action({ id: "61" }), action({ id: "62" })];
  const campaigns: CampaignSpec[] = [
    { id: "11", name: "Shop", cost: 100 },
    { id: "12", name: "Leads", cost: 300 },
  ];
  const goal = (campaign_id: string, category: string) => ({
    campaign_id,
    category,
    origin: "WEBSITE",
    biddable: true,
  });
  it("fires with the share of spend whose campaigns bid on purchases", () => {
    const r = runOne(
      "MI03",
      account(
        {
          data: {
            conversionActions: twoBuys,
            campaignConversionGoals: [goal("11", "PURCHASE"), goal("12", "SUBMIT_LEAD_FORM")],
          },
        },
        campaigns,
      ),
    );
    expect(findingsOf(r)[0]?.facts.share_of_spend_affected).toBeCloseTo(0.25);
  });
  it("counts running campaigns only: a removed and a paused spender stay out of the share", () => {
    const r = runOne(
      "MI03",
      account(
        {
          data: {
            conversionActions: twoBuys,
            // removed campaigns have no goals read; the paused one bids on leads
            campaignConversionGoals: [
              goal("11", "PURCHASE"),
              goal("12", "SUBMIT_LEAD_FORM"),
              goal("14", "SUBMIT_LEAD_FORM"),
            ],
          },
        },
        [
          ...campaigns,
          { id: "13", name: "Old sale", status: "REMOVED", cost: 500 },
          { id: "14", name: "Summer", status: "PAUSED", cost: 200 },
        ],
      ),
    );
    expect(findingsOf(r)[0]?.facts.share_of_spend_affected).toBeCloseTo(0.25);
  });
  it("carries no money when the campaign goals were not read", () => {
    const r = runOne("MI03", account({ data: { conversionActions: twoBuys } }, campaigns));
    expect(state(r)).toBe("fires");
    expect(findingsOf(r)[0]?.facts).not.toHaveProperty("share_of_spend_affected");
  });
});

describe("MI03 is never clean on what it could not read", () => {
  const run = (actions: Row[]) => runOne("MI03", account({ data: { conversionActions: actions } }));
  it("a second primary purchase action with no status read: not run", () => {
    for (const status of [null, "UNKNOWN"]) {
      const r = run([action({ id: "61" }), { ...action({ id: "62" }), status }]);
      expect(state(r)).toBe("not_checkable");
      expect(r.state === "not_checkable" ? r.reason : "").toContain("no status read");
    }
  });
  it("one with no status read that recorded nothing cannot double count", () => {
    const r = run([action({ id: "61" }), { ...action({ id: "62", conv: 0 }), status: null }]);
    expect(state(r)).toBe("none_found");
  });
  it("a second enabled one with no conversion count read: not run", () => {
    const r = run([action({ id: "61" }), { ...action({ id: "62" }), total_conversions: null }]);
    expect(r.state === "not_checkable" ? r.reason : "").toContain("no conversion count read");
  });
});

describe("MI03 and its confounder use one rule", () => {
  /** [MI03 state, MI13's MI03 confounder state] on the same actions. */
  const both = (actions: Row[]) => {
    const input = account({ data: { conversionActions: actions } });
    const ctx = checkCtxOf(input);
    const c = confoundersFor("MI13").find((x) => x.confounderId === "MI03");
    if (!c) throw new Error("MI13 has no MI03 confounder");
    const conf = c.resolve({
      model: ctx.model,
      metrics: makeMetricLookups(ctx.metrics).forInteractions,
      scope: { kind: "account", id: ctx.model.id, scope: "account" },
      thresholds: DEFAULT_CONFOUNDER_THRESHOLDS,
    });
    return [state(runOne("MI03", input)), conf.state];
  };
  it("one of two enabled primaries at 0 conversions: both clean", () => {
    expect(both([action({ id: "61" }), action({ id: "62", conv: 0 })])).toEqual([
      "none_found",
      "cleared",
    ]);
  });
  it("two enabled primaries that both recorded: both say double count", () => {
    expect(both([action({ id: "61" }), action({ id: "62" })])).toEqual(["fires", "explains"]);
  });
});

describe("MI04 conversion value rules change reported value", () => {
  const rules = [{ rule_id: "71", status: "ENABLED" }];
  const split = (added: number): Row[] => [
    { campaign_id: "11", dimension: "NO_RULE_APPLIED", conversions_value: 1000 },
    { campaign_id: "11", dimension: "GEO_LOCATION", conversions_value: added },
  ];
  const input = (rows: Row[] | null) => {
    const base = account({
      data: { conversionValueRules: rules },
      ...(rows ? { tables: { conversion_value_by_rule: rows } } : {}),
    });
    return rows ? withStatus(base, "conversion_value_by_rule", rows.length) : base;
  };
  it("fires when the rules add more than the bar of reported value", () => {
    expect(findingsOf(runOne("MI04", input(split(200))))[0]?.facts.enabled_rules_count).toBe(1);
  });
  it("is clean when they add little, or when no rule is enabled", () => {
    expect(state(runOne("MI04", input(split(10))))).toBe("none_found");
    const none = account({ data: { conversionValueRules: [{ rule_id: "71", status: "PAUSED" }] } });
    expect(state(runOne("MI04", none))).toBe("none_found");
  });
  it("is not checkable when the split by rule was not read", () => {
    expect(state(runOne("MI04", input(null)))).toBe("not_checkable");
  });
});

describe("MI05 attribution models differ", () => {
  it("fires when the actions bidding uses run two models", () => {
    const r = runOne(
      "MI05",
      account({
        data: {
          conversionActions: [
            action({ id: "61" }),
            action({ id: "62", category: "ADD_TO_CART", model: "GOOGLE_ADS_LAST_CLICK" }),
          ],
        },
      }),
    );
    expect(state(r)).toBe("fires");
  });
  it("only the action in the Conversions column counts; primaries outside it are not a mix", () => {
    // 9 primary actions, 1 counted (Google Shopping App Purchase, data-driven).
    // 5 hidden old Analytics imports + 2 YouTube actions are last-click and outside the column.
    const outside = Array.from({ length: 6 }, (_, i) =>
      action({ id: `7${i}`, model: "GOOGLE_ADS_LAST_CLICK", include: false }),
    );
    const r = runOne(
      "MI05",
      account({
        data: {
          conversionActions: [
            action({ id: "61", name: "Google Shopping App Purchase", include: true }),
            action({ id: "62", include: false }),
            action({ id: "63", include: false }),
            ...outside,
          ],
        },
      }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("hidden old imports Google still marks primary and in the column are not a mix", () => {
    // 1 enabled data-driven purchase + 5 HIDDEN old Analytics imports and a HIDDEN
    // engagement goal: primary, include_in_conversions true, last click, 0 sales in 90 days
    const hidden = ["71", "72", "73", "74", "75"].map((id) =>
      action({ id, status: "HIDDEN", model: "GOOGLE_ADS_LAST_CLICK", include: true, conv: 0 }),
    );
    const smartGoal = action({
      id: "76",
      name: "Smart Goal (All Web Site Data)",
      category: "ENGAGEMENT",
      status: "HIDDEN",
      include: true,
      conv: 0,
    });
    const actions = [
      action({ id: "61", name: "Google Shopping App Purchase", include: true }),
      action({ id: "62", category: "SIGNUP", include: false }),
      action({
        id: "63",
        category: "YOUTUBE_FOLLOW_ON_VIEWS",
        origin: "YOUTUBE_HOSTED",
        model: "GOOGLE_ADS_LAST_CLICK",
        include: false,
      }),
      ...hidden,
      smartGoal,
    ];
    const r = runOne("MI05", account({ data: { conversionActions: actions } }));
    expect(state(r)).toBe("none_found");
    expect(r.state === "none_found" ? r.population : null).toBe(1);
  });
  it("an enabled primary on a goal no live campaign bids on is not a mix", () => {
    const actions = [
      action({ id: "61", include: true }),
      action({ id: "62", category: "ENGAGEMENT", model: "GOOGLE_ADS_LAST_CLICK", include: true }),
    ];
    const goals = [
      { campaign_id: "11", category: "PURCHASE", origin: "WEBSITE", biddable: true },
      { campaign_id: "11", category: "ENGAGEMENT", origin: "WEBSITE", biddable: false },
    ];
    const r = runOne(
      "MI05",
      account({ data: { conversionActions: actions, campaignConversionGoals: goals } }),
    );
    expect(state(r)).toBe("none_found");
    // the same two actions fire when a live campaign does bid on the engagement goal
    const bidOn = goals.map((g) => ({ ...g, biddable: true }));
    const r2 = runOne(
      "MI05",
      account({ data: { conversionActions: actions, campaignConversionGoals: bidOn } }),
    );
    expect(state(r2)).toBe("fires");
  });
  it("still fires when two counted actions disagree", () => {
    const r = runOne(
      "MI05",
      account({
        data: {
          conversionActions: [
            action({ id: "61", include: true }),
            action({ id: "62", model: "GOOGLE_ADS_LAST_CLICK", include: true }),
          ],
        },
      }),
    );
    expect(state(r)).toBe("fires");
  });
  it("is clean on one model", () => {
    const r = runOne("MI05", account({ data: { conversionActions: [action({ id: "61" })] } }));
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when the actions were not read", () => {
    expect(state(runOne("MI05", account()))).toBe("not_checkable");
  });
});

describe("MI06 conversions from views", () => {
  // B13: the share is view-through / (conversions + view-through); all_conversions holds
  // secondary actions too and is not the base
  const vt = (viewThrough: number, conversions = 100 - viewThrough, allConversions = 100) =>
    withStatus(
      account({
        tables: {
          campaign_control_settings: [
            {
              campaign_id: "11",
              view_through_conversions: viewThrough,
              conversions,
              all_conversions: allConversions,
            },
          ],
        },
      }),
      "campaign_control_settings",
      1,
    );
  it("fires above the view-through bar", () => {
    expect(findingsOf(runOne("MI06", vt(25)))[0]?.facts.viewthrough_share).toBe(25);
  });
  it("Live case: 12 view-through beside 10.5 conversions is ~53%, not 12 of all conversions", () => {
    const share = findingsOf(runOne("MI06", vt(12, 10.5, 100.8)))[0]?.facts.viewthrough_share;
    expect(share).toBeCloseTo((12 / 22.5) * 100, 5);
  });
  it("is not judged without the conversions read beside it (an older snapshot)", () => {
    const old = withStatus(
      account({
        tables: {
          campaign_control_settings: [
            { campaign_id: "11", view_through_conversions: 25, all_conversions: 100 },
          ],
        },
      }),
      "campaign_control_settings",
      1,
    );
    expect(state(runOne("MI06", old))).not.toBe("fires");
    expect(state(runOne("MI06", old))).not.toBe("none_found");
    // counted as an old snapshot, never as "no row" or "below the floor"
    const r = runOne("MI06", old);
    expect(state(r)).toBe("not_checkable");
    const reason = r.state === "not_checkable" ? r.reason : "";
    expect(reason).toMatch(/1 whose conversions were not read/);
    expect(reason).not.toMatch(/no campaign_control_settings row/);
    expect(reason).not.toMatch(/conversion floor/);
  });
  it("is clean under it, and the bar is a setting", () => {
    expect(state(runOne("MI06", vt(5)))).toBe("none_found");
    const strict = { ...vt(5), settings: { measurement: { viewThroughSharePct: 3 } } };
    expect(state(runOne("MI06", strict))).toBe("fires");
  });
  it("is not checkable when not read", () => {
    expect(state(runOne("MI06", account()))).toBe("not_checkable");
  });

  // Phase F, a shop's "US - DGEN - RT": Demand Gen on YouTube Shorts only, 12 view vs 10.5
  const rt = (type: string, controls: Row[] = []) =>
    withStatus(
      account(
        {
          tables: {
            campaign_control_settings: [
              {
                campaign_id: "61",
                view_through_conversions: 12,
                conversions: 10.5,
                all_conversions: 100.8,
              },
            ],
            ...(controls.length > 0 ? { dg_channel_controls: controls } : {}),
          },
        },
        [{ id: "61", name: "US - DGEN - RT", type, cost: 13 }],
      ),
      "campaign_control_settings",
      1,
    );
  const shortsOnly: Row = {
    campaign_id: "61",
    ad_group_id: "611",
    ad_group_status: "ENABLED",
    channel_config: "SELECTED_CHANNELS",
    channel_strategy: null,
    selected_channels: ["youtubeShorts"],
  };
  it("a YouTube-only campaign is a note with no money at risk", () => {
    for (const input of [rt("DEMAND_GEN", [shortsOnly]), rt("VIDEO")]) {
      const f = findingsOf(runOne("MI06", input))[0];
      expect(f?.facts.youtube_only).toBe(true);
      expect(f?.facts.share_of_spend_affected).toBeUndefined();
      expect(f?.maxSeverity).toBe("info");
      // the note says normal: no "inflated" band beside it
      expect(f?.facts.view_share_band).toBeUndefined();
      // "RT" in the name: the plain over-credit line, still no money
      expect(f?.note).toMatch(/remarketing campaign: view conversions there often credit/);
      expect(f?.facts.remarketing).toBe(true);
      expect(f?.openItems?.join(" ")).toMatch(/often credit people who were going to buy anyway/);
    }
  });
  it("Demand Gen on every surface still carries the money and can warn", () => {
    const f = findingsOf(runOne("MI06", rt("DEMAND_GEN")))[0];
    expect(f?.facts.youtube_only).toBeUndefined();
    expect(f?.facts.view_share_band).toBe("inflated");
    expect(f?.facts.share_of_spend_affected).toBeGreaterThan(0);
    expect(f?.maxSeverity).toBeUndefined();
  });
});

describe("MI06 purchases by click or view", () => {
  // the old read alone would fire here: 25 view-through beside 75 conversions = 25%
  const split = (click: number, view: number, unnamed = 0, type = "DEMAND_GEN") =>
    withStatus(
      account(
        {
          tables: {
            campaign_control_settings: [
              {
                campaign_id: "61",
                view_through_conversions: 25,
                conversions: 75,
                all_conversions: 100,
                purchase_click_conversions: click,
                purchase_view_conversions: view,
                purchase_unnamed_conversions: unnamed,
              },
            ],
          },
        },
        [{ id: "61", name: "Remarketing views", type, cost: 13 }],
      ),
      "campaign_control_settings",
      1,
    );
  it("about 6 in 10 from a click: fires, view-led, percents never x 100", () => {
    const f = findingsOf(runOne("MI06", split(9.26, 5.22)))[0];
    expect(f?.facts).toMatchObject({
      purchase_click_share: 64,
      purchase_view_share: 36,
      viewthrough_share: 36,
      purchases_counted: 14.5,
      view_share_band: "inflated",
    });
    expect(f?.maxSeverity).toBeUndefined();
  });
  it("9 in 10 or more from a click: no finding, even when the old read would fire", () => {
    expect(state(runOne("MI06", split(790.92, 2.16, 0, "PERFORMANCE_MAX")))).toBe("none_found");
    expect(state(runOne("MI06", split(63.7, 0, 0, "SHOPPING")))).toBe("none_found");
  });
  it("between the two bars: a note, never a warning", () => {
    const f = findingsOf(runOne("MI06", split(85, 15, 0, "SEARCH")))[0];
    expect(f?.facts.purchase_click_share).toBe(85);
    expect(f?.maxSeverity).toBe("info");
  });
  it("a purchase type we cannot name: could not check, never the old read", () => {
    const r = runOne("MI06", split(40, 20, 10));
    expect(state(r)).toBe("not_checkable");
    expect(r.state === "not_checkable" ? r.reason : "").toMatch(/type we cannot name/);
  });
  it("too few purchases to judge: the old read, as before", () => {
    const f = findingsOf(runOne("MI06", split(3, 1)))[0];
    expect(f?.facts.viewthrough_share).toBe(25);
    expect(f?.facts.purchase_click_share).toBeUndefined();
  });
});

describe("MI07 campaign bids toward a goal the account does not", () => {
  const goals = (campaignCategory: string) =>
    account({
      data: {
        customerConversionGoals: [{ category: "PURCHASE", origin: "WEBSITE", biddable: true }],
        campaignConversionGoals: [
          { campaign_id: "11", category: campaignCategory, origin: "WEBSITE", biddable: true },
        ],
      },
    });
  it("fires when the campaign bids toward a goal the account does not", () => {
    expect(findingsOf(runOne("MI07", goals("SUBMIT_LEAD_FORM")))[0]?.scope.id).toBe("11");
  });
  it("is clean when it bids toward the account's goal", () => {
    expect(state(runOne("MI07", goals("PURCHASE")))).toBe("none_found");
  });
  it("is not checkable when goals were not read", () => {
    expect(state(runOne("MI07", account()))).toBe("not_checkable");
  });
});

describe("MI08 unsettled recent days (context only)", () => {
  it("fires while the recent days are still collecting conversions", () => {
    const r = runOne("MI08", account({ data: { conversionActions: [action({ id: "61" })] } }));
    expect(state(r)).toBe("fires");
  });
  it("is clean when every day is settled", () => {
    const r = runOne(
      "MI08",
      account({ data: { conversionActions: [action({ id: "61", lookback: 0 })] } }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable without conversion actions (no lookback)", () => {
    expect(state(runOne("MI08", account()))).toBe("not_checkable");
  });
});

describe("MI09 period does not end yesterday", () => {
  it("is clean when it ends yesterday", () => {
    expect(state(runOne("MI09", account()))).toBe("none_found");
  });
  it("fires when the last day is not yesterday", () => {
    expect(state(runOne("MI09", { ...account(), runDate: "2026-09-05" }))).toBe("fires");
  });
  it("is not checkable with no daily series", () => {
    const input = account();
    const r = runOne("MI09", {
      ...input,
      data: { ...input.data, dailyMetrics: [], campaignDailyMetrics: [] },
    });
    expect(state(r)).toBe("not_checkable");
  });
});

describe("MI10 / MI11 conversion tracking settings", () => {
  const settings = (s: Row) =>
    withStatus(
      account({ data: { conversionTrackingSettings: s } }),
      "conversion_tracking_settings",
      1,
    );
  const on = {
    enhanced_conversions_enabled: true,
    accepted_customer_data_terms: true,
    conversion_tracking_status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
  };
  it("MI10 fires when enhanced conversions are off", () => {
    expect(state(runOne("MI10", settings({ ...on, enhanced_conversions_enabled: false })))).toBe(
      "fires",
    );
  });
  it("MI10 is clean when both are in place", () => {
    expect(state(runOne("MI10", settings(on)))).toBe("none_found");
  });
  it("MI10 is not checkable when the settings were not read", () => {
    expect(state(runOne("MI10", account()))).toBe("not_checkable");
  });
  it("MI11 states the positive when the account owns its tracking", () => {
    expect(state(runOne("MI11", settings(on)))).toBe("fires");
    const elsewhere = settings({
      ...on,
      conversion_tracking_status: "CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER",
    });
    expect(state(runOne("MI11", elsewhere))).toBe("none_found");
    const notSetUp = settings({ ...on, conversion_tracking_status: "NOT_CONVERSION_TRACKED" });
    expect(runOne("MI11", notSetUp)).toMatchObject({
      state: "not_checkable",
      category: "not_present",
    });
    expect(state(runOne("MI11", account()))).toBe("not_checkable");
  });
});

describe("MI12 customer list uploads failing", () => {
  const jobs = (status: string) =>
    account({
      data: {
        offlineUserDataJobs: [
          {
            job_id: "1002",
            type: "CUSTOMER_MATCH_USER_LIST",
            status,
            failure_reason: "",
            user_list_resource_name: "customers/1/userLists/901",
          },
          {
            job_id: "1001",
            type: "CUSTOMER_MATCH_USER_LIST",
            status: "SUCCESS",
            failure_reason: "",
            user_list_resource_name: "customers/1/userLists/901",
          },
        ],
        audienceLists: [{ list_id: "901", list_name: "Newsletter list", list_type: "CRM_BASED" }],
      },
    });
  it("fires when the latest upload to a list failed", () => {
    const r = runOne("MI12", jobs("FAILED"));
    expect(findingsOf(r)[0]?.rows?.[0]?.entity.name).toBe("Newsletter list");
  });
  it("is clean when the latest upload succeeded", () => {
    expect(state(runOne("MI12", jobs("SUCCESS")))).toBe("none_found");
  });
  it("is not checkable when the jobs were not read", () => {
    expect(state(runOne("MI12", account()))).toBe("not_checkable");
  });
});

describe("MI14 value rules with no condition", () => {
  it("is not checkable while the rules' conditions are not read", () => {
    const r = runOne(
      "MI14",
      account({
        data: {
          conversionValueRules: [{ rule_id: "71", status: "ENABLED", conditions_read: false }],
        },
      }),
    );
    expect(r).toMatchObject({ state: "not_checkable", category: "our_gap" });
    expect(r.state === "not_checkable" && r.reason).toMatch(/doesn't read yet/);
  });
  it("is clean when no rule is enabled", () => {
    const r = runOne(
      "MI14",
      account({ data: { conversionValueRules: [{ rule_id: "71", status: "PAUSED" }] } }),
    );
    expect(state(r)).toBe("none_found");
  });
  it("fires on a rule with no condition once the split shows it adding value", () => {
    const base = account({
      data: {
        conversionValueRules: [
          { rule_id: "71", status: "ENABLED", action_operation: "ADD", action_value: 20 },
        ],
      },
      tables: {
        conversion_value_by_rule: [
          { campaign_id: "11", dimension: "NO_RULE_APPLIED", conversions_value: 1000 },
          { campaign_id: "11", dimension: "GEO_LOCATION", conversions_value: 200 },
        ],
      },
    });
    const r = runOne("MI14", withStatus(base, "conversion_value_by_rule", 2));
    expect(state(r)).toBe("fires");
  });
});

describe("MI16 a step before the sale counts as primary", () => {
  it("fires on a primary add-to-cart action", () => {
    const r = runOne(
      "MI16",
      account({
        data: {
          conversionActions: [action({ id: "61" }), action({ id: "62", category: "ADD_TO_CART" })],
        },
      }),
    );
    expect(findingsOf(r).map((f) => f.scope.id)).toEqual(["62"]);
  });
  it("fires on a purchase action with sales at no value", () => {
    const r = runOne(
      "MI16",
      account({ data: { conversionActions: [action({ id: "61", conv: 20, value: 0 })] } }),
    );
    expect(findingsOf(r)[0]?.facts.leg).toBe("zero_value_purchase");
  });
  it("is clean with only a valued purchase action primary", () => {
    const r = runOne("MI16", account({ data: { conversionActions: [action({ id: "61" })] } }));
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable when the actions were not read", () => {
    expect(state(runOne("MI16", account()))).toBe("not_checkable");
  });
});

describe("MI18 a tracking break Smart Bidding learned from", () => {
  const smart: CampaignSpec = { id: "11", strategy: "TARGET_ROAS", targetRoas: 4 };
  const outage = (gapDays: number[], tables: Record<string, Row[]> = {}) => {
    const rows = daily("61", 8, 89).filter(
      (r) =>
        !gapDays.includes(Math.round((Date.parse(LAST_DAY) - Date.parse(String(r.date))) / 864e5)),
    );
    return withStatus(
      account(
        {
          data: { conversionActions: [action({ id: "61" })] },
          tables: { conversion_action_daily: rows, ...tables },
          syncedEmpty: ["biddingOverrides"],
        },
        [smart],
      ),
      "conversion_action_daily",
      rows.length,
    );
  };
  const gap = [40, 41, 42, 43, 44];
  it("fires on a recovered zero-sale run after steady sales", () => {
    const r = runOne("MI18", outage(gap));
    expect(findingsOf(r)[0]?.facts.outage_days).toBe(5);
  });
  it("is clean with no gap, or with a data exclusion covering it", () => {
    expect(state(runOne("MI18", outage([])))).toBe("none_found");
    const covered = outage(gap);
    const exclusion = {
      override_type: "DATA_EXCLUSION",
      status: "ENABLED",
      scope: "CUSTOMER",
      start_date_time: `${dayBefore(LAST_DAY, 45)} 00:00:00`,
      end_date_time: `${dayBefore(LAST_DAY, 39)} 23:59:59`,
    };
    const r = runOne("MI18", {
      ...covered,
      data: { ...covered.data, biddingOverrides: [exclusion] },
    });
    expect(state(r)).toBe("none_found");
  });
  it("is not checkable without the daily series", () => {
    const r = runOne(
      "MI18",
      account({ data: { conversionActions: [action({ id: "61" })] } }, [smart]),
    );
    expect(state(r)).toBe("not_checkable");
  });
});
