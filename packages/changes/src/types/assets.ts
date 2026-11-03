// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// add_sitelinks / add_callouts: new sitelink or callout assets, linked to one campaign, in
// ONE atomic GoogleAdsService.Mutate (each asset made with a temporary id, then linked).
// Ported from PerfoAds executeCreateAsset + executeLinkCampaignAsset. Undo takes the links
// off the campaign; the assets stay in the account's asset library (Google keeps assets),
// so undo is declared partial.

import { z } from "zod";
import { tempResourceName } from "@perfoads/ads-client";
import { ChangeError } from "../errors.js";
import { asObject, asString, type JsonObject } from "../json.js";
import type { ActionType, Planned, ReadCtx, ReadTarget, Touched } from "./actionType.js";
import { assertId, gaql, idSchema, plural, readCampaigns, resourceName } from "./common.js";
import { adTextSchema, comparableUrl, finalUrlSchema } from "./text.js";

/** Google: at most 20 sitelinks / callouts on one campaign. */
export const CAMPAIGN_ASSETS_MAX = 20;

type Kind = "SITELINK" | "CALLOUT";

const UNDO_WHY =
  "Undo takes the new links off the campaign; the assets themselves stay in the account's asset library (Google does not delete assets).";

export const addSitelinksInput = z
  .object({
    campaign_id: idSchema,
    sitelinks: z
      .array(
        z
          .object({
            link_text: adTextSchema(25),
            description1: adTextSchema(35).optional(),
            description2: adTextSchema(35).optional(),
            final_url: finalUrlSchema,
          })
          .strict()
          .refine((s) => (s.description1 === undefined) === (s.description2 === undefined), {
            message: "give both descriptions or neither",
          }),
      )
      .min(1)
      .max(CAMPAIGN_ASSETS_MAX),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.sitelinks.forEach((s, i) => {
      const k = s.link_text.toLowerCase();
      if (seen.has(k))
        ctx.addIssue({
          code: "custom",
          path: ["sitelinks", i],
          message: "the same link text twice",
        });
      seen.add(k);
    });
  });

export const addCalloutsInput = z
  .object({
    campaign_id: idSchema,
    callouts: z
      .array(z.object({ text: adTextSchema(25) }).strict())
      .min(1)
      .max(CAMPAIGN_ASSETS_MAX),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.callouts.forEach((c, i) => {
      const k = c.text.toLowerCase();
      if (seen.has(k))
        ctx.addIssue({ code: "custom", path: ["callouts", i], message: "the same text twice" });
      seen.add(k);
    });
  });

const CAMPAIGN_ASSET_NAME = /^customers\/(\d{10})\/campaignAssets\/(\d+)~(\d+)~(SITELINK|CALLOUT)$/;

const unlinkInput = z
  .object({
    campaign_id: idSchema,
    /** Resource names of the campaign links the change made (from Google's reply). */
    undo_unlink: z.array(z.string().regex(CAMPAIGN_ASSET_NAME)).min(1).max(CAMPAIGN_ASSETS_MAX),
  })
  .strict();

export type AddSitelinksInput = z.infer<typeof addSitelinksInput> | z.infer<typeof unlinkInput>;
export type AddCalloutsInput = z.infer<typeof addCalloutsInput> | z.infer<typeof unlinkInput>;

interface Linked {
  resourceName: string;
  text: string;
  /** What the person sees: text (+ descriptions and final URLs for sitelinks), canonical JSON. */
  content: string;
}

/** Canonical content of one sitelink / callout (compared exactly, and read back). */
const contentOf = (
  kind: Kind,
  text: string,
  d1?: string | null,
  d2?: string | null,
  urls?: readonly string[] | null,
): string =>
  JSON.stringify(
    kind === "SITELINK" ? [text, d1 ?? "", d2 ?? "", (urls ?? []).map(comparableUrl)] : [text],
  );

