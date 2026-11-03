// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The daily metrics reader (snapshot only) and runReader's all-rows mode. Fake ids only.

import { describe, expect, it } from "vitest";
import { filterInput } from "./common.js";
import { runReader } from "./reader.js";
import { CAMPAIGN_DAILY_CAP, dailyMetricsReader } from "./readers/dailyMetrics.js";
import { campaignsReader } from "./readers/campaigns.js";
import { POINTS_KEPT, simulationsReader } from "./readers/simulations.js";
import { SCHEDULE_GRID_CAP, slicePerformanceReader } from "./readers/slicePerformance.js";
import { fakeContext, fakeSearch, googleError } from "./testing/fakes.js";
import type { Row } from "./normalise.js";

const range = filterInput({ date_range: "2026-09-01..2026-09-03" });

const day = (d: string, extra: Row = {}): Row => ({
  segments: { date: d },
  metrics: { costMicros: "2500000", clicks: "4", impressions: "40", conversions: 1.5 },
  ...extra,
});

describe("daily metrics reader", () => {
  it("reads account days, campaign days and campaign devices as typed rows", async () => {
    const { search, queries } = fakeSearch({
      customer: [day("2026-09-01"), day("2026-09-02"), { segments: { date: "not a day" } }],
      campaign: (q) =>
        q.includes("segments.device")
          ? [
              { campaign: { id: "11" }, segments: { device: "MOBILE" }, metrics: {} },
              { campaign: { id: "11" }, segments: { device: "bad device" }, metrics: {} },
            ]
          : [day("2026-09-01", { campaign: { id: "11" } }), day("2026-09-01", { campaign: {} })],
    });
    const r = await runReader(dailyMetricsReader, fakeContext(search), range, { all: true });
    expect(r.status).toBe("ok");
    expect(r.summary).toEqual({ accountDays: 2, campaignDays: 1, deviceRows: 1 });
    expect(r.rows.map((x) => [x.kind, x.campaignId, x.date, x.device])).toEqual([
      ["account_day", null, "2026-09-01", null],
      ["account_day", null, "2026-09-02", null],
      ["campaign_day", "11", "2026-09-01", null],
      ["campaign_device", "11", null, "MOBILE"],
    ]);
    expect(r.rows[0]?.metrics).toMatchObject({ cost: "2.5", clicks: 4, conversions: 1.5 });
    expect(queries.join("\n")).toContain("segments.date BETWEEN '2026-09-01' AND '2026-09-03'");
    // the campaign series has its own, larger cap
    expect(queries.some((q) => q.includes(`LIMIT ${CAMPAIGN_DAILY_CAP + 1}`))).toBe(true);
  });

  it("a failed part gives null for what it reads, never a zero", async () => {
    const { search } = fakeSearch({ customer: googleError(500), campaign: [] });
    const r = await runReader(dailyMetricsReader, fakeContext(search), range, { all: true });
    expect(r.status).toBe("failed");
    expect(r.summary).toEqual({ accountDays: null, campaignDays: 0, deviceRows: 0 });
  });
});

describe("runReader all-rows mode", () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({
    campaign: { id: String(i + 1), name: "x".repeat(200) },
    metrics: { costMicros: String((i + 1) * 1_000_000) },
  }));

  it("returns every row with no cursor, past the page size and the byte budget", async () => {
    const { search } = fakeSearch({ campaign: rows });
    const r = await runReader(campaignsReader, fakeContext(search), range, {
      all: true,
      cursor: "ignored",
      pageSize: 5,
      maxBytes: 1_000,
    });
    expect(r.rows).toHaveLength(450);
    expect(r.nextCursor).toBeNull();
    expect(r.notes).toEqual([]);
  });

  it("pages as before without it", async () => {
    const { search } = fakeSearch({ campaign: rows });
    const r = await runReader(campaignsReader, fakeContext(search), range, { pageSize: 5 });
    expect(r.rows).toHaveLength(5);
    expect(r.nextCursor).not.toBeNull();
  });
});

