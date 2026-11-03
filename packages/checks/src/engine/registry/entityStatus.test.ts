// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The entity activity gate. Pure unit tests: the rule is about status and spend,
 * not about one account. A paused campaign must never carry a present-tense
 * finding.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings.js";
import {
  applyActivityGate,
  type CheckCtx,
  type CheckFinding,
  type CheckResult,
} from "../checks/types.js";
import { classifyActivity, isReportable, reportableCampaigns, statusOf } from "./entityStatus.js";

const node = (id: string, status: string | null, cost: number): any => ({
  kind: "campaign",
  id,
  name: `campaign ${id}`,
  parentId: null,
  ...(status == null ? {} : { status }),
  windows: { m90: { cost } },
  attrs: {},
});

const modelOf = (campaigns: any[]): any => ({ children: { campaigns } });

const ctxOf = (
  campaigns: any[],
  extra: Partial<Record<"keywords" | "assetGroups", any[]>> = {},
): CheckCtx => {
  const model = modelOf(campaigns);
  const index = {
    campaignsById: new Map(campaigns.map((c) => [c.id, c])),
    adGroupsById: new Map(),
    keywordsById: new Map((extra.keywords ?? []).map((k) => [k.id, k])),
    adsById: new Map(),
    assetGroupsById: new Map((extra.assetGroups ?? []).map((g) => [g.id, g])),
    extensionsById: new Map(),
    conversionActionsById: new Map(),
  };
  return {
    model,
    metrics: { index } as any,
    get: (id: string) =>
      ({
        id,
        value: "PAUSED",
        unit: "enum",
        level: "campaign",
        entityId: null,
        window: null,
        source: { table: "campaigns" },
        maturity: { rule: "N/A", settledStrict: null, settledPractical: null },
        markerState: "ok",
        sample: { truncated: false },
      }) as any,
    window: {} as any,
    currency: {} as any,
    // this suite is about the ACTIVITY gate; the type gate is exercised in gates.test.ts
    businessType: "ecommerce",
    settings: DEFAULT_SETTINGS,
  };
};

const findingOn = (scope: CheckFinding["scope"]): CheckFinding => ({
  claimKey: "x.y",
  scope,
  evidence: [],
  facts: {},
  sample: { truncated: false, population: 1 },
  settled: { strict: true, practical: true },
  markerState: "ok",
});

describe("classifyActivity — three states, not a boolean", () => {
  it("ENABLED is live whatever it spent", () => {
    expect(classifyActivity(node("1", "ENABLED", 0))).toBe("live");
    expect(classifyActivity(node("1", "enabled", 900))).toBe("live");
  });

  it("PAUSED with spend in the window is recently-active — real money moved, so the fact survives as context", () => {
    expect(classifyActivity(node("1", "PAUSED", 2753.67))).toBe("recently-active");
  });

  it("but recently-active is NOT reportable: only a live entity may carry a finding (2026-09-07)", () => {
    expect(isReportable(node("1", "ENABLED", 0))).toBe(true);
    expect(isReportable(node("1", "PAUSED", 2753.67))).toBe(false);
    expect(isReportable(node("1", "PAUSED", 0))).toBe(false);
    expect(isReportable(node("1", "REMOVED", 900))).toBe(false);
  });

  it("PAUSED with no spend, REMOVED, and an UNKNOWN status are all dormant (rule 383; handover rule 4)", () => {
    expect(classifyActivity(node("1", "PAUSED", 0))).toBe("dormant");
    expect(classifyActivity(node("1", "REMOVED", 5000))).toBe("dormant");
    expect(classifyActivity(node("1", null, 5000))).toBe("dormant");
    expect(classifyActivity(node("1", "   ", 5000))).toBe("dormant");
  });

  it("reads the explicit attrs.status the leaf nodes now carry, and never guesses ENABLED", () => {
    const kw: any = {
      id: "k",
      name: "k",
      windows: { m90: { cost: 10 } },
      attrs: { status: "PAUSED" },
    };
    expect(statusOf(kw)).toBe("PAUSED");
    expect(statusOf({ windows: { m90: { cost: 10 } }, attrs: { status: null } })).toBeNull();
    expect(classifyActivity({ windows: { m90: { cost: 10 } }, attrs: { status: null } })).toBe(
      "dormant",
    );
  });
});

describe("reportableCampaigns — rule 384 counts", () => {
  it("counts only campaigns that are actually running — a paused campaign is out even if it spent", () => {
    const cs = [
      node("1", "ENABLED", 100),
      node("2", "PAUSED", 50),
      node("3", "PAUSED", 0),
      node("4", "REMOVED", 900),
    ];
    expect(reportableCampaigns(modelOf(cs)).map((c) => c.id)).toEqual(["1"]);
  });

  it("when every campaign is dormant (paused, or removed after spending), none is reportable", () => {
    const cs = [node("1", "PAUSED", 0), node("2", "REMOVED", 900)];
    expect(reportableCampaigns(modelOf(cs))).toEqual([]);
  });
});

