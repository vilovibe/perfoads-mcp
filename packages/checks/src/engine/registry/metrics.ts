// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Metric registry — build sheet §A, one definition per metric (spec §8.4
 * rule 9). Every formula reads the AccountModel (Phase 1a) plus the AccountData
 * it was built from (daily series, keyless tables), never a DB and never AI.
 *
 * Rules applied uniformly by `withTables()`:
 *   - rule 5 / population gate (population.ts): a source table that is
 *     marker-error, empty with no marker, or joined 0 of N → `not_checkable`;
 *   - rows but no marker → the value is computed and tagged `provisional`;
 *   - sample floors (§8.4 rule 3) → `insufficient_data` with the floor named;
 *   - maturity (rule 2) → both settled tiers on every value;
 *   - CAP → `sample.truncated` from the marker, never a total.
 *
 * Ids are the sheet's. Where the sheet writes a slash group (`C.spend /
 * C.clicks / …`) each member is its own definition. Two ids the task names
 * differently resolve through ALIASES (`A.cost90` → `A.spend`, `C.util90` →
 * `C.budget_util90`). Additions beyond §A, each marked "(addition)":
 * `A.spend_monthly` (the input to T.waste_floor) and
 * `A.brand_roas` (D.1's `brand_roas`, the 10.70x the scope-pairing rule cites).
 *
 * Eligible campaign (§A.1, one definition): status ENABLED, or PAUSED with
 * cost > 0 in the window. REMOVED and zero-spend paused campaigns are out.
 */
import { cmpStr } from "../shared/order.js";
import {
  ESSENTIAL_ROLES,
  essentialRolesOf,
  type EssentialRole,
  type RoleBasis,
} from "../shared/audienceRoles.js";
import { isBrandCampaign } from "../shared/campaignClassification.js";
import { brandMatcherOfModel } from "../model/context.js";
import { metricsFromRows, num, ratio, type NodeMetrics } from "../model/metrics.js";
import { offlineUploadTargets, type AccountModel } from "../model/nodes/AccountNode.js";
import { biddingConversionActions } from "../roles.js";
import { assetsUnknownReason, signalsUnknownReason } from "../model/nodes/AssetGroupNode.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import type { ConversionActionNode } from "../model/nodes/ConversionActionNode.js";
import { UTM_CLASS_NAMES, type UtmClass } from "../model/nodes/LandingPageNode.js";
import type { Slice, SliceDimension } from "../model/nodes/Slice.js";
import type { WindowSpec } from "../model/provenance.js";
import { actionSettledDay as settledDayOf, type NodeWindows } from "../model/windows.js";
import { classifyActivity, countsTowardSpend, statusOf } from "./entityStatus.js";
import { duplicateCopiesOf } from "../shared/keywordOverlap.js";
import { markerFor } from "./syncMarkers.js";
import { notCheckable as tableGate } from "./population.js";
import { formatMoney } from "../shared/currencyScale.js";
import {
  DEVICE_SKEW,
  FLOORS,
  PMAX_ASSETS,
  PMAX_SHOPPING_SHARE,
  PRODUCT_WASTE,
  TRACKING_BREAK,
  WASTE,
  scaleMoney,
  statisticalThresholdFromCvr,
  wasteFloorBand,
} from "./thresholds.js";
import {
  DAYS_MIN_FOR_WINDOW,
  DAYS_PER_MONTH_DIVISOR,
  addDays,
  daysBetween,
  endIsYesterday,
  isoDay,
  modelWindowKey,
  rowsInWindow,
  windowSpecFor,
} from "./windows.js";
import type {
  MaturityRule,
  MetricArgs,
  MetricCtx,
  MetricDefinition,
  MetricFloorCheck,
  MetricLevel,
  MetricNotComputable,
  MetricOk,
  MetricPayload,
  MetricUnit,
  MetricValue,
} from "./types.js";

// ------------------------------------------------------------------ helpers

/** The closed purchase/sale category set (§D.2 MI03). */
export const PURCHASE_CATEGORIES: ReadonlySet<string> = new Set([
  "PURCHASE",
  "PURCHASE_ONLINE",
  "CONVERTED_LEAD",
  "QUALIFIED_LEAD",
  "SUBMIT_LEAD_FORM",
  "SIGNUP",
]);

/**
 * §A.1 eligible campaign — ENABLED or PAUSED-with-spend, i.e. exactly "not
 * dormant".
 *
 * This is the ARITHMETIC population: what the account spent, what share of it
 * was brand, what a campaign's share of the total is. It deliberately does NOT
 * use `isReportable`, which went live-only for findings. It did
 * delegate to it for one commit, and the 90-day spend silently dropped as the
 * paused campaigns fell out of the denominator — turning a fix for one false claim into a different one on a
 * bigger number. See `countsTowardSpend` in entityStatus.ts.
 */
export function isEligibleCampaign(c: CampaignNode): boolean {
  return countsTowardSpend(c);
}

export function eligibleCampaigns(model: AccountModel): CampaignNode[] {
  return model.children.campaigns.filter(isEligibleCampaign);
}

function sumOf(xs: readonly (number | null)[]): number | null {
  let seen = false;
  let t = 0;
  for (const x of xs) {
    if (x == null) continue;
    seen = true;
    t += x;
  }
  return seen ? t : null;
}

/**
 * The three fields every formula needs about its own definition. Passed in
 * EXPLICITLY as the third argument (`self`) — no `this`, so a formula is a
 * plain function and the registry stays a data table.
 */
interface MetricHead {
  id: string;
  level: MetricLevel;
  unit: MetricUnit;
  maturityRule: MaturityRule;
}

/** How a formula is written in this file; `def()` binds `self` and exposes the `(ctx, args)` shape MetricDefinition declares. */
type Formula = (ctx: MetricCtx, args: MetricArgs | undefined, self: MetricHead) => MetricValue;

interface Partial {
  value: MetricPayload;
  window?: WindowSpec | null | undefined;
  table?: string | undefined;
  rowCount?: number | undefined;
  rowIds?: string[] | undefined;
  computedFrom?: string[] | undefined;
  floor?: MetricFloorCheck | undefined;
  note?: string | undefined;
  truncated?: boolean | undefined;
  cap?: number | undefined;
}

type NotComputable = Pick<MetricNotComputable, "reason" | "detail" | "code"> & {
  floor?: MetricFloorCheck | undefined;
};

function nc(
  reason: MetricNotComputable["reason"],
  detail: string,
  floor?: MetricFloorCheck,
): NotComputable {
  return floor ? { reason, detail, floor } : { reason, detail };
}

function isNc<T extends object>(x: T | NotComputable): x is NotComputable {
  return (x as NotComputable).reason !== undefined;
}

/** Floor check → `insufficient_data` when unmet. */
/** The conversion floor behind a ROAS / CPA verdict (settings.floors.strongConv). */
const strongConv = (ctx: MetricCtx): number => ctx.settings.floors.strongConv;

function floorCheck(metric: string, required: number, actual: number | null): MetricFloorCheck {
  return { metric, required, actual, met: actual != null && actual >= required };
}

/** A floor's measure in plain words. */
const FLOOR_WORDS: Readonly<Record<string, string>> = {
  conv: "conversions",
  clicks: "clicks",
  orders: "orders",
  "baseline conv": "conversions in the earlier period",
};

/** An unmet floor in plain words: "only 4 conversions, fewer than the 10 needed to judge it". */
function tooFew(f: MetricFloorCheck, where = ""): string {
  const a = f.actual ?? 0;
  const shown = Number.isInteger(a) ? String(a) : a.toFixed(1);
  return `only ${shown} ${FLOOR_WORDS[f.metric] ?? f.metric}${where}, fewer than the ${f.required} needed to judge it`;
}

function maturityFor(
  rule: MaturityRule,
  ctx: MetricCtx,
  w: WindowSpec | null | undefined,
): MetricOk["maturity"] {
  if (rule === "N/A") return { rule, settledStrict: null, settledPractical: null };
  if (rule === "S")
    return { rule, settledStrict: !ctx.window.lookbackUnknown, settledPractical: true };
  const spec = w ?? ctx.window.windows.m90;
  return { rule, settledStrict: !!spec.settledStrict, settledPractical: !!spec.settledPractical };
}

/**
 * Phase 11b (AS09): which essential lists the account holds. Lists that cannot
 * be targeted as themselves are left out: CLOSED (collects nobody new) and
 * SIMILAR / LOOKALIKE (strangers who look like the list, not the list).
 * Purchase conversion actions come from the synced actions (category PURCHASE).
 */
export function requiredListCoverageOf(model: AccountModel): {
  matches: Record<EssentialRole, Array<{ listId: string; name: string; basis: RoleBasis }>>;
  judged: number;
  definitionsRead: boolean;
} {
  const purchaseIds = new Set(
    model.children.conversionActions
      .filter((c) => String(c.attrs.category ?? "").toUpperCase() === "PURCHASE")
      .map((c) => String(c.attrs.actionId ?? ""))
      .filter(Boolean),
  );
  const matches = Object.fromEntries(
    ESSENTIAL_ROLES.map((r) => [
      r,
      [] as Array<{ listId: string; name: string; basis: RoleBasis }>,
    ]),
  ) as Record<EssentialRole, Array<{ listId: string; name: string; basis: RoleBasis }>>;
  const lists = model.children.audienceLists.filter(
    (l) =>
      String(l.membershipStatus ?? "").toUpperCase() !== "CLOSED" &&
      !/^(SIMILAR|LOOKALIKE)$/i.test(String(l.type ?? "")),
  );
  for (const l of lists) {
    for (const { role, basis } of essentialRolesOf(l, purchaseIds))
      matches[role].push({ listId: l.listId, name: l.name ?? l.listId, basis });
  }
  return {
    matches,
    judged: lists.length,
    definitionsRead: lists.some((l) => l.ruleText != null || l.actionIds != null),
  };
}

/**
 * Run a formula behind the table / population gate. `tables` are AccountData
 * keys or * names; [] = derived only (no gate). The formula may
 * return a NotComputable (floor miss, missing model field) instead of a value.
 */
function withTables(
  self: MetricHead,
  ctx: MetricCtx,
  entityId: string | null,
  tables: readonly string[],
  fn: () => Partial | NotComputable,
): MetricValue {
  let markerState: MetricOk["markerState"] = "ok";
  let truncated = false;
  for (const t of tables) {
    const g = tableGate(ctx.model, ctx.markers, t);
    if (g.notCheckable)
      return {
        id: self.id,
        value: null,
        reason: "not_checkable",
        detail: g.reason ?? t,
        unit: self.unit,
        level: self.level,
        entityId,
        source: { table: t },
      };
    if (g.markerState === "provisional") markerState = "provisional";
    if (markerFor(ctx.markers, t).truncated) truncated = true;
  }
  const r = fn();
  if (isNc(r))
    return {
      id: self.id,
      value: null,
      reason: r.reason,
      detail: r.detail,
      unit: self.unit,
      level: self.level,
      entityId,
      source: { table: tables[0] ?? "derived" },
      ...(r.floor ? { floor: r.floor } : {}),
      ...(r.code ? { code: r.code } : {}),
    };
  const w = r.window ?? null;
  const out: MetricOk = {
    id: self.id,
    value: r.value,
    unit: self.unit,
    level: self.level,
    entityId,
    window: w ? { label: w.label, start: w.start, end: w.end, days: w.days } : null,
    source: {
      table: r.table ?? tables[0] ?? "derived",
      ...(r.rowCount != null ? { rowCount: r.rowCount } : {}),
      ...(r.rowIds ? { rowIds: r.rowIds } : {}),
      ...(r.computedFrom
        ? { computedFrom: r.computedFrom }
        : tables.length > 1
          ? { computedFrom: [...tables] }
          : {}),
    },
    maturity: maturityFor(self.maturityRule, ctx, w),
    markerState,
    sample: { truncated: truncated || !!r.truncated, ...(r.cap != null ? { cap: r.cap } : {}) },
  };
  if (r.floor) out.floor = r.floor;
  if (r.note) out.note = r.note;
  return out;
}

const noEntity = (kind: string, id: string | undefined): NotComputable =>
  nc("no_entity", `${kind} ${id ?? "(none)"} is not in the AccountModel`);

// entity resolvers
const campaignOf = (ctx: MetricCtx, a?: MetricArgs) =>
  a?.campaignId ? (ctx.index.campaignsById.get(a.campaignId) ?? null) : null;
const adGroupOf = (ctx: MetricCtx, a?: MetricArgs) =>
  a?.adGroupId ? (ctx.index.adGroupsById.get(a.adGroupId) ?? null) : null;
const keywordOf = (ctx: MetricCtx, a?: MetricArgs) =>
  a?.keywordId ? (ctx.index.keywordsById.get(a.keywordId) ?? null) : null;
const termOf = (ctx: MetricCtx, a?: MetricArgs) =>
  a?.searchTermId ? (ctx.index.searchTermsById.get(a.searchTermId) ?? null) : null;
const adOf = (ctx: MetricCtx, a?: MetricArgs) =>
  a?.adId ? (ctx.index.adsById.get(a.adId) ?? null) : null;
const assetOf = (ctx: MetricCtx, a?: MetricArgs) =>
  a?.assetId ? (ctx.index.assetsById.get(a.assetId) ?? null) : null;
const extensionOf = (ctx: MetricCtx, a?: MetricArgs) =>
  a?.extensionId ? (ctx.index.extensionsById.get(a.extensionId) ?? null) : null;
const assetGroupOf = (ctx: MetricCtx, a?: MetricArgs) =>
  a?.assetGroupId ? (ctx.index.assetGroupsById.get(a.assetGroupId) ?? null) : null;
const productOf = (ctx: MetricCtx, a?: MetricArgs) =>
  a?.productId ? (ctx.index.productsById.get(a.productId.toLowerCase()) ?? null) : null;
const placementOf = (ctx: MetricCtx, a?: MetricArgs) =>
  a?.placementId ? (ctx.index.placementsById.get(a.placementId) ?? null) : null;
const landingPageOf = (ctx: MetricCtx, a?: MetricArgs) =>
  a?.landingPageId ? (ctx.index.landingPagesById.get(a.landingPageId) ?? null) : null;
const actionOf = (ctx: MetricCtx, a?: MetricArgs): ConversionActionNode | null =>
  a?.actionId ? (ctx.index.conversionActionsById.get(a.actionId) ?? null) : null;

/** A day the action fired: conversions, or all_conversions for an action outside the conversions column. */
const firedOn = (r: { conv: number; all?: number | null }): boolean =>
  r.conv > 0 || (r.all ?? 0) > 0;

/** The last settled day of THIS action's own lookback (model/windows.ts). */
const actionSettledDay = (ctx: MetricCtx, x: ConversionActionNode): string | null =>
  settledDayOf(ctx.window, x);

const rows = (ctx: MetricCtx, key: string): any[] => {
  const v = (ctx.data as any)[key];
  return Array.isArray(v) ? v : [];
};

/** campaign_daily_metrics rows for one campaign, sorted by date. */
function campaignDaily(ctx: MetricCtx, campaignId: string): any[] {
  return rows(ctx, "campaignDailyMetrics")
    .filter((r) => String(r.campaign_id) === campaignId)
    .sort((a, b) => cmpStr(String(isoDay(a.metric_date)), String(isoDay(b.metric_date))));
}

/** Plain words for the named windows, for reasons a shop owner reads. */
const WINDOW_WORDS: Record<string, string> = {
  recent30: "the last 30 days",
  prior30: "the 30 days before",
  last7: "the last 7 days",
  prior7: "the 7 days before",
  settled_week: "the last settled week",
  settled_to_date: "the settled days",
};

function windowMetrics(
  ctx: MetricCtx,
  node: { windows: NodeWindows },
  daily: any[] | null,
  name: string,
  table: string,
): { m: NodeMetrics; w: WindowSpec } | null {
  const w = windowSpecFor(name, ctx.window);
  if (!w || !w.start || !w.end) return null;
  const key = modelWindowKey(name);
  if (key) {
    const m = node.windows[key];
    return m ? { m, w } : null;
  }
  if (!daily || daily.length === 0) return null;
  return { m: metricsFromRows(rowsInWindow(daily, w), w, table), w };
}

const pct = (x: number | null): number | null => (x == null ? null : x * 100);

/** Account-scope eligible rollup (the §A.1 numbers). */
function accountTotals(ctx: MetricCtx) {
  const cs = eligibleCampaigns(ctx.model);
  return {
    campaigns: cs,
    cost: sumOf(cs.map((c) => c.windows.m90.cost)),
    clicks: sumOf(cs.map((c) => c.windows.m90.clicks)),
    impressions: sumOf(cs.map((c) => c.windows.m90.impressions)),
    conv: sumOf(cs.map((c) => c.windows.m90.conv)),
    value: sumOf(cs.map((c) => c.windows.m90.value)),
    rowIds: cs.map((c) => c.id),
  };
}

function accountConv(ctx: MetricCtx): number | null {
  return accountTotals(ctx).conv;
}

const m90 = (ctx: MetricCtx) => ctx.window.windows.m90;

// ---- slice helpers
function sliceFamily(
  ctx: MetricCtx,
  dim: SliceDimension,
  a?: MetricArgs,
): { slices: Slice[]; scopeId: string | null; scopeMetrics: NodeMetrics } | NotComputable {
  const scope = a?.scope ?? (a?.campaignId ? "campaign" : "account");
  if (scope === "campaign") {
    const c = campaignOf(ctx, a);
    if (!c) return noEntity("campaign", a?.campaignId);
    return { slices: c.children.slices[dim], scopeId: c.id, scopeMetrics: c.windows.m90 };
  }
  return {
    slices: ctx.model.children.slices[dim],
    scopeId: null,
    scopeMetrics: ctx.model.windows.m90,
  };
}

function sliceValue(s: Slice): Record<string, number | null> {
  const m = s.windows.m90;
  return { clicks: m.clicks, cost: m.cost, conv: m.conv, value: m.value, cpa: m.cpa, roas: m.roas };
}

function sliceMetric(
  ctx: MetricCtx,
  dim: SliceDimension,
  a: MetricArgs | undefined,
  clicksFloor: number,
  table: string,
): Partial | NotComputable {
  const fam = sliceFamily(ctx, dim, a);
  if (isNc(fam)) return fam;
  if (a?.key == null) {
    // whole family as a map
    const out: Record<string, number | null> = {};
    for (const s of fam.slices) out[s.attrs.key] = s.windows.m90.cost;
    return {
      value: out,
      window: m90(ctx),
      table,
      rowCount: fam.slices.length,
      note: `cost per ${dim} key; pass key= for the full slice`,
    };
  }
  const s = fam.slices.find((x) => x.attrs.key === a.key);
  if (!s)
    return nc(
      "no_entity",
      `${dim} slice '${a.key}' not present at ${fam.scopeId ? `campaign ${fam.scopeId}` : "account"} scope`,
    );
  const f = floorCheck("clicks", clicksFloor, s.windows.m90.clicks);
  if (!f.met) return nc("insufficient_data", `${dim} '${a.key}': ${tooFew(f)}`, f);
  return {
    value: sliceValue(s),
    window: m90(ctx),
    table,
    rowCount: s.windows.m90.provenance.rowCount,
    floor: f,
    truncated: s.sample.truncated,
  };
}

/** The resolved bid modifier a (campaign, key[, type]) names; a dowHour key matches the schedule covering that cell. */
function modifierOn(c: CampaignNode, a?: MetricArgs) {
  return (
    c.children.bidModifiers.find((b) => {
      const ms = b.attrs.measuredSlice;
      if (ms.kind === "unresolved") return false;
      if (a?.type && ms.kind !== a.type) return false;
      return a?.key == null || ms.key === a.key || (ms.cells ?? []).includes(a.key);
    }) ?? null
  );
}

// ------------------------------------------------------------ definitions

function def(
  id: string,
  level: MetricLevel,
  unit: MetricUnit,
  definition: string,
  sources: string[],
  window: string,
  maturityRule: MaturityRule,
  floor: string,
  formula: Formula,
): MetricDefinition {
  const self: MetricHead = { id, level, unit, maturityRule };
  return {
    id,
    level,
    unit,
    definition,
    sources,
    window,
    maturityRule,
    floor,
    formula: (ctx, args) => {
      const r = formula(ctx, args, self);
      // B1: an ok value remembers its arguments so a citation can name the leg it
      // is about (`P.ag_asset_count(field)` × 4 legs were indistinguishable rows).
      // `id` is untouched — the regression gate maps ids to claim keys by exact match.
      if (args && r.value !== null && r.reason === undefined) {
        const kept = Object.fromEntries(
          Object.entries(args).filter(([, v]) => v !== undefined && v !== null),
        );
        if (Object.keys(kept).length > 0) return { ...r, args: kept as MetricArgs };
      }
      return r;
    },
  };
}

const D: MetricDefinition[] = [];
const add = (...ds: MetricDefinition[]) => {
  D.push(...ds);
};

// ================================================================ A.0 window and sync
add(
  def(
    "W.range_start",
    "account",
    "date",
    "first day of the audit window",
    ["dailyMetrics"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["dailyMetrics"], () =>
        ctx.window.start
          ? {
              value: ctx.window.start,
              note: "AccountData carries no date_range_start; the window is min(daily_metrics.metric_date)",
            }
          : nc("not_checkable", "no daily series — the window cannot be placed on a calendar"),
      );
    },
  ),
  def(
    "W.range_end",
    "account",
    "date",
    "last day of the window",
    ["dailyMetrics"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["dailyMetrics"], () =>
        ctx.window.end
          ? {
              value: ctx.window.end,
              note: "max(daily_metrics.metric_date) — can be the run date, not yesterday",
            }
          : nc("not_checkable", "no daily series"),
      );
    },
  ),
  def(
    "W.window_days",
    "account",
    "count",
    "inclusive day count",
    ["derived"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["dailyMetrics"], () =>
        ctx.window.days != null
          ? { value: ctx.window.days }
          : nc("not_checkable", "no daily series"),
      );
    },
  ),
  def(
    "W.max_lookback_days",
    "account",
    "days",
    "longest conversion lookback across all actions",
    ["conversionActions"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionActions"], () =>
        ctx.window.maxLookbackDays != null
          ? {
              value: ctx.window.maxLookbackDays,
              rowCount: ctx.model.children.conversionActions.length,
            }
          : nc("not_checkable", "no conversion action carries lookback_window_days"),
      );
    },
  ),
  def(
    "W.last_settled_day",
    "account",
    "date",
    "last day whose conversions are complete (strict tier); practical tier = range_end − 7",
    ["derived"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["dailyMetrics", "conversionActions"], () =>
        ctx.window.lastSettledDay
          ? {
              value: {
                strict: ctx.window.lastSettledDay,
                practical: ctx.window.lastSettledDayPractical,
              },
              note: "strict = range_end − W.max_lookback_days; practical = range_end − 7",
            }
          : nc(
              "not_checkable",
              ctx.window.lookbackUnknown
                ? "lookback unknown — nothing can be called settled"
                : "no window end",
            ),
      );
    },
  ),
  def(
    "W.settled_days",
    "account",
    "count",
    "days in window at or before last_settled_day",
    ["dailyMetrics"],
    "full",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["dailyMetrics", "conversionActions"], () => {
        const s = ctx.window.lastSettledDay;
        if (!s) return nc("not_checkable", "last settled day unknown");
        const days = rows(ctx, "dailyMetrics")
          .map((r) => isoDay(r.metric_date))
          .filter((d): d is string => !!d);
        return {
          value: days.filter((d) => d <= s).length,
          rowCount: days.length,
          note: `${days.length} daily rows in total`,
        };
      });
    },
  ),
  def(
    "W.end_is_yesterday",
    "account",
    "bool",
    "does the data run to yesterday",
    ["derived"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["dailyMetrics"], () => {
        const v = endIsYesterday(ctx.window, ctx.runDate);
        return v == null
          ? nc("not_checkable", "no window end")
          : { value: v, note: `range_end ${ctx.window.end} vs run date ${ctx.runDate}` };
      });
    },
  ),
  def(
    "Y.status[table]",
    "account",
    "enum",
    "per-table sync outcome",
    ["sync_table_status"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      if (!a?.table)
        return {
          id: self.id,
          value: null,
          reason: "no_entity",
          detail: "pass table=",
          unit: self.unit,
          level: self.level,
          entityId: null,
        };
      const m = markerFor(ctx.markers, a.table);
      return {
        id: self.id,
        value: m.status,
        unit: self.unit,
        level: self.level,
        entityId: a.table,
        window: null,
        source: { table: "sync_table_status" },
        maturity: { rule: "N/A", settledStrict: null, settledPractical: null },
        markerState: "ok",
        sample: { truncated: false },
        note: `resolved via ${m.source}`,
      };
    },
  ),
  def(
    "Y.row_count[table]",
    "account",
    "count",
    "rows the reader returned",
    ["sync_table_status"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      if (!a?.table)
        return {
          id: self.id,
          value: null,
          reason: "no_entity",
          detail: "pass table=",
          unit: self.unit,
          level: self.level,
          entityId: null,
        };
      const m = markerFor(ctx.markers, a.table);
      if (m.rowCount == null)
        return {
          id: self.id,
          value: null,
          reason: "not_checkable",
          detail: m.message ?? "no marker",
          unit: self.unit,
          level: self.level,
          entityId: a.table,
        };
      return {
        id: self.id,
        value: m.rowCount,
        unit: self.unit,
        level: self.level,
        entityId: a.table,
        window: null,
        source: {
          table:
            m.source === "legacy"
              ? "audits"
              : m.source === "mc"
                ? "mc_sync_status"
                : "sync_table_status",
        },
        maturity: { rule: "N/A", settledStrict: null, settledPractical: null },
        markerState: "ok",
        sample: { truncated: m.truncated },
      };
    },
  ),
  def(
    "Y.truncated[table]",
    "account",
    "bool",
    "fetch hit its cap",
    ["derived", "FETCH_CAPS"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      if (!a?.table)
        return {
          id: self.id,
          value: null,
          reason: "no_entity",
          detail: "pass table=",
          unit: self.unit,
          level: self.level,
          entityId: null,
        };
      const m = markerFor(ctx.markers, a.table);
      return {
        id: self.id,
        value: m.truncated,
        unit: self.unit,
        level: self.level,
        entityId: a.table,
        window: null,
        source: { table: m.table },
        maturity: { rule: "N/A", settledStrict: null, settledPractical: null },
        markerState: "ok",
        sample: {
          truncated: m.truncated,
          ...(m.cap != null ? { cap: m.cap } : {}),
          rowsSeen: m.rowsSeen,
        },
      };
    },
  ),
  def(
    "Y.legacy_count[table]",
    "account",
    "count",
    "sync-time row count from the audit row (one of the 12 *_count columns)",
    ["audits"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      if (!a?.table)
        return {
          id: self.id,
          value: null,
          reason: "no_entity",
          detail: "pass table=",
          unit: self.unit,
          level: self.level,
          entityId: null,
        };
      const m = markerFor(ctx.markers, a.table);
      if (m.source !== "legacy")
        return {
          id: self.id,
          value: null,
          reason: "not_checkable",
          detail:
            m.source === "marker"
              ? "a sync_table_status row took precedence"
              : `no legacy count column for ${m.table}`,
          unit: self.unit,
          level: self.level,
          entityId: a.table,
        };
      return {
        id: self.id,
        value: m.rowCount,
        unit: self.unit,
        level: self.level,
        entityId: a.table,
        window: null,
        source: { table: "audits" },
        maturity: { rule: "N/A", settledStrict: null, settledPractical: null },
        markerState: "ok",
        sample: { truncated: false },
      };
    },
  ),
  def(
    "Y.marker_state[table]",
    "account",
    "enum",
    "how the engine learned this table's state: status row → legacy count (0 is real) → unknown",
    ["derived"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      if (!a?.table)
        return {
          id: self.id,
          value: null,
          reason: "no_entity",
          detail: "pass table=",
          unit: self.unit,
          level: self.level,
          entityId: null,
        };
      const m = markerFor(ctx.markers, a.table);
      return {
        id: self.id,
        value: m.status,
        unit: self.unit,
        level: self.level,
        entityId: a.table,
        window: null,
        source: {
          table:
            m.source === "marker"
              ? "sync_table_status"
              : m.source === "legacy"
                ? "audits"
                : m.source === "mc"
                  ? "mc_sync_status"
                  : "none",
        },
        maturity: { rule: "N/A", settledStrict: null, settledPractical: null },
        markerState: "ok",
        sample: { truncated: m.truncated },
        note: m.message ?? undefined,
      };
    },
  ),
  def(
    "DQ.population[table]",
    "account",
    "count",
    "rows that join a node in the AccountModel",
    ["derived"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      if (!a?.table)
        return {
          id: self.id,
          value: null,
          reason: "no_entity",
          detail: "pass table=",
          unit: self.unit,
          level: self.level,
          entityId: null,
        };
      const p = ctx.population.get(a.table);
      if (!p)
        return {
          id: self.id,
          value: null,
          reason: "not_checkable",
          detail: `${a.table} is not a table the model loads`,
          unit: self.unit,
          level: self.level,
          entityId: a.table,
        };
      return {
        id: self.id,
        value: p.attached,
        unit: self.unit,
        level: self.level,
        entityId: a.table,
        window: null,
        source: { table: p.table, rowCount: p.rows },
        maturity: { rule: "N/A", settledStrict: null, settledPractical: null },
        markerState: "ok",
        sample: { truncated: false },
        note:
          p.join === "unjoined"
            ? "account-level table — every row belongs to the account node"
            : undefined,
      };
    },
  ),
  def(
    "DQ.orphan_rows[table]",
    "account",
    "count",
    "rows for this audit that join no node",
    ["derived"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      if (!a?.table)
        return {
          id: self.id,
          value: null,
          reason: "no_entity",
          detail: "pass table=",
          unit: self.unit,
          level: self.level,
          entityId: null,
        };
      const p = ctx.population.get(a.table);
      if (!p)
        return {
          id: self.id,
          value: null,
          reason: "not_checkable",
          detail: `${a.table} is not a table the model loads`,
          unit: self.unit,
          level: self.level,
          entityId: a.table,
        };
      return {
        id: self.id,
        value: p.orphans,
        unit: self.unit,
        level: self.level,
        entityId: a.table,
        window: null,
        source: { table: p.table, rowCount: p.rows },
        maturity: { rule: "N/A", settledStrict: null, settledPractical: null },
        markerState: "ok",
        sample: { truncated: false },
      };
    },
  ),
);

// ================================================================ A.1 account performance
const acct = (
  id: string,
  unit: MetricUnit,
  definition: string,
  maturity: MaturityRule,
  floor: string,
  pick: (t: ReturnType<typeof accountTotals>) => number | null,
  floorFn?: (t: ReturnType<typeof accountTotals>, ctx: MetricCtx) => MetricFloorCheck,
) =>
  def(id, "account", unit, definition, ["campaigns"], "90d", maturity, floor, (ctx, _a, self) => {
    return withTables(self, ctx, null, ["campaigns"], () => {
      const t = accountTotals(ctx);
      if (t.campaigns.length === 0)
        return nc("not_checkable", "no eligible campaign (ENABLED or PAUSED with spend)");
      const f = floorFn?.(t, ctx);
      if (f && !f.met) return nc("insufficient_data", tooFew(f), f);
      const v = pick(t);
      if (v == null) return nc("not_checkable", "no eligible campaign carries the column");
      return {
        value: v,
        window: m90(ctx),
        rowCount: t.campaigns.length,
        rowIds: t.rowIds,
        floor: f,
        note: `${t.campaigns.length} eligible campaigns (ENABLED or PAUSED with spend)`,
      };
    });
  });
const convFloor = (t: ReturnType<typeof accountTotals>, ctx: MetricCtx) =>
  floorCheck("conv", strongConv(ctx), t.conv);
const clickFloor = (t: ReturnType<typeof accountTotals>) =>
  floorCheck("clicks", FLOORS.ratesClicks, t.clicks);
add(
  acct(
    "A.spend",
    "usd",
    "money spent in the window over eligible campaigns",
    "N/A",
    "–",
    (t) => t.cost,
  ),
  def(
    "A.spend_daily",
    "account",
    "usd",
    "same figure from the daily series",
    ["dailyMetrics"],
    "any",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["dailyMetrics"], () => {
        const v = ctx.model.dataQuality.reconciliation.dailyCost;
        return v == null
          ? nc("not_checkable", "daily_metrics has no cost")
          : { value: v, window: m90(ctx), rowCount: rows(ctx, "dailyMetrics").length };
      });
    },
  ),
  def(
    "A.active_days",
    "account",
    "count",
    "days with spend",
    ["dailyMetrics"],
    "90d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["dailyMetrics"], () => {
        const d = rows(ctx, "dailyMetrics");
        return d.length === 0
          ? nc("not_checkable", "no daily_metrics rows")
          : {
              value: d.filter((r) => (num(r.cost) ?? 0) > 0).length,
              window: m90(ctx),
              rowCount: d.length,
            };
      });
    },
  ),
  def(
    "A.spend_reconciliation_delta",
    "account",
    "usd",
    "disagreement between the two spend sources",
    ["derived"],
    "90d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["campaigns", "dailyMetrics"], () => {
        const a = accountTotals(ctx).cost;
        const b = ctx.model.dataQuality.reconciliation.dailyCost;
        return a == null || b == null
          ? nc("not_checkable", "one source has no cost")
          : {
              value: Math.abs(a - b),
              window: m90(ctx),
              computedFrom: ["campaigns", "dailyMetrics"],
              note: "campaigns for totals, daily_metrics for windows — never mixed inside a formula",
            };
      });
    },
  ),
  acct("A.clicks", "count", "window clicks", "N/A", "–", (t) => t.clicks),
  acct("A.impressions", "count", "window impressions", "N/A", "–", (t) => t.impressions),
  acct("A.conv", "count", "conversions in the window", "U", "–", (t) => t.conv),
  acct("A.conv_value", "usd", "conversion value", "U", "–", (t) => t.value),
  acct(
    "A.roas",
    "ratio",
    "value per unit spent",
    "U",
    "10 conv",
    (t) => ratio(t.value, t.cost),
    convFloor,
  ),
  acct(
    "A.cpa",
    "usd",
    "cost per conversion",
    "U",
    "10 conv",
    (t) => ratio(t.cost, t.conv),
    convFloor,
  ),
  acct(
    "A.cvr",
    "ratio",
    "conversions per click",
    "U",
    "100 clicks",
    (t) => ratio(t.conv, t.clicks),
    clickFloor,
  ),
  acct(
    "A.ctr",
    "ratio",
    "clicks per impression",
    "N/A",
    "100 clicks",
    (t) => ratio(t.clicks, t.impressions),
    clickFloor,
  ),
  acct(
    "A.avg_cpc",
    "usd",
    "spend per click",
    "N/A",
    "100 clicks",
    (t) => ratio(t.cost, t.clicks),
    clickFloor,
  ),
  acct(
    "A.aov",
    "usd",
    "value per conversion",
    "U",
    "100 clicks",
    (t) => ratio(t.value, t.conv),
    clickFloor,
  ),
  def(
    "A.roas_window(w)",
    "account",
    "ratio",
    "ROAS over a named window (recent30, prior30, settled_week, settled_to_date; also last7 / prior7)",
    ["dailyMetrics"],
    "recent30,prior30,settled_week,settled_to_date",
    "U",
    "10 conv",
    (ctx, a, self) => {
      const name = a?.window ?? "recent30";
      return withTables(self, ctx, null, ["dailyMetrics"], () => {
        const wm = windowMetrics(ctx, ctx.model, rows(ctx, "dailyMetrics"), name, "dailyMetrics");
        if (!wm)
          return nc(
            "not_checkable",
            `window '${name}' cannot be placed (unknown name or no daily series / settled day)`,
          );
        const f = floorCheck("conv", strongConv(ctx), wm.m.conv);
        if (!f.met)
          return nc(
            "insufficient_data",
            `${WINDOW_WORDS[name] ?? name} had ${wm.m.conv ?? 0} conversions, below the ${f.required} needed to judge a return`,
            f,
          );
        const v = ratio(wm.m.value, wm.m.cost);
        return v == null
          ? nc("not_checkable", `${name}: no cost`)
          : {
              value: v,
              window: wm.w,
              rowCount: wm.m.provenance.rowCount,
              floor: f,
              note:
                name === "last7" || name === "7d"
                  ? "trailing 7 days — UNSETTLED by both tiers (the strict settled week is `settled_week`)"
                  : undefined,
            };
      });
    },
  ),
  def(
    "A.spend_monthly",
    "account",
    "usd",
    "90-day spend / 3 (DAYS_PER_MONTH_DIVISOR) — the band input to T.waste_floor",
    ["derived"],
    "90d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["campaigns", "dailyMetrics"], () => {
        const t = accountTotals(ctx);
        const d = ctx.window.days;
        return t.cost == null || !d
          ? nc("not_checkable", "no spend or no window length")
          : { value: t.cost / DAYS_PER_MONTH_DIVISOR, window: m90(ctx), computedFrom: ["A.spend"] };
      });
    },
  ),
  def(
    "A.brand_spend",
    "account",
    "usd",
    "spend on campaigns classified brand (isBrandCampaign, not ILIKE)",
    ["campaigns", "campaignClassification"],
    "90d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["campaigns"], () => {
        const cs = accountTotals(ctx).campaigns.filter((c) => isBrandCampaign(c.name));
        return {
          value: sumOf(cs.map((c) => c.windows.m90.cost)) ?? 0,
          window: m90(ctx),
          rowCount: cs.length,
          rowIds: cs.map((c) => c.id),
        };
      });
    },
  ),
  def(
    "A.brand_spend_share",
    "account",
    "pct",
    "brand share of spend",
    ["derived"],
    "90d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["campaigns"], () => {
        const t = accountTotals(ctx);
        const b =
          sumOf(
            t.campaigns.filter((c) => isBrandCampaign(c.name)).map((c) => c.windows.m90.cost),
          ) ?? 0;
        return t.cost
          ? {
              value: (b / t.cost) * 100,
              window: m90(ctx),
              computedFrom: ["A.brand_spend", "A.spend"],
            }
          : nc("not_checkable", "no spend");
      });
    },
  ),
  def(
    "A.brand_value",
    "account",
    "usd",
    "conversion value on brand campaigns",
    ["campaigns"],
    "90d",
    "U",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["campaigns"], () => {
        const cs = accountTotals(ctx).campaigns.filter((c) => isBrandCampaign(c.name));
        return {
          value: sumOf(cs.map((c) => c.windows.m90.value)) ?? 0,
          window: m90(ctx),
          rowCount: cs.length,
          rowIds: cs.map((c) => c.id),
        };
      });
    },
  ),
  def(
    "A.brand_roas",
    "account",
    "ratio",
    "(addition, D.1 brand_roas) ROAS of the brand campaign SET — the 10.70x the scope-pairing rule cites; never pair with one campaign's ROAS",
    ["derived"],
    "90d",
    "U",
    "10 conv",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["campaigns"], () => {
        const cs = accountTotals(ctx).campaigns.filter((c) => isBrandCampaign(c.name));
        const cost = sumOf(cs.map((c) => c.windows.m90.cost));
        const value = sumOf(cs.map((c) => c.windows.m90.value));
        const f = floorCheck("conv", strongConv(ctx), sumOf(cs.map((c) => c.windows.m90.conv)));
        if (!f.met) return nc("insufficient_data", tooFew(f, " on brand campaigns"), f);
        const v = ratio(value, cost);
        return v == null
          ? nc("not_checkable", "no brand spend")
          : {
              value: v,
              window: m90(ctx),
              rowIds: cs.map((c) => c.id),
              rowCount: cs.length,
              floor: f,
            };
      });
    },
  ),
  def(
    "A.acquisition_roas",
    "account",
    "ratio",
    "ROAS excluding brand",
    ["derived"],
    "90d",
    "U",
    "10 conv",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["campaigns"], () => {
        const t = accountTotals(ctx);
        const b = t.campaigns.filter((c) => isBrandCampaign(c.name));
        const bc = sumOf(b.map((c) => c.windows.m90.cost)) ?? 0;
        const bv = sumOf(b.map((c) => c.windows.m90.value)) ?? 0;
        const f = floorCheck(
          "conv",
          strongConv(ctx),
          (t.conv ?? 0) - (sumOf(b.map((c) => c.windows.m90.conv)) ?? 0),
        );
        if (!f.met) return nc("insufficient_data", tooFew(f, " outside brand campaigns"), f);
        const v = ratio((t.value ?? 0) - bv, (t.cost ?? 0) - bc);
        return v == null
          ? nc("not_checkable", "no non-brand spend")
          : {
              value: v,
              window: m90(ctx),
              computedFrom: ["A.conv_value", "A.brand_value", "A.spend", "A.brand_spend"],
              floor: f,
            };
      });
    },
  ),
);

// ================================================================ A.2 measurement integrity
const CA_DAILY = "conversion_action_daily";
/** conversion_value_by_rule (item 9): recorded value per campaign x rule dimension. */
const VALUE_BY_RULE = "conversion_value_by_rule";
/** The two dimensions that are the value BEFORE any rule (v23 enum); everything else is an adjustment. */
const VALUE_RULE_BASE_DIMENSIONS: ReadonlySet<string> = new Set(["ORIGINAL", "NO_RULE_APPLIED"]);
/** Enum values this API version cannot name; bucketed apart, never counted as an adjustment. */
const VALUE_RULE_UNKNOWN_DIMENSIONS: ReadonlySet<string> = new Set(["UNKNOWN", "UNSPECIFIED", ""]);
/** Above this share of recorded value in the unknown bucket the split cannot be read. */
const VALUE_RULE_UNKNOWN_SHARE_MAX = 0.01;
add(
  def(
    "A.conv_actions_count",
    "account",
    "count",
    "conversion actions on the account",
    ["conversionActions"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionActions"], () => ({
        value: ctx.model.children.conversionActions.length,
        rowCount: ctx.model.children.conversionActions.length,
      }));
    },
  ),
  def(
    "A.conv_actions_primary_count",
    "account",
    "count",
    "actions marked primary",
    ["conversionActions"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionActions"], () => ({
        value: ctx.model.children.conversionActions.filter((c) => c.attrs.isPrimary).length,
        rowCount: ctx.model.children.conversionActions.length,
      }));
    },
  ),
  def(
    "A.conv_actions_with_data_count",
    "account",
    "count",
    "actions with any conversions",
    ["conversionActions"],
    "90d",
    "U",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionActions"], () => ({
        value: ctx.model.children.conversionActions.filter(
          (c) => (c.attrs.totalConversions ?? 0) > 0,
        ).length,
        window: m90(ctx),
        rowCount: ctx.model.children.conversionActions.length,
      }));
    },
  ),
  def(
    "A.per_action_coverage",
    "account",
    "ratio",
    "share of actions the per-action tables can see",
    ["campaignConversions", "conversionActions"],
    "90d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      // Round 4 item 7: the per-action DAILY table (conversion_action_daily) counts too —
      // it carries every action on a real sync, while campaignConversions holds a handful of rows.
      return withTables(self, ctx, null, ["campaignConversions", "conversionActions"], () => {
        const actions = ctx.model.children.conversionActions;
        const n = actions.length;
        if (n === 0) return nc("not_checkable", "no conversion actions");
        const names = new Set(
          rows(ctx, "campaignConversions").map((r) => String(r.conversion_action_name ?? "")),
        );
        names.delete("");
        const dailyLoaded = actions.some((c) => c.attrs.daily != null);
        const seen = actions.filter(
          (c) => names.has(c.name) || (c.attrs.daily != null && c.attrs.daily.length > 0),
        ).length;
        const seenCount = Math.max(seen, dailyLoaded ? 0 : names.size);
        const computedFrom = dailyLoaded
          ? ["campaignConversions", "conversionActions", CA_DAILY]
          : ["campaignConversions", "conversionActions"];
        return {
          value: Math.min(1, seenCount / n),
          window: m90(ctx),
          computedFrom,
          note: `the input holds ${seenCount} of ${n} actions — an engine gap, not a client tracking defect`,
        };
      });
    },
  ),
  // The per-action daily series (`attrs.daily`) is built from
  // conversion_action_daily in buildConversionActions: one entry per
  // day the table carries a row, summed over campaigns and owner accounts.
  // A day with no row is a zero day — the sync writes rows only for days with
  // activity — but ONLY inside the audit window; nothing is said about days
  // the window does not cover.
  def(
    "CA.daily_conv(action, date)",
    "conversion_action",
    "count",
    "conversions of one action on one day (date = args.key)",
    [CA_DAILY],
    "daily",
    "U",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.actionId ?? null, [CA_DAILY], () => {
        const x = actionOf(ctx, a);
        if (!x) return noEntity("conversion action", a?.actionId);
        if (x.attrs.daily == null)
          return nc("not_checkable", `${CA_DAILY} was not loaded for this audit`);
        const d = a?.key ? isoDay(a.key) : null;
        if (!d) return nc("not_checkable", "no date (args.key) given");
        const w = m90(ctx);
        if ((w.start && d < w.start) || (w.end && d > w.end))
          return nc("not_checkable", `${d} is outside the audit window`);
        const row = x.attrs.daily.find((r) => r.date === d);
        return {
          value: row?.conv ?? 0,
          window: w,
          rowIds: [x.id],
          rowCount: x.attrs.daily.length,
          note: row
            ? undefined
            : "no row for this day — the reader returns rows only for days with activity, so this is a zero day",
        };
      });
    },
  ),
  def(
    "CA.last_fire_date(action)",
    "conversion_action",
    "date",
    "most recent day the action fired",
    [CA_DAILY],
    "90d",
    "S",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.actionId ?? null, [CA_DAILY], () => {
        const x = actionOf(ctx, a);
        if (!x) return noEntity("conversion action", a?.actionId);
        if (x.attrs.daily == null)
          return nc("not_checkable", `${CA_DAILY} was not loaded for this audit`);
        const fired = x.attrs.daily.filter(firedOn);
        if (fired.length === 0)
          return {
            value: null,
            window: m90(ctx),
            rowIds: [x.id],
            rowCount: x.attrs.daily.length,
            note: `${x.name}: no day with a conversion in the window`,
          };
        return {
          value: fired[fired.length - 1]!.date,
          window: m90(ctx),
          rowIds: [x.id],
          rowCount: x.attrs.daily.length,
        };
      });
    },
  ),
  def(
    "CA.silent_days(action)",
    "conversion_action",
    "days",
    "consecutive zero days up to last_settled_day",
    [CA_DAILY],
    "90d",
    "S",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.actionId ?? null, [CA_DAILY], () => {
        const x = actionOf(ctx, a);
        if (!x) return noEntity("conversion action", a?.actionId);
        if (x.attrs.daily == null)
          return nc("not_checkable", `${CA_DAILY} was not loaded for this audit`);
        const settled = actionSettledDay(ctx, x);
        if (!settled)
          return nc(
            "not_checkable",
            ctx.window.lookbackUnknown
              ? "lookback unknown — nothing can be called settled"
              : "no window end",
          );
        const start = ctx.window.start;
        if (!start) return nc("not_checkable", "no window start");
        if (settled < start)
          return {
            ...nc(
              "not_checkable",
              `last settled day ${settled} precedes the window start ${start} — no settled day to count from`,
            ),
            code: "settled_before_window",
          };
        // Review an action the table carries NO row for is a coverage
        // gap (the sync saw other actions, not this one), not 61 days of silence.
        if (x.attrs.daily.length === 0)
          return nc(
            "not_checkable",
            `no daily rows for this action (${x.name}) in ${CA_DAILY} — a coverage gap, not silence`,
          );
        const fired = new Set(x.attrs.daily.filter(firedOn).map((r) => r.date));
        // Round 4 re-check: a day before the account first spent is not silence (nothing
        // ran that could convert). An account that started mid-window is counted from its
        // first day with spend; no daily spend series = the window start, as before.
        const firstSpend = rows(ctx, "dailyMetrics")
          .filter((r) => (num(r.cost) ?? 0) > 0)
          .map((r) => isoDay(r.metric_date))
          .filter((d): d is string => typeof d === "string" && d.length > 0)
          .sort(cmpStr)[0];
        const from = firstSpend && firstSpend > start ? firstSpend : start;
        // Round 4 follow-up: the account first spent AFTER the last settled day, so the walk
        // below would run zero times and say 0 — "clean" on a day nothing was judged.
        if (from > settled)
          return {
            ...nc(
              "not_checkable",
              `no day with spend has settled yet (the account first spent on ${from}; the last settled day for ${x.name} is ${settled})`,
            ),
            code: "no_settled_spend_day",
          };
        // walk BACKWARDS from the last settled day; stop at the first day that fired
        // or at the first day the account spent (a run that reaches it is "silent for
        // the whole settled window", never more).
        let days = 0;
        for (let d = settled; d >= from; d = addDays(d, -1)) {
          if (fired.has(d)) break;
          days++;
        }
        return {
          value: days,
          window: m90(ctx),
          rowIds: [x.id],
          rowCount: x.attrs.daily.length,
          note: `counted back from ${settled}, the last day this action's own lookback has settled; window start ${start}${from !== start ? `; the account first spent on ${from}, so earlier days are not counted as silence` : ""}`,
        };
      });
    },
  ),
  /**
   * The action's OWN firing rhythm inside the settled window: the median gap
   * (days) between consecutive firing days and the longest gap it ever went
   * without firing. MI01 judges silence against this, never against a fixed
   * two days — a purchase action that fires every third day is not broken
   * because the settled day and the day before happened to be empty.
   */
  def(
    "CA.fire_cadence(action)",
    "conversion_action",
    "mixed",
    "median and longest gap (days) between firing days up to last_settled_day",
    [CA_DAILY],
    "90d",
    "S",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.actionId ?? null, [CA_DAILY], () => {
        const x = actionOf(ctx, a);
        if (!x) return noEntity("conversion action", a?.actionId);
        if (x.attrs.daily == null)
          return nc("not_checkable", `${CA_DAILY} was not loaded for this audit`);
        if (x.attrs.daily.length === 0)
          return nc("not_checkable", `no daily rows for this action (${x.name}) in ${CA_DAILY}`);
        const settled = actionSettledDay(ctx, x);
        if (!settled) return nc("not_checkable", "no settled day");
        const days = x.attrs.daily
          .filter((r) => firedOn(r) && r.date <= settled)
          .map((r) => r.date)
          .sort();
        if (days.length < 2)
          return nc(
            "insufficient_data",
            `${x.name}: ${days.length} firing day(s) up to ${settled} — no gap to measure`,
          );
        const gaps: number[] = [];
        for (let i = 1; i < days.length; i++) gaps.push(daysBetween(days[i - 1]!, days[i]!) - 1); // daysBetween is inclusive; a gap of 1 = consecutive days
        const sorted = [...gaps].sort((p, q) => p - q);
        const mid = Math.floor(sorted.length / 2);
        const median =
          sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
        return {
          value: {
            median_gap: median,
            max_gap: sorted[sorted.length - 1]!,
            firing_days: days.length,
          },
          window: m90(ctx),
          rowIds: [x.id],
          rowCount: x.attrs.daily.length,
          note: `${days.length} firing days up to ${settled}`,
        };
      });
    },
  ),
  def(
    "CA.conv_window(action)",
    "conversion_action",
    "count",
    "conversions summed over the daily rows in the window",
    [CA_DAILY],
    "90d",
    "U",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.actionId ?? null, [CA_DAILY], () => {
        const x = actionOf(ctx, a);
        if (!x) return noEntity("conversion action", a?.actionId);
        if (x.attrs.daily == null)
          return nc("not_checkable", `${CA_DAILY} was not loaded for this audit`);
        if (x.attrs.daily.length === 0)
          return nc("not_checkable", `no daily rows for this action (${x.name}) in ${CA_DAILY}`);
        return {
          value: x.attrs.daily.reduce((n, r) => n + r.conv, 0),
          window: m90(ctx),
          rowIds: [x.id],
          rowCount: x.attrs.daily.length,
        };
      });
    },
  ),
  def(
    "CA.attribution_model(action)",
    "conversion_action",
    "enum",
    "attribution model per action",
    ["conversionActions"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.actionId ?? null, ["conversionActions"], () => {
        const x = actionOf(ctx, a);
        if (!x) return noEntity("conversion action", a?.actionId);
        const m = x.attrs.attributionModel;
        return {
          value: m,
          rowIds: [x.id],
          note:
            m === "UNKNOWN"
              ? "UNKNOWN is a sync-enum artefact, not an unidentified model (f8)"
              : undefined,
        };
      });
    },
  ),
  def(
    "A.attribution_model_mix",
    "account",
    "enum-map",
    "distinct models in use, counts",
    ["conversionActions"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionActions"], () => {
        const out: Record<string, number> = {};
        for (const c of ctx.model.children.conversionActions) {
          const k = c.attrs.attributionModel ?? "NULL";
          out[k] = (out[k] ?? 0) + 1;
        }
        return {
          value: out,
          rowCount: ctx.model.children.conversionActions.length,
          note: 'UNKNOWN rows are a sync-enum artefact — the claim is "N models", never "one unidentified" (f8)',
        };
      });
    },
  ),
  /**
   * The models the BIDDING reads. `A.attribution_model_mix` counts every action
   * the API returns, including REMOVED ones and dormant secondaries, which is
   * how the live run of reported "2 different attribution models" on
   * an account with exactly one primary action on data-driven attribution.
   * A secondary action is allowed its own model: nothing optimises on it.
   */
  def(
    "A.attribution_model_mix_bidding",
    "account",
    "enum-map",
    "distinct models across the actions the bidding uses",
    ["conversionActions"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionActions"], () => {
        const bidding = biddingConversionActions(ctx.model);
        const out: Record<string, number> = {};
        for (const c of bidding) {
          const k = c.attrs.attributionModel ?? "NULL";
          out[k] = (out[k] ?? 0) + 1;
        }
        return {
          value: out,
          rowIds: bidding.map((c) => c.id),
          rowCount: bidding.length,
          note: `judged over the ${bidding.length} action${bidding.length === 1 ? "" : "s"} the bidding uses, of ${ctx.model.children.conversionActions.length} the account holds — removed, hidden, secondary, out-of-Conversions-column actions and goals no live campaign bids on are excluded on purpose`,
        };
      });
    },
  ),
  /** How many actions the bidding actually reads. Zero is a finding of its own, never "consistent". */
  def(
    "A.bidding_action_count",
    "account",
    "count",
    "conversion actions the bidding uses (live, not hidden, primary, in the Conversions column, a goal a live campaign bids on)",
    ["conversionActions"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionActions"], () => {
        const bidding = biddingConversionActions(ctx.model);
        return {
          value: bidding.length,
          rowIds: bidding.map((c) => c.id),
          rowCount: ctx.model.children.conversionActions.length,
        };
      });
    },
  ),
  def(
    "CA.lookback(action)",
    "conversion_action",
    "days",
    "click lookback window",
    ["conversionActions"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.actionId ?? null, ["conversionActions"], () => {
        const x = actionOf(ctx, a);
        if (!x) return noEntity("conversion action", a?.actionId);
        return x.attrs.lookbackDays == null
          ? nc("not_checkable", "lookback_window_days null")
          : { value: x.attrs.lookbackDays, rowIds: [x.id] };
      });
    },
  ),
  def(
    "CA.counting_type(action)",
    "conversion_action",
    "enum",
    "ONE_PER_CLICK / MANY_PER_CLICK",
    ["conversionActions"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.actionId ?? null, ["conversionActions"], () => {
        const x = actionOf(ctx, a);
        if (!x) return noEntity("conversion action", a?.actionId);
        return x.attrs.countingType == null
          ? nc("not_checkable", "counting_type null")
          : { value: x.attrs.countingType, rowIds: [x.id] };
      });
    },
  ),
  def(
    "A.purchase_action_count",
    "account",
    "count",
    "actions whose category is a purchase/sale (closed set)",
    ["conversionActions"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionActions"], () => {
        const cs = ctx.model.children.conversionActions.filter((c) =>
          PURCHASE_CATEGORIES.has(String(c.attrs.category ?? "").toUpperCase()),
        );
        return {
          value: cs.length,
          rowIds: cs.map((c) => c.id),
          rowCount: ctx.model.children.conversionActions.length,
          note: `${cs.filter((c) => c.attrs.isPrimary).length} of them primary`,
        };
      });
    },
  ),
  def(
    "A.conv_per_click_ratio",
    "account",
    "mixed",
    "repeat-count signal for duplicate purchase actions — proxy: MANY_PER_CLICK presence + purchase action count (distinct-order count unavailable)",
    ["derived"],
    "90d",
    "U",
    "30 conv",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionActions", "campaigns"], () => {
        const f = floorCheck("conv", FLOORS.convPerClickRatioConv, accountConv(ctx));
        if (!f.met) return nc("insufficient_data", tooFew(f), f);
        const p = ctx.model.children.conversionActions.filter((c) =>
          PURCHASE_CATEGORIES.has(String(c.attrs.category ?? "").toUpperCase()),
        );
        return {
          value: {
            purchase_actions: p.length,
            many_per_click_purchase_actions: p.filter(
              (c) => c.attrs.countingType === "MANY_PER_CLICK",
            ).length,
          },
          window: m90(ctx),
          floor: f,
          note: "proxy — A.conv / count(distinct order) is not available from the input",
        };
      });
    },
  ),
  def(
    "A.value_rules_enabled_count",
    "account",
    "count",
    "active conversion value rules",
    ["conversionValueRules"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionValueRules"], () => ({
        value: ctx.model.attrs.conversionValueRules.enabled,
        rowCount: ctx.model.attrs.conversionValueRules.total,
      }));
    },
  ),
  // Item 9. What the rules ADD to reported value, from
  // segments.conversion_value_rule_primary_dimension: NO_RULE_APPLIED and
  // ORIGINAL are the value as recorded before any rule; every other dimension
  // row is the net adjustment. amount = total − (ORIGINAL + NO_RULE_APPLIED);
  // share = amount / total, null (never 0) when no value was recorded.
  def(
    "A.value_added_by_rules",
    "account",
    "mixed",
    "{amount, share, total, base}: value the conversion value rules added = total − (ORIGINAL + NO_RULE_APPLIED); share = amount / total",
    [VALUE_BY_RULE],
    "90d",
    "U",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, [VALUE_BY_RULE], () => {
        const rows = ctx.model.attrs.conversionValueByRule;
        if (rows == null)
          return nc("not_checkable", `${VALUE_BY_RULE} was not loaded for this audit`);
        if (rows.length === 0)
          return nc(
            "not_checkable",
            `${VALUE_BY_RULE} has no rows for this audit — the rule dimension split was not recorded, so what the rules add is unknown`,
          );
        const total = rows.reduce((s, r) => s + r.value, 0);
        const base = rows
          .filter((r) => VALUE_RULE_BASE_DIMENSIONS.has(r.dimension))
          .reduce((s, r) => s + r.value, 0);
        // Review UNKNOWN / UNSPECIFIED is a dimension this API
        // version cannot name, not an adjustment. Bucketed apart, never in amount.
        const unknown = rows
          .filter((r) => VALUE_RULE_UNKNOWN_DIMENSIONS.has(r.dimension))
          .reduce((s, r) => s + r.value, 0);
        if (total > 0 && Math.abs(unknown) / total > VALUE_RULE_UNKNOWN_SHARE_MAX)
          return nc(
            "not_checkable",
            `${VALUE_BY_RULE}: ${unknown.toFixed(2)} of ${total.toFixed(2)} (${((unknown / total) * 100).toFixed(1)}%) sits in an UNKNOWN / UNSPECIFIED rule dimension — more than ${VALUE_RULE_UNKNOWN_SHARE_MAX * 100}%, so what the rules add cannot be read`,
          );
        const amount = total - base - unknown;
        const campaigns = new Set(rows.map((r) => r.campaignId)).size;
        const dims = [
          ...new Set(
            rows
              .filter(
                (r) =>
                  !VALUE_RULE_BASE_DIMENSIONS.has(r.dimension) &&
                  !VALUE_RULE_UNKNOWN_DIMENSIONS.has(r.dimension),
              )
              .map((r) => r.dimension),
          ),
        ].sort();
        const unknownNote =
          unknown !== 0
            ? `; ${unknown.toFixed(2)} in an UNKNOWN / UNSPECIFIED dimension, excluded from amount`
            : "";
        return {
          value: {
            amount,
            share: total > 0 ? amount / total : null,
            total,
            base,
            unknown,
            campaigns,
          },
          window: m90(ctx),
          rowCount: rows.length,
          note:
            (dims.length > 0
              ? `rule dimensions with an adjustment: ${dims.join(", ")}`
              : "every row is ORIGINAL or NO_RULE_APPLIED — no rule adjusted any conversion in the window") +
            unknownNote,
        };
      });
    },
  ),
  // ENABLED rules that carry none of the conditions the sync reads (geo incl.
  // excluded, device, audience). One field per ADD rule (`rule_<id>` → the
  // amount added) so each rule id and its amount is an evidence row; MULTIPLY /
  // SET_TO rules are counted in `non_add_rules` (a multiplier or a replacement
  // is not an amount and must not be summed with one). The API has no field
  // for a new-vs-returning condition; see valueRuleHasNoCondition.
  def(
    "A.value_rules_unconditional",
    "account",
    "mixed",
    "ENABLED conversion value rules with no readable condition: rule_<id> → ADD amount, non_add_rules = MULTIPLY / SET_TO count",
    ["conversionValueRules"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionValueRules"], () => {
        const u = ctx.model.attrs.conversionValueRules.unconditional;
        const value: Record<string, number | null> = {};
        for (const r of u) if (r.operation === "ADD") value[`rule_${r.ruleId}`] = r.value;
        const nonAdd = u.filter((r) => r.operation !== "ADD");
        value.non_add_rules = nonAdd.length;
        const ops = [...new Set(u.map((r) => r.operation ?? "UNKNOWN"))].sort();
        return {
          value,
          rowCount: ctx.model.attrs.conversionValueRules.enabled,
          note:
            u.length > 0
              ? `${u.length} of ${ctx.model.attrs.conversionValueRules.enabled} enabled rules carry no geo / device / audience condition (operation ${ops.join(", ")}); the API exposes no new-vs-returning condition, so a customer-acquisition rule looks like this too`
              : undefined,
        };
      });
    },
  ),
  def(
    "A.conv_adjustments_count",
    "account",
    "count",
    "conversion adjustment uploads",
    ["conversionAdjustments"],
    "90d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["conversionAdjustments"], () => ({
        value: ctx.model.attrs.conversionAdjustments,
        window: m90(ctx),
      }));
    },
  ),
  def(
    "A.offline_jobs_success_count",
    "account",
    "count",
    "successful offline data jobs",
    ["offlineUserDataJobs"],
    "90d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["offlineUserDataJobs"], () => ({
        value: ctx.model.attrs.offlineUserDataJobs.success,
        window: m90(ctx),
        rowCount: ctx.model.attrs.offlineUserDataJobs.total,
        truncated: ctx.model.attrs.offlineUserDataJobs.sample,
      }));
    },
  ),
  /**
   * MI12: upload targets (customer lists, store sales) whose LATEST
   * finished upload failed. Not a sample even when the job read is at its cap:
   * the read is newest first, so every list it holds is judged on its newest
   * job, and the cap only drops OLDER history, which this count never uses.
   * `rowCount` = targets judged (the ones with at least one finished job).
   * So the value never carries the job table's cap flag: owners must not read
   * "checked on a sample" on this check.
   */
  def(
    "A.offline_lists_failing",
    "account",
    "count",
    "upload targets whose latest offline upload failed",
    ["offlineUserDataJobs"],
    "90d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      const v = withTables(self, ctx, null, ["offlineUserDataJobs"], () => {
        const jobs = ctx.model.attrs.offlineUserDataJobs.jobs;
        if (jobs == null)
          return nc("not_checkable", "offline job rows were not carried on the model");
        const judged = offlineUploadTargets(jobs).filter((t) => t.latestFinished != null);
        return {
          value: judged.filter((t) => t.latestFinished?.status === "FAILED").length,
          window: m90(ctx),
          rowCount: judged.length,
        };
      });
      return "sample" in v ? { ...v, sample: { truncated: false } } : v;
    },
  ),
  def(
    "A.enhanced_conv_leads",
    "account",
    "bool",
    "enhanced conversions enabled (the effective account-level setting)",
    ["conversionTrackingSettings"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      const s = ctx.model.attrs.conversionTrackingSettings;
      return withTables(self, ctx, null, ["conversion_tracking_settings"], () => {
        const v = s?.enhanced_conversions_enabled;
        return v == null
          ? nc("not_checkable", "conversion_tracking_settings row absent")
          : {
              value: v === true || String(v) === "true",
              table: "conversion_tracking_settings",
            };
      });
    },
  ),
  def(
    "A.customer_data_terms",
    "account",
    "bool",
    "customer data terms accepted",
    ["conversionTrackingSettings"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      const s = ctx.model.attrs.conversionTrackingSettings;
      return withTables(self, ctx, null, ["conversion_tracking_settings"], () => {
        const v = s?.accepted_customer_data_terms;
        return v == null
          ? nc("not_checkable", "conversion_tracking_settings row absent")
          : {
              value: v === true || String(v) === "true",
              table: "conversion_tracking_settings",
            };
      });
    },
  ),
  def(
    "A.tracking_ownership",
    "account",
    "enum",
    "who owns the tracking id",
    ["conversionTrackingSettings"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      const s = ctx.model.attrs.conversionTrackingSettings;
      return withTables(self, ctx, null, ["conversion_tracking_settings"], () => {
        const v = s?.conversion_tracking_status;
        return v == null
          ? nc("not_checkable", "conversion_tracking_settings row absent")
          : { value: String(v), table: "conversion_tracking_settings" };
      });
    },
  ),
  def(
    "C.goal_override(campaign)",
    "campaign",
    "bool",
    "campaign overrides the account goal set",
    ["campaignConversionGoals", "customerConversionGoals"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(
        self,
        ctx,
        a?.campaignId ?? null,
        ["campaignConversionGoals", "customerConversionGoals"],
        () => {
          const c = campaignOf(ctx, a);
          if (!c) return noEntity("campaign", a?.campaignId);
          return c.attrs.conversionGoalsDifferFromCustomer == null
            ? nc("not_checkable", "no campaign_conversion_goals rows for this campaign")
            : {
                value: c.attrs.conversionGoalsDifferFromCustomer,
                rowCount: c.attrs.conversionGoals.length,
              };
        },
      );
    },
  ),
  def(
    "C.viewthrough_share",
    "campaign",
    "pct",
    "share of conversions with no click: view-through / (conversions + view-through)",
    ["campaign_control_settings"],
    "90d",
    "U",
    "10 conv",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["campaign_control_settings"], () => {
        const c = campaignOf(ctx, a);
        if (!c) return noEntity("campaign", a?.campaignId);
        const s = c.attrs.controlSettings;
        if (!s) return nc("not_checkable", "no campaign_control_settings row joins this campaign");
        // B13: all_conversions holds secondary actions too, so it understated the share
        // (12 view-through beside 10.5 conversions read 11.9%, not 53%)
        if (s.conversions == null)
          return nc(
            "not_checkable",
            "conversions were not read beside view-through conversions (an older snapshot)",
          );
        const total =
          s.viewThroughConversions == null ? null : s.conversions + s.viewThroughConversions;
        const f = floorCheck("conv", strongConv(ctx), total);
        if (!f.met)
          return nc(
            "insufficient_data",
            `conversions + view-through ${total ?? 0} < ${f.required}`,
            f,
          );
        const v = ratio(s.viewThroughConversions, total);
        return v == null
          ? nc("not_checkable", "view_through_conversions null")
          : { value: v * 100, window: m90(ctx), floor: f };
      });
    },
  ),
);

