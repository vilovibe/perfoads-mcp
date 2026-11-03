// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  childEnv,
  forgetDataKey,
  resetProcessPath,
  runCommand,
  SAFE_POSIX_PATH,
  safePath,
  systemCommand,
  type CommandRunner,
} from "./index.js";

let dir: string;
let savedPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "perfoads-system-"));
  savedPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

/** Puts executable scripts named like system tools first in PATH; each leaves a marker file. */
const plant = (...names: string[]): string => {
  const bin = path.join(dir, "bin");
  const marker = path.join(dir, "ran");
  mkdirSync(bin, { recursive: true });
  for (const name of names) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\necho ${name} >> "${marker}"\n`, { flag: "w", mode: 0o755 });
    chmodSync(file, 0o755);
  }
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
  return marker;
};

describe("child processes never come from PATH", () => {
  it("systemCommand looks only in fixed system folders", () => {
    const only =
      (...files: string[]) =>
      (f: string) =>
        files.includes(f);
    expect(systemCommand("secret-tool", "linux", only("/usr/bin/secret-tool"))).toBe(
      "/usr/bin/secret-tool",
    );
    expect(systemCommand("xdg-open", "linux", only(`${dir}/bin/xdg-open`))).toBeUndefined();
    expect(systemCommand("../evil", "linux", () => true)).toBeUndefined();
    expect(systemCommand("icacls", "win32", () => true, { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\icacls.exe",
    );
    expect(systemCommand("icacls", "win32", () => true, { SystemRoot: "x;y" })).toBe(
      "C:\\Windows\\System32\\icacls.exe",
    );
  });

  it.skipIf(process.platform === "win32")(
    "a planted `security` / `open` / `secret-tool` first in PATH is never executed",
    () => {
      const marker = plant("security", "open", "secret-tool", "xdg-open");
      // The runner refuses bare names outright.
      expect(runCommand("security", ["list-keychains"]).error).toBeDefined();
      expect(runCommand("open", ["https://example.com"]).error).toBeDefined();
      // The keychain code asks for absolute system paths only (forget = harmless deletes).
      const calls: string[] = [];
      const recording: CommandRunner = (command, args, input) => {
        calls.push(command);
        return runCommand(command, args, input);
      };
      for (const platform of ["darwin", "linux"] as const) {
        forgetDataKey({ configDir: dir, platform, env: process.env, run: recording }, undefined);
      }
      expect(calls.every((c) => path.isAbsolute(c) && !c.startsWith(dir))).toBe(true);
      expect(existsSync(marker)).toBe(false);
    },
  );
});

describe("environment", () => {
  it("children get an allowlist: no PERFOADS_MCP_*, no tokens, no BROWSER; a safe PATH", () => {
    const env = childEnv("linux", {
      HOME: "/home/me",
      DISPLAY: ":0",
      PATH: "/tmp/evil:/usr/bin",
      BROWSER: "/tmp/evil-browser",
      NODE_OPTIONS: "--require /tmp/evil.js",
      PERFOADS_MCP_CLIENT_SECRET: "fake-secret",
      PERFOADS_MCP_REFRESH_TOKEN: "fake-refresh",
      PERFOADS_MCP_HOME: "/srv/pm",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/key.json",
    });
    expect(env).toEqual({ HOME: "/home/me", DISPLAY: ":0", PATH: SAFE_POSIX_PATH });
  });

  it("resetProcessPath sets a fixed PATH (POSIX and Windows)", () => {
    const posix: Record<string, string | undefined> = { PATH: "/tmp/evil:/usr/bin" };
    resetProcessPath(posix, "linux");
    expect(posix.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    const win: Record<string, string | undefined> = {
      Path: "C:\\evil;C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
    };
    resetProcessPath(win, "win32");
    expect(win.Path).toBeUndefined();
    expect(win.PATH).toBe(safePath("win32", { SystemRoot: "C:\\Windows" }));
    expect(win.PATH).toBe("C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem");
  });
});
