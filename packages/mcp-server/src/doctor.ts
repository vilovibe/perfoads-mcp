// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  GOOGLE_ADS_API_VERSION,
  type AccessIssue,
  type AccessLevel,
  type OpsPool,
  dailyLimitLine,
  dailyLimitOf,
  humanWait,
  MERCHANT_SCOPE,
} from "@perfoads/ads-client";
import { describePolicy, POLICY_FILE, type PolicyState } from "@perfoads/policy";
import {
  howToRun,
  isInside,
  keyFileMode,
  keyFilePath,
  listSavedAccounts,
  StoreBusyError,
} from "@perfoads/store";
import { canBindPage, openerCommand } from "./approvals/page.js";
import type { PluginState } from "./plugin.js";
import type { Runtime } from "./runtime.js";
import { errorText } from "./toolKit.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skipped";

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  /** What was found, in plain English for anyone. Never a secret. */
  detail: string;
  /** What to do about it, in plain English. Present for warn and fail. */
  fix?: string;
  /** Exact commands, file paths and setting names behind detail and fix. Never a secret. */
  details?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  summary: Record<CheckStatus, number>;
}

export const MIN_NODE = [22, 13] as const;

const STORE_PROBLEM = "The local store could not be opened.";
const RESET_FIX = "Move the store file aside or reset it, then run the setup again.";
const resetDetails = (): string =>
  `Rename the store file, or run \`${howToRun("reset")}\` in a terminal; then run \`${howToRun("init")}\`.`;
const CHECK_PROBLEM = "This check hit an unexpected error.";

const check = (
  id: string,
  title: string,
  status: CheckStatus,
  detail: string,
  fix?: string,
  details?: string,
): DoctorCheck => ({
  id,
  title,
  status,
  detail,
  ...(fix ? { fix } : {}),
  ...(details ? { details } : {}),
});

export const checkNode = (version: string): DoctorCheck => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const good = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return good
    ? check("node", "Node.js version", "ok", `Node.js ${version}.`)
    : check(
        "node",
        "Node.js version",
        "fail",
        `Node.js ${version} is too old.`,
        `Install Node.js ${MIN_NODE.join(".")} or later (nodejs.org).`,
      );
};

const isFilesystemRoot = (p: string, platform: NodeJS.Platform): boolean => {
  const api = platform === "win32" ? path.win32 : path.posix;
  const r = api.resolve(p);
  return api.parse(r).root === r;
};

/** The store and policy must sit outside every folder the AI agent works in. */
export const checkConfigDir = (
  configDir: string,
  source: string,
  cwd: string,
  roots: readonly string[] | undefined,
  platform: NodeJS.Platform,
  /** %APPDATA% (Windows): the settings folder should sit inside it. */
  appData?: string,
): DoctorCheck => {
  const title = "Settings folder location";
  const inside = [...(isFilesystemRoot(cwd, platform) ? [] : [cwd]), ...(roots ?? [])].filter(
    (folder) => isInside(configDir, folder, platform),
  );
  const where = `Settings folder: ${configDir}${source === "PERFOADS_MCP_HOME" ? " (set by PERFOADS_MCP_HOME)" : ""}.`;
  if (inside.length > 0) {
    return check(
      "config_dir",
      title,
      "warn",
      "Your settings and Google sign-in are inside a folder the AI works in, so the AI could read or change them.",
      "Move the settings folder outside your projects, then sign in again.",
      `${where} It is inside ${inside[0]}. Remove PERFOADS_MCP_HOME or point it to a folder outside the project, then run \`${howToRun("auth")}\`.`,
    );
  }
  const roaming = appData?.trim();
  if (platform === "win32" && (!roaming || !isInside(configDir, roaming, platform))) {
    return check(
      "config_dir",
      title,
      "warn",
      "Your settings and Google sign-in are outside your %APPDATA% folder, where other accounts or programs may reach them.",
      "Move the settings folder inside %APPDATA%, then sign in again.",
      `${where}${roaming ? ` %APPDATA% is ${roaming}.` : ""} The server makes the folder owner-only (icacls), but a folder elsewhere (another drive, a shared or synced folder) may be reached first. Remove PERFOADS_MCP_HOME or point it inside %APPDATA%, then run \`${howToRun("auth")}\`.`,
    );
  }
  return check(
    "config_dir",
    title,
    "ok",
    "Your settings and Google sign-in are kept outside the folders the AI works in.",
    undefined,
    `${where}${roots === undefined ? " The AI app did not share its folders, so only the start folder was checked." : ""}`,
  );
};

const LEVEL_LIMITS: Readonly<Record<AccessLevel, string>> = {
  test: "Test access: test accounts only (15,000 operations a day); live accounts refuse every call.",
  explorer:
    "Explorer access: 2,880 operations a day on live accounts and 15,000 on test accounts, and no Keyword Planner ideas (that needs Basic access).",
  basic: "Basic access: 15,000 operations a day on live accounts and 15,000 on test accounts.",
  standard: "Standard access: no daily limit.",
  unknown:
    "Not set, so the server assumes Explorer: 2,880 operations a day on live accounts and 15,000 on test accounts.",
};

