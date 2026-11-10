// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Product universe + Shopping campaign subtree.
 *
 * Product universe = `products` (products slice: clicks > 0, top 500
 * by clicks → SAMPLE, cap 500) ∪ `shoppingProductsData` (shopping_products,
 * cap 1000), keyed by the LOWERCASED id (Google lowercases item ids —
 * reference_gads_product_item_id_lowercase). Joins, all lowercased:
 *   mc_price_insights.product_id  = products.product_id
 *   shopping_cart_data.product_item_id = products.product_id OR its last '_'
 *     segment (the Shopify variant id — both forms occur)
 *   product_search_terms — checkability from the SYNC MARKER, never rows.length
 *     (Phase 1b: the table holds Shopping campaign×term rows, product_item_id
 *     NULL, marker ALWAYS 'skipped'). Product-level terms attach only when the
 *     marker is 'ok' AND the row carries a product_item_id; otherwise
 *     attrs.searchTerms is null with the marker's message. Campaign-grain rows
 *     attach to the Shopping campaign / ad-group nodes as SearchTermNodes.
 *
 * Shopping campaign: when `shopping_settings` has no row for a Shopping
 * campaign, a Shopping campaign's priority / feed label
 * are 'not_synced' and its product set cannot be derived → products [] with
 * notCheckable SH17. When a Shopping row IS synced, products are matched by
 * feed_label ('' = every product; another label = the products carrying it, when
 * the product rows carry the column). Product groups: no table → null.
 */
import {
  bool,
  json,
  nc,
  nodeFromRows,
  propagateTruncation,
  str,
  type BuildCtx,
} from "./context.js";
import { buildSearchTerm, type SearchDeps } from "./buildSearchTree.js";
import { num } from "./metrics.js";
import type { CampaignNode } from "./nodes/CampaignNode.js";
import type { ProductFeed, ProductNode } from "./nodes/ProductNode.js";

/** Google asks for colour and size on clothing only: the "Apparel & Accessories" category branch (the app's feedNicheApplicability). */
export function isApparelCategory(category: string | null | undefined): boolean {
  return (category ?? "").trim().toLowerCase().startsWith("apparel & accessories");
}

/** Row limits come from the caller (`caps`): products, shoppingProductsData, shoppingCartData, mcPriceInsights. */
const atLimit = (ctx: BuildCtx, key: string, rows: number): boolean => {
  const cap = ctx.capOf(key);
  return cap != null && rows >= cap;
};

export interface ProductUniverse {
  nodes: ProductNode[];
  byId: Map<string, ProductNode>;
  /** variant-id suffix → products (several products can share a suffix only if ids collide; kept as a list). */
  bySuffix: Map<string, ProductNode[]>;
  sample: { truncated: boolean; cap?: number | undefined; rowsSeen: number };
  /** product-grain search terms attachable (marker ok). */
  productSearchTermsSynced: boolean;
  productSearchTermsNote: string | null;
  /** campaign-grain rows (product_item_id null) for the Shopping campaign / ad-group nodes. */
  campaignTermRows: any[];
  cartSample: boolean;
}

/**
 * An item's rows grouped by its lowercased id. Google Ads' product list has one row per
 * (Merchant Center account, channel, language, feed label, item id): the same item in a US
 * and a CA feed is two rows. They are kept together on purpose, never cut to the first one.
 */
function rowsById(rows: readonly any[], idField: string): Map<string, any[]> {
  const out = new Map<string, any[]>();
  for (const r of rows) {
    const id = String(r?.[idField] ?? "").toLowerCase();
    if (!id) continue;
    (out.get(id) ?? out.set(id, []).get(id)!).push(r);
  }
  return out;
}

/** The first non-empty value of a column across an item's rows. */
function firstOf(rows: readonly any[], field: string): any {
  for (const r of rows) if (r?.[field] != null && r[field] !== "") return r[field];
  return null;
}

/** Sum of a column across an item's rows; null when no row has a number. */
function sumOf(rows: readonly any[], field: string): number | null {
  const vals = rows.map((r) => num(r?.[field])).filter((v): v is number => v != null);
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
}

/** One entry per feed row; undefined when no row has feed columns. */
function feedsOf(rows: readonly any[]): ProductFeed[] | undefined {
  const withFeed = rows.filter((r) => r && Object.prototype.hasOwnProperty.call(r, "feed_label"));
  if (withFeed.length === 0) return undefined;
  return withFeed.map((r) => ({
    merchantId: str(r.merchant_id),
    channel: str(r.channel),
    language: str(r.language_code),
    feedLabel: r.feed_label == null ? null : String(r.feed_label),
    status: str(r.status),
    availability: str(r.availability),
    issueCodes: issueCodesOf(r.issue_codes),
  }));
}

