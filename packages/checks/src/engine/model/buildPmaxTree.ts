// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * PMax subtree — asset groups → assets / audience signals / search themes /
 * listing groups → products; channel slices; search categories; placements.
 *
 * Joins (§C): asset_groups.campaign_id; pmax_assets / pmax_signals /
 * pmax_listing_groups .asset_group_id; pmax_signals.audience →
 * audiences.audience_id (resource suffix); pmax_channel_distribution
 * .campaign_id; pmax_search_insights.campaign_id (cap 50 / campaign → sample);
 * pmax_search_terms.campaign_id (search terms WITH cost, cap 2000 / campaign →
 * sample) → campaign.children.searchTerms through buildSearchTerm, so the
 * blocked resolver and the term checks see PMax terms;
 * placement_performance.campaign_id (db table).
 *
 * Listing group tree: parent_listing_group_id is '<asset_group_id>~<listing_group_id>'
 * — the prefix is stripped before matching listing_group_id.
 *
 * GUESSED JOIN — listing group → product. case_value is a JSON string:
 *   {"productItemId":{"value":"<variant id>"}}   → products whose LOWERCASED
 *     id equals the value, OR whose last '_' segment equals it (Shopify MC ids
 *     are shopify_<cc>_<productId>_<variantId>; Google's listing group carries
 *     the variant id). A value outside the loaded products slice is outside
 *     the slice, not missing.
 *   {"productCustomAttribute":{"index":"INDEX0","value":"summer"}} → products
 *     whose custom_label_<n> equals the value (case-insensitive).
 *   {"productType":{"level":..,"value":..}} → product_type; {"productBrand":{value}} → brand.
 *   a dimension WITHOUT a value = "everything else": the parent's scope minus
 *     the siblings' matches.
 *   Scope is hierarchical: a node's products ⊆ its parent's products; root = universe.
 */
import { cmpStr } from "../shared/order.js";
import {
  brandMatcherFrom,
  groupBy,
  json,
  nc,
  nodeFromRows,
  propagateTruncation,
  resourceId,
  setShare,
  str,
  containsBrandName,
  PMAX_PLACEMENTS_TABLE,
  BRAND_LISTS_TABLE,
  type BuildCtx,
} from "./context.js";
import { num } from "./metrics.js";
import type { ProductUniverse } from "./buildShoppingTree.js";
import { PRODUCT_CATALOG_TABLE, type CatalogCollector } from "./productCatalog.js";
import { buildSearchTerm, type SearchDeps, type SearchIndex } from "./buildSearchTree.js";
import type { AssetGroupNode } from "./nodes/AssetGroupNode.js";
import { assetsUnknownReason, signalsUnknownReason } from "./nodes/AssetGroupNode.js";
import { userListIdsIn } from "./nodes/AudienceSignalNode.js";
import type { AssetNode } from "./nodes/AssetNode.js";
import type { AudienceSignalNode } from "./nodes/AudienceSignalNode.js";
import type {
  BrandListRef,
  CampaignNode,
  CampaignProductPerfRow,
  CampaignProductRecentRow,
  CampaignProductUnspent,
} from "./nodes/CampaignNode.js";
import type { ChannelClassification, ChannelSlice } from "./nodes/ChannelSlice.js";
import type { ListingDimension, ListingGroupNode, ProductJoin } from "./nodes/ListingGroupNode.js";
import type { PlacementNode } from "./nodes/PlacementNode.js";
import type { ProductNode } from "./nodes/ProductNode.js";
import type { SearchCategoryNode } from "./nodes/SearchCategoryNode.js";
import type { SearchTermNode } from "./nodes/SearchTermNode.js";
import type { SearchThemeNode } from "./nodes/SearchThemeNode.js";

/** Sync cap per campaign on pmax_search_terms (the sync's per-campaign cap). */
/** Marker-message parts the sync writes (the sync writes them). Keep them in step. */
export const PMAX_TERMS_COVERAGE_PARTIAL = "coverage partial:";
export const PMAX_TERMS_NOT_READ = "campaigns not read:";
/** notCheckable id on a PMax campaign whose search categories were not read. */
export const PMAX_CATEGORIES_NOT_READ = "pmax.search_categories_not_read";

/** PMax campaign ids the sync could not read (partial read), from a table marker (search terms, placements). */
export function pmaxTermsNotRead(
  marker: { error_message?: string | null } | null | undefined,
): Set<string> {
  const msg = String(marker?.error_message ?? "");
  if (!msg.startsWith(PMAX_TERMS_COVERAGE_PARTIAL)) return new Set();
  const at = msg.indexOf(PMAX_TERMS_NOT_READ);
  if (at < 0) return new Set();
  const list = msg.slice(at + PMAX_TERMS_NOT_READ.length).split(";")[0] ?? "";
  return new Set(
    list
      .split(",")
      .map((x) => x.trim())
      .filter((x) => /^\d+$/.test(x)),
  );
}
/**
 * R3.4a: audit-keyed PMax tables read straight from the pool (like DG_TABLES).
 * A missing key is exactly "not loaded" — PX05 then keeps its account-wide read.
 */
export const PMAX_CAMPAIGN_PRODUCTS_TABLE = "pmax_campaign_products";
export const PMAX_TABLES = [PMAX_CAMPAIGN_PRODUCTS_TABLE] as const;
export const PLACEMENT_JUNK_MIN_COST = 10;
const TEXT_FIELDS = new Set(["HEADLINE", "LONG_HEADLINE", "DESCRIPTION"]);
/**
 * The uploaded creative a reader can SEE. `isFeedOnly` is about text and says
 * nothing about images or video: a "feed only" group can
 * carry headlines and zero images, so they are `isFeedOnly: false` and still
 * have no creative to describe. Anything that words the entity for a customer
 * must read this, not `isFeedOnly`.
 */
const VISUAL_FIELDS = new Set([
  "MARKETING_IMAGE",
  "SQUARE_MARKETING_IMAGE",
  "PORTRAIT_MARKETING_IMAGE",
  "YOUTUBE_VIDEO",
]);

export function classifyChannel(network: string): ChannelClassification {
  const n = network.toUpperCase();
  if (n === "SEARCH" || n === "SEARCH_PARTNERS") return "shopping";
  // v26 AdNetworkType values Performance Max channel reporting returns off Search
  if (
    n === "CONTENT" ||
    n === "YOUTUBE" ||
    n === "DISCOVER" ||
    n === "GMAIL" ||
    n === "MAPS" ||
    n === "GOOGLE_TV"
  )
    return "video_display";
  // MIXED and the historical GOOGLE_OWNED_CHANNELS cannot be split
  return "unclassified";
}