describe("applyActivityGate — what a check is allowed to publish", () => {
  const live = node("1", "ENABLED", 100);
  const paused = node("2", "PAUSED", 2753.67);
  const dormant = node("3", "PAUSED", 0);

  const fires = (findings: CheckFinding[]): CheckResult => ({ state: "fires", findings });

  it("drops a finding whose campaign is dormant", () => {
    const ctx = ctxOf([live, paused, dormant]);
    const r = applyActivityGate(
      ctx,
      fires([findingOn({ type: "campaign", id: "3", name: "campaign 3" })]),
    );
    expect(r).toMatchObject({ state: "fires", findings: [] });
    expect(r.state === "fires" && r.withheld?.join(" ")).toMatch(/not running/);
  });

  it("N12 — a live campaign that spent $0: only delivery checks may speak about it", () => {
    const idle = node("4", "ENABLED", 0);
    const ctx = ctxOf([live, idle]);
    const on = fires([findingOn({ type: "campaign", id: "4", name: "campaign 4" })]);
    const sl04 = applyActivityGate(ctx, on, "SL04");
    expect(sl04).toMatchObject({ state: "fires", findings: [] });
    expect(sl04.state === "fires" && sl04.withheld?.join(" ")).toMatch(
      /1 finding\(s\) held back: each was about a campaign that spent nothing in the 90 days read \(campaign 4\)/,
    );
    // a delivery blocker (a bid target choking delivery) keeps it
    expect(applyActivityGate(ctx, on, "BB05")).toMatchObject({
      findings: [{ scope: { id: "4" } }],
    });
    // so do assets short, products never served, a negative blocking a keyword,
    // same-priority Shopping campaigns and a campaign bidding on another goal
    for (const id of ["PX03", "PX13", "SH10", "SH19", "SK33", "MI07"])
      expect(applyActivityGate(ctx, on, id)).toMatchObject({
        findings: [{ scope: { id: "4" } }],
      });
    // unknown spend is not "spent nothing"
    const unknown = { ...node("5", "ENABLED", 0), windows: { m90: { cost: null } } };
    const onUnknown = fires([findingOn({ type: "campaign", id: "5", name: "campaign 5" })]);
    expect(applyActivityGate(ctxOf([unknown]), onUnknown, "SL04")).toMatchObject({
      findings: [{ scope: { id: "5" } }],
    });
  });

  it("rule 345 — drops a keyword finding because the CAMPAIGN it sits in is dormant", () => {
    const kw: any = {
      id: "k1",
      name: "cheap totes",
      windows: { m90: { cost: 5 } },
      attrs: { status: "ENABLED" },
    };
    const ctx = ctxOf([live, dormant], { keywords: [kw] });
    const r = applyActivityGate(
      ctx,
      fires([findingOn({ type: "keyword", id: "k1", name: "cheap totes", campaignId: "3" })]),
    );
    expect(r).toMatchObject({ state: "fires", findings: [] });
    expect(r.state === "fires" && r.withheld?.join(" ")).toMatch(/not running/);
  });

  /**
   * This replaces the old rule-108 test, which asserted the opposite: that a
   * PAUSED-but-spent scope KEEPS its finding as long as the status is stamped
   * on it for the writer to disclose. Run c8ae6cfd is why it changed. The
   * disclosure appeared in `Technical details` as `E.entity_status … PAUSED`
   * while the headline of the same card read "$25 a month is being spent
   * without return" about a campaign that had been switched off. Every one of
   * that report's four money-bearing findings was this shape.
   */
  it("drops a finding on a PAUSED-but-spent scope — no monthly rate is true about a campaign that stopped", () => {
    const ctx = ctxOf([live, paused]);
    const r = applyActivityGate(
      ctx,
      fires([findingOn({ type: "campaign", id: "2", name: "campaign 2" })]),
    );
    expect(r).toMatchObject({ state: "fires", findings: [] });
    expect(r.state === "fires" && r.withheld?.join(" ")).toMatch(/not running/);
  });

  it("drops a product finding because the ASSET GROUP holding it is switched off, inside a live campaign", () => {
    const ag: any = {
      id: "ag1",
      name: "Feed Only",
      windows: { m90: { cost: 80 } },
      status: "PAUSED",
    };
    const ctx = ctxOf([live], { assetGroups: [ag] });
    const r = applyActivityGate(
      ctx,
      fires([
        findingOn({
          type: "product",
          id: "p1",
          name: "Canvas tote",
          campaignId: "1",
          assetGroupId: "ag1",
        }),
      ]),
    );
    expect(r).toMatchObject({ state: "fires", findings: [] });
    expect(r.state === "fires" && r.withheld?.join(" ")).toMatch(/not running/);
  });

  it("a live scope is untouched, and a scope the model cannot resolve is left alone (unknown identity, not unknown status)", () => {
    const ctx = ctxOf([live, paused]);
    const onLive = findingOn({ type: "campaign", id: "1", name: "campaign 1" });
    const onSlice = findingOn({ type: "device", id: "MOBILE", name: "MOBILE" });
    const r = applyActivityGate(ctx, fires([onLive, onSlice]));
    if (r.state !== "fires") throw new Error("expected fires");
    expect(r.findings).toEqual([onLive, onSlice]);
  });

  it("still holds back findings when every campaign is dormant, a removed spender included", () => {
    const removed = node("4", "REMOVED", 900);
    const ctx = ctxOf([dormant, removed]);
    const r = applyActivityGate(
      ctx,
      fires([
        findingOn({ type: "campaign", id: "3", name: "campaign 3" }),
        findingOn({ type: "campaign", id: "4", name: "campaign 4" }),
      ]),
    );
    expect(r).toMatchObject({ state: "fires", findings: [] });
  });

  it("never touches a non-firing result", () => {
    const ctx = ctxOf([dormant, live]);
    const nf: CheckResult = { state: "none_found", population: 2 };
    expect(applyActivityGate(ctx, nf)).toBe(nf);
  });
});
