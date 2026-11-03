// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_KEY_BYTES, newDataKey } from "./crypto.js";
import type { Store } from "./db.js";
import { restrictToOwner } from "./ownerOnly.js";
import { systemCommand, type CommandResult, type CommandRunner } from "./system.js";
import { howToRun } from "./invocation.js";

/** Where the data key that encrypts the stored credentials lives. */
export type KeyBackend = "macos-keychain" | "secret-tool" | "file";

export { runCommand, type CommandResult, type CommandRunner } from "./system.js";

export interface KeyStoreDeps {
  configDir: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  run: CommandRunner;
  /** Whether a file exists (default fs.existsSync); finds the keychain tools. */
  exists?: (file: string) => boolean;
}

export interface DataKey {
  key: Buffer;
  backend: KeyBackend;
  /** Plain-English location, safe to show. */
  location: string;
}

export class KeyUnavailableError extends Error {
  constructor(where: string) {
    super(
      `The encryption key for the saved Google sign-in could not be read from ${where}. Unlock it, or run \`${howToRun("auth")}\` in a terminal to delete the saved sign-in and sign in again.`,
    );
    this.name = "KeyUnavailableError";
  }
}

const SERVICE = "perfoads-mcp";
const LABEL = "PerfoAds MCP data key";
const HEX_KEY = new RegExp(`^[0-9a-f]{${DATA_KEY_BYTES * 2}}$`);

/** One keychain entry per config dir, so separate setups never share a key. */
const accountName = (configDir: string): string =>
  `data-key-${createHash("sha256").update(path.resolve(configDir)).digest("hex").slice(0, 16)}`;

export const keyFilePath = (configDir: string): string => path.join(configDir, "key");

const describe = (backend: KeyBackend, configDir: string): string => {
  if (backend === "macos-keychain") return "the macOS Keychain";
  if (backend === "secret-tool") return "the system keyring (secret-tool)";
  return `the key file ${keyFilePath(configDir)}`;
};

/** The macOS Keychain tool: always this path, never looked up in PATH. */
export const SECURITY_COMMAND = "/usr/bin/security";

/** Absolute path of a keychain tool, or undefined (then that backend is not used). */
const tool = (deps: KeyStoreDeps, name: "security" | "secret-tool"): string | undefined => {
  const exists = deps.exists ?? existsSync;
  if (name === "security") return exists(SECURITY_COMMAND) ? SECURITY_COMMAND : undefined;
  return systemCommand(name, "linux", exists);
};

const NOT_FOUND: CommandResult = { status: null, stdout: "", error: new Error("not found") };

/** Runs a keychain tool by its absolute path; "not found" when it is not in a system folder. */
const runTool = (
  deps: KeyStoreDeps,
  name: "security" | "secret-tool",
  args: string[],
  input?: string,
): CommandResult => {
  const file = tool(deps, name);
  return file ? deps.run(file, args, input) : NOT_FOUND;
};

const parseHex = (text: string): Buffer | undefined => {
  const hex = text.trim();
  return HEX_KEY.test(hex) ? Buffer.from(hex, "hex") : undefined;
};

const readBackend = (deps: KeyStoreDeps, backend: KeyBackend): Buffer | undefined => {
  const account = accountName(deps.configDir);
  if (backend === "macos-keychain") {
    const res = runTool(deps, "security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
    ]);
    return res.status === 0 ? parseHex(res.stdout) : undefined;
  }
  if (backend === "secret-tool") {
    const res = runTool(deps, "secret-tool", ["lookup", "service", SERVICE, "account", account]);
    return res.status === 0 ? parseHex(res.stdout) : undefined;
  }
  try {
    return parseHex(readFileSync(keyFilePath(deps.configDir), "utf8"));
  } catch {
    return undefined;
  }
};

