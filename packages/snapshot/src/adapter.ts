// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// AccountSnapshot -> the check engine's EvidenceInput.
//
// - Rows: the readers' typed camelCase rows become the snake_case rows the engine reads
//   (campaign_id, cost, conversion_value, ...). Money becomes a number in account currency;
//   impression share stays a fraction (0.2 = 20%); free text is unwrapped (the engine only
//   reads it; every Google string in a check result is wrapped again on the way out).
// - Status rows: ONE per table, from the reader parts that feed it; the worst status wins.
//   A table no reader feeds gets no status row and no rows, so every check that needs it
//   reports not_run ("not read"), never clean.
// - Caps: each table's reader limit, as the snapshot recorded it per part (daily 50,000,
//   change history 9,999, PMax terms 2,000 per campaign, ...). A part that hit its limit or
//   ran out of time sets the cap to the rows it gave, so the engine treats it as a sample.
// - The account series is filled to every day of the window (Google sends no row for a day
//   with no activity). Campaign days stay as read: the engine counts them as days it ran.

import {
  AUDIT_KEY_TABLE,
  listChecks,
  MERCHANT_CENTER_NOT_READ,
  type AccountDataArrayKey,
  type ClientContextInput,
  type CheckSettingsInput,
  type EvidenceInput,
  type Row,
} from "@perfoads/checks";
import { isAbsentSection, SNAPSHOT_SECTIONS, type SnapshotSectionName } from "./build.js";
import type { AccountSnapshot, SectionStatus, SnapshotSection } from "./schema.js";

type Raw = Record<string, unknown>;

// ---- value helpers (rows came through JSON: check every field) ----

const obj = (v: unknown): Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** A decimal string or number -> number; anything else null. */
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** {"untrusted": "..."} (or a plain string) -> the text. */
const text = (v: unknown): string | null => (typeof v === "string" ? v : str(obj(v).untrusted));
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** The five metrics, as the engine names them; `valueKey` differs on keywords. */
const metricsOf = (m: unknown, valueKey = "conversion_value"): Row => {
  const x = obj(m);
  return {
    cost: num(x.cost),
    clicks: num(x.clicks),
    impressions: num(x.impressions),
    conversions: num(x.conversions),
    [valueKey]: num(x.conversionsValue),
  };
};

const MINUTES: Readonly<Record<string, string>> = {
  ZERO: "00",
  FIFTEEN: "15",
  THIRTY: "30",
  FORTY_FIVE: "45",
};

/** "MONDAY 9:00-17:30": the engine's ad-schedule key. null when any piece is missing. */
const scheduleKey = (s: unknown): string | null => {
  const x = obj(s);
  const day = str(x.dayOfWeek);
  const sh = num(x.startHour);
  const eh = num(x.endHour);
  const sm = MINUTES[String(x.startMinute ?? "ZERO")];
  const em = MINUTES[String(x.endMinute ?? "ZERO")];
  return day && sh !== null && eh !== null && sm && em ? `${day} ${sh}:${sm}-${eh}:${em}` : null;
};

/** change_event resource type -> the resource-name collection the engine joins on. */
const COLLECTIONS: Readonly<Record<string, string>> = {
  CAMPAIGN: "campaigns",
  CAMPAIGN_BUDGET: "campaignBudgets",
  CAMPAIGN_CRITERION: "campaignCriteria",
  CAMPAIGN_ASSET: "campaignAssets",
  CAMPAIGN_ASSET_SET: "campaignAssetSets",
  CAMPAIGN_SHARED_SET: "campaignSharedSets",
  AD_GROUP: "adGroups",
  AD_GROUP_AD: "adGroupAds",
  AD_GROUP_CRITERION: "adGroupCriteria",
  AD_GROUP_BID_MODIFIER: "adGroupBidModifiers",
  AD_GROUP_ASSET: "adGroupAssets",
  AD: "ads",
  ASSET: "assets",
  ASSET_GROUP: "assetGroups",
  ASSET_SET: "assetSets",
  BIDDING_STRATEGY: "biddingStrategies",
  SHARED_SET: "sharedSets",
  CUSTOMER_ASSET: "customerAssets",
};

/** Google's resource name of a changed resource, rebuilt from its type and ids. */
const resourceNameOf = (customerId: string, type: string | null, ids: unknown): string => {
  const parts = Array.isArray(ids) ? ids.filter((i): i is string => typeof i === "string") : [];
  const collection = (type && COLLECTIONS[type]) ?? (type ?? "unknown").toLowerCase();
  return `customers/${customerId}/${collection}/${parts.join("~")}`;
};

// ---- tables ----

/** The engine's named tables (EvidenceInput.tables) the snapshot fills. */
type DbTable =
  | "temporal_grid"
  | "campaign_network_split"
  | "conversion_action_daily"
  | "conversion_value_by_rule"
  | "campaign_negatives"
  | "campaign_negatives_sync_marker"
  | "account_negative_criteria"
  | "campaign_control_settings"
  | "pmax_placements"
  | "account_daily_prior_year"
  | "products_catalog"
  | "shop_languages"
  | "pmax_campaign_products"
  | "placement_performance"
  | "geo_countries"
  | "campaign_languages"
  | "video_campaign_metrics"
  | "dg_campaign_settings"
  | "dg_assets"
  | "dg_audience_signals"
  | "dg_channel_distribution"
  | "dg_channel_controls"
  | "account_placement_exclusions";

interface TableSpec {
  /** AccountData key, or (with db) the engine's named table */
  key: AccountDataArrayKey | DbTable;
  /** the rows go to EvidenceInput.tables under `key` (absent = not read) */
  db?: boolean;
  section: SnapshotSectionName;
  /** Reader parts this table's rows come from: their worst status is the table's status. */
  parts: readonly string[];
  /** Parts of a second section the rows also come from (counted in the status the same way). */
  also?: { section: SnapshotSectionName; parts: readonly string[] };
  /** "parts" = the largest row limit of its parts (as read); null = rows merged or joined, no limit to compare. */
  cap: "parts" | null;
  rows: (s: SnapshotSection, snap: AccountSnapshot) => Row[];
  /** Rows Google returned, when the reader keeps fewer than it read (an embedded list). */
  total?: (s: SnapshotSection) => number;
  /** The rows are a cut of what Google holds (an embedded list kept short): a sample. */
  cut?: (s: SnapshotSection) => boolean;
  /**
   * The campaigns a per-campaign table holds no rows for because they were not read (past a
   * limit, failed or cut): written on the ok status row in the engine's "coverage partial:
   * campaigns not read: 1,2" form, so those campaigns are unknown, never "none".
   */
  notReadCampaigns?: (s: SnapshotSection) => string[];
  /** Why the table was not read although its parts ran (e.g. Google refused the fields). */
  notRead?: (s: SnapshotSection) => string | null;
  /**
   * A plain note on an ok read, written on its status row (e.g. "truncated: ..." when the
   * engine reads a sample from the note rather than from the row limit).
   */
  okNote?: (s: SnapshotSection, sample: boolean) => string | null;
}

const rowsOf = (s: SnapshotSection): Raw[] => s.rows.map(obj);

/**
 * the status note of a capped per-campaign product read. Starts with "truncated" (the
 * engine's sample test) and carries `cutoff_cost=<n>` when the split read knows it (the engine's
 * cutoffCostOfMarker). Same format as the PerfoAds app's campaignProductsTruncatedMarker.
 */
export const campaignProductsTruncatedNote = (s: SnapshotSection): string => {
  const read = obj(s.extra?.campaignProductsRead);
  const reason = typeof read.truncatedReason === "string" ? read.truncatedReason : null;
  const cutoff = num(read.cutoffCost);
  return `truncated: ${reason ?? "the product read hit its row limit"} (the highest-cost rows kept)${cutoff !== null ? `; cutoff_cost=${(Math.ceil(cutoff * 100) / 100).toFixed(2)}` : ""}`;
};
/** A list of numeric ids (campaign ids) from an extra field; anything else is dropped. */
const textsOrIds = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).filter(
    (x): x is string => typeof x === "string" && /^\d{1,20}$/.test(x),
  );
const kind = (s: SnapshotSection, k: string) => rowsOf(s).filter((r) => r.kind === k);
/** Negative rows carry their level (ad_group, campaign, shared_list, account), not a kind. */
const level = (s: SnapshotSection, l: string) => rowsOf(s).filter((r) => r.level === l);
const partRows = (s: SnapshotSection, part: string): number =>
  s.parts.find((p) => p.part === part)?.rows_read ?? 0;
const partOf = (s: SnapshotSection, part: string) => s.parts.find((p) => p.part === part);
const arrayOf = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj) : []);
/** The conversions reader's snapshot detail (extra.detail). */
const detailOf = (s: SnapshotSection): Raw => obj(s.extra?.detail);
const textsOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map(text).filter((t): t is string => t !== null);

/** Day-overlap with the performance window (inclusive). Unknown dates overlap. */
const inWindow = (r: Raw, snap: AccountSnapshot): boolean => {
  const { start_date: start, end_date: end } = snap.date_ranges.performance;
  const from = str(r.startDateTime)?.slice(0, 10) ?? null;
  const to = str(r.endDateTime)?.slice(0, 10) ?? null;
  return (from === null || from <= end) && (to === null || to >= start);
};

const ZERO_METRICS: Row = {
  cost: 0,
  clicks: 0,
  impressions: 0,
  conversions: 0,
  conversion_value: 0,
};

