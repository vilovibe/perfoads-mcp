// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BusinessType } from "../../shared/businessType.js";
import type { AccountProfile } from "../../shared/input.js";
import type { BaseNode } from "../types.js";
import type { AuditWindow } from "../windows.js";
import type { BidModifierNode } from "./BidModifierNode.js";
import type { BudgetNode } from "./BudgetNode.js";
import type { CampaignNode, CampaignType } from "./CampaignNode.js";
import type { ConversionActionNode } from "./ConversionActionNode.js";
import type { ExtensionNode } from "./ExtensionNode.js";
import type { LandingPageNode } from "./LandingPageNode.js";
import type { NegativeEntry, NegativeListNode } from "./NegativeListNode.js";
import type { ProductNode } from "./ProductNode.js";
import type { ProductCatalogServing } from "../productCatalog.js";
import type { SliceFamilies } from "./Slice.js";

export type Checkable = "ok" | "error" | "skipped" | "unknown";

export interface TableQuality {
  rows: number;
  /** from sync_table_status; 'unknown' when there is no marker (rule 5: zero rows with no marker is not "none found"). */
  checkable: Checkable;
  markerRowCount: number | null;
  errorMessage: string | null;
  /** fetch cap the loader applies (MAPPING.md); truncated when rows == cap. */
  cap: number | null;
  truncated: boolean;
  /** 'marker' = sync_table_status row; 'legacy' = audits.*_count column; 'mc' = mc_sync_status (Merchant Center tables); 'none'. */
  source: "marker" | "legacy" | "mc" | "none";
}

export interface DataQuality {
  tables: Record<string, TableQuality>;
  syncMarkersPresent: boolean;
  /** legacy audits.*_count values by AccountData key (only when the caller supplied the audit row). */
  legacyCounts: Record<string, number | null>;
  /** Google campaign ids whose campaign-level negatives carry a sync marker. */
  campaignNegativesSynced: string[];
  merchantCenter: {
    resource: string;
    status: string;
    rowCount: number | null;
    errorDetail: string | null;
  }[];
  /**
   * Rows per table that do NOT inner-join to this audit's own entities
   * (campaign_id / ad_group_id / ad_id / asset_group_id / keyword_id, all cast
   * to text). They never feed a node metric.
   */
  orphanRows: Record<string, number>;
  /** rows that contradict a documented Google rule (e.g. impressions on a callout in a PMax campaign) — surfaced, never obeyed silently. */
  contradictions: { table: string; rowId: string; rule: string; observed: string }[];
  /** campaigns vs dailyMetrics 90d spend / conversions. */
  reconciliation: {
    campaignsCost: number | null;
    dailyCost: number | null;
    costDelta: number | null;
    campaignsConv: number | null;
    dailyConv: number | null;
  };
}

export interface AudienceListSummary {
  listId: string;
  name: string | null;
  type: string | null;
  membershipStatus: string | null;
  sizeForSearch: number | null;
  sizeForDisplay: number | null;
  /**
   * Phase 11b (AS09): how Google defines the list; undefined / null = not read
   * (older sync, or the sync dropped the fields). Optional for hand-built models.
   *   ruleText      lower-cased string values of the rule-based list's INCLUDE operands (URLs, page types, event names)
   *   actionIds     conversion action ids a basic list collects on (basic_user_list.actions)
   *   lifeSpanDays  membership_life_span
   *   uploadKeyType Customer Match key (CONTACT_INFO / CRM_ID / MOBILE_ADVERTISING_ID)
   */
  ruleText?: string | null;
  actionIds?: string[] | null;
  lifeSpanDays?: number | null;
  uploadKeyType?: string | null | undefined;
}

export interface OfflineJob {
  id: string;
  type: string;
  status: string;
  failureReason: string;
  userListId: string;
}

/** One upload target (a customer list, or the store-sales upload when no list) judged on its newest jobs. */
export interface OfflineUploadTarget {
  /** list id, or the job type when the job targets no list */
  key: string;
  userListId: string;
  type: string;
  jobs: number;
  /** newest SUCCESS / FAILED job; null = every job read is still PENDING / RUNNING */
  latestFinished: OfflineJob | null;
  /** FAILED jobs since the last SUCCESS (0 when the latest finished one succeeded) */
  failedInARow: number;
  /** some SUCCESS is older than the failing streak (the list worked before) */
  succeededBefore: boolean;
  /** an earlier FAILED job that a later SUCCESS fixed */
  recovered: boolean;
}

