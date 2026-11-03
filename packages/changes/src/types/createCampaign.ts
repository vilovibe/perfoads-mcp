// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// create_campaign: a new Search campaign from plain fields, framework-free (no templates,
// no suggested structure, no copy help). Every field is given; nothing that would choose
// for the person (networks, locations, languages, bidding) has a default. One atomic
// GoogleAdsService.Mutate with temporary ids: budget -> campaign -> campaign criteria
// (locations, languages, negatives) -> ad groups -> keywords -> responsive search ads.
//
// The campaign is always created PAUSED (policy new_entities_paused); its ad groups,
// keywords and ads are ENABLED inside it, so nothing shows or spends until a separate
// update_campaign_status change turns the campaign on (that change counts its budget as
// new daily spend). BROAD keywords only with smart bidding when the policy says so;
// campaign negatives go through the negatives safety gate.
//
// Read-back: the campaign is found by its name (Google keeps campaign names unique), and
// every field and item it made is compared with what was sent. Undo removes the campaign
// (and its own budget) only while it has not run: never switched on, no impressions,
// clicks or spend. Otherwise undo is refused and the plain answer is to pause it. Google's
// change history must show the campaign's own creates in two reads 20 s apart, at least 15
// minutes after the create was applied (it lags and can answer empty): no history is not
// "no change".

import { z } from "zod";
import {
  createTempIds,
  decimalToMicros,
  minimumUnitMicros,
  tempResourceName,
} from "@perfoads/ads-client";
import { ChangeError } from "../errors.js";
import { asObject, asString, doubleField, microsField, type JsonObject } from "../json.js";
import {
  brandTermsInput,
  MATCH_TYPES,
  negativeInput,
  negativesGate,
  negKey,
  overrideInput,
} from "../negatives/gate.js";
import { localDateTime } from "../time.js";
import type {
  ActionType,
  LandedResult,
  Planned,
  ReadCtx,
  ReadTarget,
  Touched,
} from "./actionType.js";
import { SAFE_DEFAULTS } from "./actionType.js";
import {
  amountSchema,
  assertId,
  campaignsUsing,
  formatMoney,
  gaql,
  gaqlString,
  idList,
  idSchema,
  plural,
  resourceName,
  scopeKeys,
  unique,
} from "./common.js";
import { SMART_BIDDING } from "./keywords.js";
import { adTextSchema, finalUrlSchema, keywordTextSchema, normKeyword, tidy } from "./text.js";
import { description, dupes, headline, PATH_MAX, pinProblem } from "./updateRsaText.js";

export const AD_GROUPS_MAX = 20;
export const AD_GROUP_KEYWORDS_MAX = 100;
export const LOCATIONS_MAX = 100;
export const LANGUAGES_MAX = 50;
export const CAMPAIGN_NEGATIVES_MAX = 200;
/** Live items read back per kind; more = something else is in the campaign. */
const TREE_MAX = 5_000;
/** Undo reads this much of the change history (Google keeps 30 days). */
const HISTORY_DAYS = 30;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const STRATEGY_TYPE = {
  MAXIMIZE_CLICKS: "TARGET_SPEND",
  MAXIMIZE_CONVERSIONS: "MAXIMIZE_CONVERSIONS",
  MAXIMIZE_CONVERSION_VALUE: "MAXIMIZE_CONVERSION_VALUE",
  MANUAL_CPC: "MANUAL_CPC",
} as const;

const NAME_BAD =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

const plainName = (max: number) =>
  z.string().transform((raw, ctx) => {
    const text = tidy(raw);
    if (!text || text.length > max || NAME_BAD.test(text)) {
      ctx.addIssue({ code: "custom", message: `must be 1-${max} plain characters` });
      return z.NEVER;
    }
    return text;
  });

const dateSchema = z.string().refine((v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "must be a date as YYYY-MM-DD");

const uniqueIds = (max: number, what: string) =>
  z
    .array(idSchema)
    .min(1, `give at least 1 ${what}`)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, `a ${what} is listed twice`);

const roasPercent = z
  .number()
  .min(1)
  .max(100_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, "at most 2 decimals")
  .describe("Target ROAS as a percent: 400 means 400% (4.0 in Google's ratio)");

const biddingInput = z.discriminatedUnion("strategy", [
  z
    .object({
      strategy: z.literal("MAXIMIZE_CLICKS"),
      max_cpc_limit: amountSchema.optional().describe("Highest price per click"),
    })
    .strict(),
  z
    .object({
      strategy: z.literal("MAXIMIZE_CONVERSIONS"),
      target_cpa: amountSchema.optional().describe("Target cost per conversion"),
    })
    .strict(),
  z
    .object({
      strategy: z.literal("MAXIMIZE_CONVERSION_VALUE"),
      target_roas_percent: roasPercent.optional(),
    })
    .strict(),
  z.object({ strategy: z.literal("MANUAL_CPC") }).strict(),
]);

const httpsUrl = finalUrlSchema.refine((u) => u.startsWith("https://"), "must start with https://");
const pathText = adTextSchema(PATH_MAX);

const rsaInput = z
  .object({
    final_url: httpsUrl,
    headlines: z.array(headline).min(3).max(15),
    descriptions: z.array(description).min(2).max(4),
    path1: pathText.optional(),
    path2: pathText.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.path2 !== undefined && v.path1 === undefined) {
      ctx.addIssue({ code: "custom", path: ["path2"], message: "path2 needs path1" });
    }
    for (const field of ["headlines", "descriptions"] as const) {
      const d = dupes(v[field]);
      if (d >= 0)
        ctx.addIssue({ code: "custom", path: [field, d], message: "the same text twice" });
      const p = pinProblem(v[field], [1, 2]);
      if (p) ctx.addIssue({ code: "custom", path: [field], message: p });
    }
  });

const adGroupInput = z
  .object({
    name: plainName(254),
    max_cpc: amountSchema.optional().describe("Ad group max CPC (MANUAL_CPC only, required there)"),
    keywords: z
      .array(
        z
          .object({
            text: keywordTextSchema.describe("The words only, no [brackets] or quotes"),
            match_type: z.enum(MATCH_TYPES),
          })
          .strict(),
      )
      .max(AD_GROUP_KEYWORDS_MAX)
      .default([]),
    ad: rsaInput.optional().describe("One responsive search ad"),
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

export const createCampaignInput = z
  .object({
    name: plainName(255).describe("Campaign name (unique in the account)"),
    campaign_type: z.literal("SEARCH"),
    daily_budget: amountSchema
      .optional()
      .describe("New daily budget for this campaign only, in the account's currency"),
    shared_budget_id: idSchema.optional().describe("Or: an existing shared budget"),
    bidding: biddingInput,
    networks: z
      .object({
        google_search: z.boolean(),
        search_partners: z.boolean(),
        display: z.boolean(),
      })
      .strict(),
    locations: z
      .object({
        geo_target_ids: uniqueIds(LOCATIONS_MAX, "location").describe("Geo target constant ids"),
        targeting: z
          .enum(["PRESENCE", "PRESENCE_OR_INTEREST"])
          .describe("PRESENCE = people in or regularly in; PRESENCE_OR_INTEREST adds interest"),
      })
      .strict(),
    language_ids: uniqueIds(LANGUAGES_MAX, "language").describe("Language constant ids"),
    contains_eu_political_advertising: z
      .boolean()
      .describe("Your declaration to Google: does it hold EU political advertising?"),
    start_date: dateSchema.optional(),
    end_date: dateSchema.optional(),
    ad_groups: z.array(adGroupInput).max(AD_GROUPS_MAX).default([]),
    negatives: z.array(negativeInput).max(CAMPAIGN_NEGATIVES_MAX).default([]),
    override_blocked_conversions: overrideInput,
    brand_terms: brandTermsInput,
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.daily_budget === undefined) === (v.shared_budget_id === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "give exactly one of daily_budget or shared_budget_id",
      });
    }
    if (v.start_date && v.end_date && v.end_date < v.start_date) {
      ctx.addIssue({ code: "custom", path: ["end_date"], message: "is before start_date" });
    }
    const manual = v.bidding.strategy === "MANUAL_CPC";
    const names = new Set<string>();
    v.ad_groups.forEach((g, i) => {
      if (names.has(g.name.toLowerCase()))
        ctx.addIssue({ code: "custom", path: ["ad_groups", i, "name"], message: "listed twice" });
      names.add(g.name.toLowerCase());
      if (manual && g.max_cpc === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["ad_groups", i, "max_cpc"],
          message: "MANUAL_CPC needs a max_cpc on every ad group",
        });
      }
      if (!manual && g.max_cpc !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["ad_groups", i, "max_cpc"],
          message: `only with MANUAL_CPC (${v.bidding.strategy} sets bids itself)`,
        });
      }
    });
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
        campaign_name: z.string().min(1).max(255),
        campaign_id: idSchema.optional(),
        remove_budget: z.boolean(),
        /** When this server applied the create (its own clock, UTC): the 15-minute wait. */
        made_at: z.string().datetime(),
        /** Every key the change made; anything else in the campaign now = stale. */
        keys: z.array(z.string().max(1_000)).max(10_000),
      })
      .strict(),
  })
  .strict();

