// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Windows — the audit window and its sub-windows, plus conversion maturity.
 *
 * AccountData carries no date range (MAPPING.md); the window is what the sync
 * wrote into `dailyMetrics.metric_date` (min .. max). Fallback: the campaign
 * daily series. With neither, only m90 exists and it cannot be placed on a
 * calendar (start/end null).
 *
 * Maturity (§8.4 rule 2), two tiers:
 *   strict    lastSettledDay = end − max(lookback_window_days) of the actions not HIDDEN/REMOVED
 *   practical lastSettledDayPractical = end − 7
 * A window is `settledStrict` / `settledPractical` when its end <= that day.
 * No conversion actions synced → maxLookbackDays null → nothing is strictly
 * settled, and the model says why (`lookbackUnknown`). settledWeek /
 * settledToDate are cut at the STRICT day.
 *
 * Sub-windows (labels from §3.1):
 *   m90           = start .. end (the audit window, whatever its true length)
 *   m30           = end-29 .. end
 *   mPrior30      = end-59 .. end-30
 *   m7            = end-6 .. end
 *   settledWeek   = lastSettledDay-6 .. lastSettledDay
 *   settledToDate = start .. lastSettledDay
 * Example: end , lookback 30 -> lastSettledDay ;
 * m30 = 08-04..09-02, mPrior30 = 07-05..08-03, settledWeek = 07-28..08-03.
 */
import { num, metricsFromRows, type FieldMap, type NodeMetrics } from "./metrics.js";
import type { WindowLabel, WindowSpec } from "./provenance.js";

export interface AuditWindow {
  start: string | null;
  end: string | null;
  days: number | null;
  maxLookbackDays: number | null;
  /** end − maxLookbackDays (strict tier). */
  lastSettledDay: string | null;
  /** end − 7 (practical tier). */
  lastSettledDayPractical: string | null;
  /** true when conversionActions carried no lookback → nothing can be called settled. */
  lookbackUnknown: boolean;
  /** Which table placed the window on the calendar. */
  source: "dailyMetrics" | "campaignDailyMetrics" | "none";
  windows: Record<WindowLabel, WindowSpec>;
}

export interface NodeWindows {
  m90: NodeMetrics;
  /** null, never zero, when no daily series reaches this level (G.0 rule 1). */
  m30: NodeMetrics | null;
  mPrior30: NodeMetrics | null;
  m7: NodeMetrics | null;
  settledWeek: NodeMetrics | null;
  settledToDate: NodeMetrics | null;
}

