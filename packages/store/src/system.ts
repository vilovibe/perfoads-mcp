// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Child processes (browser openers, the keychain tools, icacls): always an absolute path
// from a fixed list of system folders, never a PATH lookup. An AI agent with a shell can
// put its own `open` or `security` first in PATH; that file must never run. The server's
// own PATH is reset to a fixed value at start, and children get a small allowlisted
// environment: no PERFOADS_MCP_* settings, no tokens, no BROWSER.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Fixed folders a POSIX system program may come from, in order. */
export const POSIX_SYSTEM_DIRS: readonly string[] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** PATH the server runs with on macOS and Linux. */
export const SAFE_POSIX_PATH = POSIX_SYSTEM_DIRS.join(":");

type Env = Readonly<Record<string, string | undefined>>;

/** %SystemRoot%, only when it looks like a plain drive path; else C:\Windows. */
export const windowsRoot = (env: Env = process.env): string => {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  return /^[A-Za-z]:\\[^"<>|?*;%]*$/.test(root ?? "") ? (root as string) : "C:\\Windows";
};

/** The PATH value the server runs with (and gives its children). */
export const safePath = (platform: NodeJS.Platform = process.platform, env: Env = process.env) => {
  if (platform !== "win32") return SAFE_POSIX_PATH;
  const root = windowsRoot(env);
  return [path.win32.join(root, "System32"), root, path.win32.join(root, "System32", "Wbem")].join(
    ";",
  );
};

/**
 * Absolute path of a system program, or undefined when it is not in the fixed folders.
 * Windows: %SystemRoot%\System32\<name>.exe. Never looks at PATH.
 */
export const systemCommand = (
  name: string,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
  env: Env = process.env,
): string | undefined => {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
  if (platform === "win32") {
    const file = path.win32.join(
      windowsRoot(env),
      "System32",
      name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`,
    );
    return exists(file) ? file : undefined;
  }
  for (const dir of POSIX_SYSTEM_DIRS) {
    const file = `${dir}/${name}`;
    if (exists(file)) return file;
  }
  return undefined;
};

/**
 * Variables a child may see: what desktop tools need to find the user's session, keychain
 * and browser. Everything else (PERFOADS_MCP_*, tokens, BROWSER, NODE_OPTIONS, ...) stays out.
 */
const CHILD_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_DIRS",
  "DESKTOP_SESSION",
  "DBUS_SESSION_BUS_ADDRESS",
  "__CF_USER_TEXT_ENCODING",
  // Windows
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "SystemDrive",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
] as const;

/** The environment for a child process: allowlisted keys from env, PATH = safePath. */
export const childEnv = (
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && !key.startsWith("PERFOADS_MCP_")) out[key] = value;
  }
  out.PATH = safePath(platform, env);
  return out;
};

/**
 * Sets the process's own PATH to the fixed safe value (CLI start, `serve`). Anything the
 * process starts later can no longer be redirected through PATH.
 */
export const resetProcessPath = (
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): void => {
  const value = safePath(platform, env);
  if (platform === "win32") {
    // Windows env keys are case-insensitive, but a copied object is not: drop variants.
    for (const key of Object.keys(env)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      if (key.toUpperCase() === "PATH") delete env[key];
    }
  }
  env.PATH = value;
};

export interface CommandResult {
  status: number | null;
  stdout: string;
  /** Set when the command could not be started (e.g. not installed). */
  error?: Error | undefined;
}

/**
 * Runs a program with arguments (never through a shell). Optional text goes to its stdin.
 * `command` is an absolute path (systemCommand); anything else is refused.
 */
export type CommandRunner = (command: string, args: string[], input?: string) => CommandResult;

export const runCommand: CommandRunner = (command, args, input) => {
  if (!path.isAbsolute(command)) {
    return { status: null, stdout: "", error: new Error("not an absolute path") };
  }
  const res = spawnSync(command, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    timeout: 15_000,
    windowsHide: true,
    env: childEnv(),
  });
  return { status: res.status, stdout: res.stdout ?? "", error: res.error };
};
