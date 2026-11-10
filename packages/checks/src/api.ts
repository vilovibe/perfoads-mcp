// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Public API of the check engine: `runChecks`, `listChecks`, `explainCheck`.
 *
 * Every check ends a run in exactly one state:
 *   finding     it found something and at least one finding survived scoring;
 *   clean       it judged real data and found nothing;
 *   not_run     it could not judge (a table was not read, a floor was not met,
 *               the check does not apply), with the reason. Never "clean";
 *   suppressed  it found something, but every finding was dropped (an entity
 *               that is not running, a confounder that explains it, or a check
 *               that only feeds context), with the reasons.
 */
import { ALL_CHECKS } from "./engine/checks/index.js";
import { effectiveRequires } from "./engine/checks/requirements.js";
import {
  noteOnlyLineOf,
  type CheckDefinition,
  type CheckGroup,
  type NotCheckableCategory,
  type RemedyProvider,
  type WriterHints,
} from "./engine/checks/types.js";
import { emits, severityPolicyFor } from "./engine/checks/severityPolicy.js";
import {
  emptyPricedMoney,
  runEvidenceEngine,
  type Candidate,
  type EvidenceEngineResult,
} from "./engine/runEvidenceEngine.js";
import {
  DEFAULT_SETTINGS,
  settingsUsedOf,
  validateSettings,
  type CheckSettings,
  type SettingUsed,
  type CheckSettingsInput,
} from "./engine/settings.js";
import { sanitizeInput } from "./sanitize.js";
import type { BusinessType } from "./engine/shared/businessType.js";
import { toClientContext } from "./engine/shared/clientContext.js";
import type { AccountData, ClientContextInput, Row } from "./engine/shared/input.js";
import type { Severity } from "./engine/scoring/types.js";

/** The neutral engine input. A snapshot adapter builds it; tests build it by hand. */
export interface EvidenceInput {
  /** the account's rows, keyed by `ACCOUNT_DATA_ARRAY_KEYS` */
  data: AccountData;
  /** extra named tables (sync markers, campaign negatives, ...). Absent key = not read. */
  tables?: Record<string, Row[]> | undefined;
  /**
   * One row per table read: `{ table_name, status, row_count, error_message }`.
   * status: 'ok' | 'failed' | 'not_allowed' | 'skipped'. Only 'ok' is readable;
   * anything else (and any unrecognised status) makes the table unreadable and
   * the checks that need it report not_run. A row_count above the rows provided
   * marks the table incomplete: no check reports it clean.
   */
  statusRows?: readonly Row[] | null | undefined;
  /** fallback row counts by legacy count column, when no status row exists */
  legacyCounts?: Record<string, unknown> | null | undefined;
  /** 'YYYY-MM-DD' the run is for; defaults to today (UTC). Pass it for reproducible output. */
  runDate?: string | undefined;
  /** a label for the run; becomes the account node id. Default 'account'. */
  runId?: string | undefined;
  /** the business type when the caller already knows it; otherwise it is detected */
  businessType?: BusinessType | null | undefined;
  /** the owner's own context: targets, constraints, margin */
  clientContext?: ClientContextInput | null | undefined;
  /** judgement threshold overrides; absent = defaults (see `DEFAULT_SETTINGS`) */
  settings?: CheckSettingsInput | null | undefined;
  /** milliseconds clock for `timings`; defaults to Date.now */
  clock?: (() => number) | undefined;
  /**
   * The readers' row limits, by data key or table name (`<key>:per_campaign`
   * for a per-campaign limit). A table at its limit is treated as a sample.
   * Absent = no truncation is inferred from row counts.
   */
  caps?: Record<string, number> | null | undefined;
  /**
   * Vouch that tables with rows but no status row are complete. Without it such
   * a table has unknown completeness and no check reports it clean.
   */
  assumeComplete?: boolean | undefined;
  /**
   * The days the change history covers ('YYYY-MM-DD', inclusive). Checks that look back
   * further than this for a recent change (BB16, BB17) report not_run instead of judging.
   * Absent = coverage unknown, not checked.
   */
  changeHistoryCoverage?: { startDate: string; endDate: string } | null | undefined;
}

