// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The three translations between the evidence layers — Phase 1h §1.3.
 *
 * The five Phase 1 layers were built to narrow, deliberately unshared
 * interfaces so no agent could reach across a boundary. Three pairs are
 * structurally different and the coordinator owns the translation:
 *
 *   1. metric lookup  registry `evaluate(metrics, id, args)` is a function over
 *                     an explicit ctx; interactions and scoring each want a
 *                     `get(id, scope?)` object, and their `MetricValue` shapes
 *                     are not the registry's.
 *   2. scope          `CheckScope` (snake_case type + nullable id) →
 *                     interactions `NodeRef` (NodeKind + dimension/key) →
 *                     scoring `NodeRef` (NodeKind + REQUIRED id).
 *   3. sample         the check's numeric `sample.population` → the scoring
 *                     layer's `SampleSummary` enum, via `toSampleSummary`.
 *
 * The rule that governs all of it: an unmappable scope returns NOTHING and is
 * logged. It never falls through to account scope. That fall-through is the
 * defect that once priced one wasteful product at the whole account's spend,
 * at CRITICAL.
 */
import type { CheckScope } from "./checks/types.js";
import type {
  MetricLookup as InteractionsMetricLookup,
  MetricValue as InteractionsMetricValue,
  NodeRef as InteractionsNodeRef,
} from "./interactions/types.js";
import type { SliceDimension } from "./model/nodes/Slice.js";
import type { NodeKind } from "./model/types.js";
import { evaluate, getMetric } from "./registry/metrics.js";
import type {
  MetricArgs,
  MetricCtx,
  NotComputableReason,
  MetricValue as RegistryMetricValue,
} from "./registry/types.js";
import type {
  MetricLookup as ScoringMetricLookup,
  MetricValue as ScoringMetricValue,
  NodeRef as ScoringNodeRef,
  NotComputable as ScoringNotComputable,
  SampleSummary,
} from "./scoring/types.js";
import { toSampleSummary } from "./scoring/types.js";

// ---------------------------------------------------------------------------
// 2. scope
// ---------------------------------------------------------------------------

/**
 * `CheckScope['type']` → model `NodeKind`. ONE map, owned by governedSpend.ts
 * and shared with the case file (review: a third copy here had
 * drifted from a snake_case one that missed every translation).
 */
/** The model node kind each scope type points at. */
const SCOPE_KIND: Readonly<Record<CheckScope["type"], NodeKind | null>> = {
  account: "account",
  campaign: "campaign",
  ad_group: "adGroup",
  keyword: "keyword",
  search_term: "searchTerm",
  ad: "ad",
  asset: "asset",
  extension: "extension",
  landing_page: "landingPage",
  asset_group: "assetGroup",
  listing_group: "listingGroup",
  product: "product",
  product_group: "productGroup",
  placement: "placement",
  conversion_action: "conversionAction",
  budget: "budget",
  negative_list: "negativeList",
  audience_signal: "audienceSignal",
  search_theme: "searchTheme",
  search_category: "searchCategory",
  channel: "channelSlice",
  device: "slice",
  geo: "slice",
  hour: "slice",
  audience: "slice",
  demographic: "slice",
};

/** The slice dimension a slice-shaped `CheckScope['type']` means. */
const SCOPE_DIMENSION: Readonly<Partial<Record<CheckScope["type"], SliceDimension>>> = {
  device: "device",
  geo: "geo",
  hour: "hour",
  audience: "audience",
  demographic: "demographic",
};

/**
 * The slice family a scope belongs to, or null when it belongs to none.
 *
 * `params.sliceKind` is how IMP_WASTE_90 and IMP_CPA_GAP find the metric ids
 * for a slice at all (§A.8 keys those by family, not by node). The runner never
 * passed it, so the waste formula had no spend basis for any slice and the CPA
 * gap formula defaulted to `device` for EVERY scope — a demographic finding
 * reaching for a device metric. A non-slice scope must pass nothing and the
 * formula must decline.
 */
