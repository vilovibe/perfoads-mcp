// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Measurement checks MI01-MI18: is the conversion data the account bids on
 * trustworthy. Every one of them is a confounder for some other group.
 *
 * Rules this file keeps:
 *   - a NON-PRIMARY conversion action reading 0 is never a tracking finding;
 *     MI01 only looks at primary, enabled actions, and MI02 states a coverage
 *     gap with no impact;
 *   - a tracking gap that recovered before the last settled day does not fire
 *     MI01: silence is counted backwards from the last settled day;
 *   - an UNKNOWN attribution model is an API value this version could not
 *     name: MI05 counts it out of the mix and says so.
 *
 * Every `run` calls `gateOnData` first: a table with no read status and no rows
 * is not checkable, never "none found".
 */
import { offlineUploadTargets } from "../model/nodes/AccountNode.js";
import { doubleCountOf } from "../shared/doubleCount.js";
import {
  bool,
  campaignsOf,
  type CheckCtx,
  type CheckDefinition,
  type CheckFinding,
  type CheckResult,
  defineCheck,
  expandEvidence,
  finding,
  gateOnData,
  isOk,
  num,
  str,
} from "./types.js";

/** `conversion_action_daily` — not an AuditData key; the marker is absent until the first live sync. */
const CA_DAILY = "conversion_action_daily";
const CONTROL_SETTINGS = "campaign_control_settings";

/**
 * `share_of_spend_affected` for IMP_MEASUREMENT (= `A.spend_monthly x share`).
 * ACCOUNT-scoped measurement findings judge every dollar, so their share is 1.
 * A CAMPAIGN-scoped one must never inherit that: `shareOfSpend` below sizes it
 * to `C.spend / A.spend`, otherwise a $5.32 campaign carries the whole account's
 * monthly spend as its impact.
 */
const ALL_SPEND = 1;

/** `C.spend / A.spend` for a campaign-scoped measurement finding; null when either side is unreadable. */
function shareOfSpend(ctx: CheckCtx, campaignId: string): number | null {
  const campaignSpend = num(ctx.get("C.spend", { campaignId }));
  const accountSpend = num(ctx.get("A.spend"));
  if (campaignSpend == null || accountSpend == null || accountSpend <= 0) return null;
  return campaignSpend / accountSpend;
}

// ---------------------------------------------------------------------------

/** MI01 — a PRIMARY conversion action silent past its own cadence, ending at the last settled day. */
const MI01 = defineCheck({
  id: "MI01",
  claimKey: "tracking.primary_action_silent",
  title: "primary conversion action stopped firing",
  clientLabel: "whether your main conversion action kept firing every day",
  group: "measurement",
  metrics: [
    "CA.silent_days(action)",
    "CA.fire_cadence(action)",
    "CA.last_fire_date(action)",
    "W.last_settled_day",
  ],
  confounders: ["MI05", "MI07", "MI08", "TR01"],
  requires: [CA_DAILY],
  impactFormula: "IMP_MEASUREMENT",
  noneFoundMeans: "The primary conversion action fired on each settled day in the window.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, [CA_DAILY]);
    if (gate) return gate;

    // ONLY primary actions may carry a tracking conclusion.
    const primaries = ctx.model.children.conversionActions.filter((a) => a.attrs.isPrimary);
    if (primaries.length === 0) {
      return {
        state: "not_checkable",
        reason:
          "no conversion action is marked primary; a secondary action reading 0 is never a tracking problem",
      };
    }
    // an action REMOVED 40 days ago is silent to the
    // last settled day by definition. Silence is only a tracking fault on an
    // action that is still supposed to fire, so an unknown status is not ENABLED.
    const live = primaries.filter((a) => String(a.attrs.status ?? "").toUpperCase() === "ENABLED");
    if (live.length === 0) {
      return {
        state: "not_checkable",
        reason: `${primaries.length} primary action(s), none with an ENABLED status (conversion_actions.status is ${primaries.every((a) => a.attrs.status == null) ? "null on every row" : "not ENABLED"}) — silence on a removed or unknown-status action is not a tracking fault`,
        table: "conversionActions",
      };
    }

    const settled = ctx.get("W.last_settled_day");
    const { silenceMinDays, silenceMaxGapDays: MAX_GAP_CAP_DAYS } = ctx.settings.measurement;
    const findings: CheckFinding[] = [];
    const uncovered: string[] = [];
    // actions the metric could not count for another reason, with that reason
    const unjudged: { name: string; reason: string; tooShort: boolean }[] = [];
    const noRhythm: string[] = [];
    // enabled primaries with no daily row and 0 conversions in the window
    const silentAll: string[] = [];
    let evaluated = 0;
    for (const a of live) {
      const silent = ctx.get("CA.silent_days(action)", { actionId: a.id });
      const days = num(silent);
      if (days == null) {
        // no rows for THIS action is a coverage gap; any other cause keeps its own reason.
        // The daily table was read (the gate above), so an action with no row AND no
        // conversion in the whole window is silent for the window, not a gap.
        if (a.attrs.daily != null && a.attrs.daily.length === 0) {
          if (a.attrs.totalConversions === 0) silentAll.push(a.name);
          else uncovered.push(a.name);
        } else if (!isOk(silent))
          unjudged.push({
            name: a.name,
            reason: silent.detail,
            tooShort:
              silent.code === "settled_before_window" || silent.code === "no_settled_spend_day",
          });
        else uncovered.push(a.name);
        continue;
      } // counted out, never read as 0
      evaluated += 1;
      // `CA.silent_days` runs BACKWARDS from W.last_settled_day, so a run that
      // recovered before that day is 0 here and cannot fire.
      if (days < 2) continue;
      // Review 2026-09-07: the bar is the action's OWN cadence, not two days.
      // Silence is a fault only when it exceeds max(3, 2 × median gap, longest
      // gap it ever showed — CAPPED at 14, or one 20-day historical hole would
      // hide a 19-day live outage). An action with a single firing day has no
      // rhythm at all and is not judged (second review); the volume floor
      // (≥ 10 conversions, volumeFloorGate) keeps thin actions out entirely.
      const cadence = ctx.get("CA.fire_cadence(action)", { actionId: a.id });
      if (!isOk(cadence)) {
        evaluated -= 1;
        noRhythm.push(a.name);
        continue;
      }
      const c = cadence.value as { median_gap: number; max_gap: number };
      const bar = Math.max(silenceMinDays, 2 * c.median_gap, Math.min(c.max_gap, MAX_GAP_CAP_DAYS));
      if (days <= bar) continue;
      const lastFire = ctx.get("CA.last_fire_date(action)", { actionId: a.id });
      findings.push(
        finding({
          claimKey: "tracking.primary_action_silent",
          scope: { type: "conversion_action", id: a.id, name: a.name },
          cite: [silent, cadence, lastFire, settled],
          entity: { id: a.id, name: a.name },
          // account-scoped judgement: with ONE live primary a silent action puts every
          // dollar on unverified data; with N, each carries 1/N of the claim.
          facts: {
            silent_days: days,
            silence_bar_days: bar,
            live_primary_actions: live.length,
            share_of_spend_affected: live.length === 1 ? ALL_SPEND : 1 / live.length,
          },
          population: live.length,
          note: `primary and ENABLED (${live.length} live primary action(s)); silent ${days} days to the last settled day against its own bar of ${bar} (median gap ${c.median_gap}, longest gap ${c.max_gap}${c.max_gap > MAX_GAP_CAP_DAYS ? ` capped at ${MAX_GAP_CAP_DAYS}` : ""}), so it has not recovered`,
        }),
      );
    }
    // a switched-on primary that recorded nothing all window is never "clean"; it has
    // no rhythm to call it silent against either (and under 10 conversions the
    // volume floor holds a finding back), so the check says so instead
    if (findings.length === 0 && silentAll.length > 0)
      return {
        state: "not_checkable",
        reason: `${silentAll.join(", ")}: switched on and primary, but recorded no conversion on any day of the window read, so tracking cannot be called clean`,
        table: CA_DAILY,
      };
    if (evaluated === 0) {
      if (uncovered.length === 0 && unjudged.length > 0)
        return {
          state: "not_checkable",
          reason: unjudged.map((u) => `${u.name}: ${u.reason}`).join("; "),
          table: CA_DAILY,
          ...(unjudged.every((u) => u.tooShort) ? { category: "no_history" as const } : {}),
        };
      if (uncovered.length === 0 && noRhythm.length > 0)
        return {
          state: "not_checkable",
          reason: `${noRhythm.join(", ")}: a single firing day in the window — no rhythm to judge silence against`,
          table: CA_DAILY,
          category: "thin_data",
        };
      return {
        state: "not_checkable",
        reason: `${CA_DAILY} carries no day for ${uncovered.length} of the ${live.length} enabled primary action(s) (${uncovered.join(", ")})${unjudged.length ? `; ${unjudged.map((u) => `${u.name}: ${u.reason}`).join("; ")}` : ""}${noRhythm.length ? `; ${noRhythm.join(", ")}: a single firing day, no rhythm` : ""} — not read, which is not silence`,
        table: CA_DAILY,
        category: "our_gap",
      };
    }
    if (findings.length > 0) return { state: "fires", findings };
    const skipped = [
      ...uncovered.map((n) => `${n} (no daily rows)`),
      ...unjudged.map((u) => `${u.name} (${u.reason})`),
      ...noRhythm.map((n) => `${n} (single firing day)`),
    ];
    return {
      state: "none_found",
      population: evaluated,
      note:
        skipped.length > 0
          ? `${skipped.length} primary action(s) not judged: ${skipped.join(", ")}`
          : undefined,
    };
  },
});

