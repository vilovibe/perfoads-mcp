// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Live, bounded reads for negatives safety: searches and keywords with conversions (or
// all conversions: secondary actions too) in the last 90 days (account time zone),
// account-wide. Read fresh at propose AND again right before sending (the engine re-plans
// every change before its send), so a search that started to convert after the proposal
// still stops it. Strict: a read that fails or hits its row limit refuses the change
// (unknown is never safe). The PMax search terms view is required when the change reaches
// a Performance Max campaign; otherwise a failed read is named in a warning. GAQL has no
// OR, so rows are filtered on all_conversions (Google: it includes every conversion).

import { ChangeError } from "../errors.js";
import { asObject, asString } from "../json.js";
import { localDateTime } from "../time.js";
import type { ReadCtx } from "../types/actionType.js";
import { gaql } from "../types/common.js";
import type { ConvertingText } from "./safety.js";

export const SAFETY_WINDOW_DAYS = 90;
/** Rows per read (one page). More rows than this = refused: the check would be a sample. */
export const SAFETY_MAX_ROWS = 10_000;

export interface ConversionSources {
  convertingTerms: ConvertingText[];
  convertingKeywords: ConvertingText[];
  /** Server sentences about what could not be checked (best-effort parts). */
  notes: string[];
  window: { from: string; to: string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window in the account's time zone: [today - 90 days, today]. */
export const safetyWindow = (ctx: ReadCtx): { from: string; to: string } => {
  const now = (ctx.now ?? Date.now)();
  const tz = ctx.account.timeZone ?? "UTC";
  return {
    from: localDateTime(now - SAFETY_WINDOW_DAYS * DAY_MS, tz).slice(0, 10),
    to: localDateTime(now, tz).slice(0, 10),
  };
};

/** Conversions or all conversions (secondary actions too), whichever is larger. */
const conv = (m: unknown): number => {
  const o = asObject(m);
  const a = Number(o.conversions ?? 0);
  const b = Number(o.allConversions ?? 0);
  return Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
};

const capped = (rows: unknown[], what: string): void => {
  if (rows.length >= SAFETY_MAX_ROWS) {
    throw new ChangeError(
      "not_allowed",
      `More than ${SAFETY_MAX_ROWS.toLocaleString("en-US")} ${what} had conversions in the last ${SAFETY_WINDOW_DAYS} days, so the negatives can't all be checked. Nothing was proposed; add negatives in Google Ads.`,
    );
  }
};

/**
 * `reachesPmax`: the change reaches a Performance Max campaign. Then the PMax search terms
 * must be read: a failed read refuses the change instead of a warning.
 */
export const readConversionSources = async (
  ctx: ReadCtx,
  opts: { reachesPmax: boolean },
): Promise<ConversionSources> => {
  const window = safetyWindow(ctx);
  const during = `segments.date BETWEEN '${window.from}' AND '${window.to}'`;
  const terms = await gaql(
    ctx,
    `SELECT search_term_view.search_term, campaign.id, metrics.conversions, metrics.all_conversions FROM search_term_view WHERE ${during} AND metrics.all_conversions > 0 ORDER BY metrics.all_conversions DESC LIMIT ${SAFETY_MAX_ROWS}`,
    "the searches with conversions",
    SAFETY_MAX_ROWS,
  );
  capped(terms, "searches");
  const keywords = await gaql(
    ctx,
    `SELECT ad_group_criterion.keyword.text, campaign.id, metrics.conversions, metrics.all_conversions FROM keyword_view WHERE ${during} AND metrics.all_conversions > 0 ORDER BY metrics.all_conversions DESC LIMIT ${SAFETY_MAX_ROWS}`,
    "the keywords with conversions",
    SAFETY_MAX_ROWS,
  );
  capped(keywords, "keywords");
  const notes: string[] = [];
  let pmax: Record<string, unknown>[] = [];
  try {
    pmax = await gaql(
      ctx,
      `SELECT campaign_search_term_view.search_term, campaign.id, metrics.conversions, metrics.all_conversions FROM campaign_search_term_view WHERE ${during} AND metrics.all_conversions > 0 ORDER BY metrics.all_conversions DESC LIMIT ${SAFETY_MAX_ROWS}`,
      "the campaign search terms with conversions",
      SAFETY_MAX_ROWS,
    );
    capped(pmax, "campaign search terms");
  } catch (err) {
    if (err instanceof ChangeError && err.code === "not_allowed") throw err;
    if (opts.reachesPmax) {
      throw new ChangeError(
        "read_failed",
        "Couldn't check Performance Max searches, and this change reaches a Performance Max campaign. Nothing was proposed; try again.",
      );
    }
    notes.push(
      "Campaign-level search terms (Performance Max) couldn't be read, so they were not checked.",
    );
  }
  const where = (r: Record<string, unknown>) =>
    `campaign ${asString(asObject(r.campaign).id) ?? "?"}`;
  return {
    convertingTerms: [
      ...terms.map((r) => ({
        text: asString(asObject(r.searchTermView).searchTerm) ?? "",
        conversions: conv(r.metrics),
        where: where(r),
      })),
      ...pmax.map((r) => ({
        text: asString(asObject(r.campaignSearchTermView).searchTerm) ?? "",
        conversions: conv(r.metrics),
        where: where(r),
      })),
    ].filter((t) => t.text),
    convertingKeywords: keywords
      .map((r) => ({
        text: asString(asObject(asObject(r.adGroupCriterion).keyword).text) ?? "",
        conversions: conv(r.metrics),
        where: where(r),
      }))
      .filter((k) => k.text),
    notes,
    window,
  };
};
