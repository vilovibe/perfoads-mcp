// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  explainCheck,
  listChecks,
  runChecks,
  type EvidenceInput,
} from "./index.js";
import {
  ALL_CHECKS,
  CHECKS_BY_ID,
  CHECK_COUNT,
  collectorProblems,
  getCheck,
} from "./engine/checks/index.js";
import {
  NON_EMITTING_CHECKS,
  SEVERITY_POLICY,
  severityPolicyFor,
} from "./engine/checks/severityPolicy.js";
import { resolveConfounders, DEFAULT_CONFOUNDER_THRESHOLDS } from "./engine/interactions/index.js";
import { UNRESOLVABLE_CONFOUNDERS } from "./engine/checks/index.js";
import { confoundersFor } from "./engine/interactions/matrix.js";
import { CHECK_CLAIM_KEYS, isKnownClaimKey } from "./engine/registry/claimKeys.js";
import { IMPACT_FORMULA_IDS } from "./engine/scoring/impact.js";
import { SEVERITY_ORDER } from "./engine/scoring/severity.js";
import { resolveSettings } from "./engine/settings.js";
import { rankMoneyFloor } from "./engine/runEvidenceEngine.js";
import {
  adGroup,
  buildInput,
  checkCtxOf,
  dayBefore,
  keyword,
  LAST_DAY,
  searchTerm,
} from "./testing/account.js";

const SHIPPED = [
  "MI01",
  "MI03",
  "MI04",
  "MI05",
  "MI06",
  "MI07",
  "MI08",
  "MI09",
  "MI10",
  "MI11",
  "MI12",
  "MI14",
  "MI16",
  "MI18",
  "AS01",
  "AS02",
  "AS03",
  "AS04",
  "AS06",
  "AS07",
  "AS08",
  "AS09",
  "AS10",
  "AS13",
  "AS14",
  "AS15",
  "AS16",
  "AS17",
  "BB01",
  "BB02",
  "BB03",
  "BB04",
  "BB05",
  "BB06",
  "BB07",
  "BB08",
  "BB09",
  "BB10",
  "BB11",
  "BB14",
  "BB15",
  "BB16",
  "BB17",
  "SK01",
  "SK02",
  "SK03",
  "SK04",
  "SK05",
  "SK06",
  "SK07",
  "SK08",
  "SK09",
  "SK10",
  "SK11",
  "SK12",
  "SK13",
  "SK14",
  "SK15",
  "SK16",
  "SK17",
  "SK18",
  "SK19",
  "SK20",
  "SK21",
  "SK22",
  "SK26",
  "SK27",
  "SK28",
  "SK30",
  "SK32",
  "SK33",
  "SK35",
  "PX01",
  "PX02",
  "PX03",
  "PX05",
  "PX06",
  "PX07",
  "PX08",
  "PX09",
  "PX10",
  "PX14",
  "PX15",
  "PX16",
  "PX17",
  "PX18",
  "PX19",
  "PX20",
  "PX21",
  "SH01",
  "SH02",
  "SH03",
  "SH04",
  "SH05",
  "SH06",
  "SH08",
  "SH09",
  "SH10",
  "SH11",
  "SH22",
  "SH23",
  "SH24",
  "SL01",
  "SL02",
  "SL03",
  "SL04",
  "SL05",
  "SL06",
  "SL07",
  "SL10",
  "SL11",
  "SL12",
  "TR01",
  "TR01a",
  "TR02",
  "TR03",
  "TR04",
  "TR05",
  "TR06",
  "TR07",
  "TR08",
  "TR09",
  "TR10",
  "PR01",
  "PR02",
  "PR03",
  "PR04",
  "PR05",
  "PR06",
  "PR07",
  "MI13",
  "AS12",
  "BB12",
  "BB13",
  "SK24",
  "SK25",
  "SL09",
  "SH13",
  "SH14",
  "SH15",
  "SH17",
  "SH18",
  "SH19",
  "SH20",
  "SH21",
  "PX13",
  "VD07",
  "SK23",
  "PX11",
  "PX12",
  "SH12",
  "DG01",
  "DG02",
  "DG03",
  "DG04",
  "DG06",
  "VD01",
  "VD02",
  "VD03",
  "VD04",
  "VD05",
  "VD06",
];

