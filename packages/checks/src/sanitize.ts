// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Input validation at the API boundary. The engine never sees malformed input:
 *
 *   - a wrong TYPE for something the caller states about the account (brand
 *     terms, business type, owner context, run date, status rows) is an ERROR:
 *     no check runs and the result says why;
 *   - a damaged ROW (null, not an object) is dropped and counted in a warning;
 *     a numeric string in a metric field becomes a number; NaN / Infinity
 *     become null (unknown, never zero);
 *   - every array is put in one canonical order, so the output never depends on
 *     the order rows arrived in.
 */
import {
  ACCOUNT_DATA_ARRAY_KEYS,
  type AccountData,
  type ClientContextInput,
  type Row,
} from "./engine/shared/input.js";
import type { BusinessType } from "./engine/shared/businessType.js";
import { cmpStr } from "./engine/shared/order.js";
import { AUDIT_KEY_TABLE } from "./engine/model/buildAccountModel.js";

/** Tables the model reads by name that are not AccountData keys (per-campaign caps only). */
const EXTRA_CAP_TABLES: readonly string[] = ["pmax_placements"];

export interface CleanInput {
  data: AccountData;
  tables: Record<string, Row[]>;
  statusRows: Row[] | null;
  legacyCounts: Record<string, unknown> | null;
  runDate: string | null;
  runId: string;
  businessType: BusinessType | null;
  clientContext: ClientContextInput | null;
  settings: unknown;
  clock: (() => number) | null;
  caps: Record<string, number> | null;
  assumeComplete: boolean;
  /** tables made incomplete by the cleaning (dropped rows, bad row_count), with the reason */
  incompleteTables: Record<string, string>;
  changeHistoryCoverage: { startDate: string; endDate: string } | null;
}

export interface Sanitized {
  input: CleanInput | null;
  errors: string[];
  warnings: string[];
}

const BUSINESS_TYPES: ReadonlySet<string> = new Set([
  "lead_gen",
  "local_lead_gen",
  "local_retail",
  "ecommerce",
  "unknown",
]);

/** Metric fields whose numeric strings are turned into numbers. */
const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  "cost",
  "clicks",
  "impressions",
  "conversions",
  "conversion_value",
  "conversions_value",
  "all_conversions",
  "all_conversions_value",
  "budget",
  "amount",
  "target_roas",
  "target_cpa",
  "quality_score",
  "bid_modifier",
  "row_count",
  "search_impression_share",
  "search_budget_lost_impression_share",
  "search_rank_lost_impression_share",
  "search_top_impression_share",
  "search_absolute_top_impression_share",
  "search_exact_match_impression_share",
  "view_through_conversions",
  "cost_micros",
  "amount_micros",
  "reference_count",
  "non_removed_campaign_count",
  "campaign_count",
  "lookback_window_days",
  "portfolio_target_roas",
]);
const NUMERIC_STRING = /^\s*-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A row count: a non-negative whole number (or a string holding one). */
function isWholeCount(v: unknown): boolean {
  const n =
    typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === "object" && !Array.isArray(v);

function isIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** One value, cleaned: non-finite numbers are unknown (null); numeric strings in metric fields become numbers. */
function cleanValue(key: string, v: unknown): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && NUMERIC_FIELDS.has(key) && NUMERIC_STRING.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "function" || typeof v === "symbol") return null;
  return v;
}

/** Rows nested deeper than this, or that contain themselves, are dropped. */
export const MAX_ROW_DEPTH = 32;

class UnusableRow extends Error {}

