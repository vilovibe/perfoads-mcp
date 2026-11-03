// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Demand Gen subtree. The dg_* tables are NOT part of AccountData —
 * the DG tool executors read them through the pool. The model accepts them
 * through `dbTables` (keys 'dg_campaign_settings', 'dg_assets',
 * 'dg_audience_signals', 'dg_channel_distribution',
 * 'dg_video_metrics', 'dg_ad_video_daily'); when a table is absent the child is null and
 * the campaign carries a notCheckable entry — never "no assets". Checkability
 * comes from the sync marker (ctx.gate), never from rows.length: marker
 * 'skipped' (DG_NO_CAMPAIGNS_MESSAGE) or 'error' → null + the message.
 * Audience signals (Phase 1b columns): only `negative = false` rows attach,
 * deduped by (ad_group_id, criterion_id); node id carries the ad group so two
 * ad groups sharing a criterion never collide.
 * These tables are optional named tables; an absent key means not read.
 */
import {
  arr,
  bool,
  nc,
  nodeFromRows,
  resourceId,
  setShare,
  str,
  type BuildCtx,
} from "./context.js";
import { num } from "./metrics.js";
import { classifyChannel } from "./buildPmaxTree.js";
import type { AssetNode } from "./nodes/AssetNode.js";
import { userListIdsIn, type AudienceSignalNode } from "./nodes/AudienceSignalNode.js";
import type { CampaignNode, DgAdVideoDaily } from "./nodes/CampaignNode.js";
import type { ChannelSlice } from "./nodes/ChannelSlice.js";
import type { PlacementNode } from "./nodes/PlacementNode.js";
import type { VideoMetricsNode } from "./nodes/VideoMetricsNode.js";

export const DG_TABLES = [
  "dg_campaign_settings",
  "dg_assets",
  "dg_audience_signals",
  "dg_channel_distribution",
  "dg_channel_controls",
  "dg_video_metrics",
  "dg_ad_video_daily",
] as const;

/** B12: a channel-control surface -> the ad network its spend is reported under. */
const DG_SURFACE_NETWORK: Readonly<Record<string, string>> = {
  discover: "DISCOVER",
  youtubeInFeed: "YOUTUBE",
  youtubeInStream: "YOUTUBE",
  youtubeShorts: "YOUTUBE",
  gmail: "GMAIL",
  display: "CONTENT",
};
const OWNED_AND_OPERATED = ["DISCOVER", "GMAIL", "YOUTUBE"];

/**
 * B12: the networks one ad group's channel controls allow; null = every surface (all
 * channels, or no control set). A chosen set names only the surfaces switched on.
 */
function allowedNetworksOf(r: any): string[] | null {
  const config = String(r.channel_config ?? "").toUpperCase();
  if (config === "SELECTED_CHANNELS")
    return [
      ...new Set(
        arr(r.selected_channels)
          .map((c) => DG_SURFACE_NETWORK[String(c)])
          .filter((n): n is string => n != null),
      ),
    ].sort();
  if (
    config === "CHANNEL_STRATEGY" &&
    String(r.channel_strategy ?? "").toUpperCase() === "ALL_OWNED_AND_OPERATED_CHANNELS"
  )
    return [...OWNED_AND_OPERATED];
  return null;
}

/** The union over the campaign's live ad groups (all of them when none is live). */
export function campaignAllowedNetworks(
  rows: readonly any[] | null,
): { allowedNetworks: string[] | null; adGroups: number } | null {
  if (rows == null || rows.length === 0) return null;
  const live = rows.filter((r) => String(r.ad_group_status ?? "").toUpperCase() === "ENABLED");
  const judged = live.length > 0 ? live : rows;
  const sets = judged.map(allowedNetworksOf);
  return {
    allowedNetworks: sets.some((x) => x == null)
      ? null
      : [...new Set(sets.flatMap((x) => x ?? []))].sort(),
    adGroups: judged.length,
  };
}

