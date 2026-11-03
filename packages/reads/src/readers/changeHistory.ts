// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Ported from PerfoAds fetchChangeHistory (change_event: when, what, who, how, which fields;
// explicit dates because Google refuses a start older than 30 days and DURING LAST_30_DAYS
// can cross that line; ORDER BY change time; LIMIT at Google's maximum of 10,000).
// Changes: at most 28 days, counted in the account's time zone (inside Google's 30), end
// date = tomorrow there so today's changes are in; the user is shown as "user at <domain>" only (PerfoAds kept
// part of the address); two change_event queries: one WITH old/new values for the types in
// VALUE_SLOTS (campaign, budget, ad group, ad group criterion, campaign criterion), one
// without values for every other type (ads and assets carry whole texts: rows stay small).
// Values are kept only at the changed field paths: numbers and booleans plain; a string plain
// only when it is digits (ids, micros) or the value of a known enum field (VALUE_ENUM_FIELDS);
// any other text wrapped and cut at 300 characters. Google refusing the value fields = the
// first query is read again without them (values unknown). When neither change_event query
// can be read, change_status (what changed, not who) is read instead.
// Portfolio (shared) bid strategies: v26 change_event has no BIDDING_STRATEGY resource type
// (ChangeEventResourceType / ChangedResource, checked 2026-10-25), so a change to a shared
// strategy's target is not in the change history at all. The checks treat campaigns on a
// shared strategy as "changes unknown" (checks: BB16, BB17).

import * as z from "zod";
import { checkChoice, checkId, countBy, plural, where } from "../common.js";
import { ReadInputError } from "../dateRange.js";
import {
  dateTime,
  enumValue,
  get,
  idFromResourceName,
  idsFromResourceName,
  type Row,
} from "../normalise.js";
import type { ReaderDef } from "../reader.js";
import { UntrustedSchema, untrustedText } from "../untrusted.js";

/** Google keeps 30 days of change_event; 28 stays inside that in every time zone. */
export const MAX_CHANGE_DAYS = 28;
export const DEFAULT_CHANGE_DAYS = 14;
/** Google's LIMIT maximum for change_event and change_status. */
const GOOGLE_CHANGE_LIMIT = 10_000;

export const CHANGE_RESOURCE_TYPES = [
  "AD",
  "AD_GROUP",
  "AD_GROUP_AD",
  "AD_GROUP_ASSET",
  "AD_GROUP_BID_MODIFIER",
  "AD_GROUP_CRITERION",
  "ASSET",
  "ASSET_GROUP",
  "CAMPAIGN",
  "CAMPAIGN_ASSET",
  "CAMPAIGN_BUDGET",
  "CAMPAIGN_CRITERION",
  "CUSTOMER_ASSET",
] as const;
type ChangeResourceType = (typeof CHANGE_RESOURCE_TYPES)[number];

/** v26 ChangeEventResourceType values (change_event.change_resource_type). */
export const CHANGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "AD",
  "AD_GROUP",
  "AD_GROUP_AD",
  "AD_GROUP_ASSET",
  "AD_GROUP_BID_MODIFIER",
  "AD_GROUP_CRITERION",
  "AD_GROUP_FEED",
  "ASSET",
  "ASSET_SET",
  "ASSET_SET_ASSET",
  "CAMPAIGN",
  "CAMPAIGN_ASSET",
  "CAMPAIGN_ASSET_SET",
  "CAMPAIGN_BUDGET",
  "CAMPAIGN_CRITERION",
  "CAMPAIGN_FEED",
  "CUSTOMER_ASSET",
  "FEED",
  "FEED_ITEM",
]);

