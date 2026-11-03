// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The fake account's parts for create_campaign: geo target / language constants, new
// campaigns with everything in them, their lifetime numbers and change history. Plugged
// into the fake Google as hooks (reads it knows, and every Mutate that creates or removes
// a campaign or a budget; all-or-nothing like Google). Fake ids only.

import { errorBody, type Call, type Reply } from "@perfoads/ads-client/testing";
import { localDateTime } from "../time.js";
import type { FakeCampaign, FakeGoogle, FakeGoogleHooks, FakeWorld } from "./index.js";

type Obj = Record<string, unknown>;

export interface CreatedTree {
  criteria: {
    criterionId: string;
    type: string;
    negative: boolean;
    location?: Obj;
    language?: Obj;
    keyword?: Obj;
    device?: Obj;
  }[];
  adGroups: { id: string; name: string; status: string; type: string; cpcBidMicros?: string }[];
  keywords: {
    adGroupId: string;
    criterionId: string;
    type: string;
    negative: boolean;
    status: string;
    keyword: Obj;
  }[];
  ads: { adGroupId: string; adId: string; status: string; ad: Obj }[];
  /** Rows of campaign_asset, campaign_shared_set, ad_group_asset, ad_group_bid_modifier. */
  attached: Record<string, Obj[]>;
}

export interface CreateWorld {
  /** Geo target constants: id -> status (ENABLED / REMOVAL_PLANNED). */
  geo: Record<string, string>;
  /** Language constants: id -> targetable. */
  languages: Record<string, boolean>;
  /** Campaign id -> what is in it. */
  trees: Record<string, CreatedTree>;
  /** Campaign id -> lifetime numbers (null: Google returns no row). */
  metrics: Record<string, { impressions: string; clicks: string; costMicros: string } | null>;
  /** Campaign id -> change_event rows (the creates are added when it is made). */
  history: Record<string, HistoryEvent[]>;
  /** The fake clock; set, the creates are stamped with it (account time zone), like Google. */
  now?: () => number;
  /** Google's history lag: events stamped later than now minus this are not returned yet. */
  historyLagMs?: number;
  /**
   * Campaign id -> what the next change_event reads answer instead, in order (one per read;
   * "empty" = no rows). Models Google's history flipping between all rows and none.
   */
  historyReads?: Record<string, (HistoryEvent[] | "empty")[]>;
  /** The fake clock at each change_event read (set to record them). */
  historyReadAt?: number[];
  /** Runs on a new campaign as Google stores it (read-back mismatch tests). */
  storeAs?: (campaign: Obj) => void;
  nextId: number;
}

export interface HistoryEvent {
  type: string;
  operation: string;
  /** Local time in the account's zone; none = always in the window, no time returned. */
  at?: string;
  /** change_resource_name; none = the campaign's own for a CAMPAIGN event. */
  name?: string;
}

export const createWorld = (): CreateWorld => ({
  geo: { "2840": "ENABLED", "2826": "ENABLED", "1023191": "REMOVAL_PLANNED" },
  languages: { "1000": true, "1001": true, "1019": false },
  trees: {},
  metrics: {},
  history: {},
  nextId: 7000,
});

const last = (name: unknown): string => String(name).split("/").pop() ?? "";

/** Google's device criterion ids (desktop, mobile, tablet). */
const DEVICES = [
  ["30000", "DESKTOP"],
  ["30001", "MOBILE"],
  ["30002", "TABLET"],
] as const;

const GEO_NAMES: Record<string, string> = {
  "2840": "United States",
  "2826": "United Kingdom",
  "1023191": "New York,New York,United States",
};
const LANGUAGE_NAMES: Record<string, string> = { "1000": "English", "1001": "German" };

/** change_event resource type of each create operation. */
const EVENT_TYPE: Record<string, string> = {
  campaignBudgetOperation: "CAMPAIGN_BUDGET",
  campaignOperation: "CAMPAIGN",
  campaignCriterionOperation: "CAMPAIGN_CRITERION",
  adGroupOperation: "AD_GROUP",
  adGroupCriterionOperation: "AD_GROUP_CRITERION",
  adGroupAdOperation: "AD_GROUP_AD",
};

