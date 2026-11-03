// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";
import type { AdGroupNode } from "./AdGroupNode.js";
import type { AssetGroupNode } from "./AssetGroupNode.js";
import type { AssetNode } from "./AssetNode.js";
import type { AudienceSignalNode } from "./AudienceSignalNode.js";
import type { BidModifierNode } from "./BidModifierNode.js";
import type { ChannelSlice } from "./ChannelSlice.js";
import type { ExtensionNode } from "./ExtensionNode.js";
import type { NegativeListNode } from "./NegativeListNode.js";
import type { PlacementNode } from "./PlacementNode.js";
import type { ProductGroupNode } from "./ProductGroupNode.js";
import type { ProductNode } from "./ProductNode.js";
import type { SearchCategoryNode } from "./SearchCategoryNode.js";
import type { SearchTermNode } from "./SearchTermNode.js";
import type { SliceFamilies } from "./Slice.js";
import type { VideoMetricsNode } from "./VideoMetricsNode.js";
import type { UrlExclusion } from "../../shared/pmaxTypes.js";

export type CampaignType =
  "SEARCH" | "PERFORMANCE_MAX" | "SHOPPING" | "DEMAND_GEN" | "VIDEO" | "DISPLAY" | "OTHER";

export interface ImpressionShareAttrs {
  is: number | null;
  lostBudget: number | null;
  lostRank: number | null;
  top: number | null;
  absoluteTop: number | null;
  exactMatch: number | null;
  /**
   * The window's last weeks (snapshot extra): spend, sales and share lost to budget there.
   * null = not read. lostBudget null with cost 0 = no activity in those weeks.
   */
  recent: {
    start: string | null;
    end: string | null;
    cost: number;
    value: number | null;
    lostBudget: number | null;
  } | null;
  /** which table supplied it; 'none' = no row (PMax / Shopping have no impression_share rows). */
  source: "impression_share" | "campaigns" | "ad_groups" | "keywords" | "none";
}

/** One country row of a campaign (geo_countries). */
export interface CountrySpend {
  /** geo target constant id of the country */
  id: string;
  /** ISO 3166-1 alpha-2, null when not named */
  code: string | null;
  name: string | null;
  /** LOCATION_OF_PRESENCE (people were there) or AREA_OF_INTEREST (people searched about it) */
  locationType: string | null;
  cost: number;
  clicks: number;
  conv: number;
  value: number;
}

/** One ad network's share of a campaign's window (R9). */
export interface NetworkSpend {
  cost: number;
  clicks: number;
  conv: number;
  value: number;
}

