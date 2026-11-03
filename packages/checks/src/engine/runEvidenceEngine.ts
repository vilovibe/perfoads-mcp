// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The evidence engine runner.
 *
 * Builds the account model, builds the metric context, runs every shipped
 * check, resolves every fired finding's confounders, prices it, scores it, and
 * returns ranked `Candidate[]`. Nothing here calls a model, the network or a
 * clock-dependent API (the run date and the clock are inputs): the output is
 * structured evidence and only that, and the same input gives the same output.
 *
 * The invariants this file enforces itself:
 *   - no candidate is `critical` with an unresolved confounder;
 *   - every candidate has a claimKey, a scope and at least one evidence entry;
 *   - no candidate carries a dollar impact on a scope the formula could not map:
 *     an unmappable scope drops the finding and is logged, it NEVER falls
 *     through to account scope.
 */
import type { AccountData, Row } from "./shared/input.js";
import type { BusinessType } from "./shared/businessType.js";
import type { ClientContext } from "./shared/clientContext.js";
import { resolveSettings, type CheckSettingsInput } from "./settings.js";
import { currencyScale } from "./shared/currencyScale.js";
import { cmpStr } from "./shared/order.js";
import {
  createRefusalLog,
  makeMetricLookups,
  sliceKindForScope,
  toInteractionsScope,
  toScoringSample,
  toScoringScope,
} from "./adapters.js";
import { ALL_CHECKS } from "./checks/index.js";
import { dynamicRequires, effectiveRequires, PARENT_TABLES } from "./checks/requirements.js";
import type { CheckCtx } from "./checks/types.js";
import { severityPolicyFor } from "./checks/severityPolicy.js";
import { guardWriterHints } from "./checks/clientContextGate.js";
import { evidence as evidenceOf, gateOnData } from "./checks/types.js";
import type {
  CheckDefinition,
  CheckFinding,
  CheckResult,
  CheckScope,
  EvidenceRef,
  EvidenceRow,
  NotCheckableCategory,
  Remediation,
  RemedyProvider,
  WriterHints,
} from "./checks/types.js";
import { DEFAULT_CONFOUNDER_THRESHOLDS, resolveAndJudge } from "./interactions/index.js";
import type { ConfidenceVerdict, ConfounderResult } from "./interactions/types.js";
import { buildAccountModel } from "./model/build.js";
import {
  countMoneyOnce,
  productPagesPricedElsewhere,
  productSpendByCampaign,
  type PricedMoney,
} from "./scoring/moneyOverlap.js";
import { num } from "./model/metrics.js";
import type { AccountModel, CoverageReport, DataQuality } from "./model/nodes/AccountNode.js";
import { reportableCampaigns, statusOf } from "./registry/entityStatus.js";
import { buildMetricCtx } from "./registry/index.js";
import { evaluate, getMetric } from "./registry/metrics.js";
import { LEGACY_COUNT_COLUMNS } from "./registry/syncMarkers.js";
import type { MetricCtx, MetricPayload } from "./registry/types.js";
import type { SyncMarker } from "./registry/syncMarkers.js";
import { computeConfidence } from "./scoring/confidence.js";
import { computeImpact } from "./scoring/impact.js";
import { applyFloorBudget, computeSeverity, DAYS_PER_MONTH } from "./scoring/severity.js";
import type { ConfidenceResult } from "./scoring/confidence.js";
import type { SeverityResult } from "./scoring/severity.js";
import type {
  Confidence,
  ConfounderSummary,
  Impact,
  ImpactFormulaId,
  MetricValue as ScoringMetricValue,
  Severity,
} from "./scoring/types.js";

/** Checks blocked from emitting, with the reason (none in this version). */
export const HARD_BLOCKED_CHECKS: Readonly<Record<string, string>> = {};

export interface EvidenceEngineInput {
  data: AccountData;
  /** extra named tables (sync markers, campaign negatives, ...). Absent key = never read. */
  dbTables?: Record<string, Row[]> | undefined;
  /** a label for this run; becomes the account node id */
  auditId: string;
  /** sync marker rows (`sync_table_status` shape): one per table read, with its status and row count. */
  statusRows?: readonly Row[] | null | undefined;
  /** fallback row counts by legacy count column, when no marker row exists. */
  legacyCounts?: Record<string, unknown> | null | undefined;
  /** 'YYYY-MM-DD' the run is for; defaults to today (UTC). Pass it for reproducible output. */
  runDate?: string | undefined;
  /**
   * The classification the caller already made. Optional: without it the model
   * classifies the same `data` itself. NOT defaulted to 'ecommerce'; 'unknown'
   * makes the gated checks abstain.
   */
  businessType?: BusinessType | null | undefined;
  /**
   * The owner's own context (targets, constraints, margin). Optional; a check
   * must produce the same answer without it, it can only make an answer more
   * specific.
   */
  clientContext?: ClientContext | null | undefined;
  /** judgement threshold overrides (settings.ts); absent = defaults */
  settings?: CheckSettingsInput | null | undefined;
  /** milliseconds clock for `timings`; defaults to Date.now. Pass a fixed clock for byte-identical output. */
  clock?: () => number;
  /** the caller vouches that tables with rows but no status row are complete */
  assumeComplete?: boolean;
  /** tables known to be incomplete (rows dropped as unusable, a bad row_count), with the reason */
  incompleteTables?: Readonly<Record<string, string>>;
  /** the readers' row limits per table (see model/context FetchCaps); absent = no truncation inferred */
  caps?: Readonly<Record<string, number>> | null;
  /** the days the change history covers, inclusive (see CheckCtx.changeHistoryCoverage) */
  changeHistoryCoverage?: { startDate: string; endDate: string } | null | undefined;
  /** the caller's decisions by check id; absent = no `remediation` on any candidate */
  remedies?: RemedyProvider | null | undefined;
  /** the caller's writer text (see `WriterHints`); absent = none */
  writerHints?: WriterHints | null | undefined;
}