// ================================================================ A.3 campaign performance, budget, bidding
const camp = (
  id: string,
  unit: MetricUnit,
  definition: string,
  sources: string[],
  window: string,
  maturity: MaturityRule,
  floor: string,
  fn: (ctx: MetricCtx, c: CampaignNode, a: MetricArgs | undefined) => Partial | NotComputable,
) =>
  def(id, "campaign", unit, definition, sources, window, maturity, floor, (ctx, a, self) => {
    return withTables(
      self,
      ctx,
      a?.campaignId ?? null,
      sources.filter((s) => s !== "derived"),
      () => {
        const c = campaignOf(ctx, a);
        return c ? fn(ctx, c, a) : noEntity("campaign", a?.campaignId);
      },
    );
  });
const cm90 =
  (
    pick: (m: NodeMetrics) => number | null,
    floorMetric?: "conv" | "clicks",
    floorMin?: number | ((ctx: MetricCtx) => number),
  ) =>
  (ctx: MetricCtx, c: CampaignNode): Partial | NotComputable => {
    const m = c.windows.m90;
    if (floorMetric) {
      const min = typeof floorMin === "function" ? floorMin(ctx) : floorMin!;
      const f = floorCheck(floorMetric, min, m[floorMetric]);
      if (!f.met)
        return nc(
          "insufficient_data",
          `${c.name}: ${floorMetric} ${f.actual ?? 0} < ${f.required}`,
          f,
        );
      const v = pick(m);
      return v == null
        ? nc("not_checkable", "denominator 0 or column absent")
        : { value: v, window: m90(ctx), rowIds: [c.id], rowCount: 1, floor: f };
    }
    const v = pick(m);
    return v == null
      ? nc("not_checkable", "column absent on the campaign row")
      : { value: v, window: m90(ctx), rowIds: [c.id], rowCount: 1 };
  };
