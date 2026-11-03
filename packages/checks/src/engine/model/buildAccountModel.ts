// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * buildAccountModel — assembles the AccountNode tree from an AccountData (+ the
 * pool-read * tables) with no DB and no AI.
 *
 *   const model = buildAccountModel(snapshot.data, snapshot.dbTables, snapshot.auditId);
 *
 * Order: window → context → account-wide indexes (negatives, slices,
 * extensions, landing pages, search index, product universe, PMax index,
 * placements, conversion actions) → one CampaignNode per campaigns row with
 * the type-specific subtree → account rollups, data quality, coverage.
 *
 * Every number comes from metrics.ts; every join is listed in the subtree
 * file headers; every guessed join is in AUDIT_V3_PROGRESS.md (Phase 1a).
 */
import type { AccountData, Row } from "../shared/input.js";
import { detectBusinessType } from "../shared/businessType.js";
import { isBrandCampaign } from "../shared/campaignClassification.js";
import type { UrlExclusion } from "../shared/pmaxTypes.js";
import { buildConversionActions } from "./buildConversionActions.js";
import { buildDemandGenChildren, videoMetricsNodes } from "./buildDemandGenTree.js";
import { buildLsaAttrs } from "./buildLsa.js";
import { buildNegatives } from "./buildNegatives.js";
import {
  buildAssetGroups,
  buildBrandExclusions,
  buildCampaignProductPerf,
  buildPlacements,
  buildPmaxChildren,
  PMAX_CAMPAIGN_PRODUCTS_TABLE,
  preparePmaxIndex,
} from "./buildPmaxTree.js";
import { audienceListDefinitionOf, prepareBuyersAndLanguages } from "./buildBuyersAndLanguages.js";
import {
  buildAdGroups,
  buildExtensions,
  buildLandingPages,
  impressionShareFrom,
  prepareSearchIndex,
  type SearchDeps,
} from "./buildSearchTree.js";
import {
  buildProductUniverse,
  buildShoppingChildren,
  computeItemOverlap,
  shoppingSettingsFor,
} from "./buildShoppingTree.js";
import { createCatalogCollector } from "./productCatalog.js";
import { prepareSlices } from "./buildSlices.js";
import {
  arr,
  bool,
  brandMatcherFrom,
  brandTokensFrom,
  groupBy,
  json,
  makeCtx,
  nc,
  nodeFromMetrics,
  nodeFromRows,
  propagateTruncation,
  resourceId,
  setShare,
  str,
  type BuildCtx,
  type CtxOptions,
  MC_KEY_RESOURCE,
  mcMarkerStatus,
} from "./context.js";
import { buildCoverageReport } from "./coverage.js";
import {
  CAMPAIGN_LANGUAGES_TABLE,
  GEO_COUNTRIES_TABLE,
  LIFECYCLE_GOALS_TABLE,
  NETWORK_SPLIT_TABLE,
  PLACEMENT_EXCLUSIONS_TABLE,
  VIDEO_METRICS_TABLE,
} from "./context.js";
import { offlineJobsNewestFirst, offlineJobsTruncated } from "./nodes/AccountNode.js";
import { placementExcludedKeys } from "../shared/placement.js";
import { num, rollupMetrics } from "./metrics.js";
import type {
  AccountAttrs,
  AccountNode,
  Checkable,
  DataQuality,
  TableQuality,
} from "./nodes/AccountNode.js";
import type { BudgetNode } from "./nodes/BudgetNode.js";
import type {
  CampaignAttrs,
  CampaignNode,
  CampaignType,
  CountrySpend,
} from "./nodes/CampaignNode.js";
import type { SliceFamilies } from "./nodes/Slice.js";
import { computeAuditWindow, isoDay, windowsFromDaily } from "./windows.js";

/** AccountData key → table name, for the sync markers. */
export const AUDIT_KEY_TABLE: Record<string, string> = {
  campaigns: "campaigns",
  adGroups: "ad_groups",
  ads: "ads",
  keywords: "keywords",
  searchTerms: "search_terms",
  conversionActions: "conversion_actions",
  deviceData: "device_data",
  geographicData: "geographic_data",
  locationCriteria: "location_criteria",
  assetGroups: "asset_groups",
  adExtensions: "ad_extensions",
  impressionShare: "impression_share",
  demographicData: "demographic_data",
  temporalData: "temporal_data",
  dailyMetrics: "daily_metrics",
  products: "products",
  audienceLists: "audience_lists",
  feedDiagnostics: "feed_diagnostics",
  pmaxChannelData: "pmax_channel_performance",
  landingPageViews: "landing_page_views",
  adPolicyData: "ad_policy",
  changeHistory: "change_history",
  sharedNegativeLists: "shared_negative_lists",
  audiencePerformance: "audience_performance",
  recommendationSubscriptions: "recommendation_subscriptions",
  campaignBudgets: "campaign_budgets",
  assetPerformance: "asset_performance",
  callData: "call_data",
  biddingStrategies: "bidding_strategies",
  bidModifiers: "bid_modifiers",
  adSchedulePerformance: "ad_schedule_performance",
  accountNegatives: "account_negatives",
  paidOrganicData: "paid_organic",
  lsaLeads: "lsa_leads",
  lsaConversations: "lsa_conversations",
  lsaVerifications: "lsa_verifications",
  shoppingProductsData: "shopping_products",
  shoppingCartData: "shopping_cart_data",
  shoppingSettings: "shopping_settings",
  pmaxAssets: "pmax_assets",
  pmaxSignals: "pmax_signals",
  pmaxSearchInsights: "pmax_search_insights",
  auctionInsights: "auction_insights",
  mcPromotions: "mc_promotions",
  mcReturnPolicies: "mc_return_policies",
  mcAccountIssues: "mc_account_issues",
  mcShippingSettings: "mc_shipping",
  mcPriceInsights: "mc_price_insights",
  mcCompetitiveVisibility: "mc_competitive_visibility",
  mcSyncStatus: "mc_sync_status",
  keywordOpportunities: "keyword_opportunities",
  campaignDailyMetrics: "campaign_daily_metrics",
  campaignConversions: "campaign_conversions",
  pmaxChannelDistribution: "pmax_channel_distribution",
  sharedNegativeListMembers: "shared_negative_list_members",
  productSearchTerms: "product_search_terms",
  pmaxListingGroups: "pmax_listing_groups",
  customerConversionGoals: "customer_conversion_goals",
  campaignConversionGoals: "campaign_conversion_goals",
  audiences: "audiences",
  biddingOverrides: "bidding_overrides",
  experiments: "experiments",
  experimentArms: "experiment_arms",
  offlineUserDataJobs: "offline_user_data_jobs",
  conversionValueRules: "conversion_value_rules",
  conversionValueRuleSets: "conversion_value_rule_sets",
  simulations: "simulations",
  conversionAdjustments: "conversion_adjustments",
  dsaSearchTerms: "dsa_search_terms",
  customerUserAccess: "customer_user_access",
  campaignAudiencePerf: "campaign_audience_perf",
  pmaxSearchTerms: "pmax_search_terms",
};

export const CONVERSION_VALUE_BY_RULE_TABLE = "conversion_value_by_rule";

/**
 * True when a conversion_value_rules row carries none of the
 * conditions the sync reads: geo (match type, targets, excluded targets),
 * device types, audience lists / interests, and the
 * itinerary condition when the sync wrote it (`itinerary_condition_json`;
 * NULL on older syncs = not read, judged on the rest as before). One thing
 * this does NOT see: a new-vs-returning-customer condition, for which the v23
 * rule resource has NO field and the v23 rule-set dimension enum has NO value
 * (re-checked on developers.google.com/google-ads/api/fields/v23/
 * conversion_value_rule + conversion_value_rule_set) — a customer-acquisition
 * rule reads as unconditional here, and only the rule-set dimensions or the
 * by-rule NEW_VS_RETURNING_USER split can tell the two apart (MI14).
 */
/** PMax URL exclusions: the synced negative WEBPAGE criteria; null = not read (older syncs, non-PMax, failed read). */
function urlExclusionsOf(v: unknown): UrlExclusion[] | null {
  const list = json<unknown>(v);
  return Array.isArray(list) ? (list as UrlExclusion[]) : null;
}

/** Round 4 item 9: the sync's frequency_caps_state; anything else (older syncs) = null. */
function capsState(v: unknown): "set" | "none_returned" | null {
  return v === "set" || v === "none_returned" ? v : null;
}

export function valueRuleHasNoCondition(r: Record<string, unknown>): boolean {
  if (str(r.geo_match_type) || str(r.excluded_geo_match_type)) return false;
  if (arr(r.geo_locations_json).length > 0 || arr(r.excluded_geo_locations_json).length > 0)
    return false;
  if (arr(r.device_types_json).length > 0) return false;
  const aud = json<{ userLists?: unknown[]; userInterests?: unknown[] }>(r.audiences_json);
  if ((aud?.userLists?.length ?? 0) > 0 || (aud?.userInterests?.length ?? 0) > 0) return false;
  const itinerary = json<Record<string, unknown>>(r.itinerary_condition_json);
  if (itinerary && typeof itinerary === "object" && Object.keys(itinerary).length > 0) return false;
  return true;
}

