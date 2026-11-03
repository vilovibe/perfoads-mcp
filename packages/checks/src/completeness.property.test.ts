// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Property: completeness damage can never produce a "clean" result.
 *
 * Start from a fully read synthetic account, apply random damage (dropped rows,
 * bad row counts, failed / not_allowed / skipped / missing statuses, orphan
 * rows, rows at the caller's cap, unusable rows) and check, for every check:
 *   - a check that was not clean on the undamaged account is not clean now;
 *   - a check whose tables were damaged is not clean. "Its tables" come from the
 *     hand-written HAND_DEPS below, NOT from `dependsOn`: a dependency the engine
 *     forgot would otherwise be forgotten by the test too.
 *
 * Base accounts: the general one (most checks clean), a bidding one, clean and
 * firing, so BB09 (bid modifiers vs device slices), BB16 (loose target) and BB17
 * (re-learning) are protected in both states, the wave-1 and wave-2 accounts, and
 * the wave-3 shop (clean and firing), video, Local Services and Demand Gen accounts.
 */
import { describe, expect, it } from "vitest";
import { listChecks, runChecks, type EvidenceInput } from "./api.js";
import type { Row } from "./engine/shared/input.js";
import { AUDIT_KEY_TABLE } from "./engine/model/buildAccountModel.js";
import { LEGACY_COUNT_COLUMNS } from "./engine/model/context.js";
import {
  adGroup,
  buildInput,
  dayBefore,
  keyword,
  LAST_DAY,
  searchTerm,
} from "./testing/account.js";
import {
  country,
  demandGenAccount,
  lsaAccount,
  PRODUCTS,
  shoppingAccount,
  videoAccount,
} from "./testing/wave3.js";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** A fully read account on which most checks are clean. */
function cleanAccount(): EvidenceInput {
  return buildInput({
    campaigns: [
      {
        id: "11",
        name: "Generic search",
        budget: 100,
        cost: 90,
        conv: 0.5,
        value: 300,
        is: { lostBudget: 0.02, lostRank: 0.1 },
      },
      {
        id: "12",
        name: "Generic shopping",
        type: "SHOPPING",
        budget: 50,
        cost: 45,
        conv: 0.4,
        value: 150,
        is: { lostBudget: 0.01, lostRank: 0.05 },
      },
    ],
    data: {
      adGroups: [
        adGroup({ id: "21", campaignId: "11" }),
        adGroup({ id: "22", campaignId: "11" }),
        adGroup({ id: "23", campaignId: "12" }),
      ],
      keywords: [
        keyword({
          id: "31",
          campaignId: "11",
          adGroupId: "21",
          text: "boots",
          match: "EXACT",
          cost: 300,
          clicks: 100,
          conv: 5,
          qs: 8,
        }),
        keyword({
          id: "32",
          campaignId: "11",
          adGroupId: "22",
          text: "hiking shoes",
          match: "PHRASE",
          cost: 300,
          clicks: 100,
          conv: 5,
          qs: 8,
        }),
      ],
      searchTerms: [
        searchTerm({
          campaignId: "11",
          adGroupId: "21",
          term: "boots",
          cost: 200,
          clicks: 80,
          conv: 4,
        }),
        searchTerm({
          campaignId: "11",
          adGroupId: "22",
          term: "hiking shoes",
          cost: 200,
          clicks: 80,
          conv: 4,
        }),
      ],
    },
    syncedEmpty: ["changeHistory", "biddingStrategies", "simulations", "biddingOverrides"],
  });
}

/**
 * Bidding base: a Target ROAS campaign that is budget-limited (BB16), a manual CPC
 * campaign with a device bid adjustment (BB09) and a target change in the change
 * history (BB17). `fire` = the signals are there; otherwise the same account is clean.
 */
function biddingAccount(fire: boolean): EvidenceInput {
  const device = (mobileConv: number) => [
    {
      campaign_id: "12",
      device: "MOBILE",
      cost: 4500,
      clicks: 2000,
      conversions: mobileConv,
      conversion_value: mobileConv * 200,
      impressions: 40000,
    },
    {
      campaign_id: "12",
      device: "DESKTOP",
      cost: 4500,
      clicks: 2500,
      conversions: 180 - mobileConv,
      conversion_value: (180 - mobileConv) * 200,
      impressions: 50000,
    },
  ];
  const change = (campaignId: string, daysAgo: number) => ({
    change_resource_name: `customers/1/campaigns/${campaignId}`,
    change_date_time: `${dayBefore(LAST_DAY, daysAgo)} 10:00:00`,
    changed_fields: "maximize_conversion_value.target_roas",
    changed_values: { "maximizeConversionValue.targetRoas": { old: 3, new: 4 } },
    operation: "UPDATE",
    client_type: "GOOGLE_ADS_WEB_CLIENT",
    resource_type: "CAMPAIGN",
  });
  return buildInput({
    campaigns: [
      {
        id: "11",
        name: "Generic search roas",
        strategy: "TARGET_ROAS",
        targetRoas: fire ? 2 : 4,
        conv: 2,
        value: 400,
        cost: 100,
        budget: 100,
        is: { lostBudget: 0.2 },
      },
      { id: "12", name: "Generic search manual", strategy: "MANUAL_CPC", budget: 100, cost: 100 },
      {
        id: "13",
        name: "Generic search relearn",
        strategy: "TARGET_ROAS",
        targetRoas: 4,
        budget: 100,
        cost: 95,
        is: { lostBudget: 0.01 },
      },
    ],
    data: {
      deviceData: device(fire ? 20 : 90),
      bidModifiers: [
        {
          campaign_id: "12",
          criterion_id: "30001",
          bid_modifier: 1.5,
          modifier_source: "DEVICE",
          criterion_key: "MOBILE",
        },
        // a location adjustment too: BB09 then also depends on the location performance
        {
          campaign_id: "12",
          criterion_id: "1023191",
          bid_modifier: 1.2,
          modifier_source: "LOCATION",
          criterion_key: "geoTargetConstants/1023191",
        },
      ],
      geographicData: [
        {
          campaign_id: "12",
          location_id: "1023191",
          location_type: "TARGETED",
          cost: 3000,
          clicks: 1500,
          conversions: 60,
          conversion_value: 12000,
          impressions: 30000,
        },
      ],
      changeHistory: [change("13", fire ? 5 : 40)],
    },
    syncedEmpty: ["biddingStrategies", "simulations", "biddingOverrides"],
  });
}

/** Rows of the engine's named tables: one action firing every day, campaign 11's negatives read. */
const dailyRows = (actionId: string, days: number): Row[] =>
  Array.from({ length: days }, (_, i) => ({
    conversion_action_id: actionId,
    date: dayBefore(LAST_DAY, i),
    conversions: 2,
    conversions_value: 200,
  }));

/**
 * Wave-1 base: every table the account checks read, read in full, set up so most of them are
 * clean (never clean by design: SK21 and SK35 state a split, MI08 states the unsettled days,
 * MI11 states a positive, AS17 runs in September with nothing seasonal set up).
 */
function wave1Account(): EvidenceInput {
  const input = buildInput({
    campaigns: [
      {
        id: "11",
        name: "Generic search",
        budget: 200,
        cost: 150,
        conv: 3,
        value: 600,
        is: { lostBudget: 0.02 },
      },
      {
        id: "12",
        name: "Generic shopping",
        type: "SHOPPING",
        budget: 100,
        cost: 80,
        conv: 2,
        value: 400,
      },
    ],
    profile: { businessType: "ecommerce", brandTerms: ["acme"] },
    data: {
      adGroups: [
        {
          ...adGroup({ id: "21", campaignId: "11" }),
          cost: 9000,
          clicks: 3000,
          impressions: 60000,
        },
        adGroup({ id: "23", campaignId: "12" }),
      ],
      keywords: [
        keyword({
          id: "31",
          campaignId: "11",
          adGroupId: "21",
          text: "trail boots",
          cost: 300,
          clicks: 100,
          conv: 5,
        }),
      ],
      searchTerms: [
        searchTerm({
          campaignId: "11",
          adGroupId: "21",
          term: "trail boots",
          cost: 300,
          clicks: 100,
          conv: 5,
        }),
      ],
      conversionActions: [
        {
          action_id: "61",
          name: "Purchase",
          status: "ENABLED",
          category: "PURCHASE",
          is_primary: true,
          attribution_model: "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN",
          lookback_window_days: 30,
          total_conversions: 180,
          total_value: 18000,
        },
      ],
      customerConversionGoals: [{ category: "PURCHASE", origin: "WEBSITE", biddable: true }],
      campaignConversionGoals: [
        { campaign_id: "11", category: "PURCHASE", origin: "WEBSITE", biddable: true },
      ],
      conversionValueRules: [{ rule_id: "71", status: "PAUSED" }],
      conversionTrackingSettings: {
        enhanced_conversions_enabled: true,
        accepted_customer_data_terms: true,
        conversion_tracking_status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
      },
      recommendationSubscriptions: [{ type: "OPTIMIZE_AD_ROTATION", status: "ENABLED" }],
      experiments: [
        { experiment_id: "81", resource_name: "customers/1/experiments/81", status: "HALTED" },
      ],
      sharedNegativeLists: [
        {
          shared_set_id: "91",
          shared_set_name: "Junk",
          member_count: 1,
          linked_campaign_ids: ["11", "12"],
        },
      ],
      sharedNegativeListMembers: [
        {
          shared_set_id: "91",
          shared_set_name: "Junk",
          keyword_text: "free",
          match_type: "PHRASE",
        },
      ],
      audienceLists: [
        "All purchasers",
        "High value customers",
        "Recent purchasers",
        "Cart abandoners",
        "Newsletter subscribers",
        "Repeat customers",
        "Lapsed customers",
      ].map((n, i) => ({
        list_id: String(950 + i),
        list_name: n,
        membership_status: "OPEN",
        size_for_search: 5000,
      })),
      customerUserAccess: [{ access_role: "ADMIN" }],
      offlineUserDataJobs: [
        {
          job_id: "1001",
          type: "CUSTOMER_MATCH_USER_LIST",
          status: "SUCCESS",
          user_list_resource_name: "customers/1/userLists/954",
        },
      ],
      changeHistory: [
        {
          change_date_time: `${dayBefore(LAST_DAY, 3)} 10:00:00`,
          change_resource_name: "customers/1/campaigns/11",
          resource_type: "CAMPAIGN",
          operation: "UPDATE",
          changed_fields: "name",
          client_type: "GOOGLE_ADS_WEB_CLIENT",
          user_email: "a",
        },
      ],
      ads: [
        {
          ad_id: "41",
          ad_group_id: "21",
          campaign_id: "11",
          type: "RESPONSIVE_SEARCH_AD",
          status: "ENABLED",
          headlines: Array.from({ length: 12 }, (_, i) => ({
            text: `Headline ${i}`,
            pinnedField: null,
          })),
          descriptions: [{ text: "Description", pinnedField: null }],
          final_urls: ["https://example.com/collections/boots"],
          cost: 9000,
          clicks: 3000,
          impressions: 60000,
          conversions: 90,
          conversion_value: 18000,
        },
      ],
      adPolicyData: [
        {
          ad_id: "41",
          campaign_id: "11",
          ad_group_id: "21",
          approval_status: "APPROVED",
          ad_status: "ENABLED",
          ad_group_status: "ENABLED",
          campaign_status: "ENABLED",
        },
      ],
      assetPerformance: [
        {
          asset_id: "5001",
          ad_resource: "customers/1/adGroupAds/21~41",
          field_type: "HEADLINE",
          performance_label: "GOOD",
          asset_text: "Headline 0",
        },
      ],
      adExtensions: [
        ...[1, 2, 3, 4].map((i) => ({
          asset_id: `s${i}`,
          extension_type: "SITELINK",
          level: "CAMPAIGN",
          campaign_id: "11",
          text: `Link ${i}`,
          impressions: 100,
          approval_status: "APPROVED",
        })),
        ...[1, 2, 3, 4, 5, 6].map((i) => ({
          asset_id: `c${i}`,
          extension_type: "CALLOUT",
          level: "CAMPAIGN",
          campaign_id: "11",
          text: `Callout ${i}`,
          impressions: 100,
          approval_status: "APPROVED",
        })),
        {
          asset_id: "n1",
          extension_type: "STRUCTURED_SNIPPET",
          level: "CAMPAIGN",
          campaign_id: "11",
          text: "Types",
          impressions: 100,
          approval_status: "APPROVED",
        },
        {
          asset_id: "p1",
          extension_type: "PROMOTION",
          level: "CAMPAIGN",
          campaign_id: "12",
          text: "Sale",
          impressions: 100,
          approval_status: "APPROVED",
          metadata: { percentOff: 15, endDate: "2026-12-31" },
        },
      ],
      // one dynamic search ad search no other campaign covers (SK10 judged, clean)
      dsaSearchTerms: [
        searchTerm({ campaignId: "11", adGroupId: "21", term: "waterproof trail boots", cost: 20 }),
      ],
      landingPageViews: [
        {
          url: "https://example.com/collections/boots",
          cost: 9000,
          clicks: 3000,
          impressions: 60000,
          conversions: 120,
          conversion_value: 24000,
        },
      ],
    },
    tables: {
      conversion_action_daily: dailyRows("61", 90),
      campaign_control_settings: [
        { campaign_id: "11", view_through_conversions: 2, all_conversions: 270 },
        { campaign_id: "12", view_through_conversions: 1, all_conversions: 180 },
      ],
      conversion_value_by_rule: [],
      campaign_negatives: [],
      campaign_negatives_sync_marker: [{ campaign_id: "11" }, { campaign_id: "12" }],
      account_negative_criteria: [],
      temporal_grid: [
        {
          campaign_id: "11",
          day_of_week: "MONDAY",
          hour_of_day: 9,
          cost: 300,
          clicks: 100,
          impressions: 2000,
          conversions: 4,
          conversion_value: 800,
        },
      ],
    },
    syncedEmpty: [
      "biddingStrategies",
      "simulations",
      "biddingOverrides",
      "experimentArms",
      "accountNegatives",
    ],
  });
  const named: Array<[string, number]> = [
    ["conversion_action_daily", 90],
    ["campaign_control_settings", 2],
    ["conversion_value_by_rule", 0],
    ["campaign_negatives", 0],
    ["campaign_negatives_sync_marker", 2],
    ["account_negative_criteria", 0],
    ["temporal_grid", 1],
    ["conversion_tracking_settings", 1],
  ];
  return {
    ...input,
    statusRows: [
      ...(input.statusRows ?? []),
      ...named.map(([table_name, row_count]) => ({
        table_name,
        status: "ok",
        row_count,
        error_message: null,
      })),
    ],
  };
}

/**
 * What each check really reads, written by hand from the check code (its gates,
 * its metrics, the model joins), never computed from `dependsOn`.
 */
const HAND_DEPS: Readonly<Record<string, readonly string[]>> = {
  BB01: ["campaigns", "campaignDailyMetrics", "dailyMetrics", "campaignBudgets"],
  BB02: ["campaigns", "impressionShare", "dailyMetrics"],
  BB03: ["campaigns", "impressionShare", "dailyMetrics"],
  BB04: ["campaigns", "campaignDailyMetrics", "dailyMetrics"],
  BB05: ["campaigns", "campaignDailyMetrics", "dailyMetrics", "campaignBudgets"],
  BB06: ["campaigns", "campaignDailyMetrics", "dailyMetrics"],
  BB07: ["campaigns", "impressionShare", "campaignDailyMetrics", "dailyMetrics", "campaignBudgets"],
  BB08: ["campaigns", "biddingStrategies", "dailyMetrics"],
  // the bidding bases hold a location adjustment, so its location performance counts too
  BB09: ["campaigns", "bidModifiers", "deviceData", "geographicData", "dailyMetrics"],
  BB10: ["campaigns", "simulations", "dailyMetrics"],
  BB11: ["campaigns", "biddingOverrides", "dailyMetrics"],
  BB14: ["campaigns", "dailyMetrics"],
  BB15: ["campaigns", "searchTerms", "keywords", "adGroups", "dailyMetrics"],
  // BB16 reads the share lost to budget (C.lost_is_budget_pct) to decide "budget-limited"
  BB16: [
    "campaigns",
    "campaignDailyMetrics",
    "changeHistory",
    "impressionShare",
    "dailyMetrics",
    "campaignBudgets",
  ],
  BB17: ["campaigns", "changeHistory", "dailyMetrics"],
  SK01: ["keywords", "adGroups", "campaigns", "dailyMetrics"],
  SK02: ["keywords", "adGroups", "campaigns", "dailyMetrics"],
  SK03: ["keywords", "adGroups", "campaigns", "dailyMetrics"],
  SK04: ["keywords", "adGroups", "campaigns", "dailyMetrics"],
  SK05: ["searchTerms", "adGroups", "campaigns", "dailyMetrics"],
  // measurement: the actions, their daily series and settings; the window is dailyMetrics
  MI01: ["conversion_action_daily", "conversionActions", "dailyMetrics"],
  MI03: ["conversionActions", "dailyMetrics"],
  MI04: ["conversionValueRules", "dailyMetrics"],
  MI05: ["conversionActions", "dailyMetrics"],
  MI06: ["campaign_control_settings", "campaigns", "dailyMetrics"],
  MI07: ["campaignConversionGoals", "customerConversionGoals", "campaigns", "dailyMetrics"],
  MI08: ["conversionActions", "dailyMetrics"],
  MI09: ["dailyMetrics"],
  MI10: ["conversionTrackingSettings", "dailyMetrics"],
  MI11: ["conversionTrackingSettings", "dailyMetrics"],
  MI12: ["offlineUserDataJobs", "dailyMetrics"],
  MI14: ["conversionValueRules", "dailyMetrics"],
  MI16: ["conversionActions", "dailyMetrics"],
  // a quiet run is judged by the Smart Bidding campaigns' daily clicks; an exclusion can cover it
  MI18: [
    "conversion_action_daily",
    "conversionActions",
    "campaigns",
    "campaignDailyMetrics",
    "biddingOverrides",
    "dailyMetrics",
  ],
  // structure
  AS01: ["campaigns", "dailyMetrics"],
  AS02: ["campaigns", "dailyMetrics"],
  AS03: ["campaignBudgets", "campaigns", "impressionShare", "dailyMetrics"],
  AS04: ["recommendationSubscriptions", "dailyMetrics"],
  AS06: ["experiments", "dailyMetrics"],
  AS07: ["account_negative_criteria", "campaigns", "dailyMetrics"],
  AS08: ["sharedNegativeLists", "dailyMetrics"],
  AS09: ["audienceLists", "dailyMetrics"],
  AS10: ["customerUserAccess", "dailyMetrics"],
  AS13: ["changeHistory", "dailyMetrics"],
  AS14: ["changeHistory", "dailyMetrics"],
  AS15: ["account_negative_criteria", "campaigns", "dailyMetrics"],
  AS16: ["campaigns", "campaignDailyMetrics", "dailyMetrics"],
  AS17: ["campaigns", "adExtensions", "keywords", "adGroups", "dailyMetrics"],
  // search: every level of negatives can block a search or a keyword
  SK06: [
    "searchTerms",
    "accountNegatives",
    "sharedNegativeLists",
    "sharedNegativeListMembers",
    "campaign_negatives",
    "campaign_negatives_sync_marker",
    "adGroups",
    "campaigns",
    "dailyMetrics",
  ],
  SK07: ["searchTerms", "adGroups", "campaigns", "dailyMetrics"],
  SK08: ["searchTerms", "keywords", "adGroups", "campaigns", "dailyMetrics"],
  SK09: ["searchTerms", "keywords", "adGroups", "campaigns", "dailyMetrics"],
  SK10: ["dsaSearchTerms", "searchTerms", "adGroups", "campaigns", "dailyMetrics"],
  SK11: ["ads", "adGroups", "campaigns", "dailyMetrics"],
  SK12: ["ads", "adGroups", "campaigns", "dailyMetrics"],
  SK13: ["ads", "adGroups", "campaigns", "dailyMetrics"],
  SK14: ["assetPerformance", "ads", "adGroups", "campaigns", "dailyMetrics"],
  SK15: ["adPolicyData", "ads", "adGroups", "campaigns", "dailyMetrics"],
  SK16: ["adExtensions", "adGroups", "campaigns", "dailyMetrics"],
  SK17: ["adExtensions", "adGroups", "campaigns", "dailyMetrics"],
  SK18: ["adExtensions", "campaigns", "dailyMetrics"],
  SK19: ["landingPageViews", "dailyMetrics"],
  SK20: ["landingPageViews", "campaigns", "dailyMetrics"],
  SK21: ["landingPageViews", "dailyMetrics"],
  SK22: ["temporal_grid", "campaigns", "dailyMetrics"],
  SK26: ["adExtensions", "campaigns", "dailyMetrics"],
  SK27: ["searchTerms", "adGroups", "campaigns", "dailyMetrics"],
  SK28: ["searchTerms", "adGroups", "campaigns", "dailyMetrics"],
  SK30: ["searchTerms", "ads", "adGroups", "campaigns", "dailyMetrics"],
  SK32: ["campaigns", "dailyMetrics"],
  SK33: [
    "keywords",
    "campaign_negatives",
    "campaign_negatives_sync_marker",
    "sharedNegativeLists",
    "sharedNegativeListMembers",
    "accountNegatives",
    "adGroups",
    "campaigns",
    "dailyMetrics",
  ],
  SK35: ["searchTerms", "adGroups", "campaigns", "dailyMetrics"],
  // wave 2: Performance Max (asset groups hang off campaigns, their rows off the groups)
  PX01: ["pmaxChannelDistribution", "campaigns", "dailyMetrics"],
  PX02: ["pmaxSearchInsights", "pmaxSearchTerms", "campaigns", "dailyMetrics"],
  PX03: ["assetGroups", "pmaxAssets", "campaigns", "dailyMetrics"],
  PX06: ["pmaxSignals", "assetGroups", "campaigns", "dailyMetrics"],
  PX08: ["campaign_control_settings", "campaigns", "dailyMetrics"],
  PX09: ["assetGroups", "pmaxAssets", "campaigns", "dailyMetrics"],
  PX10: ["campaign_control_settings", "campaigns", "dailyMetrics"],
  PX12: ["pmaxSearchInsights", "keywords", "searchTerms", "adGroups", "campaigns", "dailyMetrics"],
  PX13: ["assetGroups", "pmaxAssets", "campaigns", "dailyMetrics"],
  PX14: ["assetGroups", "campaigns", "dailyMetrics"],
  PX17: ["assetGroups", "pmaxAssets", "campaigns", "dailyMetrics"],
  PX18: ["assetGroups", "pmaxListingGroups", "campaigns", "dailyMetrics"],
  PX19: ["pmax_placements", "account_negative_criteria", "campaigns", "dailyMetrics"],
  PX20: ["campaign_control_settings", "campaigns", "dailyMetrics"],
  PX21: [
    "sharedNegativeLists",
    "sharedNegativeListMembers",
    "campaign_negatives",
    "campaign_negatives_sync_marker",
    "accountNegatives",
    "pmaxSearchTerms",
    "campaigns",
    "dailyMetrics",
  ],
  // trends
  TR01: ["campaigns", "campaignDailyMetrics", "dailyMetrics"],
  TR01a: ["campaigns", "campaignDailyMetrics", "dailyMetrics"],
  TR02: ["dailyMetrics"],
  TR03: ["changeHistory", "campaigns", "dailyMetrics"],
  TR04: ["account_daily_prior_year", "dailyMetrics"],
  TR05: ["campaigns", "campaignDailyMetrics", "dailyMetrics"],
  TR06: ["campaigns", "dailyMetrics"],
  TR07: ["campaigns", "dailyMetrics"],
  TR08: ["campaigns", "dailyMetrics"],
  TR09: ["campaigns", "campaignDailyMetrics", "dailyMetrics"],
  TR10: ["campaigns", "dailyMetrics"],
  // slices
  SL01: ["campaignAudiencePerf", "campaigns", "dailyMetrics"],
  SL02: [
    "audienceLists",
    "campaignAudiencePerf",
    "pmaxSignals",
    "assetGroups",
    "campaigns",
    "dailyMetrics",
  ],
  SL04: ["campaigns", "dailyMetrics"],
  SL05: ["deviceData", "campaigns", "dailyMetrics"],
  SL06: ["deviceData", "campaigns", "dailyMetrics"],
  SL07: ["demographicData", "campaigns", "dailyMetrics"],
  SL09: ["deviceData", "campaigns", "dailyMetrics"],
  // presence and carried-in
  PR01: ["campaign_control_settings", "campaigns", "dailyMetrics"],
  PR02: ["campaigns", "dailyMetrics"],
  MI13: ["conversionActions", "dailyMetrics"],
  AS12: ["campaigns", "dailyMetrics"],
  BB12: ["impressionShare", "campaigns", "dailyMetrics"],
  BB13: ["changeHistory", "campaigns", "dailyMetrics"],
  SK23: ["keywords", "searchTerms", "adGroups", "campaigns", "dailyMetrics"],
  SK24: ["campaigns", "dailyMetrics"],
  SK25: ["keywords", "adGroups", "campaigns", "dailyMetrics"],
  // wave 3: Shopping (the product rows, the Google Ads product list, the Shopping settings)
  SH01: ["shoppingProductsData", "dailyMetrics"],
  SH02: ["mcAccountIssues", "dailyMetrics"],
  SH03: ["products", "dailyMetrics"],
  SH04: ["products", "campaigns", "dailyMetrics"],
  SH05: ["products", "campaigns", "dailyMetrics"],
  SH06: ["products", "dailyMetrics"],
  SH08: ["mcPromotions", "dailyMetrics"],
  SH09: ["mcShippingSettings", "mcReturnPolicies", "dailyMetrics"],
  SH10: ["shoppingSettings", "campaigns", "dailyMetrics"],
  SH11: ["shoppingCartData", "dailyMetrics"],
  SH12: [
    "products",
    "shoppingProductsData",
    "pmaxListingGroups",
    "assetGroups",
    "shoppingSettings",
    "campaigns",
    "dailyMetrics",
  ],
  SH13: ["products", "dailyMetrics"],
  SH14: ["products", "shoppingProductsData", "dailyMetrics"],
  SH15: ["feedDiagnostics", "products", "shoppingProductsData", "dailyMetrics"],
  SH17: ["shoppingSettings", "campaigns", "dailyMetrics"],
  SH18: ["products", "dailyMetrics"],
  SH19: [
    "products",
    "shoppingProductsData",
    "products_catalog",
    "mcSyncStatus",
    "pmaxListingGroups",
    "assetGroups",
    "campaigns",
    "dailyMetrics",
  ],
  SH20: ["products", "dailyMetrics"],
  SH21: ["campaigns", "dailyMetrics"],
  SH22: ["mcPromotions", "dailyMetrics"],
  SH23: ["products", "shoppingProductsData", "campaigns", "dailyMetrics"],
  SH24: ["campaigns", "dailyMetrics"],
  // wave 3: Performance Max products and paid places
  PX05: ["pmax_campaign_products", "campaigns", "dailyMetrics"],
  PX07: ["placement_performance", "account_placement_exclusions", "campaigns", "dailyMetrics"],
  PX11: [
    "pmaxListingGroups",
    "assetGroups",
    "products",
    "shoppingProductsData",
    "campaigns",
    "dailyMetrics",
  ],
  PX15: [
    "assetGroups",
    "pmaxListingGroups",
    "products_catalog",
    "mcSyncStatus",
    "campaigns",
    "dailyMetrics",
  ],
  PX16: ["placement_performance", "account_placement_exclusions", "campaigns", "dailyMetrics"],
  // wave 3: countries (where people were) and languages
  SL03: ["geo_countries", "campaigns", "dailyMetrics"],
  SL10: ["geo_countries", "campaigns", "dailyMetrics"],
  SL11: ["geo_countries", "shoppingSettings", "campaigns", "dailyMetrics", "shoppingProductsData"],
  SL12: ["campaign_languages", "shop_languages", "campaigns", "dailyMetrics"],
  // wave 3: Local Services (the campaign row says whether the account runs it)
  PR03: ["lsaLeads", "campaigns", "dailyMetrics"],
  PR04: ["lsaLeads", "campaigns", "dailyMetrics"],
  PR05: ["lsaLeads", "campaigns", "dailyMetrics"],
  PR06: ["lsaConversations", "campaigns", "dailyMetrics"],
  PR07: ["lsaVerifications", "campaigns", "dailyMetrics"],
  // wave 3: video
  VD01: ["video_campaign_metrics", "campaigns", "dailyMetrics"],
  VD02: ["video_campaign_metrics", "campaigns", "dailyMetrics"],
  VD03: ["campaigns", "dailyMetrics"],
  VD04: ["campaign_control_settings", "campaigns", "dailyMetrics"],
  VD05: ["campaigns", "dailyMetrics"],
  VD06: ["campaigns", "dailyMetrics"],
  VD07: ["video_campaign_metrics", "campaigns", "dailyMetrics"],
  // wave 3: Demand Gen
  DG01: ["dg_campaign_settings", "campaignConversionGoals", "campaigns", "dailyMetrics"],
  DG02: ["dg_assets", "campaigns", "dailyMetrics"],
  DG03: ["dg_audience_signals", "campaigns", "dailyMetrics"],
  DG04: ["dg_channel_distribution", "dg_channel_controls", "campaigns", "dailyMetrics"],
  DG06: ["dg_campaign_settings", "campaigns", "dailyMetrics"],
};

const DAMAGEABLE = [
  "campaigns",
  "adGroups",
  "keywords",
  "searchTerms",
  "campaignDailyMetrics",
  "dailyMetrics",
  "impressionShare",
  "campaignBudgets",
  "changeHistory",
  "biddingStrategies",
  "simulations",
  "biddingOverrides",
  "bidModifiers",
  "deviceData",
  "geographicData",
  "conversionActions",
  "campaignConversionGoals",
  "customerConversionGoals",
  "conversionValueRules",
  "recommendationSubscriptions",
  "experiments",
  "experimentArms",
  "sharedNegativeLists",
  "sharedNegativeListMembers",
  "accountNegatives",
  "audienceLists",
  "customerUserAccess",
  "offlineUserDataJobs",
  "ads",
  "adPolicyData",
  "assetPerformance",
  "adExtensions",
  "landingPageViews",
  "dsaSearchTerms",
  "assetGroups",
  "pmaxAssets",
  "pmaxSignals",
  "pmaxListingGroups",
  "pmaxChannelDistribution",
  "pmaxSearchInsights",
  "pmaxSearchTerms",
  "campaignAudiencePerf",
  "demographicData",
  // the engine's named tables (EvidenceInput.tables) and the one-row tracking settings
  "conversion_action_daily",
  "campaign_control_settings",
  "conversion_value_by_rule",
  "campaign_negatives",
  "campaign_negatives_sync_marker",
  "account_negative_criteria",
  "temporal_grid",
  "pmax_placements",
  "account_daily_prior_year",
  "conversionTrackingSettings",
  // wave 3
  "products",
  "shoppingProductsData",
  "shoppingSettings",
  "shoppingCartData",
  "mcSyncStatus",
  "lsaLeads",
  "lsaConversations",
  "lsaVerifications",
  "products_catalog",
  "shop_languages",
  "pmax_campaign_products",
  "placement_performance",
  "account_placement_exclusions",
  "geo_countries",
  "campaign_languages",
  "video_campaign_metrics",
  "dg_campaign_settings",
  "dg_assets",
  "dg_audience_signals",
  "dg_channel_distribution",
  "dg_channel_controls",
] as const;
const NAMED_TABLES: ReadonlySet<string> = new Set([
  "conversion_action_daily",
  "campaign_control_settings",
  "conversion_value_by_rule",
  "campaign_negatives",
  "campaign_negatives_sync_marker",
  "account_negative_criteria",
  "temporal_grid",
  "pmax_placements",
  "account_daily_prior_year",
  "products_catalog",
  "shop_languages",
  "pmax_campaign_products",
  "placement_performance",
  "account_placement_exclusions",
  "geo_countries",
  "campaign_languages",
  "video_campaign_metrics",
  "dg_campaign_settings",
  "dg_assets",
  "dg_audience_signals",
  "dg_channel_distribution",
  "dg_channel_controls",
]);
/**
 * The newest jobs by design: reading exactly the limit is a full read (the engine knows), so a
 * row limit equal to the rows is no damage to them.
 */
const TOP_N_BY_DESIGN: ReadonlySet<string> = new Set(["offlineUserDataJobs"]);
/** One account row, not a table: only its read status can be damaged. */
const STATUS_ONLY: Readonly<Record<string, string>> = {
  conversionTrackingSettings: "conversion_tracking_settings",
};
const PARENT_FIELD: Partial<Record<(typeof DAMAGEABLE)[number], string>> = {
  adGroups: "campaign_id",
  keywords: "ad_group_id",
  searchTerms: "ad_group_id",
  impressionShare: "campaign_id",
  campaignDailyMetrics: "campaign_id",
  bidModifiers: "campaign_id",
  deviceData: "campaign_id",
  geographicData: "campaign_id",
  campaignConversionGoals: "campaign_id",
  ads: "ad_group_id",
  adPolicyData: "ad_id",
  dsaSearchTerms: "ad_group_id",
  campaign_control_settings: "campaign_id",
  temporal_grid: "campaign_id",
  assetGroups: "campaign_id",
  pmaxAssets: "asset_group_id",
  pmaxSignals: "asset_group_id",
  pmaxListingGroups: "asset_group_id",
  pmaxChannelDistribution: "campaign_id",
  pmaxSearchInsights: "campaign_id",
  pmaxSearchTerms: "campaign_id",
  campaignAudiencePerf: "campaign_id",
  demographicData: "campaign_id",
  pmax_placements: "campaign_id",
  shoppingSettings: "campaign_id",
  pmax_campaign_products: "campaign_id",
  placement_performance: "campaign_id",
  geo_countries: "campaign_id",
  campaign_languages: "campaign_id",
  video_campaign_metrics: "campaign_id",
  dg_campaign_settings: "campaign_id",
  dg_assets: "campaign_id",
  dg_audience_signals: "campaign_id",
  dg_channel_distribution: "campaign_id",
  dg_channel_controls: "campaign_id",
};
const LEGACY_COLUMN_OF: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_COUNT_COLUMNS).map(([col, key]) => [key, col]),
);

