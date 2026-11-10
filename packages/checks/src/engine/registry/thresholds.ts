// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Thresholds: every fixed number the metrics and checks compare against.
 *
 * Money thresholds are written at USD scale; `scaleMoney` (shared/currencyScale)
 * converts them to the account currency. An unknown currency makes the caller
 * skip the money floor (`insufficient_data`); it never compares at USD scale.
 *
 * Numbers a reasonable expert could set differently are not here but in
 * `settings.ts` (`CheckSettings`), where a caller can override them per run.
 * What stays here is either plain arithmetic, a sample-size floor below which a
 * rate is noise, or a structural default with its reason written next to it.
 *
 * `T.waste_floor` is NOT defined here: the metric registry owns it
 * (registry/metrics.ts). This file only holds the spend-band ladder it reads.
 */
import { currencyScale, scaleMoney, type CurrencyScale } from "../shared/currencyScale.js";

export { currencyScale, scaleMoney };
export type { CurrencyScale };

/**
 * Zero-conversion "wasted" bar: BOTH a money bar (`T.waste_floor`, a band by
 * monthly spend) AND a statistical click bar. Money alone calls a term with six
 * clicks wasted; clicks alone call a 60-click, 3-dollar term wasted.
 */
export const WASTE = {
  /** Band ladder by monthly spend (USD scale): the input to T.waste_floor. Defaults, no external source. */
  bandUnder1k: 20,
  band1kTo10k: 50,
  band10kTo50k: 100,
  band50kPlus: 200,
  /**
   * Statistical click threshold: the N for which (1 - cvr)^N = alpha, i.e. the
   * clicks after which "zero conversions" is unlikely to be chance at the
   * account's own conversion rate. Plain probability; clamped to 50-400 clicks.
   */
  alpha: 0.05,
  clicksClampMin: 50,
  clicksClampMax: 400,
  /** used when the account conversion rate is unusable */
  clicksDefault: 100,
  /** the account conversion rate is trusted only with this many conversions behind it */
  minConvForAccountCvr: 10,
} as const;

/** Monthly spend (USD scale) -> waste band (USD scale). `bands` = settings.floors (defaults: WASTE). */
export function wasteFloorBand(
  monthlySpendUsd: number,
  bands: {
    wasteBandUnder1kUsd: number;
    wasteBand1kTo10kUsd: number;
    wasteBand10kTo50kUsd: number;
    wasteBand50kPlusUsd: number;
  } = {
    wasteBandUnder1kUsd: WASTE.bandUnder1k,
    wasteBand1kTo10kUsd: WASTE.band1kTo10k,
    wasteBand10kTo50kUsd: WASTE.band10kTo50k,
    wasteBand50kPlusUsd: WASTE.band50kPlus,
  },
): number {
  if (monthlySpendUsd < 1_000) return bands.wasteBandUnder1kUsd;
  if (monthlySpendUsd < 10_000) return bands.wasteBand1kTo10kUsd;
  if (monthlySpendUsd < 50_000) return bands.wasteBand10kTo50kUsd;
  return bands.wasteBand50kPlusUsd;
}

/** Solve (1 - cvr)^N = alpha for N, clamped. A missing or unusable rate gives the default. */
export function statisticalThresholdFromCvr(cvr: number): number {
  if (!cvr || cvr <= 0 || !Number.isFinite(cvr)) return WASTE.clicksDefault;
  const n = Math.ceil(Math.log(WASTE.alpha) / Math.log(1 - cvr));
  if (!Number.isFinite(n)) return WASTE.clicksDefault;
  return Math.max(WASTE.clicksClampMin, Math.min(WASTE.clicksClampMax, n));
}

/**
 * A group of wasting searches is a finding only when its total reaches
 * `minFloors` waste floors AND `minShareOfTermSpend` of all search-term spend.
 */
export const WASTE_ROLLUP = {
  minFloors: 2,
  minShareOfTermSpend: 0.02,
} as const;

/**
 * (product waste, same rule as the PerfoAds app): a product (one model in one colour) is
 * waste in a Shopping or Performance Max campaign at 0 sales once it spent `multiple` x that
 * campaign's 90-day cost per sale (C.product_waste_bar); it sells but loses money (ROAS under
 * 100%) once it spent `lossMultiple` x (C.product_loss_bar). The campaign's own cost per sale
 * needs settings.floors.strongConv sales in 90 days, else the account's (same floor), else the
 * spend band alone; never below that band. A whole category (product type, else Google
 * category) in one campaign loses money at `categoryMultiple` x the product bar with ROAS under
 * 100%, or 1 x with 0 sales.
 */
export const PRODUCT_WASTE = {
  multiple: 2,
  lossMultiple: 1,
  categoryMultiple: 2,
  moneyGate: "C.product_waste_bar",
  lossGate: "C.product_loss_bar",
} as const;

/** Conversion and day floors behind any verdict about an entity's return. */
export const EVIDENCE = {
  /** F.conv_min_for_verdict: a "strong" verdict needs this many conversions. */
  strongConv: 10,
  /** below this many conversions a return verdict is insufficient_data. */
  moderateConv: 3,
  zeroConvStrongClicks: 25,
  zeroConvModerateClicks: 10,
  trendStrongDays: 14,
  trendModerateDays: 7,
} as const;

/** Severity by money: a share of monthly spend. */
export const SEVERITY = {
  criticalShareOfMonthlySpend: 0.1,
  warningShareOfMonthlySpend: 0.02,
} as const;

