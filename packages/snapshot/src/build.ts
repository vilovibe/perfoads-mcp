// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Builds an AccountSnapshot: runs every reader the shipped checks need (a few at a time,
// inside a time budget) and records how each one went. Never throws for Google errors and
// never claims a read it did not make: a reader that failed, was refused or had no time left
// is in the snapshot with that status and no rows.

import { randomBytes } from "node:crypto";
import { NO_CAMPAIGN_OF_KIND } from "@perfoads/checks";
import {
  accountExclusionsReader,
  adGroupsReader,
  adsAssetsInput,
  adsAssetsReader,
  audiencesInput,
  audiencesReader,
  autoApplyReader,
  dsaSearchTermsReader,
  experimentsReader,
  landingPagesReader,
  negativesReader,
  offlineJobsReader,
  userAccessReader,
  biddingAdjustmentsReader,
  bidModifiersReader,
  budgetsReader,
  campaignsReader,
  changeHistoryInput,
  changeHistoryReader,
  conversionsReader,
  dailyMetricsReader,
  simulationsReader,
  slicePerformanceReader,
  pmaxReader,
  campaignControlsReader,
  segmentPerformanceReader,
  priorYearDailyReader,
  shoppingReader,
  placementsReader,
  geoLanguagesReader,
  videoReader,
  localServicesReader,
  demandGenReader,
  defaultDescribeError,
  filterInput,
  keywordsReader,
  MIN_PART_MS,
  ReadInputError,
  runReader,
  searchTermsReader,
  untrusted,
  untrustedOrNull,
  untrustedText,
  type ReaderContext,
  type ReaderResult,
  type SearchFn,
  type Untrusted,
} from "@perfoads/reads";
import {
  SNAPSHOT_SCHEMA,
  SNAPSHOT_VERSION,
  type AccountSnapshot,
  type SnapshotSection,
} from "./schema.js";

/** The account and the way to read it. The MCP server builds this from its runtime. */
export interface SnapshotSource {
  account: {
    customerId: string;
    name: string;
    currencyCode?: string | null | undefined;
    timeZone?: string | null | undefined;
    isTestAccount: boolean;
    isManager: boolean;
  };
  search: SearchFn;
  /** Plain, redacted text for an error (default: Google's plain message or a generic line). */
  describeError?: (err: unknown) => string;
  onError?: (err: unknown) => void;
  now?: () => number;
}

export interface BuildOptions {
  /** Epoch ms after which no reader part is started (each reader gets it as its deadline). */
  deadlineAt: number;
  /** Epoch ms at which the build returns what it has; readers still running count as skipped. */
  hardStopAt?: number | undefined;
  /** Called at hardStopAt when readers are still running (e.g. abort their requests). */
  onHardStop?: (() => void) | undefined;
  /** Readers run at the same time (default 2). */
  concurrency?: number | undefined;
  /** Days of metrics, ending yesterday in the account's time zone (default 90, max 90). */
  days?: number | undefined;
  /** Days of change history (default 28, the reader's most). */
  changeDays?: number | undefined;
  minPartMs?: number | undefined;
  /** Called after each section is done (for progress notifications). */
  onProgress?: ((done: number, total: number, section: string) => void) | undefined;
  /** Fixed id (tests); default a fresh random id. */
  id?: string | undefined;
  /**
   * Live Performance Max campaigns whose places are read, the highest-cost first (1-30,
   * default 15): one query each. The rest are recorded as not read.
   */
  pmaxPlacementCampaigns?: number | undefined;
  /** Only these sections (default: all). The others are left out of the snapshot (not read). */
  sections?: readonly SnapshotSectionName[] | undefined;
  /** The checks `sections` were chosen for (shown in the scope). */
  checks?: readonly string[] | undefined;
}

