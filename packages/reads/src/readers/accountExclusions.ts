// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot): account-level content exclusions.
// Content labels (customer_negative_criterion CONTENT_LABEL) are new here; placements,
// YouTube, apps and attached lists reuse ACCOUNT_EXCLUSIONS_QUERY from the negatives reader
// (PerfoAds fetchAccountPlacementExclusions).

import * as z from "zod";
import { countBy, plural, shown } from "../common.js";
import { enumValue, get, id, idFromResourceName, textOrNull, type Row } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";
import { ACCOUNT_EXCLUSIONS_QUERY } from "./negatives.js";

export const AccountExclusionRowSchema = z.object({
  criterionId: z.string().nullable(),
  type: z.string().nullable().describe("CONTENT_LABEL, PLACEMENT, YOUTUBE_CHANNEL, ..."),
  contentLabel: z.string().nullable().describe("e.g. SEXUALLY_SUGGESTIVE, BELOW_THE_FOLD"),
  mobileAppCategory: z
    .string()
    .nullable()
    .describe("Excluded app category (mobileAppCategoryConstants/<id>)"),
  value: UntrustedSchema.nullable().describe("URL, channel, video or app id"),
  sharedSetId: z.string().nullable().describe("Attached negative keyword / placement list"),
});
export type AccountExclusionRow = z.infer<typeof AccountExclusionRowSchema>;

export const AccountExclusionSummarySchema = z.object({
  exclusions: z.number().nullable().describe("null = a part was not read"),
  contentLabels: z.array(z.string()).nullable().describe("null = not read"),
  byType: z.record(z.string(), z.number()),
});
export type AccountExclusionSummary = z.infer<typeof AccountExclusionSummarySchema>;

export const CONTENT_LABELS_QUERY = `
    SELECT
      customer_negative_criterion.id,
      customer_negative_criterion.type,
      customer_negative_criterion.content_label.type
    FROM customer_negative_criterion
    WHERE customer_negative_criterion.type = 'CONTENT_LABEL'
    ORDER BY customer_negative_criterion.id`;

/** App categories excluded at account level (the "All apps" exclusion among them). */
export const APP_CATEGORIES_QUERY = `
    SELECT
      customer_negative_criterion.id,
      customer_negative_criterion.type,
      customer_negative_criterion.mobile_app_category.mobile_app_category_constant
    FROM customer_negative_criterion
    WHERE customer_negative_criterion.type = 'MOBILE_APP_CATEGORY'
    ORDER BY customer_negative_criterion.id`;

const mapRow = (row: Row): AccountExclusionRow => {
  const c = (path: string) => get(row, `customerNegativeCriterion.${path}`);
  const value =
    c("placement.url") ??
    c("youtubeChannel.channelId") ??
    c("youtubeVideo.videoId") ??
    c("mobileApplication.appId");
  return {
    criterionId: id(c("id")) ?? idFromResourceName(c("resourceName")),
    type: enumValue(c("type")),
    contentLabel: enumValue(c("contentLabel.type")),
    mobileAppCategory:
      typeof c("mobileAppCategory.mobileAppCategoryConstant") === "string"
        ? (c("mobileAppCategory.mobileAppCategoryConstant") as string)
        : null,
    value: textOrNull(value),
    sharedSetId:
      idFromResourceName(c("negativeKeywordList.sharedSet")) ??
      idFromResourceName(c("placementList.sharedSet")),
  };
};

export const accountExclusionsReader: ReaderDef<
  null,
  AccountExclusionRow,
  AccountExclusionSummary,
  null
> = {
  name: "account_exclusions",
  queries: () => ({
    content_labels: { gaql: CONTENT_LABELS_QUERY },
    placements: { gaql: ACCOUNT_EXCLUSIONS_QUERY },
    app_categories: { gaql: APP_CATEGORIES_QUERY },
  }),
  map: (data) => ({
    rows: [
      ...(data.content_labels ?? []),
      ...(data.placements ?? []),
      ...(data.app_categories ?? []),
    ].map(mapRow),
    extra: null,
  }),
  compare: (a, b) =>
    (a.type ?? "").localeCompare(b.type ?? "") ||
    (a.criterionId ?? "").localeCompare(b.criterionId ?? ""),
  summarise: (rows, _extra, _ctx, _input, parts) => ({
    exclusions:
      partOk(parts, "content_labels") &&
      partOk(parts, "placements") &&
      partOk(parts, "app_categories")
        ? rows.length
        : null,
    contentLabels: partOk(parts, "content_labels")
      ? rows
          .map((r) => r.contentLabel)
          .filter((l): l is string => l !== null)
          .sort()
      : null,
    byType: countBy(rows, (r) => r.type),
  }),
  summaryLine: (s, ctx) =>
    `${s.exclusions === null ? "Account-level exclusions: unknown (not all read)" : plural(s.exclusions, "account-level exclusion")} on ${ctx.customerId}; content labels excluded: ${s.contentLabels === null ? "unknown (not read)" : s.contentLabels.join(", ") || "none"}.`,
  rowLine: (r) =>
    `${r.type ?? "?"} ${r.contentLabel ?? (r.value ? shown(r.value) : r.sharedSetId ? `list ${r.sharedSetId}` : "?")}`,
};
