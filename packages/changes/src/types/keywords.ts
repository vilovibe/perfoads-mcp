// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// add_keywords / pause_keyword. Ported from PerfoAds executeCreateKeyword(+Batch) and
// executeKeywordStatusChange.
//
// add_keywords: new keywords in one ad group. The policy's defaults are enforced here:
// new_entities_paused -> created PAUSED; broad_match_requires_smart_bidding -> BROAD is
// refused unless the campaign bids with smart bidding. Each keyword is one independent
// operation (partial failure allowed); undo removes only the ones that landed.
// pause_keyword: pauses keywords (atomic); undo enables them again.

import { z } from "zod";
import { ChangeError } from "../errors.js";
import { asObject, asString, type JsonObject } from "../json.js";
import type { ActionType, Planned, ReadCtx, ReadTarget, Touched } from "./actionType.js";
import { SAFE_DEFAULTS } from "./actionType.js";
import {
  amountSchema,
  amountToMicros,
  assertId,
  compositeName,
  formatMoney,
  gaql,
  idList,
  idSchema,
  plural,
  resourceName,
  unique,
} from "./common.js";
import { keywordTextSchema, normKeyword } from "./text.js";

export const KEYWORDS_MAX = 200;
/** An ad group holds at most 20,000 keywords (Google). */
const AD_GROUP_KEYWORDS_MAX = 20_000;
const MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"] as const;

/** Bidding that sets bids per auction from conversion data (Google's "smart bidding"). */
export const SMART_BIDDING: ReadonlySet<string> = new Set([
  "TARGET_CPA",
  "TARGET_ROAS",
  "MAXIMIZE_CONVERSIONS",
  "MAXIMIZE_CONVERSION_VALUE",
]);

export const addKeywordsInput = z
  .object({
    ad_group_id: idSchema,
    keywords: z
      .array(
        z
          .object({
            text: keywordTextSchema.describe("The words only, no [brackets] or quotes"),
            match_type: z.enum(MATCH_TYPES),
            cpc_bid: amountSchema
              .optional()
              .describe("Max CPC in the account's currency (manual bidding)"),
          })
          .strict(),
      )
      .min(1)
      .max(KEYWORDS_MAX),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.keywords.forEach((k, i) => {
      const key = `${k.match_type}|${normKeyword(k.text)}`;
      if (seen.has(key))
        ctx.addIssue({ code: "custom", path: ["keywords", i], message: "listed twice" });
      seen.add(key);
    });
  });

const addUndoInput = z
  .object({
    ad_group_id: idSchema,
    undo_remove: z
      .array(
        z.object({ text: z.string().min(1).max(200), match_type: z.enum(MATCH_TYPES) }).strict(),
      )
      .min(1)
      .max(KEYWORDS_MAX),
  })
  .strict();

export type AddKeywordsInput = z.infer<typeof addKeywordsInput> | z.infer<typeof addUndoInput>;

interface AdGroupInfo {
  id: string;
  name: string | null;
  status: string | null;
  campaignId: string;
  campaignName: string | null;
  channel: string | null;
  bidding: string | null;
}

const readAdGroup = async (ctx: ReadCtx, id: string): Promise<AdGroupInfo> => {
  const rows = await gaql(
    ctx,
    `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type FROM ad_group WHERE ad_group.id = ${assertId(id)} LIMIT 1`,
    "the ad group",
  );
  if (!rows[0]) throw new ChangeError("not_found", `Ad group ${id} was not found in this account.`);
  const g = asObject(rows[0].adGroup);
  const c = asObject(rows[0].campaign);
  if (g.status === "REMOVED" || c.status === "REMOVED") {
    throw new ChangeError("not_allowed", `Ad group ${id} (or its campaign) is removed.`);
  }
  return {
    id,
    name: asString(g.name) ?? null,
    status: asString(g.status) ?? null,
    campaignId: String(c.id ?? ""),
    campaignName: asString(c.name) ?? null,
    channel: asString(c.advertisingChannelType) ?? null,
    bidding: asString(c.biddingStrategyType) ?? null,
  };
};

interface KeywordRow {
  criterionId: string;
  text: string;
  matchType: string;
  status: string;
}

