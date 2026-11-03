// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";
import type { AdNode } from "./AdNode.js";
import type { ImpressionShareAttrs } from "./CampaignNode.js";
import type { ExtensionNode } from "./ExtensionNode.js";
import type { KeywordNode } from "./KeywordNode.js";
import type { ProductGroupNode } from "./ProductGroupNode.js";
import type { SearchTermNode } from "./SearchTermNode.js";
import type { Slice } from "./Slice.js";

export interface AdGroupAttrs {
  campaignId: string;
  impressionShare: ImpressionShareAttrs;
  adsCount: number;
  rsaCount: number;
  keywordCount: number;
  negativeKeywordCount: number;
}

export interface AdGroupNode extends BaseNode<"adGroup"> {
  attrs: AdGroupAttrs;
  children: {
    keywords: KeywordNode[];
    searchTerms: SearchTermNode[];
    ads: AdNode[];
    /** level=AD_GROUP extension rows. */
    extensions: ExtensionNode[];
    /** demographic_data carries ad_group_id — the only ad-group-level slice synced; audience perf has no ad_group_id. */
    audiences: Slice[];
    /** Shopping partitions — NOT SYNCED (no table); null, never []. */
    productGroups: ProductGroupNode[] | null;
  };
}
