// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Demand Gen: DG01-DG04 and DG06, the checks that read the campaign's own data
 * (its goal, its assets, its audiences, where it spent, its product feed).
 *
 * An account with no Demand Gen campaign gets "not present" from every check, and
 * a Demand Gen table that was not read leaves the check not run, never clean
 * (null children in the model are "not read"; [] is "read, none").
 */
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import type { MetricValue } from "../registry/types.js";
import {
  campaignsOf,
  type CheckCtx,
  type CheckDefinition,
  type CheckFinding,
  type CheckResult,
  defineCheck,
  finding,
  gateOnData,
  isOk,
  num,
} from "./types.js";

const demandGenCampaigns = (ctx: CheckCtx): CampaignNode[] =>
  campaignsOf(ctx).filter((c) => c.attrs.type === "DEMAND_GEN");

const campaignScope = (c: CampaignNode) => ({
  type: "campaign" as const,
  id: c.id,
  name: c.name,
  campaignId: c.id,
  campaignName: c.name,
});

/** The campaigns read gate, then "is there a Demand Gen campaign", then the check's own tables. */
function dgGate(ctx: CheckCtx, tables: string[]): CampaignNode[] | CheckResult {
  const g = gateOnData(ctx, ["campaigns"]);
  if (g) return g;
  const campaigns = demandGenCampaigns(ctx);
  if (campaigns.length === 0)
    return {
      state: "not_checkable",
      reason: "no Demand Gen campaign on this account",
      table: "campaigns",
      category: "not_present",
    };
  const t = gateOnData(ctx, tables);
  if (t) return t;
  return campaigns;
}

/** A Demand Gen table that holds nothing for the campaigns judged: unknown, never "none". */
const notRead = (table: string): CheckResult => ({
  state: "not_checkable",
  reason: `${table} holds no row for the Demand Gen campaigns, so they cannot be judged`,
  table,
  category: "our_gap",
});

// ---------------------------------------------------------------------------
// DG01 — no optimization goal
// ---------------------------------------------------------------------------

