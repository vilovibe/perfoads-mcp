// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Report alerts fix plan Phase 11 — three datasets the engine
 * never had, read once per model build:
 *   - each campaign's sales split into new and returning customers
 *     (campaign_customer_split, segments.new_versus_returning_customers) → MI17;
 *   - each campaign's language targeting (campaign_languages) → SL12;
 *   - the languages the shop's Merchant Center feed is written in
 *     (shop_languages) → SL12.
 *   - Phase 11b: account daily totals for the same window one year earlier
 *     (account_daily_prior_year) → TR04.
 * All of them are gated on their sync marker like the other pool-read tables: an
 * absent table, no marker, 'error' or 'skipped' is "not synced" with the reason,
 * never "none".
 */
import { cmpStr } from "../shared/order.js";
import {
  CAMPAIGN_LANGUAGES_TABLE,
  CUSTOMER_SPLIT_TABLE,
  PRIOR_YEAR_DAILY_TABLE,
  SHOP_LANGUAGES_TABLE,
  str,
  type BuildCtx,
} from "./context.js";
import { num } from "./metrics.js";
import { addDays, isoDay } from "./windows.js";
import type { AccountAttrs, AccountModel } from "./nodes/AccountNode.js";
import type { CampaignNode } from "./nodes/CampaignNode.js";

type CustomerSplit = NonNullable<CampaignNode["attrs"]["customerSplit"]>;
type CampaignLanguages = NonNullable<CampaignNode["attrs"]["languages"]>;
type ShopLanguages = NonNullable<AccountAttrs["shopLanguages"]>;
type PriorYearDaily = NonNullable<AccountAttrs["priorYearDaily"]>;

/** Old ISO 639 codes Google's language constants still use → the code a feed uses. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  iw: "he",
  in: "id",
  ji: "yi",
  nb: "no",
  nn: "no",
};

/**
 * The base language of a code, lower-case, region dropped: "zh_CN" → "zh",
 * "en-GB" → "en", "iw" → "he". null for an empty code.
 */
export function languageBase(code: string | null | undefined): string | null {
  const base = String(code ?? "")
    .trim()
    .toLowerCase()
    .split(/[_-]/)[0];
  if (!base) return null;
  return LANGUAGE_ALIASES[base] ?? base;
}

/** every string value under a JSON value, keys named `operator` skipped (CONTAINS / EQUALS are not rule text). */
function stringLeaves(v: unknown, out: string[]): void {
  if (typeof v === "string") {
    out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) stringLeaves(x, out);
    return;
  }
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) if (!/operator/i.test(k)) stringLeaves(x, out);
}

