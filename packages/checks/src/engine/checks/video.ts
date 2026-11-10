// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Video (YouTube) campaigns: VD01-VD06. VD07 (cost per view) is in carriedIn.ts.
 *
 * The view numbers (views, view rate, cost per view, how far people watched) are
 * read per Video campaign. What is not read is said by each check: the targeting
 * criteria (VD03), companion banners (VD05) and each ad's format (VD06). An
 * account with no Video campaign gets "not present" from every check, never
 * clean.
 */
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import { VIDEO_METRICS_TABLE } from "../model/context.js";
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

const videoCampaigns = (ctx: CheckCtx): CampaignNode[] =>
  campaignsOf(ctx).filter((c) => c.attrs.type === "VIDEO");

const campaignScope = (c: CampaignNode) => ({
  type: "campaign" as const,
  id: c.id,
  name: c.name,
  campaignId: c.id,
  campaignName: c.name,
});

const noVideoCampaign: CheckResult = {
  state: "not_checkable",
  reason: "no Video campaign on this account",
  table: "campaigns",
  category: "not_present",
};

/** The campaigns read gate, then "is there a Video campaign", then the check's own tables. */
function videoGate(ctx: CheckCtx, tables: string[]): CampaignNode[] | CheckResult {
  const g = gateOnData(ctx, ["campaigns"]);
  if (g) return g;
  const campaigns = videoCampaigns(ctx);
  if (campaigns.length === 0) return noVideoCampaign;
  const t = gateOnData(ctx, tables);
  if (t) return t;
  return campaigns;
}

// ---------------------------------------------------------------------------
// VD01 — view rate below the bar
// ---------------------------------------------------------------------------