/** Every day of the performance window, oldest first. */
const daysOf = (snap: AccountSnapshot): string[] => {
  const { start_date: start, end_date: end } = snap.date_ranges.performance;
  const out: string[] = [];
  for (
    let t = Date.parse(`${start}T00:00:00Z`);
    t <= Date.parse(`${end}T00:00:00Z`);
    t += 86_400_000
  )
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

const campaignRowsOf = (snap: AccountSnapshot): Raw[] =>
  (snap.sections.campaigns?.rows ?? []).map(obj);

/**
 * The campaigns a bidding adjustment applies to: its own list (CAMPAIGN scope), every
 * campaign of the account (CUSTOMER), or every campaign of its channel types (CHANNEL).
 */
const scopedCampaigns = (r: Raw, snap: AccountSnapshot): string[] => {
  const scope = str(r.scope);
  const all = campaignRowsOf(snap);
  if (scope === "CUSTOMER") return all.map((c) => str(c.id)).filter((x): x is string => !!x);
  if (scope === "CHANNEL") {
    const channels = new Set(Array.isArray(r.channelTypes) ? r.channelTypes.map(String) : []);
    return all
      .filter((c) => channels.has(String(c.channelType ?? "")))
      .map((c) => str(c.id))
      .filter((x): x is string => !!x);
  }
  return Array.isArray(r.campaignIds) ? r.campaignIds.map(String) : [];
};

/** {field: {old, new}} with wrapped text unwrapped (the engine reads the values). */
const plainValues = (v: object): Record<string, { old: unknown; new: unknown }> => {
  const val = (x: unknown) => (x !== null && typeof x === "object" ? text(x) : x);
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, { old: val(obj(x).old), new: val(obj(x).new) }]),
  );
};

/** A Google Ads product as the engine's product row (cost in micros, as the engine reads it). */
const productRow = (r: Raw): Row => {
  const m = obj(r.metrics);
  const cost = num(m.cost);
  const labels = Array.isArray(r.customLabels) ? r.customLabels : [];
  return {
    product_id: text(r.itemId),
    title: text(r.title),
    brand: text(r.brand),
    product_type: text(r.productType),
    // one row per (Merchant Center account, channel, language, feed label, item id)
    merchant_id: str(r.merchantId),
    channel: str(r.channel),
    language_code: str(r.languageCode),
    feed_label: text(r.feedLabel),
    ...Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`custom_label_${i}`, text(labels[i])])),
    cost_micros: cost === null ? null : Math.round(cost * 1_000_000),
    clicks: num(m.clicks),
    impressions: num(m.impressions),
    conversions: num(m.conversions),
    conversion_value: num(m.conversionsValue),
  };
};

