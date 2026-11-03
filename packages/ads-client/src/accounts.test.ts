// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { AdsNotAllowedError } from "./errors.js";
import { errorBody, makeClient, type Call, type Reply } from "./testing/fakes.js";

// Fake tree: manager 1111111111 (direct) -> 2222222222 (level 1) -> 3333333333 (level 2);
// 4444444444 direct, not a manager; 5555555555 direct but cancelled (read fails).
const customer = (id: string, name: string, manager: boolean) => ({
  results: [
    {
      customer: {
        resourceName: `customers/${id}`,
        id,
        descriptiveName: name,
        currencyCode: "EUR",
        timeZone: "Europe/Berlin",
        manager,
        testAccount: true,
        status: "ENABLED",
      },
    },
  ],
});
const client_ = (id: string, name: string, level: number, manager = false) => ({
  customerClient: {
    resourceName: `customers/1111111111/customerClients/${id}`,
    clientCustomer: `customers/${id}`,
    descriptiveName: name,
    currencyCode: "JPY",
    timeZone: "Asia/Tokyo",
    manager,
    testAccount: true,
    status: "ENABLED",
    level: String(level),
    hidden: false,
  },
});

const router = (call: Call): Reply => {
  if (call.url.endsWith("customers:listAccessibleCustomers")) {
    return {
      body: {
        resourceNames: [
          "customers/1111111111",
          "customers/4444444444",
          "customers/5555555555",
          "customers/2222222222",
        ],
      },
    };
  }
  const id = /customers\/(\d{10})\//.exec(call.url)?.[1];
  const query = String((call.body as { query: string }).query);
  if (query.includes("FROM customer_client")) {
    return {
      body: {
        results: [client_("2222222222", "Sub A", 1, true), client_("3333333333", "Sub B", 2)],
      },
    };
  }
  if (id === "1111111111") return { body: customer(id, "Manager", true) };
  if (id === "4444444444") return { body: customer(id, "Direct", false) };
  if (id === "2222222222") return { body: customer(id, "Sub A (direct too)", true) };
  return {
    status: 403,
    body: errorBody(403, "PERMISSION_DENIED", [
      { type: "authorizationError", value: "CUSTOMER_NOT_ENABLED" },
    ]),
  };
};

describe("account discovery", () => {
  it("lists accessible customers without a login-customer-id", async () => {
    const { client, calls } = makeClient(router);
    const ids = await client.listAccessibleCustomers();
    expect(ids).toEqual(["1111111111", "4444444444", "5555555555", "2222222222"]);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["login-customer-id"]).toBeUndefined();
  });

  it("walks the manager tree and returns the login-customer-id for every account", async () => {
    const { client, calls } = makeClient(router);
    const { accounts, failures } = await client.discoverAccounts();
    const byId = Object.fromEntries(accounts.map((a) => [a.customerId, a]));

    expect(byId["1111111111"]).toMatchObject({
      isManager: true,
      loginCustomerId: "1111111111",
      level: 0,
    });
    expect(byId["4444444444"]).toMatchObject({
      isManager: false,
      loginCustomerId: "4444444444",
      level: 0,
    });
    // Reachable directly: direct access wins over the manager route.
    expect(byId["2222222222"]).toMatchObject({ loginCustomerId: "2222222222", level: 0 });
    expect(byId["3333333333"]).toMatchObject({
      name: "Sub B",
      currencyCode: "JPY",
      loginCustomerId: "1111111111",
      level: 2,
      isTestAccount: true,
    });
    expect(failures).toEqual([
      { customerId: "5555555555", message: expect.stringMatching(/not active/) },
    ]);
    const treeCall = calls.find((c) =>
      String((c.body as { query?: string })?.query).includes("customer_client"),
    );
    expect(treeCall?.headers["login-customer-id"]).toBe("1111111111");
  });
});

describe("keyword ideas", () => {
  const base = {
    customerId: "1234567890",
    language: "languageConstants/1000",
    geoTargetConstants: ["geoTargetConstants/2840"],
  };

  it("is refused on Explorer access without calling Google", async () => {
    const { client, calls } = makeClient([{ body: {} }]);
    const err = await client
      .generateKeywordIdeas({ ...base, accessLevel: "explorer", keywords: ["trail running shoes"] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdsNotAllowedError);
    expect(err.reason).toBe("access_level");
    expect(calls).toHaveLength(0);
  });

  it("is refused on Test access too (test accounts give no planning data)", async () => {
    const { client, calls } = makeClient([{ body: {} }]);
    const err = await client
      .generateKeywordIdeas({ ...base, accessLevel: "test", keywords: ["trail running shoes"] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdsNotAllowedError);
    expect(err.message).toMatch(/Test access can't use the Keyword Planner/);
    expect(calls).toHaveLength(0);
  });

  it("needs a seed", async () => {
    const { client } = makeClient([{ body: {} }]);
    await expect(client.generateKeywordIdeas({ ...base, accessLevel: "basic" })).rejects.toThrow(
      RangeError,
    );
  });

  it("sends the seed and parses ideas with micros as BigInt", async () => {
    const { client, calls } = makeClient([
      {
        body: {
          results: [
            {
              text: "blue trail running shoes",
              keywordIdeaMetrics: {
                avgMonthlySearches: "1900",
                competition: "HIGH",
                competitionIndex: "87",
                lowTopOfPageBidMicros: "420000",
                highTopOfPageBidMicros: "9007199254740993",
              },
            },
            { text: "shoe shop", keywordIdeaMetrics: {} },
          ],
          nextPageToken: "IDEAS-2",
        },
      },
    ]);
    const res = await client.generateKeywordIdeas({
      ...base,
      accessLevel: "basic",
      keywords: [" trail running shoes ", ""],
      url: "https://example.com",
    });
    expect(calls[0]?.url).toMatch(/customers\/1234567890:generateKeywordIdeas$/);
    expect(calls[0]?.body).toEqual({
      language: "languageConstants/1000",
      geoTargetConstants: ["geoTargetConstants/2840"],
      keywordPlanNetwork: "GOOGLE_SEARCH",
      includeAdultKeywords: false,
      keywordAndUrlSeed: { url: "https://example.com", keywords: ["trail running shoes"] },
    });
    expect(res.ideas[0]).toEqual({
      text: "blue trail running shoes",
      avgMonthlySearches: 1900,
      competition: "HIGH",
      competitionIndex: 87,
      lowTopOfPageBidMicros: 420000n,
      highTopOfPageBidMicros: 9007199254740993n,
    });
    expect(res.ideas[1]).toMatchObject({ avgMonthlySearches: null, lowTopOfPageBidMicros: null });
    expect(res.nextPageToken).toBe("IDEAS-2");
  });
});

describe("searchGoogleAdsFields", () => {
  it("posts the field query to googleAdsFields:search (no account in the path)", async () => {
    const { client, calls } = makeClient([
      {
        body: {
          results: [{ name: "campaign.id", category: "ATTRIBUTE", selectable: true }],
          totalResultsCount: "1",
        },
      },
    ]);
    const res = await client.searchGoogleAdsFields({
      query: "SELECT name WHERE name LIKE 'campaign.%'",
      pageSize: 500,
    });
    expect(calls[0]?.url).toMatch(/\/v26\/googleAdsFields:search$/);
    expect(calls[0]?.body).toEqual({
      query: "SELECT name WHERE name LIKE 'campaign.%'",
      pageSize: 500,
    });
    expect(calls[0]?.headers["login-customer-id"]).toBeUndefined();
    expect(res.results[0]?.name).toBe("campaign.id");
    expect(res.totalResultsCount).toBe(1);
  });
});
