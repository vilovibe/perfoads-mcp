// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// update_campaign_status: pause or enable one campaign. Ported from PerfoAds
// executeUpdateCampaignStatus. REMOVED is never allowed in v1 (Google has no un-remove).
// Enabling reports the daily budget that starts to spend (for the P5 new-spend limit).

import { z } from "zod";
import { asObject, asString, microsField } from "../json.js";
import { ChangeError } from "../errors.js";
import type { ActionType, Planned, ReadCtx, ReadTarget, Touched } from "./actionType.js";
import { assertId, formatMoney, gaql, idSchema, resourceName } from "./common.js";

const FIELD = "campaign.status";

export const updateCampaignStatusInput = z
  .object({
    campaign_id: idSchema,
    status: z.string().superRefine((v, ctx) => {
      if (v.toUpperCase() === "REMOVED") {
        ctx.addIssue({
          code: "custom",
          message: "removing a campaign is not allowed here (it can't be undone); pause it instead",
        });
      } else if (v !== "ENABLED" && v !== "PAUSED") {
        ctx.addIssue({ code: "custom", message: 'must be "ENABLED" or "PAUSED"' });
      }
    }),
  })
  .strict()
  .transform((v) => ({ campaign_id: v.campaign_id, status: v.status as "ENABLED" | "PAUSED" }));

export type UpdateCampaignStatusInput = z.infer<typeof updateCampaignStatusInput>;

const readCampaign = async (ctx: ReadCtx, campaignId: string) => {
  const rows = await gaql(
    ctx,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.period FROM campaign WHERE campaign.id = ${assertId(campaignId)} LIMIT 1`,
    "the campaign",
  );
  if (!rows[0]) return null;
  const c = asObject(rows[0].campaign);
  const b = asObject(rows[0].campaignBudget);
  return {
    name: asString(c.name) ?? null,
    status: asString(c.status) ?? null,
    budgetId: asString(b.id) ?? null,
    budgetMicros: b.amountMicros === undefined ? null : microsField(b.amountMicros),
    budgetShared: b.explicitlyShared === true,
    budgetPeriod: asString(b.period) ?? null,
  };
};

export const updateCampaignStatus: ActionType<UpdateCampaignStatusInput> = {
  type: "update_campaign_status",
  summary: "Pause or enable one campaign (removing is not allowed).",
  input: updateCampaignStatusInput,
  independentOps: false,

  async plan(ctx, input): Promise<Planned> {
    const id = input.campaign_id;
    const currency = ctx.account.currencyCode;
    const c = await readCampaign(ctx, id);
    if (!c) throw new ChangeError("not_found", `Campaign ${id} was not found in this account.`);
    if (c.status === "REMOVED") {
      throw new ChangeError(
        "not_allowed",
        `Campaign ${id} is removed; it can't be paused or enabled.`,
      );
    }
    if (c.status !== "ENABLED" && c.status !== "PAUSED") {
      throw new ChangeError("read_failed", `Couldn't read campaign ${id}'s status.`);
    }
    if (c.status === input.status) {
      throw new ChangeError(
        "nothing_to_change",
        `Nothing to change: campaign ${id} is already ${input.status.toLowerCase()}.`,
      );
    }
    const enabling = input.status === "ENABLED";
    const diff = [`Campaign ${id}: ${c.status} -> ${input.status}.`];
    const warnings: string[] = [];
    if (enabling) {
      if (c.budgetMicros !== null && c.budgetId) {
        diff.push(
          `Turning it on lets it spend up to ${formatMoney(c.budgetMicros, currency)} a day (budget ${c.budgetId}${c.budgetShared ? ", shared with other campaigns" : ""}).`,
        );
      } else {
        warnings.push(
          "Couldn't read this campaign's daily budget, so the new daily spend is unknown.",
        );
      }
      if (c.budgetPeriod && c.budgetPeriod !== "DAILY") {
        warnings.push("This campaign has a total or custom-period budget, not a daily one.");
      }
    } else {
      diff.push("Pausing it stops its ads and its spend until it is enabled again.");
    }
    return {
      ops: [
        {
          campaignOperation: {
            update: {
              resourceName: resourceName(ctx.target.customerId, "campaigns", id),
              status: input.status,
            },
            updateMask: "status",
          },
        },
      ],
      readTarget: { resource: "campaign", id },
      touched: { [FIELD]: c.status },
      expected: { [FIELD]: input.status },
      diff,
      affected: [{ kind: "campaign", id, name: c.name, status: c.status }],
      facts: {
        ...(enabling
          ? {
              newlyEnabled: [
                { campaignId: id, dailyBudgetMicros: c.budgetMicros, budgetShared: c.budgetShared },
              ],
            }
          : {}),
        affectedCampaignIds: [id],
      },
      warnings,
      undo: { supported: true, why: null },
    };
  },

  async readTouched(ctx, t: ReadTarget): Promise<Touched | null> {
    const c = await readCampaign(ctx, t.id);
    if (!c?.status || c.status === "REMOVED") return null;
    return { [FIELD]: c.status };
  },

  fromMutateResults(results) {
    const status = asString(results[0]?.resource?.status);
    return status ? { [FIELD]: status } : null;
  },

  undoInput(payload, before) {
    return { campaign_id: payload.campaign_id, status: before[FIELD] };
  },
};
