// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// add_campaign_negatives / remove_campaign_negatives: negative keywords on campaigns
// (campaign_criterion, negative KEYWORD). Ported from PerfoAds executeAddNegativeKeywords
// and its undo; the forward remove type is new. Adding runs the negatives safety gate
// (brand never, conversions only with an explicit override). Each item is one operation;
// adding uses partial failure (independent items), undo removes only what landed.
//
// Undo stays inside the type: undoing an add removes those negatives, undoing a remove
// puts them back (not re-checked: they were there before).

import { z } from "zod";
import { ChangeError } from "../errors.js";
import { asObject, asString, type JsonObject } from "../json.js";
import {
  brandTermsInput,
  MATCH_TYPES,
  negativeInput,
  negativesGate,
  negKey,
  overrideInput,
  parseNegKey,
} from "../negatives/gate.js";
import type { ActionType, Planned, ReadCtx, ReadTarget, Touched } from "./actionType.js";
import {
  compositeName,
  gaql,
  idList,
  idSchema,
  plural,
  presence,
  readCampaigns,
  resourceName,
  scopeIds,
  scopeKeys,
  unique,
} from "./common.js";
import { normKeyword } from "./text.js";

/** Most negatives in one change, and most campaigns. */
export const NEGATIVES_MAX = 200;
export const NEGATIVE_CAMPAIGNS_MAX = 20;
/** Rows read per campaign set (a campaign holds at most 10,000 negatives). */
const EXISTING_MAX = 20_000;

const noDuplicates = (
  list: readonly { text: string; match_type: string }[],
  ctx: z.RefinementCtx,
): void => {
  const seen = new Set<string>();
  list.forEach((n, i) => {
    const k = `${n.match_type}|${normKeyword(n.text)}`;
    if (seen.has(k)) {
      ctx.addIssue({ code: "custom", path: ["negatives", i], message: "listed twice" });
    }
    seen.add(k);
  });
};

const campaignIdsField = z
  .array(idSchema)
  .min(1)
  .max(NEGATIVE_CAMPAIGNS_MAX)
  .refine((ids) => new Set(ids).size === ids.length, "a campaign is listed twice");

export const addCampaignNegativesInput = z
  .object({
    campaign_ids: campaignIdsField.describe("Campaigns that get every negative"),
    negatives: z.array(negativeInput).min(1).max(NEGATIVES_MAX),
    override_blocked_conversions: overrideInput,
    brand_terms: brandTermsInput,
  })
  .strict()
  .superRefine((v, ctx) => noDuplicates(v.negatives, ctx));

const undoItem = z
  .object({
    campaign_id: idSchema,
    text: z.string().min(1).max(200),
    match_type: z.enum(MATCH_TYPES),
  })
  .strict();

const addUndoInput = z
  .object({
    undo_remove: z
      .array(undoItem)
      .min(1)
      .max(NEGATIVES_MAX * NEGATIVE_CAMPAIGNS_MAX),
  })
  .strict();

export type AddCampaignNegativesInput =
  z.infer<typeof addCampaignNegativesInput> | z.infer<typeof addUndoInput>;

export const removeCampaignNegativesInput = z
  .object({
    campaign_id: idSchema,
    negatives: z.array(negativeInput).min(1).max(NEGATIVES_MAX),
  })
  .strict()
  .superRefine((v, ctx) => noDuplicates(v.negatives, ctx));

const removeUndoInput = z
  .object({ undo_add_back: z.array(undoItem).min(1).max(NEGATIVES_MAX) })
  .strict();

export type RemoveCampaignNegativesInput =
  z.infer<typeof removeCampaignNegativesInput> | z.infer<typeof removeUndoInput>;

interface Existing {
  campaignId: string;
  criterionId: string;
  text: string;
  matchType: string;
}

