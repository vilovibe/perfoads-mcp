// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Structure checks AS01-AS17: account settings, lists, budgets, access and
 * change history. Mostly structural findings with no dollar claim.
 *
 * Every check is a pure read over the account model + the metric registry.
 * `gateOnData` is called first in every `run`: a table with no read status and
 * no rows is not checkable, never "none found".
 *
 * Two rules this file keeps:
 *   - an UNKNOWN auto-apply type is an API value this version could not name;
 *     AS04 says so and never invents a name for it;
 *   - the change history is read up to a row limit. AS11 reports the limit, and
 *     AS10 / AS13 never claim anything about review or oversight from it.
 */
import {
  campaignsOf,
  type CheckCtx,
  type CheckDefinition,
  type CheckFinding,
  type CheckResult,
  defineCheck,
  evidence as evidenceOf,
  finding,
  gateOnData,
  isOk,
  lostIsBudgetNow,
  num,
  str,
} from "./types.js";
import { isReportable, statusOf } from "../registry/entityStatus.js";
import { eligibleCampaigns } from "../registry/metrics.js";
import { negativeMatches } from "../model/buildNegatives.js";
import { foldBrandText } from "../shared/campaignClassification.js";
import { requiredListCoverageOf } from "../registry/metrics.js";
import { ESSENTIAL_ROLES, ESSENTIAL_ROLE_LABELS } from "../shared/audienceRoles.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";

const NEGATIVE_CRITERIA = "account_negative_criteria";

/** Auto-apply types that only touch ad text, assets or rotation (AS04): harmless to leave on. */
const COSMETIC_AUTO_APPLY_TYPES: ReadonlySet<string> = new Set([
  "OPTIMIZE_AD_ROTATION",
  "TEXT_AD",
  "RESPONSIVE_SEARCH_AD",
  "RESPONSIVE_SEARCH_AD_ASSET",
  "RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH",
  "CALLOUT_ASSET",
  "SITELINK_ASSET",
  "CALL_ASSET",
  "STRUCTURED_SNIPPET_ASSET",
  "DYNAMIC_IMAGE_EXTENSION_OPT_IN",
  "IMPROVE_PERFORMANCE_MAX_AD_STRENGTH",
]);

/** True only for a type on the explicit harmless list above. */
function isCosmeticAutoApplyType(type: unknown): boolean {
  return typeof type === "string" && COSMETIC_AUTO_APPLY_TYPES.has(type.trim().toUpperCase());
}

/** Bidding strategies that carry an explicit value or CPA target (AS02). */
function hasValueOrCpaTarget(
  strategy: string | null,
  targetRoas: number | null,
  targetCpa: number | null,
): boolean {
  const s = String(strategy ?? "").toUpperCase();
  if (s === "TARGET_ROAS" || s === "TARGET_CPA") return true;
  if (s === "MAXIMIZE_CONVERSION_VALUE" && targetRoas != null && targetRoas > 0) return true;
  if (s === "MAXIMIZE_CONVERSIONS" && targetCpa != null && targetCpa > 0) return true;
  return false;
}

/** Channels whose inventory brand-safety exclusions apply to (AS07). */
const EXCLUSION_RELEVANT_TYPES = new Set(["DISPLAY", "VIDEO", "PERFORMANCE_MAX", "DEMAND_GEN"]);

// ---------------------------------------------------------------------------

/** AS01 — brand campaigns take 30% or more of spend (crisis at 70%). */
const AS01 = defineCheck({
  id: "AS01",
  claimKey: "brand.spend_share_high",
  title: "brand campaigns take a large share of spend",
  group: "structure",
  metrics: [
    "A.brand_spend_share",
    "A.brand_spend",
    "A.brand_roas",
    "A.spend",
    "A.acquisition_roas",
  ],
  confounders: ["MI01", "AS02", "PX02"],
  requires: ["campaigns"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Brand campaigns take less than the brand-share bar of spend (30% by default).",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["campaigns"]);
    if (gate) return gate;

    /**
     * The COUNT here must be the set whose money the share is made of, not the set
     * we may make claims about. `A.brand_spend_share` and `A.brand_roas` come off
     * the registry, which counts every campaign that SPENT in the window
     * (`countsTowardSpend`), paused included — spent money was spent. Counting only
     * the live ones made the note's own sentence false: it said "brand campaigns (2)
     * take 6.52% of spend ... one campaign set, both numbers", while the 6.52% was
     * four campaigns' money. A reader dividing that share by 2 gets a wrong figure.
     * So this counts the same four (2026-09-07).
     */
    const brandCampaigns = eligibleCampaigns(ctx.model).filter((c) => c.attrs.isBrand);
    if (brandCampaigns.length === 0) {
      return {
        state: "not_checkable",
        reason: "no campaign is classified brand; a brand share cannot be stated",
        table: "campaigns",
        category: "not_present",
      };
    }

    const share = ctx.get("A.brand_spend_share");
    const pct = num(share);
    if (pct == null)
      return {
        state: "not_checkable",
        reason: `A.brand_spend_share is ${isOk(share) ? "non-numeric" : share.reason}`,
      };

    // Rule §6.7: both numbers below are about the SAME set — all brand campaigns.
    // A single campaign's ROAS may only appear with that campaign named.
    const brandSpend = ctx.get("A.brand_spend");
    const brandRoas = ctx.get("A.brand_roas");
    const scopeNote = `brand campaigns (${brandCampaigns.length}) take ${pct.toFixed(2)}% of spend and return ${num(brandRoas)?.toFixed(2) ?? "?"}x — one campaign set, both numbers`;

    if (pct < ctx.settings.structure.brandSpendSharePct) {
      return { state: "none_found", population: brandCampaigns.length, note: scopeNote };
    }
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "brand.spend_share_high",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [share, brandSpend, brandRoas, ctx.get("A.spend")],
          facts: { brand_spend_share: pct, brand_campaigns: brandCampaigns.length },
          population: brandCampaigns.length,
          note: scopeNote,
        }),
      ],
    };
  },
});

