// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Slices: SL01, SL02, SL04-SL07 (audiences, geo targeting, devices,
 * demographics), SL03, SL10, SL11 (countries where people were: Google's
 * geographic view, kept apart from the targeted locations) and SL12 (campaign
 * languages against the products' language). SL09 (mobile against desktop)
 * lives in carriedIn.ts.
 *
 * Every slice check computes the account scope AND every campaign scope, and
 * each finding names the scope it is about: a device that loses money inside
 * one campaign can convert well across the account, and a finding scoped to the
 * wrong one is false. Campaign-scoped findings carry `campaignId` /
 * `campaignName` on their scope.
 */
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import { FLOORS } from "../registry/thresholds.js";
import { SLICE_KEY_SEPARATOR } from "../model/nodes/Slice.js";
import type { Slice, SliceDimension } from "../model/nodes/Slice.js";
import type { CampaignNode } from "../model/nodes/CampaignNode.js";
import { ROLLUP_WASTED_COST_90D } from "../scoring/impact.js";
import type { MetricValue } from "../registry/types.js";
import { clientGrossMargin } from "./clientContextGate.js";
import { namesOf } from "./pmax.js";
import {
  campaignsOf,
  type CheckCtx,
  type CheckDefinition,
  type CheckFinding,
  type CheckResult,
  type CheckScope,
  defineCheck,
  finding,
  gateOnData,
  isOk,
  num,
  wasteFloorReason,
} from "./types.js";

const ACCOUNT_SCOPE: CheckScope = { type: "account", id: null, name: null };

// ---------------------------------------------------------------------------
// both scopes, always
// ---------------------------------------------------------------------------

interface ScopeView {
  /** null = the account. */
  campaign: CampaignNode | null;
  slices: Slice[];
  cpa: number | null;
  label: string;
}

/** The account plus every campaign, in one list. */
function bothScopes(ctx: CheckCtx, dim: SliceDimension): ScopeView[] {
  const out: ScopeView[] = [
    {
      campaign: null,
      slices: ctx.model.children.slices[dim],
      cpa: ctx.model.windows.m90.cpa,
      label: "account",
    },
  ];
  for (const c of campaignsOf(ctx)) {
    out.push({
      campaign: c,
      slices: c.children.slices[dim],
      cpa: c.windows.m90.cpa,
      label: c.name,
    });
  }
  return out;
}

function sliceScope(type: CheckScope["type"], s: Slice, view: ScopeView): CheckScope {
  return {
    type,
    id: s.attrs.key,
    name: s.name,
    campaignId: view.campaign?.id ?? null,
    campaignName: view.campaign?.name ?? null,
  };
}

/** The registry metric id for a slice family. */
const SLICE_METRIC: Record<string, string> = {
  device: "SL.device(scope)",
  geo: "SL.geo(scope, country)",
  demographic: "SL.demo(scope, type, value)",
  audience: "SL.audience(scope, criterion)",
  dow: "SL.dow(scope, day)",
  hour: "SL.hour(scope, hour)",
};

function sliceArgs(view: ScopeView, key: string) {
  return view.campaign
    ? { scope: "campaign" as const, campaignId: view.campaign.id, key }
    : { scope: "account" as const, key };
}

/** `SL.<dim>` for one key at one scope; null when the registry refused it. */
function sliceValue(ctx: CheckCtx, dim: SliceDimension, view: ScopeView, key: string) {
  const v = ctx.get(SLICE_METRIC[dim]!, sliceArgs(view, key));
  return isOk(v) ? v : null;
}

/** The cost-per-sale gap shared by SL01 (audience) and SL07 (demographic). */
function cpaGapCheck(
  ctx: CheckCtx,
  dim: "audience" | "demographic",
  claimKey: string,
  scopeType: CheckScope["type"],
  floorClicks: number,
): CheckResult {
  const multiple = ctx.settings.slices.segmentCpaMultiple;
  const findings: CheckFinding[] = [];
  let evaluated = 0;
  // Phase F: the account view counts only the live campaigns' share of a slice. Its
  // own rows add paused campaigns in, and a paused campaign spends nothing a month
  // (a live shop: 90% of "LAL BUYERS" spend came from paused Demand Gen campaigns).
  const live = campaignsOf(ctx);
  // account-level slices that were a gap only with paused campaigns' spend in
  const heldBack: string[] = [];
  const liveTotals = (key: string) => {
    let cost = 0;
    let conv = 0;
    let clicks = 0;
    const cite: MetricValue[] = [];
    for (const c of live) {
      const own = c.children.slices[dim].find((x) => x.attrs.key === key);
      if (!own) continue;
      cost += own.windows.m90.cost ?? 0;
      conv += own.windows.m90.conv ?? 0;
      clicks += own.windows.m90.clicks ?? 0;
      const v = ctx.get(SLICE_METRIC[dim]!, { scope: "campaign" as const, campaignId: c.id, key });
      if (isOk(v)) cite.push(v);
    }
    return { cost, conv, clicks, cpa: conv > 0 ? cost / conv : null, cite };
  };
  for (const view of bothScopes(ctx, dim)) {
    if (view.cpa == null || view.cpa <= 0) continue;
    for (const s of view.slices) {
      const own = s.windows.m90;
      const t =
        view.campaign == null
          ? liveTotals(s.attrs.key)
          : { cost: own.cost, conv: own.conv, clicks: own.clicks ?? 0, cpa: own.cpa, cite: null };
      // the account rows hold paused money too: use them only when the live share is all of it
      const allLive = view.campaign != null || Math.abs((own.cost ?? 0) - (t.cost ?? 0)) < 0.01;
      // the slice was a gap only with paused campaigns' money in: a line, never lost
      const pausedOnlyGap = () =>
        !allLive &&
        (own.clicks ?? 0) >= floorClicks &&
        own.cpa != null &&
        own.cpa > multiple * view.cpa!;
      if (t.clicks < floorClicks || t.cpa == null) {
        if (pausedOnlyGap())
          heldBack.push(
            `${s.name ?? s.attrs.key} (spend ${(own.cost ?? 0).toFixed(2)}, ${(own.conv ?? 0).toFixed(0)} sales; live campaigns ${(t.cost ?? 0).toFixed(2)}, ${(t.conv ?? 0).toFixed(0)} sales)`,
          );
        continue;
      }
      const cpa = t.cpa; // no conversions means no CPA; that is not a CPA gap
      evaluated += 1;
      if (cpa <= multiple * view.cpa) {
        if (pausedOnlyGap())
          heldBack.push(
            `${s.name ?? s.attrs.key} (spend ${(own.cost ?? 0).toFixed(2)}, ${(own.conv ?? 0).toFixed(0)} sales; live campaigns ${(t.cost ?? 0).toFixed(2)}, ${(t.conv ?? 0).toFixed(0)} sales)`,
          );
        continue;
      }
      const v = allLive ? sliceValue(ctx, dim, view, s.attrs.key) : null;
      const cite = v ? [v] : (t.cite ?? []);
      if (cite.length === 0) continue;
      findings.push(
        finding({
          claimKey,
          scope: sliceScope(scopeType, s, view),
          cite,
          entity: { id: s.attrs.key, name: s.name },
          facts: {
            [dim === "audience" ? "SL.audience().cost" : "SL.demo().cost"]: t.cost,
            [dim === "audience" ? "SL.audience().conv" : "SL.demo().conv"]: t.conv,
            slice_cpa: cpa,
            scope_cpa: view.cpa,
            cpa_multiple: cpa / view.cpa,
          },
          population: view.slices.length,
          note: `compared against ${view.label} CPA ${view.cpa.toFixed(2)}${allLive ? "" : "; live campaigns only, paused campaigns' spend left out"}`,
        }),
      );
    }
  }
  const withheld =
    heldBack.length > 0
      ? [
          `${heldBack.length} account-level ${dim} slice(s) held back: the cost per sale is ${multiple}x the account only with paused campaigns' spend in (${heldBack.join(", ")})`,
        ]
      : null;
  // held back is not clean: `fires` with nothing kept claims nothing (see applyActivityGate)
  if (findings.length === 0 && withheld) return { state: "fires", findings: [], withheld };
  if (evaluated === 0)
    return {
      state: "insufficient_data",
      reason: `no ${dim} slice at either scope clears the ${floorClicks}-click floor with a computable CPA`,
    };
  if (findings.length === 0)
    return {
      state: "none_found",
      population: evaluated,
      note: `${evaluated} ${dim} slices across both scopes clear the ${floorClicks}-click floor; none costs ${multiple}x its scope CPA`,
    };
  return { state: "fires", findings, ...(withheld ? { withheld } : {}) };
}

// ---------------------------------------------------------------------------
// SL01 — audience segment costs more per sale
// ---------------------------------------------------------------------------

const SL01 = defineCheck({
  id: "SL01",
  claimKey: CLAIM_KEYS.AUDIENCE_SEGMENT_UNDERPERFORMS,
  title: "audience segment costs more per sale",
  clientLabel: "audiences that cost much more per sale",
  group: "slices",
  metrics: ["SL.audience(scope, criterion)", "C.cpa", "A.cpa"],
  confounders: ["BB09", "MI01"],
  requires: ["campaignAudiencePerf"],
  impactFormula: "IMP_CPA_GAP",
  noneFoundMeans: "No audience segment costs materially more per sale.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["campaignAudiencePerf"]);
    if (g) return g;
    return cpaGapCheck(
      ctx,
      "audience",
      CLAIM_KEYS.AUDIENCE_SEGMENT_UNDERPERFORMS,
      "audience",
      FLOORS.audienceClicks,
    );
  },
});

