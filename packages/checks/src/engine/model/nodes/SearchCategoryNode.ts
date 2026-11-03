// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

/** PMax search insight category (pmax_search_insights). Capped 50 / campaign → always a sample. */
export interface SearchCategoryAttrs {
  campaignId: string;
  label: string;
  brandToken: boolean;
  /** the label equals a search term text anywhere in the account. */
  overlapsSearchTerm: boolean;
  /** the label equals a keyword text anywhere in the account. */
  overlapsKeyword: boolean;
}

export interface SearchCategoryNode extends BaseNode<"searchCategory"> {
  attrs: SearchCategoryAttrs;
}