/** v26 ChangeStatusResourceType values (change_status.resource_type). */
export const CHANGE_STATUS_TYPES: ReadonlySet<string> = new Set([
  "AD_GROUP",
  "AD_GROUP_AD",
  "AD_GROUP_ASSET",
  "AD_GROUP_BID_MODIFIER",
  "AD_GROUP_CRITERION",
  "AD_GROUP_FEED",
  "ASSET",
  "ASSET_GROUP",
  "ASSET_SET",
  "CAMPAIGN",
  "CAMPAIGN_ASSET",
  "CAMPAIGN_ASSET_SET",
  "CAMPAIGN_BUDGET",
  "CAMPAIGN_CRITERION",
  "CAMPAIGN_FEED",
  "CAMPAIGN_SHARED_SET",
  "COMBINED_AUDIENCE",
  "CUSTOMER_ASSET",
  "FEED",
  "FEED_ITEM",
  "SHARED_SET",
]);

/** The change_event filter value, or null when change_event has no such type (ASSET_GROUP). */
export const changeEventType = (t: ChangeResourceType): string | null =>
  CHANGE_EVENT_TYPES.has(t) ? t : null;

/** The change_status filter value: ad edits show up there as AD_GROUP_AD. */
export const changeStatusType = (t: ChangeResourceType): string | null => {
  const v = t === "AD" ? "AD_GROUP_AD" : t;
  return CHANGE_STATUS_TYPES.has(v) ? v : null;
};

export interface ChangeHistoryInput {
  days: number;
  startDate: string;
  /** Exclusive end: tomorrow in the account's time zone, so every change made today is in. */
  endDate: string;
  /** The last day asked for (today; without a known zone, today in UTC). endDate may run past it. */
  lastDay: string;
  campaignId: string | null;
  resourceType: (typeof CHANGE_RESOURCE_TYPES)[number] | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => ymd(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);

/** Today's date in a time zone (YYYY-MM-DD), or null when the zone is unknown. */
const localToday = (now: number, timeZone: string | null): string | null => {
  if (!timeZone) return null;
  try {
    const d = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now));
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  } catch {
    return null;
  }
};

/**
 * Raw tool input -> checked input. Throws ReadInputError with a plain reason.
 * Dates are the account's local days (Google compares change times in the account's zone).
 * Without a known zone: start from UTC's date (a later or equal local midnight in every zone
 * west of UTC, at most 14 h earlier east of it: still inside 30 days) and end 2 days ahead.
 */
export const changeHistoryInput = (
  raw: {
    days?: number | undefined;
    campaign_id?: string | undefined;
    resource_type?: string | undefined;
  },
  now: number,
  timeZone: string | null = null,
): ChangeHistoryInput => {
  const days = raw.days ?? DEFAULT_CHANGE_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_CHANGE_DAYS) {
    throw new ReadInputError(
      `days must be 1 to ${MAX_CHANGE_DAYS}. Google keeps change history for 30 days only.`,
    );
  }
  const today = localToday(now, timeZone);
  return {
    days,
    startDate: addDays(today ?? ymd(now), -days),
    endDate: addDays(today ?? ymd(now), today ? 1 : 2),
    lastDay: today ?? ymd(now),
    campaignId: checkId(raw.campaign_id, "campaign_id"),
    resourceType: checkChoice(raw.resource_type, CHANGE_RESOURCE_TYPES, "resource_type"),
  };
};

const checkWindow = (input: ChangeHistoryInput, customerId: string) => {
  const ok = /^\d{4}-\d{2}-\d{2}$/;
  if (!ok.test(input.startDate) || !ok.test(input.endDate) || !/^\d{1,20}$/.test(customerId)) {
    throw new ReadInputError("The change history window is not valid.");
  }
  const span = (Date.parse(input.endDate) - Date.parse(input.startDate)) / DAY_MS;
  if (!(span >= 1 && span <= MAX_CHANGE_DAYS + 2)) {
    throw new ReadInputError(`The change history window must be 1 to ${MAX_CHANGE_DAYS} days.`);
  }
  return {
    campaignId: checkId(input.campaignId ?? undefined, "campaign_id"),
    resourceType: checkChoice(input.resourceType, CHANGE_RESOURCE_TYPES, "resource_type"),
  };
};

