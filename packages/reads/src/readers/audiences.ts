// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Ported from PerfoAds buildAudienceListQuery/audienceListRows (user_list: type, membership
// status, sizes; a refused field retries with fewer fields), fetchCampaignAudiencePerformance
// (campaign_audience_view metrics per campaign criterion) and CRITERION_BID_MODIFIER_QUERY
// (campaign_criterion USER_LIST / USER_INTEREST). Changes: targeting read from the criteria
// themselves (campaign_criterion + ad_group_criterion, exclusions included), metrics in their
// own queries (campaign_audience_view + ad_group_audience_view; failed = null, never zero),
// no impressions/cost filter on the targeting, size buckets added, rule definitions not read.

import * as z from "zod";
import {
  checkChoice,
  countBy,
  idConditions,
  MetricsSchema,
  plural,
  shown,
  filterConditions,
  where,
  type FilterInput,
} from "../common.js";
import {
  boolOrNull,
  byMoneyDesc,
  enumValue,
  get,
  id,
  idFromResourceName,
  metrics,
  numberOrNull,
  text,
  textOrNull,
  ZERO_METRICS,
  type Metrics,
  type Row,
} from "../normalise.js";
import { partOk, type Part, type PartsData, type PartStatus, type ReaderDef } from "../reader.js";
import { UntrustedSchema, type Untrusted } from "../untrusted.js";

export const AUDIENCE_KINDS = ["lists", "targeting"] as const;

export interface AudiencesInput extends FilterInput {
  kind: (typeof AUDIENCE_KINDS)[number] | null;
}

export const audiencesInput = (filters: FilterInput, kind: unknown): AudiencesInput => ({
  ...filters,
  kind: checkChoice(kind, AUDIENCE_KINDS, "kind"),
});

export const UserListDetailSchema = z.object({
  type: z.string().nullable(),
  membershipStatus: z.string().nullable(),
  sizeForDisplay: z.number().nullable(),
  sizeForSearch: z.number().nullable(),
  sizeRangeForDisplay: z.string().nullable().describe("Google's size bucket; null = not read"),
  sizeRangeForSearch: z.string().nullable(),
  eligibleForSearch: z.boolean().nullable(),
  eligibleForDisplay: z.boolean().nullable(),
  lifeSpanDays: z.number().nullable(),
  usedBy: z
    .number()
    .nullable()
    .describe("Campaign/ad group criteria targeting it (signals not checked); null = unknown"),
});

export const AudienceRowSchema = z.object({
  kind: z.enum(["user_list", "targeting"]),
  level: z.enum(["account", "campaign", "ad_group"]),
  campaignId: z.string().nullable(),
  campaignName: UntrustedSchema.nullable(),
  adGroupId: z.string().nullable(),
  adGroupName: UntrustedSchema.nullable(),
  criterionId: z.string().nullable(),
  audienceType: z.string().nullable().describe("USER_LIST, USER_INTEREST, CUSTOM_AUDIENCE, ..."),
  audienceId: z.string().nullable(),
  name: UntrustedSchema.nullable(),
  negative: z.boolean().nullable().describe("true = exclusion"),
  status: z.string().nullable(),
  bidModifier: z.number().nullable(),
  userList: UserListDetailSchema.nullable(),
  metrics: MetricsSchema.nullable().describe("Targeting only; null = unknown (not read)"),
});
export type AudienceRow = z.infer<typeof AudienceRowSchema>;

export const AudienceSummarySchema = z.object({
  userLists: z.number().nullable(),
  listsByType: z.record(z.string(), z.number()),
  listsByMembershipStatus: z.record(z.string(), z.number()),
  notTargetedByCriteria: z
    .number()
    .nullable()
    .describe(
      "Open lists not targeted by any campaign or ad group criterion (audience signals and combined audiences not checked)",
    ),
  targeting: z.number(),
  exclusions: z.number(),
  targetingByType: z.record(z.string(), z.number()),
  campaignsWithAudiences: z.number().nullable(),
  metricsRead: z.boolean(),
});
export type AudienceSummary = z.infer<typeof AudienceSummarySchema>;

