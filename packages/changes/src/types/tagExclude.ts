// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// tag_exclude: stop a list of products showing in Shopping / Performance Max campaigns.
// Ported from the PerfoAds app's product exclusion (label route): ONE "exclude" custom
// label, written through a supplemental source PerfoAds made itself in Merchant Center,
// simulated first on every serving listing tree of the account (labelSim). Per campaign:
//   - label only: every product group there already leaves the label out (no campaign change);
//   - label node: a group would still show them and the slot is free: one exclusion of the
//     label is added to that campaign's product groups;
//   - item ids: anything else (or the label can't be used): the products are excluded one by
//     one in the campaign's product groups (listingTree).
// Unknown is unsafe: a tree PerfoAds can't place a product in never counts as dropping it.
// Writes: the labels first (each one field, in PerfoAds' own source only; a part that fails
// is taken back), then the product groups in one atomic Mutate. Undo puts the old label back
// on exactly the products this change wrote (refused while another applied tag_exclude keeps
// them out with the same label) and puts the product groups back as they were.

import { z } from "zod";
import {
  AdsInDoubtError,
  AdsNetworkError,
  AdsNotAllowedError,
  AdsNotSentError,
  GoogleAdsApiError,
  merchantAccessProblem,
  type LabelTarget,
  type MerchantDataSource,
  type MerchantProduct,
  type MutateResult,
  type OperationResult,
} from "@perfoads/ads-client";
import { howToRun } from "@perfoads/store";
import { readFailed } from "../account.js";
import { ChangeError } from "../errors.js";
import type { AffectedEntity, EngineMerchant } from "../facts.js";
import { asObject, asString, isObject, type JsonObject } from "../json.js";
import {
  DEFAULT_EXCLUDE_VALUE,
  EXCLUDE_LABEL_VALUE_RE,
  badgeNodesOfListingTree,
  chooseExcludeSlot,
  labelIndexOf,
  labelRouteFor,
  simulateLabelExclusion,
  treeCanServe,
  type BadgeNode,
  type BadgeProduct,
  type LabelRoute,
  type LabelSimResult,
  type SimCampaign,
  type SlotChoice,
} from "../productExclusion/labelSim.js";
import {
  MAX_EXCLUDE_IDS,
  MAX_EXCLUDE_OPERATIONS,
  ProductExclusionError,
  buildRestoreTreeOps,
  normalizeItemIds,
  parsePmaxFilterRows,
  parseShoppingCriterionRows,
  planProductExclusion,
  tempIdCounter,
  treeFingerprint,
  type ExclusionChannel,
  type ExclusionPlan,
  type ListingNode,
  type ListingTree,
  type TempIds,
} from "../productExclusion/listingTree.js";
import type { ActionType, Planned, ReadCtx, ReadTarget, Touched } from "./actionType.js";
import { assertId, gaql, idList, idSchema, plural, unique } from "./common.js";

const TYPE = "tag_exclude";
/** The name of the one supplemental source PerfoAds makes (never a source the user made). */
export const OWN_SOURCE_NAME = "PerfoAds connector labels";
const MAX_CAMPAIGNS = 10;
/** Listing group rows read per kind; more = the trees are too big to judge here. */
const TREE_ROWS_MAX = 10_000;
const CAMPAIGNS_MAX = 1000;

const LISTING_CASE_VALUE_FIELDS = [
  "case_value.product_brand.value",
  "case_value.product_category.category_id",
  "case_value.product_category.level",
  "case_value.product_channel.channel",
  "case_value.product_condition.condition",
  "case_value.product_custom_attribute.index",
  "case_value.product_custom_attribute.value",
  "case_value.product_item_id.value",
  "case_value.product_type.level",
  "case_value.product_type.value",
];

const merchantIdSchema = z.string().regex(/^\d{1,20}$/, "must be a Merchant Center id (digits)");

export const tagExcludeInput = z
  .object({
    merchant_id: merchantIdSchema,
    /** Google Ads product item ids (the offer ids), as the finding names them. */
    item_ids: z.array(z.string().min(1).max(150)).min(1).max(MAX_EXCLUDE_IDS),
    /** The campaigns that must stop showing them (the finding's campaigns). */
    campaign_ids: z.array(idSchema).min(1).max(MAX_CAMPAIGNS),
    /** The account's own exclude label; missing = PerfoAds picks a slot, value "exclude". */
    label: z
      .object({
        slot: z.number().int().min(0).max(4),
        value: z.string().regex(EXCLUDE_LABEL_VALUE_RE, "lowercase letters, digits, - and _"),
      })
      .strict()
      .optional(),
  })
  .strict();

const productTargetSchema = z
  .object({
    restId: z.string().min(1).max(600),
    offerId: z.string().min(1).max(150),
    contentLanguage: z.string().max(20),
    feedLabel: z.string().max(40),
  })
  .strict();

const listingNodeSchema = z
  .object({
    resourceName: z.string(),
    parent: z.string().nullable(),
    kind: z.enum(["SUBDIVISION", "INCLUDED", "EXCLUDED"]),
    caseValue: z.record(z.string(), z.unknown()).nullable(),
    cpcBidMicros: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  })
  .strict();

const treeTargetSchema = z
  .object({
    channel: z.enum(["PMAX", "SHOPPING"]),
    campaignId: idSchema,
    groupId: idSchema,
    snapshot: z.array(listingNodeSchema),
  })
  .strict();

const undoBody = z
  .object({
    merchant_id: merchantIdSchema,
    slot: z.number().int().min(0).max(4),
    value: z.string().regex(EXCLUDE_LABEL_VALUE_RE),
    source: z.string().nullable(),
    products: z.array(productTargetSchema.extend({ before: z.string().max(200) })),
    trees: z.array(treeTargetSchema),
    label_nodes: z.array(idSchema).max(MAX_CAMPAIGNS).default([]),
  })
  .strict();

const undoInputSchema = z.union([tagExcludeInput, z.object({ undo: undoBody }).strict()]);

export type TagExcludeInput = z.infer<typeof undoInputSchema>;
type ExcludeInput = z.infer<typeof tagExcludeInput>;
type UndoInput = z.infer<typeof undoBody>;
type TreeTarget = z.infer<typeof treeTargetSchema>;

/** What the read-back reads (stored as ReadTarget.scope). */
interface Scope {
  slot: number;
  value: string;
  source: string | null;
  products: LabelTarget[];
  /** Products this change keeps out with the label (written + already carrying it). */
  claims: string[];
  trees: TreeTarget[];
  /** Campaigns where this change added an exclusion of the label (undo removes it). */
  labelNodes: string[];
  /** Campaigns where this change relies on the label alone (an exclusion already there). */
  labelOnly: string[];
}

