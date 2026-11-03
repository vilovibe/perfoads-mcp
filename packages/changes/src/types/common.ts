// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { z } from "zod";
import {
  decimalToMicros,
  microsToDecimalString,
  minimumUnitMicros,
  roundMicrosToCurrency,
} from "@perfoads/ads-client";
import { readFailed } from "../account.js";
import { ChangeError } from "../errors.js";
import type { JsonObject } from "../json.js";
import { readDeadlineMs, type ReadCtx } from "./actionType.js";

/** Google Ads ids: digits only, so they are safe inside GAQL and resource names. */
export const idSchema = z
  .string()
  .regex(/^\d{1,19}$/, "must be a Google Ads id (digits only, as a string)");

const DECIMAL = /^\d{1,15}(\.\d{1,6})?$/;

/** An amount in the account's currency: "12.50" or 12.5. No signs, exponents or more than 6 decimals. */
export const amountSchema = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const text = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v.trim();
  if (!DECIMAL.test(text)) {
    ctx.addIssue({
      code: "custom",
      message: 'must be a plain positive amount in the account\'s currency, e.g. "12.50"',
    });
    return z.NEVER;
  }
  return text;
});

export const assertId = (id: string): string => {
  if (!/^\d{1,19}$/.test(id)) throw new ChangeError("invalid_input", "Not a Google Ads id.");
  return id;
};

/** Amount -> micros, rounded to the currency's smallest billable unit. */
export const amountToMicros = (
  amount: string,
  currencyCode: string,
): { micros: bigint; rounded: boolean } => {
  const exact = decimalToMicros(amount);
  const micros = roundMicrosToCurrency(exact, currencyCode, "nearest");
  return { micros, rounded: micros !== exact };
};

/** 12500000 EUR -> "12.50 EUR"; 120000000 JPY -> "120 JPY". */
export const formatMoney = (micros: string | bigint, currencyCode: string): string => {
  const unit = minimumUnitMicros(currencyCode) ?? 10_000n;
  const digits = unit >= 1_000_000n ? 0 : unit >= 100_000n ? 1 : 2;
  return `${microsToDecimalString(micros, { minFractionDigits: digits })} ${currencyCode}`;
};

export const smallestUnit = (currencyCode: string): string =>
  formatMoney(minimumUnitMicros(currencyCode) ?? 10_000n, currencyCode);

export const pctChange = (before: bigint, after: bigint): number | null =>
  before === 0n ? null : Math.round((Number(after - before) / Number(before)) * 1000) / 10;

export const signedPct = (pct: number | null): string =>
  pct === null ? "" : ` (${pct > 0 ? "+" : ""}${pct}%)`;

