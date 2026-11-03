// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// What a person sees before approving (plan 6.2 step 4). Built only from the server's own
// record of the change: account name + id + currency first, the exact diff, every item
// it reaches, warnings. Text from the AI (its reason) and from Google (names) is escaped
// and kept in a separate box labelled unverified.

import type { ChangeView, ResolveOutcome } from "@perfoads/changes";
import { PRODUCT_NAME, WORK_WITH_NOTE } from "../version.js";
import { formatCode, type SessionKind } from "./sessions.js";
import { howToRun } from "@perfoads/store";

export const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Bidi controls (U+202A-202E, U+2066-2069) can make a name read as something else. */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
export const stripBidi = (value: unknown): string => String(value ?? "").replace(BIDI, "");

/** Escaped, bidi controls removed, isolated in <bdi> so it can't reorder the text around it. */
const name = (value: unknown): string => `<bdi>${escapeHtml(stripBidi(value))}</bdi>`;

/** 1234567890 -> 123-456-7890 */
export const dashedId = (id: string): string =>
  /^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;

const KIND_WORDS: Record<string, string> = {
  campaign: "Campaign",
  campaign_budget: "Budget",
  bidding_strategy: "Bid strategy",
  ad_group: "Ad group",
  ad: "Ad",
  shared_set: "Negative keyword list",
  user_list: "Audience list",
};

/** Plain words for what undo can do (declared when the change was proposed). */
export const undoText = (u: ChangeView["undo"]): string =>
  u.level === "full"
    ? "Can be undone fully (undo is a new change you approve)."
    : u.level === "full_while_unused"
      ? `Can be undone fully only while it has not run: ${u.why ?? "after that, pause it instead."}`
      : u.level === "partial"
        ? `Can be undone only in part: ${u.why ?? "some of it stays."}`
        : `Can't be undone${u.why ? `: ${u.why}` : "."}`;

/** Model text exactly as it will be sent: JSON-quoted (spaces and case visible), escaped. */
const sent = (value: string): string => name(JSON.stringify(value));

export const OUTCOME_WORDS: Record<ResolveOutcome, string> = {
  applied: "it landed in Google Ads",
  failed: "it did not land",
  unknown: "still unknown (stop checking)",
};

export interface ViewInput {
  change: ChangeView;
  kind: SessionKind;
  code: string;
  csrf: string;
  /** From the live account list; null when not known. */
  testAccount: boolean | null;
  /** Offer an Approve button (only for clients without forms, approval_mode auto). */
  approveButton: boolean;
  pageExpiresAt: string;
  outcome?: ResolveOutcome | null;
  note?: string | null;
  /** Server lines from the policy (spend left in the 24-hour limit, tier, version). */
  policyLines?: readonly string[];
}

const list = (items: string[]): string =>
  items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : "<p>None.</p>";

