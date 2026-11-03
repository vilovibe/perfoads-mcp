// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). Google's bid simulations for a target CPA or
// target ROAS: what the campaign (or its portfolio strategy) would get at other targets.
// - campaign_simulation, one part per type (each row fills only its own point list):
//   TARGET_CPA, TARGET_ROAS.
// - bidding_strategy_simulation (portfolio strategies hold the target), TARGET_CPA and
//   TARGET_ROAS as two parts.
// - UNIFORM and DEFAULT only: a SCALING simulation (Search target CPA) has a multiplier per
//   point, not a target, so it is filtered out in the query.
// - Points: target, required budget, biddable conversions and value, clicks (or interactions
//   on Demand Gen), cost, impressions; a field Google left out is null (unknown), never 0. At
//   most POINTS_KEPT per simulation (Google sends about ten).
// No row = no simulation (new campaign, too little traffic, unsupported channel, test
// account): "no data", never "no effect". Simulations take no date range.

import * as z from "zod";
import { plural } from "../common.js";
import {
  date,
  doubleMoney,
  enumValue,
  get,
  id,
  money,
  numberOrNull,
  type Row,
} from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";

export const POINTS_KEPT = 50;

const PointSchema = z.object({
  targetCpa: z.string().nullable().describe("Account currency"),
  targetRoas: z.number().nullable().describe("3.0 = 300%"),
  requiredBudget: z.string().nullable(),
  biddableConversions: z.number().nullable().describe("null = Google sent none (unknown, not 0)"),
  biddableConversionsValue: z.string().nullable(),
  clicks: z.number().nullable().describe("Demand Gen fills interactions instead"),
  interactions: z.number().nullable(),
  cost: z.string().nullable(),
  impressions: z.number().nullable(),
});

export const SimulationRowSchema = z.object({
  level: z.enum(["campaign", "bidding_strategy"]),
  ownerId: z.string().describe("Campaign id or portfolio strategy id"),
  type: z.string().describe("TARGET_CPA or TARGET_ROAS"),
  modificationMethod: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  points: z.array(PointSchema),
});
export type SimulationRow = z.infer<typeof SimulationRowSchema>;

export const SimulationSummarySchema = z.object({
  campaignSimulations: z.number().nullable().describe("null = not read"),
  strategySimulations: z.number().nullable(),
});
export type SimulationSummary = z.infer<typeof SimulationSummarySchema>;

const LISTS = { TARGET_CPA: "target_cpa_point_list", TARGET_ROAS: "target_roas_point_list" };
type SimType = keyof typeof LISTS;
const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

export const campaignSimulationQuery = (type: SimType): string => `
    SELECT
      campaign_simulation.campaign_id,
      campaign_simulation.type,
      campaign_simulation.modification_method,
      campaign_simulation.start_date,
      campaign_simulation.end_date,
      campaign_simulation.${LISTS[type]}.points
    FROM campaign_simulation
    WHERE campaign_simulation.type = '${type}'
      AND campaign_simulation.modification_method IN ('UNIFORM', 'DEFAULT')
      AND campaign.status != 'REMOVED'
    ORDER BY campaign_simulation.campaign_id`;

export const strategySimulationQuery = (type: SimType): string => `
    SELECT
      bidding_strategy_simulation.bidding_strategy_id,
      bidding_strategy_simulation.type,
      bidding_strategy_simulation.modification_method,
      bidding_strategy_simulation.start_date,
      bidding_strategy_simulation.end_date,
      bidding_strategy_simulation.${LISTS[type]}.points
    FROM bidding_strategy_simulation
    WHERE bidding_strategy_simulation.type = '${type}'
      AND bidding_strategy_simulation.modification_method IN ('UNIFORM', 'DEFAULT')
    ORDER BY bidding_strategy_simulation.bidding_strategy_id`;

const pointOf = (p: unknown): z.infer<typeof PointSchema> => ({
  targetCpa: money(get(p, "targetCpaMicros")),
  targetRoas: numberOrNull(get(p, "targetRoas")),
  requiredBudget: money(get(p, "requiredBudgetAmountMicros")),
  // a field Google left out is unknown, never 0 (Demand Gen points carry interactions, not clicks)
  biddableConversions: numberOrNull(get(p, "biddableConversions")),
  biddableConversionsValue:
    numberOrNull(get(p, "biddableConversionsValue")) === null
      ? null
      : doubleMoney(get(p, "biddableConversionsValue")),
  clicks: numberOrNull(get(p, "clicks")),
  interactions: numberOrNull(get(p, "interactions")),
  cost: money(get(p, "costMicros")),
  impressions: numberOrNull(get(p, "impressions")),
});

const mapRow = (row: Row, level: SimulationRow["level"], type: SimType): SimulationRow | null => {
  const base = level === "campaign" ? "campaignSimulation" : "biddingStrategySimulation";
  const s = (path: string) => get(row, `${base}.${path}`);
  const ownerId = id(s(level === "campaign" ? "campaignId" : "biddingStrategyId"));
  if (!ownerId) return null;
  const points = s(`${camel(LISTS[type])}.points`);
  return {
    level,
    ownerId,
    type: enumValue(s("type")) ?? type,
    modificationMethod: enumValue(s("modificationMethod")),
    startDate: date(s("startDate")),
    endDate: date(s("endDate")),
    points: (Array.isArray(points) ? points : []).slice(0, POINTS_KEPT).map(pointOf),
  };
};

export const simulationsReader: ReaderDef<null, SimulationRow, SimulationSummary, null> = {
  name: "simulations",
  queries: () => ({
    campaign_target_cpa: { gaql: campaignSimulationQuery("TARGET_CPA") },
    campaign_target_roas: { gaql: campaignSimulationQuery("TARGET_ROAS") },
    strategy_target_cpa: { gaql: strategySimulationQuery("TARGET_CPA") },
    strategy_target_roas: { gaql: strategySimulationQuery("TARGET_ROAS") },
  }),
  map: (data) => ({
    rows: [
      ...(data.campaign_target_cpa ?? []).map((r) => mapRow(r, "campaign", "TARGET_CPA")),
      ...(data.campaign_target_roas ?? []).map((r) => mapRow(r, "campaign", "TARGET_ROAS")),
      ...(data.strategy_target_cpa ?? []).map((r) => mapRow(r, "bidding_strategy", "TARGET_CPA")),
      ...(data.strategy_target_roas ?? []).map((r) => mapRow(r, "bidding_strategy", "TARGET_ROAS")),
    ].filter((r): r is SimulationRow => r !== null),
    extra: null,
  }),
  compare: (a, b) =>
    a.level.localeCompare(b.level) ||
    a.ownerId.localeCompare(b.ownerId) ||
    a.type.localeCompare(b.type),
  summarise: (rows, _extra, _ctx, _input, parts) => ({
    campaignSimulations:
      partOk(parts, "campaign_target_cpa") && partOk(parts, "campaign_target_roas")
        ? rows.filter((r) => r.level === "campaign").length
        : null,
    strategySimulations:
      partOk(parts, "strategy_target_cpa") && partOk(parts, "strategy_target_roas")
        ? rows.filter((r) => r.level === "bidding_strategy").length
        : null,
  }),
  summaryLine: (s, ctx) =>
    `Bid simulations on ${ctx.customerId}: ${s.campaignSimulations === null ? "campaign simulations unknown" : plural(s.campaignSimulations, "campaign simulation")}, ${s.strategySimulations === null ? "strategy simulations unknown" : plural(s.strategySimulations, "strategy simulation")}.`,
  rowLine: (r) => `${r.level} ${r.ownerId} ${r.type}: ${r.points.length} points`,
};
