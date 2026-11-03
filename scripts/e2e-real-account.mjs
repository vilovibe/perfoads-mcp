#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Live change run on ONE REAL (non-test) Google Ads account, through the MCP server itself,
// the same way as scripts/e2e-live-mcp.mjs on a test account: a real MCP client (in-process
// transport) talks to the real server and runtime; every change is propose_change ->
// apply_change (approved on the real local approval page with its CSRF POST, as a click
// sends it) -> read-back -> undo_change -> its own approval -> read-back.
//
// It only touches what it makes itself in this run:
// - campaign A (create_campaign, then its undo after the 15-minute rule and change history);
// - campaign B (its own $1.00/day budget, PAUSED, Google Search only) and every other change
//   type on it, each undone; B is turned on and straight back off while its new ad is
//   still under Google's review (nonsense exact/phrase keywords, $1.00/day);
// - a new shared negative list linked to B; sitelink and callout assets (Google keeps the
//   assets after the undo: their ids are listed at the end).
// The one existing item it uses is a website-visitor user list, read from the account and
// attached to B as an exclusion (then undone). No user list or conversion action is made.
//
// Guards (scripts/e2e-real-account-guards.mjs, all before anything is sent): the env names
// the account and confirms it is live; the account must be that id, non-test, non-manager;
// a policy.yaml for the run only (writes to that id only, brand terms, new entities paused,
// $2/day new spend by default, $1 budget steps, 80 writes a day, 10 a minute); every
// proposal, every undo and every
// approval page is checked to reach only things this run made; the run stops starting new
// steps at 1,300 live operations so clean-up ends under 1,500. Writes are paced under the
// policy's writes_per_minute; one still refused by it is tried again after 65 s (3 times).
//
// Clean-up (also on error, crash and Ctrl-C, which first waits up to 60 s for a running tool
// call): removes campaign B first, then the list and campaign A (each with its own budget),
// after reading each one back; then searches the account for anything of this run still not
// removed (listed as "left in the account", exit 1); then puts the settings folder's policy
// state back exactly (no policy.yaml before = none after; one before = the same bytes). A
// last-resort policy restore also runs on process exit. Refuses to start when an earlier
// run's policy.yaml or policy backup is still in the settings folder.
// Never prints a secret, an account id or the approval page; E2E_OUT holds the details.
//
// Env (all required except E2E_OUT):
//   PERFOADS_MCP_HOME       the settings folder whose sign-in reaches the account
//   E2E_REAL_CUSTOMER_ID    the live account (10 digits, dashes allowed)
//   E2E_REAL_CONFIRM        exactly: I-understand-this-is-a-live-account
//   E2E_REAL_BRAND_TERMS    the account's brand terms, comma-separated
//   E2E_REAL_FINAL_URL      the account's own https home page (ad, sitelink)
//   E2E_OUT                 a JSON file for the full results, outside the repo
//   E2E_REAL_SPEND_CAP      optional: new spend a day the run policy allows, USD 2-5 (default
//                           2); a same-day re-run needs 4, the first run's $2 still counts
// Build first: pnpm build.

import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import {
  approvalAction,
  checkAccount,
  checkAffected,
  checkApprovalPage,
  checkCleanupTarget,
  checkOps,
  checkOutPath,
  checkOwnBudget,
  checkPolicyFolder,
  checkProposal,
  checkStartEnv,
  checkStillPaused,
  checkUndo,
  cleanupOrder,
  createOwned,
  createPolicySwap,
  MAX_BUDGET,
  NAME_PREFIX,
  OPS_CAP,
  OWN_BUDGET,
  paceWaitMs,
  RETRY_WAIT_MS,
  MAX_WRITE_RETRIES,
  retryWrite,
  runLimits,
  runPolicyYaml,
  TEXT_PREFIX,
} from "./e2e-real-account-guards.mjs";

// ---- 0. env guards: nothing is loaded or read before these pass ----
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The repo (and, from a git worktree, the main checkout it belongs to). */
const repoRoots = [root];
try {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (path.basename(common) === ".git") repoRoots.push(path.dirname(common));
} catch {
  // not a git checkout: the script's own repo folder is the one to keep E2E_OUT out of
}
let start;
let outFile;
try {
  start = checkStartEnv(process.env);
  outFile = checkOutPath(process.env.E2E_OUT, repoRoots);
} catch (err) {
  console.error(`e2e-real-account: ${err.message}`);
  process.exit(2);
}
const { customerId, brandTerms, finalUrl, spendCap } = start;
/** The run policy's limits: the writes below are paced by its writes_per_minute. */
const limits = runLimits(spendCap);

const mcpDir = path.join(root, "packages", "mcp-server");
const sdk = (pkg, file) =>
  path.join(mcpDir, "node_modules", "@modelcontextprotocol", pkg, "dist", file);

const { Client, InMemoryTransport } = await import(sdk("client", "index.mjs"));
const { serveStdio } = await import(sdk("server", "stdio.mjs"));
const { createRuntime, createMcpServer } = await import(path.join(mcpDir, "dist", "index.js"));