export interface Candidate {
  checkId: string;
  claimKey: string;
  scope: CheckScope;
  evidence: EvidenceRef[];
  facts: Record<string, MetricPayload>;
  impact: Impact;
  severity: SeverityResult;
  confidence: ConfidenceResult;
  confounders: ConfounderResult[];
  openItems: string[];
  /** Round 4 item 8: what the check itself could not see (its `limitedBy` + its own open items). */
  limitedBy?: string[] | undefined;
  /** Round 4 R17: the finding's own label (`CheckFinding.title`); absent = the check's title. */
  title?: string | undefined;
  settled: { strict: boolean; practical: boolean };
  markerState: "ok" | "provisional";
  sample: { truncated: boolean; population: number | null };
  /** phase 3: the per-entity table the check computed, carried to the card by code. */
  rows?: EvidenceRow[] | undefined;
  /**
   * The caller's decision about this finding (`EvidenceEngineInput.remedies`).
   * Absent when no provider was passed, it has no entry for this check, or it
   * declined to decide. The checks themselves never set it.
   */
  remediation?: Remediation | undefined;
  origin: "engine";
  /**
   * The matrix's verdict on this candidate.
   * `action === 'transform'` was computed and consumed by nothing; the case
   * file reads it to place an explained finding as context under the finding
   * that explains it. Optional so every existing Candidate literal still
   * compiles; the engine always sets it.
   */
  verdict?: ConfidenceVerdict | undefined;
}

/**
 * A true number about this account that NO finding claims.
 *
 * Three things produce one, and nothing else may:
 *   - `registry`   — a metric on the CONTEXT_METRIC_IDS allow-list below;
 *   - `suppressed` — the evidence of a candidate that was correctly dropped. The
 *     drop kills the recommendation, not the measurement: "there are 26 distinct
 *     callouts" survives `SK17:X_SERVING_RULES`, "3 of them are dead, fix them"
 *     does not;
 *   - `none_found` — the numbers a clean check reported structurally.
 *
 * A context fact is NOT a finding. It has no severity, no impact and no title, it
 * is never ranked, and it can never be `reappeared` or `added` in the replay diff.
 */
export interface ContextFact extends EvidenceRef {
  origin: "registry" | "suppressed" | "none_found";
  /** the check it came out of, or null for a registry fact (which belongs to no check) */
  checkId: string | null;
}

/**
 * The registry leg of the context pool: DECLARED and FINITE, never "every metric
 * that evaluated". Per-campaign share of spend, per-campaign ROAS and the
 * conversion-action count: true numbers about a structure that no check claims
 * (a healthy campaign carrying most of the spend is not a problem, so no check
 * emits it), kept so a reader still has them.
 */
export const CONTEXT_METRIC_IDS: readonly string[] = [
  "C.spend_share",
  "C.roas",
  "A.conv_actions_count",
];

/**
 * One context fact in its compact stored form: five fields, no prose, no metric
 * payload. `window` rides along so a windowed metric keeps its label.
 */
export interface StoredContextFact {
  key: string;
  value: number | string | boolean | null;
  entity: string | null;
  checkId: string | null;
  origin: ContextFact["origin"];
  window?: string | null | undefined;
}

/**
 * `ContextFact[]` → the stored form. Non-scalar values are dropped: a record
 * value has no single number for the gate to match and nothing else reads this.
 */
export function toStoredContext(context: readonly ContextFact[]): StoredContextFact[] {
  const out: StoredContextFact[] = [];
  for (const c of context) {
    const v = c.value;
    if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean" && v !== null)
      continue;
    out.push({
      key: c.key,
      value: v,
      entity: c.entity ?? null,
      checkId: c.checkId,
      origin: c.origin,
      ...(c.window != null ? { window: c.window } : {}),
    });
  }
  return out;
}

export interface EvidenceEngineResult {
  /** priced findings by monthly dollars desc, then the unpriced ones by severity and confidence */
  candidates: Candidate[];
  /** report-level facts no finding claims — see ContextFact */
  context: ContextFact[];
  /** a dropped candidate keeps its numbers: the drop kills the claim, not the measurement */
  suppressed: Array<{
    checkId: string;
    claimKey: string;
    reason: string;
    evidence: EvidenceRef[];
    facts: Record<string, MetricPayload>;
  }>;
  notCheckable: Array<{
    checkId: string;
    reason: string;
    table?: string;
    category?: NotCheckableCategory;
  }>;
  noneFound: Array<{
    checkId: string;
    population: number | null;
    note?: string;
    evidence?: EvidenceRef[];
    subject?: number;
  }>;
  insufficientData: Array<{ checkId: string; reason: string }>;
  dataQuality: DataQuality;
  coverage: CoverageReport;
  counts: {
    ran: number;
    /** checks that produced at least one finding the activity gate let through */
    fired: number;
    /**
     * Checks that FOUND something and were not allowed to say it: every finding
     * they produced was about an entity that is not running, so the gate emptied
     * them (see `applyActivityGate`). They stay `fires` rather than becoming
     * `none_found`, because `none_found` is how a check earns a POSITIVE and a
     * clean bill of health here would be the worse false claim. They are counted
     * separately so `ran` still reconciles and so the number is visible.
     */
    gatedEmpty: number;
    emitted: number;
    suppressed: number;
    notCheckable: number;
  };
  timings: {
    modelMs: number;
    ctxMs: number;
    checksMs: number;
    interactionsMs: number;
    scoringMs: number;
    totalMs: number;
  };
  /** problems with the input itself (e.g. no sync markers), in plain words */
  warnings: string[];
  /**
   * what checks held back, with the reasons: a check that had every finding held back by a
   * gate, and a firing check's held-back lines beside its findings (e.g. SK20 paused pages)
   */
  withheld: Array<{ checkId: string; reasons: string[] }>;
  /** every scope the adapters refused, so a silent drop is never silent */
  unmappableScopes: Array<{ checkId: string; scope: CheckScope; reason: string }>;
  /** Round 4 R14: the priced spend per month, summed and counted once (see `countMoneyOnce`) */
  pricedMoney: PricedMoney;
}

/** No priced finding: every total is 0. */
export const emptyPricedMoney = (currency: string): PricedMoney => ({
  currency,
  findings: 0,
  monthly: 0,
  monthlyCountedOnce: 0,
  overlapping: 0,
});

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  warning: 3,
  opportunity: 2,
  positive: 1,
  info: 0,
};
/** The ranking tiers: critical and warning stand alone; below them money decides first. */
const TIER_RANK: Record<Severity, number> = {
  critical: 2,
  warning: 1,
  opportunity: 0,
  positive: 0,
  info: 0,
};
const CONFIDENCE_RANK: Record<string, number> = { STRONG: 2, MODERATE: 1, HYPOTHESIS: 0 };

