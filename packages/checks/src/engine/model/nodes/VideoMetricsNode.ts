// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

/** One campaign's view numbers: Demand Gen (dg_video_metrics) or Video (video_campaign_metrics). */
export interface VideoMetricsAttrs {
  videoViews: number | null;
  viewRate: number | null;
  avgCpv: number | null;
  q25: number | null;
  q50: number | null;
  q75: number | null;
  q100: number | null;
  /** 0 views while any quartile rate > 0 (DG07). */
  internallyInconsistent: boolean;
}

export interface VideoMetricsNode extends BaseNode<"videoMetrics"> {
  attrs: VideoMetricsAttrs;
}