export function campaignTypeOf(raw: unknown): CampaignType {
  const t = String(raw ?? "").toUpperCase();
  if (t.includes("PERFORMANCE_MAX") || t === "PMAX") return "PERFORMANCE_MAX";
  if (t.includes("SHOPPING")) return "SHOPPING";
  if (t.includes("DEMAND_GEN") || t.includes("DISCOVERY")) return "DEMAND_GEN";
  if (t.includes("VIDEO")) return "VIDEO";
  if (t.includes("DISPLAY")) return "DISPLAY";
  if (t.includes("SEARCH")) return "SEARCH";
  return "OTHER";
}

function emptyFamilies(): SliceFamilies {
  return { device: [], geo: [], hour: [], dow: [], dowHour: [], audience: [], demographic: [] };
}

/**
 * The changed-field names that can move performance, with their plain words.
 * Everything else in the change feed (ad text, asset links, labels) is noise for
 * the question "what happened to the return". B4: matched one path at a time on
 * the path's LAST name, exactly — a pattern over the joined list read
 * `primaryStatus` or `adServingOptimizationStatus` as an on/off switch and
 * inflated TR03 to every campaign Google re-labelled. A card that says
 * "target ROAS, budget, on/off status" is the same fact as the API paths, in English.
 */
const MATERIAL_FIELD_WORDS: ReadonlyMap<string, string> = new Map([
  ["campaignBudget", "budget"],
  ["campaign_budget", "budget"],
  ["targetRoas", "target ROAS"],
  ["target_roas", "target ROAS"],
  ["targetCpa", "target CPA"],
  ["target_cpa", "target CPA"],
  ["targetCpaMicros", "target CPA"],
  ["target_cpa_micros", "target CPA"],
  ["biddingStrategy", "bidding strategy"],
  ["bidding_strategy", "bidding strategy"],
  ["biddingStrategyType", "bidding strategy"],
  ["bidding_strategy_type", "bidding strategy"],
  ["cpcBidMicros", "max CPC bid"],
  ["cpc_bid_micros", "max CPC bid"],
  ["status", "on/off status"],
]);

/**
 * A budget's amount, daily or a fixed total. Only a CAMPAIGN_BUDGET row moves a
 * budget: a promotion asset's `moneyAmountOff.amountMicros` is not one.
 */
const BUDGET_AMOUNT_FIELDS: ReadonlySet<string> = new Set([
  "amountMicros",
  "amount_micros",
  "totalAmountMicros",
  "total_amount_micros",
]);

/**
 * A bidding-strategy switch on a CAMPAIGN row can name only the new strategy
 * (`maximizeConversions`, no sub-field). Maximize clicks is `targetSpend` in the API.
 */
const STRATEGY_SWITCH_FIELDS: ReadonlySet<string> = new Set([
  "maximizeConversions",
  "maximize_conversions",
  "maximizeConversionValue",
  "maximize_conversion_value",
  "manualCpc",
  "manual_cpc",
  "manualCpm",
  "manual_cpm",
  "targetSpend",
  "target_spend",
  "targetImpressionShare",
  "target_impression_share",
  "targetRoas",
  "target_roas",
  "targetCpa",
  "target_cpa",
]);

/** the plain words for one field path on one resource type, or null when it is not material. */
function materialFieldWord(field: string, resourceType: string): string | null {
  const r = resourceType.toUpperCase();
  const name = field.split(".").pop() ?? "";
  if (BUDGET_AMOUNT_FIELDS.has(name)) return r === "CAMPAIGN_BUDGET" ? "budget" : null;
  if (r === "CAMPAIGN" && STRATEGY_SWITCH_FIELDS.has(field)) return "bidding strategy";
  return MATERIAL_FIELD_WORDS.get(name) ?? null;
}

/**
 * B4: creating or removing a campaign, an ad group or an asset group moves
 * performance whatever fields the row names (a CREATE row names only
 * "id,resourceName", checked live 1 Nov), so it is material by its OPERATION.
 */
const LAUNCH_REMOVE_WORDS: Readonly<Record<string, string>> = {
  CAMPAIGN: "campaign",
  AD_GROUP: "ad group",
  ASSET_GROUP: "asset group",
};
function launchRemoveWord(resourceType: string, operation: string): string | null {
  const what = LAUNCH_REMOVE_WORDS[resourceType.toUpperCase()];
  if (!what) return null;
  const op = operation.toUpperCase();
  if (op === "CREATE") return `${what} launched`;
  if (op === "REMOVE") return `${what} removed`;
  return null;
}

/** A person in the interface, Google's own automation, or an API caller (which includes us). */
function changedByOf(clientType: string): "person" | "google" | "api" | "unknown" {
  const t = clientType.toUpperCase();
  if (t.includes("WEB_CLIENT") || t.includes("UI")) return "person";
  if (t.includes("INTERNAL_TOOL") || t.includes("AUTOMATED")) return "google";
  if (t.includes("API")) return "api";
  return "unknown";
}

/**
 * R3.6c (bdos guide item 20): the changes GOOGLE made to the account, not a
 * person or a tool the owner runs. Only two client types count:
 * GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION is an auto-applied recommendation,
 * INTERNAL_TOOL is Google's own tooling. A recommendation someone APPLIED in the
 * interface (GOOGLE_ADS_RECOMMENDATIONS) and the owner's own automated rules or
 * scripts are the owner's choice, so they are left out on purpose.
 * `changedByOf` above is not reused: AS13 leans on its wider buckets.
 */
function googleSourceOf(clientType: string): "auto_apply" | "google_internal" | null {
  const t = clientType.toUpperCase();
  if (t.includes("RECOMMENDATIONS_SUBSCRIPTION")) return "auto_apply";
  if (t.includes("INTERNAL_TOOL")) return "google_internal";
  return null;
}

/** What a Google-made change touched, in the words the owner would use. */
function googleChangeKindOf(
  resourceType: string,
  fields: readonly string[],
):
  | "budget"
  | "bids and targets"
  | "keywords and targeting"
  | "on/off status"
  | "ads and assets"
  | "other settings" {
  const r = resourceType.toUpperCase();
  const f = fields.join(",");
  if (r.includes("BUDGET") || /budget/i.test(f)) return "budget";
  if (
    r.includes("BIDDING_STRATEGY") ||
    /targetRoas|target_roas|targetCpa|target_cpa|biddingStrategy|bidding_strategy|cpcBid|cpc_bid|bidModifier|bid_modifier/i.test(
      f,
    )
  )
    return "bids and targets";
  if (r === "AD_GROUP_CRITERION" || r === "CAMPAIGN_CRITERION" || /keyword/i.test(f))
    return "keywords and targeting";
  // an asset or ad switched on/off is an asset change, not a campaign switch
  if (r === "AD" || r === "AD_GROUP_AD" || r.includes("ASSET")) return "ads and assets";
  if (fields.some((x) => /(^|\.)status$/i.test(x))) return "on/off status";
  return "other settings";
}

/**
 * Plan 5.2 (Gate 1 row 8): the change feed counted per editor, most first, and
 * split by who pressed the button (a person, Google's automation, an API tool).
 * The email is the grouping key ONLY and is not kept: the audit reports that
 * one login made most of the changes, never whose login it was.
 */
function changeEditorsOf(changeRows: readonly Record<string, unknown>[]): {
  editors: Array<{ changes: number; person: number; google: number; api: number; unknown: number }>;
  noEditor: number;
} {
  const byEmail = new Map<
    string,
    { changes: number; person: number; google: number; api: number; unknown: number }
  >();
  let noEditor = 0;
  for (const h of changeRows) {
    const email = h.user_email == null ? "" : String(h.user_email).trim().toLowerCase();
    if (!email) {
      noEditor += 1;
      continue;
    }
    const e = byEmail.get(email) ?? { changes: 0, person: 0, google: 0, api: 0, unknown: 0 };
    e.changes += 1;
    e[changedByOf(String(h.client_type ?? ""))] += 1;
    byEmail.set(email, e);
  }
  return { editors: [...byEmail.values()].sort((a, b) => b.changes - a.changes), noEditor };
}

/** Placement watch: the account's excluded places as criterion keys (placementWatch.ts). null = the table was not loaded. */
function placementExcludedKeysOf(rows: any[] | null): string[] | null {
  return rows == null ? null : [...placementExcludedKeys(rows)].sort();
}

/**
 * R3.6d: which content labels and app categories the account excludes, by name.
 * The negative-list node keeps only a count per criterion type, which is enough
 * for AS07's "none at all" and not for "is the app category there". null = the
 * table was not loaded (unknown, never "nothing excluded").
 */
