// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// update_bidding: switch a campaign's own bidding strategy, or change its target CPA /
// target ROAS. Ported from PerfoAds executeUpdateBiddingStrategy, buildBiddingStrategySwitch,
// checkBiddingStrategyForChannelType and the rollback descriptor.
//
// Supported:
//  - Campaign with its own strategy: switch between Manual CPC, Maximize clicks (optional
//    max CPC limit), Maximize conversions (optional target CPA) and Maximize conversion
//    value (optional target ROAS); or change / clear the target on the current one.
//    "TARGET_CPA" / "TARGET_ROAS" are Maximize conversions / value WITH a target (Google
//    retired the standalone ones on Search); Standard Shopping keeps standalone Target ROAS.
//  - Campaign on a portfolio (shared) strategy: change the portfolio's target CPA / ROAS.
//    That changes every campaign on the portfolio; all of them are listed.
// A switch INTO value bidding (Maximize conversion value, with or without a target ROAS)
// from a strategy that is not value bidding needs VALUE_BIDDING_MIN_CONV_30D conversions on
// the campaign in the last 30 days: Google refuses it under its own minimum
// (NOT_ENOUGH_CONVERSIONS). A campaign already on value bidding (Target ROAS -> Maximize
// conversion value with no target) is not gated, and neither is an undo.
// Not supported (refused with a reason): moving a campaign onto or off a portfolio,
// creating portfolios, Target impression share, Enhanced CPC, CPM/CPV strategies,
// portfolios owned by a manager account, and campaign types other than Search, Display,
// Shopping, Performance Max and Demand Gen.

import { microsToDecimalString } from "@perfoads/ads-client";
import { z } from "zod";
import { asObject, asString, doubleField, microsField, type JsonObject } from "../json.js";
import { ChangeError } from "../errors.js";
import type { ChangeFacts } from "../facts.js";
import type { ActionType, Planned, ReadCtx, ReadTarget, Touched } from "./actionType.js";
import {
  amountSchema,
  amountToMicros,
  assertId,
  campaignsUsing,
  formatMoney,
  gaql,
  idSchema,
  ownId,
  resourceName,
} from "./common.js";

const STRATEGIES = [
  "MANUAL_CPC",
  "MAXIMIZE_CLICKS",
  "MAXIMIZE_CONVERSIONS",
  "MAXIMIZE_CONVERSION_VALUE",
  "TARGET_CPA",
  "TARGET_ROAS",
] as const;

type Family =
  "MANUAL_CPC" | "MAXIMIZE_CLICKS" | "MAXIMIZE_CONVERSIONS" | "MAXIMIZE_CONVERSION_VALUE";

/** Google's bidding_strategy_type (and our input names) -> the family we compare by. */
const FAMILY: Readonly<Record<string, Family>> = {
  MANUAL_CPC: "MANUAL_CPC",
  TARGET_SPEND: "MAXIMIZE_CLICKS",
  MAXIMIZE_CLICKS: "MAXIMIZE_CLICKS",
  MAXIMIZE_CONVERSIONS: "MAXIMIZE_CONVERSIONS",
  TARGET_CPA: "MAXIMIZE_CONVERSIONS",
  MAXIMIZE_CONVERSION_VALUE: "MAXIMIZE_CONVERSION_VALUE",
  TARGET_ROAS: "MAXIMIZE_CONVERSION_VALUE",
};

const WORDS: Readonly<Record<string, string>> = {
  MANUAL_CPC: "Manual CPC",
  MAXIMIZE_CLICKS: "Maximize clicks",
  MAXIMIZE_CONVERSIONS: "Maximize conversions",
  MAXIMIZE_CONVERSION_VALUE: "Maximize conversion value",
  TARGET_CPA: "Target CPA",
  TARGET_ROAS: "Target ROAS",
};
const words = (t: string): string => WORDS[t] ?? t;

