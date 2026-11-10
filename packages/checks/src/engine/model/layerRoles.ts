// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Each campaign's role (brand / retargeting / prospecting), read from
 * structure first and the name only as the old fallback.
 *
 * Order (first answer wins):
 *   1. the caller's brand tag, when one is given;
 *   2. brand by name (`isBrand`, the whole-word name rule);
 *   3. brand by searches: a Search or Shopping campaign whose own searches are
 *      mostly brand searches (brand searches carry at least half of its search
 *      clicks, 3+ searches; the brand terms the user gave, product names that
 *      work as brand names included);
 *   4. retargeting: named for remarketing ("remarketing", "RLSA", "RT");
 *   5. else prospecting.
 * Pure.
 */
import type { CampaignNode, LayerRole } from "./nodes/CampaignNode.js";

const REMARKETING_NAME = /remarket|retarget|re-target|\brlsa\b|\brmkt\b/i;
/** Short remarketing tags are upper case in campaign names ("... - DGEN - RT"); case-sensitive. */
const REMARKETING_TAG = /\bRT\b|\bDRM\b/;
export function isRemarketingCampaignName(name: string): boolean {
  return REMARKETING_NAME.test(name) || REMARKETING_TAG.test(name);
}

const BRAND_TERM_SHARE = 0.5;
const BRAND_TERM_MIN_ROWS = 3;

export interface LayerRoleInput {
  campaigns: readonly CampaignNode[];
  isBrandText: ((text: string) => boolean) | null;
  ownerTags?: {
    brandCampaignNames: readonly string[];
  } | null;
}

export interface LayerRoleAnswer {
  role: LayerRole;
  why: string;
}

function searchTermsOf(c: CampaignNode) {
  return [
    ...c.children.searchTerms,
    ...c.children.adGroups.flatMap((g) => g.children.searchTerms),
  ].filter((t) => t.attrs.source !== "pmaxSearchTerms");
}

function mostlyBrandSearches(
  c: CampaignNode,
  isBrandText: ((t: string) => boolean) | null,
): boolean {
  if (!isBrandText || (c.attrs.type !== "SEARCH" && c.attrs.type !== "SHOPPING")) return false;
  const terms = searchTermsOf(c);
  if (terms.length < BRAND_TERM_MIN_ROWS) return false;
  const clicks = terms.reduce((s, t) => s + (t.windows.m90.clicks ?? 0), 0);
  const brand = terms.filter((t) => isBrandText(t.attrs.term));
  if (clicks > 0)
    return brand.reduce((s, t) => s + (t.windows.m90.clicks ?? 0), 0) / clicks >= BRAND_TERM_SHARE;
  return brand.length / terms.length >= BRAND_TERM_SHARE;
}

export function layerRolesOf(input: LayerRoleInput): Map<string, LayerRoleAnswer> {
  const out = new Map<string, LayerRoleAnswer>();
  const brandTags = new Set(input.ownerTags?.brandCampaignNames ?? []);
  for (const c of input.campaigns) {
    if (brandTags.has(c.name)) {
      out.set(c.id, { role: "brand", why: "tagged as a brand campaign" });
      continue;
    }
    if (c.attrs.isBrand) {
      out.set(c.id, { role: "brand", why: "its name says brand" });
      continue;
    }
    if (mostlyBrandSearches(c, input.isBrandText)) {
      out.set(c.id, { role: "brand", why: "most of its search clicks are brand searches" });
      continue;
    }
    if (isRemarketingCampaignName(c.name)) {
      out.set(c.id, { role: "retargeting", why: "its name says remarketing" });
      continue;
    }
    out.set(c.id, { role: "prospecting", why: "a main campaign for new searches" });
  }
  return out;
}

export function assignLayerRoles(input: LayerRoleInput): void {
  const roles = layerRolesOf(input);
  for (const c of input.campaigns) {
    const r = roles.get(c.id);
    c.attrs.layerRole = r?.role ?? null;
    c.attrs.layerRoleWhy = r?.why ?? null;
  }
}