function budgetDaysOf(ctx: MetricCtx, c: CampaignNode): number | null {
  const daily = campaignDaily(ctx, c.id);
  const first = daily.find((r) => (num(r.cost) ?? 0) > 0);
  const firstDay = first ? isoDay(first.metric_date) : null;
  if (!firstDay || !ctx.window.end || ctx.window.days == null) return null;
  return Math.min(ctx.window.days, Math.max(1, daysBetween(firstDay, ctx.window.end)));
}
function budgetDailyOf(ctx: MetricCtx, c: CampaignNode): number | null {
  const b = c.attrs.budget.amount;
  if (b != null && b > 0) return b;
  const node = ctx.model.children.budgets.find((x) => x.id === c.attrs.budget.id);
  return node?.attrs.amount ?? null;
}
add(
  camp(
    "C.spend",
    "usd",
    "window spend",
    ["campaigns"],
    "90d",
    "N/A",
    "–",
    cm90((m) => m.cost),
  ),
  camp(
    "C.clicks",
    "count",
    "window clicks",
    ["campaigns"],
    "90d",
    "N/A",
    "–",
    cm90((m) => m.clicks),
  ),
  camp(
    "C.impr",
    "count",
    "window impressions",
    ["campaigns"],
    "90d",
    "N/A",
    "–",
    cm90((m) => m.impressions),
  ),
  camp(
    "C.conv",
    "count",
    "window conversions",
    ["campaigns"],
    "90d",
    "U",
    "–",
    cm90((m) => m.conv),
  ),
  camp(
    "C.value",
    "usd",
    "window conversion value",
    ["campaigns"],
    "90d",
    "U",
    "–",
    cm90((m) => m.value),
  ),
  camp(
    "C.roas",
    "ratio",
    "value / cost",
    ["campaigns"],
    "90d",
    "U",
    "10 conv",
    cm90((m) => m.roas, "conv", strongConv),
  ),
  camp(
    "C.cpa",
    "usd",
    "cost / conv",
    ["campaigns"],
    "90d",
    "U",
    "10 conv",
    cm90((m) => m.cpa, "conv", strongConv),
  ),
  camp(
    "C.cvr",
    "ratio",
    "conv / clicks",
    ["campaigns"],
    "90d",
    "U",
    "100 clicks",
    cm90((m) => m.cvr, "clicks", FLOORS.ratesClicks),
  ),
  camp(
    "C.ctr",
    "ratio",
    "clicks / impr",
    ["campaigns"],
    "90d",
    "N/A",
    "100 clicks",
    cm90((m) => m.ctr, "clicks", FLOORS.ratesClicks),
  ),
  camp(
    "C.spend_share",
    "ratio",
    "share of account (eligible) spend",
    ["campaigns"],
    "90d",
    "N/A",
    "–",
    (ctx, c) => {
      const t = accountTotals(ctx).cost;
      const v = ratio(c.windows.m90.cost, t);
      return v == null
        ? nc("not_checkable", "no account spend")
        : { value: v, window: m90(ctx), rowIds: [c.id], computedFrom: ["C.spend", "A.spend"] };
    },
  ),
  camp(
    "C.window(w)",
    "mixed" as MetricUnit,
    "{cost, conv, value, roas, cpa} over a named window (30d, prior30, 7d, prior7, settled_week)",
    ["campaignDailyMetrics"],
    "30d,prior30,7d,prior7,settled_week",
    "U",
    "10 conv",
    (ctx, c, a) => {
      const name = a?.window ?? "30d";
      const wm = windowMetrics(ctx, c, campaignDaily(ctx, c.id), name, "campaignDailyMetrics");
      if (!wm)
        return nc(
          "not_checkable",
          `${c.name}: window '${name}' has no campaign_daily_metrics rows or cannot be placed`,
        );
      const f = floorCheck("conv", strongConv(ctx), wm.m.conv);
      return {
        value: {
          cost: wm.m.cost,
          conv: wm.m.conv,
          value: wm.m.value,
          roas: f.met ? wm.m.roas : null,
          cpa: f.met ? wm.m.cpa : null,
        },
        window: wm.w,
        rowCount: wm.m.provenance.rowCount,
        floor: f,
        note: f.met ? undefined : "roas/cpa withheld below the 10-conv floor",
      };
    },
  ),
  camp(
    "C.windows_agree",
    "bool",
    "7v7 and 30v30 point the same way (±20% move, ROAS when the campaign has value else conversions)",
    ["campaignDailyMetrics"],
    "7d+30d",
    "U",
    "both windows ≥ 10 days",
    (ctx, c) => {
      const daily = campaignDaily(ctx, c.id);
      const w = (n: string) => windowMetrics(ctx, c, daily, n, "campaignDailyMetrics");
      const w30 = w("30d");
      const p30 = w("prior30");
      const w7 = w("7d");
      const p7 = w("prior7");
      if (!w30 || !p30 || !w7 || !p7)
        return nc("not_checkable", `${c.name}: no campaign_daily_metrics rows`);
      const f = floorCheck(
        "days",
        DAYS_MIN_FOR_WINDOW,
        Math.min(w30.m.provenance.rowCount, p30.m.provenance.rowCount),
      );
      if (!f.met)
        return nc(
          "insufficient_data",
          `${c.name}: a 30d side has ${f.actual} daily rows < ${f.required}`,
          f,
        );
      const useRoas = (c.windows.m90.value ?? 0) > 0;
      const dir = (now: number | null, before: number | null) => {
        if (now == null || before == null || before === 0) return 0;
        const ch = ((now - before) / Math.abs(before)) * 100;
        return ch > 20 ? 1 : ch < -20 ? -1 : 0;
      };
      const d7 = useRoas ? dir(w7.m.roas, p7.m.roas) : dir(w7.m.conv, p7.m.conv);
      const d30 = useRoas ? dir(w30.m.roas, p30.m.roas) : dir(w30.m.conv, p30.m.conv);
      return {
        value: d7 === d30 || d7 === 0 || d30 === 0,
        window: w30.w,
        floor: f,
        note: `dir7=${d7} dir30=${d30} on ${useRoas ? "ROAS" : "conversions"}`,
      };
    },
  ),
  camp(
    "C.active_days",
    "count",
    "days with spend",
    ["campaignDailyMetrics"],
    "90d",
    "N/A",
    "–",
    (ctx, c) => {
      const d = campaignDaily(ctx, c.id);
      return d.length === 0
        ? nc("not_checkable", `${c.name}: no campaign_daily_metrics rows`)
        : {
            value: d.filter((r) => (num(r.cost) ?? 0) > 0).length,
            window: m90(ctx),
            rowCount: d.length,
          };
    },
  ),
  // B1 (rules 305, 307, 309, 310, 182, 230). THE ONLY AGE PROXY THIS MODEL HAS.
  // There is no campaign start / created / status-change date anywhere — not on
  // CampaignAttrs, not in buildAccountModel, not in the campaigns sync
  // — so age is measured from the first day the campaign SPENT. Two consequences,
  // both load-bearing:
  //   - it SATURATES at the window length. A campaign that has run for three
  //     years and one that launched exactly at the window start both read ~90.
  //     A saturated value means "at least this old", never "exactly this old",
  //     and the note says so on every saturated row so a reader (or the writer)
  //     cannot quote it as an age.
  //   - it under-reads a campaign that existed but did not spend for its first
  //     weeks. That direction is safe for the learning gate, which only asks
  //     "younger than 14 days?": a campaign that spent nothing was not learning.
  camp(
    "C.age_days",
    "days",
    'days from the first SPENDING day to the window end — a proxy for campaign age; saturates at the window length, so a saturated value means "at least this old"',
    ["campaignDailyMetrics"],
    "90d",
    "N/A",
    "–",
    (ctx, c) => {
      const daily = campaignDaily(ctx, c.id);
      const first = daily.find((r) => (num(r.cost) ?? 0) > 0);
      const firstDay = first ? isoDay(first.metric_date) : null;
      if (!firstDay || !ctx.window.end || ctx.window.days == null)
        return nc(
          "not_checkable",
          `${c.name}: no campaign_daily_metrics row with spend, so there is no first spending day to age from`,
        );
      const days = Math.min(ctx.window.days, Math.max(1, daysBetween(firstDay, ctx.window.end)));
      const saturated = days >= ctx.window.days;
      return {
        value: days,
        window: m90(ctx),
        rowCount: daily.length,
        note: saturated
          ? `first spending day ${firstDay} is at or before the window start — the campaign is AT LEAST ${days} days old, not exactly ${days}`
          : `first spending day ${firstDay}`,
      };
    },
  ),
  camp(
    "C.days_since_last_conv",
    "days",
    "age of the newest converting day",
    ["campaignDailyMetrics"],
    "90d",
    "S",
    "–",
    (ctx, c) => {
      const d = campaignDaily(ctx, c.id).filter((r) => (num(r.conversions) ?? 0) > 0);
      if (d.length === 0) return nc("not_checkable", `${c.name}: no converting day in the series`);
      const last = isoDay(d[d.length - 1].metric_date)!;
      return {
        value: daysBetween(last, ctx.runDate) - 1,
        window: m90(ctx),
        note: `last converting day ${last}`,
      };
    },
  ),
  camp(
    "C.budget_daily",
    "usd",
    "daily budget amount (campaigns.budget, fallback campaign_budgets.amount)",
    ["campaigns", "campaignBudgets"],
    "–",
    "N/A",
    "–",
    (ctx, c) => {
      const v = budgetDailyOf(ctx, c);
      return v == null ? nc("not_checkable", "no budget amount") : { value: v, rowIds: [c.id] };
    },
  ),
  camp(
    "C.budget_days",
    "count",
    "min(W.window_days, days since first spend day + 1); null if no daily series — the cap is the real window length (91), never 90",
    ["campaignDailyMetrics"],
    "window",
    "N/A",
    "–",
    (ctx, c) => {
      const v = budgetDaysOf(ctx, c);
      return v == null
        ? nc("not_checkable", `${c.name}: no campaign_daily_metrics rows with spend`)
        : { value: v, window: m90(ctx) };
    },
  ),
  camp(
    "C.budget_util90",
    "ratio",
    "C.spend / (C.budget_daily × C.budget_days); null, never 0, if budget_days is null",
    ["derived"],
    "90d",
    "N/A",
    "–",
    (ctx, c) => {
      const b = budgetDailyOf(ctx, c);
      const d = budgetDaysOf(ctx, c);
      if (b == null || b <= 0) return nc("not_checkable", "no budget amount");
      if (d == null) return nc("not_checkable", `${c.name}: budget_days null (no daily series)`);
      const v = ratio(c.windows.m90.cost, b * d);
      return v == null
        ? nc("not_checkable", "no spend")
        : {
            value: v,
            window: m90(ctx),
            table: "campaigns",
            computedFrom: ["C.spend", "C.budget_daily", "C.budget_days"],
            note: `budget_days ${d}`,
          };
    },
  ),
  camp(
    "C.capped_days30",
    "count",
    "days in the last 30 spending ≥95% of budget",
    ["campaignDailyMetrics"],
    "30d",
    "N/A",
    "–",
    (ctx, c) => {
      const b = budgetDailyOf(ctx, c);
      if (b == null) return nc("not_checkable", "no budget amount");
      const w = ctx.window.windows.m30;
      const d = rowsInWindow(campaignDaily(ctx, c.id), w);
      if (d.length === 0) return nc("not_checkable", `${c.name}: no daily rows in the last 30`);
      return {
        value: d.filter((r) => (num(r.cost) ?? 0) >= b * 0.95).length,
        window: w,
        rowCount: d.length,
      };
    },
  ),
  camp(
    "C.budget_shared",
    "bool",
    "budget is shared",
    ["campaignBudgets"],
    "–",
    "N/A",
    "–",
    (_ctx, c) => ({
      value: c.attrs.budget.shared,
      rowIds: c.attrs.budget.id ? [c.attrs.budget.id] : [],
    }),
  ),
  camp(
    "C.budget_sibling_count",
    "count",
    "campaigns on the same budget (reference_count)",
    ["campaignBudgets"],
    "–",
    "N/A",
    "–",
    (ctx, c) => {
      const b = ctx.model.children.budgets.find((x) => x.id === c.attrs.budget.id);
      if (!b) return nc("not_checkable", "no campaign_budgets row");
      return { value: b.attrs.referenceCount ?? b.attrs.siblingCampaignIds.length, rowIds: [b.id] };
    },
  ),
  camp(
    "C.lost_is_budget_pct",
    "pct",
    "impression share lost to budget",
    ["impressionShare"],
    "90d",
    "N/A",
    "row must exist",
    (ctx, c) => {
      const is = c.attrs.impressionShare;
      if (is.source === "none")
        return nc("not_checkable", `${c.name}: no impression_share row (${c.attrs.type})`);
      const v = pct(is.lostBudget);
      return v == null
        ? nc("not_checkable", "lost-to-budget null")
        : { value: v, window: m90(ctx), table: is.source };
    },
  ),
  /**
   * The share lost to budget over the window's last weeks (BB02). A 90-day share can come from
   * launch weeks: US - SHOP - HERO read 13% over 90 days and 0% in each of the last 3 weeks.
   * Not checkable when the recent read is missing (old snapshot) or the campaign had no
   * activity then: the caller falls back to the 90-day share or skips.
   */
  camp(
    "C.lost_is_budget_recent_pct",
    "pct",
    "impression share lost to budget over the window's last weeks",
    ["impressionShare"],
    "21d",
    "N/A",
    "row must exist",
    (_ctx, c) => {
      const is = c.attrs.impressionShare;
      if (is.source === "none")
        return nc("not_checkable", `${c.name}: no impression_share row (${c.attrs.type})`);
      const r = is.recent;
      if (r == null) return nc("not_checkable", "the recent weeks were not read");
      if (r.cost <= 0 || r.lostBudget == null)
        return nc("insufficient_data", `${c.name}: no activity in ${r.start} to ${r.end}`);
      return {
        value: pct(r.lostBudget),
        table: is.source,
        note: `${r.start} to ${r.end}: spend ${r.cost.toFixed(2)}, sales ${(r.value ?? 0).toFixed(2)}`,
      };
    },
  ),
  camp(
    "C.lost_is_rank_pct",
    "pct",
    "impression share lost to rank",
    ["impressionShare"],
    "90d",
    "N/A",
    "row must exist",
    (ctx, c) => {
      const is = c.attrs.impressionShare;
      if (is.source === "none")
        return nc("not_checkable", `${c.name}: no impression_share row (${c.attrs.type})`);
      const v = pct(is.lostRank);
      return v == null
        ? nc("not_checkable", "lost-to-rank null")
        : { value: v, window: m90(ctx), table: is.source };
    },
  ),
  camp(
    "C.impression_share",
    "pct",
    "search impression share",
    ["impressionShare"],
    "90d",
    "N/A",
    "row must exist",
    (ctx, c) => {
      const is = c.attrs.impressionShare;
      if (is.source === "none")
        return nc("not_checkable", `${c.name}: no impression_share row (${c.attrs.type})`);
      return { value: pct(is.is), window: m90(ctx), table: is.source };
    },
  ),
  camp("C.strategy", "enum", "bidding strategy type", ["campaigns"], "–", "N/A", "–", (_ctx, c) =>
    c.attrs.strategy
      ? { value: c.attrs.strategy, rowIds: [c.id] }
      : nc("not_checkable", "bidding_strategy_type null"),
  ),
  camp("C.target_roas", "ratio", "the tROAS set", ["campaigns"], "–", "N/A", "–", (_ctx, c) => ({
    value: c.attrs.targetRoas,
    rowIds: [c.id],
    note: c.attrs.targetRoas == null ? "no target set" : undefined,
  })),
  camp("C.target_cpa", "usd", "the tCPA set", ["campaigns"], "–", "N/A", "–", (_ctx, c) => ({
    value: c.attrs.targetCpa,
    rowIds: [c.id],
    note: c.attrs.targetCpa == null ? "no target set" : undefined,
  })),
  camp(
    "C.target_vs_realized",
    "ratio",
    "C.target_roas / C.window(30d).roas",
    ["derived"],
    "30d",
    "U",
    "10 conv",
    (ctx, c) => {
      if (c.attrs.targetRoas == null) return nc("not_checkable", "no tROAS set");
      const wm = windowMetrics(ctx, c, null, "30d", "campaignDailyMetrics");
      if (!wm) return nc("not_checkable", `${c.name}: no 30d window`);
      const f = floorCheck("conv", strongConv(ctx), wm.m.conv);
      if (!f.met)
        return nc("insufficient_data", `${c.name}: conv30 ${f.actual ?? 0} < ${f.required}`, f);
      const v = ratio(c.attrs.targetRoas, wm.m.roas);
      return v == null
        ? nc("not_checkable", "no realised ROAS")
        : { value: v, window: wm.w, table: "campaignDailyMetrics", floor: f };
    },
  ),
  camp(
    "C.ladder_verdict",
    "enum",
    "bid target vs 30-day conversion volume (settings.bidding): ahead_of_data / ready_for_target / ok",
    ["derived"],
    "30d",
    "U",
    "–",
    (ctx, c) => {
      const wm = windowMetrics(ctx, c, null, "30d", "campaignDailyMetrics");
      if (!wm) return nc("not_checkable", `${c.name}: no 30d window`);
      const conv30 = wm.m.conv ?? 0;
      const s = String(c.attrs.strategy ?? "").toUpperCase();
      const valueBidding = s.includes("CONVERSION_VALUE") || s.includes("TARGET_ROAS");
      const cpaBidding = s.includes("TARGET_CPA") || s === "MAXIMIZE_CONVERSIONS";
      let v = "ok";
      if (
        (valueBidding &&
          c.attrs.targetRoas != null &&
          conv30 < ctx.settings.bidding.targetRoasMinConv30d) ||
        (cpaBidding &&
          c.attrs.targetCpa != null &&
          conv30 < ctx.settings.bidding.targetCpaMinConv30d)
      )
        v = "ahead_of_data";
      // one-click phase 1: a portfolio campaign's target lives on the portfolio, not the
      // campaign row, so "no target set" there is not a fact — never ready_for_target.
      // The bar is the target it would get (value bidding -> a target ROAS, Maximize
      // conversions -> a target CPA); other bidding first moves to value bidding with no
      // target, so Google's own minimum (valueBiddingMinConv30d) is the bar there.
      else if (
        c.attrs.targetRoas == null &&
        c.attrs.targetCpa == null &&
        conv30 >=
          (valueBidding
            ? ctx.settings.bidding.targetRoasMinConv30d
            : cpaBidding
              ? ctx.settings.bidding.targetCpaMinConv30d
              : ctx.settings.bidding.valueBiddingMinConv30d) &&
        !c.attrs.isBrand &&
        !c.attrs.portfolioStrategyId &&
        c.attrs.biddingStrategySource !== "portfolio"
      )
        v = "ready_for_target";
      return {
        value: v,
        window: wm.w,
        table: "campaignDailyMetrics",
        note: `conv30 ${conv30.toFixed(2)}, strategy ${s}`,
      };
    },
  ),
  camp(
    "C.portfolio_strategy",
    "enum",
    "portfolio strategy attached (campaigns.bidding_strategy_resource)",
    ["campaigns"],
    "–",
    "N/A",
    "–",
    (_ctx, c) =>
      c.attrs.portfolioStrategyId
        ? { value: c.attrs.portfolioStrategyId, rowIds: [c.id] }
        : nc(
            "not_checkable",
            `${c.name}: bidding_strategy_resource is null — no portfolio strategy attached, or the input did not carry the link`,
          ),
  ),
  camp(
    "C.seasonality_adjustments",
    "count",
    "seasonality / data-exclusion overrides in the window scoped to the campaign",
    ["biddingOverrides"],
    "90d",
    "N/A",
    "–",
    (ctx, c) => {
      const all = rows(ctx, "biddingOverrides");
      const mine = all.filter(
        (r) =>
          String(r.campaign_id ?? "") === c.id ||
          String(r.scope ?? "").includes(c.id) ||
          String(r.campaigns ?? "").includes(c.id),
      );
      return { value: mine.length, window: m90(ctx), rowCount: all.length };
    },
  ),
  camp(
    "C.simulation_points",
    "count",
    "target-change simulation points available",
    ["simulations"],
    "–",
    "N/A",
    "–",
    (ctx, c) => {
      // the campaign id parsed from the resource name, compared whole ("campaigns/1" is not "campaigns/11")
      const mine = rows(ctx, "simulations").filter(
        (r) => /\/campaigns\/(\d+)(?:[/~]|$)/.exec(String(r.resource_name ?? ""))?.[1] === c.id,
      );
      if (mine.length === 0) return nc("not_checkable", `${c.name}: no simulation row`);
      let n = 0;
      for (const s of mine) {
        const p =
          typeof s.points_json === "string"
            ? (() => {
                try {
                  return JSON.parse(s.points_json);
                } catch {
                  return [];
                }
              })()
            : s.points_json;
        n += Array.isArray(p) ? p.length : 0;
      }
      return { value: n, rowCount: mine.length };
    },
  ),
  camp(
    "C.geo_target_type",
    "enum",
    "presence vs presence-or-interest",
    ["campaigns"],
    "–",
    "N/A",
    "–",
    (_ctx, c) =>
      c.attrs.geoTargetType
        ? { value: c.attrs.geoTargetType, rowIds: [c.id] }
        : nc("not_checkable", "geo_target_type null"),
  ),
  camp(
    "C.frequency_caps_present",
    "bool",
    "any frequency cap set",
    ["campaign_control_settings"],
    "–",
    "N/A",
    "–",
    (_ctx, c) => {
      const s = c.attrs.controlSettings;
      if (!s) return nc("not_checkable", "no campaign_control_settings row joins this campaign");
      const caps = s.frequencyCaps;
      return {
        value: Array.isArray(caps)
          ? caps.length > 0
          : caps != null && typeof caps === "object" && Object.keys(caps as object).length > 0,
      };
    },
  ),
  camp(
    "C.auto_assets_optin",
    "enum[]",
    "auto-asset types opted in",
    ["campaign_control_settings"],
    "–",
    "N/A",
    "–",
    (_ctx, c) => {
      const s = c.attrs.controlSettings;
      if (!s) return nc("not_checkable", "no campaign_control_settings row joins this campaign");
      const list = Array.isArray(s.assetAutomation) ? s.assetAutomation : [];
      return {
        value: list
          .filter(
            (x: any) =>
              String(x?.status ?? x?.asset_automation_status ?? "").toUpperCase() === "OPTED_IN",
          )
          .map((x: any) => String(x?.type ?? x?.asset_automation_type ?? "")),
      };
    },
  ),
  // `campaign.url_expansion_opt_out` was removed in Google Ads API v22; the
  // answer now lives in the campaign's asset automation settings
  // (FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION: OPTED_OUT = expansion off).
  // Same source as C.auto_assets_optin. The legacy column stays as a fallback
  // for audits synced before the field died.
  camp(
    "C.url_expansion_opt_out",
    "bool",
    "PMax final-URL expansion off",
    ["campaign_control_settings"],
    "–",
    "N/A",
    "–",
    (_ctx, c) => {
      const s = c.attrs.controlSettings;
      const list = s && Array.isArray(s.assetAutomation) ? s.assetAutomation : [];
      const entry = list.find(
        (x: any) =>
          String(
            x?.type ?? x?.asset_automation_type ?? x?.assetAutomationType ?? "",
          ).toUpperCase() === "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION",
      );
      if (entry) {
        const st = String(
          entry?.status ?? entry?.asset_automation_status ?? entry?.assetAutomationStatus ?? "",
        ).toUpperCase();
        if (st === "OPTED_OUT")
          return {
            value: true,
            rowIds: [c.id],
            note: "asset_automation FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION = OPTED_OUT",
          };
        if (st === "OPTED_IN")
          return {
            value: false,
            rowIds: [c.id],
            note: "asset_automation FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION = OPTED_IN",
          };
      }
      if (c.attrs.urlExpansionOptOut != null)
        return {
          value: c.attrs.urlExpansionOptOut,
          rowIds: [c.id],
          table: "campaigns",
          note: "legacy campaigns.url_expansion_opt_out column (field removed in API v22)",
        };
      if (!s) return nc("not_checkable", "no campaign_control_settings row joins this campaign");
      return nc(
        "not_checkable",
        "asset_automation carries no FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION entry and campaigns.url_expansion_opt_out is null — unknown, never false",
      );
    },
  ),
  camp(
    "C.tracking_break_run_days",
    "days",
    "consecutive same-weekday conversion collapses ending at the freshest evaluable day (freshest 2 excluded)",
    ["campaignDailyMetrics"],
    "14d",
    "S",
    "baseline conv ≥ 3",
    (ctx, c) => {
      const daily = campaignDaily(ctx, c.id)
        .map((r) => ({
          d: isoDay(r.metric_date)!,
          cost: num(r.cost) ?? 0,
          conv: num(r.conversions) ?? 0,
        }))
        .filter((r) => r.d);
      if (daily.length === 0 || !ctx.window.end)
        return nc("not_checkable", `${c.name}: no campaign_daily_metrics rows`);
      const end = ctx.window.end;
      const age = (d: string) => daysBetween(d, end) - 1; // 0 = the last day
      const baseRows = daily.filter((r) => age(r.d) >= 14);
      const byDow = new Map<number, { conv: number; cost: number; n: number }>();
      const dow = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();
      for (const r of baseRows) {
        const k = dow(r.d);
        const b = byDow.get(k) ?? { conv: 0, cost: 0, n: 0 };
        b.conv += r.conv;
        b.cost += r.cost;
        b.n++;
        byDow.set(k, b);
      }
      const evalRows = daily
        .filter((r) => age(r.d) >= TRACKING_BREAK.freshDaysExcluded && age(r.d) < 14)
        .sort((a, b) => cmpStr(b.d, a.d));
      if (evalRows.length === 0)
        return nc("insufficient_data", `${c.name}: no evaluable day in the last 14`);
      let run = 0;
      let baselineOk = false;
      for (const r of evalRows) {
        const b = byDow.get(dow(r.d));
        if (!b || b.n === 0) break;
        const bc = b.conv / b.n;
        const bcost = b.cost / b.n;
        if (bc < TRACKING_BREAK.minBaselineConv) break;
        baselineOk = true;
        const collapsed =
          r.conv <= bc * (1 - TRACKING_BREAK.dropPct / 100) &&
          Math.abs(r.cost - bcost) <= bcost * (TRACKING_BREAK.costBandPct / 100);
        if (!collapsed) break;
        run++;
      }
      if (!baselineOk) {
        const f = floorCheck("baseline conv", TRACKING_BREAK.minBaselineConv, null);
        return nc(
          "insufficient_data",
          `${c.name}: weekday baseline below ${TRACKING_BREAK.minBaselineConv} conv`,
          f,
        );
      }
      return {
        value: run,
        window: windowSpecFor("7d", ctx.window) ?? undefined,
        note: `evaluated ${evalRows.length} days, freshest ${TRACKING_BREAK.freshDaysExcluded} excluded`,
      };
    },
  ),
);

