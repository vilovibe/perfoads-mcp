// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { localDateTime } from "./time.js";

describe("localDateTime", () => {
  it("formats in the given time zone, across the autumn clock change", () => {
    // 01:28 UTC on 25 Oct 2026 is after the change (winter time, UTC+1) ...
    expect(localDateTime(Date.parse("2026-10-25T01:28:00Z"), "Europe/Amsterdam")).toBe(
      "2026-10-25 02:28:00",
    );
    // ... and 00:28 UTC, an hour earlier, shows the same wall time (summer time, UTC+2).
    expect(localDateTime(Date.parse("2026-10-25T00:28:00Z"), "Europe/Amsterdam")).toBe(
      "2026-10-25 02:28:00",
    );
    expect(localDateTime(Date.parse("2026-10-25T01:28:00Z"), "Pacific/Auckland")).toBe(
      "2026-10-25 14:28:00",
    );
    expect(localDateTime(Date.parse("2026-10-25T01:28:00Z"), "UTC")).toBe("2026-10-25 01:28:00");
  });
});
