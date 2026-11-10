// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Synthetic accounts for the wave-3 checks (Shopping, video, Local Services,
 * Demand Gen). Every number and name is made up. Each builder returns an input
 * whose tables are all read ("ok" status rows), on which most of its checks are
 * clean; options turn single signals on for the tests that need a finding.
 */
import type { EvidenceInput } from "../api.js";
import type { Row } from "../engine/shared/input.js";
import { MERCHANT_CENTER_NOT_READ } from "../engine/checks/shopping.js";
import { buildInput, dayBefore, LAST_DAY, type CampaignSpec } from "./account.js";

/** "ok" read statuses for named tables (they have no AccountData key). */
export function withStatus(input: EvidenceInput, tables: Record<string, number>): EvidenceInput {
  return {
    ...input,
    statusRows: [
      ...(input.statusRows ?? []),
      ...Object.entries(tables).map(([table_name, row_count]) => ({
        table_name,
        status: "ok",
        row_count,
        error_message: null,
      })),
    ],
  };
}

/** Merchant Center tables a snapshot never reads: skipped, as the snapshot adapter writes them. */
export const MC_NOT_READ: readonly string[] = [
  "mc_account_issues",
  "mc_promotions",
  "mc_shipping",
  "mc_return_policies",
  "mc_price_insights",
  "feed_diagnostics",
];

