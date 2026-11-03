// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDataKey,
  keyFilePath,
  openStore,
  restrictToOwner,
  storePath,
  type CommandRunner,
  type Store,
} from "./index.js";

let dir: string;
let store: Store | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "perfoads-acl-"));
});

afterEach(() => {
  store?.close();
  store = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A fake icacls: records each call, succeeds. */
const recorder = () => {
  const calls: { command: string; args: string[] }[] = [];
  const run: CommandRunner = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: "" };
  };
  return { calls, run };
};

const WIN = { platform: "win32" as const, env: { SystemRoot: "C:\\Windows" }, user: "PC\\me" };
const ICACLS = "C:\\Windows\\System32\\icacls.exe";

describe("owner-only files and folders", () => {
  it("Windows: icacls by absolute path; inheritance removed, the user only, inherited by contents", () => {
    const { calls, run } = recorder();
    expect(restrictToOwner("C:\\cfg", "dir", { ...WIN, run })).toBe(true);
    expect(restrictToOwner("C:\\cfg\\key", "file", { ...WIN, run })).toBe(true);
    expect(calls).toEqual([
      {
        command: ICACLS,
        args: ["C:\\cfg", "/inheritance:r", "/grant:r", "PC\\me:(OI)(CI)F", "/Q"],
      },
      // never /T with /inheritance:r: that leaves every file inside with an empty ACL
      { command: ICACLS, args: ["C:\\cfg\\*", "/reset", "/T", "/C", "/Q"] },
      { command: ICACLS, args: ["C:\\cfg\\key", "/inheritance:r", "/grant:r", "PC\\me:F", "/Q"] },
    ]);
    const failing: CommandRunner = () => ({ status: 5, stdout: "" });
    expect(restrictToOwner("C:\\cfg", "dir", { ...WIN, run: failing })).toBe(false);
    const resetFails: CommandRunner = (_c, args) => ({
      status: args.includes("/reset") ? 5 : 0,
      stdout: "",
    });
    expect(restrictToOwner("C:\\cfg", "dir", { ...WIN, run: resetFails })).toBe(false);
  });

  it.skipIf(process.platform === "win32")("macOS / Linux: file 0600, folder 0700", () => {
    const file = path.join(dir, "f");
    writeFileSync(file, "x", { mode: 0o644 });
    expect(restrictToOwner(file, "file", { platform: "linux" })).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(restrictToOwner(dir, "dir", { platform: "linux" })).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("Windows: opening the store makes the settings folder owner-only (store, key, snapshots, policy, config inside)", () => {
    const { calls, run } = recorder();
    store = openStore(storePath(dir), { ownerOnly: { ...WIN, run } });
    expect(calls).toEqual([
      { command: ICACLS, args: [dir, "/inheritance:r", "/grant:r", "PC\\me:(OI)(CI)F", "/Q"] },
      { command: ICACLS, args: [path.win32.join(dir, "*"), "/reset", "/T", "/C", "/Q"] },
    ]);
  });

  it("Windows: icacls fails at store open -> a warning (stderr by default) and store.ownerOnly false", () => {
    const warnings: string[] = [];
    const failing: CommandRunner = () => ({ status: 5, stdout: "" });
    store = openStore(storePath(dir), {
      ownerOnly: { ...WIN, run: failing },
      warn: (m) => warnings.push(m),
    });
    expect(store.ownerOnly).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/couldn't make the settings folder .* owner-only/);
    expect(warnings[0]).toMatch(/doctor/);
    store.close();
    store = openStore(storePath(dir), { ownerOnly: { ...WIN, run: recorder().run } });
    expect(store.ownerOnly).toBe(true);
  });

  it("Windows: a new key file gets an owner-only ACL", () => {
    store = openStore(storePath(dir));
    const { calls, run } = recorder();
    const key = getDataKey(
      { configDir: dir, platform: "win32", env: { SystemRoot: "C:\\Windows" }, run },
      store,
      { create: true },
    );
    expect(key?.backend).toBe("file");
    const acl = calls.find((c) => c.command === ICACLS);
    expect(acl?.args.slice(0, 3)).toEqual([keyFilePath(dir), "/inheritance:r", "/grant:r"]);
    expect(acl?.args[3]).toMatch(/:F$/);
  });
});