/**
 * Conversions in the last 30 days a campaign needs before it may switch to value bidding
 * (Maximize conversion value, with or without a target ROAS). Google refuses the switch
 * with too few recent conversions (biddingError NOT_ENOUGH_CONVERSIONS, "Customer does not
 * have enough conversions to enable this feature"); its guidance runs from about 15
 * (Search / Shopping) to 30-50 (Demand Gen), so this is the conservative rung. The same
 * number as @perfoads/checks DEFAULT_SETTINGS.bidding.targetRoasMinConv30d, which BB14
 * gates its advice on (a mcp-server test keeps them equal).
 */
export const VALUE_BIDDING_MIN_CONV_30D = 30;

/** Strategies that bid on conversion value (Google's types and our input names). */
const VALUE_BIDDING: ReadonlySet<string> = new Set(["MAXIMIZE_CONVERSION_VALUE", "TARGET_ROAS"]);

/**
 * True for a switch INTO value bidding from a strategy that is not value bidding: only that
 * switch needs VALUE_BIDDING_MIN_CONV_30D. A campaign already bidding on value (Target ROAS
 * -> Maximize conversion value with no target, or a target change) is not gated. An unknown
 * current strategy counts as not value bidding (gated). Same rule as the PerfoAds app
 * (switchesIntoValueBidding).
 */
export const switchesIntoValueBidding = (to: unknown, from: unknown): boolean => {
  const up = (v: unknown): string => (typeof v === "string" ? v.toUpperCase() : "");
  return VALUE_BIDDING.has(up(to)) && !VALUE_BIDDING.has(up(from));
};

/** The campaign's conversions in the last 30 days (Google's LAST_30_DAYS, account time zone). */
const readConversions30d = async (ctx: ReadCtx, id: string): Promise<number> => {
  const rows = await gaql(
    ctx,
    `SELECT campaign.id, metrics.conversions FROM campaign WHERE campaign.id = ${assertId(id)} AND segments.date DURING LAST_30_DAYS`,
    "the campaign's conversions in the last 30 days",
  );
  let total = 0;
  for (const r of rows) {
    const n = Number(asObject(r.metrics).conversions ?? 0);
    if (!Number.isFinite(n)) {
      throw new ChangeError("read_failed", `Couldn't read campaign ${id}'s conversions.`);
    }
    total += n;
  }
  return total;
};

const CHANNELS = new Set(["SEARCH", "DISPLAY", "SHOPPING", "PERFORMANCE_MAX", "DEMAND_GEN"]);

const K = {
  strategy: "bidding.strategy",
  portfolio: "bidding.portfolio",
  cpa: "bidding.target_cpa_micros",
  roas: "bidding.target_roas",
  cap: "bidding.max_cpc_limit_micros",
  ecpc: "bidding.enhanced_cpc",
  pType: "portfolio.type",
  pCpa: "portfolio.target_cpa_micros",
  pRoas: "portfolio.target_roas",
} as const;

const biddingInput = (roas: z.ZodNumber) =>
  z
    .object({
      campaign_id: idSchema,
      strategy: z.enum(STRATEGIES).optional(),
      /** Target CPA in the account's currency. */
      target_cpa: amountSchema.optional(),
      /** Target ROAS as a percent: 250 means 250% (2.5 in Google's ratio). */
      target_roas_percent: roas.optional(),
      /** Remove the optional target of Maximize conversions / conversion value. */
      clear_target: z.literal(true).optional(),
      /** Maximize clicks only: the highest price per click, in the account's currency. */
      max_cpc_limit: amountSchema.optional(),
      /** Maximize clicks only: remove the max CPC limit. */
      clear_max_cpc_limit: z.literal(true).optional(),
    })
    .strict()
    .refine((v) => !(v.max_cpc_limit !== undefined && v.clear_max_cpc_limit), {
      message: "give max_cpc_limit or clear_max_cpc_limit, not both",
    })
    .refine((v) => !(v.target_cpa !== undefined && v.target_roas_percent !== undefined), {
      message: "give target_cpa or target_roas_percent, not both",
    })
    .refine(
      (v) =>
        !(v.clear_target && (v.target_cpa !== undefined || v.target_roas_percent !== undefined)),
      {
        message: "clear_target can't be combined with a new target",
      },
    )
    .refine(
      (v) =>
        v.strategy !== undefined ||
        v.target_cpa !== undefined ||
        v.target_roas_percent !== undefined ||
        v.clear_target !== undefined ||
        v.max_cpc_limit !== undefined ||
        v.clear_max_cpc_limit !== undefined,
      {
        message:
          "nothing asked: give a strategy, a target, clear_target, max_cpc_limit or clear_max_cpc_limit",
      },
    );

