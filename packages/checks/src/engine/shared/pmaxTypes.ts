// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

export interface UrlExclusionCondition {
  operand: string;
  operator: string;
  argument: string;
}

/** One negative WEBPAGE campaign criterion (a Performance Max URL exclusion). */
export interface UrlExclusion {
  criterionId: string | null;
  name: string | null;
  conditions: UrlExclusionCondition[];
}
