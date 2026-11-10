// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Cross-tree checks: findings that only exist by joining two trees. SK23 joins
 * keywords to the search terms they triggered; PX12 joins Performance Max search
 * categories to the keywords and searches a Search campaign already owns. The
 * joins live in the model; a check reads them and decides whether the signal is
 * there. PX11 joins products to the listing trees of one Performance Max
 * campaign's asset groups; SH12 joins them across Shopping and Performance Max.
 *
 * A keyword with no search term is usually Google's reporting threshold, not a
 * dead keyword: SK23 rules that out from this account's own data before it
 * names one.
 */
import type { AssetGroupNode } from "../model/nodes/AssetGroupNode.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import type { ListingGroupNode } from "../model/nodes/ListingGroupNode.js";
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import { liveAssetGroupsOf } from "../registry/entityStatus.js";
import type { MetricValue } from "../registry/types.js";
import {
  brandListNamesFor,
  brandListStateOf,
  excludingBrandLists,
} from "../model/buildPmaxTree.js";
import { brandMatcherOfModel, containsBrandName } from "../model/context.js";
import { categoriesNotRead, namesOf } from "./pmax.js";
import { canShowProduct } from "./shopping.js";
import {
  campaignsOf,
  type CheckCtx,
  type CheckDefinition,
  type CheckFinding,
  type CheckResult,
  type CheckScope,
  defineCheck,
  finding,
  gateOnData,
  isOk,
  num,
} from "./types.js";

const campaignScope = (c: CampaignNode): CheckScope => ({
  type: "campaign",
  id: c.id,
  name: c.name,
  campaignId: c.id,
  campaignName: c.name,
});

const pmaxCampaigns = (ctx: CheckCtx): CampaignNode[] =>
  campaignsOf(ctx).filter((c) => c.attrs.type === "PERFORMANCE_MAX");

// ---------------------------------------------------------------------------
// SK23 — keyword with spend triggers no search term
// ---------------------------------------------------------------------------

const SK23_TABLES: string[] = ["keywords", "searchTerms"];