type ForwardInput = z.infer<typeof createCampaignInput>;
export type CreateCampaignInput = ForwardInput | z.infer<typeof undoInput>;

// ---- keys ----

/** Fields of the campaign itself, by name. */
const cKey = (label: string, field: string): string => JSON.stringify(["campaign", label, field]);
const locKey = (label: string, id: string): string => JSON.stringify(["location", label, id]);
const langKey = (label: string, id: string): string => JSON.stringify(["language", label, id]);
const negWhere = (label: string): string => `campaign:${label}`;
const agKey = (label: string, ag: string): string => JSON.stringify(["ad_group", label, ag]);
const agCpcKey = (label: string, ag: string): string => JSON.stringify(["ad_group_cpc", label, ag]);
const kwKey = (label: string, ag: string, matchType: string, text: string): string =>
  JSON.stringify(["keyword", label, ag, matchType, normKeyword(text)]);
const adKey = (label: string, ag: string): string => JSON.stringify(["rsa", label, ag]);
/** Anything else found in the campaign (not made by this change). */
const otherKey = (label: string, what: string, id: string): string =>
  JSON.stringify(["other", label, what, id]);

/**
 * Google adds a device row (desktop, mobile, tablet) to every new campaign and ad group, with
 * no bid adjustment: seen live. Those are not things added later; one with an adjustment is.
 */
const isDefaultDevice = (type: string, bidModifier: unknown): boolean =>
  type === "DEVICE" && (bidModifier === undefined || bidModifier === null);

/** Keys of things in the campaign (not its own fields): an extra one makes undo stale. */
const isItemKey = (key: string): boolean => {
  try {
    const v = JSON.parse(key) as unknown;
    return Array.isArray(v) && v[0] !== "campaign" && v[0] !== "ad_group_cpc";
  } catch {
    return false;
  }
};

const assetsJson = (list: readonly { text: string; pin?: number | undefined }[], prefix: string) =>
  list.map((a) => [a.text, a.pin ? `${prefix}_${a.pin}` : ""]);

const rsaValue = (a: {
  status: string;
  finalUrls: string[];
  headlines: unknown[];
  descriptions: unknown[];
  path1: string;
  path2: string;
}): string => JSON.stringify(a);

const biddingValue = (type: string, value: string): string => JSON.stringify([type, value]);
const networksValue = (n: readonly boolean[]): string => JSON.stringify(n);

// ---- live reads ----

interface LiveCampaign {
  id: string;
  name: string;
  status: string;
  budgetId: string | null;
  budgetShared: boolean;
  fields: Record<string, string>;
  /** Settings and labels this change never sets (tracking template, labels, ...) found on it. */
  extras: { what: string; id: string }[];
}

const CAMPAIGN_FIELDS =
  "campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.target_spend.cpc_bid_ceiling_micros, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network, campaign.geo_target_type_setting.positive_geo_target_type, campaign.contains_eu_political_advertising, campaign.start_date_time, campaign.end_date_time, campaign.tracking_url_template, campaign.final_url_suffix, campaign.url_custom_parameters, campaign.labels, campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.period";

/** Labels on a resource, as "other" items (this change never sets labels). */
const labelsOf = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : []).map((l) => String(l)).filter(Boolean);

const toLive = (row: JsonObject): LiveCampaign => {
  const c = asObject(row.campaign);
  const b = asObject(row.campaignBudget);
  const n = asObject(c.networkSettings);
  const type = asString(c.biddingStrategyType) ?? "";
  const bidValue =
    type === "TARGET_SPEND"
      ? microsField(asObject(c.targetSpend).cpcBidCeilingMicros)
      : type === "MAXIMIZE_CONVERSIONS"
        ? microsField(asObject(c.maximizeConversions).targetCpaMicros)
        : type === "MAXIMIZE_CONVERSION_VALUE"
          ? doubleField(asObject(c.maximizeConversionValue).targetRoas)
          : "";
  const shared = b.explicitlyShared === true;
  const budgetId = asString(b.id) ?? (b.id === undefined ? null : String(b.id));
  const extras = [
    ...(["trackingUrlTemplate", "finalUrlSuffix"] as const)
      .filter((f) => (asString(c[f]) ?? "") !== "")
      .map((f) => ({ what: "campaign_setting", id: f })),
    ...(Array.isArray(c.urlCustomParameters) && c.urlCustomParameters.length
      ? [{ what: "campaign_setting", id: "urlCustomParameters" }]
      : []),
    ...labelsOf(c.labels).map((l) => ({ what: "campaign_label", id: l })),
  ];
  return {
    id: String(c.id ?? ""),
    name: asString(c.name) ?? "",
    status: asString(c.status) ?? "",
    budgetId,
    budgetShared: shared,
    fields: {
      name: asString(c.name) ?? "",
      status: asString(c.status) ?? "",
      channel: asString(c.advertisingChannelType) ?? "",
      budget: shared
        ? JSON.stringify({ shared: true, id: budgetId })
        : JSON.stringify({
            shared: false,
            amountMicros: microsField(b.amountMicros),
            period: asString(b.period) ?? "",
          }),
      bidding: biddingValue(type, bidValue ?? "?"),
      networks: networksValue([
        n.targetGoogleSearch === true,
        n.targetSearchNetwork === true,
        n.targetContentNetwork === true,
        n.targetPartnerSearchNetwork === true,
      ]),
      geo_type: asString(asObject(c.geoTargetTypeSetting).positiveGeoTargetType) ?? "",
      eu_political: asString(c.containsEuPoliticalAdvertising) ?? "",
      start: asString(c.startDateTime) ?? "",
      end: asString(c.endDateTime) ?? "",
    },
    extras,
  };
};

const campaignById = async (ctx: ReadCtx, id: string): Promise<LiveCampaign | null> => {
  const rows = await gaql(
    ctx,
    `SELECT ${CAMPAIGN_FIELDS} FROM campaign WHERE campaign.id = ${assertId(id)} LIMIT 1`,
    "the campaign",
  );
  return rows[0] ? toLive(rows[0]) : null;
};

/** Live (not removed) campaigns with exactly this name. */
const campaignIdsNamed = async (ctx: ReadCtx, name: string): Promise<string[]> => {
  const rows = await gaql(
    ctx,
    `SELECT campaign.id FROM campaign WHERE campaign.name = ${gaqlString(name)} AND campaign.status != 'REMOVED' LIMIT 2`,
    "the campaigns with this name",
    2,
  );
  return rows.map((r) => String(asObject(r.campaign).id ?? "")).filter(Boolean);
};

