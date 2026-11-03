// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). Ported from PerfoAds fetchExperiments
// (experiment_id, not id; goals left out: Google refused those fields in production) and
// fetchExperimentArms. Changes: arms embedded per experiment (first 10), REMOVED left out,
// arm list unknown (null) when the arm read failed.

import * as z from "zod";
import { countBy, plural, shown } from "../common.js";
import {
  bool,
  date,
  enumValue,
  get,
  id,
  idFromResourceName,
  numberOrNull,
  textOrNull,
  type Row,
} from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

const ArmSchema = z.object({
  name: UntrustedSchema.nullable(),
  control: z.boolean(),
  trafficSplit: z.number().nullable().describe("Percent of traffic"),
  campaignIds: z.array(z.string()),
});

export const ExperimentRowSchema = z.object({
  id: z.string(),
  name: UntrustedSchema.nullable(),
  description: UntrustedSchema.nullable(),
  type: z.string().nullable(),
  status: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  arms: z.array(ArmSchema).nullable().describe("First 10; null = arms not read"),
});
export type ExperimentRow = z.infer<typeof ExperimentRowSchema>;

export const ExperimentSummarySchema = z.object({
  experiments: z.number().nullable().describe("null = not read"),
  byStatus: z.record(z.string(), z.number()),
});
export type ExperimentSummary = z.infer<typeof ExperimentSummarySchema>;

export const EXPERIMENTS_QUERY = `
    SELECT
      experiment.experiment_id,
      experiment.name,
      experiment.description,
      experiment.type,
      experiment.status,
      experiment.start_date,
      experiment.end_date
    FROM experiment
    WHERE experiment.status != 'REMOVED'
    ORDER BY experiment.experiment_id`;

export const EXPERIMENT_ARMS_QUERY = `
    SELECT
      experiment_arm.experiment,
      experiment_arm.name,
      experiment_arm.control,
      experiment_arm.traffic_split,
      experiment_arm.campaigns
    FROM experiment_arm`;

const ARMS_MAX = 10;

const mapArm = (row: Row) => {
  const campaigns = get(row, "experimentArm.campaigns");
  return {
    name: textOrNull(get(row, "experimentArm.name")),
    control: bool(get(row, "experimentArm.control")),
    trafficSplit: numberOrNull(get(row, "experimentArm.trafficSplit")),
    campaignIds: (Array.isArray(campaigns) ? campaigns : [])
      .map(idFromResourceName)
      .filter((c): c is string => c !== null)
      .slice(0, 20),
  };
};

export const experimentsReader: ReaderDef<null, ExperimentRow, ExperimentSummary, null> = {
  name: "experiments",
  queries: () => ({
    experiments: { gaql: EXPERIMENTS_QUERY },
    arms: { gaql: EXPERIMENT_ARMS_QUERY },
  }),
  map: (data, _input, _ctx, parts) => {
    const armsRead = partOk(parts, "arms");
    const arms = new Map<string, ReturnType<typeof mapArm>[]>();
    for (const row of data.arms ?? []) {
      const experimentId = idFromResourceName(get(row, "experimentArm.experiment"));
      if (experimentId) arms.set(experimentId, [...(arms.get(experimentId) ?? []), mapArm(row)]);
    }
    const rows: ExperimentRow[] = [];
    for (const row of data.experiments ?? []) {
      const e = (path: string) => get(row, `experiment.${path}`);
      const experimentId = id(e("experimentId"));
      if (!experimentId) continue;
      rows.push({
        id: experimentId,
        name: textOrNull(e("name")),
        description: textOrNull(e("description")),
        type: enumValue(e("type")),
        status: enumValue(e("status")),
        startDate: date(e("startDate")),
        endDate: date(e("endDate")),
        arms: armsRead ? (arms.get(experimentId) ?? []).slice(0, ARMS_MAX) : null,
      });
    }
    return { rows, extra: null };
  },
  compare: (a, b) =>
    (b.startDate ?? "").localeCompare(a.startDate ?? "") || a.id.localeCompare(b.id),
  summarise: (rows, _extra, _ctx, _input, parts) => ({
    experiments: partOk(parts, "experiments") ? rows.length : null,
    byStatus: countBy(rows, (r) => r.status),
  }),
  summaryLine: (s, ctx) =>
    s.experiments === null
      ? `Experiments on ${ctx.customerId}: unknown (not read).`
      : `${plural(s.experiments, "experiment")} on ${ctx.customerId}.`,
  rowLine: (r) =>
    `experiment ${r.id} ${shown(r.name)} ${r.type ?? "?"} ${r.status ?? "?"} ${r.startDate ?? "?"} to ${r.endDate ?? "?"}`,
};
