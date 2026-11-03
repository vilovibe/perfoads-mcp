// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Check settings: the judgement thresholds a caller may override per run.
 *
 * Every value below is a DEFAULT, not a Google rule. Each one is a reasonable
 * starting bar for a typical account; an account with a different sales cycle,
 * margin or volume should set its own. Money values are at USD scale and are
 * converted to the account currency before use.
 *
 * Pass overrides as `settings` on the engine input; anything left out keeps
 * its default. Units: `...Pct` keys are PERCENT (0-100, so 10 = 10%); share,
 * utilisation and margin keys are FRACTIONS (0-1, so 0.5 = half); `...Usd`
 * keys are money at USD scale; `...Days` keys are whole days; dates are
 * 'YYYY-MM-DD'. A value outside its range, of the wrong type, or a fraction
 * given to a percent key keeps the default and is reported in the run's
 * warnings. Every accepted override that differs from its default is listed
 * in the run's `settingsUsed`, so no override can change what a check reports
 * without saying so.
 */

export interface CheckSettings {
  bidding: {
    /** Conversions in the last 30 days a campaign needs before a target CPA is backed by data. */
    targetCpaMinConv30d: number;
    /**
     * Conversions in the last 30 days a campaign needs before a target ROAS is
     * backed by data. Also the bar for "ready for a target" on a campaign with none,
     * and BB14's bar for advising any switch to value bidding (Google refuses one with
     * too few recent conversions; @perfoads/changes VALUE_BIDDING_MIN_CONV_30D matches it).
     */
    targetRoasMinConv30d: number;
    /** BB01: budget utilisation under this share is "low". */
    lowUtilisation: number;
    /** BB01: campaigns spending less than this in the window (USD scale) are not judged. */
    lowUtilisationMinSpendUsd: number;
    /** BB02: impression share lost to budget above this percent is a finding. */
    lostIsBudgetPct: number;
    /** BB03: impression share lost to rank above this percent is a finding (strictly above). */
    lostIsRankPct: number;
    /** BB05: a target ROAS at least this many times the realised 30-day ROAS is "choking". */
    chokingTargetVsRealised: number;
    /** BB05: ... while the campaign spends under this share of its budget. */
    chokingUtilBelow: number;
    /** BB05: ... on a daily budget of at least this (USD scale). */
    chokingMinDailyBudgetUsd: number;
    /** BB07: a campaign spending at least this share of its budget counts as budget-starved ... */
    scaleUtilMin: number;
    /** BB07: ... when it also loses more than this percent of impression share to budget. */
    scaleLostIsBudgetPct: number;
    /** BB09: a bid adjustment counts as a real push only this far from 1.0. */
    modifierMinStep: number;
    /** BB09: a slice is materially worse / better than its campaign at this multiple (ROAS or CPA). */
    modifierGapMultiple: number;
    /** BB15: the brand CPC bar is the larger of this (USD scale) ... */
    brandCpcFloorUsd: number;
    /** BB15: ... and this share of the account's own non-brand CPC. */
    brandCpcShareOfNonBrand: number;
    /** BB15: clicks a brand campaign needs before its CPC is judged. */
    brandCpcMinClicks: number;
    /** BB15: non-brand clicks behind the reference CPC. */
    nonBrandCpcMinClicks: number;
    /** BB15: monthly spend above the bar under this (USD scale) is stated in the note, never a finding. */
    brandCpcNoteBelowMonthlyUsd: number;
    /** BB16: results beating the target by this multiple make the target "loose". */
    looseTargetMargin: number;
    /** BB16: budget-limited = this percent of impression share lost to budget ... */
    budgetLimitedLostIsPct: number;
    /** BB16: ... or this share of budget used where no impression share is reported. */
    budgetLimitedUtil: number;
    /** BB16: 30-day conversions behind the comparison. */
    looseTargetMinConv30d: number;
    /** BB16: a target or strategy change in the last this many days of the window (its end included) = not judged yet. */
    recentTargetChangeDays: number;
    /**
     * BB16: audit windows ending before this ISO date are not judged. Set it to
     * the day your own observation of "budget-limited campaigns drift toward a
     * loose target" begins to apply; '' judges every window.
     */
    looseTargetFromDate: string;
    /** BB17: days a Smart Bidding campaign is treated as re-learning after a target or strategy change. */
    relearnDays: number;
    /** BB12: an absolute-top impression share under this percent is low. */
    absoluteTopMinPct: number;
    /** BB13: more target moves than this inside the move window is "moved repeatedly" ... */
    targetMovesMax: number;
    /** BB13: ... or one move bigger than this percent. */
    targetMoveMinPct: number;
    /** BB13: the window (days) the moves are counted in. */
    targetMoveWindowDays: number;
  };
  search: {
    /** SK02: a quality score at or under this is "low". */
    lowQsMax: number;
    /** SK02: ... on a keyword spending more than this share of the account's monthly spend. */
    lowQsSpendShareOfMonthly: number;
    /** SK03: one match type holding more than this share of a campaign's keyword spend. */
    matchTypeConcentrationShare: number;
    /** SK07: generic searches taking at least this share of a brand campaign's search-term spend. */
    brandLeakShare: number;
    /** SK09: sales a search needs (summed over the campaigns it ran in) before it is a candidate keyword. */
    convertingTermMinConv: number;
    /** SK10: a dynamic search ads campaign overlapping other campaigns on at least this many searches. */
    dsaOverlapMinTerms: number;
    /** SK12: a responsive search ad with fewer headlines than this is under-filled (Google allows 15). */
    rsaMinHeadlines: number;
    /** SK13: a responsive search ad pinning this many assets or more. */
    maxPinnedAssets: number;
    /** SK20: clicks a landing page needs before its conversion rate is judged. */
    landingPageMinClicks: number;
    /** SK20: a page converting under this share of the account's rate is "materially below". */
    landingPageCvrShare: number;
    /** SK27: a shared word leaks only when at least this many different searches carry it. */
    rollupMinSearches: number;
    /** SK27: the leaking total must reach this many waste bars ... */
    rollupMinFloors: number;
    /** SK27: ... and this share of all search-term spend. */
    rollupMinShareOfTermSpend: number;
    /** SK28: brand searches at or above this share of a non-brand campaign's search-term spend or sales. */
    brandInProspectingMinShare: number;
    /** SK30: research searches holding at least this share of an ad group's search-term spend. */
    researchAdGroupMinShare: number;
    /** SK23: above this share of spending keywords with no search term, the silence is the account's reporting, not the keywords. */
    silentKeywordMaxShare: number;
    /**
     * SK24: a Shopping campaign's click-through rate under this percent is low. R4: a Shopping
     * bar, not a Search one: product ads sit in a grid beside many others and typically draw
     * under 1%, so 2% called a normal 0.66% campaign low.
     */
    shoppingCtrMinPct: number;
    /** SK24: a brand Search campaign's click-through rate under this percent is low. */
    brandSearchCtrMinPct: number;
    /** SK24: impressions a campaign needs before its click-through rate is judged. */
    ctrMinImpressions: number;
    /** SK25: an ad group with more keywords than this carries too many. */
    maxKeywordsPerAdGroup: number;
  };
  structure: {
    /** AS01: brand campaigns taking this percent of spend or more. */
    brandSpendSharePct: number;
    /** AS03: a campaign on a shared budget starves when it loses more than this percent of impression share to budget. */
    siblingLostIsBudgetPct: number;
    /** AS13: changes (interface or API) needed before a per-login share is a pattern. */
    editorsMinChanges: number;
    /** AS13: one login making at least this share of those changes. */
    topEditorShare: number;
    /** AS16: conversions in 30 days a campaign on conversion bidding needs to learn. */
    learnMinConv30d: number;
    /** AS16: a channel is split too thin at this many campaigns under the bar ... */
    thinMinCampaigns: number;
    /** AS16: ... that are also at least this share of that channel's campaigns. */
    thinMinShare: number;
  };
  pmax: {
    /** PX01: a Performance Max campaign spending under this percent on Search and Shopping runs mostly elsewhere. */
    shoppingShareMinPct: number;
    /** PX02: brand search categories above this percent of a Performance Max campaign's category clicks. */
    brandLeakPct: number;
    /** PX03: headlines an asset group needs for a full set (Google allows 15). */
    minHeadlines: number;
    /** PX14: the top asset group holding at least this percent of a campaign's spend is concentrated. */
    topGroupSharePct: number;
    /** PX14 / PX18: campaigns spending less than this in the window (USD scale) are not judged on their shape. */
    shapeMinSpendUsd: number;
    /** PX14: a concentration-only finding is a warning when the busy group carries this percent of the account's spend. */
    topGroupWarnAccountPct: number;
    /** PX14: the live sibling groups must return at least this percent more than the busy group to call the concentration costly. */
    siblingBetterPct: number;
    /** PX19: the app share of the listed placement impressions at or above which the campaign is reported. */
    appListedShare: number;
    /** PX19: ... a warning only when apps also carry this share of the campaign's own impressions. */
    appImpressionShare: number;
    /** PX19: impressions a campaign (and its listed placements) needs before its app share is judged. */
    appMinImpressions: number;
    /** PX13: images (landscape, square, portrait) an asset group needs for a full image set. */
    minImagesPerGroup: number;
    /** PX13: an image under this many pixels on a side is too small. */
    minImagePx: number;
    /** PX15: a campaign with at least this percent of its asset groups switched off is checked for products left out. */
    pausedGroupsPct: number;
    /** PX15: campaigns with fewer asset groups than this are not judged on their switched-off share. */
    shapeMinGroups: number;
    /** PX16: small zero-sale placements on one site add up to a finding from this share of all placement spend ... */
    placementRollupMinShare: number;
    /** PX16: ... and from this many waste bars in total. */
    placementRollupMinFloors: number;
  };
  shopping: {
    /** SH01: products Google Ads cannot show above this percent of the products with a status. */
    disapprovedMaxPct: number;
    /** SH03: the 10 highest-spending products holding more than this percent of product spend is concentrated. */
    topProductsSpendSharePct: number;
    /** SH05: a product returning at least this many times the account's return is reported. */
    scaleRoasMultiple: number;
    /** SH06: products missing GTIN, colour or size above this percent of the products read. */
    missingAttrsMaxPct: number;
    /** SH13: a product title shorter than this many characters wastes the title space. */
    titleShortChars: number;
    /** SH14: products with no custom label above this share of the products read. */
    unlabelledMaxShare: number;
    /** SH20: clicks a product needs before "clicks and no sale" is called. */
    cloneMinClicks: number;
    /** SH21: a campaign's return must be more than this share under break-even before it is called a loss. */
    breakEvenTolerance: number;
  };
  video: {
    /** VD01: a view rate under this fraction is low. */
    viewRateMin: number;
    /** VD01: impressions a Video campaign needs before its view rate is judged. */
    minImpressions: number;
    /** VD02: more than this share of impressions lost between the 25% and the 100% mark is a steep drop. */
    quartileDropoffMax: number;
    /** VD04: view-through conversions above this percent of a Video campaign's conversions. */
    viewThroughSharePct: number;
    /** VD07: the reference band for the average cost per view (USD scale): under the low end ... */
    cpvBandMinUsd: number;
    /** VD07: ... or over the high end is outside the band. */
    cpvBandMaxUsd: number;
  };
  localServices: {
    /** PR04: a drop in leads of this share or more (last 30 days against the 30 before). */
    leadDropShare: number;
    /** PR04: leads the 30 days before need before a drop is judged. */
    leadTrendMinPrior: number;
    /** PR05: leads in the window needed before the disputed share is judged. */
    disputeMinLeads: number;
    /** PR05: disputed (credited or credit pending) leads at this share or more. */
    disputeShare: number;
    /** PR06: phone calls needed before the answer rate is judged. */
    callsMin: number;
    /** PR06: fewer calls than this share with any talk time is a low answer rate. */
    answerRateMin: number;
    /** PR06: an answered call shorter than this many seconds is a short call ... */
    shortCallSeconds: number;
    /** PR06: ... and this share or more of answered calls being short is a finding. */
    shortCallShare: number;
    /** PR07: a licence or insurance check running out within this many days. */
    expiryDays: number;
  };
  demandGen: {
    /** DG02: headlines a Demand Gen campaign needs. */
    minHeadlines: number;
    /** DG02: descriptions a Demand Gen campaign needs. */
    minDescriptions: number;
    /** DG02: images a campaign with no video needs (one creative in square, landscape and portrait). */
    minImagesWithoutVideo: number;
    /** DG04: one surface holding more than this percent of a campaign's spend is concentrated. */
    channelConcentrationPct: number;
  };
  trends: {
    /** TR01 / TR01a: a return drop of this percent or more (30 days against the 30 before) is a decline. */
    declinePct: number;
    /** TR09: a sales value drop of this percent or more (30 days against the 30 before) while the return holds. */
    salesFallPct: number;
    /** TR05: a paused campaign dormant for more than this many days. */
    dormantDays: number;
    /** TR06: clicks a campaign with no conversion needs before it is called a non-converter. */
    zeroConvMinClicks: number;
    /** TR08: the biggest live campaign carries the account from this percent of live spend. */
    carryingMinSharePct: number;
    /** TR08: a standout earner needs at least this much spend in the window (USD scale). */
    standoutMinSpendUsd: number;
  };
  slices: {
    /** SL01 / SL07: an audience or age/gender band costing this many times its scope's cost per sale. */
    segmentCpaMultiple: number;
    /** SL05: a device costing this many times its scope's cost per sale. */
    deviceCpaMultiple: number;
    /** SL05 / SL06: clicks a device slice needs before it is judged. */
    deviceMinClicks: number;
    /** SL09: mobile earning under this share of desktop's return per dollar (or, with no conversion values, desktop's cost per sale under this share of mobile's). */
    mobileCvrShare: number;
    /** SL09: clicks each of mobile and desktop needs before the rates are compared. */
    deviceCvrMinClicks: number;
    /** SL03: a country returning under this share of the account's return underperforms. */
    countryRoasShare: number;
    /** SL03: clicks a country needs before its return is judged. */
    countryMinClicks: number;
    /** SL10: a second country is material at this share of the campaign's spend. */
    multiCountryMinShare: number;
    /** SL12: a feed language counts as the shop's language from this share of its products. */
    languageMinShare: number;
  };
  measurement: {
    /** MI01: a primary action is never called silent at fewer days than this. */
    silenceMinDays: number;
    /** MI01: the longest past gap that can raise an action's own silence bar. */
    silenceMaxGapDays: number;
    /** MI04: value rules changing reported value by at least this share (either way). */
    valueRulesShare: number;
    /** MI06: view-through conversions above this percent of a campaign's conversions. */
    viewThroughSharePct: number;
    /** MI06: on a view-led channel (video, Display, Demand Gen, Performance Max), this percent or more is "inflated"; between the two bars it is a note. */
    viewThroughInflatedPct: number;
    /** MI16: a purchase action needs this many conversions before "zero value" is a pattern. */
    zeroValuePurchaseMinConv: number;
    /** MI18: sales the steady rate must have expected in a zero-sale run before it is called an outage. */
    outageMinExpectedConv: number;
    /** MI18: a run where clicks fall under this share of the days before is a traffic drop, not a tracking break. */
    outageMinTrafficShare: number;
    /** MI18: days before a run that set the steady rate. */
    outageBaselineDays: number;
    /** MI18: fewer baseline days than this = no steady rate to judge against. */
    outageMinBaselineDays: number;
  };
  floors: {
    /** money bar for "wasted" by monthly account spend (USD scale): under $1k / $1k-10k / $10k-50k / over $50k */
    wasteBandUnder1kUsd: number;
    wasteBand1kTo10kUsd: number;
    wasteBand10kTo50kUsd: number;
    wasteBand50kPlusUsd: number;
    /** spend tiers by monthly spend (USD scale): small below A, middle below B, large from B */
    spendTierAMaxMonthlyUsd: number;
    spendTierBMaxMonthlyUsd: number;
    /** a campaign younger than this (days since first spend) is still learning; its verdicts are held back */
    learningMinAgeDays: number;
    /** conversions a "strong" ROAS / CPA verdict needs */
    strongConv: number;
    /** conversions below which a return verdict is insufficient data */
    moderateConv: number;
  };
}

