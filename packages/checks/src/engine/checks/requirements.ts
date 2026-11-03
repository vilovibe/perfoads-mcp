// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Effective requirements: what a check really depends on. A keyword check reads
 * `keywords`, but a keyword only reaches the model through its ad group and its
 * campaign, so an incomplete or failed `adGroups` / `campaigns` read can hide a
 * keyword just as surely. The parent chain is declared once here and applied to
 * every check.
 */
import type { AccountModel } from "../model/nodes/AccountNode.js";
import { reportableCampaigns } from "../registry/entityStatus.js";
import type { CheckDefinition } from "./types.js";

/** data key -> the keys its rows hang off in the model. */
export const PARENT_TABLES: Readonly<Record<string, readonly string[]>> = {
  adGroups: ["campaigns"],
  ads: ["adGroups"],
  keywords: ["adGroups"],
  searchTerms: ["adGroups"],
  dsaSearchTerms: ["adGroups"],
  adExtensions: ["campaigns"],
  campaignDailyMetrics: ["campaigns"],
  campaignBudgets: ["campaigns"],
  impressionShare: ["campaigns"],
  bidModifiers: ["campaigns"],
  simulations: ["campaigns"],
  biddingOverrides: ["campaigns"],
  biddingStrategies: ["campaigns"],
  deviceData: ["campaigns"],
  geographicData: ["campaigns"],
  demographicData: ["campaigns"],
  campaignAudiencePerf: ["campaigns"],
  assetGroups: ["campaigns"],
  pmaxAssets: ["assetGroups"],
  pmaxSignals: ["assetGroups"],
  pmaxListingGroups: ["assetGroups"],
  pmaxChannelDistribution: ["campaigns"],
  pmaxSearchInsights: ["campaigns"],
  pmax_placements: ["campaigns"],
  campaignConversions: ["campaigns"],
  campaignConversionGoals: ["campaigns"],
  campaign_control_settings: ["campaigns"],
  temporal_grid: ["campaigns"],
  // an asset rating and a policy verdict hang off their ad
  assetPerformance: ["ads"],
  adPolicyData: ["ads"],
  // the per-day series of an action hangs off the action
  conversion_action_daily: ["conversionActions"],
  shoppingSettings: ["campaigns"],
  pmax_campaign_products: ["campaigns"],
  placement_performance: ["campaigns"],
  geo_countries: ["campaigns"],
  campaign_languages: ["campaigns"],
  video_campaign_metrics: ["campaigns"],
  dg_campaign_settings: ["campaigns"],
  dg_assets: ["campaigns"],
  dg_audience_signals: ["campaigns"],
  dg_channel_distribution: ["campaigns"],
  dg_channel_controls: ["campaigns"],
};

/** Tables a check reads beyond its `requires` (completeness only; they do not gate the run). */
export const CHECK_READS: Readonly<Record<string, readonly string[]>> = {
  BB15: ["searchTerms", "keywords"],
  // a quiet run is skipped by the campaigns' own daily clicks; a data exclusion can cover it
  MI18: ["campaigns", "campaignDailyMetrics", "biddingOverrides"],
  // the exposed campaigns decide whether exclusions apply at all
  AS07: ["campaigns"],
  AS15: ["campaigns"],
  // seasonal set-up lives in campaign names, keywords and promotion assets
  AS17: ["adExtensions", "keywords"],
  // the blocked state of a search reads every negative level
  SK06: ["sharedNegativeListMembers", "campaign_negatives", "campaign_negatives_sync_marker"],
  // the searches other campaigns already own
  SK10: ["searchTerms"],
  // the thinnest serving context is per ad group
  SK16: ["adGroups"],
  SK17: ["adGroups"],
  // every negative level can block a keyword
  // a group with no asset rows is unknown, never rated
  PX09: ["pmaxAssets"],
  // the listed placements sit on the campaign; the app-category exclusion is read too
  PX19: ["pmax_placements", "account_negative_criteria"],
  // every negative level can cover a Performance Max campaign
  PX21: [
    "campaign_negatives",
    "campaign_negatives_sync_marker",
    "sharedNegativeListMembers",
    "accountNegatives",
    "pmaxSearchTerms",
  ],
  // the return without brand comes from the Performance Max search terms
  PX02: ["pmaxSearchTerms", "campaigns"],
  // live Performance Max signals also count as attached
  SL02: ["pmaxSignals", "assetGroups"],
  // the moves are judged on the live campaigns
  BB13: ["campaigns"],
  // the catalogue walked through the listing trees; its completeness flag rides on the feed status
  SH19: ["products_catalog", "shoppingProductsData", "mcSyncStatus"],
  PX15: ["products_catalog", "mcSyncStatus", "campaigns"],
  // a Shopping campaign's products and an asset group's products are matched on the product list
  PX11: ["products", "campaigns"],
  SH12: ["shoppingProductsData", "campaigns"],
  // the money bar and the account return read the campaigns
  SH04: ["campaigns"],
  SH05: ["campaigns"],
  SH23: ["shoppingProductsData", "campaigns"],
  // a Local Services check first asks whether the account runs a Local Services campaign
  PR03: ["campaigns"],
  PR04: ["campaigns"],
  PR05: ["campaigns"],
  PR06: ["campaigns"],
  PR07: ["campaigns"],
  // the places already excluded for the account are skipped
  PX07: ["account_placement_exclusions"],
  PX16: ["account_placement_exclusions"],
  // a feed label names the countries the shop sells to
  SL11: ["campaigns", "shoppingProductsData"],
  SK33: [
    "campaign_negatives",
    "campaign_negatives_sync_marker",
    "sharedNegativeLists",
    "sharedNegativeListMembers",
    "accountNegatives",
  ],
};

