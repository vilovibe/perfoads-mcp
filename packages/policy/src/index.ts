// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

export {
  LIMIT_DEFAULTS,
  parsePolicyText,
  POLICY_FILE,
  POLICY_MAX_BYTES,
  PolicySchema,
  TIERS,
  type ParseResult,
  type PolicyV1,
  type Tier,
} from "./schema.js";
export {
  addedSpend,
  configuredTier,
  describeChange,
  evaluate,
  gateOf,
  isLowRisk,
  SPENT_STATUSES,
  stricterTier,
  type Verdict,
} from "./evaluate.js";
export {
  createPolicySource,
  policyPath,
  readPolicyFile,
  workspaceFoldersHolding,
  type PolicySource,
  type PolicySourceOptions,
  type PolicyState,
} from "./source.js";
export {
  createFilePolicy,
  NO_POLICY_REASON,
  notValidReason,
  policyLabel,
  type FilePolicy,
} from "./check.js";
export { describePolicy, describeState, policyResource, starterPolicy } from "./describe.js";
