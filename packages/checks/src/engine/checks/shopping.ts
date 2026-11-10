// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Shopping and feed: SH01-SH11, SH22-SH24, SH26-SH29. SH12 lives in crossTree.ts and
 * SH13-SH21 in carriedIn.ts.
 *
 * Products come from Google Ads' own product list (each product's status, labels
 * and type as Google Ads sees the linked Merchant Center feed) and its product
 * reports. Merchant Center's own screens (account issues, promotions, shipping,
 * return policies, price benchmarks) are not part of the Google Ads API: the checks
 * that need them report "not run" with that reason, never clean.
 *
 * Every number comes from the metric registry through `ctx.get` or straight from a
 * product node; a check reports the signal and its evidence and stops (severity,
 * money and confounders happen downstream).
 */
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import {
  colourKeyItems,
  groupByModelColour,
  groupByParentProduct,
  keyHasColour,
  merchantCenterLimit,
  modelColourKeys,
  outsideMerchantCenterRead,
  parentProductKey,
  type ProductNode,
  variantGroupName,
} from "../model/nodes/ProductNode.js";
import type { CampaignNode, CampaignProductPerfRow } from "../model/nodes/CampaignNode.js";
import type { MetricPayload, MetricValue } from "../registry/types.js";
import { PRODUCT_WASTE } from "../registry/thresholds.js";
import { isReportable, liveAssetGroupsOf } from "../registry/entityStatus.js";
import { groupsSelect, type ListingItem } from "../shared/pmaxRules.js";
import { formatMoney } from "../shared/currencyScale.js";
import { BREAK_EVEN_NOT_PRICED } from "../scoring/impact.js";
import { foldBrandText } from "../shared/campaignClassification.js";
import {
  campaignsOf,
  type CheckCtx,
  type CheckDefinition,
  type CheckFinding,
  type CheckResult,
  type CheckScope,
  defineCheck,
  type EvidenceRow,
  finding,
  gateOnData,
  isOk,
  MERCHANT_CENTER_NOT_READ,
  num,
  str,
  wasteFloorReason,
} from "./types.js";

export { MERCHANT_CENTER_NOT_READ };

/**
 * The gate of a check that needs Merchant Center's own data: when a table was skipped with
 * the note above, the one shared reason; otherwise the normal read gate.
 */
export function merchantCenterGate(ctx: CheckCtx, tables: string[]): CheckResult | null {
  const notRead = tables.some((t) => {
    const m = ctx.metrics.markers.get(t);
    return m?.status === "skipped" && (m.message ?? "").includes(MERCHANT_CENTER_NOT_READ);
  });
  if (notRead)
    return {
      state: "not_checkable",
      reason: `it needs Merchant Center's own data, which is not read: ${MERCHANT_CENTER_NOT_READ}`,
      category: "our_gap",
    };
  return gateOnData(ctx, tables);
}

/** Account scope, used by every account-level check here. */
export const ACCOUNT_SCOPE: CheckScope = { type: "account", id: null, name: null };

/** Rows a list finding names (the reply shows the first ten and "N more"). */
export const LIST_ROWS = 10;

/** A finding's limit, spread onto it; nothing when there is no limit. */
function limitOf(limits: string[]): { limitedBy?: string[] } {
  return limits.length > 0 ? { limitedBy: limits } : {};
}

/** Products with their own product row (spend and labels), not only a status-list row. */
export function feedProducts(ctx: CheckCtx): ProductNode[] {
  return ctx.model.children.products.filter((p) => p.attrs.primarySource === "products");
}

/** One named row per product, the biggest spender first. */
export function productRows(
  ps: readonly ProductNode[],
  cells: (p: ProductNode) => EvidenceRow["cells"],
): EvidenceRow[] {
  return [...ps]
    .sort(
      (a, b) => (b.windows.m90.cost ?? 0) - (a.windows.m90.cost ?? 0) || a.id.localeCompare(b.id),
    )
    .slice(0, LIST_ROWS)
    .map((p) => ({ entity: { id: p.id, name: p.attrs.title ?? p.id }, cells: cells(p) }));
}

/**
 * SH15's test, run where a feed-health rate is stated: the three ways of counting the
 * feed's health (feed diagnostics, Merchant Center statuses, Google Ads statuses) must
 * not contradict each other. Feed diagnostics are Merchant Center data, so on a snapshot
 * this never blocks; an input that carries them is held to it.
 */
function feedSourceDisagreement(ctx: CheckCtx): string | null {
  const mc = ctx.model.attrs.merchantCenter.feeds;
  const products = feedProducts(ctx);
  const approved = products.filter((p) => p.attrs.mcStatus === "approved").length;
  const eligible = ctx.model.children.products.filter(
    (p) => p.attrs.shopping?.status === "ELIGIBLE",
  ).length;
  const diagnosticsValid =
    mc.itemsTotal == null || mc.itemsInvalid == null ? null : mc.itemsTotal - mc.itemsInvalid;
  if (diagnosticsValid === 0 && (approved > 0 || eligible > 0))
    return `feed diagnostics say none of ${mc.itemsTotal} items is valid while ${approved} products are approved and ${eligible} can show in Google Ads: the feed sources disagree, so no feed-health rate is stated`;
  return null;
}

/** No product served: the account sells nothing through a linked feed in the window. */
export const NO_PRODUCTS: CheckResult = {
  state: "not_checkable",
  reason: "no product served in the window (no linked Merchant Center products, or none showed)",
  table: "products",
  category: "not_present",
};

/**
 * A product's statuses, one per feed row read (an item in two country feeds has two);
 * a product without feed rows has its one status.
 */
export function feedStatusesOf(p: ProductNode): FeedStatus[] {
  const feeds = p.attrs.feeds;
  if (feeds !== undefined && feeds.length > 0)
    return feeds.map((f) => ({
      status: f.status,
      feedLabel: f.feedLabel,
      merchantId: f.merchantId,
      availability: f.availability ?? null,
      issueCodes: f.issueCodes ?? null,
    }));
  return [
    {
      status: p.attrs.shopping?.status ?? null,
      feedLabel: null,
      merchantId: null,
      availability: null,
      issueCodes: null,
    },
  ];
}

/** One feed row's status, with its stock state and blocking issue codes (null = not read). */
export interface FeedStatus {
  status: string | null;
  feedLabel: string | null;
  merchantId: string | null;
  availability: string | null;
  issueCodes: string[] | null;
}

/** Google's issue code for an item that is out of stock. */
const OUT_OF_STOCK_CODE = "not_eligible_out_of_stock";

/** Whether a feed row is sold out: its stock state or Google's out-of-stock code (not read = no). */
export function soldOutRow(f: FeedStatus): boolean {
  return f.availability === "OUT_OF_STOCK" || (f.issueCodes ?? []).includes(OUT_OF_STOCK_CODE);
}

/**
 * Why a feed row cannot show, in Google's own terms:
 * - not_advertised: no live campaign advertises it here (Google's not_eligible_* codes: in no
 *   campaign, left out of a listing group, its asset group or ad group paused ...);
 * - out_of_stock: advertised, but sold out (a size or colour);
 * - blocked: advertised and in stock, but disapproved or held back by a feed problem;
 * - reason_not_read: the issues were not read (an older snapshot).
 * null = it can show. The shopping reader joins a product's campaigns by the same rule.
 */
export type CannotShowReason = "not_advertised" | "out_of_stock" | "blocked" | "reason_not_read";

export function cannotShowReason(f: FeedStatus): CannotShowReason | null {
  if (f.status !== NOT_ELIGIBLE) return null;
  const codes = f.issueCodes;
  if (codes == null) return "reason_not_read";
  if (codes.some((c) => c.startsWith("not_eligible_") && c !== OUT_OF_STOCK_CODE))
    return "not_advertised";
  // a feed error (ERROR severity, not a not_eligible_* code) blocks the row even when it is also
  // sold out: restocking alone would not let it show
  if (codes.some((c) => !c.startsWith("not_eligible_"))) return "blocked";
  if (f.availability === "OUT_OF_STOCK" || codes.includes(OUT_OF_STOCK_CODE)) return "out_of_stock";
  return "blocked";
}

/**
 * Whether a product can show in any feed: an item every one of whose read statuses is
 * NOT_ELIGIBLE cannot. A product with no status read is kept (unknown is not "cannot show").
 * Overlap counts (SH12) are over these.
 */
export function canShowProduct(p: ProductNode): boolean {
  const known = feedStatusesOf(p).filter((f) => f.status != null && f.status !== "UNSPECIFIED");
  return known.length === 0 || known.some((f) => f.status !== NOT_ELIGIBLE);
}

/** A live Shopping or Performance Max campaign's Merchant Center account and feed label ("" = every label). */
export interface Seller {
  merchantId: string;
  feedLabel: string;
}

/**
 * A campaign's Merchant Center account and feed label. "none" = it sells no products (a PMax
 * without a feed); null = its Shopping settings were not read.
 */
export function sellerOf(c: CampaignNode): Seller | "none" | null {
  const ss = c.attrs.shoppingSettings;
  if (ss.state !== "synced") return null;
  if (ss.merchantId == null) return "none";
  return { merchantId: ss.merchantId, feedLabel: (ss.feedLabel ?? "").toLowerCase() };
}

/**
 * The live Shopping and Performance Max campaigns that sell from a Merchant Center account.
 * [] = none sells products; null = a live one's Shopping settings were not read.
 */
function liveSellers(ctx: CheckCtx): Seller[] | null {
  const live = campaignsOf(ctx).filter(
    (c) => c.attrs.type === "SHOPPING" || c.attrs.type === "PERFORMANCE_MAX",
  );
  const sellers: Seller[] = [];
  for (const c of live) {
    const s = sellerOf(c);
    if (s === null) return null;
    if (s === "none") continue;
    sellers.push(s);
  }
  return sellers;
}

/**
 * Whether a feed row is one of these campaigns can serve: its Merchant Center account and
 * feed label (an empty label = every label; a row with no label or account read is kept). A
 * Merchant Center shared with other accounts holds feeds this account never serves.
 */
export function servedBy(
  sellers: readonly Seller[],
): (f: { feedLabel: string | null; merchantId: string | null }) => boolean {
  return (f) =>
    sellers.some(
      (s) =>
        (f.merchantId == null || f.merchantId === s.merchantId) &&
        (s.feedLabel === "" || f.feedLabel == null || f.feedLabel.toLowerCase() === s.feedLabel),
    );
}

/** A product's statuses across its feeds, for a row cell ("ELIGIBLE, NOT_ELIGIBLE"). */
export function statusCell(p: ProductNode | undefined): string {
  const all = p ? feedStatusesOf(p).map((s) => s.status ?? "unknown") : [];
  return all.length === 0 ? "unknown" : [...new Set(all)].join(", ");
}

/** Google Ads' product status that means "cannot show in ads". */
const NOT_ELIGIBLE = "NOT_ELIGIBLE";

// ---------------------------------------------------------------------------
// SH01 — products Google Ads cannot show
// ---------------------------------------------------------------------------

