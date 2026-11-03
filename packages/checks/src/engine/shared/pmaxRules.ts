// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Performance Max rules the checks share: the asset-refusal reading (PX17) and
 * the non-sales pages a campaign with final URL expansion on should exclude
 * (PX20). Pure, no IO.
 */
import type { ListingDimension, ListingGroupNode } from "../model/nodes/ListingGroupNode.js";
import type { UrlExclusion } from "./pmaxTypes.js";

/**
 * An asset Google has DISAPPROVED: primary status DISAPPROVED, or a status
 * detail whose reason is ASSET_DISAPPROVED, on an ENABLED asset link only.
 * Google names reasons for serving assets too (ASSET_APPROVED_LABELED,
 * ASSET_UNDER_REVIEW, ASSET_LINK_PAUSED), and NOT_ELIGIBLE with reason UNKNOWN
 * is every asset of a paused campaign: none of those is a refusal.
 * `linkStatus` undefined = the caller's rows are ENABLED links only.
 */
export function isAssetRefused(
  primaryStatus: unknown,
  primaryStatusDetails: unknown,
  linkStatus?: unknown,
): boolean {
  if (
    linkStatus !== undefined &&
    linkStatus !== null &&
    String(linkStatus).toUpperCase() !== "ENABLED"
  )
    return false;
  if (String(primaryStatus ?? "").toUpperCase() === "DISAPPROVED") return true;
  return (
    Array.isArray(primaryStatusDetails) &&
    primaryStatusDetails.some(
      (d: any) => String(d?.reason ?? d?.reasonCode ?? "").toUpperCase() === "ASSET_DISAPPROVED",
    )
  );
}

/** Google's policy topics / review reasons for a refused asset, in lower-case words. Empty when Google names none. */
export function refusalTopics(primaryStatusDetails: unknown): string[] {
  const topics = new Set<string>();
  if (Array.isArray(primaryStatusDetails)) {
    for (const d of primaryStatusDetails as any[]) {
      const dis = d?.assetDisapproved ?? d?.asset_disapproved ?? {};
      for (const r of [
        ...(dis.offlineEvaluationErrorReasons ?? dis.offline_evaluation_error_reasons ?? []),
        ...(dis.policyTopics ?? []),
      ]) {
        const t = String(r ?? "")
          .toLowerCase()
          .replace(/_/g, " ")
          .trim();
        if (t && t !== "unspecified" && t !== "unknown") topics.add(t);
      }
    }
  }
  return [...topics];
}

/** The refusal in plain words for a card row, with the policy topics when Google names them. */
export function refusalSentence(primaryStatusDetails: unknown): string {
  const topics = refusalTopics(primaryStatusDetails);
  return topics.length > 0
    ? `Google disapproved this asset (${topics.join(", ")}).`
    : "Google disapproved this asset.";
}

export interface UrlExclusionRule {
  /** URL CONTAINS argument, lower case. */
  fragment: string;
  /** Plain words, unique across the list. */
  label: string;
}

/**
 * Non-sales pages a Performance Max campaign with final URL expansion on should
 * never send paid clicks to: legal pages, contact, withdrawal forms, wholesale,
 * jobs. Shop-platform paths first, generic, several languages. Each fragment is
 * a URL CONTAINS argument, lower case. No fragment contains another, and none
 * may hit a product or collection URL (a word that can sit in a product slug is
 * anchored to `/pages/<slug>` or written as a multi-word form).
 */