/**
 * `info`: the check ran and has something to say that is not a fault: a positive, a split it
 * always states, or a plain note (its `noteOnly` line). Never counted as a finding.
 */
export type CheckStatus = "finding" | "info" | "clean" | "not_run" | "suppressed";

export interface CheckOutcome {
  id: string;
  title: string;
  group: CheckGroup;
  status: CheckStatus;
  /** findings this check contributed to `findings` */
  findings: number;
  /** why it did not run, or why its findings were dropped */
  reason?: string;
  /** not_run only: the kind of reason */
  category?: NotCheckableCategory;
  /** not_run only: the table that was missing or not readable */
  table?: string;
  /** clean: what was judged, in a short machine note; info: the plain line it states; finding: what it held back beside its findings */
  note?: string;
  /** clean only: how many entities were judged */
  population?: number | null;
  /** the overrides in this run that this check reads (empty = it judged on defaults) */
  settingsApplied: SettingUsed[];
}

export interface RunChecksResult {
  /** output shape version */
  version: 1;
  /** scored findings: by severity, then priced ones first by monthly money, then by confidence */
  findings: Candidate[];
  /** what the `info` checks state (a positive, a split, a note): never findings */
  info: Candidate[];
  /** one outcome per shipped check, in registry order */
  checks: CheckOutcome[];
  counts: {
    checks: number;
    finding: number;
    info: number;
    clean: number;
    notRun: number;
    suppressed: number;
    findings: number;
  };
  /**
   * Round 4 R14: the spend the findings price per month (waste and at risk, never upside),
   * summed and counted once (findings pricing the same money are marked `overlaps_with`)
   */
  pricedMoney: EvidenceEngineResult["pricedMoney"];
  /** findings that were dropped, with the reason; their numbers stay true */
  suppressed: EvidenceEngineResult["suppressed"];
  /** true numbers about the account that no finding claims */
  context: EvidenceEngineResult["context"];
  dataQuality: EvidenceEngineResult["dataQuality"];
  coverage: EvidenceEngineResult["coverage"];
  unmappableScopes: EvidenceEngineResult["unmappableScopes"];
  /** problems with the input itself, in plain words; the run still happened */
  warnings: string[];
  /** why the input was rejected; when non-empty no check ran and every outcome is not_run */
  errors: string[];
  /** the settings the run used (defaults plus overrides) */
  settings: CheckSettings;
  /** every accepted override that differs from its default: what changed the bars in this run */
  settingsUsed: SettingUsed[];
  timings: EvidenceEngineResult["timings"];
}

/**
 * What a caller can add to a run. The checks say what is wrong; these are the
 * caller's own text, carried onto the result and never written by this package.
 */
export interface RunChecksOptions {
  /** decisions by check id; each fills `Candidate.remediation`. Absent = never set. */
  remedies?: RemedyProvider | null | undefined;
  /** writer text (see `WriterHints`). Absent = none. */
  writerHints?: WriterHints | null | undefined;
}

/**
 * Run every shipped check over the input. Pure: no network, no AI, no database.
 * Never throws: a rejected input or an engine failure comes back as a result
 * whose checks are all not_run with the reason.
 */
