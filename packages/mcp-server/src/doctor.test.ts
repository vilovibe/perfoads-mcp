// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DAILY_OPS_LIMITS, type AccessLevel } from "@perfoads/ads-client";
import { errorBody } from "@perfoads/ads-client/testing";
import {
  getDataKey,
  howToRun,
  keyFilePath,
  saveCredential,
  storePath,
  type CommandRunner,
} from "@perfoads/store";
import { holdStoreLock } from "@perfoads/store/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkAccessLevel,
  checkApprovalMode,
  checkMerchantCenter,
  checkApprovalPage,
  checkBrowserControl,
  checkClaudeHooks,
  checkElicitation,
  checkOpener,
  findBrowserControl,
  checkConfigDir,
  checkNode,
  checkOAuthMode,
  checkOps,
  checkRetention,
  findAutoAnswerHooks,
  formatDoctor,
  runDoctor,
  type DoctorCheck,
} from "./doctor.js";
import {
  envCredentials,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_REFRESH_TOKEN,
  googleRouter,
  testRuntime,
} from "./testing/fakes.js";
import { readRetentionDays } from "./runtime.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  // Newest first: a later runtime can keep its store inside an earlier one's temp folder,
  // and Windows cannot delete that folder until the store is closed (EBUSY).
  // Every cleanup runs even if one throws; the first error is reported.
  const errors: unknown[] = [];
  for (const c of cleanups.splice(0).reverse()) {
    try {
      c();
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) throw errors[0];
});
const runtime = (options: Parameters<typeof testRuntime>[0] = {}) => {
  const t = testRuntime(options);
  cleanups.push(t.cleanup);
  return t;
};
const byId = (checks: DoctorCheck[], id: string) => checks.find((c) => c.id === id);
const noFiles = { readFile: () => undefined };

