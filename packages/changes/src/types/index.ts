// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { ActionType } from "./actionType.js";
import { addCallouts, addSitelinks } from "./assets.js";
import { addAudienceExclusions } from "./audienceExclusions.js";
import { addCampaignNegatives, removeCampaignNegatives } from "./campaignNegatives.js";
import { createCampaign } from "./createCampaign.js";
import { addKeywords, pauseKeyword } from "./keywords.js";
import { addSharedNegatives } from "./sharedNegatives.js";
import { updateBidding } from "./updateBidding.js";
import { updateBudget } from "./updateBudget.js";
import { updateCampaignStatus } from "./updateCampaignStatus.js";
import { tagExclude } from "./tagExclude.js";
import { updateRsaText } from "./updateRsaText.js";

/** The change types this version can make (plan 3.4, types 1-10, + create_campaign, tag_exclude). */
export const V1_ACTION_TYPES: readonly ActionType<unknown>[] = [
  updateBudget,
  updateCampaignStatus,
  updateBidding,
  addCampaignNegatives,
  removeCampaignNegatives,
  addSharedNegatives,
  addKeywords,
  pauseKeyword,
  updateRsaText,
  addSitelinks,
  addCallouts,
  addAudienceExclusions,
  createCampaign,
  tagExclude,
] as readonly ActionType<unknown>[];

export {
  addAudienceExclusions,
  addCallouts,
  addCampaignNegatives,
  addKeywords,
  addSharedNegatives,
  addSitelinks,
  createCampaign,
  pauseKeyword,
  removeCampaignNegatives,
  tagExclude,
  updateBidding,
  updateBudget,
  updateCampaignStatus,
  updateRsaText,
};
export {
  SAFE_DEFAULTS,
  touchedMatch,
  type ActionType,
  type ModelText,
  type Planned,
  type PolicyDefaults,
  type ReadCtx,
  type ReadTarget,
  type Touched,
  type UndoLevel,
  type UndoSupport,
} from "./actionType.js";