export const DEFAULT_SETTINGS: CheckSettings = {
  bidding: {
    targetCpaMinConv30d: 15,
    targetRoasMinConv30d: 30,
    lowUtilisation: 0.5,
    lowUtilisationMinSpendUsd: 50,
    lostIsBudgetPct: 10,
    lostIsRankPct: 30,
    chokingTargetVsRealised: 2,
    chokingUtilBelow: 0.5,
    chokingMinDailyBudgetUsd: 10,
    scaleUtilMin: 0.95,
    scaleLostIsBudgetPct: 5,
    modifierMinStep: 0.1,
    modifierGapMultiple: 1.5,
    brandCpcFloorUsd: 0.4,
    brandCpcShareOfNonBrand: 0.4,
    brandCpcMinClicks: 30,
    nonBrandCpcMinClicks: 100,
    brandCpcNoteBelowMonthlyUsd: 50,
    looseTargetMargin: 1.2,
    budgetLimitedLostIsPct: 10,
    budgetLimitedUtil: 0.95,
    looseTargetMinConv30d: 15,
    // 28: fits inside the 28 days of change history the snapshot reads (Google keeps 30)
    recentTargetChangeDays: 28,
    looseTargetFromDate: "",
    relearnDays: 14,
    absoluteTopMinPct: 30,
    targetMovesMax: 2,
    targetMoveMinPct: 20,
    targetMoveWindowDays: 28,
  },
  search: {
    lowQsMax: 4,
    lowQsSpendShareOfMonthly: 0.03,
    matchTypeConcentrationShare: 0.8,
    brandLeakShare: 0.2,
    convertingTermMinConv: 2,
    dsaOverlapMinTerms: 5,
    rsaMinHeadlines: 11,
    maxPinnedAssets: 3,
    landingPageMinClicks: 100,
    landingPageCvrShare: 0.5,
    rollupMinSearches: 3,
    rollupMinFloors: 2,
    rollupMinShareOfTermSpend: 0.02,
    brandInProspectingMinShare: 0.05,
    researchAdGroupMinShare: 0.5,
    silentKeywordMaxShare: 0.5,
    shoppingCtrMinPct: 0.5,
    brandSearchCtrMinPct: 5,
    ctrMinImpressions: 1_000,
    maxKeywordsPerAdGroup: 20,
  },
  structure: {
    brandSpendSharePct: 30,
    siblingLostIsBudgetPct: 10,
    editorsMinChanges: 50,
    topEditorShare: 0.8,
    learnMinConv30d: 30,
    thinMinCampaigns: 3,
    thinMinShare: 0.5,
  },
  pmax: {
    shoppingShareMinPct: 50,
    brandLeakPct: 20,
    minHeadlines: 11,
    topGroupSharePct: 80,
    shapeMinSpendUsd: 500,
    topGroupWarnAccountPct: 20,
    siblingBetterPct: 20,
    appListedShare: 0.05,
    appImpressionShare: 0.3,
    appMinImpressions: 1_000,
    minImagesPerGroup: 15,
    minImagePx: 500,
    pausedGroupsPct: 50,
    shapeMinGroups: 3,
    placementRollupMinShare: 0.02,
    placementRollupMinFloors: 2,
  },
  shopping: {
    disapprovedMaxPct: 5,
    topProductsSpendSharePct: 60,
    scaleRoasMultiple: 2,
    missingAttrsMaxPct: 20,
    titleShortChars: 40,
    unlabelledMaxShare: 0.5,
    cloneMinClicks: 50,
    breakEvenTolerance: 0.1,
  },
  video: {
    viewRateMin: 0.15,
    minImpressions: 1_000,
    quartileDropoffMax: 0.6,
    viewThroughSharePct: 30,
    cpvBandMinUsd: 0.01,
    cpvBandMaxUsd: 0.03,
  },
  localServices: {
    leadDropShare: 0.3,
    leadTrendMinPrior: 10,
    disputeMinLeads: 10,
    disputeShare: 0.2,
    callsMin: 10,
    answerRateMin: 0.7,
    shortCallSeconds: 30,
    shortCallShare: 0.4,
    expiryDays: 30,
  },
  demandGen: {
    minHeadlines: 3,
    minDescriptions: 2,
    minImagesWithoutVideo: 3,
    channelConcentrationPct: 80,
  },
  trends: {
    declinePct: 20,
    salesFallPct: 20,
    dormantDays: 30,
    zeroConvMinClicks: 25,
    carryingMinSharePct: 20,
    standoutMinSpendUsd: 500,
  },
  slices: {
    segmentCpaMultiple: 2,
    deviceCpaMultiple: 2,
    deviceMinClicks: 30,
    mobileCvrShare: 0.5,
    deviceCvrMinClicks: 100,
    countryRoasShare: 0.5,
    countryMinClicks: 100,
    multiCountryMinShare: 0.1,
    languageMinShare: 0.05,
  },
  measurement: {
    silenceMinDays: 3,
    silenceMaxGapDays: 14,
    valueRulesShare: 0.05,
    viewThroughSharePct: 10,
    viewThroughInflatedPct: 20,
    zeroValuePurchaseMinConv: 5,
    outageMinExpectedConv: 6,
    outageMinTrafficShare: 0.5,
    outageBaselineDays: 28,
    outageMinBaselineDays: 14,
  },
  floors: {
    wasteBandUnder1kUsd: 20,
    wasteBand1kTo10kUsd: 50,
    wasteBand10kTo50kUsd: 100,
    wasteBand50kPlusUsd: 200,
    spendTierAMaxMonthlyUsd: 3_700,
    spendTierBMaxMonthlyUsd: 12_500,
    learningMinAgeDays: 14,
    strongConv: 10,
    moderateConv: 3,
  },
};