const ISSUE_LEVEL: Partial<Record<AccessIssue, string>> = {
  test_access_only: "Test only (Google said the Cloud project is not approved for live accounts)",
  access_level_too_low: "too low for something that was asked (Google said so)",
};

export const checkAccessLevel = (
  configured: { level: AccessLevel; source: string },
  issue: { issue: AccessIssue; message: string } | undefined,
): DoctorCheck => {
  const title = "Google Ads API access level";
  const inferred = issue ? ISSUE_LEVEL[issue.issue] : undefined;
  const detail = [inferred ? `Detected: ${inferred}.` : "", LEVEL_LIMITS[configured.level]]
    .filter(Boolean)
    .join(" ");
  const setText =
    configured.level === "unknown"
      ? undefined
      : `Set to ${configured.level}${configured.source === "env" ? " by PERFOADS_MCP_ACCESS_LEVEL" : " in the local store"}.`;
  if (issue?.issue === "test_access_only") {
    return check(
      "access_level",
      title,
      "fail",
      detail,
      "Apply for Explorer access to the Google Ads API in Google Cloud. Until then only test accounts work.",
      "Google Cloud Console, the Cloud project that owns your OAuth client: Google Ads API access page.",
    );
  }
  if (configured.level === "unknown") {
    return check(
      "access_level",
      title,
      "warn",
      detail,
      "Look up your access level in Google Cloud, then run the setup again and type it in when asked.",
      `Google Cloud Console, Google Ads API access page of your project. Setup: \`${howToRun("init")}\`. Or set PERFOADS_MCP_ACCESS_LEVEL to test, explorer, basic or standard.`,
    );
  }
  return check("access_level", title, "ok", detail, undefined, setText);
};

export interface OpsUse {
  used: number;
  /** null = no daily limit. */
  remaining: number | null;
  /** The pool's daily limit (our count may pass it: reads still go); default used + remaining. */
  limit?: number | null;
  /** Google said the daily limit is used up: how long until it refills (ms). */
  waitMs?: number | null;
  /** When it refills, as Google said (epoch ms). */
  refillsAt?: number | null;
}

/** "14:05 UTC" (with the date when it is not today's in UTC). */
const refillClock = (at: number, now: number): string => {
  const iso = new Date(at).toISOString();
  const sameDay = iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  return `${sameDay ? "" : `${iso.slice(0, 10)} `}${iso.slice(11, 16)} UTC`;
};

