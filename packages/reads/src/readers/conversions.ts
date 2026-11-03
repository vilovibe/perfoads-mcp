// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Ported from PerfoAds fetchConversionActions (definitions: status, category, counting,
// attribution model, lookback windows, value settings), buildConversionActionDailyQuery
// (conversions per action per day; segmented by conversion action, so no cost/clicks),
// fetchCustomerConversionGoals, fetchCampaignConversionGoals and fetchConversionValueRules.
// Changes: primary_for_goal + origin added; REMOVED actions left out; daily rows read
// FROM customer (fewer rows), FROM campaign as the fallback query PerfoAds used in
// production; a failed metrics read = metrics null, never zero; value rules counted only.

import * as z from "zod";
import { countBy, plural, shown, where } from "../common.js";
import { dateCondition, describeDateRange, type DateRange } from "../dateRange.js";
import {
  boolOrNull,
  date,
  double,
  doubleMoney,
  enumValue,
  get,
  id,
  idFromResourceName,
  numberOrNull,
  round,
  sumMoney,
  text,
  currencyCode,
  type Row,
} from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export interface ConversionsInput {
  dateRange: DateRange;
  /**
   * The account snapshot's extra detail (not used by the tool): the per-action daily series,
   * the campaign goals, the value rules, the tracking settings and the value split by rule.
   */
  detail?: boolean;
}

/** Snapshot detail (input.detail): kept whole, never paged. */
export interface ConversionDetail {
  /** per action per day; null = not read */
  daily:
    | {
        actionId: string;
        date: string;
        conversions: number;
        conversionsValue: string;
        /** all_conversions that day: a secondary action fires here, never in conversions */
        allConversions: number;
      }[]
    | null;
  campaignGoals:
    | {
        campaignId: string;
        category: string | null;
        origin: string | null;
        biddable: boolean | null;
      }[]
    | null;
  valueRules: { id: string | null; status: string | null }[] | null;
  trackingSettings: {
    conversionTrackingStatus: string | null;
    /** the effective account-level enhanced conversions setting (inherited under cross-account tracking) */
    enhancedConversions: boolean | null;
    acceptedCustomerDataTerms: boolean | null;
  } | null;
  /** reported value per campaign and the value rule that set it; null = not read */
  valueByRule: { campaignId: string; dimension: string; conversionsValue: string }[] | null;
  /** conversions with no click (view-through) beside conversions and all conversions, per campaign; null = not read */
  viewThrough:
    | {
        campaignId: string;
        viewThroughConversions: number;
        conversions: number;
        allConversions: number;
      }[]
    | null;
}

export const ConversionMetricsSchema = z.object({
  conversions: z.number(),
  conversionsValue: z.string(),
  allConversions: z.number(),
  allConversionsValue: z.string(),
  daysWithConversions: z.number().describe("Days with all_conversions > 0"),
  lastConversionDate: z.string().nullable(),
});
type ConversionMetrics = z.infer<typeof ConversionMetricsSchema>;

export const ConversionActionRowSchema = z.object({
  id: z.string(),
  name: UntrustedSchema,
  status: z.string().nullable(),
  type: z.string().nullable(),
  category: z.string().nullable(),
  origin: z.string().nullable(),
  primaryForGoal: z.boolean().nullable(),
  includeInConversionsMetric: z.boolean().nullable(),
  countingType: z.string().nullable(),
  attributionModel: z.string().nullable(),
  dataDrivenModelStatus: z.string().nullable(),
  clickLookbackDays: z.number().nullable(),
  viewLookbackDays: z.number().nullable(),
  defaultValue: z.string().nullable(),
  defaultCurrencyCode: z.string().nullable(),
  alwaysUseDefaultValue: z.boolean().nullable(),
  ownerCustomerId: z.string().nullable(),
  metrics: ConversionMetricsSchema.nullable().describe("Over the date range; null = not read"),
});
export type ConversionActionRow = z.infer<typeof ConversionActionRowSchema>;

export const GoalSchema = z.object({
  category: z.string().nullable(),
  origin: z.string().nullable(),
  biddable: z.boolean().nullable(),
});

