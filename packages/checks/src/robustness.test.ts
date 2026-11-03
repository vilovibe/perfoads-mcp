// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * runChecks never throws, fails closed on unreadable data, never calls
 * incomplete data clean, validates settings, and does not depend on row order.
 */
import { describe, expect, it } from "vitest";
import { runChecks, type EvidenceInput } from "./api.js";
import { runEvidenceEngine } from "./engine/runEvidenceEngine.js";
import { ACCOUNT_DATA_ARRAY_KEYS } from "./engine/shared/input.js";
import { DEFAULT_SETTINGS, SETTING_RULES, validateSettings } from "./engine/settings.js";
import { adGroup, buildInput, keyword, RUN_DATE, searchTerm } from "./testing/account.js";

const CHECKS = 162;
const outcome = (r: ReturnType<typeof runChecks>, id: string) => r.checks.find((c) => c.id === id);

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function junk(r: () => number, depth = 0): unknown {
  const pick = Math.floor(r() * 14);
  switch (pick) {
    case 0:
      return null;
    case 1:
      return undefined;
    case 2:
      return Number.NaN;
    case 3:
      return Number.POSITIVE_INFINITY;
    case 4:
      return -r() * 1e12;
    case 5:
      return "12.5";
    case 6:
      return "not a number";
    case 7:
      return r() > 0.5;
    case 8:
      return depth > 2 ? [] : [junk(r, depth + 1), junk(r, depth + 1)];
    case 9:
      return depth > 2
        ? {}
        : { campaign_id: junk(r, depth + 1), cost: junk(r, depth + 1), status: junk(r, depth + 1) };
    case 10:
      return "";
    case 11:
      return Math.floor(r() * 1e6);
    case 12:
      return "ENABLED";
    default:
      return {
        campaign_id: String(Math.floor(r() * 5)),
        ad_group_id: String(Math.floor(r() * 5)),
        cost: junk(r, depth + 1),
        clicks: junk(r, depth + 1),
        conversions: junk(r, depth + 1),
        metric_date: r() > 0.5 ? "2026-08-01" : junk(r, depth + 1),
        text: junk(r, depth + 1),
        search_term: junk(r, depth + 1),
        status: r() > 0.5 ? "ENABLED" : junk(r, depth + 1),
        type: r() > 0.5 ? "SEARCH" : junk(r, depth + 1),
      };
  }
}

