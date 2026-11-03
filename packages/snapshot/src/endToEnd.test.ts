// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// End to end: synthetic Google REST rows -> readers -> snapshot -> adapter -> runChecks.
// Every shipped check has an expected outcome; read failures, refusals, cut reads and the
// time budget turn the checks that need the table into not_run, never clean.

import { GoogleAdsApiError } from "@perfoads/ads-client";
import { listChecks, runChecks, type CheckStatus } from "@perfoads/checks";
import type { SearchFn } from "@perfoads/reads";
import { describe, expect, it } from "vitest";
import {
  coversSections,
  NOT_READ_TABLES,
  sectionsForChecks,
  TABLE_SOURCES,
  toEvidenceInput,
} from "./adapter.js";
import {
  buildSnapshot,
  HARD_STOP_MESSAGE,
  isAbsentSection,
  SNAPSHOT_SECTIONS,
  TIME_LEFT_MESSAGE,
} from "./build.js";
import { AccountSnapshotSchema, type AccountSnapshot } from "./schema.js";
import {
  FIXTURE_CUSTOMER,
  FIXTURE_NOW,
  fixtureRows,
  type FixtureOptions,
} from "./testing/fixtures.js";

type Override = (query: string) => ReturnType<SearchFn> | undefined;

const searchWith =
  (
    override: Override = () => undefined,
    fixture: FixtureOptions = {},
    seen: string[] = [],
  ): SearchFn =>
  async (query, maxRows) => {
    seen.push(query);
    const custom = override(query);
    if (custom) return custom;
    const rows = fixtureRows(query, fixture);
    if (rows === null) throw new Error(`no fixture for ${query.slice(0, 80)}`);
    return { rows: rows.slice(0, maxRows) };
  };

const google = (status: number, code: Record<string, string> | null) =>
  new GoogleAdsApiError(
    "Request refused.",
    status,
    code
      ? [
          {
            errorCode: { type: Object.keys(code)[0] ?? "", value: Object.values(code)[0] ?? "" },
            message: "x",
            fieldPath: "",
            operationIndex: null,
          },
        ]
      : [],
    "fake-request",
    status === 403 ? "PERMISSION_DENIED" : "INTERNAL",
    undefined,
  );
const failed = () => Promise.reject(google(500, null));
const notAllowed = () =>
  Promise.reject(google(403, { authorizationError: "USER_PERMISSION_DENIED" }));

const build = (
  override?: Override,
  opts: {
    deadlineAt?: number;
    now?: () => number;
    fixture?: FixtureOptions;
    manager?: boolean;
    seen?: string[];
    onProgress?: (done: number, total: number, section: string) => void;
  } = {},
) =>
  buildSnapshot(
    {
      account: {
        customerId: FIXTURE_CUSTOMER,
        name: "Fake shop",
        currencyCode: "USD",
        timeZone: "UTC",
        isTestAccount: true,
        isManager: opts.manager ?? false,
      },
      search: searchWith(override, opts.fixture, opts.seen),
      now: opts.now ?? (() => FIXTURE_NOW),
    },
    {
      deadlineAt: opts.deadlineAt ?? FIXTURE_NOW + 100_000,
      id: "snap_20260902T120000Z_abcdefgh",
      onProgress: opts.onProgress,
    },
  );

const outcomes = (snap: AccountSnapshot) =>
  Object.fromEntries(
    runChecks(toEvidenceInput(snap)).checks.map((c) => [c.id, c.status] as const),
  ) as Record<string, CheckStatus>;

const reasonOf = (snap: AccountSnapshot, id: string) =>
  runChecks(toEvidenceInput(snap)).checks.find((c) => c.id === id)?.reason ?? "";

