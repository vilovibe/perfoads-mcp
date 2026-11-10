// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// A fake shop for tag_exclude: Google Ads (Shopping + Performance Max campaigns and their
// product groups, as REST rows) and Merchant Center (data sources, products whose shown
// custom labels = PerfoAds' own source over the shop's own values). Shape of a real apparel
// shop (every product group includes NAMED custom_label_0 values only, custom_label_4 used
// under one of them), every name and id made up.

import {
  GoogleAdsApiError,
  type LabelTarget,
  type MerchantDataSource,
  type MerchantProduct,
  type MutateResult,
} from "@perfoads/ads-client";
import type { EngineAds, EngineMerchant } from "../facts.js";
import { must } from "./index.js";

type Obj = Record<string, unknown>;

export const CID = "1234567890";
export const MID = "5550001";
export const PRIMARY = `accounts/${MID}/dataSources/100`;
export const OURS = `accounts/${MID}/dataSources/200`;
export const HAND_MADE = `accounts/${MID}/dataSources/300`;

export interface FakeCampaign {
  id: string;
  name: string;
  type: "PERFORMANCE_MAX" | "SHOPPING";
  status: string;
  merchantId: string;
  /** asset group / ad group id -> status */
  groups: Record<string, string>;
}

/** One product group node: [id, parent, type, caseValue?, extra?] in a group. */
export type NodeSpec = [string, string | null, string, (Obj | undefined)?, (Obj | undefined)?];

const cl = (index: number, value?: string): Obj => ({
  productCustomAttribute: value ? { index: `INDEX${index}`, value } : { index: `INDEX${index}` },
});

export const shopCampaigns = (): FakeCampaign[] => [
  {
    id: "101",
    name: "Demo - PMAX - Mugs",
    type: "PERFORMANCE_MAX",
    status: "ENABLED",
    merchantId: MID,
    groups: { "6501": "ENABLED" },
  },
  {
    id: "102",
    name: "Demo - PMAX - Jackets",
    type: "PERFORMANCE_MAX",
    status: "ENABLED",
    merchantId: MID,
    groups: { "6502": "ENABLED" },
  },
  {
    id: "103",
    name: "Demo - PMAX - Hero",
    type: "PERFORMANCE_MAX",
    status: "ENABLED",
    merchantId: MID,
    groups: { "6503": "ENABLED" },
  },
  {
    id: "104",
    name: "Demo - SHOP - Hero",
    type: "SHOPPING",
    status: "ENABLED",
    merchantId: MID,
    groups: { "7701": "ENABLED" },
  },
  {
    id: "105",
    name: "Demo - PMAX - Old test",
    type: "PERFORMANCE_MAX",
    status: "PAUSED",
    merchantId: MID,
    groups: { "6504": "ENABLED" },
  },
];

/** group id -> nodes */
export const shopTrees = (): Record<string, NodeSpec[]> => ({
  "6501": [
    ["1", null, "SUBDIVISION"],
    ["2", "1", "UNIT_INCLUDED", cl(0, "bestseller")],
    ["3", "1", "UNIT_INCLUDED", cl(0, "seller_2026")],
    ["4", "1", "UNIT_INCLUDED", cl(0, "no_data")],
    ["5", "1", "UNIT_EXCLUDED", cl(0)],
  ],
  "6502": [
    ["1", null, "SUBDIVISION"],
    ["2", "1", "SUBDIVISION", cl(0, "bestseller")],
    ["3", "2", "UNIT_INCLUDED", cl(4, "in_stock")],
    ["4", "2", "UNIT_EXCLUDED", cl(4)],
    ["5", "1", "UNIT_INCLUDED", cl(0, "seller_2026")],
    ["6", "1", "UNIT_INCLUDED", cl(0, "no_data")],
    ["7", "1", "UNIT_EXCLUDED", cl(0)],
  ],
  "6503": [
    ["1", null, "SUBDIVISION"],
    ["2", "1", "UNIT_INCLUDED", cl(0, "hero")],
    ["3", "1", "UNIT_INCLUDED", cl(0, "copy-feed")],
    ["4", "1", "UNIT_EXCLUDED", cl(0)],
  ],
  "6504": [["1", null, "UNIT_INCLUDED"]],
  "7701": [
    ["1", null, "SUBDIVISION", undefined, { status: "PAUSED" }],
    ["2", "1", "UNIT", cl(0, "hero"), { cpcBidMicros: "1000000" }],
    ["3", "1", "UNIT", cl(0), { negative: true }],
  ],
});

export interface FakeProduct {
  offerId: string;
  /** What the shop's own sources set (main feed, its own files). */
  base: (string | null)[];
  types: string[];
}