export const DEFAULT_SNAPSHOT_DAYS = 90;
export const DEFAULT_CHANGE_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Reader name -> section key, in the order they run (the daily series and campaigns first). */
export const SNAPSHOT_SECTIONS = [
  "daily_metrics",
  "campaigns",
  "ad_groups",
  "keywords",
  "search_terms",
  "budgets_and_bidding",
  "bid_modifiers",
  "bidding_adjustments",
  "change_history",
  "conversions",
  "slice_performance",
  "simulations",
  "negatives",
  "account_exclusions",
  "ads_assets",
  "landing_pages",
  "audiences",
  "auto_apply",
  "user_access",
  "experiments",
  "offline_jobs",
  "dsa_search_terms",
  "pmax",
  "campaign_controls",
  "segment_performance",
  "prior_year_daily",
  "shopping",
  "placements",
  "geo_languages",
  "video",
  "local_services",
  "demand_gen",
] as const;
export type SnapshotSectionName = (typeof SNAPSHOT_SECTIONS)[number];

/**
 * Sections only an account running these campaign types has data for. When the campaigns
 * section was read in full and shows none of them, the section is not read: skipped with
 * NO_CAMPAIGN_OF_KIND, which the checks report as "not present", never clean.
 */
export const SECTION_CAMPAIGN_TYPES: Partial<
  Record<
    SnapshotSectionName,
    {
      types: readonly string[];
      label: string;
      /** a campaign of another type that still has this data */
      alsoWhen?: (campaign: Record<string, unknown>) => boolean;
    }
  >
> = {
  shopping: { types: ["SHOPPING", "PERFORMANCE_MAX"], label: "Shopping or Performance Max" },
  // a Search campaign with the Display Network on (Display expansion) shows on placements too
  placements: {
    types: ["DISPLAY", "VIDEO", "DEMAND_GEN"],
    label: "Display, video, Demand Gen or Search-with-Display",
    alsoWhen: (c) => {
      const net = c.networks;
      return (
        net !== null && typeof net === "object" && (net as Record<string, unknown>).display === true
      );
    },
  },
  video: { types: ["VIDEO"], label: "video" },
  // Performance Max campaigns can have Local Services turned on
  local_services: {
    types: ["LOCAL_SERVICES", "PERFORMANCE_MAX"],
    label: "Local Services or Performance Max",
  },
  demand_gen: { types: ["DEMAND_GEN"], label: "Demand Gen" },
};

/** A campaign row that is ENABLED or has cost in the range. */
const isRunningOrSpent = (c: Record<string, unknown>): boolean => {
  if (c.status === "ENABLED") return true;
  const m = c.metrics;
  const cost = m !== null && typeof m === "object" ? (m as Record<string, unknown>).cost : null;
  return Number(cost ?? 0) > 0;
};

/** A section skipped because the account runs no campaign it describes. */
export const isAbsentSection = (s: SnapshotSection | undefined): boolean =>
  s !== undefined &&
  s.status === "skipped" &&
  (s.error?.untrusted ?? "").includes(NO_CAMPAIGN_OF_KIND);

interface Ranges {
  performance: { start_date: string; end_date: string };
  change_history: { start_date: string; end_date: string };
}

type AnyResult = ReaderResult<unknown, unknown, unknown>;

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => ymd(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);

/** Days of the recent range: the last 3 weeks of the window. */
export const RECENT_DAYS = 21;

/** The last RECENT_DAYS days of a "start..end" window (never before its start). */
const recentRange = (perf: string) => {
  const [start = "", end = ""] = perf.split("..");
  const from = addDays(end, -(RECENT_DAYS - 1));
  return { preset: null, startDate: from < start ? start : from, endDate: end };
};

/** Today's date in the account's time zone, or UTC's when the zone is unknown. */
export const localToday = (now: number, timeZone: string | null | undefined): string => {
  if (timeZone) {
    try {
      const d = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(now));
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    } catch {
      // unknown zone: UTC below
    }
  }
  return ymd(now);
};

export const newSnapshotId = (now: number): string => {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `snap_${stamp}_${randomBytes(6).toString("base64url")}`;
};

/** Every reader the shipped checks need, with its input. Readers return all rows (no paging). */
const READERS: Record<
  SnapshotSectionName,
  (
    ctx: ReaderContext,
    r: {
      perf: string;
      now: number;
      tz: string | null;
      changeDays: number;
      placementCampaigns: number | undefined;
    },
  ) => Promise<AnyResult> | AnyResult
