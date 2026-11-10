// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The real-account run's guards, without Google: node --test scripts/e2e-real-account-guards.test.mjs

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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
  checkSpendCap,
  checkStartEnv,
  checkStillPaused,
  checkUndo,
  cleanupOrder,
  CONFIRM,
  createOwned,
  createPolicySwap,
  GuardError,
  NAME_PREFIX,
  MAX_WRITE_RETRIES,
  OPS_STEP_STOP,
  paceWaitMs,
  retryWrite,
  runLimits,
  runPolicyYaml,
} from "./e2e-real-account-guards.mjs";

const ID = "1234567890";
const URL_OK = "https://shop.example.com/";
const goodEnv = {
  E2E_REAL_CUSTOMER_ID: "123-456-7890",
  E2E_REAL_CONFIRM: CONFIRM,
  PERFOADS_MCP_HOME: "/tmp/perfoads-test-home",
  E2E_REAL_BRAND_TERMS: "example brand, examplebrand",
  E2E_REAL_FINAL_URL: URL_OK,
};
const refused = (fn, re) =>
  assert.throws(fn, (err) => err instanceof GuardError && (!re || re.test(err.message)));

const ctxWith = () => {
  const owned = createOwned("abc123");
  owned.campaign.add("111");
  owned.campaign_budget.add("222");
  owned.ad_group.add("333");
  owned.ad.add("444");
  owned.criterion.add("555");
  owned.change.add("ch-1");
  owned.userListId = "777";
  owned.names.add(`${NAME_PREFIX} abc123 B`);
  return { owned, finalUrl: URL_OK, customerId: ID, vetted: new Set(["ch-1"]) };
};

describe("start env", () => {
  it("passes with every value set", () => {
    assert.deepEqual(checkStartEnv(goodEnv), {
      customerId: ID,
      brandTerms: ["example brand", "examplebrand"],
      finalUrl: URL_OK,
      spendCap: 2,
    });
  });
  it("refuses with no env at all", () => refused(() => checkStartEnv({})));
  it("takes E2E_REAL_SPEND_CAP from 2 to 5, default 2", () => {
    assert.equal(checkSpendCap(undefined), 2);
    assert.equal(checkSpendCap(""), 2);
    assert.equal(checkSpendCap("2"), 2);
    assert.equal(checkSpendCap("4"), 4);
    assert.equal(checkSpendCap(" 5.00 "), 5);
    assert.equal(checkStartEnv({ ...goodEnv, E2E_REAL_SPEND_CAP: "4" }).spendCap, 4);
  });
  it("refuses a spend cap outside 2..5 or not an amount", () => {
    for (const v of ["1.99", "1", "0", "5.01", "6", "-3", "abc", "4e0", "3.333", "$4"])
      refused(() => checkSpendCap(v), /SPEND_CAP/);
    refused(() => checkStartEnv({ ...goodEnv, E2E_REAL_SPEND_CAP: "10" }), /SPEND_CAP/);
  });
  it("refuses a missing or short customer id", () => {
    refused(() => checkStartEnv({ ...goodEnv, E2E_REAL_CUSTOMER_ID: undefined }), /CUSTOMER_ID/);
    refused(() => checkStartEnv({ ...goodEnv, E2E_REAL_CUSTOMER_ID: "12345" }), /CUSTOMER_ID/);
  });
  it("refuses a missing or wrong confirm", () => {
    refused(() => checkStartEnv({ ...goodEnv, E2E_REAL_CONFIRM: undefined }), /CONFIRM/);
    refused(() => checkStartEnv({ ...goodEnv, E2E_REAL_CONFIRM: "yes" }), /CONFIRM/);
  });
  it("refuses without a settings folder, brand terms or an https URL", () => {
    refused(() => checkStartEnv({ ...goodEnv, PERFOADS_MCP_HOME: "" }), /PERFOADS_MCP_HOME/);
    refused(() => checkStartEnv({ ...goodEnv, E2E_REAL_BRAND_TERMS: " , " }), /BRAND/);
    refused(() => checkStartEnv({ ...goodEnv, E2E_REAL_FINAL_URL: "http://x.com/" }), /https/);
    refused(() => checkStartEnv({ ...goodEnv, E2E_REAL_FINAL_URL: "nope" }), /FINAL_URL/);
  });
});

