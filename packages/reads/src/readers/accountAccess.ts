// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal readers (no tools; for the snapshot): auto-apply settings and user access counts.
// Ported from PerfoAds fetchRecommendations step 2 (recommendation_subscription: the type
// also sits in the resource name, which Google keeps when the enum is newer than the API
// version and reads UNKNOWN) and fetchCustomerUserAccess. Change: user access is read as
// roles only (never email_address), and returned as counts.

import * as z from "zod";
import { countBy, plural } from "../common.js";
import { enumValue, get } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";

export const AutoApplyRowSchema = z.object({
  type: z.string().nullable().describe("Recommendation type Google may apply on its own"),
  status: z.string().nullable().describe("ENABLED = auto-apply on"),
});
export type AutoApplyRow = z.infer<typeof AutoApplyRowSchema>;

export const AutoApplySummarySchema = z.object({
  subscriptions: z.number().nullable().describe("null = not read"),
  enabled: z.array(z.string()).nullable().describe("Types auto-applied now; null = not read"),
});
export type AutoApplySummary = z.infer<typeof AutoApplySummarySchema>;

export const AUTO_APPLY_QUERY = `
    SELECT
      recommendation_subscription.resource_name,
      recommendation_subscription.type,
      recommendation_subscription.status
    FROM recommendation_subscription`;

/** The enum, or the type at the end of customers/1/recommendationSubscriptions/<TYPE>. */
const subscriptionType = (type: unknown, resourceName: unknown): string | null => {
  const t = enumValue(type);
  if (t && t !== "UNKNOWN" && t !== "UNSPECIFIED") return t;
  const m =
    typeof resourceName === "string"
      ? /^customers\/\d+\/recommendationSubscriptions\/([A-Z][A-Z0-9_]*)$/.exec(resourceName)
      : null;
  return m?.[1] ?? t;
};

export const autoApplyReader: ReaderDef<null, AutoApplyRow, AutoApplySummary, null> = {
  name: "auto_apply",
  queries: () => ({ subscriptions: { gaql: AUTO_APPLY_QUERY } }),
  map: (data) => ({
    rows: (data.subscriptions ?? []).map((row) => ({
      type: subscriptionType(
        get(row, "recommendationSubscription.type"),
        get(row, "recommendationSubscription.resourceName"),
      ),
      status: enumValue(get(row, "recommendationSubscription.status")),
    })),
    extra: null,
  }),
  compare: (a, b) => (a.type ?? "").localeCompare(b.type ?? ""),
  summarise: (rows, _extra, _ctx, _input, parts) => {
    const ok = partOk(parts, "subscriptions");
    return {
      subscriptions: ok ? rows.length : null,
      enabled: ok
        ? rows
            .filter((r) => r.status === "ENABLED")
            .map((r) => r.type ?? "UNKNOWN")
            .sort()
        : null,
    };
  },
  summaryLine: (s, ctx) =>
    `Auto-apply on ${ctx.customerId}: ${s.enabled === null ? "unknown (not read)" : `${s.enabled.length ? s.enabled.join(", ") : "nothing"} switched on`}.`,
  rowLine: (r) => `${r.type ?? "?"} ${r.status ?? "?"}`,
};

export const UserAccessRowSchema = z.object({
  role: z.string().describe("ADMIN, STANDARD, READ_ONLY, EMAIL_ONLY"),
  users: z.number(),
});
export type UserAccessRow = z.infer<typeof UserAccessRowSchema>;

export const UserAccessSummarySchema = z.object({
  users: z.number().nullable().describe("null = not read"),
  admins: z.number().nullable(),
});
export type UserAccessSummary = z.infer<typeof UserAccessSummarySchema>;

/** Roles only: the email address is never read. */
export const USER_ACCESS_QUERY = `
    SELECT
      customer_user_access.access_role
    FROM customer_user_access`;

export const userAccessReader: ReaderDef<null, UserAccessRow, UserAccessSummary, null> = {
  name: "user_access",
  queries: () => ({ users: { gaql: USER_ACCESS_QUERY } }),
  map: (data) => ({
    rows: Object.entries(
      countBy(data.users ?? [], (row) => enumValue(get(row, "customerUserAccess.accessRole"))),
    ).map(([role, users]) => ({ role, users })),
    extra: null,
  }),
  compare: (a, b) => a.role.localeCompare(b.role),
  summarise: (rows, _extra, _ctx, _input, parts) => {
    const ok = partOk(parts, "users");
    return {
      users: ok ? rows.reduce((n, r) => n + r.users, 0) : null,
      admins: ok ? (rows.find((r) => r.role === "ADMIN")?.users ?? 0) : null,
    };
  },
  summaryLine: (s, ctx) =>
    `${s.users === null ? "Users: unknown (not read)" : plural(s.users, "user")} with access to ${ctx.customerId}, ${s.admins ?? "unknown"} admin.`,
  rowLine: (r) => `${r.role}: ${plural(r.users, "user")}`,
};
