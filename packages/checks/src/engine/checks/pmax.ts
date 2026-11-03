// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Performance Max checks: PX01-PX03, PX05-PX10, PX14-PX21. PX11 and PX12 live in
 * crossTree.ts and PX13 in carriedIn.ts. PX07 and PX16 judge the places Display,
 * Video and Demand Gen campaigns paid for (Performance Max reports no cost per place).
 *
 * Every check reports the entity list and the numbers behind it, never a
 * summary sentence. Two exemptions that are not optional:
 *   - a feed-only asset group (no text assets) is a deliberate configuration;
 *     the asset-set checks skip it;
 *   - Performance Max has no per-asset-group budget and no device or channel
 *     bid, so no check here produces a finding whose fix would need one.
 * An asset group with no asset rows at all is UNKNOWN (feed-only by design and
 * not read look the same), never "0 headlines".
 */
import type { MetricPayload, MetricValue } from "../registry/types.js";
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import { ASSET_FLOORS, PMAX_ASSETS, scaleMoney } from "../registry/thresholds.js";
import type { AssetGroupNode } from "../model/nodes/AssetGroupNode.js";
import { assetsUnknownReason, signalsUnknownReason } from "../model/nodes/AssetGroupNode.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import type { ListingDimension, ListingGroupNode } from "../model/nodes/ListingGroupNode.js";
import { ROLLUP_IS_SAMPLE, ROLLUP_WASTED_COST_90D } from "../scoring/impact.js";
import { isGoogleOwnedPlacement, placementExclusionKey } from "../shared/placement.js";
import {
  brandListNamesFor,
  brandListStateOf,
  excludingBrandLists,
  listHoldsOwnBrand,
  ownBrandLists,
  PMAX_CATEGORIES_NOT_READ,
} from "../model/buildPmaxTree.js";
import { brandMatcherOfModel, containsBrandName } from "../model/context.js";
import {
  isLiveUnder,
  isReportable,
  liveAssetGroupsOf,
  statusOf,
} from "../registry/entityStatus.js";
import {
  isAssetRefused,
  missingExclusions,
  refusalSentence,
  SMALL_CATALOGUE_PRODUCTS,
} from "../shared/pmaxRules.js";
import {
  campaignProductLosers,
  feedStatusesOf,
  productWastePricedParents,
  type Seller,
  sellerOf,
  servedBy,
  soldOutRow,
} from "./shopping.js";
import { VOLUME_FLOOR_REASON_TAG } from "./volumeFloorGate.js";
import {
  campaignsOf,
  type CheckCtx,
  type CheckDefinition,
  type CheckFinding,
  defineCheck,
  finding,
  gateOnData,
  isOk,
  num,
  str,
} from "./types.js";

// ---------------------------------------------------------------------------
// local helpers
// ---------------------------------------------------------------------------

const pmaxCampaigns = (ctx: CheckCtx): CampaignNode[] =>
  campaignsOf(ctx).filter((c) => c.attrs.type === "PERFORMANCE_MAX");

/** every asset group of this account, with the campaign it hangs off. */
const assetGroups = (ctx: CheckCtx): { campaign: CampaignNode; group: AssetGroupNode }[] =>
  campaignsOf(ctx).flatMap((c) => c.children.assetGroups.map((group) => ({ campaign: c, group })));

const campaignScope = (c: CampaignNode) => ({
  type: "campaign" as const,
  id: c.id,
  name: c.name,
  campaignId: c.id,
  campaignName: c.name,
});
const groupScope = (c: CampaignNode, g: AssetGroupNode) => ({
  type: "asset_group" as const,
  id: g.id,
  name: g.name,
  campaignId: c.id,
  campaignName: c.name,
});

/** Live PMax campaigns whose search categories were not read: unknown, never "none". */
export const categoriesNotRead = (ctx: CheckCtx): CampaignNode[] =>
  pmaxCampaigns(ctx).filter((c) =>
    c.notCheckable.some((n) => n.checkId === PMAX_CATEGORIES_NOT_READ),
  );

/** "A, B and 3 more": a name list a sentence can carry. */
export const namesOf = (names: readonly string[], max = 5): string =>
  names.length <= max
    ? names.join(", ")
    : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;

/** One sentence on the brand lists attached to a Performance Max campaign. */
function brandListNote(c: CampaignNode): string {
  const state = brandListStateOf(c.attrs.brandExclusions);
  const names = brandListNamesFor(c.attrs.brandExclusions);
  if (state === "attached")
    return `a brand list is excluded (${names.join(", ")}); brand searches still reach the campaign, most likely through Shopping ads`;
  if (state === "contents_unknown")
    return `a brand list is excluded (${names.join(", ")}) but whether it holds your brand could not be seen`;
  if (state === "none")
    return excludingBrandLists(c.attrs.brandExclusions).length > 0
      ? `the excluded brand list(s) (${names.join(", ")}) hold other brands only, not yours`
      : "no brand list is excluded";
  return "brand exclusion lists were not checked";
}

// ---------------------------------------------------------------------------
// PX01 — PMax spending off Search/Shopping
// ---------------------------------------------------------------------------

const PX01 = defineCheck({
  id: "PX01",
  claimKey: CLAIM_KEYS.PMAX_LOW_SHOPPING_SHARE,
  title: "PMax runs mostly off Search/Shopping",
  clientLabel: "Performance Max spending mostly outside Search and Shopping",
  group: "pmax",
  metrics: ["P.shopping_share", "P.unclassified_share", "C.spend"],
  confounders: ["SH01", "PX05", "PX03"],
  requires: ["pmaxChannelDistribution"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "Each PMax campaign runs mostly on Search and Shopping.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const bar = ctx.settings.pmax.shoppingShareMinPct;
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of pmaxCampaigns(ctx)) {
      const share = ctx.get("P.shopping_share", { campaignId: c.id });
      // no channel rows, or attributable cost under the floor: never a verdict
      if (!isOk(share)) continue;
      population++;
      const unclassified = ctx.get("P.unclassified_share", { campaignId: c.id });
      const spend = ctx.get("C.spend", { campaignId: c.id });
      const pct = num(share);
      if (pct == null || pct >= bar) continue;
      // the waste is the spend Google places off Search/Shopping (Display, YouTube), never the
      // whole campaign: Search/Shopping spend and the mixed/unclassified remainder are not in it
      const offShopping = c.children.channels
        .filter((ch) => ch.attrs.classification === "video_display")
        .reduce((t, ch) => t + (ch.windows.m90.cost ?? 0), 0);
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [share, unclassified, spend].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: {
            shopping_share_pct: pct,
            unclassified_share_pct: num(unclassified),
            wasted_cost_90d: offShopping,
            // priced on that spend, not on the campaign's (C.spend is its basis otherwise)
            [ROLLUP_WASTED_COST_90D]: Number(offShopping.toFixed(2)),
            ...(share.sample.truncated ? { [ROLLUP_IS_SAMPLE]: 1 } : {}),
            "C.spend": num(spend),
          },
          population,
          // the shares are only honest with the remainder printed beside them
          note: `share Google reports as mixed or unclassified: ${num(unclassified)?.toFixed(2) ?? "n/a"}%`,
        }),
      );
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no PMax campaign has a channel split above the cost floor",
        table: "pmaxChannelDistribution",
        category: "not_present",
      };
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note: `${population} PMax campaign(s) at or above the ${bar}% bar`,
        };
  },
});

// ---------------------------------------------------------------------------
// PX02 — brand leaking into PMax
// ---------------------------------------------------------------------------

/**
 * The campaign's return with and without its brand searches, from the PMax
 * search terms with cost. Google hides part of PMax searches, so the brand
 * figures are a floor, never a total. null = no PMax term rows or no brand
 * search among them.
 */
function pmaxReturnWithoutBrand(
  c: CampaignNode,
  isBrand: ((t: string) => boolean) | null,
): Record<string, number | null> | null {
  if (!isBrand) return null;
  const terms = c.children.searchTerms.filter((t) => t.attrs.source === "pmaxSearchTerms");
  const brand = terms.filter((t) => isBrand(t.attrs.term));
  if (brand.length === 0) return null;
  const cost = c.windows.m90.cost ?? 0;
  const value = c.windows.m90.value ?? 0;
  if (cost <= 0) return null;
  const bCost = brand.reduce((s, t) => s + (t.windows.m90.cost ?? 0), 0);
  const valueKnown = brand.every((t) => t.windows.m90.conv != null && t.windows.m90.value != null);
  const bValue = brand.reduce((s, t) => s + (t.windows.m90.value ?? 0), 0);
  const termCost = terms.reduce((s, t) => s + (t.windows.m90.cost ?? 0), 0);
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  return {
    pmax_roas_with_brand: r2(value / cost),
    pmax_roas_without_brand:
      valueKnown && cost - bCost > 0 ? r2(Math.max(0, value - bValue) / (cost - bCost)) : null,
    brand_search_spend_90d: r2(bCost),
    brand_search_value_90d: valueKnown ? r2(bValue) : null,
    search_terms_share_of_spend_pct: Math.round((termCost / cost) * 100),
    brand_search_is_sample: 1,
  };
}

const PX02 = defineCheck({
  id: "PX02",
  claimKey: CLAIM_KEYS.PMAX_BRAND_LEAK,
  title: "PMax search categories are mostly brand",
  clientLabel: "Performance Max living off searches for your own brand",
  group: "pmax",
  metrics: ["P.brand_theme_click_share"],
  confounders: ["AS01", "SK07"],
  requires: ["pmaxSearchInsights"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "PMax search categories are mostly not brand.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const bar = ctx.settings.pmax.brandLeakPct;
    const matcher = brandMatcherOfModel(ctx.model);
    // without the brand names a brand category cannot be told from any other: never clean
    if (!matcher)
      return {
        state: "not_checkable",
        reason: "no brand names were given, so brand search categories cannot be told apart",
        category: "needs_client_input",
      };
    const isBrandSearch = (t: string) => containsBrandName(t, matcher);
    const unread = categoriesNotRead(ctx);
    const unreadNote =
      unread.length > 0
        ? `the search categories of ${namesOf(unread.map((c) => c.name))} were not read`
        : null;
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of pmaxCampaigns(ctx)) {
      const share = ctx.get("P.brand_theme_click_share", { campaignId: c.id });
      if (!isOk(share)) continue;
      population++;
      const pct = num(share);
      if (pct == null || pct <= bar) continue;
      const listState = brandListStateOf(c.attrs.brandExclusions);
      const ownLists = ownBrandLists(c.attrs.brandExclusions);
      const listNames = brandListNamesFor(c.attrs.brandExclusions);
      const exBrand = pmaxReturnWithoutBrand(c, isBrandSearch);
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [share],
          entity: { id: c.id, name: c.name },
          facts: {
            brand_click_share_pct: pct,
            ...(exBrand ?? {}),
            "C.spend": num(ctx.get("C.spend", { campaignId: c.id })),
            brand_list_state: listState,
            ...(listState !== "not_checked" ? { brand_lists_attached_count: ownLists.length } : {}),
            ...(listNames.length > 0 ? { brand_list_names: listNames.join(" | ") } : {}),
          },
          population,
          note: `search categories are Google's top categories per campaign, a sample; ${brandListNote(c)}${exBrand ? `; return ${exBrand.pmax_roas_with_brand} with brand searches, ${exBrand.pmax_roas_without_brand ?? "unknown"} without (search terms are a sample, ${exBrand.search_terms_share_of_spend_pct}% of spend)` : ""}`,
        }),
      );
    }
    if (findings.length > 0) {
      if (unreadNote)
        for (const f of findings)
          f.limitedBy = [
            `${unreadNote.charAt(0).toUpperCase()}${unreadNote.slice(1)}, so they may take brand searches too.`,
          ];
      return { state: "fires", findings };
    }
    // a campaign whose categories were not read is unknown: never clean
    if (unreadNote)
      return {
        state: "not_checkable",
        reason: `${unreadNote} (one query per campaign, a limited number per snapshot)${population > 0 ? `; ${population} campaign(s) read are under the ${bar}% bar` : ""}`,
        table: "pmaxSearchInsights",
        category: "our_gap",
      };
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no PMax campaign has search category rows with clicks",
        table: "pmaxSearchInsights",
        category: "not_present",
      };
    return {
      state: "none_found",
      population,
      note: `${population} PMax campaign(s) at or under the ${bar}% bar, on each campaign's top search categories`,
    };
  },
});

