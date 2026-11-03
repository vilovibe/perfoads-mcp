// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AccessLevel } from "@perfoads/ads-client";
import type { ChangeView } from "@perfoads/changes";
import {
  approvalSummaryText,
  dashedId,
  formatDoctor,
  openSessionFor,
  PRODUCT_NAME,
  revokeRefreshToken,
  WORK_WITH_NOTE,
  runDoctor,
  statusText,
  stripBidi,
  type ApprovalSession,
  type Runtime,
} from "@perfoads/mcp-server";
import {
  type DataKey,
  DecryptError,
  deleteCredentials,
  forgetDataKey,
  getDataKey,
  howToRun,
  restrictToOwner,
  getInvocation,
  runParts,
  KeyUnavailableError,
  clearSavedLimitWait,
  loadCredential,
  readEnvCredentials,
  saveCredential,
  type Store,
  StoreBusyError,
  StoreOpenError,
  storePath,
} from "@perfoads/store";
import {
  describeState,
  POLICY_FILE,
  policyPath,
  readPolicyFile,
  starterPolicy,
} from "@perfoads/policy";
import { runAuthFlow, type AuthResult } from "./oauth.js";
import { PromptEnded, type Prompter } from "./prompt.js";

export interface CommandIo {
  out: (line: string) => void;
  err: (line: string) => void;
  prompter: Prompter | undefined;
  /** For tests: replaces the real browser sign-in. */
  authFlow?: typeof runAuthFlow;
}

export const HELP = `${PRODUCT_NAME} - an MCP server that works with your own Google Ads accounts.
Not a Google product.

Usage: perfoads-mcp <command>

Commands:
  init      Guided setup: your Google Cloud OAuth client, sign-in, checks, AI app config
  auth      Sign in with Google again (uses the saved OAuth client)
  auth --merchant-center   Same, and also allow Merchant Center labels (tag_exclude; optional)
  doctor    Check the setup and say what to fix
  reset     Delete the saved Google sign-in and its encryption key (asks first)
  approve <change_id>   Approve a change: type the code from its approval page (terminal only)
  reject <change_id>    Reject a proposed change (terminal only)
  approvals open <change_id>   Show a change's approval page from this terminal (when no browser opened)
  policy check [file]   Check a policy file (default: the one in the settings folder) and say what it allows
  policy show   Show the change policy the server uses now
  serve     Run the MCP server over stdio (what AI apps start; the default without a terminal)

Options:
  -h, --help      Show this help
  -v, --version   Show the version

Settings folder: ~/.config/perfoads-mcp (Windows: %APPDATA%\\perfoads-mcp).
Change it with PERFOADS_MCP_HOME. Never put it inside a project the AI works in.

${WORK_WITH_NOTE}`;

const SETUP_STEPS = `Before you start, in Google Cloud Console (console.cloud.google.com), with your own project:
  1. Create a Google Cloud project (or pick one you own).
  2. APIs & Services > Library: enable "Google Ads API".
  3. Google Auth Platform: set up the consent screen (External is fine) and add your
     Google user as a test user, or publish the app.
  4. Google Auth Platform > Clients: create an OAuth client of type "Desktop app".
     Keep its client id and client secret at hand.
  5. Apply for Explorer access to the Google Ads API for this project. Until it is
     approved, only Google Ads test accounts work.
No developer token is needed. Nothing goes through anyone else's servers.
`;

const ACCESS_LEVELS: readonly AccessLevel[] = ["test", "explorer", "basic", "standard", "unknown"];

/** MCP client config snippets for Claude Desktop, Claude Code and Cursor. */
/**
 * The AI app config for this install: Node + this entry file by full path until the
 * package is published, then npx with the exact version (runParts).
 */
export const configSnippets = (env: Readonly<Record<string, string | undefined>>): string => {
  const home = env.PERFOADS_MCP_HOME?.trim();
  const { command, args } = runParts();
  // Only when the config starts that Node (not npx).
  const note = command === getInvocation()?.node ? getInvocation()?.nodeNote : undefined;
  const entry = {
    command,
    args: [...args, "serve"],
    ...(home ? { env: { PERFOADS_MCP_HOME: home } } : {}),
  };
  const json = JSON.stringify({ mcpServers: { "perfoads-mcp": entry } }, null, 2);
  const envFlag = home ? ` -e PERFOADS_MCP_HOME=${JSON.stringify(home)}` : "";
  const shellArgs = [command, ...args, "serve"].map((a) =>
    /^[\w@./:-]+$/.test(a) ? a : JSON.stringify(a),
  );
  return [
    "Claude Desktop (Settings > Developer > Edit Config, claude_desktop_config.json):",
    json,
    "",
    "Claude Code (run in a terminal):",
    `  claude mcp add --scope user perfoads-mcp${envFlag} -- ${shellArgs.join(" ")}`,
    "",
    "Cursor (~/.cursor/mcp.json): the same JSON as Claude Desktop.",
    "",
    "Restart the AI app after changing its config.",
    ...(note ? ["", note] : []),
  ].join("\n");
};

