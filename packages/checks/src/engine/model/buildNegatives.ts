// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Negatives at three levels → NegativeListNode[] + the member index + the
 * per-term blocked resolver.
 *
 * Sources and joins:
 *  - `sharedNegativeLists` (shared_set_id, member_count, linked_campaign_ids[])
 *    → level 'shared_list', attached to the linked campaigns.
 *  - members = `sharedNegativeListMembers` ∪ `accountNegatives` rows carrying a
 *    shared_set_id, deduped on (set, criterion_id). Both tables can
 *    hold the same rows; a set that does not appear in sharedNegativeLists has
 *    UNKNOWN attachment -> attachmentUnknown, attached to every audited campaign.
 *  - `accountNegatives` rows of the account list → level 'account': the set
 *    type is ACCOUNT_LEVEL_NEGATIVE_KEYWORDS and customer_negative_criterion
 *    attaches it (account_level true; null = attachment not read, still the
 *    account list). An account-level set NOT attached applies nowhere and is
 *    skipped. Rows with NO shared_set_id (older syncs) stay level 'account'.
 *  - db account_negative_criteria (content labels / placements) →
 *    one 'account' node per criterion_type.
 *  - db campaign_negatives gated by campaign_negatives_sync_marker.
 *    GUESSED JOIN: the marker's campaign_id is the campaigns.id UUID
 *    (an internal row id), not the Google id; both are accepted.
 */
import { arr, nodeFromMetrics, str, type BuildCtx } from "./context.js";
import { emptyMetrics } from "./metrics.js";
import type { NegativeEntry, NegativeListNode } from "./nodes/NegativeListNode.js";
import type { BlockedState } from "./nodes/SearchTermNode.js";
import type { NegativeIndex } from "./nodes/AccountNode.js";

export interface NegativesBuild {
  lists: NegativeListNode[];
  index: NegativeIndex;
  /** Google campaign ids with a campaign-negatives sync marker. */
  campaignNegativesSynced: Set<string>;
  campaignLevel: Map<string, NegativeListNode>;
  summary: {
    accountNegativesRows: number;
    accountLevelRows: number;
    sharedListMemberRows: number;
    sharedListMemberTotalDeclared: number;
    listsDeclared: number;
    listsSeen: number;
    indexedUnique: number;
  };
  /** shared + account nodes that apply to a campaign. */
  inheritedFor(campaignId: string): NegativeListNode[];
  resolveBlocked(
    term: string,
    campaignId: string,
  ): { campaign: BlockedState; sharedList: BlockedState; account: BlockedState; by: string[] };
}

function entry(r: any): NegativeEntry {
  return {
    criterionId: str(r.criterion_id),
    text: String(r.keyword_text ?? r.text ?? ""),
    matchType: str(r.match_type),
  };
}

function entryKey(e: NegativeEntry): string {
  return e.criterionId ?? `${e.text.toLowerCase()}|${e.matchType ?? ""}`;
}