/** Things attached to a campaign that this change never makes (undo: any = stale). */
const ATTACHED = [
  "campaign_asset",
  "campaign_shared_set",
  "ad_group_asset",
  "ad_group_bid_modifier",
] as const;

/**
 * Every key the live campaign has (its fields + everything in it) -> value. `attached`:
 * also read what this change never makes (assets, shared lists, bid modifiers) for undo.
 */
const readTree = async (
  ctx: ReadCtx,
  label: string,
  c: LiveCampaign,
  attached = false,
): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  for (const [field, value] of Object.entries(c.fields)) out.set(cKey(label, field), value);
  for (const e of c.extras) out.set(otherKey(label, e.what, e.id), "present");
  const id = assertId(c.id);
  const capped = (rows: JsonObject[], what: string) => {
    if (rows.length > TREE_MAX) {
      throw new ChangeError("read_failed", `The campaign holds more than ${TREE_MAX} ${what}.`);
    }
    return rows;
  };
  const criteria = capped(
    await gaql(
      ctx,
      `SELECT campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign_criterion.bid_modifier FROM campaign_criterion WHERE campaign.id = ${id} AND campaign_criterion.status != 'REMOVED' LIMIT ${TREE_MAX + 1}`,
      "the campaign's targeting",
      TREE_MAX + 1,
    ),
    "targeting items",
  );
  for (const r of criteria) {
    const cc = asObject(r.campaignCriterion);
    const type = asString(cc.type) ?? "";
    const negative = cc.negative === true;
    const geo = /^geoTargetConstants\/(\d+)$/.exec(
      asString(asObject(cc.location).geoTargetConstant) ?? "",
    )?.[1];
    const lang = /^languageConstants\/(\d+)$/.exec(
      asString(asObject(cc.language).languageConstant) ?? "",
    )?.[1];
    const kw = asObject(cc.keyword);
    if (isDefaultDevice(type, cc.bidModifier)) continue;
    if (type === "LOCATION" && !negative && geo) out.set(locKey(label, geo), "present");
    else if (type === "LANGUAGE" && !negative && lang) out.set(langKey(label, lang), "present");
    else if (type === "KEYWORD" && negative) {
      out.set(
        negKey(negWhere(label), asString(kw.matchType) ?? "", asString(kw.text) ?? ""),
        "present",
      );
    } else {
      out.set(otherKey(label, `criterion:${type}`, String(cc.criterionId ?? "")), "present");
    }
  }
  const groups = capped(
    await gaql(
      ctx,
      `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros, ad_group.tracking_url_template, ad_group.final_url_suffix, ad_group.labels FROM ad_group WHERE campaign.id = ${id} AND ad_group.status != 'REMOVED' LIMIT ${TREE_MAX + 1}`,
      "the campaign's ad groups",
      TREE_MAX + 1,
    ),
    "ad groups",
  );
  const groupName = new Map<string, string>();
  for (const r of groups) {
    const g = asObject(r.adGroup);
    const name = asString(g.name) ?? "";
    groupName.set(String(g.id ?? ""), name);
    out.set(
      agKey(label, name),
      JSON.stringify({ status: asString(g.status) ?? "", type: asString(g.type) ?? "" }),
    );
    out.set(agCpcKey(label, name), microsField(g.cpcBidMicros) ?? "?");
    const gid = String(g.id ?? "");
    for (const f of ["trackingUrlTemplate", "finalUrlSuffix"] as const) {
      if ((asString(g[f]) ?? "") !== "")
        out.set(otherKey(label, `ad_group_setting:${f}`, gid), "present");
    }
    for (const l of labelsOf(g.labels)) out.set(otherKey(label, "ad_group_label", l), "present");
  }
  const crits = capped(
    await gaql(
      ctx,
      `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.negative, ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.labels FROM ad_group_criterion WHERE campaign.id = ${id} AND ad_group_criterion.status != 'REMOVED' LIMIT ${TREE_MAX + 1}`,
      "the campaign's keywords",
      TREE_MAX + 1,
    ),
    "keywords",
  );
  for (const r of crits) {
    const gid = String(asObject(r.adGroup).id ?? "");
    const ag = groupName.get(gid) ?? `#${gid}`;
    const k = asObject(r.adGroupCriterion);
    const kw = asObject(k.keyword);
    for (const l of labelsOf(k.labels)) {
      out.set(otherKey(label, "ad_group_criterion_label", l), "present");
    }
    if (k.type === "KEYWORD" && k.negative !== true) {
      out.set(
        kwKey(label, ag, asString(kw.matchType) ?? "", asString(kw.text) ?? ""),
        asString(k.status) ?? "",
      );
    } else {
      out.set(
        otherKey(label, "ad_group_criterion", `${gid}~${String(k.criterionId ?? "")}`),
        "present",
      );
    }
  }
  const ads = capped(
    await gaql(
      ctx,
      `SELECT ad_group.id, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group_ad.labels FROM ad_group_ad WHERE campaign.id = ${id} AND ad_group_ad.status != 'REMOVED' LIMIT ${TREE_MAX + 1}`,
      "the campaign's ads",
      TREE_MAX + 1,
    ),
    "ads",
  );
  for (const r of ads) {
    const gid = String(asObject(r.adGroup).id ?? "");
    const ag = groupName.get(gid) ?? `#${gid}`;
    const aga = asObject(r.adGroupAd);
    const ad = asObject(aga.ad);
    for (const l of labelsOf(aga.labels)) out.set(otherKey(label, "ad_label", l), "present");
    const key = adKey(label, ag);
    if (ad.type !== "RESPONSIVE_SEARCH_AD" || out.has(key)) {
      out.set(otherKey(label, "ad", String(ad.id ?? "")), "present");
      continue;
    }
    const rsa = asObject(ad.responsiveSearchAd);
    const assets = (raw: unknown) =>
      (Array.isArray(raw) ? raw : []).map((a) => {
        const o = asObject(a);
        return [asString(o.text) ?? "", asString(o.pinnedField) ?? ""];
      });
    out.set(
      key,
      rsaValue({
        status: asString(aga.status) ?? "",
        finalUrls: (Array.isArray(ad.finalUrls) ? ad.finalUrls : []).map((u) => String(u)),
        headlines: assets(rsa.headlines),
        descriptions: assets(rsa.descriptions),
        path1: asString(rsa.path1) ?? "",
        path2: asString(rsa.path2) ?? "",
      }),
    );
  }
  if (attached) {
    for (const from of ATTACHED) {
      // campaign.id is selected too: Google refuses the filter on campaign_asset otherwise.
      // Bid modifiers have no status (removing one deletes it).
      const modifier = from === "ad_group_bid_modifier";
      const live = modifier ? "" : ` AND ${from}.status != 'REMOVED'`;
      const extra = modifier
        ? ", ad_group_bid_modifier.bid_modifier, ad_group_bid_modifier.device.type"
        : "";
      const rows = await gaql(
        ctx,
        `SELECT campaign.id, ${from}.resource_name${extra} FROM ${from} WHERE campaign.id = ${id}${live} LIMIT ${TREE_MAX + 1}`,
        "what is attached to the campaign",
        TREE_MAX + 1,
      );
      const json = from.replace(/_(\w)/g, (_m, ch: string) => ch.toUpperCase());
      for (const r of capped(rows, "attached items")) {
        const o = asObject(r[json]);
        if (modifier && isDefaultDevice(asObject(o.device).type ? "DEVICE" : "", o.bidModifier))
          continue;
        const name = asString(o.resourceName) ?? "?";
        out.set(otherKey(label, from, name), "present");
      }
    }
  }
  return out;
};

