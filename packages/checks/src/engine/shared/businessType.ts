// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Business-type classification: how the account makes money, from what the
 * caller declared (profile) and from the account's own signals (conversion
 * types, campaign types, geography).
 */
import type { AccountData } from "./input.js";

/**
 * Business types that require different audit approaches
 *
 * - lead_gen: B2B, SaaS, professional services (NOT geographically constrained)
 * - local_lead_gen: Local services that generate leads (plumbers, dentists, auto shops)
 * - local_retail: Pure local foot traffic (restaurants, retail stores)
 * - ecommerce: Online product sales
 */
export type BusinessType = "lead_gen" | "local_lead_gen" | "local_retail" | "ecommerce" | "unknown";

/**
 * Fix 4: true = lead gen, false = store, null = the type does not say. The
 * same rule as the screens' leadGenFromType,
 * so the chat and the creators call a lead account a lead account.
 */
export function leadGenFromType(businessType: string | null | undefined): boolean | null {
  const t = String(businessType ?? "")
    .trim()
    .toLowerCase();
  if (!t) return null;
  if (t.includes("lead") || t === "local_services" || t === "local_service" || t === "services")
    return true;
  if (
    t === "ecommerce" ||
    t === "ecom" ||
    t === "e_commerce" ||
    t === "local_retail" ||
    t === "retail"
  )
    return false;
  return null;
}

/**
 * Detect business type from questionnaire data and campaign signals
 *
 * Detection Priority:
 * 1. Explicit questionnaire business_type (user confirmed)
 * 2. Questionnaire industry/services keywords
 * 3. Conversion types (purchase = ecom, lead/call = lead gen, directions = local retail)
 * 4. Campaign types (Shopping = ecom, Local = local)
 * 5. Geographic data patterns
 *
 * Key distinction:
 * - local_lead_gen = local business that tracks LEADS (calls, forms, quotes)
 * - local_retail = local business that tracks FOOT TRAFFIC (store visits, directions)
 */