const SIZE_FIELDS = `
      user_list.size_range_for_display,
      user_list.size_range_for_search,
      user_list.eligible_for_search,
      user_list.eligible_for_display,`;

export const userListsQuery = (full: boolean): string => `
    SELECT
      user_list.id,
      user_list.name,
      user_list.type,
      user_list.membership_status,
      user_list.size_for_display,
      user_list.size_for_search,${full ? SIZE_FIELDS : ""}
      user_list.membership_life_span
    FROM user_list
    ORDER BY user_list.id`;

const AUDIENCE_TYPES = "('USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE')";

const audienceFields = (r: string) => `
      ${r}.criterion_id,
      ${r}.type,
      ${r}.negative,
      ${r}.status,
      ${r}.bid_modifier,
      ${r}.user_list.user_list,
      ${r}.user_interest.user_interest_category,
      ${r}.custom_audience.custom_audience,
      ${r}.combined_audience.combined_audience`;

export const campaignAudiencesQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      campaign.name,${audienceFields("campaign_criterion")}
    FROM campaign_criterion
    ${where([
      "campaign.status != 'REMOVED'",
      "campaign_criterion.status != 'REMOVED'",
      `campaign_criterion.type IN ${AUDIENCE_TYPES}`,
      ...idConditions({ campaignId: input.campaignId, adGroupId: null }),
    ])}
    ORDER BY campaign.id, campaign_criterion.criterion_id`;

export const adGroupAudiencesQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,${audienceFields("ad_group_criterion")}
    FROM ad_group_criterion
    ${where([
      "campaign.status != 'REMOVED'",
      "ad_group.status != 'REMOVED'",
      "ad_group_criterion.status != 'REMOVED'",
      `ad_group_criterion.type IN ${AUDIENCE_TYPES}`,
      ...idConditions(input),
    ])}
    ORDER BY ad_group.id, ad_group_criterion.criterion_id`;

const METRIC_FIELDS = `
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value`;