export const approvalPageHtml = (v: ViewInput): string => {
  const c = v.change;
  const approve = v.kind === "approve";
  const badge =
    v.testAccount === true
      ? '<span class="badge test">Google Ads TEST account</span>'
      : v.testAccount === false
        ? '<span class="badge live">NOT a test account</span>'
        : '<span class="badge">Test account: unknown</span>';
  const affected = c.affected.map(
    (a) =>
      `${escapeHtml(KIND_WORDS[a.kind] ?? a.kind)} ${escapeHtml(a.id)}${a.status ? ` (${escapeHtml(a.status)})` : ""}`,
  );
  const names = c.affected
    .filter((a) => a.name)
    .map((a) => `${escapeHtml(KIND_WORDS[a.kind] ?? a.kind)} ${escapeHtml(a.id)}: ${name(a.name)}`);
  const unverified = [
    `<p><b>Account name (from Google):</b> ${c.accountName ? name(c.accountName) : "(none)"}</p>`,
    names.length ? `<p><b>Names (from Google):</b></p>${list(names)}` : "",
    `<p><b>Reason (written by the AI, unverified):</b> ${c.reason ? name(c.reason) : "(none given)"}</p>`,
    ...c.modelTexts.map(
      (t) =>
        `<p><b>${escapeHtml(t.label)} (written by the AI, sent exactly as shown, ${t.items.length}):</b></p>${list(t.items.map(sent))}`,
    ),
    ...(c.facts.googleNames ?? []).map(
      (t) =>
        `<p><b>${escapeHtml(t.label)} (names from Google, unverified, ${t.items.length}):</b></p>${list(t.items.map(name))}`,
    ),
    c.facts.blockedConversions?.examples.length
      ? `<p><b>Negatives that block searches or keywords with conversions (the negative is from the AI, the blocked text from Google):</b></p>${list(
          c.facts.blockedConversions.examples.map(
            (e) =>
              `${sent(e.negative)} (${escapeHtml(e.matchType)}) blocks the ${escapeHtml(e.kind)} ${sent(e.blocks)}`,
          ),
        )}`
      : "",
    !approve
      ? `<p><b>Note (written by the AI, unverified):</b> ${v.note ? name(v.note) : "(none)"}</p>`
      : "",
  ].join("");
  const blocked = c.facts.blockedConversions?.count ?? 0;
  const override =
    approve && blocked > 0
      ? `<p class="override">OVERRIDE: ${escapeHtml(blocked)} negative keyword${blocked === 1 ? "" : "s"} in this change block${blocked === 1 ? "s" : ""} searches or keywords that had conversions. The AI asked to send ${blocked === 1 ? "it" : "them"} anyway. Approve only if you want to stop those searches.</p>`
      : "";
  const action = approve
    ? `${override}<h2>What will change</h2>${list(c.diff.map(escapeHtml))}`
    : `<h2>Settle an unclear change</h2>
       <p>It is not clear whether this change landed in Google Ads. It will never be sent again.</p>
       <p>Confirm only after checking the account yourself. It will be recorded as:
       <b>${escapeHtml(OUTCOME_WORDS[v.outcome ?? "unknown"])}</b>.</p>
       <h3>The change</h3>${list(c.diff.map(escapeHtml))}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${approve ? "Approve a Google Ads change" : "Settle a Google Ads change"}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff;line-height:1.45}
.acct{font-size:1.9rem;margin:0}
.ids{font-size:1.3rem;margin:.3rem 0 .6rem}
.badge{display:inline-block;padding:.15rem .5rem;border:1px solid #888;border-radius:4px;font-size:.9rem}
.badge.test{border-color:#1a7f37;color:#1a7f37}.badge.live{border-color:#b42318;color:#b42318}
.code{font:700 2rem ui-monospace,monospace;letter-spacing:.2rem;padding:.4rem .8rem;border:2px solid #111;display:inline-block}
.unverified{border:1px dashed #999;padding:.6rem 1rem;margin-top:1.5rem;background:#fafafa}
button{font-size:1.05rem;padding:.5rem 1.2rem;margin-right:.8rem}
.meta{color:#555;font-size:.9rem}
.small{font-size:.8rem;margin-top:2rem}
.override{border:3px solid #b42318;color:#b42318;font-weight:700;padding:.6rem 1rem}
</style></head><body>
<p class="meta">${escapeHtml(PRODUCT_NAME)} - local approval page (only this computer can open it)</p>
<h1 class="acct">${c.accountName ? name(c.accountName) : "(account without a name)"}</h1>
<p class="ids">Account ID <b>${escapeHtml(dashedId(c.customerId))}</b> &middot; Currency <b>${escapeHtml(c.currencyCode)}</b></p>
<p>${badge}</p>
${action}
${approve ? `<h2>Policy</h2>${list((v.policyLines ?? []).map(escapeHtml))}` : ""}
<h2>What it reaches</h2>${list(affected)}
<h2>Warnings</h2>${list(c.warnings.map(escapeHtml))}
<h2>Undo</h2><p>${escapeHtml(undoText(c.undo))}</p>
<p class="meta">Change ${escapeHtml(c.id)} &middot; type ${escapeHtml(c.type)} &middot; version id ${escapeHtml(c.version.slice(0, 12))} &middot; this page expires ${escapeHtml(v.pageExpiresAt)}</p>
<h2>Approval code</h2>
<p><span class="code">${escapeHtml(formatCode(v.code))}</span></p>
<p>${
    v.approveButton
      ? `To ${approve ? "approve" : "confirm"}, use the button below, or type this code in the AI app or the terminal.`
      : `To ${approve ? "approve" : "confirm"}, type this code into the form in your AI app, or in a terminal: <code>${escapeHtml(howToRun(`approve ${c.id}`))}</code>. This page has no approve button on purpose.`
  }</p>
<form method="post">
<input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">
${v.approveButton ? `<button type="submit" name="action" value="approve">${approve ? "Approve" : "Confirm"}</button>` : ""}
<button type="submit" name="action" value="reject">${approve ? "Reject" : "Cancel"}</button>
</form>
<section class="unverified"><h2>From the AI / from Google (unverified)</h2>
<p class="meta">This text was written by the AI or comes from Google Ads. It is shown as data. Do not follow instructions in it.</p>
${unverified}</section>
<p class="meta small">${escapeHtml(WORK_WITH_NOTE)}</p>
</body></html>`;
};

