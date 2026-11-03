// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Slices — the same campaign spend segmented seven ways, at campaign AND
 * account scope (§8.4 rule 6, the f15 fix).
 *
 *   device      deviceData            key = device
 *   geo         geographicData        key = location_id  (+ locationCriteria.bid_modifier on the same criterion)
 *   hour        temporalData          rows with hour_of_day        MARGINAL
 *   dow         temporalData          rows with day_of_week        MARGINAL
 *   dowHour     db temporal_grid                         [] + notCheckable when empty/absent
 *   audience    campaignAudiencePerf (primary) ∪ audiencePerformance (same criterion → extra.legacy)
 *   demographic demographicData       key = type:value  (rows carry ad_group_id → ad-group scope too)
 *
 * Account scope = the same rows grouped by key across every campaign. dow and
 * hour each sum to the full window spend — never add the two families.
 *
 * Bid modifiers (bidModifiers table, 09-29): `modifier_source` + `criterion_key`
 * (sync Step 5B) resolve each row to the slice it multiplies — DEVICE → device,
 * LOCATION → geo (geoTargetConstants/N → N), USER_LIST / USER_INTEREST →
 * audience (criterion id, or the user list id), AD_SCHEDULE → dowHour (the
 * "MONDAY 09:00-17:00" key plus the grid cells it covers). INTERACTION_TYPE
 * (calls) multiplies no traffic slice → unresolved + noSlice. Rows stored
 * before Step 5B (both columns empty) keep the old rule: a criterion_id equal
 * to a geo location_id pairs, anything else is unresolved.
 */
import { groupBy, nc, nodeFromRows, resourceId, str, type BuildCtx } from "./context.js";
import { num } from "./metrics.js";
import type { BidModifierNode } from "./nodes/BidModifierNode.js";
import type { Slice, SliceDimension, SliceFamilies } from "./nodes/Slice.js";
import type { NotCheckable } from "./types.js";

export interface SlicesBuild {
  forCampaign(
    campaignId: string,
    parentId: string,
  ): { families: SliceFamilies; notCheckable: NotCheckable[] };
  forAccount(parentId: string): { families: SliceFamilies; notCheckable: NotCheckable[] };
  adGroupDemographics(adGroupId: string, campaignId: string, parentId: string): Slice[];
  bidModifiers: { byCampaign: Map<string, BidModifierNode[]>; orphans: BidModifierNode[] };
  dowHourSynced: boolean;
}

const AUD_FIELDS = { value: "conversion_value" };

/** 14 -> "2 pm", 0 -> "12 am". */
const clock = (h: number): [number, "am" | "pm"] => [
  h % 12 === 0 ? 12 : h % 12,
  h % 24 < 12 ? "am" : "pm",
];

/** A day-hour cell key "SATURDAY:2" in plain words: "Saturday 2-3 am"; an odd key stays as it is. */
export function slotName(key: string): string {
  const m = /^([A-Z]+):(\d{1,2})$/.exec(key);
  const hour = m ? Number(m[2]) : NaN;
  if (!m || hour > 23) return key;
  const day = m[1]!.charAt(0) + m[1]!.slice(1).toLowerCase();
  const [from, fromHalf] = clock(hour);
  const [to, toHalf] = clock(hour + 1);
  return fromHalf === toHalf
    ? `${day} ${from}-${to} ${toHalf}`
    : `${day} ${from} ${fromHalf}-${to} ${toHalf}`;
}

const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

/** The hour before and after a "SATURDAY:2" cell key, across midnight into the next or last day. */
export function neighbourSlots(key: string): string[] {
  const m = /^([A-Z]+):(\d{1,2})$/.exec(key);
  const day = m ? WEEKDAYS.indexOf(m[1]!) : -1;
  const hour = m ? Number(m[2]) : NaN;
  if (day < 0 || !(hour >= 0 && hour <= 23)) return [];
  const at = (d: number, h: number) => `${WEEKDAYS[(d + 7) % 7]}:${h}`;
  return [
    hour === 0 ? at(day - 1, 23) : at(day, hour - 1),
    hour === 23 ? at(day + 1, 0) : at(day, hour + 1),
  ];
}