/** The fixture's expected outcome for every shipped check. */
const EXPECTED: Record<string, CheckStatus> = {
  // measurement: tracking is healthy except enhanced conversions; MI11 states a positive
  MI01: "clean",
  MI03: "clean",
  MI04: "clean",
  MI05: "clean",
  MI06: "clean",
  MI07: "clean",
  MI08: "suppressed",
  MI09: "clean",
  MI10: "finding",
  MI11: "info",
  MI12: "clean",
  MI14: "clean",
  MI16: "clean",
  MI18: "clean",
  // structure: no brand campaign, no Display-type campaign, one change in the history
  AS01: "not_run",
  AS02: "not_run",
  AS03: "clean",
  AS04: "clean",
  AS06: "clean",
  AS07: "not_run",
  AS08: "clean",
  AS09: "clean",
  AS10: "info",
  AS13: "not_run",
  AS14: "clean",
  AS15: "not_run",
  AS16: "clean",
  AS17: "info",
  BB01: "clean",
  BB02: "finding",
  BB03: "clean",
  BB04: "clean",
  BB05: "clean",
  BB06: "finding",
  BB07: "clean",
  BB08: "clean",
  BB09: "finding",
  BB10: "info",
  BB11: "clean",
  BB14: "clean",
  BB15: "not_run",
  BB16: "finding",
  BB17: "info",
  SK01: "finding",
  SK02: "finding",
  SK03: "finding",
  SK04: "finding",
  SK05: "finding",
  // search: no brand terms given, no DSA traffic, asset impressions and ratings not read
  SK06: "clean",
  SK07: "not_run",
  SK08: "clean",
  SK09: "clean",
  SK10: "not_run",
  SK11: "clean",
  SK12: "clean",
  SK13: "clean",
  SK14: "not_run",
  SK15: "clean",
  SK16: "clean",
  SK17: "not_run",
  SK18: "not_run",
  SK19: "clean",
  SK20: "clean",
  SK21: "info",
  SK22: "clean",
  SK26: "clean",
  SK27: "clean",
  SK28: "not_run",
  SK30: "clean",
  SK32: "finding",
  SK33: "clean",
  SK35: "info",
  // wave 2: no Performance Max campaign here (see the PMax build below); SL02, SL04, SL05,
  // SL09, BB12 and BB13 fire on the search campaigns; TR03, TR08 and PR02 state notes
  PX01: "not_run",
  PX02: "not_run",
  PX03: "not_run",
  PX06: "not_run",
  PX08: "not_run",
  PX09: "not_run",
  PX10: "not_run",
  PX14: "not_run",
  PX17: "not_run",
  PX18: "not_run",
  PX19: "not_run",
  PX20: "not_run",
  PX21: "not_run",
  SL01: "not_run",
  SL02: "finding",
  SL04: "finding",
  SL05: "finding",
  SL06: "clean",
  SL07: "clean",
  TR01: "clean",
  TR01a: "clean",
  TR02: "suppressed",
  TR03: "info",
  TR04: "clean",
  TR05: "not_run",
  TR06: "clean",
  TR07: "not_run",
  TR08: "info",
  TR09: "clean",
  TR10: "clean",
  PR01: "not_run",
  PR02: "info",
  MI13: "clean",
  AS12: "not_run",
  BB12: "finding",
  BB13: "finding",
  SK24: "not_run",
  SK25: "clean",
  SL09: "finding",
  PX13: "not_run",
  SK23: "not_run",
  PX12: "not_run",
  // wave 3: no linked products, no Shopping, Video, Local Services or Demand Gen campaign;
  // Merchant Center's own screens are never read (not run, with that reason)
  PX05: "not_run",
  PX07: "not_run",
  PX11: "not_run",
  PX15: "not_run",
  PX16: "not_run",
  SH01: "not_run",
  SH02: "not_run",
  SH03: "not_run",
  SH04: "not_run",
  SH05: "not_run",
  SH06: "not_run",
  SH08: "not_run",
  SH09: "not_run",
  SH10: "not_run",
  SH11: "not_run",
  SH12: "not_run",
  SH13: "not_run",
  SH14: "not_run",
  SH15: "not_run",
  SH17: "not_run",
  SH18: "not_run",
  SH19: "not_run",
  SH20: "not_run",
  SH21: "not_run",
  SH22: "not_run",
  SH23: "not_run",
  SH24: "not_run",
  // every campaign in one country (nothing to compare), each in one country (SL10 clean)
  SL03: "not_run",
  SL10: "clean",
  SL11: "not_run",
  SL12: "not_run",
  PR03: "not_run",
  PR04: "not_run",
  PR05: "not_run",
  PR06: "not_run",
  PR07: "not_run",
  VD01: "not_run",
  VD02: "not_run",
  VD03: "not_run",
  VD04: "not_run",
  VD05: "not_run",
  VD06: "not_run",
  VD07: "not_run",
  DG01: "not_run",
  DG02: "not_run",
  DG03: "not_run",
  DG04: "not_run",
  DG06: "not_run",
};

/**
 * With the wave-3 campaigns (fixture options `pmax` + `wave3`): a Shopping campaign over six
 * linked products, a Video campaign with a costly place, a Local Services campaign and a
 * Demand Gen campaign. The checks they feed, end to end.
 */
const WAVE3_EXPECTED: Record<string, CheckStatus> = {
  // one product cannot show; one spends with no sale; a gift card spends
  SH01: "finding",
  SH04: "finding",
  SH23: "finding",
  SH20: "finding",
  SH05: "clean",
  SH10: "clean",
  SH11: "clean",
  SH14: "clean",
  SH17: "clean",
  // five products spent: no top 10 to concentrate on
  SH03: "not_run",
  // Merchant Center attributes and screens: not in the Google Ads API
  SH02: "not_run",
  SH06: "not_run",
  SH08: "not_run",
  SH09: "not_run",
  SH13: "not_run",
  SH15: "not_run",
  SH22: "not_run",
  SH24: "not_run",
  SH18: "not_run",
  // the PMax tree splits on product type: which products it holds is not exact
  SH19: "not_run",
  PX11: "not_run",
  // the Shopping campaign (feed label US) and PMax both sell the products
  SH12: "finding",
  SH21: "not_run",
  PX05: "not_run",
  // the Video campaign paid for a junk site
  PX07: "finding",
  PX16: "clean",
  PX15: "not_run",
  // the Shopping campaign also spends in Germany, outside its feed's country, with no sale
  SL03: "finding",
  SL10: "finding",
  SL11: "finding",
  // Demand Gen campaign 18 sets no campaign language: it may set them per ad group (not read)
  SL12: "not_run",
  PR03: "info",
  PR04: "clean",
  PR05: "finding",
  PR06: "clean",
  PR07: "finding",
  VD01: "clean",
  VD02: "clean",
  VD03: "not_run",
  VD04: "clean",
  VD05: "not_run",
  VD06: "not_run",
  VD07: "finding",
  DG01: "clean",
  DG02: "finding",
  DG03: "clean",
  DG04: "finding",
  DG06: "not_run",
};

/** With a Performance Max campaign (fixture option `pmax`): AS07 then sees a campaign that shows in apps. */
const PMAX_EXPECTED: Record<string, CheckStatus> = {
  AS07: "finding",
  PX01: "finding",
  // no brand names given: brand categories cannot be told apart
  PX02: "not_run",
  PX03: "finding",
  PX06: "finding",
  PX08: "info",
  PX09: "finding",
  PX10: "info",
  PX14: "clean",
  PX17: "clean",
  PX18: "clean",
  PX19: "finding",
  PX20: "finding",
  PX21: "clean",
  PX13: "clean",
  PX12: "finding",
};

