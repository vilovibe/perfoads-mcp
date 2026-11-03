// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export type SliceDimension =
  "device" | "geo" | "hour" | "dow" | "dowHour" | "audience" | "demographic";

export interface SliceAttrs {
  dimension: SliceDimension;
  scope: "account" | "campaign" | "adGroup";
  campaignId: string | null;
  adGroupId: string | null;
  /** the slice value: device name, location id, hour, day, criterion id, demographic value. */
  key: string;
  /** dow / hour rows are MARGINALS of the same spend — never sum across families (G.6). */
  marginal: boolean;
  /** bid modifier on this slice when one could be resolved. */
  bidModifier: number | null;
  extra: Record<string, unknown>;
}

export interface Slice extends BaseNode<"slice"> {
  attrs: SliceAttrs;
}

export interface SliceFamilies {
  device: Slice[];
  geo: Slice[];
  hour: Slice[];
  dow: Slice[];
  /** [] + notCheckable when temporal_grid is empty (G.6). */
  dowHour: Slice[];
  audience: Slice[];
  demographic: Slice[];
}

/**
 * A finding's scope may name a SET of slice keys, joined by this separator:
 * SL06 judges a campaign's zero-conversion device slices as ONE exclusion
 * decision, so its scope key is `CONNECTED_TV+TABLET`. A single key is a set of
 * one, and everything that reads a slice scope treats it that way.
 */
export const SLICE_KEY_SEPARATOR = "+";

/** The keys a slice scope names. `null`/empty → []. */
export function sliceKeysOf(key: string | null | undefined): string[] {
  return key == null
    ? []
    : String(key)
        .split(SLICE_KEY_SEPARATOR)
        .map((k) => k.trim())
        .filter(Boolean);
}
