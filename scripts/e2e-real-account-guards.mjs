// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Guards of the real-account live run (scripts/e2e-real-account.mjs). No Google: each one
// throws (or answers ok: false) before anything could be sent; only the settings-folder and
// E2E_OUT checks and the policy swap touch the disk. Tested by
// scripts/e2e-real-account-guards.test.mjs (node --test).

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { URL } from "node:url";

export const CONFIRM = "I-understand-this-is-a-live-account";
/** Every campaign and list the run makes is named with this (plus the run's stamp). */
export const NAME_PREFIX = "PerfoAds MCP test - do not enable";
/** Sitelink and callout texts start with this. */
export const TEXT_PREFIX = "PerfoAds test";
/** The run's own campaigns: this daily budget, raised once to MAX_BUDGET and back. */
export const OWN_BUDGET = "1.00";
export const MAX_BUDGET = "2.00";
/** Live operations: no new step starts past OPS_STEP_STOP, so clean-up ends under OPS_CAP. */
export const OPS_CAP = 1500;
export const OPS_STEP_STOP = 1300;
/** New spend a day the run's policy allows (E2E_REAL_SPEND_CAP, USD): default and range. */
export const SPEND_CAP_DEFAULT = 2;
export const SPEND_CAP_MIN = 2;
export const SPEND_CAP_MAX = 5;
/** The window of the policy's writes_per_minute; a refused write waits this long, at most this often. */
export const MINUTE_MS = 60_000;
export const RETRY_WAIT_MS = 65_000;
export const MAX_WRITE_RETRIES = 3;

export class GuardError extends Error {
  constructor(message) {
    super(`refused: ${message}`);
    this.name = "GuardError";
  }
}
const refuse = (message) => {
  throw new GuardError(message);
};

const digits = (id) => String(id ?? "").replace(/-/g, "");
const isId = (id) => /^\d+$/.test(String(id ?? ""));

