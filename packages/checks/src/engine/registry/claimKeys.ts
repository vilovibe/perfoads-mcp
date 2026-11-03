// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Claim-key vocabulary — single source of truth for the regression diff and the
 * evidence engine. A finding's `claimKey` and a regression entry's `claimKey` only
 * compare after `normalizeClaimKey`, and a key outside CLAIM_KEYS is UNKNOWN
 * (screened as prose, and a gate failure in structured mode — a renamed key
 * must never silently disarm the gate).
 *
 * Moved here from pipeline/replay/claimKeys.ts (Phase 1d); that path re-exports
 * this module. The §B check ids (build sheet, 130 checks, no SH16) are
 * registered below in the same style, with `CHECK_CLAIM_KEYS` mapping each
 * check id to its key.
 */
export const CLAIM_KEYS = {
  // ---- traps: claims a reviewer proved false; they must never reappear ----
  /** Primary purchase/lead action reported broken/unverified when it is not. */
  TRACKING_PRIMARY_ACTION_BROKEN: "tracking.primary_action_broken",
  /** Paid landing pages reported as organic / untagged. */
  LANDING_PAGE_PAID_TAGGED_AS_ORGANIC: "landing_page.paid_tagged_as_organic",
  /** A conversion action's attribution model reported unidentified/unknown. */
  ATTRIBUTION_MODEL_UNIDENTIFIED: "attribution.model_unidentified",
  /** Promotion percent_off read on the wrong scale (1,000,000 = 100%). */
  PROMOTION_PERCENT_OFF_WRONG_SCALE: "promotion.percent_off_wrong_scale",
  /** Extensions "never served" without applying per-type level override rules. */
  EXTENSIONS_NEVER_SERVED_IGNORING_LEVEL_RULES: "extensions.never_served_ignoring_level_rules",
  /** Device slice with spend and zero conversions (must be campaign-scoped). SL06. */
  DEVICE_ZERO_CONV_WASTE: "device.zero_conv_waste",
  /**
   * Adjacent/competitor-brand queries reported as wasting brand budget on a figure
   * no query reproduces (total non-brand-token spend inside the brand campaigns
   * was far below the amount claimed).
   */
  SEARCH_TERM_ADJACENT_BRAND_WASTE: "search_term.adjacent_brand_waste",
  // ---- true-claim evidence keys ----
  /** Campaign share of window spend (pct). */
  CAMPAIGN_SPEND_SHARE: "campaign.spend_share",
  /** Campaign ROAS over the window (ratio). */
  CAMPAIGN_ROAS: "campaign.roas",
  /** Account spend over the window (money). */
  ACCOUNT_SPEND: "account.spend",
  /** Account-level negative keyword count (count). */
  ACCOUNT_NEGATIVES_COUNT: "account.negatives_count",
  /** Account ROAS, prior 30 days (ratio). */
  ACCOUNT_ROAS_PRIOR_30D: "account.roas_prior_30d",
  /** Account ROAS, most recent 30 days, unmatured (ratio). */
  ACCOUNT_ROAS_RECENT_30D: "account.roas_recent_30d",
  /** Account ROAS, latest settled week (ratio). */
  ACCOUNT_ROAS_SETTLED_WEEK: "account.roas_settled_week",
  /** Cost on a device slice, entity names the scope (money). */
  DEVICE_COST: "device.cost",
  /** Number of conversion actions (count). */
  CONVERSION_ACTIONS_COUNT: "conversion_actions.count",
  /** Landing pages carrying the named utm tagging (count). */
  LANDING_PAGE_UTM_TAGGED_COUNT: "landing_page.utm_tagged_count",
  /** Distinct callout texts in the account (count). */
  EXTENSIONS_DISTINCT_CALLOUTS: "extensions.distinct_callouts",

  // ---- §B.1 measurement integrity ----
  /** MI01 */ TRACKING_PRIMARY_ACTION_SILENT: "tracking.primary_action_silent",
  /** MI02 */ TRACKING_SECONDARY_ACTION_NO_DATA: "tracking.secondary_action_no_data",
  /** MI03 */ TRACKING_DUPLICATE_PURCHASE_ACTIONS: "tracking.duplicate_purchase_actions",
  /** MI04 */ TRACKING_VALUE_RULES_DISTORTING: "tracking.value_rules_distorting",
  /** MI05 */ ATTRIBUTION_MODEL_MIX: "attribution.model_mix",
  /** MI06 */ TRACKING_VIEWTHROUGH_INFLATION: "tracking.viewthrough_inflation",
  /** MI07 */ TRACKING_CAMPAIGN_GOAL_OVERRIDE: "tracking.campaign_goal_override",
  /** MI08 */ WINDOW_UNSETTLED_COMPARISON: "window.unsettled_comparison",
  /** MI09 */ WINDOW_RANGE_END_NOT_YESTERDAY: "window.range_end_not_yesterday",
  /** MI10 */ TRACKING_ENHANCED_CONVERSIONS_MISSING: "tracking.enhanced_conversions_missing",
  /** MI11 */ TRACKING_OWNERSHIP_OK: "tracking.ownership_ok",
  /** MI12 */ TRACKING_OFFLINE_UPLOADS_HEALTHY: "tracking.offline_uploads_healthy",
  /** MI13 */ TRACKING_COUNTING_TYPE_MISMATCH: "tracking.counting_type_mismatch",
  /** MI14 */ TRACKING_VALUE_RULES_UNCONDITIONAL: "tracking.value_rules_unconditional",
  /** MI15 (R3.8) — the customer-acquisition goal adds an extra value to every new-customer sale, inside reported sales */ TRACKING_NEW_CUSTOMER_VALUE_ADDED:
    "tracking.new_customer_value_added",
  /** MI16 (R4-D) — a micro-action (add to cart, checkout, page view, contact) or a $0-value purchase counts as a primary conversion on a shop */ TRACKING_MICRO_ACTION_PRIMARY:
    "tracking.micro_action_primary",
  /** MI17 (R4-D) — much of a new-customer campaign's sales come from people who already bought */ CAMPAIGN_RETURNING_CUSTOMER_SHARE_HIGH:
    "campaign.returning_customer_share_high",
  /** MI18 (R4-D) — days of zero conversions after steady volume, with no data exclusion covering them */ TRACKING_OUTAGE_WITHOUT_DATA_EXCLUSION:
    "tracking.outage_without_data_exclusion",
  // ---- §B.1 keys the MEASUREMENT SPECIALIST may emit (audit rebuild Phase 4,
  // ). The §B checks cover duplicate PURCHASE actions (MI03) and the
  // attribution model MIX (MI05); these three are the claims the specialist can
  // prove that no check owns: more than one PRIMARY action counting the same
  // event, an account still on last-click everywhere, and a conversion action
  // that no campaign or account goal points at. Registered so `diffFindings`,
  // the claim-key cap and the feedback join can all match them.
  /** two or more PRIMARY conversion actions counting the same event. */
  TRACKING_DUPLICATE_PRIMARY_ACTIONS: "tracking.duplicate_primary_actions",
  /** every conversion action still on last-click, so the smart bidding is blind to assists. */
  TRACKING_ATTRIBUTION_LAST_CLICK: "tracking.attribution_last_click",
  /** a conversion action no campaign goal and no account goal points at. */
  TRACKING_GOAL_NOT_LINKED: "tracking.goal_not_linked",
  // ---- §B.2 account structure and controls ----
  /** AS01 */ BRAND_SPEND_SHARE_HIGH: "brand.spend_share_high",
  /** AS02 */ BRAND_CAMPAIGN_TARGET_MISMATCH: "brand.campaign_target_mismatch",
  /** AS03 */ BUDGET_SHARED_SIBLING_STARVATION: "budget.shared_sibling_starvation",
  /** AS04 */ ACCOUNT_AUTO_APPLY_ENABLED: "account.auto_apply_enabled",
  /** AS06 */ ACCOUNT_EXPERIMENT_RUNNING: "account.experiment_running",
  /** AS07 */ ACCOUNT_CONTENT_EXCLUSIONS_MISSING: "account.content_exclusions_missing",
  /** AS08 */ NEGATIVES_LIST_NOT_ATTACHED: "negatives.list_not_attached",
  /** AS09 */ AUDIENCE_REQUIRED_LISTS_MISSING: "audience.required_lists_missing",
  /** AS10 */ ACCOUNT_USER_ACCESS_REVIEW: "account.user_access_review",
  /** AS11 */ CHANGE_FEED_TRUNCATED: "change.feed_truncated",
  /** AS12 */ ACCOUNT_BUDGET_SPLIT_OFF_TARGET: "account.budget_split_off_target",
  /** AS13 (plan 5.2, Gate 1 row 8) — one login made most of the changes in the feed */ CHANGE_EDITS_CONCENTRATED:
    "change.edits_concentrated",
  /** AS14 (R3.6c) — Google changed the account itself: auto-applied recommendations or Google's own tools */ CHANGE_GOOGLE_MADE:
    "change.google_made_changes",
  /** AS15 (R3.6d) — some exclusions are set, but the all-apps category or part of the sensitive-content set is missing */ ACCOUNT_BRAND_SAFETY_GAPS:
    "account.brand_safety_gaps",
  /** AS16 (R3.8) — many campaigns of one kind each too small for their bidding to learn */ ACCOUNT_CAMPAIGNS_TOO_SMALL_TO_LEARN:
    "account.campaigns_too_small_to_learn",
  /** AS17 (R3.8) — the audit runs before the holiday peak and nothing seasonal is set up */ ACCOUNT_SEASONAL_PEAK_NOT_PREPARED:
    "account.seasonal_peak_not_prepared",
  /** AS18 (R4-D) — a campaign meant for new customers does not exclude past buyers */ AUDIENCE_PAST_BUYERS_NOT_EXCLUDED:
    "audience.past_buyers_not_excluded",
  /** AS19 (negatives framework P3) — the same junk theme blocked one by one in 3+ campaigns while the account list is empty */ NEGATIVES_REPEATED_CAMPAIGN_BLOCKS:
    "negatives.repeated_campaign_blocks",
  // ---- §B.3 budget and bidding ----
  /** BB01 */ BUDGET_UTILISATION_LOW: "budget.utilisation_low",
  /** BB02 */ BUDGET_LOST_IS_BUDGET: "budget.lost_is_budget",
  /** BB03 */ BUDGET_LOST_IS_RANK: "budget.lost_is_rank",
  /** BB04 */ BIDDING_AHEAD_OF_DATA: "bidding.ahead_of_data",
  /** BB05 */ BIDDING_TARGET_CHOKING: "bidding.target_choking",
  /** BB06 */ BIDDING_READY_FOR_TARGET: "bidding.ready_for_target",
  /** BB07 */ BUDGET_SCALE_CANDIDATE: "budget.scale_candidate",
  /** BB08 */ BIDDING_PORTFOLIO_UNREVIEWED: "bidding.portfolio_unreviewed",
  /** BB09 */ BIDDING_MODIFIER_CONTRADICTS_DATA: "bidding.modifier_contradicts_data",
  /** BB10 */ BIDDING_SIMULATION_AVAILABLE: "bidding.simulation_available",
  /** BB11 */ BIDDING_SEASONALITY_OVERRIDE_ACTIVE: "bidding.seasonality_override_active",
  /** BB12 */ BUDGET_ABSOLUTE_TOP_IS_LOW: "budget.absolute_top_is_low",
  /** BB13 */ BIDDING_TARGET_THRASH: "bidding.target_thrash",
  /** BB14 (plan 5.2, Gate 1 row 4) — bids on conversion count while its conversions carry order value */ BIDDING_COUNT_WHILE_VALUE_TRACKED:
    "bidding.count_while_value_tracked",
  /** BB15 (R3.8) — brand clicks cost far more than brand clicks should */ BIDDING_BRAND_CPC_HIGH:
    "bidding.brand_cpc_high",
  /** BB16 (R3.8) — budget-limited campaign on a target looser than its results (Google's 17 Aug 2026 change) */ BIDDING_TARGET_LOOSE_WHILE_BUDGET_LIMITED:
    "bidding.target_loose_while_budget_limited",
  /** BB17 (R4-D) — a Smart Bidding campaign whose target or strategy changed inside the last two weeks is still re-learning */ BIDDING_LEARNING_OR_LIMITED:
    "bidding.learning_or_limited",
  // ---- §B.4 search ----
  /** SK01 */ KEYWORD_ZERO_CONV_WASTE: "keyword.zero_conv_waste",
  /** SK02 */ KEYWORD_QS_LOW_HIGH_SPEND: "keyword.qs_low_high_spend",
  /** SK03 */ KEYWORD_MATCH_TYPE_CONCENTRATION: "keyword.match_type_concentration",
  /** SK04 */ KEYWORD_DUPLICATE_ACROSS_ADGROUPS: "keyword.duplicate_across_adgroups",
  /** SK05 */ SEARCH_TERM_ZERO_CONV_WASTE: "search_term.zero_conv_waste",
  /** SK06 */ NEGATIVES_TERM_ALREADY_BLOCKED: "negatives.term_already_blocked",
  /** SK07 */ SEARCH_TERM_BRAND_LEAK: "search_term.brand_leak",
  /** SK08 */ SEARCH_TERM_WRONG_AD_GROUP: "search_term.wrong_ad_group",
  /** SK09 */ SEARCH_TERM_CONVERTING_NOT_KEYWORD: "search_term.converting_not_keyword",
  /** SK10 */ DSA_OVERLAP_WITH_SEARCH: "dsa.overlap_with_search",
  /** SK11 */ ADS_RSA_COUNT_OUT_OF_RANGE: "ads.rsa_count_out_of_range",
  /** SK12 */ ADS_UNDERFILLED: "ads.underfilled",
  /** SK13 */ ADS_PINNING_RESTRICTIVE: "ads.pinning_restrictive",
  /** SK14 */ ADS_ASSETS_LOW_LABEL: "ads.assets_low_label",
  /** SK15 */ ADS_POLICY_ISSUE: "ads.policy_issue",
  /** SK16 */ EXTENSIONS_TYPE_MISSING: "extensions.type_missing",
  /** SK17 */ EXTENSIONS_NEVER_SERVED: "extensions.never_served",
  /** SK18 */ PROMOTION_VALUE_OR_DATE_INVALID: "promotion.value_or_date_invalid",
  /** SK26 — B3 / rule 245 */ EXTENSIONS_DISAPPROVED: "extensions.disapproved",
  /** SK27 (R3.6e) — many small zero-conversion searches sharing a word add up, although no single one clears the bar */ SEARCH_TERM_SMALL_WASTE_ROLLUP:
    "search_term.small_waste_rollup",
  /** SK28 (R3.8) — brand searches inside non-brand Search / Shopping campaigns */ SEARCH_TERM_BRAND_IN_PROSPECTING:
    "search_term.brand_in_prospecting",
  /** SK29 (R3.8) — no research-stage ("how to", "best", "vs") searches covered */ SEARCH_TERM_RESEARCH_INTENT_MISSING:
    "search_term.research_intent_missing",
  /** SK30 (R3.8) — research-stage searches sent to a product page */ LANDING_PAGE_RESEARCH_INTENT_MISMATCH:
    "landing_page.research_intent_mismatch",
  /** SK31 (R3.8) — AI Max never tried on a proven Search campaign */ CAMPAIGN_AI_MAX_UNTESTED:
    "campaign.ai_max_untested",
  /** SK32 (R4-D) — Search Partners or the Display Network switched on in a Search / Shopping campaign */ SETTINGS_SEARCH_PARTNERS_OR_DISPLAY_ON:
    "settings.search_partners_or_display_on",
  /** SK33 (R4-D) — a negative keyword blocks one of the account's own keywords */ NEGATIVES_BLOCK_OWN_KEYWORD:
    "negatives.blocks_own_keyword",
  /** SK34 (R4-E, Gate 1 row 7) — no shared / account negative list on the non-brand Search and Shopping campaigns */ NEGATIVES_NO_SHARED_LIST:
    "negatives.no_shared_list",
  /** SK35 (SEARCH_TYPES_PLAN Phase 3) — Search spend and return per search traffic type, and the types missing */ SEARCH_TERM_TRAFFIC_TYPES:
    "search_term.traffic_types",
  /** SK36 (SEARCH_TYPES_PLAN Phase 3) — an ad group's top searches match a different page of the site than its ads use */ LANDING_PAGE_PHRASE_MISMATCH:
    "landing_page.phrase_page_mismatch",
  /** SK19 */ LANDING_PAGE_URL_HEALTH: "landing_page.url_health",
  /** SK20 */ LANDING_PAGE_LOW_CONVERSION_RATE: "landing_page.low_conversion_rate",
  /** SK21 */ LANDING_PAGE_UTM_CLASSIFICATION: "landing_page.utm_classification",
  /** SK22 */ SCHEDULE_DEAD_ZONE: "schedule.dead_zone",
  /** SK23 */ KEYWORD_TERMS_NOT_TRIGGERED: "keyword.terms_not_triggered",
  /** SK24 */ CAMPAIGN_CTR_BELOW_BENCHMARK: "campaign.ctr_below_benchmark",
  /** SK25 */ AD_GROUP_TOO_MANY_KEYWORDS: "ad_group.too_many_keywords",
  // ---- §B.5 Performance Max ----
  /** PX01 */ PMAX_LOW_SHOPPING_SHARE: "pmax.low_shopping_share",
  /** PX02 */ PMAX_BRAND_LEAK: "pmax.brand_leak",
  /** PX03 */ PMAX_ASSET_GROUP_INCOMPLETE: "pmax.asset_group_incomplete",
  /** PX04 */ PMAX_ASSETS_LOW_LABEL: "pmax.assets_low_label",
  /** PX05 */ PMAX_LISTING_GROUP_LOSERS: "pmax.listing_group_losers",
  /** PX06 */ PMAX_SIGNALS_MISSING: "pmax.signals_missing",
  /** PX14 — one asset group carries most of a campaign's money */
  PMAX_ASSET_GROUP_SPEND_CONCENTRATION: "pmax.asset_group_spend_concentration",
  /** PX15 — most of a campaign's structure is switched off */
  PMAX_STRUCTURE_MOSTLY_PAUSED: "pmax.structure_mostly_paused",
  /** PX07 */ PMAX_PLACEMENT_JUNK: "pmax.placement_junk",
  /** PX16 (R3.6e) — many small zero-conversion placements on one site or in apps add up, although no single one clears the bar */ PMAX_PLACEMENT_SMALL_WASTE_ROLLUP:
    "pmax.placement_small_waste_rollup",
  /** PX08 */ PMAX_AUTO_ASSETS_ON: "pmax.auto_assets_on",
  /** PX17 (R3.4c) — live PMax assets Google disapproved (the Optimizer's alert rule 2) */
  PMAX_ASSETS_REFUSED: "pmax.assets_refused",
  /** PX18 (R3.4c) — one live asset group sells the whole catalogue with no product split (the Optimizer's catch-all rule) */
  PMAX_SINGLE_BUCKET: "pmax.single_bucket_structure",
  /** PX19 (R3.8) — Performance Max serving much of its traffic inside mobile apps and games */ PMAX_APP_INVENTORY_SHARE:
    "pmax.app_inventory_share",
  /** PX09 */ PMAX_AD_STRENGTH_POOR: "pmax.ad_strength_poor",
  /** PX10 */ PMAX_URL_EXPANSION_ON: "pmax.url_expansion_on",
  /** PX20 — final URL expansion on, legal and contact pages not excluded (PLAN_PMAX_URL_EXCLUSIONS) */ PMAX_URL_EXCLUSIONS_MISSING:
    "pmax.url_exclusions_missing",
  /** PX21 (negatives framework P3) — a live non-brand PMax campaign with no blocked searches at all (no own blocks, no list, no account list) */ PMAX_NO_NEGATIVES:
    "pmax.no_negatives",
  /** PX22 (negatives framework P3) — PMax searches that cost money and never sold, grouped by reason */ PMAX_SEARCH_TERM_WASTE:
    "pmax.search_term_waste",
  /** PX23 (placement watch) — Performance Max showing in game, kids or phone tool apps or parked sites (views only) */ PMAX_PLACEMENT_CONTENT_JUNK:
    "pmax.placement_content_junk",
  /** PX11 */ PMAX_PRODUCT_IN_MULTIPLE_ASSET_GROUPS: "pmax.product_in_multiple_asset_groups",
  /** PX12 */ PMAX_CATEGORY_OVERLAPS_SEARCH_CAMPAIGN: "pmax.category_overlaps_search_campaign",
  /** PX13 */ PMAX_IMAGE_COVERAGE_BELOW_SPEC: "pmax.image_coverage_below_spec",
  // ---- §B.5 keys the PMax SPECIALIST may emit.
  // Coined in `fixtures/corpus/claimkey-backfill.json` against real reviewer
  // feedback and registered here so the specialist's claims are matchable by
  // `diffFindings`, the claim-key cap and the feedback join. No §B check owns
  // them yet: they are model-decided, code-cited claims, not rulebook checks.
  /** the asset group carrying the campaign's best return is switched off. */
  PMAX_BEST_ASSET_GROUP_PAUSED: "pmax.best_asset_group_paused",
  /** the listing-group tree exposes only a fraction of the catalogue to the campaign. */
  PMAX_PRODUCT_SCOPE_NARROW: "pmax.product_scope_narrow",
  /** asset groups run with no search themes at all. */
  PMAX_SEARCH_THEMES_MISSING: "pmax.search_themes_missing",
  // ---- §B.5 audience-signal FIT. Named
  // by `pmaxSpecialistPrompt` and decided by `get_pmax_audience_signal_fit`:
  // presence was already checkable, fit was not.
  /** a prospecting asset group is seeded only with past-buyer lists, so it has no prospecting seed. */
  PMAX_AUDIENCE_SEED_WRONG: "pmax.audience_seed_wrong",
  /** a search theme is off this asset group's scope — the account's own brand, or a sibling group's theme. */
  PMAX_AUDIENCE_THEME_OFF_SCOPE: "pmax.audience_theme_off_scope",
  // ---- plan 5.1 cross-channel. Built by CODE after the specialists
  // merge (`specialists/crossChannel.ts`), from two verified bundles on different
  // channels that share an entity or a signal. No §B check owns them.
  /** PMax spends on brand queries while the brand Search campaign carries its own finding */
  CROSS_CHANNEL_BRAND: "cross_channel.brand_pmax_vs_search",
  /** the same products carry a finding in PMax and in Shopping */
  CROSS_CHANNEL_PRODUCT_OVERLAP: "cross_channel.pmax_shopping_product_overlap",
  /** the same search terms carry a finding in Search and in PMax */
  CROSS_CHANNEL_TERM_OVERLAP: "cross_channel.search_pmax_term_overlap",
  /** conversion-based findings in two or more channels rest on tracking the measurement review doubts */
  CROSS_CHANNEL_TRACKING: "cross_channel.tracking_vs_conversion_claims",
  // ---- §B.6 Shopping and feed (no SH16) ----
  /** SH01 */ FEED_DISAPPROVAL_RATE: "feed.disapproval_rate",
  /** SH02 */ FEED_ACCOUNT_ISSUES: "feed.account_issues",
  /** SH03 */ PRODUCT_SPEND_CONCENTRATION: "product.spend_concentration",
  /** SH04 */ PRODUCT_ZERO_CONV_WASTE: "product.zero_conv_waste",
  /** SH05 */ PRODUCT_SCALE_CANDIDATE: "product.scale_candidate",
  /** SH06 */ PRODUCT_ATTRIBUTES_MISSING: "product.attributes_missing",
  /** SH08 */ FEED_PROMOTIONS_EXPIRED: "feed.promotions_expired",
  /** SH09 */ FEED_POLICIES_MISSING: "feed.policies_missing",
  /** SH10 */ SHOPPING_CAMPAIGN_OVERLAP: "shopping.campaign_overlap",
  /** SH11 */ PRODUCT_AOV_CONTEXT: "product.aov_context",
  /** SH12 */ SHOPPING_ITEM_OVERLAP_WITH_PMAX: "shopping.item_overlap_with_pmax",
  /** SH13 */ PRODUCT_TITLE_STRUCTURE_WEAK: "product.title_structure_weak",
  /** SH14 */ PRODUCT_CUSTOM_LABELS_MISSING: "product.custom_labels_missing",
  /** SH15 */ FEED_SOURCE_DISAGREEMENT: "feed.source_disagreement",
  /** SH17 */ SHOPPING_PRIORITY_AND_FILTER_UNKNOWN: "shopping.priority_and_filter_unknown",
  /** SH18 */ PRODUCT_QUADRANT: "product.quadrant",
  /** SH19 */ PRODUCT_ZERO_IMPRESSIONS: "product.zero_impressions",
  /** SH20 */ PRODUCT_UNDERPERFORMING_CLONE: "product.underperforming_clone",
  /** SH21 */ PRODUCT_COGS_MISSING: "product.cogs_missing",
  /**
   * SH21's margin leg: a campaign returns under the
   * break-even set by the client's stated margin. Its own key so the money
   * finding reaches `warning` and routes to Budget & Bidding, while
   * `product.cogs_missing` (the data-gap claim) keeps its `info` ceiling.
   */
  CAMPAIGN_BELOW_BREAKEVEN_AFTER_MARGIN: "campaign.below_breakeven_after_margin",
  /** SH22 (R3.8) — no Merchant Center promotion live */ FEED_NO_ACTIVE_PROMOTION:
    "feed.no_active_promotion",
  /** SH23 (R3.8) — gift cards, test items or $0 items getting ad traffic */ PRODUCT_JUNK_IN_ADS:
    "product.junk_in_ads",
  /** SH24 (R3.8) — store quality and seller ratings are not readable by an outside tool */ FEED_STORE_QUALITY_UNREADABLE:
    "feed.store_quality_unreadable",
  // ---- §B.7 slices ----
  /** SL01 */ AUDIENCE_SEGMENT_UNDERPERFORMS: "audience.segment_underperforms",
  /** SL02 */ AUDIENCE_LISTS_UNUSED: "audience.lists_unused",
  /** SL03 */ GEO_COUNTRY_UNDERPERFORMS: "geo.country_underperforms",
  /** SL04 */ GEO_PRESENCE_OR_INTEREST: "geo.presence_or_interest",
  /** SL05 */ DEVICE_CPA_SKEW: "device.cpa_skew",
  /** SL07 */ DEMOGRAPHIC_SEGMENT_UNDERPERFORMS: "demographic.segment_underperforms",
  /** SL08 */ SCHEDULE_MARGINAL_ONLY: "schedule.marginal_only",
  /** SL09 (B17: return per dollar, or cost per sale without values; was conversion rate) */ DEVICE_MOBILE_RETURN_BELOW_DESKTOP:
    "device.mobile_return_below_desktop",
  /** SL10 (R4-D) — one campaign serves two or more countries on one feed / currency */ GEO_MULTI_COUNTRY_CAMPAIGN:
    "geo.multi_country_campaign",
  /** SL11 (R4-D) — spend in countries the shop does not deliver to */ GEO_SPEND_OUTSIDE_MARKETS:
    "geo.spend_outside_markets",
  /** SL12 (R4-D) — campaign language vs the shop's language (campaign language not synced yet) */ SETTINGS_LANGUAGE_MISMATCH:
    "settings.language_mismatch",
  // ---- §B.8 trends and change ----
  /** TR01 */ TREND_PERFORMANCE_DECLINING: "trend.performance_declining",
  /** TR01a */ TREND_ACCOUNT_PERFORMANCE_DECLINING: "trend.account_performance_declining",
  /** TR02 */ TREND_LATEST_SETTLED_WEEK: "trend.latest_settled_week",
  /** TR03 */ CHANGE_DATED_CAUSE: "change.dated_cause",
  /** TR04 */ TREND_SEASONALITY: "trend.seasonality",
  /** TR05 */ CAMPAIGN_DORMANT_WINNER: "campaign.dormant_winner",
  /** TR06 */ CAMPAIGN_ZOMBIE: "campaign.zombie",
  /** TR07 */ PAID_ORGANIC_BRAND_CANNIBALISATION: "paid_organic.brand_cannibalisation",
  /** TR08 (phase 6) — the positive that says what is EARNING, not what is absent */ PERFORMANCE_CARRYING_CAMPAIGN:
    "performance.carrying_campaign",
  /** TR09 (round 3 R4) — a live campaign's sales value fell while its return per $1 fell less, held or rose (title by the numbers, `tr09Title`; key unchanged) */ TREND_SALES_FELL_RETURN_HELD:
    "trend.sales_fell_return_held",
  /** TR10 (round 4 R16) — a live campaign or the account brought in less sales value than it spent */ RETURN_BELOW_SPEND:
    "performance.return_below_spend",
  /** TR08 standout branch — the best return per dollar among campaigns that are not brand, never "carries" */ PERFORMANCE_STANDOUT_NON_BRAND:
    "performance.standout_non_brand",
  // ---- §B.9 other channels (presence) ----
  /** PR01 */ REACH_FREQUENCY_CAP_MISSING: "reach.frequency_cap_missing",
  /** PR02 */ CHANNEL_PRESENCE: "channel.presence",
  /** PR03 */ LSA_PRESENCE: "lsa.presence",
  /** PR04 (Phase 11) */ LSA_LEAD_VOLUME_DECLINING: "lsa.lead_volume_declining",
  /** PR05 (Phase 11) */ LSA_LEADS_DISPUTED_HIGH: "lsa.leads_disputed_high",
  /** PR06 (Phase 11) */ LSA_CALLS_UNANSWERED: "lsa.calls_unanswered",
  /** PR07 (Phase 11) */ LSA_VERIFICATION_EXPIRING: "lsa.verification_expiring",
  // ---- §B.10 / §G.9 Demand Gen ----
  /** DG01 */ DGEN_OPTIMIZATION_GOAL_UNSET: "dgen.optimization_goal_unset",
  /** DG02 */ DGEN_ASSETS_BELOW_MINIMUM: "dgen.assets_below_minimum",
  /** DG03 */ DGEN_AUDIENCE_SIGNALS_MISSING: "dgen.audience_signals_missing",
  /** DG04 */ DGEN_CHANNEL_CONCENTRATION: "dgen.channel_concentration",
  /** DG05 */ DGEN_VIDEO_ENGAGEMENT_LOW: "dgen.video_engagement_low",
  /** DG06 */ DGEN_FEED_ATTACHED_NO_SALES: "dgen.feed_attached_no_sales",
  /** DG07 */ DGEN_VIDEO_METRICS_INCONSISTENT: "dgen.video_metrics_inconsistent",
  /** DG08 — a cold Demand Gen campaign targets lists of people who know the shop, age / gender only, or no lookalike and no search segment */ DGEN_COLD_AUDIENCE_WRONG:
    "dgen.cold_audience_wrong",
  /** DG09 — a cold Demand Gen campaign does not leave out site visitors, cart or email lists */ DGEN_COLD_KNOWN_PEOPLE_NOT_EXCLUDED:
    "dgen.cold_known_people_not_excluded",
  /** DG10 — live Demand Gen ad text breaks the builder's ad text rules */ DGEN_AD_TEXT_RULES:
    "dgen.ad_text_rules",
  /** DG11 — a live Demand Gen campaign fails an after-launch gate (dgGates) */ DGEN_AFTER_LAUNCH_GATE:
    "dgen.after_launch_gate",
  /** DG16 — a Demand Gen channel loses money (shared verdict rule, cost floor) */ DGEN_CHANNEL_LOSING_MONEY:
    "dgen.channel_losing_money",
  /** DG12 — an online shop with a feed and Shopping / PMax spend runs no live Demand Gen for new customers */ DGEN_ECOM_NO_COLD:
    "dgen.ecom_no_cold",
  /** DG13 — image-only Demand Gen spends on YouTube / Gmail / Display for a return under the account's */ DGEN_IMAGE_ADS_OFF_DISCOVER:
    "dgen.image_ads_off_discover",
  /** DG14 — a cold Demand Gen bids on past buyers, sits under the reach floor or stacks lookalikes */ DGEN_COLD_SETUP_WRONG:
    "dgen.cold_setup_wrong",
  /** DG15 — cold Demand Gen article / listicle ads read like a product sheet (Phase 1 scorer) or carry a hard ban */ DGEN_COLD_COPY_PRODUCT_SHEET:
    "dgen.cold_copy_product_sheet",
  /** DG17 — Demand Gen lines Google rates Low or that get far fewer clicks than the rest, next to the lines that won */ DGEN_LINES_BEST_WORST:
    "dgen.lines_best_worst",
  /** DG18 — a Demand Gen video campaign holds more than 2 videos */ DGEN_VIDEO_TOO_MANY:
    "dgen.video_too_many",
  /** DG19 (DG_VIDEO_FRAMEWORK_PLAN phase 2) — no video in the shape a placement it runs on needs */ DGEN_VIDEO_SHAPE_MISSING:
    "dgen.video_shape_missing",
  /** DG20 (DG_VIDEO_FRAMEWORK_PLAN phase 2) — a video too long for where it runs */ DGEN_VIDEO_LENGTH_WRONG:
    "dgen.video_length_wrong",
  /** DG21 (DG_VIDEO_FRAMEWORK_PLAN phase 2) — a cold video sends people to the homepage or a plain product / collection page */ DGEN_VIDEO_COLD_LANDING:
    "dgen.video_cold_landing",
  /** DG22 (DG_VIDEO_FRAMEWORK_PLAN phase 2) — new people and people who know the shop targeted in one video campaign */ DGEN_VIDEO_AUDIENCES_MIXED:
    "dgen.video_audiences_mixed",
  /** DG23 (DG_VIDEO_FRAMEWORK_PLAN phase 2) — a video's view rate, click rate or buyers per click under the framework bands */ DGEN_VIDEO_NUMBERS_LOW:
    "dgen.video_numbers_low",
  /** DG24 (DG_VIDEO_FRAMEWORK_PLAN phase 2) — a tired video: click / view rate down week after week */ DGEN_VIDEO_TIRED:
    "dgen.video_tired",
  /** SK37 — live Search ad text breaks the builder's ad text rules */ ADS_SEARCH_TEXT_RULES:
    "ads.search_text_rules",
  /** SK38 — keywords naming other brands on a page that is not a comparison page */ KEYWORD_RIVAL_ON_WRONG_PAGE:
    "keyword.rival_on_wrong_page",
  /** SK39 — a recipe campaign's exact match share far under its recipe */ KEYWORD_RECIPE_EXACT_SHARE_LOW:
    "keyword.recipe_exact_share_low",
  /** SK40 — sitelinks for the other gender on a one-gender Search campaign */ EXTENSIONS_SITELINK_OFF_AUDIENCE:
    "extensions.sitelink_off_audience",
  /** SK41 — competitors people search for, worth a separate competitor campaign once the core is profitable */ SEARCH_COMPETITOR_CAMPAIGN_OPPORTUNITY:
    "search.competitor_campaign_opportunity",
  // ---- §G.10 Video ----
  /** VD01 */ VIDEO_VIEW_RATE_LOW: "video.view_rate_low",
  /** VD02 */ VIDEO_QUARTILE_DROPOFF: "video.quartile_dropoff",
  /** VD03 */ VIDEO_TARGETING_UNBOUNDED: "video.targeting_unbounded",
  /** VD04 */ VIDEO_VIEWTHROUGH_SHARE_HIGH: "video.viewthrough_share_high",
  /** VD05 */ VIDEO_COMPANION_BANNER_MISSING: "video.companion_banner_missing",
  /** VD06 */ VIDEO_FORMAT_MIX_UNKNOWN: "video.format_mix_unknown",
  /** VD07 */ VIDEO_CPV_OUT_OF_BAND: "video.cpv_out_of_band",
} as const;