function brandSafetyExclusionsOf(
  rows: any[] | null,
): { contentLabels: string[]; appCategories: string[] } | null {
  if (rows == null) return null;
  const contentLabels = new Set<string>();
  const appCategories = new Set<string>();
  for (const r of rows) {
    const type = String(r.criterion_type ?? "").toUpperCase();
    if (type === "CONTENT_LABEL" && r.content_label_type != null)
      contentLabels.add(String(r.content_label_type).toUpperCase());
    if (type === "MOBILE_APP_CATEGORY")
      appCategories.add(String(r.mobile_app_category ?? "unnamed"));
  }
  return { contentLabels: [...contentLabels].sort(), appCategories: [...appCategories].sort() };
}

/**
 * Row limits keyed by data key OR table name (`search_terms` or `searchTerms`,
 * with an optional `:per_campaign` suffix), stored under both so every lookup
 * finds them. A key given both ways keeps the smaller limit.
 */
export function normaliseCaps(
  caps: Readonly<Record<string, number>> | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  const tableToKey = new Map(Object.entries(AUDIT_KEY_TABLE).map(([k, t]) => [t, k] as const));
  const put = (name: string, v: number) => {
    out[name] = name in out ? Math.min(out[name]!, v) : v;
  };
  for (const [name, v] of Object.entries(caps ?? {})) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    const [base = "", suffix] = name.split(":");
    const tail = suffix != null ? `:${suffix}` : "";
    const key = tableToKey.get(base) ?? (base in AUDIT_KEY_TABLE ? base : null);
    put(name, v);
    if (key) {
      put(`${key}${tail}`, v);
      put(`${AUDIT_KEY_TABLE[key]}${tail}`, v);
    }
  }
  return out;
}