// ---------------------------------------------------------------------------
// SL02 — remarketing lists worth attaching, attached to no live campaign
// ---------------------------------------------------------------------------

/**
 * Google will not use a list under 1,000 active members on Search
 * (https://support.google.com/google-ads/answer/7558048). A list below that is
 * unusable there, not unused.
 */
const AUDIENCE_MIN_SIZE_FOR_SEARCH = 1_000;

/** Lists Google creates on its own: the account did not build them and cannot be told it forgot them. */
const AUTO_GENERATED_LIST = /\((adwords|google ads)\)|adwords optimi[sz]ed|untitled audience/i;

/**
 * The audiences worth attaching to a shopping account, and nothing else: a
 * named shortlist, because "54 lists sit unattached" tells nobody anything. A
 * list matching more than one pattern takes the first (the most specific).
 */
const AUDIENCE_INTENTS: readonly { intent: string; pattern: RegExp }[] = [
  {
    intent: "engaged, never bought",
    pattern:
      /\b(excl|excluding|not|never|non|no)\b[^a-z]{0,8}(buyer|purchas|bought|order)|no[_ ]purchase/i,
  },
  {
    intent: "high-value or repeat buyers",
    pattern: /\bvip\b|high[- ]value|high spender|good spender|repeat|\d\s*\+\s*orders?/i,
  },
  { intent: "cart abandoners", pattern: /\bcarts?\b|checkout|add[_ ]?to[_ ]?cart|abandon/i },
  { intent: "purchasers", pattern: /buyer|purchas|converter|\bordered\b|orders placed/i },
  {
    intent: "recent visitors",
    pattern:
      /(visitor|engaged)[^0-9]{0,24}\b(7|14|30|60|90)\b|\b(7|14|30|60|90)\b[^0-9]{0,24}(day|dgn|dagen)/i,
  },
];

function audienceIntentOf(name: string | null): string | null {
  if (!name) return null;
  if (AUTO_GENERATED_LIST.test(name)) return null;
  for (const { intent, pattern } of AUDIENCE_INTENTS) if (pattern.test(name)) return intent;
  return null;
}