// ================================================================ A.4 structure, negatives, changes
add(
  def(
    "A.negatives_count",
    "account",
    "count",
    "negative keyword criteria attached at account level",
    ["accountNegatives"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["accountNegatives"], () => ({
        value: ctx.model.attrs.negatives.accountNegativesRows,
        rowCount: ctx.model.attrs.negatives.accountNegativesRows,
      }));
    },
  ),
  def(
    "A.negative_list_members",
    "account",
    "count",
    "negative keywords reachable through the account's KNOWN shared lists (members ⋈ lists)",
    ["sharedNegativeListMembers", "sharedNegativeLists"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(
        self,
        ctx,
        null,
        ["sharedNegativeListMembers", "sharedNegativeLists"],
        () => {
          const p = ctx.population.get("sharedNegativeListMembers");
          if (!p) return nc("not_checkable", "members table not loaded");
          return {
            value: p.attached,
            rowCount: p.rows,
            note: `${p.orphans} member rows belong to lists the input did not declare — stated, not hidden`,
          };
        },
      );
    },
  ),
  def(
    "A.negative_list_member_sum",
    "account",
    "count",
    "the lists' own declared member totals",
    ["sharedNegativeLists"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["sharedNegativeLists"], () => ({
        value: ctx.model.attrs.negatives.sharedListMemberTotalDeclared,
        rowCount: ctx.model.attrs.negatives.listsDeclared,
      }));
    },
  ),
  def(
    "A.negative_lists_count",
    "account",
    "count",
    "shared negative lists",
    ["sharedNegativeLists"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["sharedNegativeLists"], () => ({
        value: ctx.model.attrs.negatives.listsDeclared,
        rowCount: ctx.model.attrs.negatives.listsDeclared,
      }));
    },
  ),
  def(
    "A.negative_lists_unattached",
    "account",
    "count",
    "lists with no linked campaign",
    ["sharedNegativeLists"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["sharedNegativeLists"], () => {
        const ls = rows(ctx, "sharedNegativeLists");
        const un = ls.filter((l) => {
          const v = l.linked_campaign_ids;
          const arr =
            typeof v === "string"
              ? (() => {
                  try {
                    return JSON.parse(v);
                  } catch {
                    return v === "{}" ? [] : [v];
                  }
                })()
              : v;
          return arr == null || (Array.isArray(arr) && arr.length === 0);
        });
        return {
          value: un.length,
          rowCount: ls.length,
          rowIds: un.map((l) => String(l.shared_set_id)),
        };
      });
    },
  ),
  def(
    "C.negatives_count",
    "campaign",
    "count",
    "campaign-level negatives — null when the marker is absent, never 0",
    ["campaign_negatives", "campaign_negatives_sync_marker"],
    "–",
    "N/A",
    "marker required",
    (ctx, a, self) => {
      return withTables(
        self,
        ctx,
        a?.campaignId ?? null,
        ["campaign_negatives", "campaign_negatives_sync_marker"],
        () => {
          const c = campaignOf(ctx, a);
          if (!c) return noEntity("campaign", a?.campaignId);
          if (c.children.negatives == null)
            return nc(
              "not_checkable",
              `${c.name}: no campaign_negatives_sync_marker for this campaign`,
            );
          return {
            value: c.children.negatives.reduce((s, l) => s + l.attrs.memberCount, 0),
            table: "campaign_negatives",
            rowCount: c.children.negatives.length,
          };
        },
      );
    },
  ),
  def(
    "T.blocked_level(term)",
    "search_term",
    "enum",
    "lowest level already blocking this term: campaign → shared_list → account → none; unknown when a lower level cannot be evaluated",
    ["campaign_negatives", "sharedNegativeListMembers", "accountNegatives"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(
        self,
        ctx,
        a?.searchTermId ?? null,
        [
          "sharedNegativeListMembers",
          "accountNegatives",
        ] /* campaign_negatives is deliberately NOT gated: the formula returns 'unknown' for it, which preserves the levels we can prove */,
        () => {
          const t = termOf(ctx, a);
          if (!t) return noEntity("search term", a?.searchTermId);
          const b = t.attrs.blocked;
          const order: [string, typeof b.campaign][] = [
            ["campaign", b.campaign],
            ["shared_list", b.sharedList],
            ["account", b.account],
          ];
          let unknown = false;
          for (const [lvl, st] of order) {
            if (st === "blocked")
              return {
                value: lvl,
                table: "derived",
                note: unknown ? "a lower level was unknown" : undefined,
                rowIds: b.by,
              };
            if (st === "unknown") unknown = true;
          }
          return { value: unknown ? "unknown" : "none", table: "derived" };
        },
      );
    },
  ),
  def(
    "A.content_exclusions_count",
    "account",
    "count",
    "content-label / app-category exclusions",
    ["account_negative_criteria"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["account_negative_criteria"], () => {
        const n = ctx.model.children.negativeLists
          .filter((l) => l.attrs.source === "account_negative_criteria")
          .reduce((s, l) => s + l.attrs.memberCount, 0);
        const p = ctx.population.get("account_negative_criteria");
        return { value: p?.rows ?? n, rowCount: p?.rows ?? n };
      });
    },
  ),
  // R3.6d: the excluded content labels and app categories BY NAME ("CONTENT_LABEL:TRAGEDY", "MOBILE_APP_CATEGORY:<constant>")
  def(
    "A.brand_safety_exclusions",
    "account",
    "enum[]",
    "content labels and app categories excluded at account level, by name",
    ["account_negative_criteria"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["account_negative_criteria"], () => {
        const b = ctx.model.attrs.brandSafetyExclusions;
        if (b == null)
          return nc("not_checkable", "account negative criteria were not loaded into the model");
        const v = [
          ...b.contentLabels.map((l) => `CONTENT_LABEL:${l}`),
          ...b.appCategories.map((c) => `MOBILE_APP_CATEGORY:${c}`),
        ];
        return { value: v, rowCount: v.length };
      });
    },
  ),
  def(
    "A.placement_exclusions_count",
    "account",
    "count",
    "account placement exclusions",
    ["account_placement_exclusions"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["account_placement_exclusions"], () =>
        nc("not_checkable", "table not loaded into the model"),
      );
    },
  ),
  def(
    "A.auto_apply_enabled_count",
    "account",
    "count",
    "recommendation types auto-applying",
    ["recommendationSubscriptions"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["recommendationSubscriptions"], () => ({
        value: ctx.model.attrs.recommendationSubscriptions.filter(
          (r) => String(r.status).toUpperCase() === "ENABLED",
        ).length,
        rowCount: ctx.model.attrs.recommendationSubscriptions.length,
      }));
    },
  ),
  def(
    "A.experiments_active",
    "account",
    "count",
    "experiments not ended",
    ["experiments"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["experiments"], () => {
        const ended = new Set(["REMOVED", "ENDED", "HALTED", "ENDED_MANUALLY"]);
        const act = ctx.model.attrs.experiments.filter(
          (e) => !ended.has(String(e.status ?? "").toUpperCase()),
        );
        return {
          value: act.length,
          rowCount: ctx.model.attrs.experiments.length,
          rowIds: act.map((e) => e.id),
        };
      });
    },
  ),
  def(
    "C.experiment_arm",
    "campaign",
    "bool",
    "campaign is an arm of an experiment",
    ["experimentArms"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["experimentArms"], () => {
        const c = campaignOf(ctx, a);
        if (!c) return noEntity("campaign", a?.campaignId);
        return { value: c.attrs.experimentIds.length > 0, rowIds: c.attrs.experimentIds };
      });
    },
  ),
  // N11: the change history covers what Google keeps (about 30 days), never the 90-day
  // window: these metrics carry no window, so no reply labels 29 days of changes "m90"
  def(
    "A.change_count",
    "account",
    "count",
    "changes in the feed (capped 1000)",
    ["changeHistory"],
    "30d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["changeHistory"], () => ({
        value: ctx.model.attrs.changeHistory.rows,
        rowCount: ctx.model.attrs.changeHistory.rows,
        truncated: ctx.model.attrs.changeHistory.sample,
        cap: ctx.model.attrs.changeHistory.cap ?? undefined,
      }));
    },
  ),
  def(
    "A.change_users",
    "account",
    "count",
    "distinct editors",
    ["changeHistory"],
    "30d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["changeHistory"], () => ({
        value: ctx.model.attrs.changeHistory.users,
        rowCount: ctx.model.attrs.changeHistory.rows,
        truncated: ctx.model.attrs.changeHistory.sample,
      }));
    },
  ),
  // plan 5.2 (Gate 1 row 8): changes per editor, most first, no email (the model drops it)
  def(
    "A.change_editors",
    "account",
    "row[]",
    "changes per editor, most first, split person / google / api / unknown (no email)",
    ["changeHistory"],
    "30d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["changeHistory"], () => {
        const h = ctx.model.attrs.changeHistory;
        return h.editors == null
          ? nc("not_checkable", "the model carries no per-editor change counts")
          : {
              value: h.editors,
              rowCount: h.rows,
              truncated: h.sample,
              note: `${h.noEditor ?? 0} change row(s) carry no user email`,
            };
      });
    },
  ),
  // R3.6c: changes Google made itself (auto-applied recommendations, Google's own tools), with what they touched
  def(
    "A.google_made_changes",
    "account",
    "row[]",
    "changes made by auto-applied recommendations or Google internal tools: date, campaign, kind, source",
    ["changeHistory"],
    "30d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["changeHistory"], () => {
        const h = ctx.model.attrs.changeHistory;
        return h.googleMade == null
          ? nc("not_checkable", "the model carries no Google-made change list")
          : {
              value: h.googleMade.map((c) => ({ ...c, campaignIds: [...c.campaignIds] })),
              rowCount: h.rows,
              truncated: h.sample,
            };
      });
    },
  ),
  def(
    "A.change_days_covered",
    "account",
    "days",
    "days the change feed actually spans (cap detector)",
    ["changeHistory"],
    "30d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["changeHistory"], () => {
        const h = ctx.model.attrs.changeHistory;
        return h.firstDate && h.lastDate
          ? {
              value: daysBetween(h.firstDate, h.lastDate),
              truncated: h.sample,
              note: `${h.firstDate}..${h.lastDate} of a ${ctx.window.days ?? "?"}-day window`,
            }
          : nc("not_checkable", "no dated change rows");
      });
    },
  ),
  def(
    "CH.changes_near(campaign, date, ±3d)",
    "campaign",
    "row[]",
    "dated causes around a step in the series",
    ["changeHistory"],
    "±3d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["changeHistory"], () => {
        const c = campaignOf(ctx, a);
        if (!c) return noEntity("campaign", a?.campaignId);
        if (!a?.date) return nc("no_entity", "pass date=YYYY-MM-DD");
        const lo = addDays(a.date, -3);
        const hi = addDays(a.date, 3);
        const hits = rows(ctx, "changeHistory")
          .filter((r) => String(r.change_resource_name ?? "").includes(`campaigns/${c.id}`))
          .filter((r) => {
            const d = isoDay(r.change_date_time);
            return d != null && d >= lo && d <= hi;
          })
          .map((r) => ({
            date: isoDay(r.change_date_time),
            resource: String(r.change_resource_type ?? ""),
            operation: String(r.operation ?? ""),
            fields: r.changed_fields ?? null,
            user: String(r.user_email ?? ""),
          }));
        return {
          value: hits,
          rowCount: hits.length,
          truncated: ctx.model.attrs.changeHistory.sample,
        };
      });
    },
  ),
  def(
    "A.user_count",
    "account",
    "count",
    "users with access",
    ["customerUserAccess"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["customerUserAccess"], () => ({
        value: ctx.model.attrs.users.length,
        rowCount: ctx.model.attrs.users.length,
      }));
    },
  ),
  def(
    "A.audience_lists_count",
    "account",
    "count",
    "remarketing / customer-match lists",
    ["audienceLists"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["audienceLists"], () => ({
        value: ctx.model.attrs.audienceLists.total,
        rowCount: ctx.model.attrs.audienceLists.total,
      }));
    },
  ),
  def(
    "A.audience_lists_usable",
    "account",
    "count",
    "lists big enough to target (size_for_search > 0)",
    ["audienceLists"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["audienceLists"], () => ({
        value: ctx.model.attrs.audienceLists.withSearchSize,
        rowCount: ctx.model.attrs.audienceLists.total,
      }));
    },
  ),
  // Phase 11b: the checklist is the repo's own 7 essential e-commerce lists (services/audit/audienceRoles.ts
  // ESSENTIAL_ROLES, the same one PMax audience signals and CustomerListsAnalyzer use); matched on each list's
  // definition (rule / purchase conversion action / life span) first, its name only as a fallback.
  def(
    "A.required_list_coverage",
    "account",
    "enum-map",
    "which of the 7 required list archetypes exist (role -> lists matching it; 0 = missing)",
    ["audienceLists"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["audienceLists"], () => {
        const cov = requiredListCoverageOf(ctx.model);
        const value: Record<string, number> = {};
        for (const role of ESSENTIAL_ROLES) value[role] = cov.matches[role].length;
        const matched = ESSENTIAL_ROLES.filter((r) => cov.matches[r].length > 0).map(
          (r) => `${r}: ${cov.matches[r].map((m) => `${m.name} (${m.basis})`).join(", ")}`,
        );
        return {
          value,
          rowCount: ctx.model.children.audienceLists.length,
          note: `${cov.judged} open list(s) judged${cov.definitionsRead ? "" : ", list definitions not read (name match only)"}${matched.length ? `; ${matched.join("; ")}` : ""}`,
        };
      });
    },
  ),
);