/** Env checks before anything starts (no runtime, no Google yet). */
export const checkStartEnv = (env) => {
  const customerId = digits(env.E2E_REAL_CUSTOMER_ID);
  if (!/^\d{10}$/.test(customerId))
    refuse("E2E_REAL_CUSTOMER_ID must be the 10-digit id of the live account to test on");
  if (env.E2E_REAL_CONFIRM !== CONFIRM) refuse(`E2E_REAL_CONFIRM must be exactly ${CONFIRM}`);
  if (!env.PERFOADS_MCP_HOME) refuse("PERFOADS_MCP_HOME must name the settings folder to use");
  const brandTerms = String(env.E2E_REAL_BRAND_TERMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (brandTerms.length === 0)
    refuse("E2E_REAL_BRAND_TERMS must list the account's brand terms (comma-separated)");
  if (brandTerms.some((t) => t.length > 80 || !/[\p{L}\p{N}]/u.test(t)))
    refuse("each brand term needs 1-80 characters with a letter or digit");
  let finalUrl;
  try {
    finalUrl = new URL(String(env.E2E_REAL_FINAL_URL ?? ""));
  } catch {
    refuse("E2E_REAL_FINAL_URL must be the account's own https home page");
  }
  if (finalUrl.protocol !== "https:" || !finalUrl.hostname.includes("."))
    refuse("E2E_REAL_FINAL_URL must be an https URL");
  const spendCap = checkSpendCap(env.E2E_REAL_SPEND_CAP);
  return { customerId, brandTerms, finalUrl: finalUrl.href, spendCap };
};

/**
 * E2E_REAL_SPEND_CAP: the run policy's new spend a day (USD), unset = $2. A same-day re-run
 * needs more, as the 24-hour window still holds the first run's switch-on.
 */
export const checkSpendCap = (value) => {
  if (value === undefined || String(value).trim() === "") return SPEND_CAP_DEFAULT;
  const text = String(value).trim();
  const cap = Number(text);
  if (!/^\d+(\.\d{1,2})?$/.test(text) || cap < SPEND_CAP_MIN || cap > SPEND_CAP_MAX)
    refuse(`E2E_REAL_SPEND_CAP must be a dollar amount from ${SPEND_CAP_MIN} to ${SPEND_CAP_MAX}`);
  return cap;
};

/**
 * The account the run acts on: the one named, not a test account, not a manager. Takes the
 * account list entry ({customerId, isTestAccount, isManager}) or the customer row from GAQL
 * ({id, testAccount, manager}). Unknown = refused.
 */
export const checkAccount = (acct, customerId) => {
  if (!acct) refuse("the account is not reachable with this sign-in");
  const id = digits(acct.customerId ?? acct.id);
  const test = acct.isTestAccount ?? acct.testAccount;
  const manager = acct.isManager ?? acct.manager;
  if (id !== customerId) refuse("the account found is not E2E_REAL_CUSTOMER_ID");
  if (test !== false) refuse("this run is for a live (non-test) account only");
  if (manager !== false) refuse("the account is a manager account");
  return true;
};

/** What the run made itself, by kind; changes it proposed; names it proposed. */
export const createOwned = (stamp) => ({
  stamp,
  campaign: new Set(),
  campaign_budget: new Set(),
  ad_group: new Set(),
  ad: new Set(),
  criterion: new Set(),
  shared_set: new Set(),
  change: new Set(),
  names: new Set(),
  userListId: undefined,
});

const own = (owned, kind, id, what) => {
  if (!isId(id) || !owned[kind]?.has(String(id)))
    refuse(`${what} ${String(id)} was not made by this run`);
};
const keysOnly = (params, allowed, type) => {
  for (const k of Object.keys(params ?? {}))
    if (!allowed.includes(k)) refuse(`${type}: key ${k} is not used by this run`);
};
const ownText = (owned, text, what) => {
  if (typeof text !== "string" || !text.includes(owned.stamp))
    refuse(`${what} "${String(text)}" is not this run's own text`);
};
const prefixed = (text, prefix, what) => {
  if (typeof text !== "string" || !text.startsWith(prefix))
    refuse(`${what} must start with "${prefix}"`);
};
const ownName = (owned, name, what) => {
  prefixed(name, NAME_PREFIX, what);
  ownText(owned, name, what);
};
const cents = (amount) => {
  if (typeof amount !== "string" || !/^\d+(\.\d{1,2})?$/.test(amount)) refuse("bad amount");
  const [a, b = ""] = amount.split(".");
  return Number(a) * 100 + Number(b.padEnd(2, "0"));
};
const sameUrl = (url, finalUrl, what) => {
  let a;
  try {
    a = new URL(String(url)).href;
  } catch {
    refuse(`${what} is not a URL`);
  }
  if (a !== finalUrl) refuse(`${what} must be E2E_REAL_FINAL_URL`);
};

/**
 * Every proposal of the run, checked before propose_change: only the run's own ids, its own
 * texts and the run's caps. Any other change type is refused.
 */
export const checkProposal = (type, params, ctx) => {
  const { owned, finalUrl } = ctx;
  const p = params ?? {};
  switch (type) {
    case "create_campaign": {
      keysOnly(
        p,
        [
          "name",
          "campaign_type",
          "daily_budget",
          "bidding",
          "networks",
          "locations",
          "language_ids",
          "contains_eu_political_advertising",
          "ad_groups",
          "negatives",
        ],
        type,
      );
      ownName(owned, p.name, "campaign name");
      if (p.campaign_type !== "SEARCH") refuse("only Search campaigns");
      if (p.daily_budget !== OWN_BUDGET) refuse(`own daily budget must be ${OWN_BUDGET}`);
      const n = p.networks ?? {};
      if (n.google_search !== true || n.search_partners !== false || n.display !== false)
        refuse("Google Search only: no Search Partners, no Display");
      for (const g of p.ad_groups ?? []) {
        ownText(owned, g.name, "ad group name");
        for (const k of g.keywords ?? []) ownText(owned, k.text, "keyword");
        if (g.ad) sameUrl(g.ad.final_url, finalUrl, "ad final URL");
      }
      for (const k of p.negatives ?? []) ownText(owned, k.text, "negative");
      return true;
    }
    case "update_budget":
      keysOnly(p, ["budget_id", "daily_amount"], type);
      own(owned, "campaign_budget", p.budget_id, "budget");
      if (cents(p.daily_amount) > cents(MAX_BUDGET)) refuse(`budget above ${MAX_BUDGET}`);
      return true;
    case "update_campaign_status":
      keysOnly(p, ["campaign_id", "status"], type);
      own(owned, "campaign", p.campaign_id, "campaign");
      if (p.status !== "ENABLED" && p.status !== "PAUSED") refuse("status ENABLED or PAUSED only");
      return true;
    case "update_bidding":
      keysOnly(p, ["campaign_id", "target_cpa"], type);
      own(owned, "campaign", p.campaign_id, "campaign");
      return true;
    case "add_campaign_negatives":
      keysOnly(p, ["campaign_ids", "negatives"], type);
      if (!p.campaign_ids?.length) refuse("no campaign");
      for (const id of p.campaign_ids) own(owned, "campaign", id, "campaign");
      for (const k of p.negatives ?? []) ownText(owned, k.text, "negative");
      return true;
    case "remove_campaign_negatives":
      keysOnly(p, ["campaign_id", "negatives"], type);
      own(owned, "campaign", p.campaign_id, "campaign");
      for (const k of p.negatives ?? []) ownText(owned, k.text, "negative");
      return true;
    case "add_shared_negatives":
      // A new list only: an existing list (shared_set_id) is never touched.
      keysOnly(p, ["new_list_name", "negatives", "link_campaign_ids"], type);
      ownName(owned, p.new_list_name, "list name");
      for (const id of p.link_campaign_ids ?? []) own(owned, "campaign", id, "campaign");
      for (const k of p.negatives ?? []) ownText(owned, k.text, "negative");
      return true;
    case "add_keywords":
      keysOnly(p, ["ad_group_id", "keywords"], type);
      own(owned, "ad_group", p.ad_group_id, "ad group");
      for (const k of p.keywords ?? []) ownText(owned, k.text, "keyword");
      return true;
    case "pause_keyword":
      keysOnly(p, ["keywords"], type);
      if (!p.keywords?.length) refuse("no keyword");
      for (const k of p.keywords) {
        own(owned, "ad_group", k.ad_group_id, "ad group");
        own(owned, "criterion", k.criterion_id, "keyword");
      }
      return true;
    case "update_rsa_text":
      keysOnly(p, ["ad_group_id", "ad_id", "headlines", "descriptions", "path1"], type);
      own(owned, "ad_group", p.ad_group_id, "ad group");
      own(owned, "ad", p.ad_id, "ad");
      for (const h of [...(p.headlines ?? []), ...(p.descriptions ?? [])])
        ownText(owned, h.text, "ad text");
      return true;
    case "add_sitelinks":
      keysOnly(p, ["campaign_id", "sitelinks"], type);
      own(owned, "campaign", p.campaign_id, "campaign");
      for (const s of p.sitelinks ?? []) {
        prefixed(s.link_text, TEXT_PREFIX, "sitelink text");
        ownText(owned, s.link_text, "sitelink text");
        sameUrl(s.final_url, finalUrl, "sitelink URL");
      }
      return true;
    case "add_callouts":
      keysOnly(p, ["campaign_id", "callouts"], type);
      own(owned, "campaign", p.campaign_id, "campaign");
      for (const c of p.callouts ?? []) {
        prefixed(c.text, TEXT_PREFIX, "callout text");
        ownText(owned, c.text, "callout text");
      }
      return true;
    case "add_audience_exclusions":
      // The one existing item the run uses: a user list read from the account, attached
      // only to the run's own campaign.
      keysOnly(p, ["campaign_id", "user_list_ids"], type);
      own(owned, "campaign", p.campaign_id, "campaign");
      if (
        !owned.userListId ||
        p.user_list_ids?.length !== 1 ||
        String(p.user_list_ids[0]) !== owned.userListId
      )
        refuse("audience exclusion uses only the list picked at the start");
      return true;
    default:
      return refuse(`change type ${type} is not part of this run`);
  }
};

/** undo_change only on a change this run proposed. */
export const checkUndo = (changeId, ctx) => {
  if (!ctx.owned.change.has(String(changeId)))
    refuse(`change ${String(changeId)} was not proposed by this run`);
  return true;
};

const AFFECTED_KINDS = ["campaign", "campaign_budget", "ad_group", "ad", "shared_set"];

/**
 * The change as the server built it (propose_change / undo_change answer): this account, and
 * everything it reaches made by this run (the picked user list aside).
 */
export const checkAffected = (change, ctx) => {
  if (!change) refuse("no change in the answer");
  if (digits(change.account?.customerId) !== ctx.customerId)
    refuse("the change is for another account");
  for (const a of change.affected ?? []) {
    if (a.kind === "user_list") {
      if (String(a.id) !== ctx.owned.userListId) refuse(`user list ${a.id} was not picked`);
    } else if (AFFECTED_KINDS.includes(a.kind)) {
      own(ctx.owned, a.kind, a.id, a.kind);
    } else {
      refuse(`the change reaches a ${a.kind}, which this run never touches`);
    }
  }
  return true;
};

const dashed = (id) => `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`;

/**
 * The approval page, read before the "browser" approves: right account, shown as NOT a
 * test account, no OVERRIDE, and the change on it is one the run checked. ok: false = the
 * runner rejects the page instead.
 */
export const checkApprovalPage = (html, ctx) => {
  const body = String(html ?? "");
  if (!body.includes(`Account ID <b>${dashed(ctx.customerId)}</b>`))
    return { ok: false, why: "page is for another account" };
  if (!body.includes('<span class="badge live">NOT a test account</span>'))
    return { ok: false, why: "page does not show a live account" };
  if (body.includes('<p class="override">')) return { ok: false, why: "page has an OVERRIDE" };
  const changeId = /Change ([^\s<&]+) &middot; type /.exec(body)?.[1];
  if (!changeId || !ctx.vetted.has(changeId))
    return { ok: false, why: "page is for a change the run did not check" };
  return { ok: true, why: "", changeId };
};

/** A thing clean-up would remove: made by this run (by id or the exact name it proposed). */
export const checkCleanupTarget = (kind, id, name, owned) => {
  const byId = isId(id) && owned[kind]?.has(String(id));
  const byName = typeof name === "string" && owned.names.has(name);
  if (!byId && !byName) refuse(`${kind} ${String(id)} was not made by this run`);
  ownName(owned, name, `${kind} name`);
  return true;
};

/** The own budget of a run campaign: not shared, used by that one campaign only. */
export const checkOwnBudget = (budget) => {
  if (!budget) refuse("budget not found");
  if (budget.explicitlyShared !== false) refuse("budget is shared");
  if (Number(budget.referenceCount ?? 0) > 1) refuse("budget is used by other campaigns");
  return true;
};

/** Live operations of the run so far; refuses a new step past OPS_STEP_STOP. */
export const checkOps = (usedNow, usedAtStart) => {
  const run = usedNow - usedAtStart;
  if (run >= OPS_STEP_STOP)
    refuse(`${run} live operations used by this run; stopping before ${OPS_CAP}`);
  return run;
};

/**
 * After the on/off step (whatever its outcome) the run's campaign must read back PAUSED;
 * anything else stops the run, and clean-up removes the campaign first.
 */
export const checkStillPaused = (status, what) => {
  if (status !== "PAUSED")
    refuse(`${what} reads ${String(status ?? "nothing")} after the on/off step, not PAUSED`);
  return true;
};

/**
 * Clean-up order. Google refuses removing a shared list a campaign still links to, so the
 * list (with its links) goes first while B still exists. Only when B may be on (anything
 * but PAUSED, unknown included) does B go first.
 */
export const cleanupOrder = (bStatus) =>
  bStatus === "PAUSED" ? ["list", "B", "A"] : ["B", "list", "A"];

/**
 * How long to wait before the next write so the run stays under the policy's
 * writes_per_minute: fewer than (limit - 2) writes (at least 1 free slot) in the last minute.
 * `times` = when the run's earlier writes were sent (ms).
 */
export const paceWaitMs = (times, limit, now) => {
  const room = Math.max(1, limit - 2);
  const inWindow = times.filter((t) => t > now - MINUTE_MS).sort((a, b) => a - b);
  if (inWindow.length < room) return 0;
  // The oldest (count - room + 1) writes must leave the window; +1 s for clock edges.
  return inWindow[inWindow.length - room] + MINUTE_MS - now + 1_000;
};

/**
 * A refused propose_change / undo_change is tried again (after RETRY_WAIT_MS) only for the
 * per-minute write limit, at most MAX_WRITE_RETRIES times. `r` = the call's answer
 * ({ ok, sc, text }); `retriesDone` = retries already made.
 */
export const retryWrite = (r, retriesDone) => {
  if (r.ok || retriesDone >= MAX_WRITE_RETRIES) return false;
  const refusal = r.sc?.refused ?? r.sc?.error ?? null;
  if (refusal && refusal.code === "policy_refused" && refusal.rule === "limits.writes_per_minute")
    return true;
  return /Try again in a minute/.test(String(r.text ?? ""));
};

/** The approval page's button: approve only a page that passed its checks, and never after a stop. */
export const approvalAction = (pageOk, stopping) => (pageOk && !stopping ? "approve" : "reject");

/** The first line of the run's policy.yaml: a file starting with it is a crashed run's. */
export const POLICY_HEADER = "# Written by scripts/e2e-real-account.mjs";
const BACKUP_PREFIX = "policy.yaml.e2e-real-backup-";

/**
 * The settings folder before the run: refused when an earlier run left its policy.yaml or a
 * backup of the folder's own policy behind (the run would otherwise treat those as the
 * folder's own state and "restore" them).
 */
export const checkPolicyFolder = (dir) => {
  const file = path.join(dir, "policy.yaml");
  const backups = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.startsWith(BACKUP_PREFIX))
        .sort()
    : [];
  const ours = existsSync(file) && readFileSync(file, "utf8").startsWith(POLICY_HEADER);
  if (backups.length)
    refuse(
      `an earlier run left ${backups.join(", ")} in ${dir}. Fix by hand: ` +
        (ours ? "delete policy.yaml there (it is the run's own), then " : "") +
        `rename the newest backup to policy.yaml (or delete the backups if the folder had no policy.yaml before), then start again`,
    );
  if (ours)
    refuse(
      `${file} was written by an earlier run of this script and never removed. Fix by hand: delete it (or put the folder's own policy.yaml back), then start again`,
    );
  return true;
};