const readKeywords = async (ctx: ReadCtx, adGroupId: string): Promise<KeywordRow[]> => {
  const rows = await gaql(
    ctx,
    `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status FROM ad_group_criterion WHERE ad_group.id = ${assertId(adGroupId)} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED' LIMIT ${AD_GROUP_KEYWORDS_MAX + 1}`,
    "the ad group's keywords",
    AD_GROUP_KEYWORDS_MAX + 1,
  );
  return rows.map((r) => {
    const c = asObject(r.adGroupCriterion);
    const kw = asObject(c.keyword);
    return {
      criterionId: String(c.criterionId ?? ""),
      text: asString(kw.text) ?? "",
      matchType: asString(kw.matchType) ?? "",
      status: asString(c.status) ?? "",
    };
  });
};

/** ["kw", <ad group>, <match type>, <lower-case text>] -> status, or "absent". */
const kwKey = (adGroupId: string, matchType: string, text: string): string =>
  JSON.stringify(["kw", adGroupId, matchType, normKeyword(text)]);

const parseKwKey = (
  key: string,
): { text: string; matchType: (typeof MATCH_TYPES)[number] } | null => {
  try {
    const v = JSON.parse(key) as unknown;
    if (
      Array.isArray(v) &&
      v[0] === "kw" &&
      (MATCH_TYPES as readonly unknown[]).includes(v[2]) &&
      typeof v[3] === "string"
    ) {
      return { text: v[3], matchType: v[2] as (typeof MATCH_TYPES)[number] };
    }
  } catch {
    // not ours
  }
  return null;
};

const adGroupAffected = (g: AdGroupInfo): Planned["affected"] => [
  { kind: "ad_group", id: g.id, name: g.name, status: g.status },
  { kind: "campaign", id: g.campaignId, name: g.campaignName, status: null },
];

const readKeywordKeys = async (ctx: ReadCtx, t: ReadTarget): Promise<Touched> => {
  const keys = Array.isArray(t.scope?.keys)
    ? t.scope.keys.filter((k): k is string => typeof k === "string")
    : [];
  const status = new Map<string, string>();
  for (const k of await readKeywords(ctx, t.id))
    status.set(kwKey(t.id, k.matchType, k.text), k.status);
  return Object.fromEntries(keys.map((k) => [k, status.get(k) ?? "absent"]));
};

const keywordsHistory = (customerId: string, t: ReadTarget): string =>
  `change_event.change_resource_type = 'AD_GROUP_CRITERION' AND change_event.ad_group = '${resourceName(customerId, "adGroups", t.id)}'`;

