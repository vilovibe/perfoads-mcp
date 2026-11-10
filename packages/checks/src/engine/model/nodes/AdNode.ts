// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";
import type { AssetNode } from "./AssetNode.js";
import type { LandingPageNode } from "./LandingPageNode.js";

export interface AdAttrs {
  type: string | null;
  /** ads.status. null = the sync stored none, which is UNKNOWN — never read as ENABLED (A1, rules 383, 392). */
  status: string | null;
  headlineCount: number;
  /** M18 (SK42): the headline texts, in order. Optional: a hand-built model may omit it. */
  headlineTexts?: string[] | undefined;
  descriptionCount: number;
  /** null when the headlines JSON carries no pinnedField key at all (pinning not stored). */
  pinnedCount: number | null;
  finalUrls: string[];
  /** ad_policy row for this ad (join ad_id, both cast to text) — null when no row. */
  policy: {
    approvalStatus: string | null;
    reviewStatus: string | null;
    policyTopics: unknown[];
  } | null;
}

export interface AdNode extends BaseNode<"ad"> {
  attrs: AdAttrs;
  children: {
    /** asset_performance rows whose ad_resource ends with '~<ad_id>'. */
    assets: AssetNode[];
    /** landing_page_views rows whose host+path equals a final URL's host+path (query ignored). SAME node objects as AccountNode.children.landingPages. */
    landingPages: LandingPageNode[];
  };
}
