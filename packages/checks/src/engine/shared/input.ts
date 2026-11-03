// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The neutral input the check engine reads. A later adapter builds it from an
 * account snapshot; tests build it by hand.
 *
 * Two kinds of rows:
 *   - `AccountData` arrays, keyed by `ACCOUNT_DATA_ARRAY_KEYS` (campaigns,
 *     keywords, search terms ...). An ABSENT key and an empty array both read
 *     as "no rows"; whether a table can be judged is decided by the sync
 *     markers (`statusRows`), never by the row count.
 *   - extra named tables (`tables`, keyed by the internal table name). An
 *     ABSENT key means "not read", an empty array means "read, zero rows".
 *
 * Row fields are snake_case, as the engine reads them (`campaign_id`,
 * `cost`, `conversions`, ...). Rows are untyped on purpose: every reader in
 * the model coerces and null-checks each field it reads.
 */

/** One row of any table. */
export type Row = Record<string, any>;

export const ACCOUNT_DATA_ARRAY_KEYS = [
  "campaigns",
  "adGroups",
  "ads",
  "keywords",
  "searchTerms",
  "conversionActions",
  "deviceData",
  "geographicData",
  "locationCriteria",
  "assetGroups",
  "adExtensions",
  "impressionShare",
  "demographicData",
  "temporalData",
  "dailyMetrics",
  "products",
  "pmaxChannelData",
  "audienceLists",
  "feedDiagnostics",
  "landingPageViews",
  "adPolicyData",
  "changeHistory",
  "sharedNegativeLists",
  "audiencePerformance",
  "recommendationSubscriptions",
  "campaignBudgets",
  "assetPerformance",
  "callData",
  "biddingStrategies",
  "bidModifiers",
  "adSchedulePerformance",
  "accountNegatives",
  "paidOrganicData",
  "lsaLeads",
  "lsaConversations",
  "lsaVerifications",
  "shoppingProductsData",
  "shoppingCartData",
  "shoppingSettings",
  "pmaxAssets",
  "pmaxSignals",
  "pmaxSearchInsights",
  "auctionInsights",
  "mcPromotions",
  "mcReturnPolicies",
  "mcAccountIssues",
  "mcShippingSettings",
  "mcPriceInsights",
  "mcCompetitiveVisibility",
  "mcSyncStatus",
  "keywordOpportunities",
  "campaignDailyMetrics",
  "campaignConversions",
  "pmaxChannelDistribution",
  "sharedNegativeListMembers",
  "productSearchTerms",
  "pmaxListingGroups",
  "customerConversionGoals",
  "campaignConversionGoals",
  "audiences",
  "biddingOverrides",
  "experiments",
  "experimentArms",
  "offlineUserDataJobs",
  "conversionValueRules",
  "conversionValueRuleSets",
  "simulations",
  "conversionAdjustments",
  "dsaSearchTerms",
  "customerUserAccess",
  "campaignAudiencePerf",
  "pmaxSearchTerms",
] as const;

export type AccountDataArrayKey = (typeof ACCOUNT_DATA_ARRAY_KEYS)[number];

/**
 * What the account owner (or the caller) says about the business. Every field
 * is optional; a missing answer makes the checks that need it abstain, never
 * guess.
 */
export interface AccountProfile {
  /**
   * Brand names as a shopper would type them ("Acme", "Acme Outdoor"). Each
   * one is matched as a whole name (every significant word). Used to tell brand
   * searches from generic ones and to keep brand words out of negatives.
   */
  brandTerms?: readonly string[] | null;
  /** 'ecommerce' | 'lead_gen' | 'local_lead_gen' | 'local_retail' when the owner says so. */
  businessType?: string | null;
  /** Free text: what the business does. A weak signal for the business-type guess. */
  industry?: string | null;
  /** Free text goals ("sales", "leads", "calls"). A weak signal for the business-type guess. */
  primaryGoals?: readonly string[] | null;
  /** Self-reported monthly spend band: under_1k | 1k_5k | 5k_10k | 10k_25k | 25k_50k | over_50k. */
  monthlySpendRange?: string | null;
}

export type AccountData = {
  /** ISO 4217 code of the account currency; unknown currency = money floors are skipped. */
  currencyCode: string | null;
  customerId?: string | null;
  profile?: AccountProfile | null;
  merchantCenterConnected?: boolean;
  optimizationScore?: Row | null;
  conversionTrackingSettings?: Row | null;
} & { [K in AccountDataArrayKey]?: Row[] };

/** The intake answers for one campaign, all optional. */
export interface CampaignContextInput {
  /** what the campaign is for, in the owner's words */
  purpose?: string | null;
  objective?: string | null;
  /** what counts as a conversion for it */
  conversion?: string | null;
  /** the target in the owner's words, e.g. "ROAS 3:1" or "CPA under 40" */
  target?: string | null;
  /** constraints in the owner's words, e.g. "always on, never pause" */
  constraints?: string | null;
}

/**
 * Optional context the account owner supplies. Only `source: 'owner'` answers
 * count as declarations; anything else is a hint that can soften an ask but
 * never harden a verdict.
 */
export interface ClientContextInput {
  /** 'owner' = the account owner typed or confirmed it; 'suggested' = a pre-fill nobody confirmed. */
  source?: "owner" | "suggested";
  account?: {
    businessType?: string | null;
    /** 'yes' | 'no': are outcomes after the lead (sales, closed deals) fed back to Google Ads? */
    tracksPostLeadOutcomes?: string | null;
    /** rough gross margin in percent (1-95), ecommerce only */
    grossMarginPct?: number | string | null;
  };
  /** keyed by Google campaign id */
  campaigns?: Record<string, CampaignContextInput & { source?: "owner" | "suggested" }>;
}