/** MI03 — two or more PRIMARY purchase-category actions double-count the same order. */
const MI03 = defineCheck({
  id: "MI03",
  claimKey: "tracking.duplicate_purchase_actions",
  title: "more than one primary purchase action",
  group: "measurement",
  metrics: ["A.purchase_action_count", "A.conv_actions_count", "A.conv_per_click_ratio"],
  confounders: ["MI02", "MI05"],
  requires: ["conversionActions"],
  impactFormula: "IMP_MEASUREMENT",
  noneFoundMeans: "Only one purchase action counts toward the primary goal; no double counting.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["conversionActions"]);
    if (gate) return gate;

    const purchase = ctx.get("A.purchase_action_count");
    if (!isOk(purchase))
      return {
        state: "not_checkable",
        reason: `A.purchase_action_count is ${purchase.reason}: ${purchase.detail}`,
      };
    const count = num(purchase) ?? 0;
    if (count === 0)
      return {
        state: "none_found",
        population: num(ctx.get("A.conv_actions_count")),
        note: "no action carries a purchase/sale category",
      };

    // The closed category set lives in the registry; the ids it matched come back
    // as `source.rowIds`, so the primary count is not a second definition of it.
    const ids = purchase.source.rowIds ?? [];
    const primaries = ids.flatMap((id) => {
      const a = ctx.metrics.index.conversionActionsById.get(id);
      return a?.attrs.isPrimary === true ? [a] : [];
    });
    const live = primaries.filter((a) => String(a.attrs.status ?? "").toUpperCase() === "ENABLED");
    // one rule with the MI03 confounder: enabled, recorded conversions, same kind
    const double = doubleCountOf(primaries);
    // The note ALWAYS carries both numbers: "4 purchase actions exist, 1 is primary"
    // is a different statement from "there is only one purchase action".
    const note = `${count} purchase actions exist, ${primaries.length} ${primaries.length === 1 ? "is" : "are"} primary, ${live.length} of them enabled; ${double.state === "fires" ? double.actions.length : "no two"} enabled ones of one kind recorded conversions in the window`;

    if (double.state === "unknown")
      return { state: "not_checkable", reason: double.reason, table: "conversionActions" };
    if (double.state === "clean") return { state: "none_found", population: count, note };

    const share = duplicateSpendShare(ctx, double.categories);
    const ratio = ctx.get("A.conv_per_click_ratio");
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "tracking.duplicate_purchase_actions",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [purchase, ratio],
          facts: {
            purchase_action_count: count,
            primary_purchase_action_count: double.actions.length,
            // unknown which campaigns bid on both: no share, so no money figure
            ...(share != null ? { share_of_spend_affected: share } : {}),
          },
          population: count,
          note,
        }),
      ],
    };
  },
});

/**
 * The share of spend a double count touches: the spend of the running campaigns
 * whose biddable goals include a duplicated category, over all running campaigns'
 * spend. 1 when every running spender bids on them; null when the goals were not
 * read, so the finding carries no money rather than the whole account's spend.
 * Paused and removed campaigns stay out of both sides: their goals are not read
 * (removed) and a double count no longer costs them anything.
 */
function duplicateSpendShare(ctx: CheckCtx, categories: string[]): number | null {
  if (gateOnData(ctx, ["campaignConversionGoals"])) return null;
  let touched = 0;
  let total = 0;
  for (const c of campaignsOf(ctx)) {
    const spend = num(ctx.get("C.spend", { campaignId: c.id }));
    if (spend == null || spend <= 0) continue;
    total += spend;
    const goals = c.attrs.conversionGoals ?? [];
    if (goals.length === 0) return null; // this campaign's goals were not read
    const bids = biddableCategories(goals);
    if (categories.some((cat) => bids.has(cat))) touched += spend;
  }
  if (total <= 0) return null;
  return touched >= total ? ALL_SPEND : touched / total;
}

/** conversion_value_by_rule: recorded value per campaign x rule dimension (item 9). */
const VALUE_BY_RULE = "conversion_value_by_rule";

/** The by-rule dimension a customer-acquisition rule reports under. */
const ACQUISITION_DIMENSION = "NEW_VS_RETURNING_USER";

/**
 * MI04 — conversion value rules and what they ADD to (or REMOVE from)
 * reported value.
 *
 * REWORK (2026-09-06, item 9 of the casefile plan). Until today this fired on
 * the COUNT of rules ("15 conversion value rules are changing recorded
 * values"). Presence proves nothing: a rule may never match a conversion, or
 * may be silently inflating every ROAS in the report, and a count cannot tell
 * the two apart. It now reads `segments.conversion_value_rule_primary_dimension`
 * (conversion_value_by_rule): NO_RULE_APPLIED + ORIGINAL is the value
 * before any rule; every other row is the net adjustment the rules made.
 *
 * The share is SIGNED (review 2026-09-07): a MULTIPLY < 1 or a lower SET_TO
 * makes it negative, and an account whose value was halved is judged on
 * |share|, worded as "remove", never cleared as "add nothing".
 *
 *   - |share| ≥ 5% of reported value    → fires, with the amount and the share.
 *     The amount is NOT waste (it is reported value, not spend), so the finding
 *     carries no dollar impact; the share is its evidence.
 *   - rules exist, |share| < 5%         → none_found ("not materially changing")
 *   - the by-rule table has no rows      → not_checkable naming the table, never 0.
 *
 * Population: `judges` says campaigns, so the printed population is the
 * campaigns with recorded value in the by-rule split, not the rule count.
 */
const MI04 = defineCheck({
  id: "MI04",
  claimKey: "tracking.value_rules_distorting",
  title: "conversion value rules active",
  group: "measurement",
  metrics: ["A.value_rules_enabled_count", "A.value_added_by_rules"],
  confounders: ["MI05", "MI07"],
  // the split by rule matters only once a rule is enabled: read there, not a requirement
  requires: ["conversionValueRules"],
  // The amount the rules add is reported VALUE, not spend: never priced.
  impactFormula: null,
  noneFoundMeans: "No conversion value rule is materially changing reported value.",
  judges: {
    campaigns: "all",
    because:
      "a value rule adjusts wherever a conversion is recorded, so every campaign with recorded value in the window is in the population",
  },
  notCheckableCategory: "our_gap",
  clientLabel: "conversion value rules changing what your sales are worth",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["conversionValueRules"]);
    if (gate) return gate;

    const rules = ctx.get("A.value_rules_enabled_count");
    if (!isOk(rules))
      return {
        state: "not_checkable",
        reason: `A.value_rules_enabled_count is ${rules.reason}: ${rules.detail}`,
      };
    const enabled = num(rules) ?? 0;
    if (enabled === 0)
      return {
        state: "none_found",
        population: 0,
        note: "no conversion value rule is enabled",
        evidence: expandEvidence(rules),
      };

    const added = ctx.get("A.value_added_by_rules");
    if (!isOk(added))
      return {
        state: "not_checkable",
        reason: `A.value_added_by_rules is ${added.reason}: ${added.detail}`,
        table: VALUE_BY_RULE,
      };
    const v = added.value as {
      amount: number;
      share: number | null;
      total: number;
      base: number;
      unknown: number;
      campaigns: number;
    };
    if (v.share == null)
      return {
        state: "insufficient_data",
        reason: `${enabled} enabled rules, but no conversion value was recorded in the window — nothing for a rule to have adjusted`,
      };

    const money = (x: number) => Math.abs(x).toFixed(2);
    const pctOf = (x: number) => `${(Math.abs(x) * 100).toFixed(1)}%`;
    const verb = v.amount < 0 ? "remove" : "add";
    const population = v.campaigns;
    const VALUE_RULES_ADDED_SHARE_NOTEWORTHY = ctx.settings.measurement.valueRulesShare;
    if (Math.abs(v.share) < VALUE_RULES_ADDED_SHARE_NOTEWORTHY) {
      return {
        state: "none_found",
        population,
        note:
          v.amount === 0
            ? `${enabled} enabled rules add nothing to ${money(v.total)} of reported value`
            : `${enabled} enabled rules ${verb} ${money(v.amount)} (${pctOf(v.share)}) ${verb === "add" ? "to" : "from"} ${money(v.total)} of reported value — below the ${pctOf(VALUE_RULES_ADDED_SHARE_NOTEWORTHY)} mark`,
        evidence: [...expandEvidence(rules), ...expandEvidence(added)],
      };
    }

    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "tracking.value_rules_distorting",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [rules, added],
          facts: {
            enabled_rules_count: enabled,
            value_added_by_rules: v.amount,
            share_of_value_added_pct: v.share * 100,
            reported_value_total: v.total,
            reported_value_before_rules: v.base,
            campaigns_with_value_count: v.campaigns,
          },
          population,
          note: `${enabled} enabled rules ${verb} ${money(v.amount)} ${verb === "add" ? "of" : "from"} ${money(v.total)} reported value (${pctOf(v.share)}) — every ROAS in the report is standing on it`,
        }),
      ],
    };
  },
});