/** The reasons in plain words, for a row cell. */
const REASON_WORDS: Record<CannotShowReason, string> = {
  not_advertised: "not in any live campaign",
  out_of_stock: "out of stock",
  blocked: "disapproved or held back by a feed problem",
  reason_not_read: "reason not read",
};

const SH01 = defineCheck({
  id: "SH01",
  claimKey: CLAIM_KEYS.FEED_DISAPPROVAL_RATE,
  title: "products Google Ads cannot show",
  clientLabel: "the share of your advertised products Google Ads cannot show",
  group: "shopping",
  metrics: ["DQ.population[table]"],
  confounders: ["SH15", "SH02", "SH06"],
  requires: ["shoppingProductsData"],
  impactFormula: "IMP_MEASUREMENT",
  noneFoundMeans: "Nearly every product a live campaign advertises can show in your ads.",
  run(ctx: CheckCtx): CheckResult {
    // a Merchant Center shared with other accounts holds products this account never serves:
    // with no live campaign selling products, none of them can show here
    const sellers = liveSellers(ctx);
    if (sellers !== null && sellers.length === 0)
      return {
        state: "not_checkable",
        reason: "no live Shopping or Performance Max campaign sells products",
        table: "shoppingProductsData",
        category: "not_present",
      };
    const g = gateOnData(ctx, ["shoppingProductsData"]);
    if (g) return g;
    const disagreement = feedSourceDisagreement(ctx);
    if (disagreement)
      return {
        state: "not_checkable",
        reason: disagreement,
        table: "feedDiagnostics",
        category: "incomplete_data",
      };
    // the whole product list Google Ads holds, served or not, counted per feed row: an item
    // in a US and a CA feed is two rows, and it can be blocked in one feed and not the other.
    // Only the feeds a live campaign of this account can serve: a shared Merchant Center's
    // other feeds cannot show here by design
    // (settings not read: every feed row)
    const served = sellers === null ? null : servedBy(sellers);
    const withStatus = ctx.model.children.products.flatMap((p) =>
      feedStatusesOf(p)
        .filter((st) => st.status != null && st.status !== "UNSPECIFIED")
        .filter((st) => served === null || served(st))
        .map((st) => ({ p, ...st })),
    );
    if (withStatus.length === 0)
      return {
        state: "not_checkable",
        reason:
          served === null
            ? "no product carries a Google Ads status (no linked Merchant Center products)"
            : "no product a live Shopping or Performance Max campaign can serve carries a Google Ads status",
        table: "shoppingProductsData",
        category: "not_present",
      };
    // B8: a feed row cannot show for one of four reasons. Only the rows a live campaign
    // advertises make the share: a product no live campaign is set up to advertise, or a
    // sold-out size, is not a feed fault, so each is a separate count beside it
    const byReason = (reason: CannotShowReason) =>
      withStatus.filter((r) => cannotShowReason(r) === reason);
    const notAdvertised = byReason("not_advertised");
    const outOfStock = byReason("out_of_stock");
    const blockedRows = byReason("blocked");
    const unread = byReason("reason_not_read");
    const advertised = withStatus.length - notAdvertised.length;
    const counts = {
      feed_rows_advertised: advertised,
      feed_rows_cannot_show: blockedRows.length + unread.length,
      feed_rows_disapproved: blockedRows.length,
      ...(unread.length > 0 ? { feed_rows_reason_not_read: unread.length } : {}),
      feed_rows_out_of_stock: outOfStock.length,
      feed_rows_not_in_live_campaign: notAdvertised.length,
      feed_rows_with_status: withStatus.length,
    };
    const sideNote = `${outOfStock.length} more are out of stock (sold-out sizes or colours); ${notAdvertised.length} of ${withStatus.length} feed rows are not in any live campaign`;
    if (advertised === 0)
      return {
        state: "not_checkable",
        reason: `no product feed row is advertised by a live campaign (${notAdvertised.length} of ${withStatus.length} are not in any live campaign)`,
        table: "shoppingProductsData",
        category: "not_present",
      };
    const cannotShow = [...blockedRows, ...unread];
    const rate = (cannotShow.length / advertised) * 100;
    const bar = ctx.settings.shopping.disapprovedMaxPct;
    if (rate <= bar)
      return {
        state: "none_found",
        population: advertised,
        note: `${cannotShow.length} of ${advertised} product feed rows a live campaign advertises cannot show (${rate.toFixed(2)}%); ${sideNote}`,
      };
    const blockedProducts = [...new Set(cannotShow.map((r) => r.p))];
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.FEED_DISAPPROVAL_RATE,
          scope: ACCOUNT_SCOPE,
          cite: [ctx.get("DQ.population[table]", { table: "shoppingProductsData" })].filter(isOk),
          facts: {
            ...counts,
            products_cannot_show: blockedProducts.length,
            cannot_show_pct: Number(rate.toFixed(2)),
            bar_pct: bar,
          },
          population: advertised,
          rows: productRows(blockedProducts, (p) => {
            const mine = cannotShow.filter((r) => r.p === p);
            return {
              status: NOT_ELIGIBLE,
              reason: [...new Set(mine.map((r) => REASON_WORDS[cannotShowReason(r)!]))].join(", "),
              // the feeds the product cannot show in ("" = no feed label)
              feeds: mine.map((r) => r.feedLabel ?? "").join(", "),
              impressions: p.windows.m90.impressions ?? p.attrs.shopping?.impressions ?? 0,
            };
          }),
          note: `${cannotShow.length} of ${advertised} product feed rows a live campaign advertises cannot show (${rate.toFixed(2)}%); ${sideNote}`,
        }),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// SH02 — Merchant Center account issues (Merchant Center data: not read here)
// ---------------------------------------------------------------------------

const SH02 = defineCheck({
  id: "SH02",
  claimKey: CLAIM_KEYS.FEED_ACCOUNT_ISSUES,
  title: "Merchant Center account issues",
  clientLabel: "account-level issues in Merchant Center",
  group: "shopping",
  metrics: ["F.mc_issue_count"],
  confounders: ["SH01"],
  requires: ["mcAccountIssues"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No Merchant Center account issues.",
  run(ctx: CheckCtx): CheckResult {
    const g = merchantCenterGate(ctx, ["mcAccountIssues"]);
    if (g) return g;
    const v = ctx.get("F.mc_issue_count");
    if (!isOk(v))
      return {
        state: "not_checkable",
        reason: `the account issue count could not be computed: ${v.detail}`,
        table: "mcAccountIssues",
        category: "our_gap",
      };
    const n = num(v);
    if (n == null || n === 0) return { state: "none_found", population: 0 };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.FEED_ACCOUNT_ISSUES,
          scope: ACCOUNT_SCOPE,
          cite: [v],
          facts: { issue_count: n },
          population: n,
        }),
      ],
    };
  },
});

/** SH03: the products whose share of product spend is measured (the registry's top-N). */
const TOP_PRODUCTS = 10;

// ---------------------------------------------------------------------------
// SH03 — product spend concentration
// ---------------------------------------------------------------------------

const SH03 = defineCheck({
  id: "SH03",
  claimKey: CLAIM_KEYS.PRODUCT_SPEND_CONCENTRATION,
  title: "product spend concentration",
  clientLabel: "how much of your product spend sits on a handful of products",
  group: "shopping",
  metrics: ["Pr.spend_share_topN"],
  confounders: ["SH04", "PX05", "SH15"],
  requires: ["products"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Product spend is not concentrated in a handful of items.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["products"]);
    if (g) return g;
    if (feedProducts(ctx).length === 0) return NO_PRODUCTS;
    const v = ctx.get("Pr.spend_share_topN", { n: TOP_PRODUCTS });
    if (!isOk(v))
      return {
        state: "not_checkable",
        reason: `the top-10 spend share could not be computed: ${v.detail}`,
        table: "products",
      };
    const share = num(v);
    const spenders = feedProducts(ctx).filter((p) => (p.windows.m90.cost ?? 0) > 0);
    if (share == null)
      return {
        state: "not_checkable",
        reason: "the top-10 spend share is not a number",
        table: "products",
      };
    // with 10 or fewer products spending, the top 10 is every product: nothing to concentrate
    if (spenders.length <= TOP_PRODUCTS)
      return {
        state: "not_checkable",
        reason: `${spenders.length} products spent: the top ${TOP_PRODUCTS} is all of them, so there is no concentration to measure`,
        table: "products",
        category: "nothing_to_compare",
      };
    const bar = ctx.settings.shopping.topProductsSpendSharePct;
    if (share <= bar)
      return {
        state: "none_found",
        population: spenders.length,
        note: `the top 10 products carry ${share.toFixed(2)}% of product spend`,
      };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.PRODUCT_SPEND_CONCENTRATION,
          scope: ACCOUNT_SCOPE,
          cite: [v],
          facts: { top10_share_pct: share, bar_pct: bar, products_with_spend: spenders.length },
          population: spenders.length,
          rows: productRows(spenders, (p) => ({ spend: p.windows.m90.cost ?? 0 })),
        }),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// product waste per campaign (SH04 Shopping, PX05 Performance Max). Port of the
// PerfoAds app's campaignProductLosers: same groups, same bars, same legs, same numbers.
// ---------------------------------------------------------------------------

/** The campaign type a per-campaign product check judges. */
export type ProductLoserChannel = "PERFORMANCE_MAX" | "SHOPPING";

/** ROAS as a percent for a sentence; under 100% rounds DOWN (0.996 = "99%", never a "100%" loss). */
export const roasPct = (ratio: number): string =>
  `${ratio < 1 ? Math.floor(ratio * 100 + 1e-9) : Math.round(ratio * 100)}%`;

const andList = (xs: readonly string[]): string =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/**
 * a capped per-campaign product read may hide a loser. `cutoffSum` = the sum of the
 * capped reads' cutoffs (the snapshot note): the most spend a product can have outside the
 * kept rows. A kept product with no sale could reach the bar with its unseen spend, so the
 * test is cutoffSum + biggest kept zero-sale spend >= bar. Older notes (no cutoff): the
 * cheapest kept row. Pure.
 */
export function cappedReadMayHideLosers(
  truncated: boolean,
  cutoffSum: number | null,
  cheapestKept: number,
  maxKeptZeroSale: number,
  floor: number,
): boolean {
  if (!truncated) return false;
  if (cutoffSum == null) return cheapestKept >= floor;
  return cutoffSum + Math.max(0, maxKeptZeroSale) >= floor;
}

const factNum = (f: CheckFinding, key: string): number | null =>
  typeof f.facts[key] === "number" ? (f.facts[key] as number) : null;

/**
 * why the bar is what it is, in the finding's words ("more than 2x what a sale costs
 * there ($166)"). From the finding's own facts; null without a product bar.
 */
