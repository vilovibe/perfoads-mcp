#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The listing files pin the CLI package by exact version and name: server.json (MCP
// Registry) and the Claude plugin. This fails when any of them drifts from
// packages/cli/package.json, so a release can't ship a listing that launches another
// version. Run by `pnpm docs:check`; bump them together (docs/RELEASE.md).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

const cli = json("packages/cli/package.json");
const server = json("server.json");
const plugin = json("claude-plugin/.claude-plugin/plugin.json");
const pinned = `${cli.name}@${cli.version}`;
const problems = [];
const expect = (what, actual, wanted) => {
  if (actual !== wanted)
    problems.push(`${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
};

expect("server.json name", server.name, cli.mcpName);
expect("server.json version", server.version, cli.version);
expect("server.json packages[0].identifier", server.packages?.[0]?.identifier, cli.name);
expect("server.json packages[0].version", server.packages?.[0]?.version, cli.version);
expect("plugin.json version", plugin.version, cli.version);
const args = Object.values(plugin.mcpServers ?? {})[0]?.args ?? [];
expect(
  "plugin.json server package",
  args.find((a) => a.startsWith(`${cli.name}@`)),
  pinned,
);

// Every `perfoads-mcp@<x>` in the plugin README names the same version.
for (const m of read("claude-plugin/README.md").matchAll(/perfoads-mcp@([0-9A-Za-z.+-]+)/g)) {
  expect("claude-plugin/README.md version", m[1], cli.version);
}

if (problems.length > 0) {
  console.error(`Listing files out of date with ${pinned}:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`Listing files pin ${pinned}.`);
