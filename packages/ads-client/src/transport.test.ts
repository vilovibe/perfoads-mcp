// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import {
  AdsDailyLimitError,
  AdsInDoubtError,
  AdsNetworkError,
  AdsNotAllowedError,
  AdsNotSentError,
  GoogleAdsApiError,
  GoogleAdsBusyError,
} from "./errors.js";
import {
  createMemoryOpsCounter,
  DAILY_OPS_LIMITS,
  DEFAULT_DAILY_OPS_BUDGET,
} from "./opsCounter.js";
import {
  FAKE_ACCESS_TOKEN,
  FAKE_CUSTOMER,
  FAKE_MANAGER,
  FAKE_REFRESHED_TOKEN,
  campaignRow,
  errorBody,
  makeClient,
  retryInfo,
} from "./testing/fakes.js";
import { GOOGLE_ADS_API_VERSION } from "./version.js";

const ok = { body: { results: [campaignRow("1", "A")] } };
const query = "SELECT campaign.id FROM campaign";
const budgetOp = {
  update: { resourceName: "x", amountMicros: "1000000" },
  updateMask: "amount_micros",
};

describe("headers and url", () => {
  it("sends only the bearer token and a normalised login-customer-id", async () => {
    const { client, calls } = makeClient([ok]);
    await client.searchPage({ customerId: "123-456-7890", query, loginCustomerId: "111-111-1111" });
    const call = calls[0];
    if (!call) throw new Error("no call");
    expect(call.url).toBe(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${FAKE_CUSTOMER}/googleAds:search`,
    );
    expect(Object.keys(call.headers).sort()).toEqual([
      "Authorization",
      "Content-Type",
      "login-customer-id",
    ]);
    expect(call.headers.Authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
    expect(call.headers["login-customer-id"]).toBe(FAKE_MANAGER);
    expect(call.signal).toBeDefined();
  });

  it("omits login-customer-id when none is given", async () => {
    const { client, calls } = makeClient([ok]);
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(calls[0]?.headers["login-customer-id"]).toBeUndefined();
  });

  it("refuses a malformed customer id before sending", async () => {
    const { client, calls } = makeClient([ok]);
    await expect(client.searchPage({ customerId: "12/../34", query })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("read retry", () => {
  it("honours Retry-After on 429 and then succeeds", async () => {
    const { client, calls, sleeps } = makeClient([
      {
        status: 429,
        body: errorBody(429, "RESOURCE_EXHAUSTED", []),
        headers: { "retry-after": "7" },
      },
      ok,
    ]);
    const page = await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(page.rows).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([7000]);
  });

  it("uses Google's RetryInfo delay on 503", async () => {
    const { client, sleeps } = makeClient([
      { status: 503, body: errorBody(503, "UNAVAILABLE", [], [retryInfo(2)]) },
      ok,
    ]);
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(sleeps).toEqual([2000]);
  });

  it("backs off exponentially with jitter on 5xx", async () => {
    const { client, sleeps } = makeClient([{ status: 500 }, { status: 502 }, ok], {
      random: () => 1,
    });
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(sleeps).toEqual([1250, 3750]); // 1000 and 3000, each +25% jitter
  });

  it("gives up after maxAttempts and throws the Google error", async () => {
    const { client, calls } = makeClient([
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
      ok,
    ]);
    const err = await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAdsApiError);
    expect(err.httpStatus).toBe(503);
    expect(calls).toHaveLength(4);
  });

  it("daily quota spent (quotaError RESOURCE_EXHAUSTED): throws at once with the wait, no header needed", async () => {
    const { client, calls, sleeps } = makeClient([
      {
        status: 429,
        body: errorBody(429, "RESOURCE_EXHAUSTED", [
          { type: "quotaError", value: "RESOURCE_EXHAUSTED", retryDelay: "3600s" },
        ]),
      },
      ok,
    ]);
    const err = await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAdsApiError);
    expect(err.retryAfterMs).toBe(3_600_000);
    expect(err.message).toMatch(
      /^The daily request limit for your Google Cloud project's API access level is used up\. Google asks to wait 60 minutes\./,
    );
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("daily quota spent is not retried even when the wait is short", async () => {
    const { client, calls } = makeClient([
      {
        status: 429,
        body: errorBody(429, "RESOURCE_EXHAUSTED", [
          { type: "quotaError", value: "RESOURCE_EXHAUSTED", retryDelay: "5s" },
        ]),
      },
      ok,
    ]);
    await expect(client.searchPage({ customerId: FAKE_CUSTOMER, query })).rejects.toThrow(
      /daily request limit/,
    );
    expect(calls).toHaveLength(1);
  });

  it("daily quota spent with a stated wait: nothing is sent again before then", async () => {
    let clock = 1_000_000;
    const opsCounter = createMemoryOpsCounter({ now: () => clock });
    const { client, calls } = makeClient(
      [
        {
          status: 429,
          body: errorBody(429, "RESOURCE_EXHAUSTED", [
            { type: "quotaError", value: "RESOURCE_EXHAUSTED", retryDelay: "25841s" },
          ]),
        },
        ok,
      ],
      { opsCounter, now: () => clock },
    );
    await expect(client.searchPage({ customerId: FAKE_CUSTOMER, query })).rejects.toThrow(
      GoogleAdsApiError,
    );
    clock += 60_000;
    const err = await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch((e) => e);
    expect(err).toBeInstanceOf(AdsDailyLimitError);
    expect(err.message).toBe(
      "Google's daily request limit for this project is used up; it refills in about 8 hours. Nothing was sent to Google.",
    );
    expect(calls).toHaveLength(1);
    // a write is refused the same way, and counts nothing
    await expect(
      client.mutate("campaignBudgets", [budgetOp], { customerId: FAKE_CUSTOMER }),
    ).rejects.toThrow(AdsDailyLimitError);
    expect(calls).toHaveLength(1);
    expect(opsCounter.used()).toBe(0); // Google's refusal did no work: not counted
    // once the wait is over, requests go again
    clock += 25_841_000;
    const page = await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(page.rows).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("daily quota spent for one account only (rateScope ACCOUNT): no project-wide wait is kept", async () => {
    const opsCounter = createMemoryOpsCounter();
    const spent = {
      status: 429,
      body: errorBody(429, "RESOURCE_EXHAUSTED", [
        {
          type: "quotaError",
          value: "RESOURCE_EXHAUSTED",
          retryDelay: "25841s",
          rateScope: "ACCOUNT",
        },
      ]),
    };
    const { client, calls } = makeClient([spent, ok], { opsCounter });
    const err = await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAdsApiError);
    expect(err.details[0].rateScope).toBe("ACCOUNT");
    expect(opsCounter.limitUntil?.()).toBeNull();
    await client.searchPage({ customerId: "9876543210", query });
    expect(calls).toHaveLength(2);
  });

  it("daily quota spent on an account whose pool is not known: no wait is kept, the next call is sent", async () => {
    const opsCounter = createMemoryOpsCounter();
    const spent = {
      status: 429,
      body: errorBody(429, "RESOURCE_EXHAUSTED", [
        { type: "quotaError", value: "RESOURCE_EXHAUSTED", retryDelay: "25841s" },
      ]),
    };
    const { client, calls } = makeClient([spent, ok], {
      opsCounter,
      opsPool: () => undefined,
    });
    await expect(client.searchPage({ customerId: FAKE_CUSTOMER, query })).rejects.toThrow(
      GoogleAdsApiError,
    );
    expect(opsCounter.limitUntil?.()).toBeNull();
    // a wait kept for live accounts does not stop it either: it may be a test account
    opsCounter.limitReached?.(Date.now() + 3_600_000);
    const page = await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(page.rows).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("short-term quota (RESOURCE_TEMPORARILY_EXHAUSTED): waits the delay from quotaErrorDetails, then retries", async () => {
    const { client, calls, sleeps } = makeClient([
      {
        status: 429,
        body: errorBody(429, "RESOURCE_EXHAUSTED", [
          { type: "quotaError", value: "RESOURCE_TEMPORARILY_EXHAUSTED", retryDelay: "12s" },
        ]),
      },
      ok,
    ]);
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(sleeps).toEqual([12_000]);
    expect(calls).toHaveLength(2);
  });

  it("short-term quota with a wait longer than the cap: throws instead of waiting", async () => {
    const { client, calls, sleeps } = makeClient([
      {
        status: 429,
        body: errorBody(429, "RESOURCE_EXHAUSTED", [
          { type: "quotaError", value: "RESOURCE_TEMPORARILY_EXHAUSTED", retryDelay: "120s" },
        ]),
      },
      ok,
    ]);
    const err = await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAdsApiError);
    expect(err.message).toMatch(/Google asks to wait 2 minutes/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("never retries a 400", async () => {
    const { client, calls } = makeClient([
      {
        status: 400,
        body: errorBody(400, "INVALID_ARGUMENT", [
          { type: "queryError", value: "UNRECOGNIZED_FIELD" },
        ]),
      },
      ok,
    ]);
    await expect(client.searchPage({ customerId: FAKE_CUSTOMER, query })).rejects.toThrow(
      /GAQL query is not valid/,
    );
    expect(calls).toHaveLength(1);
  });

  it("retries a connection reset, then throws AdsNetworkError when it keeps failing", async () => {
    const { client, calls, sleeps } = makeClient([
      { networkError: "ECONNRESET" },
      { networkError: "ECONNRESET" },
      { networkError: "ECONNRESET" },
    ]);
    const err = await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch((e) => e);
    expect(err).toBeInstanceOf(AdsNetworkError);
    expect(err.timedOut).toBe(false);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 2000]);
  });

  it("aborts a read that hangs past the timeout", async () => {
    const { client, calls } = makeClient([{ hang: true }], {
      timeoutMs: 20,
      retry: { backoffNetworkMs: [] },
    });
    const err = await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch((e) => e);
    expect(err).toBeInstanceOf(AdsNetworkError);
    expect(err.timedOut).toBe(true);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it("refreshes the token once on 401 and resends", async () => {
    const { client, calls, refreshes } = makeClient([
      {
        status: 401,
        body: errorBody(401, "UNAUTHENTICATED", [
          { type: "authenticationError", value: "OAUTH_TOKEN_EXPIRED" },
        ]),
      },
      ok,
    ]);
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(refreshes).toEqual([false, true]);
    expect(calls[1]?.headers.Authorization).toBe(`Bearer ${FAKE_REFRESHED_TOKEN}`);
  });

  it("does not loop on a second 401", async () => {
    const e401 = {
      status: 401,
      body: errorBody(401, "UNAUTHENTICATED", [
        { type: "authenticationError", value: "OAUTH_TOKEN_REVOKED" },
      ]),
    };
    const { client, calls } = makeClient([e401, e401, ok]);
    await expect(client.searchPage({ customerId: FAKE_CUSTOMER, query })).rejects.toThrow(
      /Sign in again/,
    );
    expect(calls).toHaveLength(2);
  });
});

describe("writes are never retried after an ambiguous failure", () => {
  const write = (client: ReturnType<typeof makeClient>["client"]) =>
    client.mutate("campaignBudgets", [budgetOp], { customerId: FAKE_CUSTOMER });

  it("timeout -> in_doubt, sent exactly once", async () => {
    const { client, calls } = makeClient([{ hang: true }, { body: { results: [] } }], {
      timeoutMs: 20,
    });
    const err = await write(client).catch((e) => e);
    expect(err).toBeInstanceOf(AdsInDoubtError);
    expect(err.kind).toBe("in_doubt");
    expect(err.message).toMatch(/may or may not have been applied/);
    expect(calls).toHaveLength(1);
  });

  it("connection reset -> in_doubt, sent exactly once", async () => {
    const { client, calls } = makeClient([
      { networkError: "ECONNRESET" },
      { body: { results: [] } },
    ]);
    await expect(write(client)).rejects.toBeInstanceOf(AdsInDoubtError);
    expect(calls).toHaveLength(1);
  });

  it("5xx -> in_doubt with Google's request id kept", async () => {
    const { client, calls } = makeClient([
      { status: 503, headers: { "request-id": "fake-req-503" } },
      { body: { results: [] } },
    ]);
    const err = await write(client).catch((e) => e);
    expect(err).toBeInstanceOf(AdsInDoubtError);
    expect(err.googleRequestId).toBe("fake-req-503");
    expect(calls).toHaveLength(1);
  });

  it("200 with an unreadable body -> in_doubt", async () => {
    const { client } = makeClient([{ text: "<html>proxy</html>" }]);
    await expect(write(client)).rejects.toBeInstanceOf(AdsInDoubtError);
  });

  it("connection refused -> plain network error (never sent), not in_doubt, not retried", async () => {
    const { client, calls } = makeClient([
      { networkError: "ECONNREFUSED" },
      { body: { results: [] } },
    ]);
    const err = await write(client).catch((e) => e);
    expect(err).toBeInstanceOf(AdsNetworkError);
    expect(err.sent).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("a 400 on a write is a clear refusal and is not sent again", async () => {
    const { client, calls } = makeClient([
      {
        status: 400,
        body: errorBody(400, "INVALID_ARGUMENT", [{ type: "rangeError", value: "TOO_LOW" }]),
      },
      { body: { results: [] } },
    ]);
    await expect(write(client)).rejects.toBeInstanceOf(GoogleAdsApiError);
    expect(calls).toHaveLength(1);
  });
});

describe("a write Google refused as busy is never sent again by the transport", () => {
  const write = (client: ReturnType<typeof makeClient>["client"]) =>
    client.mutate("campaignBudgets", [budgetOp], { customerId: FAKE_CUSTOMER });
  const busy409 = {
    status: 409,
    body: errorBody(409, "ABORTED", [{ type: "databaseError", value: "CONCURRENT_MODIFICATION" }]),
  };

  it("429 -> GoogleAdsBusyError (refused, not applied) with Google's wait, sent once", async () => {
    const { client, calls, sleeps } = makeClient([
      { status: 429, headers: { "retry-after": "3" } },
      { body: { results: [] } },
    ]);
    const err = await write(client).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAdsBusyError);
    expect(err).toBeInstanceOf(GoogleAdsApiError);
    expect(err.retryAfterMs).toBe(3000);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("CONCURRENT_MODIFICATION and RESOURCE_TEMPORARILY_EXHAUSTED -> busy, sent once", async () => {
    for (const reply of [
      busy409,
      {
        status: 429,
        body: errorBody(429, "RESOURCE_EXHAUSTED", [
          { type: "quotaError", value: "RESOURCE_TEMPORARILY_EXHAUSTED", retryDelay: "2s" },
        ]),
      },
    ]) {
      const { client, calls } = makeClient([reply, { body: { results: [] } }]);
      await expect(write(client)).rejects.toBeInstanceOf(GoogleAdsBusyError);
      expect(calls).toHaveLength(1);
    }
  });

  it("daily quota spent is a plain refusal, not busy", async () => {
    const { client, calls } = makeClient([
      {
        status: 429,
        body: errorBody(429, "RESOURCE_EXHAUSTED", [
          { type: "quotaError", value: "RESOURCE_EXHAUSTED", retryDelay: "1s" },
        ]),
      },
    ]);
    const err = await write(client).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAdsApiError);
    expect(err).not.toBeInstanceOf(GoogleAdsBusyError);
    expect(calls).toHaveLength(1);
  });

  it("a 5xx with a busy code is still in_doubt", async () => {
    const { client, calls } = makeClient([
      {
        status: 500,
        body: errorBody(500, "INTERNAL", [
          { type: "databaseError", value: "CONCURRENT_MODIFICATION" },
        ]),
      },
    ]);
    await expect(write(client)).rejects.toBeInstanceOf(AdsInDoubtError);
    expect(calls).toHaveLength(1);
  });
});

describe("a write that fails before it is sent is 'not sent', never in_doubt", () => {
  it("ops counter throwing (e.g. busy store) -> AdsNotSentError, no fetch", async () => {
    const { client, calls } = makeClient([{ body: { results: [] } }], {
      opsCounter: {
        record: () => undefined,
        used: () => 0,
        remaining: () => {
          throw new Error("store is busy");
        },
      },
    });
    const err = await client
      .mutate("campaignBudgets", [budgetOp], { customerId: FAKE_CUSTOMER })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdsNotSentError);
    expect(err.message).toMatch(/Not sent: store is busy/);
    expect(calls).toHaveLength(0);
  });

  it("sign-in failing -> AdsNotSentError on writes; reads keep the original error", async () => {
    const boom = new Error("sign-in expired");
    const { client, calls } = makeClient([{ body: { results: [] } }], {
      tokens: {
        getAccessToken: async () => {
          throw boom;
        },
      },
    });
    await expect(
      client.mutate("campaignBudgets", [budgetOp], { customerId: FAKE_CUSTOMER }),
    ).rejects.toBeInstanceOf(AdsNotSentError);
    await expect(client.searchPage({ customerId: FAKE_CUSTOMER, query })).rejects.toBe(boom);
    expect(calls).toHaveLength(0);
  });
});

describe("read deadline", () => {
  it("does not start a wait that would pass the deadline", async () => {
    let clock = 0;
    const { client, calls } = makeClient([{ status: 503 }, { status: 503 }, { status: 503 }, ok], {
      deadlineMs: 5_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const err = await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAdsApiError);
    // 1000 + 3000 fit inside 5000; the next 9000 wait would not, so it stops.
    expect(calls).toHaveLength(3);
    expect(clock).toBe(4_000);
  });

  it("shortens the attempt timeout so a hanging retry ends at the deadline", async () => {
    const { client, calls } = makeClient([{ networkError: "ECONNRESET" }, { hang: true }], {
      timeoutMs: 10_000,
      deadlineMs: 600,
      sleep: async () => {},
    });
    const started = Date.now();
    const err = await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch((e) => e);
    expect(err).toBeInstanceOf(AdsNetworkError);
    expect(err.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(calls).toHaveLength(2);
  });
});

describe("writes and 401", () => {
  const e401 = {
    status: 401,
    body: errorBody(401, "UNAUTHENTICATED", [
      { type: "authenticationError", value: "OAUTH_TOKEN_EXPIRED" },
    ]),
  };
  const write = (client: ReturnType<typeof makeClient>["client"]) =>
    client.mutate("campaignBudgets", [budgetOp], { customerId: FAKE_CUSTOMER });

  it("resends exactly once with a fresh token", async () => {
    const { client, calls, refreshes } = makeClient([e401, { body: { results: [{}] } }, ok]);
    const res = await write(client);
    expect(res.results[0]?.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(refreshes).toEqual([false, true]);
  });

  it("a second 401 throws the Google error, not in_doubt", async () => {
    const { client, calls } = makeClient([e401, e401, { body: { results: [{}] } }]);
    const err = await write(client).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAdsApiError);
    expect(err).not.toBeInstanceOf(AdsInDoubtError);
    expect(calls).toHaveLength(2);
  });

  it("a timeout on the resend is in_doubt and not sent a third time", async () => {
    const { client, calls } = makeClient([e401, { hang: true }, { body: {} }], { timeoutMs: 20 });
    await expect(write(client)).rejects.toBeInstanceOf(AdsInDoubtError);
    expect(calls).toHaveLength(2);
  });
});

describe("ops counter", () => {
  it("our own count never stops a read: past it reads still go, retries included", async () => {
    const opsCounter = createMemoryOpsCounter({ limits: { production: 1 } });
    const { client, calls } = makeClient([{ status: 503 }, ok, ok], { opsCounter });
    const page = await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(page.rows).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(opsCounter.remaining()).toBe(0);
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(calls).toHaveLength(3);
  });

  it("a saved wait still stops reads when our count is spent; writes stop at the count", async () => {
    const opsCounter = createMemoryOpsCounter({ limits: { production: 1 } });
    opsCounter.record(1, "search");
    const { client, calls } = makeClient([ok], { opsCounter });
    await expect(
      client.mutate("campaignBudgets", [budgetOp], { customerId: FAKE_CUSTOMER }),
    ).rejects.toThrow(AdsNotAllowedError);
    opsCounter.limitReached?.(Date.now() + 3_600_000);
    await expect(client.searchPage({ customerId: FAKE_CUSTOMER, query })).rejects.toThrow(
      AdsDailyLimitError,
    );
    expect(calls).toHaveLength(0);
  });

  it("the share kept for changes still stops reads; only a spent count lets them past it", async () => {
    let clock = 1_000_000;
    const base = createMemoryOpsCounter({ limits: { production: 10 }, now: () => clock });
    const opsCounter = {
      ...base,
      admit: (n: number) =>
        base.used() + n > 8 ? "Not sent: kept for approved changes." : undefined,
    };
    base.record(8, "search");
    const { client, calls } = makeClient([ok, { body: { results: [{}] } }], {
      opsCounter,
      now: () => clock,
    });
    // 2 left by our count: the kept share holds reads and writes back
    await expect(client.searchPage({ customerId: FAKE_CUSTOMER, query })).rejects.toThrow(
      /kept for approved changes/,
    );
    await expect(
      client.mutate("campaignBudgets", [budgetOp], { customerId: FAKE_CUSTOMER }),
    ).rejects.toThrow(/kept for approved changes/);
    expect(calls).toHaveLength(0);
    // our count spent: a read goes (Google decides)
    base.record(2, "mutate");
    clock += 1_000;
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(calls).toHaveLength(1);
    // Google took it, so it has refilled: the count starts again and the write goes too
    expect(base.used()).toBe(1);
    await client.mutate("campaignBudgets", [budgetOp], { customerId: FAKE_CUSTOMER });
    expect(calls).toHaveLength(2);
  });

  it("Google taking a read past our spent count shows it refilled: the old count stops counting", async () => {
    let clock = 100 * 3_600_000;
    const opsCounter = createMemoryOpsCounter({ limits: { production: 10 }, now: () => clock });
    opsCounter.record(10, "search");
    clock += 3_600_000;
    const { client, calls } = makeClient([ok, { body: { results: [{}] } }], {
      opsCounter,
      now: () => clock,
    });
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(opsCounter.used()).toBe(1);
    // the change our stale count would have stopped now goes
    await client.mutate("campaignBudgets", [budgetOp], { customerId: FAKE_CUSTOMER });
    expect(calls).toHaveLength(2);
  });

  describe("policy keeps 20% for changes, 2,849 counted yesterday, no saved wait", () => {
    const setup = (replies: Parameters<typeof makeClient>[0], share: "read" | "undo" = "read") => {
      let clock = 100 * 3_600_000;
      const base = createMemoryOpsCounter({ limits: { production: 2_880 }, now: () => clock });
      base.record(2_849, "search");
      clock += 20 * 3_600_000;
      const opsCounter = {
        ...base,
        // like the policy file: reads may use 80% (2,304) of the 2,880, undo reads all of it
        admit: (n: number) =>
          base.used() + n > (share === "undo" ? 2_880 : 2_304)
            ? "Not sent: kept for approved changes."
            : undefined,
      };
      const made = makeClient(replies, { opsCounter, now: () => clock });
      return { ...made, base, tick: (ms: number) => (clock += ms) };
    };

    it("holds reads in the kept share, however long: nothing is sent", async () => {
      const { client, calls, base, tick } = setup([ok, ok]);
      for (const wait of [0, 15 * 60_000, 60 * 60_000]) {
        tick(wait);
        await expect(client.searchPage({ customerId: FAKE_CUSTOMER, query })).rejects.toThrow(
          /kept for approved changes/,
        );
      }
      expect(calls).toHaveLength(0);
      expect(base.used()).toBe(2_849);
    });

    it("undo reads may use the kept share: they go, and Google taking them there proves nothing", async () => {
      const { client, calls, base } = setup([ok, ok], "undo");
      await client.searchPage({ customerId: FAKE_CUSTOMER, query });
      expect(calls).toHaveLength(1);
      expect(base.used()).toBe(2_850);
    });

    it("count at the full limit and Google takes a read: the count starts again", async () => {
      const { client, calls, base, tick } = setup([ok, ok], "undo");
      base.record(31, "search"); // 2,880 by our count
      tick(60_000);
      await client.searchPage({ customerId: FAKE_CUSTOMER, query });
      expect(base.used()).toBe(1);
      // the kept share holds nothing back now: a plain read goes too
      await client.searchPage({ customerId: FAKE_CUSTOMER, query });
      expect(calls).toHaveLength(2);
    });

    it("Google refuses a read at the full limit: its wait is kept and the count stays", async () => {
      const { client, calls, base, tick } = setup([
        {
          status: 429,
          body: errorBody(429, "RESOURCE_EXHAUSTED", [
            { type: "quotaError", value: "RESOURCE_EXHAUSTED", retryDelay: "3600s" },
          ]),
        },
        ok,
      ]);
      base.record(31, "search");
      await expect(client.searchPage({ customerId: FAKE_CUSTOMER, query })).rejects.toThrow(
        GoogleAdsApiError,
      );
      expect(base.used()).toBe(2_880);
      tick(16 * 60_000);
      await expect(client.searchPage({ customerId: FAKE_CUSTOMER, query })).rejects.toThrow(
        AdsDailyLimitError,
      );
      expect(calls).toHaveLength(1);
    });
  });

  it("frees up when enough of the oldest operations leave the 24 hours", () => {
    let now = 0;
    const counter = createMemoryOpsCounter({ limits: { production: 10 }, now: () => now });
    counter.record(4, "search");
    now = 1_000;
    counter.record(6, "search");
    expect(counter.freesAt?.(4)).toBe(24 * 3600_000);
    expect(counter.freesAt?.(5)).toBe(24 * 3600_000 + 1_000);
    expect(counter.freesAt?.(11)).toBeNull();
    expect(createMemoryOpsCounter().freesAt?.(1)).toBeNull();
  });

  it("operations before a passed wait no longer count: Google refilled then", () => {
    let now = 0;
    const counter = createMemoryOpsCounter({ limits: { production: 10 }, now: () => now });
    counter.record(9, "search");
    counter.limitReached?.(3_600_000);
    now = 1_800_000;
    counter.record(1, "search");
    expect(counter.used()).toBe(10);
    now = 3_600_001;
    expect(counter.used()).toBe(0);
    counter.record(2, "search");
    expect(counter.remaining()).toBe(8);
  });

  it("does not count requests that never left (connection refused, DNS)", async () => {
    const opsCounter = createMemoryOpsCounter({ limits: { production: 100 } });
    const { client } = makeClient(
      [
        { networkError: "ECONNREFUSED" },
        { networkError: "ENOTFOUND" },
        { networkError: "ECONNRESET" },
      ],
      { opsCounter, retry: { backoffNetworkMs: [1, 1] } },
    );
    await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch(() => {});
    expect(opsCounter.used()).toBe(1); // only the reset one may have reached Google
  });

  it("does not count replies where Google refused for a limit (429, RESOURCE_EXHAUSTED)", async () => {
    const opsCounter = createMemoryOpsCounter({ limits: { production: 100 } });
    const { client, calls } = makeClient(
      [
        { status: 429 },
        {
          status: 429,
          body: errorBody(429, "RESOURCE_EXHAUSTED", [
            { type: "quotaError", value: "RESOURCE_TEMPORARILY_EXHAUSTED" },
          ]),
        },
        ok,
        {
          status: 429,
          body: errorBody(429, "RESOURCE_EXHAUSTED", [
            { type: "quotaError", value: "RESOURCE_EXHAUSTED", rateScope: "ACCOUNT" },
          ]),
        },
        { status: 400, body: errorBody(400, "INVALID_ARGUMENT", []) },
      ],
      { opsCounter, retry: { backoff429Ms: [1, 1, 1] } },
    );
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(calls).toHaveLength(3);
    expect(opsCounter.used()).toBe(1); // only the answered one
    await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch(() => {});
    expect(opsCounter.used()).toBe(1);
    // any other refusal still counts (Google did the work of reading it)
    await client.searchPage({ customerId: FAKE_CUSTOMER, query }).catch(() => {});
    expect(calls).toHaveLength(5);
    expect(opsCounter.used()).toBe(2);
  });

  it("records every request, retries included, with mutate cost = operation count", async () => {
    const opsCounter = createMemoryOpsCounter({ limits: { production: 100 } });
    const { client } = makeClient([{ status: 503 }, ok, { body: { results: [{}, {}] } }], {
      opsCounter,
    });
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    await client.mutate("campaignBudgets", [budgetOp, budgetOp], { customerId: FAKE_CUSTOMER });
    expect(opsCounter.used()).toBe(4);
    expect(opsCounter.remaining()).toBe(96);
  });

  it("refuses before sending when the budget cannot cover the request", async () => {
    const opsCounter = createMemoryOpsCounter({ limits: { production: 1 } });
    const { client, calls } = makeClient([ok], { opsCounter });
    const err = await client
      .mutate("campaignBudgets", [budgetOp, budgetOp], { customerId: FAKE_CUSTOMER })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdsNotAllowedError);
    expect(err.reason).toBe("ops_budget");
    expect(calls).toHaveLength(0);
  });

  it("says a change refused by our count is our own estimate, and when it frees up", async () => {
    let clock = Date.parse("2026-10-26T18:00:00Z");
    const opsCounter = createMemoryOpsCounter({ limits: { production: 3 }, now: () => clock });
    opsCounter.record(1, "search");
    clock = Date.parse("2026-10-26T18:30:00Z");
    opsCounter.record(2, "search");
    const { client, calls } = makeClient([ok], { opsCounter, now: () => clock });
    const err = await client
      .mutate("campaignBudgets", [budgetOp, budgetOp], { customerId: FAKE_CUSTOMER })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdsNotAllowedError);
    expect(err.message).toBe(
      "Not sent: this needs 2 Google Ads operations and only 0 are left for live accounts, by our count of the last 24 hours; frees up from about 2026-10-27 18:30 UTC.",
    );
    expect(err.message).not.toMatch(/today's budget/);
    expect(calls).toHaveLength(0);
  });

  it("counts test accounts and production accounts apart, each against its own limit", async () => {
    const opsCounter = createMemoryOpsCounter({ limits: { test: 15_000, production: 1 } });
    const pools: (string | undefined)[] = [];
    const { client, calls } = makeClient([ok, ok, ok, ok], {
      opsCounter,
      opsPool: (id) => {
        pools.push(id);
        return id === FAKE_CUSTOMER ? "test" : "production";
      },
    });
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(opsCounter.used("test")).toBe(2);
    expect(opsCounter.used("production")).toBe(0);
    expect(opsCounter.remaining("test")).toBe(14_998);
    expect(pools).toEqual([FAKE_CUSTOMER, FAKE_CUSTOMER]);
    // Production is a separate count: 1 left there, then a change is refused for live accounts.
    await client.searchPage({ customerId: "9876543210", query });
    const err = await client
      .mutate("campaignBudgets", [budgetOp], { customerId: "9876543210" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdsNotAllowedError);
    expect(err.message).toMatch(/live accounts/);
    expect(calls).toHaveLength(3);
    // Test accounts still work while production is used up.
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(calls).toHaveLength(4);
    expect(opsCounter.used("test")).toBe(3);
  });

  it("without an opsPool every request counts as production", async () => {
    const opsCounter = createMemoryOpsCounter({ limits: { test: 100, production: 100 } });
    const { client } = makeClient([ok], { opsCounter });
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    expect(opsCounter.used()).toBe(1);
    expect(opsCounter.used("test")).toBe(0);
  });

  it("forgets operations older than 24 hours", () => {
    let now = 0;
    const counter = createMemoryOpsCounter({ limits: { production: 10 }, now: () => now });
    counter.record(4, "search");
    now = 23 * 3600_000;
    counter.record(3, "mutate");
    expect(counter.remaining()).toBe(3);
    now = 24 * 3600_000 + 1;
    expect(counter.used()).toBe(3);
    expect(createMemoryOpsCounter().remaining()).toBeNull();
  });

  it("daily limits per access level: test accounts and live accounts apart", () => {
    expect(DAILY_OPS_LIMITS).toEqual({
      test: { test: 15_000, production: 2_880 },
      explorer: { test: 15_000, production: 2_880 },
      basic: { test: 15_000, production: 15_000 },
      standard: { test: null, production: null },
      unknown: { test: 15_000, production: 2_880 },
    });
    expect(DEFAULT_DAILY_OPS_BUDGET).toBe(2_880);
    expect(Object.isFrozen(DAILY_OPS_LIMITS)).toBe(true);
    expect(Object.isFrozen(DAILY_OPS_LIMITS.basic)).toBe(true);
  });
});

describe("logging", () => {
  it("never logs access tokens, even across errors and retries", async () => {
    const echo = {
      error: {
        code: 503,
        status: "UNAVAILABLE",
        // No "Bearer" prefix and no Google token shape: only the tracked-token list can hide these.
        message: `backend saw ${FAKE_ACCESS_TOKEN} and ${FAKE_REFRESHED_TOKEN}`,
      },
    };
    const { client, logLines } = makeClient(
      [
        { status: 401 },
        { status: 503, body: echo },
        { networkError: "ECONNRESET" },
        ok,
        { hang: true },
      ],
      { timeoutMs: 20 },
    );
    await client.searchPage({ customerId: FAKE_CUSTOMER, query });
    await client
      .mutate("campaignBudgets", [budgetOp], { customerId: FAKE_CUSTOMER })
      .catch(() => {});
    expect(logLines.length).toBeGreaterThan(3);
    const all = logLines.join("\n");
    expect(all).not.toContain(FAKE_ACCESS_TOKEN);
    expect(all).not.toContain(FAKE_REFRESHED_TOKEN);
    expect(all).toContain("[REDACTED]");
  });
});
