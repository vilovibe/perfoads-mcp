// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The pure half of `PmaxAudienceSignalService` — the 7-essential-list role
 * classifier and the user-list ref extractor, with no IO and no imports.
 *
 * Split out in the audit rebuild Phase 7e so the pipeline tool
 * `get_pmax_audience_signal_fit` can REUSE them rather than keep a second copy.
 * The service itself pulls in `PmaxOptimizerService` → `google-ads-api`, which a
 * tool executor has no business loading; `PmaxAudienceSignalService` re-exports
 * everything here, so every existing importer is unchanged and there is still
 * exactly one definition of "this list is a purchasers list".
 *
 * @module services/audit/audienceRoles
 */

export type EssentialRole =
  | "allPurchasers"
  | "highValueCustomers"
  | "recentPurchasers"
  | "cartAbandoners"
  | "emailSubscribers"
  | "repeatCustomers"
  | "lapsedCustomers";

export const ESSENTIAL_ROLES: EssentialRole[] = [
  "allPurchasers",
  "highValueCustomers",
  "recentPurchasers",
  "cartAbandoners",
  "emailSubscribers",
  "repeatCustomers",
  "lapsedCustomers",
];

/**
 * Role precedence. A PMax `AssetGroupPersona` wraps many user lists spanning
 * several roles; when one audience covers more than one, the highest-ranked
 * role is the one that describes it.
 */
export const ROLE_RANK: Record<EssentialRole, number> = {
  allPurchasers: 0,
  highValueCustomers: 1,
  recentPurchasers: 2,
  repeatCustomers: 3,
  cartAbandoners: 4,
  emailSubscribers: 5,
  lapsedCustomers: 6,
};

/**
 * Deterministic 7-essential-lists classifier (PL/EN name heuristics + list
 * type). Specific roles are tested before the generic purchaser match so
 * "Porzucone koszyki – klienci" lands on cartAbandoners, not allPurchasers.
 * Returns null for non-essential lists (visitors, generic remarketing,
 * PMAX auto-personas).
 */
export function classifyEssentialRole(
  name: string,
  listType?: string | null,
): EssentialRole | null {
  const n = String(name || "").toLowerCase();
  if (!n || /assetgrouppersona/i.test(n)) return null;
  const isCrm = /crm|customer_match/i.test(String(listType || ""));

  if (/cart|koszyk|checkout|abandon|porzuc/.test(n)) return "cartAbandoners";
  if (/high.*value|top.*spend|vip|ltv|lifetime|wysok\w*\s*wartoś/.test(n))
    return "highValueCustomers";
  if (/recent.*(purchas|buyer|customer|klienc)|ostatni\w*\s*(zakup|klienc)|nowi\s*klienc/.test(n))
    return "recentPurchasers";
  if (/repeat|returning|loyal|powracaj|lojaln|stali\s*klienc/.test(n)) return "repeatCustomers";
  if (/lapsed|inactive|churn|nieaktywn|utracon|dawn\w*\s*klienc/.test(n)) return "lapsedCustomers";
  if (/email|newsletter|subscriber|subskryb|mailing/.test(n)) return "emailSubscribers";
  if (/purchas|buyer|kupuj|nabywc|zakup/.test(n)) return "allPurchasers";
  // Generic "customers/klienci" with no purchase word only counts for
  // CRM/Customer-Match lists — a RULE_BASED "customers" page-visitor list isn't
  // a purchaser list.
  if (isCrm && /klienc|customers/.test(n)) return "allPurchasers";
  return null;
}

/** Extract wrapped user-list IDs from an audience's raw dimensions_json.
 *  Refs appear as "customers/{cid}/userLists/{id}" — regex beats deep-walking
 *  Google's nested oneof shapes. */
export function extractUserListIds(dimensionsJson: string | null | undefined): string[] {
  if (!dimensionsJson) return [];
  const ids = new Set<string>();
  const re = /userLists\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(dimensionsJson))) !== null) if (m[1]) ids.add(m[1]);
  return [...ids];
}

/** Plain English names of the seven roles, for a finding a client reads. */
export const ESSENTIAL_ROLE_LABELS: Record<EssentialRole, string> = {
  allPurchasers: "all purchasers",
  highValueCustomers: "high-value customers",
  recentPurchasers: "recent purchasers",
  cartAbandoners: "cart abandoners",
  emailSubscribers: "email subscribers",
  repeatCustomers: "repeat customers",
  lapsedCustomers: "lapsed customers",
};