/**
 * MI14 — value rules with no condition (2026-09-06, item 9; honest state
 * since the 2026-09-07 review).
 *
 * A conversion value rule is meant to say "worth X more WHEN <condition>". An
 * ENABLED rule with no condition the sync reads (geo incl. excluded, device,
 * audience, and since Phase 11 the travel itinerary) either never matches or
 * applies to every conversion. Live audit
 * account: 15 ENABLED rules, ADD 30.66–72, every condition empty — and
 * ZERO rule sets synced. The v23 rules resource has NO field for a
 * new-vs-returning-customer condition, and the v23 rule-set dimension enum
 * has none either (GEO_LOCATION / DEVICE / AUDIENCE / ITINERARY / NO_CONDITION;
 * re-checked 2026-09-29), so a customer-acquisition rule (a
 * deliberate, common setup) reads exactly like an empty one here. A finding
 * that has to hedge itself is a false finding, so the default is
 * not_checkable (our gap), and it is promoted to `fires` only when one of two
 * sources rules acquisition out:
 *   (i)  the rule sets synced with `dimensions`, and the set each rule belongs
 *        to carries no NEW_VS_RETURNING_USER; or
 *   (ii) the by-rule value split is loaded, shows the rules adding value, and
 *        has NO NEW_VS_RETURNING_USER row at all.
 */
const MI14 = defineCheck({
  id: "MI14",
  claimKey: "tracking.value_rules_unconditional",
  title: "conversion value rules with no condition",
  group: "measurement",
  metrics: ["A.value_rules_enabled_count", "A.value_rules_unconditional", "A.value_added_by_rules"],
  confounders: [],
  requires: ["conversionValueRules"],
  impactFormula: null,
  noneFoundMeans: "Every enabled conversion value rule is tied to a condition.",
  notCheckableCategory: "our_gap",
  clientLabel: "conversion value rules that apply to every sale",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["conversionValueRules"]);
    if (gate) return gate;

    const rules = ctx.get("A.value_rules_enabled_count");
    if (!isOk(rules))
      return {
        state: "not_checkable",
        reason: `A.value_rules_enabled_count is ${rules.reason}: ${rules.detail}`,
      };
    const enabled = num(rules) ?? 0;
    if (enabled === 0)
      return {
        state: "none_found",
        population: 0,
        note: "no conversion value rule is enabled",
        evidence: expandEvidence(rules),
      };

    // a rule whose conditions were not read cannot be called unconditional
    const rulesRows = ((ctx.metrics.data as unknown as { conversionValueRules?: any[] })
      .conversionValueRules ?? []) as Record<string, unknown>[];
    if (rulesRows.some((r) => String(r.status) === "ENABLED" && r.conditions_read === false))
      return {
        state: "not_checkable",
        reason: `${enabled} enabled value rule(s), but this check needs each rule's conditions, which this server doesn't read yet`,
        table: "conversionValueRules",
        category: "our_gap",
      };
    const unconditional = ctx.get("A.value_rules_unconditional");
    if (!isOk(unconditional))
      return {
        state: "not_checkable",
        reason: `A.value_rules_unconditional is ${unconditional.reason}: ${unconditional.detail}`,
      };
    const candidates = ctx.model.attrs.conversionValueRules.unconditional;
    if (candidates.length === 0)
      return {
        state: "none_found",
        population: enabled,
        evidence: [...expandEvidence(rules), ...expandEvidence(unconditional)],
      };

    // (i) the rule sets name their dimensions: a rule whose set has no
    // acquisition dimension is proven unconditional.
    const sets = ctx.model.attrs.conversionValueRuleSets.sets;
    const setOf = (ruleId: string) =>
      sets.find((s) =>
        s.rules.some((r) => r === ruleId || r.endsWith(`/conversionValueRules/${ruleId}`)),
      );
    const provenBySet = candidates.filter((c) => {
      const s = setOf(c.ruleId);
      return s != null && s.dimensions != null && !s.dimensions.includes(ACQUISITION_DIMENSION);
    });
    // (ii) the by-rule split shows the rules adding value with no acquisition row anywhere.
    const added = ctx.get("A.value_added_by_rules");
    const split = ctx.model.attrs.conversionValueByRule;
    const provenBySplit =
      isOk(added) &&
      split != null &&
      split.length > 0 &&
      (added.value as { amount: number }).amount > 0 &&
      !split.some((r) => r.dimension === ACQUISITION_DIMENSION);
    const proven = provenBySplit ? candidates : provenBySet;
    if (proven.length === 0) {
      return {
        state: "not_checkable",
        reason: `${candidates.length} of ${enabled} enabled value rules carry no geo / device / audience condition, but the rules expose no new-vs-returning condition and the rule-set dimensions were not read, so a customer-acquisition rule cannot be told apart from an empty one`,
        table: "conversion_value_rule_sets",
        category: "our_gap",
      };
    }

    const ids = proven.map((c) => c.ruleId);
    const addAmounts = proven
      .filter((c) => c.operation === "ADD" && c.value != null)
      .map((c) => c.value as number);
    const addTotal = addAmounts.reduce((s, x) => s + x, 0);
    const lo = addAmounts.length > 0 ? Math.min(...addAmounts) : null;
    const hi = addAmounts.length > 0 ? Math.max(...addAmounts) : null;
    const nonAdd = proven.filter((c) => c.operation !== "ADD").length;
    const how = provenBySplit
      ? "the by-rule value split shows them adding value with no new-vs-returning row"
      : "their rule sets carry no new-vs-returning dimension";
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "tracking.value_rules_unconditional",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [rules, unconditional, ...(provenBySplit && isOk(added) ? [added] : [])],
          facts: {
            unconditional_rules_count: ids.length,
            enabled_rules_count: enabled,
            rule_ids: ids.join(", "),
            add_rules_count: addAmounts.length,
            add_value_total: addTotal,
            add_value_min: lo,
            add_value_max: hi,
            non_add_rules_count: nonAdd,
          },
          population: enabled,
          note: `${ids.length} of ${enabled} enabled value rules carry no condition; ${how}. ${addAmounts.length > 0 ? `${addAmounts.length} ADD a flat ${lo}–${hi} to every conversion they cover` : ""}${nonAdd > 0 ? `${addAmounts.length > 0 ? "; " : ""}${nonAdd} MULTIPLY / SET_TO` : ""}`,
        }),
      ],
    };
  },
});

/** MI05 — more than one REAL attribution model in use. UNKNOWN is a sync-enum artefact, never a model. */
const MI05 = defineCheck({
  id: "MI05",
  claimKey: "attribution.model_mix",
  title: "conversion actions on different attribution models",
  group: "measurement",
  metrics: ["A.attribution_model_mix_bidding", "A.bidding_action_count"],
  confounders: ["MI02"],
  requires: ["conversionActions"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "The conversion actions the bidding uses share one attribution model.",
  /**
   * FALSE-FINDING FIX.
   *
   * This read `A.attribution_model_mix`, a count across EVERY action the API
   * returns, and reported "the account's conversion actions run on 2 different
   * attribution models" about an account with ONE primary action on data-driven
   * attribution. The eleven it counted included six REMOVED actions — deleted,
   * and still being audited — and the "second model" came from one of those
   * plus a dormant YouTube secondary with zero conversions.
   *
   * A secondary action is allowed its own attribution model, its own counting
   * type and no data at all, because nothing bids on it. Judging how an account
   * measures by its secondaries is judging a business by its notes. So the
   * population is now the actions the BIDDING reads, and nothing else.
   */
  judges: {
    conversionActions: "bidding",
    because: "a secondary or removed action is allowed its own model — nothing optimises on it",
  },
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["conversionActions"]);
    if (gate) return gate;

    const mix = ctx.get("A.attribution_model_mix_bidding");
    if (!isOk(mix))
      return {
        state: "not_checkable",
        reason: `A.attribution_model_mix_bidding is ${mix.reason}: ${mix.detail}`,
      };
    const map = (mix.value ?? {}) as Record<string, number>;
    // an enum the requested API version could not name is a DATA DEFECT.
    // It is counted out of the mix and reported as an artefact, never as
    // "one model is unidentified".
    const unnamed = (map.UNKNOWN ?? 0) + (map.NULL ?? 0);
    const named = Object.keys(map).filter((k) => k !== "UNKNOWN" && k !== "NULL");
    const total = ctx.get("A.bidding_action_count");
    // Nothing to be consistent ABOUT. "One model" and "no models" are different
    // answers, and only one of them is a clean bill of health.
    const biddingCount: number = num(total) ?? 0;
    if (biddingCount === 0) {
      return {
        state: "not_checkable",
        reason:
          "no live, primary conversion action that counts in Conversions, so there is nothing the bidding reads whose attribution could agree or disagree",
      };
    }

    const artefact =
      unnamed > 0
        ? `${unnamed} action${unnamed === 1 ? "" : "s"} report UNKNOWN — a value this API version could not name, not an account problem`
        : undefined;

    if (named.length <= 1) {
      return { state: "none_found", population: num(total), note: artefact };
    }
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "attribution.model_mix",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [mix, total],
          facts: { models: named.length, model_mix: map, unnamed_actions: unnamed },
          population: num(total),
          note: [
            `${named.length} attribution models across the ${biddingCount} action${biddingCount === 1 ? "" : "s"} the bidding uses: ${named.map((k) => `${k} x${map[k]}`).join(", ")}`,
            artefact,
          ]
            .filter(Boolean)
            .join("; "),
        }),
      ],
    };
  },
});

