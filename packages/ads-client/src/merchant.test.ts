// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { createMerchantClient, merchantAccessProblem, MERCHANT_API_HOST } from "./merchant.js";
import { captureLogger, FAKE_ACCESS_TOKEN, fakeFetch, type Reply } from "./testing/fakes.js";
import type { OpsCounter } from "./types.js";

const MID = "5550001";
const SOURCE = `accounts/${MID}/dataSources/200`;
const P = {
  restId: "en~US~demo_US_1_1",
  offerId: "demo_US_1_1",
  contentLanguage: "en",
  feedLabel: "US",
};

const client = (replies: Reply[]) => {
  const { calls, fetch } = fakeFetch(replies);
  const counted: number[] = [];
  const ops: OpsCounter = {
    record: (n) => counted.push(n),
    used: () => 0,
    remaining: () => 0,
  };
  const mc = createMerchantClient({
    tokens: { getAccessToken: async () => FAKE_ACCESS_TOKEN },
    fetch,
    logger: captureLogger().logger,
    opsCounter: ops,
    sleep: async () => {},
    random: () => 0,
  });
  return { mc, calls, counted };
};

const googleError = (code: number, status: string, message: string) => ({
  status: code,
  body: { error: { code, status, message } },
});

describe("Merchant Center client", () => {
  it("reads products with their shown custom labels from the Merchant API, never as Google Ads operations", async () => {
    const { mc, calls, counted } = client([
      {
        body: {
          products: [
            {
              name: `accounts/${MID}/products/en~US~demo_US_1_1`,
              offerId: "demo_US_1_1",
              contentLanguage: "en",
              feedLabel: "US",
              productAttributes: {
                customLabel0: "Bestseller",
                customLabel4: "in_stock",
                productTypes: ["Belts > Women"],
                brand: "Demo",
              },
            },
          ],
          nextPageToken: "p2",
        },
      },
      {
        body: {
          products: [
            { name: `accounts/${MID}/products/local~en~US~x`, offerId: "x", legacyLocal: true },
          ],
        },
      },
    ]);
    const { products, capped } = await mc.listProducts(MID);
    expect(capped).toBe(false);
    expect(products[0]).toEqual({
      name: `accounts/${MID}/products/en~US~demo_US_1_1`,
      restId: "en~US~demo_US_1_1",
      offerId: "demo_US_1_1",
      contentLanguage: "en",
      feedLabel: "US",
      labels: ["bestseller", null, null, null, "in_stock"],
      types: ["belts", "women"],
      brand: "demo",
      local: false,
    });
    expect(products[1]?.local).toBe(true);
    expect(calls[0]?.url).toBe(
      `${MERCHANT_API_HOST}/products/v1/accounts/${MID}/products?pageSize=1000`,
    );
    expect(calls[1]?.url).toBe(
      `${MERCHANT_API_HOST}/products/v1/accounts/${MID}/products?pageSize=1000&pageToken=p2`,
    );
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
    expect(counted).toEqual([]);
  });

  it("writes ONE field in the given source (PATCH with a one-field mask); no input there yet = insert just that field", async () => {
    const { mc, calls } = client([googleError(404, "NOT_FOUND", "not found"), { body: {} }]);
    await mc.setCustomLabel(MID, P, 0, "exclude", SOURCE);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(
      `${MERCHANT_API_HOST}/products/v1/accounts/${MID}/productInputs/en~US~demo_US_1_1?dataSource=${encodeURIComponent(SOURCE)}&updateMask=product_attributes.custom_label_0`,
    );
    expect(calls[0]?.body).toEqual({ productAttributes: { customLabel0: "exclude" } });
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe(
      `${MERCHANT_API_HOST}/products/v1/accounts/${MID}/productInputs:insert?dataSource=${encodeURIComponent(SOURCE)}`,
    );
    expect(calls[1]?.body).toEqual({
      offerId: "demo_US_1_1",
      contentLanguage: "en",
      feedLabel: "US",
      productAttributes: { customLabel0: "exclude" },
    });
  });

  it("a field clear sends the mask with no value; nothing there = already gone", async () => {
    const { mc, calls } = client([{ body: {} }, googleError(404, "NOT_FOUND", "not found")]);
    expect(await mc.clearCustomLabel(MID, P, 3, SOURCE)).toBe("cleared");
    expect(calls[0]?.body).toEqual({ productAttributes: {} });
    expect(calls[0]?.url).toContain("updateMask=product_attributes.custom_label_3");
    expect(await mc.clearCustomLabel(MID, P, 3, SOURCE)).toBe("already_gone");
  });

  it("never writes a source of another Merchant Center, never a bad slot", async () => {
    const { mc, calls } = client([]);
    await expect(
      mc.setCustomLabel(MID, P, 0, "exclude", "accounts/999/dataSources/1"),
    ).rejects.toThrow(TypeError);
    await expect(mc.setCustomLabel(MID, P, 5, "exclude", SOURCE)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("makes a supplemental API source for one feed label + language", async () => {
    const { mc, calls } = client([
      {
        body: {
          name: `accounts/${MID}/dataSources/900`,
          displayName: "PerfoAds connector labels",
          input: "API",
          supplementalProductDataSource: { feedLabel: "US", contentLanguage: "en" },
        },
      },
    ]);
    const made = await mc.createSupplementalSource(MID, {
      displayName: "PerfoAds connector labels",
      feedLabel: "US",
      contentLanguage: "en",
    });
    expect(made).toMatchObject({
      name: `accounts/${MID}/dataSources/900`,
      kind: "supplemental",
      api: true,
    });
    expect(calls[0]?.body).toEqual({
      displayName: "PerfoAds connector labels",
      supplementalProductDataSource: { feedLabel: "US", contentLanguage: "en" },
    });
  });

  it("lists data sources with each primary's source order", async () => {
    const { mc } = client([
      {
        body: {
          dataSources: [
            {
              name: `accounts/${MID}/dataSources/100`,
              displayName: "Main",
              input: "FILE",
              primaryProductDataSource: {
                feedLabel: "US",
                contentLanguage: "en",
                defaultRule: {
                  takeFromDataSources: [{ supplementalDataSourceName: SOURCE }, { self: true }],
                },
              },
            },
          ],
        },
      },
    ]);
    const [main] = await mc.listDataSources(MID);
    expect(main).toMatchObject({
      kind: "primary",
      api: false,
      takeFrom: [{ supplementalDataSourceName: SOURCE }, { self: true }],
    });
  });

  it("tells the access problems apart from Google's words", async () => {
    const run = async (code: number, status: string, message: string) => {
      const { mc } = client([googleError(code, status, message)]);
      return mc.listDataSources(MID).then(
        () => null,
        (e: unknown) => merchantAccessProblem(e),
      );
    };
    expect(
      await run(403, "PERMISSION_DENIED", "Request had insufficient authentication scopes."),
    ).toBe("scope");
    expect(
      await run(
        403,
        "PERMISSION_DENIED",
        "Merchant API has not been used in project 1 before or it is disabled.",
      ),
    ).toBe("api_disabled");
    expect(
      await run(
        403,
        "PERMISSION_DENIED",
        "GCP project with id 1 is not registered with the merchant account.",
      ),
    ).toBe("not_registered");
    expect(await run(403, "PERMISSION_DENIED", "The caller does not have permission")).toBe(
      "no_access",
    );
    expect(await run(400, "INVALID_ARGUMENT", "bad")).toBeNull();
  });
});
