// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Search tree — ad groups → keywords / search terms / ads (+ assets, policy,
 * landing pages) / ad-group extensions / ad-group demographics; plus the
 * extension serving rules and the landing page universe (both used by every
 * campaign type, so they live here once).
 *
 * Joins (§C): ad_groups.campaign_id; keywords.ad_group_id; ads.ad_group_id;
 * search_terms.ad_group_id; ad_policy.ad_id ↔ ads.ad_id (cast to text);
 * asset_performance.ad_resource ends with '~<ad_id>'; ad_extensions by
 * campaign_id / ad_group_id and level.
 *
 * Search term → keyword: `search_terms.keyword_criterion_id` when present
 * (Phase 1b adds it to the sync); otherwise `matchSource: 'unresolved'` and a
 * text+match-type HINT (`textMatchCandidateKeywordId`) that is not a join.
 *
 * GUESSED JOIN — ad → landing page: landing_page_views has no ad/campaign
 * key; an ad's final URL is matched on host+path (query stripped) to every
 * landing page row with the same host+path. A homepage final URL matches
 * the homepage row only ('https://example.com/').
 *
 * Extension serving rules (build sheet §C):
 *   SITELINK cumulative; CALLOUT / STRUCTURED_SNIPPET / PROMOTION / CALL /
 *   PRICE override (an ad-group asset of the same type hides the campaign one
 *   for that ad group); PMax / Shopping campaigns never serve CALLOUT,
 *   STRUCTURED_SNIPPET or CALL.
 *   servedStatus: impressions > 0 → 'served'; never-serving type on the
 *   campaign type → 'not_served_by_type'; campaign-level OVERRIDE type with an
 *   ad-group asset of the same type under the campaign → 'overridden';
 *   else 'eligible_no_impressions'.
 */
import {
  arr,
  bool,
  groupBy,
  json,
  nc,
  nodeFromRows,
  propagateTruncation,
  setShare,
  str,
  type BuildCtx,
} from "./context.js";
import { num } from "./metrics.js";
import { adTypeWords } from "../shared/words.js";
import type { NegativesBuild } from "./buildNegatives.js";
import type { SlicesBuild } from "./buildSlices.js";
import type { AdGroupNode } from "./nodes/AdGroupNode.js";
import type { AdNode } from "./nodes/AdNode.js";
import type { AssetNode } from "./nodes/AssetNode.js";
import type { CampaignNode, ImpressionShareAttrs } from "./nodes/CampaignNode.js";
import type { ExtensionNode, OverrideClass, ServedStatus } from "./nodes/ExtensionNode.js";
import type { KeywordNode } from "./nodes/KeywordNode.js";
import type { LandingPageAttrs, LandingPageNode, UtmClass } from "./nodes/LandingPageNode.js";
import type { SearchTermNode } from "./nodes/SearchTermNode.js";

// ------------------------------------------------------------- impression share
export function impressionShareFrom(
  row: any,
  source: ImpressionShareAttrs["source"],
): ImpressionShareAttrs {
  if (!row)
    return {
      is: null,
      lostBudget: null,
      lostRank: null,
      top: null,
      absoluteTop: null,
      exactMatch: null,
      recent: null,
      source: "none",
    };
  const is = num(row.search_impression_share);
  const recentCost = num(row.recent_cost);
  return {
    is,
    lostBudget: num(row.search_budget_lost_impression_share),
    lostRank: num(row.search_rank_lost_impression_share),
    top: num(row.search_top_impression_share),
    absoluteTop: num(row.search_absolute_top_impression_share),
    exactMatch: num(row.search_exact_match_impression_share),
    recent:
      recentCost == null
        ? null
        : {
            start: row.recent_start == null ? null : String(row.recent_start),
            end: row.recent_end == null ? null : String(row.recent_end),
            cost: recentCost,
            value: num(row.recent_conversion_value),
            lostBudget: num(row.recent_budget_lost_impression_share),
          },
    source: is == null ? "none" : source,
  };
}

// ------------------------------------------------------------- extensions
/** One explicit table (build sheet §C + reference_gads_asset_level_serving_rules). Anything else is UNKNOWN — never assumed. */
export const EXTENSION_SERVING: Record<string, OverrideClass> = {
  SITELINK: "CUMULATIVE",
  CALLOUT: "OVERRIDE",
  STRUCTURED_SNIPPET: "OVERRIDE",
  PROMOTION: "OVERRIDE",
  CALL: "OVERRIDE",
  PRICE: "OVERRIDE",
};
const NEVER_ON_PMAX_SHOPPING = new Set(["CALLOUT", "STRUCTURED_SNIPPET", "CALL"]);