/**
 * Queries of a build of the Search-only fixture account (82 before sections were skipped by
 * campaign type; +2 for the recent weeks' budget share and the landing pages' campaigns; +1 for spend by network).
 */
const SEARCH_ONLY_QUERIES = 78;

describe("fixture -> readers -> snapshot -> adapter -> checks", () => {
  it("reads every section, and the snapshot fits its schema", async () => {
    const snap = await build();
    expect(AccountSnapshotSchema.parse(snap)).toEqual(snap);
    // a Search account: the five sections of campaign types it does not run are not read
    const absent = ["shopping", "placements", "video", "local_services", "demand_gen"];
    expect(snap.complete).toBe(true);
    expect(
      Object.entries(snap.sections)
        .filter(([, s]) => s.status !== "ok")
        .map(([n]) => n),
    ).toEqual(absent);
    for (const n of absent) {
      expect(isAbsentSection(snap.sections[n])).toBe(true);
      expect(snap.sections[n]?.error?.untrusted).toMatch(/^no .* campaigns: /);
    }
    // a section not read because nothing of its kind runs counts as covered (a kept snapshot
    // can stand in for it)
    expect(coversSections(snap, [...SNAPSHOT_SECTIONS])).toBe(true);
    const all = await build(undefined, { fixture: { pmax: true, wave3: true } });
    expect(Object.values(all.sections).map((s) => s.status)).toEqual(
      Array(Object.keys(all.sections).length).fill("ok"),
    );
    expect(snap.date_ranges.performance).toEqual({
      start_date: "2026-06-04",
      end_date: "2026-09-01",
    });
  });

  it("gives every shipped check its expected outcome", async () => {
    const got = outcomes(await build());
    expect(Object.keys(got).sort()).toEqual(
      listChecks()
        .map((c) => c.id)
        .sort(),
    );
    expect(got).toEqual(EXPECTED);
  });

  it("a Search-only account makes no query for the campaign types it does not run", async () => {
    const seen: string[] = [];
    await build(undefined, { seen });
    expect(seen.length).toBe(SEARCH_ONLY_QUERIES);
    for (const resource of [
      "FROM shopping_product",
      "FROM detail_placement_view",
      "FROM local_services_lead",
      "'DEMAND_GEN'",
    ])
      expect([resource, seen.some((q) => q.includes(resource))]).toEqual([resource, false]);
  });

  it("TR03 puts a budget change and a new ad group on their campaigns; a status re-label is not one (B4)", async () => {
    const r = runChecks(toEvidenceInput(await build(undefined, { fixture: { b4Changes: true } })));
    const tr03 = r.info.filter((c) => c.checkId === "TR03");
    const of = (id: string) => tr03.find((c) => c.scope.id === id)?.facts ?? {};
    expect(tr03.every((c) => c.scope.type === "campaign")).toBe(true);
    expect(of("11")).toMatchObject({ changes: 1, fields_touched: "budget" });
    expect(of("12")).toMatchObject({ changes: 1, fields_touched: "ad group launched" });
    expect(of("13")).toMatchObject({ changes: 1, fields_touched: "target ROAS" });
  });

  it("checks on a section not read for want of its campaign type are not present, never clean", async () => {
    const r = runChecks(toEvidenceInput(await build()));
    const byId = new Map(r.checks.map((c) => [c.id, c] as const));
    for (const id of ["SH01", "SH04", "VD01", "PR04", "DG02", "PX07"])
      expect([id, byId.get(id)?.status, byId.get(id)?.category]).toEqual([
        id,
        "not_run",
        "not_present",
      ]);
  });

  it("a Search campaign with the Display Network on: its placements are read and judged", async () => {
    const seen: string[] = [];
    const snap = await build(undefined, { fixture: { searchDisplay: true }, seen });
    expect(snap.sections.placements?.status).toBe("ok");
    expect(seen.some((q) => q.includes("FROM detail_placement_view"))).toBe(true);
    expect(seen.length).toBe(SEARCH_ONLY_QUERIES + 1);
    const r = runChecks(toEvidenceInput(snap)).checks.find((c) => c.id === "PX07");
    expect(r?.status).toBe("finding");
  });

  it("a long-paused or deleted campaign of a type does not make that type's section read", async () => {
    const video = {
      id: "98",
      name: "Old video",
      status: "PAUSED",
      advertisingChannelType: "VIDEO",
    };
    const dg = {
      id: "99",
      name: "Deleted DG",
      status: "REMOVED",
      advertisingChannelType: "DEMAND_GEN",
    };
    const extra =
      (videoCost: number): Override =>
      (query) => {
        if (!query.includes("campaign.geo_target_type_setting.positive_geo_target_type"))
          return undefined;
        const base = fixtureRows(query, {}) ?? [];
        // the settings read: every non-removed campaign; the metrics read: removed ones too
        const rows = query.includes("metrics.search_rank_lost_impression_share")
          ? [
              ...base,
              {
                campaign: video,
                metrics: { impressions: "5", costMicros: String(videoCost * 1_000_000) },
              },
              { campaign: dg, metrics: { impressions: "3", costMicros: "0" } },
            ]
          : [...base, { campaign: video }];
        return Promise.resolve({ rows });
      };
    const idle = await build(extra(0));
    expect(idle.sections.video?.status).toBe("skipped");
    expect(idle.sections.demand_gen?.status).toBe("skipped");
    // the same paused video campaign with spend in the range: its section is read
    const spent = await build(extra(12));
    expect(spent.sections.video?.status).not.toBe("skipped");
  });

  it("a Performance Max campaign with Local Services on: its leads are read and judged", async () => {
    const seen: string[] = [];
    const snap = await build(undefined, { fixture: { pmax: true, pmaxLocalServices: true }, seen });
    expect(snap.sections.local_services?.extra?.campaignIds).toEqual(["14"]);
    expect(seen.some((q) => q.includes("FROM local_services_lead\n"))).toBe(true);
    const got = outcomes(snap);
    expect([got.PR04, got.PR05]).toEqual(["clean", "finding"]);
    // the same campaign without Local Services: nothing more is read
    const off: string[] = [];
    const plain = await build(undefined, { fixture: { pmax: true }, seen: off });
    expect(off.some((q) => q.includes("FROM local_services_lead"))).toBe(false);
    expect(outcomes(plain).PR04).toBe("not_run");
  });

  it("the per-campaign product rows carry the last 7 days' impressions into the engine table", async () => {
    const snap = await build(undefined, { fixture: { pmax: true } });
    const shopping = snap.sections.shopping;
    if (!shopping) throw new Error("no shopping section");
    const row = (item: string, recentImpressions: number | null) => ({
      kind: "campaign_product",
      campaignId: "14",
      itemId: { untrusted: item },
      channelType: "PERFORMANCE_MAX",
      recentImpressions,
      metrics: { impressions: 400, clicks: 4, cost: "2", conversions: 0, conversionsValue: "0" },
    });
    // round 3: a pair seen in the last 7 days only (no row over the range) has no metrics
    shopping.rows.push(row("sku-1", 96), row("sku-2", null), {
      ...row("sku-3-cp-a", 40),
      metrics: null,
    });
    const rows = (toEvidenceInput(snap).tables?.pmax_campaign_products ?? []) as Array<
      Record<string, unknown>
    >;
    expect(rows.map((r) => [r.offer_id, r.impressions_7d])).toEqual([
      ["sku-1", 96],
      ["sku-2", null],
      ["sku-3-cp-a", 40],
    ]);
    expect(rows[2]).toMatchObject({ cost_micros: null, clicks: null, impressions: null });
  });

  it("a Performance Max campaign gives the PMax checks their outcomes, end to end", async () => {
    const seen: string[] = [];
    const got = outcomes(await build(undefined, { fixture: { pmax: true }, seen }));
    expect(Object.fromEntries(Object.keys(PMAX_EXPECTED).map((id) => [id, got[id]]))).toEqual(
      PMAX_EXPECTED,
    );
    // the rest of the account is judged the same
    for (const [id, status] of Object.entries(EXPECTED))
      if (!(id in PMAX_EXPECTED)) expect([id, got[id]]).toEqual([id, status]);
    // one query per part, plus the PMax categories, places and search terms of its campaign;
    // no placements, video or Demand Gen read (no such campaign): 6 queries fewer; + the last
    // 7 days' impressions per campaign and product (a Shopping / PMax account)
    expect(seen.length).toBe(86);
  });

  it("PMax URL exclusions not read: PX20 not run (never a missing-pages finding), the caps and automation stand", async () => {
    const got = outcomes(
      await build((q) => (q.includes("'WEBPAGE'") ? failed() : undefined), {
        fixture: { pmax: true },
      }),
    );
    expect([got.PX20, got.PX08, got.PX10]).toEqual(["not_run", "info", "info"]);
  });

  it("year-ago series not read: TR04 not run, never clean", async () => {
    const snap = await build((q) =>
      q.includes("FROM customer") && q.includes("'2025-") ? failed() : undefined,
    );
    expect(snap.sections.prior_year_daily?.status).toBe("failed");
    expect(outcomes(snap).TR04).toBe("not_run");
  });

  it("30 PMax campaigns: categories for 5, places for 15, the rest recorded as not read", async () => {
    const seen: string[] = [];
    const snap = await build(undefined, {
      fixture: { pmax: true, extraPmaxCampaigns: 29 },
      seen,
    });
    // 82 + 30 PMax term queries + 5 category queries + 15 place queries (no placements,
    // video or Demand Gen read: no such campaign)
    expect(seen.length).toBe(133);
    const input = toEvidenceInput(snap);
    const status = (t: string) => input.statusRows?.find((r) => r.table_name === t);
    const notRead = (t: string) =>
      String(status(t)?.error_message ?? "")
        .replace("coverage partial: campaigns not read: ", "")
        .split(",");
    expect(notRead("pmax_search_insights")).toHaveLength(25);
    expect(notRead("pmax_placements")).toHaveLength(15);
    const got = outcomes(snap);
    // never clean while campaigns are unread
    expect([got.PX12, got.PX19]).not.toContain("clean");
    // more places on request: 30 place queries
    const more: string[] = [];
    await buildSnapshot(
      {
        account: {
          customerId: FIXTURE_CUSTOMER,
          name: "Fake shop",
          currencyCode: "USD",
          timeZone: "UTC",
          isTestAccount: true,
          isManager: false,
        },
        search: searchWith(undefined, { pmax: true, extraPmaxCampaigns: 29 }, more),
        now: () => FIXTURE_NOW,
      },
      { deadlineAt: FIXTURE_NOW + 100_000, pmaxPlacementCampaigns: 99 },
    );
    expect(more.filter((q) => q.includes("FROM performance_max_placement_view"))).toHaveLength(30);
  });

  it("a campaign's last active day is its last day with spend", async () => {
    const snap = await build();
    const daily = snap.sections.daily_metrics;
    if (!daily) throw new Error("no daily section");
    // campaign 13 spent nothing on its last 10 days
    daily.rows = daily.rows.map((r) => {
      const x = r as { kind?: string; campaignId?: string; date?: string; metrics?: object };
      return x.kind === "campaign_day" && x.campaignId === "13" && (x.date ?? "") > "2026-08-22"
        ? { ...x, metrics: { ...x.metrics, cost: "0" } }
        : r;
    });
    const rows = toEvidenceInput(snap).data.campaigns ?? [];
    expect(rows.find((r) => r.campaign_id === "13")?.last_active_date).toBe("2026-08-22");
    expect(rows.find((r) => r.campaign_id === "11")?.last_active_date).toBe("2026-09-01");
  });

  it("each check, built scoped on its own, gives the outcome the full build gives", async () => {
    const full = outcomes(await build());
    const differ: string[] = [];
    for (const c of listChecks()) {
      const sections = sectionsForChecks([c.id]);
      const snap = await buildSnapshot(
        {
          account: {
            customerId: FIXTURE_CUSTOMER,
            name: "Fake shop",
            currencyCode: "USD",
            timeZone: "UTC",
            isTestAccount: true,
            isManager: false,
          },
          search: searchWith(),
          now: () => FIXTURE_NOW,
        },
        { deadlineAt: FIXTURE_NOW + 100_000, sections, checks: [c.id] },
      );
      expect(snap.complete).toBe(false);
      const got = outcomes(snap)[c.id];
      if (got !== full[c.id]) differ.push(`${c.id}: scoped ${got}, full ${full[c.id]}`);
    }
    expect(differ).toEqual([]);
  });

  it("every table a shipped check depends on has a reader, or is never read by design", () => {
    const unproduced = listChecks().filter((c) =>
      c.dependsOn.some((t) => !(t in TABLE_SOURCES) && !(t in NOT_READ_TABLES)),
    );
    expect(unproduced.map((c) => c.id)).toEqual([]);
    // the by-design list is Merchant Center's own data only, and every one of them is used
    const used = new Set(listChecks().flatMap((c) => c.dependsOn));
    expect(Object.keys(NOT_READ_TABLES).filter((t) => !used.has(t))).toEqual([]);
  });

  it("the wave-3 campaigns give their checks their outcomes, end to end", async () => {
    const seen: string[] = [];
    const got = outcomes(await build(undefined, { fixture: { pmax: true, wave3: true }, seen }));
    expect(Object.fromEntries(Object.keys(WAVE3_EXPECTED).map((id) => [id, got[id]]))).toEqual(
      WAVE3_EXPECTED,
    );
    // + the three Local Services queries an account with a Local Services campaign makes,
    // + one products read per live Shopping / PMax campaign (2 here, not one account read),
    // + the negative (excluded) locations read,
    // + the Demand Gen ad groups' channel controls (B12)
    expect(seen.length).toBe(97);
  });

  it("with the wave-3 campaigns, each check built scoped on its own gives the full build's outcome", async () => {
    const fixture = { pmax: true, wave3: true };
    const full = outcomes(await build(undefined, { fixture }));
    const differ: string[] = [];
    for (const c of listChecks()) {
      const snap = await buildSnapshot(
        {
          account: {
            customerId: FIXTURE_CUSTOMER,
            name: "Fake shop",
            currencyCode: "USD",
            timeZone: "UTC",
            isTestAccount: true,
            isManager: false,
          },
          search: searchWith(undefined, fixture),
          now: () => FIXTURE_NOW,
        },
        { deadlineAt: FIXTURE_NOW + 100_000, sections: sectionsForChecks([c.id]), checks: [c.id] },
      );
      const got = outcomes(snap)[c.id];
      if (got !== full[c.id]) differ.push(`${c.id}: scoped ${got}, full ${full[c.id]}`);
    }
    expect(differ).toEqual([]);
  });

  it("cart metrics refused: the cart data is not read (SH11 not run), the products still are", async () => {
    const snap = await build(
      (q) =>
        q.includes("FROM shopping_product") && q.includes("metrics.orders")
          ? Promise.reject(google(400, null))
          : undefined,
      { fixture: { wave3: true } },
    );
    expect(snap.sections.shopping?.parts.find((p) => p.part === "products")).toMatchObject({
      status: "ok",
      fallback: true,
    });
    const got = outcomes(snap);
    expect([got.SH11, got.SH01]).toEqual(["not_run", "finding"]);
    expect(reasonOf(snap, "SH11")).toMatch(/cart metrics/);
  });

  it("a product list at its row limit is a sample: the catalogue checks never call it complete", async () => {
    const snap = await build(
      (q) =>
        q.includes("FROM shopping_product")
          ? Promise.resolve({
              // more than the reader's limit: Google had more
              rows: Array.from({ length: 10_001 }, (_, i) => ({
                shoppingProduct: {
                  itemId: `p-${i}`,
                  title: `Item ${i}`,
                  status: "ELIGIBLE",
                  feedLabel: "US",
                },
                metrics: { impressions: "0" },
              })),
            })
          : undefined,
      { fixture: { wave3: true } },
    );
    const input = toEvidenceInput(snap);
    expect(input.data.mcSyncStatus).toEqual([
      { resource: "product_feed", status: "truncated", row_count: 10_000 },
    ]);
    expect(input.caps?.shoppingProductsData).toBe(10_000);
    expect(outcomes(snap).SH01).not.toBe("clean");
  });

  it("SL11: a campaign selling every product, with the product list cut, gives no verdict", async () => {
    const capped = (q: string) =>
      q.includes("FROM shopping_product")
        ? Promise.resolve({
            rows: Array.from({ length: 10_001 }, (_, i) => ({
              shoppingProduct: { itemId: `p-${i}`, status: "ELIGIBLE", feedLabel: "US" },
              metrics: { impressions: "0" },
            })),
          })
        : undefined;
    // read in full, the Shopping campaign's German spend is outside the US the shop sells to
    expect(outcomes(await build(undefined, { fixture: { wave3: true, pmax: true } })).SL11).toBe(
      "finding",
    );
    // cut: the PMax campaign (no feed label) sells feeds the list may not have reached
    const snap = await build(capped, { fixture: { wave3: true, pmax: true } });
    expect(outcomes(snap).SL11).toBe("not_run");
    expect(reasonOf(snap, "SL11")).toMatch(/sell every product.*not read in full/);
  });

  it("Merchant Center checks name why they are not run", async () => {
    const snap = await build(undefined, { fixture: { wave3: true } });
    for (const id of ["SH02", "SH08", "SH09", "SH15", "SH22"])
      expect([id, reasonOf(snap, id)]).toEqual([
        id,
        expect.stringMatching(/reads the Google Ads API only and calls no Merchant Center API/),
      ]);
  });

  it("names why the not-run check did not run", async () => {
    // no brand campaign in the fixture
    expect(reasonOf(await build(), "BB15")).toMatch(/brand/);
  });

  it("passes the change history's covered days to the engine", async () => {
    const input = toEvidenceInput(await build());
    expect(input.changeHistoryCoverage).toEqual({ startDate: "2026-08-05", endDate: "2026-09-02" });
  });

  it("BB17 is not run when Google refuses the old/new values (read again without them)", async () => {
    const snap = await build((q) =>
      q.includes("FROM change_event") && q.includes("old_resource")
        ? Promise.reject(google(400, null))
        : undefined,
    );
    expect(snap.sections.change_history?.parts[0]).toMatchObject({ status: "ok", fallback: true });
    expect(outcomes(snap).BB17).toBe("not_run");
    expect(reasonOf(snap, "BB17")).toMatch(/no old\/new values/);
  });

  it("BB10 is not run when the simulations could not be read", async () => {
    const snap = await build((q) =>
      q.includes("FROM campaign_simulation") ? failed() : undefined,
    );
    expect(outcomes(snap).BB10).toBe("not_run");
  });
});