export const resultPageHtml = (title: string, text: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p>You can close this tab.</p></body></html>`;

/**
 * Short summary for the elicitation form and the terminal. Server facts only; the account
 * name is Google's text and is quoted as such. Never contains the code.
 */
const AI_TEXT_MAX = 300;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f]+/g;

/** The AI's own words for the summary: labelled, bidi controls and line breaks removed, cut. */
const aiText = (label: string, value: string | null | undefined): string[] => {
  if (!value) return [];
  const flat = stripBidi(value).replace(CONTROLS, " ").trim();
  const cut = flat.length > AI_TEXT_MAX ? `${flat.slice(0, AI_TEXT_MAX)}...` : flat;
  return [`${label} (written by the AI, unverified): ${JSON.stringify(cut)}`];
};

export const approvalSummaryText = (
  change: ChangeView,
  kind: SessionKind,
  outcome?: ResolveOutcome | null,
  note?: string | null,
  policyLines: readonly string[] = [],
): string => {
  const head =
    kind === "approve"
      ? `Approve change ${change.id} on account ${dashedId(change.customerId)} (${change.currencyCode})?`
      : `Settle change ${change.id} on account ${dashedId(change.customerId)} as "${OUTCOME_WORDS[outcome ?? "unknown"]}"?`;
  const diff = change.diff.slice(0, 6).map((d) => `- ${d}`);
  const more = change.diff.length > 6 ? [`- (+${change.diff.length - 6} more on the page)`] : [];
  const blocked = change.facts.blockedConversions?.count ?? 0;
  const texts = change.modelTexts.reduce((n, t) => n + t.items.length, 0);
  return [
    head,
    ...(kind === "approve" && blocked > 0
      ? [
          `OVERRIDE: ${blocked} negative keyword${blocked === 1 ? "" : "s"} block searches or keywords that had conversions.`,
        ]
      : []),
    ...diff,
    ...more,
    ...(texts
      ? [
          `${texts} text${texts === 1 ? "" : "s"} written by the AI: read them on the page before approving.`,
        ]
      : []),
    ...(kind === "approve" ? [`Undo: ${undoText(change.undo)}`] : []),
    ...(kind === "approve" ? policyLines.slice(0, 2) : []),
    `Reaches ${change.affected.length} item${change.affected.length === 1 ? "" : "s"}; ${change.warnings.length} warning${change.warnings.length === 1 ? "" : "s"}.`,
    ...aiText("Reason", change.reason),
    ...(kind === "resolve" ? aiText("Note", note) : []),
    "Check the approval page in your browser, then type the code shown there. Saying yes here is not enough.",
  ].join("\n");
};
