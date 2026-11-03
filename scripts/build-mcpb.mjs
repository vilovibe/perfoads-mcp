#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Packs the built server into a Claude Desktop extension: dist/<name>-<version>.mcpb.
//
//   pnpm build && node scripts/build-mcpb.mjs
//
// Manifest: MCPB manifest spec 0.4 (anthropics/mcpb, schemas/mcpb-manifest-v0.4.schema.json;
// the @anthropic-ai/mcpb 2.1.2 CLI's LATEST_MANIFEST_VERSION), checked with `mcpb validate`.
// Steps: `pnpm deploy --prod` of the CLI package into dist/mcpb/server (a flat node_modules,
// no symlinks), manifest.json + README + LICENSE + NOTICE next to it, a smoke test (the
// staged server starts and lists its tools), then `mcpb pack`. Names and version come from
// the built server (PRODUCT_NAME, SERVER_NAME, SERVER_VERSION) - one place to rename.
// No secret is ever in the manifest: the only setting is the settings folder. pnpm's
// bookkeeping is removed, and the staged files and the packed .mcpb are scanned: any home
// path, user name, repo path or user-folder path (macOS, Windows) fails the build.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listFromServer } from "./mcp-stdio.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist");
const stage = path.join(out, "mcpb");
const BIN = "server/bin/perfoads-mcp.js";
const REPO = "https://github.com/vilovibe/perfoads-mcp";

const serverDist = path.join(root, "packages", "mcp-server", "dist", "index.js");
if (!existsSync(serverDist) || !existsSync(path.join(root, "packages", "cli", "dist", "main.js"))) {
  console.error("Build first: pnpm build");
  process.exit(1);
}
const { PRODUCT_NAME, SERVER_NAME, SERVER_VERSION } = await import(pathToFileURL(serverDist).href);

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed (exit ${r.status}).`);
    process.exit(1);
  }
};

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// The CLI package with its production dependencies, workspace packages copied in.
run("pnpm", [
  "--filter",
  SERVER_NAME,
  "deploy",
  "--prod",
  "--config.node-linker=hoisted",
  path.join(stage, "server"),
]);

for (const f of ["README.md", "LICENSE", "NOTICE"])
  copyFileSync(path.join(root, f), path.join(stage, f));
copyFileSync(
  path.join(root, "claude-plugin/.claude-plugin/icon.png"),
  path.join(stage, "icon.png"),
);

// pnpm's own bookkeeping records this machine's paths (store dir, virtual store): never ship it.
const PNPM_METADATA = [
  "node_modules/.modules.yaml",
  "node_modules/.pnpm",
  "node_modules/.bin",
  "node_modules/.package-lock.json",
];
for (const rel of PNPM_METADATA)
  rmSync(path.join(stage, "server", rel), { recursive: true, force: true });

/**
 * Every text file under dir that holds this machine's home path, user name (as a word), the
 * repo path or any macOS / Windows user-folder path. Binary files (a NUL byte) are skipped.
 */
const leaksIn = (dir) => {
  const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const user = userInfo().username;
  const needles = [
    ["home path", new RegExp(escape(homedir()), "i")],
    ["repo path", new RegExp(escape(root), "i")],
    ["a macOS user-folder path", /\/User[s]\//],
    ["a Windows user-folder path", /[A-Za-z]:\\{1,2}Users\\{1,2}/i],
    ...(user.length >= 3
      ? [["user name", new RegExp(`(?<![\\p{L}\\p{N}_])${escape(user)}(?![\\p{L}\\p{N}_])`, "iu")]]
      : []),
  ];
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const buf = readFileSync(full);
        if (buf.includes(0)) continue;
        const text = buf.toString("utf8");
        const hit = needles.find(([, re]) => re.test(text));
        if (hit) found.push(`${path.relative(dir, full)} (${hit[0]})`);
      }
    }
  };
  walk(dir);
  return found;
};
const failOnLeaks = (dir, what) => {
  const found = leaksIn(dir);
  if (found.length > 0) {
    console.error(`${what} holds paths or names from this machine; nothing packed:`);
    for (const f of found.slice(0, 20)) console.error(`  ${f}`);
    process.exit(1);
  }
};
failOnLeaks(stage, "The staged bundle");

/**
 * The private plugin must never ship in the bundle: no file may name its package, nor hold any
 * of the fix-guidance texts that moved out of the checks (by sha256, the same list the tests
 * use: packages/checks/src/testing/movedTexts.ts; quoted pieces and whole lines of 20+ chars).
 */
const MOVED = new Set(
  [
    ...readFileSync(
      path.join(root, "packages", "checks", "src", "testing", "movedTexts.ts"),
      "utf8",
    ).matchAll(/"([g-v]{64})"/g),
  ].map((m) => m[1]),
);
const letters = (s) =>
  [...createHash("sha256").update(s).digest()]
    .map((b) => "ghijklmnopqrstuv".charAt(b >> 4) + "ghijklmnopqrstuv".charAt(b & 15))
    .join("");
const PRIVATE_NAME = new RegExp(["@perfoads", "pro"].join("\\/") + "(?![\\w-])");
const guidanceIn = (dir) => {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const buf = readFileSync(full);
        if (buf.includes(0)) continue;
        const text = buf.toString("utf8");
        if (PRIVATE_NAME.test(text)) found.push(`${path.relative(dir, full)} (names the plugin)`);
        const chunks = new Set(text.split("\n").map((l) => l.trim()));
        for (const re of [
          /"((?:[^"\\\n]|\\.)*)"/g,
          /'((?:[^'\\\n]|\\.)*)'/g,
          /`((?:[^`\\]|\\.)*)`/g,
        ])
          for (const m of text.matchAll(re))
            for (const part of (m[1] ?? "").split(/\$\{[^}]*\}/)) chunks.add(part.trim());
        for (const c of chunks)
          if (c.length >= 20 && MOVED.has(letters(c))) {
            found.push(`${path.relative(dir, full)} (fix guidance: ${c.slice(0, 40)})`);
            break;
          }
      }
    }
  };
  walk(dir);
  return found;
};
const failOnGuidance = (dir, what) => {
  if (MOVED.size < 400) {
    console.error("The fix-guidance fingerprint list was not found; nothing packed.");
    process.exit(1);
  }
  const found = guidanceIn(dir);
  if (found.length > 0) {
    console.error(`${what} holds the private plugin or its texts; nothing packed:`);
    for (const f of found.slice(0, 20)) console.error(`  ${f}`);
    process.exit(1);
  }
};
failOnGuidance(stage, "The staged bundle");