/** The campaign a read target names: by id (undo) or by its unique name. Null = none live. */
const findCampaign = async (
  ctx: ReadCtx,
  label: string,
  campaignId: string | undefined,
): Promise<LiveCampaign | null> => {
  if (campaignId !== undefined) {
    const c = await campaignById(ctx, campaignId);
    return c && c.status !== "REMOVED" ? c : null;
  }
  const ids = await campaignIdsNamed(ctx, label);
  if (ids.length > 1) {
    throw new ChangeError(
      "read_failed",
      "More than one campaign has this name; can't tell which one is ours.",
    );
  }
  return ids[0] ? campaignById(ctx, ids[0]) : null;
};

const readCreated = async (ctx: ReadCtx, t: ReadTarget): Promise<Touched> => {
  const label = asString(t.scope?.label) ?? t.id;
  const id = asString(t.scope?.campaign_id);
  const keys = scopeKeys(t.scope);
  const c = await findCampaign(ctx, label, id === undefined ? undefined : assertId(id));
  const tree = c ? await readTree(ctx, label, c) : new Map<string, string>();
  return Object.fromEntries(keys.map((k) => [k, tree.get(k) ?? "absent"]));
};

// ---- money ----

/** An amount that is exactly a whole number of the currency's smallest billable unit. */
const exactMicros = (amount: string, currency: string, what: string): bigint => {
  const unit = minimumUnitMicros(currency);
  let micros: bigint;
  try {
    micros = decimalToMicros(amount);
  } catch {
    throw new ChangeError("invalid_input", `${what} "${amount}" is not a plain amount.`);
  }
  if (unit === undefined) {
    throw new ChangeError("invalid_input", `${what} can't be used: unknown currency ${currency}.`);
  }
  if (micros <= 0n || micros % unit !== 0n) {
    throw new ChangeError(
      "invalid_input",
      `${what} "${amount}" can't be used in ${currency}: it must be a positive whole number of ${formatMoney(unit, currency)} steps (Google bills ${currency} in those). Nothing was proposed.`,
    );
  }
  return micros;
};

const roasRatio = (pct: number): string => doubleField(Math.round(pct * 100) / 10_000) ?? "0";

// ---- plan ----

const readSharedBudget = async (ctx: ReadCtx, id: string) => {
  const rows = await gaql(
    ctx,
    `SELECT campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.period, campaign_budget.status, campaign_budget.total_amount_micros FROM campaign_budget WHERE campaign_budget.id = ${assertId(id)} LIMIT 1`,
    "the shared budget",
  );
  if (!rows[0]) throw new ChangeError("not_found", `Budget ${id} was not found in this account.`);
  const b = asObject(rows[0].campaignBudget);
  if (b.status === "REMOVED") throw new ChangeError("not_allowed", `Budget ${id} is removed.`);
  if (b.explicitlyShared !== true) {
    throw new ChangeError(
      "not_allowed",
      `Budget ${id} belongs to one campaign (it is not a shared budget), so a new campaign can't use it. Give daily_budget instead.`,
    );
  }
  if (
    (asString(b.period) ?? "DAILY") !== "DAILY" ||
    (microsField(b.totalAmountMicros) ?? "0") !== "0"
  ) {
    throw new ChangeError("not_allowed", `Budget ${id} is not a daily budget.`);
  }
  const amount = microsField(b.amountMicros);
  if (amount === null) throw new ChangeError("read_failed", `Couldn't read budget ${id}'s amount.`);
  return amount;
};

/**
 * Every id must be a live geo target / targetable language (Google's constants). Returns
 * warnings and Google's names for the ids (shown next to them on the approval page).
 */
const checkConstants = async (
  ctx: ReadCtx,
  geoIds: readonly string[],
  langIds: readonly string[],
): Promise<{ warnings: string[]; names: { label: string; items: string[] }[] }> => {
  const warnings: string[] = [];
  const geoRows = await gaql(
    ctx,
    `SELECT geo_target_constant.id, geo_target_constant.status, geo_target_constant.canonical_name FROM geo_target_constant WHERE geo_target_constant.id IN ${idList(geoIds)}`,
    "the locations",
    geoIds.length + 1,
  );
  const geo = new Map(
    geoRows.map((r) => {
      const g = asObject(r.geoTargetConstant);
      return [
        String(g.id ?? ""),
        { status: asString(g.status) ?? "", name: asString(g.canonicalName) ?? "" },
      ] as const;
    }),
  );
  const missingGeo = geoIds.filter((id) => !geo.has(id));
  if (missingGeo.length) {
    throw new ChangeError(
      "invalid_input",
      `Not a Google location (geo target constant): ${missingGeo.slice(0, 10).join(", ")}. Nothing was proposed.`,
    );
  }
  const planned = geoIds.filter((id) => geo.get(id)?.status === "REMOVAL_PLANNED");
  if (planned.length) {
    warnings.push(
      `Google plans to remove ${plural(planned.length, "of these locations", "of these locations")} (${planned.join(", ")}); targeting on it may stop later.`,
    );
  }
  const langRows = await gaql(
    ctx,
    `SELECT language_constant.id, language_constant.targetable, language_constant.name FROM language_constant WHERE language_constant.id IN ${idList(langIds)}`,
    "the languages",
    langIds.length + 1,
  );
  const lang = new Map(
    langRows.map((r) => {
      const l = asObject(r.languageConstant);
      return [
        String(l.id ?? ""),
        { targetable: l.targetable === true, name: asString(l.name) ?? "" },
      ] as const;
    }),
  );
  const badLang = langIds.filter((id) => lang.get(id)?.targetable !== true);
  if (badLang.length) {
    throw new ChangeError(
      "invalid_input",
      `Not a targetable Google language (language constant): ${badLang.slice(0, 10).join(", ")}. Nothing was proposed.`,
    );
  }
  return {
    warnings,
    names: [
      {
        label: "Locations (id: Google's name)",
        items: geoIds.map((id) => `${id}: ${geo.get(id)?.name || "(no name)"}`),
      },
      {
        label: "Languages (id: Google's name)",
        items: langIds.map((id) => `${id}: ${lang.get(id)?.name || "(no name)"}`),
      },
    ],
  };
};

const STRATEGY_WORDS: Record<ForwardInput["bidding"]["strategy"], string> = {
  MAXIMIZE_CLICKS: "Maximize clicks",
  MAXIMIZE_CONVERSIONS: "Maximize conversions",
  MAXIMIZE_CONVERSION_VALUE: "Maximize conversion value",
  MANUAL_CPC: "Manual CPC",
};

const yesNo = (b: boolean): string => (b ? "yes" : "no");