export const updateBiddingInput = biddingInput(z.number().min(1).max(10_000));
/** Undo only: any positive tROAS (an old target may sit outside today's 1% .. 10,000%). */
const updateBiddingUndoInput = biddingInput(z.number().positive().max(1_000_000));

export type UpdateBiddingInput = z.infer<typeof updateBiddingInput>;

/** Touched fields of a campaign object (GAQL row or MUTABLE_RESOURCE reply). */
const campaignTouched = (c: JsonObject): Touched | null => {
  const raw = asString(c.biddingStrategyType);
  const cpa = microsField(asObject(c.maximizeConversions).targetCpaMicros);
  const legacyCpa = microsField(asObject(c.targetCpa).targetCpaMicros);
  const roas = doubleField(asObject(c.maximizeConversionValue).targetRoas);
  const legacyRoas = doubleField(asObject(c.targetRoas).targetRoas);
  const cap = microsField(asObject(c.targetSpend).cpcBidCeilingMicros);
  if (
    !raw ||
    cpa === null ||
    legacyCpa === null ||
    roas === null ||
    legacyRoas === null ||
    cap === null
  ) {
    return null;
  }
  return {
    [K.strategy]: FAMILY[raw] ?? raw,
    [K.portfolio]: asString(c.biddingStrategy) ?? "",
    [K.cpa]: cpa !== "0" ? cpa : legacyCpa,
    [K.roas]: roas !== "0" ? roas : legacyRoas,
    [K.cap]: cap,
    [K.ecpc]: asObject(c.manualCpc).enhancedCpcEnabled === true ? "true" : "false",
  };
};

const portfolioTouched = (b: JsonObject): Touched | null => {
  const type = asString(b.type);
  const cpa = microsField(asObject(b.targetCpa).targetCpaMicros);
  const mcCpa = microsField(asObject(b.maximizeConversions).targetCpaMicros);
  const roas = doubleField(asObject(b.targetRoas).targetRoas);
  const mcvRoas = doubleField(asObject(b.maximizeConversionValue).targetRoas);
  if (!type || cpa === null || mcCpa === null || roas === null || mcvRoas === null) return null;
  return {
    [K.pType]: type,
    [K.pCpa]: cpa !== "0" ? cpa : mcCpa,
    [K.pRoas]: roas !== "0" ? roas : mcvRoas,
  };
};

const CAMPAIGN_FIELDS =
  "campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas, campaign.target_spend.cpc_bid_ceiling_micros, campaign.manual_cpc.enhanced_cpc_enabled";

const PORTFOLIO_FIELDS =
  "bidding_strategy.id, bidding_strategy.name, bidding_strategy.type, bidding_strategy.status, bidding_strategy.target_cpa.target_cpa_micros, bidding_strategy.target_roas.target_roas, bidding_strategy.maximize_conversions.target_cpa_micros, bidding_strategy.maximize_conversion_value.target_roas";

const readCampaign = async (ctx: ReadCtx, id: string) => {
  const rows = await gaql(
    ctx,
    `SELECT ${CAMPAIGN_FIELDS} FROM campaign WHERE campaign.id = ${assertId(id)} LIMIT 1`,
    "the campaign",
  );
  return rows[0] ? asObject(rows[0].campaign) : null;
};

const readPortfolio = async (ctx: ReadCtx, id: string) => {
  const rows = await gaql(
    ctx,
    `SELECT ${PORTFOLIO_FIELDS} FROM bidding_strategy WHERE bidding_strategy.id = ${assertId(id)} LIMIT 1`,
    "the shared bidding strategy",
  );
  return rows[0] ? asObject(rows[0].biddingStrategy) : null;
};