/** Tables that define the audit window (model/windows.ts computeAuditWindow): every check uses it. */
export const WINDOW_TABLES: readonly string[] = ["dailyMetrics"];

/** Registry metrics computed from the impressionShare rows (registry/metrics.ts). */
const IMPRESSION_SHARE_METRICS: ReadonlySet<string> = new Set([
  "C.lost_is_budget_pct",
  "C.lost_is_budget_recent_pct",
  "C.lost_is_rank_pct",
  "C.impression_share",
]);

/** Tables a check depends on through the metrics it cites, and the window every check reads. */
function metricTables(def: CheckDefinition): string[] {
  const out: string[] = [...WINDOW_TABLES];
  if (def.metrics.some((m) => m.startsWith("C.budget"))) out.push("campaignBudgets");
  // the device slices (and BB09's modifier-vs-slice, which starts from them); the day x hour
  // grid is its own table and a requirement of the check that reads it
  if (
    def.metrics.some(
      (m) =>
        m.startsWith("SL.device") ||
        m.startsWith("SL.bid_modifier") ||
        m.startsWith("SL.modifier_vs_slice"),
    )
  )
    out.push("deviceData");
  if (def.metrics.some((m) => m.startsWith("SL.audience"))) out.push("campaignAudiencePerf");
  if (def.metrics.some((m) => m.startsWith("SL.demo"))) out.push("demographicData");
  // the impression-share metrics read the impressionShare rows (BB16 decides "budget-limited" on one)
  if (def.metrics.some((m) => IMPRESSION_SHARE_METRICS.has(m))) out.push("impressionShare");
  return out;
}

/** Where each bid-modifier slice kind is measured (model/buildSlices.ts tableOf). */
const MODIFIER_SLICE_TABLES: Readonly<Record<string, string>> = {
  device: "deviceData",
  geo: "geographicData",
  dowHour: "temporal_grid",
  audience: "campaignAudiencePerf",
};

/**
 * Tables a check depends on only for what this account holds: BB09 judges each bid
 * adjustment on its own slice, so a location adjustment makes the location performance a
 * dependency, a schedule adjustment the day x hour grid. Only running campaigns count: BB09
 * judges nothing on a paused or removed one.
 */
export function dynamicRequires(def: CheckDefinition, model: AccountModel): string[] {
  if (def.id !== "BB09") return [];
  const out = new Set<string>();
  for (const c of reportableCampaigns(model))
    for (const b of c.children.bidModifiers) {
      const t = MODIFIER_SLICE_TABLES[b.attrs.measuredSlice.kind];
      if (t) out.add(t);
    }
  return [...out];
}

const cache = new WeakMap<CheckDefinition, string[]>();

/** The check's `requires`, the tables its metrics read, and every parent of each, de-duplicated. */
export function effectiveRequires(def: CheckDefinition): string[] {
  const hit = cache.get(def);
  if (hit) return hit;
  const seen = new Set<string>();
  const visit = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    for (const p of PARENT_TABLES[t] ?? []) visit(p);
  };
  for (const t of [...def.requires, ...(CHECK_READS[def.id] ?? []), ...metricTables(def)]) visit(t);
  const out = [...seen];
  cache.set(def, out);
  return out;
}