// ---------------------------------------------------------------------------
// PX03 — asset group short of a full asset set
// ---------------------------------------------------------------------------

/** The legs the read can answer; a leg with no count (unknown) is not judged. */
function assetLegs(minHeadlines: number): { field: string; target: number; label: string }[] {
  return [
    { field: "HEADLINE", target: minHeadlines, label: "headlines" },
    { field: "LONG_HEADLINE", target: PMAX_ASSETS.maxLongHeadlines, label: "long headlines" },
    { field: "DESCRIPTION", target: PMAX_ASSETS.recommendedDescriptions, label: "descriptions" },
    { field: "YOUTUBE_VIDEO", target: PMAX_ASSETS.minVideos, label: "videos" },
  ];
}

const PX03 = defineCheck({
  id: "PX03",
  claimKey: CLAIM_KEYS.PMAX_ASSET_GROUP_INCOMPLETE,
  title: "asset group below a full Performance Max asset set",
  clientLabel: "Performance Max asset groups missing headlines, descriptions or videos",
  group: "pmax",
  metrics: ["P.ag_asset_count(field)", "P.ag_gap(field)"],
  confounders: ["PX09", "PX06"],
  requires: ["assetGroups", "pmaxAssets"],
  needsCompleteData: ["pmaxAssets"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each asset group carries a full asset set.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const legs = assetLegs(ctx.settings.pmax.minHeadlines);
    const all = assetGroups(ctx);
    if (all.length === 0)
      return {
        state: "not_checkable",
        reason: "no asset group joins a campaign of this account",
        table: "assetGroups",
        category: "not_present",
      };
    const unknown = all.filter(({ group }) => !group.attrs.assetsKnown);
    if (unknown.length === all.length)
      return {
        state: "not_checkable",
        reason: `all ${all.length} asset groups: ${assetsUnknownReason()}`,
        table: "pmaxAssets",
      };
    const known = all.filter(({ group }) => group.attrs.assetsKnown);
    const judged = known.filter(({ group }) => group.attrs.isFeedOnly === false);
    const unknownNote =
      unknown.length > 0
        ? `; ${unknown.length} asset group(s) not checkable — ${assetsUnknownReason()}`
        : "";
    if (judged.length === 0)
      return {
        state: "not_checkable",
        reason: `all ${known.length} asset groups with known assets are feed-only by design; there is no uploaded asset set to judge${unknownNote}`,
        table: "pmaxAssets",
        category: "not_present",
      };
    const findings: CheckFinding[] = [];
    for (const { campaign, group } of judged) {
      const cite: MetricValue[] = [];
      const gaps: Record<string, number> = {};
      for (const leg of legs) {
        const count = ctx.get("P.ag_asset_count(field)", {
          assetGroupId: group.id,
          field: leg.field,
        });
        if (!isOk(count)) continue;
        cite.push(count);
        const have = num(count) ?? 0;
        if (have < leg.target) gaps[leg.label] = leg.target - have;
      }
      if (Object.keys(gaps).length === 0) continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: groupScope(campaign, group),
          cite,
          entity: { id: group.id, name: group.name },
          facts: { gaps: gaps as unknown as MetricPayload, feed_only: false },
          population: judged.length,
          note: `the logo is not judged (it can be set at campaign level)${unknownNote}`,
        }),
      );
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: judged.length,
          note: `${known.length - judged.length} feed-only asset groups excluded by design${unknownNote}`,
        };
  },
});

// ---------------------------------------------------------------------------
// PX06 — asset group with spend and no signals
// ---------------------------------------------------------------------------

const PX06 = defineCheck({
  id: "PX06",
  claimKey: CLAIM_KEYS.PMAX_SIGNALS_MISSING,
  title: "asset group with spend carries no search themes or no audience signals",
  clientLabel: "Performance Max asset groups running without search themes or audience signals",
  group: "pmax",
  metrics: ["P.ag_search_themes", "P.ag_audience_signals"],
  confounders: ["PX03", "PX09"],
  requires: ["pmaxSignals", "assetGroups"],
  needsCompleteData: ["pmaxSignals"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each asset group carries audience signals and search themes.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const spendingAll = assetGroups(ctx).filter(({ group }) => (group.windows.m90.cost ?? 0) > 0);
    if (spendingAll.length === 0)
      return {
        state: "not_checkable",
        reason: "no asset group with spend joins a campaign of this account",
        table: "assetGroups",
        category: "not_present",
      };
    // a group with no signal row of either kind (and no sibling with one) is unknown
    const unknown = spendingAll.filter(({ group }) => !group.attrs.signalsKnown);
    const spending = spendingAll.filter(({ group }) => group.attrs.signalsKnown);
    const unknownNote =
      unknown.length > 0
        ? `; ${unknown.length} spending asset group(s) not checkable — ${signalsUnknownReason()}`
        : "";
    if (spending.length === 0)
      return {
        state: "not_checkable",
        reason: `all ${spendingAll.length} spending asset groups: ${signalsUnknownReason()}`,
        table: "pmaxSignals",
      };
    const findings: CheckFinding[] = [];
    for (const { campaign, group } of spending) {
      const themes = ctx.get("P.ag_search_themes", { assetGroupId: group.id });
      const audiences = ctx.get("P.ag_audience_signals", { assetGroupId: group.id });
      if (!isOk(themes) || !isOk(audiences)) continue;
      const t = num(themes) ?? 0;
      const a = num(audiences) ?? 0;
      if (t > 0 && a > 0) continue;
      const missing = [t === 0 ? "search themes" : null, a === 0 ? "audience signals" : null]
        .filter(Boolean)
        .join(" and ");
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: groupScope(campaign, group),
          cite: [themes, audiences],
          entity: { id: group.id, name: group.name },
          facts: { search_themes: t, audience_signals: a },
          population: spending.length,
          note: `no ${missing}${unknownNote}`,
        }),
      );
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population: spending.length,
          ...(unknownNote ? { note: unknownNote.slice(2) } : {}),
        };
  },
});

// ---------------------------------------------------------------------------
// asset automation: what Google returns, and the documented Performance Max defaults
// ---------------------------------------------------------------------------

const FINAL_URL_EXPANSION = "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION";

/**
 * Performance Max defaults where Google's v26 reference states one
 * (https://developers.google.com/google-ads/api/reference/rpc/v26/AssetAutomationTypeEnum.AssetAutomationType):
 * final URL expansion and text asset automation are ON for Performance Max, enhanced YouTube
 * videos and image enhancement are opted in, the automated video crawl is off
 * (https://developers.google.com/google-ads/api/docs/assets/asset-automation-settings).
 * GENERATE_IMAGE_EXTRACTION follows an account-level control the snapshot does not read, so a
 * missing entry for it is unknown.
 */
const PMAX_AUTOMATION_DEFAULTS: Readonly<Record<string, "OPTED_IN" | "OPTED_OUT">> = {
  [FINAL_URL_EXPANSION]: "OPTED_IN",
  TEXT_ASSET_AUTOMATION: "OPTED_IN",
  GENERATE_ENHANCED_YOUTUBE_VIDEOS: "OPTED_IN",
  GENERATE_IMAGE_ENHANCEMENT: "OPTED_IN",
  AUTOMATED_VIDEO_CRAWL: "OPTED_OUT",
};
const UNKNOWN_WHEN_MISSING = ["GENERATE_IMAGE_EXTRACTION"];

/**
 * A PMax campaign's asset automations as they apply: Google's entry, else the documented
 * default. null = the automation settings were not read for this campaign.
 */
function automationOf(c: CampaignNode): {
  optedIn: string[];
  byDefault: string[];
  unknown: string[];
} | null {
  const s = c.attrs.controlSettings;
  if (!s || !Array.isArray(s.assetAutomation)) return null;
  const explicit = new Map<string, string>();
  for (const x of s.assetAutomation as any[]) {
    const type = String(x?.asset_automation_type ?? x?.type ?? "").toUpperCase();
    const status = String(x?.asset_automation_status ?? x?.status ?? "").toUpperCase();
    if (type) explicit.set(type, status);
  }
  const optedIn = [...explicit].filter(([, st]) => st === "OPTED_IN").map(([t]) => t);
  const byDefault = Object.entries(PMAX_AUTOMATION_DEFAULTS)
    .filter(([t, st]) => !explicit.has(t) && st === "OPTED_IN")
    .map(([t]) => t);
  const unknown = UNKNOWN_WHEN_MISSING.filter((t) => !explicit.has(t));
  return { optedIn: optedIn.sort(), byDefault, unknown };
}

/** Final URL expansion on a PMax campaign: Google's entry, else ON (the documented default). */
function expansionOf(c: CampaignNode): "on" | "off" | "unknown" {
  const a = automationOf(c);
  if (!a) return "unknown";
  if (a.optedIn.includes(FINAL_URL_EXPANSION) || a.byDefault.includes(FINAL_URL_EXPANSION))
    return "on";
  return "off";
}

// ---------------------------------------------------------------------------
// PX08 — auto-generated assets left on (a note)
// ---------------------------------------------------------------------------

const PX08 = defineCheck({
  id: "PX08",
  claimKey: CLAIM_KEYS.PMAX_AUTO_ASSETS_ON,
  title: "auto-generated assets opted in on a PMax campaign",
  clientLabel: "Performance Max allowed to write and make its own ads",
  group: "pmax",
  metrics: ["C.auto_assets_optin"],
  confounders: [],
  requires: ["campaign_control_settings"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Auto-generated assets are off on the PMax campaigns.",
  noteOnly:
    "Google may write text, make images or videos, or enhance assets for this Performance Max campaign, so some ad wording may be Google's, not the brand's.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const findings: CheckFinding[] = [];
    let population = 0;
    const undecided: string[] = [];
    const pmax = pmaxCampaigns(ctx);
    for (const c of pmax) {
      const a = automationOf(c);
      // no control-settings row for this campaign: unknown, never "off"
      if (!a) continue;
      const on = [...a.optedIn, ...a.byDefault];
      if (on.length === 0) {
        // nothing on that we know of; a type left to an account control we did not read is unknown
        if (a.unknown.length > 0) undecided.push(c.name);
        else population++;
        continue;
      }
      population++;
      const optin = ctx.get("C.auto_assets_optin", { campaignId: c.id });
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [optin].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: {
            opted_in_types: on.join(", "),
            ...(a.byDefault.length > 0 ? { on_by_google_default: a.byDefault.join(", ") } : {}),
          },
          population,
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };
    if (undecided.length > 0)
      return {
        state: "not_checkable",
        reason: `image extraction on ${namesOf(undecided)} follows an account-level setting that is not read, and every other automation is off`,
        table: "campaign_control_settings",
        category: "our_gap",
      };
    if (population === 0)
      return {
        state: "not_checkable",
        reason:
          pmax.length === 0
            ? "no PMax campaign on this account"
            : "the asset automation settings of the PMax campaigns were not read",
        table: "campaign_control_settings",
        category: pmax.length === 0 ? "not_present" : "our_gap",
      };
    return { state: "none_found", population };
  },
});

