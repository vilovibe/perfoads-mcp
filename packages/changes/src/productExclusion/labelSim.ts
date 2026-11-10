// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The "exclude" custom label simulated on every serving listing tree before anything is
// written (pure, no I/O), ported as-is from the PerfoAds app: where a product lands in a
// tree (productOutcomeInGroup), what one label value does in every campaign
// (simulateLabelExclusion), which slot carries it (chooseExcludeSlot) and how each
// campaign drops the products (labelRouteFor: label only / label node / item ids).

import type { LabelIndex, ListingNode } from "./listingTree.js";

export const EXCLUDE_LABEL_VALUE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface ExcludeLabel {
  slot: number;
  value: string;
}

/** One custom label slot and whether anything lives there (no product carries a value). */
export interface SlotUsage {
  slot: number;
  free: boolean;
}

export function labelIndexOf(slot: number): LabelIndex {
  return `INDEX${slot}` as LabelIndex;
}

/** Offer id key: channel prefix (online:en:US:) dropped, lowercased. */
export const offerKey = (id: unknown): string => {
  const s = String(id ?? "").trim();
  return (s.includes(":") ? s.split(":").pop() || s : s).toLowerCase();
};

/** One synced listing group node, reduced to what the badge walk needs. */
export interface BadgeNode {
  id: string;
  parent: string | null;
  kind: "SUBDIVISION" | "INCLUDED" | "EXCLUDED";
  /** item = product_item_id, label = custom label slot, other = a dimension we cannot evaluate, null = root */
  dim: "item" | "label" | "other" | null;
  /** custom label slot 0-4 (dim 'label') */
  slot?: number;
  /** lowercase case value; null = "everything else" (or the root) */
  value: string | null;
  /**
   * A PMax product type (level 1-5) or brand node (dim stays 'other' for the badge
   * walk); its lowercase value, null = "everything else". Read only when the product gives its
   * types / brand (productOutcomeInGroup).
   */
  attr?:
    | { kind: "type"; level: number; value: string | null }
    | { kind: "brand"; value: string | null }
    // Google category (by category id, level 1-5) and channel (online / local)
    | { kind: "category"; level: number; value: string | null }
    | { kind: "channel"; value: string | null };
}

export interface BadgeProduct {
  /** lowercase item / offer id */
  id: string;
  /** current custom labels 0-4 (lowercase); null when the product is not in the feed */
  labels: (string | null)[] | null;
  /** The product type by level ("Mugs > Women" -> ['mugs', 'women']); absent = a type node is 'unknown'. */
  types?: string[];
  /** The brand (lowercase; null = none); absent = a brand node is 'unknown'. */
  brand?: string | null;
  /** Google category ids by level 1-5 (null = none at that level); absent = a category node is 'unknown'. */
  categoryIds?: (string | null)[];
  /** 'online' / 'local'; absent = a channel node is 'unknown'. */
  channel?: string | null;
}

export type GroupOutcome = "included" | "excluded_explicit" | "excluded_default" | "unknown";