/** A busy account: several campaigns, keywords, terms and impression share. */
function busyInput(
  overrides: Record<string, Partial<Parameters<typeof buildInput>[0]["campaigns"][number]>> = {},
): EvidenceInput {
  return buildInput({
    campaigns: [
      {
        id: "11",
        name: "Generic search",
        strategy: "TARGET_ROAS",
        targetRoas: 2,
        budget: 100,
        cost: 100,
        is: { lostBudget: 0.2, lostRank: 0.35 },
      },
      {
        id: "12",
        name: "Brand search",
        strategy: "MAXIMIZE_CONVERSIONS",
        budget: 50,
        cost: 30,
        clicks: 20,
        is: { lostBudget: 0.01 },
      },
      {
        id: "13",
        name: "Prospecting shopping",
        type: "SHOPPING",
        strategy: "MAXIMIZE_CONVERSION_VALUE",
        budget: 300,
        cost: 60,
      },
    ].map((c) => ({ ...c, ...overrides[c.id] })),
    data: {
      adGroups: [adGroup({ id: "21", campaignId: "11" }), adGroup({ id: "22", campaignId: "11" })],
      keywords: [
        keyword({
          id: "31",
          campaignId: "11",
          adGroupId: "21",
          text: "running shoes",
          match: "BROAD",
          cost: 900,
          clicks: 300,
          conv: 0,
          qs: 3,
        }),
        keyword({
          id: "32",
          campaignId: "11",
          adGroupId: "22",
          text: "running shoes",
          match: "BROAD",
          cost: 50,
        }),
      ],
      searchTerms: [
        searchTerm({
          campaignId: "11",
          adGroupId: "21",
          term: "free running shoes",
          cost: 300,
          clicks: 150,
        }),
        searchTerm({
          campaignId: "11",
          adGroupId: "21",
          term: "running shoes sale",
          cost: 300,
          clicks: 150,
          conv: 5,
        }),
      ],
    },
  });
}

