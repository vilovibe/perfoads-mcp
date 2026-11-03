// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * ROLES — who a check is allowed to judge.
 *
 * WHY THIS EXISTS
 * ---------------
 * A check answers "is proposition P true of entity E?" and the same fact means
 * opposite things depending on what E is FOR. "The account's conversion
 * actions run on 2 different attribution models" is false when only ONE action
 * is primary and the "second model" belongs to a REMOVED or dormant secondary.
 *
 * A secondary action may legitimately record nothing: it is not connected as a
 * primary goal, so it never had to carry value.
 *
 * A secondary action recording nothing is CORRECT BEHAVIOUR. A primary action
 * recording nothing is an outage. One fact, two meanings, and no check could
 * tell them apart.
 *
 * WHAT THIS FILE IS
 * -----------------
 * One definition per role, in one place, used by BOTH the metric registry and
 * the checks — so a metric and a check can never disagree about what "primary"
 * means. Every predicate is pure and total: an unknown status is never quietly
 * read as a good one.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * It is not a severity or relevance judgement. "Does this entity belong in the
 * population being judged" is all it answers. How much a finding matters is
 * `governedSpend` (money weight), and whether it is a finding at all is the
 * check's own business.
 */
import { statusOf } from "./registry/entityStatus.js";
import type { AccountModel } from "./model/nodes/AccountNode.js";
import type { CampaignNode } from "./model/nodes/CampaignNode.js";
import type { ConversionActionNode } from "./model/nodes/ConversionActionNode.js";
import type { AssetGroupNode } from "./model/nodes/AssetGroupNode.js";

// ---------------------------------------------------------------------------
// conversion actions
// ---------------------------------------------------------------------------

/**
 * REMOVED is Google's word for deleted. A deleted action is not a setting the
 * client can fix and not a signal about how the account measures anything; it
 * is a tombstone the API still returns. An account can carry many REMOVED
 * actions, and they must never be counted in an account-level claim.
 */
export function conversionActionIsLive(a: ConversionActionNode): boolean {
  const s = String(a.attrs.status ?? "")
    .trim()
    .toUpperCase();
  // Unknown status is treated as live: an absent status must not silently
  // delete an action from a population, which would hide a real finding.
  return s !== "REMOVED";
}

/**
 * The actions that DECIDE what the account optimises towards. Everything the
 * bidding reads, and nothing else.
 *
 * A secondary action is an observation the advertiser wanted recorded. It is
 * allowed to carry no value, no data and its own attribution model, because
 * nothing bids on it. Judging the account's measurement by its secondaries is
 * judging a business by its notes.
 */
export function conversionActionIsBidding(a: ConversionActionNode): boolean {
  // Primary is not enough: a hidden old import or a goal no campaign uses can
  // stay primary while Google leaves it out of the Conversions column. Only an
  // explicit false drops it; not read (null) keeps the primary rule.
  // HIDDEN is Google's word for an action the advertiser can no longer see or
  // manage (old Analytics imports). Google can still mark it primary and in the
  // column, but nothing new reaches it: it is history, not measurement.
  const s = String(a.attrs.status ?? "")
    .trim()
    .toUpperCase();
  return (
    conversionActionIsLive(a) &&
    s !== "HIDDEN" &&
    a.attrs.isPrimary === true &&
    a.attrs.includeInConversions !== false
  );
}

/**
 * The goals (category x origin) some ENABLED campaign bids on, from
 * campaign_conversion_goals. null when no live campaign carries goal rows (not
 * read, or none live): then no action is dropped for its goal.
 */
function goalsLiveCampaignsBidOn(model: AccountModel): Set<string> | null {
  const keys = new Set<string>();
  let read = false;
  for (const c of model.children.campaigns) {
    if (!campaignIsEnabled(c)) continue;
    const goals = c.attrs.conversionGoals ?? [];
    if (goals.length === 0) continue;
    read = true;
    for (const g of goals) if (g.biddable) keys.add(`${g.category}|${g.origin}`);
  }
  return read ? keys : null;
}
/** Live secondaries. They have their own, much smaller, set of legitimate findings. */
export function conversionActionIsSecondary(a: ConversionActionNode): boolean {
  return conversionActionIsLive(a) && a.attrs.isPrimary !== true;
}