/**
 * R3.6b: the channels whose ads are mostly SEEN (video, image feeds, PMax's
 * YouTube and Display inventory). The Demand Gen playbook's split applies to
 * them: 90%+ of conversions from clicks = trust the number; 20%+ from views =
 * the return is inflated. Between the two bars a view-heavy campaign on these
 * channels is a note (`info`), not a warning — views are part of the job there.
 */
const VIEW_CHANNEL_TYPES = new Set(["PERFORMANCE_MAX", "DEMAND_GEN", "VIDEO", "DISPLAY"]);

/**
 * Phase F: a campaign that shows only on YouTube (a Video campaign, or Demand Gen
 * whose channel controls allow YouTube alone). View conversions are how such a
 * campaign is measured, so its view share is a note with no money at risk.
 */
function isYouTubeOnly(c: {
  attrs: {
    type: string;
    dgChannelControls?: { allowedNetworks: string[] | null } | null | undefined;
  };
}): boolean {
  if (c.attrs.type === "VIDEO") return true;
  const allowed = c.attrs.dgChannelControls?.allowedNetworks;
  return (
    c.attrs.type === "DEMAND_GEN" &&
    allowed != null &&
    allowed.length === 1 &&
    allowed[0] === "YOUTUBE"
  );
}

/**
 * Round 2: a remarketing campaign (a user list among its audiences, or "RT" /
 * remarketing / retargeting in its name). View conversions there often credit
 * people who were going to buy anyway.
 */
function isRemarketing(c: {
  name: string | null;
  children: { slices: { audience?: { attrs: { extra: Record<string, unknown> } }[] } };
}): boolean {
  if ((c.children.slices.audience ?? []).some((s) => s.attrs.extra.userListId != null)) return true;
  return /(^|[^a-z0-9])(rt|remarketing|retargeting)([^a-z0-9]|$)/i.test(c.name ?? "");
}

const REMARKETING_VIEW_LINE =
  "It is a remarketing campaign: view conversions there often credit people who were going to buy anyway.";

/** MI06 — view-through conversions above 10% of all conversions on a campaign. */
const MI06 = defineCheck({
  id: "MI06",
  claimKey: "tracking.viewthrough_inflation",
  title: "many of a campaign's conversions come from views, not clicks",
  group: "measurement",
  metrics: ["C.viewthrough_share", "F.conv_min_for_verdict"],
  confounders: ["MI01", "MI05"],
  requires: [CONTROL_SETTINGS],
  impactFormula: "IMP_MEASUREMENT",
  noneFoundMeans:
    "View-through conversions stay under 10% on the campaigns with enough conversions to judge.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, [CONTROL_SETTINGS]);
    if (gate) return gate;

    const { viewThroughSharePct, viewThroughInflatedPct: VIEW_SHARE_INFLATED_PCT } =
      ctx.settings.measurement;
    const findings: CheckFinding[] = [];
    let judged = 0;
    const belowFloor: string[] = [];
    let noRow = 0;
    // a row that predates the conversions column (older snapshot): not the same as no row
    let convNotRead = 0;
    for (const c of campaignsOf(ctx)) {
      const vt = ctx.get("C.viewthrough_share", { campaignId: c.id });
      if (!isOk(vt)) {
        if (vt.reason === "insufficient_data") belowFloor.push(c.name ?? c.id);
        else if (c.attrs.controlSettings && c.attrs.controlSettings.conversions == null)
          convNotRead += 1;
        else noRow += 1;
        continue;
      }
      const share = num(vt);
      if (share == null) continue;
      judged += 1;
      if (share <= viewThroughSharePct) continue;
      // CAMPAIGN scope: size the money at risk to THIS campaign, never to the account.
      // A YouTube-only campaign carries none: views are its job, not inflation.
      const youtubeOnly = isYouTubeOnly(c);
      const remarketing = youtubeOnly && isRemarketing(c);
      const affected = youtubeOnly ? null : shareOfSpend(ctx, c.id);
      // R3.6b: the click / view split beside the share, and the channel band
      const viewChannel = VIEW_CHANNEL_TYPES.has(c.attrs.type);
      const vtc = c.attrs.controlSettings?.viewThroughConversions ?? null;
      // the conversions read beside the view-through ones (same range), the share's other half
      const clickConv = c.attrs.controlSettings?.conversions ?? c.windows.m90.conv;
      const base = finding({
        claimKey: "tracking.viewthrough_inflation",
        scope: { type: "campaign", id: c.id, name: c.name, campaignId: c.id, campaignName: c.name },
        cite: [vt, ctx.get("C.spend", { campaignId: c.id }), ctx.get("A.spend")],
        entity: { id: c.id, name: c.name },
        // omitted, not guessed, when the two spends do not resolve: IMP_MEASUREMENT
        // then returns IMP_NONE with the reason instead of sizing it wrong.
        facts: {
          viewthrough_share: share,
          ...(affected == null ? {} : { share_of_spend_affected: affected }),
          view_channel: viewChannel,
          ...(vtc == null ? {} : { view_through_conversions: vtc }),
          ...(clickConv == null ? {} : { click_and_engaged_conversions: clickConv }),
          // YouTube-only: views are its normal measure, so no band (never "inflated")
          ...(viewChannel && !youtubeOnly
            ? { view_share_band: share >= VIEW_SHARE_INFLATED_PCT ? "inflated" : "watch" }
            : {}),
          ...(youtubeOnly ? { youtube_only: true } : {}),
          ...(remarketing ? { remarketing: true } : {}),
        },
        population: campaignsOf(ctx).length,
        ...(youtubeOnly
          ? {
              note: `the campaign shows only on YouTube, where view conversions are the normal measure; stated as a note, no money at risk${
                remarketing ? `. ${REMARKETING_VIEW_LINE}` : ""
              }`,
            }
          : {}),
      });
      findings.push(
        viewChannel
          ? {
              ...base,
              // above 10% and under 20% a view-led channel is doing its job: a note, never a warning; 20% exactly = inflated.
              // YouTube-only: a note at any share
              ...(share < VIEW_SHARE_INFLATED_PCT || youtubeOnly
                ? { maxSeverity: "info" as const }
                : {}),
              // engaged views (10s+ watched, no click) sit INSIDE Google's conversions column; the split is not synced
              openItems: [
                "We could not split out engaged-view conversions (people who watched 10+ seconds and did not click). Google counts them inside the conversions column, so the click-only number may be lower still.",
                // the plain line beside a YouTube-only remarketing note (no money on it)
                ...(remarketing ? [REMARKETING_VIEW_LINE] : []),
              ],
            }
          : base,
      );
    }

    // Rule 4: nothing judged is not "clean". Say which campaigns could not be judged.
    const convNotReadText =
      convNotRead > 0
        ? `${convNotRead} whose conversions were not read beside view-through conversions (an older snapshot; rebuild it)`
        : null;
    if (judged === 0) {
      const parts = [
        belowFloor.length > 0 ? `${belowFloor.length} below the conversion floor` : null,
        noRow > 0 ? `${noRow} with no ${CONTROL_SETTINGS} row joining the campaign` : null,
        convNotReadText,
      ].filter(Boolean);
      // only old-snapshot rows: the share cannot be computed at all, so not checkable, not "too few"
      if (convNotRead > 0 && belowFloor.length === 0)
        return {
          state: "not_checkable",
          reason: `no campaign could be judged for view-through: ${parts.join("; ")}`,
          table: CONTROL_SETTINGS,
          category: "incomplete_data",
        };
      return {
        state: "insufficient_data",
        reason: `no campaign met the conversion floor for a view-through verdict (${parts.join("; ") || "no campaigns"})`,
      };
    }
    if (findings.length > 0) return { state: "fires", findings };
    // Rule 4 again: a none-found says what it did NOT cover, both kinds.
    const unjudged = [
      belowFloor.length > 0
        ? `${belowFloor.length} below the conversion floor (${belowFloor.join(", ")})`
        : null,
      noRow > 0 ? `${noRow} with no ${CONTROL_SETTINGS} row joining the campaign` : null,
      convNotReadText,
    ].filter(Boolean);
    const note =
      unjudged.length > 0
        ? `${judged} of ${campaignsOf(ctx).length} campaigns judged; not judged: ${unjudged.join("; ")}`
        : undefined;
    return { state: "none_found", population: judged, note };
  },
});

