// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). The Performance Max structure the PMax checks
// read, one GAQL resource per part:
// - asset_groups (asset_group): every non-removed asset group with its status and ad strength;
// - asset_group_metrics (asset_group, over the range): its spend. Google drops a row with no
//   activity, so the structure is read apart from the metrics (a quiet group is still a group);
// - assets (asset_group_asset): each asset link with its field type, status, Google's verdict
//   and the asset's text / image size / video title;
// - listing_groups (asset_group_listing_group_filter): the product selection tree (Shopping
//   listing source only; a page-feed tree is not a product selection);
// - signals (asset_group_signal): search themes and audience signals;
// - channels (campaign, segmented by ad network, over the range): where each PMax campaign spent;
// - pmax_campaigns (campaign): the live PMax campaigns, then one placements part per campaign
//   (performance_max_placement_view, impressions only: Google reports no cost per place), the
//   most-seen places first, up to PLACEMENTS_PER_CAMPAIGN.

import * as z from "zod";
import { MetricsSchema, plural, where, type FilterInput } from "../common.js";
import { dateCondition, describeDateRange } from "../dateRange.js";
import {
  count,
  enumValue,
  get,
  id,
  idFromResourceName,
  metrics,
  moneyOrZero,
  numberOrNull,
  textOrNull,
  type Row,
} from "../normalise.js";
import { partOk, type Part, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const PMAX_ROW_KINDS = [
  "asset_group",
  "asset",
  "listing_group",
  "signal",
  "channel",
  "placement",
] as const;

export const PmaxRowSchema = z.object({
  kind: z.enum(PMAX_ROW_KINDS),
  campaignId: z.string().nullable(),
  assetGroupId: z.string().nullable(),
  name: UntrustedSchema.nullable().describe("asset group name; placement display name"),
  status: z.string().nullable().describe("asset group status; asset link status"),
  adStrength: z.string().nullable(),
  assetId: z.string().nullable(),
  assetType: z.string().nullable(),
  fieldType: z.string().nullable(),
  primaryStatus: z.string().nullable(),
  primaryStatusDetails: z.array(z.unknown()).nullable().describe("Google's own detail objects"),
  source: z.string().nullable(),
  text: UntrustedSchema.nullable().describe("asset text; search theme"),
  videoTitle: UntrustedSchema.nullable(),
  imageWidthPx: z.number().nullable(),
  imageHeightPx: z.number().nullable(),
  listingGroupId: z.string().nullable(),
  parentListingGroupId: z.string().nullable(),
  listingType: z.string().nullable(),
  caseValue: z.record(z.string(), z.unknown()).nullable().describe("the dimension of the node"),
  audienceResource: z.string().nullable(),
  approvalStatus: z.string().nullable(),
  disapprovalReasons: z.array(z.string()).nullable(),
  adNetworkType: z.string().nullable(),
  placement: UntrustedSchema.nullable(),
  placementType: z.string().nullable(),
  targetUrl: UntrustedSchema.nullable(),
  metrics: MetricsSchema.nullable().describe("null = not read for this row"),
});
export type PmaxRow = z.infer<typeof PmaxRowSchema>;

export const PmaxSummarySchema = z.object({
  assetGroups: z.number().nullable().describe("null = not read"),
  assets: z.number().nullable(),
  listingGroups: z.number().nullable(),
  signals: z.number().nullable(),
  channelRows: z.number().nullable(),
  placements: z.number().nullable(),
});
export type PmaxSummary = z.infer<typeof PmaxSummarySchema>;

/** Most places read per campaign (the most-seen first). */
export const PLACEMENTS_PER_CAMPAIGN = 200;
/**
 * PMax campaigns whose places are read in one snapshot, the highest-cost first: one query each,
 * so the default keeps the Google Ads operations of a big account down. The caller may ask for
 * 1 to PLACEMENT_CAMPAIGNS_MAX.
 */
export const PLACEMENT_CAMPAIGNS_DEFAULT = 15;
export const PLACEMENT_CAMPAIGNS_MAX = 30;

export interface PmaxInput extends FilterInput {
  /** How many PMax campaigns get their places read (1-30, default 15). */
  placementCampaigns?: number | undefined;
}

export const PmaxExtraSchema = z.object({
  placementsNotRead: z
    .array(z.string())
    .describe("live PMax campaigns whose places were not read (past the limit, failed or cut)"),
  placementsCapped: z
    .array(z.string())
    .describe("campaigns whose place list stopped at PLACEMENTS_PER_CAMPAIGN (more exist)"),
});
export type PmaxExtra = z.infer<typeof PmaxExtraSchema>;

const placementCampaignsOf = (input: PmaxInput): number =>
  Math.min(
    PLACEMENT_CAMPAIGNS_MAX,
    Math.max(1, Math.floor(input.placementCampaigns ?? PLACEMENT_CAMPAIGNS_DEFAULT)),
  );

const PMAX = "campaign.advertising_channel_type = 'PERFORMANCE_MAX'";
const LIVE_CAMPAIGN = "campaign.status != 'REMOVED'";

const METRIC_FIELDS = `
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value`;

export const assetGroupsQuery = (): string => `
    SELECT
      campaign.id,
      asset_group.id,
      asset_group.name,
      asset_group.status,
      asset_group.ad_strength
    FROM asset_group
    ${where([PMAX, LIVE_CAMPAIGN, "asset_group.status != 'REMOVED'"])}
    ORDER BY asset_group.id`;

export const assetGroupMetricsQuery = (input: FilterInput): string => `
    SELECT
      asset_group.id,${METRIC_FIELDS}
    FROM asset_group
    ${where([dateCondition(input.dateRange), PMAX, "asset_group.status != 'REMOVED'"])}
    ORDER BY asset_group.id`;

export const assetGroupAssetsQuery = (): string => `
    SELECT
      campaign.id,
      asset_group.id,
      asset.id,
      asset.type,
      asset.text_asset.text,
      asset.image_asset.full_size.width_pixels,
      asset.image_asset.full_size.height_pixels,
      asset.youtube_video_asset.youtube_video_title,
      asset_group_asset.field_type,
      asset_group_asset.status,
      asset_group_asset.primary_status,
      asset_group_asset.primary_status_details,
      asset_group_asset.source
    FROM asset_group_asset
    ${where([PMAX, LIVE_CAMPAIGN, "asset_group.status != 'REMOVED'", "asset_group_asset.status != 'REMOVED'"])}
    ORDER BY asset_group.id, asset.id`;

export const listingGroupsQuery = (): string => `
    SELECT
      asset_group.id,
      asset_group_listing_group_filter.id,
      asset_group_listing_group_filter.type,
      asset_group_listing_group_filter.parent_listing_group_filter,
      asset_group_listing_group_filter.listing_source,
      asset_group_listing_group_filter.case_value.product_item_id.value,
      asset_group_listing_group_filter.case_value.product_custom_attribute.index,
      asset_group_listing_group_filter.case_value.product_custom_attribute.value,
      asset_group_listing_group_filter.case_value.product_type.level,
      asset_group_listing_group_filter.case_value.product_type.value,
      asset_group_listing_group_filter.case_value.product_brand.value,
      asset_group_listing_group_filter.case_value.product_category.category_id,
      asset_group_listing_group_filter.case_value.product_category.level,
      asset_group_listing_group_filter.case_value.product_condition.condition,
      asset_group_listing_group_filter.case_value.product_channel.channel
    FROM asset_group_listing_group_filter
    ${where([
      PMAX,
      LIVE_CAMPAIGN,
      "asset_group.status != 'REMOVED'",
      // the product tree only: a page-feed (WEBPAGE) tree would read as products
      "asset_group_listing_group_filter.listing_source = 'SHOPPING'",
    ])}
    ORDER BY asset_group.id, asset_group_listing_group_filter.id`;

export const signalsQuery = (): string => `
    SELECT
      asset_group.id,
      asset_group_signal.search_theme.text,
      asset_group_signal.audience.audience,
      asset_group_signal.approval_status,
      asset_group_signal.disapproval_reasons
    FROM asset_group_signal
    ${where([PMAX, LIVE_CAMPAIGN, "asset_group.status != 'REMOVED'"])}
    ORDER BY asset_group.id`;

export const channelsQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      segments.ad_network_type,${METRIC_FIELDS}
    FROM campaign
    ${where([dateCondition(input.dateRange), PMAX])}
    ORDER BY campaign.id`;

export const pmaxLiveCampaignsQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      campaign.status,
      metrics.cost_micros
    FROM campaign
    ${where([dateCondition(input.dateRange), PMAX, LIVE_CAMPAIGN])}
    ORDER BY metrics.cost_micros DESC`;

/** One campaign's places, most-seen first. campaignId is digits (checked). */
export const placementsQuery = (campaignId: string, input: FilterInput): string => {
  if (!/^\d{1,20}$/.test(campaignId)) throw new TypeError("campaign id must be digits");
  return `
    SELECT
      campaign.id,
      performance_max_placement_view.placement,
      performance_max_placement_view.placement_type,
      performance_max_placement_view.display_name,
      performance_max_placement_view.target_url,
      metrics.impressions
    FROM performance_max_placement_view
    ${where([`campaign.id = ${campaignId}`, dateCondition(input.dateRange)])}
    ORDER BY metrics.impressions DESC`;
};

const placementPart = (campaignId: string) => `placements_${campaignId}`;

/** Live = ENABLED, or another non-removed status with spend in the range. */
const livePmaxIds = (rows: readonly Row[]): string[] =>
  rows
    .filter((r) => {
      const st = enumValue(get(r, "campaign.status"));
      return st === "ENABLED" || moneyOrZero(get(r, "metrics.costMicros")) !== "0";
    })
    .map((r) => id(get(r, "campaign.id")))
    .filter((x): x is string => x !== null);

const EMPTY: Omit<PmaxRow, "kind"> = {
  campaignId: null,
  assetGroupId: null,
  name: null,
  status: null,
  adStrength: null,
  assetId: null,
  assetType: null,
  fieldType: null,
  primaryStatus: null,
  primaryStatusDetails: null,
  source: null,
  text: null,
  videoTitle: null,
  imageWidthPx: null,
  imageHeightPx: null,
  listingGroupId: null,
  parentListingGroupId: null,
  listingType: null,
  caseValue: null,
  audienceResource: null,
  approvalStatus: null,
  disapprovalReasons: null,
  adNetworkType: null,
  placement: null,
  placementType: null,
  targetUrl: null,
  metrics: null,
};

/** The one dimension a listing-group node carries, as {dimension: {field: value}}. */
const caseValueOf = (row: Row): Record<string, unknown> | null => {
  const cv = get(row, "assetGroupListingGroupFilter.caseValue");
  if (cv === undefined || cv === null || typeof cv !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cv as Record<string, unknown>)) {
    if (v === null || typeof v !== "object") continue;
    const fields: Record<string, unknown> = {};
    for (const [f, x] of Object.entries(v as Record<string, unknown>))
      if (typeof x === "string" || typeof x === "number") fields[f] = String(x);
    out[k] = fields;
  }
  return out;
};

