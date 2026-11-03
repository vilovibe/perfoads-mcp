// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Ported from PerfoAds fetchAds (ad_group_ad: RSA texts with pinning, final URLs, status,
// policy_summary with a retry without it when Google refuses those fields), fetchAdExtensions
// (inventory per link level customer_asset / campaign_asset / ad_group_asset, no date filter,
// so an asset with no impressions still shows; policy fields dropped on a refusal) and
// fetchAssetPerformance (ad_group_ad_asset_view labels of RSA lines). Changes: ad_strength
// added; ad metrics read in their own query (no date filter on the inventory, so zero-spend
// ads are kept; a failed metrics read = metrics null, never zero); one inventory query per
// level for all asset types (PerfoAds: one per type and level) with a smaller fallback query
// (ids, type, field type, status) when Google refuses a field; asset metrics not read.

import * as z from "zod";
import {
  checkChoice,
  countBy,
  idConditions,
  metricLine,
  MetricsSchema,
  plural,
  shown,
  statusAndIdConditions,
  TotalsSchema,
  filterConditions,
  where,
  type FilterInput,
} from "../common.js";
import { describeDateRange } from "../dateRange.js";
import {
  byMoneyDesc,
  date,
  enumValue,
  get,
  id,
  idsFromResourceName,
  metrics,
  money,
  numberOrNull,
  text,
  textList,
  textOrNull,
  totals,
  ZERO_METRICS,
  type Metrics,
  type Row,
} from "../normalise.js";
import { partOk, type PartStatus, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const ADS_ASSETS_KINDS = ["ads", "assets"] as const;

export interface AdsAssetsInput extends FilterInput {
  /** null = both. */
  kind: (typeof ADS_ASSETS_KINDS)[number] | null;
}

export const adsAssetsInput = (filters: FilterInput, kind: unknown): AdsAssetsInput => ({
  ...filters,
  kind: checkChoice(kind, ADS_ASSETS_KINDS, "kind"),
});

const AdTextSchema = z.object({
  text: UntrustedSchema,
  pinnedField: z.string().nullable(),
  performanceLabel: z
    .string()
    .nullable()
    .describe("BEST, GOOD, LOW, LEARNING, PENDING; null = unknown"),
  assetId: z.string().nullable().describe("The line's asset id when Google rated it"),
});

export const AdDetailSchema = z.object({
  adId: z.string(),
  type: z.string().nullable(),
  adStrength: z.string().nullable(),
  approvalStatus: z.string().nullable().describe("null = not read"),
  reviewStatus: z.string().nullable(),
  policyTopics: z
    .array(z.object({ topic: UntrustedSchema, type: z.string().nullable() }))
    .describe("First 10"),
  headlines: z.array(AdTextSchema),
  descriptions: z.array(AdTextSchema),
  path1: UntrustedSchema.nullable(),
  path2: UntrustedSchema.nullable(),
  finalUrls: z.array(UntrustedSchema),
  finalMobileUrls: z.array(UntrustedSchema),
});

export const AssetDetailSchema = z.object({
  assetId: z.string(),
  type: z.string().nullable(),
  fieldType: z.string().nullable().describe("SITELINK, CALLOUT, STRUCTURED_SNIPPET, AD_IMAGE, ..."),
  primaryStatus: z.string().nullable(),
  approvalStatus: z.string().nullable(),
  name: UntrustedSchema.nullable(),
  text: UntrustedSchema.nullable().describe("Sitelink/callout text, snippet header, phone, ..."),
  description1: UntrustedSchema.nullable(),
  description2: UntrustedSchema.nullable(),
  values: z.array(UntrustedSchema).describe("Structured snippet values"),
  finalUrls: z.array(UntrustedSchema),
  imageUrl: UntrustedSchema.nullable(),
  imageWidth: z.number().nullable(),
  imageHeight: z.number().nullable(),
  percentOff: z.number().nullable().describe("Promotion: 15 = 15% off"),
  moneyOff: z.string().nullable().describe("Promotion amount off, decimal"),
  promotionCode: UntrustedSchema.nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  textsRead: z.boolean().describe("false: read with fewer fields, texts unknown"),
});

export const AdAssetRowSchema = z.object({
  kind: z.enum(["ad", "asset"]),
  level: z.enum(["account", "campaign", "ad_group"]),
  campaignId: z.string().nullable(),
  campaignName: UntrustedSchema.nullable(),
  adGroupId: z.string().nullable(),
  adGroupName: UntrustedSchema.nullable(),
  status: z.string().nullable(),
  ad: AdDetailSchema.nullable(),
  asset: AssetDetailSchema.nullable(),
  metrics: MetricsSchema.nullable().describe("Ads only; null = unknown (not read)"),
});
export type AdAssetRow = z.infer<typeof AdAssetRowSchema>;
type AdText = z.infer<typeof AdTextSchema>;

export const AdsAssetsSummarySchema = z.object({
  ads: z.number(),
  assetLinks: z.number(),
  adsByType: z.record(z.string(), z.number()),
  adsByStrength: z.record(z.string(), z.number()),
  disapprovedAds: z.number().nullable().describe("null = policy not read"),
  limitedAds: z.number().nullable(),
  assetsByFieldType: z.record(z.string(), z.number()),
  assetsByLevel: z.record(z.string(), z.number()),
  labelsRead: z.boolean(),
  adTotals: TotalsSchema.nullable().describe("null = ad metrics not read"),
});
export type AdsAssetsSummary = z.infer<typeof AdsAssetsSummarySchema>;

/** Most policy topics kept per ad. */
const TOPICS_MAX = 10;

const policyFields = `
      ad_group_ad.policy_summary.approval_status,
      ad_group_ad.policy_summary.review_status,
      ad_group_ad.policy_summary.policy_topic_entries,`;

export const adsQuery = (input: FilterInput, withPolicy: boolean): string => `
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      ad_group_ad.ad.id,
      ad_group_ad.ad.type,
      ad_group_ad.status,
      ad_group_ad.ad_strength,${withPolicy ? policyFields : ""}
      ad_group_ad.ad.final_urls,
      ad_group_ad.ad.final_mobile_urls,
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions,
      ad_group_ad.ad.responsive_search_ad.path1,
      ad_group_ad.ad.responsive_search_ad.path2
    FROM ad_group_ad
    ${where([
      "ad_group_ad.status != 'REMOVED'",
      "ad_group.status != 'REMOVED'",
      "campaign.status != 'REMOVED'",
      ...statusAndIdConditions(input, "ad_group_ad.status"),
    ])}
    ORDER BY ad_group.id, ad_group_ad.ad.id`;

export const adMetricsQuery = (input: FilterInput): string => `
    SELECT
      ad_group.id,
      ad_group_ad.ad.id,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM ad_group_ad
    ${where(["ad_group_ad.status != 'REMOVED'", ...filterConditions(input, "ad_group_ad.status")])}
    ORDER BY metrics.cost_micros DESC, ad_group_ad.ad.id`;

export const adAssetLabelsQuery = (input: FilterInput): string => `
    SELECT
      ad_group_ad_asset_view.ad_group_ad,
      ad_group_ad_asset_view.field_type,
      ad_group_ad_asset_view.performance_label,
      ad_group_ad_asset_view.pinned_field,
      asset.id,
      asset.text_asset.text
    FROM ad_group_ad_asset_view
    ${where([
      "ad_group_ad_asset_view.enabled = TRUE",
      "ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'",
      "ad_group_ad.status != 'REMOVED'",
      ...idConditions(input),
    ])}
    ORDER BY asset.id`;

const ASSET_TYPES =
  "('SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET', 'IMAGE', 'CALL', 'PROMOTION', 'PRICE', 'TEXT')";

const ASSET_TYPE_FIELDS = `
      asset.name,
      asset.final_urls,
      asset.sitelink_asset.link_text,
      asset.sitelink_asset.description1,
      asset.sitelink_asset.description2,
      asset.callout_asset.callout_text,
      asset.structured_snippet_asset.header,
      asset.structured_snippet_asset.values,
      asset.image_asset.full_size.url,
      asset.image_asset.full_size.width_pixels,
      asset.image_asset.full_size.height_pixels,
      asset.call_asset.country_code,
      asset.call_asset.phone_number,
      asset.promotion_asset.promotion_target,
      asset.promotion_asset.percent_off,
      asset.promotion_asset.money_amount_off.amount_micros,
      asset.promotion_asset.promotion_code,
      asset.promotion_asset.start_date,
      asset.promotion_asset.end_date,
      asset.price_asset.type,
      asset.text_asset.text,
      asset.policy_summary.approval_status,`;

export type AssetLevel = "account" | "campaign" | "ad_group";

const LEVEL_RESOURCE: Readonly<Record<AssetLevel, string>> = {
  account: "customer_asset",
  campaign: "campaign_asset",
  ad_group: "ad_group_asset",
};

const LEVEL_FIELDS: Readonly<Record<AssetLevel, string>> = {
  account: "",
  // Google refuses a filter on campaign.status / ad_group.status here unless they are selected too.
  campaign: `
      campaign.id,
      campaign.name,
      campaign.status,`,
  ad_group: `
      campaign.id,
      campaign.name,
      campaign.status,
      ad_group.id,
      ad_group.name,
      ad_group.status,`,
};

/** One inventory query per link level. `full` = every text field + policy; else ids only. */
export const assetLinksQuery = (level: AssetLevel, input: FilterInput, full: boolean): string => {
  const r = LEVEL_RESOURCE[level];
  const ids =
    level === "account"
      ? []
      : idConditions({
          campaignId: input.campaignId,
          adGroupId: level === "ad_group" ? input.adGroupId : null,
        });
  return `
    SELECT
      asset.id,
      asset.type,${full ? ASSET_TYPE_FIELDS : ""}${full ? `\n      ${r}.primary_status,` : ""}${LEVEL_FIELDS[level]}
      ${r}.field_type,
      ${r}.status
    FROM ${r}
    ${where([
      `${r}.status != 'REMOVED'`,
      `asset.type IN ${ASSET_TYPES}`,
      ...(level === "account" ? [] : ["campaign.status != 'REMOVED'"]),
      ...(level === "ad_group" ? ["ad_group.status != 'REMOVED'"] : []),
      ...ids,
    ])}
    ORDER BY asset.id`;
};

const LEVEL_ORDER: Readonly<Record<AssetLevel, number>> = { account: 0, campaign: 1, ad_group: 2 };

const adKey = (adGroupId: string | null, adId: string | null): string =>
  `${adGroupId ?? ""}~${adId ?? ""}`;

const adTexts = (
  v: unknown,
  labels: ReadonlyMap<string, { label: string; assetId: string | null }>,
  key: string,
  field: "HEADLINE" | "DESCRIPTION",
): AdText[] =>
  (Array.isArray(v) ? v : [])
    .filter((x): x is Row => typeof x === "object" && x !== null)
    .filter((x) => typeof x.text === "string")
    .map((x) => ({
      text: text(x.text),
      pinnedField: enumValue(x.pinnedField),
      performanceLabel:
        labels.get(`${key}|${field}|${String(x.text)}`)?.label ??
        enumValue(x.assetPerformanceLabel),
      assetId: labels.get(`${key}|${field}|${String(x.text)}`)?.assetId ?? null,
    }));

const mapAd = (
  row: Row,
  policyRead: boolean,
  labels: ReadonlyMap<string, { label: string; assetId: string | null }>,
  metricsByAd: ReadonlyMap<string, Metrics> | null,
): AdAssetRow | null => {
  const adId = id(get(row, "adGroupAd.ad.id"));
  const adGroupId = id(get(row, "adGroup.id"));
  if (!adId) return null;
  const key = adKey(adGroupId, adId);
  const a = (path: string) => get(row, `adGroupAd.ad.${path}`);
  const topics = get(row, "adGroupAd.policySummary.policyTopicEntries");
  return {
    kind: "ad",
    level: "ad_group",
    campaignId: id(get(row, "campaign.id")),
    campaignName: textOrNull(get(row, "campaign.name")),
    adGroupId,
    adGroupName: textOrNull(get(row, "adGroup.name")),
    status: enumValue(get(row, "adGroupAd.status")),
    ad: {
      adId,
      type: enumValue(a("type")),
      adStrength: enumValue(get(row, "adGroupAd.adStrength")),
      approvalStatus: policyRead
        ? enumValue(get(row, "adGroupAd.policySummary.approvalStatus"))
        : null,
      reviewStatus: policyRead ? enumValue(get(row, "adGroupAd.policySummary.reviewStatus")) : null,
      policyTopics: (Array.isArray(topics) ? topics : [])
        .filter((t): t is Row => typeof t === "object" && t !== null)
        .slice(0, TOPICS_MAX)
        .map((t) => ({ topic: text(t.topic), type: enumValue(t.type) })),
      headlines: adTexts(a("responsiveSearchAd.headlines"), labels, key, "HEADLINE"),
      descriptions: adTexts(a("responsiveSearchAd.descriptions"), labels, key, "DESCRIPTION"),
      path1: textOrNull(a("responsiveSearchAd.path1")),
      path2: textOrNull(a("responsiveSearchAd.path2")),
      finalUrls: textList(a("finalUrls")),
      finalMobileUrls: textList(a("finalMobileUrls")),
    },
    asset: null,
    metrics: metricsByAd === null ? null : (metricsByAd.get(key) ?? ZERO_METRICS),
  };
};

const linkPath: Readonly<Record<AssetLevel, string>> = {
  account: "customerAsset",
  campaign: "campaignAsset",
  ad_group: "adGroupAsset",
};

const mapAsset = (row: Row, level: AssetLevel, full: boolean): AdAssetRow | null => {
  const assetId = id(get(row, "asset.id"));
  if (!assetId) return null;
  const s = (path: string) => get(row, `asset.${path}`);
  const link = (path: string) => get(row, `${linkPath[level]}.${path}`);
  const percent = numberOrNull(s("promotionAsset.percentOff"));
  const phone = s("callAsset.phoneNumber");
  const country = s("callAsset.countryCode");
  const mainText =
    s("sitelinkAsset.linkText") ??
    s("calloutAsset.calloutText") ??
    s("structuredSnippetAsset.header") ??
    (typeof phone === "string" && phone !== ""
      ? `${typeof country === "string" ? `${country} ` : ""}${phone}`
      : undefined) ??
    s("promotionAsset.promotionTarget") ??
    s("textAsset.text");
  return {
    kind: "asset",
    level,
    campaignId: level === "account" ? null : id(get(row, "campaign.id")),
    campaignName: level === "account" ? null : textOrNull(get(row, "campaign.name")),
    adGroupId: level === "ad_group" ? id(get(row, "adGroup.id")) : null,
    adGroupName: level === "ad_group" ? textOrNull(get(row, "adGroup.name")) : null,
    status: enumValue(link("status")),
    ad: null,
    asset: {
      assetId,
      type: enumValue(s("type")),
      fieldType: enumValue(link("fieldType")),
      primaryStatus: full ? enumValue(link("primaryStatus")) : null,
      approvalStatus: full ? enumValue(s("policySummary.approvalStatus")) : null,
      name: textOrNull(s("name")),
      text: textOrNull(mainText),
      description1: textOrNull(s("sitelinkAsset.description1")),
      description2: textOrNull(s("sitelinkAsset.description2")),
      values: textList(s("structuredSnippetAsset.values")),
      finalUrls: textList(s("finalUrls")),
      imageUrl: textOrNull(s("imageAsset.fullSize.url")),
      imageWidth: numberOrNull(s("imageAsset.fullSize.widthPixels")),
      imageHeight: numberOrNull(s("imageAsset.fullSize.heightPixels")),
      // Google scales percent_off so 1,000,000 = 100% (PerfoAds learned this the hard way).
      percentOff: percent === null ? null : percent / 10_000,
      moneyOff: money(s("promotionAsset.moneyAmountOff.amountMicros")),
      promotionCode: textOrNull(s("promotionAsset.promotionCode")),
      startDate: date(s("promotionAsset.startDate")),
      endDate: date(s("promotionAsset.endDate")),
      textsRead: full,
    },
    metrics: null,
  };
};

const partOf = (parts: readonly PartStatus[], name: string) => parts.find((p) => p.part === name);

const LEVELS: readonly AssetLevel[] = ["account", "campaign", "ad_group"];

export const adsAssetsReader: ReaderDef<AdsAssetsInput, AdAssetRow, AdsAssetsSummary, null> = {
  name: "ads_and_assets",
  queries: (input) => {
    const parts: Record<string, { gaql: string; fallback?: string }> = {};
    if (input.kind !== "assets") {
      parts.ads = { gaql: adsQuery(input, true), fallback: adsQuery(input, false) };
      parts.ad_metrics = { gaql: adMetricsQuery(input) };
      parts.ad_asset_labels = { gaql: adAssetLabelsQuery(input) };
    }
    if (input.kind !== "ads") {
      for (const level of LEVELS) {
        // Account-level assets have no campaign: a campaign/ad group filter leaves them out.
        if (level === "account" && (input.campaignId || input.adGroupId)) continue;
        if (level === "campaign" && input.adGroupId) continue;
        parts[`${level}_assets`] = {
          gaql: assetLinksQuery(level, input, true),
          fallback: assetLinksQuery(level, input, false),
        };
      }
    }
    return parts;
  },
  map: (data, _input, _ctx, parts) => {
    const labels = new Map<string, { label: string; assetId: string | null }>();
    for (const row of data.ad_asset_labels ?? []) {
      const [adGroupId, adId] = idsFromResourceName(get(row, "adGroupAdAssetView.adGroupAd"));
      const field = enumValue(get(row, "adGroupAdAssetView.fieldType"));
      const label = enumValue(get(row, "adGroupAdAssetView.performanceLabel"));
      const line = get(row, "asset.textAsset.text");
      if (!adGroupId || !adId || !field || !label || typeof line !== "string") continue;
      labels.set(`${adKey(adGroupId, adId)}|${field}|${line}`, {
        label,
        assetId: id(get(row, "asset.id")),
      });
    }
    let metricsByAd: Map<string, Metrics> | null = null;
    if (partOk(parts, "ad_metrics")) {
      metricsByAd = new Map();
      for (const row of data.ad_metrics ?? []) {
        metricsByAd.set(
          adKey(id(get(row, "adGroup.id")), id(get(row, "adGroupAd.ad.id"))),
          metrics(row),
        );
      }
    }
    const policyRead = partOf(parts, "ads")?.fallback !== true;
    const rows: AdAssetRow[] = [];
    for (const row of data.ads ?? []) {
      const ad = mapAd(row, policyRead, labels, metricsByAd);
      if (ad) rows.push(ad);
    }
    for (const level of LEVELS) {
      const name = `${level}_assets`;
      const full = partOf(parts, name)?.fallback !== true;
      for (const row of data[name] ?? []) {
        const asset = mapAsset(row, level, full);
        if (asset) rows.push(asset);
      }
    }
    return { rows, extra: null };
  },
  compare: (a, b) =>
    (a.kind === b.kind ? 0 : a.kind === "ad" ? -1 : 1) ||
    (a.metrics && b.metrics ? byMoneyDesc(a.metrics.cost, b.metrics.cost) : 0) ||
    LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
    (a.campaignId ?? "").localeCompare(b.campaignId ?? "") ||
    (a.adGroupId ?? "").localeCompare(b.adGroupId ?? "") ||
    (a.asset?.fieldType ?? "").localeCompare(b.asset?.fieldType ?? "") ||
    (a.ad?.adId ?? a.asset?.assetId ?? "").localeCompare(b.ad?.adId ?? b.asset?.assetId ?? ""),
  summarise: (rows, _extra, _ctx, _input, parts) => {
    const ads = rows.filter((r) => r.kind === "ad");
    const assets = rows.filter((r) => r.kind === "asset");
    const adsOk = partOk(parts, "ads");
    const policyKnown = adsOk && partOf(parts, "ads")?.fallback !== true;
    return {
      ads: ads.length,
      assetLinks: assets.length,
      adsByType: countBy(ads, (r) => r.ad?.type ?? null),
      adsByStrength: countBy(ads, (r) => r.ad?.adStrength ?? null),
      disapprovedAds: policyKnown
        ? ads.filter((r) => r.ad?.approvalStatus === "DISAPPROVED").length
        : null,
      limitedAds: policyKnown
        ? ads.filter((r) => r.ad?.approvalStatus === "APPROVED_LIMITED").length
        : null,
      assetsByFieldType: countBy(assets, (r) => r.asset?.fieldType ?? null),
      assetsByLevel: countBy(assets, (r) => r.level),
      labelsRead: partOk(parts, "ad_asset_labels"),
      adTotals:
        adsOk && partOk(parts, "ad_metrics")
          ? totals(ads.map((r) => r.metrics ?? ZERO_METRICS))
          : null,
    };
  },
  summaryLine: (s, ctx, input) =>
    `${plural(s.ads, "ad")} and ${plural(s.assetLinks, "asset link")} on ${ctx.customerId}` +
    (s.adTotals ? `, ${describeDateRange(input.dateRange)}: ${metricLine(s.adTotals, ctx)}` : "") +
    `. Disapproved ads: ${s.disapprovedAds ?? "unknown (policy not read)"}; limited: ${s.limitedAds ?? "unknown"}.`,
  rowLine: (r, ctx) => {
    if (r.ad) {
      const lines = `${r.ad.headlines.length} headlines, ${r.ad.descriptions.length} descriptions`;
      return `ad ${r.ad.adId} ${r.ad.type ?? "?"} in ad group ${r.adGroupId ?? "?"}, ${r.status ?? "?"}, strength ${r.ad.adStrength ?? "?"}, policy ${r.ad.approvalStatus ?? "unknown"}: ${lines}${r.metrics ? `; ${metricLine(r.metrics, ctx)}` : "; metrics unknown"}`;
    }
    const a = r.asset;
    const place =
      r.level === "account"
        ? "account"
        : r.level === "campaign"
          ? `campaign ${r.campaignId ?? "?"}`
          : `ad group ${r.adGroupId ?? "?"}`;
    return `asset ${a?.assetId ?? "?"} ${a?.fieldType ?? a?.type ?? "?"} (${place}) ${shown(a?.text ?? null)}`;
  },
};
