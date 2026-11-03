// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Metric registry types — build sheet §A (one definition per metric, spec §8.4
 * rule 9) and spec §3.1 (Evidence shape: value + unit + source + maturity).
 *
 * A metric formula never returns 0 for "unknown": every outcome is either a
 * MetricOk (value, provenance, maturity, marker state) or a MetricNotComputable
 * with a named reason. `not_checkable` is the rule-5 outcome (empty table with
 * no sync marker, marker error, or joined population 0 of N); `insufficient_data`
 * is a floor miss; `not_implemented` names the model field that is missing.
 */
import type { AccountData } from "../shared/input.js";
import type { CurrencyScale } from "../shared/currencyScale.js";
import type { CheckSettings } from "../settings.js";
import type { AccountModel } from "../model/nodes/AccountNode.js";
import type { AdGroupNode } from "../model/nodes/AdGroupNode.js";
import type { AdNode } from "../model/nodes/AdNode.js";
import type { AssetGroupNode } from "../model/nodes/AssetGroupNode.js";
import type { AssetNode } from "../model/nodes/AssetNode.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import type { ConversionActionNode } from "../model/nodes/ConversionActionNode.js";
import type { ExtensionNode } from "../model/nodes/ExtensionNode.js";
import type { KeywordNode } from "../model/nodes/KeywordNode.js";
import type { LandingPageNode } from "../model/nodes/LandingPageNode.js";
import type { PlacementNode } from "../model/nodes/PlacementNode.js";
import type { ProductNode } from "../model/nodes/ProductNode.js";
import type { SearchTermNode } from "../model/nodes/SearchTermNode.js";
import type { AuditWindow } from "../model/windows.js";
import type { TablePopulation } from "./population.js";
import type { SyncMarker } from "./syncMarkers.js";

/** §A "level" column. */
export type MetricLevel =
  | "account"
  | "campaign"
  | "ad_group"
  | "keyword"
  | "search_term"
  | "ad"
  | "asset"
  | "landing_page"
  | "asset_group"
  | "placement"
  | "product"
  | "conversion_action"
  | "account+campaign";

/** §A "unit" column. */
export type MetricUnit =
  | "usd"
  | "pct"
  | "ratio"
  | "count"
  | "days"
  | "date"
  | "bool"
  | "enum"
  | "enum-map"
  | "enum[]"
  | "string"
  | "id"
  | "row[]"
  | "mixed";

/** §A "maturity" column: N/A (no conversion number inside), U (unsettled unless the window says otherwise), S (settled by construction). */
export type MaturityRule = "N/A" | "U" | "S";

export type MarkerState = "ok" | "provisional";

export interface MetricWindow {
  label: string;
  start: string | null;
  end: string | null;
  days: number | null;
}

export interface MetricSource {
  /** AccountData key(s) / * table(s) the value was read from. */
  table: string;
  rowCount?: number | undefined;
  rowIds?: string[] | undefined;
  computedFrom?: string[] | undefined;
}

export interface MetricMaturity {
  rule: MaturityRule;
  /** null when the rule is N/A (no conversion number inside). */
  settledStrict: boolean | null;
  settledPractical: boolean | null;
}

export interface MetricFloorCheck {
  metric: string;
  required: number;
  actual: number | null;
  met: boolean;
}

export type MetricScalar = number | string | boolean | null;
export type MetricPayload =
  MetricScalar | string[] | Record<string, number | string | null> | Record<string, unknown>[];

export interface MetricOk {
  id: string;
  value: MetricPayload;
  unit: MetricUnit;
  level: MetricLevel;
  entityId: string | null;
  window: MetricWindow | null;
  source: MetricSource;
  maturity: MetricMaturity;
  /** 'ok' = every source table has a sync marker (status row or legacy count); 'provisional' = rows exist but no marker (§B "provisional: pending markers"). */
  markerState: MarkerState;
  sample: { truncated: boolean; cap?: number; rowsSeen?: number };
  floor?: MetricFloorCheck | undefined;
  note?: string | undefined;
  /** the arguments the metric was evaluated with (B1, 3a review): lets a citation name its leg — `P.ag_asset_count(HEADLINE)` — without changing `id`, which the regression gate matches exactly. */
  args?: MetricArgs | undefined;
  reason?: undefined | undefined;
}