export function productBarWhy(f: CheckFinding, currency: string): string | null {
  const loss = f.facts.reason === "loses_money";
  const bar = factNum(f, loss ? "product_loss_bar" : "product_waste_bar");
  if (bar == null) return null;
  const cpa = factNum(f, "campaign_cost_per_sale");
  const multiple = loss ? PRODUCT_WASTE.lossMultiple : PRODUCT_WASTE.multiple;
  const m = (n: number) => formatMoney(n, currency);
  const times =
    multiple === 1 ? "more than what a sale costs" : `more than ${multiple}x what a sale costs`;
  const basis = f.facts.bar_basis;
  if (basis === "band" || cpa == null)
    return `past the spend floor of ${m(bar)}, because there are too few sales yet to set the bar from the cost of a sale`;
  if (bar > multiple * cpa + 0.005)
    return `past the spend floor of ${m(bar)}, which is higher than ${multiple === 1 ? "what a sale costs" : `${multiple}x what a sale costs`} ${basis === "account" ? "in the account" : "there"}`;
  return basis === "account"
    ? `${times} in the account (${m(bar)}), because this campaign has too few sales to set its own bar`
    : `${times} there (${m(bar)})`;
}

/**
 * a category finding's sentence, the category as the feed writes it and the campaign
 * exactly as Google Ads shows it: "Menswear spent $532 in <campaign> and brought $31.00 in
 * sales (ROAS 5%)" / "... with no sale". Null without its facts.
 */
export function categoryHeadline(f: CheckFinding, currency: string): string | null {
  const campaign = f.scope.campaignName;
  const category = typeof f.facts.category === "string" ? f.facts.category : null;
  const spend = factNum(f, "campaign_product_spend");
  if (!campaign || !category || spend == null) return null;
  const m = (x: number) => formatMoney(x, currency);
  const value = factNum(f, "campaign_product_sales_value") ?? 0;
  const conv = factNum(f, "conv") ?? 0;
  return conv === 0
    ? `${category} spent ${m(spend)} in ${campaign} with no sale`
    : `${category} spent ${m(spend)} in ${campaign} and brought ${m(value)} in sales (ROAS ${roasPct(value / spend)})`;
}

/**
 * the finding's sentence, one per campaign and reason: "3 products spent $835 in
 * <campaign> with no sale, each more than 2x what a sale costs there ($166)" / "2 products sell
 * in <campaign>, but lose money: ROAS 61% and 88%, each after spending ...". Names exactly as
 * Google Ads shows them, never shortened. It carries Google's names, so it rides in the facts
 * (`headline`), never in the finding's title.
 */
export function productLoserHeadline(f: CheckFinding, currency: string): string | null {
  if (f.facts.reason === "category_loses_money") return categoryHeadline(f, currency);
  const why = productBarWhy(f, currency);
  const campaign = f.scope.campaignName;
  const n = factNum(f, "products") ?? 1;
  const spend = factNum(f, "campaign_product_spend");
  if (!why || !campaign || spend == null) return null;
  const m = (x: number) => formatMoney(x, currency);
  const name = f.scope.name ?? f.scope.id ?? "This product";
  if (f.facts.reason === "loses_money") {
    const roas = Array.isArray(f.facts.product_roas)
      ? (f.facts.product_roas as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const list = andList(roas);
    return n === 1
      ? `${name} sells in ${campaign}, but its sales came to ${list} of its ad cost (ROAS ${list}) after it spent ${m(spend)}, ${why}`
      : `${n} products sell in ${campaign}, but lose money: ROAS ${list}, each after spending ${why}`;
  }
  return n === 1
    ? `${name} spent ${m(spend)} in ${campaign} with no sale, ${why}`
    : `${n} products spent ${m(spend)} in ${campaign} with no sale, each ${why}`;
}

/** The finding's own label per reason (plain words, no Google names). */
const PRODUCT_LOSER_TITLES: Readonly<Record<string, string>> = {
  no_sale: "products that spent past their campaign's bar with no sale",
  loses_money: "products that sell in their campaign but lose money (ROAS under 100%)",
  category_loses_money: "a whole category that loses money in its campaign",
};

/** The per-campaign product bar a finding is judged by, or why there is none. Pure over the metric value. */
type ProductBar =
  | { bar: number; value: MetricValue; note: string | null; basis: string; cpa: number | null }
  | { bar: null; reason: string };
function productBarFrom(v: MetricValue): ProductBar {
  if (!isOk(v)) return { bar: null, reason: v.detail };
  const val = v.value as { bar?: unknown; basis?: unknown; cpa?: unknown } | null;
  const bar = typeof val?.bar === "number" ? val.bar : NaN;
  // an unknown or infinite bar can never clear a product: could not check, never "none found"
  if (!Number.isFinite(bar) || bar <= 0)
    return { bar: null, reason: "the product bar is unknown for this campaign" };
  return {
    bar,
    value: v,
    note: v.note ?? null,
    basis: String(val?.basis ?? ""),
    cpa: typeof val?.cpa === "number" ? val.cpa : null,
  };
}

/** where a category row's name comes from. */
export type CategorySource = "product_type" | "google_category";
type CategoryRowLike = Pick<
  CampaignProductPerfRow,
  "productTypeL1" | "productTypeL2" | "categoryL1"
>;
type CategoryGroupLike = {
  key: string;
  cost: number;
  conv: number;
  value: number;
  members: readonly CategoryRowLike[];
};
/** One category that loses money in one campaign: its name (feed spelling), level and every product group in it. */
export interface CategoryLoser<G> {
  path: string;
  source: CategorySource;
  level: 1 | 2;
  groups: G[];
  cost: number;
  conv: number;
  value: number;
}

const cleanText = (x: string | null | undefined): string | null =>
  typeof x === "string" && x.trim() !== "" ? x.trim() : null;

/**
 * whole categories of ONE campaign that lose money, over its model + colour groups (the
 * same groups the product legs judge). Pure.
 *   - name: product type level 1, then level 2 under it; no product type on any row of the
 *     campaign = the Google category level 1; neither = no category row (`source: null`).
 *   - fires: 0 sales and spend >= `bar` (C.product_waste_bar), or sales with spend >=
 *     categoryMultiple x `bar` and ROAS under 100%.
 *   - a category is a row only when it holds 2+ products and is not the whole campaign.
 *   - level 1 first; a level 1 that does not fire is looked at by its level 2s.
 * A group's category is that of its top-spending size that has one.
 */
export function categoryRollup<G extends CategoryGroupLike>(
  groups: readonly G[],
  bar: number,
  multiple: number = PRODUCT_WASTE.categoryMultiple,
): { source: CategorySource | null; losers: CategoryLoser<G>[] } {
  const first = (g: G, pick: (r: CategoryRowLike) => string | null): CategoryRowLike | null =>
    g.members.find((r) => pick(r) != null) ?? null;
  const source: CategorySource | null = groups.some((g) =>
    first(g, (r) => cleanText(r.productTypeL1)),
  )
    ? "product_type"
    : groups.some((g) => first(g, (r) => cleanText(r.categoryL1)))
      ? "google_category"
      : null;
  if (source == null || !Number.isFinite(bar) || bar <= 0) return { source, losers: [] };
  const fires = (b: { cost: number; conv: number; value: number }) =>
    b.conv === 0 ? b.cost >= bar : b.cost >= multiple * bar && b.value < b.cost;
  const bucket = (list: readonly G[], nameOf: (g: G) => string | null) => {
    const out = new Map<
      string,
      { name: string; groups: G[]; cost: number; conv: number; value: number }
    >();
    for (const g of [...list].sort((a, b) => b.cost - a.cost)) {
      const name = nameOf(g);
      if (name == null) continue;
      const k = name.toLowerCase();
      const b = out.get(k) ?? out.set(k, { name, groups: [], cost: 0, conv: 0, value: 0 }).get(k)!;
      b.groups.push(g);
      b.cost += g.cost;
      b.conv += g.conv;
      b.value += g.value;
    }
    return [...out.values()];
  };
  const isPart = (b: { groups: G[] }) => b.groups.length >= 2 && b.groups.length < groups.length;
  const losers: CategoryLoser<G>[] = [];
  const l1Of = (g: G) => {
    const r =
      source === "product_type"
        ? first(g, (x) => cleanText(x.productTypeL1))
        : first(g, (x) => cleanText(x.categoryL1));
    return r == null
      ? null
      : source === "product_type"
        ? cleanText(r.productTypeL1)
        : cleanText(r.categoryL1);
  };
  for (const b1 of bucket(groups, l1Of)) {
    if (isPart(b1) && fires(b1)) {
      losers.push({
        path: b1.name,
        source,
        level: 1,
        groups: b1.groups,
        cost: b1.cost,
        conv: b1.conv,
        value: b1.value,
      });
      continue;
    }
    if (source !== "product_type") continue;
    const l2Of = (g: G) => cleanText(first(g, (x) => cleanText(x.productTypeL1))?.productTypeL2);
    for (const b2 of bucket(b1.groups, l2Of)) {
      if (isPart(b2) && fires(b2))
        losers.push({
          path: `${b1.name} > ${b2.name}`,
          source,
          level: 2,
          groups: b2.groups,
          cost: b2.cost,
          conv: b2.conv,
          value: b2.value,
        });
    }
  }
  return { source, losers: losers.sort((a, b) => b.cost - a.cost) };
}

type SyncedPerf = Extract<NonNullable<CampaignNode["attrs"]["productPerf"]>, { state: "synced" }>;
const perfOf = (c: CampaignNode) => c.attrs.productPerf as SyncedPerf;

/** One campaign's rows summed per model + colour (the groups both legs and the categories judge). */
/** One campaign's rows summed per model + colour; no Merchant Center colour = the size-stripped title (colourKeyItems). */
const productGroupsOf = (c: CampaignNode) => {
  const rows = perfOf(c).rows;
  const { items, fromTitle } = colourKeyItems(rows, (r) => ({
    id: r.offerId,
    itemGroupId: r.itemGroupId ?? null,
    color: r.color ?? null,
    // the current feed title; the performance row's saved title only when the feed has none
    title: r.feedTitle ?? r.title,
  }));
  const keyOf = new Map(rows.map((r, k) => [r, items[k]!] as const));
  const titled = new Set(rows.filter((_, k) => fromTitle[k]));
  return groupByModelColour(
    rows,
    (r) => keyOf.get(r)!,
    (r) => ({ cost: r.cost, conv: r.conv, value: r.value }),
  ).map((g) => ({ ...g, colourFromTitle: g.members.some((r) => titled.has(r)) }));
};

/** the Shopify store part of an item id ("shopify_us_"); null for any other id. */
const SHOPIFY_STORE = /^shopify_[a-z]{2,3}_/i;

/**
 * each group's sizes this campaign can show that never spent here (productPerf.unspent), by
 * the SAME model + colour grouping: the keys are worked out again over the spent rows and those
 * sizes together (current feed title, the title split only on one letter-run difference). A
 * group gets them only when that grouping leaves its key and its spent sizes exactly as they
 * were (an unspent size that changes the split, or joins another group's spent sizes, adds
 * nothing), and only sizes of the same Shopify store. Group key -> item ids.
 */
const unspentByGroup = (
  c: CampaignNode,
  groups: ReturnType<typeof productGroupsOf>,
): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  const perf = perfOf(c);
  const extra = perf.unspent ?? [];
  if (extra.length === 0) return out;
  const all = [
    ...perf.rows.map((r) => ({
      row: r as CampaignProductPerfRow | null,
      id: r.offerId,
      itemGroupId: r.itemGroupId ?? null,
      color: r.color ?? null,
      title: r.feedTitle ?? r.title,
    })),
    ...extra.map((u) => ({
      row: null,
      id: u.offerId,
      itemGroupId: u.itemGroupId,
      color: u.color,
      title: u.title,
    })),
  ];
  const keys = modelColourKeys(colourKeyItems(all, (x) => x).items);
  const spentOf = new Map<string, Set<CampaignProductPerfRow>>();
  const unspentOf = new Map<string, string[]>();
  all.forEach((x, k) => {
    const key = keys[k]!;
    if (x.row) (spentOf.get(key) ?? spentOf.set(key, new Set()).get(key)!).add(x.row);
    else (unspentOf.get(key) ?? unspentOf.set(key, []).get(key)!).push(x.id);
  });
  const keyOfRow = new Map(perf.rows.map((r, k) => [r, keys[k]!] as const));
  for (const g of groups) {
    const key = keyOfRow.get(g.members[0]!);
    if (key !== g.key) continue;
    const spent = spentOf.get(key);
    if (!spent || spent.size !== g.members.length || !g.members.every((r) => spent.has(r)))
      continue;
    const stores = new Set(
      g.members.map((r) => SHOPIFY_STORE.exec(r.offerId)?.[0]?.toLowerCase() ?? ""),
    );
    const ids = (unspentOf.get(key) ?? []).filter((id) =>
      stores.has(SHOPIFY_STORE.exec(id)?.[0]?.toLowerCase() ?? ""),
    );
    if (ids.length > 0) out.set(g.key, ids);
  }
  return out;
};