describe("review fixes", () => {
  const adjustment = (scope: string, extra: Record<string, unknown> = {}) => ({
    biddingSeasonalityAdjustment: {
      seasonalityAdjustmentId: "71",
      name: "Sale week",
      scope,
      status: "ENABLED",
      startDateTime: "2026-08-20 00:00:00",
      endDateTime: "2026-08-25 23:59:59",
      conversionRateModifier: 1.3,
      ...extra,
    },
  });

  it("a CUSTOMER-scoped seasonality adjustment in the window applies to every campaign (BB11)", async () => {
    const snap = await build(undefined, { fixture: { adjustments: [adjustment("CUSTOMER")] } });
    expect(outcomes(snap).BB11).toBe("finding");
    expect(toEvidenceInput(snap).data.biddingOverrides?.[0]?.campaigns).toBe("11,12,13");
  });

  it("a CHANNEL-scoped one applies to that channel's campaigns only (BB11)", async () => {
    const search = await build(undefined, {
      fixture: { adjustments: [adjustment("CHANNEL", { advertisingChannelTypes: ["SEARCH"] })] },
    });
    expect(outcomes(search).BB11).toBe("finding");
    const shopping = await build(undefined, {
      fixture: { adjustments: [adjustment("CHANNEL", { advertisingChannelTypes: ["SHOPPING"] })] },
    });
    expect(outcomes(shopping).BB11).toBe("clean");
  });

  it("BB09: a location adjustment is judged on its location performance, never assumed", async () => {
    // the reviewer's probe: device adjustment judged, location adjustment with no performance read
    const unread = await build((q) => (q.includes("FROM location_view") ? failed() : undefined), {
      fixture: { locationModifier: { conv: 60 } },
    });
    // the device adjustment still fires, and says the location one could not be judged
    // (with only a judged-clean device adjustment it is not_run: checks/budgetBidding.test.ts)
    const r = runChecks(toEvidenceInput(unread));
    expect(r.checks.find((c) => c.id === "BB09")?.status).toBe("finding");
    expect(r.findings.find((f) => f.checkId === "BB09")?.limitedBy?.join(" ")).toMatch(
      /location adjustments could not be judged/,
    );
    // read, and in line with the campaign: the device adjustment still fires, nothing hidden
    const read = await build(undefined, { fixture: { locationModifier: { conv: 60 } } });
    expect(outcomes(read).BB09).toBe("finding");
    expect(toEvidenceInput(read).data.geographicData?.[0]).toMatchObject({
      campaign_id: "12",
      location_id: "1023191",
    });
  });

  it("SK05: terms of removed ad groups are not read, so the account is judged clean again", async () => {
    const seen: string[] = [];
    const snap = await build(undefined, {
      fixture: { cleanTerms: true, removedAdGroupTerm: true },
      seen,
    });
    expect(seen.find((q) => q.includes("FROM search_term_view"))).toContain(
      "ad_group.status != 'REMOVED'",
    );
    expect(outcomes(snap).SK05).toBe("clean");
    // the probe without the filter: the orphan term blocks a clean result
    const orphan = await build(
      (q) =>
        q.includes("FROM search_term_view")
          ? Promise.resolve({
              rows:
                fixtureRows(q.replace("ad_group.status != 'REMOVED'", ""), {
                  cleanTerms: true,
                  removedAdGroupTerm: true,
                }) ?? [],
            })
          : undefined,
      { fixture: { cleanTerms: true } },
    );
    expect(outcomes(orphan).SK05).not.toBe("clean");
  });

  it("the portfolio probe: campaign 11 on shared strategy 501 is never called settled or loose", async () => {
    // 501's target moved 3 -> 2 three days before the window end; v26 change_event has no
    // bidding strategy type, so the history cannot show it
    const snap = await build(undefined, { fixture: { portfolio501: true } });
    const r = runChecks(toEvidenceInput(snap));
    // BB17 is a note: it states `info`, never a finding
    const bb17 = r.info.filter((f) => f.checkId === "BB17");
    // 13 (own strategy, target changed) still fires; 11 is named as not judged, not cleared
    expect(bb17.map((f) => f.scope.id)).toEqual(["13"]);
    expect(bb17[0]?.limitedBy?.join(" ")).toMatch(
      /shared \(portfolio\) strategy.*Generic search roas/,
    );
    // BB16: 11 never shows up as a loose target
    expect(r.findings.filter((f) => f.checkId === "BB16").map((f) => f.scope.id)).not.toContain(
      "11",
    );
  });

  it("a manager account: the account series is skipped, not failed", async () => {
    const snap = await build(undefined, { manager: true });
    expect(snap.sections.daily_metrics?.parts.find((p) => p.part === "account_daily")?.status).toBe(
      "skipped",
    );
    expect(snap.sections.daily_metrics?.status).toBe("ok");
  });

  it("days with no activity are zero days of the account series, not missing days", async () => {
    const snap = await build(undefined, { fixture: { missingAccountDays: [0, 40] } });
    const daily = toEvidenceInput(snap).data.dailyMetrics ?? [];
    expect(daily).toHaveLength(90);
    expect(daily.at(-1)).toMatchObject({ metric_date: "2026-09-01", cost: 0, clicks: 0 });
  });

  it("caps are each part's own limit: daily 50,000, change history 9,999", async () => {
    const caps = toEvidenceInput(await build()).caps ?? {};
    expect(caps).toMatchObject({
      campaignDailyMetrics: 50_000,
      dailyMetrics: 10_000,
      changeHistory: 9_999,
      temporal_grid: 50_000,
    });
  });

  it("a section with a part skipped for lack of time is not read, not 'ok (a sample)'", async () => {
    let clock = FIXTURE_NOW;
    const snap = await build(
      (q) => {
        // the first daily part eats the time: the next parts are not started
        if (q.includes("FROM customer")) clock += 95_000;
        return undefined;
      },
      { now: () => clock },
    );
    expect(snap.sections.daily_metrics?.status).toBe("skipped");
    expect(snap.complete).toBe(false);
  });

  it("reports progress after each section", async () => {
    const calls: [number, number][] = [];
    await build(undefined, { onProgress: (d, t) => calls.push([d, t]) });
    expect(calls).toHaveLength(SNAPSHOT_SECTIONS.length);
    expect(calls.at(-1)).toEqual([SNAPSHOT_SECTIONS.length, SNAPSHOT_SECTIONS.length]);
  });
});

