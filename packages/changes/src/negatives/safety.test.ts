// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { brandMatcher, checkNegatives, negativeBlocks, stemsOf } from "./safety.js";

const none = { convertingTerms: [], convertingKeywords: [], brandTerms: [] };

describe("negativeBlocks (stricter than Google: the safe side)", () => {
  it("EXACT = the same words, plurals and accents folded", () => {
    expect(negativeBlocks({ text: "red shoe", matchType: "EXACT" }, "Red Shoes")).toBe(true);
    expect(negativeBlocks({ text: "creme", matchType: "EXACT" }, "crème")).toBe(true);
    expect(negativeBlocks({ text: "red shoe", matchType: "EXACT" }, "red shoes sale")).toBe(false);
  });
  it("PHRASE = the words in a row", () => {
    expect(
      negativeBlocks({ text: "free shipping", matchType: "PHRASE" }, "shoes free shipping uk"),
    ).toBe(true);
    expect(negativeBlocks({ text: "free shipping", matchType: "PHRASE" }, "shipping free")).toBe(
      false,
    );
  });
  it("BROAD = every word anywhere", () => {
    expect(
      negativeBlocks({ text: "shipping free", matchType: "BROAD" }, "free fast shipping"),
    ).toBe(true);
    expect(negativeBlocks({ text: "cheap", matchType: "BROAD" }, "cheaper shoes")).toBe(false);
  });
  it("folds plurals the same way on both sides", () => {
    expect(stemsOf("Dresses and Mugs")).toEqual(["dress", "and", "mug"]);
  });
});

describe("checkNegatives", () => {
  it("refuses a negative that blocks a search with conversions, naming it", () => {
    const r = checkNegatives([{ text: "running", matchType: "BROAD" }], {
      ...none,
      convertingTerms: [{ text: "running shoes men", conversions: 3, where: "campaign 333" }],
    });
    expect(r.converting).toHaveLength(1);
    expect(r.converting[0]).toMatchObject({
      reason: "converted_term",
      blocks: "running shoes men",
    });
  });

  it("ignores searches without conversions", () => {
    const r = checkNegatives([{ text: "running", matchType: "BROAD" }], {
      ...none,
      convertingTerms: [{ text: "running shoes", conversions: 0, where: "campaign 333" }],
    });
    expect(r.converting).toHaveLength(0);
  });

  it("refuses a negative that blocks a keyword with conversions", () => {
    const r = checkNegatives([{ text: "trail", matchType: "PHRASE" }], {
      ...none,
      convertingKeywords: [{ text: "trail running shoes", conversions: 1, where: "campaign 333" }],
    });
    expect(r.converting[0]?.reason).toBe("converted_keyword");
  });

  it("brand first: a brand word is a brand hit even when it also converted", () => {
    const r = checkNegatives([{ text: "acme outlet", matchType: "PHRASE" }], {
      convertingTerms: [{ text: "acme outlet", conversions: 9, where: "campaign 1" }],
      convertingKeywords: [],
      brandTerms: ["Acme"],
    });
    expect(r.brand).toHaveLength(1);
    expect(r.converting).toHaveLength(0);
  });
});

describe("brandMatcher (ported, no private lists)", () => {
  const is = brandMatcher(["Northwind Traders", "Zephyrine"]);
  it("any one brand word is enough, generic words are not", () => {
    expect(is?.("northwind sale")).toBe("Northwind Traders");
    expect(is?.("traders")).toBe("Northwind Traders");
    expect(is?.("shop online")).toBeNull();
  });
  it("inflected forms, one typo in long words, the name written together", () => {
    expect(is?.("zephyrines")).toBe("Zephyrine");
    expect(is?.("zephyrlne")).toBe("Zephyrine");
    expect(is?.("northwindtraders")).toBe("Northwind Traders");
  });
  it("no usable brand word -> no matcher", () => {
    expect(brandMatcher(["", "  ", "-", "!!"])).toBeNull();
  });
  it("short brands written together or apart: H&M as hm / h m, 3M as 3 m", () => {
    const short = brandMatcher(["H&M", "3M"]);
    for (const t of ["hm", "h m", "hm jeans", "h m jeans", "h&m", "h and m", "cheap h & m"])
      expect(short?.(t), t).toBe("H&M");
    for (const t of ["3m", "3 m", "3 m tape", "tape 3m"]) expect(short?.(t), t).toBe("3M");
  });
  it("squeezed matching is exact and whole-word: no hmm, ham, 3mm", () => {
    const short = brandMatcher(["H&M", "3M"]);
    for (const t of ["hmm", "ham", "3mm", "hmm jeans", "h mm", "3 mm", "ohm", "h", "m"])
      expect(short?.(t), t).toBeNull();
  });
  it("a multi-word brand written as one run, with or without 'and'", () => {
    const ms = brandMatcher(["Marks & Spencer"]);
    expect(ms?.("marks spencer")).toBe("Marks & Spencer");
    expect(ms?.("marksspencer jumper")).toBe("Marks & Spencer");
  });
});
