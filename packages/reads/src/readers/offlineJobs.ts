// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot): the latest uploads to customer lists and
// store-sales imports (offline_user_data_job). Job metadata only: type, status, Google's
// failure reason and the customer list a job uploads to. No uploaded data is read.

import * as z from "zod";
import { countBy, plural } from "../common.js";
import { enumValue, get, id, idFromResourceName } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";

/** The newest jobs read: enough for the latest upload to each list. */
export const OFFLINE_JOBS_CAP = 100;

export const OfflineJobRowSchema = z.object({
  jobId: z.string(),
  type: z
    .string()
    .nullable()
    .describe("CUSTOMER_MATCH_USER_LIST, STORE_SALES_UPLOAD_FIRST_PARTY, ..."),
  status: z.string().nullable().describe("PENDING, RUNNING, SUCCESS, FAILED"),
  failureReason: z.string().nullable(),
  userListId: z.string().nullable().describe("The customer list a customer-match job uploads to"),
});
export type OfflineJobRow = z.infer<typeof OfflineJobRowSchema>;

export const OfflineJobSummarySchema = z.object({
  jobs: z.number().nullable().describe("null = not read"),
  byStatus: z.record(z.string(), z.number()),
});
export type OfflineJobSummary = z.infer<typeof OfflineJobSummarySchema>;

/** Newest first: job ids grow over time. */
export const OFFLINE_JOBS_QUERY = `
    SELECT
      offline_user_data_job.id,
      offline_user_data_job.type,
      offline_user_data_job.status,
      offline_user_data_job.failure_reason,
      offline_user_data_job.customer_match_user_list_metadata.user_list
    FROM offline_user_data_job
    ORDER BY offline_user_data_job.id DESC`;

export const offlineJobsReader: ReaderDef<null, OfflineJobRow, OfflineJobSummary, null> = {
  name: "offline_jobs",
  // the newest jobs by design (the latest upload to each list): never a "partial" read
  queries: () => ({ jobs: { gaql: OFFLINE_JOBS_QUERY, limit: OFFLINE_JOBS_CAP, topOnly: true } }),
  map: (data) => ({
    rows: (data.jobs ?? [])
      .map((row) => {
        const j = (path: string) => get(row, `offlineUserDataJob.${path}`);
        const jobId = id(j("id"));
        if (!jobId) return null;
        return {
          jobId,
          type: enumValue(j("type")),
          status: enumValue(j("status")),
          failureReason: enumValue(j("failureReason")),
          userListId: idFromResourceName(j("customerMatchUserListMetadata.userList")),
        };
      })
      .filter((r): r is OfflineJobRow => r !== null),
    extra: null,
  }),
  // newest first: a longer id is newer, equal lengths compare as text
  compare: (a, b) => b.jobId.length - a.jobId.length || b.jobId.localeCompare(a.jobId),
  summarise: (rows, _extra, _ctx, _input, parts) => ({
    jobs: partOk(parts, "jobs") ? rows.length : null,
    byStatus: countBy(rows, (r) => r.status),
  }),
  summaryLine: (s, ctx) =>
    s.jobs === null
      ? `Customer list and store-sales uploads on ${ctx.customerId}: unknown (not read).`
      : `${plural(s.jobs, "customer list or store-sales upload")} read on ${ctx.customerId}.`,
  rowLine: (r) =>
    `job ${r.jobId} ${r.type ?? "?"} ${r.status ?? "?"}${r.failureReason ? ` (${r.failureReason})` : ""}${r.userListId ? ` list ${r.userListId}` : ""}`,
};