const SL02 = defineCheck({
  id: "SL02",
  claimKey: CLAIM_KEYS.AUDIENCE_LISTS_UNUSED,
  title: "usable remarketing lists attached to no live campaign",
  clientLabel: "usable remarketing lists that no live campaign uses",
  group: "slices",
  metrics: ["A.audience_lists_count", "A.audience_lists_usable"],
  confounders: ["AS09"],
  requires: ["audienceLists", "campaignAudiencePerf"],
  needsCompleteData: ["campaignAudiencePerf", "audienceLists"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each usable remarketing list is attached to a live campaign.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["audienceLists", "campaignAudiencePerf"]);
    if (g) return g;
    const totalV = ctx.get("A.audience_lists_count");
    const usableV = ctx.get("A.audience_lists_usable");
    const usableCount = num(usableV);
    if (usableCount == null)
      return {
        state: "not_checkable",
        reason: "the number of usable audience lists is not computable",
        table: "audience_lists",
      };

    // a list counts as attached when an audience row at any scope names it
    const attached = new Set<string>();
    const collect = (slices: Slice[]) => {
      for (const s of slices) {
        const id = (s.attrs.extra as { userListId?: unknown }).userListId;
        if (id != null && id !== "") attached.add(String(id));
      }
    };
    collect(ctx.model.children.slices.audience);
    for (const c of campaignsOf(ctx)) collect(c.children.slices.audience);
    /**
     * The rows above are a PERFORMANCE view (lists that served in the window), so
     * they miss lists used as Performance Max audience signals and Demand Gen
     * ad-group audiences. Both count on live campaigns; a part we cannot read is
     * named as an open item, never read as "not attached".
     */
    const unknownParts = new Set<string>();
    for (const c of campaignsOf(ctx)) {
      if (c.attrs.type === "PERFORMANCE_MAX") {
        for (const grp of c.children.assetGroups) {
          if (String(grp.status ?? "ENABLED").toUpperCase() !== "ENABLED") continue;
          if (!grp.attrs.signalsKnown) {
            unknownParts.add("pmax");
            continue;
          }
          for (const sig of grp.children.audienceSignals) {
            if (sig.attrs.userListIds == null) {
              unknownParts.add("pmax");
              continue;
            }
            for (const id of sig.attrs.userListIds) attached.add(id);
          }
        }
      } else if (c.attrs.type === "DEMAND_GEN") {
        const sigs = c.children.dgAudienceSignals;
        if (sigs == null) {
          unknownParts.add("demand_gen");
          continue;
        }
        for (const sig of sigs) {
          if (sig.attrs.userListIds == null) {
            unknownParts.add("demand_gen");
            continue;
          }
          for (const id of sig.attrs.userListIds) attached.add(id);
        }
      }
    }
    // Search / Shopping attachments are only seen once a list has served
    const servedOnlyTypes = campaignsOf(ctx).some(
      (c) => c.attrs.type === "SEARCH" || c.attrs.type === "SHOPPING",
    );

    /**
     * Three narrowings, each removing lists it would be false to call a miss:
     * still collecting members (OPEN), big enough for Google to use on Search,
     * and one of the audiences a shop should be remarketing to.
     */
    const usable = ctx.model.children.audienceLists.filter((l) => (l.sizeForSearch ?? 0) > 0);
    const shortlist = usable
      .map((l) => ({ list: l, intent: audienceIntentOf(l.name) }))
      .filter(
        (r): r is { list: (typeof usable)[number]; intent: string } =>
          r.intent != null &&
          String(r.list.membershipStatus ?? "").toUpperCase() === "OPEN" &&
          (r.list.sizeForSearch ?? 0) >= AUDIENCE_MIN_SIZE_FOR_SEARCH,
      );
    const unattached = shortlist.filter((r) => !attached.has(r.list.listId));
    if (shortlist.length === 0) {
      // an empty shortlist is a limit of the name matching, never a clean bill of health
      return {
        state: "not_checkable",
        reason: `none of the ${usable.length} lists with a search size is an open, usable list recognised by its name as purchasers, cart abandoners, high-value repeat buyers, recent visitors or people who engaged and never bought — so whether a valuable audience is going unused cannot be judged from the names alone`,
        table: "audience_lists",
        category: "our_gap",
      };
    }
    if (unattached.length === 0)
      return {
        state: "none_found",
        population: shortlist.length,
        note: `all ${shortlist.length} of the account's usable buyer, cart, high-value, recent-visitor and never-bought lists are attached somewhere live`,
      };
    const openItems = [
      ...(unknownParts.has("pmax")
        ? [
            "We could not read every list used as a Performance Max audience signal, so some of these may be in use there.",
          ]
        : []),
      ...(unknownParts.has("demand_gen")
        ? [
            "We could not read every audience on the Demand Gen ad groups, so some of these may be in use there.",
          ]
        : []),
      ...(servedOnlyTypes
        ? [
            "A list added to a Search or Shopping campaign that showed no ads in this window does not show up in the data.",
          ]
        : []),
    ];
    return {
      state: "fires",
      findings: [
        {
          ...(openItems.length > 0 ? { openItems } : {}),
          ...finding({
            claimKey: CLAIM_KEYS.AUDIENCE_LISTS_UNUSED,
            scope: ACCOUNT_SCOPE,
            cite: [totalV, usableV],
            facts: {
              counted_on:
                "live campaigns only — a list on a paused campaign counts as not attached",
              "A.audience_lists_count": num(totalV),
              "A.audience_lists_usable": usableCount,
              lists_worth_attaching: shortlist.length,
              unattached_lists: unattached.length,
              attached_lists: shortlist.length - unattached.length,
              biggest_unattached_size: Math.max(
                ...unattached.map((r) => r.list.sizeForSearch ?? 0),
              ),
              minimum_size_google_will_use: AUDIENCE_MIN_SIZE_FOR_SEARCH,
            },
            population: shortlist.length,
            rows: [...unattached]
              .sort(
                (a, b) =>
                  (b.list.sizeForSearch ?? 0) - (a.list.sizeForSearch ?? 0) ||
                  a.list.listId.localeCompare(b.list.listId),
              )
              .map((r) => ({
                entity: { id: r.list.listId, name: r.list.name ?? r.list.listId },
                cells: {
                  audience: r.intent,
                  size_for_search: r.list.sizeForSearch ?? 0,
                  attached: "no",
                },
              })),
            note: `${usable.length} lists carry a search size at all; ${shortlist.length} of them are open, at least ${AUDIENCE_MIN_SIZE_FOR_SEARCH} members and one of the remarketing audience kinds this check reads. ${attached.size} distinct lists are attached to a live campaign`,
          }),
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// SL04 — campaign targets presence OR interest
// ---------------------------------------------------------------------------

const SL04 = defineCheck({
  id: "SL04",
  claimKey: CLAIM_KEYS.GEO_PRESENCE_OR_INTEREST,
  title: "campaign targets presence OR interest",
  clientLabel: "campaigns that also show to people only interested in your locations",
  group: "slices",
  metrics: ["C.geo_target_type", "C.spend"],
  confounders: ["SL03"],
  requires: ["campaigns"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "Each campaign targets people in or regularly in its locations.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["campaigns"]);
    if (g) return g;
    const campaigns = campaignsOf(ctx);
    const findings: CheckFinding[] = [];
    let known = 0;
    for (const c of campaigns) {
      const typeV = ctx.get("C.geo_target_type", { campaignId: c.id });
      if (!isOk(typeV) || typeof typeV.value !== "string") continue;
      known += 1;
      if (!typeV.value.toUpperCase().includes("INTEREST")) continue;
      const spendV = ctx.get("C.spend", { campaignId: c.id });
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.GEO_PRESENCE_OR_INTEREST,
          scope: {
            type: "campaign",
            id: c.id,
            name: c.name,
            campaignId: c.id,
            campaignName: c.name,
          },
          cite: [typeV, spendV],
          entity: { id: c.id, name: c.name },
          facts: { "C.geo_target_type": typeV.value, "C.spend": num(spendV) },
          population: campaigns.length,
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };
    if (known === 0)
      return {
        state: "not_checkable",
        reason: "no campaign carries a location option",
        table: "campaigns",
      };
    return { state: "none_found", population: known };
  },
});

// ---------------------------------------------------------------------------
// SL05 / SL06 — devices
// ---------------------------------------------------------------------------

type ReturnVerdict =
  | "making"
  | "losing"
  | "above_goal"
  | "under_goal"
  | "above_avg"
  | "about_avg"
  | "below_avg"
  | "too_early"
  | "cant_tell";

/** Within this share of the average a return reads as "about average". */
const AVERAGE_BAND = 0.1;

/**
 * One verdict rule on a return: under 1.0 loses money, then the break-even from
 * the owner's margin, then the campaign's goal, then the account average.
 */
function judgeReturn(o: {
  roas: number | null;
  breakEven: number | null;
  goal: number | null;
  average: number | null;
  enough: boolean;
}): ReturnVerdict {
  if (!o.enough) return "too_early";
  if (o.roas == null || !Number.isFinite(o.roas) || o.roas < 0) return "cant_tell";
  if (o.roas < 1) return "losing";
  if (o.breakEven != null && Number.isFinite(o.breakEven) && o.breakEven > 0)
    return o.roas >= o.breakEven ? "making" : "losing";
  if (o.goal != null && Number.isFinite(o.goal) && o.goal > 0)
    return o.roas >= o.goal ? "above_goal" : "under_goal";
  if (o.average != null && Number.isFinite(o.average) && o.average > 0) {
    const r = o.roas / o.average;
    return r >= 1 + AVERAGE_BAND ? "above_avg" : r <= 1 - AVERAGE_BAND ? "below_avg" : "about_avg";
  }
  return "cant_tell";
}

/** A device slice's verdict, "too early" under the device click floor. A fact on the finding, never a gate. */
function deviceVerdict(ctx: CheckCtx, s: Slice, view: ScopeView): ReturnVerdict {
  return judgeReturn({
    roas: s.windows.m90.roas ?? null,
    breakEven: clientGrossMargin(ctx)?.breakEvenRoas ?? null,
    goal: view.campaign?.attrs.targetRoas ?? null,
    average: num(ctx.get("A.roas")),
    enough: (s.windows.m90.clicks ?? 0) >= ctx.settings.slices.deviceMinClicks,
  });
}

const SL05 = defineCheck({
  id: "SL05",
  claimKey: CLAIM_KEYS.DEVICE_CPA_SKEW,
  title: "device costs materially more per sale",
  clientLabel: "devices that cost much more per sale",
  group: "slices",
  metrics: [
    "SL.device(scope)",
    "SL.device_cpa_multiple(scope, device)",
    "C.cpa",
    "A.cpa",
    "A.roas",
  ],
  confounders: ["BB09", "MI01", "SL06"],
  requires: ["deviceData"],
  impactFormula: "IMP_CPA_GAP",
  noneFoundMeans: "No device costs materially more per sale, at campaign or account level.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["deviceData"]);
    if (g) return g;
    const { deviceCpaMultiple, deviceMinClicks } = ctx.settings.slices;
    // a device with ZERO conversions has no CPA: that is SL06's signal, not a CPA gap
    const findings: CheckFinding[] = [];
    let evaluated = 0;
    for (const view of bothScopes(ctx, "device")) {
      if (view.cpa == null || view.cpa <= 0) continue;
      for (const s of view.slices) {
        if ((s.windows.m90.conv ?? 0) <= 0) continue;
        if ((s.windows.m90.clicks ?? 0) < deviceMinClicks) continue;
        const multV = ctx.get(
          "SL.device_cpa_multiple(scope, device)",
          sliceArgs(view, s.attrs.key),
        );
        if (!isOk(multV)) continue;
        const mult = num(multV);
        if (mult == null || !Number.isFinite(mult)) continue;
        evaluated += 1;
        if (mult < deviceCpaMultiple) continue;
        const sliceV = sliceValue(ctx, "device", view, s.attrs.key);
        findings.push(
          finding({
            claimKey: CLAIM_KEYS.DEVICE_CPA_SKEW,
            scope: sliceScope("device", s, view),
            cite: sliceV ? [sliceV, multV] : [multV],
            entity: { id: s.attrs.key, name: s.attrs.key },
            facts: {
              "SL.device().cost": s.windows.m90.cost,
              "SL.device().conv": s.windows.m90.conv,
              "SL.device().cpa": s.windows.m90.cpa,
              scope_cpa: view.cpa,
              cpa_multiple: mult,
              verdict: deviceVerdict(ctx, s, view),
            },
            population: view.slices.length,
            note: `compared against ${view.label} CPA ${view.cpa.toFixed(2)}`,
          }),
        );
      }
    }
    if (evaluated === 0)
      return {
        state: "insufficient_data",
        reason: `no device slice at either scope clears the ${deviceMinClicks}-click floor with conversions`,
      };
    if (findings.length === 0)
      return {
        state: "none_found",
        population: evaluated,
        note: `${evaluated} device slices across both scopes clear the ${deviceMinClicks}-click floor; none reaches ${deviceCpaMultiple}x its scope CPA`,
      };
    return { state: "fires", findings };
  },
});

const SL06 = defineCheck({
  id: "SL06",
  claimKey: CLAIM_KEYS.DEVICE_ZERO_CONV_WASTE,
  title: "device slice spends past the bar without converting",
  clientLabel: "devices that spend without a sale",
  group: "slices",
  // TR06: a device of a campaign that converts nothing at all is the campaign's finding
  confounders: ["SL05", "MI01", "TR06"],
  metrics: ["SL.device_zero_conv(scope)", "SL.device(scope)", "T.waste_floor"],
  requires: ["deviceData"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "No device slice spends past the bar without converting.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["deviceData"]);
    if (g) return g;
    const { deviceMinClicks } = ctx.settings.slices;
    const floorV = ctx.get("T.waste_floor");
    const floor = num(floorV);
    if (floor == null)
      return {
        state: "not_checkable",
        reason: wasteFloorReason(floorV),
        table: "derived",
      };

    // ONE candidate per scope, over every zero-conversion device slice of it, both floors
    // on the SUM: one exclusion decision is the sum it recovers
    const views = bothScopes(ctx, "device");
    const accountView = views[0]!;
    const findings: CheckFinding[] = [];
    let evaluated = 0;
    for (const view of views) {
      // conv == null is unknown, never zero
      const zero = view.slices.filter((s) => s.windows.m90.conv === 0);
      if (zero.length === 0) continue;
      // B14: a campaign where EVERY device converts nothing has no device problem: the
      // campaign converts nothing (TR06's finding, or a campaign still learning)
      if (view.campaign && zero.length === view.slices.length) continue;
      evaluated += 1;
      const cost = zero.reduce((t, s) => t + (s.windows.m90.cost ?? 0), 0);
      const clicks = zero.reduce((t, s) => t + (s.windows.m90.clicks ?? 0), 0);
      if (cost < floor || clicks < deviceMinClicks) continue;
      const aggV = ctx.get(
        "SL.device_zero_conv(scope)",
        view.campaign ? { scope: "campaign", campaignId: view.campaign.id } : { scope: "account" },
      );
      if (!isOk(aggV)) continue;
      const keys = zero.map((s) => s.attrs.key);
      const scopeLabel = view.campaign?.name ?? "account";
      // counter-context: each of these devices at the account scope
      const counterparts = view.campaign
        ? zero
            .map((s) => accountView.slices.find((a) => a.attrs.key === s.attrs.key))
            .filter((a): a is Slice => a != null)
        : [];
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.DEVICE_ZERO_CONV_WASTE,
          cite: [aggV, floorV],
          citeLabelled: [
            ...zero.map((s) => ({
              value: sliceValue(ctx, "device", view, s.attrs.key),
              entity: { id: s.attrs.key, name: s.attrs.key },
            })),
            // B14: the account's own device numbers, labelled as the account's, never the campaign's
            ...counterparts.map((a) => ({
              value: sliceValue(ctx, "device", accountView, a.attrs.key),
              entity: { id: `account:${a.attrs.key}`, name: `account · ${a.attrs.key}` },
            })),
          ],
          entity: { id: view.campaign?.id ?? null, name: scopeLabel },
          scope: {
            type: "device",
            id: keys.join(SLICE_KEY_SEPARATOR),
            name: keys.join(SLICE_KEY_SEPARATOR),
            campaignId: view.campaign?.id ?? null,
            campaignName: view.campaign?.name ?? null,
          },
          facts: {
            // IMP_WASTE_90 prices the SUM: the money one exclusion recovers
            "SL.device().cost": cost,
            "SL.device().conv": 0,
            "SL.device().clicks": clicks,
            "T.waste_floor": floor,
            zero_conv_devices: keys.join(", "),
            zero_conv_device_count: zero.length,
            ...Object.fromEntries(
              zero.map((s) => [`device_${s.attrs.key}_cost`, s.windows.m90.cost]),
            ),
            ...Object.fromEntries(
              zero.map((s) => [`device_${s.attrs.key}_clicks`, s.windows.m90.clicks]),
            ),
            // B14: the same devices across the whole ACCOUNT, kept apart from this scope's numbers
            ...(counterparts.length > 0
              ? {
                  account_context: Object.fromEntries([
                    ["scope", "account"],
                    ...counterparts.flatMap((a) => [
                      [`${a.attrs.key}_cost`, a.windows.m90.cost ?? null],
                      [`${a.attrs.key}_conv`, a.windows.m90.conv ?? null],
                      [`${a.attrs.key}_roas`, a.windows.m90.roas ?? null],
                    ]),
                  ]) as Record<string, number | string | null>,
                }
              : {}),
          },
          population: view.slices.length,
          note: `${view.campaign ? "campaign" : "account"}-scoped; ${keys.join(" + ")} sum to ${cost.toFixed(2)} over ${clicks} clicks with zero conversions`,
        }),
      );
    }
    if (evaluated === 0)
      return {
        state: "none_found",
        population: views.length,
        note: "every device slice at every scope has at least one conversion",
      };
    if (findings.length === 0)
      return {
        state: "none_found",
        population: evaluated,
        note: `${evaluated} scope(s) have a zero-conversion device slice; none sums past the ${floor} money floor and the ${deviceMinClicks}-click floor`,
      };
    return { state: "fires", findings };
  },
});

const SL07 = defineCheck({
  id: "SL07",
  claimKey: CLAIM_KEYS.DEMOGRAPHIC_SEGMENT_UNDERPERFORMS,
  title: "age or gender band costs more per sale",
  clientLabel: "age or gender groups that cost much more per sale",
  group: "slices",
  metrics: ["SL.demo(scope, type, value)", "C.cpa", "A.cpa"],
  confounders: ["BB09", "MI01"],
  requires: ["demographicData"],
  impactFormula: "IMP_CPA_GAP",
  noneFoundMeans: "No age or gender band costs materially more per sale.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["demographicData"]);
    if (g) return g;
    return cpaGapCheck(
      ctx,
      "demographic",
      CLAIM_KEYS.DEMOGRAPHIC_SEGMENT_UNDERPERFORMS,
      "demographic",
      FLOORS.demoClicks,
    );
  },
});