/** RSA headline count under which an ad is called under-filled. Google allows up to 15. Default, no external source. */
export const ADS = {
  minHeadlines: 11,
} as const;

/** Performance Max asset limits per asset group (Google's own maximums). */
export const PMAX_ASSETS = {
  maxHeadlines: 15,
  maxLongHeadlines: 5,
  maxDescriptions: 5,
  recommendedDescriptions: 4,
  maxSearchThemes: 50,
  /** default "full set" floor for headlines, no external source */
  goodHeadlineFloor: 11,
  minVideos: 1,
  minSquareLogos: 1,
} as const;

/** Device skew: a device CPA this many times the campaign CPA, with enough clicks behind it. Defaults. */
export const DEVICE_SKEW = {
  cpaMultiple: 2.0,
  minSegmentClicks: 30,
} as const;

/** Performance Max: the attributable spend under which the channel split is not judged (USD scale). */
export const PMAX_SHOPPING_SHARE = {
  minPct: 50,
  minAttributableCost: 50,
  viewThroughWarnSharePct: 10,
} as const;

/**
 * Account spend tiers. Below tier A an account is not expected to run the
 * structure a large account needs (brand split, many campaigns, many audience
 * lists). USD scale; the caller divides the account's own spend by
 * `CurrencyScale.factor` first, and skips the tier when the currency is unknown.
 * Defaults, no external source.
 */
export const SPEND_TIER = {
  /** Tier A is everything strictly below this. */
  tierAMaxMonthlyUsd: 3_700,
  /** Tier B runs up to here; Tier C is at or above it. */
  tierBMaxMonthlyUsd: 12_500,
} as const;

/** A = small, B = middle, C = large. */
export type SpendTier = "A" | "B" | "C";

/** Measured monthly spend at USD scale -> tier. `tiers` = settings.floors (defaults: SPEND_TIER). */
export function spendTierOf(
  monthlySpendUsd: number,
  tiers: { spendTierAMaxMonthlyUsd: number; spendTierBMaxMonthlyUsd: number } = {
    spendTierAMaxMonthlyUsd: SPEND_TIER.tierAMaxMonthlyUsd,
    spendTierBMaxMonthlyUsd: SPEND_TIER.tierBMaxMonthlyUsd,
  },
): SpendTier {
  if (monthlySpendUsd < tiers.spendTierAMaxMonthlyUsd) return "A";
  if (monthlySpendUsd < tiers.spendTierBMaxMonthlyUsd) return "B";
  return "C";
}

/** Tier ordering, for "this expectation applies from tier X upward". */
export const SPEND_TIER_ORDER: Readonly<Record<SpendTier, number>> = { A: 0, B: 1, C: 2 };

/** A campaign younger than this is still learning; its verdicts are held back. Default. */
export const LEARNING = {
  minAgeDaysForVerdicts: 14,
} as const;

/**
 * Tracking-break signature: conversions collapse while cost holds, for several
 * consecutive days. The freshest days are excluded because conversions keep
 * arriving for a few days after the click.
 */
export const TRACKING_BREAK = {
  minBaselineConv: 3,
  dropPct: 70,
  costBandPct: 30,
  sustainedDays: 2,
  freshDaysExcluded: 2,
} as const;

/** Sample floors per metric: clicks for rates and slices, conversions for ROAS / CPA verdicts. */
export const FLOORS = {
  roasCpaConv: EVIDENCE.strongConv,
  ratesClicks: 100,
  deviceClicks: DEVICE_SKEW.minSegmentClicks,
  geoClicks: 100,
  demoClicks: 100,
  audienceClicks: 100,
  convPerClickRatioConv: 30,
  cartOrders: 10,
} as const;

/** Volume floors on ASSET and EXTENSION performance claims. */
export const ASSET_FLOORS = {
  /** no asset-performance finding under this many impressions */
  searchAssetImpressions: 100,
  /** no asset-quality finding under this many clicks */
  pmaxAssetClicks: 100,
  /** a sitelink is named only above this many impressions (declared, no consumer yet) */
  sitelinkNameImpressions: 1_000,
} as const;

/** Per-type extension coverage minimums (structural defaults). */
export const EXTENSION_MINIMUMS: Readonly<Record<string, number>> = {
  SITELINK: 4,
  CALLOUT: 6,
  STRUCTURED_SNIPPET: 1,
  CALL: 1,
} as const;

/**
 * M18 (gaps J33): the Search bar. A Search campaign shows up to 4 sitelinks
 * and 4 callouts at once, so it needs 8-12 sitelinks and 10-12 callouts for Google
 * to rotate and learn. SK16 tests Search campaigns against `min`. Other campaign
 * types keep EXTENSION_MINIMUMS.
 */
export const SEARCH_EXTENSION_BAR: Readonly<
  Record<"SITELINK" | "CALLOUT", { min: number; max: number }>
> = {
  SITELINK: { min: 8, max: 12 },
  CALLOUT: { min: 10, max: 12 },
} as const;

/** The whole table, for printing / tests. */
export const THRESHOLDS = {
  WASTE,
  WASTE_ROLLUP,
  PRODUCT_WASTE,
  EVIDENCE,
  SEVERITY,
  ADS,
  PMAX_ASSETS,
  DEVICE_SKEW,
  PMAX_SHOPPING_SHARE,
  SPEND_TIER,
  LEARNING,
  TRACKING_BREAK,
  FLOORS,
  ASSET_FLOORS,
  EXTENSION_MINIMUMS,
} as const;
