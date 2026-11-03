// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The fake account's parts for change types 4-10: negatives, shared lists, ad groups and
// keywords, responsive search ads, sitelink / callout assets, audience lists and the
// conversion reads of the negatives safety gate. Replies are
// shaped like Google's documented REST replies (camelCase JSON). Fake ids only.

type Obj = Record<string, unknown>;

export interface MoreWorld {
  campaignNegatives: {
    campaignId: string;
    criterionId: string;
    text: string;
    matchType: string;
    status: string;
  }[];
  exclusions: { campaignId: string; criterionId: string; userListId: string; status: string }[];
  sharedSets: { id: string; name: string; type: string; status: string }[];
  sharedCriteria: { setId: string; criterionId: string; text: string; matchType: string }[];
  campaignSharedSets: { campaignId: string; setId: string; status: string }[];
  adGroups: { id: string; name: string; status: string; campaignId: string }[];
  keywords: {
    adGroupId: string;
    criterionId: string;
    text: string;
    matchType: string;
    status: string;
    cpcBidMicros?: string;
  }[];
  ads: {
    adGroupId: string;
    adId: string;
    type: string;
    status: string;
    headlines: { text: string; pinnedField?: string }[];
    descriptions: { text: string; pinnedField?: string }[];
    path1?: string;
    path2?: string;
    reviewStatus: string;
  }[];
  assets: { id: string; sitelink?: Obj; callout?: Obj; finalUrls?: string[] }[];
  campaignAssets: { campaignId: string; assetId: string; fieldType: string; status: string }[];
  userLists: { id: string; name: string; membershipStatus: string }[];
  /** Searches / keywords with conversions in the window (the fake ignores the dates). */
  searchTerms: { text: string; campaignId: string; conversions: number; allConversions?: number }[];
  pmaxTerms: { text: string; campaignId: string; conversions: number; allConversions?: number }[];
  convertingKeywords: {
    text: string;
    campaignId: string;
    conversions: number;
    allConversions?: number;
  }[];
  /** campaign_search_term_view refuses (best-effort read). */
  pmaxViewFails?: boolean;
  nextId: number;
}

export const moreWorld = (): MoreWorld => ({
  campaignNegatives: [],
  exclusions: [],
  sharedSets: [],
  sharedCriteria: [],
  campaignSharedSets: [],
  adGroups: [{ id: "444", name: "Shoes group", status: "ENABLED", campaignId: "333" }],
  keywords: [],
  ads: [
    {
      adGroupId: "444",
      adId: "555",
      type: "RESPONSIVE_SEARCH_AD",
      status: "ENABLED",
      headlines: [
        { text: "Shoes", pinnedField: "HEADLINE_1" },
        { text: "Fast delivery" },
        { text: "Free returns" },
      ],
      descriptions: [{ text: "Shop our shoes." }, { text: "Many sizes." }],
      path1: "shoes",
      path2: "",
      reviewStatus: "REVIEWED",
    },
  ],
  assets: [],
  campaignAssets: [],
  userLists: [{ id: "666", name: "Buyers", membershipStatus: "OPEN" }],
  searchTerms: [],
  pmaxTerms: [],
  convertingKeywords: [],
  nextId: 9000,
});