export function biddingConversionActions(model: AccountModel): ConversionActionNode[] {
  const bidOn = goalsLiveCampaignsBidOn(model);
  return model.children.conversionActions.filter((a) => {
    if (!conversionActionIsBidding(a)) return false;
    // A primary action whose goal no live campaign bids on decides nothing.
    // Unknown category or origin keeps the action: never drop on a guess.
    if (bidOn == null || a.attrs.category == null || a.attrs.origin == null) return true;
    return bidOn.has(`${a.attrs.category}|${a.attrs.origin}`);
  });
}

export function liveConversionActions(model: AccountModel): ConversionActionNode[] {
  return model.children.conversionActions.filter(conversionActionIsLive);
}

// ---------------------------------------------------------------------------
// campaigns
// ---------------------------------------------------------------------------

/** Serving now. A paused campaign's settings are not a defect to fix; turning it on is the only advice about it. */
export function campaignIsEnabled(c: CampaignNode): boolean {
  return statusOf(c) === "ENABLED";
}

/** Spent money in the window, whatever it is doing now — the population for any waste claim. */
export function campaignSpent(c: CampaignNode): boolean {
  return (c.windows?.m90?.cost ?? 0) > 0;
}

export function enabledCampaigns(model: AccountModel): CampaignNode[] {
  return model.children.campaigns.filter(campaignIsEnabled);
}

export function spendingCampaigns(model: AccountModel): CampaignNode[] {
  return model.children.campaigns.filter(campaignSpent);
}

// ---------------------------------------------------------------------------
// asset groups
// ---------------------------------------------------------------------------

export function assetGroupIsEnabled(g: AssetGroupNode): boolean {
  return statusOf(g as never) === "ENABLED";
}

/**
 * Carries spend in the window. A zero-spend asset group cannot waste money and
 * cannot be the reason a campaign underperforms, so a waste or performance
 * claim about it is noise wearing a finding's clothes.
 */
export function assetGroupSpent(g: AssetGroupNode): boolean {
  return ((g as { windows?: { m90?: { cost?: number | null } } }).windows?.m90?.cost ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// the declaration a check carries
// ---------------------------------------------------------------------------

/**
 * What a check says about the population it judges. It is documentation the
 * report can print AND a contract a test can hold it to — the population on the
 * card must equal the population the check declares, so "10 of 11" cannot be
 * printed by a check that declares it only judges the primary one.
 */
export interface JudgedPopulation {
  conversionActions?: "bidding" | "live" | "secondary" | "all" | undefined;
  campaigns?: "enabled" | "spending" | "reportable" | "all" | undefined;
  assetGroups?: "enabled" | "with_spend" | "all" | undefined;
  products?: "servable" | "all" | undefined;
  /** why this population and not a wider one, in one line, for the reader and the next maintainer */
  because?: string | undefined;
}

/** Human wording for the population, so a card can say who was judged rather than implying everyone was. */
export function describePopulation(j: JudgedPopulation | undefined): string | null {
  if (!j) return null;
  const bits: string[] = [];
  if (j.conversionActions === "bidding") bits.push("the conversion actions the bidding uses");
  if (j.conversionActions === "live") bits.push("the conversion actions that still exist");
  if (j.conversionActions === "secondary") bits.push("the secondary conversion actions");
  if (j.campaigns === "enabled") bits.push("the campaigns that are running");
  if (j.campaigns === "spending") bits.push("the campaigns that spent money");
  if (j.assetGroups === "enabled") bits.push("the asset groups that are running");
  if (j.assetGroups === "with_spend") bits.push("the asset groups that spent money");
  if (j.products === "servable") bits.push("the products that can actually be shown");
  return bits.length === 0 ? null : bits.join(" and ");
}
