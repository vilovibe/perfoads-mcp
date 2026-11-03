// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Money in Google Ads is in micros (1 unit = 1,000,000 micros), sent as int64 strings.
// Everything here works on BigInt: IDR and VND budgets pass the JS safe-integer limit
// in micros, and float division gives wrong cents.

export const MICROS_PER_UNIT = 1_000_000n;

/**
 * Smallest billable amount per currency, in micros, from Google's currency codes table
 * (developers.google.com/google-ads/api/data/codes-formats, "Minimum unit" column).
 * The same value is on the currency_constant resource as billable_unit_micros.
 * Note: Google's table, not ISO 4217: HUF bills in 0.01 units here, while IDR, PKR,
 * RSD, CLP and COP bill in whole units.
 */
export const CURRENCY_MINIMUM_UNIT_MICROS: Readonly<Record<string, bigint>> = Object.freeze({
  AED: 10_000n,
  ARS: 10_000n,
  AUD: 10_000n,
  BGN: 10_000n,
  BND: 10_000n,
  BOB: 10_000n,
  BRL: 10_000n,
  CAD: 10_000n,
  CHF: 10_000n,
  CLP: 1_000_000n,
  CNY: 10_000n,
  COP: 1_000_000n,
  CSD: 10_000n,
  CZK: 10_000n,
  DEM: 10_000n,
  DKK: 10_000n,
  EEK: 10_000n,
  EGP: 10_000n,
  EUR: 10_000n,
  FJD: 10_000n,
  FRF: 10_000n,
  GBP: 10_000n,
  HKD: 10_000n,
  HRK: 10_000n,
  HUF: 10_000n,
  IDR: 1_000_000n,
  ILS: 10_000n,
  INR: 10_000n,
  JOD: 10_000n,
  JPY: 1_000_000n,
  KES: 10_000n,
  KRW: 1_000_000n,
  LKR: 10_000n,
  LTL: 10_000n,
  MAD: 10_000n,
  MTL: 10_000n,
  MXN: 10_000n,
  MYR: 10_000n,
  NGN: 10_000n,
  NOK: 10_000n,
  NZD: 10_000n,
  PEN: 10_000n,
  PHP: 10_000n,
  PKR: 1_000_000n,
  PLN: 10_000n,
  RON: 10_000n,
  RSD: 1_000_000n,
  RUB: 10_000n,
  SAR: 10_000n,
  SEK: 10_000n,
  SGD: 10_000n,
  SIT: 10_000n,
  SKK: 10_000n,
  THB: 10_000n,
  TND: 10_000n,
  TRL: 1_000_000n,
  TRY: 10_000n,
  TWD: 10_000n,
  UAH: 10_000n,
  USD: 10_000n,
  UYU: 10_000n,
  VEB: 10_000n,
  VEF: 10_000n,
  VND: 1_000_000n,
  ZAR: 10_000n,
});

const INTEGER = /^-?\d+$/;
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Parses a micros value as Google sends it (int64 string). Rejects fractions and unsafe numbers. */
export const parseMicros = (value: string | number | bigint): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`micros must be a safe integer, got ${value}; pass a string instead`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!INTEGER.test(trimmed)) throw new RangeError(`not a micros integer: "${value}"`);
  return BigInt(trimmed);
};

/** 1500000 -> "1.5", 12000000 -> "12". `minFractionDigits` pads, e.g. 2 -> "12.00". */
export const microsToDecimalString = (
  micros: string | number | bigint,
  options: { minFractionDigits?: number } = {},
): string => {
  const value = parseMicros(micros);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / MICROS_PER_UNIT;
  let fraction = (abs % MICROS_PER_UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  const minDigits = Math.min(6, Math.max(0, options.minFractionDigits ?? 0));
  if (fraction.length < minDigits) fraction = fraction.padEnd(minDigits, "0");
  const sign = negative && (whole > 0n || fraction !== "") ? "-" : "";
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
};

/** "12.34" -> 12340000n. No float maths; more than 6 decimals is refused, not rounded. */
export const decimalToMicros = (value: string | number): bigint => {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RangeError(`not a finite amount: ${value}`);
  }
  const text = String(value).trim();
  const match = DECIMAL.exec(text);
  if (!match) throw new RangeError(`not a plain decimal amount: "${text}"`);
  const [, sign, whole = "0", fraction = ""] = match;
  if (fraction.length > 6) throw new RangeError(`more than 6 decimals: "${text}"`);
  const micros = BigInt(whole) * MICROS_PER_UNIT + BigInt(fraction.padEnd(6, "0") || "0");
  return sign === "-" ? -micros : micros;
};

export const minimumUnitMicros = (currencyCode: string): bigint | undefined =>
  CURRENCY_MINIMUM_UNIT_MICROS[currencyCode.toUpperCase()];

/** nearest = half away from zero; down = toward minus infinity; up = toward plus infinity. */
export type RoundingMode = "nearest" | "down" | "up";

/**
 * Rounds micros to a multiple of the currency's minimum billable unit, which Google
 * requires for budgets. Unknown currency codes throw instead of guessing.
 */
export const roundMicrosToCurrency = (
  micros: string | number | bigint,
  currencyCode: string,
  mode: RoundingMode = "nearest",
): bigint => {
  const unit = minimumUnitMicros(currencyCode);
  if (unit === undefined) throw new RangeError(`unknown currency code: "${currencyCode}"`);
  const value = parseMicros(micros);
  const rem = ((value % unit) + unit) % unit; // always 0..unit-1
  if (rem === 0n) return value;
  const floor = value - rem;
  if (mode === "down") return floor;
  if (mode === "up") return floor + unit;
  const twice = rem * 2n;
  if (twice > unit) return floor + unit;
  if (twice < unit) return floor;
  return value < 0n ? floor : floor + unit; // exact half: away from zero
};
