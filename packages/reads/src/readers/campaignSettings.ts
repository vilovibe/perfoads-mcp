// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot): campaign settings the structure checks need
// that get_campaigns leaves out. New here (PerfoAds read these fields inside fetchCampaigns
// and fetchAdGroups): partner search network, negative geo target type, tracking template,
// final URL suffix, and ad rotation per ad group (counted per campaign).

import * as z from "zod";
import { plural, shown } from "../common.js";
import { bool, enumValue, get, id, text, textOrNull, type Row } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const CampaignSettingsRowSchema = z.object({
  id: z.string(),
  name: UntrustedSchema,
  status: z.string().nullable(),
  channelType: z.string().nullable(),
  networks: z
    .object({
      googleSearch: z.boolean(),
      searchPartners: z.boolean(),
      display: z.boolean(),
      partnerSearch: z.boolean(),
    })
    .nullable()
    .describe("Search and Shopping only; null for other types, where these settings do not apply"),
  positiveGeoTargetType: z.string().nullable(),
  negativeGeoTargetType: z.string().nullable(),
  trackingUrlTemplate: UntrustedSchema.nullable(),
  finalUrlSuffix: UntrustedSchema.nullable(),
  adRotation: z
    .record(z.string(), z.number())
    .nullable()
    .describe("Ad groups per rotation mode; null = not read"),
});
export type CampaignSettingsRow = z.infer<typeof CampaignSettingsRowSchema>;

export const CampaignSettingsSummarySchema = z.object({
  campaigns: z.number().nullable().describe("null = not read (every count below too)"),
  onSearchPartners: z.number().nullable(),
  onDisplay: z.number().nullable(),
  presenceOrInterest: z.number().nullable().describe("Positive geo type PRESENCE_OR_INTEREST"),
});
export type CampaignSettingsSummary = z.infer<typeof CampaignSettingsSummarySchema>;

export const CAMPAIGN_SETTINGS_QUERY = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.network_settings.target_google_search,
      campaign.network_settings.target_search_network,
      campaign.network_settings.target_content_network,
      campaign.network_settings.target_partner_search_network,
      campaign.geo_target_type_setting.positive_geo_target_type,
      campaign.geo_target_type_setting.negative_geo_target_type,
      campaign.tracking_url_template,
      campaign.final_url_suffix
    FROM campaign
    WHERE campaign.status != 'REMOVED'
    ORDER BY campaign.id`;

export const AD_ROTATION_QUERY = `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group.ad_rotation_mode
    FROM ad_group
    WHERE ad_group.status != 'REMOVED'
      AND campaign.status != 'REMOVED'
    ORDER BY ad_group.id`;

const mapRow = (row: Row, rotation: ReadonlyMap<string, Record<string, number>> | null) => {
  const c = (path: string) => get(row, `campaign.${path}`);
  const campaignId = id(c("id"));
  if (!campaignId) return null;
  const googleSearch = c("networkSettings.targetGoogleSearch");
  const channelType = enumValue(c("advertisingChannelType"));
  return {
    id: campaignId,
    name: text(c("name")),
    status: enumValue(c("status")),
    channelType,
    // as get_campaigns: Google returns network flags for every type, but they only steer
    // Search and Shopping
    networks:
      channelType === "SEARCH" || channelType === "SHOPPING"
        ? {
            googleSearch: googleSearch === undefined ? true : bool(googleSearch),
            searchPartners: bool(c("networkSettings.targetSearchNetwork")),
            display: bool(c("networkSettings.targetContentNetwork")),
            partnerSearch: bool(c("networkSettings.targetPartnerSearchNetwork")),
          }
        : null,
    positiveGeoTargetType: enumValue(c("geoTargetTypeSetting.positiveGeoTargetType")),
    negativeGeoTargetType: enumValue(c("geoTargetTypeSetting.negativeGeoTargetType")),
    trackingUrlTemplate: textOrNull(c("trackingUrlTemplate")),
    finalUrlSuffix: textOrNull(c("finalUrlSuffix")),
    adRotation: rotation === null ? null : (rotation.get(campaignId) ?? {}),
  };
};

export const campaignSettingsReader: ReaderDef<
  null,
  CampaignSettingsRow,
  CampaignSettingsSummary,
  null
> = {
  name: "campaign_settings",
  queries: () => ({
    campaigns: { gaql: CAMPAIGN_SETTINGS_QUERY },
    ad_rotation: { gaql: AD_ROTATION_QUERY },
  }),
  map: (data, _input, _ctx, parts) => {
    let rotation: Map<string, Record<string, number>> | null = null;
    if (partOk(parts, "ad_rotation")) {
      rotation = new Map();
      for (const row of data.ad_rotation ?? []) {
        const campaignId = id(get(row, "campaign.id"));
        const mode = enumValue(get(row, "adGroup.adRotationMode")) ?? "UNKNOWN";
        if (!campaignId) continue;
        const counts = rotation.get(campaignId) ?? {};
        counts[mode] = (counts[mode] ?? 0) + 1;
        rotation.set(campaignId, counts);
      }
    }
    return {
      rows: (data.campaigns ?? [])
        .map((r) => mapRow(r, rotation))
        .filter((r): r is CampaignSettingsRow => r !== null),
      extra: null,
    };
  },
  compare: (a, b) => a.id.localeCompare(b.id),
  summarise: (rows, _extra, _ctx, _input, parts) => {
    const ok = partOk(parts, "campaigns");
    const n = (f: (r: CampaignSettingsRow) => boolean) => (ok ? rows.filter(f).length : null);
    return {
      campaigns: ok ? rows.length : null,
      onSearchPartners: n((r) => r.networks?.searchPartners === true),
      onDisplay: n((r) => r.networks?.display === true),
      presenceOrInterest: n((r) => r.positiveGeoTargetType === "PRESENCE_OR_INTEREST"),
    };
  },
  summaryLine: (s, ctx) =>
    s.campaigns === null
      ? `Campaign settings on ${ctx.customerId}: unknown (not read).`
      : `${plural(s.campaigns, "campaign")} on ${ctx.customerId}: ${s.onSearchPartners} on search partners, ${s.onDisplay} on Display, ${s.presenceOrInterest} with "presence or interest" locations.`,
  rowLine: (r) =>
    `${shown(r.name)} id ${r.id}, ${r.channelType ?? "?"}, geo ${r.positiveGeoTargetType ?? "?"}`,
};