/** A stable sort key for a row: its fields in key order. Throws UnusableRow on a cycle or excessive depth. */
function canonical(v: unknown, depth = 0, ancestors: Set<unknown> = new Set()): string {
  if (depth > MAX_ROW_DEPTH) throw new UnusableRow("too deep");
  if (Array.isArray(v) || isObject(v)) {
    if (ancestors.has(v)) throw new UnusableRow("cyclic");
    ancestors.add(v);
    const out = Array.isArray(v)
      ? `[${v.map((x) => canonical(x, depth + 1, ancestors)).join(",")}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k], depth + 1, ancestors)}`)
          .join(",")}}`;
    ancestors.delete(v);
    return out;
  }
  if (v === undefined) return "null";
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return "null";
  }
}

/** Keep object rows only, clean their values, sort canonically. */
function cleanRows(
  name: string,
  raw: unknown,
  warnings: string[],
  incomplete?: { table: string; into: Record<string, string> },
): Row[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    warnings.push(`${name}: expected an array of rows, got ${typeof raw}; treated as not read`);
    return null;
  }
  let dropped = 0;
  let unusable = 0;
  const rows: Array<{ key: string; row: Row }> = [];
  for (const r of raw) {
    if (!isObject(r)) {
      dropped++;
      continue;
    }
    const row: Row = {};
    for (const [k, v] of Object.entries(r)) row[k] = cleanValue(k, v);
    let key: string;
    try {
      key = canonical(row);
    } catch (err) {
      if (!(err instanceof UnusableRow) && !(err instanceof RangeError)) throw err;
      unusable++;
      continue;
    }
    rows.push({ key, row });
  }
  if (dropped > 0) warnings.push(`${name}: ${dropped} row(s) were not objects and were dropped`);
  if (unusable > 0)
    warnings.push(
      `${name}: ${unusable} row(s) were nested deeper than ${MAX_ROW_DEPTH} levels or contained themselves and were dropped`,
    );
  // a dropped row is a row the reader delivered and the engine will not see: the table is incomplete
  if (incomplete && dropped + unusable > 0)
    incomplete.into[incomplete.table] =
      `${dropped + unusable} row(s) were dropped as unusable, so the table is incomplete`;
  rows.sort((a, b) => cmpStr(a.key, b.key));
  return rows.map((r) => r.row);
}

function optString(v: unknown, name: string, errors: string[]): string | null {
  if (v == null) return null;
  if (typeof v !== "string") {
    errors.push(`${name} must be a string`);
    return null;
  }
  return v;
}

function checkClientContext(v: unknown, errors: string[]): ClientContextInput | null {
  if (v == null) return null;
  if (!isObject(v)) {
    errors.push("clientContext must be an object");
    return null;
  }
  const out: ClientContextInput = {};
  if (v.source != null) {
    if (v.source !== "owner" && v.source !== "suggested")
      errors.push("clientContext.source must be 'owner' or 'suggested'");
    else out.source = v.source;
  }
  if (v.account != null) {
    if (!isObject(v.account)) errors.push("clientContext.account must be an object");
    else {
      const a = v.account;
      const account: NonNullable<ClientContextInput["account"]> = {};
      const bt = optString(a.businessType, "clientContext.account.businessType", errors);
      if (bt != null) account.businessType = bt;
      const tp = optString(
        a.tracksPostLeadOutcomes,
        "clientContext.account.tracksPostLeadOutcomes",
        errors,
      );
      if (tp != null) account.tracksPostLeadOutcomes = tp;
      if (a.grossMarginPct != null) {
        if (typeof a.grossMarginPct !== "number" && typeof a.grossMarginPct !== "string")
          errors.push("clientContext.account.grossMarginPct must be a number");
        else account.grossMarginPct = a.grossMarginPct;
      }
      out.account = account;
    }
  }
  if (v.campaigns != null) {
    if (!isObject(v.campaigns))
      errors.push("clientContext.campaigns must be an object keyed by campaign id");
    else {
      const campaigns: NonNullable<ClientContextInput["campaigns"]> = {};
      for (const [id, c] of Object.entries(v.campaigns)) {
        if (!isObject(c)) {
          errors.push(`clientContext.campaigns["${id}"] must be an object`);
          continue;
        }
        const entry: NonNullable<ClientContextInput["campaigns"]>[string] = {};
        for (const f of ["purpose", "objective", "conversion", "target", "constraints"] as const) {
          const s = optString(c[f], `clientContext.campaigns["${id}"].${f}`, errors);
          if (s != null) entry[f] = s;
        }
        if (c.source != null) {
          if (c.source !== "owner" && c.source !== "suggested")
            errors.push(`clientContext.campaigns["${id}"].source must be 'owner' or 'suggested'`);
          else entry.source = c.source;
        }
        campaigns[id] = entry;
      }
      out.campaigns = campaigns;
    }
  }
  return out;
}

/** Validate and clean everything the caller passed. Never throws. */
export function sanitizeInput(raw: unknown): Sanitized {
  const errors: string[] = [];
  const warnings: string[] = [];
  const incompleteTables: Record<string, string> = {};
  if (!isObject(raw))
    return { input: null, errors: ["the input must be an object with a `data` field"], warnings };
  const d = raw.data;
  if (!isObject(d))
    return { input: null, errors: ["`data` must be an object of account rows"], warnings };

  // ---- top-level account fields
  let currencyCode: string | null = null;
  if (d.currencyCode != null) {
    const c = typeof d.currencyCode === "string" ? d.currencyCode.trim().toUpperCase() : "";
    if (/^[A-Z]{3}$/.test(c)) currencyCode = c;
    else
      warnings.push(
        "data.currencyCode is not a 3-letter currency code; the currency is treated as unknown and money floors are skipped",
      );
  }
  const data: AccountData = { currencyCode };
  if (d.customerId != null) {
    if (typeof d.customerId === "string" || typeof d.customerId === "number")
      data.customerId = String(d.customerId);
    else warnings.push("data.customerId must be a string; ignored");
  }
  if (d.merchantCenterConnected != null) {
    if (typeof d.merchantCenterConnected === "boolean")
      data.merchantCenterConnected = d.merchantCenterConnected;
    else warnings.push("data.merchantCenterConnected must be a boolean; ignored");
  }
  for (const k of ["optimizationScore", "conversionTrackingSettings"] as const) {
    if (d[k] == null) continue;
    if (isObject(d[k])) data[k] = d[k] as Row;
    else warnings.push(`data.${k} must be an object; ignored`);
  }

  // ---- profile: what the caller states, so a wrong type is an error
  if (d.profile != null) {
    if (!isObject(d.profile)) errors.push("data.profile must be an object");
    else {
      const p = d.profile;
      const profile: NonNullable<AccountData["profile"]> = {};
      if (p.brandTerms != null) {
        if (!Array.isArray(p.brandTerms) || p.brandTerms.some((t) => typeof t !== "string"))
          errors.push("data.profile.brandTerms must be an array of strings");
        else
          profile.brandTerms = p.brandTerms
            .map((t: string) => t.trim())
            .filter((t: string) => t !== "");
      }
      if (p.primaryGoals != null) {
        if (!Array.isArray(p.primaryGoals) || p.primaryGoals.some((t) => typeof t !== "string"))
          errors.push("data.profile.primaryGoals must be an array of strings");
        else profile.primaryGoals = [...p.primaryGoals];
      }
      for (const f of ["businessType", "industry", "monthlySpendRange"] as const) {
        const s = optString(p[f], `data.profile.${f}`, errors);
        if (s != null) profile[f] = s;
      }
      data.profile = profile;
    }
  }

  // ---- row arrays
  const known = new Set<string>(ACCOUNT_DATA_ARRAY_KEYS);
  for (const k of ACCOUNT_DATA_ARRAY_KEYS) {
    const rows = cleanRows(`data.${k}`, d[k], warnings, { table: k, into: incompleteTables });
    if (rows) data[k] = rows;
  }
  const scalarKeys = new Set([
    "currencyCode",
    "customerId",
    "profile",
    "merchantCenterConnected",
    "optimizationScore",
    "conversionTrackingSettings",
  ]);
  const unknownKeys = Object.keys(d)
    .filter((k) => !known.has(k) && !scalarKeys.has(k))
    .sort();
  if (unknownKeys.length > 0)
    warnings.push(
      `data: unknown key(s) ignored: ${unknownKeys.slice(0, 10).join(", ")}${unknownKeys.length > 10 ? ", ..." : ""}`,
    );

  // ---- named tables
  const tables: Record<string, Row[]> = {};
  if (raw.tables != null) {
    if (!isObject(raw.tables)) warnings.push("tables must be an object of row arrays; ignored");
    else
      for (const name of Object.keys(raw.tables).sort()) {
        const rows = cleanRows(`tables.${name}`, raw.tables[name], warnings, {
          table: name,
          into: incompleteTables,
        });
        if (rows) tables[name] = rows;
      }
  }

  // ---- status rows: they decide what can be judged, so a wrong shape is an error
  let statusRows: Row[] | null = null;
  if (raw.statusRows != null) {
    if (!Array.isArray(raw.statusRows))
      errors.push("statusRows must be an array of { table_name, status, row_count } rows");
    else {
      const rows = cleanRows("statusRows", raw.statusRows, warnings) ?? [];
      const valid = rows.filter((r) => typeof r.table_name === "string" && r.table_name !== "");
      if (valid.length < rows.length)
        warnings.push(
          `statusRows: ${rows.length - valid.length} row(s) without a table_name were dropped`,
        );
      // row_count must be a non-negative whole number, or absent; anything else = completeness unknown
      const rawRows = (raw.statusRows as unknown[]).filter(isObject);
      for (const r of valid) {
        const original = rawRows.find(
          (x) =>
            x.table_name === r.table_name &&
            "row_count" in x &&
            x.row_count != null &&
            !isWholeCount(x.row_count),
        );
        if (!original && (r.row_count == null || isWholeCount(r.row_count))) continue;
        const shown = original ? original.row_count : r.row_count;
        const label =
          typeof shown === "number" ? String(shown) : (JSON.stringify(shown) ?? String(shown));
        warnings.push(
          `statusRows: ${String(r.table_name)} has row_count ${label}, which is not a whole number of rows; its completeness is unknown`,
        );
        incompleteTables[String(r.table_name)] =
          `row_count ${label} is not a whole number of rows, so completeness is unknown`;
        r.row_count = null;
      }
      statusRows = valid;
    }
  }

  let legacyCounts: Record<string, unknown> | null = null;
  if (raw.legacyCounts != null) {
    if (isObject(raw.legacyCounts)) legacyCounts = raw.legacyCounts;
    else warnings.push("legacyCounts must be an object; ignored");
  }

  let runDate: string | null = null;
  if (raw.runDate != null) {
    if (typeof raw.runDate !== "string" || !isIsoDate(raw.runDate))
      errors.push("runDate must be a real date 'YYYY-MM-DD'");
    else runDate = raw.runDate;
  }

  let runId = "account";
  if (raw.runId != null) {
    if (typeof raw.runId === "string" && raw.runId.trim() !== "") runId = raw.runId;
    else warnings.push("runId must be a non-empty string; 'account' is used");
  }

  let businessType: BusinessType | null = null;
  if (raw.businessType != null) {
    if (typeof raw.businessType !== "string" || !BUSINESS_TYPES.has(raw.businessType))
      errors.push(`businessType must be one of ${[...BUSINESS_TYPES].join(", ")}`);
    else businessType = raw.businessType as BusinessType;
  }

  const clientContext = checkClientContext(raw.clientContext, errors);

  let clock: (() => number) | null = null;
  if (raw.clock != null) {
    if (typeof raw.clock === "function") clock = raw.clock as () => number;
    else warnings.push("clock must be a function; the system clock is used");
  }

  let caps: Record<string, number> | null = null;
  if (raw.caps != null) {
    if (!isObject(raw.caps)) warnings.push("caps must be an object of row limits; ignored");
    else {
      caps = {};
      for (const [k, v] of Object.entries(raw.caps)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) caps[k] = v;
        else warnings.push(`caps.${k} must be a positive number; ignored`);
      }
      // a cap under a name no table answers to limits nothing: say so (usually a typo)
      const known = new Set<string>([
        ...ACCOUNT_DATA_ARRAY_KEYS,
        ...Object.values(AUDIT_KEY_TABLE),
        ...Object.keys(tables),
        ...EXTRA_CAP_TABLES,
      ]);
      for (const k of Object.keys(caps)) {
        const [base = "", suffix, ...rest] = k.split(":");
        const suffixOk = suffix === undefined || (suffix === "per_campaign" && rest.length === 0);
        if (!known.has(base) || !suffixOk)
          warnings.push(
            `caps.${k} names no table the engine reads (data key or table name, optional ":per_campaign"), so it limits nothing`,
          );
      }
    }
  }

  let assumeComplete = false;
  if (raw.assumeComplete != null) {
    if (typeof raw.assumeComplete === "boolean") assumeComplete = raw.assumeComplete;
    else errors.push("assumeComplete must be true or false");
  }

  let changeHistoryCoverage: CleanInput["changeHistoryCoverage"] = null;
  if (raw.changeHistoryCoverage != null) {
    const c = raw.changeHistoryCoverage as { startDate?: unknown; endDate?: unknown };
    if (
      !isObject(raw.changeHistoryCoverage) ||
      typeof c.startDate !== "string" ||
      typeof c.endDate !== "string" ||
      !isIsoDate(c.startDate) ||
      !isIsoDate(c.endDate) ||
      c.startDate > c.endDate
    )
      errors.push("changeHistoryCoverage must be {startDate, endDate}, real dates 'YYYY-MM-DD'");
    else changeHistoryCoverage = { startDate: c.startDate, endDate: c.endDate };
  }

  if (errors.length > 0) return { input: null, errors, warnings };
  return {
    input: {
      data,
      tables,
      statusRows,
      legacyCounts,
      runDate,
      runId,
      businessType,
      clientContext,
      settings: raw.settings,
      clock,
      caps,
      assumeComplete,
      incompleteTables,
      changeHistoryCoverage,
    },
    errors,
    warnings,
  };
}