const SK23 = defineCheck({
  id: "SK23",
  claimKey: CLAIM_KEYS.KEYWORD_TERMS_NOT_TRIGGERED,
  title: "keyword with spend triggers no search term",
  clientLabel: "keywords that spend without showing the searches behind them",
  group: "cross_tree",
  metrics: ["K.spend", "K.clicks", "T.matched_keyword"],
  confounders: ["SK01", "SK05", "MI01"],
  requires: SK23_TABLES,
  needsCompleteData: ["searchTerms"],
  impactFormula: "IMP_NONE",
  noneFoundMeans:
    "No keyword with material spend is spending without showing the search terms behind it.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, SK23_TABLES);
    if (gate) return gate;
    const { silentKeywordMaxShare } = ctx.settings.search;

    const keywords = campaignsOf(ctx).flatMap((c) =>
      c.children.adGroups.flatMap((g) => g.children.keywords),
    );
    // Performance Max search terms have no keyword behind them
    const terms = campaignsOf(ctx)
      .flatMap((c) => [
        ...c.children.searchTerms,
        ...c.children.adGroups.flatMap((g) => g.children.searchTerms),
      ])
      .filter((t) => t.attrs.source !== "pmaxSearchTerms");
    if (keywords.length === 0)
      return { state: "not_checkable", reason: "no keyword on this account", table: "keywords" };
    if (terms.length === 0)
      return {
        state: "not_checkable",
        reason: "no search term to join keywords to",
        table: "searchTerms",
      };

    const resolved = terms.filter((t) => t.attrs.matchSource === "criterion_id");
    if (resolved.length === 0) {
      return {
        state: "not_checkable",
        reason: `none of the ${terms.length} search terms names the keyword that triggered it, so "triggered nothing" cannot be told apart from a join that is not there`,
        table: "searchTerms",
      };
    }

    const spendingKeywords = keywords.filter(
      (k) => !k.attrs.isNegative && (k.windows.m90.cost ?? 0) > 0,
    );
    const withTerms = spendingKeywords.filter((k) => k.children.triggeredTerms.length > 0);
    if (withTerms.length === 0) {
      return {
        state: "not_checkable",
        reason: `not one of the ${spendingKeywords.length} keywords with spend has a search term resolved back to it, so no keyword's silence can be told apart from the reporting threshold`,
        table: "searchTerms",
      };
    }
    const silentShare = (spendingKeywords.length - withTerms.length) / spendingKeywords.length;
    if (silentShare > silentKeywordMaxShare) {
      return {
        state: "not_checkable",
        reason: `${Math.round(silentShare * 100)}% of the ${spendingKeywords.length} keywords with spend show no search term of their own, which is the reporting threshold across the account rather than a fault in the few that would otherwise be named`,
        table: "searchTerms",
        category: "google_withholds",
      };
    }
    // below the fewest clicks any keyword here needed before a term surfaced, silence is the threshold
    const termsAppearAbove = Math.min(...withTerms.map((k) => k.windows.m90.clicks ?? 0));
    const floorV = ctx.get("T.waste_floor");
    const materialityFloor = num(floorV);

    const findings: CheckFinding[] = [];
    let population = 0;
    let belowThreshold = 0;
    let immaterial = 0;
    for (const c of campaignsOf(ctx)) {
      for (const g of c.children.adGroups) {
        for (const k of g.children.keywords) {
          if (k.attrs.isNegative) continue;
          const spend = ctx.get("K.spend", { keywordId: k.id });
          const spendValue = num(spend);
          if (spendValue == null || spendValue <= 0) continue;
          population += 1;
          if (k.children.triggeredTerms.length > 0) continue;
          const clicks = ctx.get("K.clicks", { keywordId: k.id });
          const keywordClicks = k.windows.m90.clicks;
          if (keywordClicks != null && keywordClicks < termsAppearAbove) {
            belowThreshold += 1;
            continue;
          }
          if (materialityFloor != null && spendValue < materialityFloor) {
            immaterial += 1;
            continue;
          }
          findings.push(
            finding({
              claimKey: CLAIM_KEYS.KEYWORD_TERMS_NOT_TRIGGERED,
              scope: {
                type: "keyword",
                id: k.id,
                name: k.attrs.text,
                campaignId: c.id,
                campaignName: c.name,
              },
              cite: [spend, clicks].filter((v) => isOk(v)),
              entity: { id: k.id, name: k.attrs.text },
              facts: {
                match_type: k.attrs.matchType,
                spend: spendValue,
                terms_in_population: terms.length,
                terms_with_a_resolved_keyword: resolved.length,
                terms_start_appearing_above_clicks: termsAppearAbove,
                materiality_floor: materialityFloor,
              },
              population,
              rows: [
                {
                  entity: { id: k.id, name: k.attrs.text },
                  cells: {
                    match_type: String(k.attrs.matchType ?? "UNKNOWN"),
                    spend: spendValue,
                    ...(num(clicks) != null ? { clicks: num(clicks)! } : {}),
                  },
                },
              ],
              note: `${resolved.length} of ${terms.length} search terms name the keyword behind them — the answer is only as complete as that join`,
            }),
          );
        }
      }
    }
    if (population === 0)
      return { state: "not_checkable", reason: "no keyword carries spend", table: "keywords" };
    if (findings.length) return { state: "fires", findings };
    // ruled out by the reporting threshold = never judged, so never clean
    if (belowThreshold > 0) {
      return {
        state: "not_checkable",
        reason: `${belowThreshold} keyword(s) with spend show no search term of their own and sit below the ${termsAppearAbove} clicks at which terms start showing on this account, so Google's reporting threshold cannot be told apart from a keyword that triggers nothing`,
        table: "searchTerms",
        category: "google_withholds",
      };
    }
    return {
      state: "none_found",
      population,
      note:
        immaterial > 0 && materialityFloor != null
          ? `${immaterial} silent keyword(s) ruled out under the ${materialityFloor.toFixed(2)} materiality floor`
          : undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// PX12 — PMax search category overlaps a Search campaign's own searches
// ---------------------------------------------------------------------------

const PX12_TABLES: string[] = ["pmaxSearchInsights", "keywords", "searchTerms"];

const PX12 = defineCheck({
  id: "PX12",
  claimKey: CLAIM_KEYS.PMAX_CATEGORY_OVERLAPS_SEARCH_CAMPAIGN,
  title: "PMax search categories overlap a Search campaign",
  clientLabel: "Performance Max competing with your Search campaigns for the same searches",
  group: "cross_tree",
  metrics: ["P.brand_theme_click_share"],
  confounders: ["PX02", "SK01", "SK09", "MI01"],
  requires: PX12_TABLES,
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No PMax search category matches a query a Search campaign already owns.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, PX12_TABLES);
    if (gate) return gate;

    // the other tree: text -> the Search campaigns that own it, as a keyword or a served search
    const ownerByText = new Map<string, Set<string>>();
    const own = (text: string | null | undefined, c: CampaignNode) => {
      const key = (text ?? "").trim().toLowerCase();
      if (!key) return;
      const set = ownerByText.get(key) ?? new Set<string>();
      set.add(c.id);
      ownerByText.set(key, set);
    };
    for (const c of campaignsOf(ctx)) {
      if (c.attrs.type !== "SEARCH") continue;
      for (const g of c.children.adGroups) {
        for (const k of g.children.keywords) if (!k.attrs.isNegative) own(k.attrs.text, c);
        for (const t of g.children.searchTerms) own(t.attrs.term, c);
      }
      for (const t of c.children.searchTerms) own(t.attrs.term, c);
    }
    if (ownerByText.size === 0) {
      return {
        state: "not_checkable",
        reason: "no Search campaign owns a keyword or search to compare PMax categories with",
        table: "keywords",
        category: "nothing_to_compare",
      };
    }

    const campaigns = pmaxCampaigns(ctx).filter((c) => c.children.searchCategories.length > 0);
    const unread = categoriesNotRead(ctx);
    const unreadNote =
      unread.length > 0
        ? `the search categories of ${namesOf(unread.map((c) => c.name))} were not read`
        : null;
    if (campaigns.length === 0) {
      if (unreadNote)
        return {
          state: "not_checkable",
          reason: unreadNote,
          table: "pmaxSearchInsights",
          category: "our_gap",
        };
      return {
        state: "not_checkable",
        reason: "no PMax campaign has search category rows",
        table: "pmaxSearchInsights",
        category: "not_present",
      };
    }
    const matcher = brandMatcherOfModel(ctx.model);

    const findings: CheckFinding[] = [];
    for (const c of campaigns) {
      const categories = c.children.searchCategories;
      const totalClicks = categories.reduce((s, x) => s + (x.windows.m90.clicks ?? 0), 0);
      const overlapping = categories.filter((x) => {
        const owners = ownerByText.get(x.attrs.label.trim().toLowerCase());
        return (owners?.size ?? 0) > 0 || x.attrs.overlapsKeyword || x.attrs.overlapsSearchTerm;
      });
      if (overlapping.length === 0) continue;
      const overlapClicks = overlapping.reduce((s, x) => s + (x.windows.m90.clicks ?? 0), 0);
      const searchCampaignIds = [
        ...new Set(
          overlapping.flatMap((x) => [
            ...(ownerByText.get(x.attrs.label.trim().toLowerCase()) ?? []),
          ]),
        ),
      ].sort();
      const brandShare = ctx.get("P.brand_theme_click_share", { campaignId: c.id });
      const listState = brandListStateOf(c.attrs.brandExclusions);
      const listNames = brandListNamesFor(c.attrs.brandExclusions);
      const isBrand = (label: string) => matcher != null && containsBrandName(label, matcher);
      const brandOnly = overlapping.every((x) => x.attrs.brandToken || isBrand(x.attrs.label));
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.PMAX_CATEGORY_OVERLAPS_SEARCH_CAMPAIGN,
          scope: campaignScope(c),
          cite: [brandShare].filter((v) => isOk(v)),
          entity: { id: c.id, name: c.name },
          facts: {
            categories_returned: categories.length,
            overlapping_categories: overlapping.length,
            overlap_clicks: overlapClicks,
            category_clicks: totalClicks,
            overlap_click_share_pct: totalClicks > 0 ? (overlapClicks / totalClicks) * 100 : null,
            brand_token_overlap_clicks: overlapping
              .filter((x) => x.attrs.brandToken)
              .reduce((s, x) => s + (x.windows.m90.clicks ?? 0), 0),
            search_campaign_ids: searchCampaignIds.join(","),
            top_overlapping_labels: overlapping
              .slice()
              .sort(
                (a, b) =>
                  (b.windows.m90.clicks ?? 0) - (a.windows.m90.clicks ?? 0) ||
                  a.attrs.label.localeCompare(b.attrs.label),
              )
              .slice(0, 5)
              .map((x) => x.attrs.label)
              .join(" | "),
            ...(brandOnly ? { overlap_brand_only: true } : {}),
            brand_list_state: listState,
            ...(listNames.length > 0 ? { brand_list_names: listNames.join(" | ") } : {}),
            ...(listState !== "not_checked"
              ? { brand_lists_excluded_count: excludingBrandLists(c.attrs.brandExclusions).length }
              : {}),
          },
          population: categories.length,
          note:
            "search categories are Google's top categories per campaign — a sample; the overlap and its click share are the claim, and no money is projected from it" +
            (listState === "not_checked" ? "; brand exclusion lists were not checked" : ""),
        }),
      );
    }
    if (findings.length > 0) {
      if (unreadNote)
        for (const f of findings)
          f.limitedBy = [
            `${unreadNote.charAt(0).toUpperCase()}${unreadNote.slice(1)}, so they may overlap too.`,
          ];
      return { state: "fires", findings };
    }
    // a campaign whose categories were not read is unknown: never clean
    if (unreadNote)
      return {
        state: "not_checkable",
        reason: `${unreadNote}; the campaigns read show no overlap`,
        table: "pmaxSearchInsights",
        category: "our_gap",
      };
    return {
      state: "none_found",
      population: campaigns.reduce((s, c) => s + c.children.searchCategories.length, 0),
    };
  },
});

