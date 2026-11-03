// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Untrusted-data wrapping. The rule is by FIELD TYPE, never by what a value looks like:
//
// 1. Typed tools (get_campaigns, get_keywords, ...): the normaliser in @perfoads/reads
//    decides per field. Free text (names, ad texts, URLs, search terms, keyword texts,
//    asset texts, labels, Google's messages) is {"untrusted": "..."}. Enums, ids, numbers,
//    money, dates and currency codes are plain. A campaign named "ENABLED" is still
//    wrapped, because `name` is a text field.
//
// 2. query_gaql (any field the model asks for): every string is wrapped EXCEPT
//    - numbers, dates and id-only resource names (strict shapes, cannot carry words),
//    - values of fields in ENUM_FIELDS below, and only when the value has enum shape
//      (A-Z, 0-9, _). Same "ENABLED" in campaign.name is wrapped; in campaign.status it is not.
//      The table is matched on the last key of the JSON path (Google's camelCase field name).
//      Every key in it is an ENUM on every v26 field that ends with it.
//    - `category` only under conversionAction, campaignConversionGoal, customerConversionGoal
//      (an enum there; free text on asset.dynamic_*_asset.category and domain_category), and
//    - `currencyCode` (a STRING in v26, Google-set) only when it is 3 capital letters.
//    Arrays inherit the key of the field that holds them (e.g. primaryStatusReasons).
//    Wrapped text longer than 300 characters is cut, with "truncated": true.

export {
  UNTRUSTED_NOTE,
  UntrustedSchema,
  untrusted,
  untrustedOrNull,
  type Untrusted,
} from "@perfoads/reads";
import { untrustedText } from "@perfoads/reads";

/** Strict shapes that cannot carry instructions: numbers, dates, id-only resource names. */
const SAFE_SHAPES: readonly RegExp[] = [
  /^-?\d+(\.\d+)?$/,
  /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2})?)?$/,
  /^customers\/\d+(\/[A-Za-z]+\/[0-9~]+)*$/,
  /^(geoTargetConstants|languageConstants|currencyConstants)\/\d+$/,
];

/** Google Ads fields (last path key, camelCase) whose values are enums. Small on purpose. */
export const ENUM_FIELDS: ReadonlySet<string> = new Set([
  "status",
  "type",
  "servingStatus",
  "primaryStatus",
  "primaryStatusReasons",
  "advertisingChannelType",
  "advertisingChannelSubType",
  "biddingStrategyType",
  "matchType",
  "searchTermMatchType",
  "deliveryMethod",
  "period",
  "positiveGeoTargetType",
  "negativeGeoTargetType",
  "approvalStatus",
  "reviewStatus",
  "device",
  "dayOfWeek",
  "adNetworkType",
  "creativeQualityScore",
  "postClickQualityScore",
  "searchPredictedCtr",
]);

/** `category` is an enum only under these parents (conversion categories). */
const CATEGORY_ENUM_PARENTS: ReadonlySet<string> = new Set([
  "conversionAction",
  "campaignConversionGoal",
  "customerConversionGoal",
]);

const ENUM_SHAPE = /^[A-Z][A-Z0-9_]*$/;

const isSafeShape = (s: string): boolean => SAFE_SHAPES.some((re) => re.test(s));

const isPlainEnum = (key: string, parent: string, value: string): boolean => {
  if (key === "currencyCode") return /^[A-Z]{3}$/.test(value);
  if (!ENUM_SHAPE.test(value)) return false;
  if (key === "category") return CATEGORY_ENUM_PARENTS.has(parent);
  return ENUM_FIELDS.has(key);
};

/** Wraps every string of a query_gaql row by the rule above. Keys stay as they are. */
export const wrapUntrusted = (value: unknown, key = "", parent = "", depth = 0): unknown => {
  if (typeof value === "string") {
    if (isSafeShape(value) || isPlainEnum(key, parent, value)) return value;
    return untrustedText(value);
  }
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((v) => wrapUntrusted(v, key, parent, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, wrapUntrusted(v, k, key, depth + 1)]),
    );
  }
  return value;
};
