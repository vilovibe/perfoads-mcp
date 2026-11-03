// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { discoverAccounts, listAccessibleCustomers } from "./accounts.js";
import type { JsonObject } from "./json.js";
import { searchGoogleAdsFields, type FieldSearchParams } from "./fields.js";
import { generateKeywordIdeas, type KeywordIdeasParams } from "./keywordPlanner.js";
import { mutate, mutateAll, removeIdempotent, type WriteOptions } from "./mutate.js";
import { searchAll, searchPage, searchStream, type SearchParams } from "./search.js";
import { createTransport, type AdsClientConfig } from "./transport.js";

/** The Google Ads REST client. All dependencies (tokens, fetch, logger, ops counter) are injected. */
export const createAdsClient = (config: AdsClientConfig) => {
  const t = createTransport(config);
  return {
    searchPage: (p: SearchParams & { pageToken?: string }) => searchPage(t, p),
    searchAll: (
      p: SearchParams & { maxRows?: number; pageToken?: string; shouldStop?: () => boolean },
    ) => searchAll(t, p),
    searchStream: (p: SearchParams) => searchStream(t, p),
    mutate: (service: string, operations: JsonObject[], o: WriteOptions) =>
      mutate(t, service, operations, o),
    mutateAll: (mutateOperations: JsonObject[], o: WriteOptions) =>
      mutateAll(t, mutateOperations, o),
    removeIdempotent: (
      service: string,
      resourceNames: string[],
      o: Omit<WriteOptions, "partialFailure" | "responseContentType">,
    ) => removeIdempotent(t, service, resourceNames, o),
    listAccessibleCustomers: () => listAccessibleCustomers(t),
    discoverAccounts: () => discoverAccounts(t),
    generateKeywordIdeas: (p: KeywordIdeasParams) => generateKeywordIdeas(t, p),
    searchGoogleAdsFields: (p: FieldSearchParams) => searchGoogleAdsFields(t, p),
  };
};

export type AdsClient = ReturnType<typeof createAdsClient>;
