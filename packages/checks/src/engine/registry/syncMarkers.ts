// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Sync-marker resolution — build sheet §A.0 `Y.*` / §F `syncMarkers.ts`, spec
 * §8.4 rule 5 ("zero rows with no marker = not checkable, never none found").
 *
 * Three steps, in order, for every table:
 *   1. a `sync_table_status` row → its status + row_count;
 *   2. else a non-null legacy `*_count` column on `audits` (the 12 in
 *      LEGACY_COUNT_COLUMNS — the legacy row-count columns
 *      writes exactly these) → status 'ok' with that row_count. A recorded 0
 *      IS a real "synced, found none";
 *   3. else 'unknown' → the metric / check reports not_checkable when the
 *      table is empty, `provisional` when it has rows.
 *
 * CAP detection (rows seen >= the loader's fetch cap) sets `truncated`; it is
 * NOT a marker and never upgrades 'unknown' to 'ok'.
 *
 * The caller passes `legacyCounts` (the audits row or just its
 * *_count columns); AccountData does not carry them.
 */
import { AUDIT_KEY_TABLE } from "../model/buildAccountModel.js";
import {
  LEGACY_COUNT_COLUMNS,
  MC_KEY_RESOURCE,
  mcMarkerStatus,
  mergeStatusRows,
  readerStatusOf,
} from "../model/context.js";
import { offlineJobsTruncated, type AccountModel } from "../model/nodes/AccountNode.js";

export { LEGACY_COUNT_COLUMNS };

export type MarkerStatus = "ok" | "error" | "skipped" | "unknown";

/**
 * Merchant Center tables get their marker from `mc_sync_status`
 * (written by the Merchant Center sync), NOT from
 * sync_table_status. Previously nothing read it: a clean
 * account (status 'empty' = HTTP 200 with zero issues) was reported as
 * "0 rows and no sync marker", and SH02 could never become a positive.
 *
 * Key → the `resource` value the MC sync writes. mcPriceInsights and
 * mcCompetitiveVisibility have NO marker: the only price-related resource,
 * 'price_competitiveness', describes an UPDATE onto products, not
 * either table, so they stay 'unknown' truthfully.
 */
export { MC_KEY_RESOURCE, mcMarkerStatus };

export interface SyncMarker {
  /** * table name. */
  table: string;
  /** AccountData key when the table maps to one (AUDIT_KEY_TABLE); null for db-only tables. */
  key: string | null;
  status: MarkerStatus;
  /** rows the sync wrote (marker / legacy); null when unknown. */
  rowCount: number | null;
  /** 'mc' = synthesised from mc_sync_status (Merchant Center tables only). */
  source: "marker" | "legacy" | "mc" | "none";
  message: string | null;
  /** rows the loader returned for this audit. */
  rowsSeen: number;
  cap: number | null;
  /** rowsSeen >= cap — a sample, never a total (rule 4). */
  truncated: boolean;
  /** the status row says more rows exist than were provided: the data is incomplete. */
  partial?: boolean | undefined;
  /** more rows were provided than the status row counts. */
  excess?: boolean | undefined;
}

export interface ResolveMarkerInput {
  table: string;
  key?: string | null | undefined;
  /** the sync_table_status row for this table, if any. */
  statusRow?: { status?: unknown; row_count?: unknown; error_message?: unknown } | null | undefined;
  /** the legacy audits.<key>_count value, if the column exists for this table. */
  legacyCount?: unknown | undefined;
  rowsSeen: number;
  cap?: number | null | undefined;
}

function toCount(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Words that already say why a table is cut short (which read stopped, at what limit). */
const SAYS_WHY_CUT = /\blimit\b|ran out of time|only part of the data/i;

/**
 * An ok table at its row limit: the reader's own words win when they already say why it was
 * cut (a bare "N of N" would only repeat it wrongly); any other message keeps the cap text too.
 */
function cappedMessage(message: string | null, capped: string): string {
  if (message == null || message === "") return capped;
  return SAYS_WHY_CUT.test(message) ? message : `${message}; ${capped}`;
}

/** Pure three-step resolution for ONE table. */
export function resolveSyncMarker(input: ResolveMarkerInput): SyncMarker {
  const cap = input.cap ?? null;
  // offline jobs: exactly the cap is a full read; only a bigger sync count means more exist (MI12)
  const truncated =
    cap != null &&
    (input.key === "offlineUserDataJobs"
      ? offlineJobsTruncated(input.rowsSeen, toCount(input.statusRow?.row_count), cap)
      : input.rowsSeen >= cap);
  const base = {
    table: input.table,
    key: input.key ?? null,
    rowsSeen: input.rowsSeen,
    cap,
    truncated,
  };
  // a table at the caller's row limit is a sample: incomplete, like a short read
  const capped = truncated
    ? `the ${input.rowsSeen} rows provided reached the reader's row limit of ${cap}`
    : null;
  // step 1 — status row
  if (input.statusRow) {
    // fail closed: only 'ok' is readable (readerStatusOf)
    const st = readerStatusOf(input.statusRow.status, input.statusRow.error_message);
    const rowCount = toCount(input.statusRow.row_count);
    const partial = st.checkable === "ok" && rowCount != null && input.rowsSeen < rowCount;
    const excess = st.checkable === "ok" && rowCount != null && input.rowsSeen > rowCount;
    return {
      ...base,
      status: st.checkable,
      rowCount,
      source: "marker",
      message: partial
        ? `only ${input.rowsSeen} of ${rowCount} rows were provided`
        : st.checkable === "ok" && capped
          ? cappedMessage(st.message, capped)
          : excess
            ? `${input.rowsSeen} rows were provided but the status row counts ${rowCount}`
            : st.message,
      ...(partial || (st.checkable === "ok" && capped) ? { partial: true } : {}),
      ...(excess ? { excess: true } : {}),
    };
  }
  // step 2 — legacy count column (a recorded 0 is a real zero), compared with the rows provided
  const legacy = toCount(input.legacyCount);
  if (legacy != null) {
    const partial = input.rowsSeen < legacy;
    const excess = input.rowsSeen > legacy;
    return {
      ...base,
      status: "ok",
      rowCount: legacy,
      source: "legacy",
      message: partial
        ? `only ${input.rowsSeen} of ${legacy} rows were provided`
        : capped
          ? capped
          : excess
            ? `${input.rowsSeen} rows were provided but the legacy count is ${legacy}`
            : null,
      ...(partial || capped ? { partial: true } : {}),
      ...(excess ? { excess: true } : {}),
    };
  }
  // step 3 — unknown (truncation does NOT upgrade this)
  return {
    ...base,
    status: "unknown",
    rowCount: null,
    source: "none",
    message: `no sync marker for ${input.table} (sync_table_status) and no legacy count column`,
  };
}

/** Legacy column → AccountData key, and the inverse. */
const KEY_TO_LEGACY_COLUMN: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_COUNT_COLUMNS).map(([col, key]) => [key, col]),
);

