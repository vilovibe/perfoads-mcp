// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Presence: PR01 (frequency caps on reach campaigns), PR02 (the channel types
 * the account runs and their spend share), PR03 (Local Services leads came in)
 * and PR04-PR07 (Local Services lead flow, in lsa.ts). A setting that was not
 * read is "not read", never "not configured".
 */
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import { eligibleCampaigns } from "../registry/index.js";
import type { CampaignType } from "../model/nodes/CampaignNode.js";
import {
  campaignsOf,
  type CheckCtx,
  type CheckDefinition,
  type CheckResult,
  type CheckScope,
  defineCheck,
  finding,
  gateOnData,
  isOk,
  num,
} from "./types.js";
import { LSA_CHECKS, lsaGate, rowsRead } from "./lsa.js";

const ACCOUNT_SCOPE: CheckScope = { type: "account", id: null, name: null };

/** Channel types a frequency cap is a real setting for. */
const REACH_TYPES: CampaignType[] = ["DISPLAY", "VIDEO", "DEMAND_GEN"];

/**
 * PR01. Google's only cap field is `campaign.frequency_caps`, defined for Display
 * and Video campaigns (https://support.google.com/google-ads/answer/117579). It
 * does not return a Demand Gen cap, so a Demand Gen campaign passes only on a
 * recorded cap and is otherwise "cannot be told", never "no cap".
 */
const PR01 = defineCheck({
  id: "PR01",
  claimKey: CLAIM_KEYS.REACH_FREQUENCY_CAP_MISSING,
  title: "reach campaign without a frequency cap",
  clientLabel: "reach campaigns with no frequency cap",
  notCheckableCategory: "our_gap",
  group: "presence",
  metrics: ["C.frequency_caps_present"],
  confounders: ["TR06"],
  requires: ["campaign_control_settings"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each reach campaign has a frequency cap.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["campaign_control_settings"]);
    if (g) return g;
    const reach = campaignsOf(ctx).filter((c) => REACH_TYPES.includes(c.attrs.type));
    if (reach.length === 0)
      return {
        state: "not_checkable",
        reason: "no Display, Video or Demand Gen campaign on this account",
        category: "not_present",
      };

    const dg = reach.filter((c) => c.attrs.type === "DEMAND_GEN");
    const judgeable = reach.filter((c) => c.attrs.type !== "DEMAND_GEN");
    const stateOf = (c: (typeof reach)[number]): "set" | "none_returned" | null =>
      c.attrs.controlSettings?.frequencyCaps != null
        ? "set"
        : (c.attrs.controlSettings?.frequencyCapsState ?? null);
    if (judgeable.length === 0) {
      const dgCapped = (c: (typeof reach)[number]): boolean =>
        c.attrs.controlSettings?.frequencyCapsState === "set";
      if (dg.every(dgCapped)) return { state: "none_found", population: dg.length };
      const unknown = dg.filter((c) => !dgCapped(c));
      return {
        state: "not_checkable",
        reason: `Google doesn't return a frequency cap for ${unknown.length === 1 ? `the Demand Gen campaign "${unknown[0]!.name}"` : `these ${unknown.length} Demand Gen campaigns`}, so whether ${unknown.length === 1 ? "it has one" : "they have one"} cannot be told from the data`,
        table: "campaign_control_settings",
        category: "google_withholds",
      };
    }
    const knownState = judgeable.filter((c) => stateOf(c) != null);
    if (knownState.length < judgeable.length) {
      return {
        state: "not_checkable",
        reason: `the frequency cap of ${judgeable.length - knownState.length} Display or Video campaign(s) was not read — not read is never "no cap"`,
        table: "campaign_control_settings",
        category: "our_gap",
      };
    }
    const uncapped = knownState.filter((c) => stateOf(c) === "none_returned");
    if (uncapped.length === 0) return { state: "none_found", population: knownState.length };
    return {
      state: "fires",
      findings: uncapped.map((c) =>
        finding({
          claimKey: CLAIM_KEYS.REACH_FREQUENCY_CAP_MISSING,
          scope: {
            type: "campaign",
            id: c.id,
            name: c.name,
            campaignId: c.id,
            campaignName: c.name,
          },
          cite: [
            ctx.get("C.frequency_caps_present", { campaignId: c.id }),
            ctx.get("C.spend", { campaignId: c.id }),
          ].filter(isOk),
          entity: { id: c.id, name: c.name },
          facts: {
            campaign_type: c.attrs.type,
            "C.spend": c.windows.m90.cost,
            frequency_caps_state: "none_returned",
          },
          population: knownState.length,
        }),
      ),
    };
  },
});

