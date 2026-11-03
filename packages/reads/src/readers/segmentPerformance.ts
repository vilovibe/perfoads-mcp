// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). Performance by audience segment over the range,
// for the slice checks:
// - ages (age_range_view) and genders (gender_view): one row per ad group criterion, which the
//   check engine sums per campaign;
// - audiences (campaign_audience_view, campaign-level criteria only) and ad_group_audiences
//   (ad_group_audience_view): one row per audience criterion, with the user list it names, so a
//   list counts as attached when it served at either level. A custom segment or an interest
//   comes back as a resource name only: its name is read after (custom_audience_names,
//   interest_names; optional), so an audience never shows as a bare id.
//   A list attached at both the campaign and an ad group comes back from both views, so its
//   metrics are counted twice when the two are summed.
// Google drops rows with no activity: a segment with no row had none in the range.

import * as z from "zod";
import { filterConditions, MetricsSchema, plural, where, type FilterInput } from "../common.js";
import { describeDateRange } from "../dateRange.js";
import { enumValue, get, id, idFromResourceName, metrics, text, type Row } from "../normalise.js";
import { partOk, type Part, type PartsData, type ReaderDef } from "../reader.js";
import { type Untrusted, UntrustedSchema } from "../untrusted.js";
import { customAudienceNamesQuery, interestNamesQuery, namesPart } from "./audiences.js";

export const SegmentRowSchema = z.object({
  kind: z.enum(["age", "gender", "audience"]),
  campaignId: z.string(),
  adGroupId: z.string().nullable(),
  criterionId: z.string().nullable(),
  value: z.string().nullable().describe("AGE_RANGE_25_34, FEMALE, ... (age / gender rows)"),
  audienceType: z.string().nullable().describe("USER_LIST, USER_INTEREST, ... (audience rows)"),
  userListId: z.string().nullable(),
  audienceName: UntrustedSchema.nullable()
    .default(null)
    .describe(
      "audience rows: the custom segment's or interest's name (a list's name comes from the lists read); null = not read",
    ),
  metrics: MetricsSchema,
});
export type SegmentRow = z.infer<typeof SegmentRowSchema>;

export const SegmentSummarySchema = z.object({
  ageRows: z.number().nullable().describe("null = not read"),
  genderRows: z.number().nullable(),
  audienceRows: z.number().nullable(),
});
export type SegmentSummary = z.infer<typeof SegmentSummarySchema>;

/** Ad groups x criteria can pass one Google page on a big account. */
export const SEGMENT_CAP = 50_000;

const METRIC_FIELDS = `
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value`;

const plain = (input: FilterInput): FilterInput => ({
  ...input,
  campaignId: null,
  adGroupId: null,
  status: null,
});

export const ageQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group_criterion.criterion_id,
      ad_group_criterion.age_range.type,${METRIC_FIELDS}
    FROM age_range_view
    ${where(filterConditions(plain(input), null))}
    ORDER BY campaign.id, ad_group.id`;

export const genderQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group_criterion.criterion_id,
      ad_group_criterion.gender.type,${METRIC_FIELDS}
    FROM gender_view
    ${where(filterConditions(plain(input), null))}
    ORDER BY campaign.id, ad_group.id`;

export const campaignAudienceQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      campaign_criterion.criterion_id,
      campaign_criterion.type,
      campaign_criterion.user_list.user_list,
      campaign_criterion.custom_audience.custom_audience,
      campaign_criterion.user_interest.user_interest_category,${METRIC_FIELDS}
    FROM campaign_audience_view
    ${where(filterConditions(plain(input), null))}
    ORDER BY campaign.id, campaign_criterion.criterion_id`;

const mapDemo = (row: Row, kind: "age" | "gender"): SegmentRow | null => {
  const campaignId = id(get(row, "campaign.id"));
  const value = enumValue(
    get(row, kind === "age" ? "adGroupCriterion.ageRange.type" : "adGroupCriterion.gender.type"),
  );
  if (!campaignId || !value) return null;
  return {
    kind,
    campaignId,
    adGroupId: id(get(row, "adGroup.id")),
    criterionId: id(get(row, "adGroupCriterion.criterionId")),
    value,
    audienceType: null,
    userListId: null,
    audienceName: null,
    metrics: metrics(row),
  };
};

export const adGroupAudienceQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group_criterion.criterion_id,
      ad_group_criterion.type,
      ad_group_criterion.user_list.user_list,
      ad_group_criterion.custom_audience.custom_audience,
      ad_group_criterion.user_interest.user_interest_category,${METRIC_FIELDS}
    FROM ad_group_audience_view
    ${where(filterConditions(plain(input), null))}
    ORDER BY campaign.id, ad_group.id`;

/** The criterion path of a level's audience rows. */
const critOf = (level: "campaign" | "ad_group") =>
  level === "campaign" ? "campaignCriterion" : "adGroupCriterion";

