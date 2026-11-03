// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The business-type gate — A6 of AUDIT_V3_RULE_GAP_PLAN.md (rules 119, 134,
 * 263, 264, 266, 267, 385).
 *
 * `detectBusinessType` has existed since v1 and, until today, reached exactly
 * one prompt string. Nothing in the evidence engine knew whether the account
 * sells products or collects leads, so a plumber could be told his feed was
 * disapproved and a lead-gen account could be told its ROAS was falling when
 * it has never assigned a conversion value in its life.
 *
 * Like checks/brandGate.ts this is a DECLARED TABLE, not thirty special cases
 * scattered through the check bodies: one row per check id, the rule number in
 * the comment, so any suppression traces back to the sentence that caused it.
 * It is applied in `defineCheck` (checks/types.ts) AFTER the brand gate.
 *
 * TWO deliberate differences from the brand gate:
 *
 *   1. It runs BEFORE `def.run(ctx)`, not after. Business type is a property of
 *      the ACCOUNT, so there is nothing per-finding to weigh, and running first
 *      is the whole point of the fix. Several SH* checks already fall to
 *      `not_checkable` on a lead-gen account — but they do it because their
 *      `requires` name Merchant Center tables, so the report prints "no data"
 *      when the truth is "this account is not e-commerce". The number was never
 *      wrong; the REASON was, and the reason is what a client reads.
 *   2. `'unknown'` is a deny, never a pass. Rule 264: with no business-type
 *      classification, do not apply ROAS targets, CPL benchmarks, LSA, store
 *      visits or the budget tier framework. An unclassified account abstains
 *      and says so. It is never quietly read as e-commerce.
 *
 * What it does NOT do: it does not gate SH03/SH04/SH10 (product spend
 * concentration, product spend without a sale, duplicate Shopping priority).
 * Those fire off Google Ads' own Shopping tables — an account with a Shopping
 * campaign HAS a feed whatever the questionnaire says, and the finding is about
 * the campaign, not about the business model.
 */
import type { BusinessType } from "../shared/businessType.js";
import { postLeadOutcomeRider } from "./clientContextGate.js";
import type { CheckCtx, CheckResult } from "./types.js";
import { isOk } from "./types.js";

/** Every type that is not `unknown`. Used by the value-aware rows, which deny on classification, not on model. */
export const CLASSIFIED_TYPES: readonly BusinessType[] = [
  "ecommerce",
  "lead_gen",
  "local_lead_gen",
  "local_retail",
];

export interface BusinessTypeRule {
  /**
   * The types this check may fire on. Anything else is denied.
   * `'unknown'` is never listed — rule 264 makes an unclassified account abstain.
   */
  allow: readonly BusinessType[];
  /** inventory rule number(s) this row encodes — AUDIT_V3_RULE_INVENTORY.md. */
  rules: string;
  /** the reason the REPORT prints, in plain words. Never "no data". */
  why: string;
  /**
   * Value-aware rows only. When the type is denied but this holds, the check
   * runs anyway. Used where the finding itself is real on every business type
   * and only its KEY (ROAS) is wrong — see TR01/TR01a below.
   */
  allowIf?(ctx: CheckCtx): boolean;
}

/** Only e-commerce. The plain sentence the report prints for the whole family. */
const ECOM_ONLY = ["ecommerce"] as const;

/**
 * Rules 134 / 263: never use ROAS as the headline for a lead-gen account —
 * "$0 ROAS" there is the EXPECTED state, and a 0.19x ROAS with no configured
 * values is a measurement artefact, not a decline.
 *
 * But a lead-gen account in a real decline still has a decline worth reporting,
 * so this is not a hard deny. The question is whether the account assigns
 * conversion VALUE: if it does, ROAS means something whatever the vertical (a
 * great many lead-gen accounts value their leads), and the finding stands. If
 * it does not, the ROAS spine has nothing under it and the decline would have
 * to be keyed on cost per lead — which TR01/TR01a cannot do today, so they
 * abstain and say why rather than printing an artefact.
 */
function accountReportsConversionValue(ctx: CheckCtx): boolean {
  const v = ctx.get("A.conv_value");
  if (!isOk(v)) return false;
  return typeof v.value === "number" && v.value > 0;
}

const VALUE_KEYED: Pick<BusinessTypeRule, "allow" | "allowIf"> = {
  allow: ECOM_ONLY,
  allowIf: accountReportsConversionValue,
};

/**
 * The table. Every row names its rule; a row is added only when the inventory
 * says so, never because a finding looked awkward on one account.
 */