export function parseDimension(caseValue: unknown): ListingDimension {
  const cv = json<Record<string, any>>(caseValue);
  if (!cv || typeof cv !== "object") return { kind: "root" };
  const keys = Object.keys(cv);
  if (keys.length === 0) return { kind: "root" };
  const k = keys[0] ?? "";
  const v = cv[k] ?? {};
  switch (k) {
    case "productItemId":
      return { kind: "productItemId", value: str(v.value) };
    case "productCustomAttribute":
      return { kind: "productCustomAttribute", index: str(v.index), value: str(v.value) };
    case "productType":
      return { kind: "productType", level: str(v.level), value: str(v.value) };
    case "productBrand":
      return { kind: "productBrand", value: str(v.value) };
    case "productCategory":
      return { kind: "productCategory", level: str(v.level), value: str(v.categoryId ?? v.value) };
    default:
      return { kind: "other", raw: cv };
  }
}

function dimensionValue(d: ListingDimension): string | null {
  return "value" in d ? d.value : null;
}

function matchProducts(
  d: ListingDimension,
  scope: ProductNode[],
  universe: ProductUniverse,
): { products: ProductNode[]; join: ProductJoin } {
  const v = dimensionValue(d)?.toLowerCase() ?? null;
  if (v == null) return { products: [], join: "not_applicable" };
  switch (d.kind) {
    case "productItemId": {
      const set = new Set(scope);
      const hits = [universe.byId.get(v), ...(universe.bySuffix.get(v) ?? [])].filter(
        (p): p is ProductNode => !!p && set.has(p),
      );
      return { products: [...new Set(hits)], join: "item_id_suffix" };
    }
    case "productCustomAttribute": {
      const idx = Number(String(d.index ?? "").replace(/\D/g, ""));
      return {
        products: scope.filter((p) => (p.attrs.customLabels[idx] ?? "").toLowerCase() === v),
        join: "custom_label",
      };
    }
    case "productType":
      return {
        products: scope.filter((p) => (p.attrs.productType ?? "").toLowerCase() === v),
        join: "product_type",
      };
    case "productBrand":
      return {
        products: scope.filter((p) => (p.attrs.brand ?? "").toLowerCase() === v),
        join: "brand",
      };
    default:
      return { products: [], join: "none" };
  }
}

export interface PmaxDeps {
  universe: ProductUniverse;
  /** 09-29: the full stored catalog, walked through the same listing trees for SH19 (absent in hand-built deps). */
  catalog?: CatalogCollector | undefined;
  searchIndex: SearchIndex;
  placementsByCampaign: Map<string, PlacementNode[]>;
  /** Negatives framework P1: needed to build PMax search-term nodes (absent in hand-built deps = no term nodes). */
  searchDeps?: SearchDeps | undefined;
}

export interface PmaxIndex {
  assetGroupsByCampaign: Map<string, any[]>;
  assetsByGroup: Map<string, any[]>;
  signalsByGroup: Map<string, any[]>;
  listingByGroup: Map<string, any[]>;
  channelsByCampaign: Map<string, any[]>;
  channelDataByCampaign: Map<string, any[]>;
  insightsByCampaign: Map<string, any[]>;
  /** pmax_search_terms by campaign (absent in hand-built indexes). */
  termsByCampaign?: Map<string, any[]> | undefined;
  audienceById: Map<string, any>;
}

export function preparePmaxIndex(ctx: BuildCtx): PmaxIndex {
  const audiences = ctx.read("audiences");
  return {
    assetGroupsByCampaign: groupBy(ctx.read("assetGroups"), (r) => str(r.campaign_id)),
    assetsByGroup: groupBy(ctx.read("pmaxAssets"), (r) => str(r.asset_group_id)),
    signalsByGroup: groupBy(ctx.read("pmaxSignals"), (r) => str(r.asset_group_id)),
    listingByGroup: groupBy(ctx.read("pmaxListingGroups"), (r) => str(r.asset_group_id)),
    channelsByCampaign: groupBy(ctx.read("pmaxChannelDistribution"), (r) => str(r.campaign_id)),
    channelDataByCampaign: groupBy(ctx.read("pmaxChannelData"), (r) => str(r.campaign_id)),
    insightsByCampaign: groupBy(ctx.read("pmaxSearchInsights"), (r) => str(r.campaign_id)),
    termsByCampaign: groupBy(ctx.read("pmaxSearchTerms"), (r) => str(r.campaign_id)),
    audienceById: new Map(
      audiences.map(
        (a) => [String(a.audience_id ?? resourceId(a.resource_name) ?? ""), a] as const,
      ),
    ),
  };
}

/** Placements from db placement_performance, grouped by campaign (PMax, Demand Gen, Display). */
export function buildPlacements(ctx: BuildCtx): {
  byCampaign: Map<string, PlacementNode[]>;
  loaded: boolean;
  rows: number;
  note: string | null;
} {
  const gate = ctx.gate("placement_performance", ctx.readDb("placement_performance"));
  const rows = gate.rows;
  const byCampaign = new Map<string, PlacementNode[]>();
  for (const r of rows ?? []) {
    const cid = String(r.campaign_id ?? "");
    const key = str(r.target_url) ?? str(r.display_name) ?? String(r.id);
    const base = nodeFromRows(
      ctx,
      "placement",
      `${cid}:${key}`,
      str(r.display_name) ?? key,
      cid,
      [r],
      "placement_performance",
    );
    const cost = base.windows.m90.cost ?? 0;
    const node: PlacementNode = {
      ...base,
      attrs: {
        campaignId: cid,
        placementType: str(r.placement_type),
        displayName: str(r.display_name),
        targetUrl: str(r.target_url),
        junk: cost >= PLACEMENT_JUNK_MIN_COST && (base.windows.m90.conv ?? 0) === 0,
      },
    };
    (byCampaign.get(cid) ?? byCampaign.set(cid, []).get(cid)!).push(node);
  }
  return { byCampaign, loaded: rows != null, rows: rows?.length ?? 0, note: gate.note };
}

/**
 * The products a Performance Max campaign can sell: those of its feed label (an empty label =
 * every product). With a product whose label was not read, or no settings, every product.
 */
