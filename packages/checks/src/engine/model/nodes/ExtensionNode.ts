// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export type ExtensionLevel = "ACCOUNT" | "CAMPAIGN" | "AD_GROUP";
/** served_despite_rule = impressions > 0 on a type Google says never serves on this campaign type — recorded in dataQuality.contradictions, never hidden. */
export type ServedStatus =
  | "served"
  | "served_despite_rule"
  | "overridden"
  | "not_served_by_type"
  | "eligible_no_impressions";
/** UNKNOWN = a type whose level rule is not documented (IMAGE, LOCATION, LEAD_FORM, …) — never assumed either way. */
export type OverrideClass = "OVERRIDE" | "CUMULATIVE" | "UNKNOWN";

export interface ExtensionAttrs {
  type: string;
  level: ExtensionLevel;
  campaignId: string | null;
  adGroupId: string | null;
  text: string | null;
  description1: string | null;
  description2: string | null;
  finalUrls: string[];
  snippetHeader: string | null;
  snippetValues: unknown;
  metadata: Record<string, unknown> | null;
  /**
   * PROMOTION: metadata.percentOff is a PERCENT (10 = 10% off, 100 = free shipping) — the sync stores
   * `percent_off / 10_000` since `ea84d1ec`. Snapshots saved before that commit held FRACTIONS (0.1, 1);
   * `loadAuditSnapshot.ts` migrates them on load, so this attr is one scale everywhere.
   */
  promoPercentOff: number | null;
  promoEndDate: string | null;
  linkCount: number | null;
  /** EXTENSION_SERVING table in buildSearchTree.ts (build sheet §C). */
  overrideClass: OverrideClass;
  servedStatus: ServedStatus;
  /** campaign-level OVERRIDE asset: ad groups of the campaign whose own same-type assets hide it … */
  overriddenInAdGroupIds: string[];
  /** … and the ad groups where it still serves. servedStatus = 'overridden' only when servingInAdGroupIds is empty. */
  servingInAdGroupIds: string[];
  /**
   * B3 / rule 245: Google's POLICY approval for the asset, which is NOT the
   * `status` column — that one is the LINK state (ENABLED / PAUSED / REMOVED)
   * and says nothing about whether the extension is allowed to serve.
   *
   * Synced (`approval_status`, from `policy_summary.approval_status`
   * on the link resource, falling back to the asset's). `null` on audits synced
   * before that, and on any row whose select variant Google rejected — SK26
   * reports those as "we could not check this", never as approved.
   */
  approvalStatus: string | null;
  /** the campaign this row names is not one of the audited campaigns (removed / zero-spend). */
  orphan: boolean;
}

export interface ExtensionNode extends BaseNode<"extension"> {
  attrs: ExtensionAttrs;
}
