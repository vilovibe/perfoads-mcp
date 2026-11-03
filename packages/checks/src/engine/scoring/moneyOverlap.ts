// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Round 4 R14 / R17: money counted once.
 *
 * Each check prices its own claim, so two checks can price the same dollars: TR01 and
 * BB15 both price one brand campaign's spend ($507 + $318 on a $967 a month campaign),
 * and SK20 priced product pages whose spend PX05 / SH20 already priced as that product's.
 *
 *   - `productPagesPricedElsewhere`: SK20 product pages whose product a product check
 *     prices. The engine leaves a page out of SK20 (a held-back line names the check) only
 *     when those checks price at least 80% of the page's spend; otherwise the page stays a
 *     finding marked `overlaps_with`.
 *   - `countMoneyOnce`: findings on one campaign are merged when one prices the whole
 *     campaign (or the pair is a known overlap) and marked as overlapping (facts
 *     `overlaps_with`, `shared_money_monthly`, `counted_once_monthly`, `overlap_note`);
 *     slices are each counted, the money one campaign's findings count never passes its
 *     monthly spend, and the run's total is given both summed and counted once.
 *
 * Only spend is summed (waste and at risk); upside (`gain`) is never added to spend.
 * The findings' own money (`impact.value`) is never changed: it stays what the claim prices.
 */
import type { AccountModel } from "../model/nodes/AccountNode.js";
import { parentProductKey, shopifyVariantId } from "../model/nodes/ProductNode.js";
import type { Candidate } from "../runEvidenceEngine.js";
import { ROLLUP_WASTED_COST_90D } from "./impact.js";

/** The checks that price a product's own spend (sizes and colours summed to the product). */
export const PRODUCT_MONEY_CHECKS: readonly string[] = ["PX05", "SH04", "SH20"];

/** The run's priced money, per month, in the account currency. */
export interface PricedMoney {
  currency: string;
  /** findings priced as spend (waste or at risk) */
  findings: number;
  /** their money, summed as each finding prices it */
  monthly: number;
  /** the same money with every overlap counted once and no campaign past its own spend */
  monthlyCountedOnce: number;
  /** findings whose money is wholly or partly counted under another finding */
  overlapping: number;
}

