// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The client-context gate: the one place the checks reach for the owner's own
 * answers (shared/clientContext.ts turns the caller's input into typed,
 * provenanced fields), in this order:
 *
 *   1. the per-campaign DECLARED TARGET, so a metric that had no bar to judge
 *      against stops being scored on the account's own average and printed as
 *      though it were absolute (the SO Keywords failure mode: a 2.6x winner
 *      read "losing money" because the account average was the hidden bar);
 *   2. PURPOSE and CONSTRAINTS: "respect
 *      their stated purpose, goals and constraints; e.g. never recommend
 *      pausing an always-on brand campaign";
 *   3. `tracksPostLeadOutcomes`, which is the difference between "your tracking
 *      is broken" and "you track revenue only, and here is what that hides";
 *   4. `grossMarginPct`, which gives SH21 a break-even
 *      return to judge campaigns against instead of "profit view unavailable".
 *
 * ------------------------------------------------------- provenance, the rule
 *
 * A MODEL'S GUESS IS NOT THE CLIENT'S WORD. Every field arrives as
 * `{value, source, asOf}` and only `source: 'client'` is a declaration. This is
 * not a corner case: on real accounts EVERY
 * per-campaign answer was AI-suggested and accepted unedited, so `'ai'` is the
 * normal path and the code is built for it.
 *
 * The two directions are deliberately ASYMMETRIC, because the two risks are:
 *
 *   - A TARGET HARDENS A VERDICT. "Your campaign misses your 3:1 target" is a
 *     stronger, more citable claim than "it is below your account average". A
 *     model's guess must never buy that upgrade, so an AI-sourced target is not
 *     read at all. `loadClientContext` already refuses to parse one; this file
 *     re-checks the source rather than trusting that, because a single missed
 *     branch upstream would otherwise ship a fabricated declaration.
 *   - A CONSTRAINT SOFTENS AN ASK. "Do not propose pausing this" cannot invent
 *     a finding and cannot make a number wrong — the finding survives, only the
 *     ask changes. So an AI-suggested constraint IS allowed to change the ask,
 *     and the sentence it produces says plainly that it was a suggestion nobody
 *     corrected. It is never quoted back as something the client said.
 *
 * ------------------------------------------------------ freshness, the caveat
 *
 * `asOf` is the questionnaire / context row's timestamp, and that row is
 * re-INSERTed with `NOW()` on every audit even when nothing was re-confirmed
 * (see `ClientContext.questionnaireAsOf`). So NOTHING here prints a date or
 * says "as of", "current", "recently" or "still". An answer is presented as
 * something the client entered at some point, never as something true today.
 *
 * ---------------------------------------------------------------- D8 holds
 *
 * A constraint never deletes a finding. `applyClientConstraintGate` only ever
 * REWRITES the ask and stamps a citable reason on the scope and the facts; it
 * has no path that drops a finding or returns `none_found`. The age gate may
 * hold a verdict back because the number itself is not yet meaningful; a
 * constraint is a fact about the client's intent, and intent does not unspend
 * money.
 *
 * ------------------------------------------------------------ not done here
 *
 *   - "a deliberately NARROW campaign must stop being reported as a defect"
 *     (§3b). v3 has no check that reports narrowness as a defect: the two
 *     candidates, PR02 (channel types present) and AS12 (brand vs prospecting
 *     split), are `IMP_NONE` context and a spend-tier-gated band respectively.
 *     Recorded, not pretended — the same way spendTierGate.ts records rules 114
 *     and 116 as having no check to attach to.
 *   - the PROSE veto. `evidence/scoring/impossibleAdvice.ts` is where "pause a
 *     brand campaign" is refused as written text (`IA_BRAND_PAUSE`), and an
 *     `IA_CLIENT_ALWAYS_ON` row belongs beside it. That file is owned by
 *     another session right now, so this gate does the deterministic half — the
 *     caller's instruction (`WriterHints.clientConstraint`) reaches the writer
 *     through `CheckScope.clientConstraint`.
 */
import { breakEvenRoas, parseGrossMarginPct } from "../shared/grossMargin.js";
import type { ClientContext, DeclaredTarget } from "../shared/clientContext.js";
import type { CheckCtx, CheckFinding, CheckResult, CheckScope, WriterHints } from "./types.js";

// ---------------------------------------------------------------------------
// Reaching the context
// ---------------------------------------------------------------------------

