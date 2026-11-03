// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Test doubles and hand-written fixtures shaped like Google's documented REST replies.
// Only obviously fake ids (1234567890, repeated digits). Never real account data.

import { createAdsClient } from "../client.js";
import type { Logger } from "../types.js";
import type { AdsClientConfig } from "../transport.js";

export const FAKE_CUSTOMER = "1234567890";
export const FAKE_MANAGER = "1111111111";
export const FAKE_ACCESS_TOKEN = "opaque-test-token-0001";
export const FAKE_REFRESHED_TOKEN = "opaque-test-token-0002";

export type Reply =
  | { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }
  | { networkError: string }
  | { hang: true };

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

const networkError = (code: string): Error =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

/** A fetch that answers from a queue (or a router function) and records every call. */
export const fakeFetch = (replies: Reply[] | ((call: Call) => Reply)) => {
  const calls: Call[] = [];
  const queue = Array.isArray(replies) ? [...replies] : undefined;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const reply = queue ? queue.shift() : (replies as (c: Call) => Reply)(call);
    if (!reply) throw new Error(`fake fetch: no reply queued for call ${calls.length}`);
    if ("networkError" in reply) throw networkError(reply.networkError);
    if ("hang" in reply) {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    }
    const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status ?? 200, headers: reply.headers ?? {} });
  };
  return { calls, fetch };
};

export const captureLogger = () => {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (message: string, data?: Record<string, unknown>): void => {
      lines.push(`${level} ${message} ${data === undefined ? "" : JSON.stringify(data)}`);
    };
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
  return { lines, logger };
};

/** Client wired to fakes: no network, no real waiting, no jitter. */
export const makeClient = (
  replies: Reply[] | ((call: Call) => Reply),
  overrides: Partial<AdsClientConfig> = {},
) => {
  const { calls, fetch } = fakeFetch(replies);
  const sleeps: number[] = [];
  const refreshes: boolean[] = [];
  const { lines, logger } = captureLogger();
  const client = createAdsClient({
    tokens: {
      getAccessToken: async (o) => {
        refreshes.push(o?.forceRefresh === true);
        return o?.forceRefresh ? FAKE_REFRESHED_TOKEN : FAKE_ACCESS_TOKEN;
      },
    },
    fetch,
    logger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...overrides,
  });
  return { client, calls, sleeps, refreshes, logLines: lines };
};

// ---- Fixture builders (shapes from the Google Ads REST reference) ----

export interface FakeError {
  type: string;
  value: string;
  message?: string;
  /** e.g. [["operations", 1], ["create"], ["name"]] */
  path?: [string, number?][];
  /** Quota errors: details.quotaErrorDetails.retryDelay, e.g. "3600s". */
  retryDelay?: string;
  /** Quota errors: details.quotaErrorDetails.rateScope (default "DEVELOPER"). */
  rateScope?: string;
}

export const googleAdsFailure = (errors: FakeError[], requestId = "fake-request-id") => ({
  "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
  errors: errors.map((e) => ({
    errorCode: { [e.type]: e.value },
    message: e.message ?? `${e.value} (fake)`,
    ...(e.retryDelay
      ? {
          details: {
            quotaErrorDetails: {
              rateScope: e.rateScope ?? "DEVELOPER",
              rateName: "Number of operations (fake)",
              retryDelay: e.retryDelay,
            },
          },
        }
      : {}),
    ...(e.path
      ? {
          location: {
            fieldPathElements: e.path.map(([fieldName, index]) =>
              index === undefined ? { fieldName } : { fieldName, index },
            ),
          },
        }
      : {}),
  })),
  requestId,
});

export const errorBody = (
  code: number,
  status: string,
  errors: FakeError[],
  extraDetails: unknown[] = [],
) => ({
  error: {
    code,
    message: "Request contains an invalid argument.",
    status,
    details: [googleAdsFailure(errors), ...extraDetails],
  },
});

export const retryInfo = (seconds: number) => ({
  "@type": "type.googleapis.com/google.rpc.RetryInfo",
  retryDelay: `${seconds}s`,
});

export const partialFailureError = (errors: FakeError[]) => ({
  code: 3,
  message: "Multiple errors in 'details'. First error: fake.",
  details: [googleAdsFailure(errors)],
});

export const campaignRow = (id: string, name: string) => ({
  campaign: {
    resourceName: `customers/${FAKE_CUSTOMER}/campaigns/${id}`,
    id,
    name,
  },
});