describe("runChecks", () => {
  it("is deterministic: the same input and run date give byte-identical output", () => {
    const a = JSON.stringify(runChecks(busyInput()));
    const b = JSON.stringify(runChecks(busyInput()));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(1000);
  });

  it("does not depend on the order campaigns arrive in", () => {
    const input = busyInput();
    const reversed = {
      ...input,
      data: { ...input.data, campaigns: [...(input.data.campaigns ?? [])].reverse() },
    };
    const ids = (r: ReturnType<typeof runChecks>) =>
      r.findings.map((f) => `${f.checkId}:${f.scope.id}`).sort();
    expect(ids(runChecks(reversed))).toEqual(ids(runChecks(input)));
  });

  it("reports one outcome per shipped check, and finds things on a busy account", () => {
    const r = runChecks(busyInput());
    expect(r.version).toBe(1);
    expect(r.checks.map((c) => c.id)).toEqual(SHIPPED);
    expect(r.counts.checks).toBe(SHIPPED.length);
    expect(
      r.counts.finding + r.counts.info + r.counts.clean + r.counts.notRun + r.counts.suppressed,
    ).toBe(SHIPPED.length);
    const found = r.checks.filter((c) => c.status === "finding").map((c) => c.id);
    expect(found).toEqual(expect.arrayContaining(["BB02", "BB03", "SK01", "SK02", "SK04", "SK05"]));
    for (const f of r.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.claimKey).toBeTruthy();
      expect(f.origin).toBe("engine");
    }
    expect(r.counts.findings).toBe(r.findings.length);
  });

  it("never calls a check clean when its data was not read", () => {
    const r = runChecks(buildInput({ campaigns: [{ id: "11" }] }));
    for (const id of [
      "BB02",
      "BB03",
      "BB07",
      "BB08",
      "BB09",
      "BB10",
      "BB11",
      "BB17",
      "SK01",
      "SK04",
      "SK05",
    ]) {
      const o = r.checks.find((c) => c.id === id);
      expect({ id, status: o?.status }).toEqual({ id, status: "not_run" });
      expect(o?.reason).toBeTruthy();
    }
  });

  it("warns, in words, when no sync marker was supplied", () => {
    const input = buildInput({ campaigns: [{ id: "11" }] });
    const r = runChecks({ ...input, statusRows: [] });
    expect(r.warnings.join(" ")).toMatch(/no usable sync marker/);
    expect(runChecks(input).warnings).toEqual([]);
  });

  it("ranks critical and warning first; below them priced findings before unpriced ones", () => {
    const input = busyInput();
    const r = runChecks(input);
    const ctx = checkCtxOf(input);
    const n = (id: string) => {
      const v = ctx.get(id);
      return "value" in v && typeof v.value === "number" ? v.value : null;
    };
    const floor = rankMoneyFloor(n("T.waste_floor"), n("A.spend_monthly"));
    // R6: an unpriced `opportunity` never sits above a priced `info` (money at the floor or more)
    const tier = (f: (typeof r.findings)[number]) =>
      Math.min(SEVERITY_ORDER.indexOf(f.severity.severity), SEVERITY_ORDER.indexOf("opportunity"));
    const priced = (f: (typeof r.findings)[number]) =>
      f.impact.quantified && f.impact.value != null && f.impact.value >= floor;
    let prev: (typeof r.findings)[number] | undefined;
    for (const f of r.findings) {
      if (prev) {
        expect(tier(f)).toBeGreaterThanOrEqual(tier(prev));
        if (tier(f) === tier(prev) && priced(f)) expect(priced(prev)).toBe(true);
        if (tier(f) === tier(prev) && priced(f) && priced(prev))
          expect(Number(f.impact.value)).toBeLessThanOrEqual(Number(prev.impact.value));
        // inside one severity, rows priced under the floor keep their money order and sit
        // above that severity's unpriced rows
        const anyMoney = (x: (typeof r.findings)[number]) =>
          x.impact.quantified && x.impact.value != null && x.impact.value > 0;
        if (f.severity.severity === prev.severity.severity && anyMoney(f)) {
          expect(anyMoney(prev)).toBe(true);
          expect(Number(f.impact.value)).toBeLessThanOrEqual(Number(prev.impact.value));
        }
      }
      prev = f;
    }
    // the run mixes severities, so the order above is really tested
    expect(new Set(r.findings.map((f) => f.severity.severity)).size).toBeGreaterThan(1);
  });

  it("the ranking money floor: the lower of the money floor and 0.5% of monthly spend", () => {
    expect(rankMoneyFloor(80, 30_000)).toBe(80);
    expect(rankMoneyFloor(500, 30_000)).toBe(150);
    // unknown currency (an infinite money floor) or no spend read: what is known decides
    expect(rankMoneyFloor(Number.POSITIVE_INFINITY, 30_000)).toBe(150);
    expect(rankMoneyFloor(null, null)).toBe(0);
  });

  it("applies settings overrides and reports the settings it used", () => {
    const r = runChecks({ ...busyInput(), settings: { bidding: { lostIsBudgetPct: 50 } } });
    expect(r.settings.bidding.lostIsBudgetPct).toBe(50);
    expect(r.checks.find((c) => c.id === "BB02")?.status).toBe("clean");
  });

  it("an all-paused account with a removed campaign that spent puts no finding on any of them", () => {
    const r = runChecks(
      busyInput({
        "11": { status: "REMOVED" },
        "12": { status: "PAUSED", cost: 0 },
        "13": { status: "PAUSED", cost: 0 },
      }),
    );
    expect(r.warnings.join(" ")).not.toMatch(/spent nothing/);
    const onThem = r.findings.filter((f) =>
      ["11", "12", "13"].includes(String(f.scope.campaignId ?? f.scope.id)),
    );
    expect(onThem).toEqual([]);
  });

  it("an account that spent nothing gets one reason for every check, and one warning", () => {
    const r = runChecks(buildInput({ campaigns: [], syncedEmpty: ["dailyMetrics", "campaigns"] }));
    expect(r.counts.notRun).toBe(r.checks.length);
    const reasons = new Set(r.checks.map((c) => c.reason));
    expect([...reasons]).toEqual(["the account spent nothing in the 90 days read"]);
    expect(new Set(r.checks.map((c) => c.category))).toEqual(new Set(["not_present"]));
    expect(r.warnings.filter((w) => w.includes("spent nothing"))).toHaveLength(1);
  });

  it("a switched-on campaign that spent nothing adds a warning that campaigns are on", () => {
    const r = runChecks(buildInput({ campaigns: [{ id: "11", cost: 0, conv: 0, value: 0 }] }));
    expect(r.counts.notRun).toBe(r.checks.length);
    expect(r.warnings).toContain(
      "1 campaign(s) are switched on, but nothing was spent in the 90 days read.",
    );
  });

  it("daily rows that carry no cost are never read as spent nothing", () => {
    const base = buildInput({ campaigns: [] });
    const days = Array.from({ length: 90 }, (_, i) => ({
      metric_date: dayBefore(LAST_DAY, i),
      cost: null,
      conversions: 0,
      conversion_value: 0,
      clicks: 0,
      impressions: 0,
    }));
    const input: EvidenceInput = {
      ...base,
      data: { ...base.data, dailyMetrics: days },
      statusRows: [
        { table_name: "daily_metrics", status: "ok", row_count: 90, error_message: null },
      ],
    };
    const r = runChecks(input);
    expect(r.warnings.join(" ")).not.toMatch(/spent nothing/);
    expect(r.checks.map((c) => c.reason)).not.toContain(
      "the account spent nothing in the 90 days read",
    );
  });

  it("one day with a cost of 0 among days with no cost is never read as spent nothing", () => {
    const base = buildInput({ campaigns: [] });
    const days = Array.from({ length: 90 }, (_, i) => ({
      metric_date: dayBefore(LAST_DAY, i),
      cost: i === 0 ? 0 : null,
      conversions: 0,
      conversion_value: 0,
      clicks: 0,
      impressions: 0,
    }));
    const r = runChecks({
      ...base,
      data: { ...base.data, dailyMetrics: days },
      statusRows: [
        { table_name: "daily_metrics", status: "ok", row_count: 90, error_message: null },
      ],
    });
    expect(r.warnings.join(" ")).not.toMatch(/spent nothing/);
    expect(r.checks.map((c) => c.reason)).not.toContain(
      "the account spent nothing in the 90 days read",
    );
  });

  it("spend from paused and removed campaigns only: one warning, and nothing running judged clean", () => {
    const r = runChecks(
      buildInput({
        campaigns: [
          { id: "11", name: "Old sale", status: "REMOVED", cost: 100 / 90, days: 90 },
          { id: "12", name: "Summer", status: "PAUSED", cost: 30 / 90, days: 90 },
        ],
      }),
    );
    expect(r.warnings).toContain(
      "No campaign is switched on: the spend in the 90 days read came from paused or removed campaigns, so nothing running was judged.",
    );
    expect(r.warnings.join(" ")).not.toMatch(/spent nothing/);
    expect(r.counts.clean).toBe(0);
    for (const id of ["BB01", "BB04", "TR01"]) {
      const c = r.checks.find((x) => x.id === id);
      expect(c?.status).not.toBe("clean");
    }
    const bb01 = r.checks.find((x) => x.id === "BB01");
    expect(bb01?.status).toBe("not_run");
    expect(bb01?.category).toBe("not_present");
    expect(bb01?.reason).toBe("no campaign is switched on, so there was nothing running to judge");
    expect(r.findings).toEqual([]);
    // a check on the account itself (auto-apply settings here) keeps its own result
    const base = buildInput({
      campaigns: [{ id: "11", name: "Old sale", status: "REMOVED", cost: 100 / 90, days: 90 }],
    });
    const withSettings = runChecks({
      ...base,
      data: { ...base.data, recommendationSubscriptions: [] },
      statusRows: [
        ...(base.statusRows ?? []),
        { table_name: "recommendation_subscriptions", status: "ok", row_count: 0 },
      ],
    });
    expect(withSettings.checks.find((x) => x.id === "AS04")?.status).toBe("clean");
    expect(withSettings.checks.find((x) => x.id === "BB01")?.status).toBe("not_run");
  });

  it("no campaign switched on and none shows spend: the warning never says where spend came from", () => {
    const base = buildInput({
      campaigns: [{ id: "12", name: "Summer", status: "PAUSED", cost: 0, days: 90 }],
    });
    // the daily read failed, so whether the account spent anything is unknown
    const r = runChecks({
      ...base,
      statusRows: [
        { table_name: "daily_metrics", status: "error", row_count: 0, error_message: "boom" },
      ],
    });
    expect(r.warnings).toContain("No campaign is switched on, so nothing running was judged.");
    expect(r.warnings.join(" ")).not.toMatch(/spend|spent/);
  });

  it("a failed daily read is never read as spent nothing", () => {
    const base = buildInput({ campaigns: [] });
    const r = runChecks({
      ...base,
      statusRows: [
        { table_name: "daily_metrics", status: "error", row_count: 0, error_message: "boom" },
      ],
    });
    expect(r.warnings.join(" ")).not.toMatch(/spent nothing/);
    expect(r.checks.map((c) => c.reason)).not.toContain(
      "the account spent nothing in the 90 days read",
    );
  });

  it("runs on an empty account without throwing, and judges nothing", () => {
    const r = runChecks({ data: { currencyCode: null }, runDate: "2026-09-02", clock: () => 0 });
    expect(r.counts.finding).toBe(0);
    expect(r.counts.clean).toBe(0);
  });
});

