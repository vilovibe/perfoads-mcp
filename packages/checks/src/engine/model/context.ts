// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Build context shared by the subtree builders. `read()` / `readDb()` are the
 * ONLY way a builder touches AccountData / the db tables — each call records
 * the key so coverage.ts can prove every non-empty table fed a node.
 */
import type { AccountData, AccountDataArrayKey, AccountProfile } from "../shared/input.js";
import type { BusinessType } from "../shared/businessType.js";
import {
  brandTermsMatcher,
  brandTokensOfTerms,
  foldBrandText,
  isBrandShorthand,
  isCompetitorCampaign,
} from "../shared/campaignClassification.js";
import { normTerm } from "./buildNegatives.js";
import { metricsFromRows, type FieldMap, type NodeMetrics } from "./metrics.js";
import type { WindowSpec } from "./provenance.js";
import {
  baseNode,
  type BaseNode,
  type NodeKind,
  type NotCheckable,
  type SampleInfo,
  type ShareOfParent,
} from "./types.js";
import { maturityOf, windowsFromDaily, type AuditWindow, type NodeWindows } from "./windows.js";

export type { AccountDataArrayKey };

export type Checkable = "ok" | "error" | "skipped" | "unknown";

export interface TableState {
  checkable: Checkable;
  /** marker error_message (for 'error' / 'skipped'), or the reason the state is unknown. */
  message: string | null;
  rowCount: number | null;
  /** 'marker' = sync_table_status row; 'legacy' = one of the 12 audits.*_count columns; 'none'. */
  source: "marker" | "legacy" | "none";
}

/**
 * Row limits the caller's readers applied, keyed by AccountData key or table
 * name (`<key>:per_campaign` for a per-campaign limit). Rows == cap means the
 * table is a SAMPLE. Empty by default: with no cap given, no truncation is
 * inferred from a row count.
 */
export type FetchCaps = Readonly<Record<string, number>>;

/**
 * Several status rows for one table: the worst wins. Any non-ok beats ok, and
 * failed / not_allowed / unrecognised beat skipped; the row count kept is the
 * largest any row reports (so a partial read is never hidden by a smaller one).
 */
export function mergeStatusRows(rows: readonly any[]): Map<string, any> {
  const rank = (r: any) => {
    const c = readerStatusOf(r?.status, r?.error_message).checkable;
    return c === "error" ? 2 : c === "skipped" ? 1 : 0;
  };
  const out = new Map<string, any>();
  for (const r of rows) {
    const name = String(r?.table_name ?? "");
    const prev = out.get(name);
    if (!prev) {
      out.set(name, r);
      continue;
    }
    const worst = rank(r) > rank(prev) ? r : prev;
    const counts = [prev.row_count, r.row_count]
      .map((v) => (v == null || v === "" ? null : Number(v)))
      .filter((v): v is number => v != null && Number.isFinite(v));
    out.set(name, {
      ...worst,
      row_count: counts.length > 0 ? Math.max(...counts) : worst.row_count,
    });
  }
  return out;
}

/** The reader statuses an input may carry. Anything else is treated as a failed read. */
export const READER_STATUSES = ["ok", "failed", "not_allowed", "skipped"] as const;

/**
 * A status row's status, failing closed: only 'ok' is readable. 'skipped'
 * means the reader chose not to read it; 'failed', 'not_allowed' (the access
 * level does not allow the read), the legacy 'error' and every unrecognised
 * string mean the data cannot be trusted, so the table is not readable.
 */
export function readerStatusOf(
  raw: unknown,
  message: unknown,
): { checkable: "ok" | "error" | "skipped"; message: string | null } {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  const msg = message != null && String(message).trim() !== "" ? String(message) : null;
  if (s === "ok") return { checkable: "ok", message: msg };
  if (s === "skipped") return { checkable: "skipped", message: msg ?? "the read was skipped" };
  if (s === "failed" || s === "error")
    return { checkable: "error", message: msg ?? "the read failed" };
  if (s === "not_allowed")
    return { checkable: "error", message: msg ?? "the access level does not allow this read" };
  return { checkable: "error", message: `unrecognised read status '${s}'${msg ? `: ${msg}` : ""}` };
}

/**
 * Merchant Center tables get their marker from `mc_sync_status`
 * (the Merchant Center sync status), NOT from sync_table_status.
 * Key → the `resource` value the MC sync writes. mcPriceInsights and
 * mcCompetitiveVisibility have NO marker: the only price-related resource,
 * 'price_competitiveness', describes an UPDATE onto products.
 */