const stamp = Date.now().toString(36).slice(-6);
const owned = createOwned(stamp);
/** Change ids whose proposal passed checkAffected: the only ones the "browser" approves. */
const vetted = new Set();
const ctx = { owned, finalUrl, customerId, vetted };
const detail = { startedAt: new Date().toISOString(), stamp, steps: [], leftInAccount: [] };
const rows = [];

// ---- the runtime: saved sign-in of PERFOADS_MCP_HOME, no env credentials ----
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^PERFOADS_MCP_(CLIENT|REFRESH)/.test(k)),
);
const pending = [];
const rt = createRuntime({
  env,
  openUrl: (url) => {
    pending.push(approveInBrowser(url).catch((err) => ({ ok: false, why: String(err) })));
    return true;
  },
});
const redact = (text) => {
  let t = String(text ?? "");
  for (const s of rt.secrets()) if (s) t = t.split(s).join("[secret]");
  return t
    .replace(/ya29\.[\w.-]+/g, "[token]")
    .replace(/1\/\/[\w.-]{20,}/g, "[token]")
    .replace(/http:\/\/127\.0\.0\.1:\d+\/a\/[\w-]+/g, "[page]");
};

// ---- the approval page, driven like a browser (copied from e2e-live-mcp.mjs) ----
const pageRequest = (url, o = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: o.method ?? "GET",
        headers: { host: u.host, ...o.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            location: typeof res.headers.location === "string" ? res.headers.location : undefined,
            cookie: res.headers["set-cookie"]?.[0]?.split(";")[0],
          }),
        );
      },
    );
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });

/** GET (one-time 303 + cookie), check the page, POST approve (reject if a check fails or after Ctrl-C). */
async function approveInBrowser(opened) {
  const origin = new URL(opened).origin;
  let r = await pageRequest(opened);
  let url = opened;
  let cookie = "";
  if (r.status === 303 && /^\/a\/[\w-]+$/.test(r.location ?? "")) {
    url = `${origin}${r.location}`;
    cookie = r.cookie ?? "";
    r = await pageRequest(url, { headers: cookie ? { cookie } : {} });
  }
  if (r.status !== 200) return { ok: false, why: `page answered ${r.status}` };
  const csrf = /name="csrf" value="([^"]+)"/.exec(r.body)?.[1];
  if (!csrf || !/value="approve"/.test(r.body))
    return { ok: false, why: "no approve button on the page" };
  const page = checkApprovalPage(r.body, ctx);
  const stopping = stopRequested;
  const post = await pageRequest(url, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams({ csrf, action: approvalAction(page.ok, stopping) }).toString(),
  });
  if (!page.ok) return { ok: false, why: `page rejected: ${page.why}` };
  if (stopping) return { ok: false, why: "page rejected: stopped (Ctrl-C)" };
  return { ok: post.status === 200, why: `POST answered ${post.status}` };
}

// ---- the policy for this run only; the folder's own state is put back exactly ----
try {
  checkPolicyFolder(rt.configDir.dir);
} catch (err) {
  console.error(`e2e-real-account: ${err.message}`);
  rt.close();
  process.exit(2);
}
const policy = createPolicySwap(
  rt.configDir.dir,
  stamp,
  runPolicyYaml(customerId, brandTerms, spendCap),
);
/** True once the run could have made anything (its policy is written first). */
let runStarted = false;
const restorePolicy = () => {
  try {
    return policy.restore();
  } catch (err) {
    console.error(`policy restore failed: ${redact(err?.message ?? err).slice(0, 200)}`);
    return false;
  }
};
// Last resort (crash, process.exit from anywhere): synchronous, so it runs on exit.
process.on("exit", () => {
  if (policy.written && !restorePolicy())
    console.error(
      `POLICY NOT PUT BACK: ${policy.file} is still this run's; fix by hand (see the backup next to it)`,
    );
});
const writePolicy = () => {
  runStarted = true;
  policy.write();
};

// ---- the MCP client ----
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const handle = serveStdio(() => createMcpServer(rt), { transport: serverSide });
const client = new Client(
  { name: "perfoads-e2e-real-account", version: "0.0.0" },
  { capabilities: {} },
);
await client.connect(clientSide);

const textOf = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
/** Tool calls running now (Ctrl-C waits for them before clean-up starts). */
const running = new Set();
const call = async (name, args) => {
  const p = client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const mine = { name, settled: false };
  mine.done = p.then(
    () => (mine.settled = true),
    () => (mine.settled = true),
  );
  running.add(mine);
  let r;
  try {
    r = await p;
  } finally {
    running.delete(mine);
  }
  const out = { ok: !r.isError, sc: r.structuredContent ?? null, text: redact(textOf(r)) };
  detail.steps.push({ tool: name, args, ok: out.ok, text: out.text.slice(0, 4000), sc: out.sc });
  return out;
};
const gaql = async (query) => {
  const r = await call("query_gaql", { customer_id: customerId, query, max_rows: 200 });
  if (!r.ok) throw new Error(`GAQL failed: ${r.text.slice(0, 400)}`);
  return r.sc?.rows ?? [];
};
/** query_gaql wraps Google's text as {"untrusted": "..."}: the plain value. */
const plain = (v) => (v && typeof v === "object" && "untrusted" in v ? v.untrusted : v);