export const PMAX_URL_EXCLUSION_RULES: readonly UrlExclusionRule[] = [
  { fragment: "/policies/", label: "Shop policy pages" },
  { fragment: "/pages/contact", label: "Contact page" },
  { fragment: "/pages/kontakt", label: "Contact page (DE/NL/PL)" },
  { fragment: "/kontakt/", label: "Contact folder (DE/NL/PL)" },
  { fragment: "kontaktformular", label: "Contact form (DE)" },
  { fragment: "/pages/contatti", label: "Contact page (IT)" },
  { fragment: "impressum", label: "Legal notice (Impressum)" },
  { fragment: "/pages/imprint", label: "Legal notice (Imprint)" },
  { fragment: "mentions-legales", label: "Legal notice (FR)" },
  { fragment: "aviso-legal", label: "Legal notice (ES)" },
  { fragment: "note-legali", label: "Legal notice (IT)" },
  { fragment: "legal-notice", label: "Legal notice" },
  { fragment: "/pages/privacy", label: "Privacy page" },
  { fragment: "privacy-polic", label: "Privacy policy" },
  { fragment: "privacy-notice", label: "Privacy notice" },
  { fragment: "privacy-statement", label: "Privacy statement" },
  { fragment: "privacybeleid", label: "Privacy policy (NL)" },
  { fragment: "/pages/datenschutz", label: "Privacy policy (DE)" },
  { fragment: "datenschutzerkl", label: "Privacy statement (DE)" },
  { fragment: "polityka-prywatnosci", label: "Privacy policy (PL)" },
  { fragment: "politique-de-confidentialite", label: "Privacy policy (FR)" },
  { fragment: "politica-de-privacidad", label: "Privacy policy (ES)" },
  { fragment: "informativa-privacy", label: "Privacy policy (IT)" },
  { fragment: "/pages/terms", label: "Terms page" },
  { fragment: "terms-of-service", label: "Terms of service" },
  { fragment: "/pages/agb", label: "Terms and conditions (DE)" },
  { fragment: "geschaeftsbedingungen", label: "Terms and conditions (DE, ae)" },
  { fragment: "geschaftsbedingungen", label: "Terms and conditions (DE, a)" },
  { fragment: "algemene-voorwaarden", label: "Terms and conditions (NL)" },
  { fragment: "/pages/regulamin", label: "Terms and conditions (PL)" },
  { fragment: "regulamin-sklepu", label: "Shop rules (PL)" },
  { fragment: "conditions-generales", label: "Terms and conditions (FR)" },
  { fragment: "terminos-y-condiciones", label: "Terms and conditions (ES)" },
  { fragment: "termini-e-condizioni", label: "Terms and conditions (IT)" },
  { fragment: "cookie-policy", label: "Cookie policy" },
  { fragment: "cookies-policy", label: "Cookie policy (cookies)" },
  { fragment: "cookie-richtlinie", label: "Cookie policy (DE)" },
  { fragment: "cookiebeleid", label: "Cookie policy (NL)" },
  { fragment: "polityka-cookies", label: "Cookie policy (PL)" },
  { fragment: "politique-cookies", label: "Cookie policy (FR)" },
  { fragment: "politica-de-cookies", label: "Cookie policy (ES)" },
  { fragment: "politica-cookie", label: "Cookie policy (IT)" },
  { fragment: "refund-polic", label: "Refund policy" },
  { fragment: "return-polic", label: "Return policy" },
  { fragment: "shipping-polic", label: "Shipping policy" },
  { fragment: "widerruf", label: "Withdrawal form (DE)" },
  { fragment: "/pages/withdraw", label: "Withdrawal page" },
  { fragment: "withdrawal-form", label: "Withdrawal form" },
  { fragment: "right-of-withdrawal", label: "Right of withdrawal" },
  { fragment: "herroeping", label: "Withdrawal form (NL)" },
  { fragment: "odstapienie", label: "Withdrawal form (PL)" },
  { fragment: "retractation", label: "Withdrawal form (FR)" },
  { fragment: "desistimiento", label: "Withdrawal form (ES)" },
  { fragment: "diritto-di-recesso", label: "Withdrawal form (IT)" },
  { fragment: "/pages/wholesale", label: "Wholesale" },
  { fragment: "/pages/groothandel", label: "Wholesale (NL)" },
  { fragment: "/pages/grosshandel", label: "Wholesale (DE)" },
  { fragment: "/pages/retailer", label: "Retailer pages" },
  { fragment: "/pages/haendler", label: "Retailer pages (DE)" },
  { fragment: "/pages/careers", label: "Careers" },
  { fragment: "/pages/jobs", label: "Jobs" },
];

/**
 * The rules NOT covered by the existing exclusions. Only a CONTAINS condition can
 * cover a rule (an EQUALS condition blocks one exact URL, never a pattern). A rule
 * counts as covered only when the fragment contains the whole existing argument
 * (case-insensitive): that exclusion blocks every URL the fragment would. Never
 * the reverse: CONTAINS "/policies/refund-policy" leaves the other policy pages
 * open, so it does not cover "/policies/".
 */