/** Synced PMax row -> BadgeNode (case_value is the API caseValue JSON). */
export function pmaxBadgeNode(r: {
  listing_group_id: string;
  parent_listing_group_id: string | null;
  type: string;
  case_value: string | null;
}): BadgeNode | null {
  const kind =
    r.type === "SUBDIVISION"
      ? "SUBDIVISION"
      : r.type === "UNIT_INCLUDED"
        ? "INCLUDED"
        : r.type === "UNIT_EXCLUDED"
          ? "EXCLUDED"
          : null;
  if (!kind || !r.listing_group_id) return null;
  let cv: any = null;
  try {
    cv = r.case_value ? JSON.parse(r.case_value) : null;
  } catch {
    return null;
  }
  // The sync stores the parent as "<assetGroupId>~<filterId>" and the node as "<filterId>".
  const tail = (v: string) => v.split("~").pop() || v;
  const node: BadgeNode = {
    id: tail(String(r.listing_group_id)),
    parent: r.parent_listing_group_id ? tail(String(r.parent_listing_group_id)) : null,
    kind,
    dim: null,
    value: null,
  };
  const key = cv && typeof cv === "object" ? Object.keys(cv)[0] : undefined;
  if (!key) return node;
  const d = cv[key] || {};
  if (key === "productItemId" || key === "product_item_id") {
    node.dim = "item";
    node.value = typeof d.value === "string" && d.value ? offerKey(d.value) : null;
  } else if (key === "productCustomAttribute" || key === "product_custom_attribute") {
    const slot = Number(String(d.index ?? "").replace(/\D/g, ""));
    node.dim =
      Number.isInteger(slot) && slot >= 0 && slot <= 4 && String(d.index ?? "") !== ""
        ? "label"
        : "other";
    if (node.dim === "label") node.slot = slot;
    node.value = typeof d.value === "string" && d.value ? d.value.toLowerCase() : null;
  } else {
    node.dim = "other";
    node.value = Object.values(d).some((v) => v !== undefined && v !== null && v !== "")
      ? JSON.stringify(d)
      : null;
    const v = typeof d.value === "string" && d.value.trim() ? d.value.trim().toLowerCase() : null;
    if (key === "productType" || key === "product_type") {
      const level = Number(String(d.level ?? "").replace(/\D/g, ""));
      if (Number.isInteger(level) && level >= 1 && level <= 5)
        node.attr = { kind: "type", level, value: v };
    } else if (key === "productBrand" || key === "product_brand") {
      node.attr = { kind: "brand", value: v };
    } else if (key === "productCategory" || key === "product_category") {
      const level = Number(String(d.level ?? "").replace(/\D/g, ""));
      const id = d.categoryId ?? d.category_id;
      if (Number.isInteger(level) && level >= 1 && level <= 5)
        node.attr = {
          kind: "category",
          level,
          value: id != null && String(id) !== "" ? String(id) : null,
        };
    } else if (key === "productChannel" || key === "product_channel") {
      node.attr = {
        kind: "channel",
        value: typeof d.channel === "string" && d.channel ? d.channel.toLowerCase() : null,
      };
    }
  }
  return node;
}

/**
 * Where a product lands in one asset group / ad group tree: follow the
 * subdivisions by its item id and custom labels, and (when the product gives
 * them) its product type levels, brand, Google category ids and channel. Any
 * other dimension (condition, channel exclusivity…) or a product field not
 * given: 'unknown'.
 * 'excluded_explicit' = an excluded node naming the product (item id) or its
 * label value; 'excluded_default' = an excluded "everything else" (the product
 * is simply not on an allow-list).
 */
export function productOutcomeInGroup(nodes: BadgeNode[], p: BadgeProduct): GroupOutcome {
  const roots = nodes.filter((n) => !n.parent);
  if (roots.length !== 1) return "unknown";
  const children = new Map<string, BadgeNode[]>();
  for (const n of nodes)
    if (n.parent) (children.get(n.parent) ?? children.set(n.parent, []).get(n.parent)!).push(n);
  let cur: BadgeNode = roots[0]!;
  for (let depth = 0; depth < 50; depth++) {
    if (cur.kind === "INCLUDED") return "included";
    if (cur.kind === "EXCLUDED")
      return cur.value != null && cur.dim !== "other" ? "excluded_explicit" : "excluded_default";
    const kids = children.get(cur.id) || [];
    const dimNode = kids.find((k) => k.dim);
    if (!dimNode) return "unknown";
    // A product type / brand split is followed when the product gives its types / brand.
    if (dimNode.dim === "other") {
      const a = dimNode.attr;
      const levelOf = (x: BadgeNode["attr"]) =>
        x && (x.kind === "type" || x.kind === "category") ? x.level : 0;
      if (
        !a ||
        kids.some((k) => k.dim && (k.attr?.kind !== a.kind || levelOf(k.attr) !== levelOf(a)))
      )
        return "unknown";
      let want: string | null;
      if (a.kind === "type") {
        if (!p.types) return "unknown";
        want = p.types[a.level - 1] ?? null;
      } else if (a.kind === "category") {
        if (!p.categoryIds) return "unknown";
        want = p.categoryIds[a.level - 1] ?? null;
      } else if (a.kind === "channel") {
        if (p.channel === undefined) return "unknown";
        want = p.channel;
      } else {
        if (p.brand === undefined) return "unknown";
        want = p.brand;
      }
      const next =
        (want != null ? kids.find((k) => k.attr?.value === want) : undefined) ??
        kids.find((k) => k.attr?.value == null);
      if (!next) return "unknown";
      cur = next;
      continue;
    }
    let want: string | null;
    if (dimNode.dim === "item") want = p.id;
    else {
      if (!p.labels) return "unknown";
      want = p.labels[dimNode.slot!] ? String(p.labels[dimNode.slot!]).toLowerCase() : null;
    }
    const next =
      (want != null ? kids.find((k) => k.value === want) : undefined) ??
      kids.find((k) => k.value == null);
    if (!next) return "unknown";
    cur = next;
  }
  return "unknown";
}