/**
 * The goal categories a goal set actually BIDS toward.
 *
 * Phase 4. `conversionGoalsDifferFromCustomer` compares the whole
 * `category|origin|biddable` triple, so a campaign is "different" the moment any
 * goal it does not bid toward is listed in a different order or with a different
 * origin. On the golden account that made SEVEN campaigns "override the account
 * conversion goals" when every one of them bid toward exactly `PURCHASE`, which is
 * the correct setting for a shop. Only the BIDDABLE categories change what the
 * campaign optimises for; everything else is a listing.
 */
function biddableCategories(
  goals: readonly { category: string; biddable: boolean }[],
): Set<string> {
  return new Set(
    goals
      .filter((g) => g.biddable)
      .map((g) => g.category)
      .filter((c) => c !== ""),
  );
}

const sortedList = (s: Set<string>): string => [...s].sort().join(", ");

/**
 * MI07 — a campaign bids toward something the account does not.
 *
 * Phase 4 rewrite. The old check fired on "this is not the account default", which
 * is not a fault: narrowing a campaign to the one goal that makes money is the
 * correct configuration, and it is what every campaign on the golden account had
 * done. Two things ARE faults and both are tested here:
 *
 *   1. the campaign bids toward a goal the ACCOUNT does not bid toward — it is
 *      optimising for something nobody chose at the account level;
 *   2. the campaign bids toward NONE of the account's biddable goals — it shares no
 *      objective with the rest of the account, so its conversions are not the same
 *      thing as everyone else's.
 *
 * A campaign whose biddable set is a non-empty subset of the account's has TIGHTENED
 * its objective. That is a context line, not a finding.
 */
const MI07 = defineCheck({
  id: "MI07",
  claimKey: "tracking.campaign_goal_override",
  title: "campaign bids toward a different conversion goal than the account",
  group: "measurement",
  metrics: ["C.goal_override(campaign)"],
  confounders: ["MI05"],
  requires: ["campaignConversionGoals", "customerConversionGoals"],
  impactFormula: "IMP_NONE",
  noneFoundMeans:
    "Each campaign bids toward the account conversion goals, or a narrower set of them.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["campaignConversionGoals", "customerConversionGoals"]);
    if (gate) return gate;

    const accountGoals = ctx.model.attrs.customerConversionGoals;
    const accountBids = biddableCategories(accountGoals);
    if (accountBids.size === 0) {
      return {
        state: "not_checkable",
        reason:
          "the account has no biddable conversion goal, so a campaign cannot be compared against it",
        table: "customerConversionGoals",
      };
    }

    const findings: CheckFinding[] = [];
    let judged = 0;
    let narrowed = 0;
    for (const c of campaignsOf(ctx)) {
      const v = ctx.get("C.goal_override(campaign)", { campaignId: c.id });
      const override = bool(v);
      if (override == null) continue;
      judged += 1;
      if (!override) continue;

      const campaignBids = biddableCategories(c.attrs.conversionGoals);
      // (1) bidding toward something the account does not bid toward.
      const added = [...campaignBids].filter((g) => !accountBids.has(g)).sort();
      // (2) sharing no objective with the account at all.
      const sharesNothing =
        campaignBids.size > 0 && [...campaignBids].every((g) => !accountBids.has(g));
      // A campaign with an empty biddable set bids toward nothing it can report —
      // that is MI05's subject (no biddable goal anywhere), not a difference.
      if (campaignBids.size === 0) continue;
      if (added.length === 0 && !sharesNothing) {
        narrowed += 1;
        continue;
      }

      findings.push(
        finding({
          claimKey: "tracking.campaign_goal_override",
          scope: {
            type: "campaign",
            id: c.id,
            name: c.name,
            campaignId: c.id,
            campaignName: c.name,
          },
          cite: [v],
          entity: { id: c.id, name: c.name },
          facts: {
            campaign_bids_toward: [...campaignBids].sort(),
            account_bids_toward: [...accountBids].sort(),
            goals_the_account_does_not_bid_toward: added,
            shares_no_goal_with_the_account: sharesNothing,
          },
          /**
           * REVIEW FIX (2026-09-09): `judged` INCREMENTS as the loop runs, so the first
           * campaign to fire recorded `population: 1`. That number reaches the writer,
           * is quotable, and prints as "Population judged: 1" on the card — on an
           * account with seven campaigns. Back-filled after the loop, the way
           * `search.ts` and `budgetBidding.ts` already do it.
           */
          population: null,
          rows: [
            {
              entity: { id: c.id, name: c.name },
              cells: { bids_toward: sortedList(campaignBids) },
            },
            {
              entity: { id: ctx.model.id, name: `${ctx.model.name} (account)` },
              cells: { bids_toward: sortedList(accountBids) },
            },
          ],
          note: sharesNothing
            ? "this campaign bids toward none of the goals the account bids toward"
            : `bids toward ${added.join(", ")}, which the account does not`,
        }),
      );
    }
    if (judged === 0)
      return {
        state: "not_checkable",
        reason:
          "no campaign has campaign_conversion_goals rows to compare against the account goals",
        table: "campaignConversionGoals",
      };
    // the real population, known only once every campaign has been looked at
    for (const f of findings) f.sample = { ...f.sample, population: judged };
    if (findings.length > 0) return { state: "fires", findings };
    return {
      state: "none_found",
      population: judged,
      note:
        narrowed > 0
          ? `${narrowed} campaign(s) bid toward a subset of the account goals, which is a tightening rather than a difference`
          : undefined,
    };
  },
});

/** MI08 — the window's recent days are not settled, so any comparison over them is a caveat, not a trend. */
const MI08 = defineCheck({
  id: "MI08",
  claimKey: "window.unsettled_comparison",
  title: "comparisons reach past the last settled day",
  group: "measurement",
  // the audit window itself
  selfAudit:
    "the most recent days in the period we looked at are still collecting sales, so a comparison across them is not settled yet",
  metrics: [
    "W.settled_days",
    "W.window_days",
    "W.last_settled_day",
    "W.max_lookback_days",
    "A.roas_window(w)",
  ],
  confounders: [],
  // W.max_lookback_days reads conversionActions and W.settled_days reads dailyMetrics
  // (registry/metrics.ts:245,251). Only W.window_days / W.last_settled_day are derived.
  requires: ["conversionActions", "dailyMetrics"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "The comparisons in this run use settled data.",
  run(ctx: CheckCtx): CheckResult {
    const lookback = ctx.get("W.max_lookback_days");
    if (!isOk(lookback))
      return {
        state: "not_checkable",
        reason: `W.max_lookback_days is ${lookback.reason}: ${lookback.detail} — nothing can be called settled`,
      };

    const settledDays = ctx.get("W.settled_days");
    const windowDays = ctx.get("W.window_days");
    const s = num(settledDays);
    const w = num(windowDays);
    if (s == null || w == null)
      return {
        state: "not_checkable",
        reason: "the window could not be placed on a calendar (no dated daily series)",
      };
    if (s >= w)
      return { state: "none_found", population: w, note: "every day in the window is settled" };

    const lastSettled = ctx.get("W.last_settled_day");
    const recent = ctx.get("A.roas_window(w)", { window: "recent30" });
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "window.unsettled_comparison",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [settledDays, windowDays, lookback, lastSettled, recent],
          facts: { settled_days: s, window_days: w, unsettled_days: w - s },
          population: w,
          // the recent-30d number is entirely unsettled and may never be stated as a trend.
          note: `${s} of ${w} days are settled; the most recent ${w - s} days still collect conversions, so a recent-window comparison is a caveat, not a trend`,
        }),
      ],
    };
  },
});

/** MI09 — the sync stopped on the run date, so the last day is partial. An ENGINE defect, reported internally. */
const MI09 = defineCheck({
  // W.settled_days reads dailyMetrics (registry/metrics.ts:251)
  id: "MI09",
  claimKey: "window.range_end_not_yesterday",
  title: "the period read does not end yesterday",
  group: "measurement",
  // the audit window itself — an engine defect when it fires
  selfAudit:
    "the period we looked at does not run right up to yesterday, so the last day in it is only partly counted",
  metrics: ["W.end_is_yesterday", "W.range_end"],
  confounders: [],
  requires: ["dailyMetrics"],
  impactFormula: "IMP_NONE",
  noneFoundMeans: "The period read ends yesterday; no partial day.",
  run(ctx: CheckCtx): CheckResult {
    const endIsYesterday = ctx.get("W.end_is_yesterday");
    const isYesterday = bool(endIsYesterday);
    if (isYesterday == null)
      return {
        state: "not_checkable",
        reason: "W.end_is_yesterday could not be computed (no dated daily series)",
      };
    const rangeEnd = ctx.get("W.range_end");
    if (isYesterday) return { state: "none_found", population: 1 };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "window.range_end_not_yesterday",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [endIsYesterday, rangeEnd],
          facts: { range_end: str(rangeEnd), run_date: ctx.metrics.runDate },
          population: 1,
          note: `range_end ${str(rangeEnd) ?? "?"} against run date ${ctx.metrics.runDate} — the last day is partial`,
        }),
      ],
    };
  },
});

