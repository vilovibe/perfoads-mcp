// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listEvents, type PolicyRequest } from "@perfoads/changes";
import { openStore, storePath, type Store } from "@perfoads/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFilePolicy, NO_POLICY_REASON } from "./check.js";
import { createPolicySource, isBelowHome, policyPath, startFolderVerdict } from "./source.js";

const A = "1234567890";
let root: string;
let configDir: string;
let store: Store;

const write = (text: string, dir = configDir): void => {
  writeFileSync(path.join(dir, "policy.yaml"), text);
};

const policyText = (over: { pct?: number; kill?: boolean; write?: string } = {}) => `version: 1
accounts: { allow: ["${A}"], write: [${over.write ?? `"${A}"`}] }
limits: { max_budget_change_pct: ${over.pct ?? 30}, max_new_daily_spend: { "${A}": 100 } }
kill_switch: ${over.kill ?? false}
`;

const req = (over: Partial<PolicyRequest> = {}): PolicyRequest => ({
  stage: "apply",
  type: "update_budget",
  account: {
    customerId: A,
    name: "Shop",
    currencyCode: "EUR",
    timeZone: null,
    testAccount: false,
    manager: false,
  },
  payload: {},
  facts: {
    budgetChanges: [
      { budgetId: "222", beforeMicros: "100000000", afterMicros: "125000000", shared: false },
    ],
    affectedCampaignIds: [],
  },
  opsCount: 1,
  undoOf: null,
  recent: [],
  now: Date.parse("2026-10-25T10:00:00.000Z"),
  ...over,
});

const policyEvents = (s: Store) => listEvents(s).filter((e) => e.event === "policy_loaded");

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "perfoads-policy-"));
  configDir = path.join(root, "home", ".config", "perfoads-mcp");
  mkdirSync(configDir, { recursive: true });
  store = openStore(storePath(configDir));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const source = (
  o: {
    cwd?: string;
    roots?: string[];
    s?: Store;
    dir?: string;
    mode?: "server" | "cli";
  } = {},
) =>
  createPolicySource({
    configDir: o.dir ?? configDir,
    cwd: o.cwd ?? path.join(root, "project"),
    home: path.join(root, "home"),
    roots: () => o.roots ?? [],
    store: () => o.s ?? store,
    ...(o.mode ? { mode: o.mode } : {}),
  });