/** Google counts live (production) accounts and test accounts apart: one line part each. */
export const checkOps = (
  live: OpsUse,
  test: OpsUse,
  warnAtPct = 80,
  reservePct = 0,
): DoctorCheck => {
  const title = "Google Ads operations today";
  const n = (x: number) => x.toLocaleString("en-US");
  const total = (u: OpsUse, left: number): number => u.limit ?? u.used + left;
  const part = (label: string, u: OpsUse): string =>
    u.remaining === null
      ? `${label}: ${n(u.used)} used, no daily limit.`
      : `${label}: ${n(u.used)} used of ${n(total(u, u.remaining))}.`;
  const high = (u: OpsUse): boolean =>
    u.remaining !== null && u.used >= (total(u, u.remaining) * warnAtPct) / 100;
  const detail = `${part("Live accounts", live)} ${part("Test accounts", test)}`;
  // with a share kept for changes, reads pause before it (our count decides, not Google)
  const readsGo =
    reservePct > 0
      ? `reads pause before the last ${reservePct}% the policy keeps for approved changes until our count goes down; undoing a change and approved changes can still use it`
      : "reads go on until Google itself says its limit is used up";
  const details = `Our own count over the last 24 hours (since Google last refilled), for every server on this computer. It is an estimate: ${readsGo}. Google counts live and test accounts separately.`;
  // Google already said the limit is spent: nothing is sent for those accounts until then
  const waits = (
    [
      ["live", live],
      ["test", test],
    ] as const
  ).filter(([, u]) => (u.waitMs ?? 0) > 0);
  if (waits.length > 0) {
    const line = waits
      .map(([label, u]) => {
        const wait = u.waitMs ?? 0;
        const at =
          u.refillsAt !== null && u.refillsAt !== undefined
            ? ` (at ${refillClock(u.refillsAt, u.refillsAt - wait)})`
            : "";
        return `Google said today's request limit for ${label} accounts is used up; it refills in about ${humanWait(wait)}${at}.`;
      })
      .join(" ");
    return check(
      "ops",
      title,
      "warn",
      `${detail} ${line}`,
      "Nothing is sent to Google for those accounts until then. Try again after it refills; a higher access level raises the limit.",
      details,
    );
  }
  const full = [high(live) ? "live" : "", high(test) ? "test" : ""].filter(Boolean).join(" and ");
  return full
    ? check(
        "ops",
        title,
        "warn",
        detail,
        `By our count, most of the allowance for ${full} accounts is used. Changes stop when our count runs out; ${readsGo}. It frees up over the next 24 hours; a higher access level raises it.`,
        details,
      )
    : check("ops", title, "ok", detail, undefined, details);
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Names a policy file might be given in a project; none of them is ever read. */
const STRAY_POLICY_NAMES = [
  POLICY_FILE,
  "perfoads-mcp.policy.yaml",
  path.join(".perfoads-mcp", POLICY_FILE),
  path.join("perfoads-mcp", POLICY_FILE),
];

/** Policy files in the folders the AI works in (ignored by the server). */
export const findStrayPolicies = (
  folders: readonly string[],
  exists: (file: string) => boolean,
): string[] =>
  [...new Set(folders)].flatMap((f) =>
    STRAY_POLICY_NAMES.map((n) => path.join(f, n)).filter((file) => exists(file)),
  );

const dashedIds = (ids: readonly string[]): string =>
  ids.map((id) => `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`).join(", ");

/** Where the policy is, whether it is valid, its hash, kill switch, writable accounts, limits. */
export const checkPolicy = (state: PolicyState, strays: readonly string[]): DoctorCheck[] => {
  const title = "Change policy";
  const out: DoctorCheck[] = [];
  if (strays.length > 0) {
    out.push(
      check(
        "policy_location",
        "Policy file in a project folder",
        "fail",
        "A policy file sits in a folder the AI works in. The server ignores it, because the AI could edit it there.",
        "Delete it and keep the policy file in the settings folder.",
        `Found: ${strays.join(", ")}. The real one is ${POLICY_FILE} in the settings folder (\`${howToRun("policy show")}\` says where).`,
      ),
    );
  }
  switch (state.status) {
    case "none":
      out.push(
        check(
          "policy",
          title,
          "ok",
          "No policy file yet, so the server only reads: nothing can be changed.",
          undefined,
          `No ${POLICY_FILE} in the settings folder.`,
        ),
      );
      break;
    case "ignored":
      out.push(
        check(
          "policy",
          title,
          "fail",
          "The policy file is ignored, so nothing can be changed and reads are limited to the accounts it last allowed.",
          "Keep the settings folder outside your projects, and keep the policy file a single file.",
          `${state.file}: ${state.reason}${state.folder ? ` (${state.folder})` : ""} Remove PERFOADS_MCP_HOME or point it outside the project.`,
        ),
      );
      break;
    case "invalid":
      out.push(
        check(
          "policy",
          title,
          "fail",
          "The policy file has mistakes, so nothing can be changed and reads are limited to the accounts it last allowed (none if it was never right).",
          "Fix the mistakes listed in the details, then check the file again.",
          `${state.file}: ${state.problems.join("; ")}. Check it with \`${howToRun("policy check")}\`.`,
        ),
      );
      break;
    case "valid": {
      const p = state.policy;
      const writable = p.accounts.write.length ? dashedIds(p.accounts.write) : "none";
      const lines = describePolicy(p).slice(3, 6).join(" ");
      out.push(
        check(
          "policy",
          title,
          p.kill_switch ? "warn" : "ok",
          `The policy file is valid. Accounts that may be changed: ${writable}. Kill switch ${p.kill_switch ? "ON: every change is refused" : "off"}.`,
          p.kill_switch
            ? "Turn the kill switch off in the policy file to allow changes again."
            : undefined,
          `${state.file}, version ${state.hash.slice(0, 12)}${state.note ? "" : ", outside the folders the AI works in"}. ${lines}${p.kill_switch ? " Set kill_switch: false to allow changes." : ""}`,
        ),
      );
    }
  }
  if (state.note) {
    out.push(
      check(
        "policy_start_folder",
        "Settings folder and the server's start folder",
        "warn",
        state.note,
        "Keep the settings folder outside every folder an AI app works in.",
        "Or use the hardened setup (server and store under a separate OS user or in a container).",
      ),
    );
  }
  return out;
};

/**
 * Writes on a live (not test) account while an AI tool can drive the browser and the
 * approval page still has a button: the page alone is not a safe approval then.
 */
export const checkWriteExposure = (
  state: PolicyState,
  testAccounts: ReadonlyMap<string, boolean>,
  mode: "auto" | "code_only",
  browserControl: boolean,
): DoctorCheck | undefined => {
  if (state.status !== "valid" || state.policy.kill_switch) return undefined;
  const live = state.policy.accounts.write.filter((id) => testAccounts.get(id) !== true);
  if (live.length === 0 || mode === "code_only" || !browserControl) return undefined;
  return check(
    "policy_exposure",
    "Changes on live accounts with browser control",
    "warn",
    "Changes are allowed on live accounts and an AI tool here can control your browser, so it could press Approve for you.",
    "Switch approvals to code only, so every change needs a code you type.",
    `Accounts: ${dashedIds(live)} (not known to be test accounts); approval_mode is auto. Set {"approval_mode": "code_only"} in config.json in the settings folder, and use the hardened setup (separate OS user or container).`,
  );
};

/** Merchant Center access (opt-in): what tag_exclude needs to label products. */
export const checkMerchantCenter = (scopes: readonly string[] | undefined): DoctorCheck => {
  const title = "Merchant Center labels (optional)";
  const how = `To turn it on, run \`${howToRun("auth --merchant-center")}\` and tick the Merchant Center box on Google's screen.`;
  if (scopes === undefined) {
    return check(
      "merchant_center",
      title,
      "skipped",
      "Google did not say which permissions this sign-in has.",
      undefined,
      how,
    );
  }
  if (scopes.includes(MERCHANT_SCOPE)) {
    return check(
      "merchant_center",
      title,
      "ok",
      "This sign-in may read and label products in Merchant Center (used by tag_exclude).",
    );
  }
  return check(
    "merchant_center",
    title,
    "ok",
    "Off: this sign-in can't label products in Merchant Center, so tag_exclude refuses. Everything else works.",
    undefined,
    how,
  );
};

export const checkOAuthMode = (expiresAt: string | undefined, nowMs: number): DoctorCheck => {
  const title = "Google sign-in lifetime";
  if (!expiresAt) {
    return check(
      "oauth_mode",
      title,
      "ok",
      "Your Google sign-in does not expire on a timer (the sign-in app is published).",
    );
  }
  const left = Date.parse(expiresAt) - nowMs;
  const publish = "Publish the sign-in app in Google Cloud, then sign in again.";
  const how = `Google Cloud Console > Google Auth Platform > Audience > Publish app, then run \`${howToRun("auth")}\`.`;
  if (Number.isNaN(left) || left <= 0) {
    return check(
      "oauth_mode",
      title,
      "fail",
      "Your Google sign-in has expired, because the sign-in app is still in Testing mode.",
      publish,
      how,
    );
  }
  const days = Math.ceil(left / DAY_MS);
  return check(
    "oauth_mode",
    title,
    "warn",
    `Your Google sign-in stops working in ${days} day${days === 1 ? "" : "s"}, because the sign-in app is still in Testing mode (Google allows 7 days).`,
    publish,
    how,
  );
};

export interface HookFinding {
  file: string;
  event: string;
  matcher: string;
}

const SERVER_TOOL = "mcp__perfoads-mcp__doctor";

const matcherHitsUs = (matcher: string, emptyMeansAll: boolean): boolean => {
  const m = matcher.trim();
  if (m === "" || m === "*") return emptyMeansAll;
  if (/perfoads/i.test(m)) return true;
  try {
    return new RegExp(m).test(SERVER_TOOL);
  } catch {
    return false;
  }
};

/**
 * Claude Code hooks can answer permission prompts and elicitation dialogs on their own.
 * A hook like that can say "yes" for the human. Best effort, read-only.
 */
export const findAutoAnswerHooks = (file: string, text: string): HookFinding[] => {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return [];
  }
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  const findings: HookFinding[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    const answersDialogs = /elicit|permission/i.test(event);
    const preTool = event === "PreToolUse";
    if (!answersDialogs && !preTool) continue;
    for (const group of Array.isArray(groups) ? groups : []) {
      const matcher = typeof group?.matcher === "string" ? group.matcher : "";
      // PreToolUse hooks are common (formatters, linters): only flag ones aimed at MCP tools.
      const hit = answersDialogs
        ? matcherHitsUs(matcher, true)
        : /mcp__/.test(matcher) && matcherHitsUs(matcher, false);
      if (hit) findings.push({ file, event, matcher: matcher || "(all)" });
    }
  }
  return findings;
};