export const TABLES: readonly TableSpec[] = [
  {
    key: "dailyMetrics",
    section: "daily_metrics",
    parts: ["account_daily"],
    cap: "parts",
    rows: (s, snap) => {
      const byDay = new Map(
        kind(s, "account_day").map((r) => [str(r.date) ?? "", metricsOf(r.metrics)] as const),
      );
      return daysOf(snap).map((d) => ({
        metric_date: d,
        ...(byDay.get(d) ?? ZERO_METRICS),
      }));
    },
  },
  {
    key: "campaignDailyMetrics",
    section: "daily_metrics",
    parts: ["campaign_daily"],
    cap: "parts",
    rows: (s) =>
      kind(s, "campaign_day").map((r) => ({
        campaign_id: str(r.campaignId),
        metric_date: str(r.date),
        ...metricsOf(r.metrics),
      })),
  },
  {
    key: "deviceData",
    section: "daily_metrics",
    parts: ["campaign_device"],
    cap: "parts",
    rows: (s) =>
      kind(s, "campaign_device").map((r) => ({
        campaign_id: str(r.campaignId),
        device: str(r.device),
        ...metricsOf(r.metrics),
      })),
  },
  {
    key: "campaigns",
    section: "campaigns",
    parts: ["campaigns", "campaign_metrics"],
    cap: "parts",
    rows: (s, snap) => {
      // the last day each campaign spent, from the daily series (a paused campaign's last activity)
      const lastActive = new Map<string, string>();
      for (const d of snap.sections.daily_metrics
        ? kind(snap.sections.daily_metrics, "campaign_day")
        : []) {
        const cid = str(d.campaignId);
        const day = str(d.date);
        if (!cid || !day || (num(obj(d.metrics).cost) ?? 0) <= 0) continue;
        if ((lastActive.get(cid) ?? "") < day) lastActive.set(cid, day);
      }
      // Performance Max campaigns with Local Services on (their leads are Local Services leads)
      const ids: unknown = snap.sections.local_services?.extra?.campaignIds;
      const lsaIds = new Set(
        Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [],
      );
      return rowsOf(s).map((r) => {
        const portfolio = str(r.portfolioStrategyId);
        const net = obj(r.networks);
        return {
          campaign_id: str(r.id),
          name: text(r.name),
          status: str(r.status),
          type: str(r.channelType),
          ...(str(r.channelType) === "PERFORMANCE_MAX" && lsaIds.has(String(str(r.id)))
            ? { local_services_enabled: true }
            : {}),
          ...metricsOf(r.metrics),
          budget: num(r.dailyBudget),
          budget_id: str(r.budgetId),
          bidding_strategy_type: str(r.biddingStrategyType),
          // Google's learning state (null in snapshots built before it was read)
          primary_status: str(r.primaryStatus),
          bidding_strategy_system_status: str(r.biddingStrategySystemStatus),
          target_roas: num(r.targetRoas),
          target_cpa: num(r.targetCpa),
          bidding_strategy_source: portfolio ? "portfolio" : "standard",
          bidding_strategy_resource: portfolio
            ? `customers/${snap.account.customer_id}/biddingStrategies/${portfolio}`
            : null,
          geo_target_type: str(r.geoTargetType),
          last_active_date: lastActive.get(str(r.id) ?? "") ?? null,
          // the engine reads Google's own (camelCase) field names here
          // null where the settings do not apply (types other than Search and Shopping)
          network_settings:
            r.networks == null
              ? null
              : {
                  targetGoogleSearch: bool(net.googleSearch),
                  targetSearchNetwork: bool(net.searchPartners),
                  targetContentNetwork: bool(net.display),
                },
        };
      });
    },
  },
  {
    key: "impressionShare",
    section: "campaigns",
    parts: ["campaign_metrics"],
    cap: "parts",
    // fractions as Google sends them (0.2 = 20%); one row per campaign that has a share.
    // recent_*: the window's last weeks (extra.recent); recent_start null = not read. A
    // campaign with no recent row had no activity then: 0 spend, share unknown.
    rows: (s) => {
      const recent = obj(s.extra?.recent);
      const read = Array.isArray(recent.campaigns);
      const byId = new Map(arrayOf(recent.campaigns).map((r) => [str(r.campaignId), r]));
      return rowsOf(s)
        .map((r) => {
          const rec = byId.get(str(r.id));
          return {
            campaign_id: str(r.id),
            search_impression_share: num(r.searchImpressionShare),
            search_top_impression_share: num(r.searchTopImpressionShare),
            search_absolute_top_impression_share: num(r.searchAbsoluteTopImpressionShare),
            search_budget_lost_impression_share: num(r.searchBudgetLostImpressionShare),
            search_rank_lost_impression_share: num(r.searchRankLostImpressionShare),
            recent_start: read ? str(recent.startDate) : null,
            recent_end: read ? str(recent.endDate) : null,
            recent_cost: read ? (rec ? num(rec.cost) : 0) : null,
            recent_conversion_value: read ? (rec ? num(rec.conversionsValue) : 0) : null,
            recent_budget_lost_impression_share: rec
              ? num(rec.searchBudgetLostImpressionShare)
              : null,
          };
        })
        .filter(
          (r) =>
            r.search_impression_share !== null ||
            r.search_budget_lost_impression_share !== null ||
            r.search_rank_lost_impression_share !== null,
        );
    },
  },
  {
    key: "adGroups",
    section: "ad_groups",
    parts: ["ad_groups"],
    cap: "parts",
    rows: (s) =>
      rowsOf(s).map((r) => ({
        ad_group_id: str(r.id),
        campaign_id: str(r.campaignId),
        name: text(r.name),
        status: str(r.status),
        type: str(r.type),
        cpc_bid: num(r.cpcBid),
        ...metricsOf(r.metrics),
      })),
  },
  {
    key: "keywords",
    section: "keywords",
    parts: ["keywords"],
    cap: "parts",
    rows: (s) =>
      rowsOf(s).map((r) => ({
        keyword_id: str(r.criterionId),
        campaign_id: str(r.campaignId),
        ad_group_id: str(r.adGroupId),
        text: text(r.text),
        match_type: str(r.matchType),
        status: str(r.status),
        is_negative: false,
        ...metricsOf(r.metrics, "conversions_value"),
        quality_score: num(r.qualityScore),
        expected_ctr: str(r.expectedCtr),
        ad_relevance: str(r.adRelevance),
        landing_page_experience: str(r.landingPageExperience),
        cpc: num(r.cpcBid),
        first_page_cpc: num(r.firstPageCpc),
        top_of_page_cpc: num(r.topOfPageCpc),
        first_position_cpc: num(r.firstPositionCpc),
      })),
  },
  {
    key: "searchTerms",
    section: "search_terms",
    parts: ["search_terms"],
    // rows are merged per term + campaign + ad group, so a row count says nothing about the cap
    cap: null,
    rows: (s) =>
      rowsOf(s)
        .filter((r) => r.pmax !== true)
        .map((r) => ({
          campaign_id: str(r.campaignId),
          ad_group_id: str(r.adGroupId),
          search_term: text(r.searchTerm),
          status: str(r.status),
          match_type: str(r.matchType),
          keyword_criterion_id: str(obj(r.keyword).criterionId),
          // the keyword's own ad group: the engine keys a keyword by ad group + criterion id
          keyword_ad_group_id: str(obj(r.keyword).adGroupId),
          ...metricsOf(r.metrics),
        })),
  },
  {
    key: "pmaxSearchTerms",
    section: "search_terms",
    parts: ["pmax_campaigns", "pmax_terms"],
    cap: null,
    rows: (s) =>
      rowsOf(s)
        .filter((r) => r.pmax === true)
        .map((r) => ({
          campaign_id: str(r.campaignId),
          ad_group_id: null,
          search_term: text(r.searchTerm),
          status: str(r.status),
          ...metricsOf(r.metrics),
        })),
  },
  {
    key: "campaignBudgets",
    section: "budgets_and_bidding",
    parts: ["budgets"],
    cap: "parts",
    rows: (s) =>
      rowsOf(s).map((r) => ({
        budget_id: str(r.id),
        name: text(r.name),
        amount: num(r.amount),
        status: str(r.status),
        delivery_method: str(r.deliveryMethod),
        period: str(r.period),
        type: str(r.type),
        shared: bool(r.shared),
        reference_count: num(r.referenceCount),
      })),
  },
  {
    key: "biddingStrategies",
    section: "budgets_and_bidding",
    parts: ["bidding_strategies"],
    cap: "parts",
    rows: (s) =>
      (Array.isArray(s.extra?.biddingStrategies) ? s.extra.biddingStrategies : [])
        .map(obj)
        .map((r) => ({
          strategy_id: str(r.id),
          name: text(r.name),
          type: str(r.type),
          status: str(r.status),
          target_roas: num(r.targetRoas),
          target_cpa: num(r.targetCpa),
          non_removed_campaign_count: num(r.nonRemovedCampaignCount),
          // null = an older snapshot or a type with no cap (AS02 then leaves shared brand Shopping unjudged)
          cpc_bid_ceiling: num(r.maxCpc),
        })),
    // the reader returns the first 50 strategies: Google's count says whether that is all
    total: (s) => partRows(s, "bidding_strategies"),
  },
  {
    key: "bidModifiers",
    section: "bid_modifiers",
    parts: ["criteria"],
    cap: "parts",
    rows: (s) =>
      rowsOf(s)
        .filter((r) => r.negative !== true)
        .map((r) => {
          const type = str(r.type);
          const geo = str(r.geoTargetConstantId);
          return {
            campaign_id: str(r.campaignId),
            criterion_id: str(r.criterionId),
            bid_modifier: num(r.bidModifier),
            modifier_source: type,
            criterion_key:
              type === "DEVICE"
                ? str(r.device)
                : type === "LOCATION"
                  ? geo && `geoTargetConstants/${geo}`
                  : type === "AD_SCHEDULE"
                    ? scheduleKey(r.schedule)
                    : null,
            status: str(r.status),
          };
        }),
  },
  {
    // targeted AND excluded locations: an excluded country is one the campaign cannot reach
    key: "locationCriteria",
    section: "bid_modifiers",
    parts: ["criteria", "excluded_locations"],
    cap: "parts",
    rows: (s) =>
      rowsOf(s)
        .filter((r) => str(r.type) === "LOCATION")
        .map((r) => ({
          campaign_id: str(r.campaignId),
          criterion_id: str(r.criterionId),
          location_id: str(r.geoTargetConstantId),
          is_negative: r.negative === true,
          bid_modifier: num(r.bidModifier),
          status: str(r.status),
        })),
  },
  {
    key: "biddingOverrides",
    section: "bidding_adjustments",
    parts: ["data_exclusions", "seasonality_adjustments"],
    cap: null,
    // only the adjustments that overlap the measured window bear on its numbers
    rows: (s, snap) =>
      rowsOf(s)
        .filter((r) => inWindow(r, snap))
        .map((r): Raw => ({ ...r, campaignIds: scopedCampaigns(r, snap) }))
        .map((r) => ({
          override_type: r.kind === "data_exclusion" ? "DATA_EXCLUSION" : "SEASONALITY_ADJUSTMENT",
          name: text(r.name),
          status: str(r.status),
          scope: str(r.scope),
          start_date_time: str(r.startDateTime),
          end_date_time: str(r.endDateTime),
          campaigns: (Array.isArray(r.campaignIds) ? r.campaignIds : []).join(","),
          conversion_rate_modifier: num(r.conversionRateModifier),
        })),
  },
  {
    key: "changeHistory",
    section: "change_history",
    // change_status (the fallback) names no fields, so it cannot stand in for change_event
    parts: ["change_events", "change_events_other"],
    cap: "parts",
    rows: (s, snap) =>
      rowsOf(s)
        .filter((r) => r.source === "change_event")
        .map((r) => {
          const type = str(r.resourceType);
          return {
            change_date_time: str(r.changedAt),
            change_resource_name: resourceNameOf(snap.account.customer_id, type, r.resourceIds),
            resource_type: type,
            operation: str(r.operation),
            changed_fields: (Array.isArray(r.changedFields) ? r.changedFields : []).join(","),
            // B4: the campaign / ad group Google names on the change itself (budget, ad group,
            // asset group and criterion rows too), so the model never guesses it from the resource name
            campaign_id: str(r.campaignId),
            ad_group_id: str(r.adGroupId),
            client_type: str(r.clientType),
            user_email: str(r.user),
            ...(r.changedValues != null && typeof r.changedValues === "object"
              ? { changed_values: plainValues(r.changedValues) }
              : {}),
          };
        }),
  },
  {
    key: "conversionActions",
    section: "conversions",
    parts: ["actions"],
    cap: "parts",
    rows: (s) =>
      rowsOf(s).map((r) => {
        const m = r.metrics === null ? null : obj(r.metrics);
        return {
          action_id: str(r.id),
          name: text(r.name),
          status: str(r.status),
          type: str(r.type),
          category: str(r.category),
          // with category, the goal the action belongs to (campaign goals are category x origin)
          origin: str(r.origin),
          is_primary: bool(r.primaryForGoal),
          // false = outside the Conversions column (hidden imports, goals no campaign uses)
          include_in_conversions: bool(r.includeInConversionsMetric),
          counting_type: str(r.countingType),
          attribution_model: str(r.attributionModel),
          default_value: num(r.defaultValue),
          always_use_default_value: bool(r.alwaysUseDefaultValue),
          lookback_window_days: num(r.clickLookbackDays),
          view_through_window_days: num(r.viewLookbackDays),
          // over the performance window; null = not read (never zero)
          total_conversions: m ? num(m.conversions) : null,
          total_value: m ? num(m.conversionsValue) : null,
        };
      }),
  },
  {
    key: "conversion_action_daily",
    db: true,
    section: "conversions",
    parts: ["action_metrics"],
    cap: null,
    rows: (s) =>
      arrayOf(detailOf(s).daily).map((d) => ({
        conversion_action_id: str(d.actionId),
        date: str(d.date),
        conversions: num(d.conversions),
        conversions_value: num(d.conversionsValue),
        all_conversions: num(d.allConversions),
      })),
    notRead: (s) =>
      detailOf(s).daily == null ? "the daily series per conversion action was not read" : null,
  },
  {
    key: "campaign_control_settings",
    db: true,
    // the controls (frequency caps, asset automation, PMax URL exclusions) and, from the
    // conversions section, the view-through conversions: one row per campaign
    section: "campaign_controls",
    // the URL exclusions are a per-campaign field: when they were not read the field is null
    // ("not read", PX20 says so), and the caps, automation and view-through stand
    parts: ["controls"],
    also: { section: "conversions", parts: ["view_through"] },
    cap: "parts",
    rows: (s, snap) => {
      const conv = snap.sections.conversions;
      const vt = new Map(
        (conv ? arrayOf(detailOf(conv).viewThrough) : []).map((r) => [str(r.campaignId), r]),
      );
      // purchases by where they came from (a click, or a view: engaged view + impression);
      // null when the part was not read in full, never "all clicks"
      const splitPart = conv ? partOf(conv, "purchase_split") : undefined;
      const splitRead =
        splitPart !== undefined &&
        splitPart.status === "ok" &&
        !splitPart.capped &&
        !splitPart.time_cut;
      const split = new Map<string, { click: number; view: number; unnamed: number }>();
      if (splitRead && conv)
        for (const r of arrayOf(detailOf(conv).purchaseSplit)) {
          const cid = str(r.campaignId);
          if (!cid) continue;
          const t = split.get(cid) ?? { click: 0, view: 0, unnamed: 0 };
          const n = num(r.conversions) ?? 0;
          const type = str(r.eventType);
          if (type === "CLICK" || type === "INTERACTION") t.click += n;
          else if (type === "ENGAGED_VIEW" || type === "IMPRESSION") t.view += n;
          else t.unnamed += n;
          split.set(cid, t);
        }
      const splitOf = (cid: string) => {
        if (!splitRead) return {};
        const t = split.get(cid) ?? { click: 0, view: 0, unnamed: 0 };
        return {
          purchase_click_conversions: t.click,
          purchase_view_conversions: t.view,
          purchase_unnamed_conversions: t.unnamed,
        };
      };
      const urlPart = partOf(s, "url_exclusions");
      const urlRead =
        urlPart !== undefined && urlPart.status === "ok" && !urlPart.capped && !urlPart.time_cut;
      const exclusions = new Map<string, Raw[]>();
      for (const r of kind(s, "url_exclusion")) {
        const cid = str(r.campaignId) ?? "";
        exclusions.set(cid, [...(exclusions.get(cid) ?? []), r]);
      }
      const out: Row[] = [];
      const seen = new Set<string>();
      for (const r of kind(s, "controls")) {
        const cid = str(r.campaignId);
        if (!cid) continue;
        seen.add(cid);
        const caps = Array.isArray(r.frequencyCaps) ? r.frequencyCaps : [];
        const v = vt.get(cid);
        out.push({
          campaign_id: cid,
          frequency_caps: caps.length > 0 ? JSON.stringify(caps) : null,
          frequency_caps_state: caps.length > 0 ? "set" : "none_returned",
          asset_automation: JSON.stringify(
            arrayOf(r.assetAutomation).map((a) => ({
              asset_automation_type: str(a.type),
              asset_automation_status: str(a.status),
            })),
          ),
          // read for Performance Max only; null elsewhere (never "none set")
          url_exclusions:
            urlRead && str(r.channelType) === "PERFORMANCE_MAX"
              ? JSON.stringify(
                  (exclusions.get(cid) ?? []).map((e) => ({
                    criterionId: str(e.criterionId),
                    name: text(e.criterionName),
                    conditions: arrayOf(e.conditions).map((c) => ({
                      operand: str(c.operand) ?? "",
                      operator: str(c.operator) ?? "",
                      argument: text(c.argument) ?? "",
                    })),
                  })),
                )
              : null,
          view_through_conversions: v ? num(v.viewThroughConversions) : null,
          // B13: the share's base is conversions + view-through, not all_conversions
          conversions: v ? num(v.conversions) : null,
          all_conversions: v ? num(v.allConversions) : null,
          ...splitOf(cid),
        });
      }
      // a campaign with view-through numbers but no controls row (removed since) keeps them
      for (const [cid, v] of vt)
        if (cid && !seen.has(cid))
          out.push({
            campaign_id: cid,
            view_through_conversions: num(v.viewThroughConversions),
            conversions: num(v.conversions),
            all_conversions: num(v.allConversions),
            ...splitOf(cid),
          });
      return out;
    },
  },
  {
    key: "campaignConversionGoals",
    section: "conversions",
    parts: ["campaign_goals"],
    cap: "parts",
    rows: (s) =>
      arrayOf(detailOf(s).campaignGoals).map((g) => ({
        campaign_id: str(g.campaignId),
        category: str(g.category),
        origin: str(g.origin),
        biddable: bool(g.biddable),
      })),
  },
  {
    key: "conversionValueRules",
    section: "conversions",
    parts: ["value_rules"],
    cap: "parts",
    // the rules' conditions are not read: MI14 says it cannot judge them
    rows: (s) =>
      arrayOf(detailOf(s).valueRules).map((r) => ({
        rule_id: str(r.id),
        status: str(r.status),
        conditions_read: false,
      })),
  },
  {
    key: "conversion_value_by_rule",
    db: true,
    section: "conversions",
    parts: ["value_by_rule"],
    cap: "parts",
    rows: (s) =>
      arrayOf(detailOf(s).valueByRule).map((r) => ({
        campaign_id: str(r.campaignId),
        dimension: str(r.dimension),
        conversions_value: num(r.conversionsValue),
      })),
  },
  {
    key: "customerConversionGoals",
    section: "conversions",
    parts: ["customer_goals"],
    cap: "parts",
    rows: (s) =>
      (Array.isArray(s.extra?.customerGoals) ? s.extra.customerGoals : []).map(obj).map((g) => ({
        category: str(g.category),
        origin: str(g.origin),
        biddable: bool(g.biddable),
      })),
    total: (s) => partRows(s, "customer_goals"),
  },
  {
    key: "geographicData",
    section: "slice_performance",
    parts: ["locations"],
    cap: "parts",
    // performance per targeted location (location_view): what a location adjustment multiplies
    rows: (s) =>
      kind(s, "location").map((r) => ({
        campaign_id: str(r.campaignId),
        location_id: str(r.geoTargetConstantId) ?? str(r.criterionId),
        criterion_id: str(r.criterionId),
        location_type: "TARGETED",
        ...metricsOf(r.metrics),
      })),
  },
  {
    key: "temporal_grid",
    db: true,
    section: "slice_performance",
    parts: ["schedule_grid"],
    cap: "parts",
    rows: (s) =>
      kind(s, "schedule_cell").map((r) => ({
        campaign_id: str(r.campaignId),
        day_of_week: str(r.dayOfWeek),
        hour_of_day: num(r.hour),
        ...metricsOf(r.metrics),
      })),
  },
  {
    // R9 (SK32): each Search / Standard Shopping campaign's spend per ad network
    key: "campaign_network_split",
    db: true,
    section: "slice_performance",
    parts: ["networks"],
    cap: "parts",
    // a snapshot taken before this read has no such part: not read, never "$0 on partners"
    notRead: (s) =>
      partOf(s, "networks") ? null : "this snapshot was taken before the network split was read",
    rows: (s) =>
      kind(s, "network").map((r) => ({
        campaign_id: str(r.campaignId),
        ad_network_type: str(r.adNetworkType),
        ...metricsOf(r.metrics),
      })),
  },
  {
    key: "simulations",
    section: "simulations",
    parts: [
      "campaign_target_cpa",
      "campaign_target_roas",
      "strategy_target_cpa",
      "strategy_target_roas",
    ],
    cap: null,
    // a portfolio strategy's simulation stands for each campaign on that strategy; the
    // resource name is written the way the engine joins it (customers/<cid>/campaigns/<id>/...)
    rows: (s, snap) => {
      const onStrategy = new Map<string, string[]>();
      for (const c of campaignRowsOf(snap)) {
        const p = str(c.portfolioStrategyId);
        const id = str(c.id);
        if (p && id) onStrategy.set(p, [...(onStrategy.get(p) ?? []), id]);
      }
      return rowsOf(s).flatMap((r) => {
        const owner = str(r.ownerId);
        if (!owner) return [];
        const ids = r.level === "bidding_strategy" ? (onStrategy.get(owner) ?? []) : [owner];
        return ids.map((cid) => ({
          resource_name: `customers/${snap.account.customer_id}/campaigns/${cid}/simulations/${String(r.type)}~${String(r.modificationMethod ?? "")}`,
          // a strategy's simulation says where it comes from in the finding's facts
          simulation_type:
            r.level === "bidding_strategy"
              ? `${String(r.type)} (from the shared strategy)`
              : str(r.type),
          modification_method: str(r.modificationMethod),
          level: r.level,
          start_date: str(r.startDate),
          end_date: str(r.endDate),
          points_json: Array.isArray(r.points) ? r.points : [],
        }));
      });
    },
  },
  {
    key: "sharedNegativeLists",
    section: "negatives",
    parts: ["shared_lists", "shared_list_links", "account_exclusions"],
    cap: null,
    // regular lists only (the account-level list is the account's own); a list attached to
    // the whole account applies to every campaign
    rows: (s, snap) =>
      arrayOf(s.extra?.sharedLists)
        .filter((l) => l.type === "NEGATIVE_KEYWORDS")
        .map((l) => ({
          shared_set_id: str(l.id),
          shared_set_name: text(l.name),
          member_count: num(l.memberCount),
          linked_campaign_ids:
            l.attachedToAccount === true
              ? campaignRowsOf(snap)
                  .map((c) => str(c.id))
                  .filter((x): x is string => !!x)
              : textsOf(l.campaignIds),
        })),
    total: (s) => partRows(s, "shared_lists"),
    // the reader keeps the first 50 lists and the first 20 campaigns of each
    cut: (s) =>
      arrayOf(s.extra?.sharedLists).some(
        (l) => (num(l.campaignCount) ?? 0) > textsOf(l.campaignIds).length,
      ),
  },
  {
    key: "sharedNegativeListMembers",
    section: "negatives",
    parts: ["shared_list_keywords"],
    cap: "parts",
    rows: (s) =>
      level(s, "shared_list").map((r) => ({
        shared_set_id: str(r.sharedSetId),
        shared_set_name: text(r.sharedSetName),
        criterion_id: str(r.criterionId),
        keyword_text: text(r.text),
        match_type: str(r.matchType),
      })),
  },
  {
    key: "accountNegatives",
    section: "negatives",
    parts: ["account_list_keywords", "account_exclusions"],
    cap: "parts",
    // the keywords of the account-level negative list
    rows: (s) =>
      level(s, "account")
        .filter((r) => r.type === "KEYWORD")
        .map((r) => ({
          shared_set_id: str(r.sharedSetId),
          shared_set_name: text(r.sharedSetName),
          shared_set_type: "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS",
          account_level: bool(r.accountListAttached),
          criterion_id: str(r.criterionId),
          keyword_text: text(r.text),
          match_type: str(r.matchType),
        })),
  },
  {
    key: "campaign_negatives",
    db: true,
    section: "negatives",
    parts: ["campaign_negatives"],
    cap: "parts",
    rows: (s) =>
      level(s, "campaign").map((r) => ({
        campaign_id: str(r.campaignId),
        criterion_id: str(r.criterionId),
        keyword_text: text(r.text),
        match_type: str(r.matchType),
      })),
  },
  {
    key: "campaign_negatives_sync_marker",
    db: true,
    section: "negatives",
    parts: ["campaign_negatives"],
    cap: null,
    // every campaign's own negatives were read when the campaign part read in full
    rows: (s, snap) =>
      partOf(s, "campaign_negatives")?.capped || partOf(s, "campaign_negatives")?.time_cut
        ? []
        : campaignRowsOf(snap).map((c) => ({ campaign_id: str(c.id) })),
  },
  {
    key: "account_negative_criteria",
    db: true,
    section: "account_exclusions",
    parts: ["content_labels", "placements", "app_categories"],
    cap: "parts",
    // brand-safety exclusions; an attached negative keyword list is not one
    rows: (s) =>
      rowsOf(s)
        .filter((r) => r.type !== "NEGATIVE_KEYWORD_LIST")
        .map((r) => ({
          criterion_id: str(r.criterionId),
          criterion_type: str(r.type),
          content_label_type: str(r.contentLabel),
          mobile_app_category: str(r.mobileAppCategory),
        })),
  },
  {
    key: "ads",
    section: "ads_assets",
    parts: ["ads", "ad_metrics"],
    cap: "parts",
    rows: (s) =>
      kind(s, "ad").map((r) => {
        const ad = obj(r.ad);
        const lines = (v: unknown) =>
          arrayOf(v).map((x) => ({ text: text(x.text), pinnedField: str(x.pinnedField) }));
        return {
          ad_id: str(ad.adId),
          ad_group_id: str(r.adGroupId),
          campaign_id: str(r.campaignId),
          type: str(ad.type),
          status: str(r.status),
          headlines: lines(ad.headlines),
          descriptions: lines(ad.descriptions),
          final_urls: textsOf(ad.finalUrls),
          ...(r.metrics == null ? {} : metricsOf(r.metrics)),
        };
      }),
  },
  {
    key: "adPolicyData",
    section: "ads_assets",
    parts: ["ads"],
    cap: "parts",
    rows: (s, snap) => {
      const campaignStatus = new Map(campaignRowsOf(snap).map((c) => [str(c.id), str(c.status)]));
      const groupStatus = new Map(
        (snap.sections.ad_groups?.rows ?? []).map(obj).map((g) => [str(g.id), str(g.status)]),
      );
      return kind(s, "ad").map((r) => {
        const ad = obj(r.ad);
        return {
          ad_id: str(ad.adId),
          campaign_id: str(r.campaignId),
          ad_group_id: str(r.adGroupId),
          approval_status: str(ad.approvalStatus),
          review_status: str(ad.reviewStatus),
          policy_topics: arrayOf(ad.policyTopics).map((t) => text(t.topic)),
          ad_status: str(r.status),
          ad_group_status: groupStatus.get(str(r.adGroupId)) ?? null,
          campaign_status: campaignStatus.get(str(r.campaignId)) ?? null,
          headlines: arrayOf(ad.headlines).map((h) => text(h.text)),
        };
      });
    },
    notRead: (s) =>
      partOf(s, "ads")?.fallback
        ? "Google refused the policy fields, so the ads' approval status was not read"
        : null,
  },
  {
    key: "assetPerformance",
    section: "ads_assets",
    parts: ["ads", "ad_asset_labels"],
    cap: "parts",
    // Google's rating of each responsive search ad line
    rows: (s, snap) =>
      kind(s, "ad").flatMap((r) => {
        const ad = obj(r.ad);
        const line = (field: string) => (x: Raw) =>
          str(x.performanceLabel) && str(x.assetId)
            ? [
                {
                  asset_id: str(x.assetId),
                  ad_resource: `customers/${snap.account.customer_id}/adGroupAds/${str(r.adGroupId) ?? ""}~${str(ad.adId) ?? ""}`,
                  field_type: field,
                  performance_label: str(x.performanceLabel),
                  asset_text: text(x.text),
                },
              ]
            : [];
        return [
          ...arrayOf(ad.headlines).flatMap(line("HEADLINE")),
          ...arrayOf(ad.descriptions).flatMap(line("DESCRIPTION")),
        ];
      }),
  },
  {
    key: "adExtensions",
    section: "ads_assets",
    parts: ["account_assets", "campaign_assets", "ad_group_assets"],
    cap: "parts",
    // inventory only: impressions per asset are not read (left out, never 0)
    rows: (s) =>
      kind(s, "asset").map((r) => {
        const a = obj(r.asset);
        const type = str(a.fieldType) ?? str(a.type);
        return {
          asset_id: str(a.assetId),
          extension_type: type,
          level: String(r.level ?? "").toUpperCase(),
          campaign_id: str(r.campaignId),
          ad_group_id: str(r.adGroupId),
          status: str(r.status),
          text: text(a.text),
          description1: text(a.description1),
          description2: text(a.description2),
          final_urls: textsOf(a.finalUrls),
          snippet_header: type === "STRUCTURED_SNIPPET" ? text(a.text) : null,
          snippet_values: textsOf(a.values),
          metadata: {
            percentOff: num(a.percentOff),
            endDate: str(a.endDate),
          },
          approval_status: str(a.approvalStatus),
        };
      }),
  },
  {
    key: "audienceLists",
    section: "audiences",
    parts: ["user_lists"],
    cap: "parts",
    rows: (s) =>
      kind(s, "user_list").map((r) => {
        const u = obj(r.userList);
        return {
          list_id: str(r.audienceId),
          list_name: text(r.name),
          list_type: str(u.type),
          membership_status: str(u.membershipStatus),
          size_for_search: num(u.sizeForSearch),
          size_for_display: num(u.sizeForDisplay),
        };
      }),
  },
  {
    key: "recommendationSubscriptions",
    section: "auto_apply",
    parts: ["subscriptions"],
    cap: "parts",
    rows: (s) => rowsOf(s).map((r) => ({ type: str(r.type), status: str(r.status) })),
  },
  {
    key: "customerUserAccess",
    section: "user_access",
    parts: ["users"],
    cap: "parts",
    // the reader counts users per role (no emails): one row per user here
    rows: (s) =>
      rowsOf(s).flatMap((r) =>
        Array.from({ length: Math.max(0, num(r.users) ?? 0) }, () => ({
          access_role: str(r.role),
        })),
      ),
  },
  {
    key: "experiments",
    section: "experiments",
    parts: ["experiments"],
    cap: "parts",
    rows: (s, snap) =>
      rowsOf(s).map((r) => ({
        experiment_id: str(r.id),
        resource_name: `customers/${snap.account.customer_id}/experiments/${str(r.id) ?? ""}`,
        name: text(r.name),
        status: str(r.status),
        type: str(r.type),
      })),
  },
  {
    key: "experimentArms",
    section: "experiments",
    parts: ["arms"],
    cap: "parts",
    rows: (s, snap) =>
      rowsOf(s).flatMap((r) =>
        arrayOf(r.arms).map((a) => ({
          experiment_resource_name: `customers/${snap.account.customer_id}/experiments/${str(r.id) ?? ""}`,
          name: text(a.name),
          control: bool(a.control),
          campaigns_json: textsOf(a.campaignIds).map(
            (c) => `customers/${snap.account.customer_id}/campaigns/${c}`,
          ),
        })),
      ),
  },
  {
    key: "landingPageViews",
    section: "landing_pages",
    parts: ["final_urls"],
    cap: "parts",
    // campaign_clicks: clicks per campaign that fed the URL (extra.campaignClicks); null = not read
    rows: (s) => {
      const split = s.extra?.campaignClicks;
      const byUrl = new Map<string, { campaign_id: string; clicks: number }[]>();
      for (const c of arrayOf(split)) {
        const url = text(c.url);
        const campaignId = str(c.campaignId);
        if (url === null || campaignId === null) continue;
        byUrl.set(url, [
          ...(byUrl.get(url) ?? []),
          { campaign_id: campaignId, clicks: num(c.clicks) ?? 0 },
        ]);
      }
      return kind(s, "final_url").map((r) => {
        const url = text(r.url);
        return {
          url,
          ...metricsOf(r.metrics),
          mobile_friendly_pct: num(r.mobileFriendlyClicksPercentage),
          speed_score: num(r.speedScore),
          campaign_clicks: Array.isArray(split) ? (byUrl.get(url ?? "") ?? []) : null,
        };
      });
    },
  },
  {
    key: "offlineUserDataJobs",
    section: "offline_jobs",
    parts: ["jobs"],
    cap: "parts",
    rows: (s, snap) =>
      rowsOf(s).map((r) => ({
        job_id: str(r.jobId),
        type: str(r.type),
        status: str(r.status),
        failure_reason: str(r.failureReason),
        user_list_resource_name: str(r.userListId)
          ? `customers/${snap.account.customer_id}/userLists/${str(r.userListId)}`
          : null,
      })),
  },
  {
    key: "dsaSearchTerms",
    section: "dsa_search_terms",
    parts: ["terms"],
    cap: "parts",
    rows: (s) =>
      rowsOf(s).map((r) => ({
        campaign_id: str(r.campaignId),
        ad_group_id: str(r.adGroupId),
        search_term: text(r.searchTerm),
        ...metricsOf(r.metrics),
      })),
  },
  {
    key: "pmaxSearchInsights",
    section: "search_terms",
    parts: ["pmax_campaigns", "pmax_categories"],
    cap: null,
    notReadCampaigns: (s) => textsOrIds(s.extra?.pmaxCategoriesNotRead),
    rows: (s) =>
      arrayOf(s.extra?.pmaxCategories).map((r) => ({
        campaign_id: str(r.campaignId),
        category_label: text(r.category),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        conversions: num(r.conversions),
        conversions_value: num(r.conversionsValue),
      })),
  },
  {
    key: "assetGroups",
    section: "pmax",
    parts: ["asset_groups", "asset_group_metrics"],
    cap: "parts",
    rows: (s) =>
      kind(s, "asset_group").map((r) => ({
        asset_group_id: str(r.assetGroupId),
        campaign_id: str(r.campaignId),
        name: text(r.name),
        status: str(r.status),
        ad_strength: str(r.adStrength),
        ...metricsOf(r.metrics),
      })),
  },
  {
    key: "pmaxAssets",
    section: "pmax",
    parts: ["assets"],
    cap: "parts",
    rows: (s) =>
      kind(s, "asset").map((r) => ({
        asset_group_id: str(r.assetGroupId),
        asset_id: str(r.assetId),
        asset_type: str(r.assetType),
        field_type: str(r.fieldType),
        asset_text: text(r.text),
        video_title: text(r.videoTitle),
        status: str(r.status),
        primary_status: str(r.primaryStatus),
        primary_status_details: Array.isArray(r.primaryStatusDetails)
          ? JSON.stringify(r.primaryStatusDetails)
          : null,
        asset_source: str(r.source),
        image_width_px: num(r.imageWidthPx),
        image_height_px: num(r.imageHeightPx),
      })),
  },
  {
    key: "pmaxListingGroups",
    section: "pmax",
    parts: ["listing_groups"],
    cap: "parts",
    rows: (s) =>
      kind(s, "listing_group").map((r) => ({
        asset_group_id: str(r.assetGroupId),
        listing_group_id: str(r.listingGroupId),
        parent_listing_group_id: str(r.parentListingGroupId),
        type: str(r.listingType),
        case_value: JSON.stringify(obj(r.caseValue)),
      })),
  },
  {
    key: "pmaxSignals",
    section: "pmax",
    parts: ["signals"],
    cap: "parts",
    rows: (s) =>
      kind(s, "signal").map((r) => ({
        asset_group_id: str(r.assetGroupId),
        search_theme: text(r.text),
        audience: str(r.audienceResource),
        approval_status: str(r.approvalStatus),
        disapproval_reasons: Array.isArray(r.disapprovalReasons)
          ? JSON.stringify(r.disapprovalReasons)
          : null,
      })),
  },
  {
    key: "pmaxChannelDistribution",
    section: "pmax",
    parts: ["channels"],
    cap: "parts",
    rows: (s) =>
      kind(s, "channel").map((r) => ({
        campaign_id: str(r.campaignId),
        ad_network_type: str(r.adNetworkType),
        ...metricsOf(r.metrics),
      })),
  },
  {
    key: "pmax_placements",
    db: true,
    section: "pmax",
    parts: ["pmax_campaigns", "placements"],
    // each campaign's places are its own top list; the per-campaign limit is passed apart
    cap: null,
    notReadCampaigns: (s) => textsOrIds(s.extra?.placementsNotRead),
    rows: (s) =>
      kind(s, "placement").map((r) => ({
        campaign_id: str(r.campaignId),
        placement: text(r.placement),
        placement_type: str(r.placementType),
        display_name: text(r.name),
        target_url: text(r.targetUrl),
        impressions: num(obj(r.metrics).impressions),
      })),
  },
  {
    key: "campaignAudiencePerf",
    section: "segment_performance",
    parts: ["audiences", "ad_group_audiences"],
    cap: "parts",
    rows: (s) =>
      kind(s, "audience").map((r) => ({
        campaign_id: str(r.campaignId),
        ad_group_id: str(r.adGroupId),
        criterion_id: str(r.criterionId),
        audience_type: str(r.audienceType),
        user_list_id: str(r.userListId),
        // a custom segment's or interest's name (a list's comes from audienceLists)
        audience_name: text(r.audienceName),
        ...metricsOf(r.metrics),
      })),
  },
  {
    key: "demographicData",
    section: "segment_performance",
    parts: ["ages", "genders"],
    cap: "parts",
    rows: (s) =>
      rowsOf(s)
        .filter((r) => r.kind === "age" || r.kind === "gender")
        .map((r) => ({
          campaign_id: str(r.campaignId),
          ad_group_id: str(r.adGroupId),
          demographic_type: r.kind === "age" ? "AGE_RANGE" : "GENDER",
          demographic_value: str(r.value),
          ...metricsOf(r.metrics),
        })),
  },
  {
    key: "account_daily_prior_year",
    db: true,
    section: "prior_year_daily",
    parts: ["prior_year_daily"],
    cap: "parts",
    rows: (s) => rowsOf(s).map((r) => ({ metric_date: str(r.date), ...metricsOf(r.metrics) })),
  },
  // ---- Shopping (shopping_product = Merchant Center as Google Ads shows it; never a Merchant
  // Center API). Products that served in the window are the engine's product rows; every
  // product (served or not) is the catalogue and the status list. The products are read once
  // per live campaign (each read up to its own limit) and joined, so the list can be longer
  // than one read's limit: no limit is compared (cap null); a read that hit its limit still
  // makes these tables a sample.
  {
    key: "products",
    section: "shopping",
    parts: ["products"],
    cap: null,
    rows: (s) =>
      kind(s, "product")
        .filter((r) => {
          const m = obj(r.metrics);
          return (num(m.impressions) ?? 0) > 0 || (num(m.cost) ?? 0) > 0;
        })
        .map(productRow),
  },
  {
    key: "shoppingProductsData",
    section: "shopping",
    parts: ["products"],
    cap: null,
    rows: (s) =>
      kind(s, "product").map((r) => {
        const m = obj(r.metrics);
        return {
          item_id: text(r.itemId),
          title: text(r.title),
          merchant_id: str(r.merchantId),
          language_code: str(r.languageCode),
          feed_label: text(r.feedLabel),
          status: str(r.status),
          // why it cannot show: its stock state and Google's blocking issue codes (null = not read)
          availability: str(r.availability),
          issue_codes: Array.isArray(r.issueCodes) ? JSON.stringify(r.issueCodes) : null,
          channel: str(r.channel),
          clicks: num(m.clicks),
          impressions: num(m.impressions),
          conversions: num(m.conversions),
          conversions_value: num(m.conversionsValue),
        };
      }),
  },
  {
    key: "products_catalog",
    db: true,
    section: "shopping",
    parts: ["products"],
    cap: null,
    rows: (s) => kind(s, "product").map(productRow),
  },
  {
    // the catalogue is complete only when the product read was (the catalogue checks read this flag)
    key: "mcSyncStatus",
    section: "shopping",
    parts: ["products"],
    cap: null,
    rows: (s) => [
      {
        resource: "product_feed",
        status:
          partOf(s, "products")?.capped || partOf(s, "products")?.time_cut ? "truncated" : "ok",
        // product rows after the join (the per-campaign reads overlap)
        row_count: kind(s, "product").length,
      },
    ],
  },
  {
    key: "shop_languages",
    db: true,
    section: "shopping",
    parts: ["products"],
    cap: null,
    rows: (s) => {
      const counts = new Map<string, number>();
      for (const r of kind(s, "product")) {
        const code = str(r.languageCode);
        if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([language_code, product_count]) => ({ language_code, product_count }));
    },
  },
  {
    key: "shoppingCartData",
    section: "shopping",
    parts: ["products"],
    cap: null,
    notRead: (s) =>
      s.extra?.cartRead === false
        ? "Google refused the cart metrics (orders, units sold), so the cart data was not read"
        : null,
    rows: (s) =>
      kind(s, "product")
        .filter((r) => (num(obj(r.cart).orders) ?? 0) > 0)
        .map((r) => {
          const cart = obj(r.cart);
          const revenue = num(cart.revenue);
          return {
            product_item_id: text(r.itemId),
            units_sold: num(cart.unitsSold),
            orders: num(cart.orders),
            revenue_micros: revenue === null ? null : Math.round(revenue * 1_000_000),
            average_cart_size: num(cart.averageCartSize),
          };
        }),
  },
  {
    key: "shoppingSettings",
    section: "shopping",
    parts: ["shopping_settings"],
    cap: "parts",
    rows: (s) =>
      kind(s, "shopping_setting").map((r) => ({
        campaign_id: str(r.campaignId),
        campaign_priority: num(r.priority),
        merchant_id: str(r.merchantId),
        // '' = every product of the Merchant Center account
        feed_label: text(r.feedLabel) ?? "",
        enable_local: bool(r.enableLocal),
        channel_sub_type: null,
      })),
  },
  {
    key: "pmax_campaign_products",
    db: true,
    section: "shopping",
    parts: ["campaign_products"],
    cap: "parts",
    rows: (s) =>
      kind(s, "campaign_product").map((r) => {
        const m = obj(r.metrics);
        const cost = num(m.cost);
        return {
          campaign_id: str(r.campaignId),
          offer_id: text(r.itemId),
          product_title: text(r.title),
          // Shopping rows too; the engine judges each campaign of its own type
          channel: str(r.channelType),
          product_type_l1: text(r.productTypeL1),
          product_type_l2: text(r.productTypeL2),
          product_category_l1: text(r.categoryL1),
          cost_micros: cost === null ? null : Math.round(cost * 1_000_000),
          clicks: num(m.clicks),
          impressions: num(m.impressions),
          conversions: num(m.conversions),
          conversions_value: num(m.conversionsValue),
          // the last 7 days' impressions in this campaign; null = not read (never 0)
          impressions_7d: num(r.recentImpressions),
        };
      }),
    // the engine reads a capped per-campaign product read from this note; with the split
    // read's reason and cutoff (the most spend one product can have outside the kept rows)
    okNote: (s, sample) => (sample ? campaignProductsTruncatedNote(s) : null),
  },
  {
    // the places excluded for the whole account, so a placement check never asks for them again
    key: "account_placement_exclusions",
    db: true,
    section: "account_exclusions",
    parts: ["placements"],
    cap: "parts",
    rows: (s) =>
      rowsOf(s)
        .filter((r) =>
          ["PLACEMENT", "YOUTUBE_VIDEO", "YOUTUBE_CHANNEL", "MOBILE_APPLICATION"].includes(
            String(r.type ?? ""),
          ),
        )
        .map((r) => ({ type: str(r.type), value: text(r.value) })),
  },
  // ---- placements with cost (Display, Video, Demand Gen)
  {
    key: "placement_performance",
    db: true,
    section: "placements",
    parts: ["placements"],
    cap: "parts",
    rows: (s) =>
      rowsOf(s).map((r) => ({
        campaign_id: str(r.campaignId),
        placement: text(r.placement),
        placement_type: str(r.placementType),
        display_name: text(r.displayName),
        target_url: text(r.targetUrl) ?? text(r.groupTargetUrl) ?? text(r.placement),
        ...metricsOf(r.metrics),
      })),
  },
  // ---- countries (where people were) and languages
  {
    key: "geo_countries",
    db: true,
    section: "geo_languages",
    parts: ["countries", "country_names"],
    cap: "parts",
    rows: (s) =>
      kind(s, "country").map((r) => ({
        campaign_id: str(r.campaignId),
        country_id: str(r.countryId),
        country_code: str(r.countryCode),
        country_name: str(r.countryName),
        location_type: str(r.locationType),
        ...metricsOf(r.metrics),
      })),
  },
  {
    key: "campaign_languages",
    db: true,
    section: "geo_languages",
    parts: ["campaign_languages", "language_codes"],
    cap: "parts",
    rows: (s) =>
      kind(s, "campaign_language").map((r) => ({
        campaign_id: str(r.campaignId),
        criterion_id: str(r.criterionId),
        language_code: str(r.languageCode),
        status: str(r.status),
      })),
  },
  // ---- Video campaigns' view numbers
  {
    key: "video_campaign_metrics",
    db: true,
    section: "video",
    parts: ["video_campaigns"],
    cap: "parts",
    rows: (s) =>
      rowsOf(s).map((r) => {
        const q = obj(r.quartiles);
        return {
          campaign_id: str(r.campaignId),
          video_views: num(r.views),
          video_view_rate: num(r.viewRate),
          average_cpv: num(r.averageCpv),
          quartile_p25_rate: num(q.p25),
          quartile_p50_rate: num(q.p50),
          quartile_p75_rate: num(q.p75),
          quartile_p100_rate: num(q.p100),
          ...metricsOf(r.metrics),
        };
      }),
  },
  // ---- Local Services (counts-grade fields only: no contact details, notes or messages)
  {
    key: "lsaLeads",
    section: "local_services",
    parts: ["lsa_campaigns", "leads"],
    cap: "parts",
    rows: (s) =>
      kind(s, "lead").map((r) => ({
        lead_id: str(r.id),
        lead_type: str(r.type),
        lead_status: str(r.status),
        creation_time: str(r.createdAt),
        charged: bool(r.charged),
        credit_state: str(r.creditState),
      })),
  },
  {
    key: "lsaConversations",
    section: "local_services",
    parts: ["lsa_campaigns", "conversations"],
    cap: "parts",
    rows: (s) =>
      kind(s, "conversation").map((r) => ({
        conversation_id: str(r.id),
        lead_resource: str(r.leadId),
        channel: str(r.type),
        participant_type: str(r.participantType),
        event_time: str(r.createdAt),
        call_duration_ms: num(r.callDurationMs),
      })),
  },
  {
    key: "lsaVerifications",
    section: "local_services",
    parts: ["lsa_campaigns", "verifications"],
    cap: "parts",
    rows: (s) =>
      kind(s, "verification").map((r) => ({
        artifact_id: str(r.id),
        artifact_type: str(r.type),
        status: str(r.status),
        license_type: text(r.licenseType),
        license_expiry: str(r.licenseExpiry),
        insurance_expiry: str(r.insuranceExpiry),
      })),
  },
  // ---- Demand Gen
  {
    key: "dg_campaign_settings",
    db: true,
    section: "demand_gen",
    parts: ["dg_campaigns"],
    cap: "parts",
    rows: (s) =>
      kind(s, "campaign").map((r) => {
        const merchant = str(r.merchantId);
        return {
          campaign_id: str(r.campaignId),
          merchant_center_id: merchant,
          // no Merchant Center link = no feed attached
          product_feed_disabled: merchant === null ? true : bool(r.feedDisabled) === true,
          feed_label: text(r.feedLabel),
        };
      }),
  },
  {
    key: "dg_assets",
    db: true,
    section: "demand_gen",
    parts: ["dg_assets"],
    cap: "parts",
    rows: (s) =>
      kind(s, "asset").map((r) => ({
        campaign_id: str(r.campaignId),
        ad_id: str(r.adId),
        asset_id: str(r.assetId),
        field_type: str(r.fieldType),
        ad_type: str(r.adType),
        status: bool(r.enabled) === false ? "REMOVED" : "ENABLED",
      })),
  },
  {
    key: "dg_audience_signals",
    db: true,
    section: "demand_gen",
    parts: ["dg_audiences"],
    cap: "parts",
    rows: (s) =>
      kind(s, "audience").map((r) => ({
        campaign_id: str(r.campaignId),
        ad_group_id: str(r.adGroupId),
        criterion_id: str(r.criterionId),
        criterion_type: str(r.criterionType),
        negative: bool(r.negative),
        user_list_id: str(r.userListId),
        custom_audience_resource: str(r.audienceResource),
      })),
  },
  {
    key: "dg_channel_distribution",
    db: true,
    section: "demand_gen",
    parts: ["dg_channels"],
    cap: "parts",
    rows: (s) =>
      kind(s, "channel").map((r) => ({
        campaign_id: str(r.campaignId),
        ad_network_type: str(r.adNetworkType),
        ...metricsOf(r.metrics),
      })),
  },
  {
    // B12: where each Demand Gen ad group may show (DG04 measures concentration inside it)
    key: "dg_channel_controls",
    db: true,
    section: "demand_gen",
    parts: ["dg_channel_controls"],
    cap: "parts",
    rows: (s) =>
      kind(s, "channel_control").map((r) => ({
        campaign_id: str(r.campaignId),
        ad_group_id: str(r.adGroupId),
        ad_group_status: str(r.adGroupStatus),
        channel_config: str(r.channelConfig),
        channel_strategy: str(r.channelStrategy),
        selected_channels: Array.isArray(r.selectedChannels)
          ? r.selectedChannels.filter((c): c is string => typeof c === "string")
          : [],
      })),
  },
];