/** Live links of this kind on the campaign (not removed), with their visible text. */
const readLinked = async (ctx: ReadCtx, campaignId: string, kind: Kind): Promise<Linked[]> => {
  const textField =
    kind === "SITELINK"
      ? "asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2, asset.final_urls"
      : "asset.callout_asset.callout_text";
  const rows = await gaql(
    ctx,
    `SELECT campaign.id, campaign_asset.resource_name, campaign_asset.status, asset.id, ${textField} FROM campaign_asset WHERE campaign.id = ${assertId(campaignId)} AND campaign_asset.field_type = '${kind}' AND campaign_asset.status != 'REMOVED' LIMIT 1000`,
    `the campaign's ${kind === "SITELINK" ? "sitelinks" : "callouts"}`,
    1000,
  );
  return rows.map((r) => {
    const a = asObject(r.asset);
    const sl = asObject(a.sitelinkAsset);
    const text =
      (kind === "SITELINK"
        ? asString(sl.linkText)
        : asString(asObject(a.calloutAsset).calloutText)) ?? "";
    const urls = Array.isArray(a.finalUrls) ? a.finalUrls.map(String) : [];
    return {
      resourceName: asString(asObject(r.campaignAsset).resourceName) ?? "",
      text,
      content: contentOf(kind, text, asString(sl.description1), asString(sl.description2), urls),
    };
  });
};

/** ["asset", <campaign>, <kind>, <lower-case text>] */
const assetKey = (campaignId: string, kind: Kind, text: string): string =>
  JSON.stringify(["asset", campaignId, kind, text.trim().toLowerCase()]);

interface NewAsset {
  text: string;
  content: string;
  asset: JsonObject;
}

const planLinks = async (
  ctx: ReadCtx,
  kind: Kind,
  campaignId: string,
  items: readonly NewAsset[],
): Promise<Planned> => {
  const cid = ctx.target.customerId;
  const campaigns = await readCampaigns(ctx, [campaignId]);
  const c = campaigns.get(campaignId);
  const linked = await readLinked(ctx, campaignId, kind);
  const word = kind === "SITELINK" ? "sitelink" : "callout";
  const there = new Map<string, Linked[]>();
  for (const l of linked) {
    const k = assetKey(campaignId, kind, l.text);
    there.set(k, [...(there.get(k) ?? []), l]);
  }
  // Already there = same text AND same URL and descriptions. Same text, other content:
  // refused (two sitelinks with one text would be ambiguous to the person and to undo).
  for (const i of items) {
    const same = there.get(assetKey(campaignId, kind, i.text)) ?? [];
    if (same.length && !same.some((l) => l.content === i.content)) {
      throw new ChangeError(
        "not_allowed",
        kind === "SITELINK"
          ? `A sitelink with the text ${JSON.stringify(i.text)} already exists on campaign ${campaignId} with a different URL or descriptions. Nothing was proposed; change or remove that one in Google Ads, or use another text.`
          : `A callout ${JSON.stringify(i.text)} already exists on campaign ${campaignId} written differently. Nothing was proposed.`,
      );
    }
  }
  const toAdd = items.filter((i) => !there.has(assetKey(campaignId, kind, i.text)));
  if (toAdd.length === 0) {
    throw new ChangeError(
      "nothing_to_change",
      `Nothing to change: every ${word} is already on campaign ${campaignId}.`,
    );
  }
  if (linked.length + toAdd.length > CAMPAIGN_ASSETS_MAX) {
    throw new ChangeError(
      "not_allowed",
      `Campaign ${campaignId} has ${plural(linked.length, word)}; adding ${toAdd.length} would pass Google's limit of ${CAMPAIGN_ASSETS_MAX}.`,
    );
  }
  const ops: JsonObject[] = [];
  toAdd.forEach((item, i) => {
    const temp = tempResourceName(cid, "assets", -(i + 1));
    ops.push({ assetOperation: { create: { resourceName: temp, ...item.asset } } });
    ops.push({
      campaignAssetOperation: {
        create: {
          campaign: resourceName(cid, "campaigns", campaignId),
          asset: temp,
          fieldType: kind,
        },
      },
    });
  });
  const keys = toAdd.map((i) => assetKey(campaignId, kind, i.text));
  const skipped = items.length - toAdd.length;
  return {
    ops,
    readTarget: {
      resource: "campaign_asset",
      id: campaignId,
      scope: { kind, keys: [...keys].sort() },
    },
    touched: Object.fromEntries(keys.map((k) => [k, "absent"])),
    expected: Object.fromEntries(toAdd.map((i) => [assetKey(campaignId, kind, i.text), i.content])),
    diff: [
      `Campaign ${campaignId}: makes ${plural(toAdd.length, `new ${word} asset`)} and links ${toAdd.length === 1 ? "it" : "them"} to the campaign${skipped ? ` (${skipped} already there, skipped)` : ""}. Texts are in the box below, exactly as sent.`,
      `It will have ${linked.length + toAdd.length} of at most ${CAMPAIGN_ASSETS_MAX} ${word}s. Assets add no spend.`,
    ],
    affected: [
      { kind: "campaign", id: campaignId, name: c?.name ?? null, status: c?.status ?? null },
    ],
    facts: {
      affectedCampaignIds: [campaignId],
      items: [
        { kind: "asset", created: toAdd.length, updated: 0, removed: 0 },
        { kind: "campaign_asset", created: toAdd.length, updated: 0, removed: 0 },
      ],
    },
    warnings: [],
    undo: { supported: true, why: UNDO_WHY, level: "partial" },
    targetKeys: [`campaigns/${campaignId}/assets/${kind}`],
  };
};

