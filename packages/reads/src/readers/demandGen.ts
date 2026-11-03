// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). The Demand Gen set-up the Demand Gen checks
// read, one GAQL resource per part:
// - dg_campaigns (campaign): each non-removed Demand Gen campaign's product feed link (Merchant
//   Center id, feed label, feed switched off). Its bidding goals are the conversion goals the
//   campaigns section reads (campaign.optimization_goal_setting is not a Demand Gen setting:
//   it holds call, directions and app pre-registration goals only, so it is not read);
// - dg_assets (ad_group_ad_asset_view): the assets each Demand Gen ad uses now (removed links
//   left out), with the field they fill (headline, description, image, video) and the ad's type;
// - dg_audiences (ad_group_criterion): the audience criteria of Demand Gen ad groups
//   (positive targeting and exclusions);
// - dg_channels (campaign, segmented by ad network, over the range): where each Demand Gen
//   campaign spent (YouTube, Discover, Gmail, Display);
// - dg_channel_controls (ad_group): where each Demand Gen ad group is ALLOWED to show (its
//   channel controls: every channel, Google's own channels, or a chosen set). Unset booleans are
//   omitted by the API, so a chosen set names only the surfaces switched on.

import * as z from "zod";
import { MetricsSchema, plural, where, type FilterInput } from "../common.js";
import { dateCondition, describeDateRange } from "../dateRange.js";
import {
  enumValue,
  get,
  id,
  idFromResourceName,
  metrics,
  textOrNull,
  type Row,
} from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const DG_ROW_KINDS = [
  "campaign",
  "asset",
  "audience",
  "channel",
  "channel_control",
] as const;

/** The surfaces a Demand Gen ad group's channel controls can pick, as the API names them. */
export const DG_SELECTED_CHANNELS = [
  "discover",
  "youtubeInFeed",
  "youtubeInStream",
  "youtubeShorts",
  "gmail",
  "display",
] as const;

export const DemandGenRowSchema = z.object({
  kind: z.enum(DG_ROW_KINDS),
  campaignId: z.string(),
  adGroupId: z.string().nullable(),
  merchantId: z.string().nullable(),
  feedLabel: UntrustedSchema.nullable(),
  feedDisabled: z.boolean().nullable().describe("campaigns: the product feed is switched off"),
  adId: z.string().nullable(),
  adType: z.string().nullable(),
  assetId: z.string().nullable(),
  assetType: z.string().nullable(),
  fieldType: z.string().nullable(),
  enabled: z.boolean().nullable(),
  criterionId: z.string().nullable(),
  criterionType: z.string().nullable(),
  negative: z.boolean().nullable(),
  userListId: z.string().nullable(),
  audienceResource: z.string().nullable(),
  adNetworkType: z.string().nullable(),
  metrics: MetricsSchema.nullable(),
  adGroupStatus: z.string().nullable().describe("channel controls: the ad group's status"),
  channelConfig: z
    .string()
    .nullable()
    .describe("channel controls: CHANNEL_STRATEGY or SELECTED_CHANNELS; null = not set"),
  channelStrategy: z
    .string()
    .nullable()
    .describe("channel controls: ALL_CHANNELS or ALL_OWNED_AND_OPERATED_CHANNELS"),
  selectedChannels: z
    .array(z.enum(DG_SELECTED_CHANNELS))
    .nullable()
    .describe("channel controls: the surfaces switched on when the config is SELECTED_CHANNELS"),
});
export type DemandGenRow = z.infer<typeof DemandGenRowSchema>;

export const DemandGenSummarySchema = z.object({
  campaigns: z.number().nullable().describe("null = not read"),
  assets: z.number().nullable(),
  audiences: z.number().nullable(),
  channelRows: z.number().nullable(),
  channelControlRows: z.number().nullable(),
});
export type DemandGenSummary = z.infer<typeof DemandGenSummarySchema>;

const DG = "campaign.advertising_channel_type = 'DEMAND_GEN'";
const LIVE = "campaign.status != 'REMOVED'";

export const DG_CAMPAIGNS_QUERY = `
    SELECT
      campaign.id,
      campaign.shopping_setting.merchant_id,
      campaign.shopping_setting.feed_label,
      campaign.shopping_setting.disable_product_feed
    FROM campaign
    ${where([DG, LIVE])}
    ORDER BY campaign.id`;

