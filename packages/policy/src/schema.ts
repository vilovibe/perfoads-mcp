// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// policy.yaml, schema version 1 (plan section 7). Every object is strict: an unknown or
// misspelt key makes the whole file invalid (then the server is read-only), never
// "partly valid". Account ids are strings (quoted in YAML) so a leading zero survives.

import { parseDocument } from "yaml";
import * as z from "zod";
import { brandTermMatchable } from "@perfoads/changes";

export const POLICY_FILE = "policy.yaml";
/** Larger files are refused (a policy is a few hundred bytes). */
export const POLICY_MAX_BYTES = 64 * 1024;

export const TIERS = ["auto", "confirm", "blocked"] as const;
export type Tier = (typeof TIERS)[number];

/** Used when policy.yaml leaves a limit out (the plan's example values). */
export const LIMIT_DEFAULTS = Object.freeze({
  max_budget_change_pct: 30,
  max_target_change_pct: 20,
  writes_per_day: 50,
  writes_per_minute: 10,
  max_ops_per_change: 200,
  proposals_per_minute: 20,
  proposals_per_day: 200,
  undo_per_day: 50,
});

const ACCOUNT_ID = /^(\d{10}|\d{3}-\d{3}-\d{4})$/;
const TIER_KEY = /^[a-z][a-z0-9_]*\*?$|^\*$/;

const accountId = z
  .string({ error: 'account ids must be quoted strings, e.g. "123-456-7890"' })
  .regex(ACCOUNT_ID, { error: "an account id is 10 digits (dashes allowed: 123-456-7890)" })
  .transform((v) => v.replace(/-/g, ""));

/** An amount in the account's currency: positive, at most 6 decimals. */
const money = z
  .number({ error: "an amount must be a number (in the account's currency)" })
  .positive({ error: "an amount must be more than 0" })
  .max(1e12, { error: "an amount must be at most 1,000,000,000,000" })
  .refine((v) => Number(v.toFixed(6)) === v, { error: "an amount has at most 6 decimals" });

const pct = (max: number) =>
  z
    .number({ error: "a percentage must be a number" })
    .positive({ error: "a percentage must be more than 0" })
    .max(max, { error: `a percentage must be at most ${max}` });

const count = z
  .number({ error: "a count must be a whole number" })
  .int({ error: "a count must be a whole number" })
  .positive({ error: "a count must be at least 1" })
  .max(1_000_000, { error: "a count must be at most 1,000,000" });

/** Map of account id -> amount. Two spellings of one account (with / without dashes) = error. */
const perAccount = z
  .record(z.string(), money)
  .superRefine((rec, ctx) => {
    const seen = new Set<string>();
    for (const key of Object.keys(rec)) {
      if (!ACCOUNT_ID.test(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "an account id is 10 digits (dashes allowed: 123-456-7890), quoted",
        });
        continue;
      }
      const id = key.replace(/-/g, "");
      if (seen.has(id)) {
        ctx.addIssue({ code: "custom", path: [key], message: "this account is listed twice" });
      }
      seen.add(id);
    }
  })
  .transform((rec) =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [k.replace(/-/g, ""), v])),
  );

