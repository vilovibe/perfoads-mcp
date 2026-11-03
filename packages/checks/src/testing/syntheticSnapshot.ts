// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * A synthetic multi-campaign account for the model tests. Every number is made
 * up. Deterministic: no Date.now(), fixed anchor date.
 */
import type { EngineSnapshot } from "../engine/model/buildAccountModel.js";
import type { AccountData } from "../engine/shared/input.js";

export const SYNTHETIC_AUDIT_ID = "synthetic";
const ANCHOR = Date.UTC(2026, 8, 1); // 2026-09-01 = "yesterday" for the fixture

export function buildSyntheticAuditData(n: number = 5): AccountData {
  const day = (i: number) => new Date(ANCHOR - i * 86400000).toISOString().slice(0, 10);
  const campaigns: any[] = [];
  const daily: any[] = [];
  const searchTerms: any[] = [];
  const keywords: any[] = [];
  const ads: any[] = [];
  const adGroups: any[] = [];
  const budgets: any[] = [];
  const deviceData: any[] = [];
  const impressionShare: any[] = [];
  const pmaxChannelDistribution: any[] = [];
  const types = ["SEARCH", "PERFORMANCE_MAX", "SHOPPING", "SEARCH", "SEARCH"];
  for (let k = 0; k < n; k++) {
    const id = String(1000 + k);
    const type = types[k % types.length]!;
    const spend = Math.round(9000 / (k + 1)) + 50;
    const conv = k % 7 === 3 ? 0 : Math.max(1, Math.round(spend / (40 + k)));
    const value = conv * (60 + k * 3);
    campaigns.push({
      campaign_id: id,
      name: `${k % 4 === 0 ? "Brand" : "Generic"} ${type.toLowerCase()} campaign ${k + 1}`,
      status: "ENABLED",
      type,
      cost: String(spend),
      clicks: String(spend * 3),
      impressions: String(spend * 60),
      conversions: String(conv),
      conversion_value: String(value),
      budget: String(Math.round(spend / 90) + 5),
      bidding_strategy_type: [
        "TARGET_ROAS",
        "MAXIMIZE_CONVERSIONS",
        "TARGET_CPA",
        "MAXIMIZE_CONVERSION_VALUE",
      ][k % 4],
      target_roas: k % 4 === 0 ? 4 : null,
      target_cpa: k % 4 === 2 ? 35 : null,
    });
    impressionShare.push({
      campaign_id: id,
      search_budget_lost_impression_share: (k % 3) * 0.1,
      search_rank_lost_impression_share: (k % 4) * 0.08,
    });
    budgets.push({ campaign_id: id, amount_micros: (Math.round(spend / 90) + 5) * 1_000_000 });
    for (let i = 0; i < 90; i++) {
      const declining = k % 5 === 1 && i < 30;
      daily.push({
        campaign_id: id,
        metric_date: day(i),
        cost: spend / 90,
        conversions: declining ? conv / 180 : conv / 90,
        conversion_value: declining ? value / 180 : value / 90,
        clicks: spend / 30,
      });
    }
    for (let g = 0; g < 3; g++)
      adGroups.push({ campaign_id: id, ad_group_id: `${id}-${g}`, name: `Ad group ${g}` });
    for (let a = 0; a < 4; a++)
      ads.push({
        campaign_id: id,
        ad_group_id: `${id}-${a % 3}`,
        ad_id: `${id}-ad${a}`,
        type: "RESPONSIVE_SEARCH_AD",
        headlines: JSON.stringify(Array.from({ length: 5 + a }, (_, h) => `Headline ${h}`)),
        status: "ENABLED",
      });
    for (let q = 0; q < 6; q++)
      keywords.push({
        campaign_id: id,
        ad_group_id: `${id}-${q % 3}`,
        keyword: `keyword ${k} ${q}`,
        match_type: "BROAD",
        quality_score: 3 + (q % 7),
        expected_ctr: "BELOW_AVERAGE",
        ad_relevance: "AVERAGE",
        landing_page_experience: "AVERAGE",
        cost: String(spend / 6),
        clicks: String(spend / 2),
        conversions: String(conv / 6),
      });
    for (let t = 0; t < 8; t++)
      searchTerms.push({
        campaign_id: id,
        search_term: `cheap free ${k} term ${t} near me`,
        cost: String(spend / 12),
        clicks: String(spend / 4),
        conversions: t < 2 ? "0" : String(conv / 8),
        impressions: String(spend * 4),
      });
    for (const dev of ["MOBILE", "DESKTOP", "TABLET"])
      deviceData.push({
        campaign_id: id,
        device: dev,
        cost: String(spend / 3),
        conversions: String(dev === "TABLET" ? 0 : conv / 2),
        clicks: String(spend),
      });
    if (type === "PERFORMANCE_MAX") {
      for (const net of ["SEARCH", "CONTENT", "YOUTUBE", "MIXED"])
        pmaxChannelDistribution.push({
          campaign_id: id,
          ad_network_type: net,
          cost: String(net === "SEARCH" ? spend * 0.6 : spend * 0.13),
          conversions: String(conv / 4),
          conversion_value: String(value / 4),
          clicks: String(spend),
          impressions: String(spend * 30),
        });
    }
  }
  const data: any = {
    currencyCode: "USD",
    customerId: "1234567890",
    profile: { businessType: "ecommerce", brandTerms: ["Synthetic Store"], industry: "apparel" },
    merchantCenterConnected: true,
    optimizationScore: null,
    conversionTrackingSettings: null,
    campaigns,
    campaignDailyMetrics: daily,
    dailyMetrics: daily,
    searchTerms,
    keywords,
    ads,
    adGroups,
    campaignBudgets: budgets,
    deviceData,
    impressionShare,
    pmaxChannelDistribution,
    conversionActions: Array.from({ length: 6 }, (_, i) => ({
      name: `Conv action ${i}`,
      category: i < 2 ? "PURCHASE" : "PAGE_VIEW",
      status: "ENABLED",
      primary_for_goal: i < 2,
      include_in_conversions_metric: i < 3,
    })),
    recommendationSubscriptions: [{ type: "KEYWORD", status: "ENABLED" }],
    accountNegatives: Array.from({ length: 12 }, (_, i) => ({ keyword: `neg ${i}` })),
    sharedNegativeLists: [{ name: "Universal negatives" }],
  };
  return data as AccountData;
}

