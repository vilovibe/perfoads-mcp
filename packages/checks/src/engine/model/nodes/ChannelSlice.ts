// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export type ChannelClassification = "shopping" | "video_display" | "unclassified";

export interface ChannelSliceAttrs {
  adNetworkType: string;
  /** SEARCH / SEARCH_PARTNERS = shopping; CONTENT / YOUTUBE = video_display; GMAIL / DISCOVER / MIXED = unclassified (build sheet §0). */
  classification: ChannelClassification;
  /** 'pmaxChannelDistribution' | 'pmaxChannelData' | 'dg_channel_distribution' */
  source: string;
}

export interface ChannelSlice extends BaseNode<"channelSlice"> {
  attrs: ChannelSliceAttrs;
}
