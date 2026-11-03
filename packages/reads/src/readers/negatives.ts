// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Ported from PerfoAds CAMPAIGN_NEGATIVES_QUERY + campaignNegativeRows (campaign level),
// fetchSharedNegativeLists (shared_set + campaign_shared_set), fetchAccountNegatives
// (ACCOUNT_NEGATIVES_QUERY: keywords of NEGATIVE_KEYWORDS and ACCOUNT_LEVEL_NEGATIVE_KEYWORDS
// lists; ACCOUNT_LIST_ATTACHMENT_QUERY: the list attached to the whole account through
// customer_negative_criterion NEGATIVE_KEYWORD_LIST) and fetchAccountPlacementExclusions
// (customer_negative_criterion). Changes: one reader, failures reported per part (PerfoAds
// returned empty lists), campaign names on list links, ad-group-level negative keywords,
// account-level placement lists (PLACEMENT_LIST), ORDER BY on every query so the row cap
// always keeps the same rows.

import * as z from "zod";
import { countBy, plural, shown, unknownBecause } from "../common.js";
import { count, enumValue, get, id, idFromResourceName, text, textOrNull } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { untrustedText, UntrustedSchema, type Untrusted } from "../untrusted.js";

export const NegativeRowSchema = z.object({
  level: z.enum(["ad_group", "campaign", "shared_list", "account"]),
  criterionId: z.string().nullable(),
  type: z.string().nullable().describe("KEYWORD, PLACEMENT, NEGATIVE_KEYWORD_LIST, ..."),
  text: UntrustedSchema.describe("Keyword text, URL, channel, video or app id, or list name"),
  matchType: z.string().nullable(),
  campaignId: z.string().nullable(),
  campaignName: UntrustedSchema.nullable(),
  adGroupId: z.string().nullable(),
  adGroupName: UntrustedSchema.nullable(),
  sharedSetId: z.string().nullable(),
  sharedSetName: UntrustedSchema.nullable(),
  accountListAttached: z
    .boolean()
    .nullable()
    .describe(
      "Account-level list keywords only: true = applies to the whole account, false = list not attached, null = unknown",
    ),
});
export type NegativeRow = z.infer<typeof NegativeRowSchema>;

export const SharedListSchema = z.object({
  id: z.string(),
  name: UntrustedSchema,
  type: z.string().nullable(),
  memberCount: z.number(),
  attachedToAccount: z.boolean().nullable(),
  campaignCount: z.number().nullable(),
  campaignIds: z.array(z.string()).describe("First 20 linked campaigns"),
});
export type SharedList = z.infer<typeof SharedListSchema>;

/** Fields are null when a query they depend on couldn't be read (see parts). */
export const NegativeSummarySchema = z.object({
  negatives: z.number(),
  byLevel: z.record(z.string(), z.number()),
  byMatchType: z.record(z.string(), z.number()),
  sharedLists: z.number().nullable(),
  listsNotLinked: z
    .number()
    .nullable()
    .describe("Shared lists used by no campaign and not attached to the account"),
  campaignsWithNegatives: z.number().nullable(),
});
export type NegativeSummary = z.infer<typeof NegativeSummarySchema>;

export const EMBEDDED_MAX = 20;
export const SHARED_LISTS_SHOWN = 50;
const LIST_TYPES = "('NEGATIVE_KEYWORDS', 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS')";

export const AD_GROUP_NEGATIVES_QUERY = `
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type
    FROM ad_group_criterion
    WHERE campaign.status != 'REMOVED'
      AND ad_group.status != 'REMOVED'
      AND ad_group_criterion.status != 'REMOVED'
      AND ad_group_criterion.negative = TRUE
      AND ad_group_criterion.type = 'KEYWORD'
    ORDER BY ad_group.id, ad_group_criterion.criterion_id`;

export const CAMPAIGN_NEGATIVES_QUERY = `
    SELECT
      campaign.id,
      campaign.name,
      campaign_criterion.criterion_id,
      campaign_criterion.keyword.text,
      campaign_criterion.keyword.match_type
    FROM campaign_criterion
    WHERE campaign.status != 'REMOVED'
      AND campaign_criterion.negative = TRUE
      AND campaign_criterion.type = 'KEYWORD'
    ORDER BY campaign.id, campaign_criterion.criterion_id`;

