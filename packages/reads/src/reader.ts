// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The reader framework. A reader = named GAQL queries ("parts") + a row mapper + a sort +
// a summary builder. runReader reads every part (up to a row cap), maps, builds the summary
// over ALL rows read, sorts, and returns one page (cut by row count AND bytes) with a cursor.
// With a deadline it skips work it has no time for and says so, instead of failing.

import { createHash } from "node:crypto";
import {
  AdsNetworkError,
  AdsNotAllowedError,
  classifyAccessError,
  GoogleAdsApiError,
  redactString,
} from "@perfoads/ads-client";
import { ReadInputError } from "./dateRange.js";
import type { Row } from "./normalise.js";
import { splitRead } from "./splitRead.js";

export type ReaderStatus = "ok" | "failed" | "not_allowed" | "skipped";

/**
 * One GAQL read: returns up to maxRows rows. stoppedEarly = the read ended before Google's last
 * page because time ran short (the caller's shouldStop).
 */
export type SearchFn = (
  query: string,
  maxRows: number,
) => Promise<{ rows: Row[]; stoppedEarly?: boolean }>;

export interface ReaderContext {
  customerId: string;
  currencyCode: string | null;
  isManager: boolean;
  search: SearchFn;
  /** Most rows read from Google per part (default 10,000 = one Google page). */
  readCap?: number;
  /** Plain, redacted text for an error. Default: Google's plain message or a generic line. */
  describeError?: (err: unknown) => string;
  /** Sees every error (the server notes access-level problems). */
  onError?: (err: unknown) => void;
  /** Epoch ms by which the reader must be done. Work that would not fit is skipped, with a note. */
  deadlineAt?: number;
  now?: () => number;
  /** A part is not started with less time than this left (default MIN_PART_MS). */
  minPartMs?: number;
}

export const DEFAULT_READ_CAP = 10_000;
export const DEFAULT_PAGE_ROWS = 25;
export const MAX_PAGE_ROWS = 200;
/** Target size of one reply's structured content (rows + extras + envelope). */
export const DEFAULT_PAGE_BYTES = 40_000;
/** A part (or follow-up query) is not started with less time than this left. */
export const MIN_PART_MS = 15_000;
/** Room kept for the envelope (summary, parts, notes) when cutting a page by bytes. */
const ENVELOPE_BYTES = 6_000;

/**
 * A query to run, or the reason it is not run. `limit` overrides the read cap; with
 * `topOnly` the limit is by design (e.g. "top 5 campaigns"), so it never marks totals partial.
 */
export type Part =
  | {
      gaql: string;
      limit?: number;
      topOnly?: boolean;
      /** Smaller query to try once when Google refuses the first one (HTTP 400). */
      fallback?: string;
      /**
       * Many parts of one kind (e.g. one per campaign): shown as ONE part entry in the output,
       * with counts. `key` is the item id (e.g. the campaign id).
       */
      group?: { name: string; key: string };
      /**
       * With fallback + group: when Google's 400 names one of these fields, every later part of
       * the same group in this call goes straight to the fallback (Google refuses the field).
       */
      stickyFields?: readonly string[];
      /**
       * Only adds detail (e.g. names): when it is not read in full this note is given instead,
       * and the part never changes the reader's status, message or partial totals.
       */
      optional?: string;
      /** Said when the part is asked for (e.g. it covers only some of the items), unless it is optional and not read in full. */
      note?: string;
      /** Plain words for the part in notes (e.g. "keywords in shared negative lists"); else its name. */
      label?: string;
      /**
       * read by date (and, for one full day, by campaign) instead of once, so the rows
       * are not cut at `limit` (splitRead). `gaql` is unused then; `limit` is per query.
       */
      split?: SplitPart;
    }
  | { skipped: string };

/** How a split part builds its queries (no LIMIT: the reader adds it). */
export interface SplitPart {
  startDate: string;
  endDate: string;
  /** one read of start..end; campaignId null = every campaign */
  query: (start: string, end: string, campaignId: string | null) => string;
  /** the campaigns with rows on one day */
  campaignsQuery: (day: string) => string;
  campaignOf: (row: Row) => string | null;
  costOf: (row: Row) => number;
  /** first chunk in days (default: the whole window) */
  chunkDays?: number;
  /** most queries (default SPLIT_READ_BUDGET) */
  budget?: number;
}