/** The campaign a finding is about, or null when the scope belongs to no campaign. */
export function campaignIdOfScope(scope: CheckScope): string | null {
  return scope.type === "campaign" ? scope.id : (scope.campaignId ?? null);
}

function contextOf(ctx: CheckCtx): ClientContext | null {
  return ctx.clientContext ?? null;
}

/** One campaign's answers, or null. */
export function campaignContextOf(ctx: CheckCtx, campaignId: string | null) {
  if (!campaignId) return null;
  return contextOf(ctx)?.campaigns[campaignId] ?? null;
}

// ---------------------------------------------------------------------------
// 1 — the declared target
// ---------------------------------------------------------------------------

export interface ClientDeclaredTarget {
  target: DeclaredTarget;
  /** the campaign the client declared it for. */
  campaignId: string;
  /** the client's own words, verbatim, for the evidence line. */
  text: string;
}

/**
 * The efficiency bar this campaign's OWNER declared, or null.
 *
 * Client rows only, and only when the free text parsed unambiguously. Three
 * separate conditions have to hold, and any one of them failing yields null
 * rather than a guess:
 *   - the row's `source` is `'client'` (an AI pre-fill is not a declaration);
 *   - `declaredTarget.source` is `'client'` too — a second guard against a
 *     future loader change that widens what it parses;
 *   - `parseDeclaredTarget` returned a value, i.e. the text named a metric and
 *     a number. "As high as possible" is not a target.
 */
export function declaredTargetFor(
  ctx: CheckCtx,
  campaignId: string | null,
): ClientDeclaredTarget | null {
  const cc = campaignContextOf(ctx, campaignId);
  if (!cc) return null;
  if (cc.source !== "client") return null;
  if (cc.declaredTarget.source !== "client") return null;
  const target = cc.declaredTarget.value;
  if (!target) return null;
  return { target, campaignId: cc.campaignId, text: cc.target.value ?? "" };
}

/**
 * How the bar reads in the report.
 *
 * A range declares two numbers and the client is asking for BOTH ends to be
 * respected, so the bar taken is the demanding end: the LOW end of a ROAS range
 * (3-5:1 means "at least 3") and the HIGH end of a CPA range ($12-30 means "no
 * more than 30"). An open-ended "6:1+" is already a floor.
 */
export function targetBar(t: DeclaredTarget): number {
  return t.kind === "roas" ? t.low : t.high;
}

/** The bar as a client reads it — never a date, never "current" (see the freshness caveat). */
export function targetSentence(d: ClientDeclaredTarget): string {
  const bar = targetBar(d.target);
  return d.target.kind === "roas"
    ? `you set a return target of ${bar}:1 for this campaign in your context`
    : `you set a cost-per-conversion target of ${bar} for this campaign in your context`;
}

/**
 * The sentence for the FALLBACK, and the reason this file exists.
 *
 * When no target was declared, a check that needs one is judging against the
 * account's own average. That is a legitimate bar and the finding stays — but
 * it is a RELATIVE bar, and printing it as an absolute verdict is exactly how
 * a 2.6x winner came to read "losing money" in the SO Keywords work. The check
 * carries this note so the writer states which bar it used.
 */
export const ACCOUNT_AVERAGE_BAR_NOTE =
  "judged against this account's own average, not an absolute bar — no target was declared for this campaign in your context";

/**
 * Why an AI-suggested target was NOT used, for the trace.
 *
 * Emitted only when there IS an AI answer, so it never appears for a campaign
 * nobody was asked about.
 */
export function aiTargetIgnoredNote(ctx: CheckCtx, campaignId: string | null): string | null {
  const cc = campaignContextOf(ctx, campaignId);
  if (!cc || cc.source === "client") return null;
  if (!cc.target.value) return null;
  return `a suggested target ("${cc.target.value}") exists for this campaign and was NOT used as a bar: it was never confirmed by the account owner, so it is not a declaration`;
}

// ---------------------------------------------------------------------------
// 2 — purpose and constraints
// ---------------------------------------------------------------------------

/**
 * What "always-on" looks like in free text a human typed, or a model wrote for
 * one. Deliberately narrow: every pattern names the intent explicitly. A
 * campaign described as "our main campaign" is not always-on, and guessing that
 * it is would silence a real recommendation on a hunch.
 */
