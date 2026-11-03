// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Check contract — audit v3 evidence engine, build sheet §B.
 *
 * A check is a PURE function over the account model and the metric registry.
 * It decides ONE thing: does this signal exist in this account, on which entity,
 * with which numbers as evidence.
 *
 * A check does NOT:
 *   - decide severity or confidence          (scoring/ does, from what the check reports)
 *   - compute a dollar impact                (scoring/impact.ts does, from `facts`)
 *   - resolve its own confounders            (interactions/ does, driven by `confounders`)
 *   - write prose                            (the writer does, from the evidence bundle)
 *
 * That separation is the whole point of the redesign: the model used to do all
 * five jobs and got 5 of 22 findings wrong. See AUDIT_V3_HANDOVER.md §6.
 *
 * Binding rules a check MUST honour (handover §6):
 *   2. never report a signal as fact — return the evidence, let scoring decide
 *   3. population rule: only rows joined to a node of this audit exist
 *   4. empty is not clean: no marker → `not_checkable`, never `none_found`
 *   8. slice checks compute BOTH scopes and name the one they are about
 *   9. anything from a capped source is `sample.truncated`
 */
import type { BusinessType } from "../shared/businessType.js";
import type { JudgedPopulation } from "../roles.js";
import type { CurrencyScale } from "../shared/currencyScale.js";
import type { ClientContext } from "../shared/clientContext.js";
import type { CheckSettings } from "../settings.js";
import type { AccountModel } from "../model/nodes/AccountNode.js";
import type { AuditWindow } from "../model/windows.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import {
  type ActivityBearing,
  isReportable,
  reportableCampaigns,
} from "../registry/entityStatus.js";
import { applyAgeGate } from "./ageGate.js";
import { applyBrandGate } from "./brandGate.js";
import { applyBusinessTypeGate } from "./businessTypeGate.js";
import { applyClientConstraintGate, type AlwaysOnDeclaration } from "./clientContextGate.js";
import { applySpendTierGate } from "./spendTierGate.js";
import { applyVolumeFloorGate } from "./volumeFloorGate.js";
import { notCheckable as registryNotCheckable, populationOf } from "../registry/population.js";
import type {
  MetricArgs,
  MetricCtx,
  MetricNotComputable,
  MetricOk,
  MetricPayload,
  MetricValue,
} from "../registry/types.js";

/** §B section a check belongs to. */
export type CheckGroup =
  | "measurement" // B.1  MI — runs first; every other group may depend on it
  | "structure" // B.2  AS
  | "budget_bidding" // B.3  BB
  | "search" // B.4  SK
  | "pmax" // B.5  PX
  | "shopping" // B.6  SH
  | "slices" // B.7  SL
  | "trends" // B.8  TR
  | "presence" // B.9  PR
  | "carried_in" // B.10 checks carried in from the earlier planning docs
  | "cross_tree" // §G   findings that only exist by joining two trees
  | "demand_gen" // DG
  | "video"; // VD

/** What a finding is about. Rule 8: never omit this, and never widen it. */
export interface CheckScope {
  type:
    | "account"
    | "campaign"
    | "ad_group"
    | "keyword"
    | "search_term"
    | "ad"
    | "asset"
    | "extension"
    | "landing_page"
    | "asset_group"
    | "listing_group"
    | "product"
    | "product_group"
    | "placement"
    | "conversion_action"
    | "budget"
    | "negative_list"
    | "audience_signal"
    | "search_theme"
    | "search_category"
    | "channel"
    | "device"
    | "geo"
    | "hour"
    | "audience"
    | "demographic";
  id: string | null;
  name: string | null;
  /** Set when the scope sits inside a campaign; the writer puts this in the title. */
  campaignId?: string | null | undefined;
  campaignName?: string | null | undefined;
  /**
   * Set when the scope sits inside a PMax asset group (a product, a listing
   * group, a search theme, an audience signal). The activity gate reads it:
   * a product only serves if the asset group holding it is switched on, and
   * nothing checked that.
   */
  assetGroupId?: string | null | undefined;
  /**
   * One-click phase 1: set on a KEYWORD scope (SK01) — a keyword id is unique only
   * within its ad group, and the pause change must name both. Not part of the finding id.
   */
  adGroupId?: string | null | undefined;
  /**
   * Round 2 Y5: the finding is about these ASSETS inside the scope (model node
   * ids, `<assetGroupId>:<assetId>`), not the whole scope — e.g. one undersized
   * image in an asset group. Governed spend is then the assets' OWN spend and
   * never the group's (`governedSpendOf`); when Google reported no spend for
   * them the finding is unsized (null). Not part of the finding id.
   */
  sizedByAssetIds?: string[] | null | undefined;
  /**
   * The serving status of the scope.
   *
   * DEAD as of and kept only so old persisted findings still parse.
   * It used to be filled by the activity gate for a PAUSED-but-spent scope,
   * under rule 108: keep the finding, disclose the status. That rule is gone —
   * a non-live scope now produces no finding at all — so nothing sets this any
   * more and a live scope has nothing to caveat. Do not reintroduce a reader.
   */
  entityStatus?: string | null | undefined;
  /**
   * §3b: the instruction a writer receives for a finding on a campaign the
   * client context declares always-on. Filled by the client-context gate, never
   * by a check, and only when the caller passes `WriterHints.clientConstraint`.
   * It NEVER removes a finding.
   */
  clientConstraint?: string | null | undefined;
}