describe("campaigns reader: the recent range (snapshot only)", () => {
  const recentRange = { preset: null, startDate: "2026-10-11", endDate: "2026-10-31" };
  const recentRow = {
    campaign: { id: "11" },
    metrics: {
      costMicros: 1_100_000_000,
      conversionsValue: 3500,
      searchBudgetLostImpressionShare: 0,
    },
  };

  it("reads each campaign's spend, sales and share lost to budget over the recent range", async () => {
    const { search, queries } = fakeSearch({
      campaign: (q) => (q.includes("'2026-10-11'") ? [recentRow] : []),
    });
    const r = await runReader(
      campaignsReader,
      fakeContext(search),
      { ...range, recentRange },
      {
        all: true,
      },
    );
    expect(r.extra).toEqual({
      recent: {
        startDate: "2026-10-11",
        endDate: "2026-10-31",
        campaigns: [
          {
            campaignId: "11",
            cost: "1100",
            conversionsValue: "3500",
            searchBudgetLostImpressionShare: 0,
          },
        ],
      },
    });
    expect(queries.join("\n")).toContain("segments.date BETWEEN '2026-10-11' AND '2026-10-31'");
  });

  it("a failed recent read is null (not read), never 'nothing lost'", async () => {
    const { search } = fakeSearch({
      campaign: (q) => (q.includes("'2026-10-11'") ? googleError(500) : []),
    });
    const r = await runReader(
      campaignsReader,
      fakeContext(search),
      { ...range, recentRange },
      {
        all: true,
      },
    );
    expect(r.extra?.recent.campaigns).toBeNull();
  });

  it("the tool (no recent range) reads no extra part and returns no extra", async () => {
    const { search, queries } = fakeSearch({ campaign: [] });
    const r = await runReader(campaignsReader, fakeContext(search), range, { all: true });
    expect(r.extra).toBeNull();
    expect(queries).toHaveLength(2);
  });
});

describe("daily metrics on a manager account", () => {
  it("skips the account series (a manager has no metrics of its own), never fails it", async () => {
    const { search, queries } = fakeSearch({ campaign: [] });
    const r = await runReader(dailyMetricsReader, fakeContext(search, { isManager: true }), range, {
      all: true,
    });
    expect(r.parts.find((p) => p.part === "account_daily")?.status).toBe("skipped");
    expect(r.status).toBe("ok");
    expect(queries.some((q) => q.includes("FROM customer"))).toBe(false);
    // removed campaigns' spend still counts: no status filter on the campaign series
    expect(queries.every((q) => !q.includes("REMOVED"))).toBe(true);
  });
});

describe("slice performance reader", () => {
  it("reads targeted locations and the day x hour grid per campaign", async () => {
    const { search, queries } = fakeSearch({
      location_view: [
        {
          campaign: { id: "11" },
          campaignCriterion: {
            criterionId: "1023191",
            location: { geoTargetConstant: "geoTargetConstants/1023191" },
          },
          metrics: { clicks: "5" },
        },
      ],
      campaign: [
        { campaign: { id: "11" }, segments: { dayOfWeek: "MONDAY", hour: 9 }, metrics: {} },
        { campaign: { id: "11" }, segments: { dayOfWeek: "MONDAY", hour: 31 }, metrics: {} },
      ],
    });
    const r = await runReader(slicePerformanceReader, fakeContext(search), range, { all: true });
    expect(r.summary).toEqual({ locations: 1, scheduleCells: 1, networkRows: 0 });
    expect(r.rows.map((x) => [x.kind, x.geoTargetConstantId, x.dayOfWeek, x.hour])).toEqual([
      ["location", "1023191", null, null],
      ["schedule_cell", null, "MONDAY", 9],
    ]);
    expect(queries.some((q) => q.includes(`LIMIT ${SCHEDULE_GRID_CAP + 1}`))).toBe(true);
    expect(r.parts.find((p) => p.part === "schedule_grid")?.limit).toBe(SCHEDULE_GRID_CAP);
  });

  it("R9: reads the Search and Shopping campaigns' spend per ad network", async () => {
    const { search, queries } = fakeSearch({
      location_view: [],
      campaign: [
        {
          campaign: { id: "1234567890" },
          segments: { adNetworkType: "SEARCH" },
          metrics: { clicks: "1575" },
        },
      ],
    });
    const r = await runReader(slicePerformanceReader, fakeContext(search), range, { all: true });
    expect(r.summary.networkRows).toBe(1);
    expect(r.rows.find((x) => x.kind === "network")).toMatchObject({
      campaignId: "1234567890",
      adNetworkType: "SEARCH",
    });
    const q = queries.find((x) => x.includes("segments.ad_network_type")) ?? "";
    expect(q).toContain("campaign.advertising_channel_type IN ('SEARCH', 'SHOPPING')");
  });

  it("a failed location read gives null locations, never zero", async () => {
    const { search } = fakeSearch({ location_view: googleError(500), campaign: [] });
    const r = await runReader(slicePerformanceReader, fakeContext(search), range, { all: true });
    expect(r.summary.locations).toBeNull();
  });
});