describe("read problems turn the checks that need the table into not_run", () => {
  it("bid modifiers failed -> BB09 not run (it fired when they were read)", async () => {
    const snap = await build((q) => (q.includes("FROM campaign_criterion") ? failed() : undefined));
    expect(snap.sections.bid_modifiers?.status).toBe("failed");
    expect(snap.complete).toBe(false);
    const got = outcomes(snap);
    expect(got.BB09).toBe("not_run");
    expect(reasonOf(snap, "BB09")).toMatch(/bid_modifiers/);
    // campaign_criterion also holds the campaign negatives: the checks that read them are not run
    expect([got.SK06, got.SK33]).toEqual(["not_run", "not_run"]);
    // nothing else that reads neither changes (the PMax URL exclusions there are "not read")
    expect({ ...got, BB09: EXPECTED.BB09, SK06: EXPECTED.SK06, SK33: EXPECTED.SK33 }).toEqual(
      EXPECTED,
    );
  });

  it("change history not allowed -> BB16 and BB17 not run", async () => {
    const snap = await build((q) => (q.includes("FROM change_event") ? notAllowed() : undefined));
    // change_status answers instead, but it names no fields: it cannot stand in
    expect(snap.sections.change_history?.parts.map((p) => [p.part, p.status])).toEqual([
      ["change_events", "not_allowed"],
      ["change_events_other", "not_allowed"],
      ["change_status", "ok"],
    ]);
    const got = outcomes(snap);
    expect([got.BB16, got.BB17]).toEqual(["not_run", "not_run"]);
  });

  it("keywords failed -> every keyword check is not run, the rest stand", async () => {
    const snap = await build((q) => (q.includes("FROM keyword_view") ? failed() : undefined));
    const got = outcomes(snap);
    for (const id of ["SK01", "SK02", "SK03", "SK04"])
      expect([id, got[id]]).toEqual([id, "not_run"]);
    expect(got.SK05).toBe("finding");
    expect(got.BB02).toBe("finding");
  });

  it("maps what the wave-1 checks read: network settings, shared list members", async () => {
    const input = toEvidenceInput(await build());
    const c13 = (input.data.campaigns ?? []).find((c) => c.campaign_id === "13");
    expect(c13?.network_settings).toMatchObject({ targetSearchNetwork: true });
    expect(input.data.sharedNegativeListMembers).toEqual([
      expect.objectContaining({ shared_set_id: "81", keyword_text: "free", match_type: "PHRASE" }),
    ]);
  });

  it("the daily series per conversion action failed -> MI01 and MI18 not run, never clean", async () => {
    const snap = await build((q) =>
      q.includes("segments.conversion_action") ? failed() : undefined,
    );
    const got = outcomes(snap);
    expect([got.MI01, got.MI18]).toEqual(["not_run", "not_run"]);
  });

  it("campaigns failed -> no check that hangs off campaigns is clean", async () => {
    const snap = await build((q) =>
      q.includes("metrics.search_impression_share") ? failed() : undefined,
    );
    const got = outcomes(snap);
    const onCampaigns = new Set(
      listChecks()
        .filter((c) => c.dependsOn.includes("campaigns"))
        .map((c) => c.id),
    );
    expect(Object.entries(got).filter(([id, s]) => s === "clean" && onCampaigns.has(id))).toEqual(
      [],
    );
    expect(got.BB02).toBe("not_run");
    // account-level checks (users, auto-apply, conversion actions) do not need the campaigns
    expect(got.AS04).toBe("clean");
  });

  it("ads failed -> the ad checks are not run, the rest unchanged", async () => {
    const snap = await build((q) =>
      q.includes("FROM ad_group_ad\n") || /FROM ad_group_ad\s/.test(q) ? failed() : undefined,
    );
    expect(snap.sections.ads_assets?.status).toBe("failed");
    const got = outcomes(snap);
    for (const id of ["SK11", "SK12", "SK13", "SK15", "SK30"])
      expect([id, got[id]]).toEqual([id, "not_run"]);
    expect(got.SK16).toBe("clean");
    expect(got.MI01).toBe("clean");
  });

  it("tracking settings refused -> MI10 and MI11 not run, MI01 still judged", async () => {
    const snap = await build((q) =>
      q.includes("conversion_tracking_setting") ? notAllowed() : undefined,
    );
    const got = outcomes(snap);
    expect([got.MI10, got.MI11, got.MI01]).toEqual(["not_run", "not_run", "clean"]);
  });

  it("negatives failed -> SK06 and SK33 are not clean", async () => {
    const snap = await build((q) => (q.includes("FROM shared_criterion") ? failed() : undefined));
    const got = outcomes(snap);
    expect([got.SK06, got.SK33]).toEqual(["not_run", "not_run"]);
  });

  it("a read cut short by time is a sample: what was clean is no longer clean", async () => {
    const snap = await build((q) =>
      q.includes("metrics.search_impression_share")
        ? Promise.resolve({ rows: fixtureRows(q) ?? [], stoppedEarly: true })
        : undefined,
    );
    expect(snap.sections.campaigns?.truncated).toBe(true);
    const got = outcomes(snap);
    const onCampaigns = new Set(
      listChecks()
        .filter((c) => c.dependsOn.includes("campaigns"))
        .map((c) => c.id),
    );
    for (const [id, was] of Object.entries(EXPECTED)) {
      if (was === "clean" && onCampaigns.has(id)) expect([id, got[id]]).not.toEqual([id, "clean"]);
    }
  });

  it("an ok read cut before its first row counts as not read", async () => {
    const snap = await build((q) =>
      q.includes("FROM bidding_seasonality_adjustment")
        ? Promise.resolve({ rows: [], stoppedEarly: true })
        : undefined,
    );
    const input = toEvidenceInput(snap);
    expect(input.statusRows?.find((r) => r.table_name === "bidding_overrides")?.status).toBe(
      "skipped",
    );
    expect(outcomes(snap).BB11).toBe("not_run");
  });
});