/** Partial overrides, one level deep per group. */
export type CheckSettingsInput = { [G in keyof CheckSettings]?: Partial<CheckSettings[G]> };

type Unit = "percent" | "fraction" | "ratio" | "usd" | "count" | "days" | "date";
interface Rule {
  unit: Unit;
  min?: number;
  max?: number;
  /** exclusive bounds */
  minEx?: boolean;
  maxEx?: boolean;
  integer?: boolean;
  /** a percent bar that is rightly under 1 (a Shopping click-through rate): 0.5 is 0.5%, not a fraction */
  underOnePct?: boolean;
}

/** A percent bar strictly between 0 and 100: a bar of 100 could never be passed. */
const pct: Rule = { unit: "percent", min: 0, minEx: true, max: 100, maxEx: true };
/** A percent bar that is rightly under 1% (Shopping click-through rates sit under 1%). */
const smallPct: Rule = { ...pct, underOnePct: true };
/** A fraction in (0, max]; budget-use fractions stop at 1 (the whole budget). */
const frac = (max = 1): Rule => ({ unit: "fraction", min: 0, minEx: true, max });
const fracOpen: Rule = { unit: "fraction", min: 0, minEx: true, max: 1, maxEx: true };
const usd = (max: number): Rule => ({ unit: "usd", min: 0, max });
const usdPos = (max: number): Rule => ({ unit: "usd", min: 0, minEx: true, max });
const count = (min: number, max: number): Rule => ({ unit: "count", min, max });
const ratio = (max: number): Rule => ({ unit: "ratio", min: 1, minEx: true, max });
const days = (min: number, max: number): Rule => ({ unit: "days", min, max, integer: true });
/** Conversion floors stop at 200: more conversions than that in 30 days is a bar most accounts never reach. */
const CONV_MAX = 200;
/** Waste bands stop at 100,000 a month (USD scale). */
const WASTE_BAND_MAX = 100_000;

