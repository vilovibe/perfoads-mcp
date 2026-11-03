// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The policy file wired into the server: where it may live, live accounts, the auto
// tier, the approval view, policy://current, the read allowlist, the ops reserve and
// doctor. Fake Google account, fake ids only.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./server.js";
import { listEvents } from "@perfoads/changes";
import { fakeWorld } from "@perfoads/changes/testing";
import { SNAPSHOT_SECTIONS } from "@perfoads/snapshot";
import { fixtureReply } from "@perfoads/snapshot/testing";
import { afterEach, describe, expect, it } from "vitest";
import { allowanceWarning } from "./checkTools.js";
import { checkWriteExposure, runDoctor } from "./doctor.js";
import {
  ACCOUNT,
  budgetParams,
  changeRig,
  readPage,
  textOf,
  type ChangeRig,
} from "./testing/changeRig.js";
import { FAKE_MANAGER } from "./testing/fakes.js";

const rigs: ChangeRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

/** No injected policy: the server uses policy.yaml from its settings folder. */
const rig = (o: Parameters<typeof changeRig>[0] = {}) => {
  const r = changeRig({ policy: null, ...o });
  rigs.push(r);
  return r;
};

const POLICY = (o: { tiers?: string; kill?: boolean; write?: boolean } = {}) => `version: 1
accounts: { allow: ["${ACCOUNT}"], write: [${o.write === false ? "" : `"${ACCOUNT}"`}] }
limits: { max_new_daily_spend: { "${ACCOUNT}": 100 } }
tiers: { ${o.tiers ?? ""} }
kill_switch: ${o.kill ?? false}
`;

const writePolicy = (dir: string, text: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "policy.yaml"), text);
};

type Structured = { change?: { changeId: string; status: string }; refused?: { code: string } };
const sc = (res: { structuredContent?: unknown }) => (res.structuredContent ?? {}) as Structured;

const proposeBudget = async (r: ChangeRig, amount: string) => {
  const { client } = await r.connect();
  const res = await client.callTool({
    name: "propose_change",
    arguments: { customer_id: ACCOUNT, type: "update_budget", params: budgetParams(amount) },
  });
  return { client, res, id: sc(res).change?.changeId ?? "" };
};

describe("policy file location", () => {
  it("a policy.yaml in the project folder is never read: read-only, doctor FAIL", async () => {
    const r = rig();
    writePolicy(r.rt.cwd, POLICY());
    const { res } = await proposeBudget(r, "12.50");
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Writes are off: no policy file/);
    const report = await runDoctor(r.rt, {
      offline: true,
      canBindPage: async () => ({ ok: true }),
    });
    expect(report.checks.find((c) => c.id === "policy_location")).toMatchObject({ status: "fail" });
    expect(report.checks.find((c) => c.id === "policy")?.detail).toMatch(
      /server only reads: nothing can be changed/,
    );
  });

  it("a settings folder inside a workspace root: the policy is ignored, doctor FAIL", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY());
    r.rt.setWorkspaceRoots([path.dirname(r.rt.configDir.dir)]);
    const { res } = await proposeBudget(r, "12.50");
    expect(textOf(res)).toMatch(
      /Writes are off: the policy file is inside a workspace folder your AI app shares/,
    );
    const report = await runDoctor(r.rt, {
      offline: true,
      canBindPage: async () => ({ ok: true }),
    });
    expect(report.checks.find((c) => c.id === "policy")).toMatchObject({ status: "fail" });
    expect(r.fake.validations()).toBe(0);
  });

  it("start: the policy is loaded and its hash logged; invalid = doctor FAIL with the problem", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, `${POLICY()}oops: 1\n`);
    r.rt.loadPolicy();
    const loaded = listEvents(r.rt.store()).filter((e) => e.event === "policy_loaded");
    expect(loaded.at(-1)?.data).toMatchObject({ status: "invalid" });
    expect(String(loaded.at(-1)?.data.hash)).toMatch(/^[0-9a-f]{64}$/);
    const report = await runDoctor(r.rt, {
      offline: true,
      canBindPage: async () => ({ ok: true }),
    });
    expect(report.checks.find((c) => c.id === "policy")).toMatchObject({ status: "fail" });
    expect(report.checks.find((c) => c.id === "policy")?.detail).toMatch(/has mistakes/);
    expect(report.checks.find((c) => c.id === "policy")?.details).toMatch(/unknown key oops/);
  });
});

