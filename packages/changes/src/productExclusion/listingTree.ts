// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Product exclusion tree builder (pure, no I/O), ported as-is from the PerfoAds app.
//
// Turns a LIVE read of a campaign's product targeting into the Google Ads mutate
// operations that exclude a list of product item ids (or one custom label value):
//   - PMax retail: AssetGroupListingGroupFilter tree per asset group
//     (types SUBDIVISION / UNIT_INCLUDED / UNIT_EXCLUDED, listing_source SHOPPING).
//   - Standard Shopping: AdGroupCriterion listing_group tree per ad group
//     (types SUBDIVISION / UNIT, exclusion = negative UNIT).
//
// Every included unit that can serve an id gets it excluded:
//   - a unit on another dimension (or the root) is removed and re-created as a
//     SUBDIVISION on product_item_id with one excluded unit per id plus an
//     "everything else" included unit (Shopping: bid copied from the unit);
//   - the "everything else" unit of an existing product_item_id subdivision
//     gets excluded siblings for the ids not already split out;
//   - an included product_item_id unit for one of the ids becomes excluded.
// Removes go first, then creates parent-before-child, all with temporary
// resource names so the whole change is ONE atomic googleAds:mutate.

import { createHash } from "node:crypto";

export type ExclusionChannel = "PMAX" | "SHOPPING";

export type NodeKind = "SUBDIVISION" | "INCLUDED" | "EXCLUDED";

/** One listing group node, normalized across PMax filters and Shopping criteria. */
export interface ListingNode {
  resourceName: string;
  /** Parent node resource name; null for the root. */
  parent: string | null;
  kind: NodeKind;
  /** e.g. { productItemId: { value: 'abc' } }, "everything else" = { productItemId: {} }; null for the root. */
  caseValue: Record<string, any> | null;
  /** Shopping only. */
  cpcBidMicros?: string | null | undefined;
  /** Shopping only (criterion status). */
  status?: string | null | undefined;
}

export interface ListingTree {
  /** Asset group id (PMax) or ad group id (Shopping). */
  groupId: string;
  groupName?: string | null;
  nodes: ListingNode[];
}

export interface GroupPlan {
  groupId: string;
  groupName: string | null;
  /** IDs that got a new exclusion in this group. */
  excludedIds: string[];
  /** IDs that were already excluded (or not servable) everywhere in this group. */
  alreadyExcludedIds: string[];
  removedNodes: number;
  createdNodes: number;
  includedUnitsAfter: number;
}

export interface ExclusionPlan {
  channel: ExclusionChannel;
  groups: GroupPlan[];
  /** Groups that change. */
  changedGroupIds: string[];
  /** IDs excluded in at least one group. */
  excludedIds: string[];
  /** IDs already excluded in every group: nothing sent for them. */
  skippedIds: string[];
  operations: Record<string, any>[];
  /** Per changed group: fingerprint of the tree as it will be after the mutate. Undo refuses on mismatch. */
  afterFingerprints: Record<string, string>;
}

export class ProductExclusionError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "ProductExclusionError";
  }
}

export const MAX_EXCLUDE_IDS = 200;
/** The most changes one fix makes. */
export const MAX_FIX_CHANGES = 10;
/** Older cards without a change count: the most listings 10 changes of 200 take. */
export const MAX_FIX_LISTINGS = MAX_EXCLUDE_IDS * MAX_FIX_CHANGES;

/**
 * Listings packed into changes of at most `max`, product-aware: a product
 * (one group) is never split while it fits in one change; a bigger one is cut into `max` pieces.
 * First-fit decreasing (biggest piece first, ties in input order), so the number of changes
 * depends only on the group sizes: the card's check and the fix builder count the same.
 */