// ---------------------------------------------------------------------------
// PX09 — asset groups Google rates POOR or AVERAGE
// ---------------------------------------------------------------------------

const WEAK_STRENGTH = new Set(["POOR", "AVERAGE"]);

const PX09 = defineCheck({
  id: "PX09",
  claimKey: CLAIM_KEYS.PMAX_AD_STRENGTH_POOR,
  title: "asset groups rated POOR or AVERAGE",
  clientLabel: "Performance Max asset groups Google rates poor or average",
  group: "pmax",
  metrics: ["P.ag_ad_strength", "P.ag_clicks"],
  confounders: ["PX03", "PX06"],
  requires: ["assetGroups"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each live asset group rates Good or better.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    // one account-scoped finding carries the group list, so switched-off groups and the click
    // floor are filtered here (no per-group finding exists for the gates to drop)
    const live = assetGroups(ctx)
      .filter(({ group }) => (group.windows.m90.cost ?? 0) > 0)
      .filter(({ campaign, group }) => isLiveUnder(group, campaign));
    // a feed-only group is rated POOR on purpose, and a group with no asset rows is unknown
    const spending = live.filter(
      ({ group }) => group.attrs.assetsKnown && group.attrs.isFeedOnly !== true,
    );
    if (spending.length === 0) {
      return live.length > 0
        ? {
            state: "not_checkable",
            reason: `the ${live.length} live spending asset group(s) are feed-only (or carry no assets that were read), so an ad-strength rating says nothing about their creative`,
            table: "pmaxAssets",
            category: "not_present",
          }
        : {
            state: "not_checkable",
            reason: "no live asset group with spend",
            table: "assetGroups",
            category: "not_present",
          };
    }
    const judged = spending.filter(({ group }) => {
      const clicks = num(ctx.get("P.ag_clicks", { assetGroupId: group.id }));
      return clicks == null || clicks >= ASSET_FLOORS.pmaxAssetClicks;
    });
    const thin = spending.length - judged.length;
    if (judged.length === 0) {
      return {
        state: "not_checkable",
        reason: `${VOLUME_FLOOR_REASON_TAG}: none of the ${spending.length} spending asset groups has had ${ASSET_FLOORS.pmaxAssetClicks} clicks, and an asset-set rating on less traffic than that is not a verdict`,
        category: "thin_data",
      };
    }
    const cite: MetricValue[] = [];
    const weak: { id: string; name: string; strength: string; campaignId: string }[] = [];
    let rated = 0;
    for (const { campaign, group } of judged) {
      const strength = ctx.get("P.ag_ad_strength", { assetGroupId: group.id });
      if (!isOk(strength)) continue;
      rated++;
      const value = (str(strength) ?? "").toUpperCase();
      if (!WEAK_STRENGTH.has(value)) continue;
      cite.push(strength);
      const clicks = ctx.get("P.ag_clicks", { assetGroupId: group.id });
      if (isOk(clicks)) cite.push(clicks);
      weak.push({ id: group.id, name: group.name, strength: value, campaignId: campaign.id });
    }
    if (rated === 0)
      return {
        state: "not_checkable",
        reason: "Google gave no ad strength on any spending asset group",
        table: "assetGroups",
      };
    const thinNote =
      thin > 0
        ? `; ${thin} asset group(s) not judged — under ${ASSET_FLOORS.pmaxAssetClicks} clicks`
        : "";
    if (weak.length === 0)
      return {
        state: "none_found",
        population: rated,
        note: `${rated} asset groups rated${thinNote}`,
      };
    const poor = weak.filter((w) => w.strength === "POOR").length;
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: this.claimKey,
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite,
          facts: {
            asset_groups_weak: weak.length,
            asset_groups_rated: rated,
            poor,
            average: weak.length - poor,
            groups: weak.map((w) => `${w.id}:${w.strength}`).join(", "),
          },
          population: rated,
          rows: weak.map((w) => ({
            entity: { id: w.id, name: w.name },
            cells: { ad_strength: w.strength },
          })),
          note: `${weak.length} of ${rated} spending asset groups rate POOR or AVERAGE${thinNote}`,
        }),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// PX10 — final URL expansion on / PX20 — and legal pages not excluded
// ---------------------------------------------------------------------------

const PX10 = defineCheck({
  id: "PX10",
  claimKey: CLAIM_KEYS.PMAX_URL_EXPANSION_ON,
  title: "final URL expansion on a PMax campaign",
  clientLabel: "final URL expansion on Performance Max",
  group: "pmax",
  metrics: ["C.url_expansion_opt_out"],
  confounders: ["PX01"],
  requires: ["campaigns", "campaign_control_settings"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Final URL expansion is off on the Performance Max campaigns.",
  noteOnly:
    "Final URL expansion is on: Google may send clicks to any page of the site, not only the final URLs given.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const campaigns = pmaxCampaigns(ctx);
    if (campaigns.length === 0)
      return {
        state: "not_checkable",
        reason: "no PMax campaign in this account",
        table: "campaigns",
        category: "not_present",
      };
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of campaigns) {
      // no entry = Google's documented default for Performance Max (on); settings not read = unknown
      const state = expansionOf(c);
      if (state === "unknown") continue;
      population++;
      if (state !== "on") continue;
      const optOut = ctx.get("C.url_expansion_opt_out", { campaignId: c.id });
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [optOut].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: {
            url_expansion_opt_out: false,
            ...(isOk(optOut) ? {} : { on_by_google_default: true }),
          },
          population,
        }),
      );
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: `the asset automation settings of the ${campaigns.length} PMax campaign(s) were not read, so final URL expansion is unknown`,
        table: "campaign_control_settings",
        category: "our_gap",
      };
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

/** How many missing patterns a finding note names before "and N more". */
const PX20_NOTE_PATTERNS = 6;

const PX20 = defineCheck({
  id: "PX20",
  claimKey: CLAIM_KEYS.PMAX_URL_EXCLUSIONS_MISSING,
  title: "final URL expansion can send paid clicks to legal and contact pages",
  clientLabel: "Performance Max sending paid clicks to legal and contact pages",
  group: "pmax",
  metrics: ["C.url_expansion_opt_out"],
  confounders: [],
  requires: ["campaigns", "campaign_control_settings"],
  needsCompleteData: ["campaign_control_settings"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans:
    "Your live Performance Max campaigns with final URL expansion on already exclude legal and contact pages.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const live = pmaxCampaigns(ctx).filter(isReportable);
    if (live.length === 0)
      return {
        state: "not_checkable",
        reason: "no live PMax campaign in this account",
        table: "campaigns",
        category: "not_present",
      };
    const findings: CheckFinding[] = [];
    let population = 0;
    let on = 0;
    for (const c of live) {
      const optOut = ctx.get("C.url_expansion_opt_out", { campaignId: c.id });
      // expansion unknown or off: nothing to judge (PX10 owns "expansion is on")
      if (expansionOf(c) !== "on") continue;
      on++;
      const existing = c.attrs.controlSettings?.urlExclusions;
      // null = the exclusions were not read, never "none set"
      if (existing == null) continue;
      population++;
      const missing = missingExclusions(existing);
      if (missing.length === 0) continue;
      const labels = missing.map((r) => r.label);
      const named =
        labels.slice(0, PX20_NOTE_PATTERNS).join(", ") +
        (labels.length > PX20_NOTE_PATTERNS
          ? ` and ${labels.length - PX20_NOTE_PATTERNS} more`
          : "");
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [optOut].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: {
            url_expansion_opt_out: false,
            existing_url_exclusions: existing.length,
            missing_url_exclusions: missing.length,
            missing_url_patterns: missing.map((r) => r.fragment).join(", "),
          },
          population,
          note: `not excluded yet: ${named}`,
        }),
      );
    }
    if (on === 0)
      return {
        state: "not_checkable",
        reason:
          "final URL expansion is off (or unknown) on every live PMax campaign, so no page can be reached by expansion",
        table: "campaign_control_settings",
        category: "not_present",
      };
    if (population === 0)
      return {
        state: "not_checkable",
        reason: `the URL exclusions of the ${on} live PMax campaign(s) with expansion on were not read`,
        table: "campaign_control_settings",
        category: "our_gap",
      };
    if (findings.length === 0)
      return {
        state: "none_found",
        population,
        note: `${population} live PMax campaign(s) with expansion on exclude every legal and contact page on the list`,
      };
    return { state: "fires", findings };
  },
});

// ---------------------------------------------------------------------------
// PX14 — one asset group carries most of a campaign's money
// ---------------------------------------------------------------------------

/** Fewer groups than this and "most are paused" is a two-group campaign, not a shape. */
const AG_SHAPE_MIN_GROUPS = 2;

/** PX14: the label when the busy group is the campaign's only live group (the rest paused). */
export const PX14_TITLE_ONE_LIVE =
  "a PMax campaign runs on one live asset group, every other group paused";

