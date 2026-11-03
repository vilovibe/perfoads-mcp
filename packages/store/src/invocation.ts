// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// How a person runs this install's CLI. Every message that tells someone to run a command
// (errors, doctor fixes, the approval page, init's config snippet) goes through howToRun,
// so it names the program that is actually running. Until the package is published,
// `npx perfoads-mcp` could fetch whatever someone else publishes under that
// name; then it is Node + the CLI entry file by full path. Once the CLI package says
// published (package.json "perfoads": {"published": true}), it is npx with the exact version.

/** The npm package (and bin) name. */
export const PACKAGE_NAME = "perfoads-mcp";

export interface Invocation {
  /** Absolute path of the Node.js binary (process.execPath, or its stable Homebrew link). */
  node: string;
  /** Absolute, resolved path of the CLI entry file (bin/perfoads-mcp.js). */
  script: string;
  /** The CLI package version. */
  version: string;
  /** The CLI package is on npm under this exact version. */
  published: boolean;
  /** Said under the AI app config when `node` may move (a Homebrew version folder). */
  nodeNote?: string;
}

let current: Invocation | undefined;

/** Set by the CLI at start. Undefined (embedding, library tests): the bare package name. */
export const setInvocation = (value: Invocation | undefined): void => {
  current = value;
};

export const getInvocation = (): Invocation | undefined => current;

const quote = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;

/** Program and leading arguments that start this install (an AI app's config: + "serve"). */
export const runParts = (): { command: string; args: string[] } => {
  if (current?.published) {
    return { command: "npx", args: ["-y", `${PACKAGE_NAME}@${current.version}`] };
  }
  if (current) return { command: current.node, args: [current.script] };
  return { command: PACKAGE_NAME, args: [] };
};

/** The command line a person types to run `args` (e.g. "approvals open chg_1") with this install. */
export const howToRun = (args: string): string => {
  if (current?.published) return `npx ${PACKAGE_NAME}@${current.version} ${args}`;
  if (current) return `${quote(current.node)} ${quote(current.script)} ${args}`;
  return `${PACKAGE_NAME} ${args}`;
};