describe("account", () => {
  const live = { customerId: ID, isTestAccount: false, isManager: false };
  it("passes the named live client account (list entry or GAQL row)", () => {
    assert.equal(checkAccount(live, ID), true);
    assert.equal(checkAccount({ id: ID, testAccount: false, manager: false }, ID), true);
  });
  it("refuses another account (wrong id)", () =>
    refused(() => checkAccount({ ...live, customerId: "9876543210" }, ID), /not E2E_REAL/));
  it("refuses a test account", () =>
    refused(() => checkAccount({ ...live, isTestAccount: true }, ID), /non-test/));
  it("refuses a manager account", () =>
    refused(() => checkAccount({ ...live, isManager: true }, ID), /manager/));
  it("refuses an account whose kind is unknown or missing", () => {
    refused(() => checkAccount({ customerId: ID, isManager: false }, ID), /non-test/);
    refused(() => checkAccount(undefined, ID), /not reachable/);
  });
});

describe("proposals", () => {
  const ctx = ctxWith();
  it("passes the run's own targets", () => {
    assert.equal(
      checkProposal("update_budget", { budget_id: "222", daily_amount: "2.00" }, ctx),
      true,
    );
    assert.equal(
      checkProposal("update_campaign_status", { campaign_id: "111", status: "ENABLED" }, ctx),
      true,
    );
    assert.equal(
      checkProposal(
        "pause_keyword",
        { keywords: [{ ad_group_id: "333", criterion_id: "555" }] },
        ctx,
      ),
      true,
    );
    assert.equal(
      checkProposal("add_audience_exclusions", { campaign_id: "111", user_list_ids: ["777"] }, ctx),
      true,
    );
  });
  it("refuses a campaign not made this run", () => {
    refused(
      () => checkProposal("update_campaign_status", { campaign_id: "999", status: "PAUSED" }, ctx),
      /not made by this run/,
    );
    refused(
      () =>
        checkProposal(
          "add_campaign_negatives",
          { campaign_ids: ["111", "999"], negatives: [{ text: "qzabc123" }] },
          ctx,
        ),
      /not made by this run/,
    );
  });
  it("refuses a budget, ad, keyword or ad group not made this run", () => {
    refused(() => checkProposal("update_budget", { budget_id: "999", daily_amount: "1.00" }, ctx));
    refused(() =>
      checkProposal(
        "update_rsa_text",
        { ad_group_id: "333", ad_id: "999", headlines: [{ text: "x abc123" }] },
        ctx,
      ),
    );
    refused(() =>
      checkProposal(
        "pause_keyword",
        { keywords: [{ ad_group_id: "333", criterion_id: "999" }] },
        ctx,
      ),
    );
    refused(() =>
      checkProposal("add_keywords", { ad_group_id: "999", keywords: [{ text: "qzabc123" }] }, ctx),
    );
  });
  it("refuses an existing shared list and other user lists", () => {
    refused(
      () =>
        checkProposal(
          "add_shared_negatives",
          { shared_set_id: "888", negatives: [{ text: "qzabc123" }] },
          ctx,
        ),
      /shared_set_id/,
    );
    refused(() =>
      checkProposal("add_audience_exclusions", { campaign_id: "111", user_list_ids: ["778"] }, ctx),
    );
  });
  it("refuses a budget over the cap and text that is not the run's own", () => {
    refused(
      () => checkProposal("update_budget", { budget_id: "222", daily_amount: "2.01" }, ctx),
      /above/,
    );
    refused(
      () =>
        checkProposal(
          "add_campaign_negatives",
          { campaign_ids: ["111"], negatives: [{ text: "mugs" }] },
          ctx,
        ),
      /own text/,
    );
  });
  it("refuses a campaign that is not the run's shape", () => {
    const base = {
      name: `${NAME_PREFIX} abc123 A`,
      campaign_type: "SEARCH",
      daily_budget: "1.00",
      networks: { google_search: true, search_partners: false, display: false },
      ad_groups: [
        {
          name: "g abc123",
          keywords: [{ text: "qzabc123 one" }],
          ad: { final_url: URL_OK },
        },
      ],
    };
    assert.equal(checkProposal("create_campaign", base, ctx), true);
    refused(() => checkProposal("create_campaign", { ...base, name: "Brand Search" }, ctx));
    refused(() => checkProposal("create_campaign", { ...base, daily_budget: "10.00" }, ctx));
    refused(() =>
      checkProposal(
        "create_campaign",
        { ...base, networks: { ...base.networks, search_partners: true } },
        ctx,
      ),
    );
    refused(() => checkProposal("create_campaign", { ...base, shared_budget_id: "222" }, ctx));
  });
  it("refuses change types outside the run", () =>
    refused(
      () => checkProposal("apply_recommendation", { recommendation_id: "x" }, ctx),
      /not part/,
    ));
  it("refuses an undo of a change not proposed this run", () => {
    assert.equal(checkUndo("ch-1", ctx), true);
    refused(() => checkUndo("ch-other", ctx), /not proposed by this run/);
  });
});

