// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Brand classification: "is this a brand campaign?" (by name) and "does this
 * text name the brand?" (by the brand terms the caller supplied).
 */

/**
 * Brand NAME tokens a campaign name is matched on (English + Polish). "non-brand"
 * and similar names win over every token (`NON_BRAND_NAME_RE`).
 */
export const BRAND_NAME_TOKENS: readonly string[] = [
  "brand",
  "branded",
  "marka",
  "marki",
  "markowy",
  "firmowy",
  "firmowa",
  "trademark",
];

/**
 * True when the campaign name says it is a brand campaign, or the name is in
 * the caller's explicit brand-campaign set.
 */
export function isBrandCampaign(name: string, manualTags?: ReadonlySet<string>): boolean {
  if (!name) return false;
  if (manualTags && manualTags.has(name)) return true;
  return matchesBrandNameToken(name);
}

/** The name heuristic alone. "Non-Brand" / "nonbrand" / "brand exclusions" never match. */
export function matchesBrandNameToken(name: string): boolean {
  if (!name) return false;
  const lower = foldBrandText(name);
  if (NON_BRAND_NAME_RE.test(lower)) return false;
  const words = brandNameWordsOf(name);
  return words.some((w) =>
    BRAND_NAME_TOKENS.some((t) => w === t || (w.startsWith(t) && /^\d+$/.test(w.slice(t.length)))),
  );
}

/**
 * The name rule reads WHOLE words (app twin, 7 Nov): "Rebrand Spring" and
 * "Brand New Arrivals" are not brand campaigns. camelCase is split first
 * ("BrandSearch" = "brand search"), a token may carry a number ("Brand2025"),
 * and the English phrase "brand new" (only spaces between) is not the brand
 * word; "Brand - New customers" still is.
 */
export function brandNameWordsOf(name: string): string[] {
  const split = String(name ?? "")
    .normalize("NFKC")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/\bbrand[ \t]+(?=new\b)/giu, " ");
  const folded = foldBrandText(split);
  return folded ? folded.split(" ") : [];
}

/**
 * Names that win over every brand token (read on the FOLDED name, where "_"
 * and "-" are spaces): "Non-Brand", "nonbrand", Polish "niemarkowe", brand
 * EXCLUSION campaigns ("Prospecting - Brand exclusions"), and "generic" /
 * "prospecting". Word boundaries keep "Canon Brand" and "Shannon - Brand" out.
 */
const NON_BRAND_NAME_RE =
  /\bnon ?brand|\bnie ?mark|\bbrand ?excl|\bexcl\w* brand|\bgeneric\b|\bprospecting\b/;

// --- Brand TERM matching (search terms, keywords, negatives, themes) ------
//
// Rules:
//   - both sides are folded the same way: lower-case (locale-independent),
//     NFKD, combining marks stripped, letters NFKD does not decompose mapped
//     (ł -> l, ø -> o, ß -> ss ...), apostrophes dropped, everything that is not
//     a Unicode letter/digit becomes a space;
//   - a brand token matches WHOLE words only, never a substring of a word;
//   - two narrow allowances, both needing a long stem: an inflected ending
//     ("Krosna" for "Krosno") and one typo in a long word;
//   - a brand written as one word matches ("acmeoutdoor" for "Acme Outdoor").

/** Words shorter than this never become a brand token. */
export const MIN_BRAND_TOKEN_LENGTH = 3;
/** Inflected endings are only accepted for stems at least this long. */
export const MIN_BRAND_INFLECT_LENGTH = 5;
/** One typo is only accepted for stems at least this long. */
export const MIN_BRAND_TYPO_LENGTH = 7;

/** Generic words in a business name that must never act as a brand token alone. */
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
  "sklep",
  "spolka",
  "gmbh",
  "group",
]);

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

