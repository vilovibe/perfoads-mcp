// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Internal reader (no tool; for the snapshot). Local Services Ads lead flow, for the Local
// Services checks. Leads and conversations hold end-customer data (names, phone numbers,
// messages, call recordings): this reader selects ONLY counts-grade fields (ids, types,
// statuses, dates, call durations), never contact details, notes, message text, attachment
// or recording URLs, licence numbers or licensee names. One GAQL resource per part:
// - lsa_campaigns (campaign): the non-removed Local Services campaigns, and the Performance
//   Max campaigns with Local Services turned on (Google's guide: leads come from either). With
//   none, nothing else is read (the account does not run Local Services);
// - leads (local_services_lead): leads created within the range, newest first;
// - conversations (local_services_lead_conversation): conversation events within the range:
//   the channel, who took part, when, and a call's duration;
// A preset range is resolved to dates in the account's time zone (these resources filter on a
// date-time, where DURING cannot be used).
// - verifications (local_services_verification_artifact): licence and insurance checks with
//   their status and expiry date.

import * as z from "zod";
import { plural, where, type FilterInput } from "../common.js";
import { describeDateRange, rangeDates } from "../dateRange.js";
import {
  dateTime,
  enumValue,
  get,
  id,
  idFromResourceName,
  numberOrNull,
  textOrNull,
  type Row,
} from "../normalise.js";
import { partOk, type Part, type ReaderDef } from "../reader.js";
import { UntrustedSchema } from "../untrusted.js";

export const LSA_ROW_KINDS = ["lead", "conversation", "verification"] as const;

export const LsaRowSchema = z.object({
  kind: z.enum(LSA_ROW_KINDS),
  id: z.string(),
  type: z.string().nullable().describe("lead type / channel / artifact type"),
  status: z.string().nullable().describe("lead status / verification status"),
  createdAt: z.string().nullable().describe("lead creation / conversation event time"),
  charged: z.boolean().nullable().describe("leads: the lead was charged"),
  creditState: z.string().nullable().describe("leads: PENDING, CREDITED, ..."),
  leadId: z.string().nullable().describe("conversations: the lead it belongs to"),
  participantType: z.string().nullable(),
  callDurationMs: z.number().nullable(),
  licenseType: UntrustedSchema.nullable().describe(
    "the licence's type / name as the advertiser entered it (free text)",
  ),
  licenseExpiry: z.string().nullable(),
  insuranceExpiry: z.string().nullable(),
});
export type LsaRow = z.infer<typeof LsaRowSchema>;

export const LsaSummarySchema = z.object({
  lsaCampaigns: z.number().nullable().describe("null = not read"),
  leads: z.number().nullable(),
  conversations: z.number().nullable(),
  verifications: z.number().nullable(),
});
export type LsaSummary = z.infer<typeof LsaSummarySchema>;

/** Leads read, newest first; more in the range is a sample. */
export const LSA_LEAD_CAP = 5_000;
export const LSA_CONVERSATION_CAP = 10_000;

export const LSA_CAMPAIGNS_QUERY = `
    SELECT
      campaign.id,
      campaign.advertising_channel_type,
      campaign.pmax_campaign_settings.local_services_enabled,
      customer.time_zone
    FROM campaign
    WHERE campaign.advertising_channel_type IN ('LOCAL_SERVICES', 'PERFORMANCE_MAX')
      AND campaign.status != 'REMOVED'
    ORDER BY campaign.id`;

/** The range as GAQL date-times: its first and its last second. */
export interface LsaBounds {
  start: string;
  end: string;
}

export const lsaBounds = (
  input: FilterInput,
  nowMs: number,
  timeZone: string | null,
): LsaBounds => {
  const { startDate, endDate } = rangeDates(input.dateRange, nowMs, timeZone);
  return { start: `${startDate} 00:00:00`, end: `${endDate} 23:59:59` };
};