const planForward = async (ctx: ReadCtx, input: ForwardInput): Promise<Planned> => {
  const cid = ctx.target.customerId;
  const currency = ctx.account.currencyCode;
  const label = input.name;
  const defaults = ctx.defaults ?? SAFE_DEFAULTS;

  if ((await campaignIdsNamed(ctx, label)).length > 0) {
    throw new ChangeError(
      "not_allowed",
      "A campaign with this name already exists in the account (Google keeps campaign names unique). Pick another name. Nothing was proposed.",
    );
  }

  // Money first: every amount must be exact in the account's currency.
  const ownBudget =
    input.daily_budget !== undefined
      ? exactMicros(input.daily_budget, currency, "daily_budget")
      : null;
  const b = input.bidding;
  const strategyType = STRATEGY_TYPE[b.strategy];
  let bidValue = "";
  const biddingField: JsonObject = {};
  let bidLine = "";
  if (b.strategy === "MAXIMIZE_CLICKS") {
    const cap =
      b.max_cpc_limit !== undefined
        ? exactMicros(b.max_cpc_limit, currency, "max_cpc_limit")
        : null;
    bidValue = cap === null ? "0" : cap.toString();
    biddingField.targetSpend = cap === null ? {} : { cpcBidCeilingMicros: cap.toString() };
    bidLine = cap === null ? "no max CPC limit" : `max CPC limit ${formatMoney(cap, currency)}`;
  } else if (b.strategy === "MAXIMIZE_CONVERSIONS") {
    const cpa =
      b.target_cpa !== undefined ? exactMicros(b.target_cpa, currency, "target_cpa") : null;
    bidValue = cpa === null ? "0" : cpa.toString();
    biddingField.maximizeConversions = cpa === null ? {} : { targetCpaMicros: cpa.toString() };
    bidLine = cpa === null ? "no target CPA" : `target CPA ${formatMoney(cpa, currency)}`;
  } else if (b.strategy === "MAXIMIZE_CONVERSION_VALUE") {
    const ratio = b.target_roas_percent !== undefined ? roasRatio(b.target_roas_percent) : null;
    bidValue = ratio ?? "0";
    biddingField.maximizeConversionValue = ratio === null ? {} : { targetRoas: Number(ratio) };
    bidLine =
      b.target_roas_percent === undefined
        ? "no target ROAS"
        : `target ROAS ${b.target_roas_percent}%`;
  } else {
    bidValue = "";
    biddingField.manualCpc = {};
    bidLine = "you set the max CPC per ad group";
  }
  const groupCpc = input.ad_groups.map((g) =>
    g.max_cpc !== undefined
      ? exactMicros(g.max_cpc, currency, `max_cpc of ad group ${input.ad_groups.indexOf(g) + 1}`)
      : null,
  );

  // Policy defaults: BROAD only with smart bidding.
  const smart = SMART_BIDDING.has(strategyType);
  const broad = input.ad_groups.reduce(
    (n, g) => n + g.keywords.filter((k) => k.match_type === "BROAD").length,
    0,
  );
  if (broad && !smart && defaults.broadMatchRequiresSmartBidding) {
    throw new ChangeError(
      "not_allowed",
      `Refused: ${plural(broad, "BROAD keyword")} in a campaign bidding with ${STRATEGY_WORDS[b.strategy]}, not smart bidding. The policy (defaults.broad_match_requires_smart_bidding) allows BROAD only with Maximize conversions or Maximize conversion value. Use PHRASE or EXACT. Nothing was proposed.`,
    );
  }

  let budgetMicros: string;
  let sharedOn: { id: string; name: string | null; status: string | null }[] = [];
  if (input.shared_budget_id !== undefined) {
    budgetMicros = await readSharedBudget(ctx, input.shared_budget_id);
    sharedOn = await campaignsUsing(
      ctx,
      "campaign.campaign_budget",
      resourceName(cid, "campaignBudgets", input.shared_budget_id),
    );
  } else {
    budgetMicros = (ownBudget ?? 0n).toString();
  }

  const constants = await checkConstants(ctx, input.locations.geo_target_ids, input.language_ids);
  const warnings = constants.warnings;
  const outcome = await negativesGate(
    ctx,
    input.negatives.map((n) => ({ text: n.text, matchType: n.match_type })),
    {
      override: input.override_blocked_conversions === true,
      brandTerms: input.brand_terms,
      reachesPmax: false,
    },
  );
  warnings.push(...outcome.warnings);

  // ---- operations, one atomic request, temporary ids ----
  const nextId = createTempIds();
  const ops: JsonObject[] = [];
  let budgetName: string;
  if (input.shared_budget_id !== undefined) {
    budgetName = resourceName(cid, "campaignBudgets", input.shared_budget_id);
  } else {
    budgetName = tempResourceName(cid, "campaignBudgets", nextId());
    ops.push({
      campaignBudgetOperation: {
        create: {
          resourceName: budgetName,
          amountMicros: budgetMicros,
          period: "DAILY",
          explicitlyShared: false,
        },
      },
    });
  }
  const campaignName = tempResourceName(cid, "campaigns", nextId());
  const net = input.networks;
  const geoType = input.locations.targeting;
  const eu = input.contains_eu_political_advertising
    ? "CONTAINS_EU_POLITICAL_ADVERTISING"
    : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";
  const start = input.start_date !== undefined ? `${input.start_date} 00:00:00` : undefined;
  const end = input.end_date !== undefined ? `${input.end_date} 23:59:59` : undefined;
  ops.push({
    campaignOperation: {
      create: {
        resourceName: campaignName,
        name: input.name,
        status: "PAUSED",
        advertisingChannelType: "SEARCH",
        campaignBudget: budgetName,
        ...biddingField,
        networkSettings: {
          targetGoogleSearch: net.google_search,
          targetSearchNetwork: net.search_partners,
          targetContentNetwork: net.display,
          targetPartnerSearchNetwork: false,
        },
        geoTargetTypeSetting: { positiveGeoTargetType: geoType },
        containsEuPoliticalAdvertising: eu,
        ...(start !== undefined ? { startDateTime: start } : {}),
        ...(end !== undefined ? { endDateTime: end } : {}),
      },
    },
  });
  for (const id of input.locations.geo_target_ids) {
    ops.push({
      campaignCriterionOperation: {
        create: {
          campaign: campaignName,
          location: { geoTargetConstant: `geoTargetConstants/${id}` },
        },
      },
    });
  }
  for (const id of input.language_ids) {
    ops.push({
      campaignCriterionOperation: {
        create: {
          campaign: campaignName,
          language: { languageConstant: `languageConstants/${id}` },
        },
      },
    });
  }
  for (const n of input.negatives) {
    ops.push({
      campaignCriterionOperation: {
        create: {
          campaign: campaignName,
          negative: true,
          keyword: { text: n.text, matchType: n.match_type },
        },
      },
    });
  }
  const groupNames = input.ad_groups.map(() => tempResourceName(cid, "adGroups", nextId()));
  input.ad_groups.forEach((g, i) => {
    const cpc = groupCpc[i];
    ops.push({
      adGroupOperation: {
        create: {
          resourceName: groupNames[i] ?? "",
          campaign: campaignName,
          name: g.name,
          status: "ENABLED",
          type: "SEARCH_STANDARD",
          ...(cpc !== null && cpc !== undefined ? { cpcBidMicros: cpc.toString() } : {}),
        },
      },
    });
  });
  input.ad_groups.forEach((g, i) => {
    for (const k of g.keywords) {
      ops.push({
        adGroupCriterionOperation: {
          create: {
            adGroup: groupNames[i] ?? "",
            status: "ENABLED",
            keyword: { text: k.text, matchType: k.match_type },
          },
        },
      });
    }
  });
  input.ad_groups.forEach((g, i) => {
    const a = g.ad;
    if (!a) return;
    const asset = (list: readonly { text: string; pin?: number | undefined }[], prefix: string) =>
      list.map((x) => ({ text: x.text, ...(x.pin ? { pinnedField: `${prefix}_${x.pin}` } : {}) }));
    ops.push({
      adGroupAdOperation: {
        create: {
          adGroup: groupNames[i] ?? "",
          status: "ENABLED",
          ad: {
            finalUrls: [a.final_url],
            responsiveSearchAd: {
              headlines: asset(a.headlines, "HEADLINE"),
              descriptions: asset(a.descriptions, "DESCRIPTION"),
              ...(a.path1 !== undefined ? { path1: a.path1 } : {}),
              ...(a.path2 !== undefined ? { path2: a.path2 } : {}),
            },
          },
        },
      },
    });
  });

  // ---- what must read back ----
  const expected: Touched = {
    [cKey(label, "name")]: input.name,
    [cKey(label, "status")]: "PAUSED",
    [cKey(label, "channel")]: "SEARCH",
    [cKey(label, "budget")]:
      input.shared_budget_id !== undefined
        ? JSON.stringify({ shared: true, id: input.shared_budget_id })
        : JSON.stringify({ shared: false, amountMicros: budgetMicros, period: "DAILY" }),
    [cKey(label, "bidding")]: biddingValue(strategyType, bidValue),
    [cKey(label, "networks")]: networksValue([
      net.google_search,
      net.search_partners,
      net.display,
      false,
    ]),
    [cKey(label, "geo_type")]: geoType,
    [cKey(label, "eu_political")]: eu,
    ...(start !== undefined ? { [cKey(label, "start")]: start } : {}),
    ...(end !== undefined ? { [cKey(label, "end")]: end } : {}),
  };
  for (const id of input.locations.geo_target_ids) expected[locKey(label, id)] = "present";
  for (const id of input.language_ids) expected[langKey(label, id)] = "present";
  for (const n of input.negatives) {
    expected[negKey(negWhere(label), n.match_type, n.text)] = "present";
  }
  input.ad_groups.forEach((g, i) => {
    expected[agKey(label, g.name)] = JSON.stringify({ status: "ENABLED", type: "SEARCH_STANDARD" });
    const cpc = groupCpc[i];
    if (cpc !== null && cpc !== undefined) expected[agCpcKey(label, g.name)] = cpc.toString();
    for (const k of g.keywords) expected[kwKey(label, g.name, k.match_type, k.text)] = "ENABLED";
    if (g.ad) {
      expected[adKey(label, g.name)] = rsaValue({
        status: "ENABLED",
        finalUrls: [g.ad.final_url],
        headlines: assetsJson(g.ad.headlines, "HEADLINE"),
        descriptions: assetsJson(g.ad.descriptions, "DESCRIPTION"),
        path1: g.ad.path1 ?? "",
        path2: g.ad.path2 ?? "",
      });
    }
  });
  const keys = Object.keys(expected).sort();

  // ---- the approval page (server text only; every model text is in the boxes) ----
  const shared = input.shared_budget_id !== undefined;
  const budgetText = formatMoney(budgetMicros, currency);
  const keywordsTotal = input.ad_groups.reduce((n, g) => n + g.keywords.length, 0);
  const adsTotal = input.ad_groups.filter((g) => g.ad).length;
  const diff: string[] = [
    "Makes a new Search campaign, PAUSED: it shows no ads and spends nothing until a separate update_campaign_status change turns it on. Its name and every text are in the boxes below, exactly as sent.",
    shared
      ? `Budget: shared budget ${input.shared_budget_id} (${budgetText} a day), already used by ${plural(sharedOn.length, "campaign")}; once on, this campaign shares it with them.`
      : `Budget: a new daily budget of ${budgetText} for this campaign only.`,
    `Once turned on it can spend up to ${budgetText} a day${shared ? " (shared)" : ""}. That later update_campaign_status change counts it as new daily spend against the policy (max_new_daily_spend).`,
    `Bidding: ${STRATEGY_WORDS[b.strategy]}, ${bidLine}.`,
    `Networks: Google Search ${yesNo(net.google_search)}, Search partners ${yesNo(net.search_partners)}, Display ${yesNo(net.display)}.`,
    `Locations (${input.locations.geo_target_ids.length}): geo target ${input.locations.geo_target_ids.join(", ")} (Google's names in the box below). Reaches ${geoType === "PRESENCE" ? "people in or regularly in them (PRESENCE)" : "people in, regularly in, or interested in them (PRESENCE_OR_INTEREST)"}.`,
    `Languages (${input.language_ids.length}): language ${input.language_ids.join(", ")} (Google's names in the box below).`,
    `Start: ${input.start_date ?? "not set (Google uses the day it is made)"}. End: ${input.end_date ?? "not set (runs until stopped)"}.`,
    `EU political advertising: declared ${input.contains_eu_political_advertising ? "as CONTAINING" : "as NOT containing"} it.`,
  ];
  input.ad_groups.forEach((g, i) => {
    const counts = MATCH_TYPES.map(
      (m) => [m, g.keywords.filter((k) => k.match_type === m).length] as const,
    )
      .filter(([, n]) => n > 0)
      .map(([m, n]) => `${n} ${m}`)
      .join(", ");
    const cpc = groupCpc[i];
    const pins = g.ad
      ? [
          ...g.ad.headlines.flatMap((h, j) =>
            h.pin ? [`headline ${j + 1} -> position ${h.pin}`] : [],
          ),
          ...g.ad.descriptions.flatMap((d, j) =>
            d.pin ? [`description ${j + 1} -> position ${d.pin}`] : [],
          ),
        ]
      : [];
    diff.push(
      `Ad group ${i + 1}: ${cpc !== null && cpc !== undefined ? `max CPC ${formatMoney(cpc, currency)}, ` : ""}${plural(g.keywords.length, "keyword")}${counts ? ` (${counts})` : ""}, ${g.ad ? `1 responsive search ad (${g.ad.headlines.length} headlines, ${g.ad.descriptions.length} descriptions${pins.length ? `; pinned: ${pins.join(", ")}` : ""})` : "no ad"}.`,
    );
  });
  if (input.ad_groups.length) {
    diff.push(
      "Ad groups, keywords and ads are created ENABLED inside the PAUSED campaign: nothing shows until the campaign is turned on.",
    );
  }
  if (input.negatives.length) {
    diff.push(
      `Campaign negative keywords: ${input.negatives.length}, checked against your brand terms and the searches and keywords with conversions in the last 90 days.`,
    );
  }
  diff.push(
    `${plural(ops.length, "operation")} in one all-or-nothing request: if Google refuses any part, nothing is made.`,
  );
  if (input.ad_groups.length === 0) {
    warnings.push(
      "No ad groups: the campaign can't show ads until ad groups, keywords and ads are added.",
    );
  }

  const criteriaCount =
    input.locations.geo_target_ids.length + input.language_ids.length + input.negatives.length;
  return {
    ops,
    readTarget: { resource: "campaign", id: label, scope: { label, keys } },
    touched: Object.fromEntries(keys.map((k) => [k, "absent"])),
    expected,
    diff,
    affected: shared
      ? [
          {
            kind: "campaign_budget" as const,
            id: input.shared_budget_id ?? "",
            name: null,
            status: "ENABLED",
          },
          ...sharedOn.map((c) => ({ kind: "campaign" as const, ...c })),
        ]
      : [],
    facts: {
      affectedCampaignIds: sharedOn.map((c) => c.id),
      items: [
        ...(shared ? [] : [{ kind: "campaign_budget", created: 1, updated: 0, removed: 0 }]),
        { kind: "campaign", created: 1, updated: 0, removed: 0 },
        { kind: "campaign_criterion", created: criteriaCount, updated: 0, removed: 0 },
        { kind: "ad_group", created: input.ad_groups.length, updated: 0, removed: 0 },
        { kind: "ad_group_keyword", created: keywordsTotal, updated: 0, removed: 0 },
        { kind: "ad", created: adsTotal, updated: 0, removed: 0 },
      ],
      createdEnabled: 0,
      broadWithoutSmartBidding: smart ? 0 : broad,
      spendWhenEnabled: { dailyBudgetMicros: budgetMicros, budgetShared: shared },
      googleNames: constants.names,
      ...(outcome.blocked ? { blockedConversions: outcome.blocked } : {}),
    },
    warnings,
    undo: {
      supported: true,
      why: "Undo removes the new campaign (and its own budget) only while it has not run: never turned on, no impressions, clicks or spend. After that, pause it with update_campaign_status instead. Undo is possible from 15 minutes after it is made (Google's change history lags).",
      level: "full_while_unused",
    },
    targetKeys: [
      `campaigns/new:${label}`,
      ...(shared ? [`campaignBudgets/${input.shared_budget_id ?? ""}`] : []),
    ],
  };
};