/** Fold text for brand matching. "Śnieżka" -> "sniezka", "Levi's" -> "levis". */
export function foldBrandText(s: string): string {
  // NFKC before lower case: decorative capitals only become plain letters after it.
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[łđøßæœıþðħ]/g, (ch) => EXTRA_FOLDS[ch] ?? ch)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/['’‘`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function wordsOf(s: string): string[] {
  const f = foldBrandText(s);
  return f ? f.split(" ") : [];
}

/**
 * Brand tokens from a brand name: folded words of 3+ characters, generic words
 * dropped unless `keepStopWords`, de-duplicated.
 */
export function brandTokensOf(name: string, opts: { keepStopWords?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const w of wordsOf(name)) {
    if (w.length < MIN_BRAND_TOKEN_LENGTH) continue;
    if (!opts.keepStopWords && BRAND_STOP_WORDS.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Damerau-Levenshtein distance <= 1 (one insert, delete, substitute or swap). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const p = commonPrefix(a, b);
  const ra = a.slice(p);
  const rb = b.slice(p);
  if (ra.length === rb.length) {
    if (ra.slice(1) === rb.slice(1)) return true; // substitute
    return ra.length >= 2 && ra[0] === rb[1] && ra[1] === rb[0] && ra.slice(2) === rb.slice(2); // swap
  }
  return ra.length > rb.length ? ra.slice(1) === rb : rb.slice(1) === ra; // insert / delete
}

/**
 * One folded word against one folded brand stem. Equal; or an inflected form
 * of a long stem: the whole stem plus at most 2 letters, or (only when the stem
 * ends in -a / -o, noun endings that inflect) the last letter changed plus at
 * most 2 letters; or one typo in a long word. "canoe" is not "Canon".
 */
function wordMatchesStem(word: string, stem: string): boolean {
  if (word === stem) return true;
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
}

/**
 * True when the folded words contain `token` (one or more folded words) as a
 * consecutive run of whole words, or (for a one-word token) as a run of the
 * text's words written together.
 */
function wordsContainToken(words: readonly string[], token: string): boolean {
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
        joined += words[j];
        if (joined === single) return true;
      }
    }
  }
  return false;
}

/** The brand tokens `text` contains, in token order. */
export function brandTokensInText(
  text: string | null | undefined,
  tokens: readonly string[],
): string[] {
  if (!text || tokens.length === 0) return [];
  const words = wordsOf(text);
  if (words.length === 0) return [];
  return tokens.filter((t) => wordsContainToken(words, t));
}

/** True when `text` contains ANY of the brand tokens. */
export function textHasBrandToken(
  text: string | null | undefined,
  tokens: readonly string[],
): boolean {
  return brandTokensInText(text, tokens).length > 0;
}

/**
 * True when `candidate` names the whole brand: every significant stem of
 * `brand` (3+ letters, stop words kept) appears as a word, or the brand is
 * written as one word. False when the brand has no significant stem.
 */
export function brandNameMatches(candidate: string, brand: string): boolean {
  const stems = brandTokensOf(brand, { keepStopWords: true });
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
}

/**
 * Legal-form and filler words a business name carries that shoppers never type
 * ("Acme Inc", "The Body Shop Ltd"). Dropped before `brandNameMatches` is asked,
 * because it requires EVERY word of the name it is given.
 */
const BRAND_NAME_FILLERS: ReadonlySet<string> = new Set([
  "the",
  "ltd",
  "inc",
  "llc",
  "gmbh",
  "corp",
  "company",
  "limited",
  "spolka",
  "com",
  "official",
  "online",
  "group",
]);

/**
 * "Is this text a brand search / theme / keyword?" for ONE brand name: the
 * whole name must appear (every significant word, accent-folded, with the
 * inflection / one-word / one-typo allowances). "acme leather boots" is not a
 * brand search for "Acme Outdoor". null when the name has no 3+ letter word.
 */
export function brandNameMatcher(businessName: unknown): ((text: string) => boolean) | null {
  const words = brandTokensOf(String(businessName ?? ""), { keepStopWords: true }).filter(
    (w) => !BRAND_NAME_FILLERS.has(w),
  );
  if (words.length === 0) return null;
  const brand = words.join(" ");
  return (text: string) => brandNameMatches(text, brand);
}