function withMcSkipped(input: EvidenceInput): EvidenceInput {
  return {
    ...input,
    statusRows: [
      ...(input.statusRows ?? []),
      ...MC_NOT_READ.map((table_name) => ({
        table_name,
        status: "skipped",
        row_count: 0,
        error_message: `${MERCHANT_CENTER_NOT_READ}, and Google Ads does not show it`,
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Shopping
// ---------------------------------------------------------------------------

export interface ProductSpec {
  id: string;
  title?: string;
  cost?: number;
  clicks?: number;
  impressions?: number;
  conv?: number;
  value?: number;
  status?: string;
  labels?: Array<string | null>;
  feedLabel?: string;
  /** IN_STOCK, OUT_OF_STOCK ... (absent = not read) */
  availability?: string;
  /** Google's blocking issue codes for the row (absent = not read) */
  issues?: string[];
  /** false = only in the status list (no product row: did not serve) */
  served?: boolean;
  /** the product type (absent = "Shoes > Trail"; null = blank in the feed) */
  productType?: string | null;
}

export const product = (p: ProductSpec): Row => ({
  product_id: p.id,
  title: p.title ?? `Trail shoe ${p.id}`,
  brand: "Acme",
  product_type: p.productType === undefined ? "Shoes > Trail" : p.productType,
  feed_label: p.feedLabel ?? "US",
  ...Object.fromEntries(
    [0, 1, 2, 3, 4].map((i) => [`custom_label_${i}`, (p.labels ?? ["core"])[i] ?? null]),
  ),
  cost_micros: Math.round((p.cost ?? 100) * 1_000_000),
  clicks: p.clicks ?? 40,
  impressions: p.impressions ?? 2_000,
  conversions: p.conv ?? 2,
  conversion_value: p.value ?? (p.conv ?? 2) * 120,
});

const statusRow = (p: ProductSpec): Row => ({
  item_id: p.id,
  title: p.title ?? `Trail shoe ${p.id}`,
  feed_label: p.feedLabel ?? "US",
  status: p.status ?? "ELIGIBLE",
  ...(p.availability !== undefined ? { availability: p.availability } : {}),
  ...(p.issues !== undefined ? { issue_codes: JSON.stringify(p.issues) } : {}),
  channel: "ONLINE",
  clicks: p.served === false ? 0 : (p.clicks ?? 40),
  impressions: p.served === false ? 0 : (p.impressions ?? 2_000),
  conversions: p.served === false ? 0 : (p.conv ?? 2),
  conversions_value: p.served === false ? 0 : (p.value ?? (p.conv ?? 2) * 120),
});

/** Six products that serve and sell in line with the account. */
export const PRODUCTS: ProductSpec[] = [
  { id: "sku-1", cost: 300, conv: 6, value: 900 },
  { id: "sku-2", cost: 250, conv: 5, value: 700 },
  { id: "sku-3", cost: 200, conv: 4, value: 600 },
  { id: "sku-4", cost: 150, conv: 3, value: 450 },
  { id: "sku-5", cost: 100, conv: 2, value: 300 },
  { id: "sku-6", cost: 80, conv: 2, value: 240 },
];

export const SHOPPING_CAMPAIGN: CampaignSpec = {
  id: "71",
  name: "Shopping all shoes",
  type: "SHOPPING",
  cost: 6,
  conv: 0.15,
  value: 30,
  clicks: 20,
  impressions: 900,
};
export const PMAX_CAMPAIGN: CampaignSpec = {
  id: "41",
  name: "PMax all shoes",
  type: "PERFORMANCE_MAX",
  cost: 6,
  conv: 0.15,
  value: 30,
  clicks: 20,
  impressions: 900,
};
const SEARCH_CAMPAIGN: CampaignSpec = { id: "11", name: "Generic search", cost: 20, conv: 0.5 };

export interface ShoppingOptions {
  products?: ProductSpec[];
  campaigns?: CampaignSpec[];
  /** the Shopping campaign's feed label ('' = every product) and priority */
  shoppingFeedLabel?: string;
  /** a second Shopping campaign at the same priority over the same products */
  secondShopping?: boolean;
  /** PMax listing tree: "all" (root included), "split" (sku-1 and sku-2 in group 51, the rest in 52), "type" (product-type split) */
  listing?: "all" | "split" | "type";
  /** a second live asset group whose tree also includes everything */
  overlappingGroups?: boolean;
  /** per-campaign product rows: override */
  campaignProducts?: Row[];
  cart?: Row[];
  /** country rows (geo_countries) */
  countries?: Row[];
  campaignLanguages?: Row[];
  shopLanguages?: Row[];
  placements?: Row[];
  /** the product list was cut at its row limit */
  catalogCut?: boolean;
  settings?: EvidenceInput["settings"];
  clientContext?: EvidenceInput["clientContext"];
}

const listingRows = (o: ShoppingOptions): Row[] => {
  const node = (
    group: string,
    id: string,
    type: string,
    caseValue: object,
    parent?: string,
  ): Row => ({
    asset_group_id: group,
    listing_group_id: id,
    parent_listing_group_id: parent ?? null,
    type,
    case_value: JSON.stringify(caseValue),
  });
  if (o.listing === "split")
    return [
      node("51", "1", "SUBDIVISION", {}),
      node("51", "2", "UNIT_INCLUDED", { productItemId: { value: "sku-1" } }, "1"),
      node("51", "3", "UNIT_INCLUDED", { productItemId: { value: "sku-2" } }, "1"),
      node("51", "4", "UNIT_EXCLUDED", { productItemId: {} }, "1"),
      node("52", "5", "SUBDIVISION", {}),
      node("52", "6", "UNIT_EXCLUDED", { productItemId: { value: "sku-1" } }, "5"),
      node("52", "7", "UNIT_EXCLUDED", { productItemId: { value: "sku-2" } }, "5"),
      node("52", "8", "UNIT_INCLUDED", { productItemId: {} }, "5"),
    ];
  if (o.listing === "type")
    return [
      node("51", "1", "SUBDIVISION", {}),
      node("51", "2", "UNIT_INCLUDED", { productType: { level: "LEVEL1", value: "shoes" } }, "1"),
      node("51", "3", "UNIT_EXCLUDED", { productType: { level: "LEVEL1" } }, "1"),
      node("52", "4", "UNIT_INCLUDED", {}),
    ];
  return [
    node("51", "1", "UNIT_INCLUDED", {}),
    ...(o.overlappingGroups ? [node("52", "2", "UNIT_INCLUDED", {})] : []),
  ];
};

/**
 * A shop: a Shopping campaign (feed label CA by default, so it sells none of the US
 * products and nothing overlaps), a Performance Max campaign with one asset group over
 * every product, and a Search campaign. Every Shopping table is read; Merchant Center's
 * own tables are skipped, as on a snapshot.
 */
export function shoppingAccount(o: ShoppingOptions = {}): EvidenceInput {
  const specs = o.products ?? PRODUCTS;
  const served = specs.filter((p) => p.served !== false);
  const groupIds =
    o.listing === "split" || o.listing === "type" || o.overlappingGroups ? ["51", "52"] : ["51"];
  const groups = groupIds.map((id) => ({
    asset_group_id: id,
    campaign_id: "41",
    name: `Group ${id}`,
    status: "ENABLED",
    ad_strength: "GOOD",
    cost: 200,
    clicks: 100,
    impressions: 4_000,
    conversions: 5,
    conversion_value: 1_000,
  }));
  const shoppingSettings: Row[] = [
    {
      campaign_id: "71",
      campaign_priority: 0,
      merchant_id: "900",
      feed_label: o.shoppingFeedLabel ?? "CA",
      enable_local: false,
    },
    {
      campaign_id: "41",
      campaign_priority: null,
      merchant_id: "900",
      feed_label: "",
      enable_local: false,
    },
    ...(o.secondShopping
      ? [
          {
            campaign_id: "72",
            campaign_priority: 0,
            merchant_id: "900",
            feed_label: o.shoppingFeedLabel ?? "CA",
            enable_local: false,
          },
        ]
      : []),
  ];
  const campaigns = o.campaigns ?? [
    SHOPPING_CAMPAIGN,
    PMAX_CAMPAIGN,
    SEARCH_CAMPAIGN,
    ...(o.secondShopping ? [{ ...SHOPPING_CAMPAIGN, id: "72", name: "Shopping clearance" }] : []),
  ];
  const catalog = specs.map((p) => ({
    ...product(p),
    ...(p.served === false
      ? { cost_micros: 0, clicks: 0, impressions: 0, conversions: 0, conversion_value: 0 }
      : {}),
  }));
  const campaignProducts =
    o.campaignProducts ??
    served.map((p) => ({
      campaign_id: "41",
      offer_id: p.id,
      product_title: p.title ?? `Trail shoe ${p.id}`,
      cost_micros: Math.round((p.cost ?? 100) * 500_000),
      clicks: Math.round((p.clicks ?? 40) / 2),
      impressions: Math.round((p.impressions ?? 2_000) / 2),
      conversions: (p.conv ?? 2) / 2,
      conversions_value: (p.value ?? (p.conv ?? 2) * 120) / 2,
    }));
  const countries = o.countries ?? [
    country("71", "2124", "CA", 540),
    country("41", "2840", "US", 540),
    country("11", "2840", "US", 1800),
  ];
  const languages = o.campaignLanguages ?? [
    { campaign_id: "71", criterion_id: "1000", language_code: "en", status: "ENABLED" },
  ];
  const shopLanguages = o.shopLanguages ?? [{ language_code: "en", product_count: specs.length }];
  const cart = o.cart ?? [
    {
      product_item_id: "sku-1",
      units_sold: 7,
      orders: 6,
      revenue_micros: 900_000_000,
      average_cart_size: 1.2,
    },
  ];
  const placements = o.placements ?? [];
  const input = buildInput({
    campaigns,
    data: {
      products: served.map(product),
      shoppingProductsData: specs.map(statusRow),
      shoppingSettings,
      shoppingCartData: cart,
      mcSyncStatus: [
        {
          resource: "product_feed",
          status: o.catalogCut ? "truncated" : "ok",
          row_count: specs.length,
        },
      ],
      assetGroups: groups,
      pmaxListingGroups: listingRows(o),
    },
    tables: {
      products_catalog: catalog,
      shop_languages: shopLanguages,
      pmax_campaign_products: campaignProducts,
      geo_countries: countries,
      campaign_languages: languages,
      placement_performance: placements,
      account_placement_exclusions: [],
    },
    syncedEmpty: ["shoppingCartData", "pmaxListingGroups", "products", "shoppingProductsData"],
    ...(o.settings ? { settings: o.settings } : {}),
    ...(o.clientContext ? { clientContext: o.clientContext } : {}),
  });
  return withMcSkipped(
    withStatus(input, {
      products_catalog: catalog.length,
      shop_languages: shopLanguages.length,
      pmax_campaign_products: campaignProducts.length,
      geo_countries: countries.length,
      campaign_languages: languages.length,
      placement_performance: placements.length,
      account_placement_exclusions: 0,
    }),
  );
}

/** One campaign's spend in one country (people in it). */
export const country = (
  campaignId: string,
  id: string,
  code: string,
  cost: number,
  o: { conv?: number; value?: number; clicks?: number; type?: string } = {},
): Row => ({
  campaign_id: campaignId,
  country_id: id,
  country_code: code,
  country_name: code === "US" ? "United States" : code === "CA" ? "Canada" : `Country ${code}`,
  location_type: o.type ?? "LOCATION_OF_PRESENCE",
  cost,
  clicks: o.clicks ?? Math.round(cost / 2),
  impressions: Math.round(cost * 20),
  conversions: o.conv ?? cost / 50,
  conversion_value: o.value ?? cost * 5,
});

/** A Display placement row with spend. */
export const placement = (
  campaignId: string,
  url: string,
  cost: number,
  conv = 0,
  type = "WEBSITE",
): Row => ({
  campaign_id: campaignId,
  placement: url,
  placement_type: type,
  display_name: url,
  target_url: url,
  cost,
  clicks: Math.round(cost),
  impressions: Math.round(cost * 50),
  conversions: conv,
  conversion_value: conv * 100,
});

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export interface VideoOptions {
  viewRate?: number;
  q25?: number;
  q100?: number;
  cpv?: number;
  views?: number;
  /** campaign_control_settings view-through numbers (view-through, all conversions) */
  viewThrough?: { vt: number; conv: number };
  metricsRows?: Row[] | null;
  settings?: EvidenceInput["settings"];
}

export const VIDEO_CAMPAIGN: CampaignSpec = {
  id: "81",
  name: "YouTube reach",
  type: "VIDEO",
  cost: 20,
  conv: 0.2,
  value: 40,
  clicks: 30,
  impressions: 3_000,
};

export function videoAccount(o: VideoOptions = {}): EvidenceInput {
  const metricsRows =
    o.metricsRows === undefined
      ? [
          {
            campaign_id: "81",
            video_views: o.views ?? 60_000,
            video_view_rate: o.viewRate ?? 0.25,
            average_cpv: o.cpv ?? 0.02,
            quartile_p25_rate: o.q25 ?? 0.7,
            quartile_p50_rate: 0.55,
            quartile_p75_rate: 0.45,
            quartile_p100_rate: o.q100 ?? 0.4,
            cost: 1_800,
            impressions: 270_000,
          },
        ]
      : o.metricsRows;
  const vt = o.viewThrough ?? { vt: 2, conv: 18 };
  const controls = [
    {
      campaign_id: "81",
      frequency_caps: "[{}]",
      frequency_caps_state: "set",
      view_through_conversions: vt.vt,
      conversions: vt.conv,
      all_conversions: vt.conv + vt.vt,
    },
  ];
  const input = buildInput({
    campaigns: [VIDEO_CAMPAIGN, SEARCH_CAMPAIGN],
    tables: {
      ...(metricsRows ? { video_campaign_metrics: metricsRows } : {}),
      campaign_control_settings: controls,
    },
    ...(o.settings ? { settings: o.settings } : {}),
  });
  return withStatus(input, {
    ...(metricsRows ? { video_campaign_metrics: metricsRows.length } : {}),
    campaign_control_settings: controls.length,
  });
}

// ---------------------------------------------------------------------------
// Local Services
// ---------------------------------------------------------------------------

export const LSA_CAMPAIGN: CampaignSpec = {
  id: "91",
  name: "Local services plumbing",
  type: "LOCAL_SERVICES",
  cost: 30,
  conv: 1,
  value: 0,
};

/** n leads, one a day going back from `from` days before LAST_DAY. */
export const leads = (
  n: number,
  o: { from?: number; credit?: string | null; charged?: boolean; prefix?: string } = {},
): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    lead_id: `${o.prefix ?? "7"}${i}`,
    lead_type: "PHONE_CALL",
    lead_status: "BOOKED",
    creation_time: `${dayBefore(LAST_DAY, (o.from ?? 0) + i)} 10:00:00`,
    charged: o.charged ?? true,
    credit_state: o.credit ?? null,
  }));

export const calls = (n: number, durationMs: number | null, prefix = "8"): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    conversation_id: `${prefix}${i}`,
    lead_resource: `7${i}`,
    channel: "PHONE_CALL",
    participant_type: "CONSUMER",
    event_time: `${dayBefore(LAST_DAY, i)} 10:00:00`,
    call_duration_ms: durationMs,
  }));

