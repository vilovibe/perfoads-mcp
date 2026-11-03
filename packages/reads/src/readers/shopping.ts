// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). The Shopping data the Shopping and Performance
// Max product checks read, one GAQL resource per part. Merchant Center is read only as Google
// Ads shows it (shopping_product); nothing here calls a Merchant Center API.
// - shopping_settings (campaign): the Shopping settings (priority, feed label, Merchant Center
//   id) and status of every non-removed Shopping and Performance Max campaign;
// - products (shopping_product, over the range), read after the settings: one read per LIVE
//   Shopping or Performance Max campaign with a Merchant Center account (campaign scope, the
//   products that campaign can serve, with its metrics and Google Ads' status there), at most
//   3 at a time, joined per product row: metrics summed over those campaigns, the best status
//   kept. A Merchant Center shared with other accounts holds products this account never
//   serves; they are not read. Each read stops at its own cap. Over PRODUCT_CAMPAIGNS_MAX live
//   campaigns, or when a per-campaign read fails or is refused, ONE account read narrowed to
//   the live campaigns' Merchant Center accounts and feed labels stands for them all (no label
//   filter when a live campaign sells every label); only if Google refuses that one, the
//   unfiltered account read. With no settings read the account read is unfiltered; with no
//   live campaign selling products nothing is read (no product can show). The cart metrics
//   (orders, units) ride along; when Google refuses them the part is read again without them
//   and the cart data is not read. Each product row keeps its stock state and the codes of
//   Google's blocking issues (out of stock, not in a campaign, a feed problem), so a product
//   that cannot show can be told apart by reason;
// - campaign_products (shopping_performance_view, over the range): each Shopping and Performance
//   Max campaign's own spend per product, with its product type (levels 1-2) and Google
//   category (level 1). read by date (splitRead) when one read fills its limit, so no
//   row is lost to the cap; summed per (campaign, product) after;
// - campaign_products_recent (optional, explicit dates only): the same view over the last 7 days
//   of the range, impressions per (campaign, product), kept on each campaign_product row as
//   recentImpressions (whether another campaign is showing the product now); a pair with no
//   row in the range's read is kept as its own campaign_product row (metrics null).

import * as z from "zod";
import { MetricsSchema, plural, where, type FilterInput } from "../common.js";
import { dateCondition, describeDateRange } from "../dateRange.js";
import { SPLIT_READ_BUDGET } from "../splitRead.js";
import {
  addMetrics,
  enumValue,
  get,
  id,
  metrics,
  moneyOrZero,
  numberOrNull,
  sumMoney,
  textOrNull,
  type Row,
} from "../normalise.js";
import {
  partOk,
  type Part,
  type PartStatus,
  type PartsData,
  type ReaderDef,
  type SplitStatus,
} from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const SHOPPING_ROW_KINDS = ["product", "shopping_setting", "campaign_product"] as const;

export const ShoppingRowSchema = z.object({
  kind: z.enum(SHOPPING_ROW_KINDS),
  campaignId: z.string().nullable(),
  itemId: UntrustedSchema.nullable().describe("the product's item id (offer id)"),
  title: UntrustedSchema.nullable(),
  brand: UntrustedSchema.nullable(),
  status: z
    .string()
    .nullable()
    .describe(
      "product: Google Ads product status (ELIGIBLE, NOT_ELIGIBLE, ...; the best over its campaigns); shopping_setting: campaign status",
    ),
  channel: z.string().nullable(),
  availability: z
    .string()
    .nullable()
    .default(null)
    .describe("product: IN_STOCK, OUT_OF_STOCK, PREORDER, ... (null = not read)"),
  issueCodes: z
    .array(z.string())
    .nullable()
    .default(null)
    .describe(
      "product: the codes of Google's issues that stop the product showing (not_eligible_out_of_stock, not_eligible_in_any_campaign, a feed problem's code, ...); [] = none; null = not read",
    ),
  languageCode: z.string().nullable(),
  feedLabel: UntrustedSchema.nullable(),
  customLabels: z
    .array(UntrustedSchema.nullable())
    .nullable()
    .describe("custom attributes 0-4 (custom labels)"),
  productType: UntrustedSchema.nullable().describe("product type levels joined with ' > '"),
  productTypeL1: UntrustedSchema.nullable()
    .default(null)
    .describe("campaign_product: product type level 1 as Google reports it (lowercased)"),
  productTypeL2: UntrustedSchema.nullable()
    .default(null)
    .describe("campaign_product: product type level 2 as Google reports it (lowercased)"),
  categoryL1: UntrustedSchema.nullable()
    .default(null)
    .describe("campaign_product: Google product category level 1"),
  recentImpressions: z
    .number()
    .nullable()
    .default(null)
    .describe(
      "campaign_product: the product's impressions in this campaign in the last 7 days of the range; null = not read",
    ),
  channelType: z.string().nullable(),
  merchantId: z.string().nullable(),
  priority: z.number().nullable(),
  enableLocal: z.boolean().nullable(),
  metrics: MetricsSchema.nullable().describe("null = not read for this row"),
  cart: z
    .object({
      orders: z.number(),
      unitsSold: z.number(),
      revenue: z.string(),
      averageCartSize: z.number().nullable(),
    })
    .nullable()
    .describe("cart data metrics (null = not read)"),
});
export type ShoppingRow = z.infer<typeof ShoppingRowSchema>;