export function sliceKindForScope(scope: CheckScope): SliceDimension | null {
  return SCOPE_DIMENSION[scope.type] ?? null;
}

export interface UnmappableScope {
  scope: CheckScope;
  reason: string;
}

/**
 * Every scope ONE run refused, in order. The runner reports them by name.
 *
 * It is a per-run array and never module state: two audits running in the same
 * process would otherwise append to the same list, and each would report the
 * other's refusal reasons beside its own findings.
 */
export type RefusalLog = UnmappableScope[];

export function createRefusalLog(): RefusalLog {
  return [];
}

function refuse(scope: CheckScope, reason: string, refusals: RefusalLog): null {
  refusals.push({ scope, reason });
  return null;
}

/**
 * `CheckScope` → the interactions `NodeRef`.
 * Slice scopes carry `dimension` + `key` (that is what the matrix resolvers
 * read); `id` stays null because a slice node id is
 * `${scope}:${campaignId ?? 'account'}:${dimension}:${key}` and the resolver
 * builds it itself.
 */
export function toInteractionsScope(
  scope: CheckScope,
  refusals: RefusalLog,
): InteractionsNodeRef | null {
  const kind = SCOPE_KIND[scope.type];
  if (!kind) return refuse(scope, `no model NodeKind for scope type '${scope.type}'`, refusals);

  const dimension = SCOPE_DIMENSION[scope.type];
  if (kind === "slice") {
    const key = scope.id ?? scope.name;
    if (!key)
      return refuse(scope, "a slice scope with neither id nor name names no segment", refusals);
    return {
      kind,
      id: null,
      ...(dimension ? { dimension } : {}),
      key,
      ...(scope.campaignId ? { campaignId: scope.campaignId } : {}),
      scope: scope.campaignId ? "campaign" : "account",
    };
  }

  if (kind === "account") {
    if (scope.id == null && scope.name != null) return refuse(scope, ACCOUNT_SET_REFUSAL, refusals);
    return { kind, id: scope.id ?? null, scope: "account" };
  }

  // A check may scope a finding at a SET ("278 of 500 products"), which has an
  // id of null and a name. That is still a nameable scope, so it is carried
  // through under its name: `locate` simply finds no node, every resolver sees
  // null, and the registry answers `no_entity` for every entity metric — it can
  // never silently answer at account level (verified: Pr.spend / L.spend /
  // C.spend all return `no_entity` for an id that matches nothing). A scope
  // with NEITHER an id nor a name names nothing at all, and is refused.
  const id = scope.id ?? scope.name;
  if (!id)
    return refuse(
      scope,
      `a ${scope.type} scope carries neither id nor name, so it names no entity`,
      refusals,
    );
  return {
    kind,
    id,
    ...(scope.campaignId ? { campaignId: scope.campaignId } : {}),
    scope: scope.campaignId ? "campaign" : "account",
  };
}

/**
 * A scope of type `account` that carries a NAME but no id does not name the
 * account — it names a set inside it ("278 of 500 products"). `A.spend` and
 * every other account metric ignore the entity id, so letting that through
 * would price the set at the whole account's spend.
 */
const ACCOUNT_SET_REFUSAL =
  "an account scope with a name but no id names a set inside the account, not the account — every account metric ignores the entity id, so it would be priced at the whole account";

/**
 * `CheckScope` → the scoring `NodeRef`, whose `id` is REQUIRED.
 * An account scope resolves to the literal id `'account'`; anything else with
 * no id is refused, because an impact formula would otherwise resolve its
 * inputs at whatever level `metrics.get` defaults to — i.e. the account.
 *
 * `campaignId` / `campaignName` travel with it: they are what lets a slice be
 * priced against its own campaign rather than the account.
 */