// ---- undo ----

/** Rows read from the change history at most; a full page = can't tell (refused). */
const HISTORY_LIMIT = 10_000;

/** change_event resource types of what create_campaign makes, by item key kind. */
const MADE_TYPES: Record<string, string[]> = {
  location: ["CAMPAIGN_CRITERION"],
  language: ["CAMPAIGN_CRITERION"],
  neg: ["CAMPAIGN_CRITERION"],
  ad_group: ["AD_GROUP"],
  keyword: ["AD_GROUP_CRITERION"],
  rsa: ["AD_GROUP_AD", "AD"],
};

/**
 * Google's change history lags (about 10 minutes seen live) and the same read can answer
 * all rows, then none: undo waits this long after the create before trusting it.
 */
const HISTORY_SETTLE_MS = 15 * 60 * 1000;
/** The history is read twice this far apart; the two reads must agree. */
const HISTORY_GAP_MS = 20_000;
/** Time kept for the second read itself. */
const HISTORY_READ_MS = 15_000;

/**
 * One read of the campaign's change history: "changed" = any event that is not a create
 * (an update or a removal, e.g. switched on and off); "unknown" = too many rows to check;
 * "not_ready" = this campaign's own creates are not in it (Google's history has not caught
 * up, or answered empty or part of it). "ok": added = more creates than this change made
 * (sitelinks, ad groups, ...), seen = the events, to compare two reads.
 */