// ---- live operations: counted by the store, for this run ----
let opsAtStart = 0;
const opsUsed = () => rt.opsCounter.used("production");
const opsOfRun = () => opsUsed() - opsAtStart;
let stopRequested = false;
const beforeStep = () => {
  if (stopRequested) throw new Error("stopped (Ctrl-C)");
  checkOps(opsUsed(), opsAtStart);
};

// ---- pacing: the server's writes_per_minute counts the account's changes claimed for
// sending (apply) in the last minute, checked at propose, apply and undo. The run keeps the
// time of its last apply_change per change and waits before each propose_change and
// undo_change until fewer than (limit - 2) are in the last minute. ----
const writes = new Map();
/** A wait that ends early (throws) on Ctrl-C. */
const waitOrStop = async (ms) => {
  const end = Date.now() + ms;
  for (;;) {
    if (stopRequested) throw new Error("stopped (Ctrl-C)");
    const left = end - Date.now();
    if (left <= 0) return;
    await wait(Math.min(1_000, left));
  }
};
/** propose_change / undo_change, paced; a per-minute-limit refusal is tried again (3 times). */
const writeCall = async (name, args) => {
  for (let retries = 0; ; retries++) {
    await waitOrStop(paceWaitMs([...writes.values()], limits.writes_per_minute, Date.now()));
    beforeStep();
    const r = await call(name, args);
    if (!retryWrite(r, retries)) return r;
    detail.writeRetries = (detail.writeRetries ?? 0) + 1;
    console.error(`note: ${name} hit the per-minute write limit; trying again in 65 s`);
    await waitOrStop(RETRY_WAIT_MS);
  }
};

// ---- changes ----
const applyChange = async (changeId) => {
  let applyRetries = 0;
  for (let round = 0; round < 6; round++) {
    // After Ctrl-C nothing more is sent: the change stays unapplied, clean-up takes over.
    if (stopRequested) return { status: "stopped", note: "stopped (Ctrl-C) before apply" };
    writes.set(String(changeId), Date.now());
    const r = await call("apply_change", { change_id: changeId });
    const approvals = await Promise.all(pending.splice(0));
    if (approvals.some((a) => !a.ok))
      return { status: "approval_failed", note: approvals.map((a) => a.why).join("; ") };
    const status = r.sc?.change?.status;
    if (!r.ok) return { status: "error", note: r.text.slice(0, 300) };
    if (r.sc?.refused) {
      // A per-minute refusal at apply sent nothing (the move to applying and the limit check are
      // one step on the server), so asking again later is safe: the change is still approved.
      const msg = String(r.sc.refused.message ?? "");
      if (
        r.sc.refused.code === "policy_refused" &&
        /Try again in a minute/.test(msg) &&
        applyRetries < MAX_WRITE_RETRIES
      ) {
        applyRetries++;
        detail.writeRetries = (detail.writeRetries ?? 0) + 1;
        console.error("note: apply_change hit the per-minute write limit; trying again in 65 s");
        try {
          await waitOrStop(RETRY_WAIT_MS);
        } catch {
          return { status: "stopped", note: "stopped (Ctrl-C) before apply" };
        }
        round--;
        continue;
      }
      return { status: "refused", note: msg };
    }
    if (status && status !== "proposed" && status !== "approved")
      return { status, note: r.sc.change.error?.message ?? "", change: r.sc.change };
  }
  return { status: "still_waiting", note: "no decision after 6 rounds" };
};

/** Checked against the run's guards before propose_change, and its answer after. */
const propose = async (type, params) => {
  beforeStep();
  checkProposal(type, params, ctx);
  const r = await writeCall("propose_change", {
    customer_id: customerId,
    type,
    params,
    reason: "PerfoAds MCP live test on this account, authorised by the owner",
  });
  if (!r.ok) return { error: r.text.slice(0, 400) };
  const change = r.sc.change;
  owned.change.add(String(change.changeId));
  checkAffected(change, ctx);
  vetted.add(String(change.changeId));
  return { id: change.changeId, change };
};

const HISTORY_NOT_READY = /doesn't show this campaign's creation yet|made less than 15 minutes ago/;

/** undo_change of a run change, checked like a proposal; then approved and applied. */
const undo = async (changeId, o = {}) => {
  beforeStep();
  checkUndo(changeId, ctx);
  let u = await writeCall("undo_change", { change_id: changeId });
  if (o.waitForHistory) {
    const started = Date.now();
    while (!u.ok && HISTORY_NOT_READY.test(u.text) && Date.now() - started < 30 * 60_000) {
      await wait(120_000);
      beforeStep();
      u = await writeCall("undo_change", { change_id: changeId });
    }
    o.waited = Math.round((Date.now() - started) / 60_000);
  }
  if (!u.ok) return { status: "propose_failed", note: u.text.slice(0, 300) };
  const change = u.sc.change;
  owned.change.add(String(change.changeId));
  checkAffected(change, ctx);
  vetted.add(String(change.changeId));
  return applyChange(change.changeId);
};

