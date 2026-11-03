// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The negatives safety gate the negative types run while planning (at propose and again
// right before sending). Brand: always refused. Conversions: refused, unless the input
// sets override_blocked_conversions: then the change carries the count + examples in its
// facts (the approval page shows them loudly) and a warning.

import { z } from "zod";
import { ChangeError } from "../errors.js";
import type { ChangeFacts } from "../facts.js";
import type { ReadCtx } from "../types/actionType.js";
import { SAFE_DEFAULTS } from "../types/actionType.js";
import { keywordTextSchema, normKeyword } from "../types/text.js";
import { sha256Hex } from "../canonical.js";
import {
  brandTermMatchable,
  checkNegatives,
  hitLine,
  type NegativeCandidate,
  type NegativeMatchType,
} from "./safety.js";
import { readConversionSources, SAFETY_WINDOW_DAYS } from "./sources.js";

export const MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"] as const;

export const negativeInput = z
  .object({
    text: keywordTextSchema.describe("The words only, no [brackets] or quotes"),
    match_type: z.enum(MATCH_TYPES),
  })
  .strict();

export const brandTermsInput = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(brandTermMatchable, "a brand term needs a letter or digit"),
  )
  .max(50)
  .optional()
  .describe(
    "More brand words, never negated (adds to the policy's brand_terms and the account name)",
  );

export const overrideInput = z
  .boolean()
  .optional()
  .describe(
    "Send negatives that block searches or keywords with conversions anyway (shown loudly to the approver)",
  );

/** Item key of one negative: ["neg", <where>, <match type>, <lower-case text>]. */
export const negKey = (where: string, matchType: string, text: string): string =>
  JSON.stringify(["neg", where, matchType, normKeyword(text)]);

export const parseNegKey = (
  key: string,
): { where: string; matchType: NegativeMatchType; text: string } | null => {
  try {
    const v = JSON.parse(key) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 4 &&
      v[0] === "neg" &&
      typeof v[1] === "string" &&
      (MATCH_TYPES as readonly unknown[]).includes(v[2]) &&
      typeof v[3] === "string"
    ) {
      return { where: v[1], matchType: v[2] as NegativeMatchType, text: v[3] };
    }
  } catch {
    // not a negative key
  }
  return null;
};

const EXAMPLES_MAX = 10;

export interface GateOutcome {
  warnings: string[];
  blocked: ChangeFacts["blockedConversions"] | undefined;
}

/**
 * Runs the safety check on `candidates` (live reads). Throws not_allowed for any brand
 * hit, and for conversion hits unless `override`. Brand terms = the policy's brand_terms
 * (or, when it sets none, the account name) + the input's brand_terms: input only adds. A term with nothing to
 * match (no letter or digit) is refused, never skipped.
 */
export const negativesGate = async (
  ctx: ReadCtx,
  candidates: readonly NegativeCandidate[],
  opts: {
    override: boolean;
    brandTerms?: readonly string[] | undefined;
    /** The change reaches a Performance Max campaign (PMax searches must be readable). */
    reachesPmax: boolean;
  },
): Promise<GateOutcome> => {
  const warnings: string[] = [];
  const defaults = ctx.defaults ?? SAFE_DEFAULTS;
  const policyTerms = [...defaults.brandTerms];
  const inputTerms = [...(opts.brandTerms ?? [])];
  const bad = [...policyTerms, ...inputTerms].filter((t) => !brandTermMatchable(t));
  if (bad.length) {
    throw new ChangeError(
      "not_allowed",
      `Refused: brand term ${JSON.stringify(bad[0])} has no letter or digit, so it can't protect anything. Fix it (policy brand_terms or the brand_terms input). Nothing was proposed.`,
    );
  }
  // The owner's policy brand_terms replace the account-name fallback; the AI's input
  // only ever adds to whichever of the two is in force.
  const useName = policyTerms.length === 0;
  const nameUsable = useName && brandTermMatchable(ctx.account.name);
  const brands = [...policyTerms, ...(nameUsable ? [ctx.account.name] : []), ...inputTerms];
  const used = [
    ...(policyTerms.length ? [`${policyTerms.length} from the policy`] : []),
    ...(nameUsable ? ["the account name"] : []),
    ...(inputTerms.length ? [`${inputTerms.length} given with this change`] : []),
  ];
  if (useName && !nameUsable) {
    warnings.push(
      "The account name has no letter or digit to match, so it does not protect brand searches.",
    );
  }
  if (useName) {
    warnings.push(
      used.length
        ? `No brand_terms in the policy for this account. Brand protection uses: ${used.join(" and ")}.`
        : "No brand terms are set and the account name can't be matched, so brand searches could not be protected.",
    );
  }
  if (candidates.length === 0) return { warnings, blocked: undefined };
  const sources = await readConversionSources(ctx, { reachesPmax: opts.reachesPmax });
  warnings.push(...sources.notes);
  const result = checkNegatives(candidates, { ...sources, brandTerms: brands });
  if (result.brand.length > 0) {
    throw new ChangeError(
      "not_allowed",
      `Refused: ${result.brand.length} negative${result.brand.length === 1 ? " names" : "s name"} your brand, and brand searches are never blocked: ${result.brand
        .slice(0, 5)
        .map(hitLine)
        .join("; ")}. Nothing was proposed.`,
    );
  }
  if (result.converting.length === 0) return { warnings, blocked: undefined };
  if (!opts.override) {
    throw new ChangeError(
      "not_allowed",
      `Refused: ${result.converting.length} negative${result.converting.length === 1 ? "" : "s"} would block searches or keywords with conversions in the last ${SAFETY_WINDOW_DAYS} days: ${result.converting
        .slice(0, 5)
        .map(hitLine)
        .join(
          "; ",
        )}${result.converting.length > 5 ? "; ..." : ""}. Remove them, or set override_blocked_conversions: true to ask a person to approve them anyway. Nothing was proposed.`,
    );
  }
  warnings.unshift(
    `OVERRIDE: ${result.converting.length} negative${result.converting.length === 1 ? " blocks" : "s block"} searches or keywords that had conversions in the last ${SAFETY_WINDOW_DAYS} days. They are sent anyway because override_blocked_conversions is true.`,
  );
  // The whole blocked set (every negative -> every search / keyword it blocks) is hashed
  // into the facts: any change to it before the send makes the change stale.
  const pairs = result.converting
    .flatMap((h) =>
      (h.allBlocked ?? []).map(
        (b) => `${h.candidate.matchType}|${normKeyword(h.candidate.text)}|${b}`,
      ),
    )
    .sort();
  const examples = result.converting
    .map((h) => ({
      negative: h.candidate.text,
      matchType: h.candidate.matchType,
      kind: (h.reason === "converted_term" ? "search" : "keyword") as "search" | "keyword",
      blocks: h.blocks,
    }))
    .sort((a, b) =>
      `${a.matchType}|${a.negative}|${a.blocks}`.localeCompare(
        `${b.matchType}|${b.negative}|${b.blocks}`,
      ),
    )
    .slice(0, EXAMPLES_MAX);
  return {
    warnings,
    blocked: {
      count: result.converting.length,
      blockedTexts: pairs.length,
      setHash: sha256Hex(pairs.join("\n")),
      examples,
    },
  };
};