const requirePrompter = (io: CommandIo): Prompter => {
  if (!io.prompter) {
    throw new Error(
      "This step needs a terminal to type in. Run it in Terminal (macOS/Linux) or PowerShell (Windows).",
    );
  }
  return io.prompter;
};

const reportAuth = (io: CommandIo, result: AuthResult): void => {
  io.out("Signed in. The sign-in is saved encrypted in the settings folder.");
  if (result.merchantCenter === true) {
    io.out("Merchant Center labels are allowed: tag_exclude can label products.");
  } else if (result.merchantCenter === false) {
    io.out(
      "Merchant Center was not allowed (the box was not ticked), so tag_exclude refuses. Everything else works.",
    );
  }
  if (result.testingMode) {
    io.out("");
    io.out("Warning: your OAuth app is in Testing mode, so this sign-in expires in 7 days.");
    io.out(
      "Fix: in Google Cloud Console open Google Auth Platform > Audience and press Publish app,",
    );
    io.out(`then run \`${howToRun("auth")}\` again.`);
  }
};

const resetCmd = (): string => howToRun("reset");

const confirm = async (p: Prompter, question: string): Promise<boolean> =>
  /^y(es)?$/i.test((await p.ask(question)).trim());

/** Deletes the saved sign-in and the key that protected it. Nothing secret stays behind. */
/** The saved refresh token, if it can be read (never printed). */
const savedRefreshToken = (rt: Runtime, store: Store): string | undefined => {
  try {
    const dataKey = getDataKey(rt.keyDeps, store, { create: false });
    return dataKey ? loadCredential(store, dataKey.key, "refresh_token") : undefined;
  } catch {
    return undefined;
  }
};

const wipeSignIn = (rt: Runtime, store: Store | undefined): void => {
  if (store) store.immediate(() => deleteCredentials(store));
  forgetDataKey(rt.keyDeps, store);
  rt.reloadCredentials();
};

const openSavedSignIn = (
  rt: Runtime,
  store: Store,
  given: { clientId: string; clientSecret: string } | undefined,
): { dataKey: DataKey; clientId: string | undefined; clientSecret: string | undefined } => {
  const dataKey = getDataKey(rt.keyDeps, store, { create: true });
  if (!dataKey) throw new Error("Could not create the encryption key.");
  return {
    dataKey,
    clientId: given?.clientId ?? loadCredential(store, dataKey.key, "oauth_client_id"),
    clientSecret: given?.clientSecret ?? loadCredential(store, dataKey.key, "oauth_client_secret"),
  };
};

/** Signs in with the saved (or given) OAuth client and saves the refresh token, encrypted. */
export const authCommand = async (
  rt: Runtime,
  io: CommandIo,
  given?: { clientId: string; clientSecret: string },
  opts: { merchantCenter?: boolean } = {},
): Promise<number> => {
  const store = rt.store();
  let opened: ReturnType<typeof openSavedSignIn>;
  try {
    opened = openSavedSignIn(rt, store, given);
  } catch (err) {
    if (!(err instanceof KeyUnavailableError || err instanceof DecryptError)) throw err;
    io.err(
      err instanceof KeyUnavailableError
        ? "The saved Google sign-in cannot be read: its encryption key is missing or locked."
        : "The saved Google sign-in cannot be read: it was saved with another encryption key, or the file was changed.",
    );
    if (!io.prompter) {
      io.err(`To start fresh, run this in a terminal: ${resetCmd()}`);
      return 1;
    }
    if (!(await confirm(io.prompter, "Delete the saved Google sign-in and start fresh? [y/N] "))) {
      io.err("Nothing was changed.");
      return 1;
    }
    wipeSignIn(rt, store);
    opened = openSavedSignIn(rt, store, given);
  }
  const { dataKey } = opened;
  let { clientId, clientSecret } = opened;
  if (!clientId || !clientSecret) {
    const p = requirePrompter(io);
    clientId = await p.ask("OAuth client id: ");
    clientSecret = await p.askHidden("OAuth client secret (hidden): ");
  }
  if (!clientId || !clientSecret) {
    io.err("Both the client id and the client secret are needed.");
    return 1;
  }
  const flow = io.authFlow ?? runAuthFlow;
  const result = await flow({
    clientId,
    clientSecret,
    fetch: rt.fetch,
    print: io.out,
    now: rt.now,
    ...(opts.merchantCenter ? { merchantCenter: true } : {}),
  });
  store.immediate(() => {
    saveCredential(store, dataKey.key, "oauth_client_id", clientId);
    saveCredential(store, dataKey.key, "oauth_client_secret", clientSecret);
    saveCredential(
      store,
      dataKey.key,
      "refresh_token",
      result.refreshToken,
      result.refreshTokenExpiresAt ?? null,
    );
  });
  reportAuth(io, result);
  io.out(`The encryption key is in ${dataKey.location}.`);
  const fromEnv = readEnvCredentials(rt.env);
  if (fromEnv) {
    io.out(
      "Note: PERFOADS_MCP_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN are set and win over the saved sign-in.",
    );
  }
  return 0;
};