type Damage = { table: (typeof DAMAGEABLE)[number]; kind: string };

function damage(
  input: EvidenceInput,
  r: () => number,
): { input: EvidenceInput; damaged: Damage[] } {
  const data = { ...input.data } as Record<string, unknown>;
  const named: Record<string, unknown> = { ...(input.tables ?? {}) };
  let statusRows = [...(input.statusRows ?? [])] as Row[];
  const caps: Record<string, number> = {};
  const legacyCounts: Record<string, unknown> = {};
  const damaged: Damage[] = [];
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const table = DAMAGEABLE[Math.floor(r() * DAMAGEABLE.length)] ?? "campaigns";
    const name = STATUS_ONLY[table] ?? AUDIT_KEY_TABLE[table] ?? table;
    const store = NAMED_TABLES.has(table) ? named : data;
    const all = STATUS_ONLY[table] ? [] : ((store[table] as Array<Row | null> | undefined) ?? []);
    // damage only ever adds to earlier damage: junk rows stay, real rows are what can be dropped
    const junk = all.filter((x) => x == null);
    const rows = all.filter((x): x is Row => x != null);
    const kinds = STATUS_ONLY[table]
      ? ["failed", "not_allowed", "skipped", "noStatus", "duplicateStatus"]
      : [
          "drop",
          "badCount",
          "failed",
          "not_allowed",
          "skipped",
          "noStatus",
          ...(TOP_N_BY_DESIGN.has(table) ? [] : ["cap", "tableNameCap"]),
          "junkRow",
          "duplicateStatus",
          ...(PARENT_FIELD[table] && rows.length > 0 ? ["orphan"] : []),
          ...(LEGACY_COLUMN_OF[table] && rows.length > 0 ? ["shortLegacyCount"] : []),
        ];
    const kind = kinds[Math.floor(r() * kinds.length)] ?? "drop";
    if ((kind === "drop" || kind === "cap" || kind === "tableNameCap") && rows.length === 0)
      continue;
    const setStatus = (patch: Row) => {
      statusRows = statusRows.map((s) => (s.table_name === name ? { ...s, ...patch } : s));
    };
    switch (kind) {
      case "drop":
        rows.splice(Math.floor(r() * rows.length), 1);
        store[table] = [...rows, ...junk];
        break;
      case "badCount":
        setStatus({ row_count: ["many", -1, 2.5][Math.floor(r() * 3)] });
        break;
      case "failed":
      case "not_allowed":
      case "skipped":
        setStatus({ status: kind });
        break;
      case "noStatus":
        statusRows = statusRows.filter((s) => s.table_name !== name);
        break;
      case "cap":
        caps[table] = rows.length;
        break;
      case "tableNameCap":
        // the same limit under the table name instead of the data key
        caps[name] = rows.length;
        break;
      case "duplicateStatus": {
        // a second status row for the table that says it failed: the worse one must win
        const first = statusRows.find((x) => x.table_name === name);
        statusRows = [
          ...statusRows,
          { table_name: name, status: "failed", row_count: first?.row_count ?? 0 },
        ];
        if (first) statusRows = [...statusRows.filter((x) => x !== first), first];
        break;
      }
      case "shortLegacyCount":
        // no status row; the legacy count column says one more row exists than was provided
        statusRows = statusRows.filter((x) => x.table_name !== name);
        legacyCounts[LEGACY_COLUMN_OF[table] ?? ""] = rows.length + 1;
        break;
      case "junkRow":
        store[table] = [...rows, ...junk, null];
        break;
      case "orphan": {
        const k = Math.floor(r() * rows.length);
        rows[k] = { ...rows[k], [PARENT_FIELD[table] ?? "campaign_id"]: "missing" };
        store[table] = [...rows, ...junk];
        break;
      }
    }
    damaged.push({ table, kind });
  }
  return {
    input: {
      ...input,
      data: data as EvidenceInput["data"],
      tables: named as EvidenceInput["tables"],
      statusRows,
      caps,
      legacyCounts,
    },
    damaged,
  };
}

