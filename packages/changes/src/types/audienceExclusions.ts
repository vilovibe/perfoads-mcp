// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// add_audience_exclusions: exclude audience lists (user lists) from one campaign
// (campaign_criterion, negative USER_LIST). PerfoAds only had the helper inside its
// campaign builder; this is the forward type. Undo removes the exclusions it added.

import { z } from "zod";
import { ChangeError } from "../errors.js";
import { asObject, asString } from "../json.js";
import type { ActionType, Planned, ReadCtx, ReadTarget, Touched } from "./actionType.js";
import {
  assertId,
  compositeName,
  gaql,
  idList,
  idSchema,
  plural,
  readCampaigns,
  resourceName,
} from "./common.js";

export const EXCLUSIONS_MAX = 50;

export const addAudienceExclusionsInput = z
  .object({
    campaign_id: idSchema,
    user_list_ids: z
      .array(idSchema)
      .min(1)
      .max(EXCLUSIONS_MAX)
      .refine((ids) => new Set(ids).size === ids.length, "a list is given twice"),
  })
  .strict();

const undoInput = z
  .object({
    campaign_id: idSchema,
    undo_remove_user_list_ids: z.array(idSchema).min(1).max(EXCLUSIONS_MAX),
  })
  .strict();

export type AddAudienceExclusionsInput =
  z.infer<typeof addAudienceExclusionsInput> | z.infer<typeof undoInput>;

const exclKey = (campaignId: string, userListId: string): string =>
  JSON.stringify(["excl", campaignId, userListId]);

const listOfKey = (key: string): string | null => {
  try {
    const v = JSON.parse(key) as unknown;
    return Array.isArray(v) && v[0] === "excl" && typeof v[2] === "string" ? assertId(v[2]) : null;
  } catch {
    return null;
  }
};

/** Live exclusions on the campaign: user list id -> criterion id. */
const readExclusions = async (ctx: ReadCtx, campaignId: string): Promise<Map<string, string>> => {
  const rows = await gaql(
    ctx,
    `SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.user_list.user_list FROM campaign_criterion WHERE campaign.id = ${assertId(campaignId)} AND campaign_criterion.type = 'USER_LIST' AND campaign_criterion.negative = TRUE AND campaign_criterion.status != 'REMOVED' LIMIT 1000`,
    "the campaign's audience exclusions",
    1000,
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    const c = asObject(r.campaignCriterion);
    const list = asString(asObject(c.userList).userList) ?? "";
    const id = /\/userLists\/(\d+)$/.exec(list)?.[1];
    if (id) out.set(id, String(c.criterionId ?? ""));
  }
  return out;
};

const readExclusionKeys = async (ctx: ReadCtx, t: ReadTarget): Promise<Touched> => {
  const keys = Array.isArray(t.scope?.keys)
    ? t.scope.keys.filter((k): k is string => typeof k === "string")
    : [];
  const live = await readExclusions(ctx, t.id);
  return Object.fromEntries(
    keys.map((k) => [k, live.has(listOfKey(k) ?? "") ? "present" : "absent"]),
  );
};