export function buildAccountModel(
  data: AccountData,
  dbTables: Record<string, any[]> = {},
  auditId = "audit",
  opts: CtxOptions = {},
): AccountNode {
  const aw = computeAuditWindow(
    data.dailyMetrics ?? [],
    data.campaignDailyMetrics ?? [],
    data.conversionActions ?? [],
  );
  const ctx: BuildCtx = makeCtx(data, dbTables, aw, { ...opts, caps: normaliseCaps(opts.caps) });
  const accountId = auditId;

  const campaignRows = ctx.read("campaigns");
  for (const c of campaignRows) {
    const id = String(c.campaign_id);
    ctx.campaignIds.add(id);
    if (c.id != null) ctx.campaignUuidToId.set(String(c.id), id);
    ctx.campaignTypeById.set(id, campaignTypeOf(c.type));
  }
  ctx.brandTokens = brandTokensFrom(data.profile);
  ctx.brandMatch = brandMatcherFrom(data.profile);

  // ---- account-wide indexes
  const negatives = buildNegatives(ctx, accountId);
  const slices = prepareSlices(ctx);
  const extensions = buildExtensions(ctx);
  const landingPages = buildLandingPages(ctx, accountId);
  const searchIndex = prepareSearchIndex(ctx);
  const universe = buildProductUniverse(ctx, accountId);
  const pmaxIndex = preparePmaxIndex(ctx);
  const placements = buildPlacements(ctx);
  const conversionActions = buildConversionActions(ctx, accountId);
  const searchDeps: SearchDeps = {
    negatives,
    slices,
    extensions,
    landingPages,
    index: searchIndex,
  };
  const catalog = createCatalogCollector(ctx);
  const pmaxDeps = {
    universe,
    searchIndex,
    placementsByCampaign: placements.byCampaign,
    catalog,
    searchDeps,
  };

  const budgetRows = ctx.read("campaignBudgets");
  const campaignsByBudget = groupBy(campaignRows, (c) => str(c.budget_id));
  const isRows = new Map(
    ctx.read("impressionShare").map((r) => [String(r.campaign_id), r] as const),
  );
  const controlByCid = new Map(
    (ctx.readDb("campaign_control_settings") ?? []).map((r) => [String(r.campaign_id), r] as const),
  );
  const customerGoals = ctx.read("customerConversionGoals").map((g) => ({
    category: String(g.category ?? ""),
    origin: String(g.origin ?? ""),
    biddable: bool(g.biddable) === true,
  }));
  const customerGoalKeys = new Set(
    customerGoals.map((g) => `${g.category}|${g.origin}|${g.biddable}`),
  );
  const goalsByCid = groupBy(ctx.read("campaignConversionGoals"), (g) => str(g.campaign_id));
  const convByCid = groupBy(ctx.read("campaignConversions"), (c) => str(c.campaign_id));
  const locByCid = groupBy(ctx.read("locationCriteria"), (l) => str(l.campaign_id));
  const changeRows = ctx.read("changeHistory");
  /**
   * R3.6c review: the campaigns a change row is about, from its resource name.
   * `campaigns/<id>` and `campaignCriteria|campaignAssets/<id>~…` name the campaign;
   * `campaignBudgets/<id>` names a budget (a shared one runs several campaigns);
   * `adGroups|adGroupCriteria|adGroupAds|adGroupAssets/<agid>~…` name an ad group.
   * Unknown = [], never a guess.
   */
  const campaignOfAdGroup = new Map(
    ctx
      .read("adGroups")
      .map((g) => [String(g.ad_group_id ?? ""), String(g.campaign_id ?? "")] as const),
  );
  const campaignIdsOfChange = (rn: string): string[] => {
    const camp =
      /\/(?:campaigns|campaignCriteria|campaignAssets|campaignBidModifiers|campaignExtensionSettings)\/(\d+)/.exec(
        rn,
      );
    if (camp) return [camp[1]!];
    const budget = /\/campaignBudgets\/(\d+)/.exec(rn);
    if (budget)
      return campaignRows
        .filter((c) => str(c.budget_id) === budget[1])
        .map((c) => String(c.campaign_id));
    const group =
      /\/(?:adGroups|adGroupCriteria|adGroupAds|adGroupAssets|adGroupBidModifiers|adGroupExtensionSettings)\/(\d+)/.exec(
        rn,
      );
    if (group) {
      const cid = campaignOfAdGroup.get(group[1]!);
      return cid ? [cid] : [];
    }
    return [];
  };
  /**
   * B4: the one campaign a change row is about — the campaign Google names on the
   * change itself first, then its ad group's campaign, then the resource name.
   * A shared budget runs several campaigns: no single one, so null (account level).
   */
  const campaignOfChange = (h: Row): string | null => {
    const own = str(h.campaign_id);
    if (own) return own;
    const group = str(h.ad_group_id);
    const viaGroup = group ? campaignOfAdGroup.get(group) : undefined;
    if (viaGroup) return viaGroup;
    const ids = campaignIdsOfChange(String(h.change_resource_name ?? ""));
    return ids.length === 1 ? ids[0]! : null;
  };
  const changeByCid = groupBy(changeRows, campaignOfChange);
  const changeCap = ctx.capOf("changeHistory");
  const changeSample = changeCap != null && changeRows.length >= changeCap;
  const experimentRows = ctx.read("experiments");
  const armRows = ctx.read("experimentArms");
  const expByCid = new Map<string, string[]>();
  for (const a of armRows)
    for (const c of arr(a.campaigns_json)) {
      const cid = resourceId(c);
      if (!cid) continue;
      const eid = resourceId(a.experiment_resource_name) ?? String(a.experiment_resource_name);
      (expByCid.get(cid) ?? expByCid.set(cid, []).get(cid)!).push(eid);
    }
  const simByCid = groupBy(ctx.read("simulations"), (s) => {
    const m = /campaigns\/(\d+)/.exec(String(s.resource_name ?? ""));
    return m?.[1] ?? null;
  });
  const shopByCid = new Map(
    ctx.read("shoppingSettings").map((s) => [String(s.campaign_id), s] as const),
  );
  const scheduleByCid = groupBy(ctx.read("adSchedulePerformance"), (s) => str(s.campaign_id));
  const dailyByCid = groupBy(ctx.read("campaignDailyMetrics"), (d) => str(d.campaign_id));
  const dailyRows = ctx.read("dailyMetrics");

  // ---- budgets
  const budgets: BudgetNode[] = budgetRows.map((b) => {
    const id = String(b.budget_id);
    const siblings = (campaignsByBudget.get(id) ?? []).map((c) => String(c.campaign_id));
    const refs = num(b.reference_count);
    return {
      ...nodeFromRows(ctx, "budget", id, String(b.name ?? id), accountId, [], "campaignBudgets", {
        status: b.status,
      }),
      attrs: {
        amount: num(b.amount),
        status: str(b.status),
        deliveryMethod: str(b.delivery_method),
        period: str(b.period),
        type: str(b.type),
        shared: bool(b.shared) === true || (refs ?? 0) > 1 || siblings.length > 1,
        referenceCount: refs,
        siblingCampaignIds: siblings,
      },
    };
  });
  const budgetNodeById = new Map(budgets.map((b) => [b.id, b] as const));

  // ---- R3.8: customer-acquisition goals (campaign rows + the account default value)
  const lifecycleGate = ctx.gate(LIFECYCLE_GOALS_TABLE, ctx.readDb(LIFECYCLE_GOALS_TABLE));
  const lifecycleByCid = new Map<string, any>();
  let customerAcquisition: AccountAttrs["customerAcquisition"];
  if (lifecycleGate.rows == null) {
    customerAcquisition = {
      state: "not_checkable",
      note: lifecycleGate.note ?? `${LIFECYCLE_GOALS_TABLE} not loaded`,
    };
  } else {
    const accountRow = lifecycleGate.rows.find((r) => String(r.scope ?? "") === "account");
    for (const r of lifecycleGate.rows)
      if (String(r.scope ?? "") === "campaign" && r.campaign_id != null)
        lifecycleByCid.set(String(r.campaign_id), r);
    customerAcquisition = {
      state: "synced",
      accountValue: accountRow ? num(accountRow.additional_value) : null,
      accountHighLifetimeValue: accountRow ? num(accountRow.high_lifetime_value) : null,
      campaignRows: lifecycleByCid.size,
    };
  }

  // ---- Phase 11: new vs returning customers, campaign languages, the shop's feed languages
  const buyersAndLanguages = prepareBuyersAndLanguages(ctx);
  // Video campaigns' view numbers and every campaign's spend by country: null = not read
  const videoGate = ctx.gate(VIDEO_METRICS_TABLE, ctx.readDb(VIDEO_METRICS_TABLE));
  const videoByCid = groupBy(videoGate.rows ?? [], (v) => str(v.campaign_id));
  // R9 (SK32): Search / Standard Shopping spend per ad network; null = not read
  const networkGate = ctx.gate(NETWORK_SPLIT_TABLE, ctx.readDb(NETWORK_SPLIT_TABLE));
  const networkByCid = new Map<string, NonNullable<CampaignAttrs["networkSpend"]>>();
  for (const r of networkGate.rows ?? []) {
    const cid = String(r.campaign_id ?? "");
    const net = String(r.ad_network_type ?? "").toUpperCase();
    const bucket =
      net === "SEARCH"
        ? "google"
        : net === "SEARCH_PARTNERS"
          ? "partners"
          : net === "CONTENT"
            ? "display"
            : null;
    if (!cid || !bucket) continue;
    const zero = () => ({ cost: 0, clicks: 0, conv: 0, value: 0 });
    const e = networkByCid.get(cid) ?? { google: zero(), partners: zero(), display: zero() };
    e[bucket].cost += num(r.cost) ?? 0;
    e[bucket].clicks += num(r.clicks) ?? 0;
    e[bucket].conv += num(r.conversions) ?? 0;
    e[bucket].value += num(r.conversion_value) ?? 0;
    networkByCid.set(cid, e);
  }
  const countryGate = ctx.gate(GEO_COUNTRIES_TABLE, ctx.readDb(GEO_COUNTRIES_TABLE));
  const countriesByCid = new Map<string, CountrySpend[]>();
  for (const r of countryGate.rows ?? []) {
    const cid = String(r.campaign_id ?? "");
    const countryId = str(r.country_id);
    if (!cid || !countryId) continue;
    const list = countriesByCid.get(cid) ?? countriesByCid.set(cid, []).get(cid)!;
    list.push({
      id: countryId,
      code: str(r.country_code),
      name: str(r.country_name),
      locationType: str(r.location_type),
      cost: num(r.cost) ?? 0,
      clicks: num(r.clicks) ?? 0,
      conv: num(r.conversions) ?? 0,
      value: num(r.conversion_value) ?? 0,
    });
  }

  // ---- campaigns
  const campaigns: CampaignNode[] = [];
  for (const c of campaignRows) {
    const id = String(c.campaign_id);
    const type = campaignTypeOf(c.type);
    const name = String(c.name ?? id);
    const base = nodeFromRows(ctx, "campaign", id, name, accountId, [c], "campaigns", {
      status: c.status,
      daily: dailyByCid.get(id) ?? null,
      dailyTable: "campaignDailyMetrics",
    });
    const budgetId = str(c.budget_id);
    const budget = budgetId ? budgetNodeById.get(budgetId) : undefined;
    const control = controlByCid.get(id);
    const goals = (goalsByCid.get(id) ?? []).map((g) => ({
      category: String(g.category ?? ""),
      origin: String(g.origin ?? ""),
      biddable: bool(g.biddable) === true,
    }));
    const goalKeys = new Set(goals.map((g) => `${g.category}|${g.origin}|${g.biddable}`));
    const changes = changeByCid.get(id) ?? [];
    const changeDates = changes
      .map((h) => isoDay(h.change_date_time))
      .filter((d): d is string => !!d)
      .sort();
    const loc = locByCid.get(id) ?? [];
    const cost = base.windows.m90.cost ?? 0;
    const status = str(c.status);
    const vtc = control ? num(control.view_through_conversions) : null;
    const allConv = num(c.all_conversions);
    const node: CampaignNode = {
      ...base,
      attrs: {
        type,
        rawType: str(c.type),
        isBrand: isBrandCampaign(name),
        strategy: str(c.bidding_strategy_type),
        targetRoas: num(c.target_roas),
        targetCpa: num(c.target_cpa),
        // `campaigns.bidding_strategy_resource` = 'customers/<cid>/biddingStrategies/<id>'
        // (AccountDataSyncService fetchCampaigns → storeCampaigns). Keep the id only.
        portfolioStrategyId: (() => {
          const r = str(c.bidding_strategy_resource) ?? str(c.accessible_bidding_strategy_resource);
          return r ? (r.split("/").pop() ?? r) : null;
        })(),
        biddingStrategySource: (() => {
          const v = str(c.bidding_strategy_source)?.toLowerCase();
          return v === "portfolio" || v === "standard" ? v : null;
        })(),
        portfolioStrategyType: str(c.portfolio_strategy_type),
        portfolioTargetRoas: num(c.portfolio_target_roas),
        geoTargetType: str(c.geo_target_type),
        primaryStatus: str(c.primary_status),
        biddingStrategySystemStatus: str(c.bidding_strategy_system_status),
        networkSettings: json<Record<string, unknown>>(c.network_settings),
        budget: (() => {
          const amount = budget?.attrs.amount ?? num(c.budget);
          const dailyRows = (dailyByCid.get(id) ?? []).length;
          const windowDays = aw.days;
          const budgetDays =
            windowDays == null
              ? dailyRows > 0
                ? dailyRows
                : null
              : dailyRows > 0
                ? Math.min(dailyRows, windowDays)
                : windowDays;
          const util90 =
            amount != null &&
            amount > 0 &&
            budgetDays != null &&
            budgetDays > 0 &&
            base.windows.m90.cost != null
              ? base.windows.m90.cost / (amount * budgetDays)
              : null;
          return {
            id: budgetId,
            amount,
            shared: budget?.attrs.shared ?? false,
            siblingCampaignIds: (budget?.attrs.siblingCampaignIds ?? []).filter((s) => s !== id),
            budgetDays,
            util90,
            capNote: util90 != null && util90 > 1 ? "monthly cap allows up to 2x daily" : null,
          };
        })(),
        impressionShare: isRows.has(id)
          ? impressionShareFrom(isRows.get(id), "impression_share")
          : impressionShareFrom(c, "campaigns"),
        allConversions: allConv,
        allConversionsValue: num(c.all_conversions_value),
        lastActiveDate: isoDay(c.last_active_date),
        urlExpansionOptOut: bool(c.url_expansion_opt_out),
        enableAiMax: bool(c.enable_ai_max),
        brandGuidelinesEnabled: bool(c.brand_guidelines_enabled),
        hasPageFeed: bool(c.has_page_feed),
        pmaxNegativeCount: num(c.pmax_negative_count),
        controlSettings: control
          ? {
              frequencyCaps: json(control.frequency_caps),
              frequencyCapsState: capsState(control.frequency_caps_state),
              assetAutomation: json(control.asset_automation),
              viewThroughConversions: vtc,
              conversions: num(control.conversions),
              allConversions: num(control.all_conversions),
              urlExclusions: urlExclusionsOf(control.url_exclusions),
            }
          : null,
        conversionGoals: goals,
        conversionGoalsDifferFromCustomer:
          goals.length === 0
            ? null
            : goalKeys.size !== customerGoalKeys.size ||
              [...goalKeys].some((k) => !customerGoalKeys.has(k)),
        conversionsByAction: (convByCid.get(id) ?? []).map((r) => ({
          actionName: String(r.conversion_action_name ?? ""),
          category: str(r.conversion_category),
          isPrimary: bool(r.is_primary),
          conv: num(r.conversions),
          value: num(r.conversion_value),
        })),
        geo: {
          targets: loc.filter((l) => bool(l.is_negative) !== true).length,
          negatives: loc.filter((l) => bool(l.is_negative) === true).length,
          withBidModifier: loc.filter((l) => num(l.bid_modifier) != null).length,
          excluded: loc
            .filter((l) => bool(l.is_negative) === true)
            .map((l) => str(l.location_id) ?? str(l.criterion_id))
            .filter((g): g is string => g != null),
        },
        changeHistory: {
          count: changes.length,
          sample: changeSample,
          firstDate: changeDates[0] ?? null,
          lastDate: changeDates[changeDates.length - 1] ?? null,
        },
        experimentIds: expByCid.get(id) ?? [],
        simulationTypes: (simByCid.get(id) ?? []).map((s) => String(s.simulation_type ?? "")),
        shoppingSettings: shoppingSettingsFor(shopByCid.get(id)),
        brandExclusions: { state: "not_synced" },
        customerAcquisition: lifecycleByCid.has(id)
          ? {
              mode: str(lifecycleByCid.get(id).optimization_mode),
              value: num(lifecycleByCid.get(id).additional_value),
              highLifetimeValue: num(lifecycleByCid.get(id).high_lifetime_value),
            }
          : null,
        customerSplit: buyersAndLanguages.customerSplitFor(id),
        languages: buyersAndLanguages.languagesFor(id),
        networkSpend:
          networkGate.rows == null
            ? null
            : (networkByCid.get(id) ?? {
                google: { cost: 0, clicks: 0, conv: 0, value: 0 },
                partners: { cost: 0, clicks: 0, conv: 0, value: 0 },
                display: { cost: 0, clicks: 0, conv: 0, value: 0 },
              }),
        countries: countryGate.rows == null ? null : (countriesByCid.get(id) ?? []),
        productPerf: null,
        inOptimizerScope: status === "ENABLED" && cost > 0,
        channelShares: null,
        demandGen: null,
        adScheduleRows: (scheduleByCid.get(id) ?? []).length,
        // R4-D review (MI18): the campaign's own spend and clicks per day, so a zero-sale day with no traffic is never read as a tracking break
        dailyTraffic: dailyByCid.has(id)
          ? (dailyByCid.get(id) ?? [])
              .map((d) => ({
                date: isoDay(d.metric_date ?? d.date) ?? "",
                cost: num(d.cost) ?? 0,
                clicks: num(d.clicks) ?? 0,
              }))
              .filter((d) => d.date !== "")
          : null,
      },
      children: {
        adGroups: [],
        assetGroups: [],
        extensions: extensions.byCampaign.get(id) ?? [],
        negatives: negatives.campaignNegativesSynced.has(id)
          ? [negatives.campaignLevel.get(id)!]
          : null,
        inheritedNegatives: negatives.inheritedFor(id),
        bidModifiers: slices.bidModifiers.byCampaign.get(id) ?? [],
        slices: emptyFamilies(),
        channels: [],
        placements: [],
        searchCategories: [],
        productGroups: null,
        products: [],
        searchTerms: [],
        videoMetrics: null,
        dgAssets: null,
        dgAudienceSignals: null,
      },
    };
    const sl = slices.forCampaign(id, id);
    node.children.slices = sl.families;
    node.notCheckable.push(...sl.notCheckable);
    if (node.children.negatives == null)
      node.notCheckable.push(
        nc(
          "campaign.negatives",
          "no campaign_negatives sync marker for this campaign — campaign-level negatives unknown",
        ),
      );
    if (node.attrs.impressionShare.source === "none")
      node.notCheckable.push(
        nc(
          "campaign.impression_share",
          "no impression_share row and no IS columns on the campaign (PMax / Shopping / Demand Gen)",
        ),
      );
    if (node.attrs.urlExpansionOptOut == null && type === "PERFORMANCE_MAX") {
      /* PX10 pushed in the PMax builder */
    }
    if (
      node.children.bidModifiers.some(
        (b) => b.attrs.measuredSlice.kind === "unresolved" && !b.attrs.measuredSlice.noSlice,
      )
    )
      node.notCheckable.push(
        nc("BB09", "bid modifier criterion unresolved (interaction_type / modifier_source empty)"),
      );
    if (changeSample)
      node.notCheckable.push(
        nc(
          "campaign.change_history",
          "change history is at the reader's row limit — dated causes exist only for part of the window",
        ),
      );
    if (node.attrs.portfolioStrategyId == null)
      node.notCheckable.push(
        nc(
          "campaign.portfolio_strategy",
          "bidding_strategy_resource is null on this campaign — no portfolio strategy attached, or the link was not carried by the input",
        ),
      );
    if (node.windows.m30 == null)
      node.notCheckable.push(
        nc("campaign.daily", "no campaign_daily_metrics rows for this campaign — sub-windows null"),
      );

    // P3g: brand lists (PMax brand exclusions, Search brand lists) before the PMax builder reads them
    node.attrs.brandExclusions = buildBrandExclusions(ctx, node);
    node.children.adGroups = buildAdGroups(ctx, node, searchDeps);
    if (type === "PERFORMANCE_MAX") buildPmaxChildren(ctx, node, pmaxIndex, pmaxDeps);
    else if (type === "SHOPPING") {
      node.children.assetGroups = buildAssetGroups(ctx, node, pmaxIndex, pmaxDeps);
      buildShoppingChildren(ctx, node, universe, searchDeps);
      // a Shopping campaign's own product rows (SH04 judges them per campaign)
      node.attrs.productPerf = buildCampaignProductPerf(ctx, node, universe);
      node.children.placements = placements.byCampaign.get(id) ?? [];
    } else if (type === "DEMAND_GEN") buildDemandGenChildren(ctx, node, placements.byCampaign);
    else {
      node.children.placements = placements.byCampaign.get(id) ?? [];
      node.children.productGroups = null;
    }
    if (type === "VIDEO") {
      if (videoGate.rows == null)
        node.notCheckable.push(
          nc("VD01", videoGate.note ?? `${VIDEO_METRICS_TABLE} not loaded: view numbers not read`),
        );
      else
        node.children.videoMetrics = videoMetricsNodes(
          ctx,
          id,
          videoByCid.get(id) ?? [],
          VIDEO_METRICS_TABLE,
        );
    }
    for (const e of node.children.extensions) setShare(e, node.windows.m90);
    for (const s of Object.values(node.children.slices))
      for (const x of s) setShare(x, node.windows.m90);
    propagateTruncation(node, [
      ...node.children.adGroups,
      ...node.children.assetGroups,
      ...node.children.searchCategories,
    ]);
    campaigns.push(node);
  }

  // ---- account node
  const m90 = rollupMetrics(
    campaigns.map((c) => c.windows.m90),
    ctx.w90,
    "campaigns",
  );
  const accountBase = nodeFromMetrics(
    "account",
    accountId,
    `account ${data.customerId ?? ""}`.trim(),
    null,
    m90,
    windowsFromDaily(dailyRows, aw, "dailyMetrics"),
  );
  for (const c of campaigns) setShare(c, m90);
  const acctSlices = slices.forAccount(accountId);
  for (const s of Object.values(acctSlices.families)) for (const x of s) setShare(x, m90);

  // account-level rollups of keyless tables
  const audienceListRows = ctx.read("audienceLists");
  const recSubs = ctx.read("recommendationSubscriptions");
  const users = ctx.read("customerUserAccess");
  const valueRules = ctx.read("conversionValueRules");
  const valueRuleSets = ctx.read("conversionValueRuleSets");
  const valueByRuleRows = ctx.readDb(CONVERSION_VALUE_BY_RULE_TABLE);
  const adjustments = ctx.read("conversionAdjustments");
  const offline = ctx.read("offlineUserDataJobs");
  const strategies = ctx.read("biddingStrategies");
  const overrides = ctx.read("biddingOverrides");
  const simulations = ctx.read("simulations");
  const promos = ctx.read("mcPromotions");
  const returns = ctx.read("mcReturnPolicies");
  const mcIssues = ctx.read("mcAccountIssues");
  const shipping = ctx.read("mcShippingSettings");
  const compVis = ctx.read("mcCompetitiveVisibility");
  const feeds = ctx.read("feedDiagnostics");
  const kwOpps = ctx.read("keywordOpportunities");
  const paidOrganic = ctx.read("paidOrganicData");
  const lsa = buildLsaAttrs(ctx, campaignRows);
  const cart = ctx.read("shoppingCartData");
  const searchTermRows = ctx.read("searchTerms");
  const pst = ctx.read("productSearchTerms");
  const dsa = ctx.read("dsaSearchTerms");
  const policy = ctx.read("adPolicyData");
  const assetPerf = ctx.read("assetPerformance");
  const mcSync = ctx.read("mcSyncStatus");
  const callData = ctx.read("callData");
  const changeDates = changeRows
    .map((h) => isoDay(h.change_date_time))
    .filter((d): d is string => !!d)
    .sort();
  // §A.0: account-level attributes are computed over ATTACHED rows only — a 0 from an empty population is not "none found"
  const attachedAdIds = new Set(
    campaigns.flatMap((c) => c.children.adGroups.flatMap((g) => g.children.ads.map((a) => a.id))),
  );
  const attachedPmaxAssetIds = new Set(
    campaigns.flatMap((c) =>
      c.children.assetGroups.flatMap((g) =>
        g.children.assets.map((a) => a.id.split(":").pop() ?? ""),
      ),
    ),
  );
  const policyAttached = policy.filter((p) => attachedAdIds.has(String(p.ad_id ?? "")));
  const assetPerfAttached = assetPerf.filter((a) => {
    const m = /~(\d+)$/.exec(String(a.ad_resource ?? ""));
    return (
      (!!m && attachedAdIds.has(m[1] ?? "")) || attachedPmaxAssetIds.has(String(a.asset_id ?? ""))
    );
  });
  const labelCounts: Record<string, number> = {};
  for (const a of assetPerfAttached) {
    const l = String(a.performance_label ?? "UNKNOWN");
    labelCounts[l] = (labelCounts[l] ?? 0) + 1;
  }

  const counts: Record<CampaignType, number> = {
    SEARCH: 0,
    PERFORMANCE_MAX: 0,
    SHOPPING: 0,
    DEMAND_GEN: 0,
    VIDEO: 0,
    DISPLAY: 0,
    OTHER: 0,
  };
  let brandCost: number | null = null;
  let brandValue: number | null = null;
  for (const c of campaigns) {
    counts[c.attrs.type]++;
    if (c.attrs.isBrand) {
      brandCost = (brandCost ?? 0) + (c.windows.m90.cost ?? 0);
      brandValue = (brandValue ?? 0) + (c.windows.m90.value ?? 0);
    }
  }
  const outOfScope: Record<string, number> = {};
  for (const k of [
    "lsaLeads",
    "lsaConversations",
    "lsaVerifications",
    "callData",
    "auctionInsights",
  ])
    outOfScope[k] = Array.isArray((data as any)[k]) ? (data as any)[k].length : 0;

  const model: AccountNode = {
    ...accountBase,
    auditId,
    window: aw,
    attrs: {
      customerId: data.customerId ?? null,
      currencyCode: data.currencyCode ?? "",
      merchantCenterConnected: !!data.merchantCenterConnected,
      optimizationScore: data.optimizationScore ?? null,
      conversionTrackingSettings: data.conversionTrackingSettings ?? null,
      profile: data.profile ?? null,
      businessType: opts.businessType ?? detectBusinessType(data),
      customerAcquisition,
      brandTokens: ctx.brandTokens,
      campaignCounts: counts,
      brandCost,
      brandValue,
      brandSpendShare: brandCost != null && m90.cost ? brandCost / m90.cost : null,
      negatives: negatives.summary,
      callouts: extensions.callouts,
      landingPages: landingPages.summary,
      audienceLists: {
        total: audienceListRows.length,
        withSearchSize: audienceListRows.filter((l) => (num(l.size_for_search) ?? 0) > 0).length,
      },
      recommendationSubscriptions: recSubs.map((r) => ({
        type: String(r.type ?? ""),
        status: str(r.status),
      })),
      changeHistory: {
        rows: changeRows.length,
        sample: changeSample,
        cap: changeCap,
        firstDate: changeDates[0] ?? null,
        lastDate: changeDates[changeDates.length - 1] ?? null,
        users: new Set(changeRows.map((h) => String(h.user_email ?? ""))).size,
        ...changeEditorsOf(changeRows),
        googleMade: changeRows
          .map((h) => {
            const source = googleSourceOf(String(h.client_type ?? ""));
            if (!source) return null;
            const date = isoDay(h.change_date_time) ?? "";
            if (!date) return null;
            const resourceType = String(h.resource_type ?? h.change_resource_type ?? "");
            const fields = String(h.changed_fields ?? "")
              .split(",")
              .map((f) => f.trim())
              .filter(Boolean);
            return {
              date,
              campaignIds: campaignIdsOfChange(String(h.change_resource_name ?? "")),
              resourceType,
              operation: String(h.operation ?? ""),
              kind: googleChangeKindOf(resourceType, fields),
              source,
            };
          })
          .filter((c): c is NonNullable<typeof c> => c != null),
        material: changeRows
          .map((h) => {
            const resourceType = String(h.resource_type ?? h.change_resource_type ?? "");
            const operation = String(h.operation ?? "");
            const fields = String(h.changed_fields ?? "")
              .split(",")
              .map((f) => f.trim())
              .filter(Boolean);
            const launch = launchRemoveWord(resourceType, operation);
            const words = fields
              .map((f) => materialFieldWord(f, resourceType))
              .filter((w): w is string => w != null);
            return launch != null || words.length > 0
              ? { h, resourceType, operation, fields, words: launch ? [launch] : words }
              : null;
          })
          .filter((x): x is NonNullable<typeof x> => x != null)
          .map(({ h, resourceType, operation, fields, words }) => {
            let changedValues: Record<string, { old: unknown; new: unknown }> | null = null;
            const raw = (h as Record<string, unknown>).changed_values;
            if (raw != null) {
              try {
                changedValues =
                  typeof raw === "string"
                    ? JSON.parse(raw)
                    : (raw as Record<string, { old: unknown; new: unknown }>);
              } catch {
                // Older audits predate the column; unreadable is unknown, never "nothing changed".
                changedValues = null;
              }
            }
            return {
              date: isoDay(h.change_date_time) ?? "",
              campaignId: campaignOfChange(h),
              resourceType,
              operation,
              fields,
              materialFields: [...new Set(words)],
              changedValues,
              changedBy: changedByOf(String(h.client_type ?? "")),
              userEmail: h.user_email == null ? null : String(h.user_email),
            };
          })
          .filter((c) => c.date !== ""),
      },
      brandSafetyExclusions: brandSafetyExclusionsOf(ctx.readDb("account_negative_criteria")),
      placementExcludedKeys: placementExcludedKeysOf(ctx.readDb(PLACEMENT_EXCLUSIONS_TABLE)),
      users: users.map((u) => ({ role: str(u.access_role), email: str(u.email_address_masked) })),
      conversionValueRules: {
        total: valueRules.length,
        enabled: valueRules.filter((r) => String(r.status) === "ENABLED").length,
        unconditional: valueRules
          .filter((r) => String(r.status) === "ENABLED" && valueRuleHasNoCondition(r))
          .map((r) => ({
            ruleId: String(r.rule_id ?? resourceId(r.rule_resource_name) ?? ""),
            operation: str(r.action_operation),
            value: num(r.action_value),
          })),
      },
      conversionValueRuleSets: {
        total: valueRuleSets.length,
        sets: valueRuleSets.map((s) => ({
          id: String(s.rule_set_id ?? resourceId(s.rule_set_resource_name) ?? ""),
          dimensions: s.dimensions_json == null ? null : arr(s.dimensions_json).map(String),
          rules: arr(s.rules_json).map(String),
        })),
      },
      conversionValueByRule:
        valueByRuleRows == null
          ? null
          : valueByRuleRows.map((r) => ({
              campaignId: String(r.campaign_id ?? ""),
              dimension: String(r.dimension ?? ""),
              value: num(r.conversions_value) ?? 0,
            })),
      conversionAdjustments: adjustments.length,
      offlineUserDataJobs: {
        total: offline.length,
        success: offline.filter((j) => String(j.status) === "SUCCESS").length,
        failed: offline.filter((j) => String(j.status) === "FAILED").length,
        sample: offlineJobsTruncated(
          offline.length,
          ctx.checkable(
            AUDIT_KEY_TABLE.offlineUserDataJobs ?? "offline_user_data_jobs",
            "offlineUserDataJobs",
          ).rowCount,
          ctx.capOf("offlineUserDataJobs"),
        ),
        jobs: offlineJobsNewestFirst(offline),
      },
      experiments: experimentRows.map((e) => ({
        id: String(e.experiment_id ?? resourceId(e.resource_name) ?? ""),
        name: str(e.name),
        status: str(e.status),
        type: str(e.type),
        armCampaignIds: armRows
          .filter((a) => String(a.experiment_resource_name) === String(e.resource_name))
          .flatMap((a) => arr(a.campaigns_json).map((c) => resourceId(c) ?? String(c))),
      })),
      biddingStrategies: strategies.map((s) => ({
        id: String(s.strategy_id ?? ""),
        name: str(s.name),
        type: str(s.type),
        status: str(s.status),
        targetRoas: num(s.target_roas),
        targetCpa: num(s.target_cpa),
        campaignCount: num(s.campaign_count),
        nonRemovedCampaignCount: num(s.non_removed_campaign_count),
      })),
      biddingOverrides: overrides.length,
      // whether the table could be read is the check's gate (gateOnData 'biddingOverrides'), not this list
      biddingDataExclusions: overrides
        .filter((o) => String(o.override_type ?? "").toUpperCase() === "DATA_EXCLUSION")
        .map((o) => ({
          name: str(o.name),
          status: str(o.status),
          scope: str(o.scope),
          start: isoDay(o.start_date_time),
          end: isoDay(o.end_date_time),
        })),
      simulations: simulations.length,
      customerConversionGoals: customerGoals,
      merchantCenter: {
        promotions: {
          total: promos.length,
          live: promos.filter((p) => String(p.promotion_status) === "LIVE").length,
          expired: promos.filter((p) => String(p.promotion_status) === "EXPIRED").length,
          stopped: promos.filter((p) => String(p.promotion_status) === "STOPPED").length,
          dated: promos.map((p) => ({
            title: str(p.title) ?? String(p.promotion_id ?? "promotion"),
            start: isoDay(p.start_date),
            end: isoDay(p.end_date),
          })),
        },
        returnPolicies: returns.length,
        accountIssues: mcIssues.length,
        shippingServices: shipping.length
          ? (num(shipping[0].service_count) ?? arr(shipping[0].services).length)
          : null,
        deliveryCountries: shipping.length
          ? [
              ...new Set(
                shipping.flatMap((row) =>
                  arr(row.services)
                    .filter((v: any) => v?.active !== false)
                    .flatMap((v: any) =>
                      arr(v?.deliveryCountries ?? v?.delivery_countries)
                        .map((c) => String(c).trim().toUpperCase())
                        .filter((c) => /^[A-Z]{2}$/.test(c)),
                    ),
                ),
              ),
            ].sort()
          : null,
        // R4-D review: the product sync keeps the first 20 services; more declared than read = a partial country list
        deliveryCountriesPartial: shipping.some(
          (row) => (num(row.service_count) ?? 0) > arr(row.services).length,
        ),
        competitiveVisibility: compVis.length,
        // itemsInvalid is null when ANY feed's items_invalid is null (unknown upload state) — never summed as 0
        // 09-29 (SH19): every stored feed product walked through the listing trees; null = catalog not loaded
        productCatalog: catalog.summary(),
        feeds: {
          total: feeds.length,
          itemsTotal: feeds.length
            ? feeds.reduce((s, f) => s + (num(f.items_total) ?? 0), 0)
            : null,
          itemsInvalid:
            feeds.length && feeds.every((f) => num(f.items_invalid) != null)
              ? feeds.reduce((s, f) => s + (num(f.items_invalid) ?? 0), 0)
              : null,
        },
      },
      keywordOpportunities: {
        total: kwOpps.length,
        alreadyTargeted: kwOpps.filter((k) => bool(k.already_targeted) === true).length,
      },
      paidOrganic: {
        rows: paidOrganic.length,
        terms: paidOrganic.map((p) => String(p.search_term ?? "")),
        // Phase 11 (TR07): the organic columns exist on the row once the migration
        // is applied; REST omits zeros, so a read with no organic data stores NULL.
        // Not read = columns absent, or the sync dropped the fields (marker note).
        organicRead: String(ctx.markers.get("paid_organic")?.error_message ?? "").startsWith(
          "organic fields not read",
        )
          ? 0
          : paidOrganic.filter((p) => Object.prototype.hasOwnProperty.call(p, "organic_queries"))
              .length,
        withOrganic: paidOrganic.filter(
          (p) => (num(p.organic_queries) ?? 0) > 0 || (num(p.organic_impressions) ?? 0) > 0,
        ).length,
      },
      shopLanguages: buyersAndLanguages.shopLanguages,
      priorYearDaily: buyersAndLanguages.priorYearDaily,
      shoppingCart: { rows: cart.length, sample: universe.cartSample },
      searchTerms: {
        rows: searchTermRows.length,
        sample: ctx.atCap("searchTerms"),
        cap: ctx.capOf("searchTerms"),
      },
      productSearchTerms: {
        rows: pst.length,
        synced: universe.productSearchTermsSynced && !universe.productSearchTermsNote,
      },
      dsaSearchTerms: { rows: dsa.length },
      placements: { rows: placements.rows },
      adPolicy: {
        rows: policy.length,
        sample: ctx.atCap("adPolicyData"),
        population: policyAttached.length,
        notApproved:
          policyAttached.length > 0
            ? policyAttached.filter(
                (p) => p.approval_status != null && String(p.approval_status) !== "APPROVED",
              ).length
            : null,
      },
      assetPerformance: {
        rows: assetPerf.length,
        sample: ctx.atCap("assetPerformance"),
        population: assetPerfAttached.length,
        labels: assetPerfAttached.length > 0 ? labelCounts : null,
      },
      outOfScope: { ...outOfScope, callData: callData.length },
      lsa,
    },
    children: {
      campaigns,
      budgets,
      conversionActions,
      negativeLists: negatives.lists,
      audienceLists: audienceListRows.map((l) => ({
        listId: String(l.list_id ?? ""),
        name: str(l.list_name),
        type: str(l.list_type),
        membershipStatus: str(l.membership_status),
        sizeForSearch: num(l.size_for_search),
        sizeForDisplay: num(l.size_for_display),
        ...audienceListDefinitionOf(l),
      })),
      extensions: extensions.account,
      orphanExtensions: extensions.orphans,
      landingPages: landingPages.nodes,
      products: universe.nodes,
      slices: acctSlices.families,
      orphanBidModifiers: slices.bidModifiers.orphans,
    },
    dataQuality: buildDataQuality(
      ctx,
      data,
      dbTables,
      negatives.campaignNegativesSynced,
      mcSync,
      m90.cost,
      m90.conv,
      dailyRows,
      countOrphanRows(ctx, data, dbTables),
    ),
    negativeIndex: negatives.index,
    coverage: { keys: [], consumed: 0, allowlisted: 0, unconsumedNonEmpty: [] },
    index: {
      campaignsById: new Map(campaigns.map((c) => [c.id, c] as const)),
      productsById: universe.byId,
      itemOverlap: computeItemOverlap(universe),
    },
  };
  model.notCheckable.push(...acctSlices.notCheckable);
  if (aw.lookbackUnknown)
    model.notCheckable.push(
      nc("window.maturity", "no conversion action lookback synced — nothing can be called settled"),
    );
  if (aw.source === "none")
    model.notCheckable.push(
      nc("window.calendar", "no daily series — the audit window cannot be placed on a calendar"),
    );
  if (!model.dataQuality.syncMarkersPresent)
    model.notCheckable.push(
      nc("sync.markers", "no status rows were supplied — every empty table is unknown, not clean"),
    );
  if (changeSample) model.sample.truncated = true;
  if (policyAttached.length === 0)
    model.notCheckable.push(
      nc(
        "SK15",
        `ad_policy: 0 of ${policy.length} rows join an audited ad (population 0) — approval state unknown, not "all approved"`,
      ),
    );
  if (assetPerfAttached.length === 0)
    model.notCheckable.push(
      nc(
        "SK14",
        `asset_performance: 0 of ${assetPerf.length} rows join an audited ad or PMax asset (population 0)`,
      ),
    );
  propagateTruncation(model, [...campaigns, ...universe.nodes]);
  model.coverage = buildCoverageReport(data, dbTables, ctx.consumed);
  return model;
}