/**
 * R7 (SK22): a day-and-hour slot with no sale is only dead when the gap is not chance.
 * Two tests, both needed: at the grid's own sale rate the slot's clicks should have
 * brought at least this many sales (0 seen against 3 expected happens about 5% of the
 * time by luck) ...
 */
export const DEAD_SLOT_MIN_EXPECTED_CONV = 3;
/** ... and the hours on either side agree: each sells under this share of the grid's rate. */
export const DEAD_SLOT_NEIGHBOUR_RATE_SHARE = 0.5;

export interface DeadSlot {
  cell: Slice;
  /** sales the slot's clicks would have brought at the grid's own rate */
  expectedConv: number;
}

/**
 * The cells of one day-and-hour grid (one scope) that spend past `floor` without a sale
 * AND pass both tests above; `heldBack` = the ones past the floor that failed a test
 * (too few clicks to tell from chance, or a neighbouring hour sells). SK22 and its
 * confounder resolver share this, so they never disagree.
 */
export function deadHourSlots(
  cells: readonly Slice[],
  floor: number,
): { dead: DeadSlot[]; heldBack: Slice[]; rate: number | null } {
  let clicks = 0;
  let conv = 0;
  for (const c of cells) {
    clicks += c.windows.m90.clicks ?? 0;
    conv += c.windows.m90.conv ?? 0;
  }
  const rate = clicks > 0 && conv > 0 ? conv / clicks : null;
  const byKey = new Map(cells.map((c) => [c.attrs.key, c]));
  const dead: DeadSlot[] = [];
  const heldBack: Slice[] = [];
  for (const cell of cells) {
    const w = cell.windows.m90;
    if ((w.cost ?? 0) < floor || (w.conv ?? 0) !== 0) continue;
    const expectedConv = rate == null ? 0 : (w.clicks ?? 0) * rate;
    const neighboursAgree =
      rate != null &&
      neighbourSlots(cell.attrs.key).every((k) => {
        const n = byKey.get(k);
        const nClicks = n?.windows.m90.clicks ?? 0;
        // no traffic beside it cannot disagree
        if (n == null || nClicks <= 0) return true;
        return (n.windows.m90.conv ?? 0) / nClicks < rate * DEAD_SLOT_NEIGHBOUR_RATE_SHARE;
      });
    if (expectedConv >= DEAD_SLOT_MIN_EXPECTED_CONV && neighboursAgree)
      dead.push({ cell, expectedConv });
    else heldBack.push(cell);
  }
  return { dead, heldBack, rate };
}