const VD01 = defineCheck({
  id: "VD01",
  claimKey: CLAIM_KEYS.VIDEO_VIEW_RATE_LOW,
  title: "Video campaign view rate below the bar",
  clientLabel: "video view rate",
  group: "video",
  metrics: ["C.impr"],
  confounders: ["MI06"],
  requires: ["campaigns", VIDEO_METRICS_TABLE],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Each Video campaign clears the view-rate bar.",
  run(ctx) {
    const gate = videoGate(ctx, this.requires);
    if (!Array.isArray(gate)) return gate;
    const s = ctx.settings.video;
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of gate) {
      const impr = ctx.get("C.impr", { campaignId: c.id });
      const impressions = num(impr);
      if (impressions == null || impressions < s.minImpressions) continue;
      for (const v of c.children.videoMetrics ?? []) {
        if (v.attrs.internallyInconsistent) continue;
        const viewRate = v.attrs.viewRate;
        if (viewRate == null) continue;
        population++;
        if (viewRate >= s.viewRateMin) continue;
        findings.push(
          finding({
            claimKey: this.claimKey,
            scope: campaignScope(c),
            cite: [impr].filter(isOk),
            entity: { id: c.id, name: c.name },
            facts: { view_rate: viewRate, impressions, bar: s.viewRateMin },
            population,
          }),
        );
      }
    }
    if (population === 0)
      return {
        state: "insufficient_data",
        reason: `no Video campaign has ${s.minImpressions} impressions and a view rate in the window`,
      };
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

// ---------------------------------------------------------------------------
// VD02 — viewers leave before the end
// ---------------------------------------------------------------------------

const VD02 = defineCheck({
  id: "VD02",
  claimKey: CLAIM_KEYS.VIDEO_QUARTILE_DROPOFF,
  title: "most Video viewers leave before the end",
  clientLabel: "how many video viewers leave before the end",
  group: "video",
  metrics: ["C.impr"],
  confounders: ["VD01"],
  requires: ["campaigns", VIDEO_METRICS_TABLE],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Video completion holds up across the quartile curve.",
  run(ctx) {
    const gate = videoGate(ctx, this.requires);
    if (!Array.isArray(gate)) return gate;
    const max = ctx.settings.video.quartileDropoffMax;
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of gate) {
      for (const v of c.children.videoMetrics ?? []) {
        if (v.attrs.internallyInconsistent) continue;
        const { q25, q100 } = v.attrs;
        if (q25 == null || q100 == null || (v.attrs.videoViews ?? 0) <= 0) continue;
        population++;
        if (q25 - q100 <= max) continue;
        const impr = ctx.get("C.impr", { campaignId: c.id });
        findings.push(
          finding({
            claimKey: this.claimKey,
            scope: campaignScope(c),
            cite: [impr].filter(isOk),
            entity: { id: c.id, name: c.name },
            facts: { q25, q100, dropoff: Number((q25 - q100).toFixed(4)), bar: max },
            population,
          }),
        );
      }
    }
    if (population === 0)
      return {
        state: "insufficient_data",
        reason: "no Video campaign had views with quartile numbers in the window",
      };
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

// ---------------------------------------------------------------------------
// VD03 — nothing bounds the targeting (the criteria are not read)
// ---------------------------------------------------------------------------

const VD03 = defineCheck({
  id: "VD03",
  claimKey: CLAIM_KEYS.VIDEO_TARGETING_UNBOUNDED,
  title: "Video campaign with spend has no targeting criterion",
  clientLabel: "video campaigns spending with no targeting",
  group: "video",
  metrics: ["C.spend"],
  confounders: ["VD01"],
  requires: ["campaigns"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "Every Video campaign with spend is bounded by a targeting criterion.",
  run(ctx) {
    const gate = videoGate(ctx, this.requires);
    if (!Array.isArray(gate)) return gate;
    // a "no criterion" claim built from criteria never read would be a guess
    return {
      state: "not_checkable",
      reason: `the targeting of ${gate.length} Video campaign(s) (topics, placements, keywords, audiences) is not read, so "nothing bounds it" cannot be told`,
      table: "campaigns",
      category: "our_gap",
    };
  },
});

// ---------------------------------------------------------------------------
// VD04 — view-through carries a Video campaign's reported result
// ---------------------------------------------------------------------------

const VD04 = defineCheck({
  id: "VD04",
  claimKey: CLAIM_KEYS.VIDEO_VIEWTHROUGH_SHARE_HIGH,
  title: "view-through carries most of a Video campaign's reported conversions",
  clientLabel: "video conversions that came from views, not clicks",
  group: "video",
  metrics: ["C.viewthrough_share", "C.spend"],
  confounders: ["MI01", "MI05", "MI06"],
  requires: ["campaigns", "campaign_control_settings"],
  impactFormula: "IMP_MEASUREMENT",
  noneFoundMeans: "View-through conversions stay under the bar on the Video campaigns.",
  run(ctx) {
    const gate = videoGate(ctx, this.requires);
    if (!Array.isArray(gate)) return gate;
    const bar = ctx.settings.video.viewThroughSharePct;
    const findings: CheckFinding[] = [];
    let population = 0;
    for (const c of gate) {
      // purchases by click / view when read (same as MI06); a type we cannot name = no share
      const ps = c.attrs.controlSettings?.purchaseSplit ?? null;
      if (ps && ps.unnamed > 0) continue;
      const psTotal = ps ? ps.click + ps.view : 0;
      const split = ps && psTotal > 0 && psTotal >= ctx.settings.floors.strongConv;
      const share = ctx.get("C.viewthrough_share", { campaignId: c.id });
      if (!split && !isOk(share)) continue;
      population++;
      const pct = split && ps ? Math.round((ps.view / psTotal) * 1000) / 10 : num(share);
      // the bar is "inflated": 20% exactly counts
      if (pct == null || pct < bar) continue;
      const spend = ctx.get("C.spend", { campaignId: c.id });
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: campaignScope(c),
          cite: [...(split ? [] : [share]), spend].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: {
            viewthrough_share_pct: pct,
            bar_pct: bar,
            spend_90d: num(spend),
            ...(split ? { purchase_view_share: pct } : {}),
          },
          population,
        }),
      );
    }
    if (population === 0)
      return {
        state: "insufficient_data",
        reason:
          "no Video campaign has a view-through share to judge (no conversions in the window)",
      };
    return findings.length > 0 ? { state: "fires", findings } : { state: "none_found", population };
  },
});

// ---------------------------------------------------------------------------
// VD05 / VD06 — companion banners and the ad format mix (not read)
// ---------------------------------------------------------------------------

const VD05 = defineCheck({
  id: "VD05",
  claimKey: CLAIM_KEYS.VIDEO_COMPANION_BANNER_MISSING,
  title: "skippable in-stream ad with no companion banner",
  clientLabel: "skippable video ads with no companion banner",
  group: "video",
  metrics: [],
  confounders: ["VD06"],
  requires: ["campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Every skippable in-stream ad carries a companion banner.",
  run(ctx) {
    const gate = videoGate(ctx, this.requires);
    if (!Array.isArray(gate)) return gate;
    return {
      state: "not_checkable",
      reason: `each Video ad's format and companion banner are not read, so a missing banner on ${gate.length} Video campaign(s) cannot be told`,
      table: "ads",
      category: "our_gap",
    };
  },
});

const VD06 = defineCheck({
  id: "VD06",
  claimKey: CLAIM_KEYS.VIDEO_FORMAT_MIX_UNKNOWN,
  title: "Video ad format mix is not knowable",
  clientLabel: "the mix of video ad formats",
  group: "video",
  selfAudit: "the format of each video ad is not read, so the mix of formats cannot be stated",
  metrics: [],
  confounders: [],
  requires: ["campaigns"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "The skippable / non-skippable / bumper / in-feed mix is known.",
  run(ctx) {
    const gate = videoGate(ctx, this.requires);
    if (!Array.isArray(gate)) return gate;
    return {
      state: "not_checkable",
      reason: `each Video ad's format (skippable, non-skippable, bumper, in-feed) is not read for ${gate.length} Video campaign(s)`,
      table: "ads",
      category: "our_gap",
    };
  },
});

export const VIDEO_CHECKS: CheckDefinition[] = [VD01, VD02, VD03, VD04, VD05, VD06];