export const PolicySchema = z.strictObject({
  version: z.literal(1, { error: "version must be 1" }),
  accounts: z.strictObject({
    allow: z.array(accountId).max(1000).default([]),
    write: z.array(accountId).max(1000).default([]),
  }),
  limits: z
    .strictObject({
      max_budget_change_pct: pct(1000).default(LIMIT_DEFAULTS.max_budget_change_pct),
      max_budget_change_abs: perAccount.default({}),
      max_new_daily_spend: perAccount.default({}),
      max_target_change_pct: pct(1000).default(LIMIT_DEFAULTS.max_target_change_pct),
      writes_per_day: count.default(LIMIT_DEFAULTS.writes_per_day),
      writes_per_minute: count.default(LIMIT_DEFAULTS.writes_per_minute),
      max_ops_per_change: count.max(10_000).default(LIMIT_DEFAULTS.max_ops_per_change),
      proposals_per_minute: count.max(1_000).default(LIMIT_DEFAULTS.proposals_per_minute),
      proposals_per_day: count.max(100_000).default(LIMIT_DEFAULTS.proposals_per_day),
      undo_per_day: count.max(10_000).default(LIMIT_DEFAULTS.undo_per_day),
    })
    .prefault({}),
  defaults: z
    .strictObject({
      new_entities_paused: z.boolean().default(true),
      broad_match_requires_smart_bidding: z.boolean().default(true),
    })
    .prefault({}),
  /** Per account: words that are never negated (negatives safety, plan 3.3). */
  brand_terms: z
    .record(
      z.string().regex(ACCOUNT_ID, {
        error: "an account id is 10 digits (dashes allowed: 123-456-7890), quoted",
      }),
      z
        .array(
          z
            .string({ error: "a brand term is text" })
            .trim()
            .min(1, { error: "a brand term must not be empty" })
            .max(80, { error: "a brand term is at most 80 characters" })
            .refine(brandTermMatchable, {
              error: "a brand term needs a letter or digit (it could never match anything)",
            }),
        )
        .max(100, { error: "at most 100 brand terms per account" }),
    )
    .default({})
    .transform((rec) =>
      Object.fromEntries(Object.entries(rec).map(([k, v]) => [k.replace(/-/g, ""), v])),
    ),
  tiers: z
    .record(
      z.string().regex(TIER_KEY, {
        error: 'a tier key is a change type (update_budget) or a pattern ending in * ("remove_*")',
      }),
      z.enum(TIERS, { error: "a tier is auto, confirm or blocked" }),
    )
    .default({}),
  ops_budget: z
    .strictObject({
      warn_at_pct: pct(100).default(80),
      reserve_for_writes_pct: z
        .number({ error: "reserve_for_writes_pct must be a number" })
        .min(0, { error: "reserve_for_writes_pct must be 0 or more" })
        .max(90, { error: "reserve_for_writes_pct must be at most 90" })
        .default(20),
    })
    .prefault({}),
  kill_switch: z.boolean({ error: "kill_switch must be true or false" }).default(false),
});

export type PolicyV1 = z.output<typeof PolicySchema>;

export type ParseResult = { ok: true; policy: PolicyV1 } | { ok: false; problems: string[] };

const where = (path: readonly PropertyKey[]): string =>
  path.length ? path.map(String).join(".") : "the file";

/**
 * Parses policy.yaml text. YAML 1.2 core schema, duplicate keys refused, no aliases (no
 * expansion tricks), then the strict zod schema. Never partly valid.
 */
export const parsePolicyText = (text: string): ParseResult => {
  const doc = parseDocument(text, {
    schema: "core",
    uniqueKeys: true,
    merge: false,
    prettyErrors: false,
  });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      problems: doc.errors.slice(0, 5).map((e) => `YAML: ${e.message.split("\n")[0]}`),
    };
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 0 });
  } catch (err) {
    return {
      ok: false,
      problems: [`YAML: ${err instanceof Error ? err.message.split("\n")[0] : "unreadable"}`],
    };
  }
  if (data === null || data === undefined) {
    return {
      ok: false,
      problems: ["the file is empty (it needs at least version: 1 and accounts)"],
    };
  }
  const parsed = PolicySchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 8).map((i) => {
        if (i.code === "unrecognized_keys") {
          return `${where(i.path)}: unknown key${i.keys.length === 1 ? "" : "s"} ${i.keys.join(", ")}`;
        }
        if (i.code === "invalid_key") {
          return `${where(i.path)}: ${i.issues[0]?.message ?? i.message}`;
        }
        return `${where(i.path)}: ${i.message}`;
      }),
    };
  }
  const policy = parsed.data;
  const problems: string[] = [];
  const allowed = new Set([...policy.accounts.allow, ...policy.accounts.write]);
  for (const map of ["max_budget_change_abs", "max_new_daily_spend"] as const) {
    for (const id of Object.keys(policy.limits[map])) {
      if (!allowed.has(id)) {
        problems.push(
          `limits.${map}.${id}: this account is not in accounts.allow or accounts.write`,
        );
      }
    }
  }
  for (const id of Object.keys(policy.brand_terms)) {
    if (!allowed.has(id)) {
      problems.push(`brand_terms.${id}: this account is not in accounts.allow or accounts.write`);
    }
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, policy };
};