export interface CampaignAttrs {
  type: CampaignType;
  rawType: string | null;
  isBrand: boolean;
  strategy: string | null;
  targetRoas: number | null;
  targetCpa: number | null;
  /** portfolio strategy — campaigns table has no strategy id (OPEN QUESTION 3); matched only when a strategy's target equals the campaign's and campaign_count is 1. null = unresolved. */
  portfolioStrategyId: string | null;
  /** Round 4 item 10: the sync's answer 'portfolio' | 'standard' (campaigns.bidding_strategy_source); null = not synced. Optional for hand-built models. */
  biddingStrategySource?: "portfolio" | "standard" | null | undefined;
  /** the portfolio strategy's own type and target (campaigns.portfolio_strategy_type / portfolio_target_roas); null = standard strategy or not synced. Optional for hand-built models. */
  portfolioStrategyType?: string | null | undefined;
  portfolioTargetRoas?: number | null | undefined;
  geoTargetType: string | null;
  /** Round 5: Google's campaign status (campaign.primary_status, e.g. LEARNING); null = not read. Optional for hand-built models. */
  primaryStatus?: string | null | undefined;
  /** Round 5: Google's bidding strategy status (campaign.bidding_strategy_system_status, e.g. LEARNING_NEW); null = not read. Optional for hand-built models. */
  biddingStrategySystemStatus?: string | null | undefined;
  networkSettings: Record<string, unknown> | null;
  /**
   * util90 = cost / (amount × budgetDays); budgetDays = campaign_daily_metrics rows
   * for the campaign, capped at the real window length, never a
   * literal 90; window length when no daily rows. Example: 1000 / (100 × 90) = 0.111.
   */
  budget: {
    id: string | null;
    amount: number | null;
    shared: boolean;
    siblingCampaignIds: string[];
    budgetDays: number | null;
    util90: number | null;
    /** util90 > 1 is legal: Google's monthly cap allows up to 2× the daily amount on any day. */ capNote:
      string | null;
  };
  impressionShare: ImpressionShareAttrs;
  allConversions: number | null;
  allConversionsValue: number | null;
  lastActiveDate: string | null;
  /** null when not read — never coerced to false (G.6). */
  urlExpansionOptOut: boolean | null;
  enableAiMax: boolean | null;
  brandGuidelinesEnabled: boolean | null;
  hasPageFeed: boolean | null;
  pmaxNegativeCount: number | null;
  /** campaign_control_settings row; null = no row for this campaign. */
  /** frequencyCapsState (Round 4 item 9): the sync's 'set' / 'none_returned'; null = column not synced. */
  /** urlExclusions (PMax URL exclusions): negative WEBPAGE criteria; null = not read, [] = read, none set. */
  controlSettings: {
    frequencyCaps: unknown;
    frequencyCapsState?: "set" | "none_returned" | null;
    assetAutomation: unknown;
    viewThroughConversions: number | null;
    /** B13: conversions (no view-through) over the same range; null = not read (older snapshots) */
    conversions?: number | null;
    allConversions: number | null;
    urlExclusions?: UrlExclusion[] | null;
  } | null;
  /**
   * A2: the model no longer carries a view-through SHARE. It used to
   * divide `view_through_conversions` (all-conversions family) by `windows.m90.conv`
   * (the `conversions` column, which EXCLUDES view-through), so the ratio was
   * inflated and could exceed 100%, and it carried no conversion floor. The only
   * definition is now `C.viewthrough_share` in the metric registry (B13: vtc /
   * (conversions + vtc), 10-conversion floor on that total). It stays in the registry rather than here
   * because the registry depends on the model, not the other way round — delegating
   * would be a circular import. The raw inputs live on `controlSettings`.
   */
  /** campaign_conversion_goals rows, compared against customer_conversion_goals. */
  conversionGoals: { category: string; origin: string; biddable: boolean }[];
  conversionGoalsDifferFromCustomer: boolean | null;
  /** per-action totals from campaignConversions — only the actions the sync wrote rows for. */
  conversionsByAction: {
    actionName: string;
    category: string | null;
    isPrimary: boolean | null;
    conv: number | null;
    value: number | null;
  }[];
  /** location_criteria rows for this campaign. */
  geo: {
    targets: number;
    negatives: number;
    withBidModifier: number;
    /** geo target constant ids of the excluded (negative) locations: where it never shows. */
    excluded: string[];
  };
  /** change_history rows whose change_resource_name contains this campaign id (substring join; capped feed → sample). */
  changeHistory: {
    count: number;
    sample: boolean;
    firstDate: string | null;
    lastDate: string | null;
  };
  experimentIds: string[];
  simulationTypes: string[];
  /** shopping_settings row, when one exists. */
  shoppingSettings:
    | {
        state: "synced";
        priority: number | null;
        merchantId: string | null;
        feedLabel: string | null;
        enableLocal: boolean | null;
        channelSubType: string | null;
      }
    | {
        state: "not_synced";
        priority: null;
        merchantId: null;
        feedLabel: null;
        enableLocal: null;
        channelSubType: null;
      };
  /**
   * R3.4a: each product's own cost and sales INSIDE this PMax campaign
   * (pmax_campaign_products, one account query at campaign x product
   * grain). Shopping campaigns too. null = neither; not_checkable = table not
   * loaded, not synced or refused (the note says which) — never "no products".
   * `cutoffCost` = the most spend one product can have outside the kept rows of a
   * capped read (the sync note's cutoff_cost); null = not capped or not known.
   */
  productPerf:
    | {
        state: "synced";
        truncated: boolean;
        cutoffCost?: number | null | undefined;
        rows: CampaignProductPerfRow[];
        /** the products this campaign can show with no row in it (never spent here); absent = not read. */
        unspent?: CampaignProductUnspent[] | undefined;
        /** round 3 (PX15 cover): products shown here in the last 7 days with no row in the window's read; absent = none. */
        recentOnly?: CampaignProductRecentRow[] | undefined;
      }
    | { state: "not_checkable"; note: string }
    | null;
  /**
   * R3.8: where this PMax campaign served (performance_max_placement_view).
   * IMPRESSIONS ONLY — Google reports no cost per PMax placement. Top 200 rows
   * per campaign, first 5 PMax campaigns of the account. null = not PMax (or a
   * model built without the table); not_checkable = not loaded / no marker /
   * failed, or zero rows for this campaign (restricted view or past the limit).
   */
  pmaxPlacements?:
    | {
        state: "synced";
        capped: boolean;
        rows: {
          placement?: string | null;
          placementType: string | null;
          displayName: string | null;
          targetUrl: string | null;
          impressions: number;
        }[];
      }
    | { state: "not_checkable"; note: string }
    | null
    | undefined;
  /**
   * R3.8: the campaign's customer-acquisition goal (campaign_lifecycle_goals).
   * `value` is the campaign's own extra value per new customer; null = it
   * inherits the account default (AccountAttrs.customerAcquisition). Absent /
   * null = no goal row for this campaign, or the table was not loaded.
   */
  customerAcquisition?:
    | { mode: string | null; value: number | null; highLifetimeValue: number | null }
    | null
    | undefined;
  /**
   * Phase 11 (MI17): the campaign's conversions and value split by whether the
   * buyer had bought before (campaign_customer_split, 90-day window;
   * NEW_AND_HIGH_LTV counts as new, UNSPECIFIED as unknown). synced with all
   * zeros = Google returned no split for this campaign. not_synced = table not
   * loaded / no marker / failed. Optional for hand-built models.
   */
  customerSplit?:
    | {
        state: "synced";
        newConv: number;
        newValue: number;
        returningConv: number;
        returningValue: number;
        unknownConv: number;
        unknownValue: number;
      }
    | { state: "not_synced"; note: string }
    | null
    | undefined;
  /**
   * R9 (SK32): what a Search or Standard Shopping campaign spent and sold per ad network
   * over the window (campaign_network_split): Google Search, search partners, the Display
   * Network. null = not read; a campaign with no row had no activity on any network.
   * Optional for hand-built models.
   */
  networkSpend?:
    | {
        google: NetworkSpend;
        partners: NetworkSpend;
        display: NetworkSpend;
      }
    | null
    | undefined;
  /**
   * Phase 11 (SL12): the languages the campaign targets (campaign_languages),
   * as base codes ("en", "zh"). synced + codes [] + unresolved 0 = no language
   * criterion = every language. unresolved = criteria whose code was not read.
   * Optional for hand-built models.
   */
  languages?:
    | { state: "synced"; codes: string[]; unresolved: number }
    | { state: "not_synced"; note: string }
    | null
    | undefined;
  /**
   * The campaign's spend by the COUNTRY people were in or showed interest in
   * (geo_countries, Google's geographic view: the user's location, never the
   * targeted locations of geographicData). null = not read. A country id the
   * country list could not name carries code / name null. Optional for hand-built
   * models.
   */
  countries?: CountrySpend[] | null | undefined;
  /**
   * P3g: brand lists attached to this campaign (campaign_brand_lists,
   * campaign_criterion type BRAND_LIST). Read for PMax and Search only.
   * not_synced = table not loaded / no marker / failed / other campaign type
   * (the note says which) — never "none". synced + [] = no list attached.
   */
  brandExclusions:
    { state: "not_synced"; note?: string } | { state: "synced"; lists: BrandListRef[] };
  /** ENABLED and cost > 0 — the optimizers' historical universe (H.3 #1). */
  inOptimizerScope: boolean;
  /** PMax channel rollup — all three or none. */
  channelShares: {
    shopping: number | null;
    videoDisplay: number | null;
    unclassified: number | null;
  } | null;
  /** Demand Gen settings from dg_campaign_settings when the table was provided; else not_synced. */
  /** R4-D (AS18): negativeUserLists = USER_LIST criteria set as EXCLUDED per ad group, plus the lists excluded inside a new-style Audience (exclusion_dimension); audienceExclusionsUnread = ad groups whose Audience exclusions were not read; adGroupIdsSeen = ad groups any criterion row names. null = the signals table was not read. Optional for hand-built models. */
  demandGen:
    | {
        state: "synced";
        optimizationGoals: string[];
        merchantCenterId: string | null;
        productFeedDisabled: boolean | null;
        feedLabel: string | null;
        negativeAudienceCount: number | null;
        negativeUserLists?:
          | {
              adGroupId: string | null;
              listId: string | null;
              name: string | null;
              customerMatch: boolean;
            }[]
          | null;
        adGroupIdsSeen?: string[] | null;
        audienceExclusionsUnread?: string[] | null;
      }
    | { state: "not_synced" }
    | null;
  /**
   * B12: the ad networks this Demand Gen campaign is ALLOWED to show on, from its live ad
   * groups' channel controls (union; DISCOVER, YOUTUBE, GMAIL, CONTENT). `allowedNetworks`
   * null = every surface. null = the controls were read and name no ad group of this
   * campaign (unknown); absent = not read (hand-built models).
   */
  dgChannelControls?: { allowedNetworks: string[] | null; adGroups: number } | null | undefined;
  adScheduleRows: number;
  /** R4-D review (MI18): campaign_daily_metrics per day (cost, clicks); null = no daily rows for this campaign. Optional for hand-built models. */
  dailyTraffic?: { date: string; cost: number; clicks: number }[] | null | undefined;
}

