// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// (product waste): a capped product read that does not lose rows to the per-query
// limit. Port of the PerfoAds app's splitProductRead. A read that
// fills its limit is thrown away and read again as two halves of its days, down to one day;
// a full single day with 2+ campaigns is read again one campaign at a time. Every kept read
// covers its own days (and campaign), so summing the rows per (campaign, item) never counts
// a day twice. A query budget stops the splitting; a read kept at its limit is "truncated"
// with the reason and the cutoff (the cost of its last kept row: rows come biggest first).

/** Most queries one split read may run (chunks, halves, campaign lists, per-campaign reads). */
export const SPLIT_READ_BUDGET = 40;

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** Days from start to end, both included. */
const daysIn = (start: string, end: string): number =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;

/** One read: the rows kept (at most the limit) and whether Google had more. */
export interface SplitReadPage<R> {
  rows: R[];
  full: boolean;
  /** the read stopped early because time ran short */
  stoppedEarly?: boolean;
}

export interface SplitReadResult<R> {
  /** rows of disjoint (date chunk, campaign) reads */
  rows: R[];
  /** a kept read was at its limit (one day of one campaign, a refused campaign split, the budget or the time ran out) */
  truncated: boolean;
  /** why it is truncated (null when complete); plain words, days and counts only */
  truncatedReason: string | null;
  /** SUM of the capped reads' cutoffs: the most spend one product can have outside the kept rows; null when nothing was capped */
  cutoffCost: number | null;
  /** queries run */
  reads: number;
  /** a read stopped early because time ran short */
  timeCut: boolean;
}

/**
 * Reads `startDate..endDate` in chunks of `chunkDays` (default: the whole window in one read;
 * it is split only when it fills its limit). `read(start, end, campaignId)`: campaignId null =
 * every campaign; null back = the account refuses the campaign filter. `campaignsOn(day)` = the
 * campaigns with rows that day. `hasTime()` false = no more splitting (the read is kept at its
 * limit, truncated). Sequential, one query at a time. Pure apart from the callbacks.
 */
export async function splitRead<R>(opts: {
  startDate: string;
  endDate: string;
  limit: number;
  read: (start: string, end: string, campaignId: string | null) => Promise<SplitReadPage<R> | null>;
  campaignsOn: (day: string) => Promise<string[]>;
  costOf: (row: R) => number;
  chunkDays?: number;
  budget?: number;
  hasTime?: () => boolean;
}): Promise<SplitReadResult<R>> {
  const out: SplitReadResult<R> = {
    rows: [],
    truncated: false,
    truncatedReason: null,
    cutoffCost: null,
    reads: 0,
    timeCut: false,
  };
  const total = daysIn(opts.startDate, opts.endDate);
  if (!(total >= 1)) return out;
  const chunk = Math.max(1, Math.floor(opts.chunkDays ?? total));
  const budget = Math.max(1, Math.floor(opts.budget ?? SPLIT_READ_BUDGET));
  const hasTime = opts.hasTime ?? (() => true);
  /** reads still owed: unread top-level chunks + second halves waiting for their read */
  let pending = Math.ceil(total / chunk);
  const push = (rows: R[]) => {
    for (const r of rows) out.rows.push(r);
  };
  /** room for `n` more queries while every owed read still gets its one query */
  const room = (n: number) => hasTime() && out.reads + n + pending <= budget;
  const spent = (what: string) =>
    hasTime() ? `reads budget of ${budget} queries spent: ${what}` : `time ran short: ${what}`;
  const keepCapped = (rows: R[], reason: string) => {
    push(rows);
    out.truncated = true;
    out.truncatedReason ??= reason;
    const last = rows[rows.length - 1];
    if (last !== undefined)
      out.cutoffCost = (out.cutoffCost ?? 0) + (Number(opts.costOf(last)) || 0);
  };
  const readOnce = async (start: string, end: string, campaignId: string | null) => {
    const page = await opts.read(start, end, campaignId);
    out.reads++;
    if (page?.stoppedEarly) out.timeCut = true;
    return page;
  };

  const readRange = async (start: string, days: number): Promise<void> => {
    const page = (await readOnce(start, addDays(start, days - 1), null)) ?? {
      rows: [],
      full: false,
    };
    if (!page.full) {
      push(page.rows);
      return;
    }
    if (days > 1) {
      if (!room(2)) {
        keepCapped(page.rows, spent(`a ${days}-day read kept its top ${page.rows.length} rows`));
        return;
      }
      const first = Math.ceil(days / 2);
      pending++; // the second half's read is owed while the first half splits
      await readRange(start, first);
      pending--;
      await readRange(addDays(start, first), days - first);
      return;
    }
    // one full day: one campaign at a time
    if (!room(1)) {
      keepCapped(page.rows, spent(`${start} kept its top ${page.rows.length} rows`));
      return;
    }
    const campaigns = [...new Set((await opts.campaignsOn(start)).filter(Boolean))];
    out.reads++;
    if (campaigns.length <= 1) {
      keepCapped(page.rows, `one campaign filled the ${opts.limit}-row read on ${start}`);
      return;
    }
    if (!room(campaigns.length)) {
      keepCapped(page.rows, spent(`${start} kept its top ${page.rows.length} rows`));
      return;
    }
    const perCampaign: SplitReadPage<R>[] = [];
    for (const id of campaigns) {
      const r = await readOnce(start, start, id);
      if (r == null) {
        keepCapped(page.rows, `the account refused the campaign filter on ${start}`);
        return;
      }
      perCampaign.push(r);
    }
    for (const r of perCampaign) {
      if (r.full) keepCapped(r.rows, `one campaign filled the ${opts.limit}-row read on ${start}`);
      else push(r.rows);
    }
  };

  for (let offset = 0; offset < total; offset += chunk) {
    pending--;
    if (offset > 0 && !hasTime()) {
      // days never read: a cut, never "no rows"
      out.timeCut = true;
      break;
    }
    await readRange(addDays(opts.startDate, offset), Math.min(chunk, total - offset));
  }
  return out;
}