/** change_event resource type -> its slot in ChangedResource (REST camelCase), for old/new values. */
export const VALUE_SLOTS: Readonly<Record<string, string>> = {
  CAMPAIGN: "campaign",
  CAMPAIGN_BUDGET: "campaignBudget",
  AD_GROUP: "adGroup",
  AD_GROUP_CRITERION: "adGroupCriterion",
  CAMPAIGN_CRITERION: "campaignCriterion",
};
const VALUE_TYPES_IN = Object.keys(VALUE_SLOTS)
  .map((t) => `'${t}'`)
  .join(", ");

/** Field names (last path key, camelCase) whose values are enums in these resources. */
export const VALUE_ENUM_FIELDS: ReadonlySet<string> = new Set([
  "status",
  "type",
  "biddingStrategyType",
  "advertisingChannelType",
  "advertisingChannelSubType",
  "servingStatus",
  "matchType",
  "deliveryMethod",
  "period",
  "positiveGeoTargetType",
  "negativeGeoTargetType",
  "adRotationMode",
  "device",
  "dayOfWeek",
  "startMinute",
  "endMinute",
  "primaryStatus",
  "approvalStatus",
]);

/**
 * One change_event query. `withValues` adds old/new values; `types` = "values" keeps the
 * VALUE_SLOTS types, "rest" every other type, "all" no type split (a type filter given).
 */
export const changeEventsQuery = (
  input: ChangeHistoryInput,
  customerId: string,
  withValues = true,
  types: "values" | "rest" | "all" = "all",
): string => {
  const { campaignId, resourceType: t } = checkWindow(input, customerId);
  const resourceType = t ? changeEventType(t) : null;
  if (t && !resourceType) throw new ReadInputError(`change_event has no ${t} type.`);
  const split =
    types === "values"
      ? [`change_event.change_resource_type IN (${VALUE_TYPES_IN})`]
      : types === "rest"
        ? [`change_event.change_resource_type NOT IN (${VALUE_TYPES_IN})`]
        : [];
  return `
    SELECT
      change_event.change_date_time,
      change_event.change_resource_type,
      change_event.change_resource_name,
      change_event.client_type,
      change_event.user_email,
      change_event.resource_change_operation,
      change_event.changed_fields,
      change_event.campaign,
      change_event.ad_group${withValues ? ",\n      change_event.old_resource,\n      change_event.new_resource" : ""}
    FROM change_event
    ${where([
      `change_event.change_date_time >= '${input.startDate}'`,
      `change_event.change_date_time < '${input.endDate}'`,
      ...(resourceType ? [`change_event.change_resource_type = '${resourceType}'`] : []),
      ...split,
      ...(campaignId
        ? [`change_event.campaign = 'customers/${customerId}/campaigns/${campaignId}'`]
        : []),
    ])}
    ORDER BY change_event.change_date_time DESC`;
};

/**
 * change_status fields naming the changed resource (v26), most specific first, with the
 * resource types they stand for. change_status.resource_name is the change's own name.
 */
const STATUS_RESOURCE_FIELDS: readonly (readonly [string, string, readonly string[]])[] = [
  ["ad_group_ad", "adGroupAd", ["AD_GROUP_AD"]],
  ["ad_group_criterion", "adGroupCriterion", ["AD_GROUP_CRITERION"]],
  ["ad_group_bid_modifier", "adGroupBidModifier", ["AD_GROUP_BID_MODIFIER"]],
  ["ad_group_asset", "adGroupAsset", ["AD_GROUP_ASSET"]],
  ["campaign_criterion", "campaignCriterion", ["CAMPAIGN_CRITERION"]],
  ["campaign_asset", "campaignAsset", ["CAMPAIGN_ASSET"]],
  ["campaign_asset_set", "campaignAssetSet", ["CAMPAIGN_ASSET_SET"]],
  ["campaign_shared_set", "campaignSharedSet", ["CAMPAIGN_SHARED_SET"]],
  ["customer_asset", "customerAsset", ["CUSTOMER_ASSET"]],
  ["asset_group", "assetGroup", ["ASSET_GROUP"]],
  ["asset_set", "assetSet", ["ASSET_SET"]],
  ["asset", "asset", ["ASSET"]],
  ["campaign_budget", "campaignBudget", ["CAMPAIGN_BUDGET"]],
  ["shared_set", "sharedSet", ["SHARED_SET"]],
  ["combined_audience", "combinedAudience", ["COMBINED_AUDIENCE"]],
  ["ad_group", "adGroup", ["AD_GROUP"]],
  ["campaign", "campaign", ["CAMPAIGN"]],
];