function pmaxProductScope(campaign: CampaignNode, universe: ProductUniverse): ProductNode[] {
  const ss = campaign.attrs.shoppingSettings;
  const label = ss.state === "synced" ? (ss.feedLabel ?? "") : "";
  const labelled =
    universe.nodes.length > 0 &&
    universe.nodes.every(
      (p) => p.attrs.feeds !== undefined && p.attrs.feeds.every((f) => f.feedLabel !== null),
    );
  if (label === "" || !labelled) return universe.nodes;
  const want = label.toLowerCase();
  return universe.nodes.filter((p) =>
    (p.attrs.feeds ?? []).some((f) => (f.feedLabel ?? "").toLowerCase() === want),
  );
}

function buildListingTree(
  ctx: BuildCtx,
  ag: AssetGroupNode,
  rows: any[],
  universe: ProductUniverse,
  campaignId: string,
  rootScope: ProductNode[],
): ListingGroupNode[] {
  const byParent = new Map<string, any[]>();
  const stripPrefix = (p: unknown) => {
    const s = str(p);
    if (!s) return null;
    const i = s.indexOf("~");
    return i >= 0 ? s.slice(i + 1) : s;
  };
  for (const r of rows) {
    const p = stripPrefix(r.parent_listing_group_id) ?? "";
    (byParent.get(p) ?? byParent.set(p, []).get(p)!).push(r);
  }
  const build = (
    r: any,
    parentId: string | null,
    depth: number,
    scope: ProductNode[],
    siblingsMatched: Set<ProductNode> | null,
    isEverythingElse: boolean,
  ): ListingGroupNode => {
    const id = String(r.listing_group_id);
    const dim = parseDimension(r.case_value);
    // scope of this node = parent's scope narrowed by its own dimension; the root keeps the
    // campaign's products (its feed label's)
    let products: ProductNode[] = [];
    let join: ProductJoin = "not_applicable";
    if (dim.kind === "root") {
      products = scope;
      join = "not_applicable";
    } else if (isEverythingElse) {
      products = scope.filter((p) => !siblingsMatched!.has(p));
      join = "none";
    } else {
      const m = matchProducts(dim, scope, universe);
      products = m.products;
      join = m.join;
    }
    const type = String(r.type ?? "");
    const base = nodeFromRows(
      ctx,
      "listingGroup",
      id,
      `${dim.kind}${dimensionValue(dim) != null ? "=" + dimensionValue(dim) : isEverythingElse ? " (everything else)" : ""}`,
      parentId ?? ag.id,
      [],
      "pmaxListingGroups",
      {
        sample: {
          truncated: universe.sample.truncated,
          cap: universe.sample.cap,
          rowsSeen: products.length,
        },
      },
    );
    const kids = byParent.get(id) ?? [];
    // siblings with a value first, then everything-else nodes get the remainder
    const valued = kids.filter((k) => dimensionValue(parseDimension(k.case_value)) != null);
    const rest = kids.filter((k) => dimensionValue(parseDimension(k.case_value)) == null);
    const matched = new Set<ProductNode>();
    const childNodes: ListingGroupNode[] = [];
    for (const k of valued) {
      const c = build(k, id, depth + 1, products, null, false);
      childNodes.push(c);
      for (const p of c.children.products) matched.add(p);
    }
    for (const k of rest) childNodes.push(build(k, id, depth + 1, products, matched, true));
    const node: ListingGroupNode = {
      ...base,
      attrs: {
        assetGroupId: ag.id,
        type,
        depth,
        dimension: dim,
        isEverythingElse,
        rawCaseValue: r.case_value ?? null,
        cpcBidMicros: num(r.cpc_bid_micros),
        productJoin: join,
      },
      children: { children: childNodes, products: type === "SUBDIVISION" ? [] : products },
    };
    if (type === "UNIT_INCLUDED")
      for (const p of products) {
        if (!p.attrs.assetGroupsIncludingMe.includes(ag.id))
          p.attrs.assetGroupsIncludingMe.push(ag.id);
        if (!p.attrs.pmaxCampaignIds.includes(campaignId)) p.attrs.pmaxCampaignIds.push(campaignId);
      }
    if (universe.sample.truncated)
      node.notCheckable.push(
        nc(
          "listing_group.products",
          `products is a ${universe.sample.cap}-row slice (clicks > 0) — leaf membership is partial`,
        ),
      );
    return node;
  };
  const roots = byParent.get("") ?? [];
  return roots.map((r) => build(r, null, 0, rootScope, null, false));
}

