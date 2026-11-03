// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Local Services Ads: PR04-PR07 (PR03, the plain presence line, is in presence.ts).
 *
 * Local Services is pay per lead: no keywords, no ad text. What can be judged is
 * the lead flow, from counts-grade fields only (lead type, status, dates, charge
 * and credit state, call durations, verification expiry dates). No contact
 * details, notes or messages are read, and none appears here.
 *
 *   PR04  lead volume, the last 30 days against the 30 before
 *   PR05  share of leads disputed (credit asked or granted)
 *   PR06  phone leads: calls with no talk time, and very short calls
 *   PR07  a licence or insurance check running out soon (ads stop)
 *
 * Every check abstains as not_present on an account with no Local Services
 * campaign, and as not run when a table was not read. The numbers come straight
 * from the rows and ride as facts; each finding cites the rows it stands on.
 */
import { CLAIM_KEYS } from "../registry/claimKeys.js";
import type { LsaAttrs, LsaVerification } from "../model/nodes/AccountNode.js";
import {
  type CheckCtx,
  type CheckDefinition,
  type CheckResult,
  type CheckScope,
  defineCheck,
  type EvidenceRow,
  finding,
  gateOnData,
  isOk,
  num,
} from "./types.js";
import type { MetricValue } from "../registry/types.js";