/** Ids of the changed resource: the field for its type, else the most specific one set. */
const statusResourceIds = (row: Row): string[] => {
  const type = enumValue(get(row, "changeStatus.resourceType"));
  const ids = (key: string) => idsFromResourceName(get(row, `changeStatus.${key}`));
  const own = STATUS_RESOURCE_FIELDS.find(([, , types]) => type !== null && types.includes(type));
  if (own && ids(own[1]).length) return ids(own[1]);
  for (const [, key] of STATUS_RESOURCE_FIELDS) {
    const found = ids(key);
    if (found.length) return found;
  }
  return [];
};

export const changeStatusQuery = (input: ChangeHistoryInput, customerId: string): string => {
  const { campaignId, resourceType: t } = checkWindow(input, customerId);
  const resourceType = t ? changeStatusType(t) : null;
  if (t && !resourceType) throw new ReadInputError(`change_status has no ${t} type.`);
  return `
    SELECT
      change_status.resource_name,
      change_status.last_change_date_time,
      change_status.resource_type,
      change_status.resource_status,
${STATUS_RESOURCE_FIELDS.map(([f]) => `      change_status.${f}`).join(",\n")}
    FROM change_status
    ${where([
      `change_status.last_change_date_time >= '${input.startDate}'`,
      `change_status.last_change_date_time < '${input.endDate}'`,
      ...(resourceType ? [`change_status.resource_type = '${resourceType}'`] : []),
      ...(campaignId
        ? [`change_status.campaign = 'customers/${customerId}/campaigns/${campaignId}'`]
        : []),
    ])}
    ORDER BY change_status.last_change_date_time DESC`;
};