/** Internal: what a split part did (not part of the output). */
export interface SplitStatus {
  reads: number;
  truncatedReason: string | null;
  cutoffCost: number | null;
}

export const TIME_SKIP_MESSAGE =
  "not enough time left in this call. Ask again with a filter (e.g. campaign_id) or a shorter date range.";

/** Rows per part; undefined = the part did not run or failed. */
export type PartsData = Readonly<Record<string, Row[] | undefined>>;

export interface PartStatus {
  part: string;
  status: ReaderStatus;
  message: string | null;
  rowsRead: number;
  /** Google had more rows than the cap: everything built on this part is partial. */
  capped: boolean;
  /** Stopped or skipped because time ran short: everything built on this part is partial. */
  timeCut: boolean;
  /** Google refused the full query; the smaller fallback query was read instead. */
  fallback: boolean;
  /** Set on the one entry that stands for a group of parts (see Part.group). */
  group: PartGroupCounts | null;
  /** Most rows this part reads (its own limit, else the read cap); null when it did not run. */
  limit: number | null;
  /** Internal: the group this part belongs to and its key (not part of the output). */
  groupName?: string | undefined;
  groupKey?: string | undefined;
  /** Internal: a split part's reads, why it was cut and its cutoff (not part of the output). */
  split?: SplitStatus | undefined;
}

export interface PartGroupCounts {
  parts: number;
  ok: number;
  failed: number;
  notAllowed: number;
  skipped: number;
  /** Read with the smaller fallback query. */
  fallback: number;
  /** Keys (e.g. campaign ids) not read: failed, not allowed or skipped. First 20. */
  notReadKeys: string[];
  notReadTotal: number;
}

export const GROUP_KEYS_SHOWN = 20;

/** True when the named part was read completely enough to trust facts built on it. */
export const partOk = (parts: readonly PartStatus[], name: string): boolean =>
  parts.some((p) => p.part === name && p.status === "ok" && !p.timeCut && !p.capped);

/**
 * I = checked input, R = row, S = summary, X = extra sections (returned on the first page),
 * F = internal facts for the summary only (never returned).
 */
export interface ReaderDef<I, R, S, X, F = undefined> {
  name: string;
  /** GAQL per part. Every part runs in parallel. */
  queries: (input: I, ctx: ReaderContext) => Record<string, Part>;
  /** Optional second round that needs the first round's rows (e.g. one query per campaign). */
  followUp?: (input: I, ctx: ReaderContext, data: PartsData) => Record<string, Part>;
  /** Run the follow-up queries one after another (for resources Google rate-limits). */
  followUpOneByOne?: boolean;
  /** At most this many follow-up queries at once (default: all at once; followUpOneByOne = 1). */
  followUpConcurrency?: number;
  /**
   * Per follow-up group name: ONE query read instead of the whole group when the group was
   * not asked (e.g. too many items) or a part of it failed (refused, an error, not allowed;
   * never for time). Its rows and status then stand for the group, under its name. The list
   * is tried in order: the next one only when Google refused (HTTP 400) the one before.
   */
  groupFallback?: (
    input: I,
    ctx: ReaderContext,
    data: PartsData,
  ) => Record<string, readonly Part[]>;
  /** Rows of every part -> typed rows + extra sections. Must cope with missing parts. */
  map: (
    data: PartsData,
    input: I,
    ctx: ReaderContext,
    parts: readonly PartStatus[],
  ) => { rows: R[]; extra: X; facts?: F };
  /** Order of the returned rows: most important first (cost, then id). */
  compare: (a: R, b: R) => number;
  /**
   * Built over ALL rows read, before paging. A fact that depends on a part must be null when
   * partOk(parts, name) is false: never state a false fact because a read failed.
   */
  summarise: (
    rows: readonly R[],
    extra: X,
    ctx: ReaderContext,
    input: I,
    parts: readonly PartStatus[],
    facts: F | undefined,
  ) => S;
  /** One plain line for the text reply. */
  summaryLine: (summary: S, ctx: ReaderContext, input: I) => string;
  /** One short line per row for the text reply. */
  rowLine: (row: R, ctx: ReaderContext) => string;
}