// Smoke test the staged copy, and take the tool list for the manifest from it.
const served = await listFromServer(path.join(stage, BIN));
if (served.tools.length === 0) {
  console.error("The staged server lists no tools.");
  process.exit(1);
}

const manifest = {
  manifest_version: "0.4",
  name: SERVER_NAME,
  display_name: PRODUCT_NAME,
  version: SERVER_VERSION,
  icon: "icon.png",
  description:
    "Self-hosted MCP server that works with Google Ads: read, run 100+ account checks, and change things only with your approval and within your policy limits. Not a Google product.",
  long_description: [
    `${PRODUCT_NAME} works with the Google Ads API through your own Google Cloud project and sign-in. Nothing goes through a shared service.`,
    "",
    "Before installing: run `npx perfoads-mcp init` once in a terminal (Node.js 22.13 or later). It saves your Google sign-in, encrypted, in the settings folder this extension then uses.",
    "",
    "Changes are off until your policy file allows them, and each one needs your approval on a local page outside the chat. Full guide: " +
      `${REPO}#readme`,
    "",
    "Privacy policy: https://perfoads.com/privacypolicy. Terms of service: https://perfoads.com/termsofservice.",
  ].join("\n"),
  author: { name: "Paweł Wilk", email: "contact@perfoads.com", url: REPO },
  repository: { type: "git", url: `${REPO}.git` },
  homepage: REPO,
  documentation: `${REPO}#readme`,
  support: `${REPO}/issues`,
  license: "Apache-2.0",
  privacy_policies: ["https://perfoads.com/privacypolicy"],
  keywords: ["google-ads", "mcp", "ppc", "advertising", "audit", "self-hosted"],
  server: {
    type: "node",
    entry_point: BIN,
    mcp_config: {
      command: "node",
      args: [`\${__dirname}/${BIN}`, "serve"],
      env: { PERFOADS_MCP_HOME: "${user_config.settings_folder}" },
    },
  },
  tools: served.tools.map((t) => ({ name: t.name, description: t.title ?? t.name })),
  tools_generated: false,
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    // node:sqlite needs 22.13. Claude Desktop's built-in Node may be older: docs/SETUP.md.
    runtimes: { node: ">=22.13.0" },
  },
  user_config: {
    settings_folder: {
      type: "directory",
      title: "Settings folder (optional)",
      description:
        "Leave empty to use the default (~/.config/perfoads-mcp, or %APPDATA%\\perfoads-mcp on Windows) - the folder `init` uses. Pick another only if you set PERFOADS_MCP_HOME for `init` too. Never a folder your AI works in.",
      required: false,
    },
  },
};
writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const mcpb = path.join(root, "node_modules", ".bin", "mcpb");
run(mcpb, ["validate", path.join(stage, "manifest.json")]);
const file = path.join(out, `${SERVER_NAME}-${SERVER_VERSION}.mcpb`);
rmSync(file, { force: true });
run(mcpb, ["pack", stage, file]);
// The packed file, unpacked again, must be just as clean.
const check = mkdtempSync(path.join(tmpdir(), "perfoads-mcpb-check-"));
try {
  run(mcpb, ["unpack", file, check]);
  failOnLeaks(check, "The built .mcpb");
  failOnGuidance(check, "The built .mcpb");
} finally {
  rmSync(check, { recursive: true, force: true });
}
console.log(
  "Scan: no home path, user name, repo path or user-folder path in the bundle, and no private plugin text.",
);
console.log(
  `Built ${path.relative(root, file)} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB, ${served.tools.length} tools).`,
);