/**
 * The dollar figure a candidate actually carries, or null. `IMP_STRUCTURAL`
 * returns the literal 0 with `quantified: false` — it makes no dollar claim, so
 * it is not a dollar figure and must not be ranked as one.
 */
function pricedValue(c: Candidate): number | null {
  return c.impact.quantified && c.impact.value != null ? c.impact.value : null;
}

/** Share of monthly spend a priced row must reach to outrank unpriced rows below warning. */
const RANK_SPEND_SHARE = 0.005;

/**
 * The least monthly money that ranks a row ahead of unpriced ones: the lower of the money
 * floor (`T.waste_floor`) and 0.5% of monthly spend, whichever are known; 0 when neither is.
 */
export function rankMoneyFloor(moneyFloor: number | null, monthlySpend: number | null): number {
  const bars = [moneyFloor, monthlySpend != null ? monthlySpend * RANK_SPEND_SHARE : null].filter(
    (v): v is number => v != null && Number.isFinite(v) && v > 0,
  );
  return bars.length > 0 ? Math.min(...bars) : 0;
}

function numberOf(ctx: MetricCtx, id: string): number | null {
  const v = evaluate(ctx, id);
  if (v.reason !== undefined) return null;
  return typeof v.value === "number" ? v.value : null;
}

/**
 * The check's evidence rows, as the scoring layer reads metrics. A `null`
 * settled tier means "carries no conversion number", which does not vote
 * (checks/types `settledOf`), so it maps to `true` here too.
 */
function evidenceAsMetrics(f: CheckFinding): ScoringMetricValue[] {
  return f.evidence.map((e) => ({
    id: e.key,
    value:
      typeof e.value === "number" || typeof e.value === "string" || typeof e.value === "boolean"
        ? e.value
        : null,
    settledStrict: e.settledStrict ?? true,
    settledPractical: e.settledPractical ?? true,
    truncated: f.sample.truncated,
    population: (f.sample.population != null && f.sample.population > 0 ? "real" : "unknown") as
      "real" | "unknown",
    source: { table: e.source },
  }));
}

/**
 * `facts` goes into the impact formula verbatim — that is how `Pr.spend` and
 * `SL.device().cost` reach a formula instead of `C.spend`. `ImpactContext.facts`
 * only accepts a number or a MetricValue, so a row[] / enum-map fact is left
 * out rather than coerced: a formula must never read a made-up scalar.
 */
const SEVERITY_LADDER = ["info", "opportunity", "warning", "critical"] as const;

/** Round 2 Y5: the lower of the check's ceiling and a finding's own (absent = the check's). */
/** Round 4 item 8: a check's own limits (explicit + its plain open items), de-duplicated; absent when none. */
export function limitsOf(f: Pick<CheckFinding, "limitedBy" | "openItems">): {
  limitedBy?: string[];
} {
  const all = [...(f.limitedBy ?? []), ...(f.openItems ?? [])]
    .map((x) => x.trim())
    .filter((x) => x !== "");
  const uniq = all.filter((x, i) => all.indexOf(x) === i);
  return uniq.length > 0 ? { limitedBy: uniq } : {};
}

function lowerSeverity<S extends string>(policyCeiling: S, findingCeiling: string | undefined): S {
  if (!findingCeiling) return policyCeiling;
  const a = SEVERITY_LADDER.indexOf(policyCeiling as (typeof SEVERITY_LADDER)[number]);
  const b = SEVERITY_LADDER.indexOf(findingCeiling as (typeof SEVERITY_LADDER)[number]);
  if (a === -1 || b === -1) return policyCeiling;
  return (b < a ? findingCeiling : policyCeiling) as S;
}

