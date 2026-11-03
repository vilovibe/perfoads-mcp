// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export interface ProductAttrs {
  /** products.product_id lowercased. */
  productId: string;
  /** last '_' segment of the id, lowercased — Shopify MC ids are shopify_<cc>_<productId>_<variantId>; listing groups and cart rows carry the variant id. */
  itemIdSuffix: string;
  title: string | null;
  brand: string | null;
  productType: string | null;
  googleProductCategory: string | null;
  mcStatus: string | null;
  mcItemIssues: unknown;
  customLabels: (string | null)[];
  /** whether the product list (feed) has a row for it; false = labels and brand are blank, not read. */
  inFeed?: boolean | undefined;
  gtin: string | null;
  color: string | null;
  /** Merchant Center item_group_id when a source carries it; null / absent = unknown. */
  itemGroupId?: string | null | undefined;
  size: string | null;
  missingAttrs: string[];
  promotionIds: unknown;
  promotionAttached: boolean;
  titleLength: number | null;
  /** shopping_products row joined on lowercased item id. */
  shopping: {
    status: string | null;
    issues: unknown;
    channel: string | null;
    clicks: number | null;
    impressions: number | null;
    conv: number | null;
    value: number | null;
  } | null;
  /**
   * mc_price_insights row joined on lowercased product id: only the current price is kept
   * (Google's suggested price is not part of this product).
   */
  priceInsight: {
    current: number | null;
  } | null;
  /** shopping_cart_data row joined on lowercased item id (full id or bare variant id). */
  cart: {
    unitsSold: number | null;
    orders: number | null;
    revenue: number | null;
    avgCartSize: number | null;
  } | null;
  /** asset group ids whose included listing groups resolve to this product (G.5). */
  assetGroupsIncludingMe: string[];
  /** campaign ids that can buy this product (PMax via listing groups, Shopping via feed label). */
  pmaxCampaignIds: string[];
  shoppingCampaignIds: string[];
  /** product_search_terms — null when the table is empty/unsynced, never []. */
  searchTerms: null | { term: string; cost: number | null; conv: number | null }[];
  /**
   * product-level spend on the node is account-wide (products). R3.4a:
   * the per-PMax-campaign split, when pmax_campaign_products was
   * synced and a row joins this product; 'not_synced' otherwise.
   */
  productPerfPerCampaign:
    | "not_synced"
    | {
        campaignId: string;
        cost: number;
        conv: number;
        value: number;
        /** impressions over the window; optional for hand-built models */
        impressions?: number;
        /** PX15 cover: impressions in the last 7 days of the window; null / absent = not read */
        impressions7d?: number | null;
      }[];
  /** 'products' when the row came from the products slice; 'shoppingProductsData' when only shopping_products knew it. */
  primarySource: "products" | "shoppingProductsData";
  /**
   * Every feed the item sits in: one entry per (Merchant Center account, channel,
   * language, feed label) row read for this item id. An item sold in a US and a CA
   * feed is ONE product node (listing groups and reports key on the item id) whose
   * spend, clicks and conversions are the sum of its rows, with both feeds kept here:
   * each feed's own status (an item can show in one feed and not in another) and
   * label. undefined = no row carried feed columns (a Shopping campaign's feed label
   * cannot be matched). Optional for hand-built models.
   */
  feeds?: ProductFeed[] | undefined;
}

/** One feed row of an item (Google Ads' product list). */
export interface ProductFeed {
  merchantId: string | null;
  channel: string | null;
  language: string | null;
  /** null = the row carries no feed label read */
  feedLabel: string | null;
  /** Google Ads' status of the item in this feed (ELIGIBLE, NOT_ELIGIBLE ...); null = not read */
  status: string | null;
  /** IN_STOCK, OUT_OF_STOCK ...; null / absent = not read */
  availability?: string | null | undefined;
  /**
   * The codes of Google's issues that stop the item showing in this feed
   * (not_eligible_out_of_stock, not_eligible_in_any_campaign, a feed problem's code ...);
   * [] = none; null / absent = not read.
   */
  issueCodes?: string[] | null | undefined;
}

export interface ProductNode extends BaseNode<"product"> {
  attrs: ProductAttrs;
}

/**
 * Round 4 item 4: a product row with no Merchant Center match. The ids are joined
 * case-insensitively (sync + model), so this usually means the item was
 * outside the Merchant Center read (the feed crawl is capped), not that its feed
 * fields are empty. Feed checks never judge its labels / attributes / title shape.
 */
export function outsideMerchantCenterRead(p: { attrs: { mcStatus: string | null } }): boolean {
  return p.attrs.mcStatus == null;
}

