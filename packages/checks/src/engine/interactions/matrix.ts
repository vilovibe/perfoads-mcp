// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The interaction matrix — one entry per confounder relationship.
 *
 * Sources, both binding:
 *  - build sheet §B: every check row's `confounders` column, each naming
 *    another check id (MI01, SK06, PX02, …);
 *  - spec §8.3's influence table ("when judging Y, X must be resolved first"),
 *    which adds the relationships §B leaves implicit — slice scope pairing,
 *    sample floors, extension serving rules, the unresolvable match type.
 *    Those carry `X_*` ids because they are rules, not checks.
 *
 * A resolver is a small pure function over (model, metrics, scope,
 * thresholds). It answers one question and returns its evidence. It never
 * decides severity, never writes, never reads the DB, and never imports the
 * metric registry — metrics arrive by string id through MetricLookup.
 *
 * Some relationships need the same X answered the other way round (BB02 for a
 * waste check means "budget is the cap"; for a scale check the interesting
 * answer is "budget is NOT the cap"). Those get a resolver key `ID@variant`;
 * the confounder id stays `ID`.
 */
import { ESSENTIAL_ROLE_LABELS, type EssentialRole } from "../shared/audienceRoles.js";
import { SEASONAL_MIN_CONV, seasonalityOf } from "../model/buildBuyersAndLanguages.js";
import type { AdGroupNode } from "../model/nodes/AdGroupNode.js";
import type { AdNode } from "../model/nodes/AdNode.js";
import type { AssetGroupNode } from "../model/nodes/AssetGroupNode.js";
import { assetsUnknownReason, signalsUnknownReason } from "../model/nodes/AssetGroupNode.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import { brandListNamesFor, brandListStateOf } from "../model/buildPmaxTree.js";
import type { ConversionActionNode } from "../model/nodes/ConversionActionNode.js";
import type { ExtensionNode } from "../model/nodes/ExtensionNode.js";
import type { KeywordNode } from "../model/nodes/KeywordNode.js";
import type { LandingPageNode } from "../model/nodes/LandingPageNode.js";
import type { ProductNode } from "../model/nodes/ProductNode.js";
import type { SearchTermNode } from "../model/nodes/SearchTermNode.js";
import { deadHourSlots } from "../model/buildSlices.js";
import { sliceKeysOf } from "../model/nodes/Slice.js";
import type { Slice, SliceDimension } from "../model/nodes/Slice.js";
import type { NodeMetrics, NodeWindows } from "../model/types.js";
import { actionSettledDay } from "../model/windows.js";
import { liveAssetGroupsOf, statusOf } from "../registry/entityStatus.js";
import { doubleCountOf } from "../shared/doubleCount.js";
import { duplicateCopiesOf } from "../shared/keywordOverlap.js";

import {
  isComputable,
  type Confounder,
  type ConfounderContext,
  type ConfounderEffect,
  type ConfounderResult,
  type EvidenceRef,
  type NodeRef,
} from "./types.js";

// ---------------------------------------------------------------------------
// result + evidence helpers
// ---------------------------------------------------------------------------

const ev = (kind: EvidenceRef["kind"], id: string, detail?: string): EvidenceRef =>
  detail == null ? { kind, id } : { kind, id, detail };

const cleared = (note: string, evidence: EvidenceRef[] = []): ConfounderResult => ({
  state: "cleared",
  note,
  evidence,
});
const unknown = (note: string, evidence: EvidenceRef[] = []): ConfounderResult => ({
  state: "unknown",
  note,
  evidence,
});
const explains = (
  note: string,
  evidence: EvidenceRef[] = [],
  effect?: ConfounderEffect,
): ConfounderResult =>
  effect == null
    ? { state: "explains", note, evidence }
    : { state: "explains", note, evidence, effect };

/**
 * A standing, account-wide condition (value rules on, mixed attribution, goal
 * overrides, an unsettled window) is a CAVEAT, not an alternative cause: it
 * must be printed beside the number (handover rule 6 / §8.4 rule 2), and it
 * caps confidence at MODERATE — it never deletes or rewrites the finding.
 * `explains` stays reserved for "this specific signal has a specific cause".
 */
const caveat = (note: string, evidence: EvidenceRef[] = []): ConfounderResult => ({
  state: "cleared",
  note,
  evidence,
  capsConfidence: "MODERATE",
});

/**
 * Impression-share fields on the model are Google's fractions (0.2 = 20%);
 * the thresholds and the sentences are in percent. One conversion, here.
 */
const isPct = (v: number | null | undefined): number | null => (v == null ? null : v * 100);
const n2 = (v: number | null | undefined, digits = 2): string =>
  v == null ? "null" : v.toFixed(digits);
const pct = (v: number | null | undefined): string =>
  v == null ? "null" : `${(v * 100).toFixed(2)}%`;

/**
 * The window the claim is made over. A resolver must judge the same window as
 * the check, never silently fall back to 90 days; when the node carries no
 * series for that window the fallback is stated and confidence is capped.
 */
export interface ScopedWindow {
  m: NodeMetrics;
  label: string;
  substituted: boolean;
}

export function scopedWindow(ctx: ConfounderContext, node: { windows: NodeWindows }): ScopedWindow {
  const label = ctx.scope.window ?? "m90";
  if (label === "m90") return { m: node.windows.m90, label, substituted: false };
  const w = (node.windows as unknown as Record<string, NodeMetrics | null>)[label] ?? null;
  return w
    ? { m: w, label, substituted: false }
    : { m: node.windows.m90, label: "m90", substituted: true };
}

/** A metric read through the lookup; null when the registry cannot compute it. */
function metricNum(ctx: ConfounderContext, id: string, scope?: NodeRef): number | null {
  const v = ctx.metrics.get(id, scope ?? ctx.scope);
  if (!isComputable(v)) return null;
  return typeof v.value === "number" && Number.isFinite(v.value) ? v.value : null;
}

const wasteFloor = (ctx: ConfounderContext): number =>
  metricNum(ctx, "T.waste_floor") ?? ctx.thresholds.wasteFloor;
const convFloor = (ctx: ConfounderContext): number =>
  metricNum(ctx, "F.conv_min_for_verdict") ?? ctx.thresholds.convMinForVerdict;

// ---------------------------------------------------------------------------
// locating the entity the check is about
// ---------------------------------------------------------------------------

export interface Located {
  campaign: CampaignNode | null;
  adGroup: AdGroupNode | null;
  keyword: KeywordNode | null;
  searchTerm: SearchTermNode | null;
  ad: AdNode | null;
  extension: ExtensionNode | null;
  assetGroup: AssetGroupNode | null;
  product: ProductNode | null;
  landingPage: LandingPageNode | null;
  action: ConversionActionNode | null;
  slice: Slice | null;
}

const EMPTY: Located = {
  campaign: null,
  adGroup: null,
  keyword: null,
  searchTerm: null,
  ad: null,
  extension: null,
  assetGroup: null,
  product: null,
  landingPage: null,
  action: null,
  slice: null,
};

/** slice node ids are `${scope}:${campaignId ?? 'account'}:${dimension}:${key}`. */
function parseSliceId(
  id: string,
): { scope: string; campaignId: string | null; dimension: string; key: string } | null {
  const p = id.split(":");
  if (p.length < 4) return null;
  return {
    scope: p[0] ?? "",
    campaignId: p[1] === "account" ? null : (p[1] ?? null),
    dimension: p[2] ?? "",
    key: p.slice(3).join(":"),
  };
}

export function locate(ctx: ConfounderContext): Located {
  const { model, scope } = ctx;
  const out: Located = { ...EMPTY };
  const id = scope.id ?? null;

  let campaignId = scope.campaignId ?? null;
  if (campaignId == null && scope.kind === "campaign" && id) campaignId = id;
  if (campaignId == null && scope.kind === "slice" && id)
    campaignId = parseSliceId(id)?.campaignId ?? null;
  if (campaignId != null) out.campaign = model.index.campaignsById.get(campaignId) ?? null;

  if (scope.kind === "conversionAction") {
    out.action =
      model.children.conversionActions.find(
        (a) => a.id === id || a.attrs.actionId === id || a.name === id,
      ) ?? null;
  }
  if (scope.kind === "product" && id) {
    out.product =
      model.index.productsById.get(id.toLowerCase()) ??
      model.children.products.find((p) => p.id === id) ??
      null;
  }
  if (scope.kind === "landingPage" && id) {
    out.landingPage =
      model.children.landingPages.find((l) => l.id === id || l.attrs.urlKey === id) ?? null;
  }
  if (scope.kind === "slice" && id) out.slice = findSlice(ctx);

  // walk the campaigns for the sub-entities; the trees are small.
  const campaigns = out.campaign ? [out.campaign] : model.children.campaigns;
  for (const c of campaigns) {
    if (scope.kind === "assetGroup" && id) {
      const ag = c.children.assetGroups.find((g) => g.id === id);
      if (ag) {
        out.assetGroup = ag;
        out.campaign ??= c;
      }
    }
    if (scope.kind === "extension" && id) {
      const x =
        c.children.extensions.find((e) => e.id === id) ??
        c.children.adGroups.flatMap((g) => g.children.extensions).find((e) => e.id === id);
      if (x) {
        out.extension = x;
        out.campaign ??= c;
      }
    }
    if (scope.kind === "searchTerm" && id) {
      const t =
        c.children.searchTerms.find((s) => s.id === id) ??
        c.children.adGroups.flatMap((g) => g.children.searchTerms).find((s) => s.id === id);
      if (t) {
        out.searchTerm = t;
        out.campaign ??= c;
      }
    }
    for (const g of c.children.adGroups) {
      if (scope.kind === "adGroup" && g.id === id) {
        out.adGroup = g;
        out.campaign ??= c;
      }
      if (scope.adGroupId && g.id === scope.adGroupId) {
        out.adGroup = g;
        out.campaign ??= c;
      }
      if (scope.kind === "keyword" && id) {
        const k = g.children.keywords.find((x) => x.id === id);
        if (k) {
          out.keyword = k;
          out.adGroup = g;
          out.campaign ??= c;
        }
      }
      if (scope.kind === "ad" && id) {
        const a = g.children.ads.find((x) => x.id === id);
        if (a) {
          out.ad = a;
          out.adGroup = g;
          out.campaign ??= c;
        }
      }
    }
  }
  if (out.extension == null && scope.kind === "extension" && id) {
    out.extension = model.children.extensions.find((e) => e.id === id) ?? null;
  }
  return out;
}

/**
 * Every slice the scope names. A slice scope may name a SET of keys joined by
 * SLICE_KEY_SEPARATOR (SL06 judges a campaign's zero-conversion device slices as
 * one exclusion decision); a single key is a set of one, so nothing below changes
 * for the other slice checks.
 */
function findSlices(ctx: ConfounderContext): Slice[] {
  const { model, scope } = ctx;
  const parsed = scope.id ? parseSliceId(scope.id) : null;
  const dim = (scope.dimension ?? parsed?.dimension) as SliceDimension | undefined;
  const key = scope.key ?? parsed?.key;
  if (!dim || key == null) return [];
  const campaignId = scope.campaignId ?? parsed?.campaignId ?? null;
  const families = campaignId
    ? model.index.campaignsById.get(campaignId)?.children.slices
    : model.children.slices;
  const family = families?.[dim];
  if (!family) return [];
  return sliceKeysOf(key)
    .map((k) => family.find((s) => s.attrs.key === k))
    .filter((s): s is Slice => s != null);
}

function findSlice(ctx: ConfounderContext): Slice | null {
  return findSlices(ctx)[0] ?? null;
}

/** Every slice of the same dimension + key at campaign scope. */
function campaignSlices(
  ctx: ConfounderContext,
  dim: SliceDimension,
  key: string,
): { campaign: CampaignNode; slice: Slice }[] {
  const out: { campaign: CampaignNode; slice: Slice }[] = [];
  for (const c of ctx.model.children.campaigns) {
    const s = c.children.slices[dim]?.find((x) => x.attrs.key === key);
    if (s) out.push({ campaign: c, slice: s });
  }
  return out;
}

const sliceClickFloor = (ctx: ConfounderContext, dim: SliceDimension | undefined): number =>
  dim === "device" ? ctx.thresholds.deviceMinClicks : ctx.thresholds.sliceMinClicks;

/** sync marker state for an AccountData key (rule 5: zero rows with no marker is never "none found"). */
function tableState(ctx: ConfounderContext, key: string): { rows: number; checkable: string } {
  const t = ctx.model.dataQuality.tables[key];
  return { rows: t?.rows ?? 0, checkable: t?.checkable ?? "unknown" };
}

const PURCHASE_CATEGORIES = new Set([
  "PURCHASE",
  "PURCHASE_ONLINE",
  "CONVERTED_LEAD",
  "QUALIFIED_LEAD",
  "SUBMIT_LEAD_FORM",
  "SIGNUP",
]);

// ---------------------------------------------------------------------------
// resolvers — one question each
// ---------------------------------------------------------------------------

interface ResolverDef {
  question: string;
  onExplains: ConfounderEffect;
  resolve(ctx: ConfounderContext): ConfounderResult;
}