export const addKeywords: ActionType<AddKeywordsInput> = {
  type: "add_keywords",
  summary:
    "Add keywords to one ad group (paused when the policy says so; BROAD only with smart bidding when the policy says so).",
  input: addKeywordsInput as z.ZodType<AddKeywordsInput>,
  undoInputSchema: addUndoInput as z.ZodType<AddKeywordsInput>,
  independentOps: true,
  itemKeys: true,

  async plan(ctx, input): Promise<Planned> {
    const cid = ctx.target.customerId;
    const g = await readAdGroup(ctx, input.ad_group_id);
    const existing = await readKeywords(ctx, g.id);
    const byKey = new Map(existing.map((k) => [kwKey(g.id, k.matchType, k.text), k]));

    if ("undo_remove" in input) {
      const keys = unique(input.undo_remove.map((k) => kwKey(g.id, k.match_type, k.text)));
      const found = keys
        .map((k) => [k, byKey.get(k)] as const)
        .filter((e): e is readonly [string, KeywordRow] => e[1] !== undefined);
      if (found.length === 0)
        throw new ChangeError("nothing_to_change", "Nothing to undo: those keywords are gone.");
      return {
        ops: found.map(([, k]) => ({
          adGroupCriterionOperation: {
            remove: compositeName(cid, "adGroupCriteria", g.id, k.criterionId),
          },
        })),
        readTarget: {
          resource: "ad_group_criterion",
          id: g.id,
          scope: { keys: found.map(([k]) => k).sort() },
        },
        touched: Object.fromEntries(found.map(([k, row]) => [k, row.status])),
        expected: Object.fromEntries(found.map(([k]) => [k, "absent"])),
        diff: [
          `Ad group ${g.id}: removes ${plural(found.length, "keyword")} added by the change being undone.`,
        ],
        affected: adGroupAffected(g),
        facts: {
          affectedCampaignIds: [g.campaignId],
          items: [{ kind: "keyword", created: 0, updated: 0, removed: found.length }],
        },
        warnings: [],
        undo: {
          supported: false,
          why: "This is an undo; propose the change again instead.",
          level: "none",
        },
        targetKeys: [`adGroups/${g.id}/keywords`],
      };
    }

    if (g.channel !== "SEARCH") {
      throw new ChangeError(
        "not_allowed",
        `Ad group ${g.id} is in a ${g.channel ?? "non-Search"} campaign; keywords are added to Search campaigns only.`,
      );
    }
    const defaults = ctx.defaults ?? SAFE_DEFAULTS;
    const smart = g.bidding !== null && SMART_BIDDING.has(g.bidding);
    const broad = input.keywords.filter((k) => k.match_type === "BROAD");
    if (broad.length && !smart && defaults.broadMatchRequiresSmartBidding) {
      throw new ChangeError(
        "not_allowed",
        `Refused: ${plural(broad.length, "BROAD keyword")} in campaign ${g.campaignId}, which bids with ${g.bidding ?? "unknown bidding"}, not smart bidding. The policy (defaults.broad_match_requires_smart_bidding) allows BROAD only with Target CPA, Target ROAS, Maximize conversions or Maximize conversion value. Use PHRASE or EXACT.`,
      );
    }
    const toAdd = input.keywords.filter((k) => !byKey.has(kwKey(g.id, k.match_type, k.text)));
    if (toAdd.length === 0) {
      throw new ChangeError(
        "nothing_to_change",
        "Nothing to change: every keyword is already in the ad group.",
      );
    }
    const status = defaults.newEntitiesPaused ? "PAUSED" : "ENABLED";
    const currency = ctx.account.currencyCode;
    const warnings: string[] = [];
    const ops: JsonObject[] = toAdd.map((k) => {
      const create: JsonObject = {
        adGroup: resourceName(cid, "adGroups", g.id),
        status,
        keyword: { text: k.text, matchType: k.match_type },
      };
      if (k.cpc_bid !== undefined) {
        const { micros } = amountToMicros(k.cpc_bid, currency);
        if (micros <= 0n) {
          throw new ChangeError(
            "invalid_input",
            `cpc_bid must be at least the currency's smallest unit.`,
          );
        }
        create.cpcBidMicros = micros.toString();
      }
      return { adGroupCriterionOperation: { create } };
    });
    const bids = toAdd.filter((k) => k.cpc_bid !== undefined);
    if (bids.length && smart) {
      warnings.push("This campaign uses smart bidding: Google ignores keyword max CPC bids there.");
    }
    const keys = toAdd.map((k) => kwKey(g.id, k.match_type, k.text));
    const skipped = input.keywords.length - toAdd.length;
    const counts = MATCH_TYPES.map(
      (m) => [m, toAdd.filter((k) => k.match_type === m).length] as const,
    )
      .filter(([, n]) => n > 0)
      .map(([m, n]) => `${n} ${m}`)
      .join(", ");
    const diff = [
      `Ad group ${g.id} (campaign ${g.campaignId}): adds ${plural(toAdd.length, "keyword")} (${counts})${skipped ? `; ${skipped} already there, skipped` : ""}.`,
      status === "PAUSED"
        ? "New keywords are created PAUSED (policy defaults.new_entities_paused): they don't show or spend until enabled."
        : "New keywords are created ENABLED: they can show and spend at once (policy defaults.new_entities_paused is false).",
      ...(bids.length
        ? [
            `Max CPC set on ${plural(bids.length, "keyword")}: ${unique(
              bids.map((k) =>
                formatMoney(amountToMicros(k.cpc_bid ?? "0", currency).micros, currency),
              ),
            ).join(", ")}.`,
          ]
        : []),
      `Bidding: ${g.bidding ?? "unknown"}${smart ? " (smart bidding)" : ""}.`,
    ];
    return {
      ops,
      readTarget: { resource: "ad_group_criterion", id: g.id, scope: { keys: [...keys].sort() } },
      touched: Object.fromEntries(keys.map((k) => [k, "absent"])),
      expected: Object.fromEntries(keys.map((k) => [k, status])),
      diff,
      affected: adGroupAffected(g),
      facts: {
        affectedCampaignIds: [g.campaignId],
        items: [{ kind: "keyword", created: toAdd.length, updated: 0, removed: 0 }],
        createdEnabled: status === "ENABLED" ? toAdd.length : 0,
        broadWithoutSmartBidding: smart ? 0 : toAdd.filter((k) => k.match_type === "BROAD").length,
      },
      warnings,
      undo: { supported: true, why: null, level: "full" },
      targetKeys: [`adGroups/${g.id}/keywords`],
      opKeys: keys.map((k) => [k]),
    };
  },

  readTouched: readKeywordKeys,
  fromMutateResults: () => null,

  undoInput(payload, before, readTarget) {
    return {
      ad_group_id: readTarget.id,
      undo_remove: Object.entries(before)
        .filter(([, v]) => v === "absent")
        .map(([k]) => parseKwKey(k))
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => ({ text: p.text, match_type: p.matchType })),
    };
  },

  historyWhere: keywordsHistory,

  modelTexts(input) {
    if ("undo_remove" in input) return [];
    return [
      {
        label: "Keywords (match type: text)",
        items: input.keywords.map((k) => `${k.match_type}: ${k.text}`),
      },
    ];
  },
};