/** propose -> approve -> apply -> verified, then (unless noUndo) undo the same way. */
const lifecycle = async (label, type, params, o = {}) => {
  const p = await propose(type, params);
  if (p.error) {
    rows.push({ step: label, result: "propose_failed", undo: "-", note: p.error });
    return undefined;
  }
  const a = { ...(await applyChange(p.id)), changeId: p.id };
  const row = { step: label, result: a.status, undo: "-", note: a.note ?? "" };
  if (o.after && a.status === "verified") await o.after(a);
  if (!o.noUndo && a.status === "verified") {
    const ua = await undo(p.id);
    row.undo = ua.status;
    if (ua.note) row.note = `${row.note} undo: ${ua.note}`.trim();
  }
  rows.push(row);
  // A stopped step ends the run here: nothing else is proposed or applied.
  if (stopRequested) throw new Error("stopped (Ctrl-C)");
  return a;
};

// ---- reads and direct clean-up writes (never a change type) ----
let loginCustomerId;
const assertLiveAccount = async () => {
  const c = (
    await gaql("SELECT customer.id, customer.test_account, customer.manager FROM customer")
  )[0]?.customer;
  checkAccount(
    c && { id: String(c.id), testAccount: c.testAccount, manager: c.manager },
    customerId,
  );
};
const directWrite = async (operations) => {
  await assertLiveAccount();
  return rt.ads().mutateAll(operations, { customerId, loginCustomerId });
};
const rn = (kind, id) => `customers/${customerId}/${kind}/${id}`;
const lastId = (resourceName) =>
  String(resourceName ?? "")
    .split("/")
    .pop();

const campaignInput = (name, kw) => ({
  name,
  campaign_type: "SEARCH",
  daily_budget: OWN_BUDGET,
  bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
  networks: { google_search: true, search_partners: false, display: false },
  locations: { geo_target_ids: ["2840"], targeting: "PRESENCE" },
  language_ids: ["1000"],
  contains_eu_political_advertising: false,
  ad_groups: [
    {
      name: `${NAME_PREFIX} ${stamp} group`,
      keywords: [
        { text: `${kw} one`, match_type: "EXACT" },
        { text: `${kw} two`, match_type: "PHRASE" },
      ],
      ad: {
        final_url: finalUrl,
        headlines: [
          { text: `${TEXT_PREFIX} one ${stamp}` },
          { text: `${TEXT_PREFIX} two ${stamp}` },
          { text: `${TEXT_PREFIX} three ${stamp}` },
        ],
        descriptions: [
          { text: `${TEXT_PREFIX} ad, not for use. ${stamp}` },
          { text: `${TEXT_PREFIX} ad, paused and removed. ${stamp}` },
        ],
      },
    },
  ],
  negatives: [{ text: `qzccneg${stamp}`, match_type: "EXACT" }],
});

const campaignByName = async (name) =>
  (
    await gaql(
      `SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget FROM campaign WHERE campaign.name = '${name}' AND campaign.status != 'REMOVED'`,
    )
  )[0]?.campaign;

/** Records a new campaign's ids (campaign, own budget, ad groups, keywords, ads) as owned. */
const ownCampaign = async (name) => {
  const c = await campaignByName(name);
  if (!c) return undefined;
  owned.campaign.add(String(c.id));
  owned.campaign_budget.add(lastId(c.campaignBudget));
  const id = String(c.id);
  for (const g of await gaql(
    `SELECT ad_group.id FROM ad_group WHERE campaign.id = ${id} AND ad_group.status != 'REMOVED'`,
  ))
    owned.ad_group.add(String(g.adGroup.id));
  const kws = await gaql(
    `SELECT ad_group.id, ad_group_criterion.criterion_id FROM ad_group_criterion WHERE campaign.id = ${id} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'`,
  );
  for (const k of kws) owned.criterion.add(String(k.adGroupCriterion.criterionId));
  const ads = await gaql(
    `SELECT ad_group_ad.ad.id FROM ad_group_ad WHERE campaign.id = ${id} AND ad_group_ad.status != 'REMOVED'`,
  );
  for (const a of ads) owned.ad.add(String(a.adGroupAd.ad.id));
  return {
    campaignId: id,
    budgetId: lastId(c.campaignBudget),
    adGroupId: String(kws[0]?.adGroup.id ?? ""),
    criterionId: String(kws[0]?.adGroupCriterion.criterionId ?? ""),
    adId: String(ads[0]?.adGroupAd.ad.id ?? ""),
  };
};

/** Removes one run campaign and its own budget, after reading both back. */
const removeCampaign = async (id, name) => {
  const where = id ? `campaign.id = ${id}` : `campaign.name = '${name}'`;
  const c = (
    await gaql(
      `SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget FROM campaign WHERE ${where}`,
    )
  )[0]?.campaign;
  if (!c || plain(c.status) === "REMOVED") return `campaign already gone`;
  checkCleanupTarget("campaign", String(c.id), plain(c.name), owned);
  const ops = [{ campaignOperation: { remove: rn("campaigns", c.id) } }];
  const budgetId = lastId(c.campaignBudget);
  const b = (
    await gaql(
      `SELECT campaign_budget.id, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign_budget WHERE campaign_budget.id = ${budgetId}`,
    )
  )[0]?.campaignBudget;
  // Run campaigns are made with their own budget (never a shared one): used by them alone.
  // A budget kept here is found by the search after clean-up and listed as left.
  let budgetNote = "budget kept (not this run's own)";
  try {
    checkOwnBudget(b);
    ops.push({ campaignBudgetOperation: { remove: rn("campaignBudgets", budgetId) } });
    budgetNote = "with its own budget";
  } catch {
    // kept
  }
  await directWrite(ops);
  return `removed a run campaign ${budgetNote}`;
};