export function buildAssetGroups(
  ctx: BuildCtx,
  campaign: CampaignNode,
  idx: PmaxIndex,
  deps: PmaxDeps,
): AssetGroupNode[] {
  const rows = idx.assetGroupsByCampaign.get(campaign.id) ?? [];
  // B2: the signals fetch is one query over the campaign's groups, so a sibling group with signal
  // rows proves the fetch covered this campaign — a zero-row group beside it genuinely has none
  // A campaign with no signal row on ANY group is unknown.
  const campaignHasSignalRows = rows.some(
    (r) => (idx.signalsByGroup.get(String(r.asset_group_id)) ?? []).length > 0,
  );
  const out: AssetGroupNode[] = [];
  for (const r of rows) {
    const id = String(r.asset_group_id);
    const base = nodeFromRows(
      ctx,
      "assetGroup",
      id,
      String(r.name ?? id),
      campaign.id,
      [r],
      "assetGroups",
      { status: r.status },
    );
    const assetRows = idx.assetsByGroup.get(id) ?? [];
    const assets: AssetNode[] = assetRows.map((a) => {
      const perf = deps.searchIndex.assetPerfByAssetId.get(String(a.asset_id)) ?? [];
      const node: AssetNode = {
        ...nodeFromRows(
          ctx,
          "asset",
          `${id}:${a.asset_id}`,
          str(a.asset_text) ?? str(a.video_title) ?? String(a.asset_id),
          id,
          [a],
          "pmaxAssets",
        ),
        attrs: {
          surface: "pmax",
          fieldType: str(a.field_type),
          performanceLabel: str(a.performance_label),
          assetPerformanceLabel: perf.length ? str(perf[0].performance_label) : null,
          text: str(a.asset_text),
          assetResource: perf.length ? str(perf[0].asset_resource) : null,
          primaryStatus: str(a.primary_status),
          primaryStatusDetails: json(a.primary_status_details),
          assetType: str(a.asset_type),
          imageUrl: str(a.asset_image_url),
          imageWidthPx: num(a.image_width_px),
          imageHeightPx: num(a.image_height_px),
          imageAspectRatio: num(a.image_aspect_ratio),
          mimeType: str(a.mime_type),
          videoTitle: str(a.video_title),
          assetSource: str(a.asset_source),
          linkStatus: str(a.status),
        },
      };
      if (perf.length && ctx.atCap("assetPerformance")) node.sample.truncated = true;
      return node;
    });
    const assetCounts: Record<string, number> = {};
    for (const a of assets) {
      const f = a.attrs.fieldType ?? "UNKNOWN";
      assetCounts[f] = (assetCounts[f] ?? 0) + 1;
    }
    const signalRows = idx.signalsByGroup.get(id) ?? [];
    const audienceSignals: AudienceSignalNode[] = [];
    const searchThemes: SearchThemeNode[] = [];
    for (const s of signalRows) {
      const aud = str(s.audience);
      const theme = str(s.search_theme);
      if (aud) {
        const aid = resourceId(aud);
        const arow = aid ? idx.audienceById.get(aid) : undefined;
        audienceSignals.push({
          ...nodeFromRows(
            ctx,
            "audienceSignal",
            `${id}:${aud}`,
            str(arow?.name) ?? aud,
            id,
            [],
            "pmaxSignals",
          ),
          attrs: {
            assetGroupId: id,
            campaignId: campaign.id,
            adGroupId: null,
            audienceResource: aud,
            audienceId: aid,
            audienceName: str(arow?.name),
            audienceStatus: str(arow?.status),
            approvalStatus: str(s.approval_status),
            disapprovalReasons: json<unknown[]>(s.disapproval_reasons) ?? [],
            userListIds: arow ? userListIdsIn(arow.dimensions_json) : null,
          },
        });
      }
      if (theme) {
        searchThemes.push({
          ...nodeFromRows(ctx, "searchTheme", `${id}:${theme}`, theme, id, [], "pmaxSignals"),
          attrs: {
            assetGroupId: id,
            text: theme,
            approvalStatus: str(s.approval_status),
            disapprovalReasons: json<unknown[]>(s.disapproval_reasons) ?? [],
            brandOverlap: containsBrandName(theme, ctx.brandMatch),
          },
        });
      }
    }
    const lgRows = idx.listingByGroup.get(id) ?? [];
    // D11: the asset state is known ONLY when ≥1 pmaxAssets
    // row exists. Zero rows = "feed-only by design" OR "not fetched" — the data
    // cannot tell them apart, so the group is unknown (fail closed). Campaign
    // status proves nothing here: a sync change removed the ENABLED-only sync gate, and
    // an ENABLED group can have zero rows.
    const assetsKnown = assets.length > 0;
    // B2: the signals table judged on its own rows — one signal row on this group or a sibling proves the fetch, so a 0 is real
    const signalsKnown = audienceSignals.length + searchThemes.length > 0 || campaignHasSignalRows;
    const node: AssetGroupNode = {
      ...base,
      attrs: {
        campaignId: campaign.id,
        adStrength: str(r.ad_strength),
        assetsKnown,
        signalsKnown,
        isFeedOnly: assetsKnown
          ? !assets.some((a) => TEXT_FIELDS.has(a.attrs.fieldType ?? ""))
          : null,
        hasVisualAssets: assetsKnown
          ? assets.some((a) => VISUAL_FIELDS.has(a.attrs.fieldType ?? ""))
          : null,
        assetCounts,
        imageHealth: json(r.image_health),
        listingGroupCounts: {
          subdivision: lgRows.filter((l) => l.type === "SUBDIVISION").length,
          included: lgRows.filter((l) => l.type === "UNIT_INCLUDED").length,
          excluded: lgRows.filter((l) => l.type === "UNIT_EXCLUDED").length,
        },
      },
      children: { assets, audienceSignals, searchThemes, listingGroups: [] },
    };
    node.children.listingGroups = buildListingTree(
      ctx,
      node,
      lgRows,
      deps.universe,
      campaign.id,
      pmaxProductScope(campaign, deps.universe),
    );
    // SH19 coverage: only a tree that can serve counts — an ENABLED asset group
    // in an ENABLED campaign (a paused seasonal campaign must not report its
    // whole catalog as "never served"). Unknown status = not counted.
    // Phase 11b (PX15): every asset group's tree is resolved to products, switched off or not;
    // only the serving ones count for SH19.
    const inTree = deps.catalog?.add(lgRows, {
      serving:
        String(r.status ?? "").toUpperCase() === "ENABLED" &&
        String(campaign.status ?? "").toUpperCase() === "ENABLED",
      pmaxGroupId: id,
    });
    // the catalog products this campaign can show (never-served sizes too), for its unspent sizes
    if (inTree) {
      const set =
        catalogIdsOf.get(campaign) ?? catalogIdsOf.set(campaign, new Set()).get(campaign)!;
      for (const x of inTree) set.add(x);
    }
    if (!assetsKnown) node.notCheckable.push(nc("asset_group.assets", assetsUnknownReason()));
    if (!signalsKnown) node.notCheckable.push(nc("asset_group.signals", signalsUnknownReason()));
    if (!("LOGO" in assetCounts))
      node.notCheckable.push(
        nc(
          "asset_group.logo",
          "pmax_assets has no LOGO rows for this asset group (not synced or none)",
        ),
      );
    setShare(node, campaign.windows.m90);
    propagateTruncation(node, node.children.listingGroups);
    out.push(node);
  }
  return out;
}

export function buildChannels(
  ctx: BuildCtx,
  campaign: CampaignNode,
  idx: PmaxIndex,
): ChannelSlice[] {
  const dist = idx.channelsByCampaign.get(campaign.id) ?? [];
  const data = idx.channelDataByCampaign.get(campaign.id) ?? [];
  const out: ChannelSlice[] = [];
  for (const r of dist) {
    const net = String(r.ad_network_type ?? "UNKNOWN");
    const base = nodeFromRows(
      ctx,
      "channelSlice",
      `${campaign.id}:${net}`,
      net,
      campaign.id,
      [r],
      "pmaxChannelDistribution",
    );
    const node: ChannelSlice = {
      ...base,
      attrs: {
        adNetworkType: net,
        classification: classifyChannel(net),
        source: "pmaxChannelDistribution",
      },
    };
    setShare(node, campaign.windows.m90);
    out.push(node);
  }
  // pmaxChannelData (pmax_channel_performance rollup) — EMPTY on every audit until a4861265; consumed when present
  const have = new Set(out.map((c) => c.attrs.adNetworkType));
  for (const r of data) {
    const net = String(r.channel ?? r.ad_network_type ?? "UNKNOWN");
    if (have.has(net)) continue;
    const base = nodeFromRows(
      ctx,
      "channelSlice",
      `${campaign.id}:${net}`,
      net,
      campaign.id,
      [r],
      "pmaxChannelData",
      { fields: { value: "conversions_value" } },
    );
    const node: ChannelSlice = {
      ...base,
      attrs: {
        adNetworkType: net,
        classification: classifyChannel(net),
        source: "pmaxChannelData",
      },
    };
    setShare(node, campaign.windows.m90);
    out.push(node);
  }
  return out;
}