describe("the change as built by the server", () => {
  const ctx = ctxWith();
  const change = (affected, id = ID) => ({ account: { customerId: id }, affected });
  it("passes when it reaches only run items and the picked list", () => {
    assert.equal(
      checkAffected(
        change([
          { kind: "campaign", id: "111" },
          { kind: "user_list", id: "777" },
        ]),
        ctx,
      ),
      true,
    );
  });
  it("refuses a foreign resource (e.g. a shared budget's other campaign)", () =>
    refused(
      () =>
        checkAffected(
          change([
            { kind: "campaign_budget", id: "222" },
            { kind: "campaign", id: "999" },
          ]),
          ctx,
        ),
      /not made by this run/,
    ));
  it("refuses another account and unknown kinds", () => {
    refused(() => checkAffected(change([], "9876543210"), ctx), /another account/);
    refused(() => checkAffected(change([{ kind: "bidding_strategy", id: "5" }]), ctx), /never/);
  });
});

describe("approval page", () => {
  const ctx = ctxWith();
  const page = (o = {}) =>
    [
      `<p class="ids">Account ID <b>${o.acct ?? "123-456-7890"}</b> &middot; Currency <b>USD</b></p>`,
      `<p>${o.badge ?? '<span class="badge live">NOT a test account</span>'}</p>`,
      o.override ? '<p class="override">OVERRIDE: 1 negative</p>' : "",
      `<p class="meta">Change ${o.id ?? "ch-1"} &middot; type update_budget &middot; version id x</p>`,
    ].join("\n");
  it("passes the vetted change on the live account", () =>
    assert.deepEqual(checkApprovalPage(page(), ctx), { ok: true, why: "", changeId: "ch-1" }));
  it("rejects another account, a test badge, an OVERRIDE or an unchecked change", () => {
    assert.equal(checkApprovalPage(page({ acct: "987-654-3210" }), ctx).ok, false);
    assert.equal(
      checkApprovalPage(
        page({ badge: '<span class="badge test">Google Ads TEST account</span>' }),
        ctx,
      ).ok,
      false,
    );
    assert.equal(checkApprovalPage(page({ override: true }), ctx).ok, false);
    assert.equal(checkApprovalPage(page({ id: "ch-2" }), ctx).ok, false);
  });
});

describe("clean-up, ops and policy", () => {
  const ctx = ctxWith();
  it("removes only run items, by id or the exact proposed name, with the run prefix", () => {
    assert.equal(checkCleanupTarget("campaign", "111", `${NAME_PREFIX} abc123 B`, ctx.owned), true);
    assert.equal(checkCleanupTarget("campaign", "999", `${NAME_PREFIX} abc123 B`, ctx.owned), true);
    refused(() => checkCleanupTarget("campaign", "999", `${NAME_PREFIX} zzz C`, ctx.owned));
    refused(() => checkCleanupTarget("campaign", "111", "Brand Search", ctx.owned), /start/);
  });
  it("removes only an own, unshared budget", () => {
    assert.equal(checkOwnBudget({ explicitlyShared: false, referenceCount: 1 }), true);
    refused(() => checkOwnBudget({ explicitlyShared: true, referenceCount: 1 }));
    refused(() => checkOwnBudget({ explicitlyShared: false, referenceCount: 2 }));
    refused(() => checkOwnBudget(undefined));
  });
  it("stops new steps before the ops cap", () => {
    assert.equal(checkOps(1100, 100), 1000);
    refused(() => checkOps(100 + OPS_STEP_STOP, 100), /stopping/);
  });
  it("writes a policy the server accepts: one write account, the caps", async (t) => {
    const yaml = runPolicyYaml(ID, ["example brand", "examplebrand"]);
    assert.match(yaml, /write: \["1234567890"\]/);
    assert.match(yaml, /max_new_daily_spend: \{ "1234567890": 2 \}/);
    assert.match(yaml, /writes_per_day: 80/);
    assert.match(yaml, new RegExp(`writes_per_minute: ${runLimits().writes_per_minute}\n`));
    assert.match(
      runPolicyYaml(ID, ["example brand"], 4),
      /max_new_daily_spend: \{ "1234567890": 4 \}/,
    );
    assert.match(yaml, /new_entities_paused: true/);
    const dist = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../packages/policy/dist/index.js",
    );
    if (!existsSync(dist)) return t.skip("pnpm build first to parse it with the server's schema");
    const { parsePolicyText } = await import(dist);
    const parsed = parsePolicyText(yaml);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors ?? parsed));
  });
});