/** One number a finding is allowed to cite. The validator rejects any number not in this list. */
export interface EvidenceRef {
  /** metric id from the registry, e.g. 'C.util90'. */
  key: string;
  value: MetricPayload;
  unit: string;
  /** entity the number is about — used for the scope-pairing rule (handover §6.7). */
  entity: string | null;
  entityId: string | null;
  window: string | null;
  settledStrict: boolean | null;
  settledPractical: boolean | null;
  source: string;
  /** Rule 9: the metric came off a capped fetch. The writer's bundle prints ` (capped at N)` beside it. */
  truncated?: boolean | undefined;
  cap?: number | undefined;
  /** B1 (3a review): the metric's evaluation arguments, so the writer can name the leg (`field: HEADLINE`, `window: recent30`). `key` stays the registry id. */
  args?: Record<string, string | number> | undefined;
}

/**
 * One line of the per-entity table a finding may carry.
 *
 * `facts` is scalar and `evidence` is a flat citation list, so a finding that
 * quantified over N entities had nowhere to put the N. Checks were computing the
 * detail and throwing it away: PX14 ranked every asset group by spend and printed
 * one; PX15 knew the names of the paused groups and printed a count; SL02 held the
 * unattached audience lists and printed how many. What was left rode in `note`,
 * which is documented as a short MACHINE note and is not citable, so the writer
 * could not quote it and the reader never saw it.
 *
 * `cells` are the same `MetricPayload` scalars `facts` uses, so they render and
 * validate through the paths that already exist.
 */
export interface EvidenceRow {
  /** the thing this line is about — an asset group, a list, a keyword */
  entity: { id: string | null; name: string | null };
  /** an optional short label for the line, when the entity name is not the whole story */
  label?: string | undefined;
  /** column id → value. Every row of one finding should carry the same columns. */
  cells: Record<string, MetricPayload>;
}

/** Everything a check reports about one hit. Severity/impact/confidence are added downstream. */
export interface CheckFinding {
  claimKey: string;
  scope: CheckScope;
  /** every number behind this finding, in citation order */
  evidence: EvidenceRef[];
  /** named inputs for the impact formula named on the CheckDefinition */
  facts: Record<string, MetricPayload>;
  /**
   * `population` = how many entities this check actually JUDGED for this account,
   * i.e. the size of the candidate set the signal was tested against. It is the
   * denominator a reader needs to weigh "3 of 4" against "3 of 900".
   * It is NOT the loop index, and NOT the number of findings emitted: every
   * finding from one run of one check carries the SAME population.
   */
  sample: { truncated: boolean; population: number | null };
  settled: { strict: boolean; practical: boolean };
  markerState: "ok" | "provisional";
  /**
   * The per-entity table behind this finding, when it has one (phase 3). Rendered
   * by CODE, never by the writer — `renderCodeFields` carries it to the card and
   * the writer is told not to restate it in prose.
   */
  rows?: EvidenceRow[] | undefined;
  /** short machine note, not prose — e.g. 'brand campaign excluded' */
  note?: string | undefined;
  /**
   * Round 2 Y5: a per-finding ceiling under the check's own `maxSeverity`
   * (never above it), e.g. one small image whose own spend is unknown.
   */
  maxSeverity?: "info" | "opportunity" | "warning" | "critical" | undefined;
  /** Round 2 Y5: plain-words open items added to the candidate's (a thing we could not see). */
  openItems?: string[] | undefined;
  /**
   * Round 4 item 8: plain sentences naming what this check could NOT see that bears on
   * its conclusion. Unlike a generic open item, a limit travels with the finding to the
   * card: `assembleFinding` makes the summary and the action carry it, so neither the
   * card nor the brief (which reads both) can state the conclusion as a flat fact.
   * `openItems` above are treated as limits too (they are the same kind of sentence).
   */
  limitedBy?: string[] | undefined;
  /**
   * Round 4 R17: this finding's own label when it was judged on a narrower or different
   * basis than the check's title says (SK20 judged on return per $1 never says "converts
   * below"). Absent = the check's title.
   */
  title?: string | undefined;
}

export type CheckResult =
  /** the signal exists on these entities */
  | {
      state: "fires";
      findings: CheckFinding[];
      /**
       * Why findings were held back by a gate, in plain words. When a gate holds
       * back EVERY finding the check stays `fires` with no findings and the run
       * reports it suppressed with these reasons, never clean.
       */
      withheld?: string[] | undefined;
    }
  /**
   * checked properly, nothing to report — only legal when the population was real.
   * `evidence` is the STRUCTURED version of what `note` says in prose: the numbers
   * that made this account clean. `noneFoundMeans` needs them for the report's
   * positives, and a number that only exists inside a note string is a number the
   * gate cannot read (an account-negatives count was exactly that).
   * `subject` (L3 review): how many of the things the positive sentence is ABOUT exist in
   * the account (portfolio campaigns for BB08, proven campaigns for SK31). 0 = the sentence
   * would praise something the account does not have, so no positive ships. Absent = the
   * population is the subject.
   */
  | {
      state: "none_found";
      population: number | null;
      note?: string | undefined;
      evidence?: EvidenceRef[] | undefined;
      subject?: number | undefined;
    }
  /** rule 4/5: no marker, marker error, or population 0 of N */
  | {
      state: "not_checkable";
      reason: string;
      table?: string | undefined;
      category?: NotCheckableCategory | undefined;
    }
  /** a floor was not met (sample size, days, conversions) */
  | { state: "insufficient_data"; reason: string };

