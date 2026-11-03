// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Conversion actions → ConversionActionNode[] (account children).
 *
 * Sources: `conversionActions` (definition + total_conversions / total_value +
 * campaign_breakdown JSON), `campaignConversions` (per campaign × action
 * name) and the pool-read table
 * `conversion_action_daily` (one row per campaign × day × owner ×
 * action) which becomes `attrs.daily`. The node's sub-windows stay null; the
 * daily series is read by CA.daily_conv / CA.last_fire_date / CA.silent_days.
 */
import { cmpStr } from "../shared/order.js";
import { bool, json, nodeFromRows, str, type BuildCtx } from "./context.js";
import { num } from "./metrics.js";
import type { ConversionActionNode } from "./nodes/ConversionActionNode.js";
import { isoDay } from "./windows.js";

export const CONVERSION_ACTION_DAILY_TABLE = "conversion_action_daily";

/** conversion_action_id → ascending per-day totals; null when the table did not load. */
function dailyByAction(
  ctx: BuildCtx,
): Map<string, { date: string; conv: number; value: number | null; all: number | null }[]> | null {
  const rows = ctx.readDb(CONVERSION_ACTION_DAILY_TABLE);
  if (rows == null) return null;
  const acc = new Map<
    string,
    Map<string, { conv: number; value: number | null; all: number | null }>
  >();
  for (const r of rows) {
    const id = String(r.conversion_action_id ?? "");
    const d = isoDay(r.date);
    if (!id || !d) continue;
    let days = acc.get(id);
    if (!days) {
      days = new Map();
      acc.set(id, days);
    }
    const cur = days.get(d) ?? { conv: 0, value: null, all: null };
    cur.conv += num(r.conversions) ?? 0;
    const all = num(r.all_conversions);
    if (all != null) cur.all = (cur.all ?? 0) + all;
    const v = num(r.conversions_value);
    if (v != null) cur.value = (cur.value ?? 0) + v;
    days.set(d, cur);
  }
  const out = new Map<
    string,
    { date: string; conv: number; value: number | null; all: number | null }[]
  >();
  for (const [id, days] of acc)
    out.set(
      id,
      [...days.entries()]
        .map(([date, x]) => ({ date, ...x }))
        .sort((a, b) => cmpStr(a.date, b.date)),
    );
  return out;
}

export function buildConversionActions(ctx: BuildCtx, parentId: string): ConversionActionNode[] {
  const rows = ctx.read("conversionActions");
  const convRows = ctx.read("campaignConversions");
  const daily = dailyByAction(ctx);
  const byName = new Map<string, any[]>();
  for (const r of convRows) {
    const k = String(r.conversion_action_name ?? "");
    const a = byName.get(k);
    if (a) a.push(r);
    else byName.set(k, [r]);
  }
  return rows.map((r) => {
    const actionId = String(r.action_id);
    const base = nodeFromRows(
      ctx,
      "conversionAction",
      actionId,
      String(r.name ?? actionId),
      parentId,
      [r],
      "conversionActions",
      {
        status: r.status,
        fields: {
          conv: "total_conversions",
          value: "total_value",
          cost: "__none",
          clicks: "__none",
          impressions: "__none",
        },
      },
    );
    const breakdown = json<any[]>(r.campaign_breakdown) ?? [];
    const perCampaign = (Array.isArray(breakdown) ? breakdown : []).map((b) => ({
      campaignId: String(b.campaignId ?? b.campaign_id ?? ""),
      conv: num(b.conversions),
      value: num(b.value ?? b.conversion_value),
    }));
    const fromTable = (byName.get(String(r.name ?? "")) ?? []).map((c) => ({
      campaignId: String(c.campaign_id),
      conv: num(c.conversions),
      value: num(c.conversion_value),
    }));
    const total = num(r.total_conversions);
    const node: ConversionActionNode = {
      ...base,
      attrs: {
        actionId,
        category: str(r.category),
        origin: str(r.origin),
        type: str(r.type),
        status: str(r.status),
        isPrimary: bool(r.is_primary) === true,
        includeInConversions: bool(r.include_in_conversions),
        attributionModel: str(r.attribution_model),
        countingType: str(r.counting_type),
        lookbackDays: num(r.lookback_window_days),
        viewThroughDays: num(r.view_through_window_days),
        defaultValue: num(r.default_value),
        alwaysUseDefaultValue: bool(r.always_use_default_value),
        totalConversions: total,
        totalValue: num(r.total_value),
        perCampaign,
        perCampaignFromConversionsTable: fromTable,
        hasAnyData:
          (total ?? 0) > 0 || fromTable.length > 0 || perCampaign.some((p) => (p.conv ?? 0) > 0),
        daily: daily == null ? null : (daily.get(actionId) ?? []),
      },
    };
    if (node.attrs.status == null)
      node.notCheckable.push({
        checkId: "conversion_action.status",
        reason: "conversion_actions.status is null (unknown, not ENABLED)",
      });
    if (daily == null)
      node.notCheckable.push({
        checkId: "conversion_action.daily",
        reason: `${CONVERSION_ACTION_DAILY_TABLE} was not loaded for this audit — no per-action daily series`,
      });
    return node;
  });
}
