// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Metric registry: unit tests with no account: the thresholds, the three-step
 * sync-marker resolution, the population gate, the claim-key registry and two
 * invariants: ONE `T.waste_floor`, and `not_checkable` is never a 0.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { currencyScale } from "../shared/currencyScale.js";
import type { AccountModel } from "../model/nodes/AccountNode.js";
import {
  ADS,
  CLAIM_KEYS,
  CHECK_CLAIM_KEYS,
  DAYS_MIN_FOR_WINDOW,
  EVIDENCE,
  LEGACY_COUNT_COLUMNS,
  METRICS,
  PMAX_ASSETS,
  WASTE,
  claimKeyForCheck,
  getMetric,
  isKnownClaimKey,
  normalizeClaimKey,
  notCheckable,
  resolveSyncMarker,
  scaleMoney,
  settledPractical,
  settledStrict,
  statisticalThresholdFromCvr,
  wasteFloorBand,
  windowSpecFor,
  type SyncMarker,
} from "./index.js";

const REGISTRY_DIR = path.dirname(fileURLToPath(import.meta.url));

describe("thresholds: one table, self-contained", () => {
  it("the zero-conv waste bar is BOTH a spend band and a statistical click threshold", () => {
    expect([WASTE.bandUnder1k, WASTE.band1kTo10k, WASTE.band10kTo50k, WASTE.band50kPlus]).toEqual([
      20, 50, 100, 200,
    ]);
    expect(wasteFloorBand(999)).toBe(20);
    expect(wasteFloorBand(3000)).toBe(50);
    expect(wasteFloorBand(10_000)).toBe(100);
    expect(wasteFloorBand(50_000)).toBe(200);
  });

  it("the click threshold solves (1 - cvr)^N = alpha and clamps", () => {
    // 4% conversion rate: ln(0.05) / ln(0.96) = 73.4 -> 74 clicks
    expect(statisticalThresholdFromCvr(0.04)).toBe(74);
    expect(statisticalThresholdFromCvr(0.5)).toBe(WASTE.clicksClampMin);
    expect(statisticalThresholdFromCvr(0.001)).toBe(WASTE.clicksClampMax);
    expect(statisticalThresholdFromCvr(0)).toBe(WASTE.clicksDefault);
  });

  it("evidence tiers: 10 conversions strong, 3 moderate", () => {
    expect([EVIDENCE.strongConv, EVIDENCE.moderateConv]).toEqual([10, 3]); // F.conv_min_for_verdict
  });

  it("the RSA headline floor and the PMax headline floor are the same number", () => {
    expect(ADS.minHeadlines).toBe(PMAX_ASSETS.goodHeadlineFloor);
  });

  it("money thresholds scale through currencyScale; unknown currency is not scaled blind", () => {
    expect(scaleMoney(50, currencyScale("USD"))).toBe(50);
    expect(currencyScale(null).known).toBe(false); // the caller must skip the money floor
  });
});

