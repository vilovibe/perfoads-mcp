// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Account model — a typed tree of every entity in a Google Ads account with
 * its metrics, built purely in code from an already-loaded AccountData
 * (no DB, no AI). Phase 1a of the audit v3 evidence engine.
 *
 * Contract = build sheet §G.0 (type names are binding), joins = §C / spec §8.3.
 * Node types live one per file under ./nodes; this file holds the base
 * contract every node shares.
 *
 * Deviation from §G.0, on purpose (task rule "never 0-for-unknown"): the five
 * counters in NodeMetrics are `number | null`, null when the source table has
 * no such column / no row (e.g. ad_groups carries no conversion_value). A
 * consumer that needs a number must handle null; it may never read 0.
 */
import type { NodeMetrics } from "./metrics.js";
import type { Maturity, NodeWindows } from "./windows.js";

export type { NodeMetrics } from "./metrics.js";
export type { NodeWindows, Maturity } from "./windows.js";
export type { Provenance, WindowSpec, WindowLabel } from "./provenance.js";

export type NodeKind =
  | "account"
  | "conversionAction"
  | "negativeList"
  | "campaign"
  | "budget"
  | "adGroup"
  | "keyword"
  | "searchTerm"
  | "ad"
  | "asset"
  | "extension"
  | "landingPage"
  | "assetGroup"
  | "listingGroup"
  | "product"
  | "productGroup"
  | "placement"
  | "searchCategory"
  | "audienceSignal"
  | "searchTheme"
  | "bidModifier"
  | "channelSlice"
  | "slice"
  | "videoMetrics";

export interface SampleInfo {
  /** A capped fetch may have cut this entity's rows (rule 4): numbers are a sample, never a total. */
  truncated: boolean;
  cap?: number | undefined;
  rowsSeen: number;
  population?: number | undefined;
}

export interface FloorCheck {
  metric: string;
  required: number;
  actual: number;
  met: boolean;
}

export interface NotCheckable {
  checkId: string;
  reason: string;
}

export interface ShareOfParent {
  cost: number | null;
  conv: number | null;
  value: number | null;
}

export interface BaseNode<K extends NodeKind = NodeKind> {
  kind: K;
  /** stable within (audit, kind) */
  id: string;
  name: string;
  parentId: string | null;
  status?: string | undefined;
  windows: NodeWindows;
  maturity: Maturity;
  sample: SampleInfo;
  /** every floor the node was tested against, met or not — empty in Phase 1a (checks are Phase 1b). */
  floors: FloorCheck[];
  /** check ids that FIRED on this node — empty in Phase 1a. */
  flags: string[];
  /** checks that could not run here, with the reason (data gap stated, never inferred). */
  notCheckable: NotCheckable[];
  shareOfParent: ShareOfParent;
  /** back-refs into evidence[] — empty in Phase 1a. */
  evidenceIds: string[];
}

/** Helper for builders: the common fields of a fresh node. */
export function baseNode<K extends NodeKind>(
  kind: K,
  id: string,
  name: string,
  parentId: string | null,
  windows: NodeWindows,
  maturity: Maturity,
  opts: {
    status?: string | null | undefined;
    sample?: Partial<SampleInfo> | undefined;
    shareOfParent?: ShareOfParent | undefined;
    notCheckable?: NotCheckable[] | undefined;
  } = {},
): BaseNode<K> {
  const n: BaseNode<K> = {
    kind,
    id,
    name,
    parentId,
    windows,
    maturity,
    sample: { truncated: false, rowsSeen: windows.m90.provenance.rowCount, ...(opts.sample ?? {}) },
    floors: [],
    flags: [],
    notCheckable: opts.notCheckable ?? [],
    shareOfParent: opts.shareOfParent ?? { cost: null, conv: null, value: null },
    evidenceIds: [],
  };
  if (opts.status != null) n.status = String(opts.status);
  return n;
}

export type { NodeMetrics as Metrics };