/** Round 4 item 4/8: the plain limit a feed check carries when it judged only part of the products. */
export function merchantCenterLimit(unseen: number, total: number, what: string): string[] {
  return unseen > 0
    ? [
        `${unseen} of the ${total} products were outside our Merchant Center read, so their ${what} were not seen and are not counted here.`,
      ]
    : [];
}

/**
 * (port of the PerfoAds app): the ONE set of patterns the product key is built from
 * (parentProductKey / normaliseColour / modelColourKey(s)). Ids are matched lower-cased for
 * the Shopify pattern; the copy pattern runs on the trimmed id as is.
 */
export const PRODUCT_KEY_PATTERNS = {
  /** Shopify item ids: shopify_<country>_<productId>_<variantId>[-suffix]; group 1 = the parent product. */
  shopifyItemId: "^shopify_[a-z]{2,3}_(\\d+)_\\d+",
  /** a brand feed copy row ("-cp-<label>") of an original offer */
  copyId: "-cp-[a-z0-9-]+$",
  /** characters folded to one space in a colour ("Dark/Brown", "Dark-Brown"); '-' last, so it is literal in a class */
  colourFoldChars: "/-",
  whitespace: "\\s+",
} as const;
const SHOPIFY_ITEM_ID = new RegExp(PRODUCT_KEY_PATTERNS.shopifyItemId, "i");
const COPY_ID = new RegExp(PRODUCT_KEY_PATTERNS.copyId);
const COLOUR_FOLD = new RegExp(`[${PRODUCT_KEY_PATTERNS.colourFoldChars}]+`, "g");
const WHITESPACE = new RegExp(PRODUCT_KEY_PATTERNS.whitespace, "g");

/**
 * Round 4 item 6: the parent product an item id belongs to. A shop sells one product in
 * ~14 sizes and Google reports each size as its own item; judging one size alone says
 * "exclude XL" for a best seller. Shopify ids carry the parent product id; any other id
 * is its own parent, so nothing is merged by guesswork (modelColourKey also uses the
 * item_group_id and the colour when they are known).
 */
export function parentProductKey(id: string): string {
  const clean = String(id ?? "").trim();
  const m = SHOPIFY_ITEM_ID.exec(clean);
  return m ? `shopify:${m[1]}` : clean.toLowerCase();
}

/** Round 4 R17: the variant id a Shopify item id carries (its page's `?variant=`), or null. */
export function shopifyVariantId(id: string): string | null {
  return /^shopify_[a-z]{2,3}_\d+_(\d+)/i.exec(String(id ?? "").trim())?.[1] ?? null;
}

export interface VariantGroup<T> {
  key: string;
  /** biggest spender first */
  members: T[];
  cost: number;
  conv: number;
  value: number;
}

/** the original offer id a brand feed copy row ("-cp-<label>") copies; null for any other id. Pure. */
export function copyOfId(id: string): string | null {
  const clean = String(id ?? "").trim();
  if (!COPY_ID.test(clean)) return null;
  return clean.replace(COPY_ID, "") || null;
}

/** colour spellings folded: lowercase, trimmed, "/" and "-" and runs of spaces to one space. */
export function normaliseColour(colour: string | null | undefined): string {
  return String(colour ?? "")
    .toLowerCase()
    .replace(COLOUR_FOLD, " ")
    .replace(WHITESPACE, " ")
    .trim();
}

export type KeyItem = { id: string; itemGroupId?: string | null; color?: string | null };

/** model part of the key (item_group_id, else the parent product from the id); null for a brand feed copy. */
function modelOf(item: KeyItem): string | null {
  const id = String(item.id ?? "").trim();
  if (copyOfId(id) != null) return null;
  const group = String(item.itemGroupId ?? "")
    .trim()
    .toLowerCase();
  const parent = parentProductKey(id);
  // a Shopify item_group_id is the parent product id: same key as an id-only row of that product
  return !group || parent === `shopify:${group}` ? parent : `group:${group}`;
}

/**
 * the key a product is judged under = its model (item_group_id, else the parent product
 * from the id) plus its colour. Sizes of one colour sum together; another colour of the same
 * model is its own product (a camel jacket spent with no sale while the blue one sold: one parent
 * key hid the waste). No colour = the model key only. A brand feed copy ("-cp-<label>") keeps
 * its own id as key: it is judged in its own campaign, never summed into the original. One
 * item on its own; for a set of sizes use modelColourKeys. Pure.
 */