export function overrideClassOf(type: string): OverrideClass {
  return EXTENSION_SERVING[type] ?? "UNKNOWN";
}

export interface ExtensionsBuild {
  byCampaign: Map<string, ExtensionNode[]>;
  byAdGroup: Map<string, ExtensionNode[]>;
  account: ExtensionNode[];
  orphans: ExtensionNode[];
  callouts: { distinctTexts: number; neverServed: string[] };
  all: ExtensionNode[];
}

export function buildExtensions(ctx: BuildCtx): ExtensionsBuild {
  const rows = ctx.read("adExtensions");
  // ad-group-level types per campaign: campaign → type → ad group ids
  const agTypes = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    if (String(r.level) !== "AD_GROUP") continue;
    const cid = String(r.campaign_id ?? "");
    const t = String(r.extension_type ?? "");
    const m = agTypes.get(cid) ?? agTypes.set(cid, new Map()).get(cid)!;
    (m.get(t) ?? m.set(t, new Set()).get(t)!).add(String(r.ad_group_id ?? ""));
  }
  // every ad group of each audited campaign — an OVERRIDE asset is hidden only in the ad groups that carry their own set
  const adGroupsByCampaign = groupBy(ctx.read("adGroups"), (g) => str(g.campaign_id));
  const byCampaign = new Map<string, ExtensionNode[]>();
  const byAdGroup = new Map<string, ExtensionNode[]>();
  const account: ExtensionNode[] = [];
  const orphans: ExtensionNode[] = [];
  const all: ExtensionNode[] = [];
  for (const r of rows) {
    const type = String(r.extension_type ?? "UNKNOWN");
    const levelRaw = String(r.level ?? "CAMPAIGN");
    const level = levelRaw === "ACCOUNT" || levelRaw === "AD_GROUP" ? levelRaw : "CAMPAIGN";
    const campaignId = level === "ACCOUNT" ? null : str(r.campaign_id);
    const adGroupId = level === "AD_GROUP" ? str(r.ad_group_id) : null;
    const campaignType = campaignId ? (ctx.campaignTypeById.get(campaignId) ?? null) : null;
    const impressions = num(r.impressions) ?? 0;
    const oc = overrideClassOf(type);
    let overriddenIn: string[] = [];
    let servingIn: string[] = [];
    let served: ServedStatus;
    const neverServes =
      !!campaignType &&
      (campaignType === "PERFORMANCE_MAX" || campaignType === "SHOPPING") &&
      NEVER_ON_PMAX_SHOPPING.has(type);
    if (neverServes) {
      // doctrine first; data that contradicts it is recorded, not obeyed silently
      if (impressions > 0) {
        served = "served_despite_rule";
        ctx.contradictions.push({
          table: "adExtensions",
          rowId: String(r.id ?? r.asset_id),
          rule: `${campaignType} never serves ${type}`,
          observed: `${impressions} impressions on ${level} asset ${r.asset_id} in campaign ${campaignId}`,
        });
      } else served = "not_served_by_type";
    } else if (impressions > 0) served = "served";
    else if (level === "CAMPAIGN" && oc === "OVERRIDE" && campaignId) {
      const overriding = agTypes.get(campaignId)?.get(type) ?? new Set<string>();
      const allAgs = (adGroupsByCampaign.get(campaignId) ?? []).map((g) => String(g.ad_group_id));
      overriddenIn = allAgs.filter((g) => overriding.has(g));
      servingIn = allAgs.filter((g) => !overriding.has(g));
      served =
        allAgs.length > 0 && servingIn.length === 0 ? "overridden" : "eligible_no_impressions";
    } else served = "eligible_no_impressions";
    const metadata = json<Record<string, unknown>>(r.metadata);
    const base = nodeFromRows(
      ctx,
      "extension",
      `${level}:${r.asset_id}:${campaignId ?? "CUSTOMER"}:${adGroupId ?? ""}`,
      str(r.text) ?? String(r.asset_id),
      adGroupId ?? campaignId,
      [r],
      "adExtensions",
      { status: r.status },
    );
    const node: ExtensionNode = {
      ...base,
      attrs: {
        type,
        level,
        campaignId,
        adGroupId,
        text: str(r.text),
        description1: str(r.description1),
        description2: str(r.description2),
        finalUrls: arr(r.final_urls).map(String),
        snippetHeader: str(r.snippet_header),
        snippetValues: json(r.snippet_values),
        metadata,
        // percent scale (10 = 10% off, 100 = free shipping); pre-ea84d1ec snapshots are migrated by the loader
        promoPercentOff: type === "PROMOTION" ? num(metadata?.percentOff) : null,
        promoEndDate: type === "PROMOTION" ? str(metadata?.endDate) : null,
        linkCount: num(r.link_count),
        overrideClass: oc,
        servedStatus: served,
        overriddenInAdGroupIds: overriddenIn,
        servingInAdGroupIds: servingIn,
        // rule 245: the policy verdict, never the link status. `approval_status`
        // is synced from asset.policy_summary (audits before
        // that carry null — unknown, never approved).
        approvalStatus:
          str(r.approval_status) ??
          str(r.policy_approval_status) ??
          str((metadata ?? {}).approvalStatus),
        orphan: campaignId != null && !ctx.campaignIds.has(campaignId),
      },
    };
    all.push(node);
    if (level === "ACCOUNT") account.push(node);
    else if (node.attrs.orphan) orphans.push(node);
    else if (level === "AD_GROUP" && adGroupId)
      (byAdGroup.get(adGroupId) ?? byAdGroup.set(adGroupId, []).get(adGroupId)!).push(node);
    else if (campaignId)
      (byCampaign.get(campaignId) ?? byCampaign.set(campaignId, []).get(campaignId)!).push(node);
  }
  // population rule (build sheet §D.0): distinct callouts / never-served are computed over rows that join an audited campaign or ad group, never over the raw table
  const attached = all.filter((e) => e.attrs.level !== "ACCOUNT" && !e.attrs.orphan);
  const calloutTexts = groupBy(
    attached.filter((e) => e.attrs.type === "CALLOUT"),
    (e) => e.attrs.text,
  );
  const neverServed = [...calloutTexts]
    .filter(
      ([, nodes]) =>
        !nodes.some(
          (n) =>
            n.attrs.servedStatus === "served" || n.attrs.servedStatus === "served_despite_rule",
        ),
    )
    .map(([t]) => t);
  return {
    byCampaign,
    byAdGroup,
    account,
    orphans,
    all,
    callouts: { distinctTexts: calloutTexts.size, neverServed },
  };
}