export const MC_KEY_RESOURCE: Readonly<Record<string, string>> = {
  mcPromotions: "promotions",
  mcReturnPolicies: "return_policies",
  mcAccountIssues: "account_issues",
  mcShippingSettings: "shipping",
};

/** MC sync status → checkable. 'empty' is a real "synced, found none". */
export function mcMarkerStatus(status: string): Checkable {
  if (status === "ok" || status === "empty") return "ok";
  if (status === "skipped") return "skipped";
  // fail closed: anything unrecognised is an unreadable table
  return "error";
}

/** A row the model refused to take at face value because it contradicts a documented Google rule. */
export interface Contradiction {
  table: string;
  rowId: string;
  rule: string;
  observed: string;
}

/** The 12 legacy count columns on audits (build sheet A.0, Y.legacy_count) → AccountData key. These 12 and no others. */
export const LEGACY_COUNT_COLUMNS: Record<string, string> = {
  campaigns_count: "campaigns",
  ad_groups_count: "adGroups",
  ads_count: "ads",
  keywords_count: "keywords",
  search_terms_count: "searchTerms",
  conversion_actions_count: "conversionActions",
  device_data_count: "deviceData",
  geographic_data_count: "geographicData",
  ad_extensions_count: "adExtensions",
  impression_share_count: "impressionShare",
  demographic_data_count: "demographicData",
  temporal_data_count: "temporalData",
};

/**
 * Extra named tables the engine reads by name. An ABSENT key is exactly "not
 * loaded", and the checks that read them then say they could not check; an
 * empty array is "read, zero rows".
 *   - the customer-acquisition goal per campaign + the account default value;
 *   - where Performance Max served (performance_max_placement_view);
 *   - brand lists attached to campaigns (campaign_criterion type BRAND_LIST);
 *   - each campaign's sales split into new / returning customers;
 *   - campaign language criteria, and the languages the product feed is written in;
 *   - account daily totals for the audit window one year earlier;
 *   - the account's placement exclusions;
 *   - each Video campaign's view numbers (views, view rate, cost per view, quartiles);
 *   - each campaign's spend by the country people were in (the user's location, kept apart
 *     from the targeted locations in geographicData).
 */
export const LIFECYCLE_GOALS_TABLE = "campaign_lifecycle_goals";
export const PMAX_PLACEMENTS_TABLE = "pmax_placements";
export const BRAND_LISTS_TABLE = "campaign_brand_lists";
export const CUSTOMER_SPLIT_TABLE = "campaign_customer_split";
export const CAMPAIGN_LANGUAGES_TABLE = "campaign_languages";
export const SHOP_LANGUAGES_TABLE = "shop_languages";
export const PRIOR_YEAR_DAILY_TABLE = "account_daily_prior_year";
export const PLACEMENT_EXCLUSIONS_TABLE = "account_placement_exclusions";
export const VIDEO_METRICS_TABLE = "video_campaign_metrics";
export const GEO_COUNTRIES_TABLE = "geo_countries";
export const NETWORK_SPLIT_TABLE = "campaign_network_split";
export const EXTRA_NAMED_TABLES = [
  LIFECYCLE_GOALS_TABLE,
  PMAX_PLACEMENTS_TABLE,
  BRAND_LISTS_TABLE,
  CUSTOMER_SPLIT_TABLE,
  CAMPAIGN_LANGUAGES_TABLE,
  SHOP_LANGUAGES_TABLE,
  PRIOR_YEAR_DAILY_TABLE,
  PLACEMENT_EXCLUSIONS_TABLE,
  VIDEO_METRICS_TABLE,
  GEO_COUNTRIES_TABLE,
  NETWORK_SPLIT_TABLE,
] as const;