// ---------------------------------------------------------------------------
// Countries (where people were) and languages: SL03, SL10, SL11, SL12
// ---------------------------------------------------------------------------

const PRESENCE = "LOCATION_OF_PRESENCE";

interface CountryTotal {
  id: string;
  name: string;
  code: string | null;
  cost: number;
  clicks: number;
  conv: number;
  value: number;
}

/** A country's name for a sentence: Google's name, else its id. */
const countryName = (r: { id: string; name: string | null }): string =>
  r.name ?? `location ${r.id}`;

/** One campaign's countries summed over their location types (null = not read). */
function countriesOf(c: CampaignNode, onlyPresence = false): CountryTotal[] | null {
  const rows = c.attrs.countries;
  if (rows == null) return null;
  const by = new Map<string, CountryTotal>();
  for (const r of rows) {
    if (onlyPresence && r.locationType !== PRESENCE) continue;
    const t =
      by.get(r.id) ??
      by
        .set(r.id, {
          id: r.id,
          name: countryName(r),
          code: r.code,
          cost: 0,
          clicks: 0,
          conv: 0,
          value: 0,
        })
        .get(r.id)!;
    t.cost += r.cost;
    t.clicks += r.clicks;
    t.conv += r.conv;
    t.value += r.value;
  }
  return [...by.values()].sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id));
}