// ------------------------------------------------------------- landing pages
/** Google's ValueTrack placeholders left in a URL ({ignore}, {lpurl}, %7Bignore%7D). */
const PLACEHOLDER = /\{[^{}/]*\}|%7B[^/]*?%7D/gi;

/** The page itself: scheme + host + path, placeholders stripped, no query, no trailing slash. */
export function cleanPageUrl(u: string): string {
  try {
    const x = new URL(u);
    const path = x.pathname.replace(PLACEHOLDER, "").replace(/\/$/, "");
    return `${x.protocol}//${x.host}${path}`;
  } catch {
    return u.replace(PLACEHOLDER, "");
  }
}

export function urlKey(u: string): string {
  try {
    const x = new URL(u);
    return (x.host + x.pathname.replace(PLACEHOLDER, "")).replace(/\/$/, "").toLowerCase();
  } catch {
    return u.replace(PLACEHOLDER, "").toLowerCase();
  }
}

function utmOf(u: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const [k, v] of new URL(u).searchParams) if (k.startsWith("utm_")) out[k] = v;
  } catch {
    /* not a URL */
  }
  return out;
}

const utmClassOf = (utm: Record<string, string>): UtmClass =>
  utm.utm_medium === "product_sync"
    ? "product_sync"
    : Object.keys(utm).length
      ? "tagged_other"
      : "untagged";

/** From the parsed URL, so "HTTP://" is http, as cleanPageUrl writes it. */
const schemeOf = (url: string): LandingPageAttrs["scheme"] => {
  try {
    const p = new URL(url).protocol;
    return p === "https:" ? "https" : p === "http:" ? "http" : "other";
  } catch {
    return "other";
  }
};

/**
 * The key a page is grouped and matched on: scheme + host + path. The scheme stays in it,
 * so a few http rows never take the spend of the same path over https with them.
 */
export const pageKeyOf = (url: string): string => `${schemeOf(url)}:${urlKey(url)}`;