/** AS02 — a brand campaign runs on a value/CPA target, or the ladder would propose one for it. */
const AS02 = defineCheck({
  id: "AS02",
  claimKey: "brand.campaign_target_mismatch",
  title: "brand campaign on a value or CPA target",
  group: "structure",
  metrics: ["C.strategy", "C.target_roas", "C.target_cpa", "C.ladder_verdict", "C.window(w)"],
  confounders: ["BB04"],
  requires: ["campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Brand campaign bidding is appropriate.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["campaigns"]);
    if (gate) return gate;

    const brandCampaigns = campaignsOf(ctx).filter((c) => c.attrs.isBrand);
    if (brandCampaigns.length === 0)
      return {
        state: "not_checkable",
        reason: "no campaign is classified brand",
        table: "campaigns",
        category: "not_present",
      };

    const findings: CheckFinding[] = [];
    for (const c of brandCampaigns) {
      const strategy = ctx.get("C.strategy", { campaignId: c.id });
      const targetRoas = ctx.get("C.target_roas", { campaignId: c.id });
      const targetCpa = ctx.get("C.target_cpa", { campaignId: c.id });
      const verdict = ctx.get("C.ladder_verdict", { campaignId: c.id });
      const onTarget = hasValueOrCpaTarget(str(strategy), num(targetRoas), num(targetCpa));
      // `C.ladder_verdict` already carries the brand exemption: a brand campaign
      // never reads 'ready_for_target', so this leg cannot re-propose one for it.
      const proposed = str(verdict) === "ready_for_target";
      if (!onTarget && !proposed) continue;
      findings.push(
        finding({
          claimKey: "brand.campaign_target_mismatch",
          scope: {
            type: "campaign",
            id: c.id,
            name: c.name,
            campaignId: c.id,
            campaignName: c.name,
          },
          cite: [strategy, targetRoas, targetCpa, verdict],
          entity: { id: c.id, name: c.name },
          facts: {
            strategy: str(strategy),
            target_roas: num(targetRoas),
            target_cpa: num(targetCpa),
          },
          population: brandCampaigns.length,
          note: onTarget
            ? "brand campaign already on a value/CPA target"
            : "the ladder would propose a target for a brand campaign",
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };
    return {
      state: "none_found",
      population: brandCampaigns.length,
      note: "the brand exemption holds: no brand campaign is on, or proposed for, a value/CPA target",
    };
  },
});

/** AS03 — a campaign shares a budget with a sibling that is losing impressions to it. */
const AS03 = defineCheck({
  id: "AS03",
  claimKey: "budget.shared_sibling_starvation",
  title: "a shared budget starves another campaign on it",
  group: "structure",
  metrics: [
    "C.budget_shared",
    "C.budget_sibling_count",
    "C.lost_is_budget_recent_pct",
    "C.lost_is_budget_pct",
  ],
  confounders: ["BB01", "BB02"],
  requires: ["campaignBudgets"],
  // never IMP_LOSTIS: that priced this campaign's OWN lost share, which is BB02's money
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No campaign on a shared budget is starving another of impressions.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["campaignBudgets"]);
    if (gate) return gate;

    const campaigns = campaignsOf(ctx);
    const findings: CheckFinding[] = [];
    let judged = 0;
    let shared = 0;
    const unjudged: string[] = [];
    for (const c of campaigns) {
      const isShared = ctx.get("C.budget_shared", { campaignId: c.id });
      if (!isOk(isShared)) {
        // A campaign whose budget row did not resolve is NOT evidence of an
        // unshared budget; it never enters the "0 of N are shared" denominator.
        unjudged.push(c.name ?? c.id);
        continue;
      }
      judged += 1;
      if (isShared.value !== true) continue;
      shared += 1;
      const siblingCount = ctx.get("C.budget_sibling_count", { campaignId: c.id });
      const starved = c.attrs.budget.siblingCampaignIds
        .filter((id) => id !== c.id)
        // the last 3 weeks, as BB02 (90 days only when they were not read)
        .map((id) => {
          const now = lostIsBudgetNow(ctx, id);
          return { id, lost: now.metric, value: now.value };
        })
        .filter((s) => (s.value ?? 0) > ctx.settings.structure.siblingLostIsBudgetPct);
      if (starved.length === 0) continue;
      findings.push(
        finding({
          claimKey: "budget.shared_sibling_starvation",
          scope: {
            type: "campaign",
            id: c.id,
            name: c.name,
            campaignId: c.id,
            campaignName: c.name,
          },
          cite: [isShared, siblingCount, ...starved.map((s) => s.lost)],
          entity: { id: c.id, name: c.name },
          facts: {
            shared_budget_id: c.attrs.budget.id,
            siblings: c.attrs.budget.siblingCampaignIds.length,
            starved_siblings: starved.length,
          },
          population: campaigns.length,
          note: `${starved.length} sibling(s) on budget ${c.attrs.budget.id ?? "?"} lose over ${ctx.settings.structure.siblingLostIsBudgetPct}% of impressions to it`,
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };
    if (judged === 0)
      return {
        state: "not_checkable",
        reason: `no campaign has a readable budget row (${campaigns.length} unresolved)`,
        table: "campaignBudgets",
      };
    const note = [
      `${shared} of ${judged} judged campaigns are on a shared budget`,
      unjudged.length > 0 ? `${unjudged.length} not judged: ${unjudged.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    return { state: "none_found", population: judged, note };
  },
});

/** AS04 — recommendation types are auto-applying without review. */
const AS04 = defineCheck({
  id: "AS04",
  claimKey: "account.auto_apply_enabled",
  title: "auto-apply recommendations enabled",
  group: "structure",
  metrics: ["A.auto_apply_enabled_count"],
  confounders: [],
  requires: ["recommendationSubscriptions"],
  impactFormula: "IMP_STRUCTURAL",
  /**
   * One-click build phase 3: `none_found` also covers "only cosmetic types
   * auto-apply" (nothing the card would switch off), so it names exactly that.
   */
  noneFoundMeans: "No auto-apply setting that changes bidding, budgets, keywords or reach is on.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["recommendationSubscriptions"]);
    if (gate) return gate;

    const enabled = ctx.get("A.auto_apply_enabled_count");
    if (!isOk(enabled))
      return {
        state: "not_checkable",
        reason: `A.auto_apply_enabled_count is ${enabled.reason}: ${enabled.detail}`,
      };
    const count = num(enabled) ?? 0;
    const total = enabled.source.rowCount ?? null;
    if (count === 0) return { state: "none_found", population: total };

    const on = ctx.model.attrs.recommendationSubscriptions.filter(
      (r) => String(r.status).toUpperCase() === "ENABLED",
    );
    const named = on.map((r) => String(r.type)).filter((t) => t && t.toUpperCase() !== "UNKNOWN");
    const unnamed = on.length - named.length;
    /**
     * One-click build phase 3: the card's own advice is "switch off the ones that
     * change bidding, budgets or targeting, leave the cosmetic ones". Review fix:
     * the card is hidden ONLY when every switch that is on is on the explicit
     * harmless list (isCosmeticAutoApplyType). An unlisted type (e.g.
     * CUSTOM_AUDIENCE_OPT_IN widens reach) or one no one could name may be a risk,
     * so the card still fires then.
     */
    if (unnamed === 0 && named.length > 0 && named.every((t) => isCosmeticAutoApplyType(t))) {
      return {
        state: "none_found",
        population: total,
        note: `only cosmetic auto-apply types are on (${named.join(", ")}); nothing to switch off`,
      };
    }
    // never invent a name for an enum this API version could not resolve.
    const parts = [
      named.length > 0 ? named.join(", ") : null,
      unnamed > 0
        ? `${unnamed} type${unnamed === 1 ? "" : "s"} the API version could not name`
        : null,
    ].filter(Boolean);
    // The sync writes no `sync_table_status` row for this table, so the marker is
    // permanently 'unknown' and every finding here is `provisional` by rule 5.
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "account.auto_apply_enabled",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [enabled],
          facts: { auto_apply_enabled: count, named_types: named, unnamed_types: unnamed },
          population: total,
          /**
           * Phase 3: the types were already known and rode in `note`, which is a short
           * MACHINE note the writer may not quote. "Two recommendation types
           * auto-apply" is a different sentence from "OPTIMIZE_AD_ROTATION
           * auto-applies", and the reader needs the second one to act.
           *
           * a type this API version could not name is listed as unnamed
           * rather than invented.
           */
          rows: [
            ...on
              .filter((r) => String(r.type) && String(r.type).toUpperCase() !== "UNKNOWN")
              .map((r) => ({
                entity: { id: null, name: String(r.type) },
                cells: { auto_applies: "yes" },
              })),
            ...(unnamed > 0
              ? [
                  {
                    entity: {
                      id: null,
                      name: `${unnamed} type${unnamed === 1 ? "" : "s"} this API version could not name`,
                    },
                    cells: { auto_applies: "yes" },
                  },
                ]
              : []),
          ],
          note: `auto-applying: ${parts.join("; ")}`,
        }),
      ],
    };
  },
});

/** AS06 — an experiment is running; campaigns in an arm are exempt from ZOMBIE / DORMANT verdicts. */
const AS06 = defineCheck({
  // experiment arms are a separate gated table from experiments
  id: "AS06",
  claimKey: "account.experiment_running",
  title: "an experiment is running",
  group: "structure",
  metrics: ["A.experiments_active", "C.experiment_arm"],
  confounders: ["TR05", "TR06"],
  // the arms only place a running experiment on its campaigns: read when firing
  requires: ["experiments"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "No experiments running.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["experiments"]);
    if (gate) return gate;

    const active = ctx.get("A.experiments_active");
    if (!isOk(active))
      return {
        state: "not_checkable",
        reason: `A.experiments_active is ${active.reason}: ${active.detail}`,
      };
    const count = num(active) ?? 0;
    const total = active.source.rowCount ?? null;
    if (count === 0) return { state: "none_found", population: total };

    // Scope is the campaign when an arm joins one of THIS audit's campaigns
    // (rule 3). Historical arm ids that join nothing stay at account scope.
    const arms = campaignsOf(ctx)
      .map((c) => ({ c, v: ctx.get("C.experiment_arm", { campaignId: c.id }) }))
      .filter((x) => isOk(x.v) && x.v.value === true);

    if (arms.length > 0) {
      return {
        state: "fires",
        findings: arms.map(({ c, v }) =>
          finding({
            claimKey: "account.experiment_running",
            scope: {
              type: "campaign",
              id: c.id,
              name: c.name,
              campaignId: c.id,
              campaignName: c.name,
            },
            cite: [active, v],
            entity: { id: c.id, name: c.name },
            facts: { experiments_active: count, experiment_ids: c.attrs.experimentIds },
            population: campaignsOf(ctx).length,
            note: "in an experiment: its results are part of a test, so they are not judged like a normal campaign",
          }),
        ),
      };
    }
    // the arms say which campaigns are in a test; when they were not read, nobody can say
    const armsRead = gateOnData(ctx, ["experimentArms"]) == null;
    const f = finding({
      claimKey: "account.experiment_running",
      scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
      cite: [active],
      facts: { experiments_active: count, experiments_total: total, campaigns_in_arms: 0 },
      population: total,
      note: armsRead
        ? `${count} of ${total ?? "?"} experiments are active; no experiment names one of this account's campaigns, so no campaign is tagged`
        : `${count} of ${total ?? "?"} experiments are active; which campaigns they test could not be read, so no campaign is tagged`,
    });
    if (!armsRead)
      f.limitedBy = [
        "We could not read which campaigns the running experiments test, so the campaigns in a test are not named.",
      ];
    return { state: "fires", findings: [f] };
  },
});

/** AS07 — no brand-safety content exclusions while Display/Video/PMax/Demand Gen inventory is running. */
const AS07 = defineCheck({
  id: "AS07",
  claimKey: "account.content_exclusions_missing",
  title:
    "no brand-safety exclusions while ads run on Display, Video, Demand Gen or Performance Max",
  group: "structure",
  metrics: ["A.content_exclusions_count"],
  confounders: [],
  requires: [NEGATIVE_CRITERIA],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Brand-safety exclusions are set.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, [NEGATIVE_CRITERIA]);
    if (gate) return gate;

    const exclusions = ctx.get("A.content_exclusions_count");
    if (!isOk(exclusions))
      return {
        state: "not_checkable",
        reason: `A.content_exclusions_count is ${exclusions.reason}: ${exclusions.detail}`,
        table: NEGATIVE_CRITERIA,
      };
    const count = num(exclusions) ?? 0;
    const exposed = campaignsOf(ctx).filter((c) => EXCLUSION_RELEVANT_TYPES.has(c.attrs.type));
    if (exposed.length === 0)
      return {
        state: "not_checkable",
        reason:
          "no Display / Video / PMax / Demand Gen campaign runs on this account, so inventory exclusions do not apply",
        category: "not_present",
      };
    // With one row present the check correctly stays silent — the shipped code
    // fired on `negCriteriaRows.length === 0`, which is the same test.
    if (count > 0) return { state: "none_found", population: count };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "account.content_exclusions_missing",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [exclusions],
          facts: { content_exclusions: 0, exposed_campaigns: exposed.length },
          population: exposed.length,
          note: `${exposed.length} campaigns run on Display / Video / PMax / Demand Gen inventory with no content exclusion set`,
        }),
      ],
    };
  },
});

