// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";
import type { ImpressionShareAttrs } from "./CampaignNode.js";

export interface KeywordAttrs {
  /**
   * Google's criterion id alone. Google reuses one criterion id across ad groups, so the
   * node id is `${adGroupId}~${criterionId}` (Google's own adGroupCriteria key).
   */
  criterionId: string;
  text: string;
  matchType: string | null;
  /** keywords.status. null = the sync stored none, which is UNKNOWN — never read as ENABLED (A1, rule 383). */
  status: string | null;
  isNegative: boolean;
  qs: number | null;
  qsComponents: {
    expectedCtr: string | null;
    adRelevance: string | null;
    landingPageExperience: string | null;
  };
  cpc: number | null;
  firstPageCpc: number | null;
  firstPositionCpc: number | null;
  topOfPageCpc: number | null;
  impressionShare: ImpressionShareAttrs;
  /** lowercase text + match type — duplicates across ad groups share a key. */
  duplicateKey: string;
  /** keyword node ids elsewhere (other ad groups / campaigns) with the same duplicateKey. */
  cannibalisedBy: string[];
}

export interface KeywordNode extends BaseNode<"keyword"> {
  attrs: KeywordAttrs;
  /** back-refs: search term node ids whose keyword (ad group + keyword_criterion_id) resolved to this keyword. */
  children: { triggeredTerms: string[] };
}
