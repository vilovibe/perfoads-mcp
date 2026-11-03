// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Test doubles: a permissive policy and a fake Google Ads account that answers the
// engine's GAQL reads and GoogleAdsService.Mutate calls. Fake ids only.

import {
  errorBody,
  FAKE_CUSTOMER,
  partialFailureError,
  type Call,
  type Reply,
} from "@perfoads/ads-client/testing";
import type { PolicyCheck, PolicyDecision, PolicyRequest } from "../policy.js";
import type { PolicyDefaults } from "../types/actionType.js";
import { moreMutate, moreSearch, moreWorld, type MoreWorld } from "./moreWorld.js";

export { moreWorld, type MoreWorld };
export {
  createHooks,
  createWorld,
  type CreateWorld,
  type CreatedTree,
  type HistoryEvent,
} from "./createWorld.js";

export { FAKE_CUSTOMER };

/** The value, or a test failure when it is missing. */
export const must = <T>(value: T | undefined | null): T => {
  if (value === undefined || value === null) throw new Error("test fixture value missing");
  return value;
};

type Obj = Record<string, unknown>;

/** Allows everything (tier confirm). Tests only: never ship a policy like this. */
export const permissiveTestPolicy = (
  opts: { refuseAtApply?: () => boolean; defaults?: Partial<PolicyDefaults> } = {},
): PolicyCheck & { requests: PolicyRequest[] } => {
  const requests: PolicyRequest[] = [];
  const yes: PolicyDecision = {
    allowed: true,
    tier: "confirm",
    reason: "",
    policy: "test-permissive",
  };
  return {
    name: "test-permissive",
    requests,
    ...(opts.defaults
      ? {
          defaults: () => ({
            newEntitiesPaused: true,
            broadMatchRequiresSmartBidding: true,
            brandTerms: [],
            ...opts.defaults,
          }),
        }
      : {}),
    gate: () => yes,
    check: (r) => {
      requests.push(r);
      if (r.stage === "apply" && opts.refuseAtApply?.()) {
        return {
          allowed: false,
          tier: "blocked",
          reason: "Test policy refused at apply.",
          policy: "test-permissive",
        };
      }
      return yes;
    },
  };
};

export interface FakeBudget {
  id: string;
  name: string;
  amountMicros: string;
  explicitlyShared: boolean;
  period: string;
  status: string;
}

export interface FakeCampaign {
  id: string;
  name: string;
  status: string;
  advertisingChannelType: string;
  budgetId: string;
  biddingStrategyType: string;
  /** Portfolio strategy resource name. */
  biddingStrategy?: string;
  maximizeConversions?: { targetCpaMicros?: string };
  maximizeConversionValue?: { targetRoas?: number };
  targetSpend?: { cpcBidCeilingMicros?: string };
  manualCpc?: { enhancedCpcEnabled?: boolean };
  targetRoas?: { targetRoas?: number };
  targetCpa?: { targetCpaMicros?: string };
}

export interface FakeStrategy {
  id: string;
  name: string;
  type: string;
  status: string;
  targetCpa?: { targetCpaMicros?: string };
  targetRoas?: { targetRoas?: number };
  maximizeConversions?: { targetCpaMicros?: string };
  maximizeConversionValue?: { targetRoas?: number };
}

export interface FakeWorld {
  customer: {
    name: string;
    currencyCode: string;
    testAccount: boolean;
    manager?: boolean;
    timeZone?: string;
  };
  budgets: Record<string, FakeBudget>;
  campaigns: Record<string, FakeCampaign>;
  strategies: Record<string, FakeStrategy>;
  /** change_event rows: resource name + local time in the account's zone ("2026-10-25 12:00:00"). */
  changeEvents?: { name: string; at: string; campaign?: string; adGroup?: string; type?: string }[];
  /** Parts for change types 4-10 (testing/moreWorld.ts). */
  more?: MoreWorld;
  /** metrics.conversions over LAST_30_DAYS per campaign id; missing = no rows (0). */
  conversions30d?: Record<string, number>;
}