/** AS08 — a shared negative list exists but is attached to no campaign. */
const AS08 = defineCheck({
  // counts account-level negatives alongside the shared lists
  id: "AS08",
  claimKey: "negatives.list_not_attached",
  title: "negative list attached to no campaign",
  group: "structure",
  metrics: [
    "A.negative_lists_unattached",
    "A.negative_lists_count",
    "A.negative_list_members",
    "A.negatives_count",
  ],
  confounders: ["SK06"],
  requires: ["sharedNegativeLists"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each negative list is attached to at least one campaign.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["sharedNegativeLists"]);
    if (gate) return gate;

    const unattached = ctx.get("A.negative_lists_unattached");
    if (!isOk(unattached))
      return {
        state: "not_checkable",
        reason: `A.negative_lists_unattached is ${unattached.reason}: ${unattached.detail}`,
      };
    const lists = ctx.get("A.negative_lists_count");
    const members = ctx.get("A.negative_list_members");
    const accountNegatives = ctx.get("A.negatives_count");
    const listCount = num(lists);
    const count = num(unattached) ?? 0;

    // §A.4: three different numbers, never merged. What the LISTS block is
    // A.negative_list_members; how many negatives the ACCOUNT runs is
    // A.negatives_count. They differ by the orphan member rows.
    const note = `${listCount ?? "?"} lists blocking ${num(members) ?? "?"} members; the account runs ${num(accountNegatives) ?? "?"} account-level negative criteria — a different number`;
    if (count === 0) {
      // "None found" still knows three real numbers, and they are what makes the
      // account clean here. They used to live only in `note`, where nothing but a
      // human could read them.
      const clean = [lists, members, accountNegatives]
        .filter(isOk)
        .map((v) => evidenceOf(v, { id: null, name: "account" }));
      return { state: "none_found", population: listCount, note, evidence: clean };
    }
    // one-click gaps phase 1: the old shape (a negative_list scope with neither id nor
    // name) was refused downstream as "scope not mappable", so AS08 never reached a card.
    // Now ONE account finding. B15: its rows are the unattached LISTS (the table names the
    // lists, never campaigns), each with the campaigns it fits as context: live, non-brand
    // Search and Standard Shopping (a list on the brand campaign blocks the brand's own
    // keywords), and never a campaign where a member of the list would block one of its own
    // enabled keywords (Google's negative-match rules, as SK33 applies them).
    const unattachedIds = new Set(unattached.source.rowIds ?? []);
    const orphanLists = ctx.model.children.negativeLists.filter(
      (l) =>
        l.attrs.source === "sharedNegativeLists" &&
        l.attrs.listId != null &&
        (unattachedIds.size > 0
          ? unattachedIds.has(l.attrs.listId)
          : l.attrs.campaignIds.length === 0),
    );
    // Negatives framework P3: Performance Max stays out of the targets until the P1 probe confirms a
    // shared negative list links to a PMax campaign on a live account (campaign_shared_set on PMax,
    // scripts/probePmaxNegatives.ts); PX21 / PX22 carry PMax blocks meanwhile.
    const targets = campaignsOf(ctx).filter(
      (c) =>
        isReportable(c) &&
        !c.attrs.isBrand &&
        (c.attrs.type === "SEARCH" || c.attrs.type === "SHOPPING"),
    );
    const enabledKeywords = (c: CampaignNode): string[] =>
      c.children.adGroups
        .filter((g) => statusOf(g) === "ENABLED")
        .flatMap((g) => g.children.keywords)
        .filter(
          (k) => !k.attrs.isNegative && statusOf(k) === "ENABLED" && k.attrs.text.trim() !== "",
        )
        .map((k) => k.attrs.text);
    // fail closed: a list whose words were not all synced cannot be checked against
    // the keywords, so it is offered nowhere (declared member_count > synced words)
    const declared = new Map<string, number>(
      (
        (ctx.metrics.data as unknown as { sharedNegativeLists?: any[] }).sharedNegativeLists ?? []
      ).map((r) => [String(r.shared_set_id), Number(r.member_count) || 0]),
    );
    const rows = orphanLists.map((l) => {
      const members = ctx.model.negativeIndex.byList.get(String(l.attrs.listId)) ?? [];
      const fits =
        members.length < (declared.get(String(l.attrs.listId)) ?? 0)
          ? []
          : targets.filter(
              (c) =>
                !enabledKeywords(c).some((text) => members.some((n) => negativeMatches(text, n))),
            );
      return {
        entity: { id: String(l.attrs.listId), name: l.name },
        cells: {
          campaigns: fits.map((c) => c.name),
          campaign_ids: fits.map((c) => c.id),
        },
      };
    });
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "negatives.list_not_attached",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [unattached, lists, members],
          facts: {
            unattached_lists: orphanLists.map((l) => l.name),
            // the reply shows facts, not row cells: each list with the campaigns it fits. N6:
            // never a bare "campaigns" beside a list name, which reads as attached (a live shop's
            // lists showed the campaigns whose links were removed); attached is stated as 0
            lists: rows.map((r) => ({
              name: r.entity.name,
              attached_campaigns: 0,
              fits_live_campaigns: r.cells.campaigns,
            })),
            unattached_list_count: count,
            lists_total: listCount,
          },
          population: listCount,
          rows,
          note: [
            `${count} of ${listCount ?? "?"} lists are attached to no campaign${orphanLists.length > 0 ? ` (${orphanLists.map((l) => l.name).join(", ")})` : ""}`,
            note,
          ].join("; "),
        }),
      ],
    };
  },
});

