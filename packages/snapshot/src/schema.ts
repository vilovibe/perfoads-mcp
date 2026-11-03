// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// AccountSnapshot v1: the public, versioned shape of one account read for the checks.
//
// One section per reader. Every section says how the read went: ok | failed | not_allowed
// (the Cloud project's access level or the user's account access) | skipped (not started,
// e.g. no time left), how many rows it holds, the row limit it ran under and whether it was
// cut (a part hit its limit or ran out of time). Rows are the readers' typed rows as they
// came out of the normaliser: free text (names, search terms, keyword texts, Google's
// messages) stays wrapped as {"untrusted": "..."}.
//
// A change to this shape that an old reader of the file could misread bumps `version`.

import { UntrustedSchema } from "@perfoads/reads";
import * as z from "zod";

export const SNAPSHOT_SCHEMA = "perfoads.account_snapshot";
/** v2 (2026-10-25): per-part row limits (`parts[].cap`). v1 files are refused. */
export const SNAPSHOT_VERSION = 3;

/** Snapshot ids: safe as a file name on every OS (no dots, slashes or spaces). */
export const SNAPSHOT_ID_PATTERN = /^snap_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_-]{8}$/;

export const SectionStatusSchema = z.enum(["ok", "failed", "not_allowed", "skipped"]);
export type SectionStatus = z.infer<typeof SectionStatusSchema>;

export const SnapshotPartSchema = z.object({
  part: z.string(),
  status: SectionStatusSchema,
  rows_read: z.number().int().min(0),
  capped: z.boolean().describe("Google had more rows than the part's limit: a sample"),
  time_cut: z.boolean().describe("Stopped or skipped because time ran short"),
  fallback: z.boolean().describe("Read with fewer fields after Google refused the full query"),
  cap: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("Most rows this part reads; null = did not run"),
  message: UntrustedSchema.nullable(),
});
export type SnapshotPart = z.infer<typeof SnapshotPartSchema>;

export const SnapshotSectionSchema = z.object({
  reader: z.string(),
  status: SectionStatusSchema.describe(
    "Worst status of its parts; skipped when a part was skipped for lack of time",
  ),
  row_count: z.number().int().min(0).describe("Rows in `rows`"),
  cap: z.number().int().positive().nullable().describe("Largest row limit of its parts"),
  truncated: z.boolean().describe("A part hit its limit or ran out of time: rows are a sample"),
  error: UntrustedSchema.nullable().describe("First problem, redacted; Google's words are data"),
  parts: z.array(SnapshotPartSchema),
  rows: z.array(z.record(z.string(), z.unknown())),
  extra: z.record(z.string(), z.unknown()).nullable().describe("Reader's extra sections"),
});
export type SnapshotSection = z.infer<typeof SnapshotSectionSchema>;

const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const DateSpanSchema = z.object({ start_date: DaySchema, end_date: DaySchema });

export const AccountSnapshotSchema = z.object({
  schema: z.literal(SNAPSHOT_SCHEMA),
  version: z.literal(SNAPSHOT_VERSION),
  id: z.string().regex(SNAPSHOT_ID_PATTERN),
  built_at: z.string().describe("ISO 8601, UTC"),
  elapsed_ms: z.number().int().min(0),
  complete: z
    .boolean()
    .describe(
      "Every one of the snapshot's sections read, all ok and none cut (a scoped one never is)",
    ),
  scope: z
    .union([
      z.literal("all"),
      z.object({
        sections: z.array(z.string()).describe("The only sections read"),
        checks: z.array(z.string()).describe("The checks they were read for"),
      }),
    ])
    .optional()
    .describe('"all" (or absent) = every section was asked for'),
  account: z.object({
    customer_id: z.string().regex(/^\d{10}$/),
    name: UntrustedSchema,
    currency_code: z.string().nullable(),
    time_zone: z.string().nullable(),
    is_test_account: z.boolean(),
    is_manager: z.boolean(),
  }),
  date_ranges: z.object({
    performance: DateSpanSchema.describe("Metrics, inclusive, account time zone"),
    change_history: DateSpanSchema.describe("Change history, inclusive"),
  }),
  sections: z.record(z.string(), SnapshotSectionSchema),
});
export type AccountSnapshot = z.infer<typeof AccountSnapshotSchema>;

/** The JSON Schema of AccountSnapshot v1 (for other tools that read the files). */
export const accountSnapshotJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(AccountSnapshotSchema) as Record<string, unknown>;