/**
 * Removes a run's shared negative list and, in the same request, its links to run campaigns
 * (whatever their status: B is normally still there, paused). Google refuses removing a
 * list a campaign still links to; a refusal shows up in the leftover search.
 */
const removeList = async (id, name) => {
  const where = id ? `shared_set.id = ${id}` : `shared_set.name = '${name}'`;
  const s = (
    await gaql(
      `SELECT shared_set.id, shared_set.name, shared_set.status FROM shared_set WHERE ${where}`,
    )
  )[0]?.sharedSet;
  if (!s || plain(s.status) === "REMOVED") return "list already gone";
  checkCleanupTarget("shared_set", String(s.id), plain(s.name), owned);
  const links = await gaql(
    `SELECT campaign.id, campaign.name, campaign.status, campaign_shared_set.resource_name FROM campaign_shared_set WHERE shared_set.id = ${s.id} AND campaign_shared_set.status = 'ENABLED'`,
  );
  const ofRun = (l) =>
    owned.campaign.has(String(l.campaign.id)) || owned.names.has(plain(l.campaign.name));
  const runLinks = links.filter(ofRun);
  const foreign = links.filter((l) => !ofRun(l) && plain(l.campaign.status) !== "REMOVED");
  // A kept list is found by the search after clean-up and listed as left.
  if (foreign.length) return "list kept: a campaign not made by this run uses it";
  await directWrite([
    ...runLinks.map((l) => ({
      campaignSharedSetOperation: { remove: plain(l.campaignSharedSet.resourceName) },
    })),
    { sharedSetOperation: { remove: rn("sharedSets", s.id) } },
  ]);
  return "removed a run list";
};

const nameA = `${NAME_PREFIX} ${stamp} A`;
const nameB = `${NAME_PREFIX} ${stamp} B`;
const listName = `${NAME_PREFIX} ${stamp} list`;
/** The sitelink's link text and the callout's text (clean-up finds the assets by it). */
const assetText = `${TEXT_PREFIX} ${stamp}`;
owned.names.add(nameA).add(nameB).add(listName);

// ---- the report (finish() prints it once, at the very end) ----
const cols = ["step", "result", "undo", "note"];
const width = { step: 40, result: 24, undo: 14, note: 120 };
/** The terminal never shows the account id (E2E_OUT, outside the repo, does). */
const hideId = (t) =>
  t
    .split(customerId)
    .join("[account]")
    .split(`${customerId.slice(0, 3)}-${customerId.slice(3, 6)}-${customerId.slice(6)}`)
    .join("[account]");
const line = (r) =>
  cols
    .map((c) =>
      hideId(String(r[c] ?? ""))
        .replace(/\s+/g, " ")
        .slice(0, width[c])
        .padEnd(width[c]),
    )
    .join(" | ");
const badRows = () =>
  rows.filter(
    (r) =>
      !/^(ok|verified|skipped|refused \(expected\))$/.test(r.result) ||
      !/^(-|verified)$/.test(r.undo),
  );
/** The results table, the loud lines, and E2E_OUT. Called once, by finish(). */
const report = () => {
  console.log(line({ step: "step", result: "result", undo: "undo", note: "note" }));
  for (const r of rows) console.log(line(r));
  // Read in finish() before the store closes; reading here after close crashed the report.
  detail.liveOpsOfRun ??= null;
  console.log(
    `live operations used by this run: ${detail.liveOpsOfRun ?? "?"} (stop at ${OPS_CAP})`,
  );
  console.log(`clean-up: ${hideId(JSON.stringify(detail.cleanup ?? []))}`);
  const list = (xs) => xs.map((x) => `${x.kind} ${x.id}${x.status ? ` (${x.status})` : ""}`);
  const mustGo = detail.mustGo ?? [];
  const assets = (detail.leftInAccount ?? []).filter((x) => !mustGo.includes(x));
  console.log(
    `left in the account (assets Google keeps): ${assets.length ? list(assets).join(", ") : "nothing"}`,
  );
  if (mustGo.length)
    console.log(
      `LEFT IN THE ACCOUNT, CLEAN-UP MISSED IT - remove by hand now: ${list(mustGo).join(", ")}`,
    );
  if (detail.leftoverSearch)
    console.log(
      `COULD NOT CHECK what is left in the account (${hideId(detail.leftoverSearch)}): search it for campaigns and lists named "${NAME_PREFIX} ${stamp}" and remove them by hand`,
    );
  if (detail.stillRunning)
    console.log(
      `A STEP WAS STILL RUNNING at clean-up (${detail.stillRunning.join(", ")}): search the account for "${NAME_PREFIX} ${stamp}" and remove what it made by hand`,
    );
  console.log(
    detail.policyRestored
      ? "policy state restored exactly: true"
      : `POLICY NOT PUT BACK: ${policy.file} is still this run's; fix by hand (see the backup next to it)`,
  );
  detail.rows = rows;
  if (outFile) {
    try {
      writeFileSync(outFile, redact(JSON.stringify(detail, null, 2)), { mode: 0o600 });
    } catch (err) {
      console.error(`E2E_OUT not written: ${redact(err?.message ?? err).slice(0, 200)}`);
    }
  }
};