export interface CheckCtx {
  model: AccountModel;
  /** the registry context; pass to `evaluate` or use `get` below */
  metrics: MetricCtx;
  /** convenience wrapper over registry `evaluate(id, ctx, args)` */
  get(id: string, args?: MetricArgs): MetricValue;
  window: AuditWindow;
  currency: CurrencyScale;
  /**
   * A6 — how this account makes money, as `detectBusinessType` classified it.
   * Mirrors `ctx.model.attrs.businessType`; it is on the ctx because that is
   * where a check reaches for everything else. `'unknown'` means the account was
   * NOT classified and the type-gated checks abstain (rule 264).
   */
  businessType: BusinessType;
  /**
   * §3b — the client's own answers from the intake wizard, loaded once by
   * `pipeline/loadClientContext.ts` and passed straight through.
   *
   * OPTIONAL, and `null`/absent on any caller that has no database (every unit
   * suite). A check MUST behave exactly as it did before
   * this field existed when it is missing: nothing here is required to run a
   * check, it can only make an answer more specific. That is also why it is not
   * a required field — forcing forty hand-built test fixtures to pass `null`
   * would say the opposite of what the contract is.
   *
   * Every field on it carries `{value, source, asOf}`. Read it through
   * `checks/clientContextGate.ts`, not directly: that file is where the rule
   * "only `source: 'client'` is a declaration" lives.
   */
  clientContext?: ClientContext | null | undefined;
  /**
   * The days the change history covers (YYYY-MM-DD, inclusive), when the caller knows it.
   * A check that looks back further than this cannot judge "no recent change" and abstains.
   * Absent = unknown: checks behave as before.
   */
  changeHistoryCoverage?: { startDate: string; endDate: string } | null | undefined;
  /** the judgement thresholds for this run: defaults plus the caller's overrides (settings.ts). */
  settings: CheckSettings;
  /** the caller's writer text (`WriterHints`); absent = the gates add facts only, no instruction. */
  writerHints?: WriterHints | null | undefined;
}

/**
 * WHY a check could not run, as one of the fixed client-facing sentences in
 * `brief/buildNotChecked.ts`. The engine's raw reason is written
 * for us; until now the page classified it with regexes and printed "we do not
 * collect it yet" for everything unmatched, which called a dozen "this account
 * has none of those" outcomes our fault. A check states its category on the
 * result (per branch) or on the definition (when every not-checkable outcome
 * of the check shares one). The result wins.
 */
export type NotCheckableCategory =
  | "not_applicable" // spend tier: does not apply to an account of this size
  | "thin_data" // volume floor: ran, not enough traffic to judge fairly
  | "not_present" // the account does not run the thing being judged
  | "needs_client_data" // cost prices the client holds, Google does not
  | "needs_client_input" // an account-profile answer (brand terms) is empty
  | "google_withholds" // Google will not serve it to an outside tool
  | "no_history" // needs a window longer than the 90 days we hold
  | "nothing_to_compare" // only one of the thing exists
  | "our_gap" // a table / column / marker we do not have yet
  | "incomplete_data" // a table it depends on failed, was cut short or has unknown completeness
  | "could_not_run"; // the check threw

/**
 * A decision about one finding, in four parts: what to do, to what, where in
 * Google Ads, the other option and why. The checks in this package do NOT make
 * these: they say what is wrong. A `RemedyProvider` passed to `runChecks`
 * supplies them; without one, `Candidate.remediation` is never set.
 */
export interface Remediation {
  action: string;
  entity?: { id: string | null; name: string | null } | null | undefined;
  where?: string | undefined;
  alternative?: string | undefined;
  because: string;
}

/**
 * One check's decision about one of its findings, or null when it cannot
 * decide. Supplied by the caller, never by this package.
 */
export type RemedyFn = (finding: CheckFinding, ctx: CheckCtx) => Remediation | null;

/** Decisions by check id. Optional input to `runChecks`; absent = no `remediation` on any finding. */
export type RemedyProvider = Readonly<Record<string, RemedyFn>>;

/**
 * Text a report writer reads, supplied by the caller, never by this package.
 *
 *   clientConstraint   the instruction for a finding on a campaign the client context declares
 *                      always-on; null = none. The gate only calls it for a `fires` result; a
 *                      throw or a non-string result is ignored and the finding is unchanged.
 */
export interface WriterHints {
  clientConstraint?:
    ((checkId: string, declaration: AlwaysOnDeclaration) => string | null) | undefined;
}