/** shoppingShare / videoDisplayShare / unclassifiedShare of the campaign's channel-split total — all three or none. */
export function channelShares(channels: ChannelSlice[]): CampaignNode["attrs"]["channelShares"] {
  if (channels.length === 0) return null;
  let total = 0;
  const by: Record<ChannelClassification, number> = {
    shopping: 0,
    video_display: 0,
    unclassified: 0,
  };
  for (const c of channels) {
    const cost = c.windows.m90.cost ?? 0;
    total += cost;
    by[c.attrs.classification] += cost;
  }
  if (total === 0) return { shopping: null, videoDisplay: null, unclassified: null };
  return {
    shopping: by.shopping / total,
    videoDisplay: by.video_display / total,
    unclassified: by.unclassified / total,
  };
}

export function buildSearchCategories(
  ctx: BuildCtx,
  campaign: CampaignNode,
  idx: PmaxIndex,
  search: SearchIndex,
): SearchCategoryNode[] {
  const rows = idx.insightsByCampaign.get(campaign.id) ?? [];
  const cap = ctx.capOf("pmaxSearchInsights:per_campaign");
  const truncated = cap != null && rows.length >= cap;
  return rows.map((r) => {
    const label = String(r.category_label ?? "");
    // a label of spaces only is as blank as an empty one
    const blank = label.trim() === "";
    const base = nodeFromRows(
      ctx,
      "searchCategory",
      `${campaign.id}:${blank ? r.id : label}`,
      blank ? "(unlabelled)" : label,
      campaign.id,
      [r],
      "pmaxSearchInsights",
      {
        fields: { value: "conversions_value", cost: "__none" },
        sample: { truncated, ...(cap != null ? { cap } : {}), rowsSeen: rows.length },
      },
    );
    const node: SearchCategoryNode = {
      ...base,
      attrs: {
        campaignId: campaign.id,
        label,
        brandToken: containsBrandName(label, ctx.brandMatch),
        overlapsSearchTerm: search.termTexts.has(label.toLowerCase()),
        overlapsKeyword: search.keywordTexts.has(label.toLowerCase()),
      },
    };
    node.notCheckable.push(nc("search_category.cost", "pmax_search_insights carries no cost"));
    return node;
  });
}

/**
 * PMax search terms with cost → campaign-level SearchTermNodes (no ad group,
 * no keyword). Reuses buildSearchTerm, so `blocked` comes from the same
 * resolver as Search / Shopping terms. 2000 rows for one campaign = sample.
 */
export function buildPmaxSearchTerms(
  ctx: BuildCtx,
  campaign: CampaignNode,
  idx: PmaxIndex,
  deps: SearchDeps,
): SearchTermNode[] {
  const rows = idx.termsByCampaign?.get(campaign.id) ?? [];
  const cap = ctx.capOf("pmaxSearchTerms:per_campaign");
  const truncated = cap != null && rows.length >= cap;
  return rows.map((r) => {
    const node = buildSearchTerm(ctx, r, campaign.id, null, [], deps, "pmaxSearchTerms");
    node.notCheckable = node.notCheckable.filter(
      (n) => n.checkId !== "search_term.matched_keyword",
    );
    node.notCheckable.push(
      nc("search_term.matched_keyword", "Performance Max search terms have no keyword"),
    );
    if (truncated)
      node.sample = {
        ...node.sample,
        truncated: true,
        ...(node.sample.cap != null || cap != null ? { cap: node.sample.cap ?? cap! } : {}),
        rowsSeen: rows.length,
      };
    if (r.conversions == null)
      node.notCheckable.push(
        nc(
          "search_term.conversions",
          "pmax_search_terms conversions not read (cost-only fallback query)",
        ),
      );
    setShare(node, campaign.windows.m90);
    return node;
  });
}

export function buildPmaxChildren(
  ctx: BuildCtx,
  campaign: CampaignNode,
  idx: PmaxIndex,
  deps: PmaxDeps,
): void {
  campaign.children.assetGroups = buildAssetGroups(ctx, campaign, idx, deps);
  campaign.children.channels = buildChannels(ctx, campaign, idx);
  campaign.attrs.channelShares = channelShares(campaign.children.channels);
  campaign.children.searchCategories = buildSearchCategories(ctx, campaign, idx, deps.searchIndex);
  if (deps.searchDeps)
    campaign.children.searchTerms.push(
      ...buildPmaxSearchTerms(ctx, campaign, idx, deps.searchDeps),
    );
  campaign.children.placements = deps.placementsByCampaign.get(campaign.id) ?? [];
  const seen = new Set<string>();
  const products: ProductNode[] = [];
  const walk = (lg: ListingGroupNode) => {
    if (lg.attrs.type === "UNIT_INCLUDED")
      for (const p of lg.children.products)
        if (!seen.has(p.id)) {
          seen.add(p.id);
          products.push(p);
        }
    for (const c of lg.children.children) walk(c);
  };
  for (const ag of campaign.children.assetGroups)
    for (const lg of ag.children.listingGroups) walk(lg);
  campaign.children.products = products;
  campaign.children.productGroups = null;
  campaign.attrs.productPerf = buildCampaignProductPerf(ctx, campaign, deps.universe);
  campaign.attrs.pmaxPlacements = buildPmaxPlacements(ctx, campaign);
  if (campaign.children.channels.length === 0)
    campaign.notCheckable.push(
      nc("pmax.channels", "no pmax_channel_distribution rows for this campaign"),
    );
  if (campaign.children.searchCategories.some((c) => c.sample.truncated))
    campaign.notCheckable.push(
      nc(
        "pmax.search_categories_sample",
        "pmax_search_insights is at the reader's per-campaign row limit — categories are a sample",
      ),
    );
  campaign.notCheckable.push(
    nc("PX10", "campaigns.url_expansion_opt_out is null — final URL expansion state unknown"),
  );
  if (campaign.attrs.brandExclusions.state !== "synced")
    campaign.notCheckable.push(
      nc(
        "pmax.brand_exclusions",
        campaign.attrs.brandExclusions.note ?? "PMax brand lists are not synced",
      ),
    );
  if (pmaxTermsNotRead(ctx.markers.get("pmax_search_insights")).has(campaign.id))
    campaign.notCheckable.push(
      nc(
        PMAX_CATEGORIES_NOT_READ,
        'the search categories of this campaign were not read (past the per-snapshot campaign limit, failed or cut) — unknown, never "none"',
      ),
    );
  if (pmaxTermsNotRead(ctx.markers.get("pmax_search_terms")).has(campaign.id))
    campaign.notCheckable.push(
      nc(
        "pmax.search_terms",
        'pmax_search_terms not read for this campaign (partial sync) — its search terms are unknown, never "none"',
      ),
    );
  if (
    campaign.children.searchTerms.some(
      (t) => t.attrs.source === "pmaxSearchTerms" && t.sample.truncated,
    )
  )
    campaign.notCheckable.push(
      nc(
        "pmax.search_terms_sample",
        "pmax_search_terms is at the reader's per-campaign row limit — terms are a sample",
      ),
    );
  propagateTruncation(campaign, [
    ...campaign.children.assetGroups,
    ...campaign.children.searchCategories,
    ...campaign.children.searchTerms,
  ]);
}