/** Live campaigns' country rows; `unread` names the live campaigns whose countries were not read. */
function liveCountries(
  ctx: CheckCtx,
  onlyPresence: boolean,
): { live: { c: CampaignNode; countries: CountryTotal[] }[]; unread: string[] } {
  const live: { c: CampaignNode; countries: CountryTotal[] }[] = [];
  const unread: string[] = [];
  for (const c of campaignsOf(ctx)) {
    const countries = countriesOf(c, onlyPresence);
    if (countries == null) unread.push(c.name);
    else if (countries.some((x) => x.cost > 0))
      live.push({ c, countries: countries.filter((x) => x.cost > 0) });
  }
  return { live, unread };
}

const SL03 = defineCheck({
  id: "SL03",
  claimKey: CLAIM_KEYS.GEO_COUNTRY_UNDERPERFORMS,
  title: "country returns below the account",
  clientLabel: "countries returning less than the account average",
  notCheckableCategory: "nothing_to_compare",
  group: "slices",
  metrics: ["A.roas"],
  confounders: ["SL04", "BB09"],
  requires: ["geo_countries"],
  impactFormula: "IMP_CPA_GAP",
  noneFoundMeans: "Each country with traffic returns in line with the account.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["geo_countries"]);
    if (g) return g;
    const acctRoasV = ctx.get("A.roas");
    const acctRoas = num(acctRoasV);
    if (acctRoas == null)
      return {
        state: "not_checkable",
        reason: "the account's return is not known",
        table: "campaigns",
        category: "thin_data",
      };
    const share = ctx.settings.slices.countryRoasShare;
    const minClicks = ctx.settings.slices.countryMinClicks;
    // the account's countries, and each campaign's own
    const views: { campaign: CampaignNode | null; countries: CountryTotal[] }[] = [];
    const account = new Map<string, CountryTotal>();
    for (const c of campaignsOf(ctx)) {
      // where people were: an area-of-interest row is where they searched about, not from
      const list = countriesOf(c, true) ?? [];
      views.push({ campaign: c, countries: list });
      for (const x of list) {
        const t =
          account.get(x.id) ??
          account.set(x.id, { ...x, cost: 0, clicks: 0, conv: 0, value: 0 }).get(x.id)!;
        t.cost += x.cost;
        t.clicks += x.clicks;
        t.conv += x.conv;
        t.value += x.value;
      }
    }
    views.unshift({ campaign: null, countries: [...account.values()] });
    if (account.size <= 1)
      return {
        state: "not_checkable",
        reason: `${account.size === 0 ? "no country had traffic" : "one country carries all the traffic"}, so there is nothing to compare`,
        table: "geo_countries",
        category: "nothing_to_compare",
      };
    const findings: CheckFinding[] = [];
    let evaluated = 0;
    for (const view of views) {
      // a campaign in one country has nothing of its own to compare
      if (view.campaign && view.countries.length <= 1) continue;
      for (const x of view.countries) {
        if (x.clicks < minClicks || x.cost <= 0) continue;
        evaluated += 1;
        const roas = x.value / x.cost;
        if (roas >= share * acctRoas) continue;
        findings.push(
          finding({
            claimKey: CLAIM_KEYS.GEO_COUNTRY_UNDERPERFORMS,
            scope: {
              type: "geo",
              id: x.id,
              name: x.name,
              campaignId: view.campaign?.id ?? null,
              campaignName: view.campaign?.name ?? null,
            },
            cite: [acctRoasV],
            entity: { id: x.id, name: x.name },
            facts: {
              country_cost_90d: Number(x.cost.toFixed(2)),
              country_conversions_90d: Number(x.conv.toFixed(2)),
              country_clicks_90d: x.clicks,
              country_roas: Number(roas.toFixed(2)),
              "A.roas": acctRoas,
              bar_share_of_account: share,
            },
            population: view.countries.length,
          }),
        );
      }
    }
    if (findings.length > 0) return { state: "fires", findings };
    if (evaluated === 0)
      return {
        state: "insufficient_data",
        reason: `no country has ${minClicks} or more clicks in a scope with more than one country`,
      };
    return { state: "none_found", population: evaluated };
  },
});