export interface CheckDefinition {
  /** build sheet §B id, e.g. 'MI03', 'SK01', 'PX09'. */
  id: string;
  /** registry claim key — the regression gate matches on this, never on wording. */
  claimKey: string;
  /** short internal label; NOT the finding title (the writer writes that). */
  title: string;
  group: CheckGroup;
  /** metric ids this check reads. Declared so the validator and the writer know the allowed citations. */
  metrics: string[];
  /**
   * Check ids that must be resolved BEFORE this may fire (build sheet §B confounders column,
   * spec §8.3 influence table). Data, not code: interactions/ drives them.
   */
  confounders: string[];
  /** AccountData keys / tables whose read status + population gate this check. */
  requires: string[];
  /**
   * Tables whose MISSING rows could cancel a finding (not just hide one): when
   * one of them is incomplete the check reports not_checkable even if it fired.
   */
  needsCompleteData?: string[] | undefined;
  /** id of the formula in scoring/impact.ts, or null when the check carries no dollar figure. */
  impactFormula: string | null;
  /** §B "none found" column: what a clean account looks like, for the report's positives. */
  noneFoundMeans?: string | undefined;
  /**
   * Who this check is allowed to judge. Documentation the report
   * can print AND a contract a test holds the check to: the population on the
   * card must be the population declared here, so a check that judges only the
   * primary conversion action can never print "10 of 11".
   *
   * Absent means the check judges everything its `requires` tables carry, which
   * is right for a great many of them (an account-level setting has no role to
   * scope by). It is a declaration, not a filter: the check does the filtering,
   * through `roles.ts`, so metric and check can never disagree about what
   * "primary" means.
   */
  judges?: JudgedPopulation | undefined;
  /**
   * Default category for every not_checkable this check returns; a result's
   * own `category` overrides it. Set only when every not-checkable outcome of
   * the check is the same kind (a POAS view always needs cost prices).
   */
  notCheckableCategory?: NotCheckableCategory | undefined;
  /**
   * What the "What this covers" list on the report prints for this check.
   * `title` is an internal label ("a DSA campaign duplicates queries another
   * campaign already owns"); this is the client's sentence ("dynamic search ads
   * overlapping your other campaigns"). Absent → `clientLabelOf` de-jargons
   * the title minimally.
   */
  clientLabel?: string | undefined;
  /**
   * The check's SUBJECT is our own run — our sync depth, our window, our
   * change-history reach — not the account.
   * A candidate from such a check is placed `our_limit` before any metric
   * heuristic is consulted and never becomes a card: it goes to the "What we
   * could not check" block only. The Phase 1 heuristic (every metric in a
   * self-audit namespace) missed AS11 and SH15, which read one account metric
   * beside the self-audit one; the flag is the declaration the heuristic was
   * guessing at.
   *
   * The value is the reason IN PLAIN ENGLISH, printed to the customer verbatim
   * under "What we could not check". No check id,
   * no flag name, no metric id — a sentence a shop owner can read.
   */
  selfAudit?: string | undefined;
  /**
   * Plan 1.6: a $0 fact that is true and worth one line, never a
   * card ("seven people have access", "a target simulation exists"). The case
   * file places its candidate `context` with this reason, so it prints as a
   * short line under its entity (`renderPlacements`) and is kept out of the
   * editor's and the fallback ranker's pool (`withoutOurLimits`). Plain words,
   * no check id.
   */
  noteOnly?: string | undefined;
  /**
   * SK29: a `noteOnly` check's finding that carries this fact (set, not
   * empty) is a real finding, not a note: it is placed, ranked and written like
   * any other (`noteOnlyLineOf`). The fact must also be one of the claim key's
   * `fixFacts` (writer bundle.ts) so the editor and the stored finding see it.
   */
  noteOnlyUnlessFact?: string | undefined;
  /**
   * B6 (AS15): words added to the `noteOnly` line when the finding carries
   * `fact` as true, so the line people read states what the facts hold back
   * ("Performance Max app spend is not included").
   */
  noteOnlyAddendum?: { fact: string; line: string } | undefined;
  run(ctx: CheckCtx): CheckResult;
}

// ---------------------------------------------------------------------------
// Shared helpers — one implementation, so six check groups cannot diverge.
// ---------------------------------------------------------------------------

/**
 * The note line of a `noteOnly` check's finding, or undefined when the finding
 * is a real one: the check is not `noteOnly`, or the finding carries the
 * check's `noteOnlyUnlessFact` (SK29 with the keyword research's families).
 */
export function noteOnlyLineOf(
  def:
    | Pick<CheckDefinition, "noteOnly" | "noteOnlyUnlessFact" | "noteOnlyAddendum">
    | null
    | undefined,
  facts: Readonly<Record<string, unknown>> | null | undefined,
): string | undefined {
  if (!def?.noteOnly) return undefined;
  const key = def.noteOnlyUnlessFact;
  const v = key && facts ? facts[key] : undefined;
  if (v != null && v !== "") return undefined;
  const add = def.noteOnlyAddendum;
  return add && facts?.[add.fact] === true ? `${def.noteOnly}; ${add.line}` : def.noteOnly;
}

export function isOk(v: MetricValue): v is MetricOk {
  return (v as MetricNotComputable).reason === undefined;
}

export function notComputable(v: MetricValue): v is MetricNotComputable {
  return !isOk(v);
}

/** Numeric payload or null. NEVER coerces a missing value to 0 (rule: null for unknown). */
export function num(v: MetricValue): number | null {
  if (!isOk(v)) return null;
  return typeof v.value === "number" ? v.value : null;
}

export function str(v: MetricValue): string | null {
  if (!isOk(v)) return null;
  return typeof v.value === "string" ? v.value : null;
}