describe("time budget", () => {
  it("no time left: every section is skipped, every check not run", async () => {
    const snap = await build(undefined, { deadlineAt: FIXTURE_NOW + 1_000 });
    expect(snap.complete).toBe(false);
    for (const s of Object.values(snap.sections)) {
      expect(s.status).toBe("skipped");
      expect(s.error?.untrusted).toBe(TIME_LEFT_MESSAGE);
    }
    expect(new Set(Object.values(outcomes(snap)))).toEqual(new Set(["not_run"]));
  });

  it("a reader that finishes after the hard stop is still not used", async () => {
    const progress: string[] = [];
    let release: () => void = () => undefined;
    const late = new Promise<void>((r) => (release = r));
    const snap = await buildSnapshot(
      {
        account: {
          customerId: FIXTURE_CUSTOMER,
          name: "Fake shop",
          isTestAccount: true,
          isManager: false,
        },
        search: searchWith((q) =>
          q.includes("FROM keyword_view")
            ? late.then(() => ({ rows: fixtureRows(q) ?? [] }))
            : undefined,
        ),
        now: () => FIXTURE_NOW,
      },
      {
        deadlineAt: FIXTURE_NOW + 100_000,
        hardStopAt: FIXTURE_NOW + 50,
        concurrency: 1,
        onProgress: (_d, _t, name) => progress.push(name),
      },
    );
    release();
    await new Promise((r) => setTimeout(r, 20));
    // nothing is reported for it after the stop either
    expect(progress).not.toContain("keywords");
    expect(snap.sections.keywords?.error?.untrusted).toBe(HARD_STOP_MESSAGE);
    expect(snap.sections.keywords?.rows).toEqual([]);
  });

  it("returns at the hard stop with what it has; a reader still running is not used", async () => {
    let clock = FIXTURE_NOW;
    const hang = new Promise<never>(() => undefined);
    const started = Date.now();
    const snap = await buildSnapshot(
      {
        account: {
          customerId: FIXTURE_CUSTOMER,
          name: "Fake shop",
          isTestAccount: true,
          isManager: false,
        },
        search: searchWith((q) => (q.includes("FROM keyword_view") ? hang : undefined)),
        now: () => clock,
      },
      {
        deadlineAt: FIXTURE_NOW + 100_000,
        hardStopAt: FIXTURE_NOW + 50,
        onHardStop: () => {
          clock += 50;
        },
        concurrency: 1,
      },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(snap.sections.keywords?.error?.untrusted).toBe(HARD_STOP_MESSAGE);
    expect(snap.sections.campaigns?.status).toBe("ok");
    // the readers queued after the stuck one never started
    expect(snap.sections.conversions?.error?.untrusted).toBe(TIME_LEFT_MESSAGE);
    expect(outcomes(snap).SK04).toBe("not_run");
  });
});
