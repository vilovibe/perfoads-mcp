// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export interface BudgetAttrs {
  amount: number | null;
  status: string | null;
  deliveryMethod: string | null;
  period: string | null;
  type: string | null;
  /** row.shared, OR reference_count > 1, OR more than one audited campaign names this budget_id. */
  shared: boolean;
  referenceCount: number | null;
  siblingCampaignIds: string[];
}

export interface BudgetNode extends BaseNode<"budget"> {
  attrs: BudgetAttrs;
}