export const ConversionSummarySchema = z.object({
  actions: z.number(),
  byStatus: z.record(z.string(), z.number()),
  byCategory: z.record(z.string(), z.number()),
  primaryActions: z.number(),
  enabledPrimaryWithoutConversions: z
    .number()
    .nullable()
    .describe("Enabled primary actions with 0 all_conversions in the range; null = unknown"),
  customerGoals: z.number().nullable(),
  biddableGoals: z.number().nullable(),
  campaignsWithOwnGoals: z
    .number()
    .nullable()
    .describe("Campaigns whose goal settings differ from the account's"),
  valueRules: z.number().nullable(),
  enabledValueRules: z.number().nullable(),
  totals: ConversionMetricsSchema.omit({ daysWithConversions: true, lastConversionDate: true })
    .nullable()
    .describe("null = not read"),
});
export type ConversionSummary = z.infer<typeof ConversionSummarySchema>;

export const CONVERSION_ACTIONS_QUERY = `
    SELECT
      conversion_action.id,
      conversion_action.name,
      conversion_action.status,
      conversion_action.type,
      conversion_action.category,
      conversion_action.origin,
      conversion_action.primary_for_goal,
      conversion_action.include_in_conversions_metric,
      conversion_action.counting_type,
      conversion_action.attribution_model_settings.attribution_model,
      conversion_action.attribution_model_settings.data_driven_model_status,
      conversion_action.click_through_lookback_window_days,
      conversion_action.view_through_lookback_window_days,
      conversion_action.value_settings.default_value,
      conversion_action.value_settings.default_currency_code,
      conversion_action.value_settings.always_use_default_value,
      conversion_action.owner_customer
    FROM conversion_action
    WHERE conversion_action.status != 'REMOVED'
    ORDER BY conversion_action.id`;

/** Segmented by conversion action: Google refuses cost/clicks/impressions here. */
export const conversionDailyQuery = (range: DateRange, from: "customer" | "campaign"): string => `
    SELECT
      segments.date,
      segments.conversion_action,
      metrics.conversions,
      metrics.conversions_value,
      metrics.all_conversions,
      metrics.all_conversions_value
    FROM ${from}
    ${where([dateCondition(range)])}
    ORDER BY segments.date`;

export const CUSTOMER_GOALS_QUERY = `
    SELECT
      customer_conversion_goal.category,
      customer_conversion_goal.origin,
      customer_conversion_goal.biddable
    FROM customer_conversion_goal`;

export const CAMPAIGN_GOALS_QUERY = `
    SELECT
      campaign_conversion_goal.campaign,
      campaign_conversion_goal.category,
      campaign_conversion_goal.origin,
      campaign_conversion_goal.biddable
    FROM campaign_conversion_goal
    WHERE campaign.status != 'REMOVED'`;

export const TRACKING_SETTINGS_QUERY = `
    SELECT
      customer.conversion_tracking_setting.conversion_tracking_status,
      customer.conversion_tracking_setting.effective_enablement_setting,
      customer.conversion_tracking_setting.accepted_customer_data_terms
    FROM customer`;

/** Reported value per campaign and the conversion value rule (or none) that set it. */
export const valueByRuleQuery = (range: DateRange): string => `
    SELECT
      campaign.id,
      segments.conversion_value_rule_primary_dimension,
      metrics.conversions_value
    FROM campaign
    ${where([dateCondition(range)])}
    ORDER BY campaign.id`;

/** View-through conversions (seen, not clicked) beside conversions and all conversions, per campaign. */
export const viewThroughQuery = (range: DateRange): string => `
    SELECT
      campaign.id,
      metrics.view_through_conversions,
      metrics.conversions,
      metrics.all_conversions
    FROM campaign
    ${where([dateCondition(range)])}
    ORDER BY campaign.id`;

export const VALUE_RULES_QUERY = `
    SELECT
      conversion_value_rule.id,
      conversion_value_rule.status
    FROM conversion_value_rule
    WHERE conversion_value_rule.status != 'REMOVED'
    ORDER BY conversion_value_rule.id`;

/** First goals shown in the reply (an account has one per category and origin). */
export const GOALS_SHOWN = 50;

type Daily = {
  conversions: number;
  value: string[];
  all: number;
  allValue: string[];
  days: Set<string>;
  last: string | null;
};