/** Allowed range and unit for every key. Every value inside a range leaves the check able to fire. */
export const SETTING_RULES: {
  [G in keyof CheckSettings]: { [K in keyof CheckSettings[G]]: Rule };
} = {
  bidding: {
    targetCpaMinConv30d: count(1, CONV_MAX),
    targetRoasMinConv30d: count(1, CONV_MAX),
    lowUtilisation: frac(),
    lowUtilisationMinSpendUsd: usd(100_000),
    lostIsBudgetPct: pct,
    lostIsRankPct: pct,
    chokingTargetVsRealised: { unit: "ratio", min: 1, max: 20 },
    chokingUtilBelow: frac(),
    chokingMinDailyBudgetUsd: usd(10_000),
    scaleUtilMin: frac(),
    scaleLostIsBudgetPct: pct,
    modifierMinStep: fracOpen,
    modifierGapMultiple: ratio(20),
    brandCpcFloorUsd: usd(100),
    brandCpcShareOfNonBrand: frac(),
    brandCpcMinClicks: count(1, 100_000),
    nonBrandCpcMinClicks: count(1, 100_000),
    brandCpcNoteBelowMonthlyUsd: usd(100_000),
    looseTargetMargin: ratio(10),
    budgetLimitedLostIsPct: pct,
    budgetLimitedUtil: frac(),
    looseTargetMinConv30d: count(1, CONV_MAX),
    recentTargetChangeDays: days(0, 90),
    looseTargetFromDate: { unit: "date" },
    relearnDays: days(1, 60),
    absoluteTopMinPct: pct,
    targetMovesMax: { unit: "count", min: 1, max: 30, integer: true },
    targetMoveMinPct: pct,
    targetMoveWindowDays: days(7, 28),
  },
  search: {
    lowQsMax: { unit: "count", min: 1, max: 10, integer: true },
    lowQsSpendShareOfMonthly: fracOpen,
    matchTypeConcentrationShare: fracOpen,
    brandLeakShare: fracOpen,
    convertingTermMinConv: count(1, 1_000),
    dsaOverlapMinTerms: { unit: "count", min: 1, max: 1_000, integer: true },
    rsaMinHeadlines: { unit: "count", min: 3, max: 15, integer: true },
    maxPinnedAssets: { unit: "count", min: 1, max: 19, integer: true },
    landingPageMinClicks: count(1, 100_000),
    landingPageCvrShare: fracOpen,
    rollupMinSearches: { unit: "count", min: 2, max: 100, integer: true },
    rollupMinFloors: { unit: "ratio", min: 1, max: 100 },
    rollupMinShareOfTermSpend: fracOpen,
    brandInProspectingMinShare: fracOpen,
    researchAdGroupMinShare: fracOpen,
    silentKeywordMaxShare: fracOpen,
    shoppingCtrMinPct: smallPct,
    brandSearchCtrMinPct: pct,
    ctrMinImpressions: count(1, 10_000_000),
    maxKeywordsPerAdGroup: { unit: "count", min: 1, max: 1_000, integer: true },
  },
  structure: {
    brandSpendSharePct: pct,
    siblingLostIsBudgetPct: pct,
    editorsMinChanges: count(1, 100_000),
    topEditorShare: fracOpen,
    learnMinConv30d: count(1, CONV_MAX),
    thinMinCampaigns: { unit: "count", min: 2, max: 100, integer: true },
    thinMinShare: frac(),
  },
  pmax: {
    shoppingShareMinPct: pct,
    brandLeakPct: pct,
    minHeadlines: { unit: "count", min: 3, max: 15, integer: true },
    topGroupSharePct: pct,
    shapeMinSpendUsd: usd(1_000_000),
    topGroupWarnAccountPct: pct,
    siblingBetterPct: pct,
    appListedShare: fracOpen,
    appImpressionShare: fracOpen,
    appMinImpressions: count(1, 10_000_000),
    minImagesPerGroup: { unit: "count", min: 1, max: 20, integer: true },
    minImagePx: { unit: "count", min: 1, max: 5_000, integer: true },
    pausedGroupsPct: pct,
    shapeMinGroups: { unit: "count", min: 2, max: 100, integer: true },
    placementRollupMinShare: fracOpen,
    placementRollupMinFloors: { unit: "ratio", min: 1, max: 100 },
  },
  shopping: {
    disapprovedMaxPct: pct,
    topProductsSpendSharePct: pct,
    scaleRoasMultiple: ratio(20),
    missingAttrsMaxPct: pct,
    titleShortChars: { unit: "count", min: 1, max: 150, integer: true },
    unlabelledMaxShare: fracOpen,
    cloneMinClicks: count(1, 100_000),
    breakEvenTolerance: { unit: "fraction", min: 0, max: 1, maxEx: true },
  },
  video: {
    viewRateMin: fracOpen,
    minImpressions: count(1, 10_000_000),
    quartileDropoffMax: fracOpen,
    viewThroughSharePct: pct,
    cpvBandMinUsd: usd(10),
    cpvBandMaxUsd: usdPos(10),
  },
  localServices: {
    leadDropShare: fracOpen,
    leadTrendMinPrior: count(1, 10_000),
    disputeMinLeads: count(1, 10_000),
    disputeShare: fracOpen,
    callsMin: count(1, 10_000),
    answerRateMin: fracOpen,
    shortCallSeconds: { unit: "count", min: 1, max: 600, integer: true },
    shortCallShare: fracOpen,
    expiryDays: days(1, 365),
  },
  demandGen: {
    minHeadlines: { unit: "count", min: 1, max: 5, integer: true },
    minDescriptions: { unit: "count", min: 1, max: 5, integer: true },
    minImagesWithoutVideo: { unit: "count", min: 1, max: 20, integer: true },
    channelConcentrationPct: pct,
  },
  trends: {
    declinePct: pct,
    salesFallPct: pct,
    dormantDays: days(1, 80),
    zeroConvMinClicks: count(1, 100_000),
    carryingMinSharePct: pct,
    standoutMinSpendUsd: usd(1_000_000),
  },
  slices: {
    segmentCpaMultiple: ratio(20),
    deviceCpaMultiple: ratio(20),
    deviceMinClicks: count(1, 100_000),
    mobileCvrShare: fracOpen,
    deviceCvrMinClicks: count(1, 100_000),
    countryRoasShare: fracOpen,
    countryMinClicks: count(1, 100_000),
    multiCountryMinShare: fracOpen,
    languageMinShare: fracOpen,
  },
  measurement: {
    silenceMinDays: days(1, 60),
    silenceMaxGapDays: days(1, 60),
    valueRulesShare: fracOpen,
    viewThroughSharePct: pct,
    viewThroughInflatedPct: pct,
    zeroValuePurchaseMinConv: count(1, CONV_MAX),
    outageMinExpectedConv: count(1, CONV_MAX),
    outageMinTrafficShare: fracOpen,
    outageBaselineDays: days(7, 60),
    outageMinBaselineDays: days(1, 60),
  },
  floors: {
    wasteBandUnder1kUsd: usdPos(WASTE_BAND_MAX),
    wasteBand1kTo10kUsd: usdPos(WASTE_BAND_MAX),
    wasteBand10kTo50kUsd: usdPos(WASTE_BAND_MAX),
    wasteBand50kPlusUsd: usdPos(WASTE_BAND_MAX),
    spendTierAMaxMonthlyUsd: usdPos(10_000_000),
    spendTierBMaxMonthlyUsd: usdPos(10_000_000),
    learningMinAgeDays: days(0, 60),
    strongConv: count(1, CONV_MAX),
    moderateConv: count(1, CONV_MAX),
  },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Why a value breaks its rule, or null when it is fine. */
function problemOf(rule: Rule, value: unknown): string | null {
  if (rule.unit === "date") {
    if (typeof value !== "string") return "must be a date string 'YYYY-MM-DD' (or '' for none)";
    return value === "" || isIsoDate(value)
      ? null
      : "must be a real date 'YYYY-MM-DD' (or '' for none)";
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return "must be a finite number";
  if (rule.integer && !Number.isInteger(value)) return "must be a whole number";
  if (rule.unit === "percent" && !rule.underOnePct && value > 0 && value < 1)
    return "looks like a fraction; percent keys take 0-100 (10 = 10%)";
  if (rule.min != null && (rule.minEx ? value <= rule.min : value < rule.min))
    return `must be ${rule.minEx ? "above" : "at least"} ${rule.min}`;
  if (rule.max != null && (rule.maxEx ? value >= rule.max : value > rule.max))
    return `must be ${rule.maxEx ? "below" : "at most"} ${rule.max}`;
  return null;
}

/**
 * Defaults with the caller's valid overrides applied, plus a warning for every
 * override that was ignored and why.
 */
export interface SettingUsed {
  key: string;
  default: number | string;
  value: number | string;
}

/** Every accepted override that differs from its default, so a changed bar is always visible. */
export function settingsUsedOf(settings: CheckSettings): SettingUsed[] {
  const out: SettingUsed[] = [];
  for (const group of Object.keys(DEFAULT_SETTINGS) as Array<keyof CheckSettings>) {
    const d = DEFAULT_SETTINGS[group] as unknown as Record<string, number | string>;
    const v = settings[group] as unknown as Record<string, number | string>;
    for (const key of Object.keys(d))
      if (v[key] !== d[key]) out.push({ key: `${group}.${key}`, default: d[key]!, value: v[key]! });
  }
  return out;
}

export function validateSettings(input?: unknown): { settings: CheckSettings; warnings: string[] } {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const warnings: string[] = [];
  if (input == null) return { settings, warnings };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { settings, warnings: ["settings: must be an object of groups; all defaults kept"] };
  }
  for (const [group, over] of Object.entries(input as Record<string, unknown>)) {
    if (!(group in SETTING_RULES)) {
      warnings.push(`settings.${group}: unknown group, ignored`);
      continue;
    }
    if (over == null) continue;
    if (typeof over !== "object" || Array.isArray(over)) {
      warnings.push(`settings.${group}: must be an object, ignored`);
      continue;
    }
    const rules = SETTING_RULES[group as keyof CheckSettings] as Record<string, Rule>;
    const target = settings[group as keyof CheckSettings] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(over as Record<string, unknown>)) {
      const rule = rules[key];
      if (!rule) {
        warnings.push(`settings.${group}.${key}: unknown key, ignored`);
        continue;
      }
      if (value === undefined) continue;
      const problem = problemOf(rule, value);
      if (problem) {
        warnings.push(
          `settings.${group}.${key}: ${problem}; the default ${JSON.stringify(target[key])} is used`,
        );
        continue;
      }
      target[key] = value;
    }
  }
  // cross-key rules: an order that would make a bar unreachable keeps the defaults
  const f = settings.floors;
  if (f.spendTierBMaxMonthlyUsd <= f.spendTierAMaxMonthlyUsd) {
    warnings.push(
      "settings.floors: spendTierBMaxMonthlyUsd must be above spendTierAMaxMonthlyUsd; the default tiers are used",
    );
    f.spendTierAMaxMonthlyUsd = DEFAULT_SETTINGS.floors.spendTierAMaxMonthlyUsd;
    f.spendTierBMaxMonthlyUsd = DEFAULT_SETTINGS.floors.spendTierBMaxMonthlyUsd;
  }
  const bands = [
    f.wasteBandUnder1kUsd,
    f.wasteBand1kTo10kUsd,
    f.wasteBand10kTo50kUsd,
    f.wasteBand50kPlusUsd,
  ];
  if (bands.some((b, k) => k > 0 && b < bands[k - 1]!)) {
    warnings.push(
      "settings.floors: the waste bands must not shrink as spend grows; the default bands are used",
    );
    f.wasteBandUnder1kUsd = DEFAULT_SETTINGS.floors.wasteBandUnder1kUsd;
    f.wasteBand1kTo10kUsd = DEFAULT_SETTINGS.floors.wasteBand1kTo10kUsd;
    f.wasteBand10kTo50kUsd = DEFAULT_SETTINGS.floors.wasteBand10kTo50kUsd;
    f.wasteBand50kPlusUsd = DEFAULT_SETTINGS.floors.wasteBand50kPlusUsd;
  }
  if (f.moderateConv > f.strongConv) {
    warnings.push(
      "settings.floors: moderateConv must not exceed strongConv; the default conversion floors are used",
    );
    f.moderateConv = DEFAULT_SETTINGS.floors.moderateConv;
    f.strongConv = DEFAULT_SETTINGS.floors.strongConv;
  }
  const m = settings.measurement;
  if (m.viewThroughInflatedPct < m.viewThroughSharePct) {
    warnings.push(
      "settings.measurement: viewThroughInflatedPct must not be below viewThroughSharePct; the default view-through bars are used",
    );
    m.viewThroughSharePct = DEFAULT_SETTINGS.measurement.viewThroughSharePct;
    m.viewThroughInflatedPct = DEFAULT_SETTINGS.measurement.viewThroughInflatedPct;
  }
  const v = settings.video;
  if (v.cpvBandMaxUsd <= v.cpvBandMinUsd) {
    warnings.push(
      "settings.video: cpvBandMaxUsd must be above cpvBandMinUsd; the default cost-per-view band is used",
    );
    v.cpvBandMinUsd = DEFAULT_SETTINGS.video.cpvBandMinUsd;
    v.cpvBandMaxUsd = DEFAULT_SETTINGS.video.cpvBandMaxUsd;
  }
  if (m.outageMinBaselineDays > m.outageBaselineDays) {
    warnings.push(
      "settings.measurement: outageMinBaselineDays must not exceed outageBaselineDays; the default outage days are used",
    );
    m.outageBaselineDays = DEFAULT_SETTINGS.measurement.outageBaselineDays;
    m.outageMinBaselineDays = DEFAULT_SETTINGS.measurement.outageMinBaselineDays;
  }
  return { settings, warnings };
}

/** Defaults with the caller's valid overrides applied (warnings dropped; see validateSettings). */
export function resolveSettings(input?: unknown): CheckSettings {
  return validateSettings(input).settings;
}