export interface LsaOptions {
  leads?: Row[];
  conversations?: Row[];
  verifications?: Row[];
  campaigns?: CampaignSpec[];
  settings?: EvidenceInput["settings"];
}

export function lsaAccount(o: LsaOptions = {}): EvidenceInput {
  return buildInput({
    campaigns: o.campaigns ?? [LSA_CAMPAIGN, SEARCH_CAMPAIGN],
    data: {
      lsaLeads: o.leads ?? [...leads(20), ...leads(20, { from: 30, prefix: "6" })],
      lsaConversations: o.conversations ?? calls(20, 120_000),
      lsaVerifications: o.verifications ?? [
        {
          artifact_id: "5",
          artifact_type: "LICENSE",
          status: "PASSED",
          license_type: "PLUMBER",
          license_expiry: "2027-06-01 00:00:00",
          insurance_expiry: null,
        },
      ],
    },
    syncedEmpty: ["lsaLeads", "lsaConversations", "lsaVerifications"],
    profile: { businessType: "local_lead_gen" },
    ...(o.settings ? { settings: o.settings } : {}),
  });
}

// ---------------------------------------------------------------------------
// Demand Gen
// ---------------------------------------------------------------------------

export const DG_CAMPAIGN: CampaignSpec = {
  id: "61",
  name: "Demand Gen new customers",
  type: "DEMAND_GEN",
  cost: 20,
  conv: 0.5,
  value: 100,
};

