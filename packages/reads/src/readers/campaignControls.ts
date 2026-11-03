// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). Campaign controls the presence and Performance
// Max checks read:
// - controls (campaign): the frequency caps (Display and Video) and the asset automation
//   settings (auto-made assets, final URL expansion) of every non-removed campaign;
// - url_exclusions (campaign_criterion): the negative WEBPAGE criteria of Performance Max
//   campaigns (the pages final URL expansion may not send clicks to).

import * as z from "zod";
import { plural } from "../common.js";
import { enumValue, get, id, text, textOrNull, type Row } from "../normalise.js";
import { partOk, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const CampaignControlRowSchema = z.object({
  kind: z.enum(["controls", "url_exclusion"]),
  campaignId: z.string(),
  channelType: z.string().nullable(),
  frequencyCaps: z
    .array(z.unknown())
    .nullable()
    .describe("Google's cap entries; [] = none returned (controls rows)"),
  assetAutomation: z
    .array(z.object({ type: z.string().nullable(), status: z.string().nullable() }))
    .nullable(),
  criterionId: z.string().nullable(),
  criterionName: UntrustedSchema.nullable(),
  conditions: z
    .array(z.object({ operand: z.string(), operator: z.string(), argument: UntrustedSchema }))
    .nullable(),
});
export type CampaignControlRow = z.infer<typeof CampaignControlRowSchema>;

export const CampaignControlSummarySchema = z.object({
  campaigns: z.number().nullable().describe("null = not read"),
  urlExclusions: z.number().nullable(),
});
export type CampaignControlSummary = z.infer<typeof CampaignControlSummarySchema>;

export const CAMPAIGN_CONTROLS_QUERY = `
    SELECT
      campaign.id,
      campaign.advertising_channel_type,
      campaign.frequency_caps,
      campaign.asset_automation_settings
    FROM campaign
    WHERE campaign.status != 'REMOVED'
    ORDER BY campaign.id`;

export const PMAX_URL_EXCLUSIONS_QUERY = `
    SELECT
      campaign.id,
      campaign_criterion.criterion_id,
      campaign_criterion.webpage.criterion_name,
      campaign_criterion.webpage.conditions
    FROM campaign_criterion
    WHERE campaign_criterion.type = 'WEBPAGE'
      AND campaign_criterion.negative = TRUE
      AND campaign_criterion.status != 'REMOVED'
      AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
      AND campaign.status != 'REMOVED'
    ORDER BY campaign.id, campaign_criterion.criterion_id`;

const automationOf = (v: unknown): CampaignControlRow["assetAutomation"] =>
  Array.isArray(v)
    ? v.map((x) => ({
        type: enumValue(get(x, "assetAutomationType")),
        status: enumValue(get(x, "assetAutomationStatus")),
      }))
    : [];

const mapControls = (row: Row): CampaignControlRow | null => {
  const campaignId = id(get(row, "campaign.id"));
  if (!campaignId) return null;
  const caps = get(row, "campaign.frequencyCaps");
  return {
    kind: "controls",
    campaignId,
    channelType: enumValue(get(row, "campaign.advertisingChannelType")),
    frequencyCaps: Array.isArray(caps) ? caps : [],
    assetAutomation: automationOf(get(row, "campaign.assetAutomationSettings")),
    criterionId: null,
    criterionName: null,
    conditions: null,
  };
};

const mapExclusion = (row: Row): CampaignControlRow | null => {
  const campaignId = id(get(row, "campaign.id"));
  if (!campaignId) return null;
  const conds = get(row, "campaignCriterion.webpage.conditions");
  return {
    kind: "url_exclusion",
    campaignId,
    channelType: "PERFORMANCE_MAX",
    frequencyCaps: null,
    assetAutomation: null,
    criterionId: id(get(row, "campaignCriterion.criterionId")),
    criterionName: textOrNull(get(row, "campaignCriterion.webpage.criterionName")),
    conditions: Array.isArray(conds)
      ? conds.map((c) => ({
          operand: enumValue(get(c, "operand")) ?? "",
          operator: enumValue(get(c, "operator")) ?? "",
          argument: text(get(c, "argument")),
        }))
      : [],
  };
};

export const campaignControlsReader: ReaderDef<
  null,
  CampaignControlRow,
  CampaignControlSummary,
  null
> = {
  name: "campaign_controls",
  queries: () => ({
    controls: { gaql: CAMPAIGN_CONTROLS_QUERY },
    url_exclusions: { gaql: PMAX_URL_EXCLUSIONS_QUERY },
  }),
  map: (data) => ({
    rows: [
      ...(data.controls ?? []).map(mapControls),
      ...(data.url_exclusions ?? []).map(mapExclusion),
    ].filter((r): r is CampaignControlRow => r !== null),
    extra: null,
  }),
  compare: (a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.campaignId.localeCompare(b.campaignId) ||
    (a.criterionId ?? "").localeCompare(b.criterionId ?? ""),
  summarise: (rows, _extra, _ctx, _input, parts) => ({
    campaigns: partOk(parts, "controls") ? rows.filter((r) => r.kind === "controls").length : null,
    urlExclusions: partOk(parts, "url_exclusions")
      ? rows.filter((r) => r.kind === "url_exclusion").length
      : null,
  }),
  summaryLine: (s, ctx) =>
    `Campaign controls on ${ctx.customerId}: ${s.campaigns === null ? "campaigns unknown" : plural(s.campaigns, "campaign")}, ${s.urlExclusions === null ? "URL exclusions unknown" : plural(s.urlExclusions, "URL exclusion")}.`,
  rowLine: (r) =>
    `${r.kind} campaign ${r.campaignId}${r.kind === "controls" ? `: ${(r.frequencyCaps ?? []).length} caps, ${(r.assetAutomation ?? []).filter((a) => a.status === "OPTED_IN").length} automations on` : ""}`,
};
