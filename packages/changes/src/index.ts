// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

export {
  ABANDON_AFTER_MS,
  APPLY_DEADLINE_MS,
  APPROVAL_VIAS,
  ITEM_LOCK_MS,
  SEND_RESERVE_MS,
  createChangeEngine,
  NOT_TEST_ACCOUNT_MESSAGE,
  POLICY_AUTO_VIA,
  POLICY_WINDOW_MS,
  PROPOSAL_TTL_MS,
  READ_BACK_DELAYS_MS,
  STALE_APPLYING_MS,
  toView,
  UNDO_WINDOW_MS,
  type Actor,
  type ApprovalVia,
  type ChangeEngine,
  type ChangeView,
  type EngineOptions,
  type ProposeRequest,
  type ResolveOutcome,
} from "./engine.js";
export { localDateTime } from "./time.js";
export { ChangeError, type ChangeErrorCode } from "./errors.js";
export type {
  AccountFacts,
  AffectedEntity,
  ChangeFacts,
  EngineAds,
  EngineMerchant,
  Target,
} from "./facts.js";
export {
  READ_ONLY_POLICY,
  type PolicyCheck,
  type PolicyDecision,
  type PolicyRequest,
  type RecentWrite,
  type RiskTier,
} from "./policy.js";
export {
  CHANGE_STATUSES,
  CHANGE_TRANSITIONS,
  LANDED_STATUSES,
  canMove,
  isChangeStatus,
  type ChangeStatus,
} from "./states.js";
export {
  appendEvent,
  containsHead,
  exportHead,
  GENESIS_HASH,
  listEvents,
  listRecentEvents,
  verifyChain,
  type AuditEvent,
  type AuditEventInput,
  type ChainCheck,
  type LogHead,
} from "./log.js";
export { canonicalJson, sha256Hex } from "./canonical.js";
export { diffHashOf } from "./repo.js";
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
  SAFE_DEFAULTS,
  tagExclude,
  V1_ACTION_TYPES,
  touchedMatch,
  updateBidding,
  updateBudget,
  updateCampaignStatus,
  updateRsaText,
  type ActionType,
  type ModelText,
  type Planned,
  type PolicyDefaults,
  type ReadCtx,
  type ReadTarget,
  type Touched,
  type UndoLevel,
  type UndoSupport,
} from "./types/index.js";
export { SMART_BIDDING } from "./types/keywords.js";
export { VALUE_BIDDING_MIN_CONV_30D } from "./types/updateBidding.js";
export {
  brandMatcher,
  brandTermMatchable,
  checkNegatives,
  negativeBlocks,
  type NegativeCandidate,
  type NegativeMatchType,
  type SafetyResult,
  type SafetySources,
} from "./negatives/safety.js";
export { SAFETY_WINDOW_DAYS } from "./negatives/sources.js";
export {
  DEFAULT_RETENTION_DAYS,
  FINAL_STATUSES,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  pruneOldRecords,
  type PruneCounts,
  type PruneResult,
} from "./retention.js";
