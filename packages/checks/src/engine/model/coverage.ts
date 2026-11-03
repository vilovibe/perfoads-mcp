// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Coverage: every AccountData key and named table, and whether the model
 * consumed it. The builders record each `ctx.read()` / `ctx.readDb()`; a
 * non-empty key that no builder read and that is not allowlisted is listed in
 * `unconsumedNonEmpty`, so data the engine silently ignored is visible.
 */
import type { AccountData, Row } from "../shared/input.js";
import { ACCOUNT_DATA_ARRAY_KEYS } from "../shared/input.js";
import { DG_TABLES } from "./buildDemandGenTree.js";
import { PMAX_TABLES } from "./buildPmaxTree.js";
import { EXTRA_NAMED_TABLES } from "./context.js";
import type { CoverageReport } from "./nodes/AccountNode.js";

/** Named tables the core model reads (beyond the AccountData arrays). */
export const CORE_NAMED_TABLES = [
  "campaign_control_settings",
  "placement_performance",
  "account_negative_criteria",
  "campaign_negatives",
  "campaign_negatives_sync_marker",
  "temporal_grid",
  "sync_table_status",
  "conversion_action_daily",
  "conversion_value_by_rule",
] as const;

/** Keys the model deliberately does not consume, with the reason. */
export const COVERAGE_ALLOWLIST: Record<string, string> = {
  callData:
    "call reporting (call-only ads) is out of scope; presence is recorded on the account node",
  auctionInsights: "not available through the Google Ads API for most accounts; never populated",
};

export function buildCoverageReport(
  data: AccountData,
  dbTables: Record<string, Row[]>,
  consumed: ReadonlySet<string>,
): CoverageReport {
  const keys: CoverageReport["keys"] = [];
  for (const k of ACCOUNT_DATA_ARRAY_KEYS) {
    const v = data[k];
    const rows = Array.isArray(v) ? v.length : 0;
    const allow = COVERAGE_ALLOWLIST[k] ?? null;
    keys.push({
      key: k,
      rows,
      consumed: consumed.has(k),
      allowlisted: allow != null,
      reason: allow,
    });
  }
  const dbKeys = new Set<string>([
    ...CORE_NAMED_TABLES,
    ...DG_TABLES,
    ...PMAX_TABLES,
    ...EXTRA_NAMED_TABLES,
    ...Object.keys(dbTables),
  ]);
  for (const t of [...dbKeys].sort()) {
    const v = dbTables[t];
    keys.push({
      key: `db:${t}`,
      rows: Array.isArray(v) ? v.length : 0,
      consumed: consumed.has(`db:${t}`),
      allowlisted: false,
      reason: null,
    });
  }
  const unconsumedNonEmpty = keys
    .filter((k) => k.rows > 0 && !k.consumed && !k.allowlisted)
    .map((k) => k.key);
  return {
    keys,
    consumed: keys.filter((k) => k.consumed).length,
    allowlisted: keys.filter((k) => k.allowlisted).length,
    unconsumedNonEmpty,
  };
}