/** Where a finding's colours came from, said honestly on its facts. */
const colourSourceOf = (list: readonly { key: string; colourFromTitle: boolean }[]): string =>
  list.some((g) => g.colourFromTitle)
    ? "colour from product titles"
    : list.some((g) => keyHasColour(g.key))
      ? "colour from Merchant Center"
      : "no colour known";

/** Live campaigns of `channel` whose own product rows were read. */
const productSyncedCampaigns = (ctx: CheckCtx, channel: ProductLoserChannel): CampaignNode[] =>
  campaignsOf(ctx).filter(
    (c) => c.attrs.type === channel && isReportable(c) && c.attrs.productPerf?.state === "synced",
  );

/**
 * the parent products (parentProductKey) whose spend SH04 / PX05 price as waste in at
 * least one live Shopping or Performance Max campaign: a no-sale group at or over its
 * campaign's bar, or a no-sale group inside a category those checks price. SH20 leaves their
 * sizes unpriced so the same money is not counted twice.
 */
export function productWastePricedParents(ctx: CheckCtx): Set<string> {
  const keys = new Set<string>();
  for (const channel of ["PERFORMANCE_MAX", "SHOPPING"] as const)
    for (const c of productSyncedCampaigns(ctx, channel)) {
      const waste = productBarFrom(ctx.get("C.product_waste_bar", { campaignId: c.id }));
      if (waste.bar == null) continue;
      const groups = productGroupsOf(c);
      const inCategory = new Set(
        categoryRollup(groups, waste.bar).losers.flatMap((l) => l.groups.map((g) => g.key)),
      );
      for (const g of groups)
        if (g.conv === 0 && (g.cost >= waste.bar || inCategory.has(g.key)))
          for (const r of g.members) keys.add(parentProductKey(r.offerId));
    }
  return keys;
}

/**
 * round 2 (NEW-15): the model + colour groups of a Performance Max campaign that none of its
 * running asset groups can select with the products' CURRENT labels (product node; a size
 * with no feed row, or whose node or tree split cannot be read, counts as selectable). A group is out only when
 * every size of it is. SH20 still leaves their sizes alone (productWastePricedParents keeps
 * them), so the old spend is priced nowhere. Group keys.
 */
const ALREADY_OUT_NOTE =
  "not judged, already out: products no running asset group can select with their current labels, in";

function alreadyOutOf(
  ctx: CheckCtx,
  c: CampaignNode,
  groups: ReturnType<typeof productGroupsOf>,
): Set<string> {
  const out = new Set<string>();
  const running = liveAssetGroupsOf(c);
  if (running.length === 0) return out;
  const products = ctx.model.index.productsById;
  for (const g of groups) {
    const out1 = g.members.every((r) => {
      const item = listingItemOf(r.productId ? products.get(r.productId) : undefined);
      return item !== null && groupsSelect(running, item) === "no";
    });
    if (out1) out.add(g.key);
  }
  return out;
}

/**
 * A product's CURRENT labels as a listing tree reads them; null = no product node or no feed
 * row (its labels are blank, not known, so no tree can be said to leave it out).
 */
export function listingItemOf(p: ProductNode | undefined): ListingItem | null {
  if (!p || p.attrs.inFeed !== true) return null;
  return {
    id: p.attrs.productId,
    suffix: p.attrs.itemIdSuffix,
    customLabels: p.attrs.customLabels,
    brand: p.attrs.brand,
  };
}

/**
 * round 3 (SH20): whether NO live campaign can show the product now: every live Performance
 * Max campaign's running asset groups answer "no" with its current labels (alreadyOutOf's
 * rule) and every live Standard Shopping campaign sells from another Merchant Center account
 * or feed label (sellerOf / servedBy). Unknown anywhere (no feed row, a split on product
 * type, a group with no tree, a live campaign with no asset group read, Shopping settings not
 * read) = it can still be shown. With no live Performance Max campaign there is no tree to
 * prove it out: it can still be shown.
 */
export function noLiveCampaignCanShow(ctx: CheckCtx, p: ProductNode): boolean {
  const item = listingItemOf(p);
  if (item === null) return false;
  const live = campaignsOf(ctx).filter(isReportable);
  const pmax = live.filter((c) => c.attrs.type === "PERFORMANCE_MAX");
  if (pmax.length === 0) return false;
  // a live campaign with no asset group in our data: what it selects is not known
  if (pmax.some((c) => c.children.assetGroups.length === 0)) return false;
  if (pmax.some((c) => groupsSelect(liveAssetGroupsOf(c), item) !== "no")) return false;
  const feeds = feedStatusesOf(p);
  for (const c of live.filter((x) => x.attrs.type === "SHOPPING")) {
    const s = sellerOf(c);
    if (s === null) return false;
    if (s !== "none" && feeds.some(servedBy([s]))) return false;
  }
  return true;
}

/**
 * (port of the PerfoAds app; was pmaxProductLosers) — PX05 (PMax) and SH04 (Shopping) on
 * each campaign's own product rows. Sizes are summed per model + colour (groupByModelColour),
 * so a selling colour never hides a wasting one. Per campaign:
 *   - no sale: spend >= C.product_waste_bar (2 x the campaign's cost per sale) and 0 sales;
 *   - loses money: spend >= C.product_loss_bar (1 x it) and sales value / spend < 1.00;
 *   - a whole category that loses money (categoryRollup): its products are on its card only.
 * ONE finding per campaign and reason, every product in `rows` with its own spend (and ROAS),
 * the ids of every product and size in the facts (`member_item_ids`; `unspent_item_ids` = the
 * same model + colour's sizes the campaign can show that never spent there, unspentByGroup),
 * the sentence in `headline`. Returns null when
 * no live campaign of `channel` has its rows read. An unknown bar or a capped read that could
 * hide a product is "could not check", never "none found".
 */