/** Deletes the saved sign-in and its key after a typed yes. A damaged store is moved aside. */
export const resetCommand = async (rt: Runtime, io: CommandIo): Promise<number> => {
  if (!io.prompter) {
    io.err(
      `reset needs a terminal to confirm. Run it in Terminal (macOS/Linux) or PowerShell (Windows): ${resetCmd()}`,
    );
    return 1;
  }
  io.out(
    `This deletes the saved Google sign-in (OAuth client id, client secret, refresh token) and its encryption key from ${rt.configDir.dir}, and asks Google to revoke the sign-in.`,
  );
  let yes: boolean;
  try {
    yes = await confirm(io.prompter, "Continue? [y/N] ");
  } catch (err) {
    if (!(err instanceof PromptEnded)) throw err;
    io.out("No answer - nothing was changed.");
    return 1;
  }
  if (!yes) {
    io.out("Nothing was changed.");
    return 1;
  }
  let store: Store;
  try {
    store = rt.store();
  } catch (err) {
    // A busy store is healthy and in use: never move it aside or delete its key.
    if (err instanceof StoreBusyError) {
      io.err(`${err.message} Nothing was changed.`);
      return 1;
    }
    if (!(err instanceof StoreOpenError)) throw err;
    const file = storePath(rt.configDir.dir);
    const aside = `${file}.broken-${new Date(rt.now()).toISOString().replace(/[:.]/g, "-")}`;
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${aside}${suffix}`);
    }
    // The moved file can hold encrypted values: removing the key makes them unreadable for good.
    forgetDataKey(rt.keyDeps, undefined);
    io.out(`The damaged store was moved to ${aside}.`);
    store = rt.store();
  }
  // Best effort, before the token is gone: Google revokes the sign-in (and its access).
  const token = savedRefreshToken(rt, store);
  const revoked = token ? await revokeRefreshToken(rt.fetch, token) : false;
  wipeSignIn(rt, store);
  io.out("Done: the saved sign-in and its encryption key are deleted.");
  io.out(
    revoked
      ? "Google confirmed that the sign-in is revoked."
      : token
        ? "Google did not confirm revoking the sign-in (no connection, or it was already revoked). Check myaccount.google.com/permissions and remove the app there."
        : "There was no readable saved sign-in to revoke at Google. Check myaccount.google.com/permissions and remove the app there if it is listed.",
  );
  io.out(`Set up again with: ${howToRun("init")}`);
  return 0;
};

export const doctorCommand = async (rt: Runtime, io: CommandIo): Promise<number> => {
  const report = await runDoctor(rt);
  io.out(formatDoctor(report, { details: true }));
  return report.ok ? 0 : 1;
};

export const initCommand = async (rt: Runtime, io: CommandIo): Promise<number> => {
  const p = requirePrompter(io);
  io.out(`${PRODUCT_NAME} - setup. Not a Google product.`);
  io.out("");
  io.out(SETUP_STEPS);
  io.out(`Settings folder: ${rt.configDir.dir}`);
  io.out("");

  const clientId = await p.ask("OAuth client id (ends with .apps.googleusercontent.com): ");
  if (!clientId) {
    io.err("No client id given. Nothing was saved.");
    return 1;
  }
  if (!clientId.endsWith(".apps.googleusercontent.com")) {
    io.out("That does not look like an OAuth client id, but it will be tried.");
  }
  const clientSecret = await p.askHidden("OAuth client secret (hidden): ");
  if (!clientSecret) {
    io.err("No client secret given. Nothing was saved.");
    return 1;
  }
  const levelAnswer = (
    await p.ask(
      "Google Ads API access level of the project (test, explorer, basic, standard; Enter = not sure): ",
    )
  ).toLowerCase();
  const level = ACCESS_LEVELS.find((l) => l === levelAnswer) ?? "unknown";
  rt.store().setMeta("access_level", level);
  // a wait Google named for the old setup may not apply to this one
  clearSavedLimitWait(rt.store());

  io.out("");
  const authCode = await authCommand(rt, io, { clientId, clientSecret });
  if (authCode !== 0) return authCode;

  io.out("");
  await writeStarterPolicy(rt, io, p);

  io.out("");
  io.out("Checking the setup:");
  await doctorCommand(rt, io);

  io.out("");
  io.out("Last step: add the server to your AI app.");
  io.out("");
  io.out(configSnippets(rt.env));
  io.out("");
  io.out(WORK_WITH_NOTE);
  return 0;
};

/**
 * Writes a read-only starter policy.yaml (never over an existing one): accounts.allow =
 * the account chosen, accounts.write empty. Without a choice, nothing is written (reads
 * then work on every account, as with no policy).
 */
const writeStarterPolicy = async (rt: Runtime, io: CommandIo, p: Prompter): Promise<void> => {
  const file = policyPath(rt.configDir.dir);
  if (existsSync(file)) {
    io.out(`Change policy: ${file} already exists, left as it is.`);
    return;
  }
  let ids: string[] = [];
  try {
    ids = (await rt.accounts()).accounts.filter((a) => !a.isManager).map((a) => a.customerId);
  } catch {
    ids = [];
  }
  if (ids.length === 0) {
    io.out(
      `Change policy: no account list yet, so no ${POLICY_FILE} was written (read-only everywhere). Run init again later, or write it yourself (README: Change policy).`,
    );
    return;
  }
  io.out("Accounts this sign-in can read:");
  for (const id of ids.slice(0, 50)) io.out(`  ${dashedId(id)}`);
  const answer = (await p.ask("Account the AI may read (Enter = all listed): ")).replace(/-/g, "");
  const chosen = answer ? ids.filter((id) => id === answer) : ids;
  if (chosen.length === 0) {
    io.out(`That account is not in the list, so no ${POLICY_FILE} was written.`);
    return;
  }
  writeFileSync(file, starterPolicy(chosen), { mode: 0o600, flag: "wx" });
  if (rt.platform === "win32") {
    restrictToOwner(file, "file", { platform: rt.platform, run: rt.run, env: rt.env });
  }
  io.out(
    `Change policy written: ${file} (read-only: no account can be changed until you list it under accounts.write). Check it any time: ${howToRun("policy check")}`,
  );
};

/** `policy check [file]`: is the file valid, and what does it allow (plain words). */
export const policyCheckCommand = (rt: Runtime, io: CommandIo, file?: string): number => {
  const target = path.resolve(file ?? policyPath(rt.configDir.dir));
  const state = readPolicyFile(target);
  if (state.status === "none") {
    io.err(`No policy file at ${target}.`);
    return 1;
  }
  io.out(`${target}:`);
  for (const line of describeState(state)) io.out(line);
  const inForce = path.resolve(policyPath(rt.configDir.dir));
  const note = target === inForce ? rt.policyFile.state().note : undefined;
  if (note) io.out(`Note: ${note}`);
  if (file !== undefined && path.resolve(file) !== path.resolve(policyPath(rt.configDir.dir))) {
    io.out("");
    io.out(
      `Note: the server only reads ${policyPath(rt.configDir.dir)}. Copy the file there to use it.`,
    );
  }
  return state.status === "valid" ? 0 : 1;
};

/** `policy show`: the policy as the server sees it now (location rule included). */
export const policyShowCommand = (rt: Runtime, io: CommandIo): number => {
  const state = rt.policyFile.state();
  io.out(`Policy file: ${policyPath(rt.configDir.dir)}`);
  for (const line of describeState(state)) io.out(line);
  if (state.note) io.out(`Note: ${state.note}`);
  if (state.status === "valid") io.out(`Version hash: ${state.hash}`);
  return state.status === "invalid" || state.status === "ignored" ? 1 : 0;
};

const TTY_ONLY =
  "This needs a terminal you type in (keyboard input and screen output both a terminal). This asks for the code shown on the approval page. It is a convenience, not a guard against an AI with a shell on your user account - see Hardened setup in the README.";

const showChange = (
  rt: Runtime,
  io: CommandIo,
  change: ChangeView,
  session: ApprovalSession,
): void => {
  io.out(`Account: ${dashedId(change.customerId)}, currency ${change.currencyCode}`);
  io.out(
    `Account name (from Google, unverified): ${JSON.stringify(stripBidi(change.accountName))}`,
  );
  const policyLines = session.kind === "approve" ? rt.approvals().policyLines(change) : [];
  io.out(approvalSummaryText(change, session.kind, session.outcome, session.note, policyLines));
  for (const w of change.warnings) io.out(`Warning: ${w}`);
  io.out("");
};

/** Asks for the code until it is right, the person stops, or the session is burned. */
const codeLoop = async (
  rt: Runtime,
  io: CommandIo,
  prompter: Prompter,
  session: ApprovalSession,
): Promise<number> => {
  for (;;) {
    const typed = await prompter.ask("Code from the approval page (Enter = stop): ");
    if (!typed.trim()) {
      io.out("Stopped. Nothing was approved.");
      return 1;
    }
    const r = await rt.approvals().completeWithCode(session.id, typed, "cli");
    if (r.ok) {
      io.out(
        session.kind === "approve"
          ? `Approved ${r.change.id}. The AI can now send it with apply_change.`
          : `${r.change.id}: ${statusText(r.change)}`,
      );
      return 0;
    }
    if (r.reason === "wrong") {
      io.err(`Wrong code. ${r.attemptsLeft} tr${r.attemptsLeft === 1 ? "y" : "ies"} left.`);
      continue;
    }
    io.err(
      r.reason === "burned"
        ? "Too many wrong codes: this approval was closed. Ask the AI to call apply_change again for a new page."
        : r.reason === "refused"
          ? r.message
          : "This approval expired or was already finished. Nothing was approved.",
    );
    return 1;
  }
};

/**
 * Completes an approval (or the settling of an unclear change) with the code from the
 * approval page. Refuses unless stdin and stdout are a terminal (a convenience check: a
 * program can fake a terminal, so this is not a guard against an AI with a shell).
 */
export const approveCommand = async (
  rt: Runtime,
  io: CommandIo,
  changeId: string,
  tty: boolean,
): Promise<number> => {
  if (!tty || !io.prompter) {
    io.err(TTY_ONLY);
    return 1;
  }
  const change = rt.engine().get(changeId);
  if (!change) {
    io.err("No change with that id.");
    return 1;
  }
  const session = openSessionFor(rt.store(), change.id, rt.now());
  if (!session || session.version !== change.version) {
    io.err(
      `No approval is waiting for ${change.id}. Ask the AI to call apply_change (or resolve_change) first: that opens the approval page with the code.`,
    );
    return 1;
  }
  showChange(rt, io, change, session);
  return codeLoop(rt, io, io.prompter, session);
};

/**
 * `approvals open <id>`: serves a fresh code-only approval page from this terminal (when
 * the server could not open a browser), prints its address to this terminal only, then
 * asks for the code shown there.
 */
export const approvalsOpenCommand = async (
  rt: Runtime,
  io: CommandIo,
  changeId: string,
  tty: boolean,
): Promise<number> => {
  if (!tty || !io.prompter) {
    io.err(TTY_ONLY);
    return 1;
  }
  const change = rt.engine().get(changeId);
  if (!change) {
    io.err("No change with that id.");
    return 1;
  }
  const { session, page } = await rt.approvals().openForTerminal(change);
  try {
    io.out("Open this address in a browser on this computer (it works once, for 10 minutes):");
    io.out(`  ${page.url}`);
    io.out("");
    showChange(rt, io, change, session);
    return await codeLoop(rt, io, io.prompter, session);
  } finally {
    page.close();
    // Nobody can read this page's code any more: no other process may reuse its session.
    rt.approvals().release(session.id);
  }
};

/** Rejects a proposed change after a typed yes. Terminal only. */
export const rejectCommand = async (
  rt: Runtime,
  io: CommandIo,
  changeId: string,
  tty: boolean,
): Promise<number> => {
  if (!tty || !io.prompter) {
    io.err(TTY_ONLY);
    return 1;
  }
  const engine = rt.engine();
  const change = engine.get(changeId);
  if (!change) {
    io.err("No change with that id.");
    return 1;
  }
  if (change.status !== "proposed") {
    io.err(`Change ${change.id} is ${change.status}: ${statusText(change)}`);
    return 1;
  }
  io.out(approvalSummaryText(change, "approve").split("\n").slice(0, -1).join("\n"));
  if (!(await confirm(io.prompter, "Reject this change? [y/N] "))) {
    io.out("Nothing was changed.");
    return 1;
  }
  engine.markRejected(change.id, { actor: rt.approvalUser(), via: "cli" });
  rt.approvals().closeSessionsFor(change.id);
  io.out(`Rejected ${change.id}. Nothing was sent to Google Ads.`);
  return 0;
};