const labelKey = (restId: string, slot: number): string => `label:${restId}:${slot}`;
const treeKey = (groupId: string): string => `tree:${groupId}`;
const GONE = "(gone)";
const lbl = (slot: number, value: string): string => `custom_label_${slot} = ${value}`;

const READ_BACK_LAG =
  "Applied. Merchant Center passes a new label on in a few minutes to a few hours, so it does not show yet; nothing is sent again. Google Ads stops showing the products once it does.";

// ---- Merchant Center access ----------------------------------------------------------

const scopeHowTo = (): string =>
  `To turn it on, run \`${howToRun("auth --merchant-center")}\` in a terminal and tick the Merchant Center box on Google's screen; \`${howToRun("doctor")}\` shows whether it is on.`;

const merchantOf = (ctx: ReadCtx): EngineMerchant => {
  if (!ctx.merchant) {
    throw new ChangeError(
      "not_allowed",
      "This server has no Merchant Center connection, so products can't be tagged. Nothing was changed.",
    );
  }
  return ctx.merchant;
};

const needScope = async (ctx: ReadCtx): Promise<EngineMerchant> => {
  const m = merchantOf(ctx);
  let granted: boolean | undefined;
  try {
    granted = await m.scopeGranted();
  } catch (err) {
    throw readFailed("the Google sign-in", err);
  }
  if (granted === false) {
    throw new ChangeError(
      "not_allowed",
      `Merchant Center access is not turned on for this sign-in, so PerfoAds can't read or label products. ${scopeHowTo()} Nothing was changed.`,
    );
  }
  return m;
};

/** A Merchant Center read: access problems in plain words, anything else read_failed. */
const mcRead = async <T>(merchantId: string, what: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    const problem = merchantAccessProblem(err);
    if (problem === "scope") {
      throw new ChangeError(
        "not_allowed",
        `Google says this sign-in has no Merchant Center access. ${scopeHowTo()} Nothing was changed.`,
      );
    }
    if (problem === "api_disabled") {
      throw new ChangeError(
        "not_allowed",
        "The Merchant API is turned off in your Google Cloud project. Turn it on in Google Cloud Console (APIs & Services > Library > Merchant API), then try again. Nothing was changed.",
      );
    }
    if (problem === "not_registered") {
      throw new ChangeError(
        "not_allowed",
        `Your Google Cloud project is not registered with Merchant Center ${merchantId} yet (Google asks for this once per project). Register it in Merchant Center (Settings > Developer tools or Google's Merchant API "register GCP" step), then try again. Nothing was changed.`,
      );
    }
    if (problem === "no_access") {
      throw new ChangeError(
        "not_allowed",
        `This Google sign-in can't open Merchant Center ${merchantId}. Nothing was changed.`,
      );
    }
    if (err instanceof ChangeError) throw err;
    const said = err instanceof GoogleAdsApiError && err.googleSaid ? err.googleSaid : undefined;
    throw new ChangeError(
      "read_failed",
      `Couldn't read ${what} from Merchant Center, so nothing was changed.`,
      said,
    );
  }
};

// ---- Merchant Center sources (pure) ------------------------------------------------

/**
 * Primaries that serve one (feedLabel, contentLanguage) pair. Exact matches win; when there
 * are none, primaries with BOTH fields empty ("all labels / languages"). Never mixes the two.
 * Ported from the app's matchPrimaries.
 */
export const matchPrimaries = (
  sources: readonly MerchantDataSource[],
  feedLabel: string,
  contentLanguage: string,
): MerchantDataSource[] => {
  const exact: MerchantDataSource[] = [];
  const catchAll: MerchantDataSource[] = [];
  for (const ds of sources) {
    if (ds.kind !== "primary") continue;
    if (ds.feedLabel === feedLabel && ds.contentLanguage === contentLanguage) exact.push(ds);
    else if (ds.feedLabel === "" && ds.contentLanguage === "") catchAll.push(ds);
  }
  return exact.length > 0 ? exact : catchAll;
};

/** A primary with no rule reads only itself. */
const ruleOf = (ds: MerchantDataSource) =>
  ds.takeFrom.length > 0 ? ds.takeFrom : [{ self: true }];

/**
 * The sources a primary serving the pair reads BEFORE `ours` (first source that sets an
 * attribute wins): display names, "your main feed" for the primary itself. A primary that
 * does not read ours at all counts as everything above. Ported from the app's rankedAbove.
 */
export const rankedAbove = (
  sources: readonly MerchantDataSource[],
  target: { feedLabel: string; contentLanguage: string },
  ours: string,
): string[] => {
  const names = new Map(sources.map((d) => [d.name, d.displayName || d.name]));
  const out = new Set<string>();
  for (const primary of matchPrimaries(sources, target.feedLabel, target.contentLanguage)) {
    const rule = ruleOf(primary);
    const at = rule.findIndex((ref) => ref.supplementalDataSourceName === ours);
    for (const ref of at < 0 ? rule : rule.slice(0, at)) {
      out.add(
        ref.self
          ? "your main feed"
          : String(
              names.get(ref.supplementalDataSourceName ?? "") ??
                ref.supplementalDataSourceName ??
                "another source",
            ),
      );
    }
  }
  return [...out];
};

const pairKey = (merchantId: string, feedLabel: string, contentLanguage: string): string =>
  `${merchantId}:${feedLabel}:${contentLanguage}`;

/** Our source for the pair, as Merchant Center has it now; reason when it can't take the label. */
const ownSourceState = (
  ctx: ReadCtx,
  merchantId: string,
  sources: readonly MerchantDataSource[],
  pair: { feedLabel: string; contentLanguage: string },
): { source: string | null; create: boolean; problem: string | null } => {
  const stored = ctx.ownSources?.get(pairKey(merchantId, pair.feedLabel, pair.contentLanguage));
  const found = stored ? sources.find((s) => s.name === stored) : undefined;
  if (!stored || !found) {
    return {
      source: null,
      create: ctx.ownSources !== undefined,
      problem: `PerfoAds has no label source in Merchant Center ${merchantId} yet${stored ? " (the one it made was deleted)" : ""}`,
    };
  }
  if (found.kind !== "supplemental" || !found.api) {
    return {
      source: null,
      create: false,
      problem: "PerfoAds' label source is not a supplemental API source any more",
    };
  }
  const primaries = matchPrimaries(sources, pair.feedLabel, pair.contentLanguage);
  if (primaries.length === 0) {
    return {
      source: found.name,
      create: false,
      problem: "no main feed in Merchant Center serves these products' feed label and language",
    };
  }
  if (!primaries.every((p) => ruleOf(p).some((r) => r.supplementalDataSourceName === found.name))) {
    return {
      source: found.name,
      create: false,
      problem: `your main feed in Merchant Center does not read PerfoAds' label source "${OWN_SOURCE_NAME}" yet (in Merchant Center, open your main feed's settings and add that source to it; then propose this again)`,
    };
  }
  return { source: found.name, create: false, problem: null };
};