export function campaignProductLosers(
  ctx: CheckCtx,
  channel: ProductLoserChannel,
  claimKey: string,
): CheckResult | null {
  const live = campaignsOf(ctx).filter((c) => c.attrs.type === channel && isReportable(c));
  const synced = productSyncedCampaigns(ctx, channel);
  if (synced.length === 0) return null;
  const currency = ctx.currency.currency;
  const truncated = synced.some((c) => perfOf(c).truncated);
  // a capped read keeps the top rows by cost: the note's cutoff sum is the most spend a product
  // can have outside them (one note per snapshot, so every campaign carries the same sum)
  const cheapestKept = Math.min(
    ...synced.flatMap((c) => perfOf(c).rows.map((r) => r.cost)),
    Infinity,
  );
  const cutoffs = synced
    .map((c) => perfOf(c).cutoffCost)
    .filter((x): x is number => typeof x === "number");
  const cutoff = cutoffs.length > 0 ? Math.max(...cutoffs) : null;
  const findings: CheckFinding[] = [];
  let population = 0;
  let rowsSeen = 0;
  let rowsWithColour = 0;
  const unjudged: string[] = [];
  /** campaigns with products their running asset groups can no longer select, and how many */
  const alreadyOut: string[] = [];
  const categorySources: Array<CategorySource | null> = [];
  const judged: Array<{
    c: CampaignNode;
    bar: number;
    lossBar: number;
    hidesNoSale: boolean;
    hidesLoss: boolean;
    hidesCategory: boolean;
  }> = [];
  const m = (n: number) => formatMoney(n, currency);
  for (const c of synced) {
    const perf = perfOf(c);
    const waste = productBarFrom(ctx.get("C.product_waste_bar", { campaignId: c.id }));
    const loss = productBarFrom(ctx.get("C.product_loss_bar", { campaignId: c.id }));
    if (waste.bar == null || loss.bar == null) {
      unjudged.push(
        `${c.name} (${waste.bar == null ? waste.reason : (loss as { reason: string }).reason})`,
      );
      continue;
    }
    population += perf.rows.length;
    rowsSeen += perf.rows.length;
    const allGroups = productGroupsOf(c);
    const unspent = unspentByGroup(c, allGroups);
    // round 2 (NEW-15): a product whose current labels no running asset group of this
    // Performance Max campaign can select is already out of it (tagged "exclude" since):
    // its old spend is no longer money to save, so it is not judged here
    const outNow = channel === "PERFORMANCE_MAX" ? alreadyOutOf(ctx, c, allGroups) : new Set();
    const groups = allGroups.filter((g) => !outNow.has(g.key));
    if (outNow.size > 0) alreadyOut.push(`${c.name} (${outNow.size})`);
    rowsWithColour += groups
      .filter((g) => g.colourFromTitle || keyHasColour(g.key))
      .reduce((n, g) => n + g.members.length, 0);
    type Group = (typeof groups)[number];
    const unspentIdsOf = (list: readonly Group[]) => list.flatMap((g) => unspent.get(g.key) ?? []);
    // whole categories that lose money here; their products are listed on the category card
    // only (folded), never on a product card of the same campaign as well
    const categories = categoryRollup(groups, waste.bar);
    const folded = new Set(categories.losers.flatMap((l) => l.groups.map((g) => g.key)));
    const noSale = groups
      .filter((g) => !folded.has(g.key) && g.conv === 0 && g.cost >= waste.bar)
      .sort((a, b) => b.cost - a.cost);
    const losing = groups
      .filter((g) => !folded.has(g.key) && g.conv > 0 && g.cost >= loss.bar && g.value / g.cost < 1)
      .sort((a, b) => b.cost - a.cost);
    const maxKeptZeroSale = Math.max(0, ...groups.filter((g) => g.conv === 0).map((g) => g.cost));
    // a kept selling product under the loss bar could pass it with its unseen spend, and its
    // sales could then be under its cost; a product hidden entirely under the cap could itself
    // pass the loss bar (cutoff >= loss bar)
    const hidesLoss =
      (truncated && cutoff != null && cutoff >= loss.bar) ||
      groups.some(
        (g) =>
          g.conv > 0 &&
          !losing.includes(g) &&
          !folded.has(g.key) &&
          cappedReadMayHideLosers(truncated, cutoff, cheapestKept, g.cost, loss.bar) &&
          (cutoff == null || g.value < g.cost + cutoff),
      );
    // a capped read can hide any number of a category's products: its categories are never cleared
    const hidesCategory = truncated && categories.source != null;
    categorySources.push(categories.source);
    judged.push({
      c,
      bar: waste.bar,
      lossBar: loss.bar,
      hidesNoSale: cappedReadMayHideLosers(
        truncated,
        cutoff,
        cheapestKept,
        maxKeptZeroSale,
        waste.bar,
      ),
      hidesLoss,
      hidesCategory,
    });
    const nameOfGroup = (g: Group) => {
      const top = g.members[0]!;
      return variantGroupName(top.title ?? top.offerId, g.members.length, keyHasColour(g.key));
    };
    const idOfGroup = (g: Group) => g.members[0]!.productId ?? g.members[0]!.offerId;
    const clicksOf = (list: readonly Group[]) =>
      list.reduce((n, g) => n + g.members.reduce((t, r) => t + r.clicks, 0), 0);
    const finish = (f: CheckFinding, reason: string): CheckFinding => {
      const headline = productLoserHeadline(f, currency);
      f.title = PRODUCT_LOSER_TITLES[reason];
      if (headline) f.facts.headline = headline;
      return f;
    };
    for (const cat of categories.losers) {
      const list = cat.groups;
      const top = list[0]!.members[0]!;
      const total = Number(cat.cost.toFixed(2));
      const value = Number(cat.value.toFixed(2));
      const scope: CheckScope = {
        type: "product",
        id: top.productId ?? top.offerId,
        name: cat.path,
        campaignId: c.id,
        campaignName: c.name,
      };
      const rows: EvidenceRow[] = list.map((g) => ({
        entity: { id: idOfGroup(g), name: nameOfGroup(g) },
        cells: {
          campaign_product_spend: Number(g.cost.toFixed(2)),
          campaign_product_sales_value: Number(g.value.toFixed(2)),
          return_on_ad_spend: roasPct(g.cost > 0 ? g.value / g.cost : 0),
          sizes: g.members.length,
        },
      }));
      // the spend of its no-sale products is wasted money (priced like the no-sale leg)
      const noSaleSpend = Number(
        list
          .filter((g) => g.conv === 0)
          .reduce((n, g) => n + g.cost, 0)
          .toFixed(2),
      );
      const shared: Record<string, MetricPayload> = {
        reason: "category_loses_money",
        category: cat.path,
        category_source: cat.source,
        category_level: cat.level,
        products: list.length,
        variants: list.reduce((n, g) => n + g.members.length, 0),
        one_colour: list.every((g) => keyHasColour(g.key)),
        colour_source: colourSourceOf(list),
        product_ids: list.map((g) => g.members[0]!.offerId),
        member_item_ids: list.flatMap((g) => g.members.map((r) => r.offerId)),
        unspent_item_ids: unspentIdsOf(list),
        campaign_product_spend: total,
        campaign_product_sales_value: value,
        campaign_product_roas: total > 0 ? Number((value / total).toFixed(4)) : 0,
        clicks: clicksOf(list),
        campaign_type: channel,
        product_waste_bar: waste.bar,
        category_bar: Number((PRODUCT_WASTE.categoryMultiple * waste.bar).toFixed(2)),
        waste_floor: waste.bar,
        bar_basis: waste.basis,
        ...(waste.cpa != null ? { campaign_cost_per_sale: waste.cpa } : {}),
      };
      const base = finding({
        claimKey,
        scope,
        cite: [waste.value],
        entity: { id: scope.id ?? null, name: cat.path },
        rows,
        population: perf.rows.length,
        facts:
          cat.conv === 0
            ? { ...shared, wasted_cost_90d: total, "Pr.spend": total, conv: 0 }
            : noSaleSpend > 0
              ? // sales elsewhere in it: the no-sale part is still wasted money
                {
                  ...shared,
                  below_break_even: true,
                  shortfall_cost_90d: Number((total - value).toFixed(2)),
                  conv: Number(cat.conv.toFixed(2)),
                  wasted_cost_90d: noSaleSpend,
                  "Pr.spend": noSaleSpend,
                  category_no_sale_spend: noSaleSpend,
                }
              : // every product in it sells: real orders, the shortfall is margin at risk
                {
                  ...shared,
                  below_break_even: true,
                  shortfall_cost_90d: Number((total - value).toFixed(2)),
                  conv: Number(cat.conv.toFixed(2)),
                  [BREAK_EVEN_NOT_PRICED]: 1,
                },
        note: `category ${cat.path} (${cat.source === "product_type" ? `product type level ${cat.level}` : "Google category level 1"}) inside ${c.name}: ${list.length} products, ${m(total)} spent, ${m(value)} in sales; ${list.map((g) => `${nameOfGroup(g)} ${m(g.cost)}`).join("; ")}; ${waste.note ?? `bar ${waste.bar.toFixed(2)}`}`,
      });
      // a product losing money is never an "opportunity": warning when the shortfall is real money
      findings.push(
        finish(
          cat.conv === 0 || noSaleSpend > 0 ? base : { ...base, maxSeverity: "warning" },
          "category_loses_money",
        ),
      );
    }
    for (const [reason, list, bar] of [
      ["no_sale", noSale, waste],
      ["loses_money", losing, loss],
    ] as const) {
      if (list.length === 0) continue;
      const top = list[0]!.members[0]!;
      const total = Number(list.reduce((s, g) => s + g.cost, 0).toFixed(2));
      const value = Number(list.reduce((s, g) => s + g.value, 0).toFixed(2));
      const conv = list.reduce((s, g) => s + g.conv, 0);
      const scopeName = list.length === 1 ? nameOfGroup(list[0]!) : `${list.length} products`;
      const scope: CheckScope = {
        type: "product",
        id: top.productId ?? top.offerId,
        name: scopeName,
        campaignId: c.id,
        campaignName: c.name,
      };
      const shared: Record<string, MetricPayload> = {
        reason,
        products: list.length,
        variants: list.reduce((s, g) => s + g.members.length, 0),
        one_colour: list.every((g) => keyHasColour(g.key)),
        colour_source: colourSourceOf(list),
        product_ids: list.map((g) => g.members[0]!.offerId),
        member_item_ids: list.flatMap((g) => g.members.map((r) => r.offerId)),
        unspent_item_ids: unspentIdsOf(list),
        campaign_product_spend: total,
        clicks: clicksOf(list),
        campaign_type: channel,
        bar_basis: bar.basis,
        ...(bar.cpa != null ? { campaign_cost_per_sale: bar.cpa } : {}),
      };
      // every product with its own spend (and ROAS on the loss leg), all of them
      const rows: EvidenceRow[] = list.map((g) => ({
        entity: { id: idOfGroup(g), name: nameOfGroup(g) },
        cells:
          reason === "no_sale"
            ? { campaign_product_spend: Number(g.cost.toFixed(2)), sizes: g.members.length }
            : {
                campaign_product_spend: Number(g.cost.toFixed(2)),
                campaign_product_sales_value: Number(g.value.toFixed(2)),
                return_on_ad_spend: roasPct(g.value / g.cost),
                sizes: g.members.length,
              },
      }));
      const base = finding({
        claimKey,
        scope,
        cite: [bar.value],
        entity: { id: scope.id ?? null, name: scopeName },
        rows,
        population: perf.rows.length,
        facts:
          reason === "no_sale"
            ? // 'Pr.spend' = THIS campaign's cost for the listed products, so IMP_WASTE_90 prices
              // the finding, never the products' whole-account spend
              {
                ...shared,
                wasted_cost_90d: total,
                "Pr.spend": total,
                conv: 0,
                waste_floor: bar.bar,
                product_waste_bar: bar.bar,
              }
            : // the loss leg: real orders, so never priced as waste; the money is the shortfall
              {
                ...shared,
                below_break_even: true,
                campaign_product_sales_value: value,
                campaign_product_roas: Number((value / total).toFixed(4)),
                product_roas: list.map((g) => roasPct(g.value / g.cost)),
                shortfall_cost_90d: Number((total - value).toFixed(2)),
                conv: Number(conv.toFixed(2)),
                waste_floor: bar.bar,
                product_loss_bar: bar.bar,
                [BREAK_EVEN_NOT_PRICED]: 1,
              },
        note: `${list.length} product(s) ${reason === "no_sale" ? "with no sale" : "selling for less than they cost"} inside ${c.name}: ${list.map((g) => `${nameOfGroup(g)} ${m(g.cost)}`).join("; ")} (per-campaign product rows, sizes summed by ${list.every((g) => keyHasColour(g.key)) ? "model and colour" : "product where no colour is known"}); ${bar.note ?? `bar ${bar.bar.toFixed(2)}`}`,
      });
      // a product losing money is never an "opportunity": warning when the shortfall is real money
      findings.push(
        finish(reason === "no_sale" ? base : { ...base, maxSeverity: "warning" }, reason),
      );
    }
  }
  const unsynced = live.filter((c) => c.attrs.productPerf?.state !== "synced").map((c) => c.name);
  const what = channel === "SHOPPING" ? "Shopping" : "Performance Max";
  if (findings.length === 0) {
    if (unjudged.length > 0)
      return {
        state: "not_checkable",
        reason: `could not check the products in ${unjudged.join("; ")}: there is no money bar to judge them by`,
        table: "derived",
        category: "our_gap",
      };
    // a dropped row could take a kept product past a bar: losers may sit past the cap
    const hidden = judged.filter((j) => j.hidesNoSale || j.hidesLoss || j.hidesCategory);
    if (hidden.length > 0)
      return {
        state: "not_checkable",
        reason: `some products may be missing: the account has too many products to read in full, and the spend we could not see could take a product past the bar in ${hidden
          .map((j) =>
            j.hidesNoSale
              ? `${j.c.name} (${j.bar.toFixed(2)})`
              : j.hidesLoss
                ? `${j.c.name} (loss bar ${j.lossBar.toFixed(2)})`
                : `${j.c.name} (whole categories)`,
          )
          .join(", ")}`,
        table: "pmax_campaign_products",
        category: "our_gap",
      };
    if (unsynced.length > 0)
      return {
        state: "not_checkable",
        reason: `the product rows of ${andList(unsynced)} were not read`,
        table: "pmax_campaign_products",
        category: "our_gap",
      };
    if (population === 0)
      return {
        state: "not_checkable",
        reason: `the live ${what} campaigns show no product (no product rows in the window)`,
        table: "pmax_campaign_products",
        category: "not_present",
      };
    const how =
      rowsWithColour === 0
        ? "sizes summed by product, no colour known"
        : rowsWithColour < rowsSeen
          ? "sizes summed by model and colour where the colour is known, else by product"
          : "sizes summed by model and colour";
    const cats = categorySources.every((x) => x == null)
      ? "whole categories not judged: no product type or Google category on the rows"
      : `no whole category (${categorySources.includes("product_type") ? "by product type" : "by Google category"}${categorySources.some((x) => x == null) ? ", where the rows carry one" : ""}) lost money either`;
    return {
      state: "none_found",
      population,
      note: `no product (${how}) spent past its campaign's bar with no sale, or sold for less than it cost; ${cats}; inside ${judged.map((j) => `${j.c.name} (bar ${j.bar.toFixed(2)})`).join(", ")}${truncated ? " (capped product read; every row past the cap spent under the bar)" : ""}${alreadyOut.length > 0 ? `; ${ALREADY_OUT_NOTE} ${alreadyOut.join(", ")}` : ""}`,
    };
  }
  const notes = [
    truncated ? "partial list — the product read hit its row cap" : null,
    alreadyOut.length > 0 ? `${ALREADY_OUT_NOTE} ${alreadyOut.join(", ")}` : null,
    unjudged.length > 0
      ? `${what} campaigns not judged (no money bar): ${unjudged.join("; ")}`
      : null,
    unsynced.length > 0 ? `not checkable per campaign for ${unsynced.join(", ")}` : null,
  ].filter((x): x is string => x != null);
  if (notes.length > 0) for (const f of findings) f.note = `${f.note ?? ""}; ${notes.join("; ")}`;
  return { state: "fires", findings };
}

