// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The full product catalog for SH19 ("feed products that never served").
 *
 * The model's ProductNodes come from the `products` slice: the top 500 by
 * clicks, the rows the AI sees. A product with no impressions can never be in
 * that slice, so SH19 could only ever say "not checkable". Since 09-29 the
 * product sync stores EVERY feed product (0 metrics when it has no ad data)
 * and the loader reads a lightweight list of them (PRODUCT_CATALOG_TABLE: id,
 * status, labels, impressions — no descriptions). This module walks each
 * listing tree over that list with the same rules as buildListingTree
 * (valued siblings first, "everything else" takes the remainder, only
 * UNIT_INCLUDED leaves include) and keeps counts only — no 10k-node tree.
 */
import { itemIdSuffix } from "./buildShoppingTree.js";
import { parseDimension } from "./buildPmaxTree.js";
import { str, type BuildCtx } from "./context.js";
import { num } from "./metrics.js";
import type { ListingDimension } from "./nodes/ListingGroupNode.js";

/** Pseudo-table key the loader fills from products (lightweight columns). */
export const PRODUCT_CATALOG_TABLE = "products_catalog";
/** Rows the loader reads; rows == cap = the catalog is a sample. Matches the sync's crawl cap. */
/**
 * mc_sync_status.resource the product sync writes for the feed crawl
 * (the product feed sync): 'ok' / 'empty' = the
 * whole feed is stored, 'truncated' = the crawl hit its cap. Kept as a literal
 * here so the model does not import the sync service.
 */
export const PRODUCT_FEED_SYNC_RESOURCE = "product_feed";
export interface CatalogItem {
  id: string;
  suffix: string;
  customLabels: Array<string | null>;
  productType: string | null;
  brand: string | null;
  impressions: number | null;
  mcStatus: string | null;
  /** Phase 11b (PX15): the product's sales in the product window; null on rows read before the column was selected. */
  title?: string | null | undefined;
  conv?: number | null | undefined;
  value?: number | null | undefined;
  cost?: number | null | undefined;
}

/** Phase 11b (PX15): a product that sold in the window, as the PMax coverage keeps it. */
export interface SellingProduct {
  id: string;
  title: string | null;
  conv: number;
  value: number;
  cost: number;
  /** its current labels and brand, so PX15 can tell whether a running tree could take it; absent on hand-built models. */
  suffix?: string | undefined;
  customLabels?: Array<string | null> | undefined;
  brand?: string | null | undefined;
}

/**
 * Phase 11b (PX15): every PMax asset group's listing tree resolved to catalog
 * products (any status: the switched-off groups are the point). Only the
 * SELLING products are kept per group, so this stays small on a 10k catalog.
 */
export interface PmaxGroupCoverage {
  /** asset group id → products the tree includes, and which of them sold */
  byGroup: Record<string, { included: number; selling: string[]; resolved: boolean }>;
  /** the selling products the trees include, by id */
  selling: Record<string, SellingProduct>;
}

export interface ProductCatalogServing {
  /** products read from the stored catalog (every feed product, clicked or not). */
  rows: number;
  /**
   * the catalog is NOT proven complete: the sync's feed-crawl row says
   * 'truncated', there is no such row (synced before 09-29, completeness
   * unknown), or the loader read hit its cap. SH19 never counts on it.
   */
  truncated: boolean;
  /** the sync's feed-crawl flag: 'complete' | 'truncated' | 'missing' (no row). */
  crawl: "complete" | "truncated" | "missing";
  /** listing trees (asset groups / Shopping ad groups) walked. */
  listingTrees: number;
  /** products inside at least one UNIT_INCLUDED leaf. */
  included: number;
  /** of those, zero impressions in the product window. */
  includedNeverServed: number;
  /** of the never-served, how many Merchant Center disapproves. */
  neverServedDisapproved: number;
  /** up to 10 never-served product ids. */
  examples: string[];
  /** Phase 11b (PX15): per PMax asset group coverage. Optional for hand-built models. */
  pmaxGroups?: PmaxGroupCoverage | undefined;
}

/**
 * One item per item id. The product list has a row per feed (Merchant Center account,
 * channel, language, feed label): an item in a US and a CA feed has two rows, merged on
 * purpose here: impressions, conversions, value and spend summed, labels the first set.
 */
