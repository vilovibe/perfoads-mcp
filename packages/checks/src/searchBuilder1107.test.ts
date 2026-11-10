// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * M18 (J33, J40, J41): the SK16 Search bar (8 sitelinks, 10 callouts),
 * AS24 (a spending account changed under 5 times a month for 2+ months) and SK42
 * (a live Search ad mixing Title Case and sentence case headlines: an AI judgement,
 * so the connector reports it as not run). Same rules as the app's checks.
 */
import { describe, expect, it } from "vitest";
import type { CheckResult } from "./engine/checks/types.js";
import { SEARCH_EXTENSION_BAR } from "./engine/registry/thresholds.js";
import type { Row } from "./engine/shared/input.js";
import {
  adGroup,
  buildInput,
  dayBefore,
  LAST_DAY,
  runOne,
  type CampaignSpec,
  type FixtureOptions,
} from "./testing/account.js";

const state = (r: CheckResult) => r.state;
const findingsOf = (r: CheckResult) => (r.state === "fires" ? r.findings : []);

const generic: CampaignSpec = { id: "11", name: "Generic search" };
const groups = [adGroup({ id: "21", campaignId: "11" })];
const account = (opts: Partial<FixtureOptions> = {}, campaigns: CampaignSpec[] = [generic]) =>
  buildInput({ campaigns, ...opts, data: { adGroups: groups, ...(opts.data ?? {}) } });

const ext = (type: string, i: number): Row => ({
  asset_id: `${type}-${i}`,
  extension_type: type,
  level: "CAMPAIGN",
  campaign_id: "11",
  status: "ENABLED",
  text: `${type.toLowerCase()} ${i}`,
});
const set = (sitelinks: number, callouts: number): Row[] => [
  ...Array.from({ length: sitelinks }, (_, i) => ext("SITELINK", i + 1)),
  ...Array.from({ length: callouts }, (_, i) => ext("CALLOUT", i + 1)),
  ext("STRUCTURED_SNIPPET", 1),
];

describe("SK16 Search bar: 8 sitelinks, 10 callouts", () => {
  it("the bar is 8-12 sitelinks and 10-12 callouts", () => {
    expect(SEARCH_EXTENSION_BAR).toEqual({
      SITELINK: { min: 8, max: 12 },
      CALLOUT: { min: 10, max: 12 },
    });
  });
  it("7 sitelinks is short, with the counts the fact card reads", () => {
    const f = findingsOf(runOne("SK16", account({ data: { adExtensions: set(7, 10) } })))[0];
    expect(f?.facts.below_minimum).toBe("SITELINK 7 of 8");
    expect(f?.facts.sitelinks_have).toBe(7);
    expect(f?.facts.sitelinks_want).toBe(8);
    expect(f?.facts.callouts_have).toBe(10);
    expect(f?.facts.callouts_want).toBe(10);
  });
  it("8 sitelinks and 10 callouts is clean, and 12 of each is clean", () => {
    expect(state(runOne("SK16", account({ data: { adExtensions: set(8, 10) } })))).toBe(
      "none_found",
    );
    expect(state(runOne("SK16", account({ data: { adExtensions: set(12, 12) } })))).toBe(
      "none_found",
    );
  });
  it("9 callouts is short", () => {
    const f = findingsOf(runOne("SK16", account({ data: { adExtensions: set(8, 9) } })))[0];
    expect(f?.facts.below_minimum).toBe("CALLOUT 9 of 10");
  });
  it("says business name, logo and images were not checked", () => {
    const r = runOne("SK16", account({ data: { adExtensions: set(8, 10) } }));
    expect(r.state === "none_found" ? r.note : "").toMatch(
      /Business name, logo and image assets are not in our data, so they were not checked/,
    );
  });
});

/** `perDay` people-made changes on each of `days` days back from `from`. */
const changesOver = (
  from: string,
  days: number,
  every: number,
  clientType = "GOOGLE_ADS_WEB_CLIENT",
) =>
  Array.from({ length: days }, (_, i) => i)
    .filter((i) => i % every === 0)
    .map((i) => ({
      change_date_time: `${dayBefore(from, i)} 10:00:00`,
      change_resource_name: "customers/1/campaigns/11",
      resource_type: "CAMPAIGN",
      operation: "UPDATE",
      changed_fields: "name",
      client_type: clientType,
      user_email: "a",
    }));
