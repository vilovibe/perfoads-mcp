// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The volume-floor gate — B3 of AUDIT_V3_RULE_GAP_PLAN.md (inventory rules 239,
 * 247; rules 244, 246 and 96 are answered elsewhere, see the bottom of this
 * comment).
 *
 * v3 gated every asset and extension claim on `spend > 0`. The old rulebook
 * required real volume before judging one, and the difference is not academic:
 * a headline with four impressions could be reported as underperforming, which
 * is noise dressed as a finding and the fastest way for a client to stop
 * trusting the report.
 *
 * Like brandGate.ts, ageGate.ts and spendTierGate.ts this is a DECLARED TABLE,
 * one row per check id with its rule number, applied in `defineCheck`
 * (checks/types.ts) so a check imported straight from its group module cannot
 * bypass it.
 *
 * ---------------------------------------------------- what it gates, and why
 *
 * ONLY claims about how an asset PERFORMED. A claim about presence or absence
 * ("this campaign carries no sitelinks", "this asset group is three headlines
 * short") does not need traffic to be true, and gating it would delete a true
 * statement about the account's setup. SK16, PX03 and PX13 are therefore
 * deliberately absent from the table below.
 *
 * SK17 ("a callout text has never served anywhere on the account") is also
 * deliberately absent, and it is the one worth writing down. It looks like a
 * performance claim and is not: it does not compare one asset against another
 * or against a benchmark, it states that a text has ZERO impressions everywhere
 * it is attached. Zero is measurable at any volume, and the callout's own
 * impressions — the thing a floor would be measured on — are zero by
 * construction. A floor there would suppress a true fact for lack of the very
 * traffic whose absence IS the fact.
 *
 * -------------------------------------------------- suppressing is not passing
 *
 * When the floor holds back EVERY finding of a check, the check returns
 * `not_checkable`, never `none_found`. That is the hard requirement: a thin-data
 * area must not render as clean. `not_checkable` lands in `engine.notCheckable`
 * and reaches the client through `brief/buildNotChecked.ts`, which recognises
 * this family by `VOLUME_FLOOR_REASON_TAG` and prints "there was not enough
 * traffic on it yet to judge it fairly" instead of "the data is not available".
 * Do not reword the prefix without changing `plainReason` with it.
 *
 * This is the one place where the gate chain is NOT uniform: ageGate returns
 * `none_found` when it empties a check, because the age it reports is itself
 * the answer a reader wants ("Spring launch is nine days old"). Here the honest
 * answer is that the question was not settled at all.
 *
 * ------------------------------------------------- the rest of B3, and where
 *
 *   - rule 246 (4 sitelinks, 6 callouts, 1 snippet, a call extension for
 *     lead-gen and local) is COVERAGE, not performance. It lives in SK16
 *     (checks/search.ts) as per-type minimums, ungated by volume on purpose.
 *   - rule 245 (a disapproved extension on a campaign with paid traffic is
 *     critical) is SK26, new in checks/search.ts.
 *   - rule 244's 1,000-impression floor for naming a sitelink has NO consumer:
 *     no v3 check names an underperforming sitelink. The number is recorded in
 *     `ASSET_FLOORS.sitelinkNameImpressions` and cited by nothing.
 *   - rule 96's slice floors (hour 5+ conversions, day 10+, device 10+,
 *     location 5+) are already met and exceeded: `FLOORS.deviceClicks`,
 *     `geoClicks`, `demoClicks` and `audienceClicks` hold every slice check to
 *     100 CLICKS, a stricter bar than 96's conversion counts, and SL01/SL07
 *     enforce it in `cpaGapCheck`. Nothing is added for it here. The hour and
 *     day halves of 96 have no consumer either — no v3 check names a "worst
 *     hour" or a "worst day".
 */
import { ASSET_FLOORS } from "../registry/thresholds.js";
import {
  evidence,
  isOk,
  num,
  type CheckCtx,
  type CheckFinding,
  type CheckResult,
  type EvidenceRef,
} from "./types.js";

/** What a check's finding needs before its verdict may be printed. */
export interface VolumeFloorRule {
  /** inventory rule number(s) this row encodes — AUDIT_V3_RULE_INVENTORY.md. */
  rules: string;
  /** the registry metric that measures the volume, cited on every surviving finding. */
  metric: string;
  /** how the metric is addressed, from the asset the finding is scoped to. */
  scope: "ad_of_asset" | "asset_group_of_asset" | "conversion_action";
  /** the floor itself, and the word a reader needs for it. */
  floor: number;
  unit: "impressions" | "clicks" | "conversions";
  /** why, in the words of the rule, for the suppression line and the trace. */
  why: string;
}