const mapAction = (
  row: Row,
  metricsBy: ReadonlyMap<string, Daily> | null,
): ConversionActionRow | null => {
  const c = (path: string) => get(row, `conversionAction.${path}`);
  const actionId = id(c("id"));
  if (!actionId) return null;
  const d = metricsBy?.get(actionId);
  const value = numberOrNull(c("valueSettings.defaultValue"));
  return {
    id: actionId,
    name: text(c("name")),
    status: enumValue(c("status")),
    type: enumValue(c("type")),
    category: enumValue(c("category")),
    origin: enumValue(c("origin")),
    primaryForGoal: boolOrNull(c("primaryForGoal")),
    includeInConversionsMetric: boolOrNull(c("includeInConversionsMetric")),
    countingType: enumValue(c("countingType")),
    attributionModel: enumValue(c("attributionModelSettings.attributionModel")),
    dataDrivenModelStatus: enumValue(c("attributionModelSettings.dataDrivenModelStatus")),
    clickLookbackDays: numberOrNull(c("clickThroughLookbackWindowDays")),
    viewLookbackDays: numberOrNull(c("viewThroughLookbackWindowDays")),
    defaultValue: value === null ? null : doubleMoney(value),
    defaultCurrencyCode: currencyCode(c("valueSettings.defaultCurrencyCode")),
    alwaysUseDefaultValue: boolOrNull(c("valueSettings.alwaysUseDefaultValue")),
    ownerCustomerId: idFromResourceName(c("ownerCustomer")),
    metrics:
      metricsBy === null
        ? null
        : {
            conversions: d ? d.conversions : 0,
            conversionsValue: d ? sumMoney(d.value) : "0",
            allConversions: d ? d.all : 0,
            allConversionsValue: d ? sumMoney(d.allValue) : "0",
            daysWithConversions: d ? d.days.size : 0,
            lastConversionDate: d?.last ?? null,
          },
  };
};

/** ON -> true, OFF -> false, UNKNOWN / UNSPECIFIED / missing -> null (unknown). */
const onOff = (v: string | null): boolean | null =>
  v === "ON" ? true : v === "OFF" ? false : null;

/** The snapshot's detail: every list null when its part was not read in full. */
const detailOf = (
  data: Readonly<Record<string, Row[] | undefined>>,
  parts: Parameters<typeof partOk>[0],
): ConversionDetail => {
  const dailyKey = new Map<string, { conversions: number; value: string[]; all: number }>();
  for (const row of data.action_metrics ?? []) {
    const actionId = idFromResourceName(get(row, "segments.conversionAction"));
    const day = date(get(row, "segments.date"));
    if (!actionId || !day) continue;
    const k = `${actionId}|${day}`;
    const d = dailyKey.get(k) ?? { conversions: 0, value: [], all: 0 };
    d.conversions += double(get(row, "metrics.conversions"));
    d.all += double(get(row, "metrics.allConversions"));
    d.value.push(doubleMoney(get(row, "metrics.conversionsValue")));
    dailyKey.set(k, d);
  }
  const settings = (data.tracking_settings ?? [])[0];
  const t = (path: string) => get(settings, `customer.conversionTrackingSetting.${path}`);
  const byRule = new Map<string, string[]>();
  for (const row of data.value_by_rule ?? []) {
    const campaignId = id(get(row, "campaign.id"));
    const dimension = enumValue(get(row, "segments.conversionValueRulePrimaryDimension"));
    if (!campaignId || !dimension) continue;
    const k = `${campaignId}|${dimension}`;
    byRule.set(k, [...(byRule.get(k) ?? []), doubleMoney(get(row, "metrics.conversionsValue"))]);
  }
  return {
    daily: partOk(parts, "action_metrics")
      ? [...dailyKey.entries()]
          .map(([k, d]) => {
            const [actionId = "", day = ""] = k.split("|");
            return {
              actionId,
              date: day,
              conversions: round(d.conversions, 2),
              conversionsValue: sumMoney(d.value),
              allConversions: round(d.all, 2),
            };
          })
          .sort((a, b) => a.actionId.localeCompare(b.actionId) || a.date.localeCompare(b.date))
      : null,
    campaignGoals: partOk(parts, "campaign_goals")
      ? (data.campaign_goals ?? [])
          .map((row) => ({
            campaignId: idFromResourceName(get(row, "campaignConversionGoal.campaign")) ?? "",
            category: enumValue(get(row, "campaignConversionGoal.category")),
            origin: enumValue(get(row, "campaignConversionGoal.origin")),
            biddable: boolOrNull(get(row, "campaignConversionGoal.biddable")),
          }))
          .filter((g) => g.campaignId !== "")
      : null,
    valueRules: partOk(parts, "value_rules")
      ? (data.value_rules ?? []).map((r) => ({
          id: id(get(r, "conversionValueRule.id")),
          status: enumValue(get(r, "conversionValueRule.status")),
        }))
      : null,
    trackingSettings:
      partOk(parts, "tracking_settings") && settings
        ? {
            conversionTrackingStatus: enumValue(t("conversionTrackingStatus")),
            enhancedConversions: onOff(enumValue(t("effectiveEnablementSetting"))),
            acceptedCustomerDataTerms: boolOrNull(t("acceptedCustomerDataTerms")),
          }
        : null,
    viewThrough: partOk(parts, "view_through")
      ? (data.view_through ?? [])
          .map((row) => ({
            campaignId: id(get(row, "campaign.id")) ?? "",
            viewThroughConversions: double(get(row, "metrics.viewThroughConversions")),
            conversions: double(get(row, "metrics.conversions")),
            allConversions: double(get(row, "metrics.allConversions")),
          }))
          .filter((r) => r.campaignId !== "")
      : null,
    valueByRule: partOk(parts, "value_by_rule")
      ? [...byRule.entries()].map(([k, v]) => {
          const [campaignId = "", dimension = ""] = k.split("|");
          return { campaignId, dimension, conversionsValue: sumMoney(v) };
        })
      : null,
  };
};