export function catalogItemsOf(rows: any[]): CatalogItem[] {
  const byId = new Map<string, any[]>();
  for (const r of rows) {
    const id = String(r.product_id ?? "").toLowerCase();
    if (!id) continue;
    (byId.get(id) ?? byId.set(id, []).get(id)!).push(r);
  }
  const first = (rs: any[], f: string): string | null => {
    for (const r of rs) if (str(r[f]) != null) return str(r[f]);
    return null;
  };
  const sum = (rs: any[], f: string): number | null => {
    const vals = rs.map((r) => num(r[f])).filter((v): v is number => v != null);
    return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
  };
  return [...byId].map(([id, rs]) => {
    const micros = sum(rs, "cost_micros");
    return {
      id,
      suffix: itemIdSuffix(id),
      customLabels: [0, 1, 2, 3, 4].map((i) => first(rs, `custom_label_${i}`)),
      productType: first(rs, "product_type"),
      brand: first(rs, "brand"),
      impressions: sum(rs, "impressions"),
      mcStatus: first(rs, "mc_status"),
      title: first(rs, "title"),
      conv: sum(rs, "conversions"),
      value: sum(rs, "conversion_value"),
      cost: micros == null ? null : micros / 1_000_000,
    };
  });
}

function valueOf(d: ListingDimension): string | null {
  return "value" in d ? d.value : null;
}

/** buildPmaxTree.matchProducts over catalog items (same joins: item id / suffix, custom label, product type, brand). */
function matchItems(d: ListingDimension, scope: CatalogItem[]): CatalogItem[] {
  const v = valueOf(d)?.toLowerCase() ?? null;
  if (v == null) return [];
  switch (d.kind) {
    case "productItemId":
      return scope.filter((p) => p.id === v || p.suffix === v);
    case "productCustomAttribute": {
      const idx = Number(String(d.index ?? "").replace(/\D/g, ""));
      return scope.filter((p) => (p.customLabels[idx] ?? "").toLowerCase() === v);
    }
    case "productType":
      return scope.filter((p) => (p.productType ?? "").toLowerCase() === v);
    case "productBrand":
      return scope.filter((p) => (p.brand ?? "").toLowerCase() === v);
    default:
      return [];
  }
}

/**
 * Phase 11b review: the dimensions `matchItems` can evaluate exactly against
 * the stored catalog. Google category, condition, channel and product-type
 * levels are not (the stored product_type is a full path, "Apparel > Women", and
 * a LEVEL1 node names one level of it), so a tree using any of them is
 * UNRESOLVED: its product set is unknown, never "these products".
 */
const RESOLVABLE_KINDS: ReadonlySet<string> = new Set([
  "root",
  "productItemId",
  "productCustomAttribute",
  "productBrand",
]);

/** true when every node of the tree splits on a dimension the catalog can evaluate. Pure; exported for testing. */
export function listingTreeResolvable(lgRows: any[]): boolean {
  return lgRows.every(
    (r) => r.case_value == null || RESOLVABLE_KINDS.has(parseDimension(r.case_value).kind),
  );
}

/** The catalog items one listing tree includes (UNIT_INCLUDED leaves). Pure; exported for testing. */
export function includedByListingTree(lgRows: any[], items: CatalogItem[]): Set<CatalogItem> {
  const stripPrefix = (p: unknown) => {
    const s = str(p);
    if (!s) return null;
    const i = s.indexOf("~");
    return i >= 0 ? s.slice(i + 1) : s;
  };
  const byParent = new Map<string, any[]>();
  for (const r of lgRows) {
    const p = stripPrefix(r.parent_listing_group_id) ?? "";
    (byParent.get(p) ?? byParent.set(p, []).get(p)!).push(r);
  }
  const included = new Set<CatalogItem>();
  const walk = (
    r: any,
    scope: CatalogItem[],
    siblingsMatched: Set<CatalogItem> | null,
    isEverythingElse: boolean,
    depth: number,
  ): CatalogItem[] => {
    if (depth > 20) return [];
    const id = String(r.listing_group_id);
    const dim = parseDimension(r.case_value);
    const products =
      dim.kind === "root"
        ? scope
        : isEverythingElse
          ? scope.filter((p) => !siblingsMatched!.has(p))
          : matchItems(dim, scope);
    const kids = byParent.get(id) ?? [];
    const valued = kids.filter((k) => valueOf(parseDimension(k.case_value)) != null);
    const rest = kids.filter((k) => valueOf(parseDimension(k.case_value)) == null);
    const matched = new Set<CatalogItem>();
    for (const k of valued)
      for (const p of walk(k, products, null, false, depth + 1)) matched.add(p);
    for (const k of rest) walk(k, products, matched, true, depth + 1);
    if (String(r.type ?? "") === "UNIT_INCLUDED") for (const p of products) included.add(p);
    return products;
  };
  for (const root of byParent.get("") ?? []) walk(root, items, null, false, 0);
  return included;
}