> = {
  daily_metrics: (ctx, r) =>
    runReader(dailyMetricsReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
  // and the share lost to budget over the window's last weeks (BB02 judges a limit on those)
  campaigns: (ctx, r) =>
    runReader(
      campaignsReader,
      ctx,
      { ...filterInput({ date_range: r.perf }), recentRange: recentRange(r.perf) },
      { all: true },
    ),
  ad_groups: (ctx, r) =>
    runReader(adGroupsReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
  keywords: (ctx, r) =>
    runReader(keywordsReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
  search_terms: (ctx, r) =>
    runReader(
      searchTermsReader,
      ctx,
      // the Performance Max search categories too (PX02, PX12): the top 50 categories of each of
      // the 5 highest-cost live PMax campaigns (one query per campaign, as Google requires); the
      // campaigns past that are recorded as not read
      {
        ...filterInput({ date_range: r.perf }),
        includePmaxCategories: true,
        allPmaxCategories: true,
      },
      { all: true },
    ),
  budgets_and_bidding: (ctx) => runReader(budgetsReader, ctx, null, { all: true }),
  bid_modifiers: (ctx) => runReader(bidModifiersReader, ctx, null, { all: true }),
  bidding_adjustments: (ctx) => runReader(biddingAdjustmentsReader, ctx, null, { all: true }),
  change_history: (ctx, r) =>
    runReader(changeHistoryReader, ctx, changeHistoryInput({ days: r.changeDays }, r.now, r.tz), {
      all: true,
    }),
  conversions: (ctx, r) =>
    runReader(
      conversionsReader,
      ctx,
      { dateRange: filterInput({ date_range: r.perf }).dateRange, detail: true },
      { all: true },
    ),
  slice_performance: (ctx, r) =>
    runReader(slicePerformanceReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
  simulations: (ctx) => runReader(simulationsReader, ctx, null, { all: true }),
  negatives: (ctx) => runReader(negativesReader, ctx, null, { all: true }),
  account_exclusions: (ctx) => runReader(accountExclusionsReader, ctx, null, { all: true }),
  ads_assets: (ctx, r) =>
    runReader(adsAssetsReader, ctx, adsAssetsInput(filterInput({ date_range: r.perf }), null), {
      all: true,
    }),
  // and which campaigns fed each page (SK20 holds back pages only paused campaigns fed)
  landing_pages: (ctx, r) =>
    runReader(
      landingPagesReader,
      ctx,
      { ...filterInput({ date_range: r.perf }), campaignSplit: true },
      { all: true },
    ),
  // the lists only: targeting and audience metrics are not read for the checks
  audiences: (ctx, r) =>
    runReader(audiencesReader, ctx, audiencesInput(filterInput({ date_range: r.perf }), "lists"), {
      all: true,
    }),
  auto_apply: (ctx) => runReader(autoApplyReader, ctx, null, { all: true }),
  user_access: (ctx) => runReader(userAccessReader, ctx, null, { all: true }),
  experiments: (ctx) => runReader(experimentsReader, ctx, null, { all: true }),
  offline_jobs: (ctx) => runReader(offlineJobsReader, ctx, null, { all: true }),
  dsa_search_terms: (ctx, r) =>
    runReader(dsaSearchTermsReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
  pmax: (ctx, r) =>
    runReader(
      pmaxReader,
      ctx,
      { ...filterInput({ date_range: r.perf }), placementCampaigns: r.placementCampaigns },
      { all: true },
    ),
  campaign_controls: (ctx) => runReader(campaignControlsReader, ctx, null, { all: true }),
  segment_performance: (ctx, r) =>
    runReader(segmentPerformanceReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
  // the same window a year earlier, 364 days back so the weekdays line up
  prior_year_daily: (ctx, r) =>
    runReader(priorYearDailyReader, ctx, filterInput({ date_range: yearAgo(r.perf) }), {
      all: true,
    }),
  shopping: (ctx, r) =>
    runReader(shoppingReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
  placements: (ctx, r) =>
    runReader(placementsReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
  geo_languages: (ctx, r) =>
    runReader(geoLanguagesReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
  video: (ctx, r) =>
    runReader(videoReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
  local_services: (ctx, r) =>
    runReader(localServicesReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
  demand_gen: (ctx, r) =>
    runReader(demandGenReader, ctx, filterInput({ date_range: r.perf }), { all: true }),
};

/** "start..end" moved back 364 days. */
const yearAgo = (range: string): string =>
  range
    .split("..")
    .map((d) => addDays(d, -364))
    .join("..");

const notRun = (reader: string, why: string, timeCut: boolean): SnapshotSection => ({
  reader,
  status: "skipped",
  row_count: 0,
  cap: null,
  truncated: false,
  error: untrusted(why),
  parts: [
    {
      part: reader,
      status: "skipped",
      rows_read: 0,
      capped: false,
      time_cut: timeCut,
      fallback: false,
      cap: null,
      message: untrusted(why),
    },
  ],
  rows: [],
  extra: null,
});

const failedSection = (reader: string, message: string): SnapshotSection => ({
  ...notRun(reader, message, false),
  status: "failed",
  parts: [
    {
      part: reader,
      status: "failed",
      rows_read: 0,
      capped: false,
      time_cut: false,
      fallback: false,
      cap: null,
      message: untrusted(message),
    },
  ],
});

/** A part skipped because time ran short leaves the section not read, never "ok, a sample". */
const sectionStatus = (r: AnyResult): SnapshotSection["status"] =>
  r.status === "ok" && r.parts.some((p) => p.status === "skipped" && p.timeCut)
    ? "skipped"
    : r.status;

const sectionOf = (reader: string, r: AnyResult): SnapshotSection => ({
  reader,
  status: sectionStatus(r),
  row_count: r.rows.length,
  cap: r.parts.reduce<number | null>(
    (m, p) => (p.limit === null ? m : Math.max(m ?? 0, p.limit)),
    null,
  ),
  truncated: r.parts.some((p) => p.capped || p.timeCut),
  error: untrustedOrNull(r.message),
  parts: r.parts.map((p) => ({
    part: p.part,
    status: p.status,
    rows_read: p.rowsRead,
    capped: p.capped,
    time_cut: p.timeCut,
    fallback: p.fallback,
    cap: p.limit,
    message: untrustedOrNull(p.message),
  })),
  rows: r.rows as Record<string, unknown>[],
  extra:
    r.extra !== null && typeof r.extra === "object" ? (r.extra as Record<string, unknown>) : null,
});

export const TIME_LEFT_MESSAGE =
  "not started: not enough time left in this call. Build the snapshot again; it reads less on a smaller account.";
export const HARD_STOP_MESSAGE =
  "did not finish in time, so nothing of it is used. Build the snapshot again.";

/** Builds one snapshot. Never throws for read problems; they are in the sections. */
export const buildSnapshot = async (
  source: SnapshotSource,
  opts: BuildOptions,
): Promise<AccountSnapshot> => {
  const now = source.now ?? Date.now;
  const started = now();
  const tz = source.account.timeZone ?? null;
  const days = Math.min(DEFAULT_SNAPSHOT_DAYS, Math.max(1, opts.days ?? DEFAULT_SNAPSHOT_DAYS));
  const changeDays = Math.min(
    DEFAULT_CHANGE_DAYS,
    Math.max(1, opts.changeDays ?? DEFAULT_CHANGE_DAYS),
  );
  const today = localToday(started, tz);
  const end = addDays(today, -1);
  const start = addDays(end, -(days - 1));
  const change = changeHistoryInput({ days: changeDays }, started, tz);
  const ranges: Ranges = {
    performance: { start_date: start, end_date: end },
    change_history: { start_date: change.startDate, end_date: change.lastDay },
  };
  const minPartMs = opts.minPartMs ?? MIN_PART_MS;
  const describe = source.describeError ?? defaultDescribeError;
  const ctx: ReaderContext = {
    customerId: source.account.customerId,
    currencyCode: source.account.currencyCode ?? null,
    isManager: source.account.isManager,
    search: source.search,
    describeError: describe,
    ...(source.onError ? { onError: source.onError } : {}),
    deadlineAt: opts.deadlineAt,
    now,
    minPartMs,
  };
  const args = {
    perf: `${start}..${end}`,
    now: started,
    tz,
    changeDays,
    placementCampaigns: opts.pmaxPlacementCampaigns,
  };

  const done = new Map<SnapshotSectionName, SnapshotSection>();
  const wanted = opts.sections ? new Set(opts.sections) : null;
  const selected = SNAPSHOT_SECTIONS.filter((n) => !wanted || wanted.has(n));
  const queue = [...selected];
  let stopped = false;
  // the campaigns section, read once: the sections that need a campaign type wait for it
  let campaigns: Promise<SnapshotSection> | undefined;
  const campaignsSection = (): Promise<SnapshotSection> => (campaigns ??= readSection("campaigns"));
  const runOne = async (name: SnapshotSectionName): Promise<SnapshotSection> => {
    if (name === "campaigns") return campaignsSection();
    const needs = SECTION_CAMPAIGN_TYPES[name];
    if (needs && selected.includes("campaigns")) {
      const c = await campaignsSection();
      // only campaigns that run or spent in the range: a long-paused or deleted one of a
      // type is no reason to read that type's whole section
      const counted = c.rows.filter(isRunningOrSpent);
      const types = new Set(counted.map((r) => String(r.channelType ?? "")));
      const other = needs.alsoWhen ? counted.some(needs.alsoWhen) : false;
      if (c.status === "ok" && !c.truncated && !other && !needs.types.some((t) => types.has(t)))
        return notRun(name, `no ${needs.label} campaigns: ${NO_CAMPAIGN_OF_KIND}`, false);
    }
    return readSection(name);
  };
  const readSection = async (name: SnapshotSectionName): Promise<SnapshotSection> => {
    if (opts.deadlineAt - now() < minPartMs) return notRun(name, TIME_LEFT_MESSAGE, true);
    try {
      return sectionOf(name, await READERS[name](ctx, args));
    } catch (err) {
      source.onError?.(err);
      // input problems are the server's own plain text; anything else is described redacted
      return failedSection(name, err instanceof ReadInputError ? err.message : describe(err));
    }
  };
  const worker = async () => {
    for (;;) {
      const name = queue.shift();
      if (!name || stopped) return;
      const section = await runOne(name);
      // a reader that finishes after the hard stop is not used: the reply was already built
      if (stopped) return;
      done.set(name, section);
      try {
        opts.onProgress?.(done.size, selected.length, name);
      } catch {
        // progress is best effort
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, () => worker());
  let timer: NodeJS.Timeout | undefined;
  const hardStop = new Promise<void>((resolve) => {
    if (opts.hardStopAt === undefined) return;
    timer = setTimeout(
      () => {
        stopped = true;
        opts.onHardStop?.();
        resolve();
      },
      Math.max(0, opts.hardStopAt - now()),
    );
  });
  try {
    await Promise.race([Promise.all(workers).then(() => undefined), hardStop]);
  } finally {
    clearTimeout(timer);
  }

  const sections: Record<string, SnapshotSection> = {};
  for (const name of selected) {
    sections[name] =
      done.get(name) ??
      (queue.includes(name)
        ? notRun(name, TIME_LEFT_MESSAGE, true)
        : notRun(name, HARD_STOP_MESSAGE, true));
  }
  // complete = every section of a full build read in full; a scoped build never is
  const scoped = selected.length < SNAPSHOT_SECTIONS.length;
  const complete =
    !scoped &&
    Object.values(sections).every((s) => (s.status === "ok" && !s.truncated) || isAbsentSection(s));
  const name: Untrusted = untrustedText(source.account.name);
  return {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    id: opts.id ?? newSnapshotId(started),
    built_at: new Date(started).toISOString(),
    elapsed_ms: Math.max(0, Math.round(now() - started)),
    complete,
    scope: scoped
      ? { sections: [...selected], checks: [...(opts.checks ?? [])].map((c) => c.toUpperCase()) }
      : "all",
    account: {
      customer_id: source.account.customerId,
      name,
      currency_code: source.account.currencyCode ?? null,
      time_zone: tz,
      is_test_account: source.account.isTestAccount,
      is_manager: source.account.isManager,
    },
    date_ranges: ranges,
    sections,
  };
};