/**
 * AS09 — one of the seven standard remarketing lists is missing.
 *
 * Phase 11b (2026-09-29): the checklist is the repo's own seven essential
 * e-commerce lists (`services/audit/audienceRoles.ts` ESSENTIAL_ROLES, the same
 * set the PMax audience-signal tool and CustomerListsAnalyzer use): all
 * purchasers, high-value customers, recent purchasers, cart abandoners, email
 * subscribers, repeat customers, lapsed customers. Each open list is matched on
 * its DEFINITION first (rule-based include rule, the PURCHASE conversion action
 * a basic list collects on, its life span), its name only as a fallback.
 * E-commerce only (businessTypeGate); below Tier B the spend-tier gate says the
 * wider set is not expected yet (rule 115).
 */
const AS09 = defineCheck({
  id: "AS09",
  claimKey: "audience.required_lists_missing",
  title: "standard remarketing lists missing",
  clientLabel: "the standard set of remarketing audiences",
  notCheckableCategory: "our_gap",
  group: "structure",
  metrics: ["A.required_list_coverage", "A.audience_lists_count", "A.audience_lists_usable"],
  confounders: ["SL01"],
  requires: ["audienceLists"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans:
    "All seven standard remarketing lists exist, from past buyers to cart abandoners.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["audienceLists"]);
    if (gate) return gate;

    const coverage = ctx.get("A.required_list_coverage");
    if (!isOk(coverage)) {
      return {
        state: "not_checkable",
        reason: `A.required_list_coverage is ${coverage.reason}: ${coverage.detail}`,
        table: "audienceLists",
      };
    }
    const map = (coverage.value ?? {}) as Record<string, unknown>;
    const roles = ESSENTIAL_ROLES.filter((r) => r in map);
    const missing = roles.filter((r) => !(Number(map[r]) > 0));
    const total = ctx.get("A.audience_lists_count");
    const usable = ctx.get("A.audience_lists_usable");
    if (missing.length === 0)
      return { state: "none_found", population: roles.length, note: coverage.note ?? undefined };
    const cov = requiredListCoverageOf(ctx.model);
    const labels = missing.map((r) => ESSENTIAL_ROLE_LABELS[r]);
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "audience.required_lists_missing",
          scope: { type: "audience", id: null, name: null },
          cite: [coverage, total, usable],
          facts: {
            missing_lists: labels,
            missing_count: missing.length,
            standard_lists: roles.length,
            lists_total: num(total),
            lists_usable: num(usable),
            list_definitions_read: cov.definitionsRead,
          },
          population: roles.length,
          rows: roles.map((r) => ({
            entity: { id: null, name: ESSENTIAL_ROLE_LABELS[r] },
            cells: {
              present: cov.matches[r].length > 0 ? "yes" : "no",
              matched_lists:
                cov.matches[r].length === 0
                  ? null
                  : `${cov.matches[r]
                      .slice(0, 5)
                      .map((m) => m.name)
                      .join(
                        ", ",
                      )}${cov.matches[r].length > 5 ? ` and ${cov.matches[r].length - 5} more` : ""}`,
              matched_by:
                [...new Set(cov.matches[r].map((m) => m.basis.replace("_", " ")))].join(", ") ||
                null,
            },
          })),
          note: `${missing.length} of ${roles.length} standard lists missing: ${labels.join(", ")}; lists matched on their rule or purchase action first, their name only when the definition says nothing${cov.definitionsRead ? "" : " (list definitions not read on this sync, so names only)"}`,
        }),
      ],
    };
  },
});

/** AS10 — more than one user has access. INFORMATION only; never a fault, never a "no review trail" claim. */
const AS10 = defineCheck({
  id: "AS10",
  claimKey: "account.user_access_review",
  title: "more than one person has access to the account",
  group: "structure",
  metrics: ["A.user_count"],
  confounders: [],
  requires: ["customerUserAccess"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "One user has access; nothing to review.",
  // plan 1.6: $0 and never a fault — a line under the account, not a card
  noteOnly: "more than one person has access to this account",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["customerUserAccess"]);
    if (gate) return gate;

    const users = ctx.get("A.user_count");
    if (!isOk(users))
      return { state: "not_checkable", reason: `A.user_count is ${users.reason}: ${users.detail}` };
    const count = num(users) ?? 0;
    if (count <= 1) return { state: "none_found", population: count };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "account.user_access_review",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [users],
          facts: { user_count: count },
          population: count,
          // a user count is not evidence of an audit trail, in either direction.
          note: `${count} users have access — for information only; it says nothing about whether changes were reviewed`,
        }),
      ],
    };
  },
});

type EditorCount = {
  changes: number;
  person: number;
  google: number;
  api: number;
  unknown: number;
};

