// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export interface SearchThemeAttrs {
  assetGroupId: string;
  text: string;
  approvalStatus: string | null;
  disapprovalReasons: unknown[];
  /** theme contains a brand token (questionnaire business name words). */
  brandOverlap: boolean;
}

export interface SearchThemeNode extends BaseNode<"searchTheme"> {
  attrs: SearchThemeAttrs;
}