export function bool(v: MetricValue): boolean | null {
  if (!isOk(v)) return null;
  return typeof v.value === "boolean" ? v.value : null;
}

export function rows(v: MetricValue): Record<string, unknown>[] {
  if (!isOk(v)) return [];
  return Array.isArray(v.value) ? (v.value as Record<string, unknown>[]) : [];
}

/** Turn a metric result into a citable evidence row. Throws on a non-computable value:
 *  a check must test computability before it cites. */
export function evidence(
  v: MetricValue,
  entity?: { id: string | null; name: string | null },
): EvidenceRef {
  if (!isOk(v)) {
    throw new Error(
      `evidence() called on a non-computable metric ${v.id}: ${v.reason} (${v.detail})`,
    );
  }
  return {
    key: v.id,
    value: v.value,
    unit: v.unit,
    entity: entity?.name ?? null,
    entityId: entity?.id ?? v.entityId ?? null,
    window: v.window?.label ?? null,
    settledStrict: v.maturity.settledStrict,
    settledPractical: v.maturity.settledPractical,
    source: v.source.table,
    ...(v.sample.truncated
      ? { truncated: true, ...(v.sample.cap != null ? { cap: v.sample.cap } : {}) }
      : {}),
    ...(v.args && Object.keys(v.args).length > 0
      ? {
          args: Object.fromEntries(
            Object.entries(v.args).filter(
              ([, x]) => typeof x === "string" || typeof x === "number",
            ),
          ) as Record<string, string | number>,
        }
      : {}),
  };
}

/**
 * One cited metric, as citable evidence.
 *
 * Several registry ids are BUNDLES — `SL.device(scope)`, `C.window(w)`,
 * `SL.device_zero_conv(scope)` return a record, not a scalar. Emitted as a
 * single ref, the value was an object, so it rendered `[object Object]`, could
 * never match a regression claim value, and — worse — the Phase 3 validator's first
 * rule is "every number in the prose must match an evidence value", which means
 * the writer would have had NO citable figure for those findings and the
 * validator would have stripped every number from their text.
 *
 * So a bundle is expanded into one ref per numeric field, keyed `id.field`, the
 * way `C.spend` and `C.clicks` already are. Non-numeric fields are dropped
 * rather than stringified: evidence is for numbers a claim can be checked
 * against.
 */
export function expandEvidence(
  v: MetricValue,
  entity?: { id: string | null; name: string | null },
): EvidenceRef[] {
  const base = evidence(v, entity);
  const payload = base.value;
  if (payload instanceof Date) return [{ ...base, value: payload.toISOString().slice(0, 10) }];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [base];

  const fields = Object.entries(payload as Record<string, unknown>)
    .filter(([, val]) => typeof val === "number" && Number.isFinite(val))
    .map(([field, val]): EvidenceRef => ({
      ...base,
      key: `${base.key}.${field}`,
      value: val as number,
    }));

  // The bundle ref is KEPT alongside its fields, not replaced by them. The gate
  // maps a metric id to a regression claim key by exact match (`SL.device(scope)` ->
  // `device.cost`), so dropping the bare id silently unsatisfied all 14
  // verified-true claims. Additive: the claim mapping keeps working and the
  // writer gains numbers it can actually cite.
  return [base, ...fields];
}

/** 'provisional' wins: a finding is only 'ok' when every source it used had a marker. */
export function worstMarker(values: MetricValue[]): "ok" | "provisional" {
  return values.some((v) => isOk(v) && v.markerState === "provisional") ? "provisional" : "ok";
}

/** Rule 9: any capped source taints every node built from it. */
export function anyTruncated(values: MetricValue[]): boolean {
  return values.some((v) => isOk(v) && v.sample.truncated);
}

/** Rule 6: a finding is settled only when every conversion-bearing input is.
 *  Metrics with maturity 'N/A' carry no conversion number and do not vote. */
export function settledOf(values: MetricValue[]): { strict: boolean; practical: boolean } {
  const voting = values.filter((v): v is MetricOk => isOk(v) && v.maturity.settledStrict !== null);
  if (voting.length === 0) return { strict: true, practical: true };
  return {
    strict: voting.every((v) => v.maturity.settledStrict === true),
    practical: voting.every((v) => v.maturity.settledPractical === true),
  };
}