/**
 * AS13 (plan 5.2, Gate 1 row 8) — one login made most of the changes in the feed.
 *
 * FACTUAL ONLY. It says how many of the feed's changes came from the busiest
 * login and how they were made (in the interface, by Google's automation, by an
 * API tool). It never names the login — the model keeps counts, not emails —
 * and never claims anything about review or oversight: the feed is a capped
 * sample (AS11), and "984 changes by one user with no review trail" was a false
 * claim built on exactly that cap.
 */
const AS13 = defineCheck({
  id: "AS13",
  claimKey: "change.edits_concentrated",
  title: "one login made most of the account changes",
  clientLabel: "account changes made from one login",
  group: "structure",
  metrics: ["A.change_editors", "A.change_count", "A.change_days_covered", "W.window_days"],
  // a truncated feed makes the count a sample (AS11); auto-apply means some
  // changes have no human author (AS04). Either one unresolved caps confidence.
  confounders: ["AS11", "AS04"],
  requires: ["changeHistory"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Changes in the change history are spread across more than one login.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["changeHistory"]);
    if (gate) return gate;

    const editorsV = ctx.get("A.change_editors");
    if (!isOk(editorsV))
      return {
        state: "not_checkable",
        reason: `A.change_editors is ${editorsV.reason}: ${editorsV.detail}`,
        table: "changeHistory",
      };
    const editors = (Array.isArray(editorsV.value) ? editorsV.value : []) as EditorCount[];
    const changes = ctx.get("A.change_count");
    const total = num(changes) ?? 0;
    const withEditor = editors.reduce((n, e) => n + e.changes, 0);
    if (withEditor === 0) {
      return {
        state: "not_checkable",
        reason: `none of the ${total} change row(s) carries a user email, so changes cannot be counted per login`,
        table: "changeHistory",
      };
    }
    // review fix: Google's own internal tools act under a login too (auto-apply,
    // recommendations); only changes made in the interface or through an API
    // tool count toward who runs the account
    const madeBy = (e: EditorCount): number => e.person + e.api;
    const counted = editors.reduce((n, e) => n + madeBy(e), 0);
    const { editorsMinChanges: AS13_MIN_CHANGES, topEditorShare: AS13_TOP_EDITOR_SHARE } =
      ctx.settings.structure;
    if (counted < AS13_MIN_CHANGES) {
      return {
        state: "insufficient_data",
        reason: `${counted} change row(s) made in the interface or through an API tool, under the ${AS13_MIN_CHANGES} a per-login share needs`,
      };
    }
    const top = [...editors].sort((a, b) => madeBy(b) - madeBy(a))[0]!;
    const share = madeBy(top) / counted;
    if (share < AS13_TOP_EDITOR_SHARE) {
      return {
        state: "none_found",
        population: editors.length,
        note: `the busiest login made ${madeBy(top)} of ${counted} interface / API changes (${(share * 100).toFixed(1)}%)`,
      };
    }

    const covered = ctx.get("A.change_days_covered");
    const windowDays = ctx.get("W.window_days");
    const days = num(covered);
    const window = num(windowDays);
    const automated = editors.reduce((n, e) => n + e.google + e.api, 0);
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "change.edits_concentrated",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [editorsV, changes, covered, windowDays].filter((v) => isOk(v)),
          facts: {
            change_count: total,
            editors: editors.length,
            top_editor_changes: top.changes,
            interface_and_api_changes: counted,
            top_editor_interface_and_api_changes: madeBy(top),
            top_editor_share_pct: Number((share * 100).toFixed(1)),
            top_editor_in_interface: top.person,
            top_editor_by_google_automation: top.google,
            top_editor_by_api_tool: top.api,
            top_editor_unknown_client: top.unknown,
            automated_changes_all_logins: automated,
            changes_with_no_login: total - withEditor,
            feed_days_covered: days,
            window_days: window,
          },
          population: editors.length,
          note:
            `who made the changes in the feed, not whether anyone reviewed them; ` +
            (days != null && window != null && days < window
              ? `the change history covers ${days} of the ${window} days, so this is a sample`
              : "the feed is a capped sample"),
        }),
      ],
    };
  },
});

type GoogleMadeChange = {
  date: string;
  campaignIds: string[];
  resourceType: string;
  operation: string;
  kind: string;
  source: "auto_apply" | "google_internal";
};

/** AS14: what a Google change touched that moves money or reach. Asset and other tweaks are counted, not reported. */
const AS14_MATERIAL_KINDS: readonly string[] = [
  "budget",
  "bids and targets",
  "keywords and targeting",
  "on/off status",
];
/** AS14: at most this many campaign names per row — the rest become "and N more". */
const AS14_NAMES_PER_ROW = 3;

/**
 * AS14 — Google changed the account itself.
 *
 * FACTUAL ONLY: which budgets, bids, keywords or on/off switches were changed by
 * an auto-applied recommendation or by Google's own tools inside the change
 * history we read, per kind, with the campaigns named. AS13 leaves these rows
 * out of "who runs the account"; this check is where they are told. It makes no
 * claim about whether a change was good — that is the owner's call.
 */
const AS14 = defineCheck({
  id: "AS14",
  claimKey: "change.google_made_changes",
  title: "Google changed budgets, bids, keywords or on/off settings itself",
  clientLabel: "changes Google made to your account on its own",
  // a $0 fact the owner should know: one line under the account, never a card (Gate 2)
  noteOnly:
    "Google changed some budgets, bids, keywords or on/off settings in this account on its own",
  group: "structure",
  metrics: ["A.google_made_changes", "A.change_count", "A.change_days_covered"],
  // a capped feed makes the list a sample (AS11)
  confounders: ["AS11"],
  requires: ["changeHistory"],
  impactFormula: "IMP_NONE",
  noneFoundMeans:
    "Google made no budget, bid, keyword or on/off change to the account on its own in the change history we read.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["changeHistory"]);
    if (gate) return gate;

    const madeV = ctx.get("A.google_made_changes");
    if (!isOk(madeV))
      return {
        state: "not_checkable",
        reason: `A.google_made_changes is ${madeV.reason}: ${madeV.detail}`,
        table: "changeHistory",
      };
    const made = (Array.isArray(madeV.value) ? madeV.value : []) as unknown as GoogleMadeChange[];
    const changes = ctx.get("A.change_count");
    const total = num(changes) ?? 0;
    if (total === 0)
      return {
        state: "insufficient_data",
        reason: "the change history we read holds no change at all",
      };

    const material = made.filter((c) => AS14_MATERIAL_KINDS.includes(c.kind));
    if (material.length === 0) {
      return {
        state: "none_found",
        population: total,
        note:
          made.length > 0
            ? `${made.length} of ${total} changes were made by Google, none to a budget, bid, keyword or on/off setting`
            : `none of the ${total} changes was made by an auto-applied recommendation or Google's own tools`,
      };
    }

    const nameOf = (id: string): string | null =>
      ctx.model.index.campaignsById.get(id)?.name ?? null;
    const rows = AS14_MATERIAL_KINDS.map((kind) => {
      const ofKind = material.filter((c) => c.kind === kind);
      if (ofKind.length === 0) return null;
      const names = [
        ...new Set(
          ofKind.flatMap((c) => c.campaignIds.map(nameOf)).filter((n): n is string => n != null),
        ),
      ].sort();
      const shown = names.slice(0, AS14_NAMES_PER_ROW).join(", ");
      const more =
        names.length > AS14_NAMES_PER_ROW ? ` and ${names.length - AS14_NAMES_PER_ROW} more` : "";
      const sources = new Set(ofKind.map((c) => c.source));
      const dates = ofKind.map((c) => c.date).sort();
      return {
        entity: { id: null, name: kind },
        cells: {
          changes: ofKind.length,
          campaigns: names.length > 0 ? `${shown}${more}` : "account level",
          made_by:
            sources.size === 2
              ? "auto-applied recommendations and Google tools"
              : sources.has("auto_apply")
                ? "auto-applied recommendations"
                : "Google tools",
          first_change: dates[0] ?? null,
          last_change: dates[dates.length - 1] ?? null,
        },
      };
    }).filter((r): r is NonNullable<typeof r> => r != null);

    const covered = ctx.get("A.change_days_covered");
    const count = (kind: string): number => material.filter((c) => c.kind === kind).length;
    const campaignsTouched = new Set(material.flatMap((c) => c.campaignIds));
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "change.google_made_changes",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [madeV, changes, covered].filter((v) => isOk(v)),
          facts: {
            google_made_changes: material.length,
            auto_applied_changes: material.filter((c) => c.source === "auto_apply").length,
            google_tool_changes: material.filter((c) => c.source === "google_internal").length,
            budget_changes: count("budget"),
            bid_and_target_changes: count("bids and targets"),
            keyword_and_targeting_changes: count("keywords and targeting"),
            on_off_changes: count("on/off status"),
            other_google_changes: made.length - material.length,
            campaigns_touched: campaignsTouched.size,
            changes_in_feed: total,
            feed_days_covered: num(covered),
          },
          population: total,
          rows,
          note: `what Google changed, not whether it helped; ${ctx.model.attrs.changeHistory.sample ? "the change history hit its row limit, so this is a sample" : "read from the change history we hold"}`,
        }),
      ],
    };
  },
});