export type ClaimKey = (typeof CLAIM_KEYS)[keyof typeof CLAIM_KEYS];

/**
 * The trap claim keys: findings a reviewer proved false. Kept so any consumer
 * of claims (a writer, a validator) can drop them.
 */
export const TRAP_CLAIM_KEYS: ReadonlySet<string> = new Set<string>([
  CLAIM_KEYS.TRACKING_PRIMARY_ACTION_BROKEN,
  CLAIM_KEYS.LANDING_PAGE_PAID_TAGGED_AS_ORGANIC,
  CLAIM_KEYS.ATTRIBUTION_MODEL_UNIDENTIFIED,
  CLAIM_KEYS.PROMOTION_PERCENT_OFF_WRONG_SCALE,
  CLAIM_KEYS.EXTENSIONS_NEVER_SERVED_IGNORING_LEVEL_RULES,
  CLAIM_KEYS.DEVICE_ZERO_CONV_WASTE,
  CLAIM_KEYS.SEARCH_TERM_ADJACENT_BRAND_WASTE,
]);

/** Build sheet §B check id → claim key. 130 entries (33 + 68 + 15 + 3 + 2 + 7 + 2); there is no SH16. */
export const CHECK_CLAIM_KEYS: Readonly<Record<string, ClaimKey>> = {
  MI01: CLAIM_KEYS.TRACKING_PRIMARY_ACTION_SILENT,
  MI02: CLAIM_KEYS.TRACKING_SECONDARY_ACTION_NO_DATA,
  MI03: CLAIM_KEYS.TRACKING_DUPLICATE_PURCHASE_ACTIONS,
  MI04: CLAIM_KEYS.TRACKING_VALUE_RULES_DISTORTING,
  MI05: CLAIM_KEYS.ATTRIBUTION_MODEL_MIX,
  MI06: CLAIM_KEYS.TRACKING_VIEWTHROUGH_INFLATION,
  MI07: CLAIM_KEYS.TRACKING_CAMPAIGN_GOAL_OVERRIDE,
  MI08: CLAIM_KEYS.WINDOW_UNSETTLED_COMPARISON,
  MI09: CLAIM_KEYS.WINDOW_RANGE_END_NOT_YESTERDAY,
  MI10: CLAIM_KEYS.TRACKING_ENHANCED_CONVERSIONS_MISSING,
  MI11: CLAIM_KEYS.TRACKING_OWNERSHIP_OK,
  MI12: CLAIM_KEYS.TRACKING_OFFLINE_UPLOADS_HEALTHY,
  MI13: CLAIM_KEYS.TRACKING_COUNTING_TYPE_MISMATCH,
  MI14: CLAIM_KEYS.TRACKING_VALUE_RULES_UNCONDITIONAL,
  MI15: CLAIM_KEYS.TRACKING_NEW_CUSTOMER_VALUE_ADDED,
  MI16: CLAIM_KEYS.TRACKING_MICRO_ACTION_PRIMARY,
  MI17: CLAIM_KEYS.CAMPAIGN_RETURNING_CUSTOMER_SHARE_HIGH,
  MI18: CLAIM_KEYS.TRACKING_OUTAGE_WITHOUT_DATA_EXCLUSION,
  AS01: CLAIM_KEYS.BRAND_SPEND_SHARE_HIGH,
  AS02: CLAIM_KEYS.BRAND_CAMPAIGN_TARGET_MISMATCH,
  AS03: CLAIM_KEYS.BUDGET_SHARED_SIBLING_STARVATION,
  AS04: CLAIM_KEYS.ACCOUNT_AUTO_APPLY_ENABLED,
  AS06: CLAIM_KEYS.ACCOUNT_EXPERIMENT_RUNNING,
  AS07: CLAIM_KEYS.ACCOUNT_CONTENT_EXCLUSIONS_MISSING,
  AS08: CLAIM_KEYS.NEGATIVES_LIST_NOT_ATTACHED,
  AS09: CLAIM_KEYS.AUDIENCE_REQUIRED_LISTS_MISSING,
  AS10: CLAIM_KEYS.ACCOUNT_USER_ACCESS_REVIEW,
  AS11: CLAIM_KEYS.CHANGE_FEED_TRUNCATED,
  AS12: CLAIM_KEYS.ACCOUNT_BUDGET_SPLIT_OFF_TARGET,
  AS13: CLAIM_KEYS.CHANGE_EDITS_CONCENTRATED,
  AS14: CLAIM_KEYS.CHANGE_GOOGLE_MADE,
  AS15: CLAIM_KEYS.ACCOUNT_BRAND_SAFETY_GAPS,
  AS16: CLAIM_KEYS.ACCOUNT_CAMPAIGNS_TOO_SMALL_TO_LEARN,
  AS17: CLAIM_KEYS.ACCOUNT_SEASONAL_PEAK_NOT_PREPARED,
  AS18: CLAIM_KEYS.AUDIENCE_PAST_BUYERS_NOT_EXCLUDED,
  AS19: CLAIM_KEYS.NEGATIVES_REPEATED_CAMPAIGN_BLOCKS,
  BB01: CLAIM_KEYS.BUDGET_UTILISATION_LOW,
  BB02: CLAIM_KEYS.BUDGET_LOST_IS_BUDGET,
  BB03: CLAIM_KEYS.BUDGET_LOST_IS_RANK,
  BB04: CLAIM_KEYS.BIDDING_AHEAD_OF_DATA,
  BB05: CLAIM_KEYS.BIDDING_TARGET_CHOKING,
  BB06: CLAIM_KEYS.BIDDING_READY_FOR_TARGET,
  BB07: CLAIM_KEYS.BUDGET_SCALE_CANDIDATE,
  BB08: CLAIM_KEYS.BIDDING_PORTFOLIO_UNREVIEWED,
  BB09: CLAIM_KEYS.BIDDING_MODIFIER_CONTRADICTS_DATA,
  BB10: CLAIM_KEYS.BIDDING_SIMULATION_AVAILABLE,
  BB11: CLAIM_KEYS.BIDDING_SEASONALITY_OVERRIDE_ACTIVE,
  BB12: CLAIM_KEYS.BUDGET_ABSOLUTE_TOP_IS_LOW,
  BB13: CLAIM_KEYS.BIDDING_TARGET_THRASH,
  BB14: CLAIM_KEYS.BIDDING_COUNT_WHILE_VALUE_TRACKED,
  BB15: CLAIM_KEYS.BIDDING_BRAND_CPC_HIGH,
  BB16: CLAIM_KEYS.BIDDING_TARGET_LOOSE_WHILE_BUDGET_LIMITED,
  BB17: CLAIM_KEYS.BIDDING_LEARNING_OR_LIMITED,
  SK01: CLAIM_KEYS.KEYWORD_ZERO_CONV_WASTE,
  SK02: CLAIM_KEYS.KEYWORD_QS_LOW_HIGH_SPEND,
  SK03: CLAIM_KEYS.KEYWORD_MATCH_TYPE_CONCENTRATION,
  SK04: CLAIM_KEYS.KEYWORD_DUPLICATE_ACROSS_ADGROUPS,
  SK05: CLAIM_KEYS.SEARCH_TERM_ZERO_CONV_WASTE,
  SK06: CLAIM_KEYS.NEGATIVES_TERM_ALREADY_BLOCKED,
  SK07: CLAIM_KEYS.SEARCH_TERM_BRAND_LEAK,
  SK08: CLAIM_KEYS.SEARCH_TERM_WRONG_AD_GROUP,
  SK09: CLAIM_KEYS.SEARCH_TERM_CONVERTING_NOT_KEYWORD,
  SK10: CLAIM_KEYS.DSA_OVERLAP_WITH_SEARCH,
  SK11: CLAIM_KEYS.ADS_RSA_COUNT_OUT_OF_RANGE,
  SK12: CLAIM_KEYS.ADS_UNDERFILLED,
  SK13: CLAIM_KEYS.ADS_PINNING_RESTRICTIVE,
  SK14: CLAIM_KEYS.ADS_ASSETS_LOW_LABEL,
  SK15: CLAIM_KEYS.ADS_POLICY_ISSUE,
  SK16: CLAIM_KEYS.EXTENSIONS_TYPE_MISSING,
  SK17: CLAIM_KEYS.EXTENSIONS_NEVER_SERVED,
  SK18: CLAIM_KEYS.PROMOTION_VALUE_OR_DATE_INVALID,
  SK19: CLAIM_KEYS.LANDING_PAGE_URL_HEALTH,
  SK20: CLAIM_KEYS.LANDING_PAGE_LOW_CONVERSION_RATE,
  SK21: CLAIM_KEYS.LANDING_PAGE_UTM_CLASSIFICATION,
  SK22: CLAIM_KEYS.SCHEDULE_DEAD_ZONE,
  SK23: CLAIM_KEYS.KEYWORD_TERMS_NOT_TRIGGERED,
  SK24: CLAIM_KEYS.CAMPAIGN_CTR_BELOW_BENCHMARK,
  SK25: CLAIM_KEYS.AD_GROUP_TOO_MANY_KEYWORDS,
  SK26: CLAIM_KEYS.EXTENSIONS_DISAPPROVED,
  SK27: CLAIM_KEYS.SEARCH_TERM_SMALL_WASTE_ROLLUP,
  SK28: CLAIM_KEYS.SEARCH_TERM_BRAND_IN_PROSPECTING,
  SK29: CLAIM_KEYS.SEARCH_TERM_RESEARCH_INTENT_MISSING,
  SK30: CLAIM_KEYS.LANDING_PAGE_RESEARCH_INTENT_MISMATCH,
  SK31: CLAIM_KEYS.CAMPAIGN_AI_MAX_UNTESTED,
  SK32: CLAIM_KEYS.SETTINGS_SEARCH_PARTNERS_OR_DISPLAY_ON,
  SK33: CLAIM_KEYS.NEGATIVES_BLOCK_OWN_KEYWORD,
  SK34: CLAIM_KEYS.NEGATIVES_NO_SHARED_LIST,
  SK35: CLAIM_KEYS.SEARCH_TERM_TRAFFIC_TYPES,
  SK36: CLAIM_KEYS.LANDING_PAGE_PHRASE_MISMATCH,
  SK37: CLAIM_KEYS.ADS_SEARCH_TEXT_RULES,
  SK38: CLAIM_KEYS.KEYWORD_RIVAL_ON_WRONG_PAGE,
  SK39: CLAIM_KEYS.KEYWORD_RECIPE_EXACT_SHARE_LOW,
  SK40: CLAIM_KEYS.EXTENSIONS_SITELINK_OFF_AUDIENCE,
  SK41: CLAIM_KEYS.SEARCH_COMPETITOR_CAMPAIGN_OPPORTUNITY,
  PX01: CLAIM_KEYS.PMAX_LOW_SHOPPING_SHARE,
  PX02: CLAIM_KEYS.PMAX_BRAND_LEAK,
  PX03: CLAIM_KEYS.PMAX_ASSET_GROUP_INCOMPLETE,
  PX04: CLAIM_KEYS.PMAX_ASSETS_LOW_LABEL,
  PX05: CLAIM_KEYS.PMAX_LISTING_GROUP_LOSERS,
  PX06: CLAIM_KEYS.PMAX_SIGNALS_MISSING,
  PX07: CLAIM_KEYS.PMAX_PLACEMENT_JUNK,
  PX08: CLAIM_KEYS.PMAX_AUTO_ASSETS_ON,
  PX09: CLAIM_KEYS.PMAX_AD_STRENGTH_POOR,
  PX10: CLAIM_KEYS.PMAX_URL_EXPANSION_ON,
  PX11: CLAIM_KEYS.PMAX_PRODUCT_IN_MULTIPLE_ASSET_GROUPS,
  PX12: CLAIM_KEYS.PMAX_CATEGORY_OVERLAPS_SEARCH_CAMPAIGN,
  PX13: CLAIM_KEYS.PMAX_IMAGE_COVERAGE_BELOW_SPEC,
  PX14: CLAIM_KEYS.PMAX_ASSET_GROUP_SPEND_CONCENTRATION,
  PX15: CLAIM_KEYS.PMAX_STRUCTURE_MOSTLY_PAUSED,
  PX16: CLAIM_KEYS.PMAX_PLACEMENT_SMALL_WASTE_ROLLUP,
  PX17: CLAIM_KEYS.PMAX_ASSETS_REFUSED,
  PX18: CLAIM_KEYS.PMAX_SINGLE_BUCKET,
  PX19: CLAIM_KEYS.PMAX_APP_INVENTORY_SHARE,
  PX20: CLAIM_KEYS.PMAX_URL_EXCLUSIONS_MISSING,
  PX21: CLAIM_KEYS.PMAX_NO_NEGATIVES,
  PX22: CLAIM_KEYS.PMAX_SEARCH_TERM_WASTE,
  PX23: CLAIM_KEYS.PMAX_PLACEMENT_CONTENT_JUNK,
  SH01: CLAIM_KEYS.FEED_DISAPPROVAL_RATE,
  SH02: CLAIM_KEYS.FEED_ACCOUNT_ISSUES,
  SH03: CLAIM_KEYS.PRODUCT_SPEND_CONCENTRATION,
  SH04: CLAIM_KEYS.PRODUCT_ZERO_CONV_WASTE,
  SH05: CLAIM_KEYS.PRODUCT_SCALE_CANDIDATE,
  SH06: CLAIM_KEYS.PRODUCT_ATTRIBUTES_MISSING,
  SH08: CLAIM_KEYS.FEED_PROMOTIONS_EXPIRED,
  SH09: CLAIM_KEYS.FEED_POLICIES_MISSING,
  SH10: CLAIM_KEYS.SHOPPING_CAMPAIGN_OVERLAP,
  SH11: CLAIM_KEYS.PRODUCT_AOV_CONTEXT,
  SH12: CLAIM_KEYS.SHOPPING_ITEM_OVERLAP_WITH_PMAX,
  SH13: CLAIM_KEYS.PRODUCT_TITLE_STRUCTURE_WEAK,
  SH14: CLAIM_KEYS.PRODUCT_CUSTOM_LABELS_MISSING,
  SH15: CLAIM_KEYS.FEED_SOURCE_DISAGREEMENT,
  SH17: CLAIM_KEYS.SHOPPING_PRIORITY_AND_FILTER_UNKNOWN,
  SH18: CLAIM_KEYS.PRODUCT_QUADRANT,
  SH19: CLAIM_KEYS.PRODUCT_ZERO_IMPRESSIONS,
  SH20: CLAIM_KEYS.PRODUCT_UNDERPERFORMING_CLONE,
  SH21: CLAIM_KEYS.PRODUCT_COGS_MISSING,
  SH22: CLAIM_KEYS.FEED_NO_ACTIVE_PROMOTION,
  SH23: CLAIM_KEYS.PRODUCT_JUNK_IN_ADS,
  SH24: CLAIM_KEYS.FEED_STORE_QUALITY_UNREADABLE,
  SL01: CLAIM_KEYS.AUDIENCE_SEGMENT_UNDERPERFORMS,
  SL02: CLAIM_KEYS.AUDIENCE_LISTS_UNUSED,
  SL03: CLAIM_KEYS.GEO_COUNTRY_UNDERPERFORMS,
  SL04: CLAIM_KEYS.GEO_PRESENCE_OR_INTEREST,
  SL05: CLAIM_KEYS.DEVICE_CPA_SKEW,
  SL06: CLAIM_KEYS.DEVICE_ZERO_CONV_WASTE,
  SL07: CLAIM_KEYS.DEMOGRAPHIC_SEGMENT_UNDERPERFORMS,
  SL08: CLAIM_KEYS.SCHEDULE_MARGINAL_ONLY,
  SL09: CLAIM_KEYS.DEVICE_MOBILE_RETURN_BELOW_DESKTOP,
  SL10: CLAIM_KEYS.GEO_MULTI_COUNTRY_CAMPAIGN,
  SL11: CLAIM_KEYS.GEO_SPEND_OUTSIDE_MARKETS,
  SL12: CLAIM_KEYS.SETTINGS_LANGUAGE_MISMATCH,
  TR01: CLAIM_KEYS.TREND_PERFORMANCE_DECLINING,
  TR01a: CLAIM_KEYS.TREND_ACCOUNT_PERFORMANCE_DECLINING,
  TR02: CLAIM_KEYS.TREND_LATEST_SETTLED_WEEK,
  TR03: CLAIM_KEYS.CHANGE_DATED_CAUSE,
  TR04: CLAIM_KEYS.TREND_SEASONALITY,
  TR05: CLAIM_KEYS.CAMPAIGN_DORMANT_WINNER,
  TR06: CLAIM_KEYS.CAMPAIGN_ZOMBIE,
  TR07: CLAIM_KEYS.PAID_ORGANIC_BRAND_CANNIBALISATION,
  TR08: CLAIM_KEYS.PERFORMANCE_CARRYING_CAMPAIGN,
  TR09: CLAIM_KEYS.TREND_SALES_FELL_RETURN_HELD,
  TR10: CLAIM_KEYS.RETURN_BELOW_SPEND,
  PR01: CLAIM_KEYS.REACH_FREQUENCY_CAP_MISSING,
  PR02: CLAIM_KEYS.CHANNEL_PRESENCE,
  PR03: CLAIM_KEYS.LSA_PRESENCE,
  PR04: CLAIM_KEYS.LSA_LEAD_VOLUME_DECLINING,
  PR05: CLAIM_KEYS.LSA_LEADS_DISPUTED_HIGH,
  PR06: CLAIM_KEYS.LSA_CALLS_UNANSWERED,
  PR07: CLAIM_KEYS.LSA_VERIFICATION_EXPIRING,
  DG01: CLAIM_KEYS.DGEN_OPTIMIZATION_GOAL_UNSET,
  DG02: CLAIM_KEYS.DGEN_ASSETS_BELOW_MINIMUM,
  DG03: CLAIM_KEYS.DGEN_AUDIENCE_SIGNALS_MISSING,
  DG04: CLAIM_KEYS.DGEN_CHANNEL_CONCENTRATION,
  DG05: CLAIM_KEYS.DGEN_VIDEO_ENGAGEMENT_LOW,
  DG06: CLAIM_KEYS.DGEN_FEED_ATTACHED_NO_SALES,
  DG07: CLAIM_KEYS.DGEN_VIDEO_METRICS_INCONSISTENT,
  DG08: CLAIM_KEYS.DGEN_COLD_AUDIENCE_WRONG,
  DG09: CLAIM_KEYS.DGEN_COLD_KNOWN_PEOPLE_NOT_EXCLUDED,
  DG10: CLAIM_KEYS.DGEN_AD_TEXT_RULES,
  DG11: CLAIM_KEYS.DGEN_AFTER_LAUNCH_GATE,
  DG16: CLAIM_KEYS.DGEN_CHANNEL_LOSING_MONEY,
  DG12: CLAIM_KEYS.DGEN_ECOM_NO_COLD,
  DG13: CLAIM_KEYS.DGEN_IMAGE_ADS_OFF_DISCOVER,
  DG14: CLAIM_KEYS.DGEN_COLD_SETUP_WRONG,
  DG15: CLAIM_KEYS.DGEN_COLD_COPY_PRODUCT_SHEET,
  DG17: CLAIM_KEYS.DGEN_LINES_BEST_WORST,
  DG18: CLAIM_KEYS.DGEN_VIDEO_TOO_MANY,
  DG19: CLAIM_KEYS.DGEN_VIDEO_SHAPE_MISSING,
  DG20: CLAIM_KEYS.DGEN_VIDEO_LENGTH_WRONG,
  DG21: CLAIM_KEYS.DGEN_VIDEO_COLD_LANDING,
  DG22: CLAIM_KEYS.DGEN_VIDEO_AUDIENCES_MIXED,
  DG23: CLAIM_KEYS.DGEN_VIDEO_NUMBERS_LOW,
  DG24: CLAIM_KEYS.DGEN_VIDEO_TIRED,
  VD01: CLAIM_KEYS.VIDEO_VIEW_RATE_LOW,
  VD02: CLAIM_KEYS.VIDEO_QUARTILE_DROPOFF,
  VD03: CLAIM_KEYS.VIDEO_TARGETING_UNBOUNDED,
  VD04: CLAIM_KEYS.VIDEO_VIEWTHROUGH_SHARE_HIGH,
  VD05: CLAIM_KEYS.VIDEO_COMPANION_BANNER_MISSING,
  VD06: CLAIM_KEYS.VIDEO_FORMAT_MIX_UNKNOWN,
  VD07: CLAIM_KEYS.VIDEO_CPV_OUT_OF_BAND,
};

