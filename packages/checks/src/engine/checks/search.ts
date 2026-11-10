// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Search checks SK06-SK35: search terms, ads, assets, extensions, landing
 * pages, the day-and-hour grid, network settings and negatives.
 *
 * Every check is a pure read over the account model + the metric registry.
 * No severity, no dollar figure, no prose: those belong to scoring/ and the
 * writer. See checks/types.ts for the contract.
 *
 * Rules this file keeps:
 *   - a utm tag on a landing page says nothing about free or organic traffic:
 *     SK21 is informational and says so;
 *   - a promotion's percent off is a PERCENT (100 = free shipping), and the
 *     extension population is the rows that join a campaign of this account;
 *   - `gateOnData` is called first in every `run`: tables with zero rows and no
 *     read status are not checkable, never "none found".
 */
import type { AccountModel } from "../model/nodes/AccountNode.js";
import type { AdGroupNode } from "../model/nodes/AdGroupNode.js";
import type { AdNode } from "../model/nodes/AdNode.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import type { ExtensionNode } from "../model/nodes/ExtensionNode.js";
import type { KeywordNode } from "../model/nodes/KeywordNode.js";
import type { SearchTermNode } from "../model/nodes/SearchTermNode.js";
import type { NegativeEntry } from "../model/nodes/NegativeListNode.js";
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import { EXTENSION_MINIMUMS, SEARCH_EXTENSION_BAR } from "../registry/thresholds.js";
import { overrideClassOf } from "../model/buildSearchTree.js";
import { UTM_CLASS_NAMES, type UtmClass } from "../model/nodes/LandingPageNode.js";
import { brandMatcherOfModel, containsBrandName } from "../model/context.js";
import {
  foldBrandText,
  isBrandShorthand,
  isCompetitorCampaign,
  researchIntentOf,
} from "../shared/campaignClassification.js";
import { isReportable, reportableCampaigns, statusOf } from "../registry/entityStatus.js";

/** moved to shared/campaignClassification.ts (the brand dictionary reads it too); kept exported here. */
export { isBrandShorthand };
import { negativeMatches } from "../model/buildNegatives.js";
import { cmpStr } from "../shared/order.js";
import { DEAD_SLOT_MIN_EXPECTED_CONV, deadHourSlots } from "../model/buildSlices.js";
import type { MetricPayload, MetricValue } from "../registry/types.js";
import {
  bool,
  campaignsOf,
  type CheckCtx,
  type CheckDefinition,
  type CheckFinding,
  type CheckScope,
  defineCheck,
  finding,
  gateOnData,
  isOk,
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
interface AdRef {
  campaign: CampaignNode;
  adGroup: AdGroupNode;
  ad: AdNode;
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
 * termsOf without the PMax rows (attrs.source 'pmaxSearchTerms'). The Search
 * checks (SK05-SK10, SK27-SK29, SK35) judge Search / Shopping / DSA terms and
 * build Search-style fixes; PMax term waste belongs to PX22 (checks/pmax.ts), so
 * PMax rows never reach these checks or their bars. SK34 alone (the list
 * structure, widened to PMax in negatives framework P3) adds a live PMax
 * campaign's own PMax terms, never to a Search campaign's numbers.
 */
const isPmaxTerm = (term: SearchTermNode): boolean => term.attrs.source === "pmaxSearchTerms";
function searchOnlyTermsOf(model: AccountModel): TermRef[] {
  return termsOf(model).filter(({ term }) => !isPmaxTerm(term));
}

function adsOf(model: AccountModel): AdRef[] {
  const out: AdRef[] = [];
  for (const campaign of reportableCampaigns(model)) {
    for (const adGroup of campaign.children.adGroups) {
      for (const ad of adGroup.children.ads) out.push({ campaign, adGroup, ad });
    }
  }
  return out;
}

function adGroupsOf(model: AccountModel): { campaign: CampaignNode; adGroup: AdGroupNode }[] {
  return reportableCampaigns(model).flatMap((campaign) =>
    campaign.children.adGroups.map((adGroup) => ({ campaign, adGroup })),
  );
}

/**
 * Extension rows that join a CAMPAIGN node (§B.4 SK16-SK18 precondition, §D.5
 * `EXISTS (SELECT 1 FROM campaigns ...)`). `attachedExtensions` also
 * carries the 8 ACCOUNT-level rows; all of them are orphans on the golden
 * audit, and the §D population is 294, not 302.
 */
function campaignExtensions(ctx: CheckCtx): ExtensionNode[] {
  return ctx.metrics.index.attachedExtensions.filter(
    (e) => e.attrs.level !== "ACCOUNT" && !e.attrs.orphan,
  );
}

/** Extension rows of a campaign at campaign AND ad-group level (sitelinks are cumulative — never dedupe by level). */
function extensionsOfCampaign(campaign: CampaignNode): ExtensionNode[] {
  return [
    ...campaign.children.extensions,
    ...campaign.children.adGroups.flatMap((g) => g.children.extensions),
  ];
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

/** Contradiction rows the model recorded for a table — surfaced in the note, never hidden (§G.6). */
function contradictionNote(model: AccountModel, table: string): string | null {
  const rows = model.dataQuality.contradictions.filter((c) => c.table === table);
  if (rows.length === 0) return null;
  return `${rows.length} row(s) contradict a documented serving rule (e.g. ${rows[0]!.rule}: ${rows[0]!.observed})`;
}

// ---------------------------------------------------------------------------
// SK06 — negatives.term_already_blocked (confounder feed only)
// ---------------------------------------------------------------------------

const SK06 = defineCheck({
  id: "SK06",
  claimKey: CLAIM_KEYS.NEGATIVES_TERM_ALREADY_BLOCKED,
  title: "a search term a negative keyword already blocks",
  clientLabel: "searches a negative keyword already blocks",
  group: "search",
  metrics: ["T.blocked_level(term)"],
  confounders: [],
  requires: ["searchTerms", "accountNegatives", "sharedNegativeLists"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No served query is already covered by a negative.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const all = searchOnlyTermsOf(ctx.model);
    const findings: CheckFinding[] = [];
    let unknown = 0;
    for (const { campaign, term } of all) {
      const v = ctx.get("T.blocked_level(term)", { searchTermId: term.id });
      // A non-computable blocked-level is the same answer as an explicit 'unknown':
      // we cannot see whether a negative covers this query. It must never fall through
      // to "not blocked", which is how a check ends up reporting a clean account it
      // never verified.
      if (!isOk(v)) {
        unknown += 1;
        continue;
      }
      const level = str(v);
      if (level === "unknown") {
        unknown += 1;
        continue;
      }
      if (level == null || level === "none") continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("search_term", term.id, term.attrs.term, campaign),
          cite: [v, ctx.get("T.spend", { searchTermId: term.id })],
          entity: { id: term.id, name: term.attrs.term },
          facts: {
            blocked_level: level,
            blocked_by: term.attrs.blocked.by.join(", ") || null,
            spend: term.windows.m90.cost,
          },
          population: all.length,
          note: "confounder input only — never emitted as a finding of its own",
        }),
      );
    }
    const campaignsSynced = ctx.model.dataQuality.campaignNegativesSynced.length;
    const note = `${unknown} of ${all.length} term rows have an unknown blocked state because campaign negatives were read for only ${campaignsSynced} of ${campaignsOf(ctx).length} campaigns`;
    if (findings.length === 0 && unknown === all.length) {
      return {
        state: "not_checkable",
        reason: `every one of the ${all.length} served queries resolves to an unknown blocked-level, so "already blocked" cannot be judged: ${note}`,
      };
    }
    return findings.length > 0
      ? { state: "fires", findings: findings.map((f) => ({ ...f, note: `${f.note}; ${note}` })) }
      : { state: "none_found", population: all.length, note };
  },
});

// ---------------------------------------------------------------------------
// SK07 — search_term.brand_leak
// ---------------------------------------------------------------------------

const SK07 = defineCheck({
  id: "SK07",
  claimKey: CLAIM_KEYS.SEARCH_TERM_BRAND_LEAK,
  title: "generic queries take a large share of a brand campaign spend",
  group: "search",
  metrics: ["T.spend", "T.brand_token_match", "T.population_complete"],
  confounders: ["SK05", "PX02"],
  requires: ["searchTerms", "campaigns"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "No generic queries are leaking into the brand campaign.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;
    const { brandLeakShare } = ctx.settings.search;
    // R4-E: the precondition is the whole-name matcher T.brand_token_match reads
    if (!brandMatcherOfModel(ctx.model)) {
      return {
        state: "not_checkable",
        reason:
          "no brand terms were given for this run, so brand and generic searches cannot be told apart",
        table: "profile",
        category: "needs_client_input",
      };
    }

    const brandCampaigns = campaignsOf(ctx).filter((c) => c.attrs.isBrand);
    const withTerms = brandCampaigns.filter((c) => extractTerms(c).length > 0);
    if (withTerms.length === 0) {
      return {
        state: "not_checkable",
        reason: "no brand campaign has a search-term row to classify",
        table: "search_terms",
        category: "not_present",
      };
    }

    const completeV = ctx.get("T.population_complete");
    const findings: CheckFinding[] = [];
    const shares: string[] = [];
    for (const campaign of withTerms) {
      const terms = extractTerms(campaign);
      let total = 0;
      let nonBrand = 0;
      let nonBrandZeroSale = 0;
      // R4-E review: per search text — which generic searches sold (move first) and which did not (negate)
      const generic = new Map<string, { cost: number; conv: number }>();
      const shorthand = new Set<string>();
      const cite: MetricValue[] = [completeV];
      // R4-E: each term's rows carry the term as their entity, so one campaign's many
      // term rows never share a metric key (they used to overwrite each other)
      const labelled: Array<{ value: MetricValue; entity: { id: string; name: string } }> = [];
      for (const term of terms) {
        const args = { searchTermId: term.id };
        const spendV = ctx.get("T.spend", args);
        const matchV = ctx.get("T.brand_token_match", args);
        const cost = money(num(spendV));
        total += cost;
        // the brand written short ("acm wdg tools" for "acme widgets") is the brand: never counted generic, never blocked
        if (
          bool(matchV) === false &&
          isBrandShorthand(term.attrs.term, ctx.model.attrs.brandTokens)
        ) {
          shorthand.add(term.attrs.term);
          continue;
        }
        if (bool(matchV) === false) {
          nonBrand += cost;
          const g = generic.get(term.attrs.term) ?? { cost: 0, conv: 0 };
          g.cost += cost;
          g.conv += money(term.windows.m90.conv);
          generic.set(term.attrs.term, g);
          if (noSales(term.windows.m90.conv)) nonBrandZeroSale += cost;
          const entity = { id: term.id, name: term.attrs.term };
          labelled.push({ value: spendV, entity }, { value: matchV, entity });
        }
      }
      if (total <= 0) continue;
      const share = nonBrand / total;
      shares.push(`${campaign.name} ${(share * 100).toFixed(1)}%`);
      if (share < brandLeakShare) continue;
      const byCost = [...generic.entries()].sort(
        (a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0]),
      );
      const zeroSale = byCost.filter(([, g]) => g.conv === 0);
      const selling = byCost.filter(([, g]) => g.conv > 0);
      // the action carries no figures (phase 5 rule): searches with a digit stay in the table only
      const quote = (list: typeof byCost) => {
        const named = list.filter(([t]) => !/\d/.test(t));
        const shown = named
          .slice(0, SK07_LIST_MAX)
          .map(([t]) => `"${t}"`)
          .join(", ");
        return shown && list.length > Math.min(named.length, SK07_LIST_MAX)
          ? `${shown} and the others marked in the table`
          : shown || (list.length > 0 ? "the searches marked in the table" : "");
      };
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("campaign", campaign.id, campaign.name),
          cite,
          citeLabelled: labelled,
          rows: byCost.slice(0, SK07_ROWS).map(([t, g]) => ({
            entity: { id: null, name: t },
            cells: {
              spend: Number(g.cost.toFixed(2)),
              sales: Number(g.conv.toFixed(2)),
            },
          })),
          entity: { id: campaign.id, name: campaign.name },
          facts: {
            non_brand_spend: nonBrand,
            term_spend: total,
            share_pct: share * 100,
            term_rows: terms.length,
            brand_tokens: ctx.model.attrs.brandTokens.join(", "),
            // R4-E: priced on the generic searches that sold nothing (the rows themselves), never
            // on the whole campaign's spend; a capped term fetch is a sample, never priced
            rollup_wasted_cost_90d: Number(nonBrandZeroSale.toFixed(2)),
            ...(bool(completeV) === true ? {} : { rollup_is_sample: 1 }),
            generic_zero_sale_searches: quote(zeroSale),
            generic_selling_searches: quote(selling),
            ...(shorthand.size > 0
              ? {
                  brand_shorthand_searches: [...shorthand]
                    .sort()
                    .map((t) => `"${t}"`)
                    .join(", "),
                }
              : {}),
          },
          population: withTerms.length,
          note:
            bool(completeV) === false
              ? "search terms are a capped sample — confidence caps at MODERATE"
              : undefined,
        }),
      );
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: withTerms.length,
          note: `non-brand share of term spend per brand campaign: ${shares.join(", ")} — all under ${(brandLeakShare * 100).toFixed(0)}%`,
        };
  },
});

/** SK07: searches named on the card and in the action. */
const SK07_ROWS = 10;
const SK07_LIST_MAX = 8;

function extractTerms(campaign: CampaignNode): SearchTermNode[] {
  return [
    ...campaign.children.searchTerms,
    ...campaign.children.adGroups.flatMap((g) => g.children.searchTerms),
  ].filter((t) => !isPmaxTerm(t));
}

// ---------------------------------------------------------------------------
// SK08 — search_term.wrong_ad_group
// ---------------------------------------------------------------------------

/**
 * B10: a term is always served from the ad group of the keyword that matched it, so
 * "the matched keyword lives elsewhere" can never happen once a keyword is ad group +
 * criterion id. What does happen: the search is word for word a live keyword in ANOTHER
 * ad group of the same campaign, yet a looser keyword in this ad group took it.
 */
const SK08 = defineCheck({
  id: "SK08",
  claimKey: CLAIM_KEYS.SEARCH_TERM_WRONG_AD_GROUP,
  title: "a search is a keyword in another ad group of the campaign, but this ad group served it",
  group: "search",
  metrics: ["T.matched_keyword", "T.ad_group_id"],
  confounders: ["SK03"],
  requires: ["searchTerms", "keywords"],
  impactFormula: "IMP_NONE",
  noneFoundMeans:
    "No search was served from one ad group while it is word for word a keyword in another.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const all = searchOnlyTermsOf(ctx.model).filter(({ adGroup }) => adGroup != null);
    // the OTHER ad group's copy must be live (or unknown-status): a paused copy serves nothing.
    // The serving ad group "has the text" whatever its copy's status: a keyword moved from
    // this ad group (paused here, added there) left old search rows served here.
    const live = (s: string | null) => s == null || s === "ENABLED";
    const byText = new Map<string, KeywordRef[]>();
    const anyStatus = new Set<string>();
    for (const ref of keywordsOf(ctx.model)) {
      if (statusOf(ref.keyword) === "REMOVED") continue;
      const text = ref.keyword.attrs.text.trim().toLowerCase();
      if (!text) continue;
      const key = `${ref.campaign.id}|${text}`;
      anyStatus.add(`${ref.adGroup.id}|${text}`);
      if (!live(statusOf(ref.keyword)) || !live(statusOf(ref.adGroup))) continue;
      (byText.get(key) ?? byText.set(key, []).get(key)!).push(ref);
    }

    const findings: CheckFinding[] = [];
    for (const { campaign, adGroup, term } of all) {
      const text = term.attrs.term.trim().toLowerCase();
      const refs = byText.get(`${campaign.id}|${text}`);
      if (!refs || anyStatus.has(`${adGroup!.id}|${text}`)) continue;
      const owner = [...refs].sort(
        (x, y) =>
          money(y.keyword.windows.m90.cost) - money(x.keyword.windows.m90.cost) ||
          x.adGroup.name.localeCompare(y.adGroup.name),
      )[0]!;
      const args = { searchTermId: term.id };
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("search_term", term.id, term.attrs.term, campaign),
          cite: [
            ctx.get("T.ad_group_id", args),
            ctx.get("T.matched_keyword", args),
            ctx.get("T.spend", args),
          ],
          entity: { id: term.id, name: term.attrs.term },
          facts: {
            served_ad_group_id: adGroup!.id,
            served_ad_group: adGroup!.name,
            keyword_ad_group: owner.adGroup.name,
            keyword: owner.keyword.attrs.text,
            spend: term.windows.m90.cost,
          },
          population: all.length,
        }),
      );
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: all.length,
          note: `${all.length} search(es) checked; none is word for word a keyword in another ad group of its campaign`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK09 — search_term.converting_not_keyword