// ---- Google Ads reads ----------------------------------------------------------------

interface LiveCampaign {
  id: string;
  name: string | null;
  status: string | null;
  channel: ExclusionChannel | null;
  merchantId: string | null;
}

interface LiveTrees {
  channel: ExclusionChannel;
  trees: ListingTree[];
  emptyGroups: string[];
  groupStatuses: Record<string, string>;
  /** The trees could not be read (never counted as dropping anything). */
  unread: boolean;
}

const readCampaigns = async (ctx: ReadCtx): Promise<Map<string, LiveCampaign>> => {
  const rows = await gaql(
    ctx,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.shopping_setting.merchant_id FROM campaign WHERE campaign.advertising_channel_type IN ('SHOPPING', 'PERFORMANCE_MAX') AND campaign.status != 'REMOVED' LIMIT ${CAMPAIGNS_MAX + 1}`,
    "the Shopping and Performance Max campaigns",
    CAMPAIGNS_MAX + 1,
  );
  if (rows.length > CAMPAIGNS_MAX) {
    throw new ChangeError(
      "not_allowed",
      `This account has more than ${CAMPAIGNS_MAX} Shopping and Performance Max campaigns; PerfoAds can't check them all. Nothing was changed.`,
    );
  }
  const out = new Map<string, LiveCampaign>();
  for (const r of rows) {
    const c = asObject(r.campaign);
    const id = String(c.id ?? "");
    const type = asString(c.advertisingChannelType);
    const mid = asObject(c.shoppingSetting).merchantId;
    out.set(id, {
      id,
      name: asString(c.name) ?? null,
      status: asString(c.status) ?? null,
      channel: type === "SHOPPING" ? "SHOPPING" : type === "PERFORMANCE_MAX" ? "PMAX" : null,
      merchantId: mid === undefined || mid === null || mid === "" ? null : String(mid),
    });
  }
  return out;
};

const capped = <T>(rows: T[], what: string): T[] => {
  if (rows.length > TREE_ROWS_MAX) {
    throw new ChangeError(
      "not_allowed",
      `The ${what} are too big to read in one go (more than ${TREE_ROWS_MAX}); PerfoAds can't check them. Nothing was changed.`,
    );
  }
  return rows;
};

/** LIVE product groups of these campaigns (any read failure throws; a tree it can't place = unread). */
const readTrees = async (
  ctx: ReadCtx,
  campaigns: readonly LiveCampaign[],
): Promise<Map<string, LiveTrees>> => {
  const cid = ctx.target.customerId;
  const out = new Map<string, LiveTrees>();
  const pmax = campaigns.filter((c) => c.channel === "PMAX").map((c) => c.id);
  const shop = campaigns.filter((c) => c.channel === "SHOPPING").map((c) => c.id);
  const blank = (channel: ExclusionChannel): LiveTrees => ({
    channel,
    trees: [],
    emptyGroups: [],
    groupStatuses: {},
    unread: false,
  });
  const fill = (
    channel: ExclusionChannel,
    groupRows: { campaignId: string; id: string; name: string; status: string }[],
    nodeRows: { groupId: string; row: JsonObject }[],
  ) => {
    const campaignOf = new Map(groupRows.map((g) => [g.id, g.campaignId]));
    for (const g of groupRows) {
      const t = out.get(g.campaignId) ?? blank(channel);
      t.groupStatuses[g.id] = g.status;
      out.set(g.campaignId, t);
    }
    const byCampaign = new Map<string, JsonObject[]>();
    for (const n of nodeRows) {
      const c = campaignOf.get(n.groupId);
      if (!c) continue;
      const list = byCampaign.get(c) ?? [];
      list.push(n.row);
      byCampaign.set(c, list);
    }
    for (const [c, t] of out) {
      if (t.channel !== channel) continue;
      const names = Object.fromEntries(
        groupRows.filter((g) => g.campaignId === c).map((g) => [g.id, g.name]),
      );
      try {
        const rows = byCampaign.get(c) ?? [];
        t.trees =
          channel === "PMAX"
            ? parsePmaxFilterRows(rows, names)
            : parseShoppingCriterionRows(rows, names);
      } catch (err) {
        if (!(err instanceof ProductExclusionError)) throw err;
        t.unread = true;
      }
      const withTree = new Set(t.trees.map((x) => x.groupId));
      t.emptyGroups = Object.keys(names).filter((id) => !withTree.has(id));
    }
  };
  if (pmax.length > 0) {
    const groups = capped(
      await gaql(
        ctx,
        `SELECT campaign.id, asset_group.id, asset_group.name, asset_group.status FROM asset_group WHERE campaign.id IN ${idList(pmax)} AND asset_group.status != 'REMOVED'`,
        "the asset groups",
        TREE_ROWS_MAX + 1,
      ),
      "asset groups",
    ).map((r) => {
      const g = asObject(r.assetGroup);
      return {
        campaignId: String(asObject(r.campaign).id ?? ""),
        id: String(g.id ?? ""),
        name: asString(g.name) ?? "",
        status: asString(g.status) ?? "",
      };
    });
    const ids = groups.map((g) => assertId(g.id));
    const nodes: { groupId: string; row: JsonObject }[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const inList = ids
        .slice(i, i + 200)
        .map((id) => `'customers/${cid}/assetGroups/${id}'`)
        .join(", ");
      const rows = capped(
        await gaql(
          ctx,
          `SELECT asset_group_listing_group_filter.resource_name, asset_group_listing_group_filter.asset_group, asset_group_listing_group_filter.parent_listing_group_filter, asset_group_listing_group_filter.type, asset_group_listing_group_filter.listing_source, ${LISTING_CASE_VALUE_FIELDS.map((f) => `asset_group_listing_group_filter.${f}`).join(", ")} FROM asset_group_listing_group_filter WHERE asset_group_listing_group_filter.asset_group IN (${inList}) AND asset_group_listing_group_filter.listing_source = 'SHOPPING'`,
          "the product groups",
          TREE_ROWS_MAX + 1,
        ),
        "product groups",
      );
      for (const row of rows) {
        const rn = asString(asObject(row.assetGroupListingGroupFilter).resourceName) ?? "";
        const m = /assetGroupListingGroupFilters\/(\d+)~/.exec(rn);
        if (m?.[1]) nodes.push({ groupId: m[1], row });
      }
    }
    fill("PMAX", groups, nodes);
  }
  if (shop.length > 0) {
    const groups = capped(
      await gaql(
        ctx,
        `SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id IN ${idList(shop)} AND ad_group.status != 'REMOVED' AND ad_group.type = 'SHOPPING_PRODUCT_ADS'`,
        "the ad groups",
        TREE_ROWS_MAX + 1,
      ),
      "ad groups",
    ).map((r) => {
      const g = asObject(r.adGroup);
      return {
        campaignId: String(asObject(r.campaign).id ?? ""),
        id: String(g.id ?? ""),
        name: asString(g.name) ?? "",
        status: asString(g.status) ?? "",
      };
    });
    const rows = capped(
      await gaql(
        ctx,
        `SELECT campaign.id, ad_group.id, ad_group_criterion.resource_name, ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.cpc_bid_micros, ad_group_criterion.listing_group.type, ad_group_criterion.listing_group.parent_ad_group_criterion, ${LISTING_CASE_VALUE_FIELDS.map((f) => `ad_group_criterion.listing_group.${f}`).join(", ")} FROM ad_group_criterion WHERE campaign.id IN ${idList(shop)} AND ad_group_criterion.type = 'LISTING_GROUP' AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'`,
        "the product groups",
        TREE_ROWS_MAX + 1,
      ),
      "product groups",
    );
    fill(
      "SHOPPING",
      groups,
      rows.map((row) => ({ groupId: String(asObject(row.adGroup).id ?? ""), row })),
    );
  }
  for (const c of campaigns) if (c.channel && !out.has(c.id)) out.set(c.id, blank(c.channel));
  return out;
};

