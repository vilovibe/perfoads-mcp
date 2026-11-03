// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { AdsNotAllowedError } from "./errors.js";
import { asArray, asObject, asString, type JsonObject } from "./json.js";
import { parseMicros } from "./money.js";
import { normalizeCustomerId, type Transport } from "./transport.js";
import type { AccessLevel } from "./types.js";

export interface KeywordIdeasParams {
  customerId: string;
  loginCustomerId?: string | undefined;
  /** Caller's known access level. Explorer access has no keyword planning. */
  accessLevel: AccessLevel;
  /** e.g. "languageConstants/1000" (English). */
  language: string;
  /** e.g. ["geoTargetConstants/2840"]. Empty = all locations. */
  geoTargetConstants: string[];
  keywords?: string[];
  url?: string;
  network?: "GOOGLE_SEARCH" | "GOOGLE_SEARCH_AND_PARTNERS";
  includeAdultKeywords?: boolean;
  pageSize?: number;
  pageToken?: string;
  /** Aborts the read in flight (e.g. the tool ran out of time). */
  signal?: AbortSignal | undefined;
  deadlineMs?: number | undefined;
}

export interface KeywordIdea {
  text: string;
  avgMonthlySearches: number | null;
  competition: string | null;
  competitionIndex: number | null;
  lowTopOfPageBidMicros: bigint | null;
  highTopOfPageBidMicros: bigint | null;
}

export interface KeywordIdeasPage {
  ideas: KeywordIdea[];
  nextPageToken: string | undefined;
  googleRequestId: string | undefined;
}

const intOrNull = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const microsOrNull = (v: unknown): bigint | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  try {
    return parseMicros(v);
  } catch {
    return null;
  }
};

/**
 * KeywordPlanIdeaService.GenerateKeywordIdeas, one page. No caching here. 1 operation.
 * Refused before sending on Explorer access (no Keyword Planner) and on Test access (test
 * accounts give no real planning data).
 */
export const generateKeywordIdeas = async (
  t: Transport,
  p: KeywordIdeasParams,
): Promise<KeywordIdeasPage> => {
  if (p.accessLevel === "explorer" || p.accessLevel === "test") {
    throw new AdsNotAllowedError(
      `Keyword ideas need Basic or Standard API access. ${p.accessLevel === "explorer" ? "Explorer" : "Test"} access can't use the Keyword Planner.`,
      "access_level",
    );
  }
  const keywords = (p.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length === 0 && !p.url) throw new RangeError("give seed keywords, a URL, or both");
  const customerId = normalizeCustomerId(p.customerId);

  const body: JsonObject = {
    language: p.language,
    geoTargetConstants: p.geoTargetConstants,
    keywordPlanNetwork: p.network ?? "GOOGLE_SEARCH",
    includeAdultKeywords: p.includeAdultKeywords === true,
  };
  if (keywords.length && p.url) body.keywordAndUrlSeed = { url: p.url, keywords };
  else if (keywords.length) body.keywordSeed = { keywords };
  else body.urlSeed = { url: p.url };
  if (p.pageSize) body.pageSize = p.pageSize;
  if (p.pageToken) body.pageToken = p.pageToken;

  const res = await t.read({
    method: "POST",
    path: `customers/${customerId}:generateKeywordIdeas`,
    body,
    loginCustomerId: p.loginCustomerId,
    opsCost: 1,
    opsKind: "other",
    signal: p.signal,
    deadlineMs: p.deadlineMs,
  });
  const json = asObject(res.json);
  const ideas = asArray(json.results)
    .map(asObject)
    .map((r) => {
      const m = asObject(r.keywordIdeaMetrics);
      return {
        text: asString(r.text) ?? "",
        avgMonthlySearches: intOrNull(m.avgMonthlySearches),
        competition: asString(m.competition) ?? null,
        competitionIndex: intOrNull(m.competitionIndex),
        lowTopOfPageBidMicros: microsOrNull(m.lowTopOfPageBidMicros),
        highTopOfPageBidMicros: microsOrNull(m.highTopOfPageBidMicros),
      };
    })
    .filter((idea) => idea.text !== "");
  return {
    ideas,
    nextPageToken: asString(json.nextPageToken) || undefined,
    googleRequestId: res.googleRequestId,
  };
};