export function normTerm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[[\]"+]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Google negative-match semantics: EXACT = whole query; PHRASE = words in order; BROAD = all words present. */
export function negativeMatches(term: string, neg: NegativeEntry): boolean {
  const t = normTerm(term);
  const n = normTerm(neg.text);
  if (!n) return false;
  const mt = (neg.matchType ?? "BROAD").toUpperCase();
  if (mt === "EXACT") return t === n;
  if (mt === "PHRASE") return (" " + t + " ").includes(" " + n + " ");
  const words = t.split(" ");
  return n.split(" ").every((w) => words.includes(w));
}

export function buildNegatives(ctx: BuildCtx, parentId: string): NegativesBuild {
  const listRows = ctx.read("sharedNegativeLists");
  const memberRows = ctx.read("sharedNegativeListMembers");
  const accountRows = ctx.read("accountNegatives");
  const criteriaRows = ctx.readDb("account_negative_criteria");
  const campNegRows = ctx.readDb("campaign_negatives");
  const markerRows = ctx.readDb("campaign_negatives_sync_marker");

  const byList = new Map<string, NegativeEntry[]>();
  const seen = new Map<string, Set<string>>();
  const listNames = new Map<string, string>();
  const addMember = (setId: string, e: NegativeEntry, name: string | null) => {
    let s = seen.get(setId);
    if (!s) {
      s = new Set();
      seen.set(setId, s);
      byList.set(setId, []);
    }
    const k = entryKey(e);
    if (s.has(k)) return;
    s.add(k);
    byList.get(setId)!.push(e);
    if (name && !listNames.has(setId)) listNames.set(setId, name);
  };
  const account: NegativeEntry[] = [];
  for (const r of memberRows)
    if (r.shared_set_id != null)
      addMember(String(r.shared_set_id), entry(r), str(r.shared_set_name));
  for (const r of accountRows) {
    const accountList = String(r.shared_set_type ?? "") === "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS";
    if (accountList && r.account_level === false) continue;
    if (accountList || r.shared_set_id == null) account.push(entry(r));
    else addMember(String(r.shared_set_id), entry(r), str(r.shared_set_name));
  }

  const allCampaigns = [...ctx.campaignIds];
  const lists: NegativeListNode[] = [];
  const knownSets = new Set<string>();
  const mk = (id: string, name: string, attrs: NegativeListNode["attrs"]): NegativeListNode => ({
    ...nodeFromMetrics("negativeList", id, name, parentId, emptyMetrics(ctx.w90, attrs.source)),
    attrs,
  });
  for (const r of listRows) {
    const setId = String(r.shared_set_id);
    knownSets.add(setId);
    const linked = arr(r.linked_campaign_ids).map(String);
    const members = byList.get(setId) ?? [];
    lists.push(
      mk(`list:${setId}`, String(r.shared_set_name ?? setId), {
        level: "shared_list",
        listId: setId,
        memberCount: members.length || Number(r.member_count) || 0,
        campaignIds: linked,
        attachmentUnknown: false,
        source: "sharedNegativeLists",
        criterionType: "KEYWORD",
      }),
    );
  }
  for (const [setId, members] of byList) {
    if (knownSets.has(setId)) continue;
    lists.push(
      mk(`list:${setId}`, listNames.get(setId) ?? setId, {
        level: "shared_list",
        listId: setId,
        memberCount: members.length,
        campaignIds: allCampaigns,
        attachmentUnknown: true,
        source: "accountNegatives",
        criterionType: "KEYWORD",
      }),
    );
  }
  if (account.length) {
    lists.push(
      mk("account:keywords", "Account negative keywords", {
        level: "account",
        listId: "account",
        memberCount: account.length,
        campaignIds: allCampaigns,
        attachmentUnknown: false,
        source: "accountNegatives",
        criterionType: "KEYWORD",
      }),
    );
  }
  if (criteriaRows) {
    const byType = new Map<string, any[]>();
    for (const r of criteriaRows) {
      const t = String(r.criterion_type ?? "UNKNOWN");
      (byType.get(t) ?? byType.set(t, []).get(t)!).push(r);
    }
    for (const [t, rows] of byType) {
      lists.push(
        mk(`account:criteria:${t}`, `Account ${t} exclusions`, {
          level: "account",
          listId: "account",
          memberCount: rows.length,
          campaignIds: allCampaigns,
          attachmentUnknown: false,
          source: "account_negative_criteria",
          criterionType: t,
        }),
      );
    }
  }

  // campaign level, gated on the marker
  const campaignNegativesSynced = new Set<string>();
  for (const m of markerRows ?? []) {
    const raw = String(m.campaign_id ?? "");
    const gid = ctx.campaignUuidToId.get(raw) ?? raw;
    if (gid) campaignNegativesSynced.add(gid);
  }
  const byCampaign = new Map<string, NegativeEntry[]>();
  for (const r of campNegRows ?? []) {
    const raw = String(r.campaign_id ?? "");
    const gid = ctx.campaignUuidToId.get(raw) ?? raw;
    (byCampaign.get(gid) ?? byCampaign.set(gid, []).get(gid)!).push(entry(r));
  }
  const campaignLevel = new Map<string, NegativeListNode>();
  for (const cid of campaignNegativesSynced) {
    const members = byCampaign.get(cid) ?? [];
    campaignLevel.set(
      cid,
      mk(`campaign:${cid}`, `Campaign negatives ${cid}`, {
        level: "campaign",
        listId: cid,
        memberCount: members.length,
        campaignIds: [cid],
        attachmentUnknown: false,
        source: "campaign_negatives",
        criterionType: "KEYWORD",
      }),
    );
  }

  const index: NegativeIndex = { byList, account, byCampaign };
  let indexedUnique = account.length;
  for (const m of byList.values()) indexedUnique += m.length;
  const summary = {
    accountNegativesRows: accountRows.length,
    accountLevelRows: account.length,
    sharedListMemberRows: memberRows.length,
    sharedListMemberTotalDeclared: listRows.reduce((s, r) => s + (Number(r.member_count) || 0), 0),
    listsDeclared: listRows.length,
    listsSeen: byList.size,
    indexedUnique,
  };
  const inheritedFor = (campaignId: string) =>
    lists.filter((l) => l.attrs.campaignIds.includes(campaignId));
  const resolveBlocked = (term: string, campaignId: string) => {
    const by: string[] = [];
    let campaign: BlockedState = "unknown";
    if (campaignNegativesSynced.has(campaignId)) {
      const hit = (byCampaign.get(campaignId) ?? []).some((e) => negativeMatches(term, e));
      campaign = hit ? "blocked" : "not_blocked";
      if (hit) by.push(`campaign:${campaignId}`);
    }
    let sharedList: BlockedState = "not_blocked";
    let sharedUnknownOnly = false;
    for (const l of inheritedFor(campaignId)) {
      if (l.attrs.level !== "shared_list" || !l.attrs.listId) continue;
      const hit = (byList.get(l.attrs.listId) ?? []).some((e) => negativeMatches(term, e));
      if (hit) {
        if (l.attrs.attachmentUnknown) sharedUnknownOnly = true;
        else {
          sharedList = "blocked";
        }
        by.push(l.id);
      }
    }
    if (sharedList !== "blocked" && sharedUnknownOnly) sharedList = "unknown";
    const accountHit = account.some((e) => negativeMatches(term, e));
    if (accountHit) by.push("account:keywords");
    const accountState: BlockedState = accountHit ? "blocked" : "not_blocked";
    return { campaign, sharedList, account: accountState, by };
  };
  return {
    lists,
    index,
    campaignNegativesSynced,
    campaignLevel,
    summary,
    inheritedFor,
    resolveBlocked,
  };
}