// ---------------------------------------------------------------------------

/**
 * SK09. R6 (a live shop, 2 Nov): 9 "opportunities" each on 1 sale, "leather mugs" twice (two
 * campaigns), 4 brand searches the Brand campaign already catches. Now: one line per search
 * (rows summed over campaigns and ad groups), at least `convertingTermMinConv` sales, and
 * never a brand search (the brand name, or a search only brand campaigns ran on). Sales
 * are counted from the non-brand campaigns' rows only.
 */
const SK09 = defineCheck({
  id: "SK09",
  claimKey: CLAIM_KEYS.SEARCH_TERM_CONVERTING_NOT_KEYWORD,
  title: "a converting query is not a keyword anywhere in the account",
  group: "search",
  metrics: ["T.conv", "T.value", "T.spend", "K.duplicate_key"],
  confounders: ["SK03"],
  requires: ["searchTerms", "keywords"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Each converting query is already a keyword.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;
    const { convertingTermMinConv: minConv } = ctx.settings.search;

    const keywordTexts = new Set(
      keywordsOf(ctx.model).map(({ keyword }) => keyword.attrs.text.trim().toLowerCase()),
    );
    const brand = brandMatcherOfModel(ctx.model);
    const all = searchOnlyTermsOf(ctx.model);
    // Keywords exist only in Search campaigns: a Shopping search can't be "added as a
    // keyword" there (a Shopping campaign's converting search got a keyword fix Google rejects).
    const converting = all.filter(
      ({ campaign, term }) => campaign.attrs.type === "SEARCH" && money(term.windows.m90.conv) > 0,
    );
    // one entry per search, its rows in every campaign and ad group summed
    const byQuery = new Map<string, TermRef[]>();
    for (const ref of converting) {
      const key = ref.term.attrs.term.trim().toLowerCase();
      (byQuery.get(key) ?? byQuery.set(key, []).get(key)!).push(ref);
    }
    let brandSkipped = 0;
    let thin = 0;
    const findings: CheckFinding[] = [];
    for (const [key, all90] of byQuery) {
      if (keywordTexts.has(key)) continue;
      // a brand search: it names the brand, or only brand campaigns ran on it. One row
      // in a brand campaign does not make a generic search a brand one; its sales there
      // are the brand campaign's, so only the other campaigns' rows are counted.
      const refs = all90.filter(({ campaign }) => !campaign.attrs.isBrand);
      if (containsBrandName(key, brand) || refs.length === 0) {
        brandSkipped++;
        continue;
      }
      const conv = refs.reduce((t, { term }) => t + money(term.windows.m90.conv), 0);
      if (conv < minConv) {
        thin++;
        continue;
      }
      const value = refs.reduce((t, { term }) => t + money(term.windows.m90.value), 0);
      const spend = refs.reduce((t, { term }) => t + money(term.windows.m90.cost), 0);
      const top = [...refs].sort(
        (a, b) =>
          money(b.term.windows.m90.cost) - money(a.term.windows.m90.cost) ||
          cmpStr(a.term.id, b.term.id),
      )[0]!;
      const campaignNames = [...new Set(refs.map(({ campaign }) => campaign.name))];
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("search_term", top.term.id, top.term.attrs.term, top.campaign),
          cite: refs.flatMap(({ term }) => {
            const args = { searchTermId: term.id };
            return [ctx.get("T.conv", args), ctx.get("T.value", args), ctx.get("T.spend", args)];
          }),
          entity: { id: top.term.id, name: top.term.attrs.term },
          facts: {
            conversions: conv,
            conversion_value: value,
            spend,
            campaigns: campaignNames.length,
            campaign_names: campaignNames.join(", "),
            // the keyword's campaign type: the fix adds a keyword in a Search campaign only
            campaign_type: top.campaign.attrs.type,
          },
          population: byQuery.size,
        }),
      );
    }
    const skipped = `${brandSkipped} brand search(es) and ${thin} with under ${minConv} sales left out`;
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: byQuery.size,
          note: `${byQuery.size} converting Search-campaign searches; none outside the keywords qualifies (${skipped})`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK10 — dsa.overlap_with_search
// ---------------------------------------------------------------------------

const SK10 = defineCheck({
  id: "SK10",
  claimKey: CLAIM_KEYS.DSA_OVERLAP_WITH_SEARCH,
  title: "a dynamic search ads campaign buys searches another campaign already covers",
  clientLabel: "dynamic search ads overlapping your other campaigns",
  group: "search",
  metrics: ["T.spend", "T.clicks"],
  confounders: ["SK05"],
  requires: ["dsaSearchTerms"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "No dynamic search ads campaign buys searches other campaigns already cover.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;
    const { dsaOverlapMinTerms } = ctx.settings.search;

    const all = searchOnlyTermsOf(ctx.model);
    const dsa = all.filter(({ term }) => term.attrs.isDsa);
    if (dsa.length === 0) {
      return {
        state: "not_checkable",
        reason:
          "no dynamic search ad search was read: no dynamic search ad traffic on this account",
        table: "dsa_search_terms",
        category: "not_present",
      };
    }
    const ownedElsewhere = new Map<string, Set<string>>();
    for (const { campaign, term } of all) {
      if (term.attrs.isDsa) continue;
      const key = term.attrs.term.trim().toLowerCase();
      const set = ownedElsewhere.get(key) ?? new Set<string>();
      set.add(campaign.id);
      ownedElsewhere.set(key, set);
    }
    const byCampaign = new Map<string, TermRef[]>();
    for (const ref of dsa) {
      // owned by ANOTHER campaign: the DSA campaign's own search-term rows are not an overlap
      const owners = ownedElsewhere.get(ref.term.attrs.term.trim().toLowerCase());
      if (!owners || ![...owners].some((id) => id !== ref.campaign.id)) continue;
      const list = byCampaign.get(ref.campaign.id) ?? [];
      list.push(ref);
      byCampaign.set(ref.campaign.id, list);
    }
    const findings: CheckFinding[] = [];
    for (const [campaignId, refs] of byCampaign) {
      if (refs.length < dsaOverlapMinTerms) continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("campaign", campaignId, refs[0]!.campaign.name),
          cite: refs.map(({ term }) => ctx.get("T.spend", { searchTermId: term.id })),
          entity: { id: campaignId, name: refs[0]!.campaign.name },
          facts: {
            overlapping_terms: refs.length,
            overlap_spend: refs.reduce((t, { term }) => t + money(term.windows.m90.cost), 0),
          },
          population: dsa.length,
        }),
      );
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: dsa.length,
          note: `${dsa.length} DSA term rows, no campaign overlaps another on ${dsaOverlapMinTerms} or more of them`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK11 — ads.rsa_count_out_of_range
// ---------------------------------------------------------------------------

const SK11 = defineCheck({
  id: "SK11",
  claimKey: CLAIM_KEYS.ADS_RSA_COUNT_OUT_OF_RANGE,
  title:
    "a Search ad group runs no responsive search ad or more than three, or a brand ad group runs only one",
  group: "search",
  metrics: ["G.rsa_count", "G.ads_count", "G.spend"],
  confounders: ["SK15"],
  requires: ["ads", "adGroups"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans:
    "Each ad group runs 1-3 responsive search ads, and each brand ad group runs more than one.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    // RSAs only exist on Search campaigns — asking a Shopping or PMax ad group
    // for one is impossible advice (§E.1).
    const groups = adGroupsOf(ctx.model).filter(
      ({ campaign, adGroup }) =>
        campaign.attrs.type === "SEARCH" && money(adGroup.windows.m90.cost) > 0,
    );
    if (groups.length === 0) {
      return {
        state: "not_checkable",
        reason:
          "no Search ad group with spend — RSA counts do not apply to Shopping, PMax, Demand Gen or Video",
        table: "ad_groups",
        category: "not_present",
      };
    }
    const findings: CheckFinding[] = [];
    // A BRAND ad group running ONE responsive search ad is its own case: every brand
    // search shows one untestable ad. R4: a brand campaign with one ad group is not a
    // fault (one name, one group is the normal shape), so it is never judged on that.
    for (const { campaign, adGroup } of groups) {
      const count = adGroup.attrs.rsaCount;
      const brandSingle = campaign.attrs.isBrand && count === 1;
      if (count >= 1 && count <= 3 && !brandSingle) continue;
      const args = { adGroupId: adGroup.id };
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("ad_group", adGroup.id, adGroup.name, campaign),
          cite: [
            ctx.get("G.rsa_count", args),
            ctx.get("G.ads_count", args),
            ctx.get("G.spend", args),
          ],
          entity: { id: adGroup.id, name: adGroup.name },
          facts: {
            rsa_count: count,
            ads_count: adGroup.attrs.adsCount,
            spend: adGroup.windows.m90.cost,
            ...(brandSingle ? { brand_single_ad: true } : {}),
          },
          population: groups.length,
        }),
      );
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: groups.length,
          note: `${groups.length} Search ad group(s) with spend, every one running 1-3 responsive search ads`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK12 — ads.underfilled
// ---------------------------------------------------------------------------

const SK12 = defineCheck({
  id: "SK12",
  claimKey: CLAIM_KEYS.ADS_UNDERFILLED,
  title: "a responsive search ad has few headlines (Google allows 15)",
  group: "search",
  metrics: ["D.headline_count", "D.description_count"],
  confounders: ["SK11", "SK14"],
  requires: ["ads"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "The responsive ads are fully filled.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;
    const RSA_HEADLINE_TARGET = ctx.settings.search.rsaMinHeadlines;

    const rsas = adsOf(ctx.model).filter(({ ad }) =>
      String(ad.attrs.type ?? "").includes("RESPONSIVE_SEARCH"),
    );
    if (rsas.length === 0) {
      return {
        state: "not_checkable",
        reason:
          "no responsive search ad on this account — headline counts do not apply to the other ad types",
        table: "ads",
        category: "not_present",
      };
    }
    const findings: CheckFinding[] = [];
    for (const { campaign, adGroup, ad } of rsas) {
      if (ad.attrs.headlineCount >= RSA_HEADLINE_TARGET) continue;
      const args = { adId: ad.id };
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("ad", ad.id, ad.name, campaign),
          cite: [ctx.get("D.headline_count", args), ctx.get("D.description_count", args)],
          entity: { id: ad.id, name: ad.name },
          facts: {
            headline_count: ad.attrs.headlineCount,
            headline_target: RSA_HEADLINE_TARGET,
            description_count: ad.attrs.descriptionCount,
            ad_group: adGroup.name,
          },
          population: rsas.length,
        }),
      );
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: rsas.length,
          note: `${rsas.length} responsive search ad(s), every one at ${RSA_HEADLINE_TARGET}+ headlines`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK13 — ads.pinning_restrictive
// ---------------------------------------------------------------------------

const SK13 = defineCheck({
  id: "SK13",
  claimKey: CLAIM_KEYS.ADS_PINNING_RESTRICTIVE,
  title: "a responsive search ad pins many of its headlines and descriptions",
  group: "search",
  metrics: ["D.pinned_count", "D.headline_count"],
  confounders: ["SK12"],
  requires: ["ads"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No ad over-pins its assets.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;
    const { maxPinnedAssets } = ctx.settings.search;

    const rsas = adsOf(ctx.model).filter(({ ad }) =>
      String(ad.attrs.type ?? "").includes("RESPONSIVE_SEARCH"),
    );
    const withPinData = rsas.filter(({ ad }) => ad.attrs.pinnedCount != null);
    if (withPinData.length === 0) {
      return {
        state: "not_checkable",
        reason: "the ads were read without their pinning, so pinning cannot be judged",
        table: "ads",
      };
    }
    const findings: CheckFinding[] = [];
    for (const { campaign, ad } of withPinData) {
      if ((ad.attrs.pinnedCount ?? 0) < maxPinnedAssets) continue;
      const args = { adId: ad.id };
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("ad", ad.id, ad.name, campaign),
          cite: [ctx.get("D.pinned_count", args), ctx.get("D.headline_count", args)],
          entity: { id: ad.id, name: ad.name },
          facts: { pinned_count: ad.attrs.pinnedCount, headline_count: ad.attrs.headlineCount },
          population: withPinData.length,
        }),
      );
    }
    const most = Math.max(...withPinData.map(({ ad }) => ad.attrs.pinnedCount ?? 0));
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: withPinData.length,
          note: `pin data present on ${withPinData.length} of ${rsas.length} responsive ads; the most-pinned ad pins ${most}`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK14 — ads.assets_low_label
// ---------------------------------------------------------------------------

const SK14 = defineCheck({
  id: "SK14",
  claimKey: CLAIM_KEYS.ADS_ASSETS_LOW_LABEL,
  title: "Google rates an ad asset LOW",
  group: "search",
  metrics: ["S.asset_label", "G.spend"],
  confounders: ["SK12", "SK15"],
  requires: ["assetPerformance"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No ad asset is rated low.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const withSpend = adsOf(ctx.model).filter(({ adGroup }) => money(adGroup.windows.m90.cost) > 0);
    const assets = withSpend.flatMap(({ campaign, adGroup, ad }) =>
      ad.children.assets.map((asset) => ({ campaign, adGroup, ad, asset })),
    );
    if (assets.length === 0) {
      const pop = ctx.metrics.population.get("assetPerformance");
      return {
        state: "not_checkable",
        reason:
          (pop?.rows ?? 0) === 0
            ? "Google has rated none of the ad lines yet"
            : `${pop?.rows ?? 0} rated ad lines were read, but none belongs to an ad of this account`,
        table: "asset_performance",
      };
    }
    const findings: CheckFinding[] = [];
    const labels = new Map<string, number>();
    for (const { campaign, ad, asset } of assets) {
      const v = ctx.get("S.asset_label", { assetId: asset.id });
      const label = str(v);
      labels.set(label ?? "none", (labels.get(label ?? "none") ?? 0) + 1);
      // NOT_APPLICABLE means Google has issued no verdict — it is never "LOW".
      if (label !== "LOW") continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("asset", asset.id, asset.name, campaign),
          cite: [v, ctx.get("G.spend", { adGroupId: ad.parentId ?? "" })],
          entity: { id: asset.id, name: asset.name },
          facts: { performance_label: label, field_type: asset.attrs.fieldType, ad_id: ad.id },
          population: assets.length,
        }),
      );
    }
    const summary = [...labels].map(([k, n]) => `${k} ${n}`).join(", ");
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: assets.length,
          note: `${assets.length} asset rows join an ad with spend (${summary}); NOT_APPLICABLE is "no verdict yet", never LOW`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK15 — ads.policy_issue
// ---------------------------------------------------------------------------

/**
 * B19: the not-approved ad's own spend over the 90-day audit window, priced per
 * month (/ 3) as money at risk by IMP_STRUCTURAL. Ads carry no daily series, so
 * the 90-day window is the only one there is.
 */
function adSpendAtRisk(ad: AdNode): Record<string, number> {
  const m90 = ad.windows.m90.cost;
  return m90 != null && m90 > 0 ? { at_risk_cost_90d: Number(m90.toFixed(2)) } : {};
}

const SK15 = defineCheck({
  id: "SK15",
  claimKey: CLAIM_KEYS.ADS_POLICY_ISSUE,
  title: "an ad is not fully approved",
  clientLabel: "ads that Google has not fully approved",
  group: "search",
  metrics: ["D.approval_status", "D.policy_topics"],
  confounders: [],
  requires: ["adPolicyData", "ads"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Every live ad is approved.",
  /**
   * Judges ad_policy DIRECTLY (review 2026-09-07). The ads table is
   * spend-gated and a disapproved ad spends nothing, so "each ad is approved"
   * over the ads table could be false. Since 2026-09-07 the policy table holds
   * the spending ads' rows PLUS every ENABLED ad on an ENABLED ad group and
   * campaign (ad_status / campaign_status columns). The population is the
   * live rows with a verdict; a live row without an ads row is scoped to its
   * campaign. Rows from before that date carry no status columns and fall
   * back to the ads join, so the golden snapshot keeps its old answer.
   */
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const all = adsOf(ctx.model);
    const adsById = new Map(all.map((r) => [r.ad.id, r] as const));
    const rows = (ctx.metrics.data as unknown as { adPolicyData?: any[] }).adPolicyData ?? [];
    const up = (v: unknown) => String(v ?? "").toUpperCase();
    const carriesStatus = rows.some((r) => r.ad_status != null || r.campaign_status != null);
    const marker = ctx.metrics.markers.get("adPolicyData");

    if (!carriesStatus) {
      // legacy rows (synced before 2026-09-07): only the ads join says which rows are this audit's
      const withPolicy = all.filter(({ ad }) => ad.attrs.policy != null);
      if (withPolicy.length === 0) {
        const pop = ctx.metrics.population.get("adPolicyData");
        return {
          state: "not_checkable",
          reason: `ad_policy has ${pop?.rows ?? 0} rows and none of them joins one of the ${all.length} ads of this account, so nothing can be said about their approval`,
          table: "ad_policy",
          category: "our_gap",
        };
      }
      const findings: CheckFinding[] = [];
      for (const { campaign, ad } of withPolicy) {
        const v = ctx.get("D.approval_status", { adId: ad.id });
        const status = str(v);
        if (status == null || status === "APPROVED") continue;
        findings.push(
          finding({
            claimKey: this.claimKey,
            scope: scopeOf("ad", ad.id, ad.name, campaign),
            cite: [v, ctx.get("D.policy_topics", { adId: ad.id })],
            entity: { id: ad.id, name: ad.name },
            facts: {
              approval_status: status,
              policy_topics: (ad.attrs.policy?.policyTopics ?? []).length,
              ...adSpendAtRisk(ad),
            },
            population: withPolicy.length,
          }),
        );
      }
      return findings.length > 0
        ? { state: "fires", findings }
        : {
            state: "none_found",
            population: withPolicy.length,
            note: `checked the ${withPolicy.length} ads with spend in the window that carry a policy row: every one is approved`,
          };
    }

    const live = rows.filter(
      (r) =>
        up(r.campaign_status) === "ENABLED" &&
        up(r.ad_status) === "ENABLED" &&
        up(r.ad_group_status ?? "ENABLED") === "ENABLED",
    );
    if (live.length === 0) {
      return {
        state: "not_checkable",
        reason: `ad_policy holds ${rows.length} rows, none for an ENABLED ad on an ENABLED campaign — no live ad to judge`,
        table: "ad_policy",
        category: "not_present",
      };
    }
    const findings: CheckFinding[] = [];
    let population = 0;
    let spending = 0;
    for (const r of live) {
      const status = up(r.approval_status);
      if (status === "" || status === "UNKNOWN" || status === "UNSPECIFIED") continue;
      population += 1;
      const ref = adsById.get(String(r.ad_id ?? ""));
      if (ref) spending += 1;
      if (status === "APPROVED") continue;
      const campaign =
        ref?.campaign ?? ctx.model.index.campaignsById.get(String(r.campaign_id ?? "")) ?? null;
      const topics = Array.isArray(r.policy_topics) ? r.policy_topics.length : 0;
      const label =
        ref?.ad.name ??
        (Array.isArray(r.headlines) && r.headlines[0] ? String(r.headlines[0]) : "ad"); // never the numeric id: it is in entity.id
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: ref
            ? scopeOf("ad", ref.ad.id, ref.ad.name, campaign)
            : campaign
              ? scopeOf("campaign", campaign.id, campaign.name, campaign)
              : { type: "account" as const, id: null, name: null },
          cite: ref
            ? [
                ctx.get("D.approval_status", { adId: ref.ad.id }),
                ctx.get("D.policy_topics", { adId: ref.ad.id }),
              ]
            : [ctx.get("Y.row_count[table]", { table: "ad_policy" })],
          entity: { id: String(r.ad_id ?? ""), name: label },
          facts: {
            approval_status: status,
            policy_topics: topics,
            ad_has_spend_in_window: !!ref,
            ...(ref ? adSpendAtRisk(ref.ad) : {}),
          },
          population,
          note: ref
            ? undefined
            : `${label} (ad ${r.ad_id}) is live (ENABLED on an ENABLED campaign) with no spend in the window — it is in the policy table, not the ads table`,
        }),
      );
    }
    // The sync writes a marker message opening with "coverage partial:" (the
    // live-ads fetch failed; rows cover spending ads only) or "coverage
    // sample:" (the live-ads fetch hit its cap). Either way the live-ad
    // population is incomplete: disapprovals found still fire, but "every live
    // ad is approved" is never said (second review, 2026-09-07).
    const coverageGap = /^coverage (partial|sample):/i.exec(marker?.message ?? "");
    for (const f of findings) {
      f.sample.population = population;
      if (coverageGap) f.sample.truncated = true;
    }
    if (population === 0) {
      return {
        state: "not_checkable",
        reason: `${live.length} live ad(s) carry a policy row but none has a verdict yet (approval_status unknown)`,
        table: "ad_policy",
        category: "our_gap",
      };
    }
    if (findings.length > 0) return { state: "fires", findings };
    if (coverageGap) {
      return {
        state: "not_checkable",
        reason:
          coverageGap[1]!.toLowerCase() === "sample"
            ? `${population} live ads with a verdict were checked and every one is approved, but they are a SAMPLE (${marker!.message}) — "every live ad is approved" cannot be stated`
            : `${population} ads with a verdict were checked and every one is approved, but they are the ads with spend in the window only (${marker!.message}) — a live ad with no spend, which is what a blocked ad looks like, is not in the table`,
        table: "ad_policy",
        category: "our_gap",
      };
    }
    return {
      state: "none_found",
      population,
      note: `checked ${population} live ads (ENABLED on an ENABLED ad group and campaign) with a policy verdict — ${spending} of them with spend in the window, ${live.length - population} without a verdict yet. Every one with a verdict is approved`,
    };
  },
});

