#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Live end-to-end run through the MCP server itself, on a Google Ads TEST account, with the
// sign-in saved on this machine (`perfoads-mcp auth`). docs/E2E-COVERAGE.md, "Running the
// live test".
//
// It is a real MCP client (in-process transport) talking to the real server and runtime:
// list_accounts, build_snapshot, run_checks, then create_campaign and every change type on
// that campaign, each: propose_change -> apply_change -> verified -> undo_change ->
// apply_change -> verified. The client declares no forms, so apply_change opens the local
// approval page; this script acts as the browser: it GETs the page over 127.0.0.1 (following
// the one-time redirect with its cookie) and POSTs "approve" with the page's CSRF token,
// exactly what a person's click sends. No code path is skipped and none is added.
//
// Safety:
// - Writes go only to an account whose customer.test_account is true (the server refuses
//   others; this script also refuses to start on one, and checks again before each of its
//   own clean-up writes).
// - For the run it writes policy.yaml in the settings folder allowing ONLY the test account
//   (a policy.yaml already there is moved aside first and put back at the end, also on
//   Ctrl-C). The real accounts are never in it, so the server can't read or write them.
// - Never prints a secret: tool text is redacted with the runtime's known secrets, the
//   approval page (its code, token and URL) is never printed.
// - Ids of the accounts are not printed to the terminal; the detail file (E2E_OUT) holds
//   the test account's ids and must not be committed.
//
// Env:
//   E2E_CUSTOMER_ID   optional: the test client account (default: the only test client found)
//   E2E_OUT           optional: a JSON file for the full results (default: none)
//   E2E_SKIP          optional: comma-separated step names to skip
// Build first: pnpm build.

import { request } from "node:http";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, URL, URLSearchParams } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpDir = path.join(root, "packages", "mcp-server");
const sdk = (pkg, file) =>
  path.join(mcpDir, "node_modules", "@modelcontextprotocol", pkg, "dist", file);

const { Client, InMemoryTransport } = await import(sdk("client", "index.mjs"));
const { serveStdio } = await import(sdk("server", "stdio.mjs"));
const { createRuntime, createMcpServer } = await import(path.join(mcpDir, "dist", "index.js"));

const skip = new Set(
  (process.env.E2E_SKIP ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const stamp = Date.now().toString(36).slice(-5);
const detail = { startedAt: new Date().toISOString(), steps: [] };
const rows = [];

// ---- the runtime: saved sign-in, test access level, no env credentials ----
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^PERFOADS_MCP_(CLIENT|REFRESH)/.test(k)),
  ),
  PERFOADS_MCP_ACCESS_LEVEL: "test",
};