const idsIn = (query: string, field: string): string[] | null => {
  const f = field.replace(/\./g, "\\.");
  const inList = new RegExp(`${f} IN \\(([^)]*)\\)`).exec(query)?.[1];
  if (inList !== undefined) return inList.split(",").map((s) => s.trim().replace(/'/g, ""));
  const eq = new RegExp(`${f} = '?([^' ]+)'?`).exec(query)?.[1];
  return eq ? [eq] : null;
};

const has = (list: string[] | null, v: string): boolean => list === null || list.includes(v);

/** Answers a search for the parts above; undefined when the query is not one of them. */
export const moreSearch = (
  m: MoreWorld,
  cid: string,
  query: string,
  campaignOf: (id: string) => Obj | undefined = () => undefined,
): Obj[] | undefined => {
  const from = /FROM (\w+)/.exec(query)?.[1];
  const rn = (c: string, id: string) => `customers/${cid}/${c}/${id}`;
  if (from === "search_term_view") {
    return m.searchTerms.map((t) => ({
      searchTermView: { searchTerm: t.text },
      campaign: { id: t.campaignId },
      metrics: { conversions: t.conversions, allConversions: t.allConversions ?? t.conversions },
    }));
  }
  if (from === "campaign_search_term_view") {
    if (m.pmaxViewFails) throw new Error("fake google: campaign_search_term_view refused");
    return m.pmaxTerms.map((t) => ({
      campaignSearchTermView: { searchTerm: t.text },
      campaign: { id: t.campaignId },
      metrics: { conversions: t.conversions, allConversions: t.allConversions ?? t.conversions },
    }));
  }
  if (from === "keyword_view") {
    return m.convertingKeywords.map((k) => ({
      adGroupCriterion: { keyword: { text: k.text } },
      campaign: { id: k.campaignId },
      metrics: { conversions: k.conversions, allConversions: k.allConversions ?? k.conversions },
    }));
  }
  if (from === "campaign_criterion") {
    const campaigns = idsIn(query, "campaign.id");
    if (query.includes("campaign_criterion.type = 'USER_LIST'")) {
      return m.exclusions
        .filter((e) => e.status !== "REMOVED" && has(campaigns, e.campaignId))
        .map((e) => ({
          campaign: { id: e.campaignId },
          campaignCriterion: {
            criterionId: e.criterionId,
            userList: { userList: rn("userLists", e.userListId) },
          },
        }));
    }
    return m.campaignNegatives
      .filter((n) => n.status !== "REMOVED" && has(campaigns, n.campaignId))
      .map((n) => ({
        campaign: { id: n.campaignId },
        campaignCriterion: {
          criterionId: n.criterionId,
          keyword: { text: n.text, matchType: n.matchType },
        },
      }));
  }
  if (from === "shared_set") {
    const id = idsIn(query, "shared_set.id");
    const name = /shared_set\.name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1]?.replace(/\\(.)/g, "$1");
    const onlyEnabled = query.includes("shared_set.status = 'ENABLED'");
    return m.sharedSets
      .filter((s) => (id ? id.includes(s.id) : true))
      .filter((s) => (name !== undefined ? s.name === name : true))
      .filter((s) => (onlyEnabled ? s.status === "ENABLED" : true))
      .map((s) => ({ sharedSet: { id: s.id, name: s.name, type: s.type, status: s.status } }));
  }
  if (from === "shared_criterion") {
    const set = idsIn(query, "shared_set.id");
    return m.sharedCriteria
      .filter((c) => has(set, c.setId))
      .map((c) => ({
        sharedCriterion: {
          criterionId: c.criterionId,
          keyword: { text: c.text, matchType: c.matchType },
        },
      }));
  }
  if (from === "campaign_shared_set") {
    const set = idsIn(query, "shared_set.id");
    return m.campaignSharedSets
      .filter((l) => l.status === "ENABLED" && has(set, l.setId))
      .map((l) => ({
        campaign: {
          id: l.campaignId,
          name: `Campaign ${l.campaignId}`,
          status: "ENABLED",
          ...campaignOf(l.campaignId),
        },
      }));
  }
  if (from === "ad_group") {
    const id = idsIn(query, "ad_group.id");
    return m.adGroups
      .filter((g) => has(id, g.id))
      .map((g) => ({
        adGroup: { id: g.id, name: g.name, status: g.status },
        campaign: {
          id: g.campaignId,
          name: `Campaign ${g.campaignId}`,
          status: "ENABLED",
          ...campaignOf(g.campaignId),
        },
      }));
  }
  if (from === "ad_group_criterion") {
    const groups = idsIn(query, "ad_group.id");
    const crits = idsIn(query, "ad_group_criterion.criterion_id");
    const group = (id: string) => m.adGroups.find((g) => g.id === id);
    return m.keywords
      .filter((k) => has(groups, k.adGroupId) && has(crits, k.criterionId))
      .filter((k) => !query.includes("status != 'REMOVED'") || k.status !== "REMOVED")
      .map((k) => ({
        adGroup: { id: k.adGroupId, name: group(k.adGroupId)?.name ?? null },
        campaign: { id: group(k.adGroupId)?.campaignId ?? "0" },
        adGroupCriterion: {
          criterionId: k.criterionId,
          status: k.status,
          negative: false,
          type: "KEYWORD",
          keyword: { text: k.text, matchType: k.matchType },
        },
      }));
  }
  if (from === "ad_group_ad") {
    const group = idsIn(query, "ad_group.id");
    const ad = idsIn(query, "ad_group_ad.ad.id");
    return m.ads
      .filter((a) => has(group, a.adGroupId) && has(ad, a.adId))
      .map((a) => ({
        adGroup: { id: a.adGroupId, name: "Shoes group" },
        campaign: { id: m.adGroups.find((g) => g.id === a.adGroupId)?.campaignId ?? "0" },
        adGroupAd: {
          status: a.status,
          policySummary: { reviewStatus: a.reviewStatus },
          ad: {
            id: a.adId,
            type: a.type,
            responsiveSearchAd: {
              headlines: a.headlines,
              descriptions: a.descriptions,
              ...(a.path1 ? { path1: a.path1 } : {}),
              ...(a.path2 ? { path2: a.path2 } : {}),
            },
          },
        },
      }));
  }
  if (from === "campaign_asset") {
    const campaign = idsIn(query, "campaign.id");
    const kind = /campaign_asset\.field_type = '(\w+)'/.exec(query)?.[1];
    return m.campaignAssets
      .filter((l) => l.status !== "REMOVED" && has(campaign, l.campaignId) && l.fieldType === kind)
      .map((l) => {
        const a = m.assets.find((x) => x.id === l.assetId);
        return {
          campaign: { id: l.campaignId },
          campaignAsset: {
            resourceName: `customers/${cid}/campaignAssets/${l.campaignId}~${l.assetId}~${l.fieldType}`,
            status: l.status,
          },
          asset: {
            id: l.assetId,
            ...(a?.sitelink ? { sitelinkAsset: a.sitelink } : {}),
            ...(a?.callout ? { calloutAsset: a.callout } : {}),
            ...(a?.finalUrls ? { finalUrls: a.finalUrls } : {}),
          },
        };
      });
  }
  if (from === "user_list") {
    const id = idsIn(query, "user_list.id");
    return m.userLists
      .filter((u) => has(id, u.id))
      .map((u) => ({
        userList: {
          id: u.id,
          name: u.name,
          type: "CRM_BASED",
          membershipStatus: u.membershipStatus,
        },
      }));
  }
  return undefined;
};

const last = (name: unknown): string => String(name).split("/").pop() ?? "";

/**
 * Applies one mutate operation of these parts; undefined when it is not one of them.
 * `temps` maps temporary resource names to the real ones made in this request.
 */
export const moreMutate = (
  m: MoreWorld,
  cid: string,
  op: Obj,
  temps: Map<string, string>,
): Obj | undefined => {
  const rn = (c: string, id: string) => `customers/${cid}/${c}/${id}`;
  const real = (name: unknown) => temps.get(String(name)) ?? String(name);
  const newId = () => String(m.nextId++);
  const inner = (key: string) => op[key] as Obj | undefined;

  const cc = inner("campaignCriterionOperation");
  if (cc) {
    if (cc.create) {
      const c = cc.create as Obj;
      const campaignId = last(c.campaign);
      const criterionId = newId();
      if (c.userList) {
        m.exclusions.push({
          campaignId,
          criterionId,
          userListId: last((c.userList as Obj).userList),
          status: "ENABLED",
        });
      } else {
        const kw = c.keyword as Obj;
        m.campaignNegatives.push({
          campaignId,
          criterionId,
          text: String(kw.text),
          matchType: String(kw.matchType),
          status: "ENABLED",
        });
      }
      return {
        campaignCriterionResult: {
          resourceName: rn("campaignCriteria", `${campaignId}~${criterionId}`),
        },
      };
    }
    const [campaignId, criterionId] = last(cc.remove).split("~");
    for (const list of [m.campaignNegatives, m.exclusions]) {
      const row = list.find((x) => x.campaignId === campaignId && x.criterionId === criterionId);
      if (row) row.status = "REMOVED";
    }
    return { campaignCriterionResult: { resourceName: String(cc.remove) } };
  }
  const ss = inner("sharedSetOperation");
  if (ss) {
    if (ss.create) {
      const c = ss.create as Obj;
      const id = newId();
      temps.set(String(c.resourceName), rn("sharedSets", id));
      m.sharedSets.push({ id, name: String(c.name), type: String(c.type), status: "ENABLED" });
      return { sharedSetResult: { resourceName: rn("sharedSets", id) } };
    }
    const s = m.sharedSets.find((x) => x.id === last(ss.remove));
    if (s) s.status = "REMOVED";
    return { sharedSetResult: { resourceName: String(ss.remove) } };
  }
  const sc = inner("sharedCriterionOperation");
  if (sc) {
    if (sc.create) {
      const c = sc.create as Obj;
      const setId = last(real(c.sharedSet));
      const kw = c.keyword as Obj;
      const criterionId = newId();
      m.sharedCriteria.push({
        setId,
        criterionId,
        text: String(kw.text),
        matchType: String(kw.matchType),
      });
      return {
        sharedCriterionResult: { resourceName: rn("sharedCriteria", `${setId}~${criterionId}`) },
      };
    }
    const [setId, criterionId] = last(sc.remove).split("~");
    m.sharedCriteria = m.sharedCriteria.filter(
      (x) => !(x.setId === setId && x.criterionId === criterionId),
    );
    return { sharedCriterionResult: { resourceName: String(sc.remove) } };
  }
  const css = inner("campaignSharedSetOperation");
  if (css) {
    if (css.create) {
      const c = css.create as Obj;
      const campaignId = last(c.campaign);
      const setId = last(real(c.sharedSet));
      m.campaignSharedSets.push({ campaignId, setId, status: "ENABLED" });
      return {
        campaignSharedSetResult: {
          resourceName: rn("campaignSharedSets", `${campaignId}~${setId}`),
        },
      };
    }
    const [campaignId, setId] = last(css.remove).split("~");
    const l = m.campaignSharedSets.find((x) => x.campaignId === campaignId && x.setId === setId);
    if (l) l.status = "REMOVED";
    return { campaignSharedSetResult: { resourceName: String(css.remove) } };
  }
  const agc = inner("adGroupCriterionOperation");
  if (agc) {
    if (agc.create) {
      const c = agc.create as Obj;
      const kw = c.keyword as Obj;
      const adGroupId = last(c.adGroup);
      const criterionId = newId();
      m.keywords.push({
        adGroupId,
        criterionId,
        text: String(kw.text),
        matchType: String(kw.matchType),
        status: String(c.status ?? "ENABLED"),
        ...(c.cpcBidMicros ? { cpcBidMicros: String(c.cpcBidMicros) } : {}),
      });
      return {
        adGroupCriterionResult: {
          resourceName: rn("adGroupCriteria", `${adGroupId}~${criterionId}`),
        },
      };
    }
    if (agc.update) {
      const u = agc.update as Obj;
      const [adGroupId, criterionId] = last(u.resourceName).split("~");
      const k = m.keywords.find((x) => x.adGroupId === adGroupId && x.criterionId === criterionId);
      if (!k) throw new Error("fake google: no keyword");
      if (typeof u.status === "string") k.status = u.status;
      return { adGroupCriterionResult: { resourceName: String(u.resourceName) } };
    }
    const [adGroupId, criterionId] = last(agc.remove).split("~");
    const k = m.keywords.find((x) => x.adGroupId === adGroupId && x.criterionId === criterionId);
    if (k) k.status = "REMOVED";
    return { adGroupCriterionResult: { resourceName: String(agc.remove) } };
  }
  const ad = inner("adOperation");
  if (ad) {
    const u = ad.update as Obj;
    const a = m.ads.find((x) => x.adId === last(u.resourceName));
    if (!a) throw new Error("fake google: no ad");
    const r = u.responsiveSearchAd as Obj;
    if (r.headlines) a.headlines = r.headlines as typeof a.headlines;
    if (r.descriptions) a.descriptions = r.descriptions as typeof a.descriptions;
    if (typeof r.path1 === "string") a.path1 = r.path1;
    if (typeof r.path2 === "string") a.path2 = r.path2;
    a.reviewStatus = "REVIEW_IN_PROGRESS";
    return {
      adResult: {
        resourceName: String(u.resourceName),
        ad: {
          id: a.adId,
          responsiveSearchAd: {
            headlines: a.headlines,
            descriptions: a.descriptions,
            path1: a.path1,
            path2: a.path2,
          },
        },
      },
    };
  }
  const as = inner("assetOperation");
  if (as) {
    const c = as.create as Obj;
    const id = newId();
    temps.set(String(c.resourceName), rn("assets", id));
    m.assets.push({
      id,
      ...(c.sitelinkAsset ? { sitelink: c.sitelinkAsset as Obj } : {}),
      ...(c.calloutAsset ? { callout: c.calloutAsset as Obj } : {}),
      ...(c.finalUrls ? { finalUrls: c.finalUrls as string[] } : {}),
    });
    return { assetResult: { resourceName: rn("assets", id) } };
  }
  const ca = inner("campaignAssetOperation");
  if (ca) {
    if (ca.create) {
      const c = ca.create as Obj;
      const campaignId = last(c.campaign);
      const assetId = last(real(c.asset));
      m.campaignAssets.push({
        campaignId,
        assetId,
        fieldType: String(c.fieldType),
        status: "ENABLED",
      });
      return {
        campaignAssetResult: {
          resourceName: rn("campaignAssets", `${campaignId}~${assetId}~${String(c.fieldType)}`),
        },
      };
    }
    const [campaignId, assetId, fieldType] = last(ca.remove).split("~");
    const l = m.campaignAssets.find(
      (x) => x.campaignId === campaignId && x.assetId === assetId && x.fieldType === fieldType,
    );
    if (l) l.status = "REMOVED";
    return { campaignAssetResult: { resourceName: String(ca.remove) } };
  }
  return undefined;
};
