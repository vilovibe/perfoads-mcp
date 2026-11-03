// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { asArray, asString, isObject, asObject, type JsonObject } from "./json.js";
import type { Transport } from "./transport.js";

export interface FieldSearchParams {
  /** GoogleAdsFieldService query: SELECT ... WHERE ... (no FROM), e.g. name LIKE 'campaign.%'. */
  query: string;
  pageSize?: number;
  pageToken?: string | undefined;
  signal?: AbortSignal | undefined;
  deadlineMs?: number | undefined;
}

export interface FieldSearchPage {
  results: JsonObject[];
  nextPageToken: string | undefined;
  totalResultsCount: number | null;
}

/**
 * GoogleAdsFieldService.SearchGoogleAdsFields: Google's catalogue of GAQL fields
 * (REST POST /v26/googleAdsFields:search). Not tied to an account. 1 operation per page.
 */
export const searchGoogleAdsFields = async (
  t: Transport,
  p: FieldSearchParams,
): Promise<FieldSearchPage> => {
  const body: JsonObject = { query: p.query };
  if (p.pageSize) body.pageSize = p.pageSize;
  if (p.pageToken) body.pageToken = p.pageToken;
  const res = await t.read({
    method: "POST",
    path: "googleAdsFields:search",
    body,
    opsCost: 1,
    opsKind: "other",
    signal: p.signal,
    deadlineMs: p.deadlineMs,
  });
  const json = asObject(res.json);
  const total = Number(json.totalResultsCount);
  return {
    results: asArray(json.results).filter(isObject),
    nextPageToken: asString(json.nextPageToken) || undefined,
    totalResultsCount: Number.isFinite(total) ? total : null,
  };
};
