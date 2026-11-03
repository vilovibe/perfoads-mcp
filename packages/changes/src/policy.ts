// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { AccountFacts, ChangeFacts } from "./facts.js";
import type { PolicyDefaults } from "./types/actionType.js";

// The seam for the policy engine (plan section 7, @perfoads/policy). Without a policy the
// default is READ_ONLY_POLICY: nothing can be proposed or applied.

export type RiskTier = "auto" | "confirm" | "blocked";

export interface PolicyDecision {
  allowed: boolean;
  tier: RiskTier;
  /** Plain sentence, shown when not allowed. */
  reason: string;
  /** Which policy decided (name + version), stored with the change. */
  policy: string;
  /** Hash of the policy file that decided (stored with the change at propose). */
  hash?: string | undefined;
  /** Which rule refused (for the audit log). */
  rule?: string | null | undefined;
}

/** A change on the same account that was claimed (sent or being sent) recently. */
export interface RecentWrite {
  changeId: string;
  status: string;
  /** When it was claimed (applying_at), ISO. */
  claimedAt: string;
  facts: ChangeFacts;
}

export interface PolicyRequest {
  /**
   * propose: before Google's check. apply: before the claim (live account). claim: inside
   * the claim transaction (BEGIN IMMEDIATE), with this account's claims read in that same
   * transaction. approve: an auto-tier approval by the policy itself.
   */
  stage: "propose" | "apply" | "claim" | "approve";
  type: string;
  account: AccountFacts;
  /** The checked input (zod-parsed), e.g. { campaign_id, status }. */
  payload?: unknown;
  facts: ChangeFacts;
  opsCount: number;
  undoOf: string | null;
  /** An undo that puts back exactly the stored before values (the engine checked it). */
  restoresBefore?: boolean;
  /** Hash of the policy the change was proposed under (apply / claim / approve). */
  proposedUnder?: string | null;
  /** How the change was approved (apply / claim): "policy_auto" or a human path. */
  approvedVia?: string | null;
  /** This account's changes claimed in the last 24 h, without this one. */
  recent?: readonly RecentWrite[];
  /** Epoch ms of the check. */
  now?: number;
}

export interface PolicyCheck {
  readonly name: string;
  /** Cheap first check before any Google call: may this account be written at all? */
  gate(customerId: string, type: string): PolicyDecision;
  /**
   * Before any Google call of a proposal (kind propose) or an undo proposal (kind undo):
   * refusal when this account had too many attempts of that kind in the last minute / 24
   * hours. Attempts refused by a limit are not counted.
   */
  proposals?(
    customerId: string,
    counts: { kind: "propose" | "undo"; minute: number; day: number },
  ): PolicyDecision;
  /** Full check with the planned change's facts. Runs at propose, apply and in the claim. */
  check(request: PolicyRequest): PolicyDecision;
  /**
   * May changes reach this account although it is not a Google Ads test account? Only a
   * valid policy that lists it under accounts.write says yes. Missing = no.
   */
  liveWrites?(customerId: string): boolean;
  /** Plain lines for the approval view (spend left in the 24-hour limit, ...). */
  describe?(request: PolicyRequest): string[];
  /**
   * The defaults the create types follow on this account (new keywords paused, broad match
   * only with smart bidding, brand terms never negated). Missing = SAFE_DEFAULTS.
   */
  defaults?(customerId: string): PolicyDefaults;
}

const READ_ONLY_REASON =
  "Changes are turned off: there is no change policy yet, so this server is read-only everywhere.";

const readOnly: PolicyDecision = {
  allowed: false,
  tier: "blocked",
  reason: READ_ONLY_REASON,
  policy: "read-only (no policy)",
};

export const READ_ONLY_POLICY: PolicyCheck = Object.freeze({
  name: "read-only (no policy)",
  gate: () => readOnly,
  check: () => readOnly,
});
