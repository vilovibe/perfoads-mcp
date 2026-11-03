// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Google refuses a query on some resources when a field it filters on is not selected too
// ("The following field must be present in SELECT clause: 'campaign.status'"), seen live on
// geographic_view, campaign_asset and ad_group_asset. Every such query here selects what it
// filters on.

import { describe, expect, it } from "vitest";
import { filterInput } from "./common.js";
import { assetLinksQuery } from "./readers/adsAssets.js";
import { countriesQuery } from "./readers/geoLanguages.js";

const fieldsOf = (query: string) => {
  const flat = query.replace(/\s+/g, " ");
  const select = /SELECT (.*?) FROM /.exec(flat)?.[1] ?? "";
  const where = /WHERE (.*?)(?: ORDER BY | LIMIT |$)/.exec(flat)?.[1] ?? "";
  return {
    selected: new Set(select.split(",").map((f) => f.trim())),
    filtered: [...where.matchAll(/\b((?:campaign|ad_group)\.status)\b/g)].map((m) => m[1]),
  };
};

const input = filterInput({ date_range: "2026-07-27..2026-10-24" });

describe("queries select the status fields they filter on", () => {
  it.each([
    ["geographic_view", countriesQuery(input)],
    ["campaign_asset (full)", assetLinksQuery("campaign", input, true)],
    ["campaign_asset (ids)", assetLinksQuery("campaign", input, false)],
    ["ad_group_asset (full)", assetLinksQuery("ad_group", input, true)],
    ["ad_group_asset (ids)", assetLinksQuery("ad_group", input, false)],
  ])("%s", (_name, query) => {
    const { selected, filtered } = fieldsOf(query);
    expect(filtered.length).toBeGreaterThan(0);
    for (const f of filtered) expect(selected).toContain(f);
  });
});