type HistoryRead =
  { kind: "changed" | "unknown" | "not_ready" } | { kind: "ok"; added: boolean; seen: string };

const readHistory = async (
  ctx: ReadCtx,
  campaignId: string,
  made: ReadonlyMap<string, number>,
): Promise<HistoryRead> => {
  const now = (ctx.now ?? Date.now)();
  const tz = ctx.account.timeZone ?? "UTC";
  // Google keeps 30 days of history; an hour less keeps the window inside it.
  const from = localDateTime(now - HISTORY_DAYS * DAY_MS + HOUR_MS, tz);
  // A day ahead: the account clock may run ahead of ours.
  const to = localDateTime(now + DAY_MS, tz);
  const campaign = resourceName(ctx.target.customerId, "campaigns", campaignId);
  const rows = await gaql(
    ctx,
    `SELECT change_event.change_date_time, change_event.change_resource_type, change_event.change_resource_name, change_event.resource_change_operation FROM change_event WHERE change_event.change_date_time >= '${from}' AND change_event.change_date_time <= '${to}' AND change_event.campaign = '${campaign}' ORDER BY change_event.change_date_time DESC LIMIT ${HISTORY_LIMIT}`,
    "the campaign's change history",
    HISTORY_LIMIT,
  );
  if (rows.length >= HISTORY_LIMIT) return { kind: "unknown" };
  const created = new Map<string, number>();
  const seen: string[] = [];
  let added = false;
  let campaignMade = false;
  for (const r of rows) {
    const e = asObject(r.changeEvent);
    if (e.resourceChangeOperation !== "CREATE") return { kind: "changed" };
    const type = asString(e.changeResourceType) ?? "?";
    const name = asString(e.changeResourceName) ?? "";
    const at = asString(e.changeDateTime) ?? "";
    seen.push(JSON.stringify([type, name, at]));
    if (type === "CAMPAIGN" && name === campaign && at) campaignMade = true;
    const n = (created.get(type) ?? 0) + 1;
    created.set(type, n);
    if (n > (made.get(type) ?? 0)) added = true;
  }
  // Its own creates must be there: the campaign's, and one per ad group it made.
  if (!campaignMade || (created.get("AD_GROUP") ?? 0) < (made.get("AD_GROUP") ?? 0)) {
    return { kind: "not_ready" };
  }
  return { kind: "ok", added, seen: seen.sort().join("\n") };
};

/**
 * What the change history says happened to the campaign since it was made, read twice
 * HISTORY_GAP_MS apart. Refused (undo_unavailable) unless both reads show this campaign's
 * own creates, nothing but creates, the same events, and the create was applied at least
 * HISTORY_SETTLE_MS ago (madeAt: this server's stored apply time, no time zones involved).
 * Returns whether things were created in it after it was made.
 */