describe("settings", () => {
  it("defaults are complete and overrides of the wrong type are ignored", () => {
    const s = resolveSettings({
      bidding: { lostIsRankPct: Number.NaN, relearnDays: 7 },
      search: { lowQsMax: "3" as unknown as number },
    });
    expect(s.bidding.lostIsRankPct).toBe(DEFAULT_SETTINGS.bidding.lostIsRankPct);
    expect(s.bidding.relearnDays).toBe(7);
    expect(s.search.lowQsMax).toBe(DEFAULT_SETTINGS.search.lowQsMax);
  });
  it("resolving never mutates the defaults", () => {
    resolveSettings({ bidding: { relearnDays: 99 } });
    expect(DEFAULT_SETTINGS.bidding.relearnDays).toBe(14);
  });
});

describe("listChecks / explainCheck", () => {
  it("lists every shipped check with its contract", () => {
    const list = listChecks();
    expect(list.map((c) => c.id)).toEqual(SHIPPED);
    for (const c of list) {
      expect(c.title).toBeTruthy();
      expect(c.requires.length).toBeGreaterThan(0);
      expect(SEVERITY_ORDER).toContain(c.maxSeverity);
    }
    expect(list.find((c) => c.id === "BB01")?.emitsFindings).toBe(false);
  });
  it("explains one check with the settings it reads", () => {
    const e = explainCheck("bb15");
    expect(e?.id).toBe("BB15");
    expect(e?.settings).toMatchObject({
      "bidding.brandCpcFloorUsd": 0.4,
      "bidding.brandCpcShareOfNonBrand": 0.4,
    });
    expect(explainCheck("SK02")?.settings).toEqual({
      "search.lowQsMax": 4,
      "search.lowQsSpendShareOfMonthly": 0.03,
      "bidding.lostIsRankPct": 30,
    });
    expect(explainCheck("NOPE01")).toBeNull();
  });
});