/**
 * Tables some checks name that no reader fills: Merchant Center data the Google Ads API does
 * not serve (account issues, promotions, shipping and return policies, price benchmarks,
 * feed diagnostics). Each gets a "skipped" status row saying why, so
 * the checks that need it report not run with that reason, never clean.
 */
export const NOT_READ_TABLES: Readonly<Record<string, string>> = {
  mcAccountIssues: "Merchant Center account issues",
  mcPromotions: "Merchant Center promotions",
  mcShippingSettings: "Merchant Center shipping settings",
  mcReturnPolicies: "Merchant Center return policies",
  feedDiagnostics: "Merchant Center feed diagnostics",
};

/** Data key -> the snapshot section and reader parts that feed it. */
export const TABLE_SOURCES: Readonly<
  Record<
    string,
    {
      section: SnapshotSectionName;
      parts: readonly string[];
      also?: { section: SnapshotSectionName; parts: readonly string[] };
    }
  >
> = {
  ...Object.fromEntries(
    TABLES.map((t) => [
      t.key,
      { section: t.section, parts: t.parts, ...(t.also ? { also: t.also } : {}) },
    ]),
  ),
  // one account row, not a table (toEvidenceInput writes it and its status row)
  conversionTrackingSettings: { section: "conversions", parts: ["tracking_settings"] },
};