/**
 * MI12: group the jobs (newest first) by what they upload to, and judge each
 * target on its LATEST finished job. Old failures followed by a success are
 * fine, and a PENDING / RUNNING job is not a failure.
 */
export function offlineUploadTargets(jobs: readonly OfflineJob[]): OfflineUploadTarget[] {
  const byKey = new Map<string, OfflineJob[]>();
  for (const j of jobs) {
    const key = j.userListId || j.type || "UNKNOWN";
    const list = byKey.get(key) ?? [];
    list.push(j);
    byKey.set(key, list);
  }
  return Array.from(byKey.entries()).flatMap(([key, js]) => {
    const head = js[0];
    if (!head) return [];
    const finished = js.filter((j) => j.status === "SUCCESS" || j.status === "FAILED");
    const latestFinished = finished[0] ?? null;
    const firstSuccess = finished.findIndex((j) => j.status === "SUCCESS");
    const failedInARow = firstSuccess === -1 ? finished.length : firstSuccess;
    return {
      key,
      userListId: head.userListId,
      type: head.type,
      jobs: js.length,
      latestFinished,
      failedInARow,
      succeededBefore: firstSuccess !== -1 && failedInARow > 0,
      recovered: firstSuccess === 0 && finished.some((j) => j.status === "FAILED"),
    };
  });
}

/**
 * MI12: the offline job read is cut only when MORE jobs exist than
 * were read: the sync's own count (its marker, up to the API's LIMIT 100) is
 * bigger than the rows loaded, or the rows run past the cap. An account with
 * exactly the cap's worth of uploads is complete, not a sample.
 */
export function offlineJobsTruncated(
  rowsRead: number,
  synced: number | null,
  cap: number | null,
): boolean {
  return (cap != null && rowsRead > cap) || (synced != null && synced > rowsRead);
}

/**
 * MI12: offline upload jobs, newest first. Job ids are int64 strings
 * that grow over time, so a longer id is newer and equal lengths compare as text.
 * `userListId` is the id at the end of `customers/X/userLists/ID` ('' = no list).
 */