/** Serving trees of every enabled campaign this Merchant Center feeds (app: liveLabelSimulation). */
const simCampaignsOf = (
  campaigns: readonly LiveCampaign[],
  trees: Map<string, LiveTrees>,
): SimCampaign[] =>
  campaigns.map((c) => {
    const live = trees.get(c.id);
    const channel = c.channel ?? "PMAX";
    const sim: SimCampaign = { campaignId: c.id, campaignName: c.id, channel, groups: [] };
    if (!live || live.unread) return { ...sim, unread: true };
    for (const t of live.trees) {
      if (!treeCanServe("ENABLED", live.groupStatuses[t.groupId], channel === "SHOPPING")) continue;
      const nodes: BadgeNode[] | null = badgeNodesOfListingTree(t.nodes);
      if (!nodes) return { ...sim, unread: true };
      sim.groups.push(nodes);
    }
    // a serving group with no product filter shows every product
    for (const g of live.emptyGroups) {
      if (treeCanServe("ENABLED", live.groupStatuses[g], channel === "SHOPPING"))
        sim.groups.push([]);
    }
    return sim;
  });

// ---- the plan ------------------------------------------------------------------------

interface CampaignPlan {
  campaign: LiveCampaign;
  route: LabelRoute;
  why: string;
  plan: ExclusionPlan | null;
  /** Nothing to send here: already excluded in the campaign. */
  already: boolean;
}

const sameCampaignMerchant = (c: LiveCampaign, merchantId: string): boolean =>
  c.channel !== null && c.merchantId !== null && c.merchantId === merchantId;

