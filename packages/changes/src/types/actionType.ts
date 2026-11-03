// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { z } from "zod";
import type { MutateResult, OperationResult } from "@perfoads/ads-client";
import type { JsonObject } from "../json.js";
import type {
  AccountFacts,
  AffectedEntity,
  ChangeFacts,
  EngineAds,
  EngineMerchant,
  Target,
} from "../facts.js";

/**
 * The fields a change touches, as plain strings (micros, enum names, ratios), read the
 * same way before, after and when in doubt. Comparing two of these is exact.
 */
export type Touched = Record<string, string>;

/**
 * What a change is read back from. Types 1-3 write one resource (its id). List types
 * (negatives, keywords, assets, ...) keep `id` as a stable label and name the items to
 * read in `scope` (their keys are the touched keys).
 */
export interface ReadTarget {
  resource:
    | "campaign_budget"
    | "campaign"
    | "bidding_strategy"
    | "campaign_criterion"
    | "shared_set"
    | "ad_group_criterion"
    | "ad"
    | "campaign_asset"
    | "merchant_labels";
  id: string;
  /** Type-specific read-back data (plain JSON). */
  scope?: JsonObject;
}

/** Account-wide defaults from the policy (plan 7 `defaults`), enforced by the create types. */
export interface PolicyDefaults {
  /** New keywords are created PAUSED. */
  newEntitiesPaused: boolean;
  /** BROAD keywords only in campaigns with smart bidding. */
  broadMatchRequiresSmartBidding: boolean;
  /** Words that are never negated on this account (policy brand_terms). */
  brandTerms: readonly string[];
}

/** No policy (or none says otherwise): the safe side. */
export const SAFE_DEFAULTS: PolicyDefaults = Object.freeze({
  newEntitiesPaused: true,
  broadMatchRequiresSmartBidding: true,
  brandTerms: Object.freeze([]) as readonly string[],
});

/**
 * How much of a change an undo can put back (declared at propose). full_while_unused =
 * everything, but only while what it made has not run (create_campaign).
 */
export type UndoLevel = "full" | "full_while_unused" | "partial" | "none";

export interface UndoSupport {
  supported: boolean;
  why: string | null;
  /**
   * full = everything back; full_while_unused = everything, only while it has not run;
   * partial = some of it stays (e.g. assets stay in the library); none.
   */
  level?: UndoLevel;
}

export interface ReadCtx {
  ads: EngineAds;
  target: Target;
  account: AccountFacts;
  /** Reads must finish by this time (epoch ms); each read gets the time left as its deadline. */
  deadlineAt?: number | undefined;
  now?: (() => number) | undefined;
  /** Waits (a read that must be repeated a little later); missing = a real timer. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Time a send right after this read still needs (apply's last check); missing = none. */
  sendReserveMs?: number | undefined;
  /** The policy's defaults for this account (SAFE_DEFAULTS when there are none). */
  defaults?: PolicyDefaults | undefined;
  /**
   * This server's own changes that reached Google (or may have) on one campaign, from the
   * store (create_campaign rows left out). Missing = can't tell.
   */
  sentOnCampaign?:
    ((campaignId: string) => { id: string; type: string; status: string }[]) | undefined;
  /** Merchant Center (tag_exclude); missing = this server has no Merchant Center client. */
  merchant?: EngineMerchant | undefined;
  /**
   * Supplemental sources this server made in Merchant Center, by key (kept in the store, so
   * a source the user made is never taken for one of ours). Missing = can't tell.
   */
  ownSources?:
    { get(key: string): string | undefined; set(key: string, name: string): void } | undefined;
  /**
   * This server's changes of one type on this account that may hold what they wrote (sent
   * and not undone; undos left out), from the store. Missing = can't tell.
   */
  heldOfType?:
    | ((
        type: string,
      ) => { id: string; status: string; payload: unknown; before: unknown; expected: Touched }[])
    | undefined;
  /** The change being re-checked or sent (its id); missing = a new proposal. */
  changeId?: string | undefined;
  /** Proposing the undo of this change (its id); missing = not an undo. */
  undoOf?: string | undefined;
}

/** Time left for one read, or undefined when there is no deadline. Throws when none is left. */
export const readDeadlineMs = (ctx: Pick<ReadCtx, "deadlineAt" | "now">): number | undefined => {
  if (ctx.deadlineAt === undefined) return undefined;
  return Math.max(1, ctx.deadlineAt - (ctx.now ?? Date.now)());
};