export function offlineJobsNewestFirst(rows: readonly Record<string, unknown>[]): OfflineJob[] {
  return rows
    .map((j) => ({
      id: String(j.job_id ?? ""),
      type: String(j.type ?? ""),
      status: String(j.status ?? ""),
      failureReason: String(j.failure_reason ?? ""),
      userListId:
        String(j.user_list_resource_name ?? "")
          .split("/")
          .pop() ?? "",
    }))
    .sort((a, b) => b.id.length - a.id.length || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export interface AccountAttrs {
  customerId: string | null;
  currencyCode: string;
  merchantCenterConnected: boolean;
  optimizationScore: unknown;
  conversionTrackingSettings: Record<string, unknown> | null;
  /** what the caller says about the business (brand terms, declared type, spend band) */
  profile: AccountProfile | null;
  /**
   * A6 (rules 119, 134, 263, 264, 266, 267, 385). `detectBusinessType` used to
   * reach exactly one prompt string; it now reaches every check through
   * `CheckCtx.businessType` and the deny table in checks/businessTypeGate.ts.
   * `'unknown'` is a real answer and means ABSTAIN — rule 264 forbids applying
   * ROAS targets, CPL benchmarks, LSA or budget tiers without a classification.
   * It is never quietly read as 'ecommerce'.
   */
  businessType: BusinessType;
  /**
   * R3.8: the customer-acquisition goal table as a whole. `accountValue` is the
   * account default extra value per new customer (customer_lifecycle_goal).
   * not_checkable = table not loaded, no marker or a failed sync. Optional so
   * hand-built fixtures stay valid; absent reads as not loaded.
   */
  customerAcquisition?:
    | {
        state: "synced";
        accountValue: number | null;
        accountHighLifetimeValue: number | null;
        campaignRows: number;
      }
    | { state: "not_checkable"; note: string }
    | undefined;
  brandTokens: string[];
  campaignCounts: Record<CampaignType, number>;
  brandCost: number | null;
  brandValue: number | null;
  brandSpendShare: number | null;
  /**
   * Two different numbers, kept apart: `accountNegativesRows` = rows in
   * account_negatives;
   * `sharedListMemberTotalDeclared` = Σ shared_negative_lists.member_count
   *. `indexedUnique` = the
   * deduped member index across both member sources.
   */
  negatives: {
    accountNegativesRows: number;
    accountLevelRows: number;
    sharedListMemberRows: number;
    sharedListMemberTotalDeclared: number;
    listsDeclared: number;
    listsSeen: number;
    indexedUnique: number;
  };
  /** distinct callout texts across every level (incl. rows naming removed campaigns — assets are account objects); neverServed = no row of the text has servedStatus 'served'. */
  callouts: { distinctTexts: number; neverServed: string[] };
  landingPages: {
    total: number;
    productSync: number;
    taggedOther: number;
    untagged: number;
    http: number;
  };
  audienceLists: { total: number; withSearchSize: number };
  recommendationSubscriptions: { type: string; status: string | null }[];
  changeHistory: {
    rows: number;
    sample: boolean;
    cap: number | null;
    firstDate: string | null;
    lastDate: string | null;
    users: number;
    /**
     * Plan 5.2 (Gate 1 row 8): changes per editor, most first. NO email: an
     * editor is known by rank only ("login 1"), because the audit states a
     * concentration, not who. Rows with no user email are counted under
     * `noEditor`. Optional: a hand-built model (tests) may omit it.
     */
    editors?:
      | Array<{ changes: number; person: number; google: number; api: number; unknown: number }>
      | undefined;
    noEditor?: number | undefined;
    /** M18 (AS24): changes per day (yyyy-mm-dd) not made by Google's automation. Optional: a hand-built model may omit it. */
    madeByPeopleByDay?: Record<string, number> | undefined;
    /**
     * R3.6c: changes Google made itself — an auto-applied recommendation
     * (`auto_apply`) or Google's own tooling (`google_internal`) — with what they
     * touched in plain words. Optional: a hand-built model (tests) may omit it.
     */
    googleMade?: Array<{
      date: string;
      /** campaigns the row is about (a shared budget: several; unknown: none) */
      campaignIds: string[];
      resourceType: string;
      operation: string;
      kind:
        | "budget"
        | "bids and targets"
        | "keywords and targeting"
        | "on/off status"
        | "ads and assets"
        | "other settings";
      source: "auto_apply" | "google_internal";
    }>;
    /**
     * The changes that can actually move performance — budget, bidding target,
     * serving status — with their BEFORE and AFTER where the sync captured it.
     *
     * The model used to keep counts only, so TR03 ("a dated change explains the
     * move") could never name anything and returned `not_checkable` on both of
     * its exits.
     *
     * `changedBy` separates a person from a machine: GOOGLE_ADS_WEB_CLIENT is
     * someone in the interface, INTERNAL_TOOL is Google's own automation, and
     * GOOGLE_ADS_API includes our own mutations. Without that split an account
     * we have been testing against looks like a client changing everything.
     */
    material: Array<{
      date: string;
      campaignId: string | null;
      resourceType: string;
      operation: string;
      /** every field the row touched, as Google names them */
      fields: string[];
      /**
       * Just the fields that made this row MATERIAL, in plain words (budget,
       * target ROAS, bidding strategy, on/off status...). A row that flipped a
       * status often carries twenty other paths with it, so `fields` unioned
       * across an account produced a card listing 31 API field names — which is
       * what TR03 was printing. This is the readable subset.
       */
      materialFields: string[];
      changedValues: Record<string, { old: unknown; new: unknown }> | null;
      changedBy: "person" | "google" | "api" | "unknown";
      userEmail: string | null;
    }>;
  };
  /**
   * R3.6d: the content labels and app categories excluded at account level, by
   * name (account_negative_criteria). null = the table was not loaded.
   * Optional: a hand-built model (tests) may omit it.
   */
  brandSafetyExclusions?: { contentLabels: string[]; appCategories: string[] } | null | undefined;
  /**
   * Placement watch: places excluded at account level as criterion keys
   * ("PLACEMENT:host", "MOBILE_APPLICATION:2-com.x"), from
   * account_placement_exclusions. null = the table was not loaded.
   * Optional: a hand-built model (tests) may omit it.
   */
  placementExcludedKeys?: string[] | null | undefined;
  users: { role: string | null; email: string | null }[];
  conversionValueRules: {
    total: number;
    enabled: number;
    /** ENABLED rules with no condition the API exposes (geo incl. excluded, device, audience). Rule id → action. */
    unconditional: { ruleId: string; operation: string | null; value: number | null }[];
  };
  /**
   * conversion_value_rule_sets. `dimensions` is null on a row synced
   * (no dimensions_json column); `rules` = member rule
   * resource names. Live audit 62530f3f had ZERO sets beside 15 rules.
   */
  conversionValueRuleSets: {
    total: number;
    sets: { id: string; dimensions: string[] | null; rules: string[] }[];
  };
  /**
   * conversion_value_by_rule: recorded value per campaign x rule
   * dimension. null = the table did not load (never "no value"); [] = synced,
   * no row (no conversion value in the window at all).
   */
  conversionValueByRule: { campaignId: string; dimension: string; value: number }[] | null;
  conversionAdjustments: number;
  /**
   * `jobs`: one entry per upload job, NEWEST FIRST (job ids grow), so
   * MI12 can judge each list on its latest upload instead of counting every
   * non-SUCCESS job in the read (old failures a later upload fixed, and jobs
   * still PENDING / RUNNING, are not problems). `userListId` = '' for a job
   * that targets no list (store sales).
   */
  offlineUserDataJobs: {
    total: number;
    success: number;
    failed: number;
    sample: boolean;
    jobs?: OfflineJob[] | undefined;
  };
  experiments: {
    id: string;
    name: string | null;
    status: string | null;
    type: string | null;
    armCampaignIds: string[];
  }[];
  biddingStrategies: {
    id: string;
    name: string | null;
    type: string | null;
    status: string | null;
    targetRoas: number | null;
    targetCpa: number | null;
    campaignCount: number | null;
    nonRemovedCampaignCount: number | null;
    /** M10 fix round: the max CPC cap in the account currency (0 = none); null / absent = not read. */
    cpcBidCeiling?: number | null;
  }[];
  biddingOverrides: number;
  /**
   * R4-D (MI18): the data exclusions in bidding_overrides (override_type
   * DATA_EXCLUSION), as calendar days. Whether the table was read is the check's
   * gate, not this list. Optional for hand-built models.
   */
  biddingDataExclusions?:
    | {
        name: string | null;
        status: string | null;
        scope: string | null;
        start: string | null;
        end: string | null;
      }[]
    | null
    | undefined;
  simulations: number;
  customerConversionGoals: { category: string; origin: string; biddable: boolean }[];
  merchantCenter: {
    /** dated (Round 4 item 10): each promotion's name and start / end day; optional for hand-built models. */
    promotions: {
      total: number;
      live: number;
      expired: number;
      stopped: number;
      dated?: { title: string; start: string | null; end: string | null }[];
    };
    returnPolicies: number;
    accountIssues: number;
    shippingServices: number | null;
    /** R4-D (SL11): the countries Merchant Center shipping delivers to (upper-case codes); null = no shipping row. Optional for hand-built models. */
    deliveryCountries?: string[] | null | undefined;
    /** R4-D review: Merchant Center declares more shipping services than the sync read, so deliveryCountries may be missing countries. */
    deliveryCountriesPartial?: boolean | undefined;
    competitiveVisibility: number;
    /** 09-29 (SH19): the full stored catalog vs the listing trees; null = not loaded. Optional for hand-built models. */
    productCatalog?: ProductCatalogServing | null | undefined;
    feeds: { total: number; itemsTotal: number | null; itemsInvalid: number | null };
  };
  keywordOpportunities: { total: number; alreadyTargeted: number };
  /**
   * `organicRead` / `withOrganic` (Phase 11, TR07): rows synced with the organic
   * fields read (columns present, not dropped by the sync's retry; NULL values =
   * Google sent no organic figure), and rows where the site also showed unpaid.
   * Optional for hand-built models.
   */
  paidOrganic: { rows: number; terms: string[]; organicRead?: number; withOrganic?: number };
  /**
   * Phase 11 (SL12): the languages the shop's Merchant Center feed is written
   * in (content language per product, base codes). not_synced = no Merchant
   * Center product sync, table not loaded or failed. partial = counted over a
   * capped feed crawl. Optional for hand-built models.
   */
  shopLanguages?:
    | {
        state: "synced";
        source: "merchant_center_feed";
        languages: { code: string; products: number }[];
        partial: boolean;
      }
    | { state: "not_synced"; note: string }
    | undefined;
  /**
   * Phase 11b (TR04): account daily totals for the audit window one year
   * earlier (364 days back, +14-day buffer). synced with no rows = Google
   * returned nothing (account younger than a year, or no spend then).
   * Optional for hand-built models.
   */
  priorYearDaily?:
    | { state: "synced"; rows: { date: string; cost: number; conv: number; value: number }[] }
    | { state: "not_synced"; note: string }
    | undefined;
  shoppingCart: { rows: number; sample: boolean };
  searchTerms: { rows: number; sample: boolean; cap: number | null };
  productSearchTerms: { rows: number; synced: boolean };
  dsaSearchTerms: { rows: number };
  placements: { rows: number };
  /** ONLY over rows that join an audited ad. population 0 → notApproved null (never "no disapproved ads" from an empty population, §A.0). */
  adPolicy: { rows: number; sample: boolean; population: number; notApproved: number | null };
  /** ONLY over rows that join an audited ad (ad_resource ~<ad_id>) or a PMax asset (asset_id). population 0 → labels null. */
  assetPerformance: {
    rows: number;
    sample: boolean;
    population: number;
    labels: Record<string, number> | null;
  };
  /** allowlisted out-of-scope keys (coverage.ts) — presence only. */
  outOfScope: Record<string, number>;
  /**
   * Phase 11: Local Services Ads rows (checks PR04-PR07). Optional so hand-built
   * models stay valid; absent or `hasCampaign: false` = the account runs no LSA.
   */
  lsa?: LsaAttrs | undefined;
}

export interface LsaLead {
  id: string;
  type: string | null;
  status: string | null;
  /** creation_date_time as synced ('YYYY-MM-DD HH:MM:SS', account time zone). */
  createdAt: string | null;
  charged: boolean;
  /** credit_details.credit_state: PENDING (credit asked) / CREDITED; null = never disputed. */
  creditState: string | null;
}

export interface LsaConversation {
  id: string;
  /** lead id parsed from the lead resource name; '' when unreadable. */
  leadId: string;
  channel: string | null;
  participantType: string | null;
  eventTime: string | null;
  /** null = no duration synced (the sync stores 0 as null). */
  callDurationMs: number | null;
}

export interface LsaVerification {
  id: string;
  type: string | null;
  status: string | null;
  licenseType: string | null;
  licenseExpiry: string | null;
  insuranceExpiry: string | null;
}

export interface LsaAttrs {
  /** at least one LOCAL_SERVICES campaign on the account */
  hasCampaign: boolean;
  leads: LsaLead[];
  conversations: LsaConversation[];
  verifications: LsaVerification[];
}

export interface AccountChildren {
  campaigns: CampaignNode[];
  budgets: BudgetNode[];
  conversionActions: ConversionActionNode[];
  /** shared lists + account-level negatives (members in negativeIndex). */
  negativeLists: NegativeListNode[];
  audienceLists: AudienceListSummary[];
  /** level=ACCOUNT extension rows (campaign_id = 'CUSTOMER'). */
  extensions: ExtensionNode[];
  /** rows naming a campaign outside the audited set. */
  orphanExtensions: ExtensionNode[];
  landingPages: LandingPageNode[];
  /** the product universe: products slice ∪ shopping_products, keyed by lowercased id. */
  products: ProductNode[];
  slices: SliceFamilies;
  orphanBidModifiers: BidModifierNode[];
}

export interface NegativeIndex {
  /** listId → members (kept off the tree). */
  byList: Map<string, NegativeEntry[]>;
  account: NegativeEntry[];
  byCampaign: Map<string, NegativeEntry[]>;
}

export interface CoverageReport {
  keys: {
    key: string;
    rows: number;
    consumed: boolean;
    allowlisted: boolean;
    reason: string | null;
  }[];
  consumed: number;
  allowlisted: number;
  /** non-empty keys neither consumed nor allowlisted — must be [] (tested). */
  unconsumedNonEmpty: string[];
}

export interface AccountNode extends BaseNode<"account"> {
  auditId: string;
  attrs: AccountAttrs;
  window: AuditWindow;
  children: AccountChildren;
  dataQuality: DataQuality;
  negativeIndex: NegativeIndex;
  coverage: CoverageReport;
  index: {
    campaignsById: Map<string, CampaignNode>;
    productsById: Map<string, ProductNode>;
    /** Shopping ↔ PMax item overlap (G.5 / SH12). Shopping side only when shopping_settings is synced for a Shopping campaign. */
    itemOverlap: { productId: string; pmaxCampaignIds: string[]; shoppingCampaignIds: string[] }[];
  };
}

/** §G.0: AccountModel = AccountNode. */
export type AccountModel = AccountNode;