/**
 * Only trees that can serve count toward a badge: the campaign ENABLED and the
 * asset group ENABLED. Shopping ad groups: gadsaudit_ad_groups only holds ad
 * groups that spent, so a missing row (null) counts as serving; a known
 * non-ENABLED status does not. A null campaign or asset group status (no
 * synced row) never counts.
 */
export function treeCanServe(
  campaignStatus: string | null | undefined,
  groupStatus: string | null | undefined,
  groupStatusOptional = false,
): boolean {
  if (String(campaignStatus ?? "").toUpperCase() !== "ENABLED") return false;
  if (groupStatus == null || groupStatus === "") return groupStatusOptional;
  return String(groupStatus).toUpperCase() === "ENABLED";
}

/** The value written when the feed has no exclude label of its own. */
export const DEFAULT_EXCLUDE_VALUE = "exclude";

/** One Shopping / PMax campaign with the trees that can serve (treeCanServe), for the label simulation. */
export interface SimCampaign {
  campaignId: string;
  campaignName: string;
  channel: "PMAX" | "SHOPPING";
  /** one node list per serving asset group / ad group; an empty list = no product filter = every product */
  groups: BadgeNode[][];
  /** the trees could not be read: never counted as dropping anything */
  unread?: boolean;
}

/**
 * drops = with the label every chosen product lands on an excluded node or an excluded
 * "everything else" in every serving tree; needs_node = an included node still takes one;
 * unknown = a tree splits by something we cannot evaluate for one of them (or unread).
 */
export type LabelVerdict = "drops" | "needs_node" | "unknown";

export interface LabelSimResult {
  campaignId: string;
  campaignName: string;
  channel: "PMAX" | "SHOPPING";
  verdict: LabelVerdict;
  /** products an included node would still take with the label */
  stillServes: string[];
  /** products that do NOT show here today and WOULD with the label: that slot must never be used */
  startsServing: string[];
  /** products a tree cannot place (unknown dimension, labels not known, trees unread) */
  unknown: string[];
  /** products shown here today that no serving tree shows with the label (they leave this campaign) */
  leaves: string[];
}

const ROOT_ALL: BadgeNode[] = [
  { id: "all", parent: null, kind: "INCLUDED", dim: null, value: null },
];
const isExcluded = (o: GroupOutcome) => o === "excluded_explicit" || o === "excluded_default";

/** The product with ONLY `slot` changed to `value` (its other current labels stay); unknown labels stay unknown. */
function withLabel(p: BadgeProduct, slot: number, value: string): BadgeProduct {
  if (!p.labels) return p;
  const labels = [...p.labels];
  labels[slot] = value.toLowerCase();
  return { ...p, labels };
}

/**
 * Pure: where each chosen product lands in every serving tree of every campaign once
 * custom_label_<slot> = value is written on it (productOutcomeInGroup, other labels as they are).
 */
export function simulateLabelExclusion(input: {
  campaigns: SimCampaign[];
  products: BadgeProduct[];
  slot: number;
  value: string;
}): LabelSimResult[] {
  return input.campaigns.map((c) => {
    const stillServes = new Set<string>();
    const startsServing = new Set<string>();
    const unknown = new Set<string>();
    const leaves = new Set<string>();
    for (const p of input.products) {
      if (c.unread) {
        unknown.add(p.id);
        continue;
      }
      const after = withLabel(p, input.slot, input.value);
      let shownBefore = false;
      for (const g of c.groups) {
        const nodes = g.length === 0 ? ROOT_ALL : g;
        const before = productOutcomeInGroup(nodes, p);
        if (before === "included") shownBefore = true;
        const o = productOutcomeInGroup(nodes, after);
        if (o === "unknown") {
          unknown.add(p.id);
          continue;
        }
        if (isExcluded(o)) continue;
        stillServes.add(p.id);
        // not shown here today (or not placeable) and shown with the label: the label would ADD it
        if (before !== "included") startsServing.add(p.id);
      }
      if (shownBefore && !stillServes.has(p.id) && !unknown.has(p.id)) leaves.add(p.id);
    }
    const verdict: LabelVerdict =
      unknown.size > 0 ? "unknown" : stillServes.size > 0 ? "needs_node" : "drops";
    return {
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      channel: c.channel,
      verdict,
      stillServes: [...stillServes],
      startsServing: [...startsServing],
      unknown: [...unknown],
      leaves: [...leaves],
    };
  });
}