describe("policy file in force", () => {
  it("a live (not test) account listed under accounts.write: page shows the policy facts, then applied", async () => {
    const r = rig({ world: fakeWorld({ testAccount: false }) });
    writePolicy(r.rt.configDir.dir, POLICY());
    const { client, id } = await proposeBudget(r, "12.50");
    expect(id).toMatch(/^chg_/);
    const first = await client.callTool({ name: "apply_change", arguments: { change_id: id } });
    expect(textOf(first)).toMatch(/Waiting for your approval/);
    const page = await readPage(r.opened.at(-1) ?? "");
    expect(page.body).toContain(
      "This raises daily spend on this account by 2.50 EUR; 97.50 EUR left of your 100.00 EUR 24-hour limit.",
    );
    expect(page.body).toContain("NOT a test account");
    expect(page.body).toContain("once applied, this change affects real ads and real spend");
    const approved = await r.rt
      .approvals()
      .completeWithCode(
        (await import("./approvals/sessions.js")).openSessionFor(r.rt.store(), id, r.rt.now())
          ?.id ?? "",
        page.code,
        "cli",
      );
    expect(approved.ok).toBe(true);
    const applied = await client.callTool({ name: "apply_change", arguments: { change_id: id } });
    expect(sc(applied).change?.status).toBe("verified");
  });

  it("kill switch: refused before any page opens, nothing sent", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY());
    const { client, id } = await proposeBudget(r, "12.50");
    writePolicy(r.rt.configDir.dir, POLICY({ kill: true }));
    const res = await client.callTool({ name: "apply_change", arguments: { change_id: id } });
    expect(textOf(res)).toMatch(/Not sent: Changes are switched off: kill_switch is true/);
    expect(sc(res).refused?.code).toBe("policy_refused");
    expect(r.opened).toHaveLength(0);
    expect(r.fake.writes()).toBe(0);
  });

  it("auto tier, budget decrease: applied by the policy without a page", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY({ tiers: "update_budget: auto" }));
    const { client, id, res } = await proposeBudget(r, "8");
    expect(textOf(res)).toMatch(/lets this low-risk change apply without a person/);
    const applied = await client.callTool({ name: "apply_change", arguments: { change_id: id } });
    expect(sc(applied).change?.status).toBe("verified");
    expect(r.opened).toHaveLength(0);
    expect(r.rt.engine().get(id)?.approvedVia).toBe("policy_auto");
  });

  it("auto tier, budget raise: still needs a person (page opens, nothing sent)", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY({ tiers: "update_budget: auto" }));
    const { client, id } = await proposeBudget(r, "12");
    const res = await client.callTool({ name: "apply_change", arguments: { change_id: id } });
    expect(textOf(res)).toMatch(/Waiting for your approval/);
    expect(r.opened).toHaveLength(1);
    expect(r.fake.writes()).toBe(0);
  });

  it("policy://current: values and summary, no full paths", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY());
    const { client } = await r.connect();
    const res = await client.readResource({ uri: "policy://current" });
    const text = (res.contents[0] as { text: string }).text;
    const body = JSON.parse(text) as { status: string; hash: string; summary: string[] };
    expect(body.status).toBe("valid");
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.summary.join(" ")).toMatch(
      /Accounts that may be changed \(after approval\): 123-456-7890/,
    );
    expect(text).not.toContain(r.rt.configDir.dir);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).filter((n) => /policy/.test(n))).toEqual([]);
  });

  it("reads: only accounts in accounts.allow / write", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY());
    const { client } = await r.connect();
    const res = await client.callTool({
      name: "query_gaql",
      arguments: { customer_id: FAKE_MANAGER, query: "SELECT campaign.id FROM campaign" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not listed under accounts.allow/);
  });

  it("ops reserve: reads and new proposals stop; applying and undo still work", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY({ tiers: "update_budget: auto" }));
    const { client, id } = await proposeBudget(r, "8");
    expect(id).toMatch(/^chg_/);
    // A test account: 15,000 a day, 20 % kept: reads may use 12,000.
    r.rt.opsCounter.record(12_000, "search", "test");
    const read = await client.callTool({
      name: "query_gaql",
      arguments: { customer_id: ACCOUNT, query: "SELECT campaign.id FROM campaign" },
    });
    expect(read.isError).toBe(true);
    expect(textOf(read)).toMatch(/kept for approved changes \(ops_budget.reserve_for_writes_pct/);
    const another = await client.callTool({
      name: "propose_change",
      arguments: { customer_id: ACCOUNT, type: "update_budget", params: budgetParams("7") },
    });
    expect(another.isError).toBe(true);
    expect(textOf(another)).toMatch(/kept for approved changes/);
    const applied = await client.callTool({ name: "apply_change", arguments: { change_id: id } });
    expect(sc(applied).change?.status).toBe("verified");
    const undo = await client.callTool({ name: "undo_change", arguments: { change_id: id } });
    expect(sc(undo).change?.status, textOf(undo)).toBe("proposed");
  });

  it("undo reads may use the whole reserve; an approved undo applies in it", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY({ tiers: "update_budget: auto" }));
    const { client, id } = await proposeBudget(r, "8");
    const applied = await client.callTool({ name: "apply_change", arguments: { change_id: id } });
    expect(sc(applied).change?.status).toBe("verified");
    r.rt.opsCounter.record(12_000, "search", "test"); // reads used up; undo may use the 3,000 kept
    const undo = await client.callTool({ name: "undo_change", arguments: { change_id: id } });
    const undoId = sc(undo).change?.changeId ?? "";
    expect(sc(undo).change?.status, textOf(undo)).toBe("proposed");
    r.rt.opsCounter.record(1_000, "search", "test"); // deeper into the kept share
    const opened = await client.callTool({
      name: "apply_change",
      arguments: { change_id: undoId },
    });
    expect(textOf(opened)).toMatch(/Waiting for your approval/);
    const page = await readPage(r.opened.at(-1) ?? "");
    const { openSessionFor } = await import("./approvals/sessions.js");
    const done = await r.rt
      .approvals()
      .completeWithCode(
        openSessionFor(r.rt.store(), undoId, r.rt.now())?.id ?? "",
        page.code,
        "cli",
      );
    expect(done.ok).toBe(true);
    const sent = await client.callTool({ name: "apply_change", arguments: { change_id: undoId } });
    expect(sc(sent).change?.status, textOf(sent)).toBe("verified");
  });

  it("ops reserve per pool: live and test accounts each against their own limit; unknown = live", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY());
    await r.rt.accounts(); // learns customer.test_account (the fake accounts are test accounts)
    const query = "SELECT campaign.id FROM campaign";
    const NOT_LISTED = "5555555555"; // never discovered: counted as a live account
    // Explorer-or-unknown live budget: 2,880 a day, 20 % kept, reads may use 2,304.
    r.rt.opsCounter.record(2_304, "search");
    const live = await r.rt
      .ads()
      .searchPage({ customerId: NOT_LISTED, query })
      .catch((e: unknown) => e);
    expect(String(live)).toMatch(/2880 Google Ads operations a day on live accounts are kept/);
    // The live count does not touch the test account.
    await expect(r.rt.ads().searchPage({ customerId: ACCOUNT, query })).resolves.toBeDefined();
    r.rt.opsCounter.record(12_000, "search", "test");
    const test = await r.rt
      .ads()
      .searchPage({ customerId: ACCOUNT, query })
      .catch((e: unknown) => e);
    expect(String(test)).toMatch(/15000 Google Ads operations a day on test accounts are kept/);
    expect(r.rt.opsLimits).toEqual({ test: 15_000, production: 2_880 });
  });

  it("stale count one short of the limit: reads held, undo reads reach the limit, Google takes them, the count starts again", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY({ tiers: "update_budget: auto" }));
    const { client, id } = await proposeBudget(r, "8");
    await client.callTool({ name: "apply_change", arguments: { change_id: id } });
    r.rt.opsCounter.record(14_999 - r.rt.opsCounter.used("test"), "search", "test");
    const query = { customer_id: ACCOUNT, query: "SELECT campaign.id FROM campaign" };
    const held = await client.callTool({ name: "query_gaql", arguments: query });
    expect(textOf(held)).toMatch(/kept for approved changes/);
    // the undo's first read takes the last op by our count; the next goes because the count
    // is spent, and Google taking it shows it refilled
    const undo = await client.callTool({ name: "undo_change", arguments: { change_id: id } });
    const undoId = sc(undo).change?.changeId ?? "";
    expect(sc(undo).change?.status, textOf(undo)).toBe("proposed");
    expect(r.rt.opsCounter.used("test")).toBeLessThan(100);
    const read = await client.callTool({ name: "query_gaql", arguments: query });
    expect(read.isError, textOf(read)).toBeFalsy();
    const opened = await client.callTool({
      name: "apply_change",
      arguments: { change_id: undoId },
    });
    expect(textOf(opened)).toMatch(/Waiting for your approval/);
    const page = await readPage(r.opened.at(-1) ?? "");
    const { openSessionFor } = await import("./approvals/sessions.js");
    const done = await r.rt
      .approvals()
      .completeWithCode(
        openSessionFor(r.rt.store(), undoId, r.rt.now())?.id ?? "",
        page.code,
        "cli",
      );
    expect(done.ok).toBe(true);
    const sent = await client.callTool({ name: "apply_change", arguments: { change_id: undoId } });
    expect(sc(sent).change?.status, textOf(sent)).toBe("verified");
  });

  it("a policy file that was never valid: reads refused with the error line", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY().replace("kill_switch", "kil_switch"));
    const { client } = await r.connect();
    const res = await client.callTool({
      name: "query_gaql",
      arguments: { customer_id: ACCOUNT, query: "SELECT campaign.id FROM campaign" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      /Your policy file has an error: the file: unknown key kil_switch; fix it with `perfoads-mcp policy check`/,
    );
  });
});