/** Negative keywords live on these campaigns (not removed). */
const readExisting = async (ctx: ReadCtx, campaignIds: readonly string[]): Promise<Existing[]> => {
  const rows = await gaql(
    ctx,
    `SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.id IN ${idList(campaignIds)} AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign_criterion.status != 'REMOVED' LIMIT ${EXISTING_MAX + 1}`,
    "the campaigns' negative keywords",
    EXISTING_MAX + 1,
  );
  if (rows.length > EXISTING_MAX) {
    throw new ChangeError(
      "not_allowed",
      `These campaigns hold more than ${EXISTING_MAX.toLocaleString("en-US")} negative keywords; change fewer campaigns at once.`,
    );
  }
  return rows.map((r) => {
    const c = asObject(r.campaignCriterion);
    const kw = asObject(c.keyword);
    return {
      campaignId: String(asObject(r.campaign).id ?? ""),
      criterionId: String(c.criterionId ?? ""),
      text: asString(kw.text) ?? "",
      matchType: asString(kw.matchType) ?? "",
    };
  });
};

const keyOf = (e: { campaignId: string; matchType: string; text: string }): string =>
  negKey(e.campaignId, e.matchType, e.text);

const readTarget = (campaignIds: readonly string[], keys: readonly string[]): ReadTarget => ({
  resource: "campaign_criterion",
  id: "negatives",
  scope: { campaignIds: [...campaignIds].sort(), keys: [...keys].sort() },
});

const affectedOf = (
  campaigns: Awaited<ReturnType<typeof readCampaigns>>,
  ids: readonly string[],
): Planned["affected"] =>
  ids.map((id) => {
    const c = campaigns.get(id);
    return { kind: "campaign", id, name: c?.name ?? null, status: c?.status ?? null };
  });

/** Adds negatives (forward add, or the undo of a remove). */
const planAdd = async (
  ctx: ReadCtx,
  items: readonly { campaignId: string; text: string; matchType: string }[],
  opts: { gate: { override: boolean; brandTerms?: readonly string[] | undefined } | null },
): Promise<Planned> => {
  const campaignIds = unique(items.map((i) => i.campaignId));
  const campaigns = await readCampaigns(ctx, campaignIds);
  const existing = new Set((await readExisting(ctx, campaignIds)).map(keyOf));
  const toAdd = items.filter((i) => !existing.has(keyOf(i)));
  if (toAdd.length === 0) {
    throw new ChangeError(
      "nothing_to_change",
      "Nothing to change: every negative keyword is already on its campaign.",
    );
  }
  const outcome = opts.gate
    ? await negativesGate(
        ctx,
        [
          ...new Map(
            toAdd.map((i) => [
              `${i.matchType}|${normKeyword(i.text)}`,
              { text: i.text, matchType: i.matchType as (typeof MATCH_TYPES)[number] },
            ]),
          ).values(),
        ],
        {
          ...opts.gate,
          reachesPmax: campaignIds.some((id) => campaigns.get(id)?.channel === "PERFORMANCE_MAX"),
        },
      )
    : { warnings: [], blocked: undefined };
  const cid = ctx.target.customerId;
  const ops: JsonObject[] = toAdd.map((i) => ({
    campaignCriterionOperation: {
      create: {
        campaign: resourceName(cid, "campaigns", i.campaignId),
        negative: true,
        keyword: { text: i.text, matchType: i.matchType },
      },
    },
  }));
  const keys = toAdd.map(keyOf);
  const diff = campaignIds.map((id) => {
    const n = toAdd.filter((i) => i.campaignId === id).length;
    const s = items.filter((i) => i.campaignId === id).length - n;
    return `Campaign ${id}: adds ${plural(n, "negative keyword")}${s ? ` (${s} already there, skipped)` : ""}.`;
  });
  diff.push(
    opts.gate
      ? "Negative keywords stop ads from showing for matching searches; they add no spend. Checked against your brand terms and searches and keywords with conversions in the last 90 days."
      : "Puts back negative keywords that were removed (undo); they were there before, so they are not checked again.",
  );
  return {
    ops,
    readTarget: readTarget(campaignIds, keys),
    touched: Object.fromEntries(keys.map((k) => [k, "absent"])),
    expected: Object.fromEntries(keys.map((k) => [k, "present"])),
    diff,
    affected: affectedOf(campaigns, campaignIds),
    facts: {
      affectedCampaignIds: campaignIds,
      items: [{ kind: "campaign_negative_keyword", created: toAdd.length, updated: 0, removed: 0 }],
      ...(outcome.blocked ? { blockedConversions: outcome.blocked } : {}),
    },
    warnings: outcome.warnings,
    undo: opts.gate
      ? { supported: true, why: null, level: "full" }
      : {
          supported: false,
          why: "This is an undo; propose the change again instead.",
          level: "none",
        },
    targetKeys: campaignIds.map((id) => `campaigns/${id}/negatives`),
    opKeys: keys.map((k) => [k]),
  };
};