// ---------------------------------------------------------------------------
// SK16 — extensions.type_missing
// ---------------------------------------------------------------------------

/**
 * Extension types a campaign of each type can actually serve (§A.6 `S.ext_overridden`
 * + `NEVER_ON_PMAX_SHOPPING` in buildSearchTree.ts). Only Search and Shopping are
 * listed: §B.4 SK16 scopes the check to those two, and telling a PMax campaign to
 * add callouts is impossible advice (§E.1).
 */
const ELIGIBLE_EXTENSION_TYPES: Partial<Record<CampaignNode["attrs"]["type"], string[]>> = {
  SEARCH: ["SITELINK", "CALLOUT", "STRUCTURED_SNIPPET"],
  SHOPPING: ["PROMOTION"],
};

/**
 * B3 / rule 246 (rule 91 says the same): a call extension is expected on
 * lead-gen and local accounts, and on nobody else. `unknown` abstains, the same
 * call businessTypeGate.ts makes everywhere (rule 264): guessing an account is
 * lead-gen would ask an e-commerce store to add a phone number to its ads.
 */
const CALL_EXTENSION_BUSINESS_TYPES = new Set(["lead_gen", "local_lead_gen", "local_retail"]);

/**
 * B3 / rule 246: how many of one type actually SERVE in the thinnest serving
 * context of a campaign, honouring the level rules the model already records.
 *
 * The two classes behave in opposite directions and getting them the wrong way
 * round would be a real bug in a client's report:
 *   - SITELINK is CUMULATIVE. An ad group's own sitelinks are added to the
 *     campaign's, so every context sees at least the campaign-level set.
 *   - CALLOUT, STRUCTURED_SNIPPET, PROMOTION and CALL OVERRIDE. An ad group
 *     that carries its own set hides the campaign's entirely, so six callouts
 *     on the campaign do not save an ad group that carries two of its own.
 *
 * The thinnest context is what the minimum must be tested against: a campaign
 * is short of callouts if ANY ad group serving them is short.
 */
function servingCountOfType(
  campaign: CampaignNode,
  type: string,
  account: readonly ExtensionNode[],
): number {
  const cumulative = overrideClassOf(type) === "CUMULATIVE";
  // account-level assets serve a campaign that has none of that type of its own
  const own = campaign.children.extensions.filter((e) => e.attrs.type === type).length;
  const atCampaign = own > 0 ? own : account.filter((e) => e.attrs.type === type).length;
  const adGroups = campaign.children.adGroups;
  if (adGroups.length === 0) return atCampaign;
  let thinnest = Number.POSITIVE_INFINITY;
  for (const g of adGroups) {
    const own = g.children.extensions.filter((e) => e.attrs.type === type).length;
    const serving = own === 0 ? atCampaign : cumulative ? atCampaign + own : own;
    thinnest = Math.min(thinnest, serving);
  }
  return Number.isFinite(thinnest) ? thinnest : atCampaign;
}

/**
 * M18 (J33): the minimum a campaign of this type is tested against. Search
 * sitelinks and callouts use the Search bar (8 and 10, SEARCH_EXTENSION_BAR);
 * every other type keeps rule 246's minimum.
 */
function minimumFor(campaignType: string, type: string): number | undefined {
  if (campaignType === "SEARCH" && (type === "SITELINK" || type === "CALLOUT"))
    return SEARCH_EXTENSION_BAR[type].min;
  return EXTENSION_MINIMUMS[type];
}

/** M18 (J33): business name, logo and images are not in the snapshot for Search, so SK16 says it did not look at them. */
export const SK16_NOT_CHECKED_NOTE =
  "Business name, logo and image assets are not in our data, so they were not checked.";

const SK16 = defineCheck({
  id: "SK16",
  claimKey: CLAIM_KEYS.EXTENSIONS_TYPE_MISSING,
  title: "a campaign carries no asset of a type it can serve, or too few of it",
  group: "search",
  metrics: ["S.ext_rows(type, level)", "S.sitelink_link_count", "C.spend"],
  confounders: ["SK17"],
  requires: ["adExtensions", "campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans:
    "Each campaign carries the extension types it can serve, in the numbers we ask for (Search: 8 sitelinks and 10 callouts).",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const eligible = campaignsOf(ctx).filter((c) => ELIGIBLE_EXTENSION_TYPES[c.attrs.type] != null);
    if (eligible.length === 0) {
      return {
        state: "not_checkable",
        reason:
          "no Search or Shopping campaign — extension eligibility is only defined for those two types",
        table: "campaigns",
        category: "not_present",
      };
    }
    // B3 / rule 246: CALL joins the expected set on a lead-gen or local account
    // and on no other. Rule 94 keeps it off Shopping, which is why it is added to
    // the SEARCH list only.
    const wantsCall = CALL_EXTENSION_BUSINESS_TYPES.has(ctx.businessType);
    const findings: CheckFinding[] = [];
    for (const campaign of eligible) {
      const present = new Set([
        ...extensionsOfCampaign(campaign).map((e) => e.attrs.type),
        // account-level assets of a type serve every campaign with none of its own
        ...ctx.model.children.extensions.map((e) => e.attrs.type),
      ]);
      const expected = [
        ...(ELIGIBLE_EXTENSION_TYPES[campaign.attrs.type] ?? []),
        ...(wantsCall && campaign.attrs.type === "SEARCH" ? ["CALL"] : []),
      ];
      const missing = expected.filter((t) => !present.has(t));
      // B3 / rule 246: a type that IS present but below its minimum. This is a
      // COVERAGE claim, not a performance one, so it carries no volume floor —
      // "this campaign serves two callouts where Google asks for six" is true on
      // the campaign's first day and on a day it got no impressions at all.
      const short: { type: string; have: number; want: number }[] = [];
      for (const type of expected) {
        if (!present.has(type)) continue;
        const want = minimumFor(campaign.attrs.type, type);
        if (want == null) continue; // PROMOTION carries no minimum in rule 246 or rule 91
        const have = servingCountOfType(campaign, type, ctx.model.children.extensions);
        if (have < want) short.push({ type, have, want });
      }
      if (missing.length === 0 && short.length === 0) continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("campaign", campaign.id, campaign.name),
          cite: [
            ...missing.map((type) => ctx.get("S.ext_rows(type, level)", { type })),
            ctx.get("C.spend", { campaignId: campaign.id }),
          ],
          entity: { id: campaign.id, name: campaign.name },
          // a "2 of 6" claim is about THIS campaign, so it cites this campaign's own
          // count, never the account-wide one (scope-pairing, handover §6.7)
          citeLabelled: short.map((x) => ({
            value: ctx.get("S.ext_rows(type, level)", { type: x.type, campaignId: campaign.id }),
            entity: { id: campaign.id, name: campaign.name },
          })),
          facts: {
            missing_types: missing.join(", ") || null,
            below_minimum: short.map((x) => `${x.type} ${x.have} of ${x.want}`).join(", ") || null,
            present_types: [...present].sort().join(", ") || null,
            // M18 (J33): the fact card's "sitelinks 4 -> 8" (Search only)
            ...(campaign.attrs.type === "SEARCH"
              ? {
                  sitelinks_have: servingCountOfType(
                    campaign,
                    "SITELINK",
                    ctx.model.children.extensions,
                  ),
                  sitelinks_want: SEARCH_EXTENSION_BAR.SITELINK.min,
                  callouts_have: servingCountOfType(
                    campaign,
                    "CALLOUT",
                    ctx.model.children.extensions,
                  ),
                  callouts_want: SEARCH_EXTENSION_BAR.CALLOUT.min,
                }
              : {}),
            campaign_type: campaign.attrs.type,
            spend: campaign.windows.m90.cost,
          },
          population: eligible.length,
        }),
      );
    }
    const joined = campaignExtensions(ctx).length;
    const pop = ctx.metrics.population.get("adExtensions");
    const accountLevel = ctx.model.children.extensions.length;
    const note = `${joined} of ${pop?.rows ?? joined} assets read belong to a campaign of this account${accountLevel > 0 ? `; ${accountLevel} account-level asset(s) count for each campaign with none of that type of its own` : ""}. ${SK16_NOT_CHECKED_NOTE}`;
    return findings.length > 0
      ? { state: "fires", findings: findings.map((f) => ({ ...f, note })) }
      : { state: "none_found", population: eligible.length, note };
  },
});

// ---------------------------------------------------------------------------
// SK17 — extensions.never_served
// ---------------------------------------------------------------------------