const planExclude = async (ctx: ReadCtx, input: ExcludeInput): Promise<Planned> => {
  const cid = ctx.target.customerId;
  const mid = input.merchant_id;
  let itemIds: string[];
  try {
    itemIds = normalizeItemIds(input.item_ids);
  } catch (err) {
    throw new ChangeError("invalid_input", err instanceof Error ? err.message : "Bad item ids.");
  }
  const campaignIds = unique(input.campaign_ids);
  const merchant = await needScope(ctx);

  const all = await readCampaigns(ctx);
  for (const id of campaignIds) {
    const c = all.get(id);
    if (!c) throw new ChangeError("not_found", `Campaign ${id} was not found in this account.`);
    if (!c.channel) {
      throw new ChangeError(
        "not_allowed",
        `Campaign ${id} is not a Shopping or Performance Max campaign.`,
      );
    }
    if (c.merchantId !== mid) {
      throw new ChangeError(
        "not_allowed",
        `Campaign ${id} does not show products from Merchant Center ${mid}. Nothing was changed.`,
      );
    }
  }
  // every running campaign this Merchant Center feeds is simulated; the asked ones are planned
  const serving = [...all.values()].filter(
    (c) => c.status === "ENABLED" && sameCampaignMerchant(c, mid),
  );
  const read = unique([...serving.map((c) => c.id), ...campaignIds]).flatMap((id) => {
    const c = all.get(id);
    return c ? [c] : [];
  });
  const trees = await readTrees(ctx, read);
  const sims0 = simCampaignsOf(serving, trees);

  const sources = await mcRead(mid, "the data sources", () => merchant.listDataSources(mid));
  const shownListing = await mcRead(mid, "the products", () => merchant.listProducts(mid));
  // labels another applied tag_exclude wrote count as there, even while Merchant Center has
  // not passed them on yet (never written twice, counted as carriers everywhere)
  const pending = new Map<string, Map<number, string>>();
  for (const h of heldScopes(ctx, mid)) {
    for (const r of unique([...h.scope.claims, ...h.scope.products.map((p) => p.restId)])) {
      const m = pending.get(r) ?? new Map<number, string>();
      m.set(h.scope.slot, h.scope.value);
      pending.set(r, m);
    }
  }
  const listing = {
    capped: shownListing.capped,
    products: shownListing.products.map((p) => {
      const m = pending.get(p.restId);
      return m ? { ...p, labels: p.labels.map((l, i) => m.get(i) ?? l) } : p;
    }),
  };
  const shownOf = new Map(shownListing.products.map((p) => [p.restId, p.labels]));
  const wanted = new Set(itemIds);
  const chosen = listing.products.filter((p) => !p.local && wanted.has(p.offerId.toLowerCase()));
  const found = new Set(chosen.map((p) => p.offerId.toLowerCase()));
  const missing = itemIds.filter((id) => !found.has(id));
  const pairs = unique(chosen.map((p) => `${p.feedLabel}\u0000${p.contentLanguage}`));

  const asSim = (p: MerchantProduct): BadgeProduct => ({
    id: p.offerId.toLowerCase(),
    labels: p.labels,
    types: p.types,
    brand: p.brand,
    channel: "online",
  });
  const products = chosen.map(asSim);
  const simulate = (slot: number, value: string): LabelSimResult[] =>
    simulateLabelExclusion({ campaigns: sims0, products, slot, value });

  // Why the label can't be used at all (then every asked campaign goes item ids)
  let labelOff: string | null = null;
  let source: string | null = null;
  let createSource: { feedLabel: string; contentLanguage: string } | null = null;
  if (missing.length > 0) {
    labelOff = `${missing.length} of these products ${missing.length === 1 ? "is" : "are"} not in Merchant Center ${mid}${listing.capped ? " (or past the products PerfoAds reads there)" : ""}`;
  } else if (pairs.length > 1) {
    labelOff =
      "these products sit in more than one feed (feed label or language) in Merchant Center";
  } else {
    const [feedLabel = "", contentLanguage = ""] = (pairs[0] ?? "").split("\u0000");
    const own = ownSourceState(ctx, mid, sources, { feedLabel, contentLanguage });
    source = own.source;
    if (own.create) createSource = { feedLabel, contentLanguage };
    labelOff = own.problem;
  }

  let choice: SlotChoice | null = null;
  if (!labelOff) {
    const usage = [0, 1, 2, 3, 4].map((slot) => ({
      slot,
      free: !listing.capped && listing.products.every((p) => p.labels[slot] === null),
    }));
    const picked = chooseExcludeSlot({ configured: input.label ?? null, usage, simulate });
    if ("refused" in picked) labelOff = picked.refused;
    else choice = picked;
  }
  // a source Merchant Center reads before ours that sets this slot on these products would
  // overrule the label (app: labelSourceGate); a value it shows that is not ours = set there
  if (choice && source) {
    const slot = choice.slot;
    const value = choice.value;
    const overruled = chosen.filter((p) => p.labels[slot] !== null && p.labels[slot] !== value);
    const above = rankedAbove(
      sources,
      { feedLabel: chosen[0]?.feedLabel ?? "", contentLanguage: chosen[0]?.contentLanguage ?? "" },
      source,
    );
    if (overruled.length > 0 && above.length > 0) {
      labelOff = `Merchant Center reads ${above.map((n) => `"${n}"`).join(", ")} before PerfoAds' label source, and it sets custom_label_${slot} on ${overruled.length} of these products, so the label would be overruled`;
      choice = null;
    }
  }
  const slot = choice?.slot ?? input.label?.slot ?? 0;
  const value = choice?.value ?? input.label?.value ?? DEFAULT_EXCLUDE_VALUE;
  const othersCarrying = choice
    ? listing.products.filter(
        (p) => !wanted.has(p.offerId.toLowerCase()) && p.labels[slot] === value,
      ).length
    : 0;

  // per asked campaign: the route, then the product group change
  const temp: TempIds = tempIdCounter();
  const plans: CampaignPlan[] = [];
  for (const id of campaignIds) {
    const campaign = all.get(id);
    if (!campaign) continue; // checked above
    const sim = choice?.sims.find((r) => r.campaignId === id);
    let { route, why } =
      labelOff || !choice
        ? { route: "item_id" as LabelRoute, why: labelOff ?? "the label can't be used here" }
        : labelRouteFor(sim, choice);
    if (route === "label_node" && othersCarrying > 0) {
      // the new label node would stop those too: never a change wider than asked
      route = "item_id";
      why = `${plural(othersCarrying, "other product already carries", "other products already carry")} ${lbl(slot, value)}, and excluding the label here would stop them too`;
    }
    if (route === "label_only") {
      plans.push({ campaign, route, why, plan: null, already: false });
      continue;
    }
    const live = trees.get(id);
    if (!live || live.unread) {
      throw new ChangeError(
        "not_allowed",
        `Couldn't read every product group of campaign ${id}, so PerfoAds can't exclude the products there safely. Nothing was changed.`,
      );
    }
    try {
      const plan = planProductExclusion(
        live.channel,
        cid,
        live.trees,
        route === "label_node" ? [value] : itemIds,
        route === "label_node" ? { label: { index: labelIndexOf(slot), value }, temp } : { temp },
      );
      plans.push({ campaign, route, why, plan, already: false });
    } catch (err) {
      if (!(err instanceof ProductExclusionError)) throw err;
      if (err.code === "NOTHING_TO_CHANGE") {
        plans.push({ campaign, route, why, plan: null, already: true });
        continue;
      }
      throw new ChangeError("not_allowed", `Campaign ${id}: ${err.message} Nothing was changed.`);
    }
  }

  const usesLabel = choice !== null && plans.some((p) => p.route !== "item_id");
  const toWrite = usesLabel ? chosen.filter((p) => p.labels[slot] !== value) : [];
  const alreadyCarrying = usesLabel ? chosen.length - toWrite.length : 0;
  const adsOps = plans.flatMap((p) => p.plan?.operations ?? []);
  if (adsOps.length > MAX_EXCLUDE_OPERATIONS) {
    throw new ChangeError(
      "not_allowed",
      `This needs ${adsOps.length} edits in Google Ads (limit ${MAX_EXCLUDE_OPERATIONS}). Pick fewer products or campaigns. Nothing was changed.`,
    );
  }
  if (toWrite.length === 0 && adsOps.length === 0) {
    throw new ChangeError(
      "nothing_to_change",
      "Nothing to change: these products are already excluded in these campaigns.",
    );
  }

  const targets: LabelTarget[] = toWrite.map((p) => ({
    restId: p.restId,
    offerId: p.offerId,
    contentLanguage: p.contentLanguage,
    feedLabel: p.feedLabel,
  }));
  const ops: JsonObject[] = [];
  if (createSource) {
    ops.push({
      merchantCreateSource: {
        merchantId: mid,
        key: pairKey(mid, createSource.feedLabel, createSource.contentLanguage),
        displayName: OWN_SOURCE_NAME,
        feedLabel: createSource.feedLabel,
        contentLanguage: createSource.contentLanguage,
      },
    });
  }
  for (const t of targets) {
    ops.push({
      merchantSetLabel: { merchantId: mid, dataSource: source, slot, value, product: t },
    });
  }
  ops.push(...adsOps);

  const touched: Touched = {};
  const expected: Touched = {};
  for (const p of toWrite) {
    touched[labelKey(p.restId, slot)] = shownOf.get(p.restId)?.[slot] ?? "";
    expected[labelKey(p.restId, slot)] = value;
  }
  const treeTargets: TreeTarget[] = [];
  for (const p of plans) {
    if (!p.plan) continue;
    const live = trees.get(p.campaign.id);
    if (!live) continue;
    for (const g of p.plan.changedGroupIds) {
      const tree = live.trees.find((t) => t.groupId === g);
      if (!tree) continue;
      touched[treeKey(g)] = treeFingerprint(live.channel, tree.nodes);
      expected[treeKey(g)] = p.plan.afterFingerprints[g] ?? "";
      treeTargets.push({
        channel: live.channel,
        campaignId: p.campaign.id,
        groupId: g,
        snapshot: tree.nodes,
      });
    }
  }
  const scope: Scope = {
    slot,
    value,
    source: usesLabel ? source : null,
    products: targets,
    claims: usesLabel ? chosen.map((p) => p.restId).sort() : [],
    trees: treeTargets,
    labelNodes: usesLabel
      ? plans.filter((p) => p.route === "label_node" && p.plan).map((p) => p.campaign.id)
      : [],
    labelOnly: usesLabel
      ? plans
          .filter((p) => p.route === "label_only" || (p.route === "label_node" && p.already))
          .map((p) => p.campaign.id)
      : [],
  };

  // the approval: server lines only (counts and ids, no Google or model text)
  const diff: string[] = [];
  if (createSource) {
    diff.push(
      `Merchant Center ${mid}: makes PerfoAds' own label source "${OWN_SOURCE_NAME}" (empty; it changes nothing until your main feed reads it, then later exclusions can use the label).`,
    );
  }
  if (toWrite.length > 0) {
    diff.push(
      `Merchant Center ${mid}: writes ${lbl(slot, value)} on ${plural(toWrite.length, "product")}, in PerfoAds' own source only (your main feed and your other sources are not changed).`,
    );
  }
  for (const p of plans) {
    const id = p.campaign.id;
    if (p.route === "label_only") {
      diff.push(`Campaign ${id}: the label alone takes them out (${p.why}).`);
    } else if (p.already) {
      diff.push(`Campaign ${id}: these products are already excluded here; nothing changes.`);
    } else if (p.route === "label_node") {
      diff.push(
        `Campaign ${id}: adds an exclusion of ${lbl(slot, value)} to ${plural(p.plan?.changedGroupIds.length ?? 0, "product group")} (${p.why}).`,
      );
    } else {
      diff.push(
        `Campaign ${id}: excludes ${plural(p.plan?.excludedIds.length ?? 0, "product")} one by one in ${plural(p.plan?.changedGroupIds.length ?? 0, "product group")} (${p.why}).`,
      );
    }
  }

  const warnings: string[] = [];
  if (toWrite.length > 0) warnings.push(READ_BACK_LAG.replace(/^Applied\. /, ""));
  if (alreadyCarrying > 0) {
    warnings.push(
      `${plural(alreadyCarrying, "of these products already carries", "of these products already carry")} ${lbl(slot, value)} (set outside this change); PerfoAds does not write ${alreadyCarrying === 1 ? "it" : "them"} again.`,
    );
  }
  if (choice && usesLabel) {
    if (!choice.free) {
      warnings.push(
        `custom_label_${slot} already holds other values in this Merchant Center; PerfoAds checked every running Shopping and Performance Max campaign of this account, and each one leaves ${lbl(slot, value)} out.`,
      );
    }
    for (const r of choice.sims) {
      if (campaignIds.includes(r.campaignId)) continue;
      if (r.leaves.length > 0) {
        warnings.push(
          `Campaign ${r.campaignId}: ${plural(r.leaves.length, "of these products stops", "of these products stop")} showing there too (the label lands on an excluded group).`,
        );
      } else if (r.stillServes.length > 0) {
        warnings.push(
          `Campaign ${r.campaignId}: ${plural(r.stillServes.length, "of these products keeps", "of these products keep")} showing there, as today.`,
        );
      }
    }
    warnings.push(
      "This Merchant Center can feed other Google Ads accounts too; PerfoAds checked only this one, and the label can change what shows there.",
    );
  }
  warnings.push(
    toWrite.length > 0
      ? "Undo puts the old label back on the products this change wrote it on and puts the product groups back as they were."
      : "Undo puts the product groups back as they were.",
  );

  const leavesElsewhere = usesLabel
    ? (choice?.sims ?? [])
        .filter((r) => !campaignIds.includes(r.campaignId) && r.leaves.length > 0)
        .map((r) => r.campaignId)
    : [];
  const affected: AffectedEntity[] = unique([...campaignIds, ...leavesElsewhere]).map((id) => {
    const c = all.get(id);
    return { kind: "campaign", id, name: c?.name ?? null, status: c?.status ?? null };
  });
  const created = adsOps.filter(
    (o) => isObject(Object.values(o)[0]) && "create" in asObject(Object.values(o)[0]),
  ).length;
  return {
    ops,
    readTarget: { resource: "merchant_labels", id: mid, scope: scope as unknown as JsonObject },
    touched,
    expected,
    diff,
    affected,
    facts: {
      affectedCampaignIds: affected.map((a) => a.id),
      items: [
        { kind: "merchant_label", created: 0, updated: toWrite.length, removed: 0 },
        { kind: "listing_group", created, removed: adsOps.length - created, updated: 0 },
      ],
    },
    warnings,
    undo: {
      supported: true,
      why: createSource ? "the empty label source PerfoAds made stays in Merchant Center" : null,
      level: createSource ? "partial" : "full",
    },
  };
};

