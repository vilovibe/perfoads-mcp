// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Money-threshold scale per account currency.
 *
 * Every money threshold in CAMPAIGN_RULEBOOK is written at USD scale
 * ("a placement is junk above 10", "a term is a cut candidate above 20").
 * On a PLN account those same integers are ~4x too tight, so a 12-dollar
 * placement got called junk and severity rubrics labelled "(account currency)"
 * were quietly comparing against dollars.
 *
 * This is a NOISE-FLOOR scale, not accounting FX. Values are deliberately
 * coarse (1-2 significant figures) and rounded: the question they answer is
 * "what is roughly 10 dollars here", never "what is the exchange rate".
 *
 * MAINTENANCE: most rows drift a few percent a year and do not matter. The
 * high-inflation rows DO — review ARS, TRY, NGN, EGP, RUB, LBP, SYP, IRR, SDG
 * annually; a 30-40% stale factor makes every floor that much too tight and
 * the engine over-flags. (ARS went 350 → 950 → ~1400 across 2023-2025.)
 *
 * Unknown OR MISSING currency → factor 1 with `known: false`. The caller must
 * then SKIP the money-floor rules, not merely lower confidence — with a 1:1
 * factor on an ISK account a 10-unit "junk" floor is seven cents and every
 * placement with any spend at all becomes junk. Only a literal "USD" is known.
 */

/** Approximate units of the currency per 1 USD. Coarse on purpose — see header. */
const UNITS_PER_USD: Record<string, number> = {
  // Majors
  USD: 1,
  EUR: 0.9,
  GBP: 0.8,
  CHF: 0.9,
  CAD: 1.35,
  AUD: 1.5,
  NZD: 1.65,
  SGD: 1.35,
  HKD: 7.8,
  // Europe
  PLN: 4,
  RON: 4.6,
  BGN: 1.8,
  HRK: 7,
  CZK: 23,
  HUF: 360,
  ISK: 138,
  SEK: 10.5,
  NOK: 10.5,
  DKK: 6.9,
  RSD: 105,
  MKD: 57,
  ALL: 92,
  BAM: 1.8,
  MDL: 18,
  GEL: 2.7,
  AMD: 390,
  AZN: 1.7,
  BYN: 3.3,
  UAH: 41,
  RUB: 90,
  TRY: 45,
  // Asia-Pacific
  JPY: 150,
  CNY: 7,
  KRW: 1350,
  TWD: 32,
  THB: 35,
  MYR: 4.5,
  PHP: 57,
  IDR: 16000,
  VND: 25000,
  INR: 84,
  PKR: 280,
  BDT: 118,
  LKR: 300,
  NPR: 135,
  KZT: 480,
  UZS: 12800,
  KGS: 87,
  TJS: 10.9,
  TMT: 3.5,
  MNT: 3400,
  MMK: 2100,
  KHR: 4100,
  LAK: 21800,
  BND: 1.35,
  MOP: 8,
  FJD: 2.2,
  PGK: 4,
  AFN: 70,
  // Middle East / North Africa
  ILS: 3.7,
  SAR: 3.75,
  AED: 3.67,
  QAR: 3.64,
  KWD: 0.31,
  BHD: 0.38,
  OMR: 0.38,
  JOD: 0.71,
  EGP: 48,
  MAD: 10,
  TND: 3.1,
  DZD: 134,
  LYD: 4.85,
  IQD: 1310,
  IRR: 42000,
  LBP: 89500,
  SYP: 13000,
  YER: 250,
  // Sub-Saharan Africa
  ZAR: 18,
  NGN: 1500,
  KES: 130,
  GHS: 15,
  TZS: 2600,
  UGX: 3700,
  ETB: 120,
  XOF: 600,
  XAF: 600,
  MUR: 46,
  BWP: 13.5,
  NAD: 18,
  SZL: 18,
  LSL: 18,
  MZN: 64,
  AOA: 900,
  ZMW: 26,
  MWK: 1700,
  RWF: 1350,
  BIF: 2900,
  CDF: 2800,
  GNF: 8600,
  SLL: 22000,
  LRD: 190,
  GMD: 70,
  CVE: 100,
  STN: 22,
  SCR: 14,
  MGA: 4500,
  KMF: 450,
  DJF: 178,
  SOS: 570,
  ERN: 15,
  SDG: 600,
  // Americas
  BRL: 5,
  MXN: 18,
  ARS: 1400,
  COP: 4000,
  CLP: 930,
  PEN: 3.75,
  UYU: 40,
  BOB: 6.9,
  PYG: 7800,
  GTQ: 7.7,
  HNL: 25,
  NIO: 37,
  CRC: 510,
  DOP: 60,
  JMD: 156,
  TTD: 6.8,
  BBD: 2,
  BSD: 1,
  BZD: 2,
  XCD: 2.7,
};

