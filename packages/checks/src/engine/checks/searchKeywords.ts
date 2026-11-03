// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Search checks SK01-SK05: keywords and search terms.
 *
 * Every check is a pure read over the account model + the metric registry.
 * No severity, no dollar figure, no prose: those belong to scoring/ and the
 * writer. See checks/types.ts for the contract and the binding rules.
 *
 * `gateOnData` is called FIRST in every `run` and its verdict is final: tables
 * with rows but no sync marker are checkable and everything built from them is
 * `provisional`; tables with zero rows AND no marker are `not_checkable`, never
 * "none found".
 */
import type { AccountModel } from "../model/nodes/AccountNode.js";
import type { AdGroupNode } from "../model/nodes/AdGroupNode.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import type { KeywordNode } from "../model/nodes/KeywordNode.js";
import type { SearchTermNode } from "../model/nodes/SearchTermNode.js";
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import { reportableCampaigns } from "../registry/entityStatus.js";
import { campaignsOverlap } from "../shared/keywordOverlap.js";
import {
  bool,
  type CheckDefinition,
  type CheckFinding,
  type CheckScope,
  defineCheck,
  finding,
  gateOnData,
  num,
  str,
  wasteFloorReason,
} from "./types.js";

// ---------------------------------------------------------------------------
// local helpers
// ---------------------------------------------------------------------------

interface KeywordRef {
  campaign: CampaignNode;
  adGroup: AdGroupNode;
  keyword: KeywordNode;
}
interface TermRef {
  campaign: CampaignNode;
  adGroup: AdGroupNode | null;
  term: SearchTermNode;
}

/** Non-negative keywords with their ad group and campaign. */
function keywordsOf(model: AccountModel): KeywordRef[] {
  const out: KeywordRef[] = [];
  for (const campaign of reportableCampaigns(model)) {
    for (const adGroup of campaign.children.adGroups) {
      for (const keyword of adGroup.children.keywords) {
        if (keyword.attrs.isNegative) continue;
        out.push({ campaign, adGroup, keyword });
      }
    }
  }
  return out;
}

/** Every search-term row, campaign-grain rows included. */
function termsOf(model: AccountModel): TermRef[] {
  const out: TermRef[] = [];
  for (const campaign of reportableCampaigns(model)) {
    for (const term of campaign.children.searchTerms) out.push({ campaign, adGroup: null, term });
    for (const adGroup of campaign.children.adGroups) {
      for (const term of adGroup.children.searchTerms) out.push({ campaign, adGroup, term });
    }
  }
  return out;
}

/**
 * termsOf without the Performance Max rows (attrs.source 'pmaxSearchTerms').
 * The Search checks judge Search / Shopping / DSA terms; PMax term waste is a
 * separate check, so PMax rows never reach these checks or their bars.
 */
const isPmaxTerm = (term: SearchTermNode): boolean => term.attrs.source === "pmaxSearchTerms";
function searchOnlyTermsOf(model: AccountModel): TermRef[] {
  return termsOf(model).filter(({ term }) => !isPmaxTerm(term));
}

const scopeOf = (
  type: CheckScope["type"],
  id: string | null,
  name: string | null,
  campaign?: CampaignNode | null,
): CheckScope => ({
  type,
  id,
  name,
  campaignId: campaign?.id ?? null,
  campaignName: campaign?.name ?? null,
});

const money = (v: number | null | undefined): number => (v == null ? 0 : v);
/** A sale count read as exactly 0. Unknown (null: conversions not read) is never zero sales. */
const noSales = (v: number | null | undefined): boolean => v === 0;

// ---------------------------------------------------------------------------
// SK01 — keyword.zero_conv_waste
// ---------------------------------------------------------------------------

