// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Negatives safety (plan 3.3): a negative keyword must never block a search or a keyword
// that brought conversions, and never the account's own brand. Ported from PerfoAds
// negativeSafety (the "never block" gate) and its brand matcher, without private word
// lists, products or AI. Pure: the sources are read by sources.ts.
//
// Matching is on plural-folded, accent-folded words and is stricter than Google on
// purpose (the safe side): EXACT = the same words, PHRASE = the words in a row,
// BROAD = every word anywhere.

export type NegativeMatchType = "EXACT" | "PHRASE" | "BROAD";

export interface NegativeCandidate {
  text: string;
  matchType: NegativeMatchType;
}

/** A search or keyword with conversions in the window (`where` = server text, e.g. a campaign id). */
export interface ConvertingText {
  text: string;
  conversions: number;
  where: string;
}

export interface SafetySources {
  /** Search terms with conversions in the window (Search, Shopping, PMax when readable). */
  convertingTerms: readonly ConvertingText[];
  /** Keywords with conversions in the window (their own search). */
  convertingKeywords: readonly ConvertingText[];
  /** Brand words that are never negated. */
  brandTerms: readonly string[];
}

export type SafetyReason = "brand" | "converted_term" | "converted_keyword";

export interface SafetyHit {
  candidate: NegativeCandidate;
  reason: SafetyReason;
  /** What it would block: a brand term, or a search / keyword text (account data, untrusted). */
  blocks: string;
  /** Conversions in the window (refusal messages only; never stored, it drifts). */
  conversions?: number;
  /** Where (campaign id), server text. */
  where?: string;
  /** Conversion hits: every search / keyword it blocks, "search:<text>" / "keyword:<text>", sorted. */
  allBlocked?: string[];
}

export interface SafetyResult {
  /** Brand hits: never allowed, not even with the override. */
  brand: SafetyHit[];
  /** Conversion hits: refused unless override_blocked_conversions is set. */
  converting: SafetyHit[];
}

/** Letters NFKD leaves whole. */
const EXTRA_FOLDS: Readonly<Record<string, string>> = {
  ł: "l",
  đ: "d",
  ø: "o",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ı: "i",
  þ: "th",
  ð: "d",
  ħ: "h",
};

/** "Śnieżka" -> "sniezka", "Levi's" -> "levis", "+Dr. Malou" -> "dr malou". */
export const foldText = (s: string): string =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[łđøßæœıþðħ]/g, (ch) => EXTRA_FOLDS[ch] ?? ch)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/['’‘`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const stemWord = (w: string): string => {
  if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
};

/** Folded, plural-folded words of a text. */
export const stemsOf = (text: string): string[] =>
  foldText(text).split(" ").filter(Boolean).map(stemWord);

/** Would a negative `cand` block the search `text`? (stricter than Google: the safe side) */
export const negativeBlocks = (cand: NegativeCandidate, text: string): boolean => {
  const c = stemsOf(cand.text);
  const t = stemsOf(text);
  if (c.length === 0 || t.length === 0) return false;
  if (cand.matchType === "EXACT") return c.join(" ") === t.join(" ");
  if (cand.matchType === "PHRASE") return ` ${t.join(" ")} `.includes(` ${c.join(" ")} `);
  const words = new Set(t);
  return c.every((w) => words.has(w));
};

// ---- brand matcher (PerfoAds overlapBrandMatcher, without its private lists) ----

const MIN_BRAND_TOKEN_LENGTH = 3;
const MIN_BRAND_INFLECT_LENGTH = 5;
const MIN_BRAND_TYPO_LENGTH = 7;
/** Generic words that never act as a brand word on their own. */
const BRAND_STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "with",
  "shop",
  "store",
  "ltd",
  "inc",
  "llc",
  "com",
  "online",
  "official",
  "new",
  "gmbh",
  "group",
]);

/** Brand-side folding: "&" is the word "and" on both sides ("H&M" = "h and m"). */
const wordsOf = (s: string): string[] => {
  const f = foldText(String(s ?? "").replace(/&/g, " and "));
  return f ? f.split(" ") : [];
};

/**
 * Can this brand term be matched at all (a letter or digit after folding)? A term like
 * "&&" or "-" can't: the policy check and propose refuse it rather than silently skip it.
 */