const SL10 = defineCheck({
  id: "SL10",
  claimKey: CLAIM_KEYS.GEO_MULTI_COUNTRY_CAMPAIGN,
  title: "one campaign serves two or more countries",
  clientLabel: "campaigns that serve several countries at once",
  group: "slices",
  metrics: ["C.spend"],
  confounders: [],
  requires: ["geo_countries", "campaigns"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Each campaign serves one country.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["geo_countries", "campaigns"]);
    if (g) return g;
    // presence rows: where people WERE (interest rows say where people looked)
    const { live } = liveCountries(ctx, true);
    if (live.length === 0)
      return {
        state: "not_checkable",
        reason: "no live campaign has a country with spend from people in it",
        table: "geo_countries",
        category: "not_present",
      };
    const minShare = ctx.settings.slices.multiCountryMinShare;
    const findings: CheckFinding[] = [];
    for (const { c, countries } of live) {
      const total = countries.reduce((t, x) => t + x.cost, 0);
      const material = countries.filter((x) => total > 0 && x.cost / total >= minShare);
      if (material.length < 2) continue;
      const feed =
        c.attrs.shoppingSettings.state === "synced" ? c.attrs.shoppingSettings.feedLabel : null;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: {
            type: "campaign",
            id: c.id,
            name: c.name,
            campaignId: c.id,
            campaignName: c.name,
          },
          entity: { id: c.id, name: c.name },
          cite: [ctx.get("C.spend", { campaignId: c.id })].filter(isOk),
          facts: {
            countries_with_spend: countries.length,
            countries_over_bar: material.length,
            bar_share: minShare,
            ...(feed ? { feed_label: feed } : {}),
            account_currency: ctx.model.attrs.currencyCode,
          },
          population: live.length,
          rows: countries.slice(0, 10).map((x) => ({
            entity: { id: x.id, name: x.name },
            cells: {
              spend: Number(x.cost.toFixed(2)),
              share_pct: Number(((x.cost / total) * 100).toFixed(1)),
              sales: Number(x.conv.toFixed(2)),
            },
          })),
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };
    return {
      state: "none_found",
      population: live.length,
      note: `${live.length} live campaign(s) with country rows, each mostly one country`,
    };
  },
});

/**
 * The countries the shop sells to: Merchant Center delivery countries when an input
 * carries them, plus the feed labels of the Shopping and Performance Max campaigns
 * that are country codes ("US", "DE"). A snapshot reads no Merchant Center shipping,
 * so there the list is the feed-label countries.
 */
/** ISO 3166-1 alpha-2 country codes (the 249 assigned). A feed label outside them names no country. */
const ISO_COUNTRIES: ReadonlySet<string> = new Set([
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
]);

/** A feed label as a country code ("UK" is Google's alias for GB); null = names no country. */
function countryOfLabel(label: string): string | null {
  const l = label.trim().toUpperCase();
  const code = l === "UK" ? "GB" : l;
  return ISO_COUNTRIES.has(code) ? code : null;
}

