// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Entity activity — the ONE definition of "is this thing switched on", shared
 * by every check (A1; rules 107, 108, 142, 342, 345, 383, 384, 392).
 *
 * Without one shared definition a finding about a paused campaign can be
 * reported as a present-tense warning.
 *
 * Three states, not a boolean, because the old rules distinguish them
 *:
 *
 *   live             status ENABLED. Full analysis, and the ONLY state that
 *                    may carry a finding (see `isReportable`).
 *   recently-active  PAUSED but with cost in the window. Real money was spent,
 *                    so the fact is worth keeping as past-tense context — but
 * it is NOT reportable as a finding.
 *   dormant          PAUSED with no spend in the window, REMOVED, or an UNKNOWN
 *                    status. No finding at all (rule 383). Rule 4 of the
 *                    handover: unknown is unknown, never a licence.
 *
 * REMOVED is dormant whatever it spent: rule 383 and the plan text both say
 * "paused with no spend in the window, and REMOVED, produce no finding at all",
 * and that is also what `isEligibleCampaign` has always done.
 *
 * "Spend in the window" is `windows.m90.cost`, the same measure
 * `isEligibleCampaign` used, so no consumer changes meaning by adopting this.
 */
import type { AccountModel } from "../model/nodes/AccountNode.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";

export type EntityActivity = "live" | "recently-active" | "dormant";

/**
 * What the classifier needs. `status` is BaseNode's (campaigns, ad groups,
 * keywords, ads, extensions, search terms all carry it); `attrs.status` is the
 * explicit typed carrier the leaf nodes now declare. Either may be absent, and
 * absent means UNKNOWN, never ENABLED.
 */
export interface ActivityBearing {
  status?: string | undefined;
  /** every node's attrs bag; typed `unknown` so any node shape satisfies it, read through `statusOf` only. */
  attrs?: unknown | undefined;
  windows: { m90: { cost: number | null } };
}

/** The raw Google status, upper-cased, or null when the model never stored one. */
export function statusOf(node: ActivityBearing): string | null {
  const fromAttrs =
    node.attrs && typeof node.attrs === "object"
      ? (node.attrs as { status?: unknown }).status
      : undefined;
  const raw = (typeof fromAttrs === "string" ? fromAttrs : null) ?? node.status ?? null;
  const s = raw == null ? "" : String(raw).trim().toUpperCase();
  return s === "" ? null : s;
}

export function classifyActivity(node: ActivityBearing): EntityActivity {
  const s = statusOf(node);
  if (s === "ENABLED") return "live";
  if (s === "PAUSED" && (node.windows.m90.cost ?? 0) > 0) return "recently-active";
  return "dormant";
}

/**
 * Does this entity's money count toward the account's arithmetic?
 *
 * YES for anything that spent, including a campaign paused mid-window. This is
 * NOT the same question as `isReportable`, and conflating the two is a bug we
 * have already made once: when `isEligibleCampaign` delegated to `isReportable`
 * and `isReportable` went live-only, the paused campaigns' spend vanished from
 * the account's 90-day denominator. Telling a client they spent less than Google
 * invoiced is exactly the class of false claim this module exists to remove; it
 * just points the other way.
 *
 * Spent money was spent. Whether we may make a CLAIM about the thing that spent
 * it is a separate question, answered below.
 */
export function countsTowardSpend(node: ActivityBearing): boolean {
  return classifyActivity(node) !== "dormant";
}

/**
 * Only a LIVE entity gets a finding (decision; supersedes the older
 * rule 108 carve-out for `recently-active`).
 *
 * The carve-out was: a paused campaign that spent in the window keeps its
 * finding as long as the prose discloses the status. But a monthly-waste
 * figure about a paused campaign is false whatever the caveat. Disclosure does not repair a present-tense claim about
 * money that is not moving, and `IMP_WASTE_90` (90-day cost / 3) has no way to
 * express a rate that already stopped.
 *
 * `classifyActivity` still returns three states on purpose — `recently-active`
 * is real information and belongs in a past-tense context line — but it is no
 * longer a licence to make a finding.
 */
export function isReportable(node: ActivityBearing): boolean {
  return classifyActivity(node) === "live";
}

/**
 * Round 4 item 5: a child (asset group, ad group) is live only when it AND the
 * campaign above it are ENABLED. A paused seasonal group inside a running
 * campaign is not live, and neither is an enabled group inside a paused campaign.
 */
export function isLiveUnder(node: ActivityBearing, parent: ActivityBearing): boolean {
  return isReportable(node) && isReportable(parent);
}

/** Round 4 item 5: the asset groups of a campaign that are actually serving (both statuses ENABLED). */
export function liveAssetGroupsOf<G extends ActivityBearing>(
  campaign: ActivityBearing & { children: { assetGroups: readonly G[] } },
): G[] {
  return isReportable(campaign) ? campaign.children.assetGroups.filter((g) => isReportable(g)) : [];
}

/**
 * The campaign set a check may iterate, count and name (rule 384: never put a
 * dormant campaign in an "X of Y" count). Only live campaigns, always.
 *
 * There used to be an exception: when every campaign was dormant, every campaign
 * was returned and the activity gate stood down. Since the campaigns read keeps
 * idle paused and removed-with-activity campaigns, that exception was reachable
 * and put findings (and money) on paused and deleted campaigns. An account that
 * ran nothing is said once by the engine's no-activity path instead.
 */
export function reportableCampaigns(model: AccountModel): CampaignNode[] {
  return model.children.campaigns.filter(isReportable);
}
