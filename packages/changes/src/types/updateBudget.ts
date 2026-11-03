// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// update_budget: set a campaign budget's daily amount. Ported from PerfoAds
// executeUpdateBudget + its propose-side read; a shared budget lists every campaign on it.

import { microsToDecimalString } from "@perfoads/ads-client";
import { z } from "zod";
import { asObject, asString, microsField } from "../json.js";
import { ChangeError } from "../errors.js";
import type { ActionType, Planned, ReadCtx, ReadTarget, Touched } from "./actionType.js";
import {
  amountSchema,
  amountToMicros,
  assertId,
  campaignsUsing,
  formatMoney,
  gaql,
  idSchema,
  pctChange,
  resourceName,
  signedPct,
  smallestUnit,
} from "./common.js";

const FIELD = "campaign_budget.amount_micros";
/** Same bar as PerfoAds: a change over 50% gets a plain warning. */
const BIG_CHANGE_PCT = 50;

export const updateBudgetInput = z
  .object({
    budget_id: idSchema.optional(),
    campaign_id: idSchema.optional(),
    /** New daily amount in the account's currency. */
    daily_amount: amountSchema,
  })
  .strict()
  .refine((v) => (v.budget_id === undefined) !== (v.campaign_id === undefined), {
    message: "give either budget_id or campaign_id (not both)",
  });

export type UpdateBudgetInput = z.infer<typeof updateBudgetInput>;

const budgetIdOfCampaign = async (ctx: ReadCtx, campaignId: string): Promise<string> => {
  const rows = await gaql(
    ctx,
    `SELECT campaign.id, campaign.status, campaign_budget.id FROM campaign WHERE campaign.id = ${assertId(campaignId)} LIMIT 1`,
    "the campaign",
  );
  const budgetId = asString(asObject(rows[0]?.campaignBudget).id);
  if (!rows[0])
    throw new ChangeError("not_found", `Campaign ${campaignId} was not found in this account.`);
  if (!budgetId)
    throw new ChangeError("not_found", `Campaign ${campaignId} has no budget to change.`);
  return budgetId;
};

const readBudget = async (ctx: ReadCtx, budgetId: string) => {
  const rows = await gaql(
    ctx,
    `SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.period, campaign_budget.status, campaign_budget.total_amount_micros FROM campaign_budget WHERE campaign_budget.id = ${assertId(budgetId)} LIMIT 1`,
    "the budget",
  );
  if (!rows[0]) return null;
  const b = asObject(rows[0].campaignBudget);
  return {
    name: asString(b.name) ?? null,
    amountMicros: microsField(b.amountMicros),
    totalAmountMicros: microsField(b.totalAmountMicros),
    shared: b.explicitlyShared === true,
    period: asString(b.period) ?? null,
    status: asString(b.status) ?? null,
  };
};

export const updateBudget: ActionType<UpdateBudgetInput> = {
  type: "update_budget",
  summary:
    "Set a campaign budget's daily amount (shared budgets change for every campaign on them).",
  input: updateBudgetInput,
  independentOps: false,

  async plan(ctx, input): Promise<Planned> {
    const { customerId } = ctx.target;
    const currency = ctx.account.currencyCode;
    const budgetId = input.budget_id ?? (await budgetIdOfCampaign(ctx, input.campaign_id ?? ""));
    const budget = await readBudget(ctx, budgetId);
    if (!budget)
      throw new ChangeError("not_found", `Budget ${budgetId} was not found in this account.`);
    if (budget.status === "REMOVED") {
      throw new ChangeError(
        "not_allowed",
        `Budget ${budgetId} is removed, so it can't be changed.`,
      );
    }
    if ((budget.period && budget.period !== "DAILY") || (budget.totalAmountMicros ?? "0") !== "0") {
      throw new ChangeError(
        "not_allowed",
        `Budget ${budgetId} is not a daily budget (it is a total or custom-period budget). Only daily budgets can be changed here.`,
      );
    }
    if (budget.amountMicros === null) {
      throw new ChangeError("read_failed", `Couldn't read budget ${budgetId}'s amount.`);
    }
    let asked;
    try {
      asked = amountToMicros(input.daily_amount, currency);
    } catch {
      throw new ChangeError("invalid_input", `The amount can't be used in ${currency}.`);
    }
    const before = BigInt(budget.amountMicros);
    const after = asked.micros;
    if (after <= 0n) {
      throw new ChangeError(
        "invalid_input",
        `A daily budget must be at least ${smallestUnit(currency)}.`,
      );
    }
    if (after === before) {
      throw new ChangeError(
        "nothing_to_change",
        `Nothing to change: budget ${budgetId} is already ${formatMoney(before, currency)} a day.`,
      );
    }
    const rn = resourceName(customerId, "campaignBudgets", budgetId);
    const campaigns = await campaignsUsing(ctx, "campaign.campaign_budget", rn);
    const pct = pctChange(before, after);

    const diff = [
      `Daily budget ${budgetId}: ${formatMoney(before, currency)} -> ${formatMoney(after, currency)} a day${signedPct(pct)}.`,
    ];
    if (asked.rounded) {
      diff.push(
        `The amount asked for was rounded to ${formatMoney(after, currency)} (the smallest ${currency} step Google accepts is ${smallestUnit(currency)}).`,
      );
    }
    if (campaigns.length > 1 || budget.shared) {
      diff.push(
        `This budget is shared: the change applies to all ${campaigns.length} campaigns on it.`,
      );
    }
    const warnings: string[] = [];
    if (pct !== null && Math.abs(pct) > BIG_CHANGE_PCT) {
      warnings.push(`That is a big change: ${pct > 0 ? "+" : ""}${pct}% in one step.`);
    }
    if (!campaigns.some((c) => c.status === "ENABLED")) {
      warnings.push(
        "No enabled campaign uses this budget, so nothing will spend more or less right now.",
      );
    }

    return {
      ops: [
        {
          campaignBudgetOperation: {
            update: { resourceName: rn, amountMicros: after.toString() },
            updateMask: "amount_micros",
          },
        },
      ],
      readTarget: { resource: "campaign_budget", id: budgetId },
      touched: { [FIELD]: before.toString() },
      expected: { [FIELD]: after.toString() },
      diff,
      affected: [
        { kind: "campaign_budget", id: budgetId, name: budget.name, status: budget.status },
        ...campaigns.map((c) => ({ kind: "campaign" as const, ...c })),
      ],
      facts: {
        budgetChanges: [
          {
            budgetId,
            beforeMicros: before.toString(),
            afterMicros: after.toString(),
            shared: budget.shared || campaigns.length > 1,
          },
        ],
        affectedCampaignIds: campaigns.map((c) => c.id),
      },
      warnings,
      undo: { supported: true, why: null },
    };
  },

  async readTouched(ctx, t: ReadTarget): Promise<Touched | null> {
    const b = await readBudget(ctx, t.id);
    if (!b || b.status === "REMOVED" || b.amountMicros === null) return null;
    return { [FIELD]: b.amountMicros };
  },

  fromMutateResults(results) {
    const raw = results[0]?.resource?.amountMicros;
    const amount = raw === undefined ? null : microsField(raw);
    return amount === null ? null : { [FIELD]: amount };
  },

  undoInput(_payload, before, t) {
    // The old amount as an exact decimal (Google stored it already rounded to the currency).
    return { budget_id: t.id, daily_amount: microsToDecimalString(before[FIELD] ?? "0") };
  },
};