// ---------------------------------------------------------------------------
// PX11 / SH12 — products bought twice (product data joined to the listing trees)
// ---------------------------------------------------------------------------

/** Listing-tree dimensions matched to products exactly (item id, custom label, brand). */
const EXACT_DIMENSIONS: ReadonlySet<string> = new Set([
  "root",
  "productItemId",
  "productCustomAttribute",
  "productBrand",
]);

/**
 * True when every node of the group's product selection splits on a dimension the
 * products can be matched on exactly. A split on product type levels, Google's
 * category, condition or channel leaves the group's product set unknown: no check
 * may say the group does not include a product.
 */
function selectionExact(g: AssetGroupNode): boolean {
  const walk = (n: ListingGroupNode): boolean =>
    EXACT_DIMENSIONS.has(n.attrs.dimension.kind) && n.children.children.every(walk);
  return g.children.listingGroups.every(walk);
}

const PX11_TABLES: string[] = ["pmaxListingGroups", "assetGroups", "shoppingProductsData"];

const PX11 = defineCheck({
  id: "PX11",
  claimKey: CLAIM_KEYS.PMAX_PRODUCT_IN_MULTIPLE_ASSET_GROUPS,
  title: "the same product is included by several asset groups of one campaign",
  clientLabel: "products picked up by more than one asset group in a campaign",
  group: "cross_tree",
  metrics: ["P.listing_included", "Pr.spend"],
  confounders: ["PX03", "PX05", "SH15"],
  requires: PX11_TABLES,
  // a structure fault with no dollar figure (the campaign competes with itself)
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each product is bought by exactly one asset group inside its campaign.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, PX11_TABLES);
    if (gate) return gate;
    const campaigns = pmaxCampaigns(ctx);
    if (campaigns.length === 0)
      return {
        state: "not_checkable",
        reason: "no Performance Max campaign on this account",
        table: "assetGroups",
        category: "not_present",
      };
    const findings: CheckFinding[] = [];
    let population = 0;
    const unknown: string[] = [];
    for (const c of campaigns) {
      // only groups that serve can compete with each other
      const live = liveAssetGroupsOf(c);
      if (live.length < 2) continue;
      const groupIds = new Set(live.map((g) => g.id));
      const shared = ctx.model.children.products
        .map((p) => ({
          product: p,
          groups: p.attrs.assetGroupsIncludingMe.filter((id) => groupIds.has(id)),
        }))
        .filter((x) => x.groups.length > 1);
      if (shared.length === 0) {
        // no overlap can be shown only when every live selection is matched exactly
        if (!live.every(selectionExact)) unknown.push(c.name);
        else population += 1;
        continue;
      }
      population += 1;
      const involved = [...new Set(shared.flatMap((x) => x.groups))].sort();
      const witness = shared.reduce(
        (best, x) =>
          (x.product.windows.m90.cost ?? 0) > (best.product.windows.m90.cost ?? 0) ? x : best,
        shared[0]!,
      );
      const cite: MetricValue[] = involved.map((id) =>
        ctx.get("P.listing_included", { assetGroupId: id }),
      );
      cite.push(ctx.get("Pr.spend", { productId: witness.product.id }));
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.PMAX_PRODUCT_IN_MULTIPLE_ASSET_GROUPS,
          scope: {
            type: "product",
            id: null,
            name: `${shared.length} products in ${involved.length} asset groups`,
            campaignId: c.id,
            campaignName: c.name,
          },
          cite: cite.filter((v) => isOk(v)),
          facts: {
            products_in_more_than_one_asset_group: shared.length,
            asset_groups_involved: involved.length,
            live_asset_groups_in_campaign: groupIds.size,
            spend_of_shared_products: shared.reduce(
              (s, x) => s + (x.product.windows.m90.cost ?? 0),
              0,
            ),
            max_asset_groups_over_one_product: Math.max(...shared.map((x) => x.groups.length)),
          },
          population,
          rows: [...shared]
            .sort(
              (a, b) =>
                (b.product.windows.m90.cost ?? 0) - (a.product.windows.m90.cost ?? 0) ||
                a.product.id.localeCompare(b.product.id),
            )
            .slice(0, 10)
            .map((x) => ({
              entity: { id: x.product.id, name: x.product.attrs.title ?? x.product.id },
              cells: { asset_groups: x.groups.length, spend: x.product.windows.m90.cost ?? 0 },
            })),
          note: "the cost is the campaign competing with itself, not a countable sum",
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };
    if (unknown.length > 0)
      return {
        state: "not_checkable",
        reason: `the product selection of ${namesOf(unknown)} splits on product type, category, condition or channel, which cannot be matched to products exactly`,
        table: "pmaxListingGroups",
        category: "our_gap",
      };
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no live Performance Max campaign has two or more live asset groups to overlap",
        table: "assetGroups",
        category: "nothing_to_compare",
      };
    return { state: "none_found", population };
  },
});