// ================================================================ A.5 ad group, keyword, search term
add(
  def(
    "G.spend",
    "ad_group",
    "usd",
    "ad group spend",
    ["adGroups"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adGroupId ?? null, ["adGroups"], () => {
        const g = adGroupOf(ctx, a);
        if (!g) return noEntity("ad group", a?.adGroupId);
        return { value: g.windows.m90.cost, window: m90(ctx), rowIds: [g.id] };
      });
    },
  ),
  def(
    "G.conv",
    "ad_group",
    "count",
    "ad group conversions",
    ["adGroups"],
    "90d",
    "U",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adGroupId ?? null, ["adGroups"], () => {
        const g = adGroupOf(ctx, a);
        if (!g) return noEntity("ad group", a?.adGroupId);
        return { value: g.windows.m90.conv, window: m90(ctx), rowIds: [g.id] };
      });
    },
  ),
  def(
    "G.roas",
    "ad_group",
    "ratio",
    "ad group ROAS",
    ["adGroups"],
    "90d",
    "U",
    "10 conv",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adGroupId ?? null, ["adGroups"], () => {
        const g = adGroupOf(ctx, a);
        if (!g) return noEntity("ad group", a?.adGroupId);
        if (g.windows.m90.value == null)
          return nc("not_checkable", "ad_groups has no conversion_value column");
        const f = floorCheck("conv", strongConv(ctx), g.windows.m90.conv);
        if (!f.met) return nc("insufficient_data", tooFew(f), f);
        return { value: g.windows.m90.roas, window: m90(ctx), rowIds: [g.id], floor: f };
      });
    },
  ),
  def(
    "G.impression_share",
    "ad_group",
    "pct",
    "ad-group search IS",
    ["adGroups"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adGroupId ?? null, ["adGroups"], () => {
        const g = adGroupOf(ctx, a);
        if (!g) return noEntity("ad group", a?.adGroupId);
        return g.attrs.impressionShare.is == null
          ? nc("not_checkable", "search_impression_share null")
          : { value: pct(g.attrs.impressionShare.is), window: m90(ctx), rowIds: [g.id] };
      });
    },
  ),
  def(
    "G.lost_is_budget",
    "ad_group",
    "pct",
    "ad-group IS lost to budget",
    ["adGroups"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adGroupId ?? null, ["adGroups"], () => {
        const g = adGroupOf(ctx, a);
        if (!g) return noEntity("ad group", a?.adGroupId);
        return g.attrs.impressionShare.lostBudget == null
          ? nc("not_checkable", "search_budget_lost_impression_share null")
          : { value: pct(g.attrs.impressionShare.lostBudget), window: m90(ctx), rowIds: [g.id] };
      });
    },
  ),
  def(
    "G.lost_is_rank",
    "ad_group",
    "pct",
    "ad-group IS lost to rank",
    ["adGroups"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adGroupId ?? null, ["adGroups"], () => {
        const g = adGroupOf(ctx, a);
        if (!g) return noEntity("ad group", a?.adGroupId);
        return g.attrs.impressionShare.lostRank == null
          ? nc("not_checkable", "search_rank_lost_impression_share null")
          : { value: pct(g.attrs.impressionShare.lostRank), window: m90(ctx), rowIds: [g.id] };
      });
    },
  ),
  def(
    "G.ads_count",
    "ad_group",
    "count",
    "ads live in the group",
    ["ads"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adGroupId ?? null, ["ads"], () => {
        const g = adGroupOf(ctx, a);
        if (!g) return noEntity("ad group", a?.adGroupId);
        return { value: g.attrs.adsCount, rowCount: g.attrs.adsCount };
      });
    },
  ),
  def(
    "G.rsa_count",
    "ad_group",
    "count",
    "RSAs in the group",
    ["ads"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adGroupId ?? null, ["ads"], () => {
        const g = adGroupOf(ctx, a);
        if (!g) return noEntity("ad group", a?.adGroupId);
        return { value: g.attrs.rsaCount, rowCount: g.attrs.adsCount };
      });
    },
  ),
  def(
    "G.keyword_count",
    "ad_group",
    "count",
    "non-negative keywords",
    ["keywords"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adGroupId ?? null, ["keywords"], () => {
        const g = adGroupOf(ctx, a);
        if (!g) return noEntity("ad group", a?.adGroupId);
        return { value: g.attrs.keywordCount, rowCount: g.children.keywords.length };
      });
    },
  ),
  def(
    "K.spend",
    "keyword",
    "usd",
    "keyword spend",
    ["keywords"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        return { value: k.windows.m90.cost, window: m90(ctx), rowIds: [k.id] };
      });
    },
  ),
  def(
    "K.clicks",
    "keyword",
    "count",
    "keyword clicks",
    ["keywords"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        return { value: k.windows.m90.clicks, window: m90(ctx), rowIds: [k.id] };
      });
    },
  ),
  def(
    "K.conv",
    "keyword",
    "count",
    "keyword conversions",
    ["keywords"],
    "90d",
    "U",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        return { value: k.windows.m90.conv, window: m90(ctx), rowIds: [k.id] };
      });
    },
  ),
  def(
    "K.value",
    "keyword",
    "usd",
    "keyword conversion value (conversions_value)",
    ["keywords"],
    "90d",
    "U",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        return { value: k.windows.m90.value, window: m90(ctx), rowIds: [k.id] };
      });
    },
  ),
  def(
    "K.roas",
    "keyword",
    "ratio",
    "conversions_value / cost",
    ["keywords"],
    "90d",
    "U",
    "10 conv",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        const f = floorCheck("conv", strongConv(ctx), k.windows.m90.conv);
        if (!f.met) return nc("insufficient_data", tooFew(f), f);
        return { value: k.windows.m90.roas, window: m90(ctx), rowIds: [k.id], floor: f };
      });
    },
  ),
  def(
    "K.cpa",
    "keyword",
    "usd",
    "cost / conversions",
    ["keywords"],
    "90d",
    "U",
    "10 conv",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        const f = floorCheck("conv", strongConv(ctx), k.windows.m90.conv);
        if (!f.met) return nc("insufficient_data", tooFew(f), f);
        return { value: k.windows.m90.cpa, window: m90(ctx), rowIds: [k.id], floor: f };
      });
    },
  ),
  def(
    "K.qs",
    "keyword",
    "count",
    "quality score (only when > 0)",
    ["keywords"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        return k.attrs.qs == null || k.attrs.qs <= 0
          ? nc("not_checkable", "quality_score not reported (null / 0)")
          : { value: k.attrs.qs, rowIds: [k.id] };
      });
    },
  ),
  def(
    "K.qs_component.expected_ctr",
    "keyword",
    "enum",
    "QS component; BELOW_AVERAGE is the failing state",
    ["keywords"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        return k.attrs.qsComponents.expectedCtr == null
          ? nc("not_checkable", "expected_ctr null")
          : { value: k.attrs.qsComponents.expectedCtr, rowIds: [k.id] };
      });
    },
  ),
  def(
    "K.qs_component.ad_relevance",
    "keyword",
    "enum",
    "QS component; BELOW_AVERAGE is the failing state",
    ["keywords"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        return k.attrs.qsComponents.adRelevance == null
          ? nc("not_checkable", "ad_relevance null")
          : { value: k.attrs.qsComponents.adRelevance, rowIds: [k.id] };
      });
    },
  ),
  def(
    "K.qs_component.landing_page_experience",
    "keyword",
    "enum",
    "QS component; BELOW_AVERAGE is the failing state",
    ["keywords"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        return k.attrs.qsComponents.landingPageExperience == null
          ? nc("not_checkable", "landing_page_experience null")
          : { value: k.attrs.qsComponents.landingPageExperience, rowIds: [k.id] };
      });
    },
  ),
  def(
    "K.match_type",
    "keyword",
    "enum",
    "match type",
    ["keywords"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        return k.attrs.matchType == null
          ? nc("not_checkable", "match_type null")
          : { value: k.attrs.matchType, rowIds: [k.id] };
      });
    },
  ),
  def(
    "K.zero_conv_threshold_clicks",
    "account",
    "count",
    'clicks needed before "0 conversions" means anything: statisticalThresholdFromCvr(A.cvr), clamp 50-400, default 100 when CVR unusable',
    ["searchOptimizerRulebook", "campaigns"],
    "90d",
    "U",
    "≥10 account conv for the CVR",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["campaigns"], () => {
        const t = accountTotals(ctx);
        const cvr = ratio(t.conv, t.clicks);
        const usable = (t.conv ?? 0) >= WASTE.minConvForAccountCvr && cvr != null && cvr > 0;
        return {
          value: usable ? statisticalThresholdFromCvr(cvr) : WASTE.clicksDefault,
          window: m90(ctx),
          computedFrom: ["A.cvr"],
          note: usable
            ? `account CVR ${(cvr! * 100).toFixed(2)}%`
            : `account CVR unusable (${t.conv ?? 0} conv) → default ${WASTE.clicksDefault}`,
        };
      });
    },
  ),
  def(
    "K.duplicate_key",
    "keyword",
    "string",
    "normalised text + match type, for cannibalisation",
    ["keywords"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.keywordId ?? null, ["keywords"], () => {
        const k = keywordOf(ctx, a);
        if (!k) return noEntity("keyword", a?.keywordId);
        // only copies SK04 counts (live campaign, non-negative, same people) duplicate it
        const dupes = duplicateCopiesOf(ctx.model, k);
        return {
          value: k.attrs.duplicateKey,
          rowIds: [k.id],
          note: dupes.length ? `duplicated by ${dupes.join(", ")}` : undefined,
        };
      });
    },
  ),
  def(
    "T.spend",
    "search_term",
    "usd",
    "term spend",
    ["searchTerms"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.searchTermId ?? null, ["searchTerms"], () => {
        const t = termOf(ctx, a);
        if (!t) return noEntity("search term", a?.searchTermId);
        return {
          value: t.windows.m90.cost,
          window: m90(ctx),
          rowIds: [t.id],
          truncated: t.sample.truncated,
        };
      });
    },
  ),
  def(
    "T.clicks",
    "search_term",
    "count",
    "term clicks",
    ["searchTerms"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.searchTermId ?? null, ["searchTerms"], () => {
        const t = termOf(ctx, a);
        if (!t) return noEntity("search term", a?.searchTermId);
        return {
          value: t.windows.m90.clicks,
          window: m90(ctx),
          rowIds: [t.id],
          truncated: t.sample.truncated,
        };
      });
    },
  ),
  def(
    "T.conv",
    "search_term",
    "count",
    "term conversions",
    ["searchTerms"],
    "90d",
    "U",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.searchTermId ?? null, ["searchTerms"], () => {
        const t = termOf(ctx, a);
        if (!t) return noEntity("search term", a?.searchTermId);
        return {
          value: t.windows.m90.conv,
          window: m90(ctx),
          rowIds: [t.id],
          truncated: t.sample.truncated,
        };
      });
    },
  ),
  def(
    "T.value",
    "search_term",
    "usd",
    "term conversion value",
    ["searchTerms"],
    "90d",
    "U",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.searchTermId ?? null, ["searchTerms"], () => {
        const t = termOf(ctx, a);
        if (!t) return noEntity("search term", a?.searchTermId);
        return {
          value: t.windows.m90.value,
          window: m90(ctx),
          rowIds: [t.id],
          truncated: t.sample.truncated,
        };
      });
    },
  ),
  def(
    "T.matched_keyword",
    "search_term",
    "id",
    "which keyword served it (keyword_criterion_id)",
    ["searchTerms", "so_search_terms_daily"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.searchTermId ?? null, ["searchTerms"], () => {
        const t = termOf(ctx, a);
        if (!t) return noEntity("search term", a?.searchTermId);
        return t.attrs.matchedKeywordId
          ? { value: t.attrs.matchedKeywordId, rowIds: [t.id] }
          : nc(
              "not_checkable",
              `keyword_criterion_id not on the search_terms row${t.attrs.textMatchCandidateKeywordId ? `; text hint ${t.attrs.textMatchCandidateKeywordId}` : ""}`,
            );
      });
    },
  ),
  def(
    "T.ad_group_id",
    "search_term",
    "id",
    "which ad group served it",
    ["searchTerms"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.searchTermId ?? null, ["searchTerms"], () => {
        const t = termOf(ctx, a);
        if (!t) return noEntity("search term", a?.searchTermId);
        return t.attrs.adGroupId
          ? { value: t.attrs.adGroupId, rowIds: [t.id] }
          : nc("not_checkable", "ad_group_id null (campaign-grain row)");
      });
    },
  ),
  def(
    "T.population_complete",
    "account",
    "bool",
    "were all terms fetched (count < SEARCH_TERM_FETCH_CAP)",
    ["searchTerms"],
    "90d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["searchTerms"], () => {
        const s = ctx.model.attrs.searchTerms;
        return {
          value: !s.sample,
          window: m90(ctx),
          rowCount: s.rows,
          cap: s.cap ?? undefined,
          truncated: s.sample,
        };
      });
    },
  ),
  def(
    "T.brand_token_match",
    "search_term",
    "bool",
    "term names the whole brand (profile brand terms, whole-name matcher)",
    ["searchTerms", "profile"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.searchTermId ?? null, ["searchTerms"], () => {
        const t = termOf(ctx, a);
        if (!t) return noEntity("search term", a?.searchTermId);
        const match = brandMatcherOfModel(ctx.model);
        if (!match)
          return nc("not_checkable", "no brand terms supplied (profile.brandTerms empty)");
        return { value: match(t.attrs.term), rowIds: [t.id] };
      });
    },
  ),
  def(
    "T.waste_floor",
    "account",
    "usd",
    "THE one money bar for calling any entity wasted: max(A.cpa, scaleMoney(band(A.spend_monthly))); ∞ when currency unknown",
    ["derived", "MONITORING_RULEBOOK.searchTermWaste"],
    "window",
    "U",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["campaigns", "dailyMetrics"], () => {
        const t = accountTotals(ctx);
        const d = ctx.window.days;
        if (!d) return nc("not_checkable", "no daily data was read, so the window has no length");
        if (t.cost == null) return nc("not_checkable", "no spend was read in the window");
        if (!ctx.currency.known)
          return {
            value: Number.POSITIVE_INFINITY,
            window: m90(ctx),
            note: `currency ${ctx.currency.currency} unknown → money floors skipped (∞)`,
          };
        const monthly = t.cost / DAYS_PER_MONTH_DIVISOR;
        const monthlyUsd = monthly / ctx.currency.factor;
        const band = scaleMoney(wasteFloorBand(monthlyUsd, ctx.settings.floors), ctx.currency);
        const cpa = ratio(t.cost, t.conv);
        return {
          value: Math.max(cpa ?? 0, band),
          window: m90(ctx),
          computedFrom: ["A.cpa", "A.spend_monthly"],
          note: `monthly ${monthly.toFixed(2)} → band ${band}; cpa ${cpa == null ? "n/a" : cpa.toFixed(2)}`,
        };
      });
    },
  ),
  def(
    "F.conv_min_for_verdict",
    "account",
    "count",
    "the conversion floor any verdict about an entity's return needs: 10 STRONG / 3 MODERATE; below 3 → insufficient_data",
    ["auditClassifiers"],
    "window",
    "U",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, [], () => ({
        value: {
          strong: ctx.settings.floors.strongConv,
          moderate: ctx.settings.floors.moderateConv,
        },
        table: "auditClassifiers.SIGNIFICANCE_THRESHOLDS",
      }));
    },
  ),
  def(
    "F.days_min_for_window",
    "account",
    "count",
    "daily rows a windowed comparison needs per side",
    ["derived"],
    "window",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, [], () => ({
        value: DAYS_MIN_FOR_WINDOW,
        table: "registry/windows.ts",
      }));
    },
  ),
);