export const fakeWorld = (over: Partial<FakeWorld["customer"]> = {}): FakeWorld => ({
  customer: { name: "Test shop", currencyCode: "EUR", testAccount: true, ...over },
  budgets: {
    "222": {
      id: "222",
      name: "Main budget",
      amountMicros: "10000000",
      explicitlyShared: false,
      period: "DAILY",
      status: "ENABLED",
    },
  },
  campaigns: {
    "333": {
      id: "333",
      name: "Search shoes",
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
      budgetId: "222",
      biddingStrategyType: "MAXIMIZE_CONVERSIONS",
      maximizeConversions: { targetCpaMicros: "5000000" },
    },
  },
  strategies: {},
});

const cid = FAKE_CUSTOMER;
const rnBudget = (id: string) => `customers/${cid}/campaignBudgets/${id}`;
const rnCampaign = (id: string) => `customers/${cid}/campaigns/${id}`;
const rnStrategy = (id: string) => `customers/${cid}/biddingStrategies/${id}`;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const budgetJson = (b: FakeBudget): Obj => ({
  resourceName: rnBudget(b.id),
  id: b.id,
  name: b.name,
  amountMicros: b.amountMicros,
  explicitlyShared: b.explicitlyShared,
  period: b.period,
  status: b.status,
});

const campaignJson = (c: FakeCampaign): Obj => {
  const rest: Partial<FakeCampaign> = clone(c);
  delete rest.budgetId;
  return { resourceName: rnCampaign(c.id), ...rest };
};

const strategyJson = (s: FakeStrategy): Obj => ({ resourceName: rnStrategy(s.id), ...clone(s) });

const BIDDING_CONTAINERS = [
  "maximizeConversions",
  "maximizeConversionValue",
  "targetSpend",
  "manualCpc",
  "targetRoas",
  "targetCpa",
] as const;
const TYPE_OF_CONTAINER: Record<string, string> = {
  maximizeConversions: "MAXIMIZE_CONVERSIONS",
  maximizeConversionValue: "MAXIMIZE_CONVERSION_VALUE",
  targetSpend: "TARGET_SPEND",
  manualCpc: "MANUAL_CPC",
  targetRoas: "TARGET_ROAS",
  targetCpa: "TARGET_CPA",
};

export interface FakeGoogle {
  world: FakeWorld;
  /** The hooks in use; tests may swap them mid-test. */
  hooks: FakeGoogleHooks;
  /** Every request, in order. */
  router: (call: Call) => Reply;
  /** Applies a mutate body to the world (used by hooks that "land" a write then fail). */
  applyMutate: (body: Obj, skip?: ReadonlySet<number>) => Obj[];
  /** Real (not validateOnly) mutate calls seen. */
  writes: () => number;
  validations: () => number;
  searches: () => number;
}

export interface FakeGoogleHooks {
  /** Runs first for every real write. Return a reply to answer with it instead. */
  onWrite?: (call: Call, fake: FakeGoogle) => Reply | undefined;
  onValidate?: (call: Call) => Reply | undefined;
  /** Runs first for every search. */
  onSearch?: (call: Call, query: string) => Reply | undefined;
  /** After a real write lands, this many searches still see the old account. */
  lagReads?: number;
  /** The MUTABLE_RESOURCE reply shows these values instead (read-back mismatch). */
  replyOverride?: (resource: Obj) => Obj;
  /** Operations Google refuses (by index). With partialFailure the rest land; else nothing does. */
  failOps?: (index: number, op: Obj) => { type: string; value: string } | undefined;
}

/**
 * Resources on which Google refuses a filter on another resource's field unless that field
 * is selected too (seen live: "The following field must be present in SELECT clause").
 */
const MUST_SELECT_FILTERED = new Set([
  "campaign_asset",
  "ad_group_asset",
  "customer_asset",
  "campaign_budget",
  "geographic_view",
]);