export function buildDemandGenChildren(
  ctx: BuildCtx,
  campaign: CampaignNode,
  placementsByCampaign: Map<string, PlacementNode[]>,
): void {
  const cid = campaign.id;
  const byCid = (rows: any[] | null) =>
    rows
      ? rows.filter((r) => String(r.campaign_id ?? resourceId(r.campaign_resource) ?? "") === cid)
      : null;
  const load = (table: string, checkId: string) => {
    const g = ctx.gate(table, ctx.readDb(table));
    if (g.note) campaign.notCheckable.push(nc(checkId, g.note));
    return byCid(g.rows);
  };
  const settings = load("dg_campaign_settings", "DG01");
  const assets = load("dg_assets", "DG02");
  const signalsAll = load("dg_audience_signals", "DG03");
  const channels = load("dg_channel_distribution", "DG04");
  const controls = load("dg_channel_controls", "DG04");
  const video = load("dg_video_metrics", "DG05");
  const adVideo = load("dg_ad_video_daily", "DG23");

  const s = settings?.[0];
  const negativeCount = signalsAll
    ? signalsAll.filter((r) => bool(r.negative) === true).length
    : null;
  // R4-D (AS18): which lists each ad group EXCLUDES, and every ad group the criterion rows name
  const negativeUserLists = signalsAll
    ? signalsAll
        .filter(
          (r) =>
            bool(r.negative) === true &&
            String(r.criterion_type ?? "").toUpperCase() === "USER_LIST",
        )
        .map((r) => ({
          adGroupId: str(r.ad_group_id),
          listId: str(r.user_list_id),
          name: str(r.user_list_name),
          customerMatch: bool(r.is_customer_match) === true,
        }))
    : null;
  const adGroupIdsSeen = signalsAll
    ? [...new Set(signalsAll.map((r) => str(r.ad_group_id)).filter((x): x is string => !!x))]
    : null;
  // Round 2 Y7: an AUDIENCE criterion's lists come from its synced audience definition
  const audienceRows = new Map(
    ctx
      .read("audiences")
      .map((a: any) => [String(a.audience_id ?? resourceId(a.resource_name) ?? ""), a] as const),
  );
  // review: a new-style ad group (one Audience) excludes lists INSIDE the Audience
  // (audience.exclusion_dimension -> audiences.exclusion_json). Those join the
  // ad group's excluded lists; an ad group whose Audience exclusions were not read is named
  // in audienceExclusionsUnread, so AS18 / DG09 say "could not see", never "none excluded".
  const listNames = new Map(
    ctx.read("audienceLists").map((l: any) => [String(l.list_id ?? ""), str(l.list_name)] as const),
  );
  const audienceExclusionsUnread = new Set<string>();
  if (negativeUserLists && signalsAll) {
    for (const r of signalsAll) {
      if (bool(r.negative) === true || String(r.criterion_type ?? "").toUpperCase() !== "AUDIENCE")
        continue;
      const agId = str(r.ad_group_id) ?? cid;
      const row = audienceRows.get(resourceId(str(r.custom_audience_resource) ?? "") ?? "");
      const ids = row ? userListIdsIn(row.exclusion_json) : null;
      if (ids == null) {
        audienceExclusionsUnread.add(agId);
        continue;
      }
      for (const id of ids) {
        if (!negativeUserLists.some((x) => x.adGroupId === agId && x.listId === id))
          negativeUserLists.push({
            adGroupId: agId,
            listId: id,
            name: listNames.get(id) ?? null,
            customerMatch: false,
          });
      }
    }
  }
  campaign.attrs.demandGen =
    settings == null
      ? { state: "not_synced" }
      : {
          state: "synced",
          optimizationGoals: s ? arr(s.optimization_goal_types).map(String) : [],
          merchantCenterId: str(s?.merchant_center_id),
          productFeedDisabled: bool(s?.product_feed_disabled),
          feedLabel: str(s?.feed_label),
          negativeAudienceCount: negativeCount,
          negativeUserLists,
          adGroupIdsSeen,
          audienceExclusionsUnread: signalsAll ? [...audienceExclusionsUnread] : null,
        };
  if (controls != null) campaign.attrs.dgChannelControls = campaignAllowedNetworks(controls);

  campaign.children.dgAssets =
    assets == null
      ? null
      : assets.map((a): AssetNode => ({
          ...nodeFromRows(
            ctx,
            "asset",
            `${cid}:dg:${a.asset_id}`,
            str(a.asset_text) ?? str(a.youtube_video_title) ?? String(a.asset_id),
            cid,
            [],
            "dg_assets",
          ),
          attrs: {
            surface: "demand_gen",
            fieldType: str(a.field_type),
            performanceLabel: str(a.performance_label),
            assetPerformanceLabel: null,
            text: str(a.asset_text),
            assetResource: null,
            primaryStatus: str(a.status),
            primaryStatusDetails: null,
            assetType: null,
            imageUrl: str(a.asset_image_url),
            imageWidthPx: num(a.image_width_px),
            imageHeightPx: num(a.image_height_px),
            imageAspectRatio: num(a.image_aspect_ratio),
            mimeType: str(a.mime_type),
            videoTitle: str(a.youtube_video_title),
            assetSource: str(a.source),
            adType: str(a.ad_type),
            dgAssetId: str(a.asset_id),
            // Phase 6: absent columns (migration not applied) = no numbers, never zeros.
            dgStats:
              a.impressions === undefined
                ? null
                : {
                    impressions: num(a.impressions),
                    clicks: num(a.clicks),
                    conversions: num(a.conversions),
                    conversionsValue: num(a.conversions_value),
                  },
            // Video framework phase 2: absent columns (migration not applied) = null, never zero.
            dgAdId: str(a.ad_id),
            youtubeVideoId: str(a.youtube_video_id),
            videoSeconds: num(a.video_seconds),
            videoShape: str(a.video_shape),
          },
        }));

  // positive signals only, one node per (ad group, criterion)
  let signals: AudienceSignalNode[] | null = null;
  const listsOf = (r: any): string[] | null => {
    const type = String(r.criterion_type ?? "").toUpperCase();
    if (type === "USER_LIST") return r.user_list_id ? [String(r.user_list_id)] : null;
    if (type === "CUSTOM_AUDIENCE") return [];
    if (type === "AUDIENCE") {
      const row = audienceRows.get(resourceId(str(r.custom_audience_resource) ?? "") ?? "");
      return row ? userListIdsIn(row.dimensions_json) : null;
    }
    return null; // COMBINED_AUDIENCE / unknown: could not tell
  };
  if (signalsAll) {
    const seen = new Set<string>();
    signals = [];
    for (const r of signalsAll) {
      if (bool(r.negative) === true) continue;
      const agId = r.ad_group_id == null ? null : String(r.ad_group_id);
      const crit = String(r.criterion_id ?? r.user_list_id ?? "");
      const key = `${agId ?? "campaign"}:${crit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({
        ...nodeFromRows(
          ctx,
          "audienceSignal",
          `${cid}:dg:${key}`,
          str(r.user_list_name) ?? crit,
          agId ?? cid,
          [],
          "dg_audience_signals",
        ),
        attrs: {
          assetGroupId: null,
          campaignId: cid,
          adGroupId: agId,
          audienceResource: str(r.custom_audience_resource) ?? crit,
          audienceId: str(r.user_list_id),
          audienceName: str(r.user_list_name),
          audienceStatus: str(r.criterion_type),
          approvalStatus: null,
          disapprovalReasons: [],
          userListIds: listsOf(r),
        },
      });
    }
  }
  campaign.children.dgAudienceSignals = signals;

  if (channels) {
    campaign.children.channels = channels.map((r): ChannelSlice => {
      const net = String(r.ad_network_type ?? "UNKNOWN");
      const node: ChannelSlice = {
        ...nodeFromRows(
          ctx,
          "channelSlice",
          `${cid}:${net}`,
          net,
          cid,
          [r],
          "dg_channel_distribution",
        ),
        attrs: {
          adNetworkType: net,
          classification: classifyChannel(net),
          source: "dg_channel_distribution",
        },
      };
      setShare(node, campaign.windows.m90);
      return node;
    });
  }

  campaign.children.videoMetrics =
    video == null ? null : videoMetricsNodes(ctx, cid, video, "dg_video_metrics");

  campaign.children.dgAdVideo =
    adVideo == null
      ? null
      : adVideo
          .map((r): DgAdVideoDaily => ({
            adId: String(r.ad_id ?? ""),
            adGroupId: str(r.ad_group_id),
            date: String(
              r.date instanceof Date
                ? r.date.toISOString().slice(0, 10)
                : String(r.date ?? "").slice(0, 10),
            ),
            adFormat: String(r.ad_format ?? "ALL").toUpperCase(),
            impressions: num(r.impressions),
            clicks: num(r.clicks),
            costMicros: num(r.cost_micros),
            conversions: num(r.conversions),
            videoViews: num(r.video_views),
          }))
          .filter((r) => r.adId !== "");

  campaign.children.placements = placementsByCampaign.get(cid) ?? [];
  campaign.children.productGroups = null;
  campaign.children.assetGroups = [];
}

/**
 * One campaign's view numbers as nodes (Demand Gen: dg_video_metrics; Video campaigns:
 * video_campaign_metrics). The rows carry video_views, video_view_rate, average_cpv and
 * quartile_p25..p100_rate (fractions) beside the usual cost and impressions.
 */
export function videoMetricsNodes(
  ctx: BuildCtx,
  cid: string,
  rows: readonly any[],
  table: string,
): VideoMetricsNode[] {
  return rows.map((v): VideoMetricsNode => {
    const views = num(v.video_views);
    const q = [
      num(v.quartile_p25_rate),
      num(v.quartile_p50_rate),
      num(v.quartile_p75_rate),
      num(v.quartile_p100_rate),
    ];
    return {
      ...nodeFromRows(ctx, "videoMetrics", cid, `video metrics ${cid}`, cid, [v], table, {
        fields: { conv: "__none", value: "__none", clicks: "__none" },
      }),
      attrs: {
        videoViews: views,
        viewRate: num(v.video_view_rate),
        avgCpv: num(v.average_cpv),
        q25: q[0] ?? null,
        q50: q[1] ?? null,
        q75: q[2] ?? null,
        q100: q[3] ?? null,
        internallyInconsistent: views === 0 && q.some((x) => (x ?? 0) > 0),
      },
    };
  });
}