/** MI10 — enhanced conversions / customer data terms not in place. */
const MI10 = defineCheck({
  // the enhanced-conversions and data-terms flags come from conversionTrackingSettings
  id: "MI10",
  claimKey: "tracking.enhanced_conversions_missing",
  title: "enhanced conversions or data terms missing",
  group: "measurement",
  metrics: ["A.enhanced_conv_leads", "A.customer_data_terms"],
  confounders: [],
  requires: ["conversionTrackingSettings"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Enhanced conversions and data terms are in place.",
  run(ctx: CheckCtx): CheckResult {
    const leads = ctx.get("A.enhanced_conv_leads");
    const terms = ctx.get("A.customer_data_terms");
    if (!isOk(leads) && !isOk(terms)) {
      return {
        state: "not_checkable",
        reason: "no conversion_tracking_settings row for this account",
        table: "conversion_tracking_settings",
      };
    }
    const missing: string[] = [];
    if (bool(leads) === false) missing.push("enhanced conversions");
    if (bool(terms) === false) missing.push("customer data terms");
    if (missing.length === 0) {
      // "Empty is not clean" applies PER FIELD: a field that did not resolve cannot
      // be half of a positive, so an unknown one blocks the none-found outright.
      const unknown = [
        bool(leads) == null ? "the enhanced conversions setting" : null,
        bool(terms) == null ? "the customer data terms" : null,
      ].filter(Boolean);
      if (unknown.length > 0) {
        return {
          state: "not_checkable",
          reason: `${unknown.join(" and ")} could not be read, and an unknown setting cannot be called "in place"`,
          table: "conversion_tracking_settings",
        };
      }
      // this positive and a CRITICAL at MI01 on the same run is a contradiction.
      return { state: "none_found", population: 1 };
    }
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "tracking.enhanced_conversions_missing",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [leads, terms],
          facts: { enhanced_conv_leads: bool(leads), customer_data_terms: bool(terms) },
          population: 1,
          note: `not in place: ${missing.join(", ")}`,
        }),
      ],
    };
  },
});

/**
 * MI11 — who owns the conversion tracking. A positive when this account owns it (`info`);
 * clean when a manager account owns it (cross-account tracking: a normal set-up);
 * not run when tracking is not set up at all (no owner to state).
 */
const MI11 = defineCheck({
  id: "MI11",
  claimKey: "tracking.ownership_ok",
  title: "who owns the conversion tracking",
  noteOnly: "this account owns its conversion tracking",
  group: "measurement",
  metrics: ["A.tracking_ownership"],
  confounders: [],
  requires: ["conversionTrackingSettings"],
  impactFormula: "IMP_NONE",
  noneFoundMeans:
    "A manager account owns the conversion tracking (cross-account tracking); this account does not own it itself.",
  run(ctx: CheckCtx): CheckResult {
    const ownership = ctx.get("A.tracking_ownership");
    if (!isOk(ownership))
      return {
        state: "not_checkable",
        reason: `A.tracking_ownership is ${ownership.reason}: ${ownership.detail}`,
        table: "conversion_tracking_settings",
      };
    const value = (str(ownership) ?? "").toUpperCase();
    if (value.endsWith("NOT_CONVERSION_TRACKED"))
      return {
        state: "not_checkable",
        reason: "conversion tracking is not set up on this account, so it has no owner to state",
        category: "not_present",
      };
    if (value.includes("MANAGED_BY_ANOTHER_MANAGER") || value.includes("MANAGED_BY_THIS_MANAGER"))
      return {
        state: "none_found",
        population: 1,
        note: "a manager account owns the conversion tracking",
      };
    if (!value.endsWith("MANAGED_BY_SELF"))
      return {
        state: "not_checkable",
        reason: `the tracking status (${value || "empty"}) is one this version cannot name`,
        category: "our_gap",
      };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "tracking.ownership_ok",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [ownership],
          facts: { tracking_ownership: value },
          population: 1,
          note: "this account owns its conversion tracking",
        }),
      ],
    };
  },
});

/**
 * MI12: Google's failure reason (OfflineUserDataJobFailureReason) in plain words.
 * Customer Match jobs almost always fail with no reason (UNSPECIFIED / UNKNOWN);
 * the named reasons are store-sales ones.
 */
const OFFLINE_FAILURE: Readonly<Record<string, string>> = {
  INSUFFICIENT_MATCHED_TRANSACTIONS: "too few of the uploaded sales matched people Google knows",
  INSUFFICIENT_TRANSACTIONS: "the upload held too few sales for Google to accept it",
  HIGH_AVERAGE_TRANSACTION_VALUE:
    "the average sale value in the upload is far higher than Google expects",
  LOW_AVERAGE_TRANSACTION_VALUE:
    "the average sale value in the upload is far lower than Google expects",
  NEWLY_OBSERVED_CURRENCY_CODE: "the upload used a currency this account has not used before",
};
const OFFLINE_NO_REASON = "Google rejected the upload and gives no reason";

/** MI12: a customer-match job whose list was deleted or that carries no list id. */
const OFFLINE_LIST_GONE = "a customer list that no longer exists";
const OFFLINE_DELETED_LIST =
  "an app is still sending uploads to a customer list that no longer exists";
/**
 * MI12: a customer-match job whose list we could not match because the
 * account's lists were not read. The list may well exist, so never say it was
 * deleted.
 */
const OFFLINE_LIST_UNREAD = "a customer list we couldn't look up";

/** MI12: the uploading app when the list name says it; null when it does not. */
function offlineUploaderOf(name: string | null): string | null {
  const n = (name ?? "").toLowerCase();
  for (const [needle, app] of [
    ["klaviyo", "Klaviyo"],
    ["shopify", "Shopify"],
    ["hubspot", "HubSpot"],
    ["mailchimp", "Mailchimp"],
    ["salesforce", "Salesforce"],
    ["omnisend", "Omnisend"],
    ["zapier", "Zapier"],
  ] as const) {
    if (n.includes(needle)) return app;
  }
  return null;
}

const isCustomerMatchJob = (type: string): boolean => type.startsWith("CUSTOMER_MATCH");