describe("runChecks never throws", () => {
  const shapes: unknown[] = [
    null,
    undefined,
    0,
    "data",
    [],
    { data: null },
    { data: [] },
    { data: "x" },
    { data: { campaigns: "not rows" } },
    { data: {}, statusRows: "x" },
    { data: {}, runDate: "yesterday" },
    { data: {}, runDate: "2026-02-30" },
  ];
  for (const [i, shape] of shapes.entries()) {
    it(`returns a result for malformed shape #${i}`, () => {
      const r = runChecks(shape);
      expect(r.checks).toHaveLength(CHECKS);
    });
  }

  it("survives 300 random malformed inputs, each with every check accounted for", () => {
    const r = rng(42);
    for (let n = 0; n < 300; n++) {
      const data: Record<string, unknown> = { currencyCode: r() > 0.3 ? "USD" : junk(r) };
      for (const k of ACCOUNT_DATA_ARRAY_KEYS) {
        if (r() < 0.6) continue;
        data[k] = r() < 0.15 ? junk(r) : Array.from({ length: Math.floor(r() * 6) }, () => junk(r));
      }
      const input = {
        data,
        tables:
          r() > 0.5 ? { placement_performance: [junk(r)], sync_table_status: junk(r) } : junk(r),
        statusRows:
          r() > 0.5
            ? [{ table_name: "campaigns", status: junk(r), row_count: junk(r) }, junk(r)]
            : undefined,
        runDate: r() > 0.2 ? RUN_DATE : undefined,
        settings:
          r() > 0.5
            ? { bidding: { relearnDays: junk(r), lostIsBudgetPct: junk(r) }, floors: junk(r) }
            : junk(r),
        clientContext: r() > 0.7 ? { campaigns: { "1": { target: "ROAS 3:1" } } } : undefined,
        clock: () => 0,
      };
      let result: ReturnType<typeof runChecks> | undefined;
      expect(() => {
        result = runChecks(input);
      }).not.toThrow();
      expect(result?.checks).toHaveLength(CHECKS);
      for (const c of result?.checks ?? [])
        expect(["finding", "info", "clean", "not_run", "suppressed"]).toContain(c.status);
    }
  });

  it("handles a huge array of junk rows, counting what it dropped", () => {
    const rows: unknown[] = Array.from({ length: 20_000 }, (_, i) =>
      i % 3 === 0 ? null : i % 3 === 1 ? "junk" : { campaign_id: "1", cost: "NaN" },
    );
    const r = runChecks({
      data: { currencyCode: "USD", keywords: rows },
      runDate: RUN_DATE,
      clock: () => 0,
    });
    expect(r.checks).toHaveLength(CHECKS);
    expect(r.warnings.join(" ")).toMatch(
      /data\.keywords: 13334 row\(s\) were not objects and were dropped/,
    );
  });

  it("rejects a wrong type for what the caller states, with a clear error and no run", () => {
    const base = buildInput({ campaigns: [{ id: "11" }] });
    const r1 = runChecks({ ...base, data: { ...base.data, profile: { brandTerms: "Acme" } } });
    expect(r1.errors).toEqual(["data.profile.brandTerms must be an array of strings"]);
    expect(
      r1.checks.every((c) => c.status === "not_run" && /input rejected/.test(c.reason ?? "")),
    ).toBe(true);
    const r2 = runChecks({ ...base, clientContext: { campaigns: { "11": "ROAS 3:1" } } });
    expect(r2.errors).toEqual(['clientContext.campaigns["11"] must be an object']);
    const r3 = runChecks({ ...base, businessType: "shop" });
    expect(r3.errors[0]).toMatch(/businessType must be one of/);
  });

  it("drops null and non-object rows with a counted warning and still runs", () => {
    const base = buildInput({ campaigns: [{ id: "11", strategy: "MAXIMIZE_CONVERSIONS" }] });
    const r = runChecks({
      ...base,
      data: { ...base.data, campaigns: [...(base.data.campaigns ?? []), null, 7, "x"] },
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContain("data.campaigns: 3 row(s) were not objects and were dropped");
    expect(outcome(r, "BB14")?.status).toBe("finding");
  });

  it("coerces numeric strings in metric fields and treats NaN as unknown", () => {
    const base = buildInput({ campaigns: [{ id: "11", strategy: "MAXIMIZE_CONVERSIONS" }] });
    const asStrings = (base.data.campaigns ?? []).map((c) => ({
      ...c,
      cost: String(c.cost),
      conversions: String(c.conversions),
      conversion_value: String(c.conversion_value),
    }));
    const r = runChecks({ ...base, data: { ...base.data, campaigns: asStrings } });
    expect(outcome(r, "BB14")?.status).toBe("finding");
  });

  it("a model that cannot be built makes every check not_run with the reason", () => {
    const hostile = {
      toString() {
        throw new Error("boom");
      },
    };
    const r = runEvidenceEngine({
      data: { currencyCode: "USD", campaigns: [{ campaign_id: hostile }] },
      auditId: "x",
      clock: () => 0,
    });
    expect(r.notCheckable).toHaveLength(CHECKS);
    expect(r.notCheckable.every((n) => n.reason === "account model could not be built: boom")).toBe(
      true,
    );
  });
});

describe("unreadable tables fail closed", () => {
  const withKeywordStatus = (status: string, message?: string) => {
    const input = buildInput({
      campaigns: [{ id: "11" }],
      data: {
        adGroups: [adGroup({ id: "21", campaignId: "11" })],
        keywords: [
          keyword({
            id: "31",
            campaignId: "11",
            adGroupId: "21",
            text: "boots",
            cost: 200,
            clicks: 100,
            conv: 0,
          }),
        ],
      },
    });
    const statusRows = (input.statusRows ?? []).map((s) =>
      s.table_name === "keywords" ? { ...s, status, error_message: message ?? null } : s,
    );
    return runChecks({ ...input, statusRows });
  };
  for (const status of ["failed", "not_allowed", "error", "partial", "OK?", ""]) {
    it(`status '${status}' makes the keyword checks not_run`, () => {
      const r = withKeywordStatus(status);
      for (const id of ["SK01", "SK02", "SK03", "SK04"]) {
        expect({ id, status: outcome(r, id)?.status }).toEqual({ id, status: "not_run" });
        expect(outcome(r, id)?.reason).toMatch(/keywords could not be read/);
      }
    });
  }
  it("names the access level when the read was not allowed", () => {
    expect(outcome(withKeywordStatus("not_allowed"), "SK01")?.reason).toMatch(
      /access level does not allow/,
    );
  });
  it("'skipped' is not read, not clean", () => {
    const r = withKeywordStatus("skipped", "no Search campaigns");
    expect(outcome(r, "SK01")?.status).toBe("not_run");
    expect(outcome(r, "SK01")?.reason).toMatch(/keywords was not read: no Search campaigns/);
  });
  it("'ok' is readable", () => {
    expect(outcome(withKeywordStatus("ok"), "SK01")?.status).toBe("finding");
  });
});

describe("row_count against the rows provided", () => {
  const twoKeywords = [
    keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "boots" }),
    keyword({ id: "32", campaignId: "11", adGroupId: "22", text: "shoes" }),
  ];
  const input = (rowCount: number, rows = twoKeywords) => {
    const base = buildInput({
      campaigns: [{ id: "11" }],
      data: {
        adGroups: [
          adGroup({ id: "21", campaignId: "11" }),
          adGroup({ id: "22", campaignId: "11" }),
        ],
        keywords: rows,
      },
    });
    return {
      ...base,
      statusRows: (base.statusRows ?? []).map((s) =>
        s.table_name === "keywords" ? { ...s, row_count: rowCount } : s,
      ),
    };
  };
  it("more rows declared than provided: a clean check becomes not_run, naming the gap", () => {
    const r = runChecks(input(10));
    const sk04 = outcome(r, "SK04");
    expect(sk04?.status).toBe("not_run");
    expect(sk04?.reason).toMatch(/only 2 of 10 rows were provided/);
    expect(r.warnings.join(" ")).toMatch(/keywords: only 2 of 10 rows were provided/);
  });
  it("a finding on incomplete data still stands and carries the gap", () => {
    const first = keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "boots" });
    const dup = [first, { ...first, keyword_id: "33", ad_group_id: "22" }];
    const r = runChecks(input(10, dup));
    expect(outcome(r, "SK04")?.status).toBe("finding");
    const f = r.findings.find((x) => x.checkId === "SK04");
    expect(f?.limitedBy?.join(" ")).toMatch(/incomplete data/);
  });
  it("more rows provided than declared is a warning", () => {
    const r = runChecks(input(1));
    expect(r.warnings.join(" ")).toMatch(
      /keywords: 2 rows were provided but the status row counts 1/,
    );
  });
  it("matching counts: no warning, judged normally", () => {
    const r = runChecks(input(2));
    expect(outcome(r, "SK04")?.status).toBe("clean");
    expect(r.warnings).toEqual([]);
  });
});