// ---------------------------------------------------------------------------
// SH04 — a product spends past the bar without a sale
// ---------------------------------------------------------------------------

const SH04_FALLBACK_NOTE =
  "account-wide read at the one account bar (T.waste_floor): no live Shopping campaign has its own product rows read";

const SH04 = defineCheck({
  id: "SH04",
  claimKey: CLAIM_KEYS.PRODUCT_ZERO_CONV_WASTE,
  title: "product spends past the bar without a sale, or sells for less than it costs",
  clientLabel: "products that spend without selling, or sell at a loss",
  group: "shopping",
  metrics: ["C.product_waste_bar", "C.product_loss_bar", "Pr.spend", "Pr.conv", "T.waste_floor"],
  confounders: ["MI01", "SH01", "SH06", "PX05", "SH15"],
  requires: ["products"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "No product spends past the bar without a sale, or sells for less than it costs.",
  run(ctx: CheckCtx): CheckResult {
    // Shopping campaigns with their own product rows are judged per campaign, per model +
    // colour, at that campaign's own bar (the same engine as PX05). The account-wide read below
    // is the fallback only, when those rows were not read.
    const perCampaign = campaignProductLosers(ctx, "SHOPPING", CLAIM_KEYS.PRODUCT_ZERO_CONV_WASTE);
    if (perCampaign) return perCampaign;
    const g = gateOnData(ctx, ["products"]);
    if (g) return g;
    const floorV = ctx.get("T.waste_floor");
    const floor = num(floorV);
    if (floor == null)
      return {
        state: "not_checkable",
        reason: wasteFloorReason(floorV),
        table: "campaigns",
      };
    // an infinite bar (currency unknown) can clear nothing: could not check, never "none found"
    if (!Number.isFinite(floor))
      return {
        state: "not_checkable",
        reason: "could not check: the account currency is unknown, so there is no money bar",
        table: "derived",
        category: "our_gap",
      };
    // sizes and colours are summed to their parent product first: one size of a best seller
    // that has not sold is not waste; the product is what gets excluded
    const measured = feedProducts(ctx).flatMap((p) => {
      const spendV = ctx.get("Pr.spend", { productId: p.id });
      const convV = ctx.get("Pr.conv", { productId: p.id });
      const spend = num(spendV);
      const conv = num(convV);
      return spend == null || conv == null
        ? []
        : [{ p, spendV, convV, spend, conv, value: p.windows.m90.value ?? 0 }];
    });
    if (measured.length === 0) return NO_PRODUCTS;
    const parents = groupByParentProduct(
      measured,
      (x) => x.p.id,
      (x) => ({ cost: x.spend, conv: x.conv, value: x.value }),
    );
    const findings: CheckFinding[] = [];
    for (const grp of parents) {
      if (grp.cost < floor || grp.conv !== 0) continue;
      const top = grp.members[0]!;
      const name = variantGroupName(top.p.attrs.title ?? top.p.id, grp.members.length);
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.PRODUCT_ZERO_CONV_WASTE,
          scope: { type: "product", id: top.p.id, name },
          cite: [floorV],
          // each size cites under its own name, so no two rows share a label
          citeLabelled: grp.members.slice(0, LIST_ROWS).flatMap((x) => {
            const own = { id: x.p.id, name: x.p.attrs.title ?? x.p.id };
            return [
              { value: x.spendV, entity: own },
              { value: x.convV, entity: own },
            ];
          }),
          entity: { id: top.p.id, name },
          facts: {
            "Pr.spend": grp.cost,
            "Pr.conv": 0,
            "T.waste_floor": floor,
            variants: grp.members.length,
          },
          population: parents.length,
          ...(grp.members.length > 1
            ? {
                rows: grp.members.slice(0, LIST_ROWS).map((x) => ({
                  entity: { id: x.p.id, name: x.p.attrs.title ?? x.p.id },
                  cells: { spend: x.spend, sales: x.conv },
                })),
              }
            : {}),
        }),
      );
    }
    const variantNote =
      parents.length < measured.length
        ? ` (${measured.length} sizes and colours summed to ${parents.length} products)`
        : "";
    if (findings.length === 0)
      return {
        state: "none_found",
        population: parents.length,
        note: `no product of ${parents.length} spends ${floor} or more with zero conversions${variantNote}; ${SH04_FALLBACK_NOTE}`,
      };
    for (const f of findings) f.note = SH04_FALLBACK_NOTE;
    return { state: "fires", findings };
  },
});

// ---------------------------------------------------------------------------
// SH05 — a product returning far more than the account
// ---------------------------------------------------------------------------

const SH05 = defineCheck({
  id: "SH05",
  claimKey: CLAIM_KEYS.PRODUCT_SCALE_CANDIDATE,
  title: "product returning far more than the account",
  clientLabel: "products that return far more than the account",
  group: "shopping",
  metrics: ["Pr.roas", "Pr.conv", "A.roas", "F.conv_min_for_verdict"],
  confounders: ["BB07", "SH01", "SH15"],
  requires: ["products"],
  impactFormula: "IMP_SCALE",
  noneFoundMeans:
    "No product with enough conversions returns the set multiple of the account's return or more.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["products"]);
    if (g) return g;
    const acctV = ctx.get("A.roas");
    const acct = num(acctV);
    if (acct == null)
      return {
        state: "not_checkable",
        reason: `the account's return is not known: ${isOk(acctV) ? "not numeric" : acctV.detail}`,
        table: "campaigns",
      };
    // Pr.roas carries its own conversion floor, so anything below it is not computable
    const multiple = ctx.settings.shopping.scaleRoasMultiple;
    const products = feedProducts(ctx);
    if (products.length === 0) return NO_PRODUCTS;
    const findings: CheckFinding[] = [];
    let aboveFloor = 0;
    for (const p of products) {
      const roasV = ctx.get("Pr.roas", { productId: p.id });
      if (!isOk(roasV)) continue;
      aboveFloor += 1;
      const roas = num(roasV);
      if (roas == null || roas < multiple * acct) continue;
      const convV = ctx.get("Pr.conv", { productId: p.id });
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.PRODUCT_SCALE_CANDIDATE,
          scope: { type: "product", id: p.id, name: p.attrs.title ?? p.id },
          cite: [roasV, convV, acctV],
          entity: { id: p.id, name: p.attrs.title ?? p.id },
          facts: {
            "Pr.roas": roas,
            "A.roas": acct,
            "Pr.conv": num(convV),
            multiple_of_account: multiple,
          },
          population: aboveFloor,
        }),
      );
    }
    if (aboveFloor === 0)
      return {
        state: "insufficient_data",
        reason: `no product of ${products.length} has enough conversions for its return to be judged`,
      };
    if (findings.length === 0)
      return {
        state: "none_found",
        population: aboveFloor,
        note: `${aboveFloor} of ${products.length} products have enough conversions; none returns ${(multiple * acct).toFixed(2)}x or better`,
      };
    return { state: "fires", findings };
  },
});

// ---------------------------------------------------------------------------
// SH06 — GTIN, colour or size missing (Merchant Center data: not read here)
// ---------------------------------------------------------------------------

