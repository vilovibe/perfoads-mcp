// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export type NegativeLevel = "campaign" | "shared_list" | "account";

export interface NegativeEntry {
  criterionId: string | null;
  text: string;
  matchType: string | null;
}

export interface NegativeListAttrs {
  level: NegativeLevel;
  /** shared_set_id for shared lists; campaign id for campaign level; 'account' otherwise. */
  listId: string | null;
  memberCount: number;
  /** campaign ids the list is attached to (shared lists) or applies to (campaign / account). */
  campaignIds: string[];
  /** list seen in account_negatives but absent from shared_negative_lists → attachment unknown → applied to ALL campaigns. */
  attachmentUnknown: boolean;
  /** 'sharedNegativeLists' | 'accountNegatives' | 'campaign_negatives' | 'account_negative_criteria' */
  source: string;
  /** non-keyword account criteria (content labels, placements) carried here. */
  criterionType: string | null;
}

/** Members are NOT on the node — see AccountNode.negativeIndex. */
export interface NegativeListNode extends BaseNode<"negativeList"> {
  attrs: NegativeListAttrs;
}