const PX14 = defineCheck({
  id: "PX14",
  claimKey: CLAIM_KEYS.PMAX_ASSET_GROUP_SPEND_CONCENTRATION,
  title: "one asset group carries most of a PMax campaign's spend",
  clientLabel: "one asset group carrying most of a Performance Max campaign's spend",
  group: "pmax",
  metrics: ["P.ag_top_spend_share", "P.ag_spend", "C.spend"],
  // corroborating symptoms (PX03, PX06) never block this claim, so none are declared
  confounders: [],
  requires: ["assetGroups"],
  needsCompleteData: ["assetGroups"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans:
    "Where a PMax campaign's spend sits in one asset group, that group earns at least as much per unit of spend as the live groups beside it.",
  judges: {
    assetGroups: "all",
    campaigns: "spending",
    because:
      "concentration is a claim about where money went, so only campaigns that spent can carry it",
  },
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const p = ctx.settings.pmax;
    const minSpend = scaleMoney(p.shapeMinSpendUsd, ctx.currency);
    if (minSpend == null)
      return {
        state: "insufficient_data",
        reason:
          "the account currency is unknown, so the spend bar for judging a campaign's shape is skipped",
      };
    const findings: CheckFinding[] = [];
    let population = 0;
    let notJudgeable = 0;
    let earning = 0;
    for (const c of pmaxCampaigns(ctx)) {
      const groups = c.children.assetGroups;
      const spend = c.windows.m90.cost ?? 0;
      if (groups.length < AG_SHAPE_MIN_GROUPS) continue; // one group IS the campaign
      if (spend < minSpend) continue;
      const share = ctx.get("P.ag_top_spend_share", { campaignId: c.id });
      if (!isOk(share)) continue;
      population++;
      const pct = num(share);
      if (pct == null || pct < p.topGroupSharePct) continue;
      const ranked = [...groups].sort(
        (a, b) => (b.windows.m90.cost ?? 0) - (a.windows.m90.cost ?? 0) || a.id.localeCompare(b.id),
      );
      const top = ranked[0]!;
      // concentration alone is the machine working; the fault is concentration that costs something
      const liveRest = ranked
        .slice(1)
        .filter((g) => String(g.status ?? "").toUpperCase() === "ENABLED");
      const pausedSiblings = ranked
        .slice(1)
        .filter((g) => String(g.status ?? "").toUpperCase() === "PAUSED");
      const rows = ranked.map((g) => ({
        entity: { id: g.id, name: g.name },
        cells: {
          status: String(g.status ?? "UNKNOWN"),
          spend: g.windows.m90.cost ?? 0,
          share_of_campaign_pct: spend > 0 ? ((g.windows.m90.cost ?? 0) / spend) * 100 : 0,
        },
      }));
      const restCost = liveRest.reduce((n, g) => n + (g.windows.m90.cost ?? 0), 0);
      // a live busy group with paused siblings and nothing else learning: a risk of its own
      const concentrationOnly = (): void => {
        if (String(top.status ?? "").toUpperCase() !== "ENABLED" || pausedSiblings.length === 0)
          return;
        const topCost = top.windows.m90.cost ?? 0;
        const accountCost = ctx.model.windows.m90.cost ?? 0;
        const accountSharePct = accountCost > 0 ? (topCost / accountCost) * 100 : 0;
        const otherLive = spend > 0 ? (restCost / spend) * 100 : 0;
        findings.push({
          ...finding({
            claimKey: this.claimKey,
            scope: groupScope(c, top),
            cite: [
              share,
              ctx.get("P.ag_spend", { assetGroupId: top.id }),
              ctx.get("C.spend", { campaignId: c.id }),
            ].filter(isOk),
            entity: { id: top.id, name: top.name },
            facts: {
              top_group_share_pct: pct,
              asset_groups: groups.length,
              paused_groups: pausedSiblings.length,
              live_groups: 1 + liveRest.length,
              other_live_share_pct: otherLive,
              top_group_account_share_pct: accountSharePct,
              concentration_only: true,
            },
            population,
            rows,
            note:
              liveRest.length > 0
                ? `one group carries ${pct.toFixed(1)}% of the campaign's spend; the other ${liveRest.length} live group(s) get only ${otherLive.toFixed(1)}%`
                : `one live group carries ${pct.toFixed(1)}% of the campaign's spend with ${pausedSiblings.length} group(s) paused beside it — no fallback if it falters`,
          }),
          ...(accountSharePct < p.topGroupWarnAccountPct ? { maxSeverity: "info" as const } : {}),
          // R4 wording: with every other group paused there is one live group, not one group
          // out-spending live siblings
          ...(liveRest.length === 0 ? { title: PX14_TITLE_ONE_LIVE } : {}),
        });
      };
      const restValue = liveRest.reduce((n, g) => n + (g.windows.m90.value ?? 0), 0);
      const restConv = liveRest.reduce((n, g) => n + (g.windows.m90.conv ?? 0), 0);
      const topRoas = top.windows.m90.roas;
      const restRoas = restCost > 0 ? restValue / restCost : null;
      if (topRoas == null || restRoas == null || restCost <= 0 || liveRest.length === 0) {
        notJudgeable++;
        concentrationOnly();
        continue;
      }
      if (restConv < ctx.settings.floors.strongConv) {
        notJudgeable++;
        concentrationOnly();
        continue;
      }
      // multiplicative: a busy group that returned ZERO beside earning siblings must fire
      const materiallyBetter = restRoas > topRoas * (1 + p.siblingBetterPct / 100);
      if (!materiallyBetter) {
        earning++;
        concentrationOnly();
        continue;
      }
      const gapPct = topRoas > 0 ? ((restRoas - topRoas) / topRoas) * 100 : null;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: groupScope(c, top),
          cite: [
            share,
            ctx.get("P.ag_spend", { assetGroupId: top.id }),
            ctx.get("C.spend", { campaignId: c.id }),
          ].filter(isOk),
          entity: { id: top.id, name: top.name },
          facts: {
            top_group_share_pct: pct,
            asset_groups: groups.length,
            top_group_roas: topRoas,
            starved_groups_roas: restRoas,
            starved_groups_spend: restCost,
            starved_groups_conversions: restConv,
            ...(gapPct != null ? { roas_gap_pct: gapPct } : {}),
          },
          population,
          rows,
          note: `the ${liveRest.length} group(s) still running beside it returned ${restRoas.toFixed(2)}x on ${restCost.toFixed(2)}`,
        }),
      );
    }
    if (population === 0) {
      return {
        state: "not_checkable",
        reason: `no PMax campaign has more than one asset group and at least ${minSpend.toFixed(0)} of spend, so concentration cannot be judged`,
        table: "assetGroups",
        category: "not_present",
      };
    }
    if (findings.length > 0) return { state: "fires", findings };
    // "could not judge it" is not "judged it clean"
    if (notJudgeable > 0) {
      return {
        state: "not_checkable",
        reason: `${notJudgeable} PMax campaign(s) put most of their spend in one asset group, and no live sibling carries the ${ctx.settings.floors.strongConv} conversions needed to say whether that cost anything`,
        table: "assetGroups",
        category: "thin_data",
      };
    }
    return {
      state: "none_found",
      population,
      note:
        earning > 0
          ? `${earning} concentrated onto a group that returns at least as much as its live siblings`
          : undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// PX17 — PMax assets Google has disapproved
// ---------------------------------------------------------------------------

const PX17_ROWS = 10;

const PX17 = defineCheck({
  id: "PX17",
  claimKey: CLAIM_KEYS.PMAX_ASSETS_REFUSED,
  title: "PMax assets Google has disapproved",
  clientLabel: "Performance Max images and text Google has refused to show",
  group: "pmax",
  metrics: ["C.spend"],
  confounders: [],
  requires: ["assetGroups", "pmaxAssets"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans:
    "Google has refused none of the images or text in your live Performance Max asset groups.",
  judges: {
    assetGroups: "enabled",
    campaigns: "reportable",
    because:
      "a paused campaign reports every asset as not serving, so only live groups in live campaigns can carry the claim",
  },
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const judged = pmaxCampaigns(ctx)
      .filter(isReportable)
      .flatMap((campaign) =>
        campaign.children.assetGroups
          .filter(
            (group) =>
              String(group.status ?? "").toUpperCase() === "ENABLED" && group.attrs.assetsKnown,
          )
          .map((group) => ({ campaign, group })),
      );
    if (judged.length === 0)
      return {
        state: "not_checkable",
        reason: "no live asset group with assets read in a live PMax campaign",
        table: "pmaxAssets",
        category: "not_present",
      };
    const findings: CheckFinding[] = [];
    for (const { campaign, group } of judged) {
      const refused = group.children.assets.filter((a) =>
        isAssetRefused(a.attrs.primaryStatus, a.attrs.primaryStatusDetails, a.attrs.linkStatus),
      );
      if (refused.length === 0) continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: groupScope(campaign, group),
          cite: [ctx.get("C.spend", { campaignId: campaign.id })].filter(isOk),
          entity: { id: group.id, name: group.name },
          facts: { refused_assets: refused.length, assets_in_group: group.children.assets.length },
          population: judged.length,
          rows: refused.slice(0, PX17_ROWS).map((a) => ({
            entity: { id: a.id, name: a.attrs.text ?? a.attrs.videoTitle ?? a.name ?? a.id },
            cells: {
              asset: String(a.attrs.fieldType ?? "asset")
                .toLowerCase()
                .replace(/_/g, " "),
              reason: refusalSentence(a.attrs.primaryStatusDetails),
            },
          })),
          note: `${refused.length} of ${group.children.assets.length} assets in this group are disapproved by Google`,
        }),
      );
    }
    if (findings.length === 0)
      return {
        state: "none_found",
        population: judged.length,
        note: `no refused asset in ${judged.length} live asset group(s)`,
      };
    return { state: "fires", findings };
  },
});

// ---------------------------------------------------------------------------
// PX18 — one asset group sells the whole catalogue as one bucket
// ---------------------------------------------------------------------------

const PX18 = defineCheck({
  id: "PX18",
  claimKey: CLAIM_KEYS.PMAX_SINGLE_BUCKET,
  title: "one asset group sells the whole catalogue as a single bucket",
  clientLabel: "a Performance Max campaign selling its whole range from one asset group",
  group: "pmax",
  metrics: ["C.spend"],
  confounders: [],
  requires: ["assetGroups", "pmaxListingGroups"],
  needsCompleteData: ["assetGroups", "pmaxListingGroups"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Your live Performance Max campaigns split their products into groups.",
  judges: {
    campaigns: "spending",
    because: "the structure only costs anything on a live campaign that spends",
  },
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const minSpend = scaleMoney(ctx.settings.pmax.shapeMinSpendUsd, ctx.currency);
    if (minSpend == null)
      return {
        state: "insufficient_data",
        reason:
          "the account currency is unknown, so the spend bar for judging a campaign's shape is skipped",
      };
    let population = 0;
    const findings: CheckFinding[] = [];
    for (const c of pmaxCampaigns(ctx).filter(isReportable)) {
      if ((c.windows.m90.cost ?? 0) < minSpend) continue;
      const live = c.children.assetGroups.filter(
        (g) => String(g.status ?? "").toUpperCase() === "ENABLED",
      );
      if (live.length === 0) continue;
      const retail = live.some(
        (g) => g.attrs.listingGroupCounts.included + g.attrs.listingGroupCounts.subdivision > 0,
      );
      if (!retail) continue;
      population++;
      const g = live[0]!;
      // the product count reached is unknown without the catalogue: unknown counts as big
      const catalogue = c.children.products.length > 0 ? c.children.products.length : null;
      const single =
        live.length === 1 &&
        g.attrs.listingGroupCounts.subdivision === 0 &&
        (catalogue == null || catalogue >= SMALL_CATALOGUE_PRODUCTS);
      if (!single) continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: groupScope(c, g),
          cite: [ctx.get("C.spend", { campaignId: c.id })].filter(isOk),
          entity: { id: g.id, name: g.name },
          facts: {
            live_asset_groups: 1,
            listing_subdivisions: 0,
            ...(catalogue != null ? { products_reached: catalogue } : {}),
          },
          population: 1,
          note: `the campaign sells ${catalogue != null ? `${catalogue} products` : "its whole catalogue"} from one asset group with no product split`,
        }),
      );
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no live retail PMax campaign that spent past the structure bar",
        table: "pmaxListingGroups",
        category: "not_present",
      };
    if (findings.length === 0)
      return {
        state: "none_found",
        population,
        note: `${population} live retail PMax campaign(s) split their products`,
      };
    return { state: "fires", findings };
  },
});

// ---------------------------------------------------------------------------
// PX19 — PMax serving much of its traffic inside mobile apps
// ---------------------------------------------------------------------------

const APP_ROWS = 10;