// ================================================================ A.6 ads, assets, extensions, landing pages
add(
  def(
    "D.headline_count",
    "ad",
    "count",
    "headlines on an RSA",
    ["ads"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adId ?? null, ["ads"], () => {
        const d = adOf(ctx, a);
        if (!d) return noEntity("ad", a?.adId);
        return { value: d.attrs.headlineCount, rowIds: [d.id] };
      });
    },
  ),
  def(
    "D.description_count",
    "ad",
    "count",
    "descriptions on an RSA",
    ["ads"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adId ?? null, ["ads"], () => {
        const d = adOf(ctx, a);
        if (!d) return noEntity("ad", a?.adId);
        return { value: d.attrs.descriptionCount, rowIds: [d.id] };
      });
    },
  ),
  def(
    "D.pinned_count",
    "ad",
    "count",
    "headlines/descriptions with a pinned position",
    ["ads"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adId ?? null, ["ads"], () => {
        const d = adOf(ctx, a);
        if (!d) return noEntity("ad", a?.adId);
        return d.attrs.pinnedCount == null
          ? nc("not_checkable", "pin data not stored in ads.headlines")
          : { value: d.attrs.pinnedCount, rowIds: [d.id] };
      });
    },
  ),
  // B3 (rule 247): the floor the inventory states is 100 IMPRESSIONS on the
  // ASSET, and asset_performance has no impressions column at all —
  // it carries the label and nothing else. The ad is the nearest scope the data
  // does measure, and the inequality only runs one way: an asset cannot serve
  // more often than the ad it sits in, so an ad under 100 impressions guarantees
  // every asset in it is under 100 too. That makes the ad a SAFE proxy for
  // holding a claim back, and never a reason to make one.
  def(
    "D.impressions",
    "ad",
    "count",
    "impressions on the ad — the proxy for asset impressions, which are not read",
    ["ads"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adId ?? null, ["ads"], () => {
        const d = adOf(ctx, a);
        if (!d) return noEntity("ad", a?.adId);
        return { value: d.windows.m90.impressions, window: m90(ctx), rowIds: [d.id] };
      });
    },
  ),
  def(
    "D.approval_status",
    "ad",
    "enum",
    "policy approval state",
    ["adPolicyData"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adId ?? null, ["adPolicyData"], () => {
        const d = adOf(ctx, a);
        if (!d) return noEntity("ad", a?.adId);
        return d.attrs.policy?.approvalStatus
          ? { value: d.attrs.policy.approvalStatus, rowIds: [d.id] }
          : nc("not_checkable", "no ad_policy row joins this ad");
      });
    },
  ),
  def(
    "D.policy_topics",
    "ad",
    "enum[]",
    "policy topics",
    ["adPolicyData"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.adId ?? null, ["adPolicyData"], () => {
        const d = adOf(ctx, a);
        if (!d) return noEntity("ad", a?.adId);
        return d.attrs.policy
          ? {
              value: d.attrs.policy.policyTopics.map((t) =>
                String(typeof t === "object" && t ? ((t as any).topic ?? JSON.stringify(t)) : t),
              ),
              rowIds: [d.id],
            }
          : nc("not_checkable", "no ad_policy row joins this ad");
      });
    },
  ),
  def(
    "S.asset_label",
    "asset",
    "enum",
    'Google\'s performance label (NOT_APPLICABLE = no verdict, never "low")',
    ["assetPerformance", "pmaxAssets"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.assetId ?? null, [], () => {
        const s = assetOf(ctx, a);
        if (!s) return noEntity("asset", a?.assetId);
        const l = s.attrs.assetPerformanceLabel ?? s.attrs.performanceLabel;
        return l == null
          ? nc("not_checkable", "no performance label on this asset")
          : {
              value: l,
              window: m90(ctx),
              table: s.attrs.surface === "pmax" ? "pmaxAssets" : "assetPerformance",
              rowIds: [s.id],
              note: l === "NOT_APPLICABLE" ? 'Google has no verdict — not "low"' : undefined,
            };
      });
    },
  ),
  // B3 (rule 246): the optional `campaignId` leg was added so a coverage claim
  // about ONE campaign can cite that campaign's own count instead of the
  // account-wide one. Callers that pass no campaignId are unchanged.
  def(
    "S.ext_rows(type, level)",
    "account",
    "count",
    "attached extension rows by type and level, optionally within one campaign",
    ["adExtensions"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, null, ["adExtensions"], () => {
        const xs = ctx.index.attachedExtensions.filter(
          (e) =>
            (!a?.type || e.attrs.type === a.type) &&
            (!a?.level || e.attrs.level === a.level) &&
            (!a?.campaignId || e.attrs.campaignId === a.campaignId),
        );
        return {
          value: xs.length,
          window: m90(ctx),
          rowCount: ctx.index.attachedExtensions.length,
          note: a?.campaignId
            ? "attached rows of one campaign (orphans of removed campaigns excluded)"
            : "attached rows only (orphans of removed campaigns excluded)",
        };
      });
    },
  ),
  def(
    "S.ext_distinct(type)",
    "account",
    "count",
    "distinct texts of a type across attached rows",
    ["adExtensions"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, null, ["adExtensions"], () => {
        const t = a?.type ?? "CALLOUT";
        const s = new Set(
          ctx.index.attachedExtensions
            .filter((e) => e.attrs.type === t && e.attrs.text)
            .map((e) => e.attrs.text!),
        );
        return {
          value: s.size,
          rowCount: ctx.index.attachedExtensions.filter((e) => e.attrs.type === t).length,
        };
      });
    },
  ),
  // B3 (rule 245): the POLICY verdict on an extension, not its link status.
  // `approval_status` is synced; a null (older audit, or a
  // select variant Google rejected) is `not_checkable` — never "approved by default".
  def(
    "S.ext_approval_status",
    "asset",
    "enum",
    "Google's policy approval for one extension row",
    ["adExtensions"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.extensionId ?? null, ["adExtensions"], () => {
        const e = extensionOf(ctx, a);
        if (!e) return noEntity("extension", a?.extensionId);
        return e.attrs.approvalStatus == null
          ? nc("not_checkable", "ad_extensions carries no approval status column")
          : { value: e.attrs.approvalStatus, rowIds: [e.id] };
      });
    },
  ),
  def(
    "S.ext_impressions(asset)",
    "asset",
    "count",
    "impressions on one extension row",
    ["adExtensions"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.extensionId ?? null, ["adExtensions"], () => {
        const e = extensionOf(ctx, a);
        if (!e) return noEntity("extension", a?.extensionId);
        return { value: e.windows.m90.impressions, window: m90(ctx), rowIds: [e.id] };
      });
    },
  ),
  def(
    "S.ext_served_effective(text, type)",
    "account",
    "bool",
    "did this extension text ever serve anywhere (sum impressions over attached rows > 0)",
    ["adExtensions"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, null, ["adExtensions"], () => {
        if (!a?.text) return nc("no_entity", "pass text= (and type=)");
        const xs = ctx.index.attachedExtensions.filter(
          (e) => e.attrs.text === a.text && (!a.type || e.attrs.type === a.type),
        );
        if (xs.length === 0) return nc("no_entity", `no attached extension with text '${a.text}'`);
        return {
          value: xs.reduce((s, e) => s + (e.windows.m90.impressions ?? 0), 0) > 0,
          window: m90(ctx),
          rowCount: xs.length,
          rowIds: xs.map((e) => e.id),
        };
      });
    },
  ),
  def(
    "S.ext_overridden(row)",
    "asset",
    "bool",
    "a campaign-level OVERRIDE-class row superseded by an ad-group row of the same type (SITELINK never)",
    ["adExtensions"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.extensionId ?? null, ["adExtensions"], () => {
        const e = extensionOf(ctx, a);
        if (!e) return noEntity("extension", a?.extensionId);
        return {
          value: e.attrs.servedStatus === "overridden",
          rowIds: [e.id],
          note: `${e.attrs.overrideClass} · ${e.attrs.servedStatus}`,
        };
      });
    },
  ),
  def(
    "S.promo_percent_off",
    "asset",
    "pct",
    "promotion discount as a percentage — the stored value IS the percent (10 = 10% off, 100 = free shipping; sync ea84d1ec)",
    ["adExtensions"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.extensionId ?? null, ["adExtensions"], () => {
        const e = extensionOf(ctx, a);
        if (!e) return noEntity("extension", a?.extensionId);
        return e.attrs.promoPercentOff == null
          ? nc("not_checkable", "no percentOff in metadata")
          : { value: e.attrs.promoPercentOff, rowIds: [e.id] };
      });
    },
  ),
  def(
    "S.promo_end_date",
    "asset",
    "date",
    "promotion end date",
    ["adExtensions"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.extensionId ?? null, ["adExtensions"], () => {
        const e = extensionOf(ctx, a);
        if (!e) return noEntity("extension", a?.extensionId);
        return e.attrs.promoEndDate
          ? { value: e.attrs.promoEndDate, rowIds: [e.id] }
          : nc("not_checkable", "no endDate in metadata");
      });
    },
  ),
  def(
    "S.sitelink_link_count",
    "campaign",
    "count",
    "sitelinks live on a campaign (campaign + ad-group level, cumulative)",
    ["adExtensions"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["adExtensions"], () => {
        const c = campaignOf(ctx, a);
        if (!c) return noEntity("campaign", a?.campaignId);
        const xs = [
          ...c.children.extensions,
          ...c.children.adGroups.flatMap((g) => g.children.extensions),
        ].filter((e) => e.attrs.type === "SITELINK");
        return { value: xs.length, rowCount: xs.length };
      });
    },
  ),
  def(
    "L.spend",
    "landing_page",
    "usd",
    "page spend",
    ["landingPageViews"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.landingPageId ?? null, ["landingPageViews"], () => {
        const l = landingPageOf(ctx, a);
        if (!l) return noEntity("landing page", a?.landingPageId);
        return { value: l.windows.m90.cost, window: m90(ctx), rowIds: [l.id] };
      });
    },
  ),
  def(
    "L.conv",
    "landing_page",
    "count",
    "page conversions",
    ["landingPageViews"],
    "90d",
    "U",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.landingPageId ?? null, ["landingPageViews"], () => {
        const l = landingPageOf(ctx, a);
        if (!l) return noEntity("landing page", a?.landingPageId);
        return { value: l.windows.m90.conv, window: m90(ctx), rowIds: [l.id] };
      });
    },
  ),
  def(
    "L.value",
    "landing_page",
    "usd",
    "page conversion value",
    ["landingPageViews"],
    "90d",
    "U",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.landingPageId ?? null, ["landingPageViews"], () => {
        const l = landingPageOf(ctx, a);
        if (!l) return noEntity("landing page", a?.landingPageId);
        return { value: l.windows.m90.value, window: m90(ctx), rowIds: [l.id] };
      });
    },
  ),
  def(
    "L.cvr",
    "landing_page",
    "ratio",
    "conversions / clicks",
    ["landingPageViews"],
    "90d",
    "U",
    "100 clicks",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.landingPageId ?? null, ["landingPageViews"], () => {
        const l = landingPageOf(ctx, a);
        if (!l) return noEntity("landing page", a?.landingPageId);
        const f = floorCheck("clicks", FLOORS.ratesClicks, l.windows.m90.clicks);
        if (!f.met) return nc("insufficient_data", `clicks ${f.actual ?? 0} < ${f.required}`, f);
        return { value: l.windows.m90.cvr, window: m90(ctx), rowIds: [l.id], floor: f };
      });
    },
  ),
  def(
    "L.utm_class",
    "landing_page",
    "enum",
    "product_sync (Shopify Google channel — NOT organic) / gclid_only / tagged",
    ["landingPageViews"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.landingPageId ?? null, ["landingPageViews"], () => {
        const l = landingPageOf(ctx, a);
        if (!l) return noEntity("landing page", a?.landingPageId);
        return {
          value: UTM_CLASS_NAMES[l.attrs.utmClass] ?? l.attrs.utmClass,
          rowIds: [l.id],
          note:
            l.attrs.utmClass === "product_sync"
              ? "Shopify Google channel — has no bearing on GCLID tracking (f3)"
              : undefined,
        };
      });
    },
  ),
  // A page can be reached through links tagged differently (a Shopping product_sync link
  // and a plain Search link): its spend through the links of one class, key = L.utm_class value.
  def(
    "L.utm_class_spend(class)",
    "landing_page",
    "usd",
    "page spend through its links whose L.utm_class is `key`",
    ["landingPageViews"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.landingPageId ?? null, ["landingPageViews"], () => {
        const l = landingPageOf(ctx, a);
        if (!l) return noEntity("landing page", a?.landingPageId);
        const want = a?.key ?? a?.type;
        if (want == null || want === "")
          return nc("not_checkable", "no utm class named — pass key=<L.utm_class value>");
        const spend = (Object.entries(l.attrs.utmSpend) as [UtmClass, number][])
          .filter(([cls]) => UTM_CLASS_NAMES[cls] === want)
          .reduce((t, [, v]) => t + v, 0);
        return { value: spend, window: m90(ctx), rowIds: [l.id] };
      });
    },
  ),
  // §A.6, added in Phase 1h fix E: the ACCOUNT-level count of pages in one utm class.
  // `L.utm_class` answers it one page at a time, so "45 of 50 pages carry the
  // product_sync tag" had no number of its own — key = the L.utm_class value.
  def(
    "A.utm_class_page_count(class)",
    "account",
    "count",
    "landing pages with a link whose L.utm_class is `key`, out of every page joined to this audit",
    ["landingPageViews"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, null, ["landingPageViews"], () => {
        const want = a?.key ?? a?.type;
        if (want == null || want === "")
          return nc("not_checkable", "no utm class named — pass key=<L.utm_class value>");
        const pages = ctx.model.children.landingPages;
        if (pages.length === 0)
          return nc("not_checkable", "no landing page joins this audit (population rule)");
        const hit = pages.filter((l) =>
          (Object.keys(l.attrs.utmSpend) as UtmClass[]).some((c) => UTM_CLASS_NAMES[c] === want),
        );
        return {
          value: hit.length,
          rowIds: hit.map((l) => l.id),
          rowCount: pages.length,
          note: `${hit.length} of ${pages.length} pages`,
        };
      });
    },
  ),
  def(
    "L.scheme",
    "landing_page",
    "enum",
    "http vs https",
    ["landingPageViews"],
    "–",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.landingPageId ?? null, ["landingPageViews"], () => {
        const l = landingPageOf(ctx, a);
        if (!l) return noEntity("landing page", a?.landingPageId);
        return { value: l.attrs.scheme, rowIds: [l.id] };
      });
    },
  ),
  def(
    "L.speed_score",
    "landing_page",
    "count",
    "Google page speed score",
    ["landingPageViews"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.landingPageId ?? null, ["landingPageViews"], () => {
        const l = landingPageOf(ctx, a);
        if (!l) return noEntity("landing page", a?.landingPageId);
        return l.attrs.speedScore == null
          ? nc("not_checkable", "speed_score null")
          : { value: l.attrs.speedScore, window: m90(ctx), rowIds: [l.id] };
      });
    },
  ),
  def(
    "L.mobile_friendly_pct",
    "landing_page",
    "pct",
    "mobile-friendly click share",
    ["landingPageViews"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.landingPageId ?? null, ["landingPageViews"], () => {
        const l = landingPageOf(ctx, a);
        if (!l) return noEntity("landing page", a?.landingPageId);
        return l.attrs.mobileFriendlyPct == null
          ? nc("not_checkable", "mobile_friendly_pct null")
          : { value: l.attrs.mobileFriendlyPct, window: m90(ctx), rowIds: [l.id] };
      });
    },
  ),
);