describe("policy source", () => {
  it("no file = none (read-only); a valid file is loaded and its hash logged once", () => {
    const src = source();
    expect(src.current().status).toBe("none");
    write(policyText());
    const s1 = src.current();
    expect(s1.status).toBe("valid");
    src.current();
    const events = policyEvents(store);
    expect(events.map((e) => e.data.status)).toEqual(["none", "valid"]);
    expect(events[1]?.data).toMatchObject({
      hash: s1.status === "valid" ? s1.hash : "",
      file: "policy.yaml",
    });
    // The audit log gets the file name only, never the full path.
    expect(JSON.stringify(events)).not.toContain(configDir);
  });

  it("re-reads on every check: a content change with the same mtime is seen (hash), and logged", () => {
    const src = source();
    write(policyText());
    const first = src.current();
    const t = new Date("2026-10-25T09:00:00Z");
    utimesSync(policyPath(configDir), t, t);
    write(policyText({ kill: true }));
    utimesSync(policyPath(configDir), t, t);
    const second = src.current();
    expect(second.status === "valid" && second.policy.kill_switch).toBe(true);
    expect(
      first.status === "valid" && second.status === "valid" && first.hash !== second.hash,
    ).toBe(true);
    expect(policyEvents(store)).toHaveLength(2);
  });

  it("an invalid file = invalid (never partly valid), logged with its problems", () => {
    const src = source();
    write(`${policyText()}surprise: true\n`);
    const s = src.current();
    expect(s.status).toBe("invalid");
    expect(policyEvents(store)[0]?.data).toMatchObject({ status: "invalid" });
    const policy = createFilePolicy(src);
    expect(policy.gate(A, "update_budget")).toMatchObject({ allowed: false });
    expect(policy.gate(A, "update_budget").reason).toMatch(
      /not valid \(the file: unknown key surprise\)/,
    );
    expect(policy.liveWrites(A)).toBe(false);
  });

  it("defaults(): the valid file's defaults + this account's brand terms; anything else = the safe side", () => {
    const src = source();
    const policy = createFilePolicy(src);
    expect(policy.defaults(A)).toEqual({
      newEntitiesPaused: true,
      broadMatchRequiresSmartBidding: true,
      brandTerms: [],
    });
    write(
      `${policyText()}defaults: { new_entities_paused: false }\nbrand_terms: { "${A}": ["Contoso"] }\n`,
    );
    expect(policy.defaults(A)).toEqual({
      newEntitiesPaused: false,
      broadMatchRequiresSmartBidding: true,
      brandTerms: ["Contoso"],
    });
    expect(policy.defaults("1111111111").brandTerms).toEqual([]);
    write(`${policyText()}surprise: true\n`);
    expect(policy.defaults(A).newEntitiesPaused).toBe(true);
  });

  it("a file larger than 64 KB is invalid", () => {
    write(`${policyText()}${"# padding\n".repeat(7000)}`);
    expect(source().current()).toMatchObject({
      status: "invalid",
      problems: ["the file is larger than 64 KB"],
    });
  });

  it("start folder: home itself, above home or a filesystem root = warning only; a project below home = ignored", () => {
    write(policyText());
    const home = path.join(root, "home");
    // $HOME as start folder (settings at ~/.config/perfoads-mcp): used, with a warning note.
    const atHome = source({ cwd: home }).current();
    expect(atHome.status).toBe("valid");
    expect(atHome.note).toMatch(/inside .*your home folder or above/);
    // Above home (like /Users): warning only.
    expect(source({ cwd: root }).current()).toMatchObject({ status: "valid" });
    expect(source({ cwd: root }).current().note).toMatch(/home folder or above/);
    // A filesystem root: nothing.
    const fsRoot = source({ cwd: path.parse(root).root }).current();
    expect(fsRoot.status).toBe("valid");
    expect(fsRoot.note).toBeUndefined();
    // Settings folder not inside the start folder: nothing.
    expect(source({ cwd: path.join(home, "project") }).current().note).toBeUndefined();
  });

  it("PERFOADS_MCP_HOME inside a repo below home: ignored by the server; the CLI only notes it", () => {
    const repo = path.join(root, "home", "code", "repo");
    const dir = path.join(repo, ".perfoads");
    mkdirSync(dir, { recursive: true });
    write(policyText(), dir);
    const server = source({ cwd: repo, dir }).current();
    expect(server).toMatchObject({ status: "ignored" });
    if (server.status === "ignored")
      expect(server.reason).toMatch(/project folder the server was started in/);
    const policy = createFilePolicy(source({ cwd: repo, dir }));
    expect(policy.gate(A, "update_budget").reason).toMatch(
      /Writes are off: the policy file is inside the project folder/,
    );
    const cli = source({ cwd: repo, dir, mode: "cli" }).current();
    expect(cli.status).toBe("valid");
    expect(cli.note).toBe(
      `It would be ignored if your AI app works in ${repo} (the settings folder is inside it).`,
    );
  });

  it("a workspace root that holds the settings folder: always ignored (also for the CLI view)", () => {
    write(policyText());
    expect(source({ roots: [path.join(root, "home", ".config")] }).current()).toMatchObject({
      status: "ignored",
    });
    expect(
      createFilePolicy(source({ roots: [path.join(root, "home")] })).gate(A, "update_budget")
        .reason,
    ).toMatch(/inside a workspace folder your AI app shares/);
  });

  it("Windows paths: case-insensitive, strictly below home", () => {
    const home = "C:\\Users\\Me";
    const file = "c:\\users\\me\\Code\\Repo\\.perfoads\\policy.yaml";
    expect(isBelowHome("C:\\USERS\\ME\\code\\repo", home, "win32")).toBe(true);
    expect(isBelowHome("c:\\users\\me", home, "win32")).toBe(false);
    expect(isBelowHome("C:\\Users", home, "win32")).toBe(false);
    expect(startFolderVerdict(file, "C:\\Users\\ME\\code\\repo", home, "win32")).toBe("ignore");
    expect(startFolderVerdict(file, "C:\\users\\me", home, "win32")).toBe("warn");
    expect(startFolderVerdict(file, "C:\\", home, "win32")).toBe("none");
    expect(startFolderVerdict(file, "D:\\work", home, "win32")).toBe("none");
  });

  it("a policy file with a second hard link is ignored", () => {
    write(policyText());
    const other = path.join(root, "elsewhere.yaml");
    linkSync(policyPath(configDir), other);
    const s = source().current();
    expect(s).toMatchObject({ status: "ignored" });
    if (s.status === "ignored") expect(s.reason).toMatch(/more than one hard link/);
  });

  it("CLI mode logs only a valid load (actor cli), never ignored / invalid / none", () => {
    source({ mode: "cli" }).current();
    write(`${policyText()}oops: 1\n`);
    source({ mode: "cli" }).current();
    write(policyText());
    source({ mode: "cli" }).current();
    const events = policyEvents(store);
    expect(events.map((e) => [e.actor, e.data.status])).toEqual([["cli", "valid"]]);
  });

  it("a policy symlinked into a project folder is ignored", () => {
    const project = path.join(root, "home", "project");
    mkdirSync(project, { recursive: true });
    write(policyText(), project);
    symlinkSync(path.join(project, "policy.yaml"), policyPath(configDir));
    expect(source({ cwd: project }).current()).toMatchObject({ status: "ignored" });
  });

  it("finds an earlier version by hash in the store (another process, after a restart)", () => {
    write(policyText({ pct: 10 }));
    const first = source().current();
    const other = openStore(storePath(configDir));
    try {
      const later = source({ s: other });
      write(policyText({ pct: 50 }));
      later.current();
      expect(
        first.status === "valid" && later.byHash(first.hash)?.limits.max_budget_change_pct,
      ).toBe(10);
    } finally {
      other.close();
    }
  });
});