/**
 * R3.4a — the campaign's own product rows (cost / clicks / conversions / value
 * over the audit window) from pmax_campaign_products. Gated on the
 * sync marker: 'error' / 'skipped' / absent table = not_checkable with the
 * reason; 'ok' with zero rows for this campaign = synced, no product spent.
 * Rows that join a product-universe node also land on that node's
 * `productPerfPerCampaign`.
 */
export function buildCampaignProductPerf(
  ctx: BuildCtx,
  campaign: CampaignNode,
  universe: ProductUniverse,
): CampaignNode["attrs"]["productPerf"] {
  const g = ctx.gate(PMAX_CAMPAIGN_PRODUCTS_TABLE, ctx.readDb(PMAX_CAMPAIGN_PRODUCTS_TABLE));
  if (g.rows == null) {
    const note = g.note ?? `${PMAX_CAMPAIGN_PRODUCTS_TABLE} not loaded`;
    campaign.notCheckable.push(nc("pmax.product_perf", note));
    return { state: "not_checkable", note };
  }
  // rows of an older snapshot carry no channel and hold PMax campaigns only, so a
  // Shopping campaign with no rows there was never read: unknown, never "no product spent".
  if (campaign.attrs.type === "SHOPPING" && !g.rows.some((r) => str(r.channel) != null)) {
    const note = `${PMAX_CAMPAIGN_PRODUCTS_TABLE}: this snapshot read Performance Max campaigns only (no channel column), so this Shopping campaign's products were not read per campaign`;
    campaign.notCheckable.push(nc("pmax.product_perf", note));
    return { state: "not_checkable", note };
  }
  const feedOf = catalogFeedIndex(ctx);
  const marker = ctx.checkable(PMAX_CAMPAIGN_PRODUCTS_TABLE);
  const truncated = /^truncated/i.test(marker.message ?? "");
  const rows: CampaignProductPerfRow[] = [];
  const recentOnly: CampaignProductRecentRow[] = [];
  for (const r of g.rows) {
    if (String(r.campaign_id ?? "") !== campaign.id) continue;
    const offerId = String(r.offer_id ?? "").toLowerCase();
    if (!offerId) continue;
    const node =
      universe.byId.get(offerId) ??
      universe.bySuffix.get(offerId.split("_").pop() ?? "")?.[0] ??
      null;
    // round 3: a pair seen in the last 7 days with no row in the window's read (a capped
    // read): its 7-day impressions only, never a money row (no spend is invented)
    const impressions7d = r.impressions_7d == null ? null : num(r.impressions_7d);
    if (
      r.cost_micros == null &&
      r.impressions == null &&
      r.clicks == null &&
      impressions7d != null &&
      impressions7d > 0
    ) {
      recentOnly.push({ offerId, productId: node?.id ?? null, impressions7d });
      continue;
    }
    const feed =
      node?.attrs.color && node.attrs.itemGroupId && node.attrs.productType
        ? null
        : feedOf(offerId);
    // the row's category levels, in the feed's own spelling when it has the same level
    const [typeL1, typeL2] = productTypeLevelsOf(
      str(r.product_type_l1),
      str(r.product_type_l2),
      node?.attrs.productType ?? feed?.productType ?? null,
    );
    const row: CampaignProductPerfRow = {
      offerId,
      productId: node?.id ?? null,
      title: str(r.product_title) ?? node?.attrs.title ?? null,
      feedTitle: node?.attrs.title ?? null,
      customLabels: [0, 1, 2, 3, 4].map((i) => str(r[`custom_attr${i}`])),
      color: node?.attrs.color ?? feed?.color ?? null,
      itemGroupId: node?.attrs.itemGroupId ?? feed?.itemGroupId ?? null,
      productTypeL1: typeL1,
      productTypeL2: typeL2,
      categoryL1: str(r.product_category_l1),
      cost: (num(r.cost_micros) ?? 0) / 1e6,
      clicks: num(r.clicks) ?? 0,
      impressions: num(r.impressions) ?? 0,
      conv: num(r.conversions) ?? 0,
      value: num(r.conversions_value) ?? 0,
      impressions7d,
    };
    rows.push(row);
    if (node) {
      const list = Array.isArray(node.attrs.productPerfPerCampaign)
        ? node.attrs.productPerfPerCampaign
        : [];
      list.push({
        campaignId: campaign.id,
        cost: row.cost,
        conv: row.conv,
        value: row.value,
        impressions: row.impressions,
        impressions7d: row.impressions7d ?? null,
      });
      node.attrs.productPerfPerCampaign = list;
      node.notCheckable = node.notCheckable.filter(
        (x) => x.checkId !== "product.per_campaign_perf",
      );
    }
  }
  rows.sort((a, b) => b.cost - a.cost || cmpStr(a.offerId, b.offerId));
  const unspent = unspentProductsOf(ctx, campaign, rows);
  if (truncated)
    campaign.notCheckable.push(
      nc("pmax.product_perf_sample", `${PMAX_CAMPAIGN_PRODUCTS_TABLE}: ${marker.message}`),
    );
  return {
    state: "synced",
    truncated,
    cutoffCost: truncated ? cutoffCostOfMarker(marker.message) : null,
    rows,
    unspent,
    ...(recentOnly.length > 0 ? { recentOnly } : {}),
  };
}