export const DG_ASSETS_QUERY = `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group_ad.ad.id,
      ad_group_ad.ad.type,
      asset.id,
      asset.type,
      ad_group_ad_asset_view.field_type,
      ad_group_ad_asset_view.enabled
    FROM ad_group_ad_asset_view
    ${where([
      DG,
      LIVE,
      "ad_group.status != 'REMOVED'",
      "ad_group_ad.status != 'REMOVED'",
      // false = the link was removed from the ad (Google: "no longer present"), not paused
      "ad_group_ad_asset_view.enabled = TRUE",
    ])}
    ORDER BY campaign.id, ad_group_ad.ad.id, asset.id`;

export const DG_AUDIENCES_QUERY = `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group_criterion.criterion_id,
      ad_group_criterion.type,
      ad_group_criterion.negative,
      ad_group_criterion.user_list.user_list,
      ad_group_criterion.audience.audience,
      ad_group_criterion.custom_audience.custom_audience
    FROM ad_group_criterion
    ${where([
      DG,
      LIVE,
      "ad_group.status != 'REMOVED'",
      "ad_group_criterion.status != 'REMOVED'",
      "ad_group_criterion.type IN ('USER_LIST', 'AUDIENCE', 'CUSTOM_AUDIENCE', 'USER_INTEREST', 'COMBINED_AUDIENCE')",
    ])}
    ORDER BY campaign.id, ad_group.id, ad_group_criterion.criterion_id`;