export const ALWAYS_ON_PATTERNS: readonly RegExp[] = [
  /\balways[-\s]?on\b/i,
  /\bmust\s+(?:stay|remain|be\s+kept|keep)\s+(?:on|running|live|active|enabled)\b/i,
  /\bneeds?\s+to\s+(?:stay|remain)\s+(?:on|running|live|active)\b/i,
  /\bnever\s+(?:pause|paused|pausing|turn(?:ed)?\s+off|switch(?:ed)?\s+off)\b/i,
  /\b(?:do\s+not|don'?t|never)\s+pause\b/i,
  /\b(?:cannot|can'?t|must\s+not)\s+be\s+paused\b/i,
  /\brun\s+(?:it\s+)?(?:24\/7|continuously|year[-\s]?round|all\s+year)\b/i,
];

export interface AlwaysOnDeclaration {
  /** the client's (or the model's) words, verbatim. */
  text: string;
  /** which answer it was found in. */
  field: "constraints" | "purpose";
  /** 'client' = the client typed or confirmed it. 'ai' = a pre-fill nobody corrected. */
  source: "client" | "ai";
}

/**
 * An always-on constraint on this campaign, or null.
 *
 * `constraints` is read first because that is the answer the question asks for;
 * `purpose` is read second because "brand defence, kept on all year" is how a
 * real client answers the purpose question. The field is recorded so the trace
 * can say where it came from.
 */
export function alwaysOnDeclaration(
  ctx: CheckCtx,
  campaignId: string | null,
): AlwaysOnDeclaration | null {
  const cc = campaignContextOf(ctx, campaignId);
  if (!cc) return null;
  for (const field of ["constraints", "purpose"] as const) {
    const text = cc[field].value;
    if (!text) continue;
    if (ALWAYS_ON_PATTERNS.some((re) => re.test(text))) {
      return { text, field, source: cc.source };
    }
  }
  return null;
}

/**
 * The checks whose findings on a campaign are read against an always-on
 * declaration: a campaign that spends without converting (TR06) and a decline
 * (TR01). A DECLARED LIST, like brandGate.ts and businessTypeGate.ts, so a
 * stamped fact traces back to one place.
 */
export const ALWAYS_ON_CHECKS: readonly string[] = ["TR01", "TR06"];

/**
 * The always-on rule in the gate chain. Applied for EVERY check but acting only on the ones in
 * `ALWAYS_ON_CHECKS`, and never on anything but a `fires` result.
 *
 * What it changes, and nothing else:
 *   - three `facts` rows, so the declaration is citable;
 *   - when the caller passed `WriterHints.clientConstraint` and it returns text:
 *     `scope.clientConstraint` and the machine `note` carry that text.
 *
 * What it never changes: the finding's existence, its evidence, its impact and
 * its severity. D8 — a constraint must not silently delete a real finding.
 */
export function applyClientConstraintGate(
  checkId: string,
  ctx: CheckCtx,
  r: CheckResult,
  checks: readonly string[] = ALWAYS_ON_CHECKS,
): CheckResult {
  if (r.state !== "fires") return r;
  if (!checks.includes(checkId)) return r;
  if (!contextOf(ctx)) return r;

  let touched = 0;
  const findings = r.findings.map((f): CheckFinding => {
    const d = alwaysOnDeclaration(ctx, campaignIdOfScope(f.scope));
    if (!d) return f;
    touched += 1;
    const instruction = safeInstruction(ctx, checkId, d);
    return {
      ...f,
      ...(instruction ? { scope: { ...f.scope, clientConstraint: instruction } } : {}),
      facts: {
        ...f.facts,
        client_constraint: "always_on",
        client_constraint_source: d.source,
        client_constraint_field: d.field,
      },
      ...(instruction ? { note: [f.note, instruction].filter(Boolean).join("; ") } : {}),
    };
  });
  return touched === 0
    ? r
    : { state: "fires", findings, ...(r.withheld ? { withheld: r.withheld } : {}) };
}

/**
 * The caller's instruction, or null. A hint that throws or returns anything but a
 * non-empty string is ignored: the finding stands exactly as the check wrote it.
 * The engine wraps the caller's hint to record a warning (`guardWriterHints`); this
 * catch is for callers that run a check directly.
 */
function safeInstruction(ctx: CheckCtx, checkId: string, d: AlwaysOnDeclaration): string | null {
  const hint = ctx.writerHints?.clientConstraint;
  if (typeof hint !== "function") return null;
  try {
    const v: unknown = hint(checkId, d);
    return typeof v === "string" && v.trim() !== "" ? v : null;
  } catch {
    return null;
  }
}

/**
 * The caller's `WriterHints` with `clientConstraint` guarded: a throw or a
 * non-string result becomes null and one warning per check id.
 */
export function guardWriterHints(hints: WriterHints, warn: (message: string) => void): WriterHints {
  const hint = hints.clientConstraint;
  if (typeof hint !== "function") return {};
  const warned = new Set<string>();
  const once = (checkId: string, why: string) => {
    if (warned.has(checkId)) return;
    warned.add(checkId);
    warn(`writerHints.clientConstraint for ${checkId} ${why}; ignored, the finding is unchanged`);
  };
  return {
    clientConstraint: (checkId, d) => {
      try {
        const v: unknown = hint(checkId, d);
        if (v == null) return null;
        if (typeof v === "string") return v;
        once(checkId, "returned a non-string");
        return null;
      } catch {
        once(checkId, "threw");
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 3 — tracksPostLeadOutcomes
// ---------------------------------------------------------------------------

/**
 * Whether the client said they follow a lead past the form fill.
 *
 * Account-level, so it comes off the questionnaire the client submitted and its
 * source is `'client'` for every field. The value is free-ish text from a
 * select, so it is normalised to three states and anything unrecognised is
 * `null` — an answer we cannot read is not an answer.
 */
export function tracksPostLeadOutcomes(ctx: CheckCtx): "yes" | "no" | null {
  const raw = contextOf(ctx)?.account.tracksPostLeadOutcomes;
  if (!raw || raw.source !== "client" || !raw.value) return null;
  const v = raw.value.trim().toLowerCase();
  if (
    /^(yes|true|y)\b/.test(v) ||
    /\b(crm|offline conversion|closed[- ]won|revenue back)\b/.test(v)
  )
    return "yes";
  if (
    /^(no|false|n)\b/.test(v) ||
    /\b(not tracked|we do not|we don'?t|lead volume only|form fills only)\b/.test(v)
  )
    return "no";
  return null;
}

/**
 * The half-sentence that turns "we could not judge this" into "we could not
 * judge this, and here is what that hides".
 *
 * Appended to an abstention reason, never printed alone. Returns null when the
 * client answered nothing, so an account that skipped the question reads
 * exactly as it did before this file existed.
 *
 * No date and no "currently": the freshness caveat at the top applies.
 */
export function postLeadOutcomeRider(ctx: CheckCtx): string | null {
  const answer = tracksPostLeadOutcomes(ctx);
  if (answer === "no") {
    return "your context says outcomes after the lead are not fed back to Google Ads, so every conversion number in this audit stops at the form fill — it can show which campaigns produce leads, never which produce customers";
  }
  if (answer === "yes") {
    return "your context says outcomes after the lead ARE followed, so the value is there to be sent back to Google Ads and judged on";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4 — the stated gross margin (ecommerce)
// ---------------------------------------------------------------------------

export interface ClientGrossMargin {
  /** share of a sale left after product cost and shipping, before ads (1-95). */
  marginPct: number;
  /** 100 / marginPct — the return on ad spend that only covers product cost. */
  breakEvenRoas: number;
}

/**
 * The margin the client typed in the intake form, or null.
 *
 * Client-sourced only (the questionnaire is the client's own answer). A ROUGH
 * figure by the question's own wording, so anything priced from it is an
 * ESTIMATE and must say so. Null = not asked, skipped ("I don't know") or out
 * of range, or the intake business type is not `ecommerce` — and then every
 * caller behaves exactly as it did before.
 */
export function clientGrossMargin(ctx: CheckCtx): ClientGrossMargin | null {
  const account = contextOf(ctx)?.account;
  // The question is only asked of online stores; a stale answer on any other type is ignored.
  if (account?.businessType.value !== "ecommerce") return null;
  const raw = account.grossMarginPct;
  if (!raw || raw.source !== "client") return null;
  const marginPct = parseGrossMarginPct(raw.value);
  if (marginPct == null) return null;
  return { marginPct, breakEvenRoas: breakEvenRoas(marginPct) };
}