/** Original URLs kept on a page as examples. */
const EXAMPLE_URLS = 3;

export interface LandingPagesBuild {
  nodes: LandingPageNode[];
  /** by pageKeyOf (scheme + host + path) */
  byKey: Map<string, LandingPageNode[]>;
  summary: {
    total: number;
    productSync: number;
    taggedOther: number;
    untagged: number;
    http: number;
  };
}

/** Clicks per campaign over a page's rows; null when any row's split was not read. */
function campaignClicksOf(group: any[]): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const r of group) {
    if (!Array.isArray(r.campaign_clicks)) return null;
    for (const c of r.campaign_clicks) {
      const id = String(c?.campaign_id ?? "");
      if (id) out[id] = (out[id] ?? 0) + (num(c?.clicks) ?? 0);
    }
  }
  return out;
}

/** Round 4 R17: the `variant=` ids in a page's URLs, each once, in the order read. */
function variantIdsOf(urls: readonly string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    const m = /[?&]variant=(\d+)/.exec(u);
    if (m) out.add(m[1]!);
  }
  return [...out];
}

/**
 * One node per page (scheme + host + path): rows that differ only by query string or a
 * left-over placeholder are one page; http and https stay apart. The summary still counts
 * every row read.
 */
export function buildLandingPages(ctx: BuildCtx, parentId: string): LandingPagesBuild {
  const rows = ctx.read("landingPageViews");
  const nodes: LandingPageNode[] = [];
  const byKey = new Map<string, LandingPageNode[]>();
  const summary = { total: rows.length, productSync: 0, taggedOther: 0, untagged: 0, http: 0 };
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const url = String(r.url ?? "");
    const utmClass = utmClassOf(utmOf(url));
    if (utmClass === "product_sync") summary.productSync++;
    else if (utmClass === "tagged_other") summary.taggedOther++;
    else summary.untagged++;
    if (schemeOf(url) === "http") summary.http++;
    const key = pageKeyOf(url);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  for (const [key, group] of groups) {
    // the row with the most spend speaks for the page's tags and Google's page scores
    const byCost = [...group].sort(
      (a, b) =>
        (num(b.cost) ?? 0) - (num(a.cost) ?? 0) || (num(b.clicks) ?? 0) - (num(a.clicks) ?? 0),
    );
    const top = byCost[0];
    const topUrl = String(top?.url ?? "");
    const utm = utmOf(topUrl);
    const urls = byCost.map((r) => String(r.url ?? ""));
    const url = cleanPageUrl(topUrl);
    const base = nodeFromRows(ctx, "landingPage", url, url, parentId, group, "landingPageViews");
    const utmSpend: Partial<Record<UtmClass, number>> = {};
    for (const r of group) {
      const cls = utmClassOf(utmOf(String(r.url ?? "")));
      utmSpend[cls] = (utmSpend[cls] ?? 0) + (num(r.cost) ?? 0);
    }
    const node: LandingPageNode = {
      ...base,
      attrs: {
        url,
        urlKey: urlKey(topUrl),
        exampleUrls: [...new Set(urls)].slice(0, EXAMPLE_URLS),
        // every row of a page shares its scheme (it is part of the key)
        scheme: schemeOf(topUrl),
        utmClass: utmClassOf(utm),
        utm,
        utmSpend,
        mobileFriendlyPct: num(
          byCost.find((r) => num(r.mobile_friendly_pct) != null)?.mobile_friendly_pct,
        ),
        speedScore: num(byCost.find((r) => num(r.speed_score) != null)?.speed_score),
        adIds: [],
        campaignClicks: campaignClicksOf(group),
        variantIds: variantIdsOf(urls),
      },
    };
    nodes.push(node);
    byKey.set(key, [node]);
  }
  return { nodes, byKey, summary };
}

// ------------------------------------------------------------- ad groups
export interface SearchDeps {
  negatives: NegativesBuild;
  slices: SlicesBuild;
  extensions: ExtensionsBuild;
  landingPages: LandingPagesBuild;
  /** prepared once for the whole account */
  index: SearchIndex;
}