const ratioOfPercent = (pct: number): string => {
  const ratio = doubleField(Math.round(pct * 10_000) / 1_000_000) ?? "0";
  if (Number(ratio) <= 0) {
    throw new ChangeError("invalid_input", "target_roas_percent must be at least 1 (meaning 1%).");
  }
  return ratio;
};
const percentOfRatio = (ratio: string): string => `${Math.round(Number(ratio) * 10_000) / 100}%`;

const pct = (before: string, after: string): number | null => {
  const b = Number(before);
  const a = Number(after);
  return b > 0 && a > 0 ? Math.round((Math.abs(a - b) / b) * 1000) / 10 : null;
};

const LEARNING_SWITCH =
  "Switching the bidding strategy restarts Smart Bidding's learning: results can swing for 1-2 weeks.";
const LEARNING_TARGET =
  "Changing the target makes Smart Bidding re-learn; big steps (over about 20%) can swing results for a week or two.";

const money = (ctx: ReadCtx, amount: string, what: string): bigint => {
  try {
    const { micros } = amountToMicros(amount, ctx.account.currencyCode);
    if (micros <= 0n) throw new Error("zero");
    return micros;
  } catch {
    throw new ChangeError("invalid_input", `${what} can't be used in ${ctx.account.currencyCode}.`);
  }
};

const cpaText = (ctx: ReadCtx, micros: string): string =>
  micros === "0" ? "no target" : formatMoney(micros, ctx.account.currencyCode);
const roasText = (ratio: string): string => (ratio === "0" ? "no target" : percentOfRatio(ratio));