/** Build a finding from the metric values it cites, filling sample/settled/marker consistently. */
export function finding(args: {
  claimKey: string;
  scope: CheckScope;
  cite: MetricValue[];
  entity?: { id: string | null; name: string | null } | undefined;
  /**
   * Per-metric entity label, by metric id, for a finding that cites numbers about
   * DIFFERENT entity sets. Rule 7: `A.brand_spend_share` is about the brand set and
   * `A.spend` is about the account, and one `entity` for both mislabels one of them.
   * Overrides `entity` for the ids it names.
   */
  entityByMetric?: Record<string, { id: string | null; name: string | null }> | undefined;
  /**
   * Cite entries that carry their OWN entity label, for a finding whose numbers are
   * about different entities under the SAME metric id — SL06 cites `SL.device(scope)`
   * once per device, and one label for all of them would be a lie about all but one.
   * A `null` value is dropped, exactly as a non-computable `cite` entry is.
   */
  citeLabelled?:
    | Array<{ value: MetricValue | null; entity: { id: string | null; name: string | null } }>
    | undefined;
  facts?: Record<string, MetricPayload> | undefined;
  /** entities judged in this run — the same value for every finding the run emits. */
  population?: number | null | undefined;
  /** phase 3: the per-entity table behind this finding. See `EvidenceRow`. */
  rows?: EvidenceRow[] | undefined;
  note?: string | undefined;
}): CheckFinding {
  const {
    claimKey,
    scope,
    cite,
    entity,
    entityByMetric,
    citeLabelled,
    facts,
    population,
    rows,
    note,
  } = args;
  const labelled = (citeLabelled ?? []).filter(
    (c): c is { value: MetricValue; entity: { id: string | null; name: string | null } } =>
      c.value != null && isOk(c.value),
  );
  // every cited value votes on sample / settled / marker, however it was labelled
  const all: MetricValue[] = [...cite, ...labelled.map((c) => c.value)];
  return {
    claimKey,
    scope,
    evidence: [
      ...cite.filter(isOk).flatMap((v) => expandEvidence(v, entityByMetric?.[v.id] ?? entity)),
      ...labelled.flatMap((c) => expandEvidence(c.value, c.entity)),
    ],
    facts: facts ?? {},
    sample: { truncated: anyTruncated(all), population: population ?? null },
    settled: settledOf(all),
    markerState: worstMarker(all),
    ...(rows && rows.length > 0 ? { rows } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * Rule 4/5 gate. Call FIRST in every `run`; return its result when non-null.
 *
 * Delegates to the registry's own three-step rule (registry/population.notCheckable),
 * which is the single definition of "can this table be judged":
 *   - marker error or skipped            → not checkable
 *   - rows exist but none joined a node   → not checkable (population rule)
 *   - marker ok                           → checkable, findings are 'ok'
 *   - rows but no marker                  → checkable, findings are 'provisional'
 *   - zero rows and no marker             → not checkable, NEVER "none found"
 *
 * The distinction that matters: "rows but no marker" is PROVISIONAL, not unknown.
 * Gating it out would make every check on an account without marker rows report
 * "cannot check", which is how this helper was first written and was wrong.
 */
/**
 * Written on a table the snapshot did not read because the account runs no campaign of the
 * kind the table describes (no Shopping campaign, no video campaign ...). A check gated on such
 * a table is not run as "not present", never clean.
 */
export const NO_CAMPAIGN_OF_KIND = "the account runs no campaign of this kind, so it was not read";

/**
 * The status-row note a reader writes for Merchant Center data it never reads (the Google
 * Ads API does not serve it and no Merchant Center API is called). A check that needs such
 * a table says so in one shared sentence.
 */
export const MERCHANT_CENTER_NOT_READ =
  "this server reads the Google Ads API only and calls no Merchant Center API";

export function gateOnData(
  ctx: CheckCtx,
  tables: string[],
): {
  state: "not_checkable";
  reason: string;
  table?: string;
  category: NotCheckableCategory;
} | null {
  for (const table of tables) {
    const verdict = registryNotCheckable(ctx.model, ctx.metrics.markers, table);
    if (verdict.notCheckable) {
      const m = ctx.metrics.markers.get(table);
      const said = (text: string) => (m?.message ?? "").includes(text);
      const notReadBy = m?.status === "error" || m?.status === "skipped";
      // a table not read because nothing of its kind runs is the account's (not present);
      // Merchant Center data we never read, or rows that join nothing in the model, are OUR
      // gap; a read that failed, was cut short or left no status at all is incomplete data
      const category: NotCheckableCategory =
        m?.status === "skipped" && said(NO_CAMPAIGN_OF_KIND)
          ? "not_present"
          : m?.status === "skipped" && said(MERCHANT_CENTER_NOT_READ)
            ? "our_gap"
            : notReadBy || populationOf(ctx.model, table).rows === 0
              ? "incomplete_data"
              : "our_gap";
      return {
        state: "not_checkable",
        reason: verdict.reason ?? `${table} is not checkable`,
        table,
        category,
      };
    }
  }
  return null;
}

/**
 * The reason a check gives when `T.waste_floor` has no value. The bar is ∞ (never
 * null) when the currency is unknown, so a missing bar always means the spend or the
 * window was missing: say that, never "currency unknown".
 */
export function wasteFloorReason(v: MetricValue): string {
  return isOk(v)
    ? "the money bar for calling anything wasted could not be worked out"
    : `the money bar for calling anything wasted could not be worked out: ${v.detail}`;
}

// ---------------------------------------------------------------------------
// A1 — the entity activity gate (rules 107, 108, 142, 342, 345, 383, 384, 392)
// ---------------------------------------------------------------------------

/**
 * The campaign set a check may iterate, count and name. Rule 384: a dormant
 * campaign never appears in an "X of Y" count.
 *
 * Every check that walks campaigns goes through this, so the rule cannot be
 * applied in twelve slightly different ways.
 */
export function campaignsOf(ctx: CheckCtx): CampaignNode[] {
  return reportableCampaigns(ctx.model);
}

/**
 * Impression share a campaign loses to its budget NOW, the figure BB02 judges on: the
 * window's last 3 weeks when they were read, the 90-day share only when they were not.
 * A launch-week limit is not a limit today. `idle` = the recent weeks were read and the
 * campaign had no activity in them: nothing is held back by its budget today (value null).
 */
export function lostIsBudgetNow(
  ctx: CheckCtx,
  campaignId: string,
): { metric: MetricValue; value: number | null; idle: boolean } {
  const lost90 = ctx.get("C.lost_is_budget_pct", { campaignId });
  const recent = ctx.get("C.lost_is_budget_recent_pct", { campaignId });
  if (isOk(recent)) return { metric: recent, value: num(recent), idle: false };
  // insufficient_data = the weeks were read and the campaign had no activity in them
  // (not_checkable = not read, or no impression-share row at all)
  if (!isOk(recent) && recent.reason === "insufficient_data" && isOk(lost90))
    return { metric: recent, value: null, idle: true };
  return { metric: lost90, value: num(lost90), idle: false };
}

/** The entities whose status decides whether a finding may exist: the scope itself, and the campaign it sits in. */
function activityParts(
  ctx: CheckCtx,
  scope: CheckScope,
): Array<{ node: ActivityBearing; args: MetricArgs; id: string; name: string }> {
  const idx = ctx.metrics.index;
  const out: Array<{ node: ActivityBearing; args: MetricArgs; id: string; name: string }> = [];
  const add = (
    node: (ActivityBearing & { id: string; name: string }) | null | undefined,
    args: MetricArgs,
  ) => {
    if (!node) return;
    if (out.some((p) => p.id === node.id)) return;
    out.push({ node, args, id: node.id, name: node.name });
  };

  // The entity itself, and every container above it: a PAUSED asset group
  // inside an ENABLED campaign must not carry a finding either.
  if (scope.id) {
    if (scope.type === "campaign") add(idx.campaignsById.get(scope.id), { campaignId: scope.id });
    else if (scope.type === "ad_group")
      add(idx.adGroupsById.get(scope.id), { adGroupId: scope.id });
    else if (scope.type === "keyword") add(idx.keywordsById.get(scope.id), { keywordId: scope.id });
    else if (scope.type === "ad") add(idx.adsById.get(scope.id), { adId: scope.id });
    else if (scope.type === "asset_group")
      add(idx.assetGroupsById.get(scope.id), { assetGroupId: scope.id });
    else if (scope.type === "extension")
      add(idx.extensionsById.get(scope.id), { extensionId: scope.id });
    else if (scope.type === "conversion_action")
      add(idx.conversionActionsById.get(scope.id), { actionId: scope.id });
  }
  // An asset group's own status also gates everything hanging off it — a
  // listing group or product only serves if the group that contains it does.
  if (scope.assetGroupId)
    add(idx.assetGroupsById.get(scope.assetGroupId), { assetGroupId: scope.assetGroupId });
  // rule 345: the activity filter is load-bearing DOWNWARD too — 22 low-QS
  // keywords once fired, and every one of them sat in a paused campaign.
  const campaignId = scope.type === "campaign" ? scope.id : (scope.campaignId ?? null);
  if (campaignId) add(idx.campaignsById.get(campaignId), { campaignId });
  return out;
}

/**
 * Drop a finding unless every entity it depends on is LIVE. A scope the model
 * cannot resolve is left alone: that is an unknown IDENTITY, not an unknown
 * status, and the checks that build synthetic scope ids (slices, channels,
 * hours) carry no serving status of their own.
 *
 * Previously a `recently-active` scope (PAUSED, but with spend in the
 * 90-day window) kept its finding and was merely STAMPED with the status, on
 * the theory that the writer would disclose it. That does not work: a
 * disclosure in the details does not repair a headline that says money is
 * being spent every month. A paused
 * campaign spends nothing; a per-month rate about it is not a caveat away from
 * true, it is false. So `isReportable` is now `=== 'live'` and this gate drops
 * them, which also means `scope.entityStatus` is never set from here any more.
 */
/**
 * N12: the checks that may still speak about a live campaign that spent $0 in the window:
 * the ones that can explain why it does not deliver (budget unused, a target holding it
 * back, a starving shared budget, no ads or disapproved ones, products that cannot show or
 * never served, a Performance Max asset group short of assets or images, a negative that
 * blocks the account's own keyword, two Shopping campaigns at one priority, a campaign
 * bidding on another goal, a Demand Gen campaign with no goal or too few assets). No check
 * reads billing, a $0 budget, a campaign with no keywords or a bid too low to serve yet:
 * those reasons are not covered here. Everything else about a campaign
 * that spent nothing (its location setting, a running experiment, a missing frequency cap)
 * describes traffic that does not exist.
 */
export const DELIVERY_BLOCKER_CHECKS: ReadonlySet<string> = new Set([
  "BB01",
  "BB04",
  "BB05",
  "AS03",
  "SK11",
  "SK15",
  "PX17",
  "SH01",
  "SH17",
  "DG01",
  "DG02",
  "PX03",
  "PX13",
  "SH10",
  "SH19",
  "SK33",
  "MI07",
]);

/** The name of the campaign a finding sits in when that campaign spent exactly $0 in the window. */
function idleCampaignOf(ctx: CheckCtx, f: CheckFinding): string | null {
  const id = f.scope.type === "campaign" ? f.scope.id : (f.scope.campaignId ?? null);
  if (!id) return null;
  const c = ctx.metrics.index.campaignsById.get(id);
  // unknown spend (null) is not "spent nothing"
  return c && c.windows.m90.cost === 0 ? c.name : null;
}

function gateFinding(ctx: CheckCtx, f: CheckFinding): CheckFinding | null {
  const parts = activityParts(ctx, f.scope);
  if (parts.length === 0) return f;
  return parts.every((p) => isReportable(p.node)) ? f : null;
}

/**
 * Every check runs behind the gate. It is applied HERE, at definition time,
 * rather than in the engine loop, so a check imported straight from its group
 * module (which is how the unit suites call them) cannot bypass it.
 */
export function applyActivityGate(ctx: CheckCtx, r: CheckResult, checkId?: string): CheckResult {
  if (r.state !== "fires") return r;
  const kept: CheckFinding[] = [];
  let notRunning = 0;
  let idleCount = 0;
  const idle: string[] = [];
  for (const f of r.findings) {
    const g = gateFinding(ctx, f);
    if (!g) {
      notRunning++;
      continue;
    }
    // N12: a live campaign that spent $0 keeps only the findings that explain why
    const quiet = checkId && !DELIVERY_BLOCKER_CHECKS.has(checkId) ? idleCampaignOf(ctx, g) : null;
    if (quiet) {
      idleCount++;
      if (!idle.includes(quiet)) idle.push(quiet);
      continue;
    }
    kept.push(g);
  }
  /**
   * `kept` may be EMPTY, and the state deliberately stays `fires`.
   *
   * The alternative is `none_found`, and `none_found` is how a check earns a
   * POSITIVE: `positives.ts` prints its `noneFoundMeans` verbatim. BB04's is
   * "Every bidding target is achievable"; if the only campaign that fails it
   * is paused, turning the gate's silence into
   * `none_found` would print that positive — a false claim, and a worse one
   * than the finding we just suppressed, because a positive reads as a clean
   * bill of health. `fires` with no findings claims nothing at all, which is
   * exactly right: we found something and we are not allowed to say it.
   *
   * The engine's `counts.fired` therefore ignores an emptied check (see
   * runEvidenceEngine step 4/5) so the stat stays a count of checks that
   * actually produced a candidate.
   */
  const lines = [
    ...(kept.length === 0 && notRunning > 0
      ? [
          `${notRunning} finding(s) held back: each was about a campaign, ad group or keyword that is not running`,
        ]
      : []),
    ...(idleCount > 0
      ? [
          `${idleCount} finding(s) held back: each was about a campaign that spent nothing in the 90 days read (${idle.join(", ")})`,
        ]
      : []),
  ];
  const withheld = [...(r.withheld ?? []), ...lines];
  return { state: "fires", findings: kept, ...(withheld.length > 0 ? { withheld } : {}) };
}

/**
 * The gate chain, in the order it must run, all applied HERE and not in the
 * engine loop so a check imported straight from its group module (which is how
 * the unit suites call them) cannot bypass any of it.
 *
 *   A6 businessTypeGate — OUTERMOST, and one of the two that can stop the check
 *      from running at all. It has to be: several Shopping checks already fail
 *      on a lead-gen account because their `requires` name Merchant Center
 *      tables, and the point of the gate is to replace that misleading "no
 *      data" reason with "this account is not e-commerce".
 *   D6 spendTierGate   — the other one that stops the check running. Account
 *      size, like business type, is a property of the ACCOUNT, so there is
 *      nothing per-finding to weigh. It sits INSIDE the business-type gate
 *      because "this is not an e-commerce account" is the more fundamental
 *      answer: a lead-gen account should not be told its size decided anything
 *      about its product feed.
 *   A1 activityGate    — drops findings on dormant entities, stamps paused ones.
 *   A5 brandGate       — drops findings that must not be made about brand.
 *   B1 ageGate         — holds verdicts on campaigns under the learning age.
 *   B3 volumeFloorGate — holds verdicts on assets with too little traffic behind
 *      them. It runs after the age gate because both can empty a check and the
 *      age answer is the more fundamental one: a campaign too young to judge is
 *      why the asset has no traffic, not a second independent reason.
 *   A7 clientConstraintGate — INNERMOST, and the only gate that never removes
 *      anything. It runs last because it rewrites the ASK of a finding that has
 *      already survived every other gate; running it earlier would let it stamp
 *      an instruction onto findings that are about to be dropped.
 *
 * The four inner gates all filter FINDINGS, so their order among themselves is
 * only about which note a reader sees first — except that the volume floor, and
 * only the volume floor, turns an emptied check into `not_checkable` rather
 * than `none_found`. See volumeFloorGate.ts for why the two differ.
 */
export function defineCheck(def: CheckDefinition): CheckDefinition {
  return {
    ...def,
    run: (ctx: CheckCtx) =>
      applyBusinessTypeGate(def.id, ctx, () =>
        applySpendTierGate(def.id, ctx, () =>
          applyClientConstraintGate(
            def.id,
            ctx,
            applyVolumeFloorGate(
              def.id,
              ctx,
              applyAgeGate(
                def.id,
                ctx,
                applyBrandGate(def.id, ctx, applyActivityGate(ctx, def.run(ctx), def.id)),
              ),
            ),
          ),
        ),
      ),
  };
}