export function packByProduct<T>(groups: readonly (readonly T[])[], max: number): T[][] {
  const pieces: T[][] = [];
  for (const g of groups) for (let k = 0; k < g.length; k += max) pieces.push(g.slice(k, k + max));
  const order = pieces
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.length - a.p.length || a.i - b.i);
  const bins: T[][] = [];
  for (const { p } of order) {
    const bin = bins.find((b) => b.length + p.length <= max);
    if (bin) bin.push(...p);
    else bins.push([...p]);
  }
  return bins;
}
/** The most products one exclude-label change writes. */
export const MAX_LABEL_IDS = 5000;
/** Google caps one mutate request at 10,000 operations; stay well under it. */
export const MAX_EXCLUDE_OPERATIONS = 5000;

// ============================================================
// INPUT
// ============================================================

/** Trim, lowercase (Google stores product_item_id lowercase), dedupe, validate. */
export function normalizeItemIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ProductExclusionError("itemIds must be a non-empty array", "INVALID_INPUT");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string")
      throw new ProductExclusionError("itemIds must be strings", "INVALID_INPUT");
    const id = v.trim().toLowerCase();
    // eslint-disable-next-line no-control-regex
    if (!id || id.length > 150 || /[\u0000-\u001f]/.test(id)) {
      throw new ProductExclusionError(`Invalid item id: ${v.slice(0, 60)}`, "INVALID_INPUT");
    }
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  if (out.length > MAX_EXCLUDE_IDS) {
    throw new ProductExclusionError(
      `At most ${MAX_EXCLUDE_IDS} products per change (got ${out.length})`,
      "TOO_MANY_IDS",
    );
  }
  return out;
}

// ============================================================
// PARSING (REST searchStream rows -> ListingNode)
// ============================================================

