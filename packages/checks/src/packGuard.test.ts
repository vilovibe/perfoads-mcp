// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * What npm would ship: every publishable package (no "private": true) is packed with
 * `pnpm pack` into a temp folder and unpacked. No tarball may hold any of the fix texts
 * that moved out of the checks (by sha256, see testing/movedTexts.ts), nor name the
 * private plugin package. Needs the packages built (`pnpm test` builds first).
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ALL_MOVED_HASHES, literalChunks, MIN_CHUNK, sha256 } from "./testing/movedTexts.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PACKAGES = join(ROOT, "packages");
/** The private plugin's package name, written in two parts so this file never holds it whole. */
const PRIVATE_NAME = new RegExp(["@perfoads", "pro"].join("\\/") + "(?![\\w-])");

const publishable = (): string[] =>
  readdirSync(PACKAGES)
    .map((d) => join(PACKAGES, d))
    .filter((dir) => {
      const pj = join(dir, "package.json");
      if (!existsSync(pj)) return false;
      return (JSON.parse(readFileSync(pj, "utf8")) as { private?: boolean }).private !== true;
    });

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out);
    else out.push(p);
  }
  return out;
}

const WIN = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "perfoads-pack-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("npm tarballs", () => {
  it("hold none of the moved fix texts and never name the private plugin", () => {
    const dirs = publishable();
    expect(dirs.length).toBeGreaterThanOrEqual(8);
    const packed = join(work, "packed");
    mkdirSync(packed);
    for (const dir of dirs) {
      // Windows: pnpm is pnpm.cmd, which only runs through a shell (one command string)
      if (WIN) execSync(`pnpm pack --pack-destination "${packed}"`, { cwd: dir, stdio: "pipe" });
      else
        execFileSync("pnpm", ["pack", "--pack-destination", packed], { cwd: dir, stdio: "pipe" });
    }
    const tarballs = readdirSync(packed).filter((f) => f.endsWith(".tgz"));
    expect(tarballs.length).toBe(dirs.length);

    const hits: string[] = [];
    let scanned = 0;
    for (const tgz of tarballs) {
      const out = join(work, "x", tgz);
      mkdirSync(out, { recursive: true });
      execFileSync("tar", ["-xzf", join(packed, tgz), "-C", out]);
      for (const file of filesUnder(out)) {
        const text = readFileSync(file, "utf8");
        scanned += 1;
        const where = `${tgz}: ${file.slice(out.length + 1)}`;
        if (PRIVATE_NAME.test(text)) hits.push(`${where}: names the private plugin`);
        // quoted strings (code) and whole lines (docs)
        const chunks = literalChunks(text);
        for (const line of text.split("\n"))
          if (line.trim().length >= MIN_CHUNK) chunks.add(line.trim());
        for (const chunk of chunks)
          if (ALL_MOVED_HASHES.has(sha256(chunk))) hits.push(`${where}: ${chunk.slice(0, 60)}`);
      }
    }
    // the built checks are in it (an unbuilt package would pass trivially)
    expect(tarballs.some((t) => t.includes("checks"))).toBe(true);
    expect(scanned).toBeGreaterThan(100);
    expect(hits).toEqual([]);
  }, 120_000);
});
