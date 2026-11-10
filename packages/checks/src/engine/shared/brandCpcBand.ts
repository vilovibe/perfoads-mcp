// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The brand click-price band: what a click on the account's own brand name
 * should cost at most. ONE helper,
 * read by BB15. The bar is RELATIVE so it fits any currency and market: the
 * larger of a small floor (0.40 in the account's currency scale, or the user's
 * settings.bidding.brandCpcFloorUsd) and a share (40%, or
 * settings.bidding.brandCpcShareOfNonBrand) of the account's own non-brand CPC.
 */
import { scaleMoney, type CurrencyScale } from "./currencyScale.js";

/** The floor in USD scale (converted to the account currency). */
export const BRAND_CPC_FLOOR_USD = 0.4;
/** The share of the account's non-brand CPC a brand click may cost. */
export const BRAND_CPC_SHARE_OF_NON_BRAND = 0.4;

export interface BrandCpcBand {
  /** the highest usual brand click price, account currency */
  bar: number;
  /** the floor in the account currency */
  floor: number;
  /** the non-brand CPC share used */
  share: number;
}

/** bar = max(floor in the account currency, share x non-brand CPC). Pure. */
export function brandCpcBand(input: {
  nonBrandCpc: number;
  currency: CurrencyScale;
  floorUsd?: number;
  share?: number;
}): BrandCpcBand {
  const floor = scaleMoney(input.floorUsd ?? BRAND_CPC_FLOOR_USD, input.currency);
  const share = input.share ?? BRAND_CPC_SHARE_OF_NON_BRAND;
  const nb = Number.isFinite(input.nonBrandCpc) && input.nonBrandCpc > 0 ? input.nonBrandCpc : 0;
  return { bar: Math.max(floor, share * nb), floor, share };
}