const KNOWN: ReadonlySet<string> = new Set(Object.values(CLAIM_KEYS));

/** trim, lowercase, `/` -> `.`, collapse repeated dots, strip leading/trailing dots. */
export function normalizeClaimKey(s: string | null | undefined): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\//g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

export function isKnownClaimKey(s: string | null | undefined): s is ClaimKey {
  return KNOWN.has(normalizeClaimKey(s));
}

/**
 * The namespace every model-proposed claim lives in — audit v3 Phase 2, D2.
 *
 * A hypothesis is NOT a rulebook check and must never be mistaken for one, in
 * either direction:
 *
 *   - It may not take a key `CLAIM_KEYS` already owns. A hypothesis whose id
 *     matches a rulebook key — separator-insensitively, see
 *     `looksLikeRulebookKey` — is refused by the evaluator. All seven
 *     `mustNotReappear` keys are rulebook keys, so this stops a trap claim being
 *     RESTATED under a model byline. It is a name check and nothing more: what
 *     stops a false finding is that every clause is evaluated in code.
 *   - The replay gate must recognise it. `diffFindings` fails closed on an
 *     unknown claim key — correctly, because a renamed key must never silently
 *     disarm the gate — so without this prefix every model candidate would fail
 *     the gate on sight.
 *
 * A `hypothesis.*` key is therefore recognised, never matches a regression entry, and
 * never satisfies a `missingTrueClaim`.
 */