export interface ResolveAllInput {
  model: AccountModel;
  /** raw sync_table_status rows for this audit (from dbTables); when absent the model's marker-derived TableQuality is used. */
  statusRows?: readonly any[] | null | undefined;
  /** audits row (or just its *_count columns). */
  legacyCounts?: Record<string, unknown> | null | undefined;
}

/**
 * Resolve every table the model knows (AUDIT_KEY_TABLE keys + db:* tables).
 * The returned map is keyed by BOTH the AccountData key and the * name.
 */
/**
 * Scalars on AccountData that are backed by a real synced table. The model tracks no
 * population for a scalar, so without this they resolve to "no marker entry at all"
 * and any metric reading them reports markerState 'ok' — provenance it cannot support.
 */
const SCALAR_KEY_TABLE: Record<string, string> = {
  conversionTrackingSettings: "conversion_tracking_settings",
  optimizationScore: "audits",
};

export function resolveSyncMarkers(input: ResolveAllInput): Map<string, SyncMarker> {
  const out = new Map<string, SyncMarker>();
  const statusByTable = mergeStatusRows(input.statusRows ?? []);
  const legacy = input.legacyCounts ?? null;
  const tables = input.model.dataQuality.tables;

  for (const [key, table] of Object.entries(AUDIT_KEY_TABLE)) {
    const q = tables[key];
    const rowsSeen = q?.rows ?? 0;
    let statusRow = statusByTable.get(table) ?? null;
    // fall back to the model's own marker read when raw rows were not supplied
    if (!statusRow && q && q.source === "marker")
      statusRow = {
        status: q.checkable,
        row_count: q.markerRowCount,
        error_message: q.errorMessage,
      };
    const col = KEY_TO_LEGACY_COLUMN[key];
    const legacyCount = col && legacy ? legacy[col] : undefined;
    let m = resolveSyncMarker({
      table,
      key,
      statusRow,
      legacyCount,
      rowsSeen,
      cap: q?.cap ?? null,
    });
    // step 1b — a Merchant Center table with no sync_table_status row takes its
    // marker from the MC sync's own status table.
    const mcResource = MC_KEY_RESOURCE[key];
    if (m.source === "none" && mcResource) {
      const mc = input.model.dataQuality.merchantCenter.find((r) => r.resource === mcResource);
      if (mc) {
        const status = mcMarkerStatus(mc.status);
        m = {
          ...m,
          status,
          source: "mc",
          rowCount: status === "ok" ? (mc.rowCount ?? 0) : mc.rowCount,
          message:
            mc.errorDetail ??
            (status === "unknown"
              ? `mc_sync_status row has unrecognised status '${mc.status}'`
              : status === "ok" && mc.status === "empty"
                ? "Merchant Center returned no rows (synced, found none)"
                : null),
        };
      }
    }
    out.set(key, m);
    out.set(table, m);
  }
  for (const [key, table] of Object.entries(SCALAR_KEY_TABLE)) {
    if (out.has(key)) continue;
    const present =
      (input.model.attrs as unknown as Record<string, unknown> | undefined)?.[key] != null;
    const statusRow = statusByTable.get(table) ?? null;
    const col = KEY_TO_LEGACY_COLUMN[key];
    const legacyCount = col && legacy ? legacy[col] : undefined;
    const m = resolveSyncMarker({
      table,
      key,
      statusRow,
      legacyCount,
      rowsSeen: present ? 1 : 0,
      cap: null,
    });
    out.set(key, m);
    if (!out.has(table)) out.set(table, m);
  }
  for (const [k, q] of Object.entries(tables)) {
    if (!k.startsWith("db:")) continue;
    const table = k.slice(3);
    if (out.has(table)) continue;
    let statusRow = statusByTable.get(table) ?? null;
    if (!statusRow && q.source === "marker")
      statusRow = {
        status: q.checkable,
        row_count: q.markerRowCount,
        error_message: q.errorMessage,
      };
    const m = resolveSyncMarker({ table, key: null, statusRow, rowsSeen: q.rows, cap: q.cap });
    out.set(table, m);
    out.set(k, m);
  }
  // a named table the caller reported but did not provide (its read failed or was skipped):
  // its status still speaks, so a check that depends on it is never clean
  for (const [table, statusRow] of statusByTable) {
    if (out.has(table)) continue;
    const m = resolveSyncMarker({ table, key: null, statusRow, rowsSeen: 0, cap: null });
    out.set(table, m);
    out.set(`db:${table}`, m);
  }
  return out;
}

/** Marker for a table by AccountData key or * name; an unknown name resolves to status 'unknown'. */
export function markerFor(markers: Map<string, SyncMarker>, table: string): SyncMarker {
  return (
    markers.get(table) ?? {
      table,
      key: null,
      status: "unknown",
      rowCount: null,
      source: "none",
      message: `${table} is not a table the model loads`,
      rowsSeen: 0,
      cap: null,
      truncated: false,
    }
  );
}