describe("single checks", () => {
  it("node: ok from 22.13, fail below", () => {
    expect(checkNode("22.13.0").status).toBe("ok");
    expect(checkNode("26.1.0").status).toBe("ok");
    const old = checkNode("22.12.9");
    expect(old.status).toBe("fail");
    expect(old.fix).toMatch(/22\.13/);
  });

  it("config dir: warn inside the start folder or a client root, ok outside, root folder ignored", () => {
    expect(
      checkConfigDir("/p/proj/.cfg", "PERFOADS_MCP_HOME", "/p/proj", undefined, "linux").status,
    ).toBe("warn");
    expect(
      checkConfigDir("/home/u/.config/perfoads-mcp", "default", "/p/proj", ["/home/u"], "linux")
        .status,
    ).toBe("warn");
    const ok = checkConfigDir(
      "/home/u/.config/perfoads-mcp",
      "default",
      "/p/proj",
      ["/p/proj"],
      "linux",
    );
    expect(ok.status).toBe("ok");
    expect(
      checkConfigDir("/home/u/.config/perfoads-mcp", "default", "/", undefined, "linux").status,
    ).toBe("ok");
  });

  it("config dir on Windows: ok inside %APPDATA%, warn outside it or without it", () => {
    const appData = "C:\\Users\\u\\AppData\\Roaming";
    const inside = "C:\\Users\\u\\AppData\\Roaming\\perfoads-mcp";
    expect(checkConfigDir(inside, "APPDATA", "C:\\p", undefined, "win32", appData).status).toBe(
      "ok",
    );
    const outside = checkConfigDir(
      "D:\\shared\\pm",
      "PERFOADS_MCP_HOME",
      "C:\\p",
      undefined,
      "win32",
      appData,
    );
    expect(outside.status).toBe("warn");
    expect(outside.detail).toMatch(/outside your %APPDATA% folder/);
    expect(outside.fix).toMatch(/inside %APPDATA%/);
    // Paths and setting names stay out of the plain lines.
    expect(`${outside.detail} ${outside.fix}`).not.toMatch(/D:\\shared|PERFOADS_MCP_HOME/);
    expect(outside.details).toMatch(/D:\\shared\\pm .*PERFOADS_MCP_HOME/);
    expect(checkConfigDir(inside, "APPDATA", "C:\\p", undefined, "win32").status).toBe("warn");
    // Other OSes: no %APPDATA% rule.
    expect(
      checkConfigDir("/home/u/.config/perfoads-mcp", "default", "/p", undefined, "linux").status,
    ).toBe("ok");
  });

  it("retention_days: default 180, 30..3650, out of range clamped and reported", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "perfoads-ret-"));
    try {
      const read = (body?: string) => {
        if (body !== undefined) writeFileSync(path.join(dir, "config.json"), body);
        return readRetentionDays(dir);
      };
      expect(read()).toEqual({ days: 180, problem: undefined });
      expect(read('{"approval_mode":"auto"}')).toEqual({ days: 180, problem: undefined });
      expect(read('{"retention_days": 365}')).toEqual({ days: 365, problem: undefined });
      expect(read('{"retention_days": 7}')).toMatchObject({ days: 30, problem: /30 to 3650/ });
      expect(read('{"retention_days": 99999}')).toMatchObject({ days: 3650 });
      expect(read('{"retention_days": "90"}')).toMatchObject({ days: 180, problem: /whole/ });
      expect(checkRetention({ days: 180, problem: undefined }).status).toBe("ok");
      expect(checkRetention(read('{"retention_days": 7}')).status).toBe("warn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Merchant Center labels: optional, never a warning; says how to turn it on", () => {
    const on = checkMerchantCenter([
      "https://www.googleapis.com/auth/adwords",
      "https://www.googleapis.com/auth/content",
    ]);
    expect(on).toMatchObject({ id: "merchant_center", status: "ok" });
    const off = checkMerchantCenter(["https://www.googleapis.com/auth/adwords"]);
    expect(off.status).toBe("ok");
    expect(off.detail).toMatch(/^Off: .*tag_exclude refuses/);
    expect(off.details).toContain("auth --merchant-center");
    expect(checkMerchantCenter(undefined).status).toBe("skipped");
  });

  it("OAuth mode: production ok, Testing warns with days left, expired fails", () => {
    const now = Date.parse("2026-10-24T00:00:00Z");
    expect(checkOAuthMode(undefined, now).status).toBe("ok");
    const testing = checkOAuthMode("2026-10-27T00:00:00Z", now);
    expect(testing.status).toBe("warn");
    expect(testing.detail).toMatch(/3 days/);
    expect(testing.fix).toMatch(/Publish the sign-in app/);
    expect(testing.details).toMatch(/Publish app.*auth/);
    expect(checkOAuthMode("2026-10-23T00:00:00Z", now).status).toBe("fail");
  });

  it("access level: unknown warns, set is ok, Test-only error fails", () => {
    const unknown = checkAccessLevel({ level: "unknown", source: "default" }, undefined);
    expect(unknown.status).toBe("warn");
    expect(unknown.detail).toMatch(/2,880 operations a day on live accounts and 15,000 on test/);
    // Plain fix; the setting name and the long command only in details.
    expect(unknown.fix).not.toMatch(/PERFOADS_MCP_ACCESS_LEVEL|init/);
    expect(unknown.details).toMatch(/PERFOADS_MCP_ACCESS_LEVEL/);
    expect(unknown.details).toContain(howToRun("init"));
    const explorer = checkAccessLevel({ level: "explorer", source: "store" }, undefined);
    expect(explorer.status).toBe("ok");
    expect(explorer.detail).toMatch(/no Keyword Planner/);
    expect(explorer.detail).toMatch(/2,880 operations a day on live accounts and 15,000 on test/);
    expect(checkAccessLevel({ level: "basic", source: "store" }, undefined).detail).toMatch(
      /15,000 operations a day on live accounts and 15,000 on test/,
    );
    const testOnly = checkAccessLevel(
      { level: "explorer", source: "store" },
      { issue: "test_access_only", message: "x" },
    );
    expect(testOnly.status).toBe("fail");
    expect(testOnly.fix).toMatch(/Explorer access/);
  });

  it("access level: the numbers doctor shows are the limits the counter uses", () => {
    const fmt = (n: number) => n.toLocaleString("en-US");
    for (const level of Object.keys(DAILY_OPS_LIMITS) as AccessLevel[]) {
      const { test, production } = DAILY_OPS_LIMITS[level];
      const detail = checkAccessLevel({ level, source: "store" }, undefined).detail;
      if (test === null || production === null) {
        expect(detail, level).toMatch(/no daily limit/);
      } else if (level === "test") {
        // Test access: live accounts refuse every call, so only the test number is shown.
        expect(detail, level).toContain(`test accounts only (${fmt(test)} operations a day)`);
      } else {
        expect(detail, level).toContain(
          `${fmt(production)} operations a day on live accounts and ${fmt(test)} on test accounts`,
        );
      }
    }
  });

  it("ops: live and test accounts apart, ok, warn at 80% of either, no limit", () => {
    const fresh = { used: 0, remaining: 15_000 };
    const ok = checkOps({ used: 10, remaining: 2870 }, fresh);
    expect(ok.status).toBe("ok");
    expect(ok.detail).toBe("Live accounts: 10 used of 2,880. Test accounts: 0 used of 15,000.");
    const live = checkOps({ used: 2400, remaining: 480 }, fresh);
    expect(live.status).toBe("warn");
    expect(live.fix).toMatch(/for live accounts is used/);
    expect(live.fix).toMatch(/reads go on until Google itself says its limit is used up/);
    // with a share kept for changes, reads pause before it: never "reads still go"
    const kept = checkOps({ used: 2400, remaining: 480 }, fresh, 80, 20);
    expect(kept.fix).toMatch(
      /reads pause before the last 20% the policy keeps for approved changes/,
    );
    expect(kept.details).toMatch(
      /until our count goes down; undoing a change and approved changes can still use it/,
    );
    expect(kept.details).not.toMatch(/reads go on until Google|every 15 minutes/);
    // Many test-account operations never warn about live accounts, and the other way round.
    const test = checkOps({ used: 0, remaining: 2880 }, { used: 12_000, remaining: 3_000 });
    expect(test.status).toBe("warn");
    expect(test.fix).toMatch(/for test accounts is used/);
    // our count may pass the limit (reads still go): the limit stays the limit
    expect(checkOps({ used: 2_883, remaining: 0, limit: 2_880 }, fresh).detail).toMatch(
      /^Live accounts: 2,883 used of 2,880\./,
    );
    expect(checkOps({ used: 5, remaining: null }, { used: 0, remaining: null }).detail).toMatch(
      /Live accounts: 5 used, no daily limit/,
    );
  });

  it("ops: says when Google's stated wait for a spent limit ends", () => {
    const at = Date.parse("2026-10-26T14:05:00Z");
    const spent = checkOps(
      { used: 90, remaining: 2790, waitMs: 8 * 3_600_000 - 60_000, refillsAt: at },
      { used: 0, remaining: 15_000 },
    );
    expect(spent.status).toBe("warn");
    expect(spent.detail).toBe(
      "Live accounts: 90 used of 2,880. Test accounts: 0 used of 15,000. Google said today's request limit for live accounts is used up; it refills in about 8 hours (at 14:05 UTC).",
    );
    expect(spent.fix).toMatch(/^Nothing is sent to Google for those accounts until then/);
  });

  it("Claude hooks: finds permission/elicitation auto-answers and MCP-aimed PreToolUse hooks", () => {
    const settings = JSON.stringify({
      hooks: {
        PermissionRequest: [{ matcher: "", hooks: [{ type: "command", command: "echo allow" }] }],
        Elicitation: [{ matcher: "mcp__perfoads-mcp__.*", hooks: [] }],
        PreToolUse: [
          { matcher: "Bash", hooks: [] },
          { matcher: "mcp__.*", hooks: [] },
        ],
        PostToolUse: [{ matcher: "", hooks: [] }],
      },
    });
    const found = findAutoAnswerHooks("settings.json", settings);
    expect(found.map((f) => f.event)).toEqual(["PermissionRequest", "Elicitation", "PreToolUse"]);
    expect(findAutoAnswerHooks("x", "not json")).toEqual([]);
    expect(
      findAutoAnswerHooks(
        "x",
        JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "Bash" }] } }),
      ),
    ).toEqual([]);
  });

  it("Claude hooks check: skipped without files, ok when clean, warn when found", () => {
    expect(checkClaudeHooks(["/a"], () => undefined).status).toBe("skipped");
    expect(checkClaudeHooks(["/a"], () => "{}").status).toBe("ok");
    const warn = checkClaudeHooks(["/a"], () =>
      JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "*" }] } }),
    );
    expect(warn.status).toBe("warn");
    expect(warn.fix).toBeTruthy();
  });
});

