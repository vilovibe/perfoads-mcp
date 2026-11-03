// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type {
  MerchantClient,
  MutateResult,
  OperationResult,
  SearchAllResult,
  SearchParams,
  WriteOptions,
} from "@perfoads/ads-client";
import type { JsonObject } from "./json.js";

/** What the engine needs from the Google Ads client (inject a fake in tests). */
export interface EngineAds {
  searchAll(
    p: SearchParams & { maxRows?: number; pageToken?: string; shouldStop?: () => boolean },
  ): Promise<SearchAllResult>;
  mutateAll(mutateOperations: JsonObject[], o: WriteOptions): Promise<MutateResult>;
}

export type { OperationResult };

/**
 * What the engine needs from Merchant Center (tag_exclude only; inject a fake in tests).
 * Missing = the server has no Merchant Center client.
 */
export interface EngineMerchant extends Pick<
  MerchantClient,
  | "listDataSources"
  | "listProducts"
  | "createSupplementalSource"
  | "setCustomLabel"
  | "clearCustomLabel"
> {
  /**
   * Did this sign-in get the Merchant Center permission? true / false = Google said;
   * undefined = not known (then a read tells).
   */
  scopeGranted(): Promise<boolean | undefined>;
}

/** The account a change is for, read live from Google (never from model text). */
export interface AccountFacts {
  customerId: string;
  /** From Google: untrusted text. */
  name: string;
  currencyCode: string;
  timeZone: string | null;
  testAccount: boolean;
  manager: boolean;
}

export interface Target {
  customerId: string;
  loginCustomerId: string | undefined;
}

/** A campaign (or the budget / strategy itself) the change reaches. Names come from Google. */
export interface AffectedEntity {
  kind:
    | "campaign"
    | "campaign_budget"
    | "bidding_strategy"
    | "ad_group"
    | "ad"
    | "shared_set"
    | "user_list";
  id: string;
  /** From Google: untrusted text. */
  name: string | null;
  status: string | null;
}

/**
 * Numbers the policy (P5) judges a change by. Money is micros as decimal strings, in the
 * account's currency.
 */
export interface ChangeFacts {
  budgetChanges?: {
    budgetId: string;
    beforeMicros: string;
    afterMicros: string;
    shared: boolean;
  }[];
  /** Campaigns this change turns on, with the daily budget that starts to spend. */
  newlyEnabled?: { campaignId: string; dailyBudgetMicros: string | null; budgetShared: boolean }[];
  targetChanges?: {
    kind: "target_cpa_micros" | "target_roas";
    before: string | null;
    after: string | null;
    /** abs(after - before) / before * 100, null when there was no target before or after. */
    changePct: number | null;
  }[];
  strategySwitch?: { from: string; to: string } | null;
  affectedCampaignIds: string[];
  /** What the change writes, by item kind (server counts, for the policy and the page). */
  items?: { kind: string; created: number; updated: number; removed: number }[];
  /**
   * A new campaign made PAUSED: the daily budget it can spend once turned on. Not new
   * spend yet; the later update_campaign_status change counts it (newlyEnabled).
   */
  spendWhenEnabled?: { dailyBudgetMicros: string; budgetShared: boolean };
  /**
   * Google's names for ids the change sends (locations, languages), shown next to the ids
   * in the approval's from-Google box. Google text: untrusted.
   */
  googleNames?: { label: string; items: string[] }[];
  /** New keywords created ENABLED (they can spend at once). */
  createdEnabled?: number;
  /** BROAD keywords added to campaigns without smart bidding. */
  broadWithoutSmartBidding?: number;
  /**
   * Negatives that block a search or keyword with conversions, sent anyway because the
   * input set override_blocked_conversions (shown loudly on the approval page). The
   * examples hold model text (the negative) and Google text (what it blocks): untrusted.
   */
  blockedConversions?: {
    count: number;
    /** Searches / keywords blocked in total (all negatives together). */
    blockedTexts?: number;
    /** sha256 of every (negative, blocked text) pair, sorted: the set the person approved. */
    setHash?: string;
    examples: { negative: string; matchType: string; kind: "search" | "keyword"; blocks: string }[];
  };
}
