// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { AdsNetworkError, GoogleAdsApiError } from "./errors.js";
import { FAKE_CUSTOMER, campaignRow, errorBody, makeClient } from "./testing/fakes.js";

const query = "SELECT campaign.id, campaign.name FROM campaign";
const page = (ids: string[], nextPageToken?: string) => ({
  body: {
    results: ids.map((id) => campaignRow(id, `Campaign ${id}`)),
    fieldMask: "campaign.id,campaign.name",
    ...(nextPageToken ? { nextPageToken } : {}),
  },
});

describe("searchAll pagination", () => {
  it("follows page tokens to the end, one operation per page", async () => {
    const { client, calls } = makeClient([
      page(["1", "2"], "TOKEN-2"),
      page(["3"], "TOKEN-3"),
      page(["4"]),
    ]);
    const res = await client.searchAll({ customerId: FAKE_CUSTOMER, query });
    expect(res.rows.map((r) => (r.campaign as { id: string }).id)).toEqual(["1", "2", "3", "4"]);
    expect(res.pages).toBe(3);
    expect(res.truncated).toBe(false);
    expect(calls.map((c) => c.body)).toEqual([
      { query },
      { query, pageToken: "TOKEN-2" },
      { query, pageToken: "TOKEN-3" },
    ]);
  });

  it("stops at maxRows and returns the token to resume", async () => {
    const { client, calls } = makeClient([
      page(["1", "2"], "TOKEN-2"),
      page(["3", "4"], "TOKEN-3"),
    ]);
    const res = await client.searchAll({ customerId: FAKE_CUSTOMER, query, maxRows: 3 });
    expect(res.rows).toHaveLength(3);
    expect(res.truncated).toBe(true);
    expect(res.nextPageToken).toBe("TOKEN-3");
    expect(calls).toHaveLength(2);
  });

  it("shouldStop ends the paging before the next page, with the token to resume", async () => {
    const { client, calls } = makeClient([page(["1", "2"], "TOKEN-2"), page(["3"])]);
    const res = await client.searchAll({
      customerId: FAKE_CUSTOMER,
      query,
      shouldStop: () => true,
    });
    expect(res).toMatchObject({ truncated: true, stoppedEarly: true, nextPageToken: "TOKEN-2" });
    expect(res.rows).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it("an abort stops the request in flight and is not retried", async () => {
    const { client, calls } = makeClient([{ hang: true }, page(["1"])]);
    const controller = new AbortController();
    const pending = client.searchAll({
      customerId: FAKE_CUSTOMER,
      query,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AdsNetworkError);
    expect(calls).toHaveLength(1);
  });

  it("an aborted signal never sends", async () => {
    const { client, calls } = makeClient([page(["1"])]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.searchAll({ customerId: FAKE_CUSTOMER, query, signal: controller.signal }),
    ).rejects.toThrow(/stopped before it was sent/);
    expect(calls).toHaveLength(0);
  });

  it("handles an empty result (Google omits results)", async () => {
    const { client } = makeClient([{ body: { fieldMask: "campaign.id" } }]);
    const res = await client.searchAll({ customerId: FAKE_CUSTOMER, query });
    expect(res.rows).toEqual([]);
  });

  it("a page that fails after retries fails the whole call", async () => {
    const { client } = makeClient([
      page(["1"], "TOKEN-2"),
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    await expect(client.searchAll({ customerId: FAKE_CUSTOMER, query })).rejects.toBeInstanceOf(
      GoogleAdsApiError,
    );
  });
});

describe("searchStream", () => {
  it("joins all batches", async () => {
    const { client, calls } = makeClient([
      { body: [{ results: [campaignRow("1", "A")] }, { results: [campaignRow("2", "B")] }] },
    ]);
    const rows = await client.searchStream({ customerId: FAKE_CUSTOMER, query });
    expect(rows).toHaveLength(2);
    expect(calls[0]?.url).toMatch(/googleAds:searchStream$/);
  });

  it("throws when the stream ends in an error batch", async () => {
    const failed = errorBody(400, "INVALID_ARGUMENT", [
      { type: "queryError", value: "PROHIBITED_RESOURCE_TYPE_IN_SELECT_CLAUSE" },
    ]);
    const { client } = makeClient([{ body: [{ results: [campaignRow("1", "A")] }, failed] }]);
    const err = await client.searchStream({ customerId: FAKE_CUSTOMER, query }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAdsApiError);
    expect(err.httpStatus).toBe(400);
    expect(err.details[0].errorCode).toEqual({
      type: "queryError",
      value: "PROHIBITED_RESOURCE_TYPE_IN_SELECT_CLAUSE",
    });
  });
});
