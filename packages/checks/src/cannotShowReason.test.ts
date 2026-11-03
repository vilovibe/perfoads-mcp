// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { cannotShowReason, type FeedStatus } from "./engine/checks/shopping.js";

const row = (o: Partial<FeedStatus>): FeedStatus => ({
  status: "NOT_ELIGIBLE",
  feedLabel: "US",
  merchantId: "1",
  availability: "IN_STOCK",
  issueCodes: [],
  ...o,
});

describe("cannotShowReason (SH01)", () => {
  it("an eligible row can show", () => {
    expect(cannotShowReason(row({ status: "ELIGIBLE" }))).toBeNull();
  });
  it("a row in no live campaign is not advertised", () => {
    expect(cannotShowReason(row({ issueCodes: ["not_eligible_in_any_campaign"] }))).toBe(
      "not_advertised",
    );
  });
  it("a sold-out row is out of stock", () => {
    expect(
      cannotShowReason(
        row({ availability: "OUT_OF_STOCK", issueCodes: ["not_eligible_out_of_stock"] }),
      ),
    ).toBe("out_of_stock");
  });
  it("a sold-out row that also has a feed error is blocked: restocking alone would not let it show", () => {
    expect(
      cannotShowReason(
        row({
          availability: "OUT_OF_STOCK",
          issueCodes: ["disclosure_date_not_supported", "not_eligible_out_of_stock"],
        }),
      ),
    ).toBe("blocked");
  });
  it("issues not read is said as such", () => {
    expect(cannotShowReason(row({ issueCodes: null }))).toBe("reason_not_read");
  });
});