/**
 * Wave-2 base: a Performance Max campaign with every PMax table read, a brand and a
 * generic Search campaign, a Display campaign, device / audience / age rows and the
 * year-ago series, set up so most of the wave-2 checks are clean.
 */
function wave2Account(): EvidenceInput {
  const groupRow = (id: string, cost: number, conv: number, value: number): Row => ({
    asset_group_id: id,
    campaign_id: "41",
    name: `Group ${id}`,
    status: "ENABLED",
    ad_strength: "EXCELLENT",
    cost,
    clicks: 600,
    impressions: 12_000,
    conversions: conv,
    conversion_value: value,
  });
  const assetRows = (groupId: string, field: string, n: number): Row[] =>
    Array.from({ length: n }, (_, i) => ({
      asset_group_id: groupId,
      asset_id: `${groupId}${field}${i}`,
      field_type: field,
      asset_text: field.includes("IMAGE") || field === "YOUTUBE_VIDEO" ? null : `text ${i}`,
      status: "ENABLED",
      primary_status: "ELIGIBLE",
      image_width_px: field.includes("IMAGE") ? 1200 : null,
      image_height_px: field.includes("IMAGE") ? 1200 : null,
    }));
  const fullSet = (g: string): Row[] => [
    ...assetRows(g, "HEADLINE", 11),
    ...assetRows(g, "LONG_HEADLINE", 5),
    ...assetRows(g, "DESCRIPTION", 4),
    ...assetRows(g, "YOUTUBE_VIDEO", 1),
    ...assetRows(g, "MARKETING_IMAGE", 5),
    ...assetRows(g, "SQUARE_MARKETING_IMAGE", 5),
    ...assetRows(g, "PORTRAIT_MARKETING_IMAGE", 5),
  ];
  const signalRows = (g: string): Row[] => [
    { asset_group_id: g, search_theme: "trail shoes", approval_status: "APPROVED" },
    {
      asset_group_id: g,
      audience: "customers/1234567890/audiences/77",
      approval_status: "APPROVED",
    },
  ];
  const device = (c: string, d: string): Row => ({
    campaign_id: c,
    device: d,
    cost: 4000,
    clicks: 1500,
    impressions: 30_000,
    conversions: 80,
    conversion_value: 16_000,
  });
  const input = buildInput({
    campaigns: [
      {
        id: "41",
        name: "PMax all products",
        type: "PERFORMANCE_MAX",
        cost: 100,
        conv: 2,
        value: 400,
      },
      {
        id: "11",
        name: "Generic search",
        cost: 100,
        conv: 2,
        value: 400,
        is: { share: 0.6 },
        extra: { geo_target_type: "PRESENCE" },
      },
      {
        id: "12",
        name: "Brand search",
        cost: 10,
        conv: 1,
        value: 200,
        clicks: 50,
        impressions: 200,
        is: { share: 0.9 },
      },
      { id: "61", name: "Display remarketing", type: "DISPLAY", cost: 5, conv: 0.2, value: 40 },
    ],
    profile: { businessType: "ecommerce", brandTerms: ["acme"] },
    data: {
      assetGroups: [groupRow("51", 7000, 140, 28_000), groupRow("52", 2000, 40, 8_000)],
      pmaxAssets: [...fullSet("51"), ...fullSet("52")],
      pmaxSignals: [...signalRows("51"), ...signalRows("52")],
      pmaxListingGroups: [
        {
          asset_group_id: "51",
          listing_group_id: "1",
          parent_listing_group_id: null,
          type: "SUBDIVISION",
          case_value: "{}",
        },
        {
          asset_group_id: "51",
          listing_group_id: "2",
          parent_listing_group_id: "51~1",
          type: "UNIT_INCLUDED",
          case_value: JSON.stringify({ productType: { level: "LEVEL1", value: "boots" } }),
        },
        {
          asset_group_id: "51",
          listing_group_id: "3",
          parent_listing_group_id: "51~1",
          type: "UNIT_INCLUDED",
          case_value: JSON.stringify({ productType: { level: "LEVEL1" } }),
        },
      ],
      pmaxChannelDistribution: [
        {
          campaign_id: "41",
          ad_network_type: "SEARCH",
          cost: 7000,
          clicks: 900,
          impressions: 9000,
          conversions: 150,
          conversion_value: 30_000,
        },
        {
          campaign_id: "41",
          ad_network_type: "CONTENT",
          cost: 2000,
          clicks: 300,
          impressions: 30_000,
          conversions: 30,
          conversion_value: 6_000,
        },
      ],
      pmaxSearchInsights: [
        {
          campaign_id: "41",
          category_label: "rain coats",
          clicks: 300,
          impressions: 6000,
          conversions: 5,
          conversions_value: 1000,
        },
        {
          campaign_id: "41",
          category_label: "acme coats",
          clicks: 10,
          impressions: 200,
          conversions: 1,
          conversions_value: 200,
        },
      ],
      adGroups: [adGroup({ id: "21", campaignId: "11" }), adGroup({ id: "22", campaignId: "12" })],
      keywords: [
        keyword({
          id: "31",
          campaignId: "11",
          adGroupId: "21",
          text: "trail shoes",
          cost: 300,
          clicks: 100,
          conv: 5,
        }),
        keyword({
          id: "32",
          campaignId: "12",
          adGroupId: "22",
          text: "acme",
          cost: 30,
          clicks: 50,
          conv: 3,
        }),
      ],
      searchTerms: [
        {
          ...searchTerm({
            campaignId: "11",
            adGroupId: "21",
            term: "trail shoes men",
            cost: 50,
            clicks: 20,
            conv: 2,
          }),
          keyword_criterion_id: "31",
        },
        {
          ...searchTerm({
            campaignId: "12",
            adGroupId: "22",
            term: "acme shop",
            cost: 10,
            clicks: 10,
            conv: 1,
          }),
          keyword_criterion_id: "32",
        },
      ],
      deviceData: ["MOBILE", "DESKTOP"].flatMap((d) => [device("11", d), device("41", d)]),
      campaignAudiencePerf: [
        {
          campaign_id: "11",
          criterion_id: "701",
          user_list_id: "950",
          audience_type: "USER_LIST",
          cost: 1000,
          clicks: 400,
          impressions: 8000,
          conversions: 20,
          conversion_value: 4000,
        },
      ],
      audienceLists: [
        {
          list_id: "950",
          list_name: "All purchasers",
          list_type: "RULE_BASED",
          membership_status: "OPEN",
          size_for_search: 5000,
          size_for_display: 8000,
        },
      ],
      demographicData: [
        {
          campaign_id: "11",
          demographic_type: "AGE_RANGE",
          demographic_value: "AGE_RANGE_25_34",
          cost: 1000,
          clicks: 400,
          impressions: 8000,
          conversions: 20,
          conversion_value: 4000,
        },
      ],
      conversionActions: [
        {
          action_id: "61",
          name: "Purchase",
          status: "ENABLED",
          category: "PURCHASE",
          counting_type: "MANY_PER_CLICK",
          primary_for_goal: true,
          type: "WEBPAGE",
        },
      ],
      changeHistory: [
        {
          change_resource_name: "customers/1/campaigns/11",
          change_date_time: `${dayBefore(LAST_DAY, 5)} 10:00:00`,
          changed_fields: "maximize_conversion_value.target_roas",
          changed_values: { "maximizeConversionValue.targetRoas": { old: 4, new: 4.2 } },
          operation: "UPDATE",
          client_type: "GOOGLE_ADS_WEB_CLIENT",
          resource_type: "CAMPAIGN",
        },
      ],
      impressionShare: [
        {
          campaign_id: "11",
          search_impression_share: 0.6,
          search_absolute_top_impression_share: 0.5,
          search_budget_lost_impression_share: 0,
          search_rank_lost_impression_share: 0.1,
        },
        {
          campaign_id: "12",
          search_impression_share: 0.9,
          search_absolute_top_impression_share: 0.8,
          search_budget_lost_impression_share: 0,
          search_rank_lost_impression_share: 0.05,
        },
      ],
    },
    tables: {
      campaign_control_settings: [
        {
          campaign_id: "41",
          asset_automation: JSON.stringify([
            {
              asset_automation_type: "GENERATE_IMAGE_EXTRACTION",
              asset_automation_status: "OPTED_OUT",
            },
            {
              asset_automation_type: "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION",
              asset_automation_status: "OPTED_OUT",
            },
          ]),
          url_exclusions: "[]",
        },
        { campaign_id: "61", frequency_caps: "[{}]", frequency_caps_state: "set" },
      ],
      pmax_placements: [
        {
          campaign_id: "41",
          placement: "example.com",
          placement_type: "WEBSITE",
          display_name: "example.com",
          target_url: "example.com",
          impressions: 5000,
        },
      ],
      campaign_negatives: [
        { campaign_id: "41", criterion_id: "9", text: "jobs", match_type: "BROAD" },
      ],
      campaign_negatives_sync_marker: [
        { campaign_id: "41" },
        { campaign_id: "11" },
        { campaign_id: "12" },
      ],
      account_negative_criteria: [],
      account_daily_prior_year: Array.from({ length: 90 }, (_, i) => ({
        metric_date: dayBefore(dayBefore(LAST_DAY, i), 364),
        cost: 215,
        conversions: 4.2,
        conversion_value: 1040,
      })),
    },
    syncedEmpty: ["sharedNegativeLists", "accountNegatives", "pmaxSearchTerms"],
  });
  const named: Array<[string, number]> = [
    ["campaign_control_settings", 2],
    ["pmax_placements", 1],
    ["campaign_negatives", 1],
    ["campaign_negatives_sync_marker", 3],
    ["account_negative_criteria", 0],
    ["account_daily_prior_year", 90],
  ];
  return {
    ...input,
    statusRows: [
      ...(input.statusRows ?? []),
      ...named.map(([table_name, row_count]) => ({
        table_name,
        status: "ok",
        row_count,
        error_message: null,
      })),
    ],
  };
}