describe("§A.0 sync markers — status row → the 12 legacy *_count columns → unknown", () => {
  const base = { table: "campaigns", key: "campaigns", rowsSeen: 11 };

  it("step 1: a sync_table_status row wins", () => {
    const m = resolveSyncMarker({
      ...base,
      statusRow: { status: "ok", row_count: 11 },
      legacyCount: 999,
    });
    expect(m).toMatchObject({ status: "ok", rowCount: 11, source: "marker" });
  });

  it("step 1: an error row makes the table not checkable, whatever the legacy count says", () => {
    const m = resolveSyncMarker({
      ...base,
      statusRow: { status: "error", error_message: "42703 column does not exist" },
      legacyCount: 11,
    });
    expect(m).toMatchObject({ status: "error", source: "marker" });
    expect(m.message).toContain("42703");
  });

  it("step 1: an ok table at its row limit keeps the cap text next to an unrelated message", () => {
    const at = { ...base, rowsSeen: 10, cap: 10 };
    const other = resolveSyncMarker({
      ...at,
      statusRow: {
        status: "ok",
        row_count: 10,
        error_message: "coverage partial: campaigns not read: 7",
      },
    });
    expect(other.message).toBe(
      "coverage partial: campaigns not read: 7; the 10 rows provided reached the reader's row limit of 10",
    );
    expect(other.partial).toBe(true);
    // the reader already said which read stopped and why: no bare count next to it
    const why =
      "built from the products read, which stopped at its limit of 10,000 rows, so it is only part of the data";
    const named = resolveSyncMarker({
      ...at,
      statusRow: { status: "ok", row_count: 10, error_message: why },
    });
    expect(named.message).toBe(why);
  });

  it('step 2: a legacy *_count column resolves to ok — a recorded 0 IS a real "synced, found none"', () => {
    const m = resolveSyncMarker({
      table: "ads",
      key: "ads",
      rowsSeen: 0,
      legacyCount: 0,
    });
    expect(m).toMatchObject({ status: "ok", rowCount: 0, source: "legacy" });
  });

  it("step 3: nothing at all → unknown, and CAP truncation never upgrades it", () => {
    const m = resolveSyncMarker({
      table: "search_terms",
      key: "searchTerms",
      rowsSeen: 5000,
      cap: 5000,
    });
    expect(m.status).toBe("unknown");
    expect(m.source).toBe("none");
    expect(m.truncated).toBe(true); // a sample, never a total (rule 4)
    expect(m.rowCount).toBeNull();
  });

  it("exactly the 12 legacy count columns, and no others", () => {
    expect(Object.keys(LEGACY_COUNT_COLUMNS).sort()).toEqual([
      "ad_extensions_count",
      "ad_groups_count",
      "ads_count",
      "campaigns_count",
      "conversion_actions_count",
      "demographic_data_count",
      "device_data_count",
      "geographic_data_count",
      "impression_share_count",
      "keywords_count",
      "search_terms_count",
      "temporal_data_count",
    ]);
  });
});

describe('§A.0 population gate — "population 0 of N" is not "none found"', () => {
  const model = (rows: number, orphans: number): AccountModel =>
    ({
      dataQuality: {
        tables: {
          adPolicyData: {
            rows,
            checkable: "unknown",
            markerRowCount: null,
            errorMessage: null,
            cap: 500,
            truncated: rows >= 500,
            source: "none",
          },
        },
        orphanRows: { adPolicyData: orphans },
      },
    }) as unknown as AccountModel;
  const markers = (status: SyncMarker["status"]): Map<string, SyncMarker> =>
    new Map([
      [
        "adPolicyData",
        {
          table: "ad_policy",
          key: "adPolicyData",
          status,
          rowCount: null,
          source: status === "unknown" ? "none" : "marker",
          message: status === "error" ? "boom" : null,
          rowsSeen: 0,
          cap: null,
          truncated: false,
        },
      ],
    ]);

  it("500 rows, 0 joined → not checkable, naming the population", () => {
    const v = notCheckable(model(500, 500), markers("unknown"), "adPolicyData");
    expect(v.notCheckable).toBe(true);
    expect(v.reason).toContain("none of its 500 rows belong to a campaign");
  });

  it('0 rows and no marker → not checkable, never "none found"', () => {
    const v = notCheckable(model(0, 0), markers("unknown"), "adPolicyData");
    expect(v.notCheckable).toBe(true);
    expect(v.reason).toContain("was not read");
  });

  it("rows with a joined population but no marker → checkable, provisional", () => {
    const v = notCheckable(model(500, 100), markers("unknown"), "adPolicyData");
    expect(v).toMatchObject({ notCheckable: false, markerState: "provisional" });
  });

  it("a marker error is not checkable even when rows joined", () => {
    expect(notCheckable(model(500, 100), markers("error"), "adPolicyData").notCheckable).toBe(true);
  });
});