/** "someone@example.com" -> "user at example.com". Never the address itself. */
export const maskEmail = (v: unknown): string | null => {
  if (typeof v !== "string" || v.trim() === "") return null;
  const m = /^[^@\s]+@([A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+)$/.exec(v.trim());
  return m?.[1] ? `user at ${m[1].toLowerCase().slice(0, 100)}` : "not an email address (hidden)";
};

/** changed_fields is a comma-separated field mask: keep field paths only. */
const fieldList = (v: unknown): string[] =>
  typeof v === "string"
    ? v
        .split(",")
        .map((f) => f.trim())
        .filter((f) => /^[A-Za-z][A-Za-z0-9_.]{0,100}$/.test(f))
        .slice(0, 30)
    : [];

const ChangeValueSchema = z.union([z.string(), z.number(), z.boolean(), UntrustedSchema, z.null()]);
type ChangeValue = z.infer<typeof ChangeValueSchema>;

/**
 * A changed value. Numbers and booleans plain. A string is plain only when it is digits
 * (ids, micros) or the value of a known enum field in enum shape; every other string is
 * wrapped and cut at 300 characters. Objects and lists are left out (null).
 */
const changeValue = (v: unknown, field: string): ChangeValue => {
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  if (/^-?\d{1,30}$/.test(v)) return v;
  const key = field.split(".").pop() ?? "";
  return VALUE_ENUM_FIELDS.has(key) && /^[A-Z][A-Z0-9_]{0,60}$/.test(v) ? v : untrustedText(v);
};

/** Old/new values at the changed field paths (only for VALUE_SLOTS types). */
const changedValuesOf = (
  row: Row,
  type: string | null,
  fields: readonly string[],
): ChangeRow["changedValues"] => {
  const slot = type ? VALUE_SLOTS[type] : undefined;
  if (!slot) return null;
  const out: NonNullable<ChangeRow["changedValues"]> = {};
  for (const f of fields) {
    out[f] = {
      old: changeValue(get(row, `changeEvent.oldResource.${slot}.${f}`), f),
      new: changeValue(get(row, `changeEvent.newResource.${slot}.${f}`), f),
    };
  }
  return out;
};

export const ChangeRowSchema = z.object({
  source: z.enum(["change_event", "change_status"]),
  changedAt: z.string().nullable().describe("Account time zone, YYYY-MM-DD HH:MM:SS"),
  resourceType: z.string().nullable(),
  resourceIds: z.array(z.string()).describe("Ids in the changed resource's name"),
  operation: z
    .string()
    .nullable()
    .describe("CREATE, UPDATE, REMOVE (change_status: ADDED, CHANGED, REMOVED)"),
  clientType: z.string().nullable().describe("GOOGLE_ADS_WEB_CLIENT, GOOGLE_ADS_API, ..."),
  user: z.string().nullable().describe('Masked: "user at example.com"'),
  changedFields: z.array(z.string()).describe("First 30"),
  changedValues: z
    .record(z.string(), z.object({ old: ChangeValueSchema, new: ChangeValueSchema }))
    .nullable()
    .describe(
      "Old and new value per changed field; campaign/budget/ad group/criterion only; null = not read",
    ),
  campaignId: z.string().nullable(),
  adGroupId: z.string().nullable(),
});
export type ChangeRow = z.infer<typeof ChangeRowSchema>;

export const ChangeSummarySchema = z.object({
  changes: z.number(),
  days: z.number(),
  source: z.enum(["change_event", "change_status", "none"]),
  byResourceType: z.record(z.string(), z.number()),
  byOperation: z.record(z.string(), z.number()),
  byClientType: z.record(z.string(), z.number()),
  byUser: z.record(z.string(), z.number()).describe("Masked users"),
  newest: z.string().nullable(),
  oldest: z.string().nullable(),
});
export type ChangeSummary = z.infer<typeof ChangeSummarySchema>;

const mapEvent = (row: Row, withValues: boolean): ChangeRow => {
  const e = (path: string) => get(row, `changeEvent.${path}`);
  const type = enumValue(e("changeResourceType"));
  const fields = fieldList(e("changedFields"));
  return {
    source: "change_event",
    changedAt: dateTime(e("changeDateTime")),
    resourceType: enumValue(e("changeResourceType")),
    resourceIds: idsFromResourceName(e("changeResourceName")),
    operation: enumValue(e("resourceChangeOperation")),
    clientType: enumValue(e("clientType")),
    user: maskEmail(e("userEmail")),
    changedFields: fields,
    changedValues: withValues ? changedValuesOf(row, type, fields) : null,
    campaignId: idFromResourceName(e("campaign")),
    adGroupId: idFromResourceName(e("adGroup")),
  };
};

const mapStatus = (row: Row): ChangeRow => {
  const c = (path: string) => get(row, `changeStatus.${path}`);
  return {
    source: "change_status",
    changedAt: dateTime(c("lastChangeDateTime")),
    resourceType: enumValue(c("resourceType")),
    resourceIds: statusResourceIds(row),
    operation: enumValue(c("resourceStatus")),
    clientType: null,
    user: null,
    changedFields: [],
    changedValues: null,
    campaignId: idFromResourceName(c("campaign")),
    adGroupId: idFromResourceName(c("adGroup")),
  };
};

export const changeHistoryReader: ReaderDef<ChangeHistoryInput, ChangeRow, ChangeSummary, null> = {
  name: "change_history",
  queries: (input, ctx) => {
    const t = input.resourceType;
    if (t && !changeEventType(t)) {
      const skipped = { skipped: `change_event has no ${t} type; change_status answers it.` };
      return { change_events: skipped, change_events_other: skipped };
    }
    const withValues = t === null || t in VALUE_SLOTS;
    const restToo = t === null || !(t in VALUE_SLOTS);
    const types = t === null ? "values" : "all";
    return {
      change_events: withValues
        ? {
            gaql: changeEventsQuery(input, ctx.customerId, true, types),
            // Google refusing old/new values: read again without them (values unknown)
            fallback: changeEventsQuery(input, ctx.customerId, false, types),
            limit: GOOGLE_CHANGE_LIMIT - 1,
          }
        : { skipped: `${t} changes carry no old/new values here; change_events_other reads them.` },
      change_events_other: restToo
        ? {
            gaql: changeEventsQuery(input, ctx.customerId, false, t === null ? "rest" : "all"),
            limit: GOOGLE_CHANGE_LIMIT - 1,
          }
        : { skipped: `${t} changes are read with their values by change_events.` },
    };
  },
  // change_status says what changed (not who or which fields) when change_event is refused
  // or has no such resource type.
  followUp: (input, ctx, data) =>
    data.change_events === undefined && data.change_events_other === undefined
      ? {
          change_status: {
            gaql: changeStatusQuery(input, ctx.customerId),
            limit: GOOGLE_CHANGE_LIMIT - 1,
          },
        }
      : {},
  map: (data, _input, _ctx, parts) => ({
    rows: [
      ...(data.change_events ?? []).map((r) =>
        mapEvent(r, parts.find((p) => p.part === "change_events")?.fallback !== true),
      ),
      ...(data.change_events_other ?? []).map((r) => mapEvent(r, false)),
      ...(data.change_status ?? []).map(mapStatus),
    ],
    extra: null,
  }),
  compare: (a, b) =>
    (b.changedAt ?? "").localeCompare(a.changedAt ?? "") ||
    (a.resourceType ?? "").localeCompare(b.resourceType ?? "") ||
    a.resourceIds.join("~").localeCompare(b.resourceIds.join("~")),
  summarise: (rows, _extra, _ctx, input, parts) => {
    const sorted = rows
      .map((r) => r.changedAt)
      .filter((d): d is string => d !== null)
      .sort();
    return {
      changes: rows.length,
      days: input.days,
      // Capped or time-cut change_event rows still are change_event rows (totalsPartial says so).
      source: parts.some(
        (p) =>
          (p.part === "change_events" || p.part === "change_events_other") && p.status === "ok",
      )
        ? "change_event"
        : parts.some((p) => p.part === "change_status" && p.status === "ok")
          ? "change_status"
          : "none",
      byResourceType: countBy(rows, (r) => r.resourceType),
      byOperation: countBy(rows, (r) => r.operation),
      byClientType: countBy(
        rows.filter((r) => r.source === "change_event"),
        (r) => r.clientType,
      ),
      byUser: countBy(
        rows.filter((r) => r.source === "change_event"),
        (r) => r.user,
      ),
      newest: sorted[sorted.length - 1] ?? null,
      oldest: sorted[0] ?? null,
    };
  },
  summaryLine: (s, ctx) =>
    `${plural(s.changes, "change")} on ${ctx.customerId} in the last ${plural(s.days, "day")}` +
    (s.source === "change_status"
      ? " (from change_status: what changed, not who or which fields)"
      : "") +
    (s.newest ? `, newest ${s.newest}` : "") +
    ".",
  rowLine: (r) =>
    `${r.changedAt ?? "?"} ${r.operation ?? "?"} ${r.resourceType ?? "?"} ${r.resourceIds.join("~") || "?"}${r.user ? ` by ${r.user}` : ""}${r.clientType ? ` via ${r.clientType}` : ""}${r.changedFields.length ? ` (${r.changedFields.slice(0, 5).join(", ")})` : ""}`,
};