const R: Record<string, ResolverDef> = {
  // --- B.1 measurement integrity -------------------------------------------

  MI01: {
    question:
      "Is the primary conversion action firing on every settled day, so the performance numbers mean anything?",
    onExplains: "transform",
    resolve: (ctx) => {
      const primaries = ctx.model.children.conversionActions.filter((a) => a.attrs.isPrimary);
      if (primaries.length === 0) {
        return unknown(
          "No conversion action is marked primary — tracking health cannot be judged.",
          [ev("table", "conversionActions")],
        );
      }
      // Phase F: judged the way the MI01 check judges it, so the confounder never says
      // "tracking is broken" beside a clean MI01. Only ENABLED primaries (none switched
      // on = every primary, as before). An action that counted 0 in the Conversions
      // column is dropped only when another primary DID count (its silence cannot move
      // a conversion number), or when it fires only in all conversions (YouTube
      // follow-on views on a live shop). A purchase tag dead all window is never dropped.
      const enabled = primaries.filter((a) => statusOf(a) === "ENABLED");
      const pool = enabled.length > 0 ? enabled : primaries;
      const countedAny = (a: ConversionActionNode) => (a.attrs.totalConversions ?? 1) !== 0;
      const allOnly = (a: ConversionActionNode) =>
        !countedAny(a) && (a.attrs.daily ?? []).some((d) => (d.all ?? 0) > 0);
      const counted = pool.filter(countedAny);
      const counting = counted.length > 0 ? counted : pool.filter((a) => !allOnly(a));
      if (counting.length === 0) {
        return cleared(
          `Every switched-on primary action (${pool.map((a) => `"${a.name}"`).join(", ")}) counted 0 in the Conversions column and fires only in all conversions, so its silence cannot move a conversion number.`,
          [ev("table", "conversionActions"), ev("table", "conversion_action_daily")],
        );
      }
      if (counted.length === 0) {
        // no primary counted anything: one with a loaded daily series and no firing day
        // is silent for the whole window (the MI01 check calls that "cannot be called clean")
        const dead = counting.find(
          (a) =>
            a.attrs.daily != null && !a.attrs.daily.some((d) => d.conv > 0 || (d.all ?? 0) > 0),
        );
        if (dead)
          return unknown(
            `Primary action "${dead.name}" is switched on but recorded no conversion on any day of the window, and no other primary counted one — tracking cannot be called clean.`,
            [ev("node", dead.id, dead.name), ev("table", "conversion_action_daily")],
          );
      }
      // every counting primary is evaluated; the worst one governs (a second silent
      // primary must not hide behind the first).
      // Round 4 item 7: the metric id carries its argument list — 'CA.silent_days' alone never
      // resolved, so every audit fell to the proxy below and said the table was not synced.
      const scored = counting.map((a) => {
        const ref: NodeRef = { kind: "conversionAction", id: a.id };
        const silent = metricNum(ctx, "CA.silent_days(action)", ref);
        // the check's own bar: max(min days, 2 x median gap, longest gap capped); no rhythm = min days
        const cadence = ctx.metrics.get("CA.fire_cadence(action)", ref);
        const c = isComputable(cadence)
          ? (cadence.value as { median_gap?: number; max_gap?: number } | null)
          : null;
        const bar = Math.max(
          ctx.thresholds.silenceMinDays,
          2 * (c?.median_gap ?? 0),
          Math.min(c?.max_gap ?? 0, ctx.thresholds.silenceMaxGapDays),
        );
        return { a, silent, bar, rhythm: c != null };
      });
      // Round 4 re-check: judged as the MI01 check judges it. Silent 2+ days with fewer than
      // two firing days up to its settled day = no rhythm, and the check does not run on it
      // ("no rhythm to judge silence against"); the confounder says unknown, never explains.
      const noRhythm = scored.find((x) => !x.rhythm && x.silent != null && x.silent >= 2);
      if (noRhythm)
        return unknown(
          `Primary action "${noRhythm.a.name}" has fewer than two firing days up to its last settled day, so there is no rhythm to judge its silence against; tracking is neither cleared nor called broken.`,
          [
            ev("metric", "CA.fire_cadence", noRhythm.a.name),
            ev("table", "conversion_action_daily"),
          ],
        );
      const measured = scored.filter((x) => x.silent != null);
      // Round 4 follow-up: the account first spent after the last settled day, so no day
      // with spend has settled and MI01 does not judge. That is a standing condition of a
      // new account, not a doubt about this signal: a caveat beside the number (caps
      // confidence), never `unknown`, which would downgrade every finding it guards.
      if (measured.length === 0) {
        const pending = counting.find((a) => {
          const v = ctx.metrics.get("CA.silent_days(action)", {
            kind: "conversionAction",
            id: a.id,
          });
          return !isComputable(v) && v.code === "no_settled_spend_day";
        });
        if (pending)
          return caveat(
            `No day with spend has settled yet for primary action "${pending.name}" (last settled day ${actionSettledDay(ctx.model.window, pending)}), so its silence is not judged; the conversion numbers are read as reported.`,
            [ev("metric", "CA.silent_days", pending.name), ev("table", "dailyMetrics")],
          );
      }
      const worst = (
        measured.length > 0
          ? measured.sort(
              (x, y) => (y.silent as number) - y.bar - ((x.silent as number) - x.bar),
            )[0]!
          : scored.sort(
              (x, y) => (x.a.attrs.totalConversions ?? 0) - (y.a.attrs.totalConversions ?? 0),
            )[0]!
      ).a;
      const silent = measured.length > 0 ? measured[0]!.silent : null;
      const bar = measured.length > 0 ? measured[0]!.bar : null;
      if (silent != null && bar != null) {
        if (silent <= bar)
          return cleared(
            measured[0]!.rhythm
              ? `All ${counting.length} counting primary action(s) fired within their own rhythm (worst: "${worst.name}", silent ${silent} days against a bar of ${bar}).`
              : `No counting primary action was silent on a settled day with spend (worst: "${worst.name}", silent ${silent} days; silence is counted from the account's first day with spend).`,
            [
              ev("metric", "CA.silent_days", worst.name),
              ev("metric", "CA.fire_cadence", worst.name),
            ],
          );
        // account-wide on purpose: the campaigns the worst action counted for are not
        // all the campaigns a silent primary touches (a second action past its bar, a
        // campaign launched after the tag went quiet, per-campaign conversion goals)
        return explains(
          `Primary action "${worst.name}" was silent ${silent} consecutive days to its last settled day (${actionSettledDay(ctx.model.window, worst)}), past its own bar of ${bar}; the conversion numbers it feeds are judged on unverified data.`,
          [ev("metric", "CA.silent_days", worst.name), ev("table", "conversion_action_daily")],
        );
      }
      // conversion_action_daily is not synced on this audit (§B MI01 "pending
      // first live sync"): fall back to the account daily series as a proxy.
      // It CLEARS, so nothing is dropped on a data gap — but it caps confidence
      // at MODERATE, because a proxy is not per-action proof and a finding may
      // never be stated as fact on it. Self-heals on the next real sync: the
      // table is optional, and an older sync simply predates it.
      const settled = ctx.model.windows.settledWeek?.conv ?? null;
      const recent = ctx.model.windows.m7?.conv ?? null;
      // the table can be loaded and still hold no row for the primary action — say which
      const dailyLoaded = ctx.model.children.conversionActions.some(
        (a) => a.attrs.daily != null && a.attrs.daily.length > 0,
      );
      const gapLine = dailyLoaded
        ? "The per-action daily rows hold no day for the primary action(s)"
        : "Per-action daily rows are not synced";
      if ((settled ?? 0) > 0 && (recent ?? 0) > 0) {
        return {
          ...cleared(
            `${gapLine}; the account daily series carries ${n2(settled)} conversions on the settled week and ${n2(recent)} in the last 7 days, and the primary action "${worst.name}" totals ${n2(worst.attrs.totalConversions)} in the window. Proxy, not per-action proof — confidence is capped at MODERATE until conversion_action_daily has rows.`,
            [ev("table", "dailyMetrics"), ev("node", worst.id, worst.name)],
          ),
          capsConfidence: "MODERATE",
        };
      }
      return unknown(
        "conversion_action_daily is not synced and the account daily series shows no settled conversions — tracking health cannot be confirmed.",
        [ev("table", "conversion_action_daily"), ev("table", "dailyMetrics")],
      );
    },
  },

  MI02: {
    question:
      "Is this number about a non-primary action, or an action the input holds no rows for?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { action } = locate(ctx);
      if (action) {
        if (!action.attrs.isPrimary) {
          // binding rule 11 — a non-primary action reading 0 is never a tracking finding.
          return {
            ...explains(
              `"${action.name}" is a secondary conversion action (isPrimary=false); a zero here is never evidence of a tracking defect.`,
              [ev("node", action.id, action.name), ev("table", "conversionActions")],
            ),
            effect: "drop",
          };
        }
        return cleared(`"${action.name}" is the primary action.`, [
          ev("node", action.id, action.name),
        ]);
      }
      const actions = ctx.model.children.conversionActions;
      if (actions.length === 0)
        return unknown("No conversion actions synced.", [ev("table", "conversionActions")]);
      const withData = actions.filter((a) => a.attrs.hasAnyData).length;
      if (withData < actions.length) {
        return explains(
          `The sync stored data for ${withData} of ${actions.length} conversion actions (A.per_action_coverage = ${(withData / actions.length).toFixed(2)}); the zeros on the other ${actions.length - withData} are an engine gap, not a client tracking defect.`,
          [ev("metric", "A.per_action_coverage"), ev("table", "conversionActions")],
        );
      }
      return cleared(`All ${actions.length} conversion actions report data.`, [
        ev("metric", "A.per_action_coverage"),
      ]);
    },
  },

  MI03: {
    question:
      "Is more than one purchase action counting toward the primary goal (double counting)?",
    onExplains: "transform",
    resolve: (ctx) => {
      const actions = ctx.model.children.conversionActions;
      if (actions.length === 0)
        return unknown("No conversion actions synced.", [ev("table", "conversionActions")]);
      const purchase = actions.filter((a) =>
        PURCHASE_CATEGORIES.has(String(a.attrs.category ?? "")),
      );
      // MI03's own rule, so a clean MI03 never sits next to "may be counted twice"
      const double = doubleCountOf(purchase.filter((a) => a.attrs.isPrimary));
      if (double.state === "unknown")
        return unknown(`${double.reason}.`, [ev("table", "conversionActions")]);
      return double.state === "fires"
        ? explains(
            `${double.actions.length} enabled primary actions of one kind recorded conversions — conversions and value may be counted twice.`,
            [ev("table", "conversionActions")],
          )
        : cleared(
            `${purchase.length} purchase actions exist, ${double.live} enabled one(s) primary — no double counting.`,
            [ev("metric", "A.purchase_action_count")],
          );
    },
  },

  MI04: {
    question: "Are conversion value rules rewriting the value side of every ROAS?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { total, enabled } = ctx.model.attrs.conversionValueRules;
      if (total === 0 && tableState(ctx, "conversionValueRules").checkable === "unknown") {
        return unknown(
          "conversion_value_rules has no rows and no sync marker — value adjustments cannot be ruled out.",
          [ev("table", "conversionValueRules")],
        );
      }
      return enabled > 0
        ? caveat(
            `${enabled} conversion value rules are ENABLED — reported value is adjusted, so every ROAS in this finding must say so. A standing account setting caveats the number; it does not explain this particular signal.`,
            [ev("metric", "A.value_rules_enabled_count"), ev("table", "conversionValueRules")],
          )
        : cleared("No conversion value rule is rewriting reported value.", [
            ev("metric", "A.value_rules_enabled_count"),
          ]);
    },
  },

  MI05: {
    question:
      "Do the conversion actions share one attribution model, and did the model change inside the window?",
    onExplains: "transform",
    resolve: (ctx) => {
      const actions = ctx.model.children.conversionActions;
      if (actions.length === 0)
        return unknown("No conversion actions synced.", [ev("table", "conversionActions")]);
      const models = new Map<string, number>();
      let unnamed = 0;
      for (const a of actions) {
        const m = a.attrs.attributionModel;
        if (m == null || m === "UNKNOWN") {
          unnamed += 1;
          continue;
        }
        models.set(m, (models.get(m) ?? 0) + 1);
      }
      const suffix =
        unnamed > 0
          ? ` ${unnamed} row(s) report UNKNOWN — that is the API version the reader asked for, a reader artefact, never an account defect.`
          : "";
      if (models.size > 1) {
        const list = [...models.entries()].map(([m, c]) => `${m} ×${c}`).join(", ");
        return caveat(
          `Conversions are attributed by ${models.size} different models (${list}); numbers from different actions are not comparable and the finding must say so.${suffix}`,
          [ev("metric", "A.attribution_model_mix"), ev("table", "conversionActions")],
        );
      }
      if (models.size === 0)
        return unknown(`No conversion action names its attribution model.${suffix}`, [
          ev("table", "conversionActions"),
        ]);
      return cleared(
        `All actions share one attribution model (${[...models.keys()][0]}).${suffix}`,
        [ev("metric", "A.attribution_model_mix")],
      );
    },
  },

  MI06: {
    question: "Are view-through conversions inflating this campaign's conversions?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the view-through check.");
      // A2: read the registry metric, never a model attribute. The
      // model's own `viewThroughShare` divided view-through conversions by the
      // `conversions` column, which excludes them — inflated, able to exceed 100%,
      // and with no floor it explained away findings on a 2-conversion campaign.
      // `C.viewthrough_share` is vtc / (conversions + vtc), already in PERCENT, and
      // returns `insufficient_data` under the 10-conversion floor.
      const m = ctx.metrics.get("C.viewthrough_share", { kind: "campaign", id: campaign.id });
      if (!isComputable(m)) {
        return unknown(`View-through share for ${campaign.name} is not computable: ${m.detail}`, [
          ev("metric", "C.viewthrough_share", campaign.name),
          ev("table", "campaignControlSettings"),
        ]);
      }
      const share = typeof m.value === "number" && Number.isFinite(m.value) ? m.value : null;
      if (share == null)
        return unknown(`View-through share for ${campaign.name} is not a number.`, [
          ev("metric", "C.viewthrough_share", campaign.name),
        ]);
      return share > 10
        ? explains(`${n2(share)}% of ${campaign.name}'s conversions are view-through.`, [
            ev("metric", "C.viewthrough_share", campaign.name),
          ])
        : cleared(`View-through conversions are ${n2(share)}% of ${campaign.name}'s total.`, [
            ev("metric", "C.viewthrough_share", campaign.name),
          ]);
    },
  },

  MI07: {
    question:
      'Does this campaign override the account conversion goals, changing what "a conversion" means here?',
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (campaign) {
        const d = campaign.attrs.conversionGoalsDifferFromCustomer;
        if (d == null)
          return unknown(
            `Conversion goals for ${campaign.name} could not be compared with the account goals.`,
            [ev("table", "campaignConversionGoals")],
          );
        return d
          ? caveat(
              `${campaign.name} overrides the account conversion goals — its conversions count something different, which must be stated beside the number.`,
              [ev("metric", "C.goal_override", campaign.name)],
            )
          : cleared(`${campaign.name} uses the account conversion goals.`, [
              ev("metric", "C.goal_override", campaign.name),
            ]);
      }
      const campaigns = ctx.model.children.campaigns;
      const overriding = campaigns.filter(
        (c) => c.attrs.conversionGoalsDifferFromCustomer === true,
      );
      if (overriding.length > 0) {
        return caveat(
          `${overriding.length} campaign(s) override the account conversion goals (${overriding.map((c) => c.name).join(", ")}) — a standing configuration to state, not a cause of this signal.`,
          [ev("metric", "C.goal_override")],
        );
      }
      if (campaigns.every((c) => c.attrs.conversionGoalsDifferFromCustomer == null)) {
        return unknown("Campaign conversion goals could not be compared with the account goals.", [
          ev("table", "campaignConversionGoals"),
        ]);
      }
      return cleared("Every campaign uses the account conversion goals.", [
        ev("metric", "C.goal_override"),
      ]);
    },
  },

  MI08: {
    question:
      "Is the window this claim is made over settled, or does it reach past the conversion lookback?",
    onExplains: "transform",
    resolve: (ctx) => {
      const w = ctx.model.window;
      if (w.lookbackUnknown || w.lastSettledDay == null) {
        return unknown(
          "No conversion lookback is known, so nothing in this window can be called settled.",
          [ev("table", "conversionActions")],
        );
      }
      const label = ctx.scope.window ?? "m30";
      const spec = (
        w.windows as Record<
          string,
          { start: string | null; end: string | null; settledStrict: boolean }
        >
      )[label];
      if (!spec)
        return unknown(`Window "${label}" is not one of the model's windows.`, [
          ev("window", label),
        ]);
      return spec.settledStrict
        ? cleared(
            `Window ${label} (${spec.start}..${spec.end}) ends on or before the last settled day ${w.lastSettledDay}.`,
            [ev("window", label)],
          )
        : caveat(
            `Window ${label} (${spec.start}..${spec.end}) runs past the last settled day ${w.lastSettledDay} — its conversions are still maturing, so the finding is MODERATE and must carry that sentence. Maturity caveats a number, it does not delete it.`,
            [ev("window", label), ev("metric", "W.last_settled_day")],
          );
    },
  },

  // --- B.2 structure and controls ------------------------------------------

  AS01: {
    question: "Is brand spend big enough to be moving this number?",
    onExplains: "transform",
    resolve: (ctx) => {
      const share = ctx.model.attrs.brandSpendShare;
      if (share == null)
        return unknown("Brand spend share could not be computed (no campaign classified brand).", [
          ev("metric", "A.brand_spend_share"),
        ]);
      return share >= ctx.thresholds.brandSharePct
        ? explains(
            `Brand campaigns take ${n2(share)}% of spend — brand returns are mixed into this number.`,
            [ev("metric", "A.brand_spend_share")],
          )
        : cleared(`Brand campaigns take ${n2(share)}% of spend.`, [
            ev("metric", "A.brand_spend_share"),
          ]);
    },
  },

  AS02: {
    question: "Is a brand campaign carrying a value/CPA target that distorts the comparison?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const brands = campaign
        ? campaign.attrs.isBrand
          ? [campaign]
          : []
        : ctx.model.children.campaigns.filter((c) => c.attrs.isBrand);
      if (brands.length === 0) return cleared("No brand campaign in scope.");
      const targeted = brands.filter(
        (c) => c.attrs.targetRoas != null || c.attrs.targetCpa != null,
      );
      return targeted.length > 0
        ? explains(
            `Brand campaign(s) ${targeted.map((c) => c.name).join(", ")} run on an efficiency target — brand is exempt from the bidding ladder.`,
            [ev("node", targeted[0]!.id, targeted[0]!.name)],
          )
        : cleared(
            `Brand campaign bidding is appropriate (${brands.map((c) => c.attrs.strategy ?? "unknown strategy").join(", ")}).`,
          );
    },
  },

  AS03: {
    question: "Does this campaign share its budget with siblings that would absorb the change?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the shared-budget check.");
      const b = campaign.attrs.budget;
      if (b.id == null)
        return unknown(`No budget row joins ${campaign.name}.`, [ev("table", "campaignBudgets")]);
      return b.shared && b.siblingCampaignIds.length > 0
        ? explains(
            `${campaign.name} shares budget ${b.id} with ${b.siblingCampaignIds.length} sibling campaign(s) — the money moves between them, so a per-campaign claim is not safe.`,
            [ev("metric", "C.budget_shared", campaign.name)],
          )
        : cleared(`${campaign.name} has its own budget (shared=false).`, [
            ev("metric", "C.budget_shared", campaign.name),
          ]);
    },
  },

  AS04: {
    question: "Can Google change this account without a human (auto-apply)?",
    onExplains: "transform",
    resolve: (ctx) => {
      const subs = ctx.model.attrs.recommendationSubscriptions;
      if (
        subs.length === 0 &&
        tableState(ctx, "recommendationSubscriptions").checkable === "unknown"
      ) {
        return unknown(
          "recommendation_subscriptions has no rows and no sync marker — auto-apply cannot be ruled out.",
          [ev("table", "recommendationSubscriptions")],
        );
      }
      const enabled = subs.filter((s) => String(s.status ?? "").toUpperCase() === "ENABLED");
      return enabled.length > 0
        ? explains(
            `${enabled.length} recommendation type(s) auto-apply (${enabled.map((s) => s.type).join(", ")}) — changes here may have no human author.`,
            [ev("metric", "A.auto_apply_enabled_count")],
          )
        : cleared("No recommendation type auto-applies.", [
            ev("metric", "A.auto_apply_enabled_count"),
          ]);
    },
  },

  AS06: {
    question: "Is this campaign an experiment arm, where the behaviour is deliberate?",
    onExplains: "drop",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const exps = ctx.model.attrs.experiments;
      if (exps.length === 0)
        return cleared("No experiments on this account.", [ev("metric", "A.experiments_active")]);
      if (!campaign) {
        const enabled = exps.filter((e) => String(e.status ?? "").toUpperCase() === "ENABLED");
        // R13: an experiment whose arm campaigns all spent $0 in the window steers nothing
        // (a shop had 2 left "enabled" since 2022 on campaigns with no spend); a campaign the
        // model does not hold is unknown, so it still counts
        const campaigns = new Map(ctx.model.children.campaigns.map((c) => [c.id, c] as const));
        const spent = (e: (typeof exps)[number]): boolean =>
          e.armCampaignIds.length === 0 ||
          e.armCampaignIds.some((id) => {
            const c = campaigns.get(id);
            return c == null || (c.windows.m90.cost ?? 0) > 0;
          });
        const active = enabled.filter(spent);
        const idle = enabled.length - active.length;
        return active.length > 0
          ? explains(
              `${active.length} experiment(s) are running; campaigns in their arms behave deliberately.`,
              [ev("metric", "A.experiments_active")],
            )
          : cleared(
              idle > 0
                ? `No experiment is running on a campaign that spent in the window (${idle} enabled on campaigns that spent $0).`
                : "No experiment is running.",
              [ev("metric", "A.experiments_active")],
            );
      }
      const arm = exps.find((e) => e.armCampaignIds.includes(campaign.id));
      return arm
        ? explains(
            `${campaign.name} is an arm of experiment "${arm.name ?? arm.id}" (${arm.status ?? "status unknown"}) — it is exempt from zombie / dormant verdicts.`,
            [ev("node", campaign.id, campaign.name)],
          )
        : cleared(`${campaign.name} is not in any experiment arm.`, [
            ev("node", campaign.id, campaign.name),
          ]);
    },
  },

  AS09: {
    question: "Do the remarketing lists this claim assumes actually exist?",
    onExplains: "transform",
    resolve: (ctx) => {
      // Phase 11b: A.required_list_coverage now answers it — the seven essential
      // e-commerce lists (audienceRoles.ts), matched on each list's rule / purchase
      // action first and its name as a fallback. Value = role -> lists matching it.
      const m = ctx.metrics.get("A.required_list_coverage", { kind: "account", id: null });
      if (!isComputable(m))
        return unknown(`Standard list coverage is not computable: ${m.detail}`, [
          ev("table", "audienceLists"),
        ]);
      const map = (
        m.value && typeof m.value === "object" && !Array.isArray(m.value) ? m.value : {}
      ) as Record<string, unknown>;
      const roles = Object.keys(map);
      const missing = roles.filter((r) => !(Number(map[r]) > 0));
      if (roles.length === 0)
        return unknown("Standard list coverage returned no roles.", [
          ev("metric", "A.required_list_coverage"),
        ]);
      return missing.length > 0
        ? explains(
            `${missing.length} of ${roles.length} standard remarketing lists are missing (${missing.map((r) => ESSENTIAL_ROLE_LABELS[r as EssentialRole] ?? r).join(", ")}).`,
            [ev("metric", "A.required_list_coverage"), ev("table", "audienceLists")],
          )
        : cleared(`All ${roles.length} standard remarketing lists exist.`, [
            ev("metric", "A.required_list_coverage"),
          ]);
    },
  },

  AS11: {
    question: "Does the change feed cover the whole window, or is it truncated?",
    onExplains: "transform",
    resolve: (ctx) => {
      const ch = ctx.model.attrs.changeHistory;
      if (ch.rows === 0)
        return unknown("No change_history rows — dated causes cannot be ruled in or out.", [
          ev("table", "changeHistory"),
        ]);
      if (ch.sample) {
        return unknown(
          `change_history is capped at ${ch.cap} rows and covers only ${ch.firstDate}..${ch.lastDate} of the ${ctx.model.window.days}-day window — any "no cause found" answer is unknown, never cleared.`,
          [ev("metric", "A.change_days_covered"), ev("table", "changeHistory")],
        );
      }
      return cleared(`change_history covers ${ch.firstDate}..${ch.lastDate}.`, [
        ev("metric", "A.change_days_covered"),
      ]);
    },
  },

  // --- B.3 budget and bidding ----------------------------------------------

  BB01: {
    question: "Is the budget actually the cap, or is the campaign leaving it unspent?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the budget-utilisation check.");
      const util = campaign.attrs.budget.util90;
      if (util == null)
        return unknown(`Budget utilisation for ${campaign.name} could not be computed.`, [
          ev("metric", "C.budget_util90", campaign.name),
        ]);
      return util < ctx.thresholds.chokingUtil
        ? explains(
            `${campaign.name} uses only ${pct(util)} of its budget — the budget is not what is holding it back.`,
            [ev("metric", "C.budget_util90", campaign.name)],
          )
        : cleared(`${campaign.name} uses ${pct(util)} of its budget.`, [
            ev("metric", "C.budget_util90", campaign.name),
          ]);
    },
  },

  BB02: {
    question: "Is delivery capped by budget (lost impression share to budget)?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the lost-IS check.");
      const is = campaign.attrs.impressionShare;
      if (is.source === "none" || is.lostBudget == null) {
        return unknown(
          `No impression_share row joins ${campaign.name} (PMax and Shopping have none) — lost IS to budget is not checkable.`,
          [ev("table", "impressionShare")],
        );
      }
      const lostBudgetPct = isPct(is.lostBudget)!;
      return lostBudgetPct > ctx.thresholds.lostIsBudgetPct * 2
        ? explains(
            `${campaign.name} loses ${n2(lostBudgetPct)}% of impressions to budget — delivery is budget-capped.`,
            [ev("metric", "C.lost_is_budget_pct", campaign.name)],
          )
        : cleared(`${campaign.name} loses ${n2(lostBudgetPct)}% of impressions to budget.`, [
            ev("metric", "C.lost_is_budget_pct", campaign.name),
          ]);
    },
  },

  /** For a budget-headroom claim the interesting answer is the opposite one. */
  "BB02@scale": {
    question: "Does the campaign lose any impression share to budget?",
    onExplains: "drop",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the lost-IS check.");
      const is = campaign.attrs.impressionShare;
      if (is.source === "none" || is.lostBudget == null) {
        return unknown(
          `No impression_share row joins ${campaign.name} — there is no evidence the campaign is budget-starved.`,
          [ev("table", "impressionShare")],
        );
      }
      const lostBudgetPct = isPct(is.lostBudget)!;
      return lostBudgetPct <= ctx.thresholds.lostIsBudgetPct
        ? explains(
            `${campaign.name} loses only ${n2(lostBudgetPct)}% of impressions to budget — almost no impressions are lost to budget.`,
            [ev("metric", "C.lost_is_budget_pct", campaign.name)],
          )
        : cleared(
            `${campaign.name} loses ${n2(lostBudgetPct)}% of impressions to budget — impressions are lost to budget.`,
            [ev("metric", "C.lost_is_budget_pct", campaign.name)],
          );
    },
  },

  BB03: {
    question: "Is impression share lost to rank rather than to money?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the rank-IS check.");
      const is = campaign.attrs.impressionShare;
      if (is.source === "none" || is.lostRank == null)
        return unknown(`No impression_share row joins ${campaign.name}.`, [
          ev("table", "impressionShare"),
        ]);
      const cost = campaign.windows.m90.cost ?? 0;
      const lostRankPct = isPct(is.lostRank)!;
      return lostRankPct > ctx.thresholds.lostIsRankPct && cost >= wasteFloor(ctx)
        ? explains(
            `${campaign.name} loses ${n2(lostRankPct)}% of impressions to rank on ${n2(cost)} spend — quality and bid, not budget.`,
            [ev("metric", "C.lost_is_rank_pct", campaign.name)],
          )
        : cleared(`${campaign.name} loses ${n2(lostRankPct)}% of impressions to rank.`, [
            ev("metric", "C.lost_is_rank_pct", campaign.name),
          ]);
    },
  },

  BB04: {
    question:
      "Does this campaign have the conversion volume its bid target needs (F.conv_min_for_verdict and the ladder)?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the volume check.");
      const conv30 = campaign.windows.m30?.conv ?? null;
      const { targetRoas, targetCpa } = campaign.attrs;
      if (targetRoas == null && targetCpa == null)
        return cleared(`${campaign.name} carries no efficiency target.`, [
          ev("node", campaign.id, campaign.name),
        ]);
      if (conv30 == null)
        return unknown(
          `${campaign.name} has no 30-day series — the volume behind its target is unknown.`,
          [ev("window", "m30")],
        );
      const need =
        targetRoas != null ? ctx.thresholds.tRoasMinConv30 : ctx.thresholds.tCpaMinConv30;
      if (conv30 < convFloor(ctx)) {
        return explains(
          `${campaign.name} has ${n2(conv30)} conversions in 30 days, below F.conv_min_for_verdict (${convFloor(ctx)}) — nothing about its target can be judged yet.`,
          [ev("metric", "F.conv_min_for_verdict"), ev("window", "m30")],
        );
      }
      return conv30 < need
        ? explains(
            `${campaign.name} runs a ${targetRoas != null ? "tROAS" : "tCPA"} target on ${n2(conv30)} conversions/30d, under the ${need} the ladder needs — the target is ahead of the data, so wait rather than change it.`,
            [ev("window", "m30"), ev("node", campaign.id, campaign.name)],
          )
        : cleared(
            `${campaign.name} has ${n2(conv30)} conversions/30d, enough for its ${targetRoas != null ? "tROAS" : "tCPA"} target.`,
            [ev("window", "m30")],
          );
    },
  },

  BB05: {
    question: "Is the bid target choking delivery, rather than the budget?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the target-choking check.");
      const target = campaign.attrs.targetRoas;
      if (target == null)
        return cleared(`${campaign.name} carries no tROAS target.`, [
          ev("node", campaign.id, campaign.name),
        ]);
      const realised = campaign.windows.m30?.roas ?? null;
      const util = campaign.attrs.budget.util90;
      if (realised == null || util == null)
        return unknown(
          `${campaign.name} has no 30-day ROAS or no budget utilisation — choking cannot be judged.`,
          [ev("window", "m30"), ev("metric", "C.budget_util90", campaign.name)],
        );
      return target >= ctx.thresholds.chokingTargetRatio * realised &&
        util < ctx.thresholds.chokingUtil
        ? explains(
            `${campaign.name} targets ${n2(target)}x against a realised ${n2(realised)}x while using ${pct(util)} of its budget — the target is holding delivery back, so change the target, not the budget.`,
            [
              ev("metric", "C.target_vs_realized", campaign.name),
              ev("metric", "C.budget_util90", campaign.name),
            ],
          )
        : cleared(
            `${campaign.name} targets ${n2(target)}x against a realised ${n2(realised)}x at ${pct(util)} budget use — the target is not choking delivery.`,
            [ev("metric", "C.target_vs_realized", campaign.name)],
          );
    },
  },

  BB07: {
    question: "Is this campaign already at its budget ceiling?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign, product } = locate(ctx);
      const c =
        campaign ??
        (product && product.attrs.pmaxCampaignIds[0]
          ? (ctx.model.index.campaignsById.get(product.attrs.pmaxCampaignIds[0]) ?? null)
          : null);
      if (!c) return unknown("No campaign in scope for the budget-ceiling check.");
      const util = c.attrs.budget.util90;
      const lost = isPct(c.attrs.impressionShare.lostBudget);
      if (util == null)
        return unknown(`Budget utilisation for ${c.name} could not be computed.`, [
          ev("metric", "C.budget_util90", c.name),
        ]);
      return util >= ctx.thresholds.scaleUtilMin && (lost ?? 0) > ctx.thresholds.lostIsBudgetPct
        ? explains(
            `${c.name} already runs at ${pct(util)} of budget and loses ${n2(lost)}% of impressions to it — the constraint is the budget, not this finding.`,
            [ev("metric", "C.budget_util90", c.name), ev("metric", "C.lost_is_budget_pct", c.name)],
          )
        : cleared(`${c.name} runs at ${pct(util)} of budget — part of the budget is unspent.`, [
            ev("metric", "C.budget_util90", c.name),
          ]);
    },
  },

  BB09: {
    question:
      "Is a bid modifier already set on this slice, making it a choice rather than an accident?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign, slice } = locate(ctx);
      const mods = campaign
        ? campaign.children.bidModifiers
        : ctx.model.children.campaigns.flatMap((c) => c.children.bidModifiers);
      if (mods.length === 0)
        return cleared("No bid modifiers are set at this scope.", [ev("table", "bidModifiers")]);
      const unresolved = mods.filter(
        (m) => m.attrs.measuredSlice.kind === "unresolved" && !m.attrs.measuredSlice.noSlice,
      );
      if (
        unresolved.length > 0 &&
        unresolved.length ===
          mods.filter(
            (m) => !(m.attrs.measuredSlice.kind === "unresolved" && m.attrs.measuredSlice.noSlice),
          ).length
      ) {
        return unknown(
          `${unresolved.length} bid modifier row(s) carry no interaction_type / modifier_source — the criterion cannot be resolved, so a modifier on this slice cannot be ruled out.`,
          [ev("table", "bidModifiers")],
        );
      }
      const dim = slice?.attrs.dimension ?? ctx.scope.dimension;
      const key = slice?.attrs.key ?? ctx.scope.key;
      const hit = mods.find((m) => {
        const ms = m.attrs.measuredSlice;
        // a 1.0 modifier is "no adjustment", never a deliberate choice
        return (
          ms.kind !== "unresolved" &&
          ms.kind === dim &&
          m.attrs.modifier !== 1 &&
          (ms.key === key || (key != null && (ms.cells ?? []).includes(key)))
        );
      });
      return hit
        ? explains(
            `A bid modifier of ${n2(hit.attrs.modifier)} is already set on ${dim} "${key}" — the numbers on this slice are a deliberate choice.`,
            [ev("node", hit.id, "bid modifier")],
          )
        : cleared(`No bid modifier is set on ${dim ?? "this"} "${key ?? "—"}".`, [
            ev("table", "bidModifiers"),
          ]);
    },
  },

  // --- B.4 search -----------------------------------------------------------

  SK02: {
    question: "Is low quality score the component with the evidence behind this signal?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { keyword, campaign, adGroup } = locate(ctx);
      const kws = keyword
        ? [keyword]
        : adGroup
          ? adGroup.children.keywords
          : campaign
            ? campaign.children.adGroups.flatMap((g) => g.children.keywords)
            : ctx.model.children.campaigns
                .flatMap((c) => c.children.adGroups)
                .flatMap((g) => g.children.keywords);
      const withQs = kws.filter((k) => k.attrs.qs != null && k.attrs.qs > 0);
      if (withQs.length === 0)
        return unknown("No keyword in scope reports a quality score.", [ev("table", "keywords")]);
      const low = withQs.filter((k) => (k.attrs.qs as number) <= ctx.thresholds.qsLow);
      if (low.length === 0)
        return cleared(
          `Every keyword in scope with a quality score is above ${ctx.thresholds.qsLow} (${withQs.length} scored).`,
          [ev("metric", "K.qs")],
        );
      const worst = low.sort((a, b) => (a.attrs.qs as number) - (b.attrs.qs as number))[0]!;
      const comp = worst.attrs.qsComponents;
      return explains(
        `${low.length} keyword(s) score ≤${ctx.thresholds.qsLow}; the worst is "${worst.attrs.text}" at QS ${worst.attrs.qs} (expected CTR ${comp.expectedCtr ?? "?"}, ad relevance ${comp.adRelevance ?? "?"}, landing page ${comp.landingPageExperience ?? "?"}).`,
        [ev("node", worst.id, worst.attrs.text), ev("metric", "K.qs")],
      );
    },
  },

  SK03: {
    question: "Is one match type carrying the spend, so the behaviour follows from the match type?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const kws = (
        campaign
          ? campaign.children.adGroups
          : ctx.model.children.campaigns.flatMap((c) => c.children.adGroups)
      )
        .flatMap((g) => g.children.keywords)
        .filter((k) => !k.attrs.isNegative);
      if (kws.length === 0) return unknown("No keywords in scope.", [ev("table", "keywords")]);
      const total = kws.reduce((s, k) => s + (k.windows.m90.cost ?? 0), 0);
      if (total <= 0)
        return cleared("Keywords in scope carry no spend.", [ev("table", "keywords")]);
      const byType = new Map<string, number>();
      for (const k of kws)
        byType.set(
          k.attrs.matchType ?? "UNKNOWN",
          (byType.get(k.attrs.matchType ?? "UNKNOWN") ?? 0) + (k.windows.m90.cost ?? 0),
        );
      const [type, cost] = [...byType.entries()].sort((a, b) => b[1] - a[1])[0]!;
      return cost / total > 0.8
        ? explains(
            `${type} match holds ${pct(cost / total)} of keyword spend in scope — match type shapes what is being bought.`,
            [ev("metric", "K.match_type")],
          )
        : cleared(`Match types are mixed (top: ${type} at ${pct(cost / total)}).`, [
            ev("metric", "K.match_type"),
          ]);
    },
  },

  SK04: {
    question: "Is the same keyword duplicated across ad groups, splitting the data?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign, adGroup, keyword } = locate(ctx);
      const kws = keyword
        ? [keyword]
        : adGroup
          ? adGroup.children.keywords
          : (
              campaign ?? {
                children: {
                  adGroups: ctx.model.children.campaigns.flatMap((c) => c.children.adGroups),
                },
              }
            ).children.adGroups.flatMap((g) => g.children.keywords);
      // SK04's rule: a copy duplicates only when its campaign reaches the same people
      const dupes = kws.filter((k) => duplicateCopiesOf(ctx.model, k).length > 0);
      return dupes.length > 0
        ? explains(
            `${dupes.length} keyword(s) in scope are duplicated in another ad group (e.g. "${dupes[0]!.attrs.text}").`,
            [ev("metric", "K.duplicate_key")],
          )
        : cleared("No duplicate keywords across ad groups in scope.", [
            ev("metric", "K.duplicate_key"),
          ]);
    },
  },

  SK05: {
    question: "Is search-term waste already the explanation for this campaign's numbers?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const terms = (campaign ? [campaign] : ctx.model.children.campaigns)
        .flatMap((c) =>
          c.children.searchTerms.concat(c.children.adGroups.flatMap((g) => g.children.searchTerms)),
        )
        // PMax terms are PX22's (negatives framework P3), never SK05's; unknown conversions are never zero sales
        .filter((t) => t.attrs.source !== "pmaxSearchTerms");
      if (terms.length === 0)
        return unknown("No search terms join this scope.", [ev("table", "searchTerms")]);
      const floor = wasteFloor(ctx);
      const waste = terms.filter(
        (t) => t.windows.m90.conv === 0 && (t.windows.m90.cost ?? 0) >= floor,
      );
      const wasted = waste.reduce((s, t) => s + (t.windows.m90.cost ?? 0), 0);
      if (waste.length > 0)
        return explains(
          `${waste.length} search term(s) spend ${n2(wasted)} without a sale past the ${floor} floor.`,
          [ev("metric", "T.waste_floor")],
        );
      const sampled = ctx.model.attrs.searchTerms.sample || terms.some((t) => t.sample.truncated);
      const none = cleared(
        `No search term in scope spends past the ${floor} floor without a sale (${terms.length} rows checked${sampled ? `, capped at ${ctx.model.attrs.searchTerms.cap} — a sample, never the population` : ", full population"}).`,
        [ev("metric", "T.waste_floor"), ev("metric", "T.population_complete")],
      );
      return sampled ? { ...none, capsConfidence: "MODERATE" } : none;
    },
  },

  SK06: {
    question: "Is this term already negatived at campaign, shared-list or account level?",
    onExplains: "drop",
    resolve: (ctx) => {
      const { searchTerm } = locate(ctx);
      if (!searchTerm) return unknown("No search term in scope for the negative check.");
      const b = searchTerm.attrs.blocked;
      const levels: [string, string][] = [
        ["campaign", b.campaign],
        ["shared list", b.sharedList],
        ["account", b.account],
      ];
      const blocked = levels.filter(([, s]) => s === "blocked").map(([l]) => l);
      if (blocked.length > 0) {
        return explains(
          `"${searchTerm.attrs.term}" is already negatived at ${blocked.join(" + ")} level (${b.by.slice(0, 3).join(", ")}) — it cannot be blocked twice.`,
          [ev("node", searchTerm.id, searchTerm.attrs.term), ev("table", "accountNegatives")],
        );
      }
      const unresolved = levels.filter(([, s]) => s === "unknown").map(([l]) => l);
      if (unresolved.length > 0) {
        return unknown(
          `Negatives at ${unresolved.join(" + ")} level are not synced for this campaign — "${searchTerm.attrs.term}" may already be blocked.`,
          [ev("node", searchTerm.id, searchTerm.attrs.term), ev("table", "campaignNegatives")],
        );
      }
      return cleared(`"${searchTerm.attrs.term}" is not negatived at any of the three levels.`, [
        ev("metric", "T.blocked_level"),
      ]);
    },
  },

  SK07: {
    question: "Is this a brand campaign, where the query mix means something different?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign, searchTerm } = locate(ctx);
      const c = campaign;
      if (!c) return unknown("No campaign in scope for the brand check.");
      if (!c.attrs.isBrand)
        return cleared(`${c.name} is not a brand campaign.`, [ev("node", c.id, c.name)]);
      const term = searchTerm ? ` "${searchTerm.attrs.term}"` : "";
      return explains(
        `${c.name} is a brand campaign — a term${term} there is defensive spend, not prospecting waste.`,
        [ev("node", c.id, c.name)],
      );
    },
  },

  SK10: {
    question: "Did this query come from dynamic search ads, which keyword negatives do not govern?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { searchTerm, campaign } = locate(ctx);
      if (searchTerm?.attrs.isDsa) {
        return explains(
          `"${searchTerm.attrs.term}" came from DSA — keyword negatives do not apply to it; DSA exclusions do.`,
          [ev("node", searchTerm.id, searchTerm.attrs.term)],
        );
      }
      if (campaign?.attrs.hasPageFeed) {
        return unknown(
          `${campaign.name} carries a page feed and dsa_search_terms is ${tableState(ctx, "dsaSearchTerms").rows === 0 ? "not synced" : "incomplete"} — a DSA origin cannot be ruled out.`,
          [ev("table", "dsaSearchTerms")],
        );
      }
      return cleared("No DSA campaign involved.", [ev("table", "dsaSearchTerms")]);
    },
  },

  SK11: {
    question: "Does this ad group carry the 1-3 responsive ads the comparison assumes?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { adGroup } = locate(ctx);
      if (!adGroup) return unknown("No ad group in scope for the ad-count check.");
      const n = adGroup.attrs.rsaCount;
      return n === 0 || n > 3
        ? explains(
            `${adGroup.name} runs ${n} responsive search ads — outside the 1-3 range the comparison assumes.`,
            [ev("metric", "G.rsa_count", adGroup.name)],
          )
        : cleared(`${adGroup.name} runs ${n} responsive search ad(s).`, [
            ev("metric", "G.rsa_count", adGroup.name),
          ]);
    },
  },

  SK12: {
    question: "Is the ad underfilled, so the asset numbers come from a thin ad?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { ad, adGroup } = locate(ctx);
      const ads = ad ? [ad] : adGroup ? adGroup.children.ads : [];
      if (ads.length === 0)
        return unknown("No ad in scope for the fill check.", [ev("table", "ads")]);
      const thin = ads.filter((a) => a.attrs.headlineCount < 11);
      return thin.length > 0
        ? explains(
            `${thin.length} ad(s) carry fewer than 11 headlines (worst: ${Math.min(...thin.map((a) => a.attrs.headlineCount))}).`,
            [ev("metric", "D.headline_count")],
          )
        : cleared("Every ad in scope is fully filled.", [ev("metric", "D.headline_count")]);
    },
  },

  SK14: {
    question: "Has Google labelled any of these assets LOW?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { ad } = locate(ctx);
      const assets = ad ? ad.children.assets : [];
      if (ad && assets.length === 0)
        return unknown(`No asset_performance row joins ${ad.name}.`, [
          ev("table", "assetPerformance"),
        ]);
      if (!ad) {
        const labels = ctx.model.attrs.assetPerformance.labels;
        if (labels == null)
          return unknown(
            `asset_performance has ${ctx.model.attrs.assetPerformance.rows} rows but ${ctx.model.attrs.assetPerformance.population} join this audit — no label population.`,
            [ev("table", "assetPerformance")],
          );
        return (labels.LOW ?? 0) > 0
          ? explains(`${labels.LOW} asset(s) are labelled LOW.`, [ev("metric", "S.asset_label")])
          : cleared(
              `No asset is labelled LOW (labels: ${Object.entries(labels)
                .map(([k, v]) => `${k} ${v}`)
                .join(", ")}). NOT_APPLICABLE is not LOW.`,
              [ev("metric", "S.asset_label")],
            );
      }
      const low = assets.filter(
        (a) => a.attrs.performanceLabel === "LOW" || a.attrs.assetPerformanceLabel === "LOW",
      );
      return low.length > 0
        ? explains(`${low.length} asset(s) on ${ad.name} are labelled LOW.`, [
            ev("metric", "S.asset_label"),
          ])
        : cleared(`No asset on ${ad.name} is labelled LOW.`, [ev("metric", "S.asset_label")]);
    },
  },

  SK15: {
    question: "Is an ad disapproved, so it never got the chance to perform?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { ad } = locate(ctx);
      if (ad) {
        if (ad.attrs.policy == null)
          return unknown(`No ad_policy row joins ${ad.name}.`, [ev("table", "adPolicy")]);
        const s = ad.attrs.policy.approvalStatus;
        return s !== "APPROVED"
          ? explains(`${ad.name} is ${s ?? "not approved"} — it cannot serve as written.`, [
              ev("metric", "D.approval_status", ad.name),
            ])
          : cleared(`${ad.name} is approved.`, [ev("metric", "D.approval_status", ad.name)]);
      }
      const p = ctx.model.attrs.adPolicy;
      if (p.population === 0) {
        return unknown(
          `ad_policy holds ${p.rows} rows and none of them join this audit's ads — approval status is not checkable.`,
          [ev("table", "adPolicy")],
        );
      }
      return (p.notApproved ?? 0) > 0
        ? explains(`${p.notApproved} of ${p.population} joined ads are not approved.`, [
            ev("metric", "D.approval_status"),
          ])
        : cleared(`All ${p.population} joined ads are approved.`, [
            ev("metric", "D.approval_status"),
          ]);
    },
  },

  SK16: {
    question: "Do extension rows of this type actually join this campaign?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign, extension } = locate(ctx);
      const type = extension?.attrs.type ?? ctx.scope.key ?? null;
      const rows = campaign
        ? campaign.children.extensions.concat(
            campaign.children.adGroups.flatMap((g) => g.children.extensions),
          )
        : ctx.model.children.campaigns.flatMap((c) =>
            c.children.extensions.concat(c.children.adGroups.flatMap((g) => g.children.extensions)),
          );
      const scoped = type ? rows.filter((r) => r.attrs.type === type) : rows;
      if (scoped.length === 0) {
        return unknown(
          `No ${type ?? "extension"} row joins ${campaign?.name ?? "this account"} — absence here is an orphan-row artefact, not a configuration fact (${ctx.model.dataQuality.orphanRows.adExtensions ?? 0} orphan rows).`,
          [ev("table", "adExtensions")],
        );
      }
      return cleared(
        `${scoped.length} ${type ?? "extension"} row(s) join ${campaign?.name ?? "this account"}.`,
        [ev("metric", "S.ext_distinct")],
      );
    },
  },

  SK17: {
    question: "Do these extensions ever serve, once the per-type level rules are applied?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { extension, campaign } = locate(ctx);
      if (extension) return R.X_SERVING_RULES!.resolve(ctx);
      const rows = (campaign ? [campaign] : ctx.model.children.campaigns).flatMap((c) =>
        c.children.extensions.concat(c.children.adGroups.flatMap((g) => g.children.extensions)),
      );
      if (rows.length === 0)
        return unknown("No extension rows join this scope.", [ev("table", "adExtensions")]);
      // only rows that could serve count: overridden and never-serve-by-type rows are the rule, not a defect.
      const eligible = rows.filter((r) => r.attrs.servedStatus === "eligible_no_impressions");
      const served = rows.filter(
        (r) => r.attrs.servedStatus === "served" || r.attrs.servedStatus === "served_despite_rule",
      );
      return eligible.length > 0
        ? explains(
            `${eligible.length} of ${rows.length} joined extension rows are eligible and have never served (${served.length} have); the overridden and never-serve-by-type rows are excluded.`,
            [ev("metric", "S.ext_impressions")],
          )
        : cleared(
            `Every joined extension row either served or is explained by a level rule (${served.length} served of ${rows.length}).`,
            [ev("metric", "S.ext_impressions")],
          );
    },
  },

  SK18: {
    question: "Is a promotion asset live inside this window, moving conversion value?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const rows = (campaign ? [campaign] : ctx.model.children.campaigns)
        .flatMap((c) => c.children.extensions)
        .filter((e) => e.attrs.type === "PROMOTION");
      if (rows.length === 0)
        return cleared("No promotion assets on the campaigns in scope.", [
          ev("table", "adExtensions"),
        ]);
      const dated = rows.filter((r) => r.attrs.promoEndDate != null);
      if (dated.length === 0) {
        return unknown(
          `${rows.length} promotion asset(s) are attached and none carries an end date — whether a promotion started or ended inside the window cannot be told.`,
          [ev("metric", "S.promo_end_date")],
        );
      }
      return explains(
        `${dated.length} promotion asset(s) carry end dates inside or near the window (${dated
          .map((r) => r.attrs.promoEndDate)
          .slice(0, 3)
          .join(", ")}) — conversion value moves with them.`,
        [ev("metric", "S.promo_end_date")],
      );
    },
  },

  SK19: {
    question: "Is the landing page broken (http, or a 4xx/5xx status)?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { landingPage } = locate(ctx);
      const pages = landingPage ? [landingPage] : ctx.model.children.landingPages;
      if (pages.length === 0)
        return unknown("No landing pages synced.", [ev("table", "landingPageViews")]);
      const http = pages.filter((p) => p.attrs.scheme === "http");
      const note =
        "The HTTP-status leg is not checkable: url_health carries no audit_id and holds no rows for these pages.";
      if (http.length > 0) {
        return explains(`${http.length} landing page(s) resolve over http. ${note}`, [
          ev("metric", "L.scheme"),
        ]);
      }
      return {
        ...cleared(`All ${pages.length} landing pages in scope resolve over https. ${note}`, [
          ev("metric", "L.scheme"),
          ev("table", "urlHealth"),
        ]),
        capsConfidence: "MODERATE",
      };
    },
  },

  SK20: {
    question: "Is the landing page converting far below the account, so the page is the cause?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { landingPage, ad } = locate(ctx);
      const pages = landingPage ? [landingPage] : ad ? ad.children.landingPages : [];
      if (pages.length === 0)
        return unknown("No landing page in scope for the conversion-rate check.", [
          ev("table", "landingPageViews"),
        ]);
      const accountCvr = ctx.model.windows.m90.cvr;
      if (accountCvr == null)
        return unknown("Account conversion rate could not be computed.", [ev("metric", "A.cvr")]);
      const weak = pages.filter(
        (p) => (p.windows.m90.clicks ?? 0) >= 100 && (p.windows.m90.cvr ?? 0) < 0.5 * accountCvr,
      );
      return weak.length > 0
        ? explains(
            `${weak.length} landing page(s) convert below half the account rate (${pct(accountCvr)}); worst ${pct(weak[0]!.windows.m90.cvr)} on ${weak[0]!.attrs.urlKey}.`,
            [ev("metric", "L.spend"), ev("metric", "A.cvr")],
          )
        : cleared(
            `No landing page in scope converts materially below the account rate (${pct(accountCvr)}).`,
            [ev("metric", "A.cvr")],
          );
    },
  },

  SK22: {
    question: "Is a day-and-hour cell burning the money this claim is about?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const families = campaign ? campaign.children.slices : ctx.model.children.slices;
      if (families.dowHour.length === 0) {
        return unknown(
          "temporal_grid is empty — the crossed day × hour cell does not exist, and the dow / hour marginals must never be crossed or summed to fake it.",
          [ev("table", "temporalGrid")],
        );
      }
      const floor = wasteFloor(ctx);
      // R7: the same test SK22 runs, so a slot SK22 holds back as chance explains nothing
      const { dead } = deadHourSlots(families.dowHour, floor);
      return dead.length > 0
        ? explains(
            `${dead.length} day-and-hour cell(s) spend past the ${floor} floor without converting.`,
            [ev("metric", "SL.dow_hour")],
          )
        : cleared(
            `No day-and-hour cell spends past the ${floor} floor without converting where that is more than chance.`,
            [ev("metric", "SL.dow_hour")],
          );
    },
  },

  // --- B.5 / B.6 PMax, Shopping, feed --------------------------------------

  PX01: {
    question: "Where is this PMax campaign's money actually landing (shopping vs video/display)?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the channel-split check.");
      const s = campaign.attrs.channelShares;
      if (s == null || s.shopping == null)
        return unknown(
          `No channel distribution rows join ${campaign.name} — the surface split is not checkable.`,
          [ev("table", "pmaxChannelDistribution")],
        );
      return s.shopping < 0.5
        ? explains(
            `${campaign.name} sends only ${pct(s.shopping)} of attributable spend to Search/Shopping (${pct(s.unclassified)} unclassified) — the surface split is the cause.`,
            [ev("metric", "P.shopping_share", campaign.name)],
          )
        : cleared(
            `${campaign.name} runs ${pct(s.shopping)} on Search/Shopping (${pct(s.unclassified)} unclassified).`,
            [ev("metric", "P.shopping_share", campaign.name)],
          );
    },
  },

  PX02: {
    question: "Is PMax buying brand queries the Search brand campaign would otherwise win?",
    onExplains: "transform",
    resolve: (ctx) => {
      const pmax = ctx.model.children.campaigns.filter((c) => c.attrs.type === "PERFORMANCE_MAX");
      if (pmax.length === 0) return cleared("No PMax campaign on this account.");
      // P3g: brand lists synced → say which campaigns carry one; either way an
      // attached list does not rule the leak out (Shopping ads on brand
      // searches), so this stays unknown. Not synced (spec §8.3) —
      // say so, never claim it.
      const unsynced = pmax.filter(
        (c) => brandListStateOf(c.attrs.brandExclusions) === "not_checked",
      );
      if (unsynced.length === pmax.length) {
        return unknown(
          `PMax brand exclusions are not synced for ${pmax.map((c) => c.name).join(", ")} (campaigns.brandExclusions = not_synced) — a brand leak can neither be confirmed nor ruled out.`,
          [ev("table", "campaigns"), ev("metric", "P.brand_theme_click_share")],
        );
      }
      const parts = pmax.map((c) => {
        const st = brandListStateOf(c.attrs.brandExclusions);
        const names = brandListNamesFor(c.attrs.brandExclusions);
        return st === "attached"
          ? `${c.name}: brand list ${names.join(", ")}`
          : st === "contents_unknown"
            ? `${c.name}: a brand list is attached but we couldn't see whether it holds your brand`
            : st === "none"
              ? `${c.name}: no brand list holding your brand`
              : `${c.name}: brand lists not synced`;
      });
      return unknown(
        `PMax brand lists — ${parts.join("; ")}. An attached list still lets Shopping ads on brand searches through, so the leak is judged on the brand share, not the list.`,
        [ev("table", "campaign_brand_lists"), ev("metric", "P.brand_theme_click_share")],
      );
    },
  },

  /** For a search-term claim the question is whether a PMax search theme already covers the query. */
  "PX02@themes": {
    question: "Does a PMax search theme or search category already cover this query?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { searchTerm } = locate(ctx);
      const pmax = ctx.model.children.campaigns.filter((c) => c.attrs.type === "PERFORMANCE_MAX");
      if (pmax.length === 0) return cleared("No PMax campaign that could overlap this query.");
      const cats = pmax.flatMap((c) => c.children.searchCategories);
      const themes = pmax
        .flatMap((c) => c.children.assetGroups)
        .flatMap((g) => g.children.searchThemes);
      if (cats.length === 0 && themes.length === 0) {
        return unknown(
          "PMax runs on this account but no search categories or themes are synced — an overlap cannot be ruled out.",
          [ev("table", "pmaxSearchInsights")],
        );
      }
      const text = (searchTerm?.attrs.term ?? ctx.scope.key ?? "").toLowerCase();
      if (!text)
        return cleared(
          `${cats.length} PMax search categories and ${themes.length} themes exist; no query in scope to compare.`,
        );
      const hitCat = cats.find(
        (c) => c.attrs.label.toLowerCase() === text || text.includes(c.attrs.label.toLowerCase()),
      );
      const hitTheme = themes.find(
        (t) => t.attrs.text.toLowerCase() === text || text.includes(t.attrs.text.toLowerCase()),
      );
      return hitCat || hitTheme
        ? explains(
            `PMax already buys this query through ${hitTheme ? `search theme "${hitTheme.attrs.text}"` : `search category "${hitCat!.attrs.label}"`} — a keyword negative here moves the spend, it does not save it.`,
            [ev("node", (hitTheme ?? hitCat)!.id, "pmax search theme/category")],
          )
        : cats.some((c) => c.sample.truncated) || themes.some((t) => t.sample.truncated)
          ? {
              ...cleared(
                `No PMax search theme or category covers this query, but pmax_search_insights is capped at 50 rows per campaign (${cats.length} categories, ${themes.length} themes seen, some truncated) — the absence is from a sample, so confidence is capped at MODERATE.`,
                [ev("metric", "P.brand_theme_click_share")],
              ),
              capsConfidence: "MODERATE",
            }
          : cleared(
              `No PMax search theme or category (${cats.length} categories, ${themes.length} themes, full population) covers this query.`,
              [ev("metric", "P.brand_theme_click_share")],
            );
    },
  },

  /**
   * Negatives framework P3: for PX22 (PMax search-term waste). PMax searches a live
   * Search campaign targets go the overlap route (block in PMax only, so the Search
   * campaign serves them); the plan already places them there. A caveat line, never
   * a cause: the money is real either way.
   */
  PX12: {
    question:
      "Does a live Search campaign already target some of these Performance Max searches (the overlap route)?",
    onExplains: "transform",
    resolve: (ctx) => {
      const pmax = ctx.model.children.campaigns.filter((c) => c.attrs.type === "PERFORMANCE_MAX");
      const wasted = pmax
        .flatMap((c) => c.children.searchTerms)
        .filter(
          (t) =>
            t.attrs.source === "pmaxSearchTerms" &&
            t.windows.m90.conv === 0 &&
            (t.windows.m90.cost ?? 0) > 0,
        );
      if (wasted.length === 0)
        return cleared(
          "No Performance Max search with cost and no sale to compare with Search keywords.",
          [ev("table", "pmaxSearchTerms")],
        );
      const keywords = new Set(
        ctx.model.children.campaigns
          .filter((c) => c.attrs.type === "SEARCH" && !c.attrs.isBrand && statusOf(c) === "ENABLED")
          .flatMap((c) => c.children.adGroups.flatMap((g) => g.children.keywords))
          .filter((k) => !k.attrs.isNegative)
          .map((k) => k.attrs.text.toLowerCase().trim()),
      );
      const owned = wasted.filter((t) => keywords.has(t.attrs.term.toLowerCase().trim()));
      return owned.length > 0
        ? cleared(
            `${owned.length} of the ${wasted.length} Performance Max searches without a sale are keywords a live Search campaign targets; they are blocked in Performance Max only, so the Search campaign keeps them.`,
            [ev("table", "pmaxSearchTerms"), ev("table", "keywords")],
          )
        : cleared(
            `None of the ${wasted.length} Performance Max searches without a sale is a keyword a live Search campaign targets.`,
            [ev("table", "pmaxSearchTerms"), ev("table", "keywords")],
          );
    },
  },

  PX03: {
    question:
      "Are the asset groups complete enough to judge this, and is any of them feed-only by design?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { assetGroup, campaign } = locate(ctx);
      const groups = assetGroup
        ? [assetGroup]
        : campaign
          ? campaign.children.assetGroups
          : ctx.model.children.campaigns.flatMap((c) => c.children.assetGroups);
      if (groups.length === 0)
        return unknown("No asset groups in scope.", [ev("table", "assetGroups")]);
      // D11: a group with zero synced asset rows is unknown — never "full" and
      // never "feed-only" (feed-only by design and not fetched are the same zero).
      const notKnown = groups.filter((g) => !g.attrs.assetsKnown);
      if (notKnown.length === groups.length)
        return unknown(
          `Asset completeness unknown for ${groups.length} asset group(s): ${assetsUnknownReason()}.`,
          [ev("metric", "P.ag_asset_count")],
        );
      const spending = groups.filter((g) => g.attrs.assetsKnown && (g.windows.m90.cost ?? 0) > 0);
      const feedOnly = spending.filter((g) => g.attrs.isFeedOnly === true);
      const judged = spending.filter((g) => g.attrs.isFeedOnly === false);
      const thin = judged.filter(
        (g) =>
          (g.attrs.assetCounts.HEADLINE ?? 0) < 11 || (g.attrs.assetCounts.DESCRIPTION ?? 0) < 4,
      );
      if (thin.length > 0) {
        return explains(
          `${thin.length} spending asset group(s) are short of the asset targets (worst: "${thin[0]!.name}" with ${thin[0]!.attrs.assetCounts.HEADLINE ?? 0} headlines / ${thin[0]!.attrs.assetCounts.DESCRIPTION ?? 0} descriptions)${feedOnly.length ? `; ${feedOnly.length} further group(s) are feed-only by design and excluded` : ""}.`,
          [ev("metric", "P.ag_asset_count")],
        );
      }
      if (notKnown.length > 0)
        return unknown(
          `${judged.length} spending asset group(s) with known assets carry a full asset set, but ${notKnown.length} group(s) could not be judged — ${assetsUnknownReason()}.`,
          [ev("metric", "P.ag_asset_count")],
        );
      return cleared(
        `Every spending asset group carries a full asset set (${judged.length} judged, ${feedOnly.length} feed-only by design).`,
        [ev("metric", "P.ag_asset_count")],
      );
    },
  },

  PX05: {
    question: "Is this product actually inside an included listing group, or excluded from PMax?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { product, campaign } = locate(ctx);
      if (product) {
        return product.attrs.assetGroupsIncludingMe.length === 0
          ? explains(
              `"${product.name}" resolves into no included listing group — PMax is not allowed to buy it, so its spend is not a PMax product problem.`,
              [ev("node", product.id, product.name), ev("metric", "P.listing_included")],
            )
          : cleared(
              `"${product.name}" sits inside ${product.attrs.assetGroupsIncludingMe.length} included listing group(s).`,
              [ev("metric", "P.listing_included")],
            );
      }
      const groups = campaign
        ? campaign.children.assetGroups
        : ctx.model.children.campaigns.flatMap((c) => c.children.assetGroups);
      if (groups.length === 0)
        return unknown("No asset groups in scope — listing-group inclusion is not checkable.", [
          ev("table", "pmaxListingGroups"),
        ]);
      const excluded = groups.reduce((s, g) => s + g.attrs.listingGroupCounts.excluded, 0);
      const included = groups.reduce((s, g) => s + g.attrs.listingGroupCounts.included, 0);
      return excluded > 0
        ? explains(
            `${excluded} listing-group leaves are excluded against ${included} included — part of the catalogue cannot serve.`,
            [ev("metric", "P.listing_included")],
          )
        : cleared(`No listing-group exclusions (${included} included leaves).`, [
            ev("metric", "P.listing_included"),
          ]);
    },
  },

  PX06: {
    question:
      "Does the asset group carry the audience signals and search themes this judgement assumes?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { assetGroup, campaign } = locate(ctx);
      // Round 4 item 5: a campaign's groups count only when they and the campaign are live
      const groups = assetGroup
        ? [assetGroup]
        : campaign
          ? liveAssetGroupsOf(campaign)
          : ctx.model.children.campaigns.flatMap((c) => liveAssetGroupsOf(c));
      if (groups.length === 0)
        return unknown("No asset groups in scope.", [ev("table", "assetGroups")]);
      const spendingAll = groups.filter((g) => (g.windows.m90.cost ?? 0) > 0);
      // D11 (B2): a group with zero signal rows of either kind is unknown — never "bare".
      const notKnown = spendingAll.filter((g) => !g.attrs.signalsKnown);
      const spending = spendingAll.filter((g) => g.attrs.signalsKnown);
      if (spending.length === 0 && spendingAll.length > 0)
        return unknown(
          `Signals unknown for ${spendingAll.length} spending asset group(s): ${signalsUnknownReason()}.`,
          [ev("metric", "P.ag_search_themes")],
        );
      const bare = spending.filter(
        (g) => g.children.searchThemes.length === 0 || g.children.audienceSignals.length === 0,
      );
      if (bare.length > 0)
        return explains(
          `${bare.length} spending asset group(s) carry no search themes or no audience signals (e.g. "${bare[0]!.name}")${notKnown.length ? `; ${notKnown.length} further group(s) could not be judged — ${signalsUnknownReason()}` : ""}.`,
          [ev("metric", "P.ag_search_themes")],
        );
      if (notKnown.length > 0)
        return unknown(
          `${spending.length} spending asset group(s) with known signals carry audience signals and search themes, but ${notKnown.length} group(s) could not be judged — ${signalsUnknownReason()}.`,
          [ev("metric", "P.ag_search_themes")],
        );
      return cleared(
        `Each spending asset group with known signals carries audience signals and search themes (${spending.length} checked).`,
        [ev("metric", "P.ag_search_themes")],
      );
    },
  },

  PX09: {
    question:
      "Is Google rating these asset groups POOR or AVERAGE, which would explain the delivery?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { assetGroup, campaign } = locate(ctx);
      const groups = assetGroup
        ? [assetGroup]
        : campaign
          ? liveAssetGroupsOf(campaign)
          : ctx.model.children.campaigns.flatMap((c) => liveAssetGroupsOf(c));
      const spending = groups.filter((g) => (g.windows.m90.cost ?? 0) > 0);
      if (spending.length === 0)
        return unknown("No spending asset group in scope.", [ev("table", "assetGroups")]);
      const rated = spending.filter((g) => g.attrs.adStrength != null);
      if (rated.length === 0)
        return unknown("No asset group in scope reports an ad strength.", [
          ev("metric", "P.ag_ad_strength"),
        ]);
      const weak = rated.filter((g) =>
        ["POOR", "AVERAGE"].includes(String(g.attrs.adStrength).toUpperCase()),
      );
      return weak.length > 0
        ? explains(
            `${weak.length} of ${rated.length} spending asset group(s) rate POOR or AVERAGE.`,
            [ev("metric", "P.ag_ad_strength")],
          )
        : cleared(`Every spending asset group rates Good or better (${rated.length} checked).`, [
            ev("metric", "P.ag_ad_strength"),
          ]);
    },
  },

  SH01: {
    question: "Is the feed itself the problem (disapproved products cannot serve)?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { product } = locate(ctx);
      if (product) {
        const s = String(product.attrs.mcStatus ?? "").toLowerCase();
        if (product.attrs.mcStatus == null)
          return unknown(
            `"${product.name}" has no Merchant Center status — it is not matched to the feed.`,
            [ev("metric", "Pr.mc_status")],
          );
        return s.includes("disapprov")
          ? explains(
              `"${product.name}" is ${product.attrs.mcStatus} in Merchant Center — it cannot serve, so this is a feed finding.`,
              [ev("metric", "Pr.mc_status")],
            )
          : cleared(`"${product.name}" is ${product.attrs.mcStatus} in Merchant Center.`, [
              ev("metric", "Pr.mc_status"),
            ]);
      }
      const products = ctx.model.children.products;
      const withStatus = products.filter((p) => p.attrs.mcStatus != null);
      if (withStatus.length === 0)
        return unknown(
          "No product carries a Merchant Center status — feed health is not checkable.",
          [ev("table", "products")],
        );
      const disapproved = withStatus.filter((p) =>
        String(p.attrs.mcStatus).toLowerCase().includes("disapprov"),
      ).length;
      const rate = (disapproved / withStatus.length) * 100;
      return rate > ctx.thresholds.feedDisapprovalPct
        ? explains(
            `${disapproved} of ${withStatus.length} products with a status are disapproved (${n2(rate)}%) — the feed is the cause.`,
            [ev("metric", "F.feed_valid_rate")],
          )
        : cleared(
            `${disapproved} of ${withStatus.length} products with a status are disapproved (${n2(rate)}%); ${products.length - withStatus.length} rows are not matched to Merchant Center and are excluded from the denominator.`,
            [ev("metric", "F.feed_valid_rate")],
          );
    },
  },

  SH02: {
    question: "Are there Merchant Center account issues behind this?",
    onExplains: "transform",
    resolve: (ctx) => {
      const t = tableState(ctx, "mcAccountIssues");
      if (t.rows === 0 && t.checkable !== "ok")
        return unknown(
          "mc_account_issues has no rows and no sync marker — account issues cannot be ruled out.",
          [ev("table", "mcAccountIssues")],
        );
      const n = ctx.model.attrs.merchantCenter.accountIssues;
      return n > 0
        ? explains(`${n} Merchant Center account issue(s) are open.`, [
            ev("metric", "F.mc_issue_count"),
          ])
        : cleared("No Merchant Center account issues.", [ev("metric", "F.mc_issue_count")]);
    },
  },

  SH04: {
    question: "Is product-level waste already the explanation here?",
    onExplains: "transform",
    resolve: (ctx) => {
      const floor = wasteFloor(ctx);
      const products = ctx.model.children.products;
      if (products.length === 0) return unknown("No products synced.", [ev("table", "products")]);
      const waste = products.filter(
        (p) => (p.windows.m90.cost ?? 0) >= floor && (p.windows.m90.conv ?? 0) === 0,
      );
      const cost = waste.reduce((s, p) => s + (p.windows.m90.cost ?? 0), 0);
      return waste.length > 0
        ? explains(
            `${waste.length} product(s) spend ${n2(cost)} past the ${floor} floor without a sale.`,
            [ev("metric", "Pr.spend"), ev("metric", "T.waste_floor")],
          )
        : cleared(`No product spends past the ${floor} floor without a sale.`, [
            ev("metric", "T.waste_floor"),
          ]);
    },
  },

  SH05: {
    question:
      "Are there products already returning far above the account, so the money has a better home?",
    onExplains: "transform",
    resolve: (ctx) => {
      const accountRoas = ctx.model.windows.m90.roas;
      if (accountRoas == null)
        return unknown("Account ROAS could not be computed.", [ev("metric", "A.roas")]);
      const winners = ctx.model.children.products.filter(
        (p) => (p.windows.m90.conv ?? 0) >= 10 && (p.windows.m90.roas ?? 0) >= 2 * accountRoas,
      );
      return winners.length > 0
        ? explains(
            `${winners.length} product(s) return at least 2× the account ${n2(accountRoas)}x on 10+ conversions.`,
            [ev("metric", "Pr.spend"), ev("metric", "A.roas")],
          )
        : cleared(
            `No product both clears 10 conversions and returns 2× the account ${n2(accountRoas)}x.`,
            [ev("metric", "A.roas")],
          );
    },
  },

  SH06: {
    question: "Are required product attributes missing, so the feed cannot carry this anyway?",
    onExplains: "transform",
    resolve: (ctx) => {
      const products = ctx.model.children.products;
      if (products.length === 0) return unknown("No products synced.", [ev("table", "products")]);
      const missing = products.filter((p) => p.attrs.missingAttrs.length > 0).length;
      const share = missing / products.length;
      return share > 0.2
        ? explains(
            `${missing} of ${products.length} products (${pct(share)}) are missing gtin / colour / size — the feed cannot describe them.`,
            [ev("metric", "Pr.missing_attrs")],
          )
        : cleared(
            `${missing} of ${products.length} products (${pct(share)}) are missing a required attribute.`,
            [ev("metric", "Pr.missing_attrs")],
          );
    },
  },

  SH08: {
    question: "Did a Merchant Center promotion start or end inside this window?",
    onExplains: "transform",
    resolve: (ctx) => {
      const p = ctx.model.attrs.merchantCenter.promotions;
      if (p.total === 0)
        return cleared("No Merchant Center promotions on this account.", [
          ev("table", "mcPromotions"),
        ]);
      // Round 4 item 10: the sync carries each promotion's name and dates now — use them
      const dated = p.dated ?? [];
      const { start, end } = ctx.model.window;
      if (
        dated.length === p.total &&
        start &&
        end &&
        dated.every((d) => d.start != null || d.end != null)
      ) {
        const inside = dated.filter(
          (d) => (d.start ?? "0000-00-00") <= end && (d.end ?? "9999-12-31") >= start,
        );
        if (inside.length === 0)
          return cleared(
            `None of the ${p.total} Merchant Center promotions ran inside the window (${start} to ${end}).`,
            [ev("table", "mcPromotions")],
          );
        const named = inside
          .slice(0, 3)
          .map((d) => `"${d.title}" (${d.start ?? "no start date"} to ${d.end ?? "no end date"})`)
          .join(", ");
        return unknown(
          `${inside.length} Merchant Center promotion(s) ran inside the window: ${named}${inside.length > 3 ? ` and ${inside.length - 3} more` : ""} — a change in sales around those dates may be the promotion.`,
          [ev("metric", "F.promotions_live"), ev("table", "mcPromotions")],
        );
      }
      return unknown(
        `${p.total} Merchant Center promotions exist (${p.live} live, ${p.expired} expired, ${p.stopped} stopped) and their dates are not carried on the model — a promotion moving conversion value inside the window cannot be ruled out.`,
        [ev("metric", "F.promotions_live"), ev("table", "mcPromotions")],
      );
    },
  },

  SH15: {
    question: "Do the three feed sources agree on feed health before anything is claimed about it?",
    onExplains: "transform",
    resolve: (ctx) => {
      const feeds = ctx.model.attrs.merchantCenter.feeds;
      const products = ctx.model.children.products;
      const withStatus = products.filter((p) => p.attrs.mcStatus != null);
      const shopping = products.filter((p) => p.attrs.shopping?.status != null);
      const sources: string[] = [];
      let feedValid: number | null = null;
      if (feeds.itemsTotal != null && feeds.itemsTotal > 0 && feeds.itemsInvalid != null) {
        feedValid = 1 - feeds.itemsInvalid / feeds.itemsTotal;
        sources.push(`feed_diagnostics ${pct(feedValid)} valid`);
      }
      let productValid: number | null = null;
      if (withStatus.length > 0) {
        productValid =
          withStatus.filter((p) => !String(p.attrs.mcStatus).toLowerCase().includes("disapprov"))
            .length / withStatus.length;
        sources.push(`products ${pct(productValid)} approved of ${withStatus.length}`);
      }
      let shoppingValid: number | null = null;
      if (shopping.length > 0) {
        shoppingValid =
          shopping.filter((p) =>
            String(p.attrs.shopping!.status).toLowerCase().includes("eligible"),
          ).length / shopping.length;
        sources.push(`shopping_products ${pct(shoppingValid)} eligible of ${shopping.length}`);
      }
      const known = [feedValid, productValid, shoppingValid].filter((v): v is number => v != null);
      if (known.length < 2)
        return unknown(
          `Fewer than two feed sources have rows (${sources.join("; ") || "none"}) — feed health cannot be cross-checked.`,
          [ev("table", "products")],
        );
      const spread = Math.max(...known) - Math.min(...known);
      return spread > 0.1
        ? explains(
            `The feed sources disagree: ${sources.join("; ")}. Every feed-derived claim is blocked until they agree.`,
            [
              ev("table", "feedDiagnostics"),
              ev("table", "products"),
              ev("table", "shoppingProductsData"),
            ],
          )
        : cleared(`The feed sources agree within ${pct(spread)}: ${sources.join("; ")}.`, [
            ev("table", "products"),
          ]);
    },
  },

  // --- B.7 slices ----------------------------------------------------------

  SL01: {
    question: "Is an audience segment carrying the cost this claim is about?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const slices = (campaign ? campaign.children.slices : ctx.model.children.slices).audience;
      if (slices.length === 0)
        return unknown("No audience performance rows at this scope.", [
          ev("table", "audiencePerformance"),
        ]);
      const scopeCpa = (campaign ?? ctx.model).windows.m90.cpa;
      if (scopeCpa == null)
        return unknown("Scope CPA could not be computed.", [ev("metric", "A.cpa")]);
      const bad = slices.filter(
        (s) =>
          (s.windows.m90.clicks ?? 0) >= ctx.thresholds.sliceMinClicks &&
          (s.windows.m90.cpa ?? 0) > ctx.thresholds.sliceCpaMultiple * scopeCpa,
      );
      return bad.length > 0
        ? explains(
            `${bad.length} audience segment(s) cost more than ${ctx.thresholds.sliceCpaMultiple}× the scope CPA of ${n2(scopeCpa)} (worst "${bad[0]!.attrs.key}" at ${n2(bad[0]!.windows.m90.cpa)}).`,
            [ev("metric", "SL.audience")],
          )
        : cleared(
            `No audience segment above the click floor costs more than ${ctx.thresholds.sliceCpaMultiple}× the scope CPA of ${n2(scopeCpa)}.`,
            [ev("metric", "SL.audience")],
          );
    },
  },

  SL03: {
    question: "Is a country dragging this number?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const slices = (campaign ? campaign.children.slices : ctx.model.children.slices).geo;
      if (slices.length <= 1)
        return unknown(
          `geographic_data holds ${slices.length} country row(s) at this scope — a single-country account has nothing to compare.`,
          [ev("table", "geographicData")],
        );
      const accountRoas = ctx.model.windows.m90.roas;
      if (accountRoas == null)
        return unknown("Account ROAS could not be computed.", [ev("metric", "A.roas")]);
      const bad = slices.filter(
        (s) =>
          (s.windows.m90.clicks ?? 0) >= ctx.thresholds.sliceMinClicks &&
          (s.windows.m90.roas ?? 0) < 0.5 * accountRoas,
      );
      return bad.length > 0
        ? explains(
            `${bad.length} country/countries return under half the account ${n2(accountRoas)}x (worst "${bad[0]!.attrs.key}" at ${n2(bad[0]!.windows.m90.roas)}x).`,
            [ev("metric", "SL.geo")],
          )
        : cleared(
            `Every country above the click floor returns in line with the account ${n2(accountRoas)}x.`,
            [ev("metric", "SL.geo")],
          );
    },
  },

  SL04: {
    question:
      "Is the campaign targeting presence-or-interest, widening the pool beyond the geography named?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the geo-target-type check.");
      const t = campaign.attrs.geoTargetType;
      if (t == null)
        return unknown(`${campaign.name} reports no geo target type.`, [
          ev("metric", "C.geo_target_type", campaign.name),
        ]);
      return String(t).toUpperCase().includes("INTEREST")
        ? explains(
            `${campaign.name} targets ${t} — people outside the targeted area are being bought.`,
            [ev("metric", "C.geo_target_type", campaign.name)],
          )
        : cleared(`${campaign.name} targets ${t}.`, [
            ev("metric", "C.geo_target_type", campaign.name),
          ]);
    },
  },

  SL05: {
    question: "Is one device costing materially more per sale at this scope?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const slices = (campaign ? campaign.children.slices : ctx.model.children.slices).device;
      if (slices.length === 0)
        return unknown("No device rows at this scope.", [ev("table", "deviceData")]);
      const scopeCpa = (campaign ?? ctx.model).windows.m90.cpa;
      if (scopeCpa == null)
        return unknown("Scope CPA could not be computed.", [ev("metric", "A.cpa")]);
      const bad = slices.filter(
        (s) =>
          (s.windows.m90.clicks ?? 0) >= ctx.thresholds.deviceMinClicks &&
          ((s.windows.m90.conv ?? 0) === 0 ||
            (s.windows.m90.cpa ?? 0) >= ctx.thresholds.sliceCpaMultiple * scopeCpa),
      );
      return bad.length > 0
        ? explains(
            `${bad.map((s) => s.attrs.key).join(", ")} cost at least ${ctx.thresholds.sliceCpaMultiple}× the scope CPA of ${n2(scopeCpa)} at this scope.`,
            [ev("metric", "SL.device_cpa_multiple")],
          )
        : cleared(
            `No device above the ${ctx.thresholds.deviceMinClicks}-click floor costs ${ctx.thresholds.sliceCpaMultiple}× the scope CPA of ${n2(scopeCpa)}.`,
            [ev("metric", "SL.device_cpa_multiple")],
          );
    },
  },

  SL06: {
    question: "Is a device slice spending past the waste floor with no conversions?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const slices = (campaign ? campaign.children.slices : ctx.model.children.slices).device;
      if (slices.length === 0)
        return unknown("No device rows at this scope.", [ev("table", "deviceData")]);
      const floor = wasteFloor(ctx);
      const bad = slices.filter(
        (s) =>
          (s.windows.m90.conv ?? 0) === 0 &&
          (s.windows.m90.cost ?? 0) >= floor &&
          (s.windows.m90.clicks ?? 0) >= ctx.thresholds.deviceMinClicks,
      );
      return bad.length > 0
        ? explains(
            `${bad.map((s) => `${s.attrs.key} (${n2(s.windows.m90.cost)}, ${s.windows.m90.clicks} clicks, 0 conv)`).join("; ")} at ${campaign ? campaign.name : "account"} scope.`,
            [ev("metric", "SL.device")],
          )
        : cleared(
            `No device slice at ${campaign ? campaign.name : "account"} scope clears the ${floor} floor and the ${ctx.thresholds.deviceMinClicks}-click floor with zero conversions.`,
            [ev("metric", "SL.device")],
          );
    },
  },

  SL08: {
    question: "Are the day and hour numbers marginals of the same money rather than cells?",
    onExplains: "transform",
    resolve: (ctx) => {
      const f = ctx.model.children.slices;
      if (f.dowHour.length > 0)
        return cleared(
          `temporal_grid holds ${f.dowHour.length} crossed cells — day × hour is a real cell.`,
          [ev("table", "temporalGrid")],
        );
      if (f.dow.length > 0 && f.hour.length > 0) {
        return explains(
          `temporal_grid is empty while temporal_data holds ${f.dow.length} day rows and ${f.hour.length} hour rows — the same money twice. They must never be crossed or summed.`,
          [ev("table", "temporalData"), ev("table", "temporalGrid")],
        );
      }
      return unknown("No temporal rows at all — schedule claims are not checkable.", [
        ev("table", "temporalData"),
      ]);
    },
  },

  // --- B.8 trends and change ------------------------------------------------

  TR01: {
    question: "Which way is this entity actually moving across the two 30-day windows?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const node = campaign ?? ctx.model;
      const recent = node.windows.m30?.roas ?? null;
      const prior = node.windows.mPrior30?.roas ?? null;
      if (recent == null || prior == null || prior === 0)
        return unknown(
          `${campaign ? campaign.name : "The account"} has no comparable 30v30 series.`,
          [ev("window", "m30"), ev("window", "mPrior30")],
        );
      const move = ((recent - prior) / prior) * 100;
      return move < -ctx.thresholds.declinePct
        ? explains(
            `${campaign ? campaign.name : "The account"} moved ${n2(move)}% on ROAS (${n2(prior)}x → ${n2(recent)}x) across the two 30-day windows.`,
            [ev("window", "m30"), ev("window", "mPrior30")],
          )
        : cleared(
            `${campaign ? campaign.name : "The account"} moved ${n2(move)}% on ROAS (${n2(prior)}x → ${n2(recent)}x).`,
            [ev("window", "m30"), ev("window", "mPrior30")],
          );
    },
  },

  /** Scaling a declining campaign is the error the direction check exists to stop. */
  "TR01@scale": {
    question: "Is this campaign declining, so more money would follow a falling return?",
    onExplains: "drop",
    resolve: (ctx) => {
      const r = R.TR01!.resolve(ctx);
      if (r.state === "explains")
        return {
          ...r,
          note: `${r.note} Scaling a declining campaign buys the decline.`,
          effect: "drop",
        };
      return r;
    },
  },

  TR02: {
    question: "Has the latest settled week already recovered, so the decline is history?",
    onExplains: "drop",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const node = campaign ?? ctx.model;
      const settled = node.windows.settledWeek?.roas ?? null;
      const prior = node.windows.mPrior30?.roas ?? null;
      const recent = node.windows.m30?.roas ?? null;
      if (settled == null || prior == null || prior === 0) {
        return unknown(
          `${campaign ? campaign.name : "The account"} has no settled-week series to test the recovery against.`,
          [ev("window", "settledWeek")],
        );
      }
      const vsPrior = ((settled - prior) / prior) * 100;
      const label = `latest settled week ${n2(settled)}x vs prior 30 days ${n2(prior)}x${recent == null ? "" : ` (recent 30 days ${n2(recent)}x)`}`;
      return vsPrior >= -ctx.thresholds.declinePct
        ? explains(
            `Recovered: ${label} — the decline is not the current state, and any trend claim must print the settled week.`,
            [ev("window", "settledWeek"), ev("window", "mPrior30")],
          )
        : cleared(`No recovery: ${label}.`, [
            ev("window", "settledWeek"),
            ev("window", "mPrior30"),
          ]);
    },
  },

  TR03: {
    question:
      "Is there a dated change (budget, target, status, negatives, ads) that explains the move?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      const feed = ctx.model.attrs.changeHistory;
      if (feed.rows === 0)
        return unknown(
          "No change_history rows — a dated cause can neither be found nor ruled out.",
          [ev("table", "changeHistory")],
        );
      // §B's detector is "a change within ±3 days of a STEP in the daily
      // series". No step metric exists, and CampaignAttrs.changeHistory carries
      // counts + first/last date only — no per-change dates or fields. A change
      // count above zero is therefore not evidence of causation: say unknown.
      const ch = campaign?.attrs.changeHistory;
      if (ch && ch.count > 0) {
        return unknown(
          `${ch.count} change(s) are recorded against ${campaign!.name} between ${ch.firstDate} and ${ch.lastDate}, but no step detector and no per-change dates exist, so none of them can be tied to this move. A dated cause can neither be confirmed nor ruled out.`,
          [ev("table", "changeHistory"), ev("node", campaign!.id, campaign!.name)],
        );
      }
      if (feed.sample) {
        return unknown(
          `change_history is capped at ${feed.cap} rows and covers only ${feed.firstDate}..${feed.lastDate} of the ${ctx.model.window.days}-day window — "no dated cause" cannot be concluded.`,
          [ev("metric", "A.change_days_covered"), ev("table", "changeHistory")],
        );
      }
      return cleared("No dated change explains the move.", [ev("table", "changeHistory")]);
    },
  },

  TR04: {
    question: "Is this seasonal (same weeks a year ago)?",
    onExplains: "transform",
    // Phase 11b: the same weeks a year ago are synced (account_daily_prior_year).
    // Account level only: the year-ago rows are account totals, so TR01a is answered and TR01 (campaign) stays unknown.
    resolve: (ctx) => {
      // review fix: the year-ago rows are ACCOUNT totals; an account move is no answer for one campaign (TR01)
      if (ctx.scope.kind !== "account")
        return unknown(
          "Seasonality is judged on account totals only; there are no year-ago rows for a single campaign.",
          [ev("table", "account_daily_prior_year")],
        );
      const s = seasonalityOf(ctx.model, SEASONAL_MIN_CONV);
      if (s.state !== "ok")
        return unknown(`Seasonality cannot be judged: ${s.reason}.`, [
          ev("table", "account_daily_prior_year"),
        ]);
      const what = s.metric === "roas" ? "Account return" : "Account conversions";
      const line = `${what} moved ${n2(s.thisYear.changePct)}% between the last two 30-day windows; the same weeks a year ago moved ${n2(s.lastYear.changePct)}%`;
      return s.explains
        ? explains(`${line}, so the move is at least partly seasonal.`, [
            ev("table", "account_daily_prior_year"),
            ev("table", "dailyMetrics"),
          ])
        : cleared(`${line}, so seasonality does not explain it.`, [
            ev("table", "account_daily_prior_year"),
            ev("table", "dailyMetrics"),
          ]);
    },
  },

  TR05: {
    question: "Is this a paused campaign with a converting history, rather than dead weight?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the dormant check.");
      const paused = String(campaign.status ?? "").toUpperCase() === "PAUSED";
      const conv = campaign.windows.m90.conv ?? 0;
      return paused && conv >= convFloor(ctx)
        ? explains(
            `${campaign.name} is paused with ${n2(conv)} conversions in the window — a dormant winner, not dead weight.`,
            [ev("node", campaign.id, campaign.name)],
          )
        : cleared(
            `${campaign.name} is ${campaign.status ?? "of unknown status"} with ${n2(conv)} conversions in the window.`,
            [ev("node", campaign.id, campaign.name)],
          );
    },
  },

  TR06: {
    question: "Is this campaign spending with zero conversions on enough clicks to be sure?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { campaign } = locate(ctx);
      if (!campaign) return unknown("No campaign in scope for the zombie check.");
      const conv = campaign.windows.m90.conv ?? 0;
      const clicks = campaign.windows.m90.clicks ?? 0;
      return conv === 0 && clicks >= ctx.thresholds.zombieMinClicks
        ? explains(
            `${campaign.name} took ${clicks} clicks and ${n2(campaign.windows.m90.cost)} spend with zero conversions.`,
            [ev("node", campaign.id, campaign.name)],
          )
        : cleared(`${campaign.name}: ${n2(conv)} conversions on ${clicks} clicks.`, [
            ev("node", campaign.id, campaign.name),
          ]);
    },
  },

  // --- X_* rules from spec §8.3 that are not themselves checks ---------------

  X_MATCH_TYPE: {
    question: "Is the match type of the keyword that triggered this query known?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { searchTerm, keyword } = locate(ctx);
      if (keyword) {
        return keyword.attrs.matchType == null
          ? unknown(`Keyword "${keyword.attrs.text}" reports no match type.`, [
              ev("metric", "K.match_type"),
            ])
          : cleared(`Keyword "${keyword.attrs.text}" is ${keyword.attrs.matchType} match.`, [
              ev("metric", "K.match_type"),
            ]);
      }
      if (!searchTerm)
        return unknown("No search term or keyword in scope to resolve a match type for.");
      if (searchTerm.attrs.matchSource === "unresolved") {
        // `unknown` already blocks STRONG (§8.4 rule 7) — no separate cap needed.
        return unknown(
          `The keyword that triggered "${searchTerm.attrs.term}" is unresolvable: search_terms.keyword_criterion_id is null on every row, so the match type behind the query is unknown and confidence cannot exceed MODERATE.`,
          [ev("table", "searchTerms"), ev("metric", "T.matched_keyword")],
        );
      }
      return cleared(
        `"${searchTerm.attrs.term}" resolves to keyword ${searchTerm.attrs.matchedKeywordId} (${searchTerm.attrs.matchType ?? "match type unknown"}).`,
        [ev("metric", "T.matched_keyword")],
      );
    },
  },

  X_SCOPE_BOTH: {
    question:
      "Does this slice belong to the scope the finding names, with the other scope computed?",
    onExplains: "transform",
    resolve: (ctx) => {
      const slice = findSlice(ctx);
      const parsed = ctx.scope.id ? parseSliceId(ctx.scope.id) : null;
      const dim = (ctx.scope.dimension ?? parsed?.dimension) as SliceDimension | undefined;
      const key = ctx.scope.key ?? parsed?.key ?? null;
      if (!slice || !dim || key == null)
        return unknown("No slice in scope — the campaign/account pairing cannot be computed.");
      const atCampaign = (ctx.scope.campaignId ?? parsed?.campaignId) != null;
      const keys = sliceKeysOf(key);
      if (keys.length > 1) {
        // a SET of slices judged as one decision: the pairing is asked of every key,
        // and the f15 protection still has to hold for each one of them.
        const label = keys.join(", ");
        const accountSlices = keys.map(
          (k) => ctx.model.children.slices[dim]?.find((s) => s.attrs.key === k) ?? null,
        );
        if (atCampaign) {
          if (accountSlices.some((a) => a == null)) {
            return unknown(
              `The account-level ${dim} set "${label}" is incomplete — the other scope could not be computed.`,
              [ev("metric", `SL.${dim}`)],
            );
          }
          const accCost = accountSlices.reduce((t, a) => t + (a!.windows.m90.cost ?? 0), 0);
          const accConv = accountSlices.reduce((t, a) => t + (a!.windows.m90.conv ?? 0), 0);
          return cleared(
            `Campaign scope named; the account ${dim} set "${label}" is ${n2(accCost)} / ${n2(accConv)} conv and travels with the finding as counter-context.`,
            [ev("metric", `SL.${dim}`)],
          );
        }
        const setFloor = wasteFloor(ctx);
        for (const k of keys) {
          const acc = ctx.model.children.slices[dim]?.find((s) => s.attrs.key === k) ?? null;
          const owners = campaignSlices(ctx, dim, k).filter(
            (s) =>
              (s.slice.windows.m90.conv ?? 0) === 0 && (s.slice.windows.m90.cost ?? 0) >= setFloor,
          );
          if (owners.length > 0 && (acc?.windows.m90.conv ?? 0) > 0) {
            const o = owners[0]!;
            return explains(
              `At account scope ${dim} "${k}" converts (${n2(acc!.windows.m90.conv)} conv, ${n2(acc!.windows.m90.roas)}x on ${n2(acc!.windows.m90.cost)}); the zero-conversion spend is ${o.campaign.name} (${n2(o.slice.windows.m90.cost)}, ${o.slice.windows.m90.clicks} clicks). The finding belongs to that campaign and its title must name it.`,
              [
                ev("node", o.slice.id, `${o.campaign.name} ${dim} ${k}`),
                ev("node", acc!.id, `account ${dim} ${k}`),
              ],
            );
          }
        }
        return cleared(
          `the ${dim} set "${label}" is not owned by a single campaign; the account scope is the right one and both scopes are computed.`,
          [ev("metric", `SL.${dim}`)],
        );
      }
      const siblings = campaignSlices(ctx, dim, key);
      if (atCampaign) {
        const account = ctx.model.children.slices[dim]?.find((s) => s.attrs.key === key) ?? null;
        return account == null
          ? unknown(
              `The account-level ${dim} "${key}" slice does not exist — the other scope could not be computed.`,
              [ev("metric", `SL.${dim}`)],
            )
          : cleared(
              `Campaign scope named; account ${dim} "${key}" is ${n2(account.windows.m90.cost)} / ${n2(account.windows.m90.conv)} conv / ${n2(account.windows.m90.roas)}x and travels with the finding as counter-context.`,
              [ev("node", account.id, `account ${dim} ${key}`), ev("metric", `SL.${dim}`)],
            );
      }
      // account scope: does one campaign own the signal?
      const floor = wasteFloor(ctx);
      const owners = siblings.filter(
        (s) => (s.slice.windows.m90.conv ?? 0) === 0 && (s.slice.windows.m90.cost ?? 0) >= floor,
      );
      const accountConv = slice.windows.m90.conv ?? 0;
      if (owners.length > 0 && accountConv > 0) {
        const o = owners[0]!;
        return explains(
          `At account scope ${dim} "${key}" converts (${n2(accountConv)} conv, ${n2(slice.windows.m90.roas)}x on ${n2(slice.windows.m90.cost)}); the zero-conversion spend is ${o.campaign.name} (${n2(o.slice.windows.m90.cost)}, ${o.slice.windows.m90.clicks} clicks). The finding belongs to that campaign and its title must name it.`,
          [
            ev("node", o.slice.id, `${o.campaign.name} ${dim} ${key}`),
            ev("node", slice.id, `account ${dim} ${key}`),
          ],
        );
      }
      const total = siblings.reduce((s, x) => s + (x.slice.windows.m90.cost ?? 0), 0);
      const top = siblings.sort(
        (a, b) => (b.slice.windows.m90.cost ?? 0) - (a.slice.windows.m90.cost ?? 0),
      )[0];
      if (
        top &&
        total > 0 &&
        (top.slice.windows.m90.cost ?? 0) / total >= ctx.thresholds.sliceScopeConcentration
      ) {
        return explains(
          `${pct((top.slice.windows.m90.cost ?? 0) / total)} of the ${dim} "${key}" spend sits in ${top.campaign.name} — an account-wide title would be false; scope it to that campaign.`,
          [ev("node", top.slice.id, `${top.campaign.name} ${dim} ${key}`)],
        );
      }
      return cleared(
        `${dim} "${key}" is spread across ${siblings.length} campaign(s); the account scope is the right one and both scopes are computed.`,
        [ev("metric", `SL.${dim}`)],
      );
    },
  },

  X_SAMPLE_FLOOR: {
    question: "Does this slice carry enough clicks to say anything?",
    onExplains: "drop",
    resolve: (ctx) => {
      const slices = findSlices(ctx);
      const slice = slices[0] ?? null;
      if (!slice) return unknown("No slice in scope — the sample floor could not be applied.");
      if (slices.length > 1) {
        // the floor belongs on the decision, and the decision is the whole set
        const setFloor = sliceClickFloor(ctx, slice.attrs.dimension);
        const setClicks = slices.reduce((t, s) => t + (s.windows.m90.clicks ?? 0), 0);
        const setLabel = slices.map((s) => s.attrs.key).join(", ");
        return setClicks < setFloor
          ? explains(
              `${slice.attrs.dimension} set "${setLabel}" has ${setClicks} clicks in total, below the ${setFloor}-click floor — insufficient data, not a finding.`,
              [ev("metric", `SL.${slice.attrs.dimension}`)],
            )
          : cleared(
              `${slice.attrs.dimension} set "${setLabel}" has ${setClicks} clicks in total, at or above the ${setFloor}-click floor.`,
              [ev("metric", `SL.${slice.attrs.dimension}`)],
            );
      }
      const floor = sliceClickFloor(ctx, slice.attrs.dimension);
      const clicks = slice.windows.m90.clicks ?? 0;
      return clicks < floor
        ? explains(
            `${slice.attrs.dimension} "${slice.attrs.key}" has ${clicks} clicks, below the ${floor}-click floor — insufficient data, not a finding.`,
            [ev("metric", `SL.${slice.attrs.dimension}`)],
          )
        : cleared(
            `${slice.attrs.dimension} "${slice.attrs.key}" has ${clicks} clicks, at or above the ${floor}-click floor.`,
            [ev("metric", `SL.${slice.attrs.dimension}`)],
          );
    },
  },

  X_SERVING_RULES: {
    question: "Do Google's per-type serving rules already explain the zero impressions?",
    onExplains: "drop",
    resolve: (ctx) => {
      const { extension } = locate(ctx);
      if (!extension) return unknown("No extension in scope for the serving-rule check.");
      const a = extension.attrs;
      const label = `${a.type} "${a.text ?? extension.name}" at ${a.level} level`;
      switch (a.servedStatus) {
        case "overridden":
          return explains(
            `${label} is overridden: ad-group assets of the same type hide it in ad group(s) ${a.overriddenInAdGroupIds.join(", ")} and it serves nowhere else. ${a.type} is an OVERRIDE type — the granular level replaces the higher one, so zero impressions here is the rule working, not a dead asset.`,
            [ev("node", extension.id, label), ev("metric", "S.ext_overridden")],
          );
        case "not_served_by_type":
          return explains(
            `${label} sits on a campaign type that never serves it (PMax and Shopping do not serve callouts, snippets or call assets) — zero impressions is expected.`,
            [ev("node", extension.id, label)],
          );
        case "served_despite_rule":
          return unknown(
            `${label} reports impressions on a campaign type Google says never serves it — recorded in dataQuality.contradictions; the serving rule and the data disagree.`,
            [ev("node", extension.id, label), ev("table", "adExtensions")],
          );
        case "served":
          return explains(
            `${label} has served (${extension.windows.m90.impressions} impressions) — it is not an unserved asset.`,
            [ev("node", extension.id, label)],
          );
        case "eligible_no_impressions":
        default:
          if (a.overrideClass === "UNKNOWN") {
            return unknown(
              `${label}: the level rule for ${a.type} is not documented, so an override cannot be ruled in or out.`,
              [ev("node", extension.id, label)],
            );
          }
          return cleared(
            `${label} is eligible and nothing overrides it${a.overrideClass === "CUMULATIVE" ? " (sitelinks are cumulative: an ad-group set adds to the campaign set, it does not replace it)" : ""} — the zero impressions are real.`,
            [ev("node", extension.id, label), ev("metric", "S.ext_impressions")],
          );
      }
    },
  },

  X_TARGET_AGE: {
    question: "How long ago was this bid target set?",
    onExplains: "transform",
    resolve: (ctx) => {
      const feed = ctx.model.attrs.changeHistory;
      return unknown(
        `The date a bid target was set is not modelled: change_history is carried as counts per campaign (${feed.rows} rows, ${feed.firstDate}..${feed.lastDate}${feed.sample ? ", capped" : ""}) with no changed-fields breakdown, so "the target is too new to judge" can neither be confirmed nor ruled out.`,
        [ev("table", "changeHistory")],
      );
    },
  },

  X_ACTION_STATUS: {
    question: "Is the conversion action enabled, or removed/hidden?",
    onExplains: "drop",
    resolve: (ctx) => {
      const { action } = locate(ctx);
      const actions = action
        ? [action]
        : ctx.model.children.conversionActions.filter((a) => a.attrs.isPrimary);
      if (actions.length === 0)
        return unknown("No conversion action in scope.", [ev("table", "conversionActions")]);
      const unknownStatus = actions.filter((a) => a.attrs.status == null);
      if (unknownStatus.length === actions.length) {
        return unknown(
          `conversion_actions.status is null on ${unknownStatus.length} action(s) — null is "not synced", never ENABLED.`,
          [ev("table", "conversionActions")],
        );
      }
      const off = actions.filter(
        (a) => a.attrs.status != null && String(a.attrs.status).toUpperCase() !== "ENABLED",
      );
      return off.length > 0
        ? explains(
            `${off.length} action(s) in scope are not ENABLED (${off.map((a) => `${a.name}: ${a.attrs.status}`).join(", ")}) — a zero there is the status, not a tracking break.`,
            [ev("table", "conversionActions")],
          )
        : cleared("Every conversion action in scope is ENABLED.", [
            ev("table", "conversionActions"),
          ]);
    },
  },

  X_PROMOTION: {
    question: "Was a promotion running inside this window, moving conversion value?",
    onExplains: "transform",
    resolve: (ctx) => {
      const mc = R.SH08!.resolve(ctx);
      if (mc.state !== "cleared") return mc;
      return R.SK18!.resolve(ctx);
    },
  },

  X_ITEM_OVERLAP: {
    question: "Is more than one campaign buying this item_id?",
    onExplains: "transform",
    resolve: (ctx) => {
      const { product } = locate(ctx);
      if (!product) {
        const overlaps = ctx.model.index.itemOverlap.filter(
          (o) => o.pmaxCampaignIds.length + o.shoppingCampaignIds.length > 1,
        );
        return overlaps.length > 0
          ? explains(
              `${overlaps.length} item(s) are bought by more than one campaign — per-campaign product numbers are not independent.`,
              [ev("table", "products")],
            )
          : cleared("No item is bought by more than one campaign.", [ev("table", "products")]);
      }
      const all = [...product.attrs.pmaxCampaignIds, ...product.attrs.shoppingCampaignIds];
      return all.length > 1
        ? explains(
            `"${product.name}" is included by ${all.length} campaigns (${all.join(", ")}) — they compete for the same item, so a single-campaign claim about it is not safe.`,
            [ev("node", product.id, product.name)],
          )
        : cleared(`"${product.name}" is bought by ${all.length} campaign(s).`, [
            ev("node", product.id, product.name),
          ]);
    },
  },
};