export function missingExclusions(
  existing: readonly UrlExclusion[] | null | undefined,
  rules: readonly UrlExclusionRule[] = PMAX_URL_EXCLUSION_RULES,
): UrlExclusionRule[] {
  const conds = (existing ?? []).flatMap((e) => (Array.isArray(e?.conditions) ? e.conditions : []));
  const args = conds
    .filter((c) => String(c?.operator ?? "").toUpperCase() === "CONTAINS")
    .map((c) =>
      String(c?.argument ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter((a) => a !== "");
  return rules.filter((r) => {
    const frag = r.fragment.toLowerCase();
    return !args.some((a) => frag.includes(a));
  });
}

/**
 * Under this many products a single product bucket in one asset group is fine: a
 * catalogue that small has nothing to split. A structural default.
 */
export const SMALL_CATALOGUE_PRODUCTS = 10;

/** The product attributes a listing tree splits on, as the catalog or the product node holds them. */
export interface ListingItem {
  /** item id, lowercased */
  id: string;
  /** last "_" part of the id, lowercased (listing groups can carry the variant id) */
  suffix: string;
  customLabels: ReadonlyArray<string | null>;
  brand: string | null;
}

/** "yes" = it reaches an included group, "no" = it cannot, "unknown" = a split we cannot evaluate. */
export type TreeAnswer = "yes" | "no" | "unknown";

const valueMatch = (d: ListingDimension, item: ListingItem): TreeAnswer => {
  const v = "value" in d && d.value != null ? d.value.toLowerCase() : null;
  switch (d.kind) {
    case "root":
      return "yes";
    case "productItemId":
      return v != null && (item.id === v || item.suffix === v) ? "yes" : "no";
    case "productCustomAttribute": {
      const idx = Number(String(d.index ?? "").replace(/\D/g, ""));
      return (item.customLabels[idx] ?? "").toLowerCase() === v ? "yes" : "no";
    }
    case "productBrand":
      return (item.brand ?? "").toLowerCase() === v ? "yes" : "no";
    default:
      // product type levels (a node names one level, the feed the full path), Google
      // category, condition, channel: not evaluable on the item, never rules it out
      return "unknown";
  }
};

const anyOf = (xs: readonly TreeAnswer[]): TreeAnswer =>
  xs.includes("yes") ? "yes" : xs.includes("unknown") ? "unknown" : "no";

/**
 * whether a listing tree (Performance Max asset group) can select this product with its
 * current labels, walking it as Google does: at each split the child whose value matches,
 * else the "everything else" child. No tree = unknown. Pure.
 */
export function listingTreeSelects(
  roots: readonly ListingGroupNode[],
  item: ListingItem,
): TreeAnswer {
  if (roots.length === 0) return "unknown";
  const walk = (n: ListingGroupNode, depth: number): TreeAnswer => {
    if (n.attrs.type === "UNIT_INCLUDED") return "yes";
    if (n.attrs.type === "UNIT_EXCLUDED") return "no";
    if (depth > 20) return "unknown";
    const kids = n.children.children;
    const valued = kids.filter((k) => !k.attrs.isEverythingElse);
    const rest = kids.filter((k) => k.attrs.isEverythingElse);
    const out: TreeAnswer[] = [];
    let matched = false;
    let maybe = false;
    for (const k of valued) {
      const m = valueMatch(k.attrs.dimension, item);
      if (m === "no") continue;
      const r = walk(k, depth + 1);
      if (m === "yes") {
        matched = true;
        out.push(r);
      } else {
        maybe = true;
        out.push(r === "yes" ? "unknown" : r);
      }
    }
    // the "everything else" child takes the product when no valued sibling does
    if (!matched)
      for (const k of rest) {
        const r = walk(k, depth + 1);
        out.push(maybe && r === "yes" ? "unknown" : r);
      }
    return anyOf(out);
  };
  return anyOf(roots.map((r) => walk(r, 0)));
}

/** whether any of the asset groups can select the product (see listingTreeSelects). Pure. */
export function groupsSelect(
  groups: readonly { children: { listingGroups: readonly ListingGroupNode[] } }[],
  item: ListingItem,
): TreeAnswer {
  return anyOf(groups.map((g) => listingTreeSelects(g.children.listingGroups, item)));
}