export const shopProducts = (): FakeProduct[] => [
  {
    offerId: "demo_US_1_1",
    base: ["bestseller", "jackets", "high_margin", "fall26", "in_stock"],
    types: ["menswear", "jackets"],
  },
  {
    offerId: "demo_US_2_1",
    base: ["no_data", "jackets", "mid_margin", "fall26", "low_stock"],
    types: ["menswear", "coats"],
  },
  {
    offerId: "demo_US_3_1",
    base: ["seller_2026", "mugs", "high_margin", "core", "in_stock"],
    types: ["mugs", "women"],
  },
  {
    offerId: "demo_US_4_1",
    base: ["hero", "mugs", "high_margin", "core", "in_stock"],
    types: ["mugs", "hero"],
  },
  {
    offerId: "demo_US_5_1",
    base: ["bestseller", "jackets", "high_margin", "fall26", "in_stock"],
    types: ["menswear", "jackets"],
  },
];

export const restIdOf = (offerId: string): string => `en~US~${offerId}`;

export const shopSources = (
  o: { ours?: boolean; attached?: boolean; handMade?: boolean } = {},
): MerchantDataSource[] => {
  const takeFrom = [
    ...(o.ours !== false && o.attached !== false ? [{ supplementalDataSourceName: OURS }] : []),
    ...(o.handMade ? [{ supplementalDataSourceName: HAND_MADE }] : []),
    { self: true },
  ];
  return [
    {
      name: PRIMARY,
      displayName: "Main feed",
      kind: "primary",
      api: false,
      feedLabel: "US",
      contentLanguage: "en",
      takeFrom,
    },
    ...(o.ours !== false
      ? [
          {
            name: OURS,
            displayName: "PerfoAds connector labels",
            kind: "supplemental" as const,
            api: true,
            feedLabel: "US",
            contentLanguage: "en",
            takeFrom: [],
          },
        ]
      : []),
    ...(o.handMade
      ? [
          {
            name: HAND_MADE,
            displayName: "PerfoAds",
            kind: "supplemental" as const,
            api: true,
            feedLabel: "US",
            contentLanguage: "en",
            takeFrom: [],
          },
        ]
      : []),
  ];
};

export interface ShopWorld {
  campaigns: FakeCampaign[];
  trees: Record<string, NodeSpec[]>;
  products: FakeProduct[];
  sources: MerchantDataSource[];
  /** restId -> PerfoAds' own source's labels (index = slot) */
  ours: Record<string, (string | undefined)[]>;
  /** Merchant Center passes our values on only at flush() (the real delay). */
  lag: boolean;
  shown: Record<string, (string | null)[]>;
  scope: boolean | undefined;
  /** Throws for a Merchant Center write (call index from 0, op, restId). */
  failWrite?: (n: number, op: "set" | "clear", restId: string) => unknown;
  /** Throws for a Google Ads mutate (not validateOnly). */
  failMutate?: () => unknown;
  /** Throws for a Merchant Center read. */
  failRead?: () => unknown;
  writes: {
    op: "set" | "clear";
    restId: string;
    slot: number;
    value?: string;
    dataSource: string;
  }[];
  created: { feedLabel: string; contentLanguage: string; displayName: string }[];
  mutates: Obj[][];
  nextId: number;
}

export const shopWorld = (over: Partial<ShopWorld> = {}): ShopWorld => ({
  campaigns: shopCampaigns(),
  trees: shopTrees(),
  products: shopProducts(),
  sources: shopSources(),
  ours: {},
  lag: false,
  shown: {},
  scope: true,
  writes: [],
  created: [],
  mutates: [],
  nextId: 9000,
  ...over,
});

const finalLabels = (w: ShopWorld, p: FakeProduct): (string | null)[] =>
  p.base.map((b, i) => w.ours[restIdOf(p.offerId)]?.[i] ?? b);

/** Merchant Center shows what was written so far (the delay is over). */
export const flush = (w: ShopWorld): void => {
  for (const p of w.products) w.shown[restIdOf(p.offerId)] = finalLabels(w, p);
};