export const claudeSettingsFiles = (home: string, cwd: string): string[] => [
  path.join(home, ".claude", "settings.json"),
  path.join(cwd, ".claude", "settings.json"),
  path.join(cwd, ".claude", "settings.local.json"),
];

export const checkClaudeHooks = (
  files: readonly string[],
  read: (file: string) => string | undefined,
): DoctorCheck => {
  const title = "Claude Code auto-answer hooks";
  const found = files.map((f) => ({ f, text: read(f) })).filter((x) => x.text !== undefined);
  if (found.length === 0) {
    return check("claude_hooks", title, "skipped", "No Claude Code settings files found.");
  }
  const findings = found.flatMap(({ f, text }) => findAutoAnswerHooks(f, text ?? ""));
  if (findings.length === 0) {
    return check(
      "claude_hooks",
      title,
      "ok",
      "No hooks that could answer prompts for this server.",
    );
  }
  const list = findings.map((h) => `${h.event} (${h.matcher}) in ${h.file}`).join("; ");
  return check(
    "claude_hooks",
    title,
    "warn",
    "Some Claude Code hooks could answer this server's questions on their own.",
    "Remove those hooks or narrow them so they skip this server. An answer without the code from the approval page approves nothing.",
    `Hooks: ${list}. Narrow their matcher so it skips perfoads tools.`,
  );
};

const readIfExists = (file: string): string | undefined => {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
};

export interface DoctorOptions {
  /** Workspace folders the MCP client shared (roots), if it shares them. */
  roots?: readonly string[] | undefined;
  nodeVersion?: string;
  readFile?: (file: string) => string | undefined;
  /** Skip calls to Google (offline check). */
  offline?: boolean;
  /** Whether the connected AI app declared elicitation (forms); undefined = not known (CLI). */
  elicitation?: boolean | undefined;
  /** Test seam for the approval page bind check. */
  canBindPage?: typeof canBindPage;
  /** Test seam: does this file exist (opener check). */
  fileExists?: (file: string) => boolean;
}

