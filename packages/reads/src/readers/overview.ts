// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Customer settings from PerfoAds CUSTOMER_TIME_ZONE_QUERY / parseCustomerSettings, totals from
// buildPriorYearDailyQuery (metrics FROM customer, here unsegmented so Google sums the range),
// plus a count of campaigns per channel and status. Manager accounts have no metrics of their
// own: the totals part is skipped for them.

import * as z from "zod";
import {
  amount,
  metricLine,
  plural,
  shown,
  testAccountStatusNote,
  TotalsSchema,
  unknownBecause,
} from "../common.js";
import { dateCondition, describeDateRange, type DateRange } from "../dateRange.js";
import {
  bool,
  boolOrNull,
  currencyCode,
  enumValue,
  get,
  id,
  metrics,
  text,
  timeZone,
  totals,
} from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export interface OverviewInput {
  dateRange: DateRange;
}

export const ChannelRowSchema = z.object({
  channelType: z.string(),
  enabled: z.number(),
  paused: z.number(),
});
export type ChannelRow = z.infer<typeof ChannelRowSchema>;

export const OverviewSummarySchema = z.object({
  account: z
    .object({
      customerId: z.string(),
      name: UntrustedSchema,
      currencyCode: z.string().nullable(),
      timeZone: z.string().nullable(),
      status: z.string().nullable(),
      isManager: z.boolean(),
      isTestAccount: z.boolean(),
      autoTagging: z.boolean().nullable(),
      statusNote: z
        .string()
        .nullable()
        .describe("Set for test accounts Google shows as closed: they still work"),
    })
    .nullable(),
  totals: TotalsSchema.nullable().describe("null when not read (manager account or failed)"),
  enabledCampaigns: z.number().nullable().describe("null when the campaign list couldn't be read"),
  pausedCampaigns: z.number().nullable(),
});
export type OverviewSummary = z.infer<typeof OverviewSummarySchema>;

export const CUSTOMER_QUERY = `
    SELECT
      customer.id,
      customer.descriptive_name,
      customer.currency_code,
      customer.time_zone,
      customer.status,
      customer.manager,
      customer.test_account,
      customer.auto_tagging_enabled
    FROM customer`;

export const totalsQuery = (input: OverviewInput): string => `
    SELECT
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM customer
    WHERE ${dateCondition(input.dateRange)}`;

export const CAMPAIGN_COUNTS_QUERY = `
    SELECT
      campaign.advertising_channel_type,
      campaign.status
    FROM campaign
    WHERE campaign.status != 'REMOVED'`;

export const overviewReader: ReaderDef<
  OverviewInput,
  ChannelRow,
  OverviewSummary,
  { account: OverviewSummary["account"]; totals: OverviewSummary["totals"] }
> = {
  name: "account_overview",
  queries: (input, ctx) => ({
    customer: { gaql: CUSTOMER_QUERY, limit: 1 },
    totals: ctx.isManager
      ? { skipped: "Manager accounts have no metrics of their own. Ask about a client account." }
      : { gaql: totalsQuery(input) },
    campaigns: { gaql: CAMPAIGN_COUNTS_QUERY },
  }),
  map: (data, _input, ctx) => {
    const c = data.customer?.[0];
    const isTestAccount = c ? bool(get(c, "customer.testAccount")) : false;
    const status = c ? enumValue(get(c, "customer.status")) : null;
    const account = c
      ? {
          customerId: id(get(c, "customer.id")) ?? ctx.customerId,
          name: text(get(c, "customer.descriptiveName")),
          currencyCode: currencyCode(get(c, "customer.currencyCode")),
          timeZone: timeZone(get(c, "customer.timeZone")),
          status,
          isManager: bool(get(c, "customer.manager")),
          isTestAccount,
          autoTagging: boolOrNull(get(c, "customer.autoTaggingEnabled")),
          statusNote: testAccountStatusNote(isTestAccount, status),
        }
      : null;
    const sums = data.totals ? totals(data.totals.map(metrics)) : null;
    const byChannel = new Map<string, ChannelRow>();
    for (const row of data.campaigns ?? []) {
      const channelType = enumValue(get(row, "campaign.advertisingChannelType")) ?? "UNKNOWN";
      const status = enumValue(get(row, "campaign.status"));
      const entry = byChannel.get(channelType) ?? { channelType, enabled: 0, paused: 0 };
      if (status === "ENABLED") entry.enabled++;
      else if (status === "PAUSED") entry.paused++;
      byChannel.set(channelType, entry);
    }
    return { rows: [...byChannel.values()], extra: { account, totals: sums } };
  },
  compare: (a, b) =>
    b.enabled - a.enabled || b.paused - a.paused || a.channelType.localeCompare(b.channelType),
  summarise: (rows, extra, _ctx, _input, parts) => {
    const counted = partOk(parts, "campaigns");
    return {
      account: extra.account,
      totals: extra.totals,
      enabledCampaigns: counted ? rows.reduce((n, r) => n + r.enabled, 0) : null,
      pausedCampaigns: counted ? rows.reduce((n, r) => n + r.paused, 0) : null,
    };
  },
  summaryLine: (s, ctx, input) =>
    `${s.account ? shown(s.account.name) : "Account"} ${ctx.customerId} (${s.account?.currencyCode ?? "currency unknown"}): ${s.enabledCampaigns === null ? `campaigns ${unknownBecause("campaigns")}` : `${plural(s.enabledCampaigns, "enabled campaign")}, ${s.pausedCampaigns ?? 0} paused`}` +
    (s.totals
      ? `; ${describeDateRange(input.dateRange)}: ${metricLine(s.totals, ctx)}, conversion value ${amount(s.totals.conversionsValue, ctx)}${s.totals.roas === null ? "" : `, ROAS ${Math.round(s.totals.roas * 100)}%`}.`
      : ".") +
    (s.account?.statusNote ? ` ${s.account.statusNote}` : ""),
  rowLine: (r) => `${r.channelType}: ${r.enabled} enabled, ${r.paused} paused`,
};