/** The products Shopping campaigns take are read from their feed label, not their product groups. */
const SHOPPING_SIDE_LIMIT =
  "A Shopping campaign's product groups are not read: its products come from its feed label, so a product excluded in its product groups is still counted here.";

const SH12_TABLES: string[] = ["products", "pmaxListingGroups", "shoppingSettings"];

const SH12 = defineCheck({
  id: "SH12",
  claimKey: CLAIM_KEYS.SHOPPING_ITEM_OVERLAP_WITH_PMAX,
  title: "the same item is bought by a Shopping campaign and a PMax campaign",
  clientLabel: "products sold by both a Shopping and a Performance Max campaign",
  group: "cross_tree",
  metrics: ["Pr.spend", "Sh.feed_label"],
  confounders: ["SH15", "SH17", "PX05"],
  requires: SH12_TABLES,
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No item is buyable by a Shopping campaign and a PMax campaign at the same time.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, SH12_TABLES);
    if (gate) return gate;
    const shopping = campaignsOf(ctx).filter((c) => c.attrs.type === "SHOPPING");
    const pmax = pmaxCampaigns(ctx);
    if (shopping.length === 0 || pmax.length === 0)
      return {
        state: "not_checkable",
        reason: `the overlap needs both kinds: ${shopping.length} Shopping and ${pmax.length} Performance Max campaigns`,
        table: "campaigns",
        category: "not_present",
      };
    const unresolved = shopping.filter((c) => c.attrs.shoppingSettings.state !== "synced");
    if (unresolved.length > 0)
      return {
        state: "not_checkable",
        reason: `the Shopping settings of ${unresolved.length} of ${shopping.length} Shopping campaigns were not read, so the products they can sell are unknown`,
        table: "shoppingSettings",
        category: "our_gap",
      };
    // live campaigns only: a paused or removed campaign buys nothing, so it overlaps nothing
    const liveIds = new Set([...shopping, ...pmax].map((c) => c.id));
    const liveOf = (ids: readonly string[]) => ids.filter((id) => liveIds.has(id));
    // M7 (K12): a brand campaign may sell the same items as a non-brand campaign;
    // only overlap between non-brand campaigns counts.
    const brandIds = new Set(
      [...shopping, ...pmax].filter((c) => c.attrs.layerRole === "brand").map((c) => c.id),
    );
    const faultOf = (ids: readonly string[]) => liveOf(ids).filter((id) => !brandIds.has(id));
    // B8/N5: only products that can show are counted, overlap and population alike: an
    // out-of-stock size or a product Google holds back is bought by neither campaign
    const byId = ctx.model.index.productsById;
    const showable = (productId: string) => {
      const p = byId.get(productId);
      return p == null || canShowProduct(p);
    };
    const overlap = ctx.model.index.itemOverlap
      .filter((o) => showable(o.productId))
      .map((o) => ({
        ...o,
        pmaxCampaignIds: faultOf(o.pmaxCampaignIds),
        shoppingCampaignIds: faultOf(o.shoppingCampaignIds),
      }))
      .filter((o) => o.pmaxCampaignIds.length > 0 && o.shoppingCampaignIds.length > 0);
    const population = ctx.model.children.products.filter(
      (p) =>
        canShowProduct(p) &&
        (liveOf(p.attrs.pmaxCampaignIds).length > 0 ||
          liveOf(p.attrs.shoppingCampaignIds).length > 0),
    ).length;
    if (overlap.length === 0) {
      // a Shopping campaign selling by a feed label we cannot match, or a PMax selection on an
      // inexact split, leaves its products unknown: never "no overlap"
      const inexact = pmax.flatMap((c) => liveAssetGroupsOf(c)).filter((g) => !selectionExact(g));
      const unmatched = shopping.filter((c) =>
        c.notCheckable.some((n) => n.checkId === "shopping.products"),
      );
      if (inexact.length > 0 || unmatched.length > 0)
        return {
          state: "not_checkable",
          reason: `the products of ${unmatched.length > 0 ? `the Shopping campaign(s) ${namesOf(unmatched.map((c) => c.name))} (a feed label products are not matched on)` : ""}${unmatched.length > 0 && inexact.length > 0 ? " and of " : ""}${inexact.length > 0 ? `${inexact.length} asset group(s) splitting on product type, category, condition or channel` : ""} cannot be matched exactly, so whether they overlap cannot be shown`,
          table: "pmaxListingGroups",
          category: "our_gap",
        };
      return { state: "none_found", population };
    }
    const items = overlap
      .map((o) => byId.get(o.productId) ?? null)
      .filter((p): p is NonNullable<typeof p> => p != null)
      .sort(
        (a, b) => (b.windows.m90.cost ?? 0) - (a.windows.m90.cost ?? 0) || a.id.localeCompare(b.id),
      );
    const cite: MetricValue[] = [];
    if (items[0]) cite.push(ctx.get("Pr.spend", { productId: items[0].id }));
    for (const c of shopping) cite.push(ctx.get("Sh.feed_label", { campaignId: c.id }));
    return {
      state: "fires",
      findings: [
        {
          ...finding({
            claimKey: CLAIM_KEYS.SHOPPING_ITEM_OVERLAP_WITH_PMAX,
            scope: {
              type: "product",
              id: null,
              name: `${overlap.length} of ${population} items that can show`,
            },
            cite: cite.filter((v) => isOk(v)),
            facts: {
              overlapping_items: overlap.length,
              items_that_can_show: population,
              shopping_campaigns: new Set(overlap.flatMap((o) => o.shoppingCampaignIds)).size,
              pmax_campaigns: new Set(overlap.flatMap((o) => o.pmaxCampaignIds)).size,
            },
            population,
            rows: items.slice(0, 10).map((p) => ({
              entity: { id: p.id, name: p.attrs.title ?? p.id },
              cells: {
                shopping_campaigns: liveOf(p.attrs.shoppingCampaignIds).length,
                pmax_campaigns: liveOf(p.attrs.pmaxCampaignIds).length,
                spend: p.windows.m90.cost ?? 0,
              },
            })),
          }),
          limitedBy: [SHOPPING_SIDE_LIMIT],
        },
      ],
    };
  },
});

/** Cross-tree checks. */
export const CROSS_TREE_CHECKS: CheckDefinition[] = [SK23, PX11, PX12, SH12];