export interface BuildCtx {
  data: AccountData;
  /** * tables read through the pool in prod (snapshot db/). Absent key = never loaded. */
  dbTables: Record<string, any[]>;
  consumed: Set<string>;
  read(key: AccountDataArrayKey): any[];
  /** null = table absent (query failed / not loaded); [] = synced, zero rows. */
  readDb(table: string): any[] | null;
  aw: AuditWindow;
  w90: WindowSpec;
  /** Google campaign ids of the audited campaigns. */
  campaignIds: Set<string>;
  /** campaigns.id (uuid) → campaign_id — the negatives sync marker stores the uuid. */
  campaignUuidToId: Map<string, string>;
  campaignTypeById: Map<string, string>;
  brandTokens: string[];
  /** R4-E: the shared whole-name brand matcher (null = no usable business name). */
  brandMatch: ((text: string) => boolean) | null;
  /** sync_table_status rows by table_name. */
  markers: Map<string, any>;
  /** legacy counts keyed by AccountData key (from the audits row when the caller has it). */
  legacyCounts: Record<string, number | null>;
  contradictions: Contradiction[];
  /** the caller's row limits (see FetchCaps) */
  caps: FetchCaps;
  /** the caller's row limit for a key / table, or null when none was given */
  capOf(key: string): number | null;
  /** the AccountData key is at its row limit → everything built from it is a sample. */
  atCap(key: string): boolean;
  /**
   * How checkable a table is (§8.4 rule 5): marker status → legacy count →
   * unknown. NEVER derived from rows.length. `table` = * name or
   * an AccountData key (resolved through the key→table map by the caller).
   */
  checkable(table: string, key?: string): TableState;
  /**
   * Gate rows on checkability: returns the rows to attach, or null when the
   * table must be reported not-checkable, plus the reason. ok → rows (may be
   * []); error / skipped → null + marker message; unknown + rows → rows with
   * a completeness note; unknown + no rows → null.
   */
  gate(
    table: string,
    rows: any[] | null,
    key?: string,
  ): { rows: any[] | null; note: string | null };
}

export interface CtxOptions {
  /** Row of audits (or just its *_count columns) for the legacy fallback. */
  legacyCounts?: Record<string, unknown> | null | undefined;
  /**
   * A6: the pipeline's own classification, when the caller has already made it
   * (`runPipelineV3.ts` calls `detectBusinessType` at STEP 1 and logs it, so the
   * model must agree with the value the rest of the run was built on). Absent →
   * the model classifies the same data itself. NEVER defaulted to 'ecommerce'.
   */
  businessType?: BusinessType | null | undefined;
  /** the caller's row limits; absent = no truncation inferred */
  caps?: FetchCaps | null | undefined;
}

export function makeCtx(
  data: AccountData,
  dbTables: Record<string, any[]>,
  aw: AuditWindow,
  opts: CtxOptions = {},
): BuildCtx {
  const consumed = new Set<string>();
  const legacyCounts: Record<string, number | null> = {};
  for (const [col, key] of Object.entries(LEGACY_COUNT_COLUMNS)) {
    const v = opts.legacyCounts?.[col];
    const n = v == null || v === "" ? null : Number(v);
    if (n != null && Number.isFinite(n)) legacyCounts[key] = n;
  }
  const ctx: BuildCtx = {
    data,
    dbTables,
    consumed,
    aw,
    w90: aw.windows.m90,
    campaignIds: new Set(),
    campaignUuidToId: new Map(),
    campaignTypeById: new Map(),
    brandTokens: [],
    brandMatch: null,
    markers: new Map(),
    legacyCounts,
    contradictions: [],
    caps: opts.caps ?? {},
    capOf(key) {
      const v = (opts.caps ?? {})[key];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    },
    atCap(key) {
      const cap = this.capOf(key);
      if (!cap) return false;
      const v = (data as any)[key];
      return Array.isArray(v) && v.length >= cap;
    },
    checkable(table, key) {
      const m = this.markers.get(table);
      if (m) {
        const st = readerStatusOf(m.status, m.error_message);
        return {
          checkable: st.checkable,
          message: st.message,
          rowCount: m.row_count == null ? null : Number(m.row_count),
          source: "marker",
        };
      }
      if (key && key in legacyCounts)
        return {
          checkable: "ok",
          message: null,
          rowCount: legacyCounts[key] ?? null,
          source: "legacy",
        };
      return {
        checkable: "unknown",
        message: `no sync marker for ${table} (sync_table_status)`,
        rowCount: null,
        source: "none",
      };
    },
    gate(table, rows, key) {
      if (rows == null) return { rows: null, note: `${table} not loaded` };
      const st = this.checkable(table, key);
      if (st.checkable === "ok") return { rows, note: null };
      if (st.checkable === "error" || st.checkable === "skipped")
        return {
          rows: null,
          note: `${table} ${st.checkable === "skipped" ? "was not read" : "could not be read"}: ${st.message ?? ""}`.trim(),
        };
      if (rows.length > 0)
        return {
          rows,
          note: `${table}: ${rows.length} rows but no status row — completeness unknown`,
        };
      return {
        rows: null,
        note: `${table} was not read (no rows and no status row)`,
      };
    },
    read(key) {
      consumed.add(key);
      const v = (data as any)[key];
      return Array.isArray(v) ? v : [];
    },
    readDb(table) {
      consumed.add(`db:${table}`);
      const v = dbTables[table];
      return Array.isArray(v) ? v : null;
    },
  };
  for (const [name, m] of mergeStatusRows(ctx.readDb("sync_table_status") ?? []))
    ctx.markers.set(name, m);
  return ctx;
}