const BASES: Array<{ name: string; make: () => EvidenceInput; minClean: number }> = [
  { name: "general", make: cleanAccount, minClean: 8 },
  { name: "wave 1 account checks", make: wave1Account, minClean: 45 },
  { name: "bidding, clean", make: () => biddingAccount(false), minClean: 5 },
  { name: "bidding, firing", make: () => biddingAccount(true), minClean: 3 },
  { name: "wave 2 checks", make: wave2Account, minClean: 25 },
  { name: "wave 3 shop", make: () => shoppingAccount(), minClean: 12 },
  { name: "wave 3 shop, firing", make: () => shopFiring(), minClean: 1 },
  { name: "wave 3 video", make: () => videoAccount(), minClean: 4 },
  { name: "wave 3 local services", make: () => lsaAccount(), minClean: 4 },
  { name: "wave 3 Demand Gen", make: () => demandGenAccount(), minClean: 4 },
];

/** The shop with its signals on: overlaps, a loser, a placement, a country and a language off. */
function shopFiring(): EvidenceInput {
  return shoppingAccount({
    shoppingFeedLabel: "US",
    overlappingGroups: true,
    products: [...PRODUCTS, { id: "sku-9", cost: 400, conv: 0, value: 0 }],
    countries: [country("11", "2840", "US", 900), country("11", "2124", "CA", 600, { value: 60 })],
    campaignLanguages: [
      { campaign_id: "71", criterion_id: "1", language_code: "de", status: "ENABLED" },
    ],
  });
}