export const SHARED_SETS_QUERY = `
    SELECT
      shared_set.id,
      shared_set.name,
      shared_set.type,
      shared_set.status,
      shared_set.member_count
    FROM shared_set
    WHERE shared_set.type IN ${LIST_TYPES}
      AND shared_set.status = 'ENABLED'
    ORDER BY shared_set.id`;

/** Resource-name fields are not sortable; campaign.id is. */
export const SHARED_SET_LINKS_QUERY = `
    SELECT
      campaign_shared_set.shared_set,
      campaign_shared_set.campaign,
      campaign_shared_set.status,
      campaign.id,
      campaign.name
    FROM campaign_shared_set
    WHERE campaign_shared_set.status = 'ENABLED'
    ORDER BY campaign.id`;

const listCriteriaQuery = (type: string): string => `
    SELECT
      shared_set.id,
      shared_set.name,
      shared_set.type,
      shared_criterion.criterion_id,
      shared_criterion.keyword.text,
      shared_criterion.keyword.match_type
    FROM shared_criterion
    WHERE shared_set.type = '${type}'
      AND shared_set.status = 'ENABLED'
    ORDER BY shared_set.id, shared_criterion.criterion_id`;

/** The regular lists' keywords. */
export const SHARED_CRITERIA_QUERY = listCriteriaQuery("NEGATIVE_KEYWORDS");

/**
 * The account-level list's keywords, read on their own with their own limit: big regular
 * lists past the limit must not leave the account list unread.
 */
export const ACCOUNT_LIST_CRITERIA_QUERY = listCriteriaQuery("ACCOUNT_LEVEL_NEGATIVE_KEYWORDS");

export const ACCOUNT_EXCLUSIONS_QUERY = `
    SELECT
      customer_negative_criterion.resource_name,
      customer_negative_criterion.id,
      customer_negative_criterion.type,
      customer_negative_criterion.placement.url,
      customer_negative_criterion.youtube_channel.channel_id,
      customer_negative_criterion.youtube_video.video_id,
      customer_negative_criterion.mobile_application.app_id,
      customer_negative_criterion.negative_keyword_list.shared_set,
      customer_negative_criterion.placement_list.shared_set
    FROM customer_negative_criterion
    WHERE customer_negative_criterion.type IN ('PLACEMENT', 'YOUTUBE_CHANNEL', 'YOUTUBE_VIDEO', 'MOBILE_APPLICATION', 'NEGATIVE_KEYWORD_LIST', 'PLACEMENT_LIST')
    ORDER BY customer_negative_criterion.id`;

const LEVEL_ORDER = { ad_group: 0, campaign: 1, shared_list: 2, account: 3 } as const;

const blank = {
  campaignId: null,
  campaignName: null,
  adGroupId: null,
  adGroupName: null,
  sharedSetId: null,
  sharedSetName: null,
  accountListAttached: null,
} as const;

export const negativesReader: ReaderDef<
  null,
  NegativeRow,
  NegativeSummary,
  { sharedLists: SharedList[] },
  { listsTotal: number; listsNotLinked: number }