export const dgChannelsQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      segments.ad_network_type,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    ${where([dateCondition(input.dateRange), DG, LIVE])}
    ORDER BY campaign.id`;

export const DG_CHANNEL_CONTROLS_QUERY = `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group.status,
      ad_group.demand_gen_ad_group_settings.channel_controls.channel_config,
      ad_group.demand_gen_ad_group_settings.channel_controls.channel_strategy,
      ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.discover,
      ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.youtube_in_feed,
      ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.youtube_in_stream,
      ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.youtube_shorts,
      ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.gmail,
      ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.display
    FROM ad_group
    ${where([DG, LIVE, "ad_group.status != 'REMOVED'"])}
    ORDER BY campaign.id, ad_group.id`;

const EMPTY: Omit<DemandGenRow, "kind" | "campaignId"> = {
  adGroupId: null,
  merchantId: null,
  feedLabel: null,
  feedDisabled: null,
  adId: null,
  adType: null,
  assetId: null,
  assetType: null,
  fieldType: null,
  enabled: null,
  criterionId: null,
  criterionType: null,
  negative: null,
  userListId: null,
  audienceResource: null,
  adNetworkType: null,
  metrics: null,
  adGroupStatus: null,
  channelConfig: null,
  channelStrategy: null,
  selectedChannels: null,
};

const resourceOrNull = (v: unknown): string | null =>
  typeof v === "string" && /^customers\/\d+\/[A-Za-z]+\/\d+$/.test(v) ? v : null;

const mapCampaign = (r: Row): DemandGenRow | null => {
  const campaignId = id(get(r, "campaign.id"));
  if (!campaignId) return null;
  const merchantId = id(get(r, "campaign.shoppingSetting.merchantId"));
  return {
    ...EMPTY,
    kind: "campaign",
    campaignId,
    merchantId: merchantId === "0" ? null : merchantId,
    feedLabel: textOrNull(get(r, "campaign.shoppingSetting.feedLabel")),
    feedDisabled: get(r, "campaign.shoppingSetting.disableProductFeed") === true,
  };
};

const mapAsset = (r: Row): DemandGenRow | null => {
  const campaignId = id(get(r, "campaign.id"));
  if (!campaignId) return null;
  return {
    ...EMPTY,
    kind: "asset",
    campaignId,
    adGroupId: id(get(r, "adGroup.id")),
    adId: id(get(r, "adGroupAd.ad.id")),
    adType: enumValue(get(r, "adGroupAd.ad.type")),
    assetId: id(get(r, "asset.id")),
    assetType: enumValue(get(r, "asset.type")),
    fieldType: enumValue(get(r, "adGroupAdAssetView.fieldType")),
    enabled: get(r, "adGroupAdAssetView.enabled") === true,
  };
};

const mapAudience = (r: Row): DemandGenRow | null => {
  const campaignId = id(get(r, "campaign.id"));
  if (!campaignId) return null;
  return {
    ...EMPTY,
    kind: "audience",
    campaignId,
    adGroupId: id(get(r, "adGroup.id")),
    criterionId: id(get(r, "adGroupCriterion.criterionId")),
    criterionType: enumValue(get(r, "adGroupCriterion.type")),
    negative: get(r, "adGroupCriterion.negative") === true,
    userListId: idFromResourceName(get(r, "adGroupCriterion.userList.userList")),
    audienceResource:
      resourceOrNull(get(r, "adGroupCriterion.audience.audience")) ??
      resourceOrNull(get(r, "adGroupCriterion.customAudience.customAudience")),
  };
};

const mapChannel = (r: Row): DemandGenRow | null => {
  const campaignId = id(get(r, "campaign.id"));
  const net = enumValue(get(r, "segments.adNetworkType"));
  if (!campaignId || !net) return null;
  return { ...EMPTY, kind: "channel", campaignId, adNetworkType: net, metrics: metrics(r) };
};

const mapChannelControl = (r: Row): DemandGenRow | null => {
  const campaignId = id(get(r, "campaign.id"));
  const adGroupId = id(get(r, "adGroup.id"));
  if (!campaignId || !adGroupId) return null;
  const cc = (path: string) => get(r, `adGroup.demandGenAdGroupSettings.channelControls.${path}`);
  return {
    ...EMPTY,
    kind: "channel_control",
    campaignId,
    adGroupId,
    adGroupStatus: enumValue(get(r, "adGroup.status")),
    channelConfig: enumValue(cc("channelConfig")),
    channelStrategy: enumValue(cc("channelStrategy")),
    // an unset boolean is omitted: missing = off
    selectedChannels: DG_SELECTED_CHANNELS.filter((c) => cc(`selectedChannels.${c}`) === true),
  };
};

export const demandGenReader: ReaderDef<FilterInput, DemandGenRow, DemandGenSummary, null> = {
  name: "demand_gen",
  queries: (input) => ({
    dg_campaigns: { gaql: DG_CAMPAIGNS_QUERY },
    dg_assets: { gaql: DG_ASSETS_QUERY },
    dg_audiences: { gaql: DG_AUDIENCES_QUERY },
    dg_channels: { gaql: dgChannelsQuery(input) },
    dg_channel_controls: { gaql: DG_CHANNEL_CONTROLS_QUERY },
  }),
  map: (data) => ({
    rows: [
      ...(data.dg_campaigns ?? []).map(mapCampaign),
      ...(data.dg_assets ?? []).map(mapAsset),
      ...(data.dg_audiences ?? []).map(mapAudience),
      ...(data.dg_channels ?? []).map(mapChannel),
      ...(data.dg_channel_controls ?? []).map(mapChannelControl),
    ].filter((r): r is DemandGenRow => r !== null),
    extra: null,
  }),
  compare: (a, b) =>
    DG_ROW_KINDS.indexOf(a.kind) - DG_ROW_KINDS.indexOf(b.kind) ||
    a.campaignId.localeCompare(b.campaignId) ||
    (a.adGroupId ?? "").localeCompare(b.adGroupId ?? "") ||
    (a.adId ?? a.criterionId ?? a.adNetworkType ?? "").localeCompare(
      b.adId ?? b.criterionId ?? b.adNetworkType ?? "",
    ) ||
    (a.assetId ?? "").localeCompare(b.assetId ?? "") ||
    (a.fieldType ?? "").localeCompare(b.fieldType ?? ""),
  summarise: (rows, _extra, _ctx, _input, parts) => {
    const n = (kind: DemandGenRow["kind"], part: string) =>
      partOk(parts, part) ? rows.filter((r) => r.kind === kind).length : null;
    return {
      campaigns: n("campaign", "dg_campaigns"),
      assets: n("asset", "dg_assets"),
      audiences: n("audience", "dg_audiences"),
      channelRows: n("channel", "dg_channels"),
      channelControlRows: n("channel_control", "dg_channel_controls"),
    };
  },
  summaryLine: (s, ctx, input) =>
    `Demand Gen on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${s.campaigns === null ? "campaigns unknown" : plural(s.campaigns, "campaign")}, ${s.assets === null ? "assets unknown" : plural(s.assets, "asset link")}.`,
  rowLine: (r) =>
    `${r.kind} ${r.campaignId} ${r.adGroupId ?? ""} ${r.fieldType ?? r.criterionType ?? r.adNetworkType ?? ""}`.trim(),
};