const planPortfolio = async (
  ctx: ReadCtx,
  input: UpdateBiddingInput,
  campaign: JsonObject,
  portfolioId: string,
): Promise<Planned> => {
  const { customerId } = ctx.target;
  if (input.max_cpc_limit !== undefined || input.clear_max_cpc_limit) {
    throw new ChangeError(
      "not_allowed",
      "A max CPC limit on a shared bidding strategy can't be changed here.",
    );
  }
  const b = await readPortfolio(ctx, portfolioId);
  const touched = b ? portfolioTouched(b) : null;
  if (!b || !touched) {
    throw new ChangeError("read_failed", `Couldn't read shared bidding strategy ${portfolioId}.`);
  }
  const type = touched[K.pType] ?? "";
  if (input.strategy !== undefined && FAMILY[input.strategy] !== FAMILY[type]) {
    throw new ChangeError(
      "not_allowed",
      `Campaign ${String(campaign.id)} uses shared bidding strategy ${portfolioId} (${words(type)}). Moving it off the shared strategy can't be done here; only the shared strategy's target can be changed.`,
    );
  }
  const isCpa = type === "TARGET_CPA" || type === "MAXIMIZE_CONVERSIONS";
  const isRoas = type === "TARGET_ROAS" || type === "MAXIMIZE_CONVERSION_VALUE";
  if (!isCpa && !isRoas) {
    throw new ChangeError(
      "not_allowed",
      `Shared bidding strategy ${portfolioId} is ${words(type)}; its settings can't be changed here.`,
    );
  }
  if (input.clear_target && (type === "TARGET_CPA" || type === "TARGET_ROAS")) {
    throw new ChangeError("not_allowed", `${words(type)} needs a target; it can't be cleared.`);
  }
  if (
    (isCpa && input.target_roas_percent !== undefined) ||
    (isRoas && input.target_cpa !== undefined)
  ) {
    throw new ChangeError(
      "invalid_input",
      `Shared bidding strategy ${portfolioId} is ${words(type)}: give ${isCpa ? "target_cpa" : "target_roas_percent"}.`,
    );
  }
  let key: string;
  let after: string;
  let scheme: string;
  let field: string;
  if (isCpa) {
    if (input.target_cpa === undefined && !input.clear_target) {
      throw new ChangeError(
        "invalid_input",
        `Give target_cpa for shared bidding strategy ${portfolioId}.`,
      );
    }
    key = K.pCpa;
    after = input.clear_target
      ? "0"
      : money(ctx, input.target_cpa ?? "", "The target CPA").toString();
    scheme = type === "TARGET_CPA" ? "targetCpa" : "maximizeConversions";
    field = "targetCpaMicros";
  } else {
    if (input.target_roas_percent === undefined && !input.clear_target) {
      throw new ChangeError(
        "invalid_input",
        `Give target_roas_percent for shared bidding strategy ${portfolioId}.`,
      );
    }
    key = K.pRoas;
    after = input.clear_target ? "0" : ratioOfPercent(input.target_roas_percent ?? 0);
    scheme = type === "TARGET_ROAS" ? "targetRoas" : "maximizeConversionValue";
    field = "targetRoas";
  }
  const before = touched[key] ?? "0";
  if (before === after) {
    throw new ChangeError(
      "nothing_to_change",
      `Nothing to change: shared bidding strategy ${portfolioId} already has that target.`,
    );
  }
  const rn = resourceName(customerId, "biddingStrategies", portfolioId);
  const campaigns = await campaignsUsing(ctx, "campaign.bidding_strategy", rn);
  const show = isCpa ? (v: string) => cpaText(ctx, v) : roasText;
  const p = pct(before, after);
  const value = isCpa ? after : Number(after);
  const snake = scheme.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const snakeField = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return {
    ops: [
      {
        biddingStrategyOperation: {
          update: { resourceName: rn, [scheme]: { [field]: value } },
          updateMask: `${snake}.${snakeField}`,
        },
      },
    ],
    readTarget: { resource: "bidding_strategy", id: portfolioId },
    touched,
    expected: { [K.pType]: type, [key]: after },
    diff: [
      `Shared bidding strategy ${portfolioId} (${words(type)}): target ${show(before)} -> ${show(after)}${p === null ? "" : ` (${p}% change)`}.`,
      `It is used by ${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}; all of them change.`,
    ],
    affected: [
      {
        kind: "bidding_strategy",
        id: portfolioId,
        name: asString(b.name) ?? null,
        status: asString(b.status) ?? null,
      },
      ...campaigns.map((c) => ({ kind: "campaign" as const, ...c })),
    ],
    facts: {
      targetChanges: [
        {
          kind: isCpa ? "target_cpa_micros" : "target_roas",
          before: before === "0" ? null : before,
          after: after === "0" ? null : after,
          changePct: p,
        },
      ],
      strategySwitch: null,
      affectedCampaignIds: campaigns.map((c) => c.id),
    },
    warnings: [LEARNING_TARGET],
    undo: { supported: true, why: null },
  };
};