const goalKey = (category: string | null, origin: string | null) => `${category}|${origin}`;

export const conversionsReader: ReaderDef<
  ConversionsInput,
  ConversionActionRow,
  ConversionSummary,
  { customerGoals: z.infer<typeof GoalSchema>[]; detail?: ConversionDetail },
  {
    valueRules: { status: string | null }[];
    campaignsWithOwnGoals: number;
    goals: number;
    biddableGoals: number;
  }
> = {
  name: "conversions",
  queries: (input, ctx) => ({
    actions: { gaql: CONVERSION_ACTIONS_QUERY },
    action_metrics: ctx.isManager
      ? { skipped: "a manager account has no conversion metrics of its own." }
      : {
          gaql: conversionDailyQuery(input.dateRange, "customer"),
          fallback: conversionDailyQuery(input.dateRange, "campaign"),
        },
    customer_goals: { gaql: CUSTOMER_GOALS_QUERY },
    campaign_goals: { gaql: CAMPAIGN_GOALS_QUERY },
    value_rules: { gaql: VALUE_RULES_QUERY },
    ...(input.detail
      ? {
          tracking_settings: { gaql: TRACKING_SETTINGS_QUERY },
          value_by_rule: ctx.isManager
            ? { skipped: "a manager account has no conversion metrics of its own." }
            : { gaql: valueByRuleQuery(input.dateRange) },
          view_through: ctx.isManager
            ? { skipped: "a manager account has no conversion metrics of its own." }
            : { gaql: viewThroughQuery(input.dateRange) },
        }
      : {}),
  }),
  map: (data, input, _ctx, parts) => {
    let metricsBy: Map<string, Daily> | null = null;
    if (partOk(parts, "action_metrics")) {
      metricsBy = new Map();
      for (const row of data.action_metrics ?? []) {
        const actionId = idFromResourceName(get(row, "segments.conversionAction"));
        if (!actionId) continue;
        const d = metricsBy.get(actionId) ?? {
          conversions: 0,
          value: [],
          all: 0,
          allValue: [],
          days: new Set<string>(),
          last: null,
        };
        const all = double(get(row, "metrics.allConversions"));
        d.conversions += double(get(row, "metrics.conversions"));
        d.value.push(doubleMoney(get(row, "metrics.conversionsValue")));
        d.all += all;
        d.allValue.push(doubleMoney(get(row, "metrics.allConversionsValue")));
        const day = date(get(row, "segments.date"));
        if (day && all > 0) {
          d.days.add(day);
          if (d.last === null || day > d.last) d.last = day;
        }
        metricsBy.set(actionId, d);
      }
    }
    const rows = (data.actions ?? [])
      .map((r) => mapAction(r, metricsBy))
      .filter((r): r is ConversionActionRow => r !== null);

    const customerGoals = (data.customer_goals ?? []).map((row) => ({
      category: enumValue(get(row, "customerConversionGoal.category")),
      origin: enumValue(get(row, "customerConversionGoal.origin")),
      biddable: boolOrNull(get(row, "customerConversionGoal.biddable")),
    }));
    const accountBiddable = new Map(
      customerGoals.map((g) => [goalKey(g.category, g.origin), g.biddable]),
    );
    const ownGoals = new Set<string>();
    for (const row of data.campaign_goals ?? []) {
      const campaignId = idFromResourceName(get(row, "campaignConversionGoal.campaign"));
      const key = goalKey(
        enumValue(get(row, "campaignConversionGoal.category")),
        enumValue(get(row, "campaignConversionGoal.origin")),
      );
      const biddable = boolOrNull(get(row, "campaignConversionGoal.biddable"));
      if (campaignId && accountBiddable.has(key) && accountBiddable.get(key) !== biddable) {
        ownGoals.add(campaignId);
      }
    }
    customerGoals.sort(
      (a, b) =>
        (a.category ?? "").localeCompare(b.category ?? "") ||
        (a.origin ?? "").localeCompare(b.origin ?? ""),
    );
    return {
      rows,
      extra: {
        customerGoals: customerGoals.slice(0, GOALS_SHOWN),
        ...(input.detail ? { detail: detailOf(data, parts) } : {}),
      },
      facts: {
        valueRules: (data.value_rules ?? []).map((r) => ({
          status: enumValue(get(r, "conversionValueRule.status")),
        })),
        campaignsWithOwnGoals: ownGoals.size,
        goals: customerGoals.length,
        biddableGoals: customerGoals.filter((g) => g.biddable === true).length,
      },
    };
  },
  compare: (a, b) =>
    (b.metrics?.allConversions ?? -1) - (a.metrics?.allConversions ?? -1) ||
    a.id.localeCompare(b.id),
  summarise: (rows, _extra, _ctx, _input, parts, facts) => {
    const actionsOk = partOk(parts, "actions");
    const metricsOk = actionsOk && partOk(parts, "action_metrics");
    const goalsOk = partOk(parts, "customer_goals");
    const rules = facts?.valueRules ?? [];
    return {
      actions: rows.length,
      byStatus: countBy(rows, (r) => r.status),
      byCategory: countBy(rows, (r) => r.category),
      primaryActions: rows.filter((r) => r.primaryForGoal === true).length,
      enabledPrimaryWithoutConversions: metricsOk
        ? rows.filter(
            (r) =>
              r.status === "ENABLED" &&
              r.primaryForGoal === true &&
              r.metrics?.allConversions === 0,
          ).length
        : null,
      customerGoals: goalsOk ? (facts?.goals ?? 0) : null,
      biddableGoals: goalsOk ? (facts?.biddableGoals ?? 0) : null,
      campaignsWithOwnGoals:
        goalsOk && partOk(parts, "campaign_goals") ? (facts?.campaignsWithOwnGoals ?? 0) : null,
      valueRules: partOk(parts, "value_rules") ? rules.length : null,
      enabledValueRules: partOk(parts, "value_rules")
        ? rules.filter((r) => r.status === "ENABLED").length
        : null,
      totals: metricsOk
        ? {
            conversions: round(
              rows.reduce((n, r) => n + (r.metrics?.conversions ?? 0), 0),
              2,
            ),
            conversionsValue: sumMoney(rows.map((r) => r.metrics?.conversionsValue ?? "0")),
            allConversions: round(
              rows.reduce((n, r) => n + (r.metrics?.allConversions ?? 0), 0),
              2,
            ),
            allConversionsValue: sumMoney(rows.map((r) => r.metrics?.allConversionsValue ?? "0")),
          }
        : null,
    };
  },
  summaryLine: (s, ctx, input) =>
    `${plural(s.actions, "conversion action")} on ${ctx.customerId} (${s.primaryActions} primary)` +
    (s.totals
      ? `, ${describeDateRange(input.dateRange)}: ${round(s.totals.conversions, 2)} conversions, ${round(s.totals.allConversions, 2)} all conversions`
      : ", conversions in the range: unknown (not read)") +
    `. Enabled primary actions with no conversions: ${s.enabledPrimaryWithoutConversions ?? "unknown"}.`,
  rowLine: (r: ConversionActionRow) => {
    const m: ConversionMetrics | null = r.metrics;
    return `${shown(r.name)} id ${r.id}, ${r.status ?? "?"}, ${r.category ?? "?"}, ${r.primaryForGoal ? "primary" : "secondary"}, counting ${r.countingType ?? "?"}: ${m ? `${round(m.conversions, 2)} conv, ${round(m.allConversions, 2)} all, last ${m.lastConversionDate ?? "none in range"}` : "conversions unknown"}`;
  },
};