/** Ids of campaigns A and B once read back (clean-up finds them by name before that). */
const campaignIds = {};
let cleaning;
const cleanUp = () =>
  (cleaning ??= (async () => {
    const out = [];
    const step = async (fn) => {
      try {
        out.push(await fn());
      } catch (err) {
        out.push(`failed: ${redact(err?.message ?? err).slice(0, 200)}`);
      }
    };
    if (!runStarted) return out;
    // B is the one campaign the run turns on: if it is not read back PAUSED it goes first.
    // Otherwise the list (and its link to B) goes first, while B still exists.
    let bStatus;
    try {
      const where = campaignIds.B ? `campaign.id = ${campaignIds.B}` : `campaign.name = '${nameB}'`;
      const c = (await gaql(`SELECT campaign.status FROM campaign WHERE ${where}`))[0]?.campaign;
      bStatus = c ? plain(c.status) : "PAUSED"; // no B: the order does not matter
    } catch (err) {
      out.push(`B status not read: ${redact(err?.message ?? err).slice(0, 200)}`);
    }
    const remove = {
      B: () => removeCampaign(campaignIds.B, nameB),
      list: () => removeList([...owned.shared_set][0], listName),
      A: () => removeCampaign(campaignIds.A, nameA),
    };
    for (const what of cleanupOrder(bStatus)) await step(remove[what]);
    return out;
  })());

/**
 * After clean-up: everything of this run (its name prefix + run code, or a budget id it
 * read) that is still not REMOVED. mustGo = clean-up missed it; assets = the sitelink and
 * callout Google keeps (found by their run text, whether or not their step verified).
 */
const runLike = `${NAME_PREFIX} ${stamp}%`;
const findLeftovers = async () => {
  const mustGo = [];
  const assets = [];
  const live = (st) => plain(st) !== "REMOVED";
  const budgetIds = new Set([...owned.campaign_budget].filter((id) => /^\d+$/.test(id)));
  for (const r of await gaql(
    `SELECT campaign.id, campaign.status, campaign_budget.id FROM campaign WHERE campaign.name LIKE '${runLike}'`,
  )) {
    if (live(r.campaign.status))
      mustGo.push({
        kind: "campaign",
        id: String(r.campaign.id),
        status: plain(r.campaign.status),
      });
    if (r.campaignBudget?.id != null) budgetIds.add(String(r.campaignBudget.id));
  }
  if (budgetIds.size)
    for (const r of await gaql(
      `SELECT campaign_budget.id, campaign_budget.status FROM campaign_budget WHERE campaign_budget.id IN (${[...budgetIds].join(", ")})`,
    ))
      if (live(r.campaignBudget.status))
        mustGo.push({ kind: "campaign_budget", id: String(r.campaignBudget.id) });
  for (const r of await gaql(
    `SELECT shared_set.id, shared_set.status FROM shared_set WHERE shared_set.name LIKE '${runLike}'`,
  ))
    if (live(r.sharedSet.status)) mustGo.push({ kind: "shared_set", id: String(r.sharedSet.id) });
  for (const [kind, field] of [
    ["SITELINK", "sitelink_asset.link_text"],
    ["CALLOUT", "callout_asset.callout_text"],
  ])
    for (const r of await gaql(
      `SELECT asset.id FROM asset WHERE asset.type = '${kind}' AND asset.${field} = '${assetText}'`,
    ))
      assets.push({ kind: `${kind.toLowerCase()} asset`, id: String(r.asset.id) });
  return { mustGo, assets };
};

/**
 * The one way the run ends (done, error, crash or Ctrl-C; one run of it, whoever asks
 * first): clean-up, the search for leftovers, the policy put back, the report, exit.
 * busy = the tool calls that were running when a stop or crash came: any still running
 * after clean-up may make something clean-up could not see.
 */
let finishing;
const finish = (code, busy = []) =>
  (finishing ??= (async () => {
    let exit = code;
    try {
      detail.cleanup = await cleanUp();
      const still = busy.filter((c) => !c.settled);
      if (still.length) {
        detail.stillRunning = still.map((c) => c.name);
        exit ||= 1;
      }
      if (runStarted) {
        try {
          const left = await findLeftovers();
          detail.leftInAccount = [...left.mustGo, ...left.assets];
          detail.mustGo = left.mustGo;
          if (left.mustGo.length) exit ||= 1;
        } catch (err) {
          detail.leftoverSearch = `failed: ${redact(err?.message ?? err).slice(0, 300)}`;
          exit ||= 1;
        }
      }
    } catch (err) {
      detail.finishError = redact(err?.message ?? err).slice(0, 300);
      exit ||= 1;
    }
    detail.policyRestored = restorePolicy();
    if (!detail.policyRestored) exit ||= 1;
    try {
      detail.liveOpsOfRun = opsAtStart ? opsOfRun() : null;
    } catch {
      detail.liveOpsOfRun = null;
    }
    await client.close().catch(() => {});
    await handle.close().catch(() => {});
    try {
      rt.close();
    } catch {
      // closing only
    }
    try {
      report();
    } catch (err) {
      console.error(`report failed: ${redact(err?.message ?? err).slice(0, 300)}`);
      exit ||= 1;
    }
    process.exit(exit || (badRows().length ? 1 : 0));
  })());

