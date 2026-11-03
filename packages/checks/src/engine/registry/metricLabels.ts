// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Plain words for every metric id in the registry, for text a shop owner reads.
 * Reasons and evidence quote metric ids ("T.waste_floor", "C.window(w)"); the
 * reply shows these words instead and keeps the raw id in its own field.
 * Every id in `METRICS` has a label (metricLabels.test.ts).
 */
export const METRIC_LABELS: Readonly<Record<string, string>> = {
  "W.range_start": "first day of the period read",
  "W.range_end": "last day of the period read",
  "W.window_days": "days in the period read",
  "W.max_lookback_days": "longest time a conversion can be credited after a click",
  "W.last_settled_day": "last day whose conversions are final",
  "W.settled_days": "days whose conversions are final",
  "W.end_is_yesterday": "whether the data runs to yesterday",
  "Y.status[table]": "whether this part was read",
  "Y.row_count[table]": "rows read for this part",
  "Y.truncated[table]": "whether this part hit its row limit",
  "Y.legacy_count[table]": "rows counted when this part was read",
  "Y.marker_state[table]": "how we know this part was read",
  "DQ.population[table]": "rows that match something in the account",
  "DQ.orphan_rows[table]": "rows that match nothing in the account",
  "A.spend": "account spend",
  "A.spend_daily": "account spend from the daily totals",
  "A.active_days": "days the account spent",
  "A.spend_reconciliation_delta": "gap between the two spend totals",
  "A.clicks": "account clicks",
  "A.impressions": "account impressions",
  "A.conv": "account conversions",
  "A.conv_value": "account sales value",
  "A.roas": "account return on ad spend",
  "A.cpa": "account cost per conversion",
  "A.cvr": "account conversion rate",
  "A.ctr": "account click rate",
  "A.avg_cpc": "account cost per click",
  "A.aov": "average order value",
  "A.roas_window(w)": "account return on ad spend in the period compared",
  "A.spend_monthly": "monthly account spend",
  "A.brand_spend": "spend on brand campaigns",
  "A.brand_spend_share": "share of spend on brand campaigns",
  "A.brand_value": "sales value from brand campaigns",
  "A.brand_roas": "return on ad spend of brand campaigns",
  "A.acquisition_roas": "return on ad spend without brand campaigns",
  "A.conv_actions_count": "conversion actions",
  "A.conv_actions_primary_count": "main (primary) conversion actions",
  "A.conv_actions_with_data_count": "conversion actions with conversions",
  "A.per_action_coverage": "share of conversion actions we could read day by day",
  "CA.daily_conv(action, date)": "conversions of the action that day",
  "CA.last_fire_date(action)": "last day the action recorded a conversion",
  "CA.silent_days(action)": "days the action recorded nothing",
  "CA.fire_cadence(action)": "how often the action usually records conversions",
  "CA.conv_window(action)": "conversions of the action in the period",
  "CA.attribution_model(action)": "how the action credits a conversion",
  "A.attribution_model_mix": "ways the conversion actions credit conversions",
  "A.attribution_model_mix_bidding": "ways the actions bidding uses credit conversions",
  "A.bidding_action_count": "conversion actions bidding uses",
  "CA.lookback(action)": "days a conversion can be credited after a click",
  "CA.counting_type(action)": "whether the action counts one or every conversion per click",
  "A.purchase_action_count": "purchase and sign-up actions",
  "A.conv_per_click_ratio": "signs that one order is counted more than once",
  "A.value_rules_enabled_count": "active conversion value rules",
  "A.value_added_by_rules": "sales value added by conversion value rules",
  "A.value_rules_unconditional": "conversion value rules that apply to everything",
  "A.conv_adjustments_count": "conversion adjustments uploaded",
  "A.offline_jobs_success_count": "successful offline uploads",
  "A.offline_lists_failing": "customer lists whose last upload failed",
  "A.enhanced_conv_leads": "whether enhanced conversions are on",
  "A.customer_data_terms": "whether the customer data terms are accepted",
  "A.tracking_ownership": "who owns the conversion tracking",
  "C.goal_override(campaign)": "whether the campaign uses its own conversion goals",
  "C.viewthrough_share": "share of the campaign's conversions from views, not clicks",
  "C.spend": "campaign spend",
  "C.clicks": "campaign clicks",
  "C.impr": "campaign impressions",
  "C.conv": "campaign conversions",
  "C.value": "campaign sales value",
  "C.roas": "campaign return on ad spend",
  "C.cpa": "campaign cost per conversion",
  "C.product_waste_bar":
    "the spend at which a product with no sale counts as wasted in this campaign",
  "C.product_loss_bar":
    "the spend at which a product that sells at a loss is called out in this campaign",
  "C.cvr": "campaign conversion rate",
  "C.ctr": "campaign click rate",
  "C.spend_share": "campaign share of account spend",
  "C.window(w)": "campaign results in the period compared",
  "C.windows_agree": "whether the last week and the last month point the same way",
  "C.active_days": "days the campaign spent",
  "C.age_days": "days since the campaign first spent",
  "C.days_since_last_conv": "days since the campaign's last conversion",
  "C.budget_daily": "daily budget",
  "C.budget_days": "days the budget could be spent",
  "C.budget_util90": "share of the budget spent",
  "C.capped_days30": "days in the last 30 the budget ran out",
  "C.budget_shared": "whether the budget is shared",
  "C.budget_sibling_count": "campaigns sharing the budget",
  "C.lost_is_budget_pct": "share of ad views lost to budget",
  "C.lost_is_budget_recent_pct": "share of ad views lost to budget in the last 3 weeks",
  "C.lost_is_rank_pct": "share of ad views lost to ad rank",
  "C.impression_share": "share of possible ad views won",
  "C.strategy": "bidding strategy",
  "C.target_roas": "target return on ad spend",
  "C.target_cpa": "target cost per conversion",
  "C.target_vs_realized": "target return compared with the real return",
  "C.ladder_verdict": "whether the bid target fits the conversion volume",
  "C.portfolio_strategy": "shared bidding strategy",
  "C.seasonality_adjustments": "seasonality adjustments and data exclusions",
  "C.simulation_points": "bid simulations available",
  "C.geo_target_type": "who the location targeting reaches",
  "C.frequency_caps_present": "whether a frequency cap is set",
  "C.auto_assets_optin": "automatically created assets switched on",
  "C.url_expansion_opt_out": "whether landing page expansion is off",
  "C.tracking_break_run_days": "days in a row conversions dropped on the same weekday",
  "A.negatives_count": "account negative keywords",
  "A.negative_list_members": "negative keywords in shared lists",
  "A.negative_list_member_sum": "negative keywords the lists say they hold",
  "A.negative_lists_count": "shared negative keyword lists",
  "A.negative_lists_unattached": "negative keyword lists used by no campaign",
  "C.negatives_count": "campaign negative keywords",
  "T.blocked_level(term)": "where the search term is already blocked",
  "A.content_exclusions_count": "content exclusions",
  "A.brand_safety_exclusions": "content types and app categories excluded",
  "A.placement_exclusions_count": "excluded placements",
  "A.auto_apply_enabled_count": "Google recommendations applied automatically",
  "A.experiments_active": "running experiments",
  "C.experiment_arm": "whether the campaign is part of an experiment",
  "A.change_count": "changes in the change history",
  "A.change_users": "people who made changes",
  "A.change_editors": "changes per person",
  "A.google_made_changes": "changes made by Google",
  "A.change_days_covered": "days the change history covers",
  "CH.changes_near(campaign, date, \u00b13d)": "changes around that date",
  "A.user_count": "users with access",
  "A.audience_lists_count": "audience lists",
  "A.audience_lists_usable": "audience lists big enough to use",
  "A.required_list_coverage": "which key audience lists exist",
  "G.spend": "ad group spend",
  "G.conv": "ad group conversions",
  "G.roas": "ad group return on ad spend",
  "G.impression_share": "ad group share of possible ad views",
  "G.lost_is_budget": "ad group ad views lost to budget",
  "G.lost_is_rank": "ad group ad views lost to ad rank",
  "G.ads_count": "live ads in the ad group",
  "G.rsa_count": "responsive search ads in the ad group",
  "G.keyword_count": "keywords in the ad group",
  "K.spend": "keyword spend",
  "K.clicks": "keyword clicks",
  "K.conv": "keyword conversions",
  "K.value": "keyword sales value",
  "K.roas": "keyword return on ad spend",
  "K.cpa": "keyword cost per conversion",
  "K.qs": "keyword quality score",
  "K.qs_component.expected_ctr": "expected click rate (quality score part)",
  "K.qs_component.ad_relevance": "ad relevance (quality score part)",
  "K.qs_component.landing_page_experience": "landing page experience (quality score part)",
  "K.match_type": "match type",
  "K.zero_conv_threshold_clicks": "clicks needed before no conversions means something",
  "K.duplicate_key": "keyword text and match type",
  "T.spend": "search term spend",
  "T.clicks": "search term clicks",
  "T.conv": "search term conversions",
  "T.value": "search term sales value",
  "T.matched_keyword": "keyword that matched the search term",
  "T.ad_group_id": "ad group that showed the ad",
  "T.population_complete": "whether every search term was read",
  "T.brand_token_match": "whether the search term names the brand",
  "T.waste_floor": "the spend above which something with no sales counts as wasted",
  "F.conv_min_for_verdict": "conversions needed to judge a return",
  "F.days_min_for_window": "days of data needed on each side of a comparison",
  "D.headline_count": "headlines in the ad",
  "D.description_count": "descriptions in the ad",
  "D.pinned_count": "pinned headlines and descriptions",
  "D.impressions": "ad impressions",
  "D.approval_status": "ad approval status",
  "D.policy_topics": "ad policy issues",
  "S.asset_label": "Google's performance rating of the asset",
  "S.ext_rows(type, level)": "assets of this type attached",
  "S.ext_distinct(type)": "different texts of this asset type",
  "S.ext_approval_status": "asset approval status",
  "S.ext_impressions(asset)": "asset impressions",
  "S.ext_served_effective(text, type)": "whether the asset ever showed",
  "S.ext_overridden(row)": "whether an ad group asset replaces the campaign one",
  "S.promo_percent_off": "promotion discount",
  "S.promo_end_date": "promotion end date",
  "S.sitelink_link_count": "sitelinks on the campaign",
  "L.spend": "landing page spend",
  "L.conv": "landing page conversions",
  "L.value": "landing page sales value",
  "L.cvr": "landing page conversion rate",
  "L.utm_class": "how the landing page link is tagged",
  "L.utm_class_spend(class)": "landing page spend through links tagged this way",
  "A.utm_class_page_count(class)": "landing pages tagged this way",
  "L.scheme": "whether the landing page is secure (https)",
  "L.speed_score": "landing page speed score",
  "L.mobile_friendly_pct": "share of clicks on mobile-friendly pages",
  "P.channel_cost(network)": "Performance Max spend on this network",
  "P.shopping_share": "share of Performance Max spend on Search and Shopping",
  "P.unclassified_share": "Performance Max spend that cannot be placed",
  "P.ag_ad_strength": "asset group ad strength",
  "P.ag_clicks": "asset group clicks",
  "P.ag_asset_count(field)": "assets of this kind in the asset group",
  "P.ag_gap(field)": "assets of this kind still missing",
  "P.ag_search_themes": "search themes in the asset group",
  "P.ag_audience_signals": "audience signals in the asset group",
  "P.ag_spend": "asset group spend",
  "P.ag_spend_share": "asset group share of campaign spend",
  "P.ag_paused_share": "share of asset groups paused or removed",
  "P.ag_top_spend_share": "share of campaign spend in the biggest asset group",
  "P.listing_included": "product groups included",
  "P.listing_excluded": "product groups excluded",
  "P.brand_theme_click_share": "brand share of Performance Max searches",
  "P.search_term_cost": "Performance Max spend on reported search terms",
  "Pl.cost": "placement spend",
  "Pl.conv": "placement conversions",
  "Pl.impressions": "placement impressions",
  "Pr.spend": "product spend",
  "Pr.conv": "product conversions",
  "Pr.value": "product sales value",
  "Pr.roas": "product return on ad spend",
  "Pr.catalog_never_served": "products that never showed",
  "Pr.spend_share_topN": "share of product spend in the top products",
  "Pr.mc_status": "Merchant Center approval",
  "Pr.missing_attrs": "missing product details",
  "F.feed_valid_rate": "share of products accepted",
  "F.mc_issue_count": "Merchant Center account issues",
  "F.promotions_live": "live Merchant Center promotions",
  "F.promotions_expired": "expired Merchant Center promotions",
  "F.shipping_services": "Merchant Center shipping settings",
  "F.return_policies": "Merchant Center return policies",
  "Sh.campaign_priority": "Shopping campaign priority",
  "Sh.feed_label": "Shopping feed label",
  "Sh.aov": "Shopping average order value",
  "Sh.units_per_order": "units per order",
  "SL.device(scope)": "results by device",
  "SL.device_zero_conv(scope)": "devices with spend and no conversions",
  "SL.device_cpa_multiple(scope, device)": "device cost per conversion compared with the average",
  "SL.geo(scope, country)": "results by country",
  "SL.geo_negatives": "excluded locations",
  "SL.demo(scope, type, value)": "results by age or gender",
  "SL.audience(scope, criterion)": "results by audience",
  "SL.dow(scope, day)": "results by day of the week",
  "SL.hour(scope, hour)": "results by hour of the day",
  "SL.dow_hour(scope, day, hour)": "results by day and hour",
  "SL.bid_modifier(scope, criterion)": "bid adjustment",
  "SL.modifier_vs_slice(scope, criterion)": "bid adjustment compared with the results it adjusts",
  "E.entity_status": "status in Google Ads",
};

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "C.window(w)" -> "C.window", "Y.status[table]" -> "Y.status": text quotes ids with real arguments. */
const baseOf = (id: string): string => id.replace(/[([].*$/, "");
const BY_BASE = new Map(Object.entries(METRIC_LABELS).map(([id, label]) => [baseOf(id), label]));
/** Longest first, so "A.spend_monthly" is never read as "A.spend" + "_monthly". */
const BASES = [...BY_BASE.keys()].sort((a, b) => b.length - a.length);
/** A metric id with any arguments, then an optional sub-key (".cost", ".GOOGLE_ADS_LAST_CLICK"). */
const ID_PATTERN = new RegExp(
  `(?<![\\w.])(${BASES.map(escape).join("|")})(?:\\([^)]*\\)|\\[[^\\]]*\\])?(?:\\.([A-Za-z0-9_]+))?(?![\\w(\\[])`,
  "g",
);

/** "GOOGLE_ADS_LAST_CLICK" / "device_count" -> "google ads last click" / "device count". */
const plainKey = (k: string): string => k.replace(/_/g, " ").toLowerCase();

/** The plain words for a metric key (an id, or an id with a sub-key); null when it is not one. */
export function metricLabel(key: string): string | null {
  const m = new RegExp(`^${ID_PATTERN.source}$`).exec(key);
  if (!m) return null;
  const label = BY_BASE.get(m[1]!)!;
  return m[2] ? `${label}: ${plainKey(m[2])}` : label;
}

/** Every metric id and engine state word in `text` as plain words. */
const rewriteIds = (text: string): string =>
  text
    .replace(ID_PATTERN, (_m, base: string, sub: string | undefined) =>
      sub ? `${BY_BASE.get(base)} (${plainKey(sub)})` : BY_BASE.get(base)!,
    )
    .replace(/\bis not_checkable\b/g, "cannot be worked out")
    .replace(/\bis insufficient_data\b/g, "has too little data");

/**
 * Text with every metric id in it replaced by its plain words. `names` are Google
 * Ads names the text may quote (campaigns, actions...): they stay exactly as Google
 * returns them, even one that looks like a metric id. Only a name the rewrite would
 * change on its own needs guarding, so the list can be every name in the account.
 */
export function plainMetricText(
  text: string,
  names: Iterable<string> = [],
  /** A further rewrite (e.g. table names as words), kept off the names like the ids are. */
  also: (text: string) => string = (t) => t,
): string {
  const rewrite = (t: string) => also(rewriteIds(t));
  const guarded = [...new Set(names)]
    .filter((n) => n !== "" && text.includes(n) && rewrite(n) !== n)
    .sort((a, b) => b.length - a.length);
  if (guarded.length === 0) return rewrite(text);
  // the spans those names take, longest name first, never overlapping
  const spans: [number, number][] = [];
  for (const n of guarded)
    for (let at = text.indexOf(n); at >= 0; at = text.indexOf(n, at + n.length)) {
      const end = at + n.length;
      if (!spans.some(([s, e]) => at < e && end > s)) spans.push([at, end]);
    }
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [s, e] of spans) {
    out += rewrite(text.slice(at, s)) + text.slice(s, e);
    at = e;
  }
  return out + rewrite(text.slice(at));
}