export const HYPOTHESIS_KEY_PREFIX = "hypothesis.";

export function isHypothesisClaimKey(s: string | null | undefined): boolean {
  const k = normalizeClaimKey(s);
  return k.startsWith(HYPOTHESIS_KEY_PREFIX) && k.length > HYPOTHESIS_KEY_PREFIX.length;
}

/**
 * The namespace a SPECIALIST claim falls back to — audit rebuild Phase 3.
 *
 * A specialist is handed the registered key list for its own area and told to
 * use it. `specialist.*` is the last resort for a real claim the registry has
 * no word for yet, and it exists for exactly one reason: `diffFindings` fails
 * closed on an unknown key, so a novel key would DISARM the regression gate instead
 * of failing it. A prefixed key is recognised, never matches a regression entry and
 * never satisfies a `missingTrueClaim` — the same bargain `hypothesis.*` makes.
 *
 * A run whose specialist claims are mostly `specialist.*` is a registry gap, not
 * a success; a caller should print the count so it cannot go unnoticed.
 */
export const SPECIALIST_KEY_PREFIX = "specialist.";

export function isSpecialistClaimKey(s: string | null | undefined): boolean {
  const k = normalizeClaimKey(s);
  return k.startsWith(SPECIALIST_KEY_PREFIX) && k.length > SPECIALIST_KEY_PREFIX.length;
}