const ACCOUNT_SCOPE: CheckScope = { type: "account", id: null, name: null };
/** The trend compares two windows of this many days. */
export const LSA_TREND_DAYS = 30;
const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD…' → UTC ms of that day; null when unreadable. */
export function lsaDayMs(v: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

/** No Local Services campaign → not_present; otherwise the read gate. */
export function lsaGate(
  ctx: CheckCtx,
  tables: string[],
): { lsa: LsaAttrs } | { result: CheckResult } {
  const campaigns = gateOnData(ctx, ["campaigns"]);
  if (campaigns) return { result: campaigns };
  const lsa = ctx.model.attrs.lsa;
  if (!lsa || !lsa.hasCampaign)
    return {
      result: {
        state: "not_checkable",
        reason: "the account runs no Local Services campaign",
        category: "not_present",
      },
    };
  const g = gateOnData(ctx, tables);
  if (g) return { result: g };
  return { lsa };
}

/** The rows of a Local Services table, as the citable count every finding here stands on. */
export const rowsRead = (ctx: CheckCtx, table: string): MetricValue[] =>
  [ctx.get("DQ.population[table]", { table })].filter(isOk);

/** The leads were read only in part (newest first, cut at the row limit). */
const leadsCapped = (ctx: CheckCtx): boolean =>
  ctx.model.dataQuality.tables.lsaLeads?.truncated === true;

/** The day the checks measure back from: the window's end, else the newest lead. */
function anchorMs(ctx: CheckCtx, lsa: LsaAttrs): number | null {
  const end = lsaDayMs(ctx.window.end);
  if (end != null) return end;
  const days = lsa.leads.map((l) => lsaDayMs(l.createdAt)).filter((d): d is number => d != null);
  return days.length ? Math.max(...days) : null;
}

export function isDisputedLead(creditState: string | null): boolean {
  const s = String(creditState ?? "").toUpperCase();
  return s === "PENDING" || s === "CREDITED";
}

// ---------------------------------------------------------------------------
// PR04 — lead volume falling
// ---------------------------------------------------------------------------

const PR04 = defineCheck({
  id: "PR04",
  claimKey: CLAIM_KEYS.LSA_LEAD_VOLUME_DECLINING,
  title: "Local Services lead volume falling",
  clientLabel: "Local Services leads falling month on month",
  group: "presence",
  metrics: ["DQ.population[table]", "W.window_days"],
  confounders: [],
  requires: ["lsaLeads"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Local Services leads held steady over the last 30 days.",
  run(ctx: CheckCtx): CheckResult {
    const g = lsaGate(ctx, ["lsaLeads"]);
    if ("result" in g) return g.result;
    const { lsa } = g;
    const s = ctx.settings.localServices;
    // two 30-day spans side by side: a shorter window has no prior span to compare against
    const windowDays = num(ctx.get("W.window_days"));
    if (windowDays == null || windowDays < LSA_TREND_DAYS * 2)
      return {
        state: "not_checkable",
        reason:
          windowDays == null
            ? `the window's length is unknown (no daily series), and this compares two ${LSA_TREND_DAYS}-day spans`
            : `the window is ${windowDays} days, shorter than the ${LSA_TREND_DAYS * 2} days this compares (two ${LSA_TREND_DAYS}-day spans)`,
        table: "lsaLeads",
        category: "nothing_to_compare",
      };
    const end = anchorMs(ctx, lsa);
    if (end == null)
      return { state: "insufficient_data", reason: "no lead carries a readable date" };
    const curStart = end - (LSA_TREND_DAYS - 1) * DAY_MS;
    const priorStart = curStart - LSA_TREND_DAYS * DAY_MS;
    const dated = lsa.leads.map((l) => lsaDayMs(l.createdAt)).filter((d): d is number => d != null);
    // the newest leads are kept when the read is cut: if they do not reach back 60 days the prior count is short
    if (leadsCapped(ctx) && dated.length > 0 && Math.min(...dated) > priorStart)
      return {
        state: "not_checkable",
        reason: `the leads read stop at their row limit before reaching back ${LSA_TREND_DAYS * 2} days`,
        table: "lsaLeads",
        category: "incomplete_data",
      };
    const current = dated.filter((d) => d >= curStart && d <= end).length;
    const prior = dated.filter((d) => d >= priorStart && d < curStart).length;
    if (prior < s.leadTrendMinPrior)
      return {
        state: "insufficient_data",
        reason: `${prior} leads in the ${LSA_TREND_DAYS} days before (needs ${s.leadTrendMinPrior})`,
      };
    const change = (current - prior) / prior;
    if (change > -s.leadDropShare)
      return {
        state: "none_found",
        population: current + prior,
        note: `${current} leads against ${prior} the ${LSA_TREND_DAYS} days before`,
      };
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.LSA_LEAD_VOLUME_DECLINING,
          scope: ACCOUNT_SCOPE,
          cite: rowsRead(ctx, "lsaLeads"),
          facts: {
            lsa_leads_last_30d: current,
            lsa_leads_prior_30d: prior,
            lsa_lead_change_pct: Math.round(change * 1000) / 10,
            drop_bar_pct: s.leadDropShare * 100,
          },
          population: current + prior,
        }),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// PR05 — disputed (credited / credit pending) share of leads
// ---------------------------------------------------------------------------

/** The leads created inside the window, and a plain name for that set. */
export function leadsInWindow(
  ctx: CheckCtx,
  lsa: LsaAttrs,
): { leads: LsaAttrs["leads"]; scope: string; cut: boolean } {
  const start = lsaDayMs(ctx.window.start);
  const end = lsaDayMs(ctx.window.end);
  if (start == null || end == null)
    return { leads: lsa.leads, scope: `the ${lsa.leads.length} leads read`, cut: leadsCapped(ctx) };
  const leads = lsa.leads.filter((l) => {
    const d = lsaDayMs(l.createdAt);
    return d != null && d >= start && d <= end;
  });
  const dated = lsa.leads.map((l) => lsaDayMs(l.createdAt)).filter((d): d is number => d != null);
  const cut = leadsCapped(ctx) && dated.length > 0 && Math.min(...dated) > start;
  return {
    leads,
    scope: cut
      ? `the newest ${lsa.leads.length} leads, which start after ${ctx.window.start}`
      : `${ctx.window.start} to ${ctx.window.end}`,
    cut,
  };
}

const PR05 = defineCheck({
  id: "PR05",
  claimKey: CLAIM_KEYS.LSA_LEADS_DISPUTED_HIGH,
  title: "high share of Local Services leads disputed",
  clientLabel: "Local Services leads you asked Google to credit back",
  group: "presence",
  metrics: ["DQ.population[table]"],
  confounders: [],
  requires: ["lsaLeads"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Few Local Services leads needed a credit request.",
  run(ctx: CheckCtx): CheckResult {
    const g = lsaGate(ctx, ["lsaLeads"]);
    if ("result" in g) return g.result;
    const s = ctx.settings.localServices;
    const { leads, scope, cut } = leadsInWindow(ctx, g.lsa);
    if (leads.length < s.disputeMinLeads)
      return {
        state: "insufficient_data",
        reason: `${leads.length} leads in ${scope} (needs ${s.disputeMinLeads})`,
      };
    const charged = leads.filter((l) => l.charged).length;
    const credited = leads.filter(
      (l) => String(l.creditState ?? "").toUpperCase() === "CREDITED",
    ).length;
    const pending = leads.filter(
      (l) => String(l.creditState ?? "").toUpperCase() === "PENDING",
    ).length;
    const disputed = credited + pending;
    const share = disputed / leads.length;
    if (share < s.disputeShare)
      return {
        state: "none_found",
        population: leads.length,
        note: `${disputed} of ${leads.length} leads disputed`,
      };
    const byType: Record<string, number> = {};
    for (const l of leads)
      if (isDisputedLead(l.creditState))
        byType[l.type ?? "UNKNOWN"] = (byType[l.type ?? "UNKNOWN"] ?? 0) + 1;
    return {
      state: "fires",
      findings: [
        {
          ...finding({
            claimKey: CLAIM_KEYS.LSA_LEADS_DISPUTED_HIGH,
            scope: ACCOUNT_SCOPE,
            cite: rowsRead(ctx, "lsaLeads"),
            facts: {
              lsa_leads_scope: scope,
              lsa_leads: leads.length,
              lsa_leads_charged: charged,
              lsa_leads_credited: credited,
              lsa_leads_credit_pending: pending,
              lsa_disputed_share_pct: pct(disputed, leads.length),
              lsa_disputed_by_lead_type: byType,
            },
            population: leads.length,
          }),
          ...(cut ? { limitedBy: [`Only ${scope} were read.`] } : {}),
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// PR06 — phone leads missed or very short
// ---------------------------------------------------------------------------

const PR06 = defineCheck({
  id: "PR06",
  claimKey: CLAIM_KEYS.LSA_CALLS_UNANSWERED,
  title: "Local Services phone leads missed or very short",
  clientLabel: "Local Services calls missed or cut short",
  group: "presence",
  metrics: ["DQ.population[table]"],
  confounders: [],
  requires: ["lsaConversations"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "Local Services calls are being answered.",
  run(ctx: CheckCtx): CheckResult {
    const g = lsaGate(ctx, ["lsaConversations"]);
    if ("result" in g) return g.result;
    const s = ctx.settings.localServices;
    const calls = g.lsa.conversations.filter(
      (c) => String(c.channel ?? "").toUpperCase() === "PHONE_CALL",
    );
    if (calls.length < s.callsMin)
      return {
        state: "insufficient_data",
        reason: `${calls.length} phone calls read (needs ${s.callsMin})`,
      };
    const answered = calls.filter((c) => c.callDurationMs != null);
    // not one call with a duration: the field was not returned, which says nothing about answering
    if (answered.length === 0)
      return {
        state: "not_checkable",
        reason: "no phone call carries a call duration",
        table: "lsaConversations",
        category: "our_gap",
      };
    const shortMs = s.shortCallSeconds * 1000;
    const short = answered.filter((c) => (c.callDurationMs ?? 0) < shortMs).length;
    const answerRate = answered.length / calls.length;
    const shortShare = short / answered.length;
    if (answerRate >= s.answerRateMin && shortShare < s.shortCallShare)
      return {
        state: "none_found",
        population: calls.length,
        note: `${answered.length} of ${calls.length} calls had talk time`,
      };
    return {
      state: "fires",
      findings: [
        {
          ...finding({
            claimKey: CLAIM_KEYS.LSA_CALLS_UNANSWERED,
            scope: ACCOUNT_SCOPE,
            cite: rowsRead(ctx, "lsaConversations"),
            facts: {
              lsa_calls: calls.length,
              lsa_calls_with_talk_time: answered.length,
              lsa_answer_rate_pct: pct(answered.length, calls.length),
              lsa_short_calls: short,
              lsa_short_call_seconds: s.shortCallSeconds,
              lsa_short_call_share_pct: pct(short, answered.length),
            },
            population: calls.length,
          }),
          limitedBy: [
            "A call with no talk time is counted as missed; Google does not say whether it went to voicemail.",
          ],
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// PR07 — licence / insurance verification running out
// ---------------------------------------------------------------------------

/** One entry per verification kind: the latest expiry wins (a renewal supersedes the old one). */
export function latestExpiries(
  rows: readonly LsaVerification[],
): Array<{ kind: string; type: string; expiry: string }> {
  const best = new Map<string, { kind: string; type: string; expiry: string; ms: number }>();
  for (const v of rows) {
    const status = String(v.status ?? "").toUpperCase();
    if (status === "FAILED" || status === "CANCELLED") continue;
    const add = (kind: string, expiry: string | null) => {
      const ms = lsaDayMs(expiry);
      if (ms == null || !expiry) return;
      const type = kind === "license" ? (v.licenseType ?? "LICENSE") : "INSURANCE";
      const key = `${kind}:${type}`;
      const cur = best.get(key);
      if (!cur || ms > cur.ms) best.set(key, { kind, type, expiry, ms });
    };
    add("license", v.licenseExpiry);
    add("insurance", v.insuranceExpiry);
  }
  return [...best.values()].map(({ kind, type, expiry }) => ({ kind, type, expiry }));
}

const PR07 = defineCheck({
  id: "PR07",
  claimKey: CLAIM_KEYS.LSA_VERIFICATION_EXPIRING,
  title: "Local Services licence or insurance expiring",
  clientLabel: "Local Services licence or insurance about to expire",
  group: "presence",
  metrics: ["DQ.population[table]"],
  confounders: [],
  requires: ["lsaVerifications"],
  impactFormula: "IMP_STRUCTURAL",
  noneFoundMeans: "No Local Services licence or insurance runs out soon.",
  run(ctx: CheckCtx): CheckResult {
    const g = lsaGate(ctx, ["lsaVerifications"]);
    if ("result" in g) return g.result;
    const { lsa } = g;
    if (lsa.verifications.length === 0)
      return {
        state: "not_checkable",
        reason: "no licence or insurance check was found",
        table: "lsaVerifications",
        category: "not_present",
      };
    const latest = latestExpiries(lsa.verifications);
    if (latest.length === 0)
      return {
        state: "not_checkable",
        reason: "no licence or insurance check carries an expiry date",
        table: "lsaVerifications",
        category: "not_present",
      };
    const anchor = anchorMs(ctx, lsa);
    if (anchor == null)
      return { state: "insufficient_data", reason: "no date to measure the expiry from" };
    const days = ctx.settings.localServices.expiryDays;
    const soon = latest
      .map((e) => ({
        ...e,
        daysLeft: Math.round(((lsaDayMs(e.expiry) as number) - anchor) / DAY_MS),
      }))
      .filter((e) => e.daysLeft <= days)
      .sort((a, b) => a.daysLeft - b.daysLeft);
    if (soon.length === 0) return { state: "none_found", population: latest.length };
    const rows: EvidenceRow[] = soon.slice(0, 10).map((e) => ({
      entity: { id: null, name: e.kind === "license" ? `Licence (${e.type})` : "Insurance" },
      cells: { expiry: e.expiry.slice(0, 10), days_left: e.daysLeft },
    }));
    return {
      state: "fires",
      findings: [
        finding({
          claimKey: CLAIM_KEYS.LSA_VERIFICATION_EXPIRING,
          scope: ACCOUNT_SCOPE,
          cite: rowsRead(ctx, "lsaVerifications"),
          facts: {
            lsa_verifications_expiring: soon.length,
            lsa_verifications_expired: soon.filter((e) => e.daysLeft < 0).length,
            lsa_soonest_days_left: soon[0]!.daysLeft,
            within_days: days,
          },
          population: latest.length,
          rows,
        }),
      ],
    };
  },
});

export const LSA_CHECKS: CheckDefinition[] = [PR04, PR05, PR06, PR07];