export const addAudienceExclusions: ActionType<AddAudienceExclusionsInput> = {
  type: "add_audience_exclusions",
  summary: "Exclude audience lists from one campaign (undo removes the exclusions).",
  input: addAudienceExclusionsInput as z.ZodType<AddAudienceExclusionsInput>,
  undoInputSchema: undoInput as z.ZodType<AddAudienceExclusionsInput>,
  independentOps: false,
  itemKeys: true,

  async plan(ctx, input): Promise<Planned> {
    const cid = ctx.target.customerId;
    const id = input.campaign_id;
    const campaigns = await readCampaigns(ctx, [id]);
    const c = campaigns.get(id);
    const live = await readExclusions(ctx, id);
    const affectedCampaign = {
      kind: "campaign" as const,
      id,
      name: c?.name ?? null,
      status: c?.status ?? null,
    };

    if ("undo_remove_user_list_ids" in input) {
      const found = input.undo_remove_user_list_ids.filter((u) => live.has(u));
      if (found.length === 0)
        throw new ChangeError("nothing_to_change", "Nothing to undo: those exclusions are gone.");
      const keys = found.map((u) => exclKey(id, u));
      return {
        ops: found.map((u) => ({
          campaignCriterionOperation: {
            remove: compositeName(cid, "campaignCriteria", id, live.get(u) ?? ""),
          },
        })),
        readTarget: { resource: "campaign_criterion", id, scope: { keys: [...keys].sort() } },
        touched: Object.fromEntries(keys.map((k) => [k, "present"])),
        expected: Object.fromEntries(keys.map((k) => [k, "absent"])),
        diff: [`Campaign ${id}: removes ${plural(found.length, "audience exclusion")} (undo).`],
        affected: [affectedCampaign],
        facts: {
          affectedCampaignIds: [id],
          items: [{ kind: "audience_exclusion", created: 0, updated: 0, removed: found.length }],
        },
        warnings: [],
        undo: {
          supported: false,
          why: "This is an undo; propose the change again instead.",
          level: "none",
        },
        targetKeys: [`campaigns/${id}/audienceExclusions`],
      };
    }

    const listRows = await gaql(
      ctx,
      `SELECT user_list.id, user_list.name, user_list.type, user_list.membership_status FROM user_list WHERE user_list.id IN ${idList(input.user_list_ids)}`,
      "the audience lists",
      input.user_list_ids.length + 1,
    );
    const lists = new Map(
      listRows.map((r) => {
        const u = asObject(r.userList);
        return [
          String(u.id ?? ""),
          { name: asString(u.name) ?? null, status: asString(u.membershipStatus) ?? null },
        ];
      }),
    );
    const missing = input.user_list_ids.filter((u) => !lists.has(u));
    if (missing.length) {
      throw new ChangeError(
        "not_found",
        `Audience list${missing.length === 1 ? "" : "s"} ${missing.join(", ")} not found in this account.`,
      );
    }
    const toAdd = input.user_list_ids.filter((u) => !live.has(u));
    if (toAdd.length === 0) {
      throw new ChangeError(
        "nothing_to_change",
        `Nothing to change: campaign ${id} already excludes every list.`,
      );
    }
    const keys = toAdd.map((u) => exclKey(id, u));
    const closed = toAdd.filter((u) => lists.get(u)?.status === "CLOSED");
    return {
      ops: toAdd.map((u) => ({
        campaignCriterionOperation: {
          create: {
            campaign: resourceName(cid, "campaigns", id),
            negative: true,
            userList: { userList: resourceName(cid, "userLists", u) },
          },
        },
      })),
      readTarget: { resource: "campaign_criterion", id, scope: { keys: [...keys].sort() } },
      touched: Object.fromEntries(keys.map((k) => [k, "absent"])),
      expected: Object.fromEntries(keys.map((k) => [k, "present"])),
      diff: [
        `Campaign ${id}: excludes ${plural(toAdd.length, "audience list")} (${toAdd.join(", ")})${toAdd.length < input.user_list_ids.length ? `; ${input.user_list_ids.length - toAdd.length} already excluded` : ""}.`,
        "People on an excluded list no longer see this campaign's ads. Exclusions add no spend.",
      ],
      affected: [
        affectedCampaign,
        ...toAdd.map((u) => ({
          kind: "user_list" as const,
          id: u,
          name: lists.get(u)?.name ?? null,
          status: lists.get(u)?.status ?? null,
        })),
      ],
      facts: {
        affectedCampaignIds: [id],
        items: [{ kind: "audience_exclusion", created: toAdd.length, updated: 0, removed: 0 }],
      },
      warnings: closed.length
        ? [
            `${plural(closed.length, "list")} (${closed.join(", ")}) no longer collects members (closed).`,
          ]
        : [],
      undo: { supported: true, why: null, level: "full" },
      targetKeys: [`campaigns/${id}/audienceExclusions`],
    };
  },

  readTouched: readExclusionKeys,
  fromMutateResults: () => null,

  undoInput: (payload, before) => ({
    campaign_id: payload.campaign_id,
    undo_remove_user_list_ids: Object.entries(before)
      .filter(([, v]) => v === "absent")
      .map(([k]) => listOfKey(k))
      .filter((u): u is string => u !== null),
  }),

  historyWhere: (customerId, t) =>
    `change_event.change_resource_type = 'CAMPAIGN_CRITERION' AND change_event.campaign = '${resourceName(customerId, "campaigns", t.id)}'`,
};
