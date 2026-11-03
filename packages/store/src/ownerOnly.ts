// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Owner-only files and folders. macOS / Linux: mode 0600 (files) and 0700 (folders).
// Windows ignores those modes, so the settings folder gets an ACL instead, set with
// %SystemRoot%\System32\icacls.exe (absolute path, never PATH): inheritance from the parent
// removed, full control for the current user only, inherited by everything created in it.
// Then everything already inside is reset to inherit that (icacls <dir>\* /reset /T).
// Never `/inheritance:r ... /T` on the folder: icacls then strips every file inside down to
// an empty ACL that the user can't read, write or delete (seen on Windows 25 Oct - 1 Nov 2026).
// The reset also repairs a folder that an older version locked that way.
// The store, the key file, snapshots, policy.yaml and config.json all live in that folder.

import { chmodSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { runCommand, windowsRoot, type CommandRunner } from "./system.js";

export interface OwnerOnlyDeps {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  env?: Readonly<Record<string, string | undefined>>;
  /** The Windows account to grant (default: the current user). */
  user?: string;
}

/** %SystemRoot%\System32\icacls.exe. */
export const icaclsPath = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  path.win32.join(windowsRoot(env), "System32", "icacls.exe");

const currentUser = (env: Readonly<Record<string, string | undefined>>): string | undefined => {
  let name: string | undefined;
  try {
    name = userInfo().username;
  } catch {
    name = env.USERNAME;
  }
  const domain = env.USERDOMAIN?.trim();
  if (!name || /[\r\n:"]/.test(name)) return undefined;
  return domain && !/[\r\n:"\\]/.test(domain) ? `${domain}\\${name}` : name;
};

/**
 * Makes a file or folder readable and writable by its owner only. Folders: on Windows the
 * ACL is inherited by everything inside (`(OI)(CI)`), and existing contents are reset to
 * inherit it (`<dir>\* /reset /T`). True when it worked (or there was nothing to do); never
 * throws.
 */
export const restrictToOwner = (
  target: string,
  kind: "file" | "dir",
  deps: OwnerOnlyDeps = {},
): boolean => {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    try {
      chmodSync(target, kind === "dir" ? 0o700 : 0o600);
      return true;
    } catch {
      return false;
    }
  }
  const env = deps.env ?? process.env;
  const user = deps.user ?? currentUser(env);
  if (!user) return false;
  const run = deps.run ?? runCommand;
  const icacls = (args: string[]) => {
    const res = run(icaclsPath(env), [...args, "/Q"]);
    return res.error === undefined && res.status === 0;
  };
  const grant = `${user}:${kind === "dir" ? "(OI)(CI)F" : "F"}`;
  if (!icacls([target, "/inheritance:r", "/grant:r", grant])) return false;
  return kind === "file" || icacls([path.win32.join(target, "*"), "/reset", "/T", "/C"]);
};