const SK17 = defineCheck({
  id: "SK17",
  claimKey: CLAIM_KEYS.EXTENSIONS_NEVER_SERVED,
  title: "a callout text has never served anywhere on the account",
  group: "search",
  metrics: [
    "S.ext_served_effective(text, type)",
    "S.ext_distinct(type)",
    "S.ext_overridden(row)",
    "S.ext_impressions(asset)",
  ],
  confounders: ["SK16"],
  requires: ["adExtensions", "campaigns"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Each callout on this account's campaigns has served at least once.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const callouts = campaignExtensions(ctx).filter(
      (e) => e.attrs.type === "CALLOUT" && e.attrs.text,
    );
    if (callouts.length === 0) {
      const pop = ctx.metrics.population.get("adExtensions");
      return {
        state: "not_checkable",
        reason: `no callout among the ${pop?.rows ?? 0} assets read belongs to a campaign of this account`,
        table: "ad_extensions",
      };
    }
    // "never served" needs each callout's impressions; asset rows read without them say nothing
    if (!callouts.some((e) => e.windows.m90.impressions != null))
      return {
        state: "not_checkable",
        reason:
          "this check needs the impressions of each callout, which this server doesn't read yet",
        table: "adExtensions",
        category: "our_gap",
      };
    const byText = new Map<string, ExtensionNode[]>();
    for (const e of callouts) {
      const list = byText.get(e.attrs.text!) ?? [];
      list.push(e);
      byText.set(e.attrs.text!, list);
    }
    const contradictions = contradictionNote(ctx.model, "adExtensions");
    const findings: CheckFinding[] = [];
    for (const [text, rows] of byText) {
      // `S.ext_served_effective` = Σ impressions over every attached row of this
      // text > 0. A campaign-level row hidden by an ad-group set is `overridden`,
      // not dead: an earlier version called those "never served" and was wrong.
      const servedV = ctx.get("S.ext_served_effective(text, type)", { text, type: "CALLOUT" });
      if (bool(servedV) !== false) continue;
      const overridden = rows.filter((e) => e.attrs.servedStatus === "overridden").length;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf(
            "extension",
            rows[0]!.id,
            text,
            ctx.metrics.index.campaignsById.get(rows[0]!.attrs.campaignId ?? "") ?? null,
          ),
          cite: [
            servedV,
            ctx.get("S.ext_distinct(type)", { type: "CALLOUT" }),
            ...rows.map((e) => ctx.get("S.ext_impressions(asset)", { extensionId: e.id })),
          ],
          entity: { id: rows[0]!.id, name: text },
          // `S.ext_distinct(type)` counts the CALLOUT type across the account; it is
          // not a fact about this one text, and labelling it with the text made the
          // true "26 distinct callouts" unreadable as a callout fact.
          entityByMetric: { "S.ext_distinct(type)": { id: "CALLOUT", name: "callout" } },
          facts: {
            text,
            rows: rows.length,
            overridden_rows: overridden,
            levels: [...new Set(rows.map((e) => e.attrs.level))].join(", "),
            distinct_callouts: byText.size,
          },
          population: byText.size,
          note: contradictions ?? undefined,
        }),
      );
    }
    const base = `${byText.size} distinct callout texts across ${callouts.length} rows that belong to a campaign of this account${contradictions ? `; ${contradictions}` : ""}`;
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: byText.size,
          note: `${base} — every one has served at least once`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK18 — promotion.value_or_date_invalid
// ---------------------------------------------------------------------------

const SK18 = defineCheck({
  id: "SK18",
  claimKey: CLAIM_KEYS.PROMOTION_VALUE_OR_DATE_INVALID,
  title: "a promotion asset carries an impossible discount or a past end date",
  group: "search",
  metrics: ["S.promo_percent_off", "S.promo_end_date"],
  confounders: ["SK17"],
  requires: ["adExtensions", "campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "The promotion assets carry valid values and dates.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const promos = campaignExtensions(ctx).filter((e) => e.attrs.type === "PROMOTION");
    if (promos.length === 0) {
      const pop = ctx.metrics.population.get("adExtensions");
      return {
        state: "not_checkable",
        reason: `no promotion among the ${pop?.rows ?? 0} assets read belongs to a campaign of this account`,
        table: "ad_extensions",
      };
    }
    const withEndDate = promos.filter((e) => e.attrs.promoEndDate != null);
    const findings: CheckFinding[] = [];
    const distribution = new Map<string, number>();
    for (const e of promos) {
      const campaign = ctx.metrics.index.campaignsById.get(e.attrs.campaignId ?? "") ?? null;
      const pctV = ctx.get("S.promo_percent_off", { extensionId: e.id });
      const endV = ctx.get("S.promo_end_date", { extensionId: e.id });
      // S.promo_percent_off IS the percent (100 = free shipping; an earlier version printed a fraction with a % sign).
      // A live run before this scale was pinned read stored 10 as 1,000% (19 false findings, 2026-09-05).
      const pct = num(pctV);
      if (pct != null) distribution.set(`${pct}%`, (distribution.get(`${pct}%`) ?? 0) + 1);
      const badValue = pct != null && (pct <= 0 || pct > 100);
      const end = str(endV);
      const expired = end != null && end < ctx.metrics.runDate;
      if (!badValue && !expired) continue;
      // one-click gaps phase 1: the asset id (node id = `LEVEL:assetId:campaign:adGroup`,
      // buildSearchTree) and the link level, so an expired CAMPAIGN-level promotion can
      // be unlinked by one click. A bad value is `reason` = bad_value: no button.
      const assetId = /^[A-Z_]+:(\d+):/.exec(e.id)?.[1] ?? null;
      findings.push({
        ...finding({
          claimKey: this.claimKey,
          scope: scopeOf("extension", e.id, e.attrs.text ?? e.name, campaign),
          cite: [pctV, endV].filter(isOk),
          entity: { id: e.id, name: e.attrs.text ?? e.name },
          facts: {
            percent_off: pct,
            end_date: end,
            run_date: ctx.metrics.runDate,
            reason: badValue ? "percent_off outside (0,100]" : "end date in the past",
          },
          rows: [
            {
              entity: { id: assetId, name: e.attrs.text ?? e.name },
              cells: {
                reason: badValue ? "bad_value" : "expired",
                link_level:
                  e.attrs.level === "CAMPAIGN"
                    ? "campaign"
                    : e.attrs.level === "AD_GROUP"
                      ? "ad group"
                      : "account",
                end_date: end ?? "",
              },
            },
          ],
          population: promos.length,
        }),
        // R8: Google stops showing an ended promotion, so a past end date is a setting left
        // behind with no money on it: a note, never a warning (an impossible value stays one)
        ...(badValue ? {} : { maxSeverity: "info" as const }),
      });
    }
    const summary = [...distribution]
      .sort()
      .map(([k, n]) => `${k} ×${n}`)
      .join(", ");
    const dateLeg =
      withEndDate.length === 0
        ? "the expiry leg is not_checkable: none of the promotion rows carries an endDate"
        : `${withEndDate.length} of ${promos.length} rows carry an endDate`;
    return findings.length > 0
      ? { state: "fires", findings: findings.map((f) => ({ ...f, note: dateLeg })) }
      : {
          state: "none_found",
          population: promos.length,
          note: `${promos.length} promotion rows belong to a campaign of this account (${summary}); percentOff is a percent, so a stored 100 is free shipping and 10 is 10% off. ${dateLeg}`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK19 — landing_page.url_health
// ---------------------------------------------------------------------------

const SK19 = defineCheck({
  id: "SK19",
  claimKey: CLAIM_KEYS.LANDING_PAGE_URL_HEALTH,
  title: "a landing page does not resolve over https, or returns an error status",
  group: "search",
  metrics: ["L.scheme", "L.spend"],
  confounders: ["SK02", "SK20"],
  requires: ["landingPageViews"],
  // Round 5: no page is fetched, so no error is ever found: an http link is a note, never
  // priced (the shop usually forwards http to https)
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Each landing page resolves over https.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const pages = ctx.model.children.landingPages;
    if (pages.length === 0) {
      return {
        state: "not_checkable",
        reason: "no landing page was read for this account; empty is not clean",
        table: "landing_page_views",
      };
    }
    // Status leg: url_health is keyed by customer_id + url_hash, has no
    // audit_id, and is not loaded into the model at all. It never reaches a finding.
    const statusLeg = "the pages' HTTP status is not checked (no page is fetched)";
    const findings: CheckFinding[] = [];
    for (const page of pages) {
      const schemeV = ctx.get("L.scheme", { landingPageId: page.id });
      if (str(schemeV) !== "http") continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("landing_page", page.id, page.attrs.url),
          cite: [schemeV, ctx.get("L.spend", { landingPageId: page.id })],
          entity: { id: page.id, name: page.attrs.url },
          facts: { scheme: "http", spend: page.windows.m90.cost, ad_ids: page.attrs.adIds.length },
          population: pages.length,
          note: statusLeg,
        }),
      );
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: pages.length,
          note: `all ${pages.length} landing pages resolve over https; ${statusLeg}`,
        };
  },
});

// ---------------------------------------------------------------------------
// SK20 — landing_page.low_conversion_rate
// ---------------------------------------------------------------------------

/**
 * Phase F: does any LIVE ad (ad, ad group and campaign all switched on) send traffic
 * to the page? `unknown` when no ad of the page is in the model (Shopping and
 * Performance Max pages carry no ad id): those keep their finding. `knownClicks` =
 * the 90-day clicks of the page's ads the model knows, so a page whose clicks also
 * come from traffic with no ad id (mixed) is not held back on its paused ads alone.
 */
function pageTraffic(
  ctx: CheckCtx,
  adIds: readonly string[],
): { state: "live" | "none_live" | "unknown"; knownClicks: number } {
  const idx = ctx.metrics.index;
  let known = 0;
  let knownClicks = 0;
  for (const id of adIds) {
    const ad = idx.adsById.get(id);
    if (!ad) continue;
    known += 1;
    knownClicks += ad.windows.m90.clicks ?? 0;
    const group = ad.parentId ? idx.adGroupsById.get(ad.parentId) : undefined;
    const campaign = group?.parentId ? idx.campaignsById.get(group.parentId) : undefined;
    if (!group || !campaign) return { state: "unknown", knownClicks };
    if (isReportable(ad) && isReportable(group) && isReportable(campaign))
      return { state: "live", knownClicks };
  }
  return { state: known === 0 ? "unknown" : "none_live", knownClicks };
}

/** SK20 (R17): the label of a page judged on return per $1, and of one judged on sale count. */
export const SK20_TITLE_VALUE = "a landing page returns materially less per $1 than the account";
export const SK20_TITLE_COUNT = "a landing page converts materially below the account";

/** SK20: the share of a page's clicks its paused ads must carry before the page is held back. */
export const SK20_PAUSED_COVER_SHARE = 0.95;

/**
 * N1: the campaigns that fed a page (clicks per campaign, read for every type). Shopping and
 * Performance Max pages carry no ad id, so a page only a paused PMax campaign fed (NL:
 * .de/collections/mugs, all 1,062 clicks from the paused DE PMax v2) is known here.
 * null = the split was not read or holds no clicks.
 */
function pageCampaigns(
  ctx: CheckCtx,
  split: Record<string, number> | null,
): { notLiveShare: number; notLive: string[] } | null {
  if (split == null) return null;
  let total = 0;
  let notLiveClicks = 0;
  const notLive: string[] = [];
  for (const [id, clicks] of Object.entries(split)) {
    total += clicks;
    const c = ctx.metrics.index.campaignsById.get(id);
    // a campaign the model does not hold is unknown, never "not running"
    if (c && !isReportable(c)) {
      notLiveClicks += clicks;
      if (clicks > 0) notLive.push(c.name);
    }
  }
  return total > 0 ? { notLiveShare: notLiveClicks / total, notLive } : null;
}

/**
 * SK20. R5: when the account tracks sales value, a page is judged on its return per $1
 * against the account's, never on its sale count: the jacket page made $1,217 on
 * $599 ($2.03 per $1) from 5 sales and was called waste because a jacket costs 2-3 mugs.
 * Sale count (conversion rate) is the test only when no value is tracked.
 */
const SK20 = defineCheck({
  id: "SK20",
  claimKey: CLAIM_KEYS.LANDING_PAGE_LOW_CONVERSION_RATE,
  title: "a landing page performs materially below the account",
  group: "search",
  metrics: ["L.cvr", "L.spend", "L.conv", "L.value", "A.cvr", "A.spend", "A.conv_value"],
  confounders: ["MI01", "SK02", "SK19"],
  requires: ["landingPageViews", "campaigns"],
  impactFormula: "IMP_CPA_GAP",
  noneFoundMeans:
    "No landing page converts, or returns per $1 when sales value is tracked, materially below the account.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;
    const { landingPageMinClicks: LP_MIN_CLICKS, landingPageCvrShare } = ctx.settings.search;

    const accountSpendV = ctx.get("A.spend");
    const accountValueV = ctx.get("A.conv_value");
    const accountSpend = num(accountSpendV);
    const accountValue = num(accountValueV);
    const accountReturn =
      accountSpend != null && accountSpend > 0 && accountValue != null && accountValue > 0
        ? accountValue / accountSpend
        : null;
    const accountCvrV = ctx.get("A.cvr");
    const accountCvr = num(accountCvrV);
    if (accountReturn == null && (accountCvr == null || accountCvr <= 0)) {
      return {
        state: "insufficient_data",
        reason:
          "neither the account's return (A.conv_value / A.spend) nor A.cvr is computable — no account benchmark to compare a page against",
      };
    }
    const eligible = ctx.model.children.landingPages.filter(
      (p) => money(p.windows.m90.clicks) >= LP_MIN_CLICKS,
    );
    if (eligible.length === 0) {
      return {
        state: "insufficient_data",
        reason: `no landing page reaches the ${LP_MIN_CLICKS}-click floor`,
      };
    }
    const findings: CheckFinding[] = [];
    // pages whose traffic came from campaigns, ad groups or ads not running now
    const notRunning: string[] = [];
    for (const page of eligible) {
      const cvrV = ctx.get("L.cvr", { landingPageId: page.id });
      const cvr = num(cvrV);
      const spend = money(page.windows.m90.cost);
      const value = money(page.windows.m90.value);
      const pageReturn = spend > 0 ? value / spend : null;
      if (accountReturn != null) {
        if (pageReturn == null || pageReturn >= landingPageCvrShare * accountReturn) continue;
      } else if (cvr == null || cvr >= landingPageCvrShare * (accountCvr ?? 0)) continue;
      const traffic = pageTraffic(ctx, page.attrs.adIds);
      const fed = pageCampaigns(ctx, page.attrs.campaignClicks);
      const pageClicks = page.windows.m90.clicks ?? 0;
      // held back only when paused traffic carries ~all of the page's clicks: its ads (Search),
      // or its campaigns (Shopping / Performance Max pages have no ad id); mixed traffic keeps it
      const pausedAds =
        traffic.state === "none_live" &&
        pageClicks > 0 &&
        traffic.knownClicks >= SK20_PAUSED_COVER_SHARE * pageClicks;
      const pausedCampaigns = fed != null && fed.notLiveShare >= SK20_PAUSED_COVER_SHARE;
      if (pausedAds || pausedCampaigns) {
        const from =
          pausedCampaigns && !pausedAds && fed.notLive.length > 0
            ? ` from ${fed.notLive.join(", ")}`
            : "";
        notRunning.push(
          `${page.attrs.url} (spend ${spend.toFixed(2)}, ${money(page.windows.m90.conv).toFixed(0)} sales${accountReturn != null ? ` worth ${value.toFixed(2)}` : ""}, ${pageClicks} clicks while it was live${from})`,
        );
        continue;
      }
      findings.push({
        ...finding({
          claimKey: this.claimKey,
          scope: scopeOf("landing_page", page.id, page.attrs.url),
          cite: [
            ...(accountReturn != null
              ? [ctx.get("L.value", { landingPageId: page.id }), accountValueV, accountSpendV]
              : [cvrV, accountCvrV]),
            ctx.get("L.spend", { landingPageId: page.id }),
            ctx.get("L.conv", { landingPageId: page.id }),
          ],
          entity: { id: page.id, name: page.attrs.url },
          facts:
            accountReturn != null
              ? {
                  judged_on: "sales value",
                  return_per_dollar: pageReturn,
                  account_return_per_dollar: accountReturn,
                  threshold: landingPageCvrShare * accountReturn,
                  clicks: page.windows.m90.clicks,
                  conversions: page.windows.m90.conv,
                  sales_value: value,
                  spend,
                  cvr,
                  account_cvr: accountCvr,
                }
              : {
                  judged_on: "sale count",
                  cvr: cvr,
                  account_cvr: accountCvr,
                  threshold: landingPageCvrShare * (accountCvr ?? 0),
                  clicks: page.windows.m90.clicks,
                  conversions: page.windows.m90.conv,
                  spend: page.windows.m90.cost,
                },
          population: eligible.length,
        }),
        // R17: judged on value, the page returns less per $1; its conversion rate may be in line
        title: accountReturn != null ? SK20_TITLE_VALUE : SK20_TITLE_COUNT,
      });
    }
    const heldBack =
      notRunning.length > 0
        ? `${notRunning.length} page(s) held back: every ad or campaign that sends traffic there is not running (${notRunning.join(", ")})`
        : null;
    if (findings.length > 0)
      return { state: "fires", findings, ...(heldBack ? { withheld: [heldBack] } : {}) };
    // held back is not clean: `fires` with nothing kept claims nothing (see applyActivityGate)
    if (heldBack) return { state: "fires", findings: [], withheld: [heldBack] };
    return {
      state: "none_found",
      population: eligible.length,
      note:
        accountReturn != null
          ? `${eligible.length} pages clear the ${LP_MIN_CLICKS}-click floor; none returns below ${(landingPageCvrShare * 100).toFixed(0)}% of the account's return per $1`
          : `${eligible.length} pages clear the ${LP_MIN_CLICKS}-click floor; none converts below ${(landingPageCvrShare * 100).toFixed(0)}% of the account rate`,
    };
  },
});