/** One change on the first day of a 61-day feed, so 2 blocks are readable. */
const reachBack = (clientType = "GOOGLE_ADS_WEB_CLIENT") => ({
  change_date_time: `${dayBefore(LAST_DAY, 60)} 10:00:00`,
  change_resource_name: "customers/1/campaigns/11",
  resource_type: "CAMPAIGN",
  operation: "UPDATE",
  changed_fields: "name",
  client_type: clientType,
  user_email: "a",
});

describe("AS24 a spending account nobody changes", () => {
  it("fires on 4 changes a month for 2 months, with the changes per month", () => {
    // 4 changes in each 30-day block, plus the reach-back row on day 60 (block 3, not full)
    const rows = [...changesOver(LAST_DAY, 60, 8).slice(0, 8), reachBack()];
    const r = runOne("AS24", account({ data: { changeHistory: rows } }));
    expect(state(r)).toBe("fires");
    const f = findingsOf(r)[0];
    expect(f?.facts.quiet_months).toBe(2);
    expect(f?.facts.most_changes_in_a_quiet_month).toBe(4);
    expect(String(f?.facts.changes_per_month)).toMatch(/: 4; .*: 4$/);
  });
  it("is clean with 5 changes in the last month", () => {
    const rows = [...changesOver(LAST_DAY, 30, 6), reachBack()];
    expect(state(runOne("AS24", account({ data: { changeHistory: rows } })))).toBe("none_found");
  });
  it("a quiet last month with no readable month before is insufficient data, never a finding", () => {
    const rows = changesOver(LAST_DAY, 30, 10).concat({
      ...reachBack(),
      change_date_time: `${dayBefore(LAST_DAY, 29)} 10:00:00`,
    });
    expect(state(runOne("AS24", account({ data: { changeHistory: rows } })))).toBe(
      "insufficient_data",
    );
  });
  it("changes Google's automation made do not count as work on the account", () => {
    const rows = [
      ...changesOver(LAST_DAY, 60, 1, "INTERNAL_TOOL"),
      ...changesOver(LAST_DAY, 60, 20),
      reachBack(),
    ];
    expect(state(runOne("AS24", account({ data: { changeHistory: rows } })))).toBe("fires");
  });
  it("is not checkable when the change feed was not read", () => {
    expect(state(runOne("AS24", account()))).toBe("not_checkable");
  });
});

const rsa = (id: string, headlines: string[]): Row => ({
  ad_id: id,
  ad_group_id: "21",
  campaign_id: "11",
  type: "RESPONSIVE_SEARCH_AD",
  status: "ENABLED",
  headlines: headlines.map((text) => ({ text, pinnedField: null })),
  descriptions: [{ text: "Description", pinnedField: null }],
  final_urls: ["https://example.com/collections/mugs"],
  cost: 100,
  clicks: 50,
  impressions: 1000,
  conversions: 2,
  conversion_value: 400,
});

describe("SK42 one casing style per Search ad", () => {
  it("fix round: never a code verdict; not run with a plain reason, even on a clear mix", () => {
    const ads = [
      rsa("41", [
        "Free Shipping On All Orders",
        "Handmade Leather Mugs Today",
        "Soft mugs that last",
      ]),
    ];
    const r = runOne("SK42", account({ data: { ads } }));
    expect(state(r)).toBe("not_checkable");
    expect(findingsOf(r)).toHaveLength(0);
    expect(JSON.stringify(r)).toMatch(/needs an AI read of the ad text/);
  });
  it("fix round: a German ad is never flagged", () => {
    const ads = [
      rsa("41", ["Handgemachte Ledergürtel", "Gürtel für Damen und Herren", "Kostenloser Versand"]),
    ];
    const r = runOne("SK42", account({ data: { ads } }));
    expect(state(r)).toBe("not_checkable");
    expect(findingsOf(r)).toHaveLength(0);
  });
  it("is not checkable when the ads were not read", () => {
    expect(state(runOne("SK42", account()))).toBe("not_checkable");
  });
});