const writeBackend = (deps: KeyStoreDeps, backend: KeyBackend, key: Buffer): boolean => {
  const hex = key.toString("hex");
  const account = accountName(deps.configDir);
  if (backend === "macos-keychain") {
    // `security -i` reads the command from stdin, so the key never appears in the process list.
    runTool(
      deps,
      "security",
      ["-i"],
      `add-generic-password -U -s ${SERVICE} -a ${account} -l "${LABEL}" -w ${hex}\n`,
    );
  } else if (backend === "secret-tool") {
    // secret-tool reads the secret from stdin.
    runTool(
      deps,
      "secret-tool",
      ["store", `--label=${LABEL}`, "service", SERVICE, "account", account],
      hex,
    );
  } else {
    try {
      // "wx": never overwrite an existing key file. 0600: owner only.
      writeFileSync(keyFilePath(deps.configDir), `${hex}\n`, { mode: 0o600, flag: "wx" });
      if (deps.platform === "win32") {
        // Windows ignores the mode: owner-only ACL (icacls by absolute path).
        restrictToOwner(keyFilePath(deps.configDir), "file", {
          platform: deps.platform,
          run: deps.run,
          env: deps.env,
        });
      }
    } catch {
      return false;
    }
  }
  // Confirm by reading it back: some tools exit 0 even when nothing was saved.
  return readBackend(deps, backend)?.equals(key) === true;
};

const toolExists = (
  deps: KeyStoreDeps,
  name: "security" | "secret-tool",
  args: string[],
): boolean => {
  const res = runTool(deps, name, args);
  return res.error === undefined && res.status !== null;
};

/** Keychain first where the OS has one; the 0600 key file otherwise. */
const preferredBackends = (deps: KeyStoreDeps): KeyBackend[] => {
  const forced = deps.env.PERFOADS_MCP_KEY_BACKEND?.trim();
  if (forced === "file") return ["file"];
  if (deps.platform === "darwin" && toolExists(deps, "security", ["list-keychains"])) {
    return ["macos-keychain", "file"];
  }
  if (
    deps.platform === "linux" &&
    toolExists(deps, "secret-tool", ["lookup", "service", SERVICE, "account", "probe"])
  ) {
    return ["secret-tool", "file"];
  }
  return ["file"];
};

const META_KEY = "key_backend";

const asBackend = (value: string | undefined): KeyBackend | undefined =>
  value === "macos-keychain" || value === "secret-tool" || value === "file" ? value : undefined;

/** Which backend this store uses, without touching it. undefined = no key made yet. */
export const keyBackendOf = (store: Store): KeyBackend | undefined =>
  asBackend(store.getMeta(META_KEY));

export const describeKeyLocation = (backend: KeyBackend, configDir: string): string =>
  describe(backend, configDir);

/**
 * Returns the data key. With `create`, makes one on first use and records where it went.
 * Once a backend is recorded it is the only place looked at: falling back silently would
 * make the saved credentials unreadable.
 */
export const getDataKey = (
  deps: KeyStoreDeps,
  store: Store,
  options: { create: boolean },
): DataKey | undefined => {
  const recorded = keyBackendOf(store);
  if (recorded) {
    const key = readBackend(deps, recorded);
    if (!key) throw new KeyUnavailableError(describe(recorded, deps.configDir));
    return { key, backend: recorded, location: describe(recorded, deps.configDir) };
  }
  if (!options.create) return undefined;
  for (const backend of preferredBackends(deps)) {
    const existing = readBackend(deps, backend);
    const key = existing ?? newDataKey();
    if (existing || writeBackend(deps, backend, key)) {
      store.setMeta(META_KEY, backend);
      return { key, backend, location: describe(backend, deps.configDir) };
    }
  }
  throw new KeyUnavailableError(describe("file", deps.configDir));
};

/** File mode bits of the key file, or undefined when there is none (or on Windows). */
export const keyFileMode = (configDir: string, platform: NodeJS.Platform): number | undefined => {
  if (platform === "win32") return undefined;
  try {
    return statSync(keyFilePath(configDir)).mode & 0o777;
  } catch {
    return undefined;
  }
};

/**
 * Forgets the data key: removes the keychain entry and the key file (best effort, every place
 * it could be) and the record of where it was. Call only together with deleting the
 * credentials it protected. Works without a store when the store itself is damaged.
 */
export const forgetDataKey = (deps: KeyStoreDeps, store: Store | undefined): void => {
  const account = accountName(deps.configDir);
  if (deps.platform === "darwin") {
    runTool(deps, "security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
  } else if (deps.platform === "linux") {
    runTool(deps, "secret-tool", ["clear", "service", SERVICE, "account", account]);
  }
  rmSync(keyFilePath(deps.configDir), { force: true });
  store?.deleteMeta(META_KEY);
};