/** a PMax placement inside a mobile app, by Google's placement type or its `mobileapp::` id. */
function isAppServed(r: {
  placementType: string | null;
  displayName: string | null;
  targetUrl: string | null;
}): boolean {
  if (
    String(r.placementType ?? "")
      .toUpperCase()
      .includes("MOBILE_APP")
  )
    return true;
  return [r.targetUrl, r.displayName].some((v) =>
    String(v ?? "")
      .toLowerCase()
      .startsWith("mobileapp::"),
  );
}

/**
 * performance_max_placement_view carries IMPRESSIONS only (no cost), and the
 * snapshot keeps the top placements per campaign. The answer is the app share of
 * those listed impressions; a warning only when apps also carry a big share of
 * the campaign's own impressions, else a note.
 */
/** PX19: the label when apps are a big share of the listed placements only, not of all impressions. */
export const PX19_TITLE_LISTED =
  "mobile apps carry a big share of a Performance Max campaign's listed placements (a small share of all its impressions)";

const PX19 = defineCheck({
  id: "PX19",
  claimKey: CLAIM_KEYS.PMAX_APP_INVENTORY_SHARE,
  title: "a Performance Max campaign serves much of its traffic inside mobile apps",
  clientLabel: "Performance Max ads showing inside mobile apps and games",
  group: "pmax",
  metrics: ["C.impr", "A.brand_safety_exclusions"],
  confounders: [],
  requires: ["campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Performance Max barely shows in mobile apps.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const p = ctx.settings.pmax;
    const live = pmaxCampaigns(ctx).filter((c) => statusOf(c) === "ENABLED");
    if (live.length === 0)
      return {
        state: "not_checkable",
        reason: "no live PMax campaign on this account",
        category: "not_present",
      };
    const exclusionsV = ctx.get("A.brand_safety_exclusions");
    const names =
      isOk(exclusionsV) && Array.isArray(exclusionsV.value)
        ? (exclusionsV.value as unknown as string[])
        : null;
    const appExcluded =
      names == null ? null : names.some((n) => n.startsWith("MOBILE_APP_CATEGORY:"));
    const findings: CheckFinding[] = [];
    const reasons: string[] = [];
    const thin: string[] = [];
    const shares: string[] = [];
    // a list cut at the per-campaign limit can hide apps further down: never a clean answer
    const capped: string[] = [];
    let population = 0;
    for (const c of live) {
      const pl = c.attrs.pmaxPlacements;
      if (!pl || pl.state !== "synced") {
        reasons.push(
          `${c.name}: ${pl?.state === "not_checkable" ? pl.note : "placements not read"}`,
        );
        continue;
      }
      const impr = c.windows.m90.impressions ?? 0;
      const listed = pl.rows.reduce((t, r) => t + r.impressions, 0);
      if (impr < p.appMinImpressions || listed < p.appMinImpressions) {
        thin.push(`${c.name}: ${listed} impressions in its listed placements`);
        continue;
      }
      population++;
      const apps = pl.rows.filter(isAppServed);
      const appImpr = apps.reduce((t, r) => t + r.impressions, 0);
      const listedShare = appImpr / listed;
      const campaignShare = appImpr / impr;
      shares.push(
        `${c.name} ${(listedShare * 100).toFixed(1)}%${pl.capped ? ` of the top ${pl.rows.length} placements read` : ` of all ${pl.rows.length} placements`}`,
      );
      if (listedShare < p.appListedShare) {
        if (pl.capped) capped.push(c.name);
        continue;
      }
      const f = finding({
        claimKey: this.claimKey,
        scope: campaignScope(c),
        cite: [ctx.get("C.impr", { campaignId: c.id }), exclusionsV].filter(isOk),
        entity: { id: c.id, name: c.name },
        facts: {
          app_impressions: appImpr,
          listed_placement_impressions: listed,
          app_share_of_listed_placements_pct: Number((listedShare * 100).toFixed(1)),
          campaign_impressions: impr,
          app_share_of_impressions_pct: Number((campaignShare * 100).toFixed(1)),
          apps_listed: apps.length,
          app_category_excluded: appExcluded,
          placement_rows_capped: pl.capped,
        },
        rows: [...apps]
          .sort(
            (a, b) =>
              b.impressions - a.impressions ||
              String(a.displayName).localeCompare(String(b.displayName)),
          )
          .slice(0, APP_ROWS)
          .map((r) => ({
            entity: { id: null, name: r.displayName ?? r.targetUrl ?? "mobile app" },
            cells: { impressions: r.impressions },
          })),
        note: `impressions only (Google reports no cost per Performance Max placement); ${(listedShare * 100).toFixed(1)}% of the impressions in ${pl.capped ? `the top ${pl.rows.length} placements read (apps further down are not counted)` : `the ${pl.rows.length} placements read`}, ${(campaignShare * 100).toFixed(1)}% of the campaign's impressions`,
      });
      if (campaignShare < p.appImpressionShare) {
        f.maxSeverity = "info";
        // R4 wording: apps lead the listed placements but are a small share of all its
        // impressions (2.1% of a jackets campaign), never "much of its traffic"
        f.title = PX19_TITLE_LISTED;
      }
      findings.push(f);
    }
    // every campaign not read, cut short or too thin is said in every answer
    const limits = [
      ...reasons,
      ...capped.map((n) => `${n}: only the top placements were read and apps may sit further down`),
      ...thin,
    ];
    if (population === 0) {
      if (reasons.length > 0 && thin.length === 0)
        return {
          state: "not_checkable",
          reason: `no placement data for a live PMax campaign: ${reasons.join("; ")}`,
          table: "pmax_placements",
          category: "our_gap",
        };
      return {
        state: "not_checkable",
        reason: `no live PMax campaign lists ${p.appMinImpressions} placement impressions to judge${thin.length ? `: ${thin.join("; ")}` : ""}${reasons.length ? `; ${reasons.join("; ")}` : ""}`,
        table: "pmax_placements",
        category: "thin_data",
      };
    }
    for (const f of findings) {
      f.sample.population = population;
      if (limits.length > 0) f.limitedBy = [`Not judged: ${limits.join("; ")}.`];
    }
    if (findings.length > 0) return { state: "fires", findings };
    // a campaign not read, or read only in part, is unknown: never clean
    if (reasons.length > 0 || capped.length > 0)
      return {
        state: "not_checkable",
        reason: `${limits.join("; ")}; the campaigns judged are under the ${(p.appListedShare * 100).toFixed(0)}% bar (${shares.join(", ")})`,
        table: "pmax_placements",
        category: "our_gap",
      };
    return {
      state: "none_found",
      population,
      note: `app share of placement impressions: ${shares.join(", ")}; the bar is ${(p.appListedShare * 100).toFixed(0)}%${thin.length > 0 ? `; too few impressions to judge: ${thin.join("; ")}` : ""}`,
    };
  },
});

// ---------------------------------------------------------------------------
// PX21 — a live non-brand PMax campaign with no blocked searches at all
// ---------------------------------------------------------------------------

/**
 * No campaign negatives, no shared list, no account list. Preventive: any junk
 * search (jobs, free, second-hand) can show its ads. A campaign whose own blocks
 * were not read is not judged, and a list that holds only the own brand is never
 * cover.
 */
const PX21 = defineCheck({
  id: "PX21",
  claimKey: CLAIM_KEYS.PMAX_NO_NEGATIVES,
  title: "live non-brand Performance Max campaign with no blocked searches at all",
  clientLabel: "blocked searches on your Performance Max campaigns",
  group: "pmax",
  metrics: ["C.spend", "P.search_term_cost"],
  confounders: [],
  requires: ["campaigns", "sharedNegativeLists"],
  needsCompleteData: ["campaign_negatives", "sharedNegativeListMembers", "accountNegatives"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Every live Performance Max campaign blocks junk searches.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const live = pmaxCampaigns(ctx).filter(
      (c) => statusOf(c) === "ENABLED" && !c.attrs.isBrand && (c.windows.m90.cost ?? 0) > 0,
    );
    if (live.length === 0)
      return {
        state: "not_checkable",
        reason: "no live non-brand Performance Max campaign with spend",
        table: "campaigns",
        category: "not_present",
      };
    // an unread account list is never assumed empty
    if (ctx.model.dataQuality?.tables?.accountNegatives?.checkable === "error")
      return {
        state: "not_checkable",
        reason: "the account-level negative list was not read",
        table: "accountNegatives",
        category: "our_gap",
      };
    const idx = ctx.model.negativeIndex;
    const matcher = brandMatcherOfModel(ctx.model);
    const holdsBrand = (entries: readonly { text: string }[]): boolean =>
      listHoldsOwnBrand(
        entries.map((e) => e.text),
        entries.length,
        matcher ? (t: string) => containsBrandName(t, matcher) : null,
      ) === true;
    if (idx.account.length > 0 && !holdsBrand(idx.account)) {
      return {
        state: "none_found",
        population: live.length,
        note: `the account list (${idx.account.length} blocks) covers every Performance Max campaign`,
      };
    }
    const notRead: string[] = [];
    const unlinked = new Set<string>();
    const bare = live.filter((c) => {
      for (const l of c.children.inheritedNegatives) {
        if (l.attrs.level !== "shared_list" || !l.attrs.listId) continue;
        if (l.attrs.attachmentUnknown) {
          unlinked.add(l.attrs.listId);
          continue;
        }
        if (!holdsBrand(idx.byList.get(l.attrs.listId) ?? [])) return false;
      }
      if (c.children.negatives == null) {
        notRead.push(c.name);
        return false;
      }
      const own = idx.byCampaign.get(c.id) ?? [];
      return own.length === 0 || holdsBrand(own);
    });
    const notReadNote =
      notRead.length > 0 ? `; blocked searches of ${notRead.join(", ")} not read (not judged)` : "";
    if (bare.length === 0) {
      if (notRead.length === live.length)
        return {
          state: "not_checkable",
          reason: `the blocked searches of ${notRead.join(", ")} were not read`,
          table: "campaign_negatives",
          category: "our_gap",
        };
      return {
        state: "none_found",
        population: live.length - notRead.length,
        note: `every live non-brand Performance Max campaign blocks searches (own blocks or a list)${notReadNote}`,
      };
    }
    const findings: CheckFinding[] = bare.map((c) => {
      const termCost = ctx.get("P.search_term_cost", { campaignId: c.id });
      const spend = ctx.get("C.spend", { campaignId: c.id });
      const own = idx.byCampaign.get(c.id) ?? [];
      // the shared lists that apply here and hold only your brand
      const brandLists = c.children.inheritedNegatives.filter(
        (l) => l.attrs.level === "shared_list" && l.attrs.listId && !l.attrs.attachmentUnknown,
      ).length;
      const brandOnly = own.length > 0 || brandLists > 0 || idx.account.length > 0;
      return {
        ...finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [spend, termCost].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: {
            campaign_negatives: own.length,
            shared_lists_brand_only: brandLists,
            account_list_negatives: idx.account.length,
            blocks_only_your_brand: brandOnly,
            "C.spend": num(spend),
          },
          population: live.length - notRead.length,
          note: brandOnly
            ? `the only searches the campaign blocks are your own brand name (its own blocks, shared lists or the account list), so nothing keeps junk searches out${notReadNote}`
            : `the campaign blocks no search at all: no blocked searches of its own, no shared list, and the account list is empty${notReadNote}`,
        }),
        // preventive: no waste is priced here
        maxSeverity: "info" as const,
        ...(unlinked.size > 0
          ? {
              limitedBy: [
                `We could not see which campaigns ${unlinked.size} of your negative lists are attached to; if one is on this campaign, it is already covered.`,
              ],
            }
          : {}),
      };
    });
    return { state: "fires", findings };
  },
});

