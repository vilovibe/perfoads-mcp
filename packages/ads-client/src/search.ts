// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { toGoogleAdsApiError } from "./errors.js";
import { asArray, asObject, asString, isObject, type JsonObject } from "./json.js";
import { normalizeCustomerId, type Transport } from "./transport.js";

export interface SearchParams {
  customerId: string;
  query: string;
  loginCustomerId?: string | undefined;
  /** Aborts the read in flight (e.g. the tool ran out of time). */
  signal?: AbortSignal | undefined;
  /** Deadline for this read, all retries included, if shorter than the client default. */
  deadlineMs?: number | undefined;
}

export interface SearchPage {
  rows: JsonObject[];
  nextPageToken: string | undefined;
  googleRequestId: string | undefined;
}

export interface SearchAllResult {
  rows: JsonObject[];
  /** True when maxRows or shouldStop stopped the paging early; nextPageToken then resumes it. */
  truncated: boolean;
  /** True when shouldStop (not maxRows) ended the paging. */
  stoppedEarly: boolean;
  nextPageToken: string | undefined;
  pages: number;
}

/** One page of GoogleAdsService.Search (Google fixes the page size). Costs 1 operation. */
export const searchPage = async (
  t: Transport,
  params: SearchParams & { pageToken?: string | undefined },
): Promise<SearchPage> => {
  const customerId = normalizeCustomerId(params.customerId);
  const body: JsonObject = { query: params.query };
  if (params.pageToken) body.pageToken = params.pageToken;
  const res = await t.read({
    method: "POST",
    path: `customers/${customerId}/googleAds:search`,
    body,
    loginCustomerId: params.loginCustomerId,
    opsCost: 1,
    opsKind: "search",
    signal: params.signal,
    deadlineMs: params.deadlineMs,
  });
  const json = asObject(res.json);
  return {
    rows: asArray(json.results).filter(isObject),
    nextPageToken: asString(json.nextPageToken) || undefined,
    googleRequestId: res.googleRequestId,
  };
};

/**
 * Follows page tokens until the end, until maxRows rows are collected, or until
 * shouldStop() says so before the next page (e.g. little time left).
 */
export const searchAll = async (
  t: Transport,
  params: SearchParams & {
    maxRows?: number;
    pageToken?: string | undefined;
    shouldStop?: () => boolean;
  },
): Promise<SearchAllResult> => {
  const maxRows = params.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: JsonObject[] = [];
  let pageToken = params.pageToken;
  let pages = 0;
  do {
    const page = await searchPage(t, { ...params, pageToken });
    pages++;
    rows.push(...page.rows);
    pageToken = page.nextPageToken;
    if (rows.length >= maxRows && pageToken !== undefined) {
      return {
        rows: rows.slice(0, maxRows),
        truncated: true,
        stoppedEarly: false,
        nextPageToken: pageToken,
        pages,
      };
    }
    if (pageToken !== undefined && params.shouldStop?.()) {
      return { rows, truncated: true, stoppedEarly: true, nextPageToken: pageToken, pages };
    }
  } while (pageToken);
  const truncated = rows.length > maxRows;
  return {
    rows: rows.slice(0, maxRows),
    truncated,
    stoppedEarly: false,
    nextPageToken: undefined,
    pages,
  };
};

/** GoogleAdsService.SearchStream: every row in one reply. Costs 1 operation. */
export const searchStream = async (t: Transport, params: SearchParams): Promise<JsonObject[]> => {
  const customerId = normalizeCustomerId(params.customerId);
  const res = await t.read({
    method: "POST",
    path: `customers/${customerId}/googleAds:searchStream`,
    body: { query: params.query },
    loginCustomerId: params.loginCustomerId,
    opsCost: 1,
    opsKind: "search",
  });
  const rows: JsonObject[] = [];
  for (const batch of asArray(res.json).map(asObject)) {
    // A stream can fail part way: the error then arrives as the last batch.
    if (isObject(batch.error)) {
      const code = batch.error.code;
      const status = typeof code === "number" && code >= 400 ? code : 500;
      throw toGoogleAdsApiError(batch, status, res.googleRequestId, undefined);
    }
    rows.push(...asArray(batch.results).filter(isObject));
  }
  return rows;
};