// ---------------------------------------------------------------------------
// SK21 — landing_page.utm_classification
// ---------------------------------------------------------------------------

/** How each `L.utm_class` value must be described. `product_sync` is the Shopify Google channel. */
const UTM_CLASS_MEANING: Record<string, string> = {
  product_sync:
    "Shopify Google-channel tag (utm_medium=product_sync) — a shop-side channel label, not a traffic source, and no bearing on Google Ads tracking (GCLID)",
  gclid_only: "no utm parameters — Google Ads is tracked by GCLID, which is the normal setup",
  tagged: "carries utm parameters other than the Shopify Google-channel tag",
};

const SK21 = defineCheck({
  id: "SK21",
  claimKey: CLAIM_KEYS.LANDING_PAGE_UTM_CLASSIFICATION,
  title: "how landing-page spend splits by tracking tags",
  noteOnly: "how the landing-page spend splits by tracking tags",
  group: "search",
  metrics: ["A.utm_class_page_count(class)", "L.utm_class_spend(class)"],
  confounders: [],
  requires: ["landingPageViews"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No landing page spend to split by tracking tags.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const pages = ctx.model.children.landingPages;
    if (pages.length === 0) {
      return {
        state: "not_checkable",
        reason: "no landing page was read for this account; empty is not clean",
        table: "landing_page_views",
      };
    }
    // a page reached through links tagged differently counts in each class, with the
    // spend of its own links of that class only
    const byClass = new Map<string, { pages: typeof pages; spend: number }>();
    for (const page of pages) {
      for (const [raw, spend] of Object.entries(page.attrs.utmSpend) as [UtmClass, number][]) {
        const cls = UTM_CLASS_NAMES[raw] ?? "unknown";
        const bucket = byClass.get(cls) ?? { pages: [], spend: 0 };
        bucket.pages.push(page);
        bucket.spend += money(spend);
        byClass.set(cls, bucket);
      }
    }
    const total = [...byClass.values()].reduce((t, b) => t + b.spend, 0);
    const findings: CheckFinding[] = [];
    for (const [cls, bucket] of byClass) {
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("landing_page", null, `${cls} landing pages`),
          // the class's own page count first — 45 L.spend rows are not the number
          // "45 pages carry this tag" (fix E), and the class is what the count is about
          cite: [ctx.get("A.utm_class_page_count(class)", { key: cls })],
          entity: { id: cls, name: cls },
          citeLabelled: bucket.pages.map((p) => ({
            value: ctx.get("L.utm_class_spend(class)", { landingPageId: p.id, key: cls }),
            entity: { id: p.id, name: p.attrs.url ?? p.name },
          })),
          facts: {
            utm_class: cls,
            pages: bucket.pages.length,
            total_pages: pages.length,
            spend: bucket.spend,
            spend_share_pct: total > 0 ? (bucket.spend / total) * 100 : null,
            meaning: UTM_CLASS_MEANING[cls] ?? "unclassified",
          },
          population: pages.length,
          note: "for information only: none of these tags says anything about organic or free traffic",
        }),
      );
    }
    return { state: "fires", findings };
  },
});

// ---------------------------------------------------------------------------
// SK22 — schedule.dead_zone
// ---------------------------------------------------------------------------

/**
 * SK22 — a day-and-hour slot that spends past the waste bar without a sale. R7: of 168
 * slots over 13 weeks a few always land on no sale by luck (one shop: Saturday 2-3 am, 86
 * clicks, $147.73, while 1 am and 3 am both sell), so a slot counts only when its clicks
 * should have brought 3+ sales at the grid's own rate and the hours on either side sell
 * under half that rate too (`deadHourSlots`). The rest are named in the note, not findings.
 */

const SK22 = defineCheck({
  id: "SK22",
  claimKey: CLAIM_KEYS.SCHEDULE_DEAD_ZONE,
  title: "a day-and-hour slot spends past the waste bar without a conversion",
  group: "search",
  metrics: ["SL.dow_hour(scope, day, hour)", "T.waste_floor"],
  confounders: ["SL05", "MI01"],
  requires: ["temporal_grid"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans:
    "No day-and-hour slot spends past the waste bar without a conversion where that is more than chance.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    const cells = ctx.model.children.slices.dowHour;
    if (cells.length === 0) {
      return {
        state: "not_checkable",
        reason: "no day-and-hour performance was read for this account",
        table: "temporal_grid",
      };
    }
    const floorV = ctx.get("T.waste_floor");
    const floor = num(floorV);
    if (floor == null)
      return {
        state: "not_checkable",
        reason: wasteFloorReason(floorV),
      };

    // R7: a slot with no sale is a finding only when that is not chance (enough clicks to
    // expect sales at the grid's own rate) and the hours beside it agree
    const { dead, heldBack, rate } = deadHourSlots(cells, floor);
    const heldBackNote =
      heldBack.length > 0
        ? `${heldBack.length} slot(s) spend past ${floor.toFixed(2)} without a sale but are not counted: too few clicks to tell from chance (under ${DEAD_SLOT_MIN_EXPECTED_CONV} sales expected at the grid's rate${rate != null ? ` of ${(rate * 100).toFixed(2)}% of clicks` : ""}) or an hour beside it sells: ${heldBack
            .slice(0, 5)
            .map((c) => c.name)
            .join(", ")}${heldBack.length > 5 ? ` and ${heldBack.length - 5} more` : ""}`
        : null;
    const findings: CheckFinding[] = [];
    for (const { cell, expectedConv } of dead) {
      const campaign = cell.attrs.campaignId
        ? (ctx.metrics.index.campaignsById.get(cell.attrs.campaignId) ?? null)
        : null;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("hour", cell.attrs.key, cell.name, campaign),
          cite: [
            ctx.get("SL.dow_hour(scope, day, hour)", {
              key: cell.attrs.key,
              scope: cell.attrs.scope === "campaign" ? "campaign" : "account",
              campaignId: cell.attrs.campaignId ?? undefined,
            }),
            floorV,
          ],
          entity: { id: cell.attrs.key, name: cell.name },
          // the cell's own 90-day cost under the id IMP_WASTE_90 reads for an
          // hour slice (Round 2 Y1) — a dead cell's spend is the waste
          facts: {
            cell: cell.attrs.key,
            spend: cell.windows.m90.cost,
            clicks: cell.windows.m90.clicks,
            conversions: cell.windows.m90.conv,
            expected_conversions: Number(expectedConv.toFixed(1)),
            waste_floor: floor,
            "SL.dow_hour().cost": money(cell.windows.m90.cost),
          },
          population: cells.length,
          note: "the hours on either side sell under half the grid's rate too",
        }),
      );
    }
    if (findings.length > 0) {
      if (heldBackNote) for (const f of findings) f.note = `${f.note}; ${heldBackNote}`;
      return { state: "fires", findings };
    }
    return {
      state: "none_found",
      population: cells.length,
      note:
        heldBackNote ??
        `${cells.length} day-and-hour cells, none spends past ${floor.toFixed(2)} without converting`,
    };
  },
});

// ---------------------------------------------------------------------------
// SK26 — extensions.disapproved
// ---------------------------------------------------------------------------

/**
 * Rule 245: a disapproved
 * extension on a campaign with paid traffic is CRITICAL. It is money already
 * being spent on ads that are serving without the asset the account paid
 * someone to write, and it is invisible in the interface unless you go looking.
 *
 * WHAT THIS CHECK CAN DO TODAY: say that we could not check it.
 * `AuditDataSyncService.storeAdExtensions` selects `campaign_asset.status`,
 * which is the LINK state — ENABLED, PAUSED, REMOVED. Google's approval verdict
 * lives on `policy_summary.approval_status` of the same resource and is not
 * selected, so no audit synced to date carries it. Reading the link status as
 * an approval would be the worst possible version of this: every account would
 * be told its extensions are fine.
 *
 * So the check is written in full and returns `not_checkable` with the reason,
 * which reaches the client through `brief/buildNotChecked.ts` instead of
 * quietly scoring the pillar clean. Adding the field to the sync query is a
 * live-API change; the day it lands,
 * this check starts firing with nothing else to change.
 *
 * The traffic condition is rule 245's own ("a campaign with paid traffic") and
 * is a PRECONDITION on the campaign, not a volume floor on the claim: a
 * disapproved sitelink is disapproved at any impression count, and B3's floors
 * do not touch it.
 */
const DISAPPROVED = new Set(["DISAPPROVED", "AREA_OF_INTEREST_ONLY"]);

const SK26 = defineCheck({
  id: "SK26",
  claimKey: CLAIM_KEYS.EXTENSIONS_DISAPPROVED,
  title: "an extension is disapproved on a campaign that is spending",
  clientLabel: "extensions Google has disapproved on a spending campaign",
  notCheckableCategory: "our_gap",
  group: "search",
  metrics: ["S.ext_approval_status", "C.spend"],
  // nothing confounds this: an asset Google refused is refused whatever else the
  // campaign is doing, and SK16's "no sitelinks" cannot explain a disapproval
  confounders: [],
  requires: ["adExtensions", "campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Every extension on a spending campaign is approved.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;

    // account-level assets serve every campaign with none of that type of its own (as in SK16)
    const accountLevel = ctx.model.children.extensions;
    const attached = [...campaignExtensions(ctx), ...accountLevel];
    if (attached.length === 0) {
      const pop = ctx.metrics.population.get("adExtensions");
      return {
        state: "not_checkable",
        reason: `none of the ${pop?.rows ?? 0} assets read belongs to this account's campaigns or the account`,
        table: "ad_extensions",
      };
    }
    const withStatus = attached.filter((e) => e.attrs.approvalStatus != null);
    if (withStatus.length === 0) {
      return {
        state: "not_checkable",
        reason: `none of the ${attached.length} attached extension rows carries a policy approval status — only the link status (enabled, paused, removed) was read, which does not say whether Google approved the asset`,
        table: "ad_extensions",
      };
    }
    const findings: CheckFinding[] = [];
    for (const e of withStatus) {
      const v = ctx.get("S.ext_approval_status", { extensionId: e.id });
      const status = (str(v) ?? e.attrs.approvalStatus ?? "").toUpperCase();
      if (!DISAPPROVED.has(status)) continue;
      if (e.attrs.level === "ACCOUNT") {
        // the spending campaigns it serves: those with no asset of its type of their own
        const served = campaignsOf(ctx).filter(
          (c) =>
            money(c.windows.m90.cost) > 0 &&
            !extensionsOfCampaign(c).some((x) => x.attrs.type === e.attrs.type),
        );
        if (served.length === 0) continue;
        findings.push(
          finding({
            claimKey: this.claimKey,
            scope: scopeOf("extension", e.id, e.attrs.text ?? e.name),
            cite: [v, ...served.map((c) => ctx.get("C.spend", { campaignId: c.id }))],
            entity: { id: e.id, name: e.attrs.text ?? e.name },
            facts: {
              approval_status: status,
              extension_type: e.attrs.type,
              level: "ACCOUNT",
              campaigns_served: served.length,
              spend: served.reduce((t, c) => t + money(c.windows.m90.cost), 0),
            },
            population: withStatus.length,
          }),
        );
        continue;
      }
      const campaign = ctx.metrics.index.campaignsById.get(e.attrs.campaignId ?? "") ?? null;
      // rule 245's own precondition: paid traffic on the campaign carrying it
      if (!campaign || money(campaign.windows.m90.cost) <= 0) continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("extension", e.id, e.attrs.text ?? e.name, campaign),
          cite: [v, ctx.get("C.spend", { campaignId: campaign.id })],
          entity: { id: e.id, name: e.attrs.text ?? e.name },
          facts: {
            approval_status: status,
            extension_type: e.attrs.type,
            level: e.attrs.level,
            spend: campaign.windows.m90.cost,
          },
          population: withStatus.length,
        }),
      );
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: withStatus.length,
          note: `${withStatus.length} attached extension rows carry an approval status; every one on a spending campaign is approved`,
        };
  },
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SK27 — search_term.small_waste_rollup
// ---------------------------------------------------------------------------

/** SK27: words too common to be a negative on their own (English, Dutch, German, Polish fillers). */
const ROLLUP_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "near",
  "you",
  "your",
  "are",
  "how",
  "what",
  "who",
  "where",
  "when",
  "why",
  "can",
  "does",
  "this",
  "that",
  "into",
  "about",
  "online",
  "shop",
  "store",
  "sale",
  "buy",
  "een",
  "het",
  "van",
  "voor",
  "met",
  "kopen",
  "der",
  "die",
  "das",
  "und",
  "mit",
  "fur",
  "für",
  "kaufen",
  "dla",
  "jak",
  "czy",
  "oraz",
  "albo",
  "sklep",
  "kupic",
  "kupić",
  "cena",
  "gdzie",
  "jaki",
  "jaka",
  "jakie",
  "ile",
  "nie",
  "się",
  "sie",
  "jeden",
  "jedna",
  "jedno",
  "dwa",
  "trzy",
  "dzien",
  "dni",
  "bez",
  "przy",
  "oder",
  "eine",
  "einen",
  "more",
  "most",
  "best",
  "free",
  "www",
  "com",
  "http",
  "https",
]);
/** SK27: shorter words are fillers ("all", "pol", "and") far more often than products. */
const ROLLUP_MIN_WORD_LETTERS = 4;
/** SK27: rows shown on the card. */
const ROLLUP_ROWS = 5;