describe("the collector", () => {
  it("collects the shipped checks with no broken invariant", () => {
    expect(CHECK_COUNT).toBe(SHIPPED.length);
    expect(ALL_CHECKS.map((c) => c.id)).toEqual(SHIPPED);
    expect(CHECKS_BY_ID.size).toBe(SHIPPED.length);
    expect(collectorProblems()).toEqual([]);
    expect(getCheck("SK01")?.claimKey).toBe("keyword.zero_conv_waste");
    expect(getCheck("SH16")).toBeNull();
  });

  it("every claimKey is registered and matches CHECK_CLAIM_KEYS", () => {
    for (const c of ALL_CHECKS) {
      expect(isKnownClaimKey(c.claimKey)).toBe(true);
      expect(c.claimKey).toBe(CHECK_CLAIM_KEYS[c.id]);
    }
  });

  it("every non-null impactFormula is a real formula id", () => {
    const ids = new Set<string>(IMPACT_FORMULA_IDS);
    for (const c of ALL_CHECKS)
      if (c.impactFormula != null) expect(ids.has(c.impactFormula)).toBe(true);
  });

  it("every declared confounder of a shipped check has a resolver in the matrix, or is named as unresolvable", () => {
    for (const c of ALL_CHECKS) {
      const resolved = new Set(confoundersFor(c.id).map((r) => r.confounderId));
      for (const x of c.confounders)
        expect({
          check: c.id,
          confounder: x,
          resolved: resolved.has(x) || UNRESOLVABLE_CONFOUNDERS.has(`${c.id}:${x}`),
        }).toEqual({
          check: c.id,
          confounder: x,
          resolved: true,
        });
    }
  });

  it("an unresolved declared confounder is recorded as unknown, never dropped", () => {
    const results = resolveConfounders(
      "BB01",
      {
        model: {} as never,
        metrics: {
          get: () => ({
            id: "x",
            value: null,
            reason: "not_checkable",
            detail: "stub",
            unit: "count",
            level: "account",
            entityId: null,
          }),
        } as never,
        scope: { kind: "account", id: "account" } as never,
        thresholds: DEFAULT_CONFOUNDER_THRESHOLDS,
      },
      ["ZZ99"],
    );
    const missing = results.filter((r) => /has no resolver/.test(r.note ?? ""));
    expect(missing.map((r) => r.state)).toEqual(["unknown"]);
  });
});

