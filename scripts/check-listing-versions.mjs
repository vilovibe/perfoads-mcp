#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The listing files pin the CLI package by exact version and name: server.json (MCP
// Registry) and the Claude plugin. This fails when any of them drifts from
// packages/cli/package.json, so a release can't ship a listing that launches another
// version, or names another check count than docs/CHECKS.md. Run by `pnpm docs:check`;
// bump them together (docs/RELEASE.md).

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

// The check count in the listing and guide text matches the generated docs/CHECKS.md
// (itself checked against the registry by gen-checks-doc.mjs --check), so it can't drift.
const checkCount = /^(\d+) deterministic checks/m.exec(read("docs/CHECKS.md"))?.[1];
if (!checkCount) problems.push("docs/CHECKS.md has no check count line");
else
  for (const rel of [
    "server.json",
    "claude-plugin/.claude-plugin/plugin.json",
    "claude-plugin/README.md",
    "docs/USING.md",
    "docs/guide/PerfoAds-MCP-Guide.html",
  ]) {
    for (const m of read(rel).matchAll(
      /\b(\d{2,4}) (?:fixed |deterministic )?(?:account )?checks\b/g,
    )) {
      expect(`${rel} check count`, m[1], checkCount);
    }
  }

if (problems.length > 0) {
  console.error(
    `Listing files out of date with ${pinned} / ${checkCount ?? "?"} checks:\n- ${problems.join("\n- ")}`,
  );
  process.exit(1);
}
console.log(`Listing files pin ${pinned} and say ${checkCount} checks.`);
