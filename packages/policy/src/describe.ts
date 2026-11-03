// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Plain words for a policy (`policy check`, `policy show`, doctor, policy://current), and
// the starter file `init` writes.

import { howToRun, PRODUCT_NAME } from "@perfoads/store";
import { configuredTier } from "./evaluate.js";
import type { PolicyV1 } from "./schema.js";
import type { PolicyState } from "./source.js";

const dashed = (id: string): string => `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`;

const ids = (list: readonly string[]): string =>
  list.length ? list.map(dashed).join(", ") : "none";

/** What a valid policy allows, one sentence per line. */
export const describePolicy = (p: PolicyV1): string[] => {
  const l = p.limits;
  const lines = [
    p.kill_switch
      ? "Kill switch is ON: every change (undo too) is refused."
      : "Kill switch is off.",
    `Accounts the AI may read: ${ids([...new Set([...p.accounts.allow, ...p.accounts.write])])}.`,
    `Accounts that may be changed (after approval): ${ids(p.accounts.write)}.`,
    `A budget may change by at most ${l.max_budget_change_pct}% in one change (an undo may go back to exactly the old value).`,
    `Target CPA / ROAS may change by at most ${l.max_target_change_pct}% in one change.`,
    `At most ${l.writes_per_day} changes a day and ${l.writes_per_minute} a minute per account; at most ${l.max_ops_per_change} operations in one change; at most ${l.proposals_per_minute} proposals a minute and ${l.proposals_per_day} a day per account; at most ${l.undo_per_day} undo attempts a day per account (3 a minute and 20 a day per change).`,
  ];
  for (const id of p.accounts.write) {
    const cap = l.max_new_daily_spend[id];
    const abs = l.max_budget_change_abs[id];
    lines.push(
      `Account ${dashed(id)}: ${cap === undefined ? "spend can't go up (no max_new_daily_spend)" : `new daily spend at most ${cap} (account currency) in any 24 hours`}${abs === undefined ? "" : `; a budget may change by at most ${abs} in one change`}.`,
    );
  }
  lines.push(
    `New keywords start ${p.defaults.new_entities_paused ? "paused" : "enabled"}; broad match ${p.defaults.broad_match_requires_smart_bidding ? "only with Smart Bidding" : "allowed with any bidding"}.`,
  );
  for (const [id, terms] of Object.entries(p.brand_terms)) {
    lines.push(
      `Account ${dashed(id)}: ${terms.length} brand term(s) are never added as negatives.`,
    );
  }
  const tiers = Object.entries(p.tiers);
  lines.push(
    tiers.length
      ? `Approval tiers: ${tiers.map(([k, v]) => `${k} = ${v}`).join(", ")}; everything else needs a person (confirm).`
      : "Every change needs a person's approval (no tiers set).",
  );
  if (tiers.some(([, v]) => v === "auto")) {
    lines.push(
      "auto only applies to low-risk changes (pausing a campaign, lowering a budget); anything else stays confirm.",
    );
  }
  for (const type of ["update_budget", "update_campaign_status", "update_bidding"]) {
    if (configuredTier(p, type) === "blocked") lines.push(`${type} is blocked.`);
  }
  lines.push(
    `Reads stop when they would use the last ${p.ops_budget.reserve_for_writes_pct}% of today's Google Ads operations (kept for changes; live and test accounts each count on their own); doctor warns at ${p.ops_budget.warn_at_pct}%.`,
  );
  return lines;
};

/** The state in plain words: first line = status. */
export const describeState = (s: PolicyState): string[] => {
  switch (s.status) {
    case "none":
      return ["No policy file: read-only everywhere (every account can be read, none changed)."];
    case "ignored":
      return [`Policy file ignored: ${s.reason}`];
    case "invalid":
      return [
        "Policy file is NOT valid, so the server is read-only everywhere:",
        ...s.problems.map((p) => `  - ${p}`),
      ];
    case "valid":
      return [`Valid policy (version ${s.hash.slice(0, 12)}).`, ...describePolicy(s.policy)];
  }
};

/** policy://current: values only (the file name, never a full path). */
export const policyResource = (s: PolicyState): Record<string, unknown> => ({
  file: "policy.yaml (in the settings folder)",
  status: s.status,
  hash: s.status === "valid" || s.status === "invalid" ? s.hash : null,
  ...(s.status === "valid" ? { policy: s.policy } : {}),
  ...(s.status === "invalid" ? { problems: s.problems } : {}),
  summary: describeState(s),
});

/** The file `init` writes: read-only, every key explained. */
export const starterPolicy = (allow: readonly string[]): string => {
  const list = allow.map((id) => `"${dashed(id)}"`).join(", ");
  return `# ${PRODUCT_NAME} change policy (schema version 1).
# The server reads this file ONLY from its settings folder. A copy inside a project
# folder the AI works in is ignored. Any mistake (unknown key, wrong value) makes the
# whole file invalid, and then the server is read-only. Check it with:
#   ${howToRun("policy check")}
#
# Hardened setup: an AI with a terminal on your user account can edit this file. For
# real protection run the server and its settings folder under a separate OS user or in
# a container, and set approval_mode "code_only" in config.json (see the README).

version: 1

accounts:
  # Accounts the AI may read. Quote account ids: "123-456-7890".
  allow: [${list}]
  # Accounts that may be changed (each change still needs a person's approval).
  # Empty = read-only everywhere.
  write: []

limits:
  # Per account, in that account's own currency.
  max_budget_change_pct: 30        # biggest budget step in one change, in percent
  max_budget_change_abs: {}        # e.g. { "123-456-7890": 50 } = at most 50 per change
  max_new_daily_spend: {}          # e.g. { "123-456-7890": 100 } = budget raises + budgets of
                                   # campaigns turned on, over any 24 hours. Missing = spend
                                   # can't go up on that account.
  max_target_change_pct: 20        # target CPA / target ROAS step in one change, in percent
  writes_per_day: 50               # changes per account per 24 hours
  writes_per_minute: 10            # changes per account per minute
  max_ops_per_change: 200          # Google Ads operations in one change
  proposals_per_minute: 20         # new proposals per account per minute (undo not counted)
  proposals_per_day: 200           # new proposals per account per 24 hours
  undo_per_day: 50                 # undo attempts per account per 24 hours (each change: 3 a
                                   # minute and 20 a day, fixed)

defaults:
  new_entities_paused: true                  # new keywords start paused
  broad_match_requires_smart_bidding: true   # broad match only with Smart Bidding

# Words never added as negative keywords, per account, e.g. { "123-456-7890": ["Your Brand"] }.
# Empty = the account name is used as the brand.
brand_terms: {}

# Approval per change type: confirm (a person approves; the default), blocked (refused),
# or auto (no person; honoured only for pausing a campaign and lowering a budget).
tiers:
  "remove_*": blocked

ops_budget:
  warn_at_pct: 80               # doctor warns when today's Google Ads operations pass this
  reserve_for_writes_pct: 20    # reads stop before using this last share (kept for changes)

kill_switch: false              # true = every change is refused, undo too
`;
};