/** Short words in table and read names, said in full. */
const NAME_WORDS: Readonly<Record<string, string>> = {
  pmax: "Performance Max",
  dg: "Demand Gen",
  lsa: "Local Services",
  mc: "Merchant Center",
  dsa: "dynamic search ad",
  perf: "performance",
};

/** Names whose words alone would not say what they hold. */
const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  temporal_grid: "day-and-hour results",
  schedule_grid: "day-and-hour results",
  campaign_network_split: "spend by ad network",
  networks: "spend by ad network",
  dailyMetrics: "account daily results",
  daily_metrics: "account daily results",
  account_daily: "account daily results",
  campaignDailyMetrics: "campaign daily results",
  campaign_daily_metrics: "campaign daily results",
  campaign_daily: "campaign daily results",
  account_daily_prior_year: "last year's daily results",
  prior_year_daily: "last year's daily results",
  campaign_negatives_sync_marker: "campaign negatives",
  conversion_action_daily: "conversion actions by day",
  action_metrics: "conversion action results",
  impressionShare: "impression share",
  customerUserAccess: "account users",
  // names the checks quote that no reader part carries
  conversion_tracking_settings: "conversion tracking settings",
  sync_table_status: "read status list",
};

const nameWords = (id: string): string =>
  id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[_\s]+/)
    .map((w) => NAME_WORDS[w] ?? w)
    .join(" ");