export function runChecks(
  input: EvidenceInput | unknown,
  options?: RunChecksOptions,
): RunChecksResult {
  try {
    const clean = sanitizeInput(input);
    const raw = input as { settings?: unknown } | null;
    const { settings, warnings: settingWarnings } = validateSettings(
      raw != null && typeof raw === "object" ? raw.settings : undefined,
    );
    const warnings = [...clean.warnings, ...settingWarnings];
    if (!clean.input)
      return notRunResult(
        `input rejected: ${clean.errors.join("; ")}`,
        clean.errors,
        warnings,
        settings,
      );
    const i = clean.input;
    const r = runEvidenceEngine({
      data: i.data,
      dbTables: i.tables,
      auditId: i.runId,
      statusRows: i.statusRows,
      legacyCounts: i.legacyCounts,
      ...(i.runDate ? { runDate: i.runDate } : {}),
      businessType: i.businessType,
      clientContext: toClientContext(i.clientContext),
      settings,
      ...(i.clock ? { clock: i.clock } : {}),
      caps: i.caps,
      assumeComplete: i.assumeComplete,
      incompleteTables: i.incompleteTables,
      changeHistoryCoverage: i.changeHistoryCoverage,
      remedies: options?.remedies ?? null,
      writerHints: options?.writerHints ?? null,
    });
    const used = settingsUsedOf(settings);
    const checks = ALL_CHECKS.map((def) => ({
      ...outcomeOf(def, r),
      settingsApplied: used.filter((u) => (CHECK_SETTINGS[def.id] ?? []).includes(u.key)),
    }));
    const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
    const infoIds = new Set(checks.filter((c) => c.status === "info").map((c) => c.id));
    const findings = r.candidates.filter((c) => !infoIds.has(c.checkId));
    return {
      version: 1,
      findings,
      info: r.candidates.filter((c) => infoIds.has(c.checkId)),
      checks,
      counts: {
        checks: checks.length,
        finding: count("finding"),
        info: count("info"),
        clean: count("clean"),
        notRun: count("not_run"),
        suppressed: count("suppressed"),
        findings: findings.length,
      },
      pricedMoney: r.pricedMoney,
      suppressed: r.suppressed,
      context: r.context,
      dataQuality: r.dataQuality,
      coverage: r.coverage,
      unmappableScopes: r.unmappableScopes,
      warnings: [...warnings, ...r.warnings],
      errors: [],
      settings,
      settingsUsed: used,
      timings: r.timings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return notRunResult(
      `the check engine failed: ${msg.slice(0, 300)}`,
      [],
      [],
      structuredClone(DEFAULT_SETTINGS),
    );
  }
}

/** Every check not_run with one reason (rejected input or an engine failure). */
function notRunResult(
  reason: string,
  errors: string[],
  warnings: string[],
  settings: CheckSettings,
): RunChecksResult {
  const checks: CheckOutcome[] = ALL_CHECKS.map((def) => ({
    id: def.id,
    title: def.title,
    group: def.group,
    status: "not_run",
    findings: 0,
    reason,
    category: "could_not_run",
    settingsApplied: [],
  }));
  return {
    version: 1,
    findings: [],
    info: [],
    checks,
    counts: {
      checks: checks.length,
      finding: 0,
      info: 0,
      clean: 0,
      notRun: checks.length,
      suppressed: 0,
      findings: 0,
    },
    pricedMoney: emptyPricedMoney(""),
    suppressed: [],
    context: [],
    dataQuality: {
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
    },
    coverage: { keys: [], consumed: 0, allowlisted: 0, unconsumedNonEmpty: [] },
    unmappableScopes: [],
    warnings,
    errors: errors.length > 0 ? errors : [reason],
    settings,
    settingsUsed: settingsUsedOf(settings),
    timings: { modelMs: 0, ctxMs: 0, checksMs: 0, interactionsMs: 0, scoringMs: 0, totalMs: 0 },
  };
}

function outcomeOf(
  def: CheckDefinition,
  r: EvidenceEngineResult,
): Omit<CheckOutcome, "settingsApplied"> {
  const base = { id: def.id, title: def.title, group: def.group };
  const nc = r.notCheckable.find((x) => x.checkId === def.id);
  if (nc) {
    return {
      ...base,
      status: "not_run",
      findings: 0,
      reason: nc.reason,
      ...(nc.category ? { category: nc.category } : {}),
      ...(nc.table ? { table: nc.table } : {}),
    };
  }
  const thin = r.insufficientData.find((x) => x.checkId === def.id);
  if (thin)
    return { ...base, status: "not_run", findings: 0, reason: thin.reason, category: "thin_data" };
  const clean = r.noneFound.find((x) => x.checkId === def.id);
  if (clean) {
    return {
      ...base,
      status: "clean",
      findings: 0,
      population: clean.population,
      ...(clean.note ? { note: clean.note } : {}),
    };
  }
  const mine = r.candidates.filter((c) => c.checkId === def.id);
  if (mine.length > 0) {
    // a note-only check states a fact, it does not report a fault (unless a finding carries
    // the fact that makes it a real one)
    const lines = mine.map((c) => noteOnlyLineOf(def, c.facts as Record<string, unknown>));
    if (lines.every((l) => l !== undefined))
      return { ...base, status: "info", findings: 0, note: lines[0] ?? def.noteOnly ?? "" };
    // what it held back beside its findings (e.g. SK20 pages only paused ads reach)
    const heldBack = r.withheld.find((w) => w.checkId === def.id)?.reasons ?? [];
    return {
      ...base,
      status: "finding",
      findings: mine.length,
      ...(heldBack.length > 0 ? { note: [...new Set(heldBack)].join("; ") } : {}),
    };
  }
  const held = r.withheld.find((w) => w.checkId === def.id)?.reasons ?? [];
  const dropped = [
    ...held,
    ...r.suppressed.filter((s) => s.checkId === def.id).map((s) => s.reason),
  ];
  return {
    ...base,
    status: "suppressed",
    findings: 0,
    reason:
      dropped.length > 0
        ? [...new Set(dropped)].join("; ")
        : "every finding was about an entity that is not running, so none is reported",
  };
}

/** The settings keys each check reads, so `explainCheck` can show its bars. */
const WASTE_BANDS = [
  "floors.wasteBandUnder1kUsd",
  "floors.wasteBand1kTo10kUsd",
  "floors.wasteBand10kTo50kUsd",
  "floors.wasteBand50kPlusUsd",
] as const;
const LEARNING = ["floors.learningMinAgeDays"] as const;
const CHECK_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  SK01: WASTE_BANDS,
  SK05: WASTE_BANDS,
  BB01: [...LEARNING, "bidding.lowUtilisation", "bidding.lowUtilisationMinSpendUsd"],
  BB02: ["bidding.lostIsBudgetPct"],
  BB03: ["bidding.lostIsRankPct", ...WASTE_BANDS],
  BB04: [
    ...LEARNING,
    "bidding.targetCpaMinConv30d",
    "bidding.targetRoasMinConv30d",
    "floors.moderateConv",
  ],
  BB05: [
    ...LEARNING,
    "bidding.chokingTargetVsRealised",
    "bidding.chokingUtilBelow",
    "bidding.chokingMinDailyBudgetUsd",
  ],
  BB06: [
    ...LEARNING,
    "bidding.targetCpaMinConv30d",
    "bidding.targetRoasMinConv30d",
    "bidding.valueBiddingMinConv30d",
  ],
  BB07: [...LEARNING, "bidding.scaleUtilMin", "bidding.scaleLostIsBudgetPct", "floors.strongConv"],
  BB09: ["bidding.modifierMinStep", "bidding.modifierGapMultiple"],
  BB14: ["floors.strongConv", "bidding.valueBiddingMinConv30d"],
  BB15: [
    "bidding.brandCpcFloorUsd",
    "bidding.brandCpcShareOfNonBrand",
    "bidding.brandCpcMinClicks",
    "bidding.nonBrandCpcMinClicks",
    "bidding.brandCpcNoteBelowMonthlyUsd",
  ],
  BB16: [
    ...LEARNING,
    "bidding.looseTargetMargin",
    "bidding.budgetLimitedLostIsPct",
    "bidding.budgetLimitedUtil",
    "bidding.looseTargetMinConv30d",
    "bidding.recentTargetChangeDays",
    "bidding.looseTargetFromDate",
  ],
  BB17: ["bidding.relearnDays"],
  SK02: ["search.lowQsMax", "search.lowQsSpendShareOfMonthly", "bidding.lostIsRankPct"],
  SK03: ["search.matchTypeConcentrationShare"],
  SK07: ["search.brandLeakShare", ...WASTE_BANDS],
  SK09: ["search.convertingTermMinConv"],
  SK10: ["search.dsaOverlapMinTerms"],
  SK12: ["search.rsaMinHeadlines"],
  SK13: ["search.maxPinnedAssets"],
  SK20: ["search.landingPageMinClicks", "search.landingPageCvrShare"],
  SK22: WASTE_BANDS,
  SK27: [
    "search.rollupMinSearches",
    "search.rollupMinFloors",
    "search.rollupMinShareOfTermSpend",
    ...WASTE_BANDS,
  ],
  SK28: ["search.brandInProspectingMinShare", ...WASTE_BANDS],
  SK30: ["search.researchAdGroupMinShare", ...WASTE_BANDS],
  AS01: ["structure.brandSpendSharePct"],
  AS03: ["structure.siblingLostIsBudgetPct"],
  AS13: ["structure.editorsMinChanges", "structure.topEditorShare"],
  AS16: [
    ...LEARNING,
    "structure.learnMinConv30d",
    "structure.thinMinCampaigns",
    "structure.thinMinShare",
  ],
  MI01: ["measurement.silenceMinDays", "measurement.silenceMaxGapDays"],
  AS12: ["structure.brandSpendSharePct"],
  BB12: ["bidding.absoluteTopMinPct"],
  BB13: ["bidding.targetMovesMax", "bidding.targetMoveMinPct", "bidding.targetMoveWindowDays"],
  SK23: ["search.silentKeywordMaxShare", ...WASTE_BANDS],
  SK24: ["search.shoppingCtrMinPct", "search.brandSearchCtrMinPct", "search.ctrMinImpressions"],
  SK25: ["search.maxKeywordsPerAdGroup"],
  PX01: ["pmax.shoppingShareMinPct"],
  PX02: ["pmax.brandLeakPct"],
  PX03: ["pmax.minHeadlines"],
  PX13: ["pmax.minImagesPerGroup", "pmax.minImagePx"],
  PX14: [
    "pmax.topGroupSharePct",
    "pmax.shapeMinSpendUsd",
    "pmax.topGroupWarnAccountPct",
    "pmax.siblingBetterPct",
    "floors.strongConv",
  ],
  PX18: ["pmax.shapeMinSpendUsd"],
  PX19: ["pmax.appListedShare", "pmax.appImpressionShare", "pmax.appMinImpressions"],
  TR01: [...LEARNING, "trends.declinePct"],
  TR01a: ["trends.declinePct"],
  TR05: ["trends.dormantDays", "floors.moderateConv"],
  TR06: [...LEARNING, "trends.zeroConvMinClicks"],
  TR08: ["trends.carryingMinSharePct", "trends.standoutMinSpendUsd"],
  TR09: ["trends.salesFallPct", "trends.declinePct"],
  TR10: [...WASTE_BANDS, ...LEARNING],
  SL01: ["slices.segmentCpaMultiple"],
  SL05: ["slices.deviceCpaMultiple", "slices.deviceMinClicks"],
  SL06: ["slices.deviceMinClicks", ...WASTE_BANDS],
  SL07: ["slices.segmentCpaMultiple"],
  SL09: ["slices.mobileCvrShare", "slices.deviceCvrMinClicks"],
  MI04: ["measurement.valueRulesShare"],
  MI06: [
    "measurement.viewThroughSharePct",
    "measurement.viewThroughInflatedPct",
    "floors.strongConv",
  ],
  MI16: ["measurement.zeroValuePurchaseMinConv"],
  SH01: ["shopping.disapprovedMaxPct"],
  SH03: ["shopping.topProductsSpendSharePct"],
  SH04: WASTE_BANDS,
  SH05: ["shopping.scaleRoasMultiple", "floors.strongConv"],
  SH06: ["shopping.missingAttrsMaxPct"],
  SH13: ["shopping.titleShortChars"],
  SH14: ["shopping.unlabelledMaxShare"],
  SH18: [...WASTE_BANDS, "floors.moderateConv"],
  SH20: ["shopping.cloneMinClicks"],
  SH21: ["shopping.breakEvenTolerance", ...WASTE_BANDS],
  SH23: WASTE_BANDS,
  PX05: WASTE_BANDS,
  PX07: WASTE_BANDS,
  PX15: ["pmax.pausedGroupsPct", "pmax.shapeMinGroups"],
  PX16: ["pmax.placementRollupMinShare", "pmax.placementRollupMinFloors", ...WASTE_BANDS],
  SL03: ["slices.countryRoasShare", "slices.countryMinClicks"],
  SL10: ["slices.multiCountryMinShare"],
  SL11: WASTE_BANDS,
  SL12: ["slices.languageMinShare"],
  PR04: ["localServices.leadDropShare", "localServices.leadTrendMinPrior"],
  PR05: ["localServices.disputeMinLeads", "localServices.disputeShare"],
  PR06: [
    "localServices.callsMin",
    "localServices.answerRateMin",
    "localServices.shortCallSeconds",
    "localServices.shortCallShare",
  ],
  PR07: ["localServices.expiryDays"],
  VD01: ["video.viewRateMin", "video.minImpressions"],
  VD02: ["video.quartileDropoffMax"],
  VD04: ["video.viewThroughSharePct"],
  VD07: ["video.cpvBandMinUsd", "video.cpvBandMaxUsd"],
  DG02: ["demandGen.minHeadlines", "demandGen.minDescriptions", "demandGen.minImagesWithoutVideo"],
  DG04: ["demandGen.channelConcentrationPct"],
  MI18: [
    "measurement.outageMinExpectedConv",
    "measurement.outageMinTrafficShare",
    "measurement.outageBaselineDays",
    "measurement.outageMinBaselineDays",
  ],
};