export const dgAsset = (field: string, n: number, adType = "DEMAND_GEN_MULTI_ASSET_AD"): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    campaign_id: "61",
    ad_id: "611",
    asset_id: `${field}${i}`,
    field_type: field,
    ad_type: adType,
    status: "ENABLED",
  }));

export const DG_FULL_ASSETS: Row[] = [
  ...dgAsset("HEADLINE", 5),
  ...dgAsset("DESCRIPTION", 5),
  ...dgAsset("MARKETING_IMAGE", 3),
  ...dgAsset("SQUARE_MARKETING_IMAGE", 3),
];

export const dgChannel = (net: string, cost: number, conv = 5): Row => ({
  campaign_id: "61",
  ad_network_type: net,
  cost,
  clicks: 100,
  impressions: 5_000,
  conversions: conv,
  conversion_value: conv * 100,
});

/** B12: one Demand Gen ad group's channel controls (no argument = every channel). */
export const dgControl = (
  selected?: readonly string[],
  o: { adGroupId?: string; status?: string; strategy?: string } = {},
): Row => ({
  campaign_id: "61",
  ad_group_id: o.adGroupId ?? "611",
  ad_group_status: o.status ?? "ENABLED",
  channel_config: selected ? "SELECTED_CHANNELS" : "CHANNEL_STRATEGY",
  channel_strategy: selected ? null : (o.strategy ?? "ALL_CHANNELS"),
  selected_channels: selected ? [...selected] : [],
});

