// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot): the searches dynamic search ads served on
// (dynamic_search_ads_search_term_view), per campaign and ad group, with their metrics over
// the date range. Search terms are wrapped as untrusted text.

import * as z from "zod";
import {
  filterConditions,
  metricLine,
  MetricsSchema,
  plural,
  shown,
  where,
  type FilterInput,
} from "../common.js";
import { addMetrics, byMoneyDesc, get, id, metrics, text } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const DsaSearchTermRowSchema = z.object({
  campaignId: z.string().nullable(),
  adGroupId: z.string().nullable(),
  searchTerm: UntrustedSchema,
  metrics: MetricsSchema,
});
export type DsaSearchTermRow = z.infer<typeof DsaSearchTermRowSchema>;

export const DsaSearchTermSummarySchema = z.object({
  terms: z.number().nullable().describe("null = not read"),
});
export type DsaSearchTermSummary = z.infer<typeof DsaSearchTermSummarySchema>;

export const dsaSearchTermsQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      ad_group.id,
      dynamic_search_ads_search_term_view.search_term,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM dynamic_search_ads_search_term_view
    ${where(filterConditions({ ...input, status: null }, null))}
    ORDER BY metrics.cost_micros DESC`;

export const dsaSearchTermsReader: ReaderDef<
  FilterInput,
  DsaSearchTermRow,
  DsaSearchTermSummary,
  null
> = {
  name: "dsa_search_terms",
  queries: (input) => ({ terms: { gaql: dsaSearchTermsQuery(input) } }),
  // Google splits one search by headline, landing page and page URL: one row per campaign,
  // ad group and search here, metrics added up
  map: (data) => {
    const merged = new Map<string, DsaSearchTermRow>();
    for (const row of data.terms ?? []) {
      const term = get(row, "dynamicSearchAdsSearchTermView.searchTerm");
      if (typeof term !== "string" || term === "") continue;
      const campaignId = id(get(row, "campaign.id"));
      const adGroupId = id(get(row, "adGroup.id"));
      const key = `${campaignId ?? ""}|${adGroupId ?? ""}|${term}`;
      const prev = merged.get(key);
      merged.set(
        key,
        prev
          ? { ...prev, metrics: addMetrics(prev.metrics, metrics(row)) }
          : { campaignId, adGroupId, searchTerm: text(term), metrics: metrics(row) },
      );
    }
    return { rows: [...merged.values()], extra: null };
  },
  compare: (a, b) =>
    byMoneyDesc(a.metrics.cost, b.metrics.cost) ||
    (a.adGroupId ?? "").localeCompare(b.adGroupId ?? "") ||
    a.searchTerm.untrusted.localeCompare(b.searchTerm.untrusted),
  summarise: (rows, _extra, _ctx, _input, parts) => ({
    terms: partOk(parts, "terms") ? rows.length : null,
  }),
  summaryLine: (s, ctx) =>
    s.terms === null
      ? `Dynamic search ad searches on ${ctx.customerId}: unknown (not read).`
      : `${plural(s.terms, "dynamic search ad search")} on ${ctx.customerId}.`,
  rowLine: (r, ctx) =>
    `${shown(r.searchTerm)} (ad group ${r.adGroupId ?? "?"}): ${metricLine(r.metrics, ctx)}`,
};
