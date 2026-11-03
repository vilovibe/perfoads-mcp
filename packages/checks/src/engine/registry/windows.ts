// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Windows — build sheet §A.0 `W.*`, §A.5 `F.days_min_for_window`, and the
 * coordinator's two settled tiers (AUDIT_V3_PROGRESS decisions block):
 *   settledStrict    day <= range_end − max lookback of the actions involved
 *                    (with a 30-day lookback the recent 30d is UNSETTLED)
 *   settledPractical day <= range_end − 7
 *
 * The maths lives in model/windows.ts (computeAuditWindow, addDays, …); this
 * file maps the sheet's window names onto the model's WindowSpec and adds the
 * two windows the model does not carry (`prior7`, `last7` alias of m7).
 *
 * Sheet name → window (end = W.range_end):
 *   recent30 / 30d      end−29 .. end        U
 *   prior30             end−59 .. end−30     S with a 30-day lookback
 *   7d / last7          end−6  .. end        U
 *   prior7              end−13 .. end−7      U
 *   settled_week        strict−6 .. strict   S — ⚠ §D.1's SQL labels 08-27..09-02
 *                       "settled_week"; that range is `last7` (unsettled).
 *   settled_to_date     start .. strict      S
 *   full / 90d          start .. end         mixed
 */
import { addDays, daysBetween, isoDay, rowsInWindow, type AuditWindow } from "../model/windows.js";
import type { WindowSpec } from "../model/provenance.js";

export { addDays, daysBetween, isoDay, rowsInWindow };
export type { AuditWindow, WindowSpec };

/** F.days_min_for_window — daily rows a windowed comparison needs per side (the existing `windowsAgree` guard). */
export const DAYS_MIN_FOR_WINDOW = 10;

/**
 * THE one 90-day → monthly divisor for the v3 engine. Build sheet §A writes every
 * monthly figure as `90-day value / 3` (`wasted_cost_90d / 3`). ONE conversion
 * applies everywhere, this one. Never divide by `W.window_days` or multiply by
 * 30 to get a month.
 */
export const DAYS_PER_MONTH_DIVISOR = 3;

export type SheetWindowName =
  | "full"
  | "90d"
  | "recent30"
  | "30d"
  | "prior30"
  | "7d"
  | "last7"
  | "prior7"
  | "settled_week"
  | "settled_to_date";

export const SHEET_WINDOW_NAMES: readonly SheetWindowName[] = [
  "full",
  "90d",
  "recent30",
  "30d",
  "prior30",
  "7d",
  "last7",
  "prior7",
  "settled_week",
  "settled_to_date",
];

/** Is `day` settled by the strict tier (<= range_end − max lookback)? null when the lookback is unknown. */
export function settledStrict(day: string | null, aw: AuditWindow): boolean | null {
  if (!day || aw.lookbackUnknown || !aw.lastSettledDay) return aw.lookbackUnknown ? null : false;
  return day <= aw.lastSettledDay;
}

/** Is `day` settled by the practical tier (<= range_end − 7)? */
export function settledPractical(day: string | null, aw: AuditWindow): boolean {
  if (!day || !aw.lastSettledDayPractical) return false;
  return day <= aw.lastSettledDayPractical;
}

function spec(
  label: string,
  start: string | null,
  end: string | null,
  aw: AuditWindow,
): WindowSpec {
  return {
    label: label as WindowSpec["label"],
    start,
    end,
    days: start && end ? daysBetween(start, end) : null,
    settledStrict: settledStrict(end, aw) === true,
    settledPractical: settledPractical(end, aw),
  };
}

/** WindowSpec for a sheet window name. `prior7` / `last7` are built here; the rest come from the model. */
export function windowSpecFor(name: SheetWindowName | string, aw: AuditWindow): WindowSpec | null {
  const end = aw.end;
  switch (name) {
    case "full":
    case "90d":
      return aw.windows.m90;
    case "recent30":
    case "30d":
      return aw.windows.m30;
    case "prior30":
      return aw.windows.mPrior30;
    case "7d":
    case "last7":
      return { ...aw.windows.m7, label: "m7" };
    case "prior7":
      return end ? spec("prior7", addDays(end, -13), addDays(end, -7), aw) : null;
    case "settled_week":
      return aw.windows.settledWeek;
    case "settled_to_date":
      return aw.windows.settledToDate;
    default:
      return null;
  }
}

/** Model NodeWindows key for a sheet window name (null for prior7 — not on the model). */
export function modelWindowKey(
  name: string,
): "m90" | "m30" | "mPrior30" | "m7" | "settledWeek" | "settledToDate" | null {
  switch (name) {
    case "full":
    case "90d":
      return "m90";
    case "recent30":
    case "30d":
      return "m30";
    case "prior30":
      return "mPrior30";
    case "7d":
    case "last7":
      return "m7";
    case "settled_week":
      return "settledWeek";
    case "settled_to_date":
      return "settledToDate";
    default:
      return null;
  }
}

/** Both maturity flags for a window (rule 2: never assume settled). */
export function maturityOfWindow(w: WindowSpec | null): {
  settledStrict: boolean;
  settledPractical: boolean;
} {
  return { settledStrict: !!w?.settledStrict, settledPractical: !!w?.settledPractical };
}

/** W.end_is_yesterday — did the sync stop at run_date − 1. */
export function endIsYesterday(aw: AuditWindow, runDate: string): boolean | null {
  if (!aw.end) return null;
  return aw.end === addDays(runDate, -1);
}

/** Today in UTC as 'YYYY-MM-DD'. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
