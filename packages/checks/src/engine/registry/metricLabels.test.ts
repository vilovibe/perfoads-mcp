// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { METRIC_LABELS, metricLabel, plainMetricText } from "./metricLabels.js";
import { METRICS } from "./metrics.js";

describe("metric labels", () => {
  it("every metric id has a plain label, and no label names an id", () => {
    for (const m of METRICS) {
      expect(METRIC_LABELS[m.id], m.id).toBeTruthy();
      expect(METRIC_LABELS[m.id]).not.toMatch(/\b[A-Z][A-Za-z]{0,2}\.[a-z_]/);
    }
    expect(Object.keys(METRIC_LABELS).length).toBe(METRICS.length);
  });
  it("reads ids with arguments and sub-keys", () => {
    expect(metricLabel("C.window(w).cost")).toBe("campaign results in the period compared: cost");
    expect(metricLabel("A.spend_monthly")).toBe("monthly account spend");
    expect(metricLabel("not a metric")).toBeNull();
    const text = plainMetricText(
      "T.waste_floor is not_checkable: no spend; A.spend_monthly and W.max_lookback_days; SL.audience(scope, criterion).cost",
    );
    expect(text).not.toMatch(/T\.waste_floor|A\.spend_monthly|W\.|SL\./);
    expect(text).toContain("monthly account spend");
  });
  it("never touches a Google Ads name, even one that reads like a metric id", () => {
    const name = "A.spend_monthly is not_checkable SALE_2026";
    const text = plainMetricText(`"${name}" needs A.spend_monthly; it is not_checkable`, [
      name,
      "Brand",
    ]);
    expect(text).toBe(`"${name}" needs monthly account spend; it cannot be worked out`);
  });
});
