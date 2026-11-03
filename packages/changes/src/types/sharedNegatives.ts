// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// add_shared_negatives: negative keywords in a shared negative keyword list (an existing
// one, or a new one), optionally put on campaigns. Ported from PerfoAds
// executeCreateSharedNegativeSet + executeAddSharedNegativeKeyword +
// executeLinkCampaignToSharedSet, as ONE atomic GoogleAdsService.Mutate with a temporary
// id for a new list. Every campaign the list is on gets the new negatives (listed on the
// approval page); a campaign that gets the list also gets every word already in it, so
// those are safety-checked too.
//
// Undo: a new list is removed (its words and links go with it); for an existing list the
// added words are removed and the new links taken off. The change history does not cover
// shared lists, so an unclear send stays unclear until read (no automatic "failed").

import { z } from "zod";
import { tempResourceName } from "@perfoads/ads-client";
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
import type { NegativeCandidate } from "../negatives/safety.js";
import type { ActionType, Planned, ReadCtx, ReadTarget, Touched } from "./actionType.js";
import {
  AFFECTED_MAX,
  compositeName,
  gaql,
  gaqlString,
  idSchema,
  plural,
  readCampaigns,
  resourceName,
  unique,
} from "./common.js";
import { normKeyword, tidy } from "./text.js";

export const SHARED_NEGATIVES_MAX = 200;
export const SHARED_LINKS_MAX = 50;
/** A list holds at most 5,000 words (Google); read up to this many. */
const MEMBERS_MAX = 5_000;

const listName = z.string().transform((raw, ctx) => {
  const text = tidy(raw);
  if (
    !text ||
    text.length > 255 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(text)
  ) {
    ctx.addIssue({ code: "custom", message: "must be 1-255 plain characters" });
    return z.NEVER;
  }
  return text;
});

export const addSharedNegativesInput = z
  .object({
    shared_set_id: idSchema.optional().describe("An existing negative keyword list"),
    new_list_name: listName.optional().describe("Or: make a new list with this name"),
    negatives: z.array(negativeInput).max(SHARED_NEGATIVES_MAX).default([]),
    link_campaign_ids: z
      .array(idSchema)
      .max(SHARED_LINKS_MAX)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length, "a campaign is listed twice")
      .describe("Campaigns that get the list"),
    override_blocked_conversions: overrideInput,
    brand_terms: brandTermsInput,
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.shared_set_id === undefined) === (v.new_list_name === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "give exactly one of shared_set_id or new_list_name",
      });
    }
    if (v.negatives.length === 0 && v.link_campaign_ids.length === 0) {
      ctx.addIssue({ code: "custom", message: "add negatives, link campaigns, or both" });
    }
    if (v.new_list_name !== undefined && v.negatives.length === 0) {
      ctx.addIssue({ code: "custom", path: ["negatives"], message: "a new list needs negatives" });
    }
    const seen = new Set<string>();
    v.negatives.forEach((n, i) => {
      const k = `${n.match_type}|${normKeyword(n.text)}`;
      if (seen.has(k))
        ctx.addIssue({ code: "custom", path: ["negatives", i], message: "listed twice" });
      seen.add(k);
    });
  });

const undoInput = z
  .object({
    undo: z
      .object({
        new_list_name: z.string().min(1).max(255).optional(),
        /** New list: every key the change made; anything else in the list now = stale. */
        expect: z
          .array(z.string().max(400))
          .max(SHARED_NEGATIVES_MAX + SHARED_LINKS_MAX + 1)
          .optional(),
        shared_set_id: idSchema.optional(),
        remove: z
          .array(
            z
              .object({ text: z.string().min(1).max(200), match_type: z.enum(MATCH_TYPES) })
              .strict(),
          )
          .max(SHARED_NEGATIVES_MAX)
          .default([]),
        unlink_campaign_ids: z.array(idSchema).max(SHARED_LINKS_MAX).default([]),
      })
      .strict(),
  })
  .strict();

export type AddSharedNegativesInput =
  z.infer<typeof addSharedNegativesInput> | z.infer<typeof undoInput>;

interface ListState {
  id: string;
  name: string | null;
  members: { criterionId: string; text: string; matchType: string }[];
  /** Campaigns the list is on (ENABLED links). */
  campaigns: { id: string; name: string | null; status: string | null }[];
  /** Campaigns the list is on that are Performance Max. */
  pmaxCampaignIds: string[];
}