/** A row's blocking issue codes: a JSON list (or a list) of strings; null = not read. */
function issueCodesOf(v: unknown): string[] | null {
  const list = json<unknown[]>(v);
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === "string") : null;
}

export function itemIdSuffix(id: string): string {
  const parts = id.toLowerCase().split("_");
  return parts[parts.length - 1] ?? "";
}

export function buildProductUniverse(ctx: BuildCtx, parentId: string): ProductUniverse {
  const products = ctx.read("products");
  const shopping = ctx.read("shoppingProductsData");
  const price = ctx.read("mcPriceInsights");
  const cart = ctx.read("shoppingCartData");
  const pstAll = ctx.read("productSearchTerms");
  // marker decides; rows.length never does (Phase 1b: marker is 'skipped' with PRODUCT_SEARCH_TERM_LIMITATION)
  const pstGate = ctx.gate("product_search_terms", pstAll, "productSearchTerms");
  const campaignTermRows = pstAll.filter(
    (t) => t.product_item_id == null || String(t.grain ?? "") === "campaign_term",
  );
  const pst = pstGate.rows
    ? pstGate.rows.filter(
        (t) => t.product_item_id != null && String(t.grain ?? "product_term") !== "campaign_term",
      )
    : [];

  const priceById = new Map(
    price.map((p) => [String(p.product_id ?? "").toLowerCase(), p] as const),
  );
  // one item, several feed rows: its cart data summed like its spend (the average cart size
  // weighted by orders)
  const cartById = new Map<string, any>();
  for (const [id, rows] of rowsById(cart, "product_item_id")) {
    const orders = sumOf(rows, "orders");
    const sized = rows.filter((r) => num(r.average_cart_size) != null && num(r.orders) != null);
    const sizedOrders = sized.reduce((t, r) => t + (num(r.orders) ?? 0), 0);
    cartById.set(id, {
      product_item_id: id,
      units_sold: sumOf(rows, "units_sold"),
      orders,
      revenue_micros: sumOf(rows, "revenue_micros"),
      average_cart_size:
        sizedOrders > 0
          ? sized.reduce((t, r) => t + (num(r.average_cart_size) ?? 0) * (num(r.orders) ?? 0), 0) /
            sizedOrders
          : sized.length > 0
            ? num(sized[0]?.average_cart_size)
            : null,
    });
  }
  const shoppingById = rowsById(shopping, "item_id");
  const productsById = rowsById(products, "product_id");
  const pstById = new Map<string, any[]>();
  for (const t of pst) {
    const k = String(t.product_item_id ?? t.item_id ?? "").toLowerCase();
    (pstById.get(k) ?? pstById.set(k, []).get(k)!).push(t);
  }
  const productSearchTermsSynced = pstGate.rows != null;
  const productSearchTermsNote =
    pstGate.note ??
    (pstGate.rows != null && pst.length === 0 && pstAll.length > 0
      ? "product_search_terms holds campaign-grain rows only (no product_item_id)"
      : null);

  const nodes: ProductNode[] = [];
  const byId = new Map<string, ProductNode>();
  const bySuffix = new Map<string, ProductNode[]>();
  const truncated = atLimit(ctx, "products", products.length);

  // rows: the item's product-list rows (every feed); shops: its status-list rows
  const mk = (id: string, rows: any[], shops: any[]): ProductNode => {
    const suffix = itemIdSuffix(id);
    const row = rows[0] ?? null;
    const shop = shops[0] ?? null;
    const base = row
      ? nodeFromRows(ctx, "product", id, str(row.title) ?? id, parentId, rows, "products", {
          fields: { costMicros: "cost_micros" },
          idField: "product_id",
          sample: {
            truncated,
            ...(ctx.capOf("products") != null ? { cap: ctx.capOf("products")! } : {}),
          },
        })
      : nodeFromRows(
          ctx,
          "product",
          id,
          str(shop?.title) ?? id,
          parentId,
          shops,
          "shoppingProductsData",
          {
            fields: { cost: "__none", value: "conversions_value" },
            idField: "item_id",
            sample: {
              truncated: atLimit(ctx, "shoppingProductsData", shopping.length),
              ...(ctx.capOf("shoppingProductsData") != null
                ? { cap: ctx.capOf("shoppingProductsData")! }
                : {}),
            },
          },
        );
    const labels = row
      ? [0, 1, 2, 3, 4].map((i) => str(firstOf(rows, `custom_label_${i}`)))
      : [null, null, null, null, null];
    const blank = (f: string): boolean => !row || row[f] == null || row[f] === "";
    const missing: string[] = [];
    // app twin (M15 fix round 2): a GTIN is missing only when the product has no MPN either and the
    // store did not set identifier_exists to "no" (handmade / own make); colour and size are asked
    // of clothing only (Google category "Apparel & Accessories", as the app's gender / age group)
    const noIdentifier =
      bool(row?.identifier_exists) === false ||
      String(row?.identifier_exists ?? "")
        .trim()
        .toLowerCase() === "no";
    if (blank("gtin") && blank("mpn") && !noIdentifier) missing.push("gtin");
    if (isApparelCategory(str(row?.google_product_category)))
      for (const f of ["color", "size"] as const) if (blank(f)) missing.push(f);
    const pr = priceById.get(id) ?? null;
    const cr = cartById.get(id) ?? cartById.get(suffix) ?? null;
    const cur = pr ? num(pr.current_price_micros) : null;
    const promo = row ? json<any>(row.promotion_ids) : null;
    const node: ProductNode = {
      ...base,
      attrs: {
        productId: id,
        itemIdSuffix: suffix,
        title: str(row?.title ?? shop?.title),
        brand: str(row?.brand),
        productType: str(row?.product_type),
        googleProductCategory: str(row?.google_product_category),
        mcStatus: str(row?.mc_status),
        mcItemIssues: row ? json(row.mc_item_issues) : null,
        customLabels: labels,
        inFeed: row != null,
        gtin: str(row?.gtin),
        color: str(row?.color),
        itemGroupId: str(row?.item_group_id),
        size: str(row?.size),
        missingAttrs: missing,
        promotionIds: promo,
        promotionAttached: Array.isArray(promo) ? promo.length > 0 : promo != null,
        titleLength: num(row?.title_length) ?? (row?.title ? String(row.title).length : null),
        shopping: shop
          ? {
              status: str(shop.status),
              issues: json(shop.issues),
              channel: str(shop.channel),
              clicks: sumOf(shops, "clicks"),
              impressions: sumOf(shops, "impressions"),
              conv: sumOf(shops, "conversions"),
              value: sumOf(shops, "conversions_value"),
            }
          : null,
        priceInsight: pr
          ? {
              current: cur == null ? null : cur / 1e6,
            }
          : null,
        cart: cr
          ? {
              unitsSold: num(cr.units_sold),
              orders: num(cr.orders),
              revenue: num(cr.revenue_micros) == null ? null : num(cr.revenue_micros)! / 1e6,
              avgCartSize: num(cr.average_cart_size),
            }
          : null,
        assetGroupsIncludingMe: [],
        pmaxCampaignIds: [],
        shoppingCampaignIds: [],
        searchTerms:
          productSearchTermsSynced && !productSearchTermsNote
            ? (pstById.get(id) ?? pstById.get(suffix) ?? []).map((t) => ({
                term: String(t.search_term ?? ""),
                cost: num(t.cost),
                conv: num(t.conversions),
              }))
            : null,
        productPerfPerCampaign: "not_synced",
        primarySource: row ? "products" : "shoppingProductsData",
        // the status list carries each feed's own status; else the product list's feed rows
        ...(feedsOf(shops.length > 0 ? shops : rows) !== undefined
          ? { feeds: feedsOf(shops.length > 0 ? shops : rows) }
          : {}),
      },
    };
    if (!productSearchTermsSynced || productSearchTermsNote)
      node.notCheckable.push(
        nc("product.search_terms", productSearchTermsNote ?? "product_search_terms not checkable"),
      );
    if (!row)
      node.notCheckable.push(
        nc("product.cost", "only shopping_products knows this item — no cost column"),
      );
    node.notCheckable.push(
      nc(
        "product.per_campaign_perf",
        "product-level spend is account-wide; per-campaign rows (pmax_campaign_products) not joined",
      ),
    );
    return node;
  };
  for (const [id, rows] of productsById) {
    const n = mk(id, rows, shoppingById.get(id) ?? []);
    nodes.push(n);
    byId.set(id, n);
  }
  for (const [id, shops] of shoppingById) {
    if (byId.has(id)) continue;
    const n = mk(id, [], shops);
    nodes.push(n);
    byId.set(id, n);
  }
  for (const n of nodes)
    (
      bySuffix.get(n.attrs.itemIdSuffix) ??
      bySuffix.set(n.attrs.itemIdSuffix, []).get(n.attrs.itemIdSuffix)!
    ).push(n);
  return {
    nodes,
    byId,
    bySuffix,
    sample: {
      truncated,
      ...(ctx.capOf("products") != null ? { cap: ctx.capOf("products")! } : {}),
      rowsSeen: products.length,
    },
    productSearchTermsSynced,
    productSearchTermsNote,
    campaignTermRows,
    cartSample: atLimit(ctx, "shoppingCartData", cart.length),
  };
}