/** 'YYYY-MM-DD' from a pg date serialised as ISO ('2026-06-04T00:00:00.000Z') or a plain date string. */
export function isoDay(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m?.[1] ?? null;
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The last day whose conversions for ONE action are final: window end minus the
 * action's own lookback. The account-wide day uses the longest lookback of all
 * actions, so one 90-day sign-up action would leave no settled day in a 90-day
 * window for a 30-day purchase action. Falls back to the account-wide day.
 */
export function actionSettledDay(
  window: Pick<AuditWindow, "end" | "lastSettledDay">,
  action: { attrs: { lookbackDays: number | null } },
): string | null {
  const lb = action.attrs.lookbackDays;
  if (lb == null || !window.end) return window.lastSettledDay;
  return addDays(window.end, -lb);
}

export function daysBetween(start: string, end: string): number {
  const a = new Date(start + "T00:00:00Z").getTime();
  const b = new Date(end + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

function spec(
  label: WindowLabel,
  start: string | null,
  end: string | null,
  lastSettledDay: string | null,
  lastPractical: string | null,
): WindowSpec {
  const days = start && end ? daysBetween(start, end) : null;
  const settledStrict = !!(end && lastSettledDay && end <= lastSettledDay);
  const settledPractical = !!(end && lastPractical && end <= lastPractical);
  return { label, start, end, days, settledStrict, settledPractical };
}

export function computeAuditWindow(
  dailyMetrics: readonly any[],
  campaignDailyMetrics: readonly any[],
  conversionActions: readonly any[],
): AuditWindow {
  let source: AuditWindow["source"] = "none";
  let days: string[] = dailyMetrics
    .map((r) => isoDay(r?.metric_date))
    .filter((x): x is string => !!x);
  if (days.length) source = "dailyMetrics";
  else {
    days = campaignDailyMetrics.map((r) => isoDay(r?.metric_date)).filter((x): x is string => !!x);
    if (days.length) source = "campaignDailyMetrics";
  }
  days.sort();
  const start = days[0] ?? null;
  const end = days[days.length - 1] ?? null;

  // A HIDDEN or REMOVED action records nothing new, so its lookback holds nothing back
  // (an old 90-day import would leave no settled day in a 90-day window). Unknown
  // status still counts; with no live action left, every action counts as before.
  const dead = (a: any) => {
    const st = String(a?.status ?? "").toUpperCase();
    return st === "HIDDEN" || st === "REMOVED";
  };
  const live = conversionActions.filter((a) => !dead(a));
  let maxLookbackDays: number | null = null;
  for (const a of live.length > 0 ? live : conversionActions) {
    const lb = num(a?.lookback_window_days);
    if (lb == null) continue;
    maxLookbackDays = maxLookbackDays == null ? lb : Math.max(maxLookbackDays, lb);
  }
  const lookbackUnknown = maxLookbackDays == null;
  const lastSettledDay = end && maxLookbackDays != null ? addDays(end, -maxLookbackDays) : null;
  const lastSettledDayPractical = end ? addDays(end, -7) : null;
  const P = lastSettledDayPractical;

  const windows: Record<WindowLabel, WindowSpec> = {
    m90: spec("m90", start, end, lastSettledDay, P),
    m30: spec("m30", end ? addDays(end, -29) : null, end, lastSettledDay, P),
    mPrior30: spec(
      "mPrior30",
      end ? addDays(end, -59) : null,
      end ? addDays(end, -30) : null,
      lastSettledDay,
      P,
    ),
    m7: spec("m7", end ? addDays(end, -6) : null, end, lastSettledDay, P),
    settledWeek: spec(
      "settledWeek",
      lastSettledDay ? addDays(lastSettledDay, -6) : null,
      lastSettledDay,
      lastSettledDay,
      P,
    ),
    settledToDate: spec(
      "settledToDate",
      lastSettledDay ? start : null,
      lastSettledDay,
      lastSettledDay,
      P,
    ),
  };
  // A settled window whose start precedes the audit start would be a lie about
  // coverage; clamp settledWeek/settledToDate into the audit window.
  for (const w of [windows.settledWeek, windows.settledToDate]) {
    if (w.start && start && w.start < start) w.start = start;
    if (w.start && w.end && w.start > w.end) {
      w.start = null;
      w.end = null;
      w.days = null;
      w.settledStrict = false;
      w.settledPractical = false;
    } else if (w.start && w.end) w.days = daysBetween(w.start, w.end);
  }
  return {
    start,
    end,
    days: start && end ? daysBetween(start, end) : null,
    maxLookbackDays,
    lastSettledDay,
    lastSettledDayPractical,
    lookbackUnknown,
    source,
    windows,
  };
}

/** Rows whose `dateField` falls inside the window (inclusive). Empty when the window is unplaced. */
export function rowsInWindow(
  rows: readonly any[],
  w: WindowSpec,
  dateField = "metric_date",
): any[] {
  if (!w.start || !w.end) return [];
  return rows.filter((r) => {
    const d = isoDay(r?.[dateField]);
    return d != null && d >= w.start! && d <= w.end!;
  });
}

/**
 * Build the sub-window metrics for an entity from its daily series. Returns
 * null for every sub-window when the series is absent (not zero — G.0 rule 1).
 */
export function windowsFromDaily(
  daily: readonly any[] | null,
  aw: AuditWindow,
  table: string,
  fields: FieldMap = {},
): Omit<NodeWindows, "m90"> {
  if (!daily || daily.length === 0)
    return { m30: null, mPrior30: null, m7: null, settledWeek: null, settledToDate: null };
  const mk = (w: WindowSpec): NodeMetrics | null =>
    w.start && w.end ? metricsFromRows(rowsInWindow(daily, w), w, table, fields) : null;
  return {
    m30: mk(aw.windows.m30),
    mPrior30: mk(aw.windows.mPrior30),
    m7: mk(aw.windows.m7),
    settledWeek: mk(aw.windows.settledWeek),
    settledToDate: mk(aw.windows.settledToDate),
  };
}

export type Maturity = "settled" | "unsettled" | "mixed";

/** STRICT tier: settled if every present window is settled, unsettled if none is, mixed otherwise. */
export function maturityOf(w: NodeWindows): Maturity {
  const present = Object.values(w).filter((m): m is NodeMetrics => m != null);
  const settled = present.filter((m) => m.provenance.settledStrict).length;
  if (settled === 0) return "unsettled";
  if (settled === present.length) return "settled";
  return "mixed";
}