describe("runDoctor", () => {
  it("no sign-in: credentials fail with the init fix, Google checks skipped, never throws", async () => {
    const { rt } = runtime();
    const report = await runDoctor(rt, noFiles);
    expect(report.ok).toBe(false);
    expect(byId(report.checks, "store")?.status).toBe("ok");
    const cred = byId(report.checks, "credentials");
    expect(cred).toMatchObject({ status: "fail" });
    expect(cred?.fix).toBe("Run the setup in a terminal.");
    expect(cred?.details).toContain(howToRun("init"));
    expect(byId(report.checks, "token")?.status).toBe("skipped");
    expect(byId(report.checks, "accounts")?.status).toBe("skipped");
    expect(formatDoctor(report)).toMatch(/FAIL {2}Saved Google sign-in/);
  });

  it("Windows: the owner-only ACL fails -> a stderr warning at open and a doctor FAIL with the fix", async () => {
    const failingAcl: CommandRunner = (command) =>
      /icacls\.exe$/i.test(command)
        ? { status: 5, stdout: "" }
        : { status: null, stdout: "", error: new Error("ENOENT") };
    // A win32 settings path is relative on this OS: the store opens under the process's
    // folder, so that is a temp folder here (never the repo root).
    const before = process.cwd();
    const scratch = mkdtempSync(path.join(tmpdir(), "perfoads-win32-"));
    process.chdir(scratch);
    cleanups.push(() => {
      process.chdir(before);
      rmSync(scratch, { recursive: true, force: true });
    });
    const t = runtime({
      env: { SystemRoot: "C:\\Windows" },
      runtime: { platform: "win32", run: failingAcl },
    });
    const report = await runDoctor(t.rt, noFiles);
    const acl = byId(report.checks, "owner_only");
    expect(acl?.status).toBe("fail");
    expect(acl?.detail).toMatch(/couldn't make the settings folder owner-only/i);
    expect(acl?.details).toContain(`icacls "${t.rt.configDir.dir}" /inheritance:r`);
    // the folder grant without /T, then the contents reset to inherit it
    expect(acl?.details).not.toMatch(/\(OI\)\(CI\)F" \/T/);
    expect(acl?.details).toContain(
      `icacls "${path.win32.join(t.rt.configDir.dir, "*")}" /reset /T /C`,
    );
    expect(acl?.details).toContain(howToRun("doctor"));
    expect(acl?.fix).not.toContain("icacls");
    expect(report.ok).toBe(false);
    expect(t.logLines.join("\n")).toMatch(/couldn't make the settings folder .* owner-only/);
    expect(formatDoctor(report)).toMatch(/FAIL {2}Settings folder owner-only/);

    // The ACL works: no such check.
    const ok = runtime({ env: { SystemRoot: "C:\\Windows" }, runtime: { platform: "win32" } });
    expect(byId((await runDoctor(ok.rt, noFiles)).checks, "owner_only")).toBeUndefined();
  });

  it("partial env credentials fail with a fix that names all three", async () => {
    const { rt } = runtime({ env: { PERFOADS_MCP_CLIENT_ID: FAKE_CLIENT_ID } });
    const report = await runDoctor(rt, noFiles);
    expect(byId(report.checks, "credentials")?.detail).toMatch(/Only some/);
  });

  it("env credentials: warn (weaker), token + accounts ok", async () => {
    const { rt } = runtime({ env: envCredentials });
    const report = await runDoctor(rt, noFiles);
    expect(byId(report.checks, "credentials")?.status).toBe("warn");
    expect(byId(report.checks, "token")?.status).toBe("ok");
    expect(byId(report.checks, "accounts")?.status).toBe("ok");
    expect(report.ok).toBe(true);
  });

  it("stored credentials in Testing mode: ok credentials, warn lifetime", async () => {
    const now = Date.parse("2026-10-24T00:00:00Z");
    const t = runtime({ now: () => now });
    const s = t.rt.store();
    const key = getDataKey(t.rt.keyDeps, s, { create: true });
    if (!key) throw new Error("no key");
    saveCredential(s, key.key, "oauth_client_id", FAKE_CLIENT_ID);
    saveCredential(s, key.key, "oauth_client_secret", FAKE_CLIENT_SECRET);
    saveCredential(s, key.key, "refresh_token", FAKE_REFRESH_TOKEN, "2026-10-30T00:00:00Z");
    const report = await runDoctor(t.rt, noFiles);
    const cred = byId(report.checks, "credentials");
    if (process.platform === "win32") expect(cred?.status).toBe("warn");
    else expect(cred).toMatchObject({ status: "ok" });
    expect(cred?.detail).toMatch(/key file/);
    expect(byId(report.checks, "oauth_mode")).toMatchObject({ status: "warn" });
    expect(byId(report.checks, "oauth_mode")?.detail).toMatch(/6 days/);
    if (process.platform !== "win32") {
      chmodSync(keyFilePath(t.configDir), 0o644);
      const loose = await runDoctor(t.rt, noFiles);
      expect(byId(loose.checks, "credentials")?.status).toBe("warn");
    }
  });

  it("revoked sign-in: token check fails with the auth fix, no secret in the text", async () => {
    const { rt } = runtime({
      env: envCredentials,
      router: googleRouter((call) =>
        call.url.includes("oauth2") ? { status: 400, body: { error: "invalid_grant" } } : undefined,
      ),
    });
    const report = await runDoctor(rt, noFiles);
    const token = byId(report.checks, "token");
    expect(token?.status).toBe("fail");
    expect(token?.detail).toMatch(/expired or was revoked/);
    expect(JSON.stringify(report)).not.toContain(FAKE_REFRESH_TOKEN);
    expect(byId(report.checks, "accounts")?.status).toBe("skipped");
  });

  it("daily limit spent: accounts says so with the refill time, no 'turn on the API' advice; ops shows the kept wait", async () => {
    const at = Date.parse("2026-10-26T06:00:00Z");
    const failure = errorBody(429, "RESOURCE_EXHAUSTED", [
      { type: "quotaError", value: "RESOURCE_EXHAUSTED", retryDelay: "25841s" },
    ]);
    const { rt } = runtime({
      env: envCredentials,
      now: () => at,
      router: googleRouter((call) =>
        call.url.includes("listAccessibleCustomers") ? { status: 429, body: failure } : undefined,
      ),
    });
    rt.opsCounter.limitReached?.(at + 25_841_000, "production");
    const report = await runDoctor(rt, noFiles);
    const accounts = byId(report.checks, "accounts");
    expect(accounts).toMatchObject({
      status: "warn",
      detail:
        "Google's daily request limit for this project is used up; it refills in about 8 hours (at 13:10 UTC).",
      fix: "Try again after it refills.",
    });
    expect(JSON.stringify(report.checks)).not.toMatch(/turned on/);
    expect(byId(report.checks, "ops")?.detail).toMatch(
      /request limit for live accounts is used up; it refills in about 8 hours \(at 13:10 UTC\)\.$/,
    );
  });

  it("Test-only Cloud project: accounts fail and access level fails with the Explorer fix", async () => {
    const failure = errorBody(403, "PERMISSION_DENIED", [
      { type: "authorizationError", value: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" },
    ]);
    const { rt } = runtime({
      env: envCredentials,
      router: googleRouter((call) =>
        call.url.includes("listAccessibleCustomers") ? { status: 403, body: failure } : undefined,
      ),
    });
    const report = await runDoctor(rt, noFiles);
    expect(byId(report.checks, "accounts")?.status).toBe("fail");
    expect(byId(report.checks, "access_level")).toMatchObject({ status: "fail" });
  });

  it("a store busy in another process is a warn that says so, with no move-aside fix", async () => {
    const t = runtime({ storeBusyTimeoutMs: 0 });
    t.rt.store();
    t.rt.close();
    // Lock first: creating a runtime already tries the store (access level).
    const release = holdStoreLock(storePath(t.configDir));
    try {
      // APPDATA: on Windows a settings folder outside %APPDATA% is its own (move) warning
      const busy = runtime({
        env: { PERFOADS_MCP_HOME: t.configDir, APPDATA: path.dirname(t.configDir) },
        storeBusyTimeoutMs: 0,
      });
      const report = await runDoctor(busy.rt, noFiles);
      const store = byId(report.checks, "store");
      expect(store?.status).toBe("warn");
      expect(store?.detail).toMatch(/in use by another perfoads-mcp process/);
      expect(store?.fix).toBeUndefined();
      expect(byId(report.checks, "credentials")).toMatchObject({ status: "skipped" });
      expect(byId(report.checks, "credentials")?.fix).toBeUndefined();
      expect(byId(report.checks, "access_level")).toMatchObject({ status: "skipped" });
      // A healthy store in use: no line may point at reset or moving the file.
      for (const c of report.checks) {
        expect(`${c.detail} ${c.fix ?? ""}`).not.toMatch(/reset|move|rename|aside/i);
      }
      expect(formatDoctor(report)).not.toMatch(/reset|move|rename|aside/i);
    } finally {
      release();
    }
  });

  it("warns when the settings folder is inside the start folder", async () => {
    const t = runtime();
    const inside = runtime({ env: { PERFOADS_MCP_HOME: path.join(t.cwd, "cfg") } });
    const report = await runDoctor({ ...inside.rt, cwd: t.cwd }, noFiles);
    expect(byId(report.checks, "config_dir")?.status).toBe("warn");
  });
});

describe("approval checks", () => {
  it("approval page: ok when 127.0.0.1 can be bound, fail with a fix when not", async () => {
    expect((await checkApprovalPage(async () => ({ ok: true }))).status).toBe("ok");
    const bad = await checkApprovalPage(async () => ({ ok: false, message: "EPERM" }));
    expect(bad.status).toBe("fail");
    expect(bad.detail).toMatch(/blocks the local approval page/);
    expect(bad.details).toMatch(/127\.0\.0\.1: EPERM/);
    // The real one, on this machine.
    const real = await runDoctor(runtime().rt, { readFile: () => undefined, offline: true });
    expect(real.checks.find((c) => c.id === "approval_page")?.status).toBe("ok");
  });

  it("elicitation: says how approvals work with and without forms; skipped when unknown", () => {
    expect(checkElicitation(undefined).status).toBe("skipped");
    expect(checkElicitation(true).detail).toMatch(/type the code from the approval page/);
    expect(checkElicitation(false).detail).toMatch(/click Approve/);
    expect(checkElicitation(false).details).toMatch(/approve <change_id>/);
  });

  it("the auto-answer hook warning is still there", () => {
    const c = checkClaudeHooks(["/x/settings.json"], () =>
      JSON.stringify({ hooks: { Elicitation: [{ matcher: "", hooks: [] }] } }),
    );
    expect(c.status).toBe("warn");
    expect(c.fix).toMatch(/without the code from the approval page approves nothing/);
  });

  it("warns about MCP servers that control the browser or the screen (Claude Code, Desktop, Cursor configs)", () => {
    expect(
      findBrowserControl(
        JSON.stringify({
          mcpServers: { "claude-in-chrome": {}, notes: { command: "npx", args: ["notes-mcp"] } },
          projects: {
            "/x": { mcpServers: { web: { command: "npx", args: ["@playwright/mcp"] } } },
          },
        }),
      ).sort(),
    ).toEqual(["claude-in-chrome", "web"]);
    const files = { "/h/.claude.json": JSON.stringify({ mcpServers: { "computer-use": {} } }) };
    const read = (f: string) => files[f as keyof typeof files];
    const warn = checkBrowserControl(Object.keys(files), read, true);
    expect(warn.status).toBe("warn");
    expect(warn.detail).toMatch(/could read the approval page/);
    expect(warn.fix).toMatch(/code only/);
    expect(warn.details).toMatch(/code_only/);
    expect(warn.details).toMatch(/hardened setup/);
    expect(warn.details).toMatch(/computer-use \(\/h\/\.claude\.json\)/);
    // Read-only (no account may be changed): one short info line, no warning.
    const info = checkBrowserControl(Object.keys(files), read, false);
    expect(info.status).toBe("ok");
    expect(info.detail).toBe(
      "A browser-control tool is set up here. It only matters once changes are allowed.",
    );
    expect(info.fix).toBeUndefined();
    expect(checkBrowserControl(["/none"], () => undefined, true).status).toBe("ok");
  });

  it("checks the browser opener exists at its system path", () => {
    expect(checkOpener("darwin", (f) => f === "/usr/bin/open", {}).status).toBe("ok");
    const none = checkOpener("linux", () => false, {});
    expect(none.status).toBe("warn");
    expect(none.details).toMatch(/approvals open <change_id>/);
  });

  it("shows the approval mode; a broken config file warns and falls back to code_only", () => {
    expect(checkApprovalMode({ mode: "auto", problem: undefined }).detail).toMatch(/auto/);
    const bad = checkApprovalMode({ mode: "code_only", problem: "x is not valid JSON" });
    expect(bad.status).toBe("warn");
    expect(bad.detail).toMatch(/using code_only/);
  });
});