const SK01 = defineCheck({
  id: "SK01",
  claimKey: CLAIM_KEYS.KEYWORD_ZERO_CONV_WASTE,
  title: "keyword spends past the waste bar without a conversion",
  group: "search",
  metrics: [
    "K.conv",
    "K.spend",
    "K.clicks",
    "K.match_type",
    "T.waste_floor",
    "K.zero_conv_threshold_clicks",
  ],
  confounders: ["MI01", "SK06", "SK02", "SK19"],
  requires: ["keywords", "campaigns"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "No keyword spends past the waste bar without a sale.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const floorV = ctx.get("T.waste_floor");
    const clicksV = ctx.get("K.zero_conv_threshold_clicks");
    const floor = num(floorV);
    const threshold = num(clicksV);
    if (floor == null)
      return {
        state: "not_checkable",
        reason: wasteFloorReason(floorV),
      };
    if (threshold == null)
      return {
        state: "insufficient_data",
        reason: "K.zero_conv_threshold_clicks is not computable",
      };

    const all = keywordsOf(ctx.model);
    const overMoneyFloor = all.filter(
      ({ keyword }) =>
        money(keyword.windows.m90.conv) === 0 && money(keyword.windows.m90.cost) >= floor,
    );
    const findings: CheckFinding[] = [];
    for (const { campaign, adGroup, keyword } of overMoneyFloor) {
      if (money(keyword.windows.m90.clicks) < threshold) continue;
      const args = { keywordId: keyword.id };
      const cite = [
        ctx.get("K.spend", args),
        ctx.get("K.clicks", args),
        ctx.get("K.conv", args),
        ctx.get("K.match_type", args),
        floorV,
        clicksV,
      ];
      findings.push(
        finding({
          claimKey: this.claimKey,
          // one-click phase 1: the ad group rides on the scope so the pause names both ids
          scope: {
            ...scopeOf("keyword", keyword.id, keyword.attrs.text, campaign),
            adGroupId: adGroup.id,
          },
          cite,
          entity: { id: keyword.id, name: keyword.attrs.text },
          facts: {
            spend: keyword.windows.m90.cost,
            clicks: keyword.windows.m90.clicks,
            conversions: keyword.windows.m90.conv,
            waste_floor: floor,
            click_threshold: threshold,
            match_type: keyword.attrs.matchType,
            ad_group: adGroup.name,
          },
          population: all.length,
          note: "match type is the first confounder of any keyword-waste claim and is unresolved until keyword_criterion_id is synced — confidence caps at MODERATE",
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };

    const near = overMoneyFloor
      .map(
        ({ keyword }) =>
          `${keyword.attrs.text} (${money(keyword.windows.m90.clicks)} clicks, ${money(keyword.windows.m90.cost).toFixed(2)} spend)`,
      )
      .join("; ");
    return {
      state: "none_found",
      population: all.length,
      note:
        overMoneyFloor.length > 0
          ? `${overMoneyFloor.length} keyword(s) cleared the ${floor.toFixed(2)} money bar with no conversion but not the ${threshold}-click statistical threshold: ${near}`
          : undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// SK02 — keyword.qs_low_high_spend
// ---------------------------------------------------------------------------

const SK02 = defineCheck({
  id: "SK02",
  claimKey: CLAIM_KEYS.KEYWORD_QS_LOW_HIGH_SPEND,
  title: "low quality score on a keyword carrying meaningful spend",
  group: "search",
  metrics: [
    "K.qs",
    "K.spend",
    "A.spend_monthly",
    "K.qs_component.expected_ctr",
    "K.qs_component.ad_relevance",
    "K.qs_component.landing_page_experience",
  ],
  confounders: ["SK14", "SK19", "BB03"],
  requires: ["keywords", "campaigns"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No low-quality keyword carries meaningful spend.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    // §A.5 has no "account spend over the last 30 days" metric; `A.spend_monthly`
    // is the sheet's one monthly-spend definition (A.spend × 30 / window days).
    const monthlyV = ctx.get("A.spend_monthly");
    const monthly = num(monthlyV);
    if (monthly == null)
      return { state: "not_checkable", reason: "A.spend_monthly is not computable" };

    const withQs = keywordsOf(ctx.model).filter(
      ({ keyword }) => keyword.attrs.qs != null && keyword.attrs.qs > 0,
    );
    if (withQs.length === 0)
      return {
        state: "not_checkable",
        reason: "no keyword reports a quality_score > 0 (precondition of SK02)",
        table: "keywords",
      };

    const { lowQsMax, lowQsSpendShareOfMonthly } = ctx.settings.search;
    const spendGate = lowQsSpendShareOfMonthly * monthly;
    const findings: CheckFinding[] = [];
    for (const { campaign, keyword } of withQs) {
      if ((keyword.attrs.qs ?? 0) > lowQsMax) continue;
      if (money(keyword.windows.m90.cost) <= spendGate) continue;
      const args = { keywordId: keyword.id };
      const components = {
        expected_ctr: ctx.get("K.qs_component.expected_ctr", args),
        ad_relevance: ctx.get("K.qs_component.ad_relevance", args),
        landing_page_experience: ctx.get("K.qs_component.landing_page_experience", args),
      };
      const worst = Object.entries(components)
        .filter(([, v]) => str(v) === "BELOW_AVERAGE")
        .map(([k]) => k);
      const cite = [
        ctx.get("K.qs", args),
        ctx.get("K.spend", args),
        monthlyV,
        ...Object.values(components),
      ];
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("keyword", keyword.id, keyword.attrs.text, campaign),
          cite,
          entity: { id: keyword.id, name: keyword.attrs.text },
          facts: {
            quality_score: keyword.attrs.qs,
            spend: keyword.windows.m90.cost,
            spend_gate: spendGate,
            below_average_components: worst.join(", ") || null,
          },
          population: withQs.length,
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };
    const belowSeven = withQs.filter(({ keyword }) => (keyword.attrs.qs ?? 0) < 7).length;
    return {
      state: "none_found",
      population: withQs.length,
      note: `${withQs.length} keyword(s) report a quality score, ${belowSeven} below 7; none is ≤ ${lowQsMax} above the ${spendGate.toFixed(2)} spend gate`,
    };
  },
});

// ---------------------------------------------------------------------------
// SK03 — keyword.match_type_concentration
// ---------------------------------------------------------------------------

const SK03 = defineCheck({
  id: "SK03",
  claimKey: CLAIM_KEYS.KEYWORD_MATCH_TYPE_CONCENTRATION,
  title: "one match type holds most of a campaign keyword spend",
  group: "search",
  metrics: ["K.spend", "K.match_type"],
  confounders: ["SK05", "SK07"],
  requires: ["keywords", "campaigns"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Match types are mixed.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const byCampaign = new Map<string, KeywordRef[]>();
    for (const ref of keywordsOf(ctx.model)) {
      const list = byCampaign.get(ref.campaign.id) ?? [];
      list.push(ref);
      byCampaign.set(ref.campaign.id, list);
    }
    if (byCampaign.size === 0)
      return {
        state: "not_checkable",
        reason: "no campaign carries a non-negative keyword",
        table: "keywords",
      };

    const findings: CheckFinding[] = [];
    for (const [campaignId, refs] of byCampaign) {
      const campaign = refs[0]?.campaign;
      if (!campaign) continue;
      const spendByType = new Map<string, number>();
      let total = 0;
      for (const { keyword } of refs) {
        const type = keyword.attrs.matchType ?? "UNKNOWN";
        const cost = money(keyword.windows.m90.cost);
        spendByType.set(type, (spendByType.get(type) ?? 0) + cost);
        total += cost;
      }
      if (total <= 0) continue;
      const [type, spend] = [...spendByType].sort((a, b) => b[1] - a[1])[0]!;
      const share = spend / total;
      if (share <= ctx.settings.search.matchTypeConcentrationShare) continue;
      // R5 (run-2 fix): every `K.spend` row is about ONE KEYWORD, so it carries that
      // keyword's label. Labelled with the campaign (as they were) the report showed
      // four different keyword figures as if each were the campaign's own spend.
      const citeLabelled = refs.map(({ keyword }) => ({
        value: ctx.get("K.spend", { keywordId: keyword.id }),
        entity: { id: keyword.id, name: keyword.attrs.text },
      }));
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("campaign", campaignId, campaign.name),
          cite: [],
          citeLabelled,
          facts: {
            match_type: type,
            share_pct: share * 100,
            match_type_spend: spend,
            campaign_keyword_spend: total,
            keyword_count: refs.length,
          },
          population: byCampaign.size,
        }),
      );
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: byCampaign.size,
          note: `no campaign puts more than ${Math.round(ctx.settings.search.matchTypeConcentrationShare * 100)}% of its keyword spend on one match type`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK04 — keyword.duplicate_across_adgroups
// ---------------------------------------------------------------------------

const SK04 = defineCheck({
  id: "SK04",
  claimKey: CLAIM_KEYS.KEYWORD_DUPLICATE_ACROSS_ADGROUPS,
  title: "the same keyword lives in more than one ad group",
  group: "search",
  metrics: ["K.duplicate_key", "K.spend"],
  confounders: ["SK03"],
  requires: ["keywords"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No duplicate keywords across ad groups.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const all = keywordsOf(ctx.model);
    const byKey = new Map<string, KeywordRef[]>();
    for (const ref of all) {
      const list = byKey.get(ref.keyword.attrs.duplicateKey) ?? [];
      list.push(ref);
      byKey.set(ref.keyword.attrs.duplicateKey, list);
    }
    const findings: CheckFinding[] = [];
    let splitByReach = 0;
    for (const [key, refs] of byKey) {
      if (new Set(refs.map((r) => r.adGroup.id)).size < 2) continue;
      for (const { campaign, adGroup, keyword } of refs) {
        // B11: a copy in another ad group duplicates this one only if both can reach the same
        // people (same campaign, or >= 1 shared target country AND language)
        const unread = new Set<string>();
        const dupes = refs.filter((o) => {
          if (o.adGroup.id === adGroup.id) return false;
          const v = campaignsOverlap(ctx.model, campaign, o.campaign);
          if (v.overlap) for (const u of v.unread) unread.add(u);
          return v.overlap;
        });
        if (dupes.length === 0) {
          splitByReach += 1;
          continue;
        }
        const groups = new Set([adGroup.id, ...dupes.map((d) => d.adGroup.id)]);
        const args = { keywordId: keyword.id };
        findings.push(
          finding({
            claimKey: this.claimKey,
            scope: scopeOf("keyword", keyword.id, keyword.attrs.text, campaign),
            cite: [ctx.get("K.duplicate_key", args), ctx.get("K.spend", args)],
            entity: { id: keyword.id, name: keyword.attrs.text },
            facts: {
              duplicate_key: key,
              ad_group: adGroup.name,
              ad_group_count: groups.size,
              spend: keyword.windows.m90.cost,
            },
            population: all.length,
            note:
              unread.size > 0
                ? `${[...unread].join(" and ")} not read, so the campaigns are taken to reach the same people`
                : undefined,
          }),
        );
      }
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: all.length,
          note:
            splitByReach > 0
              ? `${splitByReach} keyword(s) repeat in another ad group only in campaigns that target other countries or languages`
              : `${byKey.size} distinct text+match-type keys across ${all.length} keywords, none in two ad groups`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK05 — search_term.zero_conv_waste
// ---------------------------------------------------------------------------

const SK05 = defineCheck({
  id: "SK05",
  claimKey: CLAIM_KEYS.SEARCH_TERM_ZERO_CONV_WASTE,
  title: "search term spends past the waste bar without a conversion",
  group: "search",
  metrics: [
    "T.conv",
    "T.spend",
    "T.clicks",
    "T.waste_floor",
    "K.zero_conv_threshold_clicks",
    "T.population_complete",
  ],
  confounders: ["MI01", "SK06", "SK07", "SK10", "PX02"],
  requires: ["searchTerms", "campaigns"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "No search term spends past the bar without a sale.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const floorV = ctx.get("T.waste_floor");
    const clicksV = ctx.get("K.zero_conv_threshold_clicks");
    const completeV = ctx.get("T.population_complete");
    const floor = num(floorV);
    const threshold = num(clicksV);
    if (floor == null)
      return {
        state: "not_checkable",
        reason: wasteFloorReason(floorV),
      };
    if (threshold == null)
      return {
        state: "insufficient_data",
        reason: "K.zero_conv_threshold_clicks is not computable",
      };

    const all = searchOnlyTermsOf(ctx.model);
    const distinct = new Set(all.map(({ term }) => term.attrs.term)).size;
    const zeroConv = all.filter(({ term }) => noSales(term.windows.m90.conv));
    const complete = bool(completeV);

    const findings: CheckFinding[] = [];
    for (const { campaign, term } of zeroConv) {
      if (money(term.windows.m90.cost) < floor) continue;
      if (money(term.windows.m90.clicks) < threshold) continue;
      const args = { searchTermId: term.id };
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("search_term", term.id, term.attrs.term, campaign),
          cite: [
            ctx.get("T.spend", args),
            ctx.get("T.clicks", args),
            ctx.get("T.conv", args),
            floorV,
            clicksV,
            completeV,
          ],
          entity: { id: term.id, name: term.attrs.term },
          facts: {
            spend: term.windows.m90.cost,
            clicks: term.windows.m90.clicks,
            conversions: term.windows.m90.conv,
            waste_floor: floor,
            click_threshold: threshold,
          },
          population: all.length,
          note: "the triggering keyword's match type is unresolvable until keyword_criterion_id is synced — confidence caps at MODERATE",
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };

    const zeroCost = zeroConv.reduce((t, { term }) => t + money(term.windows.m90.cost), 0);
    return {
      state: "none_found",
      population: all.length,
      note: `checked all ${all.length} term rows (${distinct} distinct queries${complete === false ? ", capped fetch — a sample" : ""}): ${zeroConv.length} converted nothing on ${zeroCost.toFixed(2)}, none clears the ${floor.toFixed(2)} bar at ${threshold}+ clicks`,
    };
  },
});

export const SEARCH_KEYWORD_CHECKS: CheckDefinition[] = [SK01, SK02, SK03, SK04, SK05];