export interface ShoppingSettingsRow {
  priority: number | null;
  merchantId: string | null;
  feedLabel: string | null;
  enableLocal: boolean | null;
  channelSubType: string | null;
}

export function shoppingSettingsFor(
  row: any | undefined,
): CampaignNode["attrs"]["shoppingSettings"] {
  if (!row)
    return {
      state: "not_synced",
      priority: null,
      merchantId: null,
      feedLabel: null,
      enableLocal: null,
      channelSubType: null,
    };
  return {
    state: "synced",
    priority: num(row.campaign_priority),
    merchantId: str(row.merchant_id),
    feedLabel: row.feed_label == null ? null : String(row.feed_label),
    enableLocal: bool(row.enable_local),
    channelSubType: str(row.channel_sub_type),
  };
}

/** Shopping campaign children: products by feed label when settings are synced; product groups never. */
export function buildShoppingChildren(
  ctx: BuildCtx,
  campaign: CampaignNode,
  universe: ProductUniverse,
  deps: SearchDeps,
): void {
  campaign.children.productGroups = null;
  // campaign-grain term rows (Phase 1b) → the ad group they name, else the campaign
  for (const t of universe.campaignTermRows) {
    if (String(t.campaign_id ?? "") !== campaign.id) continue;
    const agId = t.ad_group_id == null ? null : String(t.ad_group_id);
    const ag = agId ? campaign.children.adGroups.find((g) => g.id === agId) : undefined;
    const node = buildSearchTerm(
      ctx,
      t,
      campaign.id,
      ag ? ag.id : null,
      ag ? ag.children.keywords : [],
      deps,
      "productSearchTerms",
    );
    if (ag) ag.children.searchTerms.push(node);
    else campaign.children.searchTerms.push(node);
  }
  campaign.notCheckable.push(
    nc(
      "SH17",
      "Shopping product groups are not read; partition tree, bids and exclusions are not visible",
    ),
  );
  const ss = campaign.attrs.shoppingSettings;
  if (ss.state !== "synced") {
    campaign.children.products = [];
    campaign.notCheckable.push(
      nc(
        "shopping.products",
        "shopping_settings has no row for this Shopping campaign — feed label unknown, product set cannot be derived",
      ),
    );
    return;
  }
  // feed_label '' = all products; another label matches the products that carry the same label
  // (case-insensitive), when every product row carries the column
  // a product with no label read could belong to any campaign: then nothing is matched
  const labelled =
    universe.nodes.length > 0 &&
    universe.nodes.every(
      (p) => p.attrs.feeds !== undefined && p.attrs.feeds.every((f) => f.feedLabel !== null),
    );
  if (ss.feedLabel == null || ss.feedLabel === "") {
    campaign.children.products = universe.nodes;
    for (const p of universe.nodes) p.attrs.shoppingCampaignIds.push(campaign.id);
  } else if (labelled) {
    const want = ss.feedLabel.toLowerCase();
    // an item sells through this campaign when any of its feeds carries the label
    campaign.children.products = universe.nodes.filter((p) =>
      (p.attrs.feeds ?? []).some((f) => (f.feedLabel ?? "").toLowerCase() === want),
    );
    for (const p of campaign.children.products) p.attrs.shoppingCampaignIds.push(campaign.id);
  } else {
    campaign.children.products = [];
    campaign.notCheckable.push(
      nc(
        "shopping.products",
        `feed_label '${ss.feedLabel}' cannot be matched — products carry no feed_label column`,
      ),
    );
  }
  propagateTruncation(campaign, campaign.children.products);
}

/** Shopping ↔ PMax item overlap (G.5 / SH12). */
export function computeItemOverlap(
  universe: ProductUniverse,
): { productId: string; pmaxCampaignIds: string[]; shoppingCampaignIds: string[] }[] {
  const out: { productId: string; pmaxCampaignIds: string[]; shoppingCampaignIds: string[] }[] = [];
  for (const p of universe.nodes) {
    if (p.attrs.pmaxCampaignIds.length && p.attrs.shoppingCampaignIds.length) {
      out.push({
        productId: p.id,
        pmaxCampaignIds: [...p.attrs.pmaxCampaignIds],
        shoppingCampaignIds: [...p.attrs.shoppingCampaignIds],
      });
    }
  }
  return out;
}