export const ShoppingSummarySchema = z.object({
  products: z.number().nullable().describe("null = not read"),
  productsWithSpend: z.number().nullable(),
  shoppingCampaigns: z.number().nullable(),
  campaignProductRows: z.number().nullable(),
});
export type ShoppingSummary = z.infer<typeof ShoppingSummarySchema>;

export const ShoppingExtraSchema = z.object({
  cartRead: z.boolean().describe("false = the cart metrics were refused and not read"),
  campaignProductsRead: z
    .object({
      reads: z.number(),
      truncatedReason: z.string().nullable(),
      cutoffCost: z.number().nullable(),
    })
    .nullable()
    .default(null)
    .describe(
      "the per-campaign product read: queries run, why it was cut (null = complete) and the most spend one product can have outside the rows kept; null = not read",
    ),
});
export type ShoppingExtra = z.infer<typeof ShoppingExtraSchema>;

/** Products read per campaign (or in the one account read): one Google page. A bigger list is a sample (the highest-cost first). */
export const SHOPPING_PRODUCT_CAP = 10_000;
/**
 * Live Shopping / Performance Max campaigns whose products are read one by one; over this,
 * one read by Merchant Center account and feed label stands for them all.
 */
export const PRODUCT_CAMPAIGNS_MAX = 30;
/** Per-campaign product reads running at once. */
const PRODUCT_READS_AT_ONCE = 3;
/** Shopping / Performance Max campaign x product rows per query, the highest-cost first. */
export const CAMPAIGN_PRODUCT_CAP = 10_000;
/** Most queries the per-campaign product read may run when it splits by date. */
export const CAMPAIGN_PRODUCT_READ_BUDGET = SPLIT_READ_BUDGET;

const METRIC_FIELDS = `
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value`;

const CART_FIELDS = `,
      metrics.orders,
      metrics.units_sold,
      metrics.revenue_micros,
      metrics.average_cart_size`;

const LABELS = [0, 1, 2, 3, 4]
  .map((i) => `shopping_product.custom_attribute${i}`)
  .join(",\n      ");
const TYPES = [1, 2, 3, 4, 5]
  .map((i) => `shopping_product.product_type_level${i}`)
  .join(",\n      ");

const productsSelect = (cart: boolean) => `
    SELECT
      shopping_product.merchant_center_id,
      shopping_product.item_id,
      shopping_product.title,
      shopping_product.brand,
      shopping_product.status,
      shopping_product.availability,
      shopping_product.issues,
      shopping_product.channel,
      shopping_product.language_code,
      shopping_product.feed_label,
      ${LABELS},
      ${TYPES},${METRIC_FIELDS}${cart ? CART_FIELDS : ""}`;

/**
 * Account scope (no campaign filter): every product, metrics summed over its campaigns.
 * `scope` narrows it (Merchant Center accounts, feed labels); empty = every product.
 */
export const shoppingProductsQuery = (
  input: FilterInput,
  cart = true,
  scope: readonly string[] = [],
): string => `${productsSelect(cart)}
    FROM shopping_product
    ${where([dateCondition(input.dateRange), ...scope])}
    ORDER BY metrics.cost_micros DESC`;

/**
 * Campaign scope: the products one campaign can serve, with that campaign's metrics and the
 * product's status there. Google takes only an equality on shopping_product.campaign (a
 * campaign.id filter is refused).
 */