const SH06 = defineCheck({
  id: "SH06",
  claimKey: CLAIM_KEYS.PRODUCT_ATTRIBUTES_MISSING,
  title: "required product attributes missing",
  clientLabel: "products missing GTIN, colour or size",
  group: "shopping",
  metrics: ["Pr.missing_attrs"],
  confounders: ["SH01", "SH04", "SH15"],
  requires: ["products"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Required product attributes are present.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["products"]);
    if (g) return g;
    const all = feedProducts(ctx);
    if (all.length === 0) return NO_PRODUCTS;
    // GTIN, colour and size are Merchant Center attributes: a product outside a Merchant
    // Center read has none of them because they were never read, not because they are missing
    const products = all.filter((p) => !outsideMerchantCenterRead(p));
    const unmatched = all.length - products.length;
    if (products.length === 0)
      return {
        state: "not_checkable",
        reason:
          "GTIN, colour and size are Merchant Center attributes the Google Ads API does not return, so none was read",
        table: "products",
        category: "google_withholds",
      };
    const missing = products.filter((p) => p.attrs.missingAttrs.length > 0);
    const share = (missing.length / products.length) * 100;
    const bar = ctx.settings.shopping.missingAttrsMaxPct;
    if (share <= bar)
      return {
        state: "none_found",
        population: products.length,
        note: `${missing.length} of ${products.length} products miss GTIN, colour or size (${share.toFixed(1)}%)`,
      };
    return {
      state: "fires",
      findings: [
        {
          ...finding({
            claimKey: CLAIM_KEYS.PRODUCT_ATTRIBUTES_MISSING,
            scope: ACCOUNT_SCOPE,
            cite: missing
              .slice(0, LIST_ROWS)
              .map((p) => ctx.get("Pr.missing_attrs", { productId: p.id })),
            facts: {
              missing_products: missing.length,
              total_products: products.length,
              missing_pct: share,
              outside_merchant_center_read: unmatched,
            },
            population: products.length,
            rows: productRows(missing, (p) => ({ missing: p.attrs.missingAttrs.join(", ") })),
          }),
          ...limitOf(merchantCenterLimit(unmatched, all.length, "GTIN, colour and size")),
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// SH08 / SH09 / SH22 — promotions, shipping and returns (Merchant Center data: not read here)
// ---------------------------------------------------------------------------

const SH08 = defineCheck({
  id: "SH08",
  claimKey: CLAIM_KEYS.FEED_PROMOTIONS_EXPIRED,
  title: "Merchant Center promotions expired",
  clientLabel: "expired Merchant Center promotions",
  group: "shopping",
  metrics: ["F.promotions_live", "F.promotions_expired"],
  confounders: ["SK18"],
  requires: ["mcPromotions"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Merchant Center promotions are current.",
  run(ctx: CheckCtx): CheckResult {
    const g = merchantCenterGate(ctx, ["mcPromotions"]);
    if (g) return g;
    const liveV = ctx.get("F.promotions_live");
    const expiredV = ctx.get("F.promotions_expired");
    const live = num(liveV);
    const expired = num(expiredV);
    if (live == null || expired == null)
      return {
        state: "not_checkable",
        reason: "the live and expired promotion counts are not computable",
        table: "mcPromotions",
      };
    const total = ctx.model.attrs.merchantCenter.promotions.total;
    if (expired <= live)
      return { state: "none_found", population: total, note: `${live} live, ${expired} expired` };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.FEED_PROMOTIONS_EXPIRED,
          scope: ACCOUNT_SCOPE,
          cite: [liveV, expiredV],
          facts: {
            "F.promotions_live": live,
            "F.promotions_expired": expired,
            promotions_total: total,
          },
          population: total,
        }),
      ],
    };
  },
});

const SH09 = defineCheck({
  id: "SH09",
  claimKey: CLAIM_KEYS.FEED_POLICIES_MISSING,
  title: "shipping / return policies missing",
  clientLabel: "shipping and return policies in Merchant Center",
  group: "shopping",
  metrics: ["F.shipping_services", "F.return_policies"],
  confounders: [],
  requires: ["mcShippingSettings", "mcReturnPolicies"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Shipping and return policies are configured.",
  run(ctx: CheckCtx): CheckResult {
    const g = merchantCenterGate(ctx, ["mcShippingSettings", "mcReturnPolicies"]);
    if (g) return g;
    const shipV = ctx.get("F.shipping_services");
    const retV = ctx.get("F.return_policies");
    const ship = num(shipV);
    const ret = num(retV);
    if (ship == null || ret == null)
      return {
        state: "not_checkable",
        reason: "the shipping and return policy counts are not computable",
        table: "mcShippingSettings",
      };
    if (ship > 0 && ret > 0)
      return {
        state: "none_found",
        population: ship + ret,
        note: `${ship} shipping services, ${ret} return policies`,
      };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.FEED_POLICIES_MISSING,
          scope: ACCOUNT_SCOPE,
          cite: [shipV, retV],
          facts: { "F.shipping_services": ship, "F.return_policies": ret },
          population: ship + ret,
        }),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// SH10 — two Shopping campaigns at the same priority over the same products
// ---------------------------------------------------------------------------

const SH10 = defineCheck({
  id: "SH10",
  claimKey: CLAIM_KEYS.SHOPPING_CAMPAIGN_OVERLAP,
  title: "two Shopping campaigns at the same priority",
  clientLabel: "Shopping campaigns competing at the same priority",
  group: "shopping",
  metrics: ["Sh.campaign_priority", "Sh.feed_label"],
  confounders: ["PX01", "SH17"],
  requires: ["shoppingSettings"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No two Shopping campaigns compete at the same priority.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["shoppingSettings"]);
    if (g) return g;
    const shopping = campaignsOf(ctx).filter((c) => c.attrs.type === "SHOPPING");
    if (shopping.length === 0)
      return {
        state: "not_checkable",
        reason: "no Shopping campaign on this account",
        table: "campaigns",
        category: "not_present",
      };
    // one Shopping campaign has nothing to compete with: true without reading its settings
    if (shopping.length === 1)
      return { state: "none_found", population: 1, note: "one Shopping campaign" };
    const unsynced = shopping.filter((c) => c.attrs.shoppingSettings.state !== "synced");
    if (unsynced.length > 0)
      return {
        state: "not_checkable",
        reason: `the Shopping settings of ${unsynced.length} of ${shopping.length} Shopping campaigns were not read, so their priority and feed label are unknown`,
        table: "shoppingSettings",
        category: "our_gap",
      };
    const byKey = new Map<string, typeof shopping>();
    for (const c of shopping) {
      const key = `${str(ctx.get("Sh.feed_label", { campaignId: c.id })) ?? ""}|${str(ctx.get("Sh.campaign_priority", { campaignId: c.id })) ?? ""}`;
      byKey.set(key, [...(byKey.get(key) ?? []), c]);
    }
    const findings: CheckFinding[] = [];
    for (const [key, grp] of byKey) {
      if (grp.length < 2) continue;
      for (const c of grp) {
        findings.push(
          finding({
            claimKey: CLAIM_KEYS.SHOPPING_CAMPAIGN_OVERLAP,
            scope: {
              type: "campaign",
              id: c.id,
              name: c.name,
              campaignId: c.id,
              campaignName: c.name,
            },
            cite: [
              ctx.get("Sh.feed_label", { campaignId: c.id }),
              ctx.get("Sh.campaign_priority", { campaignId: c.id }),
            ].filter(isOk),
            entity: { id: c.id, name: c.name },
            facts: {
              feed_label: key.split("|")[0] || "all products",
              priority: key.split("|")[1] || null,
              competing_campaigns: grp.length,
            },
            population: shopping.length,
            rows: grp
              .filter((x) => x.id !== c.id)
              .slice(0, LIST_ROWS)
              .map((x) => ({ entity: { id: x.id, name: x.name }, cells: { competes: "yes" } })),
          }),
        );
      }
    }
    if (findings.length === 0) return { state: "none_found", population: shopping.length };
    return { state: "fires", findings };
  },
});

// ---------------------------------------------------------------------------
// SH11 — cart economics (a context line, never a finding)
// ---------------------------------------------------------------------------

/** SH11: orders a product needs before its own order value is worth stating. */
const CART_ORDER_FLOOR = 10;

const SH11 = defineCheck({
  id: "SH11",
  claimKey: CLAIM_KEYS.PRODUCT_AOV_CONTEXT,
  title: "cart economics context",
  clientLabel: "order size and units per order from your cart data",
  group: "shopping",
  metrics: ["Sh.aov", "Sh.units_per_order"],
  confounders: [],
  requires: ["shoppingCartData"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Cart data (orders, units, order value) is available as context.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["shoppingCartData"]);
    if (g) return g;
    // a context number, never a finding: it states the sample it stands on
    const cartProducts = ctx.model.children.products.filter((p) => p.attrs.cart);
    const aboveFloor = cartProducts.filter(
      (p) => (p.attrs.cart!.orders ?? 0) >= CART_ORDER_FLOOR,
    ).length;
    const rows = ctx.model.attrs.shoppingCart.rows;
    if (rows === 0)
      return {
        state: "not_checkable",
        reason:
          "no product carries cart data (orders and units sold need cart data sent with conversions)",
        table: "shoppingCartData",
        category: "not_present",
      };
    return {
      state: "none_found",
      population: rows,
      note: `context: ${rows} products with cart orders${ctx.model.attrs.shoppingCart.sample ? " (a sample: the product read stopped at its limit)" : ""}; ${cartProducts.length} joined, ${aboveFloor} with ${CART_ORDER_FLOOR}+ orders`,
    };
  },
});

// ---------------------------------------------------------------------------
// SH22 — no Merchant Center promotion live (Merchant Center data: not read here)
// ---------------------------------------------------------------------------

const SH22 = defineCheck({
  id: "SH22",
  claimKey: CLAIM_KEYS.FEED_NO_ACTIVE_PROMOTION,
  title: "no Merchant Center promotion is live",
  clientLabel: "a live Merchant Center promotion on your products",
  noteOnly: "no Merchant Center promotion is running, so no promotion badge shows on the products",
  group: "shopping",
  metrics: ["F.promotions_live", "F.promotions_expired"],
  confounders: [],
  requires: ["mcPromotions"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "A Merchant Center promotion is live on your products.",
  run(ctx: CheckCtx): CheckResult {
    const g = merchantCenterGate(ctx, ["mcPromotions"]);
    if (g) return g;
    const liveV = ctx.get("F.promotions_live");
    const expiredV = ctx.get("F.promotions_expired");
    const live = num(liveV);
    const expired = num(expiredV);
    if (live == null || expired == null)
      return {
        state: "not_checkable",
        reason: "the live and expired promotion counts are not computable",
        table: "mcPromotions",
      };
    const total = ctx.model.attrs.merchantCenter.promotions.total;
    if (live > 0)
      return { state: "none_found", population: total, note: `${live} live promotion(s)` };
    if (expired > 0)
      return {
        state: "insufficient_data",
        reason: `${expired} expired promotion(s) and none live: SH08 reports it`,
      };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.FEED_NO_ACTIVE_PROMOTION,
          scope: ACCOUNT_SCOPE,
          cite: [liveV, expiredV],
          facts: { promotions_live: live, promotions_expired: expired, promotions_total: total },
          population: total,
        }),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// SH23 — gift cards and test items getting ad traffic
// ---------------------------------------------------------------------------

/** Title phrases that mark a product that should never carry ad spend (folded, whole words). "sample" stays out: sample sizes are real products. */
const JUNK_TITLE_PHRASES: readonly string[] = [
  "gift card",
  "giftcard",
  "gift voucher",
  "e gift",
  "egift",
  "cadeaukaart",
  "cadeaubon",
  "karta podarunkowa",
  "bon podarunkowy",
  "gutschein",
  "test product",
  "test item",
  "dummy product",
  "placeholder",
  "do not buy",
  "do not order",
];

export function junkReasonOf(title: string | null, price: number | null): string | null {
  if (price != null && price === 0) return "price is 0";
  const folded = foldBrandText(title ?? "");
  const padded = ` ${folded} `;
  // "test" alone only when it IS the title ("Water Test Kit" is a product)
  const hit =
    folded === "test" ? "test" : JUNK_TITLE_PHRASES.find((w) => padded.includes(` ${w} `));
  if (!hit) return null;
  return /gift|cadeau|podarunk|gutschein/.test(hit) ? "gift card" : "test or placeholder item";
}

const SH23 = defineCheck({
  id: "SH23",
  claimKey: CLAIM_KEYS.PRODUCT_JUNK_IN_ADS,
  title: "gift cards, test items or $0 items are getting ad traffic",
  clientLabel: "gift cards, test items or free items showing in your ads",
  group: "shopping",
  metrics: ["Pr.spend", "Pr.conv", "T.waste_floor"],
  confounders: [],
  requires: ["products"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "No gift card, test item or $0 item is spending real money in your ads.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["products"]);
    if (g) return g;
    if (ctx.model.children.products.length === 0) return NO_PRODUCTS;
    const products = ctx.model.children.products.filter((p) => p.attrs.title != null);
    if (products.length === 0)
      return {
        state: "not_checkable",
        reason: "no product carries a title",
        table: "products",
        category: "our_gap",
      };
    const withTraffic = products.filter(
      (p) => (p.windows.m90.impressions ?? p.attrs.shopping?.impressions ?? 0) > 0,
    );
    const junk = withTraffic
      .map((p) => ({
        p,
        reason: junkReasonOf(p.attrs.title, p.attrs.priceInsight?.current ?? null),
      }))
      .filter((x): x is { p: ProductNode; reason: string } => x.reason != null);
    if (junk.length === 0)
      return {
        state: "none_found",
        population: withTraffic.length,
        note: `${withTraffic.length} products with impressions, none a gift card, test item or $0 item`,
      };
    const cost = (p: ProductNode): number => p.windows.m90.cost ?? 0;
    const conv = (p: ProductNode): number => p.windows.m90.conv ?? p.attrs.shopping?.conv ?? 0;
    const sample = products.some((p) => p.sample.truncated);
    const junkSpend = junk.reduce((t, x) => t + cost(x.p), 0);
    const floor = num(ctx.get("T.waste_floor"));
    // a zero-sale product at or above the bar is SH04's finding and priced there; it stays listed
    const ownedBySh04 = (x: (typeof junk)[number]): boolean =>
      floor != null && Number.isFinite(floor) && conv(x.p) === 0 && cost(x.p) >= floor;
    const wasted = junk
      .filter((x) => conv(x.p) === 0 && !ownedBySh04(x))
      .reduce((t, x) => t + cost(x.p), 0);
    // under the waste bar it is a line in the note, never a finding
    if (floor == null || !Number.isFinite(floor) || junkSpend < floor)
      return {
        state: "none_found",
        population: withTraffic.length,
        note: `${junk.length} gift card / test / $0 item(s) with impressions, ${junkSpend.toFixed(2)} spend: under the ${floor == null ? "unknown" : floor.toFixed(2)} bar for a finding`,
      };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.PRODUCT_JUNK_IN_ADS,
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: junk.slice(0, LIST_ROWS).map((x) => ctx.get("Pr.spend", { productId: x.p.id })),
          facts: {
            rollup_wasted_cost_90d: Number(wasted.toFixed(2)),
            ...(sample ? { rollup_is_sample: 1 } : {}),
            junk_products: junk.length,
            junk_spend_90d: Number(junkSpend.toFixed(2)),
            junk_zero_sale_spend_90d: Number(wasted.toFixed(2)),
            priced_by_product_waste_check: junk.filter(ownedBySh04).length,
          },
          population: withTraffic.length,
          rows: [...junk]
            .sort((a, b) => cost(b.p) - cost(a.p) || a.p.id.localeCompare(b.p.id))
            .slice(0, LIST_ROWS)
            .map((x) => ({
              entity: { id: x.p.id, name: x.p.attrs.title ?? x.p.id },
              cells: {
                why: x.reason,
                impressions: x.p.windows.m90.impressions ?? x.p.attrs.shopping?.impressions ?? 0,
                spend: Number(cost(x.p).toFixed(2)),
                sales: Number(conv(x.p).toFixed(2)),
              },
            })),
        }),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// SH24 — store quality and seller ratings (Google does not serve them to any tool)
// ---------------------------------------------------------------------------

const SH24 = defineCheck({
  id: "SH24",
  claimKey: CLAIM_KEYS.FEED_STORE_QUALITY_UNREADABLE,
  title: "store quality and seller ratings are not readable by an outside tool",
  clientLabel: "your store quality score and seller ratings",
  group: "shopping",
  metrics: [],
  confounders: [],
  // declared only: the line is about a Merchant Center screen no API serves, so no table gates it
  requires: ["campaigns"],
  impactFormula: "IMP_NONE",
  run(ctx: CheckCtx): CheckResult {
    const sells =
      ctx.model.attrs.merchantCenterConnected ||
      campaignsOf(ctx).some(
        (c) => c.attrs.type === "SHOPPING" || c.attrs.type === "PERFORMANCE_MAX",
      );
    if (!sells)
      return {
        state: "not_checkable",
        reason: "no Merchant Center link and no Shopping or Performance Max campaign",
        category: "not_present",
      };
    return {
      state: "not_checkable",
      reason:
        "Google does not show the store quality scorecard or seller ratings to outside tools; look in Merchant Center under Performance, then Store quality",
      category: "google_withholds",
    };
  },
});

// ---------------------------------------------------------------------------
// SH26-SH29 (M15) — store factors, photos, identifiers, highlights
// ---------------------------------------------------------------------------

/** M15: the seller-ratings bar Google states: 100 reviews in 12 months, 3.5 stars on average. */
export const SELLER_RATING_MIN_REVIEWS = 100;
export const SELLER_RATING_MIN_STARS = 3.5;
/** M15 (F128-B3): whether a store's reviews meet Google's seller-ratings bar. Pure. */
export function meetsSellerRatingBar(reviews: number, stars: number): boolean {
  return reviews >= SELLER_RATING_MIN_REVIEWS && stars >= SELLER_RATING_MIN_STARS;
}
/** M15: the reviews to-do, said wherever store ratings come up (no API serves them). */
export const SELLER_RATINGS_TODO =
  `Seller ratings show once your store has ${SELLER_RATING_MIN_REVIEWS}+ reviews from the last 12 months averaging ${SELLER_RATING_MIN_STARS}+ stars. ` +
  "Google Customer Reviews (free, set up in Merchant Center) collects them. Product ratings are a separate Merchant Center program: turn it on and connect your review app so star ratings show on your products. " +
  "Check the store quality page in Merchant Center yourself as well.";

/** M15: the account scope of SH28's product-type part, named as in the app so the two compare. */
const SH28_PRODUCT_TYPE_SCOPE: CheckScope = {
  type: "account",
  id: null,
  name: "Products: no product type",
};

const SH26 = defineCheck({
  id: "SH26",
  claimKey: CLAIM_KEYS.FEED_STORE_RANKING_FACTOR,
  title:
    "Merchant Center store factors that hold Shopping listings back (handling, delivery time, return cost)",
  clientLabel: "shipping speed and return cost in Merchant Center",
  group: "shopping",
  metrics: ["F.shipping_services", "F.return_policies"],
  confounders: [],
  requires: ["mcShippingSettings"],
  impactFormula: "IMP_NONE",
  run(ctx: CheckCtx): CheckResult {
    const g = merchantCenterGate(ctx, ["mcShippingSettings"]);
    if (g) return g;
    // a source that carries the shipping tables still has no handling / transit times or return fees here
    return {
      state: "not_checkable",
      reason: `handling and transit times and return shipping fees are Merchant Center data this server does not read. ${SELLER_RATINGS_TODO}`,
      table: "mcShippingSettings",
      category: "our_gap",
    };
  },
});

const SH27 = defineCheck({
  id: "SH27",
  claimKey: CLAIM_KEYS.PRODUCT_PHOTOS_FEW,
  title: "top-selling products have fewer than 3 photos",
  clientLabel: "photos on your best sellers",
  group: "shopping",
  metrics: [],
  confounders: ["SH15"],
  requires: ["products"],
  impactFormula: "IMP_NONE",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["products"]);
    if (g) return g;
    if (feedProducts(ctx).length === 0) return NO_PRODUCTS;
    return {
      state: "not_checkable",
      reason:
        "the Google Ads API does not return how many photos a product has (additional images are Merchant Center data)",
      table: "products",
      category: "google_withholds",
    };
  },
});

const SH28 = defineCheck({
  id: "SH28",
  claimKey: CLAIM_KEYS.PRODUCT_IDENTIFIERS_MISSING,
  // only the product type is read here: the title and label never claim barcodes were checked
  // (a "clean" SH28 must not read as "no barcode problems"; the app's SH28 also judges GTIN / MPN)
  title:
    "products with no product type (barcodes not checked: GTIN, MPN and identifier_exists are Merchant Center data)",
  clientLabel: "products with no product type in your feed",
  group: "shopping",
  metrics: [],
  confounders: ["SH15"],
  requires: ["products"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Every product in Google Ads' copy of your product list has a product type.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["products"]);
    if (g) return g;
    const all = feedProducts(ctx);
    if (all.length === 0) return NO_PRODUCTS;
    // the product type comes from Google Ads' own product list; a product with no row there was not read
    const products = all.filter((p) => p.attrs.inFeed !== false);
    if (products.length === 0)
      return {
        state: "not_checkable",
        reason: "no product had a row in Google Ads' product list, so no product type was read",
        table: "products",
        category: "our_gap",
      };
    const limits = [
      "Not checked: barcodes. GTIN, MPN and identifier_exists are Merchant Center attributes the Google Ads API does not return.",
      'Whether the brand on third-party goods is your store name (the Shopify "Vendor") was not judged: nothing we read tells your own products from resold ones.',
      ...(products.length < all.length
        ? [
            `${all.length - products.length} of the ${all.length} products had no row in Google Ads' product list, so they are not counted.`,
          ]
        : []),
    ];
    const noType = products.filter((p) => !p.attrs.productType);
    if (noType.length === 0)
      return {
        state: "none_found",
        population: products.length,
        note: `${products.length} products judged for product type, none missing. ${limits.join(" ")}`,
      };
    const sorted = [...noType].sort(
      (a, b) =>
        (b.windows.m90.value ?? 0) - (a.windows.m90.value ?? 0) ||
        (b.windows.m90.cost ?? 0) - (a.windows.m90.cost ?? 0) ||
        a.id.localeCompare(b.id),
    );
    return {
      state: "fires",
      findings: [
        {
          ...finding({
            claimKey: CLAIM_KEYS.PRODUCT_IDENTIFIERS_MISSING,
            scope: SH28_PRODUCT_TYPE_SCOPE,
            cite: [],
            facts: {
              part: "product_type",
              products_no_product_type: noType.length,
              products_read: products.length,
            },
            population: products.length,
            rows: sorted.slice(0, LIST_ROWS).map((p) => ({
              entity: { id: p.id, name: p.attrs.title ?? p.id },
              cells: {
                product_type: "none",
                sales_90d: Number((p.windows.m90.value ?? 0).toFixed(2)),
                spend_90d: Number((p.windows.m90.cost ?? 0).toFixed(2)),
              },
            })),
          }),
          ...limitOf(limits),
        },
      ],
    };
  },
});

const SH29 = defineCheck({
  id: "SH29",
  claimKey: CLAIM_KEYS.PRODUCT_HIGHLIGHTS_MISSING,
  title: "top-selling products have no product highlights or product details",
  clientLabel: "highlights and details on your best sellers",
  group: "shopping",
  metrics: [],
  confounders: ["SH15"],
  requires: ["products"],
  impactFormula: "IMP_NONE",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["products"]);
    if (g) return g;
    if (feedProducts(ctx).length === 0) return NO_PRODUCTS;
    return {
      state: "not_checkable",
      reason:
        "the Google Ads API does not return product highlights or product details (they are Merchant Center data)",
      table: "products",
      category: "google_withholds",
    };
  },
});

export const SHOPPING_CHECKS: CheckDefinition[] = [
  SH01,
  SH02,
  SH03,
  SH04,
  SH05,
  SH06,
  SH08,
  SH09,
  SH10,
  SH11,
  SH22,
  SH23,
  SH24,
  SH26,
  SH27,
  SH28,
  SH29,
];