/**
 * AS15: the sensitive-content labels a brand-safe account excludes. The label
 * names are Google's ContentLabelType values; the plain words are what the
 * owner sees in the interface.
 */
const AS15_SENSITIVE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["SEXUALLY_SUGGESTIVE", "sexually suggestive content"],
  ["PROFANITY", "profanity and rough language"],
  ["TRAGEDY", "tragedy and conflict"],
  ["SOCIAL_ISSUES", "sensitive social issues"],
];
/**
 * AS15 review (2026-09-24): OFF until the four labels are verified against the
 * live Google Ads API. The v21 protos in node_modules still list all four in
 * ContentLabelTypeEnum, but Google has been moving sensitive-content controls
 * into account "inventory types", and an enum value existing does not prove an
 * exclusion of it still does anything. With the flag off AS15 judges the
 * all-apps category only; the label leg is kept, not deleted.
 */
export const AS15_CHECK_SENSITIVE_LABELS = false;
/** AS15: channels that show ads inside mobile apps — the app-category exclusion applies to these. */
const APP_EXPOSED_TYPES = new Set(["DISPLAY", "VIDEO", "DEMAND_GEN"]);
/** AS15: Performance Max shows ads in apps too, but Google gives no cost for its app placements. */
const AS15_PMAX_APP_COST_LINE =
  "Performance Max also shows ads inside apps, but Google does not report what those app placements cost, so Performance Max app spend is not included.";

/** a placement served inside a mobile app, by Google's placement type or its `mobileapp::` id. */
function isAppPlacement(p: {
  attrs: { placementType: string | null; targetUrl: string | null; displayName: string | null };
  name: string | null;
}): boolean {
  const t = String(p.attrs.placementType ?? "").toUpperCase();
  if (t.includes("MOBILE_APP")) return true;
  return [p.attrs.targetUrl, p.attrs.displayName, p.name].some((v) =>
    String(v ?? "")
      .toLowerCase()
      .startsWith("mobileapp::"),
  );
}

/**
 * AS15 — brand safety beyond "any exclusion at all".
 *
 * AS07 fires only when NOTHING is excluded. This check runs when something is,
 * and asks two narrower questions: is the mobile-app category excluded while
 * Display / Demand Gen / Video spend, and are the four standard sensitive-content
 * labels all excluded while Display / Demand Gen / Video / PMax spend. Only
 * account-level exclusions are synced; single-app and campaign-level exclusions
 * are not, which rides on the finding as an open item rather than a guess.
 */