/** PMax: the catalog products each campaign's resolvable listing trees include (filled by buildAssetGroups). */
const catalogIdsOf = new WeakMap<CampaignNode, Set<string>>();

/**
 * the products this campaign can show that have no row in it (never spent here): its own
 * product nodes (PMax listing trees, Shopping feed label) plus the stored catalog products
 * (served or not) its resolvable listing trees include (PMax) or its feed label matches
 * (Shopping, '' = every product). Title, colour and item group from the product node, else
 * the catalog row. The check groups them by model + colour. Absent catalog = product nodes only.
 */
function unspentProductsOf(
  ctx: BuildCtx,
  campaign: CampaignNode,
  rows: readonly CampaignProductPerfRow[],
): CampaignProductUnspent[] {
  const spent = new Set<string>();
  for (const r of rows) {
    spent.add(r.offerId);
    if (r.productId) spent.add(r.productId.toLowerCase());
  }
  const catalog = ctx.readDb(PRODUCT_CATALOG_TABLE);
  const byId = new Map<string, Record<string, unknown>[]>();
  for (const r of (Array.isArray(catalog) ? catalog : []) as Record<string, unknown>[]) {
    const id = String(r?.product_id ?? "").toLowerCase();
    if (id) (byId.get(id) ?? byId.set(id, []).get(id)!).push(r);
  }
  const out = new Map<string, CampaignProductUnspent>();
  for (const p of campaign.children.products) {
    const id = p.attrs.productId.toLowerCase();
    if (spent.has(id) || out.has(id)) continue;
    const row = byId.get(id)?.[0];
    out.set(id, {
      offerId: id,
      title: p.attrs.title ?? str(row?.title),
      color: p.attrs.color ?? str(row?.color),
      itemGroupId: p.attrs.itemGroupId ?? str(row?.item_group_id),
    });
  }
  let ids: Iterable<string> = [];
  if (campaign.attrs.type === "PERFORMANCE_MAX") ids = catalogIdsOf.get(campaign) ?? [];
  else if (campaign.attrs.type === "SHOPPING") {
    const ss = campaign.attrs.shoppingSettings;
    const label = ss.state === "synced" ? ss.feedLabel : null;
    if (label != null) {
      const want = label.toLowerCase();
      ids = [...byId]
        .filter(
          ([, rs]) =>
            want === "" || rs.some((r) => String(r.feed_label ?? "").toLowerCase() === want),
        )
        .map(([id]) => id);
    }
  }
  for (const id of ids) {
    if (spent.has(id) || out.has(id)) continue;
    const row = byId.get(id)?.[0];
    out.set(id, {
      offerId: id,
      title: str(row?.title),
      color: str(row?.color),
      itemGroupId: str(row?.item_group_id),
    });
  }
  return [...out.values()].sort((a, b) => cmpStr(a.offerId, b.offerId));
}

/**
 * the cutoff a capped split read wrote on its status note (`cutoff_cost=<n>`, the
 * snapshot's campaignProductsTruncatedNote): the most spend one product can have outside the
 * kept rows. null when absent (older notes). Pure.
 */