/** Digits-only ids of the custom segments or interests the audience rows name, sorted. */
const audienceIds = (data: PartsData, path: string): string[] => {
  const ids = new Set<string>();
  for (const [part, level] of [
    ["audiences", "campaign"],
    ["ad_group_audiences", "ad_group"],
  ] as const)
    for (const row of data[part] ?? []) {
      const v = idFromResourceName(get(row, `${critOf(level)}.${path}`));
      if (v && /^\d{1,20}$/.test(v)) ids.add(v);
    }
  return [...ids].sort();
};

const mapAudience = (
  row: Row,
  level: "campaign" | "ad_group",
  names: ReadonlyMap<string, Untrusted>,
): SegmentRow | null => {
  const c = critOf(level);
  const campaignId = id(get(row, "campaign.id"));
  const criterionId = id(get(row, `${c}.criterionId`));
  if (!campaignId || !criterionId) return null;
  // names are kept per kind: a custom segment and an interest can share an id
  const customId = idFromResourceName(get(row, `${c}.customAudience.customAudience`));
  const interestId = idFromResourceName(get(row, `${c}.userInterest.userInterestCategory`));
  const nameKey = customId ? `custom:${customId}` : interestId ? `interest:${interestId}` : null;
  return {
    kind: "audience",
    campaignId,
    adGroupId: level === "ad_group" ? id(get(row, "adGroup.id")) : null,
    criterionId,
    value: null,
    audienceType: enumValue(get(row, `${c}.type`)),
    userListId: idFromResourceName(get(row, `${c}.userList.userList`)),
    audienceName: nameKey ? (names.get(nameKey) ?? null) : null,
    metrics: metrics(row),
  };
};

const KIND_ORDER: Record<SegmentRow["kind"], number> = { age: 0, gender: 1, audience: 2 };

export const segmentPerformanceReader: ReaderDef<FilterInput, SegmentRow, SegmentSummary, null> = {
  name: "segment_performance",
  queries: (input) => ({
    ages: { gaql: ageQuery(input), limit: SEGMENT_CAP },
    genders: { gaql: genderQuery(input), limit: SEGMENT_CAP },
    audiences: { gaql: campaignAudienceQuery(input) },
    ad_group_audiences: { gaql: adGroupAudienceQuery(input), limit: SEGMENT_CAP },
  }),
  // N7: custom segments and interests come back as resource names only: read their names
  followUp: (_input, _ctx, data) => {
    const parts: Record<string, Part> = {};
    const custom = audienceIds(data, "customAudience.customAudience");
    if (custom.length)
      parts.custom_audience_names = namesPart(custom, "custom audience", customAudienceNamesQuery);
    const interests = audienceIds(data, "userInterest.userInterestCategory");
    if (interests.length)
      parts.interest_names = namesPart(interests, "interest", interestNamesQuery);
    return parts;
  },
  map: (data) => {
    const names = new Map<string, Untrusted>();
    for (const row of data.custom_audience_names ?? []) {
      const v = id(get(row, "customAudience.id"));
      if (v) names.set(`custom:${v}`, text(get(row, "customAudience.name")));
    }
    for (const row of data.interest_names ?? []) {
      const v = id(get(row, "userInterest.userInterestId"));
      if (v) names.set(`interest:${v}`, text(get(row, "userInterest.name")));
    }
    return {
      rows: [
        ...(data.ages ?? []).map((r) => mapDemo(r, "age")),
        ...(data.genders ?? []).map((r) => mapDemo(r, "gender")),
        ...(data.audiences ?? []).map((r) => mapAudience(r, "campaign", names)),
        ...(data.ad_group_audiences ?? []).map((r) => mapAudience(r, "ad_group", names)),
      ].filter((r): r is SegmentRow => r !== null),
      extra: null,
    };
  },
  compare: (a, b) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.campaignId.localeCompare(b.campaignId) ||
    (a.adGroupId ?? "").localeCompare(b.adGroupId ?? "") ||
    (a.criterionId ?? "").localeCompare(b.criterionId ?? ""),
  summarise: (rows, _extra, _ctx, _input, parts) => {
    const n = (kind: SegmentRow["kind"], part: string) =>
      partOk(parts, part) ? rows.filter((r) => r.kind === kind).length : null;
    return {
      ageRows: n("age", "ages"),
      genderRows: n("gender", "genders"),
      audienceRows:
        partOk(parts, "audiences") && partOk(parts, "ad_group_audiences")
          ? rows.filter((r) => r.kind === "audience").length
          : null,
    };
  },
  summaryLine: (s, ctx, input) =>
    `Segment performance on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${s.ageRows === null ? "ages unknown" : plural(s.ageRows, "age row")}, ${s.genderRows === null ? "genders unknown" : plural(s.genderRows, "gender row")}, ${s.audienceRows === null ? "audiences unknown" : plural(s.audienceRows, "audience row")}.`,
  rowLine: (r) =>
    `${r.kind} campaign ${r.campaignId} ${r.value ?? r.criterionId ?? ""}: ${r.metrics.clicks} clicks`,
};
