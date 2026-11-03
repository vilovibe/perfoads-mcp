// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export type AssetSurface = "rsa" | "pmax" | "demand_gen" | "video";

export interface AssetAttrs {
  surface: AssetSurface;
  fieldType: string | null;
  performanceLabel: string | null;
  /** PMax: label from the asset_performance row joined on asset_id (null = no row). */
  assetPerformanceLabel: string | null;
  text: string | null;
  assetResource: string | null;
  /** PMax: primary_status, image dims, video title. */
  primaryStatus: string | null;
  primaryStatusDetails: unknown;
  assetType: string | null;
  imageUrl: string | null;
  imageWidthPx: number | null;
  imageHeightPx: number | null;
  imageAspectRatio: number | null;
  mimeType: string | null;
  videoTitle: string | null;
  assetSource: string | null;
  /** PMax: asset_group_asset.status (the LINK: ENABLED / PAUSED / REMOVED); undefined on other surfaces. */
  linkStatus?: string | null | undefined;
  /** Round 4 item 9 — Demand Gen: the ad this asset serves in (e.g. DEMAND_GEN_VIDEO_RESPONSIVE_AD); undefined elsewhere. */
  adType?: string | null | undefined;
  /** DG_COLD_COPY_PLAN phase 6 — Demand Gen: the asset id (images; text lines have none). */
  dgAssetId?: string | null | undefined;
  /**
   * Phase 6 — Demand Gen: Google's numbers for this line in this ad over the window
   * (ad_group_ad_asset_view). null = not synced (older audit / columns missing);
   * a field null = Google gave no row for the line.
   */
  dgStats?:
    | {
        impressions: number | null;
        clicks: number | null;
        conversions: number | null;
        conversionsValue: number | null;
      }
    | null
    | undefined;
  /** DG_VIDEO_FRAMEWORK_PLAN phase 2 — Demand Gen VIDEO lines: the ad it serves in, the YouTube id, length and shape (null = not read). */
  dgAdId?: string | null | undefined;
  youtubeVideoId?: string | null | undefined;
  videoSeconds?: number | null | undefined;
  videoShape?: string | null | undefined;
}

export interface AssetNode extends BaseNode<"asset"> {
  attrs: AssetAttrs;
}
