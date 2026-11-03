// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Metric registry entry point — build sheet §F sitting 1.
 *
 * `buildMetricCtx(...)` turns a Phase 1a AccountModel plus the AccountData it was
 * built from into the explicit context object every formula takes. There is no
 * `this` anywhere in the registry: a formula is a plain function of
 * `(ctx, args, self)` and `self` is bound by `def()` in metrics.ts.
 *
 * Nothing here touches a database or a model. Windows come from the model,
 * markers from syncMarkers.ts (status row → 12 legacy `*_count` columns →
 * unknown), populations from population.ts (model `dataQuality`), money floors
 * from thresholds.ts through the existing `currencyScale`.
 */
import { currencyScale } from "../shared/currencyScale.js";
import type { AccountData } from "../shared/input.js";
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
import { populationReport } from "./population.js";
import { resolveSyncMarkers } from "./syncMarkers.js";
import type { MetricCtx, MetricIndex } from "./types.js";
import { todayIso } from "./windows.js";
import { DEFAULT_SETTINGS, type CheckSettings } from "../settings.js";

export * from "./types.js";
export * from "./thresholds.js";
export * from "./windows.js";
export * from "./syncMarkers.js";
export * from "./population.js";
export * from "./claimKeys.js";
export * from "./entityStatus.js";
export {
  METRICS,
  ALIASES,
  getMetric,
  evaluate,
  evaluateAccountMetrics,
  isEligibleCampaign,
  eligibleCampaigns,
  PURCHASE_CATEGORIES,
} from "./metrics.js";

/** Walk the tree once and index every node a metric can be asked about. */
export function buildMetricIndex(model: AccountModel): MetricIndex {
  const campaignsById = new Map<string, CampaignNode>();
  const adGroupsById = new Map<string, AdGroupNode>();
  const keywordsById = new Map<string, KeywordNode>();
  const searchTermsById = new Map<string, SearchTermNode>();
  const adsById = new Map<string, AdNode>();
  const assetsById = new Map<string, AssetNode>();
  const assetGroupsById = new Map<string, AssetGroupNode>();
  const extensionsById = new Map<string, ExtensionNode>();
  const landingPagesById = new Map<string, LandingPageNode>();
  const placementsById = new Map<string, PlacementNode>();
  const productsById = new Map<string, ProductNode>();
  const conversionActionsById = new Map<string, ConversionActionNode>();
  const attachedExtensions: ExtensionNode[] = [];

  const addExtension = (e: ExtensionNode) => {
    extensionsById.set(e.id, e);
    attachedExtensions.push(e);
  };

  for (const a of model.children.conversionActions) conversionActionsById.set(a.id, a);
  for (const p of model.children.products) productsById.set(p.id.toLowerCase(), p);
  for (const l of model.children.landingPages) landingPagesById.set(l.id, l);
  for (const e of model.children.extensions) addExtension(e);

  for (const c of model.children.campaigns) {
    campaignsById.set(c.id, c);
    for (const e of c.children.extensions) addExtension(e);
    for (const pl of c.children.placements) placementsById.set(pl.id, pl);
    for (const t of c.children.searchTerms) searchTermsById.set(t.id, t);
    for (const p of c.children.products) productsById.set(p.id.toLowerCase(), p);
    for (const g of c.children.assetGroups) {
      assetGroupsById.set(g.id, g);
      for (const s of g.children.assets) assetsById.set(s.id, s);
    }
    for (const ag of c.children.adGroups) {
      adGroupsById.set(ag.id, ag);
      for (const k of ag.children.keywords) keywordsById.set(k.id, k);
      for (const t of ag.children.searchTerms) searchTermsById.set(t.id, t);
      for (const e of ag.children.extensions) addExtension(e);
      for (const ad of ag.children.ads) {
        adsById.set(ad.id, ad);
        for (const s of ad.children.assets) assetsById.set(s.id, s);
        for (const l of ad.children.landingPages) landingPagesById.set(l.id, l);
      }
    }
  }

  return {
    campaignsById,
    adGroupsById,
    keywordsById,
    searchTermsById,
    adsById,
    assetsById,
    assetGroupsById,
    extensionsById,
    landingPagesById,
    placementsById,
    productsById,
    conversionActionsById,
    attachedExtensions,
  };
}

export interface BuildMetricCtxOptions {
  /** raw sync_table_status rows for this audit; absent → the model's own marker read. */
  statusRows?: readonly any[] | null | undefined;
  /** the audits row (or just its 12 `*_count` columns) — AccountData does not carry them. */
  legacyCounts?: Record<string, unknown> | null | undefined;
  /** 'YYYY-MM-DD' the audit ran; defaults to today UTC (W.end_is_yesterday). */
  runDate?: string | undefined;
  /** account currency; defaults to the model's `attrs.currencyCode`. */
  currencyCode?: string | null | undefined;
  /** judgement thresholds; defaults to DEFAULT_SETTINGS. */
  settings?: CheckSettings | undefined;
}

/** The explicit context every metric formula takes. */
export function buildMetricCtx(
  model: AccountModel,
  data: AccountData,
  opts: BuildMetricCtxOptions = {},
): MetricCtx {
  return {
    model,
    data,
    runDate: opts.runDate ?? todayIso(),
    currency: currencyScale(opts.currencyCode ?? model.attrs.currencyCode ?? null),
    window: model.window,
    markers: resolveSyncMarkers({
      model,
      statusRows: opts.statusRows ?? null,
      legacyCounts: opts.legacyCounts ?? null,
    }),
    population: populationReport(model),
    index: buildMetricIndex(model),
    settings: opts.settings ?? DEFAULT_SETTINGS,
  };
}