export const BUSINESS_TYPE_RULES: Readonly<Record<string, BusinessTypeRule>> = {
  // --- rules 134 / 263: the bidding ladder's target rungs are tROAS rungs. An
  // account with no revenue cannot be offered a return target, and "$0 ROAS" is
  // the expected state there, not a defect. Value-aware for the same reason
  // TR01 is: a lead-gen account that DOES value its leads can hold a tROAS.
  BB04: {
    ...VALUE_KEYED,
    rules: "134, 263",
    why: "this account is not e-commerce and reports no conversion value, so a return target cannot be judged",
  },
  BB06: {
    ...VALUE_KEYED,
    rules: "134, 263",
    why: "this account is not e-commerce and reports no conversion value, so it cannot be offered a return target",
  },
  // plan 5.2: "bid on value" is only advice where the conversions carry value
  // review fix: e-commerce ONLY — a lead-gen account's values are usually one default per action, so "bid on value" there is bidding on a count again
  BB14: {
    allow: ECOM_ONLY,
    rules: "134, 263",
    why: "this account is not e-commerce, so its conversion values are not order values and value-based bidding is not recommended",
  },
  MI03: {
    allow: ECOM_ONLY,
    rules: "266, 267",
    why: "this account is not e-commerce, so duplicate purchase actions are not audited",
  },
  MI04: {
    allow: ECOM_ONLY,
    rules: "134, 266",
    why: "this account is not e-commerce, so conversion-value rules are not read as revenue distortion",
  },
  MI14: {
    allow: ECOM_ONLY,
    rules: "134, 266",
    why: "this account is not e-commerce, so conversion-value rules are not read as revenue distortion",
  },
  MI16: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so a form or a call counted as a conversion is the goal, not a step before a sale",
  },
  AS09: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so the standard shop remarketing lists are not expected",
  },
  AS17: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so the holiday shopping peak is not audited",
  },
  SK30: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so product-page landing for research searches is not audited",
  },
  // --- rule 266: the Shopping feed and shop checks are for online stores
  SH01: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so its product feed is not audited",
  },
  SH02: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so its Merchant Center account is not audited",
  },
  SH05: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so product-level returns are not audited",
  },
  SH06: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so product attributes are not audited",
  },
  SH08: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so Merchant Center promotions are not audited",
  },
  SH09: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so shipping and return policies are not audited",
  },
  SH11: {
    allow: ECOM_ONLY,
    rules: "266, 267",
    why: "this account is not e-commerce, so cart economics are not audited",
  },
  SH22: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so Merchant Center promotions are not audited",
  },
  SH23: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so its product feed is not audited",
  },
  SH24: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so store ratings are not audited",
  },
  SL11: {
    allow: ECOM_ONLY,
    rules: "266",
    why: "this account is not e-commerce, so there are no shop countries to compare spend with",
  },
  // --- rules 134 / 263: the decline itself is real on any business type; the ROAS spine
  // it is stated on is not.
  TR01: {
    ...VALUE_KEYED,
    rules: "134, 263",
    why: "this account is not e-commerce and reports no conversion value, so a decline cannot be keyed on ROAS — it would have to be keyed on cost per lead",
  },
  TR01a: {
    ...VALUE_KEYED,
    rules: "134, 263",
    why: "this account is not e-commerce and reports no conversion value, so the account decline cannot be keyed on ROAS — it would have to be keyed on cost per lead",
  },
};

/**
 * The sentence for an account nobody classified. Rule 264: emit the
 * classification gap, do not guess. Kept apart from `rule.why` because the
 * reader needs to know the difference between "this does not apply to you" and
 * "we could not tell what you are".
 */
export function unclassifiedReason(checkId: string): string {
  return `the account's business type was not classified, so ${checkId} abstains rather than assume e-commerce — set profile.businessType to fix it`;
}

/**
 * The verdict, BEFORE the check runs. `null` means "run it".
 *
 * Returning `not_checkable` (rather than `none_found`) is deliberate: this is an
 * applicability answer, the same shape rule 4 uses for a table that cannot be
 * read, and it is what `buildNotChecked` reads to tell the client which pillars
 * were not measured and why.
 */
export function businessTypeVerdict(
  checkId: string,
  ctx: CheckCtx,
): {
  state: "not_checkable";
  reason: string;
  category: "not_applicable" | "needs_client_input";
} | null {
  const rule = BUSINESS_TYPE_RULES[checkId];
  if (!rule) return null;
  const type = ctx.businessType;
  if (rule.allow.includes(type)) return null;
  if (type === "unknown")
    return {
      state: "not_checkable",
      reason: unclassifiedReason(checkId),
      category: "needs_client_input",
    };
  if (rule.allowIf?.(ctx) === true) return null;
  return {
    state: "not_checkable",
    reason: withPostLeadRider(`${rule.why} (classified ${type})`, ctx),
    category: "not_applicable",
  };
}

/**
 * §3b step 3 — `tracksPostLeadOutcomes`.
 *
 * Every reason above ends at "so this cannot be judged". For a lead-gen account
 * that is only half the truth, and the missing half is the useful one: the
 * difference between "your tracking is broken" and "you track leads only, and
 * here is what that hides". The client answered that question in the intake
 * form and until now nothing read the answer.
 *
 * ADDITIVE ONLY. The rider is appended when the client answered, and an account
 * that skipped the question reads exactly as it did before. It carries no date
 * and no "currently": an answer is something the owner entered at some point,
 * never proof of what is true today.
 */
function withPostLeadRider(reason: string, ctx: CheckCtx): string {
  const rider = postLeadOutcomeRider(ctx);
  return rider ? `${reason} — ${rider}` : reason;
}

/**
 * Applied in `defineCheck`. It takes a THUNK rather than a result because,
 * unlike the brand gate, this one must be able to stop the check from running
 * at all — that is how the misleading "no Merchant Center data" reason is
 * replaced by "this account is not e-commerce".
 */
export function applyBusinessTypeGate(
  checkId: string,
  ctx: CheckCtx,
  run: () => CheckResult,
): CheckResult {
  return businessTypeVerdict(checkId, ctx) ?? run();
}