const planOwn = (
  ctx: ReadCtx,
  input: UpdateBiddingInput,
  c: JsonObject,
  touched: Touched,
): Planned => {
  const id = input.campaign_id;
  const channel = asString(c.advertisingChannelType) ?? "";
  if (!CHANNELS.has(channel)) {
    throw new ChangeError(
      "not_allowed",
      `Bidding for ${channel || "this"} campaigns can't be changed here.`,
    );
  }
  const currentRaw = asString(c.biddingStrategyType) ?? "";
  const current = touched[K.strategy] ?? "";
  const supportedNow = Object.values(FAMILY).includes(current as Family);
  if (input.strategy === undefined && !supportedNow) {
    throw new ChangeError(
      "not_allowed",
      `Campaign ${id} uses ${words(currentRaw)}; give a strategy to switch to. Its own settings can't be changed here.`,
    );
  }
  const asked = input.strategy;
  const want: Family = asked ? (FAMILY[asked] as Family) : (current as Family);
  const shopping = channel === "SHOPPING";

  // Targets: a new one wins; clear_target writes "no target"; otherwise the same family keeps its own.
  const sameFamily = want === current;
  let cpa = "0";
  let roas = "0";
  let cap = "0";
  if (input.target_cpa !== undefined) {
    if (want !== "MAXIMIZE_CONVERSIONS") {
      throw new ChangeError(
        "invalid_input",
        `target_cpa only goes with Maximize conversions (Target CPA), not ${words(want)}.`,
      );
    }
    cpa = money(ctx, input.target_cpa, "The target CPA").toString();
  } else if (want === "MAXIMIZE_CONVERSIONS" && sameFamily && !input.clear_target) {
    cpa = touched[K.cpa] ?? "0";
  }
  if (input.target_roas_percent !== undefined) {
    if (want !== "MAXIMIZE_CONVERSION_VALUE") {
      throw new ChangeError(
        "invalid_input",
        `target_roas_percent only goes with Maximize conversion value (Target ROAS), not ${words(want)}.`,
      );
    }
    roas = ratioOfPercent(input.target_roas_percent);
  } else if (want === "MAXIMIZE_CONVERSION_VALUE" && sameFamily && !input.clear_target) {
    roas = touched[K.roas] ?? "0";
  }
  if (
    input.clear_target &&
    want !== "MAXIMIZE_CONVERSIONS" &&
    want !== "MAXIMIZE_CONVERSION_VALUE"
  ) {
    throw new ChangeError("invalid_input", `${words(want)} has no target to clear.`);
  }
  if (input.max_cpc_limit !== undefined) {
    if (want !== "MAXIMIZE_CLICKS") {
      throw new ChangeError("invalid_input", "max_cpc_limit only goes with Maximize clicks.");
    }
    cap = money(ctx, input.max_cpc_limit, "The max CPC limit").toString();
  } else if (input.clear_max_cpc_limit) {
    if (want !== "MAXIMIZE_CLICKS") {
      throw new ChangeError("invalid_input", "clear_max_cpc_limit only goes with Maximize clicks.");
    }
    cap = "0";
  } else if (want === "MAXIMIZE_CLICKS" && sameFamily) {
    cap = touched[K.cap] ?? "0";
  }
  if (asked === "TARGET_CPA" && cpa === "0") {
    throw new ChangeError("invalid_input", "Target CPA needs target_cpa.");
  }
  if (asked === "TARGET_ROAS" && roas === "0") {
    throw new ChangeError("invalid_input", "Target ROAS needs target_roas_percent.");
  }

  // Campaign type rules (PerfoAds checkBiddingStrategyForChannelType).
  if (
    channel === "PERFORMANCE_MAX" &&
    want !== "MAXIMIZE_CONVERSIONS" &&
    want !== "MAXIMIZE_CONVERSION_VALUE"
  ) {
    throw new ChangeError(
      "not_allowed",
      "Performance Max can only use Maximize conversions or Maximize conversion value (each with an optional target).",
    );
  }
  if (shopping && want === "MAXIMIZE_CONVERSIONS") {
    throw new ChangeError(
      "not_allowed",
      "A Shopping campaign can use Manual CPC, Maximize clicks or Target ROAS only.",
    );
  }
  if (shopping && want === "MAXIMIZE_CONVERSION_VALUE" && roas === "0") {
    throw new ChangeError(
      "not_allowed",
      "A Shopping campaign can use Target ROAS only with a target; it can't be cleared.",
    );
  }
  if (channel === "DEMAND_GEN" && want === "MANUAL_CPC") {
    throw new ChangeError("not_allowed", "A Demand Gen campaign can't use Manual CPC.");
  }

  const expected: Touched = { [K.strategy]: want, [K.portfolio]: "" };
  let body: JsonObject;
  let mask: string;
  switch (want) {
    case "MANUAL_CPC":
      body = { manualCpc: { enhancedCpcEnabled: false } };
      mask = "manual_cpc.enhanced_cpc_enabled";
      expected[K.ecpc] = "false";
      break;
    case "MAXIMIZE_CLICKS":
      // A mask without a value clears the limit (PerfoAds: never a placeholder ceiling).
      body = { targetSpend: cap === "0" ? {} : { cpcBidCeilingMicros: cap } };
      mask = "target_spend.cpc_bid_ceiling_micros";
      expected[K.cap] = cap;
      break;
    case "MAXIMIZE_CONVERSIONS":
      body = { maximizeConversions: { targetCpaMicros: cpa } };
      mask = "maximize_conversions.target_cpa_micros";
      expected[K.cpa] = cpa;
      break;
    case "MAXIMIZE_CONVERSION_VALUE":
      // Standard Shopping still runs the standalone target_roas.
      body = shopping
        ? { targetRoas: { targetRoas: Number(roas) } }
        : { maximizeConversionValue: { targetRoas: Number(roas) } };
      mask = shopping ? "target_roas.target_roas" : "maximize_conversion_value.target_roas";
      expected[K.roas] = roas;
      break;
  }
  const allSame = Object.entries(expected).every(([k, v]) => touched[k] === v);
  if (allSame) {
    throw new ChangeError(
      "nothing_to_change",
      `Nothing to change: campaign ${id} already bids like that.`,
    );
  }

  const diff: string[] = [];
  const warnings: string[] = [];
  const facts: ChangeFacts = { strategySwitch: null, targetChanges: [], affectedCampaignIds: [id] };
  const label = (f: string, t: Touched): string => {
    if (f === "MAXIMIZE_CONVERSIONS")
      return `${words(f)} (target CPA: ${cpaText(ctx, t[K.cpa] ?? "0")})`;
    if (f === "MAXIMIZE_CONVERSION_VALUE")
      return `${words(f)} (target ROAS: ${roasText(t[K.roas] ?? "0")})`;
    if (f === "MAXIMIZE_CLICKS")
      return `${words(f)} (max CPC limit: ${(t[K.cap] ?? "0") === "0" ? "none" : formatMoney(t[K.cap] ?? "0", ctx.account.currencyCode)})`;
    return words(f);
  };
  const afterView: Touched = { ...expected, [K.cpa]: cpa, [K.roas]: roas, [K.cap]: cap };
  diff.push(`Campaign ${id} bidding: ${label(current, touched)} -> ${label(want, afterView)}.`);
  if (!sameFamily) {
    facts.strategySwitch = { from: current, to: want };
    warnings.push(LEARNING_SWITCH);
  }
  for (const [kind, k] of [
    ["target_cpa_micros", K.cpa],
    ["target_roas", K.roas],
  ] as const) {
    const b = touched[k] ?? "0";
    const a = afterView[k] ?? "0";
    if (b !== a) {
      facts.targetChanges?.push({
        kind,
        before: b === "0" ? null : b,
        after: a === "0" ? null : a,
        changePct: pct(b, a),
      });
    }
  }
  if (sameFamily && (facts.targetChanges?.length ?? 0) > 0) warnings.push(LEARNING_TARGET);

  let undo: Planned["undo"] = { supported: true, why: null };
  if (!supportedNow) {
    undo = {
      supported: false,
      why: `The campaign used ${words(currentRaw)} before, which can't be set back from here.`,
    };
  } else if (current === "MANUAL_CPC" && touched[K.ecpc] === "true") {
    undo = {
      supported: false,
      why: "The campaign used Enhanced CPC before, which can't be turned back on (Google retired it).",
    };
  }

  return {
    ops: [
      {
        campaignOperation: {
          update: { resourceName: resourceName(ctx.target.customerId, "campaigns", id), ...body },
          updateMask: mask,
        },
      },
    ],
    readTarget: { resource: "campaign", id },
    touched,
    expected,
    diff,
    affected: [
      { kind: "campaign", id, name: asString(c.name) ?? null, status: asString(c.status) ?? null },
    ],
    facts,
    warnings,
    undo,
  };
};