export interface CurrencyScale {
  /** Currency code the scale was resolved for (upper-cased). "USD" when the code was missing. */
  currency: string;
  /** Multiply a USD-scale threshold by this to get the account-currency threshold. */
  factor: number;
  /**
   * false = the code was missing, blank, or not in the table. factor is 1 and
   * the caller MUST skip money-floor rules rather than compare at USD scale.
   */
  known: boolean;
  /** true when the code itself was absent/blank — distinct from "unrecognised". */
  missing: boolean;
}

export function currencyScale(code: string | null | undefined): CurrencyScale {
  const raw = String(code ?? "")
    .toUpperCase()
    .trim();
  if (!raw) {
    // A missing code is NOT a USD account. Upstream defaults currencyCode to
    // 'USD' only when its own lookup fails, so blank here means "we never
    // learned the currency" — say so instead of asserting dollars.
    return { currency: "USD", factor: 1, known: false, missing: true };
  }
  const factor = UNITS_PER_USD[raw];
  if (factor === undefined) return { currency: raw, factor: 1, known: false, missing: false };
  return { currency: raw, factor, known: true, missing: false };
}

/**
 * Money in the account currency for a sentence: whole units from 100 up ("$835", "$2,655"),
 * cents below ("$90.00"). Same as the PerfoAds app's formatMoney.
 */
export function formatMoney(n: number, currency: string): string {
  const digits = Math.abs(n) >= 100 ? 0 : 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n);
  } catch {
    return `${currency ? `${currency} ` : ""}${n.toFixed(digits)}`;
  }
}

/** Scale a USD-denominated rulebook threshold to the account currency. Rounded to 2dp. */
export function scaleMoney(usdAmount: number, scale: CurrencyScale): number {
  return Math.round(usdAmount * scale.factor * 100) / 100;
}

/**
 * Daily budget safety ceiling (CC M4, batch 7). It was 100,000 a day in the
 * account currency for every account, which refused normal budgets in
 * high-unit currencies (100,000 IDR is about 6 dollars). Now 100,000 USD a day
 * converted with the table above, never lower than the old 100,000 units (so
 * EUR / GBP / KWD keep the old ceiling). Unknown or missing currency keeps the
 * old 100,000 units: we never loosen a guard on a guess.
 */
export const DAILY_BUDGET_CEILING_USD = 100_000;

export function dailyBudgetCeiling(code: string | null | undefined): number {
  const s = currencyScale(code);
  return s.known
    ? Math.round(DAILY_BUDGET_CEILING_USD * Math.max(1, s.factor))
    : DAILY_BUDGET_CEILING_USD;
}

export function dailyBudgetCeilingMicros(code: string | null | undefined): number {
  return dailyBudgetCeiling(code) * 1_000_000;
}

/**
 * The highest per-account ceiling of any listed currency, in micros. For
 * currency-blind shape checks (the action-plan zod validators): the
 * per-account limit is still enforced by validateActionPayload with the
 * account's currency before anything is sent to Google.
 */
export const MAX_DAILY_BUDGET_CEILING_MICROS: number = Math.max(
  ...Object.keys(UNITS_PER_USD).map((c) => dailyBudgetCeilingMicros(c)),
);

/** Currencies Google Ads bills in whole units (budgets must be a multiple of 1 unit). */
const WHOLE_UNIT_CURRENCIES = new Set([
  "JPY",
  "KRW",
  "HUF",
  "TWD",
  "CLP",
  "COP",
  "IDR",
  "VND",
  "ISK",
  "PYG",
  "UGX",
  "XOF",
  "XAF",
  "KMF",
  "RWF",
  "BIF",
  "DJF",
  "GNF",
  "MGA",
  "VUV",
  "XPF",
]);

/** Micros of the currency's smallest billable unit (1 cent = 10_000; whole-unit currencies = 1_000_000). */
export function minorUnitMicros(currency: string | null | undefined): number {
  const code = String(currency || "").toUpperCase();
  if (WHOLE_UNIT_CURRENCIES.has(code)) return 1_000_000;
  let digits = 2;
  try {
    if (code)
      digits =
        new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions()
          .maximumFractionDigits ?? 2;
  } catch {
    digits = 2;
  }
  return 10 ** (6 - Math.min(Math.max(digits, 0), 6));
}

/**
 * Account-currency amount -> micros, rounded to the currency's smallest
 * billable unit first (cents; whole units for JPY / KRW / HUF ...), so Google
 * never gets a budget or bid that is not a multiple of the billable unit.
 * 0 when the amount is not a positive number or rounds to nothing.
 */
export function moneyToMicros(amount: unknown, currency: string | null | undefined): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = minorUnitMicros(currency);
  return Math.round((n * 1_000_000) / unit) * unit;
}