/** MCP servers that can drive a browser or the screen (best-effort name match). */
const BROWSER_CONTROL = /claude-in-chrome|playwright|puppeteer|computer[-_ ]?use|browser/i;

export const mcpConfigFiles = (
  home: string,
  cwd: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string[] => [
  path.join(home, ".claude.json"),
  path.join(cwd, ".mcp.json"),
  path.join(home, ".cursor", "mcp.json"),
  path.join(cwd, ".cursor", "mcp.json"),
  platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : platform === "win32"
      ? path.join(
          env.APPDATA ?? path.join(home, "AppData", "Roaming"),
          "Claude",
          "claude_desktop_config.json",
        )
      : path.join(home, ".config", "Claude", "claude_desktop_config.json"),
];

/** Names of configured MCP servers (any depth of "mcpServers") that look like browser control. */
export const findBrowserControl = (text: string): string[] => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const found = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || typeof v !== "object" || v === null) return;
    for (const [k, child] of Object.entries(v)) {
      if (k === "mcpServers" && typeof child === "object" && child !== null) {
        for (const [name, def] of Object.entries(child)) {
          if (BROWSER_CONTROL.test(name) || BROWSER_CONTROL.test(JSON.stringify(def ?? ""))) {
            found.add(name.slice(0, 60));
          }
        }
      } else walk(child, depth + 1);
    }
  };
  walk(json, 0);
  return [...found];
};

/**
 * Browser-control tools only matter once changes are allowed (writesOn: the policy lets at
 * least one account be changed). While read-only, a found tool is a short info line.
 */
export const checkBrowserControl = (
  files: readonly string[],
  read: (file: string) => string | undefined,
  writesOn: boolean,
): DoctorCheck => {
  const title = "AI tools that control your browser";
  const hits = files.flatMap((f) => {
    const text = read(f);
    return text === undefined ? [] : findBrowserControl(text).map((n) => `${n} (${f})`);
  });
  if (hits.length === 0) {
    return check(
      "browser_control",
      title,
      "ok",
      "No AI tools that control your browser were found (best-effort check).",
    );
  }
  const found = `Found: ${hits.join("; ")}.`;
  if (!writesOn) {
    return check(
      "browser_control",
      title,
      "ok",
      "A browser-control tool is set up here. It only matters once changes are allowed.",
      undefined,
      found,
    );
  }
  return check(
    "browser_control",
    title,
    "warn",
    "An AI tool on this computer can control your browser, so it could read the approval page.",
    "Switch approvals to code only. For full safety, run the server as a separate user.",
    `${found} Set {"approval_mode": "code_only"} in config.json in the settings folder, and use the hardened setup (server + store under a separate OS user or in a container).`,
  );
};

export const checkOpener = (
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
  env: Readonly<Record<string, string | undefined>>,
): DoctorCheck => {
  const title = "Browser opener";
  const opener = openerCommand(platform, exists, env);
  return opener
    ? check(
        "opener",
        title,
        "ok",
        "Approval pages open in your browser by themselves.",
        undefined,
        `Opener: ${opener.command}.`,
      )
    : check(
        "opener",
        title,
        "warn",
        "Approval pages can't open in your browser by themselves on this computer.",
        "Open a change's approval page yourself from a terminal.",
        `Command: \`${howToRun("approvals open <change_id>")}\`.`,
      );
};

export const checkApprovalMode = (settings: {
  mode: "auto" | "code_only";
  openBrowser?: boolean;
  problem: string | undefined;
}): DoctorCheck => {
  const noBrowser = settings.openBrowser === false;
  const opener = noBrowser
    ? "open_browser false: run `approvals open <change_id>` in a terminal as the user the server runs as."
    : "";
  const title = "Approval mode";
  if (settings.problem) {
    return check(
      "approval_mode",
      title,
      "warn",
      `The settings file has a mistake, so the server is using ${settings.mode}${noBrowser ? " and never opens a browser" : ""} (the stricter setting).`,
      "Fix the settings file (example in the details).",
      `${settings.problem}. Example config.json: {"approval_mode": "code_only", "open_browser": false}. ${opener}`.trim(),
    );
  }
  return check(
    "approval_mode",
    title,
    "ok",
    (settings.mode === "code_only"
      ? "code_only: you approve a change only by typing the code from its approval page."
      : "auto: you type the code from the approval page; apps that can't show a form get an Approve button instead.") +
      (noBrowser ? " The server never opens a browser: open approval pages yourself." : ""),
    undefined,
    opener || undefined,
  );
};

export const checkRetention = (settings: {
  days: number;
  problem: string | undefined;
}): DoctorCheck => {
  const title = "Data retention";
  const what = `Finished changes older than ${settings.days} days are deleted when the server starts. Unfinished changes always stay.`;
  const more =
    "Also approval sessions, unused policy versions and the oldest audit events; the audit log keeps a checkpoint, so it still verifies.";
  return settings.problem
    ? check(
        "retention",
        title,
        "warn",
        `The settings file has a mistake in how long to keep records. ${what}`,
        "Fix the settings file (example in the details).",
        `${settings.problem}. Example config.json: {"retention_days": 180} (30 to 3650). ${more}`,
      )
    : check("retention", title, "ok", what, undefined, more);
};