export const leadsQuery = (b: LsaBounds): string => {
  return `
    SELECT
      local_services_lead.id,
      local_services_lead.lead_type,
      local_services_lead.lead_status,
      local_services_lead.creation_date_time,
      local_services_lead.lead_charged,
      local_services_lead.credit_details.credit_state
    FROM local_services_lead
    ${where([
      `local_services_lead.creation_date_time >= '${b.start}'`,
      `local_services_lead.creation_date_time <= '${b.end}'`,
    ])}
    ORDER BY local_services_lead.creation_date_time DESC`;
};

export const conversationsQuery = (b: LsaBounds): string => {
  return `
    SELECT
      local_services_lead_conversation.id,
      local_services_lead_conversation.conversation_channel,
      local_services_lead_conversation.participant_type,
      local_services_lead_conversation.event_date_time,
      local_services_lead_conversation.lead,
      local_services_lead_conversation.phone_call_details.call_duration_millis
    FROM local_services_lead_conversation
    ${where([
      `local_services_lead_conversation.event_date_time >= '${b.start}'`,
      `local_services_lead_conversation.event_date_time <= '${b.end}'`,
    ])}
    ORDER BY local_services_lead_conversation.event_date_time DESC`;
};

export const VERIFICATIONS_QUERY = `
    SELECT
      local_services_verification_artifact.id,
      local_services_verification_artifact.artifact_type,
      local_services_verification_artifact.status,
      local_services_verification_artifact.creation_date_time,
      local_services_verification_artifact.license_verification_artifact.license_type,
      local_services_verification_artifact.license_verification_artifact.expiration_date_time,
      local_services_verification_artifact.insurance_verification_artifact.expiration_date_time
    FROM local_services_verification_artifact
    ORDER BY local_services_verification_artifact.id`;

const EMPTY: Omit<LsaRow, "kind" | "id"> = {
  type: null,
  status: null,
  createdAt: null,
  charged: null,
  creditState: null,
  leadId: null,
  participantType: null,
  callDurationMs: null,
  licenseType: null,
  licenseExpiry: null,
  insuranceExpiry: null,
};

const mapLead = (r: Row): LsaRow | null => {
  const leadId = id(get(r, "localServicesLead.id"));
  if (!leadId) return null;
  return {
    ...EMPTY,
    kind: "lead",
    id: leadId,
    type: enumValue(get(r, "localServicesLead.leadType")),
    status: enumValue(get(r, "localServicesLead.leadStatus")),
    createdAt: dateTime(get(r, "localServicesLead.creationDateTime")),
    charged: get(r, "localServicesLead.leadCharged") === true,
    creditState: enumValue(get(r, "localServicesLead.creditDetails.creditState")),
  };
};

const mapConversation = (r: Row): LsaRow | null => {
  const convId = id(get(r, "localServicesLeadConversation.id"));
  if (!convId) return null;
  return {
    ...EMPTY,
    kind: "conversation",
    id: convId,
    type: enumValue(get(r, "localServicesLeadConversation.conversationChannel")),
    createdAt: dateTime(get(r, "localServicesLeadConversation.eventDateTime")),
    leadId: idFromResourceName(get(r, "localServicesLeadConversation.lead")),
    participantType: enumValue(get(r, "localServicesLeadConversation.participantType")),
    callDurationMs: numberOrNull(
      get(r, "localServicesLeadConversation.phoneCallDetails.callDurationMillis"),
    ),
  };
};

const mapVerification = (r: Row): LsaRow | null => {
  const artifactId = id(get(r, "localServicesVerificationArtifact.id"));
  if (!artifactId) return null;
  return {
    ...EMPTY,
    kind: "verification",
    id: artifactId,
    type: enumValue(get(r, "localServicesVerificationArtifact.artifactType")),
    status: enumValue(get(r, "localServicesVerificationArtifact.status")),
    createdAt: dateTime(get(r, "localServicesVerificationArtifact.creationDateTime")),
    licenseType: textOrNull(
      plainLabel(
        get(r, "localServicesVerificationArtifact.licenseVerificationArtifact.licenseType"),
      ),
    ),
    licenseExpiry: dateTime(
      get(r, "localServicesVerificationArtifact.licenseVerificationArtifact.expirationDateTime"),
    ),
    insuranceExpiry: dateTime(
      get(r, "localServicesVerificationArtifact.insuranceVerificationArtifact.expirationDateTime"),
    ),
  };
};