export interface SlotChoice {
  slot: number;
  value: string;
  /** nothing lives in the slot (no product carries a value there) */
  free: boolean;
  source: "configured" | "free" | "in_use";
  sims: LabelSimResult[];
}

/**
 * Pure: the slot the exclude label goes in. The configured exclude label wins
 * when safe, and when it is set no other slot is tried (tier pushes protect that slot only,
 * in the app); else the first free slot that adds the products nowhere; else a
 * slot already used for something else ONLY when every serving tree of every campaign drops
 * the products with it. Never a slot that makes a tree start showing a product.
 */
export function chooseExcludeSlot(input: {
  configured: ExcludeLabel | null;
  usage: Pick<SlotUsage, "slot" | "free">[];
  simulate: (slot: number, value: string) => LabelSimResult[];
}): SlotChoice | { refused: string } {
  const value = input.configured?.value ?? DEFAULT_EXCLUDE_VALUE;
  const freeOf = (slot: number) => input.usage.find((u) => u.slot === slot)?.free === true;
  const tryOne = (slot: number, source: SlotChoice["source"]): SlotChoice | null => {
    const sims = input.simulate(slot, value);
    if (sims.some((r) => r.startsServing.length > 0)) return null;
    const free = freeOf(slot);
    if (!free && sims.some((r) => r.verdict !== "drops")) return null;
    return {
      slot,
      value,
      free,
      source: source === "configured" ? "configured" : free ? "free" : "in_use",
      sims,
    };
  };
  if (input.configured) {
    return (
      tryOne(input.configured.slot, "configured") ?? {
        refused: `your exclude label (custom_label_${input.configured.slot} = ${value}) would leave these products showing in a campaign, or make one start showing them`,
      }
    );
  }
  for (const slot of [0, 1, 2, 3, 4].filter(freeOf)) {
    const c = tryOne(slot, "free");
    if (c) return c;
  }
  for (const slot of [0, 1, 2, 3, 4].filter((s) => !freeOf(s))) {
    const c = tryOne(slot, "in_use");
    if (c) return c;
  }
  return {
    refused:
      "every custom label is in use, and with each of them at least one campaign would still show these products (or start showing them)",
  };
}

export type LabelRoute = "label_only" | "label_node" | "item_id";

/**
 * Pure: how the card's own campaign drops the products. drops -> the label alone (0 changes in
 * the campaign); an included node still takes them and the slot is free -> one label exclusion
 * node (existing method 'label'); otherwise the listings one by one (method item_id).
 */
export function labelRouteFor(
  sim: LabelSimResult | undefined,
  choice: Pick<SlotChoice, "slot" | "value" | "free">,
): { route: LabelRoute; why: string } {
  const lbl = `custom_label_${choice.slot} = ${choice.value}`;
  if (!sim)
    return { route: "item_id", why: "PerfoAds could not read the product groups of this campaign" };
  if (sim.verdict === "drops")
    return {
      route: "label_only",
      why: `every product group here already leaves ${lbl} out, so the label alone is enough and the campaign is not changed`,
    };
  if (sim.verdict === "needs_node" && choice.free)
    return {
      route: "label_node",
      why: `a product group here would still show them, so PerfoAds also adds one exclusion of ${lbl} to this campaign`,
    };
  if (sim.verdict === "needs_node")
    return {
      route: "item_id",
      why: `custom_label_${choice.slot} is used for something else in this campaign`,
    };
  return {
    route: "item_id",
    why: "this campaign splits its products by something PerfoAds cannot check from the feed",
  };
}

/**
 * A LIVE tree (productExclusionTree ListingNode, PMax filter or Shopping criterion) as badge nodes,
 * for the simulation at preview / approve. Null when a node cannot be placed (never guessed).
 */
export function badgeNodesOfListingTree(nodes: ListingNode[]): BadgeNode[] | null {
  const out: BadgeNode[] = [];
  for (const n of nodes) {
    const b = pmaxBadgeNode({
      listing_group_id: n.resourceName,
      parent_listing_group_id: n.parent,
      type:
        n.kind === "SUBDIVISION"
          ? "SUBDIVISION"
          : n.kind === "INCLUDED"
            ? "UNIT_INCLUDED"
            : "UNIT_EXCLUDED",
      case_value: n.caseValue ? JSON.stringify(n.caseValue) : null,
    });
    if (!b) return null;
    out.push(b);
  }
  return out;
}

/** custom labels / product type / brand / channel of the chosen products, from the feed (the simulation's input). */
