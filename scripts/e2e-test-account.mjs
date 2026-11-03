#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// End-to-end run of change types 1-10 and create_campaign against a Google Ads TEST account (docs/E2E-COVERAGE.md):
// for each type propose -> approve (the CLI code path: approval session + typed code) ->
// apply -> read-back -> undo (propose, approve, apply, read-back), then prints a table.
//
// Refuses any account that is not a test account (customer.test_account must be true).
// Never prints secrets: no token, client secret, refresh token or approval code is printed.
// Uses a throw-away store in a temporary folder and its own in-memory policy that allows
// writes on this one test account only. Build first: pnpm build.
//
// Env:
//   E2E_OAUTH_CLIENT_ID, E2E_OAUTH_CLIENT_SECRET, E2E_REFRESH_TOKEN  (a test-account sign-in)
//   E2E_CUSTOMER_ID          the test account (10 digits, dashes ok)
//   E2E_LOGIN_CUSTOMER_ID    optional: the test manager account above it
//   E2E_ONLY                 optional: comma-separated type names to run

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (pkg, file = "index.js") => path.join(root, "packages", pkg, "dist", file);

const need = (name) => {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing ${name}. See the header of this script.`);
    process.exit(2);
  }
  return v.trim();
};

const clientId = need("E2E_OAUTH_CLIENT_ID");
const clientSecret = need("E2E_OAUTH_CLIENT_SECRET");
const refreshToken = need("E2E_REFRESH_TOKEN");
const customerId = need("E2E_CUSTOMER_ID").replace(/-/g, "");
const loginCustomerId = process.env.E2E_LOGIN_CUSTOMER_ID?.replace(/-/g, "") || undefined;
const only = (process.env.E2E_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!/^\d{10}$/.test(customerId) || (loginCustomerId && !/^\d{10}$/.test(loginCustomerId))) {
  console.error("E2E_CUSTOMER_ID / E2E_LOGIN_CUSTOMER_ID must be 10-digit account ids.");
  process.exit(2);
}

const SECRETS = [clientSecret, refreshToken, clientId];
/** Access tokens handed out during this run (filled by the token provider). */
const issued = new Set();
/** Error text without any secret: client secret, refresh token, every issued access token. */
const safe = (err) => {
  let text = String(err?.message ?? err ?? "error");
  for (const s of [...SECRETS, ...issued]) if (s) text = text.split(s).join("[secret]");
  return text.replace(/ya29\.[\w.-]+/g, "[token]").slice(0, 300);
};

const { createAdsClient } = await import(dist("ads-client"));
const { createChangeEngine, SAFE_DEFAULTS } = await import(dist("changes"));
const { openStore, storePath } = await import(dist("store"));
const { createRefreshTokenProvider } = await import(dist("mcp-server", "tokens.js"));
const { createSession, checkCode, finishSession, localUser } = await import(
  dist("mcp-server", "approvals/sessions.js")
);

const ads = createAdsClient({
  tokens: createRefreshTokenProvider({
    credentials: { clientId, clientSecret, refreshToken },
    onIssued: (t) => issued.add(t),
  }),
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
});
const target = { customerId, loginCustomerId };
const search = async (query) => (await ads.searchAll({ ...target, query, maxRows: 50 })).rows;

// 1. Test account only.
let account;
try {
  account = (
    await search(
      "SELECT customer.id, customer.test_account, customer.manager, customer.currency_code FROM customer LIMIT 1",
    )
  )[0]?.customer;
} catch (err) {
  console.error(`Could not read the account: ${safe(err)}`);
  process.exit(1);
}
if (account?.testAccount !== true) {
  console.error(
    "Refused: this is not a Google Ads test account (customer.test_account is not true).",
  );
  process.exit(3);
}
if (account?.manager === true) {
  console.error("Refused: this is a manager account; give a test client account under it.");
  process.exit(3);
}

// 2. A throw-away store and a policy that only allows this test account.
const dir = mkdtempSync(path.join(tmpdir(), "perfoads-e2e-"));
const store = openStore(storePath(dir));
const yes = { allowed: true, tier: "confirm", reason: "", policy: "e2e-test-account-only" };
const no = {
  allowed: false,
  tier: "blocked",
  reason: "e2e policy: only the test account",
  policy: "e2e",
};
const policy = {
  name: "e2e-test-account-only",
  gate: (id) => (id === customerId ? yes : no),
  check: (r) => (r.account.customerId === customerId && r.account.testAccount !== false ? yes : no),
  liveWrites: () => false,
  defaults: () => ({ ...SAFE_DEFAULTS, brandTerms: ["perfoadsbrandzq"] }),
};
const engine = createChangeEngine({ store, ads, policy });
const by = { actor: "e2e-script", via: "cli" };

/** Approve exactly like `perfoads-mcp approve <id>`: a session, its code typed, finished via cli. */
const approve = async (change) => {
  const { session, code } = await createSession(store, {
    change,
    kind: "approve",
    now: Date.now(),
  });
  const checked = await checkCode(store, session.id, code, Date.now());
  if (!checked.ok) throw new Error(`approval code refused (${checked.reason})`);
  return finishSession(store, engine, session.id, "cli", localUser(), Date.now());
};

const run = async (type, input) => {
  const c = await engine.propose({ customerId, loginCustomerId, type, input, ...by });
  await approve(c);
  return engine.apply(c.id, by);
};

const undoOf = async (changeId) => {
  const u = await engine.proposeUndo(changeId, by);
  await approve(u);
  return engine.apply(u.id, by);
};

// 3. Fixtures found in the test account (nothing is created outside the changes themselves).
const stamp = Date.now().toString(36).slice(-5);
const first = async (query) => (await search(query))[0];
const campaignRow = await first(
  "SELECT campaign.id, campaign.status, campaign.bidding_strategy_type, campaign_budget.id, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED' AND campaign.advertising_channel_type = 'SEARCH' ORDER BY campaign.id LIMIT 1",
);
const campaignId = campaignRow?.campaign?.id;
const adGroupId = campaignId
  ? (
      await first(
        `SELECT ad_group.id FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.status != 'REMOVED' LIMIT 1`,
      )
    )?.adGroup?.id
  : undefined;
const rsa = await first(
  "SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.path1 FROM ad_group_ad WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' AND ad_group_ad.status != 'REMOVED' LIMIT 1",
);
const enabledKeyword = await first(
  "SELECT ad_group.id, ad_group_criterion.criterion_id FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status = 'ENABLED' LIMIT 1",
);
const userList = await first(
  "SELECT user_list.id FROM user_list WHERE user_list.membership_status = 'OPEN' LIMIT 1",
);

const amount = (micros, factor) =>
  (Math.round((Number(micros) / 1e6) * factor * 100) / 100).toFixed(2);

/** type -> [why skipped] or [input, setup?, cleanup?] */
const plans = {
  update_budget: () =>
    campaignRow?.campaignBudget?.id
      ? {
          input: {
            budget_id: campaignRow.campaignBudget.id,
            daily_amount: amount(campaignRow.campaignBudget.amountMicros, 1.1),
          },
        }
      : { skip: "no Search campaign with a budget" },
  update_campaign_status: () =>
    campaignId
      ? {
          input: {
            campaign_id: campaignId,
            status: campaignRow.campaign.status === "ENABLED" ? "PAUSED" : "ENABLED",
          },
        }
      : { skip: "no Search campaign" },
  update_bidding: () =>
    campaignId && campaignRow.campaign.biddingStrategyType === "MAXIMIZE_CONVERSIONS"
      ? { input: { campaign_id: campaignId, target_cpa: "5.00" } }
      : { skip: "needs a Search campaign on Maximize conversions without a portfolio" },
  add_campaign_negatives: () =>
    campaignId
      ? {
          input: {
            campaign_ids: [campaignId],
            negatives: [{ text: `qzneg${stamp}`, match_type: "EXACT" }],
          },
        }
      : { skip: "no Search campaign" },
  remove_campaign_negatives: () =>
    campaignId
      ? {
          setup: [
            "add_campaign_negatives",
            {
              campaign_ids: [campaignId],
              negatives: [{ text: `qzrm${stamp}`, match_type: "PHRASE" }],
            },
          ],
          input: {
            campaign_id: campaignId,
            negatives: [{ text: `qzrm${stamp}`, match_type: "PHRASE" }],
          },
          cleanup: [
            "remove_campaign_negatives",
            {
              campaign_id: campaignId,
              negatives: [{ text: `qzrm${stamp}`, match_type: "PHRASE" }],
            },
          ],
        }
      : { skip: "no Search campaign" },
  add_shared_negatives: () =>
    campaignId
      ? {
          input: {
            new_list_name: `PerfoAds e2e ${stamp}`,
            negatives: [{ text: `qzlist${stamp}`, match_type: "PHRASE" }],
            link_campaign_ids: [campaignId],
          },
        }
      : { skip: "no Search campaign" },
  add_keywords: () =>
    adGroupId
      ? {
          input: {
            ad_group_id: adGroupId,
            keywords: [{ text: `qzkw${stamp}`, match_type: "EXACT" }],
          },
        }
      : { skip: "no ad group in a Search campaign" },
  pause_keyword: () =>
    enabledKeyword
      ? {
          input: {
            keywords: [
              {
                ad_group_id: enabledKeyword.adGroup.id,
                criterion_id: enabledKeyword.adGroupCriterion.criterionId,
              },
            ],
          },
        }
      : { skip: "no ENABLED keyword" },
  update_rsa_text: () =>
    rsa
      ? {
          input: {
            ad_group_id: rsa.adGroup.id,
            ad_id: rsa.adGroupAd.ad.id,
            path1: rsa.adGroupAd.ad.responsiveSearchAd?.path1 === "e2e" ? "e2e2" : "e2e",
          },
        }
      : { skip: "no responsive search ad" },
  add_sitelinks: () =>
    campaignId
      ? {
          input: {
            campaign_id: campaignId,
            sitelinks: [{ link_text: `E2E ${stamp}`, final_url: "https://www.example.com/e2e" }],
          },
        }
      : { skip: "no Search campaign" },
  add_callouts: () =>
    campaignId
      ? { input: { campaign_id: campaignId, callouts: [{ text: `E2E ${stamp}` }] } }
      : { skip: "no Search campaign" },
  add_audience_exclusions: () =>
    campaignId && userList
      ? { input: { campaign_id: campaignId, user_list_ids: [userList.userList.id] } }
      : { skip: "needs a Search campaign and an open audience list" },
  // Needs no fixture: made PAUSED, read back, then undone (removed with its own budget).
  create_campaign: () => ({
    input: {
      name: `PerfoAds e2e ${stamp}`,
      campaign_type: "SEARCH",
      daily_budget: "1.00",
      bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
      networks: { google_search: true, search_partners: false, display: false },
      locations: { geo_target_ids: ["2840"], targeting: "PRESENCE" },
      language_ids: ["1000"],
      contains_eu_political_advertising: false,
      ad_groups: [
        {
          name: `E2E group ${stamp}`,
          keywords: [{ text: `qzcc${stamp}`, match_type: "EXACT" }],
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
    },
  }),
};

const rows = [];
for (const [type, plan] of Object.entries(plans)) {
  if (only.length && !only.includes(type)) continue;
  const p = plan();
  if (p.skip) {
    rows.push({ type, change: "-", status: "skipped", undo: "-", undoStatus: "-", note: p.skip });
    continue;
  }
  try {
    if (p.setup) await run(...p.setup);
    const v = await run(type, p.input);
    let undoStatus = "-";
    let note = v.statusReason ?? "";
    if (v.undo.supported && (v.status === "verified" || v.status === "applied")) {
      try {
        undoStatus = (await undoOf(v.id)).status;
      } catch (err) {
        undoStatus = "error";
        note = safe(err);
      }
    }
    if (p.cleanup) {
      try {
        await run(...p.cleanup);
      } catch {
        // already gone
      }
    }
    rows.push({ type, change: v.id, status: v.status, undo: v.undo.level, undoStatus, note });
  } catch (err) {
    rows.push({ type, change: "-", status: "error", undo: "-", undoStatus: "-", note: safe(err) });
  }
}

const cols = ["type", "change", "status", "undo", "undoStatus", "note"];
const width = Object.fromEntries(
  cols.map((c) => [c, Math.min(60, Math.max(c.length, ...rows.map((r) => String(r[c]).length)))]),
);
const line = (r) => cols.map((c) => String(r[c]).slice(0, width[c]).padEnd(width[c])).join(" | ");
console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
console.log(cols.map((c) => "-".repeat(width[c])).join("-|-"));
for (const r of rows) console.log(line(r));

store.close();
rmSync(dir, { recursive: true, force: true });
const bad = rows.filter((r) => r.status !== "verified" && r.status !== "skipped");
process.exit(bad.length || rows.some((r) => r.undoStatus === "error") ? 1 : 0);