// ---- undo ----------------------------------------------------------------------------

const scopeOf = (t: ReadTarget): Scope => {
  const s = asObject(t.scope);
  const products = Array.isArray(s.products) ? s.products : [];
  const trees = Array.isArray(s.trees) ? s.trees : [];
  return {
    slot: typeof s.slot === "number" ? s.slot : 0,
    value: asString(s.value) ?? DEFAULT_EXCLUDE_VALUE,
    source: asString(s.source) ?? null,
    products: products.map((p) => productTargetSchema.parse(p)),
    claims: Array.isArray(s.claims)
      ? s.claims.filter((c): c is string => typeof c === "string")
      : [],
    trees: trees.map((x) => treeTargetSchema.parse(x) as TreeTarget),
    labelNodes: ids(s.labelNodes),
    labelOnly: ids(s.labelOnly),
  };
};

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];

/**
 * Other changes of this type that hold labels on this Merchant Center (sent, not undone),
 * with their scope. This change itself and the change being undone are left out.
 */
const heldScopes = (ctx: ReadCtx, mid: string): { id: string; scope: Scope }[] =>
  (ctx.heldOfType?.(TYPE) ?? [])
    .filter((h) => h.id !== ctx.undoOf && h.id !== ctx.changeId)
    .flatMap((h) => {
      const t = asObject(asObject(h.before).readTarget);
      if (t.resource !== "merchant_labels" || t.id !== mid) return [];
      try {
        const scope = scopeOf(t as unknown as ReadTarget);
        return scope.source ? [{ id: h.id, scope }] : [];
      } catch {
        return [];
      }
    });