export interface ReaderResult<R, S, X> {
  reader: string;
  status: ReaderStatus;
  /** First problem, in plain words. null when status is ok. */
  message: string | null;
  parts: PartStatus[];
  summary: S;
  /** Extra sections: on the first page only (null on later pages). */
  extra: X | null;
  /** True when totals do not cover everything: a part hit the cap, ran out of time or failed. */
  totalsPartial: boolean;
  totalRows: number;
  offset: number;
  rows: R[];
  nextCursor: string | null;
  notes: string[];
  /** The first error, for the caller's own error text. Not part of the output. */
  firstError: unknown;
}

export const defaultDescribeError = (err: unknown): string => {
  if (err instanceof GoogleAdsApiError) return redactString(err.plainMessage, []);
  if (err instanceof AdsNetworkError || err instanceof AdsNotAllowedError) {
    return redactString(err.message, []);
  }
  return "The read failed with an unexpected error.";
};

/** not_allowed = the Cloud project's access level or the user's account access stops it. */
export const statusOfError = (err: unknown): ReaderStatus =>
  classifyAccessError(err) !== null ||
  (err instanceof AdsNotAllowedError && err.reason === "access_level")
    ? "not_allowed"
    : "failed";

// ---- cursor: an offset into the sorted rows of one reader call ----

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Row).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

const inputHash = (customerId: string, reader: string, input: unknown): string =>
  createHash("sha256")
    .update(`${customerId}\n${reader}\n${canonical(input)}`)
    .digest("base64url")
    .slice(0, 16);

export const encodeReaderCursor = (
  customerId: string,
  reader: string,
  input: unknown,
  offset: number,
): string =>
  Buffer.from(
    JSON.stringify({ v: 1, r: reader, o: offset, h: inputHash(customerId, reader, input) }),
  ).toString("base64url");

export const decodeReaderCursor = (
  cursor: string,
  customerId: string,
  reader: string,
  input: unknown,
): number => {
  let c: { v?: unknown; r?: unknown; o?: unknown; h?: unknown };
  try {
    c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as typeof c;
  } catch {
    throw new ReadInputError("The cursor is not valid. Call again without a cursor.");
  }
  if (c.v !== 1 || typeof c.o !== "number" || !Number.isInteger(c.o) || c.o < 0) {
    throw new ReadInputError("The cursor is not valid. Call again without a cursor.");
  }
  if (c.r !== reader || c.h !== inputHash(customerId, reader, input)) {
    throw new ReadInputError(
      "The cursor belongs to another call. Send it with the same customer_id and filters.",
    );
  }
  return c.o;
};

// ---- running ----

const worst = (statuses: readonly ReaderStatus[]): ReaderStatus => {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("not_allowed")) return "not_allowed";
  if (statuses.length > 0 && statuses.every((s) => s === "skipped")) return "skipped";
  return "ok";
};

const remaining = (ctx: ReaderContext): number =>
  ctx.deadlineAt === undefined
    ? Number.POSITIVE_INFINITY
    : ctx.deadlineAt - (ctx.now ?? Date.now)();

const skippedStatus = (part: string, message: string, timeCut: boolean): PartStatus => ({
  part,
  status: "skipped",
  message,
  rowsRead: 0,
  capped: false,
  timeCut,
  fallback: false,
  group: null,
  limit: null,
});

const errorNames = (err: unknown, fields: readonly string[]): boolean => {
  if (!(err instanceof GoogleAdsApiError)) return false;
  const text = `${err.plainMessage} ${JSON.stringify(err.details)}`;
  return fields.some((f) => text.includes(f));
};