const idsIn = (query: string, field: string): string[] =>
  (new RegExp(`${field.replace(/\./g, "\\.")} IN \\(([^)]*)\\)`).exec(query)?.[1] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const CONTAINER_TYPE: Record<string, string> = {
  targetSpend: "TARGET_SPEND",
  maximizeConversions: "MAXIMIZE_CONVERSIONS",
  maximizeConversionValue: "MAXIMIZE_CONVERSION_VALUE",
  manualCpc: "MANUAL_CPC",
};

/** Touches campaigns or budgets beyond an update (create / remove)? Then it is ours. */
const ours = (ops: Obj[]): boolean =>
  ops.some((op) =>
    ["campaignOperation", "campaignBudgetOperation"].some((k) => {
      const inner = op[k] as Obj | undefined;
      return inner !== undefined && (inner.create !== undefined || inner.remove !== undefined);
    }),
  );

export const createHooks = (w: FakeWorld, cw: CreateWorld): FakeGoogleHooks => {
  const cid = "1234567890";
  const rn = (c: string, id: string) => `customers/${cid}/${c}/${id}`;
  const tz = w.customer.timeZone ?? "Europe/Amsterdam";
  const treeOfGroup = (groupId: string): [string, CreatedTree] | undefined =>
    Object.entries(cw.trees).find(([, t]) => t.adGroups.some((g) => g.id === groupId));
  const reply = (results: Obj[]): Reply => ({ body: { results } });

  const onSearch = (_call: Call, query: string): Reply | undefined => {
    const from = /FROM (\w+)/.exec(query)?.[1];
    if (from === "geo_target_constant") {
      return reply(
        idsIn(query, "geo_target_constant.id")
          .filter((id) => cw.geo[id] !== undefined)
          .map((id) => ({
            geoTargetConstant: { id, status: cw.geo[id], canonicalName: GEO_NAMES[id] ?? "" },
          })),
      );
    }
    if (from === "language_constant") {
      return reply(
        idsIn(query, "language_constant.id")
          .filter((id) => cw.languages[id] !== undefined)
          .map((id) => ({
            languageConstant: { id, targetable: cw.languages[id], name: LANGUAGE_NAMES[id] ?? "" },
          })),
      );
    }
    if (from === "campaign" && query.includes("campaign.name = ")) {
      const name = /campaign\.name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1]?.replace(/\\(.)/g, "$1");
      return reply(
        Object.values(w.campaigns)
          .filter((c) => c.name === name && c.status !== "REMOVED")
          .map((c) => ({ campaign: { id: c.id } })),
      );
    }
    const campaignId = /campaign\.id = (\d+)/.exec(query)?.[1];
    if (from === "campaign" && query.includes("metrics.impressions") && campaignId) {
      const m = cw.metrics[campaignId];
      if (m === null) return reply([]);
      return reply([
        {
          campaign: { id: campaignId },
          metrics: m ?? { impressions: "0", clicks: "0", costMicros: "0" },
        },
      ]);
    }
    const eventsOf = /change_event\.campaign = '([^']+)'/.exec(query)?.[1];
    if (from === "change_event" && eventsOf) {
      const id = last(eventsOf);
      const limit = Number(/LIMIT (\d+)/.exec(query)?.[1] ?? "10000");
      // Local times compared as text, like Google; both bounds required.
      const from = /change_date_time >= '([^']+)'/.exec(query)?.[1];
      const to = /change_date_time <= '([^']+)'/.exec(query)?.[1];
      if (!from || !to) throw new Error("fake google: change_event needs a date range");
      if (cw.now) cw.historyReadAt?.push(cw.now());
      const queued = cw.historyReads?.[id]?.shift();
      const events = queued === "empty" ? [] : (queued ?? cw.history[id] ?? []);
      const lag = cw.historyLagMs;
      const shownUpTo = cw.now && lag !== undefined ? localDateTime(cw.now() - lag, tz) : undefined;
      return reply(
        events
          .filter((e) => e.at === undefined || (e.at >= from && e.at <= to))
          .filter((e) => e.at === undefined || shownUpTo === undefined || e.at <= shownUpTo)
          .slice(0, limit)
          .map((e) => ({
            changeEvent: {
              ...(e.at !== undefined ? { changeDateTime: `${e.at}.123456` } : {}),
              changeResourceType: e.type,
              ...(e.name !== undefined || e.type === "CAMPAIGN"
                ? { changeResourceName: e.name ?? rn("campaigns", id) }
                : {}),
              resourceChangeOperation: e.operation,
              campaign: rn("campaigns", id),
            },
          })),
      );
    }
    const tree = campaignId ? cw.trees[campaignId] : undefined;
    if (!tree) return undefined;
    if (from === "campaign_criterion") {
      return reply(tree.criteria.map((c) => ({ campaignCriterion: c })));
    }
    const groupRow = (id: string) => ({ id });
    if (from === "ad_group") {
      return reply(
        tree.adGroups.filter((g) => g.status !== "REMOVED").map((g) => ({ adGroup: g })),
      );
    }
    if (from === "ad_group_criterion") {
      return reply(
        tree.keywords
          .filter((k) => k.status !== "REMOVED")
          .map((k) => ({
            adGroup: groupRow(k.adGroupId),
            adGroupCriterion: {
              criterionId: k.criterionId,
              type: k.type,
              negative: k.negative,
              status: k.status,
              keyword: k.keyword,
            },
          })),
      );
    }
    if (from && from in tree.attached) return reply(tree.attached[from] ?? []);
    if (
      from === "campaign_asset" ||
      from === "campaign_shared_set" ||
      from === "ad_group_asset" ||
      from === "ad_group_bid_modifier"
    ) {
      return reply([]);
    }
    if (from === "ad_group_ad") {
      return reply(
        tree.ads
          .filter((a) => a.status !== "REMOVED")
          .map((a) => ({
            adGroup: groupRow(a.adGroupId),
            adGroupAd: { status: a.status, ad: { id: a.adId, ...a.ad } },
          })),
      );
    }
    return undefined;
  };

  const onWrite = (call: Call, fake: FakeGoogle): Reply | undefined => {
    const body = (call.body ?? {}) as Obj;
    const ops = (body.mutateOperations as Obj[] | undefined) ?? [];
    if (!ours(ops)) return undefined;
    const failing = ops
      .map((op, i) => [i, fake.hooks.failOps?.(i, op)] as const)
      .filter(([, f]) => f !== undefined);
    if (failing.length) {
      // All or nothing: Google refuses the request and nothing is made.
      return {
        status: 400,
        body: errorBody(
          400,
          "INVALID_ARGUMENT",
          failing.map(([i, f]) => ({
            type: f?.type ?? "requestError",
            value: f?.value ?? "UNKNOWN",
            path: [["mutate_operations", i]],
          })),
        ),
      };
    }
    const temps = new Map<string, string>();
    const real = (name: unknown) => temps.get(String(name)) ?? String(name);
    const next = () => String(cw.nextId++);
    const out: Obj[] = [];
    let madeIn: string | null = null;
    const campaignTree = (name: unknown): CreatedTree => {
      const t = cw.trees[last(real(name))];
      if (!t) throw new Error("fake google: no such new campaign");
      return t;
    };
    for (const op of ops) {
      const inner = (k: string) => op[k] as Obj | undefined;
      const bo = inner("campaignBudgetOperation");
      const co = inner("campaignOperation");
      const cc = inner("campaignCriterionOperation");
      const ag = inner("adGroupOperation");
      const agc = inner("adGroupCriterionOperation");
      const aga = inner("adGroupAdOperation");
      if (bo?.create) {
        const c = bo.create as Obj;
        const id = next();
        temps.set(String(c.resourceName), rn("campaignBudgets", id));
        w.budgets[id] = {
          id,
          name: "",
          amountMicros: String(c.amountMicros),
          explicitlyShared: c.explicitlyShared === true,
          period: String(c.period ?? "DAILY"),
          status: "ENABLED",
        };
        out.push({ campaignBudgetResult: { resourceName: rn("campaignBudgets", id) } });
      } else if (bo?.remove) {
        const b = w.budgets[last(bo.remove)];
        if (!b) throw new Error("fake google: no budget");
        b.status = "REMOVED";
        out.push({ campaignBudgetResult: { resourceName: String(bo.remove) } });
      } else if (co?.create) {
        const c = co.create as Obj;
        const id = next();
        temps.set(String(c.resourceName), rn("campaigns", id));
        const container = Object.keys(CONTAINER_TYPE).find((k) => k in c) ?? "";
        const stored: Obj = {
          id,
          name: c.name,
          status: c.status,
          advertisingChannelType: c.advertisingChannelType,
          budgetId: last(real(c.campaignBudget)),
          biddingStrategyType: CONTAINER_TYPE[container] ?? "UNKNOWN",
          [container]: JSON.parse(JSON.stringify(c[container])) as Obj,
          networkSettings: c.networkSettings,
          geoTargetTypeSetting: c.geoTargetTypeSetting,
          containsEuPoliticalAdvertising: c.containsEuPoliticalAdvertising,
          // Google fills these in when not sent.
          startDateTime: c.startDateTime ?? "2026-10-25 00:00:00",
          endDateTime: c.endDateTime ?? "2037-12-30 23:59:59",
        };
        cw.storeAs?.(stored);
        w.campaigns[id] = stored as unknown as FakeCampaign;
        // Google adds a device row per device to every new campaign, no bid adjustment (seen live).
        cw.trees[id] = {
          criteria: DEVICES.map(([criterionId, type]) => ({
            criterionId,
            type: "DEVICE",
            negative: false,
            device: { type },
          })),
          adGroups: [],
          keywords: [],
          ads: [],
          attached: {},
        };
        madeIn = id;
        out.push({ campaignResult: { resourceName: rn("campaigns", id) } });
      } else if (co?.remove) {
        const c = w.campaigns[last(co.remove)];
        if (!c) throw new Error("fake google: no campaign");
        c.status = "REMOVED";
        out.push({ campaignResult: { resourceName: String(co.remove) } });
      } else if (cc?.create) {
        const c = cc.create as Obj;
        const id = next();
        const type = c.location ? "LOCATION" : c.language ? "LANGUAGE" : "KEYWORD";
        campaignTree(c.campaign).criteria.push({
          criterionId: id,
          type,
          negative: c.negative === true,
          ...(c.location ? { location: c.location as Obj } : {}),
          ...(c.language ? { language: c.language as Obj } : {}),
          ...(c.keyword ? { keyword: c.keyword as Obj } : {}),
        });
        out.push({ campaignCriterionResult: { resourceName: `${real(c.campaign)}~${id}` } });
      } else if (ag?.create) {
        const c = ag.create as Obj;
        const id = next();
        temps.set(String(c.resourceName), rn("adGroups", id));
        campaignTree(c.campaign).adGroups.push({
          id,
          name: String(c.name),
          status: String(c.status),
          type: String(c.type),
          // Google keeps a default bid when none is sent.
          cpcBidMicros: c.cpcBidMicros === undefined ? "10000" : String(c.cpcBidMicros),
        });
        // ... and to every new ad group, as ad group bid modifiers.
        const mods = (campaignTree(c.campaign).attached.ad_group_bid_modifier ??= []);
        for (const [criterionId, type] of DEVICES) {
          mods.push({
            campaign: { id: last(real(c.campaign)) },
            adGroupBidModifier: {
              resourceName: rn("adGroupBidModifiers", `${id}~${criterionId}`),
              criterionId,
              device: { type },
            },
          });
        }
        out.push({ adGroupResult: { resourceName: rn("adGroups", id) } });
      } else if (agc?.create) {
        const c = agc.create as Obj;
        const groupId = last(real(c.adGroup));
        const t = treeOfGroup(groupId);
        if (!t) throw new Error("fake google: no ad group");
        const id = next();
        t[1].keywords.push({
          adGroupId: groupId,
          criterionId: id,
          type: "KEYWORD",
          negative: false,
          status: String(c.status),
          keyword: c.keyword as Obj,
        });
        out.push({
          adGroupCriterionResult: { resourceName: rn("adGroupCriteria", `${groupId}~${id}`) },
        });
      } else if (aga?.create) {
        const c = aga.create as Obj;
        const groupId = last(real(c.adGroup));
        const t = treeOfGroup(groupId);
        if (!t) throw new Error("fake google: no ad group");
        const id = next();
        const ad = c.ad as Obj;
        t[1].ads.push({
          adGroupId: groupId,
          adId: id,
          status: String(c.status),
          ad: { type: "RESPONSIVE_SEARCH_AD", ...ad },
        });
        out.push({ adGroupAdResult: { resourceName: rn("adGroupAds", `${groupId}~${id}`) } });
      } else {
        throw new Error("fake google: unknown operation in a create request");
      }
    }
    if (madeIn !== null) {
      // Google's change history: one CREATE per thing made, on the new campaign.
      cw.history[madeIn] = ops.flatMap((op) =>
        Object.keys(op)
          .filter((k) => (op[k] as Obj).create !== undefined && EVENT_TYPE[k])
          .map((k) => ({
            type: EVENT_TYPE[k] ?? "?",
            operation: "CREATE",
            ...(cw.now ? { at: localDateTime(cw.now(), tz) } : {}),
          })),
      );
    }
    return {
      body: { mutateOperationResponses: out },
      headers: { "request-id": `fake-create-${fake.writes()}` },
    };
  };

  return { onSearch, onWrite };
};