// ---------------------------------------------------------------------------
// the matrix: which X's each check must resolve first
// ---------------------------------------------------------------------------

/** entry = resolver key, optionally with the effect an `explains` has for THIS check. */
type Entry = string | { key: string; onExplains: ConfounderEffect };

/**
 * Confounders that every performance verdict carries (spec §3.2 row 1):
 * conversion tracking health, attribution model, window maturity, goal
 * overrides, value rules.
 */
const PERFORMANCE_BASE: Entry[] = ["MI01", "MI05", "MI08", "MI07", "MI04"];

/** Checks whose signal is a performance verdict (ROAS / CPA / conversions / decline). */
const PERFORMANCE_CHECKS = [
  "TR01",
  "TR01a",
  "TR06",
  "BB04",
  "BB05",
  "BB07",
  "SK01",
  "SK05",
  "SK20",
  "SK24",
  "SH04",
  "SH05",
  "SH18",
  "SH20",
  "PX01",
  "PX05",
  "PX07",
  "SL01",
  "SL03",
  "SL05",
  "SL06",
  "SL07",
  "SL09",
  "AS01",
  "AS12",
  "TR05",
  "TR07",
  "BB12",
  "SK02",
  "SK09",
];

/** Slice checks: rule 6 (both scopes) + rule 3 (sample floor) + modifiers. */
const SLICE_BASE: Entry[] = ["X_SCOPE_BOTH", "X_SAMPLE_FLOOR", "BB09"];