export function prepareSlices(ctx: BuildCtx): SlicesBuild {
  // inner join on the audited campaigns: rows naming another campaign never feed a slice (orphanRows counts them)
  const own = (rows: any[]) => rows.filter((r) => ctx.campaignIds.has(String(r.campaign_id ?? "")));
  const device = own(ctx.read("deviceData"));
  const geo = own(ctx.read("geographicData"));
  const temporal = own(ctx.read("temporalData"));
  const gridGate = ctx.gate("temporal_grid", ctx.readDb("temporal_grid"));
  const grid = gridGate.rows ? own(gridGate.rows) : null;
  const audPrimary = own(ctx.read("campaignAudiencePerf"));
  const audLegacy = own(ctx.read("audiencePerformance"));
  const demo = own(ctx.read("demographicData"));
  const locCriteria = ctx.read("locationCriteria");
  const audienceLists = ctx.read("audienceLists");
  const bidRows = ctx.read("bidModifiers");

  const hourRows = temporal.filter((r) => r.hour_of_day != null);
  const dowRows = temporal.filter((r) => r.day_of_week != null && r.hour_of_day == null);
  const gridRows = grid ?? [];
  const dowHourSynced = grid != null;
  const listNames = new Map(
    audienceLists.map((l) => [String(l.list_id), str(l.list_name)] as const),
  );
  const geoModifier = new Map<string, number | null>();
  for (const r of locCriteria)
    geoModifier.set(`${r.campaign_id}:${r.criterion_id}`, num(r.bid_modifier));

  const cid = (r: any) => str(r.campaign_id);
  // resolved (campaign, dimension, slice key) → modifier, filled by the bid-modifier pass below (runs before any slice is built)
  const sliceModifier = new Map<string, number | null>();
  const keyOf: Record<SliceDimension, (r: any) => string | null> = {
    device: (r) => str(r.device),
    geo: (r) => str(r.location_id),
    hour: (r) => (r.hour_of_day == null ? null : String(r.hour_of_day)),
    dow: (r) => str(r.day_of_week),
    dowHour: (r) =>
      r.day_of_week != null && r.hour_of_day != null ? `${r.day_of_week}:${r.hour_of_day}` : null,
    audience: (r) => str(r.criterion_id),
    demographic: (r) =>
      r.demographic_type != null ? `${r.demographic_type}:${r.demographic_value}` : null,
  };
  const tableOf: Record<SliceDimension, string> = {
    device: "deviceData",
    geo: "geographicData",
    hour: "temporalData",
    dow: "temporalData",
    dowHour: "temporal_grid",
    audience: "campaignAudiencePerf",
    demographic: "demographicData",
  };
  const rowsOf: Record<SliceDimension, any[]> = {
    device,
    geo,
    hour: hourRows,
    dow: dowRows,
    dowHour: gridRows,
    audience: audPrimary,
    demographic: demo,
  };
  const legacyByKey = groupBy(audLegacy, (r) => `${r.campaign_id}:${r.criterion_id}`);

  // bid modifiers
  const byCampaign = new Map<string, BidModifierNode[]>();
  const orphans: BidModifierNode[] = [];
  const geoKeys = new Set(geo.map((r) => `${r.campaign_id}:${r.location_id}`));
  for (const r of bidRows) {
    const campaignId = resourceId(r.campaign_resource) ?? String(r.campaign_id ?? "");
    const criterionId = str(r.criterion_id);
    const base = nodeFromRows(
      ctx,
      "bidModifier",
      `${campaignId}:${criterionId ?? r.id}`,
      `bid modifier ${criterionId ?? ""}`.trim(),
      campaignId,
      [],
      "bidModifiers",
    );
    const interaction = str(r.interaction_type);
    const source = str(r.modifier_source);
    const measuredSlice = resolveMeasuredSlice({
      campaignId,
      criterionId,
      source,
      interaction,
      criterionKey: str(r.criterion_key),
      geoKeys,
      device: device.filter((d) => cid(d) === campaignId),
      audience: [...audPrimary, ...audLegacy].filter((a) => cid(a) === campaignId),
    });
    const node: BidModifierNode = {
      ...base,
      attrs: {
        campaignId,
        criterionId,
        modifier: num(r.bid_modifier),
        modifierSource: source,
        interactionType: interaction,
        measuredSlice,
        orphan: !ctx.campaignIds.has(campaignId),
      },
    };
    if (node.attrs.orphan) orphans.push(node);
    else {
      (byCampaign.get(campaignId) ?? byCampaign.set(campaignId, []).get(campaignId)!).push(node);
      const ms = node.attrs.measuredSlice;
      if (ms.kind !== "unresolved") {
        for (const k of ms.kind === "dowHour" ? (ms.cells ?? []) : [ms.key])
          sliceModifier.set(`${campaignId}:${ms.kind}:${k}`, node.attrs.modifier);
      }
    }
  }

  const mkSlice = (
    dim: SliceDimension,
    rows: any[],
    key: string,
    parentId: string,
    scope: Slice["attrs"]["scope"],
    campaignId: string | null,
    adGroupId: string | null,
  ): Slice => {
    const userListId =
      dim !== "audience"
        ? null
        : (str(rows[0]?.user_list_id) ??
          (String(rows[0]?.audience_resource_name ?? "").includes("/userLists/")
            ? resourceId(rows[0]?.audience_resource_name)
            : null));
    // N7: a custom segment or an interest reads by its own name, never its bare criterion id
    const userListName = userListId ? (listNames.get(userListId) ?? null) : null;
    const audienceName =
      userListName ??
      (dim === "audience" ? str(rows.find((r) => r?.audience_name != null)?.audience_name) : null);
    const base = nodeFromRows(
      ctx,
      "slice",
      `${scope}:${campaignId ?? "account"}:${dim}:${key}`,
      // an audience reads by its list's (or segment's) name when it was read; else its criterion id
      audienceName ?? (dim === "dowHour" ? slotName(key) : key),
      parentId,
      rows,
      tableOf[dim],
      { fields: AUD_FIELDS },
    );
    const extra: Record<string, unknown> = {};
    let bidModifier: number | null = null;
    if (dim === "geo") {
      extra.locationType = str(rows[0]?.location_type);
      extra.locationName = str(rows[0]?.location_name);
      // R4-D (SL11): presence and interest rows share a location id; keep each type's own spend and sales
      const byType: Record<string, { cost: number; conv: number }> = {};
      for (const r of rows) {
        const t = String(r.location_type ?? "UNKNOWN").toUpperCase();
        const cur = byType[t] ?? (byType[t] = { cost: 0, conv: 0 });
        cur.cost += num(r.cost) ?? 0;
        cur.conv += num(r.conversions) ?? 0;
      }
      extra.byLocationType = byType;
      if (campaignId)
        bidModifier =
          geoModifier.get(`${campaignId}:${key}`) ??
          sliceModifier.get(`${campaignId}:geo:${key}`) ??
          null;
    } else if (campaignId && scope === "campaign") {
      bidModifier = sliceModifier.get(`${campaignId}:${dim}:${key}`) ?? null;
    }
    if (dim === "audience") {
      extra.audienceType = str(rows[0]?.audience_type);
      extra.audienceResource = str(rows[0]?.audience_resource_name);
      extra.userListId = userListId;
      extra.userListName = userListName;
      if (campaignId) {
        const legacy = legacyByKey.get(`${campaignId}:${key}`);
        if (legacy)
          extra.legacy = {
            table: "audiencePerformance",
            cost: num(legacy[0].cost),
            conv: num(legacy[0].conversions),
            value: num(legacy[0].conversion_value),
          };
      }
    }
    if (dim === "demographic") {
      extra.demographicType = str(rows[0]?.demographic_type);
      extra.demographicValue = str(rows[0]?.demographic_value);
    }
    return {
      ...base,
      attrs: {
        dimension: dim,
        scope,
        campaignId,
        adGroupId,
        key,
        marginal: dim === "hour" || dim === "dow",
        bidModifier,
        extra,
      },
    };
  };

  // audience criteria only in the legacy table (no primary row) still get a slice, from the legacy rows
  const audienceRowsFor = (campaignId: string | null): any[] => {
    const primary = campaignId ? audPrimary.filter((r) => cid(r) === campaignId) : audPrimary;
    const have = new Set(primary.map((r) => `${r.campaign_id}:${r.criterion_id}`));
    const extraLegacy = (
      campaignId ? audLegacy.filter((r) => cid(r) === campaignId) : audLegacy
    ).filter((r) => !have.has(`${r.campaign_id}:${r.criterion_id}`));
    return [...primary, ...extraLegacy];
  };

  const family = (dim: SliceDimension, campaignId: string | null, parentId: string): Slice[] => {
    const rows =
      dim === "audience"
        ? audienceRowsFor(campaignId)
        : campaignId
          ? rowsOf[dim].filter((r) => cid(r) === campaignId)
          : rowsOf[dim];
    const groups = groupBy(rows, keyOf[dim]);
    const out: Slice[] = [];
    for (const [key, grp] of groups)
      out.push(
        mkSlice(dim, grp, key, parentId, campaignId ? "campaign" : "account", campaignId, null),
      );
    return out;
  };

  const build = (campaignId: string | null, parentId: string) => {
    const families: SliceFamilies = {
      device: family("device", campaignId, parentId),
      geo: family("geo", campaignId, parentId),
      hour: family("hour", campaignId, parentId),
      dow: family("dow", campaignId, parentId),
      dowHour: family("dowHour", campaignId, parentId),
      audience: family("audience", campaignId, parentId),
      demographic: family("demographic", campaignId, parentId),
    };
    const notCheckable: NotCheckable[] = [];
    if (!dowHourSynced)
      notCheckable.push(nc("slices.dowHour", gridGate.note ?? "temporal_grid not checkable"));
    else if (gridGate.note) notCheckable.push(nc("slices.dowHour", gridGate.note));
    if (campaignId == null && families.geo.length <= 1)
      notCheckable.push(
        nc(
          "slices.geo",
          "geographic_data is country-level only (one row per campaign) — region / city not synced",
        ),
      );
    return { families, notCheckable };
  };

  return {
    forCampaign: (campaignId, parentId) => build(campaignId, parentId),
    forAccount: (parentId) => build(null, parentId),
    adGroupDemographics: (adGroupId, campaignId, parentId) => {
      const rows = demo.filter((r) => str(r.ad_group_id) === adGroupId);
      const out: Slice[] = [];
      for (const [key, grp] of groupBy(rows, keyOf.demographic))
        out.push(mkSlice("demographic", grp, key, parentId, "adGroup", campaignId, adGroupId));
      return out;
    },
    bidModifiers: { byCampaign, orphans },
    dowHourSynced,
  };
}