/** Dimension keys of ListingGroupFilterDimension / ListingDimensionInfo we handle, with their fields. */
const DIMENSIONS: Record<string, string[]> = {
  productBrand: ["value"],
  productCategory: ["categoryId", "level"],
  productChannel: ["channel"],
  productChannelExclusivity: ["channelExclusivity"],
  productCondition: ["condition"],
  productCustomAttribute: ["index", "value"],
  productItemId: ["value"],
  productType: ["level", "value"],
};
/** Fields that identify WHICH slot a dimension is on (kept for "everything else"). */
const SLOT_FIELDS = new Set(["level", "index"]);

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function normalizeCaseValue(raw: any): Record<string, any> | null {
  if (!raw || typeof raw !== "object") return null;
  for (const key of Object.keys(raw)) {
    const k = camel(key);
    if (!DIMENSIONS[k]) continue;
    const src = raw[key] || {};
    const dim: Record<string, any> = {};
    for (const f of DIMENSIONS[k]) {
      const v = src[f] ?? src[f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
      if (v !== undefined && v !== null && v !== "") dim[f] = v;
    }
    return { [k]: dim };
  }
  return null;
}

function dimKey(cv: Record<string, any> | null): string | null {
  return cv ? Object.keys(cv)[0] || null : null;
}

/** product_item_id value (lowercase) or null (other dimension / "everything else"). */
export function itemValueOf(node: ListingNode): string | null {
  const v = node.caseValue?.productItemId?.value;
  return typeof v === "string" && v ? v.toLowerCase() : null;
}

/** True for the "everything else" node of a subdivision (dimension set, no value). */
function isEverythingElse(cv: Record<string, any> | null): boolean {
  const k = dimKey(cv);
  if (!k || !cv) return false;
  const valueFields = (DIMENSIONS[k] ?? []).filter((f) => !SLOT_FIELDS.has(f));
  return valueFields.every((f) => cv[k][f] === undefined);
}

/**
 * A non-root node the API returned without a case value is an "everything
 * else" node: take its dimension (and level/index slot) from a sibling. A node
 * we still cannot place makes the tree unreadable: refuse rather than guess.
 */
function fillEverythingElse(nodes: ListingNode[]): void {
  const byParent = groupByParent(nodes);
  for (const n of nodes) {
    if (!n.parent || n.caseValue) continue;
    const sib = (byParent.get(n.parent) || []).find((s) => s !== n && s.caseValue);
    if (!sib?.caseValue) {
      throw new ProductExclusionError(
        "Could not read the product targeting tree fully",
        "TREE_UNREADABLE",
      );
    }
    const k = dimKey(sib.caseValue)!;
    const slot: Record<string, any> = {};
    for (const [f, v] of Object.entries(sib.caseValue[k])) if (SLOT_FIELDS.has(f)) slot[f] = v;
    n.caseValue = { [k]: slot };
  }
}

function groupByParent(nodes: ListingNode[]): Map<string, ListingNode[]> {
  const m = new Map<string, ListingNode[]>();
  for (const n of nodes) {
    if (!n.parent) continue;
    const list = m.get(n.parent) || [];
    list.push(n);
    m.set(n.parent, list);
  }
  return m;
}

function validateTree(nodes: ListingNode[]): void {
  if (nodes.length === 0) return;
  const roots = nodes.filter((n) => !n.parent);
  const names = new Set(nodes.map((n) => n.resourceName));
  if (roots.length !== 1 || nodes.some((n) => n.parent && !names.has(n.parent))) {
    throw new ProductExclusionError(
      "Could not read the product targeting tree fully",
      "TREE_UNREADABLE",
    );
  }
}

/** Rows of `SELECT asset_group_listing_group_filter.* FROM asset_group_listing_group_filter`. */
export function parsePmaxFilterRows(
  rows: any[],
  groupNames: Record<string, string> = {},
): ListingTree[] {
  const trees = new Map<string, ListingTree>();
  for (const row of rows) {
    const f = row.assetGroupListingGroupFilter || row.asset_group_listing_group_filter || {};
    const rn: string = f.resourceName || f.resource_name || "";
    const m = rn.match(/^customers\/\d+\/assetGroupListingGroupFilters\/(\d+)~(\d+)$/);
    if (!m)
      throw new ProductExclusionError(
        "Could not read the product targeting tree fully",
        "TREE_UNREADABLE",
      );
    const type = String(f.type || "");
    const kind: NodeKind | null =
      type === "SUBDIVISION"
        ? "SUBDIVISION"
        : type === "UNIT_INCLUDED"
          ? "INCLUDED"
          : type === "UNIT_EXCLUDED"
            ? "EXCLUDED"
            : null;
    if (!kind)
      throw new ProductExclusionError(`Unknown listing group type ${type}`, "TREE_UNREADABLE");
    const groupId = m[1]!;
    const tree: ListingTree = trees.get(groupId) || {
      groupId,
      groupName: groupNames[groupId] ?? null,
      nodes: [],
    };
    tree.nodes.push({
      resourceName: rn,
      parent: (f.parentListingGroupFilter || f.parent_listing_group_filter || null) as
        string | null,
      kind,
      caseValue: normalizeCaseValue(f.caseValue || f.case_value),
    });
    trees.set(groupId, tree);
  }
  for (const t of trees.values()) {
    validateTree(t.nodes);
    fillEverythingElse(t.nodes);
  }
  return [...trees.values()];
}

/** Rows of `SELECT ad_group.id, ad_group_criterion.* FROM ad_group_criterion WHERE type = LISTING_GROUP`. */
export function parseShoppingCriterionRows(
  rows: any[],
  groupNames: Record<string, string> = {},
): ListingTree[] {
  const trees = new Map<string, ListingTree>();
  for (const row of rows) {
    const c = row.adGroupCriterion || row.ad_group_criterion || {};
    const lg = c.listingGroup || c.listing_group || {};
    const rn: string = c.resourceName || c.resource_name || "";
    const m = rn.match(/^customers\/\d+\/adGroupCriteria\/(\d+)~(\d+)$/);
    if (!m)
      throw new ProductExclusionError(
        "Could not read the product targeting tree fully",
        "TREE_UNREADABLE",
      );
    const type = String(lg.type || "");
    const kind: NodeKind | null =
      type === "SUBDIVISION"
        ? "SUBDIVISION"
        : type === "UNIT"
          ? c.negative === true
            ? "EXCLUDED"
            : "INCLUDED"
          : null;
    if (!kind)
      throw new ProductExclusionError(`Unknown listing group type ${type}`, "TREE_UNREADABLE");
    const groupId = m[1]!;
    const tree: ListingTree = trees.get(groupId) || {
      groupId,
      groupName: groupNames[groupId] ?? null,
      nodes: [],
    };
    const bid = c.cpcBidMicros ?? c.cpc_bid_micros;
    tree.nodes.push({
      resourceName: rn,
      parent: (lg.parentAdGroupCriterion || lg.parent_ad_group_criterion || null) as string | null,
      kind,
      caseValue: normalizeCaseValue(lg.caseValue || lg.case_value),
      cpcBidMicros: bid !== undefined && bid !== null ? String(bid) : null,
      status: c.status ?? null,
    });
    trees.set(groupId, tree);
  }
  for (const t of trees.values()) {
    validateTree(t.nodes);
    fillEverythingElse(t.nodes);
  }
  return [...trees.values()];
}

// ============================================================
// OPERATION BUILDERS
// ============================================================

export interface TempIds {
  next: () => number;
}
export function tempIdCounter(start = -1): TempIds {
  let n = start + 1;
  return { next: () => --n };
}

function nodeResourceName(
  channel: ExclusionChannel,
  cid: string,
  groupId: string,
  id: number | string,
): string {
  return channel === "PMAX"
    ? `customers/${cid}/assetGroupListingGroupFilters/${groupId}~${id}`
    : `customers/${cid}/adGroupCriteria/${groupId}~${id}`;
}

function removeOp(channel: ExclusionChannel, rn: string): Record<string, any> {
  return channel === "PMAX"
    ? { assetGroupListingGroupFilterOperation: { remove: rn } }
    : { adGroupCriterionOperation: { remove: rn } };
}

function createOp(
  channel: ExclusionChannel,
  cid: string,
  groupId: string,
  node: {
    resourceName: string;
    parent: string | null;
    kind: NodeKind;
    caseValue: Record<string, any> | null;
    cpcBidMicros?: string | null | undefined;
    status?: string | null | undefined;
  },
): Record<string, any> {
  if (channel === "PMAX") {
    const create: Record<string, any> = {
      resourceName: node.resourceName,
      assetGroup: `customers/${cid}/assetGroups/${groupId}`,
      type:
        node.kind === "SUBDIVISION"
          ? "SUBDIVISION"
          : node.kind === "INCLUDED"
            ? "UNIT_INCLUDED"
            : "UNIT_EXCLUDED",
      listingSource: "SHOPPING",
    };
    if (node.parent) create.parentListingGroupFilter = node.parent;
    if (node.caseValue) create.caseValue = node.caseValue;
    return { assetGroupListingGroupFilterOperation: { create } };
  }
  const listingGroup: Record<string, any> = {
    type: node.kind === "SUBDIVISION" ? "SUBDIVISION" : "UNIT",
  };
  if (node.parent) listingGroup.parentAdGroupCriterion = node.parent;
  if (node.caseValue) listingGroup.caseValue = node.caseValue;
  const create: Record<string, any> = {
    resourceName: node.resourceName,
    adGroup: `customers/${cid}/adGroups/${groupId}`,
    status: node.status === "PAUSED" ? "PAUSED" : "ENABLED",
    listingGroup,
  };
  if (node.kind === "EXCLUDED") create.negative = true;
  if (node.kind === "INCLUDED" && node.cpcBidMicros) create.cpcBidMicros = node.cpcBidMicros;
  return { adGroupCriterionOperation: { create } };
}

// ============================================================
// PLAN
// ============================================================

export const LABEL_INDEXES = ["INDEX0", "INDEX1", "INDEX2", "INDEX3", "INDEX4"] as const;
export type LabelIndex = (typeof LABEL_INDEXES)[number];

/** Exclude by an "exclude" custom label instead of by item id (method 'label'). */
export interface LabelExclusion {
  index: LabelIndex;
  value: string;
}

/** The dimension the exclusion splits on: product_item_id, or one custom label slot. */
interface SplitDimension {
  same: (cv: Record<string, any> | null) => boolean;
  valueOf: (cv: Record<string, any> | null) => string | null;
  unit: (value: string) => Record<string, any>;
  rest: () => Record<string, any>;
}

function splitDimension(label?: LabelExclusion): SplitDimension {
  if (!label) {
    return {
      same: (cv) => dimKey(cv) === "productItemId",
      valueOf: (cv) =>
        typeof cv?.productItemId?.value === "string" && cv.productItemId.value
          ? cv.productItemId.value.toLowerCase()
          : null,
      unit: (value) => ({ productItemId: { value } }),
      rest: () => ({ productItemId: {} }),
    };
  }
  return {
    same: (cv) =>
      dimKey(cv) === "productCustomAttribute" && cv!.productCustomAttribute.index === label.index,
    valueOf: (cv) =>
      typeof cv?.productCustomAttribute?.value === "string" && cv.productCustomAttribute.value
        ? cv.productCustomAttribute.value.toLowerCase()
        : null,
    unit: (value) => ({ productCustomAttribute: { index: label.index, value } }),
    rest: () => ({ productCustomAttribute: { index: label.index } }),
  };
}

/**
 * Build the exclusion for every tree of the campaign. `itemIds` are the values
 * to exclude: item ids, or with `opts.label` the single label value (one
 * label-exclusion node per included unit instead of one node per id). Throws
 * ProductExclusionError on NOTHING_TO_CHANGE / WOULD_EXCLUDE_EVERYTHING /
 * TOO_MANY_OPERATIONS / NO_TREE.
 */
export function planProductExclusion(
  channel: ExclusionChannel,
  cid: string,
  trees: ListingTree[],
  itemIds: string[],
  // temp: one counter for several campaigns sent in ONE mutate (temporary ids must not repeat)
  opts: { label?: LabelExclusion | undefined; temp?: TempIds | undefined } = {},
): ExclusionPlan {
  const dim = splitDimension(opts.label);
  if (trees.length === 0 || trees.every((t) => t.nodes.length === 0)) {
    throw new ProductExclusionError("This campaign has no product targeting to change", "NO_TREE");
  }
  const temp = opts.temp ?? tempIdCounter();
  const removes: Record<string, any>[] = [];
  const creates: Record<string, any>[] = [];
  const groups: GroupPlan[] = [];
  const excludedAnywhere = new Set<string>();
  const afterFingerprints: Record<string, string> = {};

  for (const tree of trees) {
    // A group without a tree is left alone (the caller warns about it).
    if (tree.nodes.length === 0) continue;
    const g = tree.groupId;
    const byName = new Map(tree.nodes.map((n) => [n.resourceName, n]));
    const byParent = groupByParent(tree.nodes);
    const excludedHere = new Set<string>();
    let removed = 0;
    let created = 0;
    const includedBefore = tree.nodes.filter((n) => n.kind === "INCLUDED").length;
    // The tree as it will be after the mutate (temp names), for the undo fingerprint.
    let after: ListingNode[] = tree.nodes.map((n) => ({ ...n }));
    const remove = (n: ListingNode) => {
      removes.push(removeOp(channel, n.resourceName));
      after = after.filter((x) => x.resourceName !== n.resourceName);
      removed += 1;
    };
    const add = (n: Omit<ListingNode, "resourceName">): string => {
      const rn = nodeResourceName(channel, cid, g, temp.next());
      const node: ListingNode = { ...n, resourceName: rn };
      if (node.kind !== "INCLUDED") node.cpcBidMicros = null;
      creates.push(createOp(channel, cid, g, node));
      after.push(node);
      created += 1;
      return rn;
    };
    /** Nearest node on the path (self or ancestor) that sits on the product_item_id dimension. */
    const itemLevel = (n: ListingNode): ListingNode | null => {
      for (
        let cur: ListingNode | undefined = n;
        cur;
        cur = cur.parent ? byName.get(cur.parent) : undefined
      ) {
        if (dim.same(cur.caseValue)) return cur;
      }
      return null;
    };
    // Item-id splits that already got the extra excluded siblings (one pass per split).
    const extendedSplits = new Set<string>();

    for (const unit of tree.nodes.filter((n) => n.kind === "INCLUDED")) {
      const level = itemLevel(unit);
      if (level && !isEverythingElse(level.caseValue)) {
        // Unit on a specific product's path: it only serves that product.
        // Flip it to excluded when the product is one of ours.
        const item = dim.valueOf(level.caseValue)!;
        if (!itemIds.includes(item)) continue;
        remove(unit);
        add({ ...unit, kind: "EXCLUDED" });
        excludedHere.add(item);
        continue;
      }
      if (level && level.parent) {
        // Unit under the "everything else" of an item-id split (at any depth):
        // never split on item id a second time on this path. Add excluded
        // siblings at the existing split for the IDs not already split out.
        const split = level.parent;
        if (extendedSplits.has(split)) continue;
        extendedSplits.add(split);
        const splitOut = new Set(
          (byParent.get(split) || [])
            .map((x) => dim.valueOf(x.caseValue))
            .filter(Boolean) as string[],
        );
        for (const id of itemIds) {
          if (splitOut.has(id)) continue;
          add({ parent: split, kind: "EXCLUDED", caseValue: dim.unit(id), status: level.status });
          excludedHere.add(id);
        }
        continue;
      }
      // Any other unit (or the root): subdivide it on product_item_id.
      remove(unit);
      const sub = add({
        parent: unit.parent,
        kind: "SUBDIVISION",
        caseValue: unit.caseValue,
        status: unit.status,
      });
      for (const id of itemIds) {
        add({ parent: sub, kind: "EXCLUDED", caseValue: dim.unit(id), status: unit.status });
        excludedHere.add(id);
      }
      // Everything else keeps serving, at the unit's own bid (Shopping).
      add({
        parent: sub,
        kind: "INCLUDED",
        caseValue: dim.rest(),
        cpcBidMicros: unit.cpcBidMicros,
        status: unit.status,
      });
    }

    const includedAfter = after.filter((n) => n.kind === "INCLUDED").length;
    // Only a group WE change can be blamed: one already at 0 is left alone.
    if (removed + created > 0 && includedBefore > 0 && includedAfter === 0) {
      throw new ProductExclusionError(
        `This would stop every product in ${tree.groupName || `group ${g}`} from showing. Nothing was changed.`,
        "WOULD_EXCLUDE_EVERYTHING",
      );
    }
    if (removed + created > 0) afterFingerprints[g] = treeFingerprint(channel, after);
    for (const id of excludedHere) excludedAnywhere.add(id);
    groups.push({
      groupId: g,
      groupName: tree.groupName ?? null,
      excludedIds: itemIds.filter((id) => excludedHere.has(id)),
      alreadyExcludedIds: itemIds.filter((id) => !excludedHere.has(id)),
      removedNodes: removed,
      createdNodes: created,
      includedUnitsAfter: includedAfter,
    });
  }

  const operations = [...removes, ...creates];
  if (operations.length === 0) {
    throw new ProductExclusionError(
      "These products are already excluded in this campaign",
      "NOTHING_TO_CHANGE",
    );
  }
  if (operations.length > MAX_EXCLUDE_OPERATIONS) {
    throw new ProductExclusionError(
      `This change needs ${operations.length} edits in Google Ads (limit ${MAX_EXCLUDE_OPERATIONS}). Pick fewer products.`,
      "TOO_MANY_OPERATIONS",
    );
  }
  return {
    channel,
    groups,
    changedGroupIds: groups
      .filter((x) => x.createdNodes + x.removedNodes > 0)
      .map((x) => x.groupId),
    excludedIds: itemIds.filter((id) => excludedAnywhere.has(id)),
    skippedIds: itemIds.filter((id) => !excludedAnywhere.has(id)),
    operations,
    afterFingerprints,
  };
}

// ============================================================
// FINGERPRINT (undo safety)
// ============================================================

function stableJson(v: any): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Case value as Google matches it: string values lowercased (item ids, labels are case-blind), numbers as strings. */
function fingerprintCase(cv: Record<string, any> | null): Record<string, any> | null {
  if (!cv) return null;
  const out: Record<string, any> = {};
  for (const [k, dim] of Object.entries(cv)) {
    const d: Record<string, any> = {};
    for (const [f, v] of Object.entries(dim || {})) {
      if (v === undefined || v === null || v === "") continue;
      d[f] = SLOT_FIELDS.has(f) ? String(v) : String(v).toLowerCase();
    }
    out[k] = d;
  }
  return out;
}

function fingerprintEntries(
  nodes: ListingNode[],
  entry: (n: ListingNode, path: string[]) => string,
  caseOf: (cv: Record<string, any> | null) => any,
): string {
  const byName = new Map(nodes.map((n) => [n.resourceName, n]));
  const entries = nodes
    .map((n) => {
      const path: string[] = [];
      for (
        let cur: ListingNode | undefined = n;
        cur;
        cur = cur.parent ? byName.get(cur.parent) : undefined
      ) {
        path.unshift(stableJson(caseOf(cur.caseValue)));
      }
      return entry(n, path);
    })
    .sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/**
 * Name-independent fingerprint of a tree: every node as (case-value path from
 * the root, kind, and for Shopping included units the bid and status). Google
 * mints new ids, so resource names cannot be compared; the shape and bids can.
 * Only what decides serving counts: a SUBDIVISION or excluded unit's status
 * and bid do nothing, and Google may read them back differently from what we
 * sent (a planned tree must fingerprint the same as the live read of it).
 */
export function treeFingerprint(channel: ExclusionChannel, nodes: ListingNode[]): string {
  return fingerprintEntries(
    nodes,
    (n, path) => {
      const servesAtBid = channel === "SHOPPING" && n.kind === "INCLUDED";
      const bid =
        servesAtBid &&
        n.cpcBidMicros !== undefined &&
        n.cpcBidMicros !== null &&
        n.cpcBidMicros !== ""
          ? String(n.cpcBidMicros)
          : null;
      const status = servesAtBid ? (n.status === "PAUSED" ? "PAUSED" : "ENABLED") : null;
      return stableJson([path, n.kind, bid, status]);
    },
    fingerprintCase,
  );
}

// ============================================================
// RESTORE (undo)
// ============================================================

/**
 * Ops that put a group's tree back to the snapshot: remove the live tree
 * (PMax: leaves first, the order Google's own sample uses; Shopping: the root,
 * which takes its whole tree with it) then re-create the snapshot parent-first
 * with temporary ids.
 */
export function buildRestoreTreeOps(
  channel: ExclusionChannel,
  cid: string,
  groupId: string,
  current: ListingNode[],
  snapshot: ListingNode[],
  temp: TempIds,
): Record<string, any>[] {
  const ops: Record<string, any>[] = [];
  const curRoot = current.find((n) => !n.parent);
  if (curRoot) {
    if (channel === "SHOPPING") {
      ops.push(removeOp(channel, curRoot.resourceName));
    } else {
      const byParent = groupByParent(current);
      const post = (n: ListingNode) => {
        for (const c of byParent.get(n.resourceName) || []) post(c);
        ops.push(removeOp(channel, n.resourceName));
      };
      post(curRoot);
    }
  }
  const snapRoot = snapshot.find((n) => !n.parent);
  if (!snapRoot) return ops;
  const snapByParent = groupByParent(snapshot);
  const pre = (n: ListingNode, parent: string | null) => {
    const rn = nodeResourceName(channel, cid, groupId, temp.next());
    ops.push(createOp(channel, cid, groupId, { ...n, resourceName: rn, parent }));
    for (const c of snapByParent.get(n.resourceName) || []) pre(c, rn);
  };
  pre(snapRoot, null);
  return ops;
}