let interrupted = 0;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    interrupted++;
    stopRequested = true;
    if (interrupted === 2) {
      console.error(
        "clean-up is running; Ctrl-C once more quits now (the policy is still put back, but run items may stay)",
      );
      return;
    }
    if (interrupted > 2) {
      const ok = restorePolicy();
      console.error(
        `quit before clean-up ended: search the account for campaigns and lists named "${NAME_PREFIX} ${stamp}" and remove them by hand${ok ? "" : `; POLICY NOT PUT BACK: ${policy.file}`}`,
      );
      process.exit(130);
    }
    console.error("stopping: waiting up to 60 s for the running step, then cleaning up");
    const busy = [...running];
    Promise.race([Promise.all(busy.map((c) => c.done)), wait(60_000)]).then(() =>
      finish(130, busy),
    );
  });
}
const crashed = (kind) => (err) => {
  stopRequested = true;
  console.error(`${kind}: ${redact(err?.stack ?? err).slice(0, 600)}`);
  rows.push({ step: kind, result: "error", undo: "-", note: redact(err?.message ?? err) });
  finish(1, [...running]);
};
process.on("uncaughtException", crashed("uncaught exception"));
process.on("unhandledRejection", crashed("unhandled rejection"));

let exitCode = 0;
try {
  // 1. The account, from the sign-in (no policy file of ours yet).
  const all = (await rt.accounts({ refresh: true })).accounts;
  const target = all.find((a) => a.customerId === customerId);
  checkAccount(target, customerId);
  loginCustomerId = target.loginCustomerId;
  detail.account = { level: target.level, currency: target.currencyCode };
  opsAtStart = opsUsed();
  const limit = rt.opsLimits?.production;
  if (typeof limit === "number" && limit - opsAtStart < OPS_CAP + 100)
    throw new Error(`only ${limit - opsAtStart} live operations left today; need ${OPS_CAP + 100}`);
  rows.push({ step: "account", result: "ok", undo: "-", note: "live, not a manager" });

  writePolicy();
  await assertLiveAccount();

  // 2. Read-only: earlier run campaigns left behind (reported, never touched).
  const earlier = await gaql(
    `SELECT campaign.id, campaign.status FROM campaign WHERE campaign.name LIKE '${NAME_PREFIX}%' AND campaign.status != 'REMOVED'`,
  );
  detail.earlierRunCampaigns = earlier.map((r) => ({
    id: String(r.campaign.id),
    status: plain(r.campaign.status),
  }));
  if (earlier.length)
    console.error(`note: ${earlier.length} campaign(s) of an earlier run are in the account`);

  // 3. Read-only pick: a website-visitor list Search can use (no Customer Match list).
  const lists = await gaql(
    "SELECT user_list.id, user_list.type, user_list.membership_status, user_list.eligible_for_search, user_list.read_only FROM user_list WHERE user_list.type IN ('RULE_BASED', 'REMARKETING', 'LOGICAL')",
  );
  const rank = { RULE_BASED: 0, REMARKETING: 1, LOGICAL: 2 };
  const usable = lists
    .map((r) => r.userList)
    .filter(
      (u) => plain(u.membershipStatus) === "OPEN" && u.eligibleForSearch === true && u.id != null,
    )
    .sort(
      (a, b) =>
        rank[plain(a.type)] - rank[plain(b.type)] ||
        (BigInt(String(a.id)) < BigInt(String(b.id)) ? -1 : 1),
    );
  owned.userListId = usable[0] ? String(usable[0].id) : undefined;
  detail.userList = usable[0] ? { id: String(usable[0].id), type: plain(usable[0].type) } : null;

  // 4. Campaign A: made now, undone at the end (its undo waits for 15 minutes + history).
  const a = await lifecycle(
    "create_campaign (A)",
    "create_campaign",
    campaignInput(nameA, `qza${stamp}`),
    { noUndo: true },
  );
  if (a?.status === "verified") campaignIds.A = (await ownCampaign(nameA))?.campaignId;

  // 5. Campaign B, then every other type on it.
  const b = await lifecycle(
    "create_campaign (B)",
    "create_campaign",
    campaignInput(nameB, `qzb${stamp}`),
    { noUndo: true },
  );
  const B = b?.status === "verified" ? await ownCampaign(nameB) : undefined;
  if (!B?.adGroupId || !B.adId) throw new Error("campaign B was not made; the other types need it");
  campaignIds.B = B.campaignId;

  // On and straight off again, while B's new ad is still in Google's review. Whatever the
  // step ends with (verified, in doubt, error, a failed undo), B must read back PAUSED;
  // otherwise the run stops here and clean-up removes B first.
  let enableError;
  try {
    await lifecycle("update_campaign_status (enable, undo)", "update_campaign_status", {
      campaign_id: B.campaignId,
      status: "ENABLED",
    });
  } catch (err) {
    enableError = err;
  }
  const bStatus = plain(
    (await gaql(`SELECT campaign.status FROM campaign WHERE campaign.id = ${B.campaignId}`))[0]
      ?.campaign?.status,
  );
  detail.campaignBStatusAfterOnOff = bStatus;
  checkStillPaused(bStatus, "campaign B");
  if (enableError) throw enableError;
  await lifecycle("update_budget", "update_budget", {
    budget_id: B.budgetId,
    daily_amount: MAX_BUDGET,
  });
  await lifecycle("update_bidding", "update_bidding", {
    campaign_id: B.campaignId,
    target_cpa: "5.00",
  });
  await lifecycle("add_campaign_negatives", "add_campaign_negatives", {
    campaign_ids: [B.campaignId],
    negatives: [{ text: `qzneg${stamp}`, match_type: "EXACT" }],
  });
  await lifecycle("remove_campaign_negatives", "remove_campaign_negatives", {
    campaign_id: B.campaignId,
    negatives: [{ text: `qzccneg${stamp}`, match_type: "EXACT" }],
  });
  await lifecycle(
    "add_shared_negatives",
    "add_shared_negatives",
    {
      new_list_name: listName,
      negatives: [{ text: `qzlist${stamp}`, match_type: "PHRASE" }],
      link_campaign_ids: [B.campaignId],
    },
    {
      after: async () => {
        const s = (
          await gaql(
            `SELECT shared_set.id FROM shared_set WHERE shared_set.name = '${listName}' AND shared_set.status = 'ENABLED'`,
          )
        )[0]?.sharedSet;
        if (s) owned.shared_set.add(String(s.id));
      },
    },
  );
  await lifecycle("add_keywords", "add_keywords", {
    ad_group_id: B.adGroupId,
    keywords: [{ text: `qzkw${stamp}`, match_type: "EXACT" }],
  });
  await lifecycle("pause_keyword", "pause_keyword", {
    keywords: [{ ad_group_id: B.adGroupId, criterion_id: B.criterionId }],
  });
  await lifecycle("update_rsa_text", "update_rsa_text", {
    ad_group_id: B.adGroupId,
    ad_id: B.adId,
    headlines: [
      { text: `${TEXT_PREFIX} new 1 ${stamp}` },
      { text: `${TEXT_PREFIX} new 2 ${stamp}` },
      { text: `${TEXT_PREFIX} new 3 ${stamp}` },
    ],
    path1: "test",
  });
  // Their assets stay in the account after the undo: the search after clean-up lists them.
  await lifecycle("add_sitelinks", "add_sitelinks", {
    campaign_id: B.campaignId,
    sitelinks: [
      {
        link_text: assetText,
        final_url: finalUrl,
        description1: `${TEXT_PREFIX} line one`,
        description2: `${TEXT_PREFIX} line two`,
      },
    ],
  });
  await lifecycle("add_callouts", "add_callouts", {
    campaign_id: B.campaignId,
    callouts: [{ text: assetText }],
  });
  if (owned.userListId) {
    await lifecycle("add_audience_exclusions", "add_audience_exclusions", {
      campaign_id: B.campaignId,
      user_list_ids: [owned.userListId],
    });
  } else {
    rows.push({
      step: "add_audience_exclusions",
      result: "skipped",
      undo: "-",
      note: "no open website-visitor list usable on Search in the account",
    });
  }

  // 6. Undo of B after changes: must be refused (changed after it was made).
  if (b?.changeId) {
    beforeStep();
    checkUndo(b.changeId, ctx);
    const u = await writeCall("undo_change", { change_id: b.changeId });
    if (u.ok) {
      owned.change.add(String(u.sc.change.changeId));
      checkAffected(u.sc.change, ctx);
    }
    rows.push({
      step: "undo create_campaign (B, after changes)",
      result: u.ok ? "PROPOSED (unexpected)" : "refused (expected)",
      undo: "-",
      note: u.text.slice(0, 250),
    });
  }

  // 7. Undo of A: offered 15 minutes after it was made, once Google's history shows it.
  if (a?.status === "verified") {
    const o = { waitForHistory: true };
    const ua = await undo(a.changeId, o);
    detail.undoWaitMinutes = o.waited;
    rows.push({
      step: "create_campaign (A, undo)",
      result: "verified",
      undo: ua.status,
      note: `${ua.note ?? ""} undo waited ${o.waited ?? 0} min for Google's change history`.trim(),
    });
  }
} catch (err) {
  exitCode = 1;
  rows.push({
    step: "run stopped",
    result: "error",
    undo: "-",
    note: redact(err?.message ?? err).slice(0, 400),
  });
}
// The same end as a Ctrl-C or a crash starts (one run of it, whoever asks first).
await finish(exitCode);