export const fakeMerchant = (w: ShopWorld): EngineMerchant => {
  let n = 0;
  const product = (p: FakeProduct): MerchantProduct => ({
    name: `accounts/${MID}/products/${restIdOf(p.offerId)}`,
    restId: restIdOf(p.offerId),
    offerId: p.offerId,
    contentLanguage: "en",
    feedLabel: "US",
    labels: w.lag ? (w.shown[restIdOf(p.offerId)] ?? p.base) : finalLabels(w, p),
    types: p.types,
    brand: "demo brand",
    local: false,
  });
  const write = (
    op: "set" | "clear",
    t: Pick<LabelTarget, "restId">,
    slot: number,
    dataSource: string,
    value?: string,
  ) => {
    const err = w.failWrite?.(n++, op, t.restId);
    if (err) throw err;
    w.writes.push({
      op,
      restId: t.restId,
      slot,
      dataSource,
      ...(value === undefined ? {} : { value }),
    });
    const labels = (w.ours[t.restId] ??= []);
    labels[slot] = op === "set" ? value : undefined;
  };
  return {
    scopeGranted: async () => w.scope,
    listDataSources: async () => {
      const err = w.failRead?.();
      if (err) throw err;
      return w.sources;
    },
    listProducts: async () => ({ products: w.products.map(product), capped: false }),
    createSupplementalSource: async (_m, p) => {
      w.created.push({
        feedLabel: p.feedLabel,
        contentLanguage: p.contentLanguage,
        displayName: p.displayName,
      });
      const made: MerchantDataSource = {
        name: `accounts/${MID}/dataSources/${w.nextId++}`,
        displayName: p.displayName,
        kind: "supplemental",
        api: true,
        feedLabel: p.feedLabel,
        contentLanguage: p.contentLanguage,
        takeFrom: [],
      };
      w.sources.push(made);
      return made;
    },
    setCustomLabel: async (_m, t, slot, value, ds) => write("set", t, slot, ds, value),
    clearCustomLabel: async (_m, t, slot, ds) => {
      write("clear", t, slot, ds);
      return "cleared";
    },
  };
};

const groupCampaign = (w: ShopWorld, groupId: string): FakeCampaign | undefined =>
  w.campaigns.find((c) => groupId in c.groups);

const pmaxRow = (groupId: string, n: NodeSpec): Obj => ({
  assetGroupListingGroupFilter: {
    resourceName: `customers/${CID}/assetGroupListingGroupFilters/${groupId}~${n[0]}`,
    assetGroup: `customers/${CID}/assetGroups/${groupId}`,
    ...(n[1]
      ? {
          parentListingGroupFilter: `customers/${CID}/assetGroupListingGroupFilters/${groupId}~${n[1]}`,
        }
      : {}),
    type: n[2],
    listingSource: "SHOPPING",
    ...(n[3] ? { caseValue: n[3] } : {}),
  },
});

const shopRow = (groupId: string, campaignId: string, n: NodeSpec): Obj => ({
  campaign: { id: campaignId },
  adGroup: { id: groupId },
  adGroupCriterion: {
    resourceName: `customers/${CID}/adGroupCriteria/${groupId}~${n[0]}`,
    status: (n[4]?.status as string | undefined) ?? "ENABLED",
    negative: n[4]?.negative === true,
    ...(n[4]?.cpcBidMicros ? { cpcBidMicros: n[4].cpcBidMicros } : {}),
    listingGroup: {
      type: n[2],
      ...(n[1]
        ? { parentAdGroupCriterion: `customers/${CID}/adGroupCriteria/${groupId}~${n[1]}` }
        : {}),
      ...(n[3] ? { caseValue: n[3] } : {}),
    },
  },
});

const idsIn = (query: string): string[] => {
  const m = /campaign\.id IN \(([^)]*)\)/.exec(query);
  return m?.[1] ? m[1].split(",").map((x) => x.trim()) : [];
};