export type NotComputableReason =
  "not_checkable" | "insufficient_data" | "not_implemented" | "no_entity";

/** A stable cause a check may branch on; `detail` is for people and may be reworded. */
export type NotComputableCode = "settled_before_window" | "no_settled_spend_day";

export interface MetricNotComputable {
  id: string;
  value: null;
  reason: NotComputableReason;
  detail: string;
  code?: NotComputableCode | undefined;
  unit: MetricUnit;
  level: MetricLevel;
  entityId: string | null;
  source?: MetricSource | undefined;
  floor?: MetricFloorCheck | undefined;
}

export type MetricValue = MetricOk | MetricNotComputable;

/** Entity / parameter arguments for a metric below account level. */
export interface MetricArgs {
  campaignId?: string | undefined;
  adGroupId?: string | undefined;
  keywordId?: string | undefined;
  searchTermId?: string | undefined;
  adId?: string | undefined;
  assetId?: string | undefined;
  extensionId?: string | undefined;
  assetGroupId?: string | undefined;
  productId?: string | undefined;
  placementId?: string | undefined;
  landingPageId?: string | undefined;
  actionId?: string | undefined;
  /** named window (A.roas_window / C.window). */
  window?: string | undefined;
  scope?: "account" | "campaign" | undefined;
  /** slice key: device name, location id, hour, day, criterion id, demographic type:value. */
  key?: string | undefined;
  device?: string | undefined;
  network?: string | undefined;
  type?: string | undefined;
  level?: string | undefined;
  field?: string | undefined;
  text?: string | undefined;
  date?: string | undefined;
  table?: string | undefined;
  n?: number | undefined;
  metric?: string | undefined;
}

export interface MetricDefinition {
  id: string;
  level: MetricLevel;
  unit: MetricUnit;
  /** §A "definition" column, verbatim where it fits. */
  definition: string;
  /** §A "source" column — AccountData keys / * tables / rulebook modules. */
  sources: string[];
  /** §A "window" column, verbatim ('–' when none). */
  window: string;
  maturityRule: MaturityRule;
  /** §A "floor" column, verbatim ('–' when none). */
  floor: string;
  formula: (ctx: MetricCtx, args?: MetricArgs) => MetricValue;
}

export interface MetricIndex {
  campaignsById: Map<string, CampaignNode>;
  adGroupsById: Map<string, AdGroupNode>;
  keywordsById: Map<string, KeywordNode>;
  searchTermsById: Map<string, SearchTermNode>;
  adsById: Map<string, AdNode>;
  assetsById: Map<string, AssetNode>;
  assetGroupsById: Map<string, AssetGroupNode>;
  extensionsById: Map<string, ExtensionNode>;
  landingPagesById: Map<string, LandingPageNode>;
  placementsById: Map<string, PlacementNode>;
  productsById: Map<string, ProductNode>;
  conversionActionsById: Map<string, ConversionActionNode>;
  /** every attached extension row (account + campaign + ad-group level), orphans excluded. */
  attachedExtensions: ExtensionNode[];
}

export interface MetricCtx {
  model: AccountModel;
  /** the AccountData the model was built from — daily series and a few keyless tables are read here. */
  data: AccountData;
  /** 'YYYY-MM-DD' the audit ran (W.end_is_yesterday); defaults to today UTC. */
  runDate: string;
  currency: CurrencyScale;
  window: AuditWindow;
  /** keyed by BOTH the AccountData key and the * table name. */
  markers: Map<string, SyncMarker>;
  population: Map<string, TablePopulation>;
  index: MetricIndex;
  /** judgement thresholds for this run (settings.ts) */
  settings: CheckSettings;
}
