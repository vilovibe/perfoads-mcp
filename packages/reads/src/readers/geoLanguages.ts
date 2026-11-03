// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). Where people were and which languages the
// campaigns target, for the country and language checks. One GAQL resource per part:
// - countries (geographic_view, over the range): each campaign's spend by the COUNTRY people
//   were in (or showed interest in: location_type says which). This is the user's location,
//   kept apart from location_view (the targeted locations a location adjustment multiplies);
// - country_names (geo_target_constant): every country's code and name, to name those rows;
// - campaign_languages (campaign_criterion): the language criteria of non-removed campaigns
//   (a campaign with none targets every language, except Demand Gen, which can set languages
//   per ad group: those are not read, so the check treats a Demand Gen campaign's language as
//   unknown);
// - language_codes (language_constant): every language's code, to name those criteria.

import * as z from "zod";
import { MetricsSchema, plural, where, type FilterInput } from "../common.js";
import { dateCondition, describeDateRange } from "../dateRange.js";
import { enumValue, get, id, metrics } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";

export const GEO_LANGUAGE_ROW_KINDS = ["country", "campaign_language"] as const;

export const GeoLanguageRowSchema = z.object({
  kind: z.enum(GEO_LANGUAGE_ROW_KINDS),
  campaignId: z.string(),
  countryId: z.string().nullable().describe("geo target constant id of the country"),
  countryCode: z.string().nullable().describe("ISO 3166-1 alpha-2, null = not known"),
  countryName: z.string().nullable(),
  locationType: z.string().nullable().describe("LOCATION_OF_PRESENCE or AREA_OF_INTEREST"),
  criterionId: z.string().nullable(),
  languageId: z.string().nullable(),
  languageCode: z.string().nullable().describe("null = the code could not be read"),
  negative: z.boolean().nullable(),
  status: z.string().nullable(),
  metrics: MetricsSchema.nullable(),
});
export type GeoLanguageRow = z.infer<typeof GeoLanguageRowSchema>;

export const GeoLanguageSummarySchema = z.object({
  countryRows: z.number().nullable().describe("null = not read"),
  languageCriteria: z.number().nullable(),
});
export type GeoLanguageSummary = z.infer<typeof GeoLanguageSummarySchema>;

/** Campaign x country x location type rows, the costliest first; more is a sample. */
export const COUNTRY_ROW_CAP = 10_000;

export const countriesQuery = (input: FilterInput): string => `
    SELECT
      campaign.id,
      campaign.status,
      geographic_view.country_criterion_id,
      geographic_view.location_type,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM geographic_view
    ${where([dateCondition(input.dateRange), "campaign.status != 'REMOVED'"])}
    ORDER BY metrics.cost_micros DESC`;

export const COUNTRY_NAMES_QUERY = `
    SELECT
      geo_target_constant.id,
      geo_target_constant.country_code,
      geo_target_constant.name
    FROM geo_target_constant
    WHERE geo_target_constant.target_type = 'Country'
    ORDER BY geo_target_constant.id`;

export const CAMPAIGN_LANGUAGES_QUERY = `
    SELECT
      campaign.id,
      campaign_criterion.criterion_id,
      campaign_criterion.language.language_constant,
      campaign_criterion.negative,
      campaign_criterion.status
    FROM campaign_criterion
    WHERE campaign_criterion.type = 'LANGUAGE'
      AND campaign_criterion.status != 'REMOVED'
      AND campaign.status != 'REMOVED'
    ORDER BY campaign.id, campaign_criterion.criterion_id`;

export const LANGUAGE_CODES_QUERY = `
    SELECT
      language_constant.id,
      language_constant.code
    FROM language_constant
    ORDER BY language_constant.id`;