export function toScoringScope(scope: CheckScope, refusals: RefusalLog): ScoringNodeRef | null {
  const kind = SCOPE_KIND[scope.type];
  if (!kind) return refuse(scope, `no model NodeKind for scope type '${scope.type}'`, refusals);
  const campaign = {
    ...(scope.campaignId ? { campaignId: scope.campaignId } : {}),
    ...(scope.campaignName ? { campaignName: scope.campaignName } : {}),
  };
  if (kind === "account") {
    if (scope.id == null && scope.name != null) return refuse(scope, ACCOUNT_SET_REFUSAL, refusals);
    return {
      kind,
      id: scope.id ?? "account",
      ...(scope.name ? { name: scope.name } : {}),
      ...campaign,
    };
  }

  const id = scope.id ?? scope.name;
  if (!id)
    return refuse(
      scope,
      `a ${scope.type} scope carries neither id nor name, so no money may be priced on it`,
      refusals,
    );
  return { kind, id, ...(scope.name ? { name: scope.name } : {}), ...campaign };
}

/** The interactions `NodeRef` → the registry's entity arguments. */
export function toMetricArgs(scope: InteractionsNodeRef | undefined): MetricArgs {
  if (!scope) return {};
  const id = scope.id ?? undefined;
  const campaign = scope.campaignId ? { campaignId: scope.campaignId } : {};
  switch (scope.kind) {
    case "account":
      return {};
    case "campaign":
      return id ? { campaignId: id } : {};
    case "adGroup":
      return { ...campaign, ...(id ? { adGroupId: id } : {}) };
    case "keyword":
      return { ...campaign, ...(id ? { keywordId: id } : {}) };
    case "searchTerm":
      return { ...campaign, ...(id ? { searchTermId: id } : {}) };
    case "ad":
      return { ...campaign, ...(id ? { adId: id } : {}) };
    case "asset":
      return { ...campaign, ...(id ? { assetId: id } : {}) };
    case "extension":
      return { ...campaign, ...(id ? { extensionId: id } : {}) };
    case "landingPage":
      return { ...(id ? { landingPageId: id } : {}) };
    case "assetGroup":
      return { ...campaign, ...(id ? { assetGroupId: id } : {}) };
    case "product":
      return { ...campaign, ...(id ? { productId: id } : {}) };
    case "placement":
      return { ...campaign, ...(id ? { placementId: id } : {}) };
    case "conversionAction":
      return { ...(id ? { actionId: id } : {}) };
    case "slice":
      return {
        ...campaign,
        ...(scope.key ? { key: scope.key } : {}),
        scope: scope.campaignId ? "campaign" : "account",
      };
    default:
      // budget / negativeList / listingGroup / productGroup / searchTheme /
      // searchCategory / audienceSignal / channelSlice / bidModifier /
      // videoMetrics: the registry has no entity argument for them, so the
      // metric is asked at the campaign it hangs off, never re-scoped silently.
      return campaign;
  }
}

// ---------------------------------------------------------------------------
// 1. metric lookup
// ---------------------------------------------------------------------------

/** Registry value → the interactions view. Structurally compatible; this is the cast, named. */
export function toInteractionsMetric(v: RegistryMetricValue): InteractionsMetricValue {
  if (v.reason !== undefined) {
    return v.code === undefined
      ? { id: v.id, value: null, reason: v.reason, detail: v.detail }
      : { id: v.id, value: null, reason: v.reason, detail: v.detail, code: v.code };
  }
  return {
    id: v.id,
    value: v.value,
    ...(v.note ? { note: v.note } : {}),
    source: {
      table: v.source.table,
      ...(v.source.rowCount != null ? { rowCount: v.source.rowCount } : {}),
    },
  };
}

/**
 * Registry value → the scoring view.
 *
 * Two real differences, not casts:
 *   - the scoring layer's `value` is a scalar; a row[] / enum-map payload has
 *     no scalar reading, so it becomes `null` rather than a made-up number;
 *   - `settledStrict` / `settledPractical` are booleans there and nullable
 *     here. `null` means the metric carries no conversion number and does not
 *     vote on settledness (checks/types `settledOf`), so it maps to `true`.
 */