const DAYS = new Set([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);

/**
 * The grid cells (`DAY:hour`, the dowHour slice key) an ad-schedule key
 * "MONDAY 09:00-17:00" covers: every hour that starts inside the window, so
 * 09:00-17:00 → 9..16 and 09:00-17:30 → 9..17. Unparseable → [].
 */
export function scheduleCells(key: string | null): string[] {
  const m = /^([A-Z]+)\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(key ?? "").trim());
  if (!m || !DAYS.has(m[1] ?? "")) return [];
  const start = Number(m[2]);
  const endH = Number(m[4]);
  const end = Math.min(24, Number(m[5]) > 0 ? endH + 1 : endH);
  const out: string[] = [];
  for (let h = start; h < end; h++) out.push(`${m[1]}:${h}`);
  return out;
}

/** Which slice one bid-modifier row multiplies. Pure; exported for testing. */
export function resolveMeasuredSlice(a: {
  campaignId: string;
  criterionId: string | null;
  source: string | null;
  interaction: string | null;
  criterionKey: string | null;
  geoKeys: Set<string>;
  device: any[];
  audience: any[];
}): BidModifierNode["attrs"]["measuredSlice"] {
  const src = (a.source ?? "").toUpperCase();
  if (src === "DEVICE") {
    const want = (a.criterionKey ?? "").toUpperCase();
    if (!want)
      return { kind: "unresolved", reason: "device modifier with no device type in criterion_key" };
    const row = a.device.find((d) => String(d.device ?? "").toUpperCase() === want);
    return { kind: "device", key: row ? String(row.device) : want };
  }
  if (src === "LOCATION") {
    const key = resourceId(a.criterionKey) ?? a.criterionId;
    return key
      ? { kind: "geo", key }
      : { kind: "unresolved", reason: "location modifier with no geo target" };
  }
  if (src === "USER_LIST" || src === "USER_INTEREST") {
    const listId = resourceId(a.criterionKey);
    const row = a.audience.find(
      (r) =>
        (a.criterionId != null && str(r.criterion_id) === a.criterionId) ||
        (listId != null &&
          (str(r.user_list_id) === listId || resourceId(r.audience_resource_name) === listId)),
    );
    const key = row ? str(row.criterion_id) : a.criterionId;
    return key
      ? { kind: "audience", key }
      : { kind: "unresolved", reason: `${src.toLowerCase()} modifier with no criterion id` };
  }
  if (src === "AD_SCHEDULE") {
    const cells = scheduleCells(a.criterionKey);
    return a.criterionKey && cells.length > 0
      ? { kind: "dowHour", key: a.criterionKey, cells }
      : {
          kind: "unresolved",
          reason: `ad-schedule modifier with an unreadable window "${a.criterionKey ?? ""}"`,
        };
  }
  if (src === "INTERACTION_TYPE") {
    return {
      kind: "unresolved",
      reason: `interaction-type modifier (${a.interaction ?? "calls"}) multiplies call bids, not a traffic slice`,
      noSlice: true,
    };
  }
  // rows stored before Step 5B: both columns empty
  if (a.criterionId && a.geoKeys.has(`${a.campaignId}:${a.criterionId}`))
    return { kind: "geo", key: a.criterionId };
  return !a.interaction && !src
    ? { kind: "unresolved", reason: "interaction_type and modifier_source are empty in the input" }
    : {
        kind: "unresolved",
        reason: `criterion type not resolvable from interaction_type=${a.interaction} modifier_source=${a.source}`,
      };
}