/** Checks whose subject IS a slice (SL02 and SL08 are account-level, not slices). */
const SLICE_CHECKS = ["SL01", "SL03", "SL05", "SL06", "SL07", "SL09", "SK22"];

/** Build sheet §B `confounders` columns, verbatim, plus the §8.3 rules that §B leaves implicit. */
const CHECK_CONFOUNDERS: Record<string, Entry[]> = {
  // B.1
  MI01: ["MI05", "MI07", "MI08", "TR02", "X_ACTION_STATUS", "TR01"],
  MI02: ["MI01", "MI05", "MI07"],
  MI03: ["MI02", "MI05"],
  MI04: ["MI05", "MI07"],
  MI05: ["MI02"],
  MI06: ["MI01", "MI05"],
  MI07: ["MI05"],
  MI12: [],
  MI13: ["MI03", "MI05"],
  // B.2
  AS01: ["MI01", "AS02", "PX02"],
  AS02: ["BB04"],
  AS03: ["BB01", "BB02"],
  AS04: [],
  AS06: ["TR06", "TR05"],
  AS08: ["SK06"],
  AS09: ["SL01"],
  AS12: ["AS01", "PX02"],
  // plan 5.2: who made the changes is read off a capped feed, and auto-apply changes have no human author
  AS13: ["AS11", "AS04"],
  // M18: a capped feed (AS11) makes the monthly count a sample
  AS24: ["AS11"],
  // R3.6c: the Google-made change list is read off the same capped feed
  AS14: ["AS11"],
  // R3.8: fragmentation is read off conversion counts, which mean nothing if tracking is silent
  AS16: ["MI01"],
  // B.3
  BB01: ["BB05", "BB02", "MI01"],
  BB02: ["AS03", "BB05"],
  BB03: ["SK02", "SK14"],
  BB04: ["MI01", "TR01"],
  BB05: ["MI01", "BB01", "TR01", "BB04", "X_TARGET_AGE"],
  BB06: ["AS02"],
  BB07: [
    { key: "BB05", onExplains: "transform" },
    "AS03",
    "BB09",
    "TR03",
    "SL04",
    "SK22",
    "MI01",
    { key: "TR01@scale", onExplains: "drop" },
    "SH01",
    { key: "BB02@scale", onExplains: "drop" },
  ],
  BB08: ["BB04"],
  // plan 5.2: value-based bidding reads the value the tag records — a silent
  // primary, a distorting value rule or a campaign goal override changes the answer
  BB14: ["MI01", "MI04", "MI07"],
  BB09: ["SL05", "SL06", "SL03", "SL08"],
  // R3.8: a "loose" target is judged on 30-day results — silent tracking or too few conversions change the answer
  BB16: ["MI01", "BB04"],
  BB10: [],
  BB11: ["TR01", "TR03"],
  BB12: ["BB02", "BB03", "SK02", "SK15"],
  BB13: ["AS06", "TR03", "AS11"],
  // B.4
  // A5 rule 34: branded searches are NEVER waste. SK07's brand-as-defensive-spend
  // resolver was wired to SK05/SK07 only; SK01 (the same claim about the keyword
  // rather than the query) could still price a brand keyword as waste. `drop`,
  // not `transform`: on brand there is no waste finding left to restate.
  SK01: ["MI01", "SK06", "SK02", "SK19", { key: "SK07", onExplains: "drop" }, "X_MATCH_TYPE"],
  SK02: ["SK14", "SK19", "BB03"],
  SK03: ["SK05", "SK07"],
  SK04: ["SK03"],
  // rule 34 again: SK05 already consulted SK07, but a `transform` left the waste
  // claim alive in a restated form. A brand query is defensive spend, full stop.
  SK05: [
    "MI01",
    "SK06",
    { key: "SK07", onExplains: "drop" },
    "SK10",
    "PX02@themes",
    "X_MATCH_TYPE",
  ],
  // R3.6e: zero conversions only mean waste while tracking fires
  SK27: ["MI01"],
  SK07: ["SK05", "PX02@themes"],
  // R3.8: sale rates and "proven" read off conversions only while tracking fires
  SK30: ["MI01"],
  SK31: ["MI01"],
  SK08: ["SK03"],
  SK09: ["SK03"],
  SK10: ["SK05"],
  SK11: ["SK15"],
  SK12: ["SK11", "SK14"],
  SK13: ["SK12"],
  SK14: ["SK12", "SK15"],
  SK16: ["SK17"],
  SK17: ["SK16", "X_SERVING_RULES"],
  SK18: ["SK17"],
  SK19: ["SK02", "SK20"],
  SK20: ["MI01", "SK02", "SK19"],
  SK22: ["SL05", "MI01", "SL08"],
  SK24: ["SK02", "SK14", "SK17", "SL05", "MI01"],
  SK25: ["SK03", "SK04"],
  // B.5
  PX01: ["SH01", "PX05", "PX03"],
  PX02: ["AS01", "SK07"],
  PX03: ["PX09", "PX06"],
  PX04: ["PX03"],
  PX05: ["SH01", "SH06", "PX01"],
  PX06: ["PX03", "PX09"],
  PX07: ["PX01"],
  // R3.6e: the placement roll-up leans on the same channel mix PX07 does
  PX16: ["PX01"],
  PX09: ["PX03", "PX06"],
  PX10: ["PX01"],
  PX13: ["PX03", "PX09"],
  // PMax waste beside the overlap route and the brand reading; zero sales mean waste only while tracking fires
  PX22: ["PX12", "PX02", "MI01"],
  // audit catch-up: a gate's 'no orders' means no sale only while tracking fires
  DG11: ["MI01"],
  // B.6
  SH01: [{ key: "SH15", onExplains: "drop" }, "SH02", "SH06"],
  SH02: ["SH01"],
  SH03: [{ key: "SH15", onExplains: "drop" }, "SH04", "PX05"],
  SH04: [
    { key: "SH15", onExplains: "drop" },
    "MI01",
    "SH01",
    "SH06",
    "PX05",
    "X_PROMOTION",
    "X_ITEM_OVERLAP",
  ],
  SH05: [{ key: "SH15", onExplains: "drop" }, "BB07", "SH01", "X_ITEM_OVERLAP"],
  SH06: [{ key: "SH15", onExplains: "drop" }, "SH01", "SH04"],
  SH08: ["SK18"],
  SH10: ["PX01", "X_ITEM_OVERLAP"],
  SH13: ["SH06", "SH15"],
  SH14: ["SH06", { key: "SH15", onExplains: "drop" }],
  SH18: ["SH15", "SH01", "MI01", "MI04"],
  SH19: ["SH15", "SH01", "PX05"],
  SH20: ["SH15", "SH01", "PX05"],
  SH27: ["SH15"],
  SH28: ["SH15"],
  SH29: ["SH15"],
  // B.7
  SL01: ["BB09", "MI01"],
  SL02: ["AS09"],
  SL03: ["SL04", "BB09"],
  SL04: ["SL03"],
  SL05: ["BB09", "MI01", "SL06"],
  SL06: ["SL05", "MI01", "TR06"],
  SL07: ["BB09", "MI01"],
  SL08: ["SK22"],
  SL09: ["BB09", "SL05", "MI01", "SK20"],
  // B.8
  // §B TR01: a recovered campaign trend is dropped; the account trend (TR01a)
  // is the one finding that must SURVIVE and print the recovery.
  // An experiment arm makes the finding about the experiment, it does not
  // delete an account-level trend — hence the explicit transform on AS06.
  TR01: [
    "MI01",
    "MI04",
    "MI05",
    "MI07",
    "MI08",
    { key: "TR02", onExplains: "drop" },
    "TR03",
    "TR04",
    "SH08",
    "SK18",
    { key: "AS06", onExplains: "transform" },
    "BB05",
  ],
  TR01a: [
    "MI01",
    "MI04",
    "MI05",
    "MI07",
    "MI08",
    { key: "TR02", onExplains: "transform" },
    "TR03",
    "TR04",
    "SH08",
    "SK18",
    { key: "AS06", onExplains: "transform" },
    "BB05",
  ],
  TR02: ["MI08"],
  // N10: a running experiment does not make a dated change untrue: like TR01, an experiment
  // arm is stated beside the change, never a reason to drop it (a live shop runs 2 experiments,
  // which dropped every account-wide TR03 line, the changes on paused campaigns among them)
  TR03: ["AS11", { key: "AS06", onExplains: "transform" }],
  TR05: ["AS06", "TR06"],
  TR06: ["MI01", "AS06", "TR05", "BB04"],
  TR07: ["AS01", "SK07"],
  // B3: a campaign whose return is falling is no strength to name
  TR08: [{ key: "TR01", onExplains: "drop" }],
  // R4: a tracking break, the unsettled recent days, a dated change or the season can each be
  // why sales fell; stated beside the numbers, never a reason to drop them
  TR09: ["MI01", "MI08", "TR03", "TR04"],
  // R16: a tracking break is why a return can read under $1 per $1; stated, never a drop.
  // MI08: the window runs past the conversion lookback, so recent sales are still coming in
  TR10: ["MI01", "MI08"],
  // B.9 / B.10
  PR01: ["TR06"],
  VD07: ["MI06"],
  // Phase 1h: declared by the check but never wired into this matrix, so they
  // vanished silently and the finding reported "every confounder cleared".
  DG01: ["MI07"],
  DG04: ["MI01"],
  DG16: ["MI01"],
  DG13: ["MI01"],
  DG06: ["TR06", "MI01", "SH01"],
  PX11: ["PX03", "PX05", "SH15"],
  PX12: ["PX02", "MI01"],
  SH12: ["SH15", "PX05"],
  SK23: ["SK05", "MI01"],
  VD01: ["MI06"],
  VD04: ["MI01", "MI05", "MI06"],
};