const AS15 = defineCheck({
  id: "AS15",
  claimKey: "account.brand_safety_gaps",
  title: "the app category or part of the sensitive-content set is not excluded",
  clientLabel: "ads showing inside mobile apps or next to sensitive content",
  // a $0 setting gap beside AS07's card: one line under the account, never a card (Gate 2 / Gate 1 room)
  noteOnly: "some brand-safety exclusions are set, but mobile apps are not excluded",
  // B6: the app spend stated leaves Performance Max out; the line says so, not only a fact
  noteOnlyAddendum: {
    fact: "pmax_app_cost_withheld",
    line: "the app spend shown does not include Performance Max, because Google does not report what its app placements cost",
  },
  group: "structure",
  metrics: ["A.brand_safety_exclusions", "A.content_exclusions_count", "Pl.cost"],
  confounders: [],
  requires: [NEGATIVE_CRITERIA],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: 'Ads are kept out of mobile apps with the "All apps" exclusion.',
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, [NEGATIVE_CRITERIA]);
    if (gate) return gate;

    const exclusionsV = ctx.get("A.brand_safety_exclusions");
    if (!isOk(exclusionsV))
      return {
        state: "not_checkable",
        reason: `A.brand_safety_exclusions is ${exclusionsV.reason}: ${exclusionsV.detail}`,
        table: NEGATIVE_CRITERIA,
      };
    const names = (Array.isArray(exclusionsV.value) ? exclusionsV.value : []) as string[];
    // AS07 owns the "nothing excluded at all" story; saying it twice is the same gap twice
    if (names.length === 0)
      return {
        state: "not_checkable",
        reason: "no exclusion is set at all, which the content exclusions check reports",
        category: "not_applicable",
      };

    const labelsExcluded = new Set(
      names
        .filter((n) => n.startsWith("CONTENT_LABEL:"))
        .map((n) => n.slice("CONTENT_LABEL:".length)),
    );
    const appCategoryExcluded = names.some((n) => n.startsWith("MOBILE_APP_CATEGORY:"));
    const live = campaignsOf(ctx);
    const appExposed = live.filter((c) => APP_EXPOSED_TYPES.has(c.attrs.type));
    const labelExposed = AS15_CHECK_SENSITIVE_LABELS
      ? live.filter((c) => EXCLUSION_RELEVANT_TYPES.has(c.attrs.type))
      : appExposed;
    if (labelExposed.length === 0) {
      return {
        state: "not_checkable",
        reason: AS15_CHECK_SENSITIVE_LABELS
          ? "no Display / Video / PMax / Demand Gen campaign runs on this account, so inventory exclusions do not apply"
          : "no Display / Video / Demand Gen campaign runs on this account, so the app-category exclusion does not apply",
        category: "not_present",
      };
    }

    const appGap = appExposed.length > 0 && !appCategoryExcluded;
    // PMax app placements carry no cost: the app spend stated covers the other channels only
    const pmaxAppCostWithheld = appGap && live.some((c) => c.attrs.type === "PERFORMANCE_MAX");
    const missingLabels = AS15_CHECK_SENSITIVE_LABELS
      ? AS15_SENSITIVE_LABELS.filter(([label]) => !labelsExcluded.has(label))
      : [];
    if (!appGap && missingLabels.length === 0) {
      return {
        state: "none_found",
        population: labelExposed.length,
        note: AS15_CHECK_SENSITIVE_LABELS
          ? `${appExposed.length > 0 ? "the app category is excluded; " : ""}all ${AS15_SENSITIVE_LABELS.length} standard sensitive-content labels are excluded`
          : "the app category is excluded (sensitive-content labels not judged until verified)",
      };
    }

    // what app placements cost on the exposed campaigns, where placement data exists
    let appSpend: number | null = null;
    let appPlacements = 0;
    if (appGap) {
      for (const c of appExposed) {
        for (const p of c.children.placements) {
          if (!isAppPlacement(p)) continue;
          const cost = ctx.get("Pl.cost", { placementId: p.id });
          if (!isOk(cost)) continue;
          appPlacements += 1;
          appSpend = (appSpend ?? 0) + (num(cost) ?? 0);
        }
      }
    }

    const rows = [
      ...(appGap
        ? [
            {
              entity: { id: null, name: 'mobile apps ("All apps" category)' },
              cells: {
                excluded: "no",
                campaigns_exposed: appExposed
                  .map((c) => c.name)
                  .filter(Boolean)
                  .join(", "),
                ...(appSpend != null ? { app_spend_90d: Number(appSpend.toFixed(2)) } : {}),
              },
            },
          ]
        : []),
      ...missingLabels.map(([, plain]) => ({
        entity: { id: null, name: plain },
        cells: { excluded: "no" },
      })),
    ];
    return {
      state: "fires",
      findings: [
        {
          ...finding({
            claimKey: "account.brand_safety_gaps",
            scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
            cite: [exclusionsV, ctx.get("A.content_exclusions_count")].filter((v) => isOk(v)),
            facts: {
              app_category_excluded: appExposed.length > 0 ? appCategoryExcluded : null,
              app_exposed_campaigns: appExposed.length,
              ...(appSpend != null
                ? {
                    app_placement_spend_90d: Number(appSpend.toFixed(2)),
                    app_placements: appPlacements,
                  }
                : {}),
              ...(pmaxAppCostWithheld
                ? {
                    pmax_app_cost_withheld: true,
                    app_spend_scope: "Display, Video and Demand Gen only",
                  }
                : {}),
              ...(AS15_CHECK_SENSITIVE_LABELS
                ? {
                    sensitive_labels_missing: missingLabels.length,
                    sensitive_labels_checked: AS15_SENSITIVE_LABELS.length,
                  }
                : {}),
              exposed_campaigns: labelExposed.length,
            },
            population: labelExposed.length,
            rows,
            note: `${appGap ? "no app-category exclusion" : "app category excluded"}${AS15_CHECK_SENSITIVE_LABELS ? `; ${missingLabels.length} of ${AS15_SENSITIVE_LABELS.length} standard sensitive labels not excluded` : ""}${pmaxAppCostWithheld ? "; Performance Max app spend not included (Google does not report it)" : ""}`,
          }),
          openItems: [
            "We read account-level exclusions only. Apps excluded one by one, and exclusions set on a single campaign, are not in our data.",
            ...(pmaxAppCostWithheld ? [AS15_PMAX_APP_COST_LINE] : []),
          ],
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// AS16 / AS17
// ---------------------------------------------------------------------------

/** AS16: the automated strategies that learn from conversions. */
const CONVERSION_BIDDING = new Set([
  "MAXIMIZE_CONVERSIONS",
  "MAXIMIZE_CONVERSION_VALUE",
  "TARGET_CPA",
  "TARGET_ROAS",
]);
const CHANNEL_WORDS: Readonly<Record<string, string>> = {
  SEARCH: "Search",
  PERFORMANCE_MAX: "Performance Max",
  SHOPPING: "Shopping",
  DEMAND_GEN: "Demand Gen",
  VIDEO: "Video",
  DISPLAY: "Display",
  OTHER: "other",
};

/**
 * AS16 — too many campaigns, each too small to learn.
 *
 * Per channel, the live non-brand campaigns on conversion bidding that spent in
 * the last 30 days and are past the learning age. When 3+ of them, and at least
 * half of that channel, sit under 30 conversions in 30 days, the account is
 * split finer than its bidding can learn from. BB04 judges one target at a
 * time; this is the account-level "merge them" finding, naming every campaign.
 * Brand stays out: brand vs non-brand is a split worth keeping. Campaigns
 * sharing a portfolio strategy are judged on the portfolio's pooled conversions.
 */
const AS16 = defineCheck({
  id: "AS16",
  claimKey: "account.campaigns_too_small_to_learn",
  title: "many campaigns of one kind, each under the conversions its bidding needs",
  clientLabel: "campaigns split too thin for automated bidding to learn",
  group: "structure",
  metrics: ["C.window(w)", "C.strategy", "C.age_days"],
  confounders: ["MI01"],
  requires: ["campaigns", "campaignDailyMetrics"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Your campaigns are not split thinner than automated bidding can learn from.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["campaigns", "campaignDailyMetrics"]);
    if (gate) return gate;
    const minAge = ctx.settings.floors.learningMinAgeDays;
    const {
      learnMinConv30d: LEARN_MIN_CONV_30D,
      thinMinCampaigns,
      thinMinShare,
    } = ctx.settings.structure;
    const byChannel = new Map<string, CampaignNode[]>();
    for (const c of campaignsOf(ctx)) {
      if (c.status !== "ENABLED" || c.attrs.isBrand) continue;
      if (
        !CONVERSION_BIDDING.has(String(c.attrs.strategy ?? "")) &&
        c.attrs.targetRoas == null &&
        c.attrs.targetCpa == null
      )
        continue;
      if (!c.windows.m30 || (c.windows.m30.cost ?? 0) <= 0) continue;
      const age = num(ctx.get("C.age_days", { campaignId: c.id }));
      if (age != null && age < minAge) continue;
      (byChannel.get(c.attrs.type) ?? byChannel.set(c.attrs.type, []).get(c.attrs.type)!).push(c);
    }
    const judged = [...byChannel.values()].reduce((t, l) => t + l.length, 0);
    if (judged === 0)
      return {
        state: "not_checkable",
        reason:
          "no live non-brand campaign on conversion bidding spent in the last 30 days past the learning age",
        category: "not_present",
      };

    // review fix: campaigns on one portfolio strategy learn from their POOLED conversions — a
    // portfolio that clears the bar together is not fragmented, whatever each campaign has alone
    const pooled = new Map<string, number>();
    for (const c of campaignsOf(ctx)) {
      if (c.status !== "ENABLED" || !c.attrs.portfolioStrategyId) continue;
      pooled.set(
        c.attrs.portfolioStrategyId,
        (pooled.get(c.attrs.portfolioStrategyId) ?? 0) + (c.windows.m30?.conv ?? 0),
      );
    }
    const learningConv = (c: CampaignNode): number =>
      (c.attrs.portfolioStrategyId ? pooled.get(c.attrs.portfolioStrategyId) : undefined) ??
      c.windows.m30?.conv ??
      0;
    const thin: Array<{ channel: string; all: CampaignNode[]; under: CampaignNode[] }> = [];
    for (const [channel, all] of byChannel) {
      const under = all.filter((c) => learningConv(c) < LEARN_MIN_CONV_30D);
      if (under.length >= thinMinCampaigns && under.length / all.length >= thinMinShare)
        thin.push({ channel, all, under });
    }
    const summary = [...byChannel]
      .map(
        ([ch, all]) =>
          `${CHANNEL_WORDS[ch] ?? ch} ${all.filter((c) => learningConv(c) < LEARN_MIN_CONV_30D).length} of ${all.length} under ${LEARN_MIN_CONV_30D}`,
      )
      .join("; ");
    if (thin.length === 0) return { state: "none_found", population: judged, note: summary };

    const under = thin.flatMap((t) => t.under);
    const channelSpend = thin
      .flatMap((t) => t.all)
      .reduce((t, c) => t + (c.windows.m30?.cost ?? 0), 0);
    const underSpend = under.reduce((t, c) => t + (c.windows.m30?.cost ?? 0), 0);
    const rows = [...under]
      .sort(
        (a, b) =>
          (b.windows.m30?.cost ?? 0) - (a.windows.m30?.cost ?? 0) || a.name.localeCompare(b.name),
      )
      .map((c) => ({
        entity: { id: c.id, name: c.name },
        cells: {
          kind: CHANNEL_WORDS[c.attrs.type] ?? c.attrs.type,
          conversions_30d: Number((c.windows.m30?.conv ?? 0).toFixed(1)),
          ...(c.attrs.portfolioStrategyId
            ? { portfolio_conversions_30d: Number(learningConv(c).toFixed(1)) }
            : {}),
          spend_30d: Number((c.windows.m30?.cost ?? 0).toFixed(2)),
          bidding: String(c.attrs.strategy ?? ""),
        },
      }));
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "account.campaigns_too_small_to_learn",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: under
            .slice(0, 8)
            .map((c) => ctx.get("C.window(w)", { campaignId: c.id, window: "30d" })),
          facts: {
            campaigns_under_bar: under.length,
            campaigns_judged: thin.reduce((t, x) => t + x.all.length, 0),
            conversions_bar_30d: LEARN_MIN_CONV_30D,
            kinds: thin.map((t) => CHANNEL_WORDS[t.channel] ?? t.channel).join(", "),
            spend_30d_under_bar: Number(underSpend.toFixed(2)),
            share_of_kind_spend_pct:
              channelSpend > 0 ? Number(((underSpend / channelSpend) * 100).toFixed(1)) : 0,
          },
          population: judged,
          rows,
          note: summary,
        }),
      ],
    };
  },
});