/** SK27: words are compared on this many leading letters, so "widget" and "widgets" are one word. */
const ROLLUP_STEM_LETTERS = 5;

/** accent-folded words (the brand matcher's folding: "café" = "cafe"), fillers and bare numbers out. */
function rollupWordsOf(text: string): string[] {
  return [
    ...new Set(
      foldBrandText(text)
        .split(" ")
        .filter(
          (w) =>
            w.length >= ROLLUP_MIN_WORD_LETTERS && !ROLLUP_STOP_WORDS.has(w) && !/^\d+$/.test(w),
        ),
    ),
  ];
}

/** the stem a word is compared on: Polish, Dutch and German inflect the ending, never the start. */
function rollupStemOf(word: string): string {
  return word.slice(0, ROLLUP_STEM_LETTERS);
}

/**
 * SK27 — many small zero-conversion searches that share a word add up.
 *
 * SK05 reports a search only when it ALONE clears the waste bar (spend and
 * clicks). A long tail of searches under that bar is invisible to it, however
 * much it costs together. This check takes exactly the rows SK05 did NOT report
 * (so nothing is counted twice), drops brand searches, brand campaigns and
 * searches a negative already blocks, and groups the rest by the words they
 * share. A word "leaks" when 3+ different searches carry it, none of them sold,
 * no converting search anywhere in the account uses the word, and together they
 * cost at least the waste bar. Each search counts once in the total, under its
 * costliest leaking word. The words are the action: one negative per word.
 */