export function cutoffCostOfMarker(message: string | null | undefined): number | null {
  const m = /cutoff_cost=(\d+(?:\.\d+)?)/.exec(String(message ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * product type levels 1 and 2 of a per-campaign row. Google reports
 * segments.product_type_l1 / _l2 lowercased; the feed's product_type ("Menswear > Jackets")
 * gives the spelling the shop wrote, used when its level reads the same. No segment value: the
 * feed's own level. Pure.
 */
export function productTypeLevelsOf(
  segL1: string | null,
  segL2: string | null,
  feedType: string | null,
): [string | null, string | null] {
  const levels = (feedType ?? "")
    .split(">")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  const level = (seg: string | null, i: number): string | null => {
    const own = levels[i] ?? null;
    if (seg == null || seg.trim() === "") return own;
    return own != null && own.toLowerCase() === seg.trim().toLowerCase() ? own : seg.trim();
  };
  const l1 = level(segL1, 0);
  // a level 2 under another level 1 than the segment's is never borrowed from the feed
  const l2 =
    segL1 != null &&
    segL1.trim() !== "" &&
    (levels[0] ?? "").toLowerCase() !== segL1.trim().toLowerCase()
      ? segL2?.trim() || null
      : level(segL2, 1);
  return [l1, l2];
}

/**
 * colour, item_group_id and product type of a catalog product by offer id (full id; a
 * bare variant id joins by the Shopify variant suffix), for rows outside the product universe.
 * Absent catalog = nothing known.
 */
type CatalogFeed = { color: string | null; itemGroupId: string | null; productType: string | null };
function catalogFeedIndex(ctx: BuildCtx): (offerId: string) => CatalogFeed | null {
  const rows = ctx.readDb(PRODUCT_CATALOG_TABLE);
  if (!Array.isArray(rows) || rows.length === 0) return () => null;
  const byId = new Map<string, CatalogFeed>();
  const bySuffix = new Map<string, CatalogFeed>();
  for (const r of rows as Record<string, unknown>[]) {
    const id = String(r?.product_id ?? "").toLowerCase();
    if (!id) continue;
    const v = {
      color: str(r.color),
      itemGroupId: str(r.item_group_id),
      productType: str(r.product_type),
    };
    if (!byId.has(id)) byId.set(id, v);
    const suffix = id.split("_").pop() ?? "";
    if (suffix && !bySuffix.has(suffix)) bySuffix.set(suffix, v);
  }
  return (offerId) =>
    byId.get(offerId) ?? (offerId.includes("_") ? null : (bySuffix.get(offerId) ?? null));
}

/** R3.8: the sync keeps this many placement rows per PMax campaign (ORDER BY impressions DESC LIMIT 200). */

/**
 * R3.8 — where this PMax campaign served, from pmax_placements
 * (performance_max_placement_view: impressions only). Gated on the sync
 * marker like R3.4a. Zero rows for a live campaign is NOT "served nowhere":
 * the sync fails soft per campaign (restricted view), so it is not_checkable
 * with that reason. A campaign the sync did not read (failed, rate limited or
 * over its campaign cap: the marker's "campaigns not read" list) is not_checkable too.
 */
export function buildPmaxPlacements(
  ctx: BuildCtx,
  campaign: CampaignNode,
): CampaignNode["attrs"]["pmaxPlacements"] {
  const g = ctx.gate(PMAX_PLACEMENTS_TABLE, ctx.readDb(PMAX_PLACEMENTS_TABLE));
  if (g.rows == null)
    return { state: "not_checkable", note: g.note ?? `${PMAX_PLACEMENTS_TABLE} not loaded` };
  if (pmaxTermsNotRead(ctx.markers.get(PMAX_PLACEMENTS_TABLE)).has(campaign.id)) {
    return {
      state: "not_checkable",
      note: "placements not read for this campaign in this sync (read failed, rate limit or campaign cap)",
    };
  }
  const rows = g.rows
    .filter((r) => String(r.campaign_id ?? "") === campaign.id)
    .map((r) => ({
      placement: str(r.placement),
      placementType: str(r.placement_type),
      displayName: str(r.display_name),
      targetUrl: str(r.target_url),
      impressions: num(r.impressions) ?? 0,
    }));
  if (rows.length === 0)
    return {
      state: "not_checkable",
      note: "no placement rows for this campaign (Google may restrict the placement report)",
    };
  const cap = ctx.capOf("pmax_placements:per_campaign");
  return { state: "synced", capped: cap != null && rows.length >= cap, rows };
}

/**
 * P3g — the brand lists attached to a PMax or Search campaign, from
 * campaign_brand_lists (campaign_criterion type BRAND_LIST). Gated on
 * the sync marker: absent table / no marker / 'error' / 'skipped' = not_synced
 * with the reason; 'ok' with no row for this campaign = synced, none attached.
 * REMOVED attachments are dropped. Other campaign types are never read.
 */
export function buildBrandExclusions(
  ctx: BuildCtx,
  campaign: CampaignNode,
): CampaignNode["attrs"]["brandExclusions"] {
  const type = campaign.attrs.type;
  if (type !== "PERFORMANCE_MAX" && type !== "SEARCH")
    return {
      state: "not_synced",
      note: "brand lists are read for Performance Max and Search only",
    };
  const g = ctx.gate(BRAND_LISTS_TABLE, ctx.readDb(BRAND_LISTS_TABLE));
  if (g.rows == null)
    return {
      state: "not_synced",
      note: g.note ?? `${BRAND_LISTS_TABLE} not loaded — brand lists could not be checked`,
    };
  const lists = g.rows
    .filter(
      (r) =>
        String(r.campaign_id ?? "") === campaign.id &&
        String(r.status ?? "").toUpperCase() !== "REMOVED",
    )
    .map((r) => {
      const names = json<unknown>(r.brand_names);
      const brandNames = Array.isArray(names) ? names.map((n) => String(n)) : null;
      const brandCount = num(r.brand_count);
      return {
        criterionId: String(r.criterion_id ?? ""),
        negative: r.negative === true || String(r.negative).toLowerCase() === "true",
        status: str(r.status),
        sharedSetId: str(r.shared_set_id),
        name: str(r.shared_set_name),
        brandCount,
        brandNames,
        holdsOwnBrand: listHoldsOwnBrand(
          brandNames,
          brandCount,
          brandMatcherFrom(ctx.data.profile),
        ),
      };
    })
    .sort((a, b) => cmpStr(String(a.name ?? a.criterionId), String(b.name ?? b.criterionId)));
  return { state: "synced", lists };
}

/**
 * Does a brand list hold the ACCOUNT'S brand? true = one of its brands names
 * the account's brand (the whole-name matcher); false = contents read in full
 * and none matches (a competitor-only list); null = cannot tell (contents not
 * read, only part of the names kept, or no brand terms supplied).
 */
export function listHoldsOwnBrand(
  brandNames: readonly string[] | null | undefined,
  brandCount: number | null | undefined,
  matches: ((text: string) => boolean) | null,
): boolean | null {
  if (brandNames == null) return null;
  if (!matches) return null;
  if (brandNames.some((n) => matches(n))) return true;
  return brandCount != null && brandCount > brandNames.length ? null : false;
}

/**
 * The one reading every consumer uses. Only an ENABLED (or status-unknown)
 * EXCLUDING list counts, and (review fix) only when it holds the ACCOUNT'S brand:
 *   'attached'         = such a list holds your brand → the list-on check;
 *   'contents_unknown' = a list is attached but we couldn't see whether it holds
 *                        your brand → suppress nothing, say so;
 *   'none'             = synced, no list holding your brand (a competitor-only
 *                        list is 'none' for this purpose);
 *   'not_checked'      = the sync did not run / failed / not loaded.
 */
export type BrandListState = "attached" | "contents_unknown" | "none" | "not_checked";

/** every ENABLED excluding list, whatever it holds */
export function excludingBrandLists(
  be: CampaignNode["attrs"]["brandExclusions"] | null | undefined,
): BrandListRef[] {
  if (!be || be.state !== "synced") return [];
  return be.lists.filter(
    (l) => l.negative && (l.status == null || l.status.toUpperCase() === "ENABLED"),
  );
}

/** the excluding lists that hold the account's own brand */
export function ownBrandLists(
  be: CampaignNode["attrs"]["brandExclusions"] | null | undefined,
): BrandListRef[] {
  return excludingBrandLists(be).filter((l) => l.holdsOwnBrand === true);
}

export function brandListStateOf(
  be: CampaignNode["attrs"]["brandExclusions"] | null | undefined,
): BrandListState {
  if (!be || be.state !== "synced") return "not_checked";
  const lists = excludingBrandLists(be);
  if (lists.some((l) => l.holdsOwnBrand === true)) return "attached";
  if (lists.some((l) => l.holdsOwnBrand == null)) return "contents_unknown";
  return "none";
}

/** the list names a consumer should quote for a state: own-brand lists when attached, else every excluding list */
export function brandListNamesFor(
  be: CampaignNode["attrs"]["brandExclusions"] | null | undefined,
): string[] {
  const lists = brandListStateOf(be) === "attached" ? ownBrandLists(be) : excludingBrandLists(be);
  return lists.map((l) => l.name ?? `brand list ${l.criterionId}`);
}
