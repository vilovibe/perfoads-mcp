// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";
import type { AssetNode } from "./AssetNode.js";
import type { AudienceSignalNode } from "./AudienceSignalNode.js";
import type { ListingGroupNode } from "./ListingGroupNode.js";
import type { SearchThemeNode } from "./SearchThemeNode.js";

/**
 * D11: an asset group's asset
 * state is KNOWN only when at least one `pmaxAssets` row was synced for it.
 * Zero rows is not "feed-only" and not "0 headlines" — it is unknown, because
 * "feed-only by design" and "not fetched" are the same zero in the data.
 *
 * The earlier rule ("assets are fetched only for ENABLED campaigns") stopped
 * being true when a sync change dropped that GAQL filter; and an ENABLED group
 * can have zero rows, so status could never have proved "feed-only" anyway. Every reader of `isFeedOnly` / asset
 * counts / signals must treat `assetsKnown === false` as `not_checkable`.
 */
export const ASSETS_UNKNOWN_REASON =
  "no asset rows were synced for this asset group — 'feed-only by design' and 'not fetched' cannot be told apart from the data";

export function assetsUnknownReason(): string {
  return ASSETS_UNKNOWN_REASON;
}

/**
 * B2: the same rule applied to the SIGNALS table on its own. The signals fetch
 * is one query over a campaign's groups, so ≥1 `pmaxSignals` row on THIS group
 * or on a SIBLING group proves the fetch covered the campaign — "0 search
 * themes" beside 1 audience signal is a real reading, and so is a bare group
 * beside signalled siblings. A campaign with zero signal rows on every group is
 * unknown: "no signals" and "not fetched" are the same zero.
 */
export const SIGNALS_UNKNOWN_REASON =
  "no signal rows were synced for this asset group — 'no signals' and 'not fetched' cannot be told apart from the data";

export function signalsUnknownReason(): string {
  return SIGNALS_UNKNOWN_REASON;
}

export interface AssetGroupAttrs {
  campaignId: string;
  adStrength: string | null;
  /**
   * D11: true when ≥1 `pmaxAssets` row exists for this group. When false,
   * `assetCounts` is empty because nothing was synced OR nothing exists — the
   * data cannot say which; `isFeedOnly` is null and no check may judge the
   * asset set, the search themes or the audience signals.
   */
  assetsKnown: boolean;
  /** B2: true when ≥1 `pmaxSignals` row exists for this group OR a sibling in its campaign (the fetch covered the campaign). False = signal counts are unknown, never 0. */
  signalsKnown: boolean;
  /** zero text assets (HEADLINE / LONG_HEADLINE / DESCRIPTION) among KNOWN assets — "Feed Only" groups by design. null = assets unknown (D11). */
  isFeedOnly: boolean | null;
  /**
   * ≥1 uploaded image or video (MARKETING_IMAGE / SQUARE_MARKETING_IMAGE /
   * PORTRAIT_MARKETING_IMAGE / YOUTUBE_VIDEO) among KNOWN assets. null = assets
   * unknown (D11). This, not `isFeedOnly`, decides how the group is DESCRIBED to
   * a customer: a group with 8 headlines and no image is `isFeedOnly: false` and
   * still has no "images, videos and text" to talk about.
   */
  hasVisualAssets: boolean | null;
  assetCounts: Record<string, number>;
  imageHealth: unknown;
  listingGroupCounts: { subdivision: number; included: number; excluded: number };
}

export interface AssetGroupNode extends BaseNode<"assetGroup"> {
  attrs: AssetGroupAttrs;
  children: {
    assets: AssetNode[];
    audienceSignals: AudienceSignalNode[];
    searchThemes: SearchThemeNode[];
    /** roots of the partition tree (parent_listing_group_id empty). */
    listingGroups: ListingGroupNode[];
  };
}