export const campaignAudienceMetricsQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      campaign_criterion.criterion_id,${METRIC_FIELDS}
    FROM campaign_audience_view
    ${where(filterConditions({ ...input, adGroupId: null, status: null }, null))}
    ORDER BY metrics.cost_micros DESC`;

export const adGroupAudienceMetricsQuery = (input: FilterInput): string => `
    SELECT
      ad_group.id,
      ad_group_criterion.criterion_id,${METRIC_FIELDS}
    FROM ad_group_audience_view
    ${where(filterConditions({ ...input, status: null }, null))}
    ORDER BY metrics.cost_micros DESC`;

/** Most interests or custom audiences named in one read (ids beyond keep a null name). */
export const AUDIENCE_NAMES_MAX = 1_000;

export const interestNamesQuery = (ids: readonly string[]): string => `
    SELECT
      user_interest.user_interest_id,
      user_interest.name
    FROM user_interest
    WHERE user_interest.user_interest_id IN (${ids.join(", ")})`;

export const customAudienceNamesQuery = (ids: readonly string[]): string => `
    SELECT
      custom_audience.id,
      custom_audience.name
    FROM custom_audience
    WHERE custom_audience.id IN (${ids.join(", ")})`;

/** Ids (digits only) of the targeted audiences at one criterion path, sorted. */
const targetedIds = (data: PartsData, path: string): string[] => {
  const ids = new Set<string>();
  for (const [part, r] of [
    ["campaign_targeting", "campaignCriterion"],
    ["ad_group_targeting", "adGroupCriterion"],
  ] as const) {
    for (const row of data[part] ?? []) {
      const v = idFromResourceName(get(row, `${r}.${path}`));
      if (v && /^\d{1,20}$/.test(v)) ids.add(v);
    }
  }
  return [...ids].sort();
};

/** A names read: optional (rows stand without names), first AUDIENCE_NAMES_MAX ids. */
export const namesPart = (
  ids: readonly string[],
  one: "interest" | "custom audience",
  query: (ids: readonly string[]) => string,
): Part => {
  const named = ids.slice(0, AUDIENCE_NAMES_MAX);
  const kind = `${one}s`;
  const Kind = one.charAt(0).toUpperCase() + one.slice(1);
  const over = ids.length - named.length;
  return {
    gaql: query(named),
    optional: `${Kind} names were not read, so those audiences show without a name; rows and totals are complete.`,
    ...(over > 0
      ? {
          note: `${ids.length.toLocaleString("en-US")} ${kind} are targeted; only the first ${AUDIENCE_NAMES_MAX.toLocaleString("en-US")} are named, so ${over.toLocaleString("en-US")} show without a name.`,
        }
      : {}),
  };
};

const partOf = (parts: readonly PartStatus[], name: string) => parts.find((p) => p.part === name);

const targetingRow = (
  row: Row,
  level: "campaign" | "ad_group",
  names: ReadonlyMap<string, Untrusted>,
  metricsBy: ReadonlyMap<string, Metrics> | null,
): AudienceRow | null => {
  const r = level === "campaign" ? "campaignCriterion" : "adGroupCriterion";
  const c = (path: string) => get(row, `${r}.${path}`);
  const criterionId = id(c("criterionId"));
  const campaignId = id(get(row, "campaign.id"));
  const adGroupId = level === "ad_group" ? id(get(row, "adGroup.id")) : null;
  if (!criterionId) return null;
  const listId = idFromResourceName(c("userList.userList"));
  const customId = idFromResourceName(c("customAudience.customAudience"));
  const interestId = idFromResourceName(c("userInterest.userInterestCategory"));
  const audienceId =
    listId ?? customId ?? idFromResourceName(c("combinedAudience.combinedAudience")) ?? interestId;
  // names are read per kind: a list, an interest and a custom audience can share an id
  const nameKey = listId
    ? `list:${listId}`
    : customId
      ? `custom:${customId}`
      : interestId
        ? `interest:${interestId}`
        : null;
  const key = `${level}|${level === "campaign" ? campaignId : adGroupId}|${criterionId}`;
  return {
    kind: "targeting",
    level,
    campaignId,
    campaignName: textOrNull(get(row, "campaign.name")),
    adGroupId,
    adGroupName: level === "ad_group" ? textOrNull(get(row, "adGroup.name")) : null,
    criterionId,
    audienceType: enumValue(c("type")),
    audienceId,
    name: nameKey ? (names.get(nameKey) ?? null) : null,
    negative: boolOrNull(c("negative")),
    status: enumValue(c("status")),
    bidModifier: numberOrNull(c("bidModifier")),
    userList: null,
    metrics: metricsBy === null ? null : (metricsBy.get(key) ?? ZERO_METRICS),
  };
};

export const audiencesReader: ReaderDef<
  AudiencesInput,
  AudienceRow,
  AudienceSummary,
  null,
  { lists: AudienceRow[] }
> = {
  name: "audiences",
  queries: (input) => {
    // Lists are read for targeting too: their names label the criteria.
    const parts: Record<string, { gaql: string; fallback?: string }> = {
      user_lists: { gaql: userListsQuery(true), fallback: userListsQuery(false) },
    };
    if (input.kind !== "lists") {
      if (!input.adGroupId) {
        parts.campaign_targeting = { gaql: campaignAudiencesQuery(input) };
        parts.campaign_metrics = { gaql: campaignAudienceMetricsQuery(input) };
      }
      parts.ad_group_targeting = { gaql: adGroupAudiencesQuery(input) };
      parts.ad_group_metrics = { gaql: adGroupAudienceMetricsQuery(input) };
    }
    return parts;
  },
  // Interests and custom audiences come back as resource names only: read their names.
  followUp: (input, _ctx, data) => {
    const parts: Record<string, Part> = {};
    if (input.kind === "lists") return parts;
    const interests = targetedIds(data, "userInterest.userInterestCategory");
    if (interests.length)
      parts.interest_names = namesPart(interests, "interest", interestNamesQuery);
    const custom = targetedIds(data, "customAudience.customAudience");
    if (custom.length)
      parts.custom_audience_names = namesPart(custom, "custom audience", customAudienceNamesQuery);
    return parts;
  },
  map: (data, input, _ctx, parts) => {
    const names = new Map<string, Untrusted>();
    for (const row of data.user_lists ?? []) {
      const listId = id(get(row, "userList.id"));
      if (listId) names.set(`list:${listId}`, text(get(row, "userList.name")));
    }
    for (const row of data.interest_names ?? []) {
      const v = id(get(row, "userInterest.userInterestId"));
      if (v) names.set(`interest:${v}`, text(get(row, "userInterest.name")));
    }
    for (const row of data.custom_audience_names ?? []) {
      const v = id(get(row, "customAudience.id"));
      if (v) names.set(`custom:${v}`, text(get(row, "customAudience.name")));
    }
    const metricsBy = new Map<string, Metrics>();
    for (const row of data.campaign_metrics ?? []) {
      const key = `campaign|${id(get(row, "campaign.id"))}|${id(get(row, "campaignCriterion.criterionId"))}`;
      metricsBy.set(key, metrics(row));
    }
    for (const row of data.ad_group_metrics ?? []) {
      const key = `ad_group|${id(get(row, "adGroup.id"))}|${id(get(row, "adGroupCriterion.criterionId"))}`;
      metricsBy.set(key, metrics(row));
    }
    const campaignMetricsOk = partOk(parts, "campaign_metrics");
    const adGroupMetricsOk = partOk(parts, "ad_group_metrics");

    const rows: AudienceRow[] = [];
    for (const row of data.campaign_targeting ?? []) {
      const r = targetingRow(row, "campaign", names, campaignMetricsOk ? metricsBy : null);
      if (r) rows.push(r);
    }
    for (const row of data.ad_group_targeting ?? []) {
      const r = targetingRow(row, "ad_group", names, adGroupMetricsOk ? metricsBy : null);
      if (r) rows.push(r);
    }

    const targetingKnown =
      input.kind !== "lists" &&
      !input.campaignId &&
      !input.adGroupId &&
      partOk(parts, "campaign_targeting") &&
      partOk(parts, "ad_group_targeting");
    const used = new Map<string, number>();
    for (const r of rows) {
      if (r.audienceType === "USER_LIST" && r.audienceId) {
        used.set(r.audienceId, (used.get(r.audienceId) ?? 0) + 1);
      }
    }
    // Lists are read for every view; the targeting view counts them without listing them.
    const lists: AudienceRow[] = [];
    const sizesRead = partOf(parts, "user_lists")?.fallback !== true;
    for (const row of data.user_lists ?? []) {
      const u = (path: string) => get(row, `userList.${path}`);
      const listId = id(u("id"));
      if (!listId) continue;
      lists.push({
        kind: "user_list",
        level: "account",
        campaignId: null,
        campaignName: null,
        adGroupId: null,
        adGroupName: null,
        criterionId: null,
        audienceType: "USER_LIST",
        audienceId: listId,
        name: text(u("name")),
        negative: null,
        status: null,
        bidModifier: null,
        userList: {
          type: enumValue(u("type")),
          membershipStatus: enumValue(u("membershipStatus")),
          sizeForDisplay: numberOrNull(u("sizeForDisplay")),
          sizeForSearch: numberOrNull(u("sizeForSearch")),
          sizeRangeForDisplay: sizesRead ? enumValue(u("sizeRangeForDisplay")) : null,
          sizeRangeForSearch: sizesRead ? enumValue(u("sizeRangeForSearch")) : null,
          eligibleForSearch: sizesRead ? boolOrNull(u("eligibleForSearch")) : null,
          eligibleForDisplay: sizesRead ? boolOrNull(u("eligibleForDisplay")) : null,
          lifeSpanDays: numberOrNull(u("membershipLifeSpan")),
          usedBy: targetingKnown ? (used.get(listId) ?? 0) : null,
        },
        metrics: null,
      });
    }
    return {
      rows: input.kind === "targeting" ? rows : [...rows, ...lists],
      extra: null,
      facts: { lists },
    };
  },
  compare: (a, b) =>
    (a.kind === b.kind ? 0 : a.kind === "targeting" ? -1 : 1) ||
    (a.metrics && b.metrics ? byMoneyDesc(a.metrics.cost, b.metrics.cost) : 0) ||
    (b.userList?.sizeForSearch ?? -1) - (a.userList?.sizeForSearch ?? -1) ||
    (a.campaignId ?? "").localeCompare(b.campaignId ?? "") ||
    (a.adGroupId ?? "").localeCompare(b.adGroupId ?? "") ||
    (a.criterionId ?? "").localeCompare(b.criterionId ?? "") ||
    (a.audienceId ?? "").localeCompare(b.audienceId ?? ""),
  summarise: (rows, _extra, _ctx, input, parts, facts) => {
    const lists = facts?.lists ?? [];
    const targeting = rows.filter((r) => r.kind === "targeting");
    const listsOk = partOk(parts, "user_lists");
    const campaignsKnown =
      input.kind !== "lists" &&
      (!partOf(parts, "campaign_targeting") || partOk(parts, "campaign_targeting")) &&
      partOk(parts, "ad_group_targeting");
    return {
      userLists: listsOk ? lists.length : null,
      listsByType: countBy(lists, (r) => r.userList?.type ?? null),
      listsByMembershipStatus: countBy(lists, (r) => r.userList?.membershipStatus ?? null),
      // usedBy is only known when every campaign and ad group criterion was read (no filter).
      notTargetedByCriteria:
        listsOk && lists.every((l) => l.userList?.usedBy !== null)
          ? lists.filter((l) => l.userList?.membershipStatus === "OPEN" && l.userList.usedBy === 0)
              .length
          : null,
      targeting: targeting.filter((r) => r.negative !== true).length,
      exclusions: targeting.filter((r) => r.negative === true).length,
      targetingByType: countBy(targeting, (r) => r.audienceType),
      campaignsWithAudiences: campaignsKnown
        ? new Set(targeting.map((r) => r.campaignId).filter((c) => c !== null)).size
        : null,
      metricsRead:
        input.kind !== "lists" &&
        (!partOf(parts, "campaign_metrics") || partOk(parts, "campaign_metrics")) &&
        partOk(parts, "ad_group_metrics"),
    };
  },
  summaryLine: (s, ctx) =>
    `${s.userLists === null ? "User lists: not read" : plural(s.userLists, "user list")} on ${ctx.customerId} (open, not targeted by any criterion: ${s.notTargetedByCriteria ?? "unknown"}); ${plural(s.targeting, "audience target")}, ${plural(s.exclusions, "exclusion")}.`,
  rowLine: (r, ctx) => {
    if (r.kind === "user_list") {
      const u = r.userList;
      return `list ${r.audienceId ?? "?"} ${shown(r.name)} ${u?.type ?? "?"}, ${u?.membershipStatus ?? "?"}, search size ${u?.sizeForSearch ?? "?"}, used by ${u?.usedBy ?? "unknown"}`;
    }
    const place =
      r.level === "campaign" ? `campaign ${r.campaignId ?? "?"}` : `ad group ${r.adGroupId ?? "?"}`;
    return `${r.negative ? "exclusion" : "target"} ${r.audienceType ?? "?"} ${r.audienceId ?? "?"}${r.name ? ` ${shown(r.name)}` : ""} on ${place}${r.metrics ? `: cost ${r.metrics.cost}${ctx.currencyCode ? ` ${ctx.currencyCode}` : ""}, ${plural(r.metrics.clicks, "click")}` : ": metrics unknown"}`;
  },
};
