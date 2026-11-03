// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { parseArgs } from "node:util";
import {
  createRuntime,
  errorText,
  serveOverStdio,
  type RuntimeOptions,
} from "@perfoads/mcp-server";
import {
  approvalsOpenCommand,
  approveCommand,
  authCommand,
  doctorCommand,
  HELP,
  initCommand,
  policyCheckCommand,
  policyShowCommand,
  rejectCommand,
  resetCommand,
  type CommandIo,
} from "./commands.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { howToRun, resetProcessPath, setInvocation } from "@perfoads/store";
import { PromptCancelled, PromptEnded, terminalPrompter } from "./prompt.js";
import { CLI_PUBLISHED, CLI_VERSION } from "./version.js";

export interface MainOptions {
  runtime?: RuntimeOptions;
  io?: Partial<CommandIo>;
  stdinIsTty?: boolean;
  stdoutIsTty?: boolean;
}

const COMMANDS = [
  "init",
  "auth",
  "doctor",
  "reset",
  "serve",
  "approve",
  "reject",
  "approvals",
  "policy",
] as const;
/** Commands that take one change id. */
const WITH_ID = ["approve", "reject"];
type Command = (typeof COMMANDS)[number];

/** This install's entry file, resolved (pnpm and npm link through symlinks). */
const entryFile = (): string => {
  const file = fileURLToPath(new URL("../bin/perfoads-mcp.js", import.meta.url));
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

const HOMEBREW_CELLAR =
  /^(\/opt\/homebrew|\/usr\/local)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/;

/**
 * The Node.js path to put in commands and the AI app's config. Homebrew runs Node from a
 * versioned Cellar folder that is deleted on the next `brew upgrade`: then the stable link
 * (`/opt/homebrew/bin/node`, `/usr/local/bin/node`, or the formula's `opt` link) is used when
 * it exists and resolves to the same binary. Otherwise the path stays, with a note.
 */
export const stableNodePath = (
  execPath: string,
  realpath: (p: string) => string = realpathSync,
): { node: string; note?: string } => {
  const m = HOMEBREW_CELLAR.exec(execPath);
  if (!m) return { node: execPath };
  const [, prefix, formula] = m;
  const resolve = (p: string): string | undefined => {
    try {
      return realpath(p);
    } catch {
      return undefined;
    }
  };
  const target = resolve(execPath) ?? execPath;
  for (const candidate of [`${prefix}/bin/node`, `${prefix}/opt/${formula}/bin/node`]) {
    if (resolve(candidate) === target) return { node: candidate };
  }
  return {
    node: execPath,
    note: `Note: Node.js runs from a Homebrew version folder (${execPath}) that is removed when Homebrew updates Node. After \`brew upgrade\`, run init again (or change the path in the config).`,
  };
};

/** Messages name the program that is running: Node + this entry file (or npx@version once published). */
export const configureInvocation = (): void => {
  const node = stableNodePath(process.execPath);
  setInvocation({
    node: node.node,
    ...(node.note ? { nodeNote: node.note } : {}),
    script: entryFile(),
    version: CLI_VERSION,
    published: CLI_PUBLISHED,
  });
};

/**
 * The real CLI start (bin), before anything else runs: PATH becomes a fixed list of system
 * folders, so nothing the process starts can be redirected through PATH.
 */
export const prepareProcess = (): void => {
  resetProcessPath();
  configureInvocation();
};

/** The crash line of the bin: how to run doctor with this install. */
export const doctorHint = (): string => howToRun("doctor");

/** Runs the CLI and returns the exit code. `serve` resolves when the AI app disconnects. */
export const main = async (argv: string[], options: MainOptions = {}): Promise<number> => {
  configureInvocation();
  const out = options.io?.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = options.io?.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const stdinIsTty = options.stdinIsTty ?? process.stdin.isTTY === true;
  const stdoutIsTty = options.stdoutIsTty ?? process.stdout.isTTY === true;

  const parse = () =>
    parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        "merchant-center": { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse();
  } catch {
    err(`Unknown option.\n\n${HELP}`);
    return 2;
  }
  if (parsed.values.version) {
    out(CLI_VERSION);
    return 0;
  }
  if (parsed.values.help) {
    out(HELP);
    return 0;
  }
  const [first, ...rest] = parsed.positionals;
  // AI apps start the server without arguments and without a terminal.
  const command: string | undefined = first ?? (stdinIsTty ? undefined : "serve");
  if (command === undefined) {
    out(HELP);
    return 0;
  }
  const takesId = WITH_ID.includes(command);
  const approvalsOpen = command === "approvals" && rest[0] === "open" && rest.length === 2;
  const policyCmd =
    command === "policy" &&
    ((rest[0] === "check" && rest.length <= 2) || (rest[0] === "show" && rest.length === 1));
  if (
    !COMMANDS.includes(command as Command) ||
    (command === "approvals" && !approvalsOpen) ||
    (command === "policy" && !policyCmd) ||
    (command !== "approvals" && command !== "policy" && rest.length > (takesId ? 1 : 0)) ||
    (takesId && rest.length !== 1)
  ) {
    err(`Unknown command "${[command, ...rest].join(" ")}".\n\n${HELP}`);
    return 2;
  }
  const merchantCenter = parsed.values["merchant-center"] === true;
  if (merchantCenter && command !== "auth") {
    err(`--merchant-center goes with auth only.\n\n${HELP}`);
    return 2;
  }
  if (command === "serve") {
    await serveOverStdio(options.runtime);
    return 0;
  }

  // CLI commands: no start-folder rule for the policy (they say when the server would ignore it).
  const rt = createRuntime({ policyMode: "cli", ...options.runtime });
  const io: CommandIo = {
    out,
    err,
    prompter: options.io?.prompter ?? (stdinIsTty ? terminalPrompter() : undefined),
    ...(options.io?.authFlow ? { authFlow: options.io.authFlow } : {}),
  };
  try {
    if (command === "init") return await initCommand(rt, io);
    if (command === "auth") {
      return await authCommand(rt, io, undefined, merchantCenter ? { merchantCenter } : {});
    }
    if (command === "reset") return await resetCommand(rt, io);
    const tty = stdinIsTty && stdoutIsTty;
    if (command === "approve") return await approveCommand(rt, io, rest[0] ?? "", tty);
    if (command === "reject") return await rejectCommand(rt, io, rest[0] ?? "", tty);
    if (command === "approvals") return await approvalsOpenCommand(rt, io, rest[1] ?? "", tty);
    if (command === "policy") {
      return rest[0] === "show" ? policyShowCommand(rt, io) : policyCheckCommand(rt, io, rest[1]);
    }
    return await doctorCommand(rt, io);
  } catch (e) {
    if (e instanceof PromptCancelled) {
      err("Cancelled. Nothing more was saved.");
      return 130;
    }
    if (e instanceof PromptEnded) {
      err("No answer. Nothing more was saved.");
      return 1;
    }
    const known = e instanceof Error && e.message.startsWith("This step needs a terminal");
    err(known ? (e as Error).message : errorText(e, rt.secrets()));
    return 1;
  } finally {
    rt.close();
  }
};