/** Runs one GAQL read for the engine (ids in the query were checked by the caller). */
export const gaql = async (
  ctx: ReadCtx,
  query: string,
  what: string,
  maxRows = 1000,
): Promise<JsonObject[]> => {
  try {
    const deadlineMs = readDeadlineMs(ctx);
    const { rows } = await ctx.ads.searchAll({
      ...ctx.target,
      query,
      maxRows,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
    return rows;
  } catch (err) {
    throw readFailed(what, err);
  }
};

export const resourceName = (customerId: string, collection: string, id: string): string =>
  `customers/${customerId}/${collection}/${assertId(id)}`;

/** Id at the end of a resource name, when it belongs to this customer. */
export const ownId = (customerId: string, name: unknown, collection: string): string | null => {
  if (typeof name !== "string") return null;
  const m = new RegExp(`^customers/(\\d{10})/${collection}/(\\d+)$`).exec(name);
  return m && m[1] === customerId && m[2] ? m[2] : null;
};

/**
 * Max campaigns a change may reach. More = refused at propose: an approval must show
 * every campaign it changes (Google answers at most this + 1 rows).
 */
export const AFFECTED_MAX = 1000;

/** Every live campaign on a budget or a portfolio strategy (the change reaches all of them). */
export const campaignsUsing = async (
  ctx: ReadCtx,
  field: "campaign.campaign_budget" | "campaign.bidding_strategy",
  name: string,
): Promise<{ id: string; name: string | null; status: string | null }[]> => {
  if (!/^customers\/\d{10}\/(campaignBudgets|biddingStrategies)\/\d+$/.test(name)) {
    throw new ChangeError("invalid_input", "Not a budget or bidding strategy resource name.");
  }
  const rows = await gaql(
    ctx,
    `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE ${field} = '${name}' AND campaign.status != 'REMOVED' ORDER BY campaign.id LIMIT ${AFFECTED_MAX + 1}`,
    "the campaigns this change reaches",
    AFFECTED_MAX + 1,
  );
  if (rows.length > AFFECTED_MAX) {
    throw new ChangeError(
      "not_allowed",
      `Too many campaigns share this ${field === "campaign.campaign_budget" ? "budget" : "bidding strategy"} to show them all (more than ${AFFECTED_MAX}); change it in Google Ads.`,
    );
  }
  return rows.map((r) => {
    const c = r.campaign as JsonObject | undefined;
    return {
      id: String(c?.id ?? ""),
      name: typeof c?.name === "string" ? c.name : null,
      status: typeof c?.status === "string" ? c.status : null,
    };
  });
};

/** A GAQL string literal: backslashes and single quotes escaped, control characters refused. */
export const gaqlString = (text: string): string => {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new ChangeError("invalid_input", "Text with control characters can't be looked up.");
  }
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
};

/** "(1, 2, 3)" for GAQL IN, every id checked. */
export const idList = (ids: readonly string[]): string => `(${ids.map(assertId).join(", ")})`;

/** Unique, in first-seen order. */
export const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** Campaigns by id (not removed ones refused): name + status + channel + bidding type. */
export const readCampaigns = async (
  ctx: ReadCtx,
  ids: readonly string[],
): Promise<
  Map<
    string,
    {
      id: string;
      name: string | null;
      status: string | null;
      channel: string | null;
      bidding: string | null;
    }
  >
> => {
  const rows = await gaql(
    ctx,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type FROM campaign WHERE campaign.id IN ${idList(ids)}`,
    "the campaigns",
    ids.length + 1,
  );
  const out = new Map<
    string,
    {
      id: string;
      name: string | null;
      status: string | null;
      channel: string | null;
      bidding: string | null;
    }
  >();
  for (const r of rows) {
    const c = r.campaign as JsonObject | undefined;
    const id = String(c?.id ?? "");
    out.set(id, {
      id,
      name: typeof c?.name === "string" ? c.name : null,
      status: typeof c?.status === "string" ? c.status : null,
      channel: typeof c?.advertisingChannelType === "string" ? c.advertisingChannelType : null,
      bidding: typeof c?.biddingStrategyType === "string" ? c.biddingStrategyType : null,
    });
  }
  for (const id of ids) {
    const c = out.get(id);
    if (!c) throw new ChangeError("not_found", `Campaign ${id} was not found in this account.`);
    if (c.status === "REMOVED") {
      throw new ChangeError("not_allowed", `Campaign ${id} is removed; it can't be changed.`);
    }
  }
  return out;
};

/** "1 negative keyword" / "3 negative keywords" */
export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** Every key in `keys` -> "present" when in `found`, else "absent". */
export const presence = (
  keys: readonly string[],
  found: ReadonlySet<string>,
): Record<string, string> =>
  Object.fromEntries(keys.map((k) => [k, found.has(k) ? "present" : "absent"]));

/** The read-back scope's keys (list types). */
export const scopeKeys = (scope: JsonObject | undefined): string[] =>
  Array.isArray(scope?.keys) ? scope.keys.filter((k): k is string => typeof k === "string") : [];

/** A scope list of ids. */
export const scopeIds = (scope: JsonObject | undefined, field: string): string[] => {
  const v = scope?.[field];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(assertId) : [];
};

/** "customers/1/campaignCriteria/2~3": a resource named by two ids. */
export const compositeName = (
  customerId: string,
  collection: string,
  first: string,
  second: string,
): string => `customers/${customerId}/${collection}/${assertId(first)}~${assertId(second)}`;
