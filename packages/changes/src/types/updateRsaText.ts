// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// update_rsa_text: replace the headlines, descriptions and/or display paths of one
// existing responsive search ad (the ad keeps its id and history). Ported from PerfoAds
// executeUpdateAd (text part); no AI rewrite. Google's limits are checked first: 3-15
// headlines of 30, 2-4 descriptions of 90, paths of 15 (wide characters count 2), pins on
// valid positions, no duplicate texts. Google reviews an edited ad again: "under review"
// after the edit is expected and does not fail the read-back (only the texts are compared).
// Undo puts the previous texts, pins and paths back.

import { z } from "zod";
import { ChangeError } from "../errors.js";
import { asObject, asString } from "../json.js";
import type { ActionType, Planned, ReadCtx, ReadTarget, Touched } from "./actionType.js";
import { assertId, gaql, idSchema, resourceName } from "./common.js";
import { adTextSchema } from "./text.js";

export const HEADLINE_MAX = 30;
export const DESCRIPTION_MAX = 90;
export const PATH_MAX = 15;

export const headline = z
  .object({
    text: adTextSchema(HEADLINE_MAX),
    pin: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .optional()
      .describe("Pin to position 1-3"),
  })
  .strict();
export const description = z
  .object({
    text: adTextSchema(DESCRIPTION_MAX),
    pin: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .describe("Pin to position 1-2"),
  })
  .strict();
const path = adTextSchema(PATH_MAX, { allowEmpty: true });

/** Positions Google always fills (2 headlines, 2 descriptions) must be fillable. */
export const pinProblem = (
  items: readonly { pin?: number | undefined }[],
  fill: number[],
): string | null => {
  const unpinned = items.filter((i) => i.pin === undefined).length;
  const emptyPositions = fill.filter((p) => !items.some((i) => i.pin === p)).length;
  return unpinned < emptyPositions
    ? "pins leave a position that always shows with nothing to show"
    : null;
};

export const dupes = (items: readonly { text: string }[]): number =>
  items.findIndex(
    (t, i) => items.findIndex((u) => u.text.toLowerCase() === t.text.toLowerCase()) !== i,
  );

export const updateRsaTextInput = z
  .object({
    ad_group_id: idSchema,
    ad_id: idSchema,
    headlines: z.array(headline).min(3).max(15).optional(),
    descriptions: z.array(description).min(2).max(4).optional(),
    path1: path.optional().describe('Display path 1 ("" clears it)'),
    path2: path.optional().describe('Display path 2 ("" clears it)'),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.headlines && !v.descriptions && v.path1 === undefined && v.path2 === undefined) {
      ctx.addIssue({ code: "custom", message: "give headlines, descriptions, path1 and/or path2" });
    }
    for (const [field, list, fill] of [
      ["headlines", v.headlines, [1, 2]],
      ["descriptions", v.descriptions, [1, 2]],
    ] as const) {
      if (!list) continue;
      const d = dupes(list);
      if (d >= 0)
        ctx.addIssue({ code: "custom", path: [field, d], message: "the same text twice" });
      const p = pinProblem(list, [...fill]);
      if (p) ctx.addIssue({ code: "custom", path: [field], message: p });
    }
  });