const historySince = async (
  ctx: ReadCtx,
  campaignId: string,
  keys: readonly string[],
  madeAt: string | undefined,
  pauseInstead: string,
): Promise<{ added: boolean }> => {
  const now = ctx.now ?? Date.now;
  const tz = ctx.account.timeZone ?? "UTC";
  const madeMs = madeAt === undefined ? Number.NaN : Date.parse(madeAt);
  // Not dead code: the re-check before sending plans the stored input without re-validating it.
  if (!Number.isFinite(madeMs)) {
    throw new ChangeError(
      "undo_unavailable",
      "This undo doesn't say when the campaign was made, so it can't wait for Google's change history. Propose the undo again.",
    );
  }
  const ready = madeMs + HISTORY_SETTLE_MS;
  if (now() < ready) {
    throw new ChangeError(
      "undo_unavailable",
      `Campaign ${campaignId} was made less than 15 minutes ago and Google's change history lags, so it can't confirm nothing else changed yet. Try the undo again after ${localDateTime(ready, tz)} (${tz}).`,
    );
  }
  const made = new Map<string, number>([
    ["CAMPAIGN", 1],
    ["CAMPAIGN_BUDGET", 1],
  ]);
  for (const k of keys) {
    let kind: unknown;
    try {
      kind = (JSON.parse(k) as unknown[])[0];
    } catch {
      continue;
    }
    for (const t of MADE_TYPES[String(kind)] ?? []) made.set(t, (made.get(t) ?? 0) + 1);
  }
  const notReady = new ChangeError(
    "undo_unavailable",
    "Google's change history doesn't show this campaign's creation yet, so it can't confirm nothing else changed. Try the undo again in a few minutes.",
  );
  const check = (h: HistoryRead): { added: boolean; seen: string } => {
    if (h.kind === "changed") {
      throw new ChangeError(
        "undo_unavailable",
        `Google's change history shows campaign ${campaignId} was changed after it was made (it may have been switched on and run; Google's numbers can lag by hours), so it is not removed; ${pauseInstead}`,
      );
    }
    if (h.kind === "unknown") {
      throw new ChangeError(
        "undo_unavailable",
        `Campaign ${campaignId}'s change history is too long to check, so it is not removed; ${pauseInstead}`,
      );
    }
    if (h.kind !== "ok") throw notReady;
    return h;
  };
  const first = check(await readHistory(ctx, campaignId, made));
  // The wait, the second read and (before sending) the send itself must all fit.
  const needs = HISTORY_GAP_MS + HISTORY_READ_MS + (ctx.sendReserveMs ?? 0);
  if (ctx.deadlineAt !== undefined && ctx.deadlineAt - now() < needs) {
    throw new ChangeError(
      "read_failed",
      "Not enough time was left to read Google's change history twice before the deadline.",
    );
  }
  await (ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(
    HISTORY_GAP_MS,
  );
  const second = check(await readHistory(ctx, campaignId, made));
  // Google's history answered differently a moment apart: not reliable yet.
  if (second.seen !== first.seen) throw notReady;
  return { added: first.added };
};

const planUndo = async (ctx: ReadCtx, u: z.infer<typeof undoInput>["undo"]): Promise<Planned> => {
  const cid = ctx.target.customerId;
  const label = u.campaign_name;
  let c: LiveCampaign | null;
  try {
    c = await findCampaign(ctx, label, u.campaign_id);
  } catch (err) {
    if (err instanceof ChangeError && err.message.startsWith("More than one")) {
      throw new ChangeError(
        "undo_unavailable",
        "More than one campaign has this name now; remove it in Google Ads.",
      );
    }
    throw err;
  }
  if (!c) throw new ChangeError("nothing_to_change", "Nothing to undo: the campaign is gone.");
  const pauseInstead = `pause it with update_campaign_status (campaign ${c.id}) instead.`;
  if (c.status === "ENABLED") {
    throw new ChangeError(
      "undo_unavailable",
      `Campaign ${c.id} is turned on, so it may be showing ads and spending; it is not removed. Undo only removes a campaign that never ran; ${pauseInstead}`,
    );
  }
  // This server's own changes on it (switched on, budget, bidding, keywords, ...).
  if (!ctx.sentOnCampaign) {
    throw new ChangeError(
      "undo_unavailable",
      `Couldn't check this server's own changes on campaign ${c.id}, so it is not removed; ${pauseInstead}`,
    );
  }
  const sent = ctx.sentOnCampaign(c.id);
  if (sent.length) {
    const first = sent[0];
    throw new ChangeError(
      "undo_unavailable",
      `Campaign ${c.id} was changed after it was made (change ${first?.id ?? "?"}, ${first?.type ?? "?"}, ${first?.status ?? "?"}${sent.length > 1 ? `, and ${sent.length - 1} more` : ""}), so it may have run; it is not removed. Undo only removes a campaign that never ran; ${pauseInstead}`,
    );
  }
  // Lifetime totals (no date range in the query = all time). No row = can't tell.
  const m = await gaql(
    ctx,
    `SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE campaign.id = ${assertId(c.id)}`,
    "the campaign's results",
  );
  if (!m[0]) {
    throw new ChangeError(
      "undo_unavailable",
      `Couldn't read whether campaign ${c.id} has run (Google returned no results row), so it is not removed; ${pauseInstead}`,
    );
  }
  const metrics = asObject(m[0].metrics);
  const impressions = microsField(metrics.impressions);
  const clicks = microsField(metrics.clicks);
  const cost = microsField(metrics.costMicros);
  if (impressions === null || clicks === null || cost === null) {
    throw new ChangeError("read_failed", "Couldn't read whether the campaign has run.");
  }
  if (impressions !== "0" || clicks !== "0" || cost !== "0") {
    throw new ChangeError(
      "undo_unavailable",
      `Campaign ${c.id} has run (${impressions} impressions, ${clicks} clicks, ${formatMoney(cost, ctx.account.currencyCode)} spent), so it is not removed (its results would go with it); ${pauseInstead}`,
    );
  }
  const history = await historySince(ctx, c.id, u.keys, u.made_at, pauseInstead);
  if (history.added) {
    throw new ChangeError(
      "undo_stale",
      `Google's change history shows things were added to campaign ${c.id} after it was made, so removing it would remove those too. Nothing was proposed; change it in Google Ads.`,
    );
  }
  const tree = await readTree(ctx, label, c, true);
  const expect = new Set(u.keys);
  const extra = [...tree.keys()].filter((k) => isItemKey(k) && !expect.has(k));
  if (extra.length) {
    throw new ChangeError(
      "undo_stale",
      `${plural(extra.length, "thing was", "things were")} added to the campaign after it was made, so removing it would remove those too. Nothing was proposed; change it in Google Ads.`,
    );
  }
  const ops: JsonObject[] = [
    { campaignOperation: { remove: resourceName(cid, "campaigns", c.id) } },
  ];
  const removeBudget = u.remove_budget && c.budgetId !== null && !c.budgetShared;
  if (removeBudget && c.budgetId) {
    ops.push({
      campaignBudgetOperation: { remove: resourceName(cid, "campaignBudgets", c.budgetId) },
    });
  }
  const keys = [...u.keys].sort();
  return {
    ops,
    readTarget: { resource: "campaign", id: label, scope: { label, campaign_id: c.id, keys } },
    touched: Object.fromEntries(keys.map((k) => [k, tree.get(k) ?? "absent"])),
    expected: Object.fromEntries(keys.map((k) => [k, "absent"])),
    diff: [
      `Removes campaign ${c.id} (made by the change being undone) with everything in it${removeBudget ? `, and its own budget ${c.budgetId ?? ""}` : ""}. It never ran: no impressions, clicks or spend.`,
    ],
    affected: [{ kind: "campaign", id: c.id, name: c.name, status: c.status }],
    facts: {
      affectedCampaignIds: [c.id],
      items: [
        { kind: "campaign", created: 0, updated: 0, removed: 1 },
        ...(removeBudget ? [{ kind: "campaign_budget", created: 0, updated: 0, removed: 1 }] : []),
      ],
    },
    warnings: [],
    undo: {
      supported: false,
      why: "This is an undo; propose the campaign again instead.",
      level: "none",
    },
    targetKeys: unique([
      `campaigns/new:${label}`,
      `campaigns/${c.id}`,
      ...(removeBudget && c.budgetId ? [`campaignBudgets/${c.budgetId}`] : []),
    ]),
  };
};

/** The new campaign's id from Google's per-operation results (null when not recorded). */
const createdCampaignId = (results: readonly LandedResult[] | null | undefined): string | null => {
  for (const r of results ?? []) {
    const id = r.ok
      ? /^customers\/\d{10}\/campaigns\/(\d+)$/.exec(r.resourceName ?? "")?.[1]
      : null;
    if (id) return id;
  }
  return null;
};

export const createCampaign: ActionType<CreateCampaignInput> = {
  type: "create_campaign",
  summary:
    "Make a new Search campaign from plain fields (created PAUSED; optional ad groups, keywords, one RSA each, campaign negatives), in one atomic change.",
  input: createCampaignInput as unknown as z.ZodType<CreateCampaignInput>,
  undoInputSchema: undoInput as unknown as z.ZodType<CreateCampaignInput>,
  independentOps: false,
  itemKeys: true,

  async plan(ctx, input) {
    if ("undo" in input) return planUndo(ctx, input.undo);
    return planForward(ctx, input);
  },

  readTouched: readCreated,
  fromMutateResults: () => null,

  undoInput(payload, before, _readTarget, results, appliedAt) {
    if ("undo" in payload) return null;
    if (!appliedAt) {
      throw new ChangeError(
        "undo_unavailable",
        "This server has no record of when the campaign was made, so undo can't wait for Google's change history. Remove it in Google Ads.",
      );
    }
    const fromResults = createdCampaignId(results);
    return {
      undo: {
        campaign_name: payload.name,
        ...(fromResults ? { campaign_id: fromResults } : {}),
        remove_budget: payload.shared_budget_id === undefined,
        made_at: appliedAt,
        keys: Object.keys(before).sort(),
      },
    };
  },

  // The campaign's id is not known before it exists: an unclear send is settled by reading.
  historyWhere: () => null,

  modelTexts(input) {
    if ("undo" in input) return [];
    return [
      { label: "Campaign name", items: [input.name] },
      ...(input.ad_groups.length
        ? [{ label: "Ad group names (in order)", items: input.ad_groups.map((g) => g.name) }]
        : []),
      ...input.ad_groups.flatMap((g, i) => [
        ...(g.keywords.length
          ? [
              {
                label: `Ad group ${i + 1} keywords (match type: text)`,
                items: g.keywords.map((k) => `${k.match_type}: ${k.text}`),
              },
            ]
          : []),
        ...(g.ad
          ? [
              { label: `Ad group ${i + 1} ad final URL`, items: [g.ad.final_url] },
              {
                label: `Ad group ${i + 1} ad headlines (in order)`,
                items: g.ad.headlines.map((h) => h.text),
              },
              {
                label: `Ad group ${i + 1} ad descriptions (in order)`,
                items: g.ad.descriptions.map((d) => d.text),
              },
              ...(g.ad.path1 !== undefined
                ? [
                    {
                      label: `Ad group ${i + 1} ad display paths (1, 2)`,
                      items: [g.ad.path1, g.ad.path2 ?? ""],
                    },
                  ]
                : []),
            ]
          : []),
      ]),
      ...(input.negatives.length
        ? [
            {
              label: "Campaign negative keywords (match type: text)",
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