export interface SearchIndex {
  adGroupsByCampaign: Map<string, any[]>;
  keywordsByAdGroup: Map<string, any[]>;
  adsByAdGroup: Map<string, any[]>;
  termsByAdGroup: Map<string, any[]>;
  termsByCampaignNoAdGroup: Map<string, any[]>;
  dsaTermsByAdGroup: Map<string, any[]>;
  policyByAdId: Map<string, any>;
  assetsByAdId: Map<string, any[]>;
  /** asset_performance rows by asset_id — the second join (pmax_assets.asset_id). */
  assetPerfByAssetId: Map<string, any[]>;
  /** duplicateKey → keyword ids */
  dupIndex: Map<string, string[]>;
  keywordById: Map<string, any>;
  /** every search term text / keyword text, lowercased (for PMax category overlap). */
  termTexts: Set<string>;
  keywordTexts: Set<string>;
}

export function prepareSearchIndex(ctx: BuildCtx): SearchIndex {
  const adGroups = ctx.read("adGroups");
  const keywords = ctx.read("keywords");
  const ads = ctx.read("ads");
  const terms = ctx.read("searchTerms");
  const dsa = ctx.read("dsaSearchTerms");
  const policy = ctx.read("adPolicyData");
  const assetPerf = ctx.read("assetPerformance");
  const dupIndex = new Map<string, string[]>();
  const keywordById = new Map<string, any>();
  for (const k of keywords) {
    const key = `${String(k.text ?? "").toLowerCase()}|${String(k.match_type ?? "")}`;
    (dupIndex.get(key) ?? dupIndex.set(key, []).get(key)!).push(keywordNodeId(k));
    keywordById.set(keywordNodeId(k), k);
  }
  const assetsByAdId = new Map<string, any[]>();
  const assetPerfByAssetId = new Map<string, any[]>();
  for (const a of assetPerf) {
    const aid = str(a.asset_id);
    if (aid) (assetPerfByAssetId.get(aid) ?? assetPerfByAssetId.set(aid, []).get(aid)!).push(a);
    const m = /~(\d+)$/.exec(String(a.ad_resource ?? ""));
    const adId = m?.[1];
    if (!adId) continue;
    (assetsByAdId.get(adId) ?? assetsByAdId.set(adId, []).get(adId)!).push(a);
  }
  return {
    adGroupsByCampaign: groupBy(adGroups, (r) => str(r.campaign_id)),
    keywordsByAdGroup: groupBy(keywords, (r) => str(r.ad_group_id)),
    adsByAdGroup: groupBy(ads, (r) => str(r.ad_group_id)),
    termsByAdGroup: groupBy(
      terms.filter((t) => t.ad_group_id != null),
      (r) => str(r.ad_group_id),
    ),
    termsByCampaignNoAdGroup: groupBy(
      terms.filter((t) => t.ad_group_id == null),
      (r) => str(r.campaign_id),
    ),
    dsaTermsByAdGroup: groupBy(dsa, (r) => str(r.ad_group_id)),
    policyByAdId: new Map(policy.map((p) => [String(p.ad_id), p] as const)),
    assetsByAdId,
    assetPerfByAssetId,
    dupIndex,
    keywordById,
    termTexts: new Set(terms.map((t) => String(t.search_term ?? "").toLowerCase())),
    keywordTexts: new Set(keywords.map((k) => String(k.text ?? "").toLowerCase())),
  };
}

/**
 * A keyword's node id: `${ad_group_id}~${keyword_id}`, Google's adGroupCriteria key. Google
 * reuses one criterion id across ad groups (the same text in an NL and a DE ad group), so the
 * criterion id alone mixes two keywords' spend and status.
 */
export function keywordNodeId(r: any): string {
  const criterion = String(r.keyword_id);
  const adGroupId = str(r.ad_group_id);
  return adGroupId ? `${adGroupId}~${criterion}` : criterion;
}

function buildKeyword(ctx: BuildCtx, r: any, adGroupId: string, index: SearchIndex): KeywordNode {
  const id = keywordNodeId(r);
  const base = nodeFromRows(ctx, "keyword", id, String(r.text ?? id), adGroupId, [r], "keywords", {
    status: r.status,
    fields: { value: "conversions_value" },
  });
  const duplicateKey = `${String(r.text ?? "").toLowerCase()}|${String(r.match_type ?? "")}`;
  return {
    ...base,
    attrs: {
      criterionId: String(r.keyword_id),
      text: String(r.text ?? ""),
      matchType: str(r.match_type),
      status: str(r.status),
      isNegative: bool(r.is_negative) === true,
      qs: num(r.quality_score),
      qsComponents: {
        expectedCtr: str(r.expected_ctr),
        adRelevance: str(r.ad_relevance),
        landingPageExperience: str(r.landing_page_experience),
      },
      cpc: num(r.cpc),
      firstPageCpc: num(r.first_page_cpc),
      firstPositionCpc: num(r.first_position_cpc),
      topOfPageCpc: num(r.top_of_page_cpc),
      impressionShare: impressionShareFrom(r, "keywords"),
      duplicateKey,
      cannibalisedBy: (index.dupIndex.get(duplicateKey) ?? []).filter((k) => k !== id),
    },
    children: { triggeredTerms: [] },
  };
}