/** Undo: the texts the ad had (Google accepted them then); only Google's lengths checked. */
const looseText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max * 2);
const updateRsaUndoInput = z
  .object({
    ad_group_id: idSchema,
    ad_id: idSchema,
    headlines: z
      .array(
        z
          .object({
            text: looseText(HEADLINE_MAX),
            pin: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(15)
      .optional(),
    descriptions: z
      .array(
        z
          .object({
            text: looseText(DESCRIPTION_MAX),
            pin: z.union([z.literal(1), z.literal(2)]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(4)
      .optional(),
    path1: z
      .string()
      .max(PATH_MAX * 2)
      .optional(),
    path2: z
      .string()
      .max(PATH_MAX * 2)
      .optional(),
  })
  .strict();

export type UpdateRsaTextInput = z.infer<typeof updateRsaTextInput>;

const F = {
  headlines: "rsa.headlines",
  descriptions: "rsa.descriptions",
  path1: "rsa.path1",
  path2: "rsa.path2",
} as const;

type Asset = { text: string; pin?: number | undefined };

/** [[text, "HEADLINE_1" | ""], ...] as one comparable string. */
const assetsText = (list: readonly Asset[], prefix: "HEADLINE" | "DESCRIPTION"): string =>
  JSON.stringify(list.map((a) => [a.text, a.pin ? `${prefix}_${a.pin}` : ""]));

const fromGoogle = (raw: unknown, prefix: "HEADLINE" | "DESCRIPTION"): Asset[] =>
  (Array.isArray(raw) ? raw : []).map((a) => {
    const o = asObject(a);
    const pin = asString(o.pinnedField);
    const m = pin ? new RegExp(`^${prefix}_(\\d)$`).exec(pin) : null;
    return { text: asString(o.text) ?? "", ...(m ? { pin: Number(m[1]) } : {}) };
  });

interface AdState {
  adGroupName: string | null;
  campaignId: string;
  status: string | null;
  type: string | null;
  headlines: Asset[];
  descriptions: Asset[];
  path1: string;
  path2: string;
  reviewStatus: string | null;
}

const readAd = async (ctx: ReadCtx, adGroupId: string, adId: string): Promise<AdState | null> => {
  const rows = await gaql(
    ctx,
    `SELECT ad_group.id, ad_group.name, campaign.id, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group_ad.policy_summary.review_status FROM ad_group_ad WHERE ad_group.id = ${assertId(adGroupId)} AND ad_group_ad.ad.id = ${assertId(adId)} LIMIT 1`,
    "the ad",
  );
  if (!rows[0]) return null;
  const aga = asObject(rows[0].adGroupAd);
  const ad = asObject(aga.ad);
  const rsa = asObject(ad.responsiveSearchAd);
  return {
    adGroupName: asString(asObject(rows[0].adGroup).name) ?? null,
    campaignId: String(asObject(rows[0].campaign).id ?? ""),
    status: asString(aga.status) ?? null,
    type: asString(ad.type) ?? null,
    headlines: fromGoogle(rsa.headlines, "HEADLINE"),
    descriptions: fromGoogle(rsa.descriptions, "DESCRIPTION"),
    path1: asString(rsa.path1) ?? "",
    path2: asString(rsa.path2) ?? "",
    reviewStatus: asString(asObject(aga.policySummary).reviewStatus) ?? null,
  };
};

const touchedOf = (
  s: Pick<AdState, "headlines" | "descriptions" | "path1" | "path2">,
): Touched => ({
  [F.headlines]: assetsText(s.headlines, "HEADLINE"),
  [F.descriptions]: assetsText(s.descriptions, "DESCRIPTION"),
  [F.path1]: s.path1,
  [F.path2]: s.path2,
});

const pinLines = (list: readonly Asset[], what: string): string[] => {
  const pinned = list.map((a, i) => [i + 1, a.pin] as const).filter(([, p]) => p !== undefined);
  return pinned.length
    ? [
        `${what} pins: ${pinned.map(([i, p]) => `${what.toLowerCase().slice(0, -1)} ${i} -> position ${p}`).join(", ")}.`,
      ]
    : [];
};

export const updateRsaText: ActionType<UpdateRsaTextInput> = {
  type: "update_rsa_text",
  summary:
    "Replace the headlines, descriptions and/or paths of one responsive search ad (same ad, re-reviewed by Google).",
  input: updateRsaTextInput as z.ZodType<UpdateRsaTextInput>,
  undoInputSchema: updateRsaUndoInput as z.ZodType<UpdateRsaTextInput>,
  independentOps: false,

  async plan(ctx, input): Promise<Planned> {
    const ad = await readAd(ctx, input.ad_group_id, input.ad_id);
    if (!ad) {
      throw new ChangeError(
        "not_found",
        `Ad ${input.ad_id} in ad group ${input.ad_group_id} was not found.`,
      );
    }
    if (ad.status === "REMOVED")
      throw new ChangeError("not_allowed", `Ad ${input.ad_id} is removed.`);
    if (ad.type !== "RESPONSIVE_SEARCH_AD") {
      throw new ChangeError(
        "not_allowed",
        `Ad ${input.ad_id} is not a responsive search ad (${ad.type ?? "unknown type"}).`,
      );
    }
    const after = {
      headlines: input.headlines ?? ad.headlines,
      descriptions: input.descriptions ?? ad.descriptions,
      path1: input.path1 ?? ad.path1,
      path2: input.path2 ?? ad.path2,
    };
    if (after.path2 && !after.path1) {
      throw new ChangeError(
        "invalid_input",
        "path2 needs a path1 (Google shows path2 after path1).",
      );
    }
    const before = touchedOf(ad);
    const expected = touchedOf(after);
    const changed = (Object.keys(expected) as string[]).filter((k) => expected[k] !== before[k]);
    if (changed.length === 0) {
      throw new ChangeError(
        "nothing_to_change",
        `Nothing to change: ad ${input.ad_id} already has these texts.`,
      );
    }
    const rsa: Record<string, unknown> = {};
    const mask: string[] = [];
    if (expected[F.headlines] !== before[F.headlines]) {
      rsa.headlines = after.headlines.map((h) => ({
        text: h.text,
        ...(h.pin ? { pinnedField: `HEADLINE_${h.pin}` } : {}),
      }));
      mask.push("responsive_search_ad.headlines");
    }
    if (expected[F.descriptions] !== before[F.descriptions]) {
      rsa.descriptions = after.descriptions.map((d) => ({
        text: d.text,
        ...(d.pin ? { pinnedField: `DESCRIPTION_${d.pin}` } : {}),
      }));
      mask.push("responsive_search_ad.descriptions");
    }
    for (const p of ["path1", "path2"] as const) {
      if (expected[F[p]] !== before[F[p]]) {
        rsa[p] = after[p];
        mask.push(`responsive_search_ad.${p}`);
      }
    }
    const diff = [
      `Ad ${input.ad_id} in ad group ${input.ad_group_id}: replaces ${mask.map((m) => m.split(".")[1]).join(", ")}.`,
      `Headlines ${ad.headlines.length} -> ${after.headlines.length}, descriptions ${ad.descriptions.length} -> ${after.descriptions.length}${expected[F.path1] !== before[F.path1] || expected[F.path2] !== before[F.path2] ? `, paths ${after.path1 || after.path2 ? "set" : "cleared"}` : ""}. The new texts are in the box below, exactly as sent.`,
      ...pinLines(input.headlines ?? [], "Headlines"),
      ...pinLines(input.descriptions ?? [], "Descriptions"),
      "Google reviews the edited ad again; it shows as under review for a while (expected). It keeps its id and its statistics.",
    ];
    return {
      ops: [
        {
          adOperation: {
            update: {
              resourceName: resourceName(ctx.target.customerId, "ads", input.ad_id),
              responsiveSearchAd: rsa,
            },
            updateMask: mask.join(","),
          },
        },
      ],
      readTarget: { resource: "ad", id: input.ad_id, scope: { adGroupId: input.ad_group_id } },
      touched: before,
      expected,
      diff,
      affected: [
        { kind: "ad", id: input.ad_id, name: null, status: ad.status },
        { kind: "ad_group", id: input.ad_group_id, name: ad.adGroupName, status: null },
        { kind: "campaign", id: ad.campaignId, name: null, status: null },
      ],
      facts: {
        affectedCampaignIds: [ad.campaignId],
        items: [{ kind: "ad", created: 0, updated: 1, removed: 0 }],
      },
      warnings: [],
      undo: { supported: true, why: null, level: "full" },
      targetKeys: [`ads/${input.ad_id}`],
    };
  },

  async readTouched(ctx, t: ReadTarget) {
    const adGroupId = typeof t.scope?.adGroupId === "string" ? t.scope.adGroupId : "";
    const ad = await readAd(ctx, adGroupId, t.id);
    if (!ad || ad.status === "REMOVED") return null;
    // Only the texts count: a review status (UNDER_REVIEW after an edit) is never compared.
    return touchedOf(ad);
  },

  fromMutateResults(results) {
    const rsa = results[0]?.resource?.responsiveSearchAd;
    if (!rsa) return null;
    const o = asObject(rsa);
    return touchedOf({
      headlines: fromGoogle(o.headlines, "HEADLINE"),
      descriptions: fromGoogle(o.descriptions, "DESCRIPTION"),
      path1: asString(o.path1) ?? "",
      path2: asString(o.path2) ?? "",
    });
  },

  undoInput(payload, before) {
    const parse = (text: string | undefined, prefix: string): Asset[] =>
      (JSON.parse(text ?? "[]") as [string, string][]).map(([t, p]) => {
        const m = new RegExp(`^${prefix}_(\\d)$`).exec(p);
        return { text: t, ...(m ? { pin: Number(m[1]) } : {}) };
      });
    return {
      ad_group_id: payload.ad_group_id,
      ad_id: payload.ad_id,
      headlines: parse(before[F.headlines], "HEADLINE"),
      descriptions: parse(before[F.descriptions], "DESCRIPTION"),
      path1: before[F.path1] ?? "",
      path2: before[F.path2] ?? "",
    };
  },

  historyWhere: (customerId, t) =>
    `change_event.change_resource_type = 'AD' AND change_event.change_resource_name = '${resourceName(customerId, "ads", t.id)}'`,

  modelTexts(input) {
    return [
      ...(input.headlines
        ? [{ label: "Headlines (in order)", items: input.headlines.map((h) => h.text) }]
        : []),
      ...(input.descriptions
        ? [{ label: "Descriptions (in order)", items: input.descriptions.map((d) => d.text) }]
        : []),
      ...(input.path1 !== undefined || input.path2 !== undefined
        ? [
            {
              label: "Display paths (1, 2)",
              items: [input.path1 ?? "(unchanged)", input.path2 ?? "(unchanged)"],
            },
          ]
        : []),
    ];
  },
};