/** MI12 — the latest upload to a customer list (or the store-sales upload) failed. */
const MI12 = defineCheck({
  id: "MI12",
  claimKey: "tracking.offline_uploads_healthy",
  title: "the latest upload to a customer list or store-sales import failed",
  clientLabel: "customer list and store sales uploads that Google rejected",
  group: "measurement",
  metrics: ["A.offline_lists_failing"],
  // 2026-10-19: MI02 (conversion actions missing from the per-action tables) is
  // no confounder of a customer-list upload, and it made the card say "our sync
  // only stored data for some conversion actions".
  confounders: [],
  requires: ["offlineUserDataJobs"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "The latest upload to each customer list succeeded.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["offlineUserDataJobs"]);
    if (gate) return gate;

    const failing = ctx.get("A.offline_lists_failing");
    if (!isOk(failing))
      return {
        state: "not_checkable",
        reason: `A.offline_lists_failing is ${failing.reason}: ${failing.detail}`,
      };
    const jobs = ctx.model.attrs.offlineUserDataJobs.jobs ?? [];
    const judged = offlineUploadTargets(jobs).filter((t) => t.latestFinished != null);
    const checked = `checked the latest ${jobs.length} uploads across ${judged.length} lists`;
    const recovered = judged.filter((t) => t.recovered).length;
    const recoveredNote =
      recovered > 0
        ? `; ${recovered} list(s) had an earlier failed upload that a later one fixed`
        : "";
    const bad = judged.filter((t) => t.latestFinished?.status === "FAILED");
    if (bad.length === 0)
      return {
        state: "none_found",
        population: judged.length,
        note: `${checked}; the latest upload to each succeeded${recoveredNote}`,
        evidence: expandEvidence(failing),
      };

    const listsById = new Map(ctx.model.children.audienceLists.map((l) => [l.listId, l]));
    // a missing list only means "deleted" when the account's lists were actually read
    const listsRead = gateOnData(ctx, ["audienceLists"]) == null;
    const rows = bad.map((t) => {
      const list = t.userListId ? (listsById.get(t.userListId) ?? null) : null;
      const customerMatch = isCustomerMatchJob(t.type);
      // a customer-match job whose list was deleted (or that names no list) has no name to show
      const noList = customerMatch && list == null;
      const listGone = noList && listsRead;
      const listUnread = noList && !listsRead;
      const name =
        list?.name ??
        (listGone ? OFFLINE_LIST_GONE : listUnread ? OFFLINE_LIST_UNREAD : "store sales upload");
      const app = offlineUploaderOf(list?.name ?? null);
      const googleSays =
        OFFLINE_FAILURE[t.latestFinished?.failureReason ?? ""] ?? OFFLINE_NO_REASON;
      const says = listGone ? OFFLINE_DELETED_LIST : googleSays;
      return {
        entity: { id: t.userListId || null, name },
        cells: {
          upload: customerMatch ? "customer list" : "store sales",
          google_says: says,
          google_reason_code: t.latestFinished?.failureReason || "none given",
          failed_in_a_row: t.failedInARow,
          worked_before: t.succeededBefore ? "yes" : "no successful upload in the ones checked",
          list_size_search: list?.sizeForSearch ?? null,
          uploaded_by: app ?? "not named on the list",
        },
      };
    });
    const failingNames = Array.from(new Set(rows.map((r) => r.entity.name))).join(", ");
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: "tracking.offline_uploads_healthy",
          scope: { type: "account", id: ctx.model.id, name: ctx.model.name },
          cite: [failing],
          facts: {
            lists_failing: failingNames,
            lists_failing_count: bad.length,
            lists_checked: judged.length,
            uploads_checked: jobs.length,
            google_says: Array.from(new Set(rows.map((r) => r.cells.google_says))).join("; "),
          },
          population: judged.length,
          rows,
          note: `${checked}; the latest upload failed for ${failingNames}${recoveredNote}`,
        }),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// R4-D (Round 4 items 23, 24, 30) — expert checks on data already synced
// ---------------------------------------------------------------------------

/**
 * MI16: conversion categories that are a step on the way to a sale, or a lead,
 * never a sale. On a shop, a primary action in one of these teaches Smart
 * Bidding to buy the step instead of the order. DEFAULT ("Other") is left out on
 * purpose: shops often file their real purchase under it.
 */
const MICRO_ACTION_CATEGORIES: ReadonlySet<string> = new Set([
  "ADD_TO_CART",
  "BEGIN_CHECKOUT",
  "PAGE_VIEW",
  "ENGAGEMENT",
  "OUTBOUND_CLICK",
  "CONTACT",
  "SUBMIT_LEAD_FORM",
  "SIGNUP",
  "GET_DIRECTIONS",
  "BOOK_APPOINTMENT",
  "REQUEST_QUOTE",
  "PHONE_CALL_LEAD",
  "IMPORTED_LEAD",
  "QUALIFIED_LEAD",
  "CONVERTED_LEAD",
  "STORE_VISIT",
  "YOUTUBE_FOLLOW_ON_VIEWS",
  "ADD_PAYMENT_INFO",
]);

/** MI16: plain names for the categories, as a shop owner reads them. */
const MICRO_ACTION_LABEL: Readonly<Record<string, string>> = {
  ADD_TO_CART: "add to cart",
  BEGIN_CHECKOUT: "checkout started",
  PAGE_VIEW: "page view",
  ENGAGEMENT: "engagement",
  OUTBOUND_CLICK: "outbound click",
  CONTACT: "contact",
  SUBMIT_LEAD_FORM: "form sent",
  SIGNUP: "sign-up",
  GET_DIRECTIONS: "directions",
  BOOK_APPOINTMENT: "booking",
  REQUEST_QUOTE: "quote request",
  PHONE_CALL_LEAD: "phone call",
  IMPORTED_LEAD: "imported lead",
  QUALIFIED_LEAD: "qualified lead",
  CONVERTED_LEAD: "converted lead",
  STORE_VISIT: "store visit",
  YOUTUBE_FOLLOW_ON_VIEWS: "YouTube follow-on view",
  ADD_PAYMENT_INFO: "payment details added",
};

/**
 * Is the account-default goal for this category biddable? true / false when the
 * customer goals were synced and name the category; null when they were not.
 * An action in a category whose goal is switched off is recorded, not bid on.
 */
function categoryGoalBiddable(ctx: CheckCtx, category: string | null): boolean | null {
  const goals = ctx.model.attrs.customerConversionGoals ?? [];
  if (goals.length === 0 || !category) return null;
  const mine = goals.filter((g) => g.category.toUpperCase() === category.toUpperCase());
  if (mine.length === 0) return null;
  return mine.some((g) => g.biddable);
}

/**
 * MI16 (R4-D, Round 4 item 23) — the wrong actions counted as primary on a shop.
 *
 * MI03 catches two primary PURCHASE actions; nothing caught a primary action
 * that is not a sale at all. Two legs, both on live (not REMOVED) primary
 * actions whose goal is biddable (or unknown):
 *   - a micro-action or lead category (add to cart, checkout started, page view,
 *     contact form, phone call...) counted as primary on an e-commerce account;
 *   - a PURCHASE action with 5+ conversions and $0 value in the window, which
 *     tells value bidding those sales were worth nothing.
 * E-commerce only (the business-type gate): on a lead account a form IS the goal.
 * One finding per action, so the card names it.
 */
const MI16 = defineCheck({
  id: "MI16",
  claimKey: "tracking.micro_action_primary",
  title: "a micro-action or a $0-value purchase counts as a primary conversion",
  clientLabel:
    "steps before a sale (add to cart, checkout, page views, forms) or $0 sales counted as your main conversion",
  group: "measurement",
  judges: {
    conversionActions: "bidding",
    because:
      "only the actions the bidding reads can teach it the wrong goal; a secondary action is only recorded",
  },
  metrics: ["A.conv_actions_primary_count"],
  confounders: [],
  requires: ["conversionActions"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans:
    "Only real sales count as your main conversion; steps before a sale are recorded as secondary.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, ["conversionActions"]);
    if (gate) return gate;
    const bidding = ctx.model.children.conversionActions.filter(
      (a) => a.attrs.isPrimary && String(a.attrs.status ?? "").toUpperCase() !== "REMOVED",
    );
    if (bidding.length === 0) {
      return {
        state: "not_checkable",
        reason: "no live conversion action is marked primary",
        table: "conversionActions",
        category: "not_present",
      };
    }
    const judged = bidding.filter((a) => categoryGoalBiddable(ctx, a.attrs.category) !== false);
    const primaryPurchases = judged.filter(
      (a) => String(a.attrs.category ?? "").toUpperCase() === "PURCHASE",
    );
    const findings: CheckFinding[] = [];
    for (const a of judged) {
      const category = String(a.attrs.category ?? "").toUpperCase();
      const conv = a.attrs.totalConversions ?? 0;
      const value = a.attrs.totalValue;
      const micro = MICRO_ACTION_CATEGORIES.has(category);
      const zeroValue =
        category === "PURCHASE" &&
        conv >= ctx.settings.measurement.zeroValuePurchaseMinConv &&
        value != null &&
        value <= 0;
      if (!micro && !zeroValue) continue;
      const f = finding({
        claimKey: this.claimKey,
        scope: { type: "conversion_action", id: a.id, name: a.name },
        entity: { id: a.id, name: a.name },
        cite: [ctx.get("A.conv_actions_primary_count")],
        facts: {
          leg: micro ? "micro_action" : "zero_value_purchase",
          action_category: micro
            ? (MICRO_ACTION_LABEL[category] ?? category.toLowerCase().replace(/_/g, " "))
            : "purchase",
          action_conversions_90d: Number(conv.toFixed(2)),
          action_value_90d: value == null ? null : Number(value.toFixed(2)),
          primary_purchase_actions: primaryPurchases.length,
          share_of_spend_affected: ALL_SPEND,
        },
        // one-click gaps phase 4: the leg and the purchase count as data the rendered finding
        // keeps (string facts are not rendered, small numbers are deduped), so the
        // "make it secondary" change is built from these cells, never from wording
        rows: [
          {
            entity: { id: a.id, name: a.name },
            cells: {
              counted_as: micro ? "step before a sale" : "purchase at $0",
              other_primary_purchase_actions: String(
                primaryPurchases.filter((p) => p.id !== a.id).length,
              ),
            },
          },
        ],
        population: judged.length,
        note: micro
          ? `primary ${category} action on an e-commerce account (${primaryPurchases.length} primary purchase action(s) beside it)`
          : `primary purchase action: ${conv.toFixed(2)} conversions and $0 value in the window`,
      });
      // a shop's sales at $0 = broken sales tracking: no campaign's return can be judged (critical, 2026-10-17); a step before the sale stays a warning
      if (micro) f.maxSeverity = "warning";
      findings.push(f);
    }
    if (findings.length > 0) return { state: "fires", findings };
    const secondaryOnly = bidding.length - judged.length;
    return {
      state: "none_found",
      population: judged.length,
      note: `${judged.length} primary action(s) judged, none a step before the sale or a $0 purchase${secondaryOnly > 0 ? `; ${secondaryOnly} primary action(s) sit in a goal that is not used for bidding` : ""}`,
    };
  },
});

/** MI18: strategies that learn from conversions (a data exclusion only matters to these). */
const SMART_BIDDING = new Set([
  "MAXIMIZE_CONVERSIONS",
  "MAXIMIZE_CONVERSION_VALUE",
  "TARGET_CPA",
  "TARGET_ROAS",
]);

/** one day each from start to end inclusive (ISO days) */
function daysFrom(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addIsoDay(d, 1)) out.push(d);
  return out;
}
function addIsoDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * MI18 (R4-D, Round 4 item 30) — a tracking outage the bidding learned from.
 *
 * MI01 catches a primary action that is silent up to the last settled day (not
 * recovered). This is the other half: a run of zero-sale days INSIDE the window
 * that recovered afterwards, on an action whose previous 28 days were steady
 * enough that the run cannot be chance (the steady rate × the run's length ≥ 6
 * expected sales). Smart Bidding learned from those "no sale" days unless a data
 * exclusion covered them, so the check asks whether one did. Only judged when a
 * live campaign uses Smart Bidding; runs that reach into the last 7 days are left
 * to MI01 (late conversions are still arriving).
 * R4-D review: a run where the Smart Bidding campaigns' own clicks fall under half
 * of the days before (paused ads, a stock-out, a weekday-only schedule) is skipped;
 * only an account-wide exclusion counts as covering it (a campaign / channel one is
 * a limit line — the sync does not say which campaigns it names).
 */