describe("windows — the model owns the maths, the registry owns the names", () => {
  const aw = {
    start: "2026-06-04",
    end: "2026-09-02",
    days: 91,
    maxLookbackDays: 30,
    lookbackUnknown: false,
    lastSettledDay: "2026-08-03",
    lastSettledDayPractical: "2026-08-26",
    windows: {
      m90: {
        label: "m90",
        start: "2026-06-04",
        end: "2026-09-02",
        days: 91,
        settledStrict: false,
        settledPractical: false,
      },
    },
  } as never;

  it("settledStrict is range_end − max lookback, settledPractical is range_end − 7", () => {
    expect(settledStrict("2026-08-03", aw)).toBe(true);
    expect(settledStrict("2026-08-04", aw)).toBe(false);
    expect(settledPractical("2026-08-26", aw)).toBe(true);
    expect(settledPractical("2026-08-27", aw)).toBe(false);
  });

  it("prior7 is built here; an unknown window name resolves to null, never to the full window", () => {
    expect(windowSpecFor("prior7", aw)).toMatchObject({ start: "2026-08-20", end: "2026-08-26" });
    expect(windowSpecFor("last_quarter", aw)).toBeNull();
  });

  it("F.days_min_for_window is 10 per side (the existing windowsAgree guard)", () => {
    expect(DAYS_MIN_FOR_WINDOW).toBe(10);
  });
});

describe("the registry itself", () => {
  it("T.waste_floor has exactly ONE definition — greps the whole registry for a second", () => {
    expect(METRICS.filter((m) => m.id === "T.waste_floor")).toHaveLength(1);
    const defSites: string[] = [];
    for (const f of fs.readdirSync(REGISTRY_DIR)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = fs.readFileSync(path.join(REGISTRY_DIR, f), "utf8");
      // a second definition would be another `def('T.waste_floor'…)` or a local constant of the same name
      for (const m of src.matchAll(
        /def\(\s*["']T\.waste_floor["']|(?:const|let|function)\s+wasteFloor\b/g,
      ))
        defSites.push(`${f}:${m[0].replace(/\s+/g, "")}`);
    }
    expect(defSites).toEqual(['metrics.ts:def("T.waste_floor"']);
  });

  it("every definition carries the §A columns and a unique id", () => {
    const ids = new Set<string>();
    for (const m of METRICS) {
      expect(ids.has(m.id)).toBe(false);
      ids.add(m.id);
      expect(m.level).toBeTruthy();
      expect(m.unit).toBeTruthy();
      expect(m.definition.length).toBeGreaterThan(0);
      expect(m.sources.length).toBeGreaterThan(0);
      expect(m.window.length).toBeGreaterThan(0);
      expect(["N/A", "U", "S"]).toContain(m.maturityRule);
      expect(typeof m.floor).toBe("string");
      expect(typeof m.formula).toBe("function");
    }
  });

  it("the task aliases resolve to the sheet ids", () => {
    expect(getMetric("A.cost90")!.id).toBe("A.spend");
    expect(getMetric("C.util90")!.id).toBe("C.budget_util90");
    expect(getMetric("A.nonsense")).toBeUndefined();
  });
});

describe("claim keys: the single registry", () => {
  it("every check id has a key, and each key is in CLAIM_KEYS", () => {
    const ids = Object.keys(CHECK_CLAIM_KEYS);
    const known = new Set<string>(Object.values(CLAIM_KEYS));
    for (const id of ids) expect(known.has(CHECK_CLAIM_KEYS[id]!)).toBe(true);
    expect(claimKeyForCheck("SK01")).toBe(CLAIM_KEYS.KEYWORD_ZERO_CONV_WASTE);
    expect(claimKeyForCheck("ZZ99")).toBeNull();
  });

  it("normalizeClaimKey folds case and slashes; an unknown key stays unknown", () => {
    expect(normalizeClaimKey(" Account/Spend ")).toBe("account.spend");
    expect(isKnownClaimKey("ACCOUNT/SPEND")).toBe(true);
    expect(isKnownClaimKey("account.renamed_by_a_model")).toBe(false);
  });
});