describe("file policy: stricter of two versions", () => {
  it("proposed under a strict policy, applied under a looser one: the strict one still refuses", () => {
    const src = source();
    const policy = createFilePolicy(src);
    write(policyText({ pct: 10 }));
    const strict = policy.check(req({ stage: "propose" }));
    expect(strict.allowed).toBe(false);
    // Even a change that passed the strict one at propose ...
    const small = req({
      stage: "propose",
      facts: {
        budgetChanges: [
          { budgetId: "222", beforeMicros: "100000000", afterMicros: "105000000", shared: false },
        ],
        affectedCampaignIds: [],
      },
    });
    const proposed = policy.check(small);
    expect(proposed.allowed).toBe(true);
    // ... a bigger one proposed under 10 % is refused at apply although 50 % now allows it.
    write(policyText({ pct: 50 }));
    const r = policy.check(req({ stage: "claim", proposedUnder: strict.hash ?? null }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/stricter of the two versions applies.*at most 10%/);
    // Proposed under the loose one, applied under a stricter one: the new one refuses.
    const loose = policy.check(req({ stage: "propose" }));
    expect(loose.allowed).toBe(true);
    write(policyText({ pct: 10 }));
    expect(policy.check(req({ stage: "claim", proposedUnder: loose.hash ?? null })).allowed).toBe(
      false,
    );
  });

  it("the stricter tier wins, and an unknown earlier version refuses", () => {
    const policy = createFilePolicy(source());
    write(`${policyText()}tiers: { update_budget: confirm }\n`);
    const down = {
      budgetChanges: [
        { budgetId: "222", beforeMicros: "100000000", afterMicros: "90000000", shared: false },
      ],
      affectedCampaignIds: [],
    };
    const was = policy.check(req({ stage: "propose", facts: down }));
    expect(was.tier).toBe("confirm");
    write(`${policyText()}tiers: { update_budget: auto }\n`);
    expect(policy.check(req({ stage: "propose", facts: down })).tier).toBe("auto");
    expect(
      policy.check(req({ stage: "approve", facts: down, proposedUnder: was.hash ?? null })).tier,
    ).toBe("confirm");
    expect(
      policy.check(req({ stage: "claim", facts: down, proposedUnder: "f".repeat(64) })).reason,
    ).toMatch(/earlier version is not known/);
  });

  it("no file: the read-only message; reads allowed everywhere; with a file only allow + write", () => {
    const policy = createFilePolicy(source());
    expect(policy.gate(A, "update_budget").reason).toBe(NO_POLICY_REASON);
    expect(policy.readAllowed("9876543210")).toBe(true);
    write(policyText({ write: "" }));
    expect(policy.readAllowed(A)).toBe(true);
    expect(policy.readAllowed("9876543210")).toBe(false);
    expect(policy.liveWrites(A)).toBe(false);
    write(policyText());
    expect(policy.liveWrites(A)).toBe(true);
    write(policyText({ kill: true }));
    expect(policy.liveWrites(A)).toBe(false);
  });

  it("an invalid file never widens reads: last valid allowlist, or nothing at all (kil_switch typo)", () => {
    const typo = policyText().replace("kill_switch: false", "kil_switch: false");
    // Never valid: nothing is read, with a plain message.
    write(typo);
    const fresh = createFilePolicy(source());
    expect(fresh.readDenial(A)).toMatch(
      /^Your policy file has an error: the file: unknown key kil_switch; fix it with `perfoads-mcp policy check`/,
    );
    expect(fresh.gate(A, "update_budget").allowed).toBe(false);
    // Valid once (allow A only), then broken: A still readable, others not, no writes.
    write(policyText());
    const policy = createFilePolicy(source());
    expect(policy.readAllowed(A)).toBe(true);
    write(typo);
    expect(policy.readAllowed(A)).toBe(true);
    expect(policy.readDenial("9876543210")).toMatch(/only the accounts of its last valid version/);
    expect(policy.gate(A, "update_budget").allowed).toBe(false);
    expect(policy.liveWrites(A)).toBe(false);
    // Another process (or a restart) finds the last valid version in the store.
    expect(createFilePolicy(source()).readDenial("9876543210")).toMatch(/last valid version/);
    // No file at all: reads everywhere, writes nowhere.
    rmSync(policyPath(configDir));
    expect(policy.readAllowed("9876543210")).toBe(true);
  });

  it("an ignored file that was never valid still narrows reads to its own allowlist (never widens)", () => {
    write(policyText()); // allow A only
    const inRoot = createFilePolicy(source({ roots: [path.join(root, "home")] }));
    expect(inRoot.state().status).toBe("ignored");
    expect(inRoot.readAllowed(A)).toBe(true);
    expect(inRoot.readDenial("9876543210")).toMatch(/reads stay limited to the accounts it/);
    expect(inRoot.gate(A, "update_budget").allowed).toBe(false);
    // An ignored file that does not parse narrows nothing (as no file).
    write("version: [");
    expect(inRoot.readAllowed("9876543210")).toBe(true);
  });

  it("undo reads may use the whole reserve; other reads none of it", () => {
    write(policyText());
    const policy = createFilePolicy(source());
    // 2,880 a day, 576 kept: reads up to 2,304, undo reads up to the full 2,880.
    expect(policy.readRefusal(2_304, 1, 2_880)).toMatch(/kept for approved changes/);
    expect(policy.readRefusal(2_304, 1, 2_880, "undo")).toBeUndefined();
    expect(policy.readRefusal(2_879, 1, 2_880, "undo")).toBeUndefined();
    expect(policy.readRefusal(2_880, 1, 2_880, "undo")).toMatch(/kept for approved changes/);
  });

  it("proposal limits: per minute, then per day, with plain messages", () => {
    write(
      `${policyText()}`.replace(
        "limits: {",
        "limits: { proposals_per_minute: 3, proposals_per_day: 5,",
      ),
    );
    const policy = createFilePolicy(source());
    expect(policy.proposalDenial({ minute: 2, day: 2 })).toBeUndefined();
    expect(policy.proposalDenial({ minute: 3, day: 3 })).toMatch(/allows 3 a minute/);
    expect(policy.proposals?.(A, { kind: "propose", minute: 0, day: 5 })).toMatchObject({
      allowed: false,
      rule: "limits.proposals_per_day",
    });
  });

  it("ops reserve: reads stop before the share kept for changes", () => {
    const policy = createFilePolicy(source());
    expect(policy.readRefusal(2_870, 1, 2_880)).toBeUndefined(); // no policy: no reserve
    write(policyText());
    // 20 % of 2,880 kept: reads may use 2,304.
    expect(policy.readRefusal(2_303, 1, 2_880)).toBeUndefined();
    expect(policy.readRefusal(2_304, 1, 2_880)).toMatch(
      /last 576 of the 2880 Google Ads operations a day are kept for approved changes \(.*\), and by our own count of the last 24 hours 2304 are already used/,
    );
    expect(policy.readRefusal(1_000_000, 1, null)).toBeUndefined();
    // Test accounts: the same 20 % of their own 15,000 a day, named in the refusal.
    expect(policy.readRefusal(11_999, 1, 15_000, "read", "test")).toBeUndefined();
    expect(policy.readRefusal(12_000, 1, 15_000, "read", "test")).toMatch(
      /last 3000 of the 15000 Google Ads operations a day on test accounts are kept/,
    );
    expect(policy.readRefusal(2_304, 1, 2_880, "read", "production")).toMatch(/on live accounts/);
  });
});