/** How a list was matched to a role: its rule, the conversion action it collects on, or its name (fallback). */
export type RoleBasis = "rule" | "conversion_action" | "name";

/** The parts of a user list the role match reads (report alerts plan Phase 11b, AS09). */
export interface ListDefinition {
  name: string | null;
  type: string | null;
  /** lower-cased string values of the rule-based list's INCLUDE operands; null = not read */
  ruleText?: string | null | undefined;
  /** conversion action ids a basic list collects on; null = not read */
  actionIds?: string[] | null | undefined;
  lifeSpanDays?: number | null | undefined;
}

/** A rule on an order-confirmation page (ESSENTIAL_DEFINITIONS: /thank-you, /checkout/success) or a purchase event. */
const PURCHASE_RULE =
  /thank|order[-_ ]?(received|confirm|complete|success)|checkout\/success|\bpurchase|dziekuj|potwierdzeni/;
/** A rule on the cart or checkout (tested after PURCHASE_RULE: Shopify's thank-you page lives under /checkouts/). */
const CART_RULE = /cart|basket|checkout|koszyk/;
/** A list NAMED for people who did not buy (e.g. "Never purchased", "90 days - visitors - not purchased"). */
/** Roles that mean the people bought; a "never purchased" name rules out only these. */
export const BUYER_ROLES: ReadonlySet<EssentialRole> = new Set([
  "allPurchasers",
  "highValueCustomers",
  "recentPurchasers",
  "repeatCustomers",
  "lapsedCustomers",
]);
const NON_BUYER_NAME = /\b(not|never|non|no)[-\s]*(yet[-\s]*)?(purchas|buy|bought|order|convert)/i;
/** A purchaser list kept this short is a recent-purchasers list (ESSENTIAL_DEFINITIONS: membership 30 days). */
const RECENT_LIFE_SPAN_DAYS = 90;

/**
 * Report alerts plan Phase 11b (AS09): the essential roles one list fills.
 * The list's DEFINITION decides first: a rule-based list's include rule
 * (order-confirmation page = all purchasers, cart / checkout = cart abandoners),
 * or a basic list that collects on a PURCHASE conversion action (= all
 * purchasers; kept 90 days or less = recent purchasers too). The name
 * (`classifyEssentialRole`) then ADDS its role, except a buyer role on a list
 * named for people who did not buy.
 */
export function essentialRolesOf(
  list: ListDefinition,
  purchaseActionIds: ReadonlySet<string>,
): Array<{ role: EssentialRole; basis: RoleBasis }> {
  const out: Array<{ role: EssentialRole; basis: RoleBasis }> = [];
  const rule = String(list.ruleText ?? "");
  let purchaser = false;
  if (rule) {
    if (PURCHASE_RULE.test(rule)) {
      out.push({ role: "allPurchasers", basis: "rule" });
      purchaser = true;
    } else if (CART_RULE.test(rule)) out.push({ role: "cartAbandoners", basis: "rule" });
  }
  if (!purchaser && (list.actionIds ?? []).some((id) => purchaseActionIds.has(id))) {
    out.push({ role: "allPurchasers", basis: "conversion_action" });
    purchaser = true;
  }
  if (
    purchaser &&
    list.lifeSpanDays != null &&
    list.lifeSpanDays > 0 &&
    list.lifeSpanDays <= RECENT_LIFE_SPAN_DAYS
  ) {
    out.push({ role: "recentPurchasers", basis: out[out.length - 1]!.basis });
  }
  // The name ADDS roles on top of the definition ("High value customers" on a thank-you rule =
  // purchasers AND high-value). A name saying the people did NOT buy ("Never Purchased") blocks
  // only the buyer roles: "Email subscribers - never purchased" is still an email-subscriber list.
  const name = String(list.name ?? "");
  const add = (role: EssentialRole) => {
    if (!out.some((o) => o.role === role)) out.push({ role, basis: "name" });
  };
  const byName = classifyEssentialRole(name, list.type);
  const nonBuyer = NON_BUYER_NAME.test(name);
  if (byName && !(nonBuyer && BUYER_ROLES.has(byName))) {
    add(byName);
    // "Purchase - 30 days": a purchaser list named for a short window is a recent-purchasers list too
    const days = /(\d+)\s*(?:d\b|days?\b|dgn\b)/i.exec(name);
    if (
      byName === "allPurchasers" &&
      days &&
      Number(days[1]) > 0 &&
      Number(days[1]) <= RECENT_LIFE_SPAN_DAYS
    )
      add("recentPurchasers");
  }
  return out;
}
