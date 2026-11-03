// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Population and orphans — build sheet §A.0 global population rule, §C, §D.0.
 *
 * A metric's population is ONLY the rows that inner-join to a node in the
 * AccountModel. Rows carrying the audit id that join no node are orphans:
 * counted in `DQ.orphan_rows[table]`, excluded from every metric and every
 * denominator. A table whose joined population is 0 while it has rows is
 * `not_checkable: population 0 of N rows joined`, never "none found".
 *
 * The counts come from the model (`dataQuality.orphanRows`, computed by
 * `countOrphanRows` in model/buildAccountModel.ts) — nothing is recounted here.
 */
import { AUDIT_KEY_TABLE } from "../model/buildAccountModel.js";
import type { AccountModel } from "../model/nodes/AccountNode.js";
import { markerFor, type SyncMarker } from "./syncMarkers.js";

export interface TablePopulation {
  /** AccountData key or db table name as the model keys it. */
  table: string;
  rows: number;
  /** rows joining a node (DQ.population). */
  attached: number;
  /** DQ.orphan_rows — rows joining no node. */
  orphans: number;
  /** 'joined' = the model counted orphans for this table; 'unjoined' = an account-level (keyless) table, every row belongs to the account node. */
  join: "joined" | "unjoined";
}

const DB_PREFIX = "db:";

function tableKeys(model: AccountModel, table: string): string[] {
  // accept an AccountData key, a * name, or a db:-prefixed name
  const keys = new Set<string>([table]);
  if (table.startsWith(DB_PREFIX)) keys.add(table.slice(DB_PREFIX.length));
  else if (model.dataQuality.tables[`${DB_PREFIX}${table}`]) keys.add(`${DB_PREFIX}${table}`);
  for (const [k, t] of Object.entries(AUDIT_KEY_TABLE)) if (t === table) keys.add(k);
  return [...keys];
}

/** Population of one table as the model sees it. */
export function populationOf(model: AccountModel, table: string): TablePopulation {
  const keys = tableKeys(model, table);
  let rows = 0;
  let found = false;
  for (const k of keys) {
    const q = model.dataQuality.tables[k];
    if (q) {
      rows = q.rows;
      found = true;
      break;
    }
  }
  let orphans: number | null = null;
  for (const k of keys) {
    const o = model.dataQuality.orphanRows[k];
    if (o != null) {
      orphans = o;
      break;
    }
  }
  if (!found) return { table, rows: 0, attached: 0, orphans: 0, join: "unjoined" };
  if (orphans == null) return { table, rows, attached: rows, orphans: 0, join: "unjoined" };
  return { table, rows, attached: Math.max(0, rows - orphans), orphans, join: "joined" };
}

/** Every table the model tracks. */
export function populationReport(model: AccountModel): Map<string, TablePopulation> {
  const out = new Map<string, TablePopulation>();
  for (const k of Object.keys(model.dataQuality.tables)) {
    const p = populationOf(model, k);
    out.set(k, p);
    if (k.startsWith(DB_PREFIX)) out.set(k.slice(DB_PREFIX.length), p);
    const t = AUDIT_KEY_TABLE[k];
    if (t) out.set(t, p);
  }
  return out;
}

export interface NotCheckableVerdict {
  notCheckable: boolean;
  reason: string | null;
  /** 'ok' or 'provisional' when checkable. */
  markerState: "ok" | "provisional" | null;
}

/**
 * The rule-5 + population gate for a table:
 *  - marker error / skipped → not checkable (the sync said so);
 *  - population 0 of N > 0 rows joined → not checkable;
 *  - 0 rows and no marker → not checkable (never "none found");
 *  - marker ok (status row or legacy count) → checkable, 'ok';
 *  - rows but no marker → checkable, 'provisional' (§B "pending markers").
 */
export function notCheckable(
  model: AccountModel,
  markers: Map<string, SyncMarker>,
  table: string,
): NotCheckableVerdict {
  const m = markerFor(markers, table);
  const p = populationOf(model, table);
  if (m.status === "error" || m.status === "skipped")
    return {
      notCheckable: true,
      reason:
        `${m.table} ${m.status === "skipped" ? "was not read" : "could not be read"}: ${m.message ?? ""}`.trim(),
      markerState: null,
    };
  if (p.rows > 0 && p.attached === 0)
    return {
      notCheckable: true,
      reason: `${m.table}: none of its ${p.rows} rows belong to a campaign, ad group or ad in this account`,
      markerState: null,
    };
  if (m.status === "ok") return { notCheckable: false, reason: null, markerState: "ok" };
  // "rows exist" means the model tracked rows OR the loader saw rows. A scalar-backed
  // table (conversion_tracking_settings) has no tracked population, so without the
  // second half it would read as "0 rows and no marker" and be judged un-checkable
  // even though its row is right there.
  if (p.rows > 0 || m.rowsSeen > 0)
    return { notCheckable: false, reason: null, markerState: "provisional" };
  return {
    notCheckable: true,
    reason: `${m.table} was not read (no rows and no status row)`,
    markerState: null,
  };
}