const runPart = async (
  name: string,
  part: Part,
  ctx: ReaderContext,
  errors: unknown[],
  sticky: Set<string>,
): Promise<[string, Row[] | undefined, PartStatus]> => {
  const tag = (st: PartStatus): PartStatus =>
    "group" in part && part.group
      ? { ...st, groupName: part.group.name, groupKey: part.group.key }
      : st;
  if ("skipped" in part) return [name, undefined, tag(skippedStatus(name, part.skipped, false))];
  if (remaining(ctx) < (ctx.minPartMs ?? MIN_PART_MS)) {
    return [name, undefined, tag(skippedStatus(name, TIME_SKIP_MESSAGE, true))];
  }
  const limit = part.limit ?? ctx.readCap ?? DEFAULT_READ_CAP;
  // One row over the limit tells whether Google had more.
  const read = (gaql: string) => ctx.search(`${gaql.trim()} LIMIT ${limit + 1}`, limit + 1);
  if (part.split) return runSplitPart(name, part.split, limit, read, ctx, errors, tag);
  let usedFallback = false;
  const groupName = part.group?.name;
  try {
    let res: Awaited<ReturnType<SearchFn>>;
    if (part.fallback && groupName && sticky.has(groupName)) {
      usedFallback = true;
      res = await read(part.fallback);
    } else {
      try {
        res = await read(part.gaql);
      } catch (err) {
        if (!(part.fallback && err instanceof GoogleAdsApiError && err.httpStatus === 400)) {
          throw err;
        }
        ctx.onError?.(err);
        if (groupName && part.stickyFields && errorNames(err, part.stickyFields)) {
          sticky.add(groupName);
        }
        if (remaining(ctx) < (ctx.minPartMs ?? MIN_PART_MS)) throw err;
        usedFallback = true;
        res = await read(part.fallback);
      }
    }
    const capped = res.rows.length > limit && part.topOnly !== true;
    const kept = res.rows.length > limit ? res.rows.slice(0, limit) : res.rows;
    return [
      name,
      kept,
      tag({
        part: name,
        status: "ok",
        message: null,
        rowsRead: kept.length,
        capped,
        timeCut: res.stoppedEarly === true,
        fallback: usedFallback,
        group: null,
        limit,
      }),
    ];
  } catch (err) {
    errors.push(err);
    ctx.onError?.(err);
    return [
      name,
      undefined,
      tag({
        part: name,
        status: statusOfError(err),
        message: (ctx.describeError ?? defaultDescribeError)(err),
        rowsRead: 0,
        capped: false,
        timeCut: false,
        fallback: usedFallback,
        group: null,
        limit,
      }),
    ];
  }
};

/** A split part (Part.split): several reads, one status; capped = a kept read was at its limit. */
const runSplitPart = async (
  name: string,
  spec: SplitPart,
  limit: number,
  read: (gaql: string) => ReturnType<SearchFn>,
  ctx: ReaderContext,
  errors: unknown[],
  tag: (st: PartStatus) => PartStatus,
): Promise<[string, Row[] | undefined, PartStatus]> => {
  const page = async (gaql: string) => {
    const res = await read(gaql);
    return {
      rows: res.rows.length > limit ? res.rows.slice(0, limit) : res.rows,
      full: res.rows.length > limit,
      stoppedEarly: res.stoppedEarly === true,
    };
  };
  try {
    const r = await splitRead<Row>({
      startDate: spec.startDate,
      endDate: spec.endDate,
      limit,
      read: async (start, end, campaignId) => {
        try {
          return await page(spec.query(start, end, campaignId));
        } catch (err) {
          // a refused campaign filter keeps the day's capped read; any other error fails the part
          if (campaignId !== null && err instanceof GoogleAdsApiError && err.httpStatus === 400) {
            ctx.onError?.(err);
            return null;
          }
          throw err;
        }
      },
      // one row per campaign: its own cap, never the product read's limit
      campaignsOn: async (day) =>
        (
          await ctx.search(
            `${spec.campaignsQuery(day).trim()} LIMIT ${DEFAULT_READ_CAP}`,
            DEFAULT_READ_CAP,
          )
        ).rows
          .map(spec.campaignOf)
          .filter((x): x is string => x !== null),
      costOf: spec.costOf,
      ...(spec.chunkDays !== undefined ? { chunkDays: spec.chunkDays } : {}),
      ...(spec.budget !== undefined ? { budget: spec.budget } : {}),
      hasTime: () => remaining(ctx) >= (ctx.minPartMs ?? MIN_PART_MS),
    });
    return [
      name,
      r.rows,
      tag({
        part: name,
        status: "ok",
        message: null,
        rowsRead: r.rows.length,
        capped: r.truncated,
        timeCut: r.timeCut,
        fallback: false,
        group: null,
        limit,
        split: { reads: r.reads, truncatedReason: r.truncatedReason, cutoffCost: r.cutoffCost },
      }),
    ];
  } catch (err) {
    errors.push(err);
    ctx.onError?.(err);
    return [
      name,
      undefined,
      tag({
        part: name,
        status: statusOfError(err),
        message: (ctx.describeError ?? defaultDescribeError)(err),
        rowsRead: 0,
        capped: false,
        timeCut: false,
        fallback: false,
        group: null,
        limit,
      }),
    ];
  }
};