export function toScoringMetric(v: RegistryMetricValue): ScoringMetricValue | ScoringNotComputable {
  if (v.reason !== undefined) {
    return { id: v.id, notComputable: true, reason: `${v.reason}: ${v.detail}` };
  }
  const scalar =
    typeof v.value === "number" || typeof v.value === "string" || typeof v.value === "boolean"
      ? v.value
      : null;
  return {
    id: v.id,
    value: scalar,
    settledStrict: v.maturity.settledStrict ?? true,
    settledPractical: v.maturity.settledPractical ?? true,
    truncated: v.sample.truncated,
    population: "real",
    ...(v.floor ? { floors: [v.floor] } : {}),
    source: {
      table: v.source.table,
      ...(v.source.rowCount != null ? { rowCount: v.source.rowCount } : {}),
    },
  };
}

/**
 * One adapter, two exports: the registry's `evaluate` behind the two `get`
 * interfaces the interaction matrix and the scoring layer each declared.
 *
 * The scoring lookup takes a scoring `NodeRef`, which has no slice dimension,
 * so it is widened back through `SCOPE_KIND`'s inverse only where the kind
 * carries an entity argument. A slice asked at scoring level therefore reaches
 * the registry as `{ key }` — the same key the check put in `scope.id`.
 */
export function makeMetricLookups(metrics: MetricCtx): {
  forInteractions: InteractionsMetricLookup;
  forScoring: ScoringMetricLookup;
} {
  return {
    forInteractions: {
      get(id: string, scope?: InteractionsNodeRef) {
        return toInteractionsMetric(evaluateMetricId(metrics, id, toMetricArgs(scope)));
      },
    },
    forScoring: {
      get(id: string, scope?: ScoringNodeRef) {
        return toScoringMetric(
          evaluateMetricId(metrics, id, toMetricArgs(scoringToInteractionsScope(scope))),
        );
      },
    },
  };
}

/**
 * The scoring `NodeRef` back into the interactions shape the registry argument
 * builder reads. A slice's key is its id, and `campaignId` decides whether the
 * slice family is read at campaign or at account scope — dropping it is what
 * made every slice resolve `C.*` as `no_entity`.
 */
export function scoringToInteractionsScope(
  scope: ScoringNodeRef | undefined,
): InteractionsNodeRef | undefined {
  if (!scope) return undefined;
  const slice = scope.kind === "slice" || scope.kind === "channelSlice";
  return {
    kind: scope.kind,
    id: slice ? null : scope.id,
    ...(slice ? { key: scope.id } : {}),
    ...(scope.campaignId ? { campaignId: scope.campaignId } : {}),
    scope: scope.campaignId ? "campaign" : "account",
  };
}

// ---------------------------------------------------------------------------
// 1b. composite metric ids
// ---------------------------------------------------------------------------

/**
 * The build sheet names one number per id (`SL.device().cost`,
 * `C.window(30d).cost`); the registry defines the whole payload under one
 * parameterised id (`SL.device(scope)`, `C.window(w)`). This is the ONE
 * translation between the two, and it is a table plus a strict parse — never a
 * family guess. An id that is not in it does not resolve, and the lookup
 * answers `not_implemented` rather than reaching for a neighbouring metric.
 *
 * Until this existed, `IMP_SCALE`, `IMP_LOSTIS` and `IMP_WASTE_30` declared
 * `C.window().cost`, which is in no registry, so those three formulas could
 * never return a number on any account.
 */
const PAYLOAD_METRIC_IDS: Readonly<Record<string, string>> = {
  "SL.device()": "SL.device(scope)",
  "SL.geo()": "SL.geo(scope, country)",
  "SL.demo()": "SL.demo(scope, type, value)",
  "SL.audience()": "SL.audience(scope, criterion)",
  "SL.dow()": "SL.dow(scope, day)",
  "SL.hour()": "SL.hour(scope, hour)",
  "SL.dow_hour()": "SL.dow_hour(scope, day, hour)",
  "C.window()": "C.window(w)",
  "A.roas_window()": "A.roas_window(w)",
};