describe("severity policy", () => {
  it("has a row for every shipped check and no row for anything else", () => {
    expect(Object.keys(SEVERITY_POLICY).sort()).toEqual([...SHIPPED].sort());
    expect(() => severityPolicyFor("NOPE01")).toThrow(/no policy row/);
  });
  it("only the context feed does not emit", () => {
    const nonEmitting = Object.entries(SEVERITY_POLICY)
      .filter(([, p]) => !p.emit)
      .map(([id]) => id);
    expect(nonEmitting.sort()).toEqual([...NON_EMITTING_CHECKS].sort());
  });
  it("lost share to budget is priced by BB02 alone: no other check copies IMP_LOSTIS", () => {
    expect(
      ALL_CHECKS.filter((c) => c.impactFormula === "IMP_LOSTIS")
        .map((c) => c.id)
        .sort(),
    ).toEqual(["BB02"]);
  });
  it("structural = the IMP_STRUCTURAL rows", () => {
    for (const c of ALL_CHECKS)
      expect({ id: c.id, structural: severityPolicyFor(c.id).structural }).toEqual({
        id: c.id,
        structural: c.impactFormula === "IMP_STRUCTURAL",
      });
  });
  it("a floor is set only where nothing else reaches the row's own severity, and never above the ceiling", () => {
    const needsFloor = ALL_CHECKS.filter((c) => {
      const p = severityPolicyFor(c.id);
      const noMoney = c.impactFormula == null || c.impactFormula === "IMP_NONE";
      const flagged = p.integrity || p.structural || p.positive || p.opportunity;
      return noMoney && !flagged && (p.maxSeverity === "warning" || p.maxSeverity === "critical");
    })
      .map((c) => c.id)
      .sort();
    const withFloor = Object.entries(SEVERITY_POLICY)
      .filter(([, p]) => p.sheetBase)
      .map(([id]) => id)
      .sort();
    expect(withFloor).toEqual(needsFloor);
    for (const id of withFloor) {
      const p = severityPolicyFor(id);
      expect(SEVERITY_ORDER.indexOf(p.sheetBase ?? "info")).toBeGreaterThanOrEqual(
        SEVERITY_ORDER.indexOf(p.maxSeverity),
      );
    }
  });
});

describe("info outcome", () => {
  it("a note-only check that fires states its line as info, outside the findings", () => {
    const input = buildInput({
      campaigns: [{ id: "11", name: "Generic search" }],
      data: { customerUserAccess: [{ access_role: "ADMIN" }, { access_role: "STANDARD" }] },
    });
    const r = runChecks(input);
    const as10 = r.checks.find((c) => c.id === "AS10");
    expect(as10).toMatchObject({
      status: "info",
      findings: 0,
      note: "more than one person has access to this account",
    });
    expect(r.findings.some((f) => f.checkId === "AS10")).toBe(false);
    expect(r.info.some((f) => f.checkId === "AS10")).toBe(true);
    expect(r.counts.info).toBeGreaterThanOrEqual(1);
    expect(r.counts.findings).toBe(r.findings.length);
  });
  it("the catalog says which checks state info", () => {
    const byId = new Map(listChecks().map((c) => [c.id, c.infoLine] as const));
    for (const id of ["MI11", "SK21", "SK35", "AS10", "AS14", "AS15", "AS17", "BB10", "BB17"])
      expect([id, typeof byId.get(id)]).toEqual([id, "string"]);
    expect(byId.get("SK01")).toBeNull();
  });
});