/** R3.4a: one product's numbers inside one PMax campaign (90-day audit window). */
/** A product the campaign can show that spent nothing in it (buildPmaxTree unspentProductsOf). */
export interface CampaignProductUnspent {
  /** the item id, lowercased */
  offerId: string;
  title: string | null;
  color: string | null;
  itemGroupId: string | null;
}

export interface CampaignProductPerfRow {
  /** toOfferId(product_item_id) — bare, lowercased. */
  offerId: string;
  /** the product-universe node id this row joins (full id or Shopify variant suffix); null = outside the universe. */
  productId: string | null;
  title: string | null;
  customLabels: (string | null)[];
  /** the product's CURRENT feed title (product node); the colour fallback reads it before `title`. */
  feedTitle?: string | null | undefined;
  /** the product's colour (product node, else the catalog); null / absent = unknown. */
  color?: string | null | undefined;
  /** Merchant Center item_group_id when known; null / absent = unknown. */
  itemGroupId?: string | null | undefined;
  /** product type levels 1-2 (the feed's spelling when it reads the same) and Google category level 1. */
  productTypeL1?: string | null | undefined;
  productTypeL2?: string | null | undefined;
  categoryL1?: string | null | undefined;
  cost: number;
  clicks: number;
  impressions: number;
  conv: number;
  value: number;
  /** PX15: impressions in the last 7 days of the window; null / absent = not read. */
  impressions7d?: number | null | undefined;
}