const runParts = async (
  parts: Record<string, Part>,
  ctx: ReaderContext,
  errors: unknown[],
  concurrency = Number.POSITIVE_INFINITY,
): Promise<{ data: Record<string, Row[] | undefined>; status: PartStatus[] }> => {
  const entries = Object.entries(parts);
  const sticky = new Set<string>();
  // at most `concurrency` at once, results in the asked order
  const results: [string, Row[] | undefined, PartStatus][] = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      const [name, part] = entries[i] as [string, Part];
      results[i] = await runPart(name, part, ctx, errors, sticky);
    }
  };
  const width = Math.max(1, Math.min(entries.length, concurrency));
  await Promise.all(Array.from({ length: width }, worker));
  return {
    data: Object.fromEntries(results.map(([n, rows]) => [n, rows])),
    status: results.map(([, , st]) => st),
  };
};

/** Plain counts of a group. Built only from numbers: never carries Google's text. */
const groupCountsText = (g: PartGroupCounts): string =>
  `${g.ok} of ${g.parts} read (${g.fallback} with fewer fields), ${g.failed + g.notAllowed} failed, ${g.skipped} skipped.`;

/** One output entry per group of parts (e.g. 30 per-campaign reads -> "pmax_terms"). */
export const collapseParts = (parts: readonly PartStatus[]): PartStatus[] => {
  const out: PartStatus[] = [];
  const groups = new Map<string, PartStatus[]>();
  for (const p of parts) {
    if (!p.groupName) {
      out.push(p);
      continue;
    }
    const list = groups.get(p.groupName);
    if (list) {
      list.push(p);
      continue;
    }
    groups.set(p.groupName, [p]);
    out.push(p); // placeholder at the group's first position
  }
  return out.map((p) => {
    if (!p.groupName) return p;
    const list = groups.get(p.groupName) ?? [p];
    const notRead = list.filter((x) => x.status !== "ok" || x.timeCut);
    const keys = notRead.map((x) => x.groupKey ?? x.part);
    const counts: PartGroupCounts = {
      parts: list.length,
      ok: list.filter((x) => x.status === "ok").length,
      failed: list.filter((x) => x.status === "failed").length,
      notAllowed: list.filter((x) => x.status === "not_allowed").length,
      skipped: list.filter((x) => x.status === "skipped").length,
      fallback: list.filter((x) => x.fallback && x.status === "ok").length,
      notReadKeys: keys.slice(0, GROUP_KEYS_SHOWN),
      notReadTotal: keys.length,
    };
    const firstProblem = list.find((x) => x.status !== "ok" && x.message)?.message;
    return {
      part: p.groupName,
      status: worst(list.map((x) => x.status)),
      // The message may quote Google (firstProblem): it is only output wrapped, in parts[].message.
      message: groupCountsText(counts) + (firstProblem ? ` First problem: ${firstProblem}` : ""),
      rowsRead: list.reduce((n, x) => n + x.rowsRead, 0),
      capped: list.some((x) => x.capped),
      timeCut: list.some((x) => x.timeCut),
      fallback: list.some((x) => x.fallback),
      group: counts,
      limit: list.reduce<number | null>(
        (m, x) => (x.limit === null ? m : Math.max(m ?? 0, x.limit)),
        null,
      ),
    };
  });
};

export interface PageOptions {
  cursor?: string | undefined;
  pageSize?: number | undefined;
  /** Target bytes of structured content per reply (default 40,000). */
  maxBytes?: number | undefined;
  /**
   * Every row read, in order, with no page or byte cut and no cursor (the account snapshot
   * keeps them all). Ignores cursor, pageSize and maxBytes.
   */
  all?: boolean | undefined;
}

/** How to ask for less, only naming what this read's input can narrow (nothing if it can't). */
const narrowerAsk = (input: unknown): string => {
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const range = i.dateRange != null;
  const filter = "campaignId" in i || "adGroupId" in i;
  return range && filter
    ? " Use a shorter date range or a filter."
    : range
      ? " Use a shorter date range."
      : filter
        ? " Use a filter (e.g. campaign_id)."
        : "";
};

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");

/**
 * Runs a reader. Never throws for Google errors: each part gets a status
 * (ok | failed | not_allowed | skipped) and the reader's status is the worst of them.
 * Throws ReadInputError for a bad cursor.
 */