/** A finding's money when it is spend (waste or at risk); null when unpriced or upside. */
export function spendMoneyOf(c: Candidate): number | null {
  if (!c.impact.quantified || c.impact.value == null || c.impact.kind === "gain") return null;
  return c.impact.value > 0 ? c.impact.value : null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Round 4 re-check: a page is left out of SK20 only when the product checks price this share of its spend. */
export const PAGE_COVERED_SHARE = 0.8;

/** A number from a fact or a row cell (raw, or a metric payload carrying `value`). */
const amount = (v: unknown): number | null => {
  const x =
    typeof v === "number"
      ? v
      : v && typeof v === "object"
        ? (v as { value?: unknown }).value
        : null;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};

/**
 * The name a parent product goes by: the words its sizes and colours share ("... Belt with
 * Gold Buckle for Jeans & Dresses", not "... - Gold, 4 cm"). Titles that start differently
 * (a second feed's word order) are left out; a lone title is used as it is.
 */
export function parentProductTitle(titles: readonly string[]): string | null {
  const list = [...new Set(titles.map((t) => t.trim()).filter((t) => t.length > 0))];
  if (list.length === 0) return null;
  const lead = (t: string) => t.split(/\s+/).slice(0, 3).join(" ").toLowerCase();
  const counts = new Map<string, number>();
  for (const t of list) counts.set(lead(t), (counts.get(lead(t)) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  const same = list.filter((t) => lead(t) === top);
  if (same.length === 1) return same[0]!;
  const words = same.map((t) => t.split(/\s+/));
  const shared: string[] = [];
  for (let i = 0; i < words[0]!.length; i++) {
    const w = words[0]![i]!;
    if (!words.every((ws) => ws[i] === w)) break;
    shared.push(w);
  }
  const name = shared
    .join(" ")
    .replace(/[\s,;:/&(–-]+$/u, "")
    .trim();
  // too little in common to name the product by: the biggest seller's own title
  return name.split(/\s+/).length >= 3 ? name : same[0]!;
}

export interface PagePricedElsewhere {
  page: Candidate;
  /** the product checks that price this page's products */
  checkIds: string[];
  /** the parent product(s), by the name their sizes and colours share */
  product: string;
  /** the product checks' priced 90-day spend for this page's products */
  coveredSpend90: number;
  /** the page's own 90-day spend (SK20 fact), null when not read */
  pageSpend90: number | null;
  /** true = the product checks price at least PAGE_COVERED_SHARE of the page's spend */
  leaveOut: boolean;
}

/**
 * SK20 findings on product pages whose product a product check (PX05, SH04, SH20) prices.
 * Matched through the shop variant ids in the page's URLs and the item ids of the products
 * read (Shopify ids carry both). A page is left out only when the product checks' priced
 * 90-day spend for its products (PX05 campaign_product_spend, SH04 product spend, SH20 row
 * spend) covers at least PAGE_COVERED_SHARE of the page's own spend; otherwise the page stays
 * a finding and is marked as overlapping (one size priced is not the page).
 */
export function productPagesPricedElsewhere(
  candidates: readonly Candidate[],
  model: AccountModel,
): PagePricedElsewhere[] {
  const parentOfVariant = new Map<string, string>();
  const titlesOf = new Map<string, string[]>();
  const addItem = (id: string | null | undefined, title: string | null | undefined): void => {
    if (!id) return;
    const parent = parentProductKey(id);
    const v = shopifyVariantId(id);
    if (v) parentOfVariant.set(v, parent);
    if (title) titlesOf.set(parent, [...(titlesOf.get(parent) ?? []), title]);
  };
  for (const p of model.children.products) addItem(p.id, p.attrs.title);
  for (const c of model.children.campaigns) {
    const perf = c.attrs.productPerf;
    if (perf?.state === "synced") for (const r of perf.rows) addItem(r.offerId, r.title);
  }
  if (parentOfVariant.size === 0) return [];

  // per parent product: the checks that price it and the 90-day spend each prices. Checks
  // can price the same product (PX05 in one campaign, SH04 account-wide): the biggest counts.
  const priced = new Map<string, { checks: Map<string, number>; names: string[] }>();
  const add = (id: string | null, name: string | null, checkId: string, spend: number) => {
    if (!id) return;
    const key = parentProductKey(id);
    const e = priced.get(key) ?? { checks: new Map<string, number>(), names: [] };
    e.checks.set(checkId, (e.checks.get(checkId) ?? 0) + Math.max(0, spend));
    if (name) e.names.push(name);
    priced.set(key, e);
  };
  for (const c of candidates) {
    if (!PRODUCT_MONEY_CHECKS.includes(c.checkId) || spendMoneyOf(c) == null) continue;
    if (c.checkId === "SH20") {
      for (const r of c.rows ?? [])
        add(r.entity.id, r.entity.name, c.checkId, amount(r.cells.spend) ?? 0);
      continue;
    }
    // a per-campaign SH04 / PX05 finding lists every product with its own spend there
    const perProduct = (c.rows ?? []).filter((r) => amount(r.cells.campaign_product_spend) != null);
    if (perProduct.length > 0) {
      for (const r of perProduct)
        add(r.entity.id, r.entity.name, c.checkId, amount(r.cells.campaign_product_spend) ?? 0);
      continue;
    }
    if (c.scope.type !== "product" || !c.scope.id) continue;
    const spend =
      c.checkId === "PX05" ? amount(c.facts.campaign_product_spend) : amount(c.facts["Pr.spend"]);
    add(c.scope.id, c.scope.name ?? null, c.checkId, spend ?? 0);
  }
  if (priced.size === 0) return [];

  const pages = new Map(model.children.landingPages.map((p) => [p.id, p] as const));
  const out: PagePricedElsewhere[] = [];
  for (const c of candidates) {
    if (c.checkId !== "SK20" || c.scope.type !== "landing_page" || !c.scope.id) continue;
    const page = pages.get(c.scope.id);
    const parents = new Set<string>();
    for (const v of page?.attrs.variantIds ?? []) {
      const parent = parentOfVariant.get(v);
      if (parent && priced.has(parent)) parents.add(parent);
    }
    if (parents.size === 0) continue;
    const checkIds = new Set<string>();
    let covered = 0;
    const names: string[] = [];
    for (const key of parents) {
      const e = priced.get(key)!;
      for (const id of e.checks.keys()) checkIds.add(id);
      covered += Math.max(...e.checks.values());
      names.push(parentProductTitle(titlesOf.get(key) ?? e.names) ?? key);
    }
    const pageSpend = amount(c.facts.spend);
    out.push({
      page: c,
      checkIds: [...checkIds].sort(),
      product: names.join(", "),
      coveredSpend90: round2(covered),
      pageSpend90: pageSpend == null ? null : round2(pageSpend),
      leaveOut: pageSpend != null && pageSpend > 0 && covered >= PAGE_COVERED_SHARE * pageSpend,
    });
  }
  return out;
}

/** One campaign's 90-day product spend, by Shopify variant (or bare item id) and by parent product. */
export interface CampaignProductSpend {
  byVariant: ReadonlyMap<string, number>;
  byParent: ReadonlyMap<string, number>;
}

/** The key a product row and a product finding share: the Shopify variant id, else the bare item id. */
const variantKey = (id: string): string => shopifyVariantId(id) ?? id.trim().toLowerCase();

/**
 * Round 5: each campaign's 90-day spend per product, from its product rows (Performance Max
 * product results). Used to count once the product money a campaign-wide finding already prices.
 */
export function productSpendByCampaign(model: AccountModel): Map<string, CampaignProductSpend> {
  const out = new Map<string, CampaignProductSpend>();
  for (const c of model.children.campaigns) {
    const perf = c.attrs.productPerf;
    if (perf?.state !== "synced" || perf.rows.length === 0) continue;
    const byVariant = new Map<string, number>();
    const byParent = new Map<string, number>();
    for (const r of perf.rows) {
      const cost = Number.isFinite(r.cost) ? Math.max(0, r.cost) : 0;
      byVariant.set(variantKey(r.offerId), (byVariant.get(variantKey(r.offerId)) ?? 0) + cost);
      const parent = parentProductKey(r.offerId);
      byParent.set(parent, (byParent.get(parent) ?? 0) + cost);
    }
    out.set(c.id, { byVariant, byParent });
  }
  return out;
}

/**
 * The 90-day spend of an account-wide product finding (SH20 rows it prices, SH04's product)
 * that sits inside one campaign. A row counts at most its own spend.
 */
function productSpendInside(c: Candidate, inCampaign: CampaignProductSpend): number {
  if (c.checkId === "SH20") {
    let total = 0;
    for (const r of c.rows ?? []) {
      // a row priced by the product waste checks is not in this finding's money
      if (r.cells.priced_here === false || !r.entity.id) continue;
      const own = amount(r.cells.spend) ?? 0;
      total += Math.min(own, inCampaign.byVariant.get(variantKey(r.entity.id)) ?? 0);
    }
    return total;
  }
  if (c.checkId === "SH04" && c.scope.id) {
    const own = amount(c.facts["Pr.spend"]) ?? 0;
    return Math.min(own, inCampaign.byParent.get(parentProductKey(c.scope.id)) ?? 0);
  }
  return 0;
}

/** The campaign a finding's money sits in, or null. */
const campaignOf = (c: Candidate): string | null =>
  c.scope.type === "campaign" ? (c.scope.id ?? null) : (c.scope.campaignId ?? null);

/** Checks whose value gap prices a whole campaign's return (not a slice of its spend). */
const WHOLE_CAMPAIGN_VALUE_GAP: readonly string[] = ["TR01", "TR01a"];
/** Pairs known to price the same campaign money (a fall in return and an over-priced brand click). */
const KNOWN_OVERLAPS: ReadonlyArray<readonly [string, string]> = [
  ["TR01", "BB15"],
  ["TR01a", "BB15"],
];

/**
 * A campaign-scope finding that prices the whole campaign: its money is the campaign's own
 * spend (C.spend basis, not a roll-up of rows), a campaign with no sale (TR06), or the
 * campaign's fall in return (TR01 / TR01a value gap). A finding priced on a roll-up of
 * rows (rollup_wasted_cost_90d) prices a slice of the campaign, never the whole.
 */
export function pricesWholeCampaign(c: Candidate): boolean {
  if (c.scope.type !== "campaign" || !c.scope.id || spendMoneyOf(c) == null) return false;
  if (c.facts[ROLLUP_WASTED_COST_90D] !== undefined) return false;
  if (c.checkId === "TR06") return true;
  if (WHOLE_CAMPAIGN_VALUE_GAP.includes(c.checkId) && c.impact.formulaId === "IMP_VALUE_GAP")
    return true;
  return (c.impact.inputs ?? []).some((i) => i.metric === "C.spend");
}

/**
 * Marks findings that price the same money and returns the run's total counted once.
 *
 *   1. One campaign's findings are merged (the biggest counted, the others counted under it)
 *      only when one of them prices the whole campaign (`pricesWholeCampaign`) or the pair is
 *      a known overlap (TR01 + BB15). Two findings that each price a slice (two roll-ups of
 *      rows) are both counted.
 *      Product money inside a campaign priced as a whole is counted under that finding, only
 *      when it is the campaign's top finding and never past its own money less what the others
 *      merged under it price; what the cap leaves stays counted on the product finding:
 *      1a. a product finding inside that campaign (PX05 in a campaign TR01 prices);
 *      1b. an account-wide product finding (SH20 rows, SH04): the part its product spent inside
 *      the campaign (its 90-day spend there, a month of it; `productSpendByCampaign`).
 *   2. The money counted inside one campaign never passes the campaign's monthly spend
 *      (`campaignMonthly`): the smallest give way first.
 *
 * Writes facts on the overlapping candidates (keeping an `overlaps_with` set earlier, e.g.
 * on an SK20 page whose products a product check prices); their `impact` is left as priced.
 */
export function countMoneyOnce(
  candidates: readonly Candidate[],
  campaignMonthly: ReadonlyMap<string, number>,
  currency: string,
  productSpend: ReadonlyMap<string, CampaignProductSpend> = new Map(),
): PricedMoney {
  const priced = candidates.filter((c) => spendMoneyOf(c) != null);
  const counted = new Map<Candidate, number>(priced.map((c) => [c, spendMoneyOf(c)!]));
  const overlapsWith = new Map<Candidate, Set<string>>();
  const notes = new Map<Candidate, string[]>();
  /** money a whole-campaign finding shares with account-wide product findings (step 1b) */
  const sharedExtra = new Map<Candidate, number>();
  const mark = (c: Candidate, others: readonly Candidate[], note: string): void => {
    const set = overlapsWith.get(c) ?? new Set<string>();
    for (const o of others) if (o !== c) set.add(o.checkId);
    overlapsWith.set(c, set);
    notes.set(c, [...(notes.get(c) ?? []), note]);
  };
  const byMoney = (a: Candidate, b: Candidate): number =>
    spendMoneyOf(b)! - spendMoneyOf(a)! || a.checkId.localeCompare(b.checkId);

  // 0. a kept SK20 page whose products a product check prices in part: the total counts
  //    only the page money the product checks do not (their 90-day spend, a month of it)
  for (const c of priced) {
    if (c.checkId !== "SK20") continue;
    const covered90 = amount(c.facts.product_spend_priced_elsewhere_90d);
    if (covered90 == null || covered90 <= 0) continue;
    const own = spendMoneyOf(c)!;
    counted.set(c, Math.max(0, own - covered90 / 3));
    mark(
      c,
      [],
      `the total counts this page's money less the ${round2(covered90 / 3)} a month the product checks already price`,
    );
  }

  // 1. the same campaign priced as a whole by one finding (or a known overlapping pair)
  const sameCampaign = new Map<string, Candidate[]>();
  for (const c of priced) {
    if (c.scope.type !== "campaign" || !c.scope.id) continue;
    const list = sameCampaign.get(c.scope.id) ?? [];
    list.push(c);
    sameCampaign.set(c.scope.id, list);
  }
  const merged = new Map<string, Candidate[]>();
  /**
   * per campaign: the whole-campaign finding that counts product money under it, and how much
   * more it can take (its own money less what the other findings merged under it price)
   */
  const absorber = new Map<string, { whole: Candidate; left: number }>();
  for (const [id, group] of sameCampaign) {
    const whole = group.filter(pricesWholeCampaign).sort(byMoney)[0];
    let set: Candidate[] = [];
    if (whole) {
      set = [...group];
    } else {
      const ids = new Set(group.map((c) => c.checkId));
      const pair = KNOWN_OVERLAPS.find(([a, b]) => ids.has(a) && ids.has(b));
      if (pair) set = group.filter((c) => pair.includes(c.checkId));
    }
    const top = [...(set.length > 0 ? set : group)].sort(byMoney)[0];
    // product money is counted under the whole-campaign finding only when it is the top one,
    // and never past its own money less what the others merged under it price
    if (whole && top === whole) {
      const others = set.filter((o) => o !== whole).reduce((t, o) => t + spendMoneyOf(o)!, 0);
      absorber.set(id, { whole, left: Math.max(0, spendMoneyOf(whole)! - others) });
    }
    if (set.length < 2) continue;
    merged.set(id, set);
    const rest = [...set].sort(byMoney).slice(1);
    const basis = whole
      ? `${whole.checkId} prices this whole campaign`
      : `${[...new Set(set.map((c) => c.checkId))].join(" and ")} are known to price the same campaign money`;
    const restIds = [...new Set(rest.map((o) => o.checkId))];
    mark(
      top!,
      rest,
      `${basis}; ${restIds.join(", ")} price${restIds.length === 1 && rest.length === 1 ? "s" : ""} money inside it, so the total counts it once, under ${top!.checkId}`,
    );
    for (const o of rest) {
      counted.set(o, 0);
      mark(
        o,
        [top!],
        `${basis}; this money is inside it, so the total counts it once, under ${top!.checkId}`,
      );
    }
  }
  /** counts up to `want` of a product finding's money under the campaign's whole-campaign finding */
  const absorb = (id: string, c: Candidate, want: number, where: string): void => {
    const a = absorber.get(id);
    if (!a) return;
    const take = Math.min(counted.get(c) ?? 0, want, a.left);
    if (take <= 0.005) return;
    a.left -= take;
    counted.set(c, (counted.get(c) ?? 0) - take);
    sharedExtra.set(a.whole, (sharedExtra.get(a.whole) ?? 0) + take);
    const kept = counted.get(c) ?? 0;
    mark(
      c,
      [a.whole],
      `${a.whole.checkId} prices the campaign ${a.whole.scope.name ?? id} as a whole; ${round2(take)} a month of ${where} is inside it, so the total counts it once, under ${a.whole.checkId}${kept > 0.005 ? `; the other ${round2(kept)} a month is counted here` : ""}`,
    );
    mark(
      a.whole,
      [c],
      `${c.checkId} prices ${round2(take)} a month of product money inside it, so the total counts it once, under ${a.whole.checkId}`,
    );
  };

  // 1a. a product finding inside a campaign priced as a whole (PX05 in a campaign TR01 prices)
  for (const id of absorber.keys()) {
    const products = priced
      .filter((c) => c.scope.type === "product" && c.scope.campaignId === id)
      .sort(byMoney);
    for (const c of products) absorb(id, c, spendMoneyOf(c)!, "this product's money");
  }

  // 1b. an account-wide product finding (SH20 rows, SH04) whose product spent inside a
  //     campaign priced as a whole: that part is counted once, under the whole-campaign finding
  for (const id of absorber.keys()) {
    const inCampaign = productSpend.get(id);
    if (!inCampaign) continue;
    for (const c of priced) {
      if (!PRODUCT_MONEY_CHECKS.includes(c.checkId) || c.scope.campaignId) continue;
      absorb(id, c, productSpendInside(c, inCampaign) / 3, "this finding's product spend");
    }
  }

  // 2. one campaign's counted money never passes its monthly spend
  const byCampaign = new Map<string, Candidate[]>();
  for (const c of priced) {
    const id = campaignOf(c);
    if (!id) continue;
    const list = byCampaign.get(id) ?? [];
    list.push(c);
    byCampaign.set(id, list);
  }
  for (const [id, group] of byCampaign) {
    const spend = campaignMonthly.get(id);
    if (spend == null || !Number.isFinite(spend)) continue;
    let excess = group.reduce((t, c) => t + (counted.get(c) ?? 0), 0) - spend;
    if (excess <= 0.005) continue;
    for (const c of [...group].sort(byMoney).reverse()) {
      if (excess <= 0) break;
      const take = Math.min(counted.get(c) ?? 0, excess);
      if (take <= 0) continue;
      counted.set(c, (counted.get(c) ?? 0) - take);
      excess -= take;
      mark(
        c,
        group,
        `the findings on this campaign price more than its spend of ${round2(spend)} a month; the total counts at most its spend`,
      );
    }
  }

  for (const [c, set] of overlapsWith) {
    const own = spendMoneyOf(c)!;
    const once = counted.get(c) ?? own;
    const group = merged.get(campaignOf(c) ?? "") ?? [];
    // the top finding of a group keeps its money: what it shares is what the others price of it
    const shared =
      once < own
        ? own - once
        : group.filter((o) => o !== c).reduce((t, o) => t + Math.min(spendMoneyOf(o)!, own), 0) +
          (sharedExtra.get(c) ?? 0);
    const earlier = Array.isArray(c.facts.overlaps_with) ? (c.facts.overlaps_with as string[]) : [];
    const earlierNote = typeof c.facts.overlap_note === "string" ? [c.facts.overlap_note] : [];
    c.facts = {
      ...c.facts,
      overlaps_with: [...new Set([...earlier, ...set])].sort(),
      shared_money_monthly: round2(Math.min(shared, own)),
      counted_once_monthly: round2(once),
      overlap_note: [...new Set([...earlierNote, ...(notes.get(c) ?? [])])].join("; "),
    };
  }

  return {
    currency,
    findings: priced.length,
    monthly: round2(priced.reduce((t, c) => t + spendMoneyOf(c)!, 0)),
    monthlyCountedOnce: round2(priced.reduce((t, c) => t + (counted.get(c) ?? 0), 0)),
    overlapping: priced.filter((c) => overlapsWith.has(c) || Array.isArray(c.facts.overlaps_with))
      .length,
  };
}