export function detectBusinessType(data: AccountData): BusinessType {
  const signals = {
    ecommerce: 0,
    lead_gen: 0, // B2B/national lead gen
    local_lead_gen: 0, // Local services generating leads
    local_retail: 0, // Local foot traffic businesses
  };

  // ============================================================
  // SIGNAL 0: Explicit user selection (highest priority)
  // ============================================================
  const profile = data.profile ?? null;
  if (profile?.businessType) {
    const explicitType = profile.businessType.toLowerCase();
    if (explicitType === "ecommerce" || explicitType === "e-commerce") return "ecommerce";
    if (explicitType === "lead_gen" || explicitType === "b2b") return "lead_gen";
    if (explicitType === "local_lead_gen" || explicitType === "local_service")
      return "local_lead_gen";
    if (
      explicitType === "local_retail" ||
      explicitType === "retail" ||
      explicitType === "restaurant"
    )
      return "local_retail";
  }

  // ============================================================
  // SIGNAL 1: Questionnaire data (strongest signal)
  // ============================================================
  if (profile) {
    const industry = (profile.industry || "").toLowerCase();
    const goals = Array.isArray(profile.primaryGoals)
      ? profile.primaryGoals.join(" ").toLowerCase()
      : "";
    const services = "";
    const allText = `${industry} ${services} ${goals}`;

    // E-commerce signals
    const ecomKeywords = [
      "ecommerce",
      "e-commerce",
      "online store",
      "retail online",
      "shop online",
      "products",
      "cart",
      "checkout",
      "shopify",
      "woocommerce",
      "magento",
    ];
    if (ecomKeywords.some((k) => allText.includes(k))) {
      signals.ecommerce += 3;
    }
    if (
      goals.includes("sales") ||
      goals.includes("revenue") ||
      goals.includes("roas") ||
      goals.includes("order")
    ) {
      signals.ecommerce += 2;
    }

    // National/B2B Lead gen signals (NOT local)
    const b2bLeadGenKeywords = [
      "b2b",
      "saas",
      "software",
      "enterprise",
      "consulting",
      "agency",
      "professional services",
      "nationwide",
    ];
    if (b2bLeadGenKeywords.some((k) => allText.includes(k))) {
      signals.lead_gen += 3;
    }
    if (goals.includes("demo") || goals.includes("trial") || goals.includes("enterprise")) {
      signals.lead_gen += 2;
    }

    // Local lead gen signals (local + leads)
    const localLeadGenKeywords = [
      "plumber",
      "electrician",
      "hvac",
      "auto",
      "mechanic",
      "dental",
      "dentist",
      "lawyer",
      "attorney",
      "doctor",
      "clinic",
      "salon",
      "spa",
      "cleaning",
      "roofing",
      "contractor",
      "landscaping",
      "pest control",
      "locksmith",
      "towing",
      "repair",
      "service",
    ];
    if (localLeadGenKeywords.some((k) => allText.includes(k))) {
      signals.local_lead_gen += 3;
    }
    if (
      goals.includes("call") ||
      goals.includes("appointment") ||
      goals.includes("booking") ||
      goals.includes("quote") ||
      goals.includes("estimate")
    ) {
      signals.local_lead_gen += 2;
    }

    // Local retail signals (foot traffic focused)
    const localRetailKeywords = [
      "restaurant",
      "cafe",
      "bar",
      "retail store",
      "boutique",
      "grocery",
      "bakery",
      "gym",
      "fitness center",
      "hotel",
      "motel",
    ];
    if (localRetailKeywords.some((k) => allText.includes(k))) {
      signals.local_retail += 3;
    }
    if (
      goals.includes("visit") ||
      goals.includes("foot traffic") ||
      goals.includes("dine") ||
      goals.includes("reservation")
    ) {
      signals.local_retail += 2;
    }
  }

  // ============================================================
  // SIGNAL 2: Conversion actions (strong signal)
  // ============================================================
  let hasLeadConversions = false;
  let hasCallConversions = false;
  let hasDirectionConversions = false;

  if ((data.conversionActions ?? []).length > 0) {
    for (const conv of data.conversionActions ?? []) {
      const name = (conv.name || "").toLowerCase();
      const type = (conv.type || conv.conversion_action_type || "").toLowerCase();

      // E-commerce conversions
      if (
        name.includes("purchase") ||
        name.includes("transaction") ||
        name.includes("sale") ||
        type.includes("purchase") ||
        type.includes("transaction")
      ) {
        signals.ecommerce += 2;
      }

      // Lead/form conversions (could be B2B or local)
      if (
        name.includes("lead") ||
        name.includes("form") ||
        name.includes("submit") ||
        name.includes("signup") ||
        name.includes("demo") ||
        name.includes("contact") ||
        name.includes("quote") ||
        name.includes("estimate")
      ) {
        hasLeadConversions = true;
      }

      // Phone call conversions (strong local lead gen signal)
      if (
        name.includes("call") ||
        name.includes("phone") ||
        type.includes("phone") ||
        type.includes("click_to_call")
      ) {
        signals.local_lead_gen += 2;
        hasCallConversions = true;
      }

      // Direction/store visit conversions (local retail signal)
      if (
        name.includes("direction") ||
        name.includes("store visit") ||
        name.includes("visit") ||
        name.includes("get directions") ||
        name.includes("local action")
      ) {
        signals.local_retail += 2;
        hasDirectionConversions = true;
      }
    }

    // If has both calls AND local actions, it's local lead gen
    if (hasCallConversions && (hasLeadConversions || hasDirectionConversions)) {
      signals.local_lead_gen += 2;
    }

    // If has lead conversions but NO local signals, it's B2B lead gen
    if (hasLeadConversions && !hasCallConversions && !hasDirectionConversions) {
      signals.lead_gen += 2;
    }
  }

  // ============================================================
  // SIGNAL 3: Campaign types (medium signal)
  // ============================================================
  for (const campaign of data.campaigns ?? []) {
    const type = (campaign.campaign_type || campaign.advertising_channel_type || "").toLowerCase();
    const name = (campaign.name || "").toLowerCase();

    // Shopping campaigns = e-commerce
    if (type.includes("shopping") || name.includes("shopping") || name.includes("pmax")) {
      signals.ecommerce += 2;
    }

    // Local campaigns could be either local_lead_gen or local_retail
    if (type.includes("local") || name.includes("local")) {
      // If we already have call signals, it's local lead gen
      if (hasCallConversions) {
        signals.local_lead_gen += 1;
      } else {
        signals.local_retail += 1;
      }
    }
  }

  // ============================================================
  // SIGNAL 4: Geographic data (supporting signal)
  // ============================================================
  if ((data.geographicData ?? []).length > 0) {
    const uniqueLocations = new Set(
      (data.geographicData ?? []).map((g) => g.location_type || g.geo_target_type),
    );
    const isHyperLocal =
      uniqueLocations.has("CITY") ||
      uniqueLocations.has("POSTAL_CODE") ||
      uniqueLocations.has("NEIGHBORHOOD");

    if (isHyperLocal) {
      // Hyper-local targeting suggests local business
      if (hasCallConversions) {
        signals.local_lead_gen += 1;
      } else if (hasDirectionConversions) {
        signals.local_retail += 1;
      } else {
        // Default to local_lead_gen for service businesses
        signals.local_lead_gen += 1;
      }
    }
  }

  // ============================================================
  // DETERMINE WINNER
  // ============================================================
  const allSignals = [
    { type: "ecommerce" as BusinessType, score: signals.ecommerce },
    { type: "lead_gen" as BusinessType, score: signals.lead_gen },
    { type: "local_lead_gen" as BusinessType, score: signals.local_lead_gen },
    { type: "local_retail" as BusinessType, score: signals.local_retail },
  ];

  const maxSignal = Math.max(...allSignals.map((s) => s.score));

  // Need at least 2 points to make a determination
  if (maxSignal < 2) {
    return "unknown";
  }

  // Find the winner
  const winner = allSignals.find((s) => s.score === maxSignal);
  return winner?.type || "unknown";
}