/** Approval pages the server asked to open; each is approved like a browser click. */
const pending = [];
const rt = createRuntime({
  env,
  openUrl: (url) => {
    pending.push(approveInBrowser(url));
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

// ---- the approval page, driven like a browser ----
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

/** GET (one-time 303 to a fresh path + cookie), read the CSRF token, POST approve. */
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
  const hasApprove = /value="approve"/.test(r.body);
  const testBadge = /test account/i.test(r.body);
  if (!csrf || !hasApprove) return { ok: false, why: "no approve button on the page" };
  const post = await pageRequest(url, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams({ csrf, action: "approve" }).toString(),
  });
  return { ok: post.status === 200, why: `POST answered ${post.status}`, testBadge };
}

// ---- the policy for this run only ----
const policyFile = path.join(rt.configDir.dir, "policy.yaml");
const backup = `${policyFile}.e2e-backup-${stamp}`;
let policyWritten = false;
const restorePolicy = () => {
  if (!policyWritten) return;
  rmSync(policyFile, { force: true });
  if (existsSync(backup)) renameSync(backup, policyFile);
  policyWritten = false;
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    restorePolicy();
    process.exit(130);
  });
}
const writePolicy = (id) => {
  if (existsSync(policyFile)) renameSync(policyFile, backup);
  const q = JSON.stringify(id);
  writeFileSync(
    policyFile,
    [
      "# Written by scripts/e2e-live-mcp.mjs for one test run; removed at its end.",
      "version: 1",
      `accounts: { allow: [${q}], write: [${q}] }`,
      "limits:",
      "  max_budget_change_pct: 100",
      "  max_target_change_pct: 100",
      `  max_new_daily_spend: { ${q}: 100 }`,
      "  writes_per_day: 500",
      "  writes_per_minute: 60",
      "  proposals_per_minute: 60",
      "  proposals_per_day: 1000",
      "  undo_per_day: 500",
      "# Reads may use the whole daily allowance here, so clean-up reads are never refused.",
      "ops_budget: { reserve_for_writes_pct: 0 }",
      `brand_terms: { ${q}: ["perfoadsbrandzq"] }`,
      "kill_switch: false",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  policyWritten = true;
};

// ---- the MCP client ----
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const handle = serveStdio(() => createMcpServer(rt), { transport: serverSide });
const client = new Client({ name: "perfoads-e2e-live", version: "0.0.0" }, { capabilities: {} });
await client.connect(clientSide);

const textOf = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const out = { ok: !r.isError, sc: r.structuredContent ?? null, text: redact(textOf(r)) };
  detail.steps.push({ tool: name, args, ok: out.ok, text: out.text.slice(0, 4000), sc: out.sc });
  return out;
};

let customerId;
const gaql = async (query) => {
  const r = await call("query_gaql", { customer_id: customerId, query, max_rows: 200 });
  if (!r.ok) throw new Error(`GAQL failed: ${r.text.slice(0, 400)}`);
  return r.sc?.rows ?? [];
};

/** query_gaql wraps Google's text as {"untrusted": "..."}: the plain value. */
const plain = (v) => (v && typeof v === "object" && "untrusted" in v ? v.untrusted : v);

/** apply_change until the change is final (the page is approved as it opens). */
const applyChange = async (changeId) => {
  for (let round = 0; round < 6; round++) {
    const r = await call("apply_change", { change_id: changeId });
    const pages = pending.splice(0);
    const approvals = await Promise.all(pages);
    if (approvals.some((a) => !a.ok)) {
      return { status: "approval_failed", note: approvals.map((a) => a.why).join("; ") };
    }
    const status = r.sc?.change?.status;
    if (!r.ok) return { status: "error", note: r.text.slice(0, 300) };
    if (r.sc?.refused) return { status: "refused", note: r.sc.refused.message };
    if (status && status !== "proposed" && status !== "approved") {
      return {
        status,
        note: r.sc.change.error?.message ?? "",
        change: r.sc.change,
        testBadge: approvals.every((a) => a.testBadge),
      };
    }
  }
  return { status: "still_waiting", note: "no decision after 6 rounds" };
};

const propose = async (type, params) => {
  const r = await call("propose_change", {
    customer_id: customerId,
    type,
    params,
    reason: "PerfoAds MCP live e2e test",
  });
  if (!r.ok) return { error: r.text.slice(0, 400) };
  return { id: r.sc.change.changeId, change: r.sc.change };
};

/**
 * create_campaign's undo is refused until Google's change history shows the campaign's
 * creation (it lags; 15 minutes at least): the refusal says to try again.
 */
const HISTORY_NOT_READY = /doesn't show this campaign's creation yet|made less than 15 minutes ago/;

/** propose -> approve -> apply -> verified, then undo the same way. */
const lifecycle = async (label, type, params, o = {}) => {
  if (skip.has(label))
    return rows.push({ step: label, result: "skipped", undo: "-", note: "E2E_SKIP" });
  const p = await propose(type, params);
  if (p.error)
    return rows.push({ step: label, result: "propose_failed", undo: "-", note: p.error });
  const a = { ...(await applyChange(p.id)), changeId: p.id };
  const row = { step: label, result: a.status, undo: "-", note: a.note ?? "" };
  if (o.after) await o.after(a);
  if (o.noUndo || a.status !== "verified") return (rows.push(row), a);
  let u = await call("undo_change", { change_id: p.id });
  if (o.waitForHistory) {
    // Polls every 2 minutes, up to 30, while the undo waits for Google's change history.
    const started = Date.now();
    while (!u.ok && HISTORY_NOT_READY.test(u.text) && Date.now() - started < 30 * 60_000) {
      await wait(120_000);
      u = await call("undo_change", { change_id: p.id });
    }
    const waited = Math.round((Date.now() - started) / 60_000);
    detail.undoWaits = { ...(detail.undoWaits ?? {}), [label]: waited };
    row.note = `${row.note} undo waited ${waited} min for Google's change history`.trim();
  }
  if (!u.ok) {
    row.undo = "propose_failed";
    row.note = `${row.note} undo: ${u.text.slice(0, 300)}`.trim();
  } else {
    const ua = await applyChange(u.sc.change.changeId);
    row.undo = ua.status;
    if (ua.note) row.note = `${row.note} undo: ${ua.note}`.trim();
  }
  rows.push(row);
  return a;
};

// ---- direct test-account writes (set-up and clean-up only, never a change type) ----
const assertTestAccount = async () => {
  const c = (
    await gaql("SELECT customer.id, customer.test_account, customer.manager FROM customer")
  )[0]?.customer;
  if (c?.testAccount !== true || c?.manager === true) throw new Error("not a test client account");
};
let loginCustomerId;
const directWrite = async (operations) => {
  await assertTestAccount();
  return rt.ads().mutateAll(operations, { customerId, loginCustomerId });
};
const rn = (kind, id) => `customers/${customerId}/${kind}/${id}`;

const campaignInput = (name, kw) => ({
  name,
  campaign_type: "SEARCH",
  daily_budget: "10.00",
  bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
  networks: { google_search: true, search_partners: false, display: false },
  locations: { geo_target_ids: ["2840"], targeting: "PRESENCE" },
  language_ids: ["1000"],
  contains_eu_political_advertising: false,
  ad_groups: [
    {
      name: `E2E group ${stamp}`,
      keywords: [
        { text: `${kw} one`, match_type: "EXACT" },
        { text: `${kw} two`, match_type: "PHRASE" },
      ],
      ad: {
        final_url: "https://www.example.com/e2e",
        headlines: [
          { text: `E2E one ${stamp}` },
          { text: `E2E two ${stamp}` },
          { text: `E2E three ${stamp}` },
        ],
        descriptions: [
          { text: `E2E description one ${stamp}.` },
          { text: `E2E description two ${stamp}.` },
        ],
      },
    },
  ],
  negatives: [{ text: `qzccneg${stamp}`, match_type: "EXACT" }],
});

const findCampaign = async (name) =>
  (
    await gaql(
      `SELECT campaign.id, campaign.status, campaign.campaign_budget FROM campaign WHERE campaign.name = '${name}' AND campaign.status != 'REMOVED'`,
    )
  )[0]?.campaign;

const removeCampaignDirect = async (name) => {
  const c = await findCampaign(name);
  if (!c) return "already gone";
  const ops = [{ campaignOperation: { remove: rn("campaigns", c.id) } }];
  if (c.campaignBudget) ops.push({ campaignBudgetOperation: { remove: c.campaignBudget } });
  await directWrite(ops);
  return `removed ${name.split(" ").slice(0, 3).join(" ")}`;
};

/** Lists and audience lists named "PerfoAds e2e ..." left by an earlier, stopped run. */
const sweepLeftovers = async () => {
  const ops = [];
  const sets = await gaql(
    "SELECT shared_set.id FROM shared_set WHERE shared_set.name LIKE 'PerfoAds e2e%' AND shared_set.status = 'ENABLED'",
  );
  for (const s of sets) {
    const links = await gaql(
      `SELECT campaign.id, campaign_shared_set.resource_name FROM campaign_shared_set WHERE shared_set.id = ${s.sharedSet.id} AND campaign_shared_set.status = 'ENABLED'`,
    );
    for (const l of links)
      ops.push({ campaignSharedSetOperation: { remove: l.campaignSharedSet.resourceName } });
    ops.push({ sharedSetOperation: { remove: rn("sharedSets", s.sharedSet.id) } });
  }
  const lists = await gaql(
    "SELECT user_list.id FROM user_list WHERE user_list.name LIKE 'PerfoAds e2e%'",
  );
  for (const u of lists)
    ops.push({ userListOperation: { remove: rn("userLists", u.userList.id) } });
  if (ops.length) await directWrite(ops);
  return `swept ${sets.length} list(s), ${lists.length} audience list(s)`;
};

const cleanup = [];
let exitCode = 0;
try {
  // 1. Accounts (read-only: no policy file yet unless one was there).
  const la = await call("list_accounts", { refresh: true });
  const all = (await rt.accounts()).accounts;
  const tests = all.filter((a) => a.isTestAccount && !a.isManager);
  const want = process.env.E2E_CUSTOMER_ID?.replace(/-/g, "");
  const target = want
    ? tests.find((a) => a.customerId === want)
    : tests.length === 1
      ? tests[0]
      : undefined;
  rows.push({
    step: "list_accounts",
    result: la.ok ? "ok" : "error",
    undo: "-",
    note: `${all.length} accounts, ${all.filter((a) => a.isTestAccount).length} test, ${tests.length} test client(s)`,
  });
  if (!target) throw new Error("no single test client account found (set E2E_CUSTOMER_ID)");
  customerId = target.customerId;
  loginCustomerId = target.loginCustomerId;
  detail.account = { level: target.level, currency: target.currencyCode };

  writePolicy(customerId);
  await assertTestAccount();

  // Maximize conversions (and target CPA) need conversion tracking: a new test account has
  // none, so one conversion action is made once and kept for later runs.
  const conv = await gaql(
    "SELECT conversion_action.id FROM conversion_action WHERE conversion_action.status = 'ENABLED' LIMIT 1",
  );
  if (!conv.length) {
    await directWrite([
      {
        conversionActionOperation: {
          create: {
            name: "PerfoAds e2e conversion",
            type: "WEBPAGE",
            category: "PURCHASE",
            status: "ENABLED",
          },
        },
      },
    ]);
    detail.conversionActionMade = true;
  }

  detail.sweptAtStart = await sweepLeftovers();
  cleanup.push(sweepLeftovers);

  // 2. Snapshot + checks.
  if (!skip.has("snapshot")) {
    const snap = await call("build_snapshot", { customer_id: customerId, refresh: true });
    rows.push({
      step: "build_snapshot",
      result: snap.ok ? "ok" : "error",
      undo: "-",
      note: snap.text.slice(0, 200),
    });
    const snapId = snap.sc?.snapshotId ?? snap.sc?.snapshot_id;
    const checks = await call(
      "run_checks",
      snapId ? { snapshot_id: snapId } : { customer_id: customerId },
    );
    rows.push({
      step: "run_checks",
      result: checks.ok ? "ok" : "error",
      undo: "-",
      note: checks.text.slice(0, 200),
    });
  }

  // 3. create_campaign A: create, then undo (removes it and its own budget).
  const nameA = `PerfoAds e2e A ${stamp}`;
  cleanup.push(() => removeCampaignDirect(nameA));
  await lifecycle(
    "create_campaign (A, then undo)",
    "create_campaign",
    campaignInput(nameA, `qza${stamp}`),
    { waitForHistory: true },
  );
  const afterA = await gaql(
    `SELECT campaign.id, campaign.status FROM campaign WHERE campaign.name = '${nameA}'`,
  );
  detail.campaignAAfterUndo = afterA.map((r) => r.campaign?.status);

  // 4. Campaign B for every other change type.
  const nameB = `PerfoAds e2e B ${stamp}`;
  cleanup.push(() => removeCampaignDirect(nameB));
  const b = await lifecycle(
    "create_campaign (B)",
    "create_campaign",
    campaignInput(nameB, `qzb${stamp}`),
    {
      noUndo: true,
    },
  );
  if (b?.status !== "verified") throw new Error("campaign B was not made; the other types need it");
  const cB = await findCampaign(nameB);
  const campaignId = String(cB.id);
  const budgetId = cB.campaignBudget.split("/").pop();
  const kws = await gaql(
    `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.status FROM ad_group_criterion WHERE campaign.id = ${campaignId} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'`,
  );
  const adGroupId = String(kws[0].adGroup.id);
  const ad = (
    await gaql(
      `SELECT ad_group_ad.ad.id FROM ad_group_ad WHERE campaign.id = ${campaignId} AND ad_group_ad.status != 'REMOVED'`,
    )
  )[0];

  await lifecycle("update_budget", "update_budget", { budget_id: budgetId, daily_amount: "12.00" });
  await lifecycle("update_campaign_status (enable)", "update_campaign_status", {
    campaign_id: campaignId,
    status: "ENABLED",
  });
  await lifecycle("update_bidding", "update_bidding", {
    campaign_id: campaignId,
    target_cpa: "5.00",
  });
  await lifecycle("add_campaign_negatives", "add_campaign_negatives", {
    campaign_ids: [campaignId],
    negatives: [{ text: `qzneg${stamp}`, match_type: "EXACT" }],
  });
  await lifecycle("remove_campaign_negatives", "remove_campaign_negatives", {
    campaign_id: campaignId,
    negatives: [{ text: `qzccneg${stamp}`, match_type: "EXACT" }],
  });
  await lifecycle("add_shared_negatives", "add_shared_negatives", {
    new_list_name: `PerfoAds e2e ${stamp}`,
    negatives: [{ text: `qzlist${stamp}`, match_type: "PHRASE" }],
    link_campaign_ids: [campaignId],
  });
  await lifecycle("add_keywords", "add_keywords", {
    ad_group_id: adGroupId,
    keywords: [{ text: `qzkw${stamp}`, match_type: "EXACT" }],
  });
  await lifecycle("pause_keyword", "pause_keyword", {
    keywords: [
      { ad_group_id: adGroupId, criterion_id: String(kws[0].adGroupCriterion.criterionId) },
    ],
  });
  await lifecycle("update_rsa_text", "update_rsa_text", {
    ad_group_id: adGroupId,
    ad_id: String(ad.adGroupAd.ad.id),
    headlines: [
      { text: `E2E new one ${stamp}` },
      { text: `E2E new two ${stamp}` },
      { text: `E2E new three ${stamp}` },
    ],
    path1: "e2e",
  });
  // Sitelink URL as a person types it (upper-case host, no path): how does Google keep it?
  await lifecycle(
    "add_sitelinks",
    "add_sitelinks",
    {
      campaign_id: campaignId,
      sitelinks: [
        {
          link_text: `E2E ${stamp}`,
          final_url: "https://WWW.Example.com",
          description1: "E2E sitelink line one",
          description2: "E2E sitelink line two",
        },
      ],
    },
    {
      after: async () => {
        const rowsS = await gaql(
          `SELECT asset.final_urls, asset.sitelink_asset.link_text FROM asset WHERE asset.type = 'SITELINK' AND asset.sitelink_asset.link_text = 'E2E ${stamp}'`,
        );
        detail.sitelinkUrlAsStored = rowsS.map((r) => r.asset?.finalUrls);
      },
    },
  );
  await lifecycle("add_callouts", "add_callouts", {
    campaign_id: campaignId,
    callouts: [{ text: `E2E ${stamp}` }],
  });

  // Audience exclusions: needs a user list; a rule-based one is made for the run.
  let userListId;
  try {
    const made = await directWrite([
      {
        userListOperation: {
          create: {
            name: `PerfoAds e2e ${stamp}`,
            membershipLifeSpan: 30,
            ruleBasedUserList: {
              flexibleRuleUserList: {
                inclusiveRuleOperator: "AND",
                inclusiveOperands: [
                  {
                    rule: {
                      ruleItemGroups: [
                        {
                          ruleItems: [
                            {
                              name: "url__",
                              stringRuleItem: { operator: "CONTAINS", value: `e2e${stamp}` },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
    const name = JSON.stringify(made).match(/customers\/\d+\/userLists\/(\d+)/)?.[1];
    userListId = name;
  } catch (err) {
    detail.userListError = redact(err?.message ?? err).slice(0, 600);
  }
  if (userListId) {
    cleanup.push(() =>
      directWrite([{ userListOperation: { remove: rn("userLists", userListId) } }]),
    );
    await lifecycle("add_audience_exclusions", "add_audience_exclusions", {
      campaign_id: campaignId,
      user_list_ids: [userListId],
    });
  } else {
    rows.push({
      step: "add_audience_exclusions",
      result: "skipped",
      undo: "-",
      note: `could not make a user list on the test account: ${detail.userListError ?? "?"}`.slice(
        0,
        300,
      ),
    });
  }

  // 5. Undo of B after changes: must be refused (changed after it was made).
  const createB = b.changeId ? { changeId: b.changeId } : undefined;
  if (createB) {
    const u = await call("undo_change", { change_id: createB.changeId });
    rows.push({
      step: "undo create_campaign (B, after changes)",
      result: u.ok ? "PROPOSED (unexpected)" : "refused (expected)",
      undo: "-",
      note: u.text.slice(0, 250),
    });
  }

  // 6. Campaign C: a new ad added outside this server, then undo must see it in change_event.
  if (!skip.has("change_event")) {
    const nameC = `PerfoAds e2e C ${stamp}`;
    cleanup.push(() => removeCampaignDirect(nameC));
    const c = await lifecycle(
      "create_campaign (C)",
      "create_campaign",
      campaignInput(nameC, `qzc${stamp}`),
      {
        noUndo: true,
      },
    );
    const cC = c?.status === "verified" ? await findCampaign(nameC) : undefined;
    if (cC) {
      const agC = (
        await gaql(
          `SELECT ad_group.id FROM ad_group WHERE campaign.id = ${cC.id} AND ad_group.status != 'REMOVED'`,
        )
      )[0].adGroup.id;
      await directWrite([
        {
          adGroupAdOperation: {
            create: {
              adGroup: rn("adGroups", agC),
              status: "PAUSED",
              ad: {
                finalUrls: ["https://www.example.com/e2e-extra"],
                responsiveSearchAd: {
                  headlines: [
                    { text: `Extra one ${stamp}` },
                    { text: `Extra two ${stamp}` },
                    { text: `Extra three ${stamp}` },
                  ],
                  descriptions: [
                    { text: `Extra description one ${stamp}.` },
                    { text: `Extra description two ${stamp}.` },
                  ],
                },
              },
            },
          },
        },
      ]);
      const createC = c.changeId ? { changeId: c.changeId } : undefined;
      // change_event lags (about 10 minutes seen on a test account): wait up to 30 minutes.
      let verdict = "not tried";
      let seen = false;
      for (let i = 0; i < 15 && createC; i++) {
        const ev = await gaql(
          `SELECT change_event.change_resource_type, change_event.resource_change_operation FROM change_event WHERE change_event.change_date_time >= '${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}' AND change_event.change_date_time <= '${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}' AND change_event.campaign = '${rn("campaigns", cC.id)}' LIMIT 50`,
        );
        detail.changeEventC = ev.map(
          (r) =>
            `${plain(r.changeEvent?.changeResourceType)}:${plain(r.changeEvent?.resourceChangeOperation)}`,
        );
        seen =
          ev.filter((r) => plain(r.changeEvent?.changeResourceType) === "AD_GROUP_AD").length >= 2;
        if (seen) break;
        await wait(120_000);
      }
      if (createC) {
        const u = await call("undo_change", { change_id: createC.changeId });
        verdict = u.ok ? "PROPOSED (undo did not see the new ad)" : u.text.slice(0, 250);
      }
      rows.push({
        step: "change_event sees a new ad (C)",
        // Google's change history can answer "no rows" for a moment even after it showed the
        // events (seen live), so the undo may be refused by its history check (the new ad, or
        // the history not ready yet) or by reading the campaign: each is a pass; an undo that
        // is proposed is a fail.
        result: !seen
          ? "event not seen in 30 min"
          : verdict.startsWith("PROPOSED")
            ? "FAIL"
            : verdict.includes("change history shows")
              ? "pass (history)"
              : HISTORY_NOT_READY.test(verdict)
                ? "pass (history not ready)"
                : "pass (contents)",
        undo: "-",
        note: verdict,
      });
    }
  }
} catch (err) {
  exitCode = 1;
  rows.push({
    step: "run stopped",
    result: "error",
    undo: "-",
    note: redact(err?.message ?? err).slice(0, 400),
  });
} finally {
  // Clean-up: campaigns made here (removed directly; B was changed so undo refuses), lists.
  for (const fn of cleanup.reverse()) {
    try {
      const r = await fn();
      detail.cleanup = [...(detail.cleanup ?? []), typeof r === "string" ? r : "ok"];
    } catch (err) {
      detail.cleanup = [
        ...(detail.cleanup ?? []),
        `failed: ${redact(err?.message ?? err).slice(0, 200)}`,
      ];
    }
  }
  restorePolicy();
  await client.close().catch(() => {});
  await handle.close().catch(() => {});
  rt.close();
}

const cols = ["step", "result", "undo", "note"];
const width = { step: 40, result: 24, undo: 14, note: 120 };
const line = (r) =>
  cols
    .map((c) =>
      String(r[c] ?? "")
        .replace(/\s+/g, " ")
        .slice(0, width[c])
        .padEnd(width[c]),
    )
    .join(" | ");
console.log(line({ step: "step", result: "result", undo: "undo", note: "note" }));
for (const r of rows) console.log(line(r));
console.log(
  `policy.yaml restored: ${!policyWritten}; clean-up: ${JSON.stringify(detail.cleanup ?? [])}`,
);
detail.rows = rows;
if (process.env.E2E_OUT)
  writeFileSync(process.env.E2E_OUT, redact(JSON.stringify(detail, null, 2)), { mode: 0o600 });
const bad = rows.filter(
  (r) =>
    !/^(ok|verified|skipped|pass|pass \(history\)|pass \(history not ready\)|pass \(contents\)|none on test account|refused \(expected\))$/.test(
      r.result,
    ) || !/^(-|verified)$/.test(r.undo),
);
process.exit(exitCode || (bad.length ? 1 : 0));