/** Undo: unlinks exactly the links the change made (resource names from Google's reply). */
const planUnlink = async (
  ctx: ReadCtx,
  kind: Kind,
  campaignId: string,
  names: readonly string[],
): Promise<Planned> => {
  const linked = await readLinked(ctx, campaignId, kind);
  const byName = new Map(linked.map((l) => [l.resourceName, l]));
  const found = names.map((n) => byName.get(n)).filter((l): l is Linked => l !== undefined);
  if (found.length === 0)
    throw new ChangeError("nothing_to_change", "Nothing to undo: those links are gone.");
  const keys = [...new Set(found.map((l) => assetKey(campaignId, kind, l.text)))];
  // Another live link with one of these texts: the read-back by text would be ambiguous.
  const others = linked.filter(
    (l) => !names.includes(l.resourceName) && keys.includes(assetKey(campaignId, kind, l.text)),
  );
  if (others.length) {
    throw new ChangeError(
      "undo_stale",
      "Another link with the same text was added after this change, so undo can't be checked safely. Nothing was proposed; unlink it in Google Ads.",
    );
  }
  return {
    ops: found.map((l) => ({ campaignAssetOperation: { remove: l.resourceName } })),
    readTarget: {
      resource: "campaign_asset",
      id: campaignId,
      scope: { kind, keys: [...keys].sort() },
    },
    touched: Object.fromEntries(found.map((l) => [assetKey(campaignId, kind, l.text), l.content])),
    expected: Object.fromEntries(keys.map((k) => [k, "absent"])),
    diff: [
      `Campaign ${campaignId}: takes ${plural(found.length, kind === "SITELINK" ? "sitelink" : "callout")} off the campaign (undo: exactly the links the change made). The assets stay in the asset library.`,
    ],
    affected: [{ kind: "campaign", id: campaignId, name: null, status: null }],
    facts: {
      affectedCampaignIds: [campaignId],
      items: [{ kind: "campaign_asset", created: 0, updated: 0, removed: found.length }],
    },
    warnings: [],
    undo: {
      supported: false,
      why: "This is an undo; propose the change again instead.",
      level: "none",
    },
    targetKeys: [`campaigns/${campaignId}/assets/${kind}`],
  };
};

const readAssetKeys = async (ctx: ReadCtx, t: ReadTarget): Promise<Touched> => {
  const kind = t.scope?.kind === "CALLOUT" ? "CALLOUT" : "SITELINK";
  const keys = Array.isArray(t.scope?.keys)
    ? t.scope.keys.filter((k): k is string => typeof k === "string")
    : [];
  const content = new Map(
    (await readLinked(ctx, t.id, kind)).map((l) => [assetKey(t.id, kind, l.text), l.content]),
  );
  return Object.fromEntries(keys.map((k) => [k, content.get(k) ?? "absent"]));
};