export interface DemandGenOptions {
  settings?: Row[];
  assets?: Row[];
  signals?: Row[];
  channels?: Row[];
  /** channel controls per ad group; null = the table was not read */
  controls?: Row[] | null;
  goals?: Row[];
  campaign?: CampaignSpec;
  checkSettings?: EvidenceInput["settings"];
}

export function demandGenAccount(o: DemandGenOptions = {}): EvidenceInput {
  const settings = o.settings ?? [
    {
      campaign_id: "61",
      optimization_goal_types: [],
      merchant_center_id: null,
      product_feed_disabled: true,
      feed_label: null,
    },
  ];
  const assets = o.assets ?? DG_FULL_ASSETS;
  const signals = o.signals ?? [
    {
      campaign_id: "61",
      ad_group_id: "611",
      criterion_id: "1",
      criterion_type: "USER_LIST",
      negative: false,
      user_list_id: "77",
    },
  ];
  const channels = o.channels ?? [dgChannel("DISCOVER", 1_000), dgChannel("YOUTUBE", 800)];
  const controls = o.controls === undefined ? [dgControl()] : o.controls;
  const input = buildInput({
    campaigns: [o.campaign ?? DG_CAMPAIGN, SEARCH_CAMPAIGN],
    data: {
      campaignConversionGoals: o.goals ?? [
        { campaign_id: "61", category: "PURCHASE", origin: "WEBSITE", biddable: true },
        { campaign_id: "11", category: "PURCHASE", origin: "WEBSITE", biddable: true },
      ],
    },
    tables: {
      dg_campaign_settings: settings,
      dg_assets: assets,
      dg_audience_signals: signals,
      dg_channel_distribution: channels,
      ...(controls ? { dg_channel_controls: controls } : {}),
    },
    syncedEmpty: ["campaignConversionGoals"],
    ...(o.checkSettings ? { settings: o.checkSettings } : {}),
  });
  return withStatus(input, {
    dg_campaign_settings: settings.length,
    dg_assets: assets.length,
    dg_audience_signals: signals.length,
    dg_channel_distribution: channels.length,
    ...(controls ? { dg_channel_controls: controls.length } : {}),
  });
}

/** The day `n` days before the fixtures' last day, as Google writes a date-time. */
export const dateTimeBefore = (n: number): string => `${dayBefore(LAST_DAY, n)} 00:00:00`;