/** The parenthesised argument of a windowed payload id is the window name. */
const WINDOWED_PAYLOADS: ReadonlySet<string> = new Set(["C.window(w)", "A.roas_window(w)"]);

export interface CompositeMetricId {
  /** the registry id that actually resolves */
  registryId: string;
  /** the field of its payload the sheet id names */
  field: string;
  /** arguments carried by the id itself (the window name), not by the scope */
  args: MetricArgs;
}

/** `C.window(30d).cost` → `{ C.window(w), cost, {window:'30d'} }`; null when the id names nothing. */
export function resolveCompositeMetricId(id: string): CompositeMetricId | null {
  const m = /^([A-Za-z_.]+)\(([^)]*)\)\.([A-Za-z_]+)$/.exec(id);
  if (!m) return null;
  const base = m[1] ?? "";
  const argText = m[2] ?? "";
  const field = m[3] ?? "";
  const registryId = PAYLOAD_METRIC_IDS[`${base}()`];
  if (!registryId) return null;
  const arg = argText.trim();
  if (WINDOWED_PAYLOADS.has(registryId)) {
    // the window is IN the id; an empty one names no window and does not resolve
    if (!arg) return null;
    return { registryId, field, args: { window: arg } };
  }
  // a slice id takes its key and its scope from the NodeRef, never from the text
  if (arg) return null;
  return { registryId, field, args: {} };
}

/** True when the id is something the registry can answer — directly or as a payload field. */
export function metricIdResolves(id: string): boolean {
  return getMetric(id) !== undefined || resolveCompositeMetricId(id) !== null;
}

function notComputable(
  id: string,
  reason: NotComputableReason,
  detail: string,
): RegistryMetricValue {
  return { id, value: null, reason, detail, unit: "mixed", level: "account", entityId: null };
}

/**
 * `evaluate`, plus the composite ids. A field that the payload does not carry,
 * or carries as null (the registry withholds `cpa` / `roas` below the 10-conv
 * floor), is not computable — never a substituted zero.
 */
export function evaluateMetricId(
  metrics: MetricCtx,
  id: string,
  args: MetricArgs,
): RegistryMetricValue {
  if (getMetric(id)) return evaluate(metrics, id, args);
  const composite = resolveCompositeMetricId(id);
  if (!composite) return evaluate(metrics, id, args);

  const payload = evaluate(metrics, composite.registryId, { ...args, ...composite.args });
  if (payload.reason !== undefined) return { ...payload, id };
  const value = payload.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return notComputable(
      id,
      "not_checkable",
      `${composite.registryId} did not return a payload with fields`,
    );
  }
  const field = (value as Record<string, unknown>)[composite.field];
  if (field === undefined) {
    return notComputable(
      id,
      "not_checkable",
      `'${composite.field}' is not a field of ${composite.registryId}`,
    );
  }
  if (field === null) {
    return notComputable(
      id,
      "insufficient_data",
      payload.note ?? `${composite.registryId} withheld '${composite.field}'`,
    );
  }
  if (typeof field !== "number" && typeof field !== "string" && typeof field !== "boolean") {
    return notComputable(
      id,
      "not_checkable",
      `'${composite.field}' of ${composite.registryId} is not a scalar`,
    );
  }
  return { ...payload, id, value: field };
}

// ---------------------------------------------------------------------------
// 3. sample
// ---------------------------------------------------------------------------

/**
 * The check layer's `sample.population` is a COUNT; the scoring layer's is a
 * state. `toSampleSummary` is the one adapter and it is the contract: a
 * positive count is `real`, zero or missing is `unknown` — never "none found".
 */
export function toScoringSample(sample: {
  truncated: boolean;
  population: number | null;
}): SampleSummary {
  return toSampleSummary(
    sample.population == null
      ? { truncated: sample.truncated }
      : { truncated: sample.truncated, population: sample.population },
  );
}