export function buildSyntheticSnapshot(
  n: number = 5,
): EngineSnapshot & { dbTables: Record<string, any[]> } {
  const data = buildSyntheticAuditData(n);
  const pmaxIds = (data.campaigns ?? [])
    .filter((c) => c.type === "PERFORMANCE_MAX")
    .map((c) => c.campaign_id);
  const temporalGrid = (data.campaigns ?? []).flatMap((c) =>
    ["MONDAY", "TUESDAY", "WEDNESDAY"].flatMap((dow) =>
      [3, 12, 20].map((hour) => ({
        campaign_id: c.campaign_id,
        day_of_week: dow,
        hour_of_day: hour,
        cost: String(hour === 3 ? 15 : 20),
        conversions: String(hour === 3 ? 0 : 1),
      })),
    ),
  );
  return {
    auditId: SYNTHETIC_AUDIT_ID,
    data,
    dbTables: {
      campaign_control_settings: (data.campaigns ?? []).map((c) => ({
        campaign_id: c.campaign_id,
        channel_type: c.type,
        frequency_caps: null,
        asset_automation: null,
        view_through_conversions: "0",
        all_conversions: c.conversions,
      })),
      placement_performance: [],
      account_negative_criteria: [{ criterion_type: "KEYWORD" }],
      campaign_negatives: pmaxIds.flatMap((id) => [
        { campaign_id: id, keyword_text: "free" },
        { campaign_id: id, keyword_text: "cheap" },
      ]),
      campaign_negatives_sync_marker: pmaxIds.map((id) => ({ campaign_id: id })),
      // dow x hour grid (Phase 0b): a few cells per campaign, hour 3 = dead zone.
      temporal_grid: temporalGrid,
      // Per-table sync markers (Phase 0b): the grid is "ok" so dead zones count as checked.
      // Per-action daily conversions (Phase 0, 2026-09-06): synced, no rows.
      conversion_action_daily: [],
      // Value by rule dimension (item 9, 2026-09-06): synced, no rows (no rules).
      conversion_value_by_rule: [],
      sync_table_status: [
        { table_name: "temporal_grid", status: "ok", row_count: temporalGrid.length },
        { table_name: "conversion_action_daily", status: "ok", row_count: 0 },
        { table_name: "conversion_value_by_rule", status: "ok", row_count: 0 },
      ],
    },
  };
}
