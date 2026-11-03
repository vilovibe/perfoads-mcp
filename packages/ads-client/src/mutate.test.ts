// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { AdsInDoubtError, GoogleAdsApiError } from "./errors.js";
import { createTempIds, tempResourceName } from "./mutate.js";
import { FAKE_CUSTOMER, errorBody, makeClient, partialFailureError } from "./testing/fakes.js";

const C = FAKE_CUSTOMER;
const negative = (text: string) => ({
  create: {
    campaign: `customers/${C}/campaigns/111`,
    negative: true,
    keyword: { text, matchType: "PHRASE" },
  },
});

describe("validateOnly", () => {
  it("sends validateOnly: true and reports every operation as accepted", async () => {
    const { client, calls } = makeClient([{ body: {} }]);
    const res = await client.mutate("campaignCriteria", [negative("free"), negative("cheap")], {
      customerId: C,
      validateOnly: true,
    });
    expect(calls[0]?.body).toEqual({
      operations: [negative("free"), negative("cheap")],
      validateOnly: true,
    });
    expect(res.validateOnly).toBe(true);
    expect(res.results.map((r) => r.ok)).toEqual([true, true]);
  });

  it("a refused check throws with the plain reason and changes nothing", async () => {
    const { client } = makeClient([
      {
        status: 400,
        body: errorBody(400, "INVALID_ARGUMENT", [
          {
            type: "fieldError",
            value: "REQUIRED",
            message: "The required field was not present.",
            path: [["operations", 0], ["create"], ["keyword"], ["text"]],
          },
        ]),
      },
    ]);
    const err = await client
      .mutate("campaignCriteria", [negative("")], { customerId: C, validateOnly: true })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAdsApiError);
    expect(err.message).toBe(
      'A required field is missing. Google said: "The required field was not present." (field: operations[0].create.keyword.text)',
    );
    expect(err.details[0].operationIndex).toBe(0);
    expect(err.googleRequestId).toBe("fake-request-id");
  });

  it("is safe to retry, so a 503 on a check is retried instead of going in_doubt", async () => {
    const { client, calls } = makeClient([{ status: 503 }, { body: {} }]);
    const res = await client.mutate("campaignCriteria", [negative("free")], {
      customerId: C,
      validateOnly: true,
    });
    expect(res.results[0]?.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("partial failure", () => {
  it("parses per-operation results: ok ones keep their resource name, failed ones their errors", async () => {
    const { client, calls } = makeClient([
      {
        body: {
          results: [
            { resourceName: `customers/${C}/campaignCriteria/111~1` },
            {},
            { resourceName: `customers/${C}/campaignCriteria/111~3` },
          ],
          partialFailureError: partialFailureError([
            {
              type: "criterionError",
              value: "KEYWORD_HAS_INVALID_CHARS",
              path: [["operations", 1], ["create"], ["keyword"], ["text"]],
            },
          ]),
        },
      },
    ]);
    const res = await client.mutate(
      "campaignCriteria",
      [negative("a"), negative("b!!"), negative("c")],
      { customerId: C, partialFailure: true },
    );
    expect(calls[0]?.body).toMatchObject({ partialFailure: true });
    expect(res.failedCount).toBe(1);
    expect(res.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(res.results[0]?.resourceName).toBe(`customers/${C}/campaignCriteria/111~1`);
    expect(res.results[1]?.errors[0]).toMatchObject({
      errorCode: { type: "criterionError", value: "KEYWORD_HAS_INVALID_CHARS" },
      fieldPath: "operations[1].create.keyword.text",
      operationIndex: 1,
    });
    expect(res.requestErrors).toEqual([]);
  });

  it("keeps partial-failure errors that point at no operation as request errors", async () => {
    const { client } = makeClient([
      {
        body: {
          results: [{}],
          partialFailureError: partialFailureError([{ type: "requestError", value: "UNKNOWN" }]),
        },
      },
    ]);
    const res = await client.mutate("campaignCriteria", [negative("a")], {
      customerId: C,
      partialFailure: true,
    });
    expect(res.requestErrors).toHaveLength(1);
  });
});

describe("GoogleAdsService.Mutate (atomic, temporary ids)", () => {
  it("builds one request where the campaign points at the budget created before it", async () => {
    const nextId = createTempIds();
    const budget = tempResourceName(C, "campaignBudgets", nextId());
    const campaign = tempResourceName(C, "campaigns", nextId());
    const ops = [
      {
        campaignBudgetOperation: {
          create: {
            resourceName: budget,
            name: "Budget 1",
            amountMicros: "50000000",
            explicitlyShared: false,
          },
        },
      },
      {
        campaignOperation: {
          create: {
            resourceName: campaign,
            name: "Campaign 1",
            status: "PAUSED",
            advertisingChannelType: "SEARCH",
            campaignBudget: budget,
            manualCpc: {},
          },
        },
      },
    ];
    const { client, calls } = makeClient([
      {
        body: {
          mutateOperationResponses: [
            { campaignBudgetResult: { resourceName: `customers/${C}/campaignBudgets/222` } },
            { campaignResult: { resourceName: `customers/${C}/campaigns/333` } },
          ],
        },
      },
    ]);
    const res = await client.mutateAll(ops, { customerId: C });
    expect(budget).toBe(`customers/${C}/campaignBudgets/-1`);
    expect(campaign).toBe(`customers/${C}/campaigns/-2`);
    expect(calls[0]?.url).toMatch(new RegExp(`/customers/${C}/googleAds:mutate$`));
    expect(calls[0]?.body).toEqual({ mutateOperations: ops });
    expect(res.results.map((r) => r.resourceName)).toEqual([
      `customers/${C}/campaignBudgets/222`,
      `customers/${C}/campaigns/333`,
    ]);
  });

  it("an atomic failure throws and names the failing operation", async () => {
    const { client } = makeClient([
      {
        status: 400,
        body: errorBody(400, "INVALID_ARGUMENT", [
          {
            type: "campaignError",
            value: "DUPLICATE_CAMPAIGN_NAME",
            path: [["mutate_operations", 1], ["campaign_operation"], ["create"], ["name"]],
          },
        ]),
      },
    ]);
    const err = await client
      .mutateAll(
        [{ campaignBudgetOperation: { create: {} } }, { campaignOperation: { create: {} } }],
        { customerId: C },
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAdsApiError);
    expect(err.details[0].operationIndex).toBe(1);
  });

  it("refuses two creates with the same temporary id before sending", async () => {
    const { client, calls } = makeClient([{ body: {} }]);
    const rn = tempResourceName(C, "campaignBudgets", -1);
    await expect(
      client.mutateAll(
        [
          { campaignBudgetOperation: { create: { resourceName: rn } } },
          { campaignBudgetOperation: { create: { resourceName: rn } } },
        ],
        { customerId: C },
      ),
    ).rejects.toThrow(/temporary id used for two creates/);
    expect(calls).toHaveLength(0);
  });

  it("temporary ids must be negative", () => {
    expect(() => tempResourceName(C, "campaigns", 5)).toThrow(RangeError);
  });

  it("a write that times out is in_doubt and is not resent", async () => {
    const { client, calls } = makeClient([{ hang: true }, { body: {} }], { timeoutMs: 20 });
    await expect(
      client.mutateAll([{ campaignBudgetOperation: { create: {} } }], { customerId: C }),
    ).rejects.toBeInstanceOf(AdsInDoubtError);
    expect(calls).toHaveLength(1);
  });
});

describe("MUTABLE_RESOURCE", () => {
  it("asks for the changed resource and returns it (per-service mutate)", async () => {
    const { client, calls } = makeClient([
      {
        body: {
          results: [
            {
              resourceName: `customers/${C}/campaignBudgets/222`,
              campaignBudget: {
                resourceName: `customers/${C}/campaignBudgets/222`,
                amountMicros: "75000000",
              },
            },
          ],
        },
      },
    ]);
    const res = await client.mutate(
      "campaignBudgets",
      [
        {
          update: { resourceName: `customers/${C}/campaignBudgets/222`, amountMicros: "75000000" },
          updateMask: "amount_micros",
        },
      ],
      { customerId: C, responseContentType: "MUTABLE_RESOURCE" },
    );
    expect(calls[0]?.body).toMatchObject({ responseContentType: "MUTABLE_RESOURCE" });
    expect(res.results[0]?.resource).toEqual({
      resourceName: `customers/${C}/campaignBudgets/222`,
      amountMicros: "75000000",
    });
  });

  it("returns the resource from GoogleAdsService.Mutate too", async () => {
    const { client } = makeClient([
      {
        body: {
          mutateOperationResponses: [
            {
              campaignResult: {
                resourceName: `customers/${C}/campaigns/333`,
                campaign: { status: "PAUSED" },
              },
            },
          ],
        },
      },
    ]);
    const res = await client.mutateAll([{ campaignOperation: { update: {} } }], {
      customerId: C,
      responseContentType: "MUTABLE_RESOURCE",
    });
    expect(res.results[0]?.resource).toEqual({ status: "PAUSED" });
  });
});

describe("removeIdempotent", () => {
  const names = [
    `customers/${C}/campaignCriteria/111~1`,
    `customers/${C}/campaignCriteria/111~2`,
    `customers/${C}/campaignCriteria/111~3`,
  ];

  it("treats RESOURCE_NOT_FOUND as already removed and keeps real failures", async () => {
    const { client, calls } = makeClient([
      {
        body: {
          results: [{ resourceName: names[0] }, {}, {}],
          partialFailureError: partialFailureError([
            {
              type: "mutateError",
              value: "RESOURCE_NOT_FOUND",
              path: [["operations", 1], ["remove"]],
            },
            {
              type: "mutateError",
              value: "RESOURCE_TEMPORARILY_NOT_FOUND",
              path: [["operations", 2], ["remove"]],
            },
          ]),
        },
      },
    ]);
    const res = await client.removeIdempotent("campaignCriteria", names, { customerId: C });
    expect(calls[0]?.body).toEqual({
      operations: names.map((remove) => ({ remove })),
      partialFailure: true,
    });
    expect(res.results.map((r) => r.outcome)).toEqual(["removed", "already_removed", "failed"]);
  });

  it("a whole-request RESOURCE_NOT_FOUND on one remove is success", async () => {
    const { client } = makeClient([
      {
        status: 400,
        body: errorBody(400, "INVALID_ARGUMENT", [
          {
            type: "mutateError",
            value: "RESOURCE_NOT_FOUND",
            path: [["operations", 0], ["remove"]],
          },
        ]),
      },
    ]);
    const res = await client.removeIdempotent("campaignCriteria", names.slice(0, 1), {
      customerId: C,
    });
    expect(res.results[0]?.outcome).toBe("already_removed");
  });

  it("any other refusal still throws", async () => {
    const { client } = makeClient([
      {
        status: 403,
        body: errorBody(403, "PERMISSION_DENIED", [
          { type: "authorizationError", value: "USER_PERMISSION_DENIED" },
        ]),
      },
    ]);
    await expect(
      client.removeIdempotent("campaignCriteria", names, { customerId: C }),
    ).rejects.toThrow(/can't reach this account/);
  });
});

describe("input checks", () => {
  it("refuses a bad service name and an empty operation list", async () => {
    const { client, calls } = makeClient([{ body: {} }]);
    await expect(client.mutate("campaigns/../x", [{}], { customerId: C })).rejects.toThrow(
      TypeError,
    );
    await expect(client.mutate("campaigns", [], { customerId: C })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});