// ================================================================ A.7 PMax and Shopping
const ag = (
  id: string,
  unit: MetricUnit,
  definition: string,
  sources: string[],
  window: string,
  maturity: MaturityRule,
  floor: string,
  fn: (
    ctx: MetricCtx,
    g: NonNullable<ReturnType<typeof assetGroupOf>>,
    a: MetricArgs | undefined,
  ) => Partial | NotComputable,
) =>
  def(id, "asset_group", unit, definition, sources, window, maturity, floor, (ctx, a, self) => {
    return withTables(self, ctx, a?.assetGroupId ?? null, sources, () => {
      const g = assetGroupOf(ctx, a);
      return g ? fn(ctx, g, a) : noEntity("asset group", a?.assetGroupId);
    });
  });
const pr = (
  id: string,
  unit: MetricUnit,
  definition: string,
  window: string,
  maturity: MaturityRule,
  floor: string,
  fn: (ctx: MetricCtx, p: NonNullable<ReturnType<typeof productOf>>) => Partial | NotComputable,
) =>
  def(id, "product", unit, definition, ["products"], window, maturity, floor, (ctx, a, self) => {
    return withTables(self, ctx, a?.productId ?? null, ["products"], () => {
      const p = productOf(ctx, a);
      return p ? fn(ctx, p) : noEntity("product", a?.productId);
    });
  });
add(
  camp(
    "P.channel_cost(network)",
    "usd",
    "PMax spend on one network",
    ["pmaxChannelDistribution"],
    "90d",
    "N/A",
    "–",
    (ctx, c, a) => {
      if (c.children.channels.length === 0)
        return nc("not_checkable", `${c.name}: no channel rows`);
      if (!a?.network)
        return {
          value: Object.fromEntries(
            c.children.channels.map((ch) => [ch.attrs.adNetworkType, ch.windows.m90.cost]),
          ),
          window: m90(ctx),
          rowCount: c.children.channels.length,
        };
      const ch = c.children.channels.find((x) => x.attrs.adNetworkType === a.network);
      return ch
        ? { value: ch.windows.m90.cost, window: m90(ctx), rowIds: [ch.id] }
        : nc("no_entity", `network ${a.network} not present`);
    },
  ),
  camp(
    "P.shopping_share",
    "pct",
    "share of ATTRIBUTABLE cost on Search/Shopping; GMAIL/DISCOVER/MIXED excluded from both sides",
    ["pmaxChannelDistribution"],
    "90d",
    "N/A",
    "attributable ≥ scaleMoney(50)",
    (ctx, c) => {
      const s = c.attrs.channelShares;
      if (!s || s.shopping == null) return nc("not_checkable", `${c.name}: no channel rows`);
      const attributable = c.children.channels
        .filter((ch) => ch.attrs.classification !== "unclassified")
        .reduce((t, ch) => t + (ch.windows.m90.cost ?? 0), 0);
      if (!ctx.currency.known)
        return nc("insufficient_data", "currency unknown — money floor skipped");
      const f = floorCheck(
        "attributable cost",
        scaleMoney(PMAX_SHOPPING_SHARE.minAttributableCost, ctx.currency),
        attributable,
      );
      if (!f.met)
        return nc(
          "insufficient_data",
          `attributable ${attributable.toFixed(2)} < ${f.required}`,
          f,
        );
      return {
        value: s.shopping * 100,
        window: m90(ctx),
        floor: f,
        rowCount: c.children.channels.length,
      };
    },
  ),
  camp(
    "P.unclassified_share",
    "pct",
    "spend the split cannot place (GMAIL, DISCOVER, MIXED)",
    ["pmaxChannelDistribution"],
    "90d",
    "N/A",
    "–",
    (ctx, c) => {
      const s = c.attrs.channelShares;
      if (!s || s.unclassified == null) return nc("not_checkable", `${c.name}: no channel rows`);
      return {
        value: s.unclassified * 100,
        window: m90(ctx),
        rowCount: c.children.channels.length,
      };
    },
  ),
  ag(
    "P.ag_ad_strength",
    "enum",
    "Google's asset-group rating",
    ["assetGroups"],
    "–",
    "N/A",
    "–",
    (_ctx, g) =>
      g.attrs.adStrength
        ? { value: g.attrs.adStrength, rowIds: [g.id] }
        : nc("not_checkable", "ad_strength null"),
  ),
  // B3 (rule 239): asset-quality findings need 100 CLICKS. Asset-group clicks are
  // synced on asset_groups, so this one is measured at the scope the
  // rule names, not proxied.
  ag(
    "P.ag_clicks",
    "count",
    "clicks on the asset group in the window",
    ["assetGroups"],
    "90d",
    "N/A",
    "–",
    (_ctx, g) => ({ value: g.windows.m90.clicks, rowIds: [g.id] }),
  ),
  // D11: a group with zero synced asset rows is UNKNOWN (feed-only or not fetched — the same zero), so a 0 here would be "unknown" printed as "none" — refuse instead.
  ag(
    "P.ag_asset_count(field)",
    "count",
    "assets by field type",
    ["pmaxAssets"],
    "–",
    "N/A",
    "–",
    (_ctx, g, a) =>
      !g.attrs.assetsKnown
        ? nc("not_checkable", assetsUnknownReason())
        : a?.field
          ? {
              value: g.attrs.assetCounts[a.field] ?? 0,
              rowCount: g.children.assets.length,
              note: g.attrs.isFeedOnly ? "feed-only group by design" : undefined,
            }
          : {
              value: g.attrs.assetCounts,
              rowCount: g.children.assets.length,
              note: g.attrs.isFeedOnly ? "feed-only group by design" : undefined,
            },
  ),
  ag(
    "P.ag_gap(field)",
    "count",
    "distance from the PMAX_ASSET_RULEBOOK target (positive = missing)",
    ["pmaxAssets", "pmaxAssetRulebook"],
    "–",
    "N/A",
    "–",
    (_ctx, g, a) => {
      if (!g.attrs.assetsKnown) return nc("not_checkable", assetsUnknownReason());
      const targets: Record<string, number> = {
        HEADLINE: PMAX_ASSETS.maxHeadlines,
        LONG_HEADLINE: PMAX_ASSETS.maxLongHeadlines,
        DESCRIPTION: PMAX_ASSETS.maxDescriptions,
        YOUTUBE_VIDEO: PMAX_ASSETS.minVideos,
        LOGO: PMAX_ASSETS.minSquareLogos,
      };
      const f = a?.field ?? "HEADLINE";
      const t = targets[f];
      if (t == null) return nc("no_entity", `no rulebook target for field ${f}`);
      return { value: t - (g.attrs.assetCounts[f] ?? 0), rowCount: g.children.assets.length };
    },
  ),
  // D11 (B2): the signal readers carry the row-based guard on THEIR table — a group with zero signal rows of either kind is unknown, and a 0 here would be "not fetched" printed as "no signals".
  ag(
    "P.ag_search_themes",
    "count",
    "search themes attached",
    ["pmaxSignals"],
    "–",
    "N/A",
    "–",
    (_ctx, g) =>
      !g.attrs.signalsKnown
        ? nc("not_checkable", signalsUnknownReason())
        : { value: g.children.searchThemes.length, rowCount: g.children.searchThemes.length },
  ),
  ag(
    "P.ag_audience_signals",
    "count",
    "audience signals attached",
    ["pmaxSignals"],
    "–",
    "N/A",
    "–",
    (_ctx, g) =>
      !g.attrs.signalsKnown
        ? nc("not_checkable", signalsUnknownReason())
        : { value: g.children.audienceSignals.length, rowCount: g.children.audienceSignals.length },
  ),
  /**
   * SHAPE METRICS: how spend sits across asset groups, so a Performance Max
   * heavy account is judged where its money is.
   */
  ag("P.ag_spend", "usd", "asset group spend", ["assetGroups"], "90d", "N/A", "–", (ctx, g) => ({
    value: g.windows.m90.cost,
    window: m90(ctx),
    rowIds: [g.id],
  })),
  ag(
    "P.ag_spend_share",
    "pct",
    "asset group's share of its campaign's spend",
    ["assetGroups"],
    "90d",
    "N/A",
    "–",
    (ctx, g) => {
      const c = ctx.model.children.campaigns.find((x) =>
        x.children.assetGroups.some((y) => y.id === g.id),
      );
      const total = c?.windows.m90.cost ?? null;
      if (total == null || total <= 0)
        return nc("not_checkable", "campaign spend is zero or unknown, so a share cannot be taken");
      const own = g.windows.m90.cost;
      if (own == null) return nc("not_checkable", "asset group spend not synced");
      return { value: (own / total) * 100, window: m90(ctx), rowIds: [g.id] };
    },
  ),
  camp(
    "P.ag_paused_share",
    "pct",
    "share of a campaign's asset groups that are paused or removed",
    ["assetGroups"],
    "–",
    "N/A",
    "–",
    (_ctx, c) => {
      const gs = c.children.assetGroups;
      if (gs.length === 0) return nc("not_checkable", `${c.name}: no asset groups synced`);
      const off = gs.filter((g) => String(g.status ?? "").toUpperCase() !== "ENABLED").length;
      return { value: (off / gs.length) * 100, rowCount: gs.length, rowIds: gs.map((g) => g.id) };
    },
  ),
  camp(
    "P.ag_top_spend_share",
    "pct",
    "share of a campaign's spend in its single biggest asset group",
    ["assetGroups"],
    "90d",
    "N/A",
    "–",
    (ctx, c) => {
      const gs = c.children.assetGroups;
      const total = c.windows.m90.cost ?? 0;
      if (gs.length === 0) return nc("not_checkable", `${c.name}: no asset groups synced`);
      if (total <= 0)
        return nc("not_checkable", `${c.name}: campaign spend is zero, so a share cannot be taken`);
      const costs = gs.map((g) => g.windows.m90.cost ?? 0);
      const top = Math.max(...costs);
      return { value: (top / total) * 100, window: m90(ctx), rowCount: gs.length };
    },
  ),
  ag(
    "P.listing_included",
    "count",
    "UNIT_INCLUDED leaves",
    ["pmaxListingGroups"],
    "–",
    "N/A",
    "–",
    (_ctx, g) => ({ value: g.attrs.listingGroupCounts.included }),
  ),
  ag(
    "P.listing_excluded",
    "count",
    "UNIT_EXCLUDED leaves",
    ["pmaxListingGroups"],
    "–",
    "N/A",
    "–",
    (_ctx, g) => ({ value: g.attrs.listingGroupCounts.excluded }),
  ),
  camp(
    "P.brand_theme_click_share",
    "pct",
    "brand share of PMax search categories — SAMPLE, 50 rows per campaign",
    ["pmaxSearchInsights"],
    "90d",
    "N/A",
    "–",
    (ctx, c) => {
      const cs = c.children.searchCategories;
      if (cs.length === 0) return nc("not_checkable", `${c.name}: no pmax_search_insights rows`);
      const all = cs.reduce((s, x) => s + (x.windows.m90.clicks ?? 0), 0);
      const brand = cs
        .filter((x) => x.attrs.brandToken)
        .reduce((s, x) => s + (x.windows.m90.clicks ?? 0), 0);
      return all === 0
        ? nc("not_checkable", "no clicks on the sampled categories")
        : {
            value: (brand / all) * 100,
            window: m90(ctx),
            rowCount: cs.length,
            truncated: cs.some((x) => x.sample.truncated),
            cap: 50,
          };
    },
  ),
  // negatives framework P3 (PX21 / PX22): what the PMax search terms with cost add up to. Google hides part of the
  // searches PMax pays for, so this is a SAMPLE whenever it is under the campaign's spend (or a campaign hit the 2,000-row cap).
  camp(
    "P.search_term_cost",
    "usd",
    "90-day spend of the PMax search terms Google reports (campaign_search_term_view) — SAMPLE when under the campaign spend or capped at 2000 rows",
    ["pmaxSearchTerms"],
    "90d",
    "N/A",
    "–",
    (ctx, c) => {
      const ts = c.children.searchTerms.filter((t) => t.attrs.source === "pmaxSearchTerms");
      if (ts.length === 0) return nc("not_checkable", `${c.name}: no pmax_search_terms rows`);
      const cost = ts.reduce((s, t) => s + (t.windows.m90.cost ?? 0), 0);
      const spend = c.windows.m90.cost ?? 0;
      return {
        value: Math.round(cost * 100) / 100,
        window: m90(ctx),
        rowCount: ts.length,
        truncated: ts.some((t) => t.sample.truncated) || cost < spend,
        cap: 2000,
        note:
          spend > 0
            ? `${Math.round((cost / spend) * 100)}% of the campaign spend shows as search terms`
            : undefined,
      };
    },
  ),
  def(
    "Pl.cost",
    "placement",
    "usd",
    "placement spend — placement_performance ONLY",
    ["placement_performance"],
    "90d",
    "N/A",
    "cost ≥ T.waste_floor",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.placementId ?? null, ["placement_performance"], () => {
        const p = placementOf(ctx, a);
        if (!p) return noEntity("placement", a?.placementId);
        return { value: p.windows.m90.cost, window: m90(ctx), rowIds: [p.id] };
      });
    },
  ),
  def(
    "Pl.conv",
    "placement",
    "count",
    "placement conversions",
    ["placement_performance"],
    "90d",
    "U",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.placementId ?? null, ["placement_performance"], () => {
        const p = placementOf(ctx, a);
        if (!p) return noEntity("placement", a?.placementId);
        return { value: p.windows.m90.conv, window: m90(ctx), rowIds: [p.id] };
      });
    },
  ),
  def(
    "Pl.impressions",
    "placement",
    "count",
    "PMax placement reach (pmax_placements — impressions only)",
    ["pmax_placements"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.placementId ?? null, ["pmax_placements"], () =>
        nc("not_checkable", "pmax_placements is not loaded into the model"),
      );
    },
  ),
  pr("Pr.spend", "usd", "product spend (cost_micros / 1e6)", "90d", "N/A", "–", (ctx, p) => ({
    value: p.windows.m90.cost,
    window: m90(ctx),
    rowIds: [p.id],
    truncated: p.sample.truncated,
  })),
  pr("Pr.conv", "count", "product conversions", "90d", "U", "–", (ctx, p) => ({
    value: p.windows.m90.conv,
    window: m90(ctx),
    rowIds: [p.id],
    truncated: p.sample.truncated,
  })),
  pr("Pr.value", "usd", "product conversion value", "90d", "U", "–", (ctx, p) => ({
    value: p.windows.m90.value,
    window: m90(ctx),
    rowIds: [p.id],
    truncated: p.sample.truncated,
  })),
  pr("Pr.roas", "ratio", "value / cost", "90d", "U", "10 conv", (ctx, p) => {
    const f = floorCheck("conv", strongConv(ctx), p.windows.m90.conv);
    if (!f.met) return nc("insufficient_data", tooFew(f), f);
    return {
      value: p.windows.m90.roas,
      window: m90(ctx),
      rowIds: [p.id],
      floor: f,
      truncated: p.sample.truncated,
    };
  }),
  // SH19 (09-29): counted over the FULL stored catalog (every feed product, 0 metrics when it never had ad data), never the 500-row clicks slice
  def(
    "Pr.catalog_never_served",
    "account",
    "count",
    "feed products inside an UNIT_INCLUDED listing-group leaf with zero impressions, over every stored feed product (products), not the 500-row clicks slice",
    ["products"],
    "30d",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, [], () => {
        const c = ctx.model.attrs.merchantCenter.productCatalog;
        if (c == null)
          return nc(
            "not_checkable",
            "the full product catalog was not loaded for this audit (synced before 09-29, or the read failed)",
          );
        if (c.truncated)
          return nc(
            "not_checkable",
            c.crawl === "missing"
              ? "the product sync left no feed-crawl completeness flag (synced before 09-29) — the stored catalog may be a sample, so no count is stated"
              : `the stored catalog is a sample (feed crawl ${c.crawl === "truncated" ? "hit its cap" : "complete, but the read hit its cap"}, ${c.rows} rows) — a never-served count would be an artefact of the cap`,
          );
        if (c.included === 0)
          return nc(
            "not_checkable",
            "no catalog product resolves into an UNIT_INCLUDED listing-group leaf",
          );
        return { value: c.includedNeverServed, rowCount: c.rows, table: "products" };
      });
    },
  ),
  def(
    "Pr.spend_share_topN",
    "account",
    "pct",
    "concentration of product spend: sum(top N by cost) / sum(all)",
    ["products"],
    "90d",
    "N/A",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, null, ["products"], () => {
        const n = a?.n ?? 10;
        const ps = ctx.model.children.products.filter((p) => p.attrs.primarySource === "products");
        const costs = ps.map((p) => p.windows.m90.cost ?? 0).sort((x, y) => y - x);
        const all = costs.reduce((s, x) => s + x, 0);
        if (all === 0) return nc("not_checkable", "no product spend");
        return {
          value: (costs.slice(0, n).reduce((s, x) => s + x, 0) / all) * 100,
          window: m90(ctx),
          rowCount: ps.length,
          truncated: ps.some((p) => p.sample.truncated),
          note: `top ${n} of ${ps.length} (products slice is a 500-row sample)`,
        };
      });
    },
  ),
  pr(
    "Pr.mc_status",
    "enum",
    'Merchant Center approval (NULL = not in the MC join, not "disapproved")',
    "–",
    "N/A",
    "–",
    (_ctx, p) =>
      p.attrs.mcStatus == null
        ? nc("not_checkable", "not in the Merchant Center join")
        : { value: p.attrs.mcStatus, rowIds: [p.id] },
  ),
  pr(
    "Pr.missing_attrs",
    "enum[]",
    "which of {gtin, color, size} are blank (gtin: and no MPN, identifier_exists not no; color/size: clothing only)",
    "–",
    "N/A",
    "–",
    (_ctx, p) => ({ value: p.attrs.missingAttrs, rowIds: [p.id] }),
  ),
  def(
    "F.feed_valid_rate",
    "account",
    "pct",
    "share of feed items accepted",
    ["feedDiagnostics"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["feedDiagnostics"], () => {
        const f = ctx.model.attrs.merchantCenter.feeds;
        if (f.itemsTotal == null || f.itemsTotal === 0)
          return nc("not_checkable", "feed_diagnostics carries no items_total");
        if (f.itemsInvalid == null)
          return nc(
            "not_checkable",
            "feed_diagnostics items_invalid is null on at least one feed (upload not succeeded or no issues list) — unknown, never 100% valid",
          );
        return {
          value: ((f.itemsTotal - f.itemsInvalid) / f.itemsTotal) * 100,
          rowCount: f.total,
          note: "feed sources can disagree — do not emit as feed health until reconciled",
        };
      });
    },
  ),
  def(
    "F.mc_issue_count",
    "account",
    "count",
    "Merchant Center account issues",
    ["mcAccountIssues"],
    "–",
    "N/A",
    "marker required",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["mcAccountIssues"], () => ({
        value: ctx.model.attrs.merchantCenter.accountIssues,
        rowCount: ctx.model.attrs.merchantCenter.accountIssues,
      }));
    },
  ),
  def(
    "F.promotions_live",
    "account",
    "count",
    "MC promotions LIVE",
    ["mcPromotions"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["mcPromotions"], () => ({
        value: ctx.model.attrs.merchantCenter.promotions.live,
        rowCount: ctx.model.attrs.merchantCenter.promotions.total,
      }));
    },
  ),
  def(
    "F.promotions_expired",
    "account",
    "count",
    "MC promotions EXPIRED",
    ["mcPromotions"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["mcPromotions"], () => ({
        value: ctx.model.attrs.merchantCenter.promotions.expired,
        rowCount: ctx.model.attrs.merchantCenter.promotions.total,
      }));
    },
  ),
  def(
    "F.shipping_services",
    "account",
    "count",
    "MC shipping services",
    ["mcShippingSettings"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["mcShippingSettings"], () =>
        ctx.model.attrs.merchantCenter.shippingServices == null
          ? nc("not_checkable", "no mc_shipping row")
          : { value: ctx.model.attrs.merchantCenter.shippingServices },
      );
    },
  ),
  def(
    "F.return_policies",
    "account",
    "count",
    "MC return policies",
    ["mcReturnPolicies"],
    "–",
    "N/A",
    "–",
    (ctx, _a, self) => {
      return withTables(self, ctx, null, ["mcReturnPolicies"], () => ({
        value: ctx.model.attrs.merchantCenter.returnPolicies,
        rowCount: ctx.model.attrs.merchantCenter.returnPolicies,
      }));
    },
  ),
  camp(
    "Sh.campaign_priority",
    "enum",
    "Shopping campaign priority",
    ["shoppingSettings"],
    "–",
    "N/A",
    "–",
    (_ctx, c) =>
      c.attrs.shoppingSettings.state === "synced"
        ? {
            value:
              c.attrs.shoppingSettings.priority == null
                ? null
                : String(c.attrs.shoppingSettings.priority),
          }
        : nc("not_checkable", `${c.name}: shopping_settings not synced for this campaign (SH17)`),
  ),
  camp(
    "Sh.feed_label",
    "enum",
    "Shopping feed label",
    ["shoppingSettings"],
    "–",
    "N/A",
    "–",
    (_ctx, c) =>
      c.attrs.shoppingSettings.state === "synced"
        ? { value: c.attrs.shoppingSettings.feedLabel }
        : nc("not_checkable", `${c.name}: shopping_settings not synced for this campaign (SH17)`),
  ),
  def(
    "Sh.aov",
    "product",
    "usd",
    "revenue / orders (shopping_cart_data)",
    ["shoppingCartData"],
    "90d",
    "U",
    "10 orders",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.productId ?? null, ["shoppingCartData"], () => {
        const p = productOf(ctx, a);
        if (!p) return noEntity("product", a?.productId);
        if (!p.attrs.cart) return nc("not_checkable", "no shopping_cart_data row for this product");
        const f = floorCheck("orders", FLOORS.cartOrders, p.attrs.cart.orders);
        if (!f.met) return nc("insufficient_data", `orders ${f.actual ?? 0} < ${f.required}`, f);
        const v = ratio(p.attrs.cart.revenue, p.attrs.cart.orders);
        return v == null
          ? nc("not_checkable", "no revenue")
          : { value: v, window: m90(ctx), rowIds: [p.id], floor: f };
      });
    },
  ),
  def(
    "Sh.units_per_order",
    "product",
    "ratio",
    "units_sold / orders",
    ["shoppingCartData"],
    "90d",
    "U",
    "10 orders",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.productId ?? null, ["shoppingCartData"], () => {
        const p = productOf(ctx, a);
        if (!p) return noEntity("product", a?.productId);
        if (!p.attrs.cart) return nc("not_checkable", "no shopping_cart_data row for this product");
        const f = floorCheck("orders", FLOORS.cartOrders, p.attrs.cart.orders);
        if (!f.met) return nc("insufficient_data", `orders ${f.actual ?? 0} < ${f.required}`, f);
        const v = ratio(p.attrs.cart.unitsSold, p.attrs.cart.orders);
        return v == null
          ? nc("not_checkable", "no units")
          : { value: v, window: m90(ctx), rowIds: [p.id], floor: f };
      });
    },
  ),
);

