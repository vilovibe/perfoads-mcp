// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export type UtmClass = "product_sync" | "tagged_other" | "untagged";

/** The name each tag class goes by in metrics and findings (`L.utm_class`). */
export const UTM_CLASS_NAMES: Record<UtmClass, string> = {
  product_sync: "product_sync",
  tagged_other: "tagged",
  untagged: "gclid_only",
};

export interface LandingPageAttrs {
  /** The page: scheme + host + path, Google's {placeholders} stripped, no query. */
  url: string;
  /** host + path, no query, placeholders stripped. Rows are grouped and ads matched on this plus the scheme. */
  urlKey: string;
  /** A few of the URLs read for this page (query strings kept), most spend first. */
  exampleUrls: string[];
  scheme: "https" | "http" | "other";
  /** product_sync = utm_source=google&utm_medium=product_sync (Shopify Google channel, not organic — spec §3.1). Read from the page's URL with the most spend. */
  utmClass: UtmClass;
  utm: Record<string, string>;
  /** 90-day spend per tag class, summed over the page's own links; a class is here only when a link of it was read. */
  utmSpend: Partial<Record<UtmClass, number>>;
  mobileFriendlyPct: number | null;
  speedScore: number | null;
  /** ad ids whose final URL resolves to this page. */
  adIds: string[];
  /**
   * 90-day clicks per campaign that fed the page (summed over its URLs). Shopping and
   * Performance Max pages have no ad id; this is how their campaigns are known.
   * null = not read for every URL of the page.
   */
  campaignClicks: Record<string, number> | null;
  /**
   * Round 4 R17: the shop variant ids its URLs carry (`?variant=`), so a product page can
   * be tied to the product rows the product checks price. Empty = none in its URLs.
   */
  variantIds: string[];
}

export interface LandingPageNode extends BaseNode<"landingPage"> {
  attrs: LandingPageAttrs;
}