export function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s === "" ? null : s;
}

export function bool(v: unknown): boolean | null {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (s === "true" || s === "t" || s === "1") return true;
  if (s === "false" || s === "f" || s === "0") return false;
  return null;
}

/** JSON columns arrive parsed (jsonb) or as strings (text) — accept both. */
export function json<T = unknown>(v: unknown): T | null {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v as T;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return null;
}

export function arr(v: unknown): any[] {
  const j = json<any>(v);
  return Array.isArray(j) ? j : [];
}

/** Last path segment of a Google resource name ('customers/1/campaigns/2' → '2'). */
export function resourceId(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const parts = s.split("/");
  return parts[parts.length - 1] || null;
}

export function groupBy<T>(rows: readonly T[], key: (r: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    const a = m.get(k);
    if (a) a.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export interface NodeInit {
  status?: string | null | undefined;
  fields?: FieldMap | undefined;
  idField?: string | undefined;
  /** daily rows for the entity → sub-windows; absent = null sub-windows. */
  daily?: readonly any[] | null | undefined;
  dailyTable?: string | undefined;
  dailyFields?: FieldMap | undefined;
  sample?: Partial<SampleInfo> | undefined;
  notCheckable?: NotCheckable[] | undefined;
  computedFrom?: string[] | undefined;
}

/** Common node skeleton: m90 from `rows`, sub-windows from `daily`, maturity from the windows. */
export function nodeFromRows<K extends NodeKind>(
  ctx: BuildCtx,
  kind: K,
  id: string,
  name: string,
  parentId: string | null,
  rows: readonly any[],
  table: string,
  init: NodeInit = {},
): BaseNode<K> {
  const m90 = metricsFromRows(
    rows,
    ctx.w90,
    table,
    init.fields,
    init.idField ?? "id",
    init.computedFrom,
  );
  const windows: NodeWindows = {
    m90,
    ...windowsFromDaily(
      init.daily ?? null,
      ctx.aw,
      init.dailyTable ?? table,
      init.dailyFields ?? init.fields,
    ),
  };
  // rule 4: a node built from a capped source is a sample, whatever the caller says
  const capped = ctx.atCap(table);
  const sample: Partial<SampleInfo> = { ...(init.sample ?? {}) };
  if (capped) {
    sample.truncated = true;
    const cap = sample.cap ?? ctx.capOf(table) ?? undefined;
    if (cap != null) sample.cap = cap;
  }
  return baseNode(kind, id, name, parentId, windows, maturityOf(windows), {
    status: init.status,
    sample,
    notCheckable: init.notCheckable,
  });
}

/** Node whose m90 is already computed (rollups). */
export function nodeFromMetrics<K extends NodeKind>(
  kind: K,
  id: string,
  name: string,
  parentId: string | null,
  m90: NodeMetrics,
  sub: Omit<NodeWindows, "m90"> = {
    m30: null,
    mPrior30: null,
    m7: null,
    settledWeek: null,
    settledToDate: null,
  },
  init: {
    status?: string | null;
    sample?: Partial<SampleInfo>;
    notCheckable?: NotCheckable[];
  } = {},
): BaseNode<K> {
  const windows: NodeWindows = { m90, ...sub };
  return baseNode(kind, id, name, parentId, windows, maturityOf(windows), init);
}

/** shareOfParent computed at insert time (G.0 rule 2). */
export function setShare(node: BaseNode, parent: NodeMetrics): ShareOfParent {
  const c = node.windows.m90;
  const div = (a: number | null, b: number | null) =>
    a == null || b == null || b === 0 ? null : a / b;
  node.shareOfParent = {
    cost: div(c.cost, parent.cost),
    conv: div(c.conv, parent.conv),
    value: div(c.value, parent.value),
  };
  return node.shareOfParent;
}

/** A truncated child truncates every ancestor (G.0 rule 3). */
export function propagateTruncation(parent: BaseNode, children: readonly BaseNode[]): void {
  if (children.some((c) => c.sample.truncated)) parent.sample.truncated = true;
}

export function nc(checkId: string, reason: string): NotCheckable {
  return { checkId, reason };
}

/** Brand tokens from the caller's brand terms (display and the one-word safety vetoes). */
export function brandTokensFrom(profile: AccountProfile | null | undefined): string[] {
  return brandTokensOfTerms(profile?.brandTerms ?? []);
}

/**
 * Does `text` name the client's brand? The WHOLE-NAME matcher over the
 * caller's brand terms: a multi-word brand needs every significant word, so
 * "acme leather boots" is not a brand search for "Acme Outdoor".
 */
export function brandMatcherFrom(
  profile: AccountProfile | null | undefined,
): ((text: string) => boolean) | null {
  return brandTermsMatcher(profile?.brandTerms ?? []);
}

export function containsBrandName(
  text: string | null,
  match: ((text: string) => boolean) | null,
): boolean {
  return !!text && !!match && match(text);
}

const modelMatchers = new WeakMap<object, ((text: string) => boolean) | null>();

/** The parts of the account model the brand dictionary reads; all optional, so a bare `{ attrs }` still works. */
interface BrandDictionarySource {
  attrs: { profile?: AccountProfile | null; brandTokens?: readonly string[] };
  negativeIndex?: { byList: Map<string, ReadonlyArray<{ text: string }>> };
  children?: {
    negativeLists?: ReadonlyArray<{ attrs: { level: string; listId: string | null } }>;
    campaigns?: ReadonlyArray<{
      name: string;
      attrs: { isBrand?: boolean };
      children: {
        adGroups: ReadonlyArray<{
          children: {
            keywords: ReadonlyArray<{
              attrs: { text: string; isNegative: boolean; status: string | null };
            }>;
          };
        }>;
      };
    }>;
  };
}

/**
 * The account's own brand vocabulary beside the brand terms. Partial brand searches
 * ("acme boots", "acm wdg boots") were counted non-brand in the brand campaign though
 * the account's own shared brand list holds them. Two sources, exact match only (the
 * search, lowercased and trimmed, IS the term; no phrase containment):
 *   - every term of a shared negative list that holds the own brand (a member names the
 *     whole brand); such lists also carry generic blocks ("cheap", "how to", a rival's
 *     name), so a contained phrase would turn "cheap boots" into a brand search;
 *   - the enabled keywords of brand campaigns (never a campaign named for competitors).
 * A term counts only when it carries a brand word or is the brand written short
 * (`isBrandShorthand`): a brand campaign's broad "leather boots" and a brand list's rival
 * name are never the own brand. Pure; exported for testing.
 */
export function brandDictionaryOf(model: BrandDictionarySource): {
  listTerms: string[];
  keywords: string[];
} {
  const byName = brandMatcherFrom(model.attrs.profile);
  const tokens = model.attrs.brandTokens ?? brandTokensFrom(model.attrs.profile);
  if (!byName || tokens.length === 0) return { listTerms: [], keywords: [] };
  const carriesBrand = (t: string): boolean => {
    const words = new Set(foldBrandText(t).split(" "));
    return tokens.some((tok) => words.has(tok)) || isBrandShorthand(t, tokens);
  };
  const listTerms = new Set<string>();
  for (const l of model.children?.negativeLists ?? []) {
    if (l.attrs.level !== "shared_list" || !l.attrs.listId) continue;
    const members = model.negativeIndex?.byList.get(l.attrs.listId) ?? [];
    if (!members.some((m) => byName(m.text))) continue;
    for (const m of members) {
      const t = normTerm(m.text);
      if (t && carriesBrand(t)) listTerms.add(t);
    }
  }
  const keywords = new Set<string>();
  for (const c of model.children?.campaigns ?? []) {
    if (!c.attrs.isBrand || isCompetitorCampaign(c.name)) continue;
    for (const g of c.children.adGroups)
      for (const k of g.children.keywords) {
        if (k.attrs.isNegative || String(k.attrs.status ?? "").toUpperCase() !== "ENABLED")
          continue;
        const t = normTerm(k.attrs.text);
        if (t && carriesBrand(t)) keywords.add(t);
      }
  }
  return { listTerms: [...listTerms], keywords: [...keywords] };
}

/**
 * The model's brand matcher, built once per model: the whole brand name (as
 * `brandMatcherFrom`), OR an exact term of the account's brand dictionary
 * (`brandDictionaryOf`). No brand terms = null, as before.
 */
export function brandMatcherOfModel(
  model: BrandDictionarySource,
): ((text: string) => boolean) | null {
  if (!modelMatchers.has(model)) {
    const byName = brandMatcherFrom(model.attrs.profile);
    if (!byName) modelMatchers.set(model, null);
    else {
      const dict = brandDictionaryOf(model);
      const terms = new Set([...dict.listTerms, ...dict.keywords]);
      modelMatchers.set(
        model,
        terms.size === 0
          ? byName
          : (text: string) => byName(text) || terms.has(normTerm(String(text ?? ""))),
      );
    }
  }
  return modelMatchers.get(model) ?? null;
}