/** AS17: the audit months in which the holiday peak is still ahead (September to November). */
const PEAK_PREP_MONTHS = new Set([9, 10, 11]);
/** AS17: words that show something seasonal is set up (campaign names, keywords), folded, whole words. */
const SEASONAL_WORDS: readonly string[] = [
  "black friday",
  "blackfriday",
  "bfcm",
  "cyber monday",
  "cyber week",
  "holiday",
  "holidays",
  "christmas",
  "xmas",
  "gift",
  "gifts",
  "q4",
  "kerst",
  "sinterklaas",
  "cadeau",
  "swieta",
  "swiateczny",
  "swiateczne",
  "prezent",
  "prezenty",
  "mikolajki",
  "weihnachten",
  "geschenk",
];

/** Black Friday of a year: the day after the fourth Thursday of November (UTC date string). */
export function blackFridayOf(year: number): string {
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstThu = 1 + ((4 - nov1.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, 10, firstThu + 21 + 1)).toISOString().slice(0, 10);
}

/**
 * AS17 — the holiday peak is ahead and nothing seasonal
 * is set up. Date-gated: runs only when the audit window ends in September to
 * November, on e-commerce. "Set up" = a promotion asset ending in November or
 * December, or a live campaign / keyword with a seasonal word. A plain
 * reminder with no dollar figure: a note under the account (Gate 2).
 */
const AS17 = defineCheck({
  id: "AS17",
  claimKey: "account.seasonal_peak_not_prepared",
  title: "the holiday peak is ahead and nothing seasonal is set up",
  clientLabel: "preparing for the holiday peak (Black Friday to Christmas)",
  noteOnly:
    "the holiday peak is coming and nothing seasonal is set up yet (no dated promotion, no seasonal campaign or keywords)",
  group: "structure",
  metrics: ["A.spend"],
  confounders: [],
  requires: ["campaigns"],
  // "nothing seasonal" is only true when every place it could be set up was read
  needsCompleteData: ["adExtensions", "keywords", "adGroups"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "Something is already set up for the holiday peak.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["campaigns"]);
    if (gate) return gate;
    const end = ctx.model.window.end;
    if (!end)
      return {
        state: "not_checkable",
        reason: "the period read has no end date",
        category: "our_gap",
      };
    const year = Number(end.slice(0, 4));
    const month = Number(end.slice(5, 7));
    if (!PEAK_PREP_MONTHS.has(month))
      return {
        state: "not_checkable",
        reason: `the period read ends ${end}, outside September to November`,
        category: "not_applicable",
      };
    const live = campaignsOf(ctx).filter((c) => c.status === "ENABLED");
    const hasWord = (t: string | null | undefined): boolean => {
      const p = ` ${foldBrandText(t ?? "")} `;
      return SEASONAL_WORDS.some((w) => p.includes(` ${w} `));
    };
    const seasonalCampaigns = live.filter((c) => hasWord(c.name)).map((c) => c.name);
    const seasonalKeywords = live
      .flatMap((c) => c.children.adGroups.flatMap((g) => g.children.keywords))
      .filter((k) => !k.attrs.isNegative && hasWord(k.attrs.text)).length;
    const datedPromos = ctx.metrics.index.attachedExtensions.filter(
      (e) =>
        e.attrs.type === "PROMOTION" &&
        e.attrs.promoEndDate != null &&
        e.attrs.promoEndDate.slice(0, 4) === String(year) &&
        ["11", "12"].includes(e.attrs.promoEndDate.slice(5, 7)),
    ).length;
    const bf = blackFridayOf(year);
    if (seasonalCampaigns.length > 0 || seasonalKeywords > 0 || datedPromos > 0) {
      return {
        state: "none_found",
        population: live.length,
        note: `seasonal set-up found: ${seasonalCampaigns.length} campaign(s) (${seasonalCampaigns.slice(0, 3).join(", ")}), ${seasonalKeywords} seasonal keyword(s), ${datedPromos} promotion asset(s) ending in Nov/Dec`,
      };
    }
    const days = Math.round(
      (Date.parse(`${bf}T00:00:00Z`) - Date.parse(`${end}T00:00:00Z`)) / 86_400_000,
    );
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "account.seasonal_peak_not_prepared",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [ctx.get("A.spend")],
          facts: {
            audit_window_end: end,
            black_friday: bf,
            days_to_black_friday: days,
            seasonal_campaigns: 0,
            seasonal_keywords: 0,
            dated_promotion_assets: 0,
            live_campaigns: live.length,
          },
          population: live.length,
          note: "a reminder: nothing seasonal found in campaign names, keywords or promotion assets",
        }),
      ],
    };
  },
});

export const STRUCTURE_CHECKS: CheckDefinition[] = [
  AS01,
  AS02,
  AS03,
  AS04,
  AS06,
  AS07,
  AS08,
  AS09,
  AS10,
  AS13,
  AS14,
  AS15,
  AS16,
  AS17,
];