function sellingCountries(ctx: CheckCtx): {
  codes: Set<string>;
  source: string[];
  /** why the list may miss countries the shop sells to; null = complete */
  partial: string | null;
} {
  const codes = new Set<string>();
  const source: string[] = [];
  const delivery = ctx.model.attrs.merchantCenter.deliveryCountries ?? [];
  if (delivery.length > 0) {
    delivery.forEach((c) => codes.add(c));
    source.push("Merchant Center shipping");
  }
  // a feed label that names no country (WEB, ONLINE, DE_DE, EU) hides where its products sell
  const notCountries = new Set<string>();
  const countriesOfLabels = (labels: string[]): string[] =>
    labels.flatMap((l) => {
      const code = countryOfLabel(l);
      if (code == null) notCountries.add(l.trim());
      return code == null ? [] : [code];
    });
  const labels = countriesOfLabels(
    campaignsOf(ctx)
      .map((c) =>
        c.attrs.shoppingSettings.state === "synced"
          ? String(c.attrs.shoppingSettings.feedLabel ?? "").trim()
          : "",
      )
      .filter((l) => l !== ""),
  );
  if (labels.length > 0) {
    labels.forEach((l) => codes.add(l));
    source.push("feed labels");
  }
  // the country feeds the products themselves sit in (an item in a US and a CA feed sells in both)
  const productLabels = countriesOfLabels(
    ctx.model.children.products
      .flatMap((p) => (p.attrs.feeds ?? []).map((f) => (f.feedLabel ?? "").trim()))
      .filter((l) => l !== ""),
  );
  if (productLabels.length > 0) {
    productLabels.forEach((l) => codes.add(l));
    source.push("product feed labels");
  }
  // a campaign with no feed label sells every product, in whatever feeds they sit: its
  // countries are only known from a product list read in full
  const allProducts = campaignsOf(ctx).filter(
    (c) =>
      (c.attrs.type === "SHOPPING" || c.attrs.type === "PERFORMANCE_MAX") &&
      c.attrs.shoppingSettings.state === "synced" &&
      String(c.attrs.shoppingSettings.feedLabel ?? "").trim() === "",
  );
  const truncated = ctx.get("Y.truncated[table]", { table: "shoppingProductsData" });
  const productListFull =
    gateOnData(ctx, ["shoppingProductsData"]) === null &&
    isOk(truncated) &&
    truncated.value === false;
  const odd = [...notCountries].sort();
  const partialReason =
    odd.length > 0
      ? `the feed label${odd.length > 1 ? "s" : ""} ${odd
          .slice(0, 5)
          .map((l) => JSON.stringify(l.slice(0, 40)))
          .join(
            ", ",
          )}${odd.length > 5 ? ` and ${odd.length - 5} more` : ""} name${odd.length > 1 ? "" : "s"} no country, so where those products sell is not known`
      : allProducts.length > 0 && !productListFull
        ? `${namesOf(allProducts.map((c) => c.name))} sell every product, and the product list (where the products' country feeds are) was not read in full`
        : ctx.model.attrs.merchantCenter.deliveryCountriesPartial === true
          ? "the shipping countries were read only in part"
          : null;
  return { codes, source, partial: partialReason };
}

const SL11 = defineCheck({
  id: "SL11",
  claimKey: CLAIM_KEYS.GEO_SPEND_OUTSIDE_MARKETS,
  title: "spend in countries the shop does not deliver to",
  clientLabel: "ad spend in countries you do not sell to",
  group: "slices",
  metrics: ["C.spend", "T.waste_floor"],
  confounders: [],
  requires: ["geo_countries", "campaigns", "shoppingSettings"],
  impactFormula: "IMP_WASTE_90",
  noneFoundMeans: "Your ads only spend in countries you sell to.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["geo_countries", "campaigns", "shoppingSettings"]);
    if (g) return g;
    const { codes, source, partial } = sellingCountries(ctx);
    // never a verdict on a list that may miss countries: a missing one would read as waste
    if (partial)
      return {
        state: "not_checkable",
        reason: `${partial}, so the countries the shop sells to${codes.size > 0 ? ` (${[...codes].sort().join(", ")})` : ""} may be incomplete`,
        table: "shoppingProductsData",
        category: "incomplete_data",
      };
    if (codes.size === 0)
      return {
        state: "not_checkable",
        reason:
          "the countries the shop sells to are unknown: no Shopping or Performance Max campaign has a country feed label (Merchant Center shipping is not read)",
        table: "shoppingSettings",
        category: "not_present",
      };
    const floor = num(ctx.get("T.waste_floor"));
    const bar = floor != null && Number.isFinite(floor) ? floor : 0;
    const { live } = liveCountries(ctx, true);
    if (live.length === 0)
      return {
        state: "not_checkable",
        reason: "no live campaign has a country with spend from people in it",
        table: "geo_countries",
        category: "not_present",
      };
    const findings: CheckFinding[] = [];
    const notes: string[] = [];
    let unknownIds = 0;
    for (const { c, countries } of live) {
      unknownIds += countries.filter((x) => x.code == null).length;
      const outside = countries.filter((x) => x.code != null && !codes.has(x.code));
      if (outside.length === 0) continue;
      const sold = outside.filter((x) => x.conv > 0);
      const dead = outside.filter((x) => x.conv <= 0);
      if (sold.length > 0)
        notes.push(
          `${c.name}: sold in ${namesOf(sold.map((x) => x.name))}, which is not on the list, so the list may be incomplete`,
        );
      const deadCost = dead.reduce((t, x) => t + x.cost, 0);
      if (dead.length === 0 || deadCost < bar) continue;
      findings.push(
        finding({
          claimKey: this.claimKey,
          scope: {
            type: "campaign",
            id: c.id,
            name: c.name,
            campaignId: c.id,
            campaignName: c.name,
          },
          entity: { id: c.id, name: c.name },
          cite: [ctx.get("C.spend", { campaignId: c.id }), ctx.get("T.waste_floor")].filter(isOk),
          facts: {
            [ROLLUP_WASTED_COST_90D]: Number(deadCost.toFixed(2)),
            countries_outside: dead.length,
            selling_countries: [...codes].sort().join(", "),
            selling_countries_from: source.join(" and "),
          },
          population: live.length,
          rows: dead.slice(0, 10).map((x) => ({
            entity: { id: x.id, name: x.name },
            cells: { spend: Number(x.cost.toFixed(2)), sales: 0 },
          })),
        }),
      );
    }
    const tail = [
      unknownIds > 0
        ? `${unknownIds} country row(s) whose country could not be named were not judged`
        : null,
      ...notes,
    ]
      .filter(Boolean)
      .join("; ");
    if (findings.length > 0) {
      if (tail) for (const f of findings) f.note = tail;
      return { state: "fires", findings };
    }
    if (unknownIds > 0)
      return {
        state: "not_checkable",
        reason: `${unknownIds} country row(s) with spend could not be named, so whether they are on the list cannot be told`,
        table: "geo_countries",
        category: "our_gap",
      };
    return {
      state: "none_found",
      population: live.length,
      note: [
        `every country with spend is one the shop sells to (${[...codes].sort().join(", ")}, from ${source.join(" and ")})`,
        tail,
      ]
        .filter(Boolean)
        .join("; "),
    };
  },
});

/** Country domains whose site is in one language (a multi-language country is left out: be, ch, ca ...). */
const TLD_LANGUAGE: Readonly<Record<string, string>> = {
  de: "de",
  at: "de",
  nl: "nl",
  fr: "fr",
  es: "es",
  mx: "es",
  ar: "es",
  it: "it",
  pt: "pt",
  br: "pt",
  pl: "pl",
  se: "sv",
  dk: "da",
  no: "no",
  fi: "fi",
  cz: "cs",
  sk: "sk",
  hu: "hu",
  ro: "ro",
  gr: "el",
  tr: "tr",
  jp: "ja",
  kr: "ko",
  uk: "en",
  us: "en",
  au: "en",
  nz: "en",
  ie: "en",
};
/** Language codes a path segment or subdomain may name ("/de/", "/de-at/", "de.shop.com"). */
const URL_LANGUAGES = new Set([...Object.values(TLD_LANGUAGE), "en", "nb"]);