describe("clean-up order", () => {
  it("removes the list (and its link to B) before B when B is paused", () =>
    assert.deepEqual(cleanupOrder("PAUSED"), ["list", "B", "A"]));
  it("removes B first when it is on, unknown or anything but paused", () => {
    for (const st of ["ENABLED", undefined, "REMOVED", "UNKNOWN"])
      assert.deepEqual(cleanupOrder(st), ["B", "list", "A"]);
  });
});

describe("approval after Ctrl-C", () => {
  it("approves a checked page while the run goes on", () =>
    assert.equal(approvalAction(true, false), "approve"));
  it("rejects once a stop is asked for, or when the page check failed", () => {
    assert.equal(approvalAction(true, true), "reject");
    assert.equal(approvalAction(false, false), "reject");
    assert.equal(approvalAction(false, true), "reject");
  });
});

describe("campaign B after the on/off step", () => {
  it("goes on only when it reads PAUSED", () =>
    assert.equal(checkStillPaused("PAUSED", "campaign B"), true));
  it("stops the run when it is on, unknown or gone", () => {
    refused(() => checkStillPaused("ENABLED", "campaign B"), /ENABLED/);
    refused(() => checkStillPaused(undefined, "campaign B"), /nothing/);
    refused(() => checkStillPaused("REMOVED", "campaign B"));
  });
});

describe("settings folder, policy swap and E2E_OUT", () => {
  const tmp = () => mkdtempSync(path.join(tmpdir(), "perfoads-e2e-real-"));
  const yaml = runPolicyYaml(ID, ["example brand"]);

  it("no policy.yaml before -> none after", () => {
    const dir = tmp();
    const swap = createPolicySwap(dir, "abc123", yaml);
    swap.write();
    assert.equal(readFileSync(path.join(dir, "policy.yaml"), "utf8"), yaml);
    assert.equal(swap.restore(), true);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(swap.restore(), true);
    rmSync(dir, { recursive: true });
  });
  it("policy.yaml before -> byte-identical (and same mode) after", () => {
    const dir = tmp();
    const own = Buffer.from("version: 1\n# the folder's own policy \u00e9\n");
    writeFileSync(path.join(dir, "policy.yaml"), own, { mode: 0o640 });
    const swap = createPolicySwap(dir, "abc123", yaml);
    swap.write();
    assert.equal(readFileSync(path.join(dir, "policy.yaml"), "utf8"), yaml);
    assert.equal(swap.written, true);
    assert.equal(swap.restore(), true);
    assert.equal(readFileSync(path.join(dir, "policy.yaml")).equals(own), true);
    assert.equal(statSync(path.join(dir, "policy.yaml")).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(dir), ["policy.yaml"]);
    rmSync(dir, { recursive: true });
  });
  it("puts the own policy back even when its backup went missing", () => {
    const dir = tmp();
    const own = Buffer.from("version: 1\n");
    writeFileSync(path.join(dir, "policy.yaml"), own);
    const swap = createPolicySwap(dir, "abc123", yaml);
    swap.write();
    for (const n of readdirSync(dir)) if (n !== "policy.yaml") rmSync(path.join(dir, n));
    assert.equal(swap.restore(), true);
    assert.equal(readFileSync(path.join(dir, "policy.yaml")).equals(own), true);
    rmSync(dir, { recursive: true });
  });
  it("refuses a folder an earlier run left its policy or a backup in", () => {
    const dir = tmp();
    assert.equal(checkPolicyFolder(dir), true);
    writeFileSync(path.join(dir, "policy.yaml"), "version: 1\n");
    assert.equal(checkPolicyFolder(dir), true);
    writeFileSync(path.join(dir, "policy.yaml"), yaml);
    refused(() => checkPolicyFolder(dir), /earlier run.*delete it/);
    writeFileSync(path.join(dir, "policy.yaml"), "version: 1\n");
    writeFileSync(path.join(dir, "policy.yaml.e2e-real-backup-abc123"), "version: 1\n");
    refused(() => checkPolicyFolder(dir), /e2e-real-backup-abc123.*rename the newest backup/);
    // A crashed run mid-swap: its own policy.yaml and the folder's backup.
    writeFileSync(path.join(dir, "policy.yaml"), yaml);
    refused(() => checkPolicyFolder(dir), /delete policy\.yaml there/);
    rmSync(dir, { recursive: true });
  });
  it("refuses E2E_OUT inside the repo, passes one outside", () => {
    const repo = tmp();
    const outside = tmp();
    mkdirSync(path.join(repo, "scripts"));
    refused(() => checkOutPath(path.join(repo, "out.json"), [repo]), /outside the repo/);
    refused(() => checkOutPath(path.join(repo, "new", "dir", "out.json"), [repo]));
    refused(() => checkOutPath(path.join(repo, "scripts", "..", "out.json"), [repo]));
    refused(() => checkOutPath(repo, [repo]));
    const out = path.join(outside, "out.json");
    assert.equal(checkOutPath(out, [repo]), path.join(realpathSync(outside), "out.json"));
    refused(() => checkOutPath(out, [repo, outside]));
    assert.equal(checkOutPath(undefined, [repo]), undefined);
    assert.equal(existsSync(out), false);
    rmSync(repo, { recursive: true });
    rmSync(outside, { recursive: true });
  });
});