/** A path resolved through symlinks, also when its last parts do not exist yet. */
const realPath = (p) => {
  let cur = path.resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  return path.join(realpathSync(cur), ...rest);
};

/** E2E_OUT (optional): never inside the repo (it holds the account id). Its full path. */
export const checkOutPath = (out, repoRoots) => {
  if (!out) return undefined;
  const file = realPath(out);
  for (const r of repoRoots) {
    const rel = path.relative(realPath(r), file);
    if (rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)))
      refuse("E2E_OUT must be a file outside the repo");
  }
  return file;
};

/**
 * The run's policy.yaml in the settings folder, and the folder's own state put back exactly
 * after it: no policy.yaml before = none after; one before = the same bytes and mode.
 * Synchronous, so it also runs from process.on("exit"). restore() answers whether the state
 * is exactly back; it can be called again after a failure.
 */
export const createPolicySwap = (dir, stamp, text) => {
  const file = path.join(dir, "policy.yaml");
  const backup = path.join(dir, `${BACKUP_PREFIX}${stamp}`);
  let before;
  let written = false;
  return {
    file,
    get written() {
      return written;
    },
    write() {
      if (written) throw new Error("the run's policy is already written");
      before = existsSync(file)
        ? { bytes: readFileSync(file), mode: statSync(file).mode & 0o777 }
        : null;
      if (before) renameSync(file, backup);
      written = true;
      writeFileSync(file, text, { mode: 0o600, flag: "wx" });
    },
    restore() {
      if (!written) return true;
      rmSync(file, { force: true });
      if (before) {
        if (existsSync(backup)) renameSync(backup, file);
        if (!(existsSync(file) && readFileSync(file).equals(before.bytes)))
          writeFileSync(file, before.bytes, { mode: before.mode });
      }
      const ok = before
        ? existsSync(file) && readFileSync(file).equals(before.bytes) && !existsSync(backup)
        : !existsSync(file);
      if (ok) written = false;
      return ok;
    },
  };
};