/**
 * The same answer for a LIST of brand names: a text is a brand text when it
 * names any one of them. null when no name yields a usable matcher.
 */
export function brandTermsMatcher(
  terms: readonly string[] | null | undefined,
): ((text: string) => boolean) | null {
  const matchers = (terms ?? [])
    .map((t) => brandNameMatcher(t))
    .filter((m): m is (text: string) => boolean => m != null);
  if (matchers.length === 0) return null;
  return (text: string) => matchers.some((m) => m(text));
}

/** Brand tokens from a list of brand names (each one through `brandTokensOf`), de-duplicated. */
export function brandTokensOfTerms(terms: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const t of terms ?? []) for (const w of brandTokensOf(t)) if (!out.includes(w)) out.push(w);
  return out;
}

/**
 * Research-stage words, folded like the brand matcher (lower case, accents
 * stripped). Comparison = the shopper is choosing; informational = the shopper
 * is learning. English plus a few Dutch and Polish words. "top" is left out on
 * purpose: "crop top" is a product.
 */
const RESEARCH_COMPARISON_PHRASES: readonly string[] = [
  "best",
  "vs",
  "versus",
  "compare",
  "comparison",
  "review",
  "reviews",
  "alternative",
  "alternatives",
  "rated",
  "beste",
  "vergelijk",
  "vergelijken",
  "najlepszy",
  "najlepsza",
  "najlepsze",
  "ranking",
  "opinie",
  "porownanie",
];
const RESEARCH_INFO_PHRASES: readonly string[] = [
  "how to",
  "how do",
  "how does",
  "how can",
  "what is",
  "what are",
  "why",
  "guide",
  "tips for",
  "tips on",
  "gift ideas for",
  "ideas for",
  "benefits of",
  "difference between",
  "meaning",
  "hoe kies",
  "hoe werkt",
  "wat is",
  "waarom",
  "welke",
  "jak",
  "co to",
  "dlaczego",
  "poradnik",
];

/** 'comparison' | 'informational' | null for a search or keyword text (whole words only). */
export function researchIntentOf(text: string): "comparison" | "informational" | null {
  const padded = ` ${foldBrandText(text)} `;
  if (RESEARCH_COMPARISON_PHRASES.some((p) => padded.includes(` ${p} `))) return "comparison";
  if (RESEARCH_INFO_PHRASES.some((p) => padded.includes(` ${p} `))) return "informational";
  return null;
}

/**
 * SK07 (R4-E review): the brand written short — every brand word has a search word of 2+
 * letters that starts with the same letter and whose letters appear in order inside it
 * ("acm" → acme, "wdg" → widgets). "acme tools" is not: no word stands for widgets.
 */
export function isBrandShorthand(term: string, brandTokens: readonly string[]): boolean {
  if (brandTokens.length < 2) return false;
  const words = foldBrandText(term).split(" ").filter(Boolean);
  const inOrder = (w: string, tok: string): boolean => {
    let i = 0;
    for (const ch of tok) if (ch === w[i]) i++;
    return i === w.length;
  };
  const used = new Set<number>();
  return brandTokens.every((tok) => {
    const i = words.findIndex(
      (w, k) =>
        !used.has(k) &&
        w.length >= 2 &&
        w.length < tok.length &&
        w[0] === tok[0] &&
        inOrder(w, tok),
    );
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}

/**
 * A campaign bidding on competitor brand names, by its name ("Competitor",
 * "Conquest", Polish "konkurencja", Dutch "concurrent"). Its searches are
 * competitor searches: allowed tests, never a word to block.
 */
const COMPETITOR_CAMPAIGN_RE = /\bcompetitors?\b|\bconquest\w*|\bkonkurenc\w*|\bconcurrent\w*/;
export function isCompetitorCampaign(name: string | null | undefined): boolean {
  return !!name && COMPETITOR_CAMPAIGN_RE.test(foldBrandText(name));
}