const planUndo = async (ctx: ReadCtx, u: UndoInput): Promise<Planned> => {
  const cid = ctx.target.customerId;
  const mid = u.merchant_id;
  const merchant = u.products.length > 0 ? await needScope(ctx) : null;

  // another applied tag_exclude keeps some of these out with the same label, or relies on a
  // label exclusion this undo removes: never undo under it
  for (const o of heldScopes(ctx, mid)) {
    const s = o.scope;
    if (s.slot !== u.slot || s.value !== u.value) continue;
    const claims = new Set(s.claims);
    const shared = u.products.filter((p) => claims.has(p.restId)).length;
    if (shared > 0) {
      throw new ChangeError(
        "undo_unavailable",
        `Undo would put the old label back on ${plural(shared, "product")} that change ${o.id} also keeps out with ${lbl(u.slot, u.value)}. Undo that change first, then this one. Nothing was proposed.`,
      );
    }
    const relies = u.label_nodes.filter((c) => s.labelOnly.includes(c));
    if (relies.length > 0) {
      throw new ChangeError(
        "undo_unavailable",
        `Undo would remove the exclusion of ${lbl(u.slot, u.value)} from campaign ${relies.join(", ")}, and change ${o.id} relies on it to keep its products out there. Undo that change first, then this one. Nothing was proposed.`,
      );
    }
  }

  const touched: Touched = {};
  const expected: Touched = {};
  const ops: JsonObject[] = [];
  if (merchant && u.products.length > 0) {
    if (!u.source)
      throw new ChangeError("undo_unavailable", "The label source of this change is not known.");
    const listing = await mcRead(mid, "the products", () => merchant.listProducts(mid));
    const byRest = new Map(listing.products.map((p) => [p.restId, p]));
    let lagging = 0;
    for (const p of u.products) {
      const live = byRest.get(p.restId);
      const now = live ? (live.labels[u.slot] ?? "") : GONE;
      if (now === p.before && p.before !== u.value) lagging++;
      touched[labelKey(p.restId, u.slot)] = now;
      expected[labelKey(p.restId, u.slot)] = p.before;
      ops.push({
        merchantClearLabel: {
          merchantId: mid,
          dataSource: u.source,
          slot: u.slot,
          value: u.value,
          product: {
            restId: p.restId,
            offerId: p.offerId,
            contentLanguage: p.contentLanguage,
            feedLabel: p.feedLabel,
          },
        },
      });
    }
    if (lagging > 0) {
      throw new ChangeError(
        "undo_unavailable",
        `Merchant Center has not passed the label on to ${lagging} of these products yet, so undo can't check them. Try again in a few hours. Nothing was proposed.`,
      );
    }
  }
  const treeTargets: TreeTarget[] = [];
  if (u.trees.length > 0) {
    const campaigns = unique(u.trees.map((t) => t.campaignId)).map((id) => ({
      id,
      name: null,
      status: null,
      channel: u.trees.find((t) => t.campaignId === id)?.channel ?? null,
      merchantId: mid,
    }));
    const live = await readTrees(ctx, campaigns);
    const temp = tempIdCounter();
    for (const t of u.trees) {
      const lt = live.get(t.campaignId);
      const nodes = lt?.unread
        ? null
        : (lt?.trees.find((x) => x.groupId === t.groupId)?.nodes ?? []);
      touched[treeKey(t.groupId)] = nodes ? treeFingerprint(t.channel, nodes) : GONE;
      expected[treeKey(t.groupId)] = treeFingerprint(t.channel, t.snapshot as ListingNode[]);
      if (!nodes) continue;
      ops.push(
        ...buildRestoreTreeOps(t.channel, cid, t.groupId, nodes, t.snapshot as ListingNode[], temp),
      );
      treeTargets.push({ ...t, snapshot: nodes });
    }
  }
  const diff: string[] = [];
  if (u.products.length > 0) {
    diff.push(
      `Merchant Center ${mid}: takes ${lbl(u.slot, u.value)} back off ${plural(u.products.length, "product")} in PerfoAds' own source, so the old label shows again.`,
    );
  }
  for (const id of unique(u.trees.map((t) => t.campaignId))) {
    const n = u.trees.filter((t) => t.campaignId === id).length;
    diff.push(
      `Campaign ${id}: puts ${plural(n, "product group")} back as ${n === 1 ? "it was" : "they were"}.`,
    );
  }
  const campaignIds = unique(u.trees.map((t) => t.campaignId));
  return {
    ops,
    readTarget: {
      resource: "merchant_labels",
      id: mid,
      scope: {
        slot: u.slot,
        value: u.value,
        source: u.source,
        products: u.products.map((p) => ({
          restId: p.restId,
          offerId: p.offerId,
          contentLanguage: p.contentLanguage,
          feedLabel: p.feedLabel,
        })),
        claims: [],
        trees: treeTargets,
        labelNodes: [],
        labelOnly: [],
      } as unknown as JsonObject,
    },
    touched,
    expected,
    diff,
    affected: campaignIds.map((id) => ({ kind: "campaign", id, name: null, status: null })),
    facts: {
      affectedCampaignIds: campaignIds,
      items: [
        { kind: "merchant_label", created: 0, updated: u.products.length, removed: 0 },
        { kind: "listing_group", created: 0, updated: 0, removed: 0 },
      ],
    },
    warnings: u.products.length > 0 ? [READ_BACK_LAG.replace(/^Applied\. /, "")] : [],
    undo: {
      supported: false,
      why: "This is an undo. To exclude the products again, propose it again.",
    },
  };
};

// ---- send ----------------------------------------------------------------------------

type MerchantOp =
  | {
      kind: "create";
      merchantId: string;
      key: string;
      displayName: string;
      feedLabel: string;
      contentLanguage: string;
    }
  | {
      kind: "set" | "clear";
      merchantId: string;
      dataSource: string;
      slot: number;
      value: string;
      product: LabelTarget;
    };

const merchantOpOf = (op: JsonObject): MerchantOp | null => {
  if (isObject(op.merchantCreateSource)) {
    const c = op.merchantCreateSource;
    return {
      kind: "create",
      merchantId: String(c.merchantId),
      key: String(c.key),
      displayName: String(c.displayName),
      feedLabel: String(c.feedLabel ?? ""),
      contentLanguage: String(c.contentLanguage ?? ""),
    };
  }
  const raw = isObject(op.merchantSetLabel)
    ? op.merchantSetLabel
    : isObject(op.merchantClearLabel)
      ? op.merchantClearLabel
      : null;
  if (!raw) return null;
  const dataSource = asString(raw.dataSource);
  if (!dataSource) throw new AdsNotSentError("Not sent: the label source is missing.", null);
  return {
    kind: isObject(op.merchantSetLabel) ? "set" : "clear",
    merchantId: String(raw.merchantId),
    dataSource,
    slot: Number(raw.slot),
    value: String(raw.value),
    product: productTargetSchema.parse(raw.product),
  };
};

/** A failure after which a write may or may not have landed. */
const unclear = (err: unknown): boolean =>
  !(
    err instanceof GoogleAdsApiError ||
    err instanceof AdsNotSentError ||
    err instanceof AdsNotAllowedError ||
    (err instanceof AdsNetworkError && !err.sent)
  );