> = {
  name: "negatives",
  queries: () => ({
    ad_group_negatives: { gaql: AD_GROUP_NEGATIVES_QUERY, label: "ad group negatives" },
    campaign_negatives: { gaql: CAMPAIGN_NEGATIVES_QUERY, label: "campaign negatives" },
    shared_lists: { gaql: SHARED_SETS_QUERY, label: "shared negative lists" },
    shared_list_links: { gaql: SHARED_SET_LINKS_QUERY, label: "which campaigns use each list" },
    shared_list_keywords: {
      gaql: SHARED_CRITERIA_QUERY,
      label: "keywords in shared negative lists",
    },
    account_list_keywords: {
      gaql: ACCOUNT_LIST_CRITERIA_QUERY,
      label: "keywords in the account's own negative list",
    },
    account_exclusions: { gaql: ACCOUNT_EXCLUSIONS_QUERY, label: "account-wide exclusions" },
  }),
  map: (data, _input, _ctx, parts) => {
    // Lists attached to the whole account (customer_negative_criterion NEGATIVE_KEYWORD_LIST).
    const accountRead = partOk(parts, "account_exclusions");
    const attached = new Set<string>();
    for (const row of data.account_exclusions ?? []) {
      const listId = idFromResourceName(
        get(row, "customerNegativeCriterion.negativeKeywordList.sharedSet"),
      );
      if (listId) attached.add(listId);
    }
    const listNames = new Map<string, Untrusted>();
    for (const row of data.shared_lists ?? []) {
      const listId = id(get(row, "sharedSet.id"));
      if (listId) listNames.set(listId, text(get(row, "sharedSet.name")));
    }

    const rows: NegativeRow[] = [];
    for (const row of data.ad_group_negatives ?? []) {
      const keyword = get(row, "adGroupCriterion.keyword.text");
      const adGroupId = id(get(row, "adGroup.id"));
      if (typeof keyword !== "string" || !adGroupId) continue;
      rows.push({
        ...blank,
        level: "ad_group",
        criterionId: id(get(row, "adGroupCriterion.criterionId")),
        type: "KEYWORD",
        text: text(keyword),
        matchType: enumValue(get(row, "adGroupCriterion.keyword.matchType")),
        campaignId: id(get(row, "campaign.id")),
        campaignName: textOrNull(get(row, "campaign.name")),
        adGroupId,
        adGroupName: textOrNull(get(row, "adGroup.name")),
      });
    }
    for (const row of data.campaign_negatives ?? []) {
      const keyword = get(row, "campaignCriterion.keyword.text");
      const campaignId = id(get(row, "campaign.id"));
      if (typeof keyword !== "string" || !campaignId) continue;
      rows.push({
        ...blank,
        level: "campaign",
        criterionId: id(get(row, "campaignCriterion.criterionId")),
        type: "KEYWORD",
        text: text(keyword),
        matchType: enumValue(get(row, "campaignCriterion.keyword.matchType")),
        campaignId,
        campaignName: text(get(row, "campaign.name")),
      });
    }
    for (const row of [
      ...(data.shared_list_keywords ?? []),
      ...(data.account_list_keywords ?? []),
    ]) {
      const keyword = get(row, "sharedCriterion.keyword.text");
      const criterionId = id(get(row, "sharedCriterion.criterionId"));
      if (typeof keyword !== "string" || !criterionId) continue;
      const listId = id(get(row, "sharedSet.id"));
      const accountList = get(row, "sharedSet.type") === "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS";
      rows.push({
        ...blank,
        level: accountList ? "account" : "shared_list",
        criterionId,
        type: "KEYWORD",
        text: text(keyword),
        matchType: enumValue(get(row, "sharedCriterion.keyword.matchType")),
        sharedSetId: listId,
        sharedSetName: textOrNull(get(row, "sharedSet.name")),
        // As PerfoAds: attached = applies; null when the attachment read failed.
        accountListAttached: accountList
          ? accountRead
            ? listId !== null && attached.has(listId)
            : null
          : null,
      });
    }
    for (const row of data.account_exclusions ?? []) {
      const c = (path: string) => get(row, `customerNegativeCriterion.${path}`);
      const type = enumValue(c("type"));
      const criterionId = id(c("id")) ?? idFromResourceName(c("resourceName"));
      const listId =
        idFromResourceName(c("negativeKeywordList.sharedSet")) ??
        idFromResourceName(c("placementList.sharedSet"));
      if (listId) {
        rows.push({
          ...blank,
          level: "account",
          criterionId,
          type,
          text: listNames.get(listId) ?? untrustedText(`list ${listId}`),
          matchType: null,
          sharedSetId: listId,
          sharedSetName: listNames.get(listId) ?? null,
        });
        continue;
      }
      const value =
        c("placement.url") ??
        c("youtubeChannel.channelId") ??
        c("youtubeVideo.videoId") ??
        c("mobileApplication.appId");
      if (typeof value !== "string" || value === "") continue;
      rows.push({
        ...blank,
        level: "account",
        criterionId,
        type,
        text: text(value),
        matchType: null,
      });
    }

    const links = new Map<string, string[]>();
    for (const row of data.shared_list_links ?? []) {
      const listId = idFromResourceName(get(row, "campaignSharedSet.sharedSet"));
      const campaignId = idFromResourceName(get(row, "campaignSharedSet.campaign"));
      if (!listId || !campaignId) continue;
      links.set(listId, [...(links.get(listId) ?? []), campaignId]);
    }
    const linksRead = partOk(parts, "shared_list_links");
    const sharedLists: SharedList[] = [];
    for (const row of data.shared_lists ?? []) {
      const listId = id(get(row, "sharedSet.id"));
      if (!listId) continue;
      const campaigns = (links.get(listId) ?? []).sort((a, b) => a.localeCompare(b));
      sharedLists.push({
        id: listId,
        name: text(get(row, "sharedSet.name")),
        type: enumValue(get(row, "sharedSet.type")),
        memberCount: count(get(row, "sharedSet.memberCount")),
        attachedToAccount: accountRead ? attached.has(listId) : null,
        campaignCount: linksRead ? campaigns.length : null,
        campaignIds: campaigns.slice(0, EMBEDDED_MAX),
      });
    }
    sharedLists.sort((a, b) => a.id.localeCompare(b.id));
    return {
      rows,
      extra: { sharedLists: sharedLists.slice(0, SHARED_LISTS_SHOWN) },
      facts: {
        listsTotal: sharedLists.length,
        listsNotLinked: sharedLists.filter(
          (l) => l.campaignCount === 0 && l.attachedToAccount === false,
        ).length,
      },
    };
  },
  compare: (a, b) =>
    LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
    (a.adGroupId ?? "").localeCompare(b.adGroupId ?? "") ||
    (a.campaignId ?? "").localeCompare(b.campaignId ?? "") ||
    (a.sharedSetId ?? "").localeCompare(b.sharedSetId ?? "") ||
    a.text.untrusted.localeCompare(b.text.untrusted) ||
    (a.matchType ?? "").localeCompare(b.matchType ?? "") ||
    (a.criterionId ?? "").localeCompare(b.criterionId ?? "") ||
    (a.type ?? "").localeCompare(b.type ?? ""),
  summarise: (rows, _extra, _ctx, _input, parts, facts) => {
    const listsOk = partOk(parts, "shared_lists");
    const notLinkedKnown =
      listsOk && partOk(parts, "shared_list_links") && partOk(parts, "account_exclusions");
    return {
      negatives: rows.length,
      byLevel: countBy(rows, (r) => r.level),
      byMatchType: countBy(
        rows.filter((r) => r.type === "KEYWORD"),
        (r) => r.matchType,
      ),
      sharedLists: listsOk ? (facts?.listsTotal ?? 0) : null,
      listsNotLinked: notLinkedKnown ? (facts?.listsNotLinked ?? 0) : null,
      campaignsWithNegatives:
        partOk(parts, "campaign_negatives") && partOk(parts, "ad_group_negatives")
          ? new Set(rows.map((r) => r.campaignId).filter((c) => c !== null)).size
          : null,
    };
  },
  summaryLine: (s, ctx) =>
    `${plural(s.negatives, "negative")} on ${ctx.customerId}: ${s.byLevel.ad_group ?? 0} on ad groups, ${s.byLevel.campaign ?? 0} on campaigns, ${s.byLevel.shared_list ?? 0} in shared lists (lists: ${s.sharedLists ?? unknownBecause("shared_lists")}; not linked anywhere: ${s.listsNotLinked ?? unknownBecause("shared lists, links or account attachments")}), ${s.byLevel.account ?? 0} account-level (keywords, placements, attached lists).`,
  rowLine: (r) =>
    `${r.level} ${r.type ?? "?"} ${shown(r.text)}${r.matchType ? ` ${r.matchType}` : ""}${r.adGroupId ? ` (ad group ${r.adGroupId})` : r.campaignId ? ` (campaign ${r.campaignId})` : ""}${r.sharedSetId ? ` (list ${r.sharedSetId})` : ""}`,
};