/** The optional plugin config.json names (pro_plugin): loaded, not configured, or why it failed. */
export const checkPlugin = (state: PluginState): DoctorCheck => {
  const title = "Pro plugin";
  if (state.status === "loaded")
    return check("pro_plugin", title, "ok", `loaded ${state.plugin.name} ${state.plugin.version}`);
  if (state.status === "not_configured") return check("pro_plugin", title, "ok", "not configured");
  return check(
    "pro_plugin",
    title,
    "warn",
    "The pro plugin didn't load. The server runs without it.",
    "Fix the plugin setting in the settings file, or remove it; then restart the server.",
    `${state.reason}. "pro_plugin" in config.json must be an absolute path to the built plugin package.`,
  );
};

export const checkApprovalPage = async (bind: typeof canBindPage): Promise<DoctorCheck> => {
  const title = "Local approval page";
  const r = await bind();
  return r.ok
    ? check("approval_page", title, "ok", "The approval page can be served on 127.0.0.1.")
    : check(
        "approval_page",
        title,
        "fail",
        "This computer blocks the local approval page, so changes can't be approved.",
        "Allow local connections (firewall or sandbox settings), then run the check again.",
        `Couldn't open a local port on 127.0.0.1: ${r.message}.`,
      );
};

export const checkElicitation = (
  supported: boolean | undefined,
  mode: "auto" | "code_only" = "auto",
): DoctorCheck => {
  const title = "Approval form in the AI app";
  if (supported === undefined) {
    return check(
      "elicitation",
      title,
      "skipped",
      "Not known here; the AI app tells the server when it connects.",
    );
  }
  return supported
    ? check(
        "elicitation",
        title,
        "ok",
        "This AI app can show a form: you type the code from the approval page there (the page has no Approve button for it).",
      )
    : check(
        "elicitation",
        title,
        "ok",
        mode === "code_only"
          ? "This AI app can't show forms: type the code from the approval page in a terminal, then ask the AI to apply the change again."
          : "This AI app can't show forms: click Approve on the approval page in your browser, then ask the AI to apply the change again.",
        undefined,
        `Terminal: \`${howToRun("approve <change_id>")}\`; then the AI calls apply_change again.`,
      );
};

