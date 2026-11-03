// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export type BlockedState = "blocked" | "not_blocked" | "unknown";

export interface SearchTermAttrs {
  term: string;
  status: string | null;
  /** match type reported on the search term row. */
  matchType: string | null;
  campaignId: string;
  adGroupId: string | null;
  /** search_terms.keyword_criterion_id — nullable; Phase 1b adds the column to the sync. */
  matchedKeywordId: string | null;
  /** 'criterion_id' when the row carried keyword_criterion_id; 'unresolved' until synced (OPEN QUESTION 2). */
  matchSource: "criterion_id" | "unresolved";
  /** HINT only: a keyword in the same ad group with the same text + match type. Not a join. */
  textMatchCandidateKeywordId: string | null;
  /** blocked at each level, with the list / campaign ids that block it. */
  blocked: {
    campaign: BlockedState;
    sharedList: BlockedState;
    account: BlockedState;
    by: string[];
  };
  isDsa: boolean;
  /** 'searchTerms' | 'dsaSearchTerms' | 'productSearchTerms' (Shopping campaign-grain rows, Phase 1b) | 'pmaxSearchTerms' (PMax campaign_search_term_view, with cost). */
  source: string;
}

export interface SearchTermNode extends BaseNode<"searchTerm"> {
  attrs: SearchTermAttrs;
}