describe("row limits come from the caller", () => {
  const base = () =>
    buildInput({
      campaigns: [{ id: "11" }],
      data: {
        adGroups: [adGroup({ id: "21", campaignId: "11" })],
        searchTerms: [searchTerm({ campaignId: "11", adGroupId: "21", term: "boots" })],
      },
    });
  it("without caps nothing is treated as a sample", () => {
    expect(runChecks(base()).dataQuality.tables.searchTerms?.truncated).toBe(false);
  });
  it("a table at the caller's limit is a sample", () => {
    const r = runChecks({ ...base(), caps: { searchTerms: 1 } });
    expect(r.dataQuality.tables.searchTerms).toMatchObject({ truncated: true, cap: 1 });
  });
  it("a bad cap is ignored with a warning", () => {
    expect(runChecks({ ...base(), caps: { searchTerms: -3 } }).warnings).toContain(
      "caps.searchTerms must be a positive number; ignored",
    );
  });
  it("a cap under a name no table answers to is reported (it limits nothing)", () => {
    const r = runChecks({
      ...base(),
      caps: {
        searchTerm: 5,
        search_terms: 5,
        searchTerms: 5,
        "pmaxSearchTerms:per_campaign": 5,
        "keywords:per_group": 5,
      },
    });
    const unused = r.warnings.filter((w) => w.includes("names no table"));
    expect(unused).toHaveLength(2);
    expect(unused.join(" ")).toMatch(/caps\.searchTerm names/);
    expect(unused.join(" ")).toMatch(/caps\.keywords:per_group names/);
  });
});