// ================================================================ A.8 slices — both scopes (rule 6)
add(
  def(
    "SL.device(scope)",
    "account+campaign",
    "mixed",
    "per-device {clicks,cost,conv,value,cpa,roas}; scope=account|campaign (campaignId), key=DEVICE",
    ["deviceData"],
    "90d",
    "U",
    "30 clicks",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["deviceData"], () =>
        sliceMetric(ctx, "device", a, DEVICE_SKEW.minSegmentClicks, "deviceData"),
      );
    },
  ),
  // §A.8: the aggregate SL06 judges. A campaign's zero-conversion device slices are
  // ONE exclusion decision, so they are one number; judging a 0-click / $5.45
  // CONNECTED_TV slice alone is what the 30-click floor exists to prevent, and
  // hiding it inside the campaign total is what the floor was never meant to do.
  // No per-slice click floor here on purpose — SL06 applies both floors to the sum.
  def(
    "SL.device_zero_conv(scope)",
    "account+campaign",
    "mixed",
    "device slices with ZERO 90d conversions at this scope, summed: {cost,clicks,device_count}; scope=account|campaign (campaignId)",
    ["deviceData"],
    "90d",
    "U",
    "–",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["deviceData"], () => {
        const fam = sliceFamily(ctx, "device", a);
        if (isNc(fam)) return fam;
        const zero = fam.slices.filter((s) => s.windows.m90.conv === 0);
        if (zero.length === 0)
          return nc(
            "no_entity",
            `every device slice at ${fam.scopeId ? `campaign ${fam.scopeId}` : "account"} scope has at least one conversion`,
          );
        return {
          value: {
            cost: sumOf(zero.map((s) => s.windows.m90.cost)),
            clicks: sumOf(zero.map((s) => s.windows.m90.clicks)),
            device_count: zero.length,
          },
          window: m90(ctx),
          table: "deviceData",
          rowIds: zero.map((s) => s.id),
          truncated: zero.some((s) => s.sample.truncated),
          note: `${zero.map((s) => s.attrs.key).join(", ")}; the floors belong on this sum, not on each slice`,
        };
      });
    },
  ),
  def(
    "SL.device_cpa_multiple(scope, device)",
    "account+campaign",
    "ratio",
    "device CPA / scope 90d CPA; Infinity when the device has 0 conversions",
    ["deviceData"],
    "90d",
    "U",
    "30 clicks",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["deviceData"], () => {
        const fam = sliceFamily(ctx, "device", a);
        if (isNc(fam)) return fam;
        const key = a?.key ?? a?.device;
        const s = fam.slices.find((x) => x.attrs.key === key);
        if (!s) return nc("no_entity", `device '${key}' not present at this scope`);
        const f = floorCheck("clicks", DEVICE_SKEW.minSegmentClicks, s.windows.m90.clicks);
        if (!f.met)
          return nc("insufficient_data", `${key}: ${f.actual ?? 0} clicks < ${f.required}`, f);
        const scopeCpa = fam.scopeMetrics.cpa;
        if (scopeCpa == null) return nc("not_checkable", "scope CPA unavailable");
        if ((s.windows.m90.conv ?? 0) === 0)
          return { value: Number.POSITIVE_INFINITY, window: m90(ctx), floor: f, rowIds: [s.id] };
        return {
          value: (s.windows.m90.cpa ?? 0) / scopeCpa,
          window: m90(ctx),
          floor: f,
          rowIds: [s.id],
          note: `scope CPA ${scopeCpa.toFixed(2)}`,
        };
      });
    },
  ),
  def(
    "SL.geo(scope, country)",
    "account+campaign",
    "mixed",
    "per-country {cost,conv,value,roas}; key=location_id",
    ["geographicData"],
    "90d",
    "U",
    "100 clicks",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["geographicData"], () =>
        sliceMetric(ctx, "geo", a, FLOORS.geoClicks, "geographicData"),
      );
    },
  ),
  camp(
    "SL.geo_negatives",
    "count",
    "excluded locations",
    ["locationCriteria"],
    "–",
    "N/A",
    "–",
    (_ctx, c) => ({
      value: c.attrs.geo.negatives,
      rowCount: c.attrs.geo.targets + c.attrs.geo.negatives,
    }),
  ),
  def(
    "SL.demo(scope, type, value)",
    "account+campaign",
    "mixed",
    "age / gender {cost,conv}; key=TYPE:VALUE",
    ["demographicData"],
    "90d",
    "U",
    "100 clicks",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["demographicData"], () =>
        sliceMetric(ctx, "demographic", a, FLOORS.demoClicks, "demographicData"),
      );
    },
  ),
  def(
    "SL.audience(scope, criterion)",
    "account+campaign",
    "mixed",
    "audience segment {cost,conv,value,roas}; key=criterion_id",
    ["audiencePerformance", "campaignAudiencePerf"],
    "90d",
    "U",
    "100 clicks",
    (ctx, a, self) => {
      // the audience slices are built from the campaign audience rows (buildSlices.ts)
      return withTables(self, ctx, a?.campaignId ?? null, ["campaignAudiencePerf"], () =>
        sliceMetric(ctx, "audience", a, FLOORS.audienceClicks, "campaignAudiencePerf"),
      );
    },
  ),
  def(
    "SL.dow(scope, day)",
    "account+campaign",
    "mixed",
    "day-of-week MARGINAL {cost,conv} — never sum with SL.hour",
    ["temporalData"],
    "90d",
    "U",
    "100 clicks",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["temporalData"], () => {
        const r = sliceMetric(ctx, "dow", a, FLOORS.demoClicks, "temporalData");
        return isNc(r)
          ? r
          : {
              ...r,
              note: `${r.note ? r.note + "; " : ""}marginal of the same spend as SL.hour — never sum the two`,
            };
      });
    },
  ),
  def(
    "SL.hour(scope, hour)",
    "account+campaign",
    "mixed",
    "hour-of-day MARGINAL {cost,conv} — never sum with SL.dow",
    ["temporalData"],
    "90d",
    "U",
    "100 clicks",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["temporalData"], () => {
        const r = sliceMetric(ctx, "hour", a, FLOORS.demoClicks, "temporalData");
        return isNc(r)
          ? r
          : {
              ...r,
              note: `${r.note ? r.note + "; " : ""}marginal of the same spend as SL.dow — never sum the two`,
            };
      });
    },
  ),
  def(
    "SL.dow_hour(scope, day, hour)",
    "account+campaign",
    "mixed",
    "the true crossed cell {cost,conv}",
    ["temporal_grid"],
    "90d",
    "U",
    "cost ≥ T.waste_floor",
    (ctx, a, self) => {
      return withTables(self, ctx, a?.campaignId ?? null, ["temporal_grid"], () =>
        sliceMetric(ctx, "dowHour", a, 0, "temporal_grid"),
      );
    },
  ),
  camp(
    "SL.bid_modifier(scope, criterion)",
    "ratio",
    "the modifier set on a slice; key = slice key (a dowHour key matches the schedule covering it), type = slice dimension",
    ["bidModifiers"],
    "–",
    "N/A",
    "–",
    (_ctx, c, a) => {
      const bms = c.children.bidModifiers;
      if (bms.length === 0) return nc("not_checkable", `${c.name}: no bid_modifiers rows`);
      const resolved = bms.filter((b) => b.attrs.measuredSlice.kind !== "unresolved");
      if (resolved.length === 0)
        return nc(
          "not_checkable",
          "bid_modifiers.interaction_type / modifier_source empty — criterion unresolvable (BB09)",
        );
      const hit = modifierOn(c, a);
      return hit
        ? { value: hit.attrs.modifier, rowIds: [hit.id] }
        : nc("no_entity", `no modifier on slice '${a?.key}'`);
    },
  ),
  // BB09 (09-29): the slice a resolved modifier multiplies, summed over the
  // campaign's slice rows (an ad schedule = every grid cell it covers), next to
  // the campaign's own CPA / ROAS. Floor = the slice family's click floor.
  camp(
    "SL.modifier_vs_slice(scope, criterion)",
    "mixed",
    "the slice a bid modifier multiplies vs its campaign, 90d: {modifier, clicks, cost, conv, value, cpa, roas, campaign_cpa, campaign_roas}; key = modifier slice key, type = slice dimension",
    ["bidModifiers"],
    "90d",
    "U",
    "slice clicks: device 30, geo / audience / schedule 100",
    (ctx, c, a) => {
      const b = modifierOn(c, a);
      if (!b || b.attrs.measuredSlice.kind === "unresolved")
        return nc("no_entity", `${c.name}: no resolved bid modifier on '${a?.key}'`);
      const ms = b.attrs.measuredSlice;
      const fam = c.children.slices[ms.kind];
      if (ms.kind === "dowHour" && fam.length === 0)
        return nc(
          "not_checkable",
          `${c.name}: temporal_grid has no cells for this campaign — the schedule cannot be measured`,
        );
      const keys = new Set(ms.kind === "dowHour" ? (ms.cells ?? []) : [ms.key]);
      const hit = fam.filter((s) => keys.has(s.attrs.key));
      if (hit.length === 0)
        return nc(
          "no_entity",
          `${c.name}: no ${ms.kind} slice rows for '${ms.key}' (no traffic, or the slice is not synced at that level)`,
        );
      const clicks = sumOf(hit.map((s) => s.windows.m90.clicks)) ?? 0;
      const floor =
        ms.kind === "device"
          ? DEVICE_SKEW.minSegmentClicks
          : ms.kind === "geo"
            ? FLOORS.geoClicks
            : ms.kind === "audience"
              ? FLOORS.audienceClicks
              : FLOORS.demoClicks;
      const f = floorCheck("clicks", floor, clicks);
      if (!f.met)
        return nc("insufficient_data", `${c.name} ${ms.kind} '${ms.key}': ${tooFew(f)}`, f);
      const cost = sumOf(hit.map((s) => s.windows.m90.cost)) ?? 0;
      const conv = sumOf(hit.map((s) => s.windows.m90.conv)) ?? 0;
      const value = sumOf(hit.map((s) => s.windows.m90.value));
      return {
        value: {
          modifier: b.attrs.modifier,
          clicks,
          cost,
          conv,
          value,
          cpa: conv > 0 ? cost / conv : null,
          roas: value != null && cost > 0 ? value / cost : null,
          campaign_cpa: c.windows.m90.cpa,
          campaign_roas: c.windows.m90.roas,
        },
        window: m90(ctx),
        rowIds: [b.id, ...hit.map((s) => s.id)],
        rowCount: hit.length,
        floor: f,
      };
    },
  ),
  // A1 / rule 108 — a finding about a PAUSED entity that still spent in the
  // window is allowed, but the recommendation must NAME the status or be
  // dropped. The status is therefore a citable metric, so the writer has a
  // rendered row to quote and V1 cannot reject the word "paused".
  // Resolution order is most specific first: keyword → ad → ad group → campaign.
  def(
    "E.entity_status",
    "campaign",
    "enum",
    "Google serving status of the entity a finding is about (ENABLED / PAUSED / REMOVED); null when the input holds none, which is UNKNOWN and never ENABLED",
    ["campaigns", "adGroups", "keywords", "ads"],
    "\u2013",
    "N/A",
    "\u2013",
    (ctx, a, self) => {
      return withTables(
        self,
        ctx,
        a?.keywordId ?? a?.adId ?? a?.adGroupId ?? a?.campaignId ?? null,
        [],
        () => {
          const hit = (
            [
              ["keywords", keywordOf(ctx, a)],
              ["ads", adOf(ctx, a)],
              ["adGroups", adGroupOf(ctx, a)],
              ["campaigns", campaignOf(ctx, a)],
            ] as const
          ).find(([, n]) => n != null);
          if (!hit)
            return noEntity("entity", a?.keywordId ?? a?.adId ?? a?.adGroupId ?? a?.campaignId);
          const [table, node] = hit;
          const status = statusOf(node!);
          if (status == null)
            return nc(
              "not_checkable",
              `${table} row ${node!.id} carries no status \u2014 unknown, never assumed ENABLED`,
            );
          return {
            value: status,
            table,
            rowIds: [node!.id],
            note: `activity: ${classifyActivity(node!)}`,
          };
        },
      );
    },
  ),
);

// ================================================================ product waste bars
/**
 * (port of the PerfoAds app's productBarOf): C.product_waste_bar / C.product_loss_bar.
 * Reuses C.cpa / A.cpa (their own conversion floor), A.spend_monthly and the band ladder
 * T.waste_floor reads; T.waste_floor itself is untouched. `note` is the plain-English basis
 * the SH04 / PX05 finding shows. Unknown currency = not checkable, detail starting
 * PRODUCT_BAR_CURRENCY_UNKNOWN (never a bar, never "band"): the check says "could not
 * check", never "no waste found". The sales-floor decisions use the raw conversions; the
 * note shows counts rounded DOWN to 1 decimal (9.96 -> 9.9).
 */
type ProductBarBasis = "campaign" | "account" | "band";
export const PRODUCT_BAR_CURRENCY_UNKNOWN = "currency_unknown";
function productBarOf(ctx: MetricCtx, c: CampaignNode, multiple: number): Partial | NotComputable {
  const cur = ctx.currency;
  const min = strongConv(ctx);
  const campaignConv = c.windows.m90.conv ?? 0;
  const floor = floorCheck("conv", min, campaignConv);
  if (!cur.known)
    return nc(
      "not_checkable",
      `${PRODUCT_BAR_CURRENCY_UNKNOWN}: the account currency (${cur.currency}) is unknown, so no money bar can be set`,
    );
  const monthly = evaluate(ctx, "A.spend_monthly");
  if (monthly.reason) return nc("not_checkable", monthly.detail);
  if (!((monthly.value as number) > 0))
    return nc("not_checkable", "no ad spend in the account in the 90 days: no product to judge");
  const band = scaleMoney(
    wasteFloorBand((monthly.value as number) / cur.factor, ctx.settings.floors),
    cur,
  );
  const cpaOf = (v: MetricValue): number | null =>
    v.reason || typeof v.value !== "number" || !(v.value > 0) ? null : v.value;
  const accountConv = accountTotals(ctx).conv ?? 0;
  const campaignCpa = floor.met ? cpaOf(evaluate(ctx, "C.cpa", { campaignId: c.id })) : null;
  const accountCpa =
    campaignCpa == null && accountConv >= min ? cpaOf(evaluate(ctx, "A.cpa")) : null;
  const cpa = campaignCpa ?? accountCpa;
  const basis: ProductBarBasis =
    campaignCpa != null ? "campaign" : accountCpa != null ? "account" : "band";
  const bar = cpa == null ? band : Math.max(multiple * cpa, band);
  const m = (n: number) => formatMoney(n, cur.currency);
  const sales = (n: number) => {
    let shown = Math.floor(n * 10 + 1e-9) / 10;
    if (n < min && shown >= min) shown = min - 0.1; // never "10 sales (under 10)"
    return `${Number(shown.toFixed(1))} ${shown === 1 ? "sale" : "sales"}`;
  };
  const times = multiple === 1 ? "" : `${multiple} x `;
  // a campaign with enough sales whose own cost per sale is not computable (no spend in the
  // 90 days) is never worded "12 sales (under 10)"
  const campaignWhy = floor.met
    ? `this campaign has no cost per sale of its own in 90 days (${sales(campaignConv)}, no spend)`
    : `this campaign has ${sales(campaignConv)} in 90 days (under ${min})`;
  const cpaText =
    basis === "campaign"
      ? `${times}this campaign's 90-day cost per sale (${m(cpa!)})`
      : `${times}the account's 90-day cost per sale (${m(cpa ?? 0)}), because ${campaignWhy}`;
  const note =
    basis === "band"
      ? floor.met
        ? `no cost per sale could be set from the 90 days (${sales(campaignConv)} in this campaign, ${sales(accountConv)} in the account), so the bar is the spend floor: ${m(band)}`
        : `few sales yet (${sales(campaignConv)} in this campaign, ${sales(accountConv)} in the account in 90 days, under ${min}), so the bar is the spend floor: ${m(band)}`
      : multiple * cpa! >= band
        ? `bar ${m(bar)} = ${cpaText}`
        : `bar ${m(bar)} = the spend floor, higher than ${cpaText}`;
  return {
    value: { bar, basis, cpa, multiple, band, campaignConv },
    window: m90(ctx),
    rowIds: [c.id],
    floor,
    computedFrom: [
      basis === "campaign" ? "C.cpa" : basis === "account" ? "A.cpa" : "F.conv_min_for_verdict",
      "A.spend_monthly",
    ],
    note,
  };
}

add(
  camp(
    "C.product_waste_bar",
    "mixed",
    'the 0-sale bar for a product (model + colour) in this campaign: max(2 x cost per sale, the T.waste_floor band); cost per sale = C.cpa at 10+ campaign sales in 90 days, else A.cpa at 10+ account sales, else the band alone (basis "band"); value {bar, basis, cpa, multiple, band, campaignConv}; not_checkable ("currency_unknown: ...") when the currency is unknown',
    ["derived", "campaigns", "dailyMetrics"],
    "90d",
    "U",
    "10 conv (campaign, else account)",
    (ctx, c) => productBarOf(ctx, c, PRODUCT_WASTE.multiple),
  ),
  camp(
    "C.product_loss_bar",
    "mixed",
    "the loss-maker bar (sells, ROAS under 100%) for a product in this campaign: as C.product_waste_bar at 1 x cost per sale",
    ["derived", "campaigns", "dailyMetrics"],
    "90d",
    "U",
    "10 conv (campaign, else account)",
    (ctx, c) => productBarOf(ctx, c, PRODUCT_WASTE.lossMultiple),
  ),
);

// ---------------------------------------------------------------- registry API

/** Ids the task / older docs use that resolve onto a sheet id. */
export const ALIASES: Readonly<Record<string, string>> = {
  "A.cost90": "A.spend",
  "C.util90": "C.budget_util90",
};

const BY_ID = new Map<string, MetricDefinition>();
for (const d of D) {
  if (BY_ID.has(d.id)) throw new Error(`metric registry: duplicate definition for ${d.id}`);
  BY_ID.set(d.id, d);
}

export const METRICS: readonly MetricDefinition[] = D;

/** Resolve a metric id (or an alias) to its definition. */
export function getMetric(id: string): MetricDefinition | undefined {
  return BY_ID.get(ALIASES[id] ?? id);
}

/** Compute one metric. Unknown id → not_implemented. */
export function evaluate(ctx: MetricCtx, id: string, args?: MetricArgs): MetricValue {
  const d = getMetric(id);
  if (!d)
    return {
      id,
      value: null,
      reason: "not_implemented",
      detail: `no metric '${id}' in the registry`,
      unit: "mixed",
      level: "account",
      entityId: null,
    };
  return d.formula(ctx, args);
}

/** Every account-level metric that needs no argument, evaluated once. */
export function evaluateAccountMetrics(ctx: MetricCtx): MetricValue[] {
  return D.filter((d) => d.level === "account" && !/\(|\[/.test(d.id)).map((d) => d.formula(ctx));
}