/** Removes negatives (forward remove, or the undo of an add). */
const planRemove = async (
  ctx: ReadCtx,
  items: readonly { campaignId: string; text: string; matchType: string }[],
  undo: boolean,
): Promise<Planned> => {
  const campaignIds = unique(items.map((i) => i.campaignId));
  const campaigns = await readCampaigns(ctx, campaignIds);
  const existing = await readExisting(ctx, campaignIds);
  const wanted = new Set(items.map(keyOf));
  const found = existing.filter((e) => wanted.has(keyOf(e)));
  const foundKeys = unique(found.map(keyOf));
  if (foundKeys.length === 0) {
    throw new ChangeError(
      "nothing_to_change",
      "Nothing to change: none of these negative keywords is on its campaign.",
    );
  }
  const missing = wanted.size - foundKeys.length;
  const cid = ctx.target.customerId;
  const ops: JsonObject[] = found.map((e) => ({
    campaignCriterionOperation: {
      remove: compositeName(cid, "campaignCriteria", e.campaignId, e.criterionId),
    },
  }));
  const diff = campaignIds.map((id) => {
    const n = unique(found.filter((e) => e.campaignId === id).map(keyOf)).length;
    return `Campaign ${id}: removes ${plural(n, "negative keyword")}${undo ? " (undo)" : ""}.`;
  });
  if (missing)
    diff.push(`${plural(missing, "negative keyword")} not found on its campaign, skipped.`);
  diff.push("Removing negative keywords lets ads show for those searches again.");
  return {
    ops,
    readTarget: readTarget(campaignIds, foundKeys),
    touched: Object.fromEntries(foundKeys.map((k) => [k, "present"])),
    expected: Object.fromEntries(foundKeys.map((k) => [k, "absent"])),
    diff,
    affected: affectedOf(campaigns, campaignIds),
    facts: {
      affectedCampaignIds: campaignIds,
      items: [{ kind: "campaign_negative_keyword", created: 0, updated: 0, removed: ops.length }],
    },
    warnings: [],
    undo: undo
      ? {
          supported: false,
          why: "This is an undo; propose the change again instead.",
          level: "none",
        }
      : { supported: true, why: null, level: "full" },
    targetKeys: campaignIds.map((id) => `campaigns/${id}/negatives`),
  };
};

const readNegatives = async (ctx: ReadCtx, t: ReadTarget): Promise<Touched> => {
  const keys = scopeKeys(t.scope);
  const ids = scopeIds(t.scope, "campaignIds");
  const found = new Set((await readExisting(ctx, ids)).map(keyOf));
  return presence(keys, found);
};

/** Items of the keys that read `value` in `before` (what an undo works on). */
const itemsOf = (before: Touched, value: string) =>
  Object.entries(before)
    .filter(([, v]) => v === value)
    .map(([k]) => parseNegKey(k))
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => ({ campaign_id: p.where, text: p.text, match_type: p.matchType }));