export const updateBidding: ActionType<UpdateBiddingInput> = {
  type: "update_bidding",
  summary:
    "Switch a campaign's bidding strategy or change its target CPA / target ROAS (a shared strategy changes for every campaign on it).",
  input: updateBiddingInput,
  undoInputSchema: updateBiddingUndoInput,
  independentOps: false,

  async plan(ctx, input) {
    const c = await readCampaign(ctx, input.campaign_id);
    if (!c)
      throw new ChangeError(
        "not_found",
        `Campaign ${input.campaign_id} was not found in this account.`,
      );
    if (asString(c.status) === "REMOVED") {
      throw new ChangeError("not_allowed", `Campaign ${input.campaign_id} is removed.`);
    }
    const touched = campaignTouched(c);
    if (!touched)
      throw new ChangeError(
        "read_failed",
        `Couldn't read campaign ${input.campaign_id}'s bidding.`,
      );
    const portfolio = touched[K.portfolio] ?? "";
    if (portfolio) {
      const pid = ownId(ctx.target.customerId, portfolio, "biddingStrategies");
      if (!pid) {
        throw new ChangeError(
          "not_allowed",
          `Campaign ${input.campaign_id} uses a bidding strategy owned by a manager account; change it there.`,
        );
      }
      return planPortfolio(ctx, input, c, pid);
    }
    const planned = planOwn(ctx, input, c, touched);
    // a switch into value bidding needs Google's conversion minimum; an undo puts back
    // what the campaign had and is left to Google's own check
    const sw = planned.facts.strategySwitch;
    if (sw && switchesIntoValueBidding(sw.to, sw.from) && !ctx.undoOf) {
      const conv = await readConversions30d(ctx, input.campaign_id);
      if (conv < VALUE_BIDDING_MIN_CONV_30D) {
        const shown = Math.round(conv * 10) / 10;
        throw new ChangeError(
          "not_allowed",
          `Campaign ${input.campaign_id} had ${shown} conversion${shown === 1 ? "" : "s"} in the last 30 days; Google needs about ${VALUE_BIDDING_MIN_CONV_30D} before it allows bidding on conversion value (Maximize conversion value or Target ROAS) and refuses the switch otherwise. Keep the current bidding until it has enough sales.`,
        );
      }
    }
    return planned;
  },

  async readTouched(ctx, t: ReadTarget) {
    if (t.resource === "bidding_strategy") {
      const b = await readPortfolio(ctx, t.id);
      return b && asString(b.status) !== "REMOVED" ? portfolioTouched(b) : null;
    }
    const c = await readCampaign(ctx, t.id);
    return c && asString(c.status) !== "REMOVED" ? campaignTouched(c) : null;
  },

  fromMutateResults(results) {
    const r = results[0];
    if (!r?.resource) return null;
    return r.resourceName?.includes("/biddingStrategies/")
      ? portfolioTouched(r.resource)
      : campaignTouched(r.resource);
  },

  undoInput(payload, before, t) {
    if (t.resource === "bidding_strategy") {
      const type = before[K.pType] ?? "";
      const cpaType = type === "TARGET_CPA" || type === "MAXIMIZE_CONVERSIONS";
      const value = (cpaType ? before[K.pCpa] : before[K.pRoas]) ?? "0";
      if (value === "0") return { campaign_id: payload.campaign_id, clear_target: true };
      return cpaType
        ? { campaign_id: payload.campaign_id, target_cpa: microsToDecimalString(value) }
        : { campaign_id: payload.campaign_id, target_roas_percent: Number(value) * 100 };
    }
    const strategy = before[K.strategy] ?? "";
    const out: Record<string, unknown> = { campaign_id: payload.campaign_id, strategy };
    if (strategy === "MAXIMIZE_CONVERSIONS") {
      if ((before[K.cpa] ?? "0") === "0") out.clear_target = true;
      else out.target_cpa = microsToDecimalString(before[K.cpa] ?? "0");
    } else if (strategy === "MAXIMIZE_CONVERSION_VALUE") {
      if ((before[K.roas] ?? "0") === "0") out.clear_target = true;
      else out.target_roas_percent = Number(before[K.roas]) * 100;
    } else if (strategy === "MAXIMIZE_CLICKS") {
      // "No limit" before means the undo removes any limit added since.
      if ((before[K.cap] ?? "0") === "0") out.clear_max_cpc_limit = true;
      else out.max_cpc_limit = microsToDecimalString(before[K.cap] ?? "0");
    }
    return out;
  },
};