/** A product shown in a campaign in the last 7 days of the window with no row over the window: no money read. */
export interface CampaignProductRecentRow {
  /** toOfferId(product_item_id): bare, lowercased. */
  offerId: string;
  /** the product-universe node id this row joins; null = outside the universe. */
  productId: string | null;
  impressions7d: number;
}

export interface CampaignChildren {
  adGroups: AdGroupNode[];
  /** PMax only; [] elsewhere. */
  assetGroups: AssetGroupNode[];
  /** level=CAMPAIGN extension rows. */
  extensions: ExtensionNode[];
  /** campaign-level negatives: null = not synced for this campaign (no marker), [] = synced, none. Plus the shared / account lists that apply (level != 'campaign'). */
  negatives: NegativeListNode[] | null;
  inheritedNegatives: NegativeListNode[];
  bidModifiers: BidModifierNode[];
  slices: SliceFamilies;
  /** PMax (pmaxChannelDistribution / pmaxChannelData) and Demand Gen (dg_channel_distribution, when provided). */
  channels: ChannelSlice[];
  placements: PlacementNode[];
  /** PMax search insight categories (capped 50/campaign). */
  searchCategories: SearchCategoryNode[];
  /** Shopping partitions — NOT SYNCED (no table): null, never []. */
  productGroups: ProductGroupNode[] | null;
  /** PMax: products reached through included listing groups (deduped). Shopping: products matched by feed label when shopping_settings is synced; [] with notCheckable otherwise. */
  products: ProductNode[];
  /** Shopping campaign-grain term rows from product_search_terms that carry no ad_group_id (Phase 1b: the table holds campaign×term, never product×term). PMax: pmax_search_terms (with cost, 2000 per campaign). */
  searchTerms: SearchTermNode[];
  /** Demand Gen: from dg_video_metrics; Video: from video_campaign_metrics; null when not read. */
  videoMetrics: VideoMetricsNode[] | null;
  /** Demand Gen assets / audience signals (dg_assets / dg_audience_signals); null when not synced. */
  dgAssets: AssetNode[] | null;
  dgAudienceSignals: AudienceSignalNode[] | null;
  /**
   * DG_VIDEO_FRAMEWORK_PLAN phase 2: per Demand Gen video ad, its daily rows
   * (dg_ad_video_daily). null / absent = not synced (migration not
   * applied, older audit): never "no video ads".
   */
  dgAdVideo?: DgAdVideoDaily[] | null | undefined;
}

/** One Demand Gen video ad on one day in one format ('ALL' = every format together). */
export interface DgAdVideoDaily {
  adId: string;
  adGroupId: string | null;
  date: string;
  adFormat: string;
  impressions: number | null;
  clicks: number | null;
  costMicros: number | null;
  conversions: number | null;
  videoViews: number | null;
}

export interface CampaignNode extends BaseNode<"campaign"> {
  attrs: CampaignAttrs;
  children: CampaignChildren;
}

/** P3g: one brand list attached to a campaign. */
export interface BrandListRef {
  criterionId: string;
  /** TRUE = the list excludes these brands (the PMax brand exclusion). */
  negative: boolean;
  /** campaign_criterion status (ENABLED / PAUSED / REMOVED), null when not returned. */
  status: string | null;
  sharedSetId: string | null;
  name: string | null;
  /** null = the list's contents were not read. */
  brandCount: number | null;
  brandNames: string[] | null;
  /** review fix: true = a brand in the list matches the account's brand; false = read in full, none does (e.g. competitors only); null = can't tell. */
  holdsOwnBrand: boolean | null;
}
