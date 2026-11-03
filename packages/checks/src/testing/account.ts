// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Synthetic accounts for the check tests. Every number is made up; nothing
 * here comes from a real account. Deterministic: fixed dates, no clock.
 */
import type { EvidenceInput } from "../api.js";
import { getCheck } from "../engine/checks/index.js";
import type { CheckCtx, CheckResult } from "../engine/checks/types.js";
import { AUDIT_KEY_TABLE, buildAccountModel } from "../engine/model/buildAccountModel.js";
import { buildMetricCtx, evaluate } from "../engine/registry/index.js";
import { resolveSettings } from "../engine/settings.js";
import { currencyScale } from "../engine/shared/currencyScale.js";
import { toClientContext } from "../engine/shared/clientContext.js";
import type { AccountData, AccountDataArrayKey, Row } from "../engine/shared/input.js";

/** The run date every fixture uses; the daily series ends the day before. */
export const RUN_DATE = "2026-09-02";
export const LAST_DAY = "2026-09-01";

export function dayBefore(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

export interface CampaignSpec {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  strategy?: string | null;
  targetRoas?: number | null;
  targetCpa?: number | null;
  /** daily budget */
  budget?: number;
  /** per day, over `days` days */
  cost?: number;
  conv?: number;
  value?: number;
  clicks?: number;
  impressions?: number;
  /** length of the daily series (ends LAST_DAY) */
  days?: number;
  /** impression share row; omit = no row */
  is?: {
    share?: number;
    lostBudget?: number;
    lostRank?: number;
    /** the window's last 3 weeks (snapshot extra); omit = not read */
    recent?: { lostBudget?: number | null; cost?: number; value?: number };
  };
  /** extra campaign row fields */
  extra?: Row;
}

export interface FixtureOptions {
  campaigns: CampaignSpec[];
  /** more AccountData rows (keywords, searchTerms, ...) */
  data?: Partial<AccountData>;
  /** extra named tables */
  tables?: Record<string, Row[]>;
  /**
   * Which AccountData keys get an "ok" sync marker. Default: every key that has
   * rows plus every key in `syncedEmpty`. A key with no rows and no marker is
   * "not read".
   */
  syncedEmpty?: AccountDataArrayKey[];
  /** keys to leave without a marker even when they have rows */
  noMarker?: AccountDataArrayKey[];
  profile?: AccountData["profile"];
  businessType?: EvidenceInput["businessType"];
  clientContext?: EvidenceInput["clientContext"];
  settings?: EvidenceInput["settings"];
  currencyCode?: string | null;
}

export function campaignRows(spec: CampaignSpec): { campaign: Row; daily: Row[]; is: Row | null } {
  const days = spec.days ?? 90;
  const cost = spec.cost ?? 100;
  const conv = spec.conv ?? 2;
  const value = spec.value ?? conv * 200;
  const clicks = spec.clicks ?? 50;
  const impressions = spec.impressions ?? 1000;
  const daily: Row[] = [];
  for (let i = 0; i < days; i++) {
    daily.push({
      campaign_id: spec.id,
      metric_date: dayBefore(LAST_DAY, i),
      cost,
      conversions: conv,
      conversion_value: value,
      clicks,
      impressions,
    });
  }
  const campaign: Row = {
    campaign_id: spec.id,
    name: spec.name ?? `Generic campaign ${spec.id}`,
    status: spec.status ?? "ENABLED",
    type: spec.type ?? "SEARCH",
    cost: cost * days,
    conversions: conv * days,
    conversion_value: value * days,
    clicks: clicks * days,
    impressions: impressions * days,
    budget: spec.budget ?? 100,
    budget_id: `b${spec.id}`,
    bidding_strategy_type:
      spec.strategy === undefined ? "MAXIMIZE_CONVERSION_VALUE" : spec.strategy,
    target_roas: spec.targetRoas ?? null,
    target_cpa: spec.targetCpa ?? null,
    bidding_strategy_source: "standard",
    ...(spec.extra ?? {}),
  };
  const is = spec.is
    ? {
        campaign_id: spec.id,
        search_impression_share: spec.is.share ?? 0.6,
        search_budget_lost_impression_share: spec.is.lostBudget ?? 0,
        search_rank_lost_impression_share: spec.is.lostRank ?? 0,
        ...(spec.is.recent
          ? {
              recent_start: dayBefore(LAST_DAY, 20),
              recent_end: LAST_DAY,
              recent_cost: spec.is.recent.cost ?? 700,
              recent_conversion_value: spec.is.recent.value ?? 2000,
              recent_budget_lost_impression_share:
                spec.is.recent.lostBudget === undefined ? 0 : spec.is.recent.lostBudget,
            }
          : {}),
      }
    : null;
  return { campaign, daily, is };
}

/** A whole engine input from campaign specs plus extra rows. */
export function buildInput(opts: FixtureOptions): EvidenceInput {
  const campaigns: Row[] = [];
  const daily: Row[] = [];
  const is: Row[] = [];
  for (const spec of opts.campaigns) {
    const r = campaignRows(spec);
    campaigns.push(r.campaign);
    daily.push(...r.daily);
    if (r.is) is.push(r.is);
  }
  const accountDaily = new Map<string, Row>();
  for (const d of daily) {
    const a = accountDaily.get(d.metric_date) ?? {
      metric_date: d.metric_date,
      cost: 0,
      conversions: 0,
      conversion_value: 0,
      clicks: 0,
      impressions: 0,
    };
    for (const k of ["cost", "conversions", "conversion_value", "clicks", "impressions"])
      a[k] += d[k];
    accountDaily.set(d.metric_date, a);
  }
  const data: AccountData = {
    currencyCode: opts.currencyCode === undefined ? "USD" : opts.currencyCode,
    customerId: "1234567890",
    profile: opts.profile ?? { businessType: "ecommerce" },
    campaigns,
    campaignDailyMetrics: daily,
    campaignBudgets: opts.campaigns.map((c) => ({
      budget_id: `b${c.id}`,
      name: `Budget ${c.id}`,
      amount: c.budget ?? 100,
      status: "ENABLED",
      reference_count: 1,
    })),
    dailyMetrics: [...accountDaily.values()],
    ...(is.length > 0 ? { impressionShare: is } : {}),
    ...(opts.data ?? {}),
  };
  const noMarker = new Set(opts.noMarker ?? []);
  const synced = new Set<string>(opts.syncedEmpty ?? []);
  const statusRows: Row[] = [];
  for (const [key, table] of Object.entries(AUDIT_KEY_TABLE)) {
    const rows = data[key as AccountDataArrayKey];
    const has = Array.isArray(rows) && rows.length > 0;
    if (noMarker.has(key as AccountDataArrayKey)) continue;
    if (!has && !synced.has(key)) continue;
    statusRows.push({
      table_name: table,
      status: "ok",
      row_count: has ? rows.length : 0,
      error_message: null,
    });
  }
  return {
    data,
    tables: opts.tables ?? {},
    statusRows,
    runDate: RUN_DATE,
    runId: "synthetic",
    ...(opts.businessType !== undefined ? { businessType: opts.businessType } : {}),
    ...(opts.clientContext ? { clientContext: opts.clientContext } : {}),
    ...(opts.settings ? { settings: opts.settings } : {}),
    clock: () => 0,
  };
}

/** The check context the engine would build for this input. */
export function checkCtxOf(input: EvidenceInput): CheckCtx {
  // the read statuses reach the model as the engine passes them (its sync_table_status)
  const tables = { ...(input.tables ?? {}) };
  if (input.statusRows && !Array.isArray(tables.sync_table_status))
    tables.sync_table_status = [...input.statusRows];
  const model = buildAccountModel(input.data, tables, input.runId ?? "account", {
    businessType: input.businessType ?? null,
    ...(input.caps ? { caps: input.caps } : {}),
  });
  const settings = resolveSettings(input.settings);
  const metrics = buildMetricCtx(model, input.data, {
    statusRows: input.statusRows ?? null,
    ...(input.runDate ? { runDate: input.runDate } : {}),
    settings,
  });
  return {
    model,
    metrics,
    get: (id, args) => evaluate(metrics, id, args),
    window: model.window,
    currency: currencyScale(model.attrs.currencyCode),
    businessType: model.attrs.businessType,
    clientContext: toClientContext(input.clientContext),
    settings,
  };
}

/** Run one check (behind its gates) on a fixture. */
export function runOne(id: string, input: EvidenceInput): CheckResult {
  const def = getCheck(id);
  if (!def) throw new Error(`unknown check ${id}`);
  return def.run(checkCtxOf(input));
}

/** A keyword row. */
export function keyword(r: {
  id: string;
  campaignId: string;
  adGroupId: string;
  text: string;
  match?: string;
  cost?: number;
  clicks?: number;
  conv?: number;
  qs?: number | null;
  status?: string;
}): Row {
  return {
    keyword_id: r.id,
    campaign_id: r.campaignId,
    ad_group_id: r.adGroupId,
    text: r.text,
    match_type: r.match ?? "EXACT",
    status: r.status ?? "ENABLED",
    is_negative: false,
    cost: r.cost ?? 10,
    clicks: r.clicks ?? 10,
    conversions: r.conv ?? 1,
    conversions_value: (r.conv ?? 1) * 200,
    impressions: (r.clicks ?? 10) * 20,
    quality_score: r.qs === undefined ? 7 : r.qs,
    expected_ctr: "AVERAGE",
    ad_relevance: "BELOW_AVERAGE",
    landing_page_experience: "AVERAGE",
  };
}

/** An ad group row. */
export function adGroup(r: {
  id: string;
  campaignId: string;
  name?: string;
  status?: string;
}): Row {
  return {
    ad_group_id: r.id,
    campaign_id: r.campaignId,
    name: r.name ?? `Ad group ${r.id}`,
    status: r.status ?? "ENABLED",
  };
}

/** A search-term row. */
export function searchTerm(r: {
  campaignId: string;
  adGroupId: string;
  term: string;
  cost?: number;
  clicks?: number;
  conv?: number;
}): Row {
  return {
    campaign_id: r.campaignId,
    ad_group_id: r.adGroupId,
    search_term: r.term,
    cost: r.cost ?? 5,
    clicks: r.clicks ?? 5,
    conversions: r.conv ?? 0,
    conversion_value: (r.conv ?? 0) * 200,
    impressions: (r.clicks ?? 5) * 20,
  };
}