describe("simulations reader", () => {
  const point = { targetRoas: 2.5, costMicros: "1000000", biddableConversions: 3, clicks: "40" };
  it("reads campaign and strategy target simulations, UNIFORM/DEFAULT only", async () => {
    const { search, queries } = fakeSearch({
      campaign_simulation: (q) =>
        q.includes("'TARGET_ROAS'")
          ? [
              {
                campaignSimulation: {
                  campaignId: "11",
                  type: "TARGET_ROAS",
                  modificationMethod: "UNIFORM",
                  targetRoasPointList: { points: [point, point] },
                },
              },
            ]
          : [],
      bidding_strategy_simulation: (q) =>
        q.includes("'TARGET_CPA'")
          ? [
              {
                biddingStrategySimulation: {
                  biddingStrategyId: "77",
                  type: "TARGET_CPA",
                  modificationMethod: "UNIFORM",
                  targetCpaPointList: {
                    points: [{ targetCpaMicros: "12500000", interactions: "30" }],
                  },
                },
              },
            ]
          : [],
    });
    const r = await runReader(simulationsReader, fakeContext(search), null, { all: true });
    expect(r.summary).toEqual({ campaignSimulations: 1, strategySimulations: 1 });
    const camp = r.rows.find((x) => x.level === "campaign");
    const strat = r.rows.find((x) => x.level === "bidding_strategy");
    expect(camp?.points[0]).toMatchObject({ targetRoas: 2.5, cost: "1", clicks: 40 });
    expect(strat).toMatchObject({ ownerId: "77", type: "TARGET_CPA" });
    expect(strat?.points[0]).toMatchObject({
      targetCpa: "12.5",
      clicks: null,
      interactions: 30,
      biddableConversions: null,
      cost: null,
    });
    expect(queries).toHaveLength(4);
    for (const q of queries) expect(q).toContain("modification_method IN ('UNIFORM', 'DEFAULT')");
  });

  it("keeps at most POINTS_KEPT points; a failed part = unknown, not none", async () => {
    const many = Array.from({ length: POINTS_KEPT + 5 }, () => point);
    const { search } = fakeSearch({
      campaign_simulation: (q) =>
        q.includes("'TARGET_ROAS'")
          ? [
              {
                campaignSimulation: {
                  campaignId: "11",
                  type: "TARGET_ROAS",
                  targetRoasPointList: { points: many },
                },
              },
            ]
          : [],
      bidding_strategy_simulation: googleError(500),
    });
    const r = await runReader(simulationsReader, fakeContext(search), null, { all: true });
    expect(r.rows.find((x) => x.type === "TARGET_ROAS")?.points).toHaveLength(POINTS_KEPT);
    // a Demand Gen-style point: interactions, no clicks -> clicks unknown, not 0
    expect(r.rows.find((x) => x.type === "TARGET_ROAS")?.points[0]).toMatchObject({
      clicks: 40,
      impressions: null,
      biddableConversionsValue: null,
    });
    expect(r.summary.strategySimulations).toBeNull();
  });
});