describe("settings validation", () => {
  it("rejects a re-learning window of zero days, keeps the default and says so", () => {
    const { settings, warnings } = validateSettings({ bidding: { relearnDays: 0 } });
    expect(settings.bidding.relearnDays).toBe(14);
    expect(warnings.join(" ")).toMatch(/relearnDays: must be at least 1/);
  });
  it("warns on a fraction given to a percent key", () => {
    const { settings, warnings } = validateSettings({ bidding: { lostIsBudgetPct: 0.1 } });
    expect(settings.bidding.lostIsBudgetPct).toBe(10);
    expect(warnings.join(" ")).toMatch(/looks like a fraction/);
  });
  it("rejects a date that is not a real ISO date", () => {
    expect(
      validateSettings({ bidding: { looseTargetFromDate: "2026-13-01" } }).warnings.join(" "),
    ).toMatch(/real date/);
    expect(
      validateSettings({ bidding: { looseTargetFromDate: "2026-08-17" } }).settings.bidding
        .looseTargetFromDate,
    ).toBe("2026-08-17");
  });
  it("rejects a share at or above 1 that would silence SK03", () => {
    const { settings, warnings } = validateSettings({ search: { matchTypeConcentrationShare: 1 } });
    expect(settings.search.matchTypeConcentrationShare).toBe(0.8);
    expect(warnings.join(" ")).toMatch(/must be below 1/);
  });
  it("keeps the default tiers when B is not above A", () => {
    const { settings, warnings } = validateSettings({
      floors: { spendTierAMaxMonthlyUsd: 20_000 },
    });
    expect(settings.floors.spendTierAMaxMonthlyUsd).toBe(3_700);
    expect(warnings.join(" ")).toMatch(/spendTierBMaxMonthlyUsd must be above/);
  });
  it("reports unknown groups and keys", () => {
    const { warnings } = validateSettings({ biding: {}, search: { lowQs: 3 } });
    expect(warnings).toEqual([
      "settings.biding: unknown group, ignored",
      "settings.search.lowQs: unknown key, ignored",
    ]);
  });
  it("every ignored override reaches the run's warnings", () => {
    const r = runChecks({
      ...buildInput({ campaigns: [{ id: "11" }] }),
      settings: { bidding: { relearnDays: -1 } },
    });
    expect(r.warnings.join(" ")).toMatch(/settings\.bidding\.relearnDays/);
    expect(r.settings.bidding.relearnDays).toBe(14);
  });
  it("floors are overridable: a shorter learning age lets a 9-day campaign be judged", () => {
    const input = buildInput({
      campaigns: [{ id: "11", strategy: "MAXIMIZE_CONVERSION_VALUE", conv: 5, days: 9 }],
    });
    expect(outcome(runChecks(input), "BB06")?.status).toBe("suppressed");
    expect(
      outcome(runChecks({ ...input, settings: { floors: { learningMinAgeDays: 5 } } }), "BB06")
        ?.status,
    ).toBe("finding");
  });
});