const MI18 = defineCheck({
  id: "MI18",
  claimKey: "tracking.outage_without_data_exclusion",
  title: "days of zero conversions after steady volume, with no data exclusion covering them",
  clientLabel:
    "tracking breaks that Smart Bidding learned from because no data exclusion covered them",
  group: "measurement",
  judges: {
    conversionActions: "bidding",
    because: "only a primary action's gap changes what the bidding learns",
  },
  metrics: ["CA.conv_window(action)", "W.last_settled_day"],
  confounders: [],
  requires: [CA_DAILY],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No tracking break in the window that Smart Bidding could have learned from.",
  run(ctx: CheckCtx): CheckResult {
    const gate = gateOnData(ctx, [CA_DAILY]);
    if (gate) return gate;
    const smart = campaignsOf(ctx).filter((c) =>
      SMART_BIDDING.has(String(c.attrs.strategy ?? "").toUpperCase()),
    );
    if (smart.length === 0)
      return {
        state: "none_found",
        population: 0,
        note: "no live campaign uses Smart Bidding, so a gap in tracking teaches no bidding anything",
      };
    const start = ctx.window.start;
    const practical = ctx.window.lastSettledDayPractical ?? ctx.window.end;
    if (!start || !practical || practical <= start)
      return { state: "insufficient_data", reason: "the period read has no start or settled end" };
    const live = ctx.model.children.conversionActions.filter(
      (a) => a.attrs.isPrimary && String(a.attrs.status ?? "").toUpperCase() === "ENABLED",
    );
    if (live.length === 0)
      return {
        state: "not_checkable",
        reason: "no primary conversion action with an ENABLED status",
        table: "conversionActions",
        category: "not_present",
      };

    const exclusionsReadable = gateOnData(ctx, ["biddingOverrides"]) == null;
    const exclusions = (ctx.model.attrs.biddingDataExclusions ?? []).filter(
      (e) => e.start && String(e.status ?? "ENABLED").toUpperCase() !== "REMOVED",
    );
    const spans = (e: (typeof exclusions)[number], first: string, last: string) =>
      e.start! <= first && (e.end ?? e.start!) >= last;
    // R4-D review: only an account-wide exclusion (scope CUSTOMER, or none recorded) is known to cover every
    // Smart Bidding campaign; a CAMPAIGN / CHANNEL one names campaigns or channels the sync does not carry
    const accountWide = (e: (typeof exclusions)[number]) =>
      ["", "CUSTOMER", "UNSPECIFIED"].includes(String(e.scope ?? "").toUpperCase());
    const covered = (first: string, last: string) =>
      exclusions.some((e) => accountWide(e) && spans(e, first, last));
    const partlyCovered = (first: string, last: string) =>
      exclusions.some((e) => !accountWide(e) && spans(e, first, last));

    // R4-D review: the Smart Bidding campaigns' own clicks per day. A zero-sale run with little or no
    // traffic is paused ads, a stock-out or a weekday-only schedule, not a tracking break.
    const withTraffic = smart.filter(
      (c) => c.attrs.dailyTraffic != null && c.attrs.dailyTraffic.length > 0,
    );
    const clicksByDay = new Map<string, number>();
    for (const c of withTraffic)
      for (const d of c.attrs.dailyTraffic!)
        clicksByDay.set(d.date, (clicksByDay.get(d.date) ?? 0) + d.clicks);
    const avgClicks = (ds: readonly string[]) =>
      ds.length ? ds.reduce((t, d) => t + (clicksByDay.get(d) ?? 0), 0) / ds.length : 0;
    let quietRuns = 0;

    const {
      outageMinExpectedConv: OUTAGE_MIN_EXPECTED_CONV,
      outageMinTrafficShare: OUTAGE_MIN_TRAFFIC_SHARE,
      outageBaselineDays: OUTAGE_BASELINE_DAYS,
      outageMinBaselineDays: OUTAGE_MIN_BASELINE_DAYS,
    } = ctx.settings.measurement;
    const days = daysFrom(start, practical);
    const findings: CheckFinding[] = [];
    let judged = 0;
    for (const a of live) {
      if (a.attrs.daily == null || a.attrs.daily.length === 0) continue;
      judged++;
      const byDay = new Map(a.attrs.daily.map((d) => [d.date, d.conv] as const));
      const series = days.map((d) => ({ date: d, conv: byDay.get(d) ?? 0 }));
      for (let i = 0; i < series.length; i++) {
        if (series[i]!.conv > 0) continue;
        let j = i;
        while (j + 1 < series.length && series[j + 1]!.conv <= 0) j++;
        const recovered = j + 1 < series.length; // a sale after the run; a run to the end is MI01's
        const baseline = series.slice(Math.max(0, i - OUTAGE_BASELINE_DAYS), i);
        const runLen = j - i + 1;
        const rate =
          baseline.length > 0 ? baseline.reduce((t, x) => t + x.conv, 0) / baseline.length : 0;
        const expected = rate * runLen;
        if (
          recovered &&
          baseline.length >= OUTAGE_MIN_BASELINE_DAYS &&
          expected >= OUTAGE_MIN_EXPECTED_CONV
        ) {
          const first = series[i]!.date;
          const last = series[j]!.date;
          const runDays = series.slice(i, j + 1).map((x) => x.date);
          const baseClicks = avgClicks(baseline.map((x) => x.date));
          const runClicks = avgClicks(runDays);
          const quiet =
            withTraffic.length > 0 &&
            (runClicks < 1 || runClicks < OUTAGE_MIN_TRAFFIC_SHARE * baseClicks);
          if (quiet) quietRuns++;
          const isCovered = covered(first, last);
          if (!isCovered && !quiet) {
            findings.push(
              finding({
                claimKey: this.claimKey,
                scope: { type: "conversion_action", id: a.id, name: a.name },
                entity: { id: a.id, name: a.name },
                cite: [ctx.get("CA.conv_window(action)", { actionId: a.id })],
                facts: {
                  outage_first_day: first,
                  outage_last_day: last,
                  outage_days: runLen,
                  steady_sales_per_day_before: Number(rate.toFixed(1)),
                  expected_sales_in_gap: Number(expected.toFixed(0)),
                  smart_bidding_campaigns: smart.length,
                  data_exclusions_read: exclusionsReadable ? exclusions.length : null,
                  ...(withTraffic.length > 0
                    ? {
                        smart_bidding_clicks_per_day_in_gap: Number(runClicks.toFixed(0)),
                        smart_bidding_clicks_per_day_before: Number(baseClicks.toFixed(0)),
                      }
                    : {}),
                },
                population: live.length,
                rows: smart.slice(0, 10).map((c) => ({
                  entity: { id: c.id, name: c.name },
                  cells: {
                    bid_strategy: String(c.attrs.strategy ?? "")
                      .toLowerCase()
                      .replace(/_/g, " "),
                  },
                })),
                note: `${runLen} day(s) with no ${a.name} conversions (${first} to ${last}) after ${rate.toFixed(1)} a day over the ${baseline.length} days before`,
              }),
            );
            const limits: string[] = [];
            if (!exclusionsReadable)
              limits.push(
                "We could not read your data exclusions, so one may already cover these days.",
              );
            else if (partlyCovered(first, last))
              limits.push(
                "A data exclusion limited to some campaigns or channels covers these days, and we could not read which ones it applies to.",
              );
            if (withTraffic.length === 0)
              limits.push(
                "We could not read the campaigns' daily clicks, so we could not rule out that the ads simply were not running on these days.",
              );
            if (limits.length) findings[findings.length - 1]!.limitedBy = limits;
          }
        }
        i = j;
      }
    }
    if (judged === 0)
      return {
        state: "not_checkable",
        reason: `${CA_DAILY} carries no day for any enabled primary action`,
        table: CA_DAILY,
        category: "our_gap",
      };
    if (findings.length > 0) return { state: "fires", findings };
    return {
      state: "none_found",
      population: judged,
      note: `no recovered zero-sale run on ${judged} primary action(s) that steady volume makes unlikely by chance${quietRuns ? ` (${quietRuns} zero-sale run(s) skipped: the Smart Bidding campaigns had little or no traffic then)` : ""}${exclusions.length ? ` (${exclusions.length} data exclusion(s) on the account)` : ""}`,
    };
  },
});

export const MEASUREMENT_CHECKS: CheckDefinition[] = [
  MI01,
  MI03,
  MI04,
  MI05,
  MI06,
  MI07,
  MI08,
  MI09,
  MI10,
  MI11,
  MI12,
  MI14,
  MI16,
  MI18,
];