/**
 * The licence type is free text the advertiser entered ("Plumbing Contractor"): kept only when
 * it is a short plain label (letters, digits, spaces and . , ' ( ) & / -), else null.
 */
const plainLabel = (v: unknown): string | null =>
  typeof v === "string" && /^[\p{L}\p{N} .,'()&/-]{1,80}$/u.test(v) ? v : null;

/** A Local Services campaign, or a Performance Max campaign with Local Services on. */
const isLsaCampaign = (r: Row): boolean =>
  id(get(r, "campaign.id")) !== null &&
  (get(r, "campaign.advertisingChannelType") === "LOCAL_SERVICES" ||
    get(r, "campaign.pmaxCampaignSettings.localServicesEnabled") === true);

const lsaCampaigns = (rows: readonly Row[] | undefined): Row[] =>
  (rows ?? []).filter(isLsaCampaign);

const timeZoneOf = (rows: readonly Row[] | undefined): string | null => {
  const tz = (rows ?? [])
    .map((r) => get(r, "customer.timeZone"))
    .find((v) => typeof v === "string");
  return typeof tz === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) ? tz : null;
};

export const localServicesReader: ReaderDef<
  FilterInput,
  LsaRow,
  LsaSummary,
  { campaignIds: string[] },
  { campaigns: number }
> = {
  name: "local_services",
  queries: () => ({ lsa_campaigns: { gaql: LSA_CAMPAIGNS_QUERY } }),
  // only an account that runs Local Services is asked for leads (three queries saved otherwise)
  followUp: (input, ctx, data) => {
    if (lsaCampaigns(data.lsa_campaigns).length === 0) return {};
    const bounds = lsaBounds(input, (ctx.now ?? Date.now)(), timeZoneOf(data.lsa_campaigns));
    const parts: Record<string, Part> = {
      leads: { gaql: leadsQuery(bounds), limit: LSA_LEAD_CAP },
      conversations: { gaql: conversationsQuery(bounds), limit: LSA_CONVERSATION_CAP },
      verifications: { gaql: VERIFICATIONS_QUERY },
    };
    return parts;
  },
  map: (data) => ({
    facts: {
      campaigns: lsaCampaigns(data.lsa_campaigns).length,
    },
    rows: [
      ...(data.leads ?? []).map(mapLead),
      ...(data.conversations ?? []).map(mapConversation),
      ...(data.verifications ?? []).map(mapVerification),
    ].filter((r): r is LsaRow => r !== null),
    // the Local Services campaigns, Performance Max ones with Local Services on included
    extra: {
      campaignIds: lsaCampaigns(data.lsa_campaigns)
        .map((r) => id(get(r, "campaign.id")))
        .filter((x): x is string => x !== null),
    },
  }),
  compare: (a, b) =>
    LSA_ROW_KINDS.indexOf(a.kind) - LSA_ROW_KINDS.indexOf(b.kind) ||
    (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
    a.id.localeCompare(b.id),
  summarise: (rows, _extra, _ctx, _input, parts, facts) => {
    const campaigns = partOk(parts, "lsa_campaigns") ? (facts?.campaigns ?? null) : null;
    const none = campaigns === 0;
    const n = (kind: LsaRow["kind"], part: string) =>
      none ? 0 : partOk(parts, part) ? rows.filter((r) => r.kind === kind).length : null;
    return {
      lsaCampaigns: campaigns,
      leads: n("lead", "leads"),
      conversations: n("conversation", "conversations"),
      verifications: n("verification", "verifications"),
    };
  },
  summaryLine: (s, ctx, input) =>
    s.lsaCampaigns === 0
      ? `Local Services on ${ctx.customerId}: no Local Services campaign.`
      : `Local Services on ${ctx.customerId}, ${describeDateRange(input.dateRange)}: ${s.leads === null ? "leads unknown" : plural(s.leads, "lead")}, ${s.conversations === null ? "conversations unknown" : plural(s.conversations, "conversation")}.`,
  rowLine: (r) => `${r.kind} ${r.id} ${r.type ?? ""} ${r.status ?? ""} ${r.createdAt ?? ""}`.trim(),
};