/**
 * R12 (SL12): the language of the site an ad lands on, read from its final URL: a
 * language path segment ("/de/", "/de-at/"), a language subdomain ("de.shop.com"), else a
 * one-language country domain (shop.de -> de). null = cannot be told
 * (.com, .eu, a multi-language country).
 */
export function siteLanguageOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const first = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  const path = /^([a-z]{2})(?:[-_][a-z]{2})?$/.exec(first)?.[1];
  if (path && URL_LANGUAGES.has(path)) return path;
  const labels = u.hostname.toLowerCase().split(".");
  if (labels.length > 2 && URL_LANGUAGES.has(labels[0]!)) return labels[0]!;
  return TLD_LANGUAGE[labels[labels.length - 1] ?? ""] ?? null;
}

/** The site languages a campaign's ads land on: its enabled ads' final URLs, else any ad's. */
function siteLanguagesOf(c: CampaignNode): string[] {
  const ads = c.children.adGroups.flatMap((g) => g.children.ads);
  const enabled = ads.filter((a) => String(a.attrs.status ?? "").toUpperCase() === "ENABLED");
  const urls = (enabled.length > 0 ? enabled : ads).flatMap((a) => a.attrs.finalUrls);
  return [...new Set(urls.map(siteLanguageOf).filter((l): l is string => l != null))].sort();
}

const SL12 = defineCheck({
  id: "SL12",
  claimKey: CLAIM_KEYS.SETTINGS_LANGUAGE_MISMATCH,
  title: "campaign language differs from the shop's language",
  clientLabel: "whether your campaigns' language settings match your products' language",
  group: "slices",
  metrics: ["C.spend"],
  confounders: [],
  requires: ["campaigns", "campaign_languages", "shop_languages"],
  impactFormula: "IMP_NONE",
  notCheckableCategory: "our_gap",
  noneFoundMeans: "Your campaigns target the language your products are written in.",
  run(ctx: CheckCtx): CheckResult {
    const g = gateOnData(ctx, ["campaigns", "campaign_languages", "shop_languages"]);
    if (g) return g;
    const live = campaignsOf(ctx).filter((c) => (c.windows.m90.cost ?? 0) > 0);
    if (live.length === 0)
      return {
        state: "not_checkable",
        reason: "no live campaign spent in the window",
        table: "campaigns",
        category: "not_present",
      };
    const shop = ctx.model.attrs.shopLanguages;
    if (!shop || shop.state !== "synced")
      return {
        state: "not_checkable",
        reason: `the products' language is not known (${shop?.state === "not_synced" ? shop.note : "product languages not loaded"})`,
        table: "shop_languages",
        category: "our_gap",
      };
    const total = shop.languages.reduce((sum, l) => sum + l.products, 0);
    const minShare = ctx.settings.slices.languageMinShare;
    const shopCodes = shop.languages
      .filter((l) => l.products > 0 && l.products / total >= minShare)
      .map((l) => l.code);
    if (shopCodes.length === 0)
      return {
        state: "not_checkable",
        reason:
          "no product carries a content language (no linked product feed), so the shop's language is not known",
        table: "shop_languages",
        category: "not_present",
      };
    const unsynced = live.find(
      (c) => c.attrs.languages == null || c.attrs.languages.state !== "synced",
    );
    if (unsynced)
      return {
        state: "not_checkable",
        reason: "campaign language settings were not read",
        table: "campaign_languages",
        category: "our_gap",
      };
    const shopSet = new Set(shopCodes);
    const shopList = shopCodes.join(", ");
    const findings: CheckFinding[] = [];
    let matching = 0;
    let siteMatching = 0;
    let allLanguages = 0;
    const unknown: string[] = [];
    // Demand Gen (upgraded targeting, Google's default) can set languages per ad group: no
    // campaign-level language there is not "every language"
    const perAdGroup: string[] = [];
    for (const c of live) {
      const l = c.attrs.languages;
      if (!l || l.state !== "synced") continue;
      if (l.codes.length === 0) {
        if (c.attrs.type === "DEMAND_GEN") perAdGroup.push(c.name);
        else if (l.unresolved > 0) unknown.push(c.name);
        else allLanguages++;
        continue;
      }
      if (l.codes.some((code) => shopSet.has(code))) {
        matching++;
        continue;
      }
      // R12: the shop's language comes from the product feed; an ad that lands on a site in
      // the campaign's language is a match (a German campaign on the German site is fine)
      const site = siteLanguagesOf(c);
      if (site.some((code) => l.codes.includes(code))) {
        siteMatching++;
        continue;
      }
      findings.push(
        finding({
          claimKey: CLAIM_KEYS.SETTINGS_LANGUAGE_MISMATCH,
          scope: {
            type: "campaign",
            id: c.id,
            name: c.name,
            campaignId: c.id,
            campaignName: c.name,
          },
          entity: { id: c.id, name: c.name },
          cite: [ctx.get("C.spend", { campaignId: c.id })].filter(isOk),
          facts: {
            campaign_languages: l.codes.join(", "),
            shop_languages: shopList,
            shop_language_source: "the products' content language",
            ...(site.length > 0 ? { ad_site_languages: site.join(", ") } : {}),
            ...(l.unresolved > 0 ? { unresolved_language_criteria: l.unresolved } : {}),
          },
          population: live.length,
          note: `targets ${l.codes.join(", ")} only; the products are written in ${shopList}${shop.partial ? " (counted over part of the product list)" : ""}`,
        }),
      );
    }
    if (findings.length > 0) return { state: "fires", findings };
    if (perAdGroup.length > 0)
      return {
        state: "not_checkable",
        reason: `${namesOf(perAdGroup)} set no campaign language, and Demand Gen can set languages per ad group, which is not read`,
        table: "campaign_languages",
        category: "our_gap",
      };
    const judged = matching + siteMatching + allLanguages;
    if (judged === 0)
      return {
        state: "not_checkable",
        reason: `the language codes of ${namesOf(unknown)} were not read, so their languages cannot be compared with the products' (${shopList})`,
        table: "campaign_languages",
        category: "our_gap",
      };
    if (unknown.length > 0)
      return {
        state: "not_checkable",
        reason: `the language codes of ${namesOf(unknown)} were not read`,
        table: "campaign_languages",
        category: "our_gap",
      };
    return {
      state: "none_found",
      population: judged,
      note: [
        `products written in ${shopList}`,
        matching > 0 ? `${matching} campaign(s) target it` : null,
        siteMatching > 0
          ? `${siteMatching} campaign(s) target another language and their ads land on a site in that language`
          : null,
        allLanguages > 0 ? `${allLanguages} campaign(s) target every language` : null,
      ]
        .filter(Boolean)
        .join("; "),
    };
  },
});

export const SLICE_CHECKS: CheckDefinition[] = [
  SL01,
  SL02,
  SL03,
  SL04,
  SL05,
  SL06,
  SL07,
  SL10,
  SL11,
  SL12,
];