/** PR02 — the channel types the account runs and their spend share: a plain statement, never a fault. */
const PR02 = defineCheck({
  id: "PR02",
  claimKey: CLAIM_KEYS.CHANNEL_PRESENCE,
  title: "channel types present and their spend share",
  clientLabel: "the campaign types you run and their share of spend",
  group: "presence",
  metrics: ["C.spend", "A.spend"],
  confounders: [],
  requires: ["campaigns"],
  impactFormula: "IMP_NONE",
  noteOnly: "The campaign types the account runs, with their share of spend.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["campaigns"]);
    if (g) return g;
    const campaigns = campaignsOf(ctx);
    if (campaigns.length === 0)
      return {
        state: "not_checkable",
        reason: "no live campaign runs on this account",
        table: "campaigns",
        category: "not_present",
      };
    const acctV = ctx.get("A.spend");
    const acct = num(acctV);
    const counts: Record<string, number> = {};
    const spent: Record<string, number> = {};
    const spend: Record<string, number> = {};
    const notLiveSpend: Record<string, number> = {};
    const cite = [acctV];
    const liveIds = new Set(campaigns.map((c) => c.id));
    // the spend is the money A.spend is made of (every campaign that spent, paused included),
    // so the shares add up to 100. N8: each count says which set it counts: the live campaigns,
    // and the campaigns behind the spend (paused ones too), with the paused part of the spend
    for (const c of campaigns) counts[c.attrs.type] = (counts[c.attrs.type] ?? 0) + 1;
    for (const c of eligibleCampaigns(ctx.model)) {
      const sv = ctx.get("C.spend", { campaignId: c.id });
      if (isOk(sv)) cite.push(sv);
      const v = num(sv) ?? 0;
      spend[c.attrs.type] = (spend[c.attrs.type] ?? 0) + v;
      if (v > 0) spent[c.attrs.type] = (spent[c.attrs.type] ?? 0) + 1;
      if (v > 0 && !liveIds.has(c.id))
        notLiveSpend[c.attrs.type] = (notLiveSpend[c.attrs.type] ?? 0) + v;
    }
    const shares: Record<string, number | null> = {};
    for (const [t, s] of Object.entries(spend))
      shares[t] = acct && acct > 0 ? (s / acct) * 100 : null;
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.CHANNEL_PRESENCE,
          scope: ACCOUNT_SCOPE,
          cite: cite.filter(isOk),
          facts: {
            live_campaigns_by_type: counts,
            campaigns_with_spend_by_type: spent,
            spend_by_type: spend,
            spend_not_live_by_type: notLiveSpend,
            spend_share_pct_by_type: shares,
            "A.spend": acct,
          },
          population: campaigns.length,
        }),
      ],
    };
  },
});

/** PR03 — Local Services leads came in: a plain statement of the channel, never a fault. */
const PR03 = defineCheck({
  id: "PR03",
  claimKey: CLAIM_KEYS.LSA_PRESENCE,
  title: "Local Services Ads presence",
  clientLabel: "leads from Local Services Ads",
  noteOnly: "Local Services Ads bring leads to this account.",
  group: "presence",
  metrics: ["DQ.population[table]"],
  confounders: [],
  requires: ["lsaLeads"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "The Local Services campaign brought no lead in the window.",
  run(ctx: CheckCtx): CheckResult {
    const g = lsaGate(ctx, ["lsaLeads"]);
    if ("result" in g) return g.result;
    const leads = g.lsa.leads.length;
    if (leads === 0) return { state: "none_found", population: 0 };
    const charged = g.lsa.leads.filter((l) => l.charged).length;
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.LSA_PRESENCE,
          scope: ACCOUNT_SCOPE,
          cite: rowsRead(ctx, "lsaLeads"),
          facts: { lsa_leads: leads, lsa_leads_charged: charged },
          population: leads,
        }),
      ],
    };
  },
});

export const PRESENCE_CHECKS: CheckDefinition[] = [PR01, PR02, PR03, ...LSA_CHECKS];