/**
 * The table. A row is added only where the inventory gives a number; nothing
 * here was chosen because a finding looked thin on one account.
 */
export const VOLUME_FLOOR_RULES: Readonly<Record<string, VolumeFloorRule>> = {
  // --- rule 247: no asset-performance finding under 100 impressions. SK14
  // reports Google's LOW label on a search ad asset, a verdict on how that asset
  // performed against its siblings: the claim the rule refuses on thin data.
  SK14: {
    rules: "247",
    metric: "D.impressions",
    scope: "ad_of_asset",
    floor: ASSET_FLOORS.searchAssetImpressions,
    unit: "impressions",
    why: "a rating of one headline against its siblings is a comparison, and there is not enough traffic behind it yet for the comparison to mean anything",
  },

  // --- rules 50 / 126: a strong claim needs at least 10 conversions. MI01 calls
  // a primary action "silent" against its own rhythm; under 10 conversions in the
  // window there is no rhythm to speak of.
  MI01: {
    rules: "50, 126",
    metric: "CA.conv_window(action)",
    scope: "conversion_action",
    floor: 10,
    unit: "conversions",
    why: "the action has fired too rarely in the window for a quiet stretch to mean it stopped",
  },
};

/**
 * How `buildNotChecked` recognises this family. A thin-data answer is neither a
 * missing source nor an applicability answer, and it needs its own sentence.
 */
export const VOLUME_FLOOR_REASON_TAG = "not enough traffic to judge it yet";

/** The metric args that address the entity a rule measures, from the asset id on the scope. */
function volumeArgs(
  rule: VolumeFloorRule,
  ctx: CheckCtx,
  assetId: string | null,
): { args: Record<string, string>; id: string; name: string } | null {
  if (!assetId) return null;
  if (rule.scope === "conversion_action") {
    const action = ctx.metrics.index.conversionActionsById.get(assetId);
    return action ? { args: { actionId: action.id }, id: action.id, name: action.name } : null;
  }
  const asset = ctx.metrics.index.assetsById.get(assetId);
  const parentId = asset?.parentId ?? null;
  if (!parentId) return null;
  if (rule.scope === "ad_of_asset") {
    const ad = ctx.metrics.index.adsById.get(parentId);
    return ad ? { args: { adId: ad.id }, id: ad.id, name: ad.name } : null;
  }
  const group = ctx.metrics.index.assetGroupsById.get(parentId);
  return group ? { args: { assetGroupId: group.id }, id: group.id, name: group.name } : null;
}

/**
 * Apply the table. Runs for every check, after the age gate.
 *
 * A finding whose volume the model cannot resolve is LEFT ALONE — that is an
 * unknown denominator, not a small one, and the same call the age gate makes on
 * a campaign with no computable age. Suppressing there would turn a gap in our
 * own data into a silent pass on the client's account.
 */
export function applyVolumeFloorGate(
  checkId: string,
  ctx: CheckCtx,
  r: CheckResult,
  rules: Readonly<Record<string, VolumeFloorRule>> = VOLUME_FLOOR_RULES,
): CheckResult {
  if (r.state !== "fires") return r;
  const rule = rules[checkId];
  if (!rule) return r;

  const kept: CheckFinding[] = [];
  const belowFloor: { name: string; volume: number }[] = [];
  const volumeRows: EvidenceRef[] = [];
  for (const f of r.findings) {
    const target = volumeArgs(rule, ctx, f.scope.id);
    if (!target) {
      kept.push(f);
      continue;
    }
    const v = ctx.get(rule.metric, target.args);
    const volume = num(v);
    if (volume == null || volume >= rule.floor) {
      kept.push(f);
      continue;
    }
    belowFloor.push({ name: target.name, volume });
    if (isOk(v)) volumeRows.push(evidence(v, { id: target.id, name: target.name }));
  }
  if (belowFloor.length === 0) return r;

  const detail = belowFloor
    .map(
      (b) =>
        `${b.name} has ${b.volume} ${rule.unit}, under the ${rule.floor}-${rule.unit.replace(/s$/, "")} minimum`,
    )
    .join("; ");
  if (kept.length === 0) {
    return {
      state: "fires",
      findings: [],
      withheld: [...(r.withheld ?? []), `${VOLUME_FLOOR_REASON_TAG}: ${rule.why} (${detail})`],
    };
  }
  return {
    state: "fires",
    ...(r.withheld ? { withheld: r.withheld } : {}),
    findings: kept.map((f) => ({
      ...f,
      evidence: [...f.evidence, ...volumeRows],
      facts: { ...f.facts, entities_below_volume_floor: belowFloor.length },
      note: [f.note, `${belowFloor.length} finding(s) held back for too little traffic: ${detail}`]
        .filter(Boolean)
        .join("; "),
    })),
  };
}
