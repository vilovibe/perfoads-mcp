// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Test doubles for readers: a search function routed by the GAQL FROM clause.
// Hand-written rows in Google's REST JSON shape. Fake ids only, never real data.

import { GoogleAdsApiError } from "@perfoads/ads-client";
import type { Row } from "../normalise.js";
import type { ReaderContext, SearchFn } from "../reader.js";

export const FAKE_CUSTOMER = "1234567890";

/** Rows per resource, an Error to throw, or a function of the query. */
export type Route = Row[] | Error | ((query: string) => Row[] | Error);

export const fakeSearch = (routes: Record<string, Route>) => {
  const queries: string[] = [];
  const search: SearchFn = async (query, maxRows) => {
    queries.push(query);
    const resource = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
    const route = routes[resource];
    if (route === undefined) throw new Error(`fake search: no route for ${resource}`);
    const result = typeof route === "function" ? route(query) : route;
    if (result instanceof Error) throw result;
    return { rows: result.slice(0, maxRows) };
  };
  return { search, queries };
};

export const fakeContext = (
  search: SearchFn,
  overrides: Partial<ReaderContext> = {},
): ReaderContext => ({
  customerId: FAKE_CUSTOMER,
  currencyCode: "EUR",
  isManager: false,
  search,
  ...overrides,
});

export const rn = (kind: string, id: string) => `customers/${FAKE_CUSTOMER}/${kind}/${id}`;

/** A Google refusal as the ads client throws it (e.g. 400 for a field Google refuses). */
export const googleError = (
  httpStatus: number,
  message = "Request contains an invalid argument.",
) =>
  new GoogleAdsApiError(message, httpStatus, [], "fake-request-id", "INVALID_ARGUMENT", undefined);
