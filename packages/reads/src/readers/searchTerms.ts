// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Ported from PerfoAds buildSearchTermQuery + fetchSearchTerms (search_term_view, rows merged
// per term + campaign + ad group, the highest-spend triggering keyword kept) and
// fetchPmaxSearchTermInsights (campaign_search_term_insight: Performance Max search CATEGORIES,
// opt-in, top 5 PMax campaigns by cost, 50 categories each, queried one after another because
// Google rate-limits that resource).
// Performance Max search TERMS with cost: ported from PerfoAds fetchPmaxSearchTerms
// (campaign_search_term_view, one query per live PMax campaign = ENABLED or spend in the range,
// by cost, 2,000 rows each, one after another; when Google refuses the full field set (400) the
// campaign is read again with cost-only fields and its conversions are UNKNOWN, never zero;
// campaigns that could not be read are listed). search_term_view leaves Performance Max out,
// so the two never count the same click twice. Terms of removed campaigns and removed ad groups
// are left out (like ad_groups and keywords), so spend on removed items is not judged.

import * as z from "zod";
import {
  countBy,
  countOr,
  filterConditions,
  metricLine,
  MetricsSchema,
  plural,
  shown,
  TotalsSchema,
  where,
  type FilterInput,
} from "../common.js";
import { dateCondition, describeDateRange } from "../dateRange.js";
import {
  addMetrics,
  byMoneyDesc,
  count,
  double,
  doubleMoney,
  enumValue,
  get,
  id,
  idFromResourceName,
  idsFromResourceName,
  metrics,
  moneyOrZero,
  sumMoney,
  text,
  textOrNull,
  totals,
  type Row,
} from "../normalise.js";
import { partOk, type Part, type PartStatus, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export interface SearchTermInput extends FilterInput {
  includePmaxCategories: boolean;
  /** Keep every category read (the snapshot), not only the first PMAX_CATEGORIES_SHOWN. */
  allPmaxCategories?: boolean | undefined;
}

/** Top PMax campaigns (by cost) whose search categories are read when asked. */
export const PMAX_CAMPAIGNS_MAX = 5;
/** Most PMax campaigns listed (then their terms are read one by one). */
export const PMAX_CAMPAIGN_LIST_MAX = 200;
/** Rows per PMax campaign (by cost). A campaign that returns more is a sample. */
export const PMAX_TERMS_PER_CAMPAIGN = 2_000;
/** Live PMax campaigns whose terms are read per call (highest cost first). Bounds ops and time. */
export const PMAX_TERM_CAMPAIGNS_MAX = 30;
/** Fields only the full PMax term query reads: a 400 naming one makes the cost-only switch sticky. */
export const PMAX_TERM_FULL_ONLY_FIELDS = [
  "campaign.name",
  "metrics.conversions",
  "metrics.conversions_value",
] as const;
export const PMAX_CATEGORIES_MAX = 50;
/** Most PMax categories returned in one reply (the summary counts all of them). */
export const PMAX_CATEGORIES_SHOWN = 50;
/** Google returns an empty label for the search it does not show by category. */
export const NO_CATEGORY_LABEL = "(no category: Google hides it)";

/** Like MetricsSchema, but conversions can be unknown (null) on Performance Max terms. */
export const TermMetricsSchema = MetricsSchema.extend({
  conversions: z.number().nullable(),
  conversionsValue: z.string().nullable(),
});
export type TermMetrics = z.infer<typeof TermMetricsSchema>;

export const SearchTermRowSchema = z.object({
  searchTerm: UntrustedSchema,
  pmax: z.boolean().describe("true: Performance Max term (campaign level, no ad group/keyword)"),
  status: z.string().nullable().describe("ADDED, EXCLUDED, ADDED_EXCLUDED or NONE"),
  matchType: z.string().nullable(),
  keyword: z
    .object({
      criterionId: z.string().nullable(),
      adGroupId: z
        .string()
        .nullable()
        .describe(
          "the keyword's own ad group: Google reuses one criterion id across ad groups, so the keyword is ad group + criterion id",
        ),
      text: UntrustedSchema.nullable(),
      matchType: z.string().nullable(),
    })
    .nullable(),
  campaignId: z.string().nullable(),
  campaignName: UntrustedSchema,
  adGroupId: z.string().nullable(),
  adGroupName: UntrustedSchema.nullable(),
  metrics: TermMetricsSchema,
});
export type SearchTermRow = z.infer<typeof SearchTermRowSchema>;

export const PmaxCategorySchema = z.object({
  campaignId: z.string(),
  campaignName: UntrustedSchema,
  category: UntrustedSchema,
  impressions: z.number(),
  clicks: z.number(),
  conversions: z.number(),
  conversionsValue: z.string(),
});
export type PmaxCategory = z.infer<typeof PmaxCategorySchema>;

export const SearchTermSummarySchema = z.object({
  searchTerms: z.number(),
  pmaxSearchTerms: z.number().nullable().describe("null when the PMax campaign list wasn't read"),
  pmaxCampaignsNotRead: z
    .array(z.string())
    .describe("PMax campaign ids whose terms are missing (first 20)"),
  pmaxCampaignsNotReadTotal: z.number(),
  pmaxCampaignsOverLimit: z
    .number()
    .describe("Live PMax campaigns past the 30 highest-cost ones: not read in this call"),
  withConversions: z.number(),
  termsWithUnknownConversions: z.number(),
  costWithoutConversions: z
    .string()
    .nullable()
    .describe("Cost of terms with 0 conversions; null when terms couldn't all be read"),
  costWithoutConversionsUnknownBecause: z
    .string()
    .nullable()
    .describe("Why costWithoutConversions is null: the read that was cut or failed"),
  costWithUnknownConversions: z.string(),
  byStatus: z.record(z.string(), z.number()),
  totals: TotalsSchema,
  pmaxCategories: z.number().nullable().describe("null when not asked for or not read in full"),
});
export type SearchTermSummary = z.infer<typeof SearchTermSummarySchema>;

const TERM_METRICS = `
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value`;

export const searchTermsQuery = (input: FilterInput): string => `
    SELECT
      search_term_view.search_term,
      search_term_view.status,
      segments.search_term_match_type,
      segments.keyword.ad_group_criterion,
      segments.keyword.info.text,
      segments.keyword.info.match_type,
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,${TERM_METRICS}
    FROM search_term_view
    ${where([
      ...filterConditions(input, null),
      "metrics.clicks > 0",
      // as ad_groups and keywords: terms of removed campaigns / ad groups are not read, so their
      // spend is not judged (it would point at parents the other readers leave out)
      "campaign.status != 'REMOVED'",
      "ad_group.status != 'REMOVED'",
    ])}
    ORDER BY metrics.cost_micros DESC`;

const PMAX_TERM_FIELDS_FULL = [
  "campaign_search_term_view.search_term",
  "campaign.id",
  "campaign.name",
  "metrics.impressions",
  "metrics.clicks",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.conversions_value",
];
/** Cost-only fallback (PerfoAds PMAX_SEARCH_TERM_FIELDS_MIN): conversions left unknown. */
const PMAX_TERM_FIELDS_MIN = [
  "campaign_search_term_view.search_term",
  "campaign.id",
  "metrics.impressions",
  "metrics.clicks",
  "metrics.cost_micros",
];

/** One PMax campaign's terms, by cost. campaignId is digits (checked). */
export const pmaxTermsQuery = (
  campaignId: string,
  input: FilterInput,
  fields: "full" | "min" = "full",
): string => {
  if (!/^\d{1,20}$/.test(campaignId)) throw new TypeError("campaign id must be digits");
  return `
    SELECT ${(fields === "full" ? PMAX_TERM_FIELDS_FULL : PMAX_TERM_FIELDS_MIN).join(", ")}
    FROM campaign_search_term_view
    ${where([
      `campaign.id = ${campaignId}`,
      "campaign.advertising_channel_type = 'PERFORMANCE_MAX'",
      dateCondition(input.dateRange),
    ])}
    ORDER BY metrics.cost_micros DESC`;
};

export const pmaxCampaignsQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.cost_micros
    FROM campaign
    ${where([
      "campaign.advertising_channel_type = 'PERFORMANCE_MAX'",
      "campaign.status != 'REMOVED'",
      ...filterConditions({ ...input, adGroupId: null }, null),
    ])}
    ORDER BY metrics.cost_micros DESC`;

/** campaignId is digits (checked); INT64 is written unquoted. */
export const pmaxCategoriesQuery = (campaignId: string, input: FilterInput): string => {
  if (!/^\d{1,20}$/.test(campaignId)) throw new TypeError("campaign id must be digits");
  return `
    SELECT
      campaign_search_term_insight.category_label,
      metrics.clicks,
      metrics.impressions,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign_search_term_insight
    ${where([`campaign_search_term_insight.campaign_id = ${campaignId}`, dateCondition(input.dateRange)])}
    ORDER BY metrics.clicks DESC`;
};

const addTermMetrics = (a: TermMetrics, b: TermMetrics): TermMetrics => {
  const known = a.conversions !== null && b.conversions !== null;
  const sum = addMetrics(
    { ...a, conversions: a.conversions ?? 0, conversionsValue: a.conversionsValue ?? "0" },
    { ...b, conversions: b.conversions ?? 0, conversionsValue: b.conversionsValue ?? "0" },
  );
  return known ? sum : { ...sum, conversions: null, conversionsValue: null };
};

/** "customers/1/adGroupCriteria/33~44" -> "33" (the keyword's ad group); null when the shape is wrong. */
const keywordAdGroupId = (v: unknown): string | null => {
  const ids = idsFromResourceName(v);
  return ids.length === 2 ? (ids[0] ?? null) : null;
};

/**
 * Google splits a term's rows per match type and per triggering keyword. Rows come
 * cost-ordered, so the first row of a term holds its highest-spend keyword: that one is kept,
 * and the metrics of every row are summed (as PerfoAds does).
 */
export const mergeSearchTerms = (rows: readonly Row[]): SearchTermRow[] => {
  const byKey = new Map<string, SearchTermRow>();
  for (const row of rows) {
    const term = get(row, "searchTermView.searchTerm");
    if (typeof term !== "string" || term === "") continue;
    const campaignId = id(get(row, "campaign.id"));
    const adGroupId = id(get(row, "adGroup.id"));
    const key = JSON.stringify([term, campaignId, adGroupId]);
    const m = metrics(row);
    const matchType = enumValue(get(row, "segments.searchTermMatchType"));
    const kwResource = get(row, "segments.keyword.adGroupCriterion");
    const keyword =
      kwResource === undefined && get(row, "segments.keyword.info.text") === undefined
        ? null
        : {
            criterionId: idFromResourceName(kwResource),
            adGroupId: keywordAdGroupId(kwResource),
            text: textOrNull(get(row, "segments.keyword.info.text")),
            matchType: enumValue(get(row, "segments.keyword.info.matchType")),
          };
    const existing = byKey.get(key);
    if (existing) {
      existing.metrics = addTermMetrics(existing.metrics, m);
      existing.matchType ??= matchType;
      existing.keyword ??= keyword;
      continue;
    }
    byKey.set(key, {
      searchTerm: text(term),
      pmax: false,
      status: enumValue(get(row, "searchTermView.status")),
      matchType,
      keyword,
      campaignId,
      campaignName: text(get(row, "campaign.name")),
      adGroupId,
      adGroupName: text(get(row, "adGroup.name")),
      metrics: m,
    });
  }
  return [...byKey.values()];
};

/**
 * Performance Max terms of one campaign: one row per term (summed if Google splits them).
 * conversionsKnown = false after the cost-only fallback: conversions are null, never 0.
 */
export const mapPmaxTerms = (
  rows: readonly Row[],
  campaignId: string,
  campaignName: unknown,
  conversionsKnown: boolean,
): SearchTermRow[] => {
  const byTerm = new Map<string, SearchTermRow>();
  for (const row of rows) {
    const term = get(row, "campaignSearchTermView.searchTerm");
    if (typeof term !== "string" || term.trim() === "") continue;
    const m = metrics(row);
    const tm: TermMetrics = conversionsKnown
      ? m
      : { ...m, conversions: null, conversionsValue: null };
    const existing = byTerm.get(term);
    if (existing) {
      existing.metrics = addTermMetrics(existing.metrics, tm);
      continue;
    }
    byTerm.set(term, {
      searchTerm: text(term),
      pmax: true,
      status: null,
      matchType: null,
      keyword: null,
      campaignId: id(get(row, "campaign.id")) ?? campaignId,
      campaignName: text(get(row, "campaign.name") ?? campaignName),
      adGroupId: null,
      adGroupName: null,
      metrics: tm,
    });
  }
  return [...byTerm.values()];
};

/** Live = ENABLED, or any other non-removed status with spend in the range (as PerfoAds). */
const livePmax = (rows: readonly Row[]): { id: string; name: unknown }[] =>
  rows
    .filter((r) => {
      const st = enumValue(get(r, "campaign.status"));
      return st === "ENABLED" || moneyOrZero(get(r, "metrics.costMicros")) !== "0";
    })
    .map((r) => ({ id: id(get(r, "campaign.id")) ?? "", name: get(r, "campaign.name") }))
    .filter((c) => c.id !== "");

const pmaxTermsPart = (campaignId: string) => `pmax_terms_${campaignId}`;
const pmaxPart = (campaignId: string) => `pmax_categories_${campaignId}`;

/** How one part fell short, in plain words; null when it was read in full. */
const shortfall = (p: PartStatus | undefined): string | null =>
  !p
    ? "was not run"
    : p.status === "failed" || p.status === "not_allowed"
      ? "could not be read"
      : p.timeCut
        ? "stopped because time ran short"
        : p.capped
          ? "stopped at its row limit"
          : p.status === "skipped"
            ? "was skipped"
            : null;

/** Why not every term was read: names each read that was cut or failed. */
const incompleteTermsReason = (
  parts: readonly PartStatus[],
  termParts: readonly PartStatus[],
  pmaxNotRead: number,
  overLimit: number,
): string => {
  const out: string[] = [];
  const search = shortfall(parts.find((p) => p.part === "search_terms"));
  if (search) out.push(`the Search terms read ${search}`);
  const list = parts.find((p) => p.part === "pmax_campaigns");
  const listShort = okOrSkippedByDesign(parts, "pmax_campaigns") ? null : shortfall(list);
  if (listShort) out.push(`the list of Performance Max campaigns ${listShort}`);
  if (pmaxNotRead > 0)
    out.push(`the terms of ${plural(pmaxNotRead, "Performance Max campaign")} could not be read`);
  if (overLimit > 0)
    out.push(
      `${plural(overLimit, "Performance Max campaign")} past the ${PMAX_TERM_CAMPAIGNS_MAX} highest-cost ones ${overLimit === 1 ? "was" : "were"} not read`,
    );
  const capped = termParts.filter((p) => p.status === "ok" && !p.timeCut && p.capped).length;
  if (capped > 0)
    out.push(
      `the Performance Max terms of ${plural(capped, "campaign")} stopped at the limit of ${PMAX_TERMS_PER_CAMPAIGN.toLocaleString("en-US")} rows per campaign, so they are a sample`,
    );
  return out.join("; ") || "not every term was read";
};

/** A part that ran must be complete; one skipped on purpose (not for time) is fine. */
const okOrSkippedByDesign = (parts: readonly PartStatus[], name: string): boolean =>
  partOk(parts, name) || parts.some((p) => p.part === name && p.status === "skipped" && !p.timeCut);

export const searchTermsReader: ReaderDef<
  SearchTermInput,
  SearchTermRow,
  SearchTermSummary,
  {
    pmaxCategories: PmaxCategory[] | null;
    /**
     * Live PMax campaigns whose categories were NOT read (past the campaign limit, failed or cut
     * for time); null = categories not asked for. A campaign listed here has unknown categories.
     */
    pmaxCategoriesNotRead: string[] | null;
  },
  { pmaxCategoriesTotal: number; overLimit: string[] }
> = {
  name: "search_terms",
  queries: (input) => ({
    search_terms: { gaql: searchTermsQuery(input) },
    pmax_campaigns: input.adGroupId
      ? { skipped: "Performance Max has no ad groups, so an ad_group_id filter leaves it out." }
      : { gaql: pmaxCampaignsQuery(input), limit: PMAX_CAMPAIGN_LIST_MAX },
  }),
  followUp: (input, _ctx, data) => {
    const parts: Record<string, Part> = {};
    const live = livePmax(data.pmax_campaigns ?? []);
    for (const c of live.slice(0, PMAX_TERM_CAMPAIGNS_MAX)) {
      parts[pmaxTermsPart(c.id)] = {
        gaql: pmaxTermsQuery(c.id, input, "full"),
        fallback: pmaxTermsQuery(c.id, input, "min"),
        limit: PMAX_TERMS_PER_CAMPAIGN,
        group: { name: "pmax_terms", key: c.id },
        stickyFields: PMAX_TERM_FULL_ONLY_FIELDS,
      };
    }
    if (input.includePmaxCategories) {
      for (const c of live.slice(0, PMAX_CAMPAIGNS_MAX)) {
        parts[pmaxPart(c.id)] = {
          gaql: pmaxCategoriesQuery(c.id, input),
          limit: PMAX_CATEGORIES_MAX,
          topOnly: true,
          group: { name: "pmax_categories", key: c.id },
        };
      }
    }
    return parts;
  },
  followUpOneByOne: true,
  map: (data, input, _ctx, parts) => {
    const live = livePmax(data.pmax_campaigns ?? []);
    const pmaxRows: SearchTermRow[] = [];
    for (const c of live.slice(0, PMAX_TERM_CAMPAIGNS_MAX)) {
      const status = parts.find((p) => p.part === pmaxTermsPart(c.id));
      pmaxRows.push(
        ...mapPmaxTerms(data[pmaxTermsPart(c.id)] ?? [], c.id, c.name, status?.fallback !== true),
      );
    }
    let all: PmaxCategory[] | null = null;
    let notRead: string[] | null = null;
    if (input.includePmaxCategories && !input.adGroupId) {
      all = [];
      for (const c of live.slice(0, PMAX_CAMPAIGNS_MAX)) {
        for (const row of data[pmaxPart(c.id)] ?? []) {
          all.push({
            campaignId: c.id,
            campaignName: text(c.name),
            // as Google sent it: an empty label is a hidden category (the tool output says so)
            category: text(String(get(row, "campaignSearchTermInsight.categoryLabel") ?? "")),
            impressions: count(get(row, "metrics.impressions")),
            clicks: count(get(row, "metrics.clicks")),
            conversions: double(get(row, "metrics.conversions")),
            conversionsValue: doubleMoney(get(row, "metrics.conversionsValue")),
          });
        }
      }
      notRead = [
        ...live
          .slice(0, PMAX_CAMPAIGNS_MAX)
          .filter((c) => !partOk(parts, pmaxPart(c.id)))
          .map((c) => c.id),
        ...live.slice(PMAX_CAMPAIGNS_MAX).map((c) => c.id),
      ];
      all.sort(
        (a, b) =>
          b.clicks - a.clicks ||
          a.campaignId.localeCompare(b.campaignId) ||
          a.category.untrusted.localeCompare(b.category.untrusted),
      );
    }
    return {
      rows: [...mergeSearchTerms(data.search_terms ?? []), ...pmaxRows],
      extra: {
        pmaxCategories:
          all === null ? null : input.allPmaxCategories ? all : all.slice(0, PMAX_CATEGORIES_SHOWN),
        pmaxCategoriesNotRead: notRead,
      },
      facts: {
        pmaxCategoriesTotal: all?.length ?? 0,
        overLimit: live.slice(PMAX_TERM_CAMPAIGNS_MAX).map((c) => c.id),
      },
    };
  },
  compare: (a, b) =>
    byMoneyDesc(a.metrics.cost, b.metrics.cost) ||
    a.searchTerm.untrusted.localeCompare(b.searchTerm.untrusted) ||
    (a.campaignId ?? "").localeCompare(b.campaignId ?? "") ||
    (a.adGroupId ?? "").localeCompare(b.adGroupId ?? ""),
  summarise: (rows, extra, _ctx, input, parts, facts) => {
    const termParts = parts.filter((p) => p.part.startsWith("pmax_terms_"));
    const overLimit = facts?.overLimit ?? [];
    const notRead = [
      ...termParts
        .filter((p) => p.status !== "ok" || p.timeCut)
        .map((p) => p.part.slice("pmax_terms_".length)),
      ...overLimit,
    ];
    const pmaxListed = partOk(parts, "pmax_campaigns");
    // Complete = every term read in full: no failed, skipped, over-limit or capped (sampled) part.
    const termsComplete =
      partOk(parts, "search_terms") &&
      okOrSkippedByDesign(parts, "pmax_campaigns") &&
      notRead.length === 0 &&
      termParts.every((p) => partOk(parts, p.part));
    const why = termsComplete
      ? null
      : incompleteTermsReason(
          parts,
          termParts,
          notRead.length - overLimit.length,
          overLimit.length,
        );
    const categoryParts = parts.filter((p) => p.part.startsWith("pmax_categories_"));
    const categoriesComplete =
      input.includePmaxCategories &&
      pmaxListed &&
      categoryParts.every((p) => partOk(parts, p.part));
    const unknown = rows.filter((r) => r.metrics.conversions === null);
    const t = totals(
      rows.map((r) => ({
        ...r.metrics,
        conversions: r.metrics.conversions ?? 0,
        conversionsValue: r.metrics.conversionsValue ?? "0",
      })),
    );
    return {
      searchTerms: rows.length,
      pmaxSearchTerms: pmaxListed ? rows.filter((r) => r.pmax).length : null,
      pmaxCampaignsNotRead: notRead.slice(0, 20),
      pmaxCampaignsNotReadTotal: notRead.length,
      pmaxCampaignsOverLimit: overLimit.length,
      withConversions: rows.filter((r) => (r.metrics.conversions ?? 0) > 0).length,
      termsWithUnknownConversions: unknown.length,
      costWithoutConversions: termsComplete
        ? sumMoney(rows.filter((r) => r.metrics.conversions === 0).map((r) => r.metrics.cost))
        : null,
      costWithoutConversionsUnknownBecause: why,
      costWithUnknownConversions: sumMoney(unknown.map((r) => r.metrics.cost)),
      byStatus: countBy(
        rows.filter((r) => !r.pmax),
        (r) => r.status,
      ),
      // With unknown conversions, conversion totals are a minimum and the ratios are not given.
      totals: unknown.length
        ? { ...t, costPerConversion: null, roas: null, conversionsAreMinimum: true }
        : t,
      pmaxCategories:
        categoriesComplete && extra.pmaxCategories ? (facts?.pmaxCategoriesTotal ?? 0) : null,
    };
  },
  summaryLine: (s, ctx, input) => {
    const cur = ctx.currencyCode ? ` ${ctx.currencyCode}` : "";
    return (
      `${plural(s.searchTerms, "search term")} on ${ctx.customerId} (${s.pmaxSearchTerms === null ? "Performance Max terms not read" : `${s.pmaxSearchTerms} from Performance Max`}), ${describeDateRange(input.dateRange)}: ${metricLine(s.totals, ctx)}; spent on terms with no conversions: ${s.costWithoutConversions === null ? `unknown (${s.costWithoutConversionsUnknownBecause ?? "not every term was read"})` : `${s.costWithoutConversions}${cur}`}.` +
      (s.termsWithUnknownConversions
        ? ` Conversions unknown for ${plural(s.termsWithUnknownConversions, "Performance Max term")} (${s.costWithUnknownConversions}${cur}): conversion totals are a minimum.`
        : "") +
      (s.pmaxCampaignsOverLimit
        ? ` Only the ${PMAX_TERM_CAMPAIGNS_MAX} highest-cost live Performance Max campaigns are read per call (to bound Google Ads operations and time); ${s.pmaxCampaignsOverLimit} more are not: ask with campaign_id for one of them.`
        : "") +
      (s.pmaxCampaignsNotReadTotal
        ? ` Terms of PMax campaigns ${s.pmaxCampaignsNotRead.join(", ")}${s.pmaxCampaignsNotReadTotal > s.pmaxCampaignsNotRead.length ? ", ..." : ""} were not read.`
        : "") +
      (input.includePmaxCategories
        ? ` ${countOr(s.pmaxCategories, "Performance Max category", "pmax_categories")}.`.replace(
            "categorys",
            "categories",
          )
        : "")
    );
  },
  rowLine: (r, ctx) =>
    `${shown(r.searchTerm)} ${r.pmax ? "PMAX" : (r.status ?? "?")} (campaign ${r.campaignId ?? "?"}): ${metricLine(r.metrics, ctx)}`,
};