/**
 * Rows that do not inner-join to this audit's entities. Join keys cast to
 * text (§G.7: ads / keywords ids are bigint, most others text). Only tables
 * with an entity key are counted; account-level tables (change_history,
 * …) are not orphans.
 */
export function countOrphanRows(
  ctx: BuildCtx,
  data: AccountData,
  dbTables: Record<string, any[]>,
): Record<string, number> {
  const rows = (k: string) => {
    const v = (data as any)[k];
    return Array.isArray(v) ? (v as any[]) : [];
  };
  const db = (t: string) => (Array.isArray(dbTables[t]) ? dbTables[t] : []);
  const campaigns = ctx.campaignIds;
  const adGroupIds = new Set(
    rows("adGroups")
      .filter((r) => campaigns.has(String(r.campaign_id)))
      .map((r) => String(r.ad_group_id)),
  );
  const adIds = new Set(
    rows("ads")
      .filter((r) => adGroupIds.has(String(r.ad_group_id)))
      .map((r) => String(r.ad_id)),
  );
  const assetGroupIds = new Set(
    rows("assetGroups")
      .filter((r) => campaigns.has(String(r.campaign_id)))
      .map((r) => String(r.asset_group_id)),
  );
  const pmaxAssetIds = new Set(
    rows("pmaxAssets")
      .filter((r) => assetGroupIds.has(String(r.asset_group_id)))
      .map((r) => String(r.asset_id)),
  );
  const declaredSets = new Set(
    rows("sharedNegativeLists").map((r) => String(r.shared_set_id ?? "")),
  );
  const byCampaign = (r: any) => campaigns.has(String(r.campaign_id ?? ""));
  const byAdGroup = (r: any) => adGroupIds.has(String(r.ad_group_id ?? ""));
  const byAssetGroup = (r: any) => assetGroupIds.has(String(r.asset_group_id ?? ""));
  const specs: [string, any[], (r: any) => boolean][] = [
    ["adGroups", rows("adGroups"), byCampaign],
    ["ads", rows("ads"), byAdGroup],
    ["keywords", rows("keywords"), byAdGroup],
    [
      "searchTerms",
      rows("searchTerms"),
      (r) => byAdGroup(r) || (r.ad_group_id == null && byCampaign(r)),
    ],
    [
      "dsaSearchTerms",
      rows("dsaSearchTerms"),
      (r) => byAdGroup(r) || (r.ad_group_id == null && byCampaign(r)),
    ],
    ["adPolicyData", rows("adPolicyData"), (r) => adIds.has(String(r.ad_id ?? ""))],
    // two joins: ad_resource '~<ad_id>' → ads, OR asset_id → pmax_assets of an audited asset group
    [
      "assetPerformance",
      rows("assetPerformance"),
      (r) => {
        const m = /~(\d+)$/.exec(String(r.ad_resource ?? ""));
        return (!!m && adIds.has(m[1] ?? "")) || pmaxAssetIds.has(String(r.asset_id ?? ""));
      },
    ],
    // population rule: ACCOUNT-level rows do not join a campaign / ad-group node → counted here (they still hang off the account node as children.extensions)
    // an ACCOUNT-level asset hangs off the account node: it points at no campaign, so it is no orphan
    [
      "adExtensions",
      rows("adExtensions"),
      (r) => String(r.level ?? "") === "ACCOUNT" || byCampaign(r),
    ],
    // members of a shared set that sharedNegativeLists does not declare (sets seen only in account_negatives)
    [
      "sharedNegativeListMembers",
      rows("sharedNegativeListMembers"),
      (r) => declaredSets.has(String(r.shared_set_id ?? "")),
    ],
    ["deviceData", rows("deviceData"), byCampaign],
    ["geographicData", rows("geographicData"), byCampaign],
    ["temporalData", rows("temporalData"), byCampaign],
    ["demographicData", rows("demographicData"), byCampaign],
    ["audiencePerformance", rows("audiencePerformance"), byCampaign],
    ["campaignAudiencePerf", rows("campaignAudiencePerf"), byCampaign],
    ["locationCriteria", rows("locationCriteria"), byCampaign],
    [
      "bidModifiers",
      rows("bidModifiers"),
      (r) => campaigns.has(resourceId(r.campaign_resource) ?? String(r.campaign_id ?? "")),
    ],
    ["impressionShare", rows("impressionShare"), byCampaign],
    ["campaignDailyMetrics", rows("campaignDailyMetrics"), byCampaign],
    ["campaignConversions", rows("campaignConversions"), byCampaign],
    ["campaignConversionGoals", rows("campaignConversionGoals"), byCampaign],
    ["shoppingSettings", rows("shoppingSettings"), byCampaign],
    ["assetGroups", rows("assetGroups"), byCampaign],
    ["pmaxAssets", rows("pmaxAssets"), byAssetGroup],
    ["pmaxSignals", rows("pmaxSignals"), byAssetGroup],
    ["pmaxListingGroups", rows("pmaxListingGroups"), byAssetGroup],
    ["pmaxChannelDistribution", rows("pmaxChannelDistribution"), byCampaign],
    ["pmaxChannelData", rows("pmaxChannelData"), byCampaign],
    ["pmaxSearchInsights", rows("pmaxSearchInsights"), byCampaign],
    ["pmaxSearchTerms", rows("pmaxSearchTerms"), byCampaign],
    ["adSchedulePerformance", rows("adSchedulePerformance"), byCampaign],
    [
      "simulations",
      rows("simulations"),
      (r) => {
        const m = /campaigns\/(\d+)/.exec(String(r.resource_name ?? ""));
        return !m || campaigns.has(m[1] ?? "");
      },
    ],
    [
      "experimentArms",
      rows("experimentArms"),
      (r) => arr(r.campaigns_json).some((c: unknown) => campaigns.has(resourceId(c) ?? "")),
    ],
    ["campaign_control_settings", db("campaign_control_settings"), byCampaign],
    ["placement_performance", db("placement_performance"), byCampaign],
    [VIDEO_METRICS_TABLE, db(VIDEO_METRICS_TABLE), byCampaign],
    [GEO_COUNTRIES_TABLE, db(GEO_COUNTRIES_TABLE), byCampaign],
    [NETWORK_SPLIT_TABLE, db(NETWORK_SPLIT_TABLE), byCampaign],
    [CAMPAIGN_LANGUAGES_TABLE, db(CAMPAIGN_LANGUAGES_TABLE), byCampaign],
    [PMAX_CAMPAIGN_PRODUCTS_TABLE, db(PMAX_CAMPAIGN_PRODUCTS_TABLE), byCampaign],
    ["dg_campaign_settings", db("dg_campaign_settings"), byCampaign],
    ["dg_assets", db("dg_assets"), byCampaign],
    ["dg_audience_signals", db("dg_audience_signals"), byCampaign],
    ["dg_channel_distribution", db("dg_channel_distribution"), byCampaign],
    ["dg_channel_controls", db("dg_channel_controls"), byCampaign],
    ["temporal_grid", db("temporal_grid"), byCampaign],
    [
      "campaign_negatives",
      db("campaign_negatives"),
      (r) =>
        campaigns.has(
          ctx.campaignUuidToId.get(String(r.campaign_id ?? "")) ?? String(r.campaign_id ?? ""),
        ),
    ],
    [
      "campaign_negatives_sync_marker",
      db("campaign_negatives_sync_marker"),
      (r) =>
        campaigns.has(
          ctx.campaignUuidToId.get(String(r.campaign_id ?? "")) ?? String(r.campaign_id ?? ""),
        ),
    ],
  ];
  const out: Record<string, number> = {};
  for (const [table, list, joins] of specs) {
    let n = 0;
    for (const r of list) if (!joins(r)) n++;
    if (list.length > 0 || n > 0) out[table] = n;
  }
  return out;
}