/** The run policy's counted limits (the script paces its writes by writes_per_minute). */
export const runLimits = (spendCap = SPEND_CAP_DEFAULT) => ({
  max_new_daily_spend: spendCap,
  writes_per_day: 80,
  writes_per_minute: 10,
  proposals_per_minute: 20,
  proposals_per_day: 200,
  undo_per_day: 50,
});

/** policy.yaml for the run: writes to this one account only, small limits. */
export const runPolicyYaml = (customerId, brandTerms, spendCap = SPEND_CAP_DEFAULT) => {
  const q = JSON.stringify(customerId);
  const l = runLimits(spendCap);
  return [
    `${POLICY_HEADER} for one live run; removed at its end.`,
    "version: 1",
    `accounts: { allow: [${q}], write: [${q}] }`,
    "limits:",
    // $1 -> $2 is a 100% step of $1; turning on a $1 campaign + that raise = $2 a day.
    "  max_budget_change_pct: 100",
    `  max_budget_change_abs: { ${q}: 1 }`,
    `  max_new_daily_spend: { ${q}: ${l.max_new_daily_spend} }`,
    "  max_target_change_pct: 20",
    `  writes_per_day: ${l.writes_per_day}`,
    `  writes_per_minute: ${l.writes_per_minute}`,
    `  proposals_per_minute: ${l.proposals_per_minute}`,
    `  proposals_per_day: ${l.proposals_per_day}`,
    `  undo_per_day: ${l.undo_per_day}`,
    "defaults:",
    "  new_entities_paused: true",
    "  broad_match_requires_smart_bidding: true",
    // The run stops itself before OPS_CAP; clean-up reads must not be refused part way.
    "ops_budget: { reserve_for_writes_pct: 0 }",
    `brand_terms: { ${q}: [${brandTerms.map((t) => JSON.stringify(t)).join(", ")}] }`,
    'tiers: { "*": confirm }',
    "kill_switch: false",
    "",
  ].join("\n");
};