export function buildSearchTerm(
  ctx: BuildCtx,
  r: any,
  campaignId: string,
  adGroupId: string | null,
  keywords: KeywordNode[],
  deps: SearchDeps,
  source: "searchTerms" | "dsaSearchTerms" | "productSearchTerms" | "pmaxSearchTerms",
): SearchTermNode {
  const term = String(r.search_term ?? "");
  const isDsa = source === "dsaSearchTerms";
  const id = `${source === "searchTerms" ? "" : source + ":"}${adGroupId ?? campaignId}::${term}`;
  const base = nodeFromRows(ctx, "searchTerm", id, term, adGroupId ?? campaignId, [r], source, {
    status: r.status,
  });
  const criterion = str(r.keyword_criterion_id);
  // the keyword is ad group + criterion id: its own ad group (from the term's keyword
  // resource), else the ad group that served the term
  const keywordAdGroupId = str(r.keyword_ad_group_id) ?? adGroupId;
  const matchedKeywordId =
    criterion == null ? null : keywordAdGroupId ? `${keywordAdGroupId}~${criterion}` : criterion;
  const matchType = str(r.match_type);
  const hint = keywords.find(
    (k) =>
      k.attrs.text.toLowerCase() === term.toLowerCase() &&
      (matchType == null || k.attrs.matchType === matchType),
  );
  const node: SearchTermNode = {
    ...base,
    attrs: {
      term,
      status: str(r.status),
      matchType,
      campaignId,
      adGroupId,
      matchedKeywordId,
      matchSource: criterion ? "criterion_id" : "unresolved",
      textMatchCandidateKeywordId: hint?.id ?? null,
      blocked: deps.negatives.resolveBlocked(term, campaignId),
      isDsa,
      source,
    },
  };
  if (!criterion)
    node.notCheckable.push(
      nc(
        "search_term.matched_keyword",
        "search_terms has no keyword_criterion_id — the term-to-keyword link is unresolved",
      ),
    );
  if (matchedKeywordId) {
    const kw = keywords.find((k) => k.id === matchedKeywordId);
    if (kw) kw.children.triggeredTerms.push(id);
  }
  return node;
}

function buildAd(ctx: BuildCtx, r: any, adGroupId: string, deps: SearchDeps): AdNode {
  const id = String(r.ad_id);
  // the ad's name is its type in plain words ("photo ad"): never the raw enum or the numeric id, which the
  // writer would copy into a title (V2 asks a title to name its scope); the id stays on the node and the evidence
  const base = nodeFromRows(ctx, "ad", id, adTypeWords(str(r.type)), adGroupId, [r], "ads", {
    status: r.status,
  });
  const headlines = arr(r.headlines);
  const descriptions = arr(r.descriptions);
  const hasPinKey = headlines.some((h) => h && typeof h === "object" && "pinnedField" in h);
  const finalUrls = arr(r.final_urls).map(String);
  const policyRow = deps.index.policyByAdId.get(id);
  const assets: AssetNode[] = (deps.index.assetsByAdId.get(id) ?? []).map((a) => ({
    ...nodeFromRows(
      ctx,
      "asset",
      `${id}:${a.asset_id}`,
      str(a.asset_text) ?? String(a.asset_id),
      id,
      [a],
      "assetPerformance",
    ),
    attrs: {
      surface: "rsa",
      fieldType: str(a.field_type),
      performanceLabel: str(a.performance_label),
      assetPerformanceLabel: str(a.performance_label),
      text: str(a.asset_text),
      assetResource: str(a.asset_resource),
      primaryStatus: null,
      primaryStatusDetails: null,
      assetType: null,
      imageUrl: null,
      imageWidthPx: null,
      imageHeightPx: null,
      imageAspectRatio: null,
      mimeType: null,
      videoTitle: null,
      assetSource: null,
    },
  }));
  const landingPages: LandingPageNode[] = [];
  for (const u of finalUrls)
    for (const lp of deps.landingPages.byKey.get(pageKeyOf(u)) ?? []) {
      landingPages.push(lp);
      lp.attrs.adIds.push(id);
    }
  const node: AdNode = {
    ...base,
    attrs: {
      type: str(r.type),
      status: str(r.status),
      headlineCount: headlines.length,
      descriptionCount: descriptions.length,
      pinnedCount: hasPinKey
        ? headlines.filter((h) => h?.pinnedField).length +
          descriptions.filter((d) => d?.pinnedField).length
        : null,
      finalUrls,
      policy: policyRow
        ? {
            approvalStatus: str(policyRow.approval_status),
            reviewStatus: str(policyRow.review_status),
            policyTopics: arr(policyRow.policy_topics),
          }
        : null,
    },
    children: { assets, landingPages },
  };
  if (!policyRow) node.notCheckable.push(nc("ad.policy", "no ad_policy row for this ad"));
  // rule 4: attrs taken from a capped source make the node a sample too
  if (assets.some((a) => a.sample.truncated)) node.sample.truncated = true;
  if (!hasPinKey)
    node.notCheckable.push(nc("ad.pinning", "pinnedField not stored in ads.headlines JSON"));
  if (assets.length === 0)
    node.notCheckable.push(nc("ad.asset_labels", "no asset_performance rows for this ad"));
  return node;
}