export const brandTermMatchable = (term: string): boolean => wordsOf(term).length > 0;

/** Brand words: folded, 3+ letters, generic words dropped (unless keepStopWords). */
export const brandTokensOf = (name: string, keepStopWords = false): string[] => {
  const out: string[] = [];
  for (const w of wordsOf(name)) {
    if (w.length < MIN_BRAND_TOKEN_LENGTH) continue;
    if (!keepStopWords && BRAND_STOP_WORDS.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
};

const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/** Damerau-Levenshtein distance <= 1. */
const withinOneEdit = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const p = commonPrefix(a, b);
  const ra = a.slice(p);
  const rb = b.slice(p);
  if (ra.length === rb.length) {
    if (ra.slice(1) === rb.slice(1)) return true;
    return ra.length >= 2 && ra[0] === rb[1] && ra[1] === rb[0] && ra.slice(2) === rb.slice(2);
  }
  return ra.length > rb.length ? ra.slice(1) === rb : rb.slice(1) === ra;
};

/** One word against one brand stem: equal, an inflected form of a long stem, or one typo. */
const wordMatchesStem = (word: string, stem: string): boolean => {
  if (word === stem) return true;
  // Plurals of any length: "nikes" for "nike", "lgs" for "lg".
  if (word === `${stem}s` || word === `${stem}es`) return true;
  if (stem.length >= MIN_BRAND_INFLECT_LENGTH) {
    const p = commonPrefix(word, stem);
    const tail = word.length - p;
    if (p === stem.length && tail <= 2) return true;
    if (p === stem.length - 1 && /[ao]$/.test(stem) && tail >= 1 && tail <= 2) return true;
  }
  if (stem.length >= MIN_BRAND_TYPO_LENGTH && word.length >= MIN_BRAND_TYPO_LENGTH - 1) {
    return withinOneEdit(word, stem);
  }
  return false;
};

/** The words hold `token` as whole words in a row, or a one-word token written apart. */
const wordsContainToken = (words: readonly string[], token: string): boolean => {
  const tw = wordsOf(token);
  if (tw.length === 0) return false;
  for (let i = 0; i + tw.length <= words.length; i++) {
    let ok = true;
    for (let j = 0; j < tw.length; j++) {
      if (!wordMatchesStem(words[i + j] ?? "", tw[j] ?? "")) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  const single = tw[0] ?? "";
  if (tw.length === 1 && single.length >= MIN_BRAND_INFLECT_LENGTH) {
    for (let i = 0; i < words.length; i++) {
      let joined = words[i] ?? "";
      for (let j = i + 1; j < words.length && joined.length < single.length; j++) {
        joined += words[j] ?? "";
        if (joined === single) return true;
      }
    }
  }
  return false;
};

/** `candidate` names the whole brand (every significant word, or written as one word). */
const brandNameMatches = (candidate: string, brand: string): boolean => {
  const stems = brandTokensOf(brand, true);
  if (stems.length === 0) return false;
  const words = wordsOf(candidate);
  if (words.length === 0) return false;
  if (stems.every((s) => wordsContainToken(words, s))) return true;
  const squashed = wordsOf(brand).join("");
  return (
    squashed.length >= MIN_BRAND_INFLECT_LENGTH &&
    wordsOf(brand).length > 1 &&
    wordsContainToken(words, squashed)
  );
};

/** Letters and digits only, "&" / "and" left out: "H&M" -> "hm", "3 M" -> "3m". */
const squeeze = (words: readonly string[]): string => words.filter((w) => w !== "and").join("");

/**
 * Some run of whole words in `words` squeezes to exactly `brand`: "h m jeans" and "hm" hold
 * H&M ("hm"), "3 m" holds 3M; "hmm", "ham" and "3mm" don't (whole words, exact).
 */
const squeezedRunMatches = (words: readonly string[], brand: string): boolean => {
  if (!brand) return false;
  const tokens = words.filter((w) => w !== "and");
  for (let i = 0; i < tokens.length; i++) {
    let joined = "";
    for (let j = i; j < tokens.length && joined.length < brand.length; j++) {
      joined += tokens[j] ?? "";
      if (joined === brand) return true;
    }
  }
  return false;
};

/**
 * Is `text` the brand? Any one brand word in it is enough (a single brand word as a
 * negative still blocks brand searches). Null when there is no brand word at all.
 */
export const brandMatcher = (
  brands: readonly string[],
): ((text: string) => string | null) | null => {
  const list = [...new Set(brands.map((b) => String(b).trim()).filter(Boolean))];
  const usable = list.filter(brandTermMatchable);
  if (usable.length === 0) return null;
  return (text: string) => {
    const words = wordsOf(text);
    for (const b of usable) {
      // The whole brand written together or apart ("hm", "h m" for H&M; "3 m" for 3M).
      if (squeezedRunMatches(words, squeeze(wordsOf(b)))) return b;
      if (brandTokensOf(b, true).length === 0) {
        // Only short words ("H&M", "3M", "LG", "QX US"): all of them, whole, in a row.
        if (wordsContainToken(words, wordsOf(b).join(" "))) return b;
        continue;
      }
      if (brandNameMatches(text, b)) return b;
      if (brandTokensOf(b).some((t) => wordsContainToken(words, t))) return b;
    }
    return null;
  };
};

/** "12.5 conversions" */
export const conversionsText = (n: number): string => {
  const v = Math.round(n * 10) / 10;
  return `${v} conversion${v === 1 ? "" : "s"}`;
};

/** One plain refusal line per hit (model + Google text quoted as JSON strings). */
export const hitLine = (h: SafetyHit): string => {
  const neg = `${JSON.stringify(h.candidate.text)} (${h.candidate.matchType})`;
  if (h.reason === "brand") return `${neg} names the brand ${JSON.stringify(h.blocks)}`;
  const what = h.reason === "converted_term" ? "the search" : "the keyword";
  return `${neg} would block ${what} ${JSON.stringify(h.blocks)} (${conversionsText(h.conversions ?? 0)}${h.where ? `, ${h.where}` : ""})`;
};

/** Would stems `c` (a negative) block stems `t` (a search)? Same rules as negativeBlocks. */
const stemsBlock = (
  c: readonly string[],
  matchType: NegativeMatchType,
  t: readonly string[],
): boolean => {
  if (c.length === 0 || t.length === 0) return false;
  if (matchType === "EXACT") return c.join(" ") === t.join(" ");
  if (matchType === "PHRASE") return ` ${t.join(" ")} `.includes(` ${c.join(" ")} `);
  const words = new Set(t);
  return c.every((w) => words.has(w));
};

/**
 * Checks every candidate: brand first (never allowed), then searches with conversions,
 * then keywords with conversions. The hit names the first match; `allBlocked` lists every
 * search / keyword a converting candidate blocks ("search:<text>", "keyword:<text>").
 */
export const checkNegatives = (
  candidates: readonly NegativeCandidate[],
  sources: SafetySources,
): SafetyResult => {
  const isBrand = brandMatcher(sources.brandTerms);
  const stem = (list: readonly ConvertingText[], kind: "search" | "keyword") =>
    list.filter((t) => t.conversions > 0).map((t) => ({ ...t, kind, stems: stemsOf(t.text) }));
  const texts = [
    ...stem(sources.convertingTerms, "search"),
    ...stem(sources.convertingKeywords, "keyword"),
  ];
  const result: SafetyResult = { brand: [], converting: [] };
  // A negative must also never block the brand search itself ("qx" PHRASE blocks "qx us").
  const brandStems = sources.brandTerms
    .filter(brandTermMatchable)
    .map((b) => ({ b, stems: wordsOf(b).map(stemWord) }));
  for (const c of candidates) {
    const cBrandStems = wordsOf(c.text).map(stemWord);
    const brand =
      isBrand?.(c.text) ??
      brandStems.find((x) => stemsBlock(cBrandStems, c.matchType, x.stems))?.b ??
      null;
    if (brand) {
      result.brand.push({ candidate: c, reason: "brand", blocks: brand });
      continue;
    }
    const cs = stemsOf(c.text);
    const hits = texts.filter((t) => stemsBlock(cs, c.matchType, t.stems));
    const first = hits[0];
    if (!first) continue;
    result.converting.push({
      candidate: c,
      reason: first.kind === "search" ? "converted_term" : "converted_keyword",
      blocks: first.text,
      conversions: first.conversions,
      where: first.where,
      allBlocked: [...new Set(hits.map((h) => `${h.kind}:${h.text}`))].sort(),
    });
  }
  return result;
};