describe("output does not depend on row order", () => {
  function busy(): EvidenceInput {
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
        },
        { id: "13", name: "Prospecting", strategy: "MAXIMIZE_CONVERSIONS", budget: 300, cost: 60 },
      ],
      data: {
        adGroups: [
          adGroup({ id: "21", campaignId: "11" }),
          adGroup({ id: "22", campaignId: "11" }),
          adGroup({ id: "23", campaignId: "13" }),
        ],
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
          keyword({
            id: "33",
            campaignId: "13",
            adGroupId: "23",
            text: "trail shoes",
            cost: 400,
            clicks: 200,
            conv: 0,
            qs: 2,
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
            campaignId: "13",
            adGroupId: "23",
            term: "cheap trail shoes",
            cost: 300,
            clicks: 150,
          }),
        ],
      },
    });
  }
  const reverseAll = (input: EvidenceInput): EvidenceInput => {
    const data: Record<string, unknown> = { ...input.data };
    for (const [k, v] of Object.entries(data)) if (Array.isArray(v)) data[k] = [...v].reverse();
    const tables: Record<string, unknown[]> = {};
    for (const [k, v] of Object.entries(input.tables ?? {})) tables[k] = [...v].reverse();
    return {
      ...input,
      data: data as EvidenceInput["data"],
      tables: tables as EvidenceInput["tables"],
      statusRows: [...(input.statusRows ?? [])].reverse(),
    };
  };
  it("reversing every array gives byte-identical output", () => {
    const a = JSON.stringify(runChecks(busy()));
    const b = JSON.stringify(runChecks(reverseAll(busy())));
    expect(b).toBe(a);
    expect(JSON.parse(a).findings.length).toBeGreaterThan(3);
  });
});

describe("completeness covers parent tables, caps, legacy counts, duplicates and unknown status", () => {
  const kw = [
    keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "boots" }),
    keyword({ id: "32", campaignId: "11", adGroupId: "22", text: "shoes" }),
  ];
  const base = (extra: Partial<Parameters<typeof buildInput>[0]> = {}) =>
    buildInput({
      campaigns: [{ id: "11" }],
      data: {
        adGroups: [
          adGroup({ id: "21", campaignId: "11" }),
          adGroup({ id: "22", campaignId: "11" }),
        ],
        keywords: kw,
      },
      ...extra,
    });
  const withStatus = (table: string, patch: Record<string, unknown>, input = base()) => ({
    ...input,
    statusRows: (input.statusRows ?? []).map((s) =>
      s.table_name === table ? { ...s, ...patch } : s,
    ),
  });
  it("control: complete data is judged clean", () => {
    expect(outcome(runChecks(base()), "SK04")?.status).toBe("clean");
  });
  it("partial ad groups (a parent) block a clean keyword result", () => {
    const o = outcome(runChecks(withStatus("ad_groups", { row_count: 9 })), "SK04");
    expect(o?.status).toBe("not_run");
    expect(o?.reason).toMatch(/ad_groups: only 2 of 9 rows were provided/);
    expect(o?.category).toBe("incomplete_data");
  });
  it("partial campaigns block it too", () => {
    expect(outcome(runChecks(withStatus("campaigns", { row_count: 3 })), "SK04")?.reason).toMatch(
      /campaigns: only 1 of 3 rows/,
    );
  });
  it("failed campaigns block it", () => {
    const o = outcome(runChecks(withStatus("campaigns", { status: "failed" })), "SK04");
    expect(o?.status).toBe("not_run");
    expect(o?.reason).toMatch(/campaigns could not be read/);
  });
  it("a table at the caller's row limit is partial: keywords", () => {
    const o = outcome(runChecks({ ...base(), caps: { keywords: 2 } }), "SK04");
    expect(o?.status).toBe("not_run");
    expect(o?.reason).toMatch(/reached the reader's row limit of 2/);
  });
  it("a table at the caller's row limit is partial: search terms (clean blocked, finding stands with the gap)", () => {
    const terms = (conv: number) =>
      buildInput({
        campaigns: [{ id: "11" }],
        data: {
          adGroups: [adGroup({ id: "21", campaignId: "11" })],
          searchTerms: [
            searchTerm({
              campaignId: "11",
              adGroupId: "21",
              term: "boots",
              cost: 200,
              clicks: 100,
              conv,
            }),
          ],
        },
      });
    expect(outcome(runChecks({ ...terms(3), caps: { searchTerms: 1 } }), "SK05")?.status).toBe(
      "not_run",
    );
    const r = runChecks({ ...terms(0), caps: { searchTerms: 1 } });
    expect(outcome(r, "SK05")?.status).toBe("finding");
    expect(r.findings.find((f) => f.checkId === "SK05")?.limitedBy?.join(" ")).toMatch(/row limit/);
  });
  it("a legacy count above the rows provided is partial", () => {
    const input = base({ noMarker: ["keywords"] });
    const o = outcome(runChecks({ ...input, legacyCounts: { keywords_count: 5 } }), "SK04");
    expect(o?.status).toBe("not_run");
    expect(o?.reason).toMatch(/keywords: only 2 of 5 rows were provided/);
    expect(
      outcome(runChecks({ ...input, legacyCounts: { keywords_count: 2 } }), "SK04")?.status,
    ).toBe("clean");
  });
  it("duplicate status rows: the worst wins", () => {
    const input = base();
    const dup = (row: Record<string, unknown>) => ({
      ...input,
      statusRows: [...(input.statusRows ?? []), { table_name: "keywords", ...row }],
    });
    expect(outcome(runChecks(dup({ status: "failed" })), "SK04")?.reason).toMatch(
      /keywords could not be read/,
    );
    expect(outcome(runChecks(dup({ status: "ok", row_count: 10 })), "SK04")?.reason).toMatch(
      /only 2 of 10/,
    );
    const skippedThenFailed = {
      ...input,
      statusRows: [
        ...(input.statusRows ?? []).filter((s) => s.table_name !== "keywords"),
        { table_name: "keywords", status: "skipped" },
        { table_name: "keywords", status: "not_allowed" },
      ],
    };
    expect(outcome(runChecks(skippedThenFailed), "SK04")?.reason).toMatch(
      /keywords could not be read: the access level/,
    );
  });
  it("rows but no status row: completeness unknown, unless the caller vouches", () => {
    const input = base({ noMarker: ["keywords"] });
    const o = outcome(runChecks(input), "SK04");
    expect(o?.status).toBe("not_run");
    expect(o?.reason).toMatch(/completeness unknown: no read status was provided for keywords/);
    expect(outcome(runChecks({ ...input, assumeComplete: true }), "SK04")?.status).toBe("clean");
  });
});