const assetsHistory = (customerId: string, t: ReadTarget): string =>
  `change_event.change_resource_type = 'CAMPAIGN_ASSET' AND change_event.campaign = '${resourceName(customerId, "campaigns", t.id)}'`;

/** The campaign links the change made, from Google's reply (never found by text). */
const linkNames = (
  campaignId: string,
  results: readonly { ok: boolean; resourceName: string | null }[] | null | undefined,
): string[] => {
  const names = (results ?? [])
    .filter((r) => r.ok && r.resourceName)
    .map((r) => r.resourceName ?? "")
    .filter((n) => CAMPAIGN_ASSET_NAME.exec(n)?.[2] === campaignId);
  if (names.length === 0) {
    throw new ChangeError(
      "undo_unavailable",
      "Google's reply with the new links' names was not recorded (the answer was unclear), so undo can't tell which links to take off. Unlink them in Google Ads.",
    );
  }
  return names;
};

export const addSitelinks: ActionType<AddSitelinksInput> = {
  type: "add_sitelinks",
  summary:
    "Make sitelink assets and link them to one campaign (undo unlinks; assets stay in the library).",
  input: addSitelinksInput as z.ZodType<AddSitelinksInput>,
  undoInputSchema: unlinkInput as z.ZodType<AddSitelinksInput>,
  independentOps: false,
  itemKeys: true,

  plan(ctx, input) {
    if ("undo_unlink" in input)
      return planUnlink(ctx, "SITELINK", input.campaign_id, input.undo_unlink);
    return planLinks(
      ctx,
      "SITELINK",
      input.campaign_id,
      input.sitelinks.map((s) => ({
        text: s.link_text,
        content: contentOf("SITELINK", s.link_text, s.description1, s.description2, [s.final_url]),
        asset: {
          finalUrls: [s.final_url],
          sitelinkAsset: {
            linkText: s.link_text,
            ...(s.description1 !== undefined
              ? { description1: s.description1, description2: s.description2 }
              : {}),
          },
        },
      })),
    );
  },

  readTouched: readAssetKeys,
  fromMutateResults: () => null,
  undoInput: (payload, _before, _readTarget, results) => ({
    campaign_id: payload.campaign_id,
    undo_unlink: linkNames(payload.campaign_id, results),
  }),
  historyWhere: assetsHistory,

  modelTexts(input) {
    if ("undo_unlink" in input) return [];
    return [
      {
        label: "Sitelinks (link text | description 1 | description 2 | final URL)",
        items: input.sitelinks.map((s) =>
          [s.link_text, s.description1 ?? "", s.description2 ?? "", s.final_url].join(" | "),
        ),
      },
    ];
  },
};

export const addCallouts: ActionType<AddCalloutsInput> = {
  type: "add_callouts",
  summary:
    "Make callout assets and link them to one campaign (undo unlinks; assets stay in the library).",
  input: addCalloutsInput as z.ZodType<AddCalloutsInput>,
  undoInputSchema: unlinkInput as z.ZodType<AddCalloutsInput>,
  independentOps: false,
  itemKeys: true,

  plan(ctx, input) {
    if ("undo_unlink" in input)
      return planUnlink(ctx, "CALLOUT", input.campaign_id, input.undo_unlink);
    return planLinks(
      ctx,
      "CALLOUT",
      input.campaign_id,
      input.callouts.map((c) => ({
        text: c.text,
        content: contentOf("CALLOUT", c.text),
        asset: { calloutAsset: { calloutText: c.text } },
      })),
    );
  },

  readTouched: readAssetKeys,
  fromMutateResults: () => null,
  undoInput: (payload, _before, _readTarget, results) => ({
    campaign_id: payload.campaign_id,
    undo_unlink: linkNames(payload.campaign_id, results),
  }),
  historyWhere: assetsHistory,

  modelTexts(input) {
    if ("undo_unlink" in input) return [];
    return [{ label: "Callouts", items: input.callouts.map((c) => c.text) }];
  },
};