/** The first filtered field such a query does not select, as Google names it; else undefined. */
export const mustSelect = (query: string): string | undefined => {
  const flat = query.replace(/\s+/g, " ");
  const m = /SELECT (.*?) FROM (\w+)(?: WHERE (.*?))?(?: ORDER BY | LIMIT |$)/.exec(flat);
  if (!m?.[2] || !MUST_SELECT_FILTERED.has(m[2]) || !m[3]) return undefined;
  const selected = new Set((m[1] ?? "").split(",").map((f) => f.trim()));
  const own = `${m[2]}.`;
  for (const [field] of m[3].matchAll(/\b[a-z_]+\.[a-z_.]+\b/g)) {
    if (!field.startsWith(own) && !field.startsWith("segments.") && !selected.has(field)) {
      return field;
    }
  }
  return undefined;
};

export const createFakeGoogle = (world: FakeWorld, hooks: FakeGoogleHooks = {}): FakeGoogle => {
  let writes = 0;
  let validations = 0;
  let searches = 0;
  let lagged: FakeWorld | null = null;
  let lagLeft = 0;

  const search = (query: string): Obj[] => {
    const w = lagLeft > 0 && lagged ? lagged : world;
    if (lagLeft > 0) lagLeft--;
    const from = /FROM (\w+)/.exec(query)?.[1];
    const eqId = (field: string) =>
      new RegExp(`${field.replace(/\./g, "\\.")} = (\\d+)`).exec(query)?.[1];
    const eqName = (field: string) =>
      new RegExp(`${field.replace(/\./g, "\\.")} = '([^']+)'`).exec(query)?.[1];
    const campaignRow = (c: FakeCampaign): Obj => {
      const b = w.budgets[c.budgetId];
      return { campaign: campaignJson(c), ...(b ? { campaignBudget: budgetJson(b) } : {}) };
    };
    if (from === "change_event") {
      // Honours the dates like Google: local times compared as text, both bounds required.
      const rn = eqName("change_event.change_resource_name");
      const from = /change_event\.change_date_time >= '([^']+)'/.exec(query)?.[1];
      const to = /change_event\.change_date_time <= '([^']+)'/.exec(query)?.[1];
      if (!from || !to) throw new Error("fake google: change_event needs a date range");
      const names = (field: string): string[] | null => {
        const list = new RegExp(`change_event\\.${field} IN \\(([^)]*)\\)`).exec(query)?.[1];
        if (list !== undefined) return list.split(",").map((x) => x.trim().replace(/'/g, ""));
        const one = new RegExp(`change_event\\.${field} = '([^']+)'`).exec(query)?.[1];
        return one ? [one] : null;
      };
      const campaigns = names("campaign");
      const groups = names("ad_group");
      const kind = /change_event\.change_resource_type = '(\w+)'/.exec(query)?.[1];
      if (!rn && !campaigns && !groups) throw new Error("fake google: change_event needs a filter");
      return (w.changeEvents ?? [])
        .filter((e) => (rn ? e.name === rn : true))
        .filter((e) => (campaigns ? campaigns.includes(e.campaign ?? "") : true))
        .filter((e) => (groups ? groups.includes(e.adGroup ?? "") : true))
        .filter((e) => (kind ? e.type === kind : true))
        .filter((e) => e.at >= from && e.at <= to)
        .map((e) => ({ changeEvent: { changeResourceName: e.name, changeDateTime: e.at } }));
    }
    if (from === "customer") {
      return [
        {
          customer: {
            resourceName: `customers/${cid}`,
            id: cid,
            descriptiveName: w.customer.name,
            currencyCode: w.customer.currencyCode,
            timeZone: w.customer.timeZone ?? "Europe/Amsterdam",
            ...(w.customer.testAccount ? { testAccount: true } : {}),
            ...(w.customer.manager ? { manager: true } : {}),
          },
        },
      ];
    }
    if (from === "campaign_budget") {
      const b = w.budgets[eqId("campaign_budget.id") ?? ""];
      return b ? [{ campaignBudget: budgetJson(b) }] : [];
    }
    if (from === "bidding_strategy") {
      const s = w.strategies[eqId("bidding_strategy.id") ?? ""];
      return s ? [{ biddingStrategy: strategyJson(s) }] : [];
    }
    if (from === "campaign" && /campaign\.id IN \(/.test(query)) {
      const ids = (/campaign\.id IN \(([^)]*)\)/.exec(query)?.[1] ?? "")
        .split(",")
        .map((x) => x.trim());
      return Object.values(w.campaigns)
        .filter((c) => ids.includes(c.id))
        .map((c) => ({ campaign: campaignJson(c) }));
    }
    if (from === "campaign" && /metrics\.conversions/.test(query)) {
      if (!/segments\.date DURING LAST_30_DAYS/.test(query)) {
        throw new Error(`fake google: campaign conversions need LAST_30_DAYS: ${query}`);
      }
      const id = eqId("campaign.id") ?? "";
      const n = w.conversions30d?.[id];
      return w.campaigns[id] && n !== undefined
        ? [{ campaign: { resourceName: rnCampaign(id), id }, metrics: { conversions: n } }]
        : [];
    }
    if (from === "campaign") {
      const id = eqId("campaign.id");
      if (id) {
        const c = w.campaigns[id];
        return c ? [campaignRow(c)] : [];
      }
      const budget = eqName("campaign.campaign_budget");
      const strategy = eqName("campaign.bidding_strategy");
      return Object.values(w.campaigns)
        .filter((c) => c.status !== "REMOVED")
        .filter((c) => (budget ? rnBudget(c.budgetId) === budget : c.biddingStrategy === strategy))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((c) => ({ campaign: campaignJson(c) }));
    }
    const more = w.more
      ? moreSearch(w.more, cid, query, (id) => {
          const c = w.campaigns[id];
          return c ? campaignJson(c) : undefined;
        })
      : undefined;
    if (more) return more;
    throw new Error(`fake google: unknown query ${query}`);
  };

  const idOf = (rn: unknown): string => String(rn).split("/").pop() ?? "";

  const applyMutate = (body: Obj, skip: ReadonlySet<number> = new Set()): Obj[] => {
    const out: Obj[] = [];
    const temps = new Map<string, string>();
    for (const [index, op] of ((body.mutateOperations as Obj[]) ?? []).entries()) {
      if (skip.has(index)) {
        out.push({});
        continue;
      }
      if (op.campaignBudgetOperation) {
        const u = (op.campaignBudgetOperation as Obj).update as Obj;
        const b = world.budgets[idOf(u.resourceName)];
        if (!b) throw new Error("fake google: no budget");
        b.amountMicros = String(u.amountMicros);
        const resource = hooks.replyOverride ? hooks.replyOverride(budgetJson(b)) : budgetJson(b);
        out.push({
          campaignBudgetResult: { resourceName: rnBudget(b.id), campaignBudget: resource },
        });
      } else if (op.campaignOperation) {
        const u = (op.campaignOperation as Obj).update as Obj;
        const c = world.campaigns[idOf(u.resourceName)];
        if (!c) throw new Error("fake google: no campaign");
        if (typeof u.status === "string") c.status = u.status;
        const container = BIDDING_CONTAINERS.find((k) => k in u);
        if (container) {
          for (const k of BIDDING_CONTAINERS) Reflect.deleteProperty(c, k);
          delete c.biddingStrategy;
          const value = clone(u[container]) as Obj;
          if (value.targetCpaMicros === "0") delete value.targetCpaMicros;
          if (value.targetRoas === 0) delete value.targetRoas;
          (c as unknown as Obj)[container] = value;
          c.biddingStrategyType = TYPE_OF_CONTAINER[container] ?? "UNKNOWN";
        }
        const resource = hooks.replyOverride
          ? hooks.replyOverride(campaignJson(c))
          : campaignJson(c);
        out.push({ campaignResult: { resourceName: rnCampaign(c.id), campaign: resource } });
      } else if (op.biddingStrategyOperation) {
        const u = (op.biddingStrategyOperation as Obj).update as Obj;
        const s = world.strategies[idOf(u.resourceName)];
        if (!s) throw new Error("fake google: no strategy");
        for (const k of [
          "targetCpa",
          "targetRoas",
          "maximizeConversions",
          "maximizeConversionValue",
        ] as const) {
          if (k in u) (s as unknown as Obj)[k] = clone(u[k]);
        }
        out.push({
          biddingStrategyResult: {
            resourceName: rnStrategy(s.id),
            biddingStrategy: strategyJson(s),
          },
        });
      } else {
        const done = world.more ? moreMutate(world.more, cid, op, temps) : undefined;
        if (!done) throw new Error("fake google: unknown operation");
        out.push(done);
      }
    }
    return out;
  };

  /**
   * Google refuses removing a shared set that a campaign still uses, unless the same
   * request removes those links first. The index of the refused operation, else undefined.
   */
  const sharedSetInUse = (body: Obj): number | undefined => {
    const ops = (body.mutateOperations as Obj[] | undefined) ?? [];
    const unlinked = new Set<string>();
    for (const [i, op] of ops.entries()) {
      const css = op.campaignSharedSetOperation as Obj | undefined;
      if (typeof css?.remove === "string") unlinked.add(css.remove.split("/").pop() ?? "");
      const ss = op.sharedSetOperation as Obj | undefined;
      if (typeof ss?.remove !== "string") continue;
      const setId = ss.remove.split("/").pop() ?? "";
      const used = (world.more?.campaignSharedSets ?? []).some(
        (l) =>
          l.setId === setId && l.status !== "REMOVED" && !unlinked.has(`${l.campaignId}~${setId}`),
      );
      if (used) return i;
    }
    return undefined;
  };

  const fake: FakeGoogle = {
    world,
    hooks,
    applyMutate,
    writes: () => writes,
    validations: () => validations,
    searches: () => searches,
    router: (call) => {
      const body = (call.body ?? {}) as Obj;
      if (call.url.endsWith("/googleAds:search")) {
        searches++;
        const query = String(body.query);
        const unselected = mustSelect(query);
        if (unselected) {
          return {
            status: 400,
            body: errorBody(400, "INVALID_ARGUMENT", [
              {
                type: "queryError",
                value: "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE",
                message: `The following field must be present in SELECT clause: '${unselected}'.`,
              },
            ]),
          };
        }
        const hooked = hooks.onSearch?.(call, query);
        if (hooked) return hooked;
        return { body: { results: search(query) } };
      }
      if (call.url.endsWith("/googleAds:mutate")) {
        const inUse = sharedSetInUse(body);
        if (inUse !== undefined) {
          return {
            status: 400,
            body: errorBody(400, "INVALID_ARGUMENT", [
              {
                type: "sharedSetError",
                value: "SHARED_SET_IN_USE",
                message: "The shared set cannot be removed because it is in use.",
                path: [["mutate_operations", inUse], ["shared_set_operation"], ["remove"]],
              },
            ]),
          };
        }
        if (body.validateOnly === true) {
          validations++;
          const hooked = hooks.onValidate?.(call);
          if (hooked) return hooked;
          return { body: {}, headers: { "request-id": `fake-validate-${validations}` } };
        }
        writes++;
        const hooked = hooks.onWrite?.(call, fake);
        if (hooked) return hooked;
        if (hooks.lagReads) {
          lagged = clone(world);
          lagLeft = hooks.lagReads;
        }
        const failing = new Map<number, { type: string; value: string }>();
        ((body.mutateOperations as Obj[]) ?? []).forEach((op, i) => {
          const f = hooks.failOps?.(i, op);
          if (f) failing.set(i, f);
        });
        if (failing.size && body.partialFailure !== true) {
          return {
            status: 400,
            body: {
              error: {
                code: 400,
                status: "INVALID_ARGUMENT",
                message: "Request contains an invalid argument.",
                details: [
                  partialFailureError(
                    [...failing].map(([i, f]) => ({ ...f, path: [["mutate_operations", i]] })),
                  ).details[0],
                ],
              },
            },
            headers: { "request-id": `fake-write-${writes}` },
          };
        }
        const responses = applyMutate(body, new Set(failing.keys()));
        return {
          body: {
            mutateOperationResponses: responses,
            ...(failing.size
              ? {
                  partialFailureError: partialFailureError(
                    [...failing].map(([i, f]) => ({
                      ...f,
                      path: [["mutate_operations", i]] as [string, number][],
                    })),
                  ),
                }
              : {}),
          },
          headers: { "request-id": `fake-write-${writes}` },
        };
      }
      throw new Error(`fake google: unexpected ${call.url}`);
    },
  };
  return fake;
};
