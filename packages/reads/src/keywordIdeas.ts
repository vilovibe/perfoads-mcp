// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Input checks and output shape for keyword_ideas (KeywordPlanIdeaService, not GAQL).
// Language ids ported from PerfoAds KP_LANG_IDS. Not ported: PerfoAds' "bid > 500 means
// nanos" correction, which is blind to currency (500 JPY is a normal CPC).

import { microsToDecimalString, type KeywordIdea } from "@perfoads/ads-client";
import * as z from "zod";
import { ReadInputError } from "./dateRange.js";
import { enumValue } from "./normalise.js";
import { untrustedText, UntrustedSchema } from "./untrusted.js";

/** Google Ads language constants by language code (subset; any id can be given as digits). */
export const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  en: "1000",
  pl: "1030",
  de: "1001",
  fr: "1002",
  es: "1003",
  nl: "1010",
  it: "1004",
  pt: "1014",
  sv: "1015",
  da: "1009",
  fi: "1011",
  nb: "1013",
  no: "1013",
  cs: "1021",
  sk: "1033",
  hu: "1024",
  ro: "1032",
  el: "1022",
  tr: "1037",
  ja: "1005",
  ko: "1012",
  ru: "1031",
  zh: "1017",
  "zh-tw": "1018",
  bg: "1020",
  hr: "1039",
  sl: "1034",
  uk: "1036",
  lt: "1029",
  lv: "1028",
  et: "1043",
};

export const MAX_SEED_KEYWORDS = 20;
export const MAX_GEO_TARGETS = 10;
export const MAX_IDEAS = 200;
export const DEFAULT_IDEAS = 50;

export interface KeywordIdeasInput {
  keywords: string[];
  url: string | null;
  languageId: string;
  geoTargetIds: string[];
  network: "GOOGLE_SEARCH" | "GOOGLE_SEARCH_AND_PARTNERS";
  maxResults: number;
}

/** Raw tool input -> checked input. Throws ReadInputError with a plain reason. */
export const keywordIdeasInput = (raw: {
  keywords?: string[] | undefined;
  url?: string | undefined;
  language?: string | undefined;
  geo_target_ids?: string[] | undefined;
  include_search_partners?: boolean | undefined;
  max_results?: number | undefined;
}): KeywordIdeasInput => {
  const keywords = (raw.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length > MAX_SEED_KEYWORDS) {
    throw new ReadInputError(`Give at most ${MAX_SEED_KEYWORDS} seed keywords.`);
  }
  if (keywords.some((k) => Array.from(k).length > 80)) {
    throw new ReadInputError("A seed keyword is longer than 80 characters.");
  }
  let url: string | null = null;
  if (raw.url !== undefined && raw.url.trim() !== "") {
    try {
      const u = new URL(raw.url.trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
      url = u.toString();
    } catch {
      throw new ReadInputError("url must be a full web address, e.g. https://example.com/page.");
    }
    if (url.length > 2048) throw new ReadInputError("url is too long.");
  }
  if (keywords.length === 0 && url === null) {
    throw new ReadInputError("Give seed keywords, a url, or both.");
  }
  const lang = (raw.language ?? "en").trim().toLowerCase().replace(/_/g, "-");
  const languageId = /^\d{1,10}$/.test(lang)
    ? lang
    : (LANGUAGE_IDS[lang] ?? LANGUAGE_IDS[lang.split("-")[0] ?? ""]);
  if (!languageId) {
    throw new ReadInputError(
      `Unknown language "${lang.slice(0, 20)}". Use a code like en, de, pl or a Google language id like 1000.`,
    );
  }
  const geoTargetIds = (raw.geo_target_ids ?? []).map((g) => g.trim());
  if (geoTargetIds.length > MAX_GEO_TARGETS) {
    throw new ReadInputError(`Give at most ${MAX_GEO_TARGETS} locations.`);
  }
  if (geoTargetIds.some((g) => !/^\d{1,10}$/.test(g))) {
    throw new ReadInputError(
      "geo_target_ids must be Google location ids (digits), e.g. 2840 = USA.",
    );
  }
  const maxResults = raw.max_results ?? DEFAULT_IDEAS;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_IDEAS) {
    throw new ReadInputError(`max_results must be 1 to ${MAX_IDEAS}.`);
  }
  return {
    keywords,
    url,
    languageId,
    geoTargetIds,
    network: raw.include_search_partners ? "GOOGLE_SEARCH_AND_PARTNERS" : "GOOGLE_SEARCH",
    maxResults,
  };
};

export const KeywordIdeaRowSchema = z.object({
  text: UntrustedSchema,
  avgMonthlySearches: z.number().nullable(),
  competition: z.string().nullable().describe("LOW, MEDIUM, HIGH"),
  competitionIndex: z.number().nullable().describe("0-100"),
  lowTopOfPageBid: z.string().nullable().describe("Account currency"),
  highTopOfPageBid: z.string().nullable(),
});
export type KeywordIdeaRow = z.infer<typeof KeywordIdeaRowSchema>;

export const keywordIdeaRow = (idea: KeywordIdea): KeywordIdeaRow => ({
  text: untrustedText(idea.text),
  avgMonthlySearches: idea.avgMonthlySearches,
  competition: enumValue(idea.competition),
  competitionIndex: idea.competitionIndex,
  lowTopOfPageBid:
    idea.lowTopOfPageBidMicros === null ? null : microsToDecimalString(idea.lowTopOfPageBidMicros),
  highTopOfPageBid:
    idea.highTopOfPageBidMicros === null
      ? null
      : microsToDecimalString(idea.highTopOfPageBidMicros),
});

/** Most searched first; ties by text so the order is stable. */
export const compareIdeas = (a: KeywordIdeaRow, b: KeywordIdeaRow): number =>
  (b.avgMonthlySearches ?? -1) - (a.avgMonthlySearches ?? -1) ||
  a.text.untrusted.localeCompare(b.text.untrusted);
