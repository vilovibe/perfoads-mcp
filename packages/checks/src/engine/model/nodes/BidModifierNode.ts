// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";
import type { SliceDimension } from "./Slice.js";

export interface BidModifierAttrs {
  campaignId: string;
  criterionId: string | null;
  modifier: number | null;
  modifierSource: string | null;
  interactionType: string | null;
  /**
   * the slice this modifier multiplies, from modifier_source + criterion_key
   * (unresolved on rows synced before Step 5B). `noSlice` = resolved, but it
   * multiplies no traffic slice (call interaction modifier) — never a data gap.
   * `cells` (dowHour only) = the grid cells an ad schedule covers; `key` is
   * the schedule itself ("MONDAY 09:00-17:00").
   */
  measuredSlice:
    | { kind: "unresolved"; reason: string; noSlice?: boolean }
    | { kind: SliceDimension; key: string; cells?: string[] };
  /** the campaign is not one of the audited campaigns. */
  orphan: boolean;
}

export interface BidModifierNode extends BaseNode<"bidModifier"> {
  attrs: BidModifierAttrs;
}