describe("rows that cannot be ordered", () => {
  it("a cyclic row and a 20,000-deep row are dropped with a warning; the run goes on", () => {
    const input = buildInput({
      campaigns: [{ id: "11", strategy: "MAXIMIZE_CONVERSIONS" }],
      data: {
        adGroups: [adGroup({ id: "21", campaignId: "11" })],
        keywords: [keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "boots" })],
      },
    });
    const cyclic: Record<string, unknown> = { keyword_id: "99", ad_group_id: "21" };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    const root = { keyword_id: "98", ad_group_id: "21", nest: deep };
    for (let i = 0; i < 20_000; i++) {
      const next: Record<string, unknown> = {};
      deep.n = next;
      deep = next;
    }
    const r = runChecks({
      ...input,
      data: { ...input.data, keywords: [...(input.data.keywords ?? []), cyclic, root] },
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(
      /data\.keywords: 2 row\(s\) were nested deeper than 32 levels or contained themselves/,
    );
    expect(outcome(r, "BB14")?.status).toBe("finding");
  });
});

describe("every setting at its allowed extremes is either the default or reported", () => {
  const busyInput = buildInput({
    campaigns: [
      {
        id: "11",
        strategy: "TARGET_ROAS",
        targetRoas: 2,
        budget: 100,
        cost: 100,
        is: { lostBudget: 0.2, lostRank: 0.35 },
      },
    ],
    data: {
      adGroups: [adGroup({ id: "21", campaignId: "11" })],
      keywords: [
        keyword({
          id: "31",
          campaignId: "11",
          adGroupId: "21",
          text: "boots",
          cost: 200,
          clicks: 100,
          conv: 0,
          qs: 3,
        }),
      ],
    },
  });
  const extremes = (
    rule: (typeof SETTING_RULES)["bidding"][keyof (typeof SETTING_RULES)["bidding"]],
  ): unknown[] => {
    if (rule.unit === "date") return ["", "2026-01-01"];
    const eps = rule.integer ? 1 : 1e-6;
    const min = rule.min ?? 0;
    const max = rule.max ?? 0;
    return [rule.minEx ? min + eps : min, rule.maxEx ? max - eps : max];
  };
  for (const [group, rules] of Object.entries(SETTING_RULES)) {
    for (const [key, rule] of Object.entries(
      rules as Record<string, Parameters<typeof extremes>[0]>,
    )) {
      it(`${group}.${key}`, () => {
        for (const value of extremes(rule)) {
          const r = runChecks({ ...busyInput, settings: { [group]: { [key]: value } } });
          expect(r.errors).toEqual([]);
          const used = r.settingsUsed.find((u) => u.key === `${group}.${key}`);
          const def = (DEFAULT_SETTINGS as unknown as Record<string, Record<string, unknown>>)[
            group
          ]?.[key];
          const kept = (r.settings as unknown as Record<string, Record<string, unknown>>)[group]?.[
            key
          ];
          // accepted and reported, or rejected with a warning (cross-key rules), or equal to the default
          if (kept === def)
            expect(value === def || r.warnings.some((w) => w.includes(group))).toBe(true);
          else expect(used).toEqual({ key: `${group}.${key}`, default: def, value: kept });
        }
      });
    }
  }
  it("rejects values that would make a bar unreachable", () => {
    const bad: Array<[string, string, unknown]> = [
      ["bidding", "lostIsRankPct", 100],
      ["bidding", "lostIsBudgetPct", 0],
      ["bidding", "scaleUtilMin", 1.5],
      ["bidding", "budgetLimitedUtil", 1.2],
      ["search", "lowQsSpendShareOfMonthly", 1],
      ["floors", "strongConv", 201],
      ["bidding", "targetRoasMinConv30d", 500],
      ["floors", "wasteBand50kPlusUsd", 150_000],
    ];
    for (const [g, k, v] of bad) {
      const { settings, warnings } = validateSettings({ [g]: { [k]: v } });
      expect({
        k,
        kept: (settings as unknown as Record<string, Record<string, unknown>>)[g]?.[k],
      }).toEqual({
        k,
        kept: (DEFAULT_SETTINGS as unknown as Record<string, Record<string, unknown>>)[g]?.[k],
      });
      expect(warnings.length).toBeGreaterThan(0);
    }
  });
  it("waste bands must stay ordered", () => {
    const { settings, warnings } = validateSettings({ floors: { wasteBandUnder1kUsd: 500 } });
    expect(settings.floors.wasteBandUnder1kUsd).toBe(20);
    expect(warnings.join(" ")).toMatch(/must not shrink/);
  });
  it("an accepted override is listed in settingsUsed", () => {
    expect(
      runChecks({ ...busyInput, settings: { bidding: { relearnDays: 7 } } }).settingsUsed,
    ).toEqual([{ key: "bidding.relearnDays", default: 14, value: 7 }]);
    expect(runChecks(busyInput).settingsUsed).toEqual([]);
  });
});

