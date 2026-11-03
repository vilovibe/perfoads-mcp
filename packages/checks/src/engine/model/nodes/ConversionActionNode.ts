// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export interface ConversionActionAttrs {
  actionId: string;
  category: string | null;
  /** WEBSITE, YOUTUBE_HOSTED, ... With category it names the goal a campaign bids on. null = not read. */
  origin: string | null;
  type: string | null;
  /** can be null — reported as unknown, never ENABLED. */
  status: string | null;
  isPrimary: boolean;
  /** include_in_conversions_metric: false = the action is outside the Conversions column; null = not read. */
  includeInConversions: boolean | null;
  attributionModel: string | null;
  countingType: string | null;
  lookbackDays: number | null;
  viewThroughDays: number | null;
  defaultValue: number | null;
  alwaysUseDefaultValue: boolean | null;
  totalConversions: number | null;
  totalValue: number | null;
  /** from the action row's campaign_breakdown JSON. */
  perCampaign: { campaignId: string; conv: number | null; value: number | null }[];
  /** from campaignConversions rows joined on conversion_action_name. */
  perCampaignFromConversionsTable: {
    campaignId: string;
    conv: number | null;
    value: number | null;
  }[];
  hasAnyData: boolean;
  /**
   * Per-day conversions of this action from `conversion_action_daily`,
   * summed over campaigns and owner accounts, ascending by date. null when the
   * table was not loaded (absent = query failed / snapshot predates it) — a
   * table that loaded with no row for this action is an EMPTY list.
   */
  /** `all` = all_conversions that day (null when the row did not carry it). */
  daily: { date: string; conv: number; value: number | null; all?: number | null }[] | null;
}

/** windows.m90 carries total_conversions / total_value; the daily sub-windows stay null — the per-day series lives in attrs.daily. */
export interface ConversionActionNode extends BaseNode<"conversionAction"> {
  attrs: ConversionActionAttrs;
}