/** Applies Google Ads product group operations to the world (all or nothing, like Google). */
const applyOps = (w: ShopWorld, ops: Obj[]): MutateResult => {
  const trees = structuredClone(w.trees);
  const real = new Map<string, string>();
  const results = ops.map((op, index) => {
    const pm = op.assetGroupListingGroupFilterOperation as Obj | undefined;
    const sh = op.adGroupCriterionOperation as Obj | undefined;
    const body = must(pm ?? sh);
    const re = pm
      ? /assetGroupListingGroupFilters\/(\d+)~(-?\d+)$/
      : /adGroupCriteria\/(\d+)~(-?\d+)$/;
    if (typeof body.remove === "string") {
      const m = must(re.exec(body.remove));
      const g = must(m[1]);
      const nodes = must(trees[g]);
      const gone = new Set([must(m[2])]);
      // Shopping: removing a node takes its subtree with it
      for (let again = true; again;) {
        again = false;
        for (const x of nodes)
          if (x[1] && gone.has(x[1]) && !gone.has(x[0])) {
            gone.add(x[0]);
            again = true;
          }
      }
      trees[g] = nodes.filter((x) => !gone.has(x[0]));
      return { index, ok: true, resourceName: body.remove, resource: undefined, errors: [] };
    }
    const c = body.create as Obj;
    const g = must(must(re.exec(String(c.resourceName)))[1]);
    const id = String(w.nextId++);
    real.set(String(c.resourceName), id);
    const parentName = (
      pm ? c.parentListingGroupFilter : (c.listingGroup as Obj).parentAdGroupCriterion
    ) as string | undefined;
    const parent = parentName ? (real.get(parentName) ?? must(must(re.exec(parentName))[2])) : null;
    const lg = (c.listingGroup ?? {}) as Obj;
    const spec: NodeSpec = pm
      ? [id, parent, String(c.type), c.caseValue as Obj | undefined]
      : [
          id,
          parent,
          String(lg.type),
          lg.caseValue as Obj | undefined,
          {
            ...(c.negative === true ? { negative: true } : {}),
            ...(c.cpcBidMicros ? { cpcBidMicros: c.cpcBidMicros } : {}),
            ...(c.status ? { status: c.status } : {}),
          },
        ];
    trees[g] = [...(trees[g] ?? []), spec];
    return {
      index,
      ok: true,
      resourceName: String(c.resourceName).replace(/~-?\d+$/, `~${id}`),
      resource: undefined,
      errors: [],
    };
  });
  w.trees = trees;
  return {
    validateOnly: false,
    googleRequestId: "req-1",
    results,
    failedCount: 0,
    requestErrors: [],
  };
};

export const fakeAds = (w: ShopWorld): EngineAds => ({
  searchAll: async ({ query }) => {
    const rows = ((): Obj[] => {
      if (/FROM customer/.test(query)) {
        return [
          {
            customer: {
              id: CID,
              descriptiveName: "Demo shop",
              currencyCode: "USD",
              timeZone: "America/New_York",
              testAccount: true,
              manager: false,
            },
          },
        ];
      }
      if (/FROM campaign WHERE/.test(query)) {
        return w.campaigns.map((c) => ({
          campaign: {
            id: c.id,
            name: c.name,
            status: c.status,
            advertisingChannelType: c.type,
            shoppingSetting: { merchantId: c.merchantId },
          },
        }));
      }
      if (/FROM asset_group WHERE/.test(query)) {
        const ids = idsIn(query);
        return w.campaigns
          .filter((c) => c.type === "PERFORMANCE_MAX" && ids.includes(c.id))
          .flatMap((c) =>
            Object.entries(c.groups).map(([g, status]) => ({
              campaign: { id: c.id },
              assetGroup: { id: g, name: `Group ${g}`, status },
            })),
          );
      }
      if (/FROM asset_group_listing_group_filter/.test(query)) {
        const groups = [...query.matchAll(/assetGroups\/(\d+)'/g)].map((m) => must(m[1]));
        return groups.flatMap((g) => (w.trees[g] ?? []).map((n) => pmaxRow(g, n)));
      }
      if (/FROM ad_group WHERE/.test(query)) {
        const ids = idsIn(query);
        return w.campaigns
          .filter((c) => c.type === "SHOPPING" && ids.includes(c.id))
          .flatMap((c) =>
            Object.entries(c.groups).map(([g, status]) => ({
              campaign: { id: c.id },
              adGroup: { id: g, name: `Group ${g}`, status },
            })),
          );
      }
      if (/FROM ad_group_criterion/.test(query)) {
        const ids = idsIn(query);
        return Object.entries(w.trees).flatMap(([g, nodes]) => {
          const c = groupCampaign(w, g);
          return c && c.type === "SHOPPING" && ids.includes(c.id)
            ? nodes.map((n) => shopRow(g, c.id, n))
            : [];
        });
      }
      throw new Error(`fake Google Ads: no answer for ${query}`);
    })();
    return { rows, truncated: false, stoppedEarly: false, nextPageToken: undefined, pages: 1 };
  },
  mutateAll: async (ops, o) => {
    if (o.validateOnly) {
      return {
        validateOnly: true,
        googleRequestId: "req-v",
        results: ops.map((_, index) => ({
          index,
          ok: true,
          resourceName: undefined,
          resource: undefined,
          errors: [],
        })),
        failedCount: 0,
        requestErrors: [],
      };
    }
    const err = w.failMutate?.();
    if (err) throw err;
    w.mutates.push(ops);
    return applyOps(w, ops);
  },
});

/** A Google refusal as the transport builds it (Merchant Center replies are Google API errors too). */
export const googleRefusal = (status: number, said: string): GoogleAdsApiError =>
  new GoogleAdsApiError(
    `Google refused the request. Google said: "${said}"`,
    status,
    [],
    undefined,
    undefined,
    undefined,
    "Google refused the request.",
    said,
  );