describe("write pacing", () => {
  const now = 1_000_000;
  it("does not wait while fewer than limit - 2 writes are in the last minute", () => {
    assert.equal(paceWaitMs([], 10, now), 0);
    assert.equal(
      paceWaitMs([now - 1, now - 2, now - 3, now - 4, now - 5, now - 6, now - 7], 10, now),
      0,
    );
  });
  it("waits for the oldest writes to leave the minute at limit - 2", () => {
    const eight = [10, 20, 30, 40, 50, 60, 70, 80].map((s) => now - 60_000 + s * 100);
    // 8 in the window, room 8: the oldest must leave (at now + 1 s) plus 1 s margin.
    assert.equal(paceWaitMs(eight, 10, now), 1_000 + 1_000);
    // Ten in the window: the three oldest must leave; order of the log does not matter.
    const ten = [...eight, now - 500, now - 100].reverse();
    assert.equal(paceWaitMs(ten, 10, now), 3_000 + 1_000);
  });
  it("ignores writes older than a minute and follows the given limit", () => {
    const old = Array.from({ length: 20 }, (_, i) => now - 60_000 - i);
    assert.equal(paceWaitMs(old, 10, now), 0);
    const three = [now - 3_000, now - 2_000, now - 1_000];
    assert.equal(paceWaitMs(three.slice(1), 5, now), 0);
    assert.equal(paceWaitMs(three, 5, now), 57_000 + 1_000);
    assert.equal(paceWaitMs([...three, now - 500], 5, now), 58_000 + 1_000);
    assert.equal(paceWaitMs([now - 10_000], 2, now), 50_000 + 1_000);
  });
});

describe("write retry", () => {
  const minuteText =
    "10 changes were sent to this account in the last minute; the policy allows 10 a minute. Try again in a minute.";
  const byRule = {
    ok: false,
    sc: { refused: { code: "policy_refused", rule: "limits.writes_per_minute", message: "x" } },
    text: "",
  };
  it("retries the per-minute write limit, by rule or by its sentence", () => {
    assert.equal(retryWrite(byRule, 0), true);
    assert.equal(retryWrite({ ok: false, sc: null, text: minuteText }, 0), true);
  });
  it("retries at most 3 times", () => {
    assert.equal(MAX_WRITE_RETRIES, 3);
    assert.equal(retryWrite(byRule, 2), true);
    assert.equal(retryWrite(byRule, 3), false);
    assert.equal(retryWrite({ ok: false, sc: null, text: minuteText }, 3), false);
  });
  it("does not retry a success or any other refusal", () => {
    assert.equal(retryWrite({ ok: true, sc: {}, text: "" }, 0), false);
    const day = {
      ok: false,
      sc: { refused: { code: "policy_refused", rule: "limits.writes_per_day" } },
      text: "80 changes were already sent to this account in the last 24 hours; the policy allows 80 a day. Try again later.",
    };
    assert.equal(retryWrite(day, 0), false);
    assert.equal(
      retryWrite({ ok: false, sc: null, text: "Account 123-456-7890 is read-only" }, 0),
      false,
    );
    assert.equal(
      retryWrite(
        {
          ok: false,
          sc: { refused: { code: "policy_refused", rule: "limits.max_new_daily_spend" } },
          text: "",
        },
        0,
      ),
      false,
    );
  });
});