function parsed(raw: unknown): unknown {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Phase 11b (AS09): the definition columns of one audience_lists row.
 * A column that is absent or NULL (older sync, migration not applied, fields
 * dropped by the sync's retry) stays null = not read, never "no rule".
 */
export function audienceListDefinitionOf(r: any): {
  ruleText: string | null;
  actionIds: string[] | null;
  lifeSpanDays: number | null;
  uploadKeyType: string | null;
} {
  const rule = parsed(r.rule_json) as { inclusive?: unknown } | null;
  let ruleText: string | null = null;
  if (rule && typeof rule === "object") {
    const leaves: string[] = [];
    stringLeaves(rule.inclusive ?? [], leaves);
    ruleText = leaves.join(" ").toLowerCase();
  }
  const actions = parsed(r.actions_json);
  let actionIds: string[] | null = null;
  if (Array.isArray(actions)) {
    const refs: string[] = [];
    stringLeaves(actions, refs);
    actionIds = refs
      .map((x) => /conversionActions\/(\d+)/.exec(x)?.[1])
      .filter((x): x is string => !!x);
  }
  return {
    ruleText,
    actionIds,
    lifeSpanDays: num(r.membership_life_span),
    uploadKeyType: str(r.upload_key_type),
  };
}

export interface BuyersAndLanguages {
  customerSplitFor(campaignId: string): CustomerSplit;
  languagesFor(campaignId: string): CampaignLanguages;
  shopLanguages: ShopLanguages;
  priorYearDaily: PriorYearDaily;
}

export function prepareBuyersAndLanguages(ctx: BuildCtx): BuyersAndLanguages {
  // ---- new vs returning customers per campaign
  const split = ctx.gate(CUSTOMER_SPLIT_TABLE, ctx.readDb(CUSTOMER_SPLIT_TABLE));
  const splitByCid = new Map<
    string,
    {
      newConv: number;
      newValue: number;
      returningConv: number;
      returningValue: number;
      unknownConv: number;
      unknownValue: number;
    }
  >();
  for (const r of split.rows ?? []) {
    const id = String(r.campaign_id ?? "");
    if (!id) continue;
    const s = splitByCid.get(id) ?? {
      newConv: 0,
      newValue: 0,
      returningConv: 0,
      returningValue: 0,
      unknownConv: 0,
      unknownValue: 0,
    };
    const conv = num(r.conversions) ?? 0;
    const value = num(r.conversions_value) ?? 0;
    const t = String(r.customer_type ?? "").toUpperCase();
    if (t === "NEW" || t === "NEW_AND_HIGH_LTV") {
      s.newConv += conv;
      s.newValue += value;
    } else if (t === "RETURNING") {
      s.returningConv += conv;
      s.returningValue += value;
    } else {
      s.unknownConv += conv;
      s.unknownValue += value;
    }
    splitByCid.set(id, s);
  }

  // ---- campaign language criteria
  const langs = ctx.gate(CAMPAIGN_LANGUAGES_TABLE, ctx.readDb(CAMPAIGN_LANGUAGES_TABLE));
  const langByCid = new Map<string, { codes: Set<string>; unresolved: number }>();
  for (const r of langs.rows ?? []) {
    if (String(r.status ?? "").toUpperCase() === "REMOVED") continue;
    const id = String(r.campaign_id ?? "");
    if (!id) continue;
    const e = langByCid.get(id) ?? { codes: new Set<string>(), unresolved: 0 };
    const base = languageBase(str(r.language_code));
    if (base) e.codes.add(base);
    else e.unresolved++;
    langByCid.set(id, e);
  }

  // ---- the shop's feed languages
  const shop = ctx.gate(SHOP_LANGUAGES_TABLE, ctx.readDb(SHOP_LANGUAGES_TABLE));
  let shopLanguages: ShopLanguages;
  if (shop.rows == null) {
    shopLanguages = {
      state: "not_synced",
      note: shop.note ?? `${SHOP_LANGUAGES_TABLE} not loaded`,
    };
  } else {
    const counts = new Map<string, number>();
    for (const r of shop.rows) {
      const base = languageBase(str(r.language_code));
      if (base) counts.set(base, (counts.get(base) ?? 0) + (num(r.product_count) ?? 0));
    }
    const marker = ctx.markers.get(SHOP_LANGUAGES_TABLE);
    shopLanguages = {
      state: "synced",
      source: "merchant_center_feed",
      languages: [...counts.entries()]
        .map(([code, products]) => ({ code, products }))
        .sort((a, b) => b.products - a.products || cmpStr(a.code, b.code)),
      partial: marker?.error_message != null && String(marker.error_message) !== "",
    };
  }

  // ---- Phase 11b: the same window a year earlier (account daily totals)
  const py = ctx.gate(PRIOR_YEAR_DAILY_TABLE, ctx.readDb(PRIOR_YEAR_DAILY_TABLE));
  const priorYearDaily: PriorYearDaily =
    py.rows == null
      ? { state: "not_synced", note: py.note ?? `${PRIOR_YEAR_DAILY_TABLE} not loaded` }
      : {
          state: "synced",
          rows: py.rows
            .map((r) => ({
              date: isoDay(r.metric_date),
              cost: num(r.cost) ?? 0,
              conv: num(r.conversions) ?? 0,
              value: num(r.conversion_value) ?? 0,
            }))
            .filter(
              (r): r is { date: string; cost: number; conv: number; value: number } =>
                r.date != null,
            )
            .sort((a, b) => cmpStr(a.date, b.date)),
        };

  return {
    priorYearDaily,
    customerSplitFor(campaignId) {
      if (split.rows == null)
        return { state: "not_synced", note: split.note ?? `${CUSTOMER_SPLIT_TABLE} not loaded` };
      return {
        state: "synced",
        ...(splitByCid.get(campaignId) ?? {
          newConv: 0,
          newValue: 0,
          returningConv: 0,
          returningValue: 0,
          unknownConv: 0,
          unknownValue: 0,
        }),
      };
    },
    languagesFor(campaignId) {
      if (langs.rows == null)
        return {
          state: "not_synced",
          note: langs.note ?? `${CAMPAIGN_LANGUAGES_TABLE} not loaded`,
        };
      const e = langByCid.get(campaignId);
      return {
        state: "synced",
        codes: e ? [...e.codes].sort() : [],
        unresolved: e?.unresolved ?? 0,
      };
    },
    shopLanguages,
  };
}

// ---------------------------------------------------------------------------
// Phase 11b (TR04): seasonality — this window's move against the same weeks a year ago
// ---------------------------------------------------------------------------

/** 52 weeks: the same weekdays a year earlier. */
export const SEASONAL_SHIFT_DAYS = 364;
/** a move smaller than this (percent) is not a move to explain (TR01's ±20% bar). */
export const SEASONAL_MOVE_PCT = 20;
/** last year's move explains this year's when it goes the same way and is at least this share of it. */
export const SEASONAL_SHARE = 0.5;
/** days a shifted window needs from the prior-year rows before it is read (F.days_min_for_window). */
export const SEASONAL_MIN_DAYS = 10;
/** conversions each of the four windows needs (= FLOORS.roasCpaConv; the model does not import the registry). */
export const SEASONAL_MIN_CONV = 10;

export type Seasonality =
  | { state: "not_synced" | "no_history" | "thin"; reason: string }
  | {
      state: "ok";
      metric: "roas" | "conversions";
      thisYear: {
        recent: number;
        prior: number;
        changePct: number;
        recentRange: string;
        priorRange: string;
      };
      lastYear: {
        recent: number;
        prior: number;
        changePct: number;
        recentRange: string;
        priorRange: string;
      };
      /** this year moved at least SEASONAL_MOVE_PCT */
      moved: boolean;
      /** moved, and last year's same weeks moved the same way by at least SEASONAL_SHARE of it */
      explains: boolean;
    };

const pctChange = (now: number, before: number): number | null =>
  before === 0 ? null : ((now - before) / Math.abs(before)) * 100;

/**
 * Pure. Compares the account's recent30 vs prior30 move (the windows TR01a
 * uses) with the same two windows 364 days earlier, from
 * account_daily_prior_year. ROAS when both years carry value, else
 * conversions. `minConv` = the conversion floor for a ROAS side (FLOORS.roasCpaConv).
 */
export function seasonalityOf(model: AccountModel, minConv: number): Seasonality {
  const py = model.attrs.priorYearDaily;
  if (!py)
    return {
      state: "not_synced",
      reason: "the year-ago daily totals were not loaded for this audit (synced before 09-29)",
    };
  if (py.state === "not_synced")
    return {
      state: "not_synced",
      reason: `the year-ago daily totals are not in our data: ${py.note}`,
    };
  if (py.rows.length === 0)
    return {
      state: "no_history",
      reason:
        "Google returned no daily totals for the same weeks a year ago (the account is younger than a year, or it did not run then)",
    };
  const recentSpec = model.window.windows.m30;
  const priorSpec = model.window.windows.mPrior30;
  const now = model.windows.m30;
  const before = model.windows.mPrior30;
  if (
    !recentSpec?.start ||
    !recentSpec.end ||
    !priorSpec?.start ||
    !priorSpec.end ||
    !now ||
    !before
  ) {
    return {
      state: "thin",
      reason: "this audit has no recent30 / prior30 daily windows to compare",
    };
  }
  const shift = (d: string) => addDays(d, -SEASONAL_SHIFT_DAYS);
  const sumOf = (start: string, end: string) => {
    const rows = py.rows.filter((r) => r.date >= start && r.date <= end);
    return {
      days: rows.length,
      cost: rows.reduce((t, r) => t + r.cost, 0),
      conv: rows.reduce((t, r) => t + r.conv, 0),
      value: rows.reduce((t, r) => t + r.value, 0),
    };
  };
  const lyRecentRange = { start: shift(recentSpec.start), end: shift(recentSpec.end) };
  const lyPriorRange = { start: shift(priorSpec.start), end: shift(priorSpec.end) };
  const lyRecent = sumOf(lyRecentRange.start, lyRecentRange.end);
  const lyPrior = sumOf(lyPriorRange.start, lyPriorRange.end);
  if (
    lyRecent.days < SEASONAL_MIN_DAYS ||
    lyPrior.days < SEASONAL_MIN_DAYS ||
    lyRecent.cost <= 0 ||
    lyPrior.cost <= 0
  ) {
    return {
      state: "no_history",
      reason: `a year ago the account ran on ${lyPrior.days} and ${lyRecent.days} days of the two windows (${lyPriorRange.start}..${lyPriorRange.end}, ${lyRecentRange.start}..${lyRecentRange.end}), below the ${SEASONAL_MIN_DAYS}-day floor or with no spend`,
    };
  }
  const useRoas =
    (now.value ?? 0) > 0 && (before.value ?? 0) > 0 && lyRecent.value > 0 && lyPrior.value > 0;
  const sides = [now.conv ?? 0, before.conv ?? 0, lyRecent.conv, lyPrior.conv];
  if (sides.some((c) => c < minConv)) {
    return {
      state: "thin",
      reason: `one of the four windows has fewer than ${minConv} conversions (this year ${before.conv ?? 0} then ${now.conv ?? 0}, a year ago ${lyPrior.conv} then ${lyRecent.conv})`,
    };
  }
  const ty = useRoas
    ? {
        recent: (now.value ?? 0) / (now.cost || NaN),
        prior: (before.value ?? 0) / (before.cost || NaN),
      }
    : { recent: now.conv ?? 0, prior: before.conv ?? 0 };
  const ly = useRoas
    ? { recent: lyRecent.value / lyRecent.cost, prior: lyPrior.value / lyPrior.cost }
    : { recent: lyRecent.conv, prior: lyPrior.conv };
  const tyChange =
    Number.isFinite(ty.recent) && Number.isFinite(ty.prior) ? pctChange(ty.recent, ty.prior) : null;
  const lyChange = pctChange(ly.recent, ly.prior);
  if (tyChange == null || lyChange == null)
    return { state: "thin", reason: "the change is not computable on one side (a zero base)" };
  const moved = Math.abs(tyChange) >= SEASONAL_MOVE_PCT;
  const explains =
    moved &&
    Math.sign(lyChange) === Math.sign(tyChange) &&
    Math.abs(lyChange) >= SEASONAL_SHARE * Math.abs(tyChange);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    state: "ok",
    metric: useRoas ? "roas" : "conversions",
    thisYear: {
      recent: r2(ty.recent),
      prior: r2(ty.prior),
      changePct: r2(tyChange),
      recentRange: `${recentSpec.start}..${recentSpec.end}`,
      priorRange: `${priorSpec.start}..${priorSpec.end}`,
    },
    lastYear: {
      recent: r2(ly.recent),
      prior: r2(ly.prior),
      changePct: r2(lyChange),
      recentRange: `${lyRecentRange.start}..${lyRecentRange.end}`,
      priorRange: `${lyPriorRange.start}..${lyPriorRange.end}`,
    },
    moved,
    explains,
  };
}