/** Answers build_snapshot's reads for ACCOUNT from the snapshot fixtures; counts them. */
const snapshotRouter = () => {
  const seen = { reads: 0 };
  return {
    seen,
    extraRouter: (call: { url: string; body: string }) => {
      if (!/googleAds:search$/.test(call.url) || !call.url.includes(ACCOUNT)) return undefined;
      const query = String((JSON.parse(call.body) as { query?: string }).query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      if (from === "customer_client" || (from === "customer" && !query.includes("segments.")))
        return undefined;
      const body = fixtureReply(query);
      if (!body) return undefined;
      seen.reads += 1;
      return { body };
    },
  };
};

describe("snapshots follow the policy", () => {
  it("build_snapshot, run_checks, a kept snapshot by id and the snapshot resources: allowlist only", async () => {
    const google = snapshotRouter();
    const r = rig({ extraRouter: google.extraRouter });
    writePolicy(r.rt.configDir.dir, POLICY());
    const { client } = await r.connect();
    const built = await client.callTool({
      name: "build_snapshot",
      arguments: { customer_id: ACCOUNT },
    });
    expect(built.isError, textOf(built)).toBeFalsy();
    const snapshotId = String((built.structuredContent as { snapshotId?: string }).snapshotId);
    for (const name of ["build_snapshot", "run_checks"]) {
      const res = await client.callTool({ name, arguments: { customer_id: FAKE_MANAGER } });
      expect(res.isError, name).toBe(true);
      expect(textOf(res), name).toMatch(/not listed under accounts.allow/);
    }
    // ACCOUNT leaves the allowlist: its kept snapshot is no longer readable.
    writePolicy(
      r.rt.configDir.dir,
      `version: 1\naccounts: { allow: ["${FAKE_MANAGER}"], write: [] }\n`,
    );
    const byId = await client.callTool({
      name: "run_checks",
      arguments: { snapshot_id: snapshotId },
    });
    expect(byId.isError).toBe(true);
    expect(textOf(byId)).toMatch(/not listed under accounts.allow/);
    for (const uri of [
      `snapshot://${ACCOUNT}/latest`,
      `snapshot://${ACCOUNT}/${snapshotId}/campaigns/1`,
    ]) {
      await expect(client.readResource({ uri }), uri).rejects.toThrow(
        /not listed under accounts.allow/,
      );
    }
    const { resources } = await client.listResources();
    expect(resources.map((x) => x.uri)).not.toContain(`snapshot://${ACCOUNT}/latest`);
  });

  it("the resource list shows an allowed account's snapshot; a broken file keeps the last valid allowlist", async () => {
    const google = snapshotRouter();
    const r = rig({ extraRouter: google.extraRouter });
    writePolicy(r.rt.configDir.dir, POLICY());
    const { client } = await r.connect();
    const built = await client.callTool({
      name: "build_snapshot",
      arguments: { customer_id: ACCOUNT },
    });
    expect(built.isError, textOf(built)).toBeFalsy();
    const listed = async () => (await client.listResources()).resources.map((x) => x.uri);
    expect(await listed()).toContain(`snapshot://${ACCOUNT}/latest`);
    // broken after a valid version: reads (and the listing) stay at the last valid allowlist
    writePolicy(r.rt.configDir.dir, "version: 1\naccounts: [oops\n");
    expect(await listed()).toContain(`snapshot://${ACCOUNT}/latest`);
    // a valid file without the account hides it
    writePolicy(
      r.rt.configDir.dir,
      `version: 1\naccounts: { allow: ["${FAKE_MANAGER}"], write: [] }\n`,
    );
    expect(await listed()).not.toContain(`snapshot://${ACCOUNT}/latest`);
  });

  it("the resource list waits for the client's roots before the policy decides", async () => {
    const google = snapshotRouter();
    const r = rig({ extraRouter: google.extraRouter });
    const { client } = await r.connect();
    // no policy file yet: the account is readable, its snapshot is kept
    const built = await client.callTool({
      name: "build_snapshot",
      arguments: { customer_id: ACCOUNT },
    });
    expect(built.isError, textOf(built)).toBeFalsy();
    // a broken file that was never valid refuses every read ...
    writePolicy(r.rt.configDir.dir, "version: 1\naccounts: [oops\n");
    expect((await client.listResources()).resources.map((x) => x.uri)).not.toContain(
      `snapshot://${ACCOUNT}/latest`,
    );
    // ... unless it sits inside a workspace root (ignored, narrows nothing). The roots answer
    // arrives late: the listing must wait for it, not judge with the old roots.
    await new Promise((res) => setTimeout(res, 20));
    r.rt.setRootsPending(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          r.rt.setWorkspaceRoots([path.dirname(r.rt.configDir.dir)]);
          resolve();
        }, 50),
      ),
    );
    expect((await client.listResources()).resources.map((x) => x.uri)).toContain(
      `snapshot://${ACCOUNT}/latest`,
    );
  });

  it("ops reserve: build_snapshot and run_checks read through the reserve-aware client", async () => {
    const google = snapshotRouter();
    const r = rig({ extraRouter: google.extraRouter });
    writePolicy(r.rt.configDir.dir, POLICY());
    const { client } = await r.connect();
    // Warm the account list, so only the snapshot's own reads meet the reserve.
    const warm = await client.callTool({
      name: "query_gaql",
      arguments: { customer_id: ACCOUNT, query: "SELECT campaign.id FROM campaign" },
    });
    expect(warm.isError, textOf(warm)).toBeFalsy();
    google.seen.reads = 0;
    r.rt.opsCounter.record(12_000, "search", "test"); // test account: reads may use 12,000
    for (const name of ["build_snapshot", "run_checks"]) {
      const res = await client.callTool({
        name,
        arguments: { customer_id: ACCOUNT, refresh: true },
      });
      expect(JSON.stringify(res), name).toMatch(/kept for approved changes/);
      // a whole-run refusal is said once, at the top, never deduped or cut with the not-run list
      if (name === "run_checks")
        expect(textOf(res).split("\n")[1], name).toMatch(
          /^No section was read: .*kept for approved changes/,
        );
    }
    expect(google.seen.reads).toBe(0);
  });

  it("the snapshot's allowance line names the kept share as our own count, not today's", () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY());
    r.rt.opsCounter.record(11_950, "search", "test"); // test account: reads may use 12,000
    const line = allowanceWarning(r.rt, true, SNAPSHOT_SECTIONS.length);
    expect(line).toBe(
      "By our own count of the last 24 hours, 11950 of 15000 Google Ads operations are used, and the policy keeps a share of them for approved changes; this snapshot usually needs about 120, so some sections may not be read until that count goes down.",
    );
    // spent by our count: reads go (as in the transport), so the plain estimate line says so
    r.rt.opsCounter.record(3_050, "search", "test");
    expect(allowanceWarning(r.rt, true, SNAPSHOT_SECTIONS.length)).toMatch(/It is read anyway/);
  });
});