export interface CatalogCollector {
  /**
   * walk one listing tree (called wherever buildListingTree runs). `serving`
   * (default true) = the tree can serve and counts for SH19's coverage;
   * `pmaxGroupId` records the tree's selling products for PX15 (any status).
   * Returns the ids of the catalog products the tree includes when every node of it can be
   * evaluated (listingTreeResolvable); null = no catalog, no tree, or a tree we cannot resolve.
   */
  add(lgRows: any[], opts?: { serving?: boolean; pmaxGroupId?: string }): string[] | null;
  /** null when the catalog was not loaded (older audit / failed read) — never "none". */
  summary(): ProductCatalogServing | null;
}

/** The sync's feed-crawl flag from the mc_sync_status rows. Pure; exported for testing. */
export function feedCrawlState(mcSyncRows: any[]): ProductCatalogServing["crawl"] {
  const row = mcSyncRows.find((r) => String(r.resource ?? "") === PRODUCT_FEED_SYNC_RESOURCE);
  if (!row) return "missing";
  const s = String(row.status ?? "");
  return s === "ok" || s === "empty" ? "complete" : "truncated";
}

export function createCatalogCollector(ctx: BuildCtx): CatalogCollector {
  const rows = ctx.readDb(PRODUCT_CATALOG_TABLE);
  const crawl = feedCrawlState(ctx.read("mcSyncStatus"));
  const items = rows ? catalogItemsOf(rows) : [];
  const included = new Set<CatalogItem>();
  const pmaxGroups: PmaxGroupCoverage = { byGroup: {}, selling: {} };
  let trees = 0;
  return {
    add(lgRows, opts) {
      if (!rows || lgRows.length === 0) return null;
      const serving = opts?.serving ?? true;
      const inTree = includedByListingTree(lgRows, items);
      if (serving) {
        trees += 1;
        for (const p of inTree) included.add(p);
      }
      if (opts?.pmaxGroupId) {
        const selling: string[] = [];
        for (const p of inTree) {
          if ((p.conv ?? 0) <= 0) continue;
          selling.push(p.id);
          pmaxGroups.selling[p.id] ??= {
            id: p.id,
            title: p.title ?? null,
            conv: p.conv ?? 0,
            value: p.value ?? 0,
            cost: p.cost ?? 0,
            suffix: p.suffix,
            customLabels: p.customLabels,
            brand: p.brand,
          };
        }
        pmaxGroups.byGroup[opts.pmaxGroupId] = {
          included: inTree.size,
          selling,
          resolved: listingTreeResolvable(lgRows),
        };
      }
      return listingTreeResolvable(lgRows) ? [...inTree].map((p) => p.id) : null;
    },
    summary() {
      if (!rows) return null;
      const silent = [...included].filter((p) => (p.impressions ?? 0) === 0);
      return {
        rows: items.length,
        truncated:
          crawl !== "complete" ||
          (ctx.capOf(PRODUCT_CATALOG_TABLE) != null &&
            rows.length >= ctx.capOf(PRODUCT_CATALOG_TABLE)!),
        crawl,
        listingTrees: trees,
        included: included.size,
        includedNeverServed: silent.length,
        neverServedDisapproved: silent.filter(
          (p) => (p.mcStatus ?? "").toLowerCase() === "disapproved",
        ).length,
        examples: silent.slice(0, 10).map((p) => p.id),
        pmaxGroups,
      };
    },
  };
}