/**
 * Separator-insensitive form, for the hypothesis refusal ONLY.
 *
 * `normalizeClaimKey` is the gate's instrument and stays exactly as it is. But it
 * treats `_`, `-` and a space as ordinary characters, so
 * `tracking_primary_action_broken` does NOT normalise onto
 * `tracking.primary_action_broken` — and "give the hypothesis a short slug in
 * snake_case" is precisely the instruction that produces the underscore form.
 * Probed and confirmed: three of seven near-miss spellings of the
 * f1 trap key walked straight past `isKnownClaimKey`.
 *
 * So the refusal compares on a form where every separator is the same character.
 * This is a name check and only a name check: it stops a hypothesis RESTATING a
 * rulebook claim under a near-miss spelling. What actually stops a false finding
 * is that every clause is evaluated in code against the registry — the name test
 * is the cheap outer layer, not the protection.
 */
function separatorInsensitive(s: string | null | undefined): string {
  return normalizeClaimKey(s)
    .replace(/[\s_-]+/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

const KNOWN_LOOSE: ReadonlySet<string> = new Set(
  Object.values(CLAIM_KEYS).map(separatorInsensitive),
);

/** True when this id is a rulebook claim key, however it was spelled. */
export function looksLikeRulebookKey(s: string | null | undefined): boolean {
  return KNOWN_LOOSE.has(separatorInsensitive(s));
}

/** Claim key for a §B check id, or null for an unknown id. */
export function claimKeyForCheck(checkId: string): ClaimKey | null {
  return CHECK_CLAIM_KEYS[checkId] ?? null;
}