export function buildAdGroups(
  ctx: BuildCtx,
  campaign: CampaignNode,
  deps: SearchDeps,
): AdGroupNode[] {
  const rows = deps.index.adGroupsByCampaign.get(campaign.id) ?? [];
  const out: AdGroupNode[] = [];
  for (const r of rows) {
    const id = String(r.ad_group_id);
    const base = nodeFromRows(
      ctx,
      "adGroup",
      id,
      String(r.name ?? id),
      campaign.id,
      [r],
      "adGroups",
      { status: r.status },
    );
    const kwRows = deps.index.keywordsByAdGroup.get(id) ?? [];
    const keywords = kwRows.map((k) => buildKeyword(ctx, k, id, deps.index));
    const positives = keywords.filter((k) => !k.attrs.isNegative);
    const searchTerms = [
      ...(deps.index.termsByAdGroup.get(id) ?? []).map((t) =>
        buildSearchTerm(ctx, t, campaign.id, id, positives, deps, "searchTerms"),
      ),
      ...(deps.index.dsaTermsByAdGroup.get(id) ?? []).map((t) =>
        buildSearchTerm(ctx, t, campaign.id, id, positives, deps, "dsaSearchTerms"),
      ),
    ];
    const adRows = deps.index.adsByAdGroup.get(id) ?? [];
    const ads = adRows.map((a) => buildAd(ctx, a, id, deps));
    const node: AdGroupNode = {
      ...base,
      attrs: {
        campaignId: campaign.id,
        impressionShare: impressionShareFrom(r, "ad_groups"),
        adsCount: ads.length,
        rsaCount: ads.filter((a) => a.attrs.type === "RESPONSIVE_SEARCH_AD").length,
        keywordCount: positives.length,
        negativeKeywordCount: keywords.length - positives.length,
      },
      children: {
        keywords,
        searchTerms,
        ads,
        extensions: deps.extensions.byAdGroup.get(id) ?? [],
        audiences: deps.slices.adGroupDemographics(id, campaign.id, id),
        productGroups: null,
      },
    };
    node.notCheckable.push(
      nc("ad_group.product_groups", "Shopping product groups are not synced (no table)"),
    );
    if (node.windows.m90.value == null)
      node.notCheckable.push(nc("ad_group.value", "ad_groups carries no conversion_value column"));
    for (const c of [...keywords, ...searchTerms, ...ads]) setShare(c, node.windows.m90);
    setShare(node, campaign.windows.m90);
    propagateTruncation(node, [...keywords, ...searchTerms, ...ads]);
    out.push(node);
  }
  // search terms with no ad group (PMax / Shopping rows without ad_group_id) are rare; keep them visible on the campaign via notCheckable
  const stray = deps.index.termsByCampaignNoAdGroup.get(campaign.id) ?? [];
  if (stray.length)
    campaign.notCheckable.push(
      nc("search_terms.no_ad_group", `${stray.length} search_terms rows carry no ad_group_id`),
    );
  return out;
}