const readListById = async (
  ctx: ReadCtx,
  id: string,
): Promise<{ name: string | null; type: string | null; status: string | null } | null> => {
  const rows = await gaql(
    ctx,
    `SELECT shared_set.id, shared_set.name, shared_set.type, shared_set.status FROM shared_set WHERE shared_set.id = ${id} LIMIT 1`,
    "the negative keyword list",
  );
  if (!rows[0]) return null;
  const s = asObject(rows[0].sharedSet);
  return {
    name: asString(s.name) ?? null,
    type: asString(s.type) ?? null,
    status: asString(s.status) ?? null,
  };
};

/** Enabled negative keyword lists with this exact name. */
const listsNamed = async (ctx: ReadCtx, name: string): Promise<string[]> => {
  const rows = await gaql(
    ctx,
    `SELECT shared_set.id FROM shared_set WHERE shared_set.name = ${gaqlString(name)} AND shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED' LIMIT 3`,
    "the negative keyword lists",
    3,
  );
  return rows.map((r) => String(asObject(r.sharedSet).id ?? "")).filter(Boolean);
};

const readListState = async (ctx: ReadCtx, id: string): Promise<ListState> => {
  const info = await readListById(ctx, id);
  const memberRows = await gaql(
    ctx,
    `SELECT shared_criterion.criterion_id, shared_criterion.keyword.text, shared_criterion.keyword.match_type FROM shared_criterion WHERE shared_set.id = ${id} AND shared_criterion.type = 'KEYWORD' LIMIT ${MEMBERS_MAX + 1}`,
    "the list's negative keywords",
    MEMBERS_MAX + 1,
  );
  if (memberRows.length > MEMBERS_MAX) {
    throw new ChangeError(
      "not_allowed",
      `The list holds more than ${MEMBERS_MAX} words; change it in Google Ads.`,
    );
  }
  const linkRows = await gaql(
    ctx,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign_shared_set WHERE shared_set.id = ${id} AND campaign_shared_set.status = 'ENABLED' AND campaign.status != 'REMOVED' ORDER BY campaign.id LIMIT ${AFFECTED_MAX + 1}`,
    "the campaigns the list is on",
    AFFECTED_MAX + 1,
  );
  if (linkRows.length > AFFECTED_MAX) {
    throw new ChangeError(
      "not_allowed",
      `The list is on more than ${AFFECTED_MAX} campaigns, too many to show them all; change it in Google Ads.`,
    );
  }
  return {
    id,
    name: info?.name ?? null,
    members: memberRows.map((r) => {
      const c = asObject(r.sharedCriterion);
      const kw = asObject(c.keyword);
      return {
        criterionId: String(c.criterionId ?? ""),
        text: asString(kw.text) ?? "",
        matchType: asString(kw.matchType) ?? "",
      };
    }),
    campaigns: linkRows.map((r) => {
      const c = asObject(r.campaign);
      return {
        id: String(c.id ?? ""),
        name: asString(c.name) ?? null,
        status: asString(c.status) ?? null,
      };
    }),
    pmaxCampaignIds: linkRows
      .map((r) => asObject(r.campaign))
      .filter((c) => c.advertisingChannelType === "PERFORMANCE_MAX")
      .map((c) => String(c.id ?? "")),
  };
};

/** The list label inside keys: "set:<id>" or "new:<name>". */
const setLabel = (input: {
  shared_set_id?: string | undefined;
  new_list_name?: string | undefined;
}): string =>
  input.shared_set_id !== undefined
    ? `set:${input.shared_set_id}`
    : `new:${input.new_list_name ?? ""}`;

const linkKey = (label: string, campaignId: string): string =>
  JSON.stringify(["link", label, campaignId]);
const listKey = (label: string): string => JSON.stringify(["list", label]);

const parseLinkKey = (key: string): string | null => {
  try {
    const v = JSON.parse(key) as unknown;
    return Array.isArray(v) && v[0] === "link" && typeof v[2] === "string" ? v[2] : null;
  } catch {
    return null;
  }
};

/** Live state of every key in the scope (list gone = everything absent). */
const readShared = async (ctx: ReadCtx, t: ReadTarget): Promise<Touched> => {
  const scope = t.scope ?? {};
  const keys = Array.isArray(scope.keys)
    ? scope.keys.filter((k): k is string => typeof k === "string")
    : [];
  const label = typeof scope.label === "string" ? scope.label : "";
  let id: string | null = null;
  if (label.startsWith("set:")) {
    const info = await readListById(ctx, label.slice(4));
    id = info && info.status === "ENABLED" ? label.slice(4) : null;
  } else {
    const found = await listsNamed(ctx, label.slice(4));
    if (found.length > 1) {
      throw new ChangeError(
        "read_failed",
        "More than one list has this name; can't tell which one is ours.",
      );
    }
    id = found[0] ?? null;
  }
  const present = new Set<string>();
  if (id) {
    const state = await readListState(ctx, id);
    present.add(listKey(label));
    for (const m of state.members) present.add(negKey(label, m.matchType, m.text));
    for (const c of state.campaigns) present.add(linkKey(label, c.id));
  }
  return Object.fromEntries(keys.map((k) => [k, present.has(k) ? "present" : "absent"]));
};

const planForward = async (
  ctx: ReadCtx,
  input: z.infer<typeof addSharedNegativesInput>,
): Promise<Planned> => {
  const cid = ctx.target.customerId;
  const label = setLabel(input);
  let state: ListState | null = null;
  if (input.shared_set_id !== undefined) {
    const info = await readListById(ctx, input.shared_set_id);
    if (!info)
      throw new ChangeError(
        "not_found",
        `Negative keyword list ${input.shared_set_id} was not found.`,
      );
    if (info.type !== "NEGATIVE_KEYWORDS") {
      throw new ChangeError(
        "not_allowed",
        `Shared set ${input.shared_set_id} is not a negative keyword list.`,
      );
    }
    if (info.status !== "ENABLED") {
      throw new ChangeError(
        "not_allowed",
        `Negative keyword list ${input.shared_set_id} is removed.`,
      );
    }
    state = await readListState(ctx, input.shared_set_id);
  } else if ((await listsNamed(ctx, input.new_list_name ?? "")).length > 0) {
    throw new ChangeError(
      "not_allowed",
      "A negative keyword list with this name already exists. Pass its shared_set_id to add to it, or pick another name.",
    );
  }
  const memberKeys = new Set((state?.members ?? []).map((m) => negKey(label, m.matchType, m.text)));
  const newNegs = input.negatives.filter(
    (n) => !memberKeys.has(negKey(label, n.match_type, n.text)),
  );
  const onList = new Set((state?.campaigns ?? []).map((c) => c.id));
  const newLinks = input.link_campaign_ids.filter((id) => !onList.has(id));
  const linked = newLinks.length ? await readCampaigns(ctx, newLinks) : new Map();
  if (newNegs.length === 0 && newLinks.length === 0) {
    throw new ChangeError(
      "nothing_to_change",
      "Nothing to change: the words are already in the list and the campaigns already have it.",
    );
  }
  // New words, and (for campaigns that get the list) the words already in it.
  const candidates: NegativeCandidate[] = [
    ...new Map(
      [
        ...newNegs.map((n) => ({ text: n.text, matchType: n.match_type })),
        ...(newLinks.length
          ? (state?.members ?? [])
              .filter((m) => (MATCH_TYPES as readonly string[]).includes(m.matchType))
              .map((m) => ({
                text: m.text,
                matchType: m.matchType as NegativeCandidate["matchType"],
              }))
          : []),
      ].map((c) => [`${c.matchType}|${normKeyword(c.text)}`, c]),
    ).values(),
  ];
  const outcome = await negativesGate(ctx, candidates, {
    override: input.override_blocked_conversions === true,
    brandTerms: input.brand_terms,
    reachesPmax:
      (state?.pmaxCampaignIds.length ?? 0) > 0 ||
      newLinks.some((id) => linked.get(id)?.channel === "PERFORMANCE_MAX"),
  });

  const setName =
    input.shared_set_id !== undefined
      ? resourceName(cid, "sharedSets", input.shared_set_id)
      : tempResourceName(cid, "sharedSets", -1);
  const ops: JsonObject[] = [];
  if (input.new_list_name !== undefined) {
    ops.push({
      sharedSetOperation: {
        create: { resourceName: setName, name: input.new_list_name, type: "NEGATIVE_KEYWORDS" },
      },
    });
  }
  for (const n of newNegs) {
    ops.push({
      sharedCriterionOperation: {
        create: { sharedSet: setName, keyword: { text: n.text, matchType: n.match_type } },
      },
    });
  }
  for (const id of newLinks) {
    ops.push({
      campaignSharedSetOperation: {
        create: { campaign: resourceName(cid, "campaigns", id), sharedSet: setName },
      },
    });
  }
  const keys = [
    ...(input.new_list_name !== undefined ? [listKey(label)] : []),
    ...newNegs.map((n) => negKey(label, n.match_type, n.text)),
    ...newLinks.map((id) => linkKey(label, id)),
  ];
  const reached = [
    ...(state?.campaigns ?? []),
    ...newLinks.map((id) => ({
      id,
      name: linked.get(id)?.name ?? null,
      status: linked.get(id)?.status ?? null,
    })),
  ];
  const diff: string[] = [];
  if (input.new_list_name !== undefined) {
    diff.push(
      `Makes a new negative keyword list with ${plural(newNegs.length, "negative keyword")} (its name is in the box below).`,
    );
  } else {
    const skipped = input.negatives.length - newNegs.length;
    diff.push(
      `Negative keyword list ${input.shared_set_id}: adds ${plural(newNegs.length, "negative keyword")}${skipped ? ` (${skipped} already in it, skipped)` : ""}.`,
    );
    if (state && state.campaigns.length && newNegs.length) {
      diff.push(
        `The list is on ${plural(state.campaigns.length, "campaign")}: every one of them gets the new negatives.`,
      );
    }
  }
  if (newLinks.length) {
    diff.push(
      `Puts the list on ${plural(newLinks.length, "campaign")} (${newLinks.join(", ")})${state?.members.length ? `; they also get the ${plural(state.members.length, "word")} already in it` : ""}.`,
    );
  }
  diff.push(
    "Negative keywords stop ads from showing for matching searches; they add no spend. Checked against your brand terms and searches and keywords with conversions in the last 90 days.",
  );
  const affected: Planned["affected"] = [
    ...(input.shared_set_id !== undefined
      ? [
          {
            kind: "shared_set" as const,
            id: input.shared_set_id,
            name: state?.name ?? null,
            status: "ENABLED",
          },
        ]
      : []),
    ...reached.map((c) => ({
      kind: "campaign" as const,
      id: c.id,
      name: c.name,
      status: c.status,
    })),
  ];
  return {
    ops,
    readTarget: { resource: "shared_set", id: label, scope: { label, keys: [...keys].sort() } },
    touched: Object.fromEntries(keys.map((k) => [k, "absent"])),
    expected: Object.fromEntries(keys.map((k) => [k, "present"])),
    diff,
    affected,
    facts: {
      affectedCampaignIds: reached.map((c) => c.id),
      items: [
        ...(input.new_list_name !== undefined
          ? [{ kind: "shared_set", created: 1, updated: 0, removed: 0 }]
          : []),
        { kind: "shared_negative_keyword", created: newNegs.length, updated: 0, removed: 0 },
        { kind: "campaign_shared_set", created: newLinks.length, updated: 0, removed: 0 },
      ],
      ...(outcome.blocked ? { blockedConversions: outcome.blocked } : {}),
    },
    warnings: outcome.warnings,
    undo: {
      supported: true,
      why: null,
      level: "full",
    },
    targetKeys: [`sharedSets/${label}`, ...newLinks.map((id) => `campaigns/${id}/sharedSets`)],
  };
};

const planUndo = async (ctx: ReadCtx, u: z.infer<typeof undoInput>["undo"]): Promise<Planned> => {
  const cid = ctx.target.customerId;
  const label = setLabel(u);
  let id: string | null = u.shared_set_id ?? null;
  if (u.new_list_name !== undefined) {
    const found = await listsNamed(ctx, u.new_list_name);
    if (found.length > 1) {
      throw new ChangeError(
        "undo_unavailable",
        "More than one list has this name now; remove it in Google Ads.",
      );
    }
    id = found[0] ?? null;
  }
  if (!id) throw new ChangeError("nothing_to_change", "Nothing to undo: the list is gone.");
  const state = await readListState(ctx, id);
  const ops: JsonObject[] = [];
  const keys: string[] = [];
  const diff: string[] = [];
  if (u.new_list_name !== undefined) {
    // Google refuses removing a list a campaign still uses: the links go first, same request.
    for (const c of state.campaigns) {
      ops.push({
        campaignSharedSetOperation: { remove: compositeName(cid, "campaignSharedSets", c.id, id) },
      });
    }
    ops.push({ sharedSetOperation: { remove: resourceName(cid, "sharedSets", id) } });
    keys.push(listKey(label));
    for (const m of state.members) keys.push(negKey(label, m.matchType, m.text));
    for (const c of state.campaigns) keys.push(linkKey(label, c.id));
    const expect = new Set(u.expect ?? []);
    if (keys.some((k) => !expect.has(k))) {
      throw new ChangeError(
        "undo_stale",
        "The list was changed after this change (words or campaigns added), so removing it would undo that too. Nothing was proposed; change it in Google Ads.",
      );
    }
    diff.push(
      `Removes negative keyword list ${id} (made by the change being undone), with its ${plural(state.members.length, "word")}, from ${plural(state.campaigns.length, "campaign")}.`,
    );
  } else {
    const wanted = new Set(u.remove.map((r) => negKey(label, r.match_type, r.text)));
    for (const m of state.members) {
      const k = negKey(label, m.matchType, m.text);
      if (!wanted.has(k)) continue;
      ops.push({
        sharedCriterionOperation: {
          remove: compositeName(cid, "sharedCriteria", id, m.criterionId),
        },
      });
      keys.push(k);
    }
    const on = new Set(state.campaigns.map((c) => c.id));
    for (const c of u.unlink_campaign_ids) {
      if (!on.has(c)) continue;
      ops.push({
        campaignSharedSetOperation: { remove: compositeName(cid, "campaignSharedSets", c, id) },
      });
      keys.push(linkKey(label, c));
    }
    if (ops.length === 0)
      throw new ChangeError(
        "nothing_to_change",
        "Nothing to undo: those words and links are gone.",
      );
    diff.push(
      `Negative keyword list ${id}: removes ${plural(u.remove.length, "negative keyword")} and takes it off ${plural(u.unlink_campaign_ids.filter((c) => on.has(c)).length, "campaign")} (undo).`,
    );
  }
  const uniq = unique(keys);
  return {
    ops,
    readTarget: { resource: "shared_set", id: label, scope: { label, keys: [...uniq].sort() } },
    touched: Object.fromEntries(uniq.map((k) => [k, "present"])),
    expected: Object.fromEntries(uniq.map((k) => [k, "absent"])),
    diff,
    affected: [
      { kind: "shared_set", id, name: state.name, status: "ENABLED" },
      ...state.campaigns.map((c) => ({ kind: "campaign" as const, ...c })),
    ],
    facts: {
      affectedCampaignIds: state.campaigns.map((c) => c.id),
      items: [{ kind: "shared_negative_keyword", created: 0, updated: 0, removed: ops.length }],
    },
    warnings: [],
    undo: {
      supported: false,
      why: "This is an undo; propose the change again instead.",
      level: "none",
    },
    targetKeys: [
      `sharedSets/${label}`,
      ...u.unlink_campaign_ids.map((c) => `campaigns/${c}/sharedSets`),
    ],
  };
};

export const addSharedNegatives: ActionType<AddSharedNegativesInput> = {
  type: "add_shared_negatives",
  summary:
    "Add negative keywords to a shared list (existing or new) and/or put it on campaigns, in one atomic change.",
  input: addSharedNegativesInput as unknown as z.ZodType<AddSharedNegativesInput>,
  undoInputSchema: undoInput as unknown as z.ZodType<AddSharedNegativesInput>,
  independentOps: false,
  itemKeys: true,

  async plan(ctx, input) {
    if ("undo" in input) return planUndo(ctx, input.undo);
    return planForward(ctx, input);
  },

  readTouched: readShared,
  fromMutateResults: () => null,

  undoInput(payload, before) {
    if ("undo" in payload) return null;
    if (payload.new_list_name !== undefined) {
      return { undo: { new_list_name: payload.new_list_name, expect: Object.keys(before).sort() } };
    }
    const remove = Object.entries(before)
      .filter(([, v]) => v === "absent")
      .map(([k]) => parseNegKey(k))
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => ({ text: p.text, match_type: p.matchType }));
    const unlink = Object.entries(before)
      .filter(([, v]) => v === "absent")
      .map(([k]) => parseLinkKey(k))
      .filter((c): c is string => c !== null);
    return { undo: { shared_set_id: payload.shared_set_id, remove, unlink_campaign_ids: unlink } };
  },

  // change_event does not cover shared sets: an unclear send stays unclear until read.
  historyWhere: () => null,

  modelTexts(input) {
    if ("undo" in input) return [];
    return [
      ...(input.new_list_name !== undefined
        ? [{ label: "New list name", items: [input.new_list_name] }]
        : []),
      ...(input.negatives.length
        ? [
            {
              label: "Negative keywords (match type: text)",
              items: input.negatives.map((n) => `${n.match_type}: ${n.text}`),
            },
          ]
        : []),
      ...(input.brand_terms?.length
        ? [{ label: "Brand terms given", items: input.brand_terms }]
        : []),
    ];
  },
};
