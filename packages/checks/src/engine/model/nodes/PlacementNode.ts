// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export interface PlacementAttrs {
  campaignId: string;
  placementType: string | null;
  displayName: string | null;
  targetUrl: string | null;
  /** cost >= 10 and zero conversions. */
  junk: boolean;
}

export interface PlacementNode extends BaseNode<"placement"> {
  attrs: PlacementAttrs;
}
