// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Phase 11 — Local Services Ads rows on the account node (checks PR04-PR07).
 *
 * Reads the three synced LSA tables (lsa_leads / _conversations /
 * _verifications, column names per migrations/create_lsa_tables.sql)
 * through `ctx.read`, so coverage records them as consumed. The rows are only
 * typed here; every judgement lives in checks/lsa.ts.
 */
import type { LsaAttrs, LsaConversation, LsaLead, LsaVerification } from "./nodes/AccountNode.js";
import { bool, str, type BuildCtx } from "./context.js";
import { num } from "./metrics.js";

/** Lead id from `customers/{cid}/localServicesLeads/{lead_id}` (or a bare id). */
export function lsaLeadIdOf(resource: unknown): string {
  const s = str(resource);
  if (!s) return "";
  return s.split("/").pop() ?? "";
}

export function buildLsaAttrs(ctx: BuildCtx, campaignRows: readonly any[]): LsaAttrs {
  // a Local Services campaign, or a Performance Max one with Local Services on
  const hasCampaign = campaignRows.some(
    (c) => str(c.type) === "LOCAL_SERVICES" || bool(c.local_services_enabled) === true,
  );
  const leads: LsaLead[] = ctx
    .read("lsaLeads")
    .map((l) => ({
      id: str(l.lead_id) ?? "",
      type: str(l.lead_type),
      status: str(l.lead_status),
      createdAt: str(l.creation_time),
      charged: bool(l.charged) === true,
      creditState: str(l.credit_state),
    }))
    .filter((l) => l.id !== "");
  const conversations: LsaConversation[] = ctx
    .read("lsaConversations")
    .map((c) => {
      const ms = num(c.call_duration_ms);
      return {
        id: str(c.conversation_id) ?? "",
        leadId: lsaLeadIdOf(c.lead_resource),
        channel: str(c.channel),
        participantType: str(c.participant_type),
        eventTime: str(c.event_time),
        callDurationMs: ms != null && ms > 0 ? ms : null,
      };
    })
    .filter((c) => c.id !== "");
  const verifications: LsaVerification[] = ctx
    .read("lsaVerifications")
    .map((v) => ({
      id: str(v.artifact_id) ?? "",
      type: str(v.artifact_type),
      status: str(v.status),
      licenseType: str(v.license_type),
      licenseExpiry: str(v.license_expiry),
      insuranceExpiry: str(v.insurance_expiry),
    }))
    .filter((v) => v.id !== "");
  return { hasCampaign, leads, conversations, verifications };
}