export const campaignShoppingProductsQuery = (
  input: FilterInput,
  customerId: string,
  campaignId: string,
  cart = true,
): string => `${productsSelect(cart)}
    FROM shopping_product
    ${where([
      `shopping_product.campaign = 'customers/${customerId}/campaigns/${campaignId}'`,
      dateCondition(input.dateRange),
    ])}
    ORDER BY metrics.cost_micros DESC`;

/** Google's field names of the cart metrics: a refusal naming one sends later reads without them. */
const CART_METRIC_FIELDS = [
  "metrics.orders",
  "metrics.units_sold",
  "metrics.revenue_micros",
  "metrics.average_cart_size",
] as const;

export const shoppingSettingsQuery = (): string => `
    SELECT
      campaign.id,
      campaign.advertising_channel_type,
      campaign.status,
      campaign.shopping_setting.merchant_id,
      campaign.shopping_setting.feed_label,
      campaign.shopping_setting.campaign_priority,
      campaign.shopping_setting.enable_local
    FROM campaign
    ${where([
      "campaign.advertising_channel_type IN ('SHOPPING', 'PERFORMANCE_MAX')",
      "campaign.status != 'REMOVED'",
    ])}
    ORDER BY campaign.id`;

const CAMPAIGN_PRODUCT_TYPES =
  "campaign.advertising_channel_type IN ('SHOPPING', 'PERFORMANCE_MAX')";

// shopping_performance_view refuses a WHERE on a campaign field it does not also SELECT
/** Each Shopping / PMax campaign's own rows per product; `campaignId` narrows it to one campaign. */
export const campaignProductsQuery = (
  input: FilterInput,
  campaignId: string | null = null,
): string => `
    SELECT
      campaign.id,
      campaign.advertising_channel_type,
      campaign.status,
      segments.product_item_id,
      segments.product_title,
      segments.product_type_l1,
      segments.product_type_l2,
      segments.product_category_level1,${METRIC_FIELDS}
    FROM shopping_performance_view
    ${where([
      dateCondition(input.dateRange),
      CAMPAIGN_PRODUCT_TYPES,
      "campaign.status != 'REMOVED'",
      ...(campaignId !== null && /^\d{1,20}$/.test(campaignId)
        ? [`campaign.id = ${campaignId}`]
        : []),
    ])}
    ORDER BY metrics.cost_micros DESC`;

/** The Shopping / PMax campaigns with product rows on one day (one row per campaign: no product segment). */
export const productCampaignsQuery = (day: string): string => `
    SELECT
      campaign.id,
      campaign.advertising_channel_type,
      campaign.status,
      metrics.impressions
    FROM shopping_performance_view
    ${where([`segments.date = '${day}'`, CAMPAIGN_PRODUCT_TYPES, "campaign.status != 'REMOVED'"])}`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Days of the "shown recently" read, ending on the range's last day. */
export const RECENT_IMPRESSIONS_DAYS = 7;