function factsForImpact(facts: Record<string, MetricPayload>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(facts)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Rule 4, content-based: how many tables the supplied inputs can actually put a
 * marker on. Presence of the parameters proves nothing — the Phase 3 loader
 * always gets an object back for the `audits` row while
 * `sync_table_status` can come back `[]` because the sync never wrote it, and a
 * truthy-but-empty pair used to silence the warning while every marker resolved
 * `unknown`.
 */
export function countSuppliedMarkers(
  input: Pick<EvidenceEngineInput, "statusRows" | "legacyCounts">,
): number {
  let n = 0;
  for (const r of input.statusRows ?? []) {
    if (
      r &&
      typeof r === "object" &&
      String((r as { table_name?: unknown }).table_name ?? "") !== ""
    )
      n += 1;
  }
  for (const col of Object.keys(LEGACY_COUNT_COLUMNS)) {
    const v = input.legacyCounts?.[col];
    if (v != null && v !== "" && Number.isFinite(Number(v))) n += 1;
  }
  return n;
}

/** A deep-frozen structured clone, so a caller's remedy cannot change the finding it reads. */
function frozenCopy<T>(value: T): T {
  const deepFreeze = (v: unknown): void => {
    if (v === null || typeof v !== "object" || Object.isFrozen(v)) return;
    Object.freeze(v);
    for (const k of Reflect.ownKeys(v)) deepFreeze((v as Record<PropertyKey, unknown>)[k]);
  };
  const copy = structuredClone(value);
  deepFreeze(copy);
  return copy;
}

/** The one reason every check carries on an account that spent nothing in the window. */
export const NO_ACTIVITY_REASON = "the account spent nothing in the 90 days read";

/** The reason a check that would have said clean carries when no campaign is switched on. */
export const NOTHING_RUNNING_REASON =
  "no campaign is switched on, so there was nothing running to judge";

/**
 * Tables about the account itself (conversion tracking, access, Merchant Center, ...), not
 * about what runs in it: a check that reads only these judges the account whatever is
 * switched on, so it keeps its own result when no campaign is.
 */
const ACCOUNT_LEVEL_TABLES: ReadonlySet<string> = new Set([
  "conversionActions",
  "conversionTrackingSettings",
  "conversionValueRules",
  "customerConversionGoals",
  "customerUserAccess",
  "offlineUserDataJobs",
  "recommendationSubscriptions",
  "mcAccountIssues",
  "mcPromotions",
  "mcReturnPolicies",
  "mcShippingSettings",
  "lsaVerifications",
]);
const isAccountLevel = (def: { requires: readonly string[] }): boolean =>
  def.requires.length > 0 && def.requires.every((t) => ACCOUNT_LEVEL_TABLES.has(t));

export function runEvidenceEngine(input: EvidenceEngineInput): EvidenceEngineResult {
  const now = input.clock ?? Date.now;
  const t0 = now();
  const settings = resolveSettings(input.settings);
  const warnings: string[] = [];
  const refusals = createRefusalLog();

  // ---- 1. account model (+ 2. metric context). A throw here means no check
  // can judge anything: every check reports not_checkable with the reason.
  const tables = { ...(input.dbTables ?? {}) };
  if (input.statusRows && !Array.isArray(tables.sync_table_status))
    tables.sync_table_status = [...input.statusRows];
  let model: AccountModel;
  let metrics: MetricCtx;
  let modelMs = 0;
  let ctxMs = 0;
  try {
    model = buildAccountModel(input.data, tables, input.auditId, {
      legacyCounts: input.legacyCounts ?? null,
      businessType: input.businessType ?? null,
      caps: input.caps ?? null,
    });
    modelMs = now() - t0;
    const tCtx0 = now();
    metrics = buildMetricCtx(model, input.data, {
      statusRows: input.statusRows ?? null,
      legacyCounts: input.legacyCounts ?? null,
      ...(input.runDate ? { runDate: input.runDate } : {}),
      settings,
    });
    ctxMs = now() - tCtx0;
  } catch (err) {
    return modelFailure(`account model could not be built: ${plainError(err)}`, now() - t0);
  }

  const tCtx = now();
  if (countSuppliedMarkers(input) === 0) {
    // Without a marker every table resolves 'unknown' and the gated checks go
    // not_checkable. Said out loud, never silent.
    warnings.push(
      `no usable sync marker was supplied (${(input.statusRows ?? []).length} status row(s), ` +
        `${input.legacyCounts ? Object.keys(input.legacyCounts).length : 0} legacy count(s)); ` +
        'every sync marker resolves "unknown", so tables with no rows are not_checkable and findings are provisional',
    );
  }
  for (const m of uniqueMarkers(metrics)) {
    if (m.partial)
      warnings.push(
        `${m.table}: ${m.message}; checks that need the whole table do not report it clean`,
      );
    if (m.excess) warnings.push(`${m.table}: ${m.message}`);
  }
  ctxMs += now() - tCtx;

  const { forInteractions, forScoring } = makeMetricLookups(metrics);
  // the confounder resolvers judge with the same bars the checks used
  const confounderThresholds = {
    ...DEFAULT_CONFOUNDER_THRESHOLDS,
    tRoasMinConv30: settings.bidding.targetRoasMinConv30d,
    tCpaMinConv30: settings.bidding.targetCpaMinConv30d,
    chokingUtil: settings.bidding.chokingUtilBelow,
    chokingTargetRatio: settings.bidding.chokingTargetVsRealised,
    lostIsBudgetPct: settings.bidding.scaleLostIsBudgetPct,
    lostIsRankPct: settings.bidding.lostIsRankPct,
    scaleUtilMin: settings.bidding.scaleUtilMin,
    convMinForVerdict: settings.floors.moderateConv,
    qsLow: settings.search.lowQsMax,
    silenceMinDays: settings.measurement.silenceMinDays,
    silenceMaxGapDays: settings.measurement.silenceMaxGapDays,
  };
  const currency = currencyScale(model.attrs.currencyCode);
  const checkCtx: CheckCtx = {
    model,
    metrics,
    get: (id: string, args?: Parameters<typeof evaluate>[2]) => evaluate(metrics, id, args),
    window: model.window,
    currency,
    businessType: model.attrs.businessType,
    clientContext: input.clientContext ?? null,
    settings,
    changeHistoryCoverage: input.changeHistoryCoverage ?? null,
    writerHints: input.writerHints
      ? guardWriterHints(input.writerHints, (m) => warnings.push(m))
      : null,
  };

  // A remedy gets a deep-frozen copy of each finding and a frozen view of the ctx
  // (top level only: the model is shared with every check, cloning it per finding
  // costs too much and freezing it would change it for the checks still to run).
  const remedyCtx: CheckCtx = Object.freeze({ ...checkCtx });

  // ---- 3. run every check; a throw is not_checkable, never "none found"
  const tChecks = now();
  const results = new Map<string, CheckResult>();
  const notCheckable: EvidenceEngineResult["notCheckable"] = [];
  const noneFound: EvidenceEngineResult["noneFound"] = [];
  const insufficientData: EvidenceEngineResult["insufficientData"] = [];

  // An account that spent nothing in the window has nothing to audit: every check
  // gets the one true reason instead of 150 reasons about missing parts. Only when
  // the daily series was read in full and its cost is KNOWN to be 0 (no day, or
  // days that carry a cost summing to 0), and no campaign shows spend of its own:
  // a failed read or a missing cost is never called "spent nothing": one day
  // without a cost leaves the total unknown, whatever the other days sum to.
  const dailyCost = model.dataQuality.reconciliation.dailyCost;
  const dailyRows: unknown[] = Array.isArray(input.data.dailyMetrics)
    ? input.data.dailyMetrics
    : [];
  const everyDayCosted = dailyRows.every(
    (r) => r !== null && typeof r === "object" && num((r as { cost?: unknown }).cost) != null,
  );
  const campaigns = model.children.campaigns;
  const noActivity =
    gateOnData(checkCtx, ["dailyMetrics"]) == null &&
    input.incompleteTables?.dailyMetrics == null &&
    (model.window.start == null || (dailyCost === 0 && everyDayCosted)) &&
    campaigns.every((c) => (c.windows.m90.cost ?? 0) === 0);
  if (noActivity) {
    warnings.push("The account spent nothing in the 90 days read, so there is nothing to audit.");
    const on = campaigns.filter((c) => statusOf(c) === "ENABLED").length;
    if (on > 0)
      warnings.push(
        `${on} campaign(s) are switched on, but nothing was spent in the 90 days read.`,
      );
  }
  // Money was spent, but by paused or removed campaigns only: a check that judged the
  // running campaigns judged none, so it is not run, never clean. Only when the
  // campaigns were read in full and carry their status.
  const nothingRunning =
    !noActivity &&
    gateOnData(checkCtx, ["campaigns"]) == null &&
    input.incompleteTables?.campaigns == null &&
    campaigns.some((c) => statusOf(c) != null) &&
    reportableCampaigns(model).length === 0;
  // the spend is named only when a campaign shows some (the account total alone may be
  // unknown or cut short)
  if (nothingRunning)
    warnings.push(
      campaigns.some((c) => (c.windows.m90.cost ?? 0) > 0)
        ? "No campaign is switched on: the spend in the 90 days read came from paused or removed campaigns, so nothing running was judged."
        : "No campaign is switched on, so nothing running was judged.",
    );

  for (const def of ALL_CHECKS) {
    let r: CheckResult;
    if (noActivity) {
      r = {
        state: "not_checkable",
        reason: NO_ACTIVITY_REASON,
        category: "not_present",
      };
      results.set(def.id, r);
      notCheckable.push({ checkId: def.id, reason: r.reason, category: "not_present" });
      continue;
    }
    try {
      r = def.run(checkCtx);
    } catch (err) {
      r = {
        state: "not_checkable",
        reason: `check threw: ${err instanceof Error ? err.message : String(err)}`,
        category: "could_not_run",
      };
    }
    r = applyCompleteness(def, metrics, r, {
      assumeComplete: input.assumeComplete === true,
      incomplete: input.incompleteTables ?? {},
    });
    // clean, or every finding held back for sitting on a campaign that is not running
    // (a check on the account itself keeps its own result)
    if (
      nothingRunning &&
      !isAccountLevel(def) &&
      (r.state === "none_found" || (r.state === "fires" && r.findings.length === 0))
    )
      r = { state: "not_checkable", reason: NOTHING_RUNNING_REASON, category: "not_present" };
    results.set(def.id, r);
    if (r.state === "not_checkable") {
      const category = r.category ?? def.notCheckableCategory;
      notCheckable.push({
        checkId: def.id,
        reason: r.reason,
        ...(r.table ? { table: r.table } : {}),
        ...(category ? { category } : {}),
      });
    } else if (r.state === "none_found")
      noneFound.push({
        checkId: def.id,
        population: r.population,
        ...(r.note ? { note: r.note } : {}),
        ...(r.evidence?.length ? { evidence: r.evidence } : {}),
        ...(r.subject != null ? { subject: r.subject } : {}),
      });
    else if (r.state === "insufficient_data")
      insufficientData.push({ checkId: def.id, reason: r.reason });
  }
  const checksMs = now() - tChecks;

  // ---- 4/5. confounders, impact, confidence, severity, emit policy
  const monthlySpend = numberOf(metrics, "A.spend_monthly");
  // the tiny-spend cap's inputs (Phase F round 2): each campaign's monthly run rate on
  // the days it actually spent (a campaign launched last week is judged on its pace,
  // not on 90 days it did not exist), the account's monthly spend, the money floor
  const moneyFloor = numberOf(metrics, "T.waste_floor");
  const campaignRunRate = new Map(
    model.children.campaigns.map((c) => {
      const cost = c.windows.m90.cost ?? 0;
      const spendDays = (c.attrs.dailyTraffic ?? []).filter((d) => d.cost > 0).length;
      const days =
        spendDays > 0 ? spendDays : (c.attrs.budget.budgetDays ?? model.window.days ?? 90);
      return [c.id, days > 0 ? (cost / days) * DAYS_PER_MONTH : 0] as const;
    }),
  );
  const candidates: Candidate[] = [];
  const suppressed: EvidenceEngineResult["suppressed"] = [];
  const refusedByCheck: EvidenceEngineResult["unmappableScopes"] = [];
  const withheld: EvidenceEngineResult["withheld"] = [];
  let fired = 0;
  let gatedEmpty = 0;
  let interactionsMs = 0;
  let scoringMs = 0;

  for (const def of ALL_CHECKS) {
    const r = results.get(def.id)!;
    if (r.state !== "fires") continue;
    try {
      // a check the activity gate emptied is still `fires` (see applyActivityGate for
      // why it must not become `none_found`), but it produced nothing and must not be
      // counted as a check that fired. It gets its own count so the buckets still
      // add up to `ran` and so the number is not lost.
      if (r.findings.length === 0) {
        gatedEmpty += 1;
        withheld.push({
          checkId: def.id,
          reasons:
            r.withheld && r.withheld.length > 0
              ? [...r.withheld]
              : ["every finding was held back before scoring"],
        });
        continue;
      }
      fired += 1;
      // what the check held back beside its findings (SK20: pages that only paused ads
      // send traffic to) stays a line on the check's entry, never lost
      if (r.withheld && r.withheld.length > 0)
        withheld.push({ checkId: def.id, reasons: [...r.withheld] });
      const policy = severityPolicyFor(def.id);
      const blocked = HARD_BLOCKED_CHECKS[def.id];

      for (const f of r.findings) {
        if (blocked) {
          suppressed.push({
            checkId: def.id,
            claimKey: f.claimKey,
            reason: `hard block — ${blocked}`,
            evidence: f.evidence,
            facts: f.facts,
          });
          continue;
        }

        const seenBefore = refusals.length;
        const interactionScope = toInteractionsScope(f.scope, refusals);
        const scoringScope = toScoringScope(f.scope, refusals);
        if (!interactionScope || !scoringScope) {
          const why =
            refusals
              .slice(seenBefore)
              .map((u) => u.reason)
              .join("; ") || "scope could not be mapped";
          refusedByCheck.push({ checkId: def.id, scope: f.scope, reason: why });
          suppressed.push({
            checkId: def.id,
            claimKey: f.claimKey,
            reason: `scope not mappable: ${why}`,
            evidence: f.evidence,
            facts: f.facts,
          });
          continue;
        }

        // a. + b. confounders
        const tI = now();
        const { results: confounders, verdict } = resolveAndJudge(
          def.id,
          {
            model,
            metrics: forInteractions,
            scope: interactionScope,
            thresholds: confounderThresholds,
          },
          def.confounders,
        );
        interactionsMs += now() - tI;

        if (verdict.action === "drop") {
          const explainers = confounders.filter(
            (c) => c.state === "explains" && c.effect === "drop",
          );
          suppressed.push({
            checkId: def.id,
            claimKey: f.claimKey,
            reason: `dropped by confounder ${explainers.map((c) => c.id).join(", ") || verdict.explains.join(", ")}: ${explainers[0]?.note ?? "the signal is explained away"}`,
            evidence: f.evidence,
            facts: f.facts,
          });
          continue;
        }

        const tS = now();
        // c. impact — facts verbatim, on the mapped scope only
        const formulaId = (def.impactFormula ?? "IMP_NONE") as ImpactFormulaId;
        // `sliceKind` comes from the scope's own type. A scope type that belongs
        // to no slice family passes NOTHING, so the formula declines instead of
        // pricing a demographic finding off a device metric.
        const sliceKind = sliceKindForScope(f.scope);
        const impact = computeImpact(formulaId, {
          scope: scoringScope,
          metrics: forScoring,
          currency: model.attrs.currencyCode,
          facts: factsForImpact(f.facts),
          ...(sliceKind ? { params: { sliceKind } } : {}),
        });

        // d. confidence
        const summaries: ConfounderSummary[] = confounders.map((c) => ({
          state: c.state,
          id: c.id ?? c.forCheck ?? def.id,
          ...(c.campaignIds ? { campaignIds: c.campaignIds } : {}),
        }));
        // the campaign the finding is about, when it names one
        const findingCampaign =
          f.scope.type === "campaign" ? f.scope.id : (f.scope.campaignId ?? null);
        const confidence = computeConfidence({
          inputs: [...impact.inputs, ...evidenceAsMetrics(f)],
          sample: toScoringSample(f.sample),
          confounders: summaries,
          openItems: [
            ...verdict.openItems,
            ...(f.settled.strict
              ? []
              : [
                  f.settled.practical
                    ? "the finding is settled only by the practical rule"
                    : "the finding is unsettled",
                ]),
            ...(f.markerState === "provisional"
              ? ["a source table has no sync marker — the numbers are provisional"]
              : []),
          ],
          capAtModerate: verdict.ceiling === "MODERATE",
        });

        // e. severity — declaredConfounders explicitly, or it fails closed
        const severity = computeSeverity({
          impact,
          monthlySpend,
          confidence: confidence.level as Confidence,
          confounders: summaries,
          integrity: policy.integrity,
          structural: policy.structural,
          positive: policy.positive,
          opportunity: policy.opportunity,
          // Round 2 Y5: a finding may carry a LOWER ceiling of its own, never a higher one
          maxSeverity: lowerSeverity(policy.maxSeverity, f.maxSeverity),
          ...(policy.sheetBase
            ? { minSeverity: lowerSeverity(policy.sheetBase, f.maxSeverity) }
            : {}),
          declaredConfounders: def.confounders,
          campaignIds: findingCampaign ? [findingCampaign] : null,
          checkId: def.id,
          scopeSpend:
            findingCampaign && campaignRunRate.has(findingCampaign) && monthlySpend != null
              ? {
                  campaignMonthly: campaignRunRate.get(findingCampaign)!,
                  accountMonthly: monthlySpend,
                  // an unknown currency makes the floor infinite: no cap then, not a cap on everything
                  floor: moneyFloor != null && Number.isFinite(moneyFloor) ? moneyFloor : 0,
                }
              : null,
        });
        scoringMs += now() - tS;

        // 5. emit policy — these run and feed confounders, but never become candidates
        if (!policy.emit) {
          suppressed.push({
            checkId: def.id,
            claimKey: f.claimKey,
            reason:
              "context only: this check feeds other checks and the account context, it never reports a finding of its own",
            evidence: f.evidence,
            facts: f.facts,
          });
          continue;
        }

        const candidate: Candidate = {
          checkId: def.id,
          claimKey: f.claimKey,
          // NOTE (C6): two account-scope checks emit `scope.name = ''`, which the
          // writer would render as a blank in the title. Filling it with the
          // account's name here was tried and REVERTED: the gate matches a claim's
          // entity against `scope.name` before falling back to `scope.type`, so
          // naming the account broke all 14 verified-true claims. `scope.type ===
          // 'account'` already says everything the writer needs; rendering it as
          // "your account" is the writer's job, not a value change here.
          scope: f.scope,
          evidence: f.evidence,
          facts: f.facts,
          impact,
          severity,
          confidence,
          confounders,
          openItems: [...confidence.openItems, ...(f.openItems ?? [])],
          ...limitsOf(f),
          ...(f.title ? { title: f.title } : {}),
          settled: f.settled,
          markerState: f.markerState,
          sample: f.sample,
          ...(f.rows && f.rows.length > 0 ? { rows: f.rows } : {}),
          /**
           * PHASE 5. The caller's remedy for this check, when it passed one. A
           * remedy that throws while deciding must not lose the finding:
           * the decision is an ADDITION to a claim that already stands on its own,
           * and a missing one is recorded as a gap rather than a failure.
           */
          ...(() => {
            const remedy = input.remedies?.[def.id];
            if (!remedy) return {};
            try {
              const r = remedy(frozenCopy(f), remedyCtx);
              // a plain copy: a getter, a proxy or a function in it fails HERE (this
              // finding loses its decision), never later while the result is read
              return r ? { remediation: structuredClone(r) } : {};
            } catch {
              return {};
            }
          })(),
          origin: "engine",
          verdict,
        };

        const violation = invariantViolation(candidate, def);
        if (violation) {
          suppressed.push({
            checkId: def.id,
            claimKey: f.claimKey,
            reason: `invariant: ${violation}`,
            evidence: f.evidence,
            facts: f.facts,
          });
          continue;
        }
        candidates.push(candidate);
      }
      // the money floor lifts at most a few findings per check, biggest money first
      applyFloorBudget(candidates.filter((c) => c.checkId === def.id));
    } catch (err) {
      // a scoring failure drops this check's findings with the reason; it never stops the run
      for (const c of candidates.filter((x) => x.checkId === def.id))
        candidates.splice(candidates.indexOf(c), 1);
      suppressed.push({
        checkId: def.id,
        claimKey: def.claimKey,
        reason: `scoring failed: ${plainError(err)}`,
        evidence: [],
        facts: {},
      });
    }
  }

  // ---- 5b. money counted once (Round 4 R14 / R17)
  // an SK20 product page whose product a product check prices: left out of SK20 (a
  // held-back line names the check) only when those checks price 80%+ of the page's spend;
  // otherwise it stays a finding, marked as overlapping with them
  const sk20Before = candidates.some((c) => c.checkId === "SK20");
  for (const hit of productPagesPricedElsewhere(candidates, model)) {
    const { page, checkIds, product, coveredSpend90, pageSpend90 } = hit;
    const checks = checkIds.join(" and ");
    if (hit.leaveOut) {
      candidates.splice(candidates.indexOf(page), 1);
      const reason = `${page.scope.name ?? page.scope.id} left out: ${checks} already price${checkIds.length > 1 ? "" : "s"} ${coveredSpend90} of its ${pageSpend90} spend over 90 days as the product spend of ${product}`;
      const entry = withheld.find((w) => w.checkId === "SK20");
      if (entry) entry.reasons.push(reason);
      else withheld.push({ checkId: "SK20", reasons: [reason] });
      continue;
    }
    page.facts = {
      ...page.facts,
      overlaps_with: checkIds,
      product_spend_priced_elsewhere_90d: coveredSpend90,
      overlap_note: `${checks} price${checkIds.length > 1 ? "" : "s"} ${coveredSpend90} of this page's ${pageSpend90 ?? "unread"} spend over 90 days as the product spend of ${product}; the rest of the page's spend is priced only here`,
    };
  }
  if (sk20Before && !candidates.some((c) => c.checkId === "SK20")) {
    fired -= 1;
    gatedEmpty += 1;
  }
  // findings pricing the same campaign are marked; the total counts each dollar once
  const pricedMoney = countMoneyOnce(
    candidates,
    campaignRunRate,
    model.attrs.currencyCode,
    productSpendByCampaign(model),
  );

  // ---- 6. rank
  //
  // Severity first (critical > warning > opportunity > info), then money, and only
  // real money. Money first let an `info` row with a dollar figure sit above every
  // warning without one. `impact.value ?? -1` used to put IMP_STRUCTURAL's literal 0
  // above every unquantified finding. Within a severity a finding with no dollar
  // figure is ranked by what IS known about it: confidence.
  //
  // R6: below warning, money outranks the severity word. An unpriced `opportunity` (a
  // search term with 1 sale) sat above every priced `info` item; now the priced rows of
  // opportunity / positive / info come first by money, then the unpriced ones by severity.
  // Round 3: only money worth naming jumps the line. A row priced under `rankFloor` (the
  // lower of the money floor and 0.5% of monthly spend) ranks with the unpriced ones, by
  // severity, so a $3 a month note never sits above an unpriced opportunity.
  const rankFloor = rankMoneyFloor(moneyFloor, monthlySpend);
  const rankedMoney = (c: Candidate): number | null => {
    const v = pricedValue(c);
    return v != null && v >= rankFloor ? v : null;
  };
  candidates.sort((a, b) => {
    const tier = TIER_RANK[b.severity.severity] - TIER_RANK[a.severity.severity];
    if (tier !== 0) return tier;
    const am = rankedMoney(a);
    const bm = rankedMoney(b);
    if (am != null && bm != null) {
      if (bm !== am) return bm - am;
    } else if (am != null || bm != null) {
      return am != null ? -1 : 1;
    }
    const sev = SEVERITY_RANK[b.severity.severity] - SEVERITY_RANK[a.severity.severity];
    if (sev !== 0) return sev;
    // inside one severity, rows priced under the floor still keep their money order and sit
    // above the unpriced ones: a $77 page never falls below $0 notes of the same severity
    const money = (pricedValue(b) ?? -1) - (pricedValue(a) ?? -1);
    if (money !== 0) return money;
    const conf =
      (CONFIDENCE_RANK[b.confidence.level] ?? 0) - (CONFIDENCE_RANK[a.confidence.level] ?? 0);
    if (conf !== 0) return conf;
    // a total order, so the output never depends on the order rows arrived in
    return cmp(candidateKey(a), candidateKey(b));
  });

  // ---- 7. context — true numbers no finding claims (see ContextFact)
  const context: ContextFact[] = [];
  // The allow-list is one list; where each id is evaluated follows its REGISTRY
  // LEVEL, so an account metric is read once for the account and a campaign
  // metric once per campaign, instead of an account number being restated 11
  // times under a campaign's name.
  for (const id of CONTEXT_METRIC_IDS) {
    if (getMetric(id)?.level !== "account") continue;
    const v = evaluate(metrics, id);
    if (v.reason !== undefined) continue;
    context.push({
      ...evidenceOf(v, { id: null, name: "account" }),
      origin: "registry",
      checkId: null,
    });
  }
  for (const c of model.children.campaigns) {
    for (const id of CONTEXT_METRIC_IDS) {
      if (getMetric(id)?.level === "account") continue;
      const v = evaluate(metrics, id, { campaignId: c.id });
      if (v.reason !== undefined) continue;
      context.push({
        ...evidenceOf(v, { id: c.id, name: c.name }),
        origin: "registry",
        checkId: null,
      });
    }
  }
  for (const s of suppressed) {
    for (const ev of s.evidence) context.push({ ...ev, origin: "suppressed", checkId: s.checkId });
  }
  for (const n of noneFound) {
    for (const ev of n.evidence ?? [])
      context.push({ ...ev, origin: "none_found", checkId: n.checkId });
  }

  return {
    candidates,
    context,
    suppressed,
    notCheckable,
    noneFound,
    insufficientData,
    dataQuality: model.dataQuality,
    coverage: model.coverage,
    counts: {
      ran: ALL_CHECKS.length,
      fired,
      gatedEmpty,
      emitted: candidates.length,
      suppressed: suppressed.length,
      notCheckable: notCheckable.length,
    },
    timings: { modelMs, ctxMs, checksMs, interactionsMs, scoringMs, totalMs: now() - t0 },
    unmappableScopes: refusedByCheck,
    warnings,
    withheld,
    pricedMoney,
  };
}

/**
 * The §1.4 invariants, enforced on the built candidate. Returning a reason
 * suppresses the candidate — a finding that breaks one of these is not a
 * finding we are willing to print.
 */
export function invariantViolation(c: Candidate, def: CheckDefinition): string | null {
  if (!c.claimKey) return "empty claimKey";
  if (!c.scope || !c.scope.type) return "no scope";
  if (c.evidence.length === 0) return "no evidence[] entry — nothing to cite";
  if (c.severity.severity === "critical" && c.severity.unresolvedConfounders.length > 0) {
    return `critical with unresolved confounder(s) ${c.severity.unresolvedConfounders.join(", ")}`;
  }
  if (c.impact.value != null && def.impactFormula == null) {
    return "a dollar impact on a check that declares no impact formula";
  }
  return null;
}

const cmp = cmpStr;

function candidateKey(c: Candidate): string {
  return [
    c.checkId,
    c.claimKey,
    c.scope.type,
    c.scope.campaignId ?? "",
    c.scope.id ?? "",
    c.scope.name ?? "",
  ].join("\u0000");
}

function plainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

/** Each table's marker once (the map is keyed by both the data key and the table name). */
function uniqueMarkers(metrics: MetricCtx): SyncMarker[] {
  const seen = new Set<SyncMarker>();
  const out: SyncMarker[] = [];
  for (const m of metrics.markers.values()) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out.sort((a, b) => cmp(a.table, b.table));
}

/**
 * Completeness guard over the check's EFFECTIVE requirements (its tables, the
 * tables its metrics read, and every parent table): a table that failed, was
 * skipped, came back short of its row count or its reader's row limit, has rows
 * but no read status (unless the caller vouches with `assumeComplete`), or (for
 * a parent) was not read at all, cannot support a clean result. A clean verdict
 * becomes not_checkable naming the gap; a finding stands and carries the gap as
 * a limit (what was provided is real).
 */
function applyCompleteness(
  def: CheckDefinition,
  metrics: MetricCtx,
  r: CheckResult,
  opts: { assumeComplete: boolean; incomplete: Readonly<Record<string, string>> },
): CheckResult {
  const model = metrics.model;
  const direct = new Set(def.requires);
  const deps = new Set([...effectiveRequires(def), ...dynamicRequires(def, model)]);
  // the audit window comes from dailyMetrics, or campaignDailyMetrics when that is all there is
  if (model.window.source === "campaignDailyMetrics") deps.add("campaignDailyMetrics");
  const gaps: Array<{ table: string; text: string }> = [];
  for (const t of deps) {
    const m = metrics.markers.get(t);
    const name = m?.table ?? t;
    const add = (text: string) => gaps.push({ table: t, text });
    const flagged = opts.incomplete[t] ?? opts.incomplete[name];
    if (flagged) add(`${name}: ${flagged}`);
    const orphans = model.dataQuality.orphanRows[t] ?? model.dataQuality.orphanRows[name] ?? 0;
    if (orphans > 0) add(`${orphans} row(s) of ${name} point at a missing ${parentWord(t)}`);
    if (!m) continue;
    if (m.status === "error") add(`${name} could not be read${m.message ? `: ${m.message}` : ""}`);
    else if (m.status === "skipped")
      add(`${name} was not read${m.message ? `: ${m.message}` : ""}`);
    else if (m.partial) add(`${name}: ${m.message}`);
    else if (m.status === "unknown" && m.rowsSeen > 0 && !opts.assumeComplete)
      add(`completeness unknown: no read status was provided for ${name}`);
    else if (m.status === "unknown" && m.rowsSeen === 0 && !direct.has(t)) {
      // daily account totals not read at all is fine when the window came from the campaign series
      if (!(t === "dailyMetrics" && model.window.source === "campaignDailyMetrics"))
        add(`${name} was not read`);
    }
  }
  if (gaps.length === 0) return r;
  const text = [...new Set(gaps.map((g) => g.text))];
  // a table whose missing rows could cancel a finding invalidates findings too
  const fatal = (def.needsCompleteData ?? []).filter((t) => gaps.some((g) => g.table === t));
  if (r.state === "none_found" || (r.state === "fires" && fatal.length > 0))
    return {
      state: "not_checkable",
      reason: `the data is incomplete (${text.join("; ")}), so ${r.state === "fires" ? "the result" : "a clean result"} cannot be claimed`,
      category: "incomplete_data",
    };
  if (r.state === "fires")
    return {
      ...r,
      findings: r.findings.map((f) => ({
        ...f,
        limitedBy: [...(f.limitedBy ?? []), ...text.map((g) => `incomplete data — ${g}`)],
      })),
    };
  return r;
}

/** The parent a table's rows point at, in words. */
function parentWord(t: string): string {
  const p = PARENT_TABLES[t]?.[0];
  return p === "adGroups" ? "ad group" : p === "campaigns" ? "campaign" : (p ?? "parent row");
}

/** The result when the account model itself could not be built: every check is not_checkable. */
function modelFailure(reason: string, totalMs: number): EvidenceEngineResult {
  const empty = emptyQuality();
  return {
    candidates: [],
    context: [],
    suppressed: [],
    notCheckable: ALL_CHECKS.map((d) => ({
      checkId: d.id,
      reason,
      category: "could_not_run" as const,
    })),
    noneFound: [],
    insufficientData: [],
    dataQuality: empty,
    coverage: { keys: [], consumed: 0, allowlisted: 0, unconsumedNonEmpty: [] },
    counts: {
      ran: ALL_CHECKS.length,
      fired: 0,
      gatedEmpty: 0,
      emitted: 0,
      suppressed: 0,
      notCheckable: ALL_CHECKS.length,
    },
    timings: { modelMs: totalMs, ctxMs: 0, checksMs: 0, interactionsMs: 0, scoringMs: 0, totalMs },
    unmappableScopes: [],
    warnings: [reason],
    withheld: [],
    pricedMoney: emptyPricedMoney(""),
  };
}

function emptyQuality(): DataQuality {
  return {
    tables: {},
    syncMarkersPresent: false,
    legacyCounts: {},
    campaignNegativesSynced: [],
    orphanRows: {},
    contradictions: [],
    merchantCenter: [],
    reconciliation: {
      campaignsCost: null,
      dailyCost: null,
      costDelta: null,
      campaignsConv: null,
      dailyConv: null,
    },
  };
}