const DG01 = defineCheck({
  id: "DG01",
  claimKey: CLAIM_KEYS.DGEN_OPTIMIZATION_GOAL_UNSET,
  title: "Demand Gen campaign has no optimization goal",
  clientLabel: "Demand Gen campaigns that do not know which conversion to buy",
  group: "demand_gen",
  metrics: ["C.spend", "C.conv"],
  confounders: ["MI07"],
  requires: ["campaigns", "dg_campaign_settings", "campaignConversionGoals"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each Demand Gen campaign knows which action it is buying.",
  /**
   * The override list (campaign.optimization_goal_setting) holds call, directions and app
   * pre-registration goals only, never a Demand Gen goal, so the snapshot does not read it
   * (an input may still carry it); the conversion goal set is how a campaign knows what to buy. The check
   * fires only when a campaign has neither an override nor a biddable conversion goal,
   * and abstains when no Demand Gen campaign has either read.
   */
  run(ctx) {
    const gate = dgGate(ctx, this.requires);
    if (!Array.isArray(gate)) return gate;
    const findings: CheckFinding[] = [];
    let population = 0;
    let anyOverride = false;
    let anyGoals = false;
    for (const c of gate) {
      const dg = c.attrs.demandGen;
      if (!dg || dg.state !== "synced") continue;
      population++;
      if (dg.optimizationGoals.length > 0) {
        anyOverride = true;
        continue;
      }
      const goals = c.attrs.conversionGoals ?? [];
      if (goals.length > 0) anyGoals = true;
      if (goals.some((g) => g.biddable !== false)) continue;
      const spend = ctx.get("C.spend", { campaignId: c.id });
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [spend].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: {
            optimization_goals: 0,
            biddable_conversion_goals: 0,
            strategy: c.attrs.strategy,
          },
          population,
        }),
      );
    }
    if (population === 0) return notRead("dg_campaign_settings");
    if (!anyOverride && !anyGoals)
      return {
        state: "not_checkable",
        reason: `no goal override and no conversion goal were read for any of the ${population} Demand Gen campaigns, so what they optimise towards cannot be told`,
        table: "campaignConversionGoals",
        category: "our_gap",
      };
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

// ---------------------------------------------------------------------------
// DG02 — asset set below the minimum
// ---------------------------------------------------------------------------

/** DG02's gaps for one campaign's assets (pure): text legs and ONE visual leg. */
export function dgAssetGaps(
  assets: ReadonlyArray<{
    attrs: { fieldType: string | null; adType?: string | null | undefined };
  }>,
  min: { headlines: number; descriptions: number; imagesWithoutVideo: number },
): Record<string, number> {
  const gaps: Record<string, number> = {};
  const legs = [
    { match: /^HEADLINE$/i, min: min.headlines, label: "headlines" },
    { match: /^DESCRIPTION$/i, min: min.descriptions, label: "descriptions" },
  ];
  for (const leg of legs) {
    const have = assets.filter((a) => leg.match.test(a.attrs.fieldType ?? "")).length;
    if (have < leg.min) gaps[leg.label] = leg.min - have;
  }
  const images = assets.filter((a) => /IMAGE/i.test(a.attrs.fieldType ?? "")).length;
  const videos = assets.filter((a) => /VIDEO/i.test(a.attrs.fieldType ?? "")).length;
  // visuals are ONE leg: a video campaign is not short of images, an image campaign not of a
  // video. When every asset serves a video ad, the visual leg is a video.
  const adTypes = assets.map((a) => (a.attrs.adType ?? "").toUpperCase()).filter((t) => t !== "");
  const videoAdsOnly =
    adTypes.length > 0 &&
    adTypes.length === assets.length &&
    adTypes.every((t) => t.includes("VIDEO"));
  if (videoAdsOnly) {
    if (videos === 0) gaps["a video"] = 1;
    return gaps;
  }
  if (videos === 0 && images < min.imagesWithoutVideo)
    gaps[images === 0 ? "images or a video" : "images"] = min.imagesWithoutVideo - images;
  return gaps;
}

const DG02 = defineCheck({
  id: "DG02",
  claimKey: CLAIM_KEYS.DGEN_ASSETS_BELOW_MINIMUM,
  title: "Demand Gen asset set below the minimum",
  clientLabel: "Demand Gen campaigns short of headlines, descriptions or visuals",
  group: "demand_gen",
  metrics: ["C.spend"],
  confounders: ["DG01"],
  requires: ["campaigns", "dg_assets"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each Demand Gen campaign carries a full asset set.",
  run(ctx) {
    const gate = dgGate(ctx, this.requires);
    if (!Array.isArray(gate)) return gate;
    const s = ctx.settings.demandGen;
    const min = {
      headlines: s.minHeadlines,
      descriptions: s.minDescriptions,
      imagesWithoutVideo: s.minImagesWithoutVideo,
    };
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of gate) {
      const assets = c.children.dgAssets;
      if (assets == null) continue;
      population++;
      const gaps = dgAssetGaps(assets, min);
      if (Object.keys(gaps).length === 0) continue;
      const spend = ctx.get("C.spend", { campaignId: c.id });
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [spend].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: { gaps, assets: assets.length },
          population,
        }),
      );
    }
    if (population === 0) return notRead("dg_assets");
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

// ---------------------------------------------------------------------------
// DG03 — no audience on a spending campaign
// ---------------------------------------------------------------------------

const DG03 = defineCheck({
  id: "DG03",
  claimKey: CLAIM_KEYS.DGEN_AUDIENCE_SIGNALS_MISSING,
  title: "Demand Gen campaign with spend carries no audience",
  clientLabel: "Demand Gen campaigns spending with no audience",
  group: "demand_gen",
  metrics: ["C.spend"],
  confounders: ["DG01"],
  requires: ["campaigns", "dg_audience_signals"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each Demand Gen campaign with spend has an audience.",
  run(ctx) {
    const gate = dgGate(ctx, this.requires);
    if (!Array.isArray(gate)) return gate;
    const findings: CheckFinding[] = [];
    let population = 0;
    let read = 0;
    for (const c of gate) {
      const signals = c.children.dgAudienceSignals;
      if (signals == null) continue;
      read++;
      const spend = ctx.get("C.spend", { campaignId: c.id });
      const cost = num(spend);
      if (cost == null || cost <= 0) continue;
      population++;
      if (signals.length > 0) continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [spend].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: { audiences: 0, cost_90d: cost },
          population,
        }),
      );
    }
    if (read === 0) return notRead("dg_audience_signals");
    if (population === 0)
      return {
        state: "insufficient_data",
        reason: "no Demand Gen campaign spent in the window",
      };
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

// ---------------------------------------------------------------------------
// DG04 — one surface holds the campaign
// B12: measured inside the surfaces the campaign's channel controls ALLOW. A campaign
// set to one surface (Discover only, YouTube Shorts only) is concentrated by choice, so
// it is not judged; spend Google reports on a surface outside the controls is left out.
// ---------------------------------------------------------------------------

const DG04 = defineCheck({
  id: "DG04",
  claimKey: CLAIM_KEYS.DGEN_CHANNEL_CONCENTRATION,
  title: "one Demand Gen surface holds most of the spend",
  clientLabel: "Demand Gen spend sitting on one surface",
  group: "demand_gen",
  metrics: ["C.spend", "C.conv"],
  confounders: ["DG01", "MI01"],
  requires: ["campaigns", "dg_channel_distribution", "dg_channel_controls"],
  impactFormula: "IMP_CPA_GAP",
  noneFoundMeans: "Demand Gen spend is spread across the surfaces each campaign allows.",
  run(ctx) {
    const gate = dgGate(ctx, this.requires);
    if (!Array.isArray(gate)) return gate;
    const bar = ctx.settings.demandGen.channelConcentrationPct;
    const findings: CheckFinding[] = [];
    let population = 0;
    let oneSurface = 0;
    let controlsUnknown = 0;
    for (const c of gate) {
      const controls = c.attrs.dgChannelControls;
      if (controls == null) {
        controlsUnknown++;
        continue;
      }
      const allowed = controls.allowedNetworks;
      if (allowed != null && allowed.length <= 1) {
        oneSurface++;
        continue;
      }
      const channels = c.children.channels.filter(
        (ch) => allowed == null || allowed.includes(ch.attrs.adNetworkType.toUpperCase()),
      );
      if (channels.length === 0) continue;
      const total = channels.reduce((s, ch) => s + (ch.windows.m90.cost ?? 0), 0);
      if (total <= 0) continue;
      population++;
      const top = channels.reduce((a, b) =>
        (a.windows.m90.cost ?? 0) >= (b.windows.m90.cost ?? 0) ? a : b,
      );
      const share = ((top.windows.m90.cost ?? 0) / total) * 100;
      if (share <= bar) continue;
      const spend = ctx.get("C.spend", { campaignId: c.id });
      const conv = ctx.get("C.conv", { campaignId: c.id });
      const campaignConv = num(conv);
      const cite: MetricValue[] = [spend, conv].filter(isOk);
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: {
            type: "channel",
            id: top.id,
            name: top.attrs.adNetworkType,
            campaignId: c.id,
            campaignName: c.name,
          },
          cite,
          entity: { id: top.id, name: top.attrs.adNetworkType },
          facts: {
            surface: top.attrs.adNetworkType,
            cost_share_pct: Number(share.toFixed(1)),
            bar_pct: bar,
            surface_cost_90d: top.windows.m90.cost,
            surface_conv_90d: top.windows.m90.conv ?? 0,
            campaign_conv_90d: campaignConv,
            // null = every surface allowed
            allowed_surfaces: allowed == null ? null : allowed.join(", "),
          },
          population,
          note:
            campaignConv != null && campaignConv > 0
              ? undefined
              : "concentration only: the campaign has no conversion, so the surface's return cannot be measured",
        }),
      );
    }
    if (population === 0) {
      if (controlsUnknown > 0 && oneSurface === 0)
        return {
          state: "not_checkable",
          reason:
            "the Demand Gen ad groups' channel controls could not be read, so where each campaign may show is unknown",
          table: "dg_channel_controls",
          category: "our_gap",
        };
      // N9: one surface on purpose is not thin traffic: nothing to compare across surfaces
      if (oneSurface > 0)
        return {
          state: "not_checkable",
          reason: `${oneSurface} Demand Gen campaign(s) are set to show on one surface only, and no other has spend split by surface in the window`,
          table: "dg_channel_controls",
          category: "nothing_to_compare",
        };
      return {
        state: "insufficient_data",
        reason: "no Demand Gen campaign has spend split by surface in the window",
      };
    }
    return findings.length > 0
      ? { state: "fires", findings }
      : {
          state: "none_found",
          population,
          ...(oneSurface > 0 || controlsUnknown > 0
            ? {
                note: [
                  oneSurface > 0 ? `${oneSurface} campaign(s) set to one surface not judged` : "",
                  controlsUnknown > 0
                    ? `${controlsUnknown} campaign(s) with unreadable channel controls not judged`
                    : "",
                ]
                  .filter(Boolean)
                  .join("; "),
              }
            : {}),
        };
  },
});

