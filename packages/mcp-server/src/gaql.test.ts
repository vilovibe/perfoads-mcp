// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, guardGaql, replyPathOf, withSelectedFields } from "./gaql.js";
import { GAQL_RESOURCES } from "./gaqlResources.js";

const accepted: [string, string, string][] = [
  [
    "plain select, LIMIT added",
    "SELECT campaign.id, campaign.name FROM campaign",
    "SELECT campaign.id, campaign.name FROM campaign LIMIT 200",
  ],
  [
    "lowercase keywords",
    "select campaign.id from campaign where campaign.status = 'ENABLED' limit 10",
    "SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED' LIMIT 10",
  ],
  [
    "WHERE, ORDER BY, LIMIT",
    "SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS ORDER BY metrics.clicks DESC LIMIT 50",
    "SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS ORDER BY metrics.clicks DESC LIMIT 50",
  ],
  [
    "keywords and ; inside a quoted value are just text",
    "SELECT campaign.id FROM campaign WHERE campaign.name = 'DELETE; -- /* LIMIT 9 */' LIMIT 5",
    "SELECT campaign.id FROM campaign WHERE campaign.name = 'DELETE; -- /* LIMIT 9 */' LIMIT 5",
  ],
  [
    "escaped quote inside a value",
    "SELECT campaign.id FROM campaign WHERE campaign.name = 'it\\'s' LIMIT 5",
    "SELECT campaign.id FROM campaign WHERE campaign.name = 'it\\'s' LIMIT 5",
  ],
  [
    "one trailing semicolon",
    "SELECT customer.id FROM customer LIMIT 1;",
    "SELECT customer.id FROM customer LIMIT 1",
  ],
  [
    "oversized LIMIT is lowered to 1000",
    "SELECT ad_group.id FROM ad_group LIMIT 50000",
    "SELECT ad_group.id FROM ad_group LIMIT 1000",
  ],
  [
    "PARAMETERS clause",
    "SELECT campaign.id FROM campaign LIMIT 10 PARAMETERS include_drafts=true",
    "SELECT campaign.id FROM campaign LIMIT 10 PARAMETERS include_drafts = true",
  ],
  [
    "multi-line query",
    "SELECT\n  search_term_view.search_term,\n  metrics.cost_micros\nFROM search_term_view\nWHERE segments.date DURING LAST_30_DAYS",
    "SELECT search_term_view.search_term, metrics.cost_micros FROM search_term_view WHERE segments.date DURING LAST_30_DAYS LIMIT 200",
  ],
];

const rejected: [string, string, RegExp][] = [
  ["UPDATE", "UPDATE campaign SET campaign.status = 'PAUSED'", /Only SELECT/],
  ["DELETE", "DELETE FROM campaign WHERE campaign.id = 1", /Only SELECT/],
  ["chained statements", "SELECT campaign.id FROM campaign; DELETE FROM campaign", /one statement/],
  [
    "two SELECTs",
    "SELECT campaign.id FROM campaign LIMIT 1; SELECT ad_group.id FROM ad_group",
    /one statement/,
  ],
  ["-- comment", "SELECT campaign.id FROM campaign -- LIMIT 5", /Comments/],
  [
    "/* comment */ hiding a statement",
    "SELECT campaign.id /* ; DELETE */ FROM campaign",
    /Comments/,
  ],
  ["# comment", "SELECT campaign.id FROM campaign # x", /Comments/],
  ["comment before SELECT", "/* x */ SELECT campaign.id FROM campaign", /Comments/],
  ["unknown resource", "SELECT foo.id FROM foo_bar_view", /not a Google Ads resource/],
  ["uppercase resource", "SELECT campaign.id FROM CAMPAIGN", /not a Google Ads resource/],
  ["metrics is not a resource", "SELECT metrics.clicks FROM metrics", /not a Google Ads resource/],
  ["LIMIT 0", "SELECT campaign.id FROM campaign LIMIT 0", /whole number/],
  ["LIMIT not a number", "SELECT campaign.id FROM campaign LIMIT ALL", /whole number/],
  ["negative LIMIT", "SELECT campaign.id FROM campaign LIMIT -5", /whole number/],
  [
    "two LIMITs",
    "SELECT campaign.id FROM campaign WHERE campaign.id > 1 LIMIT 5 LIMIT 9000",
    /once each/,
  ],
  [
    "unknown PARAMETERS key",
    "SELECT campaign.id FROM campaign PARAMETERS validate_only=true",
    /PARAMETERS accepts/,
  ],
  [
    "PARAMETERS bad value",
    "SELECT campaign.id FROM campaign PARAMETERS include_drafts=yes",
    /PARAMETERS accepts/,
  ],
  [
    "sub-query",
    "SELECT campaign.id FROM campaign WHERE campaign.id IN (SELECT ad_group.campaign FROM ad_group)",
    /Sub-queries/,
  ],
  ["star select", "SELECT * FROM campaign", /not a GAQL field/],
  ["function in fields", "SELECT COUNT(campaign.id) FROM campaign", /not a GAQL field/],
  ["unclosed quote", "SELECT campaign.id FROM campaign WHERE campaign.name = 'x", /never closed/],
  ["look-alike letters", "SELECT campaign.id FROM cаmpaign", /characters/],
  ["empty", "   ", /empty/],
  ["no FROM", "SELECT campaign.id", /not a GAQL query/],
  ["ORDER BY expression", "SELECT campaign.id FROM campaign ORDER BY 1; x", /one statement/],
  ["bad ORDER BY", "SELECT campaign.id FROM campaign ORDER BY campaign.id SIDEWAYS", /ORDER BY/],
  [
    "too long",
    `SELECT campaign.id FROM campaign WHERE campaign.name = '${"x".repeat(10_001)}'`,
    /too long/,
  ],
];