describe("property: completeness damage never produces a clean result", () => {
  it("the hand-written dependency list names every shipped check, and covers dependsOn", () => {
    const checks = listChecks();
    expect(Object.keys(HAND_DEPS).sort()).toEqual(checks.map((c) => c.id).sort());
    // the engine's own list may not be wider than what the checks really read
    for (const c of checks) expect(HAND_DEPS[c.id]).toEqual(expect.arrayContaining(c.dependsOn));
  });

  it("the bidding bases put BB09, BB16 and BB17 in both states", () => {
    const status = (input: EvidenceInput, id: string) =>
      runChecks(input).checks.find((c) => c.id === id)?.status;
    for (const id of ["BB09", "BB16", "BB17"]) {
      expect([id, status(biddingAccount(false), id)]).toEqual([id, "clean"]);
      // BB17 is a note: it states `info` when it fires
      expect([id, status(biddingAccount(true), id)]).toEqual([
        id,
        id === "BB17" ? "info" : "finding",
      ]);
    }
  });

  for (const base of BASES) {
    describe(`base: ${base.name}`, () => {
      const undamaged = runChecks(base.make());
      const before = new Map(undamaged.checks.map((c) => [c.id, c.status]));

      it("the undamaged account has clean checks to protect", () => {
        expect([...before.values()].filter((s) => s === "clean").length).toBeGreaterThanOrEqual(
          base.minClean,
        );
      });

      it("holds over 300 random damage sets", () => {
        const r = rng(7 + base.minClean);
        for (let trial = 0; trial < 300; trial++) {
          const { input, damaged } = damage(base.make(), r);
          const result = runChecks(input);
          const tables = new Set<string>(damaged.map((d) => d.table));
          for (const c of result.checks) {
            if (c.status !== "clean") continue;
            const hit = (HAND_DEPS[c.id] ?? []).filter((t) => tables.has(t));
            expect({ trial, check: c.id, damaged, wasClean: before.get(c.id) === "clean" }).toEqual(
              { trial, check: c.id, damaged, wasClean: true },
            );
            expect({ trial, check: c.id, damaged, hit }).toEqual({
              trial,
              check: c.id,
              damaged,
              hit: [],
            });
          }
        }
      });
    });
  }
});