// ---- pause_keyword ----

const pauseItem = z.object({ ad_group_id: idSchema, criterion_id: idSchema }).strict();

export const pauseKeywordInput = z
  .object({ keywords: z.array(pauseItem).min(1).max(KEYWORDS_MAX) })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.keywords.forEach((k, i) => {
      const key = `${k.ad_group_id}~${k.criterion_id}`;
      if (seen.has(key))
        ctx.addIssue({ code: "custom", path: ["keywords", i], message: "listed twice" });
      seen.add(key);
    });
  });

const pauseUndoInput = z
  .object({ undo_enable: z.array(pauseItem).min(1).max(KEYWORDS_MAX) })
  .strict();

export type PauseKeywordInput = z.infer<typeof pauseKeywordInput> | z.infer<typeof pauseUndoInput>;

const statusKey = (adGroupId: string, criterionId: string): string =>
  JSON.stringify(["kwstatus", adGroupId, criterionId]);

const parseStatusKey = (key: string): { ad_group_id: string; criterion_id: string } | null => {
  try {
    const v = JSON.parse(key) as unknown;
    if (
      Array.isArray(v) &&
      v[0] === "kwstatus" &&
      typeof v[1] === "string" &&
      typeof v[2] === "string"
    ) {
      return { ad_group_id: assertId(v[1]), criterion_id: assertId(v[2]) };
    }
  } catch {
    // not ours
  }
  return null;
};

interface CriterionState {
  adGroupId: string;
  adGroupName: string | null;
  campaignId: string;
  criterionId: string;
  status: string;
  negative: boolean;
  type: string;
}

const readCriteria = async (
  ctx: ReadCtx,
  items: readonly { ad_group_id: string; criterion_id: string }[],
): Promise<Map<string, CriterionState>> => {
  const rows = await gaql(
    ctx,
    `SELECT ad_group.id, ad_group.name, campaign.id, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.type FROM ad_group_criterion WHERE ad_group.id IN ${idList(unique(items.map((i) => i.ad_group_id)))} AND ad_group_criterion.criterion_id IN ${idList(unique(items.map((i) => i.criterion_id)))}`,
    "the keywords",
    items.length * items.length + 1,
  );
  const out = new Map<string, CriterionState>();
  for (const r of rows) {
    const c = asObject(r.adGroupCriterion);
    const g = asObject(r.adGroup);
    const s: CriterionState = {
      adGroupId: String(g.id ?? ""),
      adGroupName: asString(g.name) ?? null,
      campaignId: String(asObject(r.campaign).id ?? ""),
      criterionId: String(c.criterionId ?? ""),
      status: asString(c.status) ?? "",
      negative: c.negative === true,
      type: asString(c.type) ?? "",
    };
    out.set(statusKey(s.adGroupId, s.criterionId), s);
  }
  return out;
};

