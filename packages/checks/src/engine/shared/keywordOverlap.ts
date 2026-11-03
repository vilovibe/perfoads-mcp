// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The one "same keyword twice" rule SK04 and its confounder (interactions/matrix.ts)
 * share. Two keywords with the same text and match type in two ad groups compete
 * only when they can reach the same people: same campaign, or campaigns that share
 * at least one target country AND at least one language. An NL-only and a DE-only
 * campaign with the same keyword is a country split, not a duplicate. A country a
 * campaign excludes is one it does not reach ("all countries minus NL" never meets an
 * NL-only campaign). Pure, no IO.
 */
import type { AccountModel } from "../model/nodes/AccountNode.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import type { KeywordNode } from "../model/nodes/KeywordNode.js";
import { reportableCampaigns } from "../registry/entityStatus.js";

/** Where and in which languages a campaign can show, as read. "all" = no limit. */
export interface CampaignReach {
  countries: ReadonlySet<string> | "all";
  /** excluded countries (read): never reached, whatever `countries` says */
  excludedCountries: ReadonlySet<string>;
  languages: ReadonlySet<string> | "all";
  /** what was not read, so the reach is taken as "all" on that side */
  unread: string[];
}

/** Country geo target constants are 2000-2999 (2276 Germany, 2528 Netherlands). */
const COUNTRY_ID = /^2\d{3}$/;

/** The campaigns' target locations (bid-modifier criteria) were read. */
function locationsRead(model: AccountModel): boolean {
  const t = model.dataQuality.tables.bidModifiers;
  return t != null && (t.checkable === "ok" || (t.checkable === "unknown" && t.rows > 0));
}

/** The excluded locations were read (unread = nothing taken as excluded: overlap kept). */
function exclusionsRead(model: AccountModel): boolean {
  const t = model.dataQuality.tables.locationCriteria;
  return t != null && t.checkable === "ok";
}

export function campaignReach(model: AccountModel, campaign: CampaignNode): CampaignReach {
  const unread: string[] = [];
  let countries: ReadonlySet<string> | "all" = "all";
  if (!locationsRead(model)) unread.push("target locations");
  else {
    const keys = campaign.children.bidModifiers
      .filter((b) => (b.attrs.modifierSource ?? "").toUpperCase() === "LOCATION")
      .map((b) => (b.attrs.measuredSlice.kind === "geo" ? b.attrs.measuredSlice.key : null));
    // no location = everywhere; a city or region target (its country not read) may sit in
    // any country, so it overlaps every campaign on the country side
    if (keys.length > 0 && keys.every((k): k is string => k != null && COUNTRY_ID.test(k)))
      countries = new Set(keys);
  }
  // only an excluded COUNTRY takes a country away; an excluded city leaves the country reached
  const excludedCountries: ReadonlySet<string> = exclusionsRead(model)
    ? new Set(campaign.attrs.geo.excluded.filter((g) => COUNTRY_ID.test(g)))
    : new Set();
  let languages: ReadonlySet<string> | "all" = "all";
  const l = campaign.attrs.languages;
  if (l == null || l.state !== "synced") unread.push("target languages");
  // no language criterion = every language; a code that was not read could be any language
  else if (l.codes.length > 0 && l.unresolved === 0)
    languages = new Set(l.codes.map((c) => c.toLowerCase()));
  return { countries, excludedCountries, languages, unread };
}

const meets = (a: ReadonlySet<string> | "all", b: ReadonlySet<string> | "all"): boolean =>
  a === "all" || b === "all" || [...a].some((x) => b.has(x));

/** >= 1 country both reach, after each campaign's excluded countries are taken away. */
function countriesMeet(a: CampaignReach, b: CampaignReach): boolean {
  const out = (x: string) => a.excludedCountries.has(x) || b.excludedCountries.has(x);
  // both "all": the world minus a few countries on each side always shares one
  if (a.countries === "all" && b.countries === "all") return true;
  if (a.countries === "all") return [...(b.countries as ReadonlySet<string>)].some((x) => !out(x));
  if (b.countries === "all") return [...a.countries].some((x) => !out(x));
  const bc = b.countries;
  return [...a.countries].some((x) => bc.has(x) && !out(x));
}

/** Two campaigns reach the same people: same campaign, or >= 1 shared country AND language. */
export function campaignsOverlap(
  model: AccountModel,
  a: CampaignNode,
  b: CampaignNode,
): { overlap: boolean; unread: string[] } {
  if (a.id === b.id) return { overlap: true, unread: [] };
  const ra = campaignReach(model, a);
  const rb = campaignReach(model, b);
  return {
    overlap: countriesMeet(ra, rb) && meets(ra.languages, rb.languages),
    unread: [...new Set([...ra.unread, ...rb.unread])],
  };
}

interface KeywordPlace {
  campaign: CampaignNode;
  adGroupId: string;
  keyword: KeywordNode;
}
/** Keyword node id -> where it lives, for SK04's population (built once per model). */
const placeOfKeyword = new WeakMap<AccountModel, Map<string, KeywordPlace>>();
function keywordPlaces(model: AccountModel): Map<string, KeywordPlace> {
  let m = placeOfKeyword.get(model);
  if (!m) {
    m = new Map();
    for (const campaign of reportableCampaigns(model))
      for (const g of campaign.children.adGroups)
        for (const keyword of g.children.keywords)
          if (!keyword.attrs.isNegative) m.set(keyword.id, { campaign, adGroupId: g.id, keyword });
    placeOfKeyword.set(model, m);
  }
  return m;
}

/**
 * The copies of `keyword` that duplicate it by SK04's rule: non-negative keywords in a
 * reportable campaign, in another ad group, whose campaign reaches the same people. A
 * negative keyword, or one outside SK04's population, has none.
 */
export function duplicateCopiesOf(model: AccountModel, keyword: KeywordNode): string[] {
  const places = keywordPlaces(model);
  const own = places.get(keyword.id);
  if (!own) return [];
  return keyword.attrs.cannibalisedBy.filter((id) => {
    const other = places.get(id);
    return (
      other != null &&
      other.adGroupId !== own.adGroupId &&
      campaignsOverlap(model, own.campaign, other.campaign).overlap
    );
  });
}