export interface Planned {
  /** GoogleAdsService.Mutate operations, sent atomically. */
  ops: JsonObject[];
  readTarget: ReadTarget;
  /** Live values right now (the "before"). */
  touched: Touched;
  /** What the touched fields must read once the change landed. */
  expected: Touched;
  /** Human-readable lines, built by the server only (no Google text, no model text). */
  diff: string[];
  affected: AffectedEntity[];
  facts: ChangeFacts;
  warnings: string[];
  undo: UndoSupport;
  /**
   * Item keys for the per-item single writer ("campaigns/333/negatives"), without the
   * customer prefix. Default: the read target + every affected entity.
   */
  targetKeys?: string[];
  /**
   * Independent types only: the touched keys each operation writes (same order as ops),
   * so a partly applied change knows what landed.
   */
  opKeys?: string[][];
}

/** One operation's outcome as Google answered it (resource name of what it made). */
export interface LandedResult {
  index: number;
  ok: boolean;
  resourceName: string | null;
}

/** Text the model wrote that the change sends, shown as-is in the approval view's AI box. */
export interface ModelText {
  label: string;
  items: string[];
}

/**
 * One kind of change. Each module validates its own input (zod), reads live state,
 * builds the operations and the diff, and knows how to read its fields back and undo.
 */
export interface ActionType<I = unknown> {
  readonly type: string;
  readonly summary: string;
  readonly input: z.ZodType<I>;
  /**
   * Looser input check for undo only: an undo may set a value outside today's input
   * bounds, but only when it puts back exactly the stored before value (the engine checks).
   */
  readonly undoInputSchema?: z.ZodType<I>;
  /** Operations are independent, so partial failure may be used. None of types 1-3. */
  readonly independentOps: boolean;
  /**
   * Touched keys name items (not fields of one resource): an undo is matched key by key,
   * and ReadTarget.id / scope may differ (a partly applied change undoes only what landed).
   */
  readonly itemKeys?: boolean;
  /**
   * Reads live state (incl. every campaign the change reaches: shared budgets, portfolio
   * strategies) and builds the change. Throws ChangeError for nothing_to_change,
   * not_allowed, not_found and read_failed.
   */
  plan(ctx: ReadCtx, input: I): Promise<Planned>;
  /** Live touched fields; null when the resource is gone. Used for stale, read-back and in_doubt. */
  readTouched(ctx: ReadCtx, readTarget: ReadTarget): Promise<Touched | null>;
  /** The touched fields as found in a MUTABLE_RESOURCE reply, or null when not in it. */
  fromMutateResults(results: readonly OperationResult[]): Touched | null;
  /**
   * The input that puts the before values back (an undo is a normal change of this type).
   * For a partly applied change, `before` holds only the keys of what landed.
   */
  undoInput(
    payload: I,
    before: Touched,
    readTarget: ReadTarget,
    /** Google's per-operation results of the applied change (null when not recorded). */
    results?: readonly LandedResult[] | null,
    /** When this server applied the change (ISO, UTC; null when not recorded). */
    appliedAt?: string | null,
  ): unknown;
  /**
   * change_event filter (GAQL conditions) for settling an unclear send, or null when the
   * change history does not cover what this type writes (then it stays unclear).
   */
  historyWhere?(customerId: string, readTarget: ReadTarget): string | null;
  /** Model-written text this change sends (headlines, negatives ...), exactly as sent. */
  modelTexts?(payload: I): ModelText[];
  /**
   * Types that write more than Google Ads (Merchant Center): sends the stored operations
   * itself instead of one atomic Google Ads Mutate (validateOnly at propose: only what
   * Google can check). Same errors as the Google Ads client; it must leave nothing changed
   * when it reports a clear failure.
   */
  send?(ctx: ReadCtx, ops: JsonObject[], o: { validateOnly: boolean }): Promise<MutateResult>;
  /**
   * Fields Google shows only after a delay (Merchant Center passes a label on in minutes to
   * hours): when read-back finds just these still at their old value and everything else
   * landed, the change stays applied with `note`, not verify_failed.
   */
  readBackLag?: { keys(key: string): boolean; note: string };
}

/** All of `expected`'s keys read the same in `observed`. */
export const touchedMatch = (observed: Touched | null, expected: Touched): boolean =>
  observed !== null && Object.entries(expected).every(([k, v]) => observed[k] === v);