// ---------------------------------------------------------------------------
// PX05 — a product inside a Performance Max campaign spends past the bar without a sale
// ---------------------------------------------------------------------------

/**
 * the parent products whose spend SH04 / PX05 price as waste in a live Shopping or
 * Performance Max campaign (each campaign at its own bar: productWastePricedParents). SH20
 * leaves their sizes unpriced so the same dollars are not counted twice.
 */
export function pmaxWastedParentKeys(ctx: CheckCtx): Set<string> {
  return productWastePricedParents(ctx);
}

const PX05 = defineCheck({
  id: "PX05",
  claimKey: CLAIM_KEYS.PMAX_LISTING_GROUP_LOSERS,
  title: "included product spends past the bar without a sale, or sells for less than it costs",
  clientLabel: "products that lose money inside a Performance Max campaign",
  group: "pmax",
  metrics: ["C.product_waste_bar", "C.product_loss_bar", "T.waste_floor", "Pr.spend", "Pr.conv"],
  confounders: ["SH01", "SH06", "PX01"],
  requires: ["pmax_campaign_products"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans:
    "No included product spends past the bar without a sale, or sells for less than it costs.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const live = pmaxCampaigns(ctx).filter(isReportable);
    if (live.length === 0)
      return {
        state: "not_checkable",
        reason: "no live Performance Max campaign on this account",
        table: "campaigns",
        category: "not_present",
      };
    // each product (model + colour) INSIDE each live PMax campaign, at that campaign's own bar
    return (
      campaignProductLosers(ctx, "PERFORMANCE_MAX", this.claimKey) ?? {
        state: "not_checkable",
        reason: "no live Performance Max campaign has its own product rows read",
        table: "pmax_campaign_products",
        category: "our_gap",
      }
    );
  },
});

// ---------------------------------------------------------------------------
// PX07 / PX16 — placements that spend without converting (Display, Video, Demand Gen)
// ---------------------------------------------------------------------------

/**
 * A money row the placement checks never name: Performance Max reports no cost per
 * place (PX19 judges its places), Google's own surfaces cannot be excluded, and a
 * place the account already excludes is done.
 */
function moneyPlacementSkipped(
  ctx: CheckCtx,
  c: CampaignNode,
  p: {
    attrs: { placementType: string | null; displayName: string | null; targetUrl: string | null };
  },
): boolean {
  if (c.attrs.type === "PERFORMANCE_MAX") return true;
  if (isGoogleOwnedPlacement(p.attrs)) return true;
  const excluded = ctx.model.attrs.placementExcludedKeys;
  if (!excluded || excluded.length === 0) return false;
  const key = placementExclusionKey(p.attrs);
  return key != null && excluded.includes(key);
}

const NO_MONEY_ROWS =
  "no placement with cost belongs to a Display, Video or Demand Gen campaign of this account (Performance Max reports no cost per place; PX19 judges its places)";

const PX07 = defineCheck({
  id: "PX07",
  claimKey: CLAIM_KEYS.PMAX_PLACEMENT_JUNK,
  title: "placement spends past the bar without converting",
  clientLabel: "sites, apps and videos that spend without a sale",
  group: "pmax",
  metrics: ["Pl.cost", "Pl.conv", "T.waste_floor"],
  confounders: ["PX01"],
  requires: ["placement_performance"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "No placement spends past the bar without converting.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const floorValue = ctx.get("T.waste_floor");
    const floor = num(floorValue);
    if (floor == null)
      return {
        state: "not_checkable",
        reason: "the money bar is not computable (currency or window unknown)",
      };
    if (!Number.isFinite(floor))
      return { state: "insufficient_data", reason: "currency unknown: the money bar is skipped" };
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of campaignsOf(ctx)) {
      for (const placement of c.children.placements) {
        if (moneyPlacementSkipped(ctx, c, placement)) continue;
        const cost = ctx.get("Pl.cost", { placementId: placement.id });
        const conv = ctx.get("Pl.conv", { placementId: placement.id });
        if (!isOk(cost) || !isOk(conv)) continue;
        population++;
        const spend = num(cost);
        const conversions = num(conv);
        if (spend == null || conversions == null || spend < floor || conversions !== 0) continue;
        findings.push(
          finding({
            claimKey: this.claimKey,
            scope: {
              type: "placement",
              id: placement.id,
              name: placement.attrs.displayName ?? placement.name,
              campaignId: c.id,
              campaignName: c.name,
            },
            cite: [cost, conv, floorValue],
            entity: { id: placement.id, name: placement.attrs.displayName ?? placement.name },
            facts: {
              wasted_cost_90d: spend,
              conv: conversions,
              waste_floor: floor,
              "Pl.cost": spend,
            },
            population,
          }),
        );
      }
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: NO_MONEY_ROWS,
        table: "placement_performance",
        category: "not_present",
      };
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          note: `no placement at or above the ${floor.toFixed(2)} bar with zero conversions`,
        };
  },
});

/** PX16: rows shown on the card. */
const PLACEMENT_ROLLUP_ROWS = 10;

