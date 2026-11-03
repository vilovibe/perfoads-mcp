// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

export {
  runChecks,
  listChecks,
  explainCheck,
  type EvidenceInput,
  type RunChecksResult,
  type CheckOutcome,
  type CheckStatus,
  type CheckInfo,
  type CheckExplanation,
  type RunChecksOptions,
} from "./api.js";
export type { Remediation, RemedyFn, RemedyProvider, WriterHints } from "./engine/checks/types.js";
export {
  ACCOUNT_DATA_ARRAY_KEYS,
  type AccountData,
  type AccountDataArrayKey,
  type AccountProfile,
  type ClientContextInput,
  type CampaignContextInput,
  type Row,
} from "./engine/shared/input.js";
export {
  DEFAULT_SETTINGS,
  resolveSettings,
  validateSettings,
  SETTING_RULES,
  type SettingUsed,
  type CheckSettings,
  type CheckSettingsInput,
} from "./engine/settings.js";
export type { Candidate, ContextFact } from "./engine/runEvidenceEngine.js";
export type { BusinessType } from "./engine/shared/businessType.js";
export { AUDIT_KEY_TABLE } from "./engine/model/buildAccountModel.js";
export { MERCHANT_CENTER_NOT_READ } from "./engine/checks/shopping.js";
export { NO_CAMPAIGN_OF_KIND } from "./engine/checks/types.js";
export { metricLabel, plainMetricText } from "./engine/registry/metricLabels.js";