export const runReader = async <I, R, S, X, F = undefined>(
  def: ReaderDef<I, R, S, X, F>,
  ctx: ReaderContext,
  input: I,
  page: PageOptions = {},
): Promise<ReaderResult<R, S, X>> => {
  const all = page.all === true;
  const offset =
    page.cursor && !all ? decodeReaderCursor(page.cursor, ctx.customerId, def.name, input) : 0;
  const pageSize = all
    ? Number.POSITIVE_INFINITY
    : Math.min(MAX_PAGE_ROWS, Math.max(1, page.pageSize ?? DEFAULT_PAGE_ROWS));
  const errors: unknown[] = [];

  const asked = def.queries(input, ctx);
  const first = await runParts(asked, ctx, errors);
  let data: PartsData = first.data;
  let parts = first.status;
  const askedParts: [string, Part][] = Object.entries(asked);
  // optional part name -> the note said when it is not read in full
  const optional = new Map<string, string>();
  if (def.followUp) {
    const more = def.followUp(input, ctx, data);
    askedParts.push(...Object.entries(more));
    for (const [name, p] of Object.entries(more))
      if ("gaql" in p && p.optional) optional.set(name, p.optional);
    if (Object.keys(more).length > 0) {
      const second = await runParts(
        more,
        ctx,
        errors,
        def.followUpOneByOne === true ? 1 : (def.followUpConcurrency ?? Number.POSITIVE_INFINITY),
      );
      data = { ...data, ...second.data };
      parts = [...parts, ...second.status];
    }
  }
  if (def.groupFallback) {
    for (const [group, chain] of Object.entries(def.groupFallback(input, ctx, data))) {
      const members = parts.filter((p) => p.groupName === group);
      // the group was not asked, or a read of it failed; never for time
      const failed = members.some((p) => p.status === "failed" || p.status === "not_allowed");
      if (chain.length === 0 || (members.length > 0 && !failed)) continue;
      const drop = new Set(members.map((p) => p.part));
      let rows: Row[] | undefined;
      let st: PartStatus | undefined;
      let part = chain[0] as Part;
      for (const p of chain) {
        part = p;
        const seen = errors.length;
        [, rows, st] = await runPart(group, p, ctx, errors, new Set());
        const err = errors.length > seen ? errors[errors.length - 1] : undefined;
        // the next one only when Google refused this one
        if (!(err instanceof GoogleAdsApiError && err.httpStatus === 400)) break;
      }
      if (st === undefined) continue;
      data = {
        ...Object.fromEntries(Object.entries(data).filter(([k]) => !drop.has(k))),
        [group]: rows,
      };
      parts = [...parts.filter((p) => !drop.has(p.part)), st];
      for (let i = askedParts.length - 1; i >= 0; i--)
        if (drop.has(askedParts[i]?.[0] ?? "")) askedParts.splice(i, 1);
      askedParts.push([group, part]);
    }
  }

  const labels = new Map<string, string>();
  for (const [name, p] of Object.entries(asked)) {
    if ("gaql" in p && p.optional) optional.set(name, p.optional);
    if ("gaql" in p && p.label) labels.set(name, p.label);
  }
  /** How a note names a part: its plain words when it has them. */
  const named = (part: string): string => labels.get(part) ?? part;

  const { rows, extra, facts } = def.map(data, input, ctx, parts);
  const summary = def.summarise(rows, extra, ctx, input, parts, facts);
  // Readers saw every part; the output (and the notes) show one entry per group.
  parts = collapseParts(parts);
  const sorted = [...rows].sort(def.compare);
  const pageExtra = offset === 0 ? extra : null;

  const notes: string[] = [];
  // an optional part not read in full says only that: its own note (e.g. "only the
  // first 1,000 are named") would claim names that were never read
  const notRead = new Set(
    parts
      .filter((x) => optional.has(x.part) && (x.status !== "ok" || x.capped || x.timeCut))
      .map((x) => x.part),
  );
  for (const [name, p] of askedParts)
    if ("gaql" in p && p.note && !notRead.has(name)) notes.push(p.note);
  for (const name of notRead) {
    const note = optional.get(name);
    if (note) notes.push(note);
  }
  // optional parts only add detail: they never make the read partial
  const counted = parts.filter((p) => !optional.has(p.part));
  const capped = counted.filter((p) => p.capped);
  const timeCut = counted.filter((p) => p.timeCut);
  const broken = counted.filter((p) => p.status === "failed" || p.status === "not_allowed");
  const single = (p: PartStatus) => p.group === null;
  for (const p of parts.filter((x) => !single(x))) {
    const g = p.group;
    const partial = g !== null && (g.notReadTotal > 0 || p.capped || p.fallback);
    if (partial) {
      notes.push(
        // Counts only: part messages can hold Google's text and stay wrapped in parts[].message.
        `"${named(p.part)}": ${g ? groupCountsText(g) : ""}` +
          (p.capped ? " Some reads hit their row cap (a sample)." : "") +
          (g && g.notReadTotal > 0 ? " What was not read is missing from rows and totals." : "") +
          (g && g.fallback > 0
            ? " Fields left out by the smaller query are unknown, not zero."
            : ""),
      );
    }
  }
  const narrow = narrowerAsk(input);
  for (const p of capped.filter(single)) {
    notes.push(
      `Totals are partial: "${named(p.part)}" stopped at ${p.rowsRead} rows (the cap) and Google has more.${narrow}`,
    );
  }
  for (const p of timeCut.filter((x) => x.status === "ok" && single(x))) {
    notes.push(
      `Totals are partial: "${named(p.part)}" stopped after ${p.rowsRead} rows because time ran short.${narrow}`,
    );
  }
  for (const p of broken.filter(single)) {
    notes.push(`"${named(p.part)}" could not be read, so it is missing from rows and totals.`);
  }
  for (const p of counted.filter((x) => x.fallback && x.status === "ok" && single(x))) {
    notes.push(
      `"${named(p.part)}": Google refused the full query, so it was read with fewer fields; what those fields hold is unknown, not zero.`,
    );
  }
  // One note per reason, so 40 skipped follow-up queries do not make 40 notes.
  const skippedBy = new Map<string, string[]>();
  for (const p of counted.filter((x) => x.status === "skipped" && single(x))) {
    // Skipped messages are the server's own text (Part.skipped or TIME_SKIP_MESSAGE), never Google's.
    const why = p.message ?? "";
    skippedBy.set(why, [...(skippedBy.get(why) ?? []), named(p.part)]);
  }
  for (const [why, names] of skippedBy) {
    notes.push(
      `${names.map((n) => `"${n}"`).join(", ")} ${names.length === 1 ? "was" : "were"} skipped: ${why}`.trim(),
    );
  }
  // Page = up to pageSize rows AND within the byte budget (always at least 1 row).
  const budget = all
    ? Number.POSITIVE_INFINITY
    : (page.maxBytes ?? DEFAULT_PAGE_BYTES) -
      ENVELOPE_BYTES -
      bytes(summary) -
      bytes(parts) -
      bytes(notes) -
      (pageExtra === null ? 0 : bytes(pageExtra));
  const pageRows: R[] = [];
  let used = 0;
  for (const row of sorted.slice(offset, offset + pageSize)) {
    const size = all ? 0 : bytes(row) + 1;
    if (pageRows.length > 0 && used + size > budget) break;
    pageRows.push(row);
    used += size;
  }
  const next = offset + pageRows.length;
  const cutByBytes = pageRows.length < Math.min(pageSize, sorted.length - offset);

  if (cutByBytes) {
    notes.push(
      `This reply stops at ${pageRows.length} rows to stay small; call again with next_cursor for the rest.`,
    );
  }

  const status = worst(counted.map((p) => p.status));
  return {
    reader: def.name,
    status,
    message: broken[0]?.message ?? (status === "skipped" ? (parts[0]?.message ?? null) : null),
    parts,
    summary,
    extra: pageExtra,
    totalsPartial: capped.length > 0 || timeCut.length > 0 || broken.length > 0,
    totalRows: sorted.length,
    offset,
    rows: pageRows,
    nextCursor:
      next < sorted.length ? encodeReaderCursor(ctx.customerId, def.name, input, next) : null,
    notes,
    firstError: errors[0],
  };
};

/** True when nothing could be read at all (every part that ran failed). */
export const readNothing = (r: { parts: readonly PartStatus[] }): boolean =>
  r.parts.some((p) => p.status === "failed" || p.status === "not_allowed") &&
  !r.parts.some((p) => p.status === "ok");