/**
 * Every table and read name a reason may quote ("shared_negative_list_members",
 * "dailyMetrics", "the shared_list_keywords read") -> plain words. Output only: the
 * engine and the snapshot keep their own names.
 */
export const TABLE_LABELS: Readonly<Record<string, string>> = (() => {
  const ids = new Set<string>([
    ...Object.keys(TABLE_SOURCES),
    ...Object.values(TABLE_SOURCES).flatMap((t) => [...t.parts, ...(t.also?.parts ?? [])]),
    ...Object.keys(AUDIT_KEY_TABLE),
    ...Object.values(AUDIT_KEY_TABLE),
    ...listChecks().flatMap((c) => c.dependsOn),
    ...Object.keys(LABEL_OVERRIDES),
  ]);
  const out: Record<string, string> = {};
  for (const id of ids) {
    const label = NOT_READ_TABLES[id] ?? LABEL_OVERRIDES[id] ?? nameWords(id);
    if (label !== id) out[id] = label;
  }
  return out;
})();

/**
 * A run of text with no space: brackets, straight and curly quotes and plain punctuation
 * around it are not part of it.
 */
const TOKEN =
  /(?<=^|\s)([(["'`\u201c\u2018]*)([^\s(["'`\u201c\u2018]+?)([)\]"'`\u201d\u2019,;:.!?]*)(?=\s|$)/g;

/** A name, or names joined by "/" when every one of them is a name ("a_b/c_d"). */
const tableWords = (core: string): string => {
  const one = TABLE_LABELS[core];
  if (one !== undefined) return one;
  const parts = core.split("/");
  return parts.length > 1 && parts.every((p) => TABLE_LABELS[p] !== undefined)
    ? parts.map((p) => TABLE_LABELS[p]).join("/")
    : core;
};

/**
 * Text with every table and read name in it as plain words (see TABLE_LABELS). Only a
 * whole name standing alone is rewritten: inside a URL, a path or a longer word
 * ("https://x.com/products_catalog/a", "C.dailyMetrics") nothing changes.
 */
export const plainTableText = (text: string): string =>
  text.replace(
    TOKEN,
    (_whole, open: string, core: string, close: string) => `${open}${tableWords(core)}${close}`,
  );

/** Tables a check may come to depend on only for what the account holds (BB09's bid adjustments). */
const DYNAMIC_TABLES: Readonly<Record<string, readonly string[]>> = {
  BB09: ["geographicData", "temporal_grid", "deviceData"],
};

/**
 * Sections every check reads through the engine, whatever its own tables: the daily series
 * (the period), the campaigns, and the conversion actions (their lookback settles the period;
 * the business-type gate and the conversion volume floor read them).
 */
const ALWAYS_SECTIONS: readonly SnapshotSectionName[] = [
  "daily_metrics",
  "campaigns",
  "conversions",
];

/**
 * The sections the given checks need, in build order: the ones every check reads, then each
 * table they depend on. Unknown ids throw.
 */
export const sectionsForChecks = (ids: readonly string[]): SnapshotSectionName[] => {
  // ids match whatever their case ("tr01a" is TR01a)
  const byId = new Map(listChecks().map((c) => [c.id.toUpperCase(), c] as const));
  const need = new Set<SnapshotSectionName>(ALWAYS_SECTIONS);
  for (const raw of ids) {
    const id = raw.trim().toUpperCase();
    const c = byId.get(id);
    if (!c) throw new Error(`no check with the id ${JSON.stringify(raw)}`);
    for (const t of [...c.dependsOn, ...(DYNAMIC_TABLES[id] ?? [])]) {
      const src = TABLE_SOURCES[t];
      if (src) need.add(src.section);
      if (src?.also) need.add(src.also.section);
    }
  }
  return SNAPSHOT_SECTIONS.filter((n) => need.has(n));
};

/** Every one of these sections was read in full in this snapshot (a kept one can stand in). */
export const coversSections = (
  snap: AccountSnapshot,
  sections: readonly SnapshotSectionName[],
): boolean =>
  sections.every((n) => {
    const s = snap.sections[n];
    return s !== undefined && ((s.status === "ok" && !s.truncated) || isAbsentSection(s));
  });

const RANK: Readonly<Record<SectionStatus, number>> = {
  ok: 0,
  skipped: 1,
  not_allowed: 2,
  failed: 3,
};

export interface TableStatus {
  key: string;
  table: string;
  status: SectionStatus;
  rows: number;
  /** rows Google had, when more than `rows` (a cut embedded list) */
  rowCount: number;
  /** a part hit its limit or ran out of time: a sample */
  sample: boolean;
  message: string | null;
  /** the row limit its parts read under (null = not comparable) */
  cap: number | null;
  /** a sample: which read stopped and at what limit, in words (null = not a sample) */
  sampleNote: string | null;
}

/** One status per table: the worst of its parts. A missing section = skipped (not read). */
export const tableStatusOf = (snap: AccountSnapshot, spec: TableSpec): TableStatus => {
  const table = spec.db ? spec.key : (AUDIT_KEY_TABLE[spec.key] ?? spec.key);
  const s = snap.sections[spec.section];
  if (!s) {
    return {
      key: spec.key,
      table,
      status: "skipped",
      rows: 0,
      rowCount: 0,
      sample: false,
      message: `the snapshot has no ${spec.section} section`,
      cap: null,
      sampleNote: null,
    };
  }
  const own = s.parts.filter((p) => spec.parts.includes(p.part));
  // no part of its own ran (e.g. no live PMax campaign to read): the section speaks for it
  const statuses: SectionStatus[] = own.length > 0 ? own.map((p) => p.status) : [s.status];
  // the second section's parts count the same way; a missing second section = not read
  const also = spec.also;
  const alsoSection = also ? snap.sections[also.section] : undefined;
  const alsoParts = also
    ? (alsoSection?.parts ?? []).filter((p) => also.parts.includes(p.part))
    : [];
  if (spec.also)
    statuses.push(
      ...(alsoSection === undefined
        ? (["skipped"] as SectionStatus[])
        : alsoParts.length > 0
          ? alsoParts.map((p) => p.status)
          : [alsoSection.status]),
    );
  const parts = [...own, ...alsoParts];
  const worst = statuses.reduce<SectionStatus>((w, x) => (RANK[x] > RANK[w] ? x : w), "ok");
  // the parts ran but this table's data was not among what they read
  const notRead = worst === "ok" ? (spec.notRead?.(s) ?? null) : null;
  const status: SectionStatus = notRead ? "skipped" : worst;
  const rows = status === "ok" ? spec.rows(s, snap) : [];
  const cutParts = parts.filter((p) => p.capped || p.time_cut);
  const sample = cutParts.length > 0 || (status === "ok" && (spec.cut?.(s) ?? false));
  // name the read that stopped and its own limit: the table's row count is not that limit
  const sampleNote = !sample
    ? null
    : cutParts.length > 0
      ? `built from ${cutParts
          .map((p) =>
            p.capped
              ? p.cap != null
                ? `the ${p.part} read, which stopped at its limit of ${p.cap.toLocaleString("en-US")} rows`
                : `the ${p.part} read, which stopped at its row limit`
              : `the ${p.part} read, which ran out of time`,
          )
          .join(" and ")}, so it is only part of the data`
      : "the reader kept only part of the list Google sent, so it is only part of the data";
  const bad = parts.find((p) => p.status === status) ?? null;
  const message =
    status === "ok"
      ? null
      : (notRead ??
        text(bad?.message) ??
        (spec.also && alsoSection === undefined
          ? `the snapshot has no ${spec.also.section} section`
          : null) ??
        text(s.error) ??
        `${spec.section} was not read (${status})`);
  return {
    key: spec.key,
    table,
    status,
    rows: rows.length,
    rowCount: Math.max(rows.length, status === "ok" && spec.total ? spec.total(s) : 0),
    sample,
    message,
    cap:
      spec.cap === "parts"
        ? parts.reduce<number | null>((m, p) => (p.cap == null ? m : Math.max(m ?? 0, p.cap)), null)
        : null,
    sampleNote,
  };
};

export interface AdapterOptions {
  /** Brand names as a shopper types them (brand vs generic searches; brand words in negatives). */
  brandTerms?: readonly string[] | undefined;
  clientContext?: ClientContextInput | null | undefined;
  settings?: CheckSettingsInput | null | undefined;
  businessType?: EvidenceInput["businessType"];
}

/** The engine input for a snapshot. Pure: same snapshot + options, same input. */
export const toEvidenceInput = (
  snap: AccountSnapshot,
  opts: AdapterOptions = {},
): EvidenceInput => {
  const data: Record<string, unknown> = {
    currencyCode: snap.account.currency_code,
    customerId: snap.account.customer_id,
    profile: { brandTerms: [...(opts.brandTerms ?? [])] },
  };
  const statusRows: Row[] = [];
  const caps: Record<string, number> = {};
  const tables: Record<string, Row[]> = {};
  for (const spec of TABLES) {
    const s = snap.sections[spec.section];
    const st = tableStatusOf(snap, spec);
    const rows = st.status === "ok" && s ? spec.rows(s, snap) : [];
    // a named table that was not read stays absent ("not read"), never an empty list
    if (spec.db) {
      if (st.status === "ok") tables[spec.key] = rows;
    } else data[spec.key] = rows;
    // an ok read that was cut before it gave a row has nothing to stand on: not read
    const emptyCut = st.status === "ok" && st.sample && rows.length === 0;
    const notRead =
      st.status === "ok" && s && spec.notReadCampaigns ? spec.notReadCampaigns(s) : [];
    statusRows.push({
      table_name: st.table,
      status: emptyCut ? "skipped" : st.status,
      row_count: st.status === "ok" && !emptyCut ? st.rowCount : 0,
      error_message: emptyCut
        ? "stopped before any row was read (time or row limit)"
        : notRead.length > 0
          ? `coverage partial: campaigns not read: ${notRead.join(",")}`
          : (st.status === "ok" && s && spec.okNote?.(s, st.sample)) ||
            (st.status === "ok" && st.sample ? st.sampleNote : null) ||
            st.message,
    });
    // a named table not read is absent: a cap under its name limits nothing (the engine warns);
    // the catalogue's own status row already says "truncated", so it is not capped again
    const cappable = (!spec.db || st.status === "ok") && spec.key !== "mcSyncStatus";
    if (cappable && st.sample && rows.length > 0) caps[spec.key] = rows.length;
    else if (cappable && st.cap !== null) caps[spec.key] = st.cap;
    // PMax terms are read one campaign at a time, each up to its own limit
    if (spec.key === "pmaxSearchTerms") {
      const per = s?.parts.find((p) => p.part === "pmax_terms")?.cap;
      if (per) caps["pmaxSearchTerms:per_campaign"] = per;
    }
    // categories and places are read one campaign at a time, each up to its own limit
    if (spec.key === "pmaxSearchInsights") {
      const per = s?.parts.find((p) => p.part === "pmax_categories")?.cap;
      if (per) caps["pmaxSearchInsights:per_campaign"] = per;
    }
    if (spec.key === "pmax_placements") {
      const per = s?.parts.find((p) => p.part === "placements")?.cap;
      if (per) caps["pmax_placements:per_campaign"] = per;
    }
  }
  // ad-group negative keywords sit on the keywords table (is_negative), as the engine reads them
  const negativesStatus = TABLES.find((t) => t.key === "campaign_negatives");
  const neg = snap.sections.negatives;
  if (neg && negativesStatus && Array.isArray(data.keywords)) {
    const part = neg.parts.find((p) => p.part === "ad_group_negatives");
    if (part?.status === "ok") {
      const extra = level(neg, "ad_group").map((r) => ({
        keyword_id: str(r.criterionId),
        campaign_id: str(r.campaignId),
        ad_group_id: str(r.adGroupId),
        text: text(r.text),
        match_type: str(r.matchType),
        status: "ENABLED",
        is_negative: true,
      }));
      (data.keywords as Row[]).push(...extra);
      const kw = statusRows.find((r) => r.table_name === AUDIT_KEY_TABLE.keywords);
      if (kw && kw.status === "ok") kw.row_count = Number(kw.row_count ?? 0) + extra.length;
      if (part.capped || part.time_cut) caps.keywords = (data.keywords as Row[]).length;
    }
  }
  // Merchant Center data this server never reads (no Merchant Center API): not read, by design
  for (const [key, what] of Object.entries(NOT_READ_TABLES))
    statusRows.push({
      table_name: AUDIT_KEY_TABLE[key] ?? key,
      status: "skipped",
      row_count: 0,
      error_message: `${MERCHANT_CENTER_NOT_READ}, and Google Ads does not show the ${what}`,
    });
  // a linked Merchant Center shows as products in Google Ads, or as a Shopping campaign's account id
  const shop = snap.sections.shopping;
  if (
    shop &&
    shop.status === "ok" &&
    (kind(shop, "product").length > 0 ||
      kind(shop, "shopping_setting").some((r) => str(r.merchantId)))
  )
    data.merchantCenterConnected = true;
  // conversion tracking settings: one account row, not a table
  const conv = snap.sections.conversions;
  const tracking = conv ? obj(detailOf(conv).trackingSettings) : {};
  const trackingPart = conv?.parts.find((p) => p.part === "tracking_settings");
  const trackingOk = trackingPart?.status === "ok" && Object.keys(tracking).length > 0;
  if (trackingOk)
    data.conversionTrackingSettings = {
      conversion_tracking_status: str(tracking.conversionTrackingStatus),
      enhanced_conversions_enabled: bool(tracking.enhancedConversions),
      accepted_customer_data_terms: bool(tracking.acceptedCustomerDataTerms),
    };
  statusRows.push({
    table_name: "conversion_tracking_settings",
    status: trackingOk
      ? "ok"
      : trackingPart && trackingPart.status !== "ok"
        ? trackingPart.status
        : "skipped",
    row_count: trackingOk ? 1 : 0,
    error_message: trackingOk
      ? null
      : (text(trackingPart?.message) ?? "the conversion tracking settings were not read"),
  });
  const ch = statusRows.find((r) => r.table_name === "change_history");
  const end = snap.date_ranges.performance.end_date;
  const runDate = new Date(Date.parse(`${end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    data: data as EvidenceInput["data"],
    tables,
    // the days the change history really covers: no check judges "no recent change" past it
    ...(ch?.status === "ok"
      ? {
          changeHistoryCoverage: {
            startDate: snap.date_ranges.change_history.start_date,
            endDate: snap.date_ranges.change_history.end_date,
          },
        }
      : {}),
    statusRows,
    caps,
    runDate,
    runId: snap.id,
    ...(opts.businessType !== undefined ? { businessType: opts.businessType } : {}),
    ...(opts.clientContext ? { clientContext: opts.clientContext } : {}),
    ...(opts.settings ? { settings: opts.settings } : {}),
  };
};
