// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). Ported from PerfoAds fetchLandingPages
// (landing_page_view: unexpanded final URL, metrics, mobile-friendly clicks, speed score).
// Changes: expanded_landing_page_view added (the URLs people really landed on), no
// impressions/cost filter and no LIMIT 50 (the reader's row cap applies), URLs wrapped.

import * as z from "zod";
import {
  metricLine,
  MetricsSchema,
  plural,
  shown,
  TotalsSchema,
  filterConditions,
  where,
  type FilterInput,
} from "../common.js";
import {
  byMoneyDesc,
  count,
  get,
  id,
  metrics,
  ratio,
  text,
  totals,
  type Row,
} from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const LandingPageRowSchema = z.object({
  kind: z.enum(["final_url", "expanded_url"]),
  url: UntrustedSchema,
  metrics: MetricsSchema,
  mobileFriendlyClicksPercentage: z.number().nullable(),
  speedScore: z.number().nullable().describe("1-10"),
});
export type LandingPageRow = z.infer<typeof LandingPageRowSchema>;

export const LandingPageSummarySchema = z.object({
  finalUrls: z.number().nullable(),
  expandedUrls: z.number().nullable(),
  totals: TotalsSchema.nullable().describe("Over final URLs; null = not read"),
});
export type LandingPageSummary = z.infer<typeof LandingPageSummarySchema>;

const METRIC_FIELDS = `
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value`;

export const landingPagesQuery = (input: FilterInput): string => `
    SELECT
      landing_page_view.unexpanded_final_url,${METRIC_FIELDS},
      metrics.mobile_friendly_clicks_percentage,
      metrics.speed_score
    FROM landing_page_view
    ${where(filterConditions({ ...input, status: null }, null))}
    ORDER BY metrics.cost_micros DESC`;

export const expandedLandingPagesQuery = (input: FilterInput): string => `
    SELECT
      expanded_landing_page_view.expanded_final_url,${METRIC_FIELDS}
    FROM expanded_landing_page_view
    ${where(filterConditions({ ...input, status: null }, null))}
    ORDER BY metrics.cost_micros DESC`;

/** Landing pages input. `campaignSplit` is for the account snapshot only (the tool never sets it). */
export interface LandingPagesInput extends FilterInput {
  /** Also read each final URL's clicks per campaign: which campaigns fed a page. */
  campaignSplit?: boolean;
}

/** Snapshot detail (input.campaignSplit): clicks per final URL per campaign; null = not read. */
export interface LandingPageCampaignClicks {
  campaignClicks:
    { url: z.infer<typeof UntrustedSchema>; campaignId: string; clicks: number }[] | null;
}

/** Each final URL's clicks per campaign (campaigns of every type, Performance Max too). */
export const landingPageCampaignsQuery = (input: FilterInput): string => `
    SELECT
      landing_page_view.unexpanded_final_url,
      campaign.id,
      metrics.clicks
    FROM landing_page_view
    ${where(filterConditions({ ...input, status: null }, null))}
    ORDER BY metrics.clicks DESC`;

const mapRow = (row: Row, kind: LandingPageRow["kind"]): LandingPageRow | null => {
  const url = get(
    row,
    kind === "final_url"
      ? "landingPageView.unexpandedFinalUrl"
      : "expandedLandingPageView.expandedFinalUrl",
  );
  if (typeof url !== "string" || url === "") return null;
  return {
    kind,
    url: text(url),
    metrics: metrics(row),
    mobileFriendlyClicksPercentage:
      kind === "final_url" ? ratio(get(row, "metrics.mobileFriendlyClicksPercentage")) : null,
    speedScore: kind === "final_url" ? ratio(get(row, "metrics.speedScore")) : null,
  };
};

export const landingPagesReader: ReaderDef<
  LandingPagesInput,
  LandingPageRow,
  LandingPageSummary,
  LandingPageCampaignClicks | null
> = {
  name: "landing_pages",
  queries: (input) => ({
    final_urls: { gaql: landingPagesQuery(input) },
    expanded_urls: { gaql: expandedLandingPagesQuery(input) },
    ...(input.campaignSplit
      ? { final_url_campaigns: { gaql: landingPageCampaignsQuery(input) } }
      : {}),
  }),
  map: (data, input, _ctx, parts) => ({
    rows: [
      ...(data.final_urls ?? []).map((r) => mapRow(r, "final_url")),
      ...(data.expanded_urls ?? []).map((r) => mapRow(r, "expanded_url")),
    ].filter((r): r is LandingPageRow => r !== null),
    extra: input.campaignSplit
      ? {
          campaignClicks: partOk(parts, "final_url_campaigns")
            ? (data.final_url_campaigns ?? []).flatMap((r) => {
                const url = get(r, "landingPageView.unexpandedFinalUrl");
                const campaignId = id(get(r, "campaign.id"));
                if (typeof url !== "string" || url === "" || !campaignId) return [];
                return [{ url: text(url), campaignId, clicks: count(get(r, "metrics.clicks")) }];
              })
            : null,
        }
      : null,
  }),
  compare: (a, b) =>
    a.kind.localeCompare(b.kind) ||
    byMoneyDesc(a.metrics.cost, b.metrics.cost) ||
    a.url.untrusted.localeCompare(b.url.untrusted),
  summarise: (rows, _extra, _ctx, _input, parts) => {
    const finals = rows.filter((r) => r.kind === "final_url");
    return {
      finalUrls: partOk(parts, "final_urls") ? finals.length : null,
      expandedUrls: partOk(parts, "expanded_urls")
        ? rows.filter((r) => r.kind === "expanded_url").length
        : null,
      totals: partOk(parts, "final_urls") ? totals(finals.map((r) => r.metrics)) : null,
    };
  },
  summaryLine: (s, ctx) =>
    `Landing pages on ${ctx.customerId}: ${s.finalUrls === null ? "final URLs unknown" : plural(s.finalUrls, "final URL")}, ${s.expandedUrls === null ? "expanded URLs unknown" : plural(s.expandedUrls, "expanded URL")}${s.totals ? `: ${metricLine(s.totals, ctx)}` : ""}.`,
  rowLine: (r, ctx) => `${r.kind} ${shown(r.url)}: ${metricLine(r.metrics, ctx)}`,
};