// ---------------------------------------------------------------------------
// DG06 — product feed attached, nothing sold
// ---------------------------------------------------------------------------

const DG06 = defineCheck({
  id: "DG06",
  claimKey: CLAIM_KEYS.DGEN_FEED_ATTACHED_NO_SALES,
  title: "Demand Gen product feed attached with zero conversions",
  clientLabel: "Demand Gen campaigns with a product feed and no sales",
  group: "demand_gen",
  metrics: ["C.spend", "C.conv"],
  // TR06 measures the same money; the two collapse to one root cause downstream
  confounders: ["TR06", "MI01", "SH01"],
  requires: ["campaigns", "dg_campaign_settings"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "Each Demand Gen campaign with a product feed is converting.",
  run(ctx) {
    const gate = dgGate(ctx, this.requires);
    if (!Array.isArray(gate)) return gate;
    const findings: CheckFinding[] = [];
    let population = 0;
    let read = 0;
    for (const c of gate) {
      const dg = c.attrs.demandGen;
      if (!dg || dg.state !== "synced") continue;
      read++;
      // null is unknown, not "attached"
      if (dg.productFeedDisabled !== false) continue;
      population++;
      const spend = ctx.get("C.spend", { campaignId: c.id });
      const conv = ctx.get("C.conv", { campaignId: c.id });
      const cost = num(spend);
      const conversions = num(conv);
      if (cost == null || conversions == null || cost <= 0 || conversions !== 0) continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [spend, conv].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: { wasted_cost_90d: cost, conv: conversions, "C.spend": cost },
          population,
          note: "same money as TR06: one root cause, never counted twice",
        }),
      );
    }
    if (read === 0) return notRead("dg_campaign_settings");
    if (population === 0)
      return {
        state: "not_checkable",
        reason: "no Demand Gen campaign has a product feed attached",
        table: "dg_campaign_settings",
        category: "not_present",
      };
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

export const DEMAND_GEN_CHECKS: CheckDefinition[] = [DG01, DG02, DG03, DG04, DG06];