const COUNTRY_CODE = /^[A-Z]{2}$/;
/** "languageConstants/1000" -> "1000" (a constant's resource name has no customer part). */
const languageIdOf = (v: unknown): string | null => {
  const m = typeof v === "string" ? /^languageConstants\/(\d{1,20})$/.exec(v) : null;
  return m ? (m[1] ?? null) : null;
};
/** Language codes as Google writes them: en, zh_CN, zh_TW, pt_BR, iw. */
const LANGUAGE_CODE = /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/;
/** Country names are Google's constants, not user text; anything odd is dropped. */
const plainName = (v: unknown): string | null =>
  typeof v === "string" && /^[\p{L}\p{M} .,'()&-]{1,80}$/u.test(v) ? v : null;

export const geoLanguagesReader: ReaderDef<FilterInput, GeoLanguageRow, GeoLanguageSummary, null> =
  {
    name: "geo_languages",
    queries: (input) => ({
      countries: { gaql: countriesQuery(input), limit: COUNTRY_ROW_CAP },
      country_names: { gaql: COUNTRY_NAMES_QUERY },
      campaign_languages: { gaql: CAMPAIGN_LANGUAGES_QUERY },
      language_codes: { gaql: LANGUAGE_CODES_QUERY },
    }),
    map: (data, _input, _ctx, parts) => {
      const countries = new Map<string, { code: string | null; name: string | null }>();
      for (const r of data.country_names ?? []) {
        const cid = id(get(r, "geoTargetConstant.id"));
        const code = get(r, "geoTargetConstant.countryCode");
        if (cid)
          countries.set(cid, {
            code: typeof code === "string" && COUNTRY_CODE.test(code) ? code : null,
            name: plainName(get(r, "geoTargetConstant.name")),
          });
      }
      const languages = new Map<string, string>();
      for (const r of data.language_codes ?? []) {
        const lid = id(get(r, "languageConstant.id"));
        const code = get(r, "languageConstant.code");
        if (lid && typeof code === "string" && LANGUAGE_CODE.test(code)) languages.set(lid, code);
      }
      // a code that was not read stays null, never a guess
      const namesRead = partOk(parts, "country_names");
      const codesRead = partOk(parts, "language_codes");
      const rows: GeoLanguageRow[] = [];
      for (const r of data.countries ?? []) {
        const campaignId = id(get(r, "campaign.id"));
        const countryId = id(get(r, "geographicView.countryCriterionId"));
        if (!campaignId || !countryId) continue;
        const c = namesRead ? countries.get(countryId) : undefined;
        rows.push({
          kind: "country",
          campaignId,
          countryId,
          countryCode: c?.code ?? null,
          countryName: c?.name ?? null,
          locationType: enumValue(get(r, "geographicView.locationType")),
          criterionId: null,
          languageId: null,
          languageCode: null,
          negative: null,
          status: null,
          metrics: metrics(r),
        });
      }
      for (const r of data.campaign_languages ?? []) {
        const campaignId = id(get(r, "campaign.id"));
        if (!campaignId) continue;
        const languageId = languageIdOf(get(r, "campaignCriterion.language.languageConstant"));
        rows.push({
          kind: "campaign_language",
          campaignId,
          countryId: null,
          countryCode: null,
          countryName: null,
          locationType: null,
          criterionId: id(get(r, "campaignCriterion.criterionId")),
          languageId,
          languageCode: codesRead && languageId ? (languages.get(languageId) ?? null) : null,
          negative: get(r, "campaignCriterion.negative") === true,
          status: enumValue(get(r, "campaignCriterion.status")),
          metrics: null,
        });
      }
      return { rows, extra: null };
    },
    compare: (a, b) =>
      GEO_LANGUAGE_ROW_KINDS.indexOf(a.kind) - GEO_LANGUAGE_ROW_KINDS.indexOf(b.kind) ||
      a.campaignId.localeCompare(b.campaignId) ||
      (a.countryId ?? a.criterionId ?? "").localeCompare(b.countryId ?? b.criterionId ?? "") ||
      (a.locationType ?? "").localeCompare(b.locationType ?? ""),
    summarise: (rows, _extra, _ctx, _input, parts) => ({
      countryRows: partOk(parts, "countries")
        ? rows.filter((r) => r.kind === "country").length
        : null,
      languageCriteria: partOk(parts, "campaign_languages")
        ? rows.filter((r) => r.kind === "campaign_language").length
        : null,
    }),
    summaryLine: (s, ctx, input) =>
      `Countries and languages on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${s.countryRows === null ? "countries unknown" : plural(s.countryRows, "country row")}, ${s.languageCriteria === null ? "languages unknown" : plural(s.languageCriteria, "language criterion")}.`,
    rowLine: (r: GeoLanguageRow) =>
      r.kind === "country"
        ? `country ${r.campaignId} ${r.countryCode ?? r.countryId ?? ""} ${r.locationType ?? ""} cost ${r.metrics?.cost ?? "0"}`
        : `language ${r.campaignId} ${r.languageCode ?? r.languageId ?? ""}`,
  };