function entryKey(e: Entry): string {
  return typeof e === "string" ? e : e.key;
}
function entryEffect(e: Entry): ConfounderEffect | null {
  return typeof e === "string" ? null : e.onExplains;
}

function expand(): Confounder[] {
  const out: Confounder[] = [];
  const seen = new Set<string>();
  for (const [checkId, entries] of Object.entries(CHECK_CONFOUNDERS)) {
    const all: Entry[] = [...entries];
    if (PERFORMANCE_CHECKS.includes(checkId)) all.push(...PERFORMANCE_BASE);
    if (SLICE_CHECKS.includes(checkId)) all.push(...SLICE_BASE);
    for (const e of all) {
      const key = entryKey(e);
      const def = R[key];
      if (!def)
        throw new Error(
          `interaction matrix: ${checkId} names confounder "${key}" with no resolver`,
        );
      const confounderId = key.split("@")[0] ?? key;
      const id = `${checkId}:${key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        forCheck: checkId,
        confounderId,
        question: def.question,
        onExplains: entryEffect(e) ?? def.onExplains,
        resolve: def.resolve,
      });
    }
  }
  return out;
}

/** One entry per confounder relationship. */
export const INTERACTION_MATRIX: Confounder[] = expand();

const BY_CHECK = new Map<string, Confounder[]>();
for (const c of INTERACTION_MATRIX) {
  const list = BY_CHECK.get(c.forCheck) ?? [];
  list.push(c);
  BY_CHECK.set(c.forCheck, list);
}

/** The confounders a check must resolve before it may fire; [] when the check has none. */
export function confoundersFor(checkId: string): Confounder[] {
  return BY_CHECK.get(checkId) ?? [];
}

/** Every check id the matrix knows. */
export function checksWithConfounders(): string[] {
  return [...BY_CHECK.keys()].sort();
}

/** Every resolver key (for tests and coverage reporting). */
export function resolverKeys(): string[] {
  return Object.keys(R).sort();
}