describe("round 3: window table, orphans, caps by table name, dropped rows, bad row counts", () => {
  const kw = [
    keyword({ id: "31", campaignId: "11", adGroupId: "21", text: "boots" }),
    keyword({ id: "32", campaignId: "11", adGroupId: "22", text: "shoes" }),
  ];
  const base = (keywords: unknown[] = kw, extra: Partial<Parameters<typeof buildInput>[0]> = {}) =>
    buildInput({
      campaigns: [{ id: "11", budget: 100, cost: 90 }],
      data: {
        adGroups: [
          adGroup({ id: "21", campaignId: "11" }),
          adGroup({ id: "22", campaignId: "11" }),
        ],
        keywords: keywords as Parameters<typeof buildInput>[0]["campaigns"],
      } as never,
      ...extra,
    });
  const status = (input: EvidenceInput, table: string, patch: Record<string, unknown>) => ({
    ...input,
    statusRows: (input.statusRows ?? []).map((s) =>
      s.table_name === table ? { ...s, ...patch } : s,
    ),
  });
  it("control: BB01 and SK04 are clean", () => {
    const r = runChecks(base());
    expect(outcome(r, "BB01")?.status).toBe("clean");
    expect(outcome(r, "SK04")?.status).toBe("clean");
  });
  it("the window table counts: 90 daily rows against a row_count of 91 blocks BB01", () => {
    const o = outcome(runChecks(status(base(), "daily_metrics", { row_count: 91 })), "BB01");
    expect(o?.status).toBe("not_run");
    expect(o?.reason).toMatch(/daily_metrics: only 90 of 91 rows/);
  });
  it("orphan rows block a clean result: an ad group id that does not exist", () => {
    const rows = [...kw, keyword({ id: "33", campaignId: "11", adGroupId: "99", text: "socks" })];
    const o = outcome(runChecks(base(rows)), "SK04");
    expect(o?.status).toBe("not_run");
    expect(o?.reason).toMatch(/1 row\(s\) of keywords point at a missing ad group/);
  });
  it("orphan rows block a clean result: a null ad group id", () => {
    const rows = [
      ...kw,
      {
        ...keyword({ id: "33", campaignId: "11", adGroupId: "21", text: "socks" }),
        ad_group_id: null,
      },
    ];
    expect(outcome(runChecks(base(rows)), "SK04")?.reason).toMatch(/point at a missing ad group/);
  });
  it("caps accept the table name", () => {
    const input = buildInput({
      campaigns: [{ id: "11" }],
      data: {
        adGroups: [adGroup({ id: "21", campaignId: "11" })],
        searchTerms: [searchTerm({ campaignId: "11", adGroupId: "21", term: "boots", conv: 3 })],
      },
    });
    const r = runChecks({ ...input, caps: { search_terms: 1 } });
    expect(r.dataQuality.tables.searchTerms).toMatchObject({ truncated: true, cap: 1 });
    expect(outcome(r, "SK05")?.status).toBe("not_run");
  });
  it("a dropped row makes its table incomplete even with no row count", () => {
    const input = status(base([null, ...kw]), "keywords", { row_count: null });
    const o = outcome(runChecks(input), "SK04");
    expect(o?.status).toBe("not_run");
    expect(o?.reason).toMatch(/keywords: 1 row\(s\) were dropped as unusable/);
  });
  for (const bad of ["lots", -5, 1.5, Number.NaN]) {
    it(`row_count ${String(bad)} is not a count: warning and completeness unknown`, () => {
      const r = runChecks(status(base(), "keywords", { row_count: bad }));
      expect(r.warnings.join(" ")).toMatch(/keywords has row_count .* not a whole number of rows/);
      expect(outcome(r, "SK04")?.status).toBe("not_run");
      expect(outcome(r, "SK04")?.reason).toMatch(/completeness is unknown/);
    });
  }
  it("BB16: an incomplete change history blocks even a finding (a missing change could cancel it)", () => {
    const loose = buildInput({
      campaigns: [
        {
          id: "11",
          strategy: "TARGET_ROAS",
          targetRoas: 2,
          conv: 2,
          value: 400,
          cost: 100,
          is: { lostBudget: 0.2 },
        },
      ],
      syncedEmpty: ["changeHistory"],
    });
    expect(outcome(runChecks(loose), "BB16")?.status).toBe("finding");
    const o = outcome(runChecks(status(loose, "change_history", { row_count: 4 })), "BB16");
    expect(o?.status).toBe("not_run");
    expect(o?.reason).toMatch(/change_history: only 0 of 4 rows/);
  });
  it("each outcome lists only the overrides that check reads", () => {
    const r = runChecks({
      ...base(),
      settings: { search: { matchTypeConcentrationShare: 0.9 }, bidding: { relearnDays: 7 } },
    });
    expect(outcome(r, "SK03")?.settingsApplied).toEqual([
      { key: "search.matchTypeConcentrationShare", default: 0.8, value: 0.9 },
    ]);
    expect(outcome(r, "BB17")?.settingsApplied).toEqual([
      { key: "bidding.relearnDays", default: 14, value: 7 },
    ]);
    expect(outcome(r, "SK04")?.settingsApplied).toEqual([]);
  });
});