export interface CheckInfo {
  id: string;
  title: string;
  group: CheckGroup;
  claimKey: string;
  /** what a clean account looks like */
  noneFoundMeans: string | null;
  /** the tables / data keys the check needs; a missing one makes it not_run */
  requires: string[];
  /** requires plus every table it depends on through the model (parents, metric tables); any of them incomplete = no clean result */
  dependsOn: string[];
  /** the registry metrics it cites */
  metrics: string[];
  /** checks whose explanation must be ruled out before it may stand */
  confounders: string[];
  /** the highest severity it can reach */
  maxSeverity: Severity;
  /** false = it only feeds context and other checks, never a finding of its own */
  emitsFindings: boolean;
  /** the impact formula pricing its findings, or null for none */
  impactFormula: string | null;
  /** when it fires it states this line as `info` (a positive, a split, a note), never a finding */
  infoLine: string | null;
}

export interface CheckExplanation extends CheckInfo {
  /** the overridable settings this check reads, with their default values */
  settings: Record<string, number | string>;
}

function infoOf(def: CheckDefinition): CheckInfo {
  const policy = severityPolicyFor(def.id);
  return {
    id: def.id,
    title: def.title,
    group: def.group,
    claimKey: def.claimKey,
    noneFoundMeans: def.noneFoundMeans ?? null,
    requires: [...def.requires],
    dependsOn: effectiveRequires(def),
    metrics: [...def.metrics],
    confounders: [...def.confounders],
    maxSeverity: policy.maxSeverity,
    emitsFindings: emits(def.id),
    impactFormula: def.impactFormula,
    infoLine: def.noteOnly ?? null,
  };
}

/** Every shipped check, in registry order. */
export function listChecks(): CheckInfo[] {
  return ALL_CHECKS.map(infoOf);
}

/** One check in full, or null for an unknown id. */
export function explainCheck(id: string): CheckExplanation | null {
  // ids match whatever their case ("tr01a" is TR01a)
  const wanted = id.trim().toUpperCase();
  const def = ALL_CHECKS.find((c) => c.id.toUpperCase() === wanted) ?? null;
  if (!def) return null;
  const settings: Record<string, number | string> = {};
  for (const key of CHECK_SETTINGS[def.id] ?? []) {
    const [group, name] = key.split(".") as [keyof CheckSettings, string];
    const value = (DEFAULT_SETTINGS[group] as unknown as Record<string, number | string>)[name];
    if (value !== undefined) settings[key] = value;
  }
  return { ...infoOf(def), settings };
}
