// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import {
  decimalToMicros,
  microsToDecimalString,
  minimumUnitMicros,
  parseMicros,
  roundMicrosToCurrency,
} from "./money.js";

describe("parseMicros", () => {
  it("parses Google's int64 strings beyond the JS safe-integer limit exactly", () => {
    expect(parseMicros("9007199254740993")).toBe(9007199254740993n);
    expect(parseMicros(" -1500000 ")).toBe(-1500000n);
    expect(parseMicros(42)).toBe(42n);
  });

  it("refuses fractions, junk and unsafe numbers", () => {
    expect(() => parseMicros("1.5")).toThrow(RangeError);
    expect(() => parseMicros("1e6")).toThrow(RangeError);
    expect(() => parseMicros("")).toThrow(RangeError);
    expect(() => parseMicros(1.5)).toThrow(RangeError);
    expect(() => parseMicros(2 ** 60)).toThrow(/pass a string/);
  });
});

describe("microsToDecimalString", () => {
  it("converts without float error", () => {
    expect(microsToDecimalString("1500000")).toBe("1.5");
    expect(microsToDecimalString(12_000_000n)).toBe("12");
    expect(microsToDecimalString("100000")).toBe("0.1");
    expect(microsToDecimalString("1")).toBe("0.000001");
    expect(microsToDecimalString("-500000")).toBe("-0.5");
    expect(microsToDecimalString("0")).toBe("0");
    expect(microsToDecimalString("12000000", { minFractionDigits: 2 })).toBe("12.00");
  });

  it("keeps large IDR and VND amounts exact", () => {
    // 75,000,000,000 IDR = 7.5e16 micros, far above 2^53.
    expect(microsToDecimalString("75000000000000001")).toBe("75000000000.000001");
    expect(microsToDecimalString("123456789012000000")).toBe("123456789012");
  });
});

describe("decimalToMicros", () => {
  it("converts strings and numbers without floats", () => {
    expect(decimalToMicros("12.34")).toBe(12_340_000n);
    expect(decimalToMicros(0.1)).toBe(100_000n);
    expect(decimalToMicros("-0.5")).toBe(-500_000n);
    expect(decimalToMicros("75000000000")).toBe(75_000_000_000_000_000n);
  });

  it("refuses more than 6 decimals, exponents and junk instead of rounding", () => {
    expect(() => decimalToMicros("1.0000001")).toThrow(RangeError);
    expect(() => decimalToMicros(1e21)).toThrow(RangeError);
    expect(() => decimalToMicros("12,50")).toThrow(RangeError);
    expect(() => decimalToMicros(Number.NaN)).toThrow(RangeError);
  });
});

describe("roundMicrosToCurrency", () => {
  it("rounds USD to whole cents", () => {
    expect(roundMicrosToCurrency("12345678", "USD")).toBe(12_350_000n);
    expect(roundMicrosToCurrency("12345678", "usd", "down")).toBe(12_340_000n);
    expect(roundMicrosToCurrency("12340001", "USD", "up")).toBe(12_350_000n);
    expect(roundMicrosToCurrency("12345000", "USD")).toBe(12_350_000n); // exact half: away from zero
    expect(roundMicrosToCurrency("12340000", "USD", "up")).toBe(12_340_000n); // already a multiple
  });

  it("rounds JPY and KRW to whole units", () => {
    expect(minimumUnitMicros("JPY")).toBe(1_000_000n);
    expect(roundMicrosToCurrency("1499999", "JPY")).toBe(1_000_000n);
    expect(roundMicrosToCurrency("1500000", "JPY")).toBe(2_000_000n);
    expect(roundMicrosToCurrency("1500000", "KRW", "down")).toBe(1_000_000n);
  });

  it("rounds IDR and VND above 2^53 micros exactly", () => {
    expect(roundMicrosToCurrency("50000000000500000", "IDR")).toBe(50_000_000_001_000_000n);
    expect(roundMicrosToCurrency("50000000000499999", "IDR")).toBe(50_000_000_000_000_000n);
    expect(roundMicrosToCurrency(9_007_199_254_740_993n, "VND", "down")).toBe(
      9_007_199_254_000_000n,
    );
  });

  it("follows Google's table, not ISO 4217, for HUF", () => {
    expect(minimumUnitMicros("HUF")).toBe(10_000n);
  });

  it("handles negative amounts (deltas)", () => {
    expect(roundMicrosToCurrency("-12345000", "USD")).toBe(-12_350_000n);
    expect(roundMicrosToCurrency("-12341000", "USD", "down")).toBe(-12_350_000n);
    expect(roundMicrosToCurrency("-12349000", "USD", "up")).toBe(-12_340_000n);
  });

  it("refuses unknown currency codes instead of guessing", () => {
    expect(() => roundMicrosToCurrency("1000000", "XXX")).toThrow(/unknown currency/);
  });
});