/** Impressions per (campaign, product) over the last RECENT_IMPRESSIONS_DAYS days ending on `endDate`. */
export const recentCampaignProductsQuery = (endDate: string): string => {
  const end = new Date(`${endDate}T00:00:00Z`);
  const start = new Date(end.getTime() - (RECENT_IMPRESSIONS_DAYS - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return `
    SELECT
      campaign.id,
      campaign.advertising_channel_type,
      campaign.status,
      segments.product_item_id,
      metrics.impressions
    FROM shopping_performance_view
    ${where([
      `segments.date BETWEEN '${start}' AND '${endDate}'`,
      CAMPAIGN_PRODUCT_TYPES,
      "campaign.status != 'REMOVED'",
      "metrics.impressions > 0",
    ])}
    ORDER BY metrics.impressions DESC`;
};

/** The recent-impressions part: explicit date ranges only (a preset has no known last day). */
const recentCampaignProductsPart = (input: FilterInput): Part | null => {
  const { endDate } = input.dateRange;
  if (input.dateRange.preset !== null || !endDate || !DAY.test(endDate)) return null;
  return {
    gaql: recentCampaignProductsQuery(endDate),
    limit: CAMPAIGN_PRODUCT_CAP,
    optional:
      "The last 7 days' impressions per campaign and product were not read in full, so they are unknown.",
    label: "last 7 days' impressions per campaign and product",
  };
};

/**
 * The per-campaign product part: an explicit date range is read with splitRead (by date, then
 * by campaign, when a read fills its limit); a preset is one read at its limit.
 */
const campaignProductsPart = (input: FilterInput): Part => {
  const { startDate, endDate } = input.dateRange;
  const gaql = campaignProductsQuery(input);
  if (
    input.dateRange.preset !== null ||
    !startDate ||
    !endDate ||
    !DAY.test(startDate) ||
    !DAY.test(endDate)
  )
    return { gaql, limit: CAMPAIGN_PRODUCT_CAP };
  return {
    gaql,
    limit: CAMPAIGN_PRODUCT_CAP,
    split: {
      startDate,
      endDate,
      query: (start, end, campaignId) =>
        campaignProductsQuery(
          { ...input, dateRange: { preset: null, startDate: start, endDate: end } },
          campaignId,
        ),
      campaignsQuery: productCampaignsQuery,
      campaignOf: (r) => id(get(r, "campaign.id")),
      costOf: (r) => Number(get(r, "metrics.costMicros") ?? 0) / 1e6,
      budget: CAMPAIGN_PRODUCT_READ_BUDGET,
    },
  };
};

const EMPTY: Omit<ShoppingRow, "kind"> = {
  campaignId: null,
  itemId: null,
  title: null,
  brand: null,
  status: null,
  channel: null,
  availability: null,
  issueCodes: null,
  languageCode: null,
  feedLabel: null,
  customLabels: null,
  productType: null,
  productTypeL1: null,
  productTypeL2: null,
  categoryL1: null,
  recentImpressions: null,
  channelType: null,
  merchantId: null,
  priority: null,
  enableLocal: null,
  metrics: null,
  cart: null,
};

/** A language code as Google sends it (en, en-US, zh_CN); anything else null. */
const languageOf = (v: unknown): string | null =>
  typeof v === "string" && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(v) ? v : null;

const cartOf = (r: Row): ShoppingRow["cart"] => ({
  orders: numberOrNull(get(r, "metrics.orders")) ?? 0,
  unitsSold: numberOrNull(get(r, "metrics.unitsSold")) ?? 0,
  revenue: moneyOrZero(get(r, "metrics.revenueMicros")),
  averageCartSize: numberOrNull(get(r, "metrics.averageCartSize")),
});

/** Google's issue codes are lowercase words joined by "_"; anything else is not kept. */
const ISSUE_CODE = /^[a-z][a-z0-9_]{0,80}$/;

/**
 * The codes of the issues that stop a product showing (ads severity ERROR), sorted and unique;
 * a warning lets it show and is left out. [] when the row carries no issue.
 */
const blockingCodes = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const codes = new Set<string>();
  for (const i of v) {
    if (get(i, "adsSeverity") !== "ERROR") continue;
    const code = get(i, "errorCode");
    if (typeof code === "string" && ISSUE_CODE.test(code)) codes.add(code);
  }
  return [...codes].sort();
};

/** Out of stock: a stock state, not a campaign or feed problem. */
const OUT_OF_STOCK_CODE = "not_eligible_out_of_stock";

/**
 * A code saying no live campaign advertises the product here (not in any campaign, left out
 * of a listing group, its asset group or ad group paused ...): Google names these
 * not_eligible_*, out of stock aside. The SH01 check reads the codes by the same rule
 * (cannotShowReason in @perfoads/checks).
 */
const isNotAdvertisedCode = (code: string): boolean =>
  code.startsWith("not_eligible_") && code !== OUT_OF_STOCK_CODE;

const mapProduct = (r: Row, cart: boolean): ShoppingRow | null => {
  const itemId = textOrNull(get(r, "shoppingProduct.itemId"));
  if (!itemId) return null;
  const types = [1, 2, 3, 4, 5]
    .map((i) => get(r, `shoppingProduct.productTypeLevel${i}`))
    .filter((x): x is string => typeof x === "string" && x !== "");
  return {
    ...EMPTY,
    kind: "product",
    itemId,
    title: textOrNull(get(r, "shoppingProduct.title")),
    brand: textOrNull(get(r, "shoppingProduct.brand")),
    status: enumValue(get(r, "shoppingProduct.status")),
    merchantId: id(get(r, "shoppingProduct.merchantCenterId")),
    channel: enumValue(get(r, "shoppingProduct.channel")),
    availability: enumValue(get(r, "shoppingProduct.availability")),
    issueCodes: blockingCodes(get(r, "shoppingProduct.issues")),
    languageCode: languageOf(get(r, "shoppingProduct.languageCode")),
    feedLabel: textOrNull(get(r, "shoppingProduct.feedLabel")),
    customLabels: [0, 1, 2, 3, 4].map((i) =>
      textOrNull(get(r, `shoppingProduct.customAttribute${i}`)),
    ),
    productType: types.length > 0 ? textOrNull(types.join(" > ")) : null,
    metrics: metrics(r),
    cart: cart ? cartOf(r) : null,
  };
};

const mapSetting = (r: Row): ShoppingRow | null => {
  const campaignId = id(get(r, "campaign.id"));
  if (!campaignId) return null;
  return {
    ...EMPTY,
    kind: "shopping_setting",
    campaignId,
    channelType: enumValue(get(r, "campaign.advertisingChannelType")),
    status: enumValue(get(r, "campaign.status")),
    merchantId: id(get(r, "campaign.shoppingSetting.merchantId")),
    feedLabel: textOrNull(get(r, "campaign.shoppingSetting.feedLabel")),
    priority: numberOrNull(get(r, "campaign.shoppingSetting.campaignPriority")),
    enableLocal: get(r, "campaign.shoppingSetting.enableLocal") === true,
  };
};

const mapCampaignProduct = (r: Row): ShoppingRow | null => {
  const campaignId = id(get(r, "campaign.id"));
  const itemId = textOrNull(get(r, "segments.productItemId"));
  if (!campaignId || !itemId) return null;
  return {
    ...EMPTY,
    kind: "campaign_product",
    campaignId,
    itemId,
    title: textOrNull(get(r, "segments.productTitle")),
    channelType: enumValue(get(r, "campaign.advertisingChannelType")),
    productTypeL1: textOrNull(get(r, "segments.productTypeL1")),
    productTypeL2: textOrNull(get(r, "segments.productTypeL2")),
    categoryL1: textOrNull(get(r, "segments.productCategoryLevel1")),
    metrics: metrics(r),
  };
};

/**
 * The split read's rows summed per (campaign, product): each kept read covers its own days,
 * so a product read in two date chunks is one row with both chunks' metrics.
 */
const sumCampaignProducts = (rows: readonly ShoppingRow[]): ShoppingRow[] => {
  const byKey = new Map<string, ShoppingRow>();
  for (const r of rows) {
    const k = JSON.stringify([r.campaignId, r.itemId?.untrusted ?? null]);
    const had = byKey.get(k);
    byKey.set(
      k,
      had
        ? {
            ...had,
            title: had.title ?? r.title,
            productTypeL1: had.productTypeL1 ?? r.productTypeL1,
            productTypeL2: had.productTypeL2 ?? r.productTypeL2,
            categoryL1: had.categoryL1 ?? r.categoryL1,
            metrics: had.metrics && r.metrics ? addMetrics(had.metrics, r.metrics) : had.metrics,
          }
        : r,
    );
  }
  return [...byKey.values()];
};

const costOf = (r: ShoppingRow): number => Number(r.metrics?.cost ?? 0);

const RECENT_PART = "campaign_products_recent";
const recentKey = (campaignId: string | null, itemId: string | null): string =>
  JSON.stringify([campaignId, (itemId ?? "").toLowerCase()]);

/** One (campaign, product) pair of the recent read: its impressions and the row it came from. */
interface RecentPair {
  campaignId: string;
  itemId: NonNullable<ShoppingRow["itemId"]>;
  channelType: string | null;
  impressions: number;
}

/**
 * Impressions per (campaign, product) of the recent read, or null when it was not read in
 * full (not asked, failed, capped or cut short): unknown, never 0.
 */
const recentImpressionsOf = (
  data: PartsData,
  parts: readonly PartStatus[],
): Map<string, RecentPair> | null => {
  if (!partOk(parts, RECENT_PART)) return null;
  const out = new Map<string, RecentPair>();
  for (const r of data[RECENT_PART] ?? []) {
    const campaignId = id(get(r, "campaign.id"));
    const itemId = textOrNull(get(r, "segments.productItemId"));
    if (!campaignId || !itemId) continue;
    const k = recentKey(campaignId, itemId.untrusted);
    const had = out.get(k);
    const n = numberOrNull(get(r, "metrics.impressions")) ?? 0;
    out.set(
      k,
      had
        ? { ...had, impressions: had.impressions + n }
        : {
            campaignId,
            itemId,
            channelType: enumValue(get(r, "campaign.advertisingChannelType")),
            impressions: n,
          },
    );
  }
  return out;
};

/**
 * The recent pairs with no row in the range's read (a capped or split read can leave a
 * product out): kept as campaign_product rows with their 7-day impressions only. metrics
 * null = no range spend, clicks or sales read for them, never 0.
 */
const recentOnlyRows = (
  recent: ReadonlyMap<string, RecentPair> | null,
  rows: readonly ShoppingRow[],
): ShoppingRow[] => {
  if (!recent) return [];
  const seen = new Set(rows.map((r) => recentKey(r.campaignId, r.itemId?.untrusted ?? null)));
  return [...recent]
    .filter(([k, v]) => !seen.has(k) && v.impressions > 0)
    .map(([, v]) => ({
      ...EMPTY,
      kind: "campaign_product" as const,
      campaignId: v.campaignId,
      itemId: v.itemId,
      channelType: v.channelType,
      recentImpressions: v.impressions,
    }));
};

/** The products part, or the one-per-campaign reads that stand for it. */
const PRODUCTS = "products";
const productsPart = (campaignId: string) => `products_${campaignId}`;
const isProductsPart = (p: PartStatus): boolean => p.part === PRODUCTS || p.groupName === PRODUCTS;

/** Every products read ran in full (not refused, not capped, not cut short). */
const productsOk = (parts: readonly PartStatus[]): boolean => {
  const own = parts.filter(isProductsPart);
  return own.length > 0 && own.every((p) => partOk([p], p.part));
};

/** A feed label safe to put in a GAQL string (Merchant Center labels are letters, digits, _ and -). */
const SAFE_LABEL = /^[A-Za-z0-9_-]{1,40}$/;

interface LiveSetting {
  campaignId: string;
  merchantId: string;
  feedLabel: string | null;
}

/**
 * The live (ENABLED) Shopping and Performance Max campaigns that sell from a Merchant Center
 * account; null when the settings were not read.
 */
const liveSettings = (data: PartsData): LiveSetting[] | null => {
  const rows = data.shopping_settings;
  if (rows === undefined) return null;
  const out: LiveSetting[] = [];
  for (const r of rows) {
    const s = mapSetting(r);
    if (!s?.campaignId || s.status !== "ENABLED" || !s.merchantId) continue;
    out.push({
      campaignId: s.campaignId,
      merchantId: s.merchantId,
      feedLabel: s.feedLabel?.untrusted ?? null,
    });
  }
  return out;
};

/** The account read, narrowed to the live campaigns' Merchant Center accounts and feed labels. */
const scopeOf = (live: readonly LiveSetting[]): string[] => {
  const merchants = [...new Set(live.map((l) => l.merchantId))].sort();
  const labels = live.map((l) => l.feedLabel ?? "");
  // an empty label sells every label; a label not safe to quote is read wider, never narrower
  const everyLabel = labels.some((l) => l === "" || !SAFE_LABEL.test(l));
  return [
    `shopping_product.merchant_center_id IN (${merchants.join(", ")})`,
    ...(everyLabel
      ? []
      : [
          `shopping_product.feed_label IN (${[...new Set(labels)]
            .sort()
            .map((l) => `'${l}'`)
            .join(", ")})`,
        ]),
  ];
};

const accountProductsPart = (input: FilterInput, scope: string[], note?: string): Part => ({
  gaql: shoppingProductsQuery(input, true, scope),
  limit: SHOPPING_PRODUCT_CAP,
  fallback: shoppingProductsQuery(input, false, scope),
  ...(note ? { note } : {}),
});

const STATUS_RANK = ["ELIGIBLE", "ELIGIBLE_LIMITED"];
/** The better of two product statuses: ELIGIBLE over ELIGIBLE_LIMITED over the rest. */
const bestStatus = (a: string | null, b: string | null): string | null => {
  const rank = (s: string | null) => {
    const i = STATUS_RANK.indexOf(s ?? "");
    return i < 0 ? STATUS_RANK.length + (s === null ? 1 : 0) : i;
  };
  return rank(b) < rank(a) ? b : a;
};

const addCart = (a: ShoppingRow["cart"], b: ShoppingRow["cart"]): ShoppingRow["cart"] => {
  if (!a || !b) return a ?? b;
  const sized = [a, b].filter((c) => c.averageCartSize !== null);
  const sizedOrders = sized.reduce((n, c) => n + c.orders, 0);
  return {
    orders: a.orders + b.orders,
    unitsSold: a.unitsSold + b.unitsSold,
    revenue: sumMoney([a.revenue, b.revenue]),
    averageCartSize:
      sizedOrders > 0
        ? sized.reduce((n, c) => n + (c.averageCartSize ?? 0) * c.orders, 0) / sizedOrders
        : (sized[0]?.averageCartSize ?? null),
  };
};

/** One product row: Merchant Center account, channel, language, feed label and item id. */
const productKey = (r: ShoppingRow): string =>
  JSON.stringify([
    r.merchantId,
    r.channel,
    r.languageCode,
    r.feedLabel?.untrusted ?? null,
    r.itemId?.untrusted ?? null,
  ]);

/**
 * How well a campaign's read lets the product show: its status first, then (cannot show) a
 * campaign that advertises it over one that leaves it out. Lower is better.
 */
const showRank = (r: ShoppingRow): number => {
  const i = STATUS_RANK.indexOf(r.status ?? "");
  if (i >= 0) return i;
  return STATUS_RANK.length + ((r.issueCodes ?? []).some(isNotAdvertisedCode) ? 1 : 0);
};

/**
 * The per-campaign reads joined per product row: metrics and cart summed (each read holds
 * that campaign's own metrics), the best status kept, with the issues of the campaign that
 * lets it show best (a product left out of one campaign and out of stock in another is
 * advertised, out of stock).
 */
const unionProducts = (reads: readonly ShoppingRow[][]): ShoppingRow[] => {
  const byKey = new Map<string, ShoppingRow>();
  for (const rows of reads)
    for (const r of rows) {
      const k = productKey(r);
      const had = byKey.get(k);
      if (!had) {
        byKey.set(k, r);
        continue;
      }
      const better = showRank(r) < showRank(had) ? r : had;
      byKey.set(k, {
        ...had,
        status: bestStatus(had.status, r.status),
        availability: had.availability ?? r.availability,
        issueCodes: better.issueCodes,
        metrics: had.metrics && r.metrics ? addMetrics(had.metrics, r.metrics) : had.metrics,
        cart: addCart(had.cart, r.cart),
      });
    }
  return [...byKey.values()];
};

export const shoppingReader: ReaderDef<FilterInput, ShoppingRow, ShoppingSummary, ShoppingExtra> = {
  name: "shopping",
  queries: (input) => {
    const recent = recentCampaignProductsPart(input);
    return {
      shopping_settings: { gaql: shoppingSettingsQuery() },
      campaign_products: campaignProductsPart(input),
      ...(recent ? { [RECENT_PART]: recent } : {}),
    };
  },
  followUp: (input, ctx, data) => {
    const live = liveSettings(data);
    if (live === null)
      return {
        [PRODUCTS]: accountProductsPart(
          input,
          [],
          "The Shopping settings were not read, so every product of the linked Merchant Center accounts was read, also products no campaign of this account serves.",
        ),
      };
    // no live campaign sells products: none can show, nothing to read. Over the cap: the
    // one read by Merchant Center and feed label (groupFallback)
    if (live.length === 0 || live.length > PRODUCT_CAMPAIGNS_MAX) return {};
    const parts: Record<string, Part> = {};
    for (const l of live)
      parts[productsPart(l.campaignId)] = {
        gaql: campaignShoppingProductsQuery(input, ctx.customerId, l.campaignId),
        limit: SHOPPING_PRODUCT_CAP,
        fallback: campaignShoppingProductsQuery(input, ctx.customerId, l.campaignId, false),
        group: { name: PRODUCTS, key: l.campaignId },
        stickyFields: CART_METRIC_FIELDS,
      };
    return parts;
  },
  followUpConcurrency: PRODUCT_READS_AT_ONCE,
  groupFallback: (input, _ctx, data) => {
    const live = liveSettings(data) ?? [];
    if (live.length === 0) return {};
    const why =
      live.length > PRODUCT_CAMPAIGNS_MAX
        ? `There are ${live.length} live Shopping and Performance Max campaigns (more than ${PRODUCT_CAMPAIGNS_MAX}), so the products were not read per campaign`
        : "The product read failed for some live campaigns (or Google refused it)";
    return {
      [PRODUCTS]: [
        accountProductsPart(
          input,
          scopeOf(live),
          `${why}, so the products were read once by the live campaigns' Merchant Center accounts and feed labels; their spend is summed over every campaign that includes them.`,
        ),
        accountProductsPart(
          input,
          [],
          `${why}, and Google refused the read by Merchant Center account and feed label, so every product of the linked Merchant Center accounts was read, also products no campaign of this account serves.`,
        ),
      ],
    };
  },
  map: (data, _input, _ctx, parts) => {
    // the fallback read leaves the cart metrics out: not read, never zero
    const cartRead = !parts.some((p) => isProductsPart(p) && p.fallback);
    const mapAll = (rows: Row[] | undefined): ShoppingRow[] =>
      (rows ?? []).map((r) => mapProduct(r, cartRead)).filter((r): r is ShoppingRow => r !== null);
    const perCampaign = parts.filter((p) => p.groupName === PRODUCTS && p.groupKey);
    const products =
      perCampaign.length > 0
        ? unionProducts(perCampaign.map((p) => mapAll(data[p.part])))
        : mapAll(data[PRODUCTS]);
    const recent = recentImpressionsOf(data, parts);
    const campaignProducts = sumCampaignProducts(
      (data.campaign_products ?? [])
        .map(mapCampaignProduct)
        .filter((r): r is ShoppingRow => r !== null),
    ).map((r) => ({
      ...r,
      recentImpressions: recent
        ? (recent.get(recentKey(r.campaignId, r.itemId?.untrusted ?? null))?.impressions ?? 0)
        : null,
    }));
    const rows = [
      ...products,
      ...(data.shopping_settings ?? []).map(mapSetting).filter((r): r is ShoppingRow => r !== null),
      ...campaignProducts,
      ...recentOnlyRows(recent, campaignProducts),
    ];
    const split: SplitStatus | undefined = parts.find((p) => p.part === "campaign_products")?.split;
    return {
      rows,
      extra: {
        cartRead,
        campaignProductsRead: split
          ? {
              reads: split.reads,
              truncatedReason: split.truncatedReason,
              cutoffCost: split.cutoffCost,
            }
          : null,
      },
    };
  },
  compare: (a, b) =>
    SHOPPING_ROW_KINDS.indexOf(a.kind) - SHOPPING_ROW_KINDS.indexOf(b.kind) ||
    (a.campaignId ?? "").localeCompare(b.campaignId ?? "") ||
    costOf(b) - costOf(a) ||
    (a.itemId?.untrusted ?? "").localeCompare(b.itemId?.untrusted ?? ""),
  summarise: (rows, _extra, _ctx, _input, parts) => {
    const n = (kind: ShoppingRow["kind"], part: string) =>
      partOk(parts, part) ? rows.filter((r) => r.kind === kind).length : null;
    // no live campaign sells products: nothing was asked, and none can show
    const noneToRead =
      !parts.some(isProductsPart) &&
      partOk(parts, "shopping_settings") &&
      !rows.some(
        (r) => r.kind === "shopping_setting" && r.status === "ENABLED" && r.merchantId !== null,
      );
    const productsRead = productsOk(parts) || noneToRead;
    return {
      products: productsRead ? rows.filter((r) => r.kind === "product").length : null,
      productsWithSpend: productsRead
        ? rows.filter((r) => r.kind === "product" && costOf(r) > 0).length
        : null,
      shoppingCampaigns: partOk(parts, "shopping_settings")
        ? rows.filter((r) => r.kind === "shopping_setting" && r.channelType === "SHOPPING").length
        : null,
      campaignProductRows: n("campaign_product", "campaign_products"),
    };
  },
  summaryLine: (s, ctx, input) =>
    `Shopping on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${s.products === null ? "products unknown" : `${plural(s.products, "product")} (${s.productsWithSpend ?? 0} with spend)`}, ${s.shoppingCampaigns === null ? "Shopping campaigns unknown" : plural(s.shoppingCampaigns, "Shopping campaign")}.`,
  rowLine: (r) =>
    `${r.kind} ${r.campaignId ?? ""} ${r.itemId ? JSON.stringify(r.itemId) : ""} ${[r.channelType, r.status].filter(Boolean).join(" ")}`.trim(),
};