describe("workspace roots", () => {
  it("policy-dependent calls wait for the first roots answer and see it", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY());
    let released = false;
    r.rt.setRootsPending(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          r.rt.setWorkspaceRoots([path.dirname(r.rt.configDir.dir)]);
          released = true;
          resolve();
        }, 50),
      ),
    );
    await r.rt.resolveAccount(ACCOUNT);
    expect(released).toBe(true);
    expect(r.rt.policy().gate(ACCOUNT, "update_budget").reason).toMatch(
      /inside a workspace folder your AI app shares/,
    );
  });

  it("a roots answer that never comes holds a call at most 3 s (runtime clock)", async () => {
    const r = rig({ manualClock: true });
    r.rt.setRootsPending(new Promise(() => undefined));
    const started = r.clock.now;
    let done = false;
    void r.rt.rootsReady().then(() => {
      done = true;
    });
    await r.clock.runUntil(() => done, 60_000);
    expect(r.clock.now - started).toBe(3_000);
  });

  it("roots/list_changed: the server asks again and ignores a policy now inside a root", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY());
    let roots: { uri: string }[] = [];
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(r.rt), { transport: serverSide });
    const client = new Client(
      { name: "roots-client", version: "0.0.0" },
      { capabilities: { roots: { listChanged: true } } },
    );
    client.setRequestHandler("roots/list", async () => ({ roots }));
    await client.connect(clientSide);
    try {
      await r.rt.rootsReady();
      expect(r.rt.policyFile.state().status).toBe("valid");
      roots = [{ uri: pathToFileURL(path.dirname(r.rt.configDir.dir)).href }];
      await client.sendRootsListChanged();
      for (let i = 0; i < 50 && r.rt.policyFile.state().status !== "ignored"; i++) {
        await new Promise((res) => setTimeout(res, 20));
      }
      expect(r.rt.policyFile.state().status).toBe("ignored");
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

describe("doctor: policy lines", () => {
  it("valid policy: location, hash, kill switch, writable accounts, limits", async () => {
    const r = rig();
    writePolicy(r.rt.configDir.dir, POLICY({ kill: true }));
    const report = await runDoctor(r.rt, {
      offline: true,
      canBindPage: async () => ({ ok: true }),
    });
    const line = report.checks.find((c) => c.id === "policy");
    expect(line?.status).toBe("warn");
    expect(line?.detail).toBe(
      "The policy file is valid. Accounts that may be changed: 123-456-7890. Kill switch ON: every change is refused.",
    );
    expect(line?.fix).toMatch(/Turn the kill switch off/);
    expect(line?.details).toMatch(
      /version [0-9a-f]{12}, outside the folders the AI works in\. .*kill_switch: false/,
    );
  });

  it("browser control: a warning only while some account may be changed; read-only = one info line", async () => {
    const config = JSON.stringify({ mcpServers: { playwright: { command: "npx" } } });
    const doctor = async (policy: string) => {
      const r = rig();
      writePolicy(r.rt.configDir.dir, policy);
      const report = await runDoctor(r.rt, {
        offline: true,
        canBindPage: async () => ({ ok: true }),
        readFile: () => config,
      });
      return {
        browser: report.checks.find((c) => c.id === "browser_control"),
        exposure: report.checks.find((c) => c.id === "policy_exposure"),
      };
    };
    const off = await doctor(POLICY({ write: false }));
    expect(off.browser).toMatchObject({
      status: "ok",
      detail: "A browser-control tool is set up here. It only matters once changes are allowed.",
    });
    expect(off.browser?.fix).toBeUndefined();
    expect(off.exposure).toBeUndefined();
    const on = await doctor(POLICY());
    expect(on.browser?.status).toBe("warn");
    expect(on.browser?.details).toMatch(/code_only/);
    // No saved account list yet: the account is not known to be a test account.
    expect(on.exposure?.status).toBe("warn");
  });

  it("warns about writes on a live account with browser control unless code_only", () => {
    const state = {
      status: "valid" as const,
      file: "policy.yaml",
      hash: "a".repeat(64),
      policy: {
        version: 1 as const,
        accounts: { allow: [ACCOUNT], write: [ACCOUNT] },
        limits: {
          max_budget_change_pct: 30,
          max_budget_change_abs: {},
          max_new_daily_spend: {},
          max_target_change_pct: 20,
          writes_per_day: 50,
          writes_per_minute: 10,
          max_ops_per_change: 200,
          proposals_per_minute: 20,
          proposals_per_day: 200,
          undo_per_day: 50,
        },
        defaults: { new_entities_paused: true, broad_match_requires_smart_bidding: true },
        brand_terms: {},
        tiers: {},
        ops_budget: { warn_at_pct: 80, reserve_for_writes_pct: 20 },
        kill_switch: false,
      },
    };
    expect(checkWriteExposure(state, new Map(), "auto", true)?.status).toBe("warn");
    expect(checkWriteExposure(state, new Map(), "code_only", true)).toBeUndefined();
    expect(checkWriteExposure(state, new Map([[ACCOUNT, true]]), "auto", true)).toBeUndefined();
    expect(checkWriteExposure(state, new Map(), "auto", false)).toBeUndefined();
  });
});
