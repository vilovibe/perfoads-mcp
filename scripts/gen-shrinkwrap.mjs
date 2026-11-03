#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Writes packages/cli/npm-shrinkwrap.json from the workspace lockfile (pnpm-lock.yaml), so
// `npm install` / `npx` of the published CLI gets exactly the dependency tree the
// workspace was tested with: every third-party package at its locked version and
// integrity hash, the @perfoads/* packages at the CLI's own version. Only `dependencies`
// count (never devDependencies). `--check` fails when the file is missing or out of date.
//
// The @perfoads/* entries carry no integrity hash: npm computes it only when they are
// published (they are published together, same version, from the same commit).

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const REGISTRY = "https://registry.npmjs.org";

// `yaml` is a dependency of @perfoads/policy, not of the root.
const YAML = createRequire(path.join(root, "packages", "policy", "package.json"))("yaml");
const lock = YAML.parse(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
if (String(lock.lockfileVersion) !== "9.0") {
  throw new Error(`pnpm-lock.yaml lockfileVersion ${lock.lockfileVersion}: this script reads 9.0`);
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const workspace = new Map(); // name -> { dir, pkg }
for (const importer of Object.keys(lock.importers)) {
  if (!importer.startsWith("packages/")) continue;
  const pkg = readJson(path.join(root, importer, "package.json"));
  workspace.set(pkg.name, { dir: importer, pkg });
}

const cli = workspace.get("perfoads-mcp");
if (!cli) throw new Error("packages/cli not found in the lockfile importers");
const version = cli.pkg.version;

/** "name@version" key of a third-party package, from an importer's locked dependency. */
const locked = (importer, name) => {
  const dep = lock.importers[importer]?.dependencies?.[name];
  if (!dep) throw new Error(`${importer}: ${name} is not in pnpm-lock.yaml (run pnpm install)`);
  return dep.version;
};

const tarball = (name, v) => `${REGISTRY}/${name}/-/${name.split("/").pop()}-${v}.tgz`;

const entries = new Map(); // "node_modules/<name>" -> entry
const place = (name, entry) => {
  const key = `node_modules/${name}`;
  const had = entries.get(key);
  if (had && had.version !== entry.version) {
    throw new Error(
      `${name} is needed at ${had.version} and ${entry.version}: nested copies are not supported here`,
    );
  }
  if (!had) entries.set(key, entry);
  return !had;
};

/** A workspace package's dependencies with workspace:* turned into the real version. */
const depsOf = (pkg) =>
  Object.fromEntries(
    Object.entries(pkg.dependencies ?? {}).map(([n, spec]) => [
      n,
      spec.startsWith("workspace:") ? workspace.get(n).pkg.version : spec,
    ]),
  );

const addExternal = (name, ref) => {
  const id = `${name}@${ref}`;
  const meta = lock.packages[id];
  const snap = lock.snapshots[id] ?? {};
  if (!meta) throw new Error(`${id} not in pnpm-lock.yaml packages`);
  if (/[(]/.test(ref)) throw new Error(`${id}: peer-resolved variants are not supported here`);
  const deps = snap.dependencies ?? {};
  const entry = {
    version: ref,
    resolved: tarball(name, ref),
    integrity: meta.resolution.integrity,
    ...(Object.keys(deps).length ? { dependencies: { ...deps } } : {}),
    ...(meta.engines ? { engines: meta.engines } : {}),
    ...(meta.hasBin ? { hasBin: true } : {}),
  };
  if (!place(name, entry)) return;
  for (const [n, r] of Object.entries(deps)) addExternal(n, r);
};

const addWorkspace = (name) => {
  const ws = workspace.get(name);
  const deps = depsOf(ws.pkg);
  const entry = {
    version: ws.pkg.version,
    resolved: tarball(name, ws.pkg.version),
    license: ws.pkg.license,
    ...(Object.keys(deps).length ? { dependencies: deps } : {}),
    ...(ws.pkg.engines ? { engines: ws.pkg.engines } : {}),
  };
  if (!place(name, entry)) return;
  walk(ws);
};

const walk = (ws) => {
  for (const [n, spec] of Object.entries(ws.pkg.dependencies ?? {})) {
    if (spec.startsWith("workspace:")) addWorkspace(n);
    else {
      const ref = locked(ws.dir, n);
      if (ref !== spec) {
        throw new Error(`${ws.pkg.name}: ${n} is "${spec}" but locked at ${ref}: pin it exactly`);
      }
      addExternal(n, ref);
    }
  }
};

walk(cli);

const sorted = Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
const shrinkwrap = {
  name: cli.pkg.name,
  version,
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: cli.pkg.name,
      version,
      license: cli.pkg.license,
      dependencies: depsOf(cli.pkg),
      bin: cli.pkg.bin,
      engines: cli.pkg.engines,
    },
    ...sorted,
  },
};

const file = path.join(root, cli.dir, "npm-shrinkwrap.json");
const text = `${JSON.stringify(shrinkwrap, null, 2)}\n`;
if (check) {
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {
    // missing
  }
  if (current !== text) {
    console.error(
      `${path.relative(root, file)} is out of date. Run: node scripts/gen-shrinkwrap.mjs`,
    );
    process.exit(1);
  }
  console.log(`${path.relative(root, file)} is up to date.`);
} else {
  writeFileSync(file, text);
  console.log(`Wrote ${path.relative(root, file)} (${entries.size} packages).`);
}