const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;

export const pmaxReader: ReaderDef<PmaxInput, PmaxRow, PmaxSummary, PmaxExtra> = {
  name: "pmax",
  queries: (input) => ({
    asset_groups: { gaql: assetGroupsQuery() },
    asset_group_metrics: { gaql: assetGroupMetricsQuery(input) },
    assets: { gaql: assetGroupAssetsQuery() },
    listing_groups: { gaql: listingGroupsQuery() },
    signals: { gaql: signalsQuery() },
    channels: { gaql: channelsQuery(input) },
    pmax_campaigns: { gaql: pmaxLiveCampaignsQuery(input) },
  }),
  followUp: (input, _ctx, data) => {
    const parts: Record<string, Part> = {};
    for (const cid of livePmaxIds(data.pmax_campaigns ?? []).slice(0, placementCampaignsOf(input)))
      parts[placementPart(cid)] = {
        gaql: placementsQuery(cid, input),
        limit: PLACEMENTS_PER_CAMPAIGN,
        topOnly: true,
        group: { name: "placements", key: cid },
      };
    return parts;
  },
  map: (data, input, _ctx, parts) => {
    const rows: PmaxRow[] = [];
    const live = livePmaxIds(data.pmax_campaigns ?? []);
    const read = live.slice(0, placementCampaignsOf(input));
    const placementsNotRead = [
      ...read.filter((cid) => !partOk(parts, placementPart(cid))),
      ...live.slice(read.length),
    ];
    const placementsCapped = read.filter(
      (cid) => (data[placementPart(cid)] ?? []).length >= PLACEMENTS_PER_CAMPAIGN,
    );
    const metricsByGroup = new Map<string, PmaxRow["metrics"]>();
    for (const r of data.asset_group_metrics ?? []) {
      const gid = id(get(r, "assetGroup.id"));
      if (gid) metricsByGroup.set(gid, metrics(r));
    }
    const metricsRead = partOk(parts, "asset_group_metrics");
    for (const r of data.asset_groups ?? []) {
      const gid = id(get(r, "assetGroup.id"));
      if (!gid) continue;
      rows.push({
        ...EMPTY,
        kind: "asset_group",
        campaignId: id(get(r, "campaign.id")),
        assetGroupId: gid,
        name: textOrNull(get(r, "assetGroup.name")),
        status: enumValue(get(r, "assetGroup.status")),
        adStrength: enumValue(get(r, "assetGroup.adStrength")),
        // a group with no metrics row had no activity in the range
        metrics: metricsRead ? (metricsByGroup.get(gid) ?? metrics({})) : null,
      });
    }
    for (const r of data.assets ?? []) {
      const gid = id(get(r, "assetGroup.id"));
      if (!gid) continue;
      const details = get(r, "assetGroupAsset.primaryStatusDetails");
      rows.push({
        ...EMPTY,
        kind: "asset",
        campaignId: id(get(r, "campaign.id")),
        assetGroupId: gid,
        assetId: id(get(r, "asset.id")),
        assetType: enumValue(get(r, "asset.type")),
        fieldType: enumValue(get(r, "assetGroupAsset.fieldType")),
        status: enumValue(get(r, "assetGroupAsset.status")),
        primaryStatus: enumValue(get(r, "assetGroupAsset.primaryStatus")),
        primaryStatusDetails: Array.isArray(details) ? details : null,
        source: enumValue(get(r, "assetGroupAsset.source")),
        text: textOrNull(get(r, "asset.textAsset.text")),
        videoTitle: textOrNull(get(r, "asset.youtubeVideoAsset.youtubeVideoTitle")),
        imageWidthPx: numberOrNull(get(r, "asset.imageAsset.fullSize.widthPixels")),
        imageHeightPx: numberOrNull(get(r, "asset.imageAsset.fullSize.heightPixels")),
      });
    }
    for (const r of data.listing_groups ?? []) {
      const gid = id(get(r, "assetGroup.id"));
      const lid = id(get(r, "assetGroupListingGroupFilter.id"));
      if (!gid || !lid) continue;
      rows.push({
        ...EMPTY,
        kind: "listing_group",
        assetGroupId: gid,
        listingGroupId: lid,
        parentListingGroupId: idFromResourceName(
          get(r, "assetGroupListingGroupFilter.parentListingGroupFilter"),
        ),
        listingType: enumValue(get(r, "assetGroupListingGroupFilter.type")),
        caseValue: caseValueOf(r),
      });
    }
    for (const r of data.signals ?? []) {
      const gid = id(get(r, "assetGroup.id"));
      if (!gid) continue;
      const audience = get(r, "assetGroupSignal.audience.audience");
      rows.push({
        ...EMPTY,
        kind: "signal",
        assetGroupId: gid,
        text: textOrNull(get(r, "assetGroupSignal.searchTheme.text")),
        audienceResource: typeof audience === "string" ? audience : null,
        approvalStatus: enumValue(get(r, "assetGroupSignal.approvalStatus")),
        disapprovalReasons: stringList(get(r, "assetGroupSignal.disapprovalReasons")),
      });
    }
    for (const r of data.channels ?? []) {
      const cid = id(get(r, "campaign.id"));
      const net = enumValue(get(r, "segments.adNetworkType"));
      if (!cid || !net) continue;
      rows.push({
        ...EMPTY,
        kind: "channel",
        campaignId: cid,
        adNetworkType: net,
        metrics: metrics(r),
      });
    }
    for (const [part, list] of Object.entries(data)) {
      if (!part.startsWith("placements_")) continue;
      for (const r of list ?? []) {
        const cid = id(get(r, "campaign.id"));
        if (!cid) continue;
        rows.push({
          ...EMPTY,
          kind: "placement",
          campaignId: cid,
          placement: textOrNull(get(r, "performanceMaxPlacementView.placement")),
          placementType: enumValue(get(r, "performanceMaxPlacementView.placementType")),
          name: textOrNull(get(r, "performanceMaxPlacementView.displayName")),
          targetUrl: textOrNull(get(r, "performanceMaxPlacementView.targetUrl")),
          metrics: { ...metrics({}), impressions: count(get(r, "metrics.impressions")) },
        });
      }
    }
    return { rows, extra: { placementsNotRead, placementsCapped } };
  },
  compare: (a, b) =>
    PMAX_ROW_KINDS.indexOf(a.kind) - PMAX_ROW_KINDS.indexOf(b.kind) ||
    (a.campaignId ?? "").localeCompare(b.campaignId ?? "") ||
    (a.assetGroupId ?? "").localeCompare(b.assetGroupId ?? "") ||
    (a.assetId ?? a.listingGroupId ?? a.adNetworkType ?? "").localeCompare(
      b.assetId ?? b.listingGroupId ?? b.adNetworkType ?? "",
    ) ||
    (b.metrics?.impressions ?? 0) - (a.metrics?.impressions ?? 0) ||
    (a.placement?.untrusted ?? a.text?.untrusted ?? "").localeCompare(
      b.placement?.untrusted ?? b.text?.untrusted ?? "",
    ),
  summarise: (rows, _extra, _ctx, _input, parts) => {
    const n = (kind: PmaxRow["kind"], part: string) =>
      partOk(parts, part) ? rows.filter((r) => r.kind === kind).length : null;
    const placementParts = parts.filter((p) => p.part.startsWith("placements_"));
    return {
      assetGroups: n("asset_group", "asset_groups"),
      assets: n("asset", "assets"),
      listingGroups: n("listing_group", "listing_groups"),
      signals: n("signal", "signals"),
      channelRows: n("channel", "channels"),
      placements:
        partOk(parts, "pmax_campaigns") && placementParts.every((p) => p.status === "ok")
          ? rows.filter((r) => r.kind === "placement").length
          : null,
    };
  },
  summaryLine: (s, ctx, input) =>
    `Performance Max on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${s.assetGroups === null ? "asset groups unknown" : plural(s.assetGroups, "asset group")}, ${s.assets === null ? "assets unknown" : plural(s.assets, "asset")}, ${s.placements === null ? "placements unknown" : plural(s.placements, "placement")}.`,
  rowLine: (r) =>
    `${r.kind} ${r.campaignId ?? ""} ${r.assetGroupId ?? ""} ${r.fieldType ?? r.listingType ?? r.adNetworkType ?? r.placementType ?? ""}`.trim(),
};