const negativesHistory = (customerId: string, t: ReadTarget): string | null => {
  const ids = scopeIds(t.scope, "campaignIds");
  if (ids.length === 0) return null;
  return `change_event.change_resource_type = 'CAMPAIGN_CRITERION' AND change_event.campaign IN (${ids
    .map((id) => `'${resourceName(customerId, "campaigns", id)}'`)
    .join(", ")})`;
};

export const addCampaignNegatives: ActionType<AddCampaignNegativesInput> = {
  type: "add_campaign_negatives",
  summary:
    "Add negative keywords to campaigns (refused when they would block your brand or searches/keywords with conversions).",
  input: addCampaignNegativesInput as z.ZodType<AddCampaignNegativesInput>,
  undoInputSchema: addUndoInput as z.ZodType<AddCampaignNegativesInput>,
  independentOps: true,
  itemKeys: true,

  async plan(ctx, input) {
    if ("undo_remove" in input) {
      return planRemove(
        ctx,
        input.undo_remove.map((i) => ({
          campaignId: i.campaign_id,
          text: i.text,
          matchType: i.match_type,
        })),
        true,
      );
    }
    const items = input.campaign_ids.flatMap((campaignId) =>
      input.negatives.map((n) => ({ campaignId, text: n.text, matchType: n.match_type })),
    );
    return planAdd(ctx, items, {
      gate: {
        override: input.override_blocked_conversions === true,
        brandTerms: input.brand_terms,
      },
    });
  },

  readTouched: readNegatives,
  fromMutateResults: () => null,

  undoInput(_payload, before) {
    return { undo_remove: itemsOf(before, "absent") };
  },

  historyWhere: negativesHistory,

  modelTexts(input) {
    if ("undo_remove" in input) return [];
    return [
      {
        label: "Negative keywords (match type: text)",
        items: input.negatives.map((n) => `${n.match_type}: ${n.text}`),
      },
      ...(input.brand_terms?.length
        ? [{ label: "Brand terms given", items: input.brand_terms }]
        : []),
    ];
  },
};

export const removeCampaignNegatives: ActionType<RemoveCampaignNegativesInput> = {
  type: "remove_campaign_negatives",
  summary: "Remove negative keywords from one campaign (undo puts them back).",
  input: removeCampaignNegativesInput as z.ZodType<RemoveCampaignNegativesInput>,
  undoInputSchema: removeUndoInput as z.ZodType<RemoveCampaignNegativesInput>,
  independentOps: false,
  itemKeys: true,

  async plan(ctx, input) {
    if ("undo_add_back" in input) {
      return planAdd(
        ctx,
        input.undo_add_back.map((i) => ({
          campaignId: i.campaign_id,
          text: i.text,
          matchType: i.match_type,
        })),
        { gate: null },
      );
    }
    return planRemove(
      ctx,
      input.negatives.map((n) => ({
        campaignId: input.campaign_id,
        text: n.text,
        matchType: n.match_type,
      })),
      false,
    );
  },

  readTouched: readNegatives,
  fromMutateResults: () => null,

  undoInput(payload, before) {
    // Put back the texts as they were sent (the keys hold them in lower case).
    const texts = new Map(
      "negatives" in payload
        ? payload.negatives.map((n) => [negKey(payload.campaign_id, n.match_type, n.text), n.text])
        : [],
    );
    return {
      undo_add_back: itemsOf(before, "present").map((i) => ({
        ...i,
        text: texts.get(negKey(i.campaign_id, i.match_type, i.text)) ?? i.text,
      })),
    };
  },

  historyWhere: negativesHistory,

  modelTexts(input) {
    if ("undo_add_back" in input) return [];
    return [
      {
        label: "Negative keywords to remove (match type: text)",
        items: input.negatives.map((n) => `${n.match_type}: ${n.text}`),
      },
    ];
  },
};