export function modelColourKey(item: KeyItem): string {
  const model = modelOf(item);
  if (model == null)
    return `copy:${String(item.id ?? "")
      .trim()
      .toLowerCase()}`;
  const colour = normaliseColour(item.color);
  return colour ? `${model}|${colour}` : model;
}

/**
 * modelColourKey over a set of rows, with the mixed-sizes rule: when a model has exactly
 * ONE colour among its sizes, its colourless sizes join that colour; with 2+ colours they stay
 * their own group (model key only). Copies never count toward a model's colours. Keys in input
 * order. Pure.
 */
export function modelColourKeys(items: readonly KeyItem[]): string[] {
  const models = items.map(modelOf);
  const colours = items.map((it) => normaliseColour(it.color));
  const seen = new Map<string, Set<string>>();
  models.forEach((m, k) => {
    if (m != null && colours[k]) (seen.get(m) ?? seen.set(m, new Set()).get(m)!).add(colours[k]);
  });
  return items.map((it, k) => {
    const m = models[k];
    if (m == null) return modelColourKey(it);
    const only = seen.get(m);
    const colour = colours[k] || (only && only.size === 1 ? [...only][0]! : "");
    return colour ? `${m}|${colour}` : m;
  });
}

/** One size token: letter sizes (XS ... 5XL, "L/XL"), with an optional "-100"; or a number ("85", "36.5", "100cm"). */
/** Separators before a size: spaces, commas, slashes, bars, brackets, hyphen, en and em dash. */
const SEP = "[\\s,/|(\\-–—]";
/** A letter size: XS ... XXXXL, 2XL-6XL, Small / Medium / Large, X-Small / XX-Large, One Size. */
const LETTER = "(?:x{0,4}s|m|x{0,4}l|[2-6]xl|(?:x{1,3}-?)?(?:small|large)|medium|one size|os)";
/** One trailing size token: a letter size ("L/XL", "XL-105"), a number with an optional unit before or after ("85", "EU 85", "34 inch", "100cm"), or a waist/length pair ("W28 L32"). */
const SIZE_TOKEN = new RegExp(
  `(?:^|${SEP}+)(?:${LETTER}(?:\\s*\\/\\s*${LETTER})?(?:\\s*-\\s*\\d+(?:\\.\\d+)?)?` +
    `|(?:(?:eu|us|uk|it|fr)\\s*)?\\d+(?:\\.\\d+)?\\s*(?:cm|mm|in|inch|inches|"|eu|us|uk)?` +
    `|w\\s*\\d+\\s*l\\s*\\d+)\\)?\\s*$`,
  "i",
);
/** A trailing size label: "| Size M", "- Size: 85", "Size XL". */
const SIZE_LABEL = new RegExp(`\\s*${SEP}?\\s*size\\s*:?\\s*[^|]*$`, "i");
const TRAILING_SEP = new RegExp(`${SEP}+$`);

/**
 * a product title with its size part removed, lower-cased and spaces folded ("... Light
 * Camel Demo Brand XS" -> "... light camel demo brand"; "Twin Black L/XL-100"
 * -> "twin black"). Trailing size tokens are stripped one by one; a title with no size stays
 * itself. Pure.
 */
export function sizeStrippedTitle(title: string | null | undefined): string {
  let t = String(title ?? "")
    .replace(WHITESPACE, " ")
    .trim()
    .replace(SIZE_LABEL, "")
    .trim();
  for (let i = 0; i < 4; i++) {
    const next = t.replace(SIZE_TOKEN, "").trim();
    if (next === t || next === "") break;
    t = next;
  }
  return t.replace(TRAILING_SEP, "").toLowerCase();
}

/**
 * the stripped titles of one model may split it into colours only when they read as one
 * title with a colour slot: the same number of words, and every title differs from the others
 * in exactly one run of at most 3 words, all letters (the colour), with more shared words than
 * slot words. Anything else (a size word we did not
 * strip, a renamed product) keeps the model whole: a wrong split is worse than a hidden colour.
 * Pure.
 */