const planStatus = async (
  ctx: ReadCtx,
  items: readonly { ad_group_id: string; criterion_id: string }[],
  to: "PAUSED" | "ENABLED",
): Promise<Planned> => {
  const cid = ctx.target.customerId;
  const live = await readCriteria(ctx, items);
  const change: CriterionState[] = [];
  let already = 0;
  for (const i of items) {
    const s = live.get(statusKey(i.ad_group_id, i.criterion_id));
    if (!s || s.status === "REMOVED") {
      throw new ChangeError(
        "not_found",
        `Keyword ${i.ad_group_id}~${i.criterion_id} was not found (or is removed).`,
      );
    }
    if (s.type !== "KEYWORD" || s.negative) {
      throw new ChangeError(
        "not_allowed",
        `Criterion ${i.ad_group_id}~${i.criterion_id} is not a keyword.`,
      );
    }
    if (s.status === to) already++;
    else change.push(s);
  }
  if (change.length === 0) {
    throw new ChangeError(
      "nothing_to_change",
      `Nothing to change: every keyword is already ${to.toLowerCase()}.`,
    );
  }
  const keys = change.map((s) => statusKey(s.adGroupId, s.criterionId));
  const groups = unique(change.map((s) => s.adGroupId));
  const campaignIds = unique(change.map((s) => s.campaignId));
  return {
    ops: change.map((s) => ({
      adGroupCriterionOperation: {
        update: {
          resourceName: compositeName(cid, "adGroupCriteria", s.adGroupId, s.criterionId),
          status: to,
        },
        updateMask: "status",
      },
    })),
    readTarget: { resource: "ad_group_criterion", id: "status", scope: { items: keys.sort() } },
    touched: Object.fromEntries(
      change.map((s) => [statusKey(s.adGroupId, s.criterionId), s.status]),
    ),
    expected: Object.fromEntries(keys.map((k) => [k, to])),
    diff: [
      `${to === "PAUSED" ? "Pauses" : "Enables"} ${plural(change.length, "keyword")} in ${plural(groups.length, "ad group")} (${groups.join(", ")})${already ? `; ${already} already ${to.toLowerCase()}` : ""}.`,
      to === "PAUSED"
        ? "Paused keywords stop showing and spending until enabled again."
        : "Enabled keywords can show and spend again (undo of a pause).",
    ],
    affected: [
      ...groups.map((id) => ({
        kind: "ad_group" as const,
        id,
        name: change.find((s) => s.adGroupId === id)?.adGroupName ?? null,
        status: null,
      })),
      ...campaignIds.map((id) => ({ kind: "campaign" as const, id, name: null, status: null })),
    ],
    facts: {
      affectedCampaignIds: campaignIds,
      items: [{ kind: "keyword", created: 0, updated: change.length, removed: 0 }],
    },
    warnings: [],
    undo:
      to === "PAUSED"
        ? { supported: true, why: null, level: "full" }
        : {
            supported: false,
            why: "This is an undo; propose the change again instead.",
            level: "none",
          },
    targetKeys: change.map((s) => `adGroupCriteria/${s.adGroupId}~${s.criterionId}`),
  };
};

export const pauseKeyword: ActionType<PauseKeywordInput> = {
  type: "pause_keyword",
  summary: "Pause keywords (undo enables them again).",
  input: pauseKeywordInput as z.ZodType<PauseKeywordInput>,
  undoInputSchema: pauseUndoInput as z.ZodType<PauseKeywordInput>,
  independentOps: false,
  itemKeys: true,

  plan(ctx, input) {
    return "undo_enable" in input
      ? planStatus(ctx, input.undo_enable, "ENABLED")
      : planStatus(ctx, input.keywords, "PAUSED");
  },

  async readTouched(ctx, t) {
    const keys = Array.isArray(t.scope?.items)
      ? t.scope.items.filter((k): k is string => typeof k === "string")
      : [];
    const items = keys.map(parseStatusKey).filter((p): p is NonNullable<typeof p> => p !== null);
    if (items.length === 0) return {};
    const live = await readCriteria(ctx, items);
    return Object.fromEntries(keys.map((k) => [k, live.get(k)?.status ?? "absent"]));
  },

  fromMutateResults: () => null,

  undoInput(_payload, before) {
    return {
      undo_enable: Object.entries(before)
        .filter(([, v]) => v === "ENABLED")
        .map(([k]) => parseStatusKey(k))
        .filter((p): p is NonNullable<typeof p> => p !== null),
    };
  },

  historyWhere: (customerId, t) => {
    const keys = Array.isArray(t.scope?.items)
      ? t.scope.items.filter((k): k is string => typeof k === "string")
      : [];
    const groups = unique(
      keys
        .map(parseStatusKey)
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => p.ad_group_id),
    );
    if (groups.length === 0) return null;
    return `change_event.change_resource_type = 'AD_GROUP_CRITERION' AND change_event.ad_group IN (${groups
      .map((g) => `'${resourceName(customerId, "adGroups", g)}'`)
      .join(", ")})`;
  },
};