/** The site, app bucket or YouTube bucket a placement belongs to. */
function placementBucketOf(p: {
  attrs: { placementType: string | null; targetUrl: string | null; displayName: string | null };
  name: string | null;
}): string {
  const type = String(p.attrs.placementType ?? "").toUpperCase();
  const raw = String(p.attrs.targetUrl ?? p.attrs.displayName ?? p.name ?? "")
    .trim()
    .toLowerCase();
  if (type.includes("MOBILE_APP") || raw.startsWith("mobileapp::")) return "mobile apps";
  if (type.includes("YOUTUBE") || /(^|\.)youtube\.com/.test(raw))
    return "YouTube channels and videos";
  const host = raw
    .replace(/^[a-z]+:\/\//, "")
    .split(/[/?#]/)[0]!
    .replace(/^www\./, "");
  return host || raw || "unnamed placement";
}

const PX16 = defineCheck({
  id: "PX16",
  claimKey: CLAIM_KEYS.PMAX_PLACEMENT_SMALL_WASTE_ROLLUP,
  title: "many small placements on one site or in apps add up to real spend without a sale",
  clientLabel: "small ad placements that add up to real spend without a sale",
  group: "pmax",
  metrics: ["Pl.cost", "Pl.conv", "T.waste_floor"],
  confounders: ["PX01"],
  requires: ["placement_performance"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans:
    "Small placements without a sale do not add up to real spend on any one site or in apps.",
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const floorValue = ctx.get("T.waste_floor");
    const floor = num(floorValue);
    if (floor == null)
      return {
        state: "not_checkable",
        reason: "the money bar is not computable (currency or window unknown)",
      };
    if (!Number.isFinite(floor))
      return { state: "insufficient_data", reason: "currency unknown: the money bar is skipped" };
    type Row = {
      campaign: CampaignNode;
      name: string;
      cost: number;
      conv: number;
      truncated: boolean;
    };
    const byBucket = new Map<string, Row[]>();
    let population = 0;
    let placementSpend = 0;
    for (const c of campaignsOf(ctx)) {
      for (const placement of c.children.placements) {
        if (moneyPlacementSkipped(ctx, c, placement)) continue;
        const cost = ctx.get("Pl.cost", { placementId: placement.id });
        const conv = ctx.get("Pl.conv", { placementId: placement.id });
        if (!isOk(cost) || !isOk(conv)) continue;
        const spend = num(cost);
        const conversions = num(conv);
        if (spend == null || conversions == null) continue;
        population++;
        placementSpend += spend;
        const key = placementBucketOf(placement);
        (byBucket.get(key) ?? byBucket.set(key, []).get(key)!).push({
          campaign: c,
          name: placement.attrs.displayName ?? placement.name ?? key,
          cost: spend,
          conv: conversions,
          truncated: cost.sample.truncated,
        });
      }
    }
    if (population === 0)
      return {
        state: "not_checkable",
        reason: NO_MONEY_ROWS,
        table: "placement_performance",
        category: "not_present",
      };
    const minShare = ctx.settings.pmax.placementRollupMinShare;
    const minFloors = ctx.settings.pmax.placementRollupMinFloors;
    // a site where ANY placement converted is not a leak; rows PX07 reports (at or over the bar) are never counted
    const buckets = [...byBucket.entries()]
      .filter(([, rows]) => rows.every((r) => r.conv === 0))
      .map(([bucket, rows]) => ({ bucket, rows: rows.filter((r) => r.cost > 0 && r.cost < floor) }))
      .filter((b) => b.rows.length >= 2 && b.rows.reduce((t, r) => t + r.cost, 0) >= floor)
      .map((b) => ({ ...b, cost: b.rows.reduce((t, r) => t + r.cost, 0) }))
      .sort((a, b) => b.cost - a.cost || a.bucket.localeCompare(b.bucket));
    const total = buckets.reduce((t, b) => t + b.cost, 0);
    const summary = `${buckets.length} site/app bucket(s) of small zero-conversion placements add up to ${total.toFixed(2)} of ${placementSpend.toFixed(2)} placement spend`;
    if (buckets.length === 0 || total < floor * minFloors || total < placementSpend * minShare)
      return {
        state: "none_found",
        population,
        note: `${summary}: under the bar for a finding (${(floor * minFloors).toFixed(2)} in total and ${(minShare * 100).toFixed(0)}% of placement spend)`,
      };
    const truncated = buckets.some((b) => b.rows.some((r) => r.truncated));
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: this.claimKey,
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [floorValue],
          facts: {
            rollup_wasted_cost_90d: Number(total.toFixed(2)),
            ...(truncated ? { rollup_is_sample: 1 } : {}),
            leaking_sites: buckets.length,
            leaking_placements: buckets.reduce((n, b) => n + b.rows.length, 0),
            placement_spend_90d: Number(placementSpend.toFixed(2)),
            waste_floor: floor,
          },
          population,
          rows: buckets.slice(0, PLACEMENT_ROLLUP_ROWS).map((b) => ({
            entity: { id: null, name: b.bucket },
            cells: {
              placements: b.rows.length,
              spend: Number(b.cost.toFixed(2)),
              campaigns: [
                ...new Set(b.rows.map((r) => r.campaign.name).filter((n): n is string => !!n)),
              ]
                .sort()
                .join(", "),
            },
          })),
          note: summary,
        }),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// PX15 — the asset groups still running leave selling products out
// ---------------------------------------------------------------------------

/** The exact product criteria a set of asset groups includes (listing-group leaves). */
type IncludeSet = {
  keys: Set<string>;
  dimensions: Set<string>;
  /** an include with no value = "everything else" */
  includesEverythingElse: boolean;
};

function criterionKey(d: ListingDimension): string | null {
  switch (d.kind) {
    case "productItemId":
      return d.value == null ? null : `productItemId=${d.value.toLowerCase()}`;
    case "productCustomAttribute":
      return d.value == null
        ? null
        : `productCustomAttribute:${d.index ?? "?"}=${d.value.toLowerCase()}`;
    case "productType":
      return d.value == null ? null : `productType:${d.level ?? "?"}=${d.value.toLowerCase()}`;
    case "productBrand":
      return d.value == null ? null : `productBrand=${d.value.toLowerCase()}`;
    case "productCategory":
      return d.value == null ? null : `productCategory:${d.level ?? "?"}=${d.value.toLowerCase()}`;
    default:
      return null;
  }
}

function includeSetOf(groups: readonly AssetGroupNode[]): IncludeSet {
  const out: IncludeSet = { keys: new Set(), dimensions: new Set(), includesEverythingElse: false };
  const walk = (n: ListingGroupNode): void => {
    if (n.attrs.type === "UNIT_INCLUDED") {
      if (n.attrs.isEverythingElse) out.includesEverythingElse = true;
      const k = criterionKey(n.attrs.dimension);
      if (k) {
        out.keys.add(k);
        out.dimensions.add(n.attrs.dimension.kind);
      }
    }
    for (const child of n.children.children) walk(child);
  };
  for (const g of groups) for (const root of g.children.listingGroups) walk(root);
  return out;
}

const PX15 = defineCheck({
  id: "PX15",
  claimKey: CLAIM_KEYS.PMAX_STRUCTURE_MOSTLY_PAUSED,
  title: "the asset groups still running leave selling products out",
  clientLabel: "products that sold but no running asset group sells any more",
  group: "pmax",
  metrics: ["P.ag_paused_share", "C.spend"],
  confounders: [],
  requires: ["assetGroups", "pmaxListingGroups"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans:
    "Where a Performance Max campaign runs on only some of its asset groups, the ones still running, another live Performance Max campaign's running asset groups, or another live campaign that showed the product in the last 7 days, each selling from the same Merchant Center account and feed label, cover the products the switched-off ones selected. Past a running asset group, only another live campaign (Standard Shopping or Performance Max) with impressions for the product in the last 7 days covers it.",
  judges: {
    assetGroups: "all",
    campaigns: "spending",
    because: "a campaign that never spent tells us nothing by having its groups off",
  },
  run(ctx) {
    const gate = gateOnData(ctx, this.requires);
    if (gate) return gate;
    const minGroups = ctx.settings.pmax.shapeMinGroups;
    const pausedPct = ctx.settings.pmax.pausedGroupsPct;
    const findings: CheckFinding[] = [];
    let population = 0;
    let coveredAnyway = 0;
    const unprovable: string[] = [];
    // the product list resolved per asset group (model/productCatalog.ts)
    const catalog = ctx.model.attrs.merchantCenter.productCatalog ?? null;
    const catalogGroups = catalog?.pmaxGroups ?? null;
    const catalogUsable = catalog != null && !catalog.truncated && catalogGroups != null;
    // every running asset group of every live PMax campaign: the coverage a product can fall back on
    const liveAccountGroups = pmaxCampaigns(ctx).flatMap((pc) =>
      liveAssetGroupsOf(pc).map((g) => ({ campaign: pc, group: g })),
    );
    // product id -> the live campaigns whose running asset groups' trees select it
    const runningTreeCampaigns = new Map<string, Set<string>>();
    if (catalogUsable)
      for (const { campaign, group } of liveAccountGroups)
        for (const id of catalogGroups!.byGroup[group.id]?.selling ?? []) {
          const set = runningTreeCampaigns.get(id) ?? new Set<string>();
          set.add(campaign.id);
          runningTreeCampaigns.set(id, set);
        }
    // a running group whose selection cannot be matched to products may be the one covering them
    const unresolvedRunning = catalogUsable
      ? liveAccountGroups
          .filter(({ group }) => !catalogGroups!.byGroup[group.id]?.resolved)
          .map(({ campaign, group }) => `${group.name} (${campaign.name})`)
      : [];
    // R11: a product another live campaign advertises is not left out: a running asset group
    // of another live Performance Max campaign whose tree includes it (by the resolved product
    // list, or the listing tree, which can miss an item Google re-ids, "...-abc1d2e3"), or
    // impressions for it in the LAST 7 DAYS of the window in another live Standard Shopping or
    // Performance Max campaign's own product results. A row over the whole window is no cover
    // (it can come from an asset group switched off since, and two campaigns' old rows could
    // cover each other) and the campaign's own rows never count. A 7-day count not read (a
    // snapshot without the column, a failed read) is unknown, not "no impressions": when another
    // live campaign that could sell to the same shoppers has such a row for a product that would
    // otherwise be left out, the campaign is not checkable, never a left-out claim. Google can show a product under a listing-tree node it reports as excluded, so
    // a tree alone may not clear a product another campaign is showing; its recent impressions
    // do. Nothing else clears a product: the splits the switched-off groups picked it by are
    // never set aside. The other campaign
    // only covers it when it can sell it to the same shoppers: the same Merchant Center account and feed label (checks/shopping.ts servedBy),
    // for every feed this campaign sells it from. A live Shopping campaign whose product rows
    // were not read may be the one covering them, so no left-out list is stated while it can.
    // A row of a COPY of the item ("<item id>-<suffix>", a second feed) counts as the item's;
    // the feed-label test does not apply to it (same Merchant Center = same product), only a
    // Merchant Center known on both sides that differs rules it out.
    const liveGroupIds = new Set(liveAccountGroups.map(({ group }) => group.id));
    const liveShopping = campaignsOf(ctx).filter(
      (sc) => sc.attrs.type === "SHOPPING" && isReportable(sc),
    );
    const liveShoppingIds = new Set(
      liveShopping.filter((sc) => sc.attrs.productPerf?.state === "synced").map((sc) => sc.id),
    );
    const livePmaxShownIds = new Set(
      pmaxCampaigns(ctx)
        .filter((pc) => isReportable(pc) && pc.attrs.productPerf?.state === "synced")
        .map((pc) => pc.id),
    );
    const shoppingNotRead = liveShopping.filter((sc) => sc.attrs.productPerf?.state !== "synced");
    const groupCampaign = new Map(
      liveAccountGroups.map(({ campaign, group }) => [group.id, campaign.id]),
    );
    const campaignsById = ctx.model.index.campaignsById;
    const productsById = ctx.model.index.productsById;
    /** whether one of `others` can sell the product to this campaign's shoppers */
    const sellsToSameShoppers = (
      productId: string,
      campaign: CampaignNode,
      others: ReadonlySet<string>,
    ): boolean => {
      const p = productsById.get(productId);
      if (others.size === 0) return false;
      const own = sellerOf(campaign);
      // settings not read, or this campaign sells no products: the account and label cannot
      // be compared, so any other live campaign showing it counts
      if (own === null || own === "none") return true;
      const otherSellers: Seller[] = [];
      for (const id of others) {
        const oc = campaignsById.get(id);
        const s = oc ? sellerOf(oc) : null;
        if (s === null) return true; // not read: cannot be ruled out
        if (s !== "none") otherSellers.push(s);
      }
      if (otherSellers.length === 0) return false;
      // the feeds this campaign sells the product from; a field not read falls back to its own
      const feeds = (p ? feedStatusesOf(p) : [{ merchantId: null, feedLabel: null }]).filter(
        servedBy([own]),
      );
      const mine = feeds.length > 0 ? feeds : [{ merchantId: null, feedLabel: null }];
      return mine.every((f) =>
        servedBy(otherSellers)({
          merchantId: f.merchantId ?? own.merchantId,
          feedLabel: f.feedLabel ?? (own.feedLabel === "" ? null : own.feedLabel),
        }),
      );
    };
    // round 3: rows the product nodes do not carry. A copy of an item ("<item id>-<suffix>",
    // e.g. a second feed's re-id "...-gao0a1m0") is a row of the item it copies for this cover
    // only: the longest prefix cut at a "-" that is a known item id (case-insensitive; a longer
    // id without the "-" is another item). Its own row keeps its identity everywhere else. A
    // pair seen in the last 7 days with no row over the window (recentOnly) covers too.
    const knownIds = new Set<string>([
      ...productsById.keys(),
      ...Object.keys(catalogGroups?.selling ?? {}),
    ]);
    const originalOf = (offerId: string): string | null => {
      const id = offerId.toLowerCase();
      for (let i = id.lastIndexOf("-"); i > 0; i = id.lastIndexOf("-", i - 1)) {
        const prefix = id.slice(0, i);
        if (knownIds.has(prefix)) return prefix;
      }
      return null;
    };
    type ExtraRow = { campaignId: string; impressions7d: number | null; viaCopy: boolean };
    const extraRows = new Map<string, ExtraRow[]>();
    const addExtra = (productId: string, row: ExtraRow) =>
      extraRows.set(productId, [...(extraRows.get(productId) ?? []), row]);
    for (const oc of campaignsOf(ctx)) {
      if (!liveShoppingIds.has(oc.id) && !livePmaxShownIds.has(oc.id)) continue;
      const perf = oc.attrs.productPerf;
      if (perf?.state !== "synced") continue;
      for (const r of perf.rows) {
        const orig = originalOf(r.offerId);
        if (orig != null && orig !== r.productId)
          addExtra(orig, {
            campaignId: oc.id,
            impressions7d: r.impressions7d ?? null,
            viaCopy: true,
          });
      }
      for (const r of perf.recentOnly ?? []) {
        if (r.productId != null)
          addExtra(r.productId, {
            campaignId: oc.id,
            impressions7d: r.impressions7d,
            viaCopy: false,
          });
        const orig = originalOf(r.offerId);
        if (orig != null && orig !== r.productId)
          addExtra(orig, { campaignId: oc.id, impressions7d: r.impressions7d, viaCopy: true });
      }
    }
    /** other live campaigns' extra rows for the product whose 7-day count passes `pick` */
    const extraOthers = (
      productId: string,
      campaign: CampaignNode,
      pick: (n: number | null) => boolean,
    ): { direct: Set<string>; copy: Set<string> } => {
      const out = { direct: new Set<string>(), copy: new Set<string>() };
      for (const r of extraRows.get(productId) ?? [])
        if (r.campaignId !== campaign.id && pick(r.impressions7d))
          (r.viaCopy ? out.copy : out.direct).add(r.campaignId);
      return out;
    };
    /**
     * The campaigns of `others` showing a copy of the product that sell to the same shoppers:
     * a copy of the same item in the same Merchant Center is the same product, whatever its
     * feed label. A Merchant Center known on both sides that differs is another shop: no cover.
     */
    const copyCoverers = (
      productId: string,
      campaign: CampaignNode,
      others: ReadonlySet<string>,
    ): string[] => {
      const own = sellerOf(campaign);
      const p = productsById.get(productId);
      const mine = new Set(
        (p ? feedStatusesOf(p) : [])
          .filter((f) => own === null || own === "none" || servedBy([own])(f))
          .map((f) => f.merchantId)
          .filter((m): m is string => m != null),
      );
      if (mine.size === 0 && own !== null && own !== "none") mine.add(own.merchantId);
      return [...others].filter((id) => {
        const oc = campaignsById.get(id);
        const s = oc ? sellerOf(oc) : null;
        if (s === null || s === "none" || mine.size === 0) return true;
        return [...mine].every((m) => m === s.merchantId);
      });
    };
    /** how another live campaign advertises the product: directly, only through a copy, or not */
    const advertisedElsewhere = (
      productId: string,
      campaign: CampaignNode,
    ): "direct" | "copy" | null => {
      const p = productsById.get(productId);
      const others = new Set<string>(
        [...(runningTreeCampaigns.get(productId) ?? [])].filter((id) => id !== campaign.id),
      );
      if (p) {
        for (const g of p.attrs.assetGroupsIncludingMe) {
          const owner = groupCampaign.get(g);
          if (liveGroupIds.has(g) && owner != null && owner !== campaign.id) others.add(owner);
        }
        const perf = p.attrs.productPerfPerCampaign;
        if (Array.isArray(perf))
          for (const r of perf)
            if (
              (liveShoppingIds.has(r.campaignId) || livePmaxShownIds.has(r.campaignId)) &&
              r.campaignId !== campaign.id &&
              (r.impressions7d ?? 0) > 0
            )
              others.add(r.campaignId);
      }
      const extra = extraOthers(productId, campaign, (n) => (n ?? 0) > 0);
      for (const id of extra.direct) others.add(id);
      if (sellsToSameShoppers(productId, campaign, others)) return "direct";
      return copyCoverers(productId, campaign, extra.copy).length > 0 ? "copy" : null;
    };
    /** other live campaigns with a row for the product (or a copy of it) whose 7-day count was not read */
    const unreadElsewhere = (
      productId: string,
      campaign: CampaignNode,
    ): { direct: Set<string>; copy: Set<string> } => {
      const out = extraOthers(productId, campaign, (n) => n == null);
      const perf = productsById.get(productId)?.attrs.productPerfPerCampaign;
      if (Array.isArray(perf))
        for (const r of perf)
          if (
            (liveShoppingIds.has(r.campaignId) || livePmaxShownIds.has(r.campaignId)) &&
            r.campaignId !== campaign.id &&
            r.impressions7d == null
          )
            out.direct.add(r.campaignId);
      return out;
    };
    const notReadIds = new Set(shoppingNotRead.map((sc) => sc.id));
    let coveredElsewhere = 0;
    let coveredByCopy = 0;
    let otherFeedDropped = 0;
    let soldOutDropped = 0;
    for (const c of pmaxCampaigns(ctx)) {
      const groups = c.children.assetGroups;
      if (groups.length < minGroups) continue;
      if ((c.windows.m90.cost ?? 0) <= 0) continue;
      if (!isReportable(c)) continue;
      const share = ctx.get("P.ag_paused_share", { campaignId: c.id });
      if (!isOk(share)) continue;
      population++;
      const pct = num(share);
      if (pct == null || pct < pausedPct) continue;
      const on = liveAssetGroupsOf(c);
      const onIds = new Set(on.map((g) => g.id));
      const off = groups.filter((g) => !onIds.has(g.id));
      // switched-off groups are housekeeping; the fault is a hole: products the off groups
      // selected that no running group can be shown to select
      const liveInc = includeSetOf(on);
      const offInc = includeSetOf(off);
      const orphanedCriteria = [...offInc.keys].filter((k) => !liveInc.keys.has(k));
      const liveDims = [...liveInc.dimensions].sort();
      const offDims = [...offInc.dimensions].sort();
      const sameDimension = offDims.length > 0 && offDims.every((d) => liveInc.dimensions.has(d));
      const noSafetyNet = !liveInc.includesEverythingElse && orphanedCriteria.length > 0;
      if (!noSafetyNet) {
        coveredAnyway += 1;
        continue;
      }
      if (!catalogUsable) {
        unprovable.push(
          `${c.name}: ${catalog == null ? "the product list was not read" : catalog.truncated ? "the product list was cut at its row limit" : "the product list was not resolved per asset group"}, so the products the switched-off groups selected cannot be matched to the running ones`,
        );
        continue;
      }
      if (unresolvedRunning.length > 0) {
        unprovable.push(
          `${c.name}: the product selection of running asset group(s) ${namesOf(unresolvedRunning)} splits on product type, category, condition or channel, which cannot be matched to products`,
        );
        continue;
      }
      const unresolvedOff = off.filter(
        (g) => catalogGroups!.byGroup[g.id] != null && !catalogGroups!.byGroup[g.id]!.resolved,
      );
      if (unresolvedOff.length > 0) {
        unprovable.push(
          `${c.name}: switched-off asset group(s) ${namesOf(unresolvedOff.map((g) => g.name))} select on a split that cannot be matched to products`,
        );
        continue;
      }
      const offSelling = new Set(off.flatMap((g) => catalogGroups!.byGroup[g.id]?.selling ?? []));
      // the tree match ignores feed labels: an item whose every known feed this campaign cannot
      // serve (another feed label or Merchant Center) was never its to show. A feed with no
      // label or account read stays in (servedBy keeps it); a product with no node stays in.
      const ownSeller = sellerOf(c);
      const otherFeedOnly = new Set(
        ownSeller === null || ownSeller === "none"
          ? []
          : [...offSelling].filter((id) => {
              const p = productsById.get(id);
              return p !== undefined && !feedStatusesOf(p).some(servedBy([ownSeller]));
            }),
      );
      // sold out in every feed this campaign sells it from: no campaign can show it now, so
      // switching the groups back on would not either (a feed with no stock state read stays in)
      const soldOut = new Set(
        [...offSelling].filter((id) => {
          const p = productsById.get(id);
          if (p === undefined || otherFeedOnly.has(id)) return false;
          const all = feedStatusesOf(p);
          const mine =
            ownSeller === null || ownSeller === "none" ? all : all.filter(servedBy([ownSeller]));
          return mine.length > 0 && mine.every(soldOutRow);
        }),
      );
      const notInRunningTrees = [...offSelling].filter(
        (id) =>
          !otherFeedOnly.has(id) && !soldOut.has(id) && !runningTreeCampaigns.get(id)?.has(c.id),
      );
      const how = new Map(notInRunningTrees.map((id) => [id, advertisedElsewhere(id, c)]));
      const notElsewhere = notInRunningTrees.filter((id) => how.get(id) == null);
      const asCopy = notInRunningTrees.filter((id) => how.get(id) === "copy").length;
      const leftOutIds = notElsewhere;
      const sellingLeftOut = leftOutIds.map((id) => catalogGroups!.selling[id]!).filter(Boolean);
      const elsewhere = notInRunningTrees.length - notElsewhere.length;
      coveredElsewhere += elsewhere;
      coveredByCopy += asCopy;
      otherFeedDropped += otherFeedOnly.size;
      soldOutDropped += soldOut.size;
      if (sellingLeftOut.length === 0) {
        coveredAnyway += 1;
        continue;
      }
      const unreadIds = new Set<string>();
      for (const id of leftOutIds) {
        const unread = unreadElsewhere(id, c);
        if (sellsToSameShoppers(id, c, unread.direct))
          for (const u of unread.direct) unreadIds.add(u);
        for (const u of copyCoverers(id, c, unread.copy)) unreadIds.add(u);
      }
      if (unreadIds.size > 0) {
        unprovable.push(
          `${c.name}: the last 7 days' impressions of the products the switched-off groups selected were not read for live campaign(s) ${namesOf([...unreadIds].map((id) => campaignsById.get(id)?.name ?? id))}, which may be showing them`,
        );
        continue;
      }
      if (leftOutIds.some((id) => sellsToSameShoppers(id, c, notReadIds))) {
        unprovable.push(
          `${c.name}: the products of live Shopping campaign(s) ${namesOf(shoppingNotRead.map((sc) => sc.name))} were not read per campaign, and they may be the ones selling the products the switched-off groups selected`,
        );
        continue;
      }
      findings.push({
        ...finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [share, ctx.get("C.spend", { campaignId: c.id })].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: {
            asset_groups: groups.length,
            switched_off: off.length,
            still_running: on.length,
            product_selections_left_uncovered: orphanedCriteria.length,
            still_running_cover_everything_else: liveInc.includesEverythingElse,
            switched_off_selected_by: offDims,
            still_running_select_by: liveDims,
            still_running_select_on_the_same_basis: sameDimension,
            selling_products_left_out: sellingLeftOut.length,
            selling_products_selected_by_switched_off: offSelling.size,
            selling_products_advertised_by_another_live_campaign: elsewhere,
            selling_products_shown_as_copy_elsewhere: asCopy,
            selling_products_in_a_feed_this_campaign_does_not_sell: otherFeedOnly.size,
            selling_products_sold_out: soldOut.size,
            products_resolved: catalog!.rows,
            cover_judged_on:
              "running asset groups of live Performance Max campaigns, and impressions in the last 7 days in other live Standard Shopping and Performance Max campaigns",
          },
          population,
          ...(otherFeedOnly.size > 0 || soldOut.size > 0
            ? {
                note: [
                  otherFeedOnly.size > 0
                    ? `${otherFeedOnly.size} selling product(s) the switched-off groups selected are not counted: every feed they are in has a feed label or Merchant Center account this campaign does not sell`
                    : null,
                  soldOut.size > 0
                    ? `${soldOut.size} selling product(s) the switched-off groups selected are not counted: sold out in every feed this campaign sells them from`
                    : null,
                ]
                  .filter((x) => x !== null)
                  .join("; "),
              }
            : {}),
          rows: [...sellingLeftOut]
            .sort((a, b) => b.value - a.value || b.conv - a.conv || a.id.localeCompare(b.id))
            .slice(0, 10)
            .map((p) => ({
              entity: { id: p.id, name: p.title ?? p.id },
              cells: { sales: p.conv, sales_value: p.value, spend: p.cost },
            })),
        }),
        maxSeverity: "info",
      });
    }
    if (findings.length > 0) return { state: "fires", findings };
    if (unprovable.length > 0)
      return {
        state: "not_checkable",
        reason: `whether the running asset groups still reach the products the switched-off ones selected cannot be shown: ${unprovable.join("; ")}`,
        table: "pmaxListingGroups",
        category: "our_gap",
      };
    if (population === 0)
      return {
        state: "not_checkable",
        reason: `no Performance Max campaign has ${minGroups} or more asset groups and spend in the window`,
        table: "assetGroups",
        category: "not_present",
      };
    return {
      state: "none_found",
      population,
      ...(coveredAnyway > 0
        ? {
            note: `${coveredAnyway} campaign(s) have most of their asset groups switched off and the groups still running, or another live campaign, still cover what those selected${coveredElsewhere > 0 ? ` (${coveredElsewhere} selling product(s) through another live campaign${coveredByCopy > 0 ? `, ${coveredByCopy} of them because it shows a copy of the item, "<item id>-<suffix>"` : ""})` : ""}${otherFeedDropped > 0 ? `; ${otherFeedDropped} selling product(s) not counted because every feed they are in has a feed label or Merchant Center account their campaign does not sell` : ""}${soldOutDropped > 0 ? `; ${soldOutDropped} selling product(s) not counted because they are sold out in every feed their campaign sells them from` : ""}; cover is judged on the running asset groups of live Performance Max campaigns and impressions in the last 7 days in other live Standard Shopping and Performance Max campaigns`,
          }
        : {}),
    };
  },
});

export const PMAX_CHECKS: CheckDefinition[] = [
  PX01,
  PX02,
  PX03,
  PX05,
  PX06,
  PX07,
  PX08,
  PX09,
  PX10,
  PX14,
  PX15,
  PX16,
  PX17,
  PX18,
  PX19,
  PX20,
  PX21,
];