/** Every doctor check, in order. Never throws; each failure becomes a "fail" line with a fix. */
export const runDoctor = async (
  rt: Runtime,
  options: DoctorOptions = {},
): Promise<DoctorReport> => {
  const checks: DoctorCheck[] = [];
  const read = options.readFile ?? readIfExists;

  checks.push(checkNode(options.nodeVersion ?? process.versions.node));
  checks.push(
    checkConfigDir(
      rt.configDir.dir,
      rt.configDir.source,
      rt.cwd,
      options.roots,
      rt.platform,
      rt.env.APPDATA,
    ),
  );

  let storeOk = false;
  let storeBusy = false;
  try {
    const s = rt.store();
    storeOk = true;
    checks.push(
      check(
        "store",
        "Local store",
        "ok",
        "The local store opened.",
        undefined,
        `Schema version ${s.schemaVersion()}, ${s.journalMode().toUpperCase()} mode.`,
      ),
    );
    if (!s.ownerOnly) {
      checks.push(
        check(
          "owner_only",
          "Settings folder owner-only",
          "fail",
          "Couldn't make the settings folder owner-only, so other accounts on this computer may be able to read your saved sign-in.",
          "Run the command in the details in a terminal, then run the check again. If it still fails, move the settings folder inside %APPDATA%.",
          `Windows refused the access change (icacls) on ${rt.configDir.dir}. In a terminal run: icacls "${rt.configDir.dir}" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" and then icacls "${path.win32.join(rt.configDir.dir, "*")}" /reset /T /C (never /T on the first one: it locks you out of the files inside) - then run \`${howToRun("doctor")}\` again. To move the folder, remove PERFOADS_MCP_HOME.`,
        ),
      );
    }
  } catch (err) {
    // Busy is a healthy store locked by another process: never suggest moving it aside.
    storeBusy = err instanceof StoreBusyError;
    checks.push(
      err instanceof StoreBusyError
        ? check("store", "Local store", "warn", errorText(err, rt.secrets(), STORE_PROBLEM))
        : check(
            "store",
            "Local store",
            "fail",
            errorText(err, rt.secrets(), STORE_PROBLEM),
            RESET_FIX,
            resetDetails(),
          ),
    );
  }

  const cred = rt.credentials();
  if (cred.status === "ready") {
    if (cred.source === "env") {
      checks.push(
        check(
          "credentials",
          "Saved Google sign-in",
          "warn",
          "Your Google sign-in is read from the AI app's config file, where it sits in plain text.",
          "Run the setup to save it encrypted, then remove it from the AI app's config.",
          `Variables: PERFOADS_MCP_CLIENT_ID, PERFOADS_MCP_CLIENT_SECRET, PERFOADS_MCP_REFRESH_TOKEN. Setup: \`${howToRun("init")}\`.`,
        ),
      );
    } else {
      const weakFile = cred.keyBackend === "file";
      const mode = weakFile ? keyFileMode(rt.configDir.dir, rt.platform) : undefined;
      const looseMode = mode !== undefined && (mode & 0o077) !== 0;
      const detail = `Saved and encrypted. The encryption key is in ${weakFile ? "a key file in the settings folder" : (cred.keyLocation ?? "an unknown place")}.`;
      const keyDetails = weakFile ? `Key file: ${keyFilePath(rt.configDir.dir)}.` : undefined;
      if (looseMode) {
        checks.push(
          check(
            "credentials",
            "Saved Google sign-in",
            "warn",
            `${detail} Other users on this computer can read the key file.`,
            "Make the key file readable by you only (command in the details).",
            `Run: chmod 600 "${keyFilePath(rt.configDir.dir)}"`,
          ),
        );
      } else if (weakFile && rt.platform === "win32") {
        checks.push(
          check(
            "credentials",
            "Saved Google sign-in",
            "warn",
            `${detail} On Windows the key file is protected by folder permissions only, which is weaker than a keychain.`,
            "Keep this Windows account to yourself, or run the server as a separate user.",
            keyDetails,
          ),
        );
      } else {
        checks.push(
          check("credentials", "Saved Google sign-in", "ok", detail, undefined, keyDetails),
        );
      }
    }
  } else if (storeBusy) {
    checks.push(
      check(
        "credentials",
        "Saved Google sign-in",
        "skipped",
        "Couldn't read the saved sign-in because the store is in use by another process.",
      ),
    );
  } else if (cred.status === "error") {
    checks.push(
      check(
        "credentials",
        "Saved Google sign-in",
        "fail",
        cred.message,
        storeOk
          ? "Sign in again from a terminal: it offers to delete the unreadable sign-in and start fresh."
          : RESET_FIX,
        storeOk ? `Run \`${howToRun("auth")}\` (or \`${howToRun("reset")}\`).` : resetDetails(),
      ),
    );
  } else {
    checks.push(
      check(
        "credentials",
        "Saved Google sign-in",
        "fail",
        cred.partialEnv
          ? "Only some of the three Google sign-in settings are in the AI app's config."
          : storeOk
            ? "No Google sign-in is saved yet."
            : "The sign-in could not be read because the local store did not open.",
        cred.partialEnv
          ? "Add the missing ones, or remove all three and run the setup."
          : "Run the setup in a terminal.",
        cred.partialEnv
          ? `Variables: PERFOADS_MCP_CLIENT_ID, PERFOADS_MCP_CLIENT_SECRET, PERFOADS_MCP_REFRESH_TOKEN. Setup: \`${howToRun("init")}\`.`
          : `Setup: \`${howToRun("init")}\`.`,
      ),
    );
  }

  const ready = cred.status === "ready";
  checks.push(
    ready
      ? cred.source === "env"
        ? check(
            "oauth_mode",
            "Google sign-in lifetime",
            "skipped",
            "Not known for a sign-in from environment variables.",
          )
        : checkOAuthMode(cred.refreshTokenExpiresAt, rt.now())
      : check("oauth_mode", "Google sign-in lifetime", "skipped", "No sign-in to check."),
  );

  let tokenOk = false;
  if (!ready || options.offline) {
    checks.push(
      check(
        "token",
        "Google sign-in works",
        "skipped",
        ready ? "Offline check." : "No sign-in to check.",
      ),
    );
  } else {
    try {
      await rt.tokens().getAccessToken({ forceRefresh: true });
      tokenOk = true;
      checks.push(
        check("token", "Google sign-in works", "ok", "Google issued a fresh access token."),
      );
      const scopes = await rt
        .tokens()
        .grantedScopes?.()
        .catch(() => undefined);
      checks.push(checkMerchantCenter(scopes));
    } catch (err) {
      checks.push(
        check(
          "token",
          "Google sign-in works",
          "fail",
          errorText(err, rt.secrets(), CHECK_PROBLEM),
          "Sign in to Google again.",
          `Run \`${howToRun("auth")}\`.`,
        ),
      );
    }
  }

  if (!tokenOk) {
    checks.push(
      check("accounts", "Google Ads accounts reachable", "skipped", "Needs a working sign-in."),
    );
  } else {
    try {
      const ids = await rt.ads().listAccessibleCustomers();
      checks.push(
        ids.length > 0
          ? check(
              "accounts",
              "Google Ads accounts reachable",
              "ok",
              `This sign-in reaches ${ids.length} account${ids.length === 1 ? "" : "s"} directly.`,
            )
          : check(
              "accounts",
              "Google Ads accounts reachable",
              "warn",
              "Google answered, but this sign-in has no Google Ads accounts.",
              "Sign in again with a Google user that can open your Google Ads account.",
              `Run \`${howToRun("auth")}\`.`,
            ),
      );
    } catch (err) {
      rt.noteError(err);
      const limit = dailyLimitOf(err);
      if (limit) {
        // the API is on and the sign-in works: Google only says the day's limit is spent
        let waitMs = limit.waitMs;
        try {
          const until = rt.opsCounter.limitUntil?.("production") ?? null;
          waitMs ??= until === null ? undefined : until - rt.now();
        } catch {
          // store busy: Google's own words only
        }
        const line =
          waitMs !== undefined && waitMs > 0
            ? dailyLimitLine(waitMs).replace(
                /\.$/,
                ` (at ${refillClock(rt.now() + waitMs, rt.now())}).`,
              )
            : dailyLimitLine(waitMs);
        checks.push(
          check(
            "accounts",
            "Google Ads accounts reachable",
            "warn",
            line,
            "Try again after it refills.",
          ),
        );
      } else {
        checks.push(
          check(
            "accounts",
            "Google Ads accounts reachable",
            "fail",
            errorText(err, rt.secrets(), CHECK_PROBLEM),
            "Check that the Google Ads API is turned on in your Google Cloud project and that this Google user can open the account.",
          ),
        );
      }
    }
  }

  const level = rt.accessLevel();
  checks.push(
    storeBusy && level.source === "default"
      ? check(
          "access_level",
          "Google Ads API access level",
          "skipped",
          "Couldn't read the store (in use by another process), so the saved access level is not known.",
        )
      : checkAccessLevel(level, rt.lastAccessIssue()),
  );
  checks.push(
    check(
      "api_version",
      "Google Ads API version",
      "ok",
      `Using Google Ads API ${GOOGLE_ADS_API_VERSION}.`,
    ),
  );
  const policyState = rt.policyFile.state();
  const exists = options.fileExists ?? existsSync;
  checks.push(
    ...checkPolicy(
      policyState,
      findStrayPolicies(
        [...(isFilesystemRoot(rt.cwd, rt.platform) ? [] : [rt.cwd]), ...(options.roots ?? [])],
        exists,
      ),
    ),
  );
  try {
    const use = (pool: OpsPool): OpsUse => {
      const until = rt.opsCounter.limitUntil?.(pool) ?? null;
      return {
        used: rt.opsCounter.used(pool),
        remaining: rt.opsCounter.remaining(pool),
        limit: rt.opsLimits[pool],
        waitMs: until === null ? null : until - rt.now(),
        refillsAt: until,
      };
    };
    checks.push(
      checkOps(
        use("production"),
        use("test"),
        policyState.status === "valid" ? policyState.policy.ops_budget.warn_at_pct : 80,
        policyState.status === "valid" ? policyState.policy.ops_budget.reserve_for_writes_pct : 0,
      ),
    );
  } catch {
    checks.push(
      check(
        "ops",
        "Google Ads operations today",
        "skipped",
        "Couldn't read today's count from the store (in use by another process).",
      ),
    );
  }
  checks.push(await checkApprovalPage(options.canBindPage ?? canBindPage));
  checks.push(checkOpener(rt.platform, exists, rt.env));
  checks.push(checkApprovalMode(rt.approvalSettings()));
  checks.push(checkRetention(rt.retentionSettings()));
  checks.push(checkPlugin(await rt.loadPlugin()));
  checks.push(checkElicitation(options.elicitation, rt.approvalSettings().mode));
  // Changes are on once the policy lets at least one account be changed.
  const writesOn = policyState.status === "valid" && policyState.policy.accounts.write.length > 0;
  const browser = checkBrowserControl(
    mcpConfigFiles(rt.home, rt.cwd, rt.platform, rt.env),
    read,
    writesOn,
  );
  checks.push(browser);
  const testAccounts = new Map<string, boolean>();
  try {
    for (const a of listSavedAccounts(rt.store())) testAccounts.set(a.customerId, a.isTestAccount);
  } catch {
    // Unknown = not a test account (the stricter reading).
  }
  const exposure = checkWriteExposure(
    policyState,
    testAccounts,
    rt.approvalSettings().mode,
    browser.status === "warn",
  );
  if (exposure) checks.push(exposure);
  checks.push(checkClaudeHooks(claudeSettingsFiles(rt.home, rt.cwd), read));

  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skipped: 0 };
  for (const c of checks) summary[c.status]++;
  return { ok: summary.fail === 0, checks, summary };
};

const LABEL: Record<CheckStatus, string> = {
  ok: "OK  ",
  warn: "WARN",
  fail: "FAIL",
  skipped: "SKIP",
};

/**
 * Plain text for terminals (details: true, so commands can be copied) and the MCP text
 * mirror (plain lines only; the details stay in the structured content).
 */
export const formatDoctor = (report: DoctorReport, options: { details?: boolean } = {}): string => {
  const lines = report.checks.flatMap((c) => [
    `${LABEL[c.status]}  ${c.title}: ${c.detail}`,
    ...(c.fix ? [`      Fix: ${c.fix}`] : []),
    ...(options.details && c.details && c.status !== "ok" ? [`      Details: ${c.details}`] : []),
  ]);
  const s = report.summary;
  lines.push(
    "",
    `${s.ok} ok, ${s.warn} warning${s.warn === 1 ? "" : "s"}, ${s.fail} failed, ${s.skipped} skipped.`,
  );
  return lines.join("\n");
};