export function titlesSplitByColour(titles: readonly string[]): boolean {
  const distinct = [...new Set(titles)];
  if (distinct.length < 2) return false;
  const words = distinct.map((t) => t.split(" "));
  const n = words[0]!.length;
  if (words.some((w) => w.length !== n)) return false;
  let pre = 0;
  while (pre < n && words.every((w) => w[pre] === words[0]![pre])) pre++;
  let suf = 0;
  while (suf < n - pre && words.every((w) => w[n - 1 - suf] === words[0]![n - 1 - suf])) suf++;
  // the colour slot is short (at most 3 words) and the shared words outnumber it
  const slot = n - pre - suf;
  if (slot < 1 || slot > 3 || pre + suf < slot) return false;
  return words.every((w) => w.slice(pre, n - suf).every((x) => /^[a-zÀ-ɏ'-]+$/.test(x)));
}

/**
 * Colour fallback (no Merchant Center colour): a model whose size-stripped titles pass
 * titlesSplitByColour is split by those titles (one title = one colour); otherwise it stays one
 * group, as before. Merchant Center colour wins: a model with any colour known keeps the
 * colours only. Returns the key items for groupByModelColour and which rows took their colour
 * from the title. Pure.
 */
export function colourKeyItems<T>(
  rows: readonly T[],
  of: (t: T) => {
    id: string;
    itemGroupId?: string | null;
    color?: string | null;
    title?: string | null;
  },
): { items: KeyItem[]; fromTitle: boolean[] } {
  const base = rows.map(of);
  const modelOfRow = base.map((b) =>
    modelColourKey({ id: b.id, itemGroupId: b.itemGroupId ?? null }),
  );
  const stripped = base.map((b) => sizeStrippedTitle(b.title));
  const modelHasColour = new Set<string>();
  const titlesOf = new Map<string, string[]>();
  base.forEach((b, k) => {
    const model = modelOfRow[k]!;
    if (normaliseColour(b.color)) modelHasColour.add(model);
    if (stripped[k])
      (titlesOf.get(model) ?? titlesOf.set(model, []).get(model)!).push(stripped[k]!);
  });
  const splits = new Set([...titlesOf].filter(([, t]) => titlesSplitByColour(t)).map(([m]) => m));
  const fromTitle: boolean[] = [];
  const items = base.map((b, k) => {
    const model = modelOfRow[k]!;
    const useTitle =
      !normaliseColour(b.color) &&
      !model.startsWith("copy:") &&
      !modelHasColour.has(model) &&
      splits.has(model) &&
      stripped[k] !== "";
    fromTitle.push(useTitle);
    return {
      id: b.id,
      itemGroupId: b.itemGroupId ?? null,
      color: useTitle ? `title:${stripped[k]}` : (b.color ?? null),
    };
  });
  return { items, fromTitle };
}

/** Round 4 item 6: sum sizes / colours up to their parent product. */
export function groupByParentProduct<T>(
  items: readonly T[],
  idOf: (t: T) => string,
  metricsOf: (t: T) => { cost: number; conv: number; value: number },
): VariantGroup<T>[] {
  return sumByKey(
    items,
    items.map((t) => parentProductKey(idOf(t))),
    metricsOf,
  );
}

/**
 * sum sizes up to their model + colour (modelColourKeys over the set, so the mixed-sizes
 * rule holds). SH04 / PX05 judge these groups: a selling colour never hides a wasting one.
 */
export function groupByModelColour<T>(
  items: readonly T[],
  keyItemOf: (t: T) => KeyItem,
  metricsOf: (t: T) => { cost: number; conv: number; value: number },
): VariantGroup<T>[] {
  return sumByKey(items, modelColourKeys(items.map(keyItemOf)), metricsOf);
}

/** True when a group key carries a colour (all its members share one colour). */
export function keyHasColour(key: string): boolean {
  return !key.startsWith("copy:") && key.includes("|");
}

function sumByKey<T>(
  items: readonly T[],
  keys: readonly string[],
  metricsOf: (t: T) => { cost: number; conv: number; value: number },
): VariantGroup<T>[] {
  const byKey = new Map<string, VariantGroup<T>>();
  for (const [k, t] of items.entries()) {
    const key = keys[k]!;
    const m = metricsOf(t);
    const g =
      byKey.get(key) ?? byKey.set(key, { key, members: [], cost: 0, conv: 0, value: 0 }).get(key)!;
    g.members.push(t);
    g.cost += m.cost;
    g.conv += m.conv;
    g.value += m.value;
  }
  for (const g of byKey.values()) g.members.sort((a, b) => metricsOf(b).cost - metricsOf(a).cost);
  return [...byKey.values()];
}

/**
 * the name a parent product is shown under: its top variant's title, with the variant count when
 * there are several (never "all": V10 reads it as a totals word). `oneColour` (every
 * member shares one colour) = "<title> (N sizes)". The title is never shortened.
 */
export function variantGroupName(topTitle: string, variants: number, oneColour = false): string {
  if (variants <= 1) return topTitle;
  return oneColour
    ? `${topTitle} (${variants} sizes)`
    : `${topTitle} (${variants} sizes and colours together)`;
}