function buildDataQuality(
  ctx: BuildCtx,
  data: AccountData,
  dbTables: Record<string, any[]>,
  campaignNegativesSynced: Set<string>,
  mcSync: any[],
  campaignsCost: number | null,
  campaignsConv: number | null,
  dailyRows: any[],
  orphanRows: Record<string, number>,
): DataQuality {
  const tables: Record<string, TableQuality> = {};
  // offline jobs: exactly the cap is a full read; only a bigger sync count means more exist (MI12)
  const truncatedOf = (
    key: string,
    rows: number,
    cap: number | null,
    synced: number | null,
  ): boolean =>
    cap == null
      ? false
      : key === "offlineUserDataJobs"
        ? offlineJobsTruncated(rows, synced, cap)
        : rows >= cap;
  const quality = (key: string, table: string | null, rows: number): TableQuality => {
    const st = table
      ? ctx.checkable(table, key)
      : {
          checkable: "unknown" as Checkable,
          message: null,
          rowCount: null,
          source: "none" as const,
        };
    const cap = ctx.capOf(key);
    return {
      rows,
      checkable: st.checkable,
      markerRowCount: st.rowCount,
      errorMessage: st.source === "marker" ? st.message : null,
      cap,
      truncated: truncatedOf(key, rows, cap, st.rowCount),
      source: st.source,
    };
  };
  for (const [key, table] of Object.entries(AUDIT_KEY_TABLE)) {
    const v = (data as any)[key];
    tables[key] = quality(key, table, Array.isArray(v) ? v.length : 0);
    // A Merchant Center table with no sync_table_status row takes its marker
    // from the MC sync's own status table (so a positive built on
    // it is not stamped provisional; syncMarkers.ts does the same for metrics).
    const mcResource = MC_KEY_RESOURCE[key];
    if (mcResource && tables[key].source === "none") {
      const mc = mcSync.find((m) => String(m.resource ?? "") === mcResource);
      if (mc) {
        const checkable = mcMarkerStatus(String(mc.status ?? ""));
        tables[key] = {
          ...tables[key],
          checkable,
          markerRowCount: checkable === "ok" ? (num(mc.row_count) ?? 0) : num(mc.row_count),
          errorMessage: str(mc.error_detail),
          source: "mc",
        };
      }
    }
  }
  for (const [t, rows] of Object.entries(dbTables))
    tables[`db:${t}`] = quality(t, t, Array.isArray(rows) ? rows.length : 0);
  let dailyCost: number | null = null;
  let dailyConv: number | null = null;
  for (const r of dailyRows) {
    const c = num(r.cost);
    const v = num(r.conversions);
    if (c != null) dailyCost = (dailyCost ?? 0) + c;
    if (v != null) dailyConv = (dailyConv ?? 0) + v;
  }
  return {
    tables,
    syncMarkersPresent: ctx.markers.size > 0,
    legacyCounts: ctx.legacyCounts,
    campaignNegativesSynced: [...campaignNegativesSynced],
    orphanRows,
    contradictions: ctx.contradictions,
    merchantCenter: mcSync.map((m) => ({
      resource: String(m.resource ?? ""),
      status: String(m.status ?? ""),
      rowCount: num(m.row_count),
      errorDetail: str(m.error_detail),
    })),
    reconciliation: {
      campaignsCost,
      dailyCost,
      costDelta: campaignsCost != null && dailyCost != null ? campaignsCost - dailyCost : null,
      campaignsConv,
      dailyConv,
    },
  };
}

/** A self-contained engine input: rows, named tables and an id. */
export interface EngineSnapshot {
  data: AccountData;
  dbTables: Record<string, Row[]>;
  auditId: string;
}

export function buildAccountModelFromSnapshot(snapshot: EngineSnapshot): AccountNode {
  return buildAccountModel(snapshot.data, snapshot.dbTables, snapshot.auditId);
}