describe("guardGaql", () => {
  it.each(accepted)("accepts: %s", (_, input, expected) => {
    const res = guardGaql(input);
    expect(res).toMatchObject({ ok: true, query: expected });
  });

  it.each(rejected)("rejects: %s", (_, input, reason) => {
    const res = guardGaql(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(reason);
  });

  it.each([
    "SELECT change_event.user_email FROM change_event WHERE change_event.change_date_time >= '2026-10-20' LIMIT 10",
    "SELECT customer_user_access.email_address FROM customer_user_access",
    "SELECT customer_user_access.inviter_user_email_address FROM customer_user_access",
    "SELECT customer_user_access_invitation.email_address FROM customer_user_access_invitation",
    "SELECT customer_user_access.access_role FROM customer_user_access WHERE customer_user_access.email_address LIKE '%@example.com'",
    "SELECT change_event.change_date_time FROM change_event ORDER BY change_event.user_EMAIL",
  ])("never reads email fields (personal data): %s", (input) => {
    const res = guardGaql(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/Email address fields can't be read/);
  });

  it.each([
    "SELECT local_services_lead.contact_details FROM local_services_lead",
    "SELECT lead_form_submission_data.lead_form_submission_fields FROM lead_form_submission_data",
    "SELECT lead_form_submission_data.custom_lead_form_submission_fields FROM lead_form_submission_data",
    "SELECT local_services_lead_conversation.message_details.text FROM local_services_lead_conversation",
    "SELECT local_services_employee.first_name FROM local_services_employee",
    "SELECT local_services_verification_artifact.id FROM local_services_verification_artifact",
    "SELECT call_view.caller_area_code, call_view.call_duration_seconds FROM call_view",
    "SELECT click_view.gclid FROM click_view WHERE segments.date = '2026-10-24'",
    "SELECT campaign.id FROM campaign WHERE local_services_lead.id = 1",
  ])("never reads personal data of leads, callers, clicks or staff: %s", (input) => {
    const res = guardGaql(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/holds personal data/);
  });

  it("those resources are not on the allowlist either", () => {
    for (const r of [
      "lead_form_submission_data",
      "local_services_lead",
      "local_services_lead_conversation",
      "local_services_employee",
      "local_services_verification_artifact",
    ]) {
      expect(GAQL_RESOURCES.has(r), r).toBe(false);
    }
    expect(guardGaql("SELECT call_view.call_duration_seconds FROM call_view").ok).toBe(true);
  });

  it("recommendations are not a resource it reads", () => {
    for (const input of [
      "SELECT recommendation.type, recommendation.campaign FROM recommendation",
      "SELECT recommendation.resource_name FROM recommendation LIMIT 10",
    ]) {
      expect(guardGaql(input).ok, input).toBe(false);
    }
    expect(GAQL_RESOURCES.has("recommendation")).toBe(false);
  });

  it.each([
    "SELECT campaign_budget.recommended_budget_amount_micros FROM campaign_budget",
    "SELECT campaign_budget.id, campaign_budget.recommended_budget_estimated_change_weekly_clicks FROM campaign_budget",
    "SELECT campaign.id, campaign_budget.recommended_budget_amount_micros FROM campaign",
    "SELECT campaign_budget.id FROM campaign_budget WHERE campaign_budget.has_recommended_budget = TRUE",
    "SELECT customer.optimization_score FROM customer",
    "SELECT customer.id, customer.optimization_score_weight FROM customer",
    "SELECT campaign.id FROM campaign ORDER BY campaign.optimization_score DESC",
  ])("never reads Google's own suggestions: %s", (input) => {
    const res = guardGaql(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/Google's own suggestions/);
  });

  it("auto-apply settings (recommendation_subscription) stay readable", () => {
    expect(
      guardGaql(
        "SELECT recommendation_subscription.type, recommendation_subscription.status FROM recommendation_subscription",
      ).ok,
    ).toBe(true);
  });

  it("a quoted value that says recommended is fine", () => {
    expect(
      guardGaql("SELECT campaign.id FROM campaign WHERE campaign.name = 'recommended picks'").ok,
    ).toBe(true);
  });

  it("a quoted value that says email is fine", () => {
    expect(
      guardGaql("SELECT campaign.id FROM campaign WHERE campaign.name = 'email signup'").ok,
    ).toBe(true);
  });

  it("explains LIMIT changes in notes", () => {
    const added = guardGaql("SELECT campaign.id FROM campaign");
    expect(added.ok && added.notes[0]).toMatch(/LIMIT 200 was added/);
    const capped = guardGaql("SELECT campaign.id FROM campaign LIMIT 5000");
    expect(capped.ok && capped.limit).toBe(1000);
    expect(capped.ok && capped.notes[0]).toMatch(/LIMIT 1000 was used/);
  });
});

describe("cursor", () => {
  const q = "SELECT campaign.id FROM campaign LIMIT 200";

  it("round-trips for the same query and account", () => {
    expect(decodeCursor(encodeCursor("1234567890", q, 50), "1234567890", q)).toEqual({
      offset: 50,
    });
  });

  it("refuses another query, another account, or junk", () => {
    const c = encodeCursor("1234567890", q, 50);
    expect(decodeCursor(c, "1111111111", q)).toHaveProperty("error");
    expect(decodeCursor(c, "1234567890", `${q} `)).toHaveProperty("error");
    expect(decodeCursor("not-a-cursor", "1234567890", q)).toHaveProperty("error");
  });
});

describe("every selected field in every row", () => {
  const query =
    "SELECT segments.date, segments.product_item_id, metrics.cost_micros FROM shopping_performance_view";

  it("the guard hands back the selected fields", () => {
    const g = guardGaql(query);
    expect(g.ok && g.fields).toEqual([
      "segments.date",
      "segments.product_item_id",
      "metrics.cost_micros",
    ]);
  });

  it("maps a field to the reply's camelCase keys", () => {
    expect(replyPathOf("segments.product_item_id")).toEqual(["segments", "productItemId"]);
    expect(replyPathOf("shopping_performance_view.resource_name")).toEqual([
      "shoppingPerformanceView",
      "resourceName",
    ]);
    expect(replyPathOf("product_custom_attribute0")).toEqual(["productCustomAttribute0"]);
  });

  it("keeps the segments Google sent and sets the ones it left out to null", () => {
    const g = guardGaql(query);
    if (!g.ok) throw new Error("refused");
    const sent = {
      shoppingPerformanceView: { resourceName: "customers/1234567890/shoppingPerformanceView" },
      segments: { date: "2026-11-02", productItemId: "shopify_us_111_222" },
      metrics: { costMicros: "7719918" },
    };
    expect(withSelectedFields(sent, g.fields)).toEqual(sent);
    // Google leaves out an empty segment and a zero metric; a row may carry no segments at all
    expect(withSelectedFields({ segments: { date: "2026-11-02" } }, g.fields)).toEqual({
      segments: { date: "2026-11-02", productItemId: null },
      metrics: { costMicros: null },
    });
    expect(withSelectedFields({ metrics: { costMicros: "1000" } }, g.fields)).toEqual({
      segments: { date: null, productItemId: null },
      metrics: { costMicros: "1000" },
    });
  });

  it("never changes the row it was given", () => {
    const row = { metrics: {} };
    withSelectedFields(row, ["metrics.clicks", "segments.date"]);
    expect(row).toEqual({ metrics: {} });
  });
});