/** The error the engine gets once the labels written so far were taken back (or not). */
const afterRollback = (err: unknown, rolledBack: boolean): unknown => {
  if (!rolledBack) {
    return new AdsInDoubtError(
      "Merchant Center took the label on only some products and PerfoAds could not take it off all of them again, so what landed is unclear. Checking the account; it will not be sent again.",
      undefined,
      err,
    );
  }
  if (!unclear(err)) return err;
  return new AdsNotSentError(
    "Not sent: Merchant Center's answer was unclear, so PerfoAds took the label back off the products it had written. Nothing was changed.",
    err,
  );
};

const okResult = (index: number): OperationResult => ({
  index,
  ok: true,
  resourceName: undefined,
  resource: undefined,
  errors: [],
});

const send = async (
  ctx: ReadCtx,
  ops: JsonObject[],
  o: { validateOnly: boolean },
): Promise<MutateResult> => {
  const mc = ops.map(merchantOpOf);
  const adsOps = ops.filter((_, i) => mc[i] === null);
  if (o.validateOnly) {
    if (adsOps.length > 0) return ctx.ads.mutateAll(adsOps, { ...ctx.target, validateOnly: true });
    return {
      validateOnly: true,
      googleRequestId: undefined,
      results: [],
      failedCount: 0,
      requestErrors: [],
    };
  }
  const merchant = merchantOf(ctx);
  const back: (() => Promise<unknown>)[] = [];
  const rollback = async (): Promise<boolean> => {
    let ok = true;
    for (const step of [...back].reverse()) {
      try {
        await step();
      } catch {
        ok = false;
      }
    }
    return ok;
  };
  for (const op of mc) {
    if (!op) continue;
    if (op.kind === "create") {
      if (ctx.ownSources?.get(op.key)) continue;
      try {
        const made = await merchant.createSupplementalSource(op.merchantId, op);
        ctx.ownSources?.set(op.key, made.name);
      } catch (err) {
        throw afterRollback(err, await rollback());
      }
      continue;
    }
    const undoStep =
      op.kind === "set"
        ? () => merchant.clearCustomLabel(op.merchantId, op.product, op.slot, op.dataSource)
        : () =>
            merchant.setCustomLabel(op.merchantId, op.product, op.slot, op.value, op.dataSource);
    try {
      if (op.kind === "set") {
        await merchant.setCustomLabel(op.merchantId, op.product, op.slot, op.value, op.dataSource);
      } else {
        await merchant.clearCustomLabel(op.merchantId, op.product, op.slot, op.dataSource);
      }
      back.push(undoStep);
    } catch (err) {
      // an unclear write may have landed: it is taken back too (both directions repeat safely)
      if (unclear(err)) back.push(undoStep);
      throw afterRollback(err, await rollback());
    }
  }
  if (adsOps.length === 0) {
    return {
      validateOnly: false,
      googleRequestId: undefined,
      results: ops.map((_, i) => okResult(i)),
      failedCount: 0,
      requestErrors: [],
    };
  }
  let res: MutateResult;
  try {
    res = await ctx.ads.mutateAll(adsOps, {
      ...ctx.target,
      responseContentType: "MUTABLE_RESOURCE",
    });
  } catch (err) {
    // unclear: the campaigns may have changed, so the labels stay and the account is read
    if (unclear(err)) throw err;
    throw afterRollback(err, await rollback());
  }
  let k = 0;
  const results = ops.map((_, index) => {
    if (mc[index]) return okResult(index);
    const r = res.results[k++];
    return r ? { ...r, index } : { ...okResult(index), ok: false };
  });
  return { ...res, results, failedCount: results.filter((r) => !r.ok).length };
};

// ---- read-back -----------------------------------------------------------------------

const readTouched = async (ctx: ReadCtx, t: ReadTarget): Promise<Touched | null> => {
  const s = scopeOf(t);
  const out: Touched = {};
  if (s.products.length > 0) {
    const merchant = merchantOf(ctx);
    const listing = await mcRead(t.id, "the products", () => merchant.listProducts(t.id));
    const byRest = new Map(listing.products.map((p) => [p.restId, p]));
    for (const p of s.products) {
      const live = byRest.get(p.restId);
      out[labelKey(p.restId, s.slot)] = live ? (live.labels[s.slot] ?? "") : GONE;
    }
  }
  if (s.trees.length > 0) {
    const campaigns = unique(s.trees.map((x) => x.campaignId)).map((id) => ({
      id,
      name: null,
      status: null,
      channel: s.trees.find((x) => x.campaignId === id)?.channel ?? null,
      merchantId: t.id,
    }));
    const live = await readTrees(ctx, campaigns);
    for (const x of s.trees) {
      const lt = live.get(x.campaignId);
      const nodes = lt?.unread ? null : lt?.trees.find((y) => y.groupId === x.groupId)?.nodes;
      out[treeKey(x.groupId)] = nodes ? treeFingerprint(x.channel, nodes) : GONE;
    }
  }
  return out;
};

export const tagExclude: ActionType<TagExcludeInput> = {
  type: TYPE,
  summary:
    "Stop products showing in Shopping / Performance Max campaigns: one exclude label in Merchant Center where the product groups already leave it out, else a label or item-id exclusion in the campaign (needs Merchant Center access).",
  input: tagExcludeInput as unknown as z.ZodType<TagExcludeInput>,
  undoInputSchema: undoInputSchema as z.ZodType<TagExcludeInput>,
  independentOps: false,
  itemKeys: true,
  readBackLag: { keys: (k) => k.startsWith("label:"), note: READ_BACK_LAG },

  plan(ctx, input): Promise<Planned> {
    return "undo" in input ? planUndo(ctx, input.undo) : planExclude(ctx, input);
  },

  readTouched,

  fromMutateResults: () => null,

  send,

  undoInput(payload, before, readTarget) {
    if ("undo" in payload) {
      throw new ChangeError(
        "undo_unavailable",
        "This is already an undo. To exclude the products again, propose it again.",
      );
    }
    const s = scopeOf(readTarget);
    const products = s.products
      .filter((p) => before[labelKey(p.restId, s.slot)] !== undefined)
      .map((p) => ({ ...p, before: before[labelKey(p.restId, s.slot)] ?? "" }));
    const trees = s.trees.filter((x) => before[treeKey(x.groupId)] !== undefined);
    return {
      undo: {
        merchant_id: readTarget.id,
        slot: s.slot,
        value: s.value,
        source: s.source,
        products,
        trees,
        label_nodes: s.labelNodes,
      },
    };
  },

  historyWhere: () => null,
};