const SK27 = defineCheck({
  id: "SK27",
  claimKey: CLAIM_KEYS.SEARCH_TERM_SMALL_WASTE_ROLLUP,
  title: "many small searches sharing a word add up to real spend without a sale",
  clientLabel: "small searches that add up to real spend without a sale",
  group: "search",
  metrics: [
    "T.spend",
    "T.conv",
    "T.waste_floor",
    "K.zero_conv_threshold_clicks",
    "T.population_complete",
  ],
  confounders: ["MI01"],
  requires: ["searchTerms", "campaigns"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "Small searches without a sale do not add up to real spend on any shared word.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;
    const {
      rollupMinSearches: ROLLUP_MIN_SEARCHES,
      rollupMinFloors: ROLLUP_MIN_FLOORS,
      rollupMinShareOfTermSpend: ROLLUP_MIN_SHARE_OF_TERM_SPEND,
    } = ctx.settings.search;

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
    if (!Number.isFinite(floor))
      return {
        state: "insufficient_data",
        reason: "currency unknown — the money floor is skipped (T.waste_floor = ∞)",
      };
    if (threshold == null)
      return {
        state: "insufficient_data",
        reason: "K.zero_conv_threshold_clicks is not computable",
      };

    const all = searchOnlyTermsOf(ctx.model);
    if (all.length === 0)
      return { state: "insufficient_data", reason: "no search term row joins a live campaign" };
    const tokens = ctx.model.attrs.brandTokens;
    const termSpend = all.reduce((t, { term }) => t + money(term.windows.m90.cost), 0);
    // a word that shares a stem with a search that SOLD, a keyword the account bids on or the brand is a
    // product word, never a negative ("widget" on a shop that sells on "widgets")
    // whole words of 3+ letters, and a prefix either way ("boot" sold protects "boots",
    // "booted"; "trainers" sold protects "trainer") on top of the shared 5-letter stem
    const protectedWords = [
      ...new Set(
        [
          ...all
            .filter(({ term }) => money(term.windows.m90.conv) > 0)
            .map(({ term }) => term.attrs.term),
          ...keywordsOf(ctx.model).map(({ keyword }) => keyword.attrs.text),
          ...tokens,
        ].flatMap((t) =>
          foldBrandText(t)
            .split(" ")
            .filter((w) => w.length >= 3 && !ROLLUP_STOP_WORDS.has(w) && !/^\d+$/.test(w)),
        ),
      ),
    ];
    const protectedStems = new Set(protectedWords.map(rollupStemOf));
    const isProtected = (w: string): boolean =>
      protectedStems.has(rollupStemOf(w)) ||
      protectedWords.some((p) => w.startsWith(p) || p.startsWith(w));
    const isBlocked = (t: SearchTermNode): boolean =>
      t.attrs.blocked.campaign === "blocked" ||
      t.attrs.blocked.sharedList === "blocked" ||
      t.attrs.blocked.account === "blocked";
    // exactly the rows SK05 leaves out: zero conversions, some spend, under its spend OR click bar
    const tail = all.filter(({ campaign, term }) => {
      const cost = money(term.windows.m90.cost);
      if (cost <= 0 || !noSales(term.windows.m90.conv)) return false;
      if (cost >= floor && money(term.windows.m90.clicks) >= threshold) return false;
      if (campaign.attrs.isBrand || isBlocked(term)) return false;
      // whole-name brand searches only ("acme trail boots" stays in the tail;
      // the lone word "acme" is still a protected word above, so it never becomes a negative)
      return !containsBrandName(term.attrs.term, brandMatcherOfModel(ctx.model));
    });

    const byWord = new Map<string, TermRef[]>();
    for (const ref of tail) {
      for (const w of rollupWordsOf(ref.term.attrs.term)) {
        if (isProtected(w)) continue;
        (byWord.get(w) ?? byWord.set(w, []).get(w)!).push(ref);
      }
    }
    const costOf = (refs: readonly TermRef[]): number =>
      refs.reduce((t, r) => t + money(r.term.windows.m90.cost), 0);
    const leaking = [...byWord.entries()]
      .filter(
        ([, refs]) =>
          new Set(refs.map((r) => r.term.attrs.term)).size >= ROLLUP_MIN_SEARCHES &&
          costOf(refs) >= floor,
      )
      .sort((a, b) => costOf(b[1]) - costOf(a[1]) || a[0].localeCompare(b[0]));
    // each search row once, under its costliest leaking word
    const claimed = new Set<string>();
    const buckets: Array<{ word: string; refs: TermRef[] }> = [];
    for (const [word, refs] of leaking) {
      const own = refs.filter((r) => !claimed.has(r.term.id));
      // what is left after costlier words took their rows must still leak on its own
      if (
        new Set(own.map((r) => r.term.attrs.term)).size < ROLLUP_MIN_SEARCHES ||
        costOf(own) < floor
      )
        continue;
      for (const r of own) claimed.add(r.term.id);
      buckets.push({ word, refs: own });
    }
    const total = buckets.reduce((t, b) => t + costOf(b.refs), 0);
    const tailCost = costOf(tail);
    const complete = bool(completeV);
    const summary = `${tail.length} search rows under the one-by-one bar converted nothing on ${tailCost.toFixed(2)}; ${buckets.length} shared word(s) leak ${total.toFixed(2)}`;
    if (
      buckets.length === 0 ||
      total < floor * ROLLUP_MIN_FLOORS ||
      total < termSpend * ROLLUP_MIN_SHARE_OF_TERM_SPEND
    ) {
      return {
        state: "none_found",
        population: all.length,
        note: `${summary} — under the bar for a finding (${(floor * ROLLUP_MIN_FLOORS).toFixed(2)} and ${(ROLLUP_MIN_SHARE_OF_TERM_SPEND * 100).toFixed(0)}% of the ${termSpend.toFixed(2)} search-term spend)${complete === false ? "; capped fetch — a sample" : ""}`,
      };
    }

    const rows = buckets.slice(0, ROLLUP_ROWS).map(({ word, refs }) => {
      const searches = [...new Set(refs.map((r) => r.term.attrs.term))];
      const examples = [...refs]
        .sort((a, b) => money(b.term.windows.m90.cost) - money(a.term.windows.m90.cost))
        .map((r) => r.term.attrs.term)
        .filter((t, i, a) => a.indexOf(t) === i)
        .slice(0, 2);
      const campaigns = [
        ...new Set(refs.map((r) => r.campaign.name).filter((n): n is string => !!n)),
      ].sort();
      // the word as the top example spells it ("café", not the accent-folded
      // "cafe"), so the negative matches what people type
      const spelled =
        (examples[0] ?? "").split(/\s+/).find((w) => foldBrandText(w) === word) ?? word;
      return {
        entity: { id: null, name: `"${spelled}"` },
        cells: {
          searches: searches.length,
          clicks: refs.reduce((t, r) => t + money(r.term.windows.m90.clicks), 0),
          spend: Number(costOf(refs).toFixed(2)),
          campaigns: campaigns.join(", "),
          examples: examples.join("; "),
        },
      };
    });
    return {
      state: "fires",
      findings: [
        {
          ...finding({
            claimKey: this.claimKey,
            scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
            cite: [floorV, clicksV, completeV],
            facts: {
              // always sent, so the account scope never prices A.spend; a capped fetch is a sample, never a total
              rollup_wasted_cost_90d: Number(total.toFixed(2)),
              ...(complete === true ? {} : { rollup_is_sample: 1 }),
              leaking_words: buckets.length,
              leaking_search_rows: claimed.size,
              small_zero_sale_spend_90d: Number(tailCost.toFixed(2)),
              search_term_spend_90d: Number(termSpend.toFixed(2)),
              waste_floor: floor,
            },
            population: all.length,
            rows,
            note: summary,
          }),
          ...(complete === true
            ? {}
            : {
                openItems: [
                  "We read only part of your search terms (the list was too long to read in full), so the real total is likely higher.",
                ],
              }),
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// SK28 / SK30
// ---------------------------------------------------------------------------

/** SK28 / SK30: example rows shown on the card. */
const R38_ROWS = 5;

/** A campaign type whose search terms SK28 reads: Search (ad-group rows) and Standard Shopping (campaign-grain rows). */
const PROSPECTING_TERM_TYPES = new Set(["SEARCH", "SHOPPING"]);

/**
 * SK28: is there a brand negative on this campaign — its own negatives, the
 * shared lists attached to it or the account list? null = its own negatives
 * were never synced and no list names the brand, so the answer is unknown.
 */
function brandNegativeOn(
  ctx: CheckCtx,
  campaign: CampaignNode,
  isBrand: (t: string) => boolean,
): boolean | null {
  const idx = ctx.model.negativeIndex;
  const own = campaign.children.negatives == null ? null : (idx.byCampaign.get(campaign.id) ?? []);
  // a list whose attachment we could not read is not proof that THIS campaign carries it
  const lists = campaign.children.inheritedNegatives
    .filter((l) => !l.attrs.attachmentUnknown)
    .flatMap((l) => (l.attrs.listId ? (idx.byList.get(l.attrs.listId) ?? []) : []));
  if ([...(own ?? []), ...lists, ...idx.account].some((e) => isBrand(e.text))) return true;
  return own == null ? null : false;
}

/**
 * SK28 — brand searches inside non-brand Search and
 * Standard Shopping campaigns.
 *
 * PX02 measures brand inside Performance Max and SK07 the reverse (generic
 * searches inside a brand campaign). Nothing measured the campaigns meant for
 * NEW customers buying the brand's own name: an audit example is brand
 * queries making 18% of a "prospecting" Standard Shopping campaign's sales.
 * Brand = the intake business name through the shared matcher
 * (`brandSearchMatcher` → `brandNameMatches`). Not waste — brand searches
 * sell — so the card states the share and the campaign's return with and
 * without them, never a waste figure. A brand total under the waste bar is a
 * note in the check's own none_found, never a card (Gate 2).
 */
const SK28 = defineCheck({
  id: "SK28",
  claimKey: CLAIM_KEYS.SEARCH_TERM_BRAND_IN_PROSPECTING,
  title: "brand searches are served by a non-brand campaign meant for new customers",
  clientLabel: "searches for your own brand inside campaigns meant for new customers",
  group: "search",
  metrics: ["T.spend", "T.conv", "T.value", "T.waste_floor", "T.population_complete"],
  confounders: [],
  requires: ["searchTerms", "campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Campaigns meant for new customers are not living off searches for your brand.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;
    const BRAND_IN_PROSPECTING_MIN_SHARE = ctx.settings.search.brandInProspectingMinShare;
    const matcher = brandMatcherOfModel(ctx.model);
    const isBrand = matcher ? (t: string) => containsBrandName(t, matcher) : null;
    if (!isBrand) {
      return {
        state: "not_checkable",
        reason: "no brand terms were given for this run, so brand searches cannot be recognised",
        table: "profile",
        category: "needs_client_input",
      };
    }
    const floorV = ctx.get("T.waste_floor");
    const completeV = ctx.get("T.population_complete");
    const floor = num(floorV);
    if (floor == null || !Number.isFinite(floor))
      return {
        state: "insufficient_data",
        reason: wasteFloorReason(floorV),
      };

    const byCampaign = new Map<string, { campaign: CampaignNode; terms: SearchTermNode[] }>();
    for (const { campaign, term } of searchOnlyTermsOf(ctx.model)) {
      if (campaign.attrs.isBrand || !PROSPECTING_TERM_TYPES.has(campaign.attrs.type)) continue;
      (
        byCampaign.get(campaign.id) ??
        byCampaign.set(campaign.id, { campaign, terms: [] }).get(campaign.id)!
      ).terms.push(term);
    }
    if (byCampaign.size === 0) {
      return {
        state: "not_checkable",
        reason: "no live non-brand Search or Standard Shopping campaign has a search-term row",
        table: "search_terms",
        category: "not_present",
      };
    }

    const findings: CheckFinding[] = [];
    const notes: string[] = [];
    for (const { campaign, terms } of byCampaign.values()) {
      const sum = (
        ts: readonly SearchTermNode[],
        k: "cost" | "conv" | "value" | "clicks",
      ): number => ts.reduce((t, x) => t + money(x.windows.m90[k]), 0);
      const brand = terms.filter((t) => isBrand(t.attrs.term));
      const cost = sum(terms, "cost");
      const conv = sum(terms, "conv");
      const value = sum(terms, "value");
      const bCost = sum(brand, "cost");
      const bConv = sum(brand, "conv");
      const bValue = sum(brand, "value");
      const bClicks = sum(brand, "clicks");
      if (brand.length === 0 || cost <= 0) continue;
      const costShare = bCost / cost;
      const convShare = conv > 0 ? bConv / conv : 0;
      if (costShare < BRAND_IN_PROSPECTING_MIN_SHARE && convShare < BRAND_IN_PROSPECTING_MIN_SHARE)
        continue;
      if (bCost < floor) {
        notes.push(
          `${campaign.name}: brand searches ${(convShare * 100).toFixed(1)}% of sales on ${bCost.toFixed(2)} spend (under the ${floor.toFixed(2)} bar)`,
        );
        continue;
      }
      // review fix: with a brand negative already on the campaign the fix is done; search terms carry
      // no daily split to re-judge after it, so these came before it or through close variants — a note
      const negativeFound = brandNegativeOn(ctx, campaign, isBrand);
      if (negativeFound === true) {
        notes.push(
          `${campaign.name}: a brand negative is set; the ${bCost.toFixed(2)} of brand searches came before it or through close variants`,
        );
        continue;
      }
      const cite: MetricValue[] = [floorV, completeV];
      for (const t of [...brand]
        .sort((a, b) => money(b.windows.m90.cost) - money(a.windows.m90.cost))
        .slice(0, R38_ROWS))
        cite.push(
          ctx.get("T.spend", { searchTermId: t.id }),
          ctx.get("T.conv", { searchTermId: t.id }),
        );
      const rows = [...brand]
        .sort(
          (a, b) =>
            money(b.windows.m90.cost) - money(a.windows.m90.cost) ||
            a.attrs.term.localeCompare(b.attrs.term),
        )
        .slice(0, R38_ROWS)
        .map((t) => ({
          entity: { id: t.id, name: t.attrs.term },
          cells: {
            clicks: money(t.windows.m90.clicks),
            spend: Number(money(t.windows.m90.cost).toFixed(2)),
            sales: Number(money(t.windows.m90.conv).toFixed(2)),
            sales_value: Number(money(t.windows.m90.value).toFixed(2)),
          },
        }));
      const roasWith = cost > 0 ? value / cost : null;
      const roasWithout = cost - bCost > 0 ? (value - bValue) / (cost - bCost) : null;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("campaign", campaign.id, campaign.name),
          cite,
          entity: { id: campaign.id, name: campaign.name },
          facts: {
            campaign_type: campaign.attrs.type,
            brand_search_terms: brand.length,
            brand_term_clicks: bClicks,
            brand_term_cost_90d: Number(bCost.toFixed(2)),
            brand_term_conversions: Number(bConv.toFixed(2)),
            brand_term_value_90d: Number(bValue.toFixed(2)),
            brand_share_of_term_spend_pct: Number((costShare * 100).toFixed(1)),
            brand_share_of_term_sales_pct: Number((convShare * 100).toFixed(1)),
            term_spend_90d: Number(cost.toFixed(2)),
            ...(roasWith != null
              ? { return_with_brand_searches: Number(roasWith.toFixed(2)) }
              : {}),
            ...(roasWithout != null
              ? { return_without_brand_searches: Number(roasWithout.toFixed(2)) }
              : {}),
            brand_negative_found: negativeFound,
          },
          population: byCampaign.size,
          rows,
          note:
            bool(completeV) === false
              ? "search terms are a capped sample — the brand share may be higher or lower"
              : undefined,
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };
    return {
      state: "none_found",
      population: byCampaign.size,
      note:
        notes.length > 0
          ? `brand share over ${BRAND_IN_PROSPECTING_MIN_SHARE * 100}% but spend under the bar: ${notes.join("; ")}`
          : `brand searches under ${BRAND_IN_PROSPECTING_MIN_SHARE * 100}% of every non-brand campaign's search-term spend and sales`,
    };
  },
});

/** SK30: a landing URL is a product or category page by these Shopify-style paths. */
function pageKindOf(url: string): "product page" | "collection page" | null {
  const u = url.toLowerCase();
  if (/\/products?\/|\/p\//.test(u)) return "product page";
  if (/\/collections?\//.test(u)) return "collection page";
  return null;
}

/**
 * SK30 — research-stage searches sent to a product page.
 *
 * An ad group whose search-term spend is mostly comparison / informational
 * searches, whose live ads all land on a product or collection page. The money
 * bar is the waste floor on the research spend; below it nothing is said here
 * (SK29's note covers the idea). The sale rate of those searches is stated
 * beside the account's, never priced: SK05 / SK27 already price the searches
 * that sold nothing. Search types Phase 3 (2026-10-11): research searches are
 * proven on a product page first, so it fires only when they spent past the
 * bar AND sold at a rate under the account's (A.cvr); account rate unknown =
 * not judged.
 */
const SK30 = defineCheck({
  id: "SK30",
  claimKey: CLAIM_KEYS.LANDING_PAGE_RESEARCH_INTENT_MISMATCH,
  title: "research-stage searches land on a product page",
  clientLabel: 'research searches ("best", "how to") sent straight to a product page',
  group: "search",
  metrics: ["T.spend", "T.conv", "T.clicks", "T.waste_floor", "A.cvr"],
  confounders: ["MI01"],
  requires: ["searchTerms", "ads", "campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Research searches are not sent straight to product pages.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;
    const RESEARCH_AD_GROUP_MIN_SHARE = ctx.settings.search.researchAdGroupMinShare;
    const floorV = ctx.get("T.waste_floor");
    const floor = num(floorV);
    if (floor == null || !Number.isFinite(floor))
      return {
        state: "insufficient_data",
        reason: wasteFloorReason(floorV),
      };
    const accountCvrV = ctx.get("A.cvr");
    const accountCvr = num(accountCvrV);
    const groups = adGroupsOf(ctx.model).filter(
      ({ campaign }) =>
        campaign.attrs.type === "SEARCH" &&
        !campaign.attrs.isBrand &&
        campaign.status === "ENABLED",
    );
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const { campaign, adGroup } of groups) {
      const terms = adGroup.children.searchTerms;
      const spend = terms.reduce((t, x) => t + money(x.windows.m90.cost), 0);
      if (spend <= 0) continue;
      const urls = adGroup.children.ads
        .filter((a) => a.status === "ENABLED" || a.attrs.status === "ENABLED")
        .flatMap((a) => a.attrs.finalUrls)
        .filter(Boolean);
      if (urls.length === 0) continue;
      population++;
      const kinds = urls.map(pageKindOf);
      if (kinds.some((k) => k == null)) continue; // at least one ad already lands on a non-product page
      const research = terms.filter((t) => researchIntentOf(t.attrs.term) != null);
      const rSpend = research.reduce((t, x) => t + money(x.windows.m90.cost), 0);
      if (rSpend / spend < RESEARCH_AD_GROUP_MIN_SHARE || rSpend < floor) continue;
      const rClicks = research.reduce((t, x) => t + money(x.windows.m90.clicks), 0);
      const rConv = research.reduce((t, x) => t + money(x.windows.m90.conv), 0);
      // Search types Phase 3: "best" / "vs" searches are allowed on a product page until they
      // prove worse there — only a sale rate under the account's own average is a finding
      if (accountCvr == null || rClicks <= 0 || rConv / rClicks >= accountCvr) continue;
      const top = [...research]
        .sort(
          (a, b) =>
            money(b.windows.m90.cost) - money(a.windows.m90.cost) ||
            a.attrs.term.localeCompare(b.attrs.term),
        )
        .slice(0, R38_ROWS);
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("ad_group", adGroup.id, adGroup.name, campaign),
          cite: [
            floorV,
            accountCvrV,
            ...top.map((t) => ctx.get("T.spend", { searchTermId: t.id })),
          ],
          entity: { id: adGroup.id, name: adGroup.name },
          facts: {
            research_term_spend_90d: Number(rSpend.toFixed(2)),
            research_share_of_ad_group_spend_pct: Number(((rSpend / spend) * 100).toFixed(1)),
            research_term_clicks: rClicks,
            research_term_conversions: Number(rConv.toFixed(2)),
            ...(rClicks > 0
              ? { research_term_conversion_rate_pct: Number(((rConv / rClicks) * 100).toFixed(2)) }
              : {}),
            ...(num(accountCvrV) != null
              ? {
                  account_conversion_rate_pct: Number(
                    ((num(accountCvrV) as number) * 100).toFixed(2),
                  ),
                }
              : {}),
            landing_page: urls[0]!,
            landing_page_kind: kinds[0]!,
          },
          rows: top.map((t) => ({
            entity: { id: t.id, name: t.attrs.term },
            cells: {
              kind: researchIntentOf(t.attrs.term) ?? "",
              clicks: money(t.windows.m90.clicks),
              spend: Number(money(t.windows.m90.cost).toFixed(2)),
              sales: Number(money(t.windows.m90.conv).toFixed(2)),
            },
          })),
        }),
      );
    }
    if (population === 0)
      return {
        state: "insufficient_data",
        reason:
          "no live non-brand Search ad group has search-term spend and a live ad with a final URL",
      };
    if (findings.length === 0)
      return {
        state: "none_found",
        population,
        note: `no ad group sends mostly research searches (${RESEARCH_AD_GROUP_MIN_SHARE * 100}%+ of its spend, at least ${floor.toFixed(2)}) converting under the account's sale rate to a product or collection page only`,
      };
    for (const f of findings) f.sample.population = population;
    return { state: "fires", findings };
  },
});

// ---------------------------------------------------------------------------
// R4-D (Round 4 items 26 + 28)
// ---------------------------------------------------------------------------

/**
 * SK32 (R4-D, Round 4 item 26) — Search Partners or the Display Network
 * switched on in a Search campaign (partners also on Standard Shopping).
 *
 * `campaign.network_settings` has been synced since the first audits
 * (`target_search_network` = Google search partners, `target_content_network` =
 * Display Network) and nothing read it. Expert rule (guides 09, 13): partners
 * off unless a test proves them, Display never inside a Search campaign.
 * Display on Search is the warning; partners alone is an opportunity.
 *
 * R9: the spend split by network is read (campaign_network_split, Google's ad
 * network segment), so the card states what the partner and Display clicks cost
 * and sold. A network switched on that took $0 in the window is no finding (a brand
 * campaign with every click on Google Search); it is named in the note. Only an
 * older snapshot without the split keeps the "cannot show what those clicks cost" limit.
 */
const SK32 = defineCheck({
  id: "SK32",
  claimKey: CLAIM_KEYS.SETTINGS_SEARCH_PARTNERS_OR_DISPLAY_ON,
  title: "Search Partners or the Display Network switched on in this campaign",
  clientLabel: "Campaigns also showing on partner sites or the Display Network",
  group: "search",
  judges: {
    campaigns: "enabled",
    because: "a network setting on a paused campaign serves nothing",
  },
  metrics: ["C.spend", "C.conv", "C.value"],
  confounders: [],
  requires: ["campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans:
    "No live Search or Shopping campaign spent on partner sites or the Display Network.",
  run(ctx: CheckCtx) {
    const blocked = gateOnData(ctx, ["campaigns"]);
    if (blocked) return blocked;
    const eligible = campaignsOf(ctx).filter(
      (c) => c.attrs.type === "SEARCH" || c.attrs.type === "SHOPPING",
    );
    if (eligible.length === 0)
      return {
        state: "not_checkable",
        reason: "no live Search or Standard Shopping campaign",
        table: "campaigns",
        category: "not_present",
      };
    const withSettings = eligible.filter((c) => c.attrs.networkSettings != null);
    if (withSettings.length === 0)
      return {
        state: "not_checkable",
        reason: `network_settings is null on all ${eligible.length} live Search / Shopping campaigns`,
        table: "campaigns",
        category: "our_gap",
      };
    const findings: CheckFinding[] = [];
    const idle: string[] = [];
    for (const c of withSettings) {
      const ns = c.attrs.networkSettings!;
      // M7 (K13): a brand Shopping campaign with search partners on is not flagged.
      const partners =
        ns.targetSearchNetwork === true &&
        !(c.attrs.type === "SHOPPING" && c.attrs.layerRole === "brand");
      const display = c.attrs.type === "SEARCH" && ns.targetContentNetwork === true;
      if (!partners && !display) continue;
      const split = c.attrs.networkSpend ?? null;
      // R9: a network on with nothing spent there in the window is a setting that cost nothing
      const partnersIdle =
        split != null && partners && split.partners.cost <= 0 && split.partners.clicks <= 0;
      const displayIdle =
        split != null && display && split.display.cost <= 0 && split.display.clicks <= 0;
      const idleNetworks = [
        partnersIdle ? "Google search partners" : null,
        displayIdle ? "Display Network" : null,
      ].filter(Boolean);
      if ((!partners || partnersIdle) && (!display || displayIdle)) {
        idle.push(`${c.name}: ${idleNetworks.join(" and ")} on`);
        continue;
      }
      const r2 = (n: number) => Number(n.toFixed(2));
      const f = finding({
        claimKey: this.claimKey,
        scope: scopeOf("campaign", c.id, c.name, c),
        entity: { id: c.id, name: c.name },
        cite: [
          ctx.get("C.spend", { campaignId: c.id }),
          ctx.get("C.conv", { campaignId: c.id }),
          ctx.get("C.value", { campaignId: c.id }),
        ],
        facts: {
          campaign_type: c.attrs.type,
          search_partners_on: partners,
          display_network_on: display,
          is_brand_campaign: c.attrs.isBrand,
          ...(split != null
            ? {
                ...(partners
                  ? {
                      search_partners_spend: r2(split.partners.cost),
                      search_partners_clicks: split.partners.clicks,
                      search_partners_sales: r2(split.partners.conv),
                      search_partners_sales_value: r2(split.partners.value),
                    }
                  : {}),
                ...(display
                  ? {
                      display_network_spend: r2(split.display.cost),
                      display_network_clicks: split.display.clicks,
                      display_network_sales: r2(split.display.conv),
                      display_network_sales_value: r2(split.display.value),
                    }
                  : {}),
                google_search_spend: r2(split.google.cost),
              }
            : {}),
        },
        // one-click phase 1: the flags as data the rendered finding keeps (boolean facts
        // are not rendered, and 0/1 number facts are deduped by value in rowsFromFacts),
        // so the networks-off change is built from these cells, never from wording
        rows: [
          {
            entity: { id: c.id, name: c.name },
            cells: {
              search_partners: partners ? "on" : "off",
              display_network: display ? "on" : "off",
              campaign_type: String(c.attrs.type),
            },
          },
        ],
        population: withSettings.length,
        note: `${[partners ? "Google search partners" : null, display ? "Display Network" : null].filter(Boolean).join(" and ")} on${idleNetworks.length > 0 ? ` (no spend on ${idleNetworks.join(" or ")} in the window)` : ""}`,
      });
      // an older snapshot without the network split cannot say what those clicks cost
      if (split == null)
        f.limitedBy = [
          "Google's split of this campaign's spend between Google Search and the other networks is not in our data, so what those clicks cost is not shown.",
        ];
      // Display on that spent nothing is no warning, the same rule as partners
      if (!display || displayIdle) f.maxSeverity = "opportunity";
      findings.push(f);
    }
    const idleNote =
      idle.length > 0 ? `${idle.join("; ")}, but no spend there in the window` : null;
    if (findings.length > 0) {
      if (idleNote) for (const f of findings) f.note = `${f.note}; ${idleNote}`;
      return { state: "fires", findings };
    }
    return {
      state: "none_found",
      population: withSettings.length,
      note:
        idleNote ??
        `${withSettings.length} live Search / Shopping campaign(s) on Google Search only`,
    };
  },
});

/** SK33: conflict lines on the card (most spend first). */
const SK33_ROWS = 10;

/** SK33: the levels a negative keyword can sit at, as the card names them. */
type NegativeLevelName = "ad group" | "campaign" | "shared list" | "account";

/**
 * SK33 (R4-D, Round 4 item 28) — a negative keyword that blocks one of the
 * account's own keywords (Google's "conflicting negatives").
 *
 * SK06 finds SEARCHES a negative already blocks; nothing compared negatives with
 * the keywords themselves. A negative blocks a keyword when the keyword's own
 * text, as a search, would be blocked by it — Google's negative-match rules,
 * which do NOT cover close variants (`negativeMatches`: exact = whole text,
 * phrase = words in order, broad = all words present). Sources, in order: the
 * ad group's negatives, the campaign's (only where they were synced), the
 * shared lists attached to the campaign, the account list. A list whose
 * attachment we could not read is never assumed to apply (it is counted in the
 * note instead): the shared-list sync names many lists it cannot link, and
 * assuming them would invent conflicts.
 */
const SK33 = defineCheck({
  id: "SK33",
  claimKey: CLAIM_KEYS.NEGATIVES_BLOCK_OWN_KEYWORD,
  title: "a negative keyword blocks one of the account's own keywords",
  clientLabel: "negative keywords that block your own keywords",
  group: "search",
  metrics: ["K.spend", "K.clicks"],
  confounders: [],
  requires: ["keywords", "campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No negative keyword blocks one of your own keywords.",
  run(ctx: CheckCtx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;
    const idx = ctx.model.negativeIndex;
    const search = campaignsOf(ctx).filter((c) => c.attrs.type === "SEARCH");
    if (search.length === 0)
      return {
        state: "not_checkable",
        reason: "no live Search campaign",
        table: "keywords",
        category: "not_present",
      };
    const unlinkedLists = new Set<string>();
    const campaignsWithoutOwn: string[] = [];
    const findings: CheckFinding[] = [];
    let judged = 0;
    for (const campaign of search) {
      const own =
        campaign.children.negatives == null ? null : (idx.byCampaign.get(campaign.id) ?? []);
      if (own == null) campaignsWithoutOwn.push(campaign.name);
      const lists: { name: string; entries: NegativeEntry[] }[] = [];
      for (const l of campaign.children.inheritedNegatives) {
        if (l.attrs.level !== "shared_list" || !l.attrs.listId) continue;
        if (l.attrs.attachmentUnknown) {
          unlinkedLists.add(l.attrs.listId);
          continue;
        }
        lists.push({ name: l.name, entries: idx.byList.get(l.attrs.listId) ?? [] });
      }
      const conflicts: {
        keyword: KeywordNode;
        negative: NegativeEntry;
        level: NegativeLevelName;
        where: string;
      }[] = [];
      for (const adGroup of campaign.children.adGroups) {
        if (statusOf(adGroup) !== "ENABLED") continue;
        const adGroupNegs = adGroup.children.keywords
          .filter((k) => k.attrs.isNegative)
          .map((k): NegativeEntry => ({
            criterionId: k.attrs.criterionId,
            text: k.attrs.text,
            matchType: k.attrs.matchType,
          }));
        for (const keyword of adGroup.children.keywords) {
          if (
            keyword.attrs.isNegative ||
            statusOf(keyword) !== "ENABLED" ||
            !keyword.attrs.text.trim()
          )
            continue;
          judged++;
          const text = keyword.attrs.text;
          const sources: {
            level: NegativeLevelName;
            where: string;
            entries: readonly NegativeEntry[];
          }[] = [
            { level: "ad group", where: adGroup.name, entries: adGroupNegs },
            { level: "campaign", where: campaign.name, entries: own ?? [] },
            ...lists.map((l) => ({
              level: "shared list" as const,
              where: l.name,
              entries: l.entries,
            })),
            { level: "account", where: "account negative keywords", entries: idx.account },
          ];
          for (const src of sources) {
            const hit = src.entries.find((n) => negativeMatches(text, n));
            if (hit) {
              conflicts.push({ keyword, negative: hit, level: src.level, where: src.where });
              break;
            }
          }
        }
      }
      if (conflicts.length === 0) continue;
      const sorted = [...conflicts].sort(
        (a, b) =>
          money(b.keyword.windows.m90.cost) - money(a.keyword.windows.m90.cost) ||
          a.keyword.attrs.text.localeCompare(b.keyword.attrs.text),
      );
      const shown = sorted.slice(0, SK33_ROWS);
      const matchWord = (m: string | null) => String(m ?? "BROAD").toLowerCase();
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: scopeOf("campaign", campaign.id, campaign.name, campaign),
          entity: { id: campaign.id, name: campaign.name },
          citeLabelled: shown.map((x) => ({
            value: ctx.get("K.spend", { keywordId: x.keyword.id }),
            entity: { id: x.keyword.id, name: x.keyword.attrs.text },
          })),
          cite: [],
          facts: {
            keywords_blocked: conflicts.length,
            keywords_judged_in_campaign: campaign.children.adGroups.reduce(
              (t, g) =>
                t +
                g.children.keywords.filter((k) => !k.attrs.isNegative && statusOf(k) === "ENABLED")
                  .length,
              0,
            ),
            blocked_keyword_spend_90d: Number(
              conflicts.reduce((t, x) => t + money(x.keyword.windows.m90.cost), 0).toFixed(2),
            ),
            levels: [...new Set(conflicts.map((x) => x.level))].join(", "),
            negative_match_types: [
              ...new Set(
                conflicts.map((x) => String(x.negative.matchType ?? "BROAD").toUpperCase()),
              ),
            ]
              .sort()
              .join(", "),
          },
          population: search.length,
          rows: shown.map((x) => ({
            entity: { id: x.keyword.id, name: x.keyword.attrs.text },
            label: `${matchWord(x.keyword.attrs.matchType)} keyword`,
            cells: {
              blocked_by: `${x.negative.text} (${matchWord(x.negative.matchType)} negative)`,
              level: x.level,
              where: x.where,
              spend: Number(money(x.keyword.windows.m90.cost).toFixed(2)),
            },
          })),
          note: `${conflicts.length} enabled keyword(s) whose own text a negative blocks`,
        }),
      );
    }
    const notes = [
      unlinkedLists.size > 0
        ? `${unlinkedLists.size} negative list(s) whose campaign links were not read were not compared`
        : null,
      campaignsWithoutOwn.length > 0
        ? `campaign-level negatives not read for ${campaignsWithoutOwn.join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("; ");
    if (findings.length > 0) {
      if (notes) for (const f of findings) f.note = `${f.note}; ${notes}`;
      return { state: "fires", findings };
    }
    if (judged === 0)
      return {
        state: "not_checkable",
        reason: "no enabled keyword in an enabled ad group of a live Search campaign",
        table: "keywords",
        category: "not_present",
      };
    return {
      state: "none_found",
      population: search.length,
      note: [`${judged} enabled keyword(s) compared with their negatives, none blocked`, notes]
        .filter(Boolean)
        .join("; "),
    };
  },
});

// ---------------------------------------------------------------------------
// SK35 — the five search traffic types
// ---------------------------------------------------------------------------

type SearchTrafficType = "brand" | "category" | "competitor" | "comparison" | "informational";
const SEARCH_TRAFFIC_TYPES: readonly SearchTrafficType[] = [
  "brand",
  "category",
  "competitor",
  "comparison",
  "informational",
];
const TRAFFIC_TYPE_LABEL: Readonly<Record<SearchTrafficType, string>> = {
  brand: "Brand (your own name)",
  category: "Category (what you sell)",
  competitor: "Competitor names",
  comparison: 'Comparison ("best", "vs", "reviews")',
  informational: 'Research ("how to", "guide")',
};

/**
 * One search's traffic type: the brand (the brand terms given for this run),
 * then a campaign named for competitors (competitor names are not known up
 * front), then research words, else category.
 */
function trafficTypeOf(
  term: string,
  campaign: { name: string },
  isBrand: ((t: string) => boolean) | null,
): SearchTrafficType {
  if (isBrand?.(term)) return "brand";
  if (isCompetitorCampaign(campaign.name)) return "competitor";
  return researchIntentOf(term) ?? "category";
}

/**
 * SK35 — where the Search money goes, by search traffic type, and which types
 * are missing. A table, not a fault. Spend, sales and the return (ROAS when
 * values are tracked, else cost per sale) per type, from the search terms of the
 * live Search campaigns. Brand needs brand terms; without them brand searches
 * read as category and "brand" is never called missing.
 *
 * R10: the money is the live Search campaigns' own spend, not the search terms'
 * (Google shows terms for part of the clicks only: one shop's terms held $1,554
 * while its Brand campaign alone spent $2,157). A brand campaign (the same flag
 * the other checks use) counts whole as brand; the other campaigns are split by
 * their search terms, and what their terms do not show is its own line.
 */
const SK35 = defineCheck({
  id: "SK35",
  claimKey: CLAIM_KEYS.SEARCH_TERM_TRAFFIC_TYPES,
  title: "which kinds of searches the Search money buys, and the kinds missing",
  clientLabel:
    "which kinds of searches your Search money buys (brand, category, competitor, comparison, research)",
  noteOnly: "which kinds of searches the Search money buys, and the kinds missing",
  group: "search",
  metrics: ["T.spend", "T.population_complete"],
  confounders: [],
  requires: ["searchTerms", "campaigns"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No Search money to split by search type.",
  run(ctx) {
    const blocked = gateOnData(ctx, this.requires);
    if (blocked) return blocked;
    const matcher = brandMatcherOfModel(ctx.model);
    const isBrand = matcher ? (t: string) => containsBrandName(t, matcher) : null;
    const completeV = ctx.get("T.population_complete");
    const search = campaignsOf(ctx).filter((c) => c.attrs.type === "SEARCH");
    if (search.length === 0)
      return {
        state: "not_checkable",
        reason: "no live Search campaign on this account",
        category: "not_present",
      };
    const brandCampaigns = search.filter((c) => c.attrs.isBrand);
    const otherIds = new Set(search.filter((c) => !c.attrs.isBrand).map((c) => c.id));
    const terms = searchOnlyTermsOf(ctx.model).filter((t) => otherIds.has(t.campaign.id));
    const termTotal = terms.reduce((n, r) => n + money(r.term.windows.m90.cost), 0);
    const brandCampaignCost = brandCampaigns.reduce((n, c) => n + money(c.windows.m90.cost), 0);
    const others = search.filter((c) => !c.attrs.isBrand);
    const sumOf = (
      xs: readonly {
        windows: { m90: { cost?: number | null; conv?: number | null; value?: number | null } };
      }[],
      k: "cost" | "conv" | "value",
    ) => xs.reduce((n, x) => n + money(x.windows.m90[k]), 0);
    // what the other campaigns spent (and sold) on searches Google does not show, never below zero
    const unseen = Math.max(0, sumOf(others, "cost") - termTotal);
    const unseenConv = Math.max(
      0,
      sumOf(others, "conv") -
        sumOf(
          terms.map((t) => t.term),
          "conv",
        ),
    );
    const unseenValue = Math.max(
      0,
      sumOf(others, "value") -
        sumOf(
          terms.map((t) => t.term),
          "value",
        ),
    );
    const total = brandCampaignCost + termTotal + unseen;
    if (total <= 0 || (terms.length === 0 && brandCampaignCost <= 0))
      return {
        state: "insufficient_data",
        reason: "the live Search campaigns have no search-term spend",
      };

    interface Agg {
      terms: number;
      cost: number;
      conv: number;
      value: number;
      top: SearchTermNode | null;
    }
    const agg = new Map<SearchTrafficType, Agg>(
      SEARCH_TRAFFIC_TYPES.map((t) => [t, { terms: 0, cost: 0, conv: 0, value: 0, top: null }]),
    );
    // a brand campaign counts whole as brand: its own spend, sales and value
    for (const c of brandCampaigns) {
      const a = agg.get("brand")!;
      const w = c.windows.m90;
      a.cost += money(w.cost);
      a.conv += money(w.conv);
      a.value += money(w.value);
    }
    agg.get("brand")!.terms += searchOnlyTermsOf(ctx.model).filter((t) =>
      brandCampaigns.some((c) => c.id === t.campaign.id),
    ).length;
    for (const { campaign, term } of terms) {
      const a = agg.get(trafficTypeOf(term.attrs.term, campaign, isBrand))!;
      const w = term.windows.m90;
      a.terms++;
      a.cost += money(w.cost);
      a.conv += money(w.conv);
      a.value += money(w.value);
      if (!a.top || money(w.cost) > money(a.top.windows.m90.cost)) a.top = term;
    }
    const valueTracked = [...agg.values()].some((a) => a.value > 0);
    const brandKnown = isBrand != null || brandCampaigns.length > 0;
    const missing = SEARCH_TRAFFIC_TYPES.filter(
      (t) => (t !== "brand" || brandKnown) && agg.get(t)!.cost <= 0,
    );
    const r2 = (n: number) => Number(n.toFixed(2));
    const rows = SEARCH_TRAFFIC_TYPES.map((t) => {
      const a = agg.get(t)!;
      return {
        entity: { id: null, name: TRAFFIC_TYPE_LABEL[t] },
        label: t as SearchTrafficType | "unseen",
        cells: {
          search_terms_count: a.terms,
          spend: r2(a.cost),
          share_of_spend_pct: Number(((a.cost / total) * 100).toFixed(1)),
          sales: r2(a.conv),
          ...(valueTracked
            ? { sales_value: r2(a.value), roas: a.cost > 0 ? r2(a.value / a.cost) : null }
            : { cost_per_sale: a.conv > 0 ? r2(a.cost / a.conv) : null }),
        },
      };
    });
    if (unseen > 0)
      rows.push({
        entity: { id: null, name: "spend not split by search term" },
        label: "unseen",
        cells: {
          search_terms_count: 0,
          spend: r2(unseen),
          share_of_spend_pct: Number(((unseen / total) * 100).toFixed(1)),
          sales: r2(unseenConv),
          ...(valueTracked
            ? { sales_value: r2(unseenValue), roas: r2(unseenValue / unseen) }
            : { cost_per_sale: unseenConv > 0 ? r2(unseen / unseenConv) : null }),
        },
      });
    const facts: Record<string, MetricPayload> = {
      // R10: every live Search campaign's own spend; the shares below are of this
      search_spend_90d: r2(total),
      search_term_spend_90d: r2(termTotal),
      brand_campaign_spend_90d: r2(brandCampaignCost),
      unseen_spend_90d: r2(unseen),
      brand_detected: brandKnown,
      missing_types: missing.map((t) => TRAFFIC_TYPE_LABEL[t]).join(", "),
      missing_type_count: missing.length,
    };
    for (const t of SEARCH_TRAFFIC_TYPES) facts[`${t}_spend_90d`] = r2(agg.get(t)!.cost);
    const tops = SEARCH_TRAFFIC_TYPES.map((t) => agg.get(t)!.top).filter(
      (x): x is SearchTermNode => x != null,
    );
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: this.claimKey,
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [completeV, ...tops.map((t) => ctx.get("T.spend", { searchTermId: t.id }))],
          facts,
          population: terms.length,
          rows,
          note: [
            "search terms of the live Search campaigns, last 90 days, sorted by word rules",
            "competitor searches = searches in a campaign named for competitors (competitor names are not known otherwise)",
            ...(brandCampaigns.length > 0
              ? [
                  `brand campaign(s) counted whole as brand: ${brandCampaigns.map((c) => c.name).join(", ")}`,
                ]
              : []),
            ...(unseen > 0
              ? [
                  `${r2(unseen)} of the other Search campaigns' spend went on searches Google does not show, so it is not split by kind`,
                ]
              : []),
            ...(brandKnown
              ? []
              : [
                  "no brand terms were given, so brand searches count as category and brand is never called missing",
                ]),
            ...(bool(completeV) === false ? ["search terms are a capped sample"] : []),
          ].join("; "),
        }),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// SK42 — ads.headline_case_mixed (M18, J41)
// ---------------------------------------------------------------------------

/**
 * SK42: a live responsive search ad whose headlines mix Title Case and sentence
 * case. M18 fix round: the style is a judgement (German and Dutch nouns start with a
 * capital by grammar; brand casing like "iPhone" is not a mix), so the app asks its AI
 * ad text judge. The connector has no AI read and never guesses by code: always not run.
 */
const SK42 = defineCheck({
  id: "SK42",
  claimKey: CLAIM_KEYS.ADS_HEADLINE_CASE_MIXED,
  title: "a live Search ad mixes Title Case and sentence case headlines",
  clientLabel: "one writing style per Search ad",
  group: "search",
  metrics: ["C.spend"],
  confounders: [],
  requires: ["ads", "adGroups"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each live Search ad uses one headline style: Title Case or sentence case.",
  run() {
    return {
      state: "not_checkable",
      reason:
        "the headline style needs an AI read of the ad text (German or Dutch nouns and brand names are capitalised on purpose); the connector does not judge it by code",
      table: "ads",
      category: "our_gap",
    };
  },
});

export const SEARCH_CHECKS: CheckDefinition[] = [
  SK06,
  SK07,
  SK08,
  SK09,
  SK10,
  SK11,
  SK12,
  SK13,
  SK14,
  SK15,
  SK16,
  SK17,
  SK18,
  SK19,
  SK20,
  SK21,
  SK22,
  SK26,
  SK27,
  SK28,
  SK30,
  SK32,
  SK33,
  SK35,
  SK42,
];
